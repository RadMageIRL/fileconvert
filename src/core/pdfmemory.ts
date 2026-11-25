// The memory admission check for PDF work. Reading a PDF with the editing library or pdf.js costs memory in
// proportion to what is in it, not only to its size: pictures cost a few times their bytes, while dictionaries,
// arrays, form fields and pages cost far more than the bytes that describe them, since each becomes many small
// objects in the JavaScript heap. A worker that runs out of heap does not fail cleanly in Chrome: the whole page
// stops responding and Cancel cannot be pressed. So every PDF task is refused BEFORE it starts when its estimate is
// more than this browser can give, and says why.
//
// The estimate comes from what the PDF guard (src/engines/pdf/scan.ts) has already counted while checking the file
// (bytes, the bytes parsed as objects, objects, pages); nothing is read twice and no buffer is copied to estimate.
// It is compared with an allowance: half of the memory the browser reports for the device (Chrome and Edge report
// it, rounded down to a power of two: 32 GB on a 64 GB computer), or a conservative assumption where nothing is reported (Firefox, Safari), never a
// figure larger than the device is likely to have. Where the browser also reports its JavaScript heap limit
// (Chrome, Edge), the heap part of the estimate is held to that as well. The figures are in src/core/limits.ts.

import { formatBytes, LIMITS, LimitError } from './limits';

const GB = 1024 * 1024 * 1024;

/** Pages pdf.js keeps after drawing them before the render worker has it let them all go (src/engines/pdf/render.ts). */
export const RENDER_KEPT_PAGES = 50;

/** What the guard counted in one PDF, the part of it that decides its memory. */
export interface PdfWork {
  bytes: number;
  /** Bytes parsed into objects: everything outside stream data, plus what object streams decode to. */
  parsed: number;
  /** Counted, but not priced by the estimate: the bytes parsed cover what objects cost. */
  objects: number;
  pages: number;
  /** The largest stream once decoded. Page content is decoded one stream at a time, by pdf.js to read text and by the
   *  cleanup to see what a page uses, so only the largest of all counts. */
  largest?: number;
  /** Pixels of the largest picture in the file, which drawing a page that shows it decodes whole. */
  imagePixels?: number;
  /** The file has soft masks, whose drawing takes several page-sized canvases. */
  softMasks?: boolean;
}

/** Where the allowance came from: the device memory the browser reports, or an assumption where it reports none. */
export type MemoryBasis = 'device' | 'computer' | 'phone';

/**
 * Whose measurements the estimate uses. 'v8' where the browser reports its JavaScript heap limit, which only Chrome and
 * Edge (V8) do. 'gecko' where the page has window.mozInnerScreenX, which only Firefox (Gecko) has. 'other' everywhere
 * else, WebKit (Safari) included: the higher of what Firefox and WebKit were measured to use for the same work, which
 * was up to several times what Chrome used. No browser is told apart by its name.
 */
export type MemoryEngine = 'v8' | 'gecko' | 'other';

export interface MemoryAllowance {
  /** All the memory one PDF task may use, in bytes. */
  total: number;
  /** The part of it that may be JavaScript heap, where the browser reports its heap limit; null elsewhere. */
  heap: number | null;
  basis: MemoryBasis;
  engine: MemoryEngine;
  /** The device memory the browser reports, in GB (basis 'device'). */
  deviceGB?: number;
}

export interface MemoryEnv {
  deviceMemory?: number;
  /** performance.memory.jsHeapSizeLimit (Chrome, Edge). */
  heapLimit?: number;
  /** A phone or tablet, for the assumption where the device memory is not reported. */
  mobile?: boolean;
  /** The page has a property only Gecko (Firefox) has. */
  gecko?: boolean;
}

export interface MemoryEstimate {
  total: number;
  heap: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** A phone or tablet: from the user agent, or a Mac that has a touch screen (an iPad asking for desktop sites). */
export function looksMobile(nav: { userAgent?: string; platform?: string; maxTouchPoints?: number; userAgentData?: { mobile?: boolean } } | undefined): boolean {
  if (!nav) return false;
  if (nav.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(nav.userAgent ?? '')) return true;
  return /Mac/.test(nav.platform ?? '') && (nav.maxTouchPoints ?? 0) > 1;
}

/** What this browser says about the device, read on the page (workers are not told). */
export function readMemoryEnv(): MemoryEnv {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } }) | undefined;
  const perf = globalThis.performance as (Performance & { memory?: { jsHeapSizeLimit?: number } }) | undefined;
  const gecko = typeof (globalThis as { mozInnerScreenX?: unknown }).mozInnerScreenX === 'number';
  return { deviceMemory: nav?.deviceMemory, heapLimit: perf?.memory?.jsHeapSizeLimit, mobile: looksMobile(nav), gecko };
}

