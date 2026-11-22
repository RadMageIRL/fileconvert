import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { addFiles, convert, documentsSetting, download, expectDone, fx, openApp, pyRead, row, unexpectedViolations } from './helpers';

// Markdown with its pictures as separate files (v0.2.0, after the Phase 1B review): an optional ZIP holding the .md
// and an assets folder. Every ZIP is checked by Python (tests/e2e/readers.py: zipfile CRCs and names, then extracted
// and its picture links followed, pictures decoded by Pillow), the pictures are compared byte for byte with the
// source, and the extracted Markdown, rendered by mistune, is opened from disk in the browser to see the pictures load.

interface MdZip {
  entries: Array<{ name: string; size: number; utf8: boolean; dir: boolean; sha256: string; stored: boolean }>;
  bad_crc: string | null; unsafe: string[]; nonascii_unflagged: string[]; markdown: string[];
  images: Array<{ url: string; exists: boolean; sha256?: string; format?: string; width?: number; script?: boolean }>;
  extracted: string; html: string | null;
}

const PICTURES = 'Pictures in Markdown (from DOCX or HTML)';
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The SHA-256 of each picture held in an HTML file as a base64 data URL, in order. */
const dataUrlHashes = (html: string) => [...html.matchAll(/src="data:([^;]+);base64,([^"]+)"/g)].map(m => ({ mime: m[1], sha256: sha(Buffer.from(m[2], 'base64')) }));

/** Opens the extracted Markdown (as mistune renders it) from disk, and returns each picture's loaded size. */
async function picturesFromDisk(page: Page, html: string): Promise<Array<{ src: string; width: number }>> {
  const view = await page.context().newPage();
  await view.goto(pathToFileURL(html).href);
  await view.waitForFunction(() => [...document.images].every(i => i.complete));
  const sizes = await view.evaluate(() => [...document.images].map(i => ({ src: i.getAttribute('src') ?? '', width: i.naturalWidth })));
  await view.close();
  return sizes;
}

test('DOCX to Markdown with pictures as files: one ZIP, the .md and assets/, the pictures byte for byte', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/word-styles.docx')]);
  await documentsSetting(page, PICTURES, 'files');
  await convert(page, 'word-styles.docx', 'Markdown');
  await expectDone(page, 'word-styles.docx');
  const { path, filename } = await download(page, 'word-styles.docx', info);
  expect(filename).toBe('word-styles.zip');
  const z = pyRead<MdZip>('mdzip', path);
  expect(z.bad_crc).toBeNull();
  expect(z.unsafe).toEqual([]);
  expect(z.entries.map(e => e.name)).toEqual(['word-styles.md', 'assets/word-styles-1.png', 'assets/word-styles-2.jpg']);
  // Pictures are stored as they are, the Markdown is compressed.
  expect(z.entries.map(e => e.stored)).toEqual([false, true, true]);
  expect(z.images.map(i => [i.url, i.exists, i.format])).toEqual([['assets/word-styles-1.png', true, 'PNG'], ['assets/word-styles-2.jpg', true, 'JPEG']]);
  // The same bytes as the pictures inside the DOCX, as Python's zipfile reads them there.
  const media = pyRead<Record<string, string>>('media', fx('document/word-styles.docx'));
  expect(z.images.map(i => i.sha256)).toEqual([media['word/media/image1.png'], media['word/media/image2.jpg']]);
  const md = readFileSync(`${z.extracted}/word-styles.md`, 'utf8');
  expect(md).not.toContain('data:');
  expect(md).toContain('# Word styles sample');
  expect((await picturesFromDisk(page, z.html!)).every(p => p.width > 0)).toBe(true);
  const notes = row(page, 'word-styles.docx').locator('.job-notes');
  await expect(notes).toContainText('The Markdown and its 2 pictures are in a ZIP: word-styles.md, with the pictures in an assets folder beside it');

  // The standalone Markdown is still the default, and still there: the same document as one .md file.
  await documentsSetting(page, PICTURES, 'embed');
  await convert(page, 'word-styles.docx', 'Markdown');
  const alone = await download(page, 'word-styles.docx', info);
  expect(alone.filename).toBe('word-styles.md');
  expect(readFileSync(alone.path, 'utf8')).toContain('](data:image/png;base64,');
  expect(w.outside).toEqual([]);
});

