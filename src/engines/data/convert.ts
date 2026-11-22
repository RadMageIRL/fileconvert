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
import { keepAstralCharacters } from './xlsxtext';

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

/**
 * Flattens one record into dotted columns (address.city). Leaves keep their JSON value: a scalar, null for an
 * empty list or object, or (with arrays as JSON) the whole list.
 */
function flattenValues(rec: Json, arrays: 'json' | 'columns', out: Map<string, Json>, prefix = ''): void {
  if (rec === null || typeof rec !== 'object') {
    out.set(prefix || 'value', rec);
    return;
  }
  if (Array.isArray(rec)) {
    if (rec.length === 0) { out.set(prefix || 'value', null); return; }
    rec.forEach((v, i) => flattenValues(v, arrays, out, prefix ? `${prefix}.${i}` : String(i)));
    return;
  }
  const keys = Object.keys(rec);
  if (keys.length === 0 && prefix) { out.set(prefix, null); return; }
  for (const k of keys) {
    const v = (rec as Record<string, Json>)[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !(Array.isArray(v) && arrays === 'json')) flattenValues(v, arrays, out, path);
    else out.set(path, v);
  }
}

/** The rows a JSON document describes, as the CSV, TSV and XLSX writers see it. */
interface JsonTable {
  /** Column names, or null when the rows are lists and there is no header. */
  header: string[] | null;
  rows: Json[][];
}

function rowsOf(value: Json, warnings: string[]): Json[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    const only = keys.length === 1 ? (value as Record<string, Json>)[keys[0]] : undefined;
    if (Array.isArray(only) && only.every(r => r !== null && typeof r === 'object' && !Array.isArray(r))) {
      warnings.push(`Used the "${keys[0]}" list as the rows.`);
      return only;
    }
    warnings.push('The top level is a single object, so it became one row.');
    return [value];
  }
  return [value];
}

function tableOf(rows: Json[], o: DataOptions, warnings: string[]): JsonTable {
  if (rows.length > 0 && rows.every(r => Array.isArray(r))) {
    warnings.push('Each inner list became one row, with no header row.');
    return { header: null, rows: (rows as Json[][]).map(r => r.map(v => v !== null && typeof v === 'object' ? JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? Number(x) : x) : v)) };
  }
  const order: string[] = [];
  const seen = new Set<string>();
  let nested = false;
  const flat = rows.map(r => {
    const m = new Map<string, Json>();
    flattenValues(r, o.arrays, m);
    for (const k of m.keys()) {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
      if (k.includes('.')) nested = true;
    }
    return m;
  });
  if (order.length > LIMITS.xlsxColumns) throw new LimitError(`The records produce ${order.length} columns; the limit is ${LIMITS.xlsxColumns}.`);
  const missing = flat.filter(m => m.size < order.length).length;
  if (nested) warnings.push(o.arrays === 'json' ? 'Nested objects became dotted columns (address.city); lists stayed JSON text in one cell.' : 'Nested objects and lists became dotted, numbered columns (address.city, tags.0).');
  if (missing && rows.length > 1) warnings.push(`The records do not all have the same fields: there is one column for every field seen, and ${plural(missing, 'record')} ${missing === 1 ? 'has' : 'have'} empty cells where a field is missing.`);
  return { header: order, rows: flat.map(m => order.map(k => m.has(k) ? m.get(k)! : null)) };
}

function readJsonTable(bytes: Uint8Array, o: DataOptions, warnings: string[]): JsonTable {
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  return tableOf(rowsOf(parseJson(dec.text, warnings), warnings), o, warnings);
}

/** CSV and TSV share one writer; TSV is the same format with tabs. */
type TextTable = 'csv' | 'tsv';
const TEXT_TABLE = { csv: { ext: 'csv', mime: 'text/csv' }, tsv: { ext: 'tsv', mime: 'text/tab-separated-values' } } as const;
const textOptions = (o: DataOptions, as: TextTable): DataOptions => as === 'tsv' ? { ...o, delimiter: '\t' } : o;
const formulaNote = (n: number) => `${plural(n, 'cell')} starting with = + - or @ got a leading apostrophe so spreadsheets do not run them as formulas. Turn off formula protection in Data settings to keep them exactly as they are.`;

