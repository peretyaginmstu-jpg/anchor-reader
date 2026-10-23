import { importBook, bookFromText } from '../js/importers.mjs';
import { zipSync, strToU8 } from '../vendor/fflate.mjs';

const encoder = new TextEncoder();
const assert = (condition, message = 'Проверка не пройдена') => { if (!condition) throw new Error(message); };
const same = (actual, expected) => assert(JSON.stringify(actual) === JSON.stringify(expected), `Ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
const file = (text, name) => new File([typeof text === 'string' ? encoder.encode(text) : text], name);
const allText = book => book.chapters.flatMap(chapter => chapter.paragraphs).join('\n');
const expectError = async (operation, pattern) => {
  try { await operation(); } catch (error) { assert(pattern.test(error.message), `Неожиданная ошибка: ${error.message}`); return; }
  throw new Error('Ожидалась ошибка импорта');
};
const cp1251 = text => Uint8Array.from(Array.from(text, char => {
  const code = char.charCodeAt(0);
  if (code < 128) return code;
  if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
  if (char === 'Ё') return 0xa8;
  if (char === 'ё') return 0xb8;
  throw new Error(`Нет символа CP1251 в фикстуре: ${char}`);
}));
const utf16 = (text, bigEndian = false) => {
  const data = new Uint8Array(2 + text.length * 2), view = new DataView(data.buffer);
  view.setUint16(0, 0xfeff, !bigEndian);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), !bigEndian);
  return data;
};
const fb2 = (encoding = 'utf-8') => `<?xml version="1.0" encoding="${encoding}"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Русская книга</book-title><author><first-name>Анна</first-name><last-name>Иванова</last-name></author><annotation><p>Аннотация вне текста</p></annotation></title-info></description><body><section><title><p>Первая глава</p></title><p>Привет, ёж!</p><p>Следующий <strong>абзац</strong>.</p><section><title><p>Подглава</p></title><p>Внутренний текст.</p></section></section></body><body name="notes"><section><p>Служебные примечания</p></section></body><binary id="image">IGNORE_BINARY</binary></FictionBook>`;
const xhtml = (title, contents) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title><style>HIDDEN_CSS</style></head><body><h1>${title}</h1>${contents}</body></html>`;
function epubFiles() {
  // ZIP order deliberately differs from spine order. Nav is also in the spine.
  return {
    mimetype: strToU8('application/epub+zip'),
    'OEBPS/second.xhtml': strToU8(xhtml('Вторая', '<p>Текст второй главы.</p>')),
    'OEBPS/nav.xhtml': strToU8(xhtml('Оглавление', '<nav><p>НЕ ЧИТАТЬ НАВИГАЦИЮ</p></nav>')),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/book.opf': strToU8('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Порядок книги</dc:title><dc:creator>Автор</dc:creator></metadata><manifest><item id="two" href="second.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="one" href="first.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="nav"/><itemref idref="one"/><itemref idref="two"/></spine></package>'),
    'OEBPS/first.xhtml': strToU8(xhtml('Первая', '<p>Первый&nbsp;абзац со словом при<strong>вет</strong>.</p><div>Второй блок.</div><p>Третий блок.</p>')),
  };
}
const epub = files => file(zipSync(files || epubFiles()), 'test.epub');

/** Execute in a real browser; returns serializable results and leaves app state alone. */
export async function runImporterTests() {
  const results = [];
  const test = async (name, run) => {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error?.stack || error) }); }
  };

  await test('Вставка текста: абзацы, Unicode и контракт Book', () => {
    const book = bookFromText('  Приве\u0301т, мир!\r\nСтрока.\r\n\r\nВторой абзац.  ', 'Название');
    same(book.chapters[0].paragraphs, ['Приве\u0301т, мир! Строка.', 'Второй абзац.']);
    assert(book.id && book.createdAt > 0 && book.updatedAt === book.createdAt && book.position === 0 && book.author === '');
    assert(book.title === 'Название');
    assert(book.id !== bookFromText('Другая книга').id);
  });
  await test('TXT UTF-8', async () => {
    const book = await importBook(file('\ufeffЁжик читает книгу.\n\nВторой абзац.', 'Имя.txt'));
    same(book.title, 'Имя');
    same(book.chapters[0].paragraphs, ['Ёжик читает книгу.', 'Второй абзац.']);
  });
  await test('TXT Windows-1251 выбран вручную', async () => {
    const book = await importBook(file(cp1251('Привет, ёж!\n\nЕщё текст.'), 'cp1251.txt'), { encoding: 'windows-1251' });
    same(book.chapters[0].paragraphs, ['Привет, ёж!', 'Ещё текст.']);
  });
  await test('TXT неверная кодировка: понятная ошибка', () => expectError(() => importBook(file(cp1251('Привет'), 'wrong.txt')), /Windows-1251/));
  await test('FB2 UTF-8: автор, секции, без notes/description/binary', async () => {
    const book = await importBook(file(fb2(), 'test.fb2'));
    same(book.title, 'Русская книга'); same(book.author, 'Анна Иванова');
    same(book.chapters[0].title, 'Первая глава');
    assert(allText(book).includes('Внутренний текст.'));
    assert(!/IGNORE_BINARY|Аннотация|Служебные/.test(allText(book)));
    same(book.chapters[0].paragraphs.slice(0, 3), ['Первая глава', 'Привет, ёж!', 'Следующий абзац.']);
  });
  await test('FB2: объявленная windows-1251', async () => {
    const book = await importBook(file(cp1251(fb2('windows-1251')), 'legacy.fb2'));
    assert(allText(book).includes('Привет, ёж!'));
  });
  await test('FB2: UTF-16LE с BOM', async () => {
    const book = await importBook(file(utf16(fb2('utf-16')), 'utf16.fb2'));
    assert(allText(book).includes('Привет, ёж!'));
  });
  await test('FB2: UTF-16BE с BOM', async () => {
    const book = await importBook(file(utf16(fb2('utf-16'), true), 'utf16be.fb2'));
    assert(allText(book).includes('Привет, ёж!'));
  });
  await test('EPUB: порядок spine, метаданные, пропуск nav', async () => {
    const book = await importBook(epub());
    same(book.title, 'Порядок книги'); same(book.author, 'Автор');
    same(book.chapters.map(chapter => chapter.title), ['Первая', 'Вторая']);
    assert(!/НАВИГАЦИЮ|HIDDEN_CSS/.test(allText(book)));
  });
  await test('EPUB: блоки и inline-теги не теряют текст', async () => {
    const book = await importBook(epub());
    same(book.chapters[0].paragraphs, ['Первая', 'Первый абзац со словом привет.', 'Второй блок.', 'Третий блок.']);
  });
  await test('EPUB: небезопасный HTML не выполняется и не читается', async () => {
    const files = epubFiles();
    files['OEBPS/first.xhtml'] = strToU8(xhtml('Безопасная глава', '<script>globalThis.__anchorImporterExecuted = true;</script><p onclick="globalThis.__anchorImporterExecuted = true">Видимый текст.</p><img src="https://example.invalid/tracking.png" onerror="globalThis.__anchorImporterExecuted = true"/><iframe src="https://example.invalid/frame">Скрытый фрейм</iframe><nav>Скрытая навигация</nav><p hidden="hidden">Скрытый текст</p><aside epub:type="footnote">Сноска</aside>'));
    delete globalThis.__anchorImporterExecuted;
    const book = await importBook(epub(files));
    same(book.chapters[0].paragraphs, ['Безопасная глава', 'Видимый текст.']);
    assert(!globalThis.__anchorImporterExecuted, 'Скрипт книги был выполнен');
  });
  await test('EPUB: повреждённый ZIP', () => expectError(() => importBook(file('this is not zip', 'bad.epub')), /повреждён/));
  await test('FB2: повреждённый XML', () => expectError(() => importBook(file('<FictionBook><body></FictionBook>', 'bad.fb2')), /повреждённый XML/));
  await test('FB2: внутренние XML entity запрещены', () => expectError(() => importBook(file('<!DOCTYPE FictionBook [<!ENTITY a "expanded">]><FictionBook><body><section><p>&a;</p></section></body></FictionBook>', 'entity.fb2')), /объявления XML/));
  await test('EPUB: пустые главы', async () => {
    const files = epubFiles();
    files['OEBPS/first.xhtml'] = strToU8(xhtml('Только title', '<script>script</script>').replace('<h1>Только title</h1>', ''));
    files['OEBPS/second.xhtml'] = files['OEBPS/first.xhtml'];
    await expectError(() => importBook(epub(files)), /не найден текст/);
  });
  await test('EPUB: DRM обнаруживается', async () => {
    const files = epubFiles();
    files['META-INF/encryption.xml'] = strToU8('<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>');
    await expectError(() => importBook(epub(files)), /DRM/);
  });
  await test('EPUB: обфускация шрифта не блокирует текст', async () => {
    const files = epubFiles();
    files['META-INF/encryption.xml'] = strToU8('<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>');
    assert((await importBook(epub(files))).chapters.length === 2);
  });
  await test('EPUB: обход каталогов запрещён', async () => {
    const files = epubFiles(); files['../evil.xhtml'] = strToU8('<p>bad</p>');
    await expectError(() => importBook(epub(files)), /небезопасные/);
  });
  await test('EPUB: отсутствующая глава вызывает ошибку', async () => {
    const files = epubFiles(); delete files['OEBPS/first.xhtml'];
    await expectError(() => importBook(epub(files)), /не найден файл/);
  });
  await test('EPUB: контрольная сумма проверяется', async () => {
    const bytes = zipSync(epubFiles()), view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        const length = view.getUint16(i + 28, true), name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + length));
        if (name === 'META-INF/container.xml') { view.setUint32(i + 16, 123, true); break; }
      }
    }
    await expectError(() => importBook(file(bytes, 'crc.epub')), /контрольная сумма/);
  });
  await test('EPUB: ограничение 50 МБ до выделения памяти', async () => {
    const bytes = zipSync(epubFiles()), view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        const length = view.getUint16(i + 28, true), name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + length));
        if (name === 'OEBPS/first.xhtml') { view.setUint32(i + 24, 51 * 1024 * 1024, true); break; }
      }
    }
    await expectError(() => importBook(file(bytes, 'oversized.epub')), /50 МБ/);
  });
  await test('Размер файла ограничен 30 МБ', () => expectError(() => importBook({ name: 'large.txt', size: 31 * 1024 * 1024, arrayBuffer: () => { throw new Error('Не должно читаться'); } }), /30 МБ/));
  await test('Пустой файл отклоняется', () => expectError(() => importBook(file('', 'empty.txt')), /Файл пуст/));
  await test('Пустой текст отклоняется', () => expectError(() => bookFromText(' \n\t\n '), /не найден текст/));
  await test('Неподдерживаемый формат: ошибка', () => expectError(() => importBook(file('pdf', 'test.pdf')), /не поддерживается/));
  const passed = results.filter(result => result.passed).length;
  return { passed, failed: results.length - passed, results };
}
