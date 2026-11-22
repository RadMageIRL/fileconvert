import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addFiles, convert, convertAllTo, download, downloadZip, expectDone, fx, openApp, pyRead, row, tempDir, unexpectedViolations, writeTemp } from './helpers';

// Phase 1B data pairs in the browser (v0.2.0): JSON Lines, XML and YAML to tables, XLS and ODS. Every result is read
// by Python's csv, json and openpyxl (tests/e2e/readers.py), not by FileConvert's own code.

type Sheet = { name: string; state: string; merged: string[]; rows: unknown[][]; cells: Record<string, { type: string; format: string; formula?: string }> };

test('JSON Lines to JSON, CSV, TSV and XLSX', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('data/events.jsonl')]);
  await expect(row(page, 'events.jsonl').locator('.job-info')).toContainText('JSON Lines');
  await convert(page, 'events.jsonl', 'JSON');
  await expectDone(page, 'events.jsonl');
  const jsonPath = (await download(page, 'events.jsonl', info)).path;
  // Python keeps the 2^53 + 1 integer exact; it is checked in the text.
  expect(readFileSync(jsonPath, 'utf8')).toContain('"n": 9007199254740993');
  const values = pyRead<Array<Record<string, unknown>>>('json', jsonPath);
  expect(values).toHaveLength(3);
  expect(values[1]).toMatchObject({ id: 2, user: { name: 'Zo\u00eb \u{1F600}', city: '\u6771\u4eac' }, tags: [], ok: false });
  for (const [label, kind] of [['CSV', 'csv'], ['TSV', 'tsv']] as const) {
    await convert(page, 'events.jsonl', label);
    const rows = pyRead<string[][]>(kind, (await download(page, 'events.jsonl', info)).path);
    expect(rows[0]).toEqual(['id', 'user.name', 'user.city', 'tags', 'ok', 'n', 'note', 'extra']);
    expect(rows[1]).toEqual(['1', 'Ada', 'London', '["a","b"]', 'true', '9007199254740993', '', '']);
    expect(rows[2][6]).toBe('line\nbreak, "quoted"');
    expect(rows[3][1]).toBe("'=cmd");
  }
  await convert(page, 'events.jsonl', 'XLSX');
  const [s] = pyRead<Sheet[]>('xlsx', (await download(page, 'events.jsonl', info)).path);
  expect(s.rows[1]).toEqual([1, 'Ada', 'London', '["a","b"]', true, '9007199254740993', null, null]);
  expect(s.rows[3][1]).toBe('=cmd');
  expect(s.cells.B4.type).toBe('s');
  expect(w.outside).toEqual([]);
});

