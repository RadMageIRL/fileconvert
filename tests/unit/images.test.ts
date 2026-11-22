import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bestEntry, decodeIcoBitmap, icoSizes, readIcoDirectory, writeIco } from '../../src/engines/image/ico';
import { encodeTiffPages, lzwEncode } from '../../src/engines/image/tiff';

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));

/** A TIFF LZW decoder written from the TIFF 6.0 specification, to check the encoder independently. */
function lzwDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitPos = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bitPos++) v = (v << 1) | ((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
    return v;
  };
  let table: number[][] = [];
  const reset = () => { table = Array.from({ length: 258 }, (_, i) => [i]); };
  reset();
  let width = 9, old: number[] | null = null;
  for (;;) {
    if (bitPos + width > data.length * 8) throw new Error('LZW data ends without EOI');
    const code = read(width);
    if (code === 257) break;
    if (code === 256) { reset(); width = 9; old = null; continue; }
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (code === table.length && old) entry = [...old, old[0]];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (old) table.push([...old, entry[0]]);
    old = entry;
    // TIFF's "early change": the width grows one code before the table would need it.
    if (table.length + 1 >= 1 << width && width < 12) width++;
  }
  return new Uint8Array(out);
}

describe('ICO', () => {
  test('reads directories with PNG and bitmap pictures, and picks the largest', () => {
    const png = readIcoDirectory(fx('image/icon-png.ico'));
    expect(png.map(e => [e.width, e.png])).toEqual([[16, true], [32, true], [48, true], [256, true]]);
    expect(bestEntry(png).width).toBe(256);
    const bmp = readIcoDirectory(fx('image/icon-8bit.ico'));
    expect(bmp).toHaveLength(1);
    expect(bmp[0]).toMatchObject({ width: 16, height: 16, bitCount: 8, png: false });
  });

  test('decodes palette bitmaps and applies the AND mask', () => {
    for (const [file, size, color] of [['image/icon-8bit.ico', 16, [255, 0, 0]], ['image/icon-1bit.ico', 32, [0, 0, 0]]] as const) {
      const b = fx(file);
      const d = decodeIcoBitmap(b, readIcoDirectory(b)[0]);
      expect([d.width, d.height]).toEqual([size, size]);
      expect(d.rgba[3]).toBe(0);
      const last = (size * size - 1) * 4;
      expect([...d.rgba.slice(last, last + 4)]).toEqual([...color, 255]);
    }
  });

  test('a directory pointing past the end of the file, and a file that is not an icon, are refused', () => {
    expect(() => readIcoDirectory(fx('hostile/bad-offsets.ico'))).toThrow('None of the pictures in this ICO file could be read');
    expect(() => readIcoDirectory(fx('image/alpha.png'))).toThrow('not a valid ICO file');
  });

  test('writes a directory of PNG pictures, smallest first, with 256 stored as 0', () => {
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
    const ico = writeIco([{ size: 256, png: png(1) }, { size: 16, png: png(2) }]);
    const dv = new DataView(ico.buffer);
    expect([dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true)]).toEqual([0, 1, 2]);
    expect([ico[6], ico[22]]).toEqual([16, 0]);
    expect(dv.getUint32(6 + 12, true)).toBe(38);
    expect(ico[38 + 4]).toBe(2);
    expect(ico[dv.getUint32(22 + 12, true) + 4]).toBe(1);
    expect(icoSizes('favicon')).toEqual([16, 32, 48]);
    expect(icoSizes('all')).toEqual([16, 32, 48, 64, 128, 256]);
    expect(icoSizes('64')).toEqual([64]);
    expect(icoSizes('999')).toEqual([16, 32, 48]);
  });
});

describe('TIFF writing', () => {
  test('LZW round-trips through an independent decoder: empty, uniform, random, and long enough to clear the table', () => {
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    const cases = [new Uint8Array(0), new Uint8Array(1), new Uint8Array(100000), Uint8Array.from({ length: 300000 }, rnd), Uint8Array.from({ length: 70000 }, (_, i) => i % 251)];
    for (const c of cases) expect(lzwDecode(lzwEncode(c))).toEqual(c);
  });

  test('pages are chained in order with their sizes and page numbers', () => {
    const page = (w: number, h: number, a = 255) => ({ rgba: new Uint8Array(w * h * 4).fill(a), width: w, height: h });
    const t = encodeTiffPages([page(3, 2), page(5, 7, 128), page(1, 1)], 'lzw');
    const dv = new DataView(t.buffer);
    expect([t[0], t[1], dv.getUint16(2, true)]).toEqual([0x49, 0x49, 42]);
    const pages: Array<Record<number, number[]>> = [];
    for (let ifd = dv.getUint32(4, true); ifd; ) {
      const n = dv.getUint16(ifd, true);
      const tags: Record<number, number[]> = {};
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12, tag = dv.getUint16(e, true), type = dv.getUint16(e + 2, true), count = dv.getUint32(e + 4, true);
        if (type === 3 && count <= 2) tags[tag] = Array.from({ length: count }, (_, k) => dv.getUint16(e + 8 + k * 2, true));
        if (type === 4 && count === 1) tags[tag] = [dv.getUint32(e + 8, true)];
      }
      pages.push(tags);
      ifd = dv.getUint32(ifd + 2 + n * 12, true);
    }
    expect(pages.map(p => [p[256][0], p[257][0], p[277][0], p[259][0], ...p[297]])).toEqual([[3, 2, 3, 5, 0, 3], [5, 7, 4, 5, 1, 3], [1, 1, 3, 5, 2, 3]]);
  });
});

