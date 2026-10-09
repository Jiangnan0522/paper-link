# Paper Manager

An [Obsidian](https://obsidian.md) plugin that keeps your papers in your vault. Paste an academic paper URL and it becomes a readable, titled link — **automatically**, just when you press `ctrl+v`/`command+v` — with a 📝 button to the paper's own note, so every paper has exactly one place for your understanding, AI summaries, and links from the rest of your notes.

Paste `https://arxiv.org/abs/1706.03762` into a note and it becomes:

> [Attention Is All You Need (arXiv 2017)](https://arxiv.org/abs/1706.03762) [[Papers/Attention Is All You Need|📝]]

The paste itself is never delayed — the URL lands instantly, and the titled link is swapped in as soon as the metadata arrives (usually well under a second).

Coming from Zotero? See [Migrating from Zotero](#migrating-from-zotero).

## Supported sources

| Source | How | Venue shown |
|---|---|---|
| arXiv | official arXiv API | `arXiv` + year |
| ACL Anthology | page citation metadata | short venue from the anthology ID (`ACL`, `NAACL`, `EMNLP`, `Findings of ACL`, …) + year |
| OpenReview | OpenReview API | see limitation below |
| Anything else | Google Scholar `citation_*` meta tags (works for NeurIPS proceedings, PMLR, IEEE, ACM, Semantic Scholar, …) | venue + year when present |

Non-paper URLs are never touched: if a page has no citation metadata, the URL is simply left as you pasted it.

## Usage

**On paste** — copy a paper URL and paste it into a note. It converts automatically. Only fires when the clipboard is exactly one URL; pasting prose containing URLs does nothing.

**Existing notes** — run the command **"Paper Manager: Convert paper URLs in current note"** from the command palette. It converts every bare paper URL in the active note, skipping URLs that are already links, in frontmatter, or inside code blocks, and reports a summary when done.

## Paper pages

Every converted paper link also gets a 📝 button pointing at the paper's own
note — one place per paper for your understanding, AI summaries, and links
from the rest of your notes:

> [Attention Is All You Need (arXiv 2017)](https://arxiv.org/abs/1706.03762) [[Papers/Attention Is All You Need|📝]]

The button is a real wikilink, so the paper's page shows every note that
mentions it under **Backlinks**, and the graph view connects them.

- **One page per paper.** Pages are identified by a `paper_id` in frontmatter
  (`arxiv:1706.03762`, `acl:N19-1423`, `doi:…`), not by file name: abs/pdf/
  versioned URLs of the same paper share one page, and you can rename or move
  pages freely. An arXiv preprint and its published version (same title) also
  share one page — the extra id is recorded under `also_ids`.
- **Created when you need it.** By default the page is created the first time
  you click 📝 (so casually pasted links don't litter the vault). Switch to
  *Immediately* or *Off* in settings.
- **Pre-filled.** Frontmatter with title, authors, year, venue, URL, PDF, DOI,
  a BibTeX-style `citekey`, `status: to-read`, and `tags: [paper]`; the body has
  the abstract plus *My Notes / AI Summary / Related* sections. Use your own
  template file with `{{title}}`, `{{authors}}`, `{{abstract}}`, `{{tldr}}`,
  `{{citekey}}`, `{{links}}`, … placeholders.
- **TL;DR.** A one-sentence summary from Semantic Scholar is added as `tldr`
  when available. The keyless API is heavily rate-limited; a free API key in
  settings makes it reliable, and **"Refresh metadata of current paper page"**
  retries later.
- **Overview table.** A new papers folder gets a `Papers.base`
  ([Bases](https://obsidian.md/help/bases)) table of all paper pages, sortable
  by year with a *To read* view. Recreate it with **"Create papers base"**.
- **Older notes.** **"Add paper page links to current note"** adds 📝 buttons
  to paper links that were converted before this feature existed.

### Migrating from Zotero

**"Migrate Zotero notes to paper pages"** turns notes exported from Zotero
(recognized by their `Zotero URI` property) into paper pages, so the vault is
the single home for your papers. A preview lists everything before anything
changes.

- Note bodies are kept; the abstract moves from properties into a callout.
- Zotero properties are renamed to the plugin's (`Title` → `title`, `Authors`
  → `authors`, `Short Title` → `aliases`, `Collections` → `collections`,
  `Tags` → `keywords`, `File Path` → `pdf_file`, …); Zotero-only ones are
  dropped, and your own properties are kept. Notes with content get
  `status: read`.
- Duplicate Zotero items of one paper are merged into a single page: list
  properties are combined, the duplicates' notes are appended, links to them
  are redirected, and the extra copies go to the system trash.
- Notes move into the paper pages folder under their current name; links
  update automatically, and `![[Zotero.base]]` embeds now point at the papers base.
- Every original file is first copied to `.paper-manager-backup/` in the vault.

## Link format

`[Title (Venue Year)](url)`, degrading gracefully when metadata is missing: `[Title (Venue)]`, `[Title (Year)]`, or just `[Title]`. If the venue already contains the year (e.g. `ICLR 2024`), the year isn't repeated.

## Known limitation: OpenReview

OpenReview fronts its API with a Cloudflare Turnstile challenge that blocks all non-interactive clients, including Obsidian's request layer. OpenReview URLs therefore currently stay as raw URLs, with a notice explaining why. The resolver is implemented and will start working automatically if OpenReview relaxes the block.

## Safety behavior

- A paste is never blocked or mangled: on any fetch failure the raw URL stays and a notice is shown.
- If you edit or undo before the title arrives, the replacement is silently dropped.
- URLs pasted into an existing `[text](` link are left alone.

## arXiv rate limits

arXiv's API asks clients to leave ~3 seconds between requests. The plugin
serializes its arXiv calls to respect this, retries a throttled request a few
times with exponential backoff, and — if it's still throttled — leaves the URL
raw and tells you to try again rather than failing silently. Converting a note
with many arXiv links is therefore paced deliberately (a few seconds per link).

## Installation

**From the community directory** (once accepted): Settings → Community plugins → Browse → "Paper Manager".

**Manual**: copy `main.js`, `manifest.json`, and `styles.css` from the latest [release](../../releases) into `<vault>/.obsidian/plugins/paper-manager/`, then enable the plugin in Settings → Community plugins.

## Development

```bash
npm install
npm test           # unit + live network tests (node)
npm run build      # typecheck + bundle to main.js
npm run dev        # watch mode
```

All metadata resolution lives in `src/resolvers.ts`, paper-page logic (naming, templates, link scanning) in `src/paperPage.ts`, and the Zotero mapping in `src/zoteroMigration.ts` — all pure with the HTTP function injected, so they run under plain node for tests. `src/main.ts` is the thin Obsidian layer. Adding a new source is a small resolver object plus a test.

## License

[MIT](LICENSE)
