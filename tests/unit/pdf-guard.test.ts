import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, unzlibSync, zlibSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { LIMITS } from '../../src/core/limits';
import { usedResources } from '../../src/engines/pdf/content';
import { Ascii85Stage, AsciiHexStage, FlateStage, LzwStage, PredictorStage, RunLengthStage, type Sink } from '../../src/engines/pdf/filters';
import { jpegSize, jpxSize, scanPdf } from '../../src/engines/pdf/scan';

// The PDF guard (v0.2.0, Phase 2): every compressed stream is measured through its own filters before any PDF library
// reads the file; sizes readers allocate from are checked; encrypted files are reported. These tests need no PDF
// library and no outside program; the browser tests check the same files in pdf.js and against qpdf and PDFium.

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const enc = (s: string) => new TextEncoder().encode(s);
const MB = 1048576;

/** Collects what a stage produces. */
function collect(make: (sink: Sink) => { push(c: Uint8Array): void; end(): void }, input: Uint8Array, pieces = 7): Uint8Array {
  const parts: Uint8Array[] = [];
  const stage = make({ push: c => parts.push(c.slice()), end() { /* */ } });
  for (let i = 0; i < input.length; i += pieces) stage.push(input.subarray(i, i + pieces));
  stage.end();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A minimal one-page PDF with the given extra objects and page content. */
function pdf(content: Uint8Array, contentDict = '', extra: Record<number, Uint8Array> = {}, resources = '<< >>'): Uint8Array {
  const objs: Record<number, Uint8Array> = {
    1: enc('<< /Type /Catalog /Pages 2 0 R >>'),
    2: enc('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    3: enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents 4 0 R >>`),
    4: cat(enc(`<< /Length ${content.length}${contentDict} >>\nstream\n`), content, enc('\nendstream')),
    ...extra,
  };
  const parts: Uint8Array[] = [enc('%PDF-1.7\n')];
  for (const [n, body] of Object.entries(objs)) parts.push(enc(`${n} 0 obj\n`), body, enc('\nendobj\n'));
  parts.push(enc('trailer\n<< /Size 9 /Root 1 0 R >>\n%%EOF\n'));
  return cat(...parts);
}
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of parts) { o.set(p, a); a += p.length; } return o; };
const zeros = (n: number) => new Uint8Array(n);

