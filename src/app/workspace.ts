// The tool workspace: the one interface every tool (./tools.ts) runs in. It keeps the files in order and lets
// them be reordered by dragging or from the keyboard, shows the tool's options, runs the tool with progress and
// cancel, gives the results unique safe names, and offers them one by one or as a ZIP. Files are checked by
// their bytes, as in the converter, and then by the tool's own inspect when it has one (a PDF tool reads each PDF's
// pages and signature as it is added); files a tool does not take stay listed with the reason. A warning a file
// raises (a signed PDF that will lose its signature) has to be accepted with a check box before the tool runs.
// Loaded only when a tool opens, so the converter pages do not pay for it.

import { FORMATS } from '../core/formats';
import { formatBytes } from '../core/limits';
import { isLoadFailure, loadFailureMessage } from '../core/loading';
import { NameRegistry, safeBase } from '../core/naming';
import { checkOrder, chosenPages, formatOrder, formatPages, parseOrder } from '../core/pageranges';
import { memoryAllowance } from '../core/pdfmemory';
import { sniffBlob } from '../core/sniff';
import { clear, h } from './dom';
import type { Engines } from './jobs';
import { CanceledError } from './pool';
import { PageGrid, PreviewSession, TILE, type GridState } from './preview';
import type { ToolDefinition, ToolInput, ToolOption, ToolValues } from './tools';

interface Entry extends ToolInput {
  info: string;
  checking: boolean;
  /** Why the tool cannot use this file. Such files are listed but never passed to the tool. */
  error?: string;
  notes: string[];
  /** A warning to accept before the tool runs with this file. */
  confirm?: string;
  /** Stops the tool's inspect when the file is removed. */
  inspecting?: AbortController;
}

/** What the page lends the workspace. */
export interface WorkspaceHost {
  engines: Engines;
  zip(files: Array<{ name: string; blob: Blob }>): Promise<Blob>;
  save(blob: Blob, name: string): void;
  announce(message: string): void;
  /** Where a run may write its results in the browser's private storage, or null where there is none. */
  temp?(prefix: string): { session: string; prefix: string } | null;
  /** Deletes results written to private storage: these names, and every name that starts with `prefix`. */
  discard?(names: string[], prefix?: string): void;
  /** The address of pdf.js's files in the app, for page previews. */
  assets?: string;
}

