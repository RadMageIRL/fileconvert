// CSV reading and writing. Writing follows RFC 4180 (CRLF, fields quoted when they hold the delimiter, a
// quote or a line break). Spreadsheet formula protection prefixes risky text cells with an apostrophe,
// the OWASP recommendation, so opening the CSV in Excel or Sheets cannot run a formula.

import Papa from 'papaparse';

export type Delimiter = ',' | ';' | '\t' | '|';

export interface CsvWriteOptions {
  delimiter: Delimiter;
  bom: boolean;
  neutralizeFormulas: boolean;
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** True when a text cell would be read as a formula by a spreadsheet. Plain numbers like -5 are not. */
export function isRiskyCell(s: string): boolean {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s.trim());
}

export interface Cell {
  text: string;
  /** Text cells are protected against formulas; numbers and booleans written by FileConvert are not text. */
  isText: boolean;
}

export function writeCsv(rows: Cell[][], opts: CsvWriteOptions): { text: string; neutralized: number } {
  let neutralized = 0;
  const d = opts.delimiter;
  const out: string[] = [];
  for (const row of rows) {
    const fields = row.map(cell => {
      let s = cell.text;
      if (opts.neutralizeFormulas && cell.isText && isRiskyCell(s)) {
        s = "'" + s;
        neutralized++;
      }
      if (s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    });
    out.push(fields.join(d));
  }
  const text = (opts.bom ? '\ufeff' : '') + out.join('\r\n') + (out.length ? '\r\n' : '');
  return { text, neutralized };
}

export interface ParsedCsv {
  rows: string[][];
  delimiter: string;
  warnings: string[];
}

export function parseCsv(text: string, delimiter: 'auto' | Delimiter, maxCells: number): ParsedCsv {
  const warnings: string[] = [];
  const res = Papa.parse<string[]>(text.replace(/^\ufeff/, ''), {
    delimiter: delimiter === 'auto' ? '' : delimiter,
    delimitersToGuess: [',', ';', '\t', '|'],
    skipEmptyLines: 'greedy',
    header: false,
    dynamicTyping: false,
  });
  let cells = 0;
  for (const r of res.data) {
    cells += r.length;
    if (cells > maxCells) throw new Error(`The CSV has more than ${maxCells.toLocaleString('en-US')} cells, the limit.`);
  }
  const seen = new Set<string>();
  for (const e of res.errors) {
    const key = e.code;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.code === 'UndetectableDelimiter') continue; // a one-column file
    const row = typeof e.row === 'number' ? ` (row ${e.row + 1})` : '';
    if (e.code === 'MissingQuotes') warnings.push(`A quoted field is never closed${row}; the rest of the file was read as one field.`);
    else if (e.code === 'InvalidQuotes') warnings.push(`A field has stray quote marks${row}; it was read as written.`);
    else warnings.push(`${e.message}${row}.`);
  }
  return { rows: res.data, delimiter: res.meta.delimiter, warnings };
}

/** A number written the way people write numbers in data, with no leading zeros and at most 15 significant digits. */
const STRICT_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export function numericValue(s: string): number | null {
  if (!STRICT_NUMBER.test(s)) return null;
  const digits = s.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '');
  if (digits.length > 15) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function booleanValue(s: string): boolean | null {
  if (s === 'true' || s === 'TRUE' || s === 'True') return true;
  if (s === 'false' || s === 'FALSE' || s === 'False') return false;
  return null;
}
