import { expect, test } from '@playwright/test';
import {
  PERSONAL_EXIF, addFiles, convert, convertAllTo, cspViolations, download, downloadZip, expectDone, ffprobe, fx, near, openApp, pillow, row, setTarget, tempDir, writeTemp,
} from './helpers';

// Pixels in the fixtures (see tools/make-fixtures.py):
//   alpha art, 320 x 200: gradient; a fully transparent hole centered at (80, 100); a half-transparent band x 200..279;
//   an opaque white square at (250..300, 20..60). Opaque gradient at (150, 150): about (120, 192, 160).
//   photo, 320 x 200: opaque; red square at (0..30, 0..30); dark band (20, 30, 60) along the top.
const ALPHA_INPUTS = ['alpha.png', 'alpha.webp', 'alpha.avif', 'alpha.heic', 'alpha.tiff'];
const OPAQUE_INPUTS = ['photo.jpg', 'photo.bmp', 'photo.gif'];
const OUTPUTS: Array<[string, string, string]> = [
  ['JPG', 'jpg', 'JPEG'], ['PNG', 'png', 'PNG'], ['WebP', 'webp', 'WEBP'], ['AVIF', 'avif', 'AVIF'],
  ['GIF', 'gif', 'GIF'], ['BMP', 'bmp', 'BMP'], ['TIFF', 'tiff', 'TIFF'],
];
const HOLE: [number, number] = [80, 100];
const BAND: [number, number] = [240, 150];
const SOLID: [number, number] = [150, 150];
const RED: [number, number] = [12, 12];

test.describe('every image input to every image output', () => {
  for (const [label, ext, pilFormat] of OUTPUTS) {
    test(`to ${label}`, async ({ page }, info) => {
      test.slow();
      const w = await openApp(page);
      await addFiles(page, [...ALPHA_INPUTS, ...OPAQUE_INPUTS].map(f => fx(`image/${f}`)));
      await convertAllTo(page, label);
      for (const f of [...ALPHA_INPUTS, ...OPAQUE_INPUTS]) await expectDone(page, f);
      const zip = await downloadZip(page, info);
      expect(zip.name).toMatch(/^FileConvert \d{4}-\d{2}-\d{2}\.zip$/);
      const dir = tempDir();
      // Each base name appears once per input; inputs that share a base name get numbered names.
      const names = Object.keys(zip.entries).sort();
      expect(names).toHaveLength(8);
      for (const [name, data] of Object.entries(zip.entries)) {
        expect(name.endsWith(`.${ext}`)).toBe(true);
        const im = pillow(writeTemp(dir, name, data), [HOLE, BAND, SOLID, RED]);
        expect(im.format, name).toBe(pilFormat);
        expect(im.size, name).toEqual([320, 200]);
        expect(im.exif.filter(t => PERSONAL_EXIF.includes(t) && !(ext === 'tiff' && t === 305)), `${name} carries no camera, time or place metadata`).toEqual([]);
      }
      // Transparency: kept where the format can hold it, flattened to white where it cannot, on/off in GIF.
      const alphaNames = names.filter(n => n.startsWith('alpha'));
      expect(alphaNames).toHaveLength(5);
      for (const name of alphaNames) {
        const im = pillow(writeTemp(dir, name, zip.entries[name]), [HOLE, BAND, SOLID]);
        const [hole, band, solid] = im.px;
        expect(near(solid, [120, 192, 160, 255], ext === 'gif' ? 40 : 24), `${name} solid ${solid}`).toBe(true);
        if (ext === 'jpg' || ext === 'bmp') {
          expect(near(hole, [255, 255, 255, 255], 6), `${name} hole ${hole}`).toBe(true);
          expect(near(band, [255, 255, 255, 255], 6), `${name} band ${band}`).toBe(false);
        } else if (ext === 'gif') {
          expect(hole[3], `${name} hole`).toBe(0);
          expect([0, 255]).toContain(band[3]);
        } else {
          expect(hole[3], `${name} hole alpha`).toBe(0);
          expect(Math.abs(band[3] - 128), `${name} band alpha ${band[3]}`).toBeLessThanOrEqual(ext === 'avif' ? 12 : 2);
        }
      }
      for (const name of names.filter(n => n.startsWith('photo'))) {
        const im = pillow(writeTemp(dir, name, zip.entries[name]), [RED]);
        expect(near(im.px[0], [230, 30, 30, 255], 40), `${name} red ${im.px[0]}`).toBe(true);
        if (im.alpha) expect(im.alpha[0], `${name} stays opaque`).toBe(255);
      }
      if (ext === 'jpg' || ext === 'bmp') {
        await expect(row(page, 'alpha.png').locator('.job-notes')).toContainText('transparent areas');
        await expect(row(page, 'photo.jpg').locator('.job-notes')).toHaveCount(0);
      }
      expect(w.errors).toEqual([]);
      expect(await cspViolations(page)).toEqual([]);
      expect(w.outside).toEqual([]);
    });
  }
});

