import { describe, expect, test } from 'vitest';
import { everyN, formatPages, pagesOf, parseOrder, parseRanges, selectPages } from '../../src/core/pageranges';

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
