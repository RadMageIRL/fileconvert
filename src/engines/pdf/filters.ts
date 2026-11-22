// Streaming decoders for the PDF filters that expand their data (ISO 32000-2, 7.4), used by the guard to measure how
// large a stream becomes before any PDF library decodes it. Each stage takes input in pieces and passes its output
// on in pieces, so measuring a stream that expands to gigabytes holds only a few kilobytes at a time. A stage stops
// at its own end-of-data marker (the end of the deflate data, LZW code 257, RunLength 128, ASCII85 "~>",
// ASCIIHex ">"), never at the stream's declared /Length, so what it counts is at least what a reader could decode.

import { Inflate, Unzlib } from 'fflate';

export interface Sink {
  push(chunk: Uint8Array): void;
  end(): void;
}

/** A decoding stage: a sink that passes decoded data to the next one, and knows when its own data has ended. */
export interface Stage extends Sink {
  readonly done: boolean;
}

const CHUNK = 65536;
/** The most compressed input given to an inflater at once (see FlateStage). */
const SLICE = 4096;

/** Collects bytes and hands them on in pieces of up to 64 KB. */
class Out {
  private buf = new Uint8Array(CHUNK);
  private n = 0;
  constructor(private next: Sink) {}
  byte(b: number): void {
    this.buf[this.n++] = b;
    if (this.n === CHUNK) this.flush();
  }
  bytes(src: Uint8Array): void {
    for (let i = 0; i < src.length;) {
      const take = Math.min(CHUNK - this.n, src.length - i);
      this.buf.set(src.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === CHUNK) this.flush();
    }
  }
  flush(): void {
    if (!this.n) return;
    this.next.push(this.buf.slice(0, this.n));
    this.n = 0;
  }
}

/** FlateDecode: zlib data, or raw deflate data when the zlib header is missing (some libraries accept both). */
export class FlateStage implements Stage {
  done = false;
  private inflater: Unzlib | Inflate | null = null;
  private head = new Uint8Array(0);
  constructor(private next: Sink) {}
  push(chunk: Uint8Array): void {
    if (this.done) return;
    if (!this.inflater) {
      const joined = new Uint8Array(this.head.length + chunk.length);
      joined.set(this.head);
      joined.set(chunk, this.head.length);
      if (joined.length < 2) { this.head = joined; return; }
      const cmf = joined[0], flg = joined[1];
      const zlib = (cmf & 0x0f) === 8 && ((cmf << 8) + flg) % 31 === 0 && !(flg & 0x20);
      const ondata = (d: Uint8Array, final: boolean) => {
        if (d.length) this.next.push(d);
        if (final) this.done = true;
      };
      this.inflater = zlib ? new Unzlib(ondata) : new Inflate(ondata);
      chunk = joined;
    }
    try {
      // fflate inflates everything one push can produce in a single buffer, and deflate can expand about 1032
      // times, so input goes in 4 KB slices: no single step allocates more than about 4 MB, however the data is
      // built (a whole first layer of Flate arriving at once in a chain, for example).
      for (let i = 0; i < chunk.length && !this.done; i += SLICE) {
        this.inflater.push(chunk.subarray(i, i + SLICE), false);
        if (this.finished()) this.done = true;
      }
    } catch (e) {
      // Damaged data: a reader decodes up to the damage and stops; so does the count.
      if (isLimit(e)) throw e;
      this.done = true;
    }
  }
  /**
   * Whether the deflate data has ended: fflate's own test in its inflate loop (the final block's header was read and
   * no block is in progress). fflate's callback reports only the caller's "final" flag, not this, and once the data
   * has ended it keeps copying whatever else it is given, so feeding must stop here. fflate is pinned (0.8.3); a unit
   * test fails if this stops working.
   */
  private finished(): boolean {
    const st = (this.inflater as unknown as { s?: { f?: number; l?: unknown } } | null)?.s;
    return !!st && !!st.f && !st.l;
  }

  end(): void {
    if (this.inflater && !this.done) {
      try { this.inflater.push(new Uint8Array(0), true); } catch (e) { if (isLimit(e)) throw e; }
    }
    this.done = true;
    this.next.end();
  }
}

/** LZWDecode, with EarlyChange (1 by default, as the standard and pdf.js use). The table holds 4096 entries. */
export class LzwStage implements Stage {
  done = false;
  private out: Out;
  private prefix = new Int32Array(4096);
  private suffix = new Uint8Array(4096);
  private length = new Uint16Array(4096);
  private first = new Uint8Array(4096);
  private scratch = new Uint8Array(4096);
  private bits = 0;
  private nbits = 0;
  private codeLength = 9;
  private nextCode = 258;
  private prev = -1;
  constructor(private next: Sink, private earlyChange = 1) {
    this.out = new Out(next);
    for (let i = 0; i < 256; i++) { this.prefix[i] = -1; this.suffix[i] = i; this.length[i] = 1; this.first[i] = i; }
  }
  private emit(code: number): void {
    const n = this.length[code];
    for (let i = n - 1, c = code; i >= 0; i--, c = this.prefix[c]) this.scratch[i] = this.suffix[c];
    this.out.bytes(this.scratch.subarray(0, n));
  }
  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length && !this.done; i++) {
      this.bits = ((this.bits << 8) | chunk[i]) >>> 0;
      this.nbits += 8;
      while (this.nbits >= this.codeLength && !this.done) {
        this.nbits -= this.codeLength;
        const code = (this.bits >>> this.nbits) & ((1 << this.codeLength) - 1);
        this.bits &= (1 << this.nbits) - 1;
        if (code === 256) { this.codeLength = 9; this.nextCode = 258; this.prev = -1; continue; }
        if (code === 257 || code > this.nextCode || (code >= 258 && this.prev < 0 && code >= this.nextCode)) { this.done = true; break; }
        let firstByte: number;
        if (code < this.nextCode) {
          this.emit(code);
          firstByte = this.first[code];
        } else {
          // The code being defined right now: the previous string and its own first byte.
          firstByte = this.first[this.prev];
          this.emit(this.prev);
          this.out.byte(firstByte);
        }
        if (this.prev >= 0 && this.nextCode < 4096) {
          const c = this.nextCode++;
          this.prefix[c] = this.prev;
          this.suffix[c] = firstByte;
          this.length[c] = this.length[this.prev] + 1;
          this.first[c] = this.first[this.prev];
          const limit = this.nextCode + this.earlyChange;
          this.codeLength = limit >= 2048 ? 12 : limit >= 1024 ? 11 : limit >= 512 ? 10 : 9;
        }
        this.prev = code;
      }
    }
    this.out.flush();
  }
  end(): void {
    this.out.flush();
    this.done = true;
    this.next.end();
  }
}

