import { Editor, Notice, Plugin, requestUrl } from 'obsidian';
import { formatLink, isSingleUrl, resolvePaperUrl } from './resolvers';
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
  async onload() {
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor) => this.onPaste(evt, editor)),
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
    } catch {
      new Notice('Paper Link: could not fetch title');
      return;
    }
    if (!meta) return; // not a paper page — leave the URL alone
    try {
      this.replaceFirstBareOccurrence(editor, url, formatLink(meta, url));
    } catch {
      // editor was detached (file closed) before the title arrived — drop it
    }
  }

  replaceFirstBareOccurrence(editor: Editor, url: string, link: string) {
    for (let line = 0; line < editor.lineCount(); line++) {
      const text = editor.getLine(line);
      let ch = -1;
      while ((ch = text.indexOf(url, ch + 1)) !== -1) {
        if (text.slice(Math.max(0, ch - 2), ch) === '](') continue; // already linked
        editor.replaceRange(link, { line, ch }, { line, ch: ch + url.length });
        return;
      }
    }
    // URL no longer present (edited or undone) — silently drop the replacement.
  }
}
