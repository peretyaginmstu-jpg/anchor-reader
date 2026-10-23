import { runImporterTests } from './importers.browser.mjs';
import { runStorageTests } from './storage.browser.mjs';
import { runFocusTests } from './focus.browser.mjs';
import { runRhythmTests } from './rhythm.browser.mjs';
import * as storage from '../js/storage.mjs';

const output = document.querySelector('#results');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function until(predicate, label, limit = 8000) {
  const deadline = performance.now() + limit;
  while (!predicate()) { if (performance.now() > deadline) throw new Error(`Timeout: ${label}`); await delay(30); }
}

document.querySelector('#run').addEventListener('click', async () => {
  document.querySelector('#run').disabled = true;
  const report = { passed: 0, failed: 0, suites: [], integration: [] };
  const record = async (name, fn) => {
    try { await fn(); report.passed++; report.integration.push({ name, ok: true }); }
    catch (error) { report.failed++; report.integration.push({ name, ok: false, error: error.message }); }
    output.textContent = JSON.stringify(report, null, 2);
  };
  let frame;
  let savedSettings;
  const originalIds = new Set();
  const openedClassics = new Set(['dostoevsky-white-nights']);
  try {
    output.textContent = 'Проверка импорта…';
    for (const [name, run] of [['importers', runImporterTests], ['storage', runStorageTests]]) {
      const result = await run();
      report.suites.push({ name, ...result });
      report.passed += result.passed;
      report.failed += result.failed;
    }
    savedSettings = await storage.getSettings();
    await storage.saveSettings({ pauseOptions: { ...storage.DEFAULT_SETTINGS.pauseOptions }, smart: true, startDelay: 0, pauseAfterParagraph: false, pauseAfterChapter: false });
    (await storage.listBooks()).forEach(book => originalIds.add(book.id));
    frame = document.createElement('iframe');
    frame.width = '1440';
    frame.src = '../';
    document.querySelector('#frame-host').append(frame);
    await until(() => frame.contentDocument?.body?.dataset.ready === 'true', 'application initialization');
    let d = frame.contentDocument;
    let w = frame.contentWindow;
    const el = id => d.getElementById(id);
    const input = (id, value, type = 'input') => { el(id).value = value; el(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
    await record('Paste text, save book, close dialog', async () => {
      el('paste-button').click();
      input('text-title', 'QA — временная книга');
      input('text-input', 'книга мама я «мама!» iii WWW ёлка мо\u0301ре по-русски 12345 ' + 'сверхдлинноесловодляпроверки'.repeat(4) + '\n\n' + Array.from({length: 100}, (_, i) => `слово${i}`).join(' '));
      el('read-text-button').click();
      await until(() => el('book-title').textContent === 'QA — временная книга' && !el('import-dialog').open, 'pasted book');
      assert(el('word-anchor').textContent === 'и', 'книга middle letter must be и');
      assert((await storage.listBooks()).some(b => b.title === 'QA — временная книга'), 'Book not persisted');
    });
    await record('Library search combines title and author, ё/е, filters and reset', async () => {
      await until(() => d.querySelector('[data-book-id="dostoevsky-white-nights"]'), 'catalogue');
      await until(() => [...d.querySelectorAll('.library-open strong')].some(title => title.textContent === 'QA — временная книга'), 'saved library metadata');
      const total = d.querySelectorAll('.classic-cover').length;
      input('library-search', 'ФЕДОР ночи');
      assert(d.querySelectorAll('.classic-cover').length === 1, 'Case-insensitive multi-term search failed');
      assert(d.querySelector('.cover-title').textContent === 'Белые ночи', 'Wrong book found');
      input('author-filter', 'Фёдор Достоевский', 'change');
      input('library-search', 'КНИГА КОТОРОЙ НЕТ');
      assert(!el('classics-empty').hidden && !d.querySelector('.classic-cover'), 'Missing empty result state');
      el('reset-filters').click();
      assert(d.querySelectorAll('.classic-cover').length === total, 'Reset lost books');
      assert(d.activeElement === el('library-search'), 'Reset must return focus to search');
      input('library-search', 'QA временная');
      assert(d.querySelectorAll('.library-book').length === 1, 'Imported book is not searchable');
      assert(d.querySelector('.library-open strong').textContent === 'QA — временная книга', 'Wrong local book found');
      const index = el('progress').value;
      el('library-search').dispatchEvent(new w.KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));
      assert(el('progress').value === index, 'Search arrow key moved reading position');
      el('clear-search').click();
      assert(el('library-search').value === '' && d.querySelectorAll('.classic-cover').length === total, 'Clear search failed');
    });
    for (const width of [1440, 390, 320]) {
      await record(`Anchor center and long-word fit at ${width}px`, async () => {
        frame.width = String(width);
        await delay(80);
        for (let index = 0; index < 11; index++) {
          input('progress', String(index));
          await delay(5);
          const anchor = el('word-anchor').getBoundingClientRect();
          const line = el('word-line').getBoundingClientRect();
          const prefix = el('word-prefix').getBoundingClientRect();
          const suffix = el('word-suffix').getBoundingClientRect();
          assert(Math.abs(anchor.x + anchor.width / 2 - (line.x + line.width / 2)) <= 1, `Anchor moved at word ${index}`);
          assert(prefix.x >= line.x - 1 && suffix.right <= line.right + 1, `Word clipped at index ${index}`);
        }
        assert(d.documentElement.scrollWidth <= width, 'Page horizontally overflows');
      });
    }
    await runFocusTests({ frame, record });
    await runRhythmTests({ frame, record });
    await record('Keyboard works after clicking reader controls', async () => {
      input('progress', '0');
      el('next-button').click();
      el('next-button').focus();
      el('next-button').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      assert(el('progress').value === '2', 'ArrowRight on button did not seek');
      el('play-button').focus();
      el('play-button').dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
      assert(el('play-label').textContent === 'Пауза', 'Space on play button did not play');
      el('play-button').click();
    });
    await record('Pause, resume and periodic save continue', async () => {
      input('speed', '600');
      el('smart').checked = false;
      el('smart').dispatchEvent(new w.Event('change', { bubbles: true }));
      input('progress', '12');
      el('play-button').click();
      await delay(70);
      el('play-button').click();
      const paused = Number(el('progress').value);
      await delay(170);
      assert(Number(el('progress').value) === paused, 'Paused reading moved');
      el('play-button').click();
      await delay(850);
      const book = (await storage.listBooks()).find(b => b.title === 'QA — временная книга');
      assert(book.position > paused, 'Periodic save did not resume');
      el('play-button').click();
    });
    await record('Context word selection stays paused until explicit continue', async () => {
      el('context-button').click();
      assert(el('context-dialog').open, 'Context dialog not opened');
      const target = el('context-paragraph').querySelectorAll('.context-word')[3];
      const word = target.textContent;
      target.click();
      assert(el('context-dialog').open, 'Context dialog closed prematurely');
      assert(el('word-line').getAttribute('aria-label') === word, 'Wrong selected word');
      assert(el('play-label').textContent !== 'Пауза', 'Word selection unexpectedly started playback');
      el('continue-button').click();
      assert(!el('context-dialog').open, 'Context dialog did not close');
      assert(el('play-label').textContent === 'Пауза', 'Context did not resume');
      el('play-button').click();
    });
    await record('Normal text view and sentence return preserve control', async () => {
      input('progress', '9');
      el('sentence-button').click();
      assert(el('progress').value === '4', 'Sentence rewind missed punctuation boundary');
      el('text-mode').click();
      assert(!el('text-mode-panel').hidden && el('word-stage').hidden, 'Text view did not switch');
      assert(el('reading-text').textContent.includes('книга'), 'Context paragraph missing');
      const beforeSize = parseFloat(w.getComputedStyle(el('reading-text')).fontSize);
      el('font-larger').click();
      assert(parseFloat(w.getComputedStyle(el('reading-text')).fontSize) > beforeSize, 'Text size button had no effect in normal mode');
      el('font-smaller').click();
      const space = new w.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
      el('font-larger').dispatchEvent(space);
      assert(!space.defaultPrevented && el('play-label').textContent !== 'Пауза', 'Space hijacked a normal button');
      el('play-button').click();
      assert(!el('word-stage').hidden && el('text-mode-panel').hidden, 'Play did not return to RSVP');
      el('play-button').click();
    });
    await record('Optional paragraph pause stops before next paragraph', async () => {
      el('smart-settings-button').click();
      input('rhythm-stop', 'paragraph', 'change');
      el('rhythm-done').click();
      input('progress', '10');
      el('play-button').click();
      await delay(250);
      assert(el('progress').value === '11' && el('play-label').textContent !== 'Пауза', 'Paragraph pause failed');
      el('smart-settings-button').click();
      input('rhythm-stop', 'none', 'change');
      el('rhythm-done').click();
    });
    await record('Hotkeys do not interfere with text input', async () => {
      el('paste-button').click();
      const oldPosition = el('progress').value;
      el('text-input').dispatchEvent(new w.KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));
      assert(el('progress').value === oldPosition, 'Text input sought reader');
      el('import-dialog').close();
    });
    await record('Failed import keeps existing book', async () => {
      el('paste-button').click();
      input('text-input', '');
      const title = el('book-title').textContent;
      el('read-text-button').click();
      await until(() => el('import-error').textContent.length > 0, 'empty text error');
      assert(el('book-title').textContent === title, 'Failed import replaced current book');
      el('import-dialog').close();
    });
    let savedPosition;
    await record('Save a custom rhythm for reload', async () => {
      el('smart-settings-button').click();
      input('rhythm-pause-sentence', '3.15', 'change');
      d.querySelector('[data-start-delay="2000"]').click();
      input('rhythm-stop', 'chapter', 'change');
      el('rhythm-done').click();
    });
    await record('Reload restores book, position, theme and settings', async () => {
      input('progress', '28');
      savedPosition = el('progress').value;
      el('theme-button').click();
      const theme = d.documentElement.dataset.theme;
      await delay(130);
      frame.src = '../?reload-test=1';
      await delay(80);
      await until(() => frame.contentDocument?.body?.dataset.ready === 'true' && frame.contentDocument.getElementById('book-title').textContent === 'QA — временная книга', 'restore');
      d = frame.contentDocument;
      w = frame.contentWindow;
      assert(el('progress').value === savedPosition, 'Position not restored');
      assert(el('speed').value === '600', 'Speed not restored');
      assert(!el('smart').checked, 'Smart pauses not restored');
      assert(d.documentElement.dataset.theme === theme, 'Theme not restored');
      el('smart-settings-button').click();
      assert(el('rhythm-pause-sentence').value === '3.15', 'Custom pause not restored');
      assert(d.querySelector('[data-start-delay="2000"]').getAttribute('aria-pressed') === 'true', 'Start delay not restored');
      assert(el('rhythm-stop').value === 'chapter', 'Chapter stop not restored');
      d.querySelector('[data-start-delay="0"]').click();
      input('rhythm-stop', 'none', 'change');
      el('rhythm-done').click();
    });
    await record('Last word finishes and can restart', async () => {
      input('progress', el('progress').max);
      el('play-button').click();
      await until(() => el('play-label').textContent === 'Сначала', 'finish');
      assert(el('progress-percent').textContent === '100%', 'Final progress not 100%');
      el('play-button').click();
      assert(el('progress').value === '0', 'Restart did not return to first word');
      el('play-button').click();
    });
    await record('Demo can be restarted repeatedly', async () => {
      el('help-button').click(); el('demo-button').click(); el('play-button').click();
      input('progress', '20');
      el('help-button').click(); el('demo-button').click();
      assert(el('progress').value === '0', 'Demo not reset');
      el('play-button').click();
    });
    await record('Personal speed trial completes, scores and leaves book position intact', async () => {
      input('speed', '1200');
      el('smart').checked = false;
      el('smart').dispatchEvent(new w.Event('change', { bubbles: true }));
      const before = el('progress').value;
      el('smart-settings-button').click();
      el('rhythm-tempo').open = true;
      el('calibration-button').click();
      const calibration = d.querySelector('.calibration-dialog');
      calibration.querySelector('[data-calibration="start"]').click();
      await until(() => !calibration.querySelector('[data-calibration="questions"]').hidden, 'trial questions', 25000);
      const correct = [1, 2, 0];
      calibration.querySelectorAll('[data-calibration="question-fields"] fieldset').forEach((fieldset, index) => {
        fieldset.querySelectorAll('input')[correct[index]].checked = true;
      });
      calibration.querySelector('form').requestSubmit();
      assert(calibration.querySelector('[data-calibration="score"]').textContent.includes('3 / 3'), 'Trial did not score correctly');
      assert(/Фактически: \d+/.test(calibration.querySelector('[data-calibration="effective-metric"]').textContent), 'Measured speed missing');
      calibration.querySelector('[data-calibration="apply"]').click();
      assert(!calibration.open, 'Trial did not close');
      assert(el('progress').value === before, 'Trial changed book position');
    });
    await record('Dostoevsky shelf opens a complete Russian book with chapters', async () => {
      await until(() => d.querySelector('[data-book-id="dostoevsky-white-nights"]'), 'classics shelf');
      const cover = d.querySelector('[data-book-id="dostoevsky-white-nights"]');
      cover.click();
      await until(() => el('book-title').textContent === 'Белые ночи', 'White nights load', 20000);
      assert(el('chapter-select').options.length === 6, 'Six sections missing');
      assert(Number(el('progress').max) > 16000, 'Book is a fragment');
      input('chapter-select', '5', 'change');
      assert(Number(el('progress').value) > 12000, 'Chapter navigation failed');
      el('play-button').click();
      await delay(150);
      el('play-button').click();
    });
    await record('Chapter auto-stop waits before the first word of the next chapter', async () => {
      el('smart-settings-button').click();
      input('rhythm-stop', 'chapter', 'change');
      el('rhythm-done').click();
      input('chapter-select', '1', 'change');
      const chapterStart = Number(el('progress').value);
      input('progress', String(chapterStart - 1));
      el('play-button').click();
      await until(() => el('play-label').textContent !== 'Пауза', 'chapter stop');
      assert(Number(el('progress').value) === chapterStart, 'Chapter stop skipped or stopped at the wrong word');
      assert(el('stage-hint').textContent.includes('главы'), 'Stop reason missing');
      await delay(180);
      assert(Number(el('progress').value) === chapterStart, 'Stopped chapter advanced');
      input('progress', String(chapterStart - 1));
      el('play-button').click();
      el('next-button').click();
      assert(el('play-label').textContent === 'Пауза', 'Manual chapter transition was mistaken for an automatic stop');
      el('play-button').click();
      assert(!el('stage-hint').textContent.includes('главы'), 'Manual seek retained an obsolete stop reason');
      el('smart-settings-button').click();
      input('rhythm-stop', 'none', 'change');
      el('rhythm-done').click();
    });
    const catalogue = await (await fetch('../books/manifest.json')).json();
    await record('Catalogue filters all five authors and sorts by length', async () => {
      for (const author of ['Лев Толстой', 'Антон Чехов', 'Александр Пушкин', 'Николай Гоголь', 'Фёдор Достоевский']) {
        input('author-filter', author, 'change');
        assert(el('author-filter').value === author, `Missing author ${author}`);
        assert(d.querySelectorAll('.classic-cover').length === catalogue.filter(book => book.author === author).length, `Wrong count for ${author}`);
      }
      el('reset-filters').click();
      input('book-sort', 'short', 'change');
      const ids = [...d.querySelectorAll('.classic-cover')].map(cover => cover.dataset.bookId);
      const counts = ids.map(id => catalogue.find(book => book.id === id).wordCount);
      assert(counts.every((value, index) => index === 0 || value >= counts[index-1]), 'Short books not sorted first');
      el('reset-filters').click();
    });
    for (const author of ['Лев Толстой', 'Антон Чехов', 'Александр Пушкин', 'Николай Гоголь']) {
      await record(`${author}: open, navigate and resume a complete built-in book`, async () => {
        const book = catalogue.find(book => book.author === author);
        assert(Boolean(book), `No book for ${author}`);
        openedClassics.add(book.id);
        d.querySelector(`[data-book-id="${book.id}"]`).click();
        await until(() => el('book-title').textContent === book.title, 'classic book opening', 20000);
        assert(Number(el('progress').max) === book.wordCount - 1, 'Word count differs from catalogue');
        assert(el('chapter-select').options.length === book.chapterCount, 'Chapter count differs');
        input('progress', String(Math.min(50, book.wordCount - 1)));
        const before = Number(el('progress').value);
        el('play-button').click();
        await delay(160);
        el('play-button').click();
        assert(Number(el('progress').value) > before, 'Playback did not advance');
      });
    }
  } catch (error) { report.failed++; report.integration.push({ name:'Runner', ok:false, error:error.stack }); }
  finally {
    frame?.remove();
    if (savedSettings) {
      for (const book of await storage.listBooks()) if (!originalIds.has(book.id) && (book.title === 'QA — временная книга' || openedClassics.has(book.id))) await storage.deleteBook(book.id);
      await storage.saveSettings(savedSettings);
    }
    output.textContent = JSON.stringify(report, null, 2);
    document.body.dataset.result = report.failed ? 'fail' : 'pass';
    document.querySelector('#run').disabled = false;
  }
});
