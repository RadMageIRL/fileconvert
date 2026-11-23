import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fx, openApp, PYTHON, pyRead, save, tempDir, unexpectedViolations, writeTemp } from './helpers';

// Split, extract, delete, reorder and rotate (v0.2.0, Phase 2) in the browser: each tool in the workspace, the work in
// the PDF worker, every result read by qpdf, pypdf and PDFium (tests/e2e/readers.py), which share no code with
// FileConvert, and compared with the same readers' view of the source.

interface Annot { subtype: string; page?: number | string; uri?: string; field?: string }
interface Outline { title: string; page?: number | string; uri?: string; children?: Outline[] }
interface Deep {
  qpdf: { ok: boolean; out: string }; pages: Array<{ mediabox: number[]; cropbox: number[]; rotate: number; text: string; annots: Annot[] }>;
  pageObjects: number; outline: Outline[]; dests: Record<string, number | string>; fields: Record<string, { value: string | null }>;
  catalog: string[]; renders: string[]; formRenders: string[]; decompressed: string;
}

const sources = new Map<string, Deep>();
const source = (f: string) => { if (!sources.has(f)) sources.set(f, pyRead<Deep>('pdfdeep', fx(`pdf/${f}`))); return sources.get(f)!; };
const pick = <T>(list: T[], idx: number[]) => idx.map(i => list[i]);
const tree = (items: Outline[]): unknown[] => items.map(o => [o.title, o.page ?? o.uri ?? null, ...(o.children ? [tree(o.children)] : [])]);

const ws = (page: Page) => page.locator('#workspace');
const pdfPool = (page: Page) => page.evaluate(() => (window as unknown as { __fileconvert: { engines: { pdf: { active: number } } } }).__fileconvert.engines.pdf.active);

async function openTool(page: Page, id: string, heading: string): Promise<void> {
  await page.evaluate(t => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool(t), id);
  await expect(page.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
}

async function add(page: Page, paths: string[]): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(paths);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

/** Runs the tool and saves every result, through the ZIP when there are several. */
async function runAndSave(page: Page, info: TestInfo, action: string): Promise<Array<{ name: string; path: string }>> {
  await ws(page).getByRole('button', { name: action }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 120_000 });
  const buttons = ws(page).locator('.ws-out button', { hasText: /^Download (?!all)/ });
  const n = await buttons.count();
  if (n === 1) {
    const [dl] = await Promise.all([page.waitForEvent('download'), buttons.first().click()]);
    const { path, filename } = await save(dl, info);
    return [{ name: filename, path }];
  }
  const [dl] = await Promise.all([page.waitForEvent('download'), ws(page).getByRole('button', { name: `Download all (ZIP, ${n})` }).click()]);
  const { path } = await save(dl, info);
  const { unzipSync } = await import('fflate');
  const dir = tempDir();
  return Object.entries(unzipSync(new Uint8Array(readFileSync(path)))).map(([name, data]) => ({ name, path: writeTemp(dir, name, data) }));
}

