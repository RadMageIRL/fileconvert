// Page structure and cleanup for every PDF editing tool, on @cantoo/pdf-lib (loaded only when a PDF is edited).
//
// Removing pages with the library alone leaves them in the file: removePage takes a page out of the page tree but
// keeps its content, its pictures and everything that points to it, so a removed page can be recovered from the
// result. Every editing operation here therefore ends with cleanDocument(), which:
//
// 1. Rewrites the page tree as one flat list of the pages that remain (inherited attributes pushed down first).
// 2. Keeps in each remaining page's resources only what its content actually uses (./content.ts), and does the
//    same for the form XObjects, annotation appearances, tiling patterns and Type 3 fonts it draws, so resources
//    shared by many pages no longer carry a removed page's pictures or fonts.
// 3. Drops what pointed at removed pages: links, outline entries with nothing left under them, named
//    destinations, an opening action, form fields whose widgets were all on removed pages (and any XFA form data,
//    which repeats every field's value). When pages are removed it also drops the structure tree (its elements
//    carry the removed pages' text), article threads and page labels, and reports each.
// 4. Sweeps every object nothing reaches any more, replacing leftover references to removed pages by null, and
//    lowers the trailer's /Size. The result is always written whole, never as an incremental update.
//
// This is not redaction. It removes pages; it does not search the remaining pages for text, pictures or metadata
// that identify someone.

import type { PDFArray as PDFArrayT, PDFDict as PDFDictT, PDFDocument as PDFDocumentT, PDFRef as PDFRefT } from '@cantoo/pdf-lib';
import { usedResources, type ResourceKind } from './content';
import { ENCRYPTED_MESSAGE, scanPdf, type PdfScan } from './scan';

type Lib = typeof import('@cantoo/pdf-lib');
let lib: Lib | null = null;

export async function pdfLib(): Promise<Lib> {
  lib ??= await import('@cantoo/pdf-lib');
  return lib;
}

export interface SignatureInfo {
  signed: boolean;
  /** Signature fields holding a signature. */
  signedFields: number;
  /** A certification signature that restricts changes (/Perms /DocMDP), or usage rights (/UR3). */
  certified: boolean;
}

export interface CleanReport {
  pages: number;
  pagesRemoved: number;
  linksRemoved: number;
  outlineItemsRemoved: number;
  destinationsRemoved: number;
  formFieldsRemoved: number;
  xfaRemoved: boolean;
  tagsRemoved: boolean;
  labelsRemoved: boolean;
  threadsRemoved: boolean;
  openActionRemoved: boolean;
  /** Resource entries that remaining pages listed but never used, removed. */
  resourcesPruned: number;
  /** Content streams that could not be read, so their resources were kept whole. */
  unreadContent: number;
  objectsRemoved: number;
  referencesCleared: number;
}

export interface OpenPdf {
  doc: PDFDocumentT;
  scan: PdfScan;
  signature: SignatureInfo;
}

/**
 * Checks a PDF with the guard, then loads it for editing. Encrypted PDFs are refused (v0.2.0 does not decrypt).
 * `admit` sees what the guard counted before the editing library reads anything, and throws to refuse the file (the
 * memory admission check, src/core/pdfmemory.ts).
 */
export async function openPdf(bytes: Uint8Array, admit?: (scan: PdfScan) => void): Promise<OpenPdf> {
  const scan = scanPdf(bytes);
  if (scan.encrypted) throw new Error(ENCRYPTED_MESSAGE);
  admit?.(scan);
  const L = await pdfLib();
  let doc: PDFDocumentT;
  try {
    doc = await L.PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity, ignoreEncryption: false, throwOnInvalidObject: false });
  } catch (e) {
    if (e instanceof RangeError) throw new Error('This PDF is nested too deeply to read, so it was not opened.');
    throw new Error(`This PDF could not be read: ${(e as Error).message}`);
  }
  return { doc, scan, signature: signatureInfo(doc, L) };
}

export async function savePdf(doc: PDFDocumentT): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false, objectsPerTick: Infinity, updateFieldAppearances: false, addDefaultPage: false });
}

