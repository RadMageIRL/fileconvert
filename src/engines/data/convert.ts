// Structured-data conversions: JSON, CSV, YAML, XML and XLSX. Pure functions of bytes and options, run in
// a worker by the app and directly by the unit tests. Every ambiguous mapping is a documented rule, and
// anything lost or changed on the way is reported as a warning rather than dropped silently.

import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseAllDocuments, stringify as yamlStringify } from 'yaml';
import * as XLSX from 'xlsx';
import { LIMITS, LimitError } from '../../core/limits';
import { decodeText, utf8 } from '../../core/text';
import { checkZip } from '../../core/zipcheck';
import { booleanValue, numericValue, parseCsv, writeCsv, type Cell } from './csv';

import type { DataOptions, DataOutput, DataResult } from './options';

export { DEFAULT_DATA_OPTIONS, type DataOptions, type DataOutput, type DataResult } from './options';


type Json = null | boolean | number | bigint | string | Json[] | { [k: string]: Json };

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ JSON

/** Parses JSON, keeping integers beyond 2^53 exact as BigInt where the engine gives the source text. */
export function parseJson(text: string, warnings: string[]): Json {
  const depth = jsonDepth(text);
  if (depth > LIMITS.dataDepth) throw new LimitError(`The data is nested ${depth} levels deep; the limit is ${LIMITS.dataDepth}.`);
  let unsafe = 0;
  let value: Json;
  try {
    value = JSON.parse(text.replace(/^\ufeff/, ''), function (this: unknown, _key: string, v: unknown, ctx?: { source?: string }) {
      if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) {
        if (ctx && typeof ctx.source === 'string' && /^-?\d+$/.test(ctx.source)) return BigInt(ctx.source);
        unsafe++;
      }
      return v;
    }) as Json;
  } catch (e) {
    throw new Error(`This is not valid JSON: ${(e as Error).message}`);
  }
  if (unsafe) warnings.push(`${plural(unsafe, 'number')} larger than 9007199254740991 may have lost precision; this browser does not expose the original digits.`);
  checkDepth(value);
  return value;
}

/** Bracket nesting of JSON text, measured before parsing (a parser with a reviver recurses per level). */
export function jsonDepth(text: string): number {
  let depth = 0, max = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) { if (++depth > max) max = depth; }
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}

/** Throws when nesting is deeper than the limit, without recursion. */
export function checkDepth(value: unknown, limit: number = LIMITS.dataDepth): void {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d > limit) throw new LimitError(`The data is nested more than ${limit} levels deep, the limit.`);
    for (const child of Array.isArray(v) ? v : Object.values(v as object)) {
      if (child !== null && typeof child === 'object') stack.push([child, d + 1]);
    }
  }
}

const scalarText = (v: Json): Cell => {
  if (v === null) return { text: '', isText: false };
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', isText: false };
  if (typeof v === 'number' || typeof v === 'bigint') return { text: String(v), isText: false };
  if (typeof v === 'string') return { text: v, isText: true };
  return { text: JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? Number(x) : x), isText: true };
};

function flattenRecord(rec: Json, arrays: 'json' | 'columns', out: Map<string, Cell>, prefix = ''): void {
  if (rec === null || typeof rec !== 'object') {
    out.set(prefix || 'value', scalarText(rec));
    return;
  }
  if (Array.isArray(rec)) {
    if (rec.length === 0) { out.set(prefix || 'value', { text: '', isText: false }); return; }
    rec.forEach((v, i) => flattenRecord(v, arrays, out, prefix ? `${prefix}.${i}` : String(i)));
    return;
  }
  const keys = Object.keys(rec);
  if (keys.length === 0 && prefix) { out.set(prefix, { text: '', isText: false }); return; }
  for (const k of keys) {
    const v = (rec as Record<string, Json>)[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !(Array.isArray(v) && arrays === 'json')) flattenRecord(v, arrays, out, path);
    else out.set(path, scalarText(v));
  }
}

