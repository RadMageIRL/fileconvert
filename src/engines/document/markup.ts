// Markdown and HTML, on the page (they need a DOM). Markdown is rendered by markdown-it with inline HTML allowed;
// HTML files and Mammoth's HTML for a DOCX are parsed as they are. Everything is then sanitized by DOMPurify:
// scripts, event handlers, forms, frames, embedded objects and javascript: links are removed before anything else
// sees the markup. Parsing happens in inert documents, so nothing in a file can run or load while it is converted,
// and no conversion fetches anything: pictures from the web stay addresses (Markdown) or become their description
// (PDF, DOCX).
//
// For PDF output, html-to-pdfmake turns the clean markup into a pdfmake document. For Markdown output, Turndown with
// the GitHub-flavored Markdown plugin writes headings, emphasis, lists, links, pictures, tables and code. For DOCX
// output, the clean HTML goes to the document worker, where the docx library writes the Word document
// (./docxwrite.ts).

import DOMPurify from 'dompurify';
import htmlToPdfmake from 'html-to-pdfmake';
import MarkdownIt from 'markdown-it';
import { LIMITS, LimitError } from '../../core/limits';
import { decodeText, normalizeNewlines, utf8 } from '../../core/text';
import { fontsFor } from './pdfwrite';
import type { FontFile } from './fonts';

const FORBID_TAGS = ['style', 'form', 'input', 'button', 'select', 'textarea', 'option', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math', 'template', 'audio', 'video', 'source', 'track', 'canvas', 'noscript'];

/** What to do with each picture: keep it, or put its description in its place. */
type PicturePolicy = (src: string) => 'keep' | 'describe';

interface Counts { removed: number; described: number; remote: number; kept: number }
const newCounts = (): Counts => ({ removed: 0, described: 0, remote: 0, kept: 0 });

function purifier(pictures: PicturePolicy, counts: Counts) {
  const p = DOMPurify(window);
  p.addHook('uponSanitizeElement', (_node, data) => {
    if (data.tagName === 'script' || FORBID_TAGS.includes(data.tagName)) counts.removed++;
  });
  p.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName.startsWith('on')) counts.removed++;
  });
  p.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName !== 'IMG') return;
    const src = node.getAttribute('src') ?? '';
    if (!/^data:/i.test(src)) counts.remote++;
    if (pictures(src) === 'keep') { counts.kept++; return; }
    counts.described++;
    const alt = node.getAttribute('alt')?.trim();
    const span = node.ownerDocument.createElement('span');
    span.textContent = alt ? `[Image: ${alt}]` : '[Image]';
    node.replaceWith(span);
  });
  return p;
}

function sanitize(html: string, pictures: PicturePolicy, counts: Counts, keepStyle = false): string {
  return purifier(pictures, counts).sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    // The labels and choices of form controls are not document text.
    ADD_FORBID_CONTENTS: ['button', 'select', 'option', 'datalist', 'textarea'],
    FORBID_ATTR: keepStyle ? ['srcset'] : ['style', 'srcset'],
    ALLOW_DATA_ATTR: false,
  }) as string;
}

const removedNote = (counts: Counts, where = '') => counts.removed
  ? [`Removed ${counts.removed} unsafe ${counts.removed === 1 ? 'item' : 'items'} (scripts, event handlers, forms, frames or embedded objects)${where}.`] : [];

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
th, td { border: 1px solid #c8d1dc; padding: .35em .7em; text-align: left; vertical-align: top; }
td p, th p { margin: 0; }
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

/**
 * A standalone page around clean markup. Its own security policy lets it run nothing and load only pictures:
 * from inside the file (data URLs), and, for Markdown that names web pictures, from the web when it is opened.
 */
function htmlPage(body: string, title: string, webPictures: boolean): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:${webPictures ? ' https: http:' : ''}; style-src 'unsafe-inline'">`,
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
}

export function markdownToHtml(bytes: Uint8Array, baseName: string): { bytes: Uint8Array; warnings: string[]; summary: string } {
  const warnings: string[] = [];
  const text = readMarkup(bytes, warnings);
  const counts = newCounts();
  const body = sanitize(md().render(text), () => 'keep', counts);
  const title = firstHeading(body) ?? baseName;
  warnings.push(...removedNote(counts, ' from the inline HTML'));
  return { bytes: utf8(htmlPage(body, title, true)), warnings, summary: 'Standalone HTML page' };
}

