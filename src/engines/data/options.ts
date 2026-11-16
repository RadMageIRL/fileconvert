// Options and result shapes for the data engine, kept apart from it so the page can use them without
// loading the parsers.

import type { Delimiter } from './csv';

export interface DataOptions {
  /** CSV output. */
  delimiter: Delimiter;
  bom: boolean;
  neutralizeFormulas: boolean;
  /** JSON to CSV: arrays inside records become JSON text in one cell, or numbered columns. */
  arrays: 'json' | 'columns';
  /** CSV input. */
  inputDelimiter: 'auto' | Delimiter;
  header: boolean;
  detectTypes: boolean;
  nest: boolean;
  /** XLSX input. */
  sheet: 'first' | 'all' | { name: string };
  values: 'formatted' | 'raw';
}

export const DEFAULT_DATA_OPTIONS: DataOptions = {
  delimiter: ',',
  bom: true,
  neutralizeFormulas: true,
  arrays: 'json',
  inputDelimiter: 'auto',
  header: true,
  detectTypes: true,
  nest: false,
  sheet: 'first',
  values: 'formatted',
};

export interface DataOutput {
  /** Appended to the base name, for one file per worksheet. */
  suffix?: string;
  bytes: Uint8Array;
  ext: string;
  mime: string;
}

export interface DataResult {
  outputs: DataOutput[];
  warnings: string[];
  /** A short description of the result for the queue row, like "3 rows, 7 columns". */
  summary: string;
}
