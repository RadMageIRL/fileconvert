// Image conversion, run inside a worker. Decoding uses the browser's own decoders where it has them
// (they apply EXIF orientation and convert color profiles to sRGB) and WebAssembly or JavaScript decoders
// for HEIC, TIFF and, where needed, AVIF. Pixels are scaled on an OffscreenCanvas and encoded by the
// canvas or by the encoders in ./encoders.

import { FORMATS, type FormatId } from '../../core/formats';
import { LIMITS, LimitError } from '../../core/limits';
import { encodeAvif, encodeBmp, encodeGif, encodeWebpWasm, type GifFrame } from './encoders';
import { readHeader } from './header';
import { bestEntry, decodeIcoBitmap, icoSizes, readIcoDirectory, writeIco } from './ico';
import { TiffWriter, type TiffCompression } from './tiff';

export type ResizeMode =
  | { mode: 'none' }
  | { mode: 'percent'; percent: number }
  | { mode: 'fit'; width: number; height: number };

export interface ImageOptions {
  /** 1 to 100, for JPG, WebP and AVIF. */
  quality: number;
  resize: ResizeMode;
  /** CSS hex color that replaces transparency in formats without it. */
  background: string;
  /** ICO output: 'favicon' (16, 32 and 48), 'all' (16 to 256) or one size such as '32'. */
  ico?: string;
  tiffCompression?: TiffCompression;
  /** A multi-page TIFF: convert every page (one file each, or one TIFF), or only the first. */
  tiffPages?: 'all' | 'first';
}

export interface ImageResult {
  /** One file, or one per page of a multi-page TIFF (suffix "page 2"). */
  outputs: Array<{ bytes: Uint8Array; suffix?: string }>;
  mime: string;
  ext: string;
  width: number;
  height: number;
  warnings: string[];
  summary: string;
}

type Progress = (stage: string) => void;

interface Picture {
  width: number;
  height: number;
  /** Draws the whole picture scaled into the given box. */
  source: CanvasImageSource;
  close(): void;
}

function context(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new LimitError(`This browser cannot make a ${width} x ${height} canvas. Try a smaller size.`);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

function imageDataPicture(data: Uint8ClampedArray, width: number, height: number): Picture {
  const ctx = context(width, height);
  ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return { width, height, source: ctx.canvas, close: () => { ctx.canvas.width = 0; } };
}

function checkPixels(width: number, height: number, what = 'The image'): void {
  if (!width || !height) return;
  if (width > LIMITS.imageSide || height > LIMITS.imageSide || width * height > LIMITS.imagePixels) {
    throw new LimitError(`${what} is ${width.toLocaleString('en-US')} x ${height.toLocaleString('en-US')} pixels; the limit is ${(LIMITS.imagePixels / 1e6).toFixed(0)} megapixels and ${LIMITS.imageSide.toLocaleString('en-US')} pixels on a side.`);
  }
}

// ------------------------------------------------------------------ decoders

let heif: Promise<{ HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[] } }> | null = null;
interface HeifImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, cb: (r: unknown) => void): void;
  free?(): void;
}

async function decodeHeic(bytes: Uint8Array, warnings: string[]): Promise<Picture> {
  if (!heif) heif = import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(m => (m.default as unknown as () => Promise<never>)());
  const lib = await heif;
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images || images.length === 0) throw new Error('No picture was found in this HEIC file. It may be damaged.');
  const image = images.find(i => i.is_primary()) ?? images[0];
  if (images.length > 1) warnings.push(`The file holds ${images.length} pictures; the main one was converted.`);
  const width = image.get_width(), height = image.get_height();
  checkPixels(width, height);
  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => image.display({ data, width, height }, r => r ? resolve() : reject(new Error('The HEIC picture could not be decoded. It may be damaged.'))));
  for (const i of images) i.free?.();
  warnings.push('HEIC color profiles are not applied; photos in a wide color space (such as Display P3) can look slightly less vivid.');
  return imageDataPicture(data, width, height);
}

