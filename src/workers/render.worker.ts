// The render worker: PDF pages drawn as pictures with pdf.js (src/engines/pdf/render.ts). PDF to JPG and PNG runs here,
// one page at a time, each picture encoded and let go before the next, and written to the browser's private storage
// when it has one, so the results do not pile up in memory. The page previews of the PDF tools use a worker of their
// own (src/app/preview.ts) that keeps one PDF open and draws small pictures of its pages on request; a preview that
// fails, or a browser that cannot draw here, never stops a tool that does not need one.

import { LimitError } from '../core/limits';
import { admit, estimateRender, type MemoryAllowance, PREVIEW_PAGES, RENDER_KEPT_PAGES } from '../core/pdfmemory';
import { pixelSize, type PageSize } from '../core/pdfrender';
import { serve } from '../core/rpc';
import { createTempFile } from '../core/tempstore';
import { canDraw, checkPicture, drawPage, NO_CANVAS, openForRender, previewDpi, shownSizeOf, type OpenRender } from '../engines/pdf/render';

export interface RenderRequest {
  file: Blob;
  /** Pages to draw, from 1, in order. */
  pages: number[];
  dpi: number;
  format: 'png' | 'jpg';
  /** JPEG quality, 1 to 100. */
  quality: number;
  /** PNG only: what the page does not paint stays transparent. */
  transparent: boolean;
  /** The address of pdf.js's files in the app, ending in a slash. */
  assets: string;
  allowance?: MemoryAllowance;
  /** Where the pictures go: the browser's private storage (a session folder and a name prefix), or memory (null). */
  temp: { session: string; prefix: string } | null;
  /** The largest picture the page's check expects, in pixels. */
  pagePixels: number;
}

