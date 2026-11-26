// The memory admission check for the image optimization tools (Compress PNG, JPEG, WebP and AVIF, Resize images), on the
// same allowance as the PDF tools (./pdfmemory: half the memory the browser reports, or an assumption where it reports
// none, 4 GB at most). Each file is processed alone, one after another, so a picture of a batch needs what it needs
// alone, plus the results made so far, which the page holds until they are downloaded, plus what the pictures before it
// left that the browser has not freed yet.
//
// The estimate comes from what the file's header says before anything is decoded: its size, pixels, bit depth and, for
// a JPEG, how many DCT coefficients it holds. The figures (src/core/limits.ts, imageOptMemory) are per byte of the file,
// per pixel or per byte of decoded samples for each kind of work, fitted to peaks measured in Chrome, Firefox and WebKit;
// the figures for other browsers (Safari among them) are 1.5 times the higher of Chrome and Firefox, and at least WebKit's.

import { LIMITS } from './limits';
import type { MemoryEngine, MemoryEstimate } from './pdfmemory';

export type OptimizeOp = 'png' | 'jpeg-lossless' | 'jpeg' | 'webp' | 'webp-lossless' | 'avif' | 'avif-lossless' | 'resize';

/** The format Resize images writes a picture in. */
export type ResizeTo = 'jpg' | 'png' | 'webp' | 'avif' | 'gif' | 'bmp';

/** What a picture's header says it costs, before it is decoded. */
export interface PictureWork {
  bytes: number;
  width: number;
  height: number;
  /** Bytes of its decoded samples as the file stores them (PNG), or pixels times 4 (8-bit) or 8 (16-bit). */
  raw: number;
  /** Bits per channel. */
  bits: number;
  /** DCT coefficients per pixel (JPEG: 1 gray, 1.5 at 4:2:0, 3 at 4:4:4, 4 CMYK). */
  coefficients?: number;
}

export interface OptimizeMore {
  /** Pixels of the result (Resize images). */
  outPixels?: number;
  /** The format of the result (Resize images): its encoder's figure counts per result pixel. Unknown: the largest. */
  to?: ResizeTo;
  /** The similarity measure is on: the result is decoded again. */
  measure?: boolean;
  /** Bytes of the results made so far, held by the page. */
  held?: number;
  /**
   * The pictures before this one in a batch. Each leaves memory the browser frees late, even though its worker is let
   * go: measured in Chrome, Firefox and WebKit, a batch's peak rose with every picture before, by an amount per picture
   * and per pixel of it, while the result bytes made no difference of their own.
   */
  before?: { files: number; pixels: number };
  engine?: MemoryEngine;
}

/** The memory one file's work needs, at most. */
export function estimateOptimize(op: OptimizeOp, w: PictureWork, more: OptimizeMore = {}): MemoryEstimate {
  const F = LIMITS.imageOptMemory[more.engine ?? 'other'];
  const px = w.width * w.height;
  const deep = w.bits > 8 ? 2 : 1;
  let work: number;
  switch (op) {
    case 'png': work = F.png * w.raw; break;
    case 'jpeg-lossless': work = F.coefficient * px * (w.coefficients ?? 3); break;
    case 'jpeg': work = F.mozjpeg * px + (more.measure ? F.measure * px : 0); break;
    case 'webp': work = F.webp * px + (more.measure ? F.measure * px : 0); break;
    case 'webp-lossless': work = F.webpLossless * px; break;
    case 'avif': work = F.avif * px * deep + (more.measure ? F.measure * px * deep : 0); break;
    case 'avif-lossless': work = F.avifLossless * px * deep; break;
    case 'resize': {
      // Decoding and resampling per pixel of the picture; then its encoder per pixel of the result: MozJPEG, libwebp
      // and libavif hold the whole result as the compressions do; PNG, GIF and BMP are written a row at a time.
      const to = more.to, out = more.outPixels ?? px;
      const enc = to === 'jpg' ? F.mozjpeg : to === 'webp' ? F.webp : to === 'avif' ? F.avif * deep : to ? F.encode * deep : Math.max(F.mozjpeg, F.webp, F.avif * deep, F.encode * deep);
      work = F.decode * px * deep + enc * out;
      break;
    }
  }
  const left = more.before ? F.perFile * more.before.files + F.perPixel * more.before.pixels : 0;
  const total = F.base + F.byte * w.bytes + work + F.held * (more.held ?? 0) + left;
  return { total: Math.ceil(total), heap: 0 };
}
