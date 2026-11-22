import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { describe, expect, test } from 'vitest';
import { keepPages, openPdf, pageRefs, pdfLib, savePdf } from '../../src/engines/pdf/structure';

// Removing pages leaves nothing of them in the file (v0.2.0, Phase 2). markers.pdf puts a distinctive mark in every
// place page 2's content can hide; after page 2 is removed, every object of the result is decoded and searched. The
// browser tests repeat this with qpdf, PDFium, pypdf and pdftotext reading the results.

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const SECRETS = ['PAGE-TWO-SECRET', 'OLD-REVISION-SECRET', 'ANNOT-SECRET', 'FIELD-SECRET', 'OUTLINE-SECRET', 'TAG-SECRET', 'THREAD-SECRET', 'PIECE-SECRET', 'secret-two', 'secretfield'];
const KEPT = ['Page one keep', 'Page three keep', 'Page four keep', 'field kept', 'keep-one'];
const PIXELS = fx('pdf/markers-secret-pixels.bin').subarray(1000, 1064);

/** Every object of a PDF as text, with each stream decoded, plus the raw bytes; read back by the same library. */
async function everything(bytes: Uint8Array): Promise<{ text: string; streams: Uint8Array[] }> {
  const L = await pdfLib();
  const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
  const streams: Uint8Array[] = [];
  let text = new TextDecoder('latin1').decode(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    text += '\n' + obj.toString();
    if (obj instanceof L.PDFRawStream) {
      const d = L.decodePDFRawStream(obj).decode();
      streams.push(d);
      text += '\n' + new TextDecoder('latin1').decode(d);
    }
  }
  return { text, streams };
}
const hasBytes = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = hay.indexOf(needle[0]); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(needle[0], i + 1)) {
    for (let k = 1; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
};

describe('removing pages removes everything of them', () => {
  for (const file of ['markers', 'markers-objstm']) {
    test(`${file}: page 2 removed, nothing of it left; everything else kept`, async () => {
      const L = await pdfLib();
      const { doc } = await openPdf(fx(`pdf/${file}.pdf`));
      const r = keepPages(doc, L, [0, 2, 3]);
      expect(r).toMatchObject({
        pages: 3, pagesRemoved: 1, linksRemoved: 1, outlineItemsRemoved: 1, destinationsRemoved: 1, formFieldsRemoved: 1,
        tagsRemoved: true, labelsRemoved: true, threadsRemoved: true, unreadContent: 0,
      });
      // The secret picture was listed in resources all pages share; the remaining pages do not draw it.
      expect(r.resourcesPruned).toBeGreaterThanOrEqual(3);
      const out = await savePdf(doc);
      const all = await everything(out);
      for (const s of SECRETS) expect(all.text, s).not.toContain(s);
      for (const k of KEPT) expect(all.text, k).toContain(k);
      expect(all.streams.some(s => hasBytes(s, PIXELS))).toBe(false);
      expect(hasBytes(out, PIXELS)).toBe(false);
      // Written whole: one revision, no update section.
      expect(new TextDecoder('latin1').decode(out).match(/%%EOF/g)).toHaveLength(1);
    });
  }

  test('a form XObject and an annotation appearance that list the shared resources keep only what they draw', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('pdf/markers.pdf'));
    const ctx = doc.context;
    const N = (s: string) => L.PDFName.of(s);
    // The resources every page inherits, which hold the secret picture.
    const shared = doc.catalog.lookup(N('Pages'), L.PDFDict).get(N('Resources')) as PDFRef;
    const form = ctx.register(ctx.flateStream('q 16 0 0 16 0 0 cm /ImKeep Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 16, 16], Resources: shared }));
    ctx.lookup(shared, L.PDFDict).lookup(N('XObject'), L.PDFDict).set(N('Fm1'), form);
    const page1 = ctx.lookup(pageRefs(doc, L)[0], L.PDFDict);
    page1.set(N('Contents'), ctx.obj([page1.get(N('Contents'))!, ctx.register(ctx.flateStream('q 1 0 0 1 300 300 cm /Fm1 Do Q'))]));
    // The kept field's appearance stream points at the same resources.
    const widget = page1.lookup(N('Annots'), L.PDFArray).lookup(1, L.PDFDict);
    const appearance = widget.lookup(N('AP'), L.PDFDict).lookup(N('N')) as PDFRawStream;
    appearance.dict.set(N('Resources'), shared);
    const r = keepPages(doc, L, [0, 2, 3]);
    expect(r.unreadContent).toBe(0);
    const out = await savePdf(doc);
    const all = await everything(out);
    expect(all.streams.some(s => hasBytes(s, PIXELS))).toBe(false);
    expect(hasBytes(out, PIXELS)).toBe(false);
    // What they draw is still there: the form draws the kept picture, the appearance its font.
    const back = await L.PDFDocument.load(out);
    const fm = back.context.lookup(back.getPage(0).node.Resources()!.lookup(N('XObject'), L.PDFDict).get(N('Fm1'))!) as PDFRawStream;
    expect(fm.dict.lookup(N('Resources'), L.PDFDict).lookup(N('XObject'), L.PDFDict).keys().map(String)).toEqual(['/ImKeep']);
  });

  test('a reference to a removed page from something that stays is cleared, not followed', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('pdf/markers.pdf'));
    // An entry of the catalog that FileConvert knows nothing about, pointing at page 2.
    doc.catalog.set(L.PDFName.of('FileConvertTest'), pageRefs(doc, L)[1]);
    const r = keepPages(doc, L, [0, 2, 3]);
    expect(r.referencesCleared).toBe(1);
    const all = await everything(await savePdf(doc));
    expect(all.text).not.toContain('PAGE-TWO-SECRET');
    expect(all.text).toContain('/FileConvertTest null');
  });

  test('a widget or popup with /Contents and /Parent on a kept page is an annotation, not a stray page', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('pdf/markers.pdf'));
    const ctx = doc.context;
    const N = (s: string) => L.PDFName.of(s);
    const page1 = ctx.lookup(pageRefs(doc, L)[0], L.PDFDict);
    // A field whose widget has a tooltip (/Contents) and a parent, and a note's popup with text of its own.
    const field = ctx.register(ctx.obj({ FT: 'Tx', T: L.PDFString.of('tipfield'), V: L.PDFString.of('TIP-VALUE') }));
    const widget = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 50, 20], Parent: field, Contents: L.PDFString.of('A tooltip') }));
    ctx.lookup(field, L.PDFDict).set(N('Kids'), ctx.obj([widget]));
    const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 10, 10], Contents: L.PDFString.of('note') }));
    const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [0, 0, 90, 90], Parent: note, Contents: L.PDFString.of('POPUP-TEXT') }));
    ctx.lookup(note, L.PDFDict).set(N('Popup'), popup);
    for (const a of [widget, note, popup]) page1.lookup(N('Annots'), L.PDFArray).push(a);
    doc.catalog.lookup(N('AcroForm'), L.PDFDict).lookup(N('Fields'), L.PDFArray).push(field);
    const r = keepPages(doc, L, [0, 2, 3]);
    expect(r.referencesCleared).toBe(0);
    const back = await L.PDFDocument.load(await savePdf(doc), { parseSpeed: Infinity });
    const annots = back.getPage(0).node.Annots()!.asArray().map(a => back.context.lookup(a, L.PDFDict).get(N('Subtype'))?.toString());
    // The link to page 2 goes with it; everything else stays.
    expect(annots).toEqual(['/Widget', '/Widget', '/Text', '/Popup']);
    expect(back.getForm().getTextField('tipfield').getText()).toBe('TIP-VALUE');
  });

  test('bookmark counts are the entries shown: a closed entry\'s own entries do not count for the level above', async () => {
    const L = await pdfLib();
    const N = (s: string) => L.PDFName.of(s);
    const counts = (doc: Awaited<ReturnType<typeof openPdf>>['doc']) => {
      const out: Record<string, number> = {};
      const o = doc.catalog.lookup(N('Outlines'), L.PDFDict);
      out.root = o.lookup(N('Count'), L.PDFNumber).asNumber();
      for (let r = o.get(N('First')); r; ) {
        const it = doc.context.lookup(r, L.PDFDict);
        const c = it.lookup(N('Count'));
        if (c) out[(it.lookup(N('Title')) as unknown as { decodeText(): string }).decodeText()] = (c as unknown as { asNumber(): number }).asNumber();
        r = it.get(N('Next'));
      }
      return out;
    };
    // merge-a: Chapter A1 open with one entry, Closed A3 closed with one, two more at the top (its own root says 4).
    const whole = await openPdf(fx('pdf/merge-a.pdf'));
    keepPages(whole.doc, L, [0, 1, 2]);
    expect(counts(whole.doc)).toEqual({ root: 5, 'Chapter A1': 1, 'Closed A3': -1 });
    // Without page 3, Closed A3 and its entry go.
    const two = await openPdf(fx('pdf/merge-a.pdf'));
    keepPages(two.doc, L, [0, 1]);
    expect(counts(two.doc)).toEqual({ root: 4, 'Chapter A1': 1 });
  });

  test('reordering keeps every page and all of its content; only the page labels go', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('pdf/markers.pdf'));
    const r = keepPages(doc, L, [3, 2, 1, 0]);
    expect(r).toMatchObject({ pages: 4, pagesRemoved: 0, linksRemoved: 0, outlineItemsRemoved: 0, formFieldsRemoved: 0, tagsRemoved: false, labelsRemoved: true, threadsRemoved: false });
    const all = await everything(await savePdf(doc));
    for (const s of ['PAGE-TWO-SECRET', 'ANNOT-SECRET', 'FIELD-SECRET', 'OUTLINE-SECRET', 'TAG-SECRET', 'THREAD-SECRET']) expect(all.text, s).toContain(s);
    expect(all.text).not.toContain('OLD-REVISION-SECRET');
    expect(all.streams.some(s => hasBytes(s, PIXELS))).toBe(true);
    const back = await (await pdfLib()).PDFDocument.load(await savePdf(doc));
    expect(back.getPageCount()).toBe(4);
  });

  test('keeping one page keeps its own marks and drops the others\'', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('pdf/markers.pdf'));
    keepPages(doc, L, [1]);
    const all = await everything(await savePdf(doc));
    for (const s of ['PAGE-TWO-SECRET', 'FIELD-SECRET', 'OUTLINE-SECRET']) expect(all.text, s).toContain(s);
    for (const k of KEPT) expect(all.text, k).not.toContain(k);
  });

  test('a page kept twice, no page at all, and page numbers that do not exist, are refused before anything changes', async () => {
    const L = await pdfLib();
    const { doc } = await openPdf(fx('pdf/markers.pdf'));
    expect(() => keepPages(doc, L, [0, 4])).toThrow('There is no page 5; the PDF has 4.');
    expect(() => keepPages(doc, L, [0, 0, 2])).toThrow('A page can be kept only once.');
    expect(() => keepPages(doc, L, [])).toThrow('At least one page has to stay.');
  });
});

describe('opening a PDF for editing', () => {
  test('the guard runs first: bombs, encrypted files and loops are refused with a reason', async () => {
    await expect(openPdf(fx('pdf/bomb-objstm.pdf'))).rejects.toThrow(/object stream that expands past 256 MB/);
    await expect(openPdf(fx('pdf/encrypted-owner.pdf'))).rejects.toThrow(/^This PDF is encrypted, .* including ones that open without a password .* FileConvert never removes a PDF's protection/);
    await expect(openPdf(fx('pdf/encrypted-user.pdf'))).rejects.toThrow(/^This PDF is encrypted/);
    const L = await pdfLib();
    const loop = await openPdf(fx('pdf/page-loop.pdf'));
    expect(() => pageRefs(loop.doc, L)).toThrow(/page tree contains itself/);
  }, 60_000);

  test('a digital signature is found before anything is changed', async () => {
    expect((await openPdf(fx('pdf/signed.pdf'))).signature).toEqual({ signed: true, signedFields: 1, certified: false });
    expect((await openPdf(fx('pdf/markers.pdf'))).signature).toEqual({ signed: false, signedFields: 0, certified: false });
  });
});
