import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAdminBook } from '../js/admin-ui.mjs';

const book = (patch = {}) => ({ id: 'cloud-123', title: ' Книга ', author: ' Автор ', year: null, source_url: '', chapters: [{ title: 'Глава', paragraphs: ['Книга — это путешествие.', 'Вни́мание к словам.'] }], published: false, ...patch });

test('catalogue writes derive the word count from chapters and retain inert text', () => {
  const row = prepareAdminBook(book({ total_words: 99999, title: '<img src=x onerror=alert(1)>', chapters: [{ title: '<script>Глава</script>', paragraphs: ['Слова остаются текстом.'] }] }));
  assert.equal(row.total_words, 3);
  assert.equal(row.title, '<img src=x onerror=alert(1)>');
  assert.equal(row.chapters[0].title, '<script>Глава</script>');
  assert.equal(row.published, false);
  assert.equal('created_at' in row, false);
});

test('only absolute HTTPS sources without embedded credentials are accepted', () => {
  for (const source_url of ['http://example.com/book', 'javascript:alert(1)', 'data:text/html,hello', '/book', 'https://user:password@example.com/book']) {
    assert.throws(() => prepareAdminBook(book({ source_url })), /https|https:\/\//i);
  }
  assert.equal(prepareAdminBook(book({ source_url: 'https://example.com/book?q=1#text' })).source_url, 'https://example.com/book?q=1#text');
});

test('empty or malformed contents cannot replace a catalogue book', () => {
  for (const chapters of [null, [], [{ paragraphs: [] }], [{ paragraphs: ['  ', '…'] }], [{ paragraphs: [42] }]]) {
    assert.throws(() => prepareAdminBook(book({ chapters })));
  }
});

test('optional years normalize while invalid metadata and implicit publishing fail safely', () => {
  assert.equal(prepareAdminBook(book({ year: '1888' })).year, 1888);
  assert.equal(prepareAdminBook(book({ year: '' })).year, null);
  assert.equal(prepareAdminBook(book({ published: 'true' })).published, false);
  assert.equal(prepareAdminBook(book({ year: -3000 })).year, -3000);
  for (const year of ['words', '2020.5', -3001, Infinity, true, 3001]) assert.throws(() => prepareAdminBook(book({ year })), /Год/);
  assert.throws(() => prepareAdminBook(book({ title: '   ' })), /название/);
  assert.throws(() => prepareAdminBook(book({ title: 'а'.repeat(241) })), /240/);
  assert.throws(() => prepareAdminBook(book({ author: 'а'.repeat(161) })), /160/);
});

test('validation creates fresh chapters without mutating an imported or open book', () => {
  const original = book();
  const before = structuredClone(original);
  const row = prepareAdminBook(original);
  row.chapters[0].paragraphs.push('Новый абзац.');
  assert.deepEqual(original, before);
  assert.equal(row.title, 'Книга');
  assert.equal(row.author, 'Автор');
});

test('catalogue resource limits reject malformed identifiers and excessive structures before tokenization', () => {
  for (const id of ['', '../book', 'cloud-book<script>', 'a'.repeat(81)]) assert.throws(() => prepareAdminBook(book({ id })), /идентификатор/);
  assert.throws(() => prepareAdminBook(book({ source_url: `https://example.com/${'a'.repeat(2048)}` })), /2048/);
  assert.throws(() => prepareAdminBook(book({ chapters: Array.from({ length: 2001 }, () => ({ title: 'Глава', paragraphs: ['Текст.'] })) })), /2000/);
  assert.throws(() => prepareAdminBook(book({ chapters: [{ title: 'г'.repeat(301), paragraphs: ['Текст.'] }] })), /300/);
  assert.throws(() => prepareAdminBook(book({ chapters: [{ title: 'Глава', paragraphs: ['а'.repeat(200001)] }] })), /200 000/);
});
