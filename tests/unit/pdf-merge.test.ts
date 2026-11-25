import type { PDFDict, PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, test } from 'vitest';
import { Merger, rewriteAppearance, uniqueName, type MergeReport } from '../../src/engines/pdf/merge';
import { openPdf, pdfLib, savePdf } from '../../src/engines/pdf/structure';
import { content, everything, fx, page, pdfFrom, read } from './pdf-helpers';

// Merge PDFs (v0.2.0, Phase 2). These tests read the result back with the editing library; the browser tests read
// every result with qpdf, pypdf, PDFium and pdftotext, which share no code with FileConvert.

async function merge(files: Array<[string, Uint8Array]>): Promise<{ report: MergeReport; bytes: Uint8Array; out: PDFDocument }> {
  const m = await Merger.create();
  for (const [name, bytes] of files) m.add(await openPdf(bytes), name);
  const report = m.finish();
  const bytes = await savePdf(m.doc);
  const L = await pdfLib();
  return { report, bytes, out: await L.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity }) };
}


describe('merging PDFs', () => {
  test('every page once, bookmarks under a section per file, links and named destinations on the right pages', async () => {
    const { report, out } = await merge([['merge-a.pdf', fx('merge-a.pdf')], ['merge-b.pdf', fx('merge-b.pdf')]]);
    const r = await read(out);
    expect(r.pages).toHaveLength(5);
    // No hidden copy of a page that a link or bookmark points at.
    expect(r.pageObjects).toBe(5);
    // Counts are the entries shown under an open entry (a closed entry's own do not count), negative when closed.
    expect(r.outline).toEqual([
      ['merge-a', 0, [['Chapter A1', 0, [['Section A1.1', 0]], 1], ['Chapter A2', 1], ['Closed A3', 2, [['A3 child', 2]], -1], ['Web link', '/URI']], 5],
      ['merge-b', 3, [['Chapter B1', 3], ['Chapter B2', 4]], 2],
    ]);
    expect(r.outlineCount).toBe(9);
    expect(report.bookmarks).toBe(10);
    // "shared" is in both files: merge-b's gets a suffix, and its bookmark still goes to merge-b's own page.
    expect(r.dests).toEqual({ 'a-sec': 0, 'a-two': 1, shared: 2, shared_2: 4 });
    const L = await pdfLib();
    // The name tree's keys are in byte order, as readers that search it expect.
    const tree = out.catalog.lookup(r.N('Names'), L.PDFDict).lookup(r.N('Dests'), L.PDFDict).lookup(r.N('Names'), L.PDFArray);
    expect(tree.asArray().filter((_, i) => i % 2 === 0).map(k => r.str(k))).toEqual(['a-sec', 'a-two', 'shared', 'shared_2']);
    // Pages keep what they inherited from their page trees: merge-a's third page its rotation, merge-b's second its
    // rotation and resources, every page its media box.
    const pageDict = (i: number) => out.context.lookup(L.PDFRef.of(Number(r.pages[i].split(' ')[0]), 0), L.PDFDict);
    expect([0, 1, 2, 3, 4].map(i => String(pageDict(i).get(r.N('Rotate')) ?? 0))).toEqual(['0', '0', '180', '0', '90']);
    expect([0, 1, 2, 3, 4].every(i => pageDict(i).lookup(r.N('MediaBox')) instanceof L.PDFArray)).toBe(true);
    expect(pageDict(4).lookup(r.N('Resources'), L.PDFDict).lookup(r.N('Font'), L.PDFDict).has(r.N('F1'))).toBe(true);
    expect(pageDict(1).lookup(r.N('Resources'), L.PDFDict).lookup(r.N('Font'), L.PDFDict).has(r.N('F1'))).toBe(true);
    // Every widget names its page (all of them do in the sources), now its merged page.
    for (const i of [1, 2, 3]) {
      const widgets = pageDict(i).lookup(r.N('Annots'), L.PDFArray).asArray().map(x => r.look(x) as PDFDict).filter(a => a.get(r.N('Subtype')) === r.N('Widget'));
      expect(widgets.length, `page ${i + 1}`).toBeGreaterThan(0);
      for (const a of widgets) expect(String(a.get(r.N('P'))), `page ${i + 1}`).toBe(r.pages[i]);
    }
    // The cleanup ran on the result: a page lists only the resources it draws (merge-a's second page inherited
    // F1 and Helv from its page tree and draws with F1).
    expect(pageDict(1).lookup(r.N('Resources'), L.PDFDict).lookup(r.N('Font'), L.PDFDict).keys().map(String)).toEqual(['/F1']);
    const linkTargets = r.pages.map(p => {
      const annots = out.context.lookup(L.PDFRef.of(Number(p.split(' ')[0]), 0), L.PDFDict).lookup(r.N('Annots'));
      return annots instanceof L.PDFArray ? annots.asArray().map(a => r.look(a) as PDFDict).filter(a => a.get(r.N('Subtype')) === r.N('Link')).map(a => {
        const act = r.look(a.get(r.N('A')));
        if (a.get(r.N('Dest')) !== undefined) return r.target(a.get(r.N('Dest')));
        if (act instanceof L.PDFDict) return act.get(r.N('S')) === r.N('URI') ? r.str(act.get(r.N('URI'))) : r.target(act.get(r.N('D')));
        return 'none';
      }) : [];
    });
    // merge-b: a page number written as 1 is its own second page (merged page 5), "nowhere" does not exist.
    expect(linkTargets).toEqual([[2, 1, 'https://example.com/alpha'], [], [], [4, 'none', 4, 'https://example.com/bravo'], []]);
    expect(report.files.map(f => [f.firstPage, f.pages, f.links, f.bookmarks, f.unresolved, f.destinationsRenamed])).toEqual([[1, 3, 3, 6, 0, 0], [4, 2, 4, 2, 1, 1]]);
  });

  test('form fields keep their values; names an earlier file used are renamed, and so is a form font that differs', async () => {
    const { report, out } = await merge([['merge-a.pdf', fx('merge-a.pdf')], ['merge-b.pdf', fx('merge-b-objstm.pdf')]]);
    const r = await read(out);
    expect(r.fields).toEqual({
      name: { value: 'Alice', da: '/Helv 0 Tf 0 g' },
      agree: { value: 'Yes', da: '/Helv 0 Tf 0 g' },
      choice: { value: 'B', da: '/Helv 0 Tf 0 g' },
      color: { value: 'Green', da: '/Helv 12 Tf 0 g' },
      name_2: { value: 'Bob', da: '/Helv_2 10 Tf 0 0 1 rg' },
      'address.street': { value: '1 Main St', da: undefined },
      'address.city': { value: 'Springfield', da: undefined },
      agree_2: { value: 'Off', da: '/Helv_2 0 Tf 0 g' },
    });
    expect(report.files[1].renamed).toEqual([{ from: 'name', to: 'name_2' }, { from: 'agree', to: 'agree_2' }]);
    expect(report.files[1].resourcesRenamed).toBe(1);
    expect(report.fields).toBe(8);
    const L = await pdfLib();
    const fonts = r.af!.lookup(r.N('DR'), L.PDFDict).lookup(r.N('Font'), L.PDFDict);
    const base = (k: string) => String(fonts.lookup(r.N(k), L.PDFDict).get(r.N('BaseFont')));
    // merge-b's /Helv is Courier: its fields now name Helv_2, which is Courier; merge-a's Helvetica keeps its name.
    expect([base('Helv'), base('Helv_2'), base('ZaDb')]).toEqual(['/Helvetica', '/Courier', '/ZapfDingbats']);
    // The "address" field took merge-b's form appearance with the renamed font, so its parts inherit Courier.
    const address = r.look(r.af!.lookup(r.N('Fields'), L.PDFArray).get(5)) as PDFDict;
    expect([r.str(address.get(r.N('T'))), r.str(address.get(r.N('DA')))]).toEqual(['address', '/Helv_2 0 Tf 0 g']);
    // The free-text note names the form's fonts too.
    const p4 = out.context.lookup(L.PDFRef.of(Number(r.pages[3].split(' ')[0]), 0), L.PDFDict);
    const free = p4.lookup(r.N('Annots'), L.PDFArray).asArray().map(a => r.look(a) as PDFDict).find(a => a.get(r.N('Subtype')) === r.N('FreeText'))!;
    expect(r.str(free.get(r.N('DA')))).toBe('/Helv_2 12 Tf 0 g');
    expect(r.str(r.af!.get(r.N('DA')))).toBe('/Helv 0 Tf 0 g');
  });

  test('layers keep their states, the first file gives the document information, and the highest version is used', async () => {
    const { report, out, bytes } = await merge([['merge-b.pdf', fx('merge-b.pdf')], ['merge-a.pdf', fx('merge-a.pdf')]]);
    const L = await pdfLib();
    const r = await read(out);
    const oc = out.catalog.lookup(r.N('OCProperties'), L.PDFDict);
    const nameOf = (g: unknown) => r.str((r.look(g) as PDFDict).get(r.N('Name')));
    expect(oc.lookup(r.N('OCGs'), L.PDFArray).asArray().map(nameOf)).toEqual(['Bravo shown', 'Bravo hidden', 'Alpha shown', 'Alpha hidden']);
    const d = oc.lookup(r.N('D'), L.PDFDict);
    expect(String(d.get(r.N('BaseState')))).toBe('/ON');
    expect(d.lookup(r.N('OFF'), L.PDFArray).asArray().map(nameOf)).toEqual(['Bravo hidden', 'Alpha hidden']);
    // Only merge-a has an Order; merge-b's groups are listed after it so the layers panel still shows them.
    expect(d.lookup(r.N('Order'), L.PDFArray).asArray().map(nameOf)).toEqual(['Alpha shown', 'Alpha hidden', 'Bravo shown', 'Bravo hidden']);
    expect(oc.get(r.N('Configs'))).toBeUndefined();
    // merge-b came first: its information, no XMP (it has none), and merge-a's opening view is not used.
    const info = out.context.lookup(out.context.trailerInfo.Info, L.PDFDict);
    expect(r.str(info.get(r.N('Title')))).toBe('Merge B');
    expect(report.infoFrom).toBe('merge-b.pdf');
    expect(out.catalog.get(r.N('Metadata'))).toBeUndefined();
    expect(out.catalog.get(r.N('OpenAction'))).toBeUndefined();
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('%PDF-1.7');
    const first = await merge([['merge-a.pdf', fx('merge-a.pdf')], ['merge-b.pdf', fx('merge-b.pdf')]]);
    expect(first.out.catalog.get(r.N('Metadata'))).toBeDefined();
    expect(String(first.out.catalog.get(r.N('Lang')))).toBe('(en-US)');
    expect(first.report.files[0].dropped).toEqual([]);
    const ra = await read(first.out);
    expect(ra.target(first.out.catalog.get(r.N('OpenAction')))).toBe(0);
  });

  test('document parts that are not carried are reported and leave nothing behind', async () => {
    const { report, bytes } = await merge([['markers.pdf', fx('markers.pdf')], ['merge-b.pdf', fx('merge-b.pdf')]]);
    expect(report.files[0].dropped.sort()).toEqual(['labels', 'tags', 'threads']);
    expect(report.files[1].dropped.sort()).toEqual(['attachments', 'labels', 'layerConfigs', 'scripts', 'tags', 'xfa']);
    const all = await everything(bytes);
    // Gone: the older revision left by an incremental update, the attachment, the scripts, the XFA data, the tags'
    // text, the thread, and the page labels.
    for (const gone of ['OLD-REVISION-SECRET', 'An attached note.', 'var ready = 1;', 'var opened = 1;', 'xdp:xdp', 'TAG-SECRET', 'THREAD-SECRET', '/PageLabels', '/StructTreeRoot', '/StructParents', '/EmbeddedFiles', '/Threads']) {
      expect(all, gone).not.toContain(gone);
    }
    // An annotation's place in the structure tree goes with the tree (merge-b's first link has one).
    expect(all).not.toMatch(/\/StructParent\b/);
    // Kept: every page's own content, annotations, fields and their values.
    for (const kept of ['PAGE-TWO-SECRET', 'ANNOT-SECRET', 'FIELD-SECRET', 'Bravo sticky note', 'Springfield', 'PIECE-SECRET']) expect(all, kept).toContain(kept);
    expect(all.match(/%%EOF/g)).toHaveLength(1);
  });

  test('a signed file is reported; its signature field and value are carried as they were', async () => {
    const { report, out } = await merge([['merge-a.pdf', fx('merge-a.pdf')], ['signed.pdf', fx('signed.pdf')]]);
    expect(report.files.map(f => f.signed)).toEqual([false, true]);
    const r = await read(out);
    expect(Object.keys(r.fields)).toContain('Signature1');
    const L = await pdfLib();
    expect(r.af!.lookup(r.N('SigFlags'), L.PDFNumber).asNumber()).toBe(1);
    // The signature's reference to its own file's catalog does not drag the source along.
    expect(r.pageObjects).toBe(7);
  });

  test('the same file twice: two copies, every name of the second renamed, nothing shared between them', async () => {
    const { report, out } = await merge([['a.pdf', fx('merge-a.pdf')], ['a.pdf', fx('merge-a.pdf')]]);
    const r = await read(out);
    expect(Object.keys(r.fields)).toEqual(['name', 'agree', 'choice', 'color', 'name_2', 'agree_2', 'choice_2', 'color_2']);
    expect(r.dests).toEqual({ 'a-sec': 0, 'a-sec_2': 3, 'a-two': 1, 'a-two_2': 4, shared: 2, shared_2: 5 });
    // The same fonts under the same names are the same thing: nothing to rename.
    expect(report.files[1].resourcesRenamed).toBe(0);
    expect(r.pageObjects).toBe(6);
  });

  test('destinations a file does not have are removed, never sent into another file', async () => {
    // b's link and a GoTo action name "first", which only a defines; its bookmark and another action point at a page
    // outside b's page tree; a name points at itself; the page refers to its own catalog and to the stray page.
    const a = pdfFrom({
      1: '<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(first) [3 0 R /Fit]] >> >> >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(4), 4: content('0 0 m'),
    });
    const b = pdfFrom({
      1: '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R /Names << /Dests 14 0 R >> >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: page(4, ' /Annots [5 0 R 6 0 R 11 0 R 12 0 R 13 0 R] /Custom 1 0 R /Other 9 0 R'), 4: content('0 0 m'),
      5: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest (first) >>',
      6: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /GoTo /D [9 0 R /Fit] >> >>',
      11: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /GoTo /D (first) >> >>',
      12: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest (loop) >>',
      13: '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /P 9 0 R /Contents (note) >>',
      14: '<< /Names [(loop) (loop)] >>',
      7: '<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >>',
      8: '<< /Title (Orphan) /Parent 7 0 R /Dest [9 0 R /Fit] >>',
      9: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 10 0 R >>', 10: content('(ORPHAN-PAGE) Tj'),
    });
    const { report, out, bytes } = await merge([['a.pdf', a], ['b.pdf', b]]);
    expect(report.files[1].unresolved).toBe(5);
    const r = await read(out);
    expect(r.outline).toEqual([['a', 0], ['b', 1, [['Orphan', null]], 1]]);
    expect(r.pageObjects).toBe(2);
    expect(await everything(bytes)).not.toContain('ORPHAN-PAGE');
    // No link or action of b's goes anywhere: none lands on a's page, and the actions without a target are gone.
    const L = await pdfLib();
    const annots = out.context.lookup(L.PDFRef.of(Number(r.pages[1].split(' ')[0]), 0), L.PDFDict).lookup(r.N('Annots'), L.PDFArray).asArray().map(a => r.look(a) as PDFDict);
    expect(annots.map(a => [a.get(r.N('Dest')), a.get(r.N('A'))].map(v => (v === undefined ? '-' : String(v))))).toEqual([['-', '-'], ['-', '-'], ['-', '-'], ['-', '-'], ['-', '-']]);
    // The note named the stray page as its page: that reference is cleared, not followed. Only one catalog and one
    // page tree are in the result: the page's references to b's catalog and stray page were cleared too.
    expect(annots[4].get(r.N('P'))).toBeUndefined();
    let catalogs = 0, trees = 0;
    for (const [, o] of out.context.enumerateIndirectObjects()) {
      if (o instanceof L.PDFDict && o.get(r.N('Type')) === r.N('Catalog')) catalogs++;
      if (o instanceof L.PDFDict && o.get(r.N('Type')) === r.N('Pages')) trees++;
    }
    expect([catalogs, trees]).toEqual([1, 1]);
  });

  test('a bookmark list that loops ends, and a long chain of references is copied without exhausting the stack', async () => {
    const chain: Record<number, string> = {};
    const n = 20_000;
    for (let i = 0; i < n; i++) chain[100 + i] = i < n - 1 ? `<< /Next ${101 + i} 0 R >>` : '<< /End (CHAIN-END) >>';
    const b = pdfFrom({
      1: '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: page(4, ' /Chain 100 0 R'), 4: content('0 0 m'),
      7: '<< /Type /Outlines /First 8 0 R /Last 9 0 R /Count 2 >>',
      8: '<< /Title (One) /Parent 7 0 R /Next 9 0 R /Dest [3 0 R /Fit] >>',
      9: '<< /Title (Two) /Parent 7 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>',
      ...chain,
    });
    const { out, bytes } = await merge([['b.pdf', b]]);
    expect((await read(out)).outline).toEqual([['b', 0, [['One', 0], ['Two', 0]], 2]]);
    expect(await everything(bytes)).toContain('CHAIN-END');
  });

  test('field names: an unnamed top field compares its named parts; a suffix already taken is skipped', async () => {
    const field = (name: string, value: string) => `<< /FT /Tx /T (${name}) /V (${value}) /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 3 0 R >>`;
    const a = pdfFrom({
      1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(4, ' /Annots [5 0 R]'), 4: content('0 0 m'), 5: field('x', 'a-x'),
    });
    const b = pdfFrom({
      1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] >> >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(4, ' /Annots [7 0 R 8 0 R]'), 4: content('0 0 m'),
      // An unnamed field holding "x"; and a field already named x_2.
      5: '<< /Kids [7 0 R] >>', 7: `<< /FT /Tx /T (x) /V (b-x) /Parent 5 0 R /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 3 0 R >>`,
      6: '<< /Kids [8 0 R] /T (x_2) /FT /Tx /V (b-x2) >>', 8: '<< /Parent 6 0 R /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 3 0 R >>',
    });
    const { report, out } = await merge([['a.pdf', a], ['b.pdf', b]]);
    expect(report.files[1].renamed).toEqual([{ from: 'x', to: 'x_2_2' }]);
    expect(Object.entries((await read(out)).fields).map(([k, v]) => [k, v.value])).toEqual([['x', 'a-x'], ['x_2_2', 'b-x'], ['x_2', 'b-x2']]);
  });

  test('a portfolio, and a request to redraw form fields, are reported; a request from a file without fields is not carried', async () => {
    const { describeMerge } = await import('../../src/tools/merge-pdf');
    const fields = (n: string) => `<< /Type /Catalog /Pages 2 0 R /Collection << /Type /Collection >> /AcroForm << /Fields [${n}] /NeedAppearances true >> >>`;
    const widget = '<< /FT /Tx /T (redrawn) /V (x) /Type /Annot /Subtype /Widget /Rect [0 0 50 20] /P 3 0 R >>';
    const p = pdfFrom({ 1: fields('5 0 R'), 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(4, ' /Annots [5 0 R]'), 4: content('0 0 m'), 5: widget });
    const { report, out } = await merge([['p.pdf', p], ['a.pdf', fx('merge-a.pdf')]]);
    expect(report.files[0]).toMatchObject({ dropped: ['portfolio'], needAppearances: true, fields: 1 });
    expect(String(out.catalog.lookup((await pdfLib()).PDFName.of('AcroForm'), (await pdfLib()).PDFDict).get((await pdfLib()).PDFName.of('NeedAppearances')))).toBe('true');
    const d = describeMerge(report);
    expect(d.warnings).toContain('p.pdf is a PDF portfolio: only its cover pages are merged, not the files inside it.');
    expect(d.warnings).toContain('p.pdf asks PDF readers to redraw form fields, so readers may redraw the fields of every file.');
    // The same request from a file with no fields would only make readers redraw the other files' fields.
    const empty = pdfFrom({ 1: fields(''), 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(4), 4: content('0 0 m') });
    const second = await merge([['e.pdf', empty], ['a.pdf', fx('merge-a.pdf')]]);
    const af = second.out.catalog.lookup((await pdfLib()).PDFName.of('AcroForm'), (await pdfLib()).PDFDict);
    expect(af.get((await pdfLib()).PDFName.of('NeedAppearances'))).toBeUndefined();
    expect(describeMerge(second.report).warnings.some(w => w.includes('redraw'))).toBe(false);
  });

  test('a PDF 2.0 file makes the result 2.0; a file with no pages is refused', async () => {
    const two = pdfFrom({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: page(4), 4: content('0 0 m') }, '2.0');
    const { bytes } = await merge([['a.pdf', fx('merge-a.pdf')], ['two.pdf', two]]);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('%PDF-2.0');
    const empty = pdfFrom({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [] /Count 0 >>' });
    const m = await Merger.create();
    await expect((async () => m.add(await openPdf(empty), 'empty.pdf'))()).rejects.toThrow('This PDF has no pages.');
  });

  test('more pages than one PDF can have is refused before anything is copied', async () => {
    const L = await pdfLib();
    const big = await L.PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 2600; i++) big.addPage([100, 100]);
    const bytes = await big.save({ useObjectStreams: false });
    const m = await Merger.create();
    m.add(await openPdf(bytes), 'one.pdf');
    await expect((async () => m.add(await openPdf(bytes), 'two.pdf'))()).rejects.toThrow('Together the files have more than 5,000 pages, the most one merged PDF can have.');
    expect(m.pages).toBe(2600);
  });

  test('encrypted files are refused, even ones that open without a password', async () => {
    await expect(openPdf(fx('encrypted-owner.pdf'))).rejects.toThrow(/^This PDF is encrypted/);
  });
});

