// The image optimization tools' work, in the image worker: Compress PNG, JPEG, WebP and AVIF (./pngopt, ./jpegopt,
// ./webpopt, ./avifopt), and Resize images, which is here. Each returns the result with what it is (lossless or not, its
// size), what changed, what was removed and kept, and, when asked for, SSIM against the original (./ssim).
//
// Resize images: the picture is decoded with its colors as stored (MozJPEG, the PNG decoder here, libwebp, libavif; GIF
// and BMP by the browser), turned upright from its EXIF orientation, scaled with Lanczos-3 (./resample), and written in
// its own format or the one chosen. Its color profile goes with it wherever the format can hold one; with metadata kept,
// so do its EXIF (orientation set to 1, since the pixels are upright now) and XMP. 16-bit PNG stays 16-bit as PNG.

import { unzlibSync, zlibSync } from 'fflate';
import { FORMATS, type FormatId } from '../../core/formats';
import { LIMITS, LimitError } from '../../core/limits';
import { decodePng } from '../pdf/pngdecode';
import { addIcc, avifFacts, compressAvif, patchNclx, type AvifOptions } from './avifopt';
import { avifDecode, avifEncode, mozjpegDecode, mozjpegEncode, releaseCodecs, RETIRE_PIXELS, RETIRE_PIXELS_PNG, retireAfter, webpDecode, webpEncode } from './codecs';
import { encodeBmp, encodeGif } from './encoders';
import { readHeader } from './header';
import { compressJpeg, jpegFacts, optimizeJpegLossless, uprightExif, type Decoded, type JpegLossyOptions } from './jpegopt';
import { exifFacts } from './metadata';
import { compressPng, readPngFile, type PngOptions } from './pngopt';
import { pngChunk, rgbaRows, writePng } from './pngwrite';
import { orient, resample, type Picture } from './resample';
import { ssim } from './ssim';
import { compressWebp, webpFacts, withMetadata, type WebpOptions } from './webpopt';

export type OptimizeTask =
  | { op: 'png'; options: PngOptions }
  | { op: 'jpeg-lossless'; options: { progressive: boolean; removeMetadata: boolean } }
  | { op: 'jpeg'; options: Omit<JpegLossyOptions, 'measure'> & { measure: boolean } }
  | { op: 'webp'; options: WebpOptions }
  | { op: 'avif'; options: AvifOptions }
  | { op: 'resize'; options: ResizeOptions };

export interface ResizeOptions {
  by: 'size' | 'percent';
  width: number;
  height: number;
  /** Keep the aspect ratio: the size is a box to fit within. Off: exactly that size (the picture is stretched). */
  lock: boolean;
  percent: number;
  enlarge: boolean;
  /** 'same', or a format to write. */
  to: 'same' | 'jpg' | 'png' | 'webp' | 'avif';
  quality: number;
  removeMetadata: boolean;
}

export interface OptimizeOutcome {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** The original, unchanged. */
  original: boolean;
  lossless: boolean;
  quality?: number;
  changes: string[];
  removed: string[];
  kept: string[];
  notes: string[];
  /** SSIM against the original, when it was asked for and could be measured. */
  ssim?: number;
}

type Progress = (stage: string) => void;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, Math.min(b.length, at + n)));

// ------------------------------------------------------------------ decoding in the browser (CMYK JPEG, GIF, BMP)