export function jsonToCsv(bytes: Uint8Array, o: DataOptions): DataResult {
  const warnings: string[] = [];
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const value = parseJson(dec.text, warnings);
  let rows: Json[];
  let rowsAreArrays = false;
  if (Array.isArray(value)) {
    rows = value;
    rowsAreArrays = value.length > 0 && value.every(r => Array.isArray(r));
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    const only = keys.length === 1 ? (value as Record<string, Json>)[keys[0]] : undefined;
    if (Array.isArray(only) && only.every(r => r !== null && typeof r === 'object' && !Array.isArray(r))) {
      rows = only;
      warnings.push(`Used the "${keys[0]}" list as the rows.`);
    } else {
      rows = [value];
      warnings.push('The top level is a single object, so it became one row.');
    }
  } else {
    rows = [value];
  }
  let table: Cell[][];
  let columns = 0;
  if (rowsAreArrays) {
    table = (rows as Json[][]).map(r => r.map(scalarText));
    columns = table.reduce((m, r) => Math.max(m, r.length), 0);
    warnings.push('Each inner list became one row, with no header row.');
  } else {
    const order: string[] = [];
    const seen = new Set<string>();
    const flat = rows.map(r => {
      const m = new Map<string, Cell>();
      flattenRecord(r, o.arrays, m);
      for (const k of m.keys()) if (!seen.has(k)) { seen.add(k); order.push(k); }
      return m;
    });
    columns = order.length;
    if (columns > LIMITS.xlsxColumns) throw new LimitError(`The records produce ${columns} columns; the limit is ${LIMITS.xlsxColumns}.`);
    table = [order.map(k => ({ text: k, isText: true }))];
    for (const m of flat) table.push(order.map(k => m.get(k) ?? { text: '', isText: false }));
  }
  const { text, neutralized } = writeCsv(table, o);
  if (neutralized) warnings.push(`${plural(neutralized, 'cell')} starting with = + - or @ got a leading apostrophe so spreadsheets do not run them as formulas.`);
  const dataRows = rowsAreArrays ? table.length : table.length - 1;
  return {
    outputs: [{ bytes: utf8(text), ext: 'csv', mime: 'text/csv' }],
    warnings,
    summary: `${plural(dataRows, 'row')}, ${plural(columns, 'column')}`,
  };
}

// ------------------------------------------------------------------ CSV

function headerNames(row: string[]): { names: string[]; renamed: number } {
  const names: string[] = [];
  const used = new Set<string>();
  let renamed = 0;
  row.forEach((raw, i) => {
    let name = raw.trim() || `column_${i + 1}`;
    if (!raw.trim()) renamed++;
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
      renamed++;
    }
    used.add(name);
    names.push(name);
  });
  return { names, renamed };
}

function typed(s: string, detect: boolean): Json {
  if (!detect) return s;
  const n = numericValue(s);
  if (n !== null) return n;
  const b = booleanValue(s);
  if (b !== null) return b;
  return s;
}

function nestRecord(flat: Record<string, Json>): { value: Record<string, Json>; ok: boolean } {
  const root: Record<string, Json> = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split('.');
    if (parts.some(p => p === '')) return { value: flat, ok: false };
    let node: Record<string, Json> = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!(p in node)) node[p] = {};
      const next = node[p];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) return { value: flat, ok: false };
      node = next as Record<string, Json>;
    }
    const last = parts[parts.length - 1];
    if (last in node) return { value: flat, ok: false };
    node[last] = v;
  }
  return { value: root, ok: true };
}

function readCsvInput(bytes: Uint8Array, o: DataOptions, warnings: string[]) {
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const parsed = parseCsv(dec.text, o.inputDelimiter, LIMITS.csvCells);
  warnings.push(...parsed.warnings);
  return parsed;
}

const delimiterName = (d: string) => d === ',' ? 'commas' : d === ';' ? 'semicolons' : d === '\t' ? 'tabs' : d === '|' ? 'pipes' : `"${d}"`;

