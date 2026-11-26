// Worker pools, one per engine. A job gets a worker of its own; canceling the job terminates that worker,
// which stops the work at once and returns all of its memory to the system. Idle workers are closed after
// a short while so a page left open does not keep codecs in memory.

import { OFFLINE_MESSAGE, UPDATED_MESSAGE } from '../core/loading';
import type { RunMessage, WorkerReply } from '../core/rpc';

export class CanceledError extends Error {
  constructor() {
    super('Canceled.');
    this.name = 'CanceledError';
  }
}

export interface RunOptions {
  onProgress?: (p: { fraction?: number; stage?: string }) => void;
  signal?: AbortSignal;
}

/** `loaded` turns true when the worker reports that its code has loaded. */
interface Slot { worker: Worker; busy: boolean; loaded: boolean; idleTimer?: ReturnType<typeof setTimeout> }

const IDLE_MS = 45_000;
let nextId = 1;

export class Pool {
  private slots: Slot[] = [];
  private waiting: Array<() => void> = [];
  /** Workers created so far, for the resource tests. */
  created = 0;

  constructor(private make: () => Worker, private max: number) {}

  get active(): number { return this.slots.length; }

  private async acquire(): Promise<Slot> {
    for (;;) {
      const idle = this.slots.find(s => !s.busy);
      if (idle) {
        clearTimeout(idle.idleTimer);
        idle.busy = true;
        return idle;
      }
      if (this.slots.length < this.max) {
        const slot: Slot = { worker: this.make(), busy: true, loaded: false };
        this.created++;
        this.slots.push(slot);
        return slot;
      }
      await new Promise<void>(r => this.waiting.push(r));
    }
  }

  private release(slot: Slot, kill: boolean): void {
    if (kill) {
      slot.worker.terminate();
      this.slots = this.slots.filter(s => s !== slot);
    } else {
      slot.busy = false;
      slot.idleTimer = setTimeout(() => {
        if (!slot.busy) {
          slot.worker.terminate();
          this.slots = this.slots.filter(s => s !== slot);
        }
      }, IDLE_MS);
    }
    this.waiting.shift()?.();
  }

  async run<T>(task: string, payload: unknown, opts: RunOptions = {}, transfer: Transferable[] = []): Promise<T> {
    if (opts.signal?.aborted) throw new CanceledError();
    const slot = await this.acquire();
    if (opts.signal?.aborted) { this.release(slot, false); throw new CanceledError(); }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (kill: boolean) => {
        settled = true;
        slot.worker.onmessage = null;
        slot.worker.onerror = null;
        opts.signal?.removeEventListener('abort', onAbort);
        this.release(slot, kill);
      };
      const onAbort = () => {
        if (settled) return;
        finish(true);
        reject(new CanceledError());
      };
      opts.signal?.addEventListener('abort', onAbort);
      slot.worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        const m = ev.data;
        if (m.type === 'ready') { slot.loaded = true; return; }
        if (m.id !== id || settled) return;
        if (m.type === 'progress') opts.onProgress?.({ fraction: m.fraction, stage: m.stage });
        // A worker asks to be retired after a large picture, or when its codec keeps a large picture's memory (oxipng):
        // the next task gets a new one, which starts with nothing.
        else if (m.type === 'done') { finish(!!m.retire); resolve(m.result as T); }
        else if (m.type === 'error') {
          // A failed job may leave a codec in a bad state, so its worker is not reused.
          finish(true);
          const err = new Error(m.message);
          err.name = m.name;
          reject(err);
        }
      };
      slot.worker.onerror = (ev: ErrorEvent) => {
        if (settled) return;
        ev.preventDefault();
        finish(true);
        // A worker whose code never loaded was not downloaded: the device is offline, or this tab is older
        // than the files on the server. One that loaded and then failed most likely ran out of memory.
        reject(new Error(navigator.onLine === false ? OFFLINE_MESSAGE
          : !slot.loaded ? UPDATED_MESSAGE
          : 'The converter stopped unexpectedly. The browser may have run out of memory; try a smaller file or close other tabs.'));
      };
      slot.worker.postMessage({ type: 'run', id, task, payload } satisfies RunMessage, transfer);
    });
  }

  terminateAll(): void {
    for (const s of this.slots) { clearTimeout(s.idleTimer); s.worker.terminate(); }
    this.slots = [];
  }
}