/** Decoded by the browser, which applies the EXIF orientation and converts colors to sRGB. Needs a canvas here. */
async function browserDecode(b: Uint8Array, mime: string): Promise<Decoded> {
  if (typeof OffscreenCanvas !== 'function') throw new LimitError('This picture is decoded by the browser, which needs OffscreenCanvas; this browser has none.');
  const bmp = await createImageBitmap(new Blob([b as Uint8Array<ArrayBuffer>], { type: mime }), { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new LimitError(`This browser cannot make a ${bmp.width} x ${bmp.height} canvas.`);
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    c.width = 0;
    return { data: d, width: bmp.width, height: bmp.height };
  } finally {
    bmp.close();
  }
}

// ------------------------------------------------------------------ similarity

/** 10- and 12-bit samples (held in 16 bits) at full 16-bit range, so they read as the others do. */
function full16(d: Uint8ClampedArray | Uint16Array, bits: number): Uint8ClampedArray | Uint16Array {
  if (!(d instanceof Uint16Array) || bits >= 16 || bits <= 8) return d;
  const k = 65535 / ((1 << bits) - 1);
  const out = new Uint16Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = Math.round(d[i] * k);
  return out;
}

function measure(p: { before: Uint8ClampedArray | Uint16Array; after: Uint8ClampedArray | Uint16Array; width: number; height: number } | undefined, bits = 8): number | undefined {
  if (!p) return undefined;
  const v = ssim(full16(p.before, bits), full16(p.after, bits), p.width, p.height);
  return v === null ? undefined : Math.round(v * 10000) / 10000;
}

// ------------------------------------------------------------------ Resize images

interface Source {
  pic: Picture;
  /** Bits per channel of the samples in pic (8, or 16 for 16-bit PNG and 10/12-bit AVIF at full range). */
  bits: number;
  /** The source's own bit depth (AVIF 10 or 12). */
  srcBits: number;
  icc: Uint8Array | null;
  exif: Uint8Array | null;
  xmp: Uint8Array | null;
  /** PNG chunks that describe its colors (gAMA, cHRM, sRGB, cICP) and its text, kept for a PNG result. */
  pngColor: Uint8Array[];
  pngText: Uint8Array[];
  /** A JPEG's comment segments, whole, kept for a JPG result. */
  jpegComments: Uint8Array[];
  avifNclx: { primaries: number; transfer: number } | null;
  notes: string[];
  /** Turned upright from an orientation. */
  turned: boolean;
}

/** The ICC profile a JPEG carries, its APP2 pieces joined in order. */
function jpegIcc(b: Uint8Array): Uint8Array | null {
  const pieces: Array<{ n: number; d: Uint8Array }> = [];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m === 0xe2 && ascii(b, p + 4, 12) === 'ICC_PROFILE\0') pieces.push({ n: b[p + 16], d: b.subarray(p + 18, p + 2 + len) });
    p += 2 + len;
  }
  if (!pieces.length) return null;
  pieces.sort((a, c) => a.n - c.n);
  const out = new Uint8Array(pieces.reduce((k, x) => k + x.d.length, 0));
  let at = 0;
  for (const x of pieces) { out.set(x.d, at); at += x.d.length; }
  return out;
}

/** An APPn segment of a JPEG starting with `prefix` (its body after the prefix), or null. */
/** A JPEG's comment (COM) segments before its picture data, each whole. */
function jpegComments(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m === 0xfe) out.push(b.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  return out;
}

function jpegApp(b: Uint8Array, marker: number, prefix: string): Uint8Array | null {
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m === marker && ascii(b, p + 4, prefix.length) === prefix) return b.subarray(p + 4 + prefix.length, p + 2 + len);
    p += 2 + len;
  }
  return null;
}

