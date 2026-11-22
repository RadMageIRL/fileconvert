// Structured-data conversions: JSON, JSON Lines, CSV, TSV, YAML, XML and spreadsheets (XLSX, XLS, ODS). Pure
// functions of bytes and options, run in a worker by the app and directly by the unit tests. Every ambiguous mapping
// is a documented rule, and anything lost or changed on the way is reported as a warning rather than dropped
// silently.
//
// Tables from JSON, JSON Lines and YAML (CSV, TSV, Excel) follow these rules, also in the README and on the pages:
//  1. A list: each item is a row. JSON Lines is always such a list, one line per row.
//  2. An object whose values are all lists: each list is a table (one CSV or TSV file each, one sheet each in Excel).
//  3. An object holding lists of records (lists of objects) beside other fields: each such list is a table, and the
//     other fields are repeated on every row as extra columns, so nothing is lost.
//  4. Any other object: one row. Any other single value: one row, one column.
//  5. In a row, nested objects become dotted columns (address.city), and lists become JSON text in one cell or
//     numbered columns (tags.0, tags.1), as chosen in Data settings. Records with different fields share one column
//     per field; a missing field is an empty cell. A list of lists gives rows without a header.
//  6. Tables are never combined: two lists of records are two tables, never a product of their rows. Rows come only
//     from the top level; lists of records inside the rows stay in their row (rule 5), and a list that mixes records
//     with other values is never used as the rows. The notes name each such list.
//  7. Nothing is dropped: a column name two fields would share (a key "a.b" beside a nested a.b) gets _2 for the
//     later one; null and a missing field are empty cells, [] and {} are written as text; an empty list, an empty
//     object or records with no fields give an empty table (no blank lines) and a note. A key repeated inside one
//     JSON object cannot be kept (JSON.parse keeps the last value, like every reader) and is counted in a note.
// XML has its own rules for finding the records (./xml.ts), then rule 5.

import { XMLBuilder } from 'fast-xml-parser';
import { parseAllDocuments, stringify as yamlStringify } from 'yaml';
import * as XLSX from 'xlsx';
import { LIMITS, LimitError } from '../../core/limits';
import { decodeText, utf8 } from '../../core/text';
import { booleanValue, numericValue, parseCsv, writeCsv, type Cell } from './csv';
import { parseJson, plural, stringifyJson, type Json } from './json';
import { readJsonLines, writeJsonLines } from './jsonl';
import { flattenXmlRecord, parseXml, xmlTables } from './xml';
import { readWorkbook, workbookSheetNames, workbookToXlsx, type WorkbookKind } from './workbook';

import type { DataOptions, DataOutput, DataResult } from './options';

export { DEFAULT_DATA_OPTIONS, type DataOptions, type DataOutput, type DataResult } from './options';
export { checkDepth, jsonDepth, parseJson, stringifyJson } from './json';
export { checkXmlSafety, xmlDepth } from './xml';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const JSON_OUT = { ext: 'json', mime: 'application/json' } as const;
const JSONL_OUT = { ext: 'jsonl', mime: 'application/jsonl' } as const;

const readText = (bytes: Uint8Array, warnings: string[]) => {
  const dec = decodeText(bytes);
  if (dec.warning) warnings.push(dec.warning);
  return dec.text;
};

const scalarText = (v: Json): Cell => {
  if (v === null) return { text: '', isText: false };
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', isText: false };
  if (typeof v === 'number' || typeof v === 'bigint') return { text: String(v), isText: false };
  if (typeof v === 'string') return { text: v, isText: true };
  return { text: stringifyJson(v), isText: true };
};

/** What flattening met that the notes must explain, gathered over every row of every table of one file. */
interface FlatNotes {
  /** Column names that two fields produced (a key "a.b" beside a nested a.b); the later field got a _2 suffix. */
  clashes: Set<string>;
  /** Fields inside the rows that hold lists of records; they are kept in the row, never expanded into more rows. */
  innerRecords: Set<string>;
}

const newNotes = (): FlatNotes => ({ clashes: new Set(), innerRecords: new Set() });

