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
