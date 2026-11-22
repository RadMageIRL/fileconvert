// ICO (and CUR) files: a directory of pictures of different sizes. Reading takes the largest picture, which is
// stored either as a PNG or as a Windows bitmap (DIB) with an AND mask for transparency, in 1, 4, 8, 24 or
// 32 bits per pixel. Writing stores each size as a PNG, which Windows (Vista and later) and every browser read,
// and which keeps full transparency. Pure functions over bytes; the caller decodes PNG entries and draws.

export interface IcoEntry {
  width: number;
  height: number;
  bitCount: number;
  offset: number;
  size: number;
  png: boolean;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const isPng = (b: Uint8Array, o: number) => b[o] === 0x89 && b[o + 1] === 0x50 && b[o + 2] === 0x4e && b[o + 3] === 0x47;

/** Lists the pictures in an ICO or CUR file. Throws when the directory is not valid. */
export function readIcoDirectory(b: Uint8Array): IcoEntry[] {
  if (b.length < 6 || u16(b, 0) !== 0 || (u16(b, 2) !== 1 && u16(b, 2) !== 2)) throw new Error('This is not a valid ICO file.');
  const count = u16(b, 4);
  if (count === 0 || count > 256 || 6 + count * 16 > b.length) throw new Error('The ICO file lists no pictures, or more than it holds.');
  const out: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = u32(b, e + 8), offset = u32(b, e + 12);
    if (offset < 6 + count * 16 || offset + size > b.length || size < 8) continue;
    const png = isPng(b, offset);
    let width = b[e] || 256, height = b[e + 1] || 256, bitCount = u16(b, e + 6);
    if (png && size >= 33) {
      width = (b[offset + 16] << 24 | b[offset + 17] << 16 | b[offset + 18] << 8 | b[offset + 19]) >>> 0;
      height = (b[offset + 20] << 24 | b[offset + 21] << 16 | b[offset + 22] << 8 | b[offset + 23]) >>> 0;
      bitCount = 32;
    } else if (!png && size >= 40 && u32(b, offset) >= 40) {
      width = Math.abs(i32(b, offset + 4));
      height = Math.abs(i32(b, offset + 8)) / 2;
      bitCount = u16(b, offset + 14);
    }
    if (!width || !height) continue;
    out.push({ width, height, bitCount, offset, size, png });
  }
  if (!out.length) throw new Error('None of the pictures in this ICO file could be read. It may be damaged.');
  return out;
}

/** The picture to convert: the largest, and of equal sizes the one with the most colors. */
export function bestEntry(entries: IcoEntry[]): IcoEntry {
  return [...entries].sort((a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount)[0];
}

/** Decodes a bitmap (DIB) entry to RGBA, applying the palette and the AND mask. */
export function decodeIcoBitmap(b: Uint8Array, e: IcoEntry): { rgba: Uint8ClampedArray; width: number; height: number } {
  const o = e.offset;
  const headerSize = u32(b, o);
  const width = Math.abs(i32(b, o + 4));
  const rawHeight = i32(b, o + 8);
  const height = Math.abs(rawHeight) / 2;
  const bpp = u16(b, o + 14);
  const compression = u32(b, o + 16);
  if (!Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024) throw new Error('This ICO picture has an invalid size.');
  if (![1, 4, 8, 24, 32].includes(bpp)) throw new Error(`ICO pictures with ${bpp} bits per pixel are not supported.`);
  if (compression !== 0 && !(compression === 3 && bpp === 32)) throw new Error('This ICO picture uses a compressed bitmap, which is not supported.');
  const colors = bpp <= 8 ? (u32(b, o + 32) || (1 << bpp)) : 0;
  const palette = o + headerSize + (compression === 3 ? 12 : 0);
  const xorStride = Math.floor((width * bpp + 31) / 32) * 4;
  const andStride = Math.floor((width + 31) / 32) * 4;
  const xor = palette + colors * 4;
  const and = xor + xorStride * height;
  if (and > e.offset + e.size || and > b.length) throw new Error('This ICO picture is cut short.');
  const hasMask = and + andStride * height <= Math.min(b.length, e.offset + e.size);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const bottomUp = rawHeight > 0;
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const srcRow = bottomUp ? height - 1 - y : y;
    const row = xor + srcRow * xorStride;
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      let r: number, g: number, bl: number, a = 255;
      if (bpp === 32) { bl = b[row + x * 4]; g = b[row + x * 4 + 1]; r = b[row + x * 4 + 2]; a = b[row + x * 4 + 3]; if (a) anyAlpha = true; }
      else if (bpp === 24) { bl = b[row + x * 3]; g = b[row + x * 3 + 1]; r = b[row + x * 3 + 2]; }
      else {
        const bit = x * bpp;
        const idx = (b[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const p = palette + idx * 4;
        bl = b[p]; g = b[p + 1]; r = b[p + 2];
      }
      rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = bl; rgba[d + 3] = a;
    }
  }
  // 32-bit pictures carry their own alpha; older ones (or 32-bit ones with an empty alpha channel) use the mask.
  if (bpp < 32 || !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const srcRow = bottomUp ? height - 1 - y : y;
      for (let x = 0; x < width; x++) {
        const transparent = hasMask && (b[and + srcRow * andStride + (x >> 3)] >> (7 - (x & 7))) & 1;
        rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { rgba, width, height };
}

/** The sizes an ICO setting stands for. */
export function icoSizes(setting: string): number[] {
  if (setting === 'all') return [16, 32, 48, 64, 128, 256];
  const n = Number(setting);
  return [16, 32, 48, 64, 128, 256].includes(n) ? [n] : [16, 32, 48];
}

/** Writes an ICO file from square PNG pictures, smallest first. */
export function writeIco(pngs: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const sorted = [...pngs].sort((a, b) => a.size - b.size);
  const head = 6 + sorted.length * 16;
  const total = head + sorted.reduce((n, p) => n + p.png.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(2, 1, true);
  dv.setUint16(4, sorted.length, true);
  let offset = head;
  sorted.forEach((p, i) => {
    const e = 6 + i * 16;
    out[e] = p.size >= 256 ? 0 : p.size;
    out[e + 1] = p.size >= 256 ? 0 : p.size;
    dv.setUint16(e + 4, 1, true);
    dv.setUint16(e + 6, 32, true);
    dv.setUint32(e + 8, p.png.length, true);
    dv.setUint32(e + 12, offset, true);
    out.set(p.png, offset);
    offset += p.png.length;
  });
  return out;
}