const isObject = (v: Json): v is { [k: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRecordList = (v: Json): v is Json[] => Array.isArray(v) && v.length > 0 && v.every(isObject);
/** A list holding some records and some other values: not a clear list of records, so never used as the rows. */
const isMixedList = (v: Json): boolean => Array.isArray(v) && v.some(isObject) && !v.every(isObject);

/** A field's name for the notes: its path without list positions (orders.0.lines becomes orders.lines). */
const fieldName = (path: string) => path.split('.').filter(p => !/^\d+$/.test(p)).join('.') || path;

/** Sets a column; a name that is already taken gets a _2 (_3, ...) suffix, so no field ever overwrites another. */
function put(out: Map<string, Json>, path: string, v: Json, notes: FlatNotes): void {
  if (out.has(path)) {
    notes.clashes.add(path);
    let n = 2;
    while (out.has(`${path}_${n}`)) n++;
    path = `${path}_${n}`;
  }
  out.set(path, v);
}

/**
 * Flattens one record into dotted columns (address.city). Leaves keep their JSON value: a scalar or null, an empty
 * list or object (written [] and {}, so they stay apart from a missing field), or (with arrays as JSON) the whole
 * list.
 */
function flattenValues(rec: Json, arrays: 'json' | 'columns', out: Map<string, Json>, notes: FlatNotes, prefix = ''): void {
  if (rec === null || typeof rec !== 'object') {
    put(out, prefix || 'value', rec, notes);
    return;
  }
  if (Array.isArray(rec)) {
    if (rec.length === 0) { put(out, prefix || 'value', rec, notes); return; }
    // A list in a field (here, one of the top-level fields repeated beside the records) follows the setting too;
    // only a row that is itself a list is always spread into numbered columns.
    if (prefix && arrays === 'json') {
      if (isRecordList(rec)) notes.innerRecords.add(fieldName(prefix));
      put(out, prefix, rec, notes);
      return;
    }
    if (prefix && isRecordList(rec)) notes.innerRecords.add(fieldName(prefix));
    rec.forEach((v, i) => flattenValues(v, arrays, out, notes, prefix ? `${prefix}.${i}` : String(i)));
    return;
  }
  const keys = Object.keys(rec);
  if (keys.length === 0 && prefix) { put(out, prefix, rec, notes); return; }
  for (const k of keys) {
    const v = rec[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !(Array.isArray(v) && arrays === 'json')) flattenValues(v, arrays, out, notes, path);
    else {
      if (isRecordList(v)) notes.innerRecords.add(fieldName(path));
      put(out, path, v, notes);
    }
  }
}

/** The rows a document describes, as the CSV, TSV and XLSX writers see them. */
interface Table {
  /** Names the CSV file or the sheet when there are several tables. */
  name?: string;
  /** Column names, or null when the rows are lists and there is no header. */
  header: string[] | null;
  rows: Json[][];
}

/** Rows from flattened records, with one column per field seen, in first-seen order, then the context columns. */
function mapsToTable(flat: Array<Map<string, Json>>, context: Map<string, Json>, warnings: string[], name?: string): Table {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const m of flat) for (const k of m.keys()) if (!seen.has(k)) { seen.add(k); order.push(k); }
  const missing = flat.filter(m => m.size < order.length).length;
  // Context columns come last; one whose name a record field already uses gets a _2 suffix.
  const contextCols: Array<[string, Json]> = [];
  for (const [k, v] of context) {
    let col = k, n = 2;
    while (seen.has(col)) col = `${k}_${n++}`;
    seen.add(col);
    contextCols.push([col, v]);
  }
  const header = [...order, ...contextCols.map(c => c[0])];
  if (header.length > LIMITS.xlsxColumns) throw new LimitError(`The records produce ${header.length} columns; the limit is ${LIMITS.xlsxColumns}.`);
  if (header.length === 0) {
    // Records with no fields at all ({}) have nothing to write: the table is empty, never a run of blank lines.
    if (flat.length) warnings.push(`The ${flat.length === 1 ? 'record' : plural(flat.length, 'record')} ${name ? `in "${name}" ` : ''}${flat.length === 1 ? 'has' : 'have'} no fields, so the table is empty.`);
    return { name, header, rows: [] };
  }
  if (missing && flat.length > 1) warnings.push(`The records ${name ? `in "${name}" ` : ''}do not all have the same fields: there is one column for every field seen, and ${plural(missing, 'record')} ${missing === 1 ? 'has' : 'have'} empty cells where a field is missing.`);
  return { name, header, rows: flat.map(m => [...order.map(k => m.has(k) ? m.get(k)! : null), ...contextCols.map(c => c[1])]) };
}

function tableOf(rows: Json[], o: DataOptions, warnings: string[], notes: FlatNotes, context = new Map<string, Json>(), name?: string): Table {
  if (rows.length > 0 && rows.every(r => Array.isArray(r))) {
    warnings.push('Each inner list became one row, with no header row.');
    return { name, header: null, rows: (rows as Json[][]).map(r => r.map(v => v !== null && typeof v === 'object' ? stringifyJson(v) : v)) };
  }
  let nested = false, records = 0, lists = 0, single = 0;
  const flat = rows.map(r => {
    if (isObject(r)) records++;
    else if (Array.isArray(r)) lists++;
    else single++;
    const m = new Map<string, Json>();
    flattenValues(r, o.arrays, m, notes);
    for (const k of m.keys()) if (k.includes('.')) nested = true;
    return m;
  });
  if (nested) warnings.push(o.arrays === 'json' ? 'Nested objects became dotted columns (address.city); lists stayed JSON text in one cell.' : 'Nested objects and lists became dotted, numbered columns (address.city, tags.0).');
  if ([records, lists, single].filter(Boolean).length > 1) {
    const kinds = [records && plural(records, 'record'), single && plural(single, 'single value'), lists && plural(lists, 'list')].filter(Boolean);
    const where = [records && 'records give their fields as columns', single && 'single values are in the "value" column', lists && 'inner lists are numbered columns (0, 1, ...)'].filter(Boolean);
    warnings.push(`The list ${name ? `"${name}" ` : ''}mixes ${and(kinds as string[])}: ${and(where as string[])}.`);
  }
  return mapsToTable(flat, context, warnings, name);
}

const and = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join('');
const quoted = (names: string[]) => and(names.map(k => `"${k}"`));
const keptAs = (o: DataOptions, many: boolean) => o.arrays === 'json'
  ? `${many ? 'each is' : 'it is'} kept whole as JSON text in one cell`
  : `${many ? 'they are' : 'it is'} kept as numbered columns (name.0, name.1, ...)`;

/**
 * Finds the tables in a JSON value by the rules at the top of this file, and explains every choice that the shape
 * of the data left open: tables are never combined with each other (no row is a combination of two lists), lists
 * inside the rows are never expanded into more rows, and nothing is left out.
 */
function tablesOf(value: Json, o: DataOptions, warnings: string[], table: 'file' | 'sheet'): Table[] {
  const notes = newNotes();
  const tables = findTables(value, o, warnings, table, notes);
  if (notes.clashes.size) {
    const names = [...notes.clashes];
    warnings.push(`Two fields gave the same column name (${quoted(names.slice(0, 4))}${names.length > 4 ? ', ...' : ''}), as a key with a dot in its name does beside a nested field; the later one got a _2 suffix, so both values are kept.`);
  }
  if (notes.innerRecords.size) {
    const names = [...notes.innerRecords];
    warnings.push(`${quoted(names.slice(0, 4))}${names.length > 4 ? ', ...' : ''} ${names.length === 1 ? 'holds a list' : 'hold lists'} of records inside the rows. Rows come only from the top level, so ${names.length === 1 ? 'it was' : 'they were'} not expanded into more rows (which would repeat or multiply the rows around ${names.length === 1 ? 'it' : 'them'}); ${keptAs(o, names.length > 1)}.`);
  }
  return tables;
}

function findTables(value: Json, o: DataOptions, warnings: string[], table: 'file' | 'sheet', notes: FlatNotes): Table[] {
  const unit = table === 'sheet' ? 'sheet' : 'file';
  if (Array.isArray(value)) {
    if (value.length === 0) warnings.push('The list is empty, so the table has no rows.');
    return [tableOf(value, o, warnings, notes)];
  }
  if (!isObject(value)) {
    warnings.push(`The file holds a single ${value === null ? 'null' : 'value'}, not a list or an object, so it became one row with one column.`);
    return [tableOf([value], o, warnings, notes)];
  }
  const keys = Object.keys(value);
  const obj = value;
  if (keys.length === 0) {
    warnings.push('The file holds an empty object, so the table is empty.');
    return [{ header: [], rows: [] }];
  }
  const empty = keys.filter(k => Array.isArray(obj[k]) && (obj[k] as Json[]).length === 0);
  if (keys.length === 1 && Array.isArray(obj[keys[0]])) {
    warnings.push(empty.length ? `The only field, "${keys[0]}", is an empty list, so the table has no rows.` : `Used the "${keys[0]}" list as the rows.`);
    return [tableOf(obj[keys[0]] as Json[], o, warnings, notes)];
  }
  if (keys.length > 1 && keys.every(k => Array.isArray(obj[k]))) {
    warnings.push(`Each of the ${keys.length} lists became its own ${unit}; their rows are not combined with each other.`);
    if (empty.length) warnings.push(`${quoted(empty)} ${empty.length === 1 ? `is an empty list, so its ${unit} has` : `are empty lists, so their ${unit}s have`} no rows.`);
    return keys.map(k => tableOf(obj[k] as Json[], o, warnings, notes, new Map(), k));
  }
  const lists = keys.filter(k => isRecordList(obj[k]));
  const mixed = keys.filter(k => isMixedList(obj[k]));
  if (mixed.length) warnings.push(`${quoted(mixed)} ${mixed.length === 1 ? 'mixes' : 'mix'} records with other values, so ${mixed.length === 1 ? 'it was' : 'they were'} not used as rows; ${keptAs(o, mixed.length > 1)}.`);
  if (lists.length) {
    const context = new Map<string, Json>();
    for (const k of keys.filter(k => !lists.includes(k))) flattenValues(obj[k], o.arrays, context, notes, k);
    warnings.push(lists.length === 1
      ? `The rows are the records of the "${lists[0]}" list.`
      : `Each list of records (${quoted(lists)}) became its own ${unit}. Their rows are not combined with each other, since nothing says which record of one list goes with which record of another.`);
    if (context.size) warnings.push(`${context.size === 1 ? 'The other top-level field' : `The ${context.size.toLocaleString('en-US')} other top-level fields`} (${[...context.keys()].slice(0, 4).join(', ')}${context.size > 4 ? ', ...' : ''}) ${context.size === 1 ? 'is' : 'are'} repeated on every row, so nothing is lost.`);
    return lists.map(k => tableOf(obj[k] as Json[], o, warnings, notes, context, lists.length > 1 ? k : undefined));
  }
  warnings.push('The top level is a single object, so it became one row.');
  if (empty.length) warnings.push(`${quoted(empty)} ${empty.length === 1 ? 'is an empty list' : 'are empty lists'}, so there are no records to make rows from; ${empty.length === 1 ? 'it is' : 'they are'} written as [].`);
  return [tableOf([value], o, warnings, notes)];
}

/** CSV and TSV share one writer; TSV is the same format with tabs. */
type TextTable = 'csv' | 'tsv';
const TEXT_TABLE = { csv: { ext: 'csv', mime: 'text/csv' }, tsv: { ext: 'tsv', mime: 'text/tab-separated-values' } } as const;
const textOptions = (o: DataOptions, as: TextTable): DataOptions => as === 'tsv' ? { ...o, delimiter: '\t' } : o;
const formulaNote = (n: number) => `${plural(n, 'cell')} starting with = + - or @ got a leading apostrophe so spreadsheets do not run them as formulas. Turn off formula protection in Data settings to keep them exactly as they are.`;

function tablesToText(tables: Table[], o: DataOptions, as: TextTable, warnings: string[]): DataResult {
  const outputs: DataOutput[] = [];
  let neutralized = 0, rows = 0, columns = 0;
  for (const t of tables) {
    // A table with no columns writes nothing at all (an empty file), not a line with no fields.
    const cells: Cell[][] = t.header?.length ? [t.header.map(k => ({ text: k, isText: true }))] : [];
    for (const r of t.rows) cells.push(r.map(scalarText));
    const w = writeCsv(cells, textOptions(o, as));
    neutralized += w.neutralized;
    rows += t.rows.length;
    columns = Math.max(columns, cells.reduce((m, r) => Math.max(m, r.length), 0));
    outputs.push({ suffix: tables.length > 1 ? t.name : undefined, bytes: utf8(w.text), ...TEXT_TABLE[as] });
  }
  if (neutralized) warnings.push(formulaNote(neutralized));
  return {
    outputs,
    warnings,
    summary: tables.length > 1 ? `${plural(tables.length, 'table')}, ${plural(rows, 'row')}` : `${plural(rows, 'row')}, ${plural(columns, 'column')}`,
  };
}

/** Excel's limit on the text in one cell. */
const CELL_TEXT = 32767;

const sheetName = (base: string) => {
  const n = base.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31).trim();
  return n && n.toLowerCase() !== 'history' ? n : 'Sheet1';
};

