import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { formatBytes, LIMITS } from '../../src/core/limits';
import { estimateImages, type MemoryEngine } from '../../src/core/pdfmemory';
import { PAGE_SIZES } from '../../src/engines/pdf/imagelayout';
import { fx, openApp, pyRead, save, tempDir, unexpectedViolations } from './helpers';

// Images to PDF (v0.2.0, Phase 2) in the browser: the workspace, the check of each picture as it is added, the PDF
// made in the PDF worker, and every result read by qpdf, PDFium and tests/e2e/readers.py, which decodes the source
// pictures and the PDF's pictures with its own code (zlib, the PNG filters, Adam7; JPEG by Pillow) and compares them
// exactly, at their own bit depth. The fixtures are synthetic (tools/make-image-pdf-fixtures.py).

const MB = 1048576;
const ip = (n: string) => fx(`image-pdf/${n}`);
const im = (n: string) => fx(`image/${n}`);
const ws = (page: Page) => page.locator('#workspace');
const item = (page: Page, name: string) => ws(page).locator('.ws-item').filter({ has: page.locator('.job-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });

interface ImageFacts { width: number; height: number; bpc: number; cs: string; filter: string; predictor?: number; decode: number[] | null; mask: number[] | null; smask: { bpc: number; cs: string } | null; icc?: string; palette?: string }
interface PageFacts {
  source: string; size: [number, number]; matrix: number[] | null; clip: number[] | null; image: ImageFacts;
  exact?: boolean; alphaExact?: boolean | null; alphaOpaque?: boolean; paletteExact?: boolean; jpegSame?: boolean; metadataFree?: boolean;
  render?: { mean: number; max: number }; cmykRender?: { mean: number; max: number }; diffMean?: number; pdfiumImage: [number, number] | string;
}
interface Result { qpdf: boolean; qpdfDecode: boolean; qpdfOut: string; pages: PageFacts[]; pageCount: number }

async function openTool(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('images-to-pdf'));
  await expect(page.getByRole('heading', { name: 'Images to PDF', level: 2 })).toBeVisible();
}

async function add(page: Page, paths: string[]): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(paths);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

/** Runs the tool, saves the PDF, and has readers.py check it against the sources (one page each, a TIFF's every page). */
async function make(page: Page, info: TestInfo, sources: string[], pictureSize = true): Promise<{ result: Result; path: string; notes: string; warnings: string }> {
  await ws(page).getByRole('button', { name: 'Make the PDF' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 180_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).locator('.ws-out button', { hasText: /^Download (?!all)/ }).first().click()]);
  const { path } = await save(dl, info);
  const spec = join(tempDir(), 'spec.json');
  writeFileSync(spec, JSON.stringify({ pdf: resolve(path), sources: sources.map(s => resolve(s)), pictureSize }));
  const notes = await ws(page).locator('.ws-out').innerText();
  const warnings = (await ws(page).locator('.job-notes').allInnerTexts()).join(' ');
  return { result: pyRead<Result>('imagepdf', spec), path, notes, warnings };
}

async function size(page: Page, value: string): Promise<void> {
  await ws(page).locator('[data-key="opt-size"]').selectOption(value);
}

test('the options, what each picture will become, and the order by keyboard and dragging', async ({ page, browserName }, info) => {
  test.slow();
  const w = await openApp(page);
  await openTool(page);
  // US English (the browsers here) starts on US Letter; the paper options show only for paper sizes.
  await expect(ws(page).locator('[data-key="opt-size"]')).toHaveValue('letter');
  for (const key of ['orientation', 'fit', 'enlarge']) await expect(ws(page).locator(`[data-key="opt-${key}"]`)).toBeVisible();
  await size(page, 'picture');
  for (const key of ['orientation', 'fit', 'enlarge']) await expect(ws(page).locator(`[data-key="opt-${key}"]`)).toBeHidden();
  await expect(ws(page).locator('[data-key="opt-margin"]')).toBeVisible();
  await add(page, [ip('orient6.jpg'), ip('rgba8.png'), ip('gray16.png')]);
  await expect(item(page, 'orient6.jpg').locator('.job-info')).toHaveText(/, 64 x 48$/);
  await expect(item(page, 'orient6.jpg')).toContainText('Turned upright from its EXIF orientation. Goes in as it is.');
  await expect(item(page, 'rgba8.png')).toContainText('Decoded and stored without loss, transparency kept.');
  await expect(item(page, 'gray16.png')).toContainText('Goes in as it is, 16 bits per channel.');
  // Keyboard: the last picture to the top.
  const names = ws(page).locator('.ws-item .job-name');
  await ws(page).getByRole('button', { name: 'Move gray16.png up' }).click();
  await ws(page).getByRole('button', { name: 'Move gray16.png up' }).click();
  await expect(names).toHaveText(['gray16.png', 'orient6.jpg', 'rgba8.png']);
  // Dragging (not in WebKit or on touch): the JPEG below the PNG.
  if (browserName !== 'webkit' && !info.project.use.hasTouch) {
    const rows = ws(page).locator('.ws-item');
    const box = (await rows.nth(2).boundingBox())!;
    await rows.nth(1).dragTo(rows.nth(2), { targetPosition: { x: 20, y: box.height - 3 } });
    await expect(names).toHaveText(['gray16.png', 'rgba8.png', 'orient6.jpg']);
  } else {
    await ws(page).getByRole('button', { name: 'Move orient6.jpg down' }).click();
  }
  const { result, notes } = await make(page, info, [ip('gray16.png'), ip('rgba8.png'), ip('orient6.jpg')]);
  expect(result.qpdf).toBe(true);
  expect(result.pages.map(p => p.source)).toEqual(['gray16.png', 'rgba8.png', 'orient6.jpg']);
  expect(result.pages.map(p => p.image.bpc)).toEqual([16, 8, 8]);
  expect(result.pages.every(p => p.exact)).toBe(true);
  expect(notes).toContain('1 JPEG picture went in as it was: the compressed data is copied byte for byte, with no new compression.');
  expect(notes).toContain('16 bits per channel kept: gray16.png.');
  expect(notes).toContain('Turned upright from the EXIF orientation, without changing a pixel: orient6.jpg.');
  expect(notes).toContain('Transparency kept (readers show the page behind it, usually white): rgba8.png.');
  expect(await unexpectedViolations(page)).toEqual([]);
  expect(w.errors).toEqual([]);
});

test('every kind of PNG: samples exact at their own depth, transparency exact, palettes and profiles kept, drawn as the source', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page);
  await size(page, 'picture');
  const names = ['gray1', 'gray2', 'gray4', 'gray8', 'gray16', 'rgb8', 'rgb16', 'pal1', 'pal4', 'pal8', 'pal8-trns', 'graya8', 'graya16', 'rgba8', 'rgba16', 'rgba8-opaque',
    'key-gray8', 'key-rgb16', 'int-rgb8', 'int-gray2', 'int-gray2-key', 'int-rgba16', 'int-pal4-trns', 'iccp-rgb', 'iccp-mismatch', 'gamma1',
    'noise-rgb8', 'noise-rgba8', 'noise-rgba16', ...Array.from({ length: 8 }, (_, i) => `orient${i + 1}`)].map(n => `${n}.png`);
  await add(page, names.map(ip));
  const { result, warnings, notes } = await make(page, info, names.map(ip));
  expect(result.qpdf, result.qpdfOut).toBe(true);
  expect(result.qpdfDecode, result.qpdfOut).toBe(true);
  expect(result.pageCount).toBe(names.length);
  const by = Object.fromEntries(result.pages.map(p => [p.source, p]));
  for (const p of result.pages) {
    expect([p.source, p.exact]).toEqual([p.source, true]);
    // PDFium draws each page as the source looks (16-bit by its high byte, transparency over white), to within 1.
    if (p.source !== 'rgb8.png') expect([p.source, p.render!.max <= 1]).toEqual([p.source, true]);
  }
  // As it is: the PNG's own data with the PNG predictor; decoded: no predictor, a soft mask for transparency.
  for (const n of ['gray1', 'gray16', 'rgb16', 'pal4', 'key-rgb16', 'orient6']) expect([n, by[`${n}.png`].image.predictor]).toEqual([n, 15]);
  for (const n of ['graya16', 'rgba16', 'int-rgb8', 'pal8-trns']) expect([n, by[`${n}.png`].image.predictor]).toEqual([n, 1]);
  expect(by['rgba16.png'].image).toMatchObject({ bpc: 16, cs: 'DeviceRGB', smask: { bpc: 16, cs: 'DeviceGray' } });
  expect(by['graya16.png'].alphaExact).toBe(true);
  expect(by['int-rgba16.png'].alphaExact).toBe(true);
  expect(by['pal8-trns.png']).toMatchObject({ alphaExact: true, paletteExact: true, image: { cs: 'Indexed:DeviceRGB:199', bpc: 8 } });
  expect(by['int-pal4-trns.png'].alphaExact).toBe(true);
  expect(by['pal1.png'].image).toMatchObject({ cs: 'Indexed:DeviceRGB:1', bpc: 1 });
  expect(by['rgba8-opaque.png'].image.smask).toBeNull();
  expect(by['key-rgb16.png'].image.mask).toEqual([1234, 1234, 5678, 5678, 9012, 9012]);
  expect(by['key-gray8.png'].image.mask).toHaveLength(2);
  expect(by['iccp-rgb.png'].image.cs).toBe('ICCBased:3');
  expect(by['iccp-mismatch.png'].image.cs).toBe('DeviceGray');
  expect(by['int-gray2.png'].image.bpc).toBe(8);
  // 48 pixels at 300 per inch are 11.52 points.
  expect(by['rgb8.png'].size).toEqual([11.52, 7.68]);
  for (let o = 1; o <= 8; o++) expect(by[`orient${o}.png`].size).toEqual([36, 24]);
  expect(notes).toContain('16 bits per channel kept: gray16.png, rgb16.png, graya16.png, rgba16.png and 3 more.');
  // The decoded 2-bit gray's transparent gray, scaled with it to 8 bits.
  expect(by['int-gray2-key.png'].image).toMatchObject({ bpc: 8, mask: [170, 170] });
  expect(by['noise-rgba16.png'].alphaExact).toBe(true);
  expect(notes).toContain('Color profile kept as the picture\'s color space: iccp-rgb.png.');
  expect(warnings).toContain('A color profile that is damaged or not for the picture\'s colors was not used: iccp-mismatch.png.');
  expect(warnings).toContain('gamma1.png: Its gamma setting (1.00) is not applied');
});

