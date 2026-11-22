import { expect, test } from '@playwright/test';
import { MD_SAMPLE, addFiles, convert, cspViolations, expectDone, fx, openApp, row } from './helpers';

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
