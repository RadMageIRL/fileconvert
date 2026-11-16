// Reads an image's dimensions and whether it is animated from its header bytes, before anything decodes
// it. This is the decompression-bomb guard: a 300-byte PNG can claim 60,000 x 60,000 pixels, and decoding
// it would ask the browser for 14 GB.

import type { FormatId } from '../../core/formats';

export interface HeaderInfo {
  width?: number;
  height?: number;
  animated?: boolean;
  frames?: number;
}

const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const i32le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

function png(b: Uint8Array): HeaderInfo {
  const info: HeaderInfo = { width: u32be(b, 16), height: u32be(b, 20), animated: false };
  // APNG: an acTL chunk before the first IDAT.
  let p = 8;
  while (p + 8 <= b.length) {
    const len = u32be(b, p);
    const t = tag(b, p + 4);
    if (t === 'acTL') {
      info.frames = u32be(b, p + 8);
      info.animated = (info.frames ?? 0) > 1;
      break;
    }
    if (t === 'IDAT' || t === 'IEND') break;
    p += 12 + len;
  }
  return info;
}

function gif(b: Uint8Array): HeaderInfo {
  const info: HeaderInfo = { width: u16le(b, 6), height: u16le(b, 8) };
  // Count image descriptors by walking the block structure.
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  let frames = 0;
  while (p < b.length) {
    const c = b[p];
    if (c === 0x2c) {
      frames++;
      if (frames > 1) break;
      let q = p + 10;
      if (b[p + 9] & 0x80) q += 3 * (1 << ((b[p + 9] & 7) + 1));
      q++; // LZW minimum code size
      while (q < b.length && b[q] !== 0) q += b[q] + 1;
      p = q + 1;
    } else if (c === 0x21) {
      let q = p + 2;
      while (q < b.length && b[q] !== 0) q += b[q] + 1;
      p = q + 1;
    } else break;
  }
  // Counting stops at the second frame, so the total is known only for a still image.
  if (frames === 1) info.frames = 1;
  info.animated = frames > 1;
  return info;
}

function bmp(b: Uint8Array): HeaderInfo {
  const dib = u16le(b, 14);
  if (dib === 12) return { width: u16le(b, 18), height: u16le(b, 20), animated: false };
  return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)), animated: false };
}

/** The EXIF orientation tag (1 to 8) in a JPEG APP1 segment, or 1 when there is none. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (tag(b, start) !== 'Exif') return 1;
  const t = start + 6;
  const le = b[t] === 0x49;
  const r16 = (i: number) => le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
  const r32 = (i: number) => le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : u32be(b, i);
  const ifd = t + r32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = r16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}

function jpeg(b: Uint8Array): HeaderInfo {
  let p = 2;
  let orientation = 1;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (m === 0xe1) orientation = exifOrientation(b, p + 4, Math.min(b.length, p + 2 + u16be(b, p + 2)));
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const height = u16be(b, p + 5), width = u16be(b, p + 7);
      // Orientations 5 to 8 turn the picture a quarter turn: it is shown, and converted, the other way round.
      return orientation >= 5 ? { width: height, height: width, animated: false } : { width, height, animated: false };
    }
    p += 2 + u16be(b, p + 2);
  }
  return { animated: false };
}

function webp(b: Uint8Array): HeaderInfo {
  const chunk = tag(b, 12);
  if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, animated: false };
  if (chunk === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false };
  }
  if (chunk === 'VP8X') {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: (b[20] & 0x02) !== 0 };
  }
  return {};
}

/** HEIF and AVIF: the ispe property gives the image size; an AVIF image sequence has the avis brand. */
function isobmffImage(b: Uint8Array): HeaderInfo {
  const info: HeaderInfo = { animated: tag(b, 8) === 'avis' };
  let best = 0;
  let rotated = false;
  for (let i = 4; i + 5 <= b.length; i++) {
    if (b[i] === 0x69 && i + 16 <= b.length && tag(b, i) === 'ispe') {
      const w = u32be(b, i + 8), h = u32be(b, i + 12);
      // The primary image is usually the largest; thumbnails and grid tiles are smaller.
      if (w * h > best) { best = w * h; info.width = w; info.height = h; }
    }
    // irot: rotation in quarter turns counterclockwise. A quarter or three-quarter turn swaps the sides.
    if (b[i] === 0x69 && tag(b, i) === 'irot') rotated = (b[i + 4] & 3) % 2 === 1;
  }
  if (rotated && info.width && info.height) [info.width, info.height] = [info.height, info.width];
  return info;
}

export function readHeader(bytes: Uint8Array, format: FormatId): HeaderInfo {
  try {
    switch (format) {
      case 'png': return png(bytes);
      case 'gif': return gif(bytes);
      case 'bmp': return bmp(bytes);
      case 'jpg': return jpeg(bytes);
      case 'webp': return webp(bytes);
      case 'avif':
      case 'heic': return isobmffImage(bytes);
      default: return {};
    }
  } catch {
    return {};
  }
}
