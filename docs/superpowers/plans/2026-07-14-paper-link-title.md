# Paper Link Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian plugin that, on paste, replaces a bare paper URL (arXiv, OpenReview, ACL Anthology, or any page with `citation_*` meta tags) with `[Title (Venue Year)](url)`.

**Architecture:** `src/resolvers.ts` holds all pure logic (URL classification, per-source metadata resolvers, link formatting) with the HTTP function injected so it runs under plain node for tests. `src/main.ts` is the thin Obsidian layer: an `editor-paste` listener that lets the paste land immediately, resolves metadata asynchronously, then swaps the URL in place. Spec: `docs/superpowers/specs/2026-07-14-paper-link-title-design.md`.

**Tech Stack:** TypeScript, esbuild (standard Obsidian plugin toolchain), node:test for the resolver test suite (unit tests on canned data + live network tests).

## Global Constraints

- Plugin id: `paper-link`; install target: `/Users/jiangnan/Desktop/Do_not_overthink/obsidian/all/.obsidian/plugins/paper-link/`
- All HTTP in the plugin goes through Obsidian `requestUrl` with a 10 s timeout; resolvers never import from `obsidian`
- Paste is never blocked or delayed; failures leave the raw URL intact
- Only fire when the trimmed clipboard is exactly one http(s) URL
- Link format degradation: `[Title (Venue Year)]` → `[Title (Venue)]` → `[Title (Year)]` → `[Title]` → leave raw URL; if the venue string already contains the year (e.g. "ICLR 2024"), don't append the year again

---

### Task 1: Project scaffold that builds

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `scripts/install.mjs`, `src/main.ts` (stub), `.gitignore`

**Interfaces:**
- Produces: `npm run build` → bundled `main.js`; `npm test` → runs `test/resolvers.test.ts` under node; `npm run install-vault` → copies `main.js` + `manifest.json` into the vault plugin folder.

- [ ] **Step 1: Write config files**

`package.json`:

```json
{
  "name": "paper-link",
  "version": "1.0.0",
  "description": "Obsidian plugin: replace pasted paper URLs with titled markdown links",
  "type": "module",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc --noEmit && node esbuild.config.mjs production",
    "test": "esbuild test/resolvers.test.ts --bundle --platform=node --format=cjs --outfile=build/test.cjs && node --test build/test.cjs",
    "install-vault": "npm run build && node scripts/install.mjs"
  },
  "devDependencies": {
    "esbuild": "^0.21.0",
    "obsidian": "^1.5.7",
    "tslib": "^2.6.0",
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2018",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["DOM", "ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`esbuild.config.mjs`:

```js
import esbuild from 'esbuild';
import process from 'node:process';

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
```

`manifest.json`:

```json
{
  "id": "paper-link",
  "name": "Paper Link",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "Replace pasted paper URLs (arXiv, OpenReview, ACL Anthology, …) with [Title (Venue Year)](url) links.",
  "author": "Jiangnan Ye",
  "isDesktopOnly": false
}
```

`scripts/install.mjs`:

```js
import { copyFileSync, mkdirSync } from 'node:fs';

const dest =
  '/Users/jiangnan/Desktop/Do_not_overthink/obsidian/all/.obsidian/plugins/paper-link';
mkdirSync(dest, { recursive: true });
for (const f of ['main.js', 'manifest.json']) copyFileSync(f, `${dest}/${f}`);
console.log('installed to', dest);
```

`.gitignore`:

```
node_modules/
build/
main.js
```

`src/main.ts` (stub — replaced in Task 4):

```ts
import { Plugin } from 'obsidian';

export default class PaperLinkPlugin extends Plugin {
  async onload() {}
}
```

- [ ] **Step 2: Install dependencies and verify the build**

Run: `npm install && npm run build`
Expected: exits 0, `main.js` created at repo root.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: scaffold obsidian plugin build (esbuild + tsc + vault install script)"
```

---

### Task 2: Pure helpers and parsers in `resolvers.ts`

