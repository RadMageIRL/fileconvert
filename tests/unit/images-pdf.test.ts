import { readFileSync } from 'node:fs';
import UPNG from '@cantoo/pdf-lib/upng';
import { describe, expect, test } from 'vitest';
import { crc32 } from '../../src/core/crc32';
import { LIMITS } from '../../src/core/limits';
import { estimateImages, type ImageWork } from '../../src/core/pdfmemory';
import { displaySize, iccUsable, jpegStream, jpegWalk, NeedMore, readExif, readJpeg, readPng, tiffPages } from '../../src/engines/pdf/imageinfo';
import { MAX_PAGE_SIDE, orientationMatrix, PAGE_SIZES, placePicture, type ImagePageOptions } from '../../src/engines/pdf/imagelayout';
import { checkPng, colorKey, decodePng, pictureRows } from '../../src/engines/pdf/pngdecode';

// Images to PDF, the parts that need no browser: reading JPEG and PNG headers, the JPEG as a PDF holds it, the PNG
// decoder (checked against UPNG, an independent PNG decoder), where each picture goes on its page, the orientation
// matrices, and the memory estimate. The browser tests check every result with qpdf, PDFium and their own decoders.

const fx = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/image-pdf/${name}`));
const img = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/image/${name}`));
const err = (f: () => unknown) => { try { f(); return 'accepted'; } catch (e) { return (e as Error).message; } };
const MM = 72 / 25.4;
const opts = (o: Partial<ImagePageOptions> = {}): ImagePageOptions => ({ size: 'a4', orientation: 'auto', margin: 0, fit: 'fit', enlarge: false, ...o });

/** A JPEG made of the given segments (marker, data), with an SOI first and an EOI after `tail`. */
function jpeg(segments: Array<[number, number[] | Uint8Array]>, tail: number[] = []): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  for (const [m, d] of segments) out.push(0xff, m, ((d.length + 2) >> 8) & 0xff, (d.length + 2) & 0xff, ...d);
  out.push(...tail, 0xff, 0xd9);
  return new Uint8Array(out);
}
const sof = (precision: number, h: number, w: number, n: number) => [precision, h >> 8, h & 0xff, w >> 8, w & 0xff, n, ...Array.from({ length: n }, (_, i) => [i + 1, 0x11, 0]).flat()];
const sos = [1, 1, 0, 0, 63, 0];
const bytes = (s: string) => Array.from(s, c => c.charCodeAt(0));