test('JSON, CSV, TSV and XLSX to JSON Lines', async ({ page }, info) => {
  await openApp(page);
  const tsv = { name: 'people.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('id\tname\r\n7\tZo\u00eb\r\n8\t=x\r\n') };
  await addFiles(page, [fx('data/records.json'), fx('data/people.csv'), tsv, fx('data/types.xlsx')]);
  await convertAllTo(page, 'JSON Lines');
  for (const f of ['records.json', 'people.csv', 'people.tsv', 'types.xlsx']) await expectDone(page, f);
  const zip = await downloadZip(page, info);
  expect(Object.keys(zip.entries).sort()).toEqual(['people (2).jsonl', 'people.jsonl', 'records.jsonl', 'types.jsonl']);
  const dir = tempDir();
  const read = (n: string) => pyRead<Array<Record<string, unknown>>>('jsonl', writeTemp(dir, n, zip.entries[n]));
  const records = read('records.jsonl');
  expect(records).toEqual(JSON.parse(readFileSync(fx('data/records.json'), 'utf8')));
  const people = read('people.jsonl');
  expect(people[0]).toEqual({ id: 1, name: 'Ada Lovelace', email: 'ada@example.com', amount: 1200.5, joined: '2024-01-15', zip: '01234', comment: 'Says "hello", often' });
  expect(read('people (2).jsonl')).toEqual([{ id: 7, name: 'Zo\u00eb' }, { id: 8, name: '=x' }]);
  const types = read('types.jsonl');
  expect(types[0]).toMatchObject({ Date: '2026-11-22', Flag: true, Empty: null, Percent: 0.25 });
});

test('YAML and XML to CSV, TSV and XLSX, with what sits beside the records repeated', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('data/inventory.yaml'), fx('data/library.xml')]);
  for (const [label, kind] of [['CSV', 'csv'], ['TSV', 'tsv']] as const) {
    await convert(page, 'inventory.yaml', label);
    await expectDone(page, 'inventory.yaml');
    const inv = pyRead<string[][]>(kind, (await download(page, 'inventory.yaml', info)).path);
    expect(inv[0]).toEqual(['sku', 'name', 'qty', 'price', 'unit', 'taxable', 'sizes', 'dims.w', 'dims.h', 'released', 'defaults.unit', 'defaults.taxable']);
    expect(inv[2].slice(0, 2)).toEqual(['00042', 'Nut \u2713']);
    expect(inv[3][1]).toBe("'=SUM(1)");
    await convert(page, 'library.xml', label);
    await expectDone(page, 'library.xml');
    await expect(row(page, 'library.xml').locator('.outputs button')).toHaveCount(2);
    const book = await download(page, 'library.xml', info, 0);
    const magazine = await download(page, 'library.xml', info, 1);
    expect([book.filename, magazine.filename]).toEqual([`library - book.${kind}`, `library - magazine.${kind}`]);
    const b = pyRead<string[][]>(kind, book.path);
    expect(b[0]).toEqual(['id', 'lang', 'title', 'author', 'price', 'price.currency', 'isbn', 'tag', 'x:shelf', 'summary', 'owner', 'meta.updated']);
    expect(b[2][2]).toBe('Privacy & You \u2713');
    expect(pyRead<string[][]>(kind, magazine.path)[2]).toEqual(['m2', 'Weekly', '47', 'Town', '2026-11-22']);
    await expect(row(page, 'library.xml').locator('.job-notes')).toContainText('repeated on every row');
  }
  await convert(page, 'inventory.yaml', 'XLSX');
  const [inv] = pyRead<Sheet[]>('xlsx', (await download(page, 'inventory.yaml', info)).path);
  expect(inv.rows[1].slice(0, 6)).toEqual(['A-001', 'Bolt', 120, 0.25, 'piece', true]);
  expect(inv.rows[2][0]).toBe('00042');
  await convert(page, 'library.xml', 'XLSX');
  const lib = pyRead<Sheet[]>('xlsx', (await download(page, 'library.xml', info)).path);
  expect(lib.map(s => s.name)).toEqual(['book', 'magazine']);
  expect(lib[0].rows[1].slice(4, 7)).toEqual([12.5, 'USD', '0123456789']);
  expect(lib[0].rows[3][2]).toBe('=HYPERLINK("x")');
  expect(lib[0].cells.C4.type).toBe('s');
  expect(w.outside).toEqual([]);
});

