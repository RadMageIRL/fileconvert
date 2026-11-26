// Compress JPEG, three ways. Lossless: the quantized coefficients written again with Huffman tables made for the picture
// (./jpegcoef), every pixel the same in every decoder, checked by reading the result back. By quality, or to a file size:
// decoded by MozJPEG (colors as stored, nothing converted) and encoded again by MozJPEG, which loses some detail; the
// quality is searched to meet a size, never the dimensions.
//
// What the file carries besides its picture is kept unless removal is asked for: EXIF (with the orientation, so the
// pixels are never turned), the color profile, XMP, IPTC, comments, and data after the picture, such as the HDR gain map
// or depth map that a Multi-Picture (MPF) index points at, whose offsets are corrected for the new picture's size, and a
// motion photo's video. Removal goes through ./metadata, keeping the color profile and a minimal orientation. A CMYK JPEG
// is decoded by the browser, which converts it to sRGB with its profile; the result is RGB, and says so.

import { LimitError } from '../../core/limits';
import { mozjpegDecode, mozjpegEncode } from './codecs';
import { JpegCoefError, readJpegCoefficients, sameCoefficients, writeJpegCoefficients, type Segment } from './jpegcoef';
import { exifFacts, stripMetadata } from './metadata';

export interface JpegFacts {
  width: number;
  height: number;
  /** 0xC0 baseline, 0xC1 extended, 0xC2 progressive, others refused. */
  sof: number;
  precision: number;
  components: number;
  /** Chroma sampling: '4:4:4', '4:2:0', '4:2:2', '4:4:0', or 'other'. */
  sampling: string;
  /** The Adobe segment's color transform, or null. */
  adobe: number | null;
  orientation: number;
  icc: boolean;
  /** The color space the profile is for ('RGB ', 'CMYK', 'GRAY'), or null. */
  iccSpace: string | null;
  exif: boolean;
  mpf: boolean;
  /** Bytes after the end marker. */
  trailing: number;
  ended: boolean;
}

const u16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, Math.min(b.length, at + n)));

/** What a JPEG's segments say, without decoding the picture. Throws with the reason for a file that is not one. */
export function jpegFacts(b: Uint8Array): JpegFacts {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('This is not a JPEG file.');
  const f: JpegFacts = { width: 0, height: 0, sof: 0, precision: 8, components: 0, sampling: 'other', adobe: null, orientation: 1, icc: false, iccSpace: null, exif: false, mpf: false, trailing: 0, ended: false };
  let p = 2;
  while (p + 2 <= b.length) {
    if (b[p] !== 0xff) break;
    let m = b[p + 1];
    while (m === 0xff && p + 2 < b.length) { p++; m = b[p + 1]; }
    if (m === 0xd9) { f.ended = true; f.trailing = b.length - p - 2; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (p + 4 > b.length) break;
    const len = u16(b, p + 2), s = p + 4, e = p + 2 + len;
    if (len < 2 || e > b.length) break;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && !f.sof) {
      f.sof = m; f.precision = b[s]; f.height = u16(b, s + 1); f.width = u16(b, s + 3); f.components = b[s + 5];
      const hv = Array.from({ length: f.components }, (_, i) => [b[s + 7 + 3 * i] >> 4, b[s + 7 + 3 * i] & 15]);
      if (f.components === 3) {
        const [y, cb, cr] = hv;
        if (cb[0] === 1 && cb[1] === 1 && cr[0] === 1 && cr[1] === 1) f.sampling = y[0] === 1 && y[1] === 1 ? '4:4:4' : y[0] === 2 && y[1] === 2 ? '4:2:0' : y[0] === 2 && y[1] === 1 ? '4:2:2' : y[0] === 1 && y[1] === 2 ? '4:4:0' : 'other';
      } else if (f.components === 1) f.sampling = 'gray';
    } else if (m === 0xe1 && ascii(b, s, 6) === 'Exif\0\0') { f.exif = true; f.orientation = exifFacts(b.subarray(s + 6, e)).orientation; }
    else if (m === 0xe2 && ascii(b, s, 12) === 'ICC_PROFILE\0') { if (!f.icc && len > 16 + 20) f.iccSpace = ascii(b, s + 14 + 16, 4); f.icc = true; }
    else if (m === 0xe2 && ascii(b, s, 4) === 'MPF\0') f.mpf = true;
    else if (m === 0xee && ascii(b, s, 5) === 'Adobe' && len >= 14) f.adobe = b[s + 11];
    else if (m === 0xda) {
      // Skip the scan's data to the next marker.
      let q = e;
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0x00 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7))) q++;
      p = q;
      continue;
    }
    p = e;
  }
  if (!f.sof) throw new Error('No picture was found in this JPEG. It may be damaged.');
  return f;
}

