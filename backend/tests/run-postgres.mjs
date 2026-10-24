import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// An isolated real PostgreSQL cluster; never connects to a hosted/project database.
const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '..');
const directory = mkdtempSync('/tmp/anchor-rls-');
const data = join(directory, 'data');
const log = join(directory, 'postgres.log');
const bin = (name) => process.env.ANCHOR_PG_BIN ? join(process.env.ANCHOR_PG_BIN, name) : name;
const connection = ['--host', directory, '--port', '55439', '--username', 'postgres', '--dbname', 'postgres', '--no-psqlrc', '--set=ON_ERROR_STOP=1'];
const env = { ...process.env, PGOPTIONS: '', PGPASSWORD: '', PGHOST: directory, PGPORT: '55439' };
let started = false;
let bootstrapChecks = 0;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  return result;
}
function sqlFile(path) { return run(bin('psql'), [...connection, '--file', path]); }
function bootstrap(email, expectedError, role) {
  const result = spawnSync(bin('psql'), [...connection, `--set=admin_email=${email}`, '--file', join(backend, 'scripts/grant-admin.sql')], {
    encoding: 'utf8', env: { ...env, PGOPTIONS: role ? `-c role=${role}` : '' },
  });
  if (result.error) throw result.error;
  if (expectedError) {
    assert.notEqual(result.status, 0, 'Unsafe bootstrap unexpectedly succeeded');
    assert.match(result.stderr, expectedError);
  } else assert.equal(result.status, 0, result.stderr);
  bootstrapChecks += 1;
}
try {
  run(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  run(bin('pg_ctl'), ['-D', data, '-l', log, '-w', '-t', '15', '-o', `-F -k ${directory} -h '' -p 55439`, 'start']);
  started = true;
  sqlFile(join(here, 'auth-fixture.sql'));
  sqlFile(join(backend, 'migrations/001_accounts_catalogue.sql'));
  bootstrap('pending@example.test', /Confirm the account email/);
  bootstrap('absent@example.test', /Expected exactly one/);
  bootstrap("x'); DELETE FROM auth.users; --", /Expected exactly one/);
  bootstrap('reader@example.test', /Run this script as the database owner/, 'authenticated');
  bootstrap('reader@example.test', /Run this script as the database owner/, 'service_role');
  bootstrap('admin@example.test');
  bootstrap('admin@example.test');
  bootstrap("o'reilly@example.test");
  run(bin('psql'), [...connection, '--command', "update public.profiles set display_name='Kept on rerun' where id='00000000-0000-0000-0000-000000000001'"]);
  sqlFile(join(backend, 'migrations/001_accounts_catalogue.sql'));
  const result = sqlFile(join(here, 'rls.sql'));
  const checks = result.stderr.match(/PASS:/g)?.length || 0;
  assert.ok(checks >= 55, `Expected a complete RLS suite, received ${checks} checks`);
  console.log(`${checks} PostgreSQL RLS/validation checks + ${bootstrapChecks} bootstrap checks passed. Migration applied twice.`);
  console.log('Auth tables/JWT identity are test fixtures; hosted Supabase Auth, email delivery and REST transport were not exercised.');
} catch (error) {
  console.error(error.message);
  if (!started) { try { console.error(readFileSync(log, 'utf8')); } catch {} }
  process.exitCode = 1;
} finally {
  if (started) {
    const stopped = spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8', env });
    if (stopped.status !== 0) { console.error(`Could not stop test cluster at ${directory}: ${stopped.stderr}`); process.exitCode = 1; }
    else rmSync(directory, { recursive: true, force: true });
  } else rmSync(directory, { recursive: true, force: true });
}
