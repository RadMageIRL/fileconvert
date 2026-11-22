// Spreadsheet workbooks read by SheetJS: XLSX, XLS (Excel 97-2003 and 5.0/95, an OLE compound file) and ODS
// (OpenDocument, a ZIP package). Every one is checked before SheetJS sees it: the size limit, ZIP bombs in XLSX and
// ODS, and the compound file's streams in XLS. Macros are never read or run, and a workbook that needs a password
// is refused with a clear message.

import * as XLSX from 'xlsx';
import { LIMITS, LimitError } from '../../core/limits';
import { checkZip } from '../../core/zipcheck';
import { plural } from './json';
import { keepAstralCharacters } from './xlsxtext';
import type { DataResult } from './options';

export type WorkbookKind = 'xlsx' | 'xls' | 'ods';

export const WORKBOOK_LABEL: Record<WorkbookKind, string> = { xlsx: 'Excel workbook', xls: 'Excel 97-2003 workbook', ods: 'OpenDocument spreadsheet' };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Streams in an XLS compound file that hold macros or other programs. */
const MACRO_STREAMS = /(^|\/)(_VBA_PROJECT_CUR|VBA|_VBA_PROJECT|Macros)(\/|$)/i;

interface Checked {
  bytes: Uint8Array;
  macros: boolean;
}

