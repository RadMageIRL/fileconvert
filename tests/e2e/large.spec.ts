// Large, realistic files, run on request: npx playwright test --project large
// Inputs are generated into the system temp folder on first use (FFmpeg and the local Python venv).
// Each test records how long the conversion took and the longest the page went without responding.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PYTHON, addFiles, convert, expectDone, ffprobe, openApp, pillow, row } from './helpers';

const DIR = join(tmpdir(), 'fileconvert-large');
mkdirSync(DIR, { recursive: true });
const REPORT = join('test-results', 'large-report.txt');

function make(name: string, build: (p: string) => void): string {
  const p = join(DIR, name);
  if (!existsSync(p)) build(p);
  return p;
}

/** Samples the main thread every 50 ms; returns the worst gap (a frozen page shows as a long gap). */
async function watchLag(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __lag: number; __lagTimer: number };
    w.__lag = 0;
    let last = performance.now();
    w.__lagTimer = window.setInterval(() => { const now = performance.now(); w.__lag = Math.max(w.__lag, now - last - 50); last = now; }, 50);
  });
  return () => page.evaluate(() => { const w = window as unknown as { __lag: number; __lagTimer: number }; clearInterval(w.__lagTimer); return Math.round(w.__lag); });
}

function record(line: string): void {
  mkdirSync('test-results', { recursive: true });
  appendFileSync(REPORT, line + '\n');
  console.log(line);
}

test('a 48-megapixel photo to WebP, and resized to PNG', async ({ page }, info) => {
  const src = make('photo-48mp.jpg', p => execFileSync(PYTHON, ['-I', '-c', [
    'import sys, numpy as np', 'from PIL import Image',
    'h, w = 6000, 8000', 'y, x = np.mgrid[0:h, 0:w]',
    'rng = np.random.default_rng(1)',
    'img = np.stack([(x * 255 // w), (y * 255 // h), ((x + y) % 256)], -1).astype(np.int16) + rng.integers(-20, 20, (h, w, 3))',
    'Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(sys.argv[1], quality=92)',
  ].join('\n'), p]));
  await openApp(page);
  await addFiles(page, [src]);
  const lag = await watchLag(page);
  const t0 = Date.now();
  await convert(page, 'photo-48mp.jpg', 'WebP', 600_000);
  await expectDone(page, 'photo-48mp.jpg');
  const secs = (Date.now() - t0) / 1000;
  const worst = await lag();
  const out = info.outputPath('big.webp');
  const [dl] = await Promise.all([page.waitForEvent('download'), row(page, 'photo-48mp.jpg').locator('.outputs button').click()]);
  await dl.saveAs(out);
  expect(pillow(out).size).toEqual([8000, 6000]);
  record(`48 MP JPG (${(statSync(src).size / 1048576).toFixed(1)} MB) to WebP: ${secs.toFixed(1)} s, output ${(statSync(out).size / 1048576).toFixed(1)} MB, worst main-thread gap ${worst} ms`);
  expect(worst).toBeLessThan(500);
  await page.locator('details[data-cat="image"] summary').click();
  await page.locator('details[data-cat="image"]').getByRole('combobox', { name: 'Resize' }).selectOption('percent');
  await page.getByRole('spinbutton', { name: 'Percent' }).fill('25');
  await page.getByRole('spinbutton', { name: 'Percent' }).press('Tab');
  const t1 = Date.now();
  await convert(page, 'photo-48mp.jpg', 'PNG', 600_000);
  await expectDone(page, 'photo-48mp.jpg');
  record(`48 MP JPG resized to 25% as PNG: ${((Date.now() - t1) / 1000).toFixed(1)} s`);
});

