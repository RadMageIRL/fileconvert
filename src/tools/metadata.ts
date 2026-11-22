// The "Remove photo metadata" tool. Each photo is rewritten without its metadata by the image worker, which copies
// the compressed picture byte for byte (src/engines/image/metadata.ts). The result keeps the file's name and
// format; each file says what was removed and kept, and its size before and after.

import { formatBytes } from '../core/limits';
import type { StripResult } from '../engines/image/metadata';
import { CanceledError } from '../app/pool';
import type { ToolDefinition } from '../app/tools';
import { safeBase } from '../core/naming';
import { FORMATS } from '../core/formats';

const sizes = (before: number, after: number) => {
  const pct = before ? Math.round((1 - after / before) * 1000) / 10 : 0;
  return `${formatBytes(before)} to ${formatBytes(after)}${after < before ? ` (${pct}% smaller)` : ''}`;
};

export const tool: ToolDefinition = {
  id: 'remove-image-metadata',
  title: 'Remove photo metadata',
  summary: 'Takes the camera details, GPS location, dates, editing history and other hidden data out of JPG, PNG and WebP photos, without recompressing them.',
  accepts: ['jpg', 'png', 'webp'],
  minInputs: 1,
  maxInputs: 500,
  ordered: false,
  options: [
    { kind: 'check', key: 'orientation', label: 'Keep the orientation, so photos stay upright', value: true },
    { kind: 'check', key: 'profile', label: 'Keep the color profile, so colors look the same', value: true },
  ],
  action: 'Remove metadata',
  async run(inputs, values, ctx) {
    const outputs: Awaited<ReturnType<ToolDefinition['run']>>['outputs'] = [];
    const warnings: string[] = [];
    let before = 0, after = 0, clean = 0;
    for (const [i, input] of inputs.entries()) {
      ctx.progress({ fraction: i / inputs.length, stage: `${i + 1} of ${inputs.length}: ${input.name}` });
      try {
        const r = await ctx.engines.image.run<StripResult>('stripMetadata', {
          file: input.file,
          format: input.format,
          options: { keepOrientation: values.orientation !== false, keepColorProfile: values.profile !== false },
        }, { signal: ctx.signal });
        before += input.file.size;
        after += r.bytes.length;
        if (!r.removed.length) clean++;
        const details = [
          r.removed.length ? `Removed: ${r.removed.join('; ')}.` : 'No metadata was found; the file is unchanged.',
          ...(r.kept.length ? [`Kept: ${r.kept.join('; ')}.`] : []),
        ];
        outputs.push({
          blob: new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: FORMATS[input.format].mime }),
          base: safeBase(input.name),
          ext: FORMATS[input.format].ext,
          note: sizes(input.file.size, r.bytes.length),
          details,
        });
      } catch (e) {
        if (e instanceof CanceledError || ctx.signal.aborted) throw e;
        warnings.push(`${input.name} was left out: ${(e as Error).message}`);
      }
    }
    if (!outputs.length) throw new Error(warnings[0] ?? 'No photo could be processed.');
    ctx.progress({ fraction: 1 });
    if (clean) warnings.push(`${clean} of ${outputs.length} ${outputs.length === 1 ? 'photo had' : 'photos had'} no metadata to remove.`);
    warnings.push('The picture itself is not changed, so faces, landmarks, documents or screens in the photo can still identify a person or a place.');
    return { outputs, warnings, summary: `${outputs.length} ${outputs.length === 1 ? 'photo' : 'photos'}, ${sizes(before, after)}` };
  },
};
