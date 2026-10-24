import { setupAccountUI } from '../js/account-ui.mjs';
import { setupAdminUI } from '../js/admin-ui.mjs';
import { importBook, bookFromText } from '../js/importers.mjs';

// Visual fixture only. No SDK, remote connection, session, password or persistent writes.
const isAdmin = new URL(location.href).searchParams.get('view') === 'admin';
const state = { configured: true, loading: false, user: isAdmin ? { id: 'preview-owner', email: 'owner@example.test', displayName: 'Редактор' } : null, isAdmin, recovery: false };
const samples = [
  { id: 'preview-river', title: 'Мастерская у реки', author: 'Демонстрационный текст', year: null, source_url: null, chapters: [{ title: 'Начало', paragraphs: ['В небольшом городе решили открыть мастерскую для соседей.'] }], total_words: 9, published: true },
  { id: 'preview-flowers', title: 'Утренние цветы', author: 'Демонстрационный текст', year: null, source_url: null, chapters: [{ title: 'Начало', paragraphs: ['Утром на площади открыли цветочный киоск.'] }], total_words: 6, published: false },
];
const unavailable = async () => { throw new Error('Это предпросмотр. Настоящий вход появится после подключения Supabase.'); };
const client = {
  getState: () => ({ ...state }), subscribe: callback => { callback({ ...state }); return () => {}; },
  signIn: unavailable, signUp: unavailable, requestPasswordReset: unavailable, updatePassword: unavailable, updateProfile: unavailable, signOut: unavailable,
  adminListBooks: async () => samples.map(({ chapters, ...metadata }) => metadata),
  adminGetBook: async id => structuredClone(samples.find(book => book.id === id)),
  adminListUsers: async () => [{ id: 'preview-owner', email: 'owner@example.test', display_name: 'Редактор', is_admin: true, email_confirmed_at: '2026-10-24T10:00:00Z', created_at: '2026-10-24T10:00:00Z', last_sign_in_at: '2026-10-24T10:00:00Z' }],
  adminSaveBook: unavailable, adminSetPublished: unavailable,
};
const admin = setupAdminUI({ client, importBook, bookFromText });
const account = setupAccountUI({ client, onAdmin: () => admin.open() });
if (isAdmin) await admin.open();
else { account.open(); document.getElementById('account-signup').click(); }
for (const dialog of document.querySelectorAll('dialog')) {
  const note = document.createElement('p');
  note.textContent = 'ПРЕДПРОСМОТР · ТЕСТОВЫЕ ДАННЫЕ';
  note.style.cssText = 'margin:0;padding:10px 16px;background:var(--bg);color:var(--muted);font:10px/1.4 system-ui;text-align:center;flex-shrink:0';
  dialog.prepend(note);
}
