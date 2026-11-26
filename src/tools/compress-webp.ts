// The "Compress WebP" tool (src/engines/image/webpopt.ts): lossy at a quality or to a file size, or lossless (every pixel
// kept, checked), with libwebp. By default a lossless file stays lossless and a lossy one is compressed at the quality.
// Transparency stays; animated WebP is refused with the reason.

import type { ToolDefinition } from '../app/tools';
import { LIMITS } from '../core/limits';
import { WEBP_TARGET_QUALITY } from '../engines/image/webpopt';
import { inspectPicture, MEASURE, memoryCheck, METADATA, plural, runOptimize, targetBytes, targetOptions } from './optimize-common';

const MODES = [
  ['auto', 'Lossless files stay lossless; others at the quality below'],
  ['lossy', 'Lossy, at a quality'],
  ['target', 'Lossy, to a file size'],
  ['lossless', 'Lossless: every pixel kept'],
] as const;

export const tool: ToolDefinition = {
  id: 'compress-webp',
  title: 'Compress WebP',
  summary: 'Makes WebP pictures smaller, at a quality, to a file size or without loss, keeping transparency and the color profile.',
  accepts: ['webp'],
  minInputs: 1,
  maxInputs: LIMITS.imageOptFiles,
  ordered: false,
  options: [
    { kind: 'select', key: 'mode', label: 'How', value: 'auto', choices: MODES,
      hint: 'Lossy WebP is much smaller and loses some detail; lossless keeps every pixel and suits screenshots, drawings and text.' },
    { kind: 'number', key: 'quality', label: 'Quality', value: 75, min: 1, max: 100, showIf: { key: 'mode', value: ['auto', 'lossy'] }, hint: '75 is libwebp\'s usual choice; lower is smaller.' },
    ...targetOptions('mode', 'target'),
    METADATA,
    { ...MEASURE, showIf: { key: 'mode', value: ['auto', 'lossy', 'target'] } },
  ],
  action: 'Compress',
  inspect: inspectPicture('webp'),
  plan(inputs, values) {
    const n = plural(inputs.length, 'WebP file');
    if (values.mode === 'lossless') return `${n}, lossless: every pixel stays the same.`;
    if (values.mode === 'target') return targetBytes(values) ? `${n}, each at most ${values.target} ${values.unit === 'mb' ? 'MB' : 'KB'} (quality ${WEBP_TARGET_QUALITY.min} to ${WEBP_TARGET_QUALITY.max} is searched).` : null;
    return values.mode === 'auto' ? `${n}: lossless ones stay lossless, the others at quality ${Number(values.quality) || 75}.` : `${n} at quality ${Number(values.quality) || 75}, lossy.`;
  },
  check(inputs, values) {
    if (values.mode === 'target' && !targetBytes(values)) return 'Give a target size of at least 1 KB.';
    return memoryCheck(inputs, () => ({ op: values.mode === 'lossy' || values.mode === 'target' ? 'webp' : 'webp-lossless' }), values.measure === true);
  },
  async run(inputs, values, ctx) {
    const mode = values.mode === 'lossy' || values.mode === 'target' || values.mode === 'lossless' ? values.mode : 'auto';
    const options = { mode, quality: Math.max(1, Math.min(100, Math.round(Number(values.quality) || 75))), targetBytes: targetBytes(values) ?? undefined, removeMetadata: values.metadata === 'remove', measure: values.measure === true } as const;
    return runOptimize(inputs, ctx, () => ({ op: mode === 'lossy' || mode === 'target' ? 'webp' : 'webp-lossless', task: { op: 'webp', options } }));
  },
};
