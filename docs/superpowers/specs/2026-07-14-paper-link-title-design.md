# Paper Link Title — Obsidian Plugin Design

**Date:** 2026-07-14
**Status:** Approved by user (conversation), pending spec review

## Problem

The user pastes paper URLs (arXiv, OpenReview, ACL Anthology, and other academic sites) directly into Obsidian notes. The notes then show only the bare URL, which is unreadable. The plugin should automatically replace a pasted paper URL with a markdown link titled by the paper name.

## Behavior

- **Trigger:** on paste (`editor-paste` event), plus a command-palette command (added v1.1, user-approved 2026-07-14): "Convert paper URLs in current note" scans the active note for bare URLs — skipping frontmatter, fenced/inline code, existing markdown links, and `<autolinks>` — resolves unique URLs with concurrency 4, converts every bare occurrence, and reports a summary notice. No vault-wide scanning.
- **Activation condition:** the pasted clipboard text, after trimming, is exactly one `http(s)` URL and nothing else. Pastes containing prose or multiple URLs are left untouched.
- **Non-blocking flow:**
  1. The raw URL is inserted into the note immediately (the paste is never delayed).
  2. Metadata is fetched asynchronously via a matching resolver.
  3. On success, the plugin locates that exact URL string in the note and replaces it with the formatted link. If the URL is no longer present (user edited/undid), do nothing.
  4. On failure (network error, no metadata found), the raw URL stays and a brief `Notice` is shown. The note is never left in a broken state.
- If the URL is already inside a markdown link (i.e., the character before the insertion point makes it part of `](...)` syntax), skip conversion.

## Link format

`[Title (Venue Year)](url)`

Graceful degradation when fields are missing:

| Available fields | Output |
|---|---|
| title, venue, year | `[Title (Venue Year)](url)` |
| title, venue | `[Title (Venue)](url)` |
| title, year | `[Title (Year)](url)` |
| title only | `[Title](url)` |
| no title | leave raw URL |

Titles are flattened to a single line and `[` / `]` characters are escaped.

## Resolvers

Resolvers are matched by URL pattern, first match wins. Each resolver returns `{ title, venue?, year? }` or `null`.

1. **arXiv** (`arxiv.org`)
   - Extract paper ID from `/abs/<id>`, `/pdf/<id>`, `/html/<id>`, with or without version suffix (`v2`) or `.pdf` extension. Support both new-style (`2405.12345`) and old-style (`cs/0501001`) IDs.
   - Query `https://export.arxiv.org/api/query?id_list=<id>` (Atom XML). Title from `<title>`, year from `<published>`. Venue is `arXiv`.

2. **OpenReview** (`openreview.net`)
   - Extract note ID from `?id=` on `/forum` or `/pdf` URLs.
   - Query API v2 `https://api2.openreview.net/notes?id=<id>`; on error or empty result, fall back to API v1 `https://api.openreview.net/notes?id=<id>`.
   - Title from `content.title` (v2 wraps values as `{value: ...}`; v1 is plain). Venue from `content.venue` when present (e.g. "ICLR 2024"), else derived from the invitation string. Year from `cdate`/`pdate` or parsed out of the venue string.

3. **ACL Anthology** (`aclanthology.org`)
   - Fetch the paper's landing page HTML (normalize `.pdf` URLs to the landing page) and parse Google Scholar meta tags: `citation_title`, `citation_publication_date` (year), venue from `citation_conference_title` / `citation_journal_title`.

4. **Generic fallback** (any other URL)
   - Fetch the page HTML and look for the same `citation_*` meta tags (present on Semantic Scholar, PMLR, NeurIPS proceedings, IEEE, ACM, etc.).
   - If `citation_title` is absent, the page is not treated as a paper — the URL is left untouched. Non-paper URLs are therefore never converted.

All HTTP goes through Obsidian's `requestUrl` (bypasses CORS). Fetch timeout kept short (~10 s) so a hung request can't pile up.

## Architecture

Standard Obsidian community-plugin toolchain: TypeScript compiled with esbuild.

```
arxiv_url_parser/
├── manifest.json        # plugin id: paper-link, minAppVersion, etc.
├── package.json / tsconfig.json / esbuild.config.mjs
├── src/
│   ├── main.ts          # Plugin class: registers editor-paste handler,
│   │                    #   insert-then-replace logic, Notices
│   └── resolvers.ts     # PaperMeta type, URL matching, the 4 resolvers,
│                        #   formatLink(meta, url) — pure logic, no Obsidian
│                        #   editor dependencies (only requestUrl injected)
└── docs/superpowers/specs/
```

`resolvers.ts` takes the HTTP function as a parameter so the resolver/format logic is testable outside Obsidian.

**Install target:** built `main.js` + `manifest.json` copied into
`/Users/jiangnan/Desktop/Do_not_overthink/obsidian/all/.obsidian/plugins/paper-link/`.

## Error handling

- Resolver throws / times out → keep raw URL, show `Notice("Paper Link: could not fetch title")`.
- Malformed/unexpected API responses → resolver returns `null`, treated as failure above.
- URL edited or deleted before fetch completes → replacement silently skipped.
- Multiple rapid pastes → each paste tracked independently (replacement matches its own URL string; if the same URL was pasted twice, replace the first unconverted occurrence).

## Testing

- Resolver and formatting logic verified with a small node test script (real network calls against one known URL per source) run during development.
- End-to-end verification in the live vault via the Obsidian CLI: reload plugin, simulate pasting each URL type, confirm the substitution and the failure path (bogus URL stays raw).

## Out of scope (v1)

- Settings tab (format template, source toggles).
- Handling pastes that contain more than a single URL.
- DOI resolution via Crossref/DataCite APIs (generic resolver only reads page meta tags).
