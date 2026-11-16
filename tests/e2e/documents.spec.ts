import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addFiles, convert, cspViolations, unexpectedViolations, download, expectDone, fx, openApp, pdftotext, row } from './helpers';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

test('TXT to PDF keeps every line, accents and Greek, in a real text layer', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/sample.txt'), fx('document/utf16.txt'), fx('document/latin1.txt')]);
  await convert(page, 'sample.txt', 'PDF');
  await expectDone(page, 'sample.txt');
  const { path, filename } = await download(page, 'sample.txt', info);
  expect(filename).toBe('sample.pdf');
  expect(readFileSync(path).subarray(0, 5).toString()).toBe('%PDF-');
  const text = pdftotext(path);
  expect(text).toContain('FileConvert text sample');
  expect(text).toContain('001. Converting files should not mean uploading them.');
  expect(text).toContain('120. Line 120 of the sample text file.');
  expect(text).toContain('caf\u00e9, na\u00efve');
  expect(text).toContain('\u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1');
  expect(text.split('\f').length - 1).toBeGreaterThanOrEqual(2);
  await convert(page, 'utf16.txt', 'PDF');
  const utf16 = pdftotext((await download(page, 'utf16.txt', info)).path);
  expect(utf16).toContain('UTF-16 text with a BOM: caf\u00e9');
  expect(utf16).toContain('Second line.');
  // Noto Sans Mono has no check mark, and the conversion says so instead of dropping it silently.
  await expect(row(page, 'utf16.txt').locator('.job-notes')).toContainText('1 character is not in the PDF font and will not show (for example \u2713)');
  await convert(page, 'latin1.txt', 'PDF');
  await expect(row(page, 'latin1.txt').locator('.job-notes')).toContainText('Windows-1252');
  expect(pdftotext((await download(page, 'latin1.txt', info)).path)).toContain('caf\u00e9, \u00a33, na\u00efve');
  expect(w.outside).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('characters outside the PDF font are reported', async ({ page }) => {
  await openApp(page);
  await page.locator('#picker').setInputFiles([{ name: 'cjk.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello \u6f22\u5b57 world\n') }]);
  await convert(page, 'cjk.txt', 'PDF');
  await expectDone(page, 'cjk.txt');
  await expect(row(page, 'cjk.txt').locator('.job-notes')).toContainText('2 characters are not in the PDF font');
});

test('PDF to TXT, including a page with no text layer', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('document/sample.pdf'), fx('document/mixed.pdf'), fx('document/scanned.pdf'), fx('hostile/not-a-pdf.pdf')]);
  await convert(page, 'sample.pdf', 'TXT');
  await expectDone(page, 'sample.pdf');
  const text = readFileSync((await download(page, 'sample.pdf', info)).path, 'utf8');
  expect(text).toContain('FileConvert PDF sample');
  expect(norm(text)).toContain('The first paragraph of the first page, with caf\u00e9 and na\u00efve.');
  expect(text).toContain('\u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1');
  expect(text.indexOf('Second page')).toBeGreaterThan(text.indexOf('FileConvert PDF sample'));
  await convert(page, 'mixed.pdf', 'TXT');
  await expectDone(page, 'mixed.pdf');
  await expect(row(page, 'mixed.pdf').locator('.job-notes')).toContainText('Page 2 has no text');
  await expect(row(page, 'mixed.pdf').locator('.job-notes')).toContainText('needs OCR');
  await convert(page, 'scanned.pdf', 'TXT');
  await expect(row(page, 'scanned.pdf')).toHaveClass(/failed/);
  await expect(row(page, 'scanned.pdf').locator('.job-error')).toContainText('its pages are pictures, as in a scanned document');
  await expect(row(page, 'scanned.pdf').locator('.job-error')).toContainText('OCR');
  await convert(page, 'not-a-pdf.pdf', 'TXT');
  await expect(row(page, 'not-a-pdf.pdf')).toHaveClass(/failed/);
});

