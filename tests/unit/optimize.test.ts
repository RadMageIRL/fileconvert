import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { crc32 } from '../../src/core/crc32';
import { estimateOptimize } from '../../src/core/imagememory';
import { readPng } from '../../src/engines/pdf/imageinfo';
import { decodePng } from '../../src/engines/pdf/pngdecode';
import { addIcc, avifFacts, patchNclx } from '../../src/engines/image/avifopt';
import { wasmFiles } from '../../src/engines/image/codecs';
import { JpegCoefError, optimalTable, readJpegCoefficients, sameCoefficients, writeJpegCoefficients } from '../../src/engines/image/jpegcoef';
import { compressJpeg, jpegFacts, optimizeJpegLossless, shiftMpf, uprightExif } from '../../src/engines/image/jpegopt';
import { exifFacts } from '../../src/engines/image/metadata';
import { resizeTarget } from '../../src/engines/image/optimize';
import { compressPng, pngFingerprint, readPngFile } from '../../src/engines/image/pngopt';
import { rgbaRows, writePng } from '../../src/engines/image/pngwrite';
import { orient, resample } from '../../src/engines/image/resample';
import { ssim } from '../../src/engines/image/ssim';
import { webpFacts, withMetadata } from '../../src/engines/image/webpopt';

// The image optimization engines (v0.2.0, Phase 3), in Node. The browser tests (tests/e2e/optimize.spec.ts) check the
// tools whole against independent readers; these hold the parts to their rules. The codecs' WebAssembly is read from
// the packages, since fetch in Node cannot.
const O = (f: string) => new Uint8Array(readFileSync(`tests/fixtures/optimize/${f}`));
const wasm = (p: string) => new Uint8Array(readFileSync(`node_modules/${p}`));
const noop = () => undefined;

beforeAll(() => {
  wasmFiles.oxipng = wasm('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm');
  wasmFiles.mozjpegDec = wasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm');
  wasmFiles.mozjpegEnc = wasm('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm');
});

