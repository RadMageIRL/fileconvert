// A PNG's picture data, read for a PDF: checked whole without keeping it (a PNG that goes into the PDF as it is), or
// decoded exactly into the planes a PDF image holds (a PNG with an alpha channel, a palette with transparency, or
// interlacing). The data is inflated in pieces and read one row at a time, so nothing is held beyond the planes
// being filled and two rows; inflating stops as soon as the picture is complete, so data that would expand past the
// picture's own size is never expanded.

import { FlateStage, type Sink } from './filters';
import type { PngLayout } from './imageinfo';

/** Adam7: the first pixel and the step of each of the seven passes, across and down. */
const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const SAMPLES: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Pass { x0: number; y0: number; dx: number; dy: number; width: number; rows: number; rowBytes: number }

function passesOf(L: PngLayout): Pass[] {
  const { width: w, height: h } = L.info;
  const bitsPerPixel = SAMPLES[L.colorType] * L.depth;
  const rowBytes = (width: number) => Math.ceil((width * bitsPerPixel) / 8);
  if (!L.interlaced) return [{ x0: 0, y0: 0, dx: 1, dy: 1, width: w, rows: h, rowBytes: rowBytes(w) }];
  return ADAM7.map(([x0, y0, dx, dy]) => {
    const width = Math.max(0, Math.ceil((w - x0) / dx)), rows = Math.max(0, Math.ceil((h - y0) / dy));
    return { x0, y0, dx, dy, width, rows, rowBytes: rowBytes(width) };
  }).filter(p => p.width > 0 && p.rows > 0);
}

/** The planes of a decoded PNG: colors (gray, RGB or palette indexes) at 8 or 16 bits per sample, and transparency
 *  at 8 or 16 bits (the alpha channel, or each palette entry's), or null when every pixel is opaque. */
export interface PngPlanes {
  color: Uint8Array;
  colorBits: 8 | 16;
  alpha: Uint8Array | null;
  alphaBits: 8 | 16;
}

const STOP = new Error('The picture is complete.');

/** Takes inflated data, splits it into rows, undoes each row's filter and hands the row on. */
class Rows implements Sink {
  error: unknown = null;
  /** Data went on past the picture's last row (it was not expanded further). */
  extra = false;
  /** Bytes inflated and seen: the picture's, and at most the rest of the last piece the inflater gave. */
  seen = 0;
  private passes: Pass[];
  private pi = 0;
  private row = 0;
  private cur: Uint8Array;
  private prev: Uint8Array;
  private fill = 0;
  private bpp: number;
  /** `onRow` gets each row with its filter byte first (filter 0 once undone). */
  constructor(L: PngLayout, private unfilter: boolean, private onRow?: (pass: Pass, y: number, row: Uint8Array) => void) {
    this.passes = passesOf(L);
    this.bpp = Math.max(1, Math.ceil((SAMPLES[L.colorType] * L.depth) / 8));
    const widest = Math.max(...this.passes.map(p => p.rowBytes));
    this.cur = new Uint8Array(widest + 1);
    this.prev = new Uint8Array(widest + 1);
  }
  get complete(): boolean {
    return this.pi >= this.passes.length;
  }
  push(chunk: Uint8Array): void {
    this.seen += chunk.length;
    try {
      let i = 0;
      while (i < chunk.length) {
        if (this.complete) { this.extra = true; throw STOP; }
        const pass = this.passes[this.pi];
        const size = pass.rowBytes + 1;
        const take = Math.min(size - this.fill, chunk.length - i);
        this.cur.set(chunk.subarray(i, i + take), this.fill);
        this.fill += take;
        i += take;
        if (this.fill < size) continue;
        const f = this.cur[0];
        if (f > 4) throw new Error('This PNG is damaged: a row of its picture uses a filter PNG does not define.');
        if (this.unfilter) { unfilterRow(f, this.cur, this.prev, pass.rowBytes, this.bpp); this.cur[0] = 0; }
        this.onRow?.(pass, this.row, this.cur.subarray(0, size));
        [this.cur, this.prev] = [this.prev, this.cur];
        this.fill = 0;
        if (++this.row === pass.rows) {
          this.pi++;
          this.row = 0;
          this.prev.fill(0);
        }
      }
    } catch (e) {
      // Thrown to stop the inflater (it marks its data as ended on any error); the reason is kept for the caller.
      if (e !== STOP) this.error ??= e;
      throw e;
    }
  }
  end(): void {}
}

