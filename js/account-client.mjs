import { ACCOUNT_CONFIG } from './account-config.mjs';

const BOOK_FIELDS = 'id,title,author,year,source_url,chapters,total_words,published,created_at,updated_at';
const PUBLIC_FIELDS = 'id,title,author,year,source_url,total_words,updated_at';
const ADMIN_FIELDS = `${PUBLIC_FIELDS},published,created_at`;

export function validateAccountConfig(config) {
  if (!config?.supabaseUrl && !config?.publishableKey) return null;
  let url;
  try { url = new URL(config.supabaseUrl); }
  catch { throw new Error('Укажите корректный HTTPS-адрес проекта Supabase.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) throw new Error('Укажите корректный HTTPS-адрес проекта Supabase.');
  const key = config.publishableKey;
  let allowed = typeof key === 'string' && /^sb_publishable_[\w-]+$/u.test(key);
  if (!allowed && typeof key === 'string' && key.split('.').length === 3) {
    try {
      const segment = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      allowed = JSON.parse(atob(segment)).role === 'anon';
    } catch { /* Only the legacy anon key is accepted. */ }
  }
  if (!allowed) throw new Error('Нужен публичный Publishable key или anon key. Секретные ключи запрещены.');
  return { supabaseUrl: url.origin, publishableKey: key };
}

export function accountError(cause, fallback = 'Не удалось выполнить действие. Попробуйте ещё раз.') {
  const messages = {
    invalid_credentials: 'Не удалось войти. Проверьте email и пароль.',
    email_not_confirmed: 'Сначала подтвердите email по ссылке из письма.',
    over_request_rate_limit: 'Слишком много попыток. Подождите немного и повторите.',
    over_email_send_rate_limit: 'Лимит писем временно исчерпан. Попробуйте позже.',
    email_address_invalid: 'Проверьте адрес электронной почты.',
    weak_password: 'Выберите более надёжный пароль: минимум 10 символов.',
    same_password: 'Новый пароль должен отличаться от предыдущего.',
    otp_expired: 'Ссылка устарела. Запросите новое письмо.',
    flow_state_not_found: 'Откройте ссылку из письма в том же браузере или запросите новую.',
    flow_state_expired: 'Ссылка устарела. Запросите новое письмо.',
    '42501': 'Доступ администратора не подтверждён.',
    PGRST301: 'Сессия закончилась. Войдите ещё раз.',
  };
  const status = Number(cause?.status || (cause?.code === '42501' ? 403 : 0));
  const error = new Error(messages[cause?.code] || (status === 429 ? messages.over_request_rate_limit : fallback));
  error.status = status;
  error.code = cause?.code;
  return error;
}

function emailValue(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('Введите адрес электронной почты.');
  return email;
}

function passwordValue(value, creating = false) {
  if (typeof value !== 'string' || value.length < (creating ? 10 : 1) || value.length > 128) throw new Error(creating ? 'Пароль должен содержать от 10 до 128 символов.' : 'Введите пароль.');
  return value; // A password is never trimmed or copied to app storage.
}

/** Supabase owns password verification and session refresh; PostgreSQL RLS owns permissions. */
export function createAccountClient({ config = ACCOUNT_CONFIG, loadSDK = () => import('../vendor/supabase.mjs'), redirectUrl = typeof location === 'object' ? new URL('./', location.href).href : 'http://localhost:4173/' } = {}) {
  let validated;
  let configurationError = '';
  try { validated = validateAccountConfig(config); } catch (error) { configurationError = error.message; }
  let state = { configured: Boolean(validated), loading: Boolean(validated), user: null, isAdmin: false, recovery: false, error: configurationError };
  const listeners = new Set();
  let sdk = null;
  let authSubscription = null;
  let generation = 0;
  let authTimer = null;
  let disposed = false;
  let lastSessionId = null;

  const getState = () => ({ ...state, user: state.user ? { ...state.user } : null });
  function emit(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(getState());
  }
  function guest(error = '') {
    generation += 1;
    lastSessionId = null;
    emit({ loading: false, user: null, isAdmin: false, recovery: false, error });
  }
  async function refreshAccount() {
    const version = ++generation;
    const verified = await sdk.auth.getUser();
    if (version !== generation || disposed) return;
    if (!verified.data?.user) {
      const missing = !verified.error || verified.error.name === 'AuthSessionMissingError' || verified.error.status === 401;
      guest(missing ? '' : 'Не удалось проверить сессию. Проверьте соединение.');
      return;
    }
    const user = verified.data.user;
    const changed = state.user?.id !== user.id;
    if (changed) emit({ loading: true, isAdmin: false, user: { id: user.id, email: user.email || '', displayName: '' } });
    const [profile, role] = await Promise.all([
      sdk.from('profiles').select('display_name').eq('id', user.id).maybeSingle(),
      sdk.rpc('is_admin'),
    ]);
    if (version !== generation || disposed) return;
    emit({
      loading: false,
      user: { id: user.id, email: user.email || '', displayName: typeof profile.data?.display_name === 'string' ? profile.data.display_name : '' },
      isAdmin: !role.error && role.data === true,
      error: profile.error || role.error ? 'Аккаунт открыт, но данные профиля недоступны. Проверьте подключение сервиса.' : '',
    });
  }
  function onAuth(event, session) {
    if (disposed) return;
    if (event === 'SIGNED_OUT' || !session?.user) {
      clearTimeout(authTimer);
      guest(event === 'INITIAL_SESSION' ? state.error : '');
      return;
    }
    if (session.user.id !== lastSessionId) {
      generation += 1;
      lastSessionId = session.user.id;
      emit({ user: null, isAdmin: false, loading: true, recovery: false });
    }
    if (event === 'PASSWORD_RECOVERY') emit({ recovery: true });
    clearTimeout(authTimer);
    // Do not call back into Auth while its state-change callback is executing.
    authTimer = setTimeout(() => { authTimer = null; refreshAccount().catch(() => emit({ loading: false, isAdmin: false, error: 'Не удалось проверить аккаунт. Попробуйте войти ещё раз.' })); }, 0);
  }
  const ready = (async () => {
    if (!validated) return;
    try {
      const { createClient } = await loadSDK();
      if (disposed) return;
      sdk = createClient(validated.supabaseUrl, validated.publishableKey, {
        auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storageKey: `anchor-auth-${new URL(validated.supabaseUrl).hostname}` },
      });
      authSubscription = sdk.auth.onAuthStateChange(onAuth).data.subscription;
      const initialized = await sdk.auth.initialize();
      if (initialized.error) throw initialized.error;
      const session = await sdk.auth.getSession();
      if (disposed) return;
      if (session.error) throw session.error;
      if (session.data?.session) await refreshAccount();
      else if (!state.user) emit({ loading: false });
    } catch (error) {
      emit({ loading: false, user: null, isAdmin: false, error: accountError(error, 'Не удалось подключить аккаунты. Попробуйте позже.').message });
    }
  })();

  async function connection() {
    await ready;
    if (!sdk || disposed) throw new Error('Аккаунты ещё не подключены. Чтение доступно без входа.');
    return sdk;
  }
  async function response(operation, fallback) {
    let result;
    try { result = await operation; }
    catch (error) { throw accountError(error, fallback); }
    if (result.error) {
      if (['42501', 'PGRST301'].includes(result.error.code) || [401, 403].includes(result.error.status)) emit({ isAdmin: false });
      throw accountError(result.error, fallback);
    }
    return result.data;
  }
  async function requireUser() {
    await connection();
    if (!state.user) throw Object.assign(new Error('Войдите в аккаунт.'), { status: 401 });
    return state.user.id;
  }
  async function requireAdmin() {
    const id = await requireUser();
    const role = await response(sdk.rpc('is_admin'), 'Не удалось проверить права администратора.');
    if (state.user?.id !== id || role !== true) {
      emit({ isAdmin: false });
      throw Object.assign(new Error('Доступ администратора не подтверждён.'), { status: 403, code: '42501' });
    }
    return id;
  }
  async function rows(query) {
    const result = [];
    for (let from = 0; ; from += 250) {
      const page = await response(query().range(from, from + 249), 'Не удалось загрузить данные. Проверьте соединение.');
      result.push(...(page || []));
      if (!page || page.length < 250) return result;
      if (result.length >= 10000) throw new Error('Список слишком большой. Обратитесь к владельцу сервиса.');
    }
  }
  async function adminData(operation) {
    const id = await requireAdmin();
    const data = await operation();
    if (disposed || state.user?.id !== id || !state.isAdmin) throw Object.assign(new Error('Сессия изменилась. Откройте админку снова.'), { status: 403 });
    return data;
  }
  return {
    ready, getState,
    subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); },
    async signIn(email, password) {
      await connection();
      await response(sdk.auth.signInWithPassword({ email: emailValue(email), password: passwordValue(password) }), 'Не удалось войти. Проверьте email, пароль и соединение.');
      await refreshAccount();
    },
    async signUp(email, password, displayName = '') {
      await connection();
      const name = String(displayName).trim();
      if (name.length > 80) throw new Error('Имя должно быть короче 81 символа.');
      const data = await response(sdk.auth.signUp({ email: emailValue(email), password: passwordValue(password, true), options: { data: { display_name: name }, emailRedirectTo: redirectUrl } }), 'Не удалось завершить регистрацию. Попробуйте позже.');
      if (data.session) await refreshAccount();
      return { confirmationRequired: !data.session };
    },
    async requestPasswordReset(email) {
      await connection();
      await response(sdk.auth.resetPasswordForEmail(emailValue(email), { redirectTo: redirectUrl }), 'Не удалось отправить письмо. Попробуйте позже.');
    },
    async updatePassword(password) {
      await requireUser();
      await response(sdk.auth.updateUser({ password: passwordValue(password, true) }), 'Не удалось изменить пароль. Запросите новую ссылку.');
      emit({ recovery: false });
    },
    async updateProfile(displayName) {
      const id = await requireUser();
      const name = String(displayName).trim();
      if (name.length > 80) throw new Error('Имя должно быть короче 81 символа.');
      await response(sdk.from('profiles').update({ display_name: name }).eq('id', id).select('id').single(), 'Не удалось сохранить имя.');
      if (state.user?.id === id) emit({ user: { ...state.user, displayName: name } });
    },
    async signOut() {
      await connection();
      await response(sdk.auth.signOut({ scope: 'local' }), 'Не удалось выйти. Проверьте соединение и повторите.');
      guest();
    },
    async listPublishedBooks() {
      await connection();
      return rows(() => sdk.from('catalogue_books').select(PUBLIC_FIELDS).eq('published', true).order('id'));
    },
    async getPublishedBook(id) {
      await connection();
      return response(sdk.from('catalogue_books').select(BOOK_FIELDS).eq('id', id).eq('published', true).single(), 'Книга сейчас недоступна. Обновите библиотеку.');
    },
    async adminListBooks() { return adminData(() => rows(() => sdk.from('catalogue_books').select(ADMIN_FIELDS).order('id'))); },
    async adminGetBook(id) { return adminData(() => response(sdk.from('catalogue_books').select(BOOK_FIELDS).eq('id', id).single(), 'Не удалось открыть книгу для редактирования.')); },
    async adminListUsers() { return adminData(() => rows(() => sdk.rpc('admin_list_users').order('id'))); },
    async adminSaveBook(book) {
      // Explicit fields keep client-supplied roles, timestamps and unrelated data out of writes.
      const { id, title, author, year, source_url, chapters, total_words, published } = book;
      return adminData(() => response(sdk.from('catalogue_books').upsert({ id, title, author, year, source_url, chapters, total_words, published }).select(BOOK_FIELDS).single(), 'Не удалось сохранить книгу. Проверьте текст и поля.'));
    },
    async adminSetPublished(id, published) {
      return adminData(() => response(sdk.from('catalogue_books').update({ published: Boolean(published) }).eq('id', id).select(BOOK_FIELDS).single(), 'Не удалось изменить публикацию книги.'));
    },
    destroy() {
      disposed = true; generation += 1;
      clearTimeout(authTimer); authSubscription?.unsubscribe(); listeners.clear();
      sdk?.auth.stopAutoRefresh();
    },
  };
}
