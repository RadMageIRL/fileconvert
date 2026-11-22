import { buffersOf, serve } from '../core/rpc';
import { docxToHtml, docxToText } from '../engines/document/docx';
import { renderDocx } from '../engines/document/docxwrite';
import type { FontFile } from '../engines/document/fonts';
import { missingIn, renderPdf } from '../engines/document/pdfwrite';
import { textToPdf, type PageOptions } from '../engines/document/text-to-pdf';

serve({
  async textToPdf(p: { file: Blob; options: PageOptions; title: string }, progress) {
    progress({ stage: 'Laying out pages' });
    const r = await textToPdf(new Uint8Array(await p.file.arrayBuffer()), p.options, p.title);
    return { result: r, transfer: buffersOf(r.bytes) };
  },
  async renderPdf(p: { doc: Record<string, unknown>; fonts: FontFile[]; text: string }, progress) {
    progress({ stage: 'Laying out pages' });
    const missing = await missingIn(p.text, 'NotoSans-Regular.ttf');
    const bytes = await renderPdf(p.doc, p.fonts);
    return { result: { bytes, missing }, transfer: buffersOf(bytes) };
  },
  async docxToHtml(p: { file: Blob }, progress) {
    progress({ stage: 'Reading the document' });
    return { result: await docxToHtml(new Uint8Array(await p.file.arrayBuffer())) };
  },
  async renderDocx(p: { html: string; title: string; pageSize: 'LETTER' | 'A4' }, progress) {
    progress({ stage: 'Writing the Word document' });
    const r = await renderDocx(p.html, p.title, p.pageSize);
    return { result: r, transfer: buffersOf(r.bytes) };
  },
  async docxToText(p: { file: Blob }, progress) {
    progress({ stage: 'Reading the document' });
    const r = await docxToText(new Uint8Array(await p.file.arrayBuffer()));
    return { result: r, transfer: buffersOf(r.bytes) };
  },
});
