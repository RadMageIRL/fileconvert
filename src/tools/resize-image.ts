// The "Resize images" tool (src/engines/image/optimize.ts, resizeImage): a width and height to fit within (the shape kept,
// by default), an exact size (stretched, only when chosen), or a percentage; never enlarged unless allowed; every picture
// turned upright first; in its own format or the one chosen. Lanczos-3, transparency kept where the format can hold it.

import type { ToolDefinition, ToolInput, ToolValues } from '../app/tools';
import { FORMATS } from '../core/formats';
import { LIMITS } from '../core/limits';
import { resizeTarget, type ResizeOptions } from '../engines/image/optimize';
import { fmt, inspectPicture, memoryCheck, METADATA, plural, runOptimize } from './optimize-common';

export function optionsOf(values: ToolValues): ResizeOptions {
  const to = values.format === 'jpg' || values.format === 'png' || values.format === 'webp' || values.format === 'avif' ? values.format : 'same';
  return {
    by: values.by === 'percent' ? 'percent' : 'size',
    width: Math.max(0, Math.round(Number(values.width) || 0)),
    height: Math.max(0, Math.round(Number(values.height) || 0)),
    lock: values.lock !== false,
    percent: Math.max(1, Math.min(1000, Number(values.percent) || 50)),
    enlarge: values.enlarge === true,
    to,
    quality: Math.max(1, Math.min(100, Math.round(Number(values.quality) || 85))),
    removeMetadata: values.metadata === 'remove',
  };
}

/** The size one picture gets, upright (its EXIF orientation is applied first). */
function sizeOf(input: ToolInput, o: ResizeOptions): { width: number; height: number } | null {
  const p = input.picture;
  if (!p) return null;
  // The check gives the upright size (EXIF orientation and AVIF rotation applied), as the worker resizes it.
  return resizeTarget(p.width, p.height, o);
}

export const tool: ToolDefinition = {
  id: 'resize-image',
  title: 'Resize images',
  summary: 'Makes pictures a new size: to fit within a width and height, to an exact size, or by a percentage. Nothing is cropped, and nothing is enlarged unless you allow it.',
  accepts: ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp'],
  minInputs: 1,
  maxInputs: LIMITS.imageOptFiles,
  ordered: false,
  options: [
    { kind: 'select', key: 'by', label: 'Size by', value: 'size', choices: [['size', 'Width and height'], ['percent', 'Percentage']] },
    { kind: 'number', key: 'width', label: 'Width', value: 1920, min: 0, max: LIMITS.imageSide, unit: 'px', showIf: { key: 'by', value: 'size' } },
    { kind: 'number', key: 'height', label: 'Height', value: 1080, min: 0, max: LIMITS.imageSide, unit: 'px', showIf: { key: 'by', value: 'size' }, hint: '0 means any: set only a width, or only a height.' },
    { kind: 'check', key: 'lock', label: 'Keep the aspect ratio (fit within the width and height)', value: true, showIf: { key: 'by', value: 'size' },
      hint: 'Off: each picture is made exactly that width and height, which stretches it if its shape differs. Nothing is ever cropped.' },
    { kind: 'number', key: 'percent', label: 'Percentage', value: 50, min: 1, max: 1000, unit: '%', showIf: { key: 'by', value: 'percent' } },
    { kind: 'check', key: 'enlarge', label: 'Allow enlarging', value: false, hint: 'Off: a picture smaller than the size asked for keeps its size. Enlarging adds no detail.' },
    { kind: 'select', key: 'format', label: 'Save as', value: 'same', choices: [['same', 'The same format'], ['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP'], ['avif', 'AVIF']] },
    { kind: 'number', key: 'quality', label: 'Quality', value: 85, min: 1, max: 100, showIf: { key: 'format', value: ['same', 'jpg', 'webp', 'avif'] }, hint: 'For JPG, WebP and AVIF results. PNG is always lossless.' },
    METADATA,
  ],
  action: 'Resize',
  inspect: inspectPicture('resize'),
  plan(inputs, values) {
    const o = optionsOf(values);
    const sizes = inputs.map(i => sizeOf(i, o)).filter((s): s is { width: number; height: number } => !!s);
    if (!sizes.length) return null;
    const to = o.to === 'same' ? 'in their own format' : `as ${FORMATS[o.to].label}`;
    const how = o.by === 'percent' ? `at ${o.percent}%` : o.lock ? `to fit within ${o.width ? fmt(o.width) : 'any'} x ${o.height ? fmt(o.height) : 'any'} pixels` : `to exactly ${fmt(o.width)} x ${fmt(o.height)} pixels`;
    const one = sizes.length === 1 ? `: ${fmt(sizes[0].width)} x ${fmt(sizes[0].height)} pixels` : '';
    return `${plural(inputs.length, 'picture')} ${how}, ${to}${one}.`;
  },
  check(inputs, values) {
    const o = optionsOf(values);
    if (o.by === 'size' && !o.width && !o.height) return 'Give a width, a height or both.';
    if (o.by === 'size' && !o.lock && (!o.width || !o.height)) return 'An exact size needs both a width and a height.';
    for (const i of inputs) {
      const s = sizeOf(i, o);
      if (s && (s.width * s.height > LIMITS.imagePixels || s.width > LIMITS.imageSide || s.height > LIMITS.imageSide)) return `${i.name} would be ${fmt(s.width)} x ${fmt(s.height)} pixels, more than the ${LIMITS.imagePixels / 1e6} megapixels and ${fmt(LIMITS.imageSide)} pixels on a side allowed.`;
      if (s && o.to === 'webp' && (s.width > 16383 || s.height > 16383)) return `${i.name} would be ${fmt(s.width)} x ${fmt(s.height)} pixels; WebP is at most 16,383 pixels on a side.`;
      if (s && o.to === 'jpg' && (s.width > 65535 || s.height > 65535)) return `${i.name} would be wider or taller than the 65,535 pixels a JPG can be.`;
    }
    return memoryCheck(inputs, i => { const s = sizeOf(i, o); return { op: 'resize', outPixels: s ? s.width * s.height : undefined }; }, false);
  },
  async run(inputs, values, ctx) {
    const o = optionsOf(values);
    return runOptimize(inputs, ctx, i => { const s = sizeOf(i, o); return { op: 'resize', outPixels: s ? s.width * s.height : undefined, task: { op: 'resize', options: o } }; });
  },
};
