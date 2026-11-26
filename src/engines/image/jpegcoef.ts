// Lossless JPEG optimization. A JPEG's quantized DCT coefficients are read from its entropy-coded data and written
// again with Huffman tables made for this picture, as a baseline or a progressive JPEG, the way jpegtran -optimize
// [-progressive] does. Nothing is decoded to pixels: the coefficients, the quantization tables, the components and their
// sampling are copied exactly, so every decoder draws the same pixels from the result as from the original.
//
// Read: baseline, extended sequential and progressive Huffman-coded JPEGs with 8-bit samples and 1 to 4 components, with
// or without restart intervals. Refused with the reason: arithmetic coding, 12-bit samples, lossless and hierarchical
// JPEG, a height given only after the picture (DNL), and damaged or cut-short data (a scan that runs into a marker, a
// code no table has, a value 8-bit JPEG cannot hold). The result has no restart markers.

/** Raised for a JPEG this cannot optimize without loss, with the reason in plain words. */
export class JpegCoefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JpegCoefError';
  }
}

const fail = (why: string): never => { throw new JpegCoefError(why); };
const DAMAGED = 'This JPEG is damaged or cut short, so it cannot be optimized without loss.';

export interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Blocks across and down that hold the component's own samples, and the blocks kept (whole MCUs). */
  bw: number;
  bh: number;
  allocW: number;
  allocH: number;
  /** 64 coefficients per block, in zigzag order, block rows of allocW blocks. */
  coef: Int16Array;
}

export interface Frame {
  progressive: boolean;
  width: number;
  height: number;
  comps: Component[];
  hmax: number;
  vmax: number;
  mcusX: number;
  mcusY: number;
  /** The quantization tables the components use, by table number: 64 values in zigzag order, and 16-bit or not. */
  qt: Map<number, { values: Uint16Array; wide: boolean }>;
}

/** A marker segment kept from the file (APPn and COM), whole, marker included, in the order found. */
export interface Segment { marker: number; bytes: Uint8Array }

export interface ParsedJpeg {
  frame: Frame;
  segments: Segment[];
  /** Where the end marker ends: what follows is data after the picture. */
  end: number;
  /** The file had restart markers. */
  restarts: boolean;
  scans: number;
}

// ------------------------------------------------------------------ Huffman decoding

interface DecodeTable { look: Int32Array; maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }

function decodeTable(counts: Uint8Array, values: Uint8Array): DecodeTable {
  const look = new Int32Array(512);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1];
    valptr[len] = k;
    mincode[len] = code;
    for (let i = 0; i < n; i++, k++, code++) {
      if (len <= 9) {
        const base = code << (9 - len);
        for (let j = 0; j < 1 << (9 - len); j++) look[base | j] = (len << 8) | values[k];
      }
    }
    maxcode[len] = n ? code - 1 : -1;
    if (code > 1 << len) fail(DAMAGED);
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { look, maxcode, valptr, mincode, values };
}

/** Reads the entropy-coded data bit by bit: stuffed zero bytes are skipped, and at a marker only zero bits come, which
 *  is counted, so data that runs into a marker is caught as damage. */
class BitReader {
  buf = 0;
  cnt = 0;
  /** Zero bytes given in place of data past a marker. */
  padded = 0;
  constructor(private b: Uint8Array, public pos: number) {}

  private fill(): void {
    while (this.cnt <= 24) {
      let byte = 0;
      const b = this.b;
      if (this.pos < b.length && b[this.pos] !== 0xff) { this.starts[this.loads++ & 15] = this.pos; byte = b[this.pos++]; }
      else if (this.pos + 1 < b.length && b[this.pos] === 0xff && b[this.pos + 1] === 0x00) { this.starts[this.loads++ & 15] = this.pos; byte = 0xff; this.pos += 2; }
      else this.padded++;
      this.buf = ((this.buf << 8) | byte) >>> 0;
      this.cnt += 8;
    }
  }

  bit(): number {
    if (this.cnt < 1) this.fill();
    this.cnt--;
    return (this.buf >>> this.cnt) & 1;
  }

  bits(n: number): number {
    if (!n) return 0;
    if (this.cnt < n) this.fill();
    this.cnt -= n;
    return (this.buf >>> this.cnt) & ((1 << n) - 1);
  }

