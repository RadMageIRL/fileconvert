import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LIMITS } from '../../src/core/limits';
import { admit, allowanceText, estimate, estimateFromSize, estimatePreviews, looksMobile, memoryAllowance, MemoryLimitError, refusal, workOf, type MemoryAllowance, type PdfWork } from '../../src/core/pdfmemory';
import { adviceWithPreviews, withPreviews } from '../../src/tools/pdf-common';
import { scanPdf } from '../../src/engines/pdf/scan';
import { openPdf, partBytes, pdfLib } from '../../src/engines/pdf/structure';
import { content, fx, page, pdfFrom } from './pdf-helpers';

// The memory admission check for PDF work (src/core/pdfmemory.ts): an estimate from what the guard counted, against an
// allowance from what the browser reports, checked before any PDF library reads a file. The browser tests check the
// same rules in each browser, with device memory forced low and with no device memory reported.

const MB = 1048576;
const GB = 1024 * MB;
const work = (w: Partial<PdfWork>): PdfWork => ({ bytes: 0, parsed: 0, objects: 0, pages: 0, ...w });
const E = LIMITS.pdfEditMemory.other;

describe('the allowance', () => {
  test('half the device memory the browser reports, at most 4 GB', () => {
    expect(memoryAllowance({ deviceMemory: 8 })).toMatchObject({ total: 4 * GB, basis: 'device', deviceGB: 8, heap: null, engine: 'other' });
    expect(memoryAllowance({ deviceMemory: 4 }).total).toBe(2 * GB);
    expect(memoryAllowance({ deviceMemory: 2 }).total).toBe(1 * GB);
    expect(memoryAllowance({ deviceMemory: 0.5 }).total).toBe(256 * MB);
    expect(memoryAllowance({ deviceMemory: 0.25 }).total).toBe(128 * MB);
    // Chrome 157 reports 32 GB on a 64 GB computer: one task still gets 4 GB at most.
    expect(memoryAllowance({ deviceMemory: 32 }).total).toBe(4 * GB);
  });

  test('where no device memory is reported: 2 GB on a computer, 1 GB on a phone or tablet, never 4 GB', () => {
    for (const deviceMemory of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(memoryAllowance({ deviceMemory })).toMatchObject({ total: 2 * GB, basis: 'computer' });
      expect(memoryAllowance({ deviceMemory, mobile: true })).toMatchObject({ total: 1 * GB, basis: 'phone' });
    }
  });

  test('the heap part: 3/4 of the reported JavaScript heap limit less the reserve, or none where it is not reported', () => {
    expect(memoryAllowance({ deviceMemory: 8, heapLimit: 3_760_000_000 }).heap).toBe(Math.floor((3_760_000_000 - LIMITS.pdfHeapReserve) * LIMITS.pdfHeapShare));
    // Chrome started with a 96 MB heap reports 212 MB.
    expect(memoryAllowance({ deviceMemory: 8, heapLimit: 212_000_000 }).heap).toBe(Math.floor((212_000_000 - LIMITS.pdfHeapReserve) * LIMITS.pdfHeapShare));
    expect(memoryAllowance({ deviceMemory: 8, heapLimit: 100 * MB }).heap).toBe(0);
    expect(memoryAllowance({ heapLimit: Number.NaN }).heap).toBeNull();
  });

  test('the measurements used: V8 where the heap limit is reported (Chrome, Edge), Gecko where its property is (Firefox), the highest elsewhere', () => {
    expect(memoryAllowance({ deviceMemory: 8, heapLimit: 3_760_000_000 }).engine).toBe('v8');
    expect(memoryAllowance({ gecko: true }).engine).toBe('gecko');
    expect(memoryAllowance({ deviceMemory: 8 }).engine).toBe('other');
    expect(memoryAllowance({}).engine).toBe('other');
  });

  test('phones and tablets, for the assumption: by user agent, or a Mac with a touch screen (an iPad)', () => {
    expect(looksMobile({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' })).toBe(true);
    expect(looksMobile({ userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0' })).toBe(true);
    expect(looksMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(looksMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(looksMobile({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', platform: 'Win32', maxTouchPoints: 10 })).toBe(false);
    expect(looksMobile({ userAgentData: { mobile: true } })).toBe(true);
    expect(looksMobile(undefined)).toBe(false);
  });
});

describe('the estimate', () => {
  test('a base, then per byte, per byte parsed into objects, per page and the largest stream, summed over the files', () => {
    const a = work({ bytes: 10 * MB, parsed: 2 * MB, objects: 1000, pages: 100, largest: 3 * MB });
    const one = estimate([a], 'edit');
    const H = LIMITS.pdfHeapMemory;
    expect(one.total).toBe(Math.ceil(E.base + E.byte * 10 * MB + E.stream * 3 * MB + E.parsed * 2 * MB + E.page * 100 + E.output));
    // The heap part has its own figures: what has to fit in the heap at once.
    expect(one.heap).toBe(Math.ceil(H.parsed * 2 * MB + H.page * 100 + H.output));
    // Objects are counted but cost nothing beyond the bytes parsed; the largest stream counts once over all files.
    expect(estimate([{ ...a, objects: 400_000 }], 'edit')).toEqual(one);
    const two = estimate([a, a], 'edit');
    expect(two.total - one.total).toBe(Math.ceil(E.byte * 10 * MB + E.parsed * 2 * MB + E.page * 100));
  });

  test('the reorder tool counts the pages its list shows, outside the heap', () => {
    const a = work({ bytes: MB, parsed: MB, pages: 5000 });
    const listed = estimate([a], 'edit', { listed: 5000 });
    const plain = estimate([a], 'edit');
    expect(listed.total - plain.total).toBe(Math.ceil(E.list * 5000));
    expect(listed.heap).toBe(plain.heap);
  });

  test('the estimate for an unknown engine is never below the one for V8 or Gecko, part by part', () => {
    for (const kind of ['edit', 'text'] as const) {
      const sets = kind === 'edit' ? LIMITS.pdfEditMemory : LIMITS.pdfTextMemory;
      for (const known of [sets.v8, sets.gecko]) {
        for (const k of Object.keys(known) as Array<keyof typeof known>) expect(sets.other[k], `${kind} ${k}`).toBeGreaterThanOrEqual(known[k]);
      }
    }
    const w = work({ bytes: 10 * MB, parsed: 3 * MB, objects: 5000, pages: 200, largest: 4 * MB });
    expect(estimate([w], 'edit', { engine: 'other' }).total).toBeGreaterThanOrEqual(estimate([w], 'edit', { engine: 'v8' }).total);
    expect(estimate([w], 'edit').total).toBe(estimate([w], 'edit', { engine: 'other' }).total);
  });

  test('a split counts each file it makes and the bytes it writes beyond the input', () => {
    const a = work({ bytes: 4 * MB, pages: 300 });
    const plain = estimate([a], 'edit', { outputs: 300 });
    const shared = estimate([a], 'edit', { outputs: 300, extraOutput: 1196 * MB });
    expect(plain.total - estimate([a], 'edit').total).toBe(Math.ceil(299 * E.output));
    expect(shared.total - plain.total).toBe(Math.ceil(E.copy * 1196 * MB));
  });

  test('the size alone is a lower bound of the whole estimate, so checking it before the file is read never refuses what the whole would admit', () => {
    const a = work({ bytes: 50 * MB, parsed: 1 * MB, objects: 10, pages: 3 });
    expect(estimateFromSize(a.bytes, 'edit').total).toBeLessThanOrEqual(estimate([a], 'edit').total);
    expect(estimateFromSize(a.bytes, 'text').total).toBeLessThanOrEqual(estimate([a], 'text').total);
  });

  test('the largest JPEG 2000 picture is counted apart, from its own header, since decoding one costs more', () => {
    const s = scanPdf(new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'pdf-render', 'jpx-cmyk.pdf'))));
    expect(s.largestJpxPixels).toBeGreaterThan(0);
    expect(s.largestJpxPixels).toBeLessThanOrEqual(s.largestImagePixels);
    expect(workOf(1, s).jpxPixels).toBe(s.largestJpxPixels);
    expect(scanPdf(fx('merge-b-objstm.pdf')).largestJpxPixels).toBe(0);
  });

  test('the counts come from the guard: bytes outside streams, and what object streams decode to', () => {
    const s = scanPdf(fx('merge-b-objstm.pdf'));
    expect(s.objectStreamBytes).toBeGreaterThan(0);
    expect(s.textBytes).toBeGreaterThan(0);
    expect(workOf(1234, s)).toEqual({ bytes: 1234, parsed: s.textBytes + s.objectStreamBytes, objects: s.objects, pages: s.pages, largest: s.largestStream, imagePixels: s.largestImagePixels, jpxPixels: s.largestJpxPixels, content: s.contentBytes, fonts: s.fontBytes, softMasks: s.softMasks > 0,
      pageContent: Math.min(s.contentBytes, s.largestContent * s.maxContents), pageRaw: Math.min(s.rawContent, s.largestRawContent * s.maxContents), expanded: s.formExpansion, expandedText: s.textFormExpansion, annotations: s.annotExpansion, formFonts: s.formFontBytes, maskDraws: s.maskDraws,
      expandedEdit: s.editFormExpansion * Math.min(1, 50 / Math.max(1, s.pages)) });
  });

  test('one page is bounded by its largest stream times the most streams a page has; forms by the 50 pages pdf.js keeps', () => {
    const s = scanPdf(fx('merge-b-objstm.pdf'));
    const w = workOf(1000, { ...s, contentBytes: 9e6, largestContent: 1e6, rawContent: 20e6, largestRawContent: 5e6, maxContents: 3, formExpansion: 1e6, annotExpansion: 2e6, editFormExpansion: 1e6, textFormExpansion: 0.25e6, pages: 100 });
    expect(w.pageContent).toBe(3e6);
    expect(w.pageRaw).toBe(15e6);
    // The guard holds drawing's and reading's form expansion to the 50 costliest pages itself; editing's is spread.
    expect(w.expanded).toBe(1e6);
    expect(w.expandedText).toBe(0.25e6);
    expect(w.annotations).toBe(2e6);
    expect(w.expandedEdit).toBe(0.5e6);
    expect(workOf(1000, { ...s, formExpansion: 1e6, editFormExpansion: 3e6, pages: 100 }).expandedEdit).toBe(1.5e6);
    // Never more than all the content, and a short file counts all of its forms.
    expect(workOf(1000, { ...s, contentBytes: 2e6, largestContent: 1e6, maxContents: 3, formExpansion: 1e6, pages: 4 }).pageContent).toBe(2e6);
    expect(workOf(1000, { ...s, editFormExpansion: 1e6, pages: 4 }).expandedEdit).toBe(1e6);
  });

  test('page content and embedded fonts are counted apart, once decoded: the cleanup reads all content, pdf.js converts every font', () => {
    const sans = scanPdf(new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'pdf-render', 'multilingual.pdf'))));
    const std = scanPdf(new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'pdf-render', 'fonts-std.pdf'))));
    // The file with embedded fonts has their programs counted; the one with the standard fonts, not embedded, has none.
    expect(sans.fontBytes).toBeGreaterThan(10_000);
    expect(std.fontBytes).toBe(0);
    expect(sans.contentBytes).toBeGreaterThan(0);
    expect(std.contentBytes).toBeGreaterThan(0);
    // Pictures are not content.
    const pic = scanPdf(new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'pdf-render', 'big-picture.pdf'))));
    expect(pic.contentBytes).toBeLessThan(1000);
    const w = workOf(1000, sans);
    const E = LIMITS.pdfEditMemory.v8, T = LIMITS.pdfTextMemory.v8;
    expect(estimate([{ ...w, content: 1e6 }], 'edit', { engine: 'v8' }).total - estimate([{ ...w, content: 0 }], 'edit', { engine: 'v8' }).total).toBe(E.content * 1e6);
    expect(estimate([{ ...w, fonts: 1e6 }], 'text', { engine: 'v8' }).total - estimate([{ ...w, fonts: 0 }], 'text', { engine: 'v8' }).total).toBe(T.font * 1e6);
    // Reading text prices content too (many small text items), and more than editing does; editing does not price fonts.
    expect(estimate([{ ...w, content: 1e6 }], 'text', { engine: 'v8' }).total - estimate([{ ...w, content: 0 }], 'text', { engine: 'v8' }).total).toBe(T.content * 1e6);
    expect(T.content).toBeGreaterThan(E.content);
    expect(estimate([{ ...w, fonts: 1e6 }], 'edit', { engine: 'v8' }).total).toBe(estimate([{ ...w, fonts: 0 }], 'edit', { engine: 'v8' }).total);
    // One page at a time: of several files, the largest page counts, not the sum.
    // Reading text counts forms that hold text, through forms inside forms; editing counts every form once (the cleanup
    // reads each form once); neither counts annotations, which only drawing reads.
    for (const [kind, F] of [['text', T], ['edit', E]] as const) {
      const big = { ...w, pageContent: 2e6, pageRaw: 3e6, expanded: 4e6, expandedText: 4e6, expandedEdit: 4e6 };
      const none = { ...w, pageContent: 0, pageRaw: 0, expanded: 0, expandedText: 0, expandedEdit: 0 };
      const one = estimate([big], kind, { engine: 'v8' }).total - estimate([none], kind, { engine: 'v8' }).total;
      expect(Math.abs(one - (F.pageContent * 2e6 + F.raw * 3e6 + F.expanded * 4e6)), kind).toBeLessThanOrEqual(1);
      const two = estimate([big, { ...w, pageContent: 1e6, pageRaw: 1e6, expanded: 1e6, expandedText: 1e6, expandedEdit: 1e6 }], kind, { engine: 'v8' }).total;
      expect(two - estimate([big, none], kind, { engine: 'v8' }).total, kind).toBe(0);
      expect(estimate([{ ...big, annotations: 9e9 }], kind, { engine: 'v8' }).total, kind).toBe(estimate([big], kind, { engine: 'v8' }).total);
    }
    // Fonts written out in full in forms are read again for text, at a small figure; editing does not read them.
    expect(estimate([{ ...w, formFonts: 1e8 }], 'text', { engine: 'v8' }).total - estimate([{ ...w, formFonts: 0 }], 'text', { engine: 'v8' }).total).toBe(T.fontLoad * 1e8);
    expect(estimate([{ ...w, formFonts: 1e8 }], 'edit', { engine: 'v8' }).total).toBe(estimate([{ ...w, formFonts: 0 }], 'edit', { engine: 'v8' }).total);
    // Editing does not multiply what forms draw: the nested expansion alone does not move its estimate.
    expect(estimate([{ ...w, expanded: 9e9, expandedText: 9e9, expandedEdit: 0 }], 'edit', { engine: 'gecko' }).total).toBe(estimate([{ ...w, expanded: 0, expandedText: 0, expandedEdit: 0 }], 'edit', { engine: 'gecko' }).total);
    const drawingForms = { ...w, expanded: 4e6, expandedText: 0 };
    expect(estimate([drawingForms], 'text', { engine: 'v8' }).total - estimate([{ ...w, expanded: 0, expandedText: 0 }], 'text', { engine: 'v8' }).total).toBe(T.formRead * 4e6);
    expect(T.formRead).toBeLessThan(T.expanded);
  });
});