describe('JPEG headers', () => {
  test('size, channels, resolution, orientation, profile and metadata, from the header alone', () => {
    const b = readJpeg(fx('baseline.jpg')).info;
    expect(b).toMatchObject({ width: 64, height: 48, channels: 3, bits: 8, path: 'jpeg', alpha: 'none', orientation: 1, dpi: [300, 300], icc: 'none', metadata: true, pages: 1 });
    expect(readJpeg(fx('progressive-icc.jpg')).info).toMatchObject({ path: 'jpeg', icc: 'kept', metadata: false });
    expect(readJpeg(fx('gray.jpg')).info.channels).toBe(1);
    const cmyk = readJpeg(fx('cmyk.jpg'));
    expect(cmyk.info.channels).toBe(4);
    expect(cmyk.adobe).not.toBeNull();
    for (let o = 1; o <= 8; o++) {
      const i = readJpeg(fx(`orient${o}.jpg`)).info;
      expect(i.orientation).toBe(o);
      expect(displaySize(i)).toEqual([64, 48]);
    }
  });

  test('a header cut short asks for more; what is not a JPEG, or not one PDF can describe, is refused', () => {
    const b = fx('baseline.jpg');
    expect(() => readJpeg(b.subarray(0, 40))).toThrow(NeedMore);
    expect(err(() => readJpeg(img('alpha.png')))).toBe('This is not a JPEG picture.');
    expect(err(() => readJpeg(jpeg([[0xc0, sof(8, 0, 16, 3)], [0xda, sos]])))).toMatch(/gives its height only after the picture data/);
    expect(err(() => readJpeg(jpeg([[0xc0, sof(8, 8, 8, 2)], [0xda, sos]])))).toBe('This JPEG has 2 color channels; FileConvert reads JPEGs with 1, 3 or 4.');
    expect(err(() => readJpeg(jpeg([[0xdb, [0]]])))).toBe('This JPEG has no picture in it.');
  });

  test('kinds of JPEG PDF readers do not read are decoded instead, and say why', () => {
    const kinds: Array<[number, number, string]> = [[0xc3, 8, 'lossless'], [0xc9, 8, 'arithmetic-coded'], [0xc5, 8, 'hierarchical'], [0xc1, 12, '12-bit']];
    for (const [m, p, word] of kinds) {
      const i = readJpeg(jpeg([[m, sof(p, 8, 8, 3)], [0xda, sos]])).info;
      expect(i.path).toBe('decode');
      expect(i.notes.join(' ')).toContain(word);
    }
    for (const m of [0xc0, 0xc1, 0xc2]) expect(readJpeg(jpeg([[m, sof(8, 8, 8, 3)], [0xda, sos]])).info.path).toBe('jpeg');
  });

  test('a color profile in several pieces is joined in order; one that is damaged or for other channels is not used', () => {
    const srgb = readJpeg(fx('progressive-icc.jpg')).icc!;
    expect(iccUsable(srgb, 3)).toBe(true);
    expect(iccUsable(srgb, 1)).toBe(false);
    expect(iccUsable(srgb.subarray(0, 100), 3)).toBe(false);
    const half = Math.floor(srgb.length / 2);
    const piece = (seq: number, total: number, d: Uint8Array) => [0xe2, new Uint8Array([...bytes('ICC_PROFILE\0'), seq, total, ...d])] as [number, Uint8Array];
    const two = readJpeg(jpeg([piece(2, 2, srgb.subarray(half)), piece(1, 2, srgb.subarray(0, half)), [0xc0, sof(8, 8, 8, 3)], [0xda, sos]]));
    expect(two.info.icc).toBe('kept');
    expect(two.icc).toEqual(srgb);
    const missing = readJpeg(jpeg([piece(1, 2, srgb.subarray(0, half)), [0xc0, sof(8, 8, 8, 3)], [0xda, sos]]));
    expect(missing.info.icc).toBe('unusable');
    expect(missing.info.notes.join(' ')).toContain('color profile is damaged');
    expect(readJpeg(jpeg([piece(1, 1, srgb), [0xc0, sof(8, 8, 8, 1)], [0xda, sos]])).info.icc).toBe('unusable');
  });

  test('EXIF orientation and resolution are read in either byte order, and nonsense never throws', () => {
    const le = [...bytes('II'), 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    expect(readExif(new Uint8Array(le), 0, le.length).orientation).toBe(6);
    const be = [...bytes('MM'), 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 8, 0, 0, 0, 0, 0, 0];
    expect(readExif(new Uint8Array(be), 0, be.length).orientation).toBe(8);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff;
    for (let k = 0; k < 2000; k++) {
      const b = new Uint8Array(40).map(rnd);
      b[0] = b[1] = k % 2 ? 0x49 : 0x4d;
      const r = readExif(b, 0, b.length);
      expect(r.orientation).toBeGreaterThanOrEqual(1);
      expect(r.orientation).toBeLessThanOrEqual(8);
    }
  });
});

describe('the JPEG a PDF holds', () => {
  test('metadata left out, the frame and scans byte for byte, data after the end left out', () => {
    const b = fx('baseline.jpg');
    const L = readJpeg(b);
    const s = jpegStream(b, L);
    const text = new TextDecoder('latin1').decode(s.data);
    for (const gone of ['Exif', 'LeakyCam', 'Jane Example', 'http://ns.adobe.com/xap', 'Secret comment']) expect(text).not.toContain(gone);
    expect(text).toContain('JFIF');
    expect(s.truncated).toBe(false);
    expect(s.trailing).toBe(0);
    // Everything from the first scan to the end is the file's own bytes.
    const scan = b.subarray(L.sos);
    expect(Buffer.from(s.data.subarray(s.data.length - scan.length)).equals(Buffer.from(scan))).toBe(true);
    const t = jpegStream(fx('trailing.jpg'), readJpeg(fx('trailing.jpg')));
    expect(t.trailing).toBeGreaterThan(0);
    expect(Buffer.from(t.data).equals(Buffer.from(s.data))).toBe(true);
    const cut = jpegStream(fx('truncated.jpg'), readJpeg(fx('truncated.jpg')));
    expect(cut.truncated).toBe(true);
    expect(jpegWalk(fx('truncated.jpg'), readJpeg(fx('truncated.jpg'))).ended).toBe(false);
  });

  test('scans, restarts and the tables between scans are kept; application data between them is not', () => {
    const entropy = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd1, 0x78];
    const j = jpeg([[0xdb, [0, ...new Array(64).fill(1)]], [0xc2, sof(8, 8, 8, 3)], [0xda, sos]], [
      ...entropy,
      0xff, 0xe1, 0, 6, ...bytes('Exif'),
      0xff, 0xc4, 0, 3, 0x10,
      0xff, 0xfe, 0, 5, ...bytes('hey'),
      0xff, 0xda, 0, 8, ...sos, ...entropy,
    ]);
    const s = jpegStream(j, readJpeg(j)).data;
    const want = jpeg([[0xdb, [0, ...new Array(64).fill(1)]], [0xc2, sof(8, 8, 8, 3)], [0xda, sos]], [...entropy, 0xff, 0xc4, 0, 3, 0x10, 0xff, 0xda, 0, 8, ...sos, ...entropy]);
    expect(Array.from(s)).toEqual(Array.from(want));
  });
});

