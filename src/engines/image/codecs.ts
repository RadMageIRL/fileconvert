// The WebAssembly codecs of the image optimization tools, each loaded on first use in the image worker: oxipng (lossless
// PNG recompression, @jsquash/oxipng), MozJPEG (JPEG decoding and encoding, @jsquash/jpeg), libwebp and libavif
// (@jsquash/webp and @jsquash/avif, which the converter already uses), all jSquash's single-threaded builds, so no
// cross-origin isolation is needed. A codec that fails is let go and loaded again, since a failed run can leave it in a
// bad state; an Emscripten codec is let go after a large picture too, so its memory goes back to the system (oxipng's
// cannot be: its worker is retired instead, see retireAfter).

type Emscripten<T> = (opts: Record<string, unknown>) => Promise<T & { HEAP8?: Int8Array }>;

let lastMessage = '';
const quiet = { noInitialRun: true, print: () => undefined, printErr: (m: string) => { lastMessage = m; } };

/** The codecs' WebAssembly as bytes, for the unit tests in Node, where fetch cannot read a package's own files. In the
 *  browser these stay empty and each codec fetches its file from the app's folder. */
export const wasmFiles: { oxipng?: Uint8Array; mozjpegDec?: Uint8Array; mozjpegEnc?: Uint8Array; webpDec?: Uint8Array; webpEnc?: Uint8Array; avifDec?: Uint8Array; avifEnc?: Uint8Array } = {};
// A fresh object for each codec: Emscripten makes it the module itself and adds its functions to it.
const opts = (bin?: Uint8Array) => ({ ...quiet, ...(bin ? { wasmBinary: bin } : {}) });

// ------------------------------------------------------------------ oxipng

interface Oxipng { optimise(data: Uint8Array, level: number, interlace: boolean, optimizeAlpha: boolean): Uint8Array }
let oxi: Promise<{ codec: Oxipng; memory: WebAssembly.Memory }> | null = null;

/**
 * oxipng on a whole PNG file, at a preset level (0 to 6): it chooses filters and recompresses, and reduces the color type,
 * bit depth and palette where every pixel stays the same. Interlacing is removed, and the RGB values under fully
 * transparent pixels are kept (optimize alpha off). Chunks are kept as they are. Animated PNGs keep every frame.
 */
export async function oxipng(data: Uint8Array, level: number): Promise<Uint8Array> {
  oxi ??= (async () => {
    const m = await import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js');
    const out = await m.default(wasmFiles.oxipng);
    return { codec: m as unknown as Oxipng, memory: out.memory };
  })();
  const { codec } = await oxi;
  return codec.optimise(data, level, false, false);
}

/** The memory oxipng's WebAssembly holds (it never gives memory back while the worker lives). */
export async function oxipngMemory(): Promise<number> {
  return oxi ? (await oxi).memory.buffer.byteLength : 0;
}

/** Past this much codec memory the worker is retired after its task, so a later task starts small. */
export const RETIRE_BYTES = 256 * 1024 * 1024;

// ------------------------------------------------------------------ MozJPEG

interface MozDecoder { decode(data: Uint8Array, preserveOrientation: boolean): { data: Uint8ClampedArray; width: number; height: number } | null }
interface MozEncoder { encode(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: Record<string, unknown>): Uint8Array }

let mozDec: Promise<MozDecoder & { HEAP8?: Int8Array }> | null = null;
let mozEnc: Promise<MozEncoder & { HEAP8?: Int8Array }> | null = null;


/** A JPEG decoded by MozJPEG (libjpeg-turbo's decoder) to 8-bit RGBA, colors as stored (no color profile applied), the
 *  EXIF orientation not applied. Gray JPEGs come out with equal R, G and B. CMYK, 12-bit and arithmetic-coded JPEGs are
 *  refused by the decoder: the error says so. */