/** Why a JPEG cannot be recompressed, or null. */
export function jpegProblem(f: JpegFacts): string | null {
  if (!f.ended) return 'This JPEG is cut short: it has no end marker. Part of the picture is missing, so it was not recompressed.';
  if (f.sof >= 0xc9 || f.sof === 0xcc) return 'This JPEG uses arithmetic coding, which this tool does not read.';
  if (f.sof === 0xc3 || (f.sof >= 0xc5 && f.sof <= 0xc7)) return 'This is a lossless or hierarchical JPEG (a rare kind), which this tool does not read.';
  if (f.precision !== 8) return `This JPEG has ${f.precision}-bit samples; this tool reads 8-bit JPEG only.`;
  if (f.components !== 1 && f.components !== 3 && f.components !== 4) return `This JPEG has ${f.components} color components, which this tool does not read.`;
  return null;
}

// ------------------------------------------------------------------ what the file carries besides the picture

/** The APPn and COM segments of a JPEG, in order, and the data after its end marker. */
function carried(b: Uint8Array): { segments: Segment[]; end: number } {
  const segments: Segment[] = [];
  let p = 2, end = b.length;
  while (p + 2 <= b.length) {
    let m = b[p + 1];
    while (m === 0xff && p + 2 < b.length) { p++; m = b[p + 1]; }
    if (b[p] !== 0xff) break;
    if (m === 0xd9) { end = p + 2; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (p + 4 > b.length) break;
    const e = p + 2 + u16(b, p + 2);
    if (e > b.length) break;
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) segments.push({ marker: m, bytes: b.subarray(p, e) });
    if (m === 0xda) {
      let q = e;
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0x00 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7))) q++;
      p = q;
      continue;
    }
    p = e;
  }
  return { segments, end };
}

/**
 * The Multi-Picture index (APP2 "MPF") with its pictures' offsets moved by `delta` bytes: they count from the index's own
 * TIFF header to pictures after the main one's end, so they move when the main picture's size or the index's place
 * changes. Null when the index cannot be read, so the caller drops it with the pictures it points at.
 */
export function shiftMpf(seg: Uint8Array, delta: number): Uint8Array | null {
  const out = seg.slice();
  const t = 8; // FF E2, length, "MPF\0"
  if (out.length < t + 8) return null;
  const le = out[t] === 0x49 && out[t + 1] === 0x49;
  if (!le && !(out[t] === 0x4d && out[t + 1] === 0x4d)) return null;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const r16 = (o: number) => dv.getUint16(t + o, le), r32 = (o: number) => dv.getUint32(t + o, le);
  const ifd = r32(4);
  if (ifd + 2 > out.length - t) return null;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + 12 * i;
    if (at + 12 > out.length - t) return null;
    if (r16(at) !== 0xb002) continue;
    const count = r32(at + 4), off = r32(at + 8);
    if (count % 16 || off + count > out.length - t) return null;
    for (let k = 0; k < count / 16; k++) {
      const e = off + 16 * k;
      const pos = r32(e + 8);
      // The first picture is the main one (offset 0); the others follow it.
      if (pos) dv.setUint32(t + e + 8, pos + delta, le);
    }
    return out;
  }
  return null;
}

/** Where the MPF segment's TIFF header sits in a file made of these parts. */
function mpfHeaderAt(parts: readonly Uint8Array[], seg: Uint8Array): number {
  let at = 0;
  for (const p of parts) { if (p === seg) return at + 8; at += p.length; }
  return -1;
}

/**
 * The result file: the new picture's own head (SOI and, for MozJPEG, its JFIF segment), the carried segments, the rest of
 * the new picture, and the data after the old one's end, with the MPF index's offsets corrected. `keepTrailer` false
 * leaves the data after the end and the MPF index out (a resized picture: its gain map no longer fits).
 */
