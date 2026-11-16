// Markdown and HTML, on the page (they need a DOM). Markdown is rendered by markdown-it with inline HTML
// allowed, then everything is sanitized by DOMPurify: scripts, event handlers, forms, frames, embedded
// objects and javascript: links are removed before anything else sees the markup. Parsing happens in inert
// documents, so nothing in a file can run or load while it is converted.
//
// For PDF output, html-to-pdfmake turns the clean markup into a pdfmake document: headings, paragraphs,
// emphasis, lists, tables, block quotes, code, links and embedded PNG or JPEG pictures. It does not apply
// stylesheets or page layout CSS, and it never fetches remote images; those become their alt text.

import DOMPurify from 'dompurify';
import htmlToPdfmake from 'html-to-pdfmake';
import MarkdownIt from 'markdown-it';
import { LIMITS, LimitError } from '../../core/limits';
import { decodeText, normalizeNewlines, utf8 } from '../../core/text';
import { fontsFor } from './pdfwrite';
import type { FontFile } from './fonts';

const FORBID_TAGS = ['style', 'form', 'input', 'button', 'select', 'textarea', 'option', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math', 'template', 'audio', 'video', 'source', 'track', 'canvas', 'noscript'];

function purifier(forPdf: boolean, counts: { images: number; removed: number }) {
  const p = DOMPurify(window);
  p.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'script' || FORBID_TAGS.includes(data.tagName)) counts.removed++;
    void node;
  });
  p.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName.startsWith('on')) counts.removed++;
  });
  if (forPdf) {
    p.addHook('afterSanitizeAttributes', node => {
      if (node.nodeName !== 'IMG') return;
      const src = node.getAttribute('src') ?? '';
      if (/^data:image\/(png|jpe?g);base64,/i.test(src)) return;
      counts.images++;
      const alt = node.getAttribute('alt')?.trim();
      const span = node.ownerDocument.createElement('span');
      span.textContent = alt ? `[Image: ${alt}]` : '[Image]';
      node.replaceWith(span);
    });
  }
  return p;
}

function sanitize(html: string, forPdf: boolean, counts: { images: number; removed: number }): string {
  return purifier(forPdf, counts).sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR: forPdf ? ['srcset'] : ['style', 'srcset'],
    ALLOW_DATA_ATTR: false,
  }) as string;
}

const md = () => new MarkdownIt({ html: true, linkify: true, typographer: false });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function readMarkup(bytes: Uint8Array, warnings: string[]): string {
  if (bytes.length > LIMITS.markupBytes) throw new LimitError(`The file is larger than ${LIMITS.markupBytes / 1048576} MB, the limit for Markdown and HTML.`);
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  return normalizeNewlines(dec.text);
}

function firstHeading(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector('h1')?.textContent?.trim() || null;
}