describe('lossless JPEG optimization (coefficients)', () => {
  const files = ['photo.jpg', 'photo444.jpg', 'progressive.jpg', 'gray.jpg', 'cmyk.jpg', 'restart.jpg', 'exif-icc.jpg', 'mpf.jpg'];
  test.each(files)('%s: written baseline and progressive, read back with the same coefficients and tables, and smaller', f => {
    const b = O(f);
    const p = readJpegCoefficients(b);
    for (const prog of [false, true]) {
      const out = writeJpegCoefficients(p.frame, [], prog);
      const back = readJpegCoefficients(out);
      expect(sameCoefficients(p.frame, back.frame), `${f} ${prog}`).toBe(true);
      expect(back.frame.progressive).toBe(prog);
    }
    expect(writeJpegCoefficients(p.frame, p.segments, true).length).toBeLessThan(b.length);
  });

  test('one changed coefficient is told apart', () => {
    const p = readJpegCoefficients(O('photo.jpg'));
    const q = readJpegCoefficients(writeJpegCoefficients(p.frame, [], false));
    q.frame.comps[1].coef[64 * 7 + 3] += 1;
    expect(sameCoefficients(p.frame, q.frame)).toBe(false);
  });

  test('a cut-short file, arithmetic coding and 12-bit samples are refused with the reason', () => {
    const t = O('truncated.jpg');
    expect(() => readJpegCoefficients(t)).toThrow(JpegCoefError);
    expect(() => readJpegCoefficients(t)).toThrow(/damaged or cut short|no end marker/);
    const b = O('photo.jpg');
    const sof = b.indexOf(0xc0, 2);
    const arith = b.slice(); arith[sof] = 0xc9;
    expect(() => readJpegCoefficients(arith)).toThrow('This JPEG uses arithmetic coding, which lossless optimization does not read.');
    const twelve = b.slice(); twelve[sof + 3] = 12;
    expect(() => readJpegCoefficients(twelve)).toThrow('This JPEG has 12-bit samples; lossless optimization supports 8-bit JPEG only.');
  });

  test('optimal Huffman tables are complete prefix codes of at most 16 bits, one code point reserved', () => {
    const freq = new Int32Array(256);
    for (let i = 0; i < 256; i++) freq[i] = i % 7 === 0 ? 1 : Math.floor(1e6 / (i + 1));
    const t = optimalTable(freq);
    let kraft = 0;
    t.counts.forEach((n, i) => { kraft += n / 2 ** (i + 1); });
    expect(t.values.length).toBe(256);
    expect(kraft).toBeLessThan(1);
    expect(kraft + 2 ** -16).toBeLessThanOrEqual(1);
    // A table no symbol uses still has one code.
    expect(optimalTable(new Int32Array(256)).values.length).toBe(1);
  });

  test('the whole tool: lossless, every segment kept, the MPF index still points at the second picture', async () => {
    const b = O('mpf.jpg');
    const r = await optimizeJpegLossless(b, { progressive: true, removeMetadata: false }, noop);
    expect(r.bytes.length).toBeLessThan(b.length);
    expect(sameCoefficients(readJpegCoefficients(b).frame, readJpegCoefficients(r.bytes).frame)).toBe(true);
    // The second picture starts where the index says: its offset counts from the index's TIFF header.
    const mpfAt = findAscii(r.bytes, 'MPF\0') + 4;
    const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset);
    const ifd = mpfAt + dv.getUint32(mpfAt + 4);
    const entries = mpfAt + dv.getUint32(ifd + 2 + 2 * 12 + 8);
    const second = mpfAt + dv.getUint32(entries + 16 + 8);
    expect([r.bytes[second], r.bytes[second + 1]]).toEqual([0xff, 0xd8]);
    expect(dv.getUint32(entries + 16 + 4)).toBe(r.bytes.length - second);
  });

  test('shiftMpf moves every offset but the first picture\'s, and gives up on an index it cannot read', () => {
    const b = O('mpf.jpg');
    const s = findAscii(b, 'MPF\0') - 4;
    const len = (b[s + 2] << 8) | b[s + 3];
    const seg = b.slice(s, s + 2 + len);
    const moved = shiftMpf(seg, -100)!;
    const dv = (x: Uint8Array) => new DataView(x.buffer, x.byteOffset);
    const t = 8, ifd = dv(seg).getUint32(t + 4), entries = dv(seg).getUint32(t + ifd + 2 + 24 + 8);
    expect(dv(moved).getUint32(t + entries + 8)).toBe(0);
    expect(dv(moved).getUint32(t + entries + 16 + 8)).toBe(dv(seg).getUint32(t + entries + 16 + 8) - 100);
    const broken = seg.slice(); broken[t] = 0x41;
    expect(shiftMpf(broken, 5)).toBeNull();
  });

  test('uprightExif sets the orientation to 1 and leaves the rest', () => {
    const b = O('exif-icc.jpg');
    const s = findAscii(b, 'Exif\0\0') - 4;
    const seg = b.slice(s, s + 2 + ((b[s + 2] << 8) | b[s + 3]));
    expect(exifFacts(seg.subarray(10)).orientation).toBe(6);
    const up = uprightExif(seg);
    expect(exifFacts(up.subarray(10)).orientation).toBe(1);
    expect(findAscii(up, 'MARK-MAKE-JPEG')).toBeGreaterThan(0);
  });
});

describe('MozJPEG compression', () => {
  const env = { decodeCmyk: () => { throw new Error('no browser'); }, resize: (d: { data: Uint8ClampedArray; width: number; height: number }, w: number, h: number) => resample(d, w, h) as typeof d };
  test('to a file size: within it, the highest quality that fits, the dimensions the same; unreachable sizes say why', async () => {
    const b = O('photo.jpg');
    const r = await compressJpeg(b, { targetBytes: 12 * 1024, progressive: true, removeMetadata: false, fit: null, measure: false }, env, noop);
    expect(r.bytes.length).toBeLessThanOrEqual(12 * 1024);
    expect([r.width, r.height]).toEqual([320, 240]);
    const higher = await compressJpeg(b, { quality: r.quality! + 2, progressive: true, removeMetadata: false, fit: null, measure: false }, env, noop);
    expect(higher.bytes.length).toBeGreaterThan(12 * 1024);
    await expect(compressJpeg(b, { targetBytes: 1024, progressive: true, removeMetadata: false, fit: null, measure: false }, env, noop)).rejects.toThrow(/^At quality 10, the lowest this tool uses, the file is still/);
    // Already within the size: not recompressed.
    const same = await compressJpeg(b, { targetBytes: 300 * 1024, progressive: true, removeMetadata: false, fit: null, measure: false }, env, noop);
    expect(same.original).toBe(true);
    expect(same.bytes).toBe(b);
  });

  test('the orientation and the other EXIF details are carried, the pixels not turned; the fit is in the upright orientation', async () => {
    const b = O('exif-icc.jpg');
    const r = await compressJpeg(b, { quality: 80, progressive: true, removeMetadata: false, fit: { width: 60, height: 200 }, measure: false }, env, noop);
    expect(jpegFacts(r.bytes).orientation).toBe(6);
    // Upright 240 x 320 fits 60 x 200 at 60 x 80; stored sideways that is 80 x 60.
    expect([r.width, r.height]).toEqual([80, 60]);
    expect(findAscii(r.bytes, 'MARK-MAKE-JPEG')).toBeGreaterThan(0);
  });
});