/** Whether a document carries a digital signature: a signed signature field, or certification or usage rights. */
export function signatureInfo(doc: PDFDocumentT, L: Lib): SignatureInfo {
  const { PDFName, PDFDict, PDFArray } = L;
  const cat = doc.catalog;
  let signedFields = 0;
  let certified = false;
  const perms = cat.lookupMaybe(PDFName.of('Perms'), PDFDict);
  if (perms && (perms.get(PDFName.of('DocMDP')) || perms.get(PDFName.of('UR3')))) certified = true;
  const af = cat.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const seen = new Set<string>();
  const walk = (arr: unknown, inheritedFT: unknown, depth: number) => {
    if (!(arr instanceof PDFArray) || depth > 64) return;
    for (let i = 0; i < arr.size(); i++) {
      const key = String(arr.get(i));
      if (seen.has(key)) continue;
      seen.add(key);
      const f = arr.lookup(i);
      if (!(f instanceof PDFDict)) continue;
      const ft = f.lookup(PDFName.of('FT')) ?? inheritedFT;
      if (ft === PDFName.of('Sig') && f.lookup(PDFName.of('V'))) signedFields++;
      walk(f.lookup(PDFName.of('Kids')), ft, depth + 1);
    }
  };
  if (af) walk(af.lookup(PDFName.of('Fields')), undefined, 0);
  return { signed: signedFields > 0 || certified, signedFields, certified };
}

/**
 * About how many bytes new files made of these parts of a document hold together (split, extract): for each part,
 * the page dictionaries and everything they reach (contents, resources, pictures, fonts, annotations, form fields),
 * each object once per part, since every new file gets its own copy of what its pages share. Links to other pages
 * and back to the page tree are not followed. Counting stops once the total passes `stop`. Nothing is copied.
 */
export function partBytes(doc: PDFDocumentT, L: Lib, parts: readonly (readonly number[])[], stop = Infinity): number {
  const { PDFDict, PDFArray, PDFRef, PDFRawStream, PDFName } = L;
  const refs = pageRefs(doc, L);
  const pages = new Set(refs.map(String));
  const skip = new Set([PDFName.of('Parent'), PDFName.of('P')]);
  let total = 0;
  for (const part of parts) {
    const seen = new Set<string>();
    const stack: unknown[] = [];
    for (const i of part) {
      const ref = refs[i];
      if (!ref || seen.has(String(ref))) continue;
      seen.add(String(ref));
      const page = doc.context.lookup(ref);
      if (!page) continue;
      total += page.sizeInBytes();
      stack.push(page);
    }
    while (stack.length) {
      const v = stack.pop();
      if (v instanceof PDFRef) {
        const key = String(v);
        if (seen.has(key) || pages.has(key)) continue;
        seen.add(key);
        const o = doc.context.lookup(v);
        if (!o) continue;
        total += o instanceof PDFRawStream ? o.dict.sizeInBytes() + o.getContentsSize() + 18 : o.sizeInBytes();
        stack.push(o);
      } else if (v instanceof PDFRawStream) {
        stack.push(v.dict);
      } else if (v instanceof PDFDict) {
        for (const [k, x] of v.entries()) if (!skip.has(k)) stack.push(x);
      } else if (v instanceof PDFArray) {
        for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
      }
    }
    if (total > stop) return total;
  }
  return total;
}

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
const KINDS: ResourceKind[] = ['Font', 'XObject', 'ExtGState', 'Shading', 'ColorSpace', 'Pattern', 'Properties'];

/** The page dictionaries of the page tree, in order, as references (a page tree that loops is refused). */
export function pageRefs(doc: PDFDocumentT, L: Lib): PDFRefT[] {
  const { PDFName, PDFDict, PDFArray, PDFRef } = L;
  const out: PDFRefT[] = [];
  const seen = new Set<string>();
  const walk = (node: PDFDictT, depth: number) => {
    if (depth > 64) throw new Error('This PDF\'s page tree is nested too deeply.');
    const kids = node.lookup(PDFName.of('Kids'));
    if (!(kids instanceof PDFArray)) return;
    for (let i = 0; i < kids.size(); i++) {
      const ref = kids.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const kid = doc.context.lookup(ref);
      if (!(kid instanceof PDFDict)) continue;
      const node = kid.lookup(PDFName.of('Type')) === PDFName.of('Pages') || kid.has(PDFName.of('Kids'));
      if (seen.has(String(ref))) {
        throw new Error(node ? 'This PDF\'s page tree contains itself, so its pages cannot be listed.' : 'This PDF lists the same page twice in its page tree, which the PDF format does not allow.');
      }
      seen.add(String(ref));
      if (node) walk(kid, depth + 1);
      else out.push(ref);
    }
  };
  const root = doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
  walk(root, 0);
  return out;
}

