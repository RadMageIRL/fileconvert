// The "Compress AVIF" tool (src/engines/image/avifopt.ts): lossy at a quality or to a file size, or lossless, with libavif
// and libaom, at the file's own bit depth (8, 10 or 12 bits), its color description (HDR included) and profile kept, and
// its rotation, mirroring and crop applied to the pixels. Animated AVIF is refused with the reason.

import type { ToolDefinition } from '../app/tools';
import { LIMITS } from '../core/limits';
import { AVIF_TARGET_PIXELS, AVIF_TARGET_QUALITY } from '../engines/image/avifopt';
import { inspectPicture, MEASURE, memoryCheck, METADATA, plural, runOptimize, targetBytes, targetOptions } from './optimize-common';

const MODES = [['lossy', 'Lossy, at a quality'], ['target', 'Lossy, to a file size'], ['lossless', 'Lossless: every pixel kept']] as const;

export const tool: ToolDefinition = {
  id: 'compress-avif',
  title: 'Compress AVIF',
  summary: 'Makes AVIF pictures smaller, at a quality or to a file size, keeping their bit depth, HDR, transparency and color.',
  accepts: ['avif'],
  minInputs: 1,
  maxInputs: LIMITS.imageOptFiles,
  ordered: false,
  options: [
    { kind: 'select', key: 'mode', label: 'How', value: 'lossy', choices: MODES,
      hint: 'AVIF encoding is slow: a large picture can take a minute, and to a file size tries several qualities.' },
    { kind: 'number', key: 'quality', label: 'Quality', value: 60, min: 1, max: 100, showIf: { key: 'mode', value: 'lossy' }, hint: '60 keeps most photos looking the same; lower is smaller.' },
    ...targetOptions('mode', 'target'),
    { ...METADATA, hint: 'The color profile and color description always stay. EXIF and XMP inside an AVIF are not written into the result either way; the result says when a file had them.' },
    { ...MEASURE, showIf: { key: 'mode', value: ['lossy', 'target'] } },
  ],
  action: 'Compress',
  inspect: inspectPicture('avif'),
  plan(inputs, values) {
    const n = plural(inputs.length, 'AVIF file');
    if (values.mode === 'lossless') return `${n}, lossless.`;
    if (values.mode === 'target') return targetBytes(values) ? `${n}, each at most ${values.target} ${values.unit === 'mb' ? 'MB' : 'KB'} (quality ${AVIF_TARGET_QUALITY.min} to ${AVIF_TARGET_QUALITY.max} is searched).` : null;
    return `${n} at quality ${Number(values.quality) || 60}, lossy.`;
  },
  check(inputs, values) {
    if (values.mode === 'target') {
      if (!targetBytes(values)) return 'Give a target size of at least 1 KB.';
      const big = inputs.find(i => i.picture && i.picture.width * i.picture.height > AVIF_TARGET_PIXELS);
      if (big) return `${big.name} is more than ${AVIF_TARGET_PIXELS / 1e6} megapixels; to a file size works up to that, since each try is a full AVIF encode. Choose a quality instead.`;
    }
    return memoryCheck(inputs, () => ({ op: 'avif' }), values.measure === true && values.mode !== 'lossless');
  },
  async run(inputs, values, ctx) {
    const mode = values.mode === 'target' || values.mode === 'lossless' ? values.mode : 'lossy';
    const options = { mode, quality: Math.max(1, Math.min(100, Math.round(Number(values.quality) || 60))), targetBytes: targetBytes(values) ?? undefined, removeMetadata: values.metadata === 'remove', measure: values.measure === true && mode !== 'lossless' } as const;
    return runOptimize(inputs, ctx, () => ({ op: 'avif', task: { op: 'avif', options } }));
  },
};
