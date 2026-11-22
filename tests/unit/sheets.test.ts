import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import { convertData, DEFAULT_DATA_OPTIONS, excelDateToIso, type DataOptions } from '../../src/engines/data/convert';
import { parseCsv } from '../../src/engines/data/csv';
import { splitAstralReferences } from '../../src/engines/data/xlsxtext';

// Spreadsheets and TSV (v0.2.0): XLSX to JSON, JSON to XLSX, and TSV as its own format.

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const txt = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const run = (from: string, to: string, bytes: Uint8Array, o: Partial<DataOptions> = {}) => convertData(from, to, bytes, { ...DEFAULT_DATA_OPTIONS, ...o }, 'sample');
const json = (r: ReturnType<typeof run>) => JSON.parse(txt(r.outputs[0].bytes));

describe('XLSX to JSON', () => {
  test('keeps types: numbers exact, booleans, null for empty cells, ISO 8601 dates, text as text', () => {
    // openpyxl, like Excel, stores 15 significant digits (0.1 + 0.2 is stored as 0.3); the JSON has the stored value.
    const r = run('xlsx', 'json', fx('data/types.xlsx'));
    const rows = json(r);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      Text: 'Zo\u00eb \u65e5\u672c \u{1F600} \u0645\u0631\u062d\u0628\u0627', Number: 0.3, Date: '2026-11-22',
      DateTime: '2026-11-22T14:30:05', Time: '14:30:00', Percent: 0.25, Flag: true, Empty: null, Error: '#DIV/0!', Big: 9007199254740992,
    });
    expect(rows[1]).toMatchObject({ Text: '=not a formula', Number: -1234.5678, Date: '1900-03-01', DateTime: '2000-02-29T23:59:59', Time: '00:00:01', Percent: 1.5, Flag: false });
    expect(rows[2]).toMatchObject({ Text: 'last', Number: 1e21, Date: null });
    const notes = r.warnings.join(' ');
    expect(notes).toMatch(/1 empty row left out/);
    expect(notes).toMatch(/6 date cells became ISO 8601 text/);
    expect(notes).toMatch(/1 cell held an Excel error/);
    expect(r.summary).toBe('3 records');
  });

  test('the "as shown in Excel" setting does not turn JSON numbers into text', () => {
    expect(json(run('xlsx', 'json', fx('data/types.xlsx'), { values: 'formatted' }))).toEqual(json(run('xlsx', 'json', fx('data/types.xlsx'), { values: 'raw' })));
  });

  test('the 1904 date system gives the same calendar date, and serials map to ISO text', () => {
    expect(json(run('xlsx', 'json', fx('data/dates1904.xlsx')))).toEqual([{ When: '2026-11-22' }]);
    expect(excelDateToIso(46348, false)).toBe('2026-11-22');
    expect(excelDateToIso(46348.6041666667, false)).toBe('2026-11-22T14:30:00');
    expect(excelDateToIso(0.5, false)).toBe('12:00:00');
    expect(excelDateToIso(61, false)).toBe('1900-03-01');
  });

  test('first sheet with a note by default, a named sheet, or all sheets in one object', () => {
    const first = run('xlsx', 'json', fx('data/workbook.xlsx'));
    expect(first.warnings[0]).toMatch(/Converted the first sheet, "People"\. The workbook has 2 sheets/);
    expect(json(first)[0]).toEqual({ Name: 'Ada', Joined: '2024-01-15', Amount: 1200.5, Zip: '01234', Active: true });
    expect(json(run('xlsx', 'json', fx('data/workbook.xlsx'), { sheet: { name: 'Totals' } })))
      .toEqual([{ Metric: 'Count', Value: 3 }, { Metric: 'Note', Value: '=1+1 is text here' }, { Metric: 'Doubled', Value: null }]);
    const all = run('xlsx', 'json', fx('data/workbook.xlsx'), { sheet: 'all' });
    expect(all.outputs).toHaveLength(1);
    expect(Object.keys(json(all))).toEqual(['People', 'Totals']);
    expect(all.warnings.join(' ')).toMatch(/1 formula cell had no saved result and became null/);
  });

  test('without a header row each row is a list; dotted headings can rebuild objects', () => {
    expect(json(run('xlsx', 'json', fx('data/workbook.xlsx'), { header: false }))[0]).toEqual(['Name', 'Joined', 'Amount', 'Zip', 'Active']);
    const x = run('json', 'xlsx', enc(JSON.stringify([{ id: 1, address: { city: 'Oslo', zip: '0150' } }])));
    expect(json(run('xlsx', 'json', x.outputs[0].bytes, { nest: true }))).toEqual([{ id: 1, address: { city: 'Oslo', zip: '0150' } }]);
  });

  test('refuses a zip bomb before unpacking it', () => {
    expect(() => run('xlsx', 'json', fx('hostile/zip-bomb.docx'))).toThrow(/expand|ratio|larger|limit|bomb/i);
  });
});