/** Moves the attributes a page inherits from the page tree (resources, boxes, rotation) onto the page itself, so it
 *  keeps them when its parents are replaced or it is copied into another document. */
export function pushDownInherited(doc: PDFDocumentT, L: Lib, refs: PDFRefT[]): void {
  const { PDFName, PDFDict } = L;
  for (const ref of refs) {
    const page = doc.context.lookup(ref, PDFDict);
    for (const k of INHERITABLE) {
      const key = PDFName.of(k);
      if (page.get(key) !== undefined) continue;
      let parent = page.lookup(PDFName.of('Parent'));
      for (let d = 0; parent instanceof PDFDict && d < 64; d++) {
        const v = parent.get(key);
        if (v !== undefined) { page.set(key, v); break; }
        parent = parent.lookup(PDFName.of('Parent'));
      }
    }
  }
}

/** Rewrites the page tree as one flat list in the given order (0-based); pages left out are removed. */
export function setPages(doc: PDFDocumentT, L: Lib, order: number[]): { kept: PDFRefT[]; removed: number } {
  const { PDFName, PDFDict } = L;
  const refs = pageRefs(doc, L);
  for (const i of order) if (!Number.isInteger(i) || i < 0 || i >= refs.length) throw new Error(`There is no page ${i + 1}; the PDF has ${refs.length}.`);
  // A page dictionary belongs to one place in the tree; repeating a page would need a copy of it and its annotations.
  if (new Set(order).size !== order.length) throw new Error('A page can be kept only once.');
  if (!order.length) throw new Error('At least one page has to stay.');
  pushDownInherited(doc, L, refs);
  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  const root = doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
  const kept = order.map(i => refs[i]);
  root.set(PDFName.of('Kids'), doc.context.obj(kept));
  root.set(PDFName.of('Count'), doc.context.obj(kept.length));
  for (const k of INHERITABLE) root.delete(PDFName.of(k));
  for (const ref of kept) doc.context.lookup(ref, PDFDict).set(PDFName.of('Parent'), rootRef!);
  return { kept, removed: refs.length - new Set(kept.map(String)).size };
}

/** Keeps the given pages, in that order, and cleans the document (see the top of this file). */
export function keepPages(doc: PDFDocumentT, L: Lib, order: number[]): CleanReport {
  const before = pageRefs(doc, L).length;
  const { removed } = setPages(doc, L, order);
  const reordered = removed > 0 || order.some((p, i) => p !== i);
  return cleanDocument(doc, L, { pagesRemoved: removed, reordered, pagesBefore: before });
}

