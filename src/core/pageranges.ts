// Page selections typed as text, for the PDF tools: "1-3, 7, 10-" means pages 1 to 3, page 7, and page 10 to the end.
// "-4" is pages 1 to 4. Items are separated by commas (or semicolons); spaces do not matter. Pages are numbered from 1.
// A new page order (reorder) may also run backwards: "10-4" is pages 10, 9, 8, 7, 6, 5 and 4, so a reversed PDF of
// any length is one range ("5000-1"). Selections (split, extract, delete, rotate) refuse ranges that run backwards.
// Every mistake is refused with a message that says what to write instead; nothing is guessed or silently fixed.
// Ranges are expanded into pages only where each page may appear once, and the expansion stops at the first page
// listed twice, so it never makes more numbers than the PDF has pages.

export interface PageRange {
  /** First and last page, 1-based, inclusive. `from` is above `to` only in an order (a range that runs backwards). */
  from: number;
  to: number;
}

const ITEM = /^(\d+)?\s*(-)?\s*(\d+)?$/;
const MAX_TEXT = 20_000;

const fmt = (n: number) => n.toLocaleString('en-US');
const pagesWord = (n: number) => `${fmt(n)} ${n === 1 ? 'page' : 'pages'}`;

function parseItems(text: string, pages: number, backwards: boolean): PageRange[] {
  if (text.length > MAX_TEXT) throw new Error('That list of pages is too long.');
  const items = text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (!items.length) throw new Error(backwards ? 'Enter the new order, such as 3, 1, 2, 4-10.' : 'Enter the pages, such as 1-3, 7, 10-.');
  return items.map(item => {
    const m = ITEM.exec(item);
    if (!m || (!m[1] && !m[3]) || (!m[2] && m[3] !== undefined && m[1] !== undefined)) {
      throw new Error(backwards
        ? `"${item}" is not a page or a range of pages; write pages like 4, or ranges like 2-5, 10- or 9-6.`
        : `"${item}" is not a page or a range of pages; write pages like 4, or ranges like 2-5 or 10-.`);
    }
    const from = m[1] !== undefined ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] !== undefined ? Number(m[3]) : pages) : from;
    if (from === 0 || to === 0) throw new Error('There is no page 0; pages are numbered from 1.');
    if (from > pages) throw new Error(`There is no page ${fmt(from)}; the PDF has ${pagesWord(pages)}.`);
    if (from > to && !backwards) throw new Error(`"${item}" goes backwards; write it from low to high, as ${to}-${from}.`);
    if (to > pages) throw new Error(`There is no page ${fmt(to)}; the PDF has ${pagesWord(pages)}.`);
    return { from, to };
  });
}

/** The ranges in the text, in the order written, each from low to high. Ranges may overlap here; the callers decide
 *  whether that is allowed. */
export function parseRanges(text: string, pages: number): PageRange[] {
  return parseItems(text, pages, false);
}

/** Every page of the ranges, in order (1-based); a range that runs backwards gives its pages from high to low. */
export function pagesOf(ranges: readonly PageRange[]): number[] {
  const out: number[] = [];
  for (const r of ranges) {
    if (r.from <= r.to) for (let p = r.from; p <= r.to; p++) out.push(p);
    else for (let p = r.from; p >= r.to; p--) out.push(p);
  }
  return out;
}

/** Each page of the ranges once, in order. The first page listed twice is refused as soon as it is reached, so at most
 *  `pages` numbers are made whatever the ranges hold (every page is within the PDF). */
function distinctPages(ranges: readonly PageRange[], pages: number): number[] {
  const seen = new Uint8Array(pages + 1);
  const out: number[] = [];
  for (const r of ranges) {
    const step = r.from <= r.to ? 1 : -1;
    for (let p = r.from; ; p += step) {
      if (seen[p]) throw new Error(`Page ${fmt(p)} is listed more than once; list each page once.`);
      seen[p] = 1;
      out.push(p);
      if (p === r.to) break;
    }
  }
  return out;
}

/** A selection where each page may appear once (extract, delete, rotate): the pages in the order written. */
export function selectPages(text: string, pages: number): number[] {
  return distinctPages(parseRanges(text, pages), pages);
}

function missingMessage(listed: (p: number) => boolean, pages: number): string {
  const missing: number[] = [];
  for (let p = 1; p <= pages && missing.length < 6; p++) if (!listed(p)) missing.push(p);
  const shown = missing.length > 5 ? `${missing.slice(0, 5).join(', ')} and more` : missing.join(', ');
  return `Every page has to be in the order once; ${missing.length === 1 ? 'page' : 'pages'} ${shown} ${missing.length === 1 ? 'is' : 'are'} missing.`;
}

/** A new order for every page (reorder), typed as text: each page exactly once; ranges may run backwards ("9-6"). */
export function parseOrder(text: string, pages: number): number[] {
  const order = distinctPages(parseItems(text, pages, true), pages);
  if (order.length !== pages) {
    const listed = new Set(order);
    throw new Error(missingMessage(p => listed.has(p), pages));
  }
  return order;
}

/** A new order kept as a list (the reorder page list): the same rules as typed text, checked page by page. */
export function checkOrder(order: readonly number[], pages: number): number[] {
  const seen = new Uint8Array(pages + 1);
  for (const p of order) {
    if (!Number.isInteger(p) || p < 1 || p > pages) throw new Error(`There is no page ${fmt(p)}; the PDF has ${pagesWord(pages)}.`);
    if (seen[p]) throw new Error(`Page ${fmt(p)} is listed more than once; list each page once.`);
    seen[p] = 1;
  }
  if (order.length !== pages) throw new Error(missingMessage(p => seen[p] === 1, pages));
  return order.slice();
}

/** Pages written as short ranges, in their order: [1, 2, 3, 7, 9, 10] is "1-3, 7, 9-10". Only runs that go up are
 *  joined, so the text is a valid selection for every tool. */
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

/** A page order as short text that parseOrder reads back: runs that go up as "4-9", runs that go down as "9-4". Every
 *  page in reverse is one range ("5000-1"), and since the runs of an order are the runs of its reverse, backwards,
 *  reversing an order gives text of exactly the same length. */
export function formatOrder(list: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    if (j === i) while (j + 1 < list.length && list[j + 1] === list[j] - 1) j++;
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
