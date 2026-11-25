// PDF metadata removal (the "Remove PDF metadata" tool), on the editing library in the PDF worker.
//
// Removed, wherever the PDF has them:
// 1. The document information dictionary: title, author, subject, keywords, creator, producer, the creation and
//    modification dates, the trapping flag and every custom entry.
// 2. The document's XMP metadata stream, and every other XMP stream (on pages, pictures, fonts, color profiles,
//    attachments, form drawings, structure elements).
// 3. Application data stored with pages and drawings (/PieceInfo: an editor's private copy of what it made, which can
//    hold far more than the page shows) and the dates it is kept with (/LastModified).
// 4. Page thumbnails (/Thumb), small pictures of the pages as they once were.
// 5. Web capture information (/SpiderInfo), the addresses and times pages were captured from.
// 6. Metadata inside JPEG pictures: EXIF (camera, dates, GPS location), XMP, IPTC and Photoshop data, comments,
//    embedded thumbnails and anything after the picture's end, such as a second picture a camera adds. The compressed
//    picture data is not touched, so the picture is exactly the same.
// 7. The file identifier (/ID), which ties copies of a file together: replaced by one made from the result itself.
// The result is written whole, so earlier versions kept inside the file (incremental updates) and objects nothing uses
// any more are not kept either (the page cleanup's sweep, ./structure.ts).
//
// Kept, since they are what the document is or does: everything on the pages (text, pictures, drawings), comments and
// other annotations with their authors and dates, bookmarks, links, form fields and their values, attachments, layers,
// accessibility tags, page labels, scripts, and digital signatures with the signer's name and certificate. The result
// says which of these the file has: removing metadata does not make a document anonymous.

import type { PDFDict as PDFDictT, PDFDocument as PDFDocumentT, PDFRawStream as PDFRawStreamT, PDFRef as PDFRefT } from '@cantoo/pdf-lib';

type Lib = typeof import('@cantoo/pdf-lib');

/** What a PDF holds, counted before and removed after. */
export interface MetadataReport {
  /** Entries in the document information dictionary, by name ("Title", "Author", or a custom name). */
  info: string[];
  /** The document's XMP metadata. */
  xmp: boolean;
  /** XMP streams elsewhere: pages, pictures, fonts. */
  objectXmp: number;
  /** Application data (/PieceInfo) and its dates (/LastModified). */
  pieceInfo: number;
  lastModified: number;
  thumbnails: number;
  spiderInfo: boolean;
  /** JPEG pictures that carried metadata, and what kinds. */
  jpegs: number;
  jpegKinds: string[];
  /** JPEG pictures behind another filter, which are not opened. */
  jpegsUnread: number;
  /** A file identifier. */
  id: boolean;
  /** The XMP said the file conforms to PDF/A or PDF/UA, which need it. */
  pdfa: boolean;
  pdfua: boolean;
  /** What stays, for the result's warnings. */
  stays: { authoredNotes: number; attachments: number; formValues: number; signatures: number; scripts: boolean };
}

const META_KEYS = ['Metadata', 'PieceInfo', 'LastModified'] as const;
const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');
const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const starts = (b: Uint8Array, at: number, s: string) => at + s.length <= b.length && latin1.decode(b.subarray(at, at + s.length)) === s;

/**
 * A JPEG without the segments that carry metadata, or null when it has none to remove or cannot be followed to its end
 * (then it is left as it is). Kept: JFIF (APP0), the color profile (APP2 ICC_PROFILE) and Adobe's color transform flag
 * (APP14), which decoders use; every table, frame and scan, byte for byte.
 */
