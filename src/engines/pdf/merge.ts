// Merge PDFs (v0.2.0, Phase 2): the pages of several PDFs, in order, in one new document, on @cantoo/pdf-lib.
//
// The library's copyPages is not used. It copies a page's dictionary under a new reference, so a link, bookmark or
// form field that points at the page by its reference pulls in a second, hidden copy of it. Here each file is copied
// by one Copier whose map starts with every page of the file already assigned its merged page, so every reference to
// a page lands on the merged page itself. References to the file's catalog and page tree, and to page dictionaries
// that are not in its page tree, become null, so nothing drags the rest of a file along. What is carried, per file:
//
// - The pages, with everything they draw and all their annotations; inherited attributes are pushed down first.
// - Links and every GoTo action: explicit destinations remapped; named ones (old /Dests names and name-tree strings)
//   resolved to the page they name; page numbers some programs write in place of a page reference turned into that
//   page. A destination that cannot be found in its own file is removed (and counted), so it can never land in
//   another file's pages.
// - Bookmarks, rebuilt: one per file, titled with its name and pointing at its first page, with the file's own
//   bookmarks under it, open or closed as they were.
// - Named destinations, in one name tree. A name an earlier file already used gets a suffix (_2 for the second file).
// - Form fields with their values and appearances. A top-level field whose name an earlier file already used is
//   renamed the same way (name_2). The form's default appearance and alignment are pushed into each file's own
//   fields; a form font resource whose name another file uses for a different font is renamed, and the default
//   appearances that use it are rewritten. Calculation order is kept; "redraw appearances" is set if a file asked.
// - Layers (optional content): every file's groups, each starting shown or hidden as in its own file.
// - From the first file only: document information, XMP metadata, language, viewer settings, and the opening view
//   when it is a page.
//
// Dropped, and reported per file: accessibility tags (the structure tree), page labels, document attachments,
// document scripts, article threads, XFA form data, other layer configurations, and a portfolio's files. Digital
// signatures are carried as they are and are no longer valid (the tool warns before it runs). The result is then
// cleaned like every edit (./structure.ts) and written whole.

import type { PDFArray as PDFArrayT, PDFDict as PDFDictT, PDFDocument as PDFDocumentT, PDFName as PDFNameT, PDFObject, PDFRef as PDFRefT } from '@cantoo/pdf-lib';
import { LIMITS } from '../../core/limits';
import { cleanDocument, pageRefs, pdfLib, pushDownInherited, type CleanReport, type OpenPdf } from './structure';

type Lib = typeof import('@cantoo/pdf-lib');

export type DroppedPart = 'tags' | 'labels' | 'attachments' | 'scripts' | 'threads' | 'xfa' | 'layerConfigs' | 'portfolio' | 'openAction';

export interface MergeFile {
  name: string;
  pages: number;
  /** The merged page number of the file's first page (1-based). */
  firstPage: number;
  /** The file's own bookmarks, carried under its section. */
  bookmarks: number;
  links: number;
  /** Form fields carried (terminal fields, the ones that hold a value). */
  fields: number;
  renamed: Array<{ from: string; to: string }>;
  /** Form resources renamed because another file used the name for something else. */
  resourcesRenamed: number;
  destinationsRenamed: number;
  /** Links, bookmarks and actions whose destination could not be found in the file; the destination was removed. */
  unresolved: number;
  /** The form has scripts, which may refer to fields by name. */
  formScripts: boolean;
  /** The file asks readers to redraw its form fields (carried only when it has fields). */
  needAppearances: boolean;
  signed: boolean;
  dropped: DroppedPart[];
}

export interface MergeReport {
  pages: number;
  files: MergeFile[];
  /** Bookmarks in the result, the file sections included. */
  bookmarks: number;
  fields: number;
  /** Layers (optional content groups) carried. */
  layers: number;
  /** The file whose document information the result carries, or null when it had none. */
  infoFrom: string | null;
  clean: CleanReport;
}

interface OutlineNode { dict: PDFDictT; ref: PDFRefT; open: boolean; children: OutlineNode[] }

const MAX_DEPTH = 256;
const OUTLINE_DEPTH = 64;