/** RunLengthDecode: a length byte, then 1 to 128 literal bytes or one byte repeated up to 128 times; 128 ends. */
export class RunLengthStage implements Stage {
  done = false;
  private out: Out;
  private literal = 0;
  private repeat = 0;
  constructor(private next: Sink) { this.out = new Out(next); }
  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length && !this.done; i++) {
      const b = chunk[i];
      if (this.literal) { this.out.byte(b); this.literal--; continue; }
      if (this.repeat) { for (let k = 0; k < this.repeat; k++) this.out.byte(b); this.repeat = 0; continue; }
      if (b === 128) { this.done = true; break; }
      if (b < 128) this.literal = b + 1; else this.repeat = 257 - b;
    }
    this.out.flush();
  }
  end(): void { this.out.flush(); this.done = true; this.next.end(); }
}

/** ASCIIHexDecode: pairs of hex digits, white space ignored, ">" ends. */
export class AsciiHexStage implements Stage {
  done = false;
  private out: Out;
  private high = -1;
  constructor(private next: Sink) { this.out = new Out(next); }
  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length && !this.done; i++) {
      const c = chunk[i];
      if (c === 62) { this.done = true; break; }
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v < 0) continue;
      if (this.high < 0) this.high = v; else { this.out.byte((this.high << 4) | v); this.high = -1; }
    }
    this.out.flush();
  }
  end(): void {
    if (this.high >= 0) this.out.byte(this.high << 4);
    this.out.flush();
    this.done = true;
    this.next.end();
  }
}

/** ASCII85Decode: groups of five characters for four bytes, "z" for four zeros, "~>" ends. */
export class Ascii85Stage implements Stage {
  done = false;
  private out: Out;
  private group: number[] = [];
  constructor(private next: Sink) { this.out = new Out(next); }
  private flushGroup(final: boolean): void {
    const n = this.group.length;
    if (!n) return;
    if (final && n === 1) { this.group = []; return; }
    while (this.group.length < 5) this.group.push(84);
    let v = 0;
    for (const d of this.group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < (final ? n - 1 : 4); k++) this.out.byte(bytes[k]);
    this.group = [];
  }
  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length && !this.done; i++) {
      const c = chunk[i];
      if (c === 126) { this.flushGroup(true); this.done = true; break; }
      if (c === 122 && !this.group.length) { for (let k = 0; k < 4; k++) this.out.byte(0); continue; }
      if (c < 33 || c > 117) continue;
      this.group.push(c - 33);
      if (this.group.length === 5) this.flushGroup(false);
    }
    this.out.flush();
  }
  end(): void {
    if (!this.done) this.flushGroup(true);
    this.out.flush();
    this.done = true;
    this.next.end();
  }
}

/**
 * PNG (10 to 15) and TIFF (2) predictors. They do not expand data, but the next filter in a chain reads what they
 * produce, so a chain is followed exactly. Row sizes are checked by the caller before this is made.
 */
export class PredictorStage implements Stage {
  done = false;
  private out: Out;
  private row: Uint8Array;
  private prevRow: Uint8Array;
  private filled = 0;
  private readonly png: boolean;
  private readonly bpp: number;
  constructor(private next: Sink, predictor: number, columns: number, colors: number, bpc: number) {
    this.out = new Out(next);
    this.png = predictor >= 10;
    this.bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowBytes = Math.ceil((columns * colors * bpc) / 8);
    this.row = new Uint8Array(rowBytes + (this.png ? 1 : 0));
    this.prevRow = new Uint8Array(rowBytes);
  }
  private finishRow(): void {
    const r = this.row, prev = this.prevRow, bpp = this.bpp;
    if (this.png) {
      const type = r[0];
      const cur = r.subarray(1);
      for (let i = 0; i < cur.length; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let p = 0;
        if (type === 1) p = a; else if (type === 2) p = b; else if (type === 3) p = (a + b) >> 1;
        else if (type === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[i] = (cur[i] + p) & 255;
      }
      this.out.bytes(cur);
      prev.set(cur);
    } else {
      for (let i = bpp; i < r.length; i++) r[i] = (r[i] + r[i - bpp]) & 255;
      this.out.bytes(r);
    }
    this.filled = 0;
  }
  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length;) {
      const take = Math.min(this.row.length - this.filled, chunk.length - i);
      this.row.set(chunk.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.row.length) this.finishRow();
    }
    this.out.flush();
  }
  end(): void {
    if (this.filled) this.out.bytes(this.row.subarray(this.png ? 1 : 0, this.filled));
    this.out.flush();
    this.done = true;
    this.next.end();
  }
}

export const isLimit = (e: unknown) => !!e && typeof e === 'object' && (e as Error).name === 'LimitError';