test('a 1 GB video copied into another container, and a 1080p clip re-encoded to 720p', async ({ page }, info) => {
  const big = make('big-1gb.mp4', p => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=270', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=270',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '55M', '-maxrate', '55M', '-bufsize', '20M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]));
  await openApp(page);
  await addFiles(page, [big]);
  const lag = await watchLag(page);
  const heap0 = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  const t0 = Date.now();
  await convert(page, 'big-1gb.mp4', 'MKV', 900_000);
  await expectDone(page, 'big-1gb.mp4');
  const secs = (Date.now() - t0) / 1000;
  const heap1 = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  const worst = await lag();
  const out = info.outputPath('big.mkv');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600_000 }), row(page, 'big-1gb.mp4').locator('.outputs button').click()]);
  await dl.saveAs(out);
  const probe = ffprobe(out);
  expect(Math.abs(Number(probe.format.duration) - 270)).toBeLessThan(0.5);
  record(`1 GB MP4 (${(statSync(big).size / 1073741824).toFixed(2)} GB) to MKV, streams copied: ${secs.toFixed(1)} s, page heap ${(heap0 / 1048576).toFixed(0)} to ${(heap1 / 1048576).toFixed(0)} MB, worst main-thread gap ${worst} ms`);
  expect(worst).toBeLessThan(500);
  await page.locator('#clear').click();

  const clip = make('clip-1080p-30s.mp4', p => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]));
  await addFiles(page, [clip]);
  await page.locator('details[data-cat="video"] summary').click();
  await page.locator('details[data-cat="video"]').getByRole('combobox', { name: 'Resolution' }).selectOption('720');
  const lag2 = await watchLag(page);
  const t1 = Date.now();
  await convert(page, 'clip-1080p-30s.mp4', 'MP4', 900_000);
  await expectDone(page, 'clip-1080p-30s.mp4');
  const secs2 = (Date.now() - t1) / 1000;
  const worst2 = await lag2();
  record(`30 s 1080p H.264 to 720p MP4 (re-encoded): ${secs2.toFixed(1)} s, worst main-thread gap ${worst2} ms`);
  expect(worst2).toBeLessThan(500);
});

test('a 50 MB CSV to JSON and to XLSX', async ({ page }) => {
  const csv = make('rows-50mb.csv', p => execFileSync(PYTHON, ['-I', '-c', [
    'import sys, random', 'random.seed(1)',
    'with open(sys.argv[1], "w", encoding="utf-8", newline="") as f:',
    '    f.write("id,name,email,amount,zip,note\\r\\n")',
    '    i = 0',
    '    while f.tell() < 50 * 1024 * 1024:',
    '        i += 1',
    '        f.write(f"{i},Person {i},p{i}@example.com,{random.randint(-9999, 99999) / 100},{random.randint(0, 99999):05d},\\"Note, with comma {i}\\"\\r\\n")',
  ].join('\n'), p]));
  await openApp(page);
  await addFiles(page, [csv]);
  const lag = await watchLag(page);
  const t0 = Date.now();
  await convert(page, 'rows-50mb.csv', 'JSON', 600_000);
  await expectDone(page, 'rows-50mb.csv');
  record(`50 MB CSV to JSON: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${await row(page, 'rows-50mb.csv').locator('.job-status').innerText()}`);
  const t1 = Date.now();
  await convert(page, 'rows-50mb.csv', 'XLSX', 600_000);
  await expectDone(page, 'rows-50mb.csv');
  const worst = await lag();
  record(`50 MB CSV to XLSX: ${((Date.now() - t1) / 1000).toFixed(1)} s, worst main-thread gap ${worst} ms`);
  expect(worst).toBeLessThan(500);
});

/** Private memory of every process of a Chrome started with this profile folder, in MB (Windows only; 0 elsewhere). */
async function browserMemory(profile: string): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const { execFile } = await import('node:child_process');
  const marker = profile.split(/[\\/]/).pop()!;
  const script = `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object -Property PrivatePageCount -Sum).Sum`;
  return new Promise(resolve => execFile('powershell', ['-NoProfile', '-Command', script], (err, out) => resolve(err ? 0 : Number(String(out).trim()) / 1048576)));
}