export function jsonToCsv(bytes: Uint8Array, o: DataOptions, as: TextTable = 'csv'): DataResult {
  const warnings: string[] = [];
  const t = readJsonTable(bytes, o, warnings);
  const cells: Cell[][] = t.header ? [t.header.map(k => ({ text: k, isText: true }))] : [];
  for (const r of t.rows) cells.push(r.map(scalarText));
  const columns = cells.reduce((m, r) => Math.max(m, r.length), 0);
  const { text, neutralized } = writeCsv(cells, textOptions(o, as));
  if (neutralized) warnings.push(formulaNote(neutralized));
  return {
    outputs: [{ bytes: utf8(text), ...TEXT_TABLE[as] }],
    warnings,
    summary: `${plural(t.rows.length, 'row')}, ${plural(columns, 'column')}`,
  };
}

/** Excel's limit on the text in one cell. */
const CELL_TEXT = 32767;

/** Writes one worksheet from rows of JSON values. Returns counts for the notes. */
function jsonSheet(t: JsonTable): { ws: XLSX.WorkSheet; width: number; exactText: number; truncated: number } {
  const all: Json[][] = t.header ? [t.header, ...t.rows] : t.rows;
  if (all.length > LIMITS.xlsxRows) throw new LimitError(`The data has ${all.length.toLocaleString('en-US')} rows; Excel allows ${LIMITS.xlsxRows.toLocaleString('en-US')}.`);
  const width = all.reduce((m, r) => Math.max(m, r.length), 0);
  const ws: XLSX.WorkSheet = {};
  const colWidth: number[] = new Array(width).fill(6);
  let exactText = 0, truncated = 0;
  all.forEach((r, ri) => r.forEach((v, ci) => {
    if (v === null || v === undefined) return;
    const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
    let cell: XLSX.CellObject;
    if (typeof v === 'number') cell = { t: 'n', v };
    else if (typeof v === 'boolean') cell = { t: 'b', v };
    else if (typeof v === 'bigint') { cell = { t: 's', v: String(v) }; exactText++; }
    else {
      let s = typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? Number(x) : x);
      s = s.replace(/\r\n?/g, '\n');
      if (s.length > CELL_TEXT) { s = s.slice(0, CELL_TEXT); truncated++; }
      cell = { t: 's', v: s };
    }
    ws[addr] = cell;
    colWidth[ci] = Math.min(60, Math.max(colWidth[ci], String(cell.v).length + 1));
  }));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, all.length - 1), c: Math.max(0, width - 1) } });
  ws['!cols'] = colWidth.map(wch => ({ wch }));
  if (t.header && t.rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, width - 1) } }) };
  return { ws, width, exactText, truncated };
}

/**
 * JSON to XLSX. A list of records becomes one sheet; an object whose values are all lists becomes one sheet per
 * list, named by its key. Numbers and true/false become typed cells; text is always stored as text (never a
 * formula); integers beyond what Excel can hold exactly are stored as text with every digit kept.
 */
