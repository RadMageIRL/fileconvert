// The "Delete pages from a PDF" tool: the PDF without the pages chosen, made in place by the page cleanup
// (src/engines/pdf/structure.ts, keepPages), which leaves nothing of the removed pages in the file. It is not redaction.

import type { ToolDefinition } from '../app/tools';
import { formatBytes } from '../core/limits';
import { safeBase } from '../core/naming';
import { selectPages } from '../core/pageranges';
import type { CleanReport, SignatureInfo } from '../engines/pdf/structure';
import { allowance, checkWith, describeEdit, inspectPdf, pagesNote, pagesOfInput, plural } from './pdf-common';

export const tool: ToolDefinition = {
  id: 'delete-pdf-pages',
  title: 'Delete pages from a PDF',
  summary: 'Removes the pages you choose and leaves nothing of them in the file.',
  accepts: ['pdf'],
  minInputs: 1,
  maxInputs: 1,
  ordered: false,
  options: [
    { kind: 'text', key: 'pages', label: 'Pages to delete', value: '', placeholder: '2, 5-6', maxLength: 4000,
      hint: 'Each page once; 10- means page 10 to the end. At least one page has to stay. This is not redaction.' },
  ],
  action: 'Delete the pages',
  confirmLabel: 'Delete anyway; the signature will no longer be valid',
  inspect: inspectPdf('Deleting pages'),
  check(inputs, values) {
    return checkWith(n => {
      if (selectPages(String(values.pages), n).length === n) throw new Error('That is every page; at least one page has to stay.');
    })(inputs);
  },
  async run(inputs, values, ctx) {
    const input = inputs[0];
    const n = pagesOfInput(inputs);
    const removed = new Set(selectPages(String(values.pages), n));
    const order = Array.from({ length: n }, (_, i) => i).filter(i => !removed.has(i + 1));
    const r = await ctx.engines.pdf.run<{ bytes: Uint8Array; report: CleanReport; signature: SignatureInfo }>('keepPages', { file: input.file, order, allowance: allowance() }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
    const d = describeEdit(r.report, r.signature.signed, true);
    return {
      outputs: [{ blob, base: `${safeBase(input.name)}-pages-removed`, ext: 'pdf', note: `${pagesNote([...removed].sort((a, b) => a - b))} removed, ${plural(order.length, 'page')} left, ${formatBytes(blob.size)}`, details: d.details }],
      warnings: d.warnings,
      summary: `${plural(removed.size, 'page')} removed`,
    };
  },
};
