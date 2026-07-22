import { Editor, Notice, Plugin, requestUrl } from 'obsidian';
import {
  bareOccurrenceIndex,
  findBareUrls,
  formatLink,
  isSingleUrl,
  RateLimitError,
  resolvePaperUrl,
} from './resolvers';
import type { HttpGet } from './resolvers';

const FETCH_TIMEOUT_MS = 10_000;

// arXiv asks clients to leave ≥3s between export-API calls; keep to it so a
// note full of arXiv links doesn't trip the throttle in the first place.
const HOST_MIN_INTERVAL_MS: Record<string, number> = { 'export.arxiv.org': 3000 };
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

const httpGet: HttpGet = async (url) => {
  await throttleHost(url);
  const res = await Promise.race([
    requestUrl({ url, throw: false }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout fetching ${url}`)), FETCH_TIMEOUT_MS),
    ),
  ]);
  if (res.status === 429 || res.status === 503) throw new RateLimitError('server');
  if (res.status >= 400) throw new Error(`request failed, status ${res.status}`);
  return res.text;
};

export default class PaperLinkPlugin extends Plugin {
  // exposed for console debugging: app.plugins.plugins['paper-link'].httpGet(url)
  httpGet = httpGet;

  async onload() {
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor) => this.onPaste(evt, editor)),
    );
    this.addCommand({
      id: 'convert-paper-urls',
      name: 'Convert paper URLs in current note',
      editorCallback: (editor) => this.convertAll(editor),
    });
  }

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
      const link = formatLink(meta, url);
      while (this.replaceFirstBareOccurrence(editor, url, link)) converted++;
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
    try {
      this.replaceFirstBareOccurrence(editor, url, formatLink(meta, url));
    } catch {
      // editor was detached (file closed) before the title arrived — drop it
    }
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
}

async function runWithConcurrency(jobs: Array<() => Promise<void>>, limit: number) {
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await job();
    }),
  );
}