describe('PNG headers', () => {
  const path = (n: string) => readPng(fx(n), false).info;
  test('each kind of PNG goes in as it is, or is decoded, as PDF can hold it', () => {
    for (const n of ['gray1', 'gray2', 'gray4', 'gray8', 'gray16', 'rgb8', 'rgb16', 'pal1', 'pal4', 'pal8', 'key-gray8', 'key-rgb16', 'iccp-rgb', 'gamma1', 'orient6']) expect([n, path(`${n}.png`).path]).toEqual([n, 'png']);
    for (const n of ['pal8-trns', 'graya8', 'graya16', 'rgba8', 'rgba16', 'rgba8-opaque', 'int-rgb8', 'int-gray2', 'int-rgba16', 'int-pal4-trns']) expect([n, path(`${n}.png`).path]).toEqual([n, 'png-decode']);
    expect(path('key-rgb16.png')).toMatchObject({ alpha: 'key', bits: 16, channels: 3 });
    expect(path('pal8-trns.png').alpha).toBe('palette');
    expect(path('rgba16.png')).toMatchObject({ alpha: 'channel', raw: 48 * 32 * 4 * 2 });
    expect(path('rgb8.png').dpi).toEqual([299.9994, 299.9994]);
    expect(path('orient6.png').orientation).toBe(6);
    expect(path('iccp-rgb.png').icc).toBe('kept');
    expect(path('gamma1.png').notes.join(' ')).toContain('gamma setting (1.00) is not applied');
    expect(path('int-rgb8.png').notes.join(' ')).toContain('interlaced');
    expect(readPng(img('animated.png'), false).info).toMatchObject({ animated: true });
  });

  test('damaged files are refused with the reason; a header cut short asks for more', () => {
    expect(err(() => readPng(fx('crc.png'), true, crc32))).toBe('This PNG is damaged: its IDAT chunk does not match its checksum.');
    expect(readPng(fx('crc.png'), false).info.width).toBe(48);
    expect(err(() => checkPng(fx('short.png'), readPng(fx('short.png'), true, crc32)))).toBe('This PNG is damaged or cut off: its picture data ends early.');
    expect(() => readPng(fx('rgb8.png').subarray(0, 20), false)).toThrow(NeedMore);
    expect(err(() => readPng(fx('baseline.jpg'), false))).toBe('This is not a PNG picture.');
    expect(readPng(fx('huge.png'), false).info).toMatchObject({ width: 40000, height: 40000 });
  });
});

