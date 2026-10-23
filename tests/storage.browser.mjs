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

function writeRawSettings(name, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(value, 'preferences');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
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
      const settings = await library.getSettings();
      equal(settings, DEFAULT_SETTINGS, 'Settings must use defaults');
      assert(settings.pauseOptions !== DEFAULT_SETTINGS.pauseOptions, 'Returned pauses must not share the defaults object');
      settings.pauseOptions.longWord = 4;
      equal(await library.getSettings(), DEFAULT_SETTINGS, 'Mutating a returned default must not affect future reads');
      assert(Object.isFrozen(DEFAULT_SETTINGS.pauseOptions), 'Nested defaults must be immutable');
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
        ...DEFAULT_SETTINGS, wpm: 600, smart: false, theme: 'dark', lastBookId: firstBook.id,
      }, 'Independent settings changes must all survive');
    });

    await test('Custom pauses merge independently and survive reopening without shared mutable defaults', async () => {
      const saved = await library.saveSettings({
        pauseOptions: { longWord: 1.1, sentence: 2.3 },
        startDelay: 1000, pauseAfterParagraph: true, pauseAfterChapter: true,
      });
      saved.pauseOptions.longWord = 4;
      await Promise.all([
        library.saveSettings({ pauseOptions: { punctuation: 1.7 } }),
        library.saveSettings({ pauseOptions: { paragraph: 3.2 } }),
      ]);
      await library.close();
      library = createLibrary(databaseName);
      const restored = await library.getSettings();
      equal(restored.pauseOptions, { longWord: 1.1, punctuation: 1.7, sentence: 2.3, paragraph: 3.2 }, 'Nested changes must preserve other pause values');
      equal(restored.startDelay, 1000, 'Start delay must survive reconnect');
      equal(restored.pauseAfterParagraph, true, 'Legacy paragraph stops must survive reconnect');
      equal(restored.pauseAfterChapter, true, 'Chapter stops must survive reconnect');
      equal(restored.smart, false, 'Custom pauses must not reenable legacy disabled smart pauses');
      restored.pauseOptions.paragraph = 1;
      equal((await library.getSettings()).pauseOptions.paragraph, 3.2, 'Returned pauses must not mutate storage');
      equal(DEFAULT_SETTINGS.pauseOptions, { longWord: 1.25, punctuation: 1.5, sentence: 2, paragraph: 2.5 }, 'Defaults must remain unchanged');
    });

    await test('Anchor mode survives reopening and accepts only center or left', async () => {
      const before = await library.getSettings();
      const bookBefore = await library.getBook(firstBook.id);
      equal((await library.saveSettings({ anchorMode: 'left' })).anchorMode, 'left', 'Left anchor mode must be saved');
      await library.close();
      library = createLibrary(databaseName);
      equal((await library.getSettings()).anchorMode, 'left', 'Left anchor mode must survive reopening');
      equal((await library.saveSettings({ theme: before.theme })).anchorMode, 'left', 'Unrelated settings patches must preserve anchor mode');
      equal((await library.saveSettings({ anchorMode: 'center' })).anchorMode, 'center', 'Center anchor mode must be saved');
      for (const invalid of ['right', 'LEFT', '', null, false, 1, {}]) {
        await writeRawSettings(databaseName, { ...before, anchorMode: invalid });
        equal((await library.getSettings()).anchorMode, 'center', 'Invalid stored anchor modes must normalize to center');
        const normalized = await library.saveSettings({ anchorMode: invalid });
        equal(normalized.anchorMode, 'center', 'Invalid anchor patches must normalize to center');
        equal((await readRawRecord(databaseName, 'settings', 'preferences')).anchorMode, 'center', 'Stored anchor mode must be normalized');
      }
      equal(await library.getBook(firstBook.id), bookBefore, 'Changing anchor mode must preserve the book and its position');
      equal((await library.getSettings()).smart, before.smart, 'Anchor changes must preserve smart mode');
      await library.saveSettings(before);
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
      const previousSettings = { wpm: 450, smart: false, theme: 'dark', lastBookId: firstBook.id, pauseAfterParagraph: true, fontScale: 1.2 };
      const legacyBook = { ...firstBook, position: 3, totalWords: 8, customMetadata: 'preserve me' };
      const upgraded = createLibrary(migrationName);
      try {
        await seedVersionOne(migrationName, [legacyBook, secondBook], previousSettings);
        equal(await upgraded.getBook(firstBook.id), legacyBook, 'Migration must preserve the complete legacy book');
        equal(await upgraded.getSettings(), { ...DEFAULT_SETTINGS, ...previousSettings }, 'Missing rhythm preferences must receive defaults while legacy values survive');
        equal((await upgraded.getSettings()).anchorMode, 'center', 'Legacy preferences must keep the original centered anchor');
        equal(await readRawRecord(migrationName, 'settings', 'preferences'), previousSettings, 'Reading legacy preferences must not rewrite the stored record');
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

    await test('Invalid saved rhythm values normalize on reads and writes without losing existing preferences', async () => {
      const previous = await library.getSettings();
      const invalid = {
        ...previous,
        pauseOptions: { longWord: -3, punctuation: 9, sentence: NaN, paragraph: 'not a number' },
        startDelay: 500,
        pauseAfterParagraph: 'true',
        pauseAfterChapter: 1,
      };
      await writeRawSettings(databaseName, invalid);
      const restored = await library.getSettings();
      equal(restored.pauseOptions, { longWord: 1, punctuation: 4, sentence: 2, paragraph: 2.5 }, 'Finite values must clamp; invalid values must use their own defaults');
      equal(restored.startDelay, 0, 'Unsupported delay must return to the default');
      equal(restored.pauseAfterParagraph, false, 'Nonboolean paragraph setting must use the default');
      equal(restored.pauseAfterChapter, false, 'Nonboolean chapter setting must use the default');
      equal(restored.smart, false, 'Existing disabled smart mode must survive normalization');
      equal(restored.wpm, previous.wpm, 'Rhythm normalization must preserve speed');
      equal(restored.theme, previous.theme, 'Rhythm normalization must preserve theme');
      const saved = await library.saveSettings({ pauseOptions: { sentence: '3', paragraph: Infinity }, startDelay: 2000 });
      equal(saved.pauseOptions, { longWord: 1, punctuation: 4, sentence: 3, paragraph: 2.5 }, 'Save must normalize values with the same rules and preserve valid boundaries');
      equal(await readRawRecord(databaseName, 'settings', 'preferences'), saved, 'Stored settings must be normalized');
      equal((await library.saveSettings({ startDelay: 0 })).startDelay, 0, 'Zero is a valid start delay');
      const retained = await library.saveSettings({ pauseOptions: null, startDelay: '1000' });
      equal(retained.pauseOptions, saved.pauseOptions, 'An invalid nested patch must not erase existing pause choices');
      equal(retained.startDelay, 0, 'Delay accepts supported numeric values only');
      await writeRawSettings(databaseName, { ...previous, pauseOptions: null });
      equal((await library.getSettings()).pauseOptions, DEFAULT_SETTINGS.pauseOptions, 'Invalid saved pause objects must receive fresh defaults');
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
