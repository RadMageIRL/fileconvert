// The "Images to PDF" tool: pictures in the order of the list become one PDF, one picture a page (every page of a
// multi-page TIFF). Each picture is checked whole in the PDF worker as it is added (src/engines/pdf/images.ts,
// checkPicture): its size, how it will go into the PDF, and what that costs in memory, so a damaged picture, or a set
// that would not fit, is refused before anything is decoded. The PDF is made in the PDF worker (src/engines/pdf/images.ts): JPEG data is copied as it is, PNGs go in as
// they are or are decoded exactly, other formats are decoded by the browser; no picture is resampled, enlarged, cut
// off or recompressed unless an option asks for it, and every change is reported with the result.

import type { ToolDefinition, ToolValues } from '../app/tools';
import { formatBytes, LIMITS } from '../core/limits';
import { safeBase } from '../core/naming';
import { estimateImages, refusal, type ImageWork } from '../core/pdfmemory';
import { defaultPaper } from '../core/paper';
import { MAX_MARGIN, type ImagePageOptions } from '../engines/pdf/imagelayout';
import type { ImagePdfResult, PictureCheck, PictureReport } from '../engines/pdf/images';
import { allowance, listNames, plural } from './pdf-common';


const PAPER = ['a4', 'letter'] as const;
const NEEDS_ONE = 'This picture needs';
const NEEDS_ALL = 'Together these pictures need';
const ADVICE = 'Use fewer or smaller pictures in one PDF.';