describe('filters decode exactly what the standard says, in any piece size', () => {
  test('Flate: zlib data and raw deflate data, stopping at the end of the deflate data', () => {
    const data = enc('Flate data '.repeat(500));
    expect(collect(s => new FlateStage(s), zlibSync(data))).toEqual(data);
    expect(collect(s => new FlateStage(s), deflateSync(data))).toEqual(data);
    // Anything after the end of the deflate data is not decoded.
    expect(collect(s => new FlateStage(s), cat(zlibSync(data), enc('endstream junk')))).toEqual(data);
  });

  test('Flate knows where its data ends, so it is not fed the rest of the file (this pins fflate 0.8.3)', () => {
    for (const make of [zlibSync, deflateSync]) {
      const stage = new FlateStage({ push() { /* */ }, end() { /* */ } });
      stage.push(cat(make(enc('short')), new Uint8Array(1000)));
      expect(stage.done).toBe(true);
    }
    const open = new FlateStage({ push() { /* */ }, end() { /* */ } });
    open.push(zlibSync(enc('x'.repeat(10000))).subarray(0, 8));
    expect(open.done).toBe(false);
  });

  test('LZW: codes 9 to 12 bits wide, with early change, the code being defined, and the clear code', () => {
    // "-----A---B" from the PDF reference's LZW example, plus a long run that fills the table.
    const example = new Uint8Array([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    expect(new TextDecoder().decode(collect(s => new LzwStage(s), example, 1))).toBe('-----A---B');
  });

  test('RunLength, ASCIIHex and ASCII85, with their end markers', () => {
    expect(collect(s => new RunLengthStage(s), new Uint8Array([2, 65, 66, 67, 253, 90, 128, 1, 2]))).toEqual(enc('ABCZZZZ'));
    expect(collect(s => new AsciiHexStage(s), enc('48 65 6c6C 6f 2>ignored'))).toEqual(enc('Hello '));
    expect(new TextDecoder().decode(collect(s => new Ascii85Stage(s), enc('87cURD]i,"Ebo80~>junk')))).toBe('Hello World!');
    expect(collect(s => new Ascii85Stage(s), enc('z~>'))).toEqual(zeros(4));
  });

  test('PNG and TIFF predictors undo each row', () => {
    // Two rows of three bytes: Up (2) then Sub (1).
    const png = new Uint8Array([2, 1, 2, 3, 1, 1, 1, 1]);
    expect(collect(s => new PredictorStage(s, 12, 3, 1, 8), png)).toEqual(new Uint8Array([1, 2, 3, 1, 2, 3]));
    expect(collect(s => new PredictorStage(s, 2, 3, 1, 8), new Uint8Array([5, 1, 1]))).toEqual(new Uint8Array([5, 6, 7]));
  });
});

describe('the guard measures compressed data before any reader decodes it', { timeout: 60_000 }, () => {
  const refused = (b: Uint8Array) => { try { scanPdf(b); return ''; } catch (e) { return (e as Error).message; } };

  test('each kind of decompression bomb in the fixtures is refused at the stream limit', () => {
    for (const f of ['content', 'content-single', 'font', 'lzw', 'runlength', 'ascii85', 'predictor']) {
      expect(refused(fx(`pdf/bomb-${f}.pdf`)), f).toMatch(/^This PDF has a stream that expands past 256 MB when decompressed/);
    }
    expect(refused(fx('pdf/bomb-image.pdf'))).toMatch(/^This PDF has a picture that expands past 256 MB/);
    expect(refused(fx('pdf/bomb-objstm.pdf'))).toMatch(/^This PDF has an object stream that expands past 256 MB/);
  }, 60_000);

  test('a bomb is measured without holding it: the largest piece in memory stays small', () => {
    // 64 MB of zeros behind two layers of Flate, all of it handed to the guard at once, with a limit above it.
    const two = zlibSync(zlibSync(zeros(64 * MB)));
    let largest = 0;
    const counted: number[] = [];
    const inner = new FlateStage({ push: c => { largest = Math.max(largest, c.length); counted.push(c.length); }, end() { /* */ } });
    const outer = new FlateStage({ push: c => { largest = Math.max(largest, c.length); inner.push(c); }, end: () => inner.end() });
    outer.push(two);
    outer.end();
    expect(counted.reduce((a, b) => a + b, 0)).toBe(64 * MB);
    expect(largest).toBeLessThanOrEqual(5 * MB);
  });

  test('a deflate stream is followed to its own end, past a false "endstream" inside it', () => {
    // A stored block that holds the word endstream, then 300 MB of zeros, in one zlib stream with an indirect length.
    const stored = enc('\nendstream\nendobj\n');
    const head = new Uint8Array([0x00, stored.length & 255, stored.length >> 8, ~stored.length & 255, (~stored.length >> 8) & 255]);
    const data = cat(new Uint8Array([0x78, 0x9c]), head, stored, deflateSync(zeros(300 * MB)));
    expect(refused(pdf(data, ' /Filter /FlateDecode /Length 9 0 R'))).toMatch(/expands past 256 MB/);
  });

  test('the total of all streams is limited too, and so are the object streams a library keeps', () => {
    const z = zlibSync(zeros(40 * MB));
    const extra: Record<number, Uint8Array> = {};
    for (let i = 5; i < 9; i++) extra[i] = cat(enc(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, enc('\nendstream'));
    const many = pdf(z, ' /Filter /FlateDecode', extra);
    expect(scanPdf(many).decodedBytes).toBe(200 * MB);
    expect(() => scanPdf(many, { ...LIMITS, pdfDecodedBytes: 150 * MB })).toThrow(/expands past 150 MB in all/);
    const objstm = cat(enc(`<< /Type /ObjStm /N 1 /First 4 /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, enc('\nendstream'));
    expect(() => scanPdf(pdf(enc('q Q'), '', { 5: objstm, 6: objstm }), { ...LIMITS, pdfObjectStreamBytes: 64 * MB })).toThrow(/object streams expand past 64 MB in all/);
  });

  test('sizes readers allocate from are checked: pictures, JPEG and JPEG 2000 headers, sampled functions, rows', () => {
    expect(refused(fx('pdf/image-dimensions.pdf'))).toMatch(/a picture of 50,000 by 50,000 pixels \(in its dictionary\)/);
    expect(refused(fx('pdf/jpeg-header-size.pdf'))).toMatch(/60,000 by 60,000 pixels \(in its JPEG data\)/);
    expect(refused(fx('pdf/jpx-header-size.pdf'))).toMatch(/60,000 by 60,000 pixels \(in its JPEG 2000 data\)/);
    expect(refused(fx('pdf/sampled-function.pdf'))).toMatch(/sampled function with 10,000,000,000 samples/);
    expect(refused(fx('pdf/predictor-columns.pdf'))).toMatch(/rows would be 381 MB each/);
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 17, 8, 0, 30, 0, 40, 3]))).toEqual({ width: 40, height: 30 });
    expect(jpxSize(new Uint8Array([0xff, 0x4f, 0xff, 0x51, 0, 41, 0, 0, 0, 0, 0, 50, 0, 0, 0, 20, 0, 0, 0, 10, 0, 0, 0, 5]))).toEqual({ width: 40, height: 15 });
  });

  test('a cross-reference stream that claims billions of entries is refused before a reader walks them', () => {
    const rows = zlibSync(new Uint8Array(7 * 4));
    const xref = cat(enc(`<< /Type /XRef /Size 2000000000 /Index [0 2000000000] /W [1 4 2] /Root 1 0 R /Length ${rows.length} /Filter /FlateDecode >>\nstream\n`), rows, enc('\nendstream'));
    expect(refused(pdf(enc('q Q'), '', { 5: xref }))).toMatch(/cross-reference stream claims 2,000,000,000 entries/);
  });

  test('pages and objects are counted inside object streams too; Brotli and odd filter chains are refused', () => {
    expect(refused(fx('pdf/pages-6000.pdf'))).toBe('This PDF has 6,000 pages; the limit is 5,000.');
    const r = scanPdf(fx('pdf/markers-objstm.pdf'));
    expect([r.pages, r.objectStreams, r.objects]).toEqual([4, 1, 32]);
    expect(() => scanPdf(fx('pdf/markers-objstm.pdf'), { ...LIMITS, pdfObjects: 20 })).toThrow(/objects; the limit is 20/);
    expect(refused(fx('pdf/brotli.pdf'))).toBe('This PDF uses Brotli compression, which FileConvert does not open.');
    expect(refused(fx('pdf/codec-chain.pdf'))).toMatch(/unusual chain of compression filters/);
  });

  test('many small streams before a large one are read once each, not to the end of the file each', () => {
    // 3,000 small Flate content streams, then 40 MB of incompressible picture data.
    const small = zlibSync(enc('BT /F1 12 Tf 72 720 Td (text) Tj ET'));
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 3000; i++) parts.push(enc(`${10 + i} 0 obj\n<< /Length ${small.length} /Filter /FlateDecode >>\nstream\n`), small, enc('\nendstream\nendobj\n'));
    const noise = new Uint8Array(40 * MB);
    for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, i + 65536));
    parts.push(enc(`9000 0 obj\n<< /Length ${noise.length} /Subtype /Image /Width 10 /Height 10 >>\nstream\n`), noise, enc('\nendstream\nendobj\n'));
    const t = performance.now();
    const r = scanPdf(pdf(enc('q Q'), '', { 5: cat(...parts) }));
    expect(r.streams).toBe(3002);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  test('ordinary files pass quickly, and encryption and signatures are reported', () => {
    for (const f of ['document/sample.pdf', 'document/mixed.pdf', 'document/scanned.pdf', 'pdf/markers.pdf', 'pdf/operator-flood.pdf', 'pdf/huge-mediabox.pdf', 'pdf/count-lie.pdf', 'pdf/deep-nesting.pdf', 'pdf/page-loop.pdf']) {
      const t = performance.now();
      expect(() => scanPdf(fx(f)), f).not.toThrow();
      expect(performance.now() - t, f).toBeLessThan(2000);
    }
    expect(scanPdf(fx('pdf/encrypted-owner.pdf')).encrypted).toBe(true);
    expect(scanPdf(fx('pdf/encrypted-user.pdf')).encrypted).toBe(true);
    expect(scanPdf(fx('pdf/markers.pdf')).encrypted).toBe(false);
    expect(scanPdf(fx('pdf/signed.pdf')).signatureHint).toBe(true);
    expect(scanPdf(fx('pdf/markers.pdf')).signatureHint).toBe(false);
  });

  test('the guard decodes the same bytes a zlib reader does', () => {
    const data = enc('BT /F1 12 Tf (x) Tj ET\n'.repeat(1000));
    const r = scanPdf(pdf(zlibSync(data), ' /Filter /FlateDecode'));
    expect(r.decodedBytes).toBe(unzlibSync(zlibSync(data)).length);
    expect(inflateSync(deflateSync(data)).length).toBe(data.length);
  });
});

describe('what the memory estimate is told about content and fonts', () => {
  test('page content and font programs are counted once decoded, apart from each other and from pictures', () => {
    const ops = enc('q 1 0 0 1 10 10 cm 0 0 m 100 100 l S Q\n'.repeat(400));
    const font = new Uint8Array(30_000).map((_, i) => (i * 7) % 251);
    const z = zlibSync(font);
    const picture = zlibSync(zeros(64 * 64 * 3));
    const s = scanPdf(pdf(zlibSync(ops), ' /Filter /FlateDecode', {
      5: cat(enc(`<< /Length ${z.length} /Length1 ${font.length} /Filter /FlateDecode >>\nstream\n`), z, enc('\nendstream')),
      6: cat(enc(`<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${picture.length} /Filter /FlateDecode >>\nstream\n`), picture, enc('\nendstream')),
    }), LIMITS);
    expect(s.contentBytes).toBe(ops.length);
    expect(s.fontBytes).toBe(font.length);
    // Uncompressed content counts its own length.
    expect(scanPdf(pdf(ops), LIMITS).contentBytes).toBe(ops.length);
  });

  test('padding is left out of the content count, but not of the decoded bytes; Do operators and /Contents arrays are counted', () => {
    // A stream of zeros: the decoded bytes count in full, the content only for the first 32 bytes of the run.
    const big = zlibSync(zeros(4 << 20));
    const z = scanPdf(pdf(big, ' /Filter /FlateDecode'), LIMITS);
    expect(z.contentBytes).toBe(32);
    expect(z.rawContent).toBe(4 << 20);
    expect(z.largestRawContent).toBe(4 << 20);
    // Real drawing counts in full, whatever its size.
    const ops = enc('0 0 m 1 1 l S\n'.repeat(200_000));
    const d = scanPdf(pdf(zlibSync(ops), ' /Filter /FlateDecode'), LIMITS);
    expect(d.contentBytes).toBe(ops.length);
    expect(d.largestContent).toBe(ops.length);
    // A form drawn many times counts its content each time; a picture drawn counts nothing; the resources say which.
    const form = enc('0 0 m 9 9 l S\n'.repeat(50));
    const formObj = cat(enc(`<< /Type /XObject /Subtype /Form /BBox [0 0 9 9] /Length ${form.length} >>\nstream\n`), form, enc('\nendstream'));
    const picObj = enc('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream');
    const res = '<< /XObject << /Fm0 5 0 R /Im0 6 0 R >> >>';
    const uses = enc('q 0.1 0 0 0.1 5 5 cm /Fm0 Do Q\n'.repeat(1000) + '/Im0 Do\n'.repeat(500));
    const f = scanPdf(pdf(uses, '', { 5: formObj, 6: picObj }, res), LIMITS);
    expect(f.formExpansion).toBe(1000 * form.length);
    // Only forms that hold text count for reading text.
    expect(f.textFormExpansion).toBe(0);
    const label = enc('BT /F0 9 Tf (label) Tj ET');
    const labelObj = cat(enc(`<< /Type /XObject /Subtype /Form /BBox [0 0 9 9] /Length ${label.length} >>\nstream\n`), label, enc('\nendstream'));
    const t = scanPdf(pdf(enc('/Lb Do\n/Fm0 Do\n'.repeat(7)), '', { 5: formObj, 6: labelObj }, '<< /XObject << /Fm0 5 0 R /Lb 6 0 R >> >>'), LIMITS);
    expect(t.textFormExpansion).toBe(7 * label.length);
    expect(t.formExpansion).toBe(7 * label.length + 7 * form.length);
    expect(f.contentBytes).toBe(uses.length);
    // Without the resources naming it, a Do draws nothing known; "Do" inside a word, or after a number, is no operator.
    expect(scanPdf(pdf(uses, '', { 5: formObj, 6: picObj }), LIMITS).formExpansion).toBe(0);
    expect(scanPdf(pdf(enc('/Fm0 Done /Fm0 Do2 /Fm0 xDo /Fm0 1 Do /Fm0 Do'), '', { 5: formObj }, res), LIMITS).formExpansion).toBe(form.length);
    // A form drawn by a form counts each time the outer form is drawn; editing, which reads each form once, does not
    // multiply it.
    const outer = enc('/Fm0 Do\n'.repeat(20));
    const outerObj = cat(enc(`<< /Type /XObject /Subtype /Form /BBox [0 0 9 9] /Resources << /XObject << /Fm0 5 0 R >> >> /Length ${outer.length} >>\nstream\n`), outer, enc('\nendstream'));
    const nested = scanPdf(pdf(enc('/Fm1 Do /Fm1 Do'), '', { 5: formObj, 7: outerObj }, '<< /XObject << /Fm1 7 0 R >> >>'), LIMITS);
    expect(nested.formExpansion).toBe(2 * (outer.length + 20 * form.length));
    expect(nested.editFormExpansion).toBe(2 * outer.length + 20 * form.length);
    // The longest /Contents array in the file bounds one page's streams.
    const objs: Record<number, Uint8Array> = {};
    for (let n = 5; n < 9; n++) objs[n] = cat(enc(`<< /Length ${ops.length} >>\nstream\n`), ops, enc('\nendstream'));
    objs[9] = enc('<< /Type /Page /Parent 2 0 R /Contents [5 0 R 6 0 R 7 0 R 8 0 R] >>');
    expect(scanPdf(pdf(enc('q Q'), '', objs), LIMITS).maxContents).toBe(4);
    // A page dictionary inside an object stream: its /Contents array and its resources count the same way.
    const inner = enc('9 0 << /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm7 8 0 R >> >> /Contents [5 0 R 6 0 R 7 0 R] >>');
    const zs = zlibSync(inner);
    const objstm = cat(enc(`<< /Type /ObjStm /N 1 /First 4 /Length ${zs.length} /Filter /FlateDecode >>\nstream\n`), zs, enc('\nendstream'));
    const inStm = scanPdf(pdf(enc('/Fm7 Do\n'.repeat(10)), '', { 5: objstm, 8: formObj }), LIMITS);
    expect(inStm.maxContents).toBe(3);
    expect(inStm.formExpansion).toBe(10 * form.length);
  });
});

/** A PDF of the given objects (strings or bytes), in order, with a trailer. */
function doc(objs: Record<number, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [enc('%PDF-1.7\n')];
  for (const [n, body] of Object.entries(objs)) parts.push(enc(`${n} 0 obj\n`), typeof body === 'string' ? enc(body) : body, enc('\nendobj\n'));
  parts.push(enc('trailer\n<< /Size 9 /Root 1 0 R >>\n%%EOF\n'));
  return cat(...parts);
}
/** A stream object's body: its dictionary (with /Length) and data. */
const stm = (dict: string, data: string | Uint8Array) => { const d = typeof data === 'string' ? enc(data) : data; return cat(enc(`<< ${dict} /Length ${d.length} >>\nstream\n`), d, enc('\nendstream')); };
/** A form XObject drawing `content`, with the given resources (none when not given). */
const fm = (content: string, resources?: string) => stm(`/Type /XObject /Subtype /Form /BBox [0 0 9 9]${resources ? ` /Resources ${resources}` : ''}`, content);
const xo = (names: Record<string, number>) => `<< /XObject << ${Object.entries(names).map(([k, v]) => `/${k} ${v} 0 R`).join(' ')} >> >>`;
const LEAF = '0 0 m 9 9 l S\n'.repeat(50);
const head = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' };
/** One page drawing `content` with `resources`, and the given objects (from 5 on). */
const page = (content: string, resources: string, objs: Record<number, string | Uint8Array>) =>
  doc({ ...head, 3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Resources ${resources} /Contents 4 0 R >>`, 4: stm('', content), ...objs });
const refusedBy = (b: Uint8Array) => { try { scanPdf(b, LIMITS); return ''; } catch (e) { return (e as Error).message; } };

describe('forms drawn inside forms, as pdf.js reads them', () => {
  test('each level multiplies the one below it, through several levels', () => {
    const l1 = '/A Do\n'.repeat(10), l2 = '/B Do\n'.repeat(10), l3 = '/C Do\n'.repeat(10);
    const s = scanPdf(page('/D Do', xo({ D: 8 }), { 5: fm(LEAF), 6: fm(l1, xo({ A: 5 })), 7: fm(l2, xo({ B: 6 })), 8: fm(l3, xo({ C: 7 })) }));
    const c1 = l1.length + 10 * LEAF.length, c2 = l2.length + 10 * c1, c3 = l3.length + 10 * c2;
    expect(s.formExpansion).toBe(c3);
    expect(s.textFormExpansion).toBe(0);
    // Text forms deep down count for reading text, each time they are reached.
    const label = 'BT /F0 9 Tf (label) Tj ET';
    const t = scanPdf(page('/D Do', xo({ D: 7 }), { 5: fm(label), 6: fm(l1, xo({ A: 5 })), 7: fm(l2, xo({ B: 6 })) }));
    expect(t.textFormExpansion).toBe(100 * label.length);
    expect(t.formExpansion).toBe(l2.length + 10 * (l1.length + 10 * label.length));
  });

  test('a name is looked up in the resources of the form that draws it, not anywhere in the file', () => {
    // Page 1 draws X, form 5, which draws its own Fm0 (form 6) ten times; page 2's Fm0 is a large form, 8. Looked up
    // anywhere, form 5's Fm0 would be the large one.
    const big = '1 1 m 2 2 l S\n'.repeat(5000);
    const s = scanPdf(doc({
      ...head, 3: `<< /Type /Page /Parent 2 0 R /Resources ${xo({ X: 5 })} /Contents 4 0 R >>`, 4: stm('', '/X Do'),
      5: fm('/Fm0 Do\n'.repeat(10), xo({ Fm0: 6 })), 6: fm(LEAF), 8: fm(big),
      9: `<< /Type /Page /Parent 2 0 R /Resources ${xo({ Fm0: 8 })} /Contents 10 0 R >>`, 10: stm('', '/Fm0 Do'),
    }));
    const outer = '/Fm0 Do\n'.repeat(10).length;
    expect(s.formExpansion).toBe(outer + 10 * LEAF.length + big.length);
    // The same name at each level does not make a loop of it.
    const same = scanPdf(page('/Fm0 Do', xo({ Fm0: 5 }), { 5: fm('/Fm0 Do\n'.repeat(10), xo({ Fm0: 6 })), 6: fm('/Fm0 Do\n'.repeat(10), xo({ Fm0: 7 })), 7: fm(LEAF) }));
    expect(same.formExpansion).toBe(outer + 10 * (outer + 10 * LEAF.length));
  });

  test('resources and XObject dictionaries that are objects of their own, and ones in an object stream, are followed', () => {
    const outer = '/Fm0 Do\n'.repeat(10);
    const want = outer.length + 10 * LEAF.length;
    // /Resources 20 0 R, whose /XObject is 21 0 R.
    const a = scanPdf(page('/X Do', xo({ X: 5 }), { 5: fm(outer, '20 0 R'), 6: fm(LEAF), 20: '<< /XObject 21 0 R /ProcSet [/PDF] >>', 21: '<< /Fm0 6 0 R >>' }));
    expect(a.formExpansion).toBe(want);
    // /Resources << /XObject 21 0 R >>.
    expect(scanPdf(page('/X Do', xo({ X: 5 }), { 5: fm(outer, '<< /XObject 21 0 R >>'), 6: fm(LEAF), 21: '<< /Fm0 6 0 R >>' })).formExpansion).toBe(want);
    // The resources in an object stream, compressed or not.
    const objs = '20 0 21 24 ';
    const body = `${objs}<< /XObject 21 0 R >>   << /Fm0 6 0 R >>`;
    expect(body.indexOf('<< /Fm0')).toBe(objs.length + 24);
    for (const [filter, data] of [[' /Filter /FlateDecode', zlibSync(enc(body))], ['', enc(body)]] as const) {
      const st = stm(`/Type /ObjStm /N 2 /First ${objs.length}${filter}`, data);
      const r = scanPdf(page('/X Do', xo({ X: 5 }), { 5: fm(outer, '20 0 R'), 6: fm(LEAF), 30: st }));
      expect(r.formExpansion, filter || 'uncompressed').toBe(want);
    }
    // A reference split by a long run of padding (padding is not held, but still separates).
    const padded = `20 0 21 24 << /XObject 21 0 R >>   << /Fm0${' '.repeat(300_000)}6${'\0'.repeat(200_000)}0\n${' '.repeat(100_000)}R >>`;
    const pst = stm('/Type /ObjStm /N 2 /First 11 /Filter /FlateDecode', zlibSync(enc(padded)));
    expect(scanPdf(page('/X Do', xo({ X: 5 }), { 5: fm(outer, '20 0 R'), 6: fm(LEAF), 30: pst })).formExpansion).toBe(want);
    // The same with the padding exactly one decoded piece, between the name and the number: ASCIIHex data is decoded
    // in pieces of 128, 256, ... up to 32,768 bytes, so the name ends at 65,408 and the number starts at 98,176.
    const lead = '20 0 21 24 << /XObject 21 0 R >>   <<';
    const aligned = `${lead}${' '.repeat(65408 - lead.length - 4)}/Fm0${' '.repeat(32768)}6 0 R >>`;
    expect(aligned.indexOf('/Fm0') + 4).toBe(65408);
    const hex = [...enc(aligned)].map(c => c.toString(16).padStart(2, '0')).join('') + '>';
    const hst = stm('/Type /ObjStm /N 2 /First 11 /Filter /ASCIIHexDecode', hex);
    expect(scanPdf(page('/X Do', xo({ X: 5 }), { 5: fm(outer, '20 0 R'), 6: fm(LEAF), 30: hst })).formExpansion).toBe(want);
  });

  test('a form with no resources of its own takes the names of the one that draws it', () => {
    // Form 5 names X (form 6, with no resources) and Y (form 7); form 6 draws Y five times. Elsewhere Y is form 8, larger.
    const big = '1 1 m 2 2 l S\n'.repeat(5000);
    const s = scanPdf(doc({
      ...head, 3: `<< /Type /Page /Parent 2 0 R /Resources ${xo({ A: 5 })} /Contents 4 0 R >>`, 4: stm('', '/A Do'),
      5: fm('/X Do', xo({ X: 6, Y: 7 })), 6: fm('/Y Do\n'.repeat(5)), 7: fm(LEAF), 8: fm(big),
      9: `<< /Type /Page /Parent 2 0 R /Resources ${xo({ Y: 8 })} /Contents 10 0 R >>`, 10: stm('', 'q Q'),
    }));
    expect(s.formExpansion).toBe('/X Do'.length + '/Y Do\n'.repeat(5).length + 5 * LEAF.length);
  });

  test('forms that draw each other in a loop are read as pdf.js reads them: a form already being drawn is skipped', () => {
    const a = '/B Do\n'.repeat(3), b = '/A Do\n'.repeat(5);
    const objs = { 5: fm(a, xo({ B: 6 })), 6: fm(b, xo({ A: 5 })) };
    expect(scanPdf(page('/A Do', xo({ A: 5 }), objs)).formExpansion).toBe(a.length + 3 * b.length);
    expect(scanPdf(page('/A Do /B Do', xo({ A: 5, B: 6 }), objs)).formExpansion).toBe(a.length + 3 * b.length + b.length + 5 * a.length);
    // A form no page draws (an annotation's or a mask's, say) counts what it draws once, as before.
    expect(scanPdf(page('q Q', '<< >>', { 5: fm('/L Do\n'.repeat(10), xo({ L: 6 })), 6: fm(LEAF) })).formExpansion).toBe(10 * LEAF.length);
    // A form that draws itself.
    const self = '/S Do\n'.repeat(1000);
    expect(scanPdf(page('/S Do', xo({ S: 5 }), { 5: fm(self, xo({ S: 5 })) })).formExpansion).toBe(self.length);
  });

  test('forms nested too often, too deeply, or in loops too tangled to follow are refused, quickly', () => {
    // Seven levels of a thousand: 10^21 bytes of content.
    const objs: Record<number, string | Uint8Array> = { 5: fm(LEAF) };
    for (let i = 6; i < 13; i++) objs[i] = fm('/N Do\n'.repeat(1000), xo({ N: i - 1 }));
    let t = performance.now();
    expect(refusedBy(page('/N Do', xo({ N: 12 }), objs))).toMatch(/^This PDF draws forms inside forms so many times/);
    expect(performance.now() - t).toBeLessThan(2000);
    // Fourteen forms that each draw all the others: billions of ways through them.
    const all: Record<string, number> = {};
    for (let i = 0; i < 14; i++) all[`F${i}`] = 5 + i;
    const tangle: Record<number, string | Uint8Array> = {};
    for (let i = 0; i < 14; i++) tangle[5 + i] = fm(Object.keys(all).map(k => `/${k} Do`).join('\n'), xo(all));
    t = performance.now();
    expect(refusedBy(page('/F0 Do', xo(all), tangle))).toMatch(/^This PDF draws its forms inside one another in a way FileConvert cannot measure/);
    expect(performance.now() - t).toBeLessThan(5000);
    // A chain of 600 forms, each drawing the next.
    const chain: Record<number, string | Uint8Array> = { 5: fm(LEAF) };
    for (let i = 6; i < 606; i++) chain[i] = fm('/N Do', xo({ N: i - 1 }));
    expect(refusedBy(page('/N Do', xo({ N: 605 }), chain))).toMatch(/cannot measure \(in a loop, or nested too deeply or too often\)/);
  });

  test('an appearance many annotations share counts once for each, for drawing only', () => {
    const ap = '/G Do\n'.repeat(100);
    const want = (n: number) => n * (ap.length + 100 * LEAF.length);
    const annots = (n: number, body: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [100 + i, `<< /Type /Annot /Subtype /Stamp /Rect [0 0 9 9] ${body} >>`]));
    const list = (n: number) => Array.from({ length: n }, (_, i) => `${100 + i} 0 R`).join(' ');
    const forms = { 5: fm(ap, xo({ G: 6 })), 6: fm(LEAF) };
    const onPage = (annotsKey: string, objs: Record<number, string | Uint8Array>) =>
      doc({ ...head, 3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Contents 4 0 R /Annots ${annotsKey} >>`, 4: stm('', 'q Q'), ...forms, ...objs });
    // Appearances in each annotation, in a shared appearance dictionary, and among appearance states.
    const inline = scanPdf(onPage(`[${list(300)}]`, annots(300, '/AP << /N 5 0 R >>')));
    expect(inline.annotExpansion).toBe(want(300));
    expect(inline.formExpansion).toBe(0);
    expect(inline.textFormExpansion).toBe(0);
    expect(scanPdf(onPage(`[${list(300)}]`, { ...annots(300, '/AP 50 0 R'), 50: '<< /N 5 0 R /D 6 0 R >>' })).annotExpansion).toBe(want(300));
    expect(scanPdf(onPage(`[${list(300)}]`, { ...annots(300, '/AP << /N 51 0 R >> /AS /On'), 51: '<< /On 5 0 R /Off 6 0 R >>' })).annotExpansion).toBe(want(300));
    // An /Annots array that is an object of its own, used by two pages: drawn on each.
    const shared = doc({
      ...head, 3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots 60 0 R >>', 4: stm('', 'q Q'), ...forms, 60: `[${list(300)}]`, ...annots(300, '/AP << /N 5 0 R >>'),
      9: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots 60 0 R >>',
    });
    expect(scanPdf(shared).annotExpansion).toBe(want(600));
    // Annotations with no appearance (links) draw nothing.
    expect(scanPdf(onPage(`[${list(300)}]`, annots(300, '/A << /S /URI /URI (https://example.com) >>'))).annotExpansion).toBe(0);
  });

  test('a graphics state with a soft mask draws its mask each time it is set, on a page and inside forms', () => {
    const group = stm('/Type /XObject /Subtype /Form /BBox [0 0 9 9] /Group << /S /Transparency >>', LEAF);
    const sets = '/GS1 gs 0 0 9 9 re f\n'.repeat(500);
    // The mask in the graphics state, in a mask dictionary of its own, and a graphics state with no mask.
    expect(scanPdf(page(sets, '<< /ExtGState << /GS1 20 0 R >> >>', { 5: group, 20: '<< /Type /ExtGState /SMask << /S /Luminosity /G 5 0 R >> >>' })).formExpansion).toBe(500 * LEAF.length);
    expect(scanPdf(page(sets, '<< /ExtGState << /GS1 20 0 R >> >>', { 5: group, 20: '<< /Type /ExtGState /SMask 21 0 R >>', 21: '<< /S /Luminosity /G 5 0 R >>' })).formExpansion).toBe(500 * LEAF.length);
    expect(scanPdf(page(sets, '<< /ExtGState << /GS1 20 0 R >> >>', { 5: group, 20: '<< /Type /ExtGState /ca 0.5 >>' })).formExpansion).toBe(0);
    // Inside a form drawn 100 times, its graphics state written out in full in the form's resources.
    const user = fm(sets, '<< /ExtGState << /GS1 << /SMask << /S /Luminosity /G 5 0 R >> >> >> >>');
    const inForms = scanPdf(page('/U Do\n'.repeat(100), xo({ U: 6 }), { 5: group, 6: user }));
    expect(inForms.formExpansion).toBe(100 * (sets.length + 500 * LEAF.length));
    // Each mask set is counted for the page that sets it (each takes page-sized canvases); a state with no mask is not.
    expect(inForms.maskDraws).toBe(100 * 500);
    expect(scanPdf(page(sets, '<< /ExtGState << /GS1 20 0 R >> >>', { 5: group, 20: '<< /Type /ExtGState /SMask << /S /Luminosity /G 5 0 R >> >>' })).maskDraws).toBe(500);
    expect(scanPdf(page(sets, '<< /ExtGState << /GS1 20 0 R >> >>', { 5: group, 20: '<< /Type /ExtGState /ca 0.5 >>' })).maskDraws).toBe(0);
    // The costliest page and the page before it, not all of them: 200 pages that each set a mask once count two.
    const pagesOf: Record<number, string | Uint8Array> = { 5: group, 20: '<< /Type /ExtGState /SMask << /S /Luminosity /G 5 0 R >> >>' };
    for (let i = 0; i < 199; i++) pagesOf[30 + i] = stm('', '/GS1 gs 0 0 9 9 re f');
    expect(scanPdf(page('/GS1 gs 0 0 9 9 re f', '<< /ExtGState << /GS1 20 0 R >> >>', pagesOf)).maskDraws).toBe(2);
  });

  test('patterns and shadings are read again each time a form that paints with them is drawn, once per drawing', () => {
    const tile = stm('/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 9 9] /XStep 9 /YStep 9 /Resources << >>', LEAF);
    const fills = '/Pattern cs /P0 scn 0 0 9 9 re f\n'.repeat(20);
    const s = scanPdf(page('/F Do\n'.repeat(300), xo({ F: 6 }), { 5: tile, 6: fm(fills, '<< /Pattern << /P0 5 0 R >> >>') }));
    expect(s.formExpansion).toBe(300 * (fills.length + LEAF.length));
    const meshData = new Uint8Array(30_000).map((_, i) => (i * 13) % 251 || 1);
    const meshObj = stm('/ShadingType 4 /ColorSpace /DeviceGray /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 9 0 9 0 1]', meshData);
    expect(scanPdf(page('/F Do\n'.repeat(300), xo({ F: 6 }), { 5: meshObj, 6: fm('/Sh0 sh\n'.repeat(5), '<< /Shading << /Sh0 5 0 R >> >>') })).formExpansion).toBe(300 * ('/Sh0 sh\n'.repeat(5).length + meshData.length));
    // A shading pattern's mesh, through the pattern.
    const viaPattern = scanPdf(page('/F Do\n'.repeat(300), xo({ F: 6 }), { 5: meshObj, 7: '<< /PatternType 2 /Shading 5 0 R >>', 6: fm('/Pattern cs /P1 scn 0 0 9 9 re f', '<< /Pattern << /P1 7 0 R >> >>') }));
    expect(viaPattern.formExpansion).toBe(300 * ('/Pattern cs /P1 scn 0 0 9 9 re f'.length + meshData.length));
  });

  test('a font written out in full in a form is loaded each time the form is drawn; one of its own object, once', () => {
    const text = 'BT /F1 9 Tf (label) Tj ET';
    const inline = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';
    const s = scanPdf(page('/T Do\n'.repeat(400), xo({ T: 5 }), { 5: fm(text, inline) }));
    expect(s.formFontBytes).toBe(400 * 600 * 1024);
    expect(s.textFormExpansion).toBe(400 * text.length);
    // The largest embedded program counts when it is larger.
    const prog = new Uint8Array(900_000).map((_, i) => (i * 7) % 251);
    const big = scanPdf(page('/T Do\n'.repeat(400), xo({ T: 5 }), { 5: fm(text, inline), 9: stm(`/Length1 ${prog.length}`, prog) }));
    expect(big.formFontBytes).toBe(400 * prog.length);
    // A font of its own object, or resources of their own object, are loaded once (pdf.js keeps them).
    for (const res of ['<< /Font << /F1 20 0 R >> >>', '30 0 R', '<< /Font 31 0 R >>']) {
      const r = scanPdf(page('/T Do\n'.repeat(400), xo({ T: 5 }), { 5: fm(text, res), 20: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 30: inline, 31: '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>' }));
      expect(r.formFontBytes, res).toBe(0);
    }
    // 50 pages of it at most, as for content.
    const spread: Record<number, string | Uint8Array> = { 5: fm(text, inline) };
    for (let i = 0; i < 199; i++) spread[10 + i] = stm('', '/T Do');
    expect(scanPdf(page('/T Do', xo({ T: 5 }), spread)).formFontBytes).toBe(50 * 600 * 1024);
  });

  test('the 50 pages pdf.js holds are the costliest ones, however many cheap pages the file has', () => {
    const spread: Record<number, string | Uint8Array> = { 5: fm(LEAF) }, heavy: Record<number, string | Uint8Array> = { 5: fm(LEAF) };
    for (let i = 0; i < 199; i++) { spread[10 + i] = stm('', '/Fm0 Do'); heavy[10 + i] = stm('', 'q Q'); }
    // 200 pages that draw the form once each hold 50 of it; one page that draws it 200 times holds all 200.
    expect(scanPdf(page('/Fm0 Do', xo({ Fm0: 5 }), spread)).formExpansion).toBe(50 * LEAF.length);
    expect(scanPdf(page('/Fm0 Do\n'.repeat(200), xo({ Fm0: 5 }), heavy)).formExpansion).toBe(200 * LEAF.length);
  });

  test('names and references are read as pdf.js reads them: escapes, NUL and comments as white space, +12 and 12.0', () => {
    const want = LEAF.length;
    expect(scanPdf(page('/F#6d0 Do', xo({ Fm0: 5 }), { 5: fm(LEAF) })).formExpansion).toBe(want);
    for (const res of ['<< /XObject << /Fm0\u00005\u00000\u0000R >> >>', '<< /XObject << /Fm0 %note\n5 0 R >> >>', '<< /XObject << /Fm0 +5 0 R >> >>', '<< /XObject << /Fm0 5.0 0 R >> >>', '<< /XObject << /F#6d0 5 0 R >> >>']) {
      expect(scanPdf(page('/Fm0 Do', res, { 5: fm(LEAF) })).formExpansion, JSON.stringify(res)).toBe(want);
    }
    // The same in a form's own resources, which are read as a dictionary.
    for (const res of ['<< /XObject << /F#6d0 6 0 R >> >>', '<< /XObject << /Fm0 +6 0 R >> >>', '<< /XObject << /Fm0 6.0 0 R >> >>']) {
      expect(scanPdf(page('/X Do', xo({ X: 5 }), { 5: fm('/Fm0 Do\n'.repeat(10), res), 6: fm(LEAF) })).formExpansion, res).toBe('/Fm0 Do\n'.repeat(10).length + 10 * LEAF.length);
    }
    // A name longer than 127 characters is compared on its first 127.
    const long = 'N'.repeat(200);
    expect(scanPdf(page(`/${long} Do`, `<< /XObject << /${long} 5 0 R >> >>`, { 5: fm(LEAF) })).formExpansion).toBe(want);
  });

  test('a form whose dictionary cannot be read is still followed, with any name in the file', () => {
    // A dictionary of more than 1 MB is not read; pdf.js may read it as a form.
    const junk = `(${'x'.repeat(1_100_000)})`;
    const inner = '/Fm0 Do\n'.repeat(100);
    const u = cat(enc(`<< /Type /XObject /Subtype /Form /Junk ${junk} /Resources ${xo({ Fm0: 5 })} /Length ${inner.length} >>\nstream\n`), enc(inner), enc('\nendstream'));
    const s = scanPdf(page('/U Do\n'.repeat(100), xo({ U: 6 }), { 5: fm(LEAF), 6: u }));
    expect(s.formExpansion).toBeGreaterThanOrEqual(100 * 100 * LEAF.length);
  });

  test('a /Contents array that is an object of its own bounds one page as well', () => {
    const s = scanPdf(doc({ ...head, 3: '<< /Type /Page /Parent 2 0 R /Contents 30 0 R >>', 30: '[5 0 R 6 0 R 7 0 R]', 5: stm('', 'q Q'), 6: stm('', 'q Q'), 7: stm('', 'q Q') }));
    expect(s.maxContents).toBe(3);
  });

  test('ordinary nested forms stay small: a letterhead with a logo on 120 pages', () => {
    const letterhead = 'q 1 0 0 1 9 9 cm /Logo Do Q\n0 0 m 9 0 l S\n';
    const objs: Record<number, string | Uint8Array> = { 5: fm(LEAF), 6: fm(letterhead, xo({ Logo: 5 })) };
    for (let i = 0; i < 119; i++) objs[10 + i] = stm('', 'q /L Do Q BT /F0 9 Tf (text) Tj ET');
    const s = scanPdf(page('q /L Do Q BT /F0 9 Tf (text) Tj ET', xo({ L: 6 }), objs));
    expect(s.formExpansion).toBe(50 * (letterhead.length + LEAF.length));
    expect(s.editFormExpansion).toBe(120 * letterhead.length + LEAF.length);
  });
});

describe('ordinary PDFs with many small streams', () => {
  test('3,000 pages of small compressed content in a 1 MB file pass the guard quickly', () => {
    // Each page's content is a few dozen compressed bytes: feeding every stream 64 KB at a time once counted as
    // 190 MB of work for this file and refused it as far more work than its size suggests.
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const offs: number[] = [];
    let at = 0;
    const put = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); at += u.length; };
    const N = 3000;
    put('%PDF-1.7\n');
    const obj = (n: number, body: string, stream?: Uint8Array) => {
      offs[n] = at;
      put(`${n} 0 obj\n${body}`);
      if (stream) { put('\nstream\n'); put(stream); put('\nendstream'); }
      put('\nendobj\n');
    };
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${Array.from({ length: N }, (_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${N} >>`);
    for (let i = 0; i < N; i++) {
      const data = zlibSync(enc.encode(`BT /F1 12 Tf 72 700 Td (Page ${i + 1}) Tj ET`));
      obj(3 + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${4 + 2 * i} 0 R >>`);
      obj(4 + 2 * i, `<< /Length ${data.length} /Filter /FlateDecode >>`, data);
    }
    const size = 3 + 2 * N;
    const xref = at;
    put(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let k = 1; k < size; k++) put(`${String(offs[k]).padStart(10, '0')} 00000 n \n`);
    put(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const bytes = new Uint8Array(at);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    expect(bytes.length).toBeLessThan(1_000_000);
    const t = performance.now();
    const scan = scanPdf(bytes);
    expect(scan.pages).toBe(N);
    expect(scan.streams).toBe(N);
    expect(performance.now() - t).toBeLessThan(5000);
  });

  test('a thousand small JPEG pictures pass: each picture header is read from the picture only', () => {
    // A picture's header was read from the first 256 KB after its start, past its own end, so a manual with thousands
    // of small JPEG pictures (a 209 MB software manual has 9,268) counted the bytes after each one as work and was
    // refused as far more work to read than its size suggests.
    const enc = new TextEncoder();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, ...new Uint8Array(200), 0xff, 0xd9]);
    const N = 1000;
    const parts: Uint8Array[] = [enc.encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n')];
    for (let i = 0; i < N; i++) {
      parts.push(enc.encode(`${10 + i} 0 obj\n<< /Type /XObject /Subtype /Image /Width 32 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, enc.encode('\nendstream\nendobj\n'));
    }
    parts.push(enc.encode(`trailer\n<< /Size ${10 + N} /Root 1 0 R >>\n%%EOF\n`));
    const bytes = cat(...parts);
    expect(bytes.length).toBeLessThan(400_000);
    const scan = scanPdf(bytes);
    expect(scan.images).toBe(N);
    expect(scan.largestImagePixels).toBe(32 * 16);
  });
});

describe('the resources a content stream uses', () => {
  test('fonts, XObjects, graphics states, shadings, color spaces, patterns and properties, and nothing in strings', () => {
    const used = usedResources(enc('/GS1 gs BT /F1 12 Tf (/Fake Do) Tj ET q /Im0 Do Q /Sh0 sh /CS0 cs /P0 scn /OC /MC0 BDC EMC /Span << /MCID 1 >> BDC EMC [/Not /Used] TJ'))!;
    expect(Object.fromEntries(Object.entries(used).map(([k, v]) => [k, [...v]]))).toEqual({
      Font: ['F1'], XObject: ['Im0'], ExtGState: ['GS1'], Shading: ['Sh0'], ColorSpace: ['CS0'], Pattern: ['P0'], Properties: ['MC0'],
    });
  });

  test('an inline picture is skipped to its EI, and its named color space counts', () => {
    const used = usedResources(cat(enc('BI /W 2 /H 1 /CS /CSi /BPC 8 ID '), new Uint8Array([0x44, 0x6f, 0x20, 0x2f]), enc(' EI /Im1 Do')))!;
    expect([...used.ColorSpace]).toEqual(['CSi']);
    expect([...used.XObject]).toEqual(['Im1']);
  });

  test('a content stream that cannot be read safely gives null, so its resources are kept whole', () => {
    expect(usedResources(enc('(unterminated'))).toBeNull();
    expect(usedResources(enc('] ] /Im0 Do'))).toBeNull();
  });
});
