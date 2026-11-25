// PDF tools on large files of different structures, run on request: npx playwright test --project large
// Each run is a fresh Chrome with its own profile (a normal, on-disk one), with the private memory of all its processes
// sampled; the input limit is not a peak ceiling, so what is measured here is the peak above the start. Inputs are
// generated into the system temp folder on first use.

import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PYTHON, openApp } from './helpers';

const DIR = join(tmpdir(), 'fileconvert-large');
mkdirSync(DIR, { recursive: true });
const REPORT = join('test-results', 'large-report.txt');
const MB = 1048576;

function record(line: string): void {
  mkdirSync('test-results', { recursive: true });
  appendFileSync(REPORT, line + '\n');
  console.log(line);
}

function make(name: string, script: string[]): string {
  const p = join(DIR, name);
  if (!existsSync(p)) execFileSync(PYTHON, ['-I', '-c', script.join('\n'), p], { timeout: 900_000 });
  return p;
}

/** A PDF writer for the generators: objects in order, a classic cross-reference table. */
const WRITER = [
  'def stream(d, extra=b""): return b"<< /Length %d%s >>\\nstream\\n" % (len(d), extra) + d + b"\\nendstream"',
  'def write(path, objs):',
  '    out = bytearray(b"%PDF-1.7\\n"); offs = {}',
  '    for k in sorted(objs): offs[k] = len(out); out += b"%d 0 obj\\n" % k + objs[k] + b"\\nendobj\\n"',
  '    x = len(out); size = max(objs) + 1',
  '    out += b"xref\\n0 %d\\n0000000000 65535 f \\n" % size + b"".join((b"%010d 00000 n \\n" % offs[k]) if k in offs else b"0000000000 65535 f \\n" for k in range(1, size))',
  '    out += b"trailer\\n<< /Size %d /Root 1 0 R >>\\nstartxref\\n%d\\n%%%%EOF\\n" % (size, x)',
  '    open(path, "wb").write(out)',
];

/** Image-heavy: 40 pages, each one 10 MB picture of incompressible pixels (about 400 MB). */
const pictures = () => make('pictures-400mb.pdf', [
  'import sys, zlib, random', ...WRITER,
  'rnd = random.Random(5); objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>"}; kids = []; n = 10',
  'for i in range(40):',
  '    objs[n + 2] = stream(zlib.compress(rnd.randbytes(1870 * 1870 * 3), 0), b" /Type /XObject /Subtype /Image /Width 1870 /Height 1870 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode")',
  '    objs[n + 1] = stream(b"q 595 0 0 595 0 120 cm /Im0 Do Q")',
  '    objs[n] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>" % (n + 2, n + 1)',
  '    kids.append(n); n += 3',
  'objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))',
  'write(sys.argv[1], objs)',
]);

/** Form-heavy: 500 pages with 40 text fields each (20,000 fields), every one with a value and an appearance. */
const forms = () => make('forms-20000.pdf', [
  'import sys', ...WRITER,
  'objs = {1: None, 3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}; kids = []; fields = []; n = 10',
  'for p in range(500):',
  '    page = n; n += 1; annots = []',
  '    objs[n] = stream(b"BT /F1 9 Tf 40 800 Td (Form page %d) Tj ET" % (p + 1)); content = n; n += 1',
  '    for f in range(40):',
  '        ap = n; n += 1; w = n; n += 1',
  '        y = 760 - f * 18',
  '        objs[ap] = stream(b"/Tx BMC BT /F1 9 Tf 2 4 Td (value %d-%d) Tj ET EMC" % (p, f), b" /Type /XObject /Subtype /Form /BBox [0 0 200 16] /Resources << /Font << /F1 3 0 R >> >>")',
  '        objs[w] = b"<< /FT /Tx /T (f%d_%d) /V (value %d-%d) /Type /Annot /Subtype /Widget /Rect [300 %d 500 %d] /P %d 0 R /F 4 /AP << /N %d 0 R >> >>" % (p, f, p, f, y, y + 16, page, ap)',
  '        annots.append(w); fields.append(w)',
  '    objs[page] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R /Annots [%s] >>" % (content, b" ".join(b"%d 0 R" % a for a in annots))',
  '    kids.append(page)',
  'objs[1] = b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [%s] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >> >>" % b" ".join(b"%d 0 R" % f for f in fields)',
  'objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))',
  'write(sys.argv[1], objs)',
]);

