// The PDF guard. Before pdf.js or the PDF editing library reads a file, this reads it as bytes, with no PDF
// library, and refuses it when reading it would take more memory than it should:
//
// - Every stream with an expanding filter (Flate, LZW, RunLength, ASCII85, ASCIIHex, and chains of them, with
//   predictors) is decoded as a count, in pieces, through its own filters (./filters.ts), and stopped as soon as
//   one stream, all streams, or the object streams a library keeps in memory pass their limits. Nothing is kept,
//   so measuring a stream that would expand to gigabytes holds a few kilobytes. pdf.js decodes fonts and large
//   pictures whole, and the editing library decodes every object stream on load, so declared sizes and picture
//   dimensions are never trusted for this.
// - Sizes that readers allocate from directly are checked: picture dimensions (in the dictionary, and in the
//   JPEG or JPEG 2000 header itself), sampled functions, and the rows predictors and fax decoders work on.
// - Objects and page dictionaries are counted, in the file and inside object streams.
// - Encrypted files cannot be measured (their streams are unreadable without the key), so they are reported, and
//   FileConvert refuses them (v0.2.0 does not decrypt). Brotli-compressed streams are refused.
//
// The limits are in src/core/limits.ts. The scan is synchronous; it runs in a worker, which is stopped to cancel it.

import { LIMITS, LimitError } from '../../core/limits';
import { Ascii85Stage, AsciiHexStage, FlateStage, LzwStage, PredictorStage, RunLengthStage, type Sink, type Stage } from './filters';
import { isDict, isName, isRef, num, ObjReader, type PdfDict, type PdfValue } from './pdfobj';

export type PdfLimits = Record<'pdfBytes' | 'pdfPages' | 'pdfStreamBytes' | 'pdfDecodedBytes' | 'pdfObjectStreamBytes' | 'pdfObjects' | 'pdfImagePixels' | 'pdfFunctionSamples' | 'pdfRowBytes', number>;

export interface PdfScan {
  /** The version in the header, such as "1.7", or null when there is none. */
  version: string | null;
  encrypted: boolean;
  /** Indirect objects, in the file and in object streams. */
  objects: number;
  /** Page dictionaries (/Type /Page), in the file and in object streams. */
  pages: number;
  streams: number;
  objectStreams: number;
  /** Bytes all expanding filters produce together, intermediate stages included. */
  decodedBytes: number;
  /** Bytes outside stream data (object headers, dictionaries, arrays, the cross-reference table): what a PDF library
   *  parses into objects when it loads the file. */
  textBytes: number;
  /** Bytes the object streams decode to, which a PDF library also parses into objects. */
  objectStreamBytes: number;
  largestStream: number;
  /** Bytes of page content once decoded: the streams that are not pictures, fonts, profiles or object streams, each up
   *  to 128 KB (CONTENT_COUNTED). Reading text and the cleanup's look at what each page uses read all of it. */
  contentBytes: number;
  /** Bytes of embedded font programs once decoded. pdf.js reads and converts every font a page uses, to read its text
   *  or to draw it. */
  fontBytes: number;
  images: number;
  largestImagePixels: number;
  /** Pixels of the largest JPEG 2000 picture, from its own header: decoding one costs more than a JPEG. */
  largestJpxPixels: number;
  /** A digital signature is likely (a signature dictionary or a byte range was seen); the parsed check decides. */
  signatureHint: boolean;
  /** Pictures compressed with JBIG2 or JPEG 2000. */
  jbig2: number;
  jpx: number;
  /** Soft mask dictionaries (/S /Luminosity or /S /Alpha): drawing a page that uses one takes several page-sized
   *  canvases, so drawing pages of such a PDF is estimated higher. */
  softMasks: number;
}

