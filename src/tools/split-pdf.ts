// The "Split a PDF" tool: one PDF becomes several, by page ranges, every N pages, or one file per page. The file is
// read once in the PDF worker; each part is copied from it with only its own pages (src/engines/pdf/merge.ts,
// takePages), so links, bookmarks and form fields stay where their pages are and nothing of the other pages is in it.

import type { ToolDefinition, ToolValues } from '../app/tools';
import { formatBytes } from '../core/limits';
import { safeBase } from '../core/naming';
import { everyN, parseRanges, type PageRange } from '../core/pageranges';
import type { MergeReport } from '../engines/pdf/merge';
import { allowance, checkWith, describeParts, inspectPdf, pageLabel, pagesOfInput, plural } from './pdf-common';

/** The parts the options ask for, as page ranges (1-based). */
export function splitParts(values: ToolValues, pages: number): PageRange[] {
  if (values.mode === 'every') return everyN(pages, Number(values.every));
  if (values.mode === 'each') return everyN(pages, 1);
  return parseRanges(String(values.ranges), pages);
}

export const tool: ToolDefinition = {
  id: 'split-pdf',
  title: 'Split a PDF',
  summary: 'Makes several PDFs from one: by page ranges, every few pages, or one file per page.',
  accepts: ['pdf'],
  minInputs: 1,
  maxInputs: 1,
  ordered: false,
  options: [
    { kind: 'select', key: 'mode', label: 'Split', value: 'ranges', choices: [['ranges', 'By page ranges'], ['every', 'Every few pages'], ['each', 'Into single pages']] },
    { kind: 'text', key: 'ranges', label: 'Page ranges, one file each', value: '', placeholder: '1-3, 4-7, 8-', maxLength: 4000, showIf: { key: 'mode', value: 'ranges' },
      hint: 'Each range becomes one file, in the order written. Ranges may overlap: each file gets its own copy of the pages. Pages in no range are left out.' },
    { kind: 'number', key: 'every', label: 'Pages in each file', value: 2, min: 1, max: 5000, showIf: { key: 'mode', value: 'every' },
      hint: 'The last file has the pages that are left.' },
  ],
  action: 'Split the PDF',
  confirmLabel: 'Split anyway; the signature will no longer be valid',
  inspect: inspectPdf('Splitting'),
  check(inputs, values) {
    return checkWith(n => {
      const parts = splitParts(values, n);
      if (values.mode === 'ranges' && parts.length === 1 && parts[0].from === 1 && parts[0].to === n) throw new Error('That range is the whole PDF; give at least two ranges, or a smaller one.');
    }, n => {
      // Overlapping ranges copy their pages into each file: at least this much more than the PDF itself is written.
      const parts = splitParts(values, n);
      const taken = parts.reduce((k, r) => k + r.to - r.from + 1, 0);
      const bytes = inputs[0]?.file.size ?? 0;
      return {
        outputs: parts.length,
        extraOutput: Math.max(0, Math.round(bytes * (taken / n - 1))),
        needs: parts.length > 1 ? `Splitting it this way makes ${plural(parts.length, 'file')}, which needs` : 'This PDF needs',
        advice: parts.length > 1 ? 'Split it into fewer parts.' : '',
      };
    })(inputs);
  },
  async run(inputs, values, ctx) {
    const input = inputs[0];
    const n = pagesOfInput(inputs);
    const ranges = splitParts(values, n);
    const r = await ctx.engines.pdf.run<{ parts: Array<{ bytes: Uint8Array; report: MergeReport }> }>('split', {
      file: input.file, name: input.name, parts: ranges.map(x => Array.from({ length: x.to - x.from + 1 }, (_, i) => x.from - 1 + i)),
      allowance: allowance(),
    }, { signal: ctx.signal, onProgress: ctx.progress });
    const base = safeBase(input.name);
    const outputs = r.parts.map((p, i) => {
      const blob = new Blob([p.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      const { from, to } = ranges[i];
      return { blob, base: `${base}-${pageLabel(from, to, n)}`, ext: 'pdf', note: `${from === to ? `Page ${from}` : `Pages ${from}-${to}`}, ${formatBytes(blob.size)}` };
    });
    const d = describeParts(r.parts.map(p => p.report));
    return { outputs, warnings: [...d.details, ...d.warnings], summary: `${plural(outputs.length, 'file')} from ${plural(n, 'page')}` };
  },
};