/** Many pages: 2,500 text pages, each with a link to the next and a bookmark (about 1.5 MB). */
const manyPages = () => make('pages-2500.pdf', [
  'import sys, zlib', ...WRITER,
  'objs = {3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}; kids = []; items = []; n = 10; N = 2500',
  'pages = [10 + 3 * i for i in range(N)]',
  'for i, page in enumerate(pages):',
  '    objs[page + 1] = stream(zlib.compress(b"BT /F1 24 Tf 72 700 Td (Page %d of many) Tj ET" % (i + 1)), b" /Filter /FlateDecode")',
  '    link = b"<< /Type /Annot /Subtype /Link /Rect [72 690 300 730] /Border [0 0 0] /Dest [%d 0 R /Fit] >>" % pages[(i + 1) % N]',
  '    objs[page + 2] = link',
  '    objs[page] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R /Annots [%d 0 R] >>" % (page + 1, page + 2)',
  '    kids.append(page)',
  'base = 10 + 3 * N',
  'for i in range(N):',
  '    links = b" /Prev %d 0 R" % (base + i - 1) if i else b""',
  '    links += b" /Next %d 0 R" % (base + i + 1) if i < N - 1 else b""',
  '    objs[base + i] = b"<< /Title (Page %d) /Parent 4 0 R /Dest [%d 0 R /Fit]%s >>" % (i + 1, pages[i], links)',
  'objs[4] = b"<< /Type /Outlines /First %d 0 R /Last %d 0 R /Count %d >>" % (base, base + N - 1, N)',
  'objs[1] = b"<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>"',
  'objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))',
  'write(sys.argv[1], objs)',
]);

async function browserMemory(profile: string): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const { execFile } = await import('node:child_process');
  const marker = profile.split(/[\\/]/).pop()!;
  const script = `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object -Property PrivatePageCount -Sum).Sum`;
  return new Promise(resolve => execFile('powershell', ['-NoProfile', '-Command', script], (err, out) => resolve(err ? 0 : Number(String(out).trim()) / MB)));
}

/** Runs one tool on some files in a fresh Chrome; measures the run (from the click to the result) and the memory. */
async function measure(baseURL: string | undefined, tool: string, files: string[], setup: (page: Page) => Promise<void>, action: string, args: string[] = []): Promise<{ secs: number; riseMB: number; outputs: number; lagMs: number; context: BrowserContext; page: Page }> {
  const profile = mkdtempSync(join(tmpdir(), 'fc-profile-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', baseURL, args });
  const page = context.pages()[0] ?? await context.newPage();
  await openApp(page);
  await page.evaluate(t => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool(t), tool);
  const ws = page.locator('#workspace');
  // From before the files are added: checking a file reads it too, and its worker stays a while afterwards.
  const base = await browserMemory(profile);
  let peak = base, sampling = true;
  const early = (async () => { while (sampling) { peak = Math.max(peak, await browserMemory(profile)); await new Promise(r => setTimeout(r, 400)); } })();
  await ws.locator('input[type=file]').setInputFiles(files);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 600_000 });
  await setup(page);
  sampling = false;
  await early;
  sampling = true;
  const sampler = (async () => { while (sampling) { peak = Math.max(peak, await browserMemory(profile)); await new Promise(r => setTimeout(r, 400)); } })();
  await page.evaluate(() => {
    const w = window as unknown as { __lag: number; __last: number };
    w.__lag = 0; w.__last = performance.now();
    window.setInterval(() => { const now = performance.now(); w.__lag = Math.max(w.__lag, now - w.__last - 50); w.__last = now; }, 50);
  });
  const t = Date.now();
  await ws.getByRole('button', { name: action }).click();
  await expect(ws.locator('.ws-state.done, .job-error')).toBeVisible({ timeout: 1_200_000 });
  const secs = (Date.now() - t) / 1000;
  sampling = false;
  await sampler;
  const lagMs = await page.evaluate(() => Math.round((window as unknown as { __lag: number }).__lag));
  const outputs = await ws.locator('.ws-out button', { hasText: /^Download (?!all)/ }).count();
  return { secs, riseMB: peak - base, outputs, lagMs, context, page };
}

const size = (files: string[]) => files.reduce((n, f) => n + statSync(f).size, 0) / MB;

test('memory by structure: image-heavy, form-heavy and many-page PDFs, merged and split', async ({ baseURL }) => {
  test.setTimeout(3_600_000);
  const cases: Array<{ what: string; tool: string; files: string[]; action: string; setup?: (p: Page) => Promise<void> }> = [
    { what: 'Merge, image-heavy (2 x 40 pages of 10 MB pictures)', tool: 'merge-pdf', files: [pictures(), pictures()], action: 'Merge PDFs' },
    { what: 'Merge, form-heavy (2 x 500 pages, 20,000 fields each, all renamed in the second)', tool: 'merge-pdf', files: [forms(), forms()], action: 'Merge PDFs' },
    { what: 'Merge, many pages (2 x 2,500 pages with links and bookmarks, 5,000 in all)', tool: 'merge-pdf', files: [manyPages(), manyPages()], action: 'Merge PDFs' },
    { what: 'Split, image-heavy, into single pages', tool: 'split-pdf', files: [pictures()], action: 'Split the PDF', setup: p => p.locator('[data-key="opt-mode"]').selectOption('each').then(() => undefined) },
    { what: 'Split, form-heavy, into single pages', tool: 'split-pdf', files: [forms()], action: 'Split the PDF', setup: p => p.locator('[data-key="opt-mode"]').selectOption('each').then(() => undefined) },
    { what: 'Split, many pages, into single pages', tool: 'split-pdf', files: [manyPages()], action: 'Split the PDF', setup: p => p.locator('[data-key="opt-mode"]').selectOption('each').then(() => undefined) },
    { what: 'Rotate, image-heavy, every page', tool: 'rotate-pdf', files: [pictures()], action: 'Rotate the pages' },
    { what: 'Delete, form-heavy, every other page', tool: 'delete-pdf-pages', files: [forms()], action: 'Delete the pages', setup: async p => { await p.locator('[data-key="opt-pages"]').fill(Array.from({ length: 250 }, (_, i) => 2 * i + 2).join(',')); await p.locator('[data-key="opt-pages"]').press('Tab'); } },
  ];
  for (const c of cases) {
    const r = await measure(baseURL, c.tool, c.files, c.setup ?? (async () => undefined), c.action);
    const failed = await r.page.locator('#workspace .ws-run .job-error').count();
    record(`${c.what}: ${size(c.files).toFixed(0)} MB in, ${failed ? 'FAILED' : `${r.outputs} ${r.outputs === 1 ? 'file' : 'files'}`} in ${r.secs.toFixed(1)} s, browser memory +${r.riseMB.toFixed(0)} MB at most (${(r.riseMB / size(c.files)).toFixed(1)} times the input), worst main-thread gap ${r.lagMs} ms`);
    await r.context.close();
    expect(failed, c.what).toBe(0);
  }
});

