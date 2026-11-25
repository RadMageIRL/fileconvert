// Drawing PDF pages as pictures, in the render worker (src/workers/render.worker.ts): PDF to JPG and PNG, and the
// page previews of the PDF tools. pdf.js reads the file and draws each page on an OffscreenCanvas, all in this worker:
// its parser runs here too (pdf.js's "fake worker"), so nothing is drawn on the page, a page left in a background tab
// keeps going, and canceling terminates the one worker that holds everything.
//
// The PDF guard (./scan.ts) reads every file first, here, on the very bytes pdf.js gets: pdf.js never sees a file whose
// compressed data, pictures or counts are past the limits, nor an encrypted one. The memory admission check
// (src/core/pdfmemory.ts, estimateRender) then refuses work that would need more than this browser can give, before
// pdf.js reads anything, and again before each page is drawn, with the size pdf.js reports for it.
//
// Fonts are drawn as outlines by pdf.js (disableFontFace), since a worker has no document to load fonts into: the
// fonts embedded in the PDF are drawn from their own data, and the standard ones (Helvetica, Times, Courier and the
// others a PDF may name without embedding) from the font files pdf.js ships, which load from the app's own folder
// when a page needs them, as do its character maps, its JPEG 2000 and JBIG2 decoders and its CMYK color profile.
// A font for which there is neither (Chinese, Japanese or Korean text in a font the PDF does not include) is drawn by
// the canvas with the device's own fonts.

import { LIMITS, LimitError } from '../../core/limits';
import { admit, estimateFromSize, estimateRender, workOf, type MemoryAllowance, type PdfWork } from '../../core/pdfmemory';
import { NO_CANVAS, pictureLimits, pictureProblem, type PageSize } from '../../core/pdfrender';

export { NO_CANVAS };
import { ENCRYPTED_MESSAGE, scanPdf } from './scan';

type PdfJs = typeof import('pdfjs-dist');
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDoc['getPage']>>;

let lib: Promise<PdfJs> | null = null;

/** pdf.js, with its parser loaded into this worker. The parser is the same file PDF to TXT starts as pdf.js's own worker
 *  on the page; importing it here makes pdf.js parse in this thread instead of starting a worker of its own. */
export function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    const parser = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    await import(/* @vite-ignore */ parser.default);
    return import('pdfjs-dist');
  })();
  return lib;
}

/** Whether this browser can draw here: an OffscreenCanvas with a 2D context, and a way to encode it. */
export function canDraw(): boolean {
  if (typeof OffscreenCanvas !== 'function') return false;
  try {
    const c = new OffscreenCanvas(1, 1);
    return !!c.getContext('2d') && typeof c.convertToBlob === 'function';
  } catch {
    return false;
  }
}


/** Canvases for pdf.js in a worker: OffscreenCanvas, read back on the CPU as pdf.js does without hardware acceleration. */
class WorkerCanvasFactory {
  constructor(_: { enableHWA?: boolean }) { void _; }
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset(cc: { canvas: OffscreenCanvas | null }, width: number, height: number) {
    if (!cc.canvas) throw new Error('Canvas is not specified');
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (!cc.canvas) throw new Error('Canvas is not specified');
    cc.canvas.width = cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
  getNoAlphaContext(canvas: OffscreenCanvas) {
    return canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  _createCanvas(width: number, height: number) {
    return new OffscreenCanvas(width, height);
  }
}

/** pdf.js makes SVG filters in the document for soft masks and transfer functions; a worker has none. With no filter,
 *  pdf.js applies soft masks itself, pixel by pixel; transfer functions (rare) are not applied. */
class NoFilterFactory {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; }
  addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; }
  destroy() { /* nothing held */ }
}

/** A PDF read for drawing, after the guard and the memory check. */
export interface OpenRender {
  pdf: PdfDoc;
  work: PdfWork;
  pages: number;
}

/**
 * Checks a PDF with the guard and the memory check, then opens it with pdf.js. `assets` is the address of pdf.js's
 * files in the app (character maps, standard fonts, decoders), ending in a slash. `pagePixels` is the largest picture
 * that will be drawn, `drawn` how many pages will be, and `needs` starts a refusal ("Drawing these pages needs").
 */
