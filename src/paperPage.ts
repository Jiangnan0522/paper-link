// Pure paper-page logic: file naming, templating, and scanning notes for
// paper links. No Obsidian imports, so it runs under plain node for tests.

import type { PaperMeta } from './resolvers';

/** Alias text of the wikilink placed after a paper link; also the button's label. */
export const PAGE_ICON = '📝';

const MAX_NAME_LENGTH = 100;

/**
 * Turns a paper title into a safe note name. Strips characters that are
 * illegal in file names on some OS (`\ / : * ? " < > |`) or that break
 * wikilinks (`# ^ [ ]`), and caps the length at a word boundary.
 */
export function sanitizeFileName(title: string): string {
  let name = title
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\\/*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '');
  if (name.length > MAX_NAME_LENGTH) {
    const cut = name.slice(0, MAX_NAME_LENGTH);
    const space = cut.lastIndexOf(' ');
    name = (space > MAX_NAME_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s-]+$/, '');
  }
  return name || 'Untitled paper';
}

/**
 * Title key for matching the same paper across sources (an arXiv preprint and
 * its ACL version have different ids but the same title).
 */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * File-name candidates in preference order: the bare title, then
 * disambiguated variants for when a different paper already owns the name.
 */
export function nameCandidates(meta: PaperMeta, paperId: string): string[] {
  const base = sanitizeFileName(meta.title);
  const idTail = sanitizeFileName(paperId.replace(/^[a-z]+:/, '')).slice(0, 40);
  const out = [base];
  if (meta.year) out.push(`${base} (${meta.year})`);
  out.push(`${base} (${idTail})`);
  return out;
}

const CITEKEY_STOPWORDS = new Set(
  'a an the on of in for to and with towards toward is are via from at by do does can how what why when'.split(
    ' ',
  ),
);

function asciiWord(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Google-Scholar-style key: first author's surname + year + first content word. */
export function makeCitekey(meta: PaperMeta): string {
  const surname = asciiWord(meta.authors?.[0]?.trim().split(/\s+/).pop() ?? '') || 'anon';
  const word =
    meta.title
      .split(/[\s:-]+/)
      .map(asciiWord)
      .find((w) => w && !CITEKEY_STOPWORDS.has(w)) ?? '';
  return `${surname}${meta.year ?? ''}${word}`;
}

export const DEFAULT_TEMPLATE = `# {{title}}

{{links}}

> [!abstract]- Abstract
> {{abstract}}

## My Notes


## AI Summary


## Related

`;

export interface TemplateVars {
  title: string;
  authors: string;
  year: string;
  venue: string;
  url: string;
  pdf: string;
  abstract: string;
  tldr: string;
  citekey: string;
  paper_id: string;
  date: string;
  links: string;
}

export function templateVars(
  meta: PaperMeta,
  url: string,
  paperId: string,
  extra: { tldr?: string; date: string },
): TemplateVars {
  const pdf = meta.pdfUrl ?? '';
  return {
    title: meta.title,
    authors: (meta.authors ?? []).join(', '),
    year: meta.year ?? '',
    venue: meta.venue ?? '',
    url,
    pdf,
    abstract: meta.abstract ?? '',
    tldr: extra.tldr ?? '',
    citekey: makeCitekey(meta),
    paper_id: paperId,
    date: extra.date,
    links: pdf ? `[Paper](${url}) · [PDF](${pdf})` : `[Paper](${url})`,
  };
}

/** Replaces `{{name}}` placeholders; unknown placeholders are left as-is. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    key in vars ? vars[key as keyof TemplateVars] : m,
  );
}

/** Frontmatter fields a paper page carries; empty values are omitted. */
export function pageFrontmatter(
  meta: PaperMeta,
  url: string,
  paperId: string,
  tldr?: string,
): Record<string, unknown> {
  const fm: Record<string, unknown> = { paper_id: paperId, title: meta.title };
  if (meta.authors?.length) fm.authors = meta.authors;
  if (meta.year) fm.year = Number(meta.year);
  if (meta.venue) fm.venue = meta.venue;
  fm.url = url;
  if (meta.pdfUrl) fm.pdf = meta.pdfUrl;
  if (meta.doi) fm.doi = meta.doi;
  fm.citekey = makeCitekey(meta);
  if (tldr) fm.tldr = tldr;
  return fm;
}

/** The wikilink appended after a paper link, pointing at its page. */
export function pageLinkMarkup(pagePath: string): string {
  return `[[${pagePath.replace(/\.md$/, '')}|${PAGE_ICON}]]`;
}

export interface PaperLinkRef {
  url: string;
  /** Wikilink path immediately following the markdown link, if any. */
  pageLink?: string;
  line: number;
  /** Offset just past the markdown link's closing `)`. */
  end: number;
}

const MD_LINK_RE = /(!?)\[(?:\\.|[^\]\\])*\]\((https?:\/\/[^)\s]+)\)/g;
const FOLLOWING_WIKILINK_RE = /^[ \t]*\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/;

/**
 * Markdown links to http(s) URLs in note text, each with the wikilink that
 * directly follows it (a paper page link) when present. Skips frontmatter,
 * fenced and inline code, and images.
 */
export function findPaperLinks(text: string): PaperLinkRef[] {
  const refs: PaperLinkRef[] = [];
  const lines = text.split('\n');
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end !== -1) i = end + 1;
  }
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(MD_LINK_RE)) {
      if (m[1]) continue; // image
      const ch = m.index ?? 0;
      if ((line.slice(0, ch).match(/`/g) ?? []).length % 2 === 1) continue;
      const end = ch + m[0].length;
      const pageLink = line.slice(end).match(FOLLOWING_WIKILINK_RE)?.[1]?.trim();
      refs.push({ url: m[2], line: i, end, ...(pageLink ? { pageLink } : {}) });
    }
  }
  return refs;
}

/** A Bases view listing every paper page, newest first. */
export function papersBaseFile(): string {
  return `filters:
  and:
    - file.hasTag("paper")
views:
  - type: table
    name: All papers
    order:
      - file.name
      - note.year
      - note.venue
      - note.status
      - note.authors
      - note.tldr
    sort:
      - property: note.year
        direction: DESC
  - type: table
    name: To read
    filters:
      and:
        - 'status == "to-read"'
    order:
      - file.name
      - note.year
      - note.venue
`;
}
