// DOCX to TXT with Mammoth. Mammoth turns the document into simple, well-formed HTML (paragraphs, headings,
// line breaks, lists, tables), which is then written out as text: one line per paragraph, line breaks kept,
// list items marked, and table rows as tab-separated cells. The package is checked for decompression bombs
// first. Macros and embedded objects are never run, and pictures are not even decoded.

import { LIMITS, LimitError } from '../../core/limits';
import { utf8 } from '../../core/text';
import { checkZip } from '../../core/zipcheck';

interface Mammoth {
  convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>): Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
  images: { imgElement(f: (image: unknown) => Promise<Record<string, string>>): unknown };
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
      case 'p': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': case 'blockquote':
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

export async function docxToText(bytes: Uint8Array): Promise<{ bytes: Uint8Array; warnings: string[]; summary: string }> {
  if (bytes.length > LIMITS.docxBytes) throw new LimitError(`The document is larger than ${LIMITS.docxBytes / 1048576} MB, the limit.`);
  const entries = checkZip(bytes, 'document');
  if (!entries.some(e => e.name === 'word/document.xml')) throw new Error('This is not a Word document (word/document.xml is missing).');
  const warnings: string[] = [];
  const mod = (await import('mammoth')) as unknown as Mammoth & { default?: Mammoth };
  const mammoth = mod.default ?? mod;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let res: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    res = await mammoth.convertToHtml({ arrayBuffer: buf }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  } catch (e) {
    throw new Error(`The document could not be read: ${(e as Error).message}`);
  }
  for (const m of res.messages.slice(0, 3)) if (m.type === 'error') warnings.push(m.message);
  const { text, images } = mammothHtmlToText(res.value);
  if (entries.some(e => /^word\/(embeddings|activeX)\//.test(e.name) || e.name === 'word/vbaProject.bin')) {
    warnings.push('The document contains macros or embedded objects. They were not opened or run; only the text was read.');
  }
  if (images) warnings.push(`${images} ${images === 1 ? 'picture is' : 'pictures are'} left out of the plain text.`);
  warnings.push('Each paragraph is one line, list items start with - or a number, and table rows have their cells separated by tabs. Headers, footers and comments are not included.');
  const words = text.split(/\s+/).filter(Boolean).length;
  return { bytes: utf8(text), warnings, summary: `${words.toLocaleString('en-US')} words` };
}
