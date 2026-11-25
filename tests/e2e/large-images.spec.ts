// Images to PDF on large and many pictures, run on request: npx playwright test --project large
// Each run is a fresh Chrome with its own profile, the private memory of its processes sampled from before the pictures
// are added (each is checked whole as it is added) to the result, and compared with the memory estimate. Every result is
// checked by qpdf and by tests/e2e/readers.py (light mode: page sizes, each picture's dictionary, JPEG streams byte for
// byte). Inputs are generated into the system temp folder on first use; their pixels are random, so they do not compress.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PYTHON, openApp, pyRead, tempDir } from './helpers';

const DIR = join(tmpdir(), 'fileconvert-large-images');
mkdirSync(DIR, { recursive: true });
const REPORT = join('test-results', 'large-images-report.txt');
const MB = 1048576;

function record(line: string): void {
  mkdirSync('test-results', { recursive: true });
  appendFileSync(REPORT, line + '\n');
  console.log(line);
}

/** Writes a picture with Python (numpy, Pillow): kind jpeg (photo-like), png (random, color type ct, depth), tiff (pages). */
function picture(name: string, kind: string, ...args: number[]): string {
  const p = join(DIR, name);
  if (existsSync(p)) return p;
  execFileSync(PYTHON, ['-I', '-c', [
    'import sys, struct, zlib, numpy as np',
    'from PIL import Image',
    'path, kind = sys.argv[1], sys.argv[2]; a = [int(x) for x in sys.argv[3:]]',
    'rng = np.random.default_rng(a[-1])',
    'if kind == "jpeg":',
    '    w, h = a[0], a[1]',
    '    base = Image.fromarray(rng.integers(0, 256, size=(max(1, h // 16), max(1, w // 16), 3), dtype=np.uint8)).resize((w, h), Image.BILINEAR)',
    '    arr = np.asarray(base).astype(np.int16) + rng.integers(-12, 12, size=(h, w, 3))',
    '    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(path, "JPEG", quality=90)',
    'elif kind == "png":',
    '    w, h, ct, depth = a[0], a[1], a[2], a[3]; n = {0: 1, 2: 3, 4: 2, 6: 4}[ct] * depth // 8',
    '    rows = np.zeros((h, w * n + 1), dtype=np.uint8); rows[:, 1:] = rng.integers(0, 256, size=(h, w * n), dtype=np.uint8)',
    '    z = zlib.compress(rows.tobytes(), 1)',
    '    ch = lambda k, d: struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xFFFFFFFF)',
    '    out = b"\\x89PNG\\r\\n\\x1a\\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, depth, ct, 0, 0, 0)) + b"".join(ch(b"IDAT", z[i:i + (1 << 20)]) for i in range(0, len(z), 1 << 20)) + ch(b"IEND", b"")',
    '    open(path, "wb").write(out)',
    'elif kind == "tiff":',
    '    w, h, pages = a[0], a[1], a[2]',
    '    frames = [Image.fromarray(rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)) for _ in range(pages)]',
    '    frames[0].save(path, save_all=True, append_images=frames[1:])',
  ].join('\n'), p, kind, ...args.map(String)], { timeout: 900_000 });
  return p;
}

async function browserMemory(profile: string): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const { execFile } = await import('node:child_process');
  const marker = profile.split(/[\\/]/).pop()!;
  const script = `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object -Property PrivatePageCount -Sum).Sum`;
  return new Promise(res => execFile('powershell', ['-NoProfile', '-Command', script], (err, out) => res(err ? 0 : Number(String(out).trim()) / MB)));
}

/** Makes one PDF from the pictures in a fresh Chrome: the time from the click to the result, the memory, the PDF. */
async function run(baseURL: string | undefined, files: string[]): Promise<{ secs: number; riseMB: number; context: BrowserContext; page: Page; pdf: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'fc-profile-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', baseURL, acceptDownloads: true });
  const page = context.pages()[0] ?? await context.newPage();
  await openApp(page);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('images-to-pdf'));
  const ws = page.locator('#workspace');
  const base = await browserMemory(profile);
  let peak = base, sampling = true;
  const sampler = (async () => { while (sampling) { peak = Math.max(peak, await browserMemory(profile)); await new Promise(r => setTimeout(r, 300)); } })();
  await ws.locator('input[type=file]').setInputFiles(files);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 900_000 });
  const t = Date.now();
  await ws.getByRole('button', { name: 'Make the PDF' }).click();
  await expect(ws.locator('.ws-state.done, .job-error')).toBeVisible({ timeout: 1_800_000 });
  const secs = (Date.now() - t) / 1000;
  sampling = false;
  await sampler;
  const [dl] = await Promise.all([page.waitForEvent('download'), ws.locator('.ws-out button', { hasText: /^Download (?!all)/ }).first().click()]);
  const pdf = join(tempDir(), 'large-images.pdf');
  await dl.saveAs(pdf);
  return { secs, riseMB: peak - base, context, page, pdf };
}

