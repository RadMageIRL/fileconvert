import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import { parse as yamlParse } from 'yaml';
import { convertData, DEFAULT_DATA_OPTIONS, xmlDepth, type DataOptions } from '../../src/engines/data/convert';
import { isRiskyCell, parseCsv } from '../../src/engines/data/csv';

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const txt = (b: Uint8Array) => new TextDecoder().decode(b);
const opts = (o: Partial<DataOptions> = {}): DataOptions => ({ ...DEFAULT_DATA_OPTIONS, ...o });
const run = (from: string, to: string, bytes: Uint8Array, o: Partial<DataOptions> = {}) => convertData(from, to, bytes, opts(o), 'sample');
const enc = (s: string) => new TextEncoder().encode(s);

describe('JSON to CSV', () => {
  test('flattens nested objects into dotted columns in first-seen order, quotes per RFC 4180', () => {
    const r = run('json', 'csv', fx('data/records.json'), { bom: false });
    const csv = txt(r.outputs[0].bytes);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,name,email,active,score,tags,address.city,address.zip,note');
    expect(lines[1]).toBe('1,Ada,ada@example.com,true,9.5,"[""admin"",""ops""]",London,01234,');
    expect(csv).toContain('"Grace, ""Amazing"""');
    expect(csv).toContain('"Line one\nLine two"');
    expect(r.summary).toBe('3 rows, 9 columns');
    // Parsing the CSV back gives the same cell values.
    const back = parseCsv(csv, 'auto', 1e6).rows;
    expect(back[2][1]).toBe('Grace, "Amazing"');
    expect(back[2][8]).toBe('Line one\nLine two');
  });

  test('numbered columns for arrays when chosen, and a BOM by default', () => {
    const r = run('json', 'csv', fx('data/records.json'), { arrays: 'columns' });
    const bytes = r.outputs[0].bytes;
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const header = txt(bytes).replace(/^\ufeff/, '').split('\r\n')[0];
    expect(header).toContain('tags.0,tags.1');
  });

  test('formula-like text gets an apostrophe; numbers and plain negative numbers do not', () => {
    const json = enc(JSON.stringify([{ a: '=HYPERLINK("x")', b: -5, c: '-5', d: '@cmd', e: '+SUM(1)' }]));
    const csv = txt(run('json', 'csv', json, { bom: false }).outputs[0].bytes);
    expect(csv.split('\r\n')[1]).toBe(`"'=HYPERLINK(""x"")",-5,-5,'@cmd,'+SUM(1)`);
    const off = txt(run('json', 'csv', json, { bom: false, neutralizeFormulas: false }).outputs[0].bytes);
    expect(off.split('\r\n')[1]).toBe('"=HYPERLINK(""x"")",-5,-5,@cmd,+SUM(1)');
    expect(isRiskyCell('-5')).toBe(false);
    expect(isRiskyCell('-A1')).toBe(true);
  });

  test('keeps integers beyond 2^53 exact', () => {
    const csv = txt(run('json', 'csv', enc('[{"id":12345678901234567890}]'), { bom: false }).outputs[0].bytes);
    expect(csv).toContain('12345678901234567890');
  });

  test('a top-level object with one list uses that list', () => {
    const r = run('json', 'csv', enc('{"data":[{"a":1},{"a":2}]}'), { bom: false });
    expect(txt(r.outputs[0].bytes)).toBe('a\r\n1\r\n2\r\n');
    expect(r.warnings.join(' ')).toContain('"data"');
  });

  test('a list of lists becomes rows without a header', () => {
    const r = run('json', 'csv', enc('[[1,"a"],[2,"b,c"]]'), { bom: false });
    expect(txt(r.outputs[0].bytes)).toBe('1,a\r\n2,"b,c"\r\n');
  });

  test('refuses invalid JSON and nesting past the limit', () => {
    expect(() => run('json', 'csv', enc('{"a":'))).toThrow(/not valid JSON/);
    expect(() => run('json', 'csv', fx('hostile/deep.json'))).toThrow(/nested 5000 levels deep/);
  });
});