describe('Compress PNG', () => {
  test('damaged files are refused with the reason', () => {
    expect(() => readPngFile(O('truncated.png'))).toThrow('This PNG is cut short: it has no end chunk.');
    expect(() => readPngFile(O('badcrc.png'))).toThrow(/does not match its checksum/);
  });

  test('the fingerprint is the picture, not how it is stored, and one changed pixel changes it', async () => {
    const b = O('rgb.png');
    const f = readPngFile(b);
    const fp = pngFingerprint(b, f).join();
    const L = f.layout;
    const p = decodePng(b, L);
    const n = L.info.width * L.info.height;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { rgba[4 * i] = p.color[3 * i]; rgba[4 * i + 1] = p.color[3 * i + 1]; rgba[4 * i + 2] = p.color[3 * i + 2]; rgba[4 * i + 3] = 255; }
    const again = await writePng(rgbaRows(rgba, L.info.width, L.info.height));
    expect(pngFingerprint(again, readPngFile(again)).join()).toBe(fp);
    rgba[4 * 1234 + 1] ^= 1;
    const changed = await writePng(rgbaRows(rgba, L.info.width, L.info.height));
    expect(pngFingerprint(changed, readPngFile(changed)).join()).not.toBe(fp);
  });

  test.each(['rgb.png', 'rgba.png', 'palette.png', 'rgb16-8.png', 'rgb16.png', 'gray-rgb-icc.png', 'meta.png', 'interlaced.png', 'animated.png'])('%s: the same picture, smaller or the same', async f => {
    const b = O(f);
    const r = await compressPng(b, { level: 2, removeMetadata: false, keep16: true }, noop);
    expect(pngFingerprint(r.bytes, readPngFile(r.bytes))).toEqual(pngFingerprint(b, readPngFile(b)));
    expect(r.bytes.length).toBeLessThanOrEqual(b.length);
  });

  test('gray pixels with an RGB profile stay RGB; 16 bits stay unless allowed', async () => {
    const g = await compressPng(O('gray-rgb-icc.png'), { level: 2, removeMetadata: false, keep16: true }, noop);
    expect(readPngFile(g.bytes).layout.colorType).toBe(2);
    expect(readPngFile(g.bytes).iccSpace).toBe('RGB ');
    const keep = await compressPng(O('rgb16-8.png'), { level: 2, removeMetadata: false, keep16: true }, noop);
    expect(readPngFile(keep.bytes).layout.depth).toBe(16);
    const allow = await compressPng(O('rgb16-8.png'), { level: 2, removeMetadata: false, keep16: false }, noop);
    expect(readPngFile(allow.bytes).layout.depth).toBe(8);
  });
});

