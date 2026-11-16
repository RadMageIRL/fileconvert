import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PYTHON, addFiles, convert, convertAllTo, cspViolations, download, expectDone, fx, openApp, row } from './helpers';

// The conversions themselves are covered in depth by tests/unit/data.test.ts; these check them in the
// browser's worker, through the interface, and with an independent reader (openpyxl) for XLSX.

test('JSON to CSV, YAML and XML in the browser', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('data/records.json')]);
  await convert(page, 'records.json', 'CSV');
  await expectDone(page, 'records.json');
  const csv = readFileSync((await download(page, 'records.json', info)).path, 'utf8');
  expect(csv.startsWith('\ufeffid,name,email,active,score,tags,address.city,address.zip,note\r\n')).toBe(true);
  await convert(page, 'records.json', 'YAML');
  expect(readFileSync((await download(page, 'records.json', info)).path, 'utf8')).toContain('    zip: "01234"');
  await convert(page, 'records.json', 'XML');
  const xml = readFileSync((await download(page, 'records.json', info)).path, 'utf8');
  expect(xml).toContain('<name>Grace, &quot;Amazing&quot;</name>');
  expect(w.outside).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('CSV, YAML and XML to JSON in the browser', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('data/people.csv'), fx('data/config.yaml'), fx('data/catalog.xml')]);
  await convertAllTo(page, 'JSON');
  for (const f of ['people.csv', 'config.yaml', 'catalog.xml']) await expectDone(page, f);
  const csv = JSON.parse(readFileSync((await download(page, 'people.csv', info)).path, 'utf8'));
  expect(csv[0].zip).toBe('01234');
  expect(csv[0].amount).toBe(1200.5);
  const yaml = JSON.parse(readFileSync((await download(page, 'config.yaml', info)).path, 'utf8'));
  expect(yaml.services[1].retries).toBe(3);
  const xml = JSON.parse(readFileSync((await download(page, 'catalog.xml', info)).path, 'utf8'));
  expect(xml.catalog.book[1].title).toBe('Privacy & You');
});

test('CSV to XLSX opens in openpyxl with typed numbers and text kept as text', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('data/people.csv')]);
  await convert(page, 'people.csv', 'XLSX');
  await expectDone(page, 'people.csv');
  const { path } = await download(page, 'people.csv', info);
  const script = 'import sys, json, openpyxl\nws = openpyxl.load_workbook(sys.argv[1]).active\nprint(json.dumps([[c.value if not hasattr(c.value, "isoformat") else c.value.isoformat() for c in r] for r in ws.iter_rows()]))';
  const rows = JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path], { encoding: 'utf8' }));
  expect(rows[0]).toEqual(['id', 'name', 'email', 'amount', 'joined', 'zip', 'comment']);
  expect(rows[1]).toEqual([1, 'Ada Lovelace', 'ada@example.com', 1200.5, '2024-01-15', '01234', 'Says "hello", often']);
  expect(rows[2][3]).toBe(-35);
});

test('XLSX to CSV: worksheet choice per file, one CSV per sheet', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('data/workbook.xlsx')]);
  await expect(row(page, 'workbook.xlsx').locator('.job-info')).toContainText('2 sheets');
  await convert(page, 'workbook.xlsx', 'CSV');
  await expectDone(page, 'workbook.xlsx');
  expect(readFileSync((await download(page, 'workbook.xlsx', info)).path, 'utf8')).toContain('Ada,2024-01-15,1200.5,01234,TRUE');
  await row(page, 'workbook.xlsx').getByRole('combobox', { name: /Worksheet/ }).selectOption('all');
  await convert(page, 'workbook.xlsx', 'CSV');
  await expect(row(page, 'workbook.xlsx').locator('.outputs button')).toHaveCount(2);
  const a = await download(page, 'workbook.xlsx', info, 0);
  const b = await download(page, 'workbook.xlsx', info, 1);
  expect(a.filename).toBe('workbook - People.csv');
  expect(b.filename).toBe('workbook - Totals.csv');
  expect(readFileSync(b.path, 'utf8')).toContain("Note,'=1+1 is text here");
  await expect(row(page, 'workbook.xlsx').locator('.job-notes')).toContainText('no saved result');
});

test('hostile data is refused with an explanation', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('hostile/xxe.xml'), fx('hostile/billion-laughs.xml'), fx('hostile/yaml-bomb.yaml'), fx('hostile/deep.json')]);
  await convert(page, 'xxe.xml', 'JSON');
  await expect(row(page, 'xxe.xml').locator('.job-error')).toContainText('declares entities');
  await convert(page, 'billion-laughs.xml', 'JSON');
  await expect(row(page, 'billion-laughs.xml').locator('.job-error')).toContainText('declares entities');
  await convert(page, 'yaml-bomb.yaml', 'JSON');
  await expect(row(page, 'yaml-bomb.yaml').locator('.job-error')).toContainText('billion laughs');
  await convert(page, 'deep.json', 'CSV');
  await expect(row(page, 'deep.json').locator('.job-error')).toContainText('nested 5000 levels deep');
});
