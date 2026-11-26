import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fx, openApp, pyRead, save, tempDir, unexpectedViolations, writeTemp } from './helpers';
import { numbered } from './pdfgen';

// PDF to JPG and PNG (v0.2.0, Phase 2) in the browser: pages drawn by pdf.js in the render worker, every picture
// compared with PDFium's rendering of the same page (tests/e2e/readers.py, kind render), which shares no code with
// pdf.js. The fixtures (tools/make-pdf-render-fixtures.py, make-pdf-render-fonts.mjs) hold multilingual text in embedded
// fonts, transparency, annotations, form fields, rotated pages, crop boxes and odd sizes.

interface Compared { ref: [number, number]; got: [number, number]; format: string; mode: string; mean: number; off48: number; mean4: number; inkRef: number; inkGot: number; alphaCorner?: number; alphaAt?: number; cornerRgb?: number[] }

const ws = (page: Page) => page.locator('#workspace');
const R = (f: string) => fx(`pdf-render/${f}`);

async function openTool(page: Page, preset: Record<string, string> = {}): Promise<void> {
  await page.evaluate(p => (window as unknown as { __fileconvert: { openTool(id: string, p: Record<string, string>): Promise<unknown> } }).__fileconvert.openTool('pdf-to-images', p), preset);
  await expect(page.getByRole('heading', { name: 'PDF to JPG or PNG', level: 2 })).toBeVisible();
}

async function add(page: Page, path: string): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(path);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

