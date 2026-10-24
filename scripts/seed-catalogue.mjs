import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { tokenizeChapters } from '../js/reader.mjs';

// Operator-only script. The secret is read from the process and is never written to site files.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key || !url.startsWith('https://')) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in a private .env file. See backend/README.md.');
  process.exit(1);
}
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const root = new URL('../books/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
for (const entry of manifest) {
  const book = JSON.parse(await readFile(new URL(entry.file, root), 'utf8'));
  const row = {
    id: entry.id, title: book.title, author: book.author || '', year: entry.year || null,
    source_url: entry.source?.url || null, chapters: book.chapters,
    total_words: tokenizeChapters(book.chapters).totalWords, published: true,
  };
  // Re-running the seed preserves edits and visibility changes made in the admin panel.
  const { error } = await client.from('catalogue_books').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  if (error) {
    console.error(`Could not add ${entry.id}: database code ${error.code || 'unknown'}. Check the migration and connection.`);
    process.exit(1);
  }
  console.log(`Ready: ${entry.id}`);
}
console.log('The sixteen classics are ready; existing entries were preserved.');
