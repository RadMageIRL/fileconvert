// The PDF worker: the guard (./engines/pdf/scan.ts) for every PDF before pdf.js or the editing library reads it,
// page operations with cleanup (./engines/pdf/structure.ts), and merging (./engines/pdf/merge.ts). The editing
// library loads only when an editing task runs. Canceling a job stops this worker, which frees whatever it held.

import { buffersOf, serve } from '../core/rpc';
import { ENCRYPTED_MESSAGE, scanPdf } from '../engines/pdf/scan';

/** An error about one of several files names it. */
const about = (name: string, e: unknown) => {
  const err = e instanceof Error ? e : new Error(String(e));
  return new Error(`${name}: ${err.message}`);
};

serve({
  /** The guard alone, before pdf.js reads a file. Encrypted files are refused (v0.2.0 does not decrypt). */
  async scan(p: { file: Blob }, progress) {
    progress({ stage: 'Checking the PDF' });
    const scan = scanPdf(new Uint8Array(await p.file.arrayBuffer()));
    if (scan.encrypted) throw new Error(ENCRYPTED_MESSAGE);
    return { result: scan };
  },
  /** A file added to a PDF tool: the guard, then the editing library reads it, for its pages and signature. */
  async inspect(p: { file: Blob }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const { doc, signature } = await s.openPdf(new Uint8Array(await p.file.arrayBuffer()));
    return { result: { pages: s.pageRefs(doc, await s.pdfLib()).length, signature } };
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
  /** Pages turned by 90, 180 or 270 degrees, in place. */
  async rotate(p: { file: Blob; pages: number[]; by: number }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const { doc, signature } = await s.openPdf(new Uint8Array(await p.file.arrayBuffer()));
    progress({ stage: 'Turning the pages' });
    const report = s.rotatePages(doc, await s.pdfLib(), p.pages, p.by);
    const bytes = await s.savePdf(doc);
    return { result: { bytes, report, signature }, transfer: buffersOf(bytes) };
  },
  /** New PDFs, each of some pages of one file (0-based, in order): split makes several, extract one. The file is read
   *  once; each part is copied from it, cleaned and written whole. */
  async split(p: { file: Blob; name: string; parts: number[][] }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const { takePages } = await import('../engines/pdf/merge');
    const open = await s.openPdf(new Uint8Array(await p.file.arrayBuffer()));
    const parts: Array<{ bytes: Uint8Array; report: import('../engines/pdf/merge').MergeReport }> = [];
    for (const [i, pages] of p.parts.entries()) {
      progress({ stage: `Writing ${i + 1} of ${p.parts.length}`, fraction: i / p.parts.length });
      const { doc, report } = await takePages(open, p.name, pages);
      parts.push({ bytes: await s.savePdf(doc), report });
    }
    return { result: { parts, signature: open.signature }, transfer: buffersOf(...parts.map(x => x.bytes)) };
  },
  /** The files in order, one at a time: each is checked, read, copied in, and let go before the next. */
  async merge(p: { files: Array<{ file: Blob; name: string }> }, progress) {
    const s = await import('../engines/pdf/structure');
    const { Merger } = await import('../engines/pdf/merge');
    const merger = await Merger.create();
    const total = p.files.reduce((n, f) => n + f.file.size, 0) || 1;
    let done = 0;
    for (const [i, f] of p.files.entries()) {
      progress({ stage: `Adding ${i + 1} of ${p.files.length}: ${f.name}`, fraction: 0.85 * (done / total) });
      try {
        merger.add(await s.openPdf(new Uint8Array(await f.file.arrayBuffer())), f.name);
      } catch (e) {
        throw (e as Error).name === 'MergeTotalError' ? e : about(f.name, e);
      }
      done += f.file.size;
    }
    progress({ stage: 'Cleaning up', fraction: 0.87 });
    const report = merger.finish();
    progress({ stage: 'Writing the PDF', fraction: 0.92 });
    const bytes = await s.savePdf(merger.doc);
    return { result: { bytes, report }, transfer: buffersOf(bytes) };
  },
});
