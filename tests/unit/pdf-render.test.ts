import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkSelection, chosenPages } from '../../src/core/pageranges';
import { defaultPaper, LETTER_REGIONS, regionOf } from '../../src/core/paper';
import { estimateRender, workOf } from '../../src/core/pdfmemory';
import { maxDpi, pictureLimits, pictureProblem, pixelSize, RENDER, shownSize } from '../../src/core/pdfrender';
import { LIMITS } from '../../src/core/limits';
import { findMetadata, newFileId, removeMetadata, stripJpeg } from '../../src/engines/pdf/metadata';
import { scanPdf } from '../../src/engines/pdf/scan';
import { cleanDocument, openPdf, pageSizes, pdfLib, savePdf } from '../../src/engines/pdf/structure';
import { tool as split } from '../../src/tools/split-pdf';

// PDF to JPG and PNG, page previews and Remove PDF metadata (v0.2.0, Phase 2), at the engine: picture sizes and
// limits, page sizes as shown, the paper a size choice starts with, chosen pages, and metadata removal. The browser
// tests compare every picture with PDFium and read every metadata result with qpdf, pypdf and PDFium.

const rx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'pdf-render', p)));
const LETTER = { w: 612, h: 792 };

describe('picture sizes and limits', () => {
  test('a page at a resolution: its points times dpi / 72, rounded, at least one pixel a side', () => {
    expect(pixelSize(LETTER, 72)).toEqual({ width: 612, height: 792 });
    expect(pixelSize(LETTER, 150)).toEqual({ width: 1275, height: 1650 });
    expect(pixelSize(LETTER, 300)).toEqual({ width: 2550, height: 3300 });
    expect(pixelSize({ w: 595.2756, h: 841.8898 }, 150)).toEqual({ width: 1240, height: 1754 });
    expect(pixelSize({ w: 10, h: 0.1 }, 72)).toEqual({ width: 10, height: 1 });
  });

  test('the highest resolution that fits: under the pixel limit and the longest side, never below the lowest offered', () => {
    const L = pictureLimits('computer');
    expect(L).toEqual({ side: 32_767, pixels: 100_000_000 });
    const a0 = { w: 2384, h: 3370 };
    const best = maxDpi(a0, L);
    const at = (d: number) => { const p = pixelSize(a0, d); return p.width * p.height; };
    expect(at(best)).toBeLessThanOrEqual(L.pixels);
    expect(at(best + 1)).toBeGreaterThan(L.pixels);
    // The longest side decides for a long banner.
    const banner = { w: 20000, h: 50 };
    expect(pixelSize(banner, maxDpi(banner, L)).width).toBeLessThanOrEqual(32_767);
    expect(pixelSize(banner, maxDpi(banner, L) + 1).width).toBeGreaterThan(32_767);
    // Pixel sizes are rounded: at the resolution the formula gives, this page would be 8,771 x 11,402 pixels, just past
    // 100 megapixels, so the answer is one lower.
    const odd = { w: 1529, h: 1987.7 };
    expect(pixelSize(odd, 413)).toEqual({ width: 8771, height: 11402 });
    expect(maxDpi(odd, L)).toBe(412);
    // A page too large for even the lowest resolution offered.
    expect(maxDpi({ w: 1e6, h: 1e6 }, L)).toBe(0);
    // US Letter fits up to 1,034 dpi (10,200 x 13,200 pixels at 1,200 is 135 megapixels); a small page up to the highest.
    expect(maxDpi(LETTER, L)).toBe(1034);
    expect(maxDpi({ w: 100, h: 100 }, L)).toBe(RENDER.dpiMax);
  });

  test('a phone or tablet that does not report its memory gets the largest canvas Safari draws there', () => {
    expect(pictureLimits('phone')).toEqual({ side: 32_767, pixels: 16_777_216 });
    expect(pictureLimits('device').pixels).toBe(100_000_000);
    expect(pictureProblem(1, LETTER, 300, pictureLimits('phone'))).toBeNull();
    expect(pictureProblem(1, LETTER, 600, pictureLimits('phone'))).toBe('Page 1 at 600 dpi would be 5,100 x 6,600 pixels, 33.7 megapixels, more than the 4,096 x 4,096 pixels Safari draws on a phone or tablet. At 423 dpi or less it fits.');
  });

  test('a refusal names the page, its size at that resolution, the limit, and the resolution at which it fits', () => {
    const L = pictureLimits('computer');
    expect(pictureProblem(3, { w: 2384, h: 3370 }, 150, L)).toBeNull();
    expect(pictureProblem(3, { w: 2384, h: 3370 }, 300, L)).toBe(`Page 3 at 300 dpi would be 9,933 x 14,042 pixels, 139.5 megapixels, more than the 100 megapixels one picture may have. At ${maxDpi({ w: 2384, h: 3370 }, L)} dpi or less it fits.`);
    expect(pictureProblem(1, { w: 20000, h: 50 }, 150, L)).toBe('Page 1 at 150 dpi would be 41,667 x 104 pixels, wider or taller than the 32,767 pixels a browser can draw. At 117 dpi or less it fits.');
    expect(pictureProblem(7, { w: 1e6, h: 1e6 }, 72, L)).toMatch(/too large to draw at any resolution FileConvert offers/);
  });

  test('the size a page is shown at, read as pdf.js reads it: crop box within media box, rotation, UserUnit', () => {
    expect(shownSize([0, 0, 612, 792], null, 0, 1)).toEqual(LETTER);
    expect(shownSize([0, 0, 612, 792], [100, 150, 400, 500], 0, 1)).toEqual({ w: 300, h: 350 });
    expect(shownSize([0, 0, 612, 792], [100, 150, 400, 500], 90, 1)).toEqual({ w: 350, h: 300 });
    expect(shownSize([0, 0, 612, 792], null, -90, 1)).toEqual({ w: 792, h: 612 });
    expect(shownSize([0, 0, 612, 792], null, 450, 1)).toEqual({ w: 792, h: 612 });
    // A rotation that is not a quarter turn is ignored, as PDF readers ignore it.
    expect(shownSize([0, 0, 612, 792], null, 45, 1)).toEqual(LETTER);
    // Corners in either order; a crop box past the media box is clipped to it; one that misses it is ignored.
    expect(shownSize([612, 792, 0, 0], [900, 900, -100, -100], 0, 1)).toEqual(LETTER);
    expect(shownSize([0, 0, 612, 792], [700, 800, 900, 900], 0, 1)).toEqual(LETTER);
    expect(shownSize([0, 0, 300, 200], null, 0, 2)).toEqual({ w: 600, h: 400 });
    // No usable media box: US Letter, as pdf.js assumes.
    expect(shownSize(null, null, 0, 1)).toEqual(LETTER);
    expect(shownSize([0, 0, 0, 100], null, 0, 1)).toEqual(LETTER);
  });

  test('page sizes from the PDF itself match those rules, inherited boxes and rotations included', async () => {
    const sizes = async (f: string) => { const { doc } = await openPdf(rx(f)); return pageSizes(doc, await pdfLib()); };
    expect(await sizes('rotations.pdf')).toEqual([612, 792, 792, 612, 612, 792, 792, 612]);
    expect(await sizes('boxes.pdf')).toEqual([300, 350, 500, 650, 600, 400, 400, 300]);
    expect(await sizes('sizes.pdf')).toEqual([2000, 100, 10, 10, 2384, 3370]);
  });
});

