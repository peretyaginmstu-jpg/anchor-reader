import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tokenizeChapters } from '../js/reader.mjs';

const manifest = JSON.parse(await readFile(new URL('../books/manifest.json', import.meta.url), 'utf8'));
const expected = {
  'dostoevsky-crime': { chapters: 41, words: 169866, minimum: 160000 },
  'dostoevsky-idiot': { chapters: 50, words: 206669, minimum: 200000 },
  'dostoevsky-karamazov': { chapters: 97, words: 292778, minimum: 290000 },
  'dostoevsky-white-nights': { chapters: 6, words: 16854, minimum: 16000 },
};
test('The Russian catalogue contains exactly the four requested complete works', () => {
  assert.deepEqual(new Set(manifest.map(book => book.id)), new Set(Object.keys(expected)));
});
for (const entry of manifest) test(`${entry.title}: complete chapter order, unique chapters and reading counts`, async () => {
  const book = JSON.parse(await readFile(new URL(`../books/${entry.file}`, import.meta.url), 'utf8'));
  const expectedBook = expected[entry.id];
  assert.equal(book.id, entry.id);
  assert.equal(book.author, 'Фёдор Достоевский');
  assert.equal(book.chapters.length, expectedBook.chapters);
  assert.equal(entry.chapterCount, expectedBook.chapters);
  assert.match(book.source.url, /^https:\/\/rvb.ru\/dostoevski\//);
  const hashes = book.chapters.map(chapter => {
    assert.ok(chapter.title.trim());
    assert.ok(chapter.paragraphs.length > 0);
    assert.ok(chapter.paragraphs.every(text => typeof text === 'string' && text.trim()));
    return createHash('sha256').update(chapter.paragraphs.join('\n')).digest('hex');
  });
  assert.equal(new Set(hashes).size, hashes.length, 'Repeated source chapter');
  const doc = tokenizeChapters(book.chapters);
  assert.equal(doc.totalWords, entry.wordCount);
  assert.equal(doc.totalWords, expectedBook.words);
  assert.ok(doc.totalWords > expectedBook.minimum);
  assert.equal(doc.chapters.length, expectedBook.chapters);
  assert.ok(doc.tokens.every(token => token.anchor && token.prefix + token.anchor + token.suffix === token.text));
});