export function csvToJson(bytes: Uint8Array, o: DataOptions): DataResult {
  const warnings: string[] = [];
  const { rows, delimiter } = readCsvInput(bytes, o, warnings);
  if (rows.length === 0) throw new Error('The CSV file is empty.');
  if (o.inputDelimiter === 'auto' && rows.some(r => r.length > 1)) warnings.push(`Fields are separated by ${delimiterName(delimiter)}.`);
  let out: Json[];
  if (o.header) {
    const { names, renamed } = headerNames(rows[0]);
    if (renamed) warnings.push(`${plural(renamed, 'column')} with an empty or repeated name got a new name, like column_3 or name_2.`);
    let ragged = 0;
    out = rows.slice(1).map(r => {
      if (r.length !== names.length) ragged++;
      const rec: Record<string, Json> = {};
      names.forEach((n, i) => { rec[n] = i < r.length ? typed(r[i], o.detectTypes) : null; });
      for (let i = names.length; i < r.length; i++) rec[`column_${i + 1}`] = typed(r[i], o.detectTypes);
      return rec;
    });
    if (ragged) warnings.push(`${plural(ragged, 'row')} had a different number of fields than the header. Missing fields are null; extra fields got column_N names.`);
    if (o.nest) {
      let failed = 0;
      out = out.map(r => {
        const n = nestRecord(r as Record<string, Json>);
        if (!n.ok) failed++;
        return n.value;
      });
      if (failed) warnings.push(`${plural(failed, 'row')} kept flat names because their dotted column names conflict (like "a" and "a.b").`);
    }
  } else {
    out = rows.map(r => r.map(s => typed(s, o.detectTypes)));
  }
  const text = JSON.stringify(out, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 2) + '\n';
  return {
    outputs: [{ bytes: utf8(text), ext: 'json', mime: 'application/json' }],
    warnings,
    summary: `${plural(out.length, o.header ? 'record' : 'row')}`,
  };
}

const sheetName = (base: string) => {
  const n = base.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31).trim();
  return n && n.toLowerCase() !== 'history' ? n : 'Sheet1';
};