  decode(t: DecodeTable): number {
    if (this.cnt < 16) this.fill();
    const v = t.look[(this.buf >>> (this.cnt - 9)) & 511];
    if (v) { this.cnt -= v >> 8; return v & 255; }
    let len = 10;
    let code = (this.buf >>> (this.cnt - 10)) & 1023;
    while (code > t.maxcode[len]) {
      len++;
      if (len > 16) fail(DAMAGED);
      code = (this.buf >>> (this.cnt - len)) & ((1 << len) - 1);
    }
    this.cnt -= len;
    return t.values[t.valptr[len] + code - t.mincode[len]];
  }

  /** Data was taken past a marker: the scan is damaged or cut short. */
  overrun(): boolean {
    return this.padded * 8 > this.cnt;
  }

  /** Where each of the last bytes loaded starts in the file (a stuffed 0xFF takes two), to give back what is unread. */
  private starts = new Int32Array(16);
  private loads = 0;

  /** Lets the rest of the current byte go and returns where the data stands: at the next marker when it is whole. */
  align(): number {
    if (this.overrun()) fail(DAMAGED);
    const unread = (this.cnt >> 3) - this.padded;
    if (unread > 0) this.pos = this.starts[(this.loads - unread) & 15];
    this.buf = 0; this.cnt = 0; this.padded = 0;
    return this.pos;
  }
}

const extend = (v: number, s: number) => (v < 1 << (s - 1) ? v - (1 << s) + 1 : v);

// ------------------------------------------------------------------ reading

const u16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];

/** The blocks of one scan in the order they are coded: [component, block index] pairs, MCU by MCU. */
function scanOrder(f: Frame, comps: Component[]): { mcus: number; blocks: (mcu: number, visit: (c: Component, ci: number, block: number) => void) => void } {
  if (comps.length === 1) {
    const c = comps[0];
    return { mcus: c.bw * c.bh, blocks: (m, visit) => visit(c, 0, ((Math.floor(m / c.bw)) * c.allocW + (m % c.bw)) * 64) };
  }
  return {
    mcus: f.mcusX * f.mcusY,
    blocks: (m, visit) => {
      const my = Math.floor(m / f.mcusX), mx = m % f.mcusX;
      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci];
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) visit(c, ci, ((my * c.v + v) * c.allocW + mx * c.h + h) * 64);
      }
    },
  };
}

