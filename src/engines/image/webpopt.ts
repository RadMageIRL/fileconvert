// Compress WebP: decoded by libwebp (colors as stored) and encoded again by libwebp, lossy at a quality or to a file size,
// or lossless (every pixel kept, the colors under fully transparent pixels included, checked by decoding the result).
// What the file carries is kept unless removal is asked for: its color profile (ICCP), EXIF (with the orientation, so the
// pixels are never turned) and XMP go into the new file's extended header. Animated WebP is refused with the reason:
// recompressing its frames is not supported here.

import { LimitError } from '../../core/limits';
import { webpDecode, webpEncode } from './codecs';
import { exifFacts, minimalExif } from './metadata';

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, Math.min(b.length, at + n)));
const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

export interface WebpFacts {
  width: number;
  height: number;
  /** VP8L: the picture is stored without loss. */
  lossless: boolean;
  alpha: boolean;
  animated: boolean;
  frames: number;
  icc: Uint8Array | null;
  exif: Uint8Array | null;
  xmp: Uint8Array | null;
  orientation: number;
  trailing: number;
}

/** A WebP's chunks, checked: sizes within the file, a picture chunk present. */
export function webpFacts(b: Uint8Array): WebpFacts {
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') throw new Error('This is not a WebP file.');
  const riffEnd = 8 + le32(b, 4);
  if (riffEnd > b.length) throw new Error('This WebP file is cut short.');
  const f: WebpFacts = { width: 0, height: 0, lossless: false, alpha: false, animated: false, frames: 1, icc: null, exif: null, xmp: null, orientation: 1, trailing: b.length - riffEnd };
  let p = 12, picture = false;
  while (p + 8 <= riffEnd) {
    const type = ascii(b, p, 4), len = le32(b, p + 4);
    const s = p + 8, e = s + len;
    if (e > riffEnd) throw new Error('This WebP file is damaged or cut short: a chunk runs past its end.');
    const d = b.subarray(s, e);
    if (type === 'VP8X' && len >= 10) {
      f.alpha = (d[0] & 0x10) !== 0;
      f.animated = (d[0] & 0x02) !== 0;
      f.width = le24(d, 4) + 1;
      f.height = le24(d, 7) + 1;
    } else if (type === 'VP8 ' && len >= 10) {
      picture = true;
      if (!f.width) { f.width = (d[6] | (d[7] << 8)) & 0x3fff; f.height = (d[8] | (d[9] << 8)) & 0x3fff; }
    } else if (type === 'VP8L' && len >= 5) {
      picture = true;
      f.lossless = true;
      const bits = le32(d, 1);
      if (!f.width) { f.width = (bits & 0x3fff) + 1; f.height = ((bits >>> 14) & 0x3fff) + 1; }
      if ((bits >>> 28) & 1) f.alpha = true;
    } else if (type === 'ALPH') f.alpha = true;
    else if (type === 'ANIM') f.animated = true;
    else if (type === 'ANMF') { f.animated = true; picture = true; }
    else if (type === 'ICCP') f.icc = d;
    else if (type === 'EXIF') {
      f.exif = d;
      f.orientation = exifFacts(ascii(d, 0, 6) === 'Exif\0\0' ? d.subarray(6) : d).orientation;
    } else if (type === 'XMP ') f.xmp = d;
    p = e + (len & 1);
  }
  if (f.animated) f.frames = Math.max(1, countFrames(b, riffEnd));
  if (!picture) throw new Error('No picture was found in this WebP file.');
  return f;
}

