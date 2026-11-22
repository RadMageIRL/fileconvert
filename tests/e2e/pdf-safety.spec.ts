import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { addFiles, convert, convertAllTo, expectDone, fx, openApp, PYTHON, pyRead, row, tempDir, unexpectedViolations } from './helpers';

// The PDF safety foundation (v0.2.0, Phase 2) in the browser. Every PDF goes through the guard in the PDF worker
// before pdf.js or the editing library reads it; page cleanup runs in the same worker. Results are read by qpdf,
// PDFium, pypdf and Xpdf's pdftotext (tests/e2e/readers.py), which share no code with FileConvert.

interface PdfRead {
  qpdf: { ok: boolean; out: string }; pages: number; text: string[]; annots: string[][]; fields: string[]; outlines: string[];
  dests: string[]; catalog: string[]; pdftotext: string; renders: string[]; decompressed: string;
}
interface KeepResult { bytes: string; report: Record<string, number | boolean>; signature: { signed: boolean } }

const SECRETS = ['PAGE-TWO-SECRET', 'OLD-REVISION-SECRET', 'ANNOT-SECRET', 'FIELD-SECRET', 'OUTLINE-SECRET', 'TAG-SECRET', 'THREAD-SECRET', 'PIECE-SECRET', 'secret-two', 'secretfield'];

/** Runs the PDF worker's page operation in the page, as the PDF tools will, and returns its result. */
async function keepPages(page: Page, file: string, order: number[]): Promise<KeepResult> {
  const data = readFileSync(file).toString('base64');
  return page.evaluate(async ([b64, keep]) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const app = (window as unknown as { __fileconvert: { engines: { pdf: { run<T>(task: string, payload: unknown): Promise<T> } } } }).__fileconvert;
    try {
      const r = await app.engines.pdf.run<{ bytes: Uint8Array; report: Record<string, number | boolean>; signature: { signed: boolean } }>('keepPages', { file: new Blob([bytes]), order: keep });
      let s = '';
      for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
      return { bytes: btoa(s), report: r.report, signature: r.signature };
    } catch (e) {
      return { bytes: '', report: { error: (e as Error).message } as unknown as Record<string, number | boolean>, signature: { signed: false } };
    }
  }, [data, order] as const);
}

const pdfWorkers = (page: Page) => page.workers().filter(w => /pdf\.worker\.min/.test(w.url())).length;

