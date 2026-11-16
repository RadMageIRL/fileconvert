import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { MD_SAMPLE, PYTHON, addFiles, convert, convertAllTo, cspViolations, download, downloadZip, expectDone, fx, openApp, row } from './helpers';

const png = () => readFileSync(fx('image/alpha.png'));

test('results with the same name are numbered, in single downloads and in the ZIP', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/alpha.png'), fx('image/alpha.webp'), fx('image/alpha.tiff')]);
  await convertAllTo(page, 'JPG');
  const names = [];
  for (const f of ['alpha.png', 'alpha.webp', 'alpha.tiff']) names.push((await download(page, f, info)).filename);
  expect(names).toEqual(['alpha.jpg', 'alpha (2).jpg', 'alpha (3).jpg']);
  const zip = await downloadZip(page, info);
  expect(Object.keys(zip.entries).sort()).toEqual(['alpha (2).jpg', 'alpha (3).jpg', 'alpha.jpg']);
});

test('numbered names follow the list order, not the order conversions finish in', async ({ page }) => {
  // The first file is a large picture (slow to encode as AVIF), the second a small one (fast). The first
  // in the list must still get the plain name.
  const big = (await import('node:child_process')).execFileSync(PYTHON, ['-I', '-c', [
    'import sys, io, numpy as np', 'from PIL import Image',
    'rng = np.random.default_rng(3)', 'a = rng.integers(0, 255, (1500, 2000, 3), dtype=np.uint8)',
    'b = io.BytesIO(); Image.fromarray(a).save(b, "PNG"); sys.stdout.buffer.write(b.getvalue())',
  ].join('\n')], { maxBuffer: 64 * 1024 * 1024 });
  await openApp(page);
  await page.locator('#picker').setInputFiles([
    { name: 'pic.png', mimeType: 'image/png', buffer: big },
    { name: 'pic.jpg', mimeType: 'image/jpeg', buffer: readFileSync(fx('image/photo.jpg')) },
  ]);
  await convertAllTo(page, 'AVIF');
  await expect(row(page, 'pic.png').locator('.outputs button')).toHaveText('Download pic.avif');
  await expect(row(page, 'pic.jpg').locator('.outputs button')).toHaveText('Download pic (2).avif');
});

test('hostile file names are shown as text and never become paths or markup', async ({ page }, info) => {
  const w = await openApp(page);
  await page.locator('#picker').setInputFiles([
    { name: '<img src=x onerror="window.__pwned=1">.png', mimeType: 'image/png', buffer: png() },
    { name: 'CON.png', mimeType: 'image/png', buffer: png() },
    { name: 'invoice\u202egnp.exe.png', mimeType: 'image/png', buffer: png() },
  ]);
  await expect(page.locator('li.job')).toHaveCount(3);
  await expect(page.locator('.job-name').first()).toHaveText('<img src=x onerror="window.__pwned=1">.png');
  await convertAllTo(page, 'WebP');
  const zip = await downloadZip(page, info);
  const names = Object.keys(zip.entries).sort();
  expect(names).toEqual(['_CON.webp', '_img src=x onerror=_window.__pwned=1__.webp', 'invoice_gnp.exe.webp'].sort());
  for (const n of names) expect(n).not.toMatch(/[\\/<>:"|?*\u202e]/);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(w.errors).toEqual([]);
});

test('a batch of 30 files converts and packs into one ZIP with unique names', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  const files = Array.from({ length: 30 }, () => ({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: readFileSync(fx('image/photo.jpg')) }));
  await page.locator('#picker').setInputFiles(files);
  await expect(page.locator('li.job')).toHaveCount(30);
  await expect(page.locator('#convert-all')).toHaveText('Convert all (30)');
  await convertAllTo(page, 'PNG');
  await expect(page.locator('li.job.done')).toHaveCount(30);
  const zip = await downloadZip(page, info);
  const names = Object.keys(zip.entries);
  expect(names).toHaveLength(30);
  expect(names).toContain('photo.png');
  expect(names).toContain('photo (30).png');
});

test('keyboard only: add, choose an output, convert and download', async ({ page }, info) => {
  await openApp(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip')).toBeFocused();
  let guard = 0;
  while (!(await page.locator('#choose').evaluate(el => el === document.activeElement)) && guard++ < 10) await page.keyboard.press('Tab');
  await expect(page.locator('#choose')).toBeFocused();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await chooser.setFiles([fx('image/photo.bmp')]);
  await expect(row(page, 'photo.bmp')).toHaveClass(/ready/);
  const select = row(page, 'photo.bmp').getByRole('combobox', { name: 'Convert photo.bmp to' });
  await select.focus();
  await select.selectOption({ label: 'WebP' });
  await page.keyboard.press('Tab');
  await expect(row(page, 'photo.bmp').getByRole('button', { name: 'Convert' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page, 'photo.bmp')).toHaveClass(/done/);
  const dl = row(page, 'photo.bmp').getByRole('button', { name: 'Download photo.webp' });
  await dl.focus();
  const [d] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(d.suggestedFilename()).toBe('photo.webp');
  void info;
});

test('every control has an accessible name and the page has one main landmark and a skip link', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('image/photo.jpg'), fx('audio/tone.mp3'), fx('video/clip.mp4'), MD_SAMPLE, fx('data/workbook.xlsx')]);
  await expect(page.locator('li.job.checking')).toHaveCount(0);
  for (const d of await page.locator('details.panel').all()) await d.locator('summary').click();
  const unnamed = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('button, select, input:not([type=hidden]), a[href]')) {
      if ((el as HTMLElement).hidden || (el as HTMLInputElement).type === 'file') continue;
      const label = (el as HTMLElement).getAttribute('aria-label') || (el.closest('label')?.textContent ?? '') || el.textContent;
      if (!label || !label.trim()) out.push(el.outerHTML.slice(0, 80));
    }
    return out;
  });
  expect(unnamed).toEqual([]);
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Back to RadMage Labs' })).toHaveAttribute('href', 'https://radmagelabs.com/');
});

