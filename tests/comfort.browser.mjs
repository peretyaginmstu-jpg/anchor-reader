const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function replaceProperty(object, name, descriptor) {
  const previous = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
  return () => {
    if (previous) Object.defineProperty(object, name, previous);
    else delete object[name];
  };
}

/** The app iframe's RSVP timers advance deterministically; parent test waits stay real. */
function fakeClock(view) {
  let now = 0;
  let serial = 0;
  const jobs = new Map();
  const nativeClear = view.clearTimeout.bind(view);
  const restorers = [
    replaceProperty(view.performance, 'now', { value: () => now }),
    replaceProperty(view, 'setTimeout', { value: (callback, milliseconds = 0, ...args) => {
      const id = --serial;
      jobs.set(id, { at: now + Math.max(0, Number(milliseconds) || 0), callback: () => callback(...args) });
      return id;
    } }),
    replaceProperty(view, 'clearTimeout', { value: (id) => {
      if (jobs.has(id)) jobs.delete(id);
      else if (id >= 0) nativeClear(id);
    } }),
  ];
  const earliest = () => [...jobs.entries()].reduce((first, job) => !first || job[1].at < first[1].at ? job : first, null);
  const next = () => {
    const job = earliest();
    if (!job) return false;
    jobs.delete(job[0]);
    now = job[1].at;
    job[1].callback();
    return true;
  };
  return {
    next,
    run(count) { for (let index = 0; index < count; index += 1) assert(next(), `No timer for word ${index + 1} of ${count}`); },
    advance(milliseconds) {
      const end = now + milliseconds;
      let runs = 0;
      while (earliest()?.[1].at <= end) {
        assert(++runs < 2000, 'Runaway timer loop');
        next();
      }
      now = end;
    },
    pending: () => jobs.size,
    restore() { jobs.clear(); restorers.reverse().forEach((restore) => restore()); },
  };
}

