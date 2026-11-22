import type { FormatId } from '../core/formats';
import { buffersOf, serve } from '../core/rpc';
import { LIMITS, LimitError } from '../core/limits';
import { convertImage, type ImageOptions } from '../engines/image/convert';
import { stripMetadata, type MetadataFormat, type StripOptions } from '../engines/image/metadata';

interface Payload { file: Blob; from: FormatId; to: FormatId; options: ImageOptions }

serve({
  async convert(p: Payload, progress) {
    const bytes = new Uint8Array(await p.file.arrayBuffer());
    const r = await convertImage(bytes, p.from, p.to, p.options, stage => progress({ stage }));
    return { result: r, transfer: buffersOf(...r.outputs.map(o => o.bytes)) };
  },
  async stripMetadata(p: { file: Blob; format: MetadataFormat; options: StripOptions }) {
    if (p.file.size > LIMITS.imageBytes) throw new LimitError(`The file is larger than ${LIMITS.imageBytes / 1048576} MB, the limit for images.`);
    const r = stripMetadata(new Uint8Array(await p.file.arrayBuffer()), p.format, p.options);
    return { result: r, transfer: buffersOf(r.bytes) };
  },
});
