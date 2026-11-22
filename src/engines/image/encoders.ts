// Encoders for the formats a browser canvas cannot write: BMP, GIF (static and animated) and AVIF, plus WebP
// for browsers whose canvas has no WebP encoder. BMP is written here; the others use small, audited libraries
// (gifenc, and the libavif and libwebp builds from jSquash). TIFF and ICO are written in ./tiff and ./ico.

import { applyPalette, GIFEncoder, quantize } from 'gifenc';

/** 24-bit BMP, bottom-up rows padded to four bytes. Callers flatten transparency first. */
export function encodeBmp(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imageSize = rowSize * height;
  const out = new Uint8Array(54 + imageSize);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(30, 0, true);
  dv.setUint32(34, imageSize, true);
  dv.setInt32(38, 2835, true); // 72 dpi
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    let dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      out[dst++] = rgba[s + 2];
      out[dst++] = rgba[s + 1];
      out[dst++] = rgba[s];
    }
  }
  return out;
}

export interface GifFrame {
  rgba: Uint8ClampedArray | Uint8Array;
  /** Display time in milliseconds. */
  delay: number;
}

export interface GifStats {
  /** Pixels that were partly transparent and became fully opaque or fully transparent. */
  partialAlpha: number;
}

/** Writes a GIF frame by frame, one palette per frame, with on/off transparency. */
export class GifWriter {
  private enc = GIFEncoder();
  private first = true;
  readonly stats: GifStats = { partialAlpha: 0 };
  /** `plays`: how many times the GIF plays, 0 for forever. */
  constructor(private width: number, private height: number, private plays: number) {}

  add(rgba: Uint8ClampedArray | Uint8Array, delay: number): void {
    const data = rgba instanceof Uint8ClampedArray ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba;
    let anyAlpha = false;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      if (a < 255) {
        anyAlpha = true;
        if (a > 0) this.stats.partialAlpha++;
      }
    }
    // gifenc: repeat 0 loops forever, -1 writes no loop extension (plays once), n repeats n more times.
    const repeat = this.first ? (this.plays === 0 ? 0 : this.plays === 1 ? -1 : this.plays - 1) : undefined;
    if (anyAlpha) {
      const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlpha: true, clearAlphaThreshold: 127 });
      const index = applyPalette(data, palette, 'rgba4444');
      const transparentIndex = palette.findIndex(c => c[3] === 0);
      this.enc.writeFrame(index, this.width, this.height, {
        palette,
        transparent: transparentIndex >= 0,
        transparentIndex: Math.max(0, transparentIndex),
        delay,
        repeat,
        dispose: 2,
      });
    } else {
      const palette = quantize(data, 256, { format: 'rgb565' });
      const index = applyPalette(data, palette, 'rgb565');
      this.enc.writeFrame(index, this.width, this.height, { palette, delay, repeat });
    }
    this.first = false;
  }

  finish(): Uint8Array {
    this.enc.finish();
    return this.enc.bytes();
  }
}

/** GIF from a list of RGBA frames. */
export function encodeGif(frames: Iterable<GifFrame>, width: number, height: number, plays = 0): { bytes: Uint8Array; stats: GifStats } {
  const w = new GifWriter(width, height, plays);
  for (const f of frames) w.add(f.rgba, f.delay);
  return { bytes: w.finish(), stats: w.stats };
}

type EmscriptenFactory = (opts: Record<string, unknown>) => Promise<{
  encode(data: Uint8Array, width: number, height: number, options: Record<string, unknown>): Uint8Array | null;
}>;

let avifModule: ReturnType<EmscriptenFactory> | null = null;
let webpModule: ReturnType<EmscriptenFactory> | null = null;

/** AVIF through libavif and libaom (jSquash's single-threaded build, so no cross-origin isolation is needed). */
export async function encodeAvif(rgba: Uint8ClampedArray, width: number, height: number, quality: number): Promise<Uint8Array> {
  if (!avifModule) {
    const factory = (await import('@jsquash/avif/codec/enc/avif_enc.js')).default as unknown as EmscriptenFactory;
    avifModule = factory({ noInitialRun: true });
  }
  const mod = await avifModule;
  const out = mod.encode(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height, {
    quality, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0, speed: 7, subsample: 1,
    chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8, lossless: false,
  });
  if (!out) throw new Error('The AVIF encoder failed.');
  return new Uint8Array(out);
}

/** WebP through libwebp, for browsers whose canvas cannot write WebP. */
export async function encodeWebpWasm(rgba: Uint8ClampedArray, width: number, height: number, quality: number): Promise<Uint8Array> {
  if (!webpModule) {
    const factory = (await import('@jsquash/webp/codec/enc/webp_enc.js')).default as unknown as EmscriptenFactory;
    webpModule = factory({ noInitialRun: true });
  }
  const mod = await webpModule;
  const { defaultOptions } = await import('@jsquash/webp/meta.js');
  const out = mod.encode(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height, { ...defaultOptions, quality });
  if (!out) throw new Error('The WebP encoder failed.');
  return new Uint8Array(out);
}