async function decodeSource(b: Uint8Array, format: FormatId, progress: Progress): Promise<Source> {
  const base: Omit<Source, 'pic' | 'bits'> = { srcBits: 8, icc: null, exif: null, xmp: null, pngColor: [], pngText: [], jpegComments: [], avifNclx: null, notes: [], turned: false };
  progress(`Decoding ${FORMATS[format].label}`);
  if (format === 'jpg') {
    const f = jpegFacts(b);
    const exif = jpegApp(b, 0xe1, 'Exif\0\0');
    const xmp = jpegApp(b, 0xe1, 'http://ns.adobe.com/xap/1.0/\0');
    if (f.components === 4) {
      const d = await browserDecode(b, 'image/jpeg');
      return { ...base, pic: d, bits: 8, exif, xmp, jpegComments: jpegComments(b), turned: f.orientation !== 1, notes: ['CMYK converted to RGB (sRGB) by the browser.'] };
    }
    const d = await mozjpegDecode(b);
    return { ...base, pic: orient(d, f.orientation), bits: 8, icc: jpegIcc(b), exif, xmp, jpegComments: jpegComments(b), turned: f.orientation !== 1 };
  }
  if (format === 'png') {
    const f = readPngFile(b);
    if (f.animated) throw new LimitError(`This PNG is animated (${f.frames} frames). Resize images makes one picture, so it was not changed; to keep the animation, convert it to GIF, WebP or MP4 in the converter with a size set.`);
    const L = f.layout;
    const planes = decodePng(b, L);
    const w = L.info.width, h = L.info.height, n = w * h;
    const wide = planes.colorBits === 16;
    const out = wide ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4);
    const ct = L.colorType;
    const colors = ct === 2 || ct === 6 ? 3 : 1;
    const key = L.trns && (ct === 0 || ct === 2) ? Array.from({ length: colors }, (_, k) => (L.trns![2 * k] << 8) | L.trns![2 * k + 1]) : null;
    const lowGray = ct === 0 && L.depth < 8 ? 255 / ((1 << L.depth) - 1) : 1;
    for (let i = 0; i < n; i++) {
      let r: number, g: number, bl: number;
      if (ct === 3) { const v = planes.color[i]; r = L.palette![3 * v]; g = L.palette![3 * v + 1]; bl = L.palette![3 * v + 2]; }
      else if (wide) {
        const at = i * colors * 2;
        r = (planes.color[at] << 8) | planes.color[at + 1];
        g = colors === 3 ? (planes.color[at + 2] << 8) | planes.color[at + 3] : r;
        bl = colors === 3 ? (planes.color[at + 4] << 8) | planes.color[at + 5] : r;
      } else { const at = i * colors; r = planes.color[at]; g = colors === 3 ? planes.color[at + 1] : r; bl = colors === 3 ? planes.color[at + 2] : r; }
      let a = wide ? 65535 : 255;
      if (planes.alpha) a = planes.alphaBits === 16 ? (planes.alpha[2 * i] << 8) | planes.alpha[2 * i + 1] : planes.alpha[i];
      else if (key) {
        const raw = colors === 3 ? [r, g, bl] : [ct === 0 && L.depth < 8 ? Math.round(r / lowGray) : r];
        if (raw.every((v, k) => v === key[k])) a = 0;
      }
      out[4 * i] = r; out[4 * i + 1] = g; out[4 * i + 2] = bl; out[4 * i + 3] = ct === 3 && planes.alpha ? planes.alpha[i] : a;
    }
    const chunk = (t: string) => f.chunks.filter(c => c.type === t);
    const whole = (t: string) => chunk(t).map(c => b.subarray(c.start, c.end));
    const iccp = chunk('iCCP')[0];
    let icc: Uint8Array | null = null;
    if (iccp) { const z = iccp.data.indexOf(0); try { icc = unzlibSync(iccp.data.subarray(z + 2), { out: new Uint8Array(1 << 22) }); } catch { icc = null; } }
    const exifChunk = chunk('eXIf')[0]?.data ?? null;
    const orientation = exifChunk ? exifFacts(exifChunk).orientation : 1;
    const xmpChunk = f.chunks.find(c => c.type === 'iTXt' && ascii(c.data, 0, 17) === 'XML:com.adobe.xmp');
    let xmp: Uint8Array | null = null;
    if (xmpChunk) { const d = xmpChunk.data; let z = 18 + 2; z = d.indexOf(0, z) + 1; z = d.indexOf(0, z) + 1; if (d[18] === 0) xmp = d.subarray(z); }
    return {
      ...base, pic: orient({ data: out, width: w, height: h }, orientation), bits: wide ? 16 : 8, icc, exif: exifChunk, xmp, turned: orientation !== 1,
      pngColor: [...whole('gAMA'), ...whole('cHRM'), ...whole('sRGB'), ...whole('cICP')], pngText: [...whole('tEXt'), ...whole('zTXt'), ...whole('iTXt').filter(c => ascii(c, 8, 17) !== 'XML:com.adobe.xmp'), ...whole('pHYs')],
    };
  }
  if (format === 'webp') {
    const f = webpFacts(b);
    if (f.animated) throw new LimitError(`This WebP is animated (${f.frames} frames). Resize images makes one picture, so it was not changed; to keep the animation, convert it to WebP, GIF or MP4 in the converter with a size set.`);
    const d = await webpDecode(b);
    const exif = f.exif && ascii(f.exif, 0, 6) === 'Exif\0\0' ? f.exif.subarray(6) : f.exif;
    return { ...base, pic: orient(d, f.orientation), bits: 8, icc: f.icc, exif, xmp: f.xmp, turned: f.orientation !== 1 };
  }
  if (format === 'avif') {
    const f = avifFacts(b);
    if (f.animated) throw new LimitError('This AVIF is an animation (an image sequence). Resize images makes one picture, so it was not changed.');
    const r = await avifDecode(b, f.bits);
    let pic: Picture = { data: full16(r.data, f.bits), width: r.width, height: r.height };
    for (const t of f.transforms) {
      if (t.kind === 'irot' && t.turns) pic = orient(pic, t.turns === 1 ? 8 : t.turns === 2 ? 3 : 6);
      else if (t.kind === 'imir') pic = orient(pic, t.axis === 0 ? 2 : 4);
    }
    const notes = f.transforms.some(t => t.kind === 'clap') ? ['Its crop box (clap) was not applied by Resize images; the whole stored picture was resized.'] : [];
    if (f.metadata.length) notes.push(`Its ${f.metadata.join(' and ')} metadata is not carried (this tool does not read AVIF metadata).`);
    return { ...base, pic, bits: f.bits > 8 ? 16 : 8, srcBits: f.bits, icc: f.icc, avifNclx: f.nclx && f.nclx.primaries !== 2 ? { primaries: f.nclx.primaries, transfer: f.nclx.transfer } : null, notes, turned: f.transforms.some(t => t.kind !== 'clap') };
  }
  if (format === 'gif' || format === 'bmp') {
    if (format === 'gif') {
      // An animated GIF has more than one image descriptor; only the first frame would be resized. They are counted by
      // walking the blocks: the bytes of a descriptor also turn up inside compressed picture data.
      if (readHeader(b, 'gif').animated) throw new LimitError('This GIF is animated. Resize images makes one picture, so it was not changed; to keep the animation, convert it to GIF, WebP or MP4 in the converter with a size set.');
    }
    const d = await browserDecode(b, FORMATS[format].mime);
    return { ...base, pic: d, bits: 8 };
  }
  throw new LimitError(`Resize images does not read ${FORMATS[format].label}.`);
}