describe('refusals', () => {
  const device: MemoryAllowance = { total: 1 * GB, heap: null, basis: 'device', engine: 'other', deviceGB: 2 };
  test('null when the estimate fits; otherwise the estimate, the allowance and where it comes from', () => {
    expect(refusal({ total: GB, heap: 0 }, device, 'This PDF needs', '')).toBeNull();
    expect(refusal({ total: GB + 1, heap: 0 }, device, 'Together these files need', 'Merge fewer files at a time.'))
      .toBe('Together these files need about 1.00 GB of memory, more than the 1.00 GB FileConvert lets one task use on this device (half of the 2 GB of memory the browser reports), so it was not started. Merge fewer files at a time.');
  });

  test('where the browser reports no device memory, the refusal says what was assumed', () => {
    expect(allowanceText(memoryAllowance({}))).toBe('the 2.00 GB FileConvert lets one task use in a browser that does not say how much memory the device has');
    expect(allowanceText(memoryAllowance({ mobile: true }))).toBe('the 1.00 GB FileConvert lets one task use on a phone or tablet whose browser does not say how much memory it has');
    expect(allowanceText(memoryAllowance({ deviceMemory: 0.5 }))).toContain('half of the 512 MB of memory the browser reports');
    expect(() => admit({ total: 3 * GB, heap: 0 }, memoryAllowance({}), 'This PDF needs', '')).toThrow(/^This PDF needs about 3\.00 GB of memory, more than the 2\.00 GB FileConvert lets one task use in a browser that does not say how much memory the device has, so it was not started\. Chrome and Edge say how much memory the device has, so FileConvert may allow more there\.$/);
  });

  test('the heap part is held to the heap allowance even when the whole fits', () => {
    const heap: MemoryAllowance = { total: 4 * GB, heap: 40 * MB, basis: 'device', engine: 'v8', deviceGB: 8 };
    expect(refusal({ total: 500 * MB, heap: 41 * MB }, heap, 'This PDF needs', '')).toMatch(/^This PDF needs about 41\.0 MB of the browser's working memory for its objects and pages, more than the 40\.0 MB this browser gives one task, so it was not started\.$/);
    expect(refusal({ total: 500 * MB, heap: 40 * MB }, heap, 'This PDF needs', '')).toBeNull();
  });

  test('admit throws a MemoryLimitError, and nothing without an allowance', () => {
    expect(() => admit({ total: 2 * GB, heap: 0 }, device, 'This PDF needs', '')).toThrow(MemoryLimitError);
    expect(() => admit({ total: 2 * GB, heap: 0 }, undefined, 'This PDF needs', '')).not.toThrow();
  });
});

describe('the check runs between the guard and the editing library', () => {
  afterEach(() => vi.restoreAllMocks());

  test('a refusal stops openPdf before the library reads anything; a file that fits loads', async () => {
    const L = await pdfLib();
    const load = vi.spyOn(L.PDFDocument, 'load');
    const bytes = fx('merge-a.pdf');
    const tiny: MemoryAllowance = { total: 1, heap: null, basis: 'device', engine: 'other', deviceGB: 0.25 };
    await expect(openPdf(bytes, scan => admit(estimate([workOf(bytes.length, scan)], 'edit'), tiny, 'This PDF needs', ''))).rejects.toThrow(/^This PDF needs about .* so it was not started\.$/);
    expect(load).not.toHaveBeenCalled();
    const seen: number[] = [];
    await openPdf(bytes, scan => { seen.push(scan.pages); admit(estimate([workOf(bytes.length, scan)], 'edit'), memoryAllowance({ deviceMemory: 8 }), 'This PDF needs', ''); });
    expect(seen).toEqual([3]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a 40 KB PDF whose object stream holds one array of a million numbers passes the guard, and is refused on a small device by what it would parse', async () => {
    // pdf-lib makes an object of every number: 20 million of them held 932 MB (measured), from 40 KB of file.
    const { zlibSync } = await import('fflate');
    const body = new TextEncoder().encode(`10 0 [${'0 '.repeat(1_000_000)}]`);
    const z = zlibSync(body, { level: 9 });
    const head = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n11 0 obj\n'
      + `<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`);
    const tail = new TextEncoder().encode('\nendstream\nendobj\ntrailer\n<< /Size 12 /Root 1 0 R >>\n%%EOF\n');
    const bytes = new Uint8Array([...head, ...z, ...tail]);
    const s = scanPdf(bytes);
    expect(s.objectStreamBytes).toBe(body.length);
    const e = estimate([workOf(bytes.length, s)], 'edit');
    // Two million bytes parsed into objects: the estimate is far above the size of the file.
    expect(e.heap).toBeGreaterThan(64 * bytes.length);
    expect(e.heap).toBeGreaterThanOrEqual(LIMITS.pdfHeapMemory.parsed * body.length);
    expect(e.total).toBeGreaterThanOrEqual(E.parsed * body.length);
    // On a device that reports 1 GB (512 MB for one task): its size alone fits; what it would parse does not.
    const small = memoryAllowance({ deviceMemory: 1 });
    expect(() => admit(estimateFromSize(bytes.length, 'edit'), small, 'This PDF needs', '')).not.toThrow();
    expect(() => admit(e, small, 'This PDF needs', '')).toThrow(MemoryLimitError);
  });
});

describe('what the parts of a split hold together', () => {
  // Three pages that draw one 20,000-byte picture; page 3 also has 50,000 bytes of its own content; page 1 links to page 3.
  const picture = `<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 20000 >>\nstream\n${'x'.repeat(20000)}\nendstream`;
  const res = ' /Resources << /XObject << /Im0 9 0 R >> >>';
  const bytes = pdfFrom({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    3: page(6, `${res} /Annots [10 0 R]`),
    4: page(7, res),
    5: page(8, res),
    6: content('q 100 0 0 100 0 0 cm /Im0 Do Q'),
    7: content('q 100 0 0 100 0 0 cm /Im0 Do Q'),
    8: content(`q 100 0 0 100 0 0 cm /Im0 Do Q ${'%'.repeat(50000)}`),
    9: picture,
    10: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [5 0 R /Fit] >>',
  });

  test('a picture shared by every page is counted once in each part', async () => {
    const { doc } = await openPdf(bytes);
    const L = await pdfLib();
    const singles = partBytes(doc, L, [[0], [1], [2]]);
    const whole = partBytes(doc, L, [[0, 1, 2]]);
    expect(singles).toBeGreaterThan(3 * 20000 + 50000);
    expect(whole).toBeLessThan(2 * 20000 + 50000);
    // Overlapping parts each get their own copy.
    expect(partBytes(doc, L, [[0, 1, 2], [0, 1, 2]])).toBe(2 * whole);
  });

  test('a link to another page does not bring that page in, and counting stops past the limit given', async () => {
    const { doc } = await openPdf(bytes);
    const L = await pdfLib();
    const first = partBytes(doc, L, [[0]]);
    expect(first).toBeGreaterThan(20000);
    expect(first).toBeLessThan(25000);
    const parts = Array.from({ length: 1000 }, () => [0, 1, 2]);
    expect(partBytes(doc, L, parts, 100_000)).toBeLessThan(3 * partBytes(doc, L, [[0, 1, 2]]));
  });
});

describe('the tools check before they run', () => {
  test('reorder counts the pages its list shows: a PDF that delete accepts can be too large to reorder', async () => {
    const { tool: reorder } = await import('../../src/tools/organize-pdf');
    const { tool: del } = await import('../../src/tools/delete-pdf-pages');
    const a = memoryAllowance();
    const pages = 5000;
    // Bytes chosen so that the file fits without its page list and not with it (Node reports no device memory).
    const without = estimate([work({ pages })], 'edit').total;
    const list = E.list * pages;
    const bytes = Math.floor((a.total - without - list / 2) / E.byte);
    const input = { id: 1, name: 'a.pdf', format: 'pdf' as const, file: { size: bytes } as File, pages, work: work({ bytes, pages }) };
    expect(del.check!([input], { pages: '1' })).toBeNull();
    expect(reorder.check!([input], { order: `${pages}, 1-${pages - 1}` })).toMatch(/^This PDF needs about .* of memory, more than the 2\.00 GB/);
  });
});

describe('what previews hold when a tool runs', () => {
  test('a tool that showed page previews counts them on top of its work; first-page pictures count the largest one', () => {
    const w: PdfWork = { bytes: 6e6, parsed: 2e6, objects: 5000, pages: 1200, largest: 3e6, imagePixels: 8.4e6 };
    const small: PdfWork = { ...w, pages: 3, imagePixels: 1e6 };
    const file = new File([new Uint8Array(4)], 'a.pdf');
    const input = (work: PdfWork, previewing?: 'pages' | 'first') => ({ id: 1, file, name: 'a.pdf', format: 'pdf' as const, work, pages: work.pages, previewing });
    const e = { total: 1000, heap: 7 };
    expect(withPreviews(e, [input(w)], 'v8')).toEqual(e);
    expect(withPreviews(e, [input(w, 'pages')], 'v8')).toEqual({ total: 1000 + estimatePreviews(w, 'pages', 'v8').total, heap: 7 });
    expect(withPreviews(e, [input(w, 'first'), input(small, 'first')], 'v8').total).toBe(1000 + Math.max(estimatePreviews(w, 'first', 'v8').total, estimatePreviews(small, 'first', 'v8').total));
    // The page grid of 1,200 pages that each show an 8.4 MP picture holds far more than one first page.
    expect(estimatePreviews(w, 'pages', 'v8').total).toBeGreaterThan(estimatePreviews(w, 'first', 'v8').total);
    expect(adviceWithPreviews('Merge fewer files.', [input(w, 'first')])).toBe('Merge fewer files. This counts the memory the first-page pictures may still hold.');
    expect(adviceWithPreviews('', [input(w)])).toBe('');
  });
});
