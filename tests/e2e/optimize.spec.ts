import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fx, openApp, pyRead, tempDir, unexpectedViolations, writeTemp } from './helpers';

// The image optimization tools (v0.2.0, Phase 3) in the browser: Compress PNG, JPG, WebP and AVIF and Resize images,
// each result read back by tests/e2e/readers.py (kind optimize) with tools that share no code with FileConvert: pypng,
// Pillow, scikit-image, libjpeg-turbo's djpeg and jpegtran, and ExifTool where installed. Fixtures:
// tools/make-optimize-fixtures.py.

const ws = (page: Page) => page.locator('#workspace');
const O = (f: string) => fx(`optimize/${f}`);

interface Check {
  check: string; srcBytes: number; outBytes: number; sameBytes: boolean; markers: string[]; exiftool?: string[];
  pixelsEqual?: boolean; bits?: number; colorType?: number; interlace?: number; chunks?: string[]; problems?: string[]; frames?: number; framesEqual?: boolean;
  progressive?: boolean; pillowEqual?: boolean; djpegEqual?: boolean; coefficientsEqual?: boolean; pictures?: number[][];
  format?: string; size?: number[]; mode?: string; icc?: boolean; srcIcc?: boolean; sameIcc?: boolean; orientation?: number | null; ssim?: number; psnr?: number;
  meanDiff?: number; maxDiff?: number; alphaMeanDiff?: number; ssimVsPillow?: number;
  avif?: { bits: number | null; nclx: number[] | null; icc: boolean; irot: boolean }; srcAvif?: { bits: number | null; nclx: number[] | null; icc: boolean; irot: boolean } | null;
}

async function openTool(page: Page, id: string, title: string): Promise<void> {
  await page.evaluate(t => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool(t), id);
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
}

async function add(page: Page, files: string[]): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(files);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

/** Runs the tool and returns its results, written to a folder, with the details shown for each. */
async function run(page: Page, action = 'Compress', allowLeftOut = false): Promise<Array<{ name: string; path: string; note: string; details: string[] }>> {
  await ws(page).getByRole('button', { name: action, exact: true }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 300_000 });
  // No picture is left out with an error unless the test expects it.
  if (!allowLeftOut) expect((await ws(page).locator('.ws-out > .job-notes li').allTextContents()).filter(t => / was left out: /.test(t))).toEqual([]);
  const outs = await page.evaluate(async () => {
    const w = (window as unknown as { __fileconvert: { workspace: { outputs: Array<{ name: string; blob: Blob; note?: string; details?: string[] }> } } }).__fileconvert.workspace;
    const list = [];
    for (const o of w.outputs) {
      const b = new Uint8Array(await o.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      list.push({ name: o.name, b64: btoa(s), note: o.note ?? '', details: o.details ?? [] });
    }
    return list;
  });
  const dir = tempDir();
  return outs.map(o => ({ name: o.name, path: writeTemp(dir, o.name, Buffer.from(o.b64, 'base64')), note: o.note, details: o.details }));
}

function check(items: Array<{ check: string; src: string; out: string }>): Check[] {
  const spec = join(tempDir(), 'optimize.json');
  writeFileSync(spec, JSON.stringify(items));
  return pyRead<{ results: Check[] }>('optimize', spec).results;
}

const byName = <T extends { name: string }>(list: T[], name: string) => { const x = list.find(o => o.name === name); if (!x) throw new Error(`no result ${name}`); return x; };