/** The bytes of a name or string, as one character per byte, to compare names exactly. */
function keyOf(o: { asBytes(): Uint8Array }): string {
  const b = o.asBytes();
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

const hexOf = (key: string) => Array.from(key, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const escapeLiteral = (s: string) => s.replace(/[\\()]/g, '\\$&');

/** name_2 for the second file; name_2_2 and on if that is taken too. */
export function uniqueName(base: string, fileNo: number, taken: (s: string) => boolean): string {
  let n = `${base}_${fileNo}`;
  for (let k = 2; taken(n); k++) n = `${base}_${fileNo}_${k}`;
  return n;
}

/** Renames font resources in a default appearance string ("/Helv 12 Tf 0 g"), keeping it a byte string. */
export function rewriteAppearance(da: string, renames: ReadonlyMap<string, string>): string {
  return da.replace(/\/([^\s/[\]()<>{}%]+)(\s+[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s+Tf)/g, (m, name: string, rest: string) => {
    const decoded = name.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const to = renames.get(decoded);
    return to ? `/${to}${rest}` : m;
  });
}

/** A file's named destinations: the name tree (/Names /Dests) first, then the old /Dests dictionary, as pdf.js reads them. */
function namedDestinations(doc: PDFDocumentT, L: Lib): Map<string, PDFObject> {
  const { PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRef } = L;
  const out = new Map<string, PDFObject>();
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 32) return;
    if (node instanceof PDFRef) { if (seen.has(String(node))) return; seen.add(String(node)); }
    const d = node instanceof PDFRef ? doc.context.lookup(node) : node;
    if (!(d instanceof PDFDict)) return;
    const names = d.lookup(PDFName.of('Names'));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size() && out.size < LIMITS.pdfObjects; i += 2) {
        const k = names.lookup(i);
        if ((k instanceof PDFString || k instanceof PDFHexString) && !out.has(keyOf(k))) out.set(keyOf(k), names.get(i + 1));
      }
    }
    const kids = d.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
  };
  const tree = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (tree) walk(tree.get(PDFName.of('Dests')), 0);
  const old = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (old) for (const [k, v] of old.entries()) if (!out.has(keyOf(k))) out.set(keyOf(k), v);
  return out;
}

/** Copies one source file's objects into the merged document (see the top of this file). */
class Copier {
  private map = new Map<PDFRefT, PDFObject>();
  private queue: Array<[PDFRefT, PDFRefT]> = [];
  /** Destinations that could not be found in the file, so they were removed. */
  unresolved = 0;
  private N: Record<string, PDFNameT>;

  constructor(private L: Lib, private src: PDFDocumentT, private out: PDFDocumentT, private srcPages: PDFRefT[],
    private pageMap: Map<PDFRefT, PDFRefT>, private named: Map<string, PDFObject>) {
    for (const [s, d] of pageMap) this.map.set(s, d);
    const n = (s: string) => L.PDFName.of(s);
    this.N = Object.fromEntries(['S', 'D', 'GoTo', 'Dest', 'Subtype', 'Link', 'Type', 'Annot', 'Rect', 'StructParent', 'Page', 'Pages',
      'Catalog', 'Outlines', 'StructTreeRoot', 'Contents', 'Parent', 'Kids', 'StructParents', 'B'].map(k => [k, n(k)]));
  }

  /** A page dictionary, a page tree node, a catalog, an outline root or a structure tree: never copied through a
   *  reference. A page without /Type is told by its content and parent; annotations always have a /Subtype. */
  private blocked(o: PDFObject): boolean {
    const { PDFDict } = this.L;
    const N = this.N;
    if (!(o instanceof PDFDict)) return false;
    const t = o.get(N.Type);
    if (t === N.Page || t === N.Pages || t === N.Catalog || t === N.Outlines || t === N.StructTreeRoot) return true;
    return o.has(N.Contents) && o.has(N.Parent) && !o.has(N.Kids) && o.get(N.Subtype) === undefined;
  }

  ref(r: PDFRefT): PDFObject {
    const m = this.map.get(r);
    if (m) return m;
    const o = this.src.context.lookup(r);
    if (o === undefined || this.blocked(o)) { this.map.set(r, this.L.PDFNull); return this.L.PDFNull; }
    const d = this.out.context.nextRef();
    this.map.set(r, d);
    this.queue.push([r, d]);
    return d;
  }

