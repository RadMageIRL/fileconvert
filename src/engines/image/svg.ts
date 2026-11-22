// SVG to pixels, on the page (browsers cannot decode SVG in a worker). Every SVG is treated as hostile:
//
// 1. It is parsed as XML, and refused if it declares entities (billion laughs, external entities).
// 2. An allowlist keeps only the elements and attributes of a static drawing. Scripts, event handlers, HTML in
//    foreignObject, animation, and every reference outside the file are removed: href may only point inside the
//    file (#id) or hold an embedded PNG, JPEG, GIF, WebP or AVIF picture; stylesheets lose @import, @font-face and
//    any url() that is not #id; xml-stylesheet instructions are dropped.
// 3. The clean SVG is drawn through an <img>, where browsers run no scripts and load nothing from anywhere.
// 4. The page's Content Security Policy still forbids connections to any other site.
//
// The result is a lossless PNG at the chosen size, which the image engine then converts like any other picture.

import { LIMITS, LimitError } from '../../core/limits';
import { decodeText } from '../../core/text';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Elements of a static drawing. Anything else is removed with its content. */
const ALLOWED = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'switch', 'a', 'view',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker', 'image', 'style',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
  'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);

const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]*$/i;

export type SvgSize = 'original' | '2x' | '4x' | '512' | '1024' | '2048' | '4096';

export interface SvgReport {
  scripts: number;
  handlers: number;
  external: number;
  html: number;
  animation: number;
  styles: number;
  other: number;
}

/** CSS with no way out of the file: no @import, no @font-face, and no url() other than #id. */
export function cleanCss(css: string, report: SvgReport): string {
  let out = css.replace(/@import[^;]*;?/gi, () => { report.external++; return ''; });
  out = out.replace(/@font-face\s*\{[^}]*\}/gi, () => { report.external++; return ''; });
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, target: string) => {
    if (target.trim().startsWith('#')) return m;
    report.external++;
    return 'none';
  });
  // Escapes could rebuild a url( or an @import after the checks above, so CSS escapes are not allowed at all.
  if (/\\/.test(out)) { report.styles++; return ''; }
  return out;
}

/** Parses, checks and cleans an SVG. Returns the clean document and what was removed. */
export function sanitizeSvg(text: string): { doc: Document; report: SvgReport } {
  const report: SvgReport = { scripts: 0, handlers: 0, external: 0, html: 0, animation: 0, styles: 0, other: 0 };
  if (/<!DOCTYPE[^>]*\[/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new Error('This SVG declares entities, which can be used to attack the converter, so it was not opened.');
  }
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(`This SVG is not valid XML: ${(error.textContent ?? '').trim().split('\n')[0].slice(0, 200)}`);
  const root = doc.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') throw new Error('This file does not have an <svg> root element.');
  // Processing instructions (xml-stylesheet can load a stylesheet from anywhere) and comments.
  for (const n of [...doc.childNodes]) if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE || n.nodeType === Node.COMMENT_NODE) { if (n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) report.external++; n.remove(); }
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      const name = child.localName;
      if (child.namespaceURI !== SVG_NS || !ALLOWED.has(name)) {
        if (name === 'script') report.scripts++;
        else if (name === 'foreignObject' || child.namespaceURI === 'http://www.w3.org/1999/xhtml') report.html++;
        else if (/^(animate|animateMotion|animateTransform|set|discard)$/.test(name)) report.animation++;
        else report.other++;
        child.remove();
        continue;
      }
      if (name === 'style') {
        const css = child.textContent ?? '';
        const clean = cleanCss(css, report);
        child.textContent = clean;
      }
      cleanAttributes(child, report);
      walk(child);
    }
    // Comments and instructions inside the drawing carry nothing needed.
    for (const n of [...el.childNodes]) if (n.nodeType === Node.COMMENT_NODE || n.nodeType === Node.PROCESSING_INSTRUCTION_NODE) n.remove();
  };
  cleanAttributes(root, report);
  walk(root);
  return { doc, report };
}

function cleanAttributes(el: Element, report: SvgReport): void {
  for (const attr of [...el.attributes]) {
    const name = attr.localName.toLowerCase();
    const value = attr.value;
    if (name.startsWith('on')) { report.handlers++; el.removeAttributeNode(attr); continue; }
    if (/javascript:|vbscript:/i.test(value.replace(/[\s\u0000-\u001f]/g, ''))) { report.scripts++; el.removeAttributeNode(attr); continue; }
    if (name === 'href' && (attr.namespaceURI === null || attr.namespaceURI === XLINK_NS)) {
      const v = value.trim();
      const internal = v.startsWith('#');
      const picture = (el.localName === 'image' || el.localName === 'feImage') && RASTER_DATA.test(v);
      if (!internal && !picture) { report.external++; el.removeAttributeNode(attr); }
      continue;
    }
    if (name === 'style') { attr.value = cleanCss(value, report); continue; }
    if (/url\s*\(/i.test(value)) attr.value = cleanCss(value, report);
  }
}

const UNITS: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };

/** A length attribute in CSS pixels, or null for a percentage or something unreadable. */
export function svgLength(v: string | null): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex)?\s*$/i.exec(v ?? '');
  if (!m) return null;
  const n = Number(m[1]) * UNITS[(m[2] ?? '').toLowerCase()];
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The drawing's own size: width and height, or the viewBox, or the browser default of 300 x 150. */
export function intrinsicSize(root: Element): { width: number; height: number; viewBox: number[] | null } {
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const viewBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0 ? vb : null;
  let w = svgLength(root.getAttribute('width')), h = svgLength(root.getAttribute('height'));
  if (viewBox) {
    if (w && !h) h = w * viewBox[3] / viewBox[2];
    if (h && !w) w = h * viewBox[2] / viewBox[3];
    w ??= viewBox[2];
    h ??= viewBox[3];
  }
  return { width: w ?? 300, height: h ?? 150, viewBox };
}

export function targetSize(w: number, h: number, size: SvgSize): { width: number; height: number } {
  const scale = size === '2x' ? 2 : size === '4x' ? 4 : /^\d+$/.test(size) ? Number(size) / w : 1;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function reportNotes(r: SvgReport): string[] {
  const notes: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (r.scripts) notes.push(`${n(r.scripts, 'script was', 'scripts were')} removed; nothing in the file ran.`);
  if (r.handlers) notes.push(`${n(r.handlers, 'event handler was', 'event handlers were')} removed.`);
  if (r.external) notes.push(`${n(r.external, 'reference', 'references')} to files, fonts or stylesheets outside the SVG ${r.external === 1 ? 'was' : 'were'} removed; nothing was downloaded.`);
  if (r.html) notes.push(`${n(r.html, 'block', 'blocks')} of HTML content (foreignObject) ${r.html === 1 ? 'was' : 'were'} removed; text inside it may be missing.`);
  if (r.animation) notes.push('Animation was removed; the picture shows the drawing as it is before any animation.');
  if (r.styles) notes.push('A stylesheet with CSS escapes was removed, as escapes can hide references outside the file.');
  if (r.other) notes.push(`${n(r.other, 'element', 'elements')} that a static drawing does not use ${r.other === 1 ? 'was' : 'were'} removed.`);
  return notes;
}

/** Rasterizes an SVG file to a PNG at the chosen size. */
export async function rasterizeSvg(file: Blob, size: SvgSize): Promise<{ png: Blob; width: number; height: number; warnings: string[] }> {
  if (file.size > LIMITS.svgBytes) throw new LimitError(`The SVG is larger than ${LIMITS.svgBytes / 1048576} MB, the limit for SVG.`);
  const dec = decodeText(new Uint8Array(await file.arrayBuffer()));
  const { doc, report } = sanitizeSvg(dec.text);
  const warnings = [...(dec.warning ? [dec.warning] : []), ...reportNotes(report)];
  const root = doc.documentElement;
  const own = intrinsicSize(root);
  const { width, height } = targetSize(own.width, own.height, size);
  if (width > LIMITS.imageSide || height > LIMITS.imageSide || width * height > LIMITS.imagePixels) {
    throw new LimitError(`At this size the picture would be ${width.toLocaleString('en-US')} x ${height.toLocaleString('en-US')} pixels, more than the limit. Choose a smaller SVG size in Images settings.`);
  }
  // Draw at the target size: without a viewBox the drawing would be cropped instead of scaled.
  if (!own.viewBox) root.setAttribute('viewBox', `0 0 ${own.width} ${own.height}`);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const svg = new XMLSerializer().serializeToString(doc);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image(width, height);
    img.decoding = 'async';
    img.src = url;
    await Promise.race([
      img.decode(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The SVG took too long to draw.')), 30_000)),
    ]).catch(e => { throw new Error(e instanceof Error && /too long/.test(e.message) ? e.message : 'The browser could not draw this SVG. It may use features it does not support.'); });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new LimitError(`This browser cannot make a ${width} x ${height} canvas. Choose a smaller SVG size.`);
    ctx.drawImage(img, 0, 0, width, height);
    const png = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
    canvas.width = 0;
    if (!png) throw new Error('The drawing could not be turned into pixels.');
    const scaled = width !== Math.round(own.width) || height !== Math.round(own.height);
    if (scaled) warnings.push(`Drawn at ${width} x ${height} pixels; the SVG's own size is ${Math.round(own.width)} x ${Math.round(own.height)}.`);
    warnings.push('Text uses the fonts installed on this device; fonts the SVG links to on the web are not downloaded.');
    return { png, width, height, warnings };
  } finally {
    URL.revokeObjectURL(url);
  }
}