// A normal, on-disk profile: Playwright's default contexts are off the record, and there, as in a private window,
// Chrome keeps the private file system in memory (measured: the browser process grows by what is unpacked).
test('a 1.2 GB ZIP is unpacked to private storage, not memory, and its files are byte-exact', async ({ baseURL }, info) => {
  const src = make('archive-1200mb.zip', p => execFileSync(PYTHON, ['-I', '-c', [
    'import sys, os, zipfile, hashlib, random',
    'h = hashlib.sha256(); rnd = random.Random(7)',
    'with zipfile.ZipFile(sys.argv[1], "w") as z:',
    '    for name in ["random-1.bin", "random-2.bin"]:',
    '        with z.open(zipfile.ZipInfo(name), "w", force_zip64=True) as f:',
    '            for _ in range(25): f.write(rnd.randbytes(16 * 1048576))',
    '    info = zipfile.ZipInfo("log.txt"); info.compress_type = zipfile.ZIP_DEFLATED',
    '    with z.open(info, "w", force_zip64=True) as f:',
    '        for block in range(400):',
    '            chunk = "".join(f"{block * 26000 + i},event-{rnd.randrange(1000)},user{rnd.randrange(50000)},{rnd.random():.6f}\\n" for i in range(26000)).encode()',
    '            h.update(chunk); f.write(chunk)',
    'open(sys.argv[1] + ".sha256", "w").write(h.hexdigest())',
  ].join('\n'), p], { timeout: 900_000 }));
  const expectedSha = (await import('node:fs')).readFileSync(src + '.sha256', 'utf8').trim();
  const { chromium } = await import('@playwright/test');
  const { mkdtempSync } = await import('node:fs');
  const profile = mkdtempSync(join(tmpdir(), 'fc-profile-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', baseURL, acceptDownloads: true });
  const page = context.pages()[0] ?? await context.newPage();
  await openApp(page);
  await addFiles(page, [src]);
  await expect(row(page, 'archive-1200mb.zip').getByRole('button', { name: 'Extract files' })).toBeVisible();
  const base = await browserMemory(profile);
  let peak = base;
  let sampling = true;
  const sampler = (async () => { while (sampling) { peak = Math.max(peak, await browserMemory(profile)); await new Promise(r => setTimeout(r, 1000)); } })();
  const lag = await watchLag(page);
  const t0 = Date.now();
  await row(page, 'archive-1200mb.zip').getByRole('button', { name: 'Extract files' }).click();
  await expect(row(page, 'archive-1200mb.zip')).toHaveClass(/done/, { timeout: 900_000 });
  const secs = (Date.now() - t0) / 1000;
  sampling = false;
  await sampler;
  const worst = await lag();
  const items = row(page, 'archive-1200mb.zip').locator('.arc-item:not(.skipped)');
  await expect(items).toHaveCount(3);
  const unpacked = await page.evaluate(() => (window as unknown as { __fileconvert: { queue: { jobs: Array<{ archive?: { entries: Array<{ size: number }> } }> } } }).__fileconvert.queue.jobs[0].archive!.entries.reduce((n, e) => n + e.size, 0));
  const out = info.outputPath('log.txt');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600_000 }), row(page, 'archive-1200mb.zip').getByRole('button', { name: 'Download log.txt' }).click()]);
  await dl.saveAs(out);
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const sha = await new Promise<string>((resolve, reject) => { const h = createHash('sha256'); createReadStream(out).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
  expect(sha).toBe(expectedSha);
  const rise = peak - base;
  record(`ZIP of ${(statSync(src).size / 1048576).toFixed(0)} MB unpacked to ${(unpacked / 1048576).toFixed(0)} MB in private storage: ${secs.toFixed(1)} s, browser memory rose ${rise.toFixed(0)} MB at most (from ${base.toFixed(0)} MB), worst main-thread gap ${worst} ms`);
  expect(worst).toBeLessThan(500);
  // Held in memory, the files alone would add 1,200 MB.
  if (base) expect(rise).toBeLessThan(400);
  await row(page, 'archive-1200mb.zip').getByRole('button', { name: 'Remove archive-1200mb.zip' }).click();
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as { __fileconvert: { tempFiles(): Promise<string[]> } }).__fileconvert.tempFiles()).length), { timeout: 60_000 }).toBe(0);
  await context.close();
});
