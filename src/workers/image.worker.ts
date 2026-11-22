import type { FormatId } from '../core/formats';
import { buffersOf, serve } from '../core/rpc';
import { convertImage, type ImageOptions } from '../engines/image/convert';

interface Payload { file: Blob; from: FormatId; to: FormatId; options: ImageOptions }

serve({
  async convert(p: Payload, progress) {
    const bytes = new Uint8Array(await p.file.arrayBuffer());
    const r = await convertImage(bytes, p.from, p.to, p.options, stage => progress({ stage }));
    return { result: r, transfer: buffersOf(...r.outputs.map(o => o.bytes)) };
  },
});
