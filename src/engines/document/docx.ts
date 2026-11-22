// DOCX with Mammoth. Mammoth turns the document into simple, well-formed HTML (headings, paragraphs, emphasis,
// lists, tables, links, pictures, footnotes); from that, DOCX to TXT writes plain text here in the worker, and DOCX to
// HTML and Markdown are finished on the page, where the HTML is sanitized first (./markup.ts). The package is checked
// for decompression bombs before Mammoth opens it. Macros and embedded objects are never run. A picture linked to a
// file or web address outside the document is never fetched (Mammoth's external file access stays off), and a style
// map carried inside the document is ignored, so a document cannot choose its own HTML.

import { LIMITS, LimitError } from '../../core/limits';
import { utf8 } from '../../core/text';
import { checkZip, type ZipEntry } from '../../core/zipcheck';
import type { MammothElement, MammothImage } from 'mammoth';

interface Mammoth {
  convertToHtml(input: { arrayBuffer: ArrayBuffer; buffer?: ArrayBuffer }, options?: Record<string, unknown>): Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
  images: { imgElement(f: (image: MammothImage) => Promise<Record<string, string>>): unknown };
  transforms: { paragraph(f: (p: MammothElement) => MammothElement): (doc: unknown) => unknown };
}

const ENTITY = /&(amp|lt|gt|quot|#39|#\d+|#x[0-9a-f]+);/gi;
const decode = (s: string) => s.replace(ENTITY, (_m, e: string) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&';
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'quot') return '"';
  if (k === '#39') return "'";
  const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
});

/** Writes Mammoth's HTML as plain text. Only the handful of elements Mammoth produces are handled. */
export function mammothHtmlToText(html: string): { text: string; images: number } {
  let out = '';
  let images = 0;
  let inCell = 0;
  const lists: Array<{ ordered: boolean; n: number }> = [];
  const endLine = () => { if (inCell) { if (!/[ \t]$/.test(out)) out += ' '; } else if (out && !out.endsWith('\n')) out += '\n'; };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>|([^<]+)/gi)) {
    if (m[4] !== undefined) { out += decode(m[4]); continue; }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    switch (tag) {
      case 'br': out += inCell ? ' ' : '\n'; break;
      case 'img': images++; break;
      case 'p': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': case 'blockquote': case 'pre':
        if (closing) endLine();
        break;
      case 'ul': case 'ol':
        if (closing) lists.pop();
        else { endLine(); lists.push({ ordered: tag === 'ol', n: 0 }); }
        break;
      case 'li':
        if (closing) endLine();
        else {
          const l = lists[lists.length - 1];
          if (l) { l.n++; out += '  '.repeat(lists.length - 1) + (l.ordered ? `${l.n}. ` : '- '); }
        }
        break;
      case 'table': endLine(); break;
      case 'td': case 'th':
        if (closing) { inCell--; out = out.replace(/ +$/, '') + '\t'; } else inCell++;
        break;
      case 'tr':
        if (closing) { out = out.replace(/\t$/, '') + '\n'; }
        break;
    }
  }
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n', images };
}

/**
 * Word, LibreOffice and pandoc styles that mean something HTML has, beyond Mammoth's own defaults (headings, lists,
 * bold, italic, strikethrough, footnotes): titles, quotations, code blocks and code in text, underline, and list
 * levels six to nine.
 */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Block Quotation'] => blockquote > p:fresh",
  "p[style-name='Quotations'] => blockquote > p:fresh",
  "p[style-name='Block Text'] => blockquote > p:fresh",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "p[style-name='Preformatted Text'] => pre:separator('\\n')",
  "p[style-name='Source Code'] => pre:separator('\\n')",
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='FileConvert code block'] => pre:separator('\\n')",
  "r[style-name='HTML Code'] => code",
  "r[style-name='Source Text'] => code",
  "r[style-name='Verbatim Char'] => code",
  "r[style-name='FileConvert code'] => code",
  "r[style-name='Emphasis'] => em",
  'u => u',
  ...[6, 7, 8, 9].flatMap(n => {
    const up = 'ul|ol > li > '.repeat(n - 1);
    return [`p:unordered-list(${n}) => ${up}ul > li:fresh`, `p:ordered-list(${n}) => ${up}ol > li:fresh`];
  }),
].join('\n');

/** Fonts that set code. Text in one of them is code; a paragraph that is all such text is a code block. */
const MONOSPACE = /^(courier( new)?|consolas|menlo|monaco|lucida console|lucida sans typewriter|source code pro|fira (code|mono)|cascadia (code|mono)|dejavu sans mono|liberation mono|roboto mono|jetbrains mono|ubuntu mono|noto sans mono|sf mono|andale mono|inconsolata|ibm plex mono|courier prime|pt mono|oxygen mono|space mono|anonymous pro)$/i;

const isRun = (e: MammothElement) => e.type === 'run';
function runsOf(e: MammothElement): MammothElement[] {
  if (isRun(e)) return [e];
  return (e.children ?? []).flatMap(runsOf);
}
const textOf = (e: MammothElement): string => e.type === 'text' ? String(e.value ?? '') : (e.children ?? []).map(textOf).join('');

