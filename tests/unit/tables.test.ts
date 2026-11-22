import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import { convertData, DEFAULT_DATA_OPTIONS, generalNumber, stringifyJson, xlsxSheetNames, type DataOptions } from '../../src/engines/data/convert';
import { parseCsv } from '../../src/engines/data/csv';
import { sniff } from '../../src/core/sniff';

// Phase 1B data (v0.2.0): JSON Lines, XML and YAML to tables, XLS and ODS input.

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const txt = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const run = (from: string, to: string, bytes: Uint8Array, o: Partial<DataOptions> = {}) => convertData(from, to, bytes, { ...DEFAULT_DATA_OPTIONS, bom: false, ...o }, 'sample');
const json = (r: ReturnType<typeof run>, i = 0) => JSON.parse(txt(r.outputs[i].bytes));
const csvRows = (r: ReturnType<typeof run>, i = 0, d = ',') => parseCsv(txt(r.outputs[i].bytes), d as ',', 1e6).rows;
const sheet = (bytes: Uint8Array) => XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true });
const sniffBytes = (b: Uint8Array, name: string) => sniff(b.subarray(0, 65536), b.subarray(Math.max(0, b.length - 65536)), b.length, name);

describe('JSON Lines', () => {
  test('to JSON: one list item per line, CRLF and a blank line handled, big integers exact', () => {
    const r = run('jsonl', 'json', fx('data/events.jsonl'));
    const out = txt(r.outputs[0].bytes);
    expect(JSON.parse(out)).toHaveLength(3);
    expect(out).toContain('"n": 9007199254740993');
    expect(JSON.parse(out)[1].user.name).toBe('Zo\u00eb \u{1F600}');
    expect(r.warnings).toContain('1 blank line skipped.');
    expect(r.summary).toBe('A list of 3 values');
  });

  test('to CSV: dotted columns in first-seen order, formula protection, exact big integers', () => {
    const r = run('jsonl', 'csv', fx('data/events.jsonl'));
    const rows = csvRows(r);
    expect(rows[0]).toEqual(['id', 'user.name', 'user.city', 'tags', 'ok', 'n', 'note', 'extra']);
    expect(rows[1]).toEqual(['1', 'Ada', 'London', '["a","b"]', 'true', '9007199254740993', '', '']);
    expect(rows[2][6]).toBe('line\nbreak, "quoted"');
    expect(rows[3][1]).toBe("'=cmd");
    expect(r.warnings.join(' ')).toMatch(/1 cell starting with = \+ - or @ got a leading apostrophe/);
  });

  test('to XLSX: typed cells, and the big integer as text with every digit', () => {
    const ws = sheet(run('jsonl', 'xlsx', fx('data/events.jsonl')).outputs[0].bytes).Sheets.sample;
    expect(ws.A2).toMatchObject({ t: 'n', v: 1 });
    expect(ws.E2).toMatchObject({ t: 'b', v: true });
    expect(ws.F2).toMatchObject({ t: 's', v: '9007199254740993' });
  });

  test('a line that is not JSON stops the conversion and names the line; nothing is skipped', () => {
    expect(() => run('jsonl', 'json', fx('hostile/bad-line.jsonl'))).toThrow(/^Line 3 is not a complete JSON value, so nothing was converted/);
    expect(() => run('jsonl', 'csv', enc('[\n  {"a": 1}\n]\n'))).toThrow(/a JSON document spread over several lines, not JSON Lines/);
    expect(() => run('jsonl', 'json', enc('\n\n'))).toThrow(/no JSON values/);
    expect(() => run('jsonl', 'json', enc('{"a":1}\n' + '['.repeat(600) + ']'.repeat(600) + '\n'))).toThrow(/^Line 2: The data is nested 600 levels deep/);
  });

  test('from JSON, CSV and XLSX: one line per record, compact, exact', () => {
    const r = run('json', 'jsonl', enc('[{"a":12345678901234567890,"b":"x\\ny"},[1,2],"s",null]'));
    expect(txt(r.outputs[0].bytes)).toBe('{"a":12345678901234567890,"b":"x\\ny"}\n[1,2]\n"s"\nnull\n');
    expect(r.outputs[0]).toMatchObject({ ext: 'jsonl', mime: 'application/jsonl' });
    expect(txt(run('json', 'jsonl', enc('{"data":[{"a":1},{"a":2}]}')).outputs[0].bytes)).toBe('{"a":1}\n{"a":2}\n');
    const one = run('json', 'jsonl', enc('{"a":1,"b":2}'));
    expect(txt(one.outputs[0].bytes)).toBe('{"a":1,"b":2}\n');
    expect(one.warnings).toContain('The JSON is not a list, so it became a single line.');
    expect(txt(run('csv', 'jsonl', enc('id,zip\r\n1,01234\r\n2,10001\r\n')).outputs[0].bytes)).toBe('{"id":1,"zip":"01234"}\n{"id":2,"zip":10001}\n');
    const all = run('xlsx', 'jsonl', fx('data/types.xlsx'), { sheet: 'all' });
    expect(all.outputs.map(o => o.suffix)).toEqual(['Types', 'Second']);
    expect(JSON.parse(txt(all.outputs[1].bytes).split('\n')[0])).toEqual({ a: 1, b: 2 });
  });

  test('JSON Lines round trip keeps every value and type', () => {
    const values = [{ id: 1, s: 'Zo\u00eb \u{1F600}', f: 0.1, n: null, t: true, nest: { a: [1, { b: 2 }] } }, [], {}, 'text', -0.5];
    const lines = txt(run('json', 'jsonl', enc(JSON.stringify(values))).outputs[0].bytes);
    expect(json(run('jsonl', 'json', enc(lines)))).toEqual(values);
  });

  test('big integers are written exactly, and no text can pass for one', () => {
    expect(stringifyJson([10n ** 30n, '\u0000x:5', { k: -(2n ** 64n) }])).toBe('[1000000000000000000000000000000,"\\u0000x:5",{"k":-18446744073709551616}]');
  });

  test('sniffing: .jsonl and .ndjson by name, and NDJSON saved as .json by its lines', () => {
    expect(sniffBytes(fx('data/events.jsonl'), 'events.jsonl').format).toBe('jsonl');
    expect(sniffBytes(fx('data/events.jsonl'), 'events.ndjson').format).toBe('jsonl');
    expect(sniffBytes(fx('data/events.jsonl'), 'events.json')).toMatchObject({ format: 'jsonl', label: 'JSON Lines file' });
    expect(sniffBytes(enc('[\n  {"a": 1},\n  {"a": 2}\n]\n'), 'pretty.json').format).toBe('json');
    expect(sniffBytes(enc('[{"a":1},{"a":2}]'), 'min.json').format).toBe('json');
  });
});

