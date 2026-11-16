// PDF to TXT with pdf.js, on the page (pdf.js parses in its own worker). Text is rebuilt line by line from
// the positions pdf.js reports. A page that has pictures but no text is a scan: reading it would need OCR,
// which is a different job from text extraction, so FileConvert says so instead of returning nothing.

import { LIMITS, LimitError } from '../../core/limits';
import { utf8 } from '../../core/text';

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

async function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, w]) => {
      m.GlobalWorkerOptions.workerSrc = w.default;
      return m;
    });
  }
  return lib;
}

interface TextItem { str: string; transform: number[]; height: number; hasEOL?: boolean }

export interface PdfTextHandle {
  promise: Promise<{ bytes: Uint8Array; warnings: string[]; summary: string }>;
  cancel(): void;
}

export function pdfToText(file: Blob, onProgress: (fraction: number, stage: string) => void): PdfTextHandle {
  let canceled = false;
  let destroy: (() => Promise<void>) | null = null;
  const promise = (async () => {
    if (file.size > LIMITS.pdfBytes) throw new LimitError(`The PDF is larger than ${LIMITS.pdfBytes / 1048576} MB, the limit.`);
    const m = await pdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const task = m.getDocument({
      data,
      cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
      cMapPacked: true,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      stopAtErrors: false,
    });
    destroy = () => task.destroy();
    let pdf;
    try {
      pdf = await task.promise;
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'PasswordException') throw new Error('This PDF is protected with a password, so its text cannot be read. Remove the password in a PDF app and try again.');
      if (name === 'InvalidPDFException') throw new Error('This file is not a valid PDF, or it is damaged.');
      throw new Error(`The PDF could not be opened: ${(e as Error).message}`);
    }
    try {
      if (pdf.numPages > LIMITS.pdfPages) throw new LimitError(`The PDF has ${pdf.numPages} pages; the limit is ${LIMITS.pdfPages}.`);
      const pages: string[] = [];
      const empty: number[] = [];
      const IMAGE_OPS = new Set([m.OPS.paintImageXObject, m.OPS.paintInlineImageXObject, m.OPS.paintImageMaskXObject, m.OPS.paintImageXObjectRepeat]);
      for (let n = 1; n <= pdf.numPages; n++) {
        if (canceled) throw new Error('Canceled.');
        onProgress((n - 1) / pdf.numPages, `Page ${n} of ${pdf.numPages}`);
        const page = await pdf.getPage(n);
        const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
        let out = '';
        let lastY: number | null = null;
        for (const raw of content.items as TextItem[]) {
          if (typeof raw.str !== 'string') continue;
          const y = raw.transform[5];
          if (lastY !== null && out && !out.endsWith('\n') && Math.abs(y - lastY) > Math.max(2, raw.height * 0.6)) out += '\n';
          out += raw.str;
          if (raw.hasEOL) out += '\n';
          lastY = y;
        }
        const text = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text.replace(/\s/g, '').length < 3) empty.push(n);
        pages.push(text);
        page.cleanup();
      }
      onProgress(1, 'Finishing');
      if (empty.length === pdf.numPages) {
        // Look at a few pages to tell a scan from a blank document.
        let pictures = false;
        for (const n of empty.slice(0, 3)) {
          const ops = await (await pdf.getPage(n)).getOperatorList();
          if (ops.fnArray.some(f => IMAGE_OPS.has(f))) { pictures = true; break; }
        }
        throw new Error(pictures
          ? 'This PDF has no text to extract: its pages are pictures, as in a scanned document. Reading text from pictures needs OCR (optical character recognition), which FileConvert does not do.'
          : 'This PDF has no text to extract. Its pages are empty, or their text is drawn as shapes.');
      }
      const warnings: string[] = [];
      if (empty.length) {
        const list = empty.length > 8 ? `${empty.slice(0, 8).join(', ')} and ${empty.length - 8} more` : empty.join(', ');
        warnings.push(`${empty.length === 1 ? 'Page' : 'Pages'} ${list} ${empty.length === 1 ? 'has' : 'have'} no text. If ${empty.length === 1 ? 'it is a scanned page' : 'they are scanned pages'}, reading ${empty.length === 1 ? 'it' : 'them'} needs OCR, which FileConvert does not do.`);
      }
      warnings.push('Text is in reading order as stored in the PDF. Columns, tables and headers may not come out in the order you see them.');
      const text = pages.join('\n\n') + '\n';
      const words = text.split(/\s+/).filter(Boolean).length;
      return { bytes: utf8(text), warnings, summary: `${pdf.numPages} ${pdf.numPages === 1 ? 'page' : 'pages'}, ${words.toLocaleString('en-US')} words` };
    } finally {
      await task.destroy();
    }
  })();
  return {
    promise,
    cancel() {
      canceled = true;
      void destroy?.();
    },
  };
}
