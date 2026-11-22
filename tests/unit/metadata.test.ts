import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CATEGORY, exifFacts, KEPT, minimalExif, stripMetadata, type MetadataFormat } from '../../src/engines/image/metadata';

// Metadata removal (v0.2.0). The fixtures carry distinctive planted values (see tools/make-fixtures.py); none of
// them may survive anywhere in a result, and the compressed picture must come through byte for byte.

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const PLANTED = ['LeakyCam', 'LC-1000', 'Jane Example', 'SERIAL-123456', 'SecretProject', 'Secret comment', 'MOTIONVIDEO-SECRET', '2024:05:06'];
const latin1 = (b: Uint8Array) => Array.from(b, c => String.fromCharCode(c)).join('');
const strip = (file: string, format: MetadataFormat, keepOrientation = true, keepColorProfile = true) => stripMetadata(fx(file), format, { keepOrientation, keepColorProfile });

/** JPEG segments by marker, and the entropy-coded data, so the picture data can be compared. */
function jpegParts(b: Uint8Array): { markers: string[]; picture: string } {
  const markers: string[] = [];
  let p = 2, picture = '';
  while (p < b.length) {
    const m = b[p + 1];
    if (m === 0xd9) break;
    const len = (b[p + 2] << 8) | b[p + 3];
    const seg = latin1(b.subarray(p, p + 2 + len));
    markers.push(m.toString(16));
    if (m < 0xe0 && m !== 0xfe) picture += seg;
    p += 2 + len;
    if (m === 0xda) {
      let q = p;
      while (!(b[q] === 0xff && b[q + 1] !== 0 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7))) q++;
      picture += latin1(b.subarray(p, q));
      p = q;
    }
  }
  return { markers, picture };
}

/** PNG chunks: type and raw bytes. */
function pngChunks(b: Uint8Array): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 8; p + 12 <= b.length;) {
    const len = dv.getUint32(p);
    const type = latin1(b.subarray(p + 4, p + 8));
    out.push([type, latin1(b.subarray(p, p + 12 + len))]);
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** WebP chunks: type and raw bytes. */
function webpChunks(b: Uint8Array): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 12; p + 8 <= b.length;) {
    const len = dv.getUint32(p + 4, true);
    out.push([latin1(b.subarray(p, p + 4)), latin1(b.subarray(p, p + 8 + len + (len & 1)))]);
    p += 8 + len + (len & 1);
  }
  return out;
}

describe('JPEG', () => {
  test('no planted value survives; the picture data, tables and color profile are copied byte for byte', () => {
    const src = fx('image/meta-full.jpg');
    const r = strip('image/meta-full.jpg', 'jpg');
    const out = latin1(r.bytes);
    for (const s of PLANTED) expect(out, s).not.toContain(s);
    expect(jpegParts(r.bytes).picture).toBe(jpegParts(src).picture);
    // The ICC segment is identical.
    const icc = (b: Uint8Array) => latin1(b).match(/ICC_PROFILE\0[\s\S]*?(?=\xff[\xc0-\xfe])/)?.[0];
    expect(icc(r.bytes)).toBe(icc(src));
    expect(r.removed).toEqual(expect.arrayContaining([CATEGORY.exif, CATEGORY.date, CATEGORY.gps, CATEGORY.thumbnail, CATEGORY.maker, CATEGORY.xmp, CATEGORY.iptc, CATEGORY.comment, CATEGORY.trailer]));
    expect(r.kept).toEqual([KEPT.icc, KEPT.orientation]);
  });

  test('a sideways photo keeps a minimal EXIF block with only its orientation, right after JFIF', () => {
    const r = strip('image/meta-full.jpg', 'jpg');
    const { markers } = jpegParts(r.bytes);
    expect(markers.slice(0, 2)).toEqual(['e0', 'e1']);
    const at = latin1(r.bytes).indexOf('Exif\0\0') + 6;
    const exif = r.bytes.subarray(at, at + minimalExif(6).length);
    expect([...exif]).toEqual([...minimalExif(6)]);
    expect(exifFacts(exif)).toEqual({ orientation: 6, gps: false, date: false, thumbnail: false, maker: false });
  });

  test('with orientation and color profile off, no EXIF and no ICC are left', () => {
    const r = strip('image/meta-full.jpg', 'jpg', false, false);
    const out = latin1(r.bytes);
    expect(out).not.toContain('Exif\0\0');
    expect(out).not.toContain('ICC_PROFILE');
    expect(r.kept).toEqual([]);
    expect(r.removed).toContain(CATEGORY.icc);
  });

  test('running it twice changes nothing more, and a clean photo comes back unchanged', () => {
    const once = strip('image/meta-full.jpg', 'jpg').bytes;
    expect(stripMetadata(once, 'jpg', { keepOrientation: true, keepColorProfile: true }).bytes).toEqual(once);
    const clean = fx('image/photo.jpg');
    const r = stripMetadata(clean, 'jpg', { keepOrientation: true, keepColorProfile: true });
    expect(jpegParts(r.bytes).picture).toBe(jpegParts(clean).picture);
  });

  test('a cut-off or damaged JPEG is refused with a reason', () => {
    const src = fx('image/meta-full.jpg');
    expect(() => stripMetadata(src.subarray(0, src.length / 2), 'jpg', { keepOrientation: true, keepColorProfile: true })).toThrow(/cut short|damaged/);
    expect(() => stripMetadata(fx('image/alpha.png'), 'jpg', { keepOrientation: true, keepColorProfile: true })).toThrow('This is not a JPEG file.');
  });
});

