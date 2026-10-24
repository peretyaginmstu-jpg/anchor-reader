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
  const candidateControl = dialog.querySelector('.comfort-candidate');
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
  const close = () => { if (dialog.open) el('comfort-dismiss').click(); };
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
  const viewport = () => {
    const visual = w.visualViewport;
    const left = visual?.offsetLeft || 0;
    const top = visual?.offsetTop || 0;
    const width = visual?.width || w.innerWidth;
    const height = visual?.height || w.innerHeight;
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  const visibleTarget = (id) => {
    const target = el(id);
    const r = target.getBoundingClientRect();
    const visible = viewport();
    assert(r.width >= 43.5 && r.height >= 43.5, `${id} is smaller than a 44px target`);
    assert(r.left >= visible.left - 1 && r.right <= visible.right + 1 && r.top >= visible.top - 1 && r.bottom <= visible.bottom + 1, `${id} is outside the visible viewport`);
    const hit = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    assert(hit === target || target.contains(hit), `${id} is covered at its touch center`);
    return r;
  };
  const assertMobilePhase = (expectedPhase) => {
    assert(phase() === expectedPhase, `Expected ${expectedPhase}, received ${phase()}`);
    const visible = viewport();
    assert(visible.width <= 600 || (visible.width <= 1000 && visible.height <= 600), 'Geometry scenario must use a mobile viewport');
    const bounds = dialog.getBoundingClientRect();
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      assert(Math.abs(bounds[edge] - visible[edge]) <= 1, `${expectedPhase}: dialog ${edge} does not fill the visible viewport`);
    }
    assert(dialog.scrollWidth <= dialog.clientWidth + 1, `${expectedPhase}: dialog has horizontal overflow`);
    const footer = dialog.querySelector('.comfort-footer');
    const footerBounds = footer.getBoundingClientRect();
    assert(Math.abs(footerBounds.bottom - visible.bottom) <= 1, `${expectedPhase}: actions are not anchored to the screen bottom`);
    assert(footerBounds.top >= visible.top - 1, `${expectedPhase}: footer exceeds the visible viewport`);
    assert(d.querySelectorAll('#comfort-dismiss').length === 1, 'Return-to-book action was duplicated');
    assert(d.querySelectorAll('.comfort-candidate').length === 1 && dialog.querySelector('.comfort-candidate') === candidateControl, 'Candidate controls were cloned or replaced');
    assert(footer.contains(candidateControl), `${expectedPhase}: mobile candidate controls are not in the footer`);
    if (expectedPhase !== 'confirm') {
      const candidateBounds = candidateControl.getBoundingClientRect();
      assert(candidateBounds.width === 0 || candidateBounds.height === 0, `${expectedPhase}: inactive candidate controls still occupy the footer`);
    }
    const actions = {
      intro: ['comfort-start', 'comfort-dismiss'],
      ramp: ['comfort-too-fast', 'comfort-toggle', 'comfort-dismiss'],
      confirm: ['comfort-candidate-down', 'comfort-candidate-up', 'comfort-check', 'comfort-dismiss'],
      trial: ['comfort-slower', 'comfort-toggle', 'comfort-dismiss'],
      result: ['comfort-apply', 'comfort-adjust', 'comfort-dismiss'],
    }[expectedPhase];
    const targets = actions.map((id) => {
      assert(footer.contains(el(id)), `${expectedPhase}: ${id} is not in the bottom footer`);
      return { id, bounds: visibleTarget(id) };
    });
    for (let first = 0; first < targets.length; first += 1) {
      for (let second = first + 1; second < targets.length; second += 1) {
        const a = targets[first];
        const b = targets[second];
        const overlapX = Math.min(a.bounds.right, b.bounds.right) - Math.max(a.bounds.left, b.bounds.left);
        const overlapY = Math.min(a.bounds.bottom, b.bounds.bottom) - Math.max(a.bounds.top, b.bounds.top);
        assert(overlapX <= 0.5 || overlapY <= 0.5, `${expectedPhase}: ${a.id} overlaps ${b.id}`);
      }
    }
    unchangedBook();
    unchangedSpeed();
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

    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [568, 320]]) {
      await scenario(`Every comfort phase fills ${width}×${height} with distinct 44px bottom actions`, async (clock) => {
        await resize(width, height);
        await open();
        assertMobilePhase('intro');
        start();
        await delay(30);
        assertMobilePhase('ramp');
        for (let word = 0; word < 24; word += 1) { assertWordFit(); clock.run(1); }
        el('comfort-too-fast').click();
        assertMobilePhase('confirm');
        el('comfort-check').click();
        await delay(30);
        assertMobilePhase('trial');
        assertWordFit();
        clock.run(24);
        assertMobilePhase('result');
        el('comfort-dismiss').click();
        assert(!dialog.open && clock.pending() === 0, 'Leaving the result did not cancel the exercise');
        unchangedBook();
        unchangedSpeed();
      });
    }

    await scenario('The bottom return action cancels every comfort phase without applying its candidate', async (clock) => {
      await resize(390, 844);
      w.scrollTo(0, 160);
      await delay(0);
      const sourceScroll = { x: w.scrollX, y: w.scrollY };
      for (const targetPhase of ['intro', 'ramp', 'confirm', 'trial', 'result']) {
        await open();
        if (targetPhase !== 'intro') start();
        if (['confirm', 'trial', 'result'].includes(targetPhase)) {
          clock.run(12);
          el('comfort-too-fast').click();
        }
        if (['trial', 'result'].includes(targetPhase)) el('comfort-check').click();
        if (targetPhase === 'result') clock.run(24);
        assertMobilePhase(targetPhase);
        el('comfort-dismiss').click();
        assert(!dialog.open, `${targetPhase}: lower cancel action did not close the exercise`);
        assert(clock.pending() === 0, `${targetPhase}: cancellation left a running timer`);
        await delay(0);
        assert(Math.abs(w.scrollX - sourceScroll.x) <= 1 && Math.abs(w.scrollY - sourceScroll.y) <= 1, `${targetPhase}: cancellation did not restore the book page scroll`);
        clock.advance(3000);
        unchangedBook();
        unchangedSpeed();
        assert(!['Пауза', 'Отменить'].includes(el('play-label').textContent), `${targetPhase}: cancelling autoplayed the book`);
      }
    });

    await scenario('Rotating and reducing the viewport during the ramp preserves the word, pace and bottom controls', async (clock) => {
      await resize(390, 844);
      await open();
      start();
      clock.run(13);
      const currentWord = el('comfort-word-line').getAttribute('aria-label');
      for (const [width, height] of [[844, 390], [320, 568], [390, 844], [390, 650]]) {
        await resize(width, height);
        assertMobilePhase('ramp');
        assertWordFit();
        assert(index() === 13 && speed() === 175, 'Viewport changes skipped a word or changed the ramp step');
        assert(el('comfort-word-line').getAttribute('aria-label') === currentWord, 'Viewport changes replaced the current word');
        assert(dialog.dataset.playing === 'true' && clock.pending() === 1, 'Viewport changes stopped or duplicated the reading timer');
      }
      clock.run(1);
      assert(index() === 14 && speed() === 175, 'The first callback after rotation did not advance exactly one word');
      await resize(1200, 800);
      assert(dialog.querySelector('.comfort-body').contains(candidateControl), 'Desktop resize did not restore the original candidate controls to the body');
      assert(d.querySelectorAll('.comfort-candidate').length === 1, 'Desktop resize duplicated candidate controls');
      visibleTarget('comfort-close');
      assert(index() === 14 && speed() === 175 && clock.pending() === 1, 'Desktop resize changed playback state');
      unchangedBook();
      unchangedSpeed();
    });

    await scenario('Simulated visual viewport offsets keep the fullscreen exercise and its controls in the visible area', async (clock) => {
      await resize(390, 650);
      await open();
      start();
      clock.run(13);
      const visual = w.visualViewport;
      assert(visual, 'VisualViewport is unavailable in this browser test environment');
      const dimensions = { width: 360, height: 560, offsetLeft: 14, offsetTop: 36 };
      const restorers = [];
      try {
        for (const key of Object.keys(dimensions)) {
          restorers.push(replaceProperty(visual, key, { get: () => dimensions[key] }));
        }
        const syncViewport = async (type) => {
          visual.dispatchEvent(new w.Event(type));
          await delay(40);
          assertMobilePhase('ramp');
          assertWordFit();
          assert(index() === 13 && speed() === 175, 'A visual viewport event advanced the reading position or pace');
          assert(dialog.dataset.playing === 'true' && clock.pending() === 1, 'A visual viewport event replaced or duplicated playback');
        };
        await syncViewport('resize');
        dimensions.offsetLeft = 20;
        dimensions.offsetTop = 58;
        await syncViewport('scroll');
        dimensions.width = 330;
        dimensions.height = 490;
        dimensions.offsetLeft = 28;
        dimensions.offsetTop = 80;
        await syncViewport('resize');
      } finally {
        restorers.reverse().forEach((restore) => restore());
        visual.dispatchEvent(new w.Event('resize'));
        visual.dispatchEvent(new w.Event('scroll'));
        await delay(40);
      }
      assertMobilePhase('ramp');
      assertWordFit();
      clock.run(1);
      assert(index() === 14 && speed() === 175, 'Restoring the viewport skipped a word');
    });

    for (const [width, height] of [[195, 420], [240, 400]]) {
      await scenario(`Every comfort phase remains usable in a simulated ${width}×${height} visual viewport`, async (clock) => {
        await resize(390, 844);
        const visual = w.visualViewport;
        assert(visual, 'VisualViewport is unavailable in this browser test environment');
        const dimensions = { width, height, offsetLeft: 0, offsetTop: 0 };
        const restorers = [];
        try {
          for (const [key, value] of Object.entries(dimensions)) {
            restorers.push(replaceProperty(visual, key, { get: () => value }));
          }
          await open();
          visual.dispatchEvent(new w.Event('resize'));
          await delay(40);
          assertMobilePhase('intro');
          start();
          await delay(30);
          assertMobilePhase('ramp');
          for (let word = 0; word < 12; word += 1) { assertWordFit(); clock.run(1); }
          el('comfort-too-fast').click();
          assertMobilePhase('confirm');
          const originalCandidate = candidate();
          el('comfort-candidate-up').click();
          assert(candidate() === originalCandidate + 25, 'Narrow candidate increment did not work');
          el('comfort-candidate-down').click();
          assert(candidate() === originalCandidate, 'Narrow candidate decrement did not work');
          assertMobilePhase('confirm');
          el('comfort-check').click();
          await delay(30);
          assertMobilePhase('trial');
          for (let word = 0; word < 24; word += 1) { assertWordFit(); clock.run(1); }
          assertMobilePhase('result');
          el('comfort-dismiss').click();
          assert(!dialog.open && clock.pending() === 0, 'Narrow viewport dismissal did not stop the exercise');
          unchangedBook();
          unchangedSpeed();
        } finally {
          close();
          restorers.reverse().forEach((restore) => restore());
          visual.dispatchEvent(new w.Event('resize'));
          visual.dispatchEvent(new w.Event('scroll'));
          await delay(40);
        }
      });
    }

    await scenario('Exiting simulated native reading fullscreen under the comfort dialog restores page styles and scroll after dismissal', async (clock) => {
      await resize(390, 844);
      const reader = el('reader');
      assert(!reader.classList.contains('focus-reader'), 'Native lock scenario requires a closed reading fullscreen');
      w.scrollTo(0, 160);
      await delay(30);
      const before = {
        x: w.scrollX,
        y: w.scrollY,
        body: d.body.style.cssText,
        root: d.documentElement.style.cssText,
      };
      const styles = (node) => JSON.stringify(Array.from(node.style).sort().map((property) => [property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]));
      const originalBodyStyles = styles(d.body);
      const originalRootStyles = styles(d.documentElement);
      const restorers = [];
      let nativeElement = null;
      try {
        restorers.push(replaceProperty(d, 'fullscreenEnabled', { get: () => true }));
        restorers.push(replaceProperty(d, 'fullscreenElement', { get: () => nativeElement }));
        restorers.push(replaceProperty(d, 'exitFullscreen', { value: async () => {
          nativeElement = null;
          d.dispatchEvent(new w.Event('fullscreenchange'));
        } }));
        restorers.push(replaceProperty(reader, 'requestFullscreen', { value: async () => {
          nativeElement = reader;
          d.dispatchEvent(new w.Event('fullscreenchange'));
        } }));
        el('fullscreen-button').focus({ preventScroll: true });
        el('fullscreen-button').click();
        await delay(30);
        assert(nativeElement === reader && reader.classList.contains('focus-reader'), 'Simulated native reading fullscreen did not open');
        const focusedBodyStyles = styles(d.body);
        const focusedRootStyles = styles(d.documentElement);
        reader.querySelector('.focus-speed-label').click();
        assert(el('rhythm-dialog').open, 'Reading fullscreen did not open its settings');
        await open();
        assert(styles(d.body) === focusedBodyStyles && styles(d.documentElement) === focusedRootStyles, 'Comfort overwrote the background lock already owned by reading fullscreen');
        start();
        clock.run(13);
        nativeElement = null;
        d.dispatchEvent(new w.Event('fullscreenchange'));
        await delay(30); // The comfort dialog acquires its lock in a frame after all native event listeners.
        assert(!reader.classList.contains('focus-reader') && !reader.classList.contains('focus-mode'), 'Native exit left the reading fullscreen active');
        assert(dialog.open && w.getComputedStyle(d.body).position === 'fixed', 'The open comfort dialog lost its background lock after native exit');
        assertMobilePhase('ramp');
        assertWordFit();
        assert(index() === 13 && speed() === 175 && clock.pending() === 1, 'Native exit changed the exercise playback state');
        el('comfort-dismiss').click();
        await delay(0);
        assert(!dialog.open && clock.pending() === 0, 'Dismissal after native exit left the exercise running');
        assert(styles(d.body) === originalBodyStyles, 'The body retained fullscreen lock styles after both views closed');
        assert(styles(d.documentElement) === originalRootStyles, 'The root retained fullscreen lock styles after both views closed');
        assert(Math.abs(w.scrollX - before.x) <= 1 && Math.abs(w.scrollY - before.y) <= 1, 'The original page scroll was not restored after both views closed');
        unchangedBook();
        unchangedSpeed();
      } finally {
        close();
        if (reader.classList.contains('focus-reader')) reader.querySelector('.focus-exit').click();
        await delay(0);
        nativeElement = null;
        d.dispatchEvent(new w.Event('fullscreenchange'));
        await delay(0);
        restorers.reverse().forEach((restore) => restore());
        d.body.style.cssText = before.body;
        d.documentElement.style.cssText = before.root;
        w.scrollTo(before.x, before.y);
      }
    });
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