interface TiffIfd { width: number; height: number; data?: Uint8Array; t254?: number[]; t256?: number[]; t257?: number[]; t274?: number[]; t34675?: unknown }

/** The pages of a TIFF (thumbnails and other reduced images left out), decoded one at a time. */
async function openTiff(bytes: Uint8Array, warnings: string[]): Promise<{ count: number; decode(i: number): Promise<{ pic: Picture; orientation: number }> }> {
  const UTIF = (await import('utif')).default as unknown as {
    decode(b: ArrayBuffer | Uint8Array): TiffIfd[];
    decodeImage(b: ArrayBuffer | Uint8Array, ifd: TiffIfd, ifds: TiffIfd[]): void;
    toRGBA8(ifd: TiffIfd): Uint8Array;
  };
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let ifds: TiffIfd[];
  try { ifds = UTIF.decode(buf); } catch { throw new Error('The TIFF file could not be read. It may be damaged.'); }
  let pages = ifds.filter(d => !(d.t254 && (d.t254[0] & 1)));
  if (!pages.length && ifds.length) pages = [ifds[0]];
  if (!pages.length) throw new Error('No picture was found in this TIFF file.');
  if (pages.length > LIMITS.tiffPages) throw new LimitError(`The TIFF has ${pages.length} pages; the limit is ${LIMITS.tiffPages}.`);
  if (pages.some(p => p.t34675)) warnings.push('The TIFF has an embedded color profile, which is not applied.');
  return {
    count: pages.length,
    async decode(i: number) {
      const page = pages[i];
      checkPixels(page.t256?.[0] ?? 0, page.t257?.[0] ?? 0);
      try { UTIF.decodeImage(buf, page, ifds); } catch { throw new Error(`Page ${i + 1} of this TIFF uses a compression or layout that could not be decoded.`); }
      const rgba = UTIF.toRGBA8(page);
      if (!page.width || !page.height || rgba.length < page.width * page.height * 4) throw new Error(`Page ${i + 1} of this TIFF could not be decoded.`);
      const pic = imageDataPicture(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, page.width * page.height * 4), page.width, page.height);
      page.data = undefined;
      return { pic, orientation: page.t274?.[0] ?? 1 };
    },
  };
}

/** The largest picture in an ICO or CUR file. */
async function decodeIco(bytes: Uint8Array, warnings: string[]): Promise<Picture> {
  const entries = readIcoDirectory(bytes);
  const e = bestEntry(entries);
  const sizes = [...new Set(entries.map(x => x.width))].sort((a, b) => a - b);
  if (sizes.length > 1) warnings.push(`The icon holds ${sizes.length} sizes (${sizes.join(', ')} pixels); the largest, ${e.width} x ${e.height}, was converted.`);
  checkPixels(e.width, e.height);
  if (e.png) return decodeNative(bytes.subarray(e.offset, e.offset + e.size), 'image/png');
  const d = decodeIcoBitmap(bytes, e);
  return imageDataPicture(d.rgba, d.width, d.height);
}

async function decodeAvifWasm(bytes: Uint8Array): Promise<Picture> {
  const factory = (await import('@jsquash/avif/codec/dec/avif_dec.js')).default as unknown as (o: Record<string, unknown>) => Promise<{ decode(b: Uint8Array, bitDepth: number): ImageData | null }>;
  const mod = await factory({ noInitialRun: true });
  const img = mod.decode(bytes, 8);
  if (!img) throw new Error('The AVIF picture could not be decoded. It may be damaged.');
  checkPixels(img.width, img.height);
  return imageDataPicture(img.data, img.width, img.height);
}

async function decodeNative(bytes: Uint8Array, mime: string): Promise<Picture> {
  const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });
  return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
}