/** The size the result gets, and why it is that size. */
export function resizeTarget(w: number, h: number, o: ResizeOptions): { width: number; height: number; note?: string } {
  let tw: number, th: number;
  if (o.by === 'percent') {
    const k = Math.max(1, Math.min(1000, o.percent)) / 100;
    tw = Math.max(1, Math.round(w * k)); th = Math.max(1, Math.round(h * k));
  } else if (o.lock) {
    const k = Math.min(o.width > 0 ? o.width / w : Infinity, o.height > 0 ? o.height / h : Infinity);
    if (!Number.isFinite(k)) return { width: w, height: h };
    tw = Math.max(1, Math.round(w * k)); th = Math.max(1, Math.round(h * k));
  } else {
    tw = o.width > 0 ? Math.round(o.width) : w; th = o.height > 0 ? Math.round(o.height) : h;
  }
  if (!o.enlarge && (tw > w || th > h)) {
    if (o.by === 'size' && !o.lock) {
      // Exact sizes are not enlarged either: each side stays at most its own length.
      return { width: Math.min(tw, w), height: Math.min(th, h), note: 'Not enlarged past its own size, as set; turn on Allow enlarging for that.' };
    }
    return { width: w, height: h, note: 'It is already within that size, and enlarging is off, so its size is kept.' };
  }
  return { width: tw, height: th };
}

const exifSegment = (exif: Uint8Array) => { const app1 = new Uint8Array(10 + exif.length); app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]); app1.set(exif, 10); return app1; };
/** EXIF with the orientation set to 1, for upright pixels. */
const exifUpright = (exif: Uint8Array) => uprightExif(exifSegment(exif)).subarray(10);

function iccSegments(icc: Uint8Array): Uint8Array[] {
  const max = 65519;
  const n = Math.ceil(icc.length / max);
  if (n > 255) return [];
  return Array.from({ length: n }, (_, i) => {
    const part = icc.subarray(i * max, (i + 1) * max);
    const seg = new Uint8Array(18 + part.length);
    seg.set([0xff, 0xe2, (seg.length - 2) >> 8, (seg.length - 2) & 255]);
    seg.set([0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00, i + 1, n], 4);
    seg.set(part, 18);
    return seg;
  });
}

function to8(d: Uint8ClampedArray | Uint16Array): Uint8ClampedArray {
  if (!(d instanceof Uint16Array)) return d;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i++) out[i] = Math.round(d[i] / 257);
  return out;
}

function flatten(d: Uint8ClampedArray): boolean {
  let any = false;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    any = true;
    const k = a / 255;
    d[i] = Math.round(d[i] * k + 255 * (1 - k)); d[i + 1] = Math.round(d[i + 1] * k + 255 * (1 - k)); d[i + 2] = Math.round(d[i + 2] * k + 255 * (1 - k)); d[i + 3] = 255;
  }
  return any;
}

