const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function until(predicate, label, limit = 8000) {
  const deadline = performance.now() + limit;
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

/** Use the existing two-paragraph QA book; leave the app paused and its original place intact. */
export async function runRhythmTests({ frame, record }) {
  const d = frame.contentDocument;
  const w = frame.contentWindow;
  const element = (id) => d.getElementById(id);
  const reader = element('reader');
  const dialog = element('rhythm-dialog');
  const trigger = element('smart-settings-button');
  const saved = {
    width: frame.style.width,
    height: frame.style.height,
    speed: element('speed').value,
    position: element('progress').value,
    title: element('book-title').textContent,
  };
  const input = (id, value, type = 'input') => {
    element(id).value = String(value);
    element(id).dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  const checked = (id, value) => {
    element(id).checked = value;
    element(id).dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const pause = () => {
    if (['Пауза', 'Отменить'].includes(element('play-label').textContent)) element('play-button').click();
  };
  const open = () => {
    if (!dialog.open) { trigger.focus({ preventScroll: true }); trigger.click(); }
    assert(dialog.open, 'Rhythm settings did not open');
  };
  const close = () => { if (dialog.open) element('rhythm-done').click(); };
  const preset = (id) => dialog.querySelector(`[data-rhythm-preset="${id}"]`);
  const startDelay = (value) => dialog.querySelector(`[data-start-delay="${value}"]`).click();
  const customPause = (kind, value) => {
    input(`rhythm-pause-${kind}`, value);
    input(`rhythm-pause-${kind}`, value, 'change');
  };

  pause();
  try {
    // Each scenario starts from a known rhythm, without replacing the QA book.
    open();
    element('rhythm-reset').click();
    close();

    await record('Opening rhythm settings pauses reading; closing does not autoplay', async () => {
      input('speed', 100);
      input('progress', 0);
      element('play-button').click();
      assert(element('play-label').textContent === 'Пауза', 'Reading did not start');
      open();
      const position = element('progress').value;
      assert(!['Пауза', 'Отменить'].includes(element('play-label').textContent), 'Opening settings did not pause');
      await delay(160);
      assert(element('progress').value === position, 'Position moved while the dialog was open');
      close();
      assert(d.activeElement === trigger, 'Focus did not return to the settings trigger');
      await delay(160);
      assert(element('progress').value === position && element('play-label').textContent !== 'Пауза', 'Closing settings resumed playback');
    });

    await record('Presets and custom pauses update the effective pace and remaining time; both smart switches agree', async () => {
      pause();
      input('speed', 200);
      input('progress', 0);
      open();
      checked('rhythm-smart', true);
      preset('light').click();
      const lightSpeed = element('effective-speed').textContent;
      const lightTime = element('time-remaining').textContent;
      preset('calm').click();
      assert(preset('calm').getAttribute('aria-pressed') === 'true', 'Selected preset is not announced');
      assert(element('effective-speed').textContent !== lightSpeed, 'Preset did not update the effective pace');
      assert(element('time-remaining').textContent !== lightTime, 'Preset did not update remaining time');
      preset('light').click();
      element('rhythm-advanced').querySelector('summary').click();
      customPause('paragraph', 4);
      assert(element('rhythm-summary').textContent.includes('Свой ритм'), 'Custom pauses are still labelled as a preset');
      assert(element('effective-speed').textContent !== lightSpeed, 'Custom range did not update the effective pace');
      assert(element('time-remaining').textContent !== lightTime, 'Custom range did not update remaining time');
      assert(element('rhythm-value-paragraph').textContent.includes('×4'), 'Range output is stale');
      assert(Number(element('rhythm-pause-longWord').value) === 1.1, 'Editing one pause erased another');
      checked('rhythm-smart', false);
      assert(!element('smart').checked && element('rhythm-pause-paragraph').disabled, 'Dialog smart switch did not synchronize');
      assert(element('effective-speed').textContent.includes('Равномерный темп: 200'), 'Disabled smart mode still shows adjusted speed');
      close();
      checked('smart', true);
      open();
      assert(element('rhythm-smart').checked && !element('rhythm-pause-paragraph').disabled, 'Main smart switch did not synchronize');
      assert(Number(element('rhythm-pause-paragraph').value) === 4, 'Toggling smart mode lost custom pauses');
      assert(element('rhythm-summary').textContent.includes('Свой ритм'), 'Custom profile was not restored');
      close();
    });

    await record('Preparation is visible and cancelling it leaves no delayed playback', async () => {
      pause();
      open();
      startDelay(1000);
      input('rhythm-stop', 'none', 'change');
      close();
      input('speed', 100);
      input('progress', 0);
      element('play-button').click();
      assert(!element('preparation-hint').hidden && element('play-label').textContent === 'Отменить', 'Preparation state is not visible');
      assert(element('progress').value === '0', 'Preparation advanced the current word');
      element('play-button').click();
      assert(element('preparation-hint').hidden, 'Cancellation left the preparation hint visible');
      await delay(1200);
      assert(element('progress').value === '0' && !['Пауза', 'Отменить'].includes(element('play-label').textContent), 'A cancelled start timer resumed reading');
    });

    await record('The first word receives its full interval after the preparation delay', async () => {
      pause();
      input('speed', 100);
      input('progress', 0);
      open();
      startDelay(1000);
      close();
      let preparedAt = null;
      let advancedAt = null;
      const observer = new w.MutationObserver(() => {
        if (element('preparation-hint').hidden && preparedAt === null) preparedAt = w.performance.now();
        if (element('progress').value !== '0' && advancedAt === null) advancedAt = w.performance.now();
      });
      observer.observe(reader, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
      try {
        element('play-button').click();
        assert(!element('preparation-hint').hidden, 'Delayed start did not prepare');
        await until(() => advancedAt !== null, 'first word after preparation');
        pause();
        assert(preparedAt !== null, 'Preparation completion was not observed');
        // 100 wpm gives 600 ms. A generous lower bound tolerates frame scheduling,
        // while catching a skipped first word or a countdown that consumes its time.
        assert(advancedAt - preparedAt >= 500, `First word lasted only ${Math.round(advancedAt - preparedAt)} ms after preparation`);
        assert(element('progress').value === '1', 'The first transition skipped a word');
      } finally { observer.disconnect(); pause(); }
    });

    await record('Paragraph auto-stop pauses on the next paragraph and can continue', async () => {
      pause();
      open();
      element('rhythm-reset').click();
      input('rhythm-stop', 'paragraph', 'change');
      close();
      input('speed', 600);
      input('progress', 10);
      element('play-button').click();
      await until(() => element('progress').value === '11' && element('play-label').textContent !== 'Пауза', 'paragraph boundary stop');
      assert(element('effective-speed').textContent.includes('ваши остановки'), 'Manual stops are missing from the tempo explanation');
      await delay(180);
      assert(element('progress').value === '11', 'Auto-stop continued without a user action');
      element('play-button').click();
      await until(() => Number(element('progress').value) > 11, 'continue after paragraph stop');
      pause();
    });

    await record('Resetting rhythm preserves speed, book and reading position', async () => {
      pause();
      input('speed', 450);
      input('progress', 7);
      open();
      preset('calm').click();
      startDelay(2000);
      input('rhythm-stop', 'chapter', 'change');
      checked('rhythm-smart', false);
      element('rhythm-reset').click();
      assert(element('speed').value === '450' && element('progress').value === '7', 'Reset changed speed or position');
      assert(element('book-title').textContent === saved.title, 'Reset changed the current book');
      assert(element('smart').checked && element('rhythm-smart').checked, 'Reset did not restore smart pauses');
      assert(preset('balanced').getAttribute('aria-pressed') === 'true', 'Reset did not restore the balanced profile');
      assert(dialog.querySelector('[data-start-delay="0"]').getAttribute('aria-pressed') === 'true', 'Reset retained the start delay');
      assert(element('rhythm-stop').value === 'none', 'Reset retained an automatic stop');
      close();
    });

    for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
      await record(`Rhythm dialog fits ${width}×${height}, scrolls internally and keeps 44px targets`, async () => {
        close();
        frame.style.width = `${width}px`;
        frame.style.height = `${height}px`;
        await delay(80);
        open();
        element('rhythm-advanced').querySelector('summary').click();
        element('rhythm-tempo').querySelector('summary').click();
        const bounds = dialog.getBoundingClientRect();
        const body = dialog.querySelector('.rhythm-body');
        const footer = dialog.querySelector('.rhythm-footer');
        const footerBefore = footer.getBoundingClientRect();
        assert(bounds.left >= -1 && bounds.right <= w.innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= w.innerHeight + 1, 'Dialog extends beyond the viewport');
        assert(dialog.scrollWidth <= dialog.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1, 'Dialog has horizontal overflow');
        assert(body.clientHeight > 0 && body.scrollHeight > body.clientHeight, 'Expanded settings have no internal scroll area');
        const targets = [...dialog.querySelectorAll('button,select,input[type="range"],summary'), dialog.querySelector('.rhythm-smart-row')];
        for (const target of targets) {
          const rect = target.getBoundingClientRect();
          assert(rect.width >= 43.5 && rect.height >= 43.5, `${target.id || target.className || target.tagName} has a target smaller than 44px`);
        }
        body.scrollTop = body.scrollHeight;
        await delay(30);
        const footerAfter = footer.getBoundingClientRect();
        const bodyBounds = body.getBoundingClientRect();
        const trial = element('calibration-button').getBoundingClientRect();
        assert(body.scrollTop > 0, 'Settings body cannot scroll');
        assert(Math.abs(footerBefore.top - footerAfter.top) <= 1, 'Footer moved with the scrolled content');
        assert(trial.top >= bodyBounds.top - 1 && trial.bottom <= bodyBounds.bottom + 1, 'Last settings control is unreachable by scrolling');
        for (const id of ['rhythm-close', 'rhythm-done']) {
          const rect = element(id).getBoundingClientRect();
          assert(rect.top >= 0 && rect.bottom <= w.innerHeight + 1, `${id} is outside the visible viewport`);
        }
        close();
      });
    }

    await record('Fullscreen fallback speed label opens rhythm settings and receives focus on close', async () => {
      pause();
      close();
      const restore = replaceProperty(d, 'fullscreenEnabled', { get: () => false });
      try {
        element('fullscreen-button').focus({ preventScroll: true });
        element('fullscreen-button').click();
        await until(() => reader.classList.contains('focus-reader'), 'fullscreen fallback');
        const label = reader.querySelector('.focus-speed-label');
        label.focus({ preventScroll: true });
        label.click();
        assert(dialog.open && !dialog.inert, 'Fullscreen settings are unavailable');
        assert(reader.classList.contains('focus-reader'), 'Opening settings exited fullscreen');
        element('rhythm-close').focus();
        assert(d.activeElement === element('rhythm-close'), 'Fullscreen modal cannot receive focus');
        close();
        assert(d.activeElement === label, 'Focus did not return to the fullscreen speed label');
        assert(reader.classList.contains('focus-reader'), 'Closing settings exited fullscreen');
      } finally {
        close();
        if (reader.classList.contains('focus-reader')) reader.querySelector('.focus-exit').click();
        await until(() => !reader.classList.contains('focus-reader'), 'fullscreen cleanup');
        restore();
      }
    });
  } finally {
    pause();
    close();
    if (reader.classList.contains('focus-reader')) reader.querySelector('.focus-exit').click();
    await until(() => !reader.classList.contains('focus-reader'), 'final fullscreen cleanup');
    open();
    element('rhythm-reset').click();
    close();
    input('speed', saved.speed);
    input('progress', saved.position);
    frame.style.width = saved.width;
    frame.style.height = saved.height;
  }
}