export async function mozjpegDecode(bytes: Uint8Array): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  mozDec ??= import('@jsquash/jpeg/codec/dec/mozjpeg_dec.js').then(m => (m.default as unknown as Emscripten<MozDecoder>)(opts(wasmFiles.mozjpegDec)));
  const dec = await mozDec;
  lastMessage = '';
  try {
    const r = dec.decode(bytes, false);
    if (!r) throw new Error('The JPEG could not be decoded.');
    return r;
  } catch (e) {
    mozDec = null;
    throw new Error(`The JPEG could not be decoded${lastMessage ? ` (${lastMessage})` : ''}.`, { cause: e });
  }
}

export interface MozjpegOptions {
  quality: number;
  progressive: boolean;
  /** 1 for full color detail (4:4:4), 2 for half each way (4:2:0). */
  subsample: 1 | 2;
  gray: boolean;
}

/** RGBA pixels as a JPEG by MozJPEG: trellis quantization and optimized Huffman tables, with its JFIF header and nothing
 *  else (no metadata, no color profile). */
export async function mozjpegEncode(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, o: MozjpegOptions): Promise<Uint8Array> {
  mozEnc ??= import('@jsquash/jpeg/codec/enc/mozjpeg_enc.js').then(m => (m.default as unknown as Emscripten<MozEncoder>)(opts(wasmFiles.mozjpegEnc)));
  const enc = await mozEnc;
  const { defaultOptions } = await import('@jsquash/jpeg/meta.js');
  lastMessage = '';
  try {
    const out = enc.encode(rgba, width, height, {
      ...defaultOptions,
      quality: Math.max(1, Math.min(100, Math.round(o.quality))),
      progressive: o.progressive,
      baseline: false,
      optimize_coding: true,
      auto_subsample: false,
      chroma_subsample: o.subsample,
      color_space: o.gray ? 1 : 3,
    });
    return new Uint8Array(out);
  } catch (e) {
    mozEnc = null;
    throw new Error(`The JPEG encoder failed${lastMessage ? ` (${lastMessage})` : ''}.`, { cause: e });
  }
}

// ------------------------------------------------------------------ WebP and AVIF

interface WebpDecoder { decode(data: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } | null }
interface WebpEncoder { encode(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: Record<string, unknown>): Uint8Array | null }
interface AvifDecoder { decode(data: Uint8Array, bitDepth: number): { data: Uint8ClampedArray | Uint16Array; width: number; height: number } | null }
interface AvifEncoder { encode(data: Uint8Array, width: number, height: number, options: Record<string, unknown>): Uint8Array | null }

let webpDec: Promise<WebpDecoder & { HEAP8?: Int8Array }> | null = null;
let webpEnc: Promise<WebpEncoder & { HEAP8?: Int8Array }> | null = null;
let avifDec: Promise<AvifDecoder & { HEAP8?: Int8Array }> | null = null;
let avifEnc: Promise<AvifEncoder & { HEAP8?: Int8Array }> | null = null;

/** A still WebP decoded by libwebp to 8-bit RGBA, colors as stored. */
export async function webpDecode(bytes: Uint8Array): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  webpDec ??= import('@jsquash/webp/codec/dec/webp_dec.js').then(m => (m.default as unknown as Emscripten<WebpDecoder>)(opts(wasmFiles.webpDec)));
  const dec = await webpDec;
  try {
    const r = dec.decode(bytes);
    if (!r) throw new Error('empty');
    return r;
  } catch (e) {
    webpDec = null;
    throw new Error('The WebP picture could not be decoded. It may be damaged.', { cause: e });
  }
}

export interface WebpOptions {
  quality: number;
  /** Lossless keeps every pixel, the colors under fully transparent pixels included (libwebp's exact mode). */
  lossless: boolean;
}

