import { readFile, writeFile } from 'node:fs/promises';
import { validateAccountConfig } from '../js/account-client.mjs';

const [supabaseUrl, publishableKey] = process.argv.slice(2);
if (!supabaseUrl || !publishableKey) {
  console.error('Usage: node scripts/configure-accounts.mjs https://PROJECT.supabase.co sb_publishable_PUBLIC_KEY');
  process.exit(1);
}
const config = validateAccountConfig({ supabaseUrl, publishableKey });
await writeFile(new URL('../js/account-config.mjs', import.meta.url), `// Public connection settings. Never add a secret/service_role key here.\nexport const ACCOUNT_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`);
// Refresh every import edge so a newly connected project cannot reuse a cached blank config.
const version = `accounts-${Date.now()}`;
for (const [file, pattern, replacement] of [
  ['../index.html', /app\.mjs\?v=[^"']+/u, `app.mjs?v=${version}`],
  ['../js/app.mjs', /account-client\.mjs\?v=[^"']+/u, `account-client.mjs?v=${version}`],
  ['../js/account-client.mjs', /account-config\.mjs(?:\?v=[^"']+)?/u, `account-config.mjs?v=${version}`],
]) {
  const target = new URL(file, import.meta.url);
  await writeFile(target, (await readFile(target, 'utf8')).replace(pattern, replacement));
}
console.log('Public account configuration saved. Apply the database migration before publishing.');
