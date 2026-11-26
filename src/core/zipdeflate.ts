// A ZIP entry deflated by the browser's own zlib (CompressionStream 'deflate-raw') for fflate's streaming Zip. fflate
// 0.8.3's streaming deflate (ZipDeflate, Zlib) was found to make invalid data for some input: rows of pixels as a PNG
// writer filters them, at levels 6 and 9, which a reader stops at with "invalid distance too far back"; its one-piece
// deflate (zlibSync, deflateSync) does not. Text results in the batch ZIP had used ZipDeflate. Where the browser has no
// CompressionStream, the entry is stored without compression instead, which is always valid.
//
// As fflate's documentation suggests for other compressors, this extends ZipPassThrough (which counts the size and the
// CRC of the data pushed) and gives it compressed data in place of the original.

import { ZipPassThrough } from 'fflate';

export class NativeDeflate extends ZipPassThrough {
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reading: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(filename: string) {
    super(filename);
    if (typeof CompressionStream !== 'function') return;
    this.compression = 8;
    const cs = new CompressionStream('deflate-raw');
    this.writer = cs.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    const reader = cs.readable.getReader();
    this.reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { this.ondata(null, new Uint8Array(0), true); return; }
          this.ondata(null, value, false);
        }
      } catch (e) {
        this.failure = e;
      }
    })();
  }

  protected process(chunk: Uint8Array, final: boolean): void {
    if (!this.writer) { super.process(chunk as Uint8Array<ArrayBuffer>, final); return; }
    if (chunk.length) void this.writer.write(chunk as Uint8Array<ArrayBuffer>).catch(e => { this.failure = e; });
    if (final) void this.writer.close().catch(e => { this.failure = e; });
  }

  /** Resolves when all of the entry's compressed data has gone to the ZIP. */
  async done(): Promise<void> {
    await this.reading;
    if (this.failure) throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
  }
}
