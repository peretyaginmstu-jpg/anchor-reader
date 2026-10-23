import { unzipSync, strFromU8 } from '../vendor/fflate.mjs';

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10000;
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'tr', 'td', 'th', 'title', 'subtitle', 'epigraph', 'poem', 'stanza', 'v', 'cite', 'text-author', 'empty-line']);
const OMIT = new Set(['script', 'style', 'head', 'nav', 'iframe', 'object', 'embed', 'svg', 'canvas', 'form', 'button', 'input', 'select', 'textarea', 'binary', 'description', 'annotation']);
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c >>> 0;
}

class ImportError extends Error {}
const fail = message => { throw new ImportError(message); };
const clean = text => text.replace(/\uFEFF/g, '').replace(/\s+/gu, ' ').trim();
const local = node => (node.localName || node.nodeName || '').toLowerCase();
const children = (node, name) => Array.from(node.children || []).filter(el => local(el) === name);
const descendants = (node, name) => Array.from(node.getElementsByTagName('*')).filter(el => local(el) === name);
const first = (node, name) => descendants(node, name)[0];
const titleOfFile = file => clean(file.name.replace(/\.[^.]+$/, '')) || 'Без названия';

function makeBook(title, author, chapters) {
  const nonempty = chapters.map(chapter => ({ title: clean(chapter.title) || 'Текст', paragraphs: chapter.paragraphs.map(clean).filter(Boolean) })).filter(chapter => chapter.paragraphs.length);
  if (!nonempty.length) fail('В книге не найден текст для чтения.');
  const now = Date.now();
  return { id: globalThis.crypto?.randomUUID?.() || `book-${now}-${Math.random().toString(36).slice(2)}`, title: clean(title) || 'Без названия', author: clean(author || ''), chapters: nonempty, createdAt: now, updatedAt: now, position: 0 };
}

/** Create a serializable, local-only book from pasted plain text. */
export function bookFromText(text, title = 'Мой текст') {
  if (typeof text !== 'string') fail('Вставьте текст для чтения.');
  if (new Blob([text]).size > MAX_TEXT_BYTES) fail('Текст слишком большой. Максимум — 50 МБ.');
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n[\t \u00a0]*\n+/u).map(clean).filter(Boolean);
  return makeBook(title, '', [{ title: 'Текст', paragraphs }]);
}

function decode(bytes, encoding = 'utf-8', declared = false) {
  let label = encoding;
  if (declared) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
    else if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) label = 'utf-16le';
    else if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) label = 'utf-16be';
    else {
      const prefix = Array.from(bytes.subarray(0, 1024), c => String.fromCharCode(c)).join('');
      label = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : prefix.match(/<\?xml\b[^>]*\bencoding\s*=\s*['"]([^'"]+)['"]/i)?.[1] || 'utf-8';
    }
  }
  if (/^(?:cp|windows-?)1251$/i.test(label)) label = 'windows-1251';
  try { return new TextDecoder(label, { fatal: true }).decode(bytes); }
  catch {
    if (!declared && label === 'utf-8') fail('Не удалось прочитать UTF-8. Для старой русской книги выберите Windows-1251 и загрузите файл снова.');
    fail(`Не удалось прочитать кодировку «${label}»: файл повреждён или кодировка не поддерживается.`);
  }
}

function xml(text, label) {
  // XML DOMParser is inert: it never attaches book markup to the page or loads images.
  // Internal DTDs and entity declarations are unnecessary for books and can expand data.
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(text)) fail(`${label}: внутренние объявления XML не поддерживаются.`);
  const withoutDoctype = text.replace(/<!DOCTYPE[^>]*>/gi, '');
  const doc = new DOMParser().parseFromString(withoutDoctype, 'application/xml');
  if (!doc.documentElement || descendants(doc, 'parsererror').length) fail(`${label}: повреждённый XML.`);
  return doc;
}

function paragraphsFrom(root) {
  const paragraphs = [];
  let buffer = '';
  const flush = () => { const text = clean(buffer); if (text) paragraphs.push(text); buffer = ''; };
  function visit(node) {
    if (node.nodeType === 3 || node.nodeType === 4) { buffer += node.textContent; return; }
    if (node.nodeType !== 1) return;
    const name = local(node);
    const type = node.getAttribute('epub:type') || node.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '';
    if (OMIT.has(name) || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || /(?:^|\s)(?:toc|landmarks|page-list|footnote|endnote)(?:\s|$)/.test(type)) return;
    if (name === 'br' || BLOCKS.has(name)) flush();
    for (const child of node.childNodes) visit(child);
    if (BLOCKS.has(name)) flush();
  }
  visit(root);
  flush();
  return paragraphs;
}