test('split by page ranges: overlapping ranges, one file each in a ZIP, each with only what belongs to its pages', async ({ page }, info) => {
  test.slow();
  const w = await openApp(page);
  await openTool(page, 'split-pdf', 'Split a PDF');
  await add(page, [fx('pdf/merge-a.pdf')]);
  await expect(ws(page).locator('.ws-item .job-info')).toHaveText(/, 3 pages$/);
  const ranges = ws(page).getByLabel('Page ranges, one file each');
  await expect(ws(page).getByLabel('Pages in each file')).toBeHidden();
  for (const [text, why] of [
    ['3-2', '"3-2" goes backwards; write it from low to high, as 2-3.'],
    ['7-3', 'There is no page 7; the PDF has 3 pages.'],
    ['1-4', 'There is no page 4; the PDF has 3 pages.'],
    ['1-3', 'That range is the whole PDF; give at least two ranges, or a smaller one.'],
    ['two', '"two" is not a page or a range of pages; write pages like 4, or ranges like 2-5 or 10-.'],
  ]) {
    await ranges.fill(text);
    await ranges.press('Tab');
    await expect(ws(page).locator('.ws-why')).toHaveText(why);
  }
  await ranges.fill('1-2, 2-3');
  await ranges.press('Tab');
  const files = await runAndSave(page, info, 'Split the PDF');
  expect(files.map(f => f.name).sort()).toEqual(['merge-a-p1-2.pdf', 'merge-a-p2-3.pdf']);
  const a = source('merge-a.pdf');
  const [one, two] = ['merge-a-p1-2.pdf', 'merge-a-p2-3.pdf'].map(n => pyRead<Deep>('pdfdeep', files.find(f => f.name === n)!.path));
  for (const [d, idx] of [[one, [0, 1]], [two, [1, 2]]] as const) {
    expect(d.qpdf.ok, d.qpdf.out).toBe(true);
    expect(d.pageObjects).toBe(2);
    expect(d.renders).toEqual(pick(a.renders, [...idx]));
    expect(d.formRenders).toEqual(pick(a.formRenders, [...idx]));
  }
  // Bookmarks and named destinations only where their pages are; the first file's link to page 3 is gone.
  expect(tree(one.outline)).toEqual([['Chapter A1', 0, [['Section A1.1', 0]]], ['Chapter A2', 1], ['Web link', 'https://example.com/']]);
  expect(tree(two.outline)).toEqual([['Chapter A2', 0], ['Closed A3', 1, [['A3 child', 1]]], ['Web link', 'https://example.com/']]);
  expect(one.dests).toEqual({ 'a-sec': 0, 'a-two': 1 });
  expect(two.dests).toEqual({ 'a-two': 0, shared: 1 });
  expect(one.pages[0].annots.map(x => x.uri ?? x.page)).toEqual([1, 'https://example.com/alpha']);
  expect(Object.keys(two.fields).sort()).toEqual(['agree', 'choice', 'color', 'name']);
  expect(two.fields.choice.value).toBe('/B');
  await expect(ws(page).locator('.ws-out > .job-notes li')).toContainText(['Removed because they went only to pages in other files: 1 link, 4 bookmarks and 2 named destinations.']);
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('split every N pages and into single pages: predictable names, nothing of other pages in a part', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page, 'split-pdf', 'Split a PDF');
  await add(page, [fx('pdf/markers.pdf')]);
  await ws(page).locator('[data-key="opt-mode"]').selectOption('every');
  await expect(ws(page).getByLabel('Page ranges, one file each')).toBeHidden();
  await ws(page).getByLabel('Pages in each file').fill('2');
  await ws(page).getByLabel('Pages in each file').press('Tab');
  const files = await runAndSave(page, info, 'Split the PDF');
  expect(files.map(f => f.name).sort()).toEqual(['markers-p1-2.pdf', 'markers-p3-4.pdf']);
  const m = source('markers.pdf');
  const later = pyRead<Deep>('pdfdeep', files.find(f => f.name === 'markers-p3-4.pdf')!.path);
  expect(later.renders).toEqual(pick(m.renders, [2, 3]));
  // Page 2's marks, in every place a page's content can hide, are not in the part without it.
  const everything = readFileSync(later.decompressed);
  for (const s of ['PAGE-TWO-SECRET', 'OLD-REVISION-SECRET', 'ANNOT-SECRET', 'FIELD-SECRET', 'OUTLINE-SECRET', 'TAG-SECRET', 'THREAD-SECRET', 'PIECE-SECRET', 'secret-two']) expect(everything.includes(s), s).toBe(false);
  expect(everything.includes(readFileSync(fx('pdf/markers-secret-pixels.bin')).subarray(1000, 1064))).toBe(false);
  // Single pages: merge-b's second page keeps its rotation and crop box; the hidden layer stays hidden (same render).
  await ws(page).getByRole('button', { name: 'Remove markers.pdf' }).click();
  await add(page, [fx('pdf/merge-b.pdf')]);
  await ws(page).locator('[data-key="opt-mode"]').selectOption('each');
  const singles = await runAndSave(page, info, 'Split the PDF');
  expect(singles.map(f => f.name).sort()).toEqual(['merge-b-p1.pdf', 'merge-b-p2.pdf']);
  const b = source('merge-b.pdf');
  const [p1, p2] = ['merge-b-p1.pdf', 'merge-b-p2.pdf'].map(n => pyRead<Deep>('pdfdeep', singles.find(f => f.name === n)!.path));
  expect([...p1.renders, ...p2.renders]).toEqual(b.renders);
  expect([p2.pages[0].rotate, p2.pages[0].cropbox]).toEqual([90, [0, 0, 600, 780]]);
  expect(Object.keys(p1.fields).sort()).toEqual(['address.city', 'address.street', 'agree', 'name']);
  expect(Object.keys(p2.fields)).toEqual([]);
});

