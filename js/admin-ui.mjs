import { tokenizeChapters } from './reader.mjs?v=20261023-mobile';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const formatNumber = (value) => Number(value || 0).toLocaleString('ru-RU');
const copyChapters = (chapters) => chapters.map((chapter) => ({ title: chapter.title, paragraphs: [...chapter.paragraphs] }));

/** Validate a catalogue write independently of server-provided word counts. */
export function prepareAdminBook(input) {
  const title = text(input?.title);
  const author = text(input?.author);
  if (!title) throw new Error('Укажите название книги.');
  if (title.length > 240) throw new Error('Название должно быть не длиннее 240 символов.');
  if (author.length > 160) throw new Error('Имя автора должно быть не длиннее 160 символов.');
  const id = text(input?.id);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error('Неверный идентификатор книги.');
  let year = null;
  if (input.year !== null && input.year !== undefined && input.year !== '') {
    year = typeof input.year === 'string' ? Number(input.year.trim()) : input.year;
    if (!Number.isInteger(year) || year < -3000 || year > 3000) throw new Error('Год должен быть целым числом от −3000 до 3000. Можно оставить поле пустым.');
  }
  const sourceURL = text(input.source_url);
  if (sourceURL.length > 2048) throw new Error('Ссылка на источник должна быть не длиннее 2048 символов.');
  if (sourceURL) {
    let url;
    try { url = new URL(sourceURL); } catch { throw new Error('Укажите полный адрес источника, начинающийся с https://.'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Источник должен быть адресом https:// без логина и пароля в ссылке.');
  }
  if (!Array.isArray(input.chapters)) throw new Error('Добавьте файл книги или вставьте её текст.');
  if (input.chapters.length > 2000) throw new Error('В книге слишком много глав. Допустимо не больше 2000.');
  let paragraphCount = 0;
  const chapters = input.chapters.map((chapter, index) => {
    if (!chapter || !Array.isArray(chapter.paragraphs) || chapter.paragraphs.some((paragraph) => typeof paragraph !== 'string')) throw new Error('Не удалось прочитать структуру глав. Загрузите текст снова.');
    paragraphCount += chapter.paragraphs.length;
    if (paragraphCount > 100000) throw new Error('В книге слишком много абзацев. Допустимо не больше 100 000.');
    if (text(chapter.title).length > 300) throw new Error('Название главы должно быть не длиннее 300 символов.');
    if (chapter.paragraphs.some((paragraph) => paragraph.length > 200000)) throw new Error('Один из абзацев длиннее 200 000 символов. Разделите его на несколько абзацев.');
    return { title: text(chapter.title) || `Глава ${index + 1}`, paragraphs: chapter.paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean) };
  }).filter((chapter) => chapter.paragraphs.length);
  if (new TextEncoder().encode(JSON.stringify(chapters)).byteLength > 20 * 1024 * 1024) throw new Error('Текст книги превышает лимит каталога — 20 МБ.');
  const totalWords = tokenizeChapters(chapters).totalWords;
  if (!totalWords) throw new Error('В книге нет слов для чтения. Добавьте другой файл или текст.');
  if (totalWords > 2000000) throw new Error('Книга содержит больше двух миллионов слов. Разделите её на несколько частей.');
  return { id, title, author, year, source_url: sourceURL, chapters, total_words: totalWords, published: input.published === true };
}

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function denied(error) {
  return [401, 403].includes(Number(error?.status)) || ['42501', 'PGRST301'].includes(error?.code);
}

/** Admin-only UI. Server authorization remains authoritative for every request. */
export function setupAdminUI({ client, importBook, bookFromText, notify = () => {}, onCatalogueChange = () => {}, pauseMain = () => {} } = {}) {
  if (!client || typeof client.getState !== 'function') throw new Error('Не подключён клиент аккаунтов.');
  const dialog = document.createElement('dialog');
  dialog.id = 'admin-dialog';
  dialog.className = 'admin-dialog';
  dialog.setAttribute('aria-labelledby', 'admin-heading');
  dialog.innerHTML = `
    <header class="admin-header"><div><p class="admin-kicker">УПРАВЛЕНИЕ</p><h2 id="admin-heading">Каталог и пользователи</h2></div><button id="admin-close" class="admin-icon" type="button" aria-label="Закрыть панель администратора">×</button></header>
    <div class="admin-tabs" role="tablist" aria-label="Разделы управления"><button id="admin-tab-books" type="button" role="tab" aria-controls="admin-books" aria-selected="true">Книги</button><button id="admin-tab-users" type="button" role="tab" aria-controls="admin-users" aria-selected="false" tabindex="-1">Пользователи</button></div>
    <div class="admin-toolbar"><label class="sr-only" for="admin-search">Поиск в текущем разделе</label><input id="admin-search" type="search" placeholder="Название или автор" autocomplete="off"><button id="admin-new-book" class="admin-primary" type="button">Добавить книгу</button></div>
    <div class="admin-feedback"><p id="admin-status" role="status" aria-live="polite"></p><p id="admin-error" role="alert" tabindex="-1"></p></div>
    <div class="admin-body">
      <section id="admin-books" role="tabpanel" aria-labelledby="admin-tab-books"><p class="admin-count" id="admin-book-count"></p><div class="admin-list" id="admin-book-list"></div></section>
      <section id="admin-users" role="tabpanel" aria-labelledby="admin-tab-users" hidden><p class="admin-count" id="admin-user-count"></p><div class="admin-list" id="admin-user-list"></div><p class="admin-note">Роли назначаются в настройках сервера. Здесь можно просматривать пользователей.</p></section>
      <form id="admin-editor" novalidate hidden>
        <div class="admin-editor-heading"><h3 id="admin-editor-title">Добавление книги</h3><p class="admin-note">Изменения попадут в каталог после сохранения.</p></div>
        <fieldset id="admin-editor-fields">
          <div class="admin-metadata">
            <label class="admin-field admin-field-wide">Название<input id="admin-title" type="text" required maxlength="240" autocomplete="off"></label>
            <label class="admin-field admin-field-wide">Автор <span>необязательно</span><input id="admin-author" type="text" maxlength="160" autocomplete="off"></label>
            <label class="admin-field">Год <span>необязательно</span><input id="admin-year" type="number" min="-3000" max="3000" step="1" inputmode="numeric"></label>
            <label class="admin-field admin-field-source">Источник <span>необязательно</span><input id="admin-source-url" type="url" maxlength="2048" placeholder="https://…" autocomplete="off"></label>
          </div>
          <label class="admin-publish-choice"><input id="admin-published" type="checkbox"><span>Показывать книгу в общем каталоге<small>Публикация изменится после сохранения.</small></span></label>
          <section class="admin-content"><div class="admin-content-heading"><h4>Текст книги</h4><p id="admin-content-summary" class="admin-note">Текст ещё не добавлен.</p></div><p id="admin-content-preview" class="admin-preview" hidden></p>
            <details id="admin-content-details" open><summary>Загрузить или заменить текст</summary><div class="admin-content-inputs">
              <label class="admin-file-label" for="admin-file">Выбрать EPUB, FB2 или TXT<input id="admin-file" type="file" accept=".epub,.fb2,.txt"></label>
              <label class="admin-encoding" for="admin-encoding">Кодировка TXT<select id="admin-encoding"><option value="utf-8">UTF-8</option><option value="windows-1251">Windows-1251</option></select></label>
              <label class="admin-field" for="admin-paste">Или вставьте текст<textarea id="admin-paste" rows="6" placeholder="Текст книги…"></textarea></label><button id="admin-use-text" class="admin-secondary" type="button">Использовать этот текст</button>
              <p class="admin-note">Файл обрабатывается на устройстве. Сервер получит текст только после сохранения книги.</p>
            </div></details>
          </section>
        </fieldset>
      </form>
    </div>
    <footer class="admin-footer"><button id="admin-done" class="admin-secondary" type="button">Готово</button><button id="admin-back" class="admin-secondary" type="button" hidden>К списку</button><button id="admin-save" class="admin-primary" type="submit" form="admin-editor" hidden>Сохранить книгу</button></footer>`;
  document.body.append(dialog);
  const find = (name) => dialog.querySelector(`#admin-${name}`);
  const media = matchMedia('(max-width: 600px), (max-width: 1000px) and (max-height: 600px)');
  let state = client.getState() || {};
  let identity = state.user?.id || '';
  let previousAdmin = state.isAdmin === true;
  let deniedIdentity = '';
  let generation = 0;
  let tab = 'books';
  let view = 'books';
  let opener = null;
  let books = [];
  let users = [];
  let draft = null;
  let booksLoaded = false;
  let usersLoaded = false;
  let writeBusy = false;
  let contentBusy = false;
  let background = null;
  let layoutFrame = null;
  const loading = { books: false, users: false };
  const sequences = { books: 0, users: 0 };
  const searches = { books: '', users: '' };

  function allowed() {
    const latest = client.getState() || {};
    return Boolean(latest.configured && latest.user?.id && latest.isAdmin === true && latest.user.id !== deniedIdentity);
  }

  function ticket() { return { generation, identity: client.getState()?.user?.id }; }
  function current(request) { return request.generation === generation && request.identity === client.getState()?.user?.id && allowed(); }
  function status(message = '') { find('status').textContent = message; }
  function errorMessage(message = '', focus = false) { find('error').textContent = message; if (focus && dialog.open) find('error').focus({ preventScroll: true }); }

  function restoreFocus() {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  function lockBackground() {
    // The immersive reader owns its existing lock until fullscreen cleanup.
    if (background || document.querySelector('#reader.focus-mode')) return;
    const changes = [[document.documentElement, 'overflow', 'hidden'], [document.documentElement, 'overscroll-behavior', 'none'], [document.body, 'position', 'fixed'], [document.body, 'top', `${-window.scrollY}px`], [document.body, 'left', `${-window.scrollX}px`], [document.body, 'width', '100%'], [document.body, 'overflow', 'hidden'], [document.body, 'overscroll-behavior', 'none']];
    background = { x: window.scrollX, y: window.scrollY, styles: changes.map(([node, property]) => [node, property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]) };
    changes.forEach(([node, property, value]) => node.style.setProperty(property, value));
  }

  function unlockBackground() {
    if (!background) return;
    const previous = background;
    background = null;
    previous.styles.forEach(([node, property, value, priority]) => { if (value) node.style.setProperty(property, value, priority); else node.style.removeProperty(property); });
    const root = document.documentElement;
    const behavior = root.style.getPropertyValue('scroll-behavior');
    const priority = root.style.getPropertyPriority('scroll-behavior');
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    window.scrollTo(previous.x, previous.y);
    if (behavior) root.style.setProperty('scroll-behavior', behavior, priority);
    else root.style.removeProperty('scroll-behavior');
  }

  function updateLayout() {
    layoutFrame = null;
    if (!dialog.open) return;
    const visual = window.visualViewport;
    const width = visual?.width || window.innerWidth;
    const height = visual?.height || window.innerHeight;
    const mobile = media.matches || width <= 600 || (width <= 1000 && height <= 600);
    dialog.classList.toggle('admin-fullscreen', mobile);
    dialog.classList.toggle('admin-narrow', width < 280);
    dialog.classList.toggle('admin-compact', height <= 450);
    if (mobile) {
      for (const [key, value] of Object.entries({ width, height, left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0 })) dialog.style.setProperty(`--admin-${key}`, `${value}px`);
      lockBackground();
    } else unlockBackground();
  }

  function requestLayout() {
    if (dialog.open && layoutFrame === null) layoutFrame = requestAnimationFrame(updateLayout);
  }

  function cleanupLayout() {
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
    dialog.classList.remove('admin-fullscreen', 'admin-narrow', 'admin-compact');
    for (const name of ['width', 'height', 'left', 'top']) dialog.style.removeProperty(`--admin-${name}`);
    unlockBackground();
  }

  function close() {
    if (dialog.open) dialog.close();
    cleanupLayout();
    restoreFocus();
  }

  function clearSensitive() {
    generation += 1;
    sequences.books += 1;
    sequences.users += 1;
    loading.books = loading.users = false;
    books = [];
    users = [];
    draft = null;
    booksLoaded = usersLoaded = writeBusy = contentBusy = false;
    searches.books = searches.users = '';
    find('book-list').replaceChildren();
    find('user-list').replaceChildren();
    find('book-count').textContent = '';
    find('user-count').textContent = '';
    find('editor').reset();
    find('paste').value = '';
    find('file').value = '';
    find('content-preview').textContent = '';
    find('content-preview').hidden = true;
    find('content-summary').textContent = 'Текст ещё не добавлен.';
    status();
    errorMessage();
    tab = 'books';
    showView('books');
    close();
  }

  function handleError(error, request, fallback) {
    if (request.generation !== generation || request.identity !== client.getState()?.user?.id) return;
    if (denied(error)) {
      deniedIdentity = request.identity;
      clearSensitive();
      notify('Доступ администратора недоступен. Войдите заново или проверьте права аккаунта.');
    } else if (allowed()) {
      errorMessage(`${fallback} ${text(error?.message)}`.trim(), true);
      status();
    }
  }

  function syncBusy() {
    const locked = writeBusy || contentBusy || !allowed();
    find('editor-fields').disabled = locked;
    find('save').disabled = locked || !draft;
    find('new-book').disabled = locked;
    find('back').disabled = writeBusy || contentBusy;
    find('tab-books').disabled = writeBusy || contentBusy;
    find('tab-users').disabled = writeBusy || contentBusy;
    dialog.querySelectorAll('[data-admin-edit],[data-admin-publish]').forEach((button) => { button.disabled = locked; });
    find('editor').setAttribute('aria-busy', String(writeBusy || contentBusy));
    find('books').setAttribute('aria-busy', String(loading.books));
    find('users').setAttribute('aria-busy', String(loading.users));
    find('save').textContent = writeBusy ? 'Сохранение…' : 'Сохранить книгу';
  }

  function showView(next) {
    view = next;
    if (next !== 'editor') tab = next;
    find('books').hidden = next !== 'books';
    find('users').hidden = next !== 'users';
    find('editor').hidden = next !== 'editor';
    dialog.querySelector('.admin-toolbar').hidden = next === 'editor';
    find('new-book').hidden = tab !== 'books';
    find('done').hidden = next === 'editor';
    find('back').hidden = next !== 'editor';
    find('save').hidden = next !== 'editor';
    find('search').value = searches[tab];
    find('search').placeholder = tab === 'books' ? 'Название или автор' : 'Имя или почта';
    for (const name of ['books', 'users']) {
      find(`tab-${name}`).setAttribute('aria-selected', String(tab === name));
      find(`tab-${name}`).tabIndex = tab === name ? 0 : -1;
    }
    dialog.dataset.view = next;
    dialog.querySelector('.admin-body').scrollTop = 0;
    syncBusy();
  }

  function emptyMessage(message) {
    const element = document.createElement('p');
    element.className = 'admin-empty';
    element.textContent = message;
    return element;
  }

  function renderBooks() {
    const query = searches.books.toLocaleLowerCase('ru-RU');
    const filtered = books.filter((book) => `${book.title || ''} ${book.author || ''}`.toLocaleLowerCase('ru-RU').includes(query));
    find('book-count').textContent = booksLoaded ? `${formatNumber(filtered.length)} из ${formatNumber(books.length)} книг` : '';
    find('book-list').replaceChildren(...filtered.map((book) => {
      const card = document.createElement('article');
      card.className = 'admin-book-card';
      const information = document.createElement('div');
      information.className = 'admin-book-information';
      const heading = document.createElement('h3');
      heading.textContent = text(book.title) || 'Без названия';
      const author = document.createElement('p');
      author.textContent = [text(book.author) || 'Автор не указан', book.year].filter(Boolean).join(' · ');
      const details = document.createElement('p');
      details.className = 'admin-note';
      details.textContent = `${formatNumber(book.total_words)} слов · Изменено ${dateLabel(book.updated_at)}`;
      const badge = document.createElement('span');
      badge.className = `admin-badge${book.published ? ' is-published' : ''}`;
      badge.textContent = book.published ? 'Опубликована' : 'Скрыта';
      information.append(heading, author, details, badge);
      const actions = document.createElement('div');
      actions.className = 'admin-card-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'admin-secondary';
      edit.dataset.adminEdit = book.id;
      edit.textContent = 'Изменить';
      edit.setAttribute('aria-label', `Изменить книгу «${book.title}»`);
      edit.addEventListener('click', () => editBook(book));
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.className = 'admin-secondary';
      publish.dataset.adminPublish = book.id;
      publish.textContent = book.published ? 'Скрыть' : 'Опубликовать';
      publish.setAttribute('aria-label', `${book.published ? 'Скрыть' : 'Опубликовать'} книгу «${book.title}»`);
      publish.addEventListener('click', () => setPublished(book.id, !book.published));
      actions.append(edit, publish);
      card.append(information, actions);
      return card;
    }));
    if (!filtered.length && booksLoaded) find('book-list').append(emptyMessage(query ? 'По этому запросу книг не найдено.' : 'В облачном каталоге пока нет книг. Добавьте первую.'));
    syncBusy();
  }

  function renderUsers() {
    const query = searches.users.toLocaleLowerCase('ru-RU');
    const filtered = users.filter((user) => `${user.display_name || ''} ${user.email || ''} ${user.id || ''}`.toLocaleLowerCase('ru-RU').includes(query));
    find('user-count').textContent = usersLoaded ? `${formatNumber(filtered.length)} из ${formatNumber(users.length)} пользователей` : '';
    find('user-list').replaceChildren(...filtered.map((user) => {
      const card = document.createElement('article');
      card.className = 'admin-user-card';
      const heading = document.createElement('h3');
      heading.textContent = text(user.display_name) || 'Без имени';
      const email = document.createElement('p');
      email.className = 'admin-user-email';
      email.textContent = text(user.email) || 'Почта не указана';
      const info = document.createElement('dl');
      for (const [label, value] of [['Регистрация', dateLabel(user.created_at)], ['Последний вход', dateLabel(user.last_sign_in_at)], ['Почта', user.email_confirmed_at ? 'Подтверждена' : 'Не подтверждена']]) {
        const term = document.createElement('dt');
        const detail = document.createElement('dd');
        term.textContent = label;
        detail.textContent = value;
        info.append(term, detail);
      }
      const role = document.createElement('span');
      role.className = 'admin-badge';
      role.textContent = user.is_admin ? 'Администратор' : 'Читатель';
      card.append(heading, email, info, role);
      return card;
    }));
    if (!filtered.length && usersLoaded) find('user-list').append(emptyMessage(query ? 'Пользователей по этому запросу не найдено.' : 'Пользователи пока не найдены.'));
  }

  async function load(name) {
    if (!allowed()) return;
    const request = ticket();
    const sequence = ++sequences[name];
    loading[name] = true;
    errorMessage();
    status(name === 'books' ? 'Загружаем книги…' : 'Загружаем пользователей…');
    syncBusy();
    try {
      const rows = await (name === 'books' ? client.adminListBooks() : client.adminListUsers());
      if (!current(request) || sequence !== sequences[name]) return;
      if (!Array.isArray(rows)) throw new Error('Сервер вернул неверный формат списка.');
      if (name === 'books') { books = rows; booksLoaded = true; renderBooks(); }
      else { users = rows; usersLoaded = true; renderUsers(); }
      if (view === name && !writeBusy && !contentBusy) status();
    } catch (error) { if (sequence === sequences[name]) handleError(error, request, 'Не удалось загрузить данные.'); }
    finally { if (current(request) && sequence === sequences[name]) { loading[name] = false; syncBusy(); } }
  }

  function renderContent() {
    const chapters = draft?.chapters || [];
    const words = draft?.total_words || 0;
    find('content-summary').textContent = words ? `${formatNumber(words)} слов · Глав: ${formatNumber(chapters.length)}` : 'Текст ещё не добавлен.';
    const preview = chapters.flatMap((chapter) => chapter.paragraphs.slice(0, 1)).slice(0, 2).join('\n\n');
    find('content-preview').textContent = preview.length > 600 ? `${preview.slice(0, 600)}…` : preview;
    find('content-preview').hidden = !preview;
  }

  async function editBook(book = null) {
    if (!allowed() || writeBusy || contentBusy) return;
    const request = ticket();
    if (book) {
      contentBusy = true;
      errorMessage();
      status('Загружаем текст книги…');
      syncBusy();
    }
    try {
      const fullBook = book ? await client.adminGetBook(book.id) : null;
      if (!current(request)) return;
      if (book && (!fullBook || fullBook.id !== book.id)) throw new Error('Сервер не вернул текст выбранной книги.');
      const parsed = fullBook ? prepareAdminBook(fullBook) : null;
      draft = parsed ? { ...parsed, chapters: copyChapters(parsed.chapters) } : { id: `cloud-${crypto.randomUUID()}`, title: '', author: '', year: null, source_url: '', chapters: [], total_words: 0, published: false };
      find('editor').reset();
      find('editor-title').textContent = book ? 'Редактирование книги' : 'Добавление книги';
      find('title').value = draft.title;
      find('author').value = draft.author;
      find('year').value = draft.year ?? '';
      find('source-url').value = draft.source_url;
      find('published').checked = draft.published;
      find('content-details').open = !draft.total_words;
      renderContent();
      errorMessage();
      status();
      contentBusy = false;
      showView('editor');
      find('title').focus({ preventScroll: true });
    } catch (error) { handleError(error, request, 'Не удалось открыть книгу.'); }
    finally { if (current(request)) { contentBusy = false; syncBusy(); } }
  }

  function acceptContent(book) {
    if (!draft) return;
    const checked = prepareAdminBook({ ...draft, title: text(book.title) || 'Текст', author: text(book.author), chapters: book.chapters });
    draft = { ...draft, chapters: checked.chapters, total_words: checked.total_words };
    if (!find('title').value.trim()) find('title').value = text(book.title);
    if (!find('author').value.trim()) find('author').value = text(book.author);
    renderContent();
    errorMessage();
    status('Текст подготовлен. Проверьте данные и сохраните книгу.');
  }

  async function loadFile(file) {
    if (!file || !draft || !allowed() || writeBusy || contentBusy) return;
    const request = ticket();
    const draftId = draft.id;
    contentBusy = true;
    errorMessage();
    status('Читаем файл на устройстве…');
    syncBusy();
    try {
      const book = await importBook(file, { encoding: find('encoding').value });
      if (current(request) && draft?.id === draftId) acceptContent(book);
    } catch (error) { handleError(error, request, 'Файл не загружен; прежний текст сохранён.'); }
    finally { if (current(request)) { contentBusy = false; find('file').value = ''; syncBusy(); } }
  }

  function useText() {
    if (!draft || !allowed() || writeBusy || contentBusy) return;
    try {
      acceptContent(bookFromText(find('paste').value, find('title').value.trim() || 'Мой текст'));
    } catch (error) { errorMessage(`Текст не заменён. ${text(error?.message)}`, true); }
  }

  function returnedRow(row, expectedId) {
    if (!row || typeof row !== 'object' || row.id !== expectedId || typeof row.published !== 'boolean') throw new Error('Сервер не подтвердил изменения. Обновите список перед повторной попыткой.');
    return row;
  }

  async function catalogueChanged(request) {
    if (!current(request)) return;
    try { await onCatalogueChange(); }
    catch { if (current(request)) notify('Книга сохранена. Не удалось обновить каталог на странице; перезагрузите её.'); }
  }

  function replaceRow(row) {
    const { chapters, ...metadata } = row;
    const index = books.findIndex((book) => book.id === row.id);
    if (index < 0) books = [metadata, ...books];
    else books = books.map((book, position) => position === index ? metadata : book);
    renderBooks();
  }

  async function save(event) {
    event.preventDefault();
    if (!draft || !allowed() || writeBusy || contentBusy || view !== 'editor') return;
    if (!find('editor').reportValidity()) return;
    let payload;
    try { payload = prepareAdminBook({ ...draft, title: find('title').value, author: find('author').value, year: find('year').value, source_url: find('source-url').value, published: find('published').checked }); }
    catch (error) { errorMessage(text(error?.message), true); return; }
    const request = ticket();
    writeBusy = true;
    sequences.books += 1;
    loading.books = false;
    errorMessage();
    status('Сохраняем книгу…');
    syncBusy();
    try {
      const row = returnedRow(await client.adminSaveBook(payload), payload.id);
      if (!current(request)) return;
      draft = { ...payload, ...row };
      replaceRow(row);
      await catalogueChanged(request);
      if (!current(request)) return;
      await load('books');
      if (current(request)) {
        status(row.published ? 'Книга сохранена и опубликована.' : 'Книга сохранена. В общем каталоге она скрыта.');
        notify('Книга сохранена.');
      }
    } catch (error) { handleError(error, request, 'Не удалось сохранить книгу. Черновик остаётся в форме.'); }
    finally { if (current(request)) { writeBusy = false; syncBusy(); } }
  }

  async function setPublished(id, published) {
    if (!allowed() || writeBusy || contentBusy) return;
    const request = ticket();
    writeBusy = true;
    sequences.books += 1;
    loading.books = false;
    errorMessage();
    status(published ? 'Публикуем книгу…' : 'Скрываем книгу…');
    syncBusy();
    try {
      const row = returnedRow(await client.adminSetPublished(id, published), id);
      if (!current(request)) return;
      replaceRow(row);
      await catalogueChanged(request);
      if (!current(request)) return;
      await load('books');
      if (current(request)) status(row.published ? 'Книга опубликована.' : 'Книга скрыта из общего каталога.');
    } catch (error) { handleError(error, request, 'Не удалось изменить публикацию.'); }
    finally { if (current(request)) { writeBusy = false; syncBusy(); } }
  }

  function selectTab(name) {
    if (!allowed() || writeBusy || contentBusy) return;
    errorMessage();
    status();
    showView(name);
    if (name === 'books') renderBooks();
    else renderUsers();
    load(name);
  }

  function open() {
    if (!allowed()) { notify('Панель доступна только администратору.'); return; }
    if (dialog.open) { find('close').focus(); return; }
    opener = document.activeElement;
    pauseMain();
    dialog.showModal();
    updateLayout();
    showView(view);
    find('close').focus({ preventScroll: true });
    if (view !== 'editor') load(tab);
  }

  find('close').addEventListener('click', close);
  find('done').addEventListener('click', close);
  find('back').addEventListener('click', () => selectTab('books'));
  find('new-book').addEventListener('click', () => editBook());
  find('editor').addEventListener('submit', save);
  find('file').addEventListener('change', () => loadFile(find('file').files?.[0]));
  find('use-text').addEventListener('click', useText);
  find('search').addEventListener('input', () => { searches[tab] = find('search').value; if (tab === 'books') renderBooks(); else renderUsers(); });
  for (const name of ['books', 'users']) find(`tab-${name}`).addEventListener('click', () => selectTab(name));
  dialog.querySelector('.admin-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || writeBusy || contentBusy) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'books' : event.key === 'End' ? 'users' : tab === 'books' ? 'users' : 'books';
    selectTab(next);
    find(`tab-${next}`).focus();
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) { cleanupLayout(); restoreFocus(); } });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  window.addEventListener('resize', requestLayout);
  media.addEventListener('change', requestLayout);
  window.visualViewport?.addEventListener('resize', requestLayout);
  window.visualViewport?.addEventListener('scroll', requestLayout);
  // A frame runs after the reader's fullscreen handlers release their scroll lock.
  document.addEventListener('fullscreenchange', requestLayout);
  client.subscribe((nextState) => {
    state = nextState || client.getState() || {};
    const nextIdentity = state.user?.id || '';
    const nextAdmin = state.isAdmin === true;
    if (nextIdentity !== identity || (!previousAdmin && nextAdmin)) deniedIdentity = '';
    if (nextIdentity !== identity || !state.configured || !nextIdentity || !nextAdmin) clearSensitive();
    identity = nextIdentity;
    previousAdmin = nextAdmin;
    syncBusy();
  });
  syncBusy();
  return { open, close };
}