/** Isolated comfort exercise; the selected book and reader settings are restored. */
export async function runComfortTests({ frame, record }) {
  const d = frame.contentDocument;
  const w = frame.contentWindow;
  const el = (id) => d.getElementById(id);
  const dialog = el('comfort-dialog');
  assert(dialog, 'Comfort exercise is not initialized');
  const saved = {
    speed: el('speed').value,
    position: el('progress').value,
    title: el('book-title').textContent,
    width: frame.style.width,
    height: frame.style.height,
    playing: ['Пауза', 'Отменить'].includes(el('play-label').textContent),
    textMode: el('text-mode').getAttribute('aria-pressed') === 'true',
    scrollX: w.scrollX,
    scrollY: w.scrollY,
  };
  const input = (id, value) => { el(id).value = String(value); el(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  const phase = () => dialog.dataset.phase;
  const speed = () => Number(el('comfort-speed-value').textContent);
  const candidate = () => Number(el('comfort-candidate-value').textContent);
  const index = () => Number(el('comfort-word-line').dataset.index);
  const pauseMain = () => { if (['Пауза', 'Отменить'].includes(el('play-label').textContent)) el('play-button').click(); };
  const close = () => { if (dialog.open) el('comfort-close').click(); };
  const unchangedBook = () => {
    assert(el('book-title').textContent === saved.title, 'The exercise changed the selected book');
    assert(el('progress').value === saved.position, 'The exercise moved the book position');
  };
  const unchangedSpeed = () => assert(el('speed').value === saved.speed, 'The exercise applied a speed without confirmation');
  const open = async () => {
    close();
    await delay(0); // Let native dialog close events finish before the next opening.
    if (!el('rhythm-dialog').open) el('smart-settings-button').click();
    if (!el('rhythm-tempo').open) el('rhythm-tempo').querySelector('summary').click();
    el('comfort-button').focus({ preventScroll: true });
    el('comfort-button').click();
    assert(dialog.open && phase() === 'intro', 'Comfort exercise did not open at its introduction');
    assert(el('play-label').textContent !== 'Пауза', 'Opening the exercise did not pause the main reader');
  };
  const start = () => {
    el('comfort-start').click();
    assert(phase() === 'ramp' && dialog.dataset.playing === 'true', 'The introductory ramp did not start');
    assert(speed() === 150 && index() === 0, 'Every new ramp must begin at 150 on its first word');
  };
  const scenario = (name, run) => record(name, async () => {
    pauseMain();
    close();
    if (el('rhythm-dialog').open) el('rhythm-done').click();
    await delay(0);
    const clock = fakeClock(w);
    try { await run(clock); }
    finally {
      try {
        close();
        // Explicit application can create the app's short success toast. Complete
        // that timer too, so restoring native timers cannot leave it stuck open.
        clock.advance(6000);
      } finally { clock.restore(); }
      if (el('rhythm-dialog').open) el('rhythm-done').click();
      await delay(0);
      input('speed', saved.speed);
      input('progress', saved.position);
      pauseMain();
    }
  });
  const resize = async (width, height) => {
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    await delay(70);
    assert(w.innerWidth === width && w.innerHeight === height, 'Comfort test viewport did not resize');
  };
  const visibleTarget = (id) => {
    const target = el(id);
    const r = target.getBoundingClientRect();
    assert(r.width >= 43.5 && r.height >= 43.5, `${id} is smaller than a 44px target`);
    assert(r.left >= -1 && r.right <= w.innerWidth + 1 && r.top >= -1 && r.bottom <= w.innerHeight + 1, `${id} is outside the visible viewport`);
    const hit = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    assert(hit === target || target.contains(hit), `${id} is covered at its touch center`);
  };
  const assertWordFit = () => {
    const line = el('comfort-word-line').getBoundingClientRect();
    const anchor = el('comfort-anchor').getBoundingClientRect();
    const prefix = el('comfort-prefix').getBoundingClientRect();
    const suffix = el('comfort-suffix').getBoundingClientRect();
    assert(line.width > 0 && anchor.width > 0, 'The comfort word is not visible');
    assert(Math.abs(anchor.left + anchor.width / 2 - line.left - line.width / 2) <= 1, 'The comfort anchor moved horizontally');
    assert(prefix.left >= line.left - 1 && suffix.right <= line.right + 1, 'The comfort word is clipped');
  };

  pauseMain();
  try {
    await scenario('Comfort ramp starts at 150, advances after 12 new words, and does not count pause or resume', async (clock) => {
      await open();
      start();
      clock.run(11);
      assert(index() === 11 && speed() === 150, 'Ramp accelerated before 12 completed words');
      el('comfort-toggle').click();
      assert(dialog.dataset.playing === 'false' && el('comfort-toggle').getAttribute('aria-pressed') === 'false', 'Pause state is not announced');
      assert(clock.pending() === 0, 'Pausing left an active reading timer');
      clock.advance(5000);
      assert(index() === 11 && speed() === 150, 'Paused time counted as completed words');
      el('comfort-toggle').click();
      assert(index() === 11 && speed() === 150, 'Resume advanced a word or a speed step');
      clock.run(1);
      assert(index() === 12 && speed() === 175, 'Twelfth completed word did not advance to 175');
      clock.run(12);
      assert(index() === 24 && speed() === 200, 'Twenty-fourth completed word did not advance to 200');
      unchangedBook();
      unchangedSpeed();
      el('comfort-dismiss').click();
      assert(!dialog.open, 'The lower return-to-book action did not close the exercise');
      assert(clock.pending() === 0, 'Closing left a reading timer behind');
      unchangedSpeed();
    });

    await scenario('Feedback proposes one slower step; a 24-word check requires explicit application', async (clock) => {
      await open();
      start();
      clock.run(24);
      el('comfort-too-fast').click();
      assert(phase() === 'confirm' && candidate() === 175 && clock.pending() === 0, 'Feedback did not stop at one slower step');
      el('comfort-candidate-down').click();
      assert(candidate() === 150, 'Candidate decrement is not 25');
      el('comfort-candidate-up').click();
      assert(candidate() === 175, 'Candidate increment is not 25');
      el('comfort-apply').click();
      unchangedSpeed();
      el('comfort-check').click();
      assert(phase() === 'trial' && speed() === 175 && index() === 0, 'Verification did not start at the candidate speed');
      clock.run(23);
      assert(phase() === 'trial' && index() === 23 && el('comfort-apply').disabled, 'Verification finished before all 24 words completed');
      el('comfort-apply').click();
      unchangedSpeed();
      clock.run(1);
      assert(phase() === 'result' && !el('comfort-apply').disabled && clock.pending() === 0, 'Verification did not finish after the full last word');
      unchangedSpeed();
      unchangedBook();
      el('comfort-adjust').click();
      assert(phase() === 'confirm' && candidate() === 175, 'Adjusting the result changed the candidate');
      el('comfort-check').click();
      el('comfort-slower').click();
      assert(phase() === 'confirm' && candidate() === 150, 'Slower feedback during verification did not step back');
      el('comfort-check').click();
      clock.run(24);
      unchangedSpeed();
      el('comfort-apply').click();
      assert(!dialog.open && Number(el('speed').value) === 150, 'Explicit confirmation did not apply the checked speed');
      assert(!['Пауза', 'Отменить'].includes(el('play-label').textContent), 'Applying comfort speed autoplayed the main reader');
      unchangedBook();
    });

    await scenario('Candidate controls clamp to 100–1200 and cancelling never applies them', async (clock) => {
      await open();
      start();
      el('comfort-too-fast').click();
      assert(candidate() === 125, 'Initial feedback must propose 125');
      for (let step = 0; step < 60; step += 1) el('comfort-candidate-down').click();
      assert(candidate() === 100 && el('comfort-candidate-down').disabled, 'Candidate fell below 100');
      for (let step = 0; step < 60; step += 1) el('comfort-candidate-up').click();
      assert(candidate() === 1200 && el('comfort-candidate-up').disabled, 'Candidate exceeded 1200');
      close();
      assert(clock.pending() === 0, 'Cancelling the candidate left a reading timer');
      unchangedSpeed();
      unchangedBook();
    });

    await scenario('Hiding the tab pauses the comfort exercise; reopening resets the ramp', async (clock) => {
      await open();
      start();
      clock.run(13);
      let hidden = true;
      const restoreHidden = replaceProperty(d, 'hidden', { get: () => hidden });
      try {
        d.dispatchEvent(new w.Event('visibilitychange'));
        assert(dialog.dataset.playing === 'false' && clock.pending() === 0, 'Hidden-tab event did not pause comfort playback');
        clock.advance(10000);
        assert(index() === 13 && speed() === 175, 'Hidden-tab delay skipped words');
        hidden = false;
        d.dispatchEvent(new w.Event('visibilitychange'));
        assert(dialog.dataset.playing === 'false', 'Returning to the tab resumed automatically');
        el('comfort-toggle').click();
        clock.run(10);
        assert(index() === 23 && speed() === 175, 'Visibility pause counted an extra word');
        clock.run(1);
        assert(index() === 24 && speed() === 200, 'Resume lost the current speed step');
      } finally { restoreHidden(); }
      close();
      await open();
      start();
      assert(index() === 0 && speed() === 150, 'A reopened exercise retained its old ramp');
      unchangedSpeed();
      unchangedBook();
    });

    await scenario('Reaching the ramp cap requests confirmation without claiming or applying an optimum', async (clock) => {
      await open();
      start();
      clock.run(503);
      assert(phase() === 'ramp' && speed() === 1175, 'Ramp reached its cap too early');
      clock.run(1);
      assert(phase() === 'confirm' && candidate() === 1200 && clock.pending() === 0, 'Cap did not preserve the current candidate for confirmation');
      assert(el('comfort-candidate-note').textContent.includes('верхней границы'), 'Cap is not explained as a trial boundary');
      unchangedSpeed();
      unchangedBook();
    });

    for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
      await scenario(`Comfort exercise fits ${width}×${height}, keeps its anchor fixed and exposes 44px actions`, async (clock) => {
        await resize(width, height);
        await open();
        visibleTarget('comfort-close');
        visibleTarget('comfort-start');
        start();
        await delay(30);
        const bounds = dialog.getBoundingClientRect();
        assert(bounds.left >= -1 && bounds.right <= width + 1 && bounds.top >= -1 && bounds.bottom <= height + 1, 'Comfort dialog extends outside the viewport');
        assert(dialog.scrollWidth <= dialog.clientWidth + 1, 'Comfort dialog has horizontal overflow');
        visibleTarget('comfort-close');
        visibleTarget('comfort-too-fast');
        visibleTarget('comfort-toggle');
        visibleTarget('comfort-dismiss');
        for (let word = 0; word < 24; word += 1) { assertWordFit(); clock.run(1); }
        el('comfort-too-fast').click();
        visibleTarget('comfort-candidate-down');
        visibleTarget('comfort-candidate-up');
        visibleTarget('comfort-check');
        el('comfort-check').click();
        visibleTarget('comfort-slower');
        visibleTarget('comfort-toggle');
        visibleTarget('comfort-dismiss');
        clock.run(24);
        visibleTarget('comfort-apply');
        visibleTarget('comfort-adjust');
        unchangedBook();
        unchangedSpeed();
      });
    }
  } finally {
    close();
    if (el('rhythm-dialog').open) el('rhythm-done').click();
    pauseMain();
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