/** RGBA pixels as a WebP by libwebp (a VP8 or VP8L picture in a RIFF file, with ALPH where there is transparency). */
export async function webpEncode(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, o: WebpOptions): Promise<Uint8Array> {
  webpEnc ??= import('@jsquash/webp/codec/enc/webp_enc.js').then(m => (m.default as unknown as Emscripten<WebpEncoder>)(opts(wasmFiles.webpEnc)));
  const enc = await webpEnc;
  const { defaultOptions } = await import('@jsquash/webp/meta.js');
  const options = o.lossless
    ? { ...defaultOptions, lossless: 1, exact: 1, quality: 100, method: 6 }
    : { ...defaultOptions, quality: Math.max(0, Math.min(100, Math.round(o.quality))), method: 4, alpha_quality: 100 };
  let out: Uint8Array | null;
  try {
    out = enc.encode(rgba, width, height, options);
  } catch (e) {
    webpEnc = null;
    throw new Error('The WebP encoder failed.', { cause: e });
  }
  if (!out) { webpEnc = null; throw new Error('The WebP encoder failed.'); }
  return new Uint8Array(out);
}

/** An AVIF decoded by libavif: 8-bit RGBA, or 16-bit samples holding 10 or 12 bits when `bits` is above 8; colors as
 *  stored, and rotation, mirroring and crop (irot, imir, clap) not applied. */
export async function avifDecode(bytes: Uint8Array, bits: number): Promise<{ data: Uint8ClampedArray | Uint16Array; width: number; height: number }> {
  avifDec ??= import('@jsquash/avif/codec/dec/avif_dec.js').then(m => (m.default as unknown as Emscripten<AvifDecoder>)(opts(wasmFiles.avifDec)));
  const dec = await avifDec;
  try {
    const r = dec.decode(bytes, bits > 8 ? 16 : 8);
    if (!r) throw new Error('empty');
    return r;
  } catch (e) {
    avifDec = null;
    throw new Error('The AVIF picture could not be decoded. It may be damaged, or use a feature this decoder does not read.', { cause: e });
  }
}

export interface AvifOptions {
  quality: number;
  lossless: boolean;
  /** 8, 10 or 12 bits per channel; above 8, `data` holds 16-bit samples. */
  bitDepth: 8 | 10 | 12;
  /** 1: 4:2:0, 3: 4:4:4 (lossless is always 4:4:4). */
  subsample: 1 | 3;
  speed: number;
}

/** RGBA samples as an AVIF by libavif and libaom. */
export async function avifEncode(data: Uint8Array | Uint8ClampedArray | Uint16Array, width: number, height: number, o: AvifOptions): Promise<Uint8Array> {
  avifEnc ??= import('@jsquash/avif/codec/enc/avif_enc.js').then(m => (m.default as unknown as Emscripten<AvifEncoder>)(opts(wasmFiles.avifEnc)));
  const enc = await avifEnc;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const options = {
    quality: o.lossless ? 100 : Math.max(0, Math.min(100, Math.round(o.quality))), qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
    speed: o.speed, subsample: o.lossless ? 3 : o.subsample, chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false,
    bitDepth: o.bitDepth, lossless: o.lossless,
  };
  let out: Uint8Array | null;
  try {
    out = enc.encode(bytes, width, height, options);
  } catch (e) {
    avifEnc = null;
    throw new Error('The AVIF encoder failed.', { cause: e });
  }
  if (!out) { avifEnc = null; throw new Error('The AVIF encoder failed.'); }
  return new Uint8Array(out);
}

// ------------------------------------------------------------------ memory

const heap = async (p: Promise<{ HEAP8?: Int8Array }> | null) => (p ? (await p.catch(() => null))?.HEAP8?.buffer.byteLength ?? 0 : 0);

/** Lets the Emscripten codecs that hold more than `limit` bytes go (the next use loads them again), so a large picture's
 *  memory does not stay with the worker. */
export async function releaseCodecs(limit = 64 * 1024 * 1024): Promise<void> {
  if (await heap(mozDec) > limit) mozDec = null;
  if (await heap(mozEnc) > limit) mozEnc = null;
  if (await heap(webpDec) > limit) webpDec = null;
  if (await heap(webpEnc) > limit) webpEnc = null;
  if (await heap(avifDec) > limit) avifDec = null;
  if (await heap(avifEnc) > limit) avifEnc = null;
}

/** Whether the worker should be retired after this task: oxipng's WebAssembly memory cannot shrink. */
export async function retireAfter(): Promise<boolean> {
  return (await oxipngMemory()) > RETIRE_BYTES;
}