/** Cleans a document whose page tree already holds only the pages to keep (see the top of this file). */
export function cleanDocument(doc: PDFDocumentT, L: Lib, opts: { pagesRemoved: number; reordered: boolean; pagesBefore?: number }): CleanReport {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFNull, PDFRawStream, decodePDFRawStream } = L;
  const ctx = doc.context;
  const N = (s: string) => PDFName.of(s);
  const kept = pageRefs(doc, L);
  const live = new Set(kept.map(String));
  const report: CleanReport = {
    pages: kept.length, pagesRemoved: opts.pagesRemoved, linksRemoved: 0, outlineItemsRemoved: 0, destinationsRemoved: 0,
    formFieldsRemoved: 0, xfaRemoved: false, tagsRemoved: false, labelsRemoved: false, threadsRemoved: false,
    openActionRemoved: false, resourcesPruned: 0, unreadContent: 0, objectsRemoved: 0, referencesCleared: 0,
  };
  const removedPages = opts.pagesRemoved > 0;
  const deref = (v: unknown) => (v instanceof PDFRef ? ctx.lookup(v) : v);

  // ---- 2. Resources: only what the content uses.
  const decoded = (s: unknown): Uint8Array | null => {
    if (!(s instanceof PDFRawStream)) return null;
    try { return decodePDFRawStream(s).decode(); } catch { return null; }
  };
  const contentOf = (v: unknown): Uint8Array | null => {
    const c = deref(v);
    if (c instanceof PDFArray) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < c.size(); i++) { const d = decoded(c.lookup(i)); if (!d) return null; parts.push(d, new Uint8Array([10])); }
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.length; }
      return all;
    }
    return c === undefined ? new Uint8Array(0) : decoded(c);
  };
  const done = new Set<string>();
  const holders: Array<[unknown, number]> = [];
  /** Gives a page or form its own resources dictionary, holding only the entries its content uses. */
  const prune = (holder: PDFDictT, content: Uint8Array | null, depth: number) => {
    const res = holder.lookup(N('Resources'));
    if (!(res instanceof PDFDict)) return;
    const used = content ? usedResources(content) : null;
    if (!used) { report.unreadContent++; return; }
    const fresh = ctx.obj({}) as PDFDictT;
    for (const [k, v] of res.entries()) {
      const kind = k.asString().slice(1) as ResourceKind;
      if (!KINDS.includes(kind)) { fresh.set(k, v); continue; }
      const sub = deref(v);
      if (!(sub instanceof PDFDict)) continue;
      const keep = ctx.obj({}) as PDFDictT;
      for (const [name, val] of sub.entries()) {
        if (used[kind].has(name.asString().slice(1))) {
          keep.set(name, val);
          if (kind === 'XObject' || kind === 'Pattern' || kind === 'Font') holders.push([val, depth + 1]);
        } else report.resourcesPruned++;
      }
      if (keep.keys().length) fresh.set(k, keep);
    }
    holder.set(N('Resources'), fresh);
  };
  const visit = (v: unknown, depth: number) => {
    if (depth > 32) return;
    const key = v instanceof PDFRef ? String(v) : null;
    if (key) { if (done.has(key)) return; done.add(key); }
    const o = deref(v);
    if (o instanceof PDFRawStream) {
      // A form XObject or a tiling pattern: its own content decides its own resources.
      const sub = o.dict.lookup(N('Subtype'));
      if (sub === N('Form') || o.dict.lookup(N('PatternType'))) prune(o.dict, decoded(o), depth);
    } else if (o instanceof PDFDict && o.lookup(N('Subtype')) === N('Type3')) {
      // A Type 3 font: the union of its glyphs' content.
      const procs = o.lookup(N('CharProcs'));
      if (procs instanceof PDFDict) {
        const parts: Uint8Array[] = [];
        let ok = true;
        for (const [, p] of procs.entries()) { const d = decoded(deref(p)); if (!d) { ok = false; break; } parts.push(d, new Uint8Array([10])); }
        const all = ok ? new Uint8Array(parts.reduce((n, p) => n + p.length, 0)) : null;
        if (all) { let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } }
        prune(o, all, depth);
      }
    }
  };
  const liveWidgets = new Set<string>();
  for (const ref of kept) {
    const page = ctx.lookup(ref, PDFDict);
    prune(page, contentOf(page.get(N('Contents'))), 0);
    const annots = page.lookup(N('Annots'));
    if (annots instanceof PDFArray) {
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.get(i);
        if (a instanceof PDFRef) liveWidgets.add(String(a));
        const ad = deref(a);
        if (!(ad instanceof PDFDict)) continue;
        const ap = ad.lookup(N('AP'));
        if (ap instanceof PDFDict) {
          for (const [, state] of ap.entries()) {
            const s = deref(state);
            if (s instanceof PDFDict && !(s instanceof PDFRawStream)) for (const [, f] of s.entries()) holders.push([f, 1]);
            else holders.push([state, 1]);
          }
        }
      }
    }
  }
  while (holders.length) { const [v, d] = holders.pop()!; visit(v, d); }

  // ---- 3. What pointed at removed pages.
  // Named destinations, read before anything is pruned, so a link or bookmark that names a removed page is found too.
  const { PDFString, PDFHexString } = L;
  const keyOf = (o: { asBytes(): Uint8Array }) => Array.from(o.asBytes(), c => String.fromCharCode(c)).join('');
  const named = new Map<string, unknown>();
  const seenNames = new Set<string>();
  const walkNames = (node: unknown, depth: number) => {
    if (node instanceof PDFRef) { if (seenNames.has(String(node))) return; seenNames.add(String(node)); }
    const d = deref(node);
    if (!(d instanceof PDFDict) || depth > 32) return;
    const arr = d.lookup(N('Names'));
    if (arr instanceof PDFArray) for (let i = 0; i + 1 < arr.size(); i += 2) {
      const k = arr.lookup(i);
      if ((k instanceof PDFString || k instanceof PDFHexString) && !named.has(keyOf(k))) named.set(keyOf(k), arr.get(i + 1));
    }
    const kids = d.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walkNames(kids.get(i), depth + 1);
  };
  walkNames(doc.catalog.lookupMaybe(N('Names'), PDFDict)?.get(N('Dests')), 0);
  const oldDests = doc.catalog.lookupMaybe(N('Dests'), PDFDict);
  if (oldDests) for (const [k, v] of oldDests.entries()) if (!named.has(keyOf(k))) named.set(keyOf(k), v);
  const deadDest = (v: unknown): boolean => {
    let a = deref(v);
    if (a instanceof PDFName || a instanceof PDFString || a instanceof PDFHexString) a = deref(named.get(keyOf(a)));
    if (a instanceof PDFDict) a = deref(a.get(N('D')));
    if (!(a instanceof PDFArray) || a.size() === 0) return false;
    const target = a.get(0);
    return target instanceof PDFRef && !live.has(String(target));
  };
  const actionDest = (a: unknown) => {
    const act = deref(a);
    return act instanceof PDFDict && act.lookup(N('S')) === N('GoTo') ? act.get(N('D')) : undefined;
  };
  for (const ref of kept) {
    const annots = ctx.lookup(ref, PDFDict).lookup(N('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      const dest = a.get(N('Dest')) ?? actionDest(a.get(N('A')));
      if (dest !== undefined && deadDest(dest)) { annots.remove(i); report.linksRemoved++; }
    }
  }
  // Outline entries: one that pointed at a removed page goes, unless entries under it remain (then only its target goes).
  const outlines = doc.catalog.lookupMaybe(N('Outlines'), PDFDict);
  if (outlines) {
    const pruneLevel = (parent: PDFDictT, parentRef: unknown, depth: number): number => {
      if (depth > 64) return 0;
      const items: Array<[unknown, PDFDictT]> = [];
      const seen = new Set<string>();
      for (let r = parent.get(N('First')); r instanceof PDFRef && !seen.has(String(r)); ) {
        seen.add(String(r));
        const it = ctx.lookup(r);
        if (!(it instanceof PDFDict)) break;
        items.push([r, it]);
        r = it.get(N('Next'));
      }
      const keep: Array<[unknown, PDFDictT]> = [];
      let visible = 0;
      for (const [r, it] of items) {
        const below = pruneLevel(it, r, depth + 1);
        const dest = it.get(N('Dest')) ?? actionDest(it.get(N('A')));
        const dead = dest !== undefined && deadDest(dest);
        if (dead && !it.get(N('First'))) { report.outlineItemsRemoved++; continue; }
        if (dead) { it.delete(N('Dest')); it.delete(N('A')); }
        keep.push([r, it]);
        // A closed entry's own entries are not shown, so they do not count for the level above (its sign says closed).
        const shut = Number(String(it.lookup(N('Count')))) < 0;
        visible += 1 + (shut ? 0 : Math.max(0, below));
      }
      keep.forEach(([, it], i) => {
        it.set(N('Parent'), parentRef as PDFRefT);
        if (i > 0) it.set(N('Prev'), keep[i - 1][0] as PDFRefT); else it.delete(N('Prev'));
        if (i < keep.length - 1) it.set(N('Next'), keep[i + 1][0] as PDFRefT); else it.delete(N('Next'));
      });
      if (keep.length) { parent.set(N('First'), keep[0][0] as PDFRefT); parent.set(N('Last'), keep[keep.length - 1][0] as PDFRefT); }
      else { parent.delete(N('First')); parent.delete(N('Last')); }
      // Count is the number of open entries below; a closed entry keeps a negative count.
      const old = parent.lookup(N('Count'));
      const closed = parent !== outlines && old !== undefined && Number(String(old)) < 0;
      if (keep.length && (old !== undefined || parent === outlines)) parent.set(N('Count'), ctx.obj(closed ? -visible : visible));
      else if (!keep.length) parent.delete(N('Count'));
      return visible;
    };
    pruneLevel(outlines, doc.catalog.get(N('Outlines')), 0);
    if (!outlines.get(N('First'))) doc.catalog.delete(N('Outlines'));
  }
  const dests = doc.catalog.lookupMaybe(N('Dests'), PDFDict);
  if (dests) for (const [k, v] of dests.entries()) if (deadDest(v)) { dests.delete(k); report.destinationsRemoved++; }
  const names = doc.catalog.lookupMaybe(N('Names'), PDFDict);
  const pruneNames = (node: unknown, depth: number) => {
    const d = deref(node);
    if (!(d instanceof PDFDict) || depth > 32) return;
    const arr = d.lookup(N('Names'));
    if (arr instanceof PDFArray) for (let i = arr.size() - 2; i >= 0; i -= 2) if (deadDest(arr.get(i + 1))) { arr.remove(i + 1); arr.remove(i); report.destinationsRemoved++; }
    const kids = d.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) pruneNames(kids.get(i), depth + 1);
  };
  if (names) pruneNames(names.get(N('Dests')), 0);
  const open = doc.catalog.get(N('OpenAction'));
  if (open !== undefined && (deadDest(open) || deadDest(actionDest(open)))) { doc.catalog.delete(N('OpenAction')); report.openActionRemoved = true; }
  // Form fields whose widgets were all on removed pages.
  const acro = doc.catalog.lookupMaybe(N('AcroForm'), PDFDict);
  if (acro) {
    /** Removes fields whose widgets were all on removed pages; a field with no widget at all is no page's, and stays. */
    const pruneFields = (arr: unknown, depth: number): { alive: number; widgets: number } => {
      const a = deref(arr);
      if (!(a instanceof PDFArray) || depth > 64) return { alive: 0, widgets: 0 };
      let alive = 0, widgets = 0;
      for (let i = a.size() - 1; i >= 0; i--) {
        const ref = a.get(i);
        const f = deref(ref);
        if (!(f instanceof PDFDict)) { a.remove(i); continue; }
        const isWidget = f.lookup(N('Subtype')) === N('Widget');
        const kids = f.get(N('Kids')) !== undefined ? pruneFields(f.get(N('Kids')), depth + 1) : { alive: 0, widgets: 0 };
        const selfAlive = isWidget && ref instanceof PDFRef && liveWidgets.has(String(ref));
        const hasWidgets = isWidget || kids.widgets > 0;
        widgets += hasWidgets ? 1 : 0;
        if (selfAlive || kids.alive > 0 || !hasWidgets) { alive++; continue; }
        a.remove(i);
        if (!isWidget || f.lookup(N('T'))) report.formFieldsRemoved++;
      }
      return { alive, widgets };
    };
    pruneFields(acro.get(N('Fields')), 0);
    // The calculation order names fields directly: one that left the form must leave it too, or the field (and its
    // value) would stay in the file through it.
    const co = acro.lookup(N('CO'));
    if (co instanceof PDFArray) {
      const inForm = new Set<string>();
      const collect = (arr: unknown, depth: number) => {
        const a = deref(arr);
        if (!(a instanceof PDFArray) || depth > 64) return;
        for (let i = 0; i < a.size(); i++) {
          const ref = a.get(i);
          if (ref instanceof PDFRef) inForm.add(String(ref));
          const f = deref(ref);
          if (f instanceof PDFDict) collect(f.get(N('Kids')), depth + 1);
        }
      };
      collect(acro.get(N('Fields')), 0);
      for (let i = co.size() - 1; i >= 0; i--) { const r = co.get(i); if (!(r instanceof PDFRef) || !inForm.has(String(r))) co.remove(i); }
      if (co.size() === 0) acro.delete(N('CO'));
    }
    if (acro.get(N('XFA')) !== undefined) { acro.delete(N('XFA')); report.xfaRemoved = true; }
    const fields = acro.lookup(N('Fields'));
    if (!(fields instanceof PDFArray) || fields.size() === 0) doc.catalog.delete(N('AcroForm'));
  }
  if (removedPages) {
    if (doc.catalog.get(N('StructTreeRoot')) !== undefined) {
      doc.catalog.delete(N('StructTreeRoot'));
      doc.catalog.delete(N('MarkInfo'));
      for (const ref of kept) ctx.lookup(ref, PDFDict).delete(N('StructParents'));
      report.tagsRemoved = true;
    }
    if (doc.catalog.get(N('Threads')) !== undefined) {
      doc.catalog.delete(N('Threads'));
      for (const ref of kept) ctx.lookup(ref, PDFDict).delete(N('B'));
      report.threadsRemoved = true;
    }
  }
  if (opts.reordered && doc.catalog.get(N('PageLabels')) !== undefined) { doc.catalog.delete(N('PageLabels')); report.labelsRemoved = true; }

  // ---- 4. Sweep: keep what the trailer reaches, never following a reference to a removed page.
  const isDeadPage = (ref: PDFRefT) => {
    if (live.has(String(ref))) return false;
    const o = ctx.lookup(ref);
    // A page without /Type is told by its content and parent; an annotation (a widget or a popup can have both) always
    // has a /Subtype, so it is never taken for one.
    return o instanceof PDFDict && (o.lookup(N('Type')) === N('Page') || (o.has(N('Contents')) && o.has(N('Parent')) && !o.has(N('Kids')) && o.get(N('Subtype')) === undefined));
  };
  const reach = new Set<string>();
  const stack: unknown[] = [];
  for (const k of ['Root', 'Info'] as const) { const v = ctx.trailerInfo[k]; if (v) stack.push(v); }
  const follow = (holder: PDFDictT | PDFArrayT, key: unknown, v: unknown) => {
    if (v instanceof PDFRef && isDeadPage(v)) {
      if (holder instanceof PDFArray) holder.set(key as number, PDFNull); else holder.set(key as ReturnType<typeof N>, PDFNull);
      report.referencesCleared++;
      return;
    }
    stack.push(v);
  };
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      const key = String(o);
      if (reach.has(key)) continue;
      reach.add(key);
      const t = ctx.lookup(o);
      if (t !== undefined) stack.push(t);
    } else if (o instanceof PDFRawStream) {
      for (const [k, v] of o.dict.entries()) follow(o.dict, k, v);
    } else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) follow(o, k, v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) follow(o, i, o.get(i));
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!reach.has(String(ref))) { ctx.delete(ref); report.objectsRemoved++; }
  let max = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) max = Math.max(max, ref.objectNumber);
  ctx.largestObjectNumber = max;
  return report;
}

