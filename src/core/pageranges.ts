// Page selections typed as text, for the PDF tools: "1-3, 7, 10-" means pages 1 to 3, page 7, and page 10 to the end.
// "-4" is pages 1 to 4. Items are separated by commas (or semicolons); spaces do not matter. Pages are numbered from 1.
// Every mistake is refused with a message that says what to write instead; nothing is guessed or silently fixed.

export interface PageRange {
  /** First and last page, 1-based, inclusive. */
  from: number;
  to: number;
}

const ITEM = /^(\d+)?\s*(-)?\s*(\d+)?$/;
const MAX_TEXT = 20_000;

const fmt = (n: number) => n.toLocaleString('en-US');
const pagesWord = (n: number) => `${fmt(n)} ${n === 1 ? 'page' : 'pages'}`;

/** The ranges in the text, in the order written. Ranges may overlap here; the callers decide whether that is allowed. */
export function parseRanges(text: string, pages: number): PageRange[] {
  if (text.length > MAX_TEXT) throw new Error('That list of pages is too long.');
  const items = text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (!items.length) throw new Error('Enter the pages, such as 1-3, 7, 10-.');
  return items.map(item => {
    const m = ITEM.exec(item);
    if (!m || (!m[1] && !m[3]) || (!m[2] && m[3] !== undefined && m[1] !== undefined)) {
      throw new Error(`"${item}" is not a page or a range of pages; write pages like 4, or ranges like 2-5 or 10-.`);
    }
    const from = m[1] !== undefined ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] !== undefined ? Number(m[3]) : pages) : from;
    if (from === 0 || to === 0) throw new Error('There is no page 0; pages are numbered from 1.');
    if (from > pages) throw new Error(`There is no page ${fmt(from)}; the PDF has ${pagesWord(pages)}.`);
    if (from > to) throw new Error(`"${item}" goes backwards; write it from low to high, as ${to}-${from}.`);
    if (to > pages) throw new Error(`There is no page ${fmt(to)}; the PDF has ${pagesWord(pages)}.`);
    return { from, to };
  });
}

/** Every page of the ranges, in order (1-based). */
export function pagesOf(ranges: readonly PageRange[]): number[] {
  const out: number[] = [];
  for (const r of ranges) for (let p = r.from; p <= r.to; p++) out.push(p);
  return out;
}

/** A selection where each page may appear once (extract, delete, rotate): the pages in the order written. */
export function selectPages(text: string, pages: number): number[] {
  const out = pagesOf(parseRanges(text, pages));
  const seen = new Set<number>();
  for (const p of out) {
    if (seen.has(p)) throw new Error(`Page ${fmt(p)} is listed more than once; list each page once.`);
    seen.add(p);
  }
  return out;
}

/** A new order for every page (reorder): each page exactly once. */
export function parseOrder(text: string, pages: number): number[] {
  const order = selectPages(text, pages);
  if (order.length !== pages) {
    const listed = new Set(order);
    const missing: number[] = [];
    for (let p = 1; p <= pages && missing.length < 6; p++) if (!listed.has(p)) missing.push(p);
    const shown = missing.length > 5 ? `${missing.slice(0, 5).join(', ')} and more` : missing.join(', ');
    throw new Error(`Every page has to be in the order once; ${missing.length === 1 ? 'page' : 'pages'} ${shown} ${missing.length === 1 ? 'is' : 'are'} missing.`);
  }
  return order;
}

/** Pages written as short ranges, in their order: [1, 2, 3, 7, 9, 10] is "1-3, 7, 9-10". */
export function formatPages(list: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    parts.push(j > i ? `${list[i]}-${list[j]}` : String(list[i]));
    i = j + 1;
  }
  return parts.join(', ');
}

/** Consecutive parts of n pages each (the last may be shorter). */
export function everyN(pages: number, n: number): PageRange[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('Enter how many pages each file should have, 1 or more.');
  const out: PageRange[] = [];
  for (let from = 1; from <= pages; from += n) out.push({ from, to: Math.min(pages, from + n - 1) });
  return out;
}
