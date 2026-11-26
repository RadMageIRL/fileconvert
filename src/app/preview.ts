// Page previews for the PDF tools: small pictures of the pages of the one PDF a tool works on, shown in the workspace as
// a grid to choose pages from (extract, delete, rotate, PDF to JPG and PNG), to put in a new order (reorder), or to see
// which file each page goes to (split).
//
// Previews are lazy and bounded. A render worker of their own (src/workers/render.worker.ts) opens the PDF once, after
// the guard and the memory check, and draws one page at a time, only pages whose place in the grid is on screen or
// near it; at most CACHE pictures are kept, the oldest let go first. The grid holds every page as a light tile (its
// number, and the picture when there is one), which the browser lays out only near the screen. A preview that fails,
// or a PDF too large to preview on this device, leaves the tiles as numbers: choosing pages, typing them and running the
// tool never depend on a preview. The worker is stopped while a tool runs (the pictures already drawn stay) and when
// the file is removed.

import { h } from './dom';
import type { MemoryAllowance } from '../core/pdfmemory';
import type { RunMessage, WorkerReply } from '../core/rpc';

/** Pictures kept at once (each about 200 KB at most). */
const CACHE = 160;

type State = 'idle' | 'opening' | 'ready' | 'off';

/** One PDF open for previews in a worker of its own. */
export class PreviewSession {
  private worker: Worker | null = null;
  private opened: Promise<void> | null = null;
  private calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private nextId = 1;
  private wanted: number[] = [];
  private busy = false;
  /** Counts the times the worker was stopped: a request of an earlier worker does nothing when it ends. */
  private generation = 0;
  private cache = new Map<number, ImageBitmap>();
  private failed = new Set<number>();
  state: State = 'idle';
  /** Why previews are off (a refusal, or a browser that cannot draw in a worker). */
  reason = '';

  constructor(
    private make: () => Worker,
    private file: Blob,
    private assets: string,
    private allowance: () => MemoryAllowance,
    readonly side: number,
    private onPicture: (page: number) => void,
    private onState: () => void,
  ) {}

  private call<T>(task: string, payload: unknown): Promise<T> {
    const w = this.worker!;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: v => resolve(v as T), reject });
      w.postMessage({ type: 'run', id, task, payload } satisfies RunMessage);
    });
  }

  private start(): Promise<void> {
    if (this.opened) return this.opened;
    const w = this.make();
    this.worker = w;
    w.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const m = ev.data;
      // pdf.js's own parser, loaded into the worker, announces itself on the same channel; that is not ours.
      if (!m || typeof m !== 'object' || !('type' in m) || m.type === 'ready' || m.type === 'progress') return;
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (m.type === 'done') c.resolve(m.result);
      else { const e = new Error(m.message); e.name = m.name; c.reject(e); }
    };
    w.onerror = ev => {
      ev.preventDefault();
      this.fail('Previews stopped: the browser may have run out of memory. You can still choose pages here or by typing them.');
    };
    this.state = 'opening';
    this.onState();
    this.opened = this.call<{ pages: number }>('previewOpen', { file: this.file, assets: this.assets, allowance: this.allowance(), side: this.side })
      .then(() => { this.state = 'ready'; this.onState(); })
      .catch(e => {
        // Stopped while opening (a tool started running): the next request opens it again.
        if ((e as Error).name !== 'Stopped') this.fail(`Previews are off for this PDF. ${(e as Error).message} You can still choose pages here or by typing them.`);
        throw e;
      });
    return this.opened;
  }

  private fail(reason: string): void {
    this.stop();
    this.state = 'off';
    this.reason = reason.replace(/\s+/g, ' ').trim();
    this.wanted = [];
    this.onState();
  }

  /** Stops the worker and rejects what was asked of it. */
  private stop(): void {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    this.opened = null;
    const stopped = Object.assign(new Error('Stopped.'), { name: 'Stopped' });
    for (const c of this.calls.values()) c.reject(stopped);
    this.calls.clear();
    this.busy = false;
  }

  /** The picture of a page, when it has been drawn. */
  picture(page: number): ImageBitmap | undefined {
    const b = this.cache.get(page);
    if (b) { this.cache.delete(page); this.cache.set(page, b); }
    return b;
  }

  hasFailed(page: number): boolean {
    return this.failed.has(page);
  }

  /** Pages whose tiles are on screen or near it, nearest first; the others are no longer wanted. */
  want(pages: number[]): void {
    if (this.state === 'off') return;
    this.wanted = pages.filter(p => !this.cache.has(p) && !this.failed.has(p));
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.wanted.length || this.state === 'off') return;
    this.busy = true;
    const gen = this.generation;
    const current = () => gen === this.generation;
    try {
      await this.start();
      while (this.wanted.length && current()) {
        const page = this.wanted.shift()!;
        if (this.cache.has(page)) continue;
        try {
          const r = await this.call<{ bitmap: ImageBitmap }>('previewPage', { page, side: this.side });
          if (!current()) { r.bitmap.close(); return; }
          this.keep(page, r.bitmap);
          this.onPicture(page);
        } catch (e) {
          if (!current()) return;
          if ((e as Error).name === 'MemoryLimitError') { this.fail(`Previews are off for this PDF. ${(e as Error).message}`); return; }
          this.failed.add(page);
          this.onPicture(page);
        }
      }
    } catch {
      // The PDF could not be opened for previews (fail() said why), or the worker was stopped meanwhile.
    } finally {
      if (current()) this.busy = false;
    }
  }

  private keep(page: number, bitmap: ImageBitmap): void {
    this.cache.set(page, bitmap);
    while (this.cache.size > CACHE) {
      const [oldest, b] = this.cache.entries().next().value as [number, ImageBitmap];
      this.cache.delete(oldest);
      b.close();
    }
  }

  /** Lets the worker go while a tool runs; the pictures drawn so far stay, and the next request opens the PDF again. */
  suspend(): void {
    if (this.state === 'off') return;
    this.stop();
    this.state = 'idle';
  }

  dispose(): void {
    this.stop();
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
    this.state = 'off';
  }
}

