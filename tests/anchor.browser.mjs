import { getSettings } from '../js/storage.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function until(predicate, label) {
  const deadline = performance.now() + 6000;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error(`Timeout: ${label}`);
    await delay(20);
  }
}

function replaceProperty(object, name, descriptor) {
  const original = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
  return () => {
    if (original) Object.defineProperty(object, name, original);
    else delete object[name];
  };
}

/** Uses the existing QA book and restores settings, layout and reader state. */
export async function runAnchorTests({ frame, record }) {
  const d = frame.contentDocument;
  const w = frame.contentWindow;
  const el = (id) => d.getElementById(id);
  const reader = el('reader');
  const rhythm = el('rhythm-dialog');
  const advanced = el('rhythm-advanced');
  const settings = await getSettings();
  const isPlaying = () => ['Пауза', 'Отменить'].includes(el('play-label').textContent);
  const saved = {
    anchorMode: settings.anchorMode === 'left' ? 'left' : 'center',
    width: frame.style.width, height: frame.style.height,
    speed: el('speed').value, position: el('progress').value,
    title: el('book-title').textContent,
    playing: isPlaying(),
    focus: reader.classList.contains('focus-reader'),
    textMode: el('text-mode').getAttribute('aria-pressed') === 'true',
    dialogs: [...d.querySelectorAll('dialog[open]')],
    advanced: advanced.open, tempo: el('rhythm-tempo').open,
    scrollX: w.scrollX, scrollY: w.scrollY,
    activeElement: d.activeElement,
  };
  const input = (id, value) => {
    el(id).value = String(value);
    el(id).dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const pause = () => { if (isPlaying()) el('play-button').click(); };
  const closeDialogs = () => {
    for (const dialog of d.querySelectorAll('dialog[open]')) {
      const trialClose = dialog.querySelector('[data-calibration="close"]');
      if (trialClose) trialClose.click();
      else dialog.close();
    }
  };
  const leaveFocus = async () => {
    closeDialogs();
    if (reader.classList.contains('focus-reader')) reader.querySelector('.focus-exit').click();
    await until(() => !reader.classList.contains('focus-reader'), 'leave focus');
  };
  const resize = async (width, height) => {
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    await until(() => w.innerWidth === width && w.innerHeight === height, 'anchor test viewport');
    await delay(60);
  };
  const openRhythm = () => {
    if (!rhythm.open) {
      const trigger = reader.classList.contains('focus-reader') ? reader.querySelector('.focus-speed-label') : el('smart-settings-button');
      trigger.click();
    }
    assert(rhythm.open, 'Rhythm settings did not open');
  };
  const modeButton = (mode) => {
    const button = advanced.querySelector(`[data-anchor-mode="${mode}"]`);
    assert(button, `Missing ${mode} anchor option inside advanced settings`);
    return button;
  };
  const setMode = (mode, close = true) => {
    openRhythm();
    if (!advanced.open) advanced.querySelector('summary').click();
    modeButton(mode).click();
    if (close) el('rhythm-done').click();
  };
  const unchanged = (position, speed) => {
    assert(el('progress').value === String(position), 'Changing the anchor moved the reading position');
    assert(el('speed').value === String(speed), 'Changing the anchor changed the reading speed');
    assert(el('book-title').textContent === saved.title, 'Anchor tests replaced the current book');
    assert(!isPlaying(), 'Changing or closing anchor settings started reading');
  };
  const wordParts = () => ['word-prefix', 'word-anchor', 'word-suffix'].map((id) => el(id).textContent);
  const geometry = (label, fullscreen = false) => {
    const anchor = el('word-anchor').getBoundingClientRect();
    const line = el('word-line').getBoundingClientRect();
    const prefix = el('word-prefix').getBoundingClientRect();
    const suffix = el('word-suffix').getBoundingClientRect();
    assert(line.width > 0 && anchor.width > 0 && line.height > 0, `${label}: the word is not laid out`);
    assert(Math.abs(anchor.left + anchor.width / 2 - line.left - line.width / 2) <= 1, `${label}: anchor is not centered`);
    assert(prefix.left >= line.left - 1 && suffix.right <= line.right + 1, `${label}: the word is clipped`);
    if (fullscreen) {
      const bounds = reader.getBoundingClientRect();
      assert(Math.abs(anchor.left + anchor.width / 2 - bounds.left - bounds.width / 2) <= 1, `${label}: fullscreen anchor moved horizontally`);
      assert(Math.abs(line.top + line.height / 2 - bounds.top - bounds.height / 2) <= 1, `${label}: fullscreen word moved vertically`);
    }
  };
  const scenario = (label, run) => record(label, async () => {
    pause();
    await leaveFocus();
    el('word-mode').click();
    try { await run(); }
    finally { pause(); await leaveFocus(); }
  });
  const restoreFullscreen = replaceProperty(d, 'fullscreenEnabled', { get: () => false });

  try {
    await scenario('Anchor choice updates the current word, example and selection without changing playback', async () => {
      input('progress', 0);
      const speed = el('speed').value;
      assert(el('word-line').getAttribute('aria-label') === 'книга', 'Expected the existing QA book at word zero');
      setMode('center');
      assert(el('word-anchor').textContent === 'и', 'Center mode did not select и in книга');
      openRhythm();
      assert(!advanced.open, 'Advanced settings did not start collapsed');
      advanced.querySelector('summary').click();
      setMode('left', false);
      assert(wordParts().join('|') === 'к|н|ига', 'Left mode did not redraw the same current word');
      assert(modeButton('left').getAttribute('aria-pressed') === 'true' && modeButton('center').getAttribute('aria-pressed') === 'false', 'Anchor selection is not reflected by aria-pressed');
      const example = el('rhythm-anchor-example');
      assert(example.children.length === 3 && [...example.children].map((part) => part.textContent).join('|') === 'вн|и|мание', 'Left example did not update its three parts');
      unchanged(0, speed);
      el('rhythm-done').click();
      await delay(150);
      unchanged(0, speed);
      await until(async () => (await getSettings()).anchorMode === 'left', 'anchor preference persisted');
      openRhythm();
      assert(!advanced.open && modeButton('left').getAttribute('aria-pressed') === 'true', 'Reopening settings lost the selection or expanded advanced settings');
      advanced.querySelector('summary').click();
      setMode('center', false);
      assert(wordParts().join('|') === 'кн|и|га', 'Center mode did not restore the original split');
      assert([...example.children].map((part) => part.textContent).join('|') === 'вни|м|ание', 'Center example was not restored');
      assert(modeButton('center').getAttribute('aria-pressed') === 'true' && modeButton('left').getAttribute('aria-pressed') === 'false', 'Center selection is not exclusive');
      el('rhythm-done').click();
      unchanged(0, speed);
    });

    await scenario('Both anchor modes retain Unicode, punctuation and word fit at 320, 390 and 1440 pixels', async () => {
      const cases = [
        ['книга', ['кн', 'и', 'га'], ['к', 'н', 'ига']],
        ['мама', ['м', 'а', 'ма']],
        ['я', ['', 'я', '']],
        ['«мама!»', ['«м', 'а', 'ма!»']],
        ['iii', ['i', 'i', 'i']],
        ['WWW', ['W', 'W', 'W']],
        ['ёлка', ['ё', 'л', 'ка']],
        ['мо́ре', ['м', 'о́', 'ре']],
        ['по-русски', ['по-р', 'у', 'сски'], ['по-', 'р', 'усски']],
        ['12345', ['12', '3', '45']],
        ['сверхдлинноесловодляпроверки'.repeat(4)],
      ];
      const speed = el('speed').value;
      for (const [width, height] of [[320, 568], [390, 844], [1440, 900]]) {
        await resize(width, height);
        for (const mode of ['center', 'left']) {
          setMode(mode);
          for (const [index, [text, center, left = center]] of cases.entries()) {
            input('progress', index);
            await delay(5);
            assert(el('word-line').getAttribute('aria-label') === text && wordParts().join('') === text, `${width}/${mode}/${index}: original word changed`);
            const expected = mode === 'left' ? left : center;
            if (expected) assert(wordParts().join('|') === expected.join('|'), `${width}/${mode}/${index}: wrong grapheme selected`);
            geometry(`${width}/${mode}/${index}`);
            unchanged(index, speed);
          }
        }
        assert(d.documentElement.scrollWidth <= w.innerWidth + 1, `${width}: anchor mode caused horizontal overflow`);
      }
    });

    await scenario('Changing anchor mode in fullscreen keeps the fixed point and the current book position', async () => {
      await resize(390, 844);
      input('progress', 0);
      const speed = el('speed').value;
      setMode('left');
      el('fullscreen-button').click();
      await until(() => reader.classList.contains('focus-reader'), 'anchor fullscreen entry');
      await delay(40);
      geometry('fullscreen left', true);
      assert(el('word-anchor').textContent === 'н', 'Fullscreen ignored the selected left anchor');
      unchanged(0, speed);
      for (const [mode, expected] of [['center', 'и'], ['left', 'н']]) {
        setMode(mode);
        await delay(20);
        assert(reader.classList.contains('focus-reader'), 'Closing anchor settings exited fullscreen');
        assert(el('word-anchor').textContent === expected, 'Fullscreen mode switch did not redraw the current word');
        geometry(`fullscreen ${mode}`, true);
        unchanged(0, speed);
      }
    });

    await scenario('The personal speed trial uses the selected left anchor without altering the book', async () => {
      await resize(390, 844);
      input('progress', 7);
      input('speed', 100);
      setMode('left');
      openRhythm();
      if (!el('rhythm-tempo').open) el('rhythm-tempo').querySelector('summary').click();
      el('calibration-button').click();
      const trial = d.querySelector('.calibration-dialog');
      assert(trial?.open && !rhythm.open, 'The speed trial did not replace the settings dialog');
      assert(trial.querySelector('input[type="radio"]:checked')?.value === '100', 'Trial did not adopt the selected slow test tempo');
      trial.querySelector('[data-calibration="start"]').click();
      const find = (name) => trial.querySelector(`[data-calibration="${name}"]`);
      assert(find('word-line').getAttribute('aria-label') === 'В', 'Trial did not start at the first word');
      assert(find('prefix').textContent === '' && find('anchor').textContent === 'В' && find('suffix').textContent === '', 'Left mode changed the one-letter first word');
      await until(() => find('word-line').getAttribute('aria-label') === 'субботу', 'second trial word');
      find('toggle').click();
      assert(find('toggle').textContent === 'Продолжить', 'Trial did not pause on the inspected word');
      assert(find('prefix').textContent === 'су' && find('anchor').textContent === 'б' && find('suffix').textContent === 'боту', 'Trial used the center split instead of the left split for субботу');
      const line = find('word-line').getBoundingClientRect();
      const anchor = find('anchor').getBoundingClientRect();
      assert(anchor.width > 0 && Math.abs(anchor.left + anchor.width / 2 - line.left - line.width / 2) <= 1, 'Trial anchor is not centered');
      find('close').click();
      await delay(100);
      unchanged(7, 100);
      assert(!trial.open, 'Closing the trial left its dialog open');
    });
  } finally {
    pause();
    await leaveFocus();
    setMode(saved.anchorMode === 'left' ? 'left' : 'center');
    await until(async () => (await getSettings()).anchorMode === saved.anchorMode, 'restored anchor preference');
    input('speed', saved.speed);
    input('progress', saved.position);
    frame.style.width = saved.width;
    frame.style.height = saved.height;
    await delay(60);
    if (saved.textMode) el('text-mode').click();
    else el('word-mode').click();
    if (saved.focus) {
      el('fullscreen-button').click();
      await until(() => reader.classList.contains('focus-reader'), 'restore focus state');
    }
    restoreFullscreen();
    for (const dialog of saved.dialogs) if (dialog.isConnected && !dialog.open) dialog.showModal();
    advanced.open = saved.advanced;
    el('rhythm-tempo').open = saved.tempo;
    if (saved.playing && !saved.dialogs.length) el('play-button').click();
    if (saved.activeElement?.isConnected) saved.activeElement.focus({ preventScroll: true });
    w.scrollTo(saved.scrollX, saved.scrollY);
  }
}
