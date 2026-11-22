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

// An ordinary large PDF: 2,000 pages of text, 16 pages of incompressible pictures and 20 nearly white 600 dpi A4
// scans stored losslessly (104 MB each decompressed), 2.3 GB decompressed in all. It must pass the guard, give its
// text, and have pages removed in the PDF worker, with the browser's memory measured.
function ordinaryLargePdf(): string {
  return make('ordinary-large.pdf', p => execFileSync(PYTHON, ['-I', '-c', [
    'import sys, zlib, random',
    'rnd = random.Random(3); objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>", 3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}',
    'kids = []; n = 10',
    'def stream(d, extra=b""): return b"<< /Length %d%s >>\\nstream\\n" % (len(d), extra) + d + b"\\nendstream"',
    'noise = zlib.compress(rnd.randbytes(2500 * 2000 * 3), 1)',
    'white = zlib.compress(bytes([255]) * (4960 * 7016 * 3), 9)',
    'for i in range(2036):',
    '    content = b"BT /F1 12 Tf 72 720 Td (Page %d of an ordinary large PDF, LARGE-MARK-%05d) Tj ET" % (i + 1, i + 1)',
    '    res = b"<< /Font << /F1 3 0 R >> >>"',
    '    if i % 125 == 0 and i < 2000:',
    '        objs[n + 2] = stream(noise, b" /Type /XObject /Subtype /Image /Width 2500 /Height 2000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode")',
    '        content += b" q 500 0 0 400 50 200 cm /Im0 Do Q"; res = b"<< /Font << /F1 3 0 R >> /XObject << /Im0 %d 0 R >> >>" % (n + 2)',
    '    if i >= 2016:',
    '        objs[n + 2] = stream(white, b" /Type /XObject /Subtype /Image /Width 4960 /Height 7016 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode")',
    '        content += b" q 595 0 0 842 0 0 cm /Im0 Do Q"; res = b"<< /Font << /F1 3 0 R >> /XObject << /Im0 %d 0 R >> >>" % (n + 2)',
    '    objs[n + 1] = stream(zlib.compress(content), b" /Filter /FlateDecode")',
    '    objs[n] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources %s /Contents %d 0 R >>" % (res, n + 1)',
    '    kids.append(n); n += 3',
    'objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))',
    'out = bytearray(b"%PDF-1.7\\n"); offs = {}',
    'for k in sorted(objs): offs[k] = len(out); out += b"%d 0 obj\\n" % k + objs[k] + b"\\nendobj\\n"',
    'x = len(out); size = max(objs) + 1',
    'out += b"xref\\n0 %d\\n0000000000 65535 f \\n" % size + b"".join((b"%010d 00000 n \\n" % offs[k]) if k in offs else b"0000000000 65535 f \\n" for k in range(1, size))',
    'out += b"trailer\\n<< /Size %d /Root 1 0 R >>\\nstartxref\\n%d\\n%%%%EOF\\n" % (size, x)',
    'open(sys.argv[1], "wb").write(out)',
  ].join('\n'), p], { timeout: 900_000 }));
}