/** Runs the tool and writes its results to a folder, by their names. */
async function run(page: Page): Promise<Array<{ name: string; path: string; size: number }>> {
  await ws(page).getByRole('button', { name: 'Convert the pages' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 180_000 });
  const outs = await page.evaluate(async () => {
    const w = (window as unknown as { __fileconvert: { workspace: { outputs: Array<{ name: string; blob: Blob }> } } }).__fileconvert.workspace;
    const list = [];
    for (const o of w.outputs) {
      const b = new Uint8Array(await o.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      list.push({ name: o.name, b64: btoa(s) });
    }
    return list;
  });
  const dir = tempDir();
  return outs.map(o => { const data = Buffer.from(o.b64, 'base64'); return { name: o.name, path: writeTemp(dir, o.name, data), size: data.length }; });
}

function compare(items: Array<{ pdf: string; page: number; picture: string; dpi: number; transparent?: boolean; point?: [number, number] }>): Compared[] {
  const spec = join(tempDir(), 'render.json');
  writeFileSync(spec, JSON.stringify(items));
  return pyRead<Compared[]>('render', spec);
}

/** Each fixture, its pages, and how each page is compared: its pixel size at 150 dpi, and how close to PDFium it is. */
const FIXTURES: Array<{ file: string; sizes: Array<[number, number]>; mean?: number; off48?: number; skip?: number[]; unit?: number[] }> = [
  { file: 'rotations.pdf', sizes: [[1275, 1650], [1650, 1275], [1275, 1650], [1650, 1275]] },
  // Page 3 has UserUnit 2, which pdf.js applies and PDFium does not: it is compared with PDFium at twice the resolution.
  { file: 'boxes.pdf', sizes: [[625, 729], [1042, 1354], [1250, 833], [833, 625]], unit: [3] },
  // A page of 10 by 10 points is 21 pixels a side: its two squares are all edge, which the two renderers smooth differently.
  { file: 'sizes.pdf', sizes: [[4167, 208], [21, 21], [4967, 7021]], skip: [2] },
  { file: 'transparency.pdf', sizes: [[1275, 1650], [1275, 1650]] },
  { file: 'annotations.pdf', sizes: [[1275, 1650]] },
  // Helvetica, Times and Courier are not in the PDF: pdf.js draws them with its own fonts, PDFium with others.
  { file: 'fonts-std.pdf', sizes: [[1275, 1650]], mean: 4 },
  // Helvetica and Arial in their four styles at 28 points: pdf.js draws them with Arimo, PDFium with its own sans-serif.
  { file: 'fonts-sans.pdf', sizes: [[1275, 1650]], mean: 6, off48: 0.04 },
  { file: 'jpx-cmyk.pdf', sizes: [[1275, 1650], [1275, 1650]] },
  { file: 'multilingual.pdf', sizes: [[1275, 1650], [1275, 1650], [1275, 1650]] },
  { file: 'metadata.pdf', sizes: [[1275, 1650]] },
];

test('every page of the render fixtures as PNG at 150 dpi: the size its page gives, drawn as PDFium draws it', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  // What pdf.js loads from the app's folder as pages need it: the standard fonts, the JPEG 2000 decoder, the color
  // module and its CMYK profile (with the system's fonts in their place, the pages would look nearly the same).
  const assets: string[] = [];
  page.on('request', r => { const m = /\/pdfjs\/(standard_fonts|wasm|iccs)\/([^/?]+)$/.exec(r.url()); if (m) assets.push(`${m[1]}/${m[2]}`); });
  await openTool(page, { format: 'png' });
  for (const f of FIXTURES) {
    await add(page, R(f.file));
    await expect(ws(page).locator('.ws-plan')).toContainText(`${f.sizes.length === 1 ? '1 PNG picture' : `${f.sizes.length} PNG pictures`} at 150 dpi`);
    const outs = await run(page);
    const stem = f.file.replace('.pdf', '');
    const w0 = String(f.sizes.length).length;
    expect(outs.map(o => o.name)).toEqual(f.sizes.map((_, i) => `${stem}-p${String(i + 1).padStart(w0, '0')}.png`));
    const results = compare(outs.map((o, i) => ({ pdf: R(f.file), page: i + 1, picture: o.path, dpi: f.unit?.includes(i + 1) ? 300 : 150 })));
    results.forEach((r, i) => {
      const where = `${f.file} page ${i + 1}`;
      expect(r.got, where).toEqual(f.sizes[i]);
      expect(r.format, where).toBe('PNG');
      // PDFium makes a picture one pixel larger where the size is a whole number; only the overlap is compared.
      expect(Math.abs(r.ref[0] - r.got[0]) + Math.abs(r.ref[1] - r.got[1]), where).toBeLessThanOrEqual(2);
      if (f.skip?.includes(i + 1)) return;
      expect(r.mean, where).toBeLessThan(f.mean ?? 2.5);
      expect(r.off48, where).toBeLessThan(f.off48 ?? 0.03);
      expect(Math.abs(r.inkRef - r.inkGot), where).toBeLessThan(0.01);
    });
    await ws(page).getByRole('button', { name: `Remove ${f.file}` }).click();
  }
  expect(w.errors).toEqual([]);
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
  // The sans-serif standard font is Arimo, asked for by pdf.js under Liberation Sans's names and never fetched as Liberation.
  expect(assets.filter(a => a.includes('Liberation'))).toEqual([]);
  for (const a of ['standard_fonts/Arimo-Regular.ttf', 'standard_fonts/Arimo-Bold.ttf', 'standard_fonts/Arimo-Italic.ttf', 'standard_fonts/Arimo-BoldItalic.ttf', 'standard_fonts/FoxitSerif.pfb', 'standard_fonts/FoxitFixed.pfb', 'standard_fonts/FoxitSymbol.pfb', 'standard_fonts/FoxitDingbats.pfb', 'wasm/openjpeg.wasm', 'wasm/qcms_bg.wasm', 'iccs/CGATS001Compat-v2-micro.icc']) expect(assets, a).toContain(a);
});

