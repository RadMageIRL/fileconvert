// The PDF worker: the guard (./engines/pdf/scan.ts) for every PDF before pdf.js or the editing library reads it,
// page operations with cleanup (./engines/pdf/structure.ts), and merging (./engines/pdf/merge.ts). The editing
// library loads only when an editing task runs. Canceling a job stops this worker, which frees whatever it held.
//
// Every task gets the page's memory allowance (src/core/pdfmemory.ts; a worker is not told the device's memory) and
// refuses before it starts: on the file's size alone before reading it, then on what the guard counted before any
// PDF library reads it. Split checks once more, before copying anything, what its parts would hold together.

import { formatBytes } from '../core/limits';
import { admit, estimate, estimateFromSize, workOf, type MemoryAllowance, type PdfWork } from '../core/pdfmemory';
import { buffersOf, serve } from '../core/rpc';
import { ENCRYPTED_MESSAGE, scanPdf } from '../engines/pdf/scan';

/** An error about one of several files names it. */
const about = (name: string, e: unknown) => {
  const err = e instanceof Error ? e : new Error(String(e));
  const out = new Error(`${name}: ${err.message}`);
  out.name = err.name;
  return out;
};

type Kind = 'edit' | 'text';
const NEEDS: Record<Kind, string> = { edit: 'This PDF needs', text: 'Reading the text of this PDF needs' };

/** A file's bytes, once its size alone fits the allowance. */
async function read(file: Blob, allowance: MemoryAllowance | undefined, kind: Kind, advice = ''): Promise<Uint8Array> {
  admit(estimateFromSize(file.size, kind, allowance?.engine), allowance, NEEDS[kind], advice);
  return new Uint8Array(await file.arrayBuffer());
}

/** The check `openPdf` runs between the guard and the editing library, for one file alone. */
const alone = (bytes: Uint8Array, allowance: MemoryAllowance | undefined, outputs = 1) =>
  (scan: Parameters<typeof workOf>[1]) => admit(estimate([workOf(bytes.length, scan)], 'edit', { outputs, engine: allowance?.engine }), allowance, NEEDS.edit, '');