/** Reads a JPEG's segments and its coefficients. Throws JpegCoefError with the reason when it cannot be done exactly. */
export function readJpegCoefficients(b: Uint8Array, maxPixels = 100_000_000): ParsedJpeg {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) fail('This is not a JPEG file.');
  const segments: Segment[] = [];
  const dc: Array<DecodeTable | null> = [null, null, null, null];
  const ac: Array<DecodeTable | null> = [null, null, null, null];
  const qt = new Map<number, { values: Uint16Array; wide: boolean }>();
  let frame: Frame | null = null;
  let restart = 0, restarts = false, scans = 0, end = -1;
  let p = 2;
  while (p < b.length) {
    if (b[p] !== 0xff) fail(DAMAGED);
    let m = b[p + 1];
    while (m === 0xff && p + 2 < b.length) { p++; m = b[p + 1]; }
    if (m === 0xd9) { end = p + 2; break; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    if (p + 4 > b.length) fail(DAMAGED);
    const len = u16(b, p + 2);
    const s = p + 4, e = p + 2 + len;
    if (len < 2 || e > b.length) fail(DAMAGED);
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) segments.push({ marker: m, bytes: b.subarray(p, e) });
    else if (m === 0xdb) {
      if (frame && scans) fail('This JPEG changes a quantization table after its first scan, which this tool does not optimize.');
      for (let q = s; q < e;) {
        const pq = b[q] >> 4, tq = b[q] & 15;
        if (pq > 1 || tq > 3) fail(DAMAGED);
        const values = new Uint16Array(64);
        for (let i = 0; i < 64; i++) values[i] = pq ? u16(b, q + 1 + 2 * i) : b[q + 1 + i];
        if (values.some(v => v === 0)) fail(DAMAGED);
        qt.set(tq, { values, wide: pq === 1 });
        q += 1 + (pq ? 128 : 64);
        if (q > e) fail(DAMAGED);
      }
    } else if (m === 0xc4) {
      for (let q = s; q < e;) {
        const tc = b[q] >> 4, th = b[q] & 15;
        if (tc > 1 || th > 3 || q + 17 > e) fail(DAMAGED);
        const counts = b.subarray(q + 1, q + 17);
        const n = counts.reduce((x, y) => x + y, 0);
        if (n > 256 || q + 17 + n > e) fail(DAMAGED);
        const t = decodeTable(counts, b.subarray(q + 17, q + 17 + n));
        (tc ? ac : dc)[th] = t;
        q += 17 + n;
      }
    } else if (m === 0xdd) { restart = u16(b, s); if (restart) restarts = true; }
    else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (frame) fail(DAMAGED);
      if (b[s] !== 8) fail(`This JPEG has ${b[s]}-bit samples; lossless optimization supports 8-bit JPEG only.`);
      const height = u16(b, s + 1), width = u16(b, s + 3), nf = b[s + 5];
      if (!height) fail('This JPEG gives its height after the picture (DNL), which this tool does not read.');
      if (!width || !nf) fail(DAMAGED);
      if (nf > 4) fail(`This JPEG has ${nf} color components; lossless optimization supports 1 to 4.`);
      if (width * height > maxPixels) fail(`This JPEG is ${width.toLocaleString('en-US')} x ${height.toLocaleString('en-US')} pixels, more than the ${(maxPixels / 1e6).toFixed(0)} megapixels allowed.`);
      const raw: Array<{ id: number; h: number; v: number; tq: number }> = [];
      for (let i = 0; i < nf; i++) {
        const q = s + 6 + 3 * i;
        const h = b[q + 1] >> 4, v = b[q + 1] & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4 || b[q + 2] > 3) fail(DAMAGED);
        if (raw.some(x => x.id === b[q])) fail(DAMAGED);
        raw.push({ id: b[q], h, v, tq: b[q + 2] });
      }
      const hmax = Math.max(...raw.map(c => c.h)), vmax = Math.max(...raw.map(c => c.v));
      const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
      const comps: Component[] = raw.map(c => {
        const bw = Math.ceil(Math.ceil((width * c.h) / hmax) / 8), bh = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
        const allocW = mcusX * c.h, allocH = mcusY * c.v;
        return { ...c, bw, bh, allocW, allocH, coef: new Int16Array(allocW * allocH * 64) };
      });
      frame = { progressive: m === 0xc2, width, height, comps, hmax, vmax, mcusX, mcusY, qt: new Map() };
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      fail(m >= 0xc9 ? 'This JPEG uses arithmetic coding, which lossless optimization does not read.' : m === 0xc3 ? 'This is a lossless JPEG (a rare kind), which this tool does not optimize.' : 'This is a hierarchical JPEG (a rare kind), which this tool does not optimize.');
    } else if (m === 0xcc) fail('This JPEG uses arithmetic coding, which lossless optimization does not read.');
    else if (m === 0xdc) fail('This JPEG gives its height after the picture (DNL), which this tool does not read.');
    else if (m === 0xda) {
      if (!frame) fail(DAMAGED);
      const f = frame!;
      const ns = b[s];
      if (ns < 1 || ns > 4 || s + 1 + 2 * ns + 3 > e) fail(DAMAGED);
      const comps: Component[] = [], tds: number[] = [], tas: number[] = [];
      for (let i = 0; i < ns; i++) {
        const c = f.comps.find(x => x.id === b[s + 1 + 2 * i]);
        if (!c || comps.includes(c)) fail(DAMAGED);
        comps.push(c!);
        tds.push(b[s + 2 + 2 * i] >> 4);
        tas.push(b[s + 2 + 2 * i] & 15);
      }
      const q = s + 1 + 2 * ns;
      const ss = b[q], se = b[q + 1], ah = b[q + 2] >> 4, al = b[q + 2] & 15;
      for (const c of comps) {
        if (!f.qt.has(c.tq)) {
          const t = qt.get(c.tq);
          if (!t) fail(DAMAGED);
          f.qt.set(c.tq, t!);
        }
      }
      p = e;
      p = decodeScan(b, p, f, comps, tds.map(t => dc[t]), tas.map(t => ac[t]), { ss, se, ah, al }, restart);
      scans++;
      continue;
    }
    p = e;
  }
  if (!frame) fail('No picture was found in this JPEG.');
  if (end < 0) fail('This JPEG is cut short: it has no end marker, so it cannot be optimized without loss.');
  if (!scans) fail(DAMAGED);
  // Every table a component uses was defined; values stay within what 8-bit JPEG holds (DC 11 bits, AC 10).
  for (const c of frame!.comps) {
    if (!frame!.qt.has(c.tq)) fail(DAMAGED);
    const k = c.coef;
    for (let i = 0; i < k.length; i += 64) {
      if (k[i] > 2047 || k[i] < -2048) fail('This JPEG holds values outside what 8-bit JPEG allows; it may be damaged.');
      for (let j = 1; j < 64; j++) if (k[i + j] > 1023 || k[i + j] < -1023) fail('This JPEG holds values outside what 8-bit JPEG allows; it may be damaged.');
    }
  }
  return { frame: frame!, segments, end, restarts, scans };
}

