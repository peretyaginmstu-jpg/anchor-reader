const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function until(predicate, label) {
  const deadline = performance.now() + 6000;
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

/** Mobile regressions against the existing QA book; no reloads or replacement books. */
export async function runMobileTests({ frame, record }) {
  const d = frame.contentDocument;
  const w = frame.contentWindow;
  const el = (id) => d.getElementById(id);
  const reader = el('reader');
  const context = el('context-dialog');
  const rhythm = el('rhythm-dialog');
  const saved = {
    width: frame.style.width, height: frame.style.height,
    speed: el('speed').value, position: el('progress').value,
    title: el('book-title').textContent,
    playing: ['Пауза', 'Отменить'].includes(el('play-label').textContent),
    textMode: el('text-mode').getAttribute('aria-pressed') === 'true',
    scrollX: w.scrollX, scrollY: w.scrollY,
  };
  const input = (id, value) => { el(id).value = String(value); el(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  const pause = () => { if (['Пауза', 'Отменить'].includes(el('play-label').textContent)) el('play-button').click(); };
  const closeDialogs = () => {
    if (context.open) el('context-dismiss').click();
    if (rhythm.open) el('rhythm-done').click();
  };
  const leaveFocus = async () => {
    closeDialogs();
    if (reader.classList.contains('focus-reader')) reader.querySelector('.focus-exit').click();
    await until(() => !reader.classList.contains('focus-reader'), 'leave focus mode');
  };
  const resize = async (width, height) => {
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    await until(() => w.innerWidth === width && w.innerHeight === height, 'iframe viewport resize');
    await delay(60);
  };
  const name = (target) => target.id || target.className || target.tagName;
  const touchTarget = (target) => {
    assert(target, 'Expected control is missing');
    const r = target.getBoundingClientRect();
    assert(r.width >= 43.5 && r.height >= 43.5, `${name(target)} has a touch target smaller than 44px (${Math.round(r.width)}×${Math.round(r.height)})`);
    return r;
  };
  const within = (rect, bounds, label) => assert(rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1, `${label} lies outside its visible area`);
  const viewport = () => ({ left: 0, top: 0, right: w.innerWidth, bottom: w.innerHeight });
  const receivesCenterHit = (target) => {
    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const hit = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === target || target.contains(hit);
  };
  const hitTarget = (target) => {
    const r = touchTarget(target);
    within(r, viewport(), name(target));
    assert(receivesCenterHit(target), `${name(target)} is covered at its touch center`);
  };
  const noOverlap = (targets) => {
    for (let a = 0; a < targets.length; a += 1) {
      const ar = targets[a].getBoundingClientRect();
      for (let b = a + 1; b < targets.length; b += 1) {
        const br = targets[b].getBoundingClientRect();
        const width = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
        const height = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
        assert(width <= 1 || height <= 1, `${name(targets[a])} overlaps ${name(targets[b])}`);
      }
    }
  };
  const unchanged = (position) => {
    assert(el('progress').value === String(position), 'Layout changed the reading position');
    assert(el('book-title').textContent === saved.title, 'Layout changed the current book');
  };
  const focusControls = () => ['#previous-button', '#play-button', '#next-button', '#rewind-button', '.focus-context', '.focus-exit', '.focus-speed-down', '.focus-speed-label', '.focus-speed-up'].map((selector) => reader.querySelector(selector));
  const assertFocus = (position, testHits = true) => {
    unchanged(position);
    const bounds = reader.getBoundingClientRect();
    const anchor = el('word-anchor').getBoundingClientRect();
    const line = el('word-line').getBoundingClientRect();
    assert(Math.abs(anchor.left + anchor.width / 2 - bounds.left - bounds.width / 2) <= 1, 'Anchor moved horizontally after a viewport change');
    assert(Math.abs(line.top + line.height / 2 - bounds.top - bounds.height / 2) <= 1, 'Word moved vertically after a viewport change');
    const controls = focusControls();
    for (const target of controls) {
      within(touchTarget(target), bounds, name(target));
      if (testHits) hitTarget(target);
    }
    noOverlap(controls);
    const utility = reader.querySelector('.focus-utility');
    const short = bounds.height <= 450;
    assert(utility.parentElement === reader.querySelector(short ? '.focus-header' : '.reading-bottom'), 'Utility controls did not follow the current viewport');
    if (!short) assert(utility.getBoundingClientRect().top >= reader.querySelector('.focus-speedbar').getBoundingClientRect().bottom - 1, 'Portrait utility controls are not below the speed controls');
    assert(d.querySelectorAll('#rewind-button').length === 1 && d.querySelectorAll('.focus-context').length === 1 && d.querySelectorAll('.focus-exit').length === 1, 'Responsive layout duplicated an action');
    assert(w.getComputedStyle(d.body).position === 'fixed', 'Focus mode lost its background scroll lock');
  };
  const contextFooter = () => {
    const footer = context.querySelector('.context-footer');
    assert(footer, 'Context footer is missing');
    within(context.getBoundingClientRect(), viewport(), 'Context dialog');
    assert(context.scrollWidth <= context.clientWidth + 1, 'Context dialog has horizontal overflow');
    const controls = ['context-previous', 'context-next', 'context-dismiss', 'continue-button'].map(el);
    for (const target of controls) hitTarget(target);
    noOverlap(controls);
    return footer.getBoundingClientRect();
  };
  const enterFocus = async () => {
    closeDialogs();
    el('fullscreen-button').focus({ preventScroll: true });
    el('fullscreen-button').click();
    await until(() => reader.classList.contains('focus-reader'), 'enter focus fallback');
    await delay(40);
  };
  const scenario = (label, run) => record(label, async () => {
    pause();
    await leaveFocus();
    try { await run(); }
    finally {
      // A failed assertion must not leave a modal or running reader behind for
      // the next independent scenario, which would turn one failure into many.
      pause();
      await leaveFocus();
    }
  });

  pause();
  const restoreFullscreen = replaceProperty(d, 'fullscreenEnabled', { get: () => false });
  try {
    for (const [width, height] of [[320, 568], [390, 844]]) {
      await scenario(`Normal reader at ${width}px has distinct 44px controls and reachable range targets`, async () => {
        await leaveFocus();
        await resize(width, height);
        el('word-mode').click();
        const actions = reader.querySelector('.reader-actions');
        assert(actions?.parentElement === reader.querySelector('.transport-row'), 'Mobile actions are not beside the transport');
        for (const id of ['fullscreen-button', 'context-button', 'sentence-button']) assert(el(id).parentElement === actions && d.querySelectorAll(`#${id}`).length === 1, `${id} was duplicated or left in its desktop location`);
        assert(actions.getBoundingClientRect().top >= reader.querySelector('.transport').getBoundingClientRect().bottom - 1, 'Mobile actions overlap the main transport');
        const targets = [
          ...['rewind-button', 'previous-button', 'play-button', 'next-button', 'fullscreen-button', 'context-button', 'sentence-button', 'word-mode', 'text-mode', 'font-smaller', 'font-larger', 'speed', 'progress', 'smart-settings-button'].map(el),
          reader.querySelector('.smart-control'),
        ];
        targets.forEach(touchTarget);
        noOverlap(targets);
        assert(d.documentElement.scrollWidth <= w.innerWidth + 1, 'Normal reader has horizontal overflow');
        for (const target of targets) {
          target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          hitTarget(target);
        }
        unchanged(saved.position);
      });
    }

    await scenario('Returning to desktop restores the original controls without duplicates', async () => {
      await resize(1000, 844);
      assert(el('fullscreen-button').parentElement.classList.contains('book-tools'), 'Fullscreen button did not return to the toolbar');
      for (const id of ['context-button', 'sentence-button']) assert(el(id).parentElement === reader.querySelector('.transport-row'), `${id} did not return to the desktop transport row`);
      for (const id of ['fullscreen-button', 'context-button', 'sentence-button', 'rewind-button']) assert(d.querySelectorAll(`#${id}`).length === 1, `${id} was duplicated`);
      unchanged(saved.position);
    });

    await scenario('Context footer remains visible while scrolling; dismiss stays paused and continue is explicit', async () => {
      await resize(320, 568);
      input('speed', 100);
      input('progress', 15);
      el('play-button').click();
      assert(el('play-label').textContent === 'Пауза', 'Reading did not start before opening context');
      el('context-button').click();
      assert(context.open && el('play-label').textContent !== 'Пауза', 'Opening context failed to pause');
      const before = contextFooter();
      const scroller = el('context-paragraph');
      assert(scroller.scrollHeight > scroller.clientHeight, 'QA text does not exercise context scrolling');
      scroller.scrollTop = scroller.scrollHeight;
      const after = contextFooter();
      assert(scroller.scrollTop > 0 && Math.abs(before.top - after.top) <= 1, 'Context actions moved with the text');
      assert(context.scrollTop === 0, 'The entire dialog scrolled instead of its text');
      const next = scroller.querySelector('.context-word.current').nextElementSibling;
      assert(next?.classList.contains('context-word'), 'The next selectable word is missing');
      next.click();
      assert(el('progress').value === '16' && context.open && el('play-label').textContent !== 'Пауза', 'Selecting a word did not stay paused in context');
      contextFooter();
      el('context-dismiss').click();
      assert(!context.open, 'Bottom dismiss did not close context');
      await delay(160);
      assert(el('progress').value === '16' && !['Пауза', 'Отменить'].includes(el('play-label').textContent), 'Dismissing context resumed reading');
      el('context-button').click();
      el('continue-button').click();
      assert(!context.open && el('play-label').textContent === 'Пауза', 'Explicit continue did not resume reading');
      pause();
    });

    for (const [width, height] of [[390, 844], [320, 568]]) {
      await scenario(`Rhythm sheet at ${width}px keeps Done at the bottom and Reset inside advanced settings`, async () => {
        pause();
        closeDialogs();
        await resize(width, height);
        el('smart-settings-button').click();
        assert(rhythm.open, 'Rhythm sheet did not open');
        const bounds = rhythm.getBoundingClientRect();
        within(bounds, viewport(), 'Rhythm sheet');
        assert(bounds.height <= Math.min(660, height - 16) + 1, 'Default rhythm sheet exceeds its compact height');
        // Some engines retain layout rectangles for descendants of closed details.
        // Their availability for a real pointer hit is the relevant distinction.
        assert(!el('rhythm-advanced').open && !receivesCenterHit(el('rhythm-reset')), 'Reset is exposed as a primary action');
        assert(el('rhythm-reset').closest('#rhythm-advanced') && !el('rhythm-reset').closest('.rhythm-footer'), 'Reset is not in advanced settings');
        const footer = rhythm.querySelector('.rhythm-footer');
        assert(footer.querySelectorAll('button').length === 1 && footer.contains(el('rhythm-done')), 'Rhythm footer has competing actions');
        hitTarget(el('rhythm-done'));
        const done = el('rhythm-done').getBoundingClientRect();
        assert(done.height >= 47.5 && done.top >= bounds.top + bounds.height / 2, 'Done is not a large lower action');
        el('rhythm-advanced').querySelector('summary').click();
        el('rhythm-reset').scrollIntoView({ block: 'end', behavior: 'instant' });
        hitTarget(el('rhythm-reset'));
        hitTarget(el('rhythm-done'));
        el('rhythm-done').click();
      });
    }

    await scenario('Open portrait focus adapts to a shorter viewport without moving the word or hiding lower actions', async () => {
      pause();
      await resize(390, 844);
      input('progress', 15);
      await enterFocus();
      assert(d.activeElement === el('play-button'), 'Focus entry did not select the main reading control');
      assertFocus(15);
      await resize(390, 568);
      assertFocus(15);
      const play = el('play-button').getBoundingClientRect();
      const bounds = reader.getBoundingClientRect();
      assert(Math.abs(play.left + play.width / 2 - bounds.left - bounds.width / 2) <= 1, 'Mobile Play is not centered');
      await leaveFocus();
      assert(el('rewind-button').parentElement === reader.querySelector('.transport'), 'Rewind did not return after leaving focus');
    });

    await scenario('Rotating focus with context or rhythm open preserves the book, position and dialog actions', async () => {
      pause();
      for (const kind of ['context', 'rhythm']) {
        await leaveFocus();
        await resize(390, 844);
        input('progress', 15);
        await enterFocus();
        reader.querySelector(kind === 'context' ? '.focus-context' : '.focus-speed-label').click();
        const dialog = kind === 'context' ? context : rhythm;
        assert(dialog.open, `${kind} dialog did not open in focus`);
        for (const [width, height] of [[844, 390], [320, 568]]) {
          await resize(width, height);
          assert(dialog.open && !dialog.inert, `${kind} dialog closed or became inert on rotation`);
          assertFocus(15, false);
          within(dialog.getBoundingClientRect(), viewport(), `${kind} dialog after rotation`);
          if (kind === 'context') contextFooter();
          else hitTarget(el('rhythm-done'));
        }
        closeDialogs();
        assertFocus(15);
        assert(!['Пауза', 'Отменить'].includes(el('play-label').textContent), 'Rotation or closing the dialog resumed reading');
        await leaveFocus();
      }
    });

    await scenario('Simulated narrow visual viewports retain focus controls and anchor alignment', async () => {
      pause();
      await resize(390, 844);
      input('progress', 15);
      await enterFocus();
      const originalViewport = w.visualViewport;
      let mockViewport = originalViewport;
      const restoreViewport = replaceProperty(w, 'visualViewport', { get: () => mockViewport });
      try {
        for (const [width, height] of [[195, 420], [240, 400]]) {
          mockViewport = { width, height, offsetLeft: 0, offsetTop: 0 };
          w.dispatchEvent(new w.Event('resize'));
          await until(() => Math.abs(reader.getBoundingClientRect().width - width) <= 1, 'simulated visual viewport width');
          await delay(40);
          const bounds = reader.getBoundingClientRect();
          assert(Math.abs(bounds.height - height) <= 1, 'Focus height ignored the simulated visual viewport');
          assertFocus(15);
        }
      } finally {
        restoreViewport();
        w.dispatchEvent(new w.Event('resize'));
        await delay(60);
        await leaveFocus();
      }
    });
  } finally {
    pause();
    await leaveFocus();
    restoreFullscreen();
    input('speed', saved.speed);
    input('progress', saved.position);
    frame.style.width = saved.width;
    frame.style.height = saved.height;
    await delay(60);
    if (saved.textMode) el('text-mode').click();
    else el('word-mode').click();
    w.scrollTo(saved.scrollX, saved.scrollY);
    if (saved.playing) el('play-button').click();
  }
}