describe('merge helpers', () => {
  test('uniqueName adds the file number, then a counter while the name is taken', () => {
    expect(uniqueName('name', 2, () => false)).toBe('name_2');
    const taken = new Set(['name_3', 'name_3_2']);
    expect(uniqueName('name', 3, s => taken.has(s))).toBe('name_3_3');
  });
  test('rewriteAppearance renames only the font operand of Tf', () => {
    const r = new Map([['Helv', 'Helv_2'], ['A B', 'AB_2']]);
    expect(rewriteAppearance('/Helv 12 Tf 0 g', r)).toBe('/Helv_2 12 Tf 0 g');
    expect(rewriteAppearance('0 g /Helv 0 Tf', r)).toBe('0 g /Helv_2 0 Tf');
    expect(rewriteAppearance('/Helvetica 9.5 Tf', r)).toBe('/Helvetica 9.5 Tf');
    expect(rewriteAppearance('/Helv cs /Cour 10 Tf', r)).toBe('/Helv cs /Cour 10 Tf');
    expect(rewriteAppearance('/A#20B 8 Tf', r)).toBe('/AB_2 8 Tf');
  });
});


describe('Merge PDFs tool', () => {
  test('the check: pages first, then the size of all files, then the memory all of them need together', async () => {
    const { tool } = await import('../../src/tools/merge-pdf');
    const { estimate, memoryAllowance } = await import('../../src/core/pdfmemory');
    const MB = 1024 * 1024;
    const input = (size: number, pages: number, parsed = 0) => ({ id: 1, name: 'a.pdf', format: 'pdf' as const, file: { size } as File, pages, work: { bytes: size, parsed, objects: 0, pages } });
    expect(tool.check!([input(MB, 3000), input(MB, 2001)], {})).toMatch(/^Together these files have 5,001 pages/);
    expect(tool.check!([input(600 * MB, 1), input(500 * MB, 1)], {})).toMatch(/^Together these files are 1\.07 GB; FileConvert merges up to 1\.00 GB at a time/);
    // Node reports no device memory, so the allowance is the one assumed for a computer.
    const a = memoryAllowance();
    expect(a.basis).toBe('computer');
    const fits = (parsed: number) => estimate([input(MB, 10, parsed).work, input(MB, 10, parsed).work], 'edit').total <= a.total;
    let lo = 0, hi = 100 * MB;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid; }
    expect(tool.check!([input(MB, 10, lo), input(MB, 10, lo)], {})).toBeNull();
    expect(tool.check!([input(MB, 10, hi), input(MB, 10, hi)], {})).toMatch(/^Together these files need about .* of memory, more than the 2\.00 GB FileConvert lets one task use in a browser that does not say how much memory the device has, so it was not started\. Merge fewer files at a time\. Chrome and Edge say how much memory the device has, so FileConvert may allow more there\.$/);
  });

  test('names are listed in plain words, at most five', async () => {
    const { listNames } = await import('../../src/tools/merge-pdf');
    expect(listNames(['a.pdf'])).toBe('a.pdf');
    expect(listNames(['a.pdf', 'b.pdf'])).toBe('a.pdf and b.pdf');
    expect(listNames(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listNames(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d and 3 more');
  });

  test('the result says what was kept, renamed and left out', async () => {
    const { describeMerge } = await import('../../src/tools/merge-pdf');
    const { report } = await merge([['merge-a.pdf', fx('merge-a.pdf')], ['markers.pdf', fx('markers.pdf')], ['signed.pdf', fx('signed.pdf')]]);
    const d = describeMerge(report);
    expect(d.note).toBe('11 pages from 3 files');
    expect(d.details).toContain('Renamed in signed.pdf, because an earlier file has fields with the same names: secretfield to secretfield_3 and keepfield to keepfield_3.');
    expect(d.warnings).toEqual([
      'The digital signature of signed.pdf is no longer valid. The signature fields and how they look are kept.',
      'Accessibility tags are not kept (markers.pdf and signed.pdf); screen readers read the merged pages without them.',
      'Page labels such as i, ii, iii are not kept (markers.pdf and signed.pdf); the merged pages are numbered 1 to 11.',
      'Article threads are not kept (markers.pdf and signed.pdf).',
    ]);
  });
});
