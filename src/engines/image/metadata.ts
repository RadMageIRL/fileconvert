// Removes metadata from JPEG, PNG and WebP files without touching the compressed picture. The file is taken apart
// into its segments (JPEG), chunks (PNG) or RIFF chunks (WebP); the ones that carry the picture or are needed to
// show it correctly are copied byte for byte, and the ones that describe the camera, the place, the person or the
// editing history are left out. Nothing is decoded or re-encoded, so quality is exactly the same.
//
// Kept by default because the picture looks wrong without them: the color profile (ICC), transparency and color
// settings, animation, and the orientation. Orientation lives inside EXIF, so when a photo is stored sideways a
// minimal EXIF block holding only the orientation tag is written in place of the original one.

import { crc32 } from '../../core/crc32';

export type MetadataFormat = 'jpg' | 'png' | 'webp';

export interface StripOptions {
  keepOrientation: boolean;
  keepColorProfile: boolean;
}

export interface StripResult {
  bytes: Uint8Array;
  /** What was taken out, in plain words, each at most once. */
  removed: string[];
  /** Metadata that was kept on purpose. */
  kept: string[];
}

export const CATEGORY = {
  exif: 'Camera details and settings (EXIF)',
  date: 'Date and time',
  gps: 'GPS location',
  thumbnail: 'Embedded thumbnail',
  maker: 'Maker notes (camera-specific data, often serial numbers)',
  xmp: 'XMP (editing history, descriptions, ratings)',
  iptc: 'IPTC and Photoshop data (captions, keywords, author, copyright)',
  comment: 'Comments',
  text: 'Text fields (titles, descriptions, software)',
  time: 'Last-modified time',
  trailer: 'Extra data after the picture (for example a motion photo video or depth map)',
  vendor: 'Other camera or app data',
  icc: 'Color profile (ICC)',
  signature: 'Digital signature',
} as const;

export const KEPT = {
  orientation: 'Orientation (a minimal EXIF block that holds nothing else)',
  icc: 'Color profile (ICC), so colors look the same',
} as const;

// ------------------------------------------------------------------ EXIF reading

interface ExifFacts { orientation: number; gps: boolean; date: boolean; thumbnail: boolean; maker: boolean }

/** Reads what an EXIF (TIFF-structured) block contains. Never throws: a damaged block simply tells less. */
export function exifFacts(tiff: Uint8Array): ExifFacts {
  const facts: ExifFacts = { orientation: 1, gps: false, date: false, thumbnail: false, maker: false };
  if (tiff.length < 8) return facts;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return facts;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => o + 2 <= tiff.length ? dv.getUint16(o, le) : 0;
  const u32 = (o: number) => o + 4 <= tiff.length ? dv.getUint32(o, le) : 0;
  const entries = (ifd: number): Array<{ tag: number; type: number; count: number; at: number }> => {
    if (!ifd || ifd + 2 > tiff.length) return [];
    const n = Math.min(u16(ifd), 1000);
    const out = [];
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + i * 12;
      if (at + 12 > tiff.length) break;
      out.push({ tag: u16(at), type: u16(at + 2), count: u32(at + 4), at });
    }
    return out;
  };
  const ifd0 = u32(4);
  const e0 = entries(ifd0);
  for (const e of e0) {
    if (e.tag === 0x0112) facts.orientation = u16(e.at + 8);
    if (e.tag === 0x0132) facts.date = true;
    if (e.tag === 0x8825) facts.gps = entries(u32(e.at + 8)).length > 0;
    if (e.tag === 0x8769) {
      for (const x of entries(u32(e.at + 8))) {
        if (x.tag === 0x9003 || x.tag === 0x9004) facts.date = true;
        if (x.tag === 0x927c) facts.maker = true;
      }
    }
  }
  const next = ifd0 + 2 + Math.min(u16(ifd0), 1000) * 12;
  const ifd1 = u32(next);
  if (ifd1 && entries(ifd1).some(e => e.tag === 0x0201 || e.tag === 0x0111)) facts.thumbnail = true;
  if (facts.orientation < 1 || facts.orientation > 8) facts.orientation = 1;
  return facts;
}

function exifCategories(f: ExifFacts, removed: Set<string>): void {
  removed.add(CATEGORY.exif);
  if (f.date) removed.add(CATEGORY.date);
  if (f.gps) removed.add(CATEGORY.gps);
  if (f.thumbnail) removed.add(CATEGORY.thumbnail);
  if (f.maker) removed.add(CATEGORY.maker);
}

/** A TIFF-structured EXIF block holding one tag, Orientation. */
export function minimalExif(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
}

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, Math.min(b.length, at + len)));
const startsWith = (b: Uint8Array, at: number, s: string) => ascii(b, at, s.length) === s;

// ------------------------------------------------------------------ JPEG

