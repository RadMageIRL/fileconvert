import { expect, test, type Page } from '@playwright/test';
import { fx, openApp } from './helpers';

// What each task fetches from the app's own folder, as it needs it: a tool loads its own encoder and decoder, and the
// fonts (Arimo and Foxit for pdf.js, Noto Sans for documents made from text) are fetched only by a task that draws or
// writes text with them. That fonts are fetched when a PDF needs them is tested in pdf-images.spec.ts.

const ws = (page: Page) => page.locator('#workspace');

/** The fonts and WebAssembly modules the page asks for, by name without the build's hash. */
function watchAssets(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', r => {
    const m = /\/([^/?]+?)(?:-[\w-]{8})?\.(wasm|ttf|pfb|otf|woff2?)(?:\?|$)/.exec(new URL(r.url()).pathname);
    if (m) seen.push(`${m[1]}.${m[2]}`);
  });
  return seen;
}

async function runTool(page: Page, id: string, files: string[], action: string): Promise<void> {
  await page.evaluate(t => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool(t), id);
  await ws(page).locator('input[type=file]').setInputFiles(files);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
  await ws(page).getByRole('button', { name: action, exact: true }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 300_000 });
}

const FONT = /\.(ttf|pfb|otf|woff2?)$/;

test('each image tool fetches its own codecs and no fonts', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  const seen = watchAssets(page);
  // Loading the app fetches no codec and no font.
  expect(seen).toEqual([]);
  // Each compression loads only its own format's codecs (MozJPEG also decodes, for the similarity measure).
  const only = (family: RegExp) => { expect(seen.filter(x => !family.test(x))).toEqual([]); expect(seen.length).toBeGreaterThan(0); seen.length = 0; };
  await runTool(page, 'compress-jpeg', [fx('optimize/photo.jpg')], 'Compress');
  only(/^mozjpeg_(enc|dec)\.wasm$/);
  await runTool(page, 'compress-png', [fx('optimize/rgb.png')], 'Compress');
  only(/^squoosh_oxipng_bg\.wasm$/);
  await runTool(page, 'compress-webp', [fx('optimize/lossy.webp')], 'Compress');
  only(/^webp_(enc|dec)\.wasm$/);
  // Resizing a JPG to a JPG, and making a PDF of pictures, draw no text: no font.
  await runTool(page, 'resize-image', [fx('optimize/photo.jpg')], 'Resize');
  expect(seen.filter(x => FONT.test(x) || /^(openjpeg|qcms_bg|jbig2)\.wasm$/.test(x))).toEqual([]);
  seen.length = 0;
  await runTool(page, 'images-to-pdf', [fx('optimize/photo.jpg'), fx('optimize/rgb.png')], 'Make the PDF');
  expect(seen.filter(x => FONT.test(x) || /^(openjpeg|qcms_bg|jbig2)\.wasm$/.test(x))).toEqual([]);
  expect(w.outside).toEqual([]);
  expect(w.errors).toEqual([]);
});