const PAGE_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2430; background: #fff; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 .5em; }
pre, code { font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; font-size: .92em; }
pre { background: #f3f5f8; padding: .8rem 1rem; overflow-x: auto; border-radius: 6px; }
:not(pre) > code { background: #f3f5f8; padding: .1em .3em; border-radius: 4px; }
blockquote { margin: 1em 0; padding: 0 1em; border-left: 4px solid #c8d1dc; color: #4a5566; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #c8d1dc; padding: .35em .7em; text-align: left; }
img { max-width: 100%; height: auto; }
a { color: #1a5fb4; }
@media (prefers-color-scheme: dark) {
  body { color: #e6ebf2; background: #12161d; }
  pre, :not(pre) > code { background: #1e2530; }
  blockquote { border-color: #3a4656; color: #aab4c3; }
  th, td { border-color: #3a4656; }
  a { color: #7db4ff; }
}
`.trim();

export function markdownToHtml(bytes: Uint8Array, baseName: string): { bytes: Uint8Array; warnings: string[]; summary: string } {
  const warnings: string[] = [];
  const text = readMarkup(bytes, warnings);
  const counts = { images: 0, removed: 0 };
  const body = sanitize(md().render(text), false, counts);
  const title = firstHeading(body) ?? baseName;
  if (counts.removed) warnings.push(`Removed ${counts.removed} unsafe ${counts.removed === 1 ? 'item' : 'items'} (scripts, event handlers, forms, frames or embedded objects) from the inline HTML.`);
  const page = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>\n${PAGE_CSS}\n</style>`,
    '</head>',
    '<body>',
    '<main>',
    body.trim(),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { bytes: utf8(page), warnings, summary: 'Standalone HTML page' };
}

export interface PdfDocRequest {
  doc: Record<string, unknown>;
  fonts: FontFile[];
  text: string;
  warnings: string[];
}

const PAGE = { LETTER: [612, 792], A4: [595.28, 841.89] } as const;
const MARGIN = 54;

/** Walks the pdfmake content, sizing pictures to the page and dropping fonts pdfmake does not have. */
function tidy(node: unknown, contentWidth: number): void {
  if (Array.isArray(node)) { for (const n of node) tidy(n, contentWidth); return; }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (typeof o.font === 'string' && o.font !== 'NotoSans' && o.font !== 'NotoSansMono') delete o.font;
  if (typeof o.image === 'string') {
    const w = typeof o.width === 'number' ? o.width : undefined;
    if (!w || w > contentWidth) { delete o.width; delete o.height; o.fit = [contentWidth, contentWidth * 1.3]; }
  }
  for (const k of ['stack', 'ul', 'ol', 'text', 'columns']) if (o[k] && typeof o[k] === 'object') tidy(o[k], contentWidth);
  const table = o.table as { body?: unknown[][] } | undefined;
  if (table?.body) for (const row of table.body) tidy(row, contentWidth);
}

export function markupToPdfDoc(bytes: Uint8Array, kind: 'md' | 'html', baseName: string, pageSize: 'LETTER' | 'A4'): PdfDocRequest {
  const warnings: string[] = [];
  const text = readMarkup(bytes, warnings);
  const counts = { images: 0, removed: 0 };
  let html: string;
  let title: string | null = null;
  if (kind === 'md') {
    html = md().render(text);
  } else {
    const parsed = new DOMParser().parseFromString(text, 'text/html');
    title = parsed.title?.trim() || null;
    if (parsed.querySelector('link[rel~="stylesheet"], style')) warnings.push('Stylesheets are not applied; the PDF shows the document structure in a clean default style.');
    html = parsed.body?.innerHTML ?? text;
  }
  const clean = sanitize(html, true, counts);
  title = title ?? firstHeading(clean) ?? baseName;
  if (counts.removed) warnings.push(`Removed ${counts.removed} unsafe ${counts.removed === 1 ? 'item' : 'items'} (scripts, event handlers, forms, frames or embedded objects).`);
  if (counts.images) warnings.push(`${counts.images} ${counts.images === 1 ? 'picture was' : 'pictures were'} replaced by ${counts.images === 1 ? 'its' : 'their'} description: only PNG and JPEG pictures embedded in the file are included, and nothing is downloaded.`);
  const [pw] = PAGE[pageSize];
  const contentWidth = pw - 2 * MARGIN;
  const content = htmlToPdfmake(clean, {
    window,
    removeExtraBlanks: true,
    tableAutoSize: true,
    defaultStyles: {
      h1: { fontSize: 22, bold: true, marginBottom: 8, marginTop: 6 },
      h2: { fontSize: 17, bold: true, marginBottom: 6, marginTop: 12 },
      h3: { fontSize: 14, bold: true, marginBottom: 5, marginTop: 10 },
      h4: { fontSize: 12, bold: true, marginBottom: 4, marginTop: 8 },
      h5: { fontSize: 11, bold: true, marginBottom: 4, marginTop: 8 },
      h6: { fontSize: 10, bold: true, marginBottom: 4, marginTop: 8 },
      p: { margin: [0, 4, 0, 6] },
      a: { color: '#1a5fb4', decoration: 'underline' },
      pre: { font: 'NotoSansMono', fontSize: 9, preserveLeadingSpaces: true, background: '#f1f3f6', margin: [0, 4, 0, 8] },
      code: { font: 'NotoSansMono', fontSize: 9.5, background: '#f1f3f6' },
      blockquote: { italics: true, color: '#4a5566', margin: [14, 4, 0, 6] },
      th: { bold: true, fillColor: '#eef1f5' },
      table: { marginBottom: 8 },
    },
  });
  tidy(content, contentWidth);
  const plain = new DOMParser().parseFromString(clean, 'text/html').body.textContent ?? '';
  const usesMono = /<(pre|code|kbd|samp|tt)[\s>]/i.test(clean);
  return {
    doc: {
      pageSize,
      pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
      content,
      defaultStyle: { font: 'NotoSans', fontSize: 11, lineHeight: 1.25 },
      info: { title },
    },
    fonts: fontsFor(usesMono, true),
    text: plain,
    warnings,
  };
}
