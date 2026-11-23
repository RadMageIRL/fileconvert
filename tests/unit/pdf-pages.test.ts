import type { PDFDict, PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, test } from 'vitest';
import { Merger, takePages } from '../../src/engines/pdf/merge';
import { keepPages, openPdf, pageRefs, pdfLib, rotatePages, savePdf } from '../../src/engines/pdf/structure';
import { content, everything, fx, page, pdfFrom, read } from './pdf-helpers';

// Split, extract, delete, reorder and rotate (v0.2.0, Phase 2), at the engine. Split and extract copy only the pages
// taken into a new document (takePages); delete and reorder edit in place (keepPages); rotate turns pages in place.
// The browser tests read every result with qpdf, pypdf, PDFium and pdftotext.

const SECRETS = ['PAGE-TWO-SECRET', 'OLD-REVISION-SECRET', 'ANNOT-SECRET', 'FIELD-SECRET', 'OUTLINE-SECRET', 'TAG-SECRET', 'THREAD-SECRET', 'PIECE-SECRET', 'secret-two', 'secretfield'];

async function taken(file: string, pages: number[]) {
  const { doc, report } = await takePages(await openPdf(fx(file)), file, pages);
  const bytes = await savePdf(doc);
  const L = await pdfLib();
  return { report, bytes, out: await L.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity }) };
}

async function pageDict(doc: PDFDocument, i: number): Promise<PDFDict> {
  const L = await pdfLib();
  return doc.context.lookup(pageRefs(doc, L)[i], L.PDFDict);
}

describe('taking some pages into a new PDF (split, extract)', () => {
  test('nothing of a page left out is in the result; what pointed only at it is removed and counted', async () => {
    for (const file of ['markers.pdf', 'markers-objstm.pdf']) {
      const { report, bytes, out } = await taken(file, [0, 2, 3]);
      const all = await everything(bytes);
      for (const s of SECRETS) expect(all, `${file}: ${s}`).not.toContain(s);
      // Named destinations are written as they read (keep-one), so the search for secret-two above means something.
      for (const k of ['Page one keep', 'Page three keep', 'Page four keep', 'field kept', '(keep-one)']) expect(all, k).toContain(k);
      const f = report.files[0];
      expect([f.pages, f.linksRemoved, f.bookmarksRemoved, f.destinationsRemoved, f.unresolved]).toEqual([3, 1, 1, 1, 0]);
      expect(f.dropped.sort()).toEqual(['labels', 'tags', 'threads']);
      const r = await read(out);
      expect(r.pageObjects).toBe(3);
      // Page 3's link to page 1 stays and goes to the new page 1.
      expect(r.outline).toEqual([['Page one', 0]]);
      expect(Object.keys(r.fields)).toEqual(['keepfield']);
      expect(r.dests).toEqual({ 'keep-one': 0 });
      expect(all.match(/%%EOF/g)).toHaveLength(1);
    }
  });

  test('pages in a new order: links, bookmarks and named destinations follow their pages; the rest go', async () => {
    // merge-a page 3, then page 1: page 2 is left out.
    const { report, out } = await taken('merge-a.pdf', [2, 0]);
    const r = await read(out);
    expect(r.outline).toEqual([['Chapter A1', 1, [['Section A1.1', 1]], 1], ['Closed A3', 0, [['A3 child', 0]], -1], ['Web link', '/URI']]);
    expect(r.dests).toEqual({ 'a-sec': 1, shared: 0 });
    const f = report.files[0];
    // Chapter A2 and the named destination a-two were on page 2; page 1's link to it by name goes too.
    expect([f.bookmarksRemoved, f.destinationsRemoved, f.linksRemoved]).toEqual([1, 1, 1]);
    const L = await pdfLib();
    const links = (await pageDict(out, 1)).lookup(L.PDFName.of('Annots'), L.PDFArray).asArray().map(a => r.look(a) as PDFDict);
    expect(links.map(a => (a.get(L.PDFName.of('Dest')) !== undefined ? r.target(a.get(L.PDFName.of('Dest'))) : 'uri'))).toEqual([0, 'uri']);
    // The radio group keeps its value and the one button on the page taken.
    expect(r.fields.choice).toEqual({ value: 'B', da: '/Helv 0 Tf 0 g' });
    expect(String((await pageDict(out, 0)).get(L.PDFName.of('Rotate')))).toBe('180');
  });

  test('a split into single pages: each part holds its page and only what belongs to it', async () => {
    const open = await openPdf(fx('merge-a.pdf'));
    const parts = [];
    for (const i of [0, 1, 2]) {
      const { doc, report } = await takePages(open, 'merge-a.pdf', [i]);
      parts.push({ report, bytes: await savePdf(doc) });
    }
    const L = await pdfLib();
    const fields = await Promise.all(parts.map(async p => Object.keys((await read(await L.PDFDocument.load(p.bytes, { parseSpeed: Infinity }))).fields)));
    expect(fields).toEqual([[], ['name', 'agree', 'choice', 'color'], ['choice']]);
    expect(parts.map(p => p.report.pages)).toEqual([1, 1, 1]);
    // The same part made twice is the same bytes.
    const again = await takePages(await openPdf(fx('merge-a.pdf')), 'merge-a.pdf', [1]);
    expect(Buffer.from(await savePdf(again.doc)).equals(Buffer.from(parts[1].bytes))).toBe(true);
  });

  test('a link whose GoTo action goes to a page left out comes off its page', async () => {
    // markers page 3 links to page 1 by a GoTo action; page 3 alone keeps no link.
    const { report, out } = await taken('markers.pdf', [2]);
    const L = await pdfLib();
    expect((await pageDict(out, 0)).lookup(L.PDFName.of('Annots'))?.toString() ?? '[ ]').toBe('[ ]');
    expect(report.files[0].linksRemoved).toBe(1);
  });

  test('a page list that is empty, repeats a page or names one that does not exist is refused', async () => {
    const open = await openPdf(fx('merge-a.pdf'));
    await expect(takePages(open, 'a', [])).rejects.toThrow('At least one page has to be taken.');
    await expect(takePages(open, 'a', [0, 0])).rejects.toThrow('A page can be taken only once.');
    await expect(takePages(open, 'a', [3])).rejects.toThrow('There is no page 4; the PDF has 3.');
  });
});