describe('XML to tables', () => {
  test('one table per repeated element, attributes as @ columns, element text in its own column, context repeated', () => {
    const r = run('xml', 'csv', fx('data/library.xml'));
    expect(r.outputs.map(o => o.suffix)).toEqual(['book', 'magazine']);
    const book = csvRows(r, 0);
    expect(book[0]).toEqual(['id', 'lang', 'title', 'author', 'price', 'price.currency', 'isbn', 'tag', 'x:shelf', 'summary', 'owner', 'meta.updated']);
    expect(book[1]).toEqual(['b1', 'en', 'Converting Files', 'Ada', '12.50', 'USD', '0123456789', '["data","privacy"]', 'A1', '', 'Town', '2026-11-22']);
    expect(book[2]).toEqual(['b2', '', 'Privacy & You \u2713', 'Zo\u00eb', '', '', '', 'privacy', '', 'Contains <markup> that is text.', 'Town', '2026-11-22']);
    expect(book[3][2]).toBe('\'=HYPERLINK("x")');
    expect(book[3][3]).toBe('');
    expect(csvRows(r, 1)).toEqual([['id', 'title', 'issue', 'owner', 'meta.updated'], ['m1', 'Monthly', '11', 'Town', '2026-11-22'], ['m2', 'Weekly', '47', 'Town', '2026-11-22']]);
    const notes = r.warnings.join(' ');
    expect(notes).toMatch(/Each repeated element \(<book>, <magazine>\) became its own table/);
    expect(notes).toMatch(/What sits beside the records \(owner, meta\.updated\) is repeated on every row, so nothing is lost/);
    expect(notes).toMatch(/CDATA sections were merged/);
    expect(r.summary).toBe('2 tables, 5 rows');
  });

  test('repeated children as numbered columns when chosen', () => {
    const book = csvRows(run('xml', 'csv', fx('data/library.xml'), { arrays: 'columns' }), 0);
    expect(book[0]).toContain('tag.0');
    expect(book[0]).toContain('tag.1');
    expect(book[1][book[0].indexOf('tag.1')]).toBe('privacy');
  });

  test('to XLSX: a sheet per table; plain numbers become numbers, leading zeros stay text', () => {
    const wb = sheet(run('xml', 'xlsx', fx('data/library.xml')).outputs[0].bytes);
    expect(wb.SheetNames).toEqual(['book', 'magazine']);
    const ws = wb.Sheets.book;
    expect(ws.E2).toMatchObject({ t: 'n', v: 12.5 });
    expect(ws.G2).toMatchObject({ t: 's', v: '0123456789' });
    expect(ws.C4).toMatchObject({ t: 's', v: '=HYPERLINK("x")' });
    expect(ws.C4.f).toBeUndefined();
    const text = sheet(run('xml', 'xlsx', fx('data/library.xml'), { detectTypes: false }).outputs[0].bytes).Sheets.book;
    expect(text.E2).toMatchObject({ t: 's', v: '12.50' });
  });

  test('wrappers are stepped into; a single record, plain text and no repetition each give one row', () => {
    const wrapped = csvRows(run('xml', 'csv', enc('<response status="ok"><data><items><item><a>1</a></item><item><a>2</a></item></items></data></response>')));
    expect(wrapped).toEqual([['a', 'status'], ['1', 'ok'], ['2', 'ok']]);
    const single = run('xml', 'csv', enc('<catalog><book id="1"><title>T</title></book></catalog>'));
    expect(csvRows(single)).toEqual([['id', 'title'], ['1', 'T']]);
    expect(single.warnings.join(' ')).toMatch(/<book> appears once, so it became one row/);
    expect(csvRows(run('xml', 'csv', enc('<note>hello</note>')))).toEqual([['note'], ['hello']]);
    expect(csvRows(run('xml', 'csv', enc('<cfg><a>1</a><b><c>2</c></b></cfg>')))).toEqual([['a', 'b.c'], ['1', '2']]);
    expect(csvRows(run('xml', 'csv', enc('<tags><tag>x</tag><tag k="v">y</tag></tags>')))).toEqual([['tag', 'k'], ['x', ''], ['y', 'v']]);
    // An attribute named like a child element keeps its @; formula protection marks that heading in a CSV.
    expect(csvRows(run('xml', 'csv', enc('<r><i id="1"><id>x</id></i><i id="2"><id>y</id></i></r>')))).toEqual([["'@id", 'id'], ['1', 'x'], ['2', 'y']]);
  });

  test('the existing XML sample and the XML safety rules', () => {
    expect(csvRows(run('xml', 'csv', fx('data/catalog.xml')))[0].slice(0, 4)).toEqual(['id', 'lang', 'title', 'author']);
    expect(() => run('xml', 'csv', fx('hostile/xxe.xml'))).toThrow(/declares entities/);
    expect(() => run('xml', 'xlsx', fx('hostile/billion-laughs.xml'))).toThrow(/declares entities/);
    const dtd = run('xml', 'csv', fx('hostile/external-dtd.xml'));
    expect(csvRows(dtd)).toEqual([['a'], ['1'], ['2']]);
    expect(dtd.warnings).toContain('The DOCTYPE declaration was ignored; nothing it refers to is loaded.');
    expect(() => run('xml', 'csv', enc('<a>' + '<b>'.repeat(600) + '</b>'.repeat(600) + '</a>'))).toThrow(/nested 601 levels deep/);
    expect(() => run('xml', 'csv', enc('<a><b></a>'))).toThrow(/not well-formed XML/);
  });
});