function assemble(head: Uint8Array, rest: Uint8Array, segs: Segment[], src: Uint8Array, srcEnd: number, keepTrailer: boolean, notes: string[]): Uint8Array {
  const trailer = src.subarray(srcEnd);
  const parts: Uint8Array[] = [head];
  let mpf: Uint8Array | null = null;
  const oldMpf = segs.find(s => s.marker === 0xe2 && ascii(s.bytes, 4, 4) === 'MPF\0');
  for (const s of segs) {
    if (s === oldMpf && (!keepTrailer || !trailer.length)) continue;
    const bytes = s === oldMpf ? (mpf = s.bytes.slice()) : s.bytes;
    parts.push(bytes);
  }
  parts.push(rest);
  if (keepTrailer && trailer.length) {
    if (mpf && oldMpf) {
      const oldHeader = (oldMpf.bytes.byteOffset - src.byteOffset) + 8;
      const newHeader = mpfHeaderAt(parts, mpf);
      const newEnd = parts.reduce((n, p) => n + p.length, 0);
      const shifted = shiftMpf(mpf, (newEnd - newHeader) - (srcEnd - oldHeader));
      if (shifted) parts[parts.indexOf(mpf)] = shifted;
      else {
        parts.splice(parts.indexOf(mpf), 1);
        notes.push('Its Multi-Picture index could not be read, so it and the pictures after the main one were left out.');
        return concat(parts);
      }
    }
    parts.push(trailer);
  } else if (!keepTrailer && (trailer.some(v => v !== 0) || oldMpf)) {
    notes.push('The pictures after the main one (such as an HDR gain map or a depth map) and data after it were left out, as they no longer match the resized picture.');
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Sets the EXIF orientation tag to 1 in an APP1 Exif segment (a copy), for pixels that were turned upright. */
export function uprightExif(seg: Uint8Array): Uint8Array {
  const out = seg.slice();
  const t = 10;
  if (out.length < t + 8) return out;
  const le = out[t] === 0x49;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const ifd = dv.getUint32(t + 4, le);
  if (t + ifd + 2 > out.length) return out;
  const n = dv.getUint16(t + ifd, le);
  for (let i = 0; i < n; i++) {
    const at = t + ifd + 2 + 12 * i;
    if (at + 12 > out.length) break;
    if (dv.getUint16(at, le) === 0x0112) dv.setUint16(at + 8, 1, le);
  }
  return out;
}

// ------------------------------------------------------------------ lossless

export interface JpegResult {
  bytes: Uint8Array;
  original: boolean;
  width: number;
  height: number;
  /** The quality used, for MozJPEG results. */
  quality?: number;
  progressive: boolean;
  changes: string[];
  removed: string[];
  kept: string[];
  notes: string[];
  /** Decoded pixels of the source and the result (RGBA, same size), for the similarity measure; MozJPEG results only. */
  pixels?: { before: Uint8ClampedArray; after: Uint8ClampedArray; width: number; height: number };
}

function stripped(bytes: Uint8Array, remove: boolean): { bytes: Uint8Array; removed: string[]; kept: string[] } {
  if (!remove) return { bytes, removed: [], kept: [] };
  const s = stripMetadata(bytes, 'jpg', { keepOrientation: true, keepColorProfile: true });
  return { bytes: s.bytes, removed: s.removed, kept: s.kept };
}

export async function optimizeJpegLossless(b: Uint8Array, o: { progressive: boolean; removeMetadata: boolean }, progress: (s: string) => void): Promise<JpegResult> {
  progress('Reading the coefficients');
  let parsed;
  try { parsed = readJpegCoefficients(b); } catch (e) { if (e instanceof JpegCoefError) throw new LimitError(e.message); throw e; }
  const { frame } = parsed;
  progress('Writing optimized tables');
  // The new picture without its segments: SOI first, the rest after; the carried segments go between them.
  const body = writeJpegCoefficients(frame, [], o.progressive);
  progress('Checking every coefficient');
  const back = readJpegCoefficients(body);
  if (!sameCoefficients(frame, back.frame)) throw new Error('The optimized JPEG did not hold the same picture, so it was not used.');
  const notes: string[] = [];
  const whole = assemble(body.subarray(0, 2), body.subarray(2), parsed.segments, b, parsed.end, true, notes);
  const s = stripped(whole, o.removeMetadata);
  const src = stripped(b, o.removeMetadata);
  const smaller = s.bytes.length < src.bytes.length;
  const out = smaller ? s.bytes : src.bytes;
  const changes: string[] = [];
  if (smaller) {
    changes.push(o.progressive ? 'Written as a progressive JPEG (it appears gradually while it loads) with Huffman tables made for this picture.' : 'Written as a baseline JPEG with Huffman tables made for this picture.');
    if (parsed.restarts) changes.push('Restart markers removed (they only help a damaged file recover).');
  }
  if (out === b) notes.push('Without loss, the file would not be smaller.');
  return { bytes: out, original: out === b, width: frame.width, height: frame.height, progressive: smaller ? o.progressive : frame.progressive, changes, removed: s.removed, kept: s.kept, notes };
}

// ------------------------------------------------------------------ by quality, or to a size

export interface JpegLossyOptions {
  /** A quality, or a size to meet (bytes) with the quality searched. */
  quality?: number;
  targetBytes?: number;
  progressive: boolean;
  removeMetadata: boolean;
  /** Fit within this box (in the picture's upright orientation), never enlarging; null keeps the size. */
  fit: { width: number; height: number } | null;
  /** Keep the decoded pixels of both, for the similarity measure. */
  measure: boolean;
}

/** The quality range the size search uses. */
export const TARGET_QUALITY = { min: 10, max: 95 } as const;

export interface Decoded { data: Uint8ClampedArray; width: number; height: number }

/**
 * Compresses a JPEG again with MozJPEG. `decodeCmyk` decodes a CMYK JPEG in the browser (with its color profile, to sRGB,
 * turned upright), where MozJPEG cannot; `resize` scales the pixels (./resample).
 */
export async function compressJpeg(b: Uint8Array, o: JpegLossyOptions, env: { decodeCmyk(b: Uint8Array): Promise<Decoded>; resize(d: Decoded, width: number, height: number): Decoded }, progress: (s: string) => void): Promise<JpegResult> {
  const facts = jpegFacts(b);
  const why = jpegProblem(facts);
  if (why) throw new LimitError(why);
  const notes: string[] = [], changes: string[] = [];
  const cmyk = facts.components === 4;
  progress('Decoding');
  let pic: Decoded = cmyk ? await env.decodeCmyk(b) : await mozjpegDecode(b);
  const turned = cmyk && facts.orientation !== 1; // the browser turned it upright
  const before = o.measure ? pic.data : undefined;
  // What the file carries: the JFIF and Adobe segments are the new picture's own; a CMYK file's profile is for CMYK.
  const { segments, end } = carried(b);
  let segs = segments.filter(s => !(s.marker === 0xe0 && ascii(s.bytes, 4, 5) === 'JFIF\0') && !(s.marker === 0xee && ascii(s.bytes, 4, 5) === 'Adobe'));
  if (cmyk) {
    segs = segs.filter(s => !(s.marker === 0xe2 && ascii(s.bytes, 4, 12) === 'ICC_PROFILE\0'));
    if (turned) segs = segs.map(s => (s.marker === 0xe1 && ascii(s.bytes, 4, 6) === 'Exif\0\0' ? { marker: s.marker, bytes: uprightExif(s.bytes) } : s));
    changes.push(`CMYK converted to RGB (sRGB) by the browser${facts.icc ? ' with the file\'s color profile' : ''}: JPEG compression here works in RGB.${turned ? ' The picture was turned upright and its EXIF orientation set to 1.' : ''}`);
  }
  let resized = false;
  if (o.fit) {
    const swap = !turned && facts.orientation >= 5 && facts.orientation <= 8;
    const boxW = swap ? o.fit.height : o.fit.width, boxH = swap ? o.fit.width : o.fit.height;
    const k = Math.min((boxW || Infinity) / pic.width, (boxH || Infinity) / pic.height, 1);
    if (k < 1) {
      progress('Resizing');
      const w = Math.max(1, Math.round(pic.width * k)), h = Math.max(1, Math.round(pic.height * k));
      pic = env.resize(pic, w, h);
      resized = true;
    }
  }
  const gray = facts.components === 1;
  const subsample: 1 | 2 = facts.sampling === '4:4:4' ? 1 : 2;
  if (!gray && !cmyk && facts.sampling !== '4:4:4' && facts.sampling !== '4:2:0') changes.push(`Color detail stored at half resolution both ways (4:2:0); the original used ${facts.sampling}.`);
  const enc = async (q: number) => {
    const jpg = await mozjpegEncode(pic.data, pic.width, pic.height, { quality: q, progressive: o.progressive, subsample, gray });
    // MozJPEG's head: SOI and its JFIF segment; the carried segments go after it.
    const jfifEnd = jpg[2] === 0xff && jpg[3] === 0xe0 ? 4 + u16(jpg, 4) : 2;
    const note: string[] = [];
    const file = assemble(jpg.subarray(0, jfifEnd), jpg.subarray(jfifEnd), segs, b, end, !resized, note);
    return { file: stripped(file, o.removeMetadata), note };
  };
  let quality: number;
  let made: Awaited<ReturnType<typeof enc>>;
  if (o.targetBytes) {
    const target = o.targetBytes;
    const srcSize = o.removeMetadata ? stripped(b, true).bytes.length : b.length;
    if (srcSize <= target && !resized && !cmyk) {
      // Already within the size: nothing is recompressed.
      const s = stripped(b, o.removeMetadata);
      return { bytes: s.bytes, original: s.bytes === b, width: facts.width, height: facts.height, progressive: facts.sof === 0xc2, changes: [], removed: s.removed, kept: s.kept, notes: [`It is already ${fmtSize(srcSize)}, within the ${fmtSize(target)} asked for, so it was not recompressed.`] };
    }
    let lo: number = TARGET_QUALITY.min, hi: number = TARGET_QUALITY.max;
    let best: { q: number; m: Awaited<ReturnType<typeof enc>> } | null = null;
    let smallest: { q: number; size: number } | null = null;
    let tries = 0;
    while (lo <= hi && tries < 8) {
      const mid = Math.round((lo + hi) / 2);
      progress(`Trying quality ${mid}`);
      const m = await enc(mid);
      tries++;
      if (!smallest || m.file.bytes.length < smallest.size) smallest = { q: mid, size: m.file.bytes.length };
      if (m.file.bytes.length <= target) { best = { q: mid, m }; lo = mid + 1; } else hi = mid - 1;
    }
    if (!best) {
      progress(`Trying quality ${TARGET_QUALITY.min}`);
      const m = await enc(TARGET_QUALITY.min);
      if (m.file.bytes.length <= target) best = { q: TARGET_QUALITY.min, m };
      else {
        const metaBytes = segs.reduce((n, s) => n + s.bytes.length, 0) + (resized ? 0 : b.length - end);
        const hint = !o.removeMetadata && metaBytes > target / 4 ? ` Its metadata and extra pictures alone take ${fmtSize(metaBytes)}; removing them would help.` : '';
        throw new LimitError(`At quality ${TARGET_QUALITY.min}, the lowest this tool uses, the file is still ${fmtSize(m.file.bytes.length)}, more than the ${fmtSize(target)} asked for. Make the picture smaller (the size option here, or Resize images) to get there.${hint}`);
      }
    }
    quality = best.q;
    made = best.m;
  } else {
    quality = Math.max(1, Math.min(100, Math.round(o.quality ?? 80)));
    progress(`Encoding at quality ${quality}`);
    made = await enc(quality);
  }
  notes.push(...made.note);
  const out = made.file.bytes;
  // Recompressing that gives no saving is not offered (unless the picture was resized or converted): the original is.
  if (!resized && !cmyk && out.length >= (o.removeMetadata ? stripped(b, true).bytes.length : b.length)) {
    const s = stripped(b, o.removeMetadata);
    return { bytes: s.bytes, original: s.bytes === b, width: facts.width, height: facts.height, progressive: facts.sof === 0xc2, changes: [], removed: s.removed, kept: s.kept, notes: [`At quality ${quality} the file would not be smaller, so it was kept as it was${o.removeMetadata && s.removed.length ? ', without its metadata' : ''}.`] };
  }
  let pixels: JpegResult['pixels'];
  if (o.measure && before && !resized) {
    progress('Measuring the similarity');
    const after = await mozjpegDecode(out);
    pixels = { before, after: after.data, width: after.width, height: after.height };
  } else if (o.measure && resized) notes.push('The similarity was not measured: the picture was resized.');
  if (resized) changes.push(`Resized to ${pic.width.toLocaleString('en-US')} x ${pic.height.toLocaleString('en-US')} pixels, as set.`);
  return { bytes: out, original: false, width: pic.width, height: pic.height, quality, progressive: o.progressive, changes, removed: made.file.removed, kept: made.file.kept, notes, pixels };
}

export const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 1 : 2)} MB` : `${(n / 1024).toFixed(n >= 100 * 1024 ? 0 : 1)} KB`);
