/** Local-only library. Callers may keep reading in memory if storage rejects. */
export const DEFAULT_SETTINGS = Object.freeze({
  wpm: 300,
  smart: true,
  theme: 'light',
  lastBookId: null,
});

const SETTINGS_KEY = 'preferences';

function storageError(cause) {
  if (cause?.isLibraryError) return cause;
  const error = new Error('Не удалось открыть или сохранить библиотеку в браузере. Проверьте доступ к локальному хранилищу и свободное место. Вы можете продолжить чтение без сохранения.');
  error.name = 'LibraryStorageError';
  error.cause = cause;
  error.isLibraryError = true;
  return error;
}

function timestamp(value) {
  if (typeof value === 'number') return value;
  return Date.parse(value || '') || 0;
}

function metadataOf({ chapters, ...metadata }) {
  return metadata;
}

/** A separate name gives tests their own database, without touching the library. */
export function createLibrary(dbName = 'anchor-reader') {
  let connection = null;
  let opening = null;

  function open() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const fail = (cause) => {
        if (settled) return;
        settled = true;
        reject(storageError(cause));
      };
      try {
        if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable');
        request = globalThis.indexedDB.open(dbName, 2);
      } catch (cause) {
        fail(cause);
        return;
      }
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const books = db.objectStoreNames.contains('books')
          ? request.transaction.objectStore('books')
          : db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
        const metadata = db.objectStoreNames.contains('metadata')
          ? request.transaction.objectStore('metadata')
          : db.createObjectStore('metadata', { keyPath: 'id' });
        if (event.oldVersion < 2) {
          // Upgrade atomically; old content and preferences remain untouched.
          const cursorRequest = books.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            metadata.put(metadataOf(cursor.value));
            cursor.continue();
          };
        }
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('Database upgrade is blocked by another tab'));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        connection = db;
        db.onversionchange = () => {
          db.close();
          if (connection === db) connection = null;
        };
        db.onclose = () => {
          if (connection === db) connection = null;
        };
        resolve(db);
      };
    }).finally(() => { opening = null; });
    return opening;
  }

  async function transact(names, mode, execute) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      try {
        tx = db.transaction(names, mode);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(storageError(tx.error));
        tx.onabort = () => reject(storageError(tx.error));
        const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
        execute(stores, (value) => { result = value; });
      } catch (cause) {
        try { tx?.abort(); } catch { /* A completed transaction cannot be aborted. */ }
        reject(storageError(cause));
      }
    });
  }

  async function listBooks() {
    return transact(['metadata'], 'readonly', ({ metadata }, done) => {
      const request = metadata.getAll();
      request.onsuccess = () => {
        request.result.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
        done(request.result);
      };
    });
  }

  async function getBook(id) {
    return transact(['books', 'metadata'], 'readonly', ({ books, metadata }, done) => {
      const request = books.get(id);
      request.onsuccess = () => {
        if (!request.result) { done(null); return; }
        const content = request.result;
        const metadataRequest = metadata.get(id);
        metadataRequest.onsuccess = () => done({ ...content, ...metadataRequest.result });
      };
    });
  }

  async function saveBook(book) {
    if (!book || typeof book.id !== 'string' || !book.id.trim()) {
      throw storageError(new Error('A book needs a nonempty string id'));
    }
    const now = Date.now();
    return transact(['books', 'metadata'], 'readwrite', ({ books, metadata }) => {
      const saved = { ...book, createdAt: book.createdAt ?? now, updatedAt: book.updatedAt ?? now };
      books.put(saved);
      metadata.put(metadataOf(saved));
    });
  }

  async function savePosition(id, position) {
    return transact(['metadata'], 'readwrite', ({ metadata }) => {
      const request = metadata.get(id);
      request.onsuccess = () => {
        if (!request.result) return;
        metadata.put({ ...request.result, position, updatedAt: Date.now() });
      };
    });
  }

  async function deleteBook(id) {
    return transact(['books', 'metadata', 'settings'], 'readwrite', ({ books, metadata, settings }) => {
      books.delete(id);
      metadata.delete(id);
      const request = settings.get(SETTINGS_KEY);
      request.onsuccess = () => {
        if (request.result?.lastBookId === id) {
          settings.put({ ...DEFAULT_SETTINGS, ...request.result, lastBookId: null }, SETTINGS_KEY);
        }
      };
    });
  }

  async function getSettings() {
    return transact(['settings'], 'readonly', ({ settings }, done) => {
      const request = settings.get(SETTINGS_KEY);
      request.onsuccess = () => done({ ...DEFAULT_SETTINGS, ...request.result });
    });
  }

  async function saveSettings(partial) {
    return transact(['settings'], 'readwrite', ({ settings }, done) => {
      const request = settings.get(SETTINGS_KEY);
      request.onsuccess = () => {
        const merged = { ...DEFAULT_SETTINGS, ...request.result, ...partial };
        settings.put(merged, SETTINGS_KEY);
        done(merged);
      };
    });
  }

  async function close() {
    // Wait for an in-flight open as well, so isolated test databases can be deleted.
    try { if (opening) await opening; } catch { /* No connection to close. */ }
    connection?.close();
    connection = null;
  }

  return { listBooks, getBook, saveBook, savePosition, deleteBook, getSettings, saveSettings, close };
}

const library = createLibrary();
export const { listBooks, getBook, saveBook, savePosition, deleteBook, getSettings, saveSettings } = library;
export default library;