describe('PNG', () => {
  test('text, XMP, EXIF, time, private chunks and trailing data go; image, transparency and color chunks stay', () => {
    const src = fx('image/meta-full.png');
    const r = strip('image/meta-full.png', 'png');
    const out = latin1(r.bytes);
    for (const s of PLANTED) expect(out, s).not.toContain(s);
    const keepTypes = (c: Array<[string, string]>) => c.filter(([t]) => ['IHDR', 'IDAT', 'IEND', 'iCCP'].includes(t));
    expect(keepTypes(pngChunks(r.bytes))).toEqual(keepTypes(pngChunks(src)));
    expect(pngChunks(r.bytes).map(([t]) => t)).toEqual(['IHDR', 'iCCP', 'eXIf', 'IDAT', 'IEND']);
    expect(r.removed).toEqual(expect.arrayContaining([CATEGORY.text, CATEGORY.xmp, CATEGORY.exif, CATEGORY.gps, CATEGORY.time, CATEGORY.vendor, CATEGORY.trailer]));
    expect(r.kept).toEqual([KEPT.icc, KEPT.orientation]);
  });

  test('a PNG without metadata is returned byte for byte', () => {
    const src = fx('image/alpha.png');
    const r = stripMetadata(src, 'png', { keepOrientation: true, keepColorProfile: true });
    expect(r.bytes).toEqual(src);
    expect(r.removed).toEqual([]);
  });
});

describe('WebP', () => {
  test('EXIF, XMP and private chunks go; the picture and alpha chunks are identical and the flags match what is left', () => {
    const src = fx('image/meta-full.webp');
    const r = strip('image/meta-full.webp', 'webp');
    const out = latin1(r.bytes);
    for (const s of PLANTED) expect(out, s).not.toContain(s);
    const pictureChunks = (c: Array<[string, string]>) => c.filter(([t]) => ['VP8 ', 'VP8L', 'ALPH', 'ICCP'].includes(t));
    expect(pictureChunks(webpChunks(r.bytes))).toEqual(pictureChunks(webpChunks(src)));
    expect(webpChunks(r.bytes).map(([t]) => t)).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8 ', 'EXIF']);
    const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset);
    expect(dv.getUint32(4, true)).toBe(r.bytes.length - 8);
    expect(r.bytes[20] & 0x3c).toBe(0x20 | 0x08 | (src[20] & 0x10));
    expect(r.removed).toEqual(expect.arrayContaining([CATEGORY.exif, CATEGORY.gps, CATEGORY.xmp, CATEGORY.vendor]));
  });

  test('with orientation and color profile off, the EXIF and ICC flags are cleared', () => {
    const r = strip('image/meta-full.webp', 'webp', false, false);
    expect(webpChunks(r.bytes).map(([t]) => t)).toEqual(['VP8X', 'ALPH', 'VP8 ']);
    expect(r.bytes[20] & (0x20 | 0x08 | 0x04)).toBe(0);
  });
});