test('JPEGs go in byte for byte without their metadata, upright by their EXIF orientation, CMYK and profiles kept', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page);
  await size(page, 'picture');
  const names = ['baseline', 'progressive-icc', 'gray', 'cmyk', 'trailing', ...Array.from({ length: 8 }, (_, i) => `orient${i + 1}`)].map(n => `${n}.jpg`);
  await add(page, names.map(ip));
  const { result, notes } = await make(page, info, names.map(ip));
  expect(result.qpdf, result.qpdfOut).toBe(true);
  expect(result.qpdfDecode, result.qpdfOut).toBe(true);
  const by = Object.fromEntries(result.pages.map(p => [p.source, p]));
  for (const p of result.pages) {
    // The stream is the file with its application data and comments taken out (by readers.py's own walk), and its
    // pixels decode exactly as the file's do; no camera name, GPS, XMP or comment is left in it.
    expect([p.source, p.jpegSame, p.exact, p.metadataFree, p.image.filter]).toEqual([p.source, true, true, true, '/DCTDecode']);
  }
  for (let o = 1; o <= 8; o++) {
    expect(by[`orient${o}.jpg`].render).toEqual({ mean: 0, max: 0 });
    expect(by[`orient${o}.jpg`].size).toEqual([48, 36]);
  }
  expect(by['cmyk.jpg'].image).toMatchObject({ cs: 'DeviceCMYK', decode: [1, 0, 1, 0, 1, 0, 1, 0] });
  expect(by['cmyk.jpg'].cmykRender).toEqual({ mean: 0, max: 0 });
  expect(by['progressive-icc.jpg'].image.cs).toBe('ICCBased:3');
  expect(by['gray.jpg'].image.cs).toBe('DeviceGray');
  expect(by['baseline.jpg'].size).toEqual([15.36, 11.52]);
  expect(notes).toContain(`${names.length} JPEG pictures went in as they were`);
  expect(notes).toContain('Photo metadata is not copied into the PDF');
  expect(notes).toContain('Data after the end of the picture (such as a second picture a camera adds) was left out: trailing.jpg.');
});