test('Compress PNG: every pixel, frame, profile and 16-bit sample kept, damaged files refused with the reason', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  await openTool(page, 'compress-png', 'Compress PNG');
  const files = ['rgb.png', 'rgba.png', 'palette.png', 'rgb16-8.png', 'rgb16.png', 'gray-rgb-icc.png', 'meta.png', 'interlaced.png', 'animated.png'];
  await add(page, [...files.map(O), O('truncated.png'), O('badcrc.png')]);
  await expect(ws(page).locator('.ws-item').filter({ hasText: 'truncated.png' }).locator('.job-error')).toHaveText('This PNG is cut short: it has no end chunk.');
  await expect(ws(page).locator('.ws-item').filter({ hasText: 'badcrc.png' }).locator('.job-error')).toHaveText('This PNG is damaged: its IDAT chunk does not match its checksum.');
  await expect(ws(page).locator('.ws-plan')).toHaveText('9 PNG files, lossless, effort Standard.');
  const outs = await run(page);
  expect(outs.map(o => o.name).sort()).toEqual([...files].sort());
  const res = check(outs.map(o => ({ check: 'png', src: O(o.name), out: o.path })));
  res.forEach((r, i) => {
    const what = outs[i].name;
    expect(r.pixelsEqual, what).toBe(true);
    expect(r.problems, what).toEqual([]);
    expect(r.outBytes, what).toBeLessThanOrEqual(r.srcBytes);
    expect(outs[i].details.join(' '), what).toMatch(/Lossless: every pixel is exactly as it was \(checked\)\.|Kept as it was/);
  });
  const get = (n: string) => res[outs.findIndex(o => o.name === n)];
  // 16 bits kept by default; gray content with an RGB profile stays RGB, its profile usable.
  expect(get('rgb16-8.png').bits).toBe(16);
  expect(get('gray-rgb-icc.png').colorType).toBe(2);
  expect(get('gray-rgb-icc.png').chunks).toContain('iCCP');
  expect(byName(outs, 'gray-rgb-icc.png').details).toContain('Its colors are all gray, but its color profile is for RGB, which a gray PNG cannot carry, so it stays RGB.');
  // Metadata stays by default, rendering chunks too.
  expect(get('meta.png').markers).toEqual(['MARK-AUTHOR-PNG', 'MARK-XMP-PNG']);
  for (const c of ['gAMA', 'cHRM', 'pHYs', 'eXIf', 'tEXt', 'iTXt', 'tIME']) expect(get('meta.png').chunks).toContain(c);
  expect(get('interlaced.png').interlace).toBe(0);
  expect(byName(outs, 'interlaced.png').details).toContain('Interlacing removed: the picture no longer appears gradually while it loads (no pixel changed).');
  expect(get('animated.png').frames).toBe(3);
  expect(get('animated.png').framesEqual).toBe(true);
  expect(get('rgb.png').outBytes).toBeLessThan(get('rgb.png').srcBytes * 0.8);
  expect(byName(outs, 'rgb.png').note).toMatch(/^\d+(\.\d+)? KB to \d+(\.\d+)? KB, \d+(\.\d+)?% smaller \(\d+(\.\d+)? KB saved\)$/);
  // Removing metadata, and allowing 8 bits: the text goes, the orientation stays as a minimal EXIF block.
  await ws(page).locator('[data-key="opt-metadata"]').selectOption('remove');
  await ws(page).locator('[data-key="opt-keep16"]').uncheck();
  const outs2 = await run(page);
  const res2 = check(['meta.png', 'rgb16-8.png'].map(n => ({ check: 'png', src: O(n), out: byName(outs2, n).path })));
  expect(res2[0].pixelsEqual).toBe(true);
  expect(res2[0].markers).toEqual([]);
  expect(res2[0].chunks).toEqual(expect.arrayContaining(['gAMA', 'cHRM', 'eXIf']));
  expect(res2[0].chunks).not.toContain('tEXt');
  expect(res2[1].bits).toBe(8);
  expect(res2[1].pixelsEqual).toBe(true);
  expect(w.errors).toEqual([]);
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('Compress JPG without loss: the same coefficients and pixels in libjpeg-turbo, metadata and the second picture of an MPF file kept', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  await openTool(page, 'compress-jpeg', 'Compress JPG');
  await ws(page).locator('[data-key="opt-mode"]').selectOption('lossless');
  const files = ['photo.jpg', 'photo444.jpg', 'progressive.jpg', 'gray.jpg', 'cmyk.jpg', 'restart.jpg', 'exif-icc.jpg', 'mpf.jpg'];
  await add(page, [...files.map(O), O('truncated.jpg')]);
  await expect(ws(page).locator('.ws-item').filter({ hasText: 'truncated.jpg' }).locator('.job-error')).toHaveText('This JPEG is cut short: it has no end marker, so part of the picture is missing.');
  await expect(ws(page).locator('.ws-plan')).toHaveText('8 JPG files, lossless: every pixel stays the same.');
  const outs = await run(page);
  const res = check(outs.map(o => ({ check: 'jpeg-lossless', src: O(o.name), out: o.path })));
  res.forEach((r, i) => {
    const what = outs[i].name;
    expect(r.pillowEqual, what).toBe(true);
    if (r.djpegEqual !== undefined) { expect(r.djpegEqual, what).toBe(true); expect(r.coefficientsEqual, what).toBe(true); }
    expect(r.outBytes, what).toBeLessThanOrEqual(r.srcBytes);
  });
  const get = (n: string) => res[outs.findIndex(o => o.name === n)];
  expect(get('photo.jpg').progressive).toBe(true);
  expect(get('photo.jpg').outBytes).toBeLessThan(get('photo.jpg').srcBytes);
  expect(get('exif-icc.jpg').markers).toEqual(['MARK-COMMENT-JPEG', 'MARK-MAKE-JPEG', 'MARK-XMP-JPEG']);
  // The second picture is still where its index says.
  expect(get('mpf.jpg').pictures).toEqual([[320, 240], [80, 60]]);
  expect(byName(outs, 'restart.jpg').details).toContain('Restart markers removed (they only help a damaged file recover).');
  expect(byName(outs, 'photo.jpg').details).toContain('Lossless: every pixel is exactly as it was (checked).');
  expect(w.errors).toEqual([]);
  expect(w.outside).toEqual([]);
});