test('HTML to Markdown with pictures as files: five formats, a picture used twice is one file, the SVG is cleaned', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/structure.html')]);
  await documentsSetting(page, PICTURES, 'files');
  await convert(page, 'structure.html', 'Markdown');
  await expectDone(page, 'structure.html');
  const { path, filename } = await download(page, 'structure.html', info);
  expect(filename).toBe('structure.zip');
  const z = pyRead<MdZip>('mdzip', path);
  expect(z.bad_crc).toBeNull();
  expect(z.entries.map(e => e.name)).toEqual(['structure.md', 'assets/structure-1.jpg', 'assets/structure-2.gif', 'assets/structure-3.png', 'assets/structure-4.webp', 'assets/structure-5.svg']);
  expect(z.images.map(i => [i.url, i.exists])).toEqual([
    ['assets/structure-1.jpg', true], ['assets/structure-2.gif', true], ['assets/structure-3.png', true], ['assets/structure-3.png', true], ['assets/structure-4.webp', true], ['assets/structure-5.svg', true],
  ]);
  expect(z.images.map(i => i.format)).toEqual(['JPEG', 'GIF', 'PNG', 'PNG', 'WEBP', 'SVG']);
  // The raster pictures are the bytes of the data URLs in the HTML file; the SVG lost its script, handler and web link.
  const source = dataUrlHashes(readFileSync(fx('document/structure.html'), 'utf8'));
  expect(z.images.slice(0, 5).map(i => i.sha256)).toEqual(source.slice(0, 5).map(s => s.sha256));
  expect(z.images[5].script).toBe(false);
  expect(z.images[5].sha256).not.toBe(source[5].sha256);
  const shown = await picturesFromDisk(page, z.html!);
  expect(shown.map(p => p.src)).toEqual(z.images.map(i => i.url));
  expect(shown.every(p => p.width > 0)).toBe(true);
  await expect(row(page, 'structure.html').locator('.job-notes')).toContainText('1 SVG picture was cleaned before being written as a file');
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('pictures as files: a non-ASCII name, web and relative pictures left as addresses, and no ZIP when there is nothing to put in one', async ({ page }, info) => {
  const w = await openApp(page);
  const html = readFileSync(fx('document/page.html'));
  const plain = { name: 'plain.html', mimeType: 'text/html', buffer: Buffer.from('<h1>Plain</h1><p>Only a picture from the web: <img src="https://example.com/a.png" alt="web"></p>') };
  await addFiles(page, [{ name: 'R\u00e9sum\u00e9 page.html', mimeType: 'text/html', buffer: html }, plain]);
  await documentsSetting(page, PICTURES, 'files');
  await convert(page, 'R\u00e9sum\u00e9 page.html', 'Markdown');
  await expectDone(page, 'R\u00e9sum\u00e9 page.html');
  const { path, filename } = await download(page, 'R\u00e9sum\u00e9 page.html', info);
  expect(filename).toBe('R\u00e9sum\u00e9 page.zip');
  const z = pyRead<MdZip>('mdzip', path);
  expect(z.entries.map(e => [e.name, e.utf8])).toEqual([['R\u00e9sum\u00e9 page.md', true], ['assets/resume-page-1.png', false]]);
  expect(z.nonascii_unflagged).toEqual([]);
  expect(z.images.map(i => [i.url, i.exists])).toEqual([['assets/resume-page-1.png', true], ['https://example.com/photo.jpg', false], ['images/local.png', false]]);
  expect(z.images[0].sha256).toBe(dataUrlHashes(html.toString('utf8'))[0].sha256);
  await expect(row(page, 'R\u00e9sum\u00e9 page.html').locator('.job-notes')).toContainText('2 pictures are referred to by their web or relative address, as in the original; nothing was downloaded, so they are not in the ZIP.');
  // A page with no picture inside it gives the Markdown alone, its web picture still an address.
  await convert(page, 'plain.html', 'Markdown');
  await expectDone(page, 'plain.html');
  const alone = await download(page, 'plain.html', info);
  expect(alone.filename).toBe('plain.md');
  expect(readFileSync(alone.path, 'utf8')).toBe('# Plain\n\nOnly a picture from the web: ![web](https://example.com/a.png)\n');
  await expect(row(page, 'plain.html').locator('.job-notes')).toContainText('There are no pictures inside the document to write as files, so the result is the Markdown file alone.');
  expect(w.outside).toEqual([]);
});

test('pictures as files: a data URL that is not a picture, or cannot be read, never becomes a file', async ({ page }, info) => {
  const w = await openApp(page);
  const script = Buffer.from('<script>alert(1)</script>').toString('base64');
  const html = `<h1>Odd pictures</h1><p><img src="data:text/html;base64,${script}" alt="Not a picture"> <img src="data:image/png;base64,@@@" alt="Broken"> <img src="data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///ywAAAAAAQABAAACAkQBADs=" alt="Real"></p>`;
  await addFiles(page, [{ name: 'odd.html', mimeType: 'text/html', buffer: Buffer.from(html) }]);
  await documentsSetting(page, PICTURES, 'files');
  await convert(page, 'odd.html', 'Markdown');
  await expectDone(page, 'odd.html');
  const z = pyRead<MdZip>('mdzip', (await download(page, 'odd.html', info)).path);
  expect(z.entries.map(e => e.name)).toEqual(['odd.md', 'assets/odd-1.gif']);
  const md = readFileSync(`${z.extracted}/odd.md`, 'utf8');
  expect(md).toContain('\\[Image: Not a picture\\]');
  expect(md).toContain('\\[Image: Broken\\]');
  expect(md).not.toContain('data:');
  await expect(row(page, 'odd.html').locator('.job-notes')).toContainText('2 pictures inside the document could not be read and were replaced by their description.');
  expect(w.outside).toEqual([]);
});

test('hostile DOCX to Markdown with pictures as files: the linked picture is not fetched, nothing unsafe is written', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('hostile/hostile.docx')]);
  await documentsSetting(page, PICTURES, 'files');
  await convert(page, 'hostile.docx', 'Markdown');
  await expectDone(page, 'hostile.docx');
  const z = pyRead<MdZip>('mdzip', (await download(page, 'hostile.docx', info)).path);
  expect(z.bad_crc).toBeNull();
  expect(z.unsafe).toEqual([]);
  expect(z.images.every(i => i.exists)).toBe(true);
  const md = readFileSync(`${z.extracted}/hostile.md`, 'utf8');
  expect(md).not.toMatch(/javascript:|<script|<iframe|tracker\.png/i);
  expect(md).toContain('Click me');
  await expect(row(page, 'hostile.docx').locator('.job-notes')).toContainText('1 picture is only linked from the document');
  expect(w.outside).toEqual([]);
});