async function decode(bytes: Uint8Array, format: FormatId, warnings: string[]): Promise<{ pic: Picture; orientation: number }> {
  if (format === 'heic') return { pic: await decodeHeic(bytes, warnings), orientation: 1 };
  if (format === 'ico') return { pic: await decodeIco(bytes, warnings), orientation: 1 };
  try {
    return { pic: await decodeNative(bytes, FORMATS[format].mime), orientation: 1 };
  } catch (e) {
    if (format === 'avif') return { pic: await decodeAvifWasm(bytes), orientation: 1 };
    throw new Error(`The ${FORMATS[format].label} image could not be decoded. It may be damaged or incomplete.`, { cause: e });
  }
}

// ------------------------------------------------------------------ geometry

export function outputSize(w: number, h: number, r: ResizeMode): { width: number; height: number } {
  if (r.mode === 'percent') {
    const p = Math.max(1, Math.min(1000, r.percent)) / 100;
    return { width: Math.max(1, Math.round(w * p)), height: Math.max(1, Math.round(h * p)) };
  }
  if (r.mode === 'fit') {
    const s = Math.min((r.width || Infinity) / w, (r.height || Infinity) / h, 1);
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
  }
  return { width: w, height: h };
}

/** Draws a picture at a new size, halving in steps for large reductions so detail is averaged, not skipped. */
function scaled(pic: Picture, width: number, height: number, orientation: number): OffscreenCanvasRenderingContext2D {
  const swap = orientation >= 5 && orientation <= 8;
  let src: CanvasImageSource = pic.source;
  let sw = pic.width, sh = pic.height;
  const targetW = swap ? height : width, targetH = swap ? width : height;
  while (sw / 2 >= targetW && sh / 2 >= targetH && sw > 2 && sh > 2) {
    const step = context(Math.round(sw / 2), Math.round(sh / 2));
    step.drawImage(src, 0, 0, step.canvas.width, step.canvas.height);
    if (src !== pic.source && src instanceof OffscreenCanvas) src.width = 0;
    src = step.canvas;
    sw = step.canvas.width;
    sh = step.canvas.height;
  }
  const ctx = context(width, height);
  // TIFF orientation tag: the browser decoders apply EXIF orientation themselves.
  switch (orientation) {
    case 2: ctx.setTransform(-1, 0, 0, 1, width, 0); break;
    case 3: ctx.setTransform(-1, 0, 0, -1, width, height); break;
    case 4: ctx.setTransform(1, 0, 0, -1, 0, height); break;
    case 5: ctx.setTransform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.setTransform(0, 1, -1, 0, width, 0); break;
    case 7: ctx.setTransform(0, -1, -1, 0, width, height); break;
    case 8: ctx.setTransform(0, -1, 1, 0, 0, height); break;
  }
  ctx.drawImage(src, 0, 0, targetW, targetH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (src !== pic.source && src instanceof OffscreenCanvas) src.width = 0;
  return ctx;
}

function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function flatten(ctx: OffscreenCanvasRenderingContext2D, color: string): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

const COLOR_NAMES: Record<string, string> = { '#ffffff': 'white', '#000000': 'black' };

// ------------------------------------------------------------------ animated GIF

interface GifuctFrame {
  patch: Uint8ClampedArray;
  dims: { top: number; left: number; width: number; height: number };
  delay: number;
  disposalType: number;
}

/** Re-encodes every frame of an animated GIF at a new size, compositing frames the way viewers do. */
async function gifToGif(bytes: Uint8Array, o: ImageOptions, progress: Progress, warnings: string[]): Promise<ImageResult> {
  const { parseGIF, decompressFrame } = await import('gifuct-js');
  const parsed = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) as unknown as {
    lsd: { width: number; height: number }; gct: unknown; frames: unknown[];
  };
  const W = parsed.lsd.width, H = parsed.lsd.height;
  checkPixels(W, H);
  const raw = parsed.frames.filter(f => (f as { image?: unknown }).image);
  if (raw.length > LIMITS.gifInputFrames) throw new LimitError(`The GIF has ${raw.length} frames; the limit is ${LIMITS.gifInputFrames}.`);
  if (raw.length * W * H > LIMITS.gifInputPixels) throw new LimitError('The GIF has too many pixels across its frames to convert.');
  const size = outputSize(W, H, o.resize);
  const screen = context(W, H);
  const patchCtx = context(1, 1);
  const out = context(size.width, size.height);
  let previous: ImageData | null = null;
  let lastDisposal = 0;
  let lastDims: GifuctFrame['dims'] | null = null;
  const frames: GifFrame[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i % 10 === 0) progress(`Frame ${i + 1} of ${raw.length}`);
    const fr = decompressFrame(raw[i] as never, parsed.gct as never, true) as unknown as GifuctFrame;
    if (lastDims && lastDisposal === 2) screen.clearRect(lastDims.left, lastDims.top, lastDims.width, lastDims.height);
    if (lastDisposal === 3 && previous) screen.putImageData(previous, 0, 0);
    previous = fr.disposalType === 3 ? screen.getImageData(0, 0, W, H) : null;
    patchCtx.canvas.width = fr.dims.width;
    patchCtx.canvas.height = fr.dims.height;
    patchCtx.putImageData(new ImageData(fr.patch as Uint8ClampedArray<ArrayBuffer>, fr.dims.width, fr.dims.height), 0, 0);
    screen.drawImage(patchCtx.canvas, fr.dims.left, fr.dims.top);
    out.clearRect(0, 0, size.width, size.height);
    out.drawImage(screen.canvas, 0, 0, size.width, size.height);
    frames.push({ rgba: out.getImageData(0, 0, size.width, size.height).data, delay: Math.max(20, fr.delay || 100) });
    lastDisposal = fr.disposalType;
    lastDims = fr.dims;
  }
  progress('Encoding GIF');
  const { bytes: gif, stats } = encodeGif(frames, size.width, size.height);
  if (stats.partialAlpha) warnings.push('GIF transparency is on or off, so partly transparent pixels became fully opaque or fully transparent.');
  return { outputs: [{ bytes: gif }], mime: 'image/gif', ext: 'gif', width: size.width, height: size.height, warnings, summary: `${size.width} x ${size.height}, ${raw.length} frames` };
}

