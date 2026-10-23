import { createLibrary, DEFAULT_SETTINGS } from '../js/storage.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

function removeTestDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Test database cleanup is blocked'));
  });
}

function readRawRecord(name, store, id) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try {
        let result;
        const tx = db.transaction(store, 'readonly');
        const read = tx.objectStore(store).get(id);
        read.onsuccess = () => { result = read.result; };
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

function seedVersionOne(name, books, settings) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('books', { keyPath: 'id' });
      request.result.createObjectStore('settings');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['books', 'settings'], 'readwrite');
      for (const book of books) tx.objectStore('books').put(book);
      tx.objectStore('settings').put(settings, 'preferences');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

/** Run in a browser; every run creates and deletes a private test database. */
export async function runStorageTests() {
  const databaseName = `anchor-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let library = createLibrary(databaseName);
  const results = [];
  const test = async (name, run) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: error?.message || String(error) });
    }
  };
  const firstBook = {
    id: 'book-one', title: 'Книга с ударе́нием', author: 'Автор',
    chapters: [{ title: 'Начало', paragraphs: ['Первое слово. Второе слово.', 'Ещё один абзац.'] }],
    createdAt: 100, updatedAt: 100, position: 0,
  };
  const secondBook = {
    id: 'book-two', title: 'Вторая книга', author: '',
    chapters: [{ title: 'Глава 1', paragraphs: ['Раз. Два. Три.'] }],
    createdAt: 200, updatedAt: 200, position: 2,
  };

  try {
    await test('New database has defaults and an empty library', async () => {
      equal(await library.getSettings(), DEFAULT_SETTINGS, 'Settings must use defaults');
      equal(await library.listBooks(), [], 'Library must start empty');
      equal(await library.getBook('unknown'), null, 'Unknown book must be null');
    });

    await test('Book content, Unicode, and metadata survive a round trip', async () => {
      await library.saveBook(firstBook);
      await library.saveBook(secondBook);
      equal(await library.getBook(firstBook.id), firstBook, 'Book data must be preserved');
      const list = await library.listBooks();
      equal(list.map((book) => book.id), [secondBook.id, firstBook.id], 'Books must be sorted by recency');
      assert(list.every((book) => !Object.hasOwn(book, 'chapters')), 'Metadata must omit chapter contents');
    });

    await test('Updating progress preserves all book fields and moves it to the top', async () => {
      await library.savePosition(firstBook.id, 4);
      const saved = await library.getBook(firstBook.id);
      equal(saved.chapters, firstBook.chapters, 'Progress must not overwrite chapters');
      equal(saved.title, firstBook.title, 'Progress must preserve title');
      equal(saved.author, firstBook.author, 'Progress must preserve author');
      equal(saved.createdAt, firstBook.createdAt, 'Progress must preserve creation time');
      equal(saved.position, 4, 'Progress must be saved');
      assert(saved.updatedAt > firstBook.updatedAt, 'Progress must update recency');
      equal((await library.listBooks())[0].id, firstBook.id, 'Read book must be first');
      await library.savePosition('unknown', 3);
      equal(await library.getBook('unknown'), null, 'Stale progress must not create a partial book');
    });

    await test('Progress writes metadata without rewriting stored book content', async () => {
      const rawContent = await readRawRecord(databaseName, 'books', firstBook.id);
      const metadata = await readRawRecord(databaseName, 'metadata', firstBook.id);
      equal(rawContent, firstBook, 'The full book record must remain identical after a progress save');
      equal(rawContent.position, 0, 'The content record keeps its original position');
      equal(metadata.position, 4, 'The metadata record holds the current position');
      assert(!Object.hasOwn(metadata, 'chapters'), 'Progress metadata must not contain chapter text');
      equal((await library.getBook(firstBook.id)).position, 4, 'Public reads must merge current metadata');
    });

    await test('Partial and concurrent settings changes merge atomically', async () => {
      await library.saveSettings({ wpm: 600, lastBookId: firstBook.id });
      await Promise.all([
        library.saveSettings({ theme: 'dark' }),
        library.saveSettings({ smart: false }),
      ]);
      equal(await library.getSettings(), {
        wpm: 600, smart: false, theme: 'dark', lastBookId: firstBook.id,
      }, 'Independent settings changes must all survive');
    });

    await test('Closing and reopening preserves books, settings, and position', async () => {
      await library.close();
      library = createLibrary(databaseName);
      equal((await library.getBook(firstBook.id)).position, 4, 'Position must survive reconnect');
      equal((await library.getBook(firstBook.id)).chapters, firstBook.chapters, 'Contents must survive reconnect');
      equal((await library.getSettings()).wpm, 600, 'Settings must survive reconnect');
    });

    await test('Deleting another book keeps current selection; deleting it clears selection', async () => {
      await library.deleteBook(secondBook.id);
      equal(await library.getBook(secondBook.id), null, 'Deleted book must be absent');
      equal(await readRawRecord(databaseName, 'metadata', secondBook.id), undefined, 'Deleted metadata must be absent');
      equal(await readRawRecord(databaseName, 'books', secondBook.id), undefined, 'Deleted content must be absent');
      equal((await library.getSettings()).lastBookId, firstBook.id, 'Unrelated deletion must keep selection');
      await library.deleteBook(firstBook.id);
      equal(await library.listBooks(), [], 'Both books must be removed');
      const settings = await library.getSettings();
      equal(settings.lastBookId, null, 'Deleting selected book must clear selection');
      equal(settings.wpm, 600, 'Deleting a book must preserve reader settings');
    });

    await test('Version 1 upgrades to metadata without losing books, positions, or settings', async () => {
      const migrationName = `${databaseName}-v1`;
      const previousSettings = { wpm: 450, smart: false, theme: 'dark', lastBookId: firstBook.id };
      const legacyBook = { ...firstBook, position: 3, totalWords: 8, customMetadata: 'preserve me' };
      const upgraded = createLibrary(migrationName);
      try {
        await seedVersionOne(migrationName, [legacyBook, secondBook], previousSettings);
        equal(await upgraded.getBook(firstBook.id), legacyBook, 'Migration must preserve the complete legacy book');
        equal(await upgraded.getSettings(), previousSettings, 'Migration must preserve preferences and selection');
        const list = await upgraded.listBooks();
        equal(list.map((book) => book.id), [secondBook.id, firstBook.id], 'Migrated metadata must retain recency order');
        const { chapters, ...expectedMetadata } = legacyBook;
        equal(await readRawRecord(migrationName, 'metadata', firstBook.id), expectedMetadata, 'Migration must copy every field except chapters');
        equal(await readRawRecord(migrationName, 'books', firstBook.id), legacyBook, 'Migration must leave source content intact');
        await upgraded.savePosition(firstBook.id, 6);
        equal((await upgraded.getBook(firstBook.id)).position, 6, 'Migrated books must accept new progress');
        equal((await readRawRecord(migrationName, 'books', firstBook.id)).position, 3, 'Progress after migration must not rewrite source content');
        await upgraded.close();
        equal((await upgraded.getBook(firstBook.id)).position, 6, 'Version 2 reopening must retain metadata progress');
      } finally {
        await upgraded.close();
        await removeTestDatabase(migrationName);
      }
    });
  } finally {
    await test('Test database is closed and removed', async () => {
      await library.close();
      await removeTestDatabase(databaseName);
    });
  }
  return {
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    results,
  };
}