test('the theme switch works and is remembered', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#theme')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('Share passes only the public address, through the share sheet or the clipboard', async ({ page, browserName }) => {
  await page.addInitScript(() => {
    (window as unknown as { __shared: unknown[] }).__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: unknown) => { (window as unknown as { __shared: unknown[] }).__shared.push(d); } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  });
  await openApp(page);
  await page.getByRole('button', { name: 'Share' }).click();
  const shared = await page.evaluate(() => (window as unknown as { __shared: Array<{ url: string }> }).__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0].url).toBe('https://radmagelabs.com/fileconvert/');
  // Without a share sheet the address is copied.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { (window as unknown as { __copied: string }).__copied = t; } } });
  });
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('#toast')).toContainText('Link copied: https://radmagelabs.com/fileconvert/');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe('https://radmagelabs.com/fileconvert/');
  void browserName;
});

test('narrow screens: no sideways scrolling with files in the list', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp(page);
  await page.locator('#picker').setInputFiles([
    { name: 'a-very-long-file-name-without-any-spaces-at-all-to-test-wrapping-in-narrow-layouts.png', mimeType: 'image/png', buffer: png() },
  ]);
  await addFiles(page, [fx('video/clip.mp4'), fx('data/workbook.xlsx')]);
  await expect(page.locator('li.job.checking')).toHaveCount(0);
  for (const d of await page.locator('details.panel').all()) await d.locator('summary').click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('conversions keep working offline once the converter has loaded', async ({ page, context }) => {
  await openApp(page);
  await addFiles(page, [fx('image/photo.jpg')]);
  await convert(page, 'photo.jpg', 'PNG');
  await expectDone(page, 'photo.jpg');
  await context.setOffline(true);
  await addFiles(page, [fx('image/alpha.webp')]);
  await convert(page, 'alpha.webp', 'PNG');
  await expectDone(page, 'alpha.webp');
  // A converter that was never loaded says why it cannot start.
  await addFiles(page, [fx('data/records.json')]);
  await expect(row(page, 'records.json')).toHaveClass(/ready/);
  await convert(page, 'records.json', 'CSV');
  await expect(row(page, 'records.json')).toHaveClass(/failed/);
  await expect(row(page, 'records.json').locator('.job-error')).toContainText('offline');
  await context.setOffline(false);
  await convert(page, 'records.json', 'CSV');
  await expectDone(page, 'records.json');
});

test('removing and clearing releases thumbnails and temporary files', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('image/photo.jpg'), fx('image/alpha.png'), fx('audio/tone.wav')]);
  await convertAllTo(page, 'PNG');
  await convert(page, 'tone.wav', 'MP3');
  await expect(page.locator('li.job.done')).toHaveCount(3);
  const app = () => page.evaluate(async () => {
    const a = (window as unknown as { __fileconvert: { liveUrls(): number; tempFiles(): Promise<string[]> } }).__fileconvert;
    return { urls: a.liveUrls(), temp: (await a.tempFiles()).length };
  });
  expect(await app()).toEqual({ urls: 2, temp: 1 });
  await row(page, 'photo.jpg').getByRole('button', { name: 'Remove photo.jpg' }).click();
  await expect(page.locator('li.job')).toHaveCount(2);
  expect((await app()).urls).toBe(1);
  await page.locator('#clear').click();
  await expect(page.locator('#work')).toBeHidden();
  await expect.poll(app).toEqual({ urls: 0, temp: 0 });
  await expect(page.locator('#choose')).toBeFocused();
});

test('archives and other unsupported files are explained, not converted', async ({ page }) => {
  await openApp(page);
  const { zipSync } = await import('fflate');
  await page.locator('#picker').setInputFiles([
    { name: 'photos.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'a.txt': new Uint8Array([65]) })) },
    { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  ]);
  await expect(row(page, 'photos.zip').locator('.job-error')).toContainText('Extract the files');
  await expect(row(page, 'drawing.svg').locator('.job-error')).toContainText('SVG images are not supported yet');
  await expect(page.locator('#convert-all')).toBeDisabled();
});

test('the page works with only its own security policy, as on GitHub Pages', async ({ page }) => {
  // The test server sends the policy as a header; the built page also carries it as a meta tag.
  await openApp(page);
  const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(meta).toContain("default-src 'none'");
  expect(meta).toContain("connect-src 'self' blob: data:");
  expect(await cspViolations(page)).toEqual([]);

});

test('temporary files of a tab that closed without cleaning up are deleted when the page opens again', async ({ browser }) => {
  const context = await browser.newContext();
  const a = await context.newPage();
  await openApp(a);
  await addFiles(a, [fx('audio/tone.wav')]);
  await convert(a, 'tone.wav', 'MP3');
  await expectDone(a, 'tone.wav');
  const listAll = (p: import('@playwright/test').Page) => p.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fileconvert-temp');
    const out: string[] = [];
    for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) out.push(name);
    return out;
  });
  const before = await listAll(a);
  expect(before).toHaveLength(1);
  // Closing the page releases its lock without running any cleanup code, as a crash would.
  await a.close({ runBeforeUnload: false });
  const b = await context.newPage();
  await openApp(b);
  const after = await listAll(b);
  expect(after).toHaveLength(1);
  expect(after).not.toContain(before[0]);
  await context.close();
});
