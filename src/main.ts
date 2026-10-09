import {
  App,
  Editor,
  MarkdownView,
  Modal,
  normalizePath,
  Notice,
  parseLinktext,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TAbstractFile,
  TFile,
} from 'obsidian';
import {
  Decoration,
  DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import {
  bareOccurrenceIndex,
  canonicalPaperId,
  canonicalPaperUrl,
  fetchS2Extra,
  findBareUrls,
  formatLink,
  isSingleUrl,
  RateLimitError,
  resolvePaperUrl,
} from './resolvers';
import type { HttpGet, PaperMeta } from './resolvers';
import {
  DEFAULT_TEMPLATE,
  findPaperLinks,
  nameCandidates,
  PAGE_ICON,
  pageFrontmatter,
  pageLinkMarkup,
  papersBaseFile,
  renderTemplate,
  templateVars,
  titleKey,
} from './paperPage';
import {
  appendMergedNotes,
  isZoteroNote,
  mergeMigrations,
  migrateZoteroFrontmatter,
  prependAbstract,
} from './zoteroMigration';
import type { ZoteroMigration } from './zoteroMigration';

const FETCH_TIMEOUT_MS = 10_000;

// arXiv asks clients to leave ≥3s between export-API calls; keep to it so a
// note full of arXiv links doesn't trip the throttle in the first place.
// Semantic Scholar's keyless pool allows roughly one request per second.
const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  'export.arxiv.org': 3000,
  'api.semanticscholar.org': 1100,
};
const hostNextAllowed: Record<string, number> = {};

