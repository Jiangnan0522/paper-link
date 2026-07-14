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
  return { title, ...(venue ? { venue } : {}), ...(year ? { year } : {}) };
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
