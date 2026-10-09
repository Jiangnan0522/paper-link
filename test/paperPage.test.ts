import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPaperLinks,
  makeCitekey,
  nameCandidates,
  pageFrontmatter,
  pageLinkMarkup,
  renderTemplate,
  sanitizeFileName,
  templateVars,
  titleKey,
  DEFAULT_TEMPLATE,
} from '../src/paperPage';
import {
  canonicalPaperId,
  canonicalPaperUrl,
  fetchS2Extra,
  parseArxivAtom,
  parseCitationMeta,
  s2Identifier,
} from '../src/resolvers';

const ATTENTION = {
  title: 'Attention Is All You Need',
  venue: 'arXiv',
  year: '2017',
  authors: ['Ashish Vaswani', 'Noam Shazeer'],
  abstract: 'The dominant sequence transduction models…',
  pdfUrl: 'https://arxiv.org/pdf/1706.03762',
};

test('sanitizeFileName turns colons into dashes and drops unsafe characters', () => {
  assert.equal(
    sanitizeFileName('BERT: Pre-training of Deep Bidirectional Transformers'),
    'BERT - Pre-training of Deep Bidirectional Transformers',
  );
  assert.equal(sanitizeFileName('What/Why? A "study" of [x] #1 | ^2'), 'What Why A study of x 1 2');
  assert.equal(sanitizeFileName('...hidden.'), 'hidden');
  assert.equal(sanitizeFileName('???'), 'Untitled paper');
});

test('sanitizeFileName caps long titles at a word boundary', () => {
  const name = sanitizeFileName('word '.repeat(40));
  assert.ok(name.length <= 100);
  assert.ok(name.endsWith('word'));
});

test('nameCandidates prefers the bare title, then year, then id', () => {
  assert.deepEqual(nameCandidates(ATTENTION, 'arxiv:1706.03762'), [
    'Attention Is All You Need',
    'Attention Is All You Need (2017)',
    'Attention Is All You Need (1706.03762)',
  ]);
});

test('makeCitekey builds surname + year + first content word', () => {
  assert.equal(makeCitekey(ATTENTION), 'vaswani2017attention');
  assert.equal(
    makeCitekey({ title: 'The Ölmo Model', year: '2024', authors: ['Dirk Groeneveld'] }),
    'groeneveld2024olmo',
  );
  assert.equal(makeCitekey({ title: 'On the X' }), 'anonx');
});

test('canonicalPaperId normalizes URL variants of the same paper', () => {
  const id = 'arxiv:1706.03762';
  assert.equal(canonicalPaperId('https://arxiv.org/abs/1706.03762'), id);
  assert.equal(canonicalPaperId('https://arxiv.org/pdf/1706.03762v5'), id);
  assert.equal(canonicalPaperId('https://www.arxiv.org/abs/1706.03762v2'), id);
  assert.equal(canonicalPaperId('https://aclanthology.org/N19-1423.pdf'), 'acl:N19-1423');
  assert.equal(canonicalPaperId('https://aclanthology.org/2023.acl-long.1/'), 'acl:2023.acl-long.1');
  assert.equal(canonicalPaperId('https://openreview.net/forum?id=abc'), 'openreview:abc');
  assert.equal(
    canonicalPaperId('https://example.org/p/1/', { title: 'T', doi: '10.1/ABC' }),
    'doi:10.1/abc',
  );
  assert.equal(canonicalPaperId('https://www.example.org/p/1/'), 'url:example.org/p/1');
});

test('s2Identifier maps canonical ids to Semantic Scholar ids', () => {
  assert.equal(s2Identifier('arxiv:1706.03762', ''), 'arXiv:1706.03762');
  assert.equal(s2Identifier('acl:N19-1423', ''), 'ACL:N19-1423');
  assert.equal(s2Identifier('doi:10.1/x', ''), 'DOI:10.1/x');
  assert.equal(s2Identifier('url:x.org/p', 'https://x.org/p'), 'URL:https://x.org/p');
});

test('fetchS2Extra reads tldr and abstract and passes the api key', async () => {
  let seen: { url: string; headers?: Record<string, string> } | undefined;
  const extra = await fetchS2Extra(
    'arxiv:1706.03762',
    'https://arxiv.org/abs/1706.03762',
    async (url, headers) => {
      seen = { url, headers };
      return JSON.stringify({ tldr: { text: 'A new  architecture.' }, abstract: 'Abs' });
    },
    'KEY',
  );
  assert.deepEqual(extra, { tldr: 'A new architecture.', abstract: 'Abs' });
  assert.match(seen!.url, /paper\/arXiv:1706\.03762\?fields=tldr,abstract$/);
  assert.deepEqual(seen!.headers, { 'x-api-key': 'KEY' });
});