/** Undoes one row's filter in place (cur[0] is the filter type; the row's bytes follow it). */
function unfilterRow(f: number, cur: Uint8Array, prev: Uint8Array, n: number, bpp: number): void {
  if (f === 0) return;
  for (let i = 1; i <= n; i++) {
    const a = i > bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    let add: number;
    if (f === 1) add = a;
    else if (f === 2) add = b;
    else if (f === 3) add = (a + b) >> 1;
    else {
      const c = i > bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[i] = (cur[i] + add) & 0xff;
  }
}

/** Inflates the IDAT data through `rows`, and says what went wrong, if anything. */
function inflate(b: Uint8Array, L: PngLayout, rows: Rows): void {
  const stage = new FlateStage(rows);
  for (const [s, e] of L.idat) {
    stage.push(b.subarray(s, e));
    if (stage.done) break;
  }
  if (!stage.done) stage.end();
  if (rows.error) throw rows.error;
  if (!rows.complete) throw new Error('This PNG is damaged or cut off: its picture data ends early.');
}

/**
 * Checks that the picture data is whole and every row's filter is one PNG defines, holding two rows at a time. Returns
 * whether the compressed data goes on past the picture: such data is never copied into a PDF as it is, since a reader
 * would expand all of it (a small file can hold data that expands to gigabytes).
 */
export function checkPng(b: Uint8Array, L: PngLayout): { extra: boolean; inflated: number } {
  const rows = new Rows(L, false);
  inflate(b, L, rows);
  return { extra: rows.extra, inflated: rows.seen };
}

/** The picture's data exactly, inflated but still filtered (each row with its filter byte), nothing past its last
 *  row: to compress again on its own, for the same PNG predictor. */
export function pictureRows(b: Uint8Array, L: PngLayout): Uint8Array {
  const out = new Uint8Array(passesOf(L).reduce((k, p) => k + p.rows * (p.rowBytes + 1), 0));
  let at = 0;
  inflate(b, L, new Rows(L, false, (_pass, _y, row) => { out.set(row, at); at += row.length; }));
  return out;
}

/**
 * Decodes the picture data into planes, exactly. Samples of fewer than 8 bits become 8-bit samples (gray scaled up
 * exactly, 0 to 255; palette indexes as they are), so an interlaced 2-bit picture comes out as 8-bit; 16-bit samples
 * stay 16-bit. The alpha plane is left out when every pixel is opaque.
 */
export function decodePng(b: Uint8Array, L: PngLayout): PngPlanes {
  const { width: w, height: h } = L.info;
  const ct = L.colorType, depth = L.depth;
  const colors = ct === 2 || ct === 6 ? 3 : 1;
  const wide = depth === 16;
  const sb = wide ? 2 : 1;
  const color = new Uint8Array(w * h * colors * sb);
  const palAlpha = ct === 3 && L.trns ? L.trns : null;
  const hasAlpha = ct === 4 || ct === 6 || !!palAlpha;
  const alpha = hasAlpha ? new Uint8Array(w * h * (ct === 3 ? 1 : sb)) : null;
  let opaque = true;
  const scale = depth < 8 && ct === 0 ? 255 / ((1 << depth) - 1) : 1;
  const mask = (1 << depth) - 1;
  const rows = new Rows(L, true, (pass, y, row) => {
    const d = row.subarray(1);
    const oy = pass.y0 + y * pass.dy;
    for (let i = 0; i < pass.width; i++) {
      const px = oy * w + pass.x0 + i * pass.dx;
      if (depth < 8) {
        const bit = i * depth;
        const v = (d[bit >> 3] >> (8 - depth - (bit & 7))) & mask;
        color[px] = ct === 0 ? Math.round(v * scale) : v;
        if (palAlpha) { const a = v < palAlpha.length ? palAlpha[v] : 255; alpha![px] = a; if (a !== 255) opaque = false; }
        continue;
      }
      const spp = SAMPLES[ct];
      const at = i * spp * sb;
      const co = px * colors * sb;
      for (let k = 0; k < colors * sb; k++) color[co + k] = d[at + k];
      if (ct === 3 && palAlpha) {
        const v = d[at];
        const a = v < palAlpha.length ? palAlpha[v] : 255;
        alpha![px] = a;
        if (a !== 255) opaque = false;
      } else if (alpha) {
        const ao = at + colors * sb;
        if (wide) {
          alpha[px * 2] = d[ao]; alpha[px * 2 + 1] = d[ao + 1];
          if (d[ao] !== 255 || d[ao + 1] !== 255) opaque = false;
        } else {
          alpha[px] = d[ao];
          if (d[ao] !== 255) opaque = false;
        }
      }
    }
  });
  inflate(b, L, rows);
  return { color, colorBits: wide ? 16 : 8, alpha: opaque ? null : alpha, alphaBits: wide && ct !== 3 ? 16 : 8 };
}

/** The transparent color of a gray or RGB PNG (its tRNS chunk), as a PDF color key mask at `bits` per sample, or
 *  null. Gray of fewer than 8 bits that was decoded to 8 bits is scaled the same way. */
export function colorKey(L: PngLayout, bits: number): number[] | null {
  const t = L.trns;
  if (!t || (L.colorType !== 0 && L.colorType !== 2)) return null;
  const n = L.colorType === 0 ? 1 : 3;
  if (t.length < 2 * n) return null;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    let v = (t[2 * k] << 8) | t[2 * k + 1];
    if (v > (1 << L.depth) - 1) return null;
    if (bits === 8 && L.depth < 8) v = Math.round(v * (255 / ((1 << L.depth) - 1)));
    out.push(v, v);
  }
  return out;
}