export function jsonToXlsx(bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  const warnings: string[] = [];
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  const value = parseJson(dec.text, warnings);
  const sheets: Array<{ name: string; table: JsonTable }> = [];
  const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  if (keys.length > 1 && keys.every(k => Array.isArray((value as Record<string, Json>)[k]))) {
    const used = new Set<string>();
    for (const k of keys) {
      let name = sheetName(k), n = 2;
      while (used.has(name.toLowerCase())) name = `${sheetName(k).slice(0, 27)} (${n++})`;
      used.add(name.toLowerCase());
      if (name !== k) warnings.push(`The list "${k}" is on the sheet "${name}" (Excel sheet names are limited to 31 characters, without [ ] : * ? / \\).`);
      sheets.push({ name, table: tableOf((value as Record<string, Json[]>)[k], o, warnings) });
    }
    warnings.unshift(`Each of the ${keys.length} lists became its own sheet.`);
  } else {
    sheets.push({ name: sheetName(baseName), table: tableOf(rowsOf(value, warnings), o, warnings) });
  }
  const wb = XLSX.utils.book_new();
  let rows = 0, width = 0, exactText = 0, truncated = 0;
  for (const s of sheets) {
    const r = jsonSheet(s.table);
    XLSX.utils.book_append_sheet(wb, r.ws, s.name);
    rows += s.table.rows.length;
    width = Math.max(width, r.width);
    exactText += r.exactText;
    truncated += r.truncated;
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
  if (exactText) warnings.push(`${plural(exactText, 'integer')} larger than Excel can hold exactly ${exactText === 1 ? 'is' : 'are'} stored as text, with every digit kept.`);
  if (truncated) warnings.push(`${plural(truncated, 'cell')} longer than 32,767 characters, the Excel limit, were cut.`);
  warnings.push('Numbers and true/false are typed cells. Text, including dates written as text, stays text; text that starts with = is never stored as a formula.');
  return {
    outputs: [{ bytes: new Uint8Array(out), ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    warnings,
    summary: sheets.length > 1 ? `${plural(sheets.length, 'sheet')}, ${plural(rows, 'row')}` : `${plural(rows, 'row')}, ${plural(width, 'column')}`,
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

/** Reads CSV or TSV. A TSV file is read with tabs whatever the CSV separator setting says. */
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

/** CSV to TSV and back: the same table with the other separator. Every field is text, as it was. */
export function retabulate(bytes: Uint8Array, o: DataOptions, as: TextTable): DataResult {
  const warnings: string[] = [];
  const { rows, delimiter } = readCsvInput(bytes, o, warnings);
  if (rows.length === 0) throw new Error('The file is empty.');
  if (o.inputDelimiter === 'auto' && rows.some(r => r.length > 1)) warnings.push(`Fields are separated by ${delimiterName(delimiter)}.`);
  const { text, neutralized } = writeCsv(rows.map(r => r.map(t => ({ text: t, isText: true }))), textOptions(o, as));
  if (neutralized) warnings.push(formulaNote(neutralized));
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { outputs: [{ bytes: utf8(text), ...TEXT_TABLE[as] }], warnings, summary: `${plural(rows.length, 'row')}, ${plural(width, 'column')}` };
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
  const wb = XLSX.read(keepAstralCharacters(bytes), { type: 'array', bookSheets: true });
  return wb.SheetNames;
}

export function xlsxToCsv(bytes: Uint8Array, o: DataOptions, as: TextTable = 'csv'): DataResult {
  const warnings: string[] = [];
  if (bytes.length > LIMITS.xlsxBytes) throw new LimitError(`The workbook is larger than ${LIMITS.xlsxBytes / 1048576} MB, the limit.`);
  checkZip(bytes, 'workbook');
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(keepAstralCharacters(bytes), { type: 'array', dense: true, cellFormula: true, cellHTML: false, cellText: true, cellDates: false, cellStyles: false, sheetStubs: true, bookVBA: false });
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
  if (o.sheet === 'first' && wb.SheetNames.length > 1) warnings.push(`Converted the first sheet, "${names[0]}". The workbook has ${wb.SheetNames.length} sheets; choose another sheet, or All sheets, next to the file.`);
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
    const { text, neutralized } = writeCsv(table, textOptions(o, as));
    neutralizedTotal += neutralized;
    totalRows += table.length;
    outputs.push({ suffix: names.length > 1 || o.sheet !== 'first' ? name : undefined, bytes: utf8(text), ...TEXT_TABLE[as] });
  }
  if (outputs.length === 1 && o.sheet !== 'all') outputs[0].suffix = undefined;
  if (neutralizedTotal) warnings.push(formulaNote(neutralizedTotal));
  if (o.values === 'formatted') warnings.push('Values are written as Excel displays them (dates and number formats applied).');
  return { outputs, warnings, summary: outputs.length > 1 ? `${plural(outputs.length, 'sheet')}, ${plural(totalRows, 'row')}` : plural(totalRows, 'row') };
}

/**
 * Excel's date serial to ISO 8601 text: "2026-11-22" for a date, "2026-11-22T14:30:00" with a time, "14:30:00"
 * for a time alone. Excel dates have no time zone, so none is added. The 1900 and 1904 date systems are both
 * handled by SheetJS's date parser, including Excel's nonexistent 1900-02-29.
 */
export function excelDateToIso(serial: number, date1904: boolean): string | null {
  const d = XLSX.SSF.parse_date_code(serial, { date1904 });
  if (!d) return null;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const time = `${p(d.H)}:${p(d.M)}:${p(Math.floor(d.S))}`;
  if (serial >= 0 && serial < 1) return time;
  const date = `${p(d.y, 4)}-${p(d.m)}-${p(d.d)}`;
  return Number.isInteger(serial) || time === '00:00:00' ? date : `${date}T${time}`;
}

/**
 * XLSX to JSON. JSON keeps types: numbers stay numbers (exactly as Excel stores them), TRUE and FALSE become
 * true and false, empty cells become null, and cells with a date format become ISO 8601 text. With a header row
 * each row is an object; without one, a list. "All sheets" gives one JSON object keyed by sheet name.
 */
export function xlsxToJson(bytes: Uint8Array, o: DataOptions): DataResult {
  const warnings: string[] = [];
  if (bytes.length > LIMITS.xlsxBytes) throw new LimitError(`The workbook is larger than ${LIMITS.xlsxBytes / 1048576} MB, the limit.`);
  checkZip(bytes, 'workbook');
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(keepAstralCharacters(bytes), { type: 'array', dense: true, cellFormula: true, cellNF: true, cellHTML: false, cellText: true, cellDates: false, cellStyles: false, sheetStubs: true, bookVBA: false });
  } catch (e) {
    throw new Error(`The workbook could not be read: ${(e as Error).message}`);
  }
  const date1904 = !!(wb.Workbook as { WBProps?: { date1904?: boolean } } | undefined)?.WBProps?.date1904;
  let names: string[];
  if (o.sheet === 'all') names = wb.SheetNames;
  else if (o.sheet === 'first') names = wb.SheetNames.slice(0, 1);
  else {
    const want = o.sheet.name;
    if (!wb.SheetNames.includes(want)) throw new Error(`The workbook has no sheet named "${want}".`);
    names = [want];
  }
  if (names.length === 0) throw new Error('The workbook has no worksheets.');
  if (o.sheet === 'first' && wb.SheetNames.length > 1) warnings.push(`Converted the first sheet, "${names[0]}". The workbook has ${wb.SheetNames.length} sheets; choose another sheet, or All sheets, next to the file.`);
  let dates = 0, errors = 0, missing = 0, skipped = 0, total = 0;
  const value = (c: XLSX.CellObject | undefined): Json => {
    if (!c) return null;
    if (c.f && (c.t === 'z' || c.v === undefined)) { missing++; return null; }
    switch (c.t) {
      case 'n': {
        const n = c.v as number;
        if (c.z && typeof c.z === 'string' && XLSX.SSF.is_date(c.z)) {
          const iso = excelDateToIso(n, date1904);
          if (iso !== null) { dates++; return iso; }
        }
        return Number.isFinite(n) ? n : null;
      }
      case 'b': return c.v as boolean;
      case 'e': errors++; return c.w ?? '#ERROR';
      case 's': return String(c.v ?? '');
      case 'd': dates++; return (c.v as Date).toISOString();
      default: return null;
    }
  };
  const sheets: Record<string, Json[]> = {};
  for (const name of names) {
    const ws = wb.Sheets[name];
    const idx = wb.SheetNames.indexOf(name);
    if (wb.Workbook?.Sheets?.[idx]?.Hidden) warnings.push(`Sheet "${name}" is hidden in Excel.`);
    if (ws['!merges']?.length) warnings.push(`"${name}" has merged cells; their value is in the first cell only.`);
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    const dense = ((ws as unknown as { '!data'?: Array<Array<XLSX.CellObject | undefined> | undefined> })['!data']) ?? [];
    const grid: Json[][] = [];
    if (range) {
      for (let r = range.s.r; r <= range.e.r; r++) {
        const row: Json[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) row.push(value(dense[r]?.[c]));
        grid.push(row);
      }
    }
    const blank = (r: Json[]) => r.every(v => v === null || v === '');
    let out: Json[];
    if (o.header && grid.length) {
      const { names: keys, renamed } = headerNames(grid[0].map(v => v === null ? '' : String(v)));
      if (renamed) warnings.push(`${plural(renamed, 'column')} in "${name}" with an empty or repeated heading got a new name, like column_3 or name_2.`);
      out = [];
      for (const r of grid.slice(1)) {
        if (blank(r)) { skipped++; continue; }
        const rec: Record<string, Json> = {};
        keys.forEach((k, i) => { rec[k] = r[i] ?? null; });
        out.push(o.nest ? nestRecord(rec).value : rec);
      }
    } else {
      out = grid.filter(r => blank(r) ? (skipped++, false) : true);
    }
    total += out.length;
    sheets[name] = out;
  }
  if (dates) warnings.push(`${plural(dates, 'date cell')} became ISO 8601 text (2026-11-22, or 2026-11-22T14:30:00 with a time); Excel dates have no time zone, so none is added.`);
  if (errors) warnings.push(`${plural(errors, 'cell')} held an Excel error such as #DIV/0!, kept as that text.`);
  if (missing) warnings.push(`${plural(missing, 'formula cell')} had no saved result and became null. Open and save the workbook in Excel to store the results.`);
  if (skipped) warnings.push(`${plural(skipped, 'empty row')} left out.`);
  warnings.push('Numbers, true/false and empty cells (null) keep their JSON types. The "Spreadsheet values" setting applies to CSV and TSV only.');
  const doc: Json = o.sheet === 'all' ? sheets : sheets[names[0]];
  const text = JSON.stringify(doc, null, 2) + '\n';
  return {
    outputs: [{ bytes: utf8(text), ext: 'json', mime: 'application/json' }],
    warnings,
    summary: names.length > 1 ? `${plural(names.length, 'sheet')}, ${plural(total, o.header ? 'record' : 'row')}` : plural(total, o.header ? 'record' : 'row'),
  };
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

const tsvInput = (o: DataOptions): DataOptions => ({ ...o, inputDelimiter: '\t' });

export function convertData(from: string, to: string, bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  if (bytes.length > LIMITS.dataBytes) throw new LimitError(`The file is larger than ${LIMITS.dataBytes / 1048576} MB, the limit for data files.`);
  const key = `${from}>${to}`;
  switch (key) {
    case 'json>csv': return jsonToCsv(bytes, o);
    case 'json>tsv': return jsonToCsv(bytes, o, 'tsv');
    case 'json>xlsx': return jsonToXlsx(bytes, o, baseName);
    case 'json>yaml': return jsonToYaml(bytes);
    case 'json>xml': return jsonToXml(bytes);
    case 'csv>json': return csvToJson(bytes, o);
    case 'csv>xlsx': return csvToXlsx(bytes, o, baseName);
    case 'csv>tsv': return retabulate(bytes, o, 'tsv');
    case 'tsv>json': return csvToJson(bytes, tsvInput(o));
    case 'tsv>xlsx': return csvToXlsx(bytes, tsvInput(o), baseName);
    case 'tsv>csv': return retabulate(bytes, tsvInput(o), 'csv');
    case 'yaml>json': return yamlToJson(bytes);
    case 'xml>json': return xmlToJson(bytes);
    case 'xlsx>csv': return xlsxToCsv(bytes, o);
    case 'xlsx>tsv': return xlsxToCsv(bytes, o, 'tsv');
    case 'xlsx>json': return xlsxToJson(bytes, o);
  }
  throw new Error(`No data conversion from ${from} to ${to}.`);
}