async function resizeImage(b: Uint8Array, format: FormatId, o: ResizeOptions, progress: Progress): Promise<OptimizeOutcome> {
  const src = await decodeSource(b, format, progress);
  const sw = src.pic.width, sh = src.pic.height;
  const to: FormatId = o.to === 'same' ? (format === 'gif' || format === 'bmp' || format === 'jpg' || format === 'png' || format === 'webp' || format === 'avif' ? format : 'png') : o.to;
  const size = resizeTarget(sw, sh, o);
  const notes = [...src.notes];
  const changes: string[] = [];
  if (size.note) notes.push(size.note);
  else if (size.width === sw && size.height === sh) notes.push('It is already that size.');
  if (size.width === sw && size.height === sh && to === format && !src.turned) {
    // Nothing to do: the original is offered unchanged.
    return { bytes: b, mime: FORMATS[format].mime, ext: FORMATS[format].ext, width: sw, height: sh, sourceWidth: sw, sourceHeight: sh, original: true, lossless: true, changes: [], removed: [], kept: [], notes };
  }
  let pic = src.pic;
  if (size.width !== sw || size.height !== sh) {
    progress('Resizing');
    pic = resample(pic, size.width, size.height);
    changes.push(`Resized from ${sw.toLocaleString('en-US')} x ${sh.toLocaleString('en-US')} to ${pic.width.toLocaleString('en-US')} x ${pic.height.toLocaleString('en-US')} pixels (Lanczos-3)${!o.lock && o.by === 'size' ? ', stretched to exactly that size' : ''}.`);
  }
  if (src.turned) {
    changes.push(format === 'avif'
      ? 'Rotated or mirrored as it is shown (its AVIF irot or imir), in the pixels themselves, so the result has neither.'
      : `Turned upright from its EXIF orientation, in the pixels themselves${!o.removeMetadata && src.exif && to !== 'avif' ? ' (the result\'s EXIF orientation is 1)' : ''}.`);
  }
  const keep = !o.removeMetadata;
  const removed: string[] = [], kept: string[] = [];
  const texts = src.pngText.filter(c => ascii(c, 4, 4) !== 'pHYs');
  if (src.icc) kept.push('Color profile (ICC), so colors look the same');
  if (!keep && (src.exif || src.xmp || texts.length || src.jpegComments.length)) removed.push('EXIF, XMP, text and comments');
  if (keep) {
    // What the result's format holds of the metadata kept, and what it cannot.
    const label = FORMATS[to].label, a = /^[AEIOU]/.test(label) ? 'an' : 'a';
    if (to === 'avif' && (src.exif || src.xmp)) notes.push('EXIF and XMP are not written into AVIF results by this tool.');
    else if (to !== 'avif' && to !== 'gif' && to !== 'bmp') {
      if (src.exif) kept.push(src.turned ? 'EXIF (its orientation set to 1, as the pixels are upright)' : 'EXIF');
      if (src.xmp) kept.push('XMP');
    }
    if (texts.length && format === 'png' && to === 'png') kept.push('Text fields (titles, descriptions, software)');
    else if (texts.length) notes.push(`Its PNG text fields (titles, descriptions, software) are not carried into ${a} ${label} result.`);
    if (src.jpegComments.length && to === 'jpg') kept.push('Comments');
    else if (src.jpegComments.length) notes.push(`Its JPEG comment is not carried into ${a} ${label} result.`);
  }
  progress(`Encoding ${FORMATS[to].label}`);
  let bytes: Uint8Array;
  let lossless = false;
  const q = Math.max(1, Math.min(100, Math.round(o.quality)));
  if (to === 'png') {
    lossless = true;
    const data = pic.data;
    const extra = {
      beforePalette: [...(src.icc ? [pngChunk('iCCP', concatBytes([new TextEncoder().encode('icc'), Uint8Array.of(0, 0), zlibSync(src.icc, { level: 9 })]))] : format === 'png' ? src.pngColor : [])],
      beforeData: [...(keep && src.exif ? [pngChunk('eXIf', exifUpright(src.exif))] : []), ...(keep && format === 'png' ? src.pngText.filter(c => ascii(c, 4, 4) === 'pHYs') : [])],
      afterData: [...(keep && format === 'png' ? src.pngText.filter(c => ascii(c, 4, 4) !== 'pHYs') : []), ...(keep && src.xmp ? [pngChunk('iTXt', concatBytes([new TextEncoder().encode('XML:com.adobe.xmp'), new Uint8Array(5), src.xmp]))] : [])],
    };
    bytes = await writePng(rgbaRows(data, pic.width, pic.height), extra);
    if (data instanceof Uint16Array) changes.push('16 bits per channel kept.');
  } else {
    const d8 = to8(pic.data);
    const deep = to === 'avif' && format === 'avif' && src.srcBits > 8;
    if (pic.data instanceof Uint16Array && !deep) changes.push(`Reduced to 8 bits per channel (${FORMATS[to].label} results here hold 8).`);
    if (to === 'jpg' || to === 'bmp') {
      const d = d8 === pic.data ? new Uint8ClampedArray(d8) : d8;
      if (flatten(d)) notes.push(`${FORMATS[to].label} has no transparency, so transparent areas became white.`);
      if (to === 'jpg') {
        const jpg = await mozjpegEncode(d, pic.width, pic.height, { quality: q, progressive: true, subsample: 2, gray: false });
        const jfifEnd = jpg[2] === 0xff && jpg[3] === 0xe0 ? 4 + ((jpg[4] << 8) | jpg[5]) : 2;
        const segs = [...(keep && src.exif ? [exifSegment(exifUpright(src.exif))] : []), ...(src.icc ? iccSegments(src.icc) : []), ...(keep && src.xmp && src.xmp.length < 65000 ? [xmpSegment(src.xmp)] : []), ...(keep ? src.jpegComments : [])];
        bytes = concatBytes([jpg.subarray(0, jfifEnd), ...segs, jpg.subarray(jfifEnd)]);
      } else bytes = encodeBmp(d, pic.width, pic.height);
    } else if (to === 'webp') {
      const enc = await webpEncode(d8, pic.width, pic.height, { quality: q, lossless: false });
      bytes = withMetadata(enc, { icc: src.icc, exif: keep && src.exif ? exifUpright(src.exif) : null, xmp: keep ? src.xmp : null }, pic.width, pic.height);
    } else if (to === 'avif') {
      let data: Uint8ClampedArray | Uint16Array = d8;
      if (deep) {
        // Back to the original's own bit depth (the pixels were held at full 16-bit range).
        const k = ((1 << src.srcBits) - 1) / 65535;
        const s16 = pic.data as Uint16Array;
        data = new Uint16Array(s16.length);
        for (let i = 0; i < s16.length; i++) data[i] = Math.round(s16[i] * k);
        changes.push(`${src.srcBits} bits per channel kept.`);
      }
      bytes = await avifEncode(data, pic.width, pic.height, { quality: q, lossless: false, bitDepth: deep ? src.srcBits as 10 | 12 : 8, subsample: 1, speed: 6 });
      if (src.avifNclx && (src.avifNclx.primaries !== 1 || src.avifNclx.transfer !== 13)) patchNclx(bytes, src.avifNclx.primaries, src.avifNclx.transfer);
      if (src.icc) {
        const withIcc = addIcc(bytes, src.icc);
        if (withIcc) bytes = withIcc; else notes.push('Its color profile could not be written into the AVIF result.');
      }
    } else {
      const d = new Uint8ClampedArray(d8);
      const { bytes: gif, stats } = encodeGif([{ rgba: d, delay: 0 }], pic.width, pic.height, 1);
      bytes = gif;
      notes.push('GIF holds at most 256 colors, so colors were reduced.');
      if (stats.partialAlpha) notes.push('GIF transparency is on or off, so partly transparent pixels became fully opaque or fully transparent.');
    }
  }
  if (to !== format) changes.push(`Written as ${FORMATS[to].label} (the original was ${FORMATS[format].label}).`);
  return { bytes, mime: FORMATS[to].mime, ext: FORMATS[to].ext, width: pic.width, height: pic.height, sourceWidth: sw, sourceHeight: sh, original: false, lossless, quality: to === 'jpg' || to === 'webp' || to === 'avif' ? q : undefined, changes, removed, kept, notes };
}