test('EXIF orientation is applied to the pixels and GPS metadata is not copied', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/rotated-exif6.jpg')]);
  // The list shows the size the picture is displayed at, not the stored one.
  await expect(row(page, 'rotated-exif6.jpg').locator('.job-info')).toContainText('320 x 200');
  await convert(page, 'rotated-exif6.jpg', 'PNG');
  await expectDone(page, 'rotated-exif6.jpg');
  const { path } = await download(page, 'rotated-exif6.jpg', info);
  const im = pillow(path, [RED, [300, 180]]);
  expect(im.size).toEqual([320, 200]);
  expect(near(im.px[0], [230, 30, 30, 255], 40)).toBe(true);
  expect(near(im.px[1], [230, 30, 30, 255], 40)).toBe(false);
  expect(im.exif).toEqual([]);
});

test('resizing: fit inside a box keeps the aspect ratio and never enlarges; percent scales', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/photo.jpg'), fx('image/alpha.png')]);
  await page.locator('details[data-cat="image"] summary').click();
  const size = page.locator('details[data-cat="image"]').getByRole('combobox', { name: 'Resize' });
  await size.selectOption('fit');
  await page.getByRole('spinbutton', { name: 'Largest width in pixels' }).fill('100');
  await page.getByRole('spinbutton', { name: 'Largest height in pixels' }).fill('100');
  await page.getByRole('spinbutton', { name: 'Largest height in pixels' }).press('Tab');
  await convert(page, 'photo.jpg', 'PNG');
  expect(pillow((await download(page, 'photo.jpg', info)).path).size).toEqual([100, 63]);
  await page.getByRole('spinbutton', { name: 'Largest width in pixels' }).fill('5000');
  await page.getByRole('spinbutton', { name: 'Largest height in pixels' }).fill('5000');
  await page.getByRole('spinbutton', { name: 'Largest height in pixels' }).press('Tab');
  await convert(page, 'alpha.png', 'WebP');
  expect(pillow((await download(page, 'alpha.png', info)).path).size).toEqual([320, 200]);
  await size.selectOption('percent');
  await page.getByRole('spinbutton', { name: 'Percent' }).fill('50');
  await page.getByRole('spinbutton', { name: 'Percent' }).press('Tab');
  await convert(page, 'alpha.png', 'WebP');
  expect(pillow((await download(page, 'alpha.png', info)).path).size).toEqual([160, 100]);
});

test('quality changes the size of lossy output', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/alpha.png')]);
  await page.locator('details[data-cat="image"] summary').click();
  const q = page.getByRole('slider', { name: 'Quality' });
  await q.fill('95');
  await q.dispatchEvent('change');
  await convert(page, 'alpha.png', 'JPG');
  const high = (await download(page, 'alpha.png', info)).path;
  await q.fill('20');
  await q.dispatchEvent('change');
  await convert(page, 'alpha.png', 'JPG');
  const low = (await download(page, 'alpha.png', info)).path;
  const { statSync } = await import('node:fs');
  expect(statSync(low).size).toBeLessThan(statSync(high).size * 0.6);
});