// ------------------------------------------------------------------ Markdown output (Turndown)

export type MarkdownPictures = 'embed' | 'describe';

interface Turndown { turndown(html: string | Node): string }

async function turndown(): Promise<Turndown> {
  const [{ default: TurndownService }, { gfm }] = await Promise.all([import('turndown'), import('@joplin/turndown-plugin-gfm')]);
  const t = new TurndownService({
    headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced', fence: '```',
    emDelimiter: '*', strongDelimiter: '**', linkStyle: 'inlined',
    // A backslash before the line end is CommonMark's hard break; two trailing spaces are lost by many editors.
    br: '\\',
  });
  t.use(gfm);
  // Markdown has no subscript or superscript; GitHub and most renderers accept these two tags as they are.
  t.keep(['sub', 'sup']);
  return t;
}

/**
 * Every pre as one code element holding all its text, with the code's language kept. Turndown fences a pre only when
 * its first child is code, and then writes that child's text alone; Mammoth writes code blocks with no code element,
 * LibreOffice's with one per line, and highlighted HTML code with spans.
 */
function codeBlocks(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  for (const pre of doc.querySelectorAll('pre')) {
    const lang = [...pre.querySelectorAll('code')].map(c => /\blanguage-[\w+#.-]+/.exec(c.className)?.[0]).find(Boolean);
    for (const br of pre.querySelectorAll('br')) br.replaceWith('\n');
    const code = doc.createElement('code');
    if (lang) code.className = lang;
    code.textContent = pre.textContent ?? '';
    pre.replaceChildren(code);
  }
  return doc.body;
}

/** Clean HTML to Markdown, with notes on what Markdown cannot hold. */
async function writeMarkdown(clean: string, warnings: string[]): Promise<{ bytes: Uint8Array; summary: string }> {
  const t = await turndown();
  // The GFM plugin wraps the tables it keeps as HTML in a wrapper of the editor it was written for.
  let out = t.turndown(codeBlocks(clean)).replace(/<div class="joplin-table-wrapper">\s*(<table[\s\S]*?<\/table>)\s*<\/div>/g, '$1');
  const htmlTables = (out.match(/<table[\s>]/g) ?? []).length;
  if (htmlTables) warnings.push(`${htmlTables} ${htmlTables === 1 ? 'table holds' : 'tables hold'} lists, headings, code or quotes in ${htmlTables === 1 ? 'its' : 'their'} cells, which Markdown tables cannot, so ${htmlTables === 1 ? 'it stays' : 'they stay'} as HTML inside the Markdown.`);
  out = out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const words = out.split(/\s+/).filter(Boolean).length;
  return { bytes: utf8(out), summary: `${words.toLocaleString('en-US')} words` };
}

const markdownPictures = (mode: MarkdownPictures): PicturePolicy => src => mode === 'describe' && /^data:/i.test(src) ? 'describe' : 'keep';

function pictureNotes(counts: Counts, mode: MarkdownPictures, warnings: string[]): void {
  if (counts.described) warnings.push(`${counts.described} ${counts.described === 1 ? 'picture was' : 'pictures were'} replaced by ${counts.described === 1 ? 'its' : 'their'} description, as chosen in Documents settings.`);
  else if (counts.kept - counts.remote > 0 && mode === 'embed') warnings.push(`${counts.kept - counts.remote} ${counts.kept - counts.remote === 1 ? 'picture is' : 'pictures are'} kept inside the Markdown as data URLs, so the file stands alone; some Markdown viewers, such as GitHub, do not show those. Documents settings can put a description in place of each instead.`);
  if (counts.remote) warnings.push(`${counts.remote} ${counts.remote === 1 ? 'picture is' : 'pictures are'} referred to by ${counts.remote === 1 ? 'its' : 'their'} web or relative address, as in the original; nothing was downloaded.`);
}

/** HTML file to Markdown. The page body is converted whole; head contents (title, styles, scripts) are not body text. */
export async function htmlToMarkdown(bytes: Uint8Array, mode: MarkdownPictures): Promise<{ bytes: Uint8Array; warnings: string[]; summary: string }> {
  const warnings: string[] = [];
  const text = readMarkup(bytes, warnings);
  const parsed = new DOMParser().parseFromString(text, 'text/html');
  if (parsed.querySelector('link[rel~="stylesheet"], style, [style]')) warnings.push('Styles (fonts, colors, layout) are not part of Markdown; the structure and text are kept.');
  const counts = newCounts();
  const clean = sanitize(parsed.body?.innerHTML ?? text, markdownPictures(mode), counts);
  warnings.push(...removedNote(counts));
  pictureNotes(counts, mode, warnings);
  const r = await writeMarkdown(clean, warnings);
  return { ...r, warnings };
}

// ------------------------------------------------------------------ DOCX to HTML and Markdown (Mammoth's HTML from the worker)

export function docxHtmlToPage(fragment: string, baseName: string, workerNotes: string[]): { bytes: Uint8Array; warnings: string[]; summary: string } {
  const warnings = [...workerNotes];
  const counts = newCounts();
  const body = sanitize(fragment, src => /^data:/i.test(src) ? 'keep' : 'describe', counts);
  warnings.push(...removedNote(counts));
  warnings.push('Headings, paragraphs, lists, tables, links, footnotes, bold, italic, underline, strikethrough, subscript, superscript and pictures are kept. Fonts, colors, sizes, alignment, page layout, headers and footers, comments and tracked changes are not.');
  return { bytes: utf8(htmlPage(body, firstHeading(body) ?? baseName, false)), warnings, summary: 'Standalone HTML page' };
}

export async function docxHtmlToMarkdown(fragment: string, mode: MarkdownPictures, workerNotes: string[]): Promise<{ bytes: Uint8Array; warnings: string[]; summary: string }> {
  const warnings = [...workerNotes];
  const counts = newCounts();
  const clean = sanitize(fragment, markdownPictures(mode), counts);
  warnings.push(...removedNote(counts));
  pictureNotes(counts, mode, warnings);
  warnings.push('Headings, paragraphs, lists, tables, links, bold, italic, strikethrough, code, quotes, footnotes and pictures are kept. Underline, fonts, colors, alignment, page layout, headers and footers, comments and tracked changes are not.');
  const r = await writeMarkdown(clean, warnings);
  return { ...r, warnings };
}

// ------------------------------------------------------------------ Markdown to DOCX (the clean HTML goes to the worker)

export interface DocxRequest { html: string; title: string; warnings: string[] }

/** Pictures Word shows that a Markdown file can carry inside itself. */
const WORD_PICTURE = /^data:image\/(png|jpe?g|gif|bmp);base64,/i;

export function markdownToDocxRequest(bytes: Uint8Array, baseName: string): DocxRequest {
  const warnings: string[] = [];
  const text = readMarkup(bytes, warnings);
  const counts = newCounts();
  const html = sanitize(md().render(text), src => WORD_PICTURE.test(src) ? 'keep' : 'describe', counts);
  warnings.push(...removedNote(counts, ' from the inline HTML'));
  const web = counts.remote, other = counts.described - counts.remote;
  if (web) warnings.push(`${web} ${web === 1 ? 'picture from the web or a relative address became its' : 'pictures from the web or relative addresses became their'} description; nothing is downloaded.`);
  if (other) warnings.push(`${other} ${other === 1 ? 'picture in a format Word cannot show became its' : 'pictures in formats Word cannot show became their'} description. PNG, JPEG, GIF and BMP pictures inside the Markdown are included.`);
  return { html, title: firstHeading(html) ?? baseName, warnings };
}

// ------------------------------------------------------------------ PDF output

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
  const counts = newCounts();
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
  const clean = sanitize(html, src => /^data:image\/(png|jpe?g);base64,/i.test(src) ? 'keep' : 'describe', counts, true);
  title = title ?? firstHeading(clean) ?? baseName;
  warnings.push(...removedNote(counts));
  if (counts.described) warnings.push(`${counts.described} ${counts.described === 1 ? 'picture was' : 'pictures were'} replaced by ${counts.described === 1 ? 'its' : 'their'} description: only PNG and JPEG pictures embedded in the file are included, and nothing is downloaded.`);
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