/** First-page pictures kept at once (Merge PDFs takes up to 200 files; each picture is at most about 64 KB). */
const FIRST_CACHE = 200;

/**
 * The first page of each PDF in a tool that takes many (Merge PDFs), as a small picture in the file's row. Drawn the way
 * page previews are, in a render worker of its own, one file at a time and only for rows on screen or near it: each PDF
 * is checked by the guard and the memory check, opened, its first page drawn and the PDF let go, so nothing else of it
 * is drawn or kept. A file that cannot be drawn, or a browser that cannot draw in a worker, keeps a plain document tile;
 * the tool never waits for a picture. The worker is stopped while the tool runs and when the list goes.
 */
export class FirstPages {
  private worker: Worker | null = null;
  private calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private nextId = 1;
  private generation = 0;
  private busy = false;
  private wanted: Array<{ id: number; file: Blob }> = [];
  private cache = new Map<number, ImageBitmap>();
  /** Why a file has no picture, by file. */
  private failed = new Map<number, string>();
  /** Why there are no pictures at all (the browser cannot draw in a worker, or the worker stopped). */
  off = '';

  constructor(
    private make: () => Worker,
    private assets: string,
    private allowance: () => MemoryAllowance,
    readonly side: number,
    private onPicture: (id: number) => void,
  ) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = this.make();
    w.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object' || !('type' in m) || m.type === 'ready' || m.type === 'progress') return;
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (m.type === 'done') c.resolve(m.result);
      else { const e = new Error(m.message); e.name = m.name; c.reject(e); }
    };
    w.onerror = ev => {
      ev.preventDefault();
      this.off = 'First-page pictures stopped: the browser may have run out of memory. The files are merged as they are.';
      this.stop();
    };
    this.worker = w;
    return w;
  }

  private call<T>(task: string, payload: unknown): Promise<T> {
    const w = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: v => resolve(v as T), reject });
      w.postMessage({ type: 'run', id, task, payload } satisfies RunMessage);
    });
  }

  private stop(): void {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    const stopped = Object.assign(new Error('Stopped.'), { name: 'Stopped' });
    for (const c of this.calls.values()) c.reject(stopped);
    this.calls.clear();
    this.busy = false;
  }

  picture(id: number): ImageBitmap | undefined {
    return this.cache.get(id);
  }

  /** Why a file has no picture, when drawing it failed or was refused. */
  failure(id: number): string | undefined {
    return this.failed.get(id);
  }

  /** The files whose rows are on screen or near it, in list order; the others are no longer wanted. */
  want(files: Array<{ id: number; file: Blob }>): void {
    if (this.off) return;
    this.wanted = files.filter(f => !this.cache.has(f.id) && !this.failed.has(f.id));
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.off) return;
    this.busy = true;
    const gen = this.generation;
    try {
      while (this.wanted.length && gen === this.generation) {
        const f = this.wanted.shift()!;
        if (this.cache.has(f.id) || this.failed.has(f.id)) continue;
        try {
          const r = await this.call<{ bitmap: ImageBitmap }>('firstPage', { file: f.file, assets: this.assets, allowance: this.allowance(), side: this.side });
          if (gen !== this.generation) { r.bitmap.close(); return; }
          this.cache.set(f.id, r.bitmap);
          while (this.cache.size > FIRST_CACHE) {
            const [oldest, b] = this.cache.entries().next().value as [number, ImageBitmap];
            this.cache.delete(oldest);
            b.close();
          }
        } catch (e) {
          if (gen !== this.generation) return;
          const msg = (e as Error).message || 'It could not be drawn.';
          // A browser that cannot draw in a worker cannot draw any of them.
          if (/OffscreenCanvas/.test(msg)) { this.off = msg; this.stop(); this.onPicture(f.id); return; }
          this.failed.set(f.id, msg);
        }
        this.onPicture(f.id);
      }
    } finally {
      if (gen === this.generation) this.busy = false;
    }
  }

  /** The file left the list: its picture goes. */
  forget(id: number): void {
    this.cache.get(id)?.close();
    this.cache.delete(id);
    this.failed.delete(id);
    this.wanted = this.wanted.filter(f => f.id !== id);
  }

  /** Lets the worker go while the tool runs; the pictures drawn so far stay. */
  suspend(): void {
    this.stop();
    this.wanted = [];
  }

  dispose(): void {
    this.stop();
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
    this.off = 'Closed.';
  }
}