export function csvToXlsx(bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  const warnings: string[] = [];
  const { rows, delimiter } = readCsvInput(bytes, o, warnings);
  if (rows.length === 0) throw new Error('The CSV file is empty.');
  if (o.inputDelimiter === 'auto' && rows.some(r => r.length > 1)) warnings.push(`Fields are separated by ${delimiterName(delimiter)}.`);
  if (rows.length > LIMITS.xlsxRows) throw new LimitError(`The CSV has ${rows.length.toLocaleString('en-US')} rows; Excel allows ${LIMITS.xlsxRows.toLocaleString('en-US')}.`);
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (width > LIMITS.xlsxColumns) throw new LimitError(`The CSV has ${width} columns; Excel allows ${LIMITS.xlsxColumns}.`);
  const ws: XLSX.WorkSheet = {};
  const colWidth: number[] = new Array(width).fill(6);
  let truncated = 0, numbers = 0;
  rows.forEach((r, ri) => {
    r.forEach((raw, ci) => {
      if (raw === '') return;
      const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
      const isHeader = o.header && ri === 0;
      const n = !isHeader && o.detectTypes ? numericValue(raw) : null;
      if (n !== null) {
        const cell: XLSX.CellObject = { t: 'n', v: n };
        const decimals = /\.(\d+)(?![eE])/.exec(raw)?.[1].length ?? 0;
        if (decimals > 0 && !/[eE]/.test(raw)) cell.z = '0.' + '0'.repeat(decimals);
        ws[addr] = cell;
        numbers++;
      } else {
        // Excel stores line breaks inside a cell as LF; a CR would be dropped by any XML reader anyway.
        let v = raw.replace(/\r\n?/g, '\n');
        if (v.length > 32767) { v = v.slice(0, 32767); truncated++; }
        ws[addr] = { t: 's', v };
      }
      colWidth[ci] = Math.min(60, Math.max(colWidth[ci], raw.length + 1));
    });
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: Math.max(0, width - 1) } });
  ws['!cols'] = colWidth.map(wch => ({ wch }));
  if (o.header && rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, width - 1) } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName(baseName));
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
  if (truncated) warnings.push(`${plural(truncated, 'cell')} longer than 32,767 characters, the Excel limit, were cut.`);
  if (o.detectTypes) warnings.push(`${plural(numbers, 'cell')} became numbers. Text such as dates, leading zeros (01234) and long digit strings stayed text.`);
  else warnings.push('Every cell is text, as chosen.');
  warnings.push('Cells that start with = are stored as text, never as formulas.');
  return {
    outputs: [{ bytes: new Uint8Array(out), ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    warnings,
    summary: `${plural(rows.length, 'row')}, ${plural(width, 'column')}`,
  };
}

// ------------------------------------------------------------------ XLSX

export function xlsxSheetNames(bytes: Uint8Array): string[] {
  checkZip(bytes, 'workbook');
  const wb = XLSX.read(bytes, { type: 'array', bookSheets: true });
  return wb.SheetNames;
}

export function xlsxToCsv(bytes: Uint8Array, o: DataOptions): DataResult {
  const warnings: string[] = [];
  if (bytes.length > LIMITS.xlsxBytes) throw new LimitError(`The workbook is larger than ${LIMITS.xlsxBytes / 1048576} MB, the limit.`);
  checkZip(bytes, 'workbook');
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: 'array', dense: true, cellFormula: true, cellHTML: false, cellText: true, cellDates: false, cellStyles: false, sheetStubs: true, bookVBA: false });
  } catch (e) {
    throw new Error(`The workbook could not be read: ${(e as Error).message}`);
  }
  let names: string[];
  if (o.sheet === 'all') names = wb.SheetNames;
  else if (o.sheet === 'first') names = wb.SheetNames.slice(0, 1);
  else {
    const want = o.sheet.name;
    if (!wb.SheetNames.includes(want)) throw new Error(`The workbook has no sheet named "${want}".`);
    names = [want];
  }
  if (names.length === 0) throw new Error('The workbook has no worksheets.');
  if (o.sheet === 'first' && wb.SheetNames.length > 1) warnings.push(`Converted the first sheet, "${names[0]}". The workbook has ${wb.SheetNames.length} sheets; choose All sheets to get one CSV each.`);
  const outputs: DataOutput[] = [];
  let totalRows = 0, neutralizedTotal = 0;
  for (const name of names) {
    const ws = wb.Sheets[name];
    const idx = wb.SheetNames.indexOf(name);
    if (wb.Workbook?.Sheets?.[idx]?.Hidden) warnings.push(`Sheet "${name}" is hidden in Excel.`);
    let missing = 0;
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    const dense = (ws as unknown as { '!data'?: XLSX.CellObject[][] })['!data'];
    if (dense) for (const row of dense) for (const c of row ?? []) if (c && c.f && (c.t === 'z' || c.v === undefined)) missing++;
    if (missing) warnings.push(`${plural(missing, 'formula cell')} in "${name}" ${missing === 1 ? 'has' : 'have'} no saved result and ${missing === 1 ? 'is' : 'are'} empty. Open and save the workbook in Excel to store the results.`);
    if (ws['!merges']?.length) warnings.push(`"${name}" has merged cells; their value is in the first cell only.`);
    const aoa = range ? XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: o.values === 'raw', defval: '', blankrows: true }) : [];
    while (aoa.length && aoa[aoa.length - 1].every(v => v === '' || v === null || v === undefined)) aoa.pop();
    // Every row gets the sheet's full width, so the CSV is rectangular even where cells are missing.
    const width = range ? range.e.c - range.s.c + 1 : 0;
    for (const row of aoa) while (row.length < width) row.push('');
    const table: Cell[][] = aoa.map(r => r.map(v => {
      if (v === null || v === undefined) return { text: '', isText: false };
      if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', isText: false };
      if (typeof v === 'number') return { text: String(v), isText: false };
      return { text: String(v), isText: true };
    }));
    const { text, neutralized } = writeCsv(table, o);
    neutralizedTotal += neutralized;
    totalRows += table.length;
    outputs.push({ suffix: names.length > 1 || o.sheet !== 'first' ? name : undefined, bytes: utf8(text), ext: 'csv', mime: 'text/csv' });
  }
  if (outputs.length === 1 && o.sheet !== 'all') outputs[0].suffix = undefined;
  if (neutralizedTotal) warnings.push(`${plural(neutralizedTotal, 'cell')} starting with = + - or @ got a leading apostrophe so spreadsheets do not run them as formulas.`);
  if (o.values === 'formatted') warnings.push('Values are written as Excel displays them (dates and number formats applied).');
  return { outputs, warnings, summary: outputs.length > 1 ? `${plural(outputs.length, 'sheet')}, ${plural(totalRows, 'row')}` : plural(totalRows, 'row') };
}

// ------------------------------------------------------------------ YAML

export function jsonToYaml(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const value = parseJson(dec.text, warnings);
  // YAML 1.1 quoting rules: strings such as yes, no, on, 2026-11-15 or 1:20 are quoted, so YAML 1.1 readers
  // (PyYAML, older tools) do not turn them into booleans, dates or numbers. The result is valid YAML 1.2 too.
  const text = yamlStringify(value, { version: '1.1', indent: 2, lineWidth: 0, minContentWidth: 0, aliasDuplicateObjects: false });
  return { outputs: [{ bytes: utf8(text), ext: 'yaml', mime: 'application/yaml' }], warnings, summary: 'YAML document' };
}

