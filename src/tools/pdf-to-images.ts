// The "PDF to JPG or PNG" tool: pages of a PDF saved as pictures, every page or the ones chosen, at a resolution, in the
// render worker (src/workers/render.worker.ts) with pdf.js. Each page is drawn at exactly the size its resolution gives,
// from its crop box and rotation; nothing is ever drawn smaller to fit a limit: a page too large for one picture, or work
// that would need more memory than this browser can give, is refused before it starts, with the size it would have
// and the resolution at which it fits. Pages are drawn one at a time; each picture is encoded and written to the
// browser's private storage (where it has one) before the next, so the results do not pile up in memory.

import type { ToolDefinition, ToolInput, ToolValues } from '../app/tools';
import { formatBytes } from '../core/limits';
import { safeBase } from '../core/naming';
import { estimateRender, refusal } from '../core/pdfmemory';
import { NO_CANVAS, pictureLimits, pictureProblem, pixelSize, RENDER } from '../core/pdfrender';
import { hasTempStore } from '../core/tempstore';
import type { RenderedPage } from '../workers/render.worker';
import { allowance, chosenPages, inspectPdf, pageLabel, pagesNote, pagesOfInput, plural } from './pdf-common';

const fmt = (n: number) => n.toLocaleString('en-US');

/** The resolution chosen, in pixels per inch. */
export function dpiOf(values: ToolValues): number {
  const v = values.dpi === 'custom' ? Number(values.customDpi) : Number(values.dpi);
  return Math.max(RENDER.dpiMin, Math.min(RENDER.dpiMax, Math.round(Number.isFinite(v) ? v : 150)));
}

const formatOf = (values: ToolValues): 'png' | 'jpg' => (values.format === 'png' ? 'png' : 'jpg');
const LABEL = { png: 'PNG', jpg: 'JPG' } as const;

/** Each chosen page's picture size, from the sizes the check of the file found. */
function pictures(input: ToolInput | undefined, values: ToolValues): Array<{ page: number; width: number; height: number }> | null {
  const n = input?.pages ?? 0;
  const sizes = input?.sizes;
  if (!n || !sizes) return null;
  const dpi = dpiOf(values);
  return chosenPages(values.pages, n, true).map(page => ({ page, ...pixelSize({ w: sizes[2 * page - 2], h: sizes[2 * page - 1] }, dpi) }));
}

/** Results a browser without private storage holds in memory, about: what such pictures usually take (a page of text
 *  far less, a page of photos more; the render worker checks again with the real sizes as it goes). */
const HELD_PER_PIXEL = { png: 1, jpg: 0.35 } as const;