function xmpSegment(xmp: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
  const seg = new Uint8Array(4 + head.length + xmp.length);
  seg.set([0xff, 0xe1, (seg.length - 2) >> 8, (seg.length - 2) & 255]);
  seg.set(head, 4);
  seg.set(xmp, 4 + head.length);
  return seg;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ------------------------------------------------------------------ the check as a file is added

/** What a tool learns about a picture as it is added: its size and kind, why it cannot be used, and its memory cost. */
export interface PictureFacts {
  width: number;
  height: number;
  bits: number;
  raw: number;
  coefficients?: number;
  /** One line about it: "progressive, 4:2:0", "16-bit RGBA", "lossless". */
  kind: string;
  /** Why the tool cannot use it, or null. */
  problem: string | null;
  notes: string[];
  lossless?: boolean;
}

/** Reads what a picture's header and structure say, checked whole where it is cheap (PNG checksums). The size is the
 *  upright one: an EXIF orientation or an AVIF rotation that turns the picture a quarter swaps its sides. */
export function pictureFacts(b: Uint8Array, format: FormatId, op: 'png' | 'jpeg' | 'webp' | 'avif' | 'resize'): PictureFacts {
  const f = storedFacts(b, format, op);
  if (f.quarter) { const w = f.width; f.width = f.height; f.height = w; }
  delete f.quarter;
  return f;
}

function storedFacts(b: Uint8Array, format: FormatId, op: 'png' | 'jpeg' | 'webp' | 'avif' | 'resize'): PictureFacts & { quarter?: boolean } {
  const notes: string[] = [];
  if (format === 'png') {
    const f = readPngFile(b);
    const L = f.layout;
    const ch = L.colorType === 0 ? 1 : L.colorType === 2 ? 3 : L.colorType === 3 ? 1 : L.colorType === 4 ? 2 : 4;
    const raw = Math.ceil((L.info.width * ch * L.depth) / 8) * L.info.height;
    const TYPE: Record<number, string> = { 0: 'gray', 2: 'RGB', 3: 'palette', 4: 'gray with alpha', 6: 'RGBA' };
    let problem: string | null = null;
    if (f.animated) {
      if (op === 'png') notes.push(`Animated, ${f.frames} frames: every frame is kept and checked.`);
      else problem = `This PNG is animated (${f.frames} frames). Resize images makes one picture, so it is not used; to keep the animation, convert it in the converter with a size set.`;
    }
    if (L.interlaced) notes.push('Interlaced.');
    if (f.trailing) notes.push('Has data after its end.');
    return { width: L.info.width, height: L.info.height, bits: L.depth, raw, kind: `${L.depth}-bit ${TYPE[L.colorType]}`, problem, notes, quarter: L.info.orientation >= 5 };
  }
  if (format === 'jpg') {
    const f = jpegFacts(b);
    const sub = f.sampling === '4:4:4' ? 3 : f.sampling === '4:2:0' ? 1.5 : f.sampling === '4:2:2' || f.sampling === '4:4:0' ? 2 : f.sampling === 'gray' ? 1 : f.components;
    let problem: string | null = null;
    if (f.sof === 0xc9 || f.sof === 0xca || f.sof === 0xcb || f.sof >= 0xcd) problem = 'This JPEG uses arithmetic coding, which this tool does not read.';
    else if (f.sof === 0xc3 || (f.sof >= 0xc5 && f.sof <= 0xc7)) problem = 'This is a lossless or hierarchical JPEG (a rare kind), which this tool does not read.';
    else if (f.precision !== 8) problem = `This JPEG has ${f.precision}-bit samples; this tool reads 8-bit JPEG only.`;
    else if (!f.ended) problem = 'This JPEG is cut short: it has no end marker, so part of the picture is missing.';
    if (f.orientation !== 1) notes.push(`EXIF orientation ${f.orientation}${op === 'resize' ? ': turned upright' : ': kept as it is'}.`);
    if (f.components === 4) notes.push(op === 'jpeg' || op === 'resize' ? 'CMYK: recompressing converts it to RGB.' : 'CMYK.');
    if (f.mpf || f.trailing) notes.push(op === 'resize' ? 'Has pictures or data after the main one (such as an HDR gain map), which a resized picture does not keep.' : 'Has pictures or data after the main one (such as an HDR gain map or a motion photo), kept with their index corrected.');
    const kind = [f.sof === 0xc2 ? 'progressive' : 'baseline', f.components === 4 ? 'CMYK' : f.components === 1 ? 'gray' : f.sampling].join(', ');
    return { width: f.width, height: f.height, bits: 8, raw: f.width * f.height * 4, coefficients: sub, kind, problem, notes, quarter: f.orientation >= 5 };
  }
  if (format === 'webp') {
    const f = webpFacts(b);
    const problem = f.animated ? `This WebP is animated (${f.frames} frames). ${op === 'webp' ? 'Compressing animated WebP is not supported here' : 'Resize images makes one picture'}, so it is not used; to keep the animation, convert it in the converter.` : null;
    return { width: f.width, height: f.height, bits: 8, raw: f.width * f.height * 4, kind: `${f.lossless ? 'lossless' : 'lossy'}${f.alpha ? ', with transparency' : ''}`, problem, notes, lossless: f.lossless, quarter: f.orientation >= 5 };
  }
  if (format === 'avif') {
    const f = avifFacts(b);
    let problem: string | null = f.animated ? 'This AVIF is an animation (an image sequence), which this tool does not change.' : f.bits > 12 ? `This AVIF has ${f.bits} bits per channel; this tool reads up to 12.` : null;
    if (!problem && f.width * f.height > LIMITS.imagePixels) problem = `This AVIF is ${f.width.toLocaleString('en-US')} x ${f.height.toLocaleString('en-US')} pixels, more than the ${LIMITS.imagePixels / 1e6} megapixels allowed.`;
    const hdr = f.nclx && (f.nclx.transfer === 16 || f.nclx.transfer === 18) ? (f.nclx.transfer === 16 ? ', HDR (PQ)' : ', HDR (HLG)') : '';
    if (f.metadata.length) notes.push(`Has ${f.metadata.join(' and ')} metadata, which the result does not carry.`);
    const quarter = f.transforms.some(t => t.kind === 'irot' && t.turns % 2 === 1);
    return { width: f.width, height: f.height, bits: f.bits, raw: f.width * f.height * (f.bits > 8 ? 8 : 4), kind: `${f.bits}-bit${f.alpha ? ', with transparency' : ''}${hdr}`, problem, notes, quarter };
  }
  // GIF and BMP (Resize images): their size from the header; an animated GIF is refused as it is added.
  const w = format === 'gif' ? b[6] | (b[7] << 8) : (b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)) >>> 0;
  const hRaw = format === 'gif' ? b[8] | (b[9] << 8) : (b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)) | 0;
  const h = Math.abs(hRaw);
  const problem = format === 'gif' && readHeader(b, 'gif').animated ? 'This GIF is animated. Resize images makes one picture, so it is not used; to keep the animation, convert it to GIF, WebP or MP4 in the converter with a size set.' : null;
  return { width: w, height: h, bits: 8, raw: w * h * 4, kind: FORMATS[format].label, problem, notes };
}

