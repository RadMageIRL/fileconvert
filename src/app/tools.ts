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
  /** Each page's size as shown, in points, flat [w1, h1, w2, h2, ...] (PDF tools that draw pages, and previews). */
  sizes?: readonly number[];
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
  /** Each page's size as shown (PDF tools that draw pages, and previews). */
  sizes?: readonly number[];
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
  /** A choice the person makes is remembered in this browser under this name, and starts the option next time instead
   *  of its default (paper size). Only a choice they make is stored, never the default. */
  remember?: string;
}

export type ToolOption =
  | OptionBase & { kind: 'select'; value: string; choices: ReadonlyArray<readonly [string, string]> }
  | OptionBase & { kind: 'number'; value: number; min: number; max: number; step?: number; unit?: string }
  | OptionBase & { kind: 'check'; value: boolean }
  | OptionBase & { kind: 'text'; value: string; placeholder?: string; maxLength?: number }
  /** Pages of the one PDF the tool takes, typed ("1-3, 7") or chosen in its page previews. Chosen pages are kept as a
   *  list of page numbers from 1, in order, and the box shows them as text; text typed is the value as typed. Empty
   *  means every page (`empty: 'all'`) or none yet (`empty: 'none'`). `mark` is the word chosen pages show ("Removed"). */
  | OptionBase & { kind: 'pages'; value: string; placeholder?: string; maxLength?: number; empty: 'all' | 'none'; mark?: string;
    /** A select option whose value turns the chosen pages in their previews, in degrees (rotate). */
    turnKey?: string }
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
  /** Where a tool may write its results in the browser's private storage (a session folder and a name prefix for this
   *  run), or null where there is none; the workspace deletes them with the results. */
  temp: { session: string; prefix: string } | null;
}

export interface ToolResult {
  /** `note` is one line under the file's download button; `details` a short list below it. */
  outputs: Array<{ blob: Blob; base: string; ext: string; note?: string; details?: string[]; temp?: string }>;
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
  /** One line about what running would make, shown above the button: "3 PNG pictures, the largest 2,550 x 3,300 pixels". */
  plan?(inputs: readonly ToolInput[], values: ToolValues): string | null;
  /** Which files each page goes to, for the page previews of a tool that makes several (split): "File 2". */
  pageLabels?(inputs: readonly ToolInput[], values: ToolValues): ReadonlyMap<number, string> | null;
  run(inputs: readonly ToolInput[], values: ToolValues, ctx: ToolContext): Promise<ToolResult>;
}