test('animated GIF stays animated as GIF and as video, and a still output says only the first frame was kept', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('image/animated.gif')]);
  await convert(page, 'animated.gif', 'GIF (animated)');
  await expectDone(page, 'animated.gif');
  const gif = pillow((await download(page, 'animated.gif', info)).path, [[30, 20]]);
  expect(gif.frames).toBe(3);
  await convert(page, 'animated.gif', 'MP4');
  await expectDone(page, 'animated.gif');
  const mp4 = ffprobe((await download(page, 'animated.gif', info)).path);
  const v = mp4.streams.find(s => s.codec_type === 'video')!;
  expect(v.codec_name).toBe('h264');
  expect(Number(v.nb_frames)).toBe(3);
  expect(Number(mp4.format.duration)).toBeCloseTo(0.6, 1);
  await convert(page, 'animated.gif', 'WebM');
  await expectDone(page, 'animated.gif');
  const webm = ffprobe((await download(page, 'animated.gif', info)).path);
  expect(webm.streams.find(s => s.codec_type === 'video')!.codec_name).toBe('vp9');
  expect(Number(webm.format.duration)).toBeCloseTo(0.6, 1);
  await setTarget(page, 'animated.gif', 'PNG (first frame)');
  await expect(row(page, 'animated.gif').locator('.job-notes')).toContainText('only the first frame will be kept');
  await convert(page, 'animated.gif', 'PNG (first frame)');
  await expect(row(page, 'animated.gif').locator('.job-notes')).toContainText('only the first frame was converted');
  const png = pillow((await download(page, 'animated.gif', info)).path, [[30, 20]]);
  expect(png.frames).toBe(1);
  expect(near(png.px[0], [220, 40, 40, 255], 30)).toBe(true);
});

test('animated WebP and APNG to a still format keep the first frame, and say so', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('image/animated.webp'), fx('image/animated.png')]);
  for (const f of ['animated.webp', 'animated.png']) {
    await convert(page, f, 'JPG (first frame)');
    await expectDone(page, f);
    await expect(row(page, f).locator('.job-notes')).toContainText('only the first frame was converted');
  }
});

test('a two-page TIFF converts its first page and says so; a PNG named .jpg converts as PNG', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('image/two-pages.tiff'), fx('image/png-named.jpg')]);
  await convert(page, 'two-pages.tiff', 'PNG');
  await expectDone(page, 'two-pages.tiff');
  await expect(row(page, 'two-pages.tiff').locator('.job-notes')).toContainText('The TIFF has 2 pages');
  await expect(row(page, 'png-named.jpg').locator('.job-notes')).toContainText('Named .jpg but contains PNG image data');
  await convert(page, 'png-named.jpg', 'WebP');
  await expectDone(page, 'png-named.jpg');
});

test('hostile images fail with a clear message and leave the page working', async ({ page }) => {
  const w = await openApp(page);
  await addFiles(page, [fx('hostile/huge-dimensions.png'), fx('hostile/truncated.png'), fx('hostile/random.jpg')]);
  await expect(row(page, 'random.jpg')).toHaveClass(/unsupported/);
  await expect(row(page, 'random.jpg').locator('.job-error')).toContainText('does not recognize this file type');
  await convert(page, 'huge-dimensions.png', 'JPG');
  await expect(row(page, 'huge-dimensions.png')).toHaveClass(/failed/);
  await expect(row(page, 'huge-dimensions.png').locator('.job-error')).toContainText('60,000 x 60,000 pixels; the limit is 100 megapixels');
  // A cut-off PNG: Chrome refuses to decode it, Firefox decodes the part that is there. Either way it is reported.
  await convert(page, 'truncated.png', 'JPG');
  if (/\bfailed\b/.test((await row(page, 'truncated.png').getAttribute('class'))!)) {
    await expect(row(page, 'truncated.png').locator('.job-error')).toContainText('could not be decoded');
  } else {
    await expect(row(page, 'truncated.png').locator('.job-notes')).toContainText('ends early');
  }
  await addFiles(page, [fx('image/photo.jpg')]);
  await convert(page, 'photo.jpg', 'PNG');
  await expectDone(page, 'photo.jpg');
  expect(w.errors).toEqual([]);
});