function decodeScan(b: Uint8Array, start: number, f: Frame, comps: Component[], dcT: Array<DecodeTable | null>, acT: Array<DecodeTable | null>, sp: { ss: number; se: number; ah: number; al: number }, restart: number): number {
  const { ss, se, ah, al } = sp;
  if (f.progressive) {
    if (ss > se || se > 63 || (ss === 0 && se !== 0) || (ss > 0 && comps.length !== 1) || al > 13 || (ah && ah !== al + 1)) fail(DAMAGED);
  } else if (ss !== 0 || se !== 63 || ah || al) fail(DAMAGED);
  const needDc = !f.progressive || (ss === 0 && ah === 0);
  const needAc = !f.progressive || ss > 0;
  for (let i = 0; i < comps.length; i++) {
    if (needDc && !dcT[i]) fail(DAMAGED);
    if (needAc && !acT[i] && (!f.progressive || ss > 0)) fail(DAMAGED);
  }
  const br = new BitReader(b, start);
  const pred = new Int32Array(comps.length);
  let eobrun = 0;
  const order = scanOrder(f, comps);
  const p1 = 1 << al, m1 = -p1;
  let rst = 0;
  const visit = (c: Component, ci: number, at: number) => {
    const k = c.coef;
    if (!f.progressive) {
      let s = br.decode(dcT[ci]!);
      if (s > 11) fail(DAMAGED);
      const diff = s ? extend(br.bits(s), s) : 0;
      pred[ci] += diff;
      k[at] = pred[ci];
      const t = acT[ci]!;
      for (let j = 1; j < 64; j++) {
        const rs = br.decode(t);
        const r = rs >> 4;
        s = rs & 15;
        if (s) {
          j += r;
          if (j > 63 || s > 10) fail(DAMAGED);
          k[at + j] = extend(br.bits(s), s);
        } else {
          if (r !== 15) break;
          j += 15;
        }
      }
      return;
    }
    if (ss === 0) {
      if (ah === 0) {
        const s = br.decode(dcT[ci]!);
        if (s > 11) fail(DAMAGED);
        pred[ci] += s ? extend(br.bits(s), s) : 0;
        k[at] = pred[ci] * p1;
      } else if (br.bit()) k[at] |= p1;
      return;
    }
    const t = acT[ci]!;
    if (ah === 0) {
      if (eobrun > 0) { eobrun--; return; }
      for (let j = ss; j <= se; j++) {
        const rs = br.decode(t);
        const r = rs >> 4, s = rs & 15;
        if (s) {
          j += r;
          if (j > se || s > 10) fail(DAMAGED);
          k[at + j] = extend(br.bits(s), s) * p1;
        } else if (r === 15) j += 15;
        else {
          eobrun = (1 << r) - 1;
          if (r) eobrun += br.bits(r);
          break;
        }
      }
      return;
    }
    // AC refinement (ITU T.81 G.1.2.3, as libjpeg reads it).
    let j = ss;
    if (eobrun === 0) {
      for (; j <= se; j++) {
        const rs = br.decode(t);
        let r = rs >> 4;
        let s = rs & 15;
        if (s) {
          if (s !== 1) fail(DAMAGED);
          s = br.bit() ? p1 : m1;
        } else if (r !== 15) {
          eobrun = 1 << r;
          if (r) eobrun += br.bits(r);
          break;
        }
        do {
          const v = k[at + j];
          if (v !== 0) {
            if (br.bit() && (v & p1) === 0) k[at + j] = v >= 0 ? v + p1 : v + m1;
          } else if (--r < 0) break;
          j++;
        } while (j <= se);
        if (s) {
          if (j > se) fail(DAMAGED);
          k[at + j] = s;
        }
      }
    }
    if (eobrun > 0) {
      for (; j <= se; j++) {
        const v = k[at + j];
        if (v !== 0 && br.bit() && (v & p1) === 0) k[at + j] = v >= 0 ? v + p1 : v + m1;
      }
      eobrun--;
    }
  };
  for (let m = 0; m < order.mcus; m++) {
    if (restart && m > 0 && m % restart === 0) {
      // A restart marker: the data is byte-aligned, the predictions and the end-of-band run start again.
      const q = nextMarker(b, br.align());
      if (b[q + 1] !== (0xd0 | (rst & 7))) fail(DAMAGED);
      rst++;
      br.pos = q + 2;
      pred.fill(0);
      eobrun = 0;
    }
    order.blocks(m, visit);
  }
  // The scan ends at the next marker (stray bytes before it, which decoders skip, are left out); a restart marker after
  // the last interval is allowed.
  let q = nextMarker(b, br.align());
  while (q + 1 < b.length && b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7) q = nextMarker(b, q + 2);
  if (q + 1 >= b.length) fail('This JPEG is cut short: it has no end marker, so it cannot be optimized without loss.');
  return q;
}

