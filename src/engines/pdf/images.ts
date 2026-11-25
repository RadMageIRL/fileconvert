// Images to PDF, in the PDF worker: pictures in the order given become the pages of one new PDF, one picture a page
// (every page of a multi-page TIFF). Pictures are read and added one at a time, and each is let go before the next.
//
// How a picture goes in decides what is kept (src/engines/pdf/imageinfo.ts):
// - A JPEG: its compressed data, byte for byte, with no decoding and no new compression. Only its metadata (EXIF with
//   any GPS location, XMP, comments, a second picture after it) is left out. Its color profile becomes the picture's
//   PDF color space; an Adobe CMYK JPEG keeps its inverted colors the way Adobe readers expect.
// - A PNG that PDF can hold: its compressed data as it is, gray, color or a palette at any bit depth, 16 bits too, with
//   its transparent color as a PDF color key and its color profile.
// - A PNG with an alpha channel, a palette with transparency, or interlacing: decoded exactly, its colors and its
//   transparency stored as two pictures compressed without loss (the second as the first's soft mask), 16 bits kept.
// - Anything else (WebP, AVIF, HEIC, GIF, BMP, TIFF, and JPEGs PDF readers cannot read): decoded to 8-bit pixels and
//   stored without further loss, transparency as a soft mask.
// A picture is placed on its page by a matrix (src/engines/pdf/imagelayout.ts), its EXIF orientation applied the same
// way, so no pixel is resampled. Nothing is upscaled, cut off or recompressed unless the options ask for it.

import type { PDFDocument as PDFDocumentT, PDFRef as PDFRefT } from '@cantoo/pdf-lib';
import { zlibSync } from 'fflate';
import { crc32 } from '../../core/crc32';
import type { FormatId } from '../../core/formats';
import { formatBytes, LIMITS, LimitError } from '../../core/limits';
import { admit, estimateImages, type ImageWork, type MemoryAllowance } from '../../core/pdfmemory';
import { FlateStage, type Sink } from './filters';
import { readHeader } from '../image/header';
import { displaySize, iccUsable, jpegStream, jpegWalk, NeedMore, readJpeg, readPng, tiffPages, type JpegLayout, type PictureInfo, type PicturePath, type PngLayout } from './imageinfo';
import { orientationMatrix, placePicture, type ImagePageOptions, type Placement } from './imagelayout';
import { checkPng, colorKey, decodePng, pictureRows } from './pngdecode';
import { pdfLib, savePdf } from './structure';

type Lib = Awaited<ReturnType<typeof pdfLib>>;

export interface ImagePdfFile {
  file: Blob;
  format: FormatId;
  name: string;
}

/** What became of one picture. */
export interface PictureReport {
  name: string;
  format: FormatId;
  path: PicturePath;
  pages: number;
  /** Pixels as shown (after orientation), of its first page. */
  width: number;
  height: number;
  /** Bits per channel in the file, and in the PDF. */
  bits: number;
  keptBits: number;
  /** Transparency: none, kept (a soft mask or a color key), or an alpha channel in which every pixel was opaque. */
  alpha: 'none' | 'kept' | 'opaque';
  /** The file's color profile: none, kept as the PDF color space, not usable, or applied by the browser (decoded). */
  icc: 'none' | 'kept' | 'unusable' | 'browser';
  /** The orientation FileConvert applied (1: none); the browser applies EXIF itself when it decodes. */
  orientation: number;
  /** Metadata in the file that is not in the PDF. */
  metadata: boolean;
  /** A JPEG that had more data after its end marker (left out). */
  trailing: boolean;
  /** The pixels were read back from a browser canvas, with partly transparent pixels present. */
  approximateAlpha: boolean;
  /** Its placement on its first page. */
  place: Placement;
  notes: string[];
}

export interface ImagePdfResult {
  bytes: Uint8Array;
  pages: number;
  pictures: PictureReport[];
}

type Progress = (p: { fraction?: number; stage?: string }) => void;

const ADVICE = 'Use fewer or smaller pictures in one PDF.';
const TRUNCATED = 'This JPEG ends before its end marker, as if it was cut off, so part of the picture is missing. Save it again from a photo editor and add it once more.';

