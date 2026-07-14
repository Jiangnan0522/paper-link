import { Editor, Notice, Plugin, requestUrl } from 'obsidian';
import {
  bareOccurrenceIndex,
  findBareUrls,
  formatLink,
  isSingleUrl,
  resolvePaperUrl,
} from './resolvers';
import type { HttpGet } from './resolvers';

const FETCH_TIMEOUT_MS = 10_000;

const httpGet: HttpGet = async (url) => {
  const res = await Promise.race([
    requestUrl({ url, throw: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout fetching ${url}`)), FETCH_TIMEOUT_MS),
    ),
  ]);
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
    const jobs = unique.map((url) => async () => {
      let meta;
      try {
        meta = await resolvePaperUrl(url, httpGet);
      } catch {
        failed++;
        return;
      }
      if (!meta) return; // not a paper page
      const link = formatLink(meta, url);
      while (this.replaceFirstBareOccurrence(editor, url, link)) converted++;
    });
    await runWithConcurrency(jobs, 4);
    new Notice(
      `Paper Link: converted ${converted} link(s)` + (failed ? `, ${failed} failed` : ''),
    );
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
        `Paper Link: could not fetch title (${e instanceof Error ? e.message : String(e)})`,
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