export function optionsOf(values: ToolValues): ImagePageOptions {
  const size = values.size === 'letter' || values.size === 'picture' ? values.size : 'a4';
  const orientation = values.orientation === 'portrait' || values.orientation === 'landscape' ? values.orientation : 'auto';
  const margin = Math.max(0, Math.min(MAX_MARGIN, Number(values.margin) || 0));
  return { size, orientation, margin, fit: values.fit === 'fill' ? 'fill' : 'fit', enlarge: values.enlarge === true };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** What the tool learns about one picture as it is added (checked whole in the PDF worker, nothing decoded): its
 *  size, pages, how it goes in, and its memory cost. Damaged pictures are refused here, with the reason. */
export const inspectPicture: NonNullable<ToolDefinition['inspect']> = async (input, ctx) => {
  const { file, format } = input;
  if (file.size > LIMITS.imageBytes) return { error: `The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.` };
  const r = await ctx.engines.pdf.run<PictureCheck>('inspectImage', { file, format, allowance: allowance() }, { signal: ctx.signal });
  const notes: string[] = [];
  if (r.orientation !== 1) notes.push('Turned upright from its EXIF orientation.');
  if (r.path === 'jpeg' || r.path === 'png') notes.push(`Goes in as it is${r.bits === 16 ? ', 16 bits per channel' : ''}.`);
  else if (r.path === 'png-decode') notes.push(`Decoded and stored without loss${r.alpha === 'channel' || r.alpha === 'palette' ? ', transparency kept' : ''}${r.bits === 16 ? ', 16 bits per channel' : ''}.`);
  else notes.push(format === 'tiff' || format === 'heic' ? 'Decoded and stored without further loss.' : 'Decoded by the browser and stored without further loss.');
  notes.push(...r.notes);
  return { info: `${fmt(r.width)} x ${fmt(r.height)}${r.pages > 1 ? `, ${r.pages} pages` : ''}`, pages: r.pages, image: r.work, note: notes.join(' ') };
};

/** The result's notes: what went in as it was, what was decoded, and every change, named. */
export function describeResult(r: ImagePdfResult, o: ImagePageOptions): { details: string[]; warnings: string[] } {
  const P = r.pictures;
  const names = (f: (p: PictureReport) => boolean) => P.filter(f).map(p => p.name);
  const details: string[] = [];
  const warnings: string[] = [];
  const asJpeg = P.filter(p => p.path === 'jpeg').length;
  const asPng = P.filter(p => p.path === 'png').length;
  const pngDecoded = P.filter(p => p.path === 'png-decode').length;
  if (asJpeg) details.push(`${plural(asJpeg, 'JPEG picture')} went in as ${asJpeg === 1 ? 'it was' : 'they were'}: the compressed data is copied byte for byte, with no new compression.`);
  if (asPng) details.push(`${plural(asPng, 'PNG picture')} went in as ${asPng === 1 ? 'it was' : 'they were'}, compressed without loss.`);
  if (pngDecoded) details.push(`${plural(pngDecoded, 'PNG picture')} ${pngDecoded === 1 ? 'was' : 'were'} decoded and stored without loss (PDF cannot hold ${pngDecoded === 1 ? 'it' : 'them'} as PNG data).`);
  const wide = names(p => p.keptBits === 16);
  if (wide.length) details.push(`16 bits per channel kept: ${listNames(wide)}.`);
  const icc = names(p => p.icc === 'kept');
  if (icc.length) details.push(`Color profile kept as the picture's color space: ${listNames(icc)}.`);
  const turned = names(p => p.orientation !== 1);
  if (turned.length) details.push(`Turned upright from the EXIF orientation, without changing a pixel: ${listNames(turned)}.`);
  const alpha = names(p => p.alpha === 'kept');
  if (alpha.length) details.push(`Transparency kept (readers show the page behind it, usually white): ${listNames(alpha)}.`);
  const meta = P.filter(p => p.metadata).length;
  if (meta) details.push(`Photo metadata is not copied into the PDF: EXIF details such as the camera, the date and any GPS location, XMP and comments (${plural(meta, 'picture')} had some).`);
  const trailing = names(p => p.trailing);
  if (trailing.length) details.push(`Data after the end of the picture (such as a second picture a camera adds) was left out: ${listNames(trailing)}.`);
  if (o.size === 'picture') {
    const assumed = P.filter(p => p.place.assumed).length;
    details.push(`Each page is the size of its picture at the picture's own resolution${assumed ? ` (96 pixels per inch for ${plural(assumed, 'picture')} that do${assumed === 1 ? 'es' : ''} not give one)` : ''}${o.margin ? `, with a ${o.margin} mm margin` : ''}.`);
    const capped = names(p => p.place.capped);
    if (capped.length) warnings.push(`Larger than 200 inches at their own resolution, so drawn smaller to fit the largest page PDF readers show (no pixel is removed): ${listNames(capped)}.`);
  } else if (o.fit === 'fit') {
    const own = names(p => p.place.scale === 1);
    if (own.length && !o.enlarge) details.push(`Smaller than the page, so placed at their own size (turn on Enlarge small pictures to fill it): ${listNames(own)}.`);
    const enlarged = P.filter(p => p.place.scale > 1.0001);
    if (enlarged.length) details.push(`Enlarged to fit, as chosen: ${listNames(enlarged.map(p => `${p.name} (${p.place.scale.toFixed(1)} times)`))}.`);
  } else {
    const cut = P.filter(p => p.place.crop > 0.0005);
    if (cut.length) warnings.push(`Edges cut off to fill the page, as chosen: ${listNames(cut.map(p => `${p.name} (${Math.round(p.place.crop * 100) || '<1'}% of it)`))}.`);
    const enlarged = P.filter(p => p.place.scale > 1.0001);
    if (enlarged.length) details.push(`Enlarged to fill the page: ${listNames(enlarged.map(p => `${p.name} (${p.place.scale.toFixed(1)} times)`))}.`);
  }
  const browser = names(p => p.path === 'decode' && p.icc === 'browser');
  if (browser.length) warnings.push(`Decoded by the browser, which converts colors to sRGB, and stored without further loss; a picture saved with lossy compression keeps the quality it had: ${listNames(browser)}.`);
  const decoded = names(p => p.path === 'decode' && p.icc !== 'browser');
  if (decoded.length) warnings.push(`Decoded and stored without further loss; color profiles in these files are not applied: ${listNames(decoded)}.`);
  const reduced = P.filter(p => p.bits > p.keptBits);
  if (reduced.length) warnings.push(`Reduced to 8 bits per channel: ${listNames(reduced.map(p => `${p.name} (${p.bits} bits)`))}.`);
  const approx = names(p => p.approximateAlpha);
  if (approx.length) warnings.push(`Partly transparent pixels were read back from the browser's canvas, so their colors can be off by a small amount: ${listNames(approx)}.`);
  const unusable = names(p => p.icc === 'unusable');
  if (unusable.length) warnings.push(`A color profile that is damaged or not for the picture's colors was not used: ${listNames(unusable)}.`);
  for (const p of P) for (const n of p.notes) { const line = `${p.name}: ${n}`; if (!warnings.includes(line)) warnings.push(line); }
  return { details, warnings };
}

export const tool: ToolDefinition = {
  id: 'images-to-pdf',
  title: 'Images to PDF',
  summary: 'Makes one PDF from your pictures, one per page, in the order you set. JPEG pictures go in as they are, with no loss.',
  accepts: ['jpg', 'png', 'webp', 'avif', 'heic', 'bmp', 'gif', 'tiff'],
  minInputs: 1,
  maxInputs: LIMITS.imagePdfFiles,
  ordered: true,
  options: [
    { kind: 'select', key: 'size', label: 'Page size', value: defaultPaper(), remember: 'paper', choices: [['a4', 'A4 (210 x 297 mm)'], ['letter', 'US Letter (8.5 x 11 in)'], ['picture', 'Same as each picture']],
      hint: 'Starts at the usual paper for the language and region set in this browser, or at the size you chose last. Same as each picture makes each page the size of its picture, from the resolution it gives (96 pixels per inch if none).' },
    { kind: 'select', key: 'orientation', label: 'Orientation', value: 'auto', choices: [['auto', 'Automatic (landscape for wide pictures)'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], showIf: { key: 'size', value: PAPER } },
    { kind: 'select', key: 'fit', label: 'Placement', value: 'fit', choices: [['fit', 'Fit the whole picture (nothing cut off)'], ['fill', 'Fill the page (cuts off edges)']], showIf: { key: 'size', value: PAPER },
      hint: 'Fill covers the page inside the margin, cutting off what does not fit; the result says how much.' },
    { kind: 'check', key: 'enlarge', label: 'Enlarge small pictures to fit', value: false, showIf: { key: 'size', value: PAPER },
      hint: 'Off: a picture smaller than the page stays at its own size. Enlarging adds no detail.' },
    { kind: 'number', key: 'margin', label: 'Margin', value: 0, min: 0, max: MAX_MARGIN, unit: 'mm', hint: 'Space around each picture. 13 mm is about half an inch.' },
  ],
  action: 'Make the PDF',
  inspect: inspectPicture,
  check(inputs) {
    const works = inputs.map(i => i.image).filter((w): w is ImageWork => !!w);
    const pages = works.reduce((k, w) => k + w.pages, 0);
    if (pages > LIMITS.pdfPages) return `The pictures make ${fmt(pages)} pages; one PDF can have up to ${fmt(LIMITS.pdfPages)} here.`;
    const size = inputs.reduce((k, i) => k + i.file.size, 0);
    if (works.length && works.every(w => w.path === 'jpeg' || w.path === 'png') && size > LIMITS.imagePdfBytes) return `The pictures hold ${formatBytes(size)}, more than the ${formatBytes(LIMITS.imagePdfBytes)} one PDF can hold here. ${ADVICE}`;
    if (!works.length) return null;
    const a = allowance();
    return refusal(estimateImages(works, a.engine), a, works.length > 1 ? NEEDS_ALL : NEEDS_ONE, ADVICE);
  },
  async run(inputs, values, ctx) {
    const o = optionsOf(values);
    const r = await ctx.engines.pdf.run<ImagePdfResult>('imagesToPdf', {
      files: inputs.map(i => ({ file: i.file, format: i.format, name: i.name })), options: o, allowance: allowance(),
    }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
    const d = describeResult(r, o);
    const base = inputs.length === 1 ? safeBase(inputs[0].name) : 'images';
    return {
      outputs: [{ blob, base, ext: 'pdf', note: `${plural(r.pages, 'page')}, ${formatBytes(blob.size)}`, details: d.details }],
      warnings: d.warnings,
      summary: `${plural(r.pages, 'page')} from ${plural(inputs.length, 'picture')}`,
    };
  },
};