test('Compress JPG at a quality and to a file size: smaller, similar (SSIM), orientation, profile and metadata kept or removed as chosen', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  await openTool(page, 'compress-jpeg', 'Compress JPG');
  await ws(page).locator('[data-key="opt-measure"]').check();
  await add(page, [O('photo.jpg'), O('exif-icc.jpg'), O('cmyk.jpg'), O('mpf.jpg')]);
  await expect(ws(page).locator('.ws-plan')).toHaveText('4 JPG files at quality 80, dimensions kept.');
  const outs = await run(page);
  const res = check(outs.map(o => ({ check: 'lossy', src: O(o.name), out: o.path })));
  const get = (n: string) => res[outs.findIndex(o => o.name === n)];
  for (const [i, r] of res.entries()) {
    // A JPEG with a Multi-Picture index is what Pillow calls MPO.
    expect(r.format, outs[i].name).toBe(outs[i].name === 'mpf.jpg' ? 'MPO' : 'JPEG');
    expect(r.outBytes, outs[i].name).toBeLessThan(r.srcBytes);
    expect(outs[i].details.join(' ')).toContain('Lossy, quality 80');
  }
  expect(get('photo.jpg').ssim).toBeGreaterThan(0.85);
  // The SSIM shown is the one scikit-image computes on the same pictures.
  const shown = Number(/SSIM (\d\.\d{4})/.exec(byName(outs, 'photo.jpg').details.join(' '))![1]);
  expect(Math.abs(shown - get('photo.jpg').ssim!)).toBeLessThan(0.002);
  expect(get('exif-icc.jpg').orientation).toBe(6);
  expect(get('exif-icc.jpg').sameIcc).toBe(true);
  expect(get('exif-icc.jpg').markers).toEqual(['MARK-COMMENT-JPEG', 'MARK-MAKE-JPEG', 'MARK-XMP-JPEG']);
  expect(get('cmyk.jpg').mode).toBe('RGB');
  expect(byName(outs, 'cmyk.jpg').details.join(' ')).toContain('CMYK converted to RGB (sRGB) by the browser');
  expect(get('mpf.jpg').pictures).toEqual([[320, 240], [80, 60]]);
  // Metadata removed: EXIF details, XMP and the comment go; the orientation and the profile stay.
  await ws(page).locator('[data-key="opt-metadata"]').selectOption('remove');
  const outs2 = await run(page);
  const r2 = check([{ check: 'lossy', src: O('exif-icc.jpg'), out: byName(outs2, 'exif-icc.jpg').path }])[0];
  expect(r2.markers).toEqual([]);
  expect(r2.orientation).toBe(6);
  expect(r2.sameIcc).toBe(true);
  if (r2.exiftool) expect(r2.exiftool.filter(t => /Make|Comment|XMP/.test(t))).toEqual([]);
  // To a file size: within it, the dimensions the same.
  await ws(page).locator('[data-key="opt-metadata"]').selectOption('keep');
  await ws(page).locator('[data-key="opt-mode"]').selectOption('target');
  await ws(page).locator('[data-key="opt-target"]').fill('12');
  await ws(page).locator('[data-key="opt-target"]').dispatchEvent('change');
  for (const n of ['exif-icc.jpg', 'cmyk.jpg', 'mpf.jpg']) await ws(page).getByRole('button', { name: `Remove ${n}` }).click();
  await expect(ws(page).locator('.ws-plan')).toHaveText('1 JPG file, each at most 12 KB (quality 10 to 95 is searched), dimensions kept.');
  const t = await run(page);
  const r3 = check([{ check: 'lossy', src: O('photo.jpg'), out: t[0].path }])[0];
  expect(r3.outBytes).toBeLessThanOrEqual(12 * 1024);
  expect(r3.outBytes).toBeGreaterThan(8 * 1024);
  expect(r3.size).toEqual([320, 240]);
  // A size it cannot reach says why, and nothing is offered.
  await ws(page).locator('[data-key="opt-target"]').fill('1');
  await ws(page).locator('[data-key="opt-target"]').dispatchEvent('change');
  await ws(page).getByRole('button', { name: 'Compress', exact: true }).click();
  await expect(ws(page).locator('.job-error')).toHaveText(/^At quality 10, the lowest this tool uses, the file is still [\d.]+ KB, more than the 1\.0 KB asked for\. Make the picture smaller/, { timeout: 120_000 });
  expect(w.errors).toEqual([]);
});