// ------------------------------------------------------------------ main

/** PNG must end with an IEND chunk and GIF with its trailer byte; a missing end means the file was cut off. */
export function isTruncated(bytes: Uint8Array, format: FormatId): boolean {
  if (format === 'png') {
    const tail = bytes.subarray(Math.max(0, bytes.length - 64));
    for (let i = tail.length - 8; i >= 0; i--) if (tail[i] === 0x49 && tail[i + 1] === 0x45 && tail[i + 2] === 0x4e && tail[i + 3] === 0x44) return false;
    return true;
  }
  if (format === 'gif') {
    let end = bytes.length - 1;
    while (end > 0 && bytes[end] === 0) end--;
    return bytes[end] !== 0x3b;
  }
  return false;
}

/** Squares of the chosen ICO sizes, the picture fitted and centered on transparency, stored as PNGs. */
async function encodeIco(pic: Picture, orientation: number, setting: string | undefined, warnings: string[]): Promise<{ bytes: Uint8Array; sizes: number[] }> {
  const swap = orientation >= 5 && orientation <= 8;
  const w0 = swap ? pic.height : pic.width, h0 = swap ? pic.width : pic.height;
  const sizes = icoSizes(setting ?? 'favicon');
  const pngs: Array<{ size: number; png: Uint8Array }> = [];
  for (const s of sizes) {
    const k = Math.min(s / w0, s / h0);
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const fitted = scaled(pic, w, h, orientation);
    const square = context(s, s);
    square.drawImage(fitted.canvas, Math.floor((s - w) / 2), Math.floor((s - h) / 2));
    fitted.canvas.width = 0;
    const blob = await square.canvas.convertToBlob({ type: 'image/png' });
    square.canvas.width = 0;
    pngs.push({ size: s, png: new Uint8Array(await blob.arrayBuffer()) });
  }
  const enlarged = sizes.filter(s => s > Math.max(w0, h0));
  if (enlarged.length) warnings.push(`The picture is ${w0} x ${h0}, so the ${enlarged.join(', ')} pixel ${enlarged.length === 1 ? 'size was' : 'sizes were'} enlarged and can look soft.`);
  if (w0 !== h0) warnings.push('The picture is not square, so it was centered on a transparent square.');
  return { bytes: writeIco(pngs), sizes };
}

