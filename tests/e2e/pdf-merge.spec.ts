import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fx, openApp, PYTHON, pyRead, save, tempDir, unexpectedViolations } from './helpers';
import { numbered } from './pdfgen';

// Merge PDFs (v0.2.0, Phase 2) in the browser: the tool in the workspace, the merge in the PDF worker, every result
// read by qpdf, pypdf and PDFium (tests/e2e/readers.py, kind pdfdeep), which share no code with FileConvert, and
// compared with the same readers' view of the source files.

interface Annot { subtype: string; page?: number | string; uri?: string; field?: string; as?: string | null; ap?: boolean; da?: string; contents?: string }
interface Outline { title: string; page?: number | string; uri?: string; open?: boolean; count?: number; children?: Outline[] }
interface Deep {
  qpdf: { ok: boolean; out: string }; version: string;
  pages: Array<{ mediabox: number[]; cropbox: number[]; rotate: number; text: string; annots: Annot[] }>;
  pageObjects: number; outline: Outline[]; outlineCount: number | null; dests: Record<string, number | string>;
  fields: Record<string, { value: string | null; type: string; da: string | null }>;
  form: { da: string | null; fonts: Record<string, string>; needAppearances: boolean; co: number } | null;
  layers: { groups: string[]; hidden: string[]; configs: boolean } | null;
  catalog: string[]; info: Record<string, string> | null; metadata: boolean; renders: string[]; formRenders: string[]; decompressed: string;
}

const sources = new Map<string, Deep>();
const source = (f: string) => { if (!sources.has(f)) sources.set(f, pyRead<Deep>('pdfdeep', fx(`pdf/${f}`))); return sources.get(f)!; };