export type GridMode = 'select' | 'order' | 'view';

export interface GridState {
  pages: number;
  /** Page sizes as shown, flat [w1, h1, ...], for the shape of each tile's picture. */
  sizes?: readonly number[];
  /** Pages in the order shown (order mode), or every page in order. */
  order: readonly number[];
  /** Pages chosen (select mode). */
  selected?: ReadonlySet<number>;
  /** Word shown on chosen pages ("Removed"), or on every page by number ("File 2"). */
  mark?: string;
  labels?: ReadonlyMap<number, string>;
  /** Degrees chosen pages are turned in the preview (rotate). */
  turn?: number;
  locked: boolean;
  /** One line about the pages: "3 of 12 pages chosen". */
  status: string;
}

export interface GridHandlers {
  toggle?(pages: number[], on: boolean): void;
  all?(): void;
  none?(): void;
  move?(from: number, to: number): void;
  reverse?(): void;
  reset?(): void;
}

/** Thumbnail box, in CSS pixels. */
export const TILE = 112;

/** The page grid: one tile per page, a picture where a preview has been drawn. */
export class PageGrid {
  readonly el: HTMLElement;
  private list: HTMLOListElement;
  private statusEl: HTMLElement;
  private note: HTMLElement;
  private tiles = new Map<number, HTMLLIElement>();
  private state: GridState = { pages: 0, order: [], locked: false, status: '' };
  private session: PreviewSession | null = null;
  private visible = new Set<number>();
  private observer: IntersectionObserver | null = null;
  private active = 0;
  private anchor: number | null = null;
  private dragPos: number | null = null;