test('WebP, AVIF, HEIC, GIF, BMP and TIFF are decoded once and stored without further loss, every change said', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page);
  await size(page, 'picture');
  const files = [im('alpha.webp'), im('photo.gif'), im('photo.bmp'), im('alpha.avif'), im('photo.heic'), im('two-pages.tiff'), im('alpha.tiff'), im('animated.gif'), ip('gray16.tiff')];
  await add(page, files);
  await expect(item(page, 'two-pages.tiff').locator('.job-info')).toHaveText(/, 320 x 200, 2 pages$/);
  await expect(item(page, 'animated.gif')).toContainText('It is animated; its first picture is the page.');
  await expect(item(page, 'gray16.tiff')).toContainText('It has 16 bits per channel; the PDF gets 8.');
  const { result, warnings } = await make(page, info, files);
  expect(result.qpdf, result.qpdfOut).toBe(true);
  expect(result.pageCount).toBe(10);
  for (const p of result.pages) {
    expect([p.source, p.image.bpc, p.image.filter]).toEqual([p.source, 8, '/FlateDecode']);
    // Lossless sources draw within 3 of what Pillow decodes; lossy ones (WebP, AVIF, HEIC) within the difference between
    // two decoders of the same lossy data, on average.
    const lossy = /\.(webp|avif|heic)$/.test(p.source);
    if (p.source !== 'gray16.tiff') expect([p.source, lossy ? p.render!.mean <= 2 : p.render!.max <= 3]).toEqual([p.source, true]);
  }
  const by = (n: string) => result.pages.filter(p => p.source === n);
  expect(by('alpha.webp')[0].image.smask).toEqual({ bpc: 8, cs: 'DeviceGray' });
  expect(by('photo.bmp')[0].image.smask).toBeNull();
  expect(warnings).toContain('Decoded by the browser, which converts colors to sRGB, and stored without further loss');
  expect(warnings).toContain('Reduced to 8 bits per channel: gray16.tiff (16 bits).');
});

