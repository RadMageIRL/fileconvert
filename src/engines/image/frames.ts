// Frames of an animated picture, fully composited, one at a time: what a viewer shows at each step. GIF frames are
// composited here from their patches with the GIF disposal rules (gifuct-js decodes them); animated WebP and APNG
// frames come from the browser's ImageDecoder, which applies their own disposal and blending. Used by the image
// worker (animated GIF and WebP output) and the media worker (MP4 and WebM output).

import { LIMITS, LimitError } from '../../core/limits';

export interface AnimFrame {
  /** The whole picture at this step, at the source size. Valid until the next call to next(). */
  canvas: OffscreenCanvas;
  /** How long the frame shows, in milliseconds. */
  duration: number;
}

export interface FrameSource {
  width: number;
  height: number;
  frames: number;
  /** How many times the animation plays; 0 means forever. */
  plays: number;
  next(): Promise<AnimFrame | null>;
  close(): void;
}

export type AnimatedFormat = 'gif' | 'webp' | 'png';

/** Browsers show GIF delays of 10 ms or less as 100 ms; FileConvert keeps the shortest delay at 20 ms. */
export const gifDelay = (ms: number) => Math.max(20, ms || 100);

interface GifuctFrame {
  patch: Uint8ClampedArray;
  dims: { top: number; left: number; width: number; height: number };
  delay: number;
  disposalType: number;
}

/** The GIF's loop setting (NETSCAPE2.0 extension): 0 forever, otherwise plays = repeats + 1; no extension plays once. */
export function gifPlays(b: Uint8Array): number {
  for (let i = 0; i + 19 < b.length && i < 4096 + 3 * 256 + 64; i++) {
    if (b[i] === 0x21 && b[i + 1] === 0xff && b[i + 2] === 0x0b && String.fromCharCode(...b.subarray(i + 3, i + 14)) === 'NETSCAPE2.0' && b[i + 14] === 3 && b[i + 15] === 1) {
      const n = b[i + 16] | (b[i + 17] << 8);
      return n === 0 ? 0 : n + 1;
    }
  }
  return 1;
}

async function gifFrames(bytes: Uint8Array): Promise<FrameSource> {
  const { parseGIF, decompressFrame } = await import('gifuct-js');
  const parsed = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) as unknown as {
    lsd: { width: number; height: number }; gct: unknown; frames: unknown[];
  };
  const W = parsed.lsd.width, H = parsed.lsd.height;
  const raw = parsed.frames.filter(f => (f as { image?: unknown }).image);
  if (raw.length > LIMITS.gifInputFrames) throw new LimitError(`The GIF has ${raw.length} frames; the limit is ${LIMITS.gifInputFrames}.`);
  if (raw.length * W * H > LIMITS.gifInputPixels) throw new LimitError('The GIF has too many pixels across its frames to convert.');
  const screen = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
  const patch = new OffscreenCanvas(1, 1).getContext('2d')!;
  let previous: ImageData | null = null;
  let lastDisposal = 0;
  let lastDims: GifuctFrame['dims'] | null = null;
  let i = 0;
  return {
    width: W, height: H, frames: raw.length, plays: gifPlays(bytes),
    async next() {
      if (i >= raw.length) return null;
      const fr = decompressFrame(raw[i++] as never, parsed.gct as never, true) as unknown as GifuctFrame;
      // Disposal of the previous frame: 2 restores its area to the background (transparent), 3 to what was before it.
      if (lastDims && lastDisposal === 2) screen.clearRect(lastDims.left, lastDims.top, lastDims.width, lastDims.height);
      if (lastDisposal === 3 && previous) screen.putImageData(previous, 0, 0);
      previous = fr.disposalType === 3 ? screen.getImageData(0, 0, W, H) : null;
      patch.canvas.width = fr.dims.width;
      patch.canvas.height = fr.dims.height;
      patch.putImageData(new ImageData(fr.patch as Uint8ClampedArray<ArrayBuffer>, fr.dims.width, fr.dims.height), 0, 0);
      screen.drawImage(patch.canvas, fr.dims.left, fr.dims.top);
      lastDisposal = fr.disposalType;
      lastDims = fr.dims;
      return { canvas: screen.canvas, duration: gifDelay(fr.delay) };
    },
    close() { screen.canvas.width = 0; patch.canvas.width = 0; },
  };
}

interface Decoder {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; repetitionCount: number } | null };
  completed: Promise<void>;
  decode(o: { frameIndex: number; completeFramesOnly?: boolean }): Promise<{ image: VideoFrame }>;
  close(): void;
}

async function decoderFrames(bytes: Uint8Array, format: 'webp' | 'png'): Promise<FrameSource> {
  const Ctor = (globalThis as unknown as { ImageDecoder?: new (o: { data: Uint8Array; type: string }) => Decoder }).ImageDecoder;
  if (!Ctor) throw new Error(`This browser cannot read the frames of an animated ${format === 'png' ? 'PNG' : 'WebP'}. Current Chrome, Edge and Firefox can.`);
  const decoder = new Ctor({ data: bytes, type: format === 'png' ? 'image/png' : 'image/webp' });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
  } catch {
    decoder.close();
    throw new Error('The animation could not be read. The file may be damaged.');
  }
  const track = decoder.tracks.selectedTrack;
  if (!track) { decoder.close(); throw new Error('The animation could not be read.'); }
  const first = (await decoder.decode({ frameIndex: 0 })).image;
  const W = first.displayWidth, H = first.displayHeight;
  first.close();
  if (W * H > LIMITS.imagePixels) { decoder.close(); throw new LimitError('The animation is too large to convert.'); }
  if (track.frameCount > LIMITS.gifInputFrames) { decoder.close(); throw new LimitError(`The animation has ${track.frameCount} frames; the limit is ${LIMITS.gifInputFrames}.`); }
  if (track.frameCount * W * H > LIMITS.gifInputPixels) { decoder.close(); throw new LimitError('The animation has too many pixels across its frames to convert.'); }
  const screen = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
  let i = 0;
  const rep = track.repetitionCount;
  return {
    width: W, height: H, frames: track.frameCount, plays: !Number.isFinite(rep) ? 0 : Math.max(1, Math.round(rep) + 1),
    async next() {
      if (i >= track.frameCount) return null;
      const frame = (await decoder.decode({ frameIndex: i++, completeFramesOnly: true })).image;
      screen.clearRect(0, 0, W, H);
      screen.drawImage(frame, 0, 0, W, H);
      const duration = frame.duration ? frame.duration / 1000 : 100;
      frame.close();
      return { canvas: screen.canvas, duration: Math.max(1, Math.round(duration)) };
    },
    close() { decoder.close(); screen.canvas.width = 0; },
  };
}

export function openFrames(bytes: Uint8Array, format: AnimatedFormat): Promise<FrameSource> {
  return format === 'gif' ? gifFrames(bytes) : decoderFrames(bytes, format);
}

/** True when this browser can read the frames of an animation in this format. */
export const canReadFrames = (format: AnimatedFormat) => format === 'gif' || typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function';
