/** Account views use only the client's verified state; books remain in this browser. */
export function setupAccountUI({ client, pauseMain = () => {}, notify = () => {}, onAdmin = () => {} } = {}) {
  if (!client?.getState || !client?.subscribe) throw new Error('Не удалось подключить интерфейс аккаунта.');
  const nav = document.querySelector('.site-header nav');
  if (!nav) throw new Error('Не найдено меню для аккаунта.');
  const button = document.createElement('button');
  button.id = 'account-button';
  button.type = 'button';
  button.className = 'account-button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'account-dialog');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg><span class="account-button-label">Аккаунт</span>';
  nav.insertBefore(button, nav.querySelector('#theme-button'));
  const dialog = document.createElement('dialog');
  dialog.id = 'account-dialog';
  dialog.className = 'account-dialog';
  dialog.setAttribute('aria-labelledby', 'account-title');
  dialog.innerHTML = `
    <header class="account-header"><h2 id="account-title">Аккаунт</h2><button id="account-close" type="button" aria-label="Закрыть аккаунт">×</button></header>
    <div class="account-body">
      <p id="account-unconfigured" class="account-notice" hidden>Аккаунты ещё не подключены. Читать и хранить книги в этом браузере можно без аккаунта.</p>
      <p id="account-loading" class="account-note" role="status" hidden>Проверяем вход…</p>
      <div id="account-tabs" class="account-tabs" role="group" aria-label="Вход или регистрация"><button id="account-signin" type="button" aria-pressed="true">Войти</button><button id="account-signup" type="button" aria-pressed="false">Регистрация</button></div>
      <p id="account-description" class="account-note"></p>
      <p id="account-message" class="account-message" role="status" aria-live="polite" aria-atomic="true" hidden></p>
      <form id="account-form">
        <div id="account-name-field" class="account-field" hidden><label for="account-display-name">Имя</label><input id="account-display-name" name="displayName" type="text" autocomplete="nickname" maxlength="80" placeholder="Как к вам обращаться"><p class="account-field-note">Можно оставить пустым.</p></div>
        <div id="account-email-field" class="account-field"><label for="account-email">Электронная почта</label><input id="account-email" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254" required placeholder="you@example.com"></div>
        <div id="account-profile-email" class="account-field" hidden><span class="account-label">Электронная почта</span><p id="account-email-value" class="account-email-value"></p></div>
        <div id="account-password-field" class="account-field"><label for="account-password">Пароль</label><div class="account-password-row"><input id="account-password" name="password" type="password" autocomplete="current-password" maxlength="128" required><button id="account-password-toggle" type="button" aria-label="Показать пароль" aria-pressed="false" aria-controls="account-password">Показать</button></div><p id="account-password-hint" class="account-field-note" hidden>От 10 до 128 символов.</p></div>
      </form>
      <button id="account-forgot" class="account-text-action" type="button">Не помню пароль</button>
      <button id="account-back" class="account-text-action" type="button" hidden>Вернуться ко входу</button>
      <button id="account-admin" class="account-admin" type="button" hidden>Администрирование ↗</button>
      <p id="account-local-note" class="account-note account-local-note">Книги и место чтения сохраняются в этом браузере.</p>
    </div>
    <footer class="account-footer"><button id="account-submit" class="account-primary" type="submit" form="account-form">Войти</button><div class="account-secondary-actions"><button id="account-logout" type="button" hidden>Выйти из аккаунта</button><button id="account-dismiss" type="button">К книге</button></div></footer>`;
  document.body.append(dialog);
  const find = (name) => dialog.querySelector(`#account-${name}`);
  const events = new AbortController();
  const listen = (node, name, callback) => node?.addEventListener(name, callback, { signal: events.signal });
  const media = matchMedia('(max-width: 600px), (max-width: 1000px) and (max-height: 600px)');
  let state = client.getState();
  let mode = 'signin';
  let renderedMode = '';
  let profileUserId = null;
  let profileNameDirty = false;
  let pending = null;
  let generation = 0;
  let destroyed = false;
  let opener = null;
  let background = null;
  let layoutFrame = null;
  let message = '';
  let messageIsError = false;
  const errorText = (error) => typeof error === 'string' ? error : error?.message || 'Не удалось выполнить действие. Попробуйте ещё раз.';
  const busy = () => Boolean(pending || state.loading);

  function clearPassword() {
    find('password').value = '';
    find('password').type = 'password';
    find('password-toggle').textContent = 'Показать';
    find('password-toggle').setAttribute('aria-label', 'Показать пароль');
    find('password-toggle').setAttribute('aria-pressed', 'false');
  }

  function currentMode() {
    if (!state.configured) return 'unconfigured';
    if (state.loading && !pending) return 'loading';
    if (state.recovery) return 'recovery';
    if (state.user) return 'profile';
    return ['signin', 'signup', 'forgot'].includes(mode) ? mode : 'signin';
  }

  function showMessage(text, isError = false) {
    message = text;
    messageIsError = isError;
    render();
    if (isError) dialog.querySelector('.account-body').scrollTop = 0;
  }

  function render() {
    if (destroyed) return;
    const next = currentMode();
    const isGuestForm = ['signin', 'signup', 'forgot'].includes(next);
    const hasPassword = ['signin', 'signup', 'recovery'].includes(next);
    const hasName = next === 'signup' || next === 'profile';
    if (next !== renderedMode) clearPassword();
    if (next === 'profile' && !state.loading) {
      if (profileUserId !== state.user?.id) {
        profileUserId = state.user?.id;
        profileNameDirty = false;
      }
      // Auth can arrive before the profile RPC. Populate from the completed
      // profile while keeping a draft the reader has already started editing.
      if (!profileNameDirty) find('display-name').value = state.user?.displayName || '';
    }
    if (next === 'signup' && renderedMode !== 'signup') find('display-name').value = '';
    renderedMode = next;
    dialog.dataset.mode = next;
    dialog.setAttribute('aria-busy', String(busy()));
    const signedIn = Boolean(state.configured && state.user);
    button.setAttribute('aria-label', signedIn ? 'Открыть мой аккаунт' : 'Открыть вход в аккаунт');
    button.title = signedIn ? 'Мой аккаунт' : 'Аккаунт';
    button.querySelector('.account-button-label').textContent = signedIn ? 'Мой аккаунт' : 'Аккаунт';
    find('title').textContent = ({ unconfigured: 'Аккаунты ещё не подключены', loading: 'Аккаунт', signin: 'С возвращением', signup: 'Создать аккаунт', forgot: 'Восстановить пароль', recovery: 'Новый пароль', profile: 'Мой аккаунт' })[next];
    find('unconfigured').hidden = next !== 'unconfigured';
    find('loading').hidden = next !== 'loading';
    find('tabs').hidden = !['signin', 'signup'].includes(next);
    find('signin').setAttribute('aria-pressed', String(next === 'signin'));
    find('signup').setAttribute('aria-pressed', String(next === 'signup'));
    find('description').textContent = ({ signin: 'Войдите с почтой и паролем.', signup: 'Укажите почту и придумайте пароль.', forgot: 'Отправим ссылку для восстановления, если оно доступно для этого адреса.', recovery: 'Придумайте новый пароль для аккаунта.', profile: 'Здесь можно изменить имя и выйти из аккаунта на этом устройстве.' })[next] || '';
    find('description').hidden = !find('description').textContent;
    find('form').hidden = ['unconfigured', 'loading'].includes(next);
    find('name-field').hidden = !hasName;
    find('email-field').hidden = !isGuestForm;
    find('profile-email').hidden = next !== 'profile';
    find('email-value').textContent = state.user?.email || '';
    find('password-field').hidden = !hasPassword;
    find('password').autocomplete = next === 'signin' ? 'current-password' : 'new-password';
    find('password').minLength = next === 'signin' ? 1 : 10;
    find('password-hint').hidden = next === 'signin';
    if (next === 'signup' || next === 'recovery') find('password').setAttribute('aria-describedby', 'account-password-hint');
    else find('password').removeAttribute('aria-describedby');
    find('forgot').hidden = next !== 'signin';
    find('back').hidden = next !== 'forgot';
    find('admin').hidden = !signedIn || !state.isAdmin || next !== 'profile';
    find('logout').hidden = !signedIn;
    find('submit').hidden = ['unconfigured', 'loading'].includes(next);
    find('submit').textContent = busy() ? 'Подождите…' : ({ signin: 'Войти', signup: 'Создать аккаунт', forgot: 'Отправить ссылку', recovery: 'Сохранить пароль', profile: 'Сохранить имя' })[next] || 'Продолжить';
    const blocked = busy();
    for (const id of ['signin', 'signup', 'forgot', 'back', 'submit', 'logout', 'admin', 'password-toggle']) find(id).disabled = blocked;
    find('display-name').disabled = blocked || !hasName;
    find('email').disabled = blocked || !isGuestForm;
    find('password').disabled = blocked || !hasPassword;
    find('message').textContent = message;
    find('message').hidden = !message;
    find('message').classList.toggle('is-error', messageIsError);
    find('message').setAttribute('role', messageIsError ? 'alert' : 'status');
  }

  function setMode(next) {
    if (busy()) return;
    generation += 1;
    mode = next;
    message = '';
    messageIsError = false;
    clearPassword();
    render();
    (next === 'signup' ? find('display-name') : find('email')).focus({ preventScroll: true });
  }

  function sync(next = client.getState()) {
    if (destroyed) return;
    const previousId = state.user?.id;
    const previousRecovery = state.recovery;
    state = next || client.getState();
    if (previousId !== state.user?.id || previousRecovery !== state.recovery) {
      clearPassword();
      message = '';
      messageIsError = false;
      if (!state.user && !state.recovery) mode = 'signin';
    }
    if (previousId !== state.user?.id) {
      profileUserId = null;
      profileNameDirty = false;
    }
    // Action errors belong to the opening that submitted them. In particular,
    // an older request must not paint its error over a freshly reopened dialog.
    if (!pending && state.error) {
      message = errorText(state.error);
      messageIsError = true;
    }
    render();
  }

  async function runAction(action, success) {
    if (destroyed || !dialog.open || busy() || !state.configured) return;
    const operation = { generation };
    pending = operation;
    message = '';
    messageIsError = false;
    clearPassword();
    render();
    try {
      const result = await action();
      if (!destroyed && dialog.open && generation === operation.generation) success?.(result);
    } catch (error) {
      if (!destroyed && dialog.open && generation === operation.generation) {
        message = errorText(error);
        messageIsError = true;
        dialog.querySelector('.account-body').scrollTop = 0;
      }
    } finally {
      if (pending === operation) pending = null;
      if (!destroyed) render();
    }
  }

  function submit(event) {
    event.preventDefault();
    if (busy() || !state.configured || !dialog.open) return;
    const activeMode = currentMode();
    const email = find('email').value.trim();
    const password = find('password').value; // Password whitespace is intentional.
    const displayName = find('display-name').value.trim();
    if (['signin', 'signup', 'forgot'].includes(activeMode)) {
      find('email').value = email;
      if (!email || !find('email').checkValidity()) { showMessage('Укажите корректный адрес электронной почты.', true); find('email').focus(); return; }
    }
    if (['signin', 'signup', 'recovery'].includes(activeMode)) {
      const min = activeMode === 'signin' ? 1 : 10;
      if (password.length < min || password.length > 128) { showMessage(min === 1 ? 'Введите пароль длиной до 128 символов.' : 'Пароль должен содержать от 10 до 128 символов.', true); find('password').focus(); return; }
    }
    if (['signup', 'profile'].includes(activeMode) && displayName.length > 80) { showMessage('Имя должно быть не длиннее 80 символов.', true); return; }
    if (activeMode === 'signin') void runAction(() => client.signIn(email, password));
    else if (activeMode === 'signup') void runAction(() => client.signUp(email, password, displayName), (result) => {
      if (result?.confirmationRequired || !state.user) message = 'Если для этого адреса доступна регистрация, вы получите письмо с дальнейшими действиями. Проверьте почту.';
    });
    else if (activeMode === 'forgot') void runAction(() => client.requestPasswordReset(email), () => { message = 'Если для этого адреса доступно восстановление, вы получите письмо со ссылкой.'; });
    else if (activeMode === 'recovery') void runAction(() => client.updatePassword(password), () => { message = 'Пароль обновлён.'; });
    else if (activeMode === 'profile') void runAction(() => client.updateProfile(displayName), () => { profileNameDirty = false; message = 'Имя сохранено.'; });
  }

  function lockBackground() {
    if (background || document.querySelector('#reader.focus-mode')) return;
    const changes = [[document.documentElement, 'overflow', 'hidden'], [document.documentElement, 'overscroll-behavior', 'none'], [document.body, 'position', 'fixed'], [document.body, 'top', `${-window.scrollY}px`], [document.body, 'left', `${-window.scrollX}px`], [document.body, 'width', '100%'], [document.body, 'overflow', 'hidden']];
    background = { x: window.scrollX, y: window.scrollY, styles: changes.map(([node, property]) => [node, property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]) };
    changes.forEach(([node, property, value]) => node.style.setProperty(property, value));
  }

  function unlockBackground() {
    if (!background) return;
    const previous = background;
    background = null;
    previous.styles.forEach(([node, property, value, priority]) => { if (value) node.style.setProperty(property, value, priority); else node.style.removeProperty(property); });
    const root = document.documentElement;
    const behavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(previous.x, previous.y);
    root.style.scrollBehavior = behavior;
  }

  function updateLayout() {
    if (!dialog.open || destroyed) return;
    const visual = window.visualViewport;
    const width = visual?.width || innerWidth;
    const height = visual?.height || innerHeight;
    const mobile = media.matches || width <= 600 || (width <= 1000 && height <= 600);
    dialog.classList.toggle('account-fullscreen', mobile);
    dialog.classList.toggle('account-narrow', width < 280);
    if (mobile) {
      for (const [key, value] of Object.entries({ width, height, left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0 })) dialog.style.setProperty(`--account-${key}`, `${value}px`);
      lockBackground();
    } else unlockBackground();
  }

  function cleanup() {
    generation += 1;
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
    clearPassword();
    unlockBackground();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  function close() {
    if (dialog.open) dialog.close();
    cleanup();
  }

  function open() {
    if (destroyed) return;
    if (dialog.open) { find('dismiss').focus({ preventScroll: true }); return; }
    generation += 1;
    opener = document.activeElement;
    pauseMain();
    mode = 'signin';
    profileUserId = null;
    profileNameDirty = false;
    message = '';
    messageIsError = false;
    clearPassword();
    sync();
    dialog.showModal();
    updateLayout();
    dialog.querySelector('.account-body').scrollTop = 0;
    const first = ['signin', 'signup', 'forgot'].includes(currentMode()) ? find('email') : currentMode() === 'recovery' ? find('password') : currentMode() === 'profile' ? find('display-name') : find('dismiss');
    (first.disabled ? find('dismiss') : first).focus({ preventScroll: true });
  }

  listen(button, 'click', open);
  listen(find('close'), 'click', close);
  listen(find('dismiss'), 'click', close);
  listen(find('signin'), 'click', () => setMode('signin'));
  listen(find('signup'), 'click', () => setMode('signup'));
  listen(find('forgot'), 'click', () => setMode('forgot'));
  listen(find('back'), 'click', () => setMode('signin'));
  listen(find('form'), 'submit', submit);
  listen(find('display-name'), 'input', () => { if (currentMode() === 'profile') profileNameDirty = true; });
  listen(find('password-toggle'), 'click', () => {
    const shown = find('password').type === 'password';
    find('password').type = shown ? 'text' : 'password';
    find('password-toggle').textContent = shown ? 'Скрыть' : 'Показать';
    find('password-toggle').setAttribute('aria-label', shown ? 'Скрыть пароль' : 'Показать пароль');
    find('password-toggle').setAttribute('aria-pressed', String(shown));
  });
  listen(find('logout'), 'click', () => { if (state.user) void runAction(() => client.signOut(), () => { message = 'Вы вышли из аккаунта на этом устройстве.'; }); });
  listen(find('admin'), 'click', () => {
    if (busy() || !state.user || !state.isAdmin) return;
    close();
    Promise.resolve().then(() => onAdmin()).catch((error) => notify(errorText(error)));
  });
  listen(dialog, 'cancel', (event) => { event.preventDefault(); close(); });
  listen(dialog, 'close', () => { if (!dialog.open) cleanup(); });
  listen(dialog, 'click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  listen(window, 'resize', updateLayout);
  listen(media, 'change', updateLayout);
  listen(window.visualViewport, 'resize', updateLayout);
  listen(window.visualViewport, 'scroll', updateLayout);
  // Native events may checkpoint microtasks between listeners. The next frame
  // runs after the reader's fullscreen cleanup has released its scroll lock.
  listen(document, 'fullscreenchange', () => {
    if (!dialog.open || destroyed || layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = null; updateLayout(); });
  });
  const unsubscribe = client.subscribe(sync);
  render();
  return {
    open, close, sync,
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      events.abort();
      unsubscribe?.();
      button.remove();
      dialog.remove();
    },
  };
}