describe('SVG helpers', () => {
  const fresh = () => ({ scripts: 0, handlers: 0, external: 0, html: 0, animation: 0, styles: 0, other: 0 });

  test('CSS keeps references inside the file and loses everything that could reach outside it', async () => {
    const { cleanCss } = await import('../../src/engines/image/svg');
    const r = fresh();
    expect(cleanCss('@import url(https://x/a.css); @import "b.css"; .a{fill:url(#g)} .b{fill:url( "https://x/p" )} @font-face{src:url(f.woff)}', r))
      .toBe('  .a{fill:url(#g)} .b{fill:none} ');
    expect(r.external).toBe(4);
    const e = fresh();
    expect(cleanCss('.a{background:u\\72l(https://x/e)}', e)).toBe('');
    expect(e.styles).toBe(1);
  });

  test('lengths in every SVG unit, and the target size for each setting', async () => {
    const { svgLength, targetSize } = await import('../../src/engines/image/svg');
    expect([svgLength('10'), svgLength('10px'), svgLength('1in'), svgLength('25.4mm'), svgLength('72pt'), svgLength('1e2')]).toEqual([10, 10, 96, 96, 96, 100]);
    expect([svgLength('50%'), svgLength('auto'), svgLength('-5'), svgLength(null)]).toEqual([null, null, null, null]);
    expect(targetSize(64, 32, 'original')).toEqual({ width: 64, height: 32 });
    expect(targetSize(64, 32, '2x')).toEqual({ width: 128, height: 64 });
    expect(targetSize(64, 32, '1024')).toEqual({ width: 1024, height: 512 });
  });
});

describe('animation', () => {
  test('the GIF loop setting: forever, a count, or play once without the extension', async () => {
    const { gifPlays } = await import('../../src/engines/image/frames');
    expect(gifPlays(fx('image/anim-dispose.gif'))).toBe(0);
    expect(gifPlays(fx('image/photo.gif'))).toBe(1);
    const ext = (n: number) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', c => c.charCodeAt(0)), 3, 1, n & 0xff, n >> 8, 0, 0, 0, 0, 0, 0]);
    expect(gifPlays(ext(3))).toBe(4);
  });

  test('animated WebP: VP8X flags, ANIM loop count, and one full-canvas ANMF per frame carrying its image chunks', async () => {
    const { writeAnimatedWebp, imageChunks } = await import('../../src/engines/image/webpanim');
    const riff = (...chunks: Array<[string, number[]]>) => {
      const body = chunks.flatMap(([t, d]) => [...Array.from(t, c => c.charCodeAt(0)), d.length & 0xff, d.length >> 8, 0, 0, ...d, ...(d.length & 1 ? [0] : [])]);
      return new Uint8Array([0x52, 0x49, 0x46, 0x46, (body.length + 4) & 0xff, (body.length + 4) >> 8, 0, 0, 0x57, 0x45, 0x42, 0x50, ...body]);
    };
    const lossy = riff(['VP8 ', [1, 2, 3]]);
    const withAlpha = riff(['VP8X', new Array(10).fill(0)], ['ALPH', [9, 9]], ['VP8 ', [4, 5, 6, 7]], ['EXIF', [1]]);
    expect([...imageChunks(withAlpha)]).toEqual([0x41, 0x4c, 0x50, 0x48, 2, 0, 0, 0, 9, 9, 0x56, 0x50, 0x38, 0x20, 4, 0, 0, 0, 4, 5, 6, 7]);
    const out = writeAnimatedWebp([{ webp: lossy, duration: 120 }, { webp: withAlpha, duration: 80 }], 40, 30, 2, true);
    const dv = new DataView(out.buffer);
    expect(dv.getUint32(4, true)).toBe(out.length - 8);
    const chunks: Array<[string, number]> = [];
    for (let p = 12; p < out.length;) { const n = dv.getUint32(p + 4, true); chunks.push([String.fromCharCode(...out.subarray(p, p + 4)), p]); p += 8 + n + (n & 1); }
    expect(chunks.map(c => c[0])).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF']);
    expect(out[20]).toBe(0x12);
    expect([out[24] | out[25] << 8, out[27] | out[28] << 8]).toEqual([39, 29]);
    expect(dv.getUint16(chunks[1][1] + 8 + 4, true)).toBe(2);
    const anmf = chunks[3][1] + 8;
    expect(out[anmf + 12] | out[anmf + 13] << 8).toBe(80);
    expect(out[anmf + 15]).toBe(0x02);
    expect(String.fromCharCode(...out.subarray(anmf + 16, anmf + 20))).toBe('ALPH');
  });
});