function fromFB2(bytes, fallbackTitle) {
  const doc = xml(decode(bytes, 'utf-8', true), 'FB2');
  if (local(doc.documentElement) !== 'fictionbook') fail('Файл FB2 должен содержать книгу FictionBook.');
  const root = doc.documentElement;
  const info = first(root, 'title-info');
  const title = info && first(info, 'book-title')?.textContent || fallbackTitle;
  const authors = info ? children(info, 'author').map(author => {
    const parts = ['first-name', 'middle-name', 'last-name'].map(name => children(author, name)[0]?.textContent || '').map(clean).filter(Boolean);
    return parts.join(' ') || children(author, 'nickname')[0]?.textContent || '';
  }).filter(Boolean).join(', ') : '';
  const bodies = children(root, 'body').filter(body => !/^(notes?|comments?|footnotes?|endnotes?)$/i.test(body.getAttribute('name') || ''));
  const chapters = [];
  for (const body of bodies) {
    // Group top-level sections. Nested sections retain their headings and paragraph order.
    let preface = [];
    const flushPreface = () => { if (preface.length) { chapters.push({ title: 'Вступление', paragraphs: preface }); preface = []; } };
    for (const node of body.children) {
      if (local(node) === 'section') {
        flushPreface();
        const titleNode = children(node, 'title')[0];
        chapters.push({ title: titleNode ? paragraphsFrom(titleNode).join(' ') : `Глава ${chapters.length + 1}`, paragraphs: paragraphsFrom(node) });
      } else preface.push(...paragraphsFrom(node));
    }
    flushPreface();
  }
  return makeBook(title, authors, chapters);
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipIndex(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  let end = -1;
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 65557); i >= min; i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail('EPUB повреждён: не найден каталог ZIP.');
  const count = u16(end + 10), start = u32(end + 16), size = u32(end + 12);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 65535 || start === 0xffffffff || size === 0xffffffff) fail('Этот вариант ZIP не поддерживается. Сохраните книгу как обычный EPUB.');
  if (count > MAX_ZIP_ENTRIES || start + size > end) fail('EPUB повреждён или содержит слишком много файлов.');
  const entries = new Map();
  let offset = start;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > start + size || u32(offset) !== 0x02014b50) fail('EPUB повреждён: неверный каталог ZIP.');
    const flags = u16(offset + 8), method = u16(offset + 10), compressed = u32(offset + 20), unpacked = u32(offset + 24), nameLength = u16(offset + 28);
    const next = offset + 46 + nameLength + u16(offset + 30) + u16(offset + 32), localOffset = u32(offset + 42);
    if (next > start + size || localOffset + 30 > start || u32(localOffset) !== 0x04034b50 || compressed === 0xffffffff || unpacked === 0xffffffff) fail('EPUB повреждён: неверные размеры файлов ZIP.');
    let name;
    try { name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength), !(flags & 2048)); }
    catch { fail('EPUB повреждён: неверное имя файла.'); }
    if (!name || name.includes('\0') || name.includes('\\') || /^\/|^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.') || entries.has(name)) fail('EPUB содержит небезопасные или повторяющиеся пути.');
    const dataOffset = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    if (dataOffset + compressed > start) fail('EPUB повреждён: неполные данные ZIP.');
    entries.set(name, { flags, method, compressed, unpacked, crc: u32(offset + 16) });
    offset = next;
  }
  if (offset !== start + size) fail('EPUB повреждён: размер каталога ZIP не совпадает.');
  return entries;
}

function resolvePath(basePath, href) {
  let path;
  try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { fail('EPUB содержит неверную ссылку на главу.'); }
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(path) || path.includes('\\') || path.includes('\0')) fail('EPUB содержит неподдерживаемую ссылку на главу.');
  const parts = basePath ? basePath.split('/').slice(0, -1) : [];
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) fail('EPUB содержит путь за пределами книги.'); parts.pop(); }
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

function xhtmlXML(text) {
  // Decode HTML named entities one at a time, without ever parsing book HTML.
  // This also supports older EPUB 2 files that declare XHTML's external DTD.
  const textarea = document.createElement('textarea');
  return text.replace(/&([a-z][a-z\d]+);/gi, (match, entity) => {
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(entity)) return match;
    textarea.innerHTML = match;
    const decoded = textarea.value;
    return decoded === match ? match : Array.from(decoded, char => `&#${char.codePointAt(0)};`).join('');
  });
}