test('PDF to JPG: chosen pages, names padded to the page count, white background, quality, one by one or as a ZIP', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page, { format: 'jpg' });
  const dir = tempDir();
  await add(page, writeTemp(dir, 'twelve.pdf', numbered(12)));
  const pages = ws(page).getByLabel('Pages to convert');
  await pages.fill('2, 11');
  await pages.press('Tab');
  await expect(ws(page).locator('.ws-plan')).toHaveText('2 JPG pictures at 150 dpi, 417 x 417 pixels each.');
  await ws(page).getByLabel('JPG quality').fill('95');
  await ws(page).getByLabel('JPG quality').press('Tab');
  const high = await run(page);
  expect(high.map(o => o.name)).toEqual(['twelve-p02.jpg', 'twelve-p11.jpg']);
  const r = compare(high.map((o, i) => ({ pdf: join(dir, 'twelve.pdf'), page: [2, 11][i], picture: o.path, dpi: 150 })));
  for (const x of r) {
    expect(x.format).toBe('JPEG');
    expect(x.got).toEqual([417, 417]);
    expect(Math.min(...x.cornerRgb!)).toBeGreaterThanOrEqual(250);
    expect(x.mean).toBeLessThan(2.5);
  }
  // Lower quality makes smaller files of the same size in pixels.
  await ws(page).getByLabel('JPG quality').fill('20');
  await ws(page).getByLabel('JPG quality').press('Tab');
  const low = await run(page);
  expect(low[0].size).toBeLessThan(high[0].size);
  // Both as a ZIP.
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).getByRole('button', { name: 'Download all (ZIP, 2)' }).click()]);
  const { path } = await save(dl, info);
  const { unzipSync } = await import('fflate');
  expect(Object.keys(unzipSync(new Uint8Array(readFileSync(path)))).sort()).toEqual(['twelve-p02.jpg', 'twelve-p11.jpg']);
  // Every page when the box is empty, and a single file downloads by itself.
  await pages.fill('');
  await pages.press('Tab');
  await expect(ws(page).locator('.ws-plan')).toHaveText('12 JPG pictures at 150 dpi, 417 x 417 pixels each.');
  await pages.fill('7');
  await pages.press('Tab');
  await ws(page).getByRole('button', { name: 'Convert the pages' }).click();
  const [one] = await Promise.all([page.waitForEvent('download'), ws(page).getByRole('button', { name: 'Download twelve-p07.jpg' }).click()]);
  expect(one.suggestedFilename()).toBe('twelve-p07.jpg');
});

test('PNG with a transparent background: what the page does not paint is transparent; a page that paints white stays white', async ({ page }) => {
  await openApp(page);
  await openTool(page, { format: 'png' });
  await ws(page).getByLabel('Background').selectOption('transparent');
  await add(page, R('transparency.pdf'));
  const outs = await run(page);
  // Page 2 paints only its shapes: a corner is transparent, the red square (250, 400 to 450, 600 points) is solid.
  const [p1, p2] = compare([
    { pdf: R('transparency.pdf'), page: 1, picture: outs[0].path, dpi: 150, transparent: true },
    { pdf: R('transparency.pdf'), page: 2, picture: outs[1].path, dpi: 150, transparent: true, point: [Math.round(350 * 150 / 72), Math.round((792 - 500) * 150 / 72)] },
  ]);
  expect(p2.mode).toBe('RGBA');
  expect(p2.alphaCorner).toBe(0);
  expect(p2.alphaAt).toBe(255);
  expect(p2.mean).toBeLessThan(2.5);
  expect(p1.alphaCorner).toBe(255);
  await expect(ws(page).locator('.ws-out .job-notes')).toContainText('What the pages do not paint is transparent.');
  // White, the default: every pixel opaque.
  await ws(page).getByLabel('Background').selectOption('white');
  const white = await run(page);
  const w2 = compare([{ pdf: R('transparency.pdf'), page: 2, picture: white[1].path, dpi: 150, transparent: true }])[0];
  expect(w2.alphaCorner ?? 255).toBe(255);
  expect(w2.mean).toBeGreaterThan(10);
});

test('refusals before anything is drawn: a page past the picture limit, with the resolution that fits, and memory', async ({ page }) => {
  await openApp(page);
  await openTool(page, { format: 'png' });
  await add(page, R('sizes.pdf'));
  const dpi = ws(page).locator('[data-key="opt-dpi"]');
  await dpi.selectOption('300');
  await expect(ws(page).locator('.ws-plan')).toHaveText('3 PNG pictures at 300 dpi, from 42 x 42 pixels to 9,933 x 14,042 pixels.');
  await expect(ws(page).locator('.ws-why')).toHaveText(/^Page 3 at 300 dpi would be 9,933 x 14,042 pixels, 139\.5 megapixels, more than the 100 megapixels one picture may have\. At \d+ dpi or less it fits\.$/);
  await expect(ws(page).getByRole('button', { name: 'Convert the pages' })).toBeDisabled();
  // The two other pages are fine at 300 dpi; the custom resolution goes up to 1,200.
  const pages = ws(page).getByLabel('Pages to convert');
  await pages.fill('1-2');
  await pages.press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveCount(0);
  await dpi.selectOption('custom');
  await ws(page).getByLabel('Custom resolution').fill('1200');
  await ws(page).getByLabel('Custom resolution').press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveText(/^Page 1 at 1,200 dpi would be 33,333 x 1,667 pixels, wider or taller than the 32,767 pixels a browser can draw\. At 1,179 dpi or less it fits\.$/);
});