test('extract pages in the order written: the pages left out leave nothing behind', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page, 'extract-pdf-pages', 'Extract pages from a PDF');
  await add(page, [fx('pdf/merge-a.pdf')]);
  const pages = ws(page).getByLabel('Pages to extract');
  // The hint is the field's description, not part of its name.
  await expect(pages).toHaveAccessibleName('Pages to extract');
  await expect(pages).toHaveAccessibleDescription('In the order you list them; each page once. 10- means page 10 to the end.');
  await pages.fill('1-3, 2');
  await pages.press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveText('Page 2 is listed more than once; list each page once.');
  await pages.fill('3, 1');
  await pages.press('Tab');
  const [out] = await runAndSave(page, info, 'Extract the pages');
  expect(out.name).toBe('merge-a-extracted.pdf');
  const d = pyRead<Deep>('pdfdeep', out.path);
  const a = source('merge-a.pdf');
  expect(d.qpdf.ok).toBe(true);
  expect(d.renders).toEqual(pick(a.renders, [2, 0]));
  expect(d.pageObjects).toBe(2);
  expect(tree(d.outline)).toEqual([['Chapter A1', 1, [['Section A1.1', 1]]], ['Closed A3', 0, [['A3 child', 0]]], ['Web link', 'https://example.com/']]);
  expect(Object.keys(d.fields)).toEqual(['choice']);
  expect(readFileSync(d.decompressed).includes('Alpha page two')).toBe(false);
  await expect(ws(page).locator('.ws-file .job-info')).toHaveText(/^Pages 3, 1, /);
});

test('delete pages: nothing of them is left, the pages that stay draw exactly as before, and deleting every page is not offered', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page, 'delete-pdf-pages', 'Delete pages from a PDF');
  await add(page, [fx('pdf/markers.pdf')]);
  const pages = ws(page).getByLabel('Pages to delete');
  await pages.fill('1-4');
  await pages.press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveText('That is every page; at least one page has to stay.');
  await expect(ws(page).getByRole('button', { name: 'Delete the pages' })).toBeDisabled();
  await pages.fill('2');
  await pages.press('Tab');
  const [out] = await runAndSave(page, info, 'Delete the pages');
  expect(out.name).toBe('markers-pages-removed.pdf');
  const d = pyRead<Deep>('pdfdeep', out.path);
  expect(d.qpdf.ok).toBe(true);
  expect(d.renders).toEqual(pick(source('markers.pdf').renders, [0, 2, 3]));
  const everything = readFileSync(d.decompressed);
  for (const s of ['PAGE-TWO-SECRET', 'OLD-REVISION-SECRET', 'ANNOT-SECRET', 'FIELD-SECRET', 'OUTLINE-SECRET', 'TAG-SECRET', 'THREAD-SECRET', 'PIECE-SECRET', 'secret-two']) expect(everything.includes(s), s).toBe(false);
  await expect(ws(page).locator('.ws-out > .job-notes li').last()).toHaveText('This removes pages; it is not redaction. The pages that stay, the document information and any attachments are not searched or changed.');
  await expect(ws(page).locator('.ws-file .ws-details li')).toHaveText(['Removed with the pages, since they went only to them: 1 link, 1 bookmark, 1 named destination and 1 form field.']);
});