describe('YAML to tables', () => {
  test('the records of the one list are the rows; the other fields are repeated; types and text kept', () => {
    const r = run('yaml', 'csv', fx('data/inventory.yaml'));
    const rows = csvRows(r);
    expect(rows[0]).toEqual(['sku', 'name', 'qty', 'price', 'unit', 'taxable', 'sizes', 'dims.w', 'dims.h', 'released', 'defaults.unit', 'defaults.taxable']);
    expect(rows[1]).toEqual(['A-001', 'Bolt', '120', '0.25', 'piece', 'true', '["M4","M5"]', '', '', '', 'piece', 'true']);
    expect(rows[2].slice(0, 4)).toEqual(['00042', 'Nut \u2713', '0', '0.1']);
    expect(rows[3].slice(0, 3)).toEqual(['B-7', "'=SUM(1)", '']);
    expect(rows[3][9]).toBe('2026-11-22');
    const notes = r.warnings.join(' ');
    expect(notes).toMatch(/The rows are the records of the "items" list/);
    expect(notes).toMatch(/The other top-level 2 fields \(defaults\.unit, defaults\.taxable\) are repeated on every row/);
  });

  test('to XLSX: numbers and true/false typed, codes with leading zeros text', () => {
    const ws = sheet(run('yaml', 'xlsx', fx('data/inventory.yaml')).outputs[0].bytes).Sheets.sample;
    expect(ws.C2).toMatchObject({ t: 'n', v: 120 });
    expect(ws.F2).toMatchObject({ t: 'b', v: true });
    expect(ws.A3).toMatchObject({ t: 's', v: '00042' });
  });

  test('several documents: one row each, or one table of all items when each is a list', () => {
    expect(csvRows(run('yaml', 'csv', enc('a: 1\n---\na: 2\n')))).toEqual([['a'], ['1'], ['2']]);
    const lists = run('yaml', 'csv', enc('- a: 1\n---\n- a: 2\n- a: 3\n'));
    expect(csvRows(lists)).toEqual([['a'], ['1'], ['2'], ['3']]);
    expect(lists.warnings.join(' ')).toMatch(/items of the 2 documents' lists are one table/);
  });

  test('unsafe tags are never resolved or run; aliases cannot explode; deep nesting is refused', () => {
    const r = run('yaml', 'json', fx('hostile/unsafe-tags.yaml'));
    expect(json(r)).toEqual([['echo owned'], 'function () { return 1 }', { a: 1 }, 'plain']);
    expect(run('yaml', 'csv', fx('hostile/unsafe-tags.yaml')).outputs).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/Unresolved tag/);
    expect(() => run('yaml', 'csv', fx('hostile/yaml-bomb.yaml'))).toThrow(/billion laughs/);
    expect(() => run('yaml', 'xlsx', fx('hostile/deep.yaml'))).toThrow(/nested/);
  });

  test('JSON follows the same table rules: several lists of records, each with the other fields', () => {
    const r = run('json', 'csv', enc(JSON.stringify({ page: 1, people: [{ n: 'a' }], orders: [{ id: 7 }, { id: 8 }] })));
    expect(r.outputs.map(o => o.suffix)).toEqual(['people', 'orders']);
    expect(csvRows(r, 1)).toEqual([['id', 'page'], ['7', '1'], ['8', '1']]);
    const wb = sheet(run('json', 'xlsx', enc(JSON.stringify({ page: 1, people: [{ n: 'a' }], orders: [{ id: 7 }] }))).outputs[0].bytes);
    expect(wb.SheetNames).toEqual(['people', 'orders']);
    // A list of plain values among other fields is a field, not a table.
    expect(csvRows(run('json', 'csv', enc('{"name":"x","tags":["a","b"]}')))).toEqual([['name', 'tags'], ['x', '["a","b"]']]);
  });
});

