const delay = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clone = (value) => structuredClone(value);
const metadata = ({ chapters, ...row }) => clone(row);
const sampleBook = (patch = {}) => ({ id: 'cloud-one', title: 'Первая книга', author: 'Автор', year: 1888, source_url: 'https://example.test/book', chapters: [{ title: 'Глава', paragraphs: ['Первый маленький абзац.', 'Затем другой короткий абзац.'] }], total_words: 7, published: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', ...patch });

function replaceProperty(object, name, descriptor) {
  const previous = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
  return () => { if (previous) Object.defineProperty(object, name, previous); else delete object[name]; };
}

function fakeClient(initial = {}) {
  let state = { configured: true, user: { id: 'admin-a', email: 'admin-a@example.test' }, isAdmin: true, ...initial };
  const listeners = new Set();
  const stores = { books: [sampleBook()], users: [{ id: 'reader-one', email: 'reader@example.test', display_name: 'Читатель', is_admin: false, created_at: '2026-01-01T00:00:00Z', last_sign_in_at: null, email_confirmed_at: '2026-01-01T00:00:00Z' }] };
  const handlers = {};
  const calls = [];
  const client = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(patch) { state = { ...state, ...patch }; listeners.forEach((listener) => listener(state)); },
    stores, handlers, calls,
  };
  const defaults = {
    adminListBooks: () => stores.books.map(metadata),
    adminGetBook: (id) => clone(stores.books.find((book) => book.id === id)),
    adminListUsers: () => clone(stores.users),
    adminSaveBook: (payload) => {
      const row = { ...clone(payload), created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' };
      stores.books = [...stores.books.filter((book) => book.id !== row.id), row];
      return clone(row);
    },
    adminSetPublished: (id, published) => {
      const row = stores.books.find((book) => book.id === id);
      if (!row) throw new Error('Книга не найдена.');
      row.published = published;
      row.updated_at = '2026-02-01T00:00:00Z';
      return clone(row);
    },
  };
  for (const [name, fallback] of Object.entries(defaults)) client[name] = async (...args) => {
    calls.push({ name, args: clone(args), userId: state.user?.id });
    return handlers[name] ? handlers[name](...args) : fallback(...args);
  };
  return client;
}

async function until(condition, message, timeout = 4000) {
  const deadline = performance.now() + timeout;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(message);
    await delay(10);
  }
}

async function harness(width = 390, height = 844, initial) {
  const frame = document.createElement('iframe');
  frame.title = 'Изолированная проверка панели администратора';
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;border:0`;
  const moduleURL = new URL('../js/admin-ui.mjs', import.meta.url).href;
  const importerURL = new URL('../js/importers.mjs', import.meta.url).href;
  const stylesURL = new URL('../styles.css', import.meta.url).href;
  const adminStylesURL = new URL('../admin.css', import.meta.url).href;
  const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  frame.srcdoc = `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${stylesURL}"><link rel="stylesheet" href="${adminStylesURL}"></head><body><button id="admin-test-opener">Открыть управление</button><main style="min-height:1400px">Изолированная проверка</main><script type="module">import {setupAdminUI} from ${JSON.stringify(moduleURL)};import {importBook,bookFromText} from ${JSON.stringify(importerURL)};window.adminTestModules={setupAdminUI,importBook,bookFromText};</script></body></html>`;
  document.body.append(frame);
  try {
    await loaded;
    await until(() => frame.contentWindow.adminTestModules, 'Admin test module did not load');
    const w = frame.contentWindow;
    const d = frame.contentDocument;
    const el = (name) => d.getElementById(`admin-${name}`);
    const client = fakeClient(initial);
    const notifications = [];
    const counters = { pause: 0, catalogue: 0 };
    const ui = w.adminTestModules.setupAdminUI({
      client,
      importBook: w.adminTestModules.importBook,
      bookFromText: w.adminTestModules.bookFromText,
      pauseMain: () => { counters.pause += 1; },
      notify: (message) => notifications.push(message),
      onCatalogueChange: async () => { counters.catalogue += 1; },
    });
    const tick = async () => { await delay(); await delay(); };
    const open = () => { el('test-opener').focus({ preventScroll: true }); ui.open(); };
    const submit = () => el('editor').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    const action = (kind, id) => d.querySelector(`[data-admin-${kind}="${id}"]`);
    const search = (value) => { el('search').value = value; el('search').dispatchEvent(new w.Event('input', { bubbles: true })); };
    const addText = (title = 'Новая книга', passage = 'Раз два три четыре.') => {
      el('new-book').click();
      el('title').value = title;
      el('paste').value = passage;
      el('use-text').click();
    };
    const chooseFile = async (contents, name) => {
      const transfer = new w.DataTransfer();
      transfer.items.add(new w.File([contents], name, { type: 'application/octet-stream' }));
      el('file').files = transfer.files;
      el('file').dispatchEvent(new w.Event('change', { bubbles: true }));
      await until(() => !el('editor-fields').disabled || !el('dialog').open, 'File import did not settle');
    };
    const noSensitive = () => {
      assert(!el('dialog').open, 'Revoked access left the admin dialog open');
      assert(!el('book-list').textContent && !el('user-list').textContent, 'Sensitive lists survived access revocation');
      for (const name of ['title', 'author', 'source-url', 'paste', 'file']) assert(!el(name).value, `${name} retained sensitive draft data`);
      assert(!el('content-preview').textContent && !el('error').textContent && !el('status').textContent, 'Draft preview or feedback survived access revocation');
    };
    return { frame, w, d, el, client, notifications, counters, ui, tick, open, submit, action, search, addText, chooseFile, noSensitive, dispose() { ui.close(); frame.remove(); } };
  } catch (error) { frame.remove(); throw error; }
}

/** Fake admin API and actual importers in a fresh iframe: no real accounts or catalogue writes. */
export async function runAdminTests({ record }) {
  const scenario = (name, run, size, initial) => record(name, async () => {
    const h = await harness(...(size || [390, 844]), initial);
    try { await run(h); }
    finally { h.dispose(); }
  });

  await scenario('Admin direct access is denied for unconfigured accounts, guests and ordinary readers', async ({ client, ui, el, open, tick, counters, notifications }) => {
    open();
    assert(!el('dialog').open && client.calls.length === 0, 'Unconfigured accounts accessed admin data');
    client.emit({ configured: true, user: null, isAdmin: false });
    ui.open();
    client.emit({ user: { id: 'reader' }, isAdmin: false });
    ui.open();
    assert(!el('dialog').open && client.calls.length === 0 && counters.pause === 0, 'Guest or reader direct access started admin work');
    assert(notifications.length === 3, 'Denied access was not explained');
    client.emit({ isAdmin: true });
    open();
    await tick();
    assert(el('dialog').open && counters.pause === 1 && client.calls[0].name === 'adminListBooks', 'Confirmed admin state did not open and pause the reader');
    assert(client.calls.every((call) => call.name !== 'adminGetBook'), 'The metadata list fetched complete books eagerly');
    el('done').click();
    assert(!el('dialog').open && el('test-opener') === el('dialog').ownerDocument.activeElement, 'Closing did not restore opener focus');
  }, undefined, { configured: false, user: null, isAdmin: false });

  await scenario('Admin book and user data remain plain text, searchable and read-only for roles', async ({ client, el, d, w, open, tick, search }) => {
    const markup = '<img src=x onerror="window.adminInjected=true">';
    client.stores.books = [sampleBook({ title: markup, author: '<b>Автор</b>' })];
    client.stores.users = [{ id: 'reader-one', email: '<svg onload=alert(1)>@example.test', display_name: markup, created_at: '2026-01-01T00:00:00Z', last_sign_in_at: null, email_confirmed_at: null, is_admin: false }];
    open(); await tick();
    assert(el('book-list').textContent.includes(markup) && !el('book-list').querySelector('img,b'), 'Book metadata was inserted as markup');
    search('нет такой книги');
    assert(el('book-count').textContent.startsWith('0 из 1'), 'Book search count is incorrect');
    search('автор');
    assert(el('book-count').textContent.startsWith('1 из 1'), 'Book search did not match the author');
    el('tab-users').click(); await tick();
    assert(el('user-list').textContent.includes(markup) && el('user-list').textContent.includes('<svg'), 'User data lost literal text');
    assert(!el('user-list').querySelector('img,svg,b,button,input,select') && !w.adminInjected, 'Untrusted user data executed or role controls appeared');
    assert(el('user-list').textContent.includes('Не подтверждена'), 'Email confirmation status is missing');
    search('EXAMPLE.TEST');
    assert(el('user-count').textContent.startsWith('1 из 1'), 'User search is not case-insensitive');
    search('nobody');
    assert(el('user-count').textContent.startsWith('0 из 1'), 'User search count is incorrect');
    assert(d.querySelectorAll('#admin-dialog').length === 1, 'Admin UI duplicated its dialog');
  });

  await scenario('Admin imports preserve a draft on corrupt files and save, publish and hide only confirmed rows', async ({ client, el, open, tick, addText, chooseFile, submit, action, search, counters }) => {
    client.stores.books = [];
    open(); await tick();
    addText('Новая книга');
    assert(!el('published').checked && el('content-summary').textContent.includes('4 слов'), 'New pasted books must start hidden with a derived word count');
    el('author').value = 'Имя автора';
    el('year').value = '1888';
    el('source-url').value = 'https://example.test/new';
    await chooseFile('Пять новых слов для каталога.', 'example.txt');
    assert(el('content-summary').textContent.includes('5 слов') && el('title').value === 'Новая книга', 'TXT import lost editable metadata or counted words incorrectly');
    const previousPreview = el('content-preview').textContent;
    await chooseFile('broken epub', 'broken.epub');
    assert(el('content-preview').textContent === previousPreview && el('title').value === 'Новая книга', 'A corrupt file replaced the draft');
    assert(el('error').textContent.includes('прежний текст сохранён'), 'Corrupt import did not explain draft preservation');
    const pending = deferred();
    client.handlers.adminSaveBook = () => pending.promise;
    submit(); submit();
    const saves = client.calls.filter((call) => call.name === 'adminSaveBook');
    assert(saves.length === 1 && el('save').disabled, 'Pending save allowed duplicate writes');
    const payload = saves[0].args[0];
    assert(/^cloud-[0-9a-f-]{36}$/.test(payload.id) && payload.total_words === 5 && !payload.published, 'New cloud payload has an invalid identity, count or publication default');
    assert(counters.catalogue === 0 && client.stores.books.length === 0, 'Save was applied optimistically');
    const saved = sampleBook(payload);
    client.stores.books = [saved];
    pending.resolve(clone(saved)); await tick();
    assert(!el('save').disabled && counters.catalogue === 1, 'Confirmed save did not release the form or refresh the catalogue');
    el('back').click(); await tick();
    assert(el('book-count').textContent.startsWith('1 из 1'), 'Saved book was not counted');
    action('publish', payload.id).click(); await tick();
    assert(client.stores.books[0].published && action('publish', payload.id).textContent === 'Скрыть', 'Publish did not reflect the confirmed server row');
    action('publish', payload.id).click(); await tick();
    assert(!client.stores.books[0].published && counters.catalogue === 3, 'Hide did not update the public catalogue');
    search('не найдено');
    assert(el('book-count').textContent.startsWith('0 из 1'), 'Search count did not update after writes');
  });

  await scenario('Failed admin writes retain the draft; server permission failures clear it and block reopening', async ({ client, el, open, tick, addText, submit, counters, noSensitive, ui }) => {
    open(); await tick(); addText('Сохранить этот черновик');
    el('author').value = 'Автор черновика';
    client.handlers.adminSaveBook = async () => { throw new Error('<b>Сеть недоступна</b>'); };
    submit(); await tick();
    assert(el('dialog').open && el('title').value === 'Сохранить этот черновик' && el('paste').value === 'Раз два три четыре.', 'A failed save erased draft fields');
    assert(el('error').textContent.includes('<b>Сеть недоступна</b>') && !el('error').querySelector('b'), 'Server errors were inserted as markup');
    assert(!el('save').disabled && counters.catalogue === 0, 'A failed save remained locked or refreshed the catalogue');
    client.handlers.adminSaveBook = async () => { throw Object.assign(new Error('RLS denied'), { status: 403, code: '42501' }); };
    submit(); await tick();
    noSensitive();
    const count = client.calls.length;
    ui.open();
    assert(!el('dialog').open && client.calls.length === count && counters.catalogue === 0, '403 allowed direct reopening or fabricated a successful write');
  });

  await scenario('Role loss clears lists and drafts and ignores late book, user and full-text responses', async ({ client, el, open, tick, noSensitive, action }) => {
    const pendingBooks = deferred();
    const pendingUsers = deferred();
    client.handlers.adminListBooks = () => pendingBooks.promise;
    client.handlers.adminListUsers = () => pendingUsers.promise;
    open();
    el('tab-users').click();
    client.emit({ isAdmin: false });
    noSensitive();
    pendingBooks.resolve([metadata(sampleBook({ title: 'Секретная старая книга' }))]);
    pendingUsers.resolve([{ id: 'secret', email: 'secret@example.test' }]);
    await tick(); noSensitive();
    delete client.handlers.adminListBooks;
    delete client.handlers.adminListUsers;
    client.emit({ isAdmin: true });
    open(); await tick();
    const pendingFullText = deferred();
    client.handlers.adminGetBook = () => pendingFullText.promise;
    action('edit', 'cloud-one').click();
    assert(client.calls.at(-1).name === 'adminGetBook' && el('editor').hidden, 'Edit did not lazily request the selected full text');
    client.emit({ user: null, isAdmin: false });
    noSensitive();
    pendingFullText.resolve(sampleBook({ title: 'Секретный полный текст' }));
    await tick(); noSensitive();
  });

  await scenario('An old account mutation cannot repaint or unlock a new administrator session', async ({ client, el, open, tick, action, submit, counters }) => {
    client.stores.books = [sampleBook({ id: 'cloud-a', title: 'Книга A' })];
    const pendingA = deferred();
    const pendingB = deferred();
    client.handlers.adminSaveBook = (row) => row.id === 'cloud-a' ? pendingA.promise : pendingB.promise;
    open(); await tick(); action('edit', 'cloud-a').click(); await tick();
    el('title').value = 'Старые изменения A'; submit();
    client.emit({ user: { id: 'admin-b', email: 'b@example.test' }, isAdmin: true });
    assert(!el('dialog').open && !el('title').value, 'Changing admin identity retained the old editor');
    client.stores.books = [sampleBook({ id: 'cloud-b', title: 'Книга B' })];
    open(); await tick(); action('edit', 'cloud-b').click(); await tick();
    el('title').value = 'Текущие изменения B'; submit();
    pendingA.resolve(sampleBook({ id: 'cloud-a', title: 'Старые изменения A' })); await tick();
    assert(el('dialog').open && el('title').value === 'Текущие изменения B' && el('save').disabled, 'Old completion repainted or unlocked the new pending form');
    assert(!el('book-list').textContent.includes('Старые изменения A') && counters.catalogue === 0, 'Old completion leaked rows or refreshed the new session');
    const rowB = sampleBook({ id: 'cloud-b', title: 'Текущие изменения B' });
    client.stores.books = [rowB];
    pendingB.resolve(rowB); await tick();
    assert(!el('save').disabled && counters.catalogue === 1, 'Current account completion was lost');
  });

  await scenario('Admin follows the visible keyboard viewport and restores its scroll lock without disturbing reader fullscreen', async ({ el, d, w, open, tick, action, ui, client, noSensitive }) => {
    const visual = w.visualViewport;
    assert(visual, 'Visual viewport is unavailable for the admin keyboard test');
    const dimensions = { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 };
    const restorers = Object.keys(dimensions).map((key) => replaceProperty(visual, key, { get: () => dimensions[key] }));
    const savedRoot = d.documentElement.getAttribute('style');
    const savedBody = d.body.getAttribute('style');
    let mockReader = null;
    try {
      d.documentElement.style.setProperty('overflow', 'auto', 'important');
      d.documentElement.style.setProperty('overscroll-behavior', 'contain', 'important');
      d.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
      d.body.style.setProperty('position', 'relative');
      d.body.style.setProperty('top', '1px');
      d.body.style.setProperty('left', '0px');
      d.body.style.setProperty('width', '100%');
      d.body.style.setProperty('overflow', 'visible');
      w.scrollTo(0, 55);
      await tick();
      assert(Math.abs(w.scrollY - 55) <= 1, 'Could not set the original background scroll position');
      const properties = [[d.documentElement, 'overflow'], [d.documentElement, 'overscroll-behavior'], [d.documentElement, 'scroll-behavior'], [d.body, 'position'], [d.body, 'top'], [d.body, 'left'], [d.body, 'width'], [d.body, 'overflow'], [d.body, 'overscroll-behavior']];
      const snapshot = properties.map(([node, property]) => [node, property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]);
      const restored = () => {
        for (const [node, property, value, priority] of snapshot) assert(node.style.getPropertyValue(property) === value && node.style.getPropertyPriority(property) === priority, `Admin failed to restore ${property} and its priority`);
        assert(Math.abs(w.scrollY - 55) <= 1, 'Admin did not restore the original page scroll');
      };
      const restoreSnapshot = () => {
        for (const [node, property, value, priority] of snapshot) { if (value) node.style.setProperty(property, value, priority); else node.style.removeProperty(property); }
        w.scrollTo(0, 55);
      };
      open(); await tick();
      action('edit', 'cloud-one').click(); await tick();
      el('title').value = 'Черновик при открытой клавиатуре';
      assert(w.getComputedStyle(d.body).position === 'fixed', 'Mobile admin did not lock background scrolling');
      const geometry = async () => {
        await until(() => {
          const r = el('dialog').getBoundingClientRect();
          return Math.abs(r.width - dimensions.width) <= 1 && Math.abs(r.height - dimensions.height) <= 1 && Math.abs(r.top - dimensions.offsetTop) <= 1;
        }, 'Admin did not follow visualViewport dimensions');
        const r = el('dialog').getBoundingClientRect();
        assert(el('dialog').classList.contains('admin-fullscreen') && Math.abs(r.left - dimensions.offsetLeft) <= 1, 'Admin is not positioned in the visible viewport');
        const footer = el('dialog').querySelector('.admin-footer').getBoundingClientRect();
        assert(Math.abs(footer.bottom - dimensions.offsetTop - dimensions.height) <= 1, 'Keyboard covered the bottom admin actions');
        const buttons = ['back', 'save'].map((name) => {
          const target = el(name);
          const bounds = target.getBoundingClientRect();
          assert(bounds.width >= 43.5 && bounds.height >= 43.5, `${name} shrank below 44px with the keyboard open`);
          assert(bounds.top >= dimensions.offsetTop - 1 && bounds.bottom <= dimensions.offsetTop + dimensions.height + 1, `${name} exceeds the keyboard viewport`);
          const top = d.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          assert(top === target || target.contains(top), `${name} is covered with the keyboard open`);
          return bounds;
        });
        assert(buttons[0].right <= buttons[1].left + .5 || buttons[1].right <= buttons[0].left + .5, 'Admin keyboard actions overlap');
        assert(el('title').value === 'Черновик при открытой клавиатуре', 'Viewport changes lost the editor draft');
      };
      await geometry();
      dimensions.height = 430;
      dimensions.offsetTop = 30;
      visual.dispatchEvent(new w.Event('resize'));
      await geometry();
      dimensions.offsetTop = 55;
      visual.dispatchEvent(new w.Event('scroll'));
      await geometry();
      await delay(30);

      let serial = 0;
      let cancelled = 0;
      const frames = new Map();
      restorers.push(replaceProperty(w, 'requestAnimationFrame', { value: (callback) => { const id = ++serial; frames.set(id, callback); return id; } }));
      restorers.push(replaceProperty(w, 'cancelAnimationFrame', { value: (id) => { if (frames.delete(id)) cancelled += 1; } }));
      d.dispatchEvent(new w.Event('fullscreenchange'));
      d.dispatchEvent(new w.Event('fullscreenchange'));
      assert(frames.size === 1, 'Fullscreen changes did not coalesce into one animation frame');
      ui.close();
      assert(frames.size === 0 && cancelled === 1, 'Closing did not cancel the queued viewport frame');
      restored();

      // A reader lock already in force belongs to the reader, not to this dialog.
      mockReader = d.createElement('div');
      mockReader.id = 'reader';
      mockReader.className = 'focus-mode';
      d.body.append(mockReader);
      d.documentElement.style.overflow = 'hidden';
      d.body.style.position = 'fixed';
      d.body.style.top = '-55px';
      open(); await tick();
      ui.close();
      assert(d.body.style.position === 'fixed' && d.body.style.top === '-55px' && d.documentElement.style.overflow === 'hidden', 'Admin closing removed the reader scroll lock');
      mockReader.remove(); mockReader = null;
      restoreSnapshot();
      open(); await tick();
      client.emit({ isAdmin: false });
      noSensitive();
      restored();
    } finally {
      ui.close();
      mockReader?.remove();
      restorers.reverse().forEach((restore) => restore());
      if (savedRoot === null) d.documentElement.removeAttribute('style'); else d.documentElement.setAttribute('style', savedRoot);
      if (savedBody === null) d.body.removeAttribute('style'); else d.body.setAttribute('style', savedBody);
    }
  });

  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [568, 320]]) {
    await scenario(`Admin list and editor fit ${width}×${height} with accessible pinned actions`, async ({ el, d, w, open, tick, action }) => {
      open(); await tick();
      assert(w.innerWidth === width && w.innerHeight === height, 'Admin test viewport has the wrong size');
      const dialog = el('dialog');
      const footer = dialog.querySelector('.admin-footer');
      const body = dialog.querySelector('.admin-body');
      const boundsCheck = () => {
        const bounds = dialog.getBoundingClientRect();
        const bottom = footer.getBoundingClientRect();
        assert(bounds.left >= -1 && bounds.right <= width + 1 && bounds.top >= -1 && bounds.bottom <= height + 1, 'Admin dialog exceeds the viewport');
        assert(dialog.scrollWidth <= dialog.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1, 'Admin content has horizontal overflow');
        assert(Math.abs(bottom.bottom - bounds.bottom) <= 1.5, 'Admin footer is not pinned to the dialog bottom');
      };
      const hit = (target, scroll = false) => {
        if (scroll) target.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = target.getBoundingClientRect();
        assert(r.width >= 43.5 && r.height >= 43.5, `${target.id || target.textContent}: touch target is below 44px`);
        assert(r.left >= -1 && r.right <= width + 1 && r.top >= -1 && r.bottom <= height + 1, `${target.id}: target exceeds the viewport`);
        const top = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        assert(top === target || target.contains(top), `${target.id || target.textContent}: target is covered at its center`);
        return r;
      };
      const separate = (first, second) => {
        const x = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const y = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
        assert(x <= .5 || y <= .5, 'Pinned admin actions overlap');
      };
      boundsCheck();
      hit(el('close')); hit(el('done')); hit(el('tab-books')); hit(el('tab-users')); hit(el('search')); hit(el('new-book'));
      const edit = action('edit', 'cloud-one');
      hit(edit, true); hit(action('publish', 'cloud-one'), true);
      edit.click(); await tick();
      assert(!el('editor').hidden, 'Lazy edit did not open for geometry checks');
      boundsCheck();
      const initialFooter = footer.getBoundingClientRect().top;
      for (const name of ['title', 'author', 'year', 'source-url']) hit(el(name), true);
      hit(el('published').closest('label'), true);
      const details = el('content-details');
      details.open = true;
      for (const name of ['file', 'encoding', 'paste', 'use-text']) hit(el(name), true);
      boundsCheck();
      assert(Math.abs(initialFooter - footer.getBoundingClientRect().top) <= 1, 'Scrolling the editor moved the pinned footer');
      separate(hit(el('back')), hit(el('save')));
      hit(el('close'));
      el('back').click(); await tick();
      boundsCheck(); hit(el('done'));
    }, [width, height]);
  }
}