**Files:**
- Create: `src/resolvers.ts`
- Test: `test/resolvers.test.ts`

**Interfaces:**
- Produces (used by Tasks 3 and 4):
  - `interface PaperMeta { title: string; venue?: string; year?: string }`
  - `type HttpGet = (url: string) => Promise<string>` — returns body text, throws on HTTP error
  - `isSingleUrl(text: string): boolean`
  - `formatLink(meta: PaperMeta, url: string): string`
  - `cleanText(s: string): string` — entity-decode + collapse whitespace
  - `parseArxivAtom(xml: string): PaperMeta | null`
  - `parseCitationMeta(html: string): PaperMeta | null`

- [ ] **Step 1: Write the failing tests**

`test/resolvers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSingleUrl,
  formatLink,
  parseArxivAtom,
  parseCitationMeta,
} from '../src/resolvers';

test('isSingleUrl accepts a bare http(s) URL', () => {
  assert.equal(isSingleUrl('https://arxiv.org/abs/1706.03762'), true);
  assert.equal(isSingleUrl('http://example.com/x?a=1'), true);
});

test('isSingleUrl rejects prose, multiple URLs, non-http', () => {
  assert.equal(isSingleUrl('see https://arxiv.org/abs/1706.03762'), false);
  assert.equal(isSingleUrl('https://a.com https://b.com'), false);
  assert.equal(isSingleUrl('not a url'), false);
  assert.equal(isSingleUrl('ftp://example.com/f'), false);
});

test('formatLink renders all degradation levels', () => {
  const url = 'https://x.org/p';
  assert.equal(
    formatLink({ title: 'T', venue: 'ACL', year: '2023' }, url),
    '[T (ACL 2023)](https://x.org/p)',
  );
  assert.equal(formatLink({ title: 'T', venue: 'ACL' }, url), '[T (ACL)](https://x.org/p)');
  assert.equal(formatLink({ title: 'T', year: '2023' }, url), '[T (2023)](https://x.org/p)');
  assert.equal(formatLink({ title: 'T' }, url), '[T](https://x.org/p)');
});

test('formatLink does not duplicate a year embedded in the venue', () => {
  assert.equal(
    formatLink({ title: 'T', venue: 'ICLR 2024', year: '2024' }, 'https://x.org/p'),
    '[T (ICLR 2024)](https://x.org/p)',
  );
});

test('formatLink escapes brackets and flattens whitespace in titles', () => {
  assert.equal(
    formatLink({ title: 'A [BERT]\n  study' }, 'https://x.org/p'),
    '[A \\[BERT\\] study](https://x.org/p)',
  );
});

test('parseArxivAtom extracts title and year from an entry', () => {
  const xml = `<?xml version="1.0"?><feed>
    <title>ArXiv Query: search_query=&amp;id_list=1706.03762</title>
    <entry>
      <title>Attention Is All You
  Need</title>
      <published>2017-06-12T17:57:34Z</published>
    </entry></feed>`;
  assert.deepEqual(parseArxivAtom(xml), {
    title: 'Attention Is All You Need',
    venue: 'arXiv',
    year: '2017',
  });
});

test('parseArxivAtom returns null for error/empty feeds', () => {
  assert.equal(parseArxivAtom('<feed><title>ArXiv Query</title></feed>'), null);
  assert.equal(
    parseArxivAtom('<feed><entry><title>Error</title></entry></feed>'),
    null,
  );
});

test('parseCitationMeta reads citation tags in either attribute order', () => {
  const html = `<html><head>
    <meta name="citation_title" content="Deep Stuff &amp; More" />
    <meta content="NeurIPS" name="citation_conference_title" />
    <meta name="citation_publication_date" content="2022/11/28" />
  </head></html>`;
  assert.deepEqual(parseCitationMeta(html), {
    title: 'Deep Stuff & More',
    venue: 'NeurIPS',
    year: '2022',
  });
});

test('parseCitationMeta returns null without citation_title', () => {
  assert.equal(parseCitationMeta('<html><head><title>Blog</title></head></html>'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — esbuild cannot resolve `../src/resolvers` (or missing exports).

- [ ] **Step 3: Implement the helpers**

`src/resolvers.ts`:

```ts
// Pure metadata-resolution logic. No Obsidian imports — the HTTP function is
// injected so this module also runs under plain node for tests.

