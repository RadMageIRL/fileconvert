import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { formatBytes, LIMITS } from '../../src/core/limits';
import { estimate, type MemoryEngine, type PdfWork } from '../../src/core/pdfmemory';
import { addFiles, fx, openApp, row, tempDir, unexpectedViolations } from './helpers';
import { forms, giantArray, pictures } from './pdfgen';

// The memory admission check for PDF work (src/core/pdfmemory.ts) in each browser: every PDF task is refused before
// it starts when its estimate passes what the browser can give one task, with the reason, and the page stays usable.
// Device memory is forced low with a stand-in for navigator.deviceMemory; "no device memory reported" is how Firefox and
// WebKit are, and is forced in Chrome; a small JavaScript heap is a stand-in for performance.memory. The real heap cap
// (Chrome started with a small heap) is in large-pdf.spec.ts.

const MB = 1048576;
const ws = (page: Page) => page.locator('#workspace');
const item = (page: Page, name: string) => ws(page).locator('.ws-item').filter({ has: page.locator('.job-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });

async function openTool(page: Page, id: string): Promise<void> {
  await page.evaluate(t => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool(t), id);
  await expect(ws(page).locator('h2')).toBeVisible();
}

async function add(page: Page, paths: string[]): Promise<void> {
  await ws(page).locator('input[type=file]').setInputFiles(paths);
  await expect(ws(page).locator('.ws-item.checking')).toHaveCount(0, { timeout: 90_000 });
}

/** Stand-ins for what the browser reports: device memory in GB (null: not reported), and the JavaScript heap limit. */
async function device(page: Page, gb: number | null, heapLimit?: number): Promise<void> {
  await page.addInitScript(([g, h]) => {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => g ?? undefined, configurable: true });
    if (h) Object.defineProperty(Performance.prototype, 'memory', { get: () => ({ jsHeapSizeLimit: h, totalJSHeapSize: 0, usedJSHeapSize: 0 }), configurable: true });
  }, [gb, heapLimit ?? 0] as const);
}

const write = (name: string, data: Buffer) => { const p = `${tempDir()}/${name}`; writeFileSync(p, data); return p; };
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The measurements this browser's engine gets (Firefox has its own; Chrome and Edge report their heap limit), and a
 * forced device memory that leaves 128 MB above the estimate's base for one task: 512 MB in Chrome, 768 MB in Firefox.
 * `allowed` is the allowance as a refusal words it, from "the" to the closing parenthesis.
 */
function low(browserName: string): { engine: MemoryEngine; gb: number; allowed: string } {
  const engine: MemoryEngine = browserName === 'firefox' ? 'gecko' : 'v8';
  const gb = (2 * (LIMITS.pdfEditMemory[engine].base + 128 * MB)) / (1024 * MB);
  const reported = gb >= 1 ? `${gb} GB` : `${gb * 1024} MB`;
  return { engine, gb, allowed: `the ${formatBytes(gb * 512 * MB)} FileConvert lets one task use on this device (half of the ${reported} of memory the browser reports)` };
}

test('the allowance in this browser: half the device memory it reports, or 2 GB on a computer where it reports none', async ({ page, browserName }, info) => {
  await openApp(page);
  await openTool(page, 'merge-pdf');
  const seen = await page.evaluate(() => ({
    device: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    heap: (performance as Performance & { memory?: { jsHeapSizeLimit: number } }).memory?.jsHeapSizeLimit ?? null,
  }));
  // Chrome and Edge report device memory (rounded down to a power of two) and their heap limit; Firefox does not.
  if (browserName === 'chromium') { expect(seen.device).toBeGreaterThan(0); expect(seen.heap).toBeGreaterThan(0); } else { expect(seen.device).toBeNull(); expect(seen.heap).toBeNull(); }
  const allowance = seen.device ? Math.min(4096, seen.device * 512) * MB : (info.project.use.isMobile ? 1024 : 2048) * MB;
  // The tool's own check with stand-ins for two checked files: the largest that fit is accepted, a byte more is not.
  // Their size is all bytes (no objects to parse), so the heap limit Chrome and Edge also have does not decide here.
  const check = (bytes: number) => page.evaluate(b => {
    const app = (window as unknown as { __fileconvert: { workspace: { def: { check(i: unknown[], v: unknown): string | null } } } }).__fileconvert;
    const one = { file: { size: 1 }, pages: 1, work: { bytes: b, parsed: 0, objects: 0, pages: 1 } };
    return app.workspace.def.check([one, one], {});
  }, bytes);
  const w = (bytes: number): PdfWork => ({ bytes, parsed: 0, objects: 0, pages: 1 });
  let lo = 0, hi = 1024 * MB;
  const engine: MemoryEngine = seen.heap ? 'v8' : browserName === 'firefox' ? 'gecko' : 'other';
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (estimate([w(mid), w(mid)], 'edit', { engine }).total <= allowance) lo = mid; else hi = mid; }
  expect(await check(lo)).toBeNull();
  expect(await check(hi)).toMatch(/^Together these files need about .* of memory, more than the .* FileConvert lets one task use .*, so it was not started\. Merge fewer files at a time\.( Chrome and Edge say how much memory the device has, so FileConvert may allow more there\.)?$/);
});

