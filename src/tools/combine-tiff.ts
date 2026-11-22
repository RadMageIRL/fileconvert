// The "Combine images into a TIFF" tool: pictures in the chosen order become the pages of one TIFF, made by the
// image worker (combineTiff in src/engines/image/convert.ts). A multi-page TIFF among them adds all its pages.

import type { ToolDefinition } from '../app/tools';
import { formatBytes } from '../core/limits';

export const tool: ToolDefinition = {
  id: 'images-to-tiff',
  title: 'Combine images into a TIFF',
  summary: 'Makes one multi-page TIFF from your pictures, one page each, in the order you set.',
  accepts: ['jpg', 'png', 'webp', 'avif', 'heic', 'bmp', 'gif', 'tiff', 'ico'],
  minInputs: 2,
  maxInputs: 500,
  ordered: true,
  options: [
    { kind: 'select', key: 'compression', label: 'Compression', value: 'none', choices: [['none', 'None (most compatible)'], ['lzw', 'LZW (smaller, lossless)']] },
  ],
  action: 'Make the TIFF',
  async run(inputs, values, ctx) {
    const r = await ctx.engines.image.run<{ bytes: Uint8Array; pages: number; warnings: string[] }>('combineTiff', {
      files: inputs.map(i => ({ file: i.file, format: i.format, name: i.name })),
      compression: values.compression === 'lzw' ? 'lzw' : 'none',
    }, { signal: ctx.signal, onProgress: ctx.progress });
    const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: 'image/tiff' });
    return {
      outputs: [{ blob, base: 'combined', ext: 'tiff', note: `${r.pages} pages, ${formatBytes(blob.size)}` }],
      warnings: r.warnings,
      summary: `${r.pages} pages${values.compression === 'lzw' ? ', LZW' : ''}`,
    };
  },
};