describe('CSV to JSON', () => {
  test('header row, quoted fields with commas, quotes and line breaks, BOM ignored', () => {
    const r = run('csv', 'json', fx('data/people.csv'));
    const out = JSON.parse(txt(r.outputs[0].bytes));
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: 1, name: 'Ada Lovelace', email: 'ada@example.com', amount: 1200.5, joined: '2024-01-15', zip: '01234', comment: 'Says "hello", often' });
    expect(out[1].comment).toBe('Multi\r\nline');
    expect(out[1].amount).toBe(-35);
    expect(out[2].name).toBe('Linus \u00e9\u00e8');
  });

  test('type detection off keeps every value as text', () => {
    const out = JSON.parse(txt(run('csv', 'json', fx('data/people.csv'), { detectTypes: false }).outputs[0].bytes));
    expect(out[0].id).toBe('1');
    expect(out[0].amount).toBe('1200.50');
  });

  test('semicolon files are detected and decimal commas stay text', () => {
    const r = run('csv', 'json', fx('data/semicolon.csv'));
    expect(JSON.parse(txt(r.outputs[0].bytes))).toEqual([{ a: 1, b: '2,5', c: 'x' }, { a: 4, b: '5,25', c: 'y' }]);
    expect(r.warnings.join(' ')).toContain('semicolons');
  });

  test('round trip: JSON to CSV to JSON with nesting rebuilt', () => {
    const src = [{ id: 1, name: 'A', address: { city: 'X', zip: '01234' } }, { id: 2, name: 'B', address: { city: 'Y', zip: '02134' } }];
    const csv = run('json', 'csv', enc(JSON.stringify(src)), { bom: false }).outputs[0].bytes;
    const back = JSON.parse(txt(run('csv', 'json', csv, { nest: true }).outputs[0].bytes));
    expect(back).toEqual(src);
  });

  test('duplicate and empty headers get names, ragged rows are reported', () => {
    const r = run('csv', 'json', enc('a,a,\n1,2,3,4\n5\n'));
    const out = JSON.parse(txt(r.outputs[0].bytes));
    expect(Object.keys(out[0])).toEqual(['a', 'a_2', 'column_3', 'column_4']);
    expect(out[1]).toEqual({ a: 5, a_2: null, column_3: null });
    expect(r.warnings.join(' ')).toMatch(/2 rows had a different number of fields/);
  });

  test('an empty file is an error', () => {
    expect(() => run('csv', 'json', fx('hostile/empty.csv'))).toThrow(/empty/);
  });

  test('Windows-1252 input is decoded and the guess is reported', () => {
    const bytes = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const r = run('csv', 'json', bytes);
    expect(JSON.parse(txt(r.outputs[0].bytes))).toEqual([{ name: 'caf\u00e9' }]);
    expect(r.warnings.join(' ')).toContain('Windows-1252');
  });
});