describe('deleting and reordering in place', () => {
  test('deleting every page is refused; deleting some leaves nothing of them', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('merge-a.pdf'));
    expect(() => keepPages(doc, L, [])).toThrow('At least one page has to stay.');
    const m = await openPdf(fx('markers.pdf'));
    const r = keepPages(m.doc, L, [0, 2, 3]);
    expect(r.pagesRemoved).toBe(1);
    const all = await everything(await savePdf(m.doc));
    for (const s of SECRETS) expect(all, s).not.toContain(s);
  });

  test('a link and a bookmark that name a deleted page (not point at it) go with it', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('merge-a.pdf'));
    // merge-a page 1 links to page 2 through the named destination a-two; bookmark Chapter A2 goes there by a GoTo action.
    const r = keepPages(doc, L, [0, 2]);
    expect([r.linksRemoved, r.outlineItemsRemoved, r.destinationsRemoved]).toEqual([1, 1, 1]);
    const out = await L.PDFDocument.load(await savePdf(doc), { parseSpeed: Infinity });
    const read1 = await read(out);
    expect(read1.outline).toEqual([['Chapter A1', 0, [['Section A1.1', 0]], 1], ['Closed A3', 1, [['A3 child', 1]], -1], ['Web link', '/URI']]);
    const links = (await pageDict(out, 0)).lookup(L.PDFName.of('Annots'), L.PDFArray).asArray().map(a => read1.look(a) as PDFDict);
    expect(links.map(a => (a.get(L.PDFName.of('Dest')) !== undefined ? read1.target(a.get(L.PDFName.of('Dest'))) : 'uri'))).toEqual([1, 'uri']);
  });

  test('reordering keeps every link, bookmark and destination on its own page, wherever that page went', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('merge-a.pdf'));
    keepPages(doc, L, [2, 1, 0]);
    const out = await L.PDFDocument.load(await savePdf(doc), { parseSpeed: Infinity });
    const r = await read(out);
    expect(r.outline).toEqual([['Chapter A1', 2, [['Section A1.1', 2]], 1], ['Chapter A2', 1], ['Closed A3', 0, [['A3 child', 0]], -1], ['Web link', '/URI']]);
    expect(r.dests).toEqual({ 'a-two': 1, shared: 0 });
    expect(Object.keys(r.fields).sort()).toEqual(['agree', 'choice', 'color', 'name']);
  });
});

