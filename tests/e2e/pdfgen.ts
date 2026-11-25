// Small PDFs written for the memory tests, with no PDF library: pictures of random pixels (one per page, or one shared
// by every page), a tiny file whose object stream holds one huge array, and form-heavy pages.
import { randomBytes } from 'node:crypto';
import { zlibSync } from 'fflate';

const MB = 1048576;
const enc = (s: string) => Buffer.from(s, 'latin1');

/** A PDF of numbered objects (bodies as bytes), with a cross-reference table. */
export function pdf(objs: Record<number, Buffer>): Buffer {
  const parts: Buffer[] = [enc('%PDF-1.7\n')];
  const offs: Record<number, number> = {};
  let at = parts[0].length;
  const keys = Object.keys(objs).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    offs[k] = at;
    const b = Buffer.concat([enc(`${k} 0 obj\n`), objs[k], enc('\nendobj\n')]);
    parts.push(b);
    at += b.length;
  }
  const size = Math.max(...keys) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) xref += offs[k] !== undefined ? `${String(offs[k]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  parts.push(enc(xref + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}
export const stream = (data: Buffer, dict = '') => Buffer.concat([enc(`<< /Length ${data.length}${dict} >>\nstream\n`), data, enc('\nendstream')]);

/** Pages that each draw a picture of random pixels: `shared` draws one picture on every page. */
export function pictures(pages: number, pictureMB: number, shared = false): Buffer {
  const side = Math.round(Math.sqrt(pictureMB * MB / 3));
  const objs: Record<number, Buffer> = { 1: enc('<< /Type /Catalog /Pages 2 0 R >>') };
  const kids: number[] = [];
  const picture = () => stream(Buffer.from(randomBytes(side * side * 3)), ` /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8`);
  if (shared) objs[3] = picture();
  for (let i = 0; i < pages; i++) {
    const n = 10 + 3 * i;
    if (!shared) objs[n + 2] = picture();
    objs[n + 1] = stream(enc(`q 200 0 0 200 50 50 cm /Im0 Do Q BT /F1 12 Tf 72 20 Td (Page ${i + 1}) Tj ET`));
    objs[n] = enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im0 ${shared ? 3 : n + 2} 0 R >> /Font << /F1 4 0 R >> >> /Contents ${n + 1} 0 R >>`);
    kids.push(n);
  }
  objs[4] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objs[2] = enc(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${pages} >>`);
  return pdf(objs);
}

/** One page, plus an object stream holding one array of `millions` million zeros: a tiny file the guard passes, which
 *  the editing library would turn into that many objects. */
export function giantArray(millions: number): Buffer {
  const body = enc(`10 0 [${'0 '.repeat(millions * 1_000_000)}]`);
  const z = Buffer.from(zlibSync(body, { level: 9 }));
  return pdf({
    1: enc('<< /Type /Catalog /Pages 2 0 R >>'),
    2: enc('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    3: enc('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>'),
    11: stream(z, ' /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode'),
  });
}

/** Form-heavy: `pages` pages of 40 text fields, each with a value and an appearance. */
export function forms(pages: number): Buffer {
  const objs: Record<number, Buffer> = { 3: enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') };
  const kids: number[] = [];
  const fields: number[] = [];
  let n = 10;
  for (let p = 0; p < pages; p++) {
    const pg = n++;
    const c = n++;
    objs[c] = stream(enc(`BT /F1 9 Tf 40 280 Td (Form page ${p + 1}) Tj ET`));
    const annots: number[] = [];
    for (let f = 0; f < 40; f++) {
      const ap = n++, w = n++;
      objs[ap] = stream(enc(`/Tx BMC BT /F1 9 Tf 2 4 Td (value ${p}-${f}) Tj ET EMC`), ' /Type /XObject /Subtype /Form /BBox [0 0 200 6] /Resources << /Font << /F1 3 0 R >> >>');
      objs[w] = enc(`<< /FT /Tx /T (f${p}_${f}) /V (value ${p}-${f}) /Type /Annot /Subtype /Widget /Rect [50 ${270 - f * 6} 250 ${276 - f * 6}] /P ${pg} 0 R /F 4 /AP << /N ${ap} 0 R >> >>`);
      annots.push(w); fields.push(w);
    }
    objs[pg] = enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R /Annots [${annots.map(a => `${a} 0 R`).join(' ')}] >>`);
    kids.push(pg);
  }
  objs[1] = enc(`<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${fields.map(f => `${f} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >> >>`);
  objs[2] = enc(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${pages} >>`);
  return pdf(objs);
}

/** `pages` small pages, each with its number as text ("Page 1"), so the order of the pages can be read back. */
export function numbered(pages: number): Buffer {
  const objs: Record<number, Buffer> = { 1: enc('<< /Type /Catalog /Pages 2 0 R >>'), 3: enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') };
  const kids: number[] = [];
  for (let i = 0; i < pages; i++) {
    const n = 10 + 2 * i;
    objs[n + 1] = stream(enc(`BT /F1 24 Tf 40 120 Td (Page ${i + 1}) Tj ET`));
    objs[n] = enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`);
    kids.push(n);
  }
  objs[2] = enc(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${pages} >>`);
  return pdf(objs);
}