// Chrome with its JavaScript heap capped at 96 MB, a stand-in for a device with little memory. Before the memory
// admission check, merging two form-heavy PDFs here ran the PDF worker out of heap, and Chrome stopped the whole page
// from responding: Cancel could not be pressed and it never recovered. Now each file is refused as it is added, the
// page keeps answering, a run that fits can be canceled, and a small merge completes.
test('a 96 MB heap: form-heavy PDFs are refused as they are added instead of freezing the page; cancel and a small merge still work', async ({ baseURL }) => {
  test.setTimeout(600_000);
  const profile = mkdtempSync(join(tmpdir(), 'fc-profile-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', baseURL, args: ['--js-flags=--max-old-space-size=96'] });
  const page = context.pages()[0] ?? await context.newPage();
  await openApp(page);
  expect(await page.evaluate(() => (performance as Performance & { memory: { jsHeapSizeLimit: number } }).memory.jsHeapSizeLimit)).toBeLessThan(300 * MB);
  await page.evaluate(() => (window as unknown as { __fileconvert: { openTool(id: string): Promise<unknown> } }).__fileconvert.openTool('merge-pdf'));
  const ws = page.locator('#workspace');
  const f = forms();
  const g = join(DIR, 'forms-20000-copy.pdf');
  if (!existsSync(g)) copyFileSync(f, g);
  const t = Date.now();
  await ws.locator('input[type=file]').setInputFiles([f, g]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 120_000 });
  expect(Date.now() - t).toBeLessThan(60_000);
  await expect(ws.locator('.ws-item .job-error')).toHaveCount(2);
  await expect(ws.locator('.ws-item .job-error').first()).toHaveText(/^This PDF needs about [\d.]+ MB of the browser's working memory for its objects and pages, more than the [\d.]+ MB this browser gives one task, so it was not started\.$/);
  // The page answers at once.
  const t2 = Date.now();
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  expect(Date.now() - t2).toBeLessThan(2_000);
  while (await ws.getByRole('button', { name: /^Remove / }).count()) await ws.getByRole('button', { name: /^Remove / }).first().click();
  // A merge that fits (two 400 MB picture files are bytes, not objects) can be canceled while it runs.
  const p = pictures();
  const q = join(DIR, 'pictures-400mb-copy.pdf');
  if (!existsSync(q)) copyFileSync(p, q);
  await ws.locator('input[type=file]').setInputFiles([p, q]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 300_000 });
  await expect(ws.locator('.ws-item .job-error')).toHaveCount(0);
  await ws.getByRole('button', { name: 'Merge PDFs' }).click();
  await expect(ws.locator('.ws-run .job-info')).toContainText('Adding', { timeout: 60_000 });
  await ws.getByRole('button', { name: 'Cancel' }).click();
  await expect(ws.locator('.ws-state.canceled')).toHaveText('Canceled.');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fileconvert: { engines: { pdf: { active: number } } } }).__fileconvert.engines.pdf.active)).toBe(0);
  while (await ws.getByRole('button', { name: /^Remove / }).count()) await ws.getByRole('button', { name: /^Remove / }).first().click();
  await ws.locator('input[type=file]').setInputFiles([join('tests', 'fixtures', 'pdf', 'merge-a.pdf'), join('tests', 'fixtures', 'pdf', 'merge-b.pdf')]);
  await expect(ws.locator('.ws-item.checking')).toHaveCount(0, { timeout: 60_000 });
  await ws.getByRole('button', { name: 'Merge PDFs' }).click();
  await expect(ws.locator('.ws-state.done')).toHaveText(/^Done: 1 file/, { timeout: 120_000 });
  record(`96 MB heap: two form-heavy PDFs refused as added in ${((Date.now() - t) / 1000).toFixed(1)} s in all, a picture merge canceled, a small merge done`);
  await context.close();
});