export interface PaperMeta {
  title: string;
  venue?: string;
  year?: string;
}

/** Fetches a URL, returns the response body text. Must throw on HTTP errors. */
export type HttpGet = (url: string) => Promise<string>;

export function isSingleUrl(text: string): boolean {
  if (/\s/.test(text)) return false;
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

export function cleanText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function yearFrom(s: string | undefined): string | undefined {
  return s?.match(/(?:19|20)\d{2}/)?.[0];
}

export function formatLink(meta: PaperMeta, url: string): string {
  const title = cleanText(meta.title).replace(/([[\]])/g, '\\$1');
  let suffix: string;
  if (meta.venue && meta.year) {
    suffix = meta.venue.includes(meta.year) ? meta.venue : `${meta.venue} ${meta.year}`;
  } else {
    suffix = meta.venue ?? meta.year ?? '';
  }
  return suffix ? `[${title} (${suffix})](${url})` : `[${title}](${url})`;
}

export function parseArxivAtom(xml: string): PaperMeta | null {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;
  const rawTitle = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
  if (!rawTitle) return null;
  const title = cleanText(rawTitle);
  if (!title || title === 'Error') return null;
  const year = entry.match(/<published>(\d{4})/)?.[1];
  return { title, venue: 'arXiv', ...(year ? { year } : {}) };
}

function metaContent(html: string, name: string): string | undefined {
  const nameFirst = new RegExp(
    `<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const contentFirst = new RegExp(
    `<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`,
    'i',
  );
  const raw = (html.match(nameFirst) ?? html.match(contentFirst))?.[1];
  return raw === undefined ? undefined : cleanText(raw);
}

export function parseCitationMeta(html: string): PaperMeta | null {
  const title = metaContent(html, 'citation_title');
  if (!title) return null;
  const venue =
    metaContent(html, 'citation_conference_title') ??
    metaContent(html, 'citation_journal_title');
  const year = yearFrom(
    metaContent(html, 'citation_publication_date') ??
      metaContent(html, 'citation_date') ??
      metaContent(html, 'citation_online_date'),
  );
  return { title, ...(venue ? { venue } : {}), ...(year ? { year } : {}) };
}
```

Note for later tasks: `parseArxivAtom`/`parseCitationMeta` omit missing optional keys entirely (spread pattern) so `assert.deepEqual` comparisons stay exact.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolvers.ts test/resolvers.test.ts
git commit -m "feat: URL detection, link formatting, and metadata parsers"
```

---

### Task 3: Source resolvers and dispatcher

**Files:**
- Modify: `src/resolvers.ts` (append)
- Test: `test/resolvers.test.ts` (append)

**Interfaces:**
- Consumes: `PaperMeta`, `HttpGet`, `cleanText`, `parseArxivAtom`, `parseCitationMeta` from Task 2.
- Produces (used by Task 4): `resolvePaperUrl(rawUrl: string, http: HttpGet): Promise<PaperMeta | null>` — throws on network failure, returns `null` for non-paper pages.

- [ ] **Step 1: Write the failing tests**

Append to `test/resolvers.test.ts` (add `arxivId` and `resolvePaperUrl` to the existing import from `../src/resolvers`, plus `import type { HttpGet } from '../src/resolvers';`):

```ts
import { arxivId, resolvePaperUrl } from '../src/resolvers';
import type { HttpGet } from '../src/resolvers';

test('arxivId handles abs/pdf/html forms, versions, old-style IDs', () => {
  assert.equal(arxivId(new URL('https://arxiv.org/abs/1706.03762')), '1706.03762');
  assert.equal(arxivId(new URL('https://arxiv.org/abs/1706.03762v5')), '1706.03762v5');
  assert.equal(arxivId(new URL('https://arxiv.org/pdf/1706.03762.pdf')), '1706.03762');
  assert.equal(arxivId(new URL('https://arxiv.org/pdf/2405.12345')), '2405.12345');
  assert.equal(arxivId(new URL('https://arxiv.org/html/2405.12345v2')), '2405.12345v2');
  assert.equal(arxivId(new URL('https://arxiv.org/abs/cs/0501001')), 'cs/0501001');
  assert.equal(arxivId(new URL('https://arxiv.org/abs/math.GT/0309136')), 'math.GT/0309136');
  assert.equal(arxivId(new URL('https://arxiv.org/list/cs.CL/recent')), null);
});

// --- live network tests (hit the real APIs) ---

const http: HttpGet = async (url) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'paper-link-obsidian-plugin-test' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

test('live: arXiv abs URL', async () => {
  const meta = await resolvePaperUrl('https://arxiv.org/abs/1706.03762', http);
  assert.equal(meta?.title, 'Attention Is All You Need');
  assert.equal(meta?.venue, 'arXiv');
  assert.equal(meta?.year, '2017');
});

test('live: OpenReview forum URL', async () => {
  const meta = await resolvePaperUrl('https://openreview.net/forum?id=YicbFdNTTy', http);
  assert.match(meta?.title ?? '', /Image is Worth 16x16 Words/i);
  assert.equal(meta?.year, '2021');
});

test('live: ACL Anthology URL', async () => {
  const meta = await resolvePaperUrl('https://aclanthology.org/N19-1423/', http);
  assert.match(meta?.title ?? '', /BERT/);
  assert.equal(meta?.year, '2019');
});

test('live: generic resolver via PMLR citation tags', async () => {
  const meta = await resolvePaperUrl(
    'https://proceedings.mlr.press/v139/radford21a.html',
    http,
  );
  assert.match(meta?.title ?? '', /Natural Language Supervision/i);
});

test('live: non-paper page resolves to null', async () => {
  const meta = await resolvePaperUrl('https://example.com/', http);
  assert.equal(meta, null);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — `arxivId` / `resolvePaperUrl` not exported.

- [ ] **Step 3: Implement resolvers and dispatcher**

Append to `src/resolvers.ts`:

```ts
interface Resolver {
  name: string;
  matches(url: URL): boolean;
  resolve(url: URL, http: HttpGet): Promise<PaperMeta | null>;
}

export function arxivId(url: URL): string | null {
  const m = url.pathname.match(
    /\/(?:abs|pdf|html)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?)/,
  );
  return m ? m[1] : null;
}

const arxivResolver: Resolver = {
  name: 'arXiv',
  matches: (u) => /(^|\.)arxiv\.org$/.test(u.hostname),
  async resolve(u, http) {
    const id = arxivId(u);
    if (!id) return null;
    const xml = await http(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
    );
    return parseArxivAtom(xml);
  },
};

// OpenReview API v2 wraps content values as {value: ...}; v1 stores them plain.
function orField(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') {
    return (v as { value: string }).value;
  }
  return null;
}

async function orFetchNote(apiUrl: string, http: HttpGet): Promise<any | null> {
  try {
    const data = JSON.parse(await http(apiUrl));
    return data.notes?.[0] ?? null;
  } catch {
    return null;
  }
}

const openreviewResolver: Resolver = {
  name: 'OpenReview',
  matches: (u) => /(^|\.)openreview\.net$/.test(u.hostname),
  async resolve(u, http) {
    const id = u.searchParams.get('id');
    if (!id) return null;
    const q = `notes?id=${encodeURIComponent(id)}`;
    const note =
      (await orFetchNote(`https://api2.openreview.net/${q}`, http)) ??
      (await orFetchNote(`https://api.openreview.net/${q}`, http));
    if (!note) return null;
    const rawTitle = orField(note.content?.title);
    if (!rawTitle) return null;
    const venue = orField(note.content?.venue);
    const ms: unknown = note.pdate ?? note.cdate;
    const year =
      yearFrom(venue ?? undefined) ??
      (typeof ms === 'number' ? String(new Date(ms).getUTCFullYear()) : undefined);
    return {
      title: cleanText(rawTitle),
      ...(venue ? { venue: cleanText(venue) } : {}),
      ...(year ? { year } : {}),
    };
  },
};

const aclResolver: Resolver = {
  name: 'ACL Anthology',
  matches: (u) => /(^|\.)aclanthology\.org$/.test(u.hostname),
  async resolve(u, http) {
    const html = await http(u.href.replace(/\.pdf$/, ''));
    const meta = parseCitationMeta(html);
    if (!meta) return null;
    if (!meta.venue) {
      // e.g. /2023.acl-long.1/ → ACL
      const slug = u.pathname.match(/\/\d{4}\.([a-z0-9]+)-/)?.[1];
      if (slug) meta.venue = slug.toUpperCase();
    }
    return meta;
  },
};

const genericResolver: Resolver = {
  name: 'generic',
  matches: () => true,
  async resolve(u, http) {
    return parseCitationMeta(await http(u.href));
  },
};

const RESOLVERS: Resolver[] = [
  arxivResolver,
  openreviewResolver,
  aclResolver,
  genericResolver,
];

export async function resolvePaperUrl(
  rawUrl: string,
  http: HttpGet,
): Promise<PaperMeta | null> {
  const url = new URL(rawUrl);
  const resolver = RESOLVERS.find((r) => r.matches(url))!;
  return resolver.resolve(url, http);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (16 tests, live ones need network). If a live test fails, distinguish API-shape bugs (fix the resolver) from a wrong expected value in the test (verify by fetching the API by hand with `curl`, then fix the assertion).

- [ ] **Step 5: Commit**

```bash
git add src/resolvers.ts test/resolvers.test.ts
git commit -m "feat: arXiv/OpenReview/ACL/generic resolvers with live tests"
```

---

### Task 4: Paste handler, vault install, live verification

**Files:**
- Modify: `src/main.ts` (replace stub)

**Interfaces:**
- Consumes: `isSingleUrl`, `resolvePaperUrl`, `formatLink`, `HttpGet` from Tasks 2–3.

- [ ] **Step 1: Implement the plugin class**

`src/main.ts` (full replacement):

```ts
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
```

- [ ] **Step 2: Build and typecheck**

Run: `npm run build`
Expected: exits 0 (tsc clean, `main.js` rebuilt).

- [ ] **Step 3: Install into the vault**

Run: `npm run install-vault`
Expected: `installed to /Users/jiangnan/Desktop/Do_not_overthink/obsidian/all/.obsidian/plugins/paper-link`

- [ ] **Step 4: Enable and verify live in Obsidian**

Invoke the `obsidian:obsidian-cli` skill for the exact commands. Verification sequence:

1. Enable the `paper-link` plugin (CLI or Settings → Community plugins), reload it.
2. Create a scratch note in the vault; via the CLI's run-JavaScript facility, dispatch a synthetic paste of `https://arxiv.org/abs/1706.03762` into the active editor (construct a `ClipboardEvent('paste', { clipboardData })` with a `DataTransfer` carrying the URL, or set the system clipboard and trigger the editor paste command).
3. Wait ~3 s, read the note: expect `[Attention Is All You Need (arXiv 2017)](https://arxiv.org/abs/1706.03762)`.
4. Repeat for `https://openreview.net/forum?id=YicbFdNTTy` (expect an ICLR 2021 titled link) and `https://example.com/` (expect the bare URL, unchanged).
5. Capture plugin errors via the CLI's error/console facility — expect none.

If synthetic paste events don't reach the plugin (Electron clipboard sandboxing), fall back to asking the user to paste once manually and read the note afterwards.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: on-paste conversion of paper URLs to titled links"
```