describe('CSV and XLSX', () => {
  test('CSV to XLSX: numbers typed with their decimals kept, leading zeros and dates stay text, no formulas', () => {
    const r = run('csv', 'xlsx', fx('data/people.csv'));
    const wb = XLSX.read(r.outputs[0].bytes, { type: 'array', cellFormula: true, cellNF: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    expect(wb.SheetNames[0]).toBe('sample');
    expect(ws.A1.v).toBe('id');
    expect(ws.D2).toMatchObject({ t: 'n', v: 1200.5, z: '0.00' });
    expect(ws.F2).toMatchObject({ t: 's', v: '01234' });
    expect(ws.E2).toMatchObject({ t: 's', v: '2024-01-15' });
    const f = run('csv', 'xlsx', fx('hostile/formulas.csv'));
    const fws = XLSX.read(f.outputs[0].bytes, { type: 'array', cellFormula: true }).Sheets.sample;
    expect(fws.A2.t).toBe('s');
    expect(fws.A2.f).toBeUndefined();
    expect(fws.A2.v).toBe('=HYPERLINK("https://example.com","click")');
  });

  test('round trip: CSV to XLSX to CSV gives the same cells', () => {
    const csv1 = fx('data/people.csv');
    const xlsx = run('csv', 'xlsx', csv1).outputs[0].bytes;
    const csv2 = txt(run('xlsx', 'csv', xlsx, { bom: false }).outputs[0].bytes);
    // Excel keeps line breaks inside a cell as LF, so a CRLF inside a field comes back as LF.
    const a = parseCsv(txt(csv1), 'auto', 1e6).rows.map(r => r.map(c => c.replace(/\r\n/g, '\n')));
    const b = parseCsv(csv2, 'auto', 1e6).rows;
    expect(b).toEqual(a);
  });

  test('XLSX to CSV: first sheet by default with a note, all sheets on request, dates as displayed', () => {
    const r = run('xlsx', 'csv', fx('data/workbook.xlsx'), { bom: false });
    expect(r.outputs).toHaveLength(1);
    const lines = txt(r.outputs[0].bytes).split('\r\n');
    expect(lines[0]).toBe('Name,Joined,Amount,Zip,Active');
    expect(lines[1]).toBe('Ada,2024-01-15,1200.5,01234,TRUE');
    expect(lines[3]).toBe('"Comma, ""quoted""",2022-07-04,0,97201,TRUE');
    expect(r.warnings.join(' ')).toMatch(/2 sheets/);
    const all = run('xlsx', 'csv', fx('data/workbook.xlsx'), { sheet: 'all', bom: false });
    expect(all.outputs.map(o => o.suffix)).toEqual(['People', 'Totals']);
    expect(txt(all.outputs[1].bytes)).toBe("Metric,Value\r\nCount,3\r\nNote,'=1+1 is text here\r\nDoubled,\r\n");
    expect(all.warnings.join(' ')).toMatch(/1 formula cell in "Totals" has no saved result/);
    const named = run('xlsx', 'csv', fx('data/workbook.xlsx'), { sheet: { name: 'Totals' }, bom: false });
    expect(named.outputs).toHaveLength(1);
    expect(txt(named.outputs[0].bytes)).toContain('Count,3');
  });

  test('refuses a zip bomb before unpacking it', () => {
    expect(() => run('xlsx', 'csv', fx('hostile/zip-bomb.docx'))).toThrow(/would unpack to|decompression bomb/);
  });
});

describe('YAML', () => {
  test('YAML to JSON with anchors and merge keys; dates stay strings', () => {
    const out = JSON.parse(txt(run('yaml', 'json', fx('data/config.yaml')).outputs[0].bytes));
    expect(out.services[0]).toEqual({ name: 'web', retries: 3, timeout: 2.5, ports: [80, 443], enabled: true });
    expect(out.services[1].note).toBe('Multi-line\nliteral text\n');
    expect(out.released).toBe('2026-11-15');
    expect(out.empty).toBeNull();
  });

  test('round trip: JSON to YAML to JSON is identical, ambiguous strings are quoted', () => {
    const src = { a: 'yes', b: 'no', d: '2026-11-15', t: '1:20', z: '01234', n: null, list: [1, 'two', { three: 3 }], big: 12345678901234567890n };
    const json = enc(JSON.stringify(src, (_k, v) => typeof v === 'bigint' ? '__BIG__' : v).replace('"__BIG__"', '12345678901234567890'));
    const yaml = txt(run('json', 'yaml', json).outputs[0].bytes);
    expect(yaml).toContain('a: "yes"');
    expect(yaml).toContain('d: "2026-11-15"');
    expect(yaml).toContain('big: 12345678901234567890');
    expect(yamlParse(yaml, { version: '1.1' }).a).toBe('yes');
    const back = txt(run('yaml', 'json', enc(yaml.replace('12345678901234567890', '1'))).outputs[0].bytes);
    expect(JSON.parse(back)).toEqual({ ...src, big: 1 });
  });

  test('refuses an alias bomb and reports syntax errors with a line', () => {
    expect(() => run('yaml', 'json', fx('hostile/yaml-bomb.yaml'))).toThrow(/billion laughs/);
    expect(() => run('yaml', 'json', enc('a: [1, 2\nb: 3\n'))).toThrow(/not valid YAML/);
  });

  test('several documents become a list; .inf becomes null with a warning', () => {
    const r = run('yaml', 'json', enc('a: 1\n---\na: .inf\n'));
    expect(JSON.parse(txt(r.outputs[0].bytes))).toEqual([{ a: 1 }, { a: null }]);
    expect(r.warnings.join(' ')).toMatch(/2 YAML documents/);
    expect(r.warnings.join(' ')).toMatch(/\.inf or \.nan/);
  });
});

describe('XML', () => {
  test('XML to JSON: attributes, repeated elements, CDATA, entities and numeric references', () => {
    const out = JSON.parse(txt(run('xml', 'json', fx('data/catalog.xml')).outputs[0].bytes));
    const books = out.catalog.book;
    expect(books).toHaveLength(2);
    expect(books[0]['@id']).toBe('b1');
    expect(books[0].price).toEqual({ '@currency': 'USD', '#text': '12.50' });
    expect(books[0]['x:tag']).toBe('one');
    expect(books[1].title).toBe('Privacy & You');
    expect(books[1].summary).toBe('Contains <markup> that is text.');
    const r = JSON.parse(txt(run('xml', 'json', enc('<a t="&amp;#233;">caf&#233; &#x2713; &amp;lt;</a>')).outputs[0].bytes));
    expect(r.a).toEqual({ '@t': '&#233;', '#text': 'caf\u00e9 \u2713 &lt;' });
  });

  test('refuses external entities and entity expansion before parsing', () => {
    expect(() => run('xml', 'json', fx('hostile/xxe.xml'))).toThrow(/declares entities/);
    expect(() => run('xml', 'json', fx('hostile/billion-laughs.xml'))).toThrow(/declares entities/);
  });

  test('malformed XML reports the line and column', () => {
    expect(() => run('xml', 'json', enc('<a>\n<b></a>'))).toThrow(/line 2/);
  });

  test('depth is measured without recursion and limited', () => {
    expect(xmlDepth('<a><b x=">"><c/></b><!-- <x><y> --><![CDATA[<z>]]></a>')).toBe(3);
    const deep = '<a>'.repeat(600) + '</a>'.repeat(600);
    expect(() => run('xml', 'json', enc(deep))).toThrow(/600 levels/);
  });

  test('JSON to XML: one root key, attributes, escaping, invalid names renamed, control characters removed', () => {
    const r = run('json', 'xml', enc(JSON.stringify({ order: { '@id': 'a"<&', item: [{ name: 'x < y & z' }, { name: 'two' }], 'first name': 'Ada', '1st': true, bad: 'a\u0001b', empty: null } })));
    const xml = txt(r.outputs[0].bytes);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<order id="a&quot;&lt;&amp;">')).toBe(true);
    expect(xml).toContain('<name>x &lt; y &amp; z</name>');
    expect(xml).toContain('<first_name>Ada</first_name>');
    expect(xml).toContain('<_1st>true</_1st>');
    expect(xml).toContain('<bad>ab</bad>');
    expect(xml).toContain('<empty/>');
    expect(r.warnings.join(' ')).toMatch(/Renamed 2 keys/);
    expect(r.warnings.join(' ')).toMatch(/Removed 1 character/);
  });

  test('round trip: XML to JSON to XML keeps the structure', () => {
    const json = run('xml', 'json', fx('data/catalog.xml')).outputs[0].bytes;
    const xml2 = run('json', 'xml', json).outputs[0].bytes;
    const again = JSON.parse(txt(run('xml', 'json', xml2).outputs[0].bytes));
    expect(again).toEqual(JSON.parse(txt(json)));
  });

  test('a top-level list is wrapped in root and item elements', () => {
    const xml = txt(run('json', 'xml', enc('[1,2]')).outputs[0].bytes);
    expect(xml).toContain('<root>\n  <item>1</item>\n  <item>2</item>\n</root>');
  });
});

describe('large inputs', () => {
  test('hundreds of thousands of rows do not overflow the stack', () => {
    const lines = ['a,b'];
    for (let i = 0; i < 300_000; i++) lines.push(`${i},x`);
    const csv = enc(lines.join('\n'));
    expect(run('csv', 'xlsx', csv).summary).toBe('300,001 rows, 2 columns');
    const json = enc(JSON.stringify(Array.from({ length: 300_000 }, (_, i) => [i, 'x'])));
    expect(run('json', 'csv', json).summary).toBe('300,000 rows, 2 columns');
  });
});

describe('boundaries', () => {
  test('nesting just under the limit converts; just over it is refused', () => {
    const nest = (n: number) => '['.repeat(n) + ']'.repeat(n);
    expect(run('json', 'yaml', enc(nest(500))).outputs).toHaveLength(1);
    expect(() => run('json', 'yaml', enc(nest(501)))).toThrow(/nested 501 levels deep; the limit is 500/);
    const xml = (n: number) => '<a>'.repeat(n) + '</a>'.repeat(n);
    expect(run('xml', 'json', enc(xml(500))).outputs).toHaveLength(1);
    expect(() => run('xml', 'json', enc(xml(501)))).toThrow(/501 levels deep; the limit is 500/);
  });

  test('15 significant digits become a number, 16 stay text', () => {
    const out = JSON.parse(txt(run('csv', 'json', enc('a,b,c\n123456789012345,1234567890123456,0.12345678901234\n')).outputs[0].bytes));
    expect(out[0]).toEqual({ a: 123456789012345, b: '1234567890123456', c: 0.12345678901234 });
  });

  test('true and false in any of the usual cases become booleans, other words do not', () => {
    const out = JSON.parse(txt(run('csv', 'json', enc('a,b,c,d\ntrue,FALSE,True,yes\n')).outputs[0].bytes));
    expect(out[0]).toEqual({ a: true, b: false, c: true, d: 'yes' });
  });
});

describe('mutation-found gaps', () => {
  test('brackets inside JSON strings are not nesting, and nesting after a string still counts', () => {
    const inString = JSON.stringify([{ text: '['.repeat(600) }]);
    expect(run('json', 'yaml', enc(inString)).outputs).toHaveLength(1);
    const after = '["a \\" [ quoted", ' + '['.repeat(600) + ']'.repeat(600) + ']';
    expect(() => run('json', 'yaml', enc(after))).toThrow(/nested 601 levels deep/);
  });

  test('upper-case TRUE is a boolean', () => {
    expect(JSON.parse(txt(run('csv', 'json', enc('a\nTRUE\n')).outputs[0].bytes))).toEqual([{ a: true }]);
  });

  test('CSV to XLSX stores line breaks as Excel does, with no carriage-return escapes', async () => {
    const { unzipSync } = await import('fflate');
    const xlsx = run('csv', 'xlsx', enc('a\r\n"one\r\ntwo"\r\n')).outputs[0].bytes;
    const files = unzipSync(xlsx);
    const xml = Object.entries(files).filter(([n]) => /^xl\/(worksheets|sharedStrings)/.test(n)).map(([, b]) => txt(b)).join('');
    expect(xml).toContain('one\ntwo');
    expect(xml.toLowerCase()).not.toContain('_x000d_');
  });
});
