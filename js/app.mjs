import { ReadingEngine, tokenizeChapters, remainingMs, applyPauseOptions } from './reader.mjs?v=20261023-rhythm';
import { importBook, bookFromText } from './importers.mjs';
import * as library from './storage.mjs?v=20261023-rhythm';
import { setupCalibration } from './calibration.mjs';
import { selectBooks, listAuthors, bookCount } from './library-search.mjs';
import { setupFocusReader } from './focus.mjs?v=20261023-rhythm';

import { normalizePauses } from './rhythm.mjs';
import { setupSmartSettings } from './smart-settings.mjs?v=20261023-rhythm';

const $ = (id) => document.getElementById(id);
const demo = bookFromText(`Внимание — это маленькое путешествие. Обычно взгляд спешит по строкам, перескакивает вперёд и возвращается назад. Здесь всё устроено иначе. Слова появляются по одному, а красная буква остаётся на месте. Просто удерживайте взгляд рядом с ней.

Представьте тихое утро. За окном ещё спит город. На столе стоит чашка тёплого чая, рядом лежит книга, которую вы давно хотели открыть. Сегодня для неё нашлось время.

Не обязательно сразу выбирать большую скорость. Начните с удобного темпа и дайте себе освоиться. После точки появится небольшая пауза. Длинное слово задержится чуть дольше. Когда захочется вернуться к мысли, остановитесь и откройте абзац.

Чтение — это встреча с чужой мыслью. Иногда хочется двигаться быстрее. Иногда важно задержаться на одной фразе. Темп всегда остаётся вашим.

Теперь попробуйте открыть свою книгу. Она останется в этом браузере вместе с местом, на котором вы остановились. Следующая история уже ждёт.`, 'Небольшая пауза для внимания');
demo.id = 'anchor-demo';
demo.author = 'Короткое знакомство с «Якорем»';

let currentBook = demo;
let doc = tokenizeChapters(demo.chapters);
let settings = { ...library.DEFAULT_SETTINGS };
let storageAvailable = true;
let toastTimer;
let persistTimer;
let libraryVersion = 0;
let importGeneration = 0;
let ready = false;
let lastDrawnIndex = -1;
let previousPlaying = false;
let fitSize = 68;
let viewMode = 'word';
let contextParagraphIndex = 0;
let pausedAtBoundary = '';
let smartSettings;
let catalogue = [];
let catalogueLoaded = false;
let savedBooks = [];
let authorSignature = '';
let focusReader;
const searchState = { query: '', author: '', sort: 'shelf' };
const measureCanvas = document.createElement('canvas');
const measure = measureCanvas.getContext('2d');
const engine = new ReadingEngine({ tokens: doc.tokens, onUpdate: () => {
  if (engine.playing && !engine.preparing && engine.index === lastDrawnIndex + 1 && lastDrawnIndex >= 0) {
    const previous = doc.tokens[lastDrawnIndex];
    const current = doc.tokens[engine.index];
    const boundary = settings.pauseAfterChapter && previous.chapterIndex !== current.chapterIndex ? 'chapter'
      : settings.pauseAfterParagraph && previous.paragraphIndex !== current.paragraphIndex ? 'paragraph' : '';
    if (boundary) { pausedAtBoundary = boundary; engine.pause(); return; }
  }
  render();
} });
const calibration = setupCalibration({ getWpm: () => engine.wpm, getSmart: () => engine.smart, onApply: setSpeed, pauseMain: () => engine.pause() });
smartSettings = setupSmartSettings({
  getSettings: () => settings,
  onOpen: () => engine.pause(),
  onChange: updateRhythm,
  onCalibration: () => { smartSettings.close(); calibration.open(); },
});
focusReader = setupFocusReader({
  readState: () => ({ wpm: engine.wpm, title: currentBook.title, status: engine.preparing ? 'Приготовьтесь…' : pausedAtBoundary ? `Пауза после ${pausedAtBoundary === 'chapter' ? 'главы' : 'абзаца'}` : '' }),
  onSpeedChange: setSpeed,
  onSettings: () => smartSettings.open(),
  onEnter: () => setViewMode('word'),
  onChange: fitWord,
});

function notify(message, duration = 5500) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}

function storageFailed(error) {
  if (storageAvailable) notify(error.message || 'Не удалось сохранить данные. Чтение доступно без сохранения.', 9000);
  storageAvailable = false;
}