describe('PNG data, decoded here and by UPNG', () => {
  /** UPNG's samples split into planes the way a PDF holds them, as the oracle. */
  function upng(name: string) {
    const b = fx(name);
    const d = UPNG.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    return { ...d, raw: new Uint8Array(d.data as unknown as ArrayBuffer) };
  }

  test('alpha channels, 8 and 16 bits, interlaced or not, split exactly into colors and transparency', () => {
    for (const name of ['graya8.png', 'graya16.png', 'rgba8.png', 'rgba16.png', 'int-rgba16.png', 'noise-rgba8.png', 'noise-rgba16.png']) {
      const u = upng(name);
      const L = readPng(fx(name), true, crc32);
      const p = decodePng(fx(name), L);
      const colors = u.ctype === 6 ? 3 : 1, sb = u.depth / 8, px = u.width * u.height;
      const color = new Uint8Array(px * colors * sb), alpha = new Uint8Array(px * sb);
      for (let i = 0; i < px; i++) {
        const at = i * (colors + 1) * sb;
        color.set(u.raw.subarray(at, at + colors * sb), i * colors * sb);
        alpha.set(u.raw.subarray(at + colors * sb, at + (colors + 1) * sb), i * sb);
      }
      expect([name, Buffer.from(p.color).equals(Buffer.from(color))]).toEqual([name, true]);
      expect([name, p.alpha && Buffer.from(p.alpha).equals(Buffer.from(alpha))]).toEqual([name, true]);
      expect(p.colorBits).toBe(u.depth);
      expect(p.alphaBits).toBe(u.depth);
    }
  });

  test('palettes with transparency, interlaced gray of 2 bits, and an alpha channel that is all opaque', () => {
    // The fixture's indexes are (x + 3y) mod 200 (tools/make-image-pdf-fixtures.py).
    const pal = decodePng(fx('pal8-trns.png'), readPng(fx('pal8-trns.png'), true, crc32));
    const idx = Array.from({ length: 48 * 32 }, (_, i) => ((i % 48) + 3 * Math.floor(i / 48)) % 200);
    expect(Array.from(pal.color)).toEqual(idx);
    const trns = readPng(fx('pal8-trns.png'), true).trns!;
    expect(Array.from(pal.alpha!)).toEqual(idx.map(v => (v < trns.length ? trns[v] : 255)));
    // 2-bit gray becomes 8-bit, scaled exactly: 0, 85, 170, 255.
    const g = decodePng(fx('int-gray2.png'), readPng(fx('int-gray2.png'), true, crc32));
    const ug = decodePng(fx('gray2.png'), readPng(fx('gray2.png'), true, crc32));
    expect(Array.from(g.color)).toEqual(Array.from(ug.color));
    expect(new Set(g.color)).toEqual(new Set([0, 85, 170, 255]));
    expect(g.alpha).toBeNull();
    // Interlaced or not, the same picture.
    const i8 = decodePng(fx('int-rgb8.png'), readPng(fx('int-rgb8.png'), true, crc32));
    const r8 = decodePng(fx('rgb8.png'), readPng(fx('rgb8.png'), true, crc32));
    expect(Buffer.from(i8.color).equals(Buffer.from(r8.color))).toBe(true);
    expect(decodePng(fx('rgba8-opaque.png'), readPng(fx('rgba8-opaque.png'), true, crc32)).alpha).toBeNull();
  });

  test('data that goes on past the picture is noticed and never expanded; the picture alone is kept', () => {
    const b = fx('bomb.png');
    const L = readPng(b, true, crc32);
    const c = checkPng(b, L);
    expect(c.extra).toBe(true);
    // 64 MB follow the picture; only the picture and the rest of the piece that held its end were inflated.
    expect(c.inflated).toBeLessThan(8 * 1048576);
    expect(pictureRows(b, L).length).toBe(16 * 17);
    expect(checkPng(fx('rgb8.png'), readPng(fx('rgb8.png'), true, crc32))).toEqual({ extra: false, inflated: 32 * (48 * 3 + 1) });
    // A PNG of random samples goes in as it is: the PNG decoded by UPNG and by the planes agree byte for byte.
    const n = decodePng(fx('noise-rgb8.png'), readPng(fx('noise-rgb8.png'), true, crc32));
    expect(Buffer.from(n.color).equals(Buffer.from(upng('noise-rgb8.png').raw.subarray(0, 40 * 24 * 3)))).toBe(true);
  });

  test('a transparent color becomes a color key at the depth the PDF holds', () => {
    expect(colorKey(readPng(fx('key-rgb16.png'), true), 16)).toEqual([1234, 1234, 5678, 5678, 9012, 9012]);
    const g = readPng(fx('key-gray8.png'), true);
    expect(colorKey(g, 8)).toEqual([g.trns![1], g.trns![1]]);
    // A 2-bit gray key: as it is at 2 bits, scaled with the samples when decoded to 8 bits.
    const k2 = readPng(fx('int-gray2-key.png'), true);
    expect(colorKey(k2, 2)).toEqual([2, 2]);
    expect(colorKey(k2, 8)).toEqual([170, 170]);
    expect(colorKey(readPng(fx('rgb8.png'), true), 8)).toBeNull();
  });
});

