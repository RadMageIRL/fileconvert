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
    // A form drawn by a form counts for each Do in the outer form's content.
    const outer = enc('/Fm0 Do\n'.repeat(20));
    const outerObj = cat(enc(`<< /Type /XObject /Subtype /Form /BBox [0 0 9 9] /Resources << /XObject << /Fm0 5 0 R >> >> /Length ${outer.length} >>\nstream\n`), outer, enc('\nendstream'));
    const nested = scanPdf(pdf(enc('/Fm1 Do /Fm1 Do'), '', { 5: formObj, 7: outerObj }, '<< /XObject << /Fm1 7 0 R >> >>'), LIMITS);
    expect(nested.formExpansion).toBe(2 * outer.length + 20 * form.length);
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
