import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient, validateAccountConfig } from '../js/account-client.mjs';

const config = { supabaseUrl: 'https://reader.supabase.co', publishableKey: 'sb_publishable_test' };
const jwt = (role) => `a.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.c`;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function fixture({ user = null, role = false, initializationError = null } = {}) {
  const calls = [];
  let listener;
  let roleError = null;
  let delayedRole = null;
  const data = { user, role };
  const success = (value) => Promise.resolve({ data: value, error: null });
  function query(table) {
    const entry = { table, operations: [] }; calls.push(entry);
    const chain = {
      select(value) { entry.operations.push(['select', value]); return chain; },
      eq(key, value) { entry.operations.push(['eq', key, value]); return chain; },
      order(value) { entry.operations.push(['order', value]); return chain; },
      update(value) { entry.operations.push(['update', value]); return chain; },
      upsert(value) { entry.operations.push(['upsert', value]); return chain; },
      maybeSingle() { return success({ display_name: 'Читатель' }); },
      single() { return success(table === 'profiles' ? { id: data.user?.id } : { id: 'cloud-book', published: true }); },
      range() { return success([]); },
    };
    return chain;
  }
  const sdk = {
    from: query,
    rpc(name) {
      calls.push({ rpc: name });
      if (name === 'is_admin' && delayedRole) return delayedRole;
      const result = roleError ? Promise.resolve({ data: null, error: roleError }) : success(name === 'is_admin' ? data.role : []);
      result.range = () => result;
      result.order = () => result;
      return result;
    },
    auth: {
      initialize() { return Promise.resolve({ error: initializationError }); },
      onAuthStateChange(callback) { listener = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      getSession() { return success({ session: data.user ? { user: data.user } : null }); },
      getUser() { return success({ user: data.user }); },
      signInWithPassword(value) { calls.push({ signIn: value }); data.user = { id: 'reader', email: value.email }; return success({ user: data.user, session: { user: data.user } }); },
      signUp(value) { calls.push({ signUp: value }); return success({ user: { id: 'new' }, session: null }); },
      resetPasswordForEmail(email, options) { calls.push({ reset: email, options }); return success({}); },
      updateUser(value) { calls.push({ updateUser: value }); return success({ user: data.user }); },
      signOut(options) { calls.push({ signOut: options }); data.user = null; listener('SIGNED_OUT', null); return success({}); },
      stopAutoRefresh() {},
    },
  };
  const client = createAccountClient({ config, redirectUrl: 'https://example.org/anchor-reader/', loadSDK: async () => ({ createClient: (...args) => { calls.push({ initialization: args }); return sdk; } }) });
  return { client, calls, data, roleError(value) { roleError = value; }, delayRole(value) { delayedRole = value; }, event: (...args) => listener(...args) };
}

test('account config accepts public keys and rejects secret keys and unsafe endpoints', () => {
  assert.equal(validateAccountConfig({ supabaseUrl: '', publishableKey: '' }), null);
  assert.deepEqual(validateAccountConfig(config), config);
  assert.equal(validateAccountConfig({ ...config, publishableKey: jwt('anon') }).publishableKey, jwt('anon'));
  for (const key of ['sb_secret_private', jwt('service_role'), jwt('authenticated'), 'random']) assert.throws(() => validateAccountConfig({ ...config, publishableKey: key }));
  for (const url of ['http://external.example', 'https://user:pass@reader.supabase.co', 'https://reader.supabase.co/?token=x', 'https://reader.supabase.co/auth']) assert.throws(() => validateAccountConfig({ ...config, supabaseUrl: url }));
  assert.equal(validateAccountConfig({ ...config, supabaseUrl: 'http://localhost:54321' }).supabaseUrl, 'http://localhost:54321');
});

test('expired callback initialization errors are surfaced instead of silently showing a guest', async () => {
  const f = fixture({ initializationError: { code: 'flow_state_expired', status: 400 } });
  try {
    await f.client.ready;
    assert.equal(f.client.getState().user, null);
    assert.equal(f.client.getState().isAdmin, false);
    assert.match(f.client.getState().error, /устарела/u);
    f.event('INITIAL_SESSION', null);
    assert.match(f.client.getState().error, /устарела/u);
  } finally { f.client.destroy(); }
});

test('unconfigured accounts never load the SDK or pretend to authenticate', async () => {
  let loaded = false;
  const client = createAccountClient({ config: { supabaseUrl: '', publishableKey: '' }, loadSDK: async () => { loaded = true; } });
  await client.ready;
  assert.equal(loaded, false);
  assert.deepEqual(client.getState(), { configured: false, loading: false, user: null, isAdmin: false, recovery: false, error: '' });
  await assert.rejects(client.signIn('reader@example.org', 'password'), /не подключены/u);
  client.destroy();
});

test('administrator metadata never grants access; the verified database result controls the role', async () => {
  const f = fixture({ user: { id: 'reader', email: 'reader@example.org', user_metadata: { role: 'admin', is_admin: true } } });
  try {
    await f.client.ready;
    assert.equal(f.client.getState().user.displayName, 'Читатель');
    assert.equal(f.client.getState().isAdmin, false);
    await assert.rejects(f.client.adminListUsers(), error => error.status === 403);
    assert.equal(f.calls.filter(c => c.rpc === 'admin_list_users').length, 0);
    const profileQuery = f.calls.find(c => c.table === 'profiles');
    assert.ok(profileQuery.operations.some(c => c[0] === 'eq' && c[1] === 'id' && c[2] === 'reader'));
  } finally { f.client.destroy(); }
});

test('signup preserves the password and sends only display name metadata and the fixed callback URL', async () => {
  const f = fixture();
  try {
    await f.client.ready;
    const result = await f.client.signUp(' reader@example.org ', '  Secret pass  ', ' Маша ');
    assert.deepEqual(result, { confirmationRequired: true });
    assert.deepEqual(f.calls.find(c => c.signUp).signUp, { email: 'reader@example.org', password: '  Secret pass  ', options: { data: { display_name: 'Маша' }, emailRedirectTo: 'https://example.org/anchor-reader/' } });
    assert.equal(f.client.getState().user, null);
    await assert.rejects(f.client.signUp('reader@example.org', 'short'), /10/u);
    await assert.rejects(f.client.signIn('not-email', 'password'), /почты/u);
    await f.client.requestPasswordReset(' reader@example.org ');
    assert.deepEqual(f.calls.find(c => c.reset), { reset: 'reader@example.org', options: { redirectTo: 'https://example.org/anchor-reader/' } });
  } finally { f.client.destroy(); }
});

test('profile updates cannot include roles and signout clears the session locally', async () => {
  const f = fixture({ user: { id: 'reader', email: 'reader@example.org' }, role: true });
  try {
    await f.client.ready;
    const snapshot = f.client.getState(); snapshot.user.email = 'changed@example.org'; snapshot.isAdmin = false;
    assert.equal(f.client.getState().isAdmin, true);
    assert.equal(f.client.getState().user.email, 'reader@example.org');
    await f.client.updateProfile(' Мария ');
    assert.equal(f.client.getState().user.displayName, 'Мария');
    const write = f.calls.find(c => c.table === 'profiles' && c.operations.some(op => op[0] === 'update'));
    assert.deepEqual(write.operations.find(op => op[0] === 'update')[1], { display_name: 'Мария' });
    await f.client.signOut();
    assert.equal(f.client.getState().user, null);
    assert.equal(f.client.getState().isAdmin, false);
    assert.deepEqual(f.calls.find(c => c.signOut).signOut, { scope: 'local' });
  } finally { f.client.destroy(); }
});

test('admin methods recheck the role and refuse requests after revocation', async () => {
  const f = fixture({ user: { id: 'admin', email: 'admin@example.org' }, role: true });
  try {
    await f.client.ready;
    assert.equal(f.client.getState().isAdmin, true);
    await f.client.adminListUsers();
    assert.ok(f.calls.some(c => c.rpc === 'admin_list_users'));
    f.data.role = false;
    await assert.rejects(f.client.adminSaveBook({ id: 'cloud-book', title: 'Title' }), error => error.code === '42501');
    assert.equal(f.client.getState().isAdmin, false);
    assert.equal(f.calls.filter(c => c.table === 'catalogue_books').length, 0);
  } finally { f.client.destroy(); }
});

test('stale account refresh cannot restore a user or admin role after signout', async () => {
  const f = fixture({ user: { id: 'admin', email: 'admin@example.org' }, role: true });
  try {
    await f.client.ready;
    let resolveRole;
    f.delayRole(new Promise(resolve => { resolveRole = resolve; }));
    f.event('TOKEN_REFRESHED', { user: f.data.user });
    await tick();
    await f.client.signOut();
    resolveRole({ data: true, error: null });
    await tick();
    assert.equal(f.client.getState().user, null);
    assert.equal(f.client.getState().isAdmin, false);
  } finally { f.client.destroy(); }
});

test('recovery mode requires a signed-in verified recovery session and leaves it after password update', async () => {
  const f = fixture({ user: { id: 'reader', email: 'reader@example.org' } });
  try {
    await f.client.ready;
    f.event('PASSWORD_RECOVERY', { user: f.data.user });
    await tick();
    assert.equal(f.client.getState().recovery, true);
    await f.client.updatePassword('  New password  ');
    assert.equal(f.client.getState().recovery, false);
    assert.deepEqual(f.calls.find(c => c.updateUser).updateUser, { password: '  New password  ' });
  } finally { f.client.destroy(); }
});