test('an ordinary 2,036-page PDF with 2.3 GB of compressed data passes the guard, converts, and has pages removed', async ({ baseURL }) => {
  test.setTimeout(900_000);
  const src = ordinaryLargePdf();
  const { chromium } = await import('@playwright/test');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  /** Runs a step in a fresh Chrome with its own profile, sampling the memory of all its processes. */
  async function measured<T, A = undefined>(step: (page: Page) => Promise<T>, after?: (page: Page) => Promise<A>): Promise<{ value: T; secs: number; riseMB: number; lagMs: number; extra?: A }> {
    const profile = mkdtempSync(join(tmpdir(), 'fc-profile-'));
    const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', baseURL });
    const page = context.pages()[0] ?? await context.newPage();
    await openApp(page);
    await addFiles(page, [src]);
    await row(page, 'ordinary-large.pdf').locator('select').first().waitFor();
    const base = await browserMemory(profile);
    let peak = base, sampling = true;
    const sampler = (async () => { while (sampling) { peak = Math.max(peak, await browserMemory(profile)); await new Promise(r => setTimeout(r, 500)); } })();
    const lag = await watchLag(page);
    const t = Date.now();
    const value = await step(page);
    const secs = (Date.now() - t) / 1000;
    sampling = false;
    await sampler;
    const lagMs = await lag();
    const extra = after ? await after(page) : undefined;
    await context.close();
    return { value, secs, riseMB: peak - base, lagMs, extra };
  }
  const text = await measured(async page => {
    await convert(page, 'ordinary-large.pdf', 'TXT', 600_000);
    await expectDone(page, 'ordinary-large.pdf');
  });
  // Every other page removed, in the PDF worker, as the delete-pages tool will.
  const edit = await measured(page => page.evaluate(async () => {
    const app = (window as unknown as { __fileconvert: { queue: { jobs: Array<{ name: string; file: Blob }> }; engines: { pdf: { run<T>(t: string, p: unknown): Promise<T> } } } }).__fileconvert;
    const file = app.queue.jobs.find(j => j.name === 'ordinary-large.pdf')!.file;
    const order = Array.from({ length: 1018 }, (_, i) => i * 2);
    const r = await app.engines.pdf.run<{ bytes: Uint8Array; report: { pages: number; objectsRemoved: number } }>('keepPages', { file, order });
    (window as unknown as { __out: Uint8Array }).__out = r.bytes;
    return { pages: r.report.pages, removed: r.report.objectsRemoved };
  }), page => page.evaluate(() => {
    // Outside the measured time: the test's own copy of the result, out of the page.
    const b = (window as unknown as { __out: Uint8Array }).__out;
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }));
  const result = edit.value;
  expect(result.pages).toBe(1018);
  const bytesOut = Buffer.from(edit.extra!, 'base64');
  record(`Ordinary PDF (${(statSync(src).size / 1048576).toFixed(0)} MB, 2,036 pages, 2.3 GB decompressed): guard and text ${text.secs.toFixed(1)} s, browser memory +${text.riseMB.toFixed(0)} MB, worst main-thread gap ${text.lagMs} ms; every other page removed in ${edit.secs.toFixed(1)} s, +${edit.riseMB.toFixed(0)} MB, ${(bytesOut.length / 1048576).toFixed(0)} MB out, ${result.removed} objects swept, worst main-thread gap ${edit.lagMs} ms`);
  // The result, read by qpdf: whole and clean, and no removed page's mark left.
  const out = join(DIR, 'ordinary-large-half.pdf');
  writeFileSync(out, bytesOut);
  const qpdf = execFileSync('qpdf', ['--check', out], { encoding: 'utf8', maxBuffer: 64 << 20 });
  expect(qpdf).toContain('No syntax or stream encoding errors found');
  expect(execFileSync('qpdf', ['--show-npages', out], { encoding: 'utf8' }).trim()).toBe('1018');
  const firstPages = execFileSync('pdftotext', ['-f', '1', '-l', '3', out, '-'], { encoding: 'utf8' });
  expect(firstPages).toContain('LARGE-MARK-00001');
  expect(firstPages).toContain('LARGE-MARK-00003');
  expect(firstPages).not.toContain('LARGE-MARK-00002');
});

