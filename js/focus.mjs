/** Compact fullscreen shell. The existing word renderer, transport and engine stay in use. */
export function setupFocusReader({
  reader = document.getElementById('reader'),
  trigger = document.getElementById('fullscreen-button'),
  readState = () => ({ wpm: 300, title: '' }),
  onSpeedChange = () => {},
  onSettings = () => {},
  onEnter = () => {},
  onChange = () => {},
  preferNative = true,
} = {}) {
  if (!reader || !trigger) throw new Error('Для режима чтения нужны reader и fullscreen-button.');
  const doc = reader.ownerDocument;
  const view = doc.defaultView;
  const bottom = reader.querySelector('.reading-bottom');
  const contextSource = reader.querySelector('#context-button');
  const playButton = reader.querySelector('#play-button');
  const rewindButton = reader.querySelector('#rewind-button');
  const rewindParent = rewindButton?.parentNode;
  const rewindNext = rewindButton?.nextSibling;
  if (!bottom) throw new Error('Не найдены элементы управления чтением.');

  const header = doc.createElement('div');
  header.className = 'focus-header';
  header.innerHTML = '<div class="focus-heading"><span class="focus-caption">РЕЖИМ ЧТЕНИЯ</span><span class="focus-title"></span></div>';
  reader.prepend(header);
  const speedbar = doc.createElement('div');
  speedbar.className = 'focus-speedbar';
  speedbar.setAttribute('role', 'group');
  speedbar.setAttribute('aria-label', 'Темп чтения');
  speedbar.innerHTML = '<button class="focus-speed-down" type="button" aria-label="Читать медленнее на 25 слов в минуту">−</button><button class="focus-speed-label" type="button" aria-label="Настройки умного чтения" aria-haspopup="dialog"><strong class="focus-speed-value">300</strong><span>слов/мин · настройки</span></button><button class="focus-speed-up" type="button" aria-label="Читать быстрее на 25 слов в минуту">+</button>';
  bottom.append(speedbar);
  const utility = doc.createElement('div');
  utility.className = 'focus-utility';
  utility.setAttribute('role', 'group');
  utility.setAttribute('aria-label', 'Навигация и выход из режима чтения');
  utility.innerHTML = '<button class="focus-context" type="button" aria-label="Открыть окружающий абзац">Абзац</button><button class="focus-exit" type="button" aria-label="Выйти из полноэкранного режима"><span aria-hidden="true">×</span> Выйти</button>';
  bottom.append(utility);

  const exitButton = utility.querySelector('.focus-exit');
  const contextButton = utility.querySelector('.focus-context');
  contextButton.hidden = !contextSource;
  const speedDown = speedbar.querySelector('.focus-speed-down');
  const speedUp = speedbar.querySelector('.focus-speed-up');
  const settingsButton = speedbar.querySelector('.focus-speed-label');
  const originalTriggerLabel = trigger.getAttribute('aria-label');
  const originalTriggerTitle = trigger.getAttribute('title');
  const originalTriggerPressed = trigger.getAttribute('aria-pressed');
  let active = false;
  let disposed = false;
  let nativeEntered = false;
  let requestGeneration = 0;
  let layoutFrame = null;
  let opener = null;
  let scrollPosition = null;
  let styleSnapshot = [];
  let inertSnapshot = [];
  let fontLimit = Infinity;

  function rememberStyle(element, property, value) {
    styleSnapshot.push([element, property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
    element.style.setProperty(property, value);
  }

  function lockBackground() {
    scrollPosition = { x: view.scrollX, y: view.scrollY };
    rememberStyle(doc.documentElement, 'overflow', 'hidden');
    rememberStyle(doc.documentElement, 'overscroll-behavior', 'none');
    rememberStyle(doc.body, 'position', 'fixed');
    rememberStyle(doc.body, 'top', `${-scrollPosition.y}px`);
    rememberStyle(doc.body, 'left', `${-scrollPosition.x}px`);
    rememberStyle(doc.body, 'width', '100%');
    rememberStyle(doc.body, 'overflow', 'hidden');
    rememberStyle(doc.body, 'overscroll-behavior', 'none');
    // Keep background links out of the keyboard/accessibility focus order in fallback mode.
    for (let current = reader; current?.parentElement; current = current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling !== current && sibling instanceof view.HTMLElement && sibling.tagName !== 'DIALOG') {
          inertSnapshot.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
      }
      if (current.parentElement === doc.body) break;
    }
  }

  function restoreBackground() {
    for (const [element, property, value, priority] of styleSnapshot) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
    styleSnapshot = [];
    for (const [element, previous] of inertSnapshot) element.inert = previous;
    inertSnapshot = [];
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
    if (scrollPosition) {
      const behavior = doc.documentElement.style.scrollBehavior;
      doc.documentElement.style.scrollBehavior = 'auto';
      view.scrollTo(scrollPosition.x, scrollPosition.y);
      doc.documentElement.style.scrollBehavior = behavior;
      scrollPosition = null;
    }
  }

  function viewportLayout() {
    layoutFrame = null;
    if (!active) return;
    const viewport = view.visualViewport;
    const width = viewport?.width || view.innerWidth;
    const height = viewport?.height || view.innerHeight;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    // Pinch zoom changes the visible viewport without changing CSS media queries.
    // Reflow the same controls to keep them reachable instead of duplicating them.
    const compact = height <= 450;
    reader.classList.toggle('focus-compact', compact);
    reader.classList.toggle('focus-landscape', compact && width >= 540);
    reader.classList.toggle('focus-narrow', width < 280);
    const utilityParent = compact ? header : bottom;
    if (utility.parentElement !== utilityParent) utilityParent.append(utility);
    reader.style.setProperty('--focus-width', `${width}px`);
    reader.style.setProperty('--focus-height', `${height}px`);
    reader.style.setProperty('--focus-left', `${left}px`);
    reader.style.setProperty('--focus-top', `${top}px`);
    const bounds = reader.getBoundingClientRect();
    const center = bounds.top + bounds.height / 2;
    const headerEnd = header.getBoundingClientRect().bottom;
    const controlsStart = bottom.getBoundingClientRect().top;
    const halfSpace = Math.max(24, Math.min(center - headerEnd - 8, controlsStart - center - 8));
    const wordHeight = Math.min(240, 2 * halfSpace);
    fontLimit = wordHeight / 1.5;
    reader.style.setProperty('--focus-word-height', `${wordHeight}px`);
    onChange({ active: true, mode: doc.fullscreenElement === reader ? 'native' : 'fallback', width, height, maxFontSize: fontLimit });
  }

  function requestLayout() {
    if (active && layoutFrame === null) layoutFrame = view.requestAnimationFrame(viewportLayout);
  }

  function sync() {
    const state = readState() || {};
    const wpm = Math.min(1200, Math.max(100, Math.round(Number(state.wpm) || 300)));
    speedbar.querySelector('.focus-speed-value').textContent = String(wpm);
    header.querySelector('.focus-caption').textContent = state.status || 'РЕЖИМ ЧТЕНИЯ';
    speedDown.disabled = wpm <= 100;
    speedUp.disabled = wpm >= 1200;
    header.querySelector('.focus-title').textContent = state.title || reader.querySelector('#book-title')?.textContent || 'Ваша книга';
  }

  function deactivate() {
    if (!active) return;
    active = false;
    nativeEntered = false;
    fontLimit = Infinity;
    if (layoutFrame !== null) view.cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
    reader.classList.remove('focus-reader', 'focus-mode', 'focus-compact', 'focus-landscape', 'focus-narrow');
    if (rewindButton && rewindParent) rewindParent.insertBefore(rewindButton, rewindNext?.parentNode === rewindParent ? rewindNext : null);
    if (utility.parentElement !== bottom) bottom.append(utility);
    for (const property of ['--focus-width', '--focus-height', '--focus-left', '--focus-top', '--focus-word-height']) reader.style.removeProperty(property);
    if (originalTriggerLabel === null) trigger.removeAttribute('aria-label');
    else trigger.setAttribute('aria-label', originalTriggerLabel);
    if (originalTriggerTitle === null) trigger.removeAttribute('title');
    else trigger.setAttribute('title', originalTriggerTitle);
    if (originalTriggerPressed === null) trigger.removeAttribute('aria-pressed');
    else trigger.setAttribute('aria-pressed', originalTriggerPressed);
    restoreBackground();
    onChange({ active: false, mode: null, maxFontSize: Infinity });
  }

  async function exit() {
    requestGeneration += 1;
    if (doc.fullscreenElement === reader && typeof doc.exitFullscreen === 'function') {
      try { await doc.exitFullscreen(); } catch { /* Fallback cleanup still restores the page. */ }
    }
    deactivate();
  }

  async function enter() {
    if (active || disposed) return;
    const generation = ++requestGeneration;
    opener = doc.activeElement;
    onEnter();
    active = true;
    nativeEntered = false;
    lockBackground();
    if (rewindButton) utility.prepend(rewindButton);
    reader.classList.add('focus-mode', 'focus-reader');
    trigger.setAttribute('aria-label', 'Выйти из полноэкранного режима');
    trigger.setAttribute('title', 'Выйти из полноэкранного режима');
    trigger.setAttribute('aria-pressed', 'true');
    sync();
    viewportLayout();
    (playButton || exitButton).focus({ preventScroll: true });
    if (preferNative && doc.fullscreenEnabled !== false && typeof reader.requestFullscreen === 'function') {
      try {
        await reader.requestFullscreen({ navigationUI: 'hide' });
        if (generation !== requestGeneration || !active) {
          if (doc.fullscreenElement === reader) await doc.exitFullscreen();
          return;
        }
        nativeEntered = doc.fullscreenElement === reader;
        requestLayout();
      } catch { /* iPhone Safari, embedding and permission failures keep the fixed viewport mode. */ }
    }
  }

  function toggle() { return active ? exit() : enter(); }

  function changeSpeed(delta) {
    const current = Number(readState()?.wpm) || 300;
    onSpeedChange(Math.min(1200, Math.max(100, current + delta)));
    sync();
  }

  function fullscreenChanged() {
    if (doc.fullscreenElement === reader) {
      if (active) { nativeEntered = true; requestLayout(); }
      else if (typeof doc.exitFullscreen === 'function') doc.exitFullscreen().catch(() => {});
    } else if (active && nativeEntered) deactivate();
  }

  function keydown(event) {
    if (!active || doc.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      exit();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...reader.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')]
      .filter((element) => element.getClientRects().length && !element.closest('[hidden]'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (doc.activeElement === first || !reader.contains(doc.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (doc.activeElement === last || !reader.contains(doc.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }

  const reduceSpeed = () => changeSpeed(-25);
  const increaseSpeed = () => changeSpeed(25);
  const openContext = () => contextSource?.click();
  trigger.addEventListener('click', toggle);
  exitButton.addEventListener('click', exit);
  contextButton.addEventListener('click', openContext);
  speedDown.addEventListener('click', reduceSpeed);
  speedUp.addEventListener('click', increaseSpeed);
  settingsButton.addEventListener('click', onSettings);
  doc.addEventListener('fullscreenchange', fullscreenChanged);
  doc.addEventListener('keydown', keydown, true);
  view.addEventListener('resize', requestLayout);
  view.addEventListener('orientationchange', requestLayout);
  view.visualViewport?.addEventListener('resize', requestLayout);
  view.visualViewport?.addEventListener('scroll', requestLayout);
  const controlsObserver = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(requestLayout) : null;
  controlsObserver?.observe(bottom);
  controlsObserver?.observe(header);

  async function dispose() {
    disposed = true;
    await exit();
    trigger.removeEventListener('click', toggle);
    exitButton.removeEventListener('click', exit);
    contextButton.removeEventListener('click', openContext);
    speedDown.removeEventListener('click', reduceSpeed);
    speedUp.removeEventListener('click', increaseSpeed);
    settingsButton.removeEventListener('click', onSettings);
    doc.removeEventListener('fullscreenchange', fullscreenChanged);
    doc.removeEventListener('keydown', keydown, true);
    view.removeEventListener('resize', requestLayout);
    view.removeEventListener('orientationchange', requestLayout);
    view.visualViewport?.removeEventListener('resize', requestLayout);
    view.visualViewport?.removeEventListener('scroll', requestLayout);
    controlsObserver?.disconnect();
    header.remove();
    speedbar.remove();
    utility.remove();
  }

  return { enter, exit, toggle, sync, dispose, get active() { return active; }, get maxFontSize() { return fontLimit; } };
}
