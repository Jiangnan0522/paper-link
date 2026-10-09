import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendMergedNotes,
  bareDoi,
  mergeMigrations,
  isZoteroNote,
  migrateZoteroFrontmatter,
  prependAbstract,
} from '../src/zoteroMigration';

const NOTE = {
  base: '[[Zotero.base]]',
  Place: '',
  'Item Type': 'Preprint',
  'Citation Key': '',
  'Proceedings Title': '',
  DOI: 'https://doi.org/10.48550/arXiv.2408.03094',
  Tags: ['Computer Science - Computation and Language'],
  'In-Text Citation': 'Li et al., ‘500xCompressor’.',
  'Datasets Used': [],
  'Short Title': '500xCompressor',
  Abstract: 'Prompt compression is\ncrucial.',
  'Date Modified': '2025-10-25T18:43:00',
  URL: 'http://arxiv.org/abs/2408.03094',
  Publication: '',
  Year: 2024,
  'File Path': '/Users/x/Zotero/storage/X/Li.pdf',
  Date: '2024-08-06',
  Taxonomy: ['seminal'],
  'Zotero URI': 'https://zotero.org/u/items/VCVFFIML',
  Title: '500xCompressor: Generalized Prompt Compression for Large Language Models',
  'Date Added': '2025-10-25T18:43:00',
  Field: [],
  Collections: ['1PhD ▸ Compression'],
  Extra: 'arXiv:2408.03094 [cs]',
  Authors: 'Li, Zongqian\nSu, Yixuan\nCollier, Nigel',
  方向: ['[[Visual-Text Compression|Visual-Text Compression]]'],
  'Series Title': '',
  'Full Citation': 'Li, Zongqian, …',
};

test('isZoteroNote keys on the Zotero item URI', () => {
  assert.equal(isZoteroNote(NOTE), true);
  assert.equal(isZoteroNote({ Title: 'x' }), false);
  assert.equal(isZoteroNote(undefined), false);
});

test('bareDoi strips resolver prefixes', () => {
  assert.equal(bareDoi('https://doi.org/10.1/X'), '10.1/X');
  assert.equal(bareDoi('http://dx.doi.org/10.1/X'), '10.1/X');
  assert.equal(bareDoi('10.1/X'), '10.1/X');
});

test('migrateZoteroFrontmatter maps an arXiv preprint to a paper page', () => {
  const m = migrateZoteroFrontmatter(NOTE, true)!;
  assert.equal(m.paperId, 'arxiv:2408.03094');
  assert.equal(m.abstract, 'Prompt compression is crucial.');
  assert.deepEqual(m.frontmatter, {
    paper_id: 'arxiv:2408.03094',
    title: '500xCompressor: Generalized Prompt Compression for Large Language Models',
    aliases: ['500xCompressor'],
    authors: ['Zongqian Li', 'Yixuan Su', 'Nigel Collier'],
    year: 2024,
    venue: 'arXiv',
    url: 'https://arxiv.org/abs/2408.03094',
    pdf: 'https://arxiv.org/pdf/2408.03094',
    citekey: 'li2024500xcompressor',
    status: 'read',
    created: '2025-10-25',
    collections: ['1PhD ▸ Compression'],
    keywords: ['Computer Science - Computation and Language'],
    pdf_file: '/Users/x/Zotero/storage/X/Li.pdf',
    tags: ['paper'],
    'Datasets Used': [],
    Taxonomy: ['seminal'],
    方向: ['[[Visual-Text Compression|Visual-Text Compression]]'],
  });
  // no capitalized Zotero key survives (property names are case-insensitive)
  for (const k of ['Title', 'Authors', 'Year', 'URL', 'DOI', 'Tags', 'Abstract', 'base'])
    assert.equal(k in m.frontmatter, false, k);
});

test('migrateZoteroFrontmatter uses a journal DOI as identity when there is no paper URL', () => {
  const m = migrateZoteroFrontmatter(
    {
      'Zotero URI': 'https://zotero.org/u/items/K',
      Title: 'A Journal Paper',
      'Item Type': 'Journal Article',
      DOI: '10.1038/Nature123',
      Publication: 'Nature',
      Authors: ['Ada Lovelace'],
      Date: '2021-03-01',
    },
    false,
  )!;
  assert.equal(m.paperId, 'doi:10.1038/nature123');
  assert.equal(m.frontmatter.url, 'https://doi.org/10.1038/Nature123');
  assert.equal(m.frontmatter.doi, '10.1038/Nature123');
  assert.equal(m.frontmatter.venue, 'Nature');
  assert.equal(m.frontmatter.year, 2021);
  assert.equal(m.frontmatter.status, 'to-read');
});

test('migrateZoteroFrontmatter falls back to the Zotero key and skips untitled notes', () => {
  assert.equal(
    migrateZoteroFrontmatter({ 'Zotero URI': 'https://zotero.org/u/items/ABC', Title: 'T' }, false)!
      .paperId,
    'zotero:ABC',
  );
  assert.equal(migrateZoteroFrontmatter({ 'Zotero URI': 'u' }, false), null);
});

test('prependAbstract puts a collapsed callout above existing notes', () => {
  assert.equal(
    prependAbstract('\n> [!note]+ mine\n', 'Abs.'),
    '> [!abstract]- Abstract\n> Abs.\n\n> [!note]+ mine\n',
  );
  assert.equal(prependAbstract('', 'Abs.'), '> [!abstract]- Abstract\n> Abs.\n');
});

test('mergeMigrations unions list fields and keeps the earliest date and read status', () => {
  const a = migrateZoteroFrontmatter(
    { ...NOTE, Collections: ['A'], 'Date Added': '2025-12-07T00:00:00', 方向: [] },
    false,
  )!;
  const b = migrateZoteroFrontmatter(
    { ...NOTE, Collections: ['B', 'A'], 'Date Added': '2025-10-01T00:00:00', 方向: ['[[X]]'] },
    true,
  )!;
  const m = mergeMigrations(a, [b]);
  assert.deepEqual(m.frontmatter.collections, ['A', 'B']);
  assert.deepEqual(m.frontmatter['方向'], ['[[X]]']);
  assert.equal(m.frontmatter.created, '2025-10-01');
  assert.equal(m.frontmatter.status, 'read');
  assert.deepEqual(m.frontmatter.aliases, ['500xCompressor']);
});

test('appendMergedNotes adds a duplicate note body under a heading', () => {
  assert.equal(
    appendMergedNotes('mine\n\n', 'Paper 1', '\ntheirs\n'),
    'mine\n\n## Notes from "Paper 1"\n\ntheirs\n',
  );
});
