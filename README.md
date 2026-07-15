# Paper Link

An [Obsidian](https://obsidian.md) plugin that **automatically** replaces pasted academic paper URLs with readable, titled markdown links, just when you press `ctrl+v`/`command+v`!

Paste `https://arxiv.org/abs/1706.03762` into a note and it becomes:

> [Attention Is All You Need (arXiv 2017)](https://arxiv.org/abs/1706.03762)

The paste itself is never delayed — the URL lands instantly, and the titled link is swapped in as soon as the metadata arrives (usually well under a second).

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

**Existing notes** — run the command **"Paper Link: Convert paper URLs in current note"** from the command palette. It converts every bare paper URL in the active note, skipping URLs that are already links, in frontmatter, or inside code blocks, and reports a summary when done.

## Link format

`[Title (Venue Year)](url)`, degrading gracefully when metadata is missing: `[Title (Venue)]`, `[Title (Year)]`, or just `[Title]`. If the venue already contains the year (e.g. `ICLR 2024`), the year isn't repeated.

## Known limitation: OpenReview

OpenReview fronts its API with a Cloudflare Turnstile challenge that blocks all non-interactive clients, including Obsidian's request layer. OpenReview URLs therefore currently stay as raw URLs, with a notice explaining why. The resolver is implemented and will start working automatically if OpenReview relaxes the block.

## Safety behavior

- A paste is never blocked or mangled: on any fetch failure the raw URL stays and a notice is shown.
- If you edit or undo before the title arrives, the replacement is silently dropped.
- URLs pasted into an existing `[text](` link are left alone.

## Installation

**From the community directory** (once accepted): Settings → Community plugins → Browse → "Paper Link".

**Manual**: copy `main.js` and `manifest.json` from the latest [release](../../releases) into `<vault>/.obsidian/plugins/paper-link/`, then enable the plugin in Settings → Community plugins.

## Development

```bash
npm install
npm test           # unit + live network tests (node)
npm run build      # typecheck + bundle to main.js
npm run dev        # watch mode
```

All metadata resolution lives in `src/resolvers.ts` as pure logic with the HTTP function injected, so it runs under plain node for tests. `src/main.ts` is the thin Obsidian layer. Adding a new source is a small resolver object plus a test.

## License

[MIT](LICENSE)
