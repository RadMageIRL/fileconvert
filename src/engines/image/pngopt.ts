// Compress PNG: lossless recompression with oxipng (./codecs), held to what the picture is. Every file is checked whole
// first (signature, every chunk's checksum, the header, complete picture data, the end chunk) and its decoded samples are
// fingerprinted: each pixel's position and its red, green, blue and alpha at 16 bits, palette and transparency applied,
// summed as two 64-bit hashes, read a row at a time (so a large picture is never held), every APNG frame and its timing
// included. The result must have the same fingerprint, or it is not used.
//
// oxipng may store the picture differently where no pixel changes: as a palette, in gray, with fewer bits, without
// interlacing. Two of those are not taken: gray in place of color when the file has an RGB color profile (a gray PNG
// cannot carry one, so readers would drop it), and 8 bits in place of 16 unless allowed. Then the picture is written
// again here in its own color type and bit depth (./pngwrite), its chunks copied. Metadata is removed only when asked
// (./metadata, keeping the color profile and the orientation).

import { unzlibSync } from 'fflate';
import { crc32 } from '../../core/crc32';
import { readPng, type PngLayout } from '../pdf/imageinfo';
import { decodePng, eachRow } from '../pdf/pngdecode';
import { oxipng } from './codecs';
import { stripMetadata } from './metadata';
import { writePng, type PngColorType } from './pngwrite';

export interface PngChunkInfo { type: string; start: number; end: number; data: Uint8Array }

