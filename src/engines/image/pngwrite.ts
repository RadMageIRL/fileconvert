// Writes PNG files from rows of samples: any PNG color type and bit depth, 16 bits included, with a palette and
// transparency where given, and the ancillary chunks the caller passes kept as they are. Each row gets the filter that
// leaves it smallest by the usual measure (the least sum of absolute differences; none for palettes and fewer than 8
// bits, as the PNG specification recommends), and the data is deflated in a stream by the browser's own zlib
// (CompressionStream), so a large picture is never held a second time while it is compressed; where there is none, by
// fflate in one piece. (fflate 0.8.3's streaming compressor made invalid data for some filtered rows, so it is not
// used here.) Used by Resize images and by Compress PNG where its optimizer cannot be used.

import { zlibSync } from 'fflate';
import { crc32 } from '../../core/crc32';

export type PngColorType = 0 | 2 | 3 | 4 | 6;

export interface PngRows {
  width: number;
  height: number;
  colorType: PngColorType;
  depth: 1 | 2 | 4 | 8 | 16;
  /** Row y as PNG stores it, without a filter byte: samples packed from the high bit for fewer than 8 bits, 16-bit
   *  samples big-endian. The array may be reused for the next row. */
  row(y: number): Uint8Array;
  /** PLTE data (RGB triples), for color type 3. */
  palette?: Uint8Array;
}

/** Chunks to copy into the file, whole (length, type, data and CRC): those that must come before PLTE (color space,
 *  gamma, significant bits), those between PLTE and IDAT (transparency, background, physical size, EXIF), and those
 *  after IDAT (text). */
export interface PngExtra { beforePalette?: Uint8Array[]; beforeData?: Uint8Array[]; afterData?: Uint8Array[] }

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CHANNELS: Record<PngColorType, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Picks a filter for one row and writes it, filter byte first, into `out`. */
function filterRow(cur: Uint8Array, prev: Uint8Array, bpp: number, adaptive: boolean, out: Uint8Array, scratch: Uint8Array): void {
  const n = cur.length;
  if (!adaptive) { out[0] = 0; out.set(cur, 1); return; }
  let best = -1, bestSum = Infinity;
  for (let f = 0; f <= 4; f++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let pred: number;
      if (f === 0) pred = 0;
      else if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      const v = (cur[i] - pred) & 0xff;
      scratch[i] = v;
      sum += v < 128 ? v : 256 - v;
      if (sum >= bestSum) break;
    }
    if (sum < bestSum) {
      bestSum = sum;
      best = f;
      out[0] = f;
      out.set(scratch.subarray(0, n), 1);
    }
  }
  void best;
}

/** Compresses the filtered rows as one zlib stream: through CompressionStream where the browser has it, in batches,
 *  else in one piece. */
async function deflate(rows: (emit: (batch: Uint8Array) => Promise<void>) => Promise<void>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; out.push(value); } })();
    await rows(async batch => { await writer.ready; await writer.write(batch as Uint8Array<ArrayBuffer>); });
    await writer.close();
    await reading;
    return out;
  }
  const all: Uint8Array[] = [];
  await rows(async batch => { all.push(batch); });
  const joined = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of all) { joined.set(x, at); at += x.length; }
  return [zlibSync(joined, { level: 9 })];
}

/** The picture's rows, each with the filter chosen for it, in batches of up to 4 MB: what the zlib stream holds. */
export async function filteredRows(pic: PngRows, emit: (batch: Uint8Array) => Promise<void>): Promise<void> {
  const { width, height, colorType, depth } = pic;
  const bitsPerPixel = CHANNELS[colorType] * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const adaptive = colorType !== 3 && depth >= 8;
  let prev = new Uint8Array(rowBytes);
  let cur = new Uint8Array(rowBytes);
  const scratch = new Uint8Array(rowBytes);
  const out = new Uint8Array(rowBytes + 1);
  const size = Math.max(rowBytes + 1, Math.min(4 << 20, (rowBytes + 1) * 64));
  let batch = new Uint8Array(size);
  let fill = 0;
  for (let y = 0; y < height; y++) {
    cur.set(pic.row(y).subarray(0, rowBytes));
    filterRow(cur, prev, bpp, adaptive, out, scratch);
    if (fill + out.length > batch.length) { await emit(batch.subarray(0, fill)); batch = new Uint8Array(size); fill = 0; }
    batch.set(out, fill);
    fill += out.length;
    [prev, cur] = [cur, prev];
  }
  if (fill) await emit(batch.subarray(0, fill));
}

/** A whole PNG from rows of samples. */
export async function writePng(pic: PngRows, extra: PngExtra = {}): Promise<Uint8Array> {
  const { width, height, colorType, depth } = pic;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts: Uint8Array[] = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), pngChunk('IHDR', ihdr)];
  parts.push(...(extra.beforePalette ?? []));
  if (colorType === 3 && pic.palette) parts.push(pngChunk('PLTE', pic.palette));
  parts.push(...(extra.beforeData ?? []));
  const compressed = await deflate(emit => filteredRows(pic, emit));
  // The compressed data in IDAT chunks of up to 256 KB.
  const total = compressed.reduce((n, x) => n + x.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const x of compressed) { joined.set(x, at); at += x.length; }
  for (let i = 0; i < total; i += 262144) parts.push(pngChunk('IDAT', joined.subarray(i, i + 262144)));
  parts.push(...(extra.afterData ?? []));
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  at = 0;
  for (const p of parts) { file.set(p, at); at += p.length; }
  return file;
}

/** Rows of an RGBA picture, 8 or 16 bits per channel (16-bit samples in a Uint16Array), as the smallest color type
 *  that holds every pixel exactly: gray when every pixel is gray, without alpha when every pixel is opaque. */
export function rgbaRows(data: Uint8Array | Uint8ClampedArray | Uint16Array, width: number, height: number): PngRows {
  const wide = data instanceof Uint16Array;
  const max = wide ? 65535 : 255;
  let gray = true, opaque = true;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== max) opaque = false;
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) gray = false;
    if (!gray && !opaque) break;
  }
  const colorType: PngColorType = gray ? (opaque ? 0 : 4) : opaque ? 2 : 6;
  const ch = CHANNELS[colorType];
  const sb = wide ? 2 : 1;
  const row = new Uint8Array(width * ch * sb);
  const pick = gray ? (opaque ? [0] : [0, 3]) : opaque ? [0, 1, 2] : [0, 1, 2, 3];
  return {
    width, height, colorType, depth: wide ? 16 : 8,
    row(y) {
      let o = 0;
      for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
        for (const c of pick) {
          const v = data[i + c];
          if (wide) { row[o++] = v >> 8; row[o++] = v & 255; } else row[o++] = v;
        }
      }
      return row;
    },
  };
}
