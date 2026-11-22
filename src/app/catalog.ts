// The catalog's search and category filter. The list of pages is static HTML, built with the page; this script
// only filters it, and answers "does it convert X to Y?" from the format registry for conversions that have no
// page of their own. Unsupported formats people often ask for get the same reason the converter would give.

import { allConversions, ANIMATED_IN, FORMATS, targetsFor, type FormatId } from '../core/formats';
import { $, clear, h } from './dom';

const STOP = new Set(['to', 'into', 'convert', 'converter', 'conversion', 'converting', 'file', 'files', 'from', 'a', 'an', 'the', 'online', 'free', 'and', 'or', 'as', 'in', 'for', 'my']);

/** Words that name a format: labels, every extension, and a few everyday names. */
const WORDS = new Map<string, FormatId>();
for (const f of Object.values(FORMATS)) {
  WORDS.set(f.label.toLowerCase(), f.id);
  for (const e of f.exts) WORDS.set(e, f.id);
}
for (const [w, id] of [['excel', 'xlsx'], ['spreadsheet', 'xlsx'], ['word', 'docx'], ['quicktime', 'mov'], ['matroska', 'mkv']] as const) WORDS.set(w, id);

const ARCHIVE = 'RAR and 7-Zip archives are not supported. ZIP, TAR and GZ archives can be unpacked, and their files converted.';
const RAW = 'Camera RAW files are not supported. Export a JPG or TIFF from your camera software first.';
/** Formats that are recognized but not converted, with the reason. Kept in step with src/core/sniff.ts. */
export const NOT_SUPPORTED: Readonly<Record<string, string>> = {
  avi: 'AVI video is not supported yet. MP4, WebM, MOV and MKV are.',
  wmv: 'Windows Media files (WMV, WMA) are not supported yet.', wma: 'Windows Media files (WMV, WMA) are not supported yet.', asf: 'Windows Media files (WMV, WMA) are not supported yet.',
  doc: 'Older Word documents (DOC) are not supported. Save them as DOCX first.',
  ppt: 'PowerPoint files are not supported.', pptx: 'PowerPoint files are not supported.',
  odt: 'OpenDocument text (ODT) and presentations (ODP) are not supported. ODS spreadsheets are.', odp: 'OpenDocument text (ODT) and presentations (ODP) are not supported. ODS spreadsheets are.',
  epub: 'EPUB books are not supported.', rtf: 'RTF documents are not supported.',
  psd: 'Photoshop files (PSD) are not supported.', jxl: 'JPEG XL is not supported yet.',
  rar: ARCHIVE, '7z': ARCHIVE,
  raw: RAW, cr2: RAW, cr3: RAW, nef: RAW, arw: RAW, dng: RAW, orf: RAW, rw2: RAW, raf: RAW,
};

export interface Query {
  /** Words that must all match a page (each as the start of one of its search terms). */
  tokens: string[];
  /** Formats named in the query, in order. */
  formats: FormatId[];
  /** Named formats FileConvert does not convert, with the reason. */
  unsupported: string[];
}

export function parseQuery(text: string): Query {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t));
  const formats: FormatId[] = [];
  const unsupported: string[] = [];
  for (const t of tokens) {
    const id = WORDS.get(t);
    if (id && !formats.includes(id)) formats.push(id);
    const why = NOT_SUPPORTED[t];
    if (!id && why && !unsupported.includes(why)) unsupported.push(why);
  }
  return { tokens, formats, unsupported };
}

const PAIRS = new Set(allConversions().filter(([a, b]) => a !== b).map(([a, b]) => `${a}>${b}`));
const label = (id: FormatId) => FORMATS[id].label;
const listOf = (ids: FormatId[]) => ids.map(label).join(', ');

/** Answers for the formats named in a query that the page list alone cannot give. */
export function answers(q: Query, hasPage: (from: FormatId, to: FormatId) => boolean): string[] {
  const out = [...q.unsupported];
  const [a, b] = q.formats;
  const archive = (f: FormatId | undefined) => !!f && FORMATS[f].category === 'archive';
  if (archive(a)) {
    // Archives are unpacked, never converted into another archive format.
    out.push(`${label(a)} archives are unpacked, not converted: add one to the converter at the top of the page and choose Extract files, then download the files inside or convert them.`);
    if (b && archive(b) && b !== a) out.push(`FileConvert does not turn one archive format into another, such as ${label(a)} to ${label(b)}.`);
  } else if (archive(b)) {
    out.push(`FileConvert unpacks ZIP, TAR and GZ archives but does not make them, apart from downloading several converted files together as one ZIP.`);
  } else if (a && b) {
    if (PAIRS.has(`${a}>${b}`)) {
      if (!hasPage(a, b)) out.push(`${label(a)} to ${label(b)} is supported. Add your file to the converter at the top of the page and choose ${label(b)}.`);
    } else if (b === 'heic') {
      out.push('HEIC is read but not written: the open HEVC encoders are GPL-licensed and patent-encumbered.');
    } else if (a !== b) {
      out.push(`FileConvert does not convert ${label(a)} to ${label(b)}.`);
    }
  } else if (a) {
    const to = targetsFor(a, ANIMATED_IN.includes(a) ? { animated: true } : {}).filter(t => t !== a);
    const from = (Object.keys(FORMATS) as FormatId[]).filter(x => x !== a && PAIRS.has(`${x}>${a}`));
    if (to.length) out.push(`${label(a)} converts to ${listOf(to)}.`);
    if (from.length) out.push(`${label(a)} can be made from ${listOf(from)}.`);
  }
  return out;
}

const matches = (terms: string[], tokens: string[]) => tokens.every(t => terms.some(w => w.startsWith(t)));

export function setupCatalog(): void {
  const tools = document.getElementById('catalog-tools');
  const input = document.getElementById('catalog-search') as HTMLInputElement | null;
  if (!tools || !input) return;
  tools.hidden = false;
  const status = $('catalog-status');
  const more = $('catalog-more');
  const items = [...document.querySelectorAll<HTMLElement>('.cat-item')];
  const groups = [...document.querySelectorAll<HTMLElement>('.cat-group')];
  const chips = [...tools.querySelectorAll<HTMLButtonElement>('.chip')];
  const hasPage = (a: FormatId, b: FormatId) => items.some(i => i.dataset.from === a && i.dataset.to === b);
  let category = '';

  const update = () => {
    const q = parseQuery(input.value);
    let shown = 0;
    for (const item of items) {
      // A query naming two formats asks for a conversion, so tool pages are left out of its results.
      const ok = (!category || item.dataset.cat === category) && matches((item.dataset.terms ?? '').split(' '), q.tokens) && !(item.dataset.tool && q.formats.length >= 2);
      item.hidden = !ok;
      if (ok) shown++;
    }
    for (const g of groups) g.hidden = !g.querySelector('.cat-item:not([hidden])');
    const lines = q.tokens.length ? answers(q, hasPage) : [];
    clear(more);
    for (const l of lines) more.append(h('p', {}, l));
    if (lines.some(l => l.includes('converter at the top'))) {
      more.append(h('button', { type: 'button', class: 'small primary', onclick: () => document.getElementById('choose')?.click() }, 'Choose files'));
    }
    more.hidden = lines.length === 0;
    status.textContent = !q.tokens.length && !category ? ''
      : shown ? `${shown} ${shown === 1 ? 'page matches' : 'pages match'}.`
      : 'No page matches.';
  };
  input.addEventListener('input', update);
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      category = chip.dataset.cat ?? '';
      for (const c of chips) c.setAttribute('aria-pressed', String(c === chip));
      update();
    });
  }
  if (input.value) update();
}