/** How much memory one PDF task may use in this browser. */
export function memoryAllowance(env: MemoryEnv = readMemoryEnv()): MemoryAllowance {
  const L = LIMITS;
  let total: number;
  let basis: MemoryBasis;
  if (finite(env.deviceMemory)) {
    total = env.deviceMemory * GB * L.pdfMemoryDeviceShare;
    basis = 'device';
  } else {
    basis = env.mobile ? 'phone' : 'computer';
    total = basis === 'phone' ? L.pdfMemoryAssumedPhone : L.pdfMemoryAssumedComputer;
  }
  total = Math.floor(Math.min(total, L.pdfMemoryCeiling));
  const heap = finite(env.heapLimit) ? Math.max(0, Math.floor((env.heapLimit - L.pdfHeapReserve) * L.pdfHeapShare)) : null;
  const engine: MemoryEngine = heap !== null ? 'v8' : env.gecko ? 'gecko' : 'other';
  return { total, heap, basis, engine, deviceGB: basis === 'device' ? env.deviceMemory : undefined };
}

/** The work in one PDF, from what its guard pass counted. */
export function workOf(bytes: number, scan: { textBytes: number; objectStreamBytes: number; objects: number; pages: number; largestStream: number; largestImagePixels?: number; softMasks?: number }): PdfWork {
  return { bytes, parsed: scan.textBytes + scan.objectStreamBytes, objects: scan.objects, pages: scan.pages, largest: scan.largestStream, imagePixels: scan.largestImagePixels ?? 0, softMasks: (scan.softMasks ?? 0) > 0 };
}

const sumOf = (works: readonly PdfWork[], k: 'bytes' | 'parsed' | 'objects' | 'pages') => works.reduce((n, w) => n + w[k], 0);

/**
 * The memory a task on these PDFs needs, at most. `kind` is 'edit' for the editing library (merge, split, extract,
 * delete, reorder, rotate: the file read whole, every object parsed, the result written whole) and 'text' for pdf.js
 * reading text (the file read whole, objects parsed as pages need them). `outputs` is the number of files made,
 * `extraOutput` the bytes they hold beyond the input (split: pages shared by several parts are copied into each) and
 * `listed` the pages the reorder tool shows in its list. `engine` picks the measurements (the highest when not given).
 */
export function estimate(works: readonly PdfWork[], kind: 'edit' | 'text', more: { outputs?: number; extraOutput?: number; listed?: number; engine?: MemoryEngine } = {}): MemoryEstimate {
  const engine = more.engine ?? 'other';
  const edit = LIMITS.pdfEditMemory[engine];
  const per = kind === 'edit' ? edit : LIMITS.pdfTextMemory[engine];
  const outputs = kind === 'edit' ? more.outputs ?? 1 : 0;
  const objects = per.parsed * sumOf(works, 'parsed') + per.page * sumOf(works, 'pages') + (kind === 'edit' ? edit.output * outputs : 0);
  const largest = works.reduce((n, w) => Math.max(n, w.largest ?? 0), 0);
  // The page list and the new files' bytes are held on the page and as buffers, not in the worker's heap.
  const page = kind === 'edit' ? edit.list * (more.listed ?? 0) + edit.copy * (more.extraOutput ?? 0) : 0;
  const total = per.base + per.byte * sumOf(works, 'bytes') + per.stream * largest + objects + page;
  // What has to fit in the heap at once: the objects alone, with figures fitted to where a capped heap stopped Chrome.
  const H = LIMITS.pdfHeapMemory;
  const heap = H.parsed * sumOf(works, 'parsed') + H.page * sumOf(works, 'pages') + H.output * outputs;
  return { total: Math.ceil(total), heap: Math.ceil(heap) };
}

/**
 * The memory drawing pages of one PDF as pictures needs, at most (PDF to JPG and PNG, page previews): pdf.js reading the
 * file, as for text, and keeping up to 50 pages it has drawn (`page`, per page of the file up to that), and what each
 * page drawn leaves until it is collected (`drawn`, per page drawn: `more.drawn`); the largest
 * picture in it, decoded whole when a page that shows it is drawn (`image`, per pixel: its samples, the bitmap pdf.js
 * makes of them and the smaller copies it draws from); the page being drawn (`canvas`, per pixel of the picture made: the
 * canvas, a transparency group's and the encoder's copy; `masked` instead where the file has soft masks, which take
 * several more page-sized canvases); and the results held in memory (`held`, per byte: none when they are written to the
 * browser's private storage). Pages are drawn one at a time and let go before the next, so only the largest counts.
 */
export function estimateRender(work: PdfWork, pagePixels: number, more: { held?: number; engine?: MemoryEngine; drawn?: number } = {}): MemoryEstimate {
  const F = LIMITS.pdfRenderMemory[more.engine ?? 'other'];
  const total = F.base + F.byte * work.bytes + F.parsed * work.parsed + F.page * Math.min(work.pages, RENDER_KEPT_PAGES) + F.drawn * (more.drawn ?? 0) + F.stream * (work.largest ?? 0)
    + F.image * (work.imagePixels ?? 0) + (work.softMasks ? F.masked : F.canvas) * pagePixels + F.held * (more.held ?? 0);
  const H = LIMITS.pdfHeapMemory;
  return { total: Math.ceil(total), heap: Math.ceil(H.parsed * work.parsed + H.page * work.pages) };
}