export interface RotateReport {
  /** Pages turned. */
  rotated: number;
  /** Pages whose rotation was not a multiple of 90 (readers draw those upright), taken as 0 before turning. */
  invalid: number;
  clean: CleanReport;
}

/**
 * Turns the given pages (0-based, each once) by 90, 180 or 270 degrees clockwise, on top of the rotation they already
 * have (inherited rotation is pushed onto each page first). Only /Rotate changes: the content, its boxes and its
 * annotations stay as they are, so every reader turns the whole page. The document is then cleaned as every edit is.
 */
export function rotatePages(doc: PDFDocumentT, L: Lib, pages: readonly number[], by: number): RotateReport {
  const { PDFName, PDFDict, PDFNumber } = L;
  if (![90, 180, 270].includes(by)) throw new Error('Pages turn by 90, 180 or 270 degrees.');
  const refs = pageRefs(doc, L);
  if (!pages.length) throw new Error('Choose at least one page to turn.');
  for (const i of pages) if (!Number.isInteger(i) || i < 0 || i >= refs.length) throw new Error(`There is no page ${i + 1}; the PDF has ${refs.length}.`);
  if (new Set(pages).size !== pages.length) throw new Error('A page can be turned only once.');
  pushDownInherited(doc, L, refs);
  let invalid = 0;
  for (const i of pages) {
    const page = doc.context.lookup(refs[i], PDFDict);
    const cur = page.lookup(PDFName.of('Rotate'));
    let now = cur instanceof PDFNumber ? cur.asNumber() : 0;
    if (!Number.isInteger(now) || now % 90 !== 0) { invalid++; now = 0; }
    page.set(PDFName.of('Rotate'), doc.context.obj((((now + by) % 360) + 360) % 360));
  }
  const clean = cleanDocument(doc, L, { pagesRemoved: 0, reordered: false });
  return { rotated: pages.length, invalid, clean };
}