test('paper sizes: orientation, margins, fit without cropping by default, enlarging and filling only when chosen', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page);
  await size(page, 'a4');
  const [A4W, A4H] = PAGE_SIZES.a4;
  const MM = 72 / 25.4;
  await add(page, [ip('orient6.jpg'), ip('rgb16.png')]);
  // Fit, small pictures at their own size, centered: 64 x 48 pixels at 96 per inch are 48 x 36 points.
  let r = (await make(page, info, [ip('orient6.jpg'), ip('rgb16.png')], false)).result;
  expect(r.pages[0].size).toEqual([round(A4H), round(A4W)]);
  expect(r.pages[0].matrix).toEqual([0, -36, 48, 0, round((A4H - 48) / 2), round((A4W - 36) / 2 + 36)]);
  expect(r.pages[0].clip).toBeNull();
  // Enlarged to fit, with a 10 mm margin, portrait.
  await ws(page).locator('[data-key="opt-enlarge"]').check();
  await ws(page).locator('[data-key="opt-orientation"]').selectOption('portrait');
  await ws(page).locator('[data-key="opt-margin"]').fill('10');
  await ws(page).locator('[data-key="opt-margin"]').press('Tab');
  let made = await make(page, info, [ip('orient6.jpg'), ip('rgb16.png')], false);
  r = made.result;
  const bw = A4W - 20 * MM;
  expect(r.pages[1].size).toEqual([round(A4W), round(A4H)]);
  expect(r.pages[1].matrix).toEqual([round(bw), 0, 0, round(bw * 24 / 36), round(10 * MM), round((A4H - bw * 24 / 36) / 2)]);
  expect(made.notes).toMatch(/Enlarged to fit, as chosen: orient6\.jpg \(\d+\.\d times\) and rgb16\.png/);
  // Fill: the space inside the margin covered and clipped to it, how much is cut off said.
  await ws(page).locator('[data-key="opt-fit"]').selectOption('fill');
  made = await make(page, info, [ip('orient6.jpg'), ip('rgb16.png')], false);
  r = made.result;
  expect(r.pages[1].clip).toEqual([round(10 * MM), round(10 * MM), round(bw), round(A4H - 20 * MM)]);
  expect(made.warnings).toMatch(/Edges cut off to fill the page, as chosen: orient6\.jpg \(\d+% of it\) and rgb16\.png \(\d+% of it\)\./);
  // US Letter, landscape.
  await size(page, 'letter');
  await ws(page).locator('[data-key="opt-orientation"]').selectOption('landscape');
  r = (await make(page, info, [ip('orient6.jpg'), ip('rgb16.png')], false)).result;
  expect(r.pages.map(p => p.size)).toEqual([[792, 612], [792, 612]]);
});

const round = (n: number) => Math.round(n * 1000) / 1000;

