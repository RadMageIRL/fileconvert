import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import { convertData, DEFAULT_DATA_OPTIONS, type DataOptions } from '../../src/engines/data/convert';
import { parseCsv } from '../../src/engines/data/csv';

// How JSON, JSON Lines and YAML become tables (v0.2.0, after the Phase 1B review): one row per record of a clear
// list of records, with the fields around it repeated; several lists are never combined into one table (no
// Cartesian products); lists inside the rows are never expanded into more rows; every choice the shape leaves open is
// named in the notes; and no field or value of the source is ever left out without a note saying so.

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const txt = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const run = (from: string, to: string, bytes: Uint8Array, o: Partial<DataOptions> = {}) => convertData(from, to, bytes, { ...DEFAULT_DATA_OPTIONS, bom: false, ...o }, 'sample');
const csvRows = (r: ReturnType<typeof run>, i = 0) => parseCsv(txt(r.outputs[i].bytes), ',', 1e6).rows;
const csvOf = (src: unknown, o: Partial<DataOptions> = {}) => run('json', 'csv', enc(JSON.stringify(src)), o);
const notes = (r: ReturnType<typeof run>) => r.warnings.join(' | ');
const ORDERS = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'data', 'orders.json'), 'utf8'));

/** Every scalar in a JSON value, as the text a CSV cell would hold, and every key name. */
function inventory(v: unknown, values: string[] = [], keys: string[] = []): { values: string[]; keys: string[] } {
  if (v === null) return { values, keys };
  if (Array.isArray(v)) v.forEach(x => inventory(x, values, keys));
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v as object)) { keys.push(k); inventory(x, values, keys); }
  else values.push(String(v));
  return { values, keys };
}