  value(v: PDFObject | undefined, depth = 0): PDFObject {
    const { PDFRef, PDFDict, PDFArray, PDFStream, PDFRawStream, PDFNull } = this.L;
    if (v === undefined) return PDFNull;
    if (depth > MAX_DEPTH) throw new Error('This PDF is nested too deeply to merge.');
    if (v instanceof PDFRef) return this.ref(v);
    if (v instanceof PDFStream) return PDFRawStream.of(this.dict(v.dict, depth, true) as PDFDictT, v.getContents());
    if (v instanceof PDFDict) return this.dict(v, depth, false);
    if (v instanceof PDFArray) {
      const a = this.out.context.obj([]) as PDFArrayT;
      for (let i = 0; i < v.size(); i++) a.push(this.value(v.get(i), depth + 1));
      return a;
    }
    // Names, numbers, strings, booleans and null are values; they are shared, never changed.
    return v;
  }

  private dict(d: PDFDictT, depth: number, isStream: boolean): PDFObject {
    const N = this.N;
    const goTo = !isStream && d.get(N.S) === N.GoTo;
    const link = !isStream && d.get(N.Subtype) === N.Link;
    const annot = !isStream && d.get(N.Subtype) !== undefined && (d.get(N.Type) === N.Annot || d.has(N.Rect));
    const out = this.out.context.obj({}) as PDFDictT;
    for (const [k, v] of d.entries()) {
      // The structure tree is not carried, so an annotation's place in it goes too.
      if (annot && k === N.StructParent) continue;
      if ((goTo && k === N.D) || (link && k === N.Dest)) {
        const r = this.dest(v);
        if (r) { out.set(k, r); continue; }
        this.unresolved++;
        // A GoTo action without its destination is not an action; the link or bookmark keeps no action at all.
        if (goTo) return this.L.PDFNull;
        continue;
      }
      out.set(k, this.value(v, depth + 1));
    }
    return out;
  }

  /** An explicit destination in the merged document, or null when the file does not have it. */
  dest(v: PDFObject | undefined, followNames = true): PDFArrayT | null {
    const { PDFName, PDFString, PDFHexString, PDFDict, PDFArray, PDFRef, PDFNumber } = this.L;
    let d: PDFObject | undefined = v instanceof PDFRef ? this.src.context.lookup(v) : v;
    if (d instanceof PDFName || d instanceof PDFString || d instanceof PDFHexString) {
      if (!followNames) return null;
      return this.dest(this.named.get(keyOf(d)), false);
    }
    if (d instanceof PDFDict) {
      const inner = d.get(this.N.D);
      d = inner instanceof PDFRef ? this.src.context.lookup(inner) : inner;
    }
    if (!(d instanceof PDFArray) || d.size() === 0) return null;
    const first = d.get(0);
    let page: PDFRefT | undefined;
    if (first instanceof PDFRef) page = this.pageMap.get(first);
    else if (first instanceof PDFNumber) {
      // Some programs write the page number (0-based) where a page reference belongs.
      const i = first.asNumber();
      if (Number.isInteger(i) && i >= 0 && i < this.srcPages.length) page = this.pageMap.get(this.srcPages[i]);
    }
    if (!page) return null;
    const out = this.out.context.obj([]) as PDFArrayT;
    out.push(page);
    for (let i = 1; i < d.size(); i++) out.push(this.value(d.get(i), 1));
    return out;
  }

  /** Copies a page dictionary to its merged reference, without its parent, its structure-tree key or its beads. */
  page(srcRef: PDFRefT, destRef: PDFRefT): void {
    const { PDFDict, PDFPageLeaf } = this.L;
    const N = this.N;
    const p = this.src.context.lookup(srcRef, PDFDict);
    const out = PDFPageLeaf.fromMapWithContext(new Map(), this.out.context);
    for (const [k, v] of p.entries()) {
      if (k === N.Parent || k === N.StructParents || k === N.B) continue;
      out.set(k, this.value(v, 1));
    }
    this.out.context.assign(destRef, out);
  }

  /** Copies everything the copied objects reference, one object at a time (a long chain of references cannot
   *  exhaust the stack). */
  drain(): void {
    for (let item = this.queue.pop(); item; item = this.queue.pop()) {
      const o = this.src.context.lookup(item[0]);
      this.out.context.assign(item[1], this.value(o));
    }
  }
}

export class Merger {
  private kids: PDFRefT[] = [];
  private sections: OutlineNode[] = [];
  private fieldNames = new Set<string>();
  private fields: PDFObject[] = [];
  private co: PDFObject[] = [];
  private dr: PDFDictT | null = null;
  private da: PDFObject | undefined;
  private q: PDFObject | undefined;
  private needAppearances = false;
  private sigFlags = 0;
  private dests = new Map<string, PDFArrayT>();
  private oc = { ocgs: [] as PDFObject[], off: [] as PDFObject[], order: [] as PDFObject[], rb: [] as PDFObject[], locked: [] as PDFObject[], as: [] as PDFObject[], ordered: false, unordered: [] as PDFObject[] };
  private version: [number, number] = [1, 7];
  private infoFrom: string | null = null;
  readonly files: MergeFile[] = [];

