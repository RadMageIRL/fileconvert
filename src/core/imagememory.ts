// The memory admission check for the image optimization tools (Compress PNG, JPEG, WebP and AVIF, Resize images), on the
// same allowance as the PDF tools (./pdfmemory: half the memory the browser reports, or an assumption where it reports
// none, 4 GB at most). Each file is processed alone, one after another, so a batch needs what its largest file needs,
// plus the results it has made so far, which the page holds until they are downloaded.
//
// The estimate comes from what the file's header says before anything is decoded: its size, pixels, bit depth and, for
// a JPEG, how many DCT coefficients it holds. The figures (src/core/limits.ts, imageOptMemory) are per byte of the file,
// per pixel or per byte of decoded samples for each kind of work, fitted to peaks measured in Chrome and Firefox; the
// figures for other browsers are higher than both.

import { LIMITS } from './limits';
import type { MemoryEngine, MemoryEstimate } from './pdfmemory';

export type OptimizeOp = 'png' | 'jpeg-lossless' | 'jpeg' | 'webp' | 'webp-lossless' | 'avif' | 'resize';

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
  /** The similarity measure is on: the result is decoded again. */
  measure?: boolean;
  /** Bytes of the results made so far, held by the page. */
  held?: number;
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
    case 'resize': work = F.decode * px * deep + F.encode * (more.outPixels ?? px) * deep; break;
  }
  const total = F.base + F.byte * w.bytes + work + F.held * (more.held ?? 0);
  return { total: Math.ceil(total), heap: 0 };
}