export const tool: ToolDefinition = {
  id: 'pdf-to-images',
  title: 'PDF to JPG or PNG',
  summary: 'Saves the pages of a PDF as JPG or PNG pictures, every page or the ones you choose, at the resolution you choose.',
  accepts: ['pdf'],
  minInputs: 1,
  maxInputs: 1,
  ordered: false,
  options: [
    { kind: 'select', key: 'format', label: 'Picture format', value: 'jpg', choices: [['jpg', 'JPG (smaller files)'], ['png', 'PNG (no loss)']] },
    { kind: 'select', key: 'dpi', label: 'Resolution', value: '150', choices: [['72', '72 dpi (screen)'], ['150', '150 dpi (documents)'], ['300', '300 dpi (print)'], ['custom', 'Custom']],
      hint: 'Dots per inch of the page: a US Letter page at 150 dpi is 1,275 x 1,650 pixels.' },
    { kind: 'number', key: 'customDpi', label: 'Custom resolution', value: 200, min: RENDER.dpiMin, max: RENDER.dpiMax, unit: 'dpi', showIf: { key: 'dpi', value: 'custom' } },
    { kind: 'number', key: 'quality', label: 'JPG quality', value: 90, min: 1, max: 100, showIf: { key: 'format', value: 'jpg' },
      hint: 'Higher is sharper and larger; 90 keeps text crisp. JPG pictures always have a white background.' },
    { kind: 'select', key: 'background', label: 'Background', value: 'white', choices: [['white', 'White'], ['transparent', 'Transparent where the page has nothing']], showIf: { key: 'format', value: 'png' },
      hint: 'Pages that paint their own white background stay white.' },
    { kind: 'pages', key: 'pages', label: 'Pages to convert', value: '', placeholder: 'Every page', maxLength: 4000, empty: 'all',
      hint: 'Leave empty for every page, or list pages such as 1, 3-5, or choose them in the page previews.' },
  ],
  action: 'Convert the pages',
  inspect: inspectPdf('Converting', { sizes: true, changes: false }),
  plan(inputs, values) {
    let list;
    try { list = pictures(inputs[0], values); } catch { return null; }
    if (!list?.length) return null;
    const what = `${plural(list.length, `${LABEL[formatOf(values)]} picture`)} at ${fmt(dpiOf(values))} dpi`;
    const px = (p: { width: number; height: number }) => `${fmt(p.width)} x ${fmt(p.height)} pixels`;
    if (list.length === 1) return `${what}: ${px(list[0])}.`;
    const areas = list.map(p => p.width * p.height);
    const small = list[areas.indexOf(Math.min(...areas))], large = list[areas.indexOf(Math.max(...areas))];
    return small.width === large.width && small.height === large.height ? `${what}, ${px(large)} each.` : `${what}, from ${px(small)} to ${px(large)}.`;
  },
  check(inputs, values) {
    const input = inputs[0];
    const n = pagesOfInput(inputs);
    if (!n) return 'Checking the file.';
    // Pages are drawn on an OffscreenCanvas in a worker; a browser without one on the page has none there either.
    if (typeof OffscreenCanvas !== 'function') return NO_CANVAS;
    let pages: number[];
    try { pages = chosenPages(values.pages, n, true); } catch (e) { return (e as Error).message; }
    const sizes = input.sizes;
    const a = allowance();
    const dpi = dpiOf(values);
    let largest = 0, total = 0;
    if (sizes) {
      const L = pictureLimits(a.basis);
      for (const p of pages) {
        const size = { w: sizes[2 * p - 2], h: sizes[2 * p - 1] };
        const why = pictureProblem(p, size, dpi, L);
        if (why) return why;
        const { width, height } = pixelSize(size, dpi);
        largest = Math.max(largest, width * height);
        total += width * height;
      }
    }
    if (!input.work) return null;
    const format = formatOf(values);
    const held = hasTempStore() ? 0 : total * HELD_PER_PIXEL[format];
    const needs = pages.length > 1 ? `Converting ${plural(pages.length, 'page')} at ${fmt(dpi)} dpi needs` : `Converting this page at ${fmt(dpi)} dpi needs`;
    return refusal(estimateRender(input.work, largest, { held, engine: a.engine, drawn: pages.length }), a, needs, held ? 'Convert fewer pages at a time, or choose a lower resolution.' : 'Choose a lower resolution.');
  },
  async run(inputs, values, ctx) {
    const input = inputs[0];
    const n = pagesOfInput(inputs);
    const pages = chosenPages(values.pages, n, true);
    const dpi = dpiOf(values);
    const format = formatOf(values);
    const transparent = format === 'png' && values.background === 'transparent';
    const list = pictures(input, values);
    const pagePixels = list ? Math.max(...list.map(p => p.width * p.height)) : 0;
    const r = await ctx.engines.render.run<{ outputs: RenderedPage[]; pages: number }>('render', {
      file: input.file, pages, dpi, format, quality: Math.max(1, Math.min(100, Number(values.quality) || 90)), transparent,
      assets: new URL(`${document.documentElement.dataset.root ?? './'}pdfjs/`, document.baseURI).href,
      allowance: allowance(), temp: ctx.temp, pagePixels,
    }, { signal: ctx.signal, onProgress: ctx.progress });
    const base = safeBase(input.name);
    const outputs = r.outputs.map(o => ({
      blob: o.blob, base: `${base}-${pageLabel(o.page, o.page, n)}`, ext: format, temp: o.temp,
      note: `Page ${fmt(o.page)}, ${fmt(o.width)} x ${fmt(o.height)} pixels, ${formatBytes(o.blob.size)}`,
    }));
    const warnings: string[] = [];
    if (format === 'jpg') warnings.push(`JPG compresses with some loss (quality ${Number(values.quality) || 90}); choose PNG for pictures without loss.`);
    if (transparent) warnings.push('What the pages do not paint is transparent. Pages that paint their own white background stay white.');
    warnings.push('Each picture shows the page as a PDF reader shows it, comments and filled-in form fields included. Fonts the PDF does not include are drawn with similar fonts, so such text can look a little different.');
    return { outputs, warnings, summary: `${pages.length === n ? `All ${plural(n, 'page')}` : pagesNote(pages)} at ${fmt(dpi)} dpi` };
  },
};
