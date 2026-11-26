// The "Compress PNG" tool: lossless recompression with oxipng in the image worker (src/engines/image/pngopt.ts). Every
// pixel, transparency, and every frame of an animated PNG stay exactly as they were, checked on each file; the result is
// the original when nothing smaller comes out. Metadata stays unless removal is chosen.

import type { ToolDefinition } from '../app/tools';
import { LIMITS } from '../core/limits';
import { choiceLabel, inspectPicture, memoryCheck, METADATA, plural, runOptimize } from './optimize-common';

const EFFORT = [['2', 'Standard (fast)'], ['4', 'Thorough (slower; can help screenshots and drawings)'], ['6', 'Most (much slower)']] as const;

export const tool: ToolDefinition = {
  id: 'compress-png',
  title: 'Compress PNG',
  summary: 'Makes PNG files smaller without changing a pixel: better filters and compression, and a smaller way to store the same colors where there is one.',
  accepts: ['png'],
  minInputs: 1,
  maxInputs: LIMITS.imageOptFiles,
  ordered: false,
  options: [
    { kind: 'select', key: 'effort', label: 'Effort', value: '2', choices: EFFORT, hint: 'Standard suits most pictures. Thorough tries more ways to compress, which helps flat colors most.' },
    METADATA,
    { kind: 'check', key: 'keep16', label: 'Keep 16 bits per channel', value: true, hint: 'Off: a 16-bit picture whose every value fits in 8 bits is stored in 8 bits, which is smaller and changes no value.' },
  ],
  action: 'Compress',
  inspect: inspectPicture('png'),
  plan(inputs, values) {
    return `${plural(inputs.length, 'PNG file')}, lossless, effort ${choiceLabel(EFFORT, values.effort).split(' (')[0]}.`;
  },
  check(inputs) {
    return memoryCheck(inputs, () => ({ op: 'png' }), false);
  },
  async run(inputs, values, ctx) {
    const level = values.effort === '6' ? 6 : values.effort === '4' ? 4 : 2;
    return runOptimize(inputs, ctx, () => ({ op: 'png', task: { op: 'png', options: { level, removeMetadata: values.metadata === 'remove', keep16: values.keep16 !== false } } }));
  },
};