const ws = (page: Page) => page.locator('#workspace');
const item = (page: Page, name: string) => ws(page).locator('.ws-item').filter({ has: page.locator('.job-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
const order = (page: Page) => ws(page).locator('.ws-item:not(.rejected) .job-name');
const pdfPool = (page: Page) => page.evaluate(() => (window as unknown as { __fileconvert: { engines: { pdf: { active: number } } } }).__fileconvert.engines.pdf.active);

async function openMerge(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('merge-pdf'));
  await expect(page.getByRole('heading', { name: 'Merge PDFs', level: 2 })).toBeVisible();
}

async function add(page: Page, paths: string[]): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(paths);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

async function mergeAndRead(page: Page, info: TestInfo): Promise<{ deep: Deep; path: string }> {
  await ws(page).getByRole('button', { name: 'Merge PDFs' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 120_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).getByRole('button', { name: 'Download merged.pdf' }).click()]);
  const { path, filename } = await save(dl, info);
  expect(filename).toBe('merged.pdf');
  return { deep: pyRead<Deep>('pdfdeep', path), path };
}

test('two PDFs put in order from the keyboard merge into one: every page drawn as in its file, links, bookmarks, fields and layers kept', async ({ page }, info) => {
  test.slow();
  const w = await openApp(page);
  await openMerge(page);
  await add(page, [fx('pdf/merge-b.pdf'), fx('pdf/merge-a.pdf')]);
  await expect(item(page, 'merge-a.pdf').locator('.job-info')).toHaveText(/^PDF document, .*, 3 pages$/);
  await expect(item(page, 'merge-b.pdf').locator('.job-info')).toHaveText(/, 2 pages$/);
  await ws(page).getByRole('button', { name: 'Move merge-a.pdf up' }).focus();
  await page.keyboard.press('Enter');
  await expect(order(page)).toHaveText(['merge-a.pdf', 'merge-b.pdf']);
  const { deep: m } = await mergeAndRead(page, info);
  const a = source('merge-a.pdf'), b = source('merge-b.pdf');

  expect(m.qpdf.ok, m.qpdf.out).toBe(true);
  expect(m.pages).toHaveLength(5);
  // No hidden copy of a page a link or bookmark points at.
  expect(m.pageObjects).toBe(5);
  // Each page drawn exactly as in its own file, by PDFium, with and without its form engine; the same text.
  expect(m.renders).toEqual([...a.renders, ...b.renders]);
  expect(m.formRenders).toEqual([...a.formRenders, ...b.formRenders]);
  expect(m.pages.map(p => p.text)).toEqual([...a.pages, ...b.pages].map(p => p.text));
  expect(m.pages.map(p => [p.rotate, p.cropbox])).toEqual([...a.pages, ...b.pages].map(p => [p.rotate, p.cropbox]));

  // Bookmarks: a section per file, each file's own under it, every one on its page in the merged PDF.
  expect(m.outline).toEqual([
    { title: 'merge-a', page: 0, open: true, count: 5, children: [
      { title: 'Chapter A1', page: 0, open: true, count: 1, children: [{ title: 'Section A1.1', page: 0 }] },
      { title: 'Chapter A2', page: 1 },
      { title: 'Closed A3', page: 2, open: false, count: -1, children: [{ title: 'A3 child', page: 2 }] },
      { title: 'Web link', uri: 'https://example.com/' },
    ] },
    { title: 'merge-b', page: 3, open: true, count: 2, children: [{ title: 'Chapter B1', page: 3 }, { title: 'Chapter B2', page: 4 }] },
  ]);
  // Counts are the entries shown under an open entry; a closed entry's own do not count.
  expect(m.outlineCount).toBe(9);
  expect(m.dests).toEqual({ 'a-sec': 0, 'a-two': 1, shared: 2, shared_2: 4 });
  // Links: merge-b's page-number link lands on merge-b's own second page; its link to a name it lacks goes nowhere.
  const links = m.pages.map(p => p.annots.filter(x => x.subtype === '/Link').map(x => x.uri ?? x.page ?? 'none'));
  expect(links).toEqual([[2, 1, 'https://example.com/alpha'], [], [], [4, 'none', 4, 'https://example.com/bravo'], []]);
  // Annotations are all there, in their order, with their appearances.
  expect(m.pages.map(p => p.annots.map(x => x.subtype))).toEqual([...a.pages, ...b.pages].map(p => p.annots.map(x => x.subtype)));
  expect(m.pages.flatMap(p => p.annots).filter(x => x.subtype === '/Widget').every(x => x.ap)).toBe(true);

  // Form fields: values kept; clashing names renamed; merge-b's /Helv is Courier, renamed so its fields keep it.
  expect(Object.fromEntries(Object.entries(m.fields).map(([k, v]) => [k, v.value]))).toEqual({
    name: 'Alice', agree: '/Yes', choice: '/B', color: 'Green',
    name_2: 'Bob', 'address.street': '1 Main St', 'address.city': 'Springfield', agree_2: '/Off',
  });
  expect(m.fields.name_2.da).toBe('/Helv_2 10 Tf 0 0 1 rg');
  expect(m.fields['address.city'].da).toBe('/Helv_2 0 Tf 0 g');
  expect(m.fields.name.da).toBe('/Helv 0 Tf 0 g');
  expect(m.form!.fonts).toEqual({ Helv: '/Helvetica', ZaDb: '/ZapfDingbats', Helv_2: '/Courier' });
  expect(m.pages[3].annots.find(x => x.subtype === '/FreeText')!.da).toBe('/Helv_2 12 Tf 0 g');
  // The widgets' states: merge-a's check box on, its radio group on B (the button on page 3).
  expect(m.pages[1].annots.filter(x => x.subtype === '/Widget').map(x => [x.field, x.as])).toEqual([['name', null], ['agree', '/Yes'], ['choice', '/Off'], ['color', null]]);
  expect(m.pages[2].annots.map(x => [x.field, x.as])).toEqual([['choice', '/B']]);

  // Layers: both files' hidden layers stay hidden (PDFium's identical renders show it too).
  expect(m.layers).toEqual({ groups: ['Alpha shown', 'Alpha hidden', 'Bravo shown', 'Bravo hidden'], hidden: ['Alpha hidden', 'Bravo hidden'], configs: false });
  // The first file's document information and metadata; nothing of what is not carried.
  expect(m.info).toEqual({ '/Title': 'Merge A', '/Author': 'Test A', '/Subject': 'FileConvert merge fixture' });
  expect(m.metadata).toBe(true);
  for (const k of ['/StructTreeRoot', '/PageLabels', '/Threads', '/MarkInfo', '/Perms', '/Collection']) expect(m.catalog, k).not.toContain(k);
  const everything = readFileSync(m.decompressed);
  for (const gone of ['An attached note.', 'var ready = 1;', 'var opened = 1;', 'xdp:xdp', '/EmbeddedFiles', '/JavaScript']) expect(everything.includes(gone), gone).toBe(false);

  // What the result says.
  const file = ws(page).locator('.ws-file');
  await expect(file.locator('.job-info')).toHaveText(/^5 pages from 2 files, /);
  await expect(file.locator('.ws-details li')).toHaveText([
    'Bookmarks: one for each file, with the file\'s own bookmarks under it (10 bookmarks in all).',
    'Links: 7 links, each pointing at its page in the merged PDF.',
    'Form fields: 8 fields kept with their values.',
    'Renamed in merge-b.pdf, because an earlier file has fields with the same names: name to name_2 and agree to agree_2.',
    '1 named destination renamed, because an earlier file uses the same names; links and bookmarks still go to the right pages.',
    'Layers: 4 layers, each shown or hidden as in its file.',
    'Title, author and other document information are from the first file, merge-a.pdf.',
  ]);
  await expect(ws(page).locator('.ws-out > .job-notes li')).toHaveText([
    '1 link or bookmark in merge-b.pdf pointed at a place the file does not have; it goes nowhere now.',
    'Accessibility tags are not kept (merge-b.pdf); screen readers read the merged pages without them.',
    'Page labels such as i, ii, iii are not kept (merge-b.pdf); the merged pages are numbered 1 to 5.',
    'Files attached to the document are not kept (merge-b.pdf); attachments placed on a page are.',
    'Document scripts are not kept (merge-b.pdf).',
    'XFA form data is not kept (merge-b.pdf); the regular form fields and their values are.',
    'Extra layer settings are not kept (merge-b.pdf); each layer starts shown or hidden as in its file.',
  ]);
  expect(w.outside).toEqual([]);
  expect(w.errors).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('a signed PDF has to be accepted before merging; the merged copy keeps its field, and its signature is no longer valid', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openMerge(page);
  await add(page, [fx('pdf/merge-a.pdf'), fx('pdf/signed.pdf')]);
  await expect(item(page, 'signed.pdf').locator('.job-notes li')).toHaveText('Digitally signed.');
  const box = ws(page).locator('.ws-confirm');
  await expect(box).toBeVisible();
  await expect(box.locator('li')).toHaveText(/^signed\.pdf is digitally signed\. Merging changes it, so its signature will no longer be valid/);
  const run = ws(page).getByRole('button', { name: 'Merge PDFs' });
  await expect(run).toBeDisabled();
  await expect(ws(page).locator('.ws-why')).toHaveText('Check "Merge anyway; the signatures will no longer be valid" first.');
  await box.getByLabel('Merge anyway; the signatures will no longer be valid').check();
  await expect(run).toBeEnabled();
  // Taking the signed file out and adding it again asks again.
  await ws(page).getByRole('button', { name: 'Remove signed.pdf' }).click();
  await expect(box).toBeHidden();
  await add(page, [fx('pdf/signed.pdf')]);
  await expect(run).toBeDisabled();
  await box.getByLabel('Merge anyway; the signatures will no longer be valid').check();
  const { deep: m, path } = await mergeAndRead(page, info);
  expect(m.qpdf.ok, m.qpdf.out).toBe(true);
  expect(m.pageObjects).toBe(7);
  const s = source('signed.pdf');
  expect(m.renders.slice(3)).toEqual(s.renders);
  expect(m.fields.Signature1.value).toBe('signature');
  expect(Object.keys(m.fields)).toEqual(['name', 'agree', 'choice', 'color', 'secretfield', 'keepfield', 'Signature1']);
  await expect(ws(page).locator('.ws-out > .job-notes li').first()).toHaveText('The digital signature of signed.pdf is no longer valid. The signature fields and how they look are kept.');
  // pyHanko, where it is installed (local/eval-2/venv), reports the copied signature as not intact.
  const hanko = resolve('local/eval-2/venv/Scripts/python.exe');
  if (existsSync(hanko)) {
    const script = 'import sys\nfrom pyhanko.pdf_utils.reader import PdfFileReader\nfrom pyhanko.sign.validation import validate_pdf_signature\nr = PdfFileReader(open(sys.argv[1], "rb"), strict=False)\nprint(",".join(str(validate_pdf_signature(s).intact) for s in r.embedded_signatures))';
    expect(execFileSync(hanko, ['-I', '-c', script, fx('pdf/signed.pdf')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()).toBe('True');
    expect(execFileSync(hanko, ['-I', '-c', script, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()).toBe('False');
  }
});

test('encrypted, hostile and non-PDF files are refused as they are added, each with its reason', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  await openMerge(page);
  await add(page, [fx('pdf/encrypted-owner.pdf'), fx('pdf/bomb-objstm.pdf'), fx('pdf/pages-6000.pdf'), fx('pdf/page-loop.pdf'), fx('document/sample.txt'), fx('pdf/merge-a.pdf')]);
  const error = (f: string) => item(page, f).locator('.job-error');
  await expect(error('encrypted-owner.pdf')).toHaveText(/^This PDF is encrypted, so FileConvert does not open it\. Encrypted PDFs are not supported, including ones that open without a password/);
  await expect(error('bomb-objstm.pdf')).toContainText('object stream that expands past 256 MB');
  await expect(error('pages-6000.pdf')).toContainText('This PDF has 6,000 pages; the limit is 5,000');
  await expect(error('page-loop.pdf')).toContainText('page tree contains itself');
  await expect(error('sample.txt')).toHaveText(/^Merge PDFs takes PDF files; this is /);
  await expect(order(page)).toHaveText(['merge-a.pdf']);
  await expect(ws(page).locator('.ws-why')).toHaveText('Add at least 2 files.');
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

/** A PDF whose four content streams decompress to 800 MB: under every limit, slow enough to cancel while checked. */
function slowPdf(): string {
  const slow = `${tempDir()}/slow.pdf`;
  execFileSync(PYTHON, ['-I', '-c', [
    'import sys, zlib',
    'z = zlib.compress(bytes(200 << 20), 9)',
    'objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>", 2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",',
    '        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R >>", 8: b"<< /Length 3 >>\\nstream\\nq Q\\nendstream"}',
    // Slow to check (the guard decodes 800 MB of zeros) but light to edit: embedded files, not page content.
    'for n in range(4, 8): objs[n] = b"<< /Type /EmbeddedFile /Length %d /Filter /FlateDecode >>\\nstream\\n" % len(z) + z + b"\\nendstream"',
    'out = b"%PDF-1.7\\n" + b"".join(b"%d 0 obj\\n" % k + v + b"\\nendobj\\n" for k, v in objs.items()) + b"trailer\\n<< /Root 1 0 R >>\\n%%EOF\\n"',
    'open(sys.argv[1], "wb").write(out)',
  ].join('\n'), slow]);
  return slow;
}

test('removing a file while it is checked, and canceling a merge, stop the PDF worker; the next merge works', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openMerge(page);
  const slow = slowPdf();
  await ws(page).locator('input[type=file]').setInputFiles([slow]);
  await expect(item(page, 'slow.pdf')).toHaveClass(/checking/);
  await expect.poll(() => pdfPool(page)).toBe(1);
  await ws(page).getByRole('button', { name: 'Remove slow.pdf' }).click();
  await expect(item(page, 'slow.pdf')).toHaveCount(0);
  await expect.poll(() => pdfPool(page)).toBe(0);
  // Canceled while the merge checks the slow file again.
  await add(page, [slow, fx('pdf/merge-a.pdf')]);
  await ws(page).getByRole('button', { name: 'Merge PDFs' }).click();
  await expect(ws(page).locator('.ws-run .job-info')).toContainText('Adding 1 of 2: slow.pdf');
  await ws(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(ws(page).locator('.ws-state.canceled')).toHaveText('Canceled.');
  await expect.poll(() => pdfPool(page)).toBe(0);
  await ws(page).getByRole('button', { name: 'Remove slow.pdf' }).click();
  await add(page, [fx('pdf/merge-b.pdf')]);
  const { deep } = await mergeAndRead(page, info);
  expect(deep.pages).toHaveLength(5);
});

test('more pages than a merged PDF can have: Merge PDFs stays off and says why', async ({ page }) => {
  test.slow();
  await openApp(page);
  await openMerge(page);
  const dir = tempDir();
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const big = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < 2600; i++) big.addPage([100, 100]);
  writeFileSync(`${dir}/one.pdf`, await big.save({ useObjectStreams: false }));
  writeFileSync(`${dir}/two.pdf`, readFileSync(`${dir}/one.pdf`));
  await add(page, [`${dir}/one.pdf`, `${dir}/two.pdf`]);
  await expect(item(page, 'one.pdf').locator('.job-info')).toHaveText(/, 2,600 pages$/);
  await expect(ws(page).locator('.ws-why')).toHaveText('Together these files have 5,200 pages; a merged PDF can have up to 5,000. Merge fewer files at a time.');
  await expect(ws(page).getByRole('button', { name: 'Merge PDFs' })).toBeDisabled();
  await ws(page).getByRole('button', { name: 'Remove two.pdf' }).click();
  await expect(ws(page).getByRole('button', { name: 'Merge PDFs' })).toBeDisabled();
  await expect(ws(page).locator('.ws-why')).toHaveText('Add at least 2 files.');
});

test('at 320 pixels, with a signed file, notes and a result, nothing scrolls sideways; rows reorder by touch', async ({ page }, info) => {
  test.slow();
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page);
  await openMerge(page);
  const dir = tempDir();
  const long = `${dir}/a-very-long-file-name-for-a-quarterly-report-that-keeps-going-and-going.pdf`;
  writeFileSync(long, readFileSync(fx('pdf/merge-b.pdf')));
  await add(page, [fx('pdf/signed.pdf'), long, fx('pdf/merge-a.pdf')]);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const up = ws(page).getByRole('button', { name: 'Move merge-a.pdf up' });
  // A phone taps; a desktop browser clicks. Either way the row moves, and the buttons are big enough to hit.
  if (info.project.use.hasTouch) await up.tap(); else await up.click();
  await expect(order(page)).toHaveText(['signed.pdf', 'merge-a.pdf', /^a-very-long-file-name/]);
  expect((await up.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  const check = ws(page).getByLabel('Merge anyway; the signatures will no longer be valid');
  if (info.project.use.hasTouch) await check.tap(); else await check.check();
  await expect(check).toBeChecked();
  await mergeAndRead(page, info);
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test('the Merge PDFs page opens the tool at once, and it merges there', async ({ page }, info) => {
  const w = await openApp(page);
  await page.goto('./merge-pdf/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Merge PDFs');
  await expect(page.locator('html')).toHaveAttribute('data-tool', 'merge-pdf');
  await expect(page.locator('#drop')).toBeHidden();
  await add(page, [fx('pdf/merge-a.pdf'), fx('pdf/merge-b-objstm.pdf')]);
  const { deep } = await mergeAndRead(page, info);
  expect(deep.qpdf.ok).toBe(true);
  expect(deep.renders).toEqual([...source('merge-a.pdf').renders, ...source('merge-b.pdf').renders]);
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('a problem found during the merge itself names its file; a limit on the whole merge does not', async ({ page }) => {
  await openApp(page);
  // The worker's merge task called directly, as if a file had changed after it was checked.
  const run = (files: string[]) => page.evaluate(async list => {
    const app = (window as unknown as { __fileconvert: { engines: { pdf: { run<T>(t: string, p: unknown): Promise<T> } } } }).__fileconvert;
    const blobs = list.map(([name, b64]) => ({ name, file: new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]) }));
    try { await app.engines.pdf.run('merge', { files: blobs }); return 'merged'; } catch (e) { return (e as Error).message; }
  }, files.map(f => [f.split('/').pop()!, readFileSync(fx(f)).toString('base64')]));
  expect(await run(['pdf/merge-a.pdf', 'pdf/bomb-objstm.pdf'])).toMatch(/^bomb-objstm\.pdf: This PDF has an object stream that expands past 256 MB/);
  expect(await run(['pdf/merge-a.pdf', 'pdf/encrypted-owner.pdf'])).toMatch(/^encrypted-owner\.pdf: This PDF is encrypted/);
  expect(await run(['pdf/merge-a.pdf', 'pdf/merge-b.pdf'])).toBe('merged');
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const big = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < 2600; i++) big.addPage([100, 100]);
  const b64 = Buffer.from(await big.save({ useObjectStreams: false })).toString('base64');
  const total = await page.evaluate(async data => {
    const app = (window as unknown as { __fileconvert: { engines: { pdf: { run<T>(t: string, p: unknown): Promise<T> } } } }).__fileconvert;
    const file = () => new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))]);
    try { await app.engines.pdf.run('merge', { files: [{ name: 'one.pdf', file: file() }, { name: 'two.pdf', file: file() }] }); return 'merged'; } catch (e) { return (e as Error).message; }
  }, b64);
  expect(total).toBe('Together the files have more than 5,000 pages, the most one merged PDF can have.');
});

test('after the memory check stops a merge, taking a file out lets it run', async ({ page, browserName }, info) => {
  // A device that says it has 512 MB (768 MB in Firefox, whose figures have a larger base): one task may use 256 MB
  // (384 MB), 128 MB above the base, so one 20 MB file fits and two do not.
  const gb = browserName === 'firefox' ? 0.75 : 0.5;
  await page.addInitScript(g => Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => g, configurable: true }), gb);
  await openApp(page);
  await openMerge(page);
  const dir = tempDir();
  execFileSync(PYTHON, ['-I', '-c', [
    'import sys, os',
    'data = os.urandom(20 << 20)',
    'img = b"<< /Type /XObject /Subtype /Image /Width 2048 /Height 3413 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length %d >>\\nstream\\n" % len(data) + data + b"\\nendstream"',
    'objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>", 2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",',
    '        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /I 4 0 R >> >> /Contents 5 0 R >>", 4: img,',
    '        5: b"<< /Length 24 >>\\nstream\\nq 612 0 0 792 0 0 cm /I Do Q\\nendstream"}',
    'out = b"%PDF-1.7\\n" + b"".join(b"%d 0 obj\\n" % k + v + b"\\nendobj\\n" for k, v in objs.items()) + b"trailer\\n<< /Root 1 0 R >>\\n%%EOF\\n"',
    'open(sys.argv[1], "wb").write(out); open(sys.argv[2], "wb").write(out)',
  ].join('\n'), `${dir}/scan-1.pdf`, `${dir}/scan-2.pdf`]);
  await add(page, [`${dir}/scan-1.pdf`, `${dir}/scan-2.pdf`, fx('pdf/merge-a.pdf')]);
  await expect(ws(page).locator('.ws-why')).toHaveText(new RegExp(`^Together these files need about \\d+ MB of memory, more than the ${gb * 512} MB FileConvert lets one task use on this device \\(half of the ${gb * 1024} MB of memory the browser reports\\), so it was not started\\. Merge fewer files at a time\\.$`));
  await ws(page).getByRole('button', { name: 'Remove scan-2.pdf' }).click();
  const { deep } = await mergeAndRead(page, info);
  expect(deep.pages).toHaveLength(4);
  expect(deep.qpdf.ok).toBe(true);
});

// First-page pictures (v0.2.0, Phase 3, decision 4): each file's row shows its first page, drawn in a render worker of
// its own, one file at a time, only for rows on screen or near it; a picture is never needed to merge.
const thumbs = (page: Page) => ws(page).locator('.ws-thumb canvas');
const inked = (page: Page, name: string) => item(page, name).locator('.ws-thumb canvas').evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
  return { w: c.width, h: c.height, ink: n / (d.length / 4) };
});