describe('JSON to XLSX', () => {
  const first = (bytes: Uint8Array) => { const wb = XLSX.read(bytes, { type: 'array' }); return { wb, ws: wb.Sheets[wb.SheetNames[0]] }; };

  test('typed cells: numbers, booleans, text never a formula, exact big integers, empty for null, ragged records', () => {
    const text = '[{"name":"Zo\u00eb \u{1F600}","n":0.1,"flag":true,"formula":"=HYPERLINK(\\"x\\")","big":12345678901234567890,"none":null,"when":"2026-11-22"},'
      + '{"name":"Grace","n":-5,"flag":false,"extra":"only here"}]';
    const r = run('json', 'xlsx', enc(text));
    const { ws } = first(r.outputs[0].bytes);
    expect(ws.A1.v).toBe('name');
    expect(ws.A2).toMatchObject({ t: 's', v: 'Zo\u00eb \u{1F600}' });
    expect(ws.B2).toMatchObject({ t: 'n', v: 0.1 });
    expect(ws.C2).toMatchObject({ t: 'b', v: true });
    expect(ws.D2).toMatchObject({ t: 's', v: '=HYPERLINK("x")' });
    expect(ws.D2.f).toBeUndefined();
    expect(ws.E2).toMatchObject({ t: 's', v: '12345678901234567890' });
    expect(ws.F2).toBeUndefined();
    expect(ws.G2).toMatchObject({ t: 's', v: '2026-11-22' });
    expect(ws.H3).toMatchObject({ t: 's', v: 'only here' });
    const notes = r.warnings.join(' ');
    expect(notes).toMatch(/1 integer larger than Excel can hold exactly is stored as text/);
    expect(notes).toMatch(/do not all have the same fields: there is one column for every field seen, and 2 records have empty cells/);
  });

  test('an object of lists becomes one sheet per list, with Excel-safe names', () => {
    const r = run('json', 'xlsx', enc(JSON.stringify({ people: [{ a: 1 }], 'orders/2026: [Q4]': [{ b: 2 }], people2: [] })));
    expect(first(r.outputs[0].bytes).wb.SheetNames).toEqual(['people', 'orders_2026_ _Q4_', 'people2']);
    expect(r.warnings[0]).toBe('Each of the 3 lists became its own sheet; their rows are not combined with each other.');
    expect(r.warnings[1]).toBe('"people2" is an empty list, so its sheet has no rows.');
    expect(r.summary).toBe('3 sheets, 2 rows');
  });

  test('round trip: JSON to XLSX to JSON keeps values and types', () => {
    const records = [{ id: 1, name: 'Ada', score: 0.1 + 0.2, ok: true, note: null }, { id: 2, name: '\u65e5\u672c \u{1F600}', score: -1e-300, ok: false, note: 'x' }];
    const x = run('json', 'xlsx', enc(JSON.stringify(records)));
    expect(json(run('xlsx', 'json', x.outputs[0].bytes))).toEqual(records);
  });
});

