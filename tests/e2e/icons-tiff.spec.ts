import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { PYTHON, addFiles, convert, download, expectDone, fx, openApp, pillow, row } from './helpers';

// ICO in and out, and multi-page TIFF (v0.2.0), checked by Pillow and FFmpeg rather than by the browser that
// made them.

/** Every picture in an ICO as Pillow reads it: size, mode, and the alpha of the top-left and center pixels. */
function icoEntries(path: string): Array<{ size: [number, number]; corner: number; center: number[] }> {
  const script = [
    'import sys, json', 'from PIL import Image', 'im = Image.open(sys.argv[1]); out = []',
    'for s in sorted(im.info["sizes"]):',
    '    im.size = s; im.load(); a = im.convert("RGBA")',
    '    out.append({"size": list(a.size), "corner": a.getpixel((0, 0))[3], "center": list(a.getpixel((a.size[0] * 3 // 4, a.size[1] * 3 // 4)))})',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path], { encoding: 'utf8' }));
}

/** A TIFF as Pillow reads it: page count, compression, and each page's size and mode. */
function tiffInfo(path: string): { frames: number; compression: string; pages: Array<{ size: [number, number]; mode: string }> } {
  const script = [
    'import sys, json', 'from PIL import Image', 'im = Image.open(sys.argv[1]); pages = []',
    'for i in range(im.n_frames):', '    im.seek(i); im.load(); pages.append({"size": list(im.size), "mode": im.mode})',
    'print(json.dumps({"frames": im.n_frames, "compression": im.info.get("compression"), "pages": pages}))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path], { encoding: 'utf8' }));
}

async function setImageOption(page: Page, label: string, value: string): Promise<void> {
  const panel = page.locator('details.panel[data-cat="image"]');
  if (!(await panel.evaluate(d => (d as HTMLDetailsElement).open))) await panel.locator('summary').click();
  await panel.getByLabel(label).selectOption(value);
}

test('PNG to ICO: a favicon with 16, 32 and 48 pixel pictures that keep transparency', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/icon-png.ico')]);
  await convert(page, 'icon-png.ico', 'PNG');
  await expectDone(page, 'icon-png.ico');
  const png = await download(page, 'icon-png.ico', info);
  const p = pillow(png.path, [[0, 0], [250, 250]]);
  expect(p.size).toEqual([256, 256]);
  expect(p.px[0][3]).toBe(0);
  await expect(row(page, 'icon-png.ico').locator('.job-notes')).toContainText('The icon holds 4 sizes (16, 32, 48, 256 pixels); the largest, 256 x 256, was converted.');

  await page.locator('#picker').setInputFiles([{ name: 'logo.png', mimeType: 'image/png', buffer: (await import('node:fs')).readFileSync(png.path) }]);
  await convert(page, 'logo.png', 'ICO');
  await expectDone(page, 'logo.png');
  const ico = await download(page, 'logo.png', info);
  expect(ico.filename).toBe('logo.ico');
  const entries = icoEntries(ico.path);
  expect(entries.map(e => e.size)).toEqual([[16, 16], [32, 32], [48, 48]]);
  for (const e of entries) {
    expect(e.corner).toBe(0);
    expect(e.center[3]).toBe(255);
    expect(Math.abs(e.center[0] - 220) + Math.abs(e.center[1] - 200)).toBeLessThan(40);
  }
  await expect(row(page, 'logo.png').locator('.job-status')).toContainText('ICO, 16, 32, 48 px');
});

test('ICO sizes: all six, or one chosen size; a picture that is not square is centered', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/alpha.png')]);
  await convert(page, 'alpha.png', 'ICO');
  await setImageOption(page, 'ICO sizes', 'all');
  await convert(page, 'alpha.png', 'ICO');
  await expectDone(page, 'alpha.png');
  expect(icoEntries((await download(page, 'alpha.png', info)).path).map(e => e.size[0])).toEqual([16, 32, 48, 64, 128, 256]);
  await expect(row(page, 'alpha.png').locator('.job-notes')).toContainText('not square, so it was centered on a transparent square');
  await setImageOption(page, 'ICO sizes', '32');
  await convert(page, 'alpha.png', 'ICO');
  expect(icoEntries((await download(page, 'alpha.png', info)).path).map(e => e.size)).toEqual([[32, 32]]);
});

test('ICO input: PNG pictures, 32-bit bitmaps, and 8-bit and 1-bit bitmaps with a transparency mask', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/icon-bmp.ico'), fx('image/icon-8bit.ico'), fx('image/icon-1bit.ico')]);
  for (const [name, size, opaque] of [['icon-bmp.ico', 64, [220, 200, 90]], ['icon-8bit.ico', 16, [255, 0, 0]], ['icon-1bit.ico', 32, [0, 0, 0]]] as const) {
    await convert(page, name, 'PNG');
    await expectDone(page, name);
    const p = pillow((await download(page, name, info)).path, [[0, 0], [size - 1, size - 1]]);
    expect(p.size, name).toEqual([size, size]);
    expect(p.px[0][3], name).toBe(0);
    expect(p.px[1], name).toEqual([...opaque, 255]);
  }
});

test('a damaged icon directory is refused with a reason', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('hostile/bad-offsets.ico')]);
  await convert(page, 'bad-offsets.ico', 'PNG');
  await expect(row(page, 'bad-offsets.ico')).toHaveClass(/failed|unsupported/);
  await expect(row(page, 'bad-offsets.ico').locator('.job-error')).toContainText(/ICO/);
});