function stripJpeg(b: Uint8Array, o: StripOptions): StripResult {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('This is not a JPEG file.');
  const removed = new Set<string>();
  const kept = new Set<string>();
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let orientation = 1;
  let exifAt = -1; // where the minimal EXIF goes: after SOI, or after a JFIF APP0
  let p = 2;
  let end = -1;
  while (p < b.length) {
    if (b[p] !== 0xff) throw new Error('This JPEG file is damaged: a segment does not start where expected.');
    let marker = b[p + 1];
    while (marker === 0xff && p + 2 < b.length) { p++; marker = b[p + 1]; } // fill bytes
    if (marker === 0xd9) { parts.push(b.subarray(p, p + 2)); end = p + 2; break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(b.subarray(p, p + 2)); p += 2; continue; }
    if (p + 4 > b.length) throw new Error('This JPEG file is cut short.');
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > b.length) throw new Error('This JPEG file is cut short or damaged: a segment runs past the end of the file.');
    const seg = b.subarray(p, p + 2 + len);
    const body = p + 4;
    let keep = true;
    if (marker === 0xe0) {
      if (startsWith(b, body, 'JFIF\0')) {
        // JFIF can carry a small uncompressed thumbnail; keep the header without it.
        if (len > 16 && (b[body + 12] || b[body + 13])) {
          const header = seg.slice(0, 18);
          header[2] = 0; header[3] = 16; header[16] = 0; header[17] = 0;
          parts.push(header);
          removed.add(CATEGORY.thumbnail);
          keep = false;
        }
        exifAt = parts.length + (keep ? 1 : 0);
      } else { keep = false; removed.add(startsWith(b, body, 'JFXX') ? CATEGORY.thumbnail : CATEGORY.vendor); }
    } else if (marker === 0xe1) {
      keep = false;
      if (startsWith(b, body, 'Exif\0')) {
        const f = exifFacts(b.subarray(body + 6, p + 2 + len));
        exifCategories(f, removed);
        if (f.orientation !== 1) orientation = f.orientation;
      } else if (startsWith(b, body, 'http://ns.adobe.com/')) removed.add(CATEGORY.xmp);
      else removed.add(CATEGORY.vendor);
    } else if (marker === 0xe2) {
      if (startsWith(b, body, 'ICC_PROFILE\0')) {
        if (o.keepColorProfile) kept.add(KEPT.icc); else { keep = false; removed.add(CATEGORY.icc); }
      } else { keep = false; removed.add(startsWith(b, body, 'MPF\0') ? CATEGORY.trailer : CATEGORY.vendor); }
    } else if (marker === 0xed) { keep = false; removed.add(CATEGORY.iptc); }
    else if (marker === 0xee) { /* APP14 Adobe: the color transform, needed to show CMYK and YCCK pictures. */ }
    else if (marker >= 0xe3 && marker <= 0xef) { keep = false; removed.add(CATEGORY.vendor); }
    else if (marker === 0xfe) { keep = false; removed.add(CATEGORY.comment); }
    if (keep) parts.push(seg);
    p += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data runs until a marker that is not a stuffed 0x00 or a restart marker.
      let q = p;
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0x00 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7))) q++;
      parts.push(b.subarray(p, q));
      p = q;
    }
  }
  if (end < 0) throw new Error('This JPEG file is cut short: it has no end marker.');
  const trailing = b.subarray(end);
  if (trailing.some(v => v !== 0)) removed.add(CATEGORY.trailer);
  if (orientation !== 1 && o.keepOrientation) {
    const exif = minimalExif(orientation);
    const app1 = new Uint8Array(4 + 6 + exif.length);
    app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 0xff]);
    app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    app1.set(exif, 10);
    parts.splice(exifAt > 0 ? exifAt : 1, 0, app1);
    kept.add(KEPT.orientation);
  }
  return { bytes: concat(parts), removed: [...removed], kept: [...kept] };
}

// ------------------------------------------------------------------ PNG