describe('TSV', () => {
  test('JSON to TSV uses tabs and quotes fields that hold a tab or a line break', () => {
    const r = run('json', 'tsv', enc(JSON.stringify([{ a: 'x\ty', b: 'line\nbreak', c: 3 }])), { bom: false });
    expect(r.outputs[0]).toMatchObject({ ext: 'tsv', mime: 'text/tab-separated-values' });
    expect(txt(r.outputs[0].bytes)).toBe('a\tb\tc\r\n"x\ty"\t"line\nbreak"\t3\r\n');
  });

  test('TSV is read with tabs even when commas are everywhere, and converts to JSON, CSV and XLSX', () => {
    const tsv = enc('name\tnote\r\nAda\t"a, b, c"\r\nGrace\t1,5\r\n');
    expect(json(run('tsv', 'json', tsv))).toEqual([{ name: 'Ada', note: 'a, b, c' }, { name: 'Grace', note: '1,5' }]);
    expect(txt(run('tsv', 'csv', tsv, { bom: false }).outputs[0].bytes)).toBe('name,note\r\nAda,"a, b, c"\r\nGrace,"1,5"\r\n');
    const wb = XLSX.read(run('tsv', 'xlsx', tsv).outputs[0].bytes, { type: 'array' });
    expect(wb.Sheets[wb.SheetNames[0]].B2.v).toBe('a, b, c');
  });

  test('CSV to TSV and XLSX to TSV', () => {
    expect(txt(run('csv', 'tsv', enc('a,b\r\n1,"x\ty"\r\n'), { bom: false }).outputs[0].bytes)).toBe('a\tb\r\n1\t"x\ty"\r\n');
    const r = run('xlsx', 'tsv', fx('data/workbook.xlsx'), { bom: false });
    expect(r.outputs[0].ext).toBe('tsv');
    expect(txt(r.outputs[0].bytes).split('\r\n')[0]).toBe('Name\tJoined\tAmount\tZip\tActive');
  });

  test('formula protection works in TSV and CSV, says how many cells it changed, and can be turned off', () => {
    const risky = enc(JSON.stringify([{ a: '=cmd|"/c calc"!A1', b: '+1+1', c: '-2+3', d: '@SUM(A1)', e: '\t=1', f: '-5', g: 5 }]));
    for (const to of ['csv', 'tsv'] as const) {
      const d = to === 'tsv' ? '\t' : ',';
      const on = run('json', to, risky, { bom: false });
      const row = parseCsv(txt(on.outputs[0].bytes), d, 100).rows[1];
      expect(row.slice(0, 5)).toEqual(["'=cmd|\"/c calc\"!A1", "'+1+1", "'-2+3", "'@SUM(A1)", "'\t=1"]);
      expect(row.slice(5)).toEqual(['-5', '5']);
      expect(on.warnings.join(' ')).toMatch(/5 cells starting with = \+ - or @ got a leading apostrophe.*Turn off formula protection/);
      const off = run('json', to, risky, { bom: false, neutralizeFormulas: false });
      expect(parseCsv(txt(off.outputs[0].bytes), d, 100).rows[1].slice(0, 5)).toEqual(['=cmd|"/c calc"!A1', '+1+1', '-2+3', '@SUM(A1)', '\t=1']);
      expect(off.warnings.join(' ')).not.toMatch(/apostrophe/);
    }
  });
});

describe('characters beyond the Basic Multilingual Plane', () => {
  test('numeric references to emoji (as openpyxl and pandas write them) survive XLSX to JSON and to CSV', () => {
    const csv = txt(run('xlsx', 'csv', fx('data/types.xlsx'), { bom: false }).outputs[0].bytes);
    expect(csv.split('\r\n')[1].startsWith('Zo\u00eb \u65e5\u672c \u{1F600} ')).toBe(true);
  });

  test('a reference is split into its two surrogate references; others are left as they are', () => {
    expect(splitAstralReferences('<t>&#128512; &#x1F600; &#235; &#xEB; &amp;</t>')).toEqual({ xml: '<t>&#55357;&#56832; &#55357;&#56832; &#235; &#xEB; &amp;</t>', fixed: 2 });
    expect(splitAstralReferences('<t>&#1114112;</t>').fixed).toBe(0);
  });
});
