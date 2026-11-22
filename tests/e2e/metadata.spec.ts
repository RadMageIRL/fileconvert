import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, PYTHON, cspViolations, fx, save } from './helpers';

// The Remove photo metadata tool (v0.2.0), checked independently: Pillow decodes the pictures and reads what
// metadata is left, and the raw bytes are searched for every identifying value planted in the fixtures.

const PLANTED = ['LeakyCam', 'LC-1000', 'Jane Example', 'SERIAL-123456', 'SecretProject', 'Secret comment', 'MOTIONVIDEO-SECRET', '2024:05:06'];

async function openTool(page: Page) {
  const w = { errors: [] as string[], outside: [] as string[] };
  page.on('pageerror', e => w.errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (!['blob:', 'data:'].includes(u.protocol) && u.origin !== ORIGIN) w.outside.push(r.url()); });
  await page.goto('./remove-image-metadata/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Remove photo metadata');
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#drop')).toBeHidden();
  return w;
}

/** Compares a result with its original in Pillow: format, size, mode, pixels, the EXIF tags left, ICC and XMP. */
function compare(original: string, result: string): { same: boolean; exif: Record<string, number>; icc: boolean; xmp: boolean; text: string[] } {
  const script = [
    'import sys, json', 'from PIL import Image',
    'a, b = Image.open(sys.argv[1]), Image.open(sys.argv[2]); a.load(); b.load()',
    'same = a.format == b.format and a.size == b.size and a.mode == b.mode and a.tobytes() == b.tobytes()',
    'exif = {str(k): v for k, v in b.getexif().items()}',
    'text = [k for k in b.info if k not in ("dpi", "icc_profile", "exif", "transparency", "gamma", "jfif", "jfif_version", "jfif_unit", "jfif_density", "progressive", "progression", "loop", "duration", "background", "timestamp", "srgb", "chromaticity", "aspect")]',
    'print(json.dumps({"same": same, "exif": exif, "icc": b.info.get("icc_profile") == a.info.get("icc_profile") and bool(a.info.get("icc_profile")), "xmp": "xmp" in b.info or "XML:com.adobe.xmp" in b.info, "text": text}))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, original, result], { encoding: 'utf8' }));
}

test('removes every planted value from JPEG, PNG and WebP, keeps the picture, orientation and color profile', async ({ page }, info) => {
  const w = await openTool(page);
  const ws = page.locator('#workspace');
  await ws.locator('input[type=file]').setInputFiles([fx('image/meta-full.jpg'), fx('image/meta-full.png'), fx('image/meta-full.webp'), fx('image/alpha.png'), fx('image/photo.gif')]);
  await expect(ws.locator('.ws-item.rejected .job-error')).toHaveText('Remove photo metadata takes JPG, PNG or WebP files; this is GIF image.');
  await ws.getByRole('button', { name: 'Remove metadata' }).click();
  await expect(ws.locator('.ws-state.done')).toContainText('Done: 4 files');
  const files = ws.locator('.ws-file');
  await expect(files).toHaveCount(4);
  await expect(files.nth(0)).toContainText(/to .* \(\d+(\.\d)?% smaller\)/);
  await expect(files.nth(0).locator('.ws-details')).toContainText('GPS location');
  await expect(files.nth(0).locator('.ws-details')).toContainText('Kept: Color profile (ICC), so colors look the same; Orientation (a minimal EXIF block that holds nothing else).');
  await expect(files.nth(3).locator('.ws-details')).toHaveText('No metadata was found; the file is unchanged.');
  await expect(ws.locator('.job-notes')).toContainText('faces, landmarks, documents or screens in the photo can still identify a person or a place');

  for (const [i, src] of ['image/meta-full.jpg', 'image/meta-full.png', 'image/meta-full.webp'].entries()) {
    const [dl] = await Promise.all([page.waitForEvent('download'), files.nth(i).getByRole('button').click()]);
    const out = await save(dl, info);
    expect(out.filename).toBe(src.split('/')[1]);
    const bytes = readFileSync(out.path).toString('latin1');
    for (const s of PLANTED) expect(bytes, `${src}: ${s}`).not.toContain(s);
    const c = compare(fx(src), out.path);
    expect(c.same, src).toBe(true);
    expect(c.exif, src).toEqual({ 274: 6 });
    expect(c.icc, src).toBe(true);
    expect(c.xmp, src).toBe(false);
    expect(c.text, src).toEqual([]);
  }
  expect(w.errors).toEqual([]);
  expect(w.outside).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('with both options off nothing but the picture is left; the browser shows the kept orientation', async ({ page }, info) => {
  await openTool(page);
  const ws = page.locator('#workspace');
  await ws.locator('input[type=file]').setInputFiles([fx('image/meta-full.jpg')]);
  await ws.getByRole('button', { name: 'Remove metadata' }).click();
  const kept = await save(...await Promise.all([page.waitForEvent('download'), ws.locator('.ws-file').first().getByRole('button').click()]).then(([d]) => [d, info] as const));
  // The browser itself turns the photo upright from the minimal EXIF block: 64 x 48 stored, 48 x 64 shown.
  const shown = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, readFileSync(kept.path).toString('base64'));
  expect(shown).toEqual([48, 64]);

  await ws.getByLabel('Keep the orientation, so photos stay upright').uncheck();
  await ws.getByLabel('Keep the color profile, so colors look the same').uncheck();
  await ws.getByRole('button', { name: 'Remove metadata' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), ws.locator('.ws-file').first().getByRole('button').click()]);
  const bare = await save(dl, info);
  const c = compare(fx('image/meta-full.jpg'), bare.path);
  expect(c.same).toBe(true);
  expect(c.exif).toEqual({});
  expect(c.icc).toBe(false);
  await expect(ws.locator('.ws-file').first().locator('.ws-details')).toContainText('Color profile (ICC)');
});

test('a batch comes as one ZIP with the original names, and a damaged photo is left out with a reason', async ({ page }, info) => {
  await openTool(page);
  const ws = page.locator('#workspace');
  const full = readFileSync(fx('image/meta-full.jpg'));
  await ws.locator('input[type=file]').setInputFiles([
    { name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: full },
    { name: 'holiday.JPG', mimeType: 'image/jpeg', buffer: full },
    { name: 'cut.jpg', mimeType: 'image/jpeg', buffer: full.subarray(0, full.length >> 1) },
  ]);
  await ws.getByRole('button', { name: 'Remove metadata' }).click();
  await expect(ws.locator('.job-notes')).toContainText('cut.jpg was left out: This JPEG file is cut short');
  const [dl] = await Promise.all([page.waitForEvent('download'), ws.getByRole('button', { name: /Download all \(ZIP, 2\)/ }).click()]);
  const zip = await save(dl, info);
  expect(zip.filename).toMatch(/^Remove photo metadata \d{4}-\d{2}-\d{2}\.zip$/);
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(new Uint8Array(readFileSync(zip.path)));
  expect(Object.keys(entries).sort()).toEqual(['holiday (2).jpg', 'holiday.jpg']);
  for (const b of Object.values(entries)) for (const s of PLANTED) expect(Buffer.from(b).toString('latin1')).not.toContain(s);
});