describe('the PNG writer, resampling and SSIM', () => {
  test('writes 8 and 16-bit RGBA and gray that decode to the same samples', async () => {
    const w = 37, h = 11;
    for (const wide of [false, true]) {
      const d = wide ? new Uint16Array(w * h * 4) : new Uint8ClampedArray(w * h * 4);
      const max = wide ? 65535 : 255;
      for (let i = 0; i < w * h; i++) { d[4 * i] = (i * 31) % max; d[4 * i + 1] = (i * 17) % max; d[4 * i + 2] = (i * 7) % max; d[4 * i + 3] = i % 5 ? max : 0; }
      const png = await writePng(rgbaRows(d, w, h));
      const L = readPng(png, true, crc32);
      expect([L.colorType, L.depth]).toEqual([6, wide ? 16 : 8]);
      const p = decodePng(png, L);
      for (let i = 0; i < w * h; i++) {
        const c = wide ? (p.color[6 * i] << 8) | p.color[6 * i + 1] : p.color[3 * i];
        expect(c).toBe(d[4 * i]);
      }
    }
  });

  test('a flat picture stays flat; transparent edges do not darken; 16 bits stay 16 bits', () => {
    const w = 50, h = 40;
    const flat = new Uint16Array(w * h * 4).fill(40000);
    const r = resample({ data: flat, width: w, height: h }, 17, 9);
    expect(r.data).toBeInstanceOf(Uint16Array);
    expect(new Set(r.data)).toEqual(new Set([40000]));
    // White opaque on the left, black fully transparent on the right: the result's opaque pixels stay white.
    const half = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = 4 * (y * w + x); if (x < 25) half.set([255, 255, 255, 255], i); else half.set([0, 0, 0, 0], i); }
    const s = resample({ data: half, width: w, height: h }, 20, 16);
    for (let i = 0; i < s.data.length; i += 4) if (s.data[i + 3] > 8) expect(s.data[i], `pixel ${i / 4}`).toBeGreaterThanOrEqual(250);
  });

  test('each EXIF orientation puts the stored top left corner where it belongs', () => {
    const d = new Uint8ClampedArray(3 * 2 * 4);
    d[0] = 255; // the stored top left pixel, red
    const where: Record<number, [number, number, number, number]> = { 2: [3, 2, 2, 0], 3: [3, 2, 2, 1], 4: [3, 2, 0, 1], 5: [2, 3, 0, 0], 6: [2, 3, 1, 0], 7: [2, 3, 1, 2], 8: [2, 3, 0, 2] };
    for (const [o, [w, h, x, y]] of Object.entries(where)) {
      const r = orient({ data: d, width: 3, height: 2 }, Number(o));
      expect([r.width, r.height], `orientation ${o}`).toEqual([w, h]);
      expect(r.data[4 * (y * w + x)], `orientation ${o}`).toBe(255);
    }
  });

  test('SSIM is 1 for the same picture, less for a changed one, none for one smaller than its window', () => {
    const w = 64, h = 48;
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { a[4 * i] = (i * 13) % 256; a[4 * i + 1] = (i * 7) % 256; a[4 * i + 2] = 99; a[4 * i + 3] = 255; }
    expect(ssim(a, a, w, h)).toBeCloseTo(1, 10);
    const b = a.slice();
    for (let i = 0; i < b.length; i += 4) b[i] = Math.min(255, b[i] + ((i / 4) % 3) * 20);
    const v = ssim(a, b, w, h)!;
    expect(v).toBeLessThan(0.9999);
    expect(v).toBeGreaterThan(0.5);
    expect(ssim(a, a, 10, 10)).toBeNull();
  });

  test('sizes: fit within keeps the shape, exact stretches, percent scales, nothing is enlarged unless allowed', () => {
    const base = { by: 'size' as const, width: 0, height: 0, lock: true, percent: 50, enlarge: false, to: 'same' as const, quality: 85, removeMetadata: false };
    expect(resizeTarget(4000, 3000, { ...base, width: 1920, height: 1080 })).toEqual({ width: 1440, height: 1080 });
    expect(resizeTarget(4000, 3000, { ...base, width: 1000 })).toEqual({ width: 1000, height: 750 });
    expect(resizeTarget(4000, 3000, { ...base, lock: false, width: 500, height: 500 })).toEqual({ width: 500, height: 500 });
    expect(resizeTarget(4000, 3000, { ...base, by: 'percent', percent: 25 })).toEqual({ width: 1000, height: 750 });
    expect(resizeTarget(800, 600, { ...base, width: 1920, height: 1080 })).toMatchObject({ width: 800, height: 600 });
    expect(resizeTarget(800, 600, { ...base, width: 1920, height: 1080, enlarge: true })).toEqual({ width: 1440, height: 1080 });
    expect(resizeTarget(800, 600, { ...base, lock: false, width: 1000, height: 300 })).toMatchObject({ width: 800, height: 300 });
  });
});

