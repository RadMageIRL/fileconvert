import { describe, expect, test } from 'vitest';
import { checkOrder, everyN, formatOrder, formatPages, pagesOf, parseOrder, parseRanges, selectPages } from '../../src/core/pageranges';

describe('page ranges typed as text', () => {
  test('pages, ranges, open ends, spaces and semicolons', () => {
    expect(parseRanges('1-3, 7, 10-', 12)).toEqual([{ from: 1, to: 3 }, { from: 7, to: 7 }, { from: 10, to: 12 }]);
    expect(parseRanges(' -2 ;5 - 6,', 8)).toEqual([{ from: 1, to: 2 }, { from: 5, to: 6 }]);
    expect(pagesOf(parseRanges('2-4, 3', 5))).toEqual([2, 3, 4, 3]);
  });

  test('every mistake gets a message saying what to write instead', () => {
    const err = (t: string, n = 10) => { try { parseRanges(t, n); return 'accepted'; } catch (e) { return (e as Error).message; } };
    expect(err('')).toBe('Enter the pages, such as 1-3, 7, 10-.');
    expect(err(' , ')).toBe('Enter the pages, such as 1-3, 7, 10-.');
    expect(err('a')).toBe('"a" is not a page or a range of pages; write pages like 4, or ranges like 2-5 or 10-.');
    expect(err('4 5')).toMatch(/^"4 5" is not a page/);
    expect(err('-')).toMatch(/^"-" is not a page/);
    expect(err('1-2-3')).toMatch(/^"1-2-3" is not a page/);
    expect(err('0')).toBe('There is no page 0; pages are numbered from 1.');
    expect(err('7-3')).toBe('"7-3" goes backwards; write it from low to high, as 3-7.');
    expect(err('11')).toBe('There is no page 11; the PDF has 10 pages.');
    expect(err('9-12')).toBe('There is no page 12; the PDF has 10 pages.');
    expect(err('12-', 10)).toBe('There is no page 12; the PDF has 10 pages.');
    expect(err('2', 1)).toBe('There is no page 2; the PDF has 1 page.');
    expect(err('1'.repeat(20_001))).toBe('That list of pages is too long.');
  });

  test('a selection lists each page once, in the order written', () => {
    expect(selectPages('5-6, 1', 6)).toEqual([5, 6, 1]);
    expect(() => selectPages('1-3, 2', 6)).toThrow('Page 2 is listed more than once; list each page once.');
  });

  test('an order holds every page once', () => {
    expect(parseOrder('3, 1, 2', 3)).toEqual([3, 1, 2]);
    expect(() => parseOrder('3, 1', 3)).toThrow('Every page has to be in the order once; page 2 is missing.');
    expect(() => parseOrder('1', 9)).toThrow('Every page has to be in the order once; pages 2, 3, 4, 5, 6 and more are missing.');
    expect(() => parseOrder('1, 1, 2', 2)).toThrow('Page 1 is listed more than once');
  });

  test('pages written back as short ranges, and parts of N pages', () => {
    expect(formatPages([1, 2, 3, 7, 9, 10, 4])).toBe('1-3, 7, 9-10, 4');
    expect(formatPages([])).toBe('');
    expect(everyN(7, 3)).toEqual([{ from: 1, to: 3 }, { from: 4, to: 6 }, { from: 7, to: 7 }]);
    expect(everyN(2, 5)).toEqual([{ from: 1, to: 2 }]);
    expect(() => everyN(5, 0)).toThrow('Enter how many pages each file should have, 1 or more.');
  });
});

describe('page tool helpers', () => {
  test('file names carry the pages, padded so they sort', async () => {
    const { pageLabel } = await import('../../src/tools/pdf-common');
    expect(pageLabel(3, 3, 12)).toBe('p03');
    expect(pageLabel(1, 4, 12)).toBe('p01-04');
    expect(pageLabel(7, 7, 9)).toBe('p7');
    expect(pageLabel(98, 120, 1200)).toBe('p0098-0120');
  });
  test('split parts from the options: ranges as written, every N, single pages', async () => {
    const { splitParts } = await import('../../src/tools/split-pdf');
    expect(splitParts({ mode: 'ranges', ranges: '4-, 1-2' }, 5)).toEqual([{ from: 4, to: 5 }, { from: 1, to: 2 }]);
    expect(splitParts({ mode: 'every', every: 2 }, 5)).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }, { from: 5, to: 5 }]);
    expect(splitParts({ mode: 'each' }, 2)).toEqual([{ from: 1, to: 1 }, { from: 2, to: 2 }]);
  });
});

