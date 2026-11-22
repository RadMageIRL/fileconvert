import type { FormatId } from '../core/formats';
import { buffersOf, serve } from '../core/rpc';
import { LIMITS, LimitError } from '../core/limits';
import { combineTiff, convertImage, type ImageOptions } from '../engines/image/convert';
import type { TiffCompression } from '../engines/image/tiff';
import { stripMetadata, type MetadataFormat, type StripOptions } from '../engines/image/metadata';

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
  async stripMetadata(p: { file: Blob; format: MetadataFormat; options: StripOptions }) {
    if (p.file.size > LIMITS.imageBytes) throw new LimitError(`The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.`);
    const r = stripMetadata(new Uint8Array(await p.file.arrayBuffer()), p.format, p.options);
    return { result: r, transfer: buffersOf(r.bytes) };
  },
});