describe('form fields named by the calculation order', () => {
  // Page 2's field is listed in /CO; once page 2 goes, neither the field nor its value may stay through /CO.
  const withCO = () => pdfFrom({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] /CO [6 0 R 5 0 R] >> >>',
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    3: page(7, ' /Annots [5 0 R]'), 4: page(8, ' /Annots [6 0 R]'), 7: content('0 0 m'), 8: content('0 0 m'),
    5: '<< /FT /Tx /T (kept) /V (KEPT-VALUE) /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 3 0 R >>',
    6: '<< /FT /Tx /T (gone) /V (GONE-SECRET) /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 4 0 R >>',
  });
  const coOf = async (bytes: Uint8Array) => {
    const L = await pdfLib();
    const doc = await L.PDFDocument.load(bytes, { parseSpeed: Infinity });
    const r = await read(doc);
    const co = r.af!.lookup(L.PDFName.of('CO'), L.PDFArray).asArray().map(x => r.str((r.look(x) as PDFDict).get(L.PDFName.of('T'))));
    return { co, fields: Object.keys(r.fields), all: await everything(bytes) };
  };
  test('deleting the page in place', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(withCO());
    keepPages(doc, L, [0]);
    const r = await coOf(await savePdf(doc));
    expect([r.co, r.fields]).toEqual([['kept'], ['kept']]);
    expect(r.all).not.toContain('GONE-SECRET');
  });
  test('taking the other page into a new PDF', async () => {
    const { doc, report } = await takePages(await openPdf(withCO()), 'co.pdf', [0]);
    // The other page's field is never copied (nothing to sweep afterwards): splitting a large form stays cheap.
    expect(report.clean.objectsRemoved).toBe(0);
    const r = await coOf(await savePdf(doc));
    expect([r.co, r.fields]).toEqual([['kept'], ['kept']]);
    expect(r.all).not.toContain('GONE-SECRET');
  });
});

describe('rotating pages', () => {
  test('turns add to the rotation a page has, inherited or its own; the rest of the page is unchanged', async () => {
    const L = await pdfLib();
    const rot = async (pages: number[], by: number) => {
      const { doc } = await openPdf(fx('merge-a.pdf'));
      const report = rotatePages(doc, L, pages, by);
      const out = await L.PDFDocument.load(await savePdf(doc), { parseSpeed: Infinity });
      return { report, rot: await Promise.all([0, 1, 2].map(async i => String((await pageDict(out, i)).get(L.PDFName.of('Rotate')) ?? 0))), out };
    };
    // Page 3 inherits 180 from its page tree node.
    expect((await rot([0, 2], 90)).rot).toEqual(['90', '0', '270']);
    expect((await rot([0, 1, 2], 270)).rot).toEqual(['270', '270', '90']);
    expect((await rot([2], 180)).rot).toEqual(['0', '0', '0']);
    const { out, report } = await rot([1], 90);
    expect(report).toMatchObject({ rotated: 1, invalid: 0 });
    const r = await read(out);
    expect(Object.keys(r.fields)).toEqual(['name', 'agree', 'choice', 'color']);
    expect((await pageDict(out, 1)).lookup(L.PDFName.of('MediaBox'), L.PDFArray).asArray().map(String)).toEqual(['0', '0', '612', '792']);
  });

  test('the cleanup runs after turning: each page lists only the resources it draws', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('markers.pdf'));
    const r = rotatePages(doc, L, [0], 90);
    expect(r.clean.resourcesPruned).toBeGreaterThan(0);
    const xobjects = (await pageDict(doc, 0)).lookup(L.PDFName.of('Resources'), L.PDFDict).lookup(L.PDFName.of('XObject'), L.PDFDict);
    expect(xobjects.keys().map(String)).toEqual(['/ImKeep']);
  });

  test('a rotation that is not a quarter turn counts as upright; bad requests are refused', async () => {
    const L = await pdfLib();
    const odd = pdfFrom({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(4, ' /Rotate 45'), 4: content('0 0 m') });
    const { doc } = await openPdf(odd);
    expect(rotatePages(doc, L, [0], 90)).toMatchObject({ rotated: 1, invalid: 1 });
    expect(String(doc.context.lookup(pageRefs(doc, L)[0], L.PDFDict).get(L.PDFName.of('Rotate')))).toBe('90');
    expect(() => rotatePages(doc, L, [0], 45)).toThrow('Pages turn by 90, 180 or 270 degrees.');
    expect(() => rotatePages(doc, L, [], 90)).toThrow('Choose at least one page to turn.');
    expect(() => rotatePages(doc, L, [0, 0], 90)).toThrow('A page can be turned only once.');
    expect(() => rotatePages(doc, L, [1], 90)).toThrow('There is no page 2; the PDF has 1.');
  });
});