function fromEPUB(bytes, fallbackTitle) {
  const entries = zipIndex(bytes), cache = new Map();
  let textBytes = 0;
  function extract(paths) {
    const needed = new Set(paths.filter(path => !cache.has(path)));
    for (const path of needed) {
      const entry = entries.get(path);
      if (!entry) fail(`EPUB повреждён: не найден файл «${path}».`);
      if (entry.flags & 1) fail('Эта EPUB-книга защищена DRM или паролем. Загрузите книгу без защиты.');
      if (entry.method !== 0 && entry.method !== 8) fail('Метод сжатия этой EPUB-книги не поддерживается.');
      if (entry.method === 0 && entry.unpacked !== entry.compressed) fail('EPUB повреждён: неверный размер несжатого файла.');
      textBytes += entry.unpacked;
      if (textBytes > MAX_TEXT_BYTES) fail('Распакованный текст EPUB превышает 50 МБ. Выберите книгу меньшего размера.');
    }
    let files;
    try { files = unzipSync(bytes, { filter: entry => needed.has(entry.name) }); }
    catch { fail('Не удалось распаковать EPUB. Возможно, книга повреждена или защищена DRM.'); }
    for (const path of needed) {
      const data = files[path], entry = entries.get(path);
      if (!(data instanceof Uint8Array) || data.length !== entry.unpacked || crc32(data) !== entry.crc) fail('EPUB повреждён: контрольная сумма файла не совпадает.');
      cache.set(path, data);
    }
  }
  if (entries.has('META-INF/encryption.xml')) {
    extract(['META-INF/encryption.xml']);
    const encryption = xml(decode(cache.get('META-INF/encryption.xml'), 'utf-8', true), 'EPUB');
    const methods = descendants(encryption, 'encryptionmethod');
    if (!methods.length || methods.some(method => !['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(method.getAttribute('Algorithm')))) fail('Эта EPUB-книга защищена DRM. Загрузите книгу без защиты.');
  }
  extract(['META-INF/container.xml']);
  const container = xml(decode(cache.get('META-INF/container.xml'), 'utf-8', true), 'EPUB');
  const rootfiles = descendants(container, 'rootfile');
  const rootfile = rootfiles.find(node => node.getAttribute('media-type') === 'application/oebps-package+xml') || rootfiles[0];
  if (!rootfile?.getAttribute('full-path')) fail('EPUB повреждён: не найдено описание книги.');
  const opfPath = resolvePath('', rootfile.getAttribute('full-path'));
  extract([opfPath]);
  const opf = xml(decode(cache.get(opfPath), 'utf-8', true), 'EPUB');
  if (local(opf.documentElement) !== 'package') fail('EPUB повреждён: неверное описание книги.');
  const metadata = first(opf, 'metadata'), manifest = first(opf, 'manifest'), spine = first(opf, 'spine');
  if (!manifest || !spine) fail('EPUB повреждён: отсутствует порядок глав.');
  const items = new Map(children(manifest, 'item').map(item => [item.getAttribute('id'), item]));
  const refs = children(spine, 'itemref').filter(ref => ref.getAttribute('linear') !== 'no');
  const chapterSources = [];
  for (const ref of refs) {
    const item = items.get(ref.getAttribute('idref'));
    if (!item) fail('EPUB повреждён: глава отсутствует в описании книги.');
    if ((item.getAttribute('properties') || '').split(/\s+/).includes('nav')) continue;
    if (!['application/xhtml+xml', 'text/html', 'text/plain'].includes(item.getAttribute('media-type'))) continue;
    chapterSources.push({ path: resolvePath(opfPath, item.getAttribute('href') || ''), type: item.getAttribute('media-type') });
  }
  extract(chapterSources.map(chapter => chapter.path));
  const chapters = chapterSources.map(({ path, type }, index) => {
    const text = decode(cache.get(path), 'utf-8', true);
    if (type === 'text/plain') return { title: `Глава ${index + 1}`, paragraphs: text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(clean).filter(Boolean) };
    const content = xml(xhtmlXML(text), `EPUB, глава ${index + 1}`), body = first(content, 'body');
    if (!body) return { title: `Глава ${index + 1}`, paragraphs: [] };
    const heading = descendants(body, 'h1')[0] || descendants(body, 'h2')[0];
    return { title: heading?.textContent || first(content, 'title')?.textContent || `Глава ${index + 1}`, paragraphs: paragraphsFrom(body) };
  });
  return makeBook(metadata && first(metadata, 'title')?.textContent || fallbackTitle, metadata ? descendants(metadata, 'creator').map(node => clean(node.textContent)).filter(Boolean).join(', ') : '', chapters);
}

/** Import a File without executing its markup, uploading it, or changing active state. */
export async function importBook(file, { encoding = 'utf-8' } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') fail('Выберите файл книги.');
  if (!file.size) fail('Файл пуст. Выберите книгу с текстом.');
  if (file.size > MAX_FILE_BYTES) fail('Файл слишком большой. Максимум — 30 МБ.');
  const extension = file.name?.split('.').pop()?.toLowerCase();
  if (!['txt', 'fb2', 'epub'].includes(extension)) fail('Этот формат не поддерживается. Загрузите EPUB, FB2 или TXT.');
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { fail('Не удалось открыть файл. Выберите его снова.'); }
  try {
    if (extension === 'txt') return bookFromText(decode(bytes, encoding), titleOfFile(file));
    if (extension === 'fb2') return fromFB2(bytes, titleOfFile(file));
    return fromEPUB(bytes, titleOfFile(file));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    fail('Не удалось прочитать книгу: файл повреждён или его структура не поддерживается.');
  }
}
