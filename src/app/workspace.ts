// The tool workspace: the one interface every tool (./tools.ts) runs in. It keeps the files in order and lets
// them be reordered by dragging or from the keyboard, shows the tool's options, runs the tool with progress and
// cancel, gives the results unique safe names, and offers them one by one or as a ZIP. Files are checked by
// their bytes, as in the converter; files a tool does not take stay listed with the reason. Loaded only when a
// tool opens, so the converter pages do not pay for it.

import { FORMATS } from '../core/formats';
import { formatBytes } from '../core/limits';
import { isLoadFailure, loadFailureMessage } from '../core/loading';
import { NameRegistry, safeBase } from '../core/naming';
import { sniffBlob } from '../core/sniff';
import { clear, h } from './dom';
import type { Engines } from './jobs';
import { CanceledError } from './pool';
import type { ToolDefinition, ToolInput, ToolOption, ToolValues } from './tools';

interface Entry extends ToolInput {
  info: string;
  checking: boolean;
  /** Why the tool cannot use this file. Such files are listed but never passed to the tool. */
  error?: string;
  note?: string;
}

/** What the page lends the workspace. */
export interface WorkspaceHost {
  engines: Engines;
  zip(files: Array<{ name: string; blob: Blob }>): Promise<Blob>;
  save(blob: Blob, name: string): void;
  announce(message: string): void;
}

type State = 'idle' | 'running' | 'done' | 'failed' | 'canceled';

export class Workspace {
  private entries: Entry[] = [];
  private nextId = 1;
  private values: ToolValues = {};
  private state: State = 'idle';
  private fraction?: number;
  private stage?: string;
  private error?: string;
  private warnings: string[] = [];
  private summary?: string;
  private outputs: Array<{ name: string; blob: Blob }> = [];
  private controller: AbortController | null = null;
  private names = new NameRegistry();
  private dragId: number | null = null;
  private list!: HTMLOListElement;
  private runBox!: HTMLElement;
  private outBox!: HTMLElement;
  private picker!: HTMLInputElement;

  constructor(private root: HTMLElement, readonly def: ToolDefinition, private host: WorkspaceHost) {
    for (const o of def.options) this.values[o.key] = o.value;
  }

  // ------------------------------------------------------------ state

  /** Files the tool will get, in order. */
  accepted(): Entry[] {
    return this.entries.filter(e => !e.checking && !e.error);
  }

  get running(): boolean {
    return this.state === 'running';
  }

  /** Why the tool cannot run now, or null. */
  blocker(): string | null {
    const n = this.accepted().length;
    const { minInputs: min, maxInputs: max } = this.def;
    if (this.entries.some(e => e.checking)) return 'Checking the files.';
    if (n < min) return min === 1 ? 'Add a file to start.' : `Add at least ${min} files.`;
    if (n > max) return `This tool takes up to ${max} ${max === 1 ? 'file' : 'files'}. Remove ${n - max}.`;
    return this.def.check?.(this.accepted(), this.values) ?? null;
  }

  add(files: Iterable<File>): void {
    if (this.running) return;
    for (const file of files) {
      const e: Entry = { id: this.nextId++, file, name: file.name || 'unnamed', format: 'txt', info: formatBytes(file.size), checking: true };
      this.entries.push(e);
      void sniffBlob(file, e.name).then(s => {
        e.info = `${s.label}, ${formatBytes(file.size)}`;
        if (s.format && this.def.accepts.includes(s.format)) {
          e.format = s.format;
          if (s.mismatch) e.note = s.mismatch;
        } else {
          e.error = s.format
            ? `${this.def.title} takes ${this.acceptedLabels()} files; this is ${s.label}.`
            : s.reason ?? 'This file cannot be used.';
        }
      }, () => { e.error = 'The file could not be read.'; }).finally(() => {
        e.checking = false;
        this.changed();
      });
    }
    this.changed();
  }

  remove(id: number): void {
    if (this.running) return;
    this.entries = this.entries.filter(e => e.id !== id);
    this.changed();
  }

  /** Moves a file up (-1) or down (+1) among the files the tool takes. */
  move(id: number, delta: number): void {
    const acc = this.accepted();
    const i = acc.findIndex(e => e.id === id);
    if (i < 0 || i + delta < 0 || i + delta >= acc.length) return;
    this.moveTo(id, i + delta);
  }