test('multi-page TIFF: every page to its own PNG, all pages kept in a TIFF, LZW, or the first page only', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/two-pages.tiff')]);
  const src = tiffInfo(fx('image/two-pages.tiff'));
  await convert(page, 'two-pages.tiff', 'PNG');
  await expectDone(page, 'two-pages.tiff');
  await expect(row(page, 'two-pages.tiff').locator('.outputs button')).toHaveText(['Download two-pages - page 1.png', 'Download two-pages - page 2.png']);
  for (let i = 0; i < 2; i++) expect(pillow((await download(page, 'two-pages.tiff', info, i)).path).size).toEqual(src.pages[i].size);

  await setImageOption(page, 'TIFF compression', 'lzw');
  await convert(page, 'two-pages.tiff', 'TIFF');
  await expectDone(page, 'two-pages.tiff');
  const out = await download(page, 'two-pages.tiff', info);
  const t = tiffInfo(out.path);
  expect(t.frames).toBe(2);
  expect(t.compression).toBe('tiff_lzw');
  expect(t.pages.map(p => p.size)).toEqual(src.pages.map(p => p.size));
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', out.path, '-f', 'null', '-']);
  await expect(row(page, 'two-pages.tiff').locator('.job-status')).toContainText(', 2 pages, LZW');

  await setImageOption(page, 'Multi-page TIFF', 'first');
  await convert(page, 'two-pages.tiff', 'PNG');
  await expect(row(page, 'two-pages.tiff').locator('.outputs button')).toHaveCount(1);
  await expect(row(page, 'two-pages.tiff').locator('.job-notes')).toContainText('the first was converted, as set in Images settings');
});

test('TIFF keeps transparency, and LZW and uncompressed TIFF hold the same pixels', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/alpha.png')]);
  await convert(page, 'alpha.png', 'TIFF');
  await expectDone(page, 'alpha.png');
  const plain = await download(page, 'alpha.png', info);
  await setImageOption(page, 'TIFF compression', 'lzw');
  await convert(page, 'alpha.png', 'TIFF');
  const lzw = await download(page, 'alpha.png', info);
  const script = 'import sys\nfrom PIL import Image\na, b = Image.open(sys.argv[1]), Image.open(sys.argv[2])\nprint(a.mode, b.mode, a.info.get("compression"), b.info.get("compression"), a.tobytes() == b.tobytes(), a.getchannel("A").getextrema())';
  expect(execFileSync(PYTHON, ['-I', '-c', script, plain.path, lzw.path], { encoding: 'utf8' }).trim()).toBe('RGBA RGBA raw tiff_lzw True (0, 255)');
});

test('combine images into one TIFF: pages in the chosen order, turned upright, TIFF pages included, LZW', async ({ page }, info) => {
  await page.goto('./images-to-tiff/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Combine images into a TIFF');
  const ws = page.locator('#workspace');
  await ws.locator('input[type=file]').setInputFiles([fx('image/photo.jpg'), fx('image/alpha.png'), fx('image/two-pages.tiff'), fx('image/rotated-exif6.jpg')]);
  await expect(ws.locator('.ws-item:not(.rejected) .job-name')).toHaveText(['photo.jpg', 'alpha.png', 'two-pages.tiff', 'rotated-exif6.jpg']);
  for (let i = 0; i < 3; i++) await ws.getByRole('button', { name: 'Move rotated-exif6.jpg up' }).click();
  await expect(ws.locator('.ws-item:not(.rejected) .job-name')).toHaveText(['rotated-exif6.jpg', 'photo.jpg', 'alpha.png', 'two-pages.tiff']);
  await ws.getByLabel('Compression').selectOption('lzw');
  await ws.getByRole('button', { name: 'Make the TIFF' }).click();
  await expect(ws.locator('.ws-file')).toContainText('5 pages');
  const [dl] = await Promise.all([page.waitForEvent('download'), ws.locator('.ws-file').getByRole('button').click()]);
  const { path, filename } = await (await import('./helpers')).save(dl, info);
  expect(filename).toBe('combined.tiff');
  const script = [
    'import sys, json', 'from PIL import Image, ImageOps',
    'def upright(p):', '    im = Image.open(p); return [list(ImageOps.exif_transpose(im).size)]',
    'def pages(p):', '    im = Image.open(p); out = []', '    for i in range(im.n_frames):', '        im.seek(i); out.append([list(im.size), im.mode])', '    return out',
    'srcs = upright(sys.argv[2]) + upright(sys.argv[3]) + upright(sys.argv[4]) + [p[0] for p in pages(sys.argv[5])]',
    'out = Image.open(sys.argv[1])',
    'print(json.dumps({"compression": out.info.get("compression"), "pages": pages(sys.argv[1]), "expected": srcs}))',
  ].join('\n');
  const r = JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path, fx('image/rotated-exif6.jpg'), fx('image/photo.jpg'), fx('image/alpha.png'), fx('image/two-pages.tiff')], { encoding: 'utf8' }));
  expect(r.compression).toBe('tiff_lzw');
  expect(r.pages.map((p: [number[], string]) => p[0])).toEqual(r.expected);
  expect(r.pages[2][1]).toBe('RGBA');
  await expect(ws.locator('.job-notes')).toContainText('two-pages.tiff added its 2 pages.');
});