describe('TIFF pages', () => {
  test('pages, sizes and bits from the directories alone', async () => {
    const read = (b: Uint8Array) => async (o: number, n: number) => b.subarray(o, o + n);
    const two = img('two-pages.tiff');
    expect((await tiffPages(read(two), two.length)).length).toBe(2);
    const g16 = fx('gray16.tiff');
    expect(await tiffPages(read(g16), g16.length)).toEqual([{ width: 48, height: 32, bits: 16, samples: 1 }]);
    await expect(tiffPages(read(fx('rgb8.png')), 100)).rejects.toThrow('This is not a TIFF picture.');
  });
});

describe('where a picture goes on its page', () => {
  const [A4W, A4H] = PAGE_SIZES.a4;
  test('fit: large pictures made smaller, small ones left at their own size unless enlarging is chosen', () => {
    // 4000 x 3000 at 96 per inch is 3000 x 2250 points: on landscape A4 its height decides.
    const big = placePicture(4000, 3000, null, opts());
    expect(big.page).toEqual([A4H, A4W]);
    expect(big.scale).toBeCloseTo(A4W / 2250);
    expect(big.box[3]).toBeCloseTo(A4W);
    expect(big.box[1]).toBeCloseTo(0);
    const small = placePicture(200, 100, null, opts());
    expect(small.scale).toBe(1);
    expect(small.box).toEqual([(A4H - 150) / 2, (A4W - 75) / 2, 150, 75]);
    const enlarged = placePicture(200, 100, null, opts({ enlarge: true }));
    expect(enlarged.scale).toBeCloseTo(A4H / 150);
    // At 300 pixels per inch, 600 pixels are 2 inches: 144 points.
    expect(placePicture(600, 300, [300, 300], opts()).box[2]).toBeCloseTo(144);
  });

  test('orientation: automatic follows the picture, or all pages one way; margins in millimetres', () => {
    expect(placePicture(100, 200, null, opts()).page).toEqual([A4W, A4H]);
    expect(placePicture(200, 100, null, opts({ orientation: 'portrait' })).page).toEqual([A4W, A4H]);
    expect(placePicture(100, 200, null, opts({ orientation: 'landscape' })).page).toEqual([A4H, A4W]);
    expect(placePicture(10, 10, null, opts({ size: 'letter' })).page).toEqual([612, 792]);
    const m = placePicture(4000, 3000, null, opts({ margin: 20 }));
    expect(m.box[3]).toBeCloseTo(A4W - 40 * MM);
    expect(m.box[1]).toBeCloseTo(20 * MM);
    expect(m.box[0]).toBeCloseTo((A4H - m.box[2]) / 2);
  });

  test('fill: the space covered, the part cut off measured, and the picture clipped to the space', () => {
    const f = placePicture(400, 100, null, opts({ fit: 'fill', orientation: 'portrait' }));
    expect(f.clip).toEqual([0, 0, A4W, A4H]);
    expect(f.box[3]).toBeCloseTo(A4H);
    expect(f.crop).toBeCloseTo(1 - (A4W * A4H) / (f.box[2] * f.box[3]));
    expect(f.crop).toBeCloseTo(1 - A4W / (4 * A4H), 6);
    const exact = placePicture(Math.round(A4W * 4 / 3) * 10, Math.round(A4H * 4 / 3) * 10, null, opts({ fit: 'fill', orientation: 'portrait' }));
    expect(exact.crop).toBeLessThan(0.002);
  });

  test('a page the size of the picture, with its margin, never past 200 inches or under 3 points', () => {
    const p = placePicture(960, 480, null, opts({ size: 'picture', margin: 10 }));
    expect(p.page[0]).toBeCloseTo(720 + 20 * MM);
    expect(p.scale).toBe(1);
    expect(p.assumed).toBe(true);
    const huge = placePicture(30000, 1000, [72, 72], opts({ size: 'picture' }));
    expect(huge.page[0]).toBeCloseTo(MAX_PAGE_SIDE);
    expect(huge.capped).toBe(true);
    expect(placePicture(1, 1, null, opts({ size: 'picture' })).page).toEqual([3, 3]);
    expect(placePicture(100, 100, [300, 150], opts({ size: 'picture' })).page).toEqual([24, 48]);
  });

  test('each EXIF orientation draws the stored corners where they show', () => {
    // Where the stored picture's top left and top right corners land: in PDF image space they are (0, 1) and (1, 1).
    const at = (o: number, u: number, v: number) => {
      const [a, b, c, d, e, f] = orientationMatrix(o, 10, 20, 300, 200);
      return [a * u + c * v + e, b * u + d * v + f].map(n => Math.round(n));
    };
    const TL = [10, 220], TR = [310, 220], BL = [10, 20], BR = [310, 20];
    const want: Record<number, [number[], number[]]> = { 1: [TL, TR], 2: [TR, TL], 3: [BR, BL], 4: [BL, BR], 5: [TL, BL], 6: [TR, BR], 7: [BR, TR], 8: [BL, TL] };
    for (let o = 1; o <= 8; o++) expect([o, at(o, 0, 1), at(o, 1, 1)]).toEqual([o, ...want[o]]);
    expect(orientationMatrix(1, 5, 6, 7, 8)).toEqual([7, -0, -0, 8, 5, 6]);
  });
});