  /** Moves a file to a position among the files the tool takes. */
  moveTo(id: number, index: number): void {
    if (this.running) return;
    const entry = this.entries.find(e => e.id === id);
    if (!entry || entry.error || entry.checking) return;
    const acc = this.accepted().filter(e => e.id !== id);
    const at = Math.max(0, Math.min(index, acc.length));
    this.entries = this.entries.filter(e => e.id !== id);
    const before = acc[at];
    this.entries.splice(before ? this.entries.indexOf(before) : this.entries.length, 0, entry);
    this.changed();
    this.host.announce(`${entry.name} moved to position ${at + 1} of ${acc.length + 1}.`);
  }

  setValue(key: string, value: string | number | boolean): void {
    this.values[key] = value;
    this.changed();
  }

  /** The list or the options changed, so earlier results no longer match them. */
  private changed(): void {
    if (this.state !== 'running') {
      this.dropOutputs();
      if (this.state !== 'idle') { this.state = 'idle'; this.error = undefined; }
    }
    this.render();
  }

  private dropOutputs(): void {
    for (const o of this.outputs) this.names.release(o.name);
    this.outputs = [];
    this.warnings = [];
    this.summary = undefined;
  }

  async run(): Promise<void> {
    if (this.running || this.blocker()) return;
    const inputs: ToolInput[] = this.accepted().map(({ id, file, name, format }) => ({ id, file, name, format }));
    this.dropOutputs();
    const controller = new AbortController();
    this.controller = controller;
    Object.assign(this, { state: 'running', error: undefined, fraction: undefined, stage: 'Starting' });
    this.render();
    const current = () => this.controller === controller;
    try {
      const r = await this.def.run(inputs, { ...this.values }, {
        signal: controller.signal,
        engines: this.host.engines,
        progress: p => {
          if (!current()) return;
          if (p.fraction !== undefined) this.fraction = p.fraction;
          if (p.stage !== undefined) this.stage = p.stage;
          this.renderRun();
        },
      });
      if (!current()) return;
      if (controller.signal.aborted) throw new CanceledError();
      this.outputs = r.outputs.map(o => ({ name: this.names.claim(o.base, o.ext), blob: o.blob }));
      this.warnings = r.warnings;
      this.summary = r.summary;
      this.state = 'done';
      this.host.announce(`${this.def.title}: ${this.outputs.length} ${this.outputs.length === 1 ? 'file is' : 'files are'} ready to download.`);
    } catch (e) {
      if (!current()) return;
      if (e instanceof CanceledError || controller.signal.aborted) {
        this.state = 'canceled';
      } else {
        this.state = 'failed';
        this.error = isLoadFailure(e) ? loadFailureMessage() : (e as Error).message || `${this.def.title} failed.`;
        this.host.announce(`${this.def.title} failed: ${this.error}`);
      }
    } finally {
      if (current()) {
        this.controller = null;
        this.render();
      }
    }
  }

  /** Stops the run at once. A result that arrives later is ignored. */
  cancel(): void {
    if (!this.controller) return;
    this.controller.abort();
    this.controller = null;
    this.state = 'canceled';
    this.render();
  }

  dispose(): void {
    this.cancel();
    this.dropOutputs();
    clear(this.root);
  }