/** What a set of CSV results holds: every cell, plus the scalars and keys inside cells that are JSON text. */
function held(r: ReturnType<typeof run>): { values: Set<string>; keys: Set<string> } {
  const values = new Set<string>(), keys = new Set<string>();
  r.outputs.forEach((o, i) => {
    // A table made from a named list is named after it (the file name or the sheet).
    if (o.suffix) keys.add(o.suffix);
    const [header, ...rows] = csvRows(r, i);
    for (const h of header) { keys.add(h); for (const part of h.replace(/_\d+$/, '').split('.')) keys.add(part); }
    for (const row of rows) for (const c of row) {
      const cell = c.replace(/^'(?=[=+\-@])/, '');
      values.add(cell);
      if (/^[[{]/.test(cell)) { const inner = inventory(JSON.parse(cell)); inner.values.forEach(x => values.add(x)); inner.keys.forEach(x => keys.add(x)); }
    }
  });
  return { values, keys };
}

describe('table rules: records with the fields around them', () => {
  test('one row per record; the scalar fields around the list are repeated on every row, exactly', () => {
    const r = csvOf({ batch: 'B-7', count: 2, ok: true, rows: [{ id: 1 }, { id: 2 }] });
    expect(csvRows(r)).toEqual([['id', 'batch', 'count', 'ok'], ['1', 'B-7', '2', 'true'], ['2', 'B-7', '2', 'true']]);
    expect(notes(r)).toMatch(/The rows are the records of the "rows" list\. \| The 3 other top-level fields \(batch, count, ok\) are repeated on every row/);
    const ws = XLSX.read(run('json', 'xlsx', enc(JSON.stringify({ batch: 'B-7', count: 2, ok: true, rows: [{ id: 1 }] }))).outputs[0].bytes, { type: 'array' }).Sheets.sample;
    expect([ws.B2, ws.C2, ws.D2].map(c => [c.t, c.v])).toEqual([['s', 'B-7'], ['n', 2], ['b', true]]);
  });

  test('several lists of records: one table each, never combined, so the rows add up instead of multiplying', () => {
    const r = run('json', 'csv', fx('data/orders.json'));
    expect(r.outputs.map(o => o.suffix)).toEqual(['orders', 'refunds']);
    expect(csvRows(r, 0)).toHaveLength(1 + 3);
    expect(csvRows(r, 1)).toHaveLength(1 + 2);
    expect(r.summary).toBe('2 tables, 5 rows');
    expect(notes(r)).toMatch(/Each list of records \("orders" and "refunds"\) became its own file\. Their rows are not combined with each other/);
    const wb = XLSX.read(run('json', 'xlsx', fx('data/orders.json')).outputs[0].bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['orders', 'refunds']);
    expect(XLSX.utils.sheet_to_json(wb.Sheets.refunds)).toHaveLength(2);
  });

  test('the orders fixture, column by column: nested fields dotted, clashes renamed, empty values written', () => {
    const r = run('json', 'csv', fx('data/orders.json'));
    const [head, first, second, third] = csvRows(r, 0);
    expect(head).toEqual(['id', 'customer.name', 'customer.city', 'total', 'lines', 'note', 'gift', 'customer', 'store',
      'store_2', 'exported', 'currency', 'meta.version', 'meta.source', 'meta.tags', 'a.b', 'a.b_2', 'mixed']);
    const context = ['Northwind', '2026-11-22', 'EUR', '2', '', '[]', 'a key with a dot', 'a nested field', '[{"x":1},"loose",3]'];
    expect(first).toEqual(['1', 'Ada', 'London', '12.5', '[{"sku":"A-1","qty":2},{"sku":"B-2","qty":1}]', '', '', '', '', ...context]);
    expect(second).toEqual(['2', ORDERS.orders[1].customer.name, ORDERS.orders[1].customer.city, '0', '[]', "'=cmd", 'true', '', '', ...context]);
    expect(third).toEqual(['3', '', '', '7', '[{"sku":"C-3","qty":5}]', '', '', '{}', 'Outlet', ...context]);
    expect(csvRows(r, 1)[0]).toEqual(['order', 'amount', 'reason', 'store', 'exported', 'currency', 'meta.version', 'meta.source', 'meta.tags', 'a.b', 'a.b_2', 'mixed']);
    const n = notes(r);
    expect(n).toMatch(/Two fields gave the same column name \("a\.b"\)[^|]*the later one got a _2 suffix, so both values are kept/);
    expect(n).toMatch(/"mixed" mixes records with other values, so it was not used as rows; it is kept whole as JSON text in one cell/);
    expect(n).toMatch(/"lines" holds a list of records inside the rows\. Rows come only from the top level, so it was not expanded into more rows/);
    expect(n).toMatch(/The 9 other top-level fields \(store, exported, currency, meta\.version, \.\.\.\) are repeated on every row/);
  });

  test('with lists as numbered columns, inner records spread across columns, still one row per record', () => {
    const r = run('json', 'csv', fx('data/orders.json'), { arrays: 'columns' });
    const [head, first, second] = csvRows(r, 0);
    for (const c of ['lines.0.sku', 'lines.0.qty', 'lines.1.sku', 'lines.1.qty', 'mixed.0.x', 'mixed.1', 'mixed.2']) expect(head).toContain(c);
    expect(first[head.indexOf('lines.1.sku')]).toBe('B-2');
    expect(second[head.indexOf('lines')]).toBe('[]');
    expect(first[head.indexOf('mixed.1')]).toBe('loose');
    expect(csvRows(r, 0)).toHaveLength(4);
    expect(notes(r)).toMatch(/"lines" holds a list of records inside the rows[^|]*it is kept as numbered columns/);
  });

  test('a list of records nested inside the object is explained, not guessed at', () => {
    const r = csvOf({ meta: { v: 1 }, data: { rows: [{ a: 1 }, { a: 2 }] } });
    expect(csvRows(r)).toEqual([['meta.v', 'data.rows'], ['1', '[{"a":1},{"a":2}]']]);
    expect(notes(r)).toMatch(/The top level is a single object, so it became one row\. .*"data\.rows" holds a list of records inside the rows\. Rows come only from the top level/);
  });

  test('a top-level list that mixes records with other values is explained', () => {
    const r = csvOf([{ a: 1 }, 'x', [1, 2]]);
    expect(csvRows(r)).toEqual([['a', 'value', '0', '1'], ['1', '', '', ''], ['', 'x', '', ''], ['', '', '1', '2']]);
    expect(notes(r)).toMatch(/The list mixes 1 record, 1 single value and 1 list: records give their fields as columns, single values are in the "value" column and inner lists are numbered columns/);
  });
});

describe('table rules: empty structures and null', () => {
  test('an empty list or object gives an empty file with a note, never stray blank lines', () => {
    for (const [src, note] of [
      [[], 'The list is empty, so the table has no rows.'],
      [{}, 'The file holds an empty object, so the table is empty.'],
      [[{}, {}], 'The 2 records have no fields, so the table is empty.'],
      [{ rows: [] }, 'The only field, "rows", is an empty list, so the table has no rows.'],
    ] as const) {
      const r = csvOf(src);
      expect(r.outputs).toHaveLength(1);
      expect(r.outputs[0].bytes).toHaveLength(0);
      expect(r.warnings).toContain(note);
    }
    const ws = XLSX.read(run('json', 'xlsx', enc('[]')).outputs[0].bytes, { type: 'array' }).Sheets.sample;
    expect(XLSX.utils.sheet_to_json(ws, { header: 1 })).toEqual([]);
  });

  test('an empty list among lists keeps its own empty file or sheet, named in the notes', () => {
    const r = csvOf({ people: [{ a: 1 }], pets: [] });
    expect(r.outputs.map(o => [o.suffix, txt(o.bytes)])).toEqual([['people', 'a\r\n1\r\n'], ['pets', '']]);
    expect(r.warnings).toContain('"pets" is an empty list, so its file has no rows.');
  });

  test('an empty list beside other fields is a field written as []; the object stays one row', () => {
    const r = csvOf({ name: 'x', items: [] });
    expect(csvRows(r)).toEqual([['name', 'items'], ['x', '[]']]);
    expect(notes(r)).toMatch(/"items" is an empty list, so there are no records to make rows from; it is written as \[\]/);
  });

  test('null and a missing field are empty cells; [] and {} are written as text in both list settings', () => {
    for (const arrays of ['json', 'columns'] as const) {
      const r = csvOf({ n: null, rows: [{ a: null, l: [], o: {} }, { b: 1 }] }, { arrays });
      expect(csvRows(r)).toEqual([['a', 'l', 'o', 'b', 'n'], ['', '[]', '{}', '', ''], ['', '', '', '1', '']]);
    }
    const ws = XLSX.read(run('json', 'xlsx', enc('[{"a":null,"l":[],"o":{}}]')).outputs[0].bytes, { type: 'array' }).Sheets.sample;
    expect(ws.A2).toBeUndefined();
    expect([ws.B2.v, ws.C2.v]).toEqual(['[]', '{}']);
  });

  test('a single value, null included, is one row with one column', () => {
    expect(csvRows(csvOf(42))).toEqual([['value'], ['42']]);
    const r = csvOf(null);
    expect(txt(r.outputs[0].bytes)).toBe('value\r\n\r\n');
    expect(r.warnings).toContain('The file holds a single null, not a list or an object, so it became one row with one column.');
  });
});

describe('table rules: nothing is left out', () => {
  test('a key with a dot never overwrites the nested field of the same dotted name, in either order', () => {
    expect(csvRows(csvOf({ 'a.b': 1, a: { b: 2 } }))).toEqual([['a.b', 'a.b_2'], ['1', '2']]);
    expect(csvRows(csvOf({ a: { b: 2 }, 'a.b': 1 }))).toEqual([['a.b', 'a.b_2'], ['2', '1']]);
    expect(csvRows(csvOf([{ 'tags.0': 'x', tags: ['y'] }], { arrays: 'columns' }))).toEqual([['tags.0', 'tags.0_2'], ['x', 'y']]);
  });

  test('a repeated JSON key is named: the last value is used, as every JSON reader does', () => {
    const r = run('json', 'csv', enc('{"a":1,"b":{"c":1,"c":2},"a":3}'));
    expect(csvRows(r)).toEqual([['a', 'b.c'], ['3', '2']]);
    expect(r.warnings[0]).toBe('2 repeated keys in the same object (first: "c"): JSON keeps one value per key, so, as every JSON reader does, the last value was used and the earlier ones were not converted.');
    // The same key written with an escape is the same key.
    const escaped = '{"a":1,"' + String.fromCharCode(92) + 'u0061":2}';
    expect(run('json', 'jsonl', enc(escaped)).warnings[0]).toMatch(/^1 repeated key in the same object \(first: "a"\)/);
    // A key inside a string, or the same key in two different objects, is not a repeat.
    expect(run('json', 'csv', enc('[{"a":"{\\"a\\":1,\\"a\\":2}"},{"a":2}]')).warnings.join(' ')).not.toMatch(/repeated key/);
  });

  test('JSON Lines names repeated keys once, with the number of lines', () => {
    const r = run('jsonl', 'csv', enc('{"a":1,"a":2}\n{"b":1}\n{"b":1,"b":2,"b":3}\n'));
    expect(r.warnings).toContain('3 repeated keys in the same object on 2 lines (first: "a"): JSON keeps one value per key, so, as every JSON reader does, the last value was used and the earlier ones were not converted.');
  });

  test('every value and every field name of the orders fixture is in the CSV results, in both list settings', () => {
    const src = inventory(ORDERS);
    for (const arrays of ['json', 'columns'] as const) {
      const out = held(run('json', 'csv', fx('data/orders.json'), { arrays }));
      expect(src.values.filter(v => !out.values.has(v))).toEqual([]);
      expect([...new Set(src.keys)].filter(k => !out.keys.has(k))).toEqual([]);
    }
  });

  test('YAML follows the same rules: the YAML copy of the fixture gives the same tables', () => {
    for (const arrays of ['json', 'columns'] as const) {
      const fromJson = run('json', 'csv', fx('data/orders.json'), { arrays });
      const fromYaml = run('yaml', 'csv', fx('data/orders.yaml'), { arrays });
      expect(fromYaml.outputs.map(o => [o.suffix, txt(o.bytes)])).toEqual(fromJson.outputs.map(o => [o.suffix, txt(o.bytes)]));
    }
  });
});