export function stripJpeg(b: Uint8Array): { bytes: Uint8Array; kinds: string[] } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  const kinds = new Set<string>();
  let p = 2;
  let ended = false;
  while (p + 1 < b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) { parts.push(b.subarray(p, p + 2)); p += 2; ended = true; break; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { parts.push(b.subarray(p, p + 2)); p += 2; continue; }
    if (p + 4 > b.length) return null;
    const end = p + 2 + u16(b, p + 2);
    if (end > b.length || end < p + 4) return null;
    if (m === 0xda) {
      // The entropy-coded data runs to the next marker that is not a stuffed zero or a restart.
      let q = end;
      for (;;) {
        q = b.indexOf(0xff, q);
        if (q < 0 || q + 1 >= b.length) return null;
        const n = b[q + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { q += 2; continue; }
        if (n === 0xff) { q += 1; continue; }
        break;
      }
      parts.push(b.subarray(p, q));
      p = q;
      continue;
    }
    const body = p + 4;
    let drop: string | null = null;
    if (m === 0xfe) drop = 'comments';
    else if (m === 0xe0) drop = starts(b, body, 'JFIF\0') ? null : starts(b, body, 'JFXX\0') ? 'thumbnails' : 'other data';
    else if (m === 0xe1) drop = starts(b, body, 'Exif\0') ? 'EXIF' : starts(b, body, 'http://ns.adobe.com/') ? 'XMP' : 'other data';
    else if (m === 0xe2) drop = starts(b, body, 'ICC_PROFILE\0') ? null : starts(b, body, 'MPF\0') ? 'extra pictures' : 'other data';
    else if (m === 0xed) drop = 'IPTC and Photoshop data';
    else if (m === 0xee) drop = starts(b, body, 'Adobe') ? null : 'other data';
    else if (m >= 0xe3 && m <= 0xef) drop = 'other data';
    if (drop) kinds.add(drop); else parts.push(b.subarray(p, end));
    p = end;
  }
  if (!ended) return null;
  if (p < b.length) kinds.add('data after the picture');
  if (!kinds.size) return null;
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return { bytes: out, kinds: [...kinds] };
}

/** Walks every object the document reaches, direct or not, once. `visit` sees each dictionary (a stream's too). */
function walk(doc: PDFDocumentT, L: Lib, visit: (d: PDFDictT, stream: PDFRawStreamT | null, ref: PDFRefT | null) => void): void {
  const { PDFRef, PDFDict, PDFArray, PDFRawStream } = L;
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: Array<[unknown, PDFRefT | null]> = [];
  for (const k of ['Root', 'Info'] as const) { const v = ctx.trailerInfo[k]; if (v) stack.push([v, null]); }
  while (stack.length) {
    const [o, from] = stack.pop()!;
    if (o instanceof PDFRef) {
      const key = String(o);
      if (seen.has(key)) continue;
      seen.add(key);
      const t = ctx.lookup(o);
      if (t !== undefined) stack.push([t, o]);
    } else if (o instanceof PDFRawStream) {
      visit(o.dict, o, from);
      for (const [, v] of o.dict.entries()) stack.push([v, null]);
    } else if (o instanceof PDFDict) {
      visit(o, null, from);
      for (const [, v] of o.entries()) stack.push([v, null]);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push([o.get(i), null]);
    }
  }
}

const MARKUP = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'FileAttachment', 'Sound', 'Redact']);

/** Counts what removeMetadata would remove, and what stays, without changing anything. */
export function findMetadata(doc: PDFDocumentT, L: Lib): MetadataReport {
  return scan(doc, L, false);
}

/** Removes the metadata (see the top of this file) and reports what there was. Run cleanDocument and write the file
 *  whole afterwards, then give it a new identifier (newFileId). */
export function removeMetadata(doc: PDFDocumentT, L: Lib): MetadataReport {
  return scan(doc, L, true);
}