export interface PngFile {
  layout: PngLayout;
  chunks: PngChunkInfo[];
  animated: boolean;
  frames: number;
  /** The color space the iCCP profile says ('RGB ', 'GRAY'), or null. */
  iccSpace: string | null;
  /** Bytes after the end chunk. */
  trailing: number;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Reads a PNG's structure, every chunk checked against its checksum. Throws with the reason when it is damaged. */
export function readPngFile(b: Uint8Array): PngFile {
  const chunks: PngChunkInfo[] = [];
  let p = 8, ended = false;
  while (p + 12 <= b.length) {
    const len = u32(b, p);
    const type = ascii(b, p + 4, 4);
    if (p + 12 + len > b.length) break;
    chunks.push({ type, start: p, end: p + 12 + len, data: b.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw new Error('This PNG is cut short: it has no end chunk.');
  const layout = readPng(b, true, crc32);
  const actl = chunks.find(c => c.type === 'acTL');
  let iccSpace: string | null = null;
  const iccp = chunks.find(c => c.type === 'iCCP');
  if (iccp) {
    const z = iccp.data.indexOf(0);
    if (z > 0 && z < 80) {
      try {
        // Only the header is needed; a profile is small, and a bomb is cut off.
        const prof = unzlibSync(iccp.data.subarray(z + 2), { out: new Uint8Array(1 << 22) });
        if (prof.length >= 20) iccSpace = ascii(prof, 16, 4);
      } catch { iccSpace = '?'; }
    }
  }
  return { layout, chunks, animated: !!actl, frames: actl && actl.data.length >= 8 ? u32(actl.data, 0) : 1, iccSpace, trailing: b.length - p };
}

// ------------------------------------------------------------------ the fingerprint

const fmix = (h: number) => {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/** Sums of two hashes of every pixel's position and RGBA at 16 bits: the same for the same picture, however it is
 *  stored (color type, bit depth, palette, interlacing, filters, compression). */
class PixelSum {
  a = 0; b = 0; c = 0; d = 0;
  add(x: number, y: number, r: number, g: number, bl: number, al: number): void {
    const k = Math.imul(x, 0x27d4eb2f) ^ Math.imul(y, 0x165667b1);
    const h1 = fmix(k ^ fmix(((r << 16) | g) ^ 0x9e3779b9) ^ Math.imul((bl << 16) | al, 0xcc9e2d51));
    const h2 = fmix(h1 ^ Math.imul(k + 0x7f4a7c15, 0x1b873593) ^ ((bl << 16) | al));
    this.a = (this.a + h1) >>> 0; this.b = (this.b ^ h1) >>> 0;
    this.c = (this.c + h2) >>> 0; this.d = (this.d ^ Math.imul(h2, 0x2545f491)) >>> 0;
  }
  toString(): string { return [this.a, this.b, this.c, this.d].map(v => v.toString(16).padStart(8, '0')).join(''); }
}

/** Every pixel of one picture (the image, or an APNG frame) into a sum. */
function sumPicture(b: Uint8Array, L: PngLayout, sum: PixelSum): void {
  const ct = L.colorType, d = L.depth;
  const max = (1 << d) - 1, up = 65535 / max;
  const pal = L.palette, trns = L.trns;
  const key = ct === 0 && trns && trns.length >= 2 ? [(trns[0] << 8) | trns[1]] : ct === 2 && trns && trns.length >= 6 ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;
  const s16 = d === 16;
  eachRow(b, L, (pass, yy, row) => {
    const y = pass.y0 + yy * pass.dy;
    for (let i = 0; i < pass.width; i++) {
      const x = pass.x0 + i * pass.dx;
      let r: number, g: number, bl: number, al = 65535;
      if (d < 8) {
        const bit = i * d;
        const v = (row[bit >> 3] >> (8 - d - (bit & 7))) & max;
        if (ct === 3) {
          r = pal![3 * v] * 257; g = pal![3 * v + 1] * 257; bl = pal![3 * v + 2] * 257;
          if (trns && v < trns.length) al = trns[v] * 257;
        } else {
          r = g = bl = v * up;
          if (key && v === key[0]) al = 0;
        }
      } else {
        const n = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
        const at = i * n * (s16 ? 2 : 1);
        const s = (k: number) => (s16 ? (row[at + 2 * k] << 8) | row[at + 2 * k + 1] : row[at + k]);
        const w = (v: number) => (s16 ? v : v * 257);
        if (ct === 3) {
          const v = row[at];
          r = pal![3 * v] * 257; g = pal![3 * v + 1] * 257; bl = pal![3 * v + 2] * 257;
          if (trns && v < trns.length) al = trns[v] * 257;
        } else if (ct === 0 || ct === 4) {
          const v = s(0);
          r = g = bl = w(v);
          if (ct === 4) al = w(s(1)); else if (key && v === key[0]) al = 0;
        } else {
          const R = s(0), G = s(1), B = s(2);
          r = w(R); g = w(G); bl = w(B);
          if (ct === 6) al = w(s(3)); else if (key && R === key[0] && G === key[1] && B === key[2]) al = 0;
        }
      }
      sum.add(x, y, r, g, bl, al);
    }
  });
}

/** The picture a PNG shows, as a list of fingerprints: its image, and each animation frame with its place, timing,
 *  disposal and blending (sequence numbers left out), and the animation's frame and play counts. */
export function pngFingerprint(b: Uint8Array, f: PngFile): string[] {
  const L = f.layout;
  const out: string[] = [];
  const main = new PixelSum();
  sumPicture(b, L, main);
  out.push(`image ${L.info.width}x${L.info.height} ${main}`);
  if (!f.animated) return out;
  const actl = f.chunks.find(c => c.type === 'acTL')!;
  out.push(`acTL ${u32(actl.data, 0)} ${u32(actl.data, 4)}`);
  let frame: { head: string; w: number; h: number; ranges: Array<[number, number]>; main: boolean } | null = null;
  const flush = () => {
    if (!frame) return;
    if (frame.main) out.push(`frame ${frame.head} image`);
    else {
      const sum = new PixelSum();
      const FL: PngLayout = { ...L, info: { ...L.info, width: frame.w, height: frame.h }, idat: frame.ranges };
      sumPicture(b, FL, sum);
      out.push(`frame ${frame.head} ${sum}`);
    }
    frame = null;
  };
  for (const c of f.chunks) {
    if (c.type === 'fcTL') {
      flush();
      const d = c.data;
      if (d.length < 26) throw new Error('This animated PNG is damaged: a frame header is too short.');
      const w = u32(d, 4), h = u32(d, 8);
      frame = { head: [w, h, u32(d, 12), u32(d, 16), (d[20] << 8) | d[21], (d[22] << 8) | d[23], d[24], d[25]].join(','), w, h, ranges: [], main: false };
    } else if (c.type === 'IDAT' && frame) frame.main = true;
    else if (c.type === 'fdAT' && frame) frame.ranges.push([c.start + 12, c.end - 4]);
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ writing it again here

/** The picture's rows as the file stores them (its color type and bit depth), from its decoded planes. */
function rowsOf(b: Uint8Array, L: PngLayout) {
  const planes = decodePng(b, L);
  const w = L.info.width, ct = L.colorType, d = L.depth;
  const colors = ct === 2 || ct === 6 ? 3 : 1;
  const sb = d === 16 ? 2 : 1;
  const rowBytes = Math.ceil((w * (ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4) * d) / 8);
  const row = new Uint8Array(rowBytes);
  const down = d < 8 && ct === 0 ? ((1 << d) - 1) / 255 : 1;
  return (y: number) => {
    row.fill(0);
    if (d < 8) {
      for (let x = 0; x < w; x++) {
        const v = Math.round(planes.color[y * w + x] * down);
        const bit = x * d;
        row[bit >> 3] |= v << (8 - d - (bit & 7));
      }
      return row;
    }
    let o = 0;
    for (let x = 0; x < w; x++) {
      const px = y * w + x;
      for (let k = 0; k < colors * sb; k++) row[o++] = planes.color[px * colors * sb + k];
      if (ct === 4 || ct === 6) {
        if (!planes.alpha) { row[o++] = 255; if (sb === 2) row[o++] = 255; }
        else if (sb === 2) { row[o++] = planes.alpha[px * 2]; row[o++] = planes.alpha[px * 2 + 1]; }
        else row[o++] = planes.alpha[px];
      }
    }
    return row;
  };
}

/** Where a copied chunk goes: before the palette (color), before the picture data, or after it (text). */
const BEFORE_PALETTE = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi']);
const AFTER_DATA = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME']);

/** The picture written again in its own color type and bit depth, without interlacing, every ancillary chunk copied. */
function rewrite(b: Uint8Array, f: PngFile): Promise<Uint8Array> {
  const L = f.layout;
  const extra = { beforePalette: [] as Uint8Array[], beforeData: [] as Uint8Array[], afterData: [] as Uint8Array[] };
  for (const c of f.chunks) {
    if (['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(c.type)) continue;
    const whole = b.subarray(c.start, c.end);
    (BEFORE_PALETTE.has(c.type) ? extra.beforePalette : AFTER_DATA.has(c.type) ? extra.afterData : extra.beforeData).push(whole);
  }
  return writePng({ width: L.info.width, height: L.info.height, colorType: L.colorType as PngColorType, depth: L.depth as 1 | 2 | 4 | 8 | 16, palette: L.palette ?? undefined, row: rowsOf(b, L) }, extra);
}

// ------------------------------------------------------------------ Compress PNG

export interface PngOptions {
  /** oxipng's preset: 2 (standard), 4 (thorough) or 6 (most). */
  level: number;
  removeMetadata: boolean;
  /** Keep 16 bits per channel even where every sample would fit in 8. */
  keep16: boolean;
}

export interface PngResult {
  bytes: Uint8Array;
  /** The file is the original, unchanged: nothing smaller was found. */
  original: boolean;
  /** How the picture is stored now, where that changed ("8-bit palette, was 8-bit RGB"). */
  changes: string[];
  removed: string[];
  kept: string[];
  notes: string[];
  frames: number;
}

const TYPE: Record<number, string> = { 0: 'gray', 2: 'RGB', 3: 'palette', 4: 'gray with alpha', 6: 'RGBA' };
const stored = (L: PngLayout) => `${L.depth}-bit ${TYPE[L.colorType]}${L.colorType === 3 && L.palette ? ` (${L.palette.length / 3} colors)` : ''}`;

const CHUNK_NAME: Record<string, string> = {
  bKGD: 'the background color suggestion (bKGD)', sBIT: 'the significant bits (sBIT)', hIST: 'the palette histogram (hIST)', sPLT: 'the suggested palette (sPLT)',
};

export async function compressPng(b: Uint8Array, o: PngOptions, progress: (stage: string) => void): Promise<PngResult> {
  progress('Checking the PNG');
  const src = readPngFile(b);
  const want = pngFingerprint(b, src);
  const notes: string[] = [];
  let input = b;
  let removed: string[] = [], kept: string[] = [];
  if (o.removeMetadata) {
    const s = stripMetadata(b, 'png', { keepOrientation: true, keepColorProfile: true });
    input = s.bytes; removed = s.removed; kept = s.kept;
  }
  const inFile = input === b ? src : readPngFile(input);
  progress('Compressing (oxipng)');
  let out = await oxipng(input, o.level);
  let res = readPngFile(out);
  progress('Checking every pixel');
  if (pngFingerprint(out, res).join('|') !== want.join('|')) throw new Error('The optimized PNG did not match the original, so it was not used.');
  const colorToGray = (src.layout.colorType === 2 || src.layout.colorType === 6 || src.layout.colorType === 3) && (res.layout.colorType === 0 || res.layout.colorType === 4);
  const profileClash = colorToGray && src.iccSpace !== null && src.iccSpace !== 'GRAY';
  const lostDepth = o.keep16 && src.layout.depth === 16 && res.layout.depth < 16;
  // Why oxipng's smaller file was not used, said only when what is offered instead is not simply the original.
  let why = '';
  if (profileClash || lostDepth) {
    why = profileClash
      ? 'Its colors are all gray, but its color profile is for RGB, which a gray PNG cannot carry, so it stays RGB.'
      : 'Kept at 16 bits per channel, as set, though every sample fits in 8.';
    if (src.animated) out = input; // frames cannot be written again here
    else {
      progress('Writing the PNG again');
      out = await rewrite(input, inFile);
      res = readPngFile(out);
      if (pngFingerprint(out, res).join('|') !== want.join('|')) throw new Error('The PNG written again did not match the original, so it was not used.');
    }
  }
  // Keep whichever is smallest: the optimized file, or the input (the original, or the original without its metadata).
  if (out.length >= input.length) { out = input; res = inFile; }
  if (why && out !== b) notes.push(why);
  const original = out === b;
  const changes: string[] = [];
  if (!original) {
    if (stored(src.layout) !== stored(res.layout)) changes.push(`Stored as ${stored(res.layout)}, was ${stored(src.layout)}; no pixel changed.`);
    if (src.layout.interlaced && !res.layout.interlaced) changes.push('Interlacing removed: the picture no longer appears gradually while it loads (no pixel changed).');
    const before = new Set(inFile.chunks.map(c => c.type)), after = new Set(res.chunks.map(c => c.type));
    const lost = [...before].filter(t => !after.has(t) && CHUNK_NAME[t]);
    if (lost.length) changes.push(`Removed because the picture is now stored differently: ${lost.map(t => CHUNK_NAME[t]).join(', ')}.`);
    if (src.trailing && !res.trailing) removed.push('Extra data after the end of the PNG');
  }
  return { bytes: out, original, changes, removed, kept, notes, frames: src.animated ? src.frames : 1 };
}
