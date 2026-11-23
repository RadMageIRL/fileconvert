// What the PDF tools share: the check of each PDF as it is added (pages, a digital signature, the PDF guard in the
// worker), the warning a signed PDF needs before anything changes it, and the wording of what a result kept and lost.

import type { ToolDefinition, ToolInput } from '../app/tools';
import { formatPages, parseRanges, pagesOf } from '../core/pageranges';
import type { DroppedPart, MergeReport } from '../engines/pdf/merge';
import type { CleanReport, SignatureInfo } from '../engines/pdf/structure';

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "a.pdf", "a.pdf and b.pdf", "a.pdf, b.pdf and c.pdf", at most five names. */
export function listNames(names: string[]): string {
  const shown = names.length > 5 ? [...names.slice(0, 4), `${names.length - 4} more`] : names;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? '';
}

/**
 * The check of each PDF as it is added: the guard and the editing library read it in the PDF worker (encrypted,
 * hostile and malformed files are refused with the reason), its pages are counted, and a digitally signed file raises
 * a warning that has to be accepted. `doing` says what the tool does to it: "Merging", "Splitting".
 */
export function inspectPdf(doing: string): NonNullable<ToolDefinition['inspect']> {
  return async (input, ctx) => {
    const r = await ctx.engines.pdf.run<{ pages: number; signature: SignatureInfo }>('inspect', { file: input.file }, { signal: ctx.signal });
    return {
      pages: r.pages,
      info: plural(r.pages, 'page'),
      note: r.signature.signed ? 'Digitally signed.' : undefined,
      confirm: r.signature.signed
        ? `${input.name} is digitally signed. ${doing} changes it, so its signature will no longer be valid: the result keeps the signature field and how it looks, but PDF readers will report the signature as broken.`
        : undefined,
    };
  };
}

/** The pages of the one file a page tool takes, once its check has counted them. */
export function pagesOfInput(inputs: readonly ToolInput[]): number {
  return inputs[0]?.pages ?? 0;
}

/** A tool's check that reads a page selection: the parser's message, or null. */
export function checkWith(read: (n: number) => unknown): (inputs: readonly ToolInput[]) => string | null {
  return inputs => {
    const n = pagesOfInput(inputs);
    if (!n) return 'Checking the file.';
    try { read(n); return null; } catch (e) { return (e as Error).message; }
  };
}

/** Page numbers in a file name, padded to the page count's width so the names sort: p03, p01-04. */
export function pageLabel(from: number, to: number, pages: number): string {
  const w = String(pages).length;
  const pad = (n: number) => String(n).padStart(w, '0');
  return from === to ? `p${pad(from)}` : `p${pad(from)}-${pad(to)}`;
}

export { formatPages, parseRanges, pagesOf };

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