/** Marks code by its font: Mammoth maps styles, not fonts, and many documents set code only by choosing a font. */
function codeByFont(p: MammothElement): MammothElement {
  if (p.styleName && /code|preformatted|verbatim|source/i.test(p.styleName)) return p;
  const runs = runsOf(p).filter(r => textOf(r).trim());
  if (!runs.length) return p;
  const mono = (r: MammothElement) => typeof r.font === 'string' && MONOSPACE.test(r.font.trim());
  if (runs.every(mono) && (!p.styleName || /^(normal|body text|default)/i.test(p.styleName))) return { ...p, styleName: 'FileConvert code block' };
  const mark = (e: MammothElement): MammothElement => {
    if (isRun(e)) return mono(e) && !e.styleName ? { ...e, styleName: 'FileConvert code' } : e;
    return e.children ? { ...e, children: e.children.map(mark) } : e;
  };
  return mark(p);
}

/** Picture types every current browser shows. Others (EMF and WMF drawings, TIFF) are kept but do not display. */
const VIEWABLE = /^image\/(png|jpeg|gif|bmp|webp|svg\+xml|avif)$/i;

async function loadMammoth(): Promise<Mammoth> {
  const mod = (await import('mammoth')) as unknown as Mammoth & { default?: Mammoth };
  return mod.default ?? mod;
}

function openDocx(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > LIMITS.docxBytes) throw new LimitError(`The document is larger than ${LIMITS.docxBytes / 1048576} MB, the limit.`);
  const entries = checkZip(bytes, 'document');
  if (!entries.some(e => e.name === 'word/document.xml')) throw new Error('This is not a Word document (word/document.xml is missing).');
  return entries;
}

/** Mammoth's browser build reads arrayBuffer and its Node build (the unit tests) reads buffer. */
const input = (bytes: Uint8Array) => {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return { arrayBuffer: buf, buffer: buf };
};
const macroNote = (entries: ZipEntry[]) => entries.some(e => /^word\/(embeddings|activeX)\//.test(e.name) || e.name === 'word/vbaProject.bin')
  ? ['The document contains macros or embedded objects. They were not opened or run.'] : [];

export async function docxToText(bytes: Uint8Array): Promise<{ bytes: Uint8Array; warnings: string[]; summary: string }> {
  const entries = openDocx(bytes);
  const warnings: string[] = [];
  const mammoth = await loadMammoth();
  let res: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    res = await mammoth.convertToHtml(input(bytes), { includeEmbeddedStyleMap: false, externalFileAccess: false, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  } catch (e) {
    throw new Error(`The document could not be read: ${(e as Error).message}`);
  }
  for (const m of res.messages.slice(0, 3)) if (m.type === 'error') warnings.push(m.message);
  const { text, images } = mammothHtmlToText(res.value);
  if (macroNote(entries).length) warnings.push('The document contains macros or embedded objects. They were not opened or run; only the text was read.');
  if (images) warnings.push(`${images} ${images === 1 ? 'picture is' : 'pictures are'} left out of the plain text.`);
  warnings.push('Each paragraph is one line, list items start with - or a number, and table rows have their cells separated by tabs. Headers, footers and comments are not included.');
  const words = text.split(/\s+/).filter(Boolean).length;
  return { bytes: utf8(text), warnings, summary: `${words.toLocaleString('en-US')} words` };
}

export interface DocxHtml {
  /** Mammoth's HTML, not yet sanitized. */
  html: string;
  warnings: string[];
  pictures: number;
}

/**
 * DOCX to an HTML fragment for DOCX to HTML and DOCX to Markdown. Pictures stored in the document become data URLs;
 * pictures that are only linked are left out and counted.
 */
export async function docxToHtml(bytes: Uint8Array): Promise<DocxHtml> {
  const entries = openDocx(bytes);
  const mammoth = await loadMammoth();
  const warnings: string[] = [];
  let pictures = 0, unviewable = 0, size = 0;
  const convertImage = mammoth.images.imgElement(async image => {
    const type = (image.contentType ?? 'application/octet-stream').toLowerCase();
    const data = await image.read('base64');
    size += Math.floor(data.length * 3 / 4);
    if (size > LIMITS.docxPictureBytes) throw new LimitError(`The document's pictures come to more than ${LIMITS.docxPictureBytes / 1048576} MB, the limit for pictures kept inside one HTML or Markdown file.`);
    pictures++;
    if (!VIEWABLE.test(type)) unviewable++;
    return { src: `data:${type};base64,${data}` };
  });
  let res: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    res = await mammoth.convertToHtml(input(bytes), {
      styleMap: STYLE_MAP,
      includeEmbeddedStyleMap: false,
      externalFileAccess: false,
      convertImage,
      transformDocument: mammoth.transforms.paragraph(codeByFont),
    });
  } catch (e) {
    if (e instanceof LimitError) throw e;
    throw new Error(`The document could not be read: ${(e as Error).message}`);
  }
  const errors = res.messages.filter(m => m.type === 'error');
  const linked = errors.filter(m => /external (image|file)|external file access/i.test(m.message)).length;
  if (linked) warnings.push(`${linked} ${linked === 1 ? 'picture is' : 'pictures are'} only linked from the document, to a file or web address. ${linked === 1 ? 'It was' : 'They were'} not fetched and ${linked === 1 ? 'is' : 'are'} left out.`);
  for (const m of errors.filter(m => !/external (image|file)|external file access/i.test(m.message)).slice(0, 2)) warnings.push(m.message);
  if (unviewable) warnings.push(`${unviewable} ${unviewable === 1 ? 'picture is' : 'pictures are'} a Windows drawing (EMF or WMF) or another kind browsers cannot show; kept, but ${unviewable === 1 ? 'it' : 'they'} will not display.`);
  warnings.push(...macroNote(entries));
  return { html: res.value, warnings, pictures };
}
