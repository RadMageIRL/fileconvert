// The "Extract pages from a PDF" tool: the pages chosen, in the order written, become a new PDF. The same copy as a
// split part (src/engines/pdf/merge.ts, takePages): nothing of the other pages is in it.

import type { ToolDefinition } from '../app/tools';
import { formatBytes } from '../core/limits';
import { safeBase } from '../core/naming';
import { selectPages } from '../core/pageranges';
import type { MergeReport } from '../engines/pdf/merge';
import { checkWith, describeParts, inspectPdf, pagesNote, pagesOfInput, plural } from './pdf-common';

export const tool: ToolDefinition = {
  id: 'extract-pdf-pages',
  title: 'Extract pages from a PDF',
  summary: 'Makes a new PDF from the pages you choose, in the order you list them.',
  accepts: ['pdf'],
  minInputs: 1,
  maxInputs: 1,
  ordered: false,
  options: [
    { kind: 'text', key: 'pages', label: 'Pages to extract', value: '', placeholder: '1-3, 7, 10-', maxLength: 4000,
      hint: 'In the order you list them; each page once. 10- means page 10 to the end.' },
  ],
  action: 'Extract the pages',
  confirmLabel: 'Extract anyway; the signature will no longer be valid',
  inspect: inspectPdf('Extracting pages'),
  check(inputs, values) {
    return checkWith(n => selectPages(String(values.pages), n))(inputs);
  },
  async run(inputs, values, ctx) {
    const input = inputs[0];
    const n = pagesOfInput(inputs);
    const pages = selectPages(String(values.pages), n);
    const r = await ctx.engines.pdf.run<{ parts: Array<{ bytes: Uint8Array; report: MergeReport }> }>('split', {
      file: input.file, name: input.name, parts: [pages.map(p => p - 1)],
    }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.parts[0].bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
    const d = describeParts([r.parts[0].report]);
    return {
      outputs: [{ blob, base: `${safeBase(input.name)}-extracted`, ext: 'pdf', note: `${pagesNote(pages)}, ${formatBytes(blob.size)}`, details: d.details }],
      warnings: d.warnings,
      summary: `${plural(pages.length, 'page')} of ${plural(n, 'page')}`,
    };
  },
};