export function yamlToJson(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const docs = parseAllDocuments(dec.text, { prettyErrors: true, uniqueKeys: true, merge: true, schema: 'core' });
  const list = Array.isArray(docs) ? docs : [docs];
  const values: unknown[] = [];
  for (const doc of list) {
    if (doc.errors.length) throw new Error(`This is not valid YAML: ${doc.errors[0].message.split('\n')[0]}`);
    for (const w of doc.warnings) warnings.push(w.message.split('\n')[0]);
    try {
      values.push(doc.toJS({ maxAliasCount: 100 }));
    } catch (e) {
      if (/alias/i.test((e as Error).message)) throw new LimitError('The YAML uses aliases to expand far beyond its size (a "billion laughs" pattern), so it was not converted.');
      throw e;
    }
  }
  if (values.length === 0) throw new Error('The YAML file has no documents.');
  let value: unknown = values.length === 1 ? values[0] : values;
  if (values.length > 1) warnings.push(`The file has ${values.length} YAML documents; the JSON is a list of them.`);
  let nonFinite = 0, other = 0;
  const clean = (v: unknown, depth: number): unknown => {
    if (depth > LIMITS.dataDepth) throw new LimitError(`The data is nested more than ${LIMITS.dataDepth} levels deep, the limit.`);
    if (typeof v === 'number' && !Number.isFinite(v)) { nonFinite++; return null; }
    if (v === undefined) { other++; return null; }
    if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
    if (v instanceof Uint8Array || v instanceof Date || v instanceof Map || v instanceof Set) { other++; return String(v); }
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = clean(x, depth + 1);
      return o;
    }
    return v;
  };
  value = clean(value, 0);
  if (nonFinite) warnings.push(`${plural(nonFinite, 'value')} (.inf or .nan) cannot exist in JSON and became null.`);
  if (other) warnings.push(`${plural(other, 'value')} with no JSON equivalent became text or null.`);
  const text = JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 2) + '\n';
  return { outputs: [{ bytes: utf8(text), ext: 'json', mime: 'application/json' }], warnings, summary: values.length > 1 ? plural(values.length, 'document') : 'JSON document' };
}

// ------------------------------------------------------------------ XML

/** Rejects DOCTYPE entity declarations before any parser sees them (XXE, billion laughs). */
export function checkXmlSafety(text: string, warnings: string[]): void {
  const m = /<!DOCTYPE/i.exec(text);
  if (!m) return;
  const rest = text.slice(m.index, m.index + 200000);
  if (/<!ENTITY/i.test(rest)) {
    throw new Error('This XML declares entities in its DOCTYPE. Entity expansion is a common attack (XXE, billion laughs), so FileConvert does not convert such files. Remove the DOCTYPE block and try again.');
  }
  warnings.push('The DOCTYPE declaration was ignored; nothing it refers to is loaded.');
}

/** Measures element nesting without recursion, skipping comments, CDATA, declarations and quoted attribute values. */
export function xmlDepth(text: string): number {
  let depth = 0, max = 0;
  let i = text.indexOf('<');
  while (i !== -1 && i < text.length) {
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); i = e < 0 ? -1 : text.indexOf('<', e + 3); continue; }
    if (text.startsWith('<![CDATA[', i)) { const e = text.indexOf(']]>', i + 9); i = e < 0 ? -1 : text.indexOf('<', e + 3); continue; }
    if (text[i + 1] === '?' || text[i + 1] === '!') { const e = text.indexOf('>', i); i = e < 0 ? -1 : text.indexOf('<', e + 1); continue; }
    let j = i + 1;
    let quote = '';
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (text[i + 1] === '/') depth--;
    else if (text[j - 1] === '/') { if (depth + 1 > max) max = depth + 1; }
    else { depth++; if (depth > max) max = depth; }
    i = text.indexOf('<', j + 1);
  }
  return max;
}

