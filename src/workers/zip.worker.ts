// Builds the batch ZIP. Already-compressed results (pictures, audio, video, PDF, XLSX) are stored as they
// are; text results are deflated. The archive streams into a temporary private file when the browser has
// one, so a large batch does not have to fit in memory twice.

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { serve } from '../core/rpc';
import { createTempFile } from '../core/tempstore';

interface Payload { files: Array<{ name: string; blob: Blob }>; temp: { session: string; name: string } | null }

const TEXT = /\.(txt|csv|json|yaml|xml|html|md)$/i;

serve({
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
      const entry = TEXT.test(f.name) ? new ZipDeflate(f.name, { level: 6 }) : new ZipPassThrough(f.name);
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
      done++;
    }
    zip.end();
    if (failure) throw failure;
    progress({ fraction: 1, stage: `Packed ${done} files` });
    return { result: await sink.finish() };
  },
});
