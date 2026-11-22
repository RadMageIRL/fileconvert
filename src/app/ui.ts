// The interface: the drop zone, the settings panels, the queue rows and the batch actions. Rows are built
// once and updated in place, so focus and scroll position survive progress updates.

import { ANIMATED_OUT, AUDIO_OUT, effectiveCategory, FORMATS, WORKBOOKS, type Category, type FormatId } from '../core/formats';
import { formatBytes, LIMITS } from '../core/limits';
import { listSession } from '../core/tempstore';
import { $, clear, h } from './dom';
import { Engines, Queue, type Job } from './jobs';
import { Pool } from './pool';
import { saveSettings, type Settings } from './settings';
import type { ToolId } from '../core/tools';
import { loadTool } from './toolset';
import type { ToolDefinition } from './tools';
import type { Workspace } from './workspace';

const CATEGORY_NAMES: Record<Category, string> = { image: 'Images', audio: 'Audio', video: 'Video', document: 'Documents', data: 'Data', archive: 'Archives' };
/** An output's name in the menu; for an animation, whether the output keeps it moving. */
const optionLabel = (t: FormatId, animated?: boolean) => !animated || FORMATS[t].category !== 'image' ? FORMATS[t].label
  : ANIMATED_OUT.includes(t) ? `${FORMATS[t].label} (animated)` : `${FORMATS[t].label} (first frame)`;
const ICON_TEXT: Record<Category, string> = { image: 'IMG', audio: 'AUD', video: 'VID', document: 'DOC', data: 'DATA', archive: 'ZIP' };

export class App {
  queue: Queue;
  private rows = new Map<number, HTMLLIElement>();
  private thumbs = new Map<number, string>();
  private zipPool = new Pool(() => new Worker(new URL('../workers/zip.worker.ts', import.meta.url), { type: 'module' }), 1);
  private zipUrl: string | null = null;
  private downloadsInFlight = new Set<string>();
  private announced = new Set<string>();
  /** Files ticked in each unpacked archive, by job id. */
  private picked = new Map<number, Set<number>>();
  /** The open tool, if any. Tools replace the converter on their page. */
  workspace: Workspace | null = null;

  constructor(private settings: Settings, private session: string | null, readonly engines = new Engines()) {
    this.queue = new Queue(engines, () => this.settings, session, job => this.update(job), () => this.relist());
  }