function scan(doc: PDFDocumentT, L: Lib, remove: boolean): MetadataReport {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFHexString, decodePDFRawStream } = L;
  const N = (s: string) => PDFName.of(s);
  const ctx = doc.context;
  const r: MetadataReport = {
    info: [], xmp: false, objectXmp: 0, pieceInfo: 0, lastModified: 0, thumbnails: 0, spiderInfo: false,
    jpegs: 0, jpegKinds: [], jpegsUnread: 0, id: !!ctx.trailerInfo.ID, pdfa: false, pdfua: false,
    stays: { authoredNotes: 0, attachments: 0, formValues: 0, signatures: 0, scripts: false },
  };
  const info = ctx.trailerInfo.Info ? ctx.lookup(ctx.trailerInfo.Info) : undefined;
  if (info instanceof PDFDict) r.info = info.keys().map(k => k.asString().slice(1));
  const cat = doc.catalog;
  const docXmp = cat.lookup(N('Metadata'));
  if (docXmp instanceof PDFRawStream) {
    r.xmp = true;
    try {
      const text = latin1.decode(decodePDFRawStream(docXmp).decode());
      r.pdfa = /pdfaid:part|pdfaid\/|<pdfaid:/i.test(text);
      r.pdfua = /pdfuaid:part|<pdfuaid:/i.test(text);
    } catch { /* unreadable XMP: removed all the same */ }
  }
  r.spiderInfo = cat.get(N('SpiderInfo')) !== undefined;
  r.stays.scripts = (cat.lookupMaybe(N('Names'), PDFDict)?.get(N('JavaScript')) ?? undefined) !== undefined;
  const kinds = new Set<string>();
  const cleanup: Array<[PDFDictT, boolean]> = [];
  const jpegs: Array<[PDFRefT, PDFRawStreamT, Uint8Array]> = [];
  walk(doc, L, (d, stream, ref) => {
    if (d !== cat && d.get(N('Metadata')) !== undefined) r.objectXmp++;
    if (d.get(N('PieceInfo')) !== undefined) r.pieceInfo++;
    if (d.get(N('LastModified')) !== undefined) r.lastModified++;
    const type = d.lookup(N('Type'));
    if (type === N('Page') && d.get(N('Thumb')) !== undefined) r.thumbnails++;
    const sub = d.lookup(N('Subtype'));
    if (sub instanceof PDFName && MARKUP.has(sub.asString().slice(1)) && d.lookup(N('T')) !== undefined) r.stays.authoredNotes++;
    if (type === N('EmbeddedFile')) r.stays.attachments++;
    if (d.lookup(N('FT')) instanceof PDFName && d.get(N('V')) !== undefined) {
      if (d.lookup(N('FT')) === N('Sig')) r.stays.signatures++; else r.stays.formValues++;
    }
    if (stream && ref && sub === N('Image')) {
      const f = d.lookup(N('Filter'));
      const only = f === N('DCTDecode') || f === N('DCT') || (f instanceof PDFArray && f.size() === 1 && (f.lookup(0) === N('DCTDecode') || f.lookup(0) === N('DCT')));
      const has = f === N('DCTDecode') || f === N('DCT') || (f instanceof PDFArray && Array.from({ length: f.size() }, (_, i) => f.lookup(i)).some(x => x === N('DCTDecode') || x === N('DCT')));
      if (only) {
        const s = stripJpeg(stream.getContents());
        if (s) { r.jpegs++; s.kinds.forEach(k => kinds.add(k)); if (remove) jpegs.push([ref, stream, s.bytes]); }
      } else if (has) r.jpegsUnread++;
    }
    // Removed after the walk, so what is inside application data is counted the same way as when only finding.
    if (remove) cleanup.push([d, type === N('Page')]);
  });
  r.jpegKinds = [...kinds].sort();
  if (remove) {
    for (const [d, page] of cleanup) {
      for (const k of META_KEYS) if (d !== cat || k !== 'Metadata') d.delete(N(k));
      if (page) d.delete(N('Thumb'));
    }
    if (info) ctx.trailerInfo.Info = undefined;
    cat.delete(N('Metadata'));
    cat.delete(N('SpiderInfo'));
    for (const [ref, old, bytes] of jpegs) ctx.assign(ref, PDFRawStream.of(old.dict, bytes));
    // A placeholder identifier the same length as the final one (newFileId writes it once the file is made).
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(ID_PLACEHOLDER), PDFHexString.of(ID_PLACEHOLDER)]);
  }
  return r;
}

const ID_PLACEHOLDER = '0'.repeat(32);

/**
 * Gives a written PDF a new file identifier made from its own bytes: the SHA-256 of the file with the placeholder in
 * place, first 16 bytes, as both halves of /ID. The same input always gives the same result, and nothing of the old
 * identifier remains. The identifier is the same length as the placeholder, so no offset in the file moves.
 */
export async function newFileId(bytes: Uint8Array): Promise<Uint8Array> {
  const needle = enc.encode(`<${ID_PLACEHOLDER}>`);
  const at: number[] = [];
  // The trailer is at the end of the file: look there first, from the end.
  for (let i = bytes.length - needle.length; i >= 0 && at.length < 2; i--) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) { ok = false; break; }
    if (ok) at.push(i);
  }
  if (at.length < 2) throw new Error('The new file identifier could not be written.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  const hex = enc.encode(Array.from(digest.subarray(0, 16), x => x.toString(16).padStart(2, '0')).join('').toUpperCase());
  const out = bytes.slice();
  for (const i of at) out.set(hex, i + 1);
  return out;
}
