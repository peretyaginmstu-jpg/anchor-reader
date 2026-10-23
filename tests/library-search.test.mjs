import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearch, matchesBook, selectBooks, listAuthors, bookCount } from '../js/library-search.mjs';

const books = [
  { title: 'Белые ночи', author: 'Фёдор Достоевский', wordCount: 16854 },
  { title: 'Смерть Ивана Ильича', author: 'Лев Толстой', wordCount: 21000 },
  { title: 'Ёлка: мой текст', author: '', totalWords: 500 },
];
test('Search ignores case, ё/е, punctuation and stress, but retains й', () => {
  assert.equal(normalizeSearch('  ФЁДОР, мо́ре!  '), 'федор море');
  assert.notEqual(normalizeSearch('чай'), normalizeSearch('чаи'));
  assert.ok(matchesBook(books[0], 'ФЕДОР ночи'));
  assert.ok(matchesBook(books[2], 'елка мой'));
});
test('All terms must match across title and author; the author filter combines with query', () => {
  assert.ok(matchesBook(books[1], 'ивана толст'));
  assert.ok(!matchesBook(books[1], 'ивана ночи'));
  assert.ok(!matchesBook(books[0], 'ночи', 'Лев Толстой'));
  assert.ok(matchesBook(books[0], '', 'Федор Достоевский'));
  assert.equal(selectBooks(books, { query: '   ' }).length, 3);
  assert.equal(selectBooks(books, { query: '<script>' }).length, 0);
});
test('Sorting includes local books, remains stable and never changes the source array', () => {
  assert.equal(selectBooks(books, { sort: 'short' })[0], books[2]);
  assert.equal(selectBooks(books, { sort: 'title' })[0], books[0]);
  assert.equal(books[0].title, 'Белые ночи');
  assert.deepEqual(listAuthors([...books, books[0]]), ['Фёдор Достоевский', 'Лев Толстой']);
});
test('Russian book counts use the right noun', () => {
  assert.deepEqual([0, 1, 3, 11, 21].map(bookCount), ['0 книг', '1 книга', '3 книги', '11 книг', '21 книга']);
});