test('reorder pages with the keyboard, by dragging, or as text: links, bookmarks and destinations follow their pages', async ({ page, browserName }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page, 'organize-pdf', 'Reorder PDF pages');
  await add(page, [fx('pdf/merge-a.pdf')]);
  const rows = ws(page).locator('.ws-page .ws-page-name');
  await expect(rows).toHaveText(['Page 1', 'Page 2', 'Page 3']);
  await expect(ws(page).locator('.ws-why')).toHaveText('The pages are in their first order; move some to reorder them.');
  // Keyboard: page 3 up twice, the focus staying on it.
  await ws(page).getByRole('button', { name: 'Move page 3 up' }).focus();
  await page.keyboard.press('Enter');
  await expect(ws(page).getByRole('button', { name: 'Move page 3 up' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText(['Page 3', 'Page 1', 'Page 2']);
  // At the top its Up button is off, so the focus goes to its Down button, not back to the start of the page.
  await expect(ws(page).getByRole('button', { name: 'Move page 3 down' })).toBeFocused();
  await expect(ws(page).getByLabel('New page order')).toHaveValue('3, 1-2');
  // Text: the accessible way to set any order at once.
  const text = ws(page).getByLabel('New page order');
  await text.fill('2, 2, 1');
  await text.press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveText('Page 2 is listed more than once; list each page once.');
  await text.fill('2, 3, 1');
  await text.press('Tab');
  await expect(rows).toHaveText(['Page 2', 'Page 3', 'Page 1']);
  // Dragging (a pointer and HTML drag and drop): page 1 to the top.
  if (browserName !== 'webkit' && !test.info().project.use.hasTouch) {
    await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 10, y: 2 } });
    await expect(rows).toHaveText(['Page 1', 'Page 2', 'Page 3']);
    // And downward: the first page below the last.
    const box = (await rows.nth(2).boundingBox())!;
    await rows.nth(0).dragTo(rows.nth(2), { targetPosition: { x: 10, y: box.height - 2 } });
    await expect(rows).toHaveText(['Page 2', 'Page 3', 'Page 1']);
    await text.fill('2, 3, 1');
    await text.press('Tab');
  }
  const [out] = await runAndSave(page, info, 'Reorder the pages');
  expect(out.name).toBe('merge-a-reordered.pdf');
  const d = pyRead<Deep>('pdfdeep', out.path);
  const a = source('merge-a.pdf');
  expect(d.qpdf.ok).toBe(true);
  expect(d.renders).toEqual(pick(a.renders, [1, 2, 0]));
  expect(d.pageObjects).toBe(3);
  expect(tree(d.outline)).toEqual([['Chapter A1', 2, [['Section A1.1', 2]]], ['Chapter A2', 0], ['Closed A3', 1, [['A3 child', 1]]], ['Web link', 'https://example.com/']]);
  expect(d.dests).toEqual({ 'a-sec': 2, 'a-two': 0, shared: 1 });
  expect(d.pages[2].annots.filter(x => x.subtype === '/Link').map(x => x.uri ?? x.page)).toEqual([1, 0, 'https://example.com/alpha']);
  expect(Object.keys(d.fields).sort()).toEqual(['agree', 'choice', 'color', 'name']);
  // Another file starts from its own pages, in their order.
  await ws(page).getByRole('button', { name: 'Remove merge-a.pdf' }).click();
  await add(page, [fx('pdf/merge-b.pdf')]);
  await expect(rows).toHaveText(['Page 1', 'Page 2']);
  await expect(text).toHaveValue('1-2');
});

test('rotate every page or some, either way: PDFium draws each page as it draws the source page turned', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page, 'rotate-pdf', 'Rotate PDF pages');
  await add(page, [fx('pdf/merge-a.pdf')]);
  const turns = pyRead<string[][]>('pdfturns', fx('pdf/merge-a.pdf'));
  await ws(page).locator('[data-key="opt-by"]').selectOption('270');
  const [all] = await runAndSave(page, info, 'Rotate the pages');
  expect(all.name).toBe('merge-a-rotated.pdf');
  const d = pyRead<Deep>('pdfdeep', all.path);
  expect(d.qpdf.ok).toBe(true);
  expect(d.pages.map(p => p.rotate)).toEqual([270, 270, 90]);
  expect(d.pages.map(p => p.mediabox)).toEqual(source('merge-a.pdf').pages.map(p => p.mediabox));
  expect(d.renders).toEqual(turns.map(t => t[3]));
  expect(Object.keys(d.fields).sort()).toEqual(['agree', 'choice', 'color', 'name']);
  expect(d.pages[0].annots.map(x => x.uri ?? x.page)).toEqual([2, 1, 'https://example.com/alpha']);
  // Page 2 alone, clockwise.
  await ws(page).locator('[data-key="opt-by"]').selectOption('90');
  const which = ws(page).getByLabel('Pages to turn');
  await which.fill('2');
  await which.press('Tab');
  const [one] = await runAndSave(page, info, 'Rotate the pages');
  const e = pyRead<Deep>('pdfdeep', one.path);
  expect(e.pages.map(p => p.rotate)).toEqual([0, 90, 180]);
  expect(e.renders).toEqual([turns[0][0], turns[1][1], turns[2][0]]);
  await expect(ws(page).locator('.ws-file .job-info')).toHaveText(/^Page 2 turned 90 degrees clockwise, /);
});

