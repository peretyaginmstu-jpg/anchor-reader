const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function until(predicate, label) {
  const deadline = performance.now() + 4000;
  while (!predicate()) {
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

/** Runs against the already loaded app iframe; restores size, speed and reading position. */
export async function runFocusTests({ frame, record }) {
  const d = frame.contentDocument;
  const w = frame.contentWindow;
  const element = (id) => d.getElementById(id);
  const reader = element('reader');
  const trigger = element('fullscreen-button');
  const saved = {
    width: frame.style.width,
    height: frame.style.height,
    position: element('progress').value,
    speed: element('speed').value,
    playing: element('play-label').textContent === 'Пауза',
  };
  const input = (id, value) => { element(id).value = value; element(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  const leave = async () => {
    d.querySelector('dialog[open]')?.close();
    if (reader.classList.contains('focus-reader')) reader.querySelector('.focus-exit').click();
    await until(() => !reader.classList.contains('focus-reader'), 'focus exit');
  };
  const restorers = [];
  if (saved.playing) element('play-button').click();
  // Force a rejected request so the test proves the fixed viewport path even on desktop.
  restorers.push(replaceProperty(d, 'fullscreenEnabled', { get: () => true }));
  restorers.push(replaceProperty(reader, 'requestFullscreen', { value: async () => { throw new Error('Test: native fullscreen unavailable'); } }));
  try {
    for (const [width, height] of [[390, 844], [320, 568], [844, 390], [568, 320]]) {
      await record(`Focus fallback fits ${width}×${height}, with a fixed anchor and visible controls`, async () => {
        await leave();
        frame.style.width = `${width}px`;
        frame.style.height = `${height}px`;
        await delay(80);
        const before = element('progress').value;
        trigger.focus({ preventScroll: true });
        trigger.click();
        await until(() => reader.classList.contains('focus-reader'), 'fallback entry');
        await delay(60);
        const bounds = reader.getBoundingClientRect();
        const anchor = element('word-anchor').getBoundingClientRect();
        const line = element('word-line').getBoundingClientRect();
        const prefix = element('word-prefix').getBoundingClientRect();
        const suffix = element('word-suffix').getBoundingClientRect();
        assert(Math.abs(bounds.left) <= 1 && Math.abs(bounds.top) <= 1, 'Reader is offset from the viewport');
        assert(Math.abs(bounds.width - w.innerWidth) <= 1 && Math.abs(bounds.height - w.innerHeight) <= 1, 'Reader does not fill the current viewport');
        assert(Math.abs(anchor.x + anchor.width / 2 - (bounds.x + bounds.width / 2)) <= 1, 'Anchor is not horizontally centered');
        assert(Math.abs(line.y + line.height / 2 - (bounds.y + bounds.height / 2)) <= 1, 'Word is not vertically centered');
        assert(prefix.left >= line.left - 1 && suffix.right <= line.right + 1, 'Current word is clipped');
        for (const selector of ['.focus-exit', '.focus-context', '#play-button', '#previous-button', '#next-button', '.focus-speed-down', '.focus-speed-up']) {
          const control = reader.querySelector(selector);
          const rect = control.getBoundingClientRect();
          assert(rect.width >= 43 && rect.height >= 43, `${selector} has a small touch target`);
          assert(rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1, `${selector} is outside the viewport`);
        }
        assert(reader.scrollWidth <= reader.clientWidth + 1 && reader.scrollHeight <= reader.clientHeight + 1, 'Reader requires scrolling');
        const progress = reader.querySelector('.progress-labels').getBoundingClientRect();
        assert(progress.height > 0 && progress.top >= line.bottom && progress.bottom <= bounds.bottom, 'Compact progress overlaps the word or is hidden');
        assert(w.getComputedStyle(reader.querySelector('.reader-settings')).display === 'none', 'Full settings still visible');
        assert(w.getComputedStyle(d.body).position === 'fixed', 'Background scrolling was not locked');
        assert(element('progress').value === before, 'Entry changed the reading position');
        await leave();
        assert(element('progress').value === before, 'Exit changed the reading position');
        assert(d.activeElement === trigger, 'Focus did not return to the fullscreen trigger');
      });
    }

    await record('Focus speed controls use the existing engine and stay in sync', async () => {
      trigger.click();
      await until(() => reader.classList.contains('focus-reader'), 'focus entry');
      const old = Number(element('speed').value);
      const direction = old <= 1175 ? 1 : -1;
      reader.querySelector(direction === 1 ? '.focus-speed-up' : '.focus-speed-down').click();
      assert(Number(element('speed').value) === old + 25 * direction, 'Main speed control was not updated');
      assert(Number(reader.querySelector('.focus-speed-value').textContent) === old + 25 * direction, 'Compact speed label is stale');
      input('speed', String(old));
      await leave();
    });

    await record('Focus context dialog is usable and does not close focus mode', async () => {
      trigger.click();
      await until(() => reader.classList.contains('focus-reader'), 'focus entry');
      reader.querySelector('.focus-context').click();
      const context = element('context-dialog');
      assert(context.open && !context.inert, 'Context dialog is unavailable');
      const button = context.querySelector('button');
      button.focus();
      assert(d.activeElement === button, 'Dialog controls cannot receive focus');
      const escape = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      button.dispatchEvent(escape);
      assert(!escape.defaultPrevented, 'Focus mode captured the dialog Escape key');
      assert(reader.classList.contains('focus-reader'), 'Opening context left focus mode');
      context.close();
      await leave();
    });

    await record('Focus Escape restores background scroll and preserves playback state', async () => {
      w.scrollTo(0, 160);
      await delay(30);
      const beforeScroll = w.scrollY;
      input('speed', '100');
      input('progress', '0');
      element('play-button').click();
      assert(element('play-label').textContent === 'Пауза', 'Playback did not start');
      trigger.click();
      await until(() => reader.classList.contains('focus-reader'), 'focus entry');
      assert(element('play-label').textContent === 'Пауза', 'Entering focus paused or reset playback');
      reader.querySelector('.focus-exit').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until(() => !reader.classList.contains('focus-reader'), 'Escape exit');
      assert(element('play-label').textContent === 'Пауза', 'Exiting focus changed playback state');
      element('play-button').click();
      assert(Math.abs(w.scrollY - beforeScroll) <= 1, 'Background scroll was not restored');
      assert(w.getComputedStyle(d.body).position !== 'fixed', 'Body stayed locked');
      input('speed', saved.speed);
    });

    await record('Simulated native fullscreen exit cleans up the compact shell', async () => {
      let nativeElement = null;
      const restoreElement = replaceProperty(d, 'fullscreenElement', { get: () => nativeElement });
      const restoreExit = replaceProperty(d, 'exitFullscreen', { value: async () => { nativeElement = null; d.dispatchEvent(new w.Event('fullscreenchange')); } });
      const restoreRequest = replaceProperty(reader, 'requestFullscreen', { value: async () => { nativeElement = reader; d.dispatchEvent(new w.Event('fullscreenchange')); } });
      try {
        trigger.click();
        await until(() => nativeElement === reader, 'simulated native entry');
        nativeElement = null;
        d.dispatchEvent(new w.Event('fullscreenchange'));
        assert(!reader.classList.contains('focus-reader'), 'Native exit left a fallback shell open');
        assert(w.getComputedStyle(d.body).position !== 'fixed', 'Native exit left the background locked');
      } finally { restoreRequest(); restoreExit(); restoreElement(); await leave(); }
    });

    await record('A late fullscreen request cannot reopen an already closed reader', async () => {
      let nativeElement = null;
      let finishRequest;
      const restoreElement = replaceProperty(d, 'fullscreenElement', { get: () => nativeElement });
      const restoreExit = replaceProperty(d, 'exitFullscreen', { value: async () => { nativeElement = null; d.dispatchEvent(new w.Event('fullscreenchange')); } });
      const restoreRequest = replaceProperty(reader, 'requestFullscreen', { value: () => new Promise((resolve) => { finishRequest = () => { nativeElement = reader; d.dispatchEvent(new w.Event('fullscreenchange')); resolve(); }; }) });
      try {
        trigger.click();
        await until(() => typeof finishRequest === 'function', 'pending native request');
        await leave();
        finishRequest();
        await delay(30);
        assert(nativeElement === null && !reader.classList.contains('focus-reader'), 'A late request reopened fullscreen');
        assert(w.getComputedStyle(d.body).position !== 'fixed', 'A late request relocked the background');
      } finally { restoreRequest(); restoreExit(); restoreElement(); await leave(); }
    });
  } finally {
    await leave();
    for (const restore of restorers.reverse()) restore();
    if (element('play-label').textContent === 'Пауза') element('play-button').click();
    input('speed', saved.speed);
    input('progress', saved.position);
    frame.style.width = saved.width;
    frame.style.height = saved.height;
    if (saved.playing) element('play-button').click();
  }
}