test('Compress WebP and AVIF: lossless kept lossless, transparency, profiles, bit depth, HDR and rotation kept; animations refused', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  await openTool(page, 'compress-webp', 'Compress WebP');
  await add(page, [O('lossy.webp'), O('lossless.webp'), O('alpha.webp'), O('meta.webp'), O('animated.webp')]);
  await expect(ws(page).locator('.ws-item').filter({ hasText: 'animated.webp' }).locator('.job-error')).toHaveText(/^This WebP is animated \(3 frames\)\. Compressing animated WebP is not supported here, so it is not used/);
  const outs = await run(page);
  const res = check(outs.map(o => ({ check: 'lossy', src: O(o.name), out: o.path })));
  const get = (n: string) => res[outs.findIndex(o => o.name === n)];
  expect(byName(outs, 'lossless.webp').details).toContain('Lossless: every pixel is exactly as it was (checked).');
  expect(get('lossless.webp').psnr).toBe(99);
  expect(get('lossy.webp').outBytes).toBeLessThan(get('lossy.webp').srcBytes);
  expect(get('alpha.webp').mode).toBe('RGBA');
  expect(get('meta.webp').sameIcc).toBe(true);
  expect(get('meta.webp').markers).toEqual(['MARK-MAKE-WEBP']);
  await openTool(page, 'compress-avif', 'Compress AVIF');
  await add(page, [O('photo.avif'), O('alpha.avif'), O('icc.avif'), O('rotated.avif'), O('exif.avif'), O('hdr10.avif'), O('animated.avif')]);
  await expect(ws(page).locator('.ws-item').filter({ hasText: 'animated.avif' }).locator('.job-error')).toHaveText('This AVIF is an animation (an image sequence), which this tool does not change.');
  await expect(ws(page).locator('.ws-item').filter({ hasText: 'hdr10.avif' }).locator('.job-info')).toContainText('10-bit, HDR (PQ)');
  const a = await run(page);
  const ra = check(a.map(o => ({ check: 'lossy', src: O(o.name), out: o.path })));
  const ga = (n: string) => ra[a.findIndex(o => o.name === n)];
  expect(ga('alpha.avif').mode).toBe('RGBA');
  expect(ga('icc.avif').avif!.icc).toBe(true);
  expect(ga('icc.avif').sameIcc).toBe(true);
  // Turned in the pixels: the stored 128 x 64 picture with a quarter turn becomes 64 x 128, with no rotation box.
  expect(ga('rotated.avif').size).toEqual([64, 128]);
  expect(ga('rotated.avif').avif!.irot).toBe(false);
  expect(byName(a, 'exif.avif').details).toContain('Its EXIF metadata is not written into the result (this tool does not carry AVIF metadata).');
  // HDR: 10 bits and PQ over BT.2020 kept.
  const hdr = ga('hdr10.avif');
  if (!hdr.sameBytes) {
    expect(hdr.avif!.bits).toBe(10);
    expect(hdr.avif!.nclx!.slice(0, 2)).toEqual([9, 16]);
  }
  expect(w.errors).toEqual([]);
  expect(w.outside).toEqual([]);
});