export async function openForRender(file: Blob, p: { assets: string; allowance?: MemoryAllowance; pagePixels: number; drawn: number; needs: string; advice?: string }): Promise<OpenRender> {
  const engine = p.allowance?.engine;
  admit(estimateFromSize(file.size, 'render', engine), p.allowance, p.needs, p.advice ?? '');
  if (file.size > LIMITS.pdfBytes) throw new LimitError(`The PDF is larger than ${LIMITS.pdfBytes / 1048576} MB, the limit.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const scan = scanPdf(bytes);
  if (scan.encrypted) throw new Error(ENCRYPTED_MESSAGE);
  const work = workOf(bytes.length, scan);
  admit(estimateRender(work, p.pagePixels, { engine, drawn: p.drawn }), p.allowance, p.needs, p.advice ?? '');
  const m = await pdfjs();
  const task = m.getDocument({
    data: bytes,
    cMapUrl: `${p.assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${p.assets}standard_fonts/`,
    wasmUrl: `${p.assets}wasm/`,
    iccUrl: `${p.assets}iccs/`,
    useWorkerFetch: true,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    maxImageSize: LIMITS.pdfImagePixels,
    isOffscreenCanvasSupported: true,
    disableWorkerRendering: true,
    CanvasFactory: WorkerCanvasFactory,
    FilterFactory: NoFilterFactory,
    verbosity: 0,
  } as Parameters<PdfJs['getDocument']>[0]);
  let pdf: PdfDoc;
  try {
    pdf = await task.promise;
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'PasswordException') throw new Error(ENCRYPTED_MESSAGE);
    if (name === 'InvalidPDFException') throw new Error('This file is not a valid PDF, or it is damaged.');
    throw new Error(`The PDF could not be opened: ${(e as Error).message}`);
  }
  if (pdf.numPages > LIMITS.pdfPages) {
    await pdf.loadingTask.destroy();
    throw new LimitError(`The PDF has ${pdf.numPages.toLocaleString('en-US')} pages; the limit is ${LIMITS.pdfPages.toLocaleString('en-US')}.`);
  }
  return { pdf, work, pages: pdf.numPages };
}

/** A page as pdf.js shows it, in points: its view (crop box within media box), rotation and UserUnit. */
export function shownSizeOf(page: PdfPage): PageSize {
  const v = page.getViewport({ scale: 1 });
  return { w: v.width, h: v.height };
}

export interface DrawOptions {
  /** Pixels per inch. */
  dpi: number;
  /** Leave what the page does not paint transparent (PNG only); otherwise it is white. */
  transparent: boolean;
}

/** Draws one page on a canvas of exactly the size its resolution gives. The caller encodes it, then lets it go. */
export async function drawPage(page: PdfPage, o: DrawOptions): Promise<OffscreenCanvas> {
  const m = await pdfjs();
  const viewport = page.getViewport({ scale: o.dpi / 72 });
  const width = Math.max(1, Math.round(viewport.width)), height = Math.max(1, Math.round(viewport.height));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: o.transparent, willReadFrequently: true });
  // A canvas the browser could not make comes back without a context, or smaller than asked.
  if (!ctx || canvas.width !== width || canvas.height !== height) throw new LimitError(`The browser could not make a canvas of ${width.toLocaleString('en-US')} x ${height.toLocaleString('en-US')} pixels for page ${page.pageNumber}; choose a lower resolution.`);
  const task = page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    canvas: null,
    viewport,
    intent: 'display',
    annotationMode: m.AnnotationMode.ENABLE,
    background: o.transparent ? 'rgba(0,0,0,0)' : '#ffffff',
  });
  await task.promise;
  return canvas;
}

/** Fits a page's picture in a square of `side` pixels, for a preview: the scale for drawPage, as a resolution. */
export function previewDpi(size: PageSize, side: number): number {
  return 72 * side / Math.max(size.w, size.h, 1);
}

/** The limits on one picture for this allowance (a phone or tablet that does not report its memory gets Safari's). */
export function limitsFor(allowance: MemoryAllowance | undefined) {
  return pictureLimits(allowance?.basis ?? 'computer');
}

/** Throws when page `n` at `dpi` is past the limits, with the size it would have and the resolution that fits. */
export function checkPicture(n: number, size: PageSize, dpi: number, allowance: MemoryAllowance | undefined): void {
  const why = pictureProblem(n, size, dpi, limitsFor(allowance));
  if (why) throw new LimitError(why);
}