test('XLS and ODS to XLSX, CSV, TSV, JSON and JSON Lines', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await addFiles(page, [fx('data/legacy.xls'), fx('data/legacy.ods')]);
  await expect(row(page, 'legacy.xls').locator('.job-info')).toContainText('3 sheets');
  await expect(row(page, 'legacy.ods').locator('.job-info')).toContainText('3 sheets');
  // XLSX is offered first, and converts the whole workbook, so there is no sheet to choose.
  await expect(row(page, 'legacy.xls').getByRole('combobox', { name: /^Convert .* to$/ })).toHaveValue('xlsx');
  await expect(row(page, 'legacy.xls').getByRole('combobox', { name: /Worksheet/ })).toHaveCount(0);
  await convertAllTo(page, 'XLSX');
  const dir = tempDir();
  let zip = await downloadZip(page, info);
  expect(Object.keys(zip.entries).sort()).toEqual(['legacy (2).xlsx', 'legacy.xlsx']);
  for (const name of ['legacy.xlsx', 'legacy (2).xlsx']) {
    const wb = pyRead<Sheet[]>('xlsx', writeTemp(dir, name, zip.entries[name]));
    expect(wb.map(s => s.name)).toEqual(['Data', 'Second', 'Hidden']);
    const data = wb[0];
    expect(data.rows[1]).toEqual(['Zo\u00eb \u65e5\u672c \u{1F600} \u0645\u0631\u062d\u0628\u0627', 0.3, '2026-11-22T00:00:00', '2026-11-22T14:30:05', '14:30:00', 0.25, 1234.5, true, null, 0.6, '#DIV/0!']);
    expect(data.cells.J2.formula).toBe('=B2*2');
    expect(data.cells.J3.formula).toBe('=SUM(B2:B3)');
    expect(data.cells.H2.type).toBe('b');
    expect(data.cells.C2.format).toMatch(/yy.*mm.*dd/);
    expect(data.rows[3]).toEqual(Array(11).fill(null));
    expect(data.rows[4].slice(0, 3)).toEqual(['01234', 123456789012345, '1999-12-31T00:00:00']);
    expect(data.rows[5].slice(0, 2)).toEqual(['=not a formula', 1e21]);
    expect(data.cells.A6.type).toBe('s');
    expect(wb[1].merged).toEqual(['A1:B1']);
    // XLS records which sheets are hidden; SheetJS does not read that from ODS (a documented limit).
    expect(wb[2].state).toBe(name === 'legacy.xlsx' ? 'hidden' : 'visible');
  }
  await expect(row(page, 'legacy.xls').locator('.job-notes')).toContainText('Not kept: fonts, colors, borders');
  await convertAllTo(page, 'CSV');
  zip = await downloadZip(page, info);
  for (const name of ['legacy.csv', 'legacy (2).csv']) {
    const rows = pyRead<string[][]>('csv', writeTemp(dir, name, zip.entries[name]));
    expect(rows[1].slice(0, 8)).toEqual(['Zo\u00eb \u65e5\u672c \u{1F600} \u0645\u0631\u062d\u0628\u0627', '0.3', '2026-11-22', '2026-11-22 14:30:05', '14:30:00', '25%', '1,234.50', 'TRUE']);
    expect(rows[4].slice(0, 2)).toEqual(['01234', '123456789012345']);
    expect(rows[5][0]).toBe("'=not a formula");
  }
  for (const [label, kind] of [['JSON', 'json'], ['JSON Lines', 'jsonl']] as const) {
    await convertAllTo(page, label);
    zip = await downloadZip(page, info);
    for (const name of [`legacy.${kind}`, `legacy (2).${kind}`]) {
      const v = pyRead<Array<Record<string, unknown>>>(kind, writeTemp(dir, name, zip.entries[name]));
      expect(v).toHaveLength(4);
      expect(v[0]).toMatchObject({ Date: '2026-11-22', DateTime: '2026-11-22T14:30:05', Time: '14:30:00', Number: 0.3, Flag: true, Empty: null, Formula: 0.6, Error: '#DIV/0!' });
      expect(v[2]).toMatchObject({ Text: '01234', Number: 123456789012345 });
    }
  }
  await row(page, 'legacy.ods').getByRole('combobox', { name: /^Convert .* to$/ }).selectOption({ label: 'TSV' });
  await row(page, 'legacy.ods').getByRole('combobox', { name: /Worksheet/ }).selectOption('all');
  await convert(page, 'legacy.ods', 'TSV');
  await expect(row(page, 'legacy.ods').locator('.outputs button')).toHaveCount(3);
  const hidden = await download(page, 'legacy.ods', info, 2);
  expect(hidden.filename).toBe('legacy - Hidden.tsv');
  expect(pyRead<string[][]>('tsv', hidden.path)).toEqual([['secret', '42']]);
});

test('hostile and broken data: the bad line is named, unsafe YAML tags stay data, nothing is fetched', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('hostile/bad-line.jsonl'), fx('hostile/unsafe-tags.yaml'), fx('hostile/deep.yaml'), fx('hostile/external-dtd.xml')]);
  await convert(page, 'bad-line.jsonl', 'CSV');
  await expect(row(page, 'bad-line.jsonl').locator('.job-error')).toContainText('Line 3 is not a complete JSON value, so nothing was converted');
  await convert(page, 'unsafe-tags.yaml', 'JSON');
  await expectDone(page, 'unsafe-tags.yaml');
  expect(pyRead('json', (await download(page, 'unsafe-tags.yaml', info)).path)).toEqual([['echo owned'], 'function () { return 1 }', { a: 1 }, 'plain']);
  await expect(row(page, 'unsafe-tags.yaml').locator('.job-notes')).toContainText('Unresolved tag');
  await convert(page, 'deep.yaml', 'CSV');
  await expect(row(page, 'deep.yaml').locator('.job-error')).toContainText('nested too deeply');
  await convert(page, 'external-dtd.xml', 'CSV');
  await expectDone(page, 'external-dtd.xml');
  expect(pyRead('csv', (await download(page, 'external-dtd.xml', info)).path)).toEqual([['a'], ['1'], ['2']]);
  await expect(row(page, 'external-dtd.xml').locator('.job-notes')).toContainText('nothing it refers to is loaded');
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});