test('Resize images: fit within, exact, percent; upright, never enlarged unless allowed; drawn as Pillow\'s Lanczos draws them', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  await openTool(page, 'resize-image', 'Resize images');
  // Typed, then the button pressed at once: the value is taken as it is typed, and the press is not lost.
  await ws(page).locator('[data-key="opt-width"]').fill('120');
  await ws(page).locator('[data-key="opt-height"]').fill('120');
  await add(page, [O('photo.jpg'), O('exif-icc.jpg'), O('rgba.png'), O('rgb16.png'), O('alpha.webp'), O('photo.avif'), O('picture.gif'), O('picture.bmp'), O('animated.png')]);
  await expect(ws(page).locator('.ws-item').filter({ hasText: 'animated.png' }).locator('.job-error')).toContainText('This PNG is animated (3 frames). Resize images makes one picture');
  await expect(ws(page).locator('.ws-plan')).toHaveText('8 pictures to fit within 120 x 120 pixels, in their own format.');
  const outs = await run(page, 'Resize');
  const res = check(outs.map(o => ({ check: 'resize', src: O(o.name), out: o.path })));
  const get = (n: string) => res[outs.findIndex(o => o.name === n)];
  expect(get('photo.jpg').size).toEqual([120, 90]);
  // EXIF orientation 6: the 320 x 240 stored picture is upright 240 x 320, so it fits as 90 x 120, orientation 1.
  expect(get('exif-icc.jpg').size).toEqual([90, 120]);
  expect(get('exif-icc.jpg').orientation ?? 1).toBe(1);
  expect(get('exif-icc.jpg').sameIcc).toBe(true);
  expect(get('rgba.png').size).toEqual([120, 90]);
  expect(get('rgba.png').mode).toBe('RGBA');
  expect(get('alpha.webp').mode).toBe('RGBA');
  expect(get('photo.avif').format).toBe('AVIF');
  for (const n of ['rgba.png', 'picture.bmp', 'picture.gif']) {
    // Lossless results against Pillow's Lanczos on the same picture: the same filter, so nearly the same pixels.
    expect(get(n).meanDiff!, n).toBeLessThan(n === 'picture.gif' ? 6 : 1.5);
  }
  for (const n of ['photo.jpg', 'exif-icc.jpg', 'alpha.webp']) expect(get(n).ssimVsPillow!, n).toBeGreaterThan(0.95);
  expect(byName(outs, 'rgb16.png').details).toContain('16 bits per channel kept.');
  // Exact size: stretched to it, nothing cropped. Not enlarged unless allowed.
  for (const n of ['exif-icc.jpg', 'rgba.png', 'rgb16.png', 'alpha.webp', 'photo.avif', 'picture.gif', 'picture.bmp', 'animated.png']) await ws(page).getByRole('button', { name: `Remove ${n}` }).click();
  await ws(page).locator('[data-key="opt-lock"]').uncheck();
  await ws(page).locator('[data-key="opt-height"]').fill('50');
  await ws(page).locator('[data-key="opt-format"]').selectOption('png');
  const exact = await run(page, 'Resize');
  expect(check([{ check: 'resize', src: O('photo.jpg'), out: exact[0].path }])[0].size).toEqual([120, 50]);
  expect(exact[0].name).toBe('photo.png');
  await ws(page).locator('[data-key="opt-lock"]').check();
  await ws(page).locator('[data-key="opt-format"]').selectOption('same');
  await ws(page).locator('[data-key="opt-width"]').fill('2000');
  await ws(page).locator('[data-key="opt-height"]').fill('2000');
  const same = await run(page, 'Resize');
  expect(same[0].details).toContain('It is already within that size, and enlarging is off, so its size is kept.');
  expect(check([{ check: 'resize', src: O('photo.jpg'), out: same[0].path }])[0].sameBytes).toBe(true);
  await ws(page).locator('[data-key="opt-enlarge"]').check();
  const big = await run(page, 'Resize');
  expect(check([{ check: 'resize', src: O('photo.jpg'), out: big[0].path }])[0].size).toEqual([2000, 1500]);
  expect(w.errors).toEqual([]);
  expect(w.outside).toEqual([]);
});