// ------------------------------------------------------------------ the entry point

/** A picture's size as it is shown: an EXIF orientation or an AVIF rotation that turns it a quarter swaps its sides. */
function shown(bytes: Uint8Array, format: FormatId, width: number, height: number): [number, number] {
  let quarter = false;
  try {
    if (format === 'jpg') quarter = jpegFacts(bytes).orientation >= 5;
    else if (format === 'webp') quarter = webpFacts(bytes).orientation >= 5;
    else if (format === 'png') quarter = readPngFile(bytes).layout.info.orientation >= 5;
    else if (format === 'avif') quarter = avifFacts(bytes).transforms.some(t => t.kind === 'irot' && t.turns % 2 === 1);
  } catch {
    // Its size as stored.
  }
  return quarter ? [height, width] : [width, height];
}

/** Runs one optimization task on one file. `retire` says the worker should be let go after it (oxipng's memory). */
export async function optimizeImage(b: Uint8Array, format: FormatId, task: OptimizeTask, progress: Progress): Promise<{ outcome: OptimizeOutcome; retire: boolean }> {
  const done = async (o: OptimizeOutcome) => {
    // The compressions report sizes as the files store them; they are shown as the file list shows them, upright.
    if (task.op !== 'resize') {
      [o.sourceWidth, o.sourceHeight] = shown(b, format, o.sourceWidth, o.sourceHeight);
      [o.width, o.height] = shown(o.bytes, format, o.width, o.height);
    }
    await releaseCodecs();
    const large = Math.max(o.sourceWidth * o.sourceHeight, o.width * o.height) >= (task.op === 'png' ? RETIRE_PIXELS_PNG : RETIRE_PIXELS);
    return { outcome: o, retire: large || await retireAfter() };
  };
  const mimeOf = (f: FormatId) => ({ mime: FORMATS[f].mime, ext: FORMATS[f].ext });
  if (task.op === 'png') {
    const f0 = readPngFile(b);
    const r = await compressPng(b, task.options, progress);
    return done({ ...mimeOf('png'), bytes: r.bytes, width: f0.layout.info.width, height: f0.layout.info.height, sourceWidth: f0.layout.info.width, sourceHeight: f0.layout.info.height, original: r.original, lossless: true, changes: r.changes, removed: r.removed, kept: r.kept, notes: r.notes });
  }
  if (task.op === 'jpeg-lossless') {
    const r = await optimizeJpegLossless(b, task.options, progress);
    return done({ ...mimeOf('jpg'), bytes: r.bytes, width: r.width, height: r.height, sourceWidth: r.width, sourceHeight: r.height, original: r.original, lossless: true, changes: r.changes, removed: r.removed, kept: r.kept, notes: r.notes });
  }
  if (task.op === 'jpeg') {
    const f = jpegFacts(b);
    const r = await compressJpeg(b, task.options, { decodeCmyk: x => browserDecode(x, 'image/jpeg'), resize: (d, w, h) => resample(d, w, h) as Decoded }, progress);
    return done({ ...mimeOf('jpg'), bytes: r.bytes, width: r.width, height: r.height, sourceWidth: f.width, sourceHeight: f.height, original: r.original, lossless: false, quality: r.quality, changes: r.changes, removed: r.removed, kept: r.kept, notes: r.notes, ssim: measure(r.pixels) });
  }
  if (task.op === 'webp') {
    const r = await compressWebp(b, task.options, progress);
    const f = webpFacts(b);
    return done({ ...mimeOf('webp'), bytes: r.bytes, width: r.width, height: r.height, sourceWidth: f.width, sourceHeight: f.height, original: r.original, lossless: r.lossless, quality: r.quality, changes: r.changes, removed: r.removed, kept: r.kept, notes: r.notes, ssim: measure(r.pixels) });
  }
  if (task.op === 'avif') {
    const f = avifFacts(b);
    const r = await compressAvif(b, task.options, progress);
    return done({ ...mimeOf('avif'), bytes: r.bytes, width: r.width, height: r.height, sourceWidth: f.width, sourceHeight: f.height, original: r.original, lossless: r.lossless, quality: r.quality, changes: r.changes, removed: r.removed, kept: r.kept, notes: r.notes, ssim: measure(r.pixels, r.bits) });
  }
  return done(await resizeImage(b, format, task.options, progress));
}
