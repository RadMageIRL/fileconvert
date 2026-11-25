import { expect, test, type Page } from '@playwright/test';
import { fx, openApp, pyRead, tempDir, unexpectedViolations, writeTemp } from './helpers';
import { numbered } from './pdfgen';

// Page previews (v0.2.0, Phase 2) in the PDF tools' workspace: drawn by pdf.js in a render worker of their own, only for
// pages near the screen, at most a bounded number kept; chosen by click, Shift-click or the keyboard, in step with the
// typed pages; turned in the rotate tool; labeled with their file in split. Previews never decide whether a tool runs.
// A tile's picture is checked as being there, not as visible: the browser skips laying out tiles below the screen.

const ws = (page: Page) => page.locator('#workspace');
const tiles = (page: Page) => ws(page).locator('.pg-tile');
const grid = (page: Page) => ws(page).locator('.pg-grid');

async function openTool(page: Page, id: string): Promise<void> {
  await page.evaluate(t => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool(t), id);
}

async function add(page: Page, path: string): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(path);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

test('previews of a 12-page PDF: chosen by click, Shift-click and the keyboard, in step with the typed pages', async ({ page }, info) => {
  const w = await openApp(page);
  await openTool(page, 'extract-pdf-pages');
  const dir = tempDir();
  await add(page, writeTemp(dir, 'twelve.pdf', numbered(12)));
  await expect(tiles(page)).toHaveCount(12);
  // Pictures appear for the pages on screen.
  await expect(tiles(page).first().locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  const text = ws(page).getByLabel('Pages to extract');
  const status = ws(page).locator('.pg-status');
  await expect(status).toHaveText('12 pages. Choose pages here or type them above.');
  const touch = !!info.project.use.hasTouch;
  const tap = async (i: number, shift = false) => {
    if (touch && !shift) await tiles(page).nth(i).tap(); else await tiles(page).nth(i).click({ modifiers: shift ? ['Shift'] : [] });
  };
  await tap(2);
  await expect(text).toHaveValue('3');
  await expect(tiles(page).nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(tiles(page).nth(2).locator('.pg-mark')).toHaveText('Extracted');
  if (!touch) {
    await tap(5, true);
    await expect(text).toHaveValue('3-6');
    // The keyboard: the grid is one stop; End goes to the last page, Space chooses it, Left and Space the one before.
    await grid(page).focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Space');
    await expect(text).toHaveValue('3-6, 12');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');
    await expect(text).toHaveValue('3-6, 11-12');
    await expect(grid(page)).toHaveAttribute('aria-activedescendant', 'pg-11');
    await page.keyboard.press('Space');
    await expect(text).toHaveValue('3-6, 12');
    await expect(status).toHaveText('5 of 12 pages chosen.');
  }
  await ws(page).getByRole('button', { name: 'Select all' }).click();
  await expect(text).toHaveValue('1-12');
  await ws(page).getByRole('button', { name: 'Clear selection' }).click();
  await expect(text).toHaveValue('');
  await expect(ws(page).locator('.pg-tile[aria-selected="true"]')).toHaveCount(0);
  // Typing chooses the same pages in the previews.
  await text.fill('4, 2');
  await text.press('Tab');
  await expect(ws(page).locator('.pg-tile[aria-selected="true"]')).toHaveCount(2);
  await expect(tiles(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tiles(page).nth(3)).toHaveAttribute('aria-selected', 'true');
  await ws(page).getByRole('button', { name: 'Extract the pages' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).getByRole('button', { name: 'Download twelve-extracted.pdf' }).click()]);
  const out = writeTemp(tempDir(), 'out.pdf', new Uint8Array(await (await import('node:fs/promises')).readFile(await dl.path())));
  const read = pyRead<{ qpdf: boolean; pypdf: string[]; pdfium: string[] }>('pdforder', out);
  expect(read.qpdf).toBe(true);
  expect(read.pypdf).toEqual(['Page 4', 'Page 2']);
  expect(read.pdfium).toEqual(['Page 4', 'Page 2']);
  expect(w.errors).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('rotate: the chosen pages are shown turned by the turn chosen; every page when none is chosen', async ({ page }) => {
  await openApp(page);
  await openTool(page, 'rotate-pdf');
  await add(page, fx('pdf-render/rotations.pdf'));
  const canvas = (i: number) => tiles(page).nth(i).locator('canvas');
  const turned = (i: number) => canvas(i).evaluate(c => (c as HTMLCanvasElement).style.transform);
  await expect(canvas(3)).toBeVisible({ timeout: 30_000 });
  // Every page is turned while the box is empty.
  for (let i = 0; i < 4; i++) await expect.poll(() => turned(i)).toBe('rotate(90deg)');
  await tiles(page).nth(1).click();
  await ws(page).locator('[data-key="pages-none"]').click();
  await tiles(page).nth(1).click();
  await expect(ws(page).getByLabel('Pages to turn')).toHaveValue('2');
  await expect.poll(() => turned(1)).toBe('rotate(90deg)');
  await expect.poll(() => turned(0)).toBe('');
  await ws(page).locator('[data-key="opt-by"]').selectOption('180');
  await expect.poll(() => turned(1)).toBe('rotate(180deg)');
  await expect(tiles(page).nth(1).locator('.pg-mark')).toHaveText('Turned');
});

test('split: each page is labeled with the file it goes to, as the ranges change', async ({ page }) => {
  await openApp(page);
  await openTool(page, 'split-pdf');
  const dir = tempDir();
  await add(page, writeTemp(dir, 'six.pdf', numbered(6)));
  const marks = ws(page).locator('.pg-tile .pg-mark');
  const ranges = ws(page).getByLabel('Page ranges, one file each');
  await ranges.fill('1-2, 2-3, 5');
  await ranges.press('Tab');
  await expect(marks).toHaveText(['File 1', 'Files 1, 2', 'File 2', 'Left out', 'File 3', 'Left out']);
  await ws(page).locator('[data-key="opt-mode"]').selectOption('every');
  await ws(page).locator('[data-key="opt-every"]').fill('4');
  await ws(page).locator('[data-key="opt-every"]').press('Tab');
  await expect(marks).toHaveText(['File 1', 'File 1', 'File 1', 'File 1', 'File 2', 'File 2']);
});

test('5,000 pages: only pages near the screen are drawn, canvases are let go as they scroll away, and the tool runs', async ({ page }) => {
  test.slow();
  await openApp(page);
  await openTool(page, 'delete-pdf-pages');
  const dir = tempDir();
  const t0 = Date.now();
  await add(page, writeTemp(dir, 'many.pdf', numbered(5000)));
  await expect(tiles(page)).toHaveCount(5000);
  await expect(tiles(page).first().locator('canvas')).toHaveCount(1, { timeout: 60_000 });
  const first = Date.now() - t0;
  const live = () => ws(page).locator('.pg-tile canvas').count();
  await expect.poll(live).toBeGreaterThan(3);
  expect(await live()).toBeLessThanOrEqual(80);
  // To the end of the grid: the last pages are drawn, the first ones let their canvases go.
  const t1 = Date.now();
  await grid(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(tiles(page).last().locator('canvas')).toHaveCount(1, { timeout: 60_000 });
  const scrolled = Date.now() - t1;
  await expect(tiles(page).first().locator('canvas')).toHaveCount(0);
  expect(await live()).toBeLessThanOrEqual(80);
  // Choosing a page far down works without its neighbours being drawn, and the tool runs.
  await tiles(page).nth(4998).click();
  await expect(ws(page).getByLabel('Pages to delete')).toHaveValue('4999');
  await ws(page).getByRole('button', { name: 'Delete the pages' }).click();
  // Polled once a second: checking visibility on every frame of a page holding 5,000 tiles kept Chrome from showing the
  // result within two minutes, although the run itself takes about two seconds.
  await expect.poll(() => ws(page).locator('.ws-state.done').count(), { timeout: 120_000, intervals: [1000] }).toBe(1);
  test.info().annotations.push({ type: 'timing', description: `first preview ${first} ms after adding (check included), last page drawn ${scrolled} ms after scrolling` });
});

test('a PDF too large to preview on this device: previews are off with the reason, and the tool still works', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox reports no device memory: the stand-in below is how the other browsers are held to a small device');
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 1, configurable: true }); });
  await openApp(page);
  await openTool(page, 'delete-pdf-pages');
  await add(page, fx('pdf-render/big-picture.pdf'));
  await expect(ws(page).locator('.pg-note')).toHaveText(/^Previews are off for this PDF\. Showing previews of this PDF needs about [\d.]+ (MB|GB) of memory, more than the 512 MB FileConvert lets one task use on this device .*You can still choose pages here or by typing them\.$/, { timeout: 30_000 });
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first().locator('.pg-ph')).toHaveText('1');
  // Editing it does not decode the picture, so it fits; the result simply has no page to delete here, so rotate instead.
  await openTool(page, 'rotate-pdf');
  await add(page, fx('pdf-render/big-picture.pdf'));
  await expect(ws(page).locator('.pg-note')).toBeVisible({ timeout: 30_000 });
  await ws(page).getByRole('button', { name: 'Rotate the pages' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
});

test('previews of a file go when it is removed, and the next file gets its own', async ({ page }) => {
  await openApp(page);
  await openTool(page, 'organize-pdf');
  const dir = tempDir();
  await add(page, writeTemp(dir, 'three.pdf', numbered(3)));
  await expect(tiles(page).nth(2).locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  await expect(tiles(page).first().locator('.ws-pos')).toHaveText('1');
  await ws(page).getByRole('button', { name: 'Remove three.pdf' }).click();
  await expect(tiles(page)).toHaveCount(0);
  await add(page, fx('pdf-render/rotations.pdf'));
  await expect(tiles(page)).toHaveCount(4);
  await expect(tiles(page).nth(3).locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  // A landscape page's picture is wider than it is tall.
  const size = await tiles(page).nth(1).locator('canvas').evaluate(c => [(c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height]);
  expect(size[0]).toBeGreaterThan(size[1]);
});