/** What one picture costs Images to PDF, from its header (src/engines/pdf/imageinfo.ts), before it is decoded. */
export interface ImageWork {
  /** The file's size. */
  bytes: number;
  /** Pixels of its largest page. */
  pixels: number;
  /** Bytes of its decoded samples, every page, alpha included: what the PDF holds when it is decoded. */
  raw: number;
  /** As it is (a JPEG, or a PNG PDF can hold), decoded here (a PNG), or decoded by the browser. */
  path: 'jpeg' | 'png' | 'png-decode' | 'decode';
  pages: number;
}

/**
 * The memory Images to PDF needs for these pictures, at most: what the PDF holds of every picture (as it is, or its
 * decoded samples, compressed without loss, which is never more than the samples), plus the most that adding any one
 * of them takes (pictures are added one at a time, and each is let go before the next), plus the pages.
 */
export function estimateImages(works: readonly ImageWork[], engine: MemoryEngine = 'other'): MemoryEstimate {
  const F = LIMITS.imagePdfMemory[engine];
  let held = 0, adding = 0, pages = 0;
  for (const w of works) {
    const asIs = w.path === 'jpeg' || w.path === 'png';
    held += asIs ? w.bytes : w.raw;
    pages += w.pages;
    const one = F.copy * w.bytes + (w.path === 'png-decode' ? F.planes * w.raw : w.path === 'decode' ? F.pixel * w.pixels : 0);
    adding = Math.max(adding, one);
  }
  const total = F.base + F.held * held + adding + F.page * pages;
  return { total: Math.ceil(total), heap: Math.ceil(LIMITS.pdfHeapMemory.page * pages + LIMITS.pdfHeapMemory.output) };
}

/** What checking one picture as it is added needs: the file read whole in the PDF worker, nothing decoded. */
export function estimateImageCheck(bytes: number, engine: MemoryEngine = 'other'): MemoryEstimate {
  const F = LIMITS.imagePdfMemory[engine];
  return { total: Math.ceil(F.base + F.copy * bytes), heap: 0 };
}

/** The check before any reading: the size alone, against the allowance (the cheapest part of the estimate). */
export function estimateFromSize(bytes: number, kind: 'edit' | 'text' | 'render', engine: MemoryEngine = 'other'): MemoryEstimate {
  const per = kind === 'edit' ? LIMITS.pdfEditMemory[engine] : kind === 'text' ? LIMITS.pdfTextMemory[engine] : LIMITS.pdfRenderMemory[engine];
  return { total: Math.ceil(per.base + per.byte * bytes), heap: 0 };
}

const gb = (n: number) => formatBytes(n);

/** Where the allowance comes from, in words, for a refusal. */
export function allowanceText(a: MemoryAllowance): string {
  if (a.basis === 'device') return `the ${gb(a.total)} FileConvert lets one task use on this device (half of the ${a.deviceGB! >= 1 ? `${a.deviceGB} GB` : `${a.deviceGB! * 1024} MB`} of memory the browser reports)`;
  if (a.basis === 'phone') return `the ${gb(a.total)} FileConvert lets one task use on a phone or tablet whose browser does not say how much memory it has`;
  return `the ${gb(a.total)} FileConvert lets one task use in a browser that does not say how much memory the device has`;
}

/**
 * Null when the estimate fits the allowance, or the refusal: `needs` starts the sentence ("This PDF needs", "Together
 * these files need"), `advice` ends it ("Merge fewer files at a time.").
 */
export function refusal(e: MemoryEstimate, a: MemoryAllowance, needs: string, advice: string): string | null {
  if (e.total > a.total) {
    // Where the device memory is not reported, the allowance is an assumption; Chrome and Edge report it.
    const hint = a.basis === 'device' ? '' : ' Chrome and Edge say how much memory the device has, so FileConvert may allow more there.';
    return `${needs} about ${gb(e.total)} of memory, more than ${allowanceText(a)}, so it was not started. ${advice}${hint}`.replace(/\s+$/, '').replace(/ {2,}/g, ' ');
  }
  if (a.heap !== null && e.heap > a.heap) {
    return `${needs} about ${gb(e.heap)} of the browser's working memory for its objects and pages, more than the ${gb(a.heap)} this browser gives one task, so it was not started. ${advice}`.trim();
  }
  return null;
}

/** A refusal raised in a worker: the same message, as a LimitError. */
export class MemoryLimitError extends LimitError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryLimitError';
  }
}

/** Throws a MemoryLimitError when the estimate does not fit the allowance. */
export function admit(e: MemoryEstimate, a: MemoryAllowance | undefined, needs: string, advice: string): void {
  if (!a) return;
  const why = refusal(e, a, needs, advice);
  if (why) throw new MemoryLimitError(why);
}