const ENTITY = /&(lt|gt|amp|apos|quot|#\d+|#x[0-9a-fA-F]+);/g;
function decodeEntities(s: string): string {
  return s.replace(ENTITY, (m, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'apos': return "'";
      case 'quot': return '"';
    }
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

function decodeTree(v: unknown): unknown {
  if (typeof v === 'string') return decodeEntities(v);
  if (Array.isArray(v)) return v.map(decodeTree);
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = decodeTree(x);
    return o;
  }
  return v;
}

export function xmlToJson(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const text = dec.text.replace(/^\ufeff/, '');
  checkXmlSafety(text, warnings);
  const depth = xmlDepth(text);
  if (depth > LIMITS.dataDepth) throw new LimitError(`The XML is nested ${depth} levels deep; the limit is ${LIMITS.dataDepth}.`);
  const valid = XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (valid !== true) throw new Error(`This is not well-formed XML: ${valid.err.msg} (line ${valid.err.line}, column ${valid.err.col}).`);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
    htmlEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    allowBooleanAttributes: true,
    removeNSPrefix: false,
    // The depth is already checked above with a clear message; the parser's own cap (100 by default) sits past it.
    maxNestedTags: LIMITS.dataDepth + 1,
  });
  const value = decodeTree(parser.parse(text));
  if (/<!\[CDATA\[/.test(text)) warnings.push('CDATA sections were merged into the element text.');
  warnings.push('Attributes are keys starting with @, element text is #text, and repeated elements became lists. All values are kept as text.');
  const out = JSON.stringify(value, null, 2) + '\n';
  return { outputs: [{ bytes: utf8(out), ext: 'json', mime: 'application/json' }], warnings, summary: 'JSON document' };
}

const XML_NAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
const XML_BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function xmlName(key: string, renamed: Map<string, string>): string {
  const valid = (k: string) => k.split(':').length <= 2 && k.split(':').every(p => XML_NAME.test(p));
  if (valid(key)) return key;
  let n = key.replace(/[^\p{L}\p{N}_.-]/gu, '_');
  if (!/^[\p{L}_]/u.test(n)) n = '_' + n;
  renamed.set(key, n);
  return n;
}

export function jsonToXml(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const value = parseJson(dec.text, warnings);
  const renamed = new Map<string, string>();
  let badChars = 0;
  const fix = (v: Json, parentKey: string | null): unknown => {
    if (typeof v === 'string') {
      const c = v.replace(XML_BAD_CHARS, () => { badChars++; return ''; });
      return c;
    }
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(x => fix(x, parentKey));
    if (v !== null && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === '#text') { o[k] = fix(x, k); continue; }
        if (k.startsWith('@')) {
          if (x !== null && typeof x === 'object') { o[xmlName(k.slice(1), renamed)] = fix(x, k); continue; }
          o['@' + xmlName(k.slice(1), renamed)] = fix(x, k);
          continue;
        }
        o[xmlName(k, renamed)] = fix(x, k);
      }
      return o;
    }
    return v;
  };
  let tree: unknown;
  const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  if (keys.length === 1 && !keys[0].startsWith('@') && keys[0] !== '#text' && !Array.isArray((value as Record<string, Json>)[keys[0]])) {
    tree = fix(value, null);
  } else if (Array.isArray(value)) {
    tree = { root: { item: fix(value, 'item') } };
    warnings.push('The top level is a list, so it is wrapped in <root> with one <item> per entry.');
  } else {
    tree = { root: fix(value, 'root') };
    if (keys.length !== 1) warnings.push('The top level has no single key to use as the root element, so it is wrapped in <root>.');
  }
  if (renamed.size) {
    const examples = [...renamed].slice(0, 3).map(([a, b]) => `"${a}" to "${b}"`).join(', ');
    warnings.push(`Renamed ${plural(renamed.size, 'key')} that are not valid XML names: ${examples}${renamed.size > 3 ? ', ...' : ''}.`);
  }
  if (badChars) warnings.push(`Removed ${plural(badChars, 'character')} that XML does not allow (control characters).`);
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    textNodeName: '#text',
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    processEntities: true,
  });
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(tree);
  return { outputs: [{ bytes: utf8(xml), ext: 'xml', mime: 'application/xml' }], warnings, summary: 'XML document' };
}

// ------------------------------------------------------------------ dispatch

export function convertData(from: string, to: string, bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  if (bytes.length > LIMITS.dataBytes) throw new LimitError(`The file is larger than ${LIMITS.dataBytes / 1048576} MB, the limit for data files.`);
  const key = `${from}>${to}`;
  switch (key) {
    case 'json>csv': return jsonToCsv(bytes, o);
    case 'json>yaml': return jsonToYaml(bytes);
    case 'json>xml': return jsonToXml(bytes);
    case 'csv>json': return csvToJson(bytes, o);
    case 'csv>xlsx': return csvToXlsx(bytes, o, baseName);
    case 'yaml>json': return yamlToJson(bytes);
    case 'xml>json': return xmlToJson(bytes);
    case 'xlsx>csv': return xlsxToCsv(bytes, o);
  }
  throw new Error(`No data conversion from ${from} to ${to}.`);
}