test('each file shows its first page, kept with its row as the rows move, and the merge does not wait for it', async ({ page }, info) => {
  const w = await openApp(page);
  await openMerge(page);
  await add(page, [fx('pdf/merge-a.pdf'), fx('pdf/merge-b.pdf'), fx('pdf-render/rotations.pdf')]);
  await expect(thumbs(page)).toHaveCount(3, { timeout: 30_000 });
  // Each row's picture is that file's first page: rotations.pdf starts with an upright Letter page with a red square.
  const r = await inked(page, 'rotations.pdf');
  expect(r.h).toBeGreaterThan(r.w);
  expect(r.ink).toBeGreaterThan(0.01);
  for (const li of await ws(page).locator('.ws-item').all()) expect(await li.locator('[data-thumb]').getAttribute('data-thumb')).toBe(await li.getAttribute('data-id'));
  // Moved to the top from the keyboard, the file keeps its picture, and the focus stays on it.
  await item(page, 'rotations.pdf').getByRole('button', { name: 'Move rotations.pdf up' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(order(page)).toHaveText(['rotations.pdf', 'merge-a.pdf', 'merge-b.pdf']);
  expect((await inked(page, 'rotations.pdf')).ink).toBeGreaterThan(0.01);
  await expect(thumbs(page)).toHaveCount(3);
  // A file taken out takes its picture with it.
  await item(page, 'merge-b.pdf').getByRole('button', { name: 'Remove merge-b.pdf' }).click();
  await expect(thumbs(page)).toHaveCount(2);
  const { deep } = await mergeAndRead(page, info);
  expect(deep.qpdf.ok).toBe(true);
  expect(deep.pages).toHaveLength(4 + source('merge-a.pdf').pages.length);
  expect(w.errors).toEqual([]);
  expect(w.outside).toEqual([]);
});

test('a file whose first page needs more memory than this device allows keeps a plain tile, and merges', async ({ page, browserName }, info) => {
  test.skip(browserName === 'firefox', 'Firefox reports no device memory: the stand-in below is how the other browsers are held to a small device');
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 1, configurable: true }); });
  await openApp(page);
  await openMerge(page);
  await add(page, [fx('pdf/merge-a.pdf'), fx('pdf-render/big-picture.pdf')]);
  await expect(item(page, 'merge-a.pdf').locator('.ws-thumb canvas')).toHaveCount(1, { timeout: 30_000 });
  const tile = item(page, 'big-picture.pdf').locator('.ws-thumb.generic');
  await expect(tile).toHaveAttribute('title', /^No picture of the first page: Showing the first page of this PDF needs about [\d.]+ (MB|GB) of memory, more than the 512 MB/, { timeout: 30_000 });
  await expect(tile).toHaveText('PDF');
  const { deep } = await mergeAndRead(page, info);
  expect(deep.qpdf.ok).toBe(true);
  expect(deep.pages).toHaveLength(source('merge-a.pdf').pages.length + 1);
});

test('forty files: only the rows near the screen get pictures, and more as the list scrolls', async ({ page }) => {
  await openApp(page);
  await openMerge(page);
  const dir = tempDir();
  const files = Array.from({ length: 40 }, (_, i) => { const p = resolve(dir, `n${String(i + 1).padStart(2, '0')}.pdf`); writeFileSync(p, numbered(1)); return p; });
  await add(page, files);
  // Wait until drawing stops for the rows in view, then count: far fewer than forty.
  let drawn = -1;
  for (let i = 0; i < 40; i++) {
    const n = await thumbs(page).count();
    if (n === drawn && n > 0) break;
    drawn = n;
    await page.waitForTimeout(500);
  }
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(40);
  await item(page, 'n40.pdf').scrollIntoViewIfNeeded();
  await expect(item(page, 'n40.pdf').locator('.ws-thumb canvas')).toHaveCount(1, { timeout: 30_000 });
});