describe('the memory estimate for drawing pages', () => {
  test('the parts pdf.js reads, the largest picture in the file, the page drawn and the results held in memory', () => {
    const s = scanPdf(rx('transparency.pdf'));
    const w = workOf(1000, s);
    expect(w.imagePixels).toBe(128 * 128);
    // Its soft mask is found, and the page drawn costs more for it.
    expect(s.softMasks).toBe(1);
    expect(w.softMasks).toBe(true);
    const F = LIMITS.pdfRenderMemory.v8;
    const base = F.base + F.byte * 1000 + F.parsed * w.parsed + F.page * w.pages + F.stream * w.largest!;
    expect(estimateRender(w, 0, { engine: 'v8' }).total).toBe(Math.ceil(base + F.image * 128 * 128));
    expect(estimateRender(w, 1e6, { engine: 'v8' }).total - estimateRender(w, 0, { engine: 'v8' }).total).toBe(F.masked * 1e6);
    expect(estimateRender({ ...w, softMasks: false }, 1e6, { engine: 'v8' }).total - estimateRender({ ...w, softMasks: false }, 0, { engine: 'v8' }).total).toBe(F.canvas * 1e6);
    expect(F.masked).toBeGreaterThan(F.canvas);
    // Each page drawn counts too (Firefox frees what a page used later than Chrome).
    expect(estimateRender(w, 0, { engine: 'gecko', drawn: 1000 }).total - estimateRender(w, 0, { engine: 'gecko' }).total).toBe(LIMITS.pdfRenderMemory.gecko.drawn * 1000);
    // Pages count up to the 50 pdf.js keeps before the worker lets them go.
    expect(estimateRender({ ...w, pages: 5000 }, 0, { engine: 'v8' }).total - estimateRender({ ...w, pages: 50 }, 0, { engine: 'v8' }).total).toBe(0);
    expect(estimateRender({ ...w, pages: 50 }, 0, { engine: 'v8' }).total - estimateRender({ ...w, pages: 49 }, 0, { engine: 'v8' }).total).toBe(F.page);
    // No soft mask in a file of plain pages, nor in one whose pictures have their own (an image's /SMask).
    expect(scanPdf(rx('rotations.pdf')).softMasks).toBe(0);
    expect(scanPdf(rx('multilingual.pdf')).softMasks).toBeGreaterThan(0);
    expect(estimateRender(w, 0, { engine: 'v8', held: 1e6 }).total - estimateRender(w, 0, { engine: 'v8' }).total).toBe(F.held * 1e6);
    // An engine not told apart gets the highest figures.
    for (const k of Object.keys(F) as Array<keyof typeof F>) expect(LIMITS.pdfRenderMemory.other[k]).toBeGreaterThanOrEqual(Math.max(F[k], LIMITS.pdfRenderMemory.gecko[k]));
    expect(estimateRender(w, 1e6).total).toBe(estimateRender(w, 1e6, { engine: 'other' }).total);
  });
});

