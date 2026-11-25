// The "Reorder PDF pages" tool: the pages of one PDF in a new order, set by dragging, with Up and Down, or as text.
// Made in place by the page cleanup (src/engines/pdf/structure.ts, keepPages): every page and its content stay; links,
// bookmarks and destinations keep pointing at the same pages, wherever those now are.

import type { ToolDefinition } from '../app/tools';
import { formatBytes } from '../core/limits';
import { safeBase } from '../core/naming';
import { parseOrder } from '../core/pageranges';
import type { CleanReport, SignatureInfo } from '../engines/pdf/structure';
import { allowance, checkWith, describeEdit, inspectPdf, pagesOfInput, plural } from './pdf-common';

export const tool: ToolDefinition = {
  id: 'organize-pdf',
  title: 'Reorder PDF pages',
  summary: 'Puts the pages of a PDF in a new order: drag them, move them with Up and Down, or type the order.',
  accepts: ['pdf'],
  minInputs: 1,
  maxInputs: 1,
  ordered: false,
  options: [
    { kind: 'order', key: 'order', label: 'New page order', value: '',
      hint: 'Each page once, such as 3, 1, 2, 4-10. The list below shows the same order.' },
  ],
  action: 'Reorder the pages',
  confirmLabel: 'Reorder anyway; the signature will no longer be valid',
  inspect: inspectPdf('Reordering its pages'),
  check(inputs, values) {
    return checkWith(n => {
      if (parseOrder(String(values.order), n).every((p, i) => p === i + 1)) throw new Error('The pages are in their first order; move some to reorder them.');
    }, n => ({ listed: n }))(inputs);
  },
  async run(inputs, values, ctx) {
    const input = inputs[0];
    const n = pagesOfInput(inputs);
    const order = parseOrder(String(values.order), n);
    const r = await ctx.engines.pdf.run<{ bytes: Uint8Array; report: CleanReport; signature: SignatureInfo }>('keepPages', { file: input.file, order: order.map(p => p - 1), allowance: allowance() }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
    const d = describeEdit(r.report, r.signature.signed, false);
    const moved = order.filter((p, i) => p !== i + 1).length;
    return {
      outputs: [{ blob, base: `${safeBase(input.name)}-reordered`, ext: 'pdf', note: `${plural(n, 'page')}, ${plural(moved, 'page')} in a new place, ${formatBytes(blob.size)}`, details: d.details }],
      warnings: d.warnings,
      summary: `${plural(moved, 'page')} moved`,
    };
  },
};
