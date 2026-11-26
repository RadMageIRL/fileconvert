// What the image optimization tools share (Compress PNG, JPEG, WebP and AVIF, Resize images): the check of each picture
// as it is added (its header and structure, read in the image worker), the memory check before anything runs, the run
// itself, one file after another in the image worker, and the words of each result: its size before and after, the bytes
// and the share saved, its dimensions, whether it is lossless or lossy, what changed, what metadata was removed or kept,
// and SSIM when it was asked for. A compression that would not make a file smaller gives back the original, saying so.

import type { ToolContext, ToolDefinition, ToolInput, ToolResult, ToolValues } from '../app/tools';
import { CanceledError } from '../app/pool';
import { formatBytes, LIMITS } from '../core/limits';
import { estimateOptimize, type OptimizeOp, type PictureWork, type ResizeTo } from '../core/imagememory';
import { safeBase } from '../core/naming';
import { memoryAllowance, refusal } from '../core/pdfmemory';
import type { OptimizeOutcome, OptimizeTask, PictureFacts } from '../engines/image/optimize';

export const fmt = (n: number) => n.toLocaleString('en-US');
export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** The check of a picture as it is added: its size and kind, a reason it cannot be used, and what it costs. */
export function inspectPicture(op: 'png' | 'jpeg' | 'webp' | 'avif' | 'resize'): NonNullable<ToolDefinition['inspect']> {
  return async (input, ctx) => {
    if (input.file.size > LIMITS.imageBytes) return { error: `The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.` };
    const f = await ctx.engines.image.run<PictureFacts>('pictureFacts', { file: input.file, format: input.format, op }, { signal: ctx.signal });
    if (f.width * f.height > LIMITS.imagePixels || f.width > LIMITS.imageSide || f.height > LIMITS.imageSide) {
      return { info: `${fmt(f.width)} x ${fmt(f.height)}`, error: `The picture is ${fmt(f.width)} x ${fmt(f.height)} pixels; the limit is ${(LIMITS.imagePixels / 1e6).toFixed(0)} megapixels and ${fmt(LIMITS.imageSide)} pixels on a side.` };
    }
    const picture: PictureWork = { bytes: input.file.size, width: f.width, height: f.height, raw: f.raw, bits: f.bits, coefficients: f.coefficients };
    return { info: `${fmt(f.width)} x ${fmt(f.height)}, ${f.kind}`, note: f.notes.join(' ') || undefined, error: f.problem ?? undefined, picture };
  };
}

/** A size the person asked for, from its number and unit, in bytes; null when it is not a usable size. */
export function targetBytes(values: ToolValues): number | null {
  const v = Number(values.target);
  if (!Number.isFinite(v) || v <= 0) return null;
  const bytes = Math.round(v * (values.unit === 'mb' ? 1048576 : 1024));
  return bytes >= 1024 && bytes <= LIMITS.imageBytes ? bytes : null;
}

/** The target-size options: a number and its unit, shown while `key` is `value`. */
export function targetOptions(key: string, value: string) {
  return [
    { kind: 'number' as const, key: 'target', label: 'Target size', value: 500, min: 1, max: 300000, step: 1, showIf: { key, value },
      hint: 'The file is made as close to this size as it can be without going over, by choosing the quality. Its dimensions are not changed.' },
    { kind: 'select' as const, key: 'unit', label: 'Unit', value: 'kb', choices: [['kb', 'KB'], ['mb', 'MB']] as const, showIf: { key, value } },
  ];
}

/**
 * The memory check of a set of pictures: each is processed alone, so the largest counts, with the results before it.
 * Before the run, the results are counted at their pictures' sizes (a compression's result is never larger: the original
 * is kept instead); the worker checks each picture again with the results' real sizes, which a resize can make larger.
 */
export function memoryCheck(inputs: readonly ToolInput[], opOf: (input: ToolInput) => { op: OptimizeOp; outPixels?: number; to?: ResizeTo }, measure: boolean): string | null {
  const a = memoryAllowance();
  let held = 0;
  const before = { files: 0, pixels: 0 };
  for (const input of inputs) {
    if (!input.picture) continue;
    const { op, outPixels, to } = opOf(input);
    // Too large on its own, or only after the pictures before it: the advice differs.
    const alone = refusal(estimateOptimize(op, input.picture, { outPixels, to, measure, engine: a.engine }), a, inputs.length > 1 ? `${input.name} needs` : 'This picture needs', inputs.length > 1 ? 'Take it out, or try a smaller picture.' : 'Try a smaller picture.');
    if (alone) return alone;
    const k = before.files;
    const why = refusal(estimateOptimize(op, input.picture, { outPixels, to, measure, held, before: { ...before }, engine: a.engine }), a, `After ${k === 1 ? 'the picture' : `the ${plural(k, 'picture')}`} before it, ${input.name} needs`, `Run at most ${k} at a time.`);
    if (why) return why;
    held += input.file.size;
    before.files++;
    before.pixels += input.picture.width * input.picture.height;
  }
  return null;
}

const pct = (before: number, after: number) => (before ? Math.round((1 - after / before) * 1000) / 10 : 0);

