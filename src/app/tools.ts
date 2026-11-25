// The contract for tools: work that takes a set of files, often in a chosen order, and makes one result or a
// few (merge PDFs, images to PDF, split a PDF). The converter queue handles one file to one format; tools get the
// workspace (./workspace.ts), which owns the file list, its order, the options, progress, cancel, the result
// names and the downloads. A tool only says what it accepts and how to run, so every tool behaves the same way.

import type { FormatId } from '../core/formats';
import type { ImageWork, PdfWork } from '../core/pdfmemory';
import type { Engines } from './jobs';

/** A file in the workspace that the tool accepts. */
export interface ToolInput {
  id: number;
  file: File;
  name: string;
  /** The format found in the file's bytes, not its name. */
  format: FormatId;
  /** Pages, when the tool's inspect found them (PDF tools). */
  pages?: number;
  /** What the PDF guard counted in the file, for the memory admission check (PDF tools). */
  work?: PdfWork;
  /** What a picture's header says it costs, for the memory admission check (Images to PDF). */
  image?: ImageWork;
}

/** What a tool's inspect found about one file. */
export interface ToolInspection {
  /** Added to the file's line: "12 pages". */
  info?: string;
  pages?: number;
  /** What the PDF guard counted (PDF tools). */
  work?: PdfWork;
  /** What a picture's header says it costs (Images to PDF). */
  image?: ImageWork;
  /** Shown under the file. */
  note?: string;
  /** Why the tool cannot use the file; it stays listed but is never passed to the tool. */
  error?: string;
  /** A warning the person has to accept (the tool's confirmLabel) before the tool runs with this file. */
  confirm?: string;
}

/** What every option may have: a line of help under it, and a condition on another option for being shown. */
interface OptionBase {
  key: string;
  label: string;
  hint?: string;
  /** Shown only while the select option `key` has this value, or one of these values. */
  showIf?: { key: string; value: string | readonly string[] };
}

export type ToolOption =
  | OptionBase & { kind: 'select'; value: string; choices: ReadonlyArray<readonly [string, string]> }
  | OptionBase & { kind: 'number'; value: number; min: number; max: number; step?: number; unit?: string }
  | OptionBase & { kind: 'check'; value: boolean }
  | OptionBase & { kind: 'text'; value: string; placeholder?: string; maxLength?: number }
  /** A new order for the pages of the one file the tool takes: a list to drag or move with buttons, and the same order
   *  as text ("3, 1, 2, 4-10", or "10-1" for every page in reverse). Once the file's pages are known the value is the
   *  order itself, a list of page numbers from 1 (every page in order to start with), so no order depends on how long
   *  its text would be; while the text box holds text that is not a valid order, the value is that text. */
  | OptionBase & { kind: 'order'; value: string };

export type ToolValues = Record<string, string | number | boolean | readonly number[]>;

export interface ToolContext {
  signal: AbortSignal;
  progress(p: { fraction?: number; stage?: string }): void;
  /** The worker pools, for tools whose work runs off the page. */
  engines: Engines;
}

export interface ToolResult {
  /** `note` is one line under the file's download button; `details` a short list below it. */
  outputs: Array<{ blob: Blob; base: string; ext: string; note?: string; details?: string[] }>;
  warnings: string[];
  summary?: string;
}

export interface ToolDefinition {
  id: string;
  title: string;
  /** One line under the title. */
  summary: string;
  accepts: readonly FormatId[];
  minInputs: number;
  maxInputs: number;
  /** The order of the files matters: the list can be reordered by dragging or with Move up and Move down. */
  ordered: boolean;
  options: readonly ToolOption[];
  /** The run button's label, such as "Merge PDFs". */
  action: string;
  /** Looks at each file the tool takes as it is added, off the page (the file shows as being checked meanwhile). */
  inspect?(input: ToolInput, ctx: { signal: AbortSignal; engines: Engines }): Promise<ToolInspection>;
  /** The check box that accepts every confirm warning from inspect: "Merge anyway". */
  confirmLabel?: string;
  /** Why the tool cannot run with these files and values, or null when it can. */
  check?(inputs: readonly ToolInput[], values: ToolValues): string | null;
  run(inputs: readonly ToolInput[], values: ToolValues, ctx: ToolContext): Promise<ToolResult>;
}
