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
    await expect(openPdf(fx('pdf/encrypted-owner.pdf'))).rejects.toThrow(/^This PDF is encrypted .* FileConvert never removes a PDF's protection/);
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