/** Ancillary PNG chunks needed to show the picture (transparency, color, physical size, animation). */
const PNG_KEEP = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi', 'oFFs', 'pCAL', 'sCAL']);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function stripPng(b: Uint8Array, o: StripOptions): StripResult {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) throw new Error('This is not a PNG file.');
  const removed = new Set<string>();
  const kept = new Set<string>();
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let orientation = 1;
  let firstIdat = -1;
  let p = 8;
  let ended = false;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    if (p + 12 + len > b.length) throw new Error('This PNG file is damaged or cut short: a chunk runs past the end of the file.');
    const type = ascii(b, p + 4, 4);
    const chunk = b.subarray(p, p + 12 + len);
    const data = b.subarray(p + 8, p + 8 + len);
    let keep: boolean;
    if (type === 'IEND') { parts.push(chunk); p += 12 + len; ended = true; break; }
    if (type === 'IDAT' && firstIdat < 0) firstIdat = parts.length;
    const critical = (type.charCodeAt(0) & 0x20) === 0;
    if (critical || PNG_KEEP.has(type)) keep = true;
    else if (type === 'iCCP') { keep = o.keepColorProfile; (keep ? kept.add(KEPT.icc) : removed.add(CATEGORY.icc)); }
    else {
      keep = false;
      if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') removed.add(type === 'iTXt' && startsWith(data, 0, 'XML:com.adobe.xmp') ? CATEGORY.xmp : CATEGORY.text);
      else if (type === 'eXIf') { const f = exifFacts(data); exifCategories(f, removed); if (f.orientation !== 1) orientation = f.orientation; }
      else if (type === 'tIME') removed.add(CATEGORY.time);
      else if (type === 'dSIG') removed.add(CATEGORY.signature);
      else removed.add(CATEGORY.vendor);
    }
    if (keep) parts.push(chunk);
    p += 12 + len;
  }
  if (!ended) throw new Error('This PNG file is cut short: it has no end chunk.');
  if (b.subarray(p).some(v => v !== 0)) removed.add(CATEGORY.trailer);
  if (orientation !== 1 && o.keepOrientation) {
    parts.splice(firstIdat > 0 ? firstIdat : parts.length - 1, 0, pngChunk('eXIf', minimalExif(orientation)));
    kept.add(KEPT.orientation);
  }
  return { bytes: concat(parts), removed: [...removed], kept: [...kept] };
}

// ------------------------------------------------------------------ WebP

const WEBP_FLAGS = { ICCP: 0x20, ALPH: 0x10, EXIF: 0x08, XMP: 0x04, ANIM: 0x02 } as const;
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

function stripWebp(b: Uint8Array, o: StripOptions): StripResult {
  if (!startsWith(b, 0, 'RIFF') || !startsWith(b, 8, 'WEBP')) throw new Error('This is not a WebP file.');
  const removed = new Set<string>();
  const kept = new Set<string>();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riffEnd = Math.min(b.length, 8 + dv.getUint32(4, true));
  const chunks: Array<{ type: string; bytes: Uint8Array }> = [];
  let orientation = 1;
  let p = 12;
  while (p + 8 <= riffEnd) {
    const type = ascii(b, p, 4);
    const len = dv.getUint32(p + 4, true);
    const padded = len + (len & 1);
    if (p + 8 + len > b.length) throw new Error('This WebP file is damaged or cut short: a chunk runs past the end of the file.');
    const whole = b.subarray(p, Math.min(b.length, p + 8 + padded));
    const data = b.subarray(p + 8, p + 8 + len);
    if (WEBP_KEEP.has(type)) chunks.push({ type, bytes: whole });
    else if (type === 'ICCP') { if (o.keepColorProfile) { chunks.push({ type, bytes: whole }); kept.add(KEPT.icc); } else removed.add(CATEGORY.icc); }
    else if (type === 'EXIF') {
      // Some writers keep the JPEG "Exif\0\0" prefix inside the chunk.
      const f = exifFacts(startsWith(data, 0, 'Exif\0') ? data.subarray(6) : data);
      exifCategories(f, removed);
      if (f.orientation !== 1) orientation = f.orientation;
    } else if (type === 'XMP ') removed.add(CATEGORY.xmp);
    else removed.add(CATEGORY.vendor);
    p += 8 + padded;
  }
  if (b.subarray(riffEnd).some(v => v !== 0)) removed.add(CATEGORY.trailer);
  const vp8x = chunks.find(c => c.type === 'VP8X');
  if (orientation !== 1 && o.keepOrientation && vp8x) {
    const exif = minimalExif(orientation);
    const chunk = new Uint8Array(8 + exif.length);
    chunk.set([0x45, 0x58, 0x49, 0x46]);
    new DataView(chunk.buffer).setUint32(4, exif.length, true);
    chunk.set(exif, 8);
    chunks.push({ type: 'EXIF', bytes: chunk });
    kept.add(KEPT.orientation);
  }
  if (vp8x) {
    // The feature flags must match the chunks that are left.
    const header = vp8x.bytes.slice();
    let flags = header[8] & ~(WEBP_FLAGS.ICCP | WEBP_FLAGS.EXIF | WEBP_FLAGS.XMP);
    if (chunks.some(c => c.type === 'ICCP')) flags |= WEBP_FLAGS.ICCP;
    if (chunks.some(c => c.type === 'EXIF')) flags |= WEBP_FLAGS.EXIF;
    header[8] = flags;
    vp8x.bytes = header;
  }
  const body = concat(chunks.map(c => c.bytes));
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, 4 + body.length, true);
  return { bytes: concat([head, body]), removed: [...removed], kept: [...kept] };
}

// ------------------------------------------------------------------ entry point

export function stripMetadata(bytes: Uint8Array, format: MetadataFormat, o: StripOptions): StripResult {
  if (format === 'jpg') return stripJpeg(bytes, o);
  if (format === 'png') return stripPng(bytes, o);
  if (format === 'webp') return stripWebp(bytes, o);
  throw new Error('Only JPG, PNG and WebP files are supported.');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
