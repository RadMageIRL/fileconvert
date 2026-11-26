import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { MD_SAMPLE, addFiles, convert, cspViolations, documentsSetting, expectDone, fx, openApp, pyRead, row, tempDir, writeTemp } from './helpers';
import { giantArray, pictures } from './pdfgen';

// Playwright's WebKit on Windows is not Safari: it has no OffscreenCanvas and no WebCodecs. These tests
// check that FileConvert does what it can there and explains clearly what it cannot. Downloads are read
// through the page, because this WebKit build does not report them to Playwright.

async function resultText(page: import('@playwright/test').Page, name: string): Promise<string> {
  return page.evaluate(async n => {
    const app = (window as unknown as { __fileconvert: { queue: { jobs: Array<{ name: string; outputs: Array<{ blob: Blob }> }> } } }).__fileconvert;
    const job = app.queue.jobs.find(j => j.name === n)!;
    return job.outputs[0].blob.text();
  }, name);
}

test('loads, converts data and documents, and explains what this browser cannot do', async ({ page }) => {
  const w = await openApp(page);
  await addFiles(page, [fx('data/records.json'), MD_SAMPLE, fx('document/sample.pdf'), fx('image/photo.jpg'), fx('audio/tone.mp3')]);
  await convert(page, 'records.json', 'CSV');
  await expectDone(page, 'records.json');
  expect(await resultText(page, 'records.json')).toContain('id,name,email,active,score,tags,address.city,address.zip,note');
  await convert(page, 'sample.md', 'HTML');
  await expectDone(page, 'sample.md');
  expect(await resultText(page, 'sample.md')).toContain('<h2>Lists</h2>');
  await convert(page, 'sample.pdf', 'TXT');
  await expectDone(page, 'sample.pdf');
  expect(await resultText(page, 'sample.pdf')).toContain('FileConvert PDF sample');
  await expect(row(page, 'photo.jpg')).toHaveClass(/unsupported/);
  await expect(row(page, 'photo.jpg').locator('.job-error')).toContainText('needs OffscreenCanvas');
  await expect(row(page, 'tone.mp3')).toHaveClass(/unsupported/);
  await expect(row(page, 'tone.mp3').locator('.job-error')).toContainText('needs WebCodecs');
  // WebKit also logs its blocked built-in styles as console errors.
  expect(w.errors.filter(e => !/^Refused to apply (a stylesheet|inline style)/.test(e))).toEqual([]);
  // WebKit flags its own built-in styling of form controls as inline styles; nothing else may be blocked.
  expect((await cspViolations(page)).filter(v => v !== 'style-src-attr inline')).toEqual([]);
  expect(w.outside).toEqual([]);
});

test('TXT to PDF works without OffscreenCanvas', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('document/sample.txt')]);
  await convert(page, 'sample.txt', 'PDF');
  await expectDone(page, 'sample.txt');
  const head = await page.evaluate(async () => {
    const app = (window as unknown as { __fileconvert: { queue: { jobs: Array<{ outputs: Array<{ blob: Blob }> }> } } }).__fileconvert;
    return new TextDecoder().decode(new Uint8Array(await app.queue.jobs[0].outputs[0].blob.slice(0, 5).arrayBuffer()));
  });
  expect(head).toBe('%PDF-');
});

test('a conversion page loads with its content, and the catalog search works', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./json-to-csv/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Convert JSON to CSV');
  await page.getByRole('searchbox', { name: 'Search conversions' }).fill('heic');
  // The TIFF tool and Images to PDF take HEIC pictures, so they match too.
  await expect(page.locator('.cat-item:not([hidden]) .cat-name')).toHaveText(['HEIC to JPG', 'HEIC to PNG', 'Combine images into a TIFF', 'Images to PDF']);
  await addFiles(page, [fx('data/records.json')]);
  await expect(row(page, 'records.json').getByRole('combobox', { name: 'Convert records.json to' })).toHaveValue('csv');
  expect(errors).toEqual([]);
});