describe('XLS and ODS', () => {
  const expected = [
    { Text: 'Zo\u00eb \u65e5\u672c \u{1F600} \u0645\u0631\u062d\u0628\u0627', Number: 0.3, Date: '2026-11-22', DateTime: '2026-11-22T14:30:05', Time: '14:30:00', Percent: 0.25, Money: 1234.5, Flag: true, Empty: null, Formula: 0.6, Error: '#DIV/0!' },
    { Text: 'Line one\nLine two', Number: -1234.5678, Date: '1900-03-01', DateTime: '2000-02-29T23:59:59', Time: '00:00:01', Percent: 1.5, Money: -0.01, Flag: false, Empty: null, Formula: -1234.2678, Error: null },
    { Text: '01234', Number: 123456789012345, Date: '1999-12-31', DateTime: null, Time: null, Percent: null, Money: null, Flag: null, Empty: null, Formula: '01234!', Error: null },
    { Text: '=not a formula', Number: 1e21, Date: null, DateTime: null, Time: null, Percent: null, Money: null, Flag: null, Empty: null, Formula: null, Error: null },
  ];

  for (const kind of ['xls', 'ods'] as const) {
    test(`${kind.toUpperCase()} to JSON: dates, precision, formulas' results, empty cells, errors, Unicode`, () => {
      const r = run(kind, 'json', fx(`data/legacy.${kind}`));
      expect(json(r)).toEqual(expected);
      const notes = r.warnings.join(' ');
      expect(notes).toMatch(/Converted the first sheet, "Data"\. The workbook has 3 sheets/);
      expect(notes).toMatch(/1 empty row left out/);
      expect(notes).toMatch(/7 date cells became ISO 8601 text/);
    });

    test(`${kind.toUpperCase()} to CSV: as shown, with General numbers in full and formula protection`, () => {
      const rows = csvRows(run(kind, 'csv', fx(`data/legacy.${kind}`)));
      expect(rows[1].slice(0, 8)).toEqual(['Zo\u00eb \u65e5\u672c \u{1F600} \u0645\u0631\u062d\u0628\u0627', '0.3', '2026-11-22', '2026-11-22 14:30:05', '14:30:00', '25%', '1,234.50', 'TRUE']);
      // The empty fourth row is written as empty fields; the CSV reader here skips it.
      expect(rows[3].slice(0, 2)).toEqual(['01234', '123456789012345']);
      expect(rows[4].slice(0, 2)).toEqual(["'=not a formula", '1E+21']);
      const raw = csvRows(run(kind, 'csv', fx(`data/legacy.${kind}`), { values: 'raw' }));
      expect(raw[1].slice(1, 3)).toEqual(['0.3', '46348']);
    });

    test(`${kind.toUpperCase()}: every sheet, named sheets, TSV and JSON Lines`, () => {
      expect(xlsxSheetNames(fx(`data/legacy.${kind}`), kind)).toEqual(['Data', 'Second', 'Hidden']);
      const all = run(kind, 'tsv', fx(`data/legacy.${kind}`), { sheet: 'all' });
      expect(all.outputs.map(o => o.suffix)).toEqual(['Data', 'Second', 'Hidden']);
      expect(txt(all.outputs[2].bytes)).toBe('secret\t42\r\n');
      expect(json(run(kind, 'json', fx(`data/legacy.${kind}`), { sheet: { name: 'Second' } }))).toEqual([{ 'Merged heading': 1, column_2: 2, C: 3 }]);
      const lines = txt(run(kind, 'jsonl', fx(`data/legacy.${kind}`)).outputs[0].bytes).trim().split('\n');
      expect(lines).toHaveLength(4);
      expect(JSON.parse(lines[0]).Date).toBe('2026-11-22');
    });

    test(`${kind.toUpperCase()} to XLSX: sheets, values, formulas with results, number formats, merges`, async () => {
      const r = run(kind, 'xlsx', fx(`data/legacy.${kind}`));
      const wb = XLSX.read(r.outputs[0].bytes, { type: 'array', cellFormula: true, cellNF: true, cellDates: false });
      expect(wb.SheetNames).toEqual(['Data', 'Second', 'Hidden']);
      const ws = wb.Sheets.Data;
      expect(ws.A2.v).toBe('Zo\u00eb \u65e5\u672c \u{1F600} \u0645\u0631\u062d\u0628\u0627');
      expect(ws.C2).toMatchObject({ t: 'n', v: 46348 });
      expect(XLSX.SSF.is_date(ws.C2.z as string)).toBe(true);
      expect(ws.J2).toMatchObject({ f: 'B2*2', v: 0.6 });
      expect(ws.J3).toMatchObject({ f: 'SUM(B2:B3)' });
      expect(ws.H2).toMatchObject({ t: 'b', v: true });
      expect(ws.H2.f).toBeUndefined();
      expect(ws.A6).toMatchObject({ t: 's', v: '=not a formula' });
      expect(ws.A6.f).toBeUndefined();
      expect(wb.Sheets.Second['!merges']).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]);
      // Only attributes the format has: SheetJS also writes a "level" attribute that openpyxl rejects.
      const { unzipSync, strFromU8 } = await import('fflate');
      const sheetXml = strFromU8(unzipSync(r.outputs[0].bytes)['xl/worksheets/sheet1.xml']);
      expect(sheetXml).not.toMatch(/<col [^>]*level=/);
      if (kind === 'xls') expect(wb.Workbook?.Sheets?.[2]?.Hidden).toBe(1);
      const notes = r.warnings.join(' ');
      expect(notes).toMatch(/^Kept: 3 sheets, /);
      expect(notes).toMatch(/4 formulas with their saved results/);
      expect(notes).toMatch(/Not kept: fonts, colors, borders/);
      expect(notes).toMatch(/2 TRUE or FALSE values stored as the formulas/);
    });

    test(`${kind.toUpperCase()} is recognized by its contents`, () => {
      expect(sniffBytes(fx(`data/legacy.${kind}`), `renamed.bin`).format).toBe(kind);
    });
  }

  test('other OLE and OpenDocument files are named, not converted', () => {
    const xls = fx('data/legacy.xls');
    expect(sniffBytes(xls, 'legacy.doc').format).toBe('xls');
    const word = new Uint8Array(xls);
    // The XLS with its Workbook stream renamed: an Office file that is not a workbook.
    const name = [...'Workbook'].flatMap(c => [c.charCodeAt(0), 0]);
    for (let i = 0; i + name.length <= word.length; i++) if (name.every((b, j) => word[i + j] === b)) word.set([...'WordDocument'].flatMap(c => [c.charCodeAt(0), 0]), i);
    expect(sniffBytes(word, 'letter.doc')).toMatchObject({ format: null, label: 'Word 97-2003 document' });
    expect(() => run('xls', 'csv', word)).toThrow(/not an Excel workbook/);
    expect(() => run('xls', 'csv', xls.slice(0, 3000))).toThrow(/damaged|could not be read/);
    expect(() => run('ods', 'csv', fx('hostile/zip-bomb.docx'))).toThrow(/expand|ratio|larger|limit|bomb|unpack/i);
  });

  test('underlying values: a date is its serial number, never a date in the local time zone', () => {
    const raw = csvRows(run('xlsx', 'csv', fx('data/types.xlsx'), { values: 'raw' }));
    expect(raw[1].slice(2, 6)).toEqual(['46348', '46348.60422453703', '0.6041666666666666', '0.25']);
    expect(raw[1][8]).toBe('#DIV/0!');
  });

  test('as shown in Excel: General numbers are not cut to 11 characters (v0.1 wrote 1.23457E+14 and 1234.56789)', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'x'], [123456789012345, 0.1 + 0.2], [12345678901, 1234.5678901234]]), 'S');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    expect(txt(run('xlsx', 'csv', bytes).outputs[0].bytes)).toBe('id,x\r\n123456789012345,0.3\r\n12345678901,1234.5678901234\r\n');
  });

  test('General numbers keep up to 15 significant digits', () => {
    expect(generalNumber(123456789012345)).toBe('123456789012345');
    expect(generalNumber(0.1 + 0.2)).toBe('0.3');
    expect(generalNumber(-1234.5678)).toBe('-1234.5678');
    expect(generalNumber(1e21)).toBe('1E+21');
    expect(generalNumber(9007199254740993)).toBe('9.00719925474099E+15');
  });
});