describe('the memory estimate for Images to PDF', () => {
  const w = (x: Partial<ImageWork>): ImageWork => ({ bytes: 0, pixels: 0, raw: 0, path: 'jpeg', pages: 1, ...x });
  const F = LIMITS.imagePdfMemory.v8;
  const MB = 1048576;
  test('what the PDF holds of every picture, the most that adding one takes, and the pages', () => {
    const jpg = w({ bytes: 10 * MB });
    expect(estimateImages([jpg], 'v8').total).toBe(Math.ceil(F.base + F.held * 10 * MB + F.copy * 10 * MB + F.page));
    const decoded = w({ bytes: MB, pixels: 50e6, raw: 200e6, path: 'decode' });
    expect(estimateImages([decoded], 'v8').total).toBe(Math.ceil(F.base + F.held * 200e6 + F.copy * MB + F.pixel * 50e6 + F.page));
    const png = w({ bytes: 2 * MB, raw: 40e6, path: 'png-decode' });
    expect(estimateImages([png], 'v8').total).toBe(Math.ceil(F.base + F.held * 40e6 + F.copy * 2 * MB + F.planes * 40e6 + F.page));
    // Many: held adds up, adding counts the largest one only, wherever it is in the list.
    const two = Math.ceil(F.base + F.held * (10 * MB + 200e6) + Math.max(F.copy * 10 * MB, F.copy * MB + F.pixel * 50e6) + 2 * F.page);
    expect(estimateImages([jpg, decoded], 'v8').total).toBe(two);
    expect(estimateImages([decoded, jpg], 'v8').total).toBe(two);
    expect(estimateImages([w({ pages: 7, path: 'decode' })], 'v8').total).toBe(Math.ceil(F.base + 7 * F.page));
  });

  test('unknown engines get the highest figures, never lower than the measured ones', () => {
    const O = LIMITS.imagePdfMemory.other;
    for (const k of ['base', 'held', 'copy', 'planes', 'pixel', 'page'] as const) {
      expect(O[k]).toBeGreaterThanOrEqual(LIMITS.imagePdfMemory.v8[k]);
      expect(O[k]).toBeGreaterThanOrEqual(LIMITS.imagePdfMemory.gecko[k]);
    }
    const one = [w({ bytes: MB, pixels: 1e6, raw: 4e6, path: 'decode' })];
    expect(estimateImages(one).total).toBe(estimateImages(one, 'other').total);
  });
});

