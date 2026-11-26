// The message protocol between the page and the conversion workers. A worker runs one job at a time; the
// page cancels a job by terminating its worker, which stops it immediately and frees all of its memory.

export interface RunMessage<T = unknown> {
  type: 'run';
  id: number;
  task: string;
  payload: T;
}

export type WorkerReply =
  /** Sent once when the worker's code has loaded, so the page can tell a failed download from a crash. */
  | { type: 'ready'; id?: undefined }
  | { type: 'progress'; id: number; fraction?: number; stage?: string }
  /** `retire`: the worker should not be used again (a codec in it holds memory it cannot give back). */
  | { type: 'done'; id: number; result: unknown; retire?: boolean }
  | { type: 'error'; id: number; name: string; message: string };

export type Progress = (p: { fraction?: number; stage?: string }) => void;

/** Installs the worker side of the protocol. `handlers` maps task names to async functions. */
export function serve(handlers: Record<string, (payload: never, progress: Progress) => Promise<{ result: unknown; transfer?: Transferable[]; retire?: boolean }>>): void {
  const scope = self as unknown as { onmessage: ((ev: MessageEvent<RunMessage>) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void };
  scope.onmessage = async (ev: MessageEvent<RunMessage>) => {
    const { id, task, payload } = ev.data;
    const progress: Progress = p => scope.postMessage({ type: 'progress', id, ...p } satisfies WorkerReply);
    try {
      const handler = handlers[task];
      if (!handler) throw new Error(`Unknown task ${task}`);
      const { result, transfer, retire } = await handler(payload as never, progress);
      scope.postMessage({ type: 'done', id, result, ...(retire ? { retire } : {}) } satisfies WorkerReply, transfer ?? []);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      scope.postMessage({ type: 'error', id, name: err.name, message: err.message || String(e) } satisfies WorkerReply);
    }
  };
  scope.postMessage({ type: 'ready' } satisfies WorkerReply);
}

/** Pulls every ArrayBuffer out of a result so it is moved, not copied, back to the page. */
export function buffersOf(...arrays: Array<Uint8Array | undefined>): Transferable[] {
  const set = new Set<ArrayBuffer>();
  for (const a of arrays) if (a && a.buffer instanceof ArrayBuffer && a.byteOffset === 0 && a.byteLength === a.buffer.byteLength) set.add(a.buffer);
  return [...set];
}