function countFrames(b: Uint8Array, end: number): number {
  let n = 0, p = 12;
  while (p + 8 <= end) { const len = le32(b, p + 4); if (ascii(b, p, 4) === 'ANMF') n++; p += 8 + len + (len & 1); }
  return n;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/**
 * The WebP libwebp made, with a color profile, EXIF and XMP added in an extended header (VP8X) when there are any:
 * VP8X, ICCP, ALPH, VP8 or VP8L, EXIF, XMP, in the order the WebP container specification gives.
 */
export function withMetadata(encoded: Uint8Array, carry: { icc?: Uint8Array | null; exif?: Uint8Array | null; xmp?: Uint8Array | null }, width: number, height: number, force = false): Uint8Array {
  if (!carry.icc && !carry.exif && !carry.xmp && !force) return encoded;
  const end = 8 + le32(encoded, 4);
  const parts: Uint8Array[] = [];
  let alpha = false;
  let p = 12;
  while (p + 8 <= end) {
    const type = ascii(encoded, p, 4), len = le32(encoded, p + 4);
    const whole = encoded.subarray(p, p + 8 + len + (len & 1));
    if (type === 'VP8X') alpha = (encoded[p + 8] & 0x10) !== 0;
    else if (type === 'ALPH') { alpha = true; parts.push(whole); }
    else if (type === 'VP8 ' || type === 'VP8L') {
      if (type === 'VP8L' && (le32(encoded, p + 9) >>> 28) & 1) alpha = true;
      parts.push(whole);
    }
    p += 8 + len + (len & 1);
  }
  const vp8x = new Uint8Array(10);
  vp8x[0] = (carry.icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (carry.exif ? 0x08 : 0) | (carry.xmp ? 0x04 : 0);
  vp8x[4] = (width - 1) & 255; vp8x[5] = ((width - 1) >> 8) & 255; vp8x[6] = ((width - 1) >> 16) & 255;
  vp8x[7] = (height - 1) & 255; vp8x[8] = ((height - 1) >> 8) & 255; vp8x[9] = ((height - 1) >> 16) & 255;
  const body = [chunk('VP8X', vp8x), ...(carry.icc ? [chunk('ICCP', carry.icc)] : []), ...parts, ...(carry.exif ? [chunk('EXIF', carry.exif)] : []), ...(carry.xmp ? [chunk('XMP ', carry.xmp)] : [])];
  const size = body.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(12 + size);
  out.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(out.buffer).setUint32(4, 4 + size, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  let at = 12;
  for (const x of body) { out.set(x, at); at += x.length; }
  return out;
}

export interface WebpOptions {
  /** 'auto': lossless files stay lossless, lossy files at `quality`. */
  mode: 'auto' | 'lossy' | 'lossless' | 'target';
  quality: number;
  targetBytes?: number;
  removeMetadata: boolean;
  measure: boolean;
}

export interface WebpResult {
  bytes: Uint8Array;
  original: boolean;
  width: number;
  height: number;
  lossless: boolean;
  quality?: number;
  changes: string[];
  removed: string[];
  kept: string[];
  notes: string[];
  pixels?: { before: Uint8ClampedArray; after: Uint8ClampedArray; width: number; height: number };
}

export const WEBP_TARGET_QUALITY = { min: 10, max: 95 } as const;

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

export async function compressWebp(b: Uint8Array, o: WebpOptions, progress: (s: string) => void): Promise<WebpResult> {
  const f = webpFacts(b);
  if (f.animated) throw new LimitError(`This WebP is animated (${f.frames} frames). Compressing animated WebP is not supported here, and only its first frame would be kept, so it was not changed. To keep the animation, convert it to WebP or MP4 in the converter.`);
  progress('Decoding');
  const pic = await webpDecode(b);
  const lossless = o.mode === 'lossless' || (o.mode === 'auto' && f.lossless);
  // What goes in the new file besides the picture.
  const removed: string[] = [], kept: string[] = [];
  const carry = { icc: f.icc, exif: f.exif, xmp: f.xmp };
  if (o.removeMetadata) {
    if (f.exif) removed.push('Camera details and settings (EXIF)');
    if (f.xmp) removed.push('XMP (editing history, descriptions, ratings)');
    carry.exif = f.orientation !== 1 ? minimalExif(f.orientation) : null;
    carry.xmp = null;
    if (f.orientation !== 1) kept.push('Orientation (a minimal EXIF block that holds nothing else)');
  }
  if (f.icc) kept.push('Color profile (ICC), so colors look the same');
  const make = async (q: number) => withMetadata(await webpEncode(pic.data, pic.width, pic.height, { quality: q, lossless }), carry, pic.width, pic.height);
  let out: Uint8Array, quality: number | undefined;
  const notes: string[] = [];
  const baseline = o.removeMetadata ? withMetadataStripped(b, f, carry) : b;
  if (lossless) {
    progress('Encoding without loss');
    out = await make(100);
    progress('Checking every pixel');
    const back = await webpDecode(out);
    if (back.width !== pic.width || back.height !== pic.height || !sameBytes(back.data, pic.data)) throw new Error('The lossless WebP did not hold the same pixels, so it was not used.');
  } else if (o.mode === 'target' && o.targetBytes) {
    const target = o.targetBytes;
    if (baseline.length <= target) {
      return { bytes: baseline, original: baseline === b, width: f.width, height: f.height, lossless: f.lossless, changes: [], removed, kept, notes: [`It is already ${fmtSize(baseline.length)}, within the ${fmtSize(target)} asked for, so it was not recompressed.`] };
    }
    let lo: number = WEBP_TARGET_QUALITY.min, hi: number = WEBP_TARGET_QUALITY.max, best: { q: number; out: Uint8Array } | null = null, tries = 0;
    while (lo <= hi && tries < 8) {
      const mid = Math.round((lo + hi) / 2);
      progress(`Trying quality ${mid}`);
      const x = await make(mid);
      tries++;
      if (x.length <= target) { best = { q: mid, out: x }; lo = mid + 1; } else hi = mid - 1;
    }
    if (!best) {
      const x = await make(WEBP_TARGET_QUALITY.min);
      if (x.length > target) throw new LimitError(`At quality ${WEBP_TARGET_QUALITY.min}, the lowest this tool uses, the file is still ${fmtSize(x.length)}, more than the ${fmtSize(target)} asked for. Make the picture smaller (Resize images) to get there.`);
      best = { q: WEBP_TARGET_QUALITY.min, out: x };
    }
    out = best.out; quality = best.q;
  } else {
    quality = Math.max(1, Math.min(100, Math.round(o.quality)));
    progress(`Encoding at quality ${quality}`);
    out = await make(quality);
  }
  if (out.length >= baseline.length) {
    notes.push(lossless ? 'Without loss, the file would not be smaller, so it was kept as it was.' : `At quality ${quality} the file would not be smaller, so it was kept as it was.`);
    return { bytes: baseline, original: baseline === b, width: f.width, height: f.height, lossless: f.lossless, changes: [], removed: baseline === b ? [] : removed, kept, notes };
  }
  const changes: string[] = [];
  if (!lossless && f.lossless) changes.push('Stored with lossy compression; the original was lossless.');
  let pixels: WebpResult['pixels'];
  if (o.measure && !lossless) {
    progress('Measuring the similarity');
    pixels = { before: pic.data, after: (await webpDecode(out)).data, width: pic.width, height: pic.height };
  }
  return { bytes: out, original: false, width: pic.width, height: pic.height, lossless, quality, changes, removed, kept, notes, pixels };
}

/** The original's own picture data with only the metadata that removal keeps (for comparing sizes). */
function withMetadataStripped(b: Uint8Array, f: WebpFacts, carry: { icc?: Uint8Array | null; exif?: Uint8Array | null; xmp?: Uint8Array | null }): Uint8Array {
  // The original's picture chunks, re-wrapped: the picture itself is not touched.
  const end = 8 + le32(b, 4);
  const parts: Uint8Array[] = [];
  let p = 12;
  while (p + 8 <= end) {
    const type = ascii(b, p, 4), len = le32(b, p + 4);
    if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L') parts.push(b.subarray(p, p + 8 + len + (len & 1)));
    p += 8 + len + (len & 1);
  }
  const size = parts.reduce((n, x) => n + x.length, 0);
  const bare = new Uint8Array(12 + size);
  bare.set(b.subarray(0, 12));
  new DataView(bare.buffer).setUint32(4, 4 + size, true);
  let at = 12;
  for (const x of parts) { bare.set(x, at); at += x.length; }
  const hasAlph = parts.some(x => ascii(x, 0, 4) === 'ALPH');
  if (!carry.icc && !carry.exif && !carry.xmp && !hasAlph) return bare;
  return withMetadata(bare, carry, f.width, f.height, true);
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