const enc = (s: string) => new TextEncoder().encode(s);
const STREAM = enc('stream');
const ENDSTREAM = enc('endstream');
const latin1 = new TextDecoder('latin1');
const MB = 1048576;
/**
 * Page content counts for the memory estimate up to this much per stream. What costs memory is many small text items;
 * a stream past this is a drawing (paths cost little per byte: a 40-page drawing with 260 KB a page needed no more
 * memory to edit than a plain file), or padding, which would otherwise make an ordinary file look like gigabytes.
 */
const CONTENT_COUNTED = 128 * 1024;
const mb = (n: number) => `${Math.round(n / MB).toLocaleString('en-US')} MB`;

const FILTER_NAMES: Record<string, string> = {
  FlateDecode: 'Flate', Fl: 'Flate', LZWDecode: 'LZW', LZW: 'LZW', ASCIIHexDecode: 'AHx', AHx: 'AHx',
  ASCII85Decode: 'A85', A85: 'A85', RunLengthDecode: 'RL', RL: 'RL', DCTDecode: 'DCT', DCT: 'DCT',
  CCITTFaxDecode: 'CCF', CCF: 'CCF', JBIG2Decode: 'JBIG2', JPXDecode: 'JPX', Crypt: 'Crypt', BrotliDecode: 'Brotli', Br: 'Brotli',
};

function find(h: Uint8Array, n: Uint8Array, from: number): number {
  for (let i = h.indexOf(n[0], from); i >= 0 && i <= h.length - n.length; i = h.indexOf(n[0], i + 1)) {
    let k = 1;
    while (k < n.length && h[i + k] === n[k]) k++;
    if (k === n.length) return i;
  }
  return -1;
}

/** Counts what passes through, against one stream's limit and the file's total; then passes it on. */
class Counter implements Sink {
  count = 0;
  constructor(private scan: Scanner, private next: Sink | null, private what: string) {}
  push(chunk: Uint8Array): void {
    this.count += chunk.length;
    this.scan.add(chunk.length, this.count, this.what);
    this.next?.push(chunk);
  }
  end(): void { this.next?.end(); }
}

/** Keeps the first bytes that pass, for reading a picture's own header. */
class Head implements Sink {
  bytes = new Uint8Array(0);
  constructor(private max: number) {}
  push(chunk: Uint8Array): void {
    if (this.bytes.length >= this.max) return;
    const take = chunk.subarray(0, this.max - this.bytes.length);
    const joined = new Uint8Array(this.bytes.length + take.length);
    joined.set(this.bytes);
    joined.set(take, this.bytes.length);
    this.bytes = joined;
  }
  end(): void { /* nothing */ }
}

/** Looks for page dictionaries in the decoded text of an object stream, across piece boundaries. */
class PageCounter implements Sink {
  pages = 0;
  softMasks = 0;
  signature = false;
  private tail = '';
  push(chunk: Uint8Array): void {
    const text = this.tail + latin1.decode(chunk);
    this.pages += countPages(text);
    this.softMasks += countSoftMasks(text);
    if (/\/ByteRange|\/Type\s*\/Sig\b/.test(text)) this.signature = true;
    // Keep enough to see a key split between two pieces, without counting it twice.
    const cut = Math.max(0, text.length - 24);
    this.tail = text.slice(cut).replace(/^[^/]*/, '');
  }
  end(): void { /* nothing */ }
}

const countPages = (text: string) => (text.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g) ?? []).length;
const countSoftMasks = (text: string) => (text.match(/\/S\s*\/(?:Luminosity|Alpha)(?![A-Za-z0-9])/g) ?? []).length;

/** The width and height in a JPEG's frame header, or null. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** The image size in a JPEG 2000 codestream's SIZ marker (bare, or inside a JP2 file), or null. */
export function jpxSize(b: Uint8Array): { width: number; height: number } | null {
  const at = find(b, new Uint8Array([0xff, 0x4f, 0xff, 0x51]), 0);
  if (at < 0 || at + 22 > b.length) return null;
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const xsiz = u32(at + 8), ysiz = u32(at + 12), x0 = u32(at + 16), y0 = u32(at + 20);
  return { width: Math.max(0, xsiz - x0), height: Math.max(0, ysiz - y0) };
}

