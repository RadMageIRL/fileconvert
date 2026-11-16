import { expect, test } from '@playwright/test';
import { addFiles, convert, cspViolations, expectDone, fx, openApp, row } from './helpers';

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
  await addFiles(page, [fx('data/records.json'), fx('document/sample.md'), fx('document/sample.pdf'), fx('image/photo.jpg'), fx('audio/tone.mp3')]);
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
