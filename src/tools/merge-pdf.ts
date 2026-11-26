// The "Merge PDFs" tool: PDFs in the chosen order become one, made by the PDF worker (src/engines/pdf/merge.ts). Each
// file is checked as it is added (the guard, its pages, a digital signature); a signed file has to be accepted before
// the merge, since merging makes its signature invalid. The result says what was kept, renamed and left out.

import type { ToolDefinition, ToolInput } from '../app/tools';
import { formatBytes, LIMITS } from '../core/limits';
import type { DroppedPart, MergeFile, MergeReport } from '../engines/pdf/merge';
import { allowance, inspectPdf, listNames, memoryCheck, plural } from './pdf-common';

export { listNames };

const DROPPED: Record<DroppedPart, (files: string, pages: number) => string> = {
  tags: f => `Accessibility tags are not kept (${f}); screen readers read the merged pages without them.`,
  labels: (f, pages) => `Page labels such as i, ii, iii are not kept (${f}); the merged pages are numbered 1 to ${pages.toLocaleString('en-US')}.`,
  attachments: f => `Files attached to the document are not kept (${f}); attachments placed on a page are.`,
  scripts: f => `Document scripts are not kept (${f}).`,
  threads: f => `Article threads are not kept (${f}).`,
  xfa: f => `XFA form data is not kept (${f}); the regular form fields and their values are.`,
  layerConfigs: f => `Extra layer settings are not kept (${f}); each layer starts shown or hidden as in its file.`,
  portfolio: f => `${f} is a PDF portfolio: only its cover pages are merged, not the files inside it.`,
  openAction: f => `How ${f} opens (its opening action) is not kept.`,
};

/** What the result says: details about what was kept, warnings about what was changed or left out. */
export function describeMerge(r: MergeReport): { note: string; details: string[]; warnings: string[] } {
  const files = r.files;
  const names = (pick: (f: MergeFile) => boolean) => listNames(files.filter(pick).map(f => f.name));
  const details: string[] = [];
  details.push(`Bookmarks: one for each file, with the file's own bookmarks under it (${plural(r.bookmarks, 'bookmark')} in all).`);
  const links = files.reduce((n, f) => n + f.links, 0);
  if (links) details.push(`Links: ${plural(links, 'link')}, each pointing at its page in the merged PDF.`);
  if (r.fields) {
    const renamed = files.filter(f => f.renamed.length);
    details.push(`Form fields: ${plural(r.fields, 'field')} kept with their values.`);
    for (const f of renamed) {
      const list = f.renamed.slice(0, 5).map(x => `${x.from} to ${x.to}`);
      if (f.renamed.length > 5) list.push(`${f.renamed.length - 5} more`);
      details.push(`Renamed in ${f.name}, because an earlier file has fields with the same names: ${listNames(list)}.`);
    }
  }
  const dests = files.reduce((n, f) => n + f.destinationsRenamed, 0);
  if (dests) details.push(`${plural(dests, 'named destination')} renamed, because an earlier file uses the same names; links and bookmarks still go to the right pages.`);
  if (r.layers) details.push(`Layers: ${plural(r.layers, 'layer')}, each shown or hidden as in its file.`);
  if (r.infoFrom) details.push(`Title, author and other document information are from the first file, ${r.infoFrom}.`);

  const warnings: string[] = [];
  const signed = names(f => f.signed);
  if (signed) warnings.push(`The digital ${files.filter(f => f.signed).length === 1 ? 'signature' : 'signatures'} of ${signed} ${files.filter(f => f.signed).length === 1 ? 'is' : 'are'} no longer valid. The signature fields and how they look are kept.`);
  for (const f of files) {
    if (f.unresolved) warnings.push(`${plural(f.unresolved, 'link or bookmark', 'links or bookmarks')} in ${f.name} pointed at a place the file does not have; ${f.unresolved === 1 ? 'it goes' : 'they go'} nowhere now.`);
    if (f.formScripts && f.renamed.length) warnings.push(`The form in ${f.name} has scripts, which may still use the old names of its renamed fields.`);
  }
  for (const part of Object.keys(DROPPED) as DroppedPart[]) {
    const who = names(f => f.dropped.includes(part));
    if (who) warnings.push(DROPPED[part](who, r.pages));
  }
  // A file that asks readers to redraw its fields makes them redraw the other files' fields too.
  const redraw = files.filter(f => f.needAppearances && f.fields > 0);
  if (redraw.length && files.some(f => !f.needAppearances && f.fields > 0)) {
    warnings.push(`${listNames(redraw.map(f => f.name))} ${redraw.length === 1 ? 'asks' : 'ask'} PDF readers to redraw form fields, so readers may redraw the fields of every file.`);
  }
  if (r.clean.formFieldsRemoved) warnings.push(`${plural(r.clean.formFieldsRemoved, 'form field')} with no box on any page ${r.clean.formFieldsRemoved === 1 ? 'was' : 'were'} left out.`);
  return { note: `${plural(r.pages, 'page')} from ${plural(files.length, 'file')}`, details, warnings };
}

export const tool: ToolDefinition = {
  id: 'merge-pdf',
  title: 'Merge PDFs',
  summary: 'Combines PDFs into one, in the order you set, keeping links, bookmarks and form fields.',
  accepts: ['pdf'],
  minInputs: 2,
  maxInputs: LIMITS.pdfMergeFiles,
  ordered: true,
  firstPages: true,
  options: [],
  action: 'Merge PDFs',
  confirmLabel: 'Merge anyway; the signatures will no longer be valid',
  inspect: inspectPdf('Merging'),
  check(inputs: readonly ToolInput[]) {
    const pages = inputs.reduce((n, i) => n + (i.pages ?? 0), 0);
    if (pages > LIMITS.pdfPages) {
      return `Together these files have ${pages.toLocaleString('en-US')} pages; a merged PDF can have up to ${LIMITS.pdfPages.toLocaleString('en-US')}. Merge fewer files at a time.`;
    }
    const bytes = inputs.reduce((n, i) => n + i.file.size, 0);
    if (bytes > LIMITS.pdfMergeBytes) {
      return `Together these files are ${formatBytes(bytes)}; FileConvert merges up to ${formatBytes(LIMITS.pdfMergeBytes)} at a time. Merge fewer files at a time.`;
    }
    return memoryCheck(inputs, {}, 'Together these files need', 'Merge fewer files at a time.');
  },
  async run(inputs, _values, ctx) {
    const r = await ctx.engines.pdf.run<{ bytes: Uint8Array; report: MergeReport }>('merge', {
      files: inputs.map(i => ({ file: i.file, name: i.name })), allowance: allowance(),
    }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
    const d = describeMerge(r.report);
    return {
      outputs: [{ blob, base: 'merged', ext: 'pdf', note: `${d.note}, ${formatBytes(blob.size)}`, details: d.details }],
      warnings: d.warnings,
      summary: d.note,
    };
  },
};