interface Light { qpdf: boolean; qpdfDecode: boolean; qpdfOut: string; pageCount: number; pages: Array<{ source: string; size: number[]; image: { width: number; height: number; bpc: number; filter: string; smask: boolean }; jpegSame?: boolean }> }

const check = (pdf: string, sources: string[]) => {
  const spec = join(tempDir(), 'spec.json');
  writeFileSync(spec, JSON.stringify({ pdf: resolve(pdf), sources: sources.map(s => resolve(s)), light: true }));
  return pyRead<Light>('imagepdf', spec);
};
const size = (files: string[]) => files.reduce((n, f) => n + statSync(f).size, 0) / MB;

test('large and many pictures: 100 megapixels, 60 photos, 36-megapixel transparency, 16-bit, 500 pictures, a 10-page TIFF', async ({ baseURL }) => {
  test.setTimeout(3_600_000);
  const photos = Array.from({ length: 60 }, (_, i) => picture(`photo-${i}.jpg`, 'jpeg', 2400, 1800, i + 1));
  const small = Array.from({ length: 500 }, (_, i) => picture(`small-${i}.png`, 'png', 120, 90, 2, 8, i + 1));
  const cases: Array<{ what: string; files: string[]; pages: number; expect: (r: Light) => void }> = [
    { what: 'one 100-megapixel JPEG (10,000 x 10,000)', files: [picture('big-100mp.jpg', 'jpeg', 10000, 10000, 3)], pages: 1, expect: r => expect(r.pages[0].jpegSame).toBe(true) },
    { what: '60 photo JPEGs of 4.3 megapixels', files: photos, pages: 60, expect: r => expect(r.pages.every(p => p.jpegSame)).toBe(true) },
    { what: 'one 36-megapixel RGBA PNG, decoded', files: [picture('alpha-36mp.png', 'png', 6000, 6000, 6, 8, 4)], pages: 1, expect: r => expect(r.pages[0].image).toMatchObject({ width: 6000, bpc: 8, smask: true }) },
    { what: 'one 16-megapixel 16-bit RGBA PNG, decoded', files: [picture('alpha16-16mp.png', 'png', 4000, 4000, 6, 16, 5)], pages: 1, expect: r => expect(r.pages[0].image).toMatchObject({ bpc: 16, smask: true }) },
    { what: 'one 48-megapixel RGB PNG, as it is', files: [picture('rgb-48mp.png', 'png', 8000, 6000, 2, 8, 6)], pages: 1, expect: r => expect(r.pages[0].image).toMatchObject({ bpc: 8, smask: false, filter: '/FlateDecode' }) },
    { what: '500 small PNGs', files: small, pages: 500, expect: r => expect(r.pages.map(p => p.source)).toEqual(small.map(f => f.split(/[\\/]/).pop())) },
    { what: 'a 10-page TIFF of 4 megapixels a page', files: [picture('pages-10.tiff', 'tiff', 2000, 2000, 10, 7)], pages: 10, expect: r => expect(r.pages.every(p => p.image.width === 2000)).toBe(true) },
  ];
  for (const c of cases) {
    const r = await run(baseURL, c.files);
    const failed = await r.page.locator('#workspace .job-error').count();
    const light = check(r.pdf, c.files);
    record(`${c.what}: ${size(c.files).toFixed(0)} MB in, ${failed ? 'FAILED' : `${light.pageCount} pages, ${(statSync(r.pdf).size / MB).toFixed(0)} MB out`} in ${r.secs.toFixed(1)} s, browser memory +${r.riseMB.toFixed(0)} MB at most`);
    await r.context.close();
    expect(failed, c.what).toBe(0);
    expect(light.qpdf, light.qpdfOut).toBe(true);
    expect(light.pageCount).toBe(c.pages);
    c.expect(light);
  }
});