function savePreferences(patch) {
  Object.assign(settings, patch);
  if (storageAvailable) library.saveSettings(patch).catch(storageFailed);
}

function persistPosition() {
  clearTimeout(persistTimer);
  persistTimer = null;
  currentBook.position = engine.finished ? doc.totalWords : engine.index;
  if (!storageAvailable || currentBook.id === demo.id) return;
  const id = currentBook.id;
  const position = currentBook.position;
  library.savePosition(id, position).catch(storageFailed);
}

function queuePosition() {
  if (!engine.playing) { persistPosition(); return; }
  if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; persistPosition(); }, 700);
}

function formatRemaining(ms) {
  if (ms <= 0) return 'прочитано';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `~ ${minutes} мин` : `~ ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function updateSlider(input) {
  const range = Number(input.max) - Number(input.min);
  input.style.setProperty('--fill', `${range ? (Number(input.value) - Number(input.min)) / range * 100 : 0}%`);
}

function fitWord() {
  const scale = settings.fontScale || 1;
  $('reading-text').style.fontSize = `${(window.innerWidth <= 600 ? 18 : 19) * scale}px`;
  $('font-smaller').disabled = scale <= .7;
  $('font-larger').disabled = scale >= 1.6;
  const token = doc.tokens[engine.index];
  if (!token) return;
  const line = $('word-line');
  const fullscreen = Boolean(document.fullscreenElement) || $('reader').classList.contains('focus-mode');
  const base = Math.min(focusReader?.maxFontSize ?? Infinity, (fullscreen ? (window.innerWidth <= 600 ? 58 : 90) : window.innerWidth <= 600 ? 48 : window.innerWidth <= 850 ? 60 : 68) * (settings.fontScale || 1));
  measure.font = `${base}px Georgia, "Times New Roman", serif`;
  measure.fontKerning = 'none';
  const width = line.getBoundingClientRect().width;
  if (!width) return;
  const requiredHalf = Math.max(measure.measureText(token.prefix).width, measure.measureText(token.suffix).width) + measure.measureText(token.anchor).width / 2;
  fitSize = Math.min(base, base * Math.max(1, width / 2 - 4) / Math.max(1, requiredHalf));
  line.style.fontSize = `${fitSize}px`;
}

function render() {
  const token = doc.tokens[engine.index];
  if (!token) return;
  if (lastDrawnIndex !== engine.index) {
    $('word-prefix').textContent = token.prefix;
    $('word-anchor').textContent = token.anchor;
    $('word-suffix').textContent = token.suffix;
    $('word-line').setAttribute('aria-label', token.text);
    lastDrawnIndex = engine.index;
    fitWord();
  }
  $('preparation-hint').hidden = !engine.preparing;
  $('reader').classList.toggle('is-preparing', engine.preparing);
  $('play-label').textContent = engine.preparing ? 'Отменить' : engine.playing ? 'Пауза' : engine.finished ? 'Сначала' : engine.index > 0 ? 'Продолжить' : 'Читать';
  $('play-button').setAttribute('aria-label', engine.preparing ? 'Отменить начало чтения' : engine.playing ? 'Приостановить чтение' : engine.finished ? 'Читать сначала' : 'Начать чтение');
  $('play-icon').innerHTML = engine.playing ? '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>' : '<path d="m8 5 11 7-11 7Z"/>';
  $('stage-hint').textContent = engine.finished ? 'Текст прочитан. Время для следующей истории.' : engine.playing ? 'Держите взгляд на красной букве' : pausedAtBoundary ? `Пауза после ${pausedAtBoundary === 'chapter' ? 'главы' : 'абзаца'}. Продолжайте в своём темпе.` : 'Одна точка опоры для вашего взгляда';
  $('progress').value = engine.index;
  updateSlider($('progress'));
  const percent = engine.finished ? 100 : Math.floor(engine.index / doc.totalWords * 100);
  $('progress-percent').textContent = `${percent}%`;
  $('progress').setAttribute('aria-valuetext', `Слово ${engine.index + 1} из ${doc.totalWords}`);
  $('time-remaining').textContent = formatRemaining(remainingMs(doc, engine.finished ? doc.totalWords : engine.index, engine.wpm, engine.smart));
  $('chapter-label').textContent = `${doc.chapters[token.chapterIndex]?.title || 'Текст'} · ${engine.index + 1} / ${doc.totalWords}`;
  $('chapter-select').value = String(token.chapterIndex);
  $('previous-button').disabled = engine.index === 0;
  $('rewind-button').disabled = engine.index === 0;
  $('next-button').disabled = engine.index >= doc.totalWords - 1;
  const average = engine.smart ? Math.round(engine.wpm * doc.totalWords / doc.suffixUnits[0]) : engine.wpm;
  $('effective-speed').textContent = engine.smart ? `С учётом пауз: ~${average} слов/мин${settings.pauseAfterParagraph || settings.pauseAfterChapter ? ' + ваши остановки' : ''}` : `Равномерный темп: ${engine.wpm} слов/мин${settings.pauseAfterParagraph || settings.pauseAfterChapter ? ' + ваши остановки' : ''}`;
  document.querySelectorAll('[data-speed]').forEach(button => { button.classList.toggle('active', Number(button.dataset.speed) === engine.wpm); button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === engine.wpm)); });
  if (viewMode === 'text') renderTextPanel();
  focusReader?.sync();
  if (ready) queuePosition();
  if (previousPlaying && !engine.playing) refreshLibrary();
  previousPlaying = engine.playing;
}

function activateBook(book, compiled = tokenizeChapters(book.chapters)) {
  if (!compiled.totalWords) throw new Error('В книге не найден текст для чтения.');
  const requestedPosition = book.position || 0;
  if (ready) persistPosition();
  currentBook = { ...book, position: requestedPosition };
  doc = applyPauseOptions(compiled, settings.pauseOptions);
  pausedAtBoundary = '';
  setViewMode('word');
  lastDrawnIndex = -1;
  $('book-title').textContent = book.title;
  $('book-meta').textContent = `${book.author || (book.id === demo.id ? 'Демонстрационный текст' : 'Ваша библиотека')} · ${doc.totalWords.toLocaleString('ru-RU')} слов`;
  $('demo-badge').hidden = book.id !== demo.id;
  $('progress').max = String(Math.max(0, doc.totalWords - 1));
  $('chapter-select').replaceChildren(...doc.chapters.map((chapter, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = chapter.title;
    return option;
  }));
  $('chapter-row').hidden = doc.chapters.length < 2;
  const completed = requestedPosition >= doc.totalWords;
  engine.replaceTokens(doc.tokens, requestedPosition);
  if (completed) { engine.finished = true; render(); }
  savePreferences({ lastBookId: book.id === demo.id ? null : book.id });
  refreshLibrary();
}

async function refreshLibrary() {
  if (!storageAvailable) return;
  const version = ++libraryVersion;
  try {
    const books = await library.listBooks();
    if (version !== libraryVersion) return;
    savedBooks = books;
    const previousAuthor = searchState.author;
    refreshAuthors();
    if (previousAuthor !== searchState.author) renderCatalogue();
    renderSavedLibrary();
    updateSearchSummary();
  } catch (error) { storageFailed(error); }
}

function renderSavedLibrary() {
    const books = selectBooks(savedBooks, searchState);
    const filtering = Boolean(searchState.query.trim() || searchState.author);
    $('library-empty').hidden = savedBooks.length > 0 || filtering;
    $('library-search-empty').hidden = books.length > 0 || (!savedBooks.length && !filtering);
    $('library-list').replaceChildren(...books.map((book) => {
      const article = document.createElement('article');
      article.className = `library-book${book.id === currentBook.id ? ' active' : ''}`;
      const icon = document.createElement('span');
      icon.className = 'book-symbol';
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 14h14M7 3v14"/></svg>';
      const open = document.createElement('button');
      open.className = 'library-open';
      const title = document.createElement('strong');
      title.textContent = book.title;
      const meta = document.createElement('small');
      const percent = book.totalWords ? Math.min(100, Math.floor((book.position || 0) / book.totalWords * 100)) : 0;
      meta.textContent = `${book.author ? `${book.author} · ` : ''}${percent ? `${percent}% прочитано` : 'Начать чтение'}`;
      open.append(title, meta);
      open.addEventListener('click', async () => {
        const generation = ++importGeneration;
        engine.pause();
        try {
          const stored = await library.getBook(book.id);
          if (generation !== importGeneration) return;
          if (!stored) { await refreshLibrary(); notify('Этой книги уже нет в библиотеке.'); return; }
          activateBook(stored);
          $('reader').scrollIntoView({ block: 'center', behavior: 'instant' });
        } catch (error) { notify(error.message); }
      });
      const remove = document.createElement('button');
      remove.className = 'icon-button delete-book';
      remove.setAttribute('aria-label', `Удалить книгу «${book.title}»`);
      remove.title = 'Удалить с полки';
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>';
      remove.addEventListener('click', async () => {
        engine.pause();
        try {
          await library.deleteBook(book.id);
          if (currentBook.id === book.id) { demo.position = 0; activateBook(demo); }
          await refreshLibrary();
          notify('Книга удалена с полки. Исходный файл остался на устройстве.');
        } catch (error) { storageFailed(error); }
      });
      article.append(icon, open, remove);
      return article;
    }));
}

function openDialog(id) {
  engine.pause();
  $(id).showModal();
}

function openImport(focusText = false) {
  $('import-error').textContent = '';
  openDialog('import-dialog');
  if (focusText) $('text-input').focus();
}

function importBusy(busy) {
  $('read-text-button').disabled = busy;
  $('choose-file-button').disabled = busy;
  $('read-text-button').textContent = busy ? 'Подготавливаем текст…' : 'Добавить и читать';
}

async function addBook(book, generation) {
  const compiled = tokenizeChapters(book.chapters);
  if (!compiled.totalWords) throw new Error('В книге не найден текст для чтения.');
  if (generation !== importGeneration) return;
  book.totalWords = compiled.totalWords;
  if (storageAvailable) {
    try { await library.saveBook(book); } catch (error) { storageFailed(error); }
  }
  if (generation !== importGeneration) return;
  activateBook(book, compiled);
  $('import-dialog').close();
  $('text-input').value = '';
  $('text-title').value = '';
  notify(storageAvailable ? 'Книга готова. Нажмите «Читать», когда будете готовы.' : 'Книга открыта без сохранения в библиотеке.');
}

async function loadFile(file) {
  if (!file) return;
  const generation = ++importGeneration;
  engine.pause();
  $('import-error').textContent = '';
  importBusy(true);
  try { await addBook(await importBook(file, { encoding: $('encoding').value }), generation); }
  catch (error) { if (generation === importGeneration) $('import-error').textContent = error.message || 'Не удалось открыть книгу.'; }
  finally { if (generation === importGeneration) importBusy(false); $('file-input').value = ''; }
}

function contextNodes(center, onSelect) {
  const nodes = [];
  for (let p = Math.max(0, center - 1); p <= Math.min(doc.paragraphs.length - 1, center + 1); p += 1) {
    const paragraph = doc.paragraphs[p];
    const wrapper = document.createElement('p');
    wrapper.className = p === center ? 'current-paragraph' : 'neighbor-paragraph';
    for (let index = paragraph.start; index < paragraph.end; index += 1) {
      const button = document.createElement('button');
      button.className = `context-word${index === engine.index ? ' current' : ''}`;
      button.textContent = doc.tokens[index].text;
      if (index === engine.index) button.setAttribute('aria-current', 'location');
      button.addEventListener('click', () => onSelect(index));
      wrapper.append(button, document.createTextNode(' '));
    }
    nodes.push(wrapper);
  }
  return nodes;
}

function renderContext() {
  $('context-paragraph').replaceChildren(...contextNodes(contextParagraphIndex, index => {
    seekWord(index);
    contextParagraphIndex = doc.tokens[index].paragraphIndex;
    renderContext();
    $('continue-button').focus();
  }));
  $('context-count').textContent = `${contextParagraphIndex + 1} / ${doc.paragraphs.length}`;
  $('context-previous').disabled = contextParagraphIndex === 0;
  $('context-next').disabled = contextParagraphIndex === doc.paragraphs.length - 1;
}

function showContext() {
  engine.pause();
  contextParagraphIndex = doc.tokens[engine.index].paragraphIndex;
  renderContext();
  openDialog('context-dialog');
  $('context-paragraph').querySelector('.current')?.scrollIntoView({ block: 'center' });
}

function renderTextPanel() {
  const center = doc.tokens[engine.index].paragraphIndex;
  $('reading-text').replaceChildren(...contextNodes(center, index => { seekWord(index); }));
  $('text-previous').disabled = center === 0;
  $('text-next').disabled = center === doc.paragraphs.length - 1;
}

function setViewMode(mode) {
  if (mode === 'text') engine.pause();
  viewMode = mode;
  $('word-stage').hidden = mode !== 'word';
  $('text-mode-panel').hidden = mode !== 'text';
  $('word-mode').setAttribute('aria-pressed', String(mode === 'word'));
  $('text-mode').setAttribute('aria-pressed', String(mode === 'text'));
  if (mode === 'text') renderTextPanel();
  fitWord();
}

function seekWord(index) {
  pausedAtBoundary = '';
  lastDrawnIndex = -1;
  engine.seek(index);
}

function toggleReading() {
  pausedAtBoundary = '';
  if (!engine.playing) setViewMode('word');
  engine.toggle();
}

function setSpeed(wpm) {
  engine.setSpeed(Number(wpm));
  $('speed').value = engine.wpm;
  $('speed-value').textContent = engine.wpm;
  updateSlider($('speed'));
  savePreferences({ wpm: engine.wpm });
  smartSettings?.sync();
}

function updateRhythm(patch) {
  const next = { ...patch };
  if ('pauseOptions' in next) next.pauseOptions = normalizePauses(next.pauseOptions);
  savePreferences(next);
  if ('pauseOptions' in next) {
    applyPauseOptions(doc, settings.pauseOptions);
    engine.setPauseOptions(settings.pauseOptions);
  }
  if ('smart' in next) engine.setSmart(settings.smart);
  if ('startDelay' in next) engine.setStartDelay(settings.startDelay);
  if ('wpm' in next) setSpeed(settings.wpm);
  pausedAtBoundary = '';
  $('smart').checked = engine.smart;
  smartSettings?.sync();
  render();
}

async function loadCatalogue() {
  try {
    const response = await fetch('./books/manifest.json?v=20261023-library');
    if (!response.ok) throw new Error('Не удалось загрузить полку классики.');
    catalogue = await response.json();
    catalogueLoaded = true;
    refreshAuthors();
    renderCatalogue();
    updateSearchSummary();
  } catch (error) {
    const message = document.createElement('p'); message.className = 'catalog-loading'; message.textContent = error.message;
    const retry = document.createElement('button'); retry.className = 'text-button'; retry.textContent = 'Повторить'; retry.addEventListener('click', loadCatalogue);
    $('classics-list').replaceChildren(message, retry);
    $('search-results').textContent = 'Поиск по вашим книгам доступен. Полку классики можно загрузить повторно.';
  }
}

function renderCatalogue() {
    if (!catalogueLoaded) return;
    const books = selectBooks(catalogue, searchState);
    $('classics-count').textContent = `${bookCount(catalogue.length)} · полные тексты на русском`;
    $('classics-empty').hidden = books.length > 0;
    $('classics-list').replaceChildren(...books.map(book => {
      const card = document.createElement('article'); card.className = 'classic-card';
      const cover = document.createElement('button'); cover.className = 'classic-cover'; cover.dataset.bookId = book.id;
      cover.dataset.author = book.id.split('-')[0];
      cover.setAttribute('aria-label', `Читать «${book.title}»`);
      for (const [className, text] of [['cover-author', book.author.replace(/ (\S+)$/u, '\n$1')], ['cover-title', book.title], ['cover-year', String(book.year)], ['cover-open', '↗']]) {
        const span = document.createElement('span'); span.className = className; span.textContent = text; cover.append(span);
      }
      const meta = document.createElement('div'); meta.className = 'classic-meta';
      const length = document.createElement('span'); length.textContent = book.wordCount >= 10000 ? `${Math.round(book.wordCount / 1000)} тыс. слов` : `${book.wordCount.toLocaleString('ru-RU')} слов`;
      const source = document.createElement('a'); source.textContent = 'Источник ↗'; source.href = book.source.url; source.target = '_blank'; source.rel = 'noopener';
      meta.append(length, source); card.append(cover, meta);
      cover.addEventListener('click', () => openClassic(book, cover));
      return card;
    }));
}

function refreshAuthors() {
  const authors = listAuthors([...catalogue, ...savedBooks]);
  const signature = JSON.stringify(authors);
  if (signature === authorSignature) return;
  authorSignature = signature;
  $('author-filter').replaceChildren(...['', ...authors].map(author => {
    const option = document.createElement('option');
    option.value = author;
    option.textContent = author || 'Все авторы';
    return option;
  }));
  if (!authors.includes(searchState.author)) searchState.author = '';
  $('author-filter').value = searchState.author;
}

function updateSearchSummary() {
  const classics = selectBooks(catalogue, searchState).length;
  const saved = selectBooks(savedBooks, searchState).length;
  const filtering = Boolean(searchState.query.trim() || searchState.author);
  $('search-results').textContent = filtering ? `Классика: ${bookCount(classics)} · На вашей полке: ${bookCount(saved)}` : 'Ищите по названию и автору во всей библиотеке';
  $('clear-search').hidden = !searchState.query;
  $('reset-filters').hidden = !filtering && searchState.sort === 'shelf';
}

function applySearch() {
  searchState.query = $('library-search').value;
  searchState.author = $('author-filter').value;
  searchState.sort = $('book-sort').value;
  renderCatalogue();
  renderSavedLibrary();
  updateSearchSummary();
}

$('library-search').addEventListener('input', applySearch);
$('author-filter').addEventListener('change', applySearch);
$('book-sort').addEventListener('change', applySearch);
$('clear-search').addEventListener('click', () => { $('library-search').value = ''; applySearch(); $('library-search').focus(); });
$('reset-filters').addEventListener('click', () => { $('library-search').value = ''; $('author-filter').value = ''; $('book-sort').value = 'shelf'; applySearch(); $('library-search').focus(); });

async function openClassic(entry, button) {
  const generation = ++importGeneration;
  engine.pause();
  button.disabled = true;
  const title = button.querySelector('.cover-title'); title.textContent = 'Открываем…';
  try {
    let book = storageAvailable ? await library.getBook(entry.id) : null;
    if (!book) {
      const response = await fetch(`./books/${entry.file}`);
      if (!response.ok) throw new Error('Книга не загрузилась. Проверьте соединение и попробуйте ещё раз.');
      const data = await response.json();
      book = { ...data, position: 0, createdAt: Date.now(), updatedAt: Date.now() };
      if (generation !== importGeneration) return;
      const compiled = tokenizeChapters(book.chapters);
      book.totalWords = compiled.totalWords;
      if (storageAvailable) { try { await library.saveBook(book); } catch (error) { storageFailed(error); } }
      if (generation !== importGeneration) return;
      activateBook(book, compiled);
    } else {
      if (generation !== importGeneration) return;
      activateBook(book);
    }
    $('reader').scrollIntoView({ block: 'start', behavior: 'instant' });
    $('play-button').focus({ preventScroll: true });
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; title.textContent = entry.title; }
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  $('theme-button').setAttribute('aria-label', settings.theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
  document.querySelector('meta[name="theme-color"]').content = settings.theme === 'dark' ? '#181c1a' : '#f7f5f0';
}

$('play-button').addEventListener('click', toggleReading);
$('previous-button').addEventListener('click', () => seekWord(engine.index - 1));
$('next-button').addEventListener('click', () => seekWord(engine.index + 1));
$('rewind-button').addEventListener('click', () => seekWord(engine.index - 10));
$('progress').addEventListener('input', () => seekWord(Number($('progress').value)));
$('chapter-select').addEventListener('change', () => seekWord(doc.chapters[Number($('chapter-select').value)].start));
$('speed').addEventListener('input', () => setSpeed($('speed').value));
$('word-mode').addEventListener('click', () => setViewMode('word'));
$('text-mode').addEventListener('click', () => setViewMode('text'));
$('font-smaller').addEventListener('click', () => { savePreferences({ fontScale: Math.max(.7, (settings.fontScale || 1) - .1) }); fitWord(); });
$('font-larger').addEventListener('click', () => { savePreferences({ fontScale: Math.min(1.6, (settings.fontScale || 1) + .1) }); fitWord(); });
$('sentence-button').addEventListener('click', () => {
  engine.pause();
  let index = engine.index;
  const paragraph = doc.tokens[index].paragraphIndex;
  while (index > 0 && doc.tokens[index - 1].paragraphIndex === paragraph && !/[.!?…][»”’"')\]]*$/u.test(doc.tokens[index - 1].text)) index -= 1;
  if (index === engine.index && index > 0) {
    index -= 1;
    const precedingParagraph = doc.tokens[index].paragraphIndex;
    while (index > 0 && doc.tokens[index - 1].paragraphIndex === precedingParagraph && !/[.!?…][»”’"')\]]*$/u.test(doc.tokens[index - 1].text)) index -= 1;
  }
  pausedAtBoundary = '';
  seekWord(index);
});
for (const [id, delta] of [['context-previous', -1], ['context-next', 1]]) $(id).addEventListener('click', () => { contextParagraphIndex = Math.max(0, Math.min(doc.paragraphs.length - 1, contextParagraphIndex + delta)); renderContext(); $('context-paragraph').scrollTop = 0; });
for (const [id, delta] of [['text-previous', -1], ['text-next', 1]]) $(id).addEventListener('click', () => { const next = Math.max(0, Math.min(doc.paragraphs.length - 1, doc.tokens[engine.index].paragraphIndex + delta)); seekWord(doc.paragraphs[next].start); $('text-mode-panel').scrollTop = 0; });
$('smart').addEventListener('change', () => updateRhythm({ smart: $('smart').checked }));
$('theme-button').addEventListener('click', () => { savePreferences({ theme: settings.theme === 'light' ? 'dark' : 'light' }); applyTheme(); });
$('context-button').addEventListener('click', showContext);
$('continue-button').addEventListener('click', () => { $('context-dialog').close(); pausedAtBoundary = ''; setViewMode('word'); engine.play(); });
$('help-button').addEventListener('click', () => openDialog('help-dialog'));
$('demo-button').addEventListener('click', () => { ++importGeneration; $('help-dialog').close(); demo.position = 0; activateBook(demo); engine.play(); });
document.querySelectorAll('.import-trigger').forEach((button) => button.addEventListener('click', () => openImport()));
$('paste-button').addEventListener('click', () => openImport(true));
$('choose-file-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', () => loadFile($('file-input').files[0]));
$('drop-zone').addEventListener('dragover', (event) => { event.preventDefault(); $('drop-zone').classList.add('dragover'); });
$('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragover'));
$('drop-zone').addEventListener('drop', (event) => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); loadFile(event.dataTransfer.files[0]); });
$('read-text-button').addEventListener('click', async () => {
  const generation = ++importGeneration;
  $('import-error').textContent = '';
  importBusy(true);
  try { await addBook(bookFromText($('text-input').value, $('text-title').value.trim() || 'Мой текст'), generation); }
  catch (error) { $('import-error').textContent = error.message; }
  finally { if (generation === importGeneration) importBusy(false); }
});
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$('import-dialog').addEventListener('close', () => { importGeneration += 1; importBusy(false); });
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest('button,a') && !event.target.closest('#reader')) return;
  if (event.code === 'Space') {
    if (event.target.closest('button') && event.target.closest('button').id !== 'play-button') return;
    event.preventDefault(); if (!event.repeat) toggleReading();
  }
  if (event.key === 'ArrowLeft') { event.preventDefault(); seekWord(engine.index - 1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); seekWord(engine.index + 1); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { engine.pause(); persistPosition(); } });
window.addEventListener('pagehide', () => { engine.pause(); persistPosition(); });
new ResizeObserver(fitWord).observe($('word-stage'));

async function initialize() {
  let restored = null;
  try {
    settings = await library.getSettings();
    if (settings.lastBookId) restored = await library.getBook(settings.lastBookId);
  } catch (error) { storageFailed(error); }
  applyTheme();
  engine.setSpeed(settings.wpm);
  engine.setSmart(settings.smart);
  engine.setPauseOptions(settings.pauseOptions);
  engine.setStartDelay(settings.startDelay);
  $('speed').value = engine.wpm;
  $('speed-value').textContent = engine.wpm;
  $('smart').checked = engine.smart;
  smartSettings.sync();
  updateSlider($('speed'));
  try { activateBook(restored || demo); }
  catch { activateBook(demo); notify('Не удалось восстановить последнюю книгу. Откройте её заново.'); }
  ready = true;
  render();
  document.body.dataset.ready = 'true';
  loadCatalogue();
}
initialize();