describe('names that clash, and the same result for the same input', () => {
  // Three files using the same names, some already carrying the suffix a rename would give.
  const form = (fields: string[], font: string, dests: string[]) => {
    const objs: Record<number, string> = {
      1: `<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [${dests.map(d => `(${d}) [3 0 R /Fit]`).join(' ')}] >> >> /AcroForm << /Fields [${fields.map((_, i) => `${10 + i} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>`,
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: page(4, ` /Annots [${fields.map((_, i) => `${10 + i} 0 R`).join(' ')}]`), 4: content('0 0 m'),
      5: `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
    };
    fields.forEach((f, i) => { objs[10 + i] = `<< /FT /Tx /T (${f}) /V (${f}-value) /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 3 0 R >>`; });
    return pdfFrom(objs);
  };
  const files: Array<[string, Uint8Array]> = [
    ['a.pdf', form(['name', 'name_2'], 'Helvetica', ['intro'])],
    ['b.pdf', form(['name', 'name_2'], 'Courier', ['intro', 'intro_2'])],
    ['c.pdf', form(['name', 'name_3'], 'Times-Roman', ['intro'])],
  ];
  const mergeAll = async () => {
    const m = await Merger.create();
    for (const [n, b] of files) m.add(await openPdf(b), n);
    const report = m.finish();
    return { report, bytes: await savePdf(m.doc) };
  };

  test('names without a clash stay; clashes take the file number, then a counter; nothing is overwritten', async () => {
    const { report, bytes } = await mergeAll();
    const L = await pdfLib();
    const out = await L.PDFDocument.load(bytes, { parseSpeed: Infinity });
    const r = await read(out);
    expect(Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, [v.value, v.da]]))).toEqual({
      name: ['name-value', '/Helv 0 Tf 0 g'], name_2: ['name_2-value', '/Helv 0 Tf 0 g'],
      name_2_2: ['name-value', '/Helv_2 0 Tf 0 g'], name_2_2_2: ['name_2-value', '/Helv_2 0 Tf 0 g'],
      name_3_2: ['name-value', '/Helv_3 0 Tf 0 g'], name_3: ['name_3-value', '/Helv_3 0 Tf 0 g'],
    });
    expect(report.files.map(f => f.renamed)).toEqual([
      [],
      [{ from: 'name', to: 'name_2_2' }, { from: 'name_2', to: 'name_2_2_2' }],
      [{ from: 'name', to: 'name_3_2' }],
    ]);
    expect(r.dests).toEqual({ intro: 0, intro_2: 1, intro_2_2: 1, intro_3: 2 });
    const fonts = r.af!.lookup(r.N('DR'), L.PDFDict).lookup(r.N('Font'), L.PDFDict);
    expect(Object.fromEntries(fonts.keys().map(k => [k.decodeText(), String(fonts.lookup(k, L.PDFDict).get(r.N('BaseFont')))]))).toEqual({ Helv: '/Helvetica', Helv_2: '/Courier', Helv_3: '/Times-Roman' });
  });

  test('the same files in the same order give the same bytes', async () => {
    const one = await mergeAll();
    const two = await mergeAll();
    expect(Buffer.from(one.bytes).equals(Buffer.from(two.bytes))).toBe(true);
  });
});
