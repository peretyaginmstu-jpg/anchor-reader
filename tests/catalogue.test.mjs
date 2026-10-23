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
  'tolstoy-ivan-ilyich': { chapters: 12, words: 17366, minimum: 17000 },
  'tolstoy-after-the-ball': { chapters: 1, words: 3093, minimum: 3000 },
  'tolstoy-hadji-murat': { chapters: 26, words: 34761, minimum: 34000 },
  'chekhov-ward-six': { chapters: 19, words: 16075, minimum: 16000 },
  'chekhov-lady-with-the-dog': { chapters: 4, words: 5109, minimum: 5000 },
  'chekhov-man-in-a-case': { chapters: 1, words: 4007, minimum: 4000 },
  'pushkin-captain-daughter': { chapters: 14, words: 29670, minimum: 29000 },
  'pushkin-queen-spades': { chapters: 7, words: 6944, minimum: 6900 },
  'pushkin-stationmaster': { chapters: 1, words: 3444, minimum: 3400 },
  'gogol-overcoat': { chapters: 1, words: 9990, minimum: 9900 },
  'gogol-nose': { chapters: 3, words: 7656, minimum: 7600 },
  'gogol-christmas-eve': { chapters: 2, words: 13297, minimum: 13000 },
};
test('The Russian catalogue contains sixteen complete works by five authors', () => {
  assert.deepEqual(new Set(manifest.map(book => book.id)), new Set(Object.keys(expected)));
  assert.equal(manifest.length, 16);
  assert.deepEqual(new Set(manifest.map(book => book.author)), new Set(['Фёдор Достоевский', 'Лев Толстой', 'Антон Чехов', 'Александр Пушкин', 'Николай Гоголь']));
});
for (const entry of manifest) test(`${entry.title}: complete chapter order, unique chapters and reading counts`, async () => {
  const book = JSON.parse(await readFile(new URL(`../books/${entry.file}`, import.meta.url), 'utf8'));
  const expectedBook = expected[entry.id];
  assert.equal(book.id, entry.id);
  assert.equal(book.author, entry.author);
  assert.equal(book.title, entry.title);
  assert.equal(book.chapters.length, expectedBook.chapters);
  assert.equal(entry.chapterCount, expectedBook.chapters);
  assert.equal(book.source.url, entry.source.url);
  assert.match(book.source.url, /^https:\/\/(rvb\.ru|ru\.wikisource\.org)\//);
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