describe('the PDF made in the worker, run here (JPEG and PNG need no canvas)', () => {
  const file = (name: string) => ({ file: new Blob([fx(name)]), format: (name.endsWith('.jpg') ? 'jpg' : 'png') as 'jpg' | 'png', name });
  const progress = () => undefined;

  test('one page each, in order, read back by pdf-lib with the pictures the tool reported', async () => {
    const { imagesToPdf } = await import('../../src/engines/pdf/images');
    const r = await imagesToPdf([file('orient6.jpg'), file('rgba16.png'), file('pal4.png')], opts({ size: 'picture' }), undefined, progress);
    expect(r.pages).toBe(3);
    expect(r.pictures.map(p => [p.name, p.path, p.keptBits, p.alpha, p.orientation])).toEqual([
      ['orient6.jpg', 'jpeg', 8, 'none', 6], ['rgba16.png', 'png-decode', 16, 'kept', 1], ['pal4.png', 'png', 4, 'none', 1],
    ]);
    const { PDFDocument } = await import('@cantoo/pdf-lib');
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPages().map(p => [Math.round(p.getWidth()), Math.round(p.getHeight())])).toEqual([[48, 36], [36, 24], [36, 24]]);
    expect(new TextDecoder('latin1').decode(r.bytes)).not.toMatch(/LeakyCam|Exif/);
  });

  test('every picture is checked against the allowance before it is read, so a set that would not fit stops', async () => {
    const { imagesToPdf } = await import('../../src/engines/pdf/images');
    const MB = 1048576;
    const F = LIMITS.imagePdfMemory.v8;
    const tight = { total: F.base + 2 * MB, heap: null, basis: 'device' as const, engine: 'v8' as const, deviceGB: 0.5 };
    // A 1,000 x 1,000 RGBA PNG is decoded here: 4 MB of samples, held and worked on several times over.
    const { zlibSync } = await import('fflate');
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(data.length + 12);
      const v = new DataView(out.buffer);
      v.setUint32(0, data.length);
      out.set(new TextEncoder().encode(type), 4);
      out.set(data, 8);
      v.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
      return out;
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 1000);
    new DataView(ihdr.buffer).setUint32(4, 1000);
    ihdr[8] = 8; ihdr[9] = 6;
    const raw = new Uint8Array(1000 * 4001).map((_, i) => (i % 4001 ? (i * 7) & 0xff : 0));
    const big = new Uint8Array([...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ...chunk('IHDR', ihdr), ...chunk('IDAT', zlibSync(raw)), ...chunk('IEND', new Uint8Array(0))]);
    await expect(imagesToPdf([{ file: new Blob([big]), format: 'png', name: 'big.png' }], opts(), tight, progress)).rejects.toThrow(/^big\.png: This picture needs about .* of memory, more than/);
    await expect(imagesToPdf([file('rgb8.png'), file('rgba16.png')], opts(), { ...tight, total: F.base + 60 * 1024 }, progress)).rejects.toMatchObject({ name: 'MemoryLimitError' });
    expect((await imagesToPdf([file('rgb8.png')], opts(), { ...tight, total: 4096 * MB }, progress)).pages).toBe(1);
    // A file whose size alone is too much is refused before it is read at all.
    const unread = { size: 200 * MB, arrayBuffer: () => { throw new Error('read before the check'); } } as unknown as Blob;
    await expect(imagesToPdf([{ file: unread, format: 'png', name: 'huge.png' }], opts(), tight, progress)).rejects.toMatchObject({ name: 'MemoryLimitError' });
  });

  test('a JPEG cut off before its end is refused when the PDF is made, too', async () => {
    const { imagesToPdf } = await import('../../src/engines/pdf/images');
    await expect(imagesToPdf([file('truncated.jpg')], opts(), undefined, progress)).rejects.toThrow(/^truncated\.jpg: This JPEG ends before its end marker/);
  });

  test('the check as a picture is added: damaged files refused with the reason, nothing decoded', async () => {
    const { checkPicture } = await import('../../src/engines/pdf/images');
    await expect(checkPicture(fx('truncated.jpg'), 'jpg')).rejects.toThrow(/^This JPEG ends before its end marker/);
    await expect(checkPicture(fx('crc.png'), 'png')).rejects.toThrow('This PNG is damaged: its IDAT chunk does not match its checksum.');
    await expect(checkPicture(fx('short.png'), 'png')).rejects.toThrow('This PNG is damaged or cut off: its picture data ends early.');
    await expect(checkPicture(fx('huge.png'), 'png')).rejects.toThrow('The picture is 40,000 x 40,000 pixels; the limit is 100 megapixels and 30,000 pixels on a side.');
    await expect(checkPicture(fx('baseline.jpg').subarray(0, 200), 'jpg')).rejects.toThrow('This JPEG ends before its picture data, as if it was cut off.');
    const bomb = await checkPicture(fx('bomb.png'), 'png');
    expect(bomb.notes.join(' ')).toContain('goes on past the picture');
    expect(await checkPicture(fx('orient6.jpg'), 'jpg')).toMatchObject({ width: 64, height: 48, pages: 1, path: 'jpeg', orientation: 6 });
    expect(await checkPicture(fx('gray16.tiff'), 'tiff')).toMatchObject({ width: 48, height: 32, pages: 1, path: 'decode', bits: 16, notes: ['It has 16 bits per channel; the PDF gets 8.'] });
    expect((await checkPicture(img('two-pages.tiff'), 'tiff')).work).toMatchObject({ pages: 2, path: 'decode' });
  });
});