/** Writes one worksheet from rows of JSON values. Returns counts for the notes. */
function tableSheet(t: Table, textNumbers: boolean): { ws: XLSX.WorkSheet; width: number; exactText: number; truncated: number; numbers: number } {
  const all: Json[][] = t.header ? [t.header, ...t.rows] : t.rows;
  if (all.length > LIMITS.xlsxRows) throw new LimitError(`The data has ${all.length.toLocaleString('en-US')} rows; Excel allows ${LIMITS.xlsxRows.toLocaleString('en-US')}.`);
  const width = all.reduce((m, r) => Math.max(m, r.length), 0);
  const ws: XLSX.WorkSheet = {};
  const colWidth: number[] = new Array(width).fill(6);
  let exactText = 0, truncated = 0, numbers = 0;
  all.forEach((r, ri) => r.forEach((v, ci) => {
    if (v === null || v === undefined) return;
    const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
    let cell: XLSX.CellObject;
    const n = textNumbers && typeof v === 'string' && !(t.header && ri === 0) ? numericValue(v) : null;
    if (typeof v === 'number') cell = { t: 'n', v };
    else if (n !== null) { cell = { t: 'n', v: n }; numbers++; }
    else if (typeof v === 'boolean') cell = { t: 'b', v };
    else if (typeof v === 'bigint') { cell = { t: 's', v: String(v) }; exactText++; }
    else {
      let s = typeof v === 'string' ? v : stringifyJson(v);
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
  return { ws, width, exactText, truncated, numbers };
}

/**
 * Tables to one XLSX workbook, one sheet per table. Numbers and true/false become typed cells; text is always stored
 * as text (never a formula); integers beyond what Excel can hold exactly are stored as text with every digit kept.
 * With `textNumbers` (XML, whose values are all text), text that is a plain number becomes a number cell.
 */
function tablesToXlsx(tables: Table[], baseName: string, warnings: string[], textNumbers = false): DataResult {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  let rows = 0, width = 0, exactText = 0, truncated = 0, numbers = 0;
  for (const t of tables) {
    const wanted = tables.length > 1 && t.name !== undefined ? t.name : baseName;
    let name = sheetName(wanted), n = 2;
    while (used.has(name.toLowerCase())) name = `${sheetName(wanted).slice(0, 27)} (${n++})`;
    used.add(name.toLowerCase());
    if (tables.length > 1 && name !== wanted) warnings.push(`The list "${wanted}" is on the sheet "${name}" (Excel sheet names are limited to 31 characters, without [ ] : * ? / \\).`);
    const r = tableSheet(t, textNumbers);
    XLSX.utils.book_append_sheet(wb, r.ws, name);
    rows += t.rows.length;
    width = Math.max(width, r.width);
    exactText += r.exactText;
    truncated += r.truncated;
    numbers += r.numbers;
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
  if (exactText) warnings.push(`${plural(exactText, 'integer')} larger than Excel can hold exactly ${exactText === 1 ? 'is' : 'are'} stored as text, with every digit kept.`);
  if (truncated) warnings.push(`${plural(truncated, 'cell')} longer than 32,767 characters, the Excel limit, were cut.`);
  if (textNumbers) warnings.push(`${plural(numbers, 'cell')} became numbers. Text such as dates, leading zeros (01234) and long digit strings stayed text.`);
  warnings.push(textNumbers
    ? 'Text, including dates written as text, stays text; text that starts with = is never stored as a formula.'
    : 'Numbers and true/false are typed cells. Text, including dates written as text, stays text; text that starts with = is never stored as a formula.');
  return {
    outputs: [{ bytes: new Uint8Array(out), ext: 'xlsx', mime: XLSX_MIME }],
    warnings,
    summary: tables.length > 1 ? `${plural(tables.length, 'sheet')}, ${plural(rows, 'row')}` : `${plural(rows, 'row')}, ${plural(width, 'column')}`,
  };
}

// ------------------------------------------------------------------ JSON and JSON Lines

const readJson = (bytes: Uint8Array, warnings: string[]) => parseJson(readText(bytes, warnings), warnings);

export function jsonToCsv(bytes: Uint8Array, o: DataOptions, as: TextTable = 'csv'): DataResult {
  const warnings: string[] = [];
  return tablesToText(tablesOf(readJson(bytes, warnings), o, warnings, 'file'), o, as, warnings);
}

export function jsonToXlsx(bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  const warnings: string[] = [];
  return tablesToXlsx(tablesOf(readJson(bytes, warnings), o, warnings, 'sheet'), baseName, warnings);
}

/** JSON to JSON Lines: a list gives one line per item; an object holding one list, one line per item of it. */
export function jsonToJsonl(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const value = readJson(bytes, warnings);
  let items: Json[];
  if (Array.isArray(value)) items = value;
  else {
    const keys = value !== null && typeof value === 'object' ? Object.keys(value) : [];
    const only = keys.length === 1 ? (value as Record<string, Json>)[keys[0]] : undefined;
    if (Array.isArray(only)) {
      items = only;
      warnings.push(`Used the "${keys[0]}" list: one line per item.`);
    } else {
      items = [value];
      warnings.push('The JSON is not a list, so it became a single line.');
    }
  }
  return { outputs: [{ bytes: utf8(writeJsonLines(items)), ...JSONL_OUT }], warnings, summary: plural(items.length, 'line') };
}

const readJsonl = (bytes: Uint8Array, warnings: string[]) => readJsonLines(readText(bytes, warnings), warnings);

export function jsonlToJson(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const values = readJsonl(bytes, warnings);
  return { outputs: [{ bytes: utf8(stringifyJson(values, 2) + '\n'), ...JSON_OUT }], warnings, summary: `A list of ${plural(values.length, 'value')}` };
}

export function jsonlToCsv(bytes: Uint8Array, o: DataOptions, as: TextTable = 'csv'): DataResult {
  const warnings: string[] = [];
  return tablesToText(tablesOf(readJsonl(bytes, warnings), o, warnings, 'file'), o, as, warnings);
}

export function jsonlToXlsx(bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  const warnings: string[] = [];
  return tablesToXlsx(tablesOf(readJsonl(bytes, warnings), o, warnings, 'sheet'), baseName, warnings);
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
  const parsed = parseCsv(readText(bytes, warnings), o.inputDelimiter, LIMITS.csvCells);
  warnings.push(...parsed.warnings);
  return parsed;
}

const delimiterName = (d: string) => d === ',' ? 'commas' : d === ';' ? 'semicolons' : d === '\t' ? 'tabs' : d === '|' ? 'pipes' : `"${d}"`;

/** CSV or TSV rows as JSON values: records named by the header row, or lists without one. */
function csvRecords(bytes: Uint8Array, o: DataOptions, warnings: string[]): Json[] {
  const { rows, delimiter } = readCsvInput(bytes, o, warnings);
  if (rows.length === 0) throw new Error('The CSV file is empty.');
  if (o.inputDelimiter === 'auto' && rows.some(r => r.length > 1)) warnings.push(`Fields are separated by ${delimiterName(delimiter)}.`);
  if (!o.header) return rows.map(r => r.map(s => typed(s, o.detectTypes)));
  const { names, renamed } = headerNames(rows[0]);
  if (renamed) warnings.push(`${plural(renamed, 'column')} with an empty or repeated name got a new name, like column_3 or name_2.`);
  let ragged = 0;
  let out: Json[] = rows.slice(1).map(r => {
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
  return out;
}

export function csvToJson(bytes: Uint8Array, o: DataOptions): DataResult {
  const warnings: string[] = [];
  const out = csvRecords(bytes, o, warnings);
  return { outputs: [{ bytes: utf8(stringifyJson(out, 2) + '\n'), ...JSON_OUT }], warnings, summary: plural(out.length, o.header ? 'record' : 'row') };
}

export function csvToJsonl(bytes: Uint8Array, o: DataOptions): DataResult {
  const warnings: string[] = [];
  const out = csvRecords(bytes, o, warnings);
  return { outputs: [{ bytes: utf8(writeJsonLines(out)), ...JSONL_OUT }], warnings, summary: plural(out.length, 'line') };
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
        if (v.length > CELL_TEXT) { v = v.slice(0, CELL_TEXT); truncated++; }
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
    outputs: [{ bytes: new Uint8Array(out), ext: 'xlsx', mime: XLSX_MIME }],
    warnings,
    summary: `${plural(rows.length, 'row')}, ${plural(width, 'column')}`,
  };
}

// ------------------------------------------------------------------ spreadsheets (XLSX, XLS, ODS)

export function xlsxSheetNames(bytes: Uint8Array, kind: WorkbookKind = 'xlsx'): string[] {
  return workbookSheetNames(bytes, kind);
}

function chooseSheets(wb: XLSX.WorkBook, o: DataOptions, warnings: string[]): string[] {
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
  return names;
}

/** A number in the General format, as text: up to 15 significant digits, Excel's precision, never cut to fit a column. */
export function generalNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  // Past 15 digits Excel shows E notation, so a rounded value never passes for an exact one.
  if (Math.abs(n) >= 1e15) return n.toExponential(14).replace(/\.?0+e/, 'e').replace('e', 'E');
  return String(Number(n.toPrecision(15))).replace('e', 'E');
}

/** One spreadsheet cell as CSV text: as shown (with General numbers in full), or the value the workbook stores. */
function csvCell(c: XLSX.CellObject | undefined, values: DataOptions['values']): Cell {
  if (!c || c.t === 'z' || c.v === undefined || c.v === null) return { text: '', isText: false };
  if (c.t === 'e') return { text: c.w ?? '#ERROR', isText: false };
  if (c.t === 'b') return { text: c.v ? 'TRUE' : 'FALSE', isText: false };
  if (values === 'raw') {
    if (c.t === 'n') return { text: String(c.v), isText: false };
    if (c.v instanceof Date) return { text: c.v.toISOString(), isText: false };
    return { text: String(c.v), isText: true };
  }
  if (c.t === 'n') return { text: c.w ?? XLSX.utils.format_cell(c), isText: false };
  return { text: c.w ?? String(c.v), isText: true };
}

const isGeneral = (z: unknown) => z === undefined || z === null || (typeof z === 'string' && /^general$/i.test(z));

export function xlsxToCsv(bytes: Uint8Array, o: DataOptions, as: TextTable = 'csv', kind: WorkbookKind = 'xlsx'): DataResult {
  const warnings: string[] = [];
  const { wb, macros } = readWorkbook(bytes, kind, { dense: true, cellFormula: true, cellNF: true, cellHTML: false, cellText: true, cellDates: false, cellStyles: false, sheetStubs: true });
  const names = chooseSheets(wb, o, warnings);
  const outputs: DataOutput[] = [];
  let totalRows = 0, neutralizedTotal = 0;
  for (const name of names) {
    const ws = wb.Sheets[name];
    const idx = wb.SheetNames.indexOf(name);
    if (wb.Workbook?.Sheets?.[idx]?.Hidden) warnings.push(`Sheet "${name}" is hidden in Excel.`);
    let missing = 0;
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    const dense = (ws as unknown as { '!data'?: XLSX.CellObject[][] })['!data'];
    if (dense) for (const row of dense) for (const c of row ?? []) {
      if (!c) continue;
      if (c.f && (c.t === 'z' || c.v === undefined)) missing++;
      // A number in the General format is written with every digit Excel keeps, not cut short to an 11-character
      // column the way Excel's display (and its own CSV export) can show 123456789012345 as 1.23457E+14.
      else if (c.t === 'n' && typeof c.v === 'number' && isGeneral(c.z)) c.w = generalNumber(c.v);
    }
    if (missing) warnings.push(`${plural(missing, 'formula cell')} in "${name}" ${missing === 1 ? 'has' : 'have'} no saved result and ${missing === 1 ? 'is' : 'are'} empty. Open and save the workbook in Excel to store the results.`);
    if (ws['!merges']?.length) warnings.push(`"${name}" has merged cells; their value is in the first cell only.`);
    // Every row gets the sheet's full width, so the CSV is rectangular even where cells are missing. Cells are read
    // directly: for XLS files SheetJS's sheet_to_json gives raw date cells as JavaScript dates in the local time zone.
    const table: Cell[][] = [];
    if (range) {
      for (let r = range.s.r; r <= range.e.r; r++) {
        const row: Cell[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) row.push(csvCell(dense?.[r]?.[c], o.values));
        table.push(row);
      }
    }
    while (table.length && table[table.length - 1].every(c => c.text === '')) table.pop();
    const { text, neutralized } = writeCsv(table, textOptions(o, as));
    neutralizedTotal += neutralized;
    totalRows += table.length;
    outputs.push({ suffix: names.length > 1 || o.sheet !== 'first' ? name : undefined, bytes: utf8(text), ...TEXT_TABLE[as] });
  }
  if (outputs.length === 1 && o.sheet !== 'all') outputs[0].suffix = undefined;
  if (neutralizedTotal) warnings.push(formulaNote(neutralizedTotal));
  if (o.values === 'formatted') warnings.push('Values are written as Excel displays them (dates and number formats applied); numbers in the General format keep their 15 significant digits rather than being cut to fit a column.');
  if (macros) warnings.push('The workbook contains macros. They were not read or run.');
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
 * A workbook's sheets as JSON values. JSON keeps types: numbers stay numbers (exactly as the workbook stores them),
 * TRUE and FALSE become true and false, empty cells become null, and cells with a date format become ISO 8601 text.
 * With a header row each row is an object; without one, a list.
 */
function workbookRecords(bytes: Uint8Array, o: DataOptions, kind: WorkbookKind, warnings: string[]): { names: string[]; sheets: Record<string, Json[]>; total: number } {
  const { wb, macros } = readWorkbook(bytes, kind, { dense: true, cellFormula: true, cellNF: true, cellHTML: false, cellText: true, cellDates: false, cellStyles: false, sheetStubs: true });
  const date1904 = !!(wb.Workbook as { WBProps?: { date1904?: boolean } } | undefined)?.WBProps?.date1904;
  const names = chooseSheets(wb, o, warnings);
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
  if (macros) warnings.push('The workbook contains macros. They were not read or run.');
  return { names, sheets, total };
}

export function xlsxToJson(bytes: Uint8Array, o: DataOptions, kind: WorkbookKind = 'xlsx'): DataResult {
  const warnings: string[] = [];
  const { names, sheets, total } = workbookRecords(bytes, o, kind, warnings);
  const doc: Json = o.sheet === 'all' ? sheets : sheets[names[0]];
  return {
    outputs: [{ bytes: utf8(JSON.stringify(doc, null, 2) + '\n'), ...JSON_OUT }],
    warnings,
    summary: names.length > 1 ? `${plural(names.length, 'sheet')}, ${plural(total, o.header ? 'record' : 'row')}` : plural(total, o.header ? 'record' : 'row'),
  };
}

/** A workbook to JSON Lines: one line per row, and one file per sheet when there are several. */
export function xlsxToJsonl(bytes: Uint8Array, o: DataOptions, kind: WorkbookKind = 'xlsx'): DataResult {
  const warnings: string[] = [];
  const { names, sheets, total } = workbookRecords(bytes, o, kind, warnings);
  const outputs: DataOutput[] = names.map(n => ({ suffix: names.length > 1 || o.sheet === 'all' ? n : undefined, bytes: utf8(writeJsonLines(sheets[n])), ...JSONL_OUT }));
  if (outputs.length === 1 && o.sheet !== 'all') outputs[0].suffix = undefined;
  return { outputs, warnings, summary: names.length > 1 ? `${plural(names.length, 'sheet')}, ${plural(total, 'line')}` : plural(total, 'line') };
}

// ------------------------------------------------------------------ YAML

/** A stack overflow, as Chrome and Edge (RangeError, "Maximum call stack") and Firefox ("too much recursion") report it. */
const tooDeep = (e: unknown) => e instanceof RangeError || /call stack|too much recursion/i.test(String((e as Error)?.message ?? e));

/**
 * Nesting of YAML flow collections ([ ] and { }) outside quoted text and comments, measured before parsing so a deep
 * one is refused the same way in every browser. Nesting by indentation is caught by tooDeep while parsing.
 */
export function yamlFlowDepth(text: string): number {
  let depth = 0, max = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) { if (quote === "'" && text[i + 1] === "'") i++; else quote = ''; }
      else if (c === '\\' && quote === '"') i++;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t' || text[i - 1] === '\n')) {
      const end = text.indexOf('\n', i);
      if (end < 0) break;
      i = end;
    } else if (c === '[' || c === '{') { if (++depth > max) max = depth; }
    else if ((c === ']' || c === '}') && depth > 0) depth--;
  }
  return max;
}

/**
 * Parses YAML with the core schema: no custom tags are resolved or run (an unknown tag such as !!python/object is a
 * warning and its value stays plain data), keys must be unique, merge keys (<<) work, aliases may not expand far
 * beyond the file's size (billion laughs), and nesting is limited. Several documents become a list of them.
 */
function parseYaml(text: string, warnings: string[]): { value: Json; documents: number } {
  const depth = yamlFlowDepth(text);
  if (depth > LIMITS.dataDepth) throw new LimitError(`The YAML is nested ${depth} levels deep; the limit is ${LIMITS.dataDepth}.`);
  let list;
  try {
    list = parseAllDocuments(text, { prettyErrors: true, uniqueKeys: true, merge: true, schema: 'core' });
  } catch (e) {
    if (tooDeep(e)) throw new LimitError(`The YAML is nested too deeply to read; the limit is ${LIMITS.dataDepth} levels.`);
    throw e;
  }
  const docs = Array.isArray(list) ? list : [list];
  const values: unknown[] = [];
  for (const doc of docs) {
    if (doc.errors.length) {
      if (tooDeep(doc.errors[0])) throw new LimitError(`The YAML is nested too deeply to read; the limit is ${LIMITS.dataDepth} levels.`);
      throw new Error(`This is not valid YAML: ${doc.errors[0].message.split('\n')[0]}`);
    }
    for (const w of doc.warnings) warnings.push(w.message.split('\n')[0]);
    try {
      values.push(doc.toJS({ maxAliasCount: 100 }));
    } catch (e) {
      if (/alias/i.test((e as Error).message)) throw new LimitError('The YAML uses aliases to expand far beyond its size (a "billion laughs" pattern), so it was not converted.');
      if (tooDeep(e)) throw new LimitError(`The YAML is nested too deeply to read; the limit is ${LIMITS.dataDepth} levels.`);
      throw e;
    }
  }
  if (values.length === 0) throw new Error('The YAML file has no documents.');
  if (values.length > 1) warnings.push(`The file has ${values.length} YAML documents; together they are a list of them.`);
  let nonFinite = 0, other = 0;
  const clean = (v: unknown, depth: number): Json => {
    if (depth > LIMITS.dataDepth) throw new LimitError(`The data is nested more than ${LIMITS.dataDepth} levels deep, the limit.`);
    if (typeof v === 'number' && !Number.isFinite(v)) { nonFinite++; return null; }
    if (v === undefined) { other++; return null; }
    if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
    if (v instanceof Uint8Array || v instanceof Date || v instanceof Map || v instanceof Set) { other++; return String(v); }
    if (v !== null && typeof v === 'object') {
      const o: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) o[k] = clean(x, depth + 1);
      return o;
    }
    return v as Json;
  };
  const value = clean(values.length === 1 ? values[0] : values, 0);
  if (nonFinite) warnings.push(`${plural(nonFinite, 'value')} (.inf or .nan) cannot exist in JSON and became null.`);
  if (other) warnings.push(`${plural(other, 'value')} with no JSON equivalent became text or null.`);
  return { value, documents: values.length };
}

export function jsonToYaml(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const value = readJson(bytes, warnings);
  // YAML 1.1 quoting rules: strings such as yes, no, on, 2026-11-15 or 1:20 are quoted, so YAML 1.1 readers
  // (PyYAML, older tools) do not turn them into booleans, dates or numbers. The result is valid YAML 1.2 too.
  const text = yamlStringify(value, { version: '1.1', indent: 2, lineWidth: 0, minContentWidth: 0, aliasDuplicateObjects: false });
  return { outputs: [{ bytes: utf8(text), ext: 'yaml', mime: 'application/yaml' }], warnings, summary: 'YAML document' };
}

export function yamlToJson(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const { value, documents } = parseYaml(readText(bytes, warnings), warnings);
  return { outputs: [{ bytes: utf8(stringifyJson(value, 2) + '\n'), ...JSON_OUT }], warnings, summary: documents > 1 ? plural(documents, 'document') : 'JSON document' };
}

/** YAML tables: several documents that are all lists are one table of all their items; otherwise the JSON rules. */
function yamlTables(bytes: Uint8Array, o: DataOptions, warnings: string[], table: 'file' | 'sheet'): Table[] {
  const { value, documents } = parseYaml(readText(bytes, warnings), warnings);
  if (documents > 1 && Array.isArray(value) && value.every(d => Array.isArray(d))) {
    warnings.push(`The items of the ${documents} documents' lists are one table.`);
    return tablesOf((value as Json[][]).flat(), o, warnings, table);
  }
  return tablesOf(value, o, warnings, table);
}

export function yamlToCsv(bytes: Uint8Array, o: DataOptions, as: TextTable = 'csv'): DataResult {
  const warnings: string[] = [];
  return tablesToText(yamlTables(bytes, o, warnings, 'file'), o, as, warnings);
}

export function yamlToXlsx(bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  const warnings: string[] = [];
  return tablesToXlsx(yamlTables(bytes, o, warnings, 'sheet'), baseName, warnings);
}

// ------------------------------------------------------------------ XML

export function xmlToJson(bytes: Uint8Array): DataResult {
  const warnings: string[] = [];
  const value = parseXml(readText(bytes, warnings), warnings);
  warnings.push('Attributes are keys starting with @, element text is #text, and repeated elements became lists. All values are kept as text.');
  return { outputs: [{ bytes: utf8(JSON.stringify(value, null, 2) + '\n'), ...JSON_OUT }], warnings, summary: 'JSON document' };
}

/** XML tables by the rules in ./xml.ts: one table per repeated element, with what sits beside the records repeated. */
function xmlTablesOf(bytes: Uint8Array, o: DataOptions, warnings: string[]): Table[] {
  const tree = parseXml(readText(bytes, warnings), warnings);
  const { tables, context } = xmlTables(tree, o.arrays, warnings);
  if (tables.length > 1) warnings.push(`Each repeated element (${tables.map(t => `<${t.name}>`).join(', ')}) became its own table.`);
  else if (tables[0].records.length > 1) warnings.push(`Each <${tables[0].name}> element is one row.`);
  if (context.size) warnings.push(`What sits beside the records (${[...context.keys()].slice(0, 4).join(', ')}${context.size > 4 ? ', ...' : ''}) is repeated on every row, so nothing is lost.`);
  warnings.push('Attributes and child elements are columns by name, nested elements are dotted columns, and an element repeated inside a record is ' + (o.arrays === 'json' ? 'a JSON list in one cell.' : 'numbered columns (tag.0, tag.1).'));
  return tables.map(t => mapsToTable(t.records.map(r => flattenXmlRecord(r, o.arrays, t.name)), context, warnings, tables.length > 1 ? t.name : undefined));
}

export function xmlToCsv(bytes: Uint8Array, o: DataOptions, as: TextTable = 'csv'): DataResult {
  const warnings: string[] = [];
  return tablesToText(xmlTablesOf(bytes, o, warnings), o, as, warnings);
}

export function xmlToXlsx(bytes: Uint8Array, o: DataOptions, baseName: string): DataResult {
  const warnings: string[] = [];
  return tablesToXlsx(xmlTablesOf(bytes, o, warnings), baseName, warnings, o.detectTypes);
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
  const value = readJson(bytes, warnings);
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
    case 'json>jsonl': return jsonToJsonl(bytes);
    case 'jsonl>json': return jsonlToJson(bytes);
    case 'jsonl>csv': return jsonlToCsv(bytes, o);
    case 'jsonl>tsv': return jsonlToCsv(bytes, o, 'tsv');
    case 'jsonl>xlsx': return jsonlToXlsx(bytes, o, baseName);
    case 'csv>json': return csvToJson(bytes, o);
    case 'csv>jsonl': return csvToJsonl(bytes, o);
    case 'csv>xlsx': return csvToXlsx(bytes, o, baseName);
    case 'csv>tsv': return retabulate(bytes, o, 'tsv');
    case 'tsv>json': return csvToJson(bytes, tsvInput(o));
    case 'tsv>jsonl': return csvToJsonl(bytes, tsvInput(o));
    case 'tsv>xlsx': return csvToXlsx(bytes, tsvInput(o), baseName);
    case 'tsv>csv': return retabulate(bytes, tsvInput(o), 'csv');
    case 'yaml>json': return yamlToJson(bytes);
    case 'yaml>csv': return yamlToCsv(bytes, o);
    case 'yaml>tsv': return yamlToCsv(bytes, o, 'tsv');
    case 'yaml>xlsx': return yamlToXlsx(bytes, o, baseName);
    case 'xml>json': return xmlToJson(bytes);
    case 'xml>csv': return xmlToCsv(bytes, o);
    case 'xml>tsv': return xmlToCsv(bytes, o, 'tsv');
    case 'xml>xlsx': return xmlToXlsx(bytes, o, baseName);
  }
  if (from === 'xlsx' || from === 'xls' || from === 'ods') {
    switch (to) {
      case 'csv': return xlsxToCsv(bytes, o, 'csv', from);
      case 'tsv': return xlsxToCsv(bytes, o, 'tsv', from);
      case 'json': return xlsxToJson(bytes, o, from);
      case 'jsonl': return xlsxToJsonl(bytes, o, from);
      case 'xlsx': if (from !== 'xlsx') return workbookToXlsx(bytes, from); break;
    }
  }
  throw new Error(`No data conversion from ${from} to ${to}.`);
}