test('parseArxivAtom extracts authors, abstract, and doi', () => {
  const meta = parseArxivAtom(`<feed><entry><title>T</title>
    <summary>  An
      abstract. </summary><published>2020-01-01</published>
    <author><name>A One</name></author><author>
      <name>B Two</name></author><arxiv:doi xmlns:arxiv="x">10.1/X</arxiv:doi></entry></feed>`);
  assert.deepEqual(meta, {
    title: 'T',
    venue: 'arXiv',
    year: '2020',
    authors: ['A One', 'B Two'],
    abstract: 'An abstract.',
    doi: '10.1/X',
  });
});

test('parseCitationMeta collects authors (flipping "Last, First"), doi, pdf', () => {
  const meta = parseCitationMeta(`
    <meta name="citation_title" content="T">
    <meta name="citation_author" content="Devlin, Jacob">
    <meta name="citation_author" content="Ming-Wei Chang">
    <meta name="citation_doi" content="10.18653/v1/N19-1423">
    <meta name="citation_pdf_url" content="https://x.org/p.pdf">
    <meta name="citation_abstract" content="Abs.">`);
  assert.deepEqual(meta, {
    title: 'T',
    authors: ['Jacob Devlin', 'Ming-Wei Chang'],
    abstract: 'Abs.',
    doi: '10.18653/v1/N19-1423',
    pdfUrl: 'https://x.org/p.pdf',
  });
});

test('renderTemplate fills placeholders and leaves unknown ones', () => {
  const vars = templateVars(ATTENTION, 'https://arxiv.org/abs/1706.03762', 'arxiv:1706.03762', {
    date: '2026-10-09',
  });
  assert.equal(
    renderTemplate('{{title}} / {{ authors }} / {{citekey}} / {{nope}}', vars),
    'Attention Is All You Need / Ashish Vaswani, Noam Shazeer / vaswani2017attention / {{nope}}',
  );
  const body = renderTemplate(DEFAULT_TEMPLATE, vars);
  assert.match(body, /^# Attention Is All You Need\n/);
  assert.match(body, /\[Paper\]\(https:\/\/arxiv\.org\/abs\/1706\.03762\) · \[PDF\]\(https:\/\/arxiv\.org\/pdf\/1706\.03762\)/);
  assert.match(body, /> The dominant sequence/);
});

test('pageFrontmatter carries the identity and omits empty fields', () => {
  assert.deepEqual(pageFrontmatter({ title: 'T' }, 'https://x.org/p', 'url:x.org/p'), {
    paper_id: 'url:x.org/p',
    title: 'T',
    url: 'https://x.org/p',
    citekey: 'anont',
  });
  const fm = pageFrontmatter(ATTENTION, 'u', 'arxiv:1706.03762', 'Short.');
  assert.equal(fm.year, 2017);
  assert.equal(fm.tldr, 'Short.');
  assert.equal(fm.pdf, ATTENTION.pdfUrl);
});

test('pageLinkMarkup strips the .md extension', () => {
  assert.equal(pageLinkMarkup('Papers/Attention.md'), '[[Papers/Attention|📝]]');
});

test('findPaperLinks pairs links with a following page wikilink', () => {
  const text = [
    '---',
    'source: [x](https://skip.org/fm)',
    '---',
    'See [A (arXiv 2017)](https://arxiv.org/abs/1) [[Papers/A|📝]] and [B](https://b.org/2).',
    '![img](https://img.org/i.png) `[c](https://code.org/c)`',
    '```',
    '[d](https://fence.org/d)',
    '```',
    '[E \\[x\\]](https://e.org/e)[[Papers/E#sec|📝]]',
  ].join('\n');
  const refs = findPaperLinks(text);
  assert.deepEqual(
    refs.map((r) => [r.url, r.pageLink, r.line]),
    [
      ['https://arxiv.org/abs/1', 'Papers/A', 3],
      ['https://b.org/2', undefined, 3],
      ['https://e.org/e', 'Papers/E', 8],
    ],
  );
  const line = text.split('\n')[3];
  assert.equal(line.slice(0, refs[1].end).endsWith('(https://b.org/2)'), true);
});

test('titleKey matches titles that differ only in case and punctuation', () => {
  assert.equal(
    titleKey('BERT: Pre-training of Deep Bidirectional Transformers'),
    titleKey('BERT - Pre-Training of Deep Bidirectional Transformers'),
  );
  assert.notEqual(titleKey('Attention Is All You Need'), titleKey('Attention Is Not All You Need'));
});

test('canonicalPaperUrl maps arXiv variants to the versionless abs page', () => {
  assert.equal(canonicalPaperUrl('https://arxiv.org/pdf/1706.03762v5'), 'https://arxiv.org/abs/1706.03762');
  assert.equal(canonicalPaperUrl('https://aclanthology.org/N19-1423/'), 'https://aclanthology.org/N19-1423/');
});
