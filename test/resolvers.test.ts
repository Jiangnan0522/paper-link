import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSingleUrl,
  formatLink,
  parseArxivAtom,
  parseCitationMeta,
  arxivId,
  resolvePaperUrl,
} from '../src/resolvers';
import type { HttpGet } from '../src/resolvers';

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

test('parseCitationMeta handles unquoted attribute names (ACL Anthology style)', () => {
  const html = `<head><meta content="BERT: Pre-training" name=citation_title>
    <meta content="2019/6" name=citation_publication_date></head>`;
  assert.deepEqual(parseCitationMeta(html), {
    title: 'BERT: Pre-training',
    year: '2019',
  });
});

test('parseCitationMeta returns null without citation_title', () => {
  assert.equal(parseCitationMeta('<html><head><title>Blog</title></head></html>'), null);
});

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

test('live: OpenReview forum URL', async (t) => {
  // OpenReview fronts its API with a Cloudflare Turnstile challenge that
  // rejects non-browser TLS fingerprints (curl, node fetch). Obsidian's
  // requestUrl uses Electron's Chromium stack, so the plugin itself may still
  // pass — that path is verified live in the app, not here.
  const challenged = await http('https://api2.openreview.net/notes?id=YicbFdNTTy').then(
    (body) => body.includes('ChallengeRequiredError'),
    () => true,
  );
  if (challenged) {
    t.skip('OpenReview API challenged from node — verified inside Obsidian instead');
    return;
  }
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
