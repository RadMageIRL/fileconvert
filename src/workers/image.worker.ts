import type { FormatId } from '../core/formats';
import { buffersOf, serve } from '../core/rpc';
import { LIMITS, LimitError } from '../core/limits';
import { combineTiff, convertImage, type ImageOptions } from '../engines/image/convert';
import type { TiffCompression } from '../engines/image/tiff';
import { stripMetadata, type MetadataFormat, type StripOptions } from '../engines/image/metadata';
import type { OptimizeTask } from '../engines/image/optimize';
import { estimateOptimize, type OptimizeOp, type ResizeTo } from '../core/imagememory';
import { admit, type MemoryAllowance } from '../core/pdfmemory';

interface Payload { file: Blob; from: FormatId; to: FormatId; options: ImageOptions }

serve({
  async convert(p: Payload, progress) {
    const bytes = new Uint8Array(await p.file.arrayBuffer());
    const r = await convertImage(bytes, p.from, p.to, p.options, stage => progress({ stage }));
    return { result: r, transfer: buffersOf(...r.outputs.map(o => o.bytes)) };
  },
  async combineTiff(p: { files: Array<{ file: Blob; format: FormatId; name: string }>; compression: TiffCompression }, progress) {
    const files = [];
    for (const f of p.files) files.push({ bytes: new Uint8Array(await f.file.arrayBuffer()), format: f.format, name: f.name });
    const r = await combineTiff(files, p.compression === 'lzw' ? 'lzw' : 'none', progress);
    return { result: r, transfer: buffersOf(r.bytes) };
  },
  /** What an image optimization tool learns about a picture as it is added (its header and structure). */
  async pictureFacts(p: { file: Blob; format: FormatId; op: 'png' | 'jpeg' | 'webp' | 'avif' | 'resize' }) {
    if (p.file.size > LIMITS.imageBytes) throw new LimitError(`The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.`);
    // The optimization engines load only when one of their tools is used, so conversions do not pay for them.
    const { pictureFacts } = await import('../engines/image/optimize');
    return { result: pictureFacts(new Uint8Array(await p.file.arrayBuffer()), p.format, p.op) };
  },
  /** One image optimization task on one file, checked for memory again here before anything is decoded. */
  async optimize(p: { file: Blob; format: FormatId; task: OptimizeTask; memoryOp: OptimizeOp; allowance?: MemoryAllowance; outPixels?: number; held?: number; before?: { files: number; pixels: number } }, progress) {
    if (p.file.size > LIMITS.imageBytes) throw new LimitError(`The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.`);
    const bytes = new Uint8Array(await p.file.arrayBuffer());
    const { optimizeImage, pictureFacts } = await import('../engines/image/optimize');
    const f = pictureFacts(bytes, p.format, p.task.op === 'resize' ? 'resize' : p.task.op === 'jpeg-lossless' ? 'jpeg' : p.task.op);
    if (f.problem) throw new LimitError(f.problem);
    if (f.width * f.height > LIMITS.imagePixels || f.width > LIMITS.imageSide || f.height > LIMITS.imageSide) {
      throw new LimitError(`The picture is ${f.width.toLocaleString('en-US')} x ${f.height.toLocaleString('en-US')} pixels; the limit is ${(LIMITS.imagePixels / 1e6).toFixed(0)} megapixels and ${LIMITS.imageSide.toLocaleString('en-US')} pixels on a side.`);
    }
    const measure = 'measure' in p.task.options && p.task.options.measure === true;
    admit(estimateOptimize(p.memoryOp, { bytes: bytes.length, width: f.width, height: f.height, raw: f.raw, bits: f.bits, coefficients: f.coefficients }, { outPixels: p.outPixels, to: p.task.op === 'resize' ? (p.task.options.to === 'same' ? p.format as ResizeTo : p.task.options.to) : undefined, measure, held: p.held, before: p.before, engine: p.allowance?.engine }), p.allowance, 'This picture needs', 'Try a smaller picture.');
    const { outcome, retire } = await optimizeImage(bytes, p.format, p.task, stage => progress({ stage }));
    return { result: outcome, transfer: buffersOf(outcome.bytes), retire };
  },
  async stripMetadata(p: { file: Blob; format: MetadataFormat; options: StripOptions }) {
    if (p.file.size > LIMITS.imageBytes) throw new LimitError(`The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.`);
    const r = stripMetadata(new Uint8Array(await p.file.arrayBuffer()), p.format, p.options);
    return { result: r, transfer: buffersOf(r.bytes) };
  },
});