async function throttleHost(url: string): Promise<void> {
  const host = new URL(url).hostname;
  const min = HOST_MIN_INTERVAL_MS[host];
  if (!min) return;
  const now = Date.now();
  const wait = Math.max(0, (hostNextAllowed[host] ?? 0) - now);
  hostNextAllowed[host] = Math.max(now, hostNextAllowed[host] ?? 0) + min;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

const httpGet: HttpGet = async (url, headers) => {
  await throttleHost(url);
  const res = await Promise.race([
    requestUrl({ url, headers, throw: false }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout fetching ${url}`)), FETCH_TIMEOUT_MS),
    ),
  ]);
  if (res.status === 429 || res.status === 503) throw new RateLimitError('server');
  if (res.status >= 400) throw new Error(`request failed, status ${res.status}`);
  return res.text;
};

type PageMode = 'always' | 'on-click' | 'off';

interface PaperLinkSettings {
  pagesFolder: string;
  pageMode: PageMode;
  templatePath: string;
  fetchTldr: boolean;
  s2ApiKey: string;
}

const DEFAULT_SETTINGS: PaperLinkSettings = {
  pagesFolder: 'Papers',
  pageMode: 'on-click',
  templatePath: '',
  fetchTldr: true,
  s2ApiKey: '',
};

const BUTTON_CLASS = 'paper-link-page-btn';
const BASE_FILE_NAME = 'Papers.base';

/** Where a paper's page lives (or will live) and whether it exists yet. */
interface PagePlan {
  path: string;
  paperId: string;
  exists: boolean;
}

export default class PaperLinkPlugin extends Plugin {
  settings: PaperLinkSettings = DEFAULT_SETTINGS;
  // exposed for console debugging: app.plugins.plugins['paper-link'].httpGet(url)
  httpGet = httpGet;
  /** Pages this plugin is writing right now, so the create hook ignores them. */
  private filling = new Set<string>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new PaperLinkSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor) => this.onPaste(evt, editor)),
    );
    this.addCommand({
      id: 'convert-paper-urls',
      name: 'Convert paper URLs in current note',
      editorCallback: (editor) => this.convertAll(editor),
    });
    this.addCommand({
      id: 'add-paper-page-links',
      name: 'Add paper page links to current note',
      editorCallback: (editor) => this.addPageLinks(editor),
    });
    this.addCommand({
      id: 'refresh-paper-page',
      name: 'Refresh metadata of current paper page',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const url = file && this.app.metadataCache.getFileCache(file)?.frontmatter?.url;
        if (!file || typeof url !== 'string') return false;
        if (!checking) void this.refreshPage(file, url);
        return true;
      },
    });
    this.addCommand({
      id: 'migrate-zotero-notes',
      name: 'Migrate Zotero notes to paper pages',
      callback: () => this.planZoteroMigration(),
    });
    this.addCommand({
      id: 'create-papers-base',
      name: 'Create papers base (table of all paper pages)',
      callback: () => this.createBaseFile(true),
    });

    // `create` also fires for every existing file while the vault loads —
    // only listen once the workspace is ready.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (f) => void this.onFileCreated(f)));
    });

    // Style the 📝 page link as a small button in reading view and live preview.
    this.registerMarkdownPostProcessor((el) => {
      el.querySelectorAll('a.internal-link').forEach((a) => {
        if (a.textContent === PAGE_ICON) a.addClass(BUTTON_CLASS);
      });
    });
    this.registerEditorExtension(pageButtonPlugin);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── link conversion ──────────────────────────────────────────────────────

  async convertAll(editor: Editor) {
    const unique = [...new Set(findBareUrls(editor.getValue()))];
    if (!unique.length) {
      new Notice('Paper Link: no bare URLs found');
      return;
    }
    new Notice(`Paper Link: checking ${unique.length} URL(s)…`);
    let converted = 0;
    let failed = 0;
    let rateLimited = 0;
    const jobs = unique.map((url) => async () => {
      let meta;
      try {
        meta = await resolvePaperUrl(url, httpGet);
      } catch (e) {
        if (e instanceof RateLimitError) rateLimited++;
        else failed++;
        return;
      }
      if (!meta) return; // not a paper page
      const plan = await this.planPage(meta, url);
      const link = withPageLink(formatLink(meta, url), plan);
      let replaced = 0;
      while (this.replaceFirstBareOccurrence(editor, url, link)) replaced++;
      converted += replaced;
      if (replaced) await this.createPageIfEager(plan, meta, url);
    });
    // arXiv requests are already serialized by the per-host throttle; a small
    // pool keeps the other hosts responsive without hammering any one of them.
    await runWithConcurrency(jobs, 3);
    const parts = [`converted ${converted} link(s)`];
    if (rateLimited) parts.push(`${rateLimited} rate-limited (try again)`);
    if (failed) parts.push(`${failed} failed`);
    new Notice(`Paper Link: ${parts.join(', ')}`);
  }

  onPaste(evt: ClipboardEvent, editor: Editor) {
    if (evt.defaultPrevented) return;
    const text = evt.clipboardData?.getData('text/plain')?.trim();
    if (!text || !isSingleUrl(text)) return;
    const cursor = editor.getCursor('from');
    // typing [title]( by hand and pasting the URL — already a link, skip
    if (editor.getLine(cursor.line).slice(0, cursor.ch).endsWith('](')) return;
    // Let the paste land untouched; swap in the titled link when it arrives.
    void this.convertWhenResolved(text, editor);
  }

  async convertWhenResolved(url: string, editor: Editor) {
    let meta;
    try {
      meta = await resolvePaperUrl(url, httpGet);
    } catch (e) {
      new Notice(
        e instanceof RateLimitError
          ? 'Paper Link: rate-limited — paste again in a moment'
          : `Paper Link: could not fetch title (${e instanceof Error ? e.message : String(e)})`,
      );
      return;
    }
    if (!meta) return; // not a paper page — leave the URL alone
    const plan = await this.planPage(meta, url);
    let replaced = false;
    try {
      replaced = this.replaceFirstBareOccurrence(
        editor,
        url,
        withPageLink(formatLink(meta, url), plan),
      );
    } catch {
      // editor was detached (file closed) before the title arrived — drop it
    }
    // only create the page once the link really landed (not undone meanwhile)
    if (replaced) await this.createPageIfEager(plan, meta, url);
  }

  replaceFirstBareOccurrence(editor: Editor, url: string, link: string): boolean {
    for (let line = 0; line < editor.lineCount(); line++) {
      const ch = bareOccurrenceIndex(editor.getLine(line), url);
      if (ch !== -1) {
        editor.replaceRange(link, { line, ch }, { line, ch: ch + url.length });
        return true;
      }
    }
    // URL no longer present (edited or undone) — silently drop the replacement.
    return false;
  }

  /** Backfill: append a 📝 page link to existing paper links that lack one. */
  async addPageLinks(editor: Editor) {
    if (this.settings.pageMode === 'off') {
      new Notice('Paper Link: paper pages are turned off in settings');
      return;
    }
    const urls = [
      ...new Set(findPaperLinks(editor.getValue()).filter((r) => !r.pageLink).map((r) => r.url)),
    ];
    if (!urls.length) {
      new Notice('Paper Link: every link already has a page link');
      return;
    }
    new Notice(`Paper Link: checking ${urls.length} link(s)…`);
    let added = 0;
    let skipped = 0;
    const jobs = urls.map((url) => async () => {
      let meta;
      try {
        meta = await resolvePaperUrl(url, httpGet);
      } catch {
        skipped++;
        return;
      }
      if (!meta) return; // not a paper
      const plan = await this.planPage(meta, url);
      if (!plan) return;
      const markup = ` ${pageLinkMarkup(plan.path)}`;
      let inserted = 0;
      for (;;) {
        const ref = findPaperLinks(editor.getValue()).find((r) => r.url === url && !r.pageLink);
        if (!ref) break;
        editor.replaceRange(markup, { line: ref.line, ch: ref.end });
        inserted++;
      }
      added += inserted;
      if (inserted) await this.createPageIfEager(plan, meta, url);
    });
    await runWithConcurrency(jobs, 3);
    new Notice(
      `Paper Link: added ${added} page link(s)` + (skipped ? `, ${skipped} failed (try again)` : ''),
    );
  }

  // ── paper pages ──────────────────────────────────────────────────────────

  /** Finds the paper's existing page, or picks a free path for a new one. */
  async planPage(meta: PaperMeta, url: string): Promise<PagePlan | null> {
    if (this.settings.pageMode === 'off') return null;
    const paperId = canonicalPaperId(url, meta);
    const existing = this.findPageById(paperId);
    if (existing) return { path: existing.path, paperId, exists: true };
    // same title under another id: the preprint/published version of one paper
    const twin = this.findPageByTitle(meta.title);
    if (twin) {
      await this.app.fileManager.processFrontMatter(twin, (fm) => {
        const ids: unknown[] = Array.isArray(fm.also_ids) ? fm.also_ids : [];
        if (!ids.includes(paperId)) fm.also_ids = [...ids, paperId];
      });
      return { path: twin.path, paperId, exists: true };
    }
    const folder = this.pagesFolder();
    let path = '';
    for (const name of nameCandidates(meta, paperId)) {
      path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
      const taken = this.app.vault.getAbstractFileByPath(path);
      // a same-named page that is empty is an on-click page not yet filled
      if (!taken || (taken instanceof TFile && this.pageIdOf(taken) === undefined && taken.stat.size === 0)) break;
    }
    // the on-click flow relies on Obsidian creating the file inside this folder
    await this.ensureFolder();
    return { path, paperId, exists: false };
  }

  async createPageIfEager(plan: PagePlan | null, meta: PaperMeta, url: string) {
    if (!plan || plan.exists || this.settings.pageMode !== 'always') return;
    if (this.app.vault.getAbstractFileByPath(plan.path)) return;
    this.filling.add(plan.path);
    try {
      const file = await this.app.vault.create(plan.path, '');
      await this.writePage(file, meta, url, plan.paperId);
    } catch (e) {
      new Notice(`Paper Link: could not create page (${e instanceof Error ? e.message : e})`);
    } finally {
      this.filling.delete(plan.path);
    }
  }

  /** On-click mode: Obsidian just created an empty page from a 📝 link — fill it. */
  async onFileCreated(file: TAbstractFile) {
    if (this.settings.pageMode === 'off') return;
    if (!(file instanceof TFile) || file.extension !== 'md' || file.stat.size > 0) return;
    if (this.filling.has(file.path) || !this.inPagesFolder(file)) return;
    const url = await this.findSourceUrl(file);
    if (!url) return; // an ordinary new note in the folder
    this.filling.add(file.path);
    try {
      const notice = new Notice('Paper Link: fetching paper details…', 0);
      let meta: PaperMeta | null = null;
      try {
        meta = await resolvePaperUrl(url, httpGet);
      } finally {
        notice.hide();
      }
      if (!meta) {
        new Notice('Paper Link: could not fetch paper details for this page');
        return;
      }
      await this.writePage(file, meta, url, canonicalPaperId(url, meta));
    } catch (e) {
      new Notice(
        e instanceof RateLimitError
          ? 'Paper Link: rate-limited — run "Refresh metadata of current paper page" in a moment'
          : `Paper Link: could not fill page (${e instanceof Error ? e.message : e})`,
      );
      // leave a url so the refresh command can finish the job later
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.url = url;
      });
    } finally {
      this.filling.delete(file.path);
    }
  }

  /** The URL of the paper link whose 📝 wikilink points at `file`. */
  async findSourceUrl(file: TFile): Promise<string | undefined> {
    const match = (text: string, sourcePath: string) =>
      findPaperLinks(text).find((r) => {
        if (!r.pageLink) return false;
        const dest = this.app.metadataCache.getFirstLinkpathDest(r.pageLink, sourcePath);
        return dest
          ? dest.path === file.path
          : normalizePath(`${r.pageLink}.md`) === file.path;
      })?.url;

    // Clicking the link fires `create` before navigating, so the note that
    // holds the link is normally still the active editor.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && view.file !== file) {
      const url = match(view.editor.getValue(), view.file.path);
      if (url) return url;
    }
    for (const src of this.app.vault.getMarkdownFiles()) {
      if (src === file || src === view?.file) continue;
      const url = match(await this.app.vault.cachedRead(src), src.path);
      if (url) return url;
    }
    return undefined;
  }

  async writePage(file: TFile, meta: PaperMeta, rawUrl: string, paperId: string) {
    const url = canonicalPaperUrl(rawUrl);
    let extraAbstract: string | undefined;
    let tldr: string | undefined;
    // without an abstract the page body would be thin — worth waiting for S2
    if (!meta.abstract && this.settings.fetchTldr) {
      ({ tldr, abstract: extraAbstract } = await this.fetchExtra(paperId, url));
    }
    const full = { ...meta, ...(extraAbstract ? { abstract: extraAbstract } : {}) };
    const vars = templateVars(full, url, paperId, {
      tldr,
      date: localDate(),
    });
    await this.app.vault.modify(file, renderTemplate(await this.loadTemplate(), vars));
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      Object.assign(fm, pageFrontmatter(full, url, paperId, tldr));
      fm.status ??= 'to-read';
      fm.created ??= vars.date;
      const tags: unknown[] = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
      if (!tags.includes('paper')) tags.push('paper');
      fm.tags = tags;
    });
    if (!tldr && meta.abstract && this.settings.fetchTldr) void this.addTldr(file, paperId, url);
  }

  async addTldr(file: TFile, paperId: string, url: string): Promise<boolean> {
    const { tldr } = await this.fetchExtra(paperId, url);
    if (!tldr) return false;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.tldr = tldr;
    });
    return true;
  }

  async fetchExtra(paperId: string, url: string) {
    try {
      return await fetchS2Extra(paperId, url, httpGet, this.settings.s2ApiKey || undefined);
    } catch (e) {
      // keyless Semantic Scholar 429s often — a missing TL;DR is not an error
      console.debug('Paper Link: Semantic Scholar lookup failed', e);
      return {};
    }
  }

  async refreshPage(file: TFile, url: string) {
    const notice = new Notice('Paper Link: refreshing…', 0);
    try {
      const meta = await resolvePaperUrl(url, httpGet);
      if (!meta) {
        new Notice('Paper Link: no paper metadata found at this URL');
        return;
      }
      const paperId = canonicalPaperId(url, meta);
      const body = (await this.app.vault.read(file)).replace(/^---\n[\s\S]*?\n---\n?/, '');
      if (!body.trim()) {
        // a page whose first fill failed — write the full template now
        await this.writePage(file, meta, url, paperId);
        new Notice('Paper Link: page filled');
        return;
      }
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        Object.assign(fm, pageFrontmatter(meta, canonicalPaperUrl(url), paperId));
      });
      const gotTldr = this.settings.fetchTldr && (await this.addTldr(file, paperId, url));
      new Notice(
        'Paper Link: metadata refreshed' +
          (this.settings.fetchTldr && !gotTldr ? ' (TL;DR not available yet)' : ''),
      );
    } catch (e) {
      new Notice(
        e instanceof RateLimitError
          ? 'Paper Link: rate-limited — try again in a moment'
          : `Paper Link: refresh failed (${e instanceof Error ? e.message : e})`,
      );
    } finally {
      notice.hide();
    }
  }

  async loadTemplate(): Promise<string> {
    const raw = this.settings.templatePath.trim();
    if (!raw) return DEFAULT_TEMPLATE;
    const path = normalizePath(raw.endsWith('.md') ? raw : `${raw}.md`);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return this.app.vault.read(file);
    new Notice(`Paper Link: template "${path}" not found — using the built-in one`);
    return DEFAULT_TEMPLATE;
  }

  findPageById(paperId: string): TFile | undefined {
    return this.app.vault.getMarkdownFiles().find((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm?.paper_id === paperId || (Array.isArray(fm?.also_ids) && fm.also_ids.includes(paperId));
    });
  }

  findPageByTitle(title: string): TFile | undefined {
    const key = titleKey(title);
    return this.app.vault.getMarkdownFiles().find((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return typeof fm?.paper_id === 'string' && typeof fm.title === 'string' && titleKey(fm.title) === key;
    });
  }

  pageIdOf(file: TFile): string | undefined {
    const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.paper_id;
    return typeof id === 'string' ? id : undefined;
  }

  pagesFolder(): string {
    const f = normalizePath(this.settings.pagesFolder.trim() || '/');
    return f === '/' ? '' : f;
  }

  inPagesFolder(file: TFile): boolean {
    const folder = this.pagesFolder();
    return folder ? file.path.startsWith(`${folder}/`) : !file.path.includes('/');
  }

  async ensureFolder() {
    const folder = this.pagesFolder();
    if (!folder || this.app.vault.getAbstractFileByPath(folder)) return;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // created concurrently by another job — fine
    }
    // a brand-new papers folder comes with its overview table
    await this.createBaseFile(false);
  }

  // ── Zotero migration ─────────────────────────────────────────────────────

  /** Builds the migration plan and asks for confirmation before touching anything. */
  async planZoteroMigration() {
    const { items, skipped } = await this.collectZoteroMigration();
    if (!items.length) {
      new Notice(
        'Paper Link: no Zotero notes to migrate' + (skipped.length ? ` (${skipped.length} skipped)` : ''),
      );
      return;
    }
    new MigrationModal(this.app, items, skipped, this.pagesFolder(), () =>
      this.runZoteroMigration(items),
    ).open();
  }

  async collectZoteroMigration(): Promise<{ items: MigrationItem[]; skipped: string[] }> {
    const folder = this.pagesFolder();
    const skipped: string[] = [];
    // every Zotero copy of a paper, grouped by paper id
    const groups = new Map<string, ZoteroCopy[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!isZoteroNote(cache?.frontmatter)) continue;
      const body = (await this.app.vault.cachedRead(file)).slice(
        cache?.frontmatterPosition?.end.offset ?? 0,
      );
      const migration = migrateZoteroFrontmatter(cache!.frontmatter!, body.trim().length > 0);
      if (!migration) {
        skipped.push(`${file.path} — no title`);
        continue;
      }
      const copy: ZoteroCopy = {
        file,
        migration,
        body,
        inlinks: this.incomingLinkSources(file).length,
        webPage: cache!.frontmatter!['Item Type'] === 'Web Page',
      };
      groups.set(migration.paperId, [...(groups.get(migration.paperId) ?? []), copy]);
    }

    const items: MigrationItem[] = [];
    const claimedDests = new Set<string>();
    for (const [paperId, copies] of groups) {
      // the copy holding the most notes (then the most links) survives
      copies.sort(
        (a, b) => b.body.trim().length - a.body.trim().length || b.inlinks - a.inlinks,
      );
      const [primary, ...dups] = copies;
      const page = this.findPageById(paperId);
      if (page && !copies.some((c) => c.file === page)) {
        for (const c of copies) skipped.push(`${c.file.path} — same paper as ${page.path}`);
        continue;
      }
      // the merged page takes the plainest name (drops Zotero's " 1" suffixes)
      const name = copies.map((c) => c.file.name).sort((a, b) => a.length - b.length)[0];
      const dest = normalizePath(folder ? `${folder}/${name}` : name);
      const taken = this.app.vault.getAbstractFileByPath(dest);
      if ((taken && !copies.some((c) => c.file === taken)) || claimedDests.has(dest)) {
        for (const c of copies) skipped.push(`${c.file.path} — ${dest} already exists`);
        continue;
      }
      claimedDests.add(dest);
      items.push({
        file: primary.file,
        dest,
        migration: mergeMigrations(
          primary.migration,
          dups.map((d) => d.migration),
        ),
        hasNotes: copies.some((c) => c.body.trim().length > 0),
        webPage: primary.webPage,
        duplicates: dups.map((d) => ({ file: d.file, body: d.body })),
      });
    }
    return { items, skipped };
  }

  incomingLinkSources(file: TFile): string[] {
    return Object.entries(this.app.metadataCache.resolvedLinks)
      .filter(([src, targets]) => src !== file.path && targets[file.path])
      .map(([src]) => src);
  }

  async runZoteroMigration(items: MigrationItem[]) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = `.paper-link-backup/zotero-${stamp}`;
    const notice = new Notice(`Paper Link: migrating ${items.length} Zotero notes…`, 0);
    let done = 0;
    let merged = 0;
    const failed: string[] = [];
    try {
      await this.ensureFolder();
      for (const item of items) {
        const { file, dest, migration, duplicates } = item;
        try {
          // byte-for-byte copies of every original before any change
          for (const f of [file, ...duplicates.map((d) => d.file)]) await this.backup(f, backupDir);

          // rebuild the frontmatter in display order (Obsidian property names
          // are case-insensitive, so the capitalized Zotero keys must go)
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            for (const k of Object.keys(fm)) delete fm[k];
            Object.assign(fm, migration.frontmatter);
          });
          const primaryBody = (await this.app.vault.read(file)).replace(FRONTMATTER_RE, '');
          await this.app.vault.process(file, (text) => {
            const head = text.match(FRONTMATTER_RE)?.[0] ?? '';
            let body = text.slice(head.length);
            for (const d of duplicates) {
              const notes = d.body.trim();
              if (notes && notes !== primaryBody.trim()) {
                body = appendMergedNotes(body, d.file.basename, notes);
              }
            }
            if (migration.abstract) body = prependAbstract(body, migration.abstract);
            return head + body;
          });

          // duplicates: point their links at the surviving page, then trash them
          for (const d of duplicates) {
            await this.redirectLinks(d.file, file);
            await this.app.vault.trash(d.file, true);
            merged++;
          }
          // renameFile rewrites every link to the note
          if (file.path !== dest) await this.app.fileManager.renameFile(file, dest);
          done++;
          notice.setMessage(`Paper Link: migrating Zotero notes… ${done}/${items.length}`);
        } catch (e) {
          failed.push(`${file.path}: ${e instanceof Error ? e.message : e}`);
        }
      }
      const embeds = await this.replaceZoteroBaseEmbeds();
      new Notice(
        `Paper Link: migrated ${done} Zotero note(s)` +
          (merged ? `, merged ${merged} duplicate(s)` : '') +
          (embeds ? `, pointed ${embeds} embed(s) at the papers base` : '') +
          (failed.length ? `, ${failed.length} failed (see console)` : '') +
          `. Originals backed up in ${backupDir}/`,
        15000,
      );
      if (failed.length) console.warn('Paper Link: Zotero migration failures', failed);
    } finally {
      notice.hide();
    }
  }

  async backup(file: TFile, backupDir: string) {
    const adapter = this.app.vault.adapter;
    const backupPath = `${backupDir}/${file.path}`;
    const dir = backupPath.slice(0, backupPath.lastIndexOf('/'));
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(backupPath, await this.app.vault.read(file));
  }

  /** Rewrites every link and embed pointing at `from` so it points at `to`. */
  async redirectLinks(from: TFile, to: TFile) {
    for (const src of this.incomingLinkSources(from)) {
      const srcFile = this.app.vault.getAbstractFileByPath(src);
      if (!(srcFile instanceof TFile)) continue;
      const cache = this.app.metadataCache.getFileCache(srcFile);
      const linkTo = (ref: { link: string; original: string; displayText?: string }, embed: boolean) => {
        const { path, subpath } = parseLinktext(ref.link);
        if (this.app.metadataCache.getFirstLinkpathDest(path, src) !== from) return null;
        // keep a wikilink's explicit |alias; a markdown link keeps its text
        const alias = /^!?\[\[/.test(ref.original)
          ? ref.original.match(/\|([^\]]*)\]\]$/)?.[1]
          : ref.displayText;
        const link = this.app.fileManager.generateMarkdownLink(to, src, subpath, alias);
        return (embed ? '!' : '') + link.replace(/^!/, '');
      };
      const edits: Array<{ start: number; end: number; original: string; text: string }> = [];
      for (const [refs, embed] of [[cache?.links ?? [], false], [cache?.embeds ?? [], true]] as const) {
        for (const ref of refs) {
          const text = linkTo(ref, embed);
          if (text) edits.push({ start: ref.position.start.offset, end: ref.position.end.offset, original: ref.original, text });
        }
      }
      if (edits.length) {
        await this.app.vault.process(srcFile, (content) => {
          // apply back-to-front so earlier offsets stay valid
          for (const e of edits.sort((a, b) => b.start - a.start)) {
            if (content.slice(e.start, e.end) === e.original) {
              content = content.slice(0, e.start) + e.text + content.slice(e.end);
            }
          }
          return content;
        });
      }
      // links inside properties (e.g. a 方向 list) have no offsets — rewrite by value
      const fmLinks = (cache?.frontmatterLinks ?? [])
        .map((ref) => ({ original: ref.original, text: linkTo(ref, false) }))
        .filter((r): r is { original: string; text: string } => !!r.text);
      if (fmLinks.length) {
        await this.app.fileManager.processFrontMatter(srcFile, (fm) => {
          const fix = (v: unknown): unknown =>
            typeof v === 'string'
              ? fmLinks.reduce((acc, r) => acc.split(r.original).join(r.text), v)
              : Array.isArray(v)
                ? v.map(fix)
                : v;
          for (const k of Object.keys(fm)) fm[k] = fix(fm[k]);
        });
      }
    }
  }

  /** Repoints `![[Zotero.base]]` embeds (e.g. a papers index note) to the new base. */
  async replaceZoteroBaseEmbeds(): Promise<number> {
    const folder = this.pagesFolder();
    const target = (folder ? `${folder}/` : '') + BASE_FILE_NAME.replace(/\.base$/, '');
    let count = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const embeds = this.app.metadataCache.getFileCache(file)?.embeds ?? [];
      if (!embeds.some((e) => /(^|\/)Zotero\.base$/.test(e.link))) continue;
      await this.app.vault.process(file, (text) =>
        text.replace(/!\[\[([^\]|]*\/)?Zotero\.base(\|[^\]]*)?\]\]/g, () => {
          count++;
          return `![[${target}.base]]`;
        }),
      );
    }
    return count;
  }

  async createBaseFile(announce: boolean) {
    const folder = this.pagesFolder();
    const path = normalizePath(folder ? `${folder}/${BASE_FILE_NAME}` : BASE_FILE_NAME);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      try {
        if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
          await this.app.vault.createFolder(folder);
        }
        file = await this.app.vault.create(path, papersBaseFile());
      } catch (e) {
        if (announce) new Notice(`Paper Link: could not create ${path} (${e})`);
        return;
      }
    } else if (announce) {
      new Notice(`Paper Link: ${path} already exists — opening it`);
    }
    if (announce && file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }
}

/** Today as YYYY-MM-DD in local time. */
function localDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface ZoteroCopy {
  file: TFile;
  migration: ZoteroMigration;
  body: string;
  inlinks: number;
  webPage: boolean;
}

interface MigrationItem {
  /** The copy that survives (most notes); duplicates are merged into it. */
  file: TFile;
  dest: string;
  migration: ZoteroMigration;
  hasNotes: boolean;
  /** Zotero "Web Page" items — often not papers, so the modal lists them. */
  webPage: boolean;
  duplicates: Array<{ file: TFile; body: string }>;
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

function withPageLink(link: string, plan: PagePlan | null): string {
  return plan ? `${link} ${pageLinkMarkup(plan.path)}` : link;
}

async function runWithConcurrency(jobs: Array<() => Promise<void>>, limit: number) {
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await job();
    }),
  );
}

// Live preview / source mode: mark the 📝 alias of a page wikilink so CSS can
// draw it as a button. Reading view is handled by the post-processor.
const pageButtonMatcher = new MatchDecorator({
  regexp: new RegExp(`(?<=\\|)${PAGE_ICON}(?=\\]\\])`, 'gu'),
  decoration: Decoration.mark({ class: BUTTON_CLASS }),
});

const pageButtonPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = pageButtonMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = pageButtonMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

class MigrationModal extends Modal {
  constructor(
    app: App,
    private items: MigrationItem[],
    private skipped: string[],
    private folder: string,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle('Migrate Zotero notes to paper pages');
    const withNotes = this.items.filter((i) => i.hasNotes).length;
    contentEl.createEl('p', {
      text:
        `${this.items.length} Zotero notes will become paper pages in "${this.folder || '/'}" ` +
        `(${withNotes} with your notes → status "read", the rest "to-read").`,
    });
    const ul = contentEl.createEl('ul');
    for (const t of [
      'Note bodies are kept as-is; the abstract moves from properties to a callout at the top.',
      'Zotero properties are renamed (Title → title, Authors → authors, Short Title → aliases, ' +
        'Collections → collections, Tags → keywords, File Path → pdf_file); ' +
        'Zotero-only ones (Zotero URI, citations, dates modified, …) are dropped.',
      'Your own properties (方向, Taxonomy, Datasets Used, …) are kept.',
      'Files keep their names; links to them are updated automatically.',
      'Every original file is copied to .paper-link-backup/ in the vault first.',
    ])
      ul.createEl('li', { text: t });
    const dupItems = this.items.filter((i) => i.duplicates.length);
    if (dupItems.length) {
      contentEl.createEl('p', {
        text:
          `Duplicates in Zotero — merged into one page each (properties combined, ` +
          `their notes appended, links redirected, extra copies moved to the system trash):`,
      });
      const dl = contentEl.createEl('ul');
      for (const i of dupItems) {
        dl.createEl('li', {
          text: `${i.file.basename} ← ${i.duplicates.map((d) => d.file.basename).join(', ')}`,
        });
      }
    }
    const web = this.items.filter((i) => i.webPage);
    if (web.length) {
      contentEl.createEl('p', {
        text: `Saved as web pages in Zotero — migrated too; delete any that aren't papers:`,
      });
      const wl = contentEl.createEl('ul');
      for (const i of web) wl.createEl('li', { text: i.file.basename });
    }
    if (this.skipped.length) {
      contentEl.createEl('p', { text: `Skipped (${this.skipped.length}):` });
      const sk = contentEl.createEl('ul');
      for (const s of this.skipped) sk.createEl('li', { text: s });
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(`Migrate ${this.items.length} notes`)
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PaperLinkSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: PaperLinkPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl).setName('Paper pages').setHeading();

    new Setting(containerEl)
      .setName('Create paper pages')
      .setDesc(
        `Each paper link gets a ${PAGE_ICON} button linking to the paper's own note. ` +
          '"When clicked" creates the note the first time you open it; ' +
          '"Immediately" creates it as soon as the link is converted.',
      )
      .addDropdown((d) =>
        d
          .addOptions({ 'on-click': 'When clicked', always: 'Immediately', off: 'Off' })
          .setValue(s.pageMode)
          .onChange(async (v) => {
            s.pageMode = v as PageMode;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName('Paper pages folder')
      .setDesc('Where paper notes are created. Existing pages are found by paper ID anywhere in the vault.')
      .addText((t) =>
        t
          .setPlaceholder('Papers')
          .setValue(s.pagesFolder)
          .onChange(async (v) => {
            s.pagesFolder = v;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName('Template file')
      .setDesc(
        'Optional note used as the page body. Placeholders: {{title}} {{authors}} {{year}} ' +
          '{{venue}} {{url}} {{pdf}} {{links}} {{abstract}} {{tldr}} {{citekey}} {{paper_id}} ' +
          '{{date}}. Frontmatter (paper_id, authors, …) is added automatically. Empty = built-in.',
      )
      .addText((t) =>
        t
          .setPlaceholder('Templates/Paper')
          .setValue(s.templatePath)
          .onChange(async (v) => {
            s.templatePath = v;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName('Fetch TL;DR from Semantic Scholar')
      .setDesc(
        'Adds a one-sentence AI summary (and an abstract when the source has none). ' +
          'Best-effort: the keyless API is often rate-limited.',
      )
      .addToggle((t) =>
        t.setValue(s.fetchTldr).onChange(async (v) => {
          s.fetchTldr = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Semantic Scholar API key')
      .setDesc('Optional. A free key makes TL;DR lookups much more reliable.')
      .addText((t) =>
        t.setValue(s.s2ApiKey).onChange(async (v) => {
          s.s2ApiKey = v.trim();
          await save();
        }),
      );
  }
}
