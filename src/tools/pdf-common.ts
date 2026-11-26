// What the PDF tools share: the check of each PDF as it is added (pages, a digital signature, the PDF guard in the
// worker), the warning a signed PDF needs before anything changes it, and the wording of what a result kept and lost.

import type { ToolDefinition, ToolInput } from '../app/tools';
import { chosenPages, formatPages, parseRanges, pagesOf } from '../core/pageranges';
import { estimate, estimatePreviews, memoryAllowance, refusal, type MemoryAllowance, type MemoryEngine, type MemoryEstimate, type PdfWork } from '../core/pdfmemory';
import type { DroppedPart, MergeReport } from '../engines/pdf/merge';
import type { MetadataReport } from '../engines/pdf/metadata';
import type { CleanReport, SignatureInfo } from '../engines/pdf/structure';

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "a.pdf", "a.pdf and b.pdf", "a.pdf, b.pdf and c.pdf", at most five names. */
export function listNames(names: string[]): string {
  const shown = names.length > 5 ? [...names.slice(0, 4), `${names.length - 4} more`] : names;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? '';
}

/** What the PDF worker's check of a file finds (src/workers/pdf.worker.ts, inspect). */
export interface PdfInspection {
  pages: number;
  signature: SignatureInfo;
  work: PdfWork;
  sizes?: number[];
  metadata?: MetadataReport;
}

/**
 * The check of each PDF as it is added: the guard and the editing library read it in the PDF worker (encrypted,
 * hostile and malformed files are refused with the reason), its pages are counted, and a digitally signed file raises
 * a warning that has to be accepted. `doing` says what the tool does to it: "Merging", "Splitting"; a tool that only
 * reads the file (`changes: false`) leaves its signature as it is. `sizes` asks for each page's size as shown (tools
 * with page previews), `metadata` for what metadata it holds; `describe` adds to the note under the file.
 */
export function inspectPdf(doing: string, o: { sizes?: boolean; metadata?: boolean; changes?: boolean; describe?: (r: PdfInspection) => string | undefined } = {}): NonNullable<ToolDefinition['inspect']> {
  return async (input, ctx) => {
    const r = await ctx.engines.pdf.run<PdfInspection>('inspect', { file: input.file, allowance: allowance(), sizes: o.sizes, metadata: o.metadata }, { signal: ctx.signal });
    const changes = o.changes !== false;
    const signed = r.signature.signed ? (changes ? 'Digitally signed.' : 'Digitally signed; this tool does not change the file.') : undefined;
    const note = [signed, o.describe?.(r)].filter(Boolean).join(' ') || undefined;
    return {
      pages: r.pages,
      work: r.work,
      sizes: r.sizes,
      info: plural(r.pages, 'page'),
      note,
      confirm: r.signature.signed && changes
        ? `${input.name} is digitally signed. ${doing} changes it, so its signature will no longer be valid: the result keeps the signature field and how it looks, but PDF readers will report the signature as broken.`
        : undefined,
    };
  };
}


/** What one PDF task may use in this browser, read when a task starts (src/core/pdfmemory.ts). Every PDF task in the
 *  worker gets it, since a worker is not told the device's memory. */
export function allowance(): MemoryAllowance {
  return memoryAllowance();
}

/**
 * The memory admission check of a tool, from what each file's check counted: null, or why the tool cannot run. `outputs`
 * is the number of files the tool makes; `extraOutput` the bytes they hold beyond the input (split: overlapping parts
 * each get their own copy of their pages). The worker checks again with what it finds, before it reads or copies.
 */
export function memoryCheck(inputs: readonly ToolInput[], more: { outputs?: number; extraOutput?: number; listed?: number } = {}, needs = 'This PDF needs', advice = ''): string | null {
  const works = inputs.map(i => i.work).filter((w): w is PdfWork => !!w);
  if (!works.length) return null;
  const a = allowance();
  return refusal(withPreviews(estimate(works, 'edit', { ...more, engine: a.engine }), inputs, a.engine), a, needs, adviceWithPreviews(advice, inputs));
}

/**
 * A task's estimate with what the previews of its files may still hold when it runs (src/core/pdfmemory.ts,
 * estimatePreviews): every page grid shown, and the largest first-page picture (Merge PDFs draws one at a time).
 */
export function withPreviews(e: MemoryEstimate, inputs: readonly ToolInput[], engine: MemoryEngine): MemoryEstimate {
  let pages = 0, first = 0;
  for (const i of inputs) {
    if (!i.work || !i.previewing) continue;
    const t = estimatePreviews(i.work, i.previewing, engine).total;
    if (i.previewing === 'pages') pages += t; else first = Math.max(first, t);
  }
  return { total: e.total + pages + first, heap: e.heap };
}

/** The advice of a refusal, saying when the previews were counted. */
export function adviceWithPreviews(advice: string, inputs: readonly ToolInput[]): string {
  const kind = inputs.find(i => i.work && i.previewing)?.previewing;
  if (!kind) return advice;
  return `${advice} This counts the memory ${kind === 'pages' ? 'its page previews' : 'the first-page pictures'} may still hold.`.trim();
}

/** The pages of the one file a page tool takes, once its check has counted them. */
export function pagesOfInput(inputs: readonly ToolInput[]): number {
  return inputs[0]?.pages ?? 0;
}

/** What a page tool's run makes, for its memory check (`memoryCheck`), from the page count. */
export interface MemoryNeed { outputs?: number; extraOutput?: number; listed?: number; needs?: string; advice?: string }

/** A tool's check that reads a page selection: the parser's message, then the memory check, or null. */
export function checkWith(read: (n: number) => unknown, memory: (n: number) => MemoryNeed = () => ({})): (inputs: readonly ToolInput[]) => string | null {
  return inputs => {
    const n = pagesOfInput(inputs);
    if (!n) return 'Checking the file.';
    try { read(n); } catch (e) { return (e as Error).message; }
    const m = memory(n);
    return memoryCheck(inputs, m, m.needs, m.advice);
  };
}