function check(bytes: Uint8Array, kind: WorkbookKind): Checked {
  if (bytes.length > LIMITS.xlsxBytes) throw new LimitError(`The workbook is larger than ${LIMITS.xlsxBytes / 1048576} MB, the limit.`);
  if (kind === 'xls') {
    let paths: string[];
    try {
      paths = XLSX.CFB.read(bytes, { type: 'array' }).FullPaths;
    } catch (e) {
      throw new Error(`This XLS file is damaged: ${(e as Error).message}`);
    }
    if (!paths.some(p => /(^|\/)(Workbook|Book)$/.test(p))) throw new Error('This is an Office file but not an Excel workbook (it has no Workbook stream). Word (DOC) and PowerPoint (PPT) files are not supported.');
    if (paths.some(p => /(^|\/)EncryptionInfo$/.test(p))) throw new Error('This workbook is protected with a password. Remove the password in Excel and try again.');
    return { bytes, macros: paths.some(p => MACRO_STREAMS.test(p)) };
  }
  const entries = checkZip(bytes, 'workbook');
  if (kind === 'ods') {
    if (!entries.some(e => e.name === 'content.xml')) throw new Error('This is not an OpenDocument spreadsheet (content.xml is missing).');
    return { bytes, macros: entries.some(e => /^Basic\/|^Scripts\//.test(e.name)) };
  }
  return { bytes: keepAstralCharacters(bytes), macros: entries.some(e => /^xl\/vbaProject\.bin$/i.test(e.name)) };
}

function friendly(e: unknown, kind: WorkbookKind): Error {
  const msg = (e as Error).message || String(e);
  if (/password|encrypt/i.test(msg)) return new Error('This workbook is protected with a password. Remove the password and try again.');
  return new Error(`The ${kind === 'xls' ? 'XLS' : kind === 'ods' ? 'ODS' : ''} workbook could not be read: ${msg}`.replace('The  workbook', 'The workbook'));
}

export interface ReadWorkbook {
  wb: XLSX.WorkBook;
  macros: boolean;
}

/** Reads a workbook for its cell values (CSV, TSV, JSON, JSON Lines). */
export function readWorkbook(bytes: Uint8Array, kind: WorkbookKind, opts: XLSX.ParsingOptions): ReadWorkbook {
  const c = check(bytes, kind);
  try {
    return { wb: XLSX.read(c.bytes, { ...opts, type: 'array', bookVBA: false, WTF: false }), macros: c.macros };
  } catch (e) {
    throw friendly(e, kind);
  }
}

export function workbookSheetNames(bytes: Uint8Array, kind: WorkbookKind): string[] {
  const c = check(bytes, kind);
  try {
    return XLSX.read(c.bytes, { type: 'array', bookSheets: true }).SheetNames;
  } catch (e) {
    throw friendly(e, kind);
  }
}

/** True for LibreOffice's way of storing TRUE and FALSE in XLS and ODS: as the formulas =TRUE() and =FALSE(). */
const BOOLEAN_FORMULA = /^(true|false)(\(\))?$/i;

/**
 * XLS or ODS to XLSX. What SheetJS reads from the file is written as a new XLSX workbook: every sheet, its values,
 * formulas with their saved results, number formats (so dates stay dates), merged cells, column widths (XLS) and
 * hidden sheets (XLS). Formatting such as fonts, colors and borders, and charts, pictures and macros are not part of
 * what is read, so they are not in the result; the notes say so.
 */
export function workbookToXlsx(bytes: Uint8Array, kind: 'xls' | 'ods'): DataResult {
  const warnings: string[] = [];
  // Sparse sheets: SheetJS 0.20.3 cannot write a dense sheet that has an empty row.
  const { wb, macros } = readWorkbook(bytes, kind, { dense: false, cellFormula: true, cellNF: true, cellStyles: true, cellDates: false, cellText: false, cellHTML: false, sheetStubs: false });
  if (!wb.SheetNames.length) throw new Error('The workbook has no worksheets.');
  let formulas = 0, merges = 0, cells = 0, booleans = 0, comments = 0, outlined = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const c = ws[addr] as XLSX.CellObject;
      cells++;
      // Comments are left out on purpose, so the note below is true for every workbook.
      if (c.c) { delete c.c; comments++; }
      if (c.t === 'b' && typeof c.f === 'string' && BOOLEAN_FORMULA.test(c.f)) { delete c.f; booleans++; continue; }
      if (c.f) formulas++;
    }
    merges += ws['!merges']?.length ?? 0;
    // SheetJS 0.20.3 writes a column's outline level twice, once as a "level" attribute that is not part of the
    // format (openpyxl refuses the file, and Excel would have to repair it), so it is taken out before writing.
    for (const col of ws['!cols'] ?? []) {
      if (!col) continue;
      const c = col as { level?: number };
      if (c.level) outlined++;
      delete c.level;
    }
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    if (range && (range.e.r >= LIMITS.xlsxRows || range.e.c >= LIMITS.xlsxColumns)) throw new LimitError(`Sheet "${name}" is larger than Excel allows (${LIMITS.xlsxRows.toLocaleString('en-US')} rows, ${LIMITS.xlsxColumns.toLocaleString('en-US')} columns).`);
  }
  const hidden = (wb.Workbook?.Sheets ?? []).filter(s => s.Hidden).length;
  let out: ArrayBuffer;
  try {
    out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true, cellStyles: true }) as ArrayBuffer;
  } catch (e) {
    throw new Error(`The XLSX workbook could not be written: ${(e as Error).message}`);
  }
  const kept = [`${plural(wb.SheetNames.length, 'sheet')}`, `${plural(cells, 'cell')} with their values and number formats (dates stay dates)`];
  if (formulas) kept.push(`${plural(formulas, 'formula')} with ${formulas === 1 ? 'its' : 'their'} saved ${formulas === 1 ? 'result' : 'results'}`);
  if (merges) kept.push(`${plural(merges, 'merged range')}`);
  if (hidden) kept.push(`${plural(hidden, 'hidden sheet')}, still hidden`);
  warnings.push(`Kept: ${kept.join(', ')}.`);
  if (booleans) warnings.push(`${plural(booleans, 'TRUE or FALSE value')} stored as the formulas =TRUE() or =FALSE() (as LibreOffice does) ${booleans === 1 ? 'is' : 'are'} plain TRUE or FALSE now.`);
  warnings.push(kind === 'xls'
    ? 'Not kept: fonts, colors, borders and other cell formatting, charts, pictures, comments and macros. Check the result in Excel before replacing the original.'
    : 'Not kept: fonts, colors, borders and other cell formatting, column widths, which sheets are hidden, charts, pictures, comments and macros. Check the result in Excel before replacing the original.');
  if (comments) warnings.push(`${plural(comments, 'cell comment')} left out.`);
  if (outlined) warnings.push(`${plural(outlined, 'column')} grouped in an outline ${outlined === 1 ? 'is' : 'are'} no longer grouped.`);
  if (macros) warnings.push('The workbook contains macros. They were not read or run, and are not in the result.');
  return {
    outputs: [{ bytes: new Uint8Array(out), ext: 'xlsx', mime: XLSX_MIME }],
    warnings,
    summary: `${plural(wb.SheetNames.length, 'sheet')}, ${plural(cells, 'cell')}`,
  };
}