export interface RenderedPage {
  page: number;
  blob: Blob;
  width: number;
  height: number;
  /** The name in private storage, when it was written there. */
  temp?: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Pages counted as drawn for previews: as many as the page keeps pictures of (src/app/preview.ts). */

/** The one PDF a preview worker keeps open, and how many pages it has drawn. */
let preview: OpenRender | null = null;
let drawn = 0;

serve({
  async render(p: RenderRequest, progress) {
    if (!canDraw()) throw new Error(NO_CANVAS);
    progress({ stage: 'Checking the PDF' });
    const engine = p.allowance?.engine;
    const many = p.pages.length > 1;
    const needs = many ? `Drawing these ${fmt(p.pages.length)} pages at ${fmt(p.dpi)} dpi needs` : `Drawing this page at ${fmt(p.dpi)} dpi needs`;
    const advice = 'Choose a lower resolution.';
    const open = await openForRender(p.file, { assets: p.assets, allowance: p.allowance, pagePixels: p.pagePixels, drawn: p.pages.length, needs, advice });
    const type = p.format === 'jpg' ? 'image/jpeg' : 'image/png';
    const transparent = p.transparent && p.format === 'png';
    const outputs: RenderedPage[] = [];
    let held = 0;
    try {
      for (const [i, n] of p.pages.entries()) {
        if (n < 1 || n > open.pages) throw new Error(`The PDF has no page ${fmt(n)}.`);
        progress({ stage: `Page ${fmt(n)} (${fmt(i + 1)} of ${fmt(p.pages.length)})`, fraction: i / p.pages.length });
        const page = await open.pdf.getPage(n);
        const size = shownSizeOf(page);
        checkPicture(n, size, p.dpi, p.allowance);
        const { width, height } = pixelSize(size, p.dpi);
        // Again before each page, with its own size and what the pictures so far hold in memory.
        admit(estimateRender(open.work, width * height, { held: p.temp ? 0 : held, engine, drawn: p.pages.length }), p.allowance,
          i > 0 && !p.temp ? `With the ${fmt(i)} ${i === 1 ? 'picture' : 'pictures'} made so far held in memory, page ${fmt(n)} needs` : needs,
          i > 0 && !p.temp ? 'Convert fewer pages at a time, or choose a lower resolution.' : advice);
        const canvas = await drawPage(page, { dpi: p.dpi, transparent });
        let blob = await canvas.convertToBlob(p.format === 'jpg' ? { type, quality: p.quality / 100 } : { type });
        canvas.width = canvas.height = 0;
        page.cleanup();
        // pdf.js keeps every page it has loaded; letting them all go now and then keeps that bounded however many pages.
        if ((i + 1) % RENDER_KEPT_PAGES === 0) await open.pdf.cleanup();
        if (blob.type !== type) throw new Error(`This browser cannot write ${p.format === 'jpg' ? 'JPEG' : 'PNG'} pictures.`);
        let temp: string | undefined;
        if (p.temp) {
          temp = `${p.temp.prefix}${n}.${p.format}`;
          const f = await createTempFile(p.temp.session, temp);
          const w = f.writable.getWriter();
          try {
            await w.write({ data: new Uint8Array(await blob.arrayBuffer()), position: 0 });
            await w.close();
          } catch (e) {
            await f.abort();
            throw e;
          }
          blob = await f.finish();
        } else {
          held += blob.size;
        }
        outputs.push({ page: n, blob, width, height, temp });
      }
    } finally {
      await open.pdf.loadingTask.destroy();
    }
    return { result: { outputs, pages: open.pages } };
  },

  /** Opens one PDF for previews, keeping it open until the next previewOpen or until the worker is stopped. */
  async previewOpen(p: { file: Blob; assets: string; allowance?: MemoryAllowance; side: number }) {
    if (!canDraw()) throw new Error(NO_CANVAS);
    if (preview) { const old = preview; preview = null; await old.pdf.loadingTask.destroy(); }
    // Previews are drawn as pages come near the screen; what they leave is counted for as many pages as are kept.
    preview = await openForRender(p.file, { assets: p.assets, allowance: p.allowance, pagePixels: p.side * p.side, drawn: PREVIEW_PAGES, needs: 'Showing previews of this PDF needs' });
    return { result: { pages: preview.pages } };
  },

  /** The first page of one PDF as a small picture, its longer side `side` pixels (Merge PDFs: one for each file in the
   *  list). The PDF is checked by the guard and the memory check, opened, its first page drawn, and let go at once:
   *  nothing else of it is drawn or kept. */
  async firstPage(p: { file: Blob; assets: string; allowance?: MemoryAllowance; side: number }) {
    if (!canDraw()) throw new Error(NO_CANVAS);
    const open = await openForRender(p.file, { assets: p.assets, allowance: p.allowance, pagePixels: p.side * p.side, drawn: 1, needs: 'Showing the first page of this PDF needs' });
    try {
      const page = await open.pdf.getPage(1);
      const canvas = await drawPage(page, { dpi: previewDpi(shownSizeOf(page), p.side), transparent: false });
      const bitmap = canvas.transferToImageBitmap();
      canvas.width = canvas.height = 0;
      page.cleanup();
      return { result: { bitmap }, transfer: [bitmap] };
    } finally {
      await open.pdf.loadingTask.destroy();
    }
  },

  /** A small picture of one page of the open PDF: its longer side `side` pixels. */
  async previewPage(p: { page: number; side: number }) {
    if (!preview) throw new Error('No PDF is open for previews.');
    if (p.page < 1 || p.page > preview.pages) throw new LimitError(`The PDF has no page ${fmt(p.page)}.`);
    const page = await preview.pdf.getPage(p.page);
    const size: PageSize = shownSizeOf(page);
    const canvas = await drawPage(page, { dpi: previewDpi(size, p.side), transparent: false });
    const bitmap = canvas.transferToImageBitmap();
    canvas.width = canvas.height = 0;
    page.cleanup();
    if (++drawn % RENDER_KEPT_PAGES === 0) await preview.pdf.cleanup();
    return { result: { bitmap, w: size.w, h: size.h }, transfer: [bitmap] };
  },
});