/** Where the next marker starts: a 0xFF that is not a stuffed zero byte (fill bytes 0xFF before it included). */
function nextMarker(b: Uint8Array, q: number): number {
  while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0x00 && b[q + 1] !== 0xff)) q++;
  return q;
}

// ------------------------------------------------------------------ Huffman encoding

/** Optimal code lengths for these symbol counts, at most 16 bits (ITU T.81 K.2 and K.3, as libjpeg makes them). */
export function optimalTable(freq: Int32Array): { counts: Uint8Array; values: Uint8Array } {
  const f = new Float64Array(257);
  for (let i = 0; i < 256; i++) f[i] = freq[i];
  // A table no symbol uses still needs one code.
  if (!f.some(x => x > 0)) f[0] = 1;
  f[256] = 1; // a code point no symbol gets, so no code is all ones
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v) { v = f[i]; c1 = i; }
    let c2 = -1;
    v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v && i !== c1) { v = f[i]; c2 = i; }
    if (c2 < 0) break;
    f[c1] += f[c2];
    f[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }
  const bits = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  let i = 16;
  while (bits[i] === 0) i--;
  bits[i]--; // the reserved code point
  const values: number[] = [];
  for (let len = 1; len <= 32; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) values.push(s);
  const counts = new Uint8Array(16);
  for (let len = 1; len <= 16; len++) counts[len - 1] = bits[len];
  return { counts, values: Uint8Array.from(values) };
}

interface EncodeTable { code: Uint16Array; size: Uint8Array }

function encodeTable(t: { counts: Uint8Array; values: Uint8Array }): EncodeTable {
  const code = new Uint16Array(256), size = new Uint8Array(256);
  let c = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < t.counts[len - 1]; i++, k++) { code[t.values[k]] = c++; size[t.values[k]] = len; }
    c <<= 1;
  }
  return { code, size };
}

