const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

// Keep й intact: decomposing and removing every mark would merge it with и.
export function normalizeSearch(value = '') {
  return String(value).normalize('NFC').toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е').replace(/[\u0300\u0301]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchesBook(book, query = '', author = '') {
  if (author && normalizeSearch(book.author) !== normalizeSearch(author)) return false;
  const haystack = normalizeSearch(`${book.title} ${book.author || ''}`);
  return normalizeSearch(query).split(/\s+/u).filter(Boolean).every(term => haystack.includes(term));
}

export function selectBooks(books, { query = '', author = '', sort = 'shelf' } = {}) {
  const result = books.filter(book => matchesBook(book, query, author));
  if (sort === 'title') result.sort((a, b) => collator.compare(a.title, b.title));
  if (sort === 'short') result.sort((a, b) => (a.wordCount ?? a.totalWords ?? Infinity) - (b.wordCount ?? b.totalWords ?? Infinity) || collator.compare(a.title, b.title));
  return result;
}

export function listAuthors(books) {
  return [...new Set(books.map(book => book.author?.trim()).filter(Boolean))]
    .sort((a, b) => collator.compare(a.split(' ').at(-1), b.split(' ').at(-1)) || collator.compare(a, b));
}

export function bookCount(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun = mod100 >= 11 && mod100 <= 14 ? 'книг' : mod10 === 1 ? 'книга' : mod10 >= 2 && mod10 <= 4 ? 'книги' : 'книг';
  return `${count} ${noun}`;
}
