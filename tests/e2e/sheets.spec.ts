import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PYTHON, addFiles, convert, cspViolations, download, expectDone, fx, openApp, row } from './helpers';

// Spreadsheets and TSV in the browser (v0.2.0). XLSX results are read back by openpyxl, independently of
// SheetJS, which writes them.

/** Every sheet of a workbook as openpyxl reads it: [sheet, [[value, data_type], ...]]. */
function openpyxl(path: string): Array<[string, Array<Array<[unknown, string]>>]> {
  const script = [
    'import sys, json, openpyxl',
    'wb = openpyxl.load_workbook(sys.argv[1])',
    'print(json.dumps([[ws.title, [[[c.value, c.data_type] for c in r] for r in ws.iter_rows()]] for ws in wb.worksheets]))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path], { encoding: 'utf8' }));
}

test('XLSX to JSON keeps types, dates and emoji, and All sheets gives one JSON file', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('data/types.xlsx')]);
  await convert(page, 'types.xlsx', 'JSON');
  await expectDone(page, 'types.xlsx');
  const rows = JSON.parse(readFileSync((await download(page, 'types.xlsx', info)).path, 'utf8'));
  expect(rows[0]).toMatchObject({ Text: 'Zo\u00eb \u65e5\u672c \u{1F600} \u0645\u0631\u062d\u0628\u0627', Date: '2026-11-22', DateTime: '2026-11-22T14:30:05', Flag: true, Empty: null, Percent: 0.25 });
  await expect(row(page, 'types.xlsx').locator('.job-notes')).toContainText('became ISO 8601 text');

  await addFiles(page, [fx('data/workbook.xlsx')]);
  await convert(page, 'workbook.xlsx', 'JSON');
  const sheet = row(page, 'workbook.xlsx').getByRole('combobox', { name: /Worksheet/ });
  await expect(sheet.locator('option[value="all"]')).toHaveText('All sheets, in one JSON file');
  await sheet.selectOption('all');
  await convert(page, 'workbook.xlsx', 'JSON');
  await expect(row(page, 'workbook.xlsx').locator('.outputs button')).toHaveCount(1);
  const all = JSON.parse(readFileSync((await download(page, 'workbook.xlsx', info)).path, 'utf8'));
  expect(Object.keys(all)).toEqual(['People', 'Totals']);
  expect(all.People[0]).toEqual({ Name: 'Ada', Joined: '2024-01-15', Amount: 1200.5, Zip: '01234', Active: true });
  expect(w.outside).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('JSON to XLSX: openpyxl reads typed cells, text that is never a formula, and one sheet per list', async ({ page }, info) => {
  await openApp(page);
  const doc = '{"people":[{"name":"Zo\u00eb \u{1F600}","n":0.5,"ok":true,"f":"=SUM(A1:A9)","big":12345678901234567890,"none":null}],"orders":[{"id":7,"when":"2026-11-22"}]}';
  await page.locator('#picker').setInputFiles([{ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(doc) }]);
  await convert(page, 'export.json', 'XLSX');
  await expectDone(page, 'export.json');
  const sheets = openpyxl((await download(page, 'export.json', info)).path);
  expect(sheets.map(s => s[0])).toEqual(['people', 'orders']);
  const people = sheets[0][1];
  expect(people[0].map(c => c[0])).toEqual(['name', 'n', 'ok', 'f', 'big', 'none']);
  expect(people[1]).toEqual([['Zo\u00eb \u{1F600}', 's'], [0.5, 'n'], [true, 'b'], ['=SUM(A1:A9)', 's'], ['12345678901234567890', 's'], [null, 'n']]);
  expect(sheets[1][1][1]).toEqual([[7, 'n'], ['2026-11-22', 's']]);
});

test('TSV is its own format: recognized by name, converted to CSV and XLSX, and written from JSON', async ({ page }, info) => {
  await openApp(page);
  await page.locator('#picker').setInputFiles([
    { name: 'table.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('name\tnote\r\nAda\t"a, b"\r\nGrace\t=1+1\r\n') },
  ]);
  await expect(row(page, 'table.tsv').locator('.job-info')).toContainText('TSV file');
  await convert(page, 'table.tsv', 'CSV');
  await expectDone(page, 'table.tsv');
  const csv = readFileSync((await download(page, 'table.tsv', info)).path, 'utf8');
  expect(csv).toBe("\ufeffname,note\r\nAda,\"a, b\"\r\nGrace,'=1+1\r\n");
  await expect(row(page, 'table.tsv').locator('.job-notes')).toContainText('1 cell starting with = + - or @ got a leading apostrophe');
  await convert(page, 'table.tsv', 'XLSX');
  const xlsx = openpyxl((await download(page, 'table.tsv', info)).path);
  expect(xlsx[0][1][2]).toEqual([['Grace', 's'], ['=1+1', 's']]);

  await addFiles(page, [fx('data/records.json')]);
  await convert(page, 'records.json', 'TSV');
  const tsv = await download(page, 'records.json', info);
  expect(tsv.filename).toBe('records.tsv');
  expect(readFileSync(tsv.path, 'utf8').split('\r\n')[0]).toBe('\ufeffid\tname\temail\tactive\tscore\ttags\taddress.city\taddress.zip\tnote');

  // TSV to JSON, CSV to TSV, Excel to TSV.
  await convert(page, 'table.tsv', 'JSON');
  expect(JSON.parse(readFileSync((await download(page, 'table.tsv', info)).path, 'utf8'))).toEqual([{ name: 'Ada', note: 'a, b' }, { name: 'Grace', note: '=1+1' }]);
  await addFiles(page, [fx('data/people.csv'), fx('data/workbook.xlsx')]);
  await convert(page, 'people.csv', 'TSV');
  const tsvPath = (await download(page, 'people.csv', info)).path;
  const fromCsv = readFileSync(tsvPath, 'utf8');
  // Python's csv module reads the TSV (excel-tab) back to exactly the rows it reads from the CSV.
  const rows = (path: string, dialect: string) => JSON.parse(execFileSync(PYTHON, ['-I', '-c', 'import csv, sys, json; print(json.dumps(list(csv.reader(open(sys.argv[1], encoding="utf-8-sig", newline=""), dialect=sys.argv[2]))))', path, dialect], { encoding: 'utf8' }));
  expect(rows(tsvPath, 'excel-tab')).toEqual(rows(fx('data/people.csv'), 'excel'));
  // A field holding quote marks is quoted, as Excel and Python's excel-tab dialect write it, so it reads back exactly.
  expect(fromCsv.split('\r\n').slice(0, 2)).toEqual(['\ufeffid\tname\temail\tamount\tjoined\tzip\tcomment', '1\tAda Lovelace\tada@example.com\t1200.50\t2024-01-15\t01234\t"Says ""hello"", often"']);
  await convert(page, 'workbook.xlsx', 'TSV');
  expect(readFileSync((await download(page, 'workbook.xlsx', info)).path, 'utf8')).toContain('Ada\t2024-01-15\t1200.5\t01234\tTRUE');
});
