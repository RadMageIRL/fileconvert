import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PDFDict, PDFDocument } from '@cantoo/pdf-lib';
import { pageRefs, pdfLib } from '../../src/engines/pdf/structure';

// Helpers for the PDF unit tests: fixtures, small hand-written PDFs, and a result read back with the editing library.
// The browser tests read every result with qpdf, pypdf, PDFium and pdftotext instead.

export const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'pdf', p)));

/** A small hand-written PDF (ASCII only), for shapes the fixtures do not have. */
export function pdfFrom(objs: Record<number, string>, version = '1.7'): Uint8Array {
  let out = `%PDF-${version}\n`;
  const offs: Record<number, number> = {};
  const keys = Object.keys(objs).map(Number).sort((a, b) => a - b);
  for (const k of keys) { offs[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
  const size = Math.max(...keys) + 1;
  const xref = out.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) out += offs[k] !== undefined ? `${String(offs[k]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
export const content = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
export const page = (contents: number, extra = '') => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contents} 0 R${extra} >>`;

/** What the result holds, read back: pages by index, bookmarks as [title, page, children], fields by full name. */
export async function read(doc: PDFDocument) {
  const L = await pdfLib();
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } = L;
  const N = (s: string) => PDFName.of(s);
  const pages = pageRefs(doc, L).map(String);
  const look = (v: unknown) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
  const str = (v: unknown) => { const s = look(v); return s instanceof PDFString || s instanceof PDFHexString ? s.decodeText() : undefined; };
  /** A destination's page: explicit, or named (the old /Dests dictionary or the name tree), as readers resolve it. */
  const target = (d: unknown): number | string => {
    let a = look(d);
    if (a instanceof PDFName) a = look(doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict)?.get(a));
    else if (a instanceof PDFString || a instanceof PDFHexString) {
      const key = a.decodeText();
      const tree = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookup(PDFName.of('Dests'));
      const list = tree instanceof PDFDict ? tree.lookup(PDFName.of('Names')) : undefined;
      a = undefined;
      if (list instanceof PDFArray) for (let i = 0; i < list.size(); i += 2) if (str(list.get(i)) === key) a = look(list.get(i + 1));
    }
    if (a instanceof PDFDict) a = look(a.get(PDFName.of('D')));
    if (!(a instanceof PDFArray)) return 'none';
    return pages.indexOf(String(a.get(0)));
  };
  const outline = (first: unknown): unknown[] => {
    const out: unknown[] = [];
    for (let r = first, n = 0; r instanceof PDFRef && n < 100; n++) {
      const it = doc.context.lookup(r, PDFDict);
      const a = look(it.get(N('A')));
      const dest = it.get(N('Dest')) ?? (a instanceof PDFDict && a.get(N('S')) === N('GoTo') ? a.get(N('D')) : undefined);
      const row: unknown[] = [str(it.get(N('Title'))), dest !== undefined ? target(dest) : a instanceof PDFDict ? String(a.get(N('S'))) : null];
      if (it.get(N('First'))) row.push(outline(it.get(N('First'))), (look(it.get(N('Count'))) as { asNumber(): number }).asNumber());
      out.push(row);
      r = it.get(N('Next'));
    }
    return out;
  };
  const fields: Record<string, { value?: string; da?: string }> = {};
  const walk = (v: unknown, prefix: string) => {
    const f = look(v);
    if (!(f instanceof PDFDict)) return;
    const name = [prefix, str(f.get(N('T')))].filter(Boolean).join('.');
    const kids = look(f.get(N('Kids')));
    const named = kids instanceof PDFArray ? kids.asArray().filter(k => (look(k) as PDFDict).get(N('T')) !== undefined) : [];
    if (named.length) { for (const k of named) walk(k, name); return; }
    const val = look(f.get(N('V')));
    fields[name] = { value: val instanceof PDFName ? val.decodeText() : str(val), da: str(f.get(N('DA'))) };
  };
  const af = doc.catalog.lookupMaybe(N('AcroForm'), PDFDict);
  const list = af?.lookup(N('Fields'));
  if (list instanceof PDFArray) for (const f of list.asArray()) walk(f, '');
  const dests: Record<string, number | string> = {};
  const names = doc.catalog.lookupMaybe(N('Names'), PDFDict)?.lookup(N('Dests'));
  const arr = names instanceof PDFDict ? names.lookup(N('Names')) : undefined;
  if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i += 2) dests[str(arr.get(i))!] = target(arr.get(i + 1));
  let pageObjects = 0;
  for (const [, o] of doc.context.enumerateIndirectObjects()) if (o instanceof PDFDict && o.get(N('Type')) === N('Page')) pageObjects++;
  const outlines = doc.catalog.lookupMaybe(N('Outlines'), PDFDict);
  return { pages, pageObjects, outline: outlines ? outline(outlines.get(N('First'))) : [], outlineCount: outlines ? (look(outlines.get(N('Count'))) as { asNumber(): number }).asNumber() : 0, fields, dests, af, look, str, N, target };
}

/** Every object of a PDF as text, each stream decoded, plus the raw bytes. */
export async function everything(bytes: Uint8Array): Promise<string> {
  const L = await pdfLib();
  const doc = await L.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity });
  let text = new TextDecoder('latin1').decode(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    text += '\n' + obj.toString();
    if (obj instanceof L.PDFRawStream) text += '\n' + new TextDecoder('latin1').decode(L.decodePDFRawStream(obj).decode());
  }
  return text;
}