// Merge PDFs near its 1 GB limit, through the workspace: the ordinary large PDF twice and 400 MB of incompressible
// pictures (4,112 pages, about 860 MB), with every browser process's memory sampled while the files are checked and
// while they are merged.
test('Merge PDFs: about 860 MB and 4,112 pages in three files merge through the workspace, memory measured', async ({ baseURL }, info) => {
  test.setTimeout(1_800_000);
  const { chromium } = await import('@playwright/test');
  const { copyFileSync, mkdtempSync } = await import('node:fs');
  const big = ordinaryLargePdf();
  const copy = join(DIR, 'ordinary-large-again.pdf');
  if (!existsSync(copy)) copyFileSync(big, copy);
  const pics = make('pictures-400mb.pdf', p => execFileSync(PYTHON, ['-I', '-c', [
    'import sys, zlib, random',
    'rnd = random.Random(5); objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>"}; kids = []; n = 10',
    'def stream(d, extra=b""): return b"<< /Length %d%s >>\\nstream\\n" % (len(d), extra) + d + b"\\nendstream"',
    'for i in range(40):',
    '    objs[n + 2] = stream(zlib.compress(rnd.randbytes(1870 * 1870 * 3), 0), b" /Type /XObject /Subtype /Image /Width 1870 /Height 1870 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode")',
    '    objs[n + 1] = stream(b"q 595 0 0 595 0 120 cm /Im0 Do Q")',
    '    objs[n] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>" % (n + 2, n + 1)',
    '    kids.append(n); n += 3',
    'objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))',
    'out = bytearray(b"%PDF-1.7\\n"); offs = {}',
    'for k in sorted(objs): offs[k] = len(out); out += b"%d 0 obj\\n" % k + objs[k] + b"\\nendobj\\n"',
    'x = len(out); size = max(objs) + 1',
    'out += b"xref\\n0 %d\\n0000000000 65535 f \\n" % size + b"".join((b"%010d 00000 n \\n" % offs[k]) if k in offs else b"0000000000 65535 f \\n" for k in range(1, size))',
    'out += b"trailer\\n<< /Size %d /Root 1 0 R >>\\nstartxref\\n%d\\n%%%%EOF\\n" % (size, x)',
    'open(sys.argv[1], "wb").write(out)',
  ].join('\n'), p], { timeout: 900_000 }));
  const total = [big, pics, copy].reduce((n, f) => n + statSync(f).size, 0);
  const profile = mkdtempSync(join(tmpdir(), 'fc-profile-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', baseURL, acceptDownloads: true });
  const page = context.pages()[0] ?? await context.newPage();
  await openApp(page);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('merge-pdf'));
  const ws = page.locator('#workspace');
  const base = await browserMemory(profile);
  let peak = base, sampling = true;
  const sampler = (async () => { while (sampling) { peak = Math.max(peak, await browserMemory(profile)); await new Promise(r => setTimeout(r, 500)); } })();
  let t = Date.now();
  await ws.locator('input[type=file]').setInputFiles([big, pics, copy]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 600_000 });
  const checkSecs = (Date.now() - t) / 1000, checkRise = peak - base;
  await expect(ws.locator('.ws-item.rejected')).toHaveCount(0);
  peak = await browserMemory(profile);
  const before = peak;
  const lag = await watchLag(page);
  t = Date.now();
  await ws.getByRole('button', { name: 'Merge PDFs' }).click();
  await expect(ws.locator('.ws-state.done')).toBeVisible({ timeout: 1_200_000 });
  const mergeSecs = (Date.now() - t) / 1000, mergeRise = peak - before;
  sampling = false;
  await sampler;
  const lagMs = await lag();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), ws.getByRole('button', { name: 'Download merged.pdf' }).click()]);
  const out = info.outputPath('merged-large.pdf');
  await dl.saveAs(out);
  await context.close();
  record(`Merge PDFs (${(total / 1048576).toFixed(0)} MB in 3 files, 4,112 pages): checked as added in ${checkSecs.toFixed(1)} s, browser memory +${checkRise.toFixed(0)} MB; merged in ${mergeSecs.toFixed(1)} s, +${mergeRise.toFixed(0)} MB over the ${(before - base).toFixed(0)} MB the page held, ${(statSync(out).size / 1048576).toFixed(0)} MB out, worst main-thread gap ${lagMs} ms`);
  expect(execFileSync('qpdf', ['--check', out], { encoding: 'utf8', maxBuffer: 64 << 20 })).toContain('No syntax or stream encoding errors found');
  expect(execFileSync('qpdf', ['--show-npages', out], { encoding: 'utf8' }).trim()).toBe('4112');
  expect(execFileSync('pdftotext', ['-f', '1', '-l', '1', out, '-'], { encoding: 'utf8' })).toContain('LARGE-MARK-00001');
  expect(execFileSync('pdftotext', ['-f', '2077', '-l', '2077', out, '-'], { encoding: 'utf8' })).toContain('LARGE-MARK-00001');
  expect(execFileSync('pdftotext', ['-f', '4112', '-l', '4112', out, '-'], { encoding: 'utf8' })).toContain('LARGE-MARK-02036');
  expect(lagMs).toBeLessThan(500);
});