/** Writes bits with 0xFF bytes stuffed. */
class BitWriter {
  private out: Uint8Array;
  private n = 0;
  private buf = 0;
  private cnt = 0;
  constructor(capacity: number) { this.out = new Uint8Array(Math.max(1024, capacity)); }
  private byte(v: number): void {
    if (this.n + 2 > this.out.length) { const o = new Uint8Array(this.out.length * 2); o.set(this.out); this.out = o; }
    this.out[this.n++] = v;
    if (v === 0xff) this.out[this.n++] = 0;
  }
  bits(v: number, n: number): void {
    if (!n) return;
    this.buf = ((this.buf << n) | (v & ((1 << n) - 1))) >>> 0;
    this.cnt += n;
    while (this.cnt >= 8) { this.cnt -= 8; this.byte((this.buf >>> this.cnt) & 255); }
  }
  /** Pads the last byte with ones, as JPEG asks. */
  flush(): void {
    if (this.cnt) this.bits(0x7f, 8 - this.cnt);
    this.buf = 0;
  }
  bytes(): Uint8Array { return this.out.subarray(0, this.n); }
}

const bitLength = (v: number) => (v ? 32 - Math.clz32(v) : 0);

interface Scan { comps: number[]; ss: number; se: number; ah: number; al: number }

/** The scans of the result: one sequential scan (or one per component where an MCU would hold more than 10 blocks), or
 *  libjpeg's progressive script (jpeg_simple_progression), which jpegtran -progressive also uses. */
function scansFor(f: Frame, progressive: boolean): Scan[] {
  const n = f.comps.length;
  const all = Array.from({ length: n }, (_, i) => i);
  const blocks = f.comps.reduce((k, c) => k + c.h * c.v, 0);
  const interleave = n === 1 || blocks <= 10;
  if (!progressive) return interleave ? [{ comps: all, ss: 0, se: 63, ah: 0, al: 0 }] : all.map(c => ({ comps: [c], ss: 0, se: 63, ah: 0, al: 0 }));
  const dc = (ah: number, al: number): Scan[] => interleave ? [{ comps: all, ss: 0, se: 0, ah, al }] : all.map(c => ({ comps: [c], ss: 0, se: 0, ah, al }));
  const ac = (c: number, ss: number, se: number, ah: number, al: number): Scan => ({ comps: [c], ss, se, ah, al });
  if (n === 3) {
    return [...dc(0, 1), ac(0, 1, 5, 0, 2), ac(2, 1, 63, 0, 1), ac(1, 1, 63, 0, 1), ac(0, 6, 63, 0, 2), ac(0, 1, 63, 2, 1), ...dc(1, 0), ac(2, 1, 63, 1, 0), ac(1, 1, 63, 1, 0), ac(0, 1, 63, 1, 0)];
  }
  return [...dc(0, 1), ...all.map(c => ac(c, 1, 5, 0, 2)), ...all.map(c => ac(c, 6, 63, 0, 2)), ...all.map(c => ac(c, 1, 63, 2, 1)), ...dc(1, 0), ...all.map(c => ac(c, 1, 63, 1, 0))];
}

const MAX_CORR_BITS = 1000;