  private async downloadZip(): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      this.host.save(await this.host.zip(this.outputs), `${safeBase(this.def.title + '.x')} ${stamp}.zip`);
    } catch (e) {
      this.host.announce(`The ZIP could not be made: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ interface

  private acceptedLabels(): string {
    const l = this.def.accepts.map(f => FORMATS[f].label);
    return l.length > 1 ? `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}` : l[0];
  }

  mount(): void {
    clear(this.root);
    const accept = this.def.accepts.flatMap(f => FORMATS[f].exts.map(e => `.${e}`)).join(',');
    this.picker = h('input', { type: 'file', multiple: this.def.maxInputs > 1, accept, hidden: true }) as HTMLInputElement;
    this.picker.addEventListener('change', () => {
      if (this.picker.files?.length) this.add(this.picker.files);
      this.picker.value = '';
    });
    this.list = h('ol', { class: 'ws-list', 'aria-label': this.def.ordered ? 'Files, in order' : 'Files' }) as HTMLOListElement;
    this.runBox = h('div', { class: 'ws-run' });
    this.outBox = h('div', { class: 'ws-out' });
    this.root.append(
      h('div', { class: 'ws-head' }, h('h2', { id: 'workspace-title' }, this.def.title), h('p', { class: 'lede' }, this.def.summary)),
      h('div', { class: 'ws-add' }, this.picker,
        h('button', { type: 'button', class: 'primary', 'data-key': 'add', onclick: () => this.picker.click() }, 'Add files'),
        h('span', { class: 'drop-sub' }, `${this.acceptedLabels()}${this.def.maxInputs > 1 ? `, up to ${this.def.maxInputs} files` : ''}. You can also drop files on the page.`)),
      this.list,
      this.optionsBox(),
      this.runBox,
      this.outBox,
    );
    this.setupDrag();
    this.render();
  }

  private field(o: ToolOption): HTMLElement {
    const disabledWhileRunning = (el: HTMLElement) => { el.dataset.lock = ''; return el; };
    if (o.kind === 'select') {
      const sel = h('select', { 'data-key': `opt-${o.key}` }) as HTMLSelectElement;
      for (const [v, l] of o.choices) sel.append(h('option', { value: v, selected: v === this.values[o.key] }, l));
      sel.addEventListener('change', () => this.setValue(o.key, sel.value));
      return h('label', { class: 'field' }, h('span', {}, o.label), disabledWhileRunning(sel));
    }
    if (o.kind === 'number') {
      const input = h('input', { type: 'number', min: o.min, max: o.max, step: o.step ?? 1, value: Number(this.values[o.key]), 'data-key': `opt-${o.key}` }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = Math.max(o.min, Math.min(o.max, Number(input.value) || o.min));
        input.value = String(v);
        this.setValue(o.key, v);
      });
      return h('label', { class: 'field' }, h('span', {}, o.label), h('span', { class: 'row' }, disabledWhileRunning(input), o.unit ?? ''));
    }
    if (o.kind === 'check') {
      const box = h('input', { type: 'checkbox', checked: this.values[o.key] === true, 'data-key': `opt-${o.key}` }) as HTMLInputElement;
      box.addEventListener('change', () => this.setValue(o.key, box.checked));
      return h('label', { class: 'field check' }, disabledWhileRunning(box), h('span', {}, o.label));
    }
    const text = h('input', { type: 'text', value: String(this.values[o.key]), placeholder: o.placeholder, maxlength: o.maxLength, 'data-key': `opt-${o.key}` }) as HTMLInputElement;
    text.addEventListener('change', () => this.setValue(o.key, text.value));
    return h('label', { class: 'field' }, h('span', {}, o.label), disabledWhileRunning(text));
  }

  private optionsBox(): HTMLElement {
    if (!this.def.options.length) return h('div', { hidden: true });
    return h('fieldset', { class: 'ws-options' }, h('legend', {}, 'Options'), h('div', { class: 'fields' }, ...this.def.options.map(o => this.field(o))));
  }

  /** Reordering with the mouse: rows are dragged within the list. Files dropped from outside go to add(). */
  private setupDrag(): void {
    const rowAt = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLLIElement>('li.ws-item[draggable="true"]') ?? null;
    const clearMarks = () => this.list.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    this.list.addEventListener('dragstart', e => {
      const row = rowAt(e.target);
      if (!row || this.running) return;
      this.dragId = Number(row.dataset.id);
      e.dataTransfer?.setData('text/plain', row.dataset.id!);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    this.list.addEventListener('dragover', e => {
      if (this.dragId === null) return;
      const row = rowAt(e.target);
      e.preventDefault();
      clearMarks();
      if (!row || Number(row.dataset.id) === this.dragId) return;
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    this.list.addEventListener('drop', e => {
      if (this.dragId === null) return;
      e.preventDefault();
      e.stopPropagation();
      const row = rowAt(e.target);
      const id = this.dragId;
      this.dragId = null;
      clearMarks();
      if (!row || Number(row.dataset.id) === id) return this.render();
      const acc = this.accepted().filter(x => x.id !== id);
      const target = acc.findIndex(x => x.id === Number(row.dataset.id));
      const r = row.getBoundingClientRect();
      this.moveTo(id, e.clientY < r.top + r.height / 2 ? target : target + 1);
    });
    this.list.addEventListener('dragend', () => {
      this.dragId = null;
      clearMarks();
      this.list.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    });
  }

  private render(): void {
    if (!this.list) return;
    const focused = document.activeElement && this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    clear(this.list);
    const acc = this.accepted();
    const ordered = this.def.ordered && acc.length > 1;
    for (const e of this.entries) {
      const pos = acc.indexOf(e);
      const usable = pos >= 0;
      const li = h('li', { class: `ws-item${e.error ? ' rejected' : ''}${e.checking ? ' checking' : ''}`, 'data-id': e.id, draggable: ordered && usable && !this.running ? 'true' : null });
      const main = h('div', { class: 'ws-main' },
        h('div', { class: 'job-name' }, e.name),
        h('div', { class: 'job-info' }, e.checking ? `Checking, ${e.info}` : e.info));
      if (e.note) main.append(h('ul', { class: 'job-notes' }, h('li', {}, e.note)));
      if (e.error) main.append(h('div', { class: 'job-error' }, e.error));
      const actions = h('div', { class: 'job-actions' });
      if (ordered && usable) {
        actions.append(
          h('button', { type: 'button', class: 'small', 'data-key': `up-${e.id}`, 'aria-label': `Move ${e.name} up`, disabled: pos === 0 || this.running, onclick: () => this.move(e.id, -1) }, 'Up'),
          h('button', { type: 'button', class: 'small', 'data-key': `down-${e.id}`, 'aria-label': `Move ${e.name} down`, disabled: pos === acc.length - 1 || this.running, onclick: () => this.move(e.id, 1) }, 'Down'));
      }
      actions.append(h('button', { type: 'button', class: 'small ghost danger', 'data-key': `rm-${e.id}`, 'aria-label': `Remove ${e.name}`, disabled: this.running, onclick: () => this.remove(e.id) }, 'Remove'));
      li.append(h('span', { class: 'ws-pos', 'aria-hidden': 'true' }, usable && this.def.ordered ? String(pos + 1) : ''), main, actions);
      this.list.append(li);
    }
    this.list.hidden = this.entries.length === 0;
    for (const el of this.root.querySelectorAll<HTMLInputElement>('[data-lock]')) el.disabled = this.running;
    this.renderRun();
    this.renderOutputs();
    if (focused) {
      let el = this.root.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(focused)}"]`);
      // A row moved to an end loses the button that moved it there; the other direction keeps the focus nearby.
      if (el?.disabled && /^(up|down)-/.test(focused)) el = this.root.querySelector(`[data-key="${CSS.escape(focused.startsWith('up-') ? focused.replace('up-', 'down-') : focused.replace('down-', 'up-'))}"]`);
      (el && !el.disabled ? el : this.root.querySelector<HTMLElement>('[data-key="add"]'))?.focus();
    }
  }

  private renderRun(): void {
    const box = this.runBox;
    const why = this.blocker();
    const keepFocus = document.activeElement && box.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    clear(box);
    if (this.running) {
      const p = h('progress', { max: 1, 'aria-label': `${this.def.title} progress` }) as HTMLProgressElement;
      if (this.fraction !== undefined) p.value = this.fraction;
      box.append(
        h('button', { type: 'button', 'data-key': 'cancel', onclick: () => this.cancel() }, 'Cancel'),
        h('div', { class: 'job-status' }, h('span', { class: 'state' }, 'Working'), p,
          h('span', { class: 'pct' }, this.fraction !== undefined ? `${Math.floor(this.fraction * 100)}%` : ''),
          h('span', { class: 'job-info' }, this.stage ?? '')));
    } else {
      box.append(h('button', { type: 'button', class: 'primary', 'data-key': 'run', disabled: !!why, onclick: () => void this.run() }, this.def.action));
      if (why && this.entries.length) box.append(h('p', { class: 'ws-why' }, why));
      if (this.state === 'canceled') box.append(h('p', { class: 'ws-state canceled' }, 'Canceled.'));
      if (this.state === 'failed' && this.error) box.append(h('div', { class: 'job-error' }, this.error));
    }
    if (keepFocus) box.querySelector<HTMLElement>(`[data-key="${keepFocus === 'cancel' ? 'run' : keepFocus === 'run' ? 'cancel' : keepFocus}"]`)?.focus();
  }

  private renderOutputs(): void {
    const box = this.outBox;
    clear(box);
    if (this.state !== 'done' || !this.outputs.length) { box.hidden = true; return; }
    box.hidden = false;
    const size = this.outputs.reduce((n, o) => n + o.blob.size, 0);
    box.append(h('p', { class: 'ws-state done' }, [`Done: ${this.outputs.length} ${this.outputs.length === 1 ? 'file' : 'files'}, ${formatBytes(size)}`, this.summary].filter(Boolean).join('. ')));
    if (this.warnings.length) box.append(h('ul', { class: 'job-notes' }, ...this.warnings.map(w => h('li', {}, w))));
    const buttons = h('div', { class: 'outputs' });
    this.outputs.forEach((o, i) => buttons.append(h('button', { type: 'button', class: 'small primary', 'data-key': `dl-${i}`, title: o.name, onclick: () => this.host.save(o.blob, o.name) }, h('span', {}, `Download ${o.name}`))));
    if (this.outputs.length > 1) buttons.append(h('button', { type: 'button', class: 'small', 'data-key': 'zip', onclick: () => void this.downloadZip() }, `Download all (ZIP, ${this.outputs.length})`));
    box.append(buttons);
  }
}