test('on a device that reports little memory: a large PDF is refused as it is added, with the reason; a smaller one then works', async ({ page, browserName }) => {
  test.slow();
  const L = low(browserName);
  await device(page, L.gb);
  await openApp(page);
  await openTool(page, 'rotate-pdf');
  const big = write('scan-40mb.pdf', pictures(2, 20));
  await add(page, [big]);
  await expect(item(page, 'scan-40mb.pdf').locator('.job-error')).toHaveText(new RegExp(`^This PDF needs about \\d+ MB of memory, more than ${esc(L.allowed)}, so it was not started\\.$`));
  await expect(ws(page).getByRole('button', { name: 'Rotate the pages' })).toBeDisabled();
  await ws(page).getByRole('button', { name: 'Remove scan-40mb.pdf' }).click();
  await add(page, [fx('pdf/merge-a.pdf')]);
  await ws(page).getByRole('button', { name: 'Rotate the pages' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
});

test('on a device that reports little memory: files that fit one by one but not together are not merged; taking one out lets it run', async ({ page, browserName }) => {
  test.slow();
  const L = low(browserName);
  await device(page, L.gb);
  await openApp(page);
  await openTool(page, 'merge-pdf');
  // 16 MB each: one fits in the 128 MB above the base, two do not.
  const a = write('scan-a.pdf', pictures(1, 16));
  const b = write('scan-b.pdf', pictures(1, 16));
  await add(page, [a, b, fx('pdf/merge-a.pdf')]);
  await expect(ws(page).locator('.ws-item .job-error')).toHaveCount(0);
  await expect(ws(page).locator('.ws-why')).toHaveText(new RegExp(`^Together these files need about \\d+ MB of memory, more than ${esc(L.allowed)}, so it was not started\\. Merge fewer files at a time\\.$`));
  await expect(ws(page).getByRole('button', { name: 'Merge PDFs' })).toBeDisabled();
  await ws(page).getByRole('button', { name: 'Remove scan-b.pdf' }).click();
  await ws(page).getByRole('button', { name: 'Merge PDFs' }).click();
  await expect(ws(page).locator('.ws-state.done')).toHaveText(/^Done: 1 file/, { timeout: 60_000 });
});

test('where no device memory is reported, a phone or tablet is assumed to have 2 GB and a computer 4 GB, never more', async ({ page }, info) => {
  await device(page, null);
  await openApp(page);
  await openTool(page, 'merge-pdf');
  const why = await page.evaluate(() => {
    const app = (window as unknown as { __fileconvert: { workspace: { def: { check(i: unknown[], v: unknown): string | null } } } }).__fileconvert;
    const one = { file: { size: 1 }, pages: 1, work: { bytes: 300 * 1048576, parsed: 0, objects: 0, pages: 1 } };
    return app.workspace.def.check([one, one], {});
  });
  expect(why).toMatch(info.project.use.isMobile
    ? /more than the 1\.00 GB FileConvert lets one task use on a phone or tablet whose browser does not say how much memory it has/
    : /more than the 2\.00 GB FileConvert lets one task use in a browser that does not say how much memory the device has/);
});

test('a 100 KB PDF whose object stream would become 50 million objects is refused as it is added, at once, in every browser', async ({ page }) => {
  const w = await openApp(page);
  await openTool(page, 'delete-pdf-pages');
  const bomb = write('tiny-bomb.pdf', giantArray(50));
  const t = Date.now();
  await add(page, [bomb]);
  await expect(item(page, 'tiny-bomb.pdf').locator('.job-error')).toHaveText(/^This PDF needs about [\d.]+ GB (of memory|of the browser's working memory for its objects and pages), more than the .*, so it was not started\.( Chrome and Edge say how much memory the device has, so FileConvert may allow more there\.)?$/);
  expect(Date.now() - t).toBeLessThan(30_000);
  // The page answers, and the next file is checked and edited as usual.
  await ws(page).getByRole('button', { name: 'Remove tiny-bomb.pdf' }).click();
  await add(page, [fx('pdf/merge-a.pdf')]);
  await ws(page).locator('[data-key="opt-pages"]').fill('2');
  await ws(page).locator('[data-key="opt-pages"]').press('Tab');
  await ws(page).getByRole('button', { name: 'Delete the pages' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('a small JavaScript heap: a form-heavy PDF that fits the device is refused for the heap, with the reason', async ({ page }) => {
  test.slow();
  // Chrome started with a 96 MB heap reports 212 MB as its limit.
  await device(page, 8, 212_000_000);
  await openApp(page);
  await openTool(page, 'rotate-pdf');
  const f = write('forms-300.pdf', forms(300));
  await add(page, [f]);
  await expect(item(page, 'forms-300.pdf').locator('.job-error')).toHaveText(/^This PDF needs about [\d.]+ MB of the browser's working memory for its objects and pages, more than the [\d.]+ MB this browser gives one task, so it was not started\.$/);
  await ws(page).getByRole('button', { name: 'Remove forms-300.pdf' }).click();
  await add(page, [fx('pdf/merge-a.pdf')]);
  await ws(page).getByRole('button', { name: 'Rotate the pages' }).click();
  await expect(ws(page).locator('.ws-state.done')).toBeVisible({ timeout: 60_000 });
});

test('a split whose parts would each copy a shared picture is refused before anything is copied; fewer parts then work', async ({ page, browserName }) => {
  test.slow();
  // 60 pages that all draw one 3 MB picture: split into single pages, the parts hold 180 MB together.
  const L = low(browserName);
  await device(page, L.gb);
  await openApp(page);
  await openTool(page, 'split-pdf');
  const shared = write('shared-picture.pdf', pictures(60, 3, true));
  await add(page, [shared]);
  await expect(item(page, 'shared-picture.pdf').locator('.job-error')).toHaveCount(0);
  await ws(page).locator('[data-key="opt-mode"]').selectOption('each');
  await ws(page).getByRole('button', { name: 'Split the PDF' }).click();
  await expect(ws(page).locator('.ws-run .job-error')).toHaveText(new RegExp(`^Splitting it this way makes 60 files that hold about \\d+ MB together, since each gets its own copy of the pictures and fonts its pages share; that needs about \\d+ MB of memory, more than ${esc(L.allowed)}, so it was not started\\. Split it into fewer parts\\.$`), { timeout: 60_000 });
  await ws(page).locator('[data-key="opt-mode"]').selectOption('ranges');
  await ws(page).locator('[data-key="opt-ranges"]').fill('1-30, 31-60');
  await ws(page).locator('[data-key="opt-ranges"]').press('Tab');
  await ws(page).getByRole('button', { name: 'Split the PDF' }).click();
  await expect(ws(page).locator('.ws-state.done')).toHaveText(/^Done: 2 files/, { timeout: 60_000 });
});

test('overlapping split ranges that copy the whole PDF many times are refused before the split starts', async ({ page, browserName }) => {
  const L = low(browserName);
  await device(page, L.gb);
  await openApp(page);
  await openTool(page, 'split-pdf');
  const p = write('scan-10mb.pdf', pictures(2, 5));
  await add(page, [p]);
  await ws(page).locator('[data-key="opt-ranges"]').fill(Array.from({ length: 40 }, () => '1-2').join(', '));
  await ws(page).locator('[data-key="opt-ranges"]').press('Tab');
  await expect(ws(page).locator('.ws-why')).toHaveText(new RegExp(`^Splitting it this way makes 40 files, which needs about [\\d.]+ (MB|GB) of memory, more than ${esc(L.allowed)}, so it was not started\\. Split it into fewer parts\\.$`));
  await ws(page).locator('[data-key="opt-ranges"]').fill('1, 2');
  await ws(page).locator('[data-key="opt-ranges"]').press('Tab');
  await expect(ws(page).getByRole('button', { name: 'Split the PDF' })).toBeEnabled();
});

test('PDF to TXT: a PDF too large for the device is refused before pdf.js reads it; a small one converts', async ({ page, browserName }) => {
  test.slow();
  const L = low(browserName);
  await device(page, L.gb);
  await openApp(page);
  const big = write('text-and-scan.pdf', pictures(3, 20));
  await addFiles(page, [big, fx('document/sample.pdf')]);
  for (const name of ['text-and-scan.pdf', 'sample.pdf']) {
    await expect(row(page, name)).toHaveClass(/\bready\b/, { timeout: 60_000 });
    await row(page, name).getByRole('combobox', { name: /^Convert .* to$/ }).selectOption({ label: 'TXT' });
    await row(page, name).getByRole('button', { name: /^(Convert|Convert to .+)$/ }).click();
  }
  await expect(row(page, 'text-and-scan.pdf')).toHaveClass(/\bfailed\b/, { timeout: 60_000 });
  await expect(row(page, 'text-and-scan.pdf').locator('.job-error')).toHaveText(new RegExp(`^Reading the text of this PDF needs about \\d+ MB of memory, more than ${esc(L.allowed)}, so it was not started\\.$`));
  await expect(row(page, 'sample.pdf')).toHaveClass(/\bdone\b/, { timeout: 60_000 });
});

test('the worker holds a task to the allowance itself, file by file, even when the page did not check first', async ({ page }) => {
  test.slow();
  await openApp(page);
  const a = pictures(1, 15).toString('base64');
  const run = (task: string, payload: Record<string, unknown>, files: string[]) => page.evaluate(async ([t, p, list]) => {
    const app = (window as unknown as { __fileconvert: { engines: { pdf: { run<T>(task: string, payload: unknown): Promise<T> } } } }).__fileconvert;
    const blob = (b64: string) => new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]);
    const allowance = { total: 256 * 1048576, heap: null, basis: 'device', engine: 'v8', deviceGB: 0.5 };
    const body = t === 'merge' ? { files: list.map((b, i) => ({ name: `f${i}.pdf`, file: blob(b) })), allowance } : { ...p, file: blob(list[0]), allowance };
    try { await app.engines.pdf.run(t, body); return 'ran'; } catch (e) { return (e as Error).message; }
  }, [task, payload, files] as const);
  expect(await run('merge', {}, [a, a])).toMatch(/^Together these files need about \d+ MB of memory, more than the 256 MB FileConvert lets one task use on this device/);
  expect(await run('merge', {}, [a])).toBe('ran');
  const big = pictures(2, 30).toString('base64');
  expect(await run('merge', {}, [big])).toMatch(/^f0\.pdf: This PDF needs about \d+ MB of memory/);
  // The size is checked before the file is read: a 60 MB file that also holds a decompression bomb is refused for its
  // memory, not by the guard, which would have had to read it first.
  const bombed = Buffer.concat([pictures(2, 30), readFileSync(fx('pdf/bomb-content.pdf'))]).toString('base64');
  expect(await run('rotate', { pages: [0], by: 90 }, [bombed])).toMatch(/^This PDF needs about \d+ MB of memory, more than the 256 MB/);
  // A 60 MB file is refused on its size before it is read; a 10 KB file that holds 5 million numbers after the guard
  // has counted them, before the editing library reads it.
  const small = giantArray(5).toString('base64');
  for (const [task, payload] of [['rotate', { pages: [0], by: 90 }], ['keepPages', { order: [0] }], ['split', { name: 'x.pdf', parts: [[0]] }], ['inspect', {}], ['scan', {}]] as const) {
    expect(await run(task, payload, [big]), task).toMatch(/needs about \d+ MB of memory, more than the 256 MB/);
    expect(await run(task, payload, [small]), task).toMatch(/needs about \d+ MB of memory, more than the 256 MB/);
  }
});
