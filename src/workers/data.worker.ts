import { buffersOf, serve } from '../core/rpc';
import { convertData, xlsxSheetNames, type DataOptions } from '../engines/data/convert';

interface Payload { file: Blob; from: string; to: string; options: DataOptions; baseName: string }

serve({
  async convert(p: Payload, progress) {
    progress({ stage: 'Reading' });
    const bytes = new Uint8Array(await p.file.arrayBuffer());
    progress({ stage: 'Converting' });
    const r = convertData(p.from, p.to, bytes, p.options, p.baseName);
    return { result: r, transfer: buffersOf(...r.outputs.map(o => o.bytes)) };
  },
  async sheets(p: { file: Blob; kind?: 'xlsx' | 'xls' | 'ods' }) {
    return { result: xlsxSheetNames(new Uint8Array(await p.file.arrayBuffer()), p.kind ?? 'xlsx') };
  },
});
