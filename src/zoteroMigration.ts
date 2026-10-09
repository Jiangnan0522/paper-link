// Pure mapping from Zotero-exported note frontmatter (capitalized keys such as
// `Title`, `Authors`, `Zotero URI`) to paper-page frontmatter. No Obsidian
// imports, so it runs under plain node for tests.

import { canonicalPaperId, canonicalPaperUrl } from './resolvers';
import { makeCitekey } from './paperPage';

/** A note counts as a Zotero export when it carries its Zotero item URI. */
export function isZoteroNote(fm: Record<string, unknown> | undefined): boolean {
  return typeof fm?.['Zotero URI'] === 'string';
}

// Zotero keys whose value is carried over (renamed) or that only made sense
// inside Zotero. Everything not listed here is the user's own field and is kept.
const CONSUMED_KEYS = [
  'Title',
  'Authors',
  'Year',
  'Date',
  'DOI',
  'URL',
  'Abstract',
  'Proceedings Title',
  'Publication',
  'Item Type',
  'Citation Key',
  'Short Title',
  'Tags',
  'Collections',
  'File Path',
  'Date Added',
  'Date Modified',
  'Zotero URI',
  'In-Text Citation',
  'Full Citation',
  'Extra',
  'Place',
  'Editors',
  'Series Title',
  'Field',
  'base',
];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  return str(v)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "Li, Zongqian" → "Zongqian Li". */
function flipName(name: string): string {
  const parts = name.split(',').map((p) => p.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : name;
}

/** "https://doi.org/10.1/X" → "10.1/X". */
export function bareDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

/** arXiv id from a DataCite arXiv DOI (10.48550/arXiv.2408.03094) or an `Extra` line. */
function arxivIdFrom(doi: string, extra: string): string | undefined {
  return (
    doi.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1] ??
    extra.match(/arXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i)?.[1]
  );
}

export interface ZoteroMigration {
  paperId: string;
  title: string;
  /** Frontmatter in display order: paper fields first, then the user's own fields. */
  frontmatter: Record<string, unknown>;
  /** Abstract to move from frontmatter into the note body. */
  abstract?: string;
}

/**
 * Maps a Zotero note's frontmatter to a paper page's. `hasNotes` tells whether
 * the note body has content, which marks the paper as already read.
 */
export function migrateZoteroFrontmatter(
  fm: Record<string, unknown>,
  hasNotes: boolean,
): ZoteroMigration | null {
  const title = str(fm.Title) || str(fm['Short Title']);
  if (!title) return null;

  const doi = bareDoi(str(fm.DOI));
  const arxiv = arxivIdFrom(doi, str(fm.Extra));
  let url = str(fm.URL);
  if (!url && arxiv) url = `https://arxiv.org/abs/${arxiv}`;
  if (!url && doi) url = `https://doi.org/${doi}`;
  // a plain (non-arXiv-DOI) DOI only identifies the paper when the URL can't
  const isArxivDoi = /^10\.48550\//.test(doi);

  let paperId: string;
  if (url && /arxiv\.org|aclanthology\.org|openreview\.net/.test(url)) {
    paperId = canonicalPaperId(url);
  } else if (arxiv) {
    paperId = `arxiv:${arxiv.replace(/v\d+$/, '')}`;
  } else if (doi && !isArxivDoi) {
    paperId = `doi:${doi.toLowerCase()}`;
  } else if (url) {
    paperId = canonicalPaperId(url);
  } else {
    paperId = `zotero:${str(fm['Zotero URI']).split('/').pop()}`;
  }
  if (url) url = canonicalPaperUrl(url);

  const authors = list(fm.Authors).map(flipName);
  const year = str(fm.Year) || str(fm.Date).match(/(?:19|20)\d{2}/)?.[0] || '';
  const venue =
    str(fm['Proceedings Title']) ||
    str(fm.Publication) ||
    (paperId.startsWith('arxiv:') && str(fm['Item Type']) === 'Preprint' ? 'arXiv' : '');
  const pdf = paperId.startsWith('arxiv:') ? `https://arxiv.org/pdf/${paperId.slice(6)}` : '';
  const meta = { title, ...(year ? { year } : {}), authors };

  const out: Record<string, unknown> = { paper_id: paperId, title };
  const shortTitle = str(fm['Short Title']);
  if (shortTitle && shortTitle !== title) out.aliases = [shortTitle];
  if (authors.length) out.authors = authors;
  if (year) out.year = Number(year);
  if (venue) out.venue = venue;
  if (url) out.url = url;
  if (pdf) out.pdf = pdf;
  if (doi && !isArxivDoi) out.doi = doi;
  out.citekey = str(fm['Citation Key']) || makeCitekey(meta);
  out.status = hasNotes ? 'read' : 'to-read';
  const added = str(fm['Date Added']).slice(0, 10);
  if (added) out.created = added;
  const collections = list(fm.Collections);
  if (collections.length) out.collections = collections;
  const keywords = list(fm.Tags);
  if (keywords.length) out.keywords = keywords;
  const pdfFile = str(fm['File Path']);
  if (pdfFile) out.pdf_file = pdfFile;
  const tags = list(fm.tags);
  out.tags = tags.includes('paper') ? tags : [...tags, 'paper'];

  // the user's own fields (方向, Taxonomy, Datasets Used, …) come along untouched
  for (const [k, v] of Object.entries(fm)) {
    if (!CONSUMED_KEYS.includes(k) && !(k in out)) out[k] = v;
  }

  const abstract = str(fm.Abstract).replace(/\s+/g, ' ');
  return { paperId, title, frontmatter: out, ...(abstract ? { abstract } : {}) };
}

/** Puts the abstract callout at the top of the note body, above existing notes. */
export function prependAbstract(body: string, abstract: string): string {
  const callout = `> [!abstract]- Abstract\n> ${abstract}\n`;
  const rest = body.replace(/^\n+/, '');
  return rest ? `${callout}\n${rest}` : callout;
}

/**
 * Merges duplicate Zotero items of one paper into the primary's migration:
 * list fields (collections, 方向, aliases, …) are unioned, the earliest
 * `created` wins, and the paper counts as read if any copy was.
 */
export function mergeMigrations(primary: ZoteroMigration, others: ZoteroMigration[]): ZoteroMigration {
  const fm: Record<string, unknown> = { ...primary.frontmatter };
  for (const other of others) {
    for (const [k, v] of Object.entries(other.frontmatter)) {
      const cur = fm[k];
      if (Array.isArray(v)) {
        const base = Array.isArray(cur) ? cur : cur === undefined || cur === '' ? [] : [cur];
        const merged = [...base];
        for (const x of v) if (!merged.some((m) => JSON.stringify(m) === JSON.stringify(x))) merged.push(x);
        fm[k] = merged;
      } else if (k === 'created') {
        if (typeof v === 'string' && (typeof cur !== 'string' || v < cur)) fm[k] = v;
      } else if (k === 'status') {
        if (v === 'read') fm[k] = 'read';
      } else if (cur === undefined || cur === '') {
        fm[k] = v;
      }
    }
  }
  const abstract = primary.abstract ?? others.find((o) => o.abstract)?.abstract;
  return { ...primary, frontmatter: fm, ...(abstract ? { abstract } : {}) };
}

/** Appends a duplicate's notes under a heading naming where they came from. */
export function appendMergedNotes(body: string, fromName: string, notes: string): string {
  return `${body.replace(/\s+$/, '')}\n\n## Notes from "${fromName}"\n\n${notes.trim()}\n`;
}
