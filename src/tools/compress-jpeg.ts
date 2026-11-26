// The "Compress JPG" tool, three ways (src/engines/image/jpegopt.ts): lossless (the picture's coefficients written again
// with Huffman tables made for it, every pixel the same), at a quality, or to a file size (MozJPEG, which loses some
// detail; the quality is searched, the dimensions are never changed for it). Making the picture smaller is a separate,
// explicit option. Metadata, the color profile and the pictures after the main one stay unless removal is chosen.

import type { ToolDefinition, ToolInput, ToolValues } from '../app/tools';
import { LIMITS } from '../core/limits';
import { TARGET_QUALITY } from '../engines/image/jpegopt';
import { fmt, inspectPicture, MEASURE, memoryCheck, METADATA, plural, runOptimize, targetBytes, targetOptions } from './optimize-common';

const MODES = [
  ['quality', 'Smaller: at a quality (lossy)'],
  ['target', 'Smaller: to a file size (lossy)'],
  ['lossless', 'Lossless: every pixel kept'],
] as const;
const LOSSY = ['quality', 'target'] as const;

function fitOf(values: ToolValues): { width: number; height: number } | null {
  if (values.mode === 'lossless' || values.resize !== 'fit') return null;
  const w = Math.max(0, Math.round(Number(values.maxWidth) || 0)), h = Math.max(0, Math.round(Number(values.maxHeight) || 0));
  return w || h ? { width: w, height: h } : null;
}

/** The size a picture ends at with the size option, in its upright orientation. */
function fitted(input: ToolInput, values: ToolValues): { width: number; height: number } | null {
  const p = input.picture, fit = fitOf(values);
  if (!p) return null;
  if (!fit) return { width: p.width, height: p.height };
  const k = Math.min(fit.width ? fit.width / p.width : Infinity, fit.height ? fit.height / p.height : Infinity, 1);
  return { width: Math.max(1, Math.round(p.width * k)), height: Math.max(1, Math.round(p.height * k)) };
}

export const tool: ToolDefinition = {
  id: 'compress-jpeg',
  title: 'Compress JPG',
  summary: 'Makes JPG photos smaller: at a quality you choose, to a file size, or without losing a pixel. Dimensions stay the same unless you ask.',
  accepts: ['jpg'],
  minInputs: 1,
  maxInputs: LIMITS.imageOptFiles,
  ordered: false,
  compare: true,
  options: [
    { kind: 'select', key: 'mode', label: 'How', value: 'quality', choices: MODES,
      hint: 'Lossless makes files a few percent smaller with no change at all. The others compress again with MozJPEG, which is much smaller and loses some detail.' },
    { kind: 'number', key: 'quality', label: 'Quality', value: 80, min: 1, max: 100, showIf: { key: 'mode', value: 'quality' }, hint: '80 keeps photos looking the same to most people; lower is smaller.' },
    ...targetOptions('mode', 'target'),
    { kind: 'check', key: 'progressive', label: 'Progressive (appears gradually while it loads; usually smaller)', value: true },
    { kind: 'select', key: 'resize', label: 'Dimensions', value: 'keep', choices: [['keep', 'Keep them'], ['fit', 'Make the picture smaller to fit within']], showIf: { key: 'mode', value: LOSSY } },
    { kind: 'number', key: 'maxWidth', label: 'Width at most', value: 1920, min: 0, max: LIMITS.imageSide, unit: 'px', showIf: [{ key: 'mode', value: LOSSY }, { key: 'resize', value: 'fit' }] },
    { kind: 'number', key: 'maxHeight', label: 'Height at most', value: 1920, min: 0, max: LIMITS.imageSide, unit: 'px', showIf: [{ key: 'mode', value: LOSSY }, { key: 'resize', value: 'fit' }], hint: '0 means any. The shape is kept and nothing is enlarged.' },
    METADATA,
    { ...MEASURE, showIf: { key: 'mode', value: LOSSY } },
  ],
  action: 'Compress',
  inspect: inspectPicture('jpeg'),
  plan(inputs, values) {
    const n = plural(inputs.length, 'JPG file');
    if (values.mode === 'lossless') return `${n}, lossless: every pixel stays the same.`;
    const fit = fitOf(values);
    const size = fit ? `, made smaller to fit within ${fit.width ? fmt(fit.width) : 'any'} x ${fit.height ? fmt(fit.height) : 'any'} pixels` : ', dimensions kept';
    if (values.mode === 'target') {
      const t = targetBytes(values);
      return t ? `${n}, each at most ${values.unit === 'mb' ? `${values.target} MB` : `${values.target} KB`} (quality ${TARGET_QUALITY.min} to ${TARGET_QUALITY.max} is searched)${size}.` : null;
    }
    return `${n} at quality ${Number(values.quality) || 80}${size}.`;
  },
  check(inputs, values) {
    if (values.mode === 'target' && !targetBytes(values)) return 'Give a target size of at least 1 KB.';
    return memoryCheck(inputs, input => values.mode === 'lossless' ? { op: 'jpeg-lossless' } : { op: 'jpeg', outPixels: (fitted(input, values)?.width ?? 0) * (fitted(input, values)?.height ?? 0) || undefined }, values.measure === true && values.mode !== 'lossless');
  },
  async run(inputs, values, ctx) {
    const removeMetadata = values.metadata === 'remove';
    const progressive = values.progressive !== false;
    if (values.mode === 'lossless') return runOptimize(inputs, ctx, () => ({ op: 'jpeg-lossless', task: { op: 'jpeg-lossless', options: { progressive, removeMetadata } } }));
    const target = values.mode === 'target' ? targetBytes(values) ?? undefined : undefined;
    const quality = values.mode === 'quality' ? Math.max(1, Math.min(100, Math.round(Number(values.quality) || 80))) : undefined;
    return runOptimize(inputs, ctx, () => ({ op: 'jpeg', task: { op: 'jpeg', options: { quality, targetBytes: target, progressive, removeMetadata, fit: fitOf(values), measure: values.measure === true } } }));
  },
};
