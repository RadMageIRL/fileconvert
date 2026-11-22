import { expect, test } from '@playwright/test';
import { MD_SAMPLE, addFiles, convert, cspViolations, documentsSetting, expectDone, fx, openApp, pyRead, row, tempDir, writeTemp } from './helpers';

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
  // The TIFF tool takes HEIC pictures, so it matches too.
  await expect(page.locator('.cat-item:not([hidden]) .cat-name')).toHaveText(['HEIC to JPG', 'HEIC to PNG', 'Combine images into a TIFF']);
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
