// Temporary storage for large results. Audio and video results are written to the browser's origin private
// file system (OPFS), a sandboxed area on this device that no website and no other origin can read, so a
// multi-gigabyte result does not have to fit in memory. Each tab works in its own folder and holds a Web
// Lock for it; when a tab starts, it deletes the folders of tabs that no longer hold their lock. Results
// are deleted when they are removed from the list, when the list is cleared, and when the tab closes.

interface FileSystemSyncAccessHandle {
  write(data: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

const ROOT = 'fileconvert-temp';
const LOCK_PREFIX = 'fileconvert-session-';

/** The page can only see whether OPFS exists; sync access handles exist only inside workers, which check for themselves. */
export function hasTempStore(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

async function rootDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT, { create: true });
}

/** Page side: claims a session folder, holding its lock until the tab closes, and clears abandoned folders. */
export async function openSession(): Promise<string | null> {
  if (!hasTempStore() || !navigator.locks) return null;
  const id = crypto.randomUUID();
  await new Promise<void>(resolve => {
    navigator.locks.request(LOCK_PREFIX + id, () => {
      resolve();
      return new Promise(() => { /* held for the life of the page */ });
    });
  });
  try {
    const dir = await rootDir();
    const held = new Set(((await navigator.locks.query()).held ?? []).map(l => l.name));
    for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (name !== id && !held.has(LOCK_PREFIX + name)) await dir.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    await dir.getDirectoryHandle(id, { create: true });
  } catch {
    return null;
  }
  return id;
}

/** Worker side: a file in the session folder written at arbitrary positions through a sync access handle. */
export async function createTempFile(session: string, name: string): Promise<{ writable: WritableStream<{ data: Uint8Array; position: number }>; finish(): Promise<File>; abort(): Promise<void> }> {
  const dir = await (await rootDir()).getDirectoryHandle(session, { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  const access = await (handle as unknown as { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }).createSyncAccessHandle();
  access.truncate(0);
  let closed = false;
  const close = () => { if (!closed) { closed = true; access.flush(); access.close(); } };
  const writable = new WritableStream<{ data: Uint8Array; position: number }>({
    write(chunk) {
      let done = 0;
      while (done < chunk.data.length) {
        const n = access.write(chunk.data.subarray(done) as Uint8Array<ArrayBuffer>, { at: chunk.position + done });
        if (n <= 0) throw new Error('The browser stopped accepting data for the temporary file (the disk may be full).');
        done += n;
      }
    },
    close() { close(); },
    abort() { close(); },
  });
  return {
    writable,
    async finish() { close(); return handle.getFile(); },
    async abort() { close(); await dir.removeEntry(name).catch(() => undefined); },
  };
}

/**
 * Page side: deletes one temporary file. After a worker is terminated its file lock is released
 * asynchronously, so a locked file is retried for a few seconds.
 */
export async function deleteTempFile(session: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const dir = await (await rootDir()).getDirectoryHandle(session);
      await dir.removeEntry(name);
      return;
    } catch (e) {
      if ((e as Error).name === 'NotFoundError') return;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

/** Page side: deletes everything this tab stored. */
export async function clearSession(session: string): Promise<void> {
  try {
    const dir = await rootDir();
    await dir.removeEntry(session, { recursive: true });
    await dir.getDirectoryHandle(session, { create: true });
  } catch { /* nothing to clear */ }
}

/** Page side: names of the files currently stored for this tab (used by the tests). */
export async function listSession(session: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const dir = await (await rootDir()).getDirectoryHandle(session);
    for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) names.push(name);
  } catch { /* none */ }
  return names;
}
