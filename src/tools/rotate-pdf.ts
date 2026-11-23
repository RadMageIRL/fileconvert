// The "Rotate PDF pages" tool: the pages chosen (or every page) turned by 90 degrees either way or by 180, in place
// (src/engines/pdf/structure.ts, rotatePages). Only each page's rotation changes; readers turn its content, links,
// notes and form fields with it.

import type { ToolDefinition } from '../app/tools';
import { formatBytes } from '../core/limits';
import { safeBase } from '../core/naming';
import { selectPages } from '../core/pageranges';
import type { RotateReport, SignatureInfo } from '../engines/pdf/structure';
import { checkWith, describeEdit, inspectPdf, pagesNote, pagesOfInput, plural } from './pdf-common';

const ALL = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const chosen = (text: unknown, n: number) => (String(text ?? '').trim() ? selectPages(String(text), n) : ALL(n));
const TURN: Record<string, string> = { 90: '90 degrees clockwise', 270: '90 degrees counterclockwise', 180: '180 degrees' };

export const tool: ToolDefinition = {
  id: 'rotate-pdf',
  title: 'Rotate PDF pages',
  summary: 'Turns every page, or the pages you choose, a quarter turn either way or upside down.',
  accepts: ['pdf'],
  minInputs: 1,
  maxInputs: 1,
  ordered: false,
  options: [
    { kind: 'select', key: 'by', label: 'Turn', value: '90', choices: [['90', 'Clockwise, 90 degrees'], ['270', 'Counterclockwise, 90 degrees'], ['180', 'Upside down, 180 degrees']] },
    { kind: 'text', key: 'pages', label: 'Pages to turn', value: '', placeholder: 'Every page', maxLength: 4000,
      hint: 'Leave empty to turn every page, or list pages such as 1, 3-5. Each turn adds to the rotation a page already has.' },
  ],
  action: 'Rotate the pages',
  confirmLabel: 'Rotate anyway; the signature will no longer be valid',
  inspect: inspectPdf('Rotating its pages'),
  check(inputs, values) {
    return checkWith(n => chosen(values.pages, n))(inputs);
  },
  async run(inputs, values, ctx) {
    const input = inputs[0];
    const n = pagesOfInput(inputs);
    const pages = chosen(values.pages, n);
    const by = Number(values.by);
    const r = await ctx.engines.pdf.run<{ bytes: Uint8Array; report: RotateReport; signature: SignatureInfo }>('rotate', { file: input.file, pages: pages.map(p => p - 1), by }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
    const d = describeEdit(r.report.clean, r.signature.signed, false);
    if (r.report.invalid) d.warnings.push(`${plural(r.report.invalid, 'page')} had a rotation that is not a quarter turn, which PDF readers ignore; ${r.report.invalid === 1 ? 'it was' : 'they were'} turned from upright.`);
    const which = pages.length === n ? `All ${plural(n, 'page')}` : pagesNote(pages);
    return {
      outputs: [{ blob, base: `${safeBase(input.name)}-rotated`, ext: 'pdf', note: `${which} turned ${TURN[by]}, ${formatBytes(blob.size)}`, details: d.details }],
      warnings: d.warnings,
      summary: `${plural(pages.length, 'page')} turned`,
    };
  },
};