/** One result's line: its size before and after, and what that saves. */
export function sizeNote(before: number, after: number, original: boolean): string {
  if (original) return `${formatBytes(before)}, kept as it was`;
  if (after < before) return `${formatBytes(before)} to ${formatBytes(after)}, ${pct(before, after)}% smaller (${formatBytes(before - after)} saved)`;
  if (after === before) return `${formatBytes(before)}, the same size`;
  return `${formatBytes(before)} to ${formatBytes(after)}, ${Math.abs(pct(before, after))}% larger`;
}

/** The details of one result. */
export function describeOutcome(o: OptimizeOutcome, resize = false): string[] {
  const d: string[] = [];
  const dims = `${fmt(o.width)} x ${fmt(o.height)} pixels`;
  d.push(o.width === o.sourceWidth && o.height === o.sourceHeight ? dims : `${dims}, was ${fmt(o.sourceWidth)} x ${fmt(o.sourceHeight)}`);
  if (o.original) d.push(resize ? 'Unchanged: the original file is offered as it is.' : 'Kept as it was: the original is offered unchanged.');
  else if (o.lossless) d.push('Lossless: every pixel is exactly as it was (checked).');
  else d.push(`Lossy${o.quality ? `, quality ${o.quality}` : ''}: compressed again, so some detail is lost.`);
  if (o.ssim !== undefined) d.push(`SSIM ${o.ssim.toFixed(4)} (1 means identical). It measures changes in the structure of brightness, not everything people notice.`);
  d.push(...o.changes);
  if (o.removed.length) d.push(`Removed: ${o.removed.join('; ')}.`);
  if (o.kept.length) d.push(`Kept: ${o.kept.join('; ')}.`);
  d.push(...o.notes);
  return d;
}

/**
 * Runs a tool's task on each picture in the image worker, one after another. A picture that fails is left out with the
 * reason; the others go on. `taskOf` gives each picture's task and what it is checked as for memory.
 */
export async function runOptimize(inputs: readonly ToolInput[], ctx: ToolContext, taskOf: (input: ToolInput) => { task: OptimizeTask; op: OptimizeOp; outPixels?: number }): Promise<ToolResult> {
  const outputs: ToolResult['outputs'] = [];
  const warnings: string[] = [];
  let before = 0, after = 0, unchanged = 0, held = 0;
  const done = { files: 0, pixels: 0 };
  for (const [i, input] of inputs.entries()) {
    const head = inputs.length > 1 ? `${i + 1} of ${inputs.length}: ${input.name}` : input.name;
    ctx.progress({ fraction: i / inputs.length, stage: head });
    const { task, op, outPixels } = taskOf(input);
    try {
      const r = await ctx.engines.image.run<OptimizeOutcome>('optimize', { file: input.file, format: input.format, task, memoryOp: op, allowance: memoryAllowance(), outPixels, held, before: { ...done } }, {
        signal: ctx.signal,
        onProgress: p => ctx.progress({ fraction: i / inputs.length, stage: p.stage ? `${head}: ${p.stage}` : head }),
      });
      const blob = r.original ? input.file : new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: r.mime });
      before += input.file.size;
      after += blob.size;
      if (r.original) unchanged++;
      else held += blob.size;
      outputs.push({ blob, base: safeBase(input.name), ext: r.ext, note: sizeNote(input.file.size, blob.size, r.original), details: describeOutcome(r, op === 'resize'), source: r.original ? undefined : input.id });
    } catch (e) {
      if (e instanceof CanceledError || ctx.signal.aborted) throw e;
      warnings.push(`${input.name} was left out: ${(e as Error).message}`);
    }
    // Done or failed, it may have left memory behind for the pictures after it.
    done.files++;
    done.pixels += (input.picture?.width ?? 0) * (input.picture?.height ?? 0);
  }
  if (!outputs.length) throw new Error(warnings[0]?.replace(/^.*? was left out: /, '') ?? 'No picture could be processed.');
  ctx.progress({ fraction: 1 });
  if (unchanged && outputs.length > 1) warnings.push(`${plural(unchanged, 'picture')} ${unchanged === 1 ? 'was' : 'were'} kept as ${unchanged === 1 ? 'it was' : 'they were'}.`);
  const summary = outputs.length > 1 ? `${plural(outputs.length, 'picture')}, ${sizeNote(before, after, false)} in all` : undefined;
  return { outputs, warnings, summary };
}

/** "Standard", for the plan line. */
export const choiceLabel = (choices: ReadonlyArray<readonly [string, string]>, v: unknown) => choices.find(([k]) => k === v)?.[1] ?? '';

export const METADATA = {
  kind: 'select' as const, key: 'metadata', label: 'Metadata', value: 'keep',
  choices: [['keep', 'Keep it (EXIF, XMP, text, color profile)'], ['remove', 'Remove it (keep the color profile and orientation)']] as const,
  hint: 'Removing takes out camera details, dates, GPS location, XMP and text; the color profile and the orientation stay so the picture looks the same.',
};

export const MEASURE = {
  kind: 'check' as const, key: 'measure', label: 'Measure the similarity (SSIM); slower', value: false,
  hint: 'Decodes each result again and compares it with the original. 1 means identical.',
};