class Scanner {
  decoded = 0;
  objectStreamBytes = 0;
  fed = 0;
  report: PdfScan = {
    version: null, encrypted: false, objects: 0, pages: 0, streams: 0, objectStreams: 0, decodedBytes: 0, textBytes: 0,
    objectStreamBytes: 0, largestStream: 0, contentBytes: 0, fontBytes: 0, images: 0, largestImagePixels: 0, largestJpxPixels: 0, signatureHint: false, jbig2: 0, jpx: 0, softMasks: 0,
  };
  constructor(private b: Uint8Array, private L: PdfLimits) {}

  /** Called for every decoded piece: checks one stream's size and the file's total. */
  add(n: number, streamSoFar: number, what: string): void {
    this.decoded += n;
    if (streamSoFar > this.report.largestStream) this.report.largestStream = streamSoFar;
    if (streamSoFar > this.L.pdfStreamBytes) throw new LimitError(`This PDF has ${what} that expands past ${mb(this.L.pdfStreamBytes)} when decompressed, far more than a document needs, so it was not opened (a "decompression bomb" makes a small file use gigabytes of memory).`);
    if (this.decoded > this.L.pdfDecodedBytes) throw new LimitError(`This PDF's compressed data expands past ${mb(this.L.pdfDecodedBytes)} in all, the limit, so it was not opened.`);
  }

  run(): PdfScan {
    const b = this.b;
    if (b.length > this.L.pdfBytes) throw new LimitError(`The PDF is larger than ${mb(this.L.pdfBytes)}, the limit.`);
    const head = latin1.decode(b.subarray(0, 1024));
    const v = /%PDF-(\d\.\d)/.exec(head);
    this.report.version = v ? v[1] : null;
    let text = 0; // start of the text not yet examined (outside stream data)
    for (let at = find(b, STREAM, 0); at >= 0; at = find(b, STREAM, at + 1)) {
      // "endstream", or "stream" inside a word, is not a stream keyword.
      if (at >= 3 && b[at - 3] === 101 && b[at - 2] === 110 && b[at - 1] === 100) continue;
      const after = b[at + 6];
      if (after !== 10 && after !== 13 && after !== 32) continue;
      if (at < text) continue;
      this.examineText(text, at);
      const start = at + 6 + (after === 13 && b[at + 7] === 10 ? 2 : 1);
      const dict = this.dictBefore(at, text);
      const end = this.stream(dict, start);
      text = end;
      at = Math.max(at, end - 1);
    }
    this.examineText(text, b.length);
    this.report.decodedBytes = this.decoded;
    this.report.objectStreamBytes = this.objectStreamBytes;
    if (this.report.objects > this.L.pdfObjects) throw new LimitError(`This PDF has ${this.report.objects.toLocaleString('en-US')} objects; the limit is ${this.L.pdfObjects.toLocaleString('en-US')}.`);
    if (this.report.pages > this.L.pdfPages) throw new LimitError(`This PDF has ${this.report.pages.toLocaleString('en-US')} pages; the limit is ${this.L.pdfPages.toLocaleString('en-US')}.`);
    return this.report;
  }

  /** Text between streams: object headers, page dictionaries, trailers. */
  private examineText(from: number, to: number): void {
    if (to <= from) return;
    this.report.textBytes += to - from;
    // Large text regions are read in pieces that overlap a little, so a key is never cut in two.
    for (let p = from; p < to; p += 4 * MB) {
      const text = latin1.decode(this.b.subarray(p, Math.min(to, p + 4 * MB + 32)));
      const own = p + 4 * MB >= to ? text : text.slice(0, 4 * MB);
      this.report.objects += (own.match(/\d+\s+\d+\s+obj\b/g) ?? []).length;
      this.report.pages += countPages(own);
      this.report.softMasks += countSoftMasks(own);
      if (/\/ByteRange|\/Type\s*\/Sig\b/.test(text)) this.report.signatureHint = true;
      for (const m of text.matchAll(/trailer\s*<</g)) {
        const d = this.readDict(p + (m.index ?? 0) + m[0].length - 2);
        if (d && 'Encrypt' in d) this.report.encrypted = true;
      }
    }
  }