let canvasWebp: boolean | null = null;

/** Converts one decoded picture (or one TIFF page). Returns the encoded bytes, or null when added to a TIFF. */
async function renderPicture(pic: Picture, orientation: number, from: FormatId, to: FormatId, o: ImageOptions, warnings: string[], progress: Progress, tiff: TiffWriter | null): Promise<{ bytes: Uint8Array | null; width: number; height: number; detail?: string }> {
  const note = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  checkPixels(pic.width, pic.height);
  if (to === 'ico') {
    progress('Making icon sizes');
    if (o.resize.mode !== 'none') note('ICO sizes come from the ICO setting in Images settings; the Size setting does not apply.');
    const r = await encodeIco(pic, orientation, o.ico, warnings);
    return { bytes: r.bytes, width: r.sizes[r.sizes.length - 1], height: r.sizes[r.sizes.length - 1], detail: `${r.sizes.join(', ')} px` };
  }
  const swap = orientation >= 5 && orientation <= 8;
  const baseW = swap ? pic.height : pic.width, baseH = swap ? pic.width : pic.height;
  const size = outputSize(baseW, baseH, o.resize);
  checkPixels(size.width, size.height, 'The result');
  if (to === 'webp' && (size.width > 16383 || size.height > 16383)) throw new LimitError('WebP images can be at most 16,383 pixels on a side. Choose a smaller size.');
  if ((to === 'jpg' || to === 'gif') && (size.width > 65535 || size.height > 65535)) throw new LimitError(`${FORMATS[to].label} images can be at most 65,535 pixels on a side.`);
  progress(size.width !== baseW || size.height !== baseH ? 'Resizing' : 'Preparing pixels');
  const ctx = scaled(pic, size.width, size.height, orientation);
  const opaqueSource = from === 'jpg' || from === 'bmp';
  const transparent = !opaqueSource && hasTransparency(ctx.getImageData(0, 0, size.width, size.height).data);
  const noAlpha = to === 'jpg' || to === 'bmp';
  if (noAlpha && transparent) {
    flatten(ctx, o.background);
    note(`The image has transparent areas. ${FORMATS[to].label} cannot keep them, so they became ${COLOR_NAMES[o.background.toLowerCase()] ?? o.background}.`);
  }
  progress(`Encoding ${FORMATS[to].label}`);
  let out: Uint8Array | null;
  const q = Math.max(1, Math.min(100, Math.round(o.quality)));
  switch (to) {
    case 'png':
    case 'jpg': {
      const blob = await ctx.canvas.convertToBlob({ type: FORMATS[to].mime, quality: q / 100 });
      if (blob.type !== FORMATS[to].mime) throw new Error(`This browser cannot write ${FORMATS[to].label}.`);
      out = new Uint8Array(await blob.arrayBuffer());
      break;
    }
    case 'webp': {
      if (canvasWebp !== false) {
        const blob = await ctx.canvas.convertToBlob({ type: 'image/webp', quality: q / 100 });
        canvasWebp = blob.type === 'image/webp';
        if (canvasWebp) { out = new Uint8Array(await blob.arrayBuffer()); break; }
      }
      out = await encodeWebpWasm(ctx.getImageData(0, 0, size.width, size.height).data, size.width, size.height, q);
      break;
    }
    case 'avif':
      out = await encodeAvif(ctx.getImageData(0, 0, size.width, size.height).data, size.width, size.height, q);
      break;
    case 'bmp':
      out = encodeBmp(ctx.getImageData(0, 0, size.width, size.height).data, size.width, size.height);
      break;
    case 'tiff':
      tiff!.addPage({ rgba: ctx.getImageData(0, 0, size.width, size.height).data, width: size.width, height: size.height });
      out = null;
      break;
    case 'gif': {
      const { bytes: gif, stats } = encodeGif([{ rgba: ctx.getImageData(0, 0, size.width, size.height).data, delay: 0 }], size.width, size.height, false);
      out = gif;
      if (stats.partialAlpha) note('GIF transparency is on or off, so partly transparent pixels became fully opaque or fully transparent.');
      if (from !== 'gif') note('GIF holds at most 256 colors, so colors were reduced. Photos and gradients can show banding.');
      break;
    }
    default:
      throw new Error(`Images cannot be converted to ${FORMATS[to].label}.`);
  }
  ctx.canvas.width = 0;
  return { bytes: out, width: size.width, height: size.height };
}