test('a picture that would need more memory than this device allows is refused before anything is decoded', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox reports no device memory: the stand-in below is how the other browsers are held to a small device');
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 1, configurable: true }); });
  await openApp(page);
  await openTool(page, 'compress-png', 'Compress PNG');
  // An 8,000 x 8,000 RGB PNG of one color: a small file whose samples take 192 MB.
  const W = 8000, H = 8000;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(d.length); head.write(t, 4, 'latin1'); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([head.subarray(4), d]))); return Buffer.concat([head, d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  await add(page, [writeTemp(tempDir(), 'large.png', file)]);
  await expect(ws(page).locator('.ws-why')).toHaveText(/^This picture needs about [\d.]+ GB of memory, more than the 512 MB FileConvert lets one task use on this device/);
  await expect(ws(page).getByRole('button', { name: 'Compress', exact: true })).toBeDisabled();
});

test('at 320 pixels, with options, a refused file and results with their details, nothing scrolls sideways', async ({ page }, info) => {
  test.slow();
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page);
  await openTool(page, 'compress-jpeg', 'Compress JPG');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const dir = tempDir();
  const long = writeTemp(dir, 'a-very-long-photo-name-from-a-camera-that-keeps-going-and-going-IMG_20261125_120000.jpg', readFileSync(O('exif-icc.jpg')));
  await ws(page).locator('[data-key="opt-measure"]').check();
  await ws(page).locator('[data-key="opt-resize"]').selectOption('fit');
  await add(page, [long, O('photo.jpg'), O('truncated.jpg')]);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const button = ws(page).getByRole('button', { name: 'Compress', exact: true });
  if (info.project.use.hasTouch) await button.tap(); else await button.click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 120_000 });
  await expect(ws(page).locator('.ws-details').first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect((await ws(page).getByRole('button', { name: /^Download photo\.jpg/ }).boundingBox())!.height).toBeGreaterThanOrEqual(32);
});
