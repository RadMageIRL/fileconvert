// The PDF worker: the guard (./engines/pdf/scan.ts) for every PDF before pdf.js or the editing library reads it,
// and page operations with cleanup (./engines/pdf/structure.ts). The editing library loads only when a page
// operation runs. Canceling a job stops this worker, which frees whatever it held.

import { buffersOf, serve } from '../core/rpc';
import { ENCRYPTED_MESSAGE, scanPdf } from '../engines/pdf/scan';

serve({
  /** The guard alone, before pdf.js reads a file. Encrypted files are refused (v0.2.0 does not decrypt). */
  async scan(p: { file: Blob }, progress) {
    progress({ stage: 'Checking the PDF' });
    const scan = scanPdf(new Uint8Array(await p.file.arrayBuffer()));
    if (scan.encrypted) throw new Error(ENCRYPTED_MESSAGE);
    return { result: scan };
  },
  async keepPages(p: { file: Blob; order: number[] }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const { doc, scan, signature } = await s.openPdf(new Uint8Array(await p.file.arrayBuffer()));
    progress({ stage: 'Rewriting the pages' });
    const report = s.keepPages(doc, await s.pdfLib(), p.order);
    const bytes = await s.savePdf(doc);
    return { result: { bytes, report, scan, signature }, transfer: buffersOf(bytes) };
  },
});
