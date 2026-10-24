const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function replaceProperty(object, name, descriptor) {
  const original = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, ...descriptor });
  return () => { if (original) Object.defineProperty(object, name, original); else delete object[name]; };
}

function fakeClient(initial = {}) {
  let state = { configured: true, loading: false, user: null, isAdmin: false, recovery: false, ...initial };
  const listeners = new Set();
  const calls = [];
  const handlers = {};
  const client = {
    getState: () => state,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    emit(patch) { state = { ...state, ...patch }; listeners.forEach((callback) => callback(state)); },
    calls, handlers,
    subscribers: () => listeners.size,
  };
  for (const name of ['signIn', 'signUp', 'requestPasswordReset', 'updatePassword', 'updateProfile', 'signOut']) {
    client[name] = (...args) => { calls.push({ name, args }); return handlers[name] ? handlers[name](...args) : Promise.resolve(); };
  }
  return client;
}

/** Tests an isolated UI and fake client: no real login, credentials, storage or reader changes. */
export async function runAccountTests({ record }) {
  const frame = document.createElement('iframe');
  frame.title = 'Изолированные проверки интерфейса аккаунта';
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:390px;height:844px;border:0';
  const moduleURL = new URL('../js/account-ui.mjs', import.meta.url).href;
  const stylesURL = new URL('../styles.css', import.meta.url).href;
  const accountStylesURL = new URL('../account.css', import.meta.url).href;
  const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  frame.srcdoc = `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${stylesURL}"><link rel="stylesheet" href="${accountStylesURL}"></head><body><header class="site-header"><a class="brand" href="#">якорь.</a><nav aria-label="Основное меню"><a class="quiet-button" href="#">Библиотека</a><button id="help-button" class="quiet-button">Как читать</button><button id="theme-button" class="theme-button" aria-label="Тема">☾</button></nav></header><main style="min-height:1400px">Проверка аккаунта</main><script type="module">import { setupAccountUI } from ${JSON.stringify(moduleURL)};window.accountTestFactory = setupAccountUI;</script></body></html>`;
  document.body.append(frame);
  let ui;
  try {
    await loaded;
    const deadline = performance.now() + 5000;
    while (!frame.contentWindow.accountTestFactory) {
      if (performance.now() > deadline) throw new Error('Account UI test module did not load');
      await delay(20);
    }
    const w = frame.contentWindow;
    const d = frame.contentDocument;
    const el = (name) => d.getElementById(`account-${name}`);
    const tick = async () => { await delay(); await delay(); };
    let pauseCount = 0;
    let adminCount = 0;
    const make = async (initial) => {
      ui?.destroy();
      await tick();
      const client = fakeClient(initial);
      pauseCount = 0;
      adminCount = 0;
      ui = w.accountTestFactory({ client, pauseMain: () => { pauseCount += 1; }, onAdmin: () => { adminCount += 1; } });
      return client;
    };
    const submit = () => el('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    const fill = (email, password) => { el('email').value = email; el('password').value = password; };
    const open = () => { el('button').focus({ preventScroll: true }); el('button').click(); assert(el('dialog').open, 'Account dialog did not open'); };

    await record('Unconfigured accounts show an honest notice without an editable credential form', async () => {
      const client = await make({ configured: false });
      open();
      assert(el('dialog').dataset.mode === 'unconfigured', 'Unconfigured accounts opened a login screen');
      assert(el('title').textContent.includes('ещё не подключены') && !el('unconfigured').hidden, 'Connection status is not explained');
      assert(el('form').hidden && el('password').disabled && el('email').disabled, 'Unconfigured view has editable credentials');
      fill('unused@example.test', 'never-sent-password');
      submit();
      assert(client.calls.length === 0, 'Unconfigured UI attempted authentication');
      assert(pauseCount === 1, 'Opening an account did not pause reading exactly once');
      el('dismiss').click();
      assert(!el('dialog').open && !el('password').value && d.activeElement === el('button'), 'Closing did not clear the password or restore focus');
    });

    await record('Registration validates bounds, preserves password whitespace and waits for confirmation without claiming login', async () => {
      const client = await make();
      const request = deferred();
      client.handlers.signUp = () => request.promise;
      open();
      el('signup').click();
      assert(el('password').autocomplete === 'new-password' && el('email').autocomplete === 'username', 'Registration autofill semantics are incorrect');
      el('display-name').value = '  Читатель  ';
      fill(' reader@example.test ', '123456789');
      submit();
      assert(client.calls.length === 0, 'A password shorter than ten characters was submitted');
      el('password').value = 'a'.repeat(129);
      submit();
      assert(client.calls.length === 0, 'A password longer than 128 characters was submitted');
      const password = ` ${'a'.repeat(126)} `;
      el('password').value = password;
      el('password-toggle').click();
      assert(el('password').type === 'text' && el('password-toggle').getAttribute('aria-pressed') === 'true', 'Password visibility is not announced');
      submit();
      submit();
      assert(client.calls.length === 1, 'Registration submitted twice while pending');
      assert(client.calls[0].args[0] === 'reader@example.test' && client.calls[0].args[1] === password && client.calls[0].args[2] === 'Читатель', 'Email/name normalization changed the password');
      assert(!el('password').value && el('password').type === 'password' && el('submit').disabled, 'Submitting did not clear and conceal credentials');
      request.resolve({ confirmationRequired: true });
      await tick();
      assert(el('dialog').dataset.mode === 'signup' && el('message').textContent.includes('письмо'), 'Registration confirmation pretended to sign in');
      assert(!client.getState().user && el('logout').hidden, 'A fake account appeared before client authentication');
    });

    await record('Profile data and errors stay plain text; administrator access follows only client state', async () => {
      const client = await make();
      const name = '<img src=x onerror="window.badAccountMarkup=true">';
      const email = '<svg onload=alert(1)>@example.test';
      client.handlers.signIn = async () => { client.emit({ user: { id: 'user-1', email, displayName: name }, isAdmin: false }); };
      open();
      fill('reader@example.test', ' old-password ');
      submit();
      await tick();
      assert(client.calls[0].args[1] === ' old-password ', 'Sign-in trimmed an existing password');
      assert(el('dialog').dataset.mode === 'profile' && el('display-name').value === name && el('email-value').textContent === email, 'Client profile did not render safely');
      assert(!el('dialog').querySelector('img,svg') && !w.badAccountMarkup, 'Untrusted profile markup was inserted as HTML');
      assert(el('admin').hidden && el('logout').closest('.account-footer'), 'Non-admin access or logout placement is incorrect');
      client.handlers.updateProfile = async (displayName) => client.emit({ user: { ...client.getState().user, displayName } });
      el('display-name').value = '  Новое имя  ';
      submit();
      await tick();
      assert(client.calls.at(-1).name === 'updateProfile' && client.calls.at(-1).args[0] === 'Новое имя', 'Profile edit did not use the client');
      client.emit({ isAdmin: true });
      assert(!el('admin').hidden, 'Verified admin state did not expose the admin action');
      client.emit({ isAdmin: false });
      el('admin').click();
      await tick();
      assert(adminCount === 0 && el('dialog').open, 'An outdated admin button bypassed current role state');
      client.emit({ isAdmin: true });
      el('admin').click();
      await tick();
      assert(adminCount === 1 && !el('dialog').open, 'Admin navigation did not close the account dialog');
    });

    await record('Profile hydration fills the saved name and preserves an unsaved draft through later refreshes', async () => {
      const user = { id: 'hydrating', email: 'reader@example.test', displayName: '' };
      const client = await make({ loading: true, user });
      open();
      assert(el('dialog').dataset.mode === 'loading' && el('display-name').disabled, 'A partial auth user was shown as a loaded profile');
      client.emit({ loading: false, user: { ...user, displayName: 'Сохранённое имя' } });
      assert(el('dialog').dataset.mode === 'profile' && el('display-name').value === 'Сохранённое имя', 'The completed profile did not populate the existing name');
      el('display-name').value = 'Мой несохранённый вариант';
      el('display-name').dispatchEvent(new w.Event('input', { bubbles: true }));
      client.emit({ loading: true, user });
      assert(el('dialog').dataset.mode === 'loading', 'A refreshed partial profile was editable');
      client.emit({ loading: false, user: { ...user, displayName: 'Имя с сервера' } });
      assert(el('display-name').value === 'Мой несохранённый вариант', 'A profile refresh overwrote the user draft');
      client.handlers.updateProfile = async (displayName) => client.emit({ user: { ...user, displayName } });
      submit();
      await tick();
      assert(client.calls.at(-1).args[0] === 'Мой несохранённый вариант', 'Saving used the stale server name instead of the draft');
      client.emit({ user: { ...user, displayName: 'Обновлённое сохранённое имя' } });
      assert(el('display-name').value === 'Обновлённое сохранённое имя', 'A saved field stopped following completed profile updates');
    });

    await record('Forgot-password messaging is generic and recovery accepts only a new 10–128 character password', async () => {
      const client = await make();
      open();
      el('forgot').click();
      el('email').value = ' reader@example.test ';
      submit();
      await tick();
      assert(client.calls[0].name === 'requestPasswordReset' && client.calls[0].args[0] === 'reader@example.test', 'Reset did not use the trimmed email');
      assert(el('message').textContent.includes('Если для этого адреса'), 'Password reset reveals whether an account exists');
      client.emit({ user: { id: 'recovering', email: 'reader@example.test', displayName: '' }, recovery: true });
      assert(el('dialog').dataset.mode === 'recovery' && el('password').autocomplete === 'new-password', 'Recovery did not override the profile view');
      el('password').value = 'short';
      submit();
      assert(client.calls.length === 1, 'Recovery submitted a short password');
      const password = ' new-password ';
      client.handlers.updatePassword = async () => client.emit({ recovery: false });
      el('password').value = password;
      submit();
      await tick();
      assert(client.calls.at(-1).name === 'updatePassword' && client.calls.at(-1).args[0] === password, 'Recovery changed the password before submitting');
      assert(!el('password').value && el('dialog').dataset.mode === 'profile' && el('message').textContent === 'Пароль обновлён.', 'Successful password recovery did not clear the secret and return to profile');
    });

    await record('Closing and reopening a pending sign-in blocks duplicates and ignores the old view error', async () => {
      const client = await make();
      const request = deferred();
      client.handlers.signIn = () => request.promise;
      open();
      fill('reader@example.test', 'example-password');
      submit();
      el('dismiss').click();
      open();
      assert(el('submit').disabled && !el('password').value, 'Reopening lost the pending operation lock');
      submit();
      assert(client.calls.length === 1, 'Reopening allowed a parallel sign-in');
      client.emit({ error: '<img src=x>Старый отказ' });
      request.reject(new Error('<img src=x>Старый отказ'));
      await tick();
      assert(el('message').hidden && !el('submit').disabled, 'An old request repainted or locked the reopened view');
      assert(!el('dialog').querySelector('img'), 'An error was rendered as HTML');
      client.emit({ error: null });
      client.handlers.signIn = async () => { throw new Error('<b>Ошибка входа</b>'); };
      fill('reader@example.test', 'another-password');
      submit();
      await tick();
      assert(el('message').textContent === '<b>Ошибка входа</b>' && !el('message').querySelector('b'), 'Current errors do not render as plain text');
    });

    await record('Logout remains in the footer, submits once and follows real client state after reopening', async () => {
      const client = await make({ user: { id: 'user-2', email: 'reader@example.test', displayName: 'Читатель' } });
      const request = deferred();
      client.handlers.signOut = () => request.promise;
      open();
      el('logout').click();
      el('logout').click();
      assert(client.calls.length === 1 && client.calls[0].name === 'signOut', 'Logout submitted twice');
      el('dismiss').click();
      open();
      assert(el('logout').disabled && el('logout').closest('.account-footer'), 'Pending logout lost its footer state');
      client.emit({ user: null, isAdmin: false });
      request.resolve();
      await tick();
      assert(el('dialog').dataset.mode === 'signin' && el('logout').hidden && !el('submit').disabled, 'Logout state was not synchronized with the client');
      ui.destroy();
      assert(client.subscribers() === 0 && !d.getElementById('account-button') && !d.getElementById('account-dialog'), 'Destroy leaked account elements or subscriptions');
    });

    await record('Fullscreen lock transfer waits for an animation frame and queued layout is cancelled on close or destroy', async () => {
      await make();
      frame.style.width = '390px';
      frame.style.height = '844px';
      await delay(60);
      const original = { body: d.body.style.cssText, root: d.documentElement.style.cssText, x: w.scrollX, y: w.scrollY };
      const reader = d.createElement('section');
      reader.id = 'reader';
      reader.className = 'focus-mode';
      d.body.append(reader);
      const frames = new Map();
      let serial = 0;
      let cancelled = 0;
      const restoreRequest = replaceProperty(w, 'requestAnimationFrame', { value: (callback) => { const id = ++serial; frames.set(id, callback); return id; } });
      const restoreCancel = replaceProperty(w, 'cancelAnimationFrame', { value: (id) => { if (frames.delete(id)) cancelled += 1; } });
      const releaseReaderLock = () => {
        reader.classList.remove('focus-mode');
        d.body.style.cssText = original.body;
        d.documentElement.style.cssText = original.root;
      };
      // Registered after the account listener to model native fullscreen cleanup.
      d.addEventListener('fullscreenchange', releaseReaderLock);
      try {
        d.body.style.position = 'fixed';
        d.body.style.top = '-160px';
        d.documentElement.style.overflow = 'hidden';
        open();
        assert(d.body.style.top === '-160px', 'Opening account overwrote the reader-owned lock');
        d.dispatchEvent(new w.Event('fullscreenchange'));
        assert(frames.size === 1 && d.body.style.position !== 'fixed', 'Fullscreen handling did not defer until after the reader released its lock');
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        callback(0);
        assert(d.body.style.position === 'fixed', 'The account did not acquire its lock on the next frame');
        el('dismiss').click();
        await tick();
        assert(d.body.style.cssText === original.body && d.documentElement.style.cssText === original.root, 'Account close restored temporary fullscreen styles');
        d.removeEventListener('fullscreenchange', releaseReaderLock);
        open();
        d.dispatchEvent(new w.Event('fullscreenchange'));
        assert(frames.size === 1, 'Fullscreen change did not queue a layout frame');
        el('dismiss').click();
        assert(frames.size === 0 && cancelled === 1, 'Closing did not cancel the queued layout');
        await tick();
        open();
        d.dispatchEvent(new w.Event('fullscreenchange'));
        ui.destroy();
        assert(frames.size === 0 && cancelled === 2, 'Destroy left a queued fullscreen callback');
        assert(d.body.style.cssText === original.body && d.documentElement.style.cssText === original.root, 'Destroy retained the account scroll lock');
      } finally {
        ui?.destroy();
        d.removeEventListener('fullscreenchange', releaseReaderLock);
        restoreCancel();
        restoreRequest();
        reader.remove();
        d.body.style.cssText = original.body;
        d.documentElement.style.cssText = original.root;
        w.scrollTo(original.x, original.y);
      }
    });

    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [568, 320]]) {
      await record(`Account modes fit ${width}×${height} with accessible bottom actions`, async () => {
        const client = await make({ configured: false });
        frame.style.width = `${width}px`;
        frame.style.height = `${height}px`;
        await delay(60);
        open();
        const geometry = (mode) => {
          assert(el('dialog').dataset.mode === mode, `Expected account mode ${mode}`);
          const r = el('dialog').getBoundingClientRect();
          assert(Math.abs(r.left) <= 1 && Math.abs(r.top) <= 1 && Math.abs(r.width - width) <= 1 && Math.abs(r.height - height) <= 1, `${mode}: dialog does not fill the viewport`);
          assert(el('dialog').scrollWidth <= el('dialog').clientWidth + 1, `${mode}: dialog overflows horizontally`);
          const footer = el('dialog').querySelector('.account-footer');
          assert(Math.abs(footer.getBoundingClientRect().bottom - height) <= 1, `${mode}: footer does not stay at the screen bottom`);
          const targets = [el('submit'), el('logout'), el('dismiss')].filter((node) => !node.hidden).map((node) => {
            const bounds = node.getBoundingClientRect();
            assert(bounds.width >= 43.5 && bounds.height >= 43.5, `${mode}: ${node.id} is below 44px`);
            assert(bounds.left >= -1 && bounds.right <= width + 1 && bounds.top >= -1 && bounds.bottom <= height + 1, `${mode}: ${node.id} is outside the viewport`);
            const hit = d.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            assert(hit === node || node.contains(hit), `${mode}: ${node.id} is covered`);
            return bounds;
          });
          for (let a = 0; a < targets.length; a += 1) for (let b = a + 1; b < targets.length; b += 1) {
            const overlapX = Math.min(targets[a].right, targets[b].right) - Math.max(targets[a].left, targets[b].left);
            const overlapY = Math.min(targets[a].bottom, targets[b].bottom) - Math.max(targets[a].top, targets[b].top);
            assert(overlapX <= .5 || overlapY <= .5, `${mode}: footer actions overlap`);
          }
        };
        geometry('unconfigured');
        client.emit({ configured: true });
        geometry('signin');
        el('signup').click();
        geometry('signup');
        el('signin').click();
        el('forgot').click();
        geometry('forgot');
        client.emit({ user: { id: 'geometry', email: 'reader@example.test', displayName: 'Читатель' }, recovery: true });
        geometry('recovery');
        client.emit({ recovery: false, isAdmin: true });
        geometry('profile');
        el('dismiss').click();
        await tick();
        assert(!el('password').value && w.getComputedStyle(d.body).position !== 'fixed', 'Closing the mobile account retained credentials or the scroll lock');
      });
    }
  } finally {
    ui?.destroy();
    frame.remove();
  }
}