test('a signed PDF has to be accepted, encrypted and hostile PDFs are refused, and a canceled split frees the worker', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await openTool(page, 'split-pdf', 'Split a PDF');
  await add(page, [fx('pdf/encrypted-owner.pdf')]);
  await expect(ws(page).locator('.ws-item .job-error')).toHaveText(/^This PDF is encrypted, so FileConvert does not open it/);
  await ws(page).getByRole('button', { name: 'Remove encrypted-owner.pdf' }).click();
  await add(page, [fx('pdf/bomb-objstm.pdf')]);
  await expect(ws(page).locator('.ws-item .job-error')).toContainText('object stream that expands past 256 MB');
  await ws(page).getByRole('button', { name: 'Remove bomb-objstm.pdf' }).click();
  await add(page, [fx('pdf/signed.pdf')]);
  await ws(page).locator('[data-key="opt-mode"]').selectOption('each');
  await expect(ws(page).locator('.ws-confirm li')).toHaveText(/^signed\.pdf is digitally signed\. Splitting changes it, so its signature will no longer be valid/);
  await expect(ws(page).getByRole('button', { name: 'Split the PDF' })).toBeDisabled();
  await ws(page).getByLabel('Split anyway; the signature will no longer be valid').check();
  const parts = await runAndSave(page, info, 'Split the PDF');
  expect(parts).toHaveLength(4);
  await expect(ws(page).locator('.ws-out > .job-notes li')).toContainText(['The digital signature is no longer valid in the new files. The signature field and how it looks are kept where its page is.']);
  const first = pyRead<Deep>('pdfdeep', parts.find(p => p.name === 'signed-p1.pdf')!.path);
  expect(first.fields.Signature1.value).toBe('signature');
  // A slow file: canceled while the split checks it, the worker stops, and the next split works.
  await ws(page).getByRole('button', { name: 'Remove signed.pdf' }).click();
  const slow = `${tempDir()}/slow.pdf`;
  execFileSync(PYTHON, ['-I', '-c', [
    'import sys, zlib',
    'z = zlib.compress(bytes(200 << 20), 9)',
    'objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>", 2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",',
    '        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 5 0 R 6 0 R 7 0 R] >>"}',
    'for n in range(4, 8): objs[n] = b"<< /Length %d /Filter /FlateDecode >>\\nstream\\n" % len(z) + z + b"\\nendstream"',
    'out = b"%PDF-1.7\\n" + b"".join(b"%d 0 obj\\n" % k + v + b"\\nendobj\\n" for k, v in objs.items()) + b"trailer\\n<< /Root 1 0 R >>\\n%%EOF\\n"',
    'open(sys.argv[1], "wb").write(out)',
  ].join('\n'), slow]);
  await add(page, [slow]);
  await ws(page).getByRole('button', { name: 'Split the PDF' }).click();
  await expect(ws(page).locator('.ws-run .job-info')).toContainText('Checking the PDF');
  await ws(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(ws(page).locator('.ws-state.canceled')).toHaveText('Canceled.');
  await expect.poll(() => pdfPool(page)).toBe(0);
  await ws(page).getByRole('button', { name: 'Remove slow.pdf' }).click();
  await add(page, [fx('pdf/merge-b.pdf')]);
  expect(await runAndSave(page, info, 'Split the PDF')).toHaveLength(2);
});

test('at 320 pixels the page tools fit, and pages reorder by touch or click', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page);
  await openTool(page, 'organize-pdf', 'Reorder PDF pages');
  await add(page, [fx('pdf/merge-a.pdf')]);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const down = ws(page).getByRole('button', { name: 'Move page 1 down' });
  if (info.project.use.hasTouch) await down.tap(); else await down.click();
  await expect(ws(page).locator('.ws-page .ws-page-name')).toHaveText(['Page 2', 'Page 1', 'Page 3']);
  expect((await down.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  await runAndSave(page, info, 'Reorder the pages');
  expect(await overflow()).toBeLessThanOrEqual(0);
  for (const [id, heading] of [['split-pdf', 'Split a PDF'], ['rotate-pdf', 'Rotate PDF pages']]) {
    await openTool(page, id, heading);
    await add(page, [fx('pdf/merge-a.pdf')]);
    expect(await overflow(), id).toBeLessThanOrEqual(0);
  }
});