/** Codes one scan: counting symbols (`sink.count`) or writing them. */
function codeScan(f: Frame, scan: Scan, sink: { dc(ci: number, sym: number): void; ac(sym: number): void; bits(v: number, n: number): void }): void {
  const comps = scan.comps.map(i => f.comps[i]);
  const order = scanOrder(f, comps);
  const { ss, se, ah, al } = scan;
  const pred = new Int32Array(comps.length);
  let eobrun = 0;
  // Correction bits waiting for the end-of-band run they belong to (refinement scans).
  const corr = new Uint8Array(MAX_CORR_BITS + 64);
  let be = 0;
  const emitEob = () => {
    if (!eobrun) return;
    const nbits = bitLength(eobrun) - 1;
    sink.ac(nbits << 4);
    sink.bits(eobrun, nbits);
    eobrun = 0;
    for (let i = 0; i < be; i++) sink.bits(corr[i], 1);
    be = 0;
  };
  const abs = new Int32Array(64);
  const visit = (c: Component, ci: number, at: number) => {
    const k = c.coef;
    if (ss === 0 && se === 63) {
      // Sequential.
      const v = k[at], diff = v - pred[ci];
      pred[ci] = v;
      const t = diff < 0 ? -diff : diff, nb = bitLength(t);
      sink.dc(ci, nb);
      sink.bits(diff < 0 ? diff - 1 : diff, nb);
      let r = 0;
      for (let j = 1; j < 64; j++) {
        const x = k[at + j];
        if (x === 0) { r++; continue; }
        while (r > 15) { sink.ac(0xf0); r -= 16; }
        const a = x < 0 ? -x : x, n = bitLength(a);
        sink.ac((r << 4) | n);
        sink.bits(x < 0 ? x - 1 : x, n);
        r = 0;
      }
      if (r > 0) sink.ac(0);
      return;
    }
    if (ss === 0) {
      if (ah === 0) {
        const v = k[at] >> al, diff = v - pred[ci];
        pred[ci] = v;
        const t = diff < 0 ? -diff : diff, nb = bitLength(t);
        sink.dc(ci, nb);
        sink.bits(diff < 0 ? diff - 1 : diff, nb);
      } else sink.bits((k[at] >> al) & 1, 1);
      return;
    }
    if (ah === 0) {
      let r = 0;
      for (let j = ss; j <= se; j++) {
        let x = k[at + j];
        if (x === 0) { r++; continue; }
        let t2: number;
        if (x < 0) { x = (-x) >> al; t2 = ~x; } else { x >>= al; t2 = x; }
        if (x === 0) { r++; continue; }
        emitEob();
        while (r > 15) { sink.ac(0xf0); r -= 16; }
        const n = bitLength(x);
        sink.ac((r << 4) | n);
        sink.bits(t2, n);
        r = 0;
      }
      if (r > 0) { eobrun++; if (eobrun === 0x7fff) emitEob(); }
      return;
    }
    // AC refinement (libjpeg's encode_mcu_AC_refine).
    let eob = 0;
    for (let j = ss; j <= se; j++) {
      const x = k[at + j];
      const a = (x < 0 ? -x : x) >> al;
      abs[j] = a;
      if (a === 1) eob = j;
    }
    let r = 0, br = 0, brStart = be;
    for (let j = ss; j <= se; j++) {
      const a = abs[j];
      if (a === 0) { r++; continue; }
      while (r > 15 && j <= eob) {
        emitEob();
        sink.ac(0xf0);
        r -= 16;
        for (let i = 0; i < br; i++) sink.bits(corr[brStart + i], 1);
        brStart = be; br = 0;
      }
      if (a > 1) { corr[brStart + br++] = a & 1; continue; }
      emitEob();
      sink.ac((r << 4) | 1);
      sink.bits(k[at + j] < 0 ? 0 : 1, 1);
      for (let i = 0; i < br; i++) sink.bits(corr[brStart + i], 1);
      brStart = be; br = 0;
      r = 0;
    }
    if (r > 0 || br > 0) {
      eobrun++;
      be += br;
      if (eobrun === 0x7fff || be > MAX_CORR_BITS - 64 + 1) emitEob();
    }
  };
  for (let m = 0; m < order.mcus; m++) order.blocks(m, visit);
  emitEob();
}

/** The segments of a JPEG with these coefficients: tables, frame and scans, between `head` (SOI and the segments to
 *  keep) and the end marker. Huffman tables are made for each scan's own symbols. */
