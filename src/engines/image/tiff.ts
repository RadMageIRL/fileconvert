// TIFF writing: one or many pages, 8 bits per sample, RGB or RGBA (unassociated alpha, only when a page has
// transparency), uncompressed or LZW. LZW is the compression Windows, macOS, Office and image editors all read;
// the encoder follows libtiff's, including when the code width grows and when the table is cleared. Each page is
// cut into strips of about 64 KB, each strip compressed on its own, as baseline readers expect.

export type TiffCompression = 'none' | 'lzw';

export interface TiffPage {
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

const CLEAR = 256, EOI = 257, FIRST = 258, MAX_CODE = 4095;

/** TIFF LZW (MSB-first codes, 9 to 12 bits). */
export function lzwEncode(data: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(64, (data.length * 3) >> 1));
  let pos = 0, acc = 0, accBits = 0;
  const put = (code: number, bits: number) => {
    acc = (acc << bits) | code;
    accBits += bits;
    while (accBits >= 8) {
      if (pos >= out.length) { const grown = new Uint8Array(out.length * 2); grown.set(out); out = grown; }
      out[pos++] = (acc >>> (accBits - 8)) & 0xff;
      accBits -= 8;
    }
    acc &= (1 << accBits) - 1;
  };
  // The table maps (prefix code, next byte) to a code. A generation stamp clears it without refilling.
  const table = new Int32Array(4096 * 256);
  let gen = 1;
  let nbits = 9, maxcode = (1 << nbits) - 1, next = FIRST;
  put(CLEAR, nbits);
  let ent = data.length ? data[0] : -1;
  for (let i = 1; i < data.length; i++) {
    const c = data[i];
    const key = (ent << 8) | c;
    const v = table[key];
    if (v >>> 12 === gen) { ent = v & 0xfff; continue; }
    put(ent, nbits);
    ent = c;
    if (next === MAX_CODE - 1) {
      put(CLEAR, nbits);
      gen++;
      next = FIRST;
      nbits = 9;
      maxcode = (1 << nbits) - 1;
    } else {
      table[key] = (gen << 12) | next;
      next++;
      if (next > maxcode && nbits < 12) { nbits++; maxcode = (1 << nbits) - 1; }
    }
  }
  if (ent >= 0) {
    put(ent, nbits);
    next++;
    if (next === MAX_CODE - 1) { put(CLEAR, nbits); nbits = 9; }
    else if (next > maxcode && nbits < 12) nbits++;
  }
  put(EOI, nbits);
  if (accBits) { if (pos >= out.length) { const g = new Uint8Array(out.length + 1); g.set(out); out = g; } out[pos++] = (acc << (8 - accBits)) & 0xff; }
  return out.slice(0, pos);
}

interface Tag { tag: number; type: 3 | 4 | 5 | 2; values: number[] | string }

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 } as const;

/**
 * Builds a TIFF page by page. Each page is cut into strips and compressed as it is added, so only compressed
 * bytes are kept; finish() writes the directories after all the image data and chains them.
 */
export class TiffWriter {
  private chunks: Uint8Array[] = [];
  private offset = 8;
  private ifds: Tag[][] = [];

  constructor(private compression: TiffCompression = 'none') {}

  get pages(): number { return this.ifds.length; }

