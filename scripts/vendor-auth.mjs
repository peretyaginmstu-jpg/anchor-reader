import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  stdin: { contents: 'export { createClient } from "@supabase/supabase-js";', resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  legalComments: 'linked', outfile: 'vendor/supabase.mjs',
  banner: { js: '/*! Local bundle: @supabase/supabase-js 2.118.0. See supabase-LICENSES.txt. */' },
});
const packages = ['@supabase/supabase-js', '@supabase/auth-js', '@supabase/postgrest-js', '@supabase/functions-js', '@supabase/realtime-js', '@supabase/phoenix', '@supabase/storage-js', 'iceberg-js', 'tslib'];
const licenses = [];
for (const name of packages) {
  const dir = `node_modules/${name}`;
  const metadata = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  let license;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'CopyrightNotice.txt']) {
    try { license = await readFile(`${dir}/${file}`, 'utf8'); break; } catch { /* Check next conventional name. */ }
  }
  if (!license) throw new Error(`License text is missing for ${name}`);
  licenses.push(`${name}@${metadata.version} (${metadata.license})\n${license.replace(/\r\n/g, '\n')}`);
}
await writeFile('vendor/supabase-LICENSES.txt', licenses.join('\n\n--------------------\n\n'));
