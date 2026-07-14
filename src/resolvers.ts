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

// Attribute values may be double-quoted, single-quoted, or bare (ACL Anthology
// serves `name=citation_title` unquoted), in either attribute order.
function attrValue(tag: string, attr: string): string | undefined {
  const m = tag.match(
    new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'),
  );
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

function metaContent(html: string, name: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attrValue(tag, 'name') !== name) continue;
    const raw = attrValue(tag, 'content');
    if (raw !== undefined) return cleanText(raw);
  }
  return undefined;
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
  // full proceedings titles are too long for inline link text
  const shortVenue = venue && venue.length <= 60 ? venue : undefined;
  return { title, ...(shortVenue ? { venue: shortVenue } : {}), ...(year ? { year } : {}) };
}

const URL_RE = /https?:\/\/[^\s<>()"'\]]+/g;
const TRAILING_PUNCT = /[.,;:!?]+$/;
// characters that can continue a URL — a bare match must not be followed by one
const URL_TAIL_CHAR = /[A-Za-z0-9/&%#?=._~+-]/;

/**
 * Collects bare (not-yet-linked) URLs from note text in document order,
 * skipping frontmatter, fenced/inline code, markdown link targets, and
 * <autolinks>. May contain duplicates if a URL appears more than once.
 */
export function findBareUrls(text: string): string[] {
  const urls: string[] = [];
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
    for (const m of line.matchAll(URL_RE)) {
      const ch = m.index ?? 0;
      const before = line.slice(Math.max(0, ch - 2), ch);
      if (before.endsWith('<') || before === '](') continue;
      const backticks = (line.slice(0, ch).match(/`/g) ?? []).length;
      if (backticks % 2 === 1) continue;
      urls.push(m[0].replace(TRAILING_PUNCT, ''));
    }
  }
  return urls;
}

/**
 * Index of the first bare occurrence of `url` in `line`, or -1. Skips
 * occurrences that are markdown link targets, autolinks, or prefixes of a
 * longer URL (e.g. .../1706.03762 inside .../1706.03762v5).
 */
export function bareOccurrenceIndex(line: string, url: string, from = 0): number {
  let ch = line.indexOf(url, from);
  while (ch !== -1) {
    const before = line.slice(Math.max(0, ch - 2), ch);
    const after = line[ch + url.length] ?? '';
    const linked = before === '](' || before.endsWith('<');
    if (!linked && !(after && URL_TAIL_CHAR.test(after))) return ch;
    ch = line.indexOf(url, ch + 1);
  }
  return -1;
}

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

interface OrFetchResult {
  reachable: boolean;
  note: any | null;
}

async function orFetchNote(apiUrl: string, http: HttpGet): Promise<OrFetchResult> {
  try {
    const data = JSON.parse(await http(apiUrl));
    return { reachable: true, note: data.notes?.[0] ?? null };
  } catch {
    return { reachable: false, note: null };
  }
}

const openreviewResolver: Resolver = {
  name: 'OpenReview',
  matches: (u) => /(^|\.)openreview\.net$/.test(u.hostname),
  async resolve(u, http) {
    const id = u.searchParams.get('id');
    if (!id) return null;
    const q = `notes?id=${encodeURIComponent(id)}`;
    const v2 = await orFetchNote(`https://api2.openreview.net/${q}`, http);
    const v1 = v2.note ? v2 : await orFetchNote(`https://api.openreview.net/${q}`, http);
    const note = v2.note ?? v1.note;
    if (!note) {
      if (!v2.reachable && !v1.reachable) {
        // OpenReview fronts its API with a Cloudflare Turnstile challenge that
        // rejects non-interactive clients — surface this instead of silence.
        throw new Error('OpenReview API blocked or unreachable');
      }
      return null;
    }
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

// Single-letter prefixes of old-style anthology IDs (e.g. N19-1423 → NAACL).
const ACL_LETTER_VENUES: Record<string, string> = {
  P: 'ACL',
  N: 'NAACL',
  D: 'EMNLP',
  E: 'EACL',
  C: 'COLING',
  L: 'LREC',
  S: 'SemEval',
  Q: 'TACL',
  J: 'CL',
  W: 'Workshop',
};

export function aclVenueFromPath(pathname: string): string | undefined {
  // new-style: /2023.acl-long.1/ or /2021.findings-acl.123/
  const m = pathname.match(/\/\d{4}\.([a-z0-9]+)-([a-z0-9]+)/);
  if (m) {
    return m[1] === 'findings' ? `Findings of ${m[2].toUpperCase()}` : m[1].toUpperCase();
  }
  const old = pathname.match(/\/([A-Z])\d{2}-\d{4}/);
  return old ? ACL_LETTER_VENUES[old[1]] : undefined;
}

const aclResolver: Resolver = {
  name: 'ACL Anthology',
  matches: (u) => /(^|\.)aclanthology\.org$/.test(u.hostname),
  async resolve(u, http) {
    const html = await http(u.href.replace(/\.pdf$/, ''));
    const meta = parseCitationMeta(html);
    if (!meta) return null;
    // the citation meta venue is the full proceedings title — prefer the
    // short conference name encoded in the anthology ID
    const venue = aclVenueFromPath(u.pathname);
    if (venue) meta.venue = venue;
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
