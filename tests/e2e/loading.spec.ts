import { expect, test, type Page } from '@playwright/test';
import { addFiles, convert, download, expectDone, fx, openApp, row } from './helpers';

// Files the app loads later, from wherever the page is: pdf.js character maps live at the app's root, so they
// must load from a page one folder down too. And a tab left open across an update may ask for a converter the
// server no longer has; it must say to reload, not blame memory or fail with a raw browser error.

/**
 * A one-page PDF whose text uses a predefined Japanese CMap (UniJIS-UCS2-H) and a non-embedded CID font, so
 * pdf.js can read it only with its character maps. The text is "Nihongo" in kanji.
 */
function cjkPdf(): Buffer {
  const stream = 'BT /F1 24 Tf 20 40 Td <65E5672C8A9E> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 6 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function extractCjk(page: Page, info: import('@playwright/test').TestInfo): Promise<{ text: string; cmaps: string[] }> {
  const cmaps: string[] = [];
  page.on('response', r => { if (r.url().includes('.bcmap')) cmaps.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.locator('#picker').setInputFiles([{ name: 'japanese.pdf', mimeType: 'application/pdf', buffer: cjkPdf() }]);
  await convert(page, 'japanese.pdf', 'TXT');
  await expectDone(page, 'japanese.pdf');
  const { path } = await download(page, 'japanese.pdf', info);
  return { text: (await import('node:fs')).readFileSync(path, 'utf8'), cmaps };
}

test('PDF text in a CJK font is read with the character maps, on the home page and one folder down', async ({ page }, info) => {
  await openApp(page);
  const home = await extractCjk(page, info);
  expect(home.text).toContain('\u65e5\u672c\u8a9e');
  expect(home.cmaps.length).toBeGreaterThan(0);
  for (const c of home.cmaps) expect(c).toMatch(/^200 \/fileconvert\/pdfjs\/cmaps\/[\w-]+\.bcmap$/);

  await page.goto('./pdf-to-text/');
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  const sub = await extractCjk(page, info);
  expect(sub.text).toContain('\u65e5\u672c\u8a9e');
  expect(sub.cmaps.length).toBeGreaterThan(0);
  for (const c of sub.cmaps) expect(c).toMatch(/^200 \/fileconvert\/pdfjs\/cmaps\/[\w-]+\.bcmap$/);
});

test('a converter that is gone from the server (the app was updated) asks for a reload', async ({ page, context, browserName }) => {
  await openApp(page);
  // The data worker and the PDF reader's chunk are what an old tab would ask for after an update.
  await context.route(/\/assets\/(data\.worker|pdf-text)-[\w-]+\.js$/, r => r.fulfill({ status: 404, body: 'not found' }));
  await addFiles(page, [fx('data/records.json'), fx('document/sample.pdf')]);
  await convert(page, 'sample.pdf', 'TXT');
  await expect(row(page, 'sample.pdf')).toHaveClass(/failed/);
  await expect(row(page, 'sample.pdf').locator('.job-error')).toHaveText(/^Part of FileConvert could not be downloaded\. .*reload the page/);
  await convert(page, 'records.json', 'CSV');
  await expect(row(page, 'records.json')).toHaveClass(/failed/);
  await expect(row(page, 'records.json').locator('.job-error')).toHaveText(/^Part of FileConvert could not be downloaded\. .*reload the page/);
  // Once the files are back (a reload would fetch the new ones), the same conversions work.
  await context.unrouteAll();
  await convert(page, 'records.json', 'CSV');
  await expectDone(page, 'records.json');
  void browserName;
});

test('a worker that never loaded is reported as a download problem, one that loaded and then failed as a crash', async ({ page }) => {
  await openApp(page);
  const messages = await page.evaluate(async () => {
    // The app's own worker pool, given two throwaway workers: one whose code fails to load, one that loads,
    // says so, and then dies while working.
    const app = (window as unknown as { __fileconvert: { engines: { data: object } } }).__fileconvert;
    const Pool = app.engines.data.constructor as new (make: () => Worker, max: number) => { run(task: string, payload: unknown): Promise<unknown> };
    const worker = (code: string) => () => new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const failed = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => e.message);
    return Promise.all([
      failed(new Pool(worker('throw new Error("load");'), 1).run('x', {})),
      failed(new Pool(worker('postMessage({ type: "ready" }); onmessage = () => setTimeout(() => { throw new Error("crash"); });'), 1).run('x', {})),
    ]);
  });
  expect(messages[0]).toMatch(/^Part of FileConvert could not be downloaded\./);
  expect(messages[1]).toMatch(/^The converter stopped unexpectedly\./);
});
