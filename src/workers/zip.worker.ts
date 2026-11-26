// Builds the batch ZIP. Already-compressed results (pictures, audio, video, PDF, XLSX) are stored as they
// are; text results are deflated by the browser's own zlib (src/core/zipdeflate.ts). The archive streams into a temporary private file when the browser has
// one, so a large batch does not have to fit in memory twice.

import { Zip, ZipPassThrough } from 'fflate';
import { NativeDeflate } from '../core/zipdeflate';
import { LIMITS } from '../core/limits';
import { serve } from '../core/rpc';
import { createTempFile } from '../core/tempstore';
import { extractArchive, type ArchiveKind, type EntryWriter, type Sink } from '../engines/archive/extract';

interface Payload { files: Array<{ name: string; blob: Blob }>; temp: { session: string; name: string } | null }

const TEXT = /\.(txt|csv|json|yaml|xml|html|md)$/i;

serve({
  /** Unpacks an archive; each file goes to its own temporary private file (or memory without one). */
  async extract(p: { file: Blob; kind: ArchiveKind; name: string; temp: { session: string; prefix: string } | null }, progress) {
    let n = 0;
    const memory = (): EntryWriter => {
      const parts: Uint8Array[] = [];
      return { async write(c) { parts.push(c); }, async finish() { return new Blob(parts as Uint8Array<ArrayBuffer>[]); }, async abort() { parts.length = 0; } };
    };
    const sink: Sink = async () => {
      if (!p.temp) return memory();
      const tf = await createTempFile(p.temp.session, `${p.temp.prefix}-${n++}`);
      const w = tf.writable.getWriter();
      let position = 0;
      return {
        async write(c) { await w.write({ data: c, position }); position += c.length; },
        async finish() { await w.close(); return tf.finish(); },
        async abort() { try { await w.abort(); } catch { /* already closed */ } await tf.abort(); },
      };
    };
    const limits = { entries: LIMITS.archiveEntries, totalBytes: p.temp ? LIMITS.archiveBytes : LIMITS.archiveInMemoryBytes, ratio: LIMITS.archiveRatio, ratioFloor: LIMITS.archiveRatioFloor };
    return { result: await extractArchive(p.file, p.kind, p.name, sink, limits, fraction => progress({ fraction })) };
  },
  async zip(p: Payload, progress) {
    const total = p.files.reduce((n, f) => n + f.blob.size, 0);
    let written = 0, done = 0;
    let sink: { write(chunk: Uint8Array): void; finish(): Promise<Blob> };
    let temp: Awaited<ReturnType<typeof createTempFile>> | null = null;
    if (p.temp) {
      try { temp = await createTempFile(p.temp.session, p.temp.name); } catch { temp = null; }
    }
    if (temp) {
      const writer = temp.writable.getWriter();
      let pos = 0;
      const t = temp;
      sink = {
        write(chunk) { void writer.write({ data: chunk, position: pos }); pos += chunk.length; },
        async finish() { await writer.close(); return t.finish(); },
      };
    } else {
      const parts: Uint8Array[] = [];
      sink = { write(c) { parts.push(c); }, async finish() { return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: 'application/zip' }); } };
    }
    let failure: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) { failure = err; return; }
      sink.write(chunk);
    });
    for (const f of p.files) {
      const entry = TEXT.test(f.name) ? new NativeDeflate(f.name) : new ZipPassThrough(f.name);
      zip.add(entry);
      const reader = f.blob.stream().getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        entry.push(value, false);
        written += value.length;
        progress({ fraction: total ? written / total : 0, stage: `Adding ${f.name}` });
        if (failure) throw failure;
      }
      entry.push(new Uint8Array(0), true);
      // The next entry starts once this one's compressed data is all in the ZIP.
      if (entry instanceof NativeDeflate) await entry.done();
      if (failure) throw failure;
      done++;
    }
    zip.end();
    if (failure) throw failure;
    progress({ fraction: 1, stage: `Packed ${done} files` });
    return { result: await sink.finish() };
  },
});