test('Markdown to HTML: a standalone page with the content, and scripts and handlers removed', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/sample.md')]);
  await convert(page, 'sample.md', 'HTML');
  await expectDone(page, 'sample.md');
  const html = readFileSync((await download(page, 'sample.md', info)).path, 'utf8');
  expect(html.startsWith('<!doctype html>')).toBe(true);
  expect(html).toContain('<title>FileConvert Markdown sample</title>');
  expect(html).toContain('<h2>Lists</h2>');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toMatch(/<table>[\s\S]*<td>PNG<\/td>/);
  expect(html).toContain('<code class="language-js">');
  expect(html).toContain('src="data:image/png;base64,');
  expect(html).toContain('<p>Inline HTML paragraph.</p>');
  expect(html).not.toMatch(/<script|onclick|onerror|href="javascript:/i);
  expect(html).toContain('<a>A javascript: link</a>');
  expect(html).toContain('Content-Security-Policy');
  await expect(row(page, 'sample.md').locator('.job-notes')).toContainText('Removed');
  expect(w.outside).toEqual([]);
  // The result opens in a browser and runs nothing. (Opening it does load the document's own remote image,
  // as any web page would; that is the user's content, not FileConvert.)
  await page.goto('about:blank');
  await page.setContent(html);
  expect(await page.evaluate(() => (window as unknown as { __fileconvertPwned?: boolean }).__fileconvertPwned)).toBeUndefined();
});

test('Markdown and HTML to PDF: structure, text and links, with nothing fetched or run', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/sample.md'), fx('document/sample.html')]);
  await convert(page, 'sample.md', 'PDF');
  await expectDone(page, 'sample.md');
  const md = pdftotext((await download(page, 'sample.md', info)).path);
  for (const s of ['FileConvert Markdown sample', 'Lists', 'First item', 'A nested item', 'function hello(name)', 'Format', 'MP3', 'A block quote that spans', '[Image: A remote image that must not be fetched]', 'caf\u00e9']) {
    expect(md, s).toContain(s);
  }
  await expect(row(page, 'sample.md').locator('.job-notes')).toContainText('replaced by its description');
  await convert(page, 'sample.html', 'PDF');
  await expectDone(page, 'sample.html');
  const html = pdftotext((await download(page, 'sample.html', info)).path);
  for (const s of ['FileConvert HTML sample', 'A styled note.', 'Two point one', 'Alpha', 'preformatted', 'The end: caf\u00e9.']) expect(html, s).toContain(s);
  await expect(row(page, 'sample.html').locator('.job-notes')).toContainText('Stylesheets are not applied');
  expect(await page.evaluate(() => (window as unknown as { __fileconvertPwned?: boolean }).__fileconvertPwned)).toBeUndefined();
  expect(w.outside, 'no request to example.com or anywhere else').toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('DOCX to TXT reads paragraphs, tabs, line breaks, lists and tables; a zip bomb is refused', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('document/sample.docx'), fx('hostile/zip-bomb.docx')]);
  await convert(page, 'sample.docx', 'TXT');
  await expectDone(page, 'sample.docx');
  const text = readFileSync((await download(page, 'sample.docx', info)).path, 'utf8');
  for (const s of ['FileConvert DOCX sample', 'A first paragraph with bold text', 'Before the tab\tafter the tab.', 'A line\nbroken in two.', 'First bullet', 'Second bullet', 'Alpha', 'caf\u00e9, na\u00efve', '\u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1']) {
    expect(text, JSON.stringify(s)).toContain(s);
  }
  await convert(page, 'zip-bomb.docx', 'TXT');
  await expect(row(page, 'zip-bomb.docx')).toHaveClass(/failed/);
  await expect(row(page, 'zip-bomb.docx').locator('.job-error')).toContainText(/would unpack to 1536 MB/);
});