test('PDF to TXT: every hostile PDF is refused by the guard before pdf.js reads it; ordinary PDFs still convert', async ({ page }) => {
  test.slow();
  const w = await openApp(page);
  const hostile: Array<[string, RegExp]> = [
    ['bomb-content.pdf', /a stream that expands past 256 MB when decompressed/],
    ['bomb-objstm.pdf', /an object stream that expands past 256 MB/],
    ['bomb-font.pdf', /a stream that expands past 256 MB/],
    ['bomb-image.pdf', /a picture that expands past 256 MB/],
    ['bomb-lzw.pdf', /expands past 256 MB/],
    ['bomb-predictor.pdf', /expands past 256 MB/],
    ['jpeg-header-size.pdf', /60,000 by 60,000 pixels \(in its JPEG data\)/],
    ['sampled-function.pdf', /sampled function with 10,000,000,000 samples/],
    ['predictor-columns.pdf', /rows would be 381 MB each/],
    ['pages-6000.pdf', /This PDF has 6,000 pages; the limit is 5,000/],
    ['brotli.pdf', /Brotli compression/],
    ['encrypted-owner.pdf', /This PDF is encrypted .* FileConvert never removes a PDF's protection/],
    ['encrypted-user.pdf', /This PDF is encrypted/],
  ];
  await addFiles(page, [...hostile.map(([f]) => fx(`pdf/${f}`)), fx('document/sample.pdf'), fx('pdf/markers.pdf'), fx('pdf/count-lie.pdf')]);
  const t = Date.now();
  await convertAllTo(page, 'TXT');
  for (const [f, message] of hostile) {
    await expect(row(page, f)).toHaveClass(/failed/, { timeout: 60_000 });
    await expect(row(page, f).locator('.job-error')).toContainText(message);
  }
  // A page tree that claims two billion pages holds one: the guard counts page dictionaries, and pdf.js counts
  // the pages it finds, so it converts as the one page it is.
  for (const f of ['sample.pdf', 'markers.pdf', 'count-lie.pdf']) await expectDone(page, f);
  await expect(row(page, 'count-lie.pdf').locator('.job-summary, .job-info').first()).toBeVisible();
  expect(Date.now() - t, 'all of it').toBeLessThan(60_000);
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
  // pdf.js's own worker is gone once each document is done with.
  await expect.poll(() => pdfWorkers(page)).toBe(0);
});

test('a canceled check stops the PDF worker and frees it; the next PDF converts normally', async ({ page }) => {
  await openApp(page);
  // Four content streams of 200 MB each, under every limit but slow enough to cancel while the guard reads them.
  const dir = tempDir();
  const slow = `${dir}/slow.pdf`;
  execFileSync(PYTHON, ['-I', '-c', [
    'import sys, zlib',
    'z = zlib.compress(bytes(200 << 20), 9)',
    'objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>", 2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",',
    '        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 5 0 R 6 0 R 7 0 R] >>"}',
    'for n in range(4, 8): objs[n] = b"<< /Length %d /Filter /FlateDecode >>\\nstream\\n" % len(z) + z + b"\\nendstream"',
    'out = b"%PDF-1.7\\n" + b"".join(b"%d 0 obj\\n" % k + v + b"\\nendobj\\n" for k, v in objs.items()) + b"trailer\\n<< /Root 1 0 R >>\\n%%EOF\\n"',
    'open(sys.argv[1], "wb").write(out)',
  ].join('\n'), slow]);
  await addFiles(page, [slow]);
  const r = row(page, 'slow.pdf');
  await r.locator('select').first().selectOption({ label: 'TXT' });
  await r.getByRole('button', { name: /^Convert/ }).click();
  await expect(r.locator('.job-info.stage')).toContainText(/Checking the PDF/);
  await r.getByRole('button', { name: /Cancel/ }).click();
  await expect(r).toHaveClass(/canceled/);
  // The worker that was checking it was stopped, not left running.
  const pool = await page.evaluate(() => (window as unknown as { __fileconvert: { engines: { pdf: { active: number } } } }).__fileconvert.engines.pdf.active);
  expect(pool).toBe(0);
  await addFiles(page, [fx('document/sample.pdf')]);
  await convert(page, 'sample.pdf', 'TXT');
  await expectDone(page, 'sample.pdf');
});

test('page cleanup in the browser: page 2 of markers.pdf removed, and qpdf, PDFium, pypdf and pdftotext find nothing of it', async ({ page }) => {
  test.slow();
  await openApp(page);
  const pixels = readFileSync(fx('pdf/markers-secret-pixels.bin')).subarray(1000, 1064);
  const source = pyRead<PdfRead>('pdf', fx('pdf/markers.pdf'));
  for (const file of ['markers.pdf', 'markers-objstm.pdf', 'signed.pdf']) {
    const r = await keepPages(page, fx(`pdf/${file}`), [0, 2, 3]);
    expect(r.report.error, file).toBeUndefined();
    expect(r.report).toMatchObject({ pages: 3, pagesRemoved: 1, linksRemoved: 1, formFieldsRemoved: 1, tagsRemoved: true, unreadContent: 0 });
    expect(r.signature.signed, file).toBe(file === 'signed.pdf');
    const out = `${tempDir()}/${file}`;
    writeFileSync(out, Buffer.from(r.bytes, 'base64'));
    const d = pyRead<PdfRead>('pdf', out);
    expect(d.qpdf.ok, d.qpdf.out).toBe(true);
    expect(d.pages).toBe(3);
    const everything = readFileSync(d.decompressed);
    for (const s of SECRETS) expect(everything.includes(s), `${file}: ${s}`).toBe(false);
    expect(everything.includes(pixels), `${file}: the secret picture`).toBe(false);
    expect(d.text.map(t => t.trim())).toEqual(['Page one keep', 'Page three keep', 'Page four keep']);
    expect(d.pdftotext).not.toContain('PAGE-TWO');
    expect(d.annots).toEqual([['/Widget', ...(file === 'signed.pdf' ? ['/Widget'] : [])], ['/Link'], []]);
    expect(d.fields).toEqual(file === 'signed.pdf' ? ['Signature1', 'keepfield'] : ['keepfield']);
    expect(d.outlines).toEqual(['Page one']);
    expect(d.dests).toEqual(['keep-one']);
    for (const k of ['/StructTreeRoot', '/PageLabels', '/Threads']) expect(d.catalog, k).not.toContain(k);
    // The remaining pages look exactly as they did, pixel for pixel, as PDFium draws them.
    if (file === 'markers.pdf') expect(d.renders).toEqual([source.renders[0], source.renders[2], source.renders[3]]);
  }
  // Editing refuses what the guard refuses.
  expect((await keepPages(page, fx('pdf/bomb-objstm.pdf'), [0])).report.error).toMatch(/object stream that expands past 256 MB/);
  expect((await keepPages(page, fx('pdf/encrypted-owner.pdf'), [0])).report.error).toMatch(/^This PDF is encrypted/);
});