/** Where a remembered choice is kept in this browser (localStorage). */
const REMEMBER = 'fileconvert-choice-';

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
  private outputs: Array<{ name: string; blob: Blob; note?: string; details?: string[]; temp?: string }> = [];
  /** The name prefix of the current run's results in private storage. */
  private runPrefix = '';
  private runs = 0;
  private controller: AbortController | null = null;
  private names = new NameRegistry();
  private dragId: number | null = null;
  /** The warnings accepted, and which files raised them (a new warning has to be accepted again). */
  private confirmed = false;
  private confirmFor = '';
  private list!: HTMLOListElement;
  private confirmBox!: HTMLElement;
  /** The page option of a one-PDF tool, with its page previews: a page order (reorder), pages to choose (extract,
   *  delete, rotate, PDF to JPG and PNG), or the pages shown with the file each goes to (split, no option). Its text box,
   *  what the box shows, and the file and page count it was made for. An order is the option's value as a list of pages,
   *  shown as short text ("5000-1"); chosen pages are a list too, or the text as typed. */
  private pagesUi?: { opt?: ToolOption; grid: PageGrid; text?: HTMLInputElement; shown: string; madeFor: string };
  /** The previews of the file in the tool, drawn in a worker of their own. */
  private preview: { id: number; session: PreviewSession } | null = null;
  private runBox!: HTMLElement;
  private outBox!: HTMLElement;
  private picker!: HTMLInputElement;

  /** `preset` sets options for a page about one use of the tool (PNG on the PDF to PNG page), over remembered choices. */
  constructor(private root: HTMLElement, readonly def: ToolDefinition, private host: WorkspaceHost, preset: Record<string, string> = {}) {
    for (const o of def.options) {
      this.values[o.key] = o.value;
      const kept = o.remember ? this.recall(o.remember) : null;
      for (const v of [kept, preset[o.key]]) if (v != null && this.allowed(o, v)) this.values[o.key] = o.kind === 'number' ? Number(v) : o.kind === 'check' ? v === 'true' : v;
    }
  }

  private recall(name: string): string | null {
    try { return localStorage.getItem(REMEMBER + name); } catch { return null; }
  }

  /** Whether a stored or preset value is one the option can take. */
  private allowed(o: ToolOption, v: string): boolean {
    if (o.kind === 'select') return o.choices.some(([c]) => c === v);
    if (o.kind === 'number') return Number.isFinite(Number(v)) && Number(v) >= o.min && Number(v) <= o.max;
    if (o.kind === 'check') return v === 'true' || v === 'false';
    return o.kind === 'text';
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
    const own = this.def.check?.(this.accepted(), this.values) ?? null;
    if (own) return own;
    if (this.raised().length && !this.confirmed) return `Check "${this.def.confirmLabel ?? 'Go on anyway'}" first.`;
    return null;
  }

  /** The accepted files that raised a warning. */
  private raised(): Entry[] {
    return this.accepted().filter(e => e.confirm);
  }

  add(files: Iterable<File>): void {
    if (this.running) return;
    for (const file of files) {
      const e: Entry = { id: this.nextId++, file, name: file.name || 'unnamed', format: 'txt', info: formatBytes(file.size), checking: true, notes: [] };
      this.entries.push(e);
      void sniffBlob(file, e.name).then(async s => {
        e.info = `${s.label}, ${formatBytes(file.size)}`;
        if (s.format && this.def.accepts.includes(s.format)) {
          e.format = s.format;
          if (s.mismatch) e.notes.push(s.mismatch);
        } else {
          e.error = s.format
            ? `${this.def.title} takes ${this.acceptedLabels()} files; this is ${s.label}.`
            : s.reason ?? 'This file cannot be used.';
        }
        if (e.error || !this.def.inspect || !this.entries.includes(e)) return;
        const ac = new AbortController();
        e.inspecting = ac;
        try {
          const r = await this.def.inspect({ id: e.id, file, name: e.name, format: e.format }, { signal: ac.signal, engines: this.host.engines });
          if (r.info) e.info += `, ${r.info}`;
          if (r.pages !== undefined) e.pages = r.pages;
          if (r.work) e.work = r.work;
          if (r.image) e.image = r.image;
          if (r.sizes) e.sizes = r.sizes;
          if (r.note) e.notes.push(r.note);
          if (r.error) e.error = r.error;
          if (r.confirm) e.confirm = r.confirm;
        } catch (err) {
          if (!(err instanceof CanceledError) && !ac.signal.aborted) e.error = isLoadFailure(err) ? loadFailureMessage() : (err as Error).message || 'The file could not be read.';
        } finally {
          e.inspecting = undefined;
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
    this.entries.find(e => e.id === id)?.inspecting?.abort();
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
    // A choice the person makes is remembered where the option asks for it (paper size); defaults never are.
    const o = this.def.options.find(x => x.key === key);
    if (o?.remember) { try { localStorage.setItem(REMEMBER + o.remember, String(value)); } catch { /* storage unavailable: kept for this visit */ } }
    this.changed();
  }

  /** The list or the options changed, so earlier results no longer match them. */
  private changed(): void {
    const raised = this.raised().map(e => e.id).join(',');
    if (raised !== this.confirmFor) { this.confirmFor = raised; this.confirmed = false; }
    if (this.state !== 'running') {
      this.dropOutputs();
      if (this.state !== 'idle') { this.state = 'idle'; this.error = undefined; }
    }
    this.render();
  }

  private dropOutputs(): void {
    for (const o of this.outputs) this.names.release(o.name);
    const temps = this.outputs.flatMap(o => (o.temp ? [o.temp] : []));
    if (temps.length) this.host.discard?.(temps);
    this.outputs = [];
    this.warnings = [];
    this.summary = undefined;
  }

  async run(): Promise<void> {
    if (this.running || this.blocker()) return;
    const inputs: ToolInput[] = this.accepted().map(({ id, file, name, format, pages, work, image, sizes }) => ({ id, file, name, format, pages, work, image, sizes }));
    this.dropOutputs();
    const controller = new AbortController();
    this.controller = controller;
    Object.assign(this, { state: 'running', error: undefined, fraction: undefined, stage: 'Starting' });
    // The previews let their worker go while the tool runs, so the two do not hold the file in memory together.
    this.preview?.session.suspend();
    const prefix = `ws${Date.now().toString(36)}-${++this.runs}-`;
    this.runPrefix = prefix;
    this.render();
    const current = () => this.controller === controller;
    const leftovers = () => this.host.discard?.([], prefix);
    try {
      const r = await this.def.run(inputs, { ...this.values }, {
        signal: controller.signal,
        engines: this.host.engines,
        temp: this.host.temp?.(prefix) ?? null,
        progress: p => {
          if (!current()) return;
          if (p.fraction !== undefined) this.fraction = p.fraction;
          if (p.stage !== undefined) this.stage = p.stage;
          this.renderRun();
        },
      });
      if (!current()) { leftovers(); return; }
      if (controller.signal.aborted) throw new CanceledError();
      this.outputs = r.outputs.map(o => ({ name: this.names.claim(o.base, o.ext), blob: o.blob, note: o.note, details: o.details, temp: o.temp }));
      this.warnings = r.warnings;
      this.summary = r.summary;
      this.state = 'done';
      this.host.announce(`${this.def.title}: ${this.outputs.length} ${this.outputs.length === 1 ? 'file is' : 'files are'} ready to download.`);
    } catch (e) {
      leftovers();
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
    // A worker stopped halfway may have written some results; they are not offered, so they go.
    if (this.runPrefix) this.host.discard?.([], this.runPrefix);
    this.render();
  }

  dispose(): void {
    for (const e of this.entries) e.inspecting?.abort();
    this.cancel();
    this.dropOutputs();
    this.preview?.session.dispose();
    this.preview = null;
    this.pagesUi?.grid.dispose();
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
    this.confirmBox = h('div', { class: 'ws-confirm', hidden: true });
    this.runBox = h('div', { class: 'ws-run' });
    this.outBox = h('div', { class: 'ws-out' });
    this.root.append(
      h('div', { class: 'ws-head' }, h('h2', { id: 'workspace-title' }, this.def.title), h('p', { class: 'lede' }, this.def.summary)),
      h('div', { class: 'ws-add' }, this.picker,
        h('button', { type: 'button', class: 'primary', 'data-key': 'add', onclick: () => this.picker.click() }, 'Add files'),
        h('span', { class: 'drop-sub' }, `${this.acceptedLabels()}${this.def.maxInputs > 1 ? `, up to ${this.def.maxInputs} files` : ''}. You can also drop files on the page.`)),
      this.list,
      this.optionsBox(),
      this.labelsBox(),
      this.confirmBox,
      this.runBox,
      this.outBox,
    );
    this.setupDrag();
    this.render();
  }

  /** An option's control, with its hint beside its label (read as the control's description, not its name). */
  private field(o: ToolOption): HTMLElement {
    const el = this.fieldControl(o);
    if (!o.hint && !o.showIf) return el;
    const box = h('div', { class: 'ws-field' }, el);
    if (o.hint) {
      const id = `ws-hint-${o.key}`;
      const hint = h('span', { class: 'ws-hint', id }, o.hint);
      // A page option's hint is about its text box, so it goes under the box, above the page previews.
      const grid = el.querySelector('.pg-box');
      if (grid) grid.before(hint); else box.append(hint);
      el.querySelector('input, select')?.setAttribute('aria-describedby', id);
    }
    if (o.showIf) { box.dataset.showKey = o.showIf.key; box.dataset.showValue = ([] as string[]).concat(o.showIf.value).join('|'); }
    return box;
  }

  private fieldControl(o: ToolOption): HTMLElement {
    const disabledWhileRunning = (el: HTMLElement) => { el.dataset.lock = ''; return el; };
    if (o.kind === 'order' || o.kind === 'pages') return this.pagesField(o);
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
    const text = h('input', { type: 'text', value: String(this.values[o.key]), placeholder: (o as { placeholder?: string }).placeholder, maxlength: (o as { maxLength?: number }).maxLength, 'data-key': `opt-${o.key}` }) as HTMLInputElement;
    text.addEventListener('change', () => this.setValue(o.key, text.value));
    return h('label', { class: 'field' }, h('span', {}, o.label), disabledWhileRunning(text));
  }

  private optionsBox(): HTMLElement {
    if (!this.def.options.length) return h('div', { hidden: true });
    return h('fieldset', { class: 'ws-options' }, h('legend', {}, 'Options'), h('div', { class: 'fields' }, ...this.def.options.map(o => this.field(o))));
  }

  // ------------------------------------------------------------ pages of one PDF, with previews

  /** The page option (an order, or pages to choose): its text box and its page grid. */
  private pagesField(o: ToolOption): HTMLElement {
    const order = o.kind === 'order';
    const text = h('input', { type: 'text', 'data-key': `opt-${o.key}`, 'data-lock': '', autocomplete: 'off', spellcheck: 'false',
      placeholder: o.kind === 'pages' ? o.placeholder : undefined, maxlength: o.kind === 'pages' ? o.maxLength : undefined }) as HTMLInputElement;
    const grid = new PageGrid(order ? 'order' : 'select', order ? 'Pages, in their new order' : 'Pages', order ? {
      move: (from, to) => this.movePage(from, to),
      reverse: () => this.setOrder(this.currentOrder().reverse(), 'The order was reversed.'),
      reset: () => this.setOrder(this.currentOrder().sort((a, b) => a - b), 'The pages are back in their first order.'),
    } : {
      toggle: (pages, on) => this.choosePages(pages, on),
      all: () => this.chooseAll(true),
      none: () => this.chooseAll(false),
    });
    this.pagesUi = { opt: o, grid, text, shown: '', madeFor: '' };
    text.addEventListener('change', () => (order ? this.typeOrder(text.value.trim()) : this.typePages(text.value)));
    return h('div', { class: `field ${order ? 'ws-order' : 'ws-pick'}` },
      h('label', { class: 'field' }, h('span', {}, o.label), text),
      grid.el);
  }

  /** A tool that makes several files from one PDF (split) shows its pages with the file each goes to. */
  private labelsBox(): HTMLElement {
    if (!this.def.pageLabels || this.pagesUi || this.def.maxInputs !== 1) return h('div', { hidden: true });
    const grid = new PageGrid('view', 'Pages, with the file each goes to', {});
    this.pagesUi = { grid, shown: '', madeFor: '' };
    return h('fieldset', { class: 'ws-options' }, h('legend', {}, 'Pages'), grid.el);
  }

  private pageCount(): number {
    return this.accepted()[0]?.pages ?? 0;
  }

  /** The order as page numbers, or every page in order while the text does not hold a valid order. */
  private currentOrder(): number[] {
    const n = this.pageCount();
    try { return this.orderValue(n); } catch { return Array.from({ length: n }, (_, i) => i + 1); }
  }

  /** The option's order for a file of n pages: the list kept, or the text typed read as an order (which may throw). */
  private orderValue(n: number): number[] {
    const v = this.values[this.pagesUi!.opt!.key];
    return Array.isArray(v) ? checkOrder(v, n) : parseOrder(String(v), n);
  }

  /** Text typed in the box: kept as the order when it is one (the box keeps the text as typed), otherwise kept as
   *  text, so the tool's check shows what is wrong with it. */
  private typeOrder(text: string): void {
    const u = this.pagesUi!;
    u.shown = text;
    let value: string | number[] = text;
    try { value = parseOrder(text, this.pageCount()); } catch { /* the check says why */ }
    this.values[u.opt!.key] = value;
    this.changed();
  }

  private setOrder(order: number[], message?: string): void {
    this.values[this.pagesUi!.opt!.key] = order;
    this.pagesUi!.shown = formatOrder(order);
    this.changed();
    if (message) this.host.announce(message);
  }

  /** Moves the page at position `from` to position `to` (0-based), keeping the focus on the page that moved. */
  private movePage(from: number, to: number): void {
    const order = this.currentOrder();
    if (to < 0 || to >= order.length || from === to) return;
    const [p] = order.splice(from, 1);
    order.splice(to, 0, p);
    this.setOrder(order, `Page ${p} moved to position ${to + 1} of ${order.length}.`);
  }

  /** Whether an empty choice means every page (rotate, PDF to JPG and PNG) rather than none yet. */
  private emptyAll(): boolean {
    const o = this.pagesUi?.opt;
    return o?.kind === 'pages' && o.empty === 'all';
  }

  /** The chosen pages, or none while the text does not hold a valid choice. */
  private chosen(): Set<number> {
    const o = this.pagesUi!.opt!;
    const v = this.values[o.key];
    if (v === '' && !this.emptyAll()) return new Set();
    try { return new Set(chosenPages(v, this.pageCount(), this.emptyAll())); } catch { return new Set(); }
  }

  private typePages(text: string): void {
    const u = this.pagesUi!;
    u.shown = text;
    this.values[u.opt!.key] = text.trim();
    this.changed();
  }

  /** Pages chosen or let go in the previews; the box shows the choice as text. */
  private choosePages(pages: number[], on: boolean): void {
    const u = this.pagesUi!;
    const n = this.pageCount();
    const set = this.chosen();
    for (const p of pages) if (on) set.add(p); else set.delete(p);
    const list = [...set].sort((a, b) => a - b);
    const every = this.emptyAll() && list.length === n;
    this.values[u.opt!.key] = every ? '' : list;
    u.shown = every ? '' : formatPages(list);
    this.changed();
    this.host.announce(pages.length === 1 ? `Page ${pages[0]} ${on ? 'chosen' : 'no longer chosen'}; ${list.length} of ${n} chosen.` : `${list.length} of ${n} pages chosen.`);
  }

  private chooseAll(on: boolean): void {
    const u = this.pagesUi!;
    const n = this.pageCount();
    if (on) {
      this.values[u.opt!.key] = this.emptyAll() ? '' : Array.from({ length: n }, (_, i) => i + 1);
      u.shown = this.emptyAll() ? '' : `1-${n}`;
    } else {
      this.values[u.opt!.key] = this.emptyAll() ? [] : '';
      u.shown = '';
    }
    this.changed();
    this.host.announce(on ? `All ${n} pages chosen.` : 'No pages chosen.');
  }

  /** The page grid and its previews, for the file now in the tool. */
  private renderPages(): void {
    const u = this.pagesUi;
    if (!u) return;
    const file = this.accepted()[0];
    const n = file?.pages ?? 0;
    // A new file (or a file with other pages) starts from its own order and from nothing chosen.
    const madeFor = file ? `${file.id}:${n}` : '';
    if (u.madeFor !== madeFor) {
      u.madeFor = madeFor;
      if (u.opt?.kind === 'order') {
        this.values[u.opt.key] = n ? Array.from({ length: n }, (_, i) => i + 1) : '';
        u.shown = n ? `1-${n}` : '';
      } else if (u.opt) {
        this.values[u.opt.key] = u.opt.value;
        u.shown = String(u.opt.value);
      }
      this.syncPreview();
    }
    if (u.text) u.text.value = u.shown;
    const fmt = (k: number) => k.toLocaleString('en-US');
    const state: GridState = { pages: n, sizes: file?.sizes, order: [], locked: this.running, status: '' };
    if (!n) {
      state.status = 'Add a PDF to see its pages.';
    } else if (u.opt?.kind === 'order') {
      try {
        state.order = this.orderValue(n);
        state.status = state.order.every((p, i) => p === i + 1) ? `${fmt(n)} pages, in their first order.` : `${fmt(n)} pages, in a new order.`;
      } catch (e) {
        state.order = Array.from({ length: n }, (_, i) => i + 1);
        state.status = (e as Error).message;
      }
    } else {
      state.order = Array.from({ length: n }, (_, i) => i + 1);
      if (u.opt?.kind === 'pages') {
        const v = this.values[u.opt.key];
        let status = '';
        try { if (!(v === '' && !this.emptyAll())) chosenPages(v, n, this.emptyAll()); } catch (e) { status = (e as Error).message; }
        const set = this.chosen();
        state.selected = set;
        state.mark = u.opt.mark;
        if (u.opt.turnKey) state.turn = Number(this.values[u.opt.turnKey]) || 0;
        state.status = status || (v === '' && this.emptyAll() ? `All ${fmt(n)} pages.` : set.size ? `${fmt(set.size)} of ${fmt(n)} pages chosen.` : `${fmt(n)} pages. Choose pages here or type them above.`);
      } else {
        state.labels = this.def.pageLabels?.(this.accepted(), this.values) ?? undefined;
        state.status = `${fmt(n)} pages.`;
      }
    }
    u.grid.update(state);
  }

  /** Starts previews for the file now in the tool, and stops those of a file that left it. */
  private syncPreview(): void {
    const u = this.pagesUi;
    const file = this.accepted()[0];
    const id = u && file?.pages && this.def.maxInputs === 1 ? file.id : null;
    if ((this.preview?.id ?? null) === id) return;
    this.preview?.session.dispose();
    this.preview = null;
    if (id === null || !u || !this.host.assets) { u?.grid.setSession(null); return; }
    const side = Math.round(TILE * Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)));
    const session = new PreviewSession(() => this.host.engines.newRenderWorker(), file!.file, this.host.assets, () => memoryAllowance(), side,
      p => u.grid.pictureReady(p), () => u.grid.sessionChanged());
    this.preview = { id, session };
    u.grid.setSession(session);
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
      if (e.notes.length) main.append(h('ul', { class: 'job-notes' }, ...e.notes.map(n => h('li', {}, n))));
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
    this.renderConfirm();
    this.renderPages();
    // Options that belong to one choice of another (split by ranges, or every N pages).
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-show-key]')) el.hidden = !el.dataset.showValue!.split('|').includes(String(this.values[el.dataset.showKey!]));
    for (const el of this.root.querySelectorAll<HTMLInputElement>('[data-lock]')) el.disabled = this.running;
    this.renderRun();
    this.renderOutputs();
    if (focused) {
      let el = this.root.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(focused)}"]`);
      // A row moved to an end loses the button that moved it there; the other direction keeps the focus nearby.
      if (el?.disabled && /^(pg-)?(up|down)-/.test(focused)) el = this.root.querySelector(`[data-key="${CSS.escape(focused.replace(/(up|down)-(\d+)$/, (_, d: string, n: string) => `${d === 'up' ? 'down' : 'up'}-${n}`))}"]`);
      (el && !el.disabled ? el : this.root.querySelector<HTMLElement>('[data-key="add"]'))?.focus();
    }
  }

  /** The warnings files raised, and the check box that accepts them. */
  private renderConfirm(): void {
    const box = this.confirmBox;
    const raised = this.raised();
    clear(box);
    box.hidden = raised.length === 0;
    if (!raised.length) return;
    const input = h('input', { type: 'checkbox', checked: this.confirmed, 'data-key': 'confirm', 'data-lock': '' }) as HTMLInputElement;
    input.addEventListener('change', () => { this.confirmed = input.checked; this.renderRun(); });
    box.append(
      h('p', { class: 'ws-confirm-title', id: 'ws-confirm-title' }, raised.length === 1 ? 'Before you go on' : `Before you go on (${raised.length} files)`),
      h('ul', { class: 'job-notes', 'aria-labelledby': 'ws-confirm-title' }, ...raised.map(e => h('li', {}, e.confirm!))),
      h('label', { class: 'field check' }, input, h('span', {}, this.def.confirmLabel ?? 'Go on anyway')));
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
      const plan = this.accepted().length && !this.entries.some(e => e.checking) ? this.def.plan?.(this.accepted(), this.values) : null;
      if (plan) box.append(h('p', { class: 'ws-plan' }, plan));
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
    this.outputs.forEach((o, i) => {
      const button = h('button', { type: 'button', class: 'small primary', 'data-key': `dl-${i}`, title: o.name, onclick: () => this.host.save(o.blob, o.name) }, h('span', {}, `Download ${o.name}`));
      if (!o.note && !o.details?.length) { buttons.append(button); return; }
      buttons.append(h('div', { class: 'ws-file' }, button,
        o.note ? h('span', { class: 'job-info' }, o.note) : null,
        o.details?.length ? h('ul', { class: 'ws-details' }, ...o.details.map(d => h('li', {}, d))) : null));
    });
    if (this.outputs.length > 1) buttons.append(h('button', { type: 'button', class: 'small', 'data-key': 'zip', onclick: () => void this.downloadZip() }, `Download all (ZIP, ${this.outputs.length})`));
    box.append(buttons);
  }
}