describe('WebP and AVIF boxes', () => {
  test('WebP facts: lossless, transparency, animation, profile and EXIF', () => {
    expect(webpFacts(O('lossless.webp'))).toMatchObject({ lossless: true, animated: false, width: 160, height: 120 });
    expect(webpFacts(O('lossy.webp'))).toMatchObject({ lossless: false, alpha: false });
    expect(webpFacts(O('alpha.webp')).alpha).toBe(true);
    expect(webpFacts(O('animated.webp'))).toMatchObject({ animated: true, frames: 3 });
    const m = webpFacts(O('meta.webp'));
    expect(m.icc).not.toBeNull();
    expect(m.exif).not.toBeNull();
  });

  test('metadata goes into an extended header whose flags and sizes match its chunks', () => {
    const plain = O('lossy.webp');
    const f = webpFacts(O('meta.webp'));
    const out = withMetadata(plain, { icc: f.icc, exif: f.exif }, 160, 120);
    const g = webpFacts(out);
    expect(g.icc).toEqual(f.icc);
    expect(g.exif).toEqual(f.exif);
    expect(out[20] & 0x28).toBe(0x28); // ICC and EXIF flags
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  test('AVIF facts: bit depth, HDR description, rotation, profile, metadata, alpha, animation', () => {
    expect(avifFacts(O('photo.avif'))).toMatchObject({ bits: 8, animated: false, width: 128, height: 96 });
    const hdr = avifFacts(O('hdr10.avif'));
    expect(hdr.bits).toBe(10);
    expect([hdr.nclx!.primaries, hdr.nclx!.transfer]).toEqual([9, 16]);
    expect(avifFacts(O('rotated.avif')).transforms).toEqual([{ kind: 'irot', turns: 3 }]);
    expect(avifFacts(O('icc.avif')).icc).not.toBeNull();
    expect(avifFacts(O('exif.avif')).metadata).toEqual(['EXIF']);
    expect(avifFacts(O('alpha.avif')).alpha).toBe(true);
    expect(avifFacts(O('animated.avif')).animated).toBe(true);
  });

  test('an ICC profile added to an AVIF: the boxes still read, the profile is there, and the item data still lines up', () => {
    const b = O('photo.avif');
    const icc = avifFacts(O('icc.avif')).icc!;
    const out = addIcc(b, icc)!;
    expect(out.length).toBe(b.length + 12 + icc.length + 1);
    const f = avifFacts(out);
    expect(f.icc).toEqual(icc);
    expect([f.width, f.height]).toEqual([128, 96]);
    // The coded picture (the mdat payload) is the same bytes, moved.
    const mdat = (x: Uint8Array) => x.subarray(findAscii(x, 'mdat') + 4);
    expect(Buffer.compare(Buffer.from(mdat(out)), Buffer.from(mdat(b)))).toBe(0);
    const p = out.slice();
    expect(patchNclx(p, 12, 13)).toBe(true);
    expect(avifFacts(p).nclx).toMatchObject({ primaries: 12, transfer: 13 });
  });
});

describe('memory estimates', () => {
  test('grow with the picture, and the figures for unknown browsers are the highest', () => {
    const w = { bytes: 5e6, width: 4000, height: 3000, raw: 36e6, bits: 8, coefficients: 1.5 };
    for (const op of ['png', 'jpeg-lossless', 'jpeg', 'webp', 'webp-lossless', 'avif', 'resize'] as const) {
      const small = estimateOptimize(op, { ...w, width: 1000, height: 750, raw: 2.25e6 }, { engine: 'v8' }).total;
      expect(estimateOptimize(op, w, { engine: 'v8' }).total, op).toBeGreaterThan(small);
      expect(estimateOptimize(op, w, { engine: 'other' }).total, op).toBeGreaterThanOrEqual(estimateOptimize(op, w, { engine: 'gecko' }).total);
      expect(estimateOptimize(op, w, { engine: 'other' }).total, op).toBeGreaterThanOrEqual(estimateOptimize(op, w, { engine: 'v8' }).total);
    }
    expect(estimateOptimize('jpeg', w, { engine: 'v8', measure: true }).total).toBeGreaterThan(estimateOptimize('jpeg', w, { engine: 'v8' }).total);
  });
});

function findAscii(b: Uint8Array, s: string): number {
  outer: for (let i = 0; i + s.length <= b.length; i++) {
    for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}