describe('a new page order: ranges that run backwards, kept as a list (the Reverse button)', () => {
  /** A seeded shuffle, so a failure can be repeated. */
  const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const identity = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const shuffled = (n: number, seed: number) => { const r = rng(seed), a = identity(n); for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  /** An order made the way the page list makes one: some pages moved one at a time. */
  const moved = (n: number, moves: number, seed: number) => {
    const r = rng(seed), a = identity(n);
    for (let k = 0; k < moves; k++) { const [p] = a.splice(Math.floor(r() * n), 1); a.splice(Math.floor(r() * n), 0, p); }
    return a;
  };
  const err = (f: () => unknown) => { try { f(); return 'accepted'; } catch (e) { return (e as Error).message; } };

  test('an order may run backwards, alone or mixed with ranges that go up', () => {
    expect(parseOrder('4-1', 4)).toEqual([4, 3, 2, 1]);
    expect(parseOrder('5000-1', 5000)).toEqual(identity(5000).reverse());
    expect(parseOrder('1-3, 10-4, 11-12', 12)).toEqual([1, 2, 3, 10, 9, 8, 7, 6, 5, 4, 11, 12]);
    expect(parseOrder('6-, 5-1', 8)).toEqual([6, 7, 8, 5, 4, 3, 2, 1]);
    expect(parseOrder('2-1, 3', 3)).toEqual([2, 1, 3]);
    expect(parseOrder(' 3 - 1 ', 3)).toEqual([3, 2, 1]);
  });

  test('an order still refuses pages listed twice, pages it does not have and pages left out', () => {
    expect(err(() => parseOrder('5-1, 3', 5))).toBe('Page 3 is listed more than once; list each page once.');
    expect(err(() => parseOrder('1-3, 3-1', 3))).toBe('Page 3 is listed more than once; list each page once.');
    expect(err(() => parseOrder('6-1', 5))).toBe('There is no page 6; the PDF has 5 pages.');
    expect(err(() => parseOrder('4234-1', 4000))).toBe('There is no page 4,234; the PDF has 4,000 pages.');
    expect(err(() => parseOrder('3-0', 3))).toBe('There is no page 0; pages are numbered from 1.');
    expect(err(() => parseOrder('5-3', 5))).toBe('Every page has to be in the order once; pages 1, 2 are missing.');
    expect(err(() => parseOrder('9-a', 9))).toBe('"9-a" is not a page or a range of pages; write pages like 4, or ranges like 2-5, 10- or 9-6.');
    expect(err(() => parseOrder('', 3))).toBe('Enter the new order, such as 3, 1, 2, 4-10.');
    expect(err(() => parseOrder('1'.repeat(20_001), 3))).toBe('That list of pages is too long.');
  });

  test('selections (split, extract, delete, rotate) still refuse ranges that run backwards', async () => {
    expect(err(() => parseRanges('7-3', 10))).toBe('"7-3" goes backwards; write it from low to high, as 3-7.');
    expect(err(() => selectPages('4-1', 4))).toBe('"4-1" goes backwards; write it from low to high, as 1-4.');
    const { splitParts } = await import('../../src/tools/split-pdf');
    expect(err(() => splitParts({ mode: 'ranges', ranges: '1-2, 5-3' }, 5))).toBe('"5-3" goes backwards; write it from low to high, as 3-5.');
    // And their messages and pages are the same as before.
    expect(selectPages('5-6, 1', 6)).toEqual([5, 6, 1]);
    expect(err(() => parseRanges('', 3))).toBe('Enter the pages, such as 1-3, 7, 10-.');
    expect(err(() => parseRanges('9-a', 9))).toBe('"9-a" is not a page or a range of pages; write pages like 4, or ranges like 2-5 or 10-.');
  });

  test('ranges are expanded only as far as the PDF has pages, however many are written', () => {
    // Every page made is pushed onto the list, so counting pushes counts the expansion.
    const push = Array.prototype.push;
    let pushed = 0;
    const counted = (f: () => unknown) => {
      pushed = 0;
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) { pushed++; return push.apply(this, items); };
      try { return err(f); } finally { Array.prototype.push = push; }
    };
    // 2,857 copies of every page of a 5,000-page PDF fit in the text: 14 million pages if all were expanded.
    const text = '1-5000,'.repeat(2857);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(counted(() => selectPages(text, 5000))).toBe('Page 1 is listed more than once; list each page once.');
    expect(pushed).toBeLessThanOrEqual(5000);
    expect(counted(() => parseOrder('5000-1,'.repeat(2857), 5000))).toBe('Page 5,000 is listed more than once; list each page once.');
    expect(pushed).toBeLessThanOrEqual(5000);
    expect(counted(() => parseOrder('1-4999, 4999-1', 5000))).toBe('Page 4,999 is listed more than once; list each page once.');
    expect(pushed).toBe(4999);
    expect(counted(() => parseOrder('5000-1', 5000))).toBe('accepted');
    expect(pushed).toBe(5000);
  });

  /** An order through its text when the text fits (the box), else through the list the workspace keeps. */
  const roundTrip = (o: number[], n: number) => {
    const text = formatOrder(o);
    return text.length <= 20_000 ? parseOrder(text, n) : checkOrder(o, n);
  };

  test('an order written as text reads back as itself, and any order works as the list', () => {
    let throughText = 0, throughList = 0;
    for (const n of [1, 2, 3, 4, 7, 50, 999, 5000]) {
      const orders = [identity(n), identity(n).reverse(), shuffled(n, n), shuffled(n, n + 1), moved(n, 3, n), moved(n, 40, n + 7)];
      for (const o of orders) {
        expect(roundTrip(o, n)).toEqual(o);
        if (formatOrder(o).length <= 20_000) throughText++; else throughList++;
      }
    }
    // Only the shuffled 5,000-page orders are too long to type; the list is what carries them.
    expect([throughText, throughList]).toEqual([46, 2]);
    expect(formatOrder(identity(5000).reverse())).toBe('5000-1');
    expect(formatOrder(identity(4234).reverse())).toBe('4234-1');
    expect(formatOrder([3, 1, 2])).toBe('3, 1-2');
    expect(formatOrder([2, 1, 3])).toBe('2-1, 3');
    expect(formatOrder([1, 2, 3, 10, 9, 8, 4, 7, 6, 5])).toBe('1-3, 10-8, 4, 7-5');
    expect(formatOrder([])).toBe('');
  });

  test('reversing twice gives the first order back, and never makes the text longer', () => {
    for (const n of [1, 2, 3, 900, 3600, 4234, 5000]) {
      for (const o of [identity(n), shuffled(n, 3 * n), moved(n, 25, 5 * n)]) {
        const once = roundTrip(o.slice().reverse(), n);
        expect(once).toEqual(o.slice().reverse());
        expect(formatOrder(once).length).toBe(formatOrder(o).length);
        const twice = roundTrip(once.slice().reverse(), n);
        expect(twice).toEqual(o);
        expect(formatOrder(twice)).toBe(formatOrder(o));
      }
    }
    // Every order the box can hold, reversed, fits the box again: its text is exactly as long.
    for (const n of [900, 3600, 5000]) {
      const o = moved(n, 25, n);
      expect(formatOrder(o.slice().reverse()).length).toBe(formatOrder(o).length);
      expect(formatOrder(o).length).toBeLessThan(20_000);
    }
    // Before, the reversed order of 3,600 pages was written page by page, past the limit of the text.
    expect(formatPages(identity(3600).reverse()).length).toBeGreaterThan(20_000);
  });

  test('an order kept as a list is checked as strictly as typed text', async () => {
    expect(checkOrder([2, 1, 3], 3)).toEqual([2, 1, 3]);
    expect(err(() => checkOrder([1, 1, 2], 3))).toBe('Page 1 is listed more than once; list each page once.');
    expect(err(() => checkOrder([1, 4, 2], 3))).toBe('There is no page 4; the PDF has 3 pages.');
    expect(err(() => checkOrder([0, 1, 2], 3))).toBe('There is no page 0; the PDF has 3 pages.');
    expect(err(() => checkOrder([1.5, 1, 2], 3))).toBe('There is no page 1.5; the PDF has 3 pages.');
    expect(err(() => checkOrder([1, 2], 3))).toBe('Every page has to be in the order once; page 3 is missing.');
    expect(err(() => checkOrder([1, 2, 3, 3], 3))).toBe('Page 3 is listed more than once; list each page once.');
    // The tool takes the list or the text, the same way.
    const { orderOf } = await import('../../src/tools/organize-pdf');
    expect(orderOf([3, 2, 1], 3)).toEqual([3, 2, 1]);
    expect(orderOf('3-1', 3)).toEqual([3, 2, 1]);
    expect(err(() => orderOf('3, 3', 3))).toBe('Page 3 is listed more than once; list each page once.');
    expect(err(() => orderOf([3, 3, 1], 3))).toBe('Page 3 is listed more than once; list each page once.');
    // An order whose text would be too long to type is still an order as a list.
    const long = shuffled(5000, 11);
    expect(formatOrder(long).length).toBeGreaterThan(20_000);
    expect(orderOf(long, 5000)).toEqual(long);
  });
});
