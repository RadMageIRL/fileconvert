// The contract for tools: work that takes a set of files, often in a chosen order, and makes one result or a
// few (merge PDFs, images to PDF, split a PDF). The converter queue handles one file to one format; tools get the
// workspace (./workspace.ts), which owns the file list, its order, the options, progress, cancel, the result
// names and the downloads. A tool only says what it accepts and how to run, so every tool behaves the same way.

import type { FormatId } from '../core/formats';
import type { Engines } from './jobs';

/** A file in the workspace that the tool accepts. */
export interface ToolInput {
  id: number;
  file: File;
  name: string;
  /** The format found in the file's bytes, not its name. */
  format: FormatId;
}

export type ToolOption =
  | { kind: 'select'; key: string; label: string; value: string; choices: ReadonlyArray<readonly [string, string]> }
  | { kind: 'number'; key: string; label: string; value: number; min: number; max: number; step?: number; unit?: string }
  | { kind: 'check'; key: string; label: string; value: boolean }
  | { kind: 'text'; key: string; label: string; value: string; placeholder?: string; maxLength?: number };

export type ToolValues = Record<string, string | number | boolean>;

export interface ToolContext {
  signal: AbortSignal;
  progress(p: { fraction?: number; stage?: string }): void;
  /** The worker pools, for tools whose work runs off the page. */
  engines: Engines;
}

export interface ToolResult {
  outputs: Array<{ blob: Blob; base: string; ext: string }>;
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
  /** Why the tool cannot run with these files and values, or null when it can. */
  check?(inputs: readonly ToolInput[], values: ToolValues): string | null;
  run(inputs: readonly ToolInput[], values: ToolValues, ctx: ToolContext): Promise<ToolResult>;
}