  addPage(p: TiffPage): void {
    const alpha = hasAlpha(p.rgba);
    const spp = alpha ? 4 : 3;
    const rowBytes = p.width * spp;
    const rowsPerStrip = Math.max(1, Math.min(p.height, Math.floor(65536 / rowBytes) || 1));
    const offsets: number[] = [], counts: number[] = [];
    for (let y = 0; y < p.height; y += rowsPerStrip) {
      const rows = Math.min(rowsPerStrip, p.height - y);
      const raw = new Uint8Array(rows * rowBytes);
      for (let r = 0; r < rows; r++) {
        const src = (y + r) * p.width * 4;
        const dst = r * rowBytes;
        if (alpha) raw.set(p.rgba.subarray(src, src + p.width * 4), dst);
        else for (let x = 0; x < p.width; x++) { raw[dst + x * 3] = p.rgba[src + x * 4]; raw[dst + x * 3 + 1] = p.rgba[src + x * 4 + 1]; raw[dst + x * 3 + 2] = p.rgba[src + x * 4 + 2]; }
      }
      const data = this.compression === 'lzw' ? lzwEncode(raw) : raw;
      offsets.push(this.offset);
      counts.push(data.length);
      this.chunks.push(data);
      this.offset += data.length;
      if (this.offset & 1) { this.chunks.push(new Uint8Array(1)); this.offset++; }
    }
    const tags: Tag[] = [
      { tag: 254, type: 4, values: [0] },
      { tag: 256, type: 4, values: [p.width] },
      { tag: 257, type: 4, values: [p.height] },
      { tag: 258, type: 3, values: new Array(spp).fill(8) },
      { tag: 259, type: 3, values: [this.compression === 'lzw' ? 5 : 1] },
      { tag: 262, type: 3, values: [2] },
      { tag: 273, type: 4, values: offsets },
      { tag: 277, type: 3, values: [spp] },
      { tag: 278, type: 4, values: [rowsPerStrip] },
      { tag: 279, type: 4, values: counts },
      { tag: 282, type: 5, values: [72, 1] },
      { tag: 283, type: 5, values: [72, 1] },
      { tag: 284, type: 3, values: [1] },
      { tag: 296, type: 3, values: [2] },
      { tag: 297, type: 3, values: [this.ifds.length, 0] },
      { tag: 305, type: 2, values: 'FileConvert\0' },
    ];
    if (alpha) tags.push({ tag: 338, type: 3, values: [2] });
    this.ifds.push(tags);
  }

  finish(): Uint8Array {
    if (!this.ifds.length) throw new Error('There are no pages to write.');
    // PageNumber holds the page count, known only now.
    for (const tags of this.ifds) (tags.find(t => t.tag === 297)!.values as number[])[1] = this.ifds.length;
    let offset = this.offset;
    const ifdBytes: Uint8Array[] = [];
    const ifdOffsets: number[] = [];
    for (const tags of this.ifds) {
      ifdOffsets.push(offset);
      const entriesSize = 2 + tags.length * 12 + 4;
      let extra = offset + entriesSize;
      const body = new Uint8Array(entriesSize + tags.reduce((n, t) => n + overflow(t), 0));
      const dv = new DataView(body.buffer);
      dv.setUint16(0, tags.length, true);
      let extraPos = entriesSize;
      tags.forEach((t, i) => {
        const e = 2 + i * 12;
        const count = typeof t.values === 'string' ? t.values.length : t.type === 5 ? t.values.length / 2 : t.values.length;
        dv.setUint16(e, t.tag, true);
        dv.setUint16(e + 2, t.type, true);
        dv.setUint32(e + 4, count, true);
        const size = count * TYPE_SIZE[t.type];
        const target = size <= 4 ? e + 8 : extraPos;
        if (size > 4) { dv.setUint32(e + 8, extra, true); extra += size + (size & 1); extraPos += size + (size & 1); }
        writeValues(dv, target, t);
      });
      ifdBytes.push(body);
      offset += body.length;
    }
    ifdBytes.forEach((body, i) => {
      new DataView(body.buffer).setUint32(2 + this.ifds[i].length * 12, i + 1 < ifdBytes.length ? ifdOffsets[i + 1] : 0, true);
    });
    const out = new Uint8Array(offset);
    out.set([0x49, 0x49, 42, 0]);
    new DataView(out.buffer).setUint32(4, ifdOffsets[0], true);
    let at = 8;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    for (const b of ifdBytes) { out.set(b, at); at += b.length; }
    this.chunks = [];
    return out;
  }
}

/** Writes the pages as one TIFF file. */
export function encodeTiffPages(pages: TiffPage[], compression: TiffCompression = 'none'): Uint8Array {
  const w = new TiffWriter(compression);
  for (const p of pages) w.addPage(p);
  return w.finish();
}

function overflow(t: Tag): number {
  const count = typeof t.values === 'string' ? t.values.length : t.type === 5 ? t.values.length / 2 : t.values.length;
  const size = count * TYPE_SIZE[t.type];
  return size > 4 ? size + (size & 1) : 0;
}

function writeValues(dv: DataView, at: number, t: Tag): void {
  if (typeof t.values === 'string') { for (let i = 0; i < t.values.length; i++) dv.setUint8(at + i, t.values.charCodeAt(i)); return; }
  t.values.forEach((v, i) => {
    if (t.type === 3) dv.setUint16(at + i * 2, v, true);
    else dv.setUint32(at + i * 4, v, true);
  });
}

function hasAlpha(rgba: Uint8Array | Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}