export function writeJpegCoefficients(f: Frame, keep: readonly Segment[], progressive: boolean): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  for (const s of keep) parts.push(s.bytes);
  // Quantization tables, as they were.
  for (const [tq, t] of [...f.qt.entries()].sort((a, b) => a[0] - b[0])) {
    const body = new Uint8Array(1 + (t.wide ? 128 : 64));
    body[0] = (t.wide ? 0x10 : 0) | tq;
    for (let i = 0; i < 64; i++) {
      if (t.wide) { body[1 + 2 * i] = t.values[i] >> 8; body[2 + 2 * i] = t.values[i] & 255; } else body[1 + i] = t.values[i];
    }
    parts.push(segment(0xdb, body));
  }
  const wide = [...f.qt.values()].some(t => t.wide);
  const sof = progressive ? 0xc2 : wide ? 0xc1 : 0xc0;
  const fh = new Uint8Array(6 + 3 * f.comps.length);
  fh[0] = 8; fh[1] = f.height >> 8; fh[2] = f.height & 255; fh[3] = f.width >> 8; fh[4] = f.width & 255; fh[5] = f.comps.length;
  f.comps.forEach((c, i) => { fh[6 + 3 * i] = c.id; fh[7 + 3 * i] = (c.h << 4) | c.v; fh[8 + 3 * i] = c.tq; });
  parts.push(segment(sof, fh));
  const capacity = f.comps.reduce((k, c) => k + c.coef.length, 0) / 2;
  const noop = () => undefined;
  for (const scan of scansFor(f, progressive)) {
    const seq = scan.ss === 0 && scan.se === 63;
    const dcScan = !seq && scan.ss === 0;
    const refineDc = dcScan && scan.ah > 0;
    // Table numbers: the first component's 0, the others 1 (baseline allows two of each kind).
    const tableOf = (ci: number) => (scan.comps[ci] === 0 ? 0 : 1);
    const used = [0, 1].filter(t => scan.comps.some((_, ci) => tableOf(ci) === t));
    const dcFreq = [new Int32Array(256), new Int32Array(256)];
    const acFreq = [new Int32Array(256), new Int32Array(256)];
    let cur = tableOf(0);
    if (!refineDc) codeScan(f, scan, { dc: (ci, s) => { cur = tableOf(ci); dcFreq[cur][s]++; }, ac: s => { acFreq[cur][s]++; }, bits: noop });
    const dcT: Array<EncodeTable | null> = [null, null], acT: Array<EncodeTable | null> = [null, null];
    const dht: Uint8Array[] = [];
    if (seq || (dcScan && !refineDc)) {
      for (const t of used) { const o = optimalTable(dcFreq[t]); dcT[t] = encodeTable(o); dht.push(Uint8Array.of(t, ...o.counts, ...o.values)); }
    }
    if (seq || !dcScan) {
      for (const t of used) { const o = optimalTable(acFreq[t]); acT[t] = encodeTable(o); dht.push(Uint8Array.of(0x10 | t, ...o.counts, ...o.values)); }
    }
    if (dht.length) parts.push(segment(0xc4, concat(dht)));
    const sh = new Uint8Array(1 + 2 * scan.comps.length + 3);
    sh[0] = scan.comps.length;
    scan.comps.forEach((c, ci) => {
      const t = tableOf(ci);
      sh[1 + 2 * ci] = f.comps[c].id;
      sh[2 + 2 * ci] = seq ? (t << 4) | t : dcScan ? t << 4 : t;
    });
    const q = 1 + 2 * scan.comps.length;
    sh[q] = scan.ss; sh[q + 1] = scan.se; sh[q + 2] = (scan.ah << 4) | scan.al;
    parts.push(segment(0xda, sh));
    const w = new BitWriter(capacity);
    cur = tableOf(0);
    codeScan(f, scan, {
      dc: (ci, s) => { cur = tableOf(ci); const t = dcT[cur]!; w.bits(t.code[s], t.size[s]); },
      ac: s => { const t = acT[cur]!; w.bits(t.code[s], t.size[s]); },
      bits: (v, n) => w.bits(v, n),
    });
    w.flush();
    parts.push(w.bytes());
  }
  parts.push(Uint8Array.of(0xff, 0xd9));
  return concat(parts);
}

function segment(marker: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  out[0] = 0xff; out[1] = marker; out[2] = (body.length + 2) >> 8; out[3] = (body.length + 2) & 255;
  out.set(body, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Whether two frames hold the same picture exactly: sizes, components, sampling, quantization tables and every
 *  coefficient of the blocks that hold samples. */
export function sameCoefficients(a: Frame, b: Frame): boolean {
  if (a.width !== b.width || a.height !== b.height || a.comps.length !== b.comps.length) return false;
  for (let i = 0; i < a.comps.length; i++) {
    const x = a.comps[i], y = b.comps[i];
    if (x.id !== y.id || x.h !== y.h || x.v !== y.v || x.tq !== y.tq) return false;
    const qa = a.qt.get(x.tq)!, qb = b.qt.get(y.tq)!;
    if (!qa || !qb || qa.values.some((v, k) => v !== qb.values[k])) return false;
    for (let by = 0; by < x.bh; by++) {
      for (let bx = 0; bx < x.bw; bx++) {
        const o = (by * x.allocW + bx) * 64;
        for (let k = 0; k < 64; k++) if (x.coef[o + k] !== y.coef[o + k]) return false;
      }
    }
  }
  return true;
}
