// TXT to PDF. Plain text keeps its layout only in a monospaced font, so lines are set in Noto Sans Mono,
// tabs are expanded to the next multiple of the tab width, long lines wrap at the page edge, and form feeds
// start a new page.

import { LIMITS, LimitError } from '../../core/limits';
import { decodeText, normalizeNewlines } from '../../core/text';
import { missingIn, renderPdf } from './pdfwrite';

export interface PageOptions {
  pageSize: 'LETTER' | 'A4';
  fontSize: number;
}

const PAGE = { LETTER: [612, 792], A4: [595.28, 841.89] } as const;
const MARGIN = 54; // three quarters of an inch
const MONO_ADVANCE = 0.6; // Noto Sans Mono: 600 units per em

export function expandTabs(line: string, width = 8): string {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(width - (out.length % width));
    else out += ch;
  }
  return out;
}

/** Splits a line into pieces of at most `cols` characters, by code point, so no surrogate pair is cut. */
export function wrapColumns(line: string, cols: number): string[] {
  const chars = [...line];
  if (chars.length <= cols) return [line];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += cols) parts.push(chars.slice(i, i + cols).join(''));
  return parts;
}

export async function textToPdf(bytes: Uint8Array, o: PageOptions, title: string): Promise<{ bytes: Uint8Array; warnings: string[]; summary: string }> {
  if (bytes.length > LIMITS.textToPdfBytes) throw new LimitError(`The text file is larger than ${LIMITS.textToPdfBytes / 1048576} MB, the limit for PDF output (that would be thousands of pages).`);
  const warnings: string[] = [];
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const text = normalizeNewlines(dec.text);
  const [pw] = PAGE[o.pageSize];
  const cols = Math.floor((pw - 2 * MARGIN) / (o.fontSize * MONO_ADVANCE));
  const pages = text.split('\f');
  let wrapped = 0, lineCount = 0;
  const content: unknown[] = [];
  pages.forEach((page, pi) => {
    const lines: string[] = [];
    for (const raw of page.split('\n')) {
      const pieces = wrapColumns(expandTabs(raw), cols);
      if (pieces.length > 1) wrapped++;
      lines.push(...pieces);
    }
    if (pi === pages.length - 1 && lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    lineCount += lines.length;
    // Chunks of lines keep pdfmake's work per node small; each chunk can still break across pages.
    for (let i = 0; i < lines.length; i += 50) {
      const chunk = lines.slice(i, i + 50).map(l => l === '' ? ' ' : l).join('\n');
      content.push({ text: chunk, preserveLeadingSpaces: true, pageBreak: pi > 0 && i === 0 ? 'before' : undefined });
    }
    if (lines.length === 0) content.push({ text: ' ', pageBreak: pi > 0 ? 'before' : undefined });
  });
  if (wrapped) warnings.push(`${wrapped.toLocaleString('en-US')} long ${wrapped === 1 ? 'line was' : 'lines were'} wrapped at ${cols} characters to fit the page.`);
  const missing = await missingIn(text, 'NotoSansMono-Regular.ttf');
  if (missing.count) warnings.push(`${missing.count.toLocaleString('en-US')} ${missing.count === 1 ? 'character is' : 'characters are'} not in the PDF font and will not show (for example ${missing.examples.join(' ')}). The font covers Latin, Greek and Cyrillic.`);
  const pdf = await renderPdf({
    pageSize: o.pageSize,
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
    content,
    defaultStyle: { font: 'NotoSansMono', fontSize: o.fontSize, lineHeight: 1.2 },
    info: { title },
  }, ['NotoSansMono-Regular.ttf']);
  return { bytes: pdf, warnings, summary: `${lineCount.toLocaleString('en-US')} lines` };
}