  constructor(readonly mode: GridMode, label: string, private on: GridHandlers) {
    this.list = h('ol', {
      class: `pg-grid${mode === 'order' ? ' ws-pages' : ''}`, 'aria-label': label,
      ...(mode === 'select' ? { role: 'listbox', 'aria-multiselectable': 'true', tabindex: '0' } : {}),
    }) as HTMLOListElement;
    this.statusEl = h('span', { class: 'ws-hint pg-status', 'aria-live': 'polite' });
    this.note = h('p', { class: 'ws-hint pg-note', hidden: true });
    const tools = h('div', { class: 'ws-page-tools' });
    if (mode === 'select') {
      tools.append(
        h('button', { type: 'button', class: 'small', 'data-key': 'pages-all', 'data-lock': '', onclick: () => this.on.all?.() }, 'Select all'),
        h('button', { type: 'button', class: 'small', 'data-key': 'pages-none', 'data-lock': '', onclick: () => this.on.none?.() }, 'Clear selection'));
    } else if (mode === 'order') {
      tools.append(
        h('button', { type: 'button', class: 'small', 'data-key': 'order-reverse', 'data-lock': '', onclick: () => this.on.reverse?.() }, 'Reverse'),
        h('button', { type: 'button', class: 'small', 'data-key': 'order-reset', 'data-lock': '', onclick: () => this.on.reset?.() }, 'Reset'));
    }
    this.el = h('div', { class: 'pg-box' }, this.statusEl, tools, this.note, this.list);
    if (mode === 'select') this.setupSelect();
    if (mode === 'order') this.setupDrag();
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver(entries => {
        for (const e of entries) {
          const p = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) this.visible.add(p); else this.visible.delete(p);
          // A tile that leaves the screen lets its canvas go; it is drawn again from the kept picture when it is back.
          this.paint(e.target as HTMLLIElement);
        }
        this.request();
      // Near the screen means near the grid's own scrolling area, which is at most 70% of the window tall: the tiles in
      // it and in about two rows around it. The grid draws them even while the page is scrolled elsewhere.
      }, { root: this.list, rootMargin: '300px 0px' });
    }
  }

  /** The preview session for the file now in the tool, or none. */
  setSession(s: PreviewSession | null): void {
    this.session = s;
    for (const t of this.tiles.values()) this.paint(t);
    this.renderNote();
    this.request();
  }

  /** A picture was drawn (or failed) for a page. */
  pictureReady(page: number): void {
    const t = this.tiles.get(page);
    if (t) this.paint(t);
  }

  /** The session opened, failed or stopped. */
  sessionChanged(): void {
    this.renderNote();
    this.request();
  }

  private renderNote(): void {
    const s = this.session;
    this.note.hidden = !(s && s.state === 'off' && s.reason);
    this.note.textContent = s?.reason ?? '';
  }

  /** Asks for the pictures of the tiles on screen, in the order shown. */
  private request(): void {
    if (!this.session || this.state.locked) return;
    const want = this.state.order.filter(p => this.visible.has(p) && !this.session!.picture(p));
    this.session.want(want);
  }

  update(next: GridState): void {
    const prev = this.state;
    this.state = next;
    this.statusEl.textContent = next.status;
    this.el.hidden = next.pages === 0;
    if (next.pages !== prev.pages) this.build();
    if (this.mode === 'order' && next.order.some((p, i) => this.list.children[i] !== this.tiles.get(p))) {
      for (const p of next.order) { const t = this.tiles.get(p); if (t) this.list.append(t); }
    }
    let i = 0;
    for (const p of next.order) {
      const t = this.tiles.get(p);
      if (t) this.patch(t, p, i++);
    }
    this.renderNote();
    if (!next.locked) this.request();
  }

  /** A tile for every page, in page order. */
  private build(): void {
    this.observer?.disconnect();
    this.visible.clear();
    this.tiles.clear();
    this.list.replaceChildren();
    this.active = 0;
    const n = this.state.pages;
    for (let p = 1; p <= n; p++) {
      const thumb = h('span', { class: 'pg-thumb', 'aria-hidden': 'true' }, h('span', { class: 'pg-ph' }, String(p)));
      const name = h('span', { class: 'pg-num ws-page-name' }, `Page ${p}`);
      const li = h('li', { class: `pg-tile${this.mode === 'order' ? ' ws-page' : ''}`, 'data-page': p }, thumb, name, h('span', { class: 'pg-mark' })) as HTMLLIElement;
      // Its place in the new order, shown on the picture; the page keeps its own number as its name.
      if (this.mode === 'order') li.prepend(h('span', { class: 'ws-pos pg-pos', 'aria-hidden': 'true' }));
      if (this.mode === 'select') { li.setAttribute('role', 'option'); li.id = `pg-${p}`; }
      if (this.mode === 'order') {
        li.append(h('span', { class: 'job-actions' },
          h('button', { type: 'button', class: 'small', 'data-key': `pg-up-${p}`, 'aria-label': `Move page ${p} up`, onclick: () => this.on.move?.(Number(li.dataset.pos), Number(li.dataset.pos) - 1) }, 'Up'),
          h('button', { type: 'button', class: 'small', 'data-key': `pg-down-${p}`, 'aria-label': `Move page ${p} down`, onclick: () => this.on.move?.(Number(li.dataset.pos), Number(li.dataset.pos) + 1) }, 'Down')));
      }
      this.tiles.set(p, li);
      this.list.append(li);
      this.observer?.observe(li);
    }
  }

  /** The tile's place, choice, mark, turn and picture. */
  private patch(t: HTMLLIElement, p: number, pos: number): void {
    const s = this.state;
    t.dataset.pos = String(pos);
    const chosen = s.selected?.has(p) ?? false;
    if (this.mode === 'select') {
      t.setAttribute('aria-selected', String(chosen));
      t.classList.toggle('chosen', chosen);
    }
    if (this.mode === 'order') {
      t.draggable = !s.locked;
      const [up, down] = t.querySelectorAll<HTMLButtonElement>('.job-actions button');
      up.disabled = pos === 0 || s.locked;
      down.disabled = pos === s.order.length - 1 || s.locked;
      t.querySelector('.pg-pos')!.textContent = String(pos + 1);
    }
    const mark = s.labels?.get(p) ?? (chosen && s.mark ? s.mark : '');
    const m = t.querySelector('.pg-mark')!;
    if (m.textContent !== mark) m.textContent = mark;
    t.classList.toggle('marked', !!mark);
    const turn = chosen && s.turn ? s.turn : 0;
    if (Number(t.dataset.turn ?? 0) !== turn) { t.dataset.turn = String(turn); this.paint(t); }
    if (this.mode === 'select') t.tabIndex = -1;
  }

  /** Draws the tile's picture, turned as chosen, while the tile is on screen or near it; otherwise its number. */
  private paint(t: HTMLLIElement): void {
    const p = Number(t.dataset.page);
    const box = t.querySelector<HTMLElement>('.pg-thumb')!;
    const bitmap = this.visible.has(p) ? this.session?.picture(p) : undefined;
    if (!bitmap) {
      const old = box.querySelector('canvas');
      if (old) { old.width = old.height = 0; }
      if (!box.querySelector('.pg-ph')) box.replaceChildren(h('span', { class: 'pg-ph' }, String(p)));
      box.classList.toggle('pg-failed', !!this.session?.hasFailed(p));
      return;
    }
    let canvas = box.querySelector('canvas');
    if (!canvas) { canvas = h('canvas', {}) as HTMLCanvasElement; box.replaceChildren(canvas); }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    // Fit in the square box, turned: a quarter turn swaps the sides that have to fit.
    const turn = Number(t.dataset.turn ?? 0);
    const quarter = turn === 90 || turn === 270;
    const [fw, fh] = quarter ? [bitmap.height, bitmap.width] : [bitmap.width, bitmap.height];
    const k = TILE / Math.max(fw, fh);
    canvas.style.width = `${Math.round(bitmap.width * k)}px`;
    canvas.style.height = `${Math.round(bitmap.height * k)}px`;
    canvas.style.transform = turn ? `rotate(${turn}deg)` : '';
  }

  /** Clicking, Shift-clicking and the keyboard (arrows, Home, End, Space) in select mode. */
  private setupSelect(): void {
    const tileOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLLIElement>('li.pg-tile') ?? null;
    this.list.addEventListener('click', e => {
      const t = tileOf(e.target);
      if (!t || this.state.locked) return;
      const p = Number(t.dataset.page);
      const pos = Number(t.dataset.pos);
      if (e.shiftKey && this.anchor !== null) {
        const [a, b] = [Math.min(this.anchor, pos), Math.max(this.anchor, pos)];
        this.on.toggle?.(this.state.order.slice(a, b + 1), true);
      } else {
        this.on.toggle?.([p], !(this.state.selected?.has(p) ?? false));
        this.anchor = pos;
      }
      this.focusAt(pos);
    });
    this.list.addEventListener('focus', () => this.focusAt(this.active));
    this.list.addEventListener('keydown', e => {
      const n = this.state.order.length;
      if (!n) return;
      const cols = this.columns();
      let to = this.active;
      if (e.key === 'ArrowRight') to++;
      else if (e.key === 'ArrowLeft') to--;
      else if (e.key === 'ArrowDown') to += cols;
      else if (e.key === 'ArrowUp') to -= cols;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (this.state.locked) return;
        const p = this.state.order[this.active];
        this.on.toggle?.([p], !(this.state.selected?.has(p) ?? false));
        this.anchor = this.active;
        return;
      } else return;
      e.preventDefault();
      this.focusAt(Math.max(0, Math.min(n - 1, to)));
    });
  }

  /** Tiles in a row, from where they are laid out. */
  private columns(): number {
    const first = this.list.firstElementChild as HTMLElement | null;
    if (!first) return 1;
    let n = 0;
    for (const c of this.list.children) { if ((c as HTMLElement).offsetTop !== first.offsetTop) break; n++; }
    return Math.max(1, n);
  }

  /** The active tile in select mode: the list's active descendant, scrolled into view. */
  private focusAt(pos: number): void {
    this.active = pos;
    const p = this.state.order[pos];
    const t = p ? this.tiles.get(p) : undefined;
    for (const c of this.list.querySelectorAll('.pg-active')) c.classList.remove('pg-active');
    if (!t) return;
    t.classList.add('pg-active');
    this.list.setAttribute('aria-activedescendant', t.id);
    if (document.activeElement === this.list) t.scrollIntoView({ block: 'nearest' });
  }

  /** Dragging tiles in order mode; Up and Down do the same from the keyboard. */
  private setupDrag(): void {
    const tileOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLLIElement>('li.pg-tile') ?? null;
    const clearMarks = () => this.list.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    const before = (t: HTMLElement, e: DragEvent) => {
      const r = t.getBoundingClientRect();
      // Tiles flow in rows: the left half of a tile drops before it, the right half after it.
      return e.clientX < r.left + r.width / 2;
    };
    this.list.addEventListener('dragstart', e => {
      const t = tileOf(e.target);
      if (!t || this.state.locked) return;
      this.dragPos = Number(t.dataset.pos);
      e.dataTransfer?.setData('text/plain', t.dataset.page!);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      t.classList.add('dragging');
    });
    this.list.addEventListener('dragover', e => {
      if (this.dragPos === null) return;
      e.preventDefault();
      clearMarks();
      const t = tileOf(e.target);
      if (t) t.classList.add(before(t, e) ? 'drop-before' : 'drop-after');
    });
    this.list.addEventListener('drop', e => {
      if (this.dragPos === null) return;
      e.preventDefault();
      e.stopPropagation();
      const from = this.dragPos;
      this.dragPos = null;
      clearMarks();
      this.list.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
      const t = tileOf(e.target);
      if (!t) return;
      let to = Number(t.dataset.pos) + (before(t, e) ? 0 : 1);
      if (to > from) to--;
      if (to !== from) this.on.move?.(from, to);
    });
    this.list.addEventListener('dragend', () => {
      this.dragPos = null;
      clearMarks();
      this.list.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    });
  }

  /** Live canvases, for the tests of the bound. */
  canvases(): number {
    return this.list.querySelectorAll('canvas').length;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.session = null;
  }
}