/** Page numbers in a file name, padded to the page count's width so the names sort: p03, p01-04. */
export function pageLabel(from: number, to: number, pages: number): string {
  const w = String(pages).length;
  const pad = (n: number) => String(n).padStart(w, '0');
  return from === to ? `p${pad(from)}` : `p${pad(from)}-${pad(to)}`;
}

export { chosenPages, formatPages, parseRanges, pagesOf };

const DROPPED_NEW: Record<DroppedPart, string> = {
  tags: 'Accessibility tags are not kept; screen readers read the new files without them.',
  labels: 'Page labels such as i, ii, iii are not kept; each new file numbers its pages from 1.',
  attachments: 'Files attached to the document are not kept; attachments placed on a page are.',
  scripts: 'Document scripts are not kept.',
  threads: 'Article threads are not kept.',
  xfa: 'XFA form data is not kept; the regular form fields and their values are.',
  layerConfigs: 'Extra layer settings are not kept; each layer starts shown or hidden as in the file.',
  portfolio: 'The file is a PDF portfolio: only its cover pages are used, not the files inside it.',
  openAction: 'How the file opens (its opening action) is not kept.',
};

/** What new files made of some pages (split, extract) kept and lost, over all of them. */
export function describeParts(reports: MergeReport[]): { details: string[]; warnings: string[] } {
  const sum = (k: 'linksRemoved' | 'bookmarksRemoved' | 'destinationsRemoved' | 'actionsRemoved' | 'unresolved' | 'bookmarks' | 'fields') =>
    reports.reduce((n, r) => n + r.files[0][k], 0);
  const one = reports.length === 1;
  const where = one ? 'pages that are not in it' : 'pages in other files';
  const details: string[] = [];
  const bookmarks = sum('bookmarks'), fields = sum('fields');
  if (bookmarks) details.push(`Bookmarks kept for the pages ${one ? 'it holds' : 'each file holds'} (${plural(bookmarks, 'bookmark')}).`);
  if (fields) details.push(`Form fields on ${one ? 'its' : 'their'} pages kept with their values (${plural(fields, 'field')}).`);
  if (reports.some(r => r.infoFrom)) details.push('Title, author and other document information are kept.');
  const warnings: string[] = [];
  if (reports.some(r => r.files[0].signed)) warnings.push(`The digital signature is no longer valid in the new ${one ? 'file' : 'files'}. The signature field and how it looks are kept where its page is.`);
  const gone = [
    sum('linksRemoved') && plural(sum('linksRemoved'), 'link'),
    sum('bookmarksRemoved') && plural(sum('bookmarksRemoved'), 'bookmark'),
    sum('destinationsRemoved') && plural(sum('destinationsRemoved'), 'named destination'),
    sum('actionsRemoved') && plural(sum('actionsRemoved'), 'other action'),
  ].filter(Boolean) as string[];
  if (gone.length) warnings.push(`Removed because they went only to ${where}: ${listNames(gone)}.`);
  const missing = sum('unresolved');
  if (missing) warnings.push(`${plural(missing, 'link or bookmark', 'links or bookmarks')} pointed at a place the PDF does not have; ${missing === 1 ? 'it goes' : 'they go'} nowhere now.`);
  for (const part of Object.keys(DROPPED_NEW) as DroppedPart[]) if (reports[0]?.files[0].dropped.includes(part)) warnings.push(DROPPED_NEW[part]);
  const orphanFields = reports.reduce((n, r) => n + r.clean.formFieldsRemoved, 0);
  if (orphanFields) warnings.push(`${plural(orphanFields, 'form field')} with no box on ${one ? 'its' : 'their'} pages ${orphanFields === 1 ? 'was' : 'were'} left out.`);
  return { details, warnings };
}

/** What an edit made in place (delete, reorder, rotate) removed or dropped. */
export function describeEdit(c: CleanReport, signed: boolean, removing: boolean): { details: string[]; warnings: string[] } {
  const details: string[] = [];
  const warnings: string[] = [];
  if (signed) warnings.push('The digital signature is no longer valid. The signature field and how it looks are kept.');
  const gone = [
    c.linksRemoved && plural(c.linksRemoved, 'link'),
    c.outlineItemsRemoved && plural(c.outlineItemsRemoved, 'bookmark'),
    c.destinationsRemoved && plural(c.destinationsRemoved, 'named destination'),
    c.formFieldsRemoved && plural(c.formFieldsRemoved, 'form field'),
  ].filter(Boolean) as string[];
  if (gone.length) details.push(`Removed with the pages, since they went only to them: ${listNames(gone)}.`);
  if (c.openActionRemoved) warnings.push('The PDF opened at a removed page; it now opens at its first page.');
  if (c.tagsRemoved) warnings.push('Accessibility tags are not kept: they held the text of the removed pages.');
  if (c.threadsRemoved) warnings.push('Article threads are not kept: they ran through the removed pages.');
  if (c.labelsRemoved) warnings.push('Page labels such as i, ii, iii are not kept, since pages were removed or moved; pages are numbered from 1.');
  if (c.xfaRemoved) warnings.push('XFA form data is not kept; the regular form fields and their values are.');
  if (removing) warnings.push('This removes pages; it is not redaction. The pages that stay, the document information and any attachments are not searched or changed.');
  return { details, warnings };
}

/** Pages in a list of 1-based numbers, as a short note: "Pages 1-3, 7". */
export function pagesNote(list: readonly number[]): string {
  return `${list.length === 1 ? 'Page' : 'Pages'} ${formatPages(list)}`;
}