test('a ZIP is unpacked, and a file from it converts, without OffscreenCanvas or WebCodecs', async ({ page }) => {
  const { zipSync, strToU8 } = await import('fflate');
  await openApp(page);
  const zip = zipSync({ 'data/records.json': strToU8('[{"a":1,"b":"x"},{"a":2,"b":"y"}]'), 'notes.md': strToU8('# Notes\n') });
  await addFiles(page, [{ name: 'bundle.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) }]);
  await row(page, 'bundle.zip').getByRole('button', { name: 'Extract files' }).click();
  await expect(row(page, 'bundle.zip').locator('.arc-item .arc-path')).toHaveText(['data/records.json', 'notes.md']);
  await row(page, 'bundle.zip').getByRole('checkbox', { name: 'Select data/records.json' }).check();
  await row(page, 'bundle.zip').getByRole('button', { name: 'Add 1 to the list' }).click();
  await convert(page, 'records.json', 'CSV');
  await expectDone(page, 'records.json');
  // Blob.text() decodes as UTF-8 and drops the byte order mark the CSV starts with.
  expect(await resultText(page, 'records.json')).toBe('a,b\r\n1,x\r\n2,y\r\n');
});

test('HTML to DOCX, and Markdown with its pictures in a ZIP, without OffscreenCanvas or WebCodecs', async ({ page }) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/page.html'), fx('document/structure.html')]);
  const bytesOf = (n: string) => page.evaluate(async name => {
    const app = (window as unknown as { __fileconvert: { queue: { jobs: Array<{ name: string; outputs: Array<{ name: string; blob: Blob }> }> } } }).__fileconvert;
    const out = app.queue.jobs.find(j => j.name === name)!.outputs[0];
    return { name: out.name, bytes: [...new Uint8Array(await out.blob.arrayBuffer())] };
  }, n);
  await convert(page, 'page.html', 'DOCX');
  await expectDone(page, 'page.html');
  const docx = await bytesOf('page.html');
  expect(docx.name).toBe('page.docx');
  const d = pyRead<{ blocks: Array<{ type: string; style?: string; text?: string }> }>('docx', writeTemp(tempDir(), docx.name, new Uint8Array(docx.bytes)));
  expect(d.blocks.filter(b => b.style === 'Heading 1').map(b => b.text)).toEqual(['Converting a page']);
  await documentsSetting(page, 'Pictures in Markdown (from DOCX or HTML)', 'files');
  await convert(page, 'structure.html', 'Markdown');
  await expectDone(page, 'structure.html');
  const zip = await bytesOf('structure.html');
  expect(zip.name).toBe('structure.zip');
  const z = pyRead<{ bad_crc: string | null; images: Array<{ url: string; exists: boolean }> }>('mdzip', writeTemp(tempDir(), zip.name, new Uint8Array(zip.bytes)));
  expect(z.bad_crc).toBeNull();
  expect(z.images).toHaveLength(6);
  expect(z.images.every(i => i.exists)).toBe(true);
  expect(w.outside).toEqual([]);
});

test('PDF guard and page cleanup in WebKit: a bomb is refused, page 2 of markers.pdf is removed cleanly', async ({ page }) => {
  const w = await openApp(page);
  await addFiles(page, [fx('pdf/bomb-content.pdf'), fx('pdf/encrypted-owner.pdf')]);
  for (const name of ['bomb-content.pdf', 'encrypted-owner.pdf']) {
    await row(page, name).locator('select').first().selectOption({ label: 'TXT' });
    await row(page, name).getByRole('button', { name: /^Convert/ }).click();
  }
  await expect(row(page, 'bomb-content.pdf').locator('.job-error')).toContainText('expands past 256 MB when decompressed');
  await expect(row(page, 'encrypted-owner.pdf').locator('.job-error')).toContainText('This PDF is encrypted');
  const b64 = (await import('node:fs')).readFileSync(fx('pdf/markers.pdf')).toString('base64');
  const r = await page.evaluate(async data => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const app = (window as unknown as { __fileconvert: { engines: { pdf: { run<T>(t: string, p: unknown): Promise<T> } } } }).__fileconvert;
    const out = await app.engines.pdf.run<{ bytes: Uint8Array; report: { pages: number } }>('keepPages', { file: new Blob([bytes]), order: [0, 2, 3] });
    return { pages: out.report.pages, bytes: [...out.bytes] };
  }, b64);
  expect(r.pages).toBe(3);
  const d = pyRead<{ qpdf: { ok: boolean }; pages: number; decompressed: string }>('pdf', writeTemp(tempDir(), 'markers-webkit.pdf', new Uint8Array(r.bytes)));
  expect(d.qpdf.ok).toBe(true);
  expect(d.pages).toBe(3);
  expect((await import('node:fs')).readFileSync(d.decompressed).includes('PAGE-TWO-SECRET')).toBe(false);
  expect(w.outside).toEqual([]);
});

test('Merge PDFs in WebKit: the workspace checks, merges and offers the result; independent readers agree', async ({ page }) => {
  const w = await openApp(page);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('merge-pdf'));
  const ws = page.locator('#workspace');
  await ws.locator('input[type=file]').setInputFiles([fx('pdf/merge-a.pdf'), fx('pdf/merge-b.pdf')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  // No canvas in a worker: each row keeps a plain document tile that says why, and the merge does not need a picture.
  await expect(ws.locator('.ws-thumb.generic').first()).toHaveAttribute('title', /^No picture of the first page: This browser cannot draw PDF pages in the background/, { timeout: 30_000 });
  await expect(ws.locator('.ws-thumb canvas')).toHaveCount(0);
  await ws.getByRole('button', { name: 'Merge PDFs' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  // Playwright's WebKit on Windows does not report downloads, so the result is read from the workspace itself.
  const bytes = await page.evaluate(async () => {
    const app = (window as unknown as { __fileconvert: { workspace: { outputs: Array<{ blob: Blob }> } } }).__fileconvert;
    return [...new Uint8Array(await app.workspace.outputs[0].blob.arrayBuffer())];
  });
  type Deep = { qpdf: { ok: boolean }; pages: unknown[]; pageObjects: number; renders: string[]; fields: Record<string, { value: string }> };
  const d = pyRead<Deep>('pdfdeep', writeTemp(tempDir(), 'merged-webkit.pdf', new Uint8Array(bytes)));
  const a = pyRead<Deep>('pdfdeep', fx('pdf/merge-a.pdf')), b = pyRead<Deep>('pdfdeep', fx('pdf/merge-b.pdf'));
  expect(d.qpdf.ok).toBe(true);
  expect(d.pages).toHaveLength(5);
  expect(d.pageObjects).toBe(5);
  expect(d.renders).toEqual([...a.renders, ...b.renders]);
  expect(d.fields.name_2.value).toBe('Bob');
  expect(w.outside).toEqual([]);
});

test('Split and rotate in WebKit: the page tools check, work and offer their results; independent readers agree', async ({ page }) => {
  const w = await openApp(page);
  const ws = page.locator('#workspace');
  type Deep = { qpdf: { ok: boolean }; pages: Array<{ rotate: number }>; renders: string[] };
  const outputs = () => page.evaluate(async () => {
    const app = (window as unknown as { __fileconvert: { workspace: { outputs: Array<{ name: string; blob: Blob }> } } }).__fileconvert;
    return Promise.all(app.workspace.outputs.map(async o => ({ name: o.name, bytes: [...new Uint8Array(await o.blob.arrayBuffer())] })));
  });
  const a = pyRead<Deep>('pdfdeep', fx('pdf/merge-a.pdf'));
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('split-pdf'));
  await ws.locator('input[type=file]').setInputFiles([fx('pdf/merge-a.pdf')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  await ws.locator('[data-key="opt-mode"]').selectOption('each');
  await ws.getByRole('button', { name: 'Split the PDF' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  const parts = await outputs();
  expect(parts.map(p => p.name)).toEqual(['merge-a-p1.pdf', 'merge-a-p2.pdf', 'merge-a-p3.pdf']);
  const dir = tempDir();
  const read = parts.map(p => pyRead<Deep>('pdfdeep', writeTemp(dir, p.name, new Uint8Array(p.bytes))));
  expect(read.every(d => d.qpdf.ok)).toBe(true);
  expect(read.flatMap(d => d.renders)).toEqual(a.renders);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('rotate-pdf'));
  await ws.locator('input[type=file]').setInputFiles([fx('pdf/merge-a.pdf')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  await ws.getByRole('button', { name: 'Rotate the pages' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  const [turned] = await outputs();
  expect(pyRead<Deep>('pdfdeep', writeTemp(dir, turned.name, new Uint8Array(turned.bytes))).pages.map(p => p.rotate)).toEqual([90, 90, 270]);
  expect(w.outside).toEqual([]);
});

test('the PDF memory allowance in WebKit: no device memory and no heap limit reported, so 2 GB is assumed for a computer', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('merge-pdf'));
  expect(await page.evaluate(() => (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null)).toBeNull();
  expect(await page.evaluate(() => (performance as Performance & { memory?: unknown }).memory ?? null)).toBeNull();
  const { estimate } = await import('../../src/core/pdfmemory');
  const MB = 1048576;
  const w = (bytes: number) => ({ bytes, parsed: 0, objects: 0, pages: 1 });
  let lo = 0, hi = 1024 * MB;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (estimate([w(mid), w(mid)], 'edit').total <= 2048 * MB) lo = mid; else hi = mid; }
  const check = (bytes: number) => page.evaluate(b => {
    const app = (window as unknown as { __fileconvert: { workspace: { def: { check(i: unknown[], v: unknown): string | null } } } }).__fileconvert;
    const one = { file: { size: 1 }, pages: 1, work: { bytes: b, parsed: 0, objects: 0, pages: 1 } };
    return app.workspace.def.check([one, one], {});
  }, bytes);
  expect(await check(lo)).toBeNull();
  expect(await check(hi)).toMatch(/^Together these files need about .* of memory, more than the 2\.00 GB FileConvert lets one task use in a browser that does not say how much memory the device has, so it was not started\. Merge fewer files at a time\. Chrome and Edge say how much memory the device has, so FileConvert may allow more there\.$/);
});

test('WebKit: a 100 KB PDF that would become 50 million objects is refused as it is added; a small one is then edited', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('rotate-pdf'));
  const ws = page.locator('#workspace');
  const bomb = `${tempDir()}/tiny-bomb.pdf`;
  writeFileSync(bomb, giantArray(50));
  await ws.locator('input[type=file]').setInputFiles([bomb]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  await expect(ws.locator('.ws-item .job-error')).toHaveText(/^This PDF needs about [\d.]+ GB of memory, more than the 2\.00 GB FileConvert lets one task use in a browser that does not say how much memory the device has, so it was not started\. Chrome and Edge say how much memory the device has, so FileConvert may allow more there\.$/);
  await ws.getByRole('button', { name: 'Remove tiny-bomb.pdf' }).click();
  await ws.locator('input[type=file]').setInputFiles([fx('pdf/merge-a.pdf')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  await ws.getByRole('button', { name: 'Rotate the pages' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
});

test('WebKit on an iPhone or iPad: no device memory reported, so a phone or tablet with 2 GB is assumed, and 1 GB allowed', async ({ browser }) => {
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    // An iPad asks for desktop sites, so it says it is a Mac; it has a touch screen.
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  ]) {
    const context = await browser.newContext({ userAgent: ua, hasTouch: true, isMobile: false });
    const page = await context.newPage();
    if (!/iPhone/.test(ua)) await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 }); });
    await openApp(page);
    await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('rotate-pdf'));
    const ws = page.locator('#workspace');
    // 250 MB of pictures: within the 2 GB assumed for a computer, not the 1 GB for a phone or tablet.
    const scan = `${tempDir()}/scan-250mb.pdf`;
    writeFileSync(scan, pictures(10, 25));
    await ws.locator('input[type=file]').setInputFiles([scan]);
    await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 120_000 });
    await expect(ws.locator('.ws-item .job-error')).toHaveText(/^This PDF needs about [\d.]+ GB of memory, more than the 1\.00 GB FileConvert lets one task use on a phone or tablet whose browser does not say how much memory it has, so it was not started\. Chrome and Edge say how much memory the device has, so FileConvert may allow more there\.$/);
    await context.close();
  }
});

test('Images to PDF in WebKit: JPEG, PNG, TIFF and HEIC go in exactly; a WebP, which needs a canvas in a worker, says why not', async ({ page }) => {
  const w = await openApp(page);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('images-to-pdf'));
  const ws = page.locator('#workspace');
  await ws.locator('[data-key="opt-size"]').selectOption('picture');
  const sources = [fx('image-pdf/orient6.jpg'), fx('image-pdf/rgba16.png'), fx('image-pdf/pal8-trns.png'), fx('image/two-pages.tiff'), fx('image/photo.heic')];
  await ws.locator('input[type=file]').setInputFiles([...sources, fx('image/alpha.webp')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  const webp = ws.locator('.ws-item').filter({ hasText: 'alpha.webp' });
  await expect(webp.locator('.job-error')).toContainText('it has no OffscreenCanvas');
  await ws.getByRole('button', { name: 'Make the PDF' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 120_000 });
  const bytes = await page.evaluate(async () => {
    const app = (window as unknown as { __fileconvert: { workspace: { outputs: Array<{ blob: Blob }> } } }).__fileconvert;
    return [...new Uint8Array(await app.workspace.outputs[0].blob.arrayBuffer())];
  });
  const pdf = writeTemp(tempDir(), 'images-webkit.pdf', new Uint8Array(bytes));
  const spec = writeTemp(tempDir(), 'spec.json', new TextEncoder().encode(JSON.stringify({ pdf, sources, pictureSize: true })));
  type R = { qpdf: boolean; pages: Array<{ source: string; exact?: boolean; alphaExact?: boolean; jpegSame?: boolean; render?: { max: number } }> };
  const r = pyRead<R>('imagepdf', spec);
  expect(r.qpdf).toBe(true);
  expect(r.pages.map(p => p.source)).toEqual(['orient6.jpg', 'rgba16.png', 'pal8-trns.png', 'two-pages.tiff', 'two-pages.tiff', 'photo.heic']);
  expect(r.pages.slice(0, 3).map(p => [p.exact, p.render!.max <= 1])).toEqual([[true, true], [true, true], [true, true]]);
  expect(r.pages[0].jpegSame).toBe(true);
  expect(r.pages[1].alphaExact).toBe(true);
  expect(w.outside).toEqual([]);
});

test('page previews, PDF to JPG and PNG, and Remove PDF metadata in WebKit: what needs a canvas in a worker says so; the rest works', async ({ page }) => {
  const w = await openApp(page);
  const ws = page.locator('#workspace');
  const open = (id: string) => page.evaluate(t => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool(t), id);
  // Previews are off with the reason; pages are still chosen in the grid, and the tool runs.
  await open('delete-pdf-pages');
  await ws.locator('input[type=file]').setInputFiles([fx('pdf/merge-a.pdf')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  await expect(ws.locator('.pg-note')).toHaveText('Previews are off for this PDF. This browser cannot draw PDF pages in the background: it has no OffscreenCanvas in workers. Current Chrome, Edge, Firefox and Safari (16.4 and later) have it. You can still choose pages here or by typing them.', { timeout: 30_000 });
  await expect(ws.locator('.pg-tile .pg-ph')).toHaveText(['1', '2', '3']);
  await ws.locator('.pg-tile').nth(1).click();
  await expect(ws.locator('[data-key="opt-pages"]')).toHaveValue('2');
  await ws.getByRole('button', { name: 'Delete the pages' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  // PDF to JPG and PNG is not offered as if it worked: the catalog marks it, and its workspace says why before a file is
  // added, and takes none.
  await expect(page.locator('.cat-item[data-tool="pdf-to-images"] .cat-note')).toHaveText(['Not available in this browser', 'Not available in this browser']);
  await open('pdf-to-images');
  await expect(ws.locator('.ws-unavailable')).toHaveText('This browser cannot draw in the background (it has no OffscreenCanvas), so this tool cannot run here. Current Chrome, Edge, Firefox and Safari 16.4 or later can.');
  await expect(ws.getByRole('button', { name: 'Add files' })).toBeDisabled();
  await ws.locator('input[type=file]').setInputFiles([fx('pdf/merge-a.pdf')]);
  await expect(ws.locator('.ws-item')).toHaveCount(0);
  await expect(ws.getByRole('button', { name: 'Convert the pages' })).toBeDisabled();
  // Metadata removal needs no canvas.
  await open('remove-pdf-metadata');
  await ws.locator('input[type=file]').setInputFiles([fx('pdf-render/metadata.pdf')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  await ws.getByRole('button', { name: 'Remove the metadata' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  const bytes = await page.evaluate(async () => [...new Uint8Array(await (window as unknown as { __fileconvert: { workspace: { outputs: Array<{ blob: Blob }> } } }).__fileconvert.workspace.outputs[0].blob.arrayBuffer())]);
  const meta = pyRead<{ qpdf: { ok: boolean }; words: string[] }>('pdfmeta', writeTemp(tempDir(), 'out.pdf', new Uint8Array(bytes)));
  expect(meta.qpdf.ok).toBe(true);
  expect(meta.words.filter(x => x.startsWith('MARK-'))).toEqual([]);
  expect(w.outside).toEqual([]);
});