describe('the paper a page size starts with', () => {
  test('the region of a language tag, when it names one', () => {
    expect(regionOf('en-US')).toBe('US');
    expect(regionOf('zh-Hant-TW')).toBe('TW');
    expect(regionOf('es_MX')).toBe('MX');
    expect(regionOf('en')).toBeNull();
    expect(regionOf('es-419')).toBeNull();
    expect(regionOf('fr-CA-u-ca-gregory')).toBe('CA');
  });

  test('Letter where it is the usual paper, A4 elsewhere and when no language names a region', () => {
    for (const t of ['en-US', 'es-MX', 'fr-CA', 'en-PH', 'es-CL', 'es-CO', 'es-PR']) expect(defaultPaper([t]), t).toBe('letter');
    for (const t of ['en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'en-AU', 'es-ES', 'pt-BR', 'en-IN']) expect(defaultPaper([t]), t).toBe('a4');
    expect(defaultPaper([])).toBe('a4');
    expect(defaultPaper(['en'])).toBe('a4');
    // The first language that names a region decides.
    expect(defaultPaper(['en', 'en-US', 'de-DE'])).toBe('letter');
    expect(defaultPaper(['de-DE', 'en-US'])).toBe('a4');
    expect([...LETTER_REGIONS].sort()).toEqual(['BZ', 'CA', 'CL', 'CO', 'CR', 'GT', 'MX', 'NI', 'PA', 'PH', 'PR', 'SV', 'US', 'VE']);
  });
});

describe('pages chosen in the previews or typed', () => {
  test('a list kept from the previews, checked page by page; an empty list chooses nothing', () => {
    expect(chosenPages([2, 5, 9], 10, false)).toEqual([2, 5, 9]);
    expect(() => chosenPages([], 10, true)).toThrow('Choose at least one page.');
    expect(() => chosenPages([3, 11], 10, false)).toThrow('There is no page 11; the PDF has 10 pages.');
    expect(() => checkSelection([3, 3], 10)).toThrow('Page 3 is listed more than once; list each page once.');
    expect(() => checkSelection([0], 10)).toThrow('There is no page 0; the PDF has 10 pages.');
  });

  test('text as typed: empty is every page or nothing yet, as the tool says', () => {
    expect(chosenPages('', 4, true)).toEqual([1, 2, 3, 4]);
    expect(chosenPages('  ', 4, true)).toEqual([1, 2, 3, 4]);
    expect(() => chosenPages('', 4, false)).toThrow('Enter the pages, such as 1-3, 7, 10-.');
    expect(chosenPages('3, 1-2', 4, false)).toEqual([3, 1, 2]);
  });

  test('split shows which file each page goes to', () => {
    const inputs = [{ id: 1, file: new File([], 'a.pdf'), name: 'a.pdf', format: 'pdf' as const, pages: 6 }];
    const labels = split.pageLabels!(inputs, { mode: 'ranges', ranges: '1-2, 2-3, 5', every: 2 })!;
    expect([...labels.entries()]).toEqual([[1, 'File 1'], [2, 'Files 1, 2'], [3, 'File 2'], [4, 'Left out'], [5, 'File 3'], [6, 'Left out']]);
    expect([...split.pageLabels!(inputs, { mode: 'every', ranges: '', every: 4 })!.values()]).toEqual(['File 1', 'File 1', 'File 1', 'File 1', 'File 2', 'File 2']);
    expect(split.pageLabels!(inputs, { mode: 'ranges', ranges: '9', every: 2 })).toBeNull();
  });
});

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const seg = (m: number, body: string) => { const p = new TextEncoder().encode(body); return [0xff, m, (p.length + 2) >> 8, (p.length + 2) & 255, ...p]; };
const SOI = [0xff, 0xd8], EOI = [0xff, 0xd9];
// A stand-in for tables, frame and scan: a quantization table segment, a start of scan, entropy data with a stuffed
// zero and a restart marker.
const CORE = [...seg(0xdb, 'QQQQ'), ...seg(0xc0, 'FRAME'), ...seg(0xda, 'SCAN'), 1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4, 5];

describe('JPEG pictures: metadata out, picture data untouched', () => {
  test('EXIF, XMP, IPTC, comments, JFXX thumbnails, extra pictures and data after the end are removed', () => {
    const b = new Uint8Array([...SOI, ...seg(0xe0, 'JFIF\0x'), ...seg(0xe1, 'Exif\0\0GPS'), ...seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0X'), ...seg(0xe2, 'ICC_PROFILE\0p'),
      ...seg(0xe2, 'MPF\0m'), ...seg(0xed, 'Photoshop 3.0\0i'), ...seg(0xee, 'Adobe\0t'), ...seg(0xe0, 'JFXX\0th'), ...seg(0xfe, 'note'), ...seg(0xe5, 'vendor'), ...CORE, ...EOI, 9, 9, 9]);
    const r = stripJpeg(b)!;
    expect(r.kinds.sort()).toEqual(['EXIF', 'IPTC and Photoshop data', 'XMP', 'comments', 'data after the picture', 'extra pictures', 'other data', 'thumbnails']);
    expect(Array.from(r.bytes)).toEqual([...SOI, ...seg(0xe0, 'JFIF\0x'), ...seg(0xe2, 'ICC_PROFILE\0p'), ...seg(0xee, 'Adobe\0t'), ...CORE, ...EOI]);
  });

  test('nothing to remove, not a JPEG, or one that cannot be followed to its end: left as it is', () => {
    expect(stripJpeg(new Uint8Array([...SOI, ...seg(0xe0, 'JFIF\0'), ...CORE, ...EOI]))).toBeNull();
    expect(stripJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    // Cut off in the scan, or a segment length past the end.
    expect(stripJpeg(new Uint8Array([...SOI, ...seg(0xe1, 'Exif\0\0'), ...seg(0xda, 'S'), 1, 2, 3]))).toBeNull();
    expect(stripJpeg(new Uint8Array([...SOI, 0xff, 0xe1, 0x40, 0x00, 1]))).toBeNull();
  });
});

describe('removing PDF metadata', () => {
  const run = async (bytes: Uint8Array) => {
    const L = await pdfLib();
    const { doc } = await openPdf(bytes);
    const found = findMetadata(doc, L);
    const report = removeMetadata(doc, L);
    cleanDocument(doc, L, { pagesRemoved: 0, reordered: false });
    const out = await newFileId(await savePdf(doc));
    return { found, report, out };
  };
  const textOf = async (bytes: Uint8Array) => {
    const L = await pdfLib();
    const doc = await L.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity });
    let t = latin1(bytes);
    for (const [, o] of doc.context.enumerateIndirectObjects()) if (o instanceof L.PDFRawStream) { try { t += latin1(L.decodePDFRawStream(o).decode()); } catch { /* JPEG data is in the bytes */ } }
    return t;
  };

  test('every kind of metadata is found and counted before anything changes, and removing it reports the same', async () => {
    const { found, report } = await run(rx('metadata.pdf'));
    expect(report).toEqual(found);
    expect(found.info).toEqual(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped', 'Department']);
    expect(found).toMatchObject({ xmp: true, objectXmp: 2, pieceInfo: 2, lastModified: 3, thumbnails: 1, spiderInfo: true, jpegs: 1, jpegsUnread: 0, id: true, pdfa: true, pdfua: false });
    expect(found.jpegKinds).toEqual(['EXIF', 'IPTC and Photoshop data', 'XMP', 'comments', 'data after the picture']);
    expect(found.stays).toEqual({ authoredNotes: 1, attachments: 1, formValues: 1, signatures: 0, scripts: false });
  });

  test('none of it is left anywhere in the result, older versions included; what makes up the document stays', async () => {
    const before = await textOf(rx('metadata.pdf'));
    expect(before).toContain('MARK-AUTHOR-OLD-1001');
    expect(before).toContain('MARK-EXIF-CAMERA-5150');
    const { out } = await run(rx('metadata.pdf'));
    const after = await textOf(out);
    expect(after.match(/MARK-[A-Z-]+\d*/g) ?? []).toEqual([]);
    for (const k of ['KEEP-PAGE-TEXT-3141', 'KEEP-COMMENT-AUTHOR-9090', 'KEEP-BOOKMARK-1212', 'KEEP-FIELD-VALUE-5656', 'KEEP-ATTACHMENT-NAME', 'KEEP-ATTACHMENT-CONTENT', 'KEEP-LINK']) expect(after, k).toContain(k);
    // The result reads back with nothing to remove, except its new identifier.
    const L = await pdfLib();
    const again = findMetadata((await openPdf(out)).doc, L);
    expect(again).toMatchObject({ info: [], xmp: false, objectXmp: 0, pieceInfo: 0, lastModified: 0, thumbnails: 0, spiderInfo: false, jpegs: 0, id: true });
  });

  test('the new identifier comes from the result itself: the same input always gives the same file, and the old one is gone', async () => {
    const a = (await run(rx('metadata.pdf'))).out;
    const b = (await run(rx('metadata.pdf'))).out;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const id = /\/ID \[ <([0-9A-F]{32})> <([0-9A-F]{32})> \]/.exec(latin1(a))!;
    expect(id[1]).toBe(id[2]);
    // SHA-256 of the file with the placeholder in place of the identifier, its first 16 bytes.
    const placeholder = latin1(a).replaceAll(id[1], '0'.repeat(32));
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(placeholder, 'latin1'))).subarray(0, 16).toString('hex').toUpperCase();
    expect(id[1]).toBe(digest);
    expect(latin1(a)).not.toContain('4D41524B2D4F4C442D49442D30303031');
  });

  test('a PDF without metadata gains an identifier and nothing else; a placeholder that cannot be found is an error', async () => {
    const { found, out } = await run(new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'pdf', 'merge-b.pdf'))));
    expect(found.jpegs).toBe(0);
    expect(latin1(out)).toMatch(/\/ID \[ <[0-9A-F]{32}> <[0-9A-F]{32}> \]/);
    await expect(newFileId(new Uint8Array(10))).rejects.toThrow('The new file identifier could not be written.');
  });
});