test('damaged and hostile pictures are refused as they are added, with the reason; the rest still make a PDF', async ({ page }, info) => {
  await openApp(page);
  await openTool(page);
  await size(page, 'picture');
  await add(page, [ip('crc.png'), ip('short.png'), ip('huge.png'), ip('truncated.jpg'), ip('bomb.png'), ip('rgb8.png')]);
  await expect(item(page, 'crc.png').locator('.job-error')).toHaveText('This PNG is damaged: its IDAT chunk does not match its checksum.');
  await expect(item(page, 'short.png').locator('.job-error')).toHaveText('This PNG is damaged or cut off: its picture data ends early.');
  await expect(item(page, 'huge.png').locator('.job-error')).toHaveText('The picture is 40,000 x 40,000 pixels; the limit is 100 megapixels and 30,000 pixels on a side.');
  await expect(item(page, 'truncated.jpg').locator('.job-error')).toHaveText(/^This JPEG ends before its end marker, as if it was cut off/);
  // The bomb's data would expand to 64 MB; only its 16 x 16 picture goes in, compressed again.
  await expect(item(page, 'bomb.png')).toContainText('Its compressed data goes on past the picture; only the picture will be kept, compressed again without loss.');
  const { result, path } = await make(page, info, [ip('bomb.png'), ip('rgb8.png')]);
  expect(result.qpdf).toBe(true);
  expect(result.pages.map(p => p.exact)).toEqual([true, true]);
  expect(readFileSync(path).length).toBeLessThan(8000);
});

/** The engine's measurements, and a device memory that gives one task 128 MB above the estimate's base. */
function low(browserName: string): { engine: MemoryEngine; gb: number } {
  const engine: MemoryEngine = browserName === 'firefox' ? 'gecko' : 'v8';
  return { engine, gb: (2 * (LIMITS.imagePdfMemory[engine].base + 128 * MB)) / (1024 * MB) };
}

test('memory: pictures that would need more than the browser can give are refused before anything is decoded', async ({ page, browserName }, info) => {
  test.slow();
  const { engine, gb } = low(browserName);
  await page.addInitScript(g => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => g, configurable: true }); }, gb);
  await openApp(page);
  await openTool(page);
  // A 3,000 x 3,000 PNG with an alpha channel is decoded here: 36 MB of samples, too much for 128 MB above the base.
  const { pngRgba } = await import('./pdfgen');
  const big = join(tempDir(), 'big-alpha.png');
  writeFileSync(big, pngRgba(3000, 3000));
  await add(page, [big, ip('rgb8.png')]);
  const why = ws(page).locator('.ws-why');
  const need = estimateImages([{ bytes: readFileSync(big).length, pixels: 9e6, raw: 36e6, path: 'png-decode', pages: 1 }, { bytes: readFileSync(ip('rgb8.png')).length, pixels: 1536, raw: 4608, path: 'png', pages: 1 }], engine).total;
  await expect(why).toHaveText(new RegExp(`^Together these pictures need about ${formatBytes(need).replace('.', '\\.')} of memory, more than the .* FileConvert lets one task use on this device .*so it was not started\\. Use fewer or smaller pictures in one PDF\\.$`));
  await expect(ws(page).getByRole('button', { name: 'Make the PDF' })).toBeDisabled();
  await ws(page).getByRole('button', { name: 'Remove big-alpha.png' }).click();
  await expect(why).toHaveCount(0);
  const { result } = await make(page, info, [ip('rgb8.png')]);
  expect(result.pages[0].exact).toBe(true);
});

test('a run can be canceled, and the PDF worker is let go', async ({ page }) => {
  await openApp(page);
  await openTool(page);
  const { pngRgba } = await import('./pdfgen');
  const paths = Array.from({ length: 6 }, (_, i) => { const p = join(tempDir(), `cancel-${i}.png`); writeFileSync(p, pngRgba(2000, 2000, i)); return p; });
  await add(page, paths);
  await ws(page).getByRole('button', { name: 'Make the PDF' }).click();
  await ws(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(ws(page).locator('.ws-state.canceled')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fileconvert: { engines: { pdf: { active: number } } } }).__fileconvert.engines.pdf.active)).toBe(0);
});

test('at 320 pixels the options and the list fit', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  await openTool(page);
  await add(page, [ip('rgb8.png'), ip('orient6.jpg')]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(ws(page).getByRole('button', { name: 'Make the PDF' })).toBeEnabled();
});