  private constructor(private L: Lib, readonly doc: PDFDocumentT) {}

  static async create(): Promise<Merger> {
    const L = await pdfLib();
    return new Merger(L, await L.PDFDocument.create({ updateMetadata: false }));
  }

  get pages(): number { return this.kids.length; }

  private n(s: string): PDFNameT { return this.L.PDFName.of(s); }

  /** Adds every page of one file, after the pages added so far. */
  add(src: OpenPdf, name: string): MergeFile {
    const L = this.L;
    const { PDFDict, PDFArray, PDFRef, PDFHexString } = L;
    const N = (s: string) => this.n(s);
    const doc = src.doc;
    const cat = doc.catalog;
    const ctx = this.doc.context;
    const srcPages = pageRefs(doc, L);
    if (!srcPages.length) throw new Error('This PDF has no pages.');
    if (this.kids.length + srcPages.length > LIMITS.pdfPages) {
      const e = new Error(`Together the files have more than ${LIMITS.pdfPages.toLocaleString('en-US')} pages, the most one merged PDF can have.`);
      // About the whole merge, not one file.
      e.name = 'MergeTotalError';
      throw e;
    }
    pushDownInherited(doc, L, srcPages);
    const fileNo = this.files.length + 1;
    const report: MergeFile = {
      name, pages: srcPages.length, firstPage: this.kids.length + 1, bookmarks: 0, links: 0, fields: 0, renamed: [],
      resourcesRenamed: 0, destinationsRenamed: 0, unresolved: 0, formScripts: false, needAppearances: false,
      signed: src.signature.signed, dropped: [],
    };
    const drop = (p: DroppedPart) => { if (!report.dropped.includes(p)) report.dropped.push(p); };
    const pageMap = new Map<PDFRefT, PDFRefT>();
    for (const r of srcPages) pageMap.set(r, ctx.nextRef());
    const named = namedDestinations(doc, L);
    const c = new Copier(L, doc, this.doc, srcPages, pageMap, named);

    // ---- Pages.
    for (const r of srcPages) {
      c.page(r, pageMap.get(r)!);
      this.kids.push(pageMap.get(r)!);
      const annots = doc.context.lookup(r, PDFDict).lookup(N('Annots'));
      if (annots instanceof PDFArray) for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i);
        if (a instanceof PDFDict && a.get(N('Subtype')) === N('Link')) report.links++;
      }
    }

    // ---- Bookmarks, under a section for the file.
    const seen = new Set<string>();
    const outline = (parent: PDFDictT, depth: number): OutlineNode[] => {
      const items: OutlineNode[] = [];
      if (depth > OUTLINE_DEPTH) return items;
      let r = parent.get(N('First'));
      while (r instanceof PDFRef && !seen.has(String(r)) && seen.size < LIMITS.pdfObjects) {
        seen.add(String(r));
        const it = doc.context.lookup(r);
        if (!(it instanceof PDFDict)) break;
        const dict = ctx.obj({}) as PDFDictT;
        dict.set(N('Title'), it.get(N('Title')) !== undefined ? c.value(it.get(N('Title'))) : L.PDFString.of(''));
        for (const k of ['C', 'F']) if (it.get(N(k)) !== undefined) dict.set(N(k), c.value(it.get(N(k))));
        if (it.get(N('Dest')) !== undefined) {
          const d = c.dest(it.get(N('Dest')));
          if (d) dict.set(N('Dest'), d); else c.unresolved++;
        } else if (it.get(N('A')) !== undefined) {
          const a = c.value(it.get(N('A')));
          if (a !== L.PDFNull) dict.set(N('A'), a);
        }
        const count = it.lookup(N('Count'));
        const node: OutlineNode = { dict, ref: ctx.register(dict), open: !(count instanceof L.PDFNumber && count.asNumber() < 0), children: [] };
        report.bookmarks++;
        node.children = outline(it, depth + 1);
        items.push(node);
        r = it.get(N('Next'));
      }
      return items;
    };
    const outlines = cat.lookupMaybe(N('Outlines'), PDFDict);
    const base = name.replace(/\.pdf$/i, '') || name;
    const section = ctx.obj({ Title: PDFHexString.fromText(base) }) as PDFDictT;
    const first = ctx.obj([pageMap.get(srcPages[0])!, N('Fit')]);
    section.set(N('Dest'), first);
    this.sections.push({ dict: section, ref: ctx.register(section), open: true, children: outlines ? outline(outlines, 0) : [] });

    // ---- Named destinations.
    for (const [k, v] of named) {
      const d = c.dest(v, false);
      if (!d) continue;
      let key = k;
      if (this.dests.has(key)) { key = uniqueName(k, fileNo, s => this.dests.has(s) || named.has(s)); report.destinationsRenamed++; }
      this.dests.set(key, d);
    }

    // ---- Form (copied now; names and appearances are settled once the objects exist, below).
    const af = cat.lookupMaybe(N('AcroForm'), PDFDict);
    const tops: PDFObject[] = [];
    let drCopy: PDFObject | undefined;
    let formDA: PDFObject | undefined;
    let formQ: PDFObject | undefined;
    if (af) {
      if (af.get(N('XFA')) !== undefined) drop('xfa');
      const fields = af.lookup(N('Fields'));
      if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) tops.push(c.value(fields.get(i)));
      const co = af.lookup(N('CO'));
      if (co instanceof PDFArray) for (let i = 0; i < co.size(); i++) this.co.push(c.value(co.get(i)));
      if (af.get(N('DR')) !== undefined) drCopy = c.value(af.get(N('DR')));
      formDA = af.lookup(N('DA'));
      formQ = af.lookup(N('Q'));
      const na = af.lookup(N('NeedAppearances'));
      if (na instanceof L.PDFBool && na.asBoolean()) report.needAppearances = true;
      const sf = af.lookup(N('SigFlags'));
      if (sf instanceof L.PDFNumber && (sf.asNumber() & 1)) this.sigFlags = 1;
    }

    // ---- Layers.
    const ocp = cat.lookupMaybe(N('OCProperties'), PDFDict);
    if (ocp) {
      const groups: PDFObject[] = [];
      const ocgs = ocp.lookup(N('OCGs'));
      if (ocgs instanceof PDFArray) for (let i = 0; i < ocgs.size(); i++) groups.push(c.value(ocgs.get(i)));
      const dflt = ocp.lookup(N('D'));
      const list = (v: unknown) => { const out: PDFObject[] = []; if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) out.push(c.value(v.get(i))); return out; };
      if (dflt instanceof PDFDict) {
        if (dflt.lookup(N('BaseState')) === N('OFF')) {
          const on = new Set(list(dflt.lookup(N('ON'))).map(String));
          this.oc.off.push(...groups.filter(g => !on.has(String(g))));
        } else this.oc.off.push(...list(dflt.lookup(N('OFF'))));
        const order = dflt.lookup(N('Order'));
        if (order instanceof PDFArray) { this.oc.order.push(...list(order)); this.oc.ordered = true; } else this.oc.unordered.push(...groups);
        this.oc.rb.push(...list(dflt.lookup(N('RBGroups'))));
        this.oc.locked.push(...list(dflt.lookup(N('Locked'))));
        this.oc.as.push(...list(dflt.lookup(N('AS'))));
      } else this.oc.unordered.push(...groups);
      for (const g of groups) if (!this.oc.ocgs.some(x => String(x) === String(g))) this.oc.ocgs.push(g);
      if (ocp.get(N('Configs')) !== undefined) drop('layerConfigs');
    }

    // ---- Document-level parts that are not carried.
    const names = cat.lookupMaybe(N('Names'), PDFDict);
    if (cat.get(N('StructTreeRoot')) !== undefined) drop('tags');
    if (cat.get(N('PageLabels')) !== undefined) drop('labels');
    if (names?.get(N('EmbeddedFiles')) !== undefined) drop('attachments');
    const openAction = cat.lookup(N('OpenAction'));
    const isScript = (a: unknown) => a instanceof PDFDict && a.lookup(N('S')) === N('JavaScript');
    if (names?.get(N('JavaScript')) !== undefined || cat.get(N('AA')) !== undefined || isScript(openAction)) drop('scripts');
    if (cat.get(N('Threads')) !== undefined) drop('threads');
    if (cat.get(N('Collection')) !== undefined) drop('portfolio');

    // ---- From the first file: document information, metadata, language, viewer settings, opening view.
    if (fileNo === 1) {
      const out = this.doc.catalog;
      const info = doc.context.trailerInfo.Info;
      const infoDict = info instanceof PDFRef ? doc.context.lookup(info) : info;
      if (infoDict instanceof PDFDict && infoDict.keys().length) {
        const v = c.value(info);
        ctx.trailerInfo.Info = v instanceof PDFRef ? v : ctx.register(v);
        this.infoFrom = name;
      }
      for (const k of ['Metadata', 'Lang', 'PageLayout', 'ViewerPreferences']) if (cat.get(N(k)) !== undefined) out.set(N(k), c.value(cat.get(N(k))));
      const mode = cat.lookup(N('PageMode'));
      if (mode !== undefined && mode !== N('UseAttachments')) out.set(N('PageMode'), c.value(mode));
      if (openAction !== undefined && !isScript(openAction)) {
        const d = openAction instanceof PDFArray ? c.dest(openAction)
          : openAction instanceof PDFDict && openAction.lookup(N('S')) === N('GoTo') ? c.dest(openAction.get(N('D'))) : null;
        if (d) out.set(N('OpenAction'), d); else drop('openAction');
      }
    }
    const vs = (src.scan.version ?? '').match(/^(\d)\.(\d)$/);
    const cv = cat.lookup(N('Version'));
    for (const m of [vs, cv instanceof L.PDFName ? cv.decodeText().match(/^(\d)\.(\d)$/) : null]) {
      if (m && (Number(m[1]) > this.version[0] || (Number(m[1]) === this.version[0] && Number(m[2]) > this.version[1]))) this.version = [Number(m[1]), Number(m[2])];
    }

    c.drain();

    // ---- Form, now that its objects exist: resources, names, default appearances.
    if (af) this.settleForm(tops, drCopy, formDA, formQ, fileNo, report, pageMap);
    report.unresolved = c.unresolved;
    this.files.push(report);
    return report;
  }

  private deref(v: PDFObject | undefined): PDFObject | undefined {
    return v instanceof this.L.PDFRef ? this.doc.context.lookup(v) : v;
  }

  /** Whether two resource values are the same thing (structurally), so a shared name needs no rename. */
  private same(a: PDFObject | undefined, b: PDFObject | undefined, depth = 0): boolean {
    const { PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString, PDFBool, PDFRawStream, PDFName } = this.L;
    if (a === b) return true;
    if (depth > 8) return false;
    const x = this.deref(a), y = this.deref(b);
    if (x === y) return true;
    if (x instanceof PDFName || y instanceof PDFName) return x === y;
    if (x instanceof PDFNumber && y instanceof PDFNumber) return x.asNumber() === y.asNumber();
    if (x instanceof PDFBool && y instanceof PDFBool) return x.asBoolean() === y.asBoolean();
    if ((x instanceof PDFString || x instanceof PDFHexString) && (y instanceof PDFString || y instanceof PDFHexString)) return keyOf(x) === keyOf(y);
    if (x instanceof PDFArray && y instanceof PDFArray) {
      if (x.size() !== y.size()) return false;
      for (let i = 0; i < x.size(); i++) if (!this.same(x.get(i), y.get(i), depth + 1)) return false;
      return true;
    }
    if (x instanceof PDFRawStream && y instanceof PDFRawStream) {
      const p = x.getContents(), q = y.getContents();
      if (p.length !== q.length || p.length > 4 << 20 || !this.same(x.dict, y.dict, depth + 1)) return false;
      for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
      return true;
    }
    if (x instanceof PDFDict && y instanceof PDFDict) {
      const kx = x.keys(), ky = y.keys();
      if (kx.length !== ky.length) return false;
      for (const k of kx) if (!this.same(x.get(k), y.get(k), depth + 1)) return false;
      return true;
    }
    return false;
  }

  private settleForm(tops: PDFObject[], drCopy: PDFObject | undefined, formDA: PDFObject | undefined, formQ: PDFObject | undefined,
    fileNo: number, report: MergeFile, pageMap: Map<PDFRefT, PDFRefT>): void {
    const L = this.L;
    const { PDFDict, PDFArray, PDFString, PDFHexString, PDFRef } = L;
    const N = (s: string) => this.n(s);
    const ctx = this.doc.context;

    // Form resources: a name another file uses for something else is renamed; fonts are what appearances name.
    const fontRenames = new Map<string, string>();
    const dr = this.deref(drCopy);
    if (dr instanceof PDFDict) {
      this.dr ??= ctx.obj({}) as PDFDictT;
      for (const [kind, sub] of dr.entries()) {
        const s = this.deref(sub);
        if (!(s instanceof PDFDict)) { if (!this.dr.has(kind)) this.dr.set(kind, sub); continue; }
        let target = this.deref(this.dr.get(kind));
        if (!(target instanceof PDFDict)) { target = ctx.obj({}) as PDFDictT; this.dr.set(kind, target); }
        const t = target as PDFDictT;
        for (const [nm, val] of s.entries()) {
          const have = t.get(nm);
          if (have === undefined) { t.set(nm, val); continue; }
          if (this.same(have, val)) continue;
          const renamed = uniqueName(nm.decodeText(), fileNo, k => t.has(N(k)) || s.has(N(k)));
          t.set(N(renamed), val);
          report.resourcesRenamed++;
          if (kind === N('Font')) fontRenames.set(nm.decodeText(), renamed);
        }
      }
    }
    const latin = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? keyOf(o) : null);
    const rewrite = (holder: PDFDictT) => {
      const da = latin(holder.get(N('DA')));
      if (da === null || !fontRenames.size) return;
      const out = rewriteAppearance(da, fontRenames);
      if (out !== da) holder.set(N('DA'), PDFString.of(escapeLiteral(out)));
    };

    // Names: the top-level names (or, under an unnamed top, the first named ones) are what can clash.
    const named: PDFDictT[] = [];
    const findNamed = (v: PDFObject | undefined, depth: number) => {
      const f = this.deref(v);
      if (!(f instanceof PDFDict) || depth > 8) return;
      if (f.get(N('T')) !== undefined) { named.push(f); return; }
      const kids = f.lookup(N('Kids'));
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) findNamed(kids.get(i), depth + 1);
    };
    for (const t of tops) findNamed(t, 0);
    const nameOf = (f: PDFDictT) => { const t = f.lookup(N('T')); return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : ''; };
    const own = new Set(named.map(nameOf));
    const assigned = new Set<string>();
    for (const f of named) {
      const nm = nameOf(f);
      if (this.fieldNames.has(nm)) {
        const to = uniqueName(nm, fileNo, s => this.fieldNames.has(s) || own.has(s) || assigned.has(s));
        f.set(N('T'), PDFHexString.fromText(to));
        report.renamed.push({ from: nm, to });
        assigned.add(to);
      } else assigned.add(nm);
    }
    for (const nm of assigned) this.fieldNames.add(nm);

    // The form's default appearance and alignment, pushed into this file's own fields, then every appearance
    // rewritten for renamed fonts; free-text annotations name the form's fonts too.
    const seen = new Set<string>();
    const walk = (v: PDFObject | undefined, depth: number, top: boolean): number => {
      if (v instanceof PDFRef) { if (seen.has(String(v))) return 0; seen.add(String(v)); }
      const f = this.deref(v);
      if (!(f instanceof PDFDict) || depth > 64) return 0;
      if (top) {
        if (formDA !== undefined && f.get(N('DA')) === undefined) f.set(N('DA'), formDA);
        if (formQ !== undefined && f.get(N('Q')) === undefined) f.set(N('Q'), formQ);
      }
      rewrite(f);
      for (const k of ['A', 'AA']) {
        const a = this.deref(f.get(N(k)));
        if (a instanceof PDFDict && (a.lookup(N('S')) === N('JavaScript') || (k === 'AA' && a.values().some(x => { const y = this.deref(x); return y instanceof PDFDict && y.lookup(N('S')) === N('JavaScript'); })))) report.formScripts = true;
      }
      const kids = f.lookup(N('Kids'));
      let n = 0, namedKids = false;
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) {
        const k = this.deref(kids.get(i));
        if (k instanceof PDFDict && k.get(N('T')) !== undefined) namedKids = true;
        n += walk(kids.get(i), depth + 1, false);
      }
      return namedKids ? n : f.get(N('T')) !== undefined ? 1 : n;
    };
    for (const t of tops) report.fields += walk(t, 0, true);
    // Asking readers to redraw form fields applies to every field of the merged PDF, so it is carried only from a
    // file that has fields to redraw.
    if (report.needAppearances && report.fields > 0) this.needAppearances = true;
    if (fontRenames.size) {
      for (const ref of pageMap.values()) {
        const annots = ctx.lookup(ref, PDFDict).lookup(N('Annots'));
        if (annots instanceof PDFArray) for (let i = 0; i < annots.size(); i++) {
          const a = annots.lookup(i);
          if (a instanceof PDFDict && a.get(N('Subtype')) === N('FreeText')) rewrite(a);
        }
      }
    }
    if (this.da === undefined && formDA !== undefined) {
      const s = latin(formDA);
      this.da = s !== null && fontRenames.size ? PDFString.of(escapeLiteral(rewriteAppearance(s, fontRenames))) : formDA;
    }
    if (this.q === undefined && formQ !== undefined) this.q = formQ;
    this.fields.push(...tops.filter(t => t !== L.PDFNull));
  }

  /** Writes the page tree, bookmarks, names, form and layers, and cleans the result. */
  finish(): MergeReport {
    const L = this.L;
    const { PDFDict, PDFHexString } = L;
    const N = (s: string) => this.n(s);
    const ctx = this.doc.context;
    const cat = this.doc.catalog;
    const rootRef = cat.get(N('Pages'))!;
    const root = cat.lookup(N('Pages'), PDFDict);
    root.set(N('Kids'), ctx.obj(this.kids));
    root.set(N('Count'), ctx.obj(this.kids.length));
    for (const k of this.kids) ctx.lookup(k, PDFDict).set(N('Parent'), rootRef);

    // Bookmarks: Count is the number of entries shown below an open entry, negative for a closed one.
    let total = 0;
    const link = (parentRef: PDFRefT, parent: PDFDictT, nodes: OutlineNode[]): number => {
      let shown = 0;
      nodes.forEach((node, i) => {
        total++;
        node.dict.set(N('Parent'), parentRef);
        if (i > 0) node.dict.set(N('Prev'), nodes[i - 1].ref);
        if (i < nodes.length - 1) node.dict.set(N('Next'), nodes[i + 1].ref);
        const below = link(node.ref, node.dict, node.children);
        if (node.children.length) node.dict.set(N('Count'), ctx.obj(node.open ? below : -below));
        shown += 1 + (node.open ? below : 0);
      });
      if (nodes.length) { parent.set(N('First'), nodes[0].ref); parent.set(N('Last'), nodes[nodes.length - 1].ref); }
      return shown;
    };
    if (this.sections.length) {
      const outlines = ctx.obj({ Type: 'Outlines' }) as PDFDictT;
      const ref = ctx.register(outlines);
      outlines.set(N('Count'), ctx.obj(link(ref, outlines, this.sections)));
      cat.set(N('Outlines'), ref);
    }

    if (this.dests.size) {
      const keys = [...this.dests.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const arr: PDFObject[] = [];
      for (const k of keys) arr.push(PDFHexString.of(hexOf(k)), this.dests.get(k)!);
      cat.set(N('Names'), ctx.obj({ Dests: ctx.register(ctx.obj({ Names: arr })) }));
    }

    if (this.fields.length) {
      const af = ctx.obj({ Fields: this.fields }) as PDFDictT;
      if (this.da !== undefined) af.set(N('DA'), this.da);
      if (this.q !== undefined) af.set(N('Q'), this.q);
      if (this.dr) af.set(N('DR'), this.dr);
      if (this.co.length) af.set(N('CO'), ctx.obj(this.co));
      if (this.needAppearances) af.set(N('NeedAppearances'), L.PDFBool.True);
      if (this.sigFlags) af.set(N('SigFlags'), ctx.obj(this.sigFlags));
      cat.set(N('AcroForm'), ctx.register(af));
    }

    if (this.oc.ocgs.length) {
      const d = ctx.obj({ BaseState: 'ON' }) as PDFDictT;
      if (this.oc.off.length) d.set(N('OFF'), ctx.obj(this.oc.off));
      if (this.oc.ordered) d.set(N('Order'), ctx.obj([...this.oc.order, ...this.oc.unordered]));
      if (this.oc.rb.length) d.set(N('RBGroups'), ctx.obj(this.oc.rb));
      if (this.oc.locked.length) d.set(N('Locked'), ctx.obj(this.oc.locked));
      if (this.oc.as.length) d.set(N('AS'), ctx.obj(this.oc.as));
      cat.set(N('OCProperties'), ctx.obj({ OCGs: this.oc.ocgs, D: d }));
    }

    ctx.header = L.PDFHeader.forVersion(this.version[0], this.version[1]);
    const clean = cleanDocument(this.doc, L, { pagesRemoved: 0, reordered: false });
    return {
      pages: this.kids.length, files: this.files, bookmarks: total,
      fields: this.files.reduce((n, f) => n + f.fields, 0), layers: this.oc.ocgs.length, infoFrom: this.infoFrom, clean,
    };
  }
}