  start(): void {
    const picker = $<HTMLInputElement>('picker');
    $('choose').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      if (picker.files?.length) this.queue.add(picker.files);
      picker.value = '';
    });
    const drop = $('drop');
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    document.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; drop.classList.add('over'); } });
    document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('over'); });
    document.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } });
    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.classList.remove('over');
      const files = [...(e.dataTransfer?.files ?? [])].filter(f => f.size > 0 || f.type !== '' || /\.[a-z0-9]+$/i.test(f.name));
      const skipped = (e.dataTransfer?.files.length ?? 0) - files.length;
      if (skipped) this.toast(`${skipped} ${skipped === 1 ? 'item was' : 'items were'} skipped: folders cannot be added, only files.`);
      if (files.length) (this.workspace ?? this.queue).add(files);
    });
    $('convert-all').addEventListener('click', () => this.queue.convertAll());
    $('cancel-all').addEventListener('click', () => this.queue.cancelAll());
    $('clear').addEventListener('click', () => this.clearAll());
    $('zip').addEventListener('click', () => void this.downloadZip());
    $<HTMLSelectElement>('bulk-target').addEventListener('change', e => {
      const v = (e.target as HTMLSelectElement).value as FormatId;
      if (!v) return;
      for (const j of this.queue.jobs) if (j.targets.includes(v) && j.status !== 'converting' && j.status !== 'queued') this.queue.setTarget(j, v);
      (e.target as HTMLSelectElement).value = '';
    });
    window.addEventListener('beforeunload', e => {
      if (this.queue.jobs.some(j => j.status === 'converting' || j.status === 'queued') || this.workspace?.running) e.preventDefault();
    });
  }

  /** Opens one of FileConvert's tools by its id (a tool page does this; the tests too, before a tool has a page). */
  async openTool(id: ToolId): Promise<Workspace> {
    return this.openWorkspace(await loadTool(id));
  }

  /** Opens a tool in the workspace, in place of the converter. The workspace code loads on first use. */
  async openWorkspace(def: ToolDefinition): Promise<Workspace> {
    const { Workspace } = await import('./workspace');
    this.workspace?.dispose();
    const ws = new Workspace($('workspace'), def, {
      engines: this.engines,
      zip: files => this.zipBlob(files),
      save: (blob, name) => this.saveDownload(blob, name),
      announce: msg => this.announce(msg),
    });
    this.workspace = ws;
    $('drop').hidden = true;
    $('work').hidden = true;
    $('workspace').hidden = false;
    ws.mount();
    return ws;
  }

  // ------------------------------------------------------------ helpers

  toast(msg: string, ms = 5000): void {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout((t as unknown as { _timer?: number })._timer);
    (t as unknown as { _timer?: number })._timer = window.setTimeout(() => { t.hidden = true; }, ms);
  }

  private announce(msg: string): void {
    const a = $('announcer');
    a.textContent = '';
    window.setTimeout(() => { a.textContent = msg; }, 50);
  }

  saveDownload(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    this.downloadsInFlight.add(url);
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    // The URL has to live until the browser has started reading it; a minute is far more than needed.
    window.setTimeout(() => { URL.revokeObjectURL(url); this.downloadsInFlight.delete(url); }, 60_000);
  }

  /** Object URLs still alive, for the resource tests. */
  liveUrls(): number {
    return this.downloadsInFlight.size + this.thumbs.size + (this.zipUrl ? 1 : 0);
  }

  async tempFiles(): Promise<string[]> {
    return this.session ? listSession(this.session) : [];
  }

  private clearAll(): void {
    this.queue.clear();
    for (const url of this.thumbs.values()) URL.revokeObjectURL(url);
    this.thumbs.clear();
    if (this.zipUrl) { URL.revokeObjectURL(this.zipUrl); this.zipUrl = null; }
    this.announced.clear();
    this.announce('The list was cleared.');
    $('choose').focus();
  }

  // ------------------------------------------------------------ list

  private relist(): void {
    const ul = $('queue');
    const ids = new Set(this.queue.jobs.map(j => j.id));
    for (const [id, row] of this.rows) {
      if (!ids.has(id)) {
        row.remove();
        this.rows.delete(id);
        const t = this.thumbs.get(id);
        if (t) { URL.revokeObjectURL(t); this.thumbs.delete(id); }
      }
    }
    for (const job of this.queue.jobs) {
      if (!this.rows.has(job.id)) {
        const row = h('li', { class: 'job', 'data-id': job.id });
        this.rows.set(job.id, row);
        ul.append(row);
        this.update(job);
      }
    }
    $('work').hidden = this.queue.jobs.length === 0;
    this.refreshChrome();
  }

  private refreshChrome(): void {
    const jobs = this.queue.jobs;
    const n = jobs.length;
    $('count').textContent = n ? `(${n})` : '';
    const running = jobs.some(j => j.status === 'converting' || j.status === 'queued');
    $('cancel-all').hidden = !running;
    const convertible = jobs.filter(j => (j.status === 'ready' || j.status === 'failed' || j.status === 'canceled') && !(j.format && FORMATS[j.format].category === 'archive'));
    ($('convert-all') as HTMLButtonElement).disabled = convertible.length === 0;
    $('convert-all').textContent = convertible.length > 1 ? `Convert all (${convertible.length})` : 'Convert';
    const zip = this.queue.zipAllowed();
    const zipBtn = $<HTMLButtonElement>('zip');
    const doneCount = this.queue.outputs().length;
    zipBtn.disabled = !zip.ok || running;
    zipBtn.title = zip.reason ?? (running ? 'Wait for the conversions to finish.' : '');
    zipBtn.textContent = doneCount ? `Download all (ZIP, ${doneCount})` : 'Download all (ZIP)';
    this.renderBulkTarget();
    this.renderSettings();
  }

  private renderBulkTarget(): void {
    const ready = this.queue.jobs.filter(j => j.targets.length && j.status !== 'unsupported');
    const wrap = $('bulk-target-wrap');
    const sel = $<HTMLSelectElement>('bulk-target');
    if (ready.length < 2) { wrap.hidden = true; return; }
    const counts = new Map<FormatId, number>();
    for (const j of ready) for (const t of j.targets) counts.set(t, (counts.get(t) ?? 0) + 1);
    const opts = [...counts.entries()].filter(([, c]) => c >= 2).map(([t]) => t);
    const key = opts.join(',');
    if (sel.dataset.key !== key) {
      clear(sel);
      sel.append(h('option', { value: '' }, 'Choose'));
      for (const t of opts) sel.append(h('option', { value: t }, `${FORMATS[t].label}${counts.get(t)! < ready.length ? ` (${counts.get(t)} files)` : ''}`));
      sel.dataset.key = key;
    }
    wrap.hidden = opts.length === 0;
  }

  // ------------------------------------------------------------ rows

  /** While a job converts, only its progress changes: update those nodes and leave the buttons alone. */
  private updateProgress(job: Job, row: HTMLLIElement): boolean {
    if (job.status !== 'converting' || row.dataset.status !== 'converting') return false;
    const status = row.querySelector('.job-status');
    if (!status) return false;
    const p = status.querySelector('progress') as HTMLProgressElement | null;
    if (p && job.fraction !== undefined) p.value = job.fraction;
    const pct = status.querySelector<HTMLElement>('.pct');
    if (pct) pct.textContent = job.fraction !== undefined ? `${Math.floor(job.fraction * 100)}%` : '';
    const stage = status.querySelector<HTMLElement>('.stage');
    if (stage) stage.textContent = job.stage ?? '';
    return true;
  }

  private update(job: Job): void {
    const row = this.rows.get(job.id);
    if (!row) return;
    if (this.updateProgress(job, row)) return;
    const focused = document.activeElement && row.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    row.className = `job ${job.status}`;
    row.dataset.runs = String(job.runs);
    row.dataset.status = job.status;
    const cat = job.format ? effectiveCategory(job.format, job.traits) : null;
    const isArchive = cat === 'archive';
    clear(row);

    const icon = h('div', { class: 'job-icon', 'aria-hidden': 'true' });
    const thumb = this.thumbs.get(job.id);
    if (thumb) icon.append(h('img', { src: thumb, alt: '' }));
    else icon.textContent = cat ? ICON_TEXT[cat] : '?';

    const main = h('div', { class: 'job-main' },
      h('div', { class: 'job-name' }, job.name),
      h('div', { class: 'job-info' }, job.status === 'checking' ? `Checking, ${formatBytes(job.file.size)}` : job.info));
    // An animation converted to a still format: say so before converting, not only after.
    const still = job.traits.animated && job.target && FORMATS[job.target].category === 'image' && !ANIMATED_OUT.includes(job.target) && job.status !== 'done'
      ? [`${FORMATS[job.target].label} holds one picture, so only the first frame will be kept. Choose GIF, WebP, MP4 or WebM to keep the animation.`] : [];
    const notes = [...job.notes, ...still, ...(job.status === 'done' ? job.warnings : [])];
    if (notes.length) main.append(h('ul', { class: 'job-notes' }, ...notes.map(n => h('li', {}, n))));

    const status = h('div', { class: 'job-status' });
    const label = (s: string) => h('span', { class: 'state' }, s);
    switch (job.status) {
      case 'checking': status.append(label('Checking the file')); break;
      case 'ready': status.append(label('Ready')); break;
      case 'queued': status.append(label('Waiting')); break;
      case 'converting': {
        status.append(label(isArchive ? 'Unpacking' : 'Converting'));
        // No value means "not measurable": the bar shows activity instead of an invented percentage.
        const p = h('progress', { max: 1, 'aria-label': `Converting ${job.name}` }) as HTMLProgressElement;
        if (job.fraction !== undefined) p.value = job.fraction;
        status.append(p, h('span', { class: 'pct' }, job.fraction !== undefined ? `${Math.floor(job.fraction * 100)}%` : ''), h('span', { class: 'job-info stage' }, job.stage ?? ''));
        break;
      }
      case 'done': status.append(label(isArchive ? 'Unpacked' : `Converted to ${FORMATS[job.madeAs ?? job.target!].label}`), h('span', { class: 'job-info' }, job.summary ?? '')); break;
      case 'failed': status.append(label('Failed')); break;
      case 'canceled': status.append(label('Canceled')); break;
      case 'unsupported': status.append(label('Cannot convert')); break;
    }
    main.append(status);
    if (job.error) main.append(h('div', { class: 'job-error' }, job.error));

    const side = h('div', { class: 'job-side' });
    if (job.targets.length) {
      const sel = h('select', { 'aria-label': `Convert ${job.name} to`, 'data-key': 'target', disabled: job.status === 'converting' || job.status === 'queued' }) as HTMLSelectElement;
      for (const t of job.targets) sel.append(h('option', { value: t, selected: t === job.target }, optionLabel(t, job.traits.animated)));
      sel.addEventListener('change', () => this.queue.setTarget(job, sel.value as FormatId));
      const groupLabel = cat === 'video' && job.target && AUDIO_OUT.includes(job.target) ? 'Audio as' : 'To';
      side.append(h('label', { class: 'job-target' }, groupLabel, sel));
    }
    // Choosing a sheet: not for XLS or ODS to XLSX, which converts the whole workbook.
    if (job.format && WORKBOOKS.includes(job.format) && job.target !== 'xlsx' && job.sheets && job.sheets.length > 1) {
      const sel = h('select', { 'aria-label': `Worksheet to convert from ${job.name}`, 'data-key': 'sheet', disabled: job.status === 'converting' }) as HTMLSelectElement;
      sel.append(h('option', { value: 'first', selected: job.sheet === 'first' }, `First sheet (${job.sheets[0]})`));
      sel.append(h('option', { value: 'all', selected: job.sheet === 'all' }, job.target === 'json' ? 'All sheets, in one JSON file' : `All sheets, one ${FORMATS[job.target ?? 'csv'].label} file each`));
      for (const s of job.sheets.slice(1)) sel.append(h('option', { value: s, selected: job.sheet === s }, s));
      sel.addEventListener('change', () => { job.sheet = sel.value; if (job.status === 'done') job.status = 'ready'; this.update(job); });
      side.append(h('label', { class: 'job-target' }, 'Sheet', sel));
    }
    const actions = h('div', { class: 'job-actions' });
    if (job.status === 'ready' || job.status === 'failed' || job.status === 'canceled') {
      actions.append(h('button', { type: 'button', class: 'small primary', 'data-key': 'convert', onclick: () => this.queue.convert(job) }, job.status === 'ready' ? (isArchive ? 'Extract files' : 'Convert') : 'Try again'));
    }
    if (isArchive) { /* an unpacked archive offers its files below, not another conversion */ }
    else if (job.status === 'done' && job.target !== job.madeAs) {
      actions.append(h('button', { type: 'button', class: 'small primary', 'data-key': 'convert', onclick: () => this.queue.convert(job) }, `Convert to ${FORMATS[job.target!].label}`));
    } else if (job.status === 'done') {
      actions.append(h('button', { type: 'button', class: 'small', 'data-key': 'convert', onclick: () => this.queue.convert(job) }, 'Convert again'));
    }
    if (job.status === 'converting' || job.status === 'queued') {
      actions.append(h('button', { type: 'button', class: 'small', 'data-key': 'cancel', onclick: () => this.queue.cancel(job) }, 'Cancel'));
    }
    actions.append(h('button', { type: 'button', class: 'small ghost danger', 'data-key': 'remove', 'aria-label': `Remove ${job.name}`, onclick: () => this.removeJob(job) }, 'Remove'));
    side.append(actions);
    if (job.status === 'done' && job.outputs.length) {
      const outs = h('div', { class: 'outputs' });
      for (const o of job.outputs) {
        outs.append(h('button', { type: 'button', class: 'small primary', 'data-key': `dl-${o.name}`, title: o.name, onclick: () => this.saveDownload(o.blob, o.name) },
          h('span', {}, `Download ${o.name}`)));
      }
      side.append(outs);
    }
    row.append(icon, main, side);
    if (isArchive && job.status === 'done' && job.archive) row.append(this.archiveList(job));
    if (focused) row.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();

    if (job.status === 'done' && isArchive) {
      const key = `${job.id}:unpacked:${job.runs}`;
      if (!this.announced.has(key)) { this.announced.add(key); this.announce(`${job.name} was unpacked: ${job.summary ?? ''}.`); }
    } else if (job.status === 'done') {
      this.maybeThumb(job);
      const key = `${job.id}:${job.outputs.map(o => o.name).join(',')}`;
      if (!this.announced.has(key)) { this.announced.add(key); this.announce(`${job.name} converted to ${FORMATS[job.madeAs!].label}.`); }
    } else if (job.status === 'failed') {
      const key = `${job.id}:failed:${job.error}`;
      if (!this.announced.has(key)) { this.announced.add(key); this.announce(`${job.name} failed: ${job.error}`); }
    }
    this.refreshChrome();
  }

  /** The files of an unpacked archive: download any of them, or tick the ones to add to the list for converting. */
  private archiveList(job: Job): HTMLElement {
    const { entries, skipped } = job.archive!;
    const picked = this.picked.get(job.id) ?? new Set<number>();
    this.picked.set(job.id, picked);
    const SHOWN = 500;
    const convertible = entries.map((e, i) => e.format ? i : -1).filter(i => i >= 0);
    const add = h('button', { type: 'button', class: 'small primary', 'data-key': 'arc-add', disabled: picked.size === 0, onclick: () => {
      const added = this.queue.addFromArchive(job, [...picked]);
      picked.clear();
      this.toast(`${added.length} ${added.length === 1 ? 'file was' : 'files were'} added to the list, ready to convert.`);
      this.update(job);
    } }, picked.size ? `Add ${picked.size} to the list` : 'Add to the list');
    const all = h('button', { type: 'button', class: 'small', 'data-key': 'arc-all', disabled: convertible.length === 0, onclick: () => {
      for (const i of convertible) picked.add(i);
      this.update(job);
    } }, `Select all that can be converted (${convertible.length})`);
    const list = h('ul', { class: 'archive-list' });
    entries.slice(0, SHOWN).forEach((e, i) => {
      const box = e.format ? h('input', { type: 'checkbox', checked: picked.has(i), 'aria-label': `Select ${e.path}`, 'data-key': `arc-${i}` }) as HTMLInputElement : null;
      box?.addEventListener('change', () => { if (box.checked) picked.add(i); else picked.delete(i); this.update(job); });
      list.append(h('li', { class: e.format ? 'arc-item' : 'arc-item no-convert' },
        box ?? h('span', { class: 'arc-spacer', 'aria-hidden': 'true' }),
        h('span', { class: 'arc-path', title: e.path }, e.path),
        h('span', { class: 'job-info' }, `${e.label}, ${formatBytes(e.size)}${e.format ? '' : ', cannot be converted'}`),
        h('button', { type: 'button', class: 'small', 'data-key': `arc-dl-${i}`, 'aria-label': `Download ${e.path}`, onclick: () => this.saveDownload(e.file, e.name) }, 'Download')));
    });
    for (const s of skipped.slice(0, 50)) list.append(h('li', { class: 'arc-item skipped' }, h('span', { class: 'arc-spacer', 'aria-hidden': 'true' }), h('span', { class: 'arc-path', title: s.path }, s.path), h('span', { class: 'job-info' }, `Not unpacked: ${s.reason}`)));
    const more = entries.length > SHOWN ? h('p', { class: 'note' }, `The first ${SHOWN} of ${entries.length} files are listed. Select all adds every file that can be converted.`) : null;
    return h('details', { class: 'archive', open: true },
      h('summary', {}, `Files in ${job.name} (${entries.length})`),
      h('div', { class: 'archive-actions' }, all, add),
      list, more);
  }

  private maybeThumb(job: Job): void {
    const out = job.outputs[0];
    if (!out || !/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(out.blob.type)) return;
    if (out.blob.size > 20 * 1048576) return;
    const old = this.thumbs.get(job.id);
    if (old) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(out.blob);
    this.thumbs.set(job.id, url);
    const icon = this.rows.get(job.id)?.querySelector('.job-icon');
    if (icon) { clear(icon); icon.append(h('img', { src: url, alt: '' })); }
  }

  private removeJob(job: Job): void {
    const row = this.rows.get(job.id);
    const next = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null;
    this.queue.remove(job);
    (next?.querySelector<HTMLElement>('select, button') ?? $('choose')).focus();
    this.announce(`${job.name} was removed.`);
  }

  private async downloadZip(): Promise<void> {
    const files = this.queue.outputs().map(o => ({ name: o.name, blob: o.blob }));
    if (!files.length) return;
    const btn = $<HTMLButtonElement>('zip');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Packing ZIP...';
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const blob = await this.zipBlob(files, p => { if (p.fraction !== undefined) btn.textContent = `Packing ZIP ${Math.floor(p.fraction * 100)}%`; });
      this.saveDownload(blob, `FileConvert ${stamp}.zip`);
    } catch (e) {
      this.toast(`The ZIP could not be made: ${(e as Error).message}`);
    } finally {
      btn.textContent = label;
      this.refreshChrome();
    }
  }

  /** Packs files into a ZIP in the ZIP worker, streaming into private storage when the browser has it. */
  private zipBlob(files: Array<{ name: string; blob: Blob }>, onProgress?: (p: { fraction?: number }) => void): Promise<Blob> {
    const temp = this.session ? { session: this.session, name: `batch-${Date.now()}.zip` } : null;
    return this.zipPool.run<Blob>('zip', { files, temp }, { onProgress });
  }

  // ------------------------------------------------------------ settings

  private renderedSettingsKey = '';

  private renderSettings(): void {
    const cats = new Set<Category>();
    for (const j of this.queue.jobs) if (j.format && j.target && j.status !== 'unsupported') {
      cats.add(effectiveCategory(j.format, j.traits));
      if (FORMATS[j.target].category === 'audio') cats.add('audio');
      if (j.target === 'gif' && effectiveCategory(j.format, j.traits) === 'video') cats.add('video');
    }
    const key = [...cats].sort().join(',');
    if (key === this.renderedSettingsKey) return;
    this.renderedSettingsKey = key;
    const box = $('settings');
    const open = new Set([...box.querySelectorAll('details[open]')].map(d => (d as HTMLElement).dataset.cat));
    clear(box);
    const save = () => saveSettings(this.settings);
    const panel = (cat: Category, hint: string, ...fields: Node[]) => {
      const d = h('details', { class: 'panel', 'data-cat': cat, open: open.has(cat) }, h('summary', {}, `${CATEGORY_NAMES[cat]} settings`, h('span', { class: 'hint' }, hint)), h('div', { class: 'fields' }, ...fields));
      box.append(d);
      return d;
    };
    const select = (labelText: string, value: string | number, options: Array<[string | number, string]>, onChange: (v: string) => void) => {
      const sel = h('select', {}) as HTMLSelectElement;
      for (const [v, l] of options) sel.append(h('option', { value: String(v), selected: String(v) === String(value) }, l));
      sel.addEventListener('change', () => { onChange(sel.value); save(); });
      return h('label', { class: 'field' }, h('span', {}, labelText), sel);
    };
    const check = (labelText: string, value: boolean, onChange: (v: boolean) => void) => {
      const box = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
      box.addEventListener('change', () => { onChange(box.checked); save(); });
      return h('label', { class: 'field check' }, box, h('span', {}, labelText));
    };
    const s = this.settings;

    if (cats.has('image')) {
      const quality = h('input', { type: 'range', min: 1, max: 100, value: s.image.quality, 'aria-label': 'Quality' }) as HTMLInputElement;
      const qv = h('output', {}, String(s.image.quality));
      quality.addEventListener('input', () => { s.image.quality = Number(quality.value); qv.textContent = quality.value; });
      quality.addEventListener('change', save);
      const mode = h('select', { 'aria-label': 'Resize' }) as HTMLSelectElement;
      for (const [v, l] of [['none', 'Keep the size'], ['percent', 'Scale by percent'], ['fit', 'Fit inside a box']]) mode.append(h('option', { value: v, selected: s.image.resize.mode === v }, l));
      const pct = h('input', { type: 'number', min: 1, max: 400, value: s.image.resize.mode === 'percent' ? s.image.resize.percent : 50, 'aria-label': 'Percent' }) as HTMLInputElement;
      const bw = h('input', { type: 'number', min: 1, max: LIMITS.imageSide, value: s.image.resize.mode === 'fit' ? s.image.resize.width : 1920, 'aria-label': 'Largest width in pixels' }) as HTMLInputElement;
      const bh = h('input', { type: 'number', min: 1, max: LIMITS.imageSide, value: s.image.resize.mode === 'fit' ? s.image.resize.height : 1920, 'aria-label': 'Largest height in pixels' }) as HTMLInputElement;
      const pctRow = h('span', { class: 'row' }, pct, '%');
      const boxRow = h('span', { class: 'row' }, bw, 'x', bh, 'px');
      const sync = () => {
        pctRow.hidden = mode.value !== 'percent';
        boxRow.hidden = mode.value !== 'fit';
        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v) || lo));
        s.image.resize = mode.value === 'percent' ? { mode: 'percent', percent: clamp(Number(pct.value), 1, 400) }
          : mode.value === 'fit' ? { mode: 'fit', width: clamp(Number(bw.value), 1, LIMITS.imageSide), height: clamp(Number(bh.value), 1, LIMITS.imageSide) }
          : { mode: 'none' };
        save();
      };
      for (const el of [mode, pct, bw, bh]) el.addEventListener('change', sync);
      pctRow.hidden = s.image.resize.mode !== 'percent';
      boxRow.hidden = s.image.resize.mode !== 'fit';
      const color = h('input', { type: 'color', value: s.image.background, 'aria-label': 'Background color for transparent areas' }) as HTMLInputElement;
      color.addEventListener('change', () => { s.image.background = color.value; save(); });
      panel('image', ' Quality, size, transparency',
        h('label', { class: 'field' }, h('span', {}, 'Quality (JPG, WebP, AVIF)'), h('span', { class: 'row' }, quality, qv)),
        h('div', { class: 'field' }, h('span', {}, 'Size'), h('span', { class: 'row' }, mode, pctRow, boxRow)),
        h('label', { class: 'field' }, h('span', {}, 'Background for transparent areas (JPG, BMP)'), color),
        select('SVG size', s.image.svgSize, [['original', 'Its own size'], ['2x', 'Twice its size'], ['4x', 'Four times its size'], ['512', '512 px wide'], ['1024', '1024 px wide'], ['2048', '2048 px wide'], ['4096', '4096 px wide']], v => { s.image.svgSize = v; }),
        select('ICO sizes', s.image.ico, [['favicon', 'Favicon: 16, 32 and 48 px'], ['all', 'All: 16 to 256 px'], ['16', '16 x 16'], ['32', '32 x 32'], ['48', '48 x 48'], ['64', '64 x 64'], ['128', '128 x 128'], ['256', '256 x 256']], v => { s.image.ico = v; }),
        select('TIFF compression', s.image.tiffCompression, [['none', 'None (most compatible)'], ['lzw', 'LZW (smaller, lossless)']], v => { s.image.tiffCompression = v === 'lzw' ? 'lzw' : 'none'; }),
        select('Multi-page TIFF', s.image.tiffPages, [['all', 'Every page'], ['first', 'First page only']], v => { s.image.tiffPages = v === 'first' ? 'first' : 'all'; }));
      box.lastElementChild!.append(h('p', { class: 'note' }, 'Fit inside a box never enlarges. Metadata such as EXIF and GPS location is not copied. Orientation is applied to the pixels. An SVG is a drawing, so it is drawn at the size you choose, sharp at any size. An ICO holds each chosen size as a square picture; a picture that is not square is centered on transparency. Every page of a multi-page TIFF becomes its own file, or stays together when converting to TIFF.'));
    }
    if (cats.has('audio')) {
      panel('audio', ' Bitrate, sample rate, channels',
        select('Bitrate (MP3, AAC, M4A, OGG)', s.audio.bitrate, [[0, 'Automatic (high quality)'], [96, '96 kbit/s'], [128, '128 kbit/s'], [160, '160 kbit/s'], [192, '192 kbit/s'], [256, '256 kbit/s'], [320, '320 kbit/s']], v => { s.audio.bitrate = Number(v); }),
        select('Sample rate', s.audio.sampleRate, [[0, 'Keep the original'], [44100, '44.1 kHz'], [48000, '48 kHz']], v => { s.audio.sampleRate = Number(v); }),
        select('Channels', s.audio.channels, [[0, 'Keep the original'], [2, 'Stereo'], [1, 'Mono']], v => { s.audio.channels = Number(v); }));
      box.lastElementChild!.append(h('p', { class: 'note' }, 'OGG files use the Opus codec at 48 kHz. Audio copied from a video or between MP4, M4A and AAC is not re-encoded when no setting asks for it.'));
    }
    if (cats.has('video')) {
      panel('video', ' Resolution, quality, sound, GIF',
        select('Resolution', s.video.maxHeight, [[0, 'Keep the original'], [2160, '2160p (4K)'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']], v => { s.video.maxHeight = Number(v); }),
        select('Quality', s.video.quality, [['original', 'Original (copy when possible)'], ['very-high', 'Very high'], ['high', 'High'], ['medium', 'Medium (smaller file)'], ['low', 'Low (smallest file)']], v => { s.video.quality = v as Settings['video']['quality']; }),
        check('Remove the sound', s.video.removeAudio, v => { s.video.removeAudio = v; }),
        select('GIF width', s.video.gifWidth, [[320, '320 px'], [480, '480 px'], [640, '640 px'], [800, '800 px']], v => { s.video.gifWidth = Number(v); }),
        select('GIF frame rate', s.video.gifFps, [[5, '5 fps'], [10, '10 fps'], [15, '15 fps'], [20, '20 fps']], v => { s.video.gifFps = Number(v); }));
      box.lastElementChild!.append(h('p', { class: 'note' }, 'With Original, streams that already fit the new container are copied without re-encoding, which is fast and lossless. Videos are never enlarged.'));
    }
    if (cats.has('document')) {
      panel('document', ' Page size, text size, pictures in Markdown',
        select('Page size (PDF and DOCX)', s.document.pageSize, [['LETTER', 'US Letter'], ['A4', 'A4']], v => { s.document.pageSize = v as 'LETTER' | 'A4'; }),
        select('Text size (TXT to PDF)', s.document.fontSize, [[9, '9 pt'], [10, '10 pt'], [11, '11 pt'], [12, '12 pt']], v => { s.document.fontSize = Number(v); }),
        select('Pictures in Markdown (from DOCX or HTML)', s.document.mdPictures, [['embed', 'Inside the file'], ['files', 'Separate files, in a ZIP'], ['describe', 'Description only']], v => { s.document.mdPictures = v as 'embed' | 'files' | 'describe'; }));
    }
    if (cats.has('data')) {
      const d = s.data;
      panel('data', ' CSV, JSON and spreadsheet options',
        select('CSV separator (output)', d.delimiter, [[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab']], v => { d.delimiter = v as typeof d.delimiter; }),
        select('CSV separator (input)', d.inputDelimiter, [['auto', 'Detect'], [',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], ['|', 'Pipe']], v => { d.inputDelimiter = v as typeof d.inputDelimiter; }),
        select('Lists inside JSON records', d.arrays, [['json', 'Keep as JSON text in one cell'], ['columns', 'Spread into numbered columns']], v => { d.arrays = v as typeof d.arrays; }),
        select('Spreadsheet values (to CSV or TSV)', d.values, [['formatted', 'As shown in Excel'], ['raw', 'Underlying values']], v => { d.values = v as typeof d.values; }),
        check('First row is the header (CSV, TSV, spreadsheets)', d.header, v => { d.header = v; }),
        check('Detect numbers and true/false in CSV and TSV, and numbers in XML', d.detectTypes, v => { d.detectTypes = v; }),
        check('Rebuild nested objects from dotted column names', d.nest, v => { d.nest = v; }),
        check('Add a byte order mark to CSV and TSV (helps Excel read UTF-8)', d.bom, v => { d.bom = v; }),
        check('Protect CSV and TSV from spreadsheet formulas', d.neutralizeFormulas, v => { d.neutralizeFormulas = v; }));
      box.lastElementChild!.append(h('p', { class: 'note' }, 'Formula protection puts an apostrophe before text cells that start with = + - or @ (plain numbers such as -5 are left alone), so opening the CSV or TSV in a spreadsheet cannot run them; the result says how many cells it changed. XLSX results never need it: their text cells cannot become formulas. Numbers with leading zeros, such as ZIP codes, always stay text. JSON from a spreadsheet keeps numbers, true/false and empty cells, and writes dates as ISO 8601 text.'));
    }
  }
}