test('memory: a device that reports little memory is refused before the worker draws anything, with the reason', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 1, configurable: true }); });
  await openApp(page);
  await openTool(page, { format: 'png' });
  await add(page, R('sizes.pdf'));
  // A0 at 200 dpi is a 62-megapixel picture.
  await ws(page).locator('[data-key="opt-dpi"]').selectOption('custom');
  await ws(page).getByLabel('Custom resolution').fill('200');
  await ws(page).getByLabel('Custom resolution').press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveText(/^Converting 3 pages at 200 dpi needs about [\d.]+ (MB|GB) of memory, more than the 512 MB FileConvert lets one task use on this device \(half of the 1 GB of memory the browser reports\), so it was not started\. Choose a lower resolution\.$/);
  // Without it, it fits.
  const pages = ws(page).getByLabel('Pages to convert');
  await pages.fill('1-2');
  await pages.press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveCount(0);
});

test('cancel stops the drawing at once and leaves no pictures behind in private storage; the next run works', async ({ page }) => {
  await openApp(page);
  await openTool(page, { format: 'png' });
  const dir = tempDir();
  await add(page, writeTemp(dir, 'many.pdf', numbered(300)));
  // 1,000 dpi: each page is 2,778 pixels a side, so the 300 take long enough to cancel.
  await ws(page).locator('[data-key="opt-dpi"]').selectOption('custom');
  await ws(page).getByLabel('Custom resolution').fill('1000');
  await ws(page).getByLabel('Custom resolution').press('Tab');
  const temp = () => page.evaluate(() => (window as unknown as { __fileconvert: { tempFiles(): Promise<string[]> } }).__fileconvert.tempFiles());
  await ws(page).getByRole('button', { name: 'Convert the pages' }).click();
  await expect(ws(page).locator('.ws-run .job-info')).toContainText(/Page \d+ \(\d+ of 300\)/, { timeout: 60_000 });
  await ws(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(ws(page).locator('.ws-state.canceled')).toBeVisible();
  await expect.poll(async () => (await temp()).filter(n => n.startsWith('ws')), { timeout: 15_000 }).toEqual([]);
  const pages = ws(page).getByLabel('Pages to convert');
  await pages.fill('1-3');
  await pages.press('Tab');
  const outs = await run(page);
  expect(outs.map(o => o.name)).toEqual(['many-p001.png', 'many-p002.png', 'many-p003.png']);
  // The pictures wait in private storage until they are downloaded or the results change.
  await expect.poll(async () => (await temp()).filter(n => n.startsWith('ws')).length).toBe(3);
  await pages.fill('1');
  await pages.press('Tab');
  await expect.poll(async () => (await temp()).filter(n => n.startsWith('ws')).length).toBe(0);
});

test('an encrypted PDF is refused as it is added, and the PDF to JPG and PDF to PNG pages start with their format', async ({ page }) => {
  await openApp(page);
  await openTool(page);
  await expect(ws(page).getByLabel('Picture format')).toHaveValue('jpg');
  await ws(page).locator('input[type=file]').setInputFiles(fx('pdf/encrypted-user.pdf'));
  await expect(ws(page).locator('.job-error')).toContainText('This PDF is encrypted, so FileConvert does not open it.');
  await page.goto('./pdf-to-png/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.getByRole('heading', { name: 'PDF to PNG', level: 1 })).toBeVisible();
  await expect(ws(page).getByLabel('Picture format')).toHaveValue('png');
  await page.goto('./pdf-to-jpg/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(ws(page).getByLabel('Picture format')).toHaveValue('jpg');
});