  private readDict(pos: number): PdfDict | null {
    try {
      const v = new ObjReader(this.b, pos, Math.min(this.b.length, pos + 1 * MB)).read();
      return isDict(v) ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * The dictionary in front of a "stream" keyword: read forward from the object header that starts it, looking no
   * further back than the end of the previous stream (so a file of many streams is read once, not once per stream).
   */
  private dictBefore(at: number, lower: number): PdfDict {
    const from = Math.max(lower, at - 256 * 1024);
    const window = latin1.decode(this.b.subarray(from, at));
    const re = /\d+\s+\d+\s+obj\b/g;
    let last = -1;
    for (let m = re.exec(window); m; m = re.exec(window)) last = m.index + m[0].length;
    if (last < 0) return {};
    const d = this.readDict(from + last);
    return d ?? {};
  }

  /** Measures one stream; returns where the text after it starts. */
  private stream(dict: PdfDict, start: number): number {
    const b = this.b;
    const r = this.report;
    r.streams++;
    // Where the data ends, for continuing the scan: its /Length when "endstream" follows it, else the next "endstream".
    const len = num(dict.Length);
    let end = -1;
    if (len !== null && len >= 0 && start + len <= b.length) {
      let e = start + len;
      while (e < b.length && (b[e] === 10 || b[e] === 13 || b[e] === 32)) e++;
      if (find(b.subarray(e, e + 9), ENDSTREAM, 0) === 0) end = e + 9;
    }
    if (end < 0) {
      const e = find(b, ENDSTREAM, start);
      end = e < 0 ? b.length : e + 9;
    }
    const type = isName(dict.Type) ? dict.Type.name : '';
    if (type === 'XRef' && 'Encrypt' in dict) r.encrypted = true;
    if (type === 'XRef') {
      const index = Array.isArray(dict.Index) ? dict.Index : [0, num(dict.Size) ?? 0];
      let entries = 0;
      for (let i = 1; i < index.length; i += 2) entries += Math.max(0, num(index[i]) ?? 0);
      if (entries > this.L.pdfObjects * 4) throw new LimitError(`This PDF's cross-reference stream claims ${entries.toLocaleString('en-US')} entries, far more than the file holds, so it was not opened.`);
    }
    const objstm = type === 'ObjStm';
    if (objstm) {
      r.objectStreams++;
      r.objects += Math.max(0, num(dict.N) ?? 0);
    }
    const image = isName(dict.Subtype, 'Image');
    if (image) {
      r.images++;
      const w = num(dict.Width), h = num(dict.Height);
      if (w !== null && h !== null) this.picture(w, h, 'dictionary');
    }
    if (num(dict.FunctionType) === 0 && Array.isArray(dict.Size)) {
      let samples = 1;
      for (const s of dict.Size) samples *= Math.max(1, num(s) ?? 1);
      samples *= Math.max(1, Array.isArray(dict.Range) ? dict.Range.length / 2 : 1);
      if (samples > this.L.pdfFunctionSamples) throw new LimitError(`This PDF has a sampled function with ${samples.toLocaleString('en-US')} samples; the limit is ${this.L.pdfFunctionSamples.toLocaleString('en-US')}, so it was not opened.`);
    }
    const filters = this.filters(dict);
    if (filters.some(f => f.name === 'Brotli')) throw new Error('This PDF uses Brotli compression, which FileConvert does not open.');
    const what = objstm ? 'an object stream' : image ? 'a picture' : 'a stream';
    // The stages, last first: a counter at the end, the image codec's header reader if there is one.
    const CODECS = ['DCT', 'JPX', 'JBIG2', 'CCF'];
    if (filters.slice(0, -1).some(f => CODECS.includes(f.name))) throw new Error('This PDF uses an unusual chain of compression filters (a picture codec followed by another filter), so it was not opened.');
    const codec = filters.length && CODECS.includes(filters[filters.length - 1].name) ? filters[filters.length - 1] : null;
    const expanding = filters.slice(0, codec ? -1 : undefined).filter(f => f.name !== 'Crypt');
    if (codec?.name === 'JBIG2') r.jbig2++;
    if (codec?.name === 'JPX') r.jpx++;
    if (codec?.name === 'CCF') this.row(num(codec.parms.Columns) ?? 1728, 1, 1, 'a fax picture');
    const headSink = codec && (codec.name === 'DCT' || codec.name === 'JPX') ? new Head(256 * 1024) : null;
    const pages = objstm ? new PageCounter() : null;
    // A font program (FontFile, FontFile2, FontFile3) or page content, as far as a dictionary tells: content has no type
    // or subtype and is not a color profile.
    const font = 'Length1' in dict || 'Length2' in dict || 'Length3' in dict || isName(dict.Subtype, 'Type1C') || isName(dict.Subtype, 'CIDFontType0C') || isName(dict.Subtype, 'OpenType');
    const plain = !font && !type && !image && !('Subtype' in dict) && !('N' in dict) && !codec;
    const tally = { n: 0, push(c: Uint8Array) { this.n += c.length; }, end() { /* nothing */ } };
    let next: Sink = headSink ?? pages ?? tally;
    let objectCounter: Counter | null = null;
    if (objstm) next = objectCounter = new Counter(this, next, what);
    const stages: Stage[] = [];
    for (let i = expanding.length - 1; i >= 0; i--) {
      const f = expanding[i];
      const predictor = num(f.parms.Predictor) ?? 1;
      if ((f.name === 'Flate' || f.name === 'LZW') && predictor > 1) {
        const columns = num(f.parms.Columns) ?? 1, colors = num(f.parms.Colors) ?? 1, bpc = num(f.parms.BitsPerComponent) ?? 8;
        this.row(columns, colors, bpc, what);
        const counted = i === expanding.length - 1 && objectCounter ? next : new Counter(this, next, what);
        next = new PredictorStage(counted, predictor, columns, colors, bpc);
      }
      const out = i === expanding.length - 1 && objectCounter && !(predictor > 1 && (f.name === 'Flate' || f.name === 'LZW')) ? next : new Counter(this, next, what);
      const stage: Stage | null = f.name === 'Flate' ? new FlateStage(out)
        : f.name === 'LZW' ? new LzwStage(out, num(f.parms.EarlyChange) ?? 1)
        : f.name === 'RL' ? new RunLengthStage(out)
        : f.name === 'AHx' ? new AsciiHexStage(out)
        : f.name === 'A85' ? new Ascii85Stage(out)
        : null;
      if (!stage) continue;
      stages.unshift(stage);
      next = stage;
    }
    if (stages.length || headSink) {
      // Feed from the data's start until the first stage reaches its own end of data.
      const first = stages[0];
      const sink: Sink = first ?? headSink!;
      // A picture's header is read from its own data only: reading on past a small picture counted the bytes after
      // it as work, so a manual with thousands of small JPEG pictures was refused as too much work to read.
      const stop = first ? b.length : Math.min(end, start + 256 * 1024);
      // Pieces grow from 256 bytes to 64 KB: a short stream is not fed (and its feeding counted) far past its own end,
      // which made a file of thousands of small streams look like far more work than it is, while a long stream is
      // soon read 64 KB at a time. The work limit below is unchanged.
      for (let p = start, size = 256; p < stop && !(first?.done); p += size, size = Math.min(65536, size * 2)) {
        const piece = b.subarray(p, Math.min(stop, p + size));
        this.fed += piece.length;
        if (this.fed > b.length * 8 + 64 * MB) throw new LimitError('This PDF\'s structure makes it far more work to read than its size suggests, so it was not opened.');
        sink.push(piece);
      }
      sink.end();
    }
    const streamSize = stages.length ? tally.n : Math.max(0, len ?? end - start - 9);
    if (plain) r.contentBytes += Math.min(streamSize, CONTENT_COUNTED);
    else if (font && !codec) r.fontBytes += streamSize;
    if (objectCounter) {
      this.objectStreamBytes += objectCounter.count;
      if (this.objectStreamBytes > this.L.pdfObjectStreamBytes) throw new LimitError(`This PDF's object streams expand past ${mb(this.L.pdfObjectStreamBytes)} in all, the limit, so it was not opened.`);
    }
    if (pages) {
      r.pages += pages.pages;
      r.softMasks += pages.softMasks;
      if (pages.signature) r.signatureHint = true;
    }
    if (headSink) {
      const size = codec!.name === 'DCT' ? jpegSize(headSink.bytes) : jpxSize(headSink.bytes);
      if (size) this.picture(size.width, size.height, codec!.name === 'DCT' ? 'JPEG data' : 'JPEG 2000 data');
    }
    return end;
  }

  private filters(dict: PdfDict): Array<{ name: string; parms: PdfDict }> {
    const f = dict.Filter ?? dict.F;
    const parms = dict.DecodeParms ?? dict.DP;
    const names: PdfValue[] = Array.isArray(f) ? f : f === undefined || f === null ? [] : [f];
    const plist: PdfValue[] = Array.isArray(parms) ? parms : [parms ?? null];
    return names.map((n, i) => {
      // A filter given by reference cannot be read here; Flate is assumed, the expanding filter almost all files use.
      const name = isName(n) ? FILTER_NAMES[n.name] ?? `?${n.name}` : isRef(n) ? 'Flate' : '?';
      const p = plist[i];
      return { name, parms: isDict(p) ? p : {} };
    }).filter(x => !x.name.startsWith('?'));
  }

  private picture(width: number, height: number, from: string): void {
    const px = Math.max(0, width) * Math.max(0, height);
    if (px > this.report.largestImagePixels) this.report.largestImagePixels = px;
    if (from === 'JPEG 2000 data' && px > this.report.largestJpxPixels) this.report.largestJpxPixels = px;
    if (px > this.L.pdfImagePixels) throw new LimitError(`This PDF has a picture of ${Math.round(width).toLocaleString('en-US')} by ${Math.round(height).toLocaleString('en-US')} pixels (in its ${from}), more than the ${(this.L.pdfImagePixels / 1e6).toLocaleString('en-US')} million pixels allowed, so it was not opened.`);
  }

  private row(columns: number, colors: number, bpc: number, what: string): void {
    const bytes = Math.ceil((Math.max(1, columns) * Math.max(1, colors) * Math.max(1, bpc)) / 8);
    if (!Number.isFinite(bytes) || bytes > this.L.pdfRowBytes) throw new LimitError(`This PDF has ${what} whose rows would be ${mb(bytes)} each, far more than a document needs, so it was not opened.`);
  }
}

/** Scans a PDF's bytes and returns what it holds, or throws a LimitError saying which limit it passes. */
export function scanPdf(bytes: Uint8Array, limits: PdfLimits = LIMITS): PdfScan {
  return new Scanner(bytes, limits).run();
}

/** The message for a PDF FileConvert does not open because it is encrypted (v0.2.0 does not decrypt). It says that
 *  this includes PDFs that open without a password, since those converted before v0.2.0. */
export const ENCRYPTED_MESSAGE = 'This PDF is encrypted, so FileConvert does not open it. Encrypted PDFs are not supported, including ones that open without a password and only restrict printing, copying or editing. FileConvert never removes a PDF\'s protection; open it in the app that made it, or ask its owner for an unprotected copy.';