/** An error about one picture names it. */
function about(name: string, e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const out = new Error(`${name}: ${err.message}`);
  out.name = err.name;
  return out;
}

function checkPixels(width: number, height: number): void {
  if (width > LIMITS.imageSide || height > LIMITS.imageSide || width * height > LIMITS.imagePixels) {
    throw new LimitError(`The picture is ${width.toLocaleString('en-US')} x ${height.toLocaleString('en-US')} pixels; the limit is ${(LIMITS.imagePixels / 1e6).toFixed(0)} megapixels and ${LIMITS.imageSide.toLocaleString('en-US')} pixels on a side.`);
  }
}

/** A color profile inflated from a PNG, no larger than a profile can sensibly be; null when it is not whole. */
function inflateProfile(z: Uint8Array): Uint8Array | null {
  const MAX = 16 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  let n = 0;
  let over = false;
  const sink: Sink = {
    push(c: Uint8Array) {
      n += c.length;
      if (n > MAX) { over = true; throw new Error('too large'); }
      parts.push(c.slice());
    },
    end() {},
  };
  const stage = new FlateStage(sink);
  stage.push(z);
  if (!stage.done) stage.end();
  if (over || !n) return null;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The work the memory check prices, from a picture's header. */
export function workOf(bytes: number, info: PictureInfo, pixels = info.width * info.height, pages = info.pages): ImageWork {
  return { bytes, pixels, raw: info.raw, path: info.path, pages };
}

class Builder {
  private works: ImageWork[] = [];
  pages = 0;
  /** Bytes of the streams the PDF holds so far. */
  bytes = 0;
  constructor(readonly L: Lib, readonly doc: PDFDocumentT, readonly o: ImagePageOptions, readonly allowance: MemoryAllowance | undefined) {}

  /** The memory check with this picture's work added to what the PDF holds so far. */
  check(w: ImageWork): void {
    admit(estimateImages([...this.works, w], this.allowance?.engine), this.allowance, this.works.length ? 'Together these pictures need' : 'This picture needs', ADVICE);
  }

  done(w: ImageWork): void {
    this.works.push(w);
  }

  /** A stream of these bytes, as they are (already compressed, or a JPEG), registered in the PDF. */
  private stream(data: Uint8Array, dict: Record<string, unknown>): PDFRefT {
    this.bytes += data.length;
    if (this.bytes > LIMITS.imagePdfBytes) throw new LimitError(`The PDF would hold more than ${formatBytes(LIMITS.imagePdfBytes)} of pictures, the most one PDF can hold here. ${ADVICE}`);
    return this.doc.context.register(this.doc.context.stream(data, dict as never));
  }

  private deviceSpace(channels: number): string {
    return channels === 1 ? 'DeviceGray' : channels === 3 ? 'DeviceRGB' : 'DeviceCMYK';
  }

  /** A profile stream (already compressed with zlib, or to compress here) as an ICCBased color space. */
  private iccSpace(channels: number, profile: Uint8Array, compressed: boolean) {
    const { PDFName } = this.L;
    const ctx = this.doc.context;
    const dict = { N: channels, Alternate: this.deviceSpace(channels) };
    const ref = this.stream(compressed ? profile : zlibSync(profile, { level: 6 }), { ...dict, Filter: 'FlateDecode' });
    return ctx.obj([PDFName.of('ICCBased'), ref]);
  }

  /** Adds one page holding the picture `ref` (stored w x h pixels, EXIF orientation, resolution as stored). */
  page(ref: PDFRefT, w: number, h: number, orientation: number, dpi: [number, number] | null): Placement {
    const L = this.L;
    const turned = orientation >= 5;
    const place = placePicture(turned ? h : w, turned ? w : h, dpi && turned ? [dpi[1], dpi[0]] : dpi, this.o);
    const page = this.doc.addPage(place.page);
    const name = page.node.newXObject('Im', ref);
    const ops = [L.pushGraphicsState()];
    if (place.clip) ops.push(L.rectangle(...place.clip), L.clip(), L.endPath());
    ops.push(L.concatTransformationMatrix(...orientationMatrix(orientation, ...place.box)), L.drawObject(name), L.popGraphicsState());
    page.pushOperators(...ops);
    this.pages++;
    if (this.pages > LIMITS.pdfPages) throw new LimitError(`The pictures make more than ${LIMITS.pdfPages.toLocaleString('en-US')} pages, the most one PDF can have here.`);
    return place;
  }

  /** A JPEG as it is. */
  jpeg(b: Uint8Array, J: JpegLayout): { ref: PDFRefT; trailing: boolean } {
    const L = this.L;
    const s = jpegStream(b, J);
    // A JPEG cut off in its picture data would be a damaged picture in the PDF, which readers show in part or not at all.
    if (s.truncated) throw new Error(TRUNCATED);
    const n = J.info.channels;
    const dict: Record<string, unknown> = {
      Type: 'XObject', Subtype: 'Image', Width: J.info.width, Height: J.info.height, BitsPerComponent: 8,
      ColorSpace: J.icc ? this.iccSpace(n, J.icc, false) : L.PDFName.of(this.deviceSpace(n)), Filter: 'DCTDecode',
    };
    // Adobe writes CMYK JPEGs with every value inverted; PDF readers expect a Decode array to say so.
    if (n === 4 && J.adobe !== null) dict.Decode = [1, 0, 1, 0, 1, 0, 1, 0];
    // Three channels named R, G and B with neither JFIF nor Adobe data are RGB, not YCbCr.
    if (n === 3 && J.adobe === null && !J.jfif && J.ids[0] === 0x52 && J.ids[1] === 0x47 && J.ids[2] === 0x42) dict.DecodeParms = { ColorTransform: 0 };
    const ref = this.stream(s.data, dict);
    return { ref, trailing: s.trailing > 0 };
  }

  /** The color space of a PNG's colors: gray, RGB or a palette over RGB, with its profile when it fits. */
  private pngSpace(P: PngLayout, profile: Uint8Array | null) {
    const { PDFName, PDFHexString } = this.L;
    const ctx = this.doc.context;
    const n = P.colorType === 0 || P.colorType === 4 ? 1 : 3;
    const base = profile ? this.iccSpace(n, P.iccCompressed!, true) : PDFName.of(this.deviceSpace(n));
    if (P.colorType !== 3) return base;
    const pal = P.palette!;
    const entries = Math.min(256, Math.floor(pal.length / 3));
    let hex = '';
    for (let i = 0; i < entries * 3; i++) hex += pal[i].toString(16).padStart(2, '0');
    return ctx.obj([PDFName.of('Indexed'), base, entries - 1, PDFHexString.of(hex)]);
  }

  /** A PNG: as it is when PDF can hold it, otherwise decoded exactly. */
  png(b: Uint8Array, P: PngLayout): { ref: PDFRefT; alpha: PictureReport['alpha']; keptBits: number; icc: PictureReport['icc']; extra: boolean } {
    const n = P.colorType === 0 || P.colorType === 4 ? 1 : 3;
    let profile: Uint8Array | null = null;
    let icc: PictureReport['icc'] = 'none';
    if (P.iccCompressed) {
      profile = inflateProfile(P.iccCompressed);
      icc = profile && iccUsable(profile, n) ? 'kept' : 'unusable';
      if (icc === 'unusable') profile = null;
    }
    const { width: w, height: h } = P.info;
    if (P.info.path === 'png') {
      // As it is, unless its compressed data goes on past the picture: then exactly the picture's rows, compressed again.
      const { extra } = checkPng(b, P);
      let data: Uint8Array;
      if (extra) data = zlibSync(pictureRows(b, P), { level: 6 });
      else {
        data = new Uint8Array(P.idat.reduce((k, [s, e]) => k + e - s, 0));
        let at = 0;
        for (const [s, e] of P.idat) { data.set(b.subarray(s, e), at); at += e - s; }
      }
      const samples = P.colorType === 2 ? 3 : 1;
      const dict: Record<string, unknown> = {
        Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: P.depth, ColorSpace: this.pngSpace(P, profile),
        Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: samples, BitsPerComponent: P.depth, Columns: w },
      };
      const key = colorKey(P, P.depth);
      if (key) dict.Mask = key;
      return { ref: this.stream(data, dict), alpha: key ? 'kept' : 'none', keptBits: P.depth, icc, extra };
    }
    const planes = decodePng(b, P);
    const dict: Record<string, unknown> = {
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: planes.colorBits, ColorSpace: this.pngSpace(P, profile), Filter: 'FlateDecode',
    };
    const key = colorKey(P, planes.colorBits);
    if (key) dict.Mask = key;
    let alpha: PictureReport['alpha'] = key ? 'kept' : (P.colorType === 4 || P.colorType === 6) ? 'opaque' : 'none';
    if (planes.alpha) {
      dict.SMask = this.stream(zlibSync(planes.alpha, { level: 6 }), { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: planes.alphaBits, Filter: 'FlateDecode' });
      alpha = 'kept';
    }
    return { ref: this.stream(zlibSync(planes.color, { level: 6 }), dict), alpha, keptBits: planes.colorBits, icc, extra: false };
  }

  /** 8-bit RGBA pixels: their colors, and their transparency as a soft mask when any pixel is not opaque. */
  rgba(px: Uint8Array, w: number, h: number): { ref: PDFRefT; alpha: boolean; partial: boolean } {
    const n = w * h;
    const rgb = new Uint8Array(n * 3);
    let a: Uint8Array | null = null;
    let partial = false;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      rgb[i * 3] = px[j]; rgb[i * 3 + 1] = px[j + 1]; rgb[i * 3 + 2] = px[j + 2];
      const v = px[j + 3];
      if (v !== 255) {
        if (!a) { a = new Uint8Array(n); a.fill(255, 0, i); }
        if (v !== 0) partial = true;
      }
      if (a) a[i] = v;
    }
    const dict: Record<string, unknown> = { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' };
    if (a) dict.SMask = this.stream(zlibSync(a, { level: 6 }), { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' });
    return { ref: this.stream(zlibSync(rgb, { level: 6 }), dict), alpha: !!a, partial };
  }
}

/** The picture's header as the worker reads it from the whole file. */
function infoOf(b: Uint8Array, format: FormatId): { J?: JpegLayout; P?: PngLayout } {
  try {
    if (format === 'jpg') return { J: readJpeg(b) };
    if (format === 'png') return { P: readPng(b, true, crc32) };
  } catch (e) {
    if (e instanceof NeedMore) throw new Error(`This ${format === 'jpg' ? 'JPEG' : 'PNG'} ends before its picture data, as if it was cut off.`);
    throw e;
  }
  return {};
}

/** One file's pictures, added as pages. */
async function addFile(B: Builder, b: Uint8Array, f: ImagePdfFile): Promise<PictureReport> {
  const { J, P } = infoOf(b, f.format);
  const base = { name: f.name, format: f.format, trailing: false, approximateAlpha: false };
  if (J?.info.path === 'jpeg') {
    checkPixels(J.info.width, J.info.height);
    B.check(workOf(b.length, J.info));
    const r = B.jpeg(b, J);
    const place = B.page(r.ref, J.info.width, J.info.height, J.info.orientation, J.info.dpi);
    const [w, h] = J.info.orientation >= 5 ? [J.info.height, J.info.width] : [J.info.width, J.info.height];
    B.done(workOf(b.length, J.info));
    return { ...base, path: 'jpeg', pages: 1, width: w, height: h, bits: 8, keptBits: 8, alpha: 'none', icc: J.info.icc, orientation: J.info.orientation, metadata: J.info.metadata, trailing: r.trailing, place, notes: J.info.notes };
  }
  if (P) {
    checkPixels(P.info.width, P.info.height);
    B.check(workOf(b.length, P.info));
    const r = B.png(b, P);
    const place = B.page(r.ref, P.info.width, P.info.height, P.info.orientation, P.info.dpi);
    const [w, h] = P.info.orientation >= 5 ? [P.info.height, P.info.width] : [P.info.width, P.info.height];
    B.done(workOf(b.length, P.info));
    const notes = r.extra ? [...P.info.notes, 'Its compressed data went on past the picture; only the picture was kept, compressed again without loss.'] : P.info.notes;
    return { ...base, path: P.info.path, pages: 1, width: w, height: h, bits: P.info.bits, keptBits: r.keptBits, alpha: r.alpha, icc: r.icc, orientation: P.info.orientation, metadata: P.info.metadata, place, notes };
  }
  // Decoded by the browser, or by the TIFF, HEIC and AVIF decoders: one page at a time.
  const { rawPictures } = await import('../image/convert');
  const warnings: string[] = [...(J?.info.notes ?? [])];
  const src = await rawPictures(b, f.format, warnings);
  let report: PictureReport | null = null;
  let maxPixels = 0;
  for (let i = 0; i < src.count; i++) {
    const s = src.size(i);
    checkPixels(s.width, s.height);
    maxPixels = Math.max(maxPixels, s.width * s.height);
  }
  const raw = Array.from({ length: src.count }, (_, i) => src.size(i)).reduce((k, s) => k + s.width * s.height * 4, 0);
  const work: ImageWork = { bytes: b.length, pixels: maxPixels, raw, path: 'decode', pages: src.count };
  B.check(work);
  let alpha = false, partial = false, approximate = false;
  for (let i = 0; i < src.count; i++) {
    const pic = await src.get(i);
    const r = B.rgba(pic.rgba, pic.width, pic.height);
    alpha ||= r.alpha;
    partial ||= r.partial;
    approximate ||= r.partial && !pic.exact;
    const place = B.page(r.ref, pic.width, pic.height, pic.orientation, null);
    if (!report) {
      const [w, h] = pic.orientation >= 5 ? [pic.height, pic.width] : [pic.width, pic.height];
      report = { ...base, path: 'decode', pages: src.count, width: w, height: h, bits: pic.bits, keptBits: 8, alpha: 'none', icc: f.format === 'tiff' || f.format === 'heic' ? 'none' : 'browser', orientation: pic.orientation, metadata: false, place, notes: warnings };
    }
  }
  B.done(work);
  report!.alpha = alpha ? 'kept' : 'none';
  report!.approximateAlpha = approximate;
  return report!;
}

/** What the check of one picture, as it is added, finds: its size as shown, its pages, how it goes into the PDF, and
 *  what that costs in memory. */
export interface PictureCheck {
  width: number;
  height: number;
  pages: number;
  path: PicturePath;
  bits: number;
  alpha: PictureInfo['alpha'];
  orientation: number;
  icc: PictureInfo['icc'];
  metadata: boolean;
  notes: string[];
  work: ImageWork;
}

const NO_CANVAS = 'This browser cannot decode this kind of picture inside a worker (it has no OffscreenCanvas), which Images to PDF needs. JPEG, PNG, TIFF, HEIC and AVIF pictures work here; a current Chrome, Edge, Firefox or Safari reads this one too.';

/** Formats the browser decodes on a canvas here, which a worker can do only where OffscreenCanvas exists. */
const CANVAS: readonly FormatId[] = ['webp', 'gif', 'bmp', 'jpg'];

/**
 * Checks one picture whole as it is added, without decoding it: a JPEG's header and that its data reaches its end
 * marker; a PNG's chunks with their checksums and its compressed data inflated and checked row by row (nothing kept);
 * a TIFF's pages; another format's header. Damaged files are refused here, with the reason, rather than when the PDF
 * is made.
 */
export async function checkPicture(b: Uint8Array, format: FormatId): Promise<PictureCheck> {
  let info: PictureInfo;
  if (format === 'jpg' || format === 'png') {
    try {
      if (format === 'jpg') {
        const J = readJpeg(b);
        info = J.info;
        if (info.path === 'jpeg' && !jpegWalk(b, J).ended) throw new Error(TRUNCATED);
      } else {
        const P = readPng(b, true, crc32);
        info = P.info;
        checkPixels(info.width, info.height);
        if (checkPng(b, P).extra) info.notes.push('Its compressed data goes on past the picture; only the picture will be kept, compressed again without loss.');
      }
    } catch (e) {
      if (e instanceof NeedMore) throw new Error(`This ${format === 'jpg' ? 'JPEG' : 'PNG'} ends before its picture data, as if it was cut off.`);
      throw e;
    }
    const [w, h] = displaySize(info);
    checkPixels(w, h);
    if (info.path === 'decode' && typeof OffscreenCanvas === 'undefined') throw new Error(NO_CANVAS);
    return { width: w, height: h, pages: 1, path: info.path, bits: info.bits, alpha: info.alpha, orientation: info.orientation, icc: info.icc, metadata: info.metadata, notes: info.notes, work: workOf(b.length, info) };
  }
  // Formats decoded by the browser or by FileConvert's other decoders: their size from the header (every page of a
  // TIFF), and whether this browser can decode them in a worker at all.
  if (CANVAS.includes(format) && typeof OffscreenCanvas === 'undefined') {
    throw new Error(NO_CANVAS);
  }
  if (format === 'tiff') {
    const pages = await tiffPages(async (off, len) => b.subarray(off, off + len), b.length);
    if (pages.length > LIMITS.tiffPages) throw new LimitError(`The TIFF has ${pages.length} pages; the limit is ${LIMITS.tiffPages}.`);
    for (const p of pages) checkPixels(p.width, p.height);
    const bits = Math.max(...pages.map(p => p.bits));
    const notes = [pages.length > 1 ? `Its ${pages.length} pages each become a page.` : '', bits > 8 ? `It has ${bits} bits per channel; the PDF gets 8.` : ''].filter(Boolean);
    return {
      width: pages[0].width, height: pages[0].height, pages: pages.length, path: 'decode', bits, alpha: 'none', orientation: 1, icc: 'none', metadata: false, notes,
      work: { bytes: b.length, pixels: Math.max(...pages.map(p => p.width * p.height)), raw: pages.reduce((k, p) => k + p.width * p.height * 4, 0), path: 'decode', pages: pages.length },
    };
  }
  const head = readHeader(b, format);
  if (!head.width || !head.height) throw new Error('The size of this picture could not be read; it may be damaged.');
  checkPixels(head.width, head.height);
  const notes = head.animated ? ['It is animated; its first picture is the page.'] : [];
  return {
    width: head.width, height: head.height, pages: 1, path: 'decode', bits: 8, alpha: 'none', orientation: 1, icc: 'none', metadata: false, notes,
    work: { bytes: b.length, pixels: head.width * head.height, raw: head.width * head.height * 4, path: 'decode', pages: 1 },
  };
}

/** Makes the PDF. `allowance` is the page's memory allowance; every picture is checked against it before it is read. */
export async function imagesToPdf(files: ImagePdfFile[], o: ImagePageOptions, allowance: MemoryAllowance | undefined, progress: Progress): Promise<ImagePdfResult> {
  if (!files.length) throw new Error('Add pictures first.');
  if (files.length > LIMITS.imagePdfFiles) throw new LimitError(`One PDF can be made from up to ${LIMITS.imagePdfFiles} pictures here.`);
  const L = await pdfLib();
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const B = new Builder(L, doc, o, allowance);
  const pictures: PictureReport[] = [];
  for (const [i, f] of files.entries()) {
    progress({ stage: `Adding ${i + 1} of ${files.length}: ${f.name}`, fraction: (0.9 * i) / files.length });
    try {
      if (f.file.size > LIMITS.imageBytes) throw new LimitError(`The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.`);
      // Before reading it: what the PDF holds so far, and this file read and copied.
      B.check({ bytes: f.file.size, pixels: 0, raw: 0, path: 'jpeg', pages: 1 });
      const bytes = new Uint8Array(await f.file.arrayBuffer());
      pictures.push(await addFile(B, bytes, f));
    } catch (e) {
      const name = (e as Error).name;
      throw name === 'MemoryLimitError' && i > 0 ? e : about(f.name, e);
    }
  }
  progress({ stage: 'Writing the PDF', fraction: 0.92 });
  const bytes = await savePdf(doc);
  return { bytes, pages: B.pages, pictures };
}
