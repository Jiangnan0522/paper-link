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