serve({
  /** The guard alone, before pdf.js reads a file for its text. Encrypted files are refused (v0.2.0 does not decrypt). */
  async scan(p: { file: Blob; allowance?: MemoryAllowance }, progress) {
    progress({ stage: 'Checking the PDF' });
    const bytes = await read(p.file, p.allowance, 'text');
    const scan = scanPdf(bytes);
    if (scan.encrypted) throw new Error(ENCRYPTED_MESSAGE);
    admit(estimate([workOf(bytes.length, scan)], 'text', { engine: p.allowance?.engine }), p.allowance, NEEDS.text, '');
    return { result: scan };
  },
  /** A file added to a PDF tool: the guard, then the editing library reads it, for its pages and signature. */
  async inspect(p: { file: Blob; allowance?: MemoryAllowance }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const bytes = await read(p.file, p.allowance, 'edit');
    const { doc, signature, scan } = await s.openPdf(bytes, alone(bytes, p.allowance));
    const work: PdfWork = workOf(bytes.length, scan);
    return { result: { pages: s.pageRefs(doc, await s.pdfLib()).length, signature, work } };
  },
  async keepPages(p: { file: Blob; order: number[]; allowance?: MemoryAllowance }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const bytes = await read(p.file, p.allowance, 'edit');
    const { doc, scan, signature } = await s.openPdf(bytes, alone(bytes, p.allowance));
    progress({ stage: 'Rewriting the pages' });
    const report = s.keepPages(doc, await s.pdfLib(), p.order);
    const out = await s.savePdf(doc);
    return { result: { bytes: out, report, scan, signature }, transfer: buffersOf(out) };
  },
  /** Pages turned by 90, 180 or 270 degrees, in place. */
  async rotate(p: { file: Blob; pages: number[]; by: number; allowance?: MemoryAllowance }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const bytes = await read(p.file, p.allowance, 'edit');
    const { doc, signature } = await s.openPdf(bytes, alone(bytes, p.allowance));
    progress({ stage: 'Turning the pages' });
    const report = s.rotatePages(doc, await s.pdfLib(), p.pages, p.by);
    const out = await s.savePdf(doc);
    return { result: { bytes: out, report, signature }, transfer: buffersOf(out) };
  },
  /** New PDFs, each of some pages of one file (0-based, in order): split makes several, extract one. The file is read
   *  once; each part is copied from it, cleaned and written whole. Before copying, what the parts hold together is
   *  counted: pages shared by several parts, and pictures or fonts shared by their pages, are copied into each. */
  async split(p: { file: Blob; name: string; parts: number[][]; allowance?: MemoryAllowance }, progress) {
    progress({ stage: 'Checking the PDF' });
    const s = await import('../engines/pdf/structure');
    const { takePages } = await import('../engines/pdf/merge');
    const bytes = await read(p.file, p.allowance, 'edit');
    const open = await s.openPdf(bytes, alone(bytes, p.allowance, p.parts.length));
    if (p.allowance) {
      const work = workOf(bytes.length, open.scan);
      const held = s.partBytes(open.doc, await s.pdfLib(), p.parts, p.allowance.total);
      const e = estimate([work], 'edit', { outputs: p.parts.length, extraOutput: Math.max(0, held - bytes.length), engine: p.allowance.engine });
      const many = p.parts.length > 1;
      admit(e, p.allowance, many ? `Splitting it this way makes ${p.parts.length.toLocaleString('en-US')} files that hold about ${formatBytes(held)} together, since each gets its own copy of the pictures and fonts its pages share; that needs` : NEEDS.edit,
        many ? 'Split it into fewer parts.' : '');
    }
    const parts: Array<{ bytes: Uint8Array; report: import('../engines/pdf/merge').MergeReport }> = [];
    for (const [i, pages] of p.parts.entries()) {
      progress({ stage: `Writing ${i + 1} of ${p.parts.length}`, fraction: i / p.parts.length });
      const { doc, report } = await takePages(open, p.name, pages);
      parts.push({ bytes: await s.savePdf(doc), report });
    }
    return { result: { parts, signature: open.signature }, transfer: buffersOf(...parts.map(x => x.bytes)) };
  },
  /** The files in order, one at a time: each is checked, read, copied in, and let go before the next. Before each is
   *  read, the files so far and this one together are held to the allowance (the page checked the whole set first). */
  async merge(p: { files: Array<{ file: Blob; name: string }>; allowance?: MemoryAllowance }, progress) {
    const s = await import('../engines/pdf/structure');
    const { Merger } = await import('../engines/pdf/merge');
    const merger = await Merger.create();
    const total = p.files.reduce((n, f) => n + f.file.size, 0) || 1;
    const works: PdfWork[] = [];
    const ADVICE = 'Merge fewer files at a time.';
    let done = 0;
    for (const [i, f] of p.files.entries()) {
      progress({ stage: `Adding ${i + 1} of ${p.files.length}: ${f.name}`, fraction: 0.85 * (done / total) });
      // Before reading: the files so far, and this one by its size alone. After the guard: with what it counted.
      const together = (w: PdfWork) => {
        const all = [...works, w];
        admit(estimate(all, 'edit', { engine: p.allowance?.engine }), p.allowance, all.length > 1 ? 'Together these files need' : NEEDS.edit, ADVICE);
      };
      try {
        together({ bytes: f.file.size, parsed: 0, objects: 0, pages: 0 });
        const bytes = new Uint8Array(await f.file.arrayBuffer());
        let work: PdfWork | null = null;
        merger.add(await s.openPdf(bytes, scan => { work = workOf(bytes.length, scan); together(work); }), f.name);
        works.push(work!);
      } catch (e) {
        const name = (e as Error).name;
        throw name === 'MergeTotalError' || (name === 'MemoryLimitError' && works.length > 0) ? e : about(f.name, e);
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