export async function convertImage(bytes: Uint8Array, from: FormatId, to: FormatId, o: ImageOptions, progress: Progress): Promise<ImageResult> {
  const warnings: string[] = [];
  if (bytes.length > LIMITS.imageBytes) throw new LimitError(`The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.`);
  const header = readHeader(bytes, from);
  if (header.width && header.height) checkPixels(header.width, header.height);
  if (from === 'gif' && to === 'gif' && header.animated) return gifToGif(bytes, o, progress, warnings);
  if (header.animated) {
    const keep = from === 'gif' ? 'GIF, MP4 or WebM' : 'its original format';
    warnings.push(`This image is animated${header.frames ? ` (${header.frames} frames)` : ''}. Only the first frame was converted; keep ${keep} to keep the animation.`);
  }
  if (isTruncated(bytes, from)) {
    // Some browsers refuse a cut-off file, others decode what is there. Either way the user should know.
    warnings.push(`The ${FORMATS[from].label} file ends early, as if the download or copy was cut off. Part of the picture may be missing.`);
  }
  // A multi-page TIFF gives every page (one file each, or one TIFF with them all), or only its first page.
  const tiffIn = from === 'tiff' ? await openTiff(bytes, warnings) : null;
  let count = tiffIn ? tiffIn.count : 1;
  if (tiffIn && count > 1) {
    if (o.tiffPages === 'first') { warnings.push(`The TIFF has ${count} pages; the first was converted, as set in Images settings.`); count = 1; }
    else if (to === 'tiff') warnings.push(`All ${count} pages are in the new TIFF, in order.`);
    else if (to === 'ico') { warnings.push(`The TIFF has ${count} pages; the icon is made from the first.`); count = 1; }
    else warnings.push(`The TIFF has ${count} pages; each became its own ${FORMATS[to].label} file.`);
  }
  const tiff = to === 'tiff' ? new TiffWriter(o.tiffCompression === 'lzw' ? 'lzw' : 'none') : null;
  const outputs: ImageResult['outputs'] = [];
  let last: { width: number; height: number; detail?: string } = { width: 0, height: 0 };
  for (let i = 0; i < count; i++) {
    progress(count > 1 ? `Page ${i + 1} of ${count}` : `Decoding ${FORMATS[from].label}`);
    const { pic, orientation } = tiffIn ? await tiffIn.decode(i) : await decode(bytes, from, warnings);
    try {
      const r = await renderPicture(pic, orientation, from, to, o, warnings, progress, tiff);
      if (r.bytes) outputs.push({ bytes: r.bytes, suffix: count > 1 ? `page ${i + 1}` : undefined });
      last = r;
    } finally {
      pic.close();
    }
  }
  if (tiff) outputs.push({ bytes: tiff.finish() });
  const pages = to === 'tiff' && count > 1 ? `, ${count} pages` : count > 1 ? `, ${count} files` : '';
  const summary = last.detail ? `ICO, ${last.detail}` : `${last.width} x ${last.height}${pages}${to === 'tiff' && o.tiffCompression === 'lzw' ? ', LZW' : ''}`;
  return { outputs, mime: FORMATS[to].mime, ext: FORMATS[to].ext, width: last.width, height: last.height, warnings, summary };
}
