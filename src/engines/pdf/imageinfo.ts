// What a picture holds, read from its own bytes before anything decodes it, for Images to PDF: its size in pixels,
// color channels and bits, EXIF orientation, resolution, color profile and transparency, and how it can go into a PDF.
//
// A JPEG goes in as it is: its compressed data is copied byte for byte (src/engines/pdf/images.ts), unless it is a kind
// of JPEG that PDF readers do not read (12-bit, lossless, hierarchical or arithmetic coded), which is decoded instead.
// A PNG goes in as it is when PDF can say what it holds: gray, color or a palette at any bit depth, 16 bits included,
// and one transparent color; with an alpha channel, a palette with transparency, or interlacing, it is decoded here,
// exactly, and stored losslessly. Other formats are decoded by the browser. Nothing here allocates more than the
// header it reads; it is used on the page (from the start of the file, as each picture is added) and in the PDF worker
// (from the whole file).

export type PicturePath = 'jpeg' | 'png' | 'png-decode' | 'decode';

export interface PictureInfo {
  /** Pixels as stored, before the EXIF orientation is applied. */
  width: number;
  height: number;
  /** Color channels, not counting alpha: 1 (gray, or a palette index), 3 (RGB) or 4 (CMYK). */
  channels: number;
  /** Bits per channel as stored. */
  bits: number;
  path: PicturePath;
  /** Transparency: an alpha channel, one transparent color, or transparent palette entries. */
  alpha: 'none' | 'channel' | 'key' | 'palette';
  /** EXIF orientation, 1 to 8 (1 when there is none). */
  orientation: number;
  /** Pixels per inch across and down, when the file says. */
  dpi: [number, number] | null;
  /** An embedded color profile: none, one the PDF can use, or one it cannot (damaged, or for other channels). */
  icc: 'none' | 'kept' | 'unusable';
  animated: boolean;
  /** EXIF, XMP, comments and other metadata the file carries, which are not copied into the PDF. */
  metadata: boolean;
  /** Facts about this picture for the result: why it is decoded, what is not kept. */
  notes: string[];
  /** Bytes of the decoded samples at their own depth, alpha included (what decoding it holds). */
  raw: number;
  /** Pages in the file (a multi-page TIFF), 1 otherwise. */
  pages: number;
}

/** The header goes on past the bytes given: read more of the file and try again. */
export class NeedMore extends Error {
  constructor() {
    super('More of the file is needed.');
    this.name = 'NeedMore';
  }
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const startsWith = (b: Uint8Array, at: number, s: string) => at + s.length <= b.length && ascii(b, at, s.length) === s;

/** A plausible resolution (pixels per inch); anything else is treated as not given. */
const plausible = (d: number) => Number.isFinite(d) && d >= 10 && d <= 10_000;

/** Display size: orientations 5 to 8 turn the picture a quarter turn. */
export function displaySize(info: Pick<PictureInfo, 'width' | 'height' | 'orientation'>): [number, number] {
  return info.orientation >= 5 ? [info.height, info.width] : [info.width, info.height];
}

// ------------------------------------------------------------------ EXIF (a TIFF structure)

interface ExifFacts {
  orientation: number;
  dpi: [number, number] | null;
}

/** Orientation and resolution from EXIF data (a TIFF header and its first IFD), read with every bound checked. */
export function readExif(b: Uint8Array, start: number, end: number): ExifFacts {
  const out: ExifFacts = { orientation: 1, dpi: null };
  if (start + 8 > end) return out;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return out;
  const r16 = (i: number) => le ? b[i] | (b[i + 1] << 8) : u16be(b, i);
  const r32 = (i: number) => le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : u32be(b, i);
  const ifd = start + r32(start + 4);
  if (ifd + 2 > end) return out;
  const n = r16(ifd);
  let xres = 0, yres = 0, unit = 2;
  const rational = (e: number) => {
    const at = start + r32(e + 8);
    if (at + 8 > end) return 0;
    const den = r32(at + 4);
    return den ? r32(at) / den : 0;
  };
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    const tag = r16(e), type = r16(e + 2);
    if (tag === 0x0112 && type === 3) { const v = r16(e + 8); if (v >= 1 && v <= 8) out.orientation = v; }
    else if (tag === 0x011a && type === 5) xres = rational(e);
    else if (tag === 0x011b && type === 5) yres = rational(e);
    else if (tag === 0x0128 && type === 3) unit = r16(e + 8);
  }
  const k = unit === 3 ? 2.54 : unit === 2 ? 1 : 0;
  if (k && plausible(xres * k) && plausible(yres * k)) out.dpi = [xres * k, yres * k];
  return out;
}

// ------------------------------------------------------------------ ICC profiles

const ICC_SPACE: Record<number, string> = { 1: 'GRAY', 3: 'RGB ', 4: 'CMYK' };

/** Whether a color profile can describe a picture's channels in a PDF (ICCBased): whole, an input, display, output or
 *  color space profile, for that many channels. */
export function iccUsable(p: Uint8Array, channels: number): boolean {
  if (p.length < 132) return false;
  const size = u32be(p, 0);
  if (size < 132 || size > p.length) return false;
  if (!startsWith(p, 36, 'acsp')) return false;
  if (!['scnr', 'mntr', 'prtr', 'spac'].includes(ascii(p, 12, 4))) return false;
  return ascii(p, 16, 4) === ICC_SPACE[channels];
}

// ------------------------------------------------------------------ JPEG

/** Frame types PDF readers decode (DCTDecode): baseline, extended sequential and progressive, Huffman coded. */
const SOF_PDF = new Set([0xc0, 0xc1, 0xc2]);
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

export interface JpegLayout {
  info: PictureInfo;
  /** Segments kept before the first scan, [start, end) with their markers: tables, the frame header, JFIF and Adobe. */
  keep: Array<[number, number]>;
  /** Where the first scan's marker is. */
  sos: number;
  icc: Uint8Array | null;
  /** The Adobe segment's color transform (0: none, 1: YCbCr, 2: YCCK), or null when there is none. */
  adobe: number | null;
  /** The frame's component ids, in order. */
  ids: number[];
  /** Whether the frame header says JFIF (YCbCr for three channels). */
  jfif: boolean;
}

/** A JPEG's header, up to its first scan. Throws NeedMore when the bytes end before the scan. */
export function readJpeg(b: Uint8Array): JpegLayout {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('This is not a JPEG picture.');
  const keep: Array<[number, number]> = [];
  const icc = new Map<number, Uint8Array>();
  let iccTotal = 0, iccBad = false;
  let adobe: number | null = null, jfif = false, jfifDpi: [number, number] | null = null;
  let exif: ExifFacts = { orientation: 1, dpi: null };
  let metadata = false;
  let sof: { marker: number; precision: number; width: number; height: number; ids: number[] } | null = null;
  let p = 2;
  for (;;) {
    if (p + 2 > b.length) throw new NeedMore();
    if (b[p] !== 0xff) throw new Error('This JPEG is damaged: its header could not be read.');
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { p += 2; continue; }
    if (m === 0xd9) throw new Error('This JPEG has no picture in it.');
    if (p + 4 > b.length) throw new NeedMore();
    const len = u16be(b, p + 2);
    if (len < 2) throw new Error('This JPEG is damaged: its header could not be read.');
    if (m === 0xda) break;
    const end = p + 2 + len;
    if (end > b.length) throw new NeedMore();
    const s = p + 4;
    if (m === 0xe0 && startsWith(b, s, 'JFIF\0') && len >= 16) {
      jfif = true;
      const units = b[s + 7], xd = u16be(b, s + 8), yd = u16be(b, s + 10);
      const k = units === 1 ? 1 : units === 2 ? 2.54 : 0;
      if (k && plausible(xd * k) && plausible(yd * k)) jfifDpi = [xd * k, yd * k];
      keep.push([p, end]);
    } else if (m === 0xe1 && startsWith(b, s, 'Exif\0\0')) {
      exif = readExif(b, s + 6, end);
      metadata = true;
    } else if (m === 0xe2 && startsWith(b, s, 'ICC_PROFILE\0') && len >= 16) {
      const seq = b[s + 12], total = b[s + 13];
      if (!seq || !total || (iccTotal && total !== iccTotal) || icc.has(seq)) iccBad = true;
      iccTotal = total;
      icc.set(seq, b.subarray(s + 14, end));
    } else if (m === 0xee && startsWith(b, s, 'Adobe') && len >= 14) {
      adobe = b[s + 11];
      keep.push([p, end]);
    } else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      // Other application data (XMP, IPTC, Photoshop, maker data, a second picture's index) and comments.
      metadata = true;
    } else {
      if (isSof(m)) {
        if (len < 8) throw new Error('This JPEG is damaged: its frame header is too short.');
        const n = b[s + 5];
        if (len < 8 + 3 * n) throw new Error('This JPEG is damaged: its frame header is too short.');
        sof = { marker: m, precision: b[s], height: u16be(b, s + 1), width: u16be(b, s + 3), ids: Array.from({ length: n }, (_, i) => b[s + 6 + 3 * i]) };
      }
      keep.push([p, end]);
    }
    p = end;
  }
  if (!sof) throw new Error('This JPEG has no frame header, so its size is unknown.');
  if (!sof.width || !sof.height) throw new Error('This JPEG gives its height only after the picture data (a DNL marker), which FileConvert does not read.');
  const channels = sof.ids.length;
  const notes: string[] = [];
  let path: PicturePath = 'jpeg';
  if (![1, 3, 4].includes(channels)) throw new Error(`This JPEG has ${channels} color channels; FileConvert reads JPEGs with 1, 3 or 4.`);
  if (!SOF_PDF.has(sof.marker)) {
    path = 'decode';
    const kind = sof.marker === 0xc3 || sof.marker === 0xc7 || sof.marker === 0xcb || sof.marker === 0xcf ? 'lossless' : sof.marker >= 0xc9 ? 'arithmetic-coded' : 'hierarchical';
    notes.push(`It is a ${kind} JPEG, which PDF readers do not read, so the browser decoded it and its pixels are stored without loss.`);
  } else if (sof.precision !== 8) {
    path = 'decode';
    notes.push(`It is a ${sof.precision}-bit JPEG, which PDF readers do not read, so the browser decoded it.`);
  }
  let profile: Uint8Array | null = null;
  let iccState: PictureInfo['icc'] = 'none';
  if (icc.size) {
    if (!iccBad && icc.size === iccTotal) {
      const parts = Array.from({ length: iccTotal }, (_, i) => icc.get(i + 1));
      if (parts.every(Boolean)) {
        profile = new Uint8Array(parts.reduce((n, x) => n + x!.length, 0));
        let at = 0;
        for (const x of parts) { profile.set(x!, at); at += x!.length; }
      }
    }
    iccState = profile && iccUsable(profile, channels) ? 'kept' : 'unusable';
    if (iccState === 'unusable') { profile = null; notes.push('Its color profile is damaged or not for its colors, so it is not used.'); }
  }
  const info: PictureInfo = {
    width: sof.width, height: sof.height, channels, bits: sof.precision, path, alpha: 'none',
    orientation: exif.orientation, dpi: jfifDpi ?? exif.dpi, icc: iccState, animated: false, metadata, notes,
    raw: sof.width * sof.height * (channels === 1 ? 1 : 4), pages: 1,
  };
  return { info, keep, sos: p, icc: profile, adobe, ids: sof.ids, jfif };
}

export interface JpegStream {
  /** The JPEG to embed: its tables, frame and every scan as they were, without metadata. */
  data: Uint8Array;
  /** The file ended before its end marker; one was added. */
  truncated: boolean;
  /** Bytes after the end marker (a second picture, a camera's trailer), left out. */
  trailing: number;
}

/**
 * The JPEG as a PDF holds it: the start marker, the segments kept from the header, and from the first scan on, every
 * scan's header and its entropy-coded data byte for byte, with the tables between scans (progressive JPEGs), up to the
 * end marker. Application data and comments, in the header or between scans, are left out; nothing is decoded.
 */
export function jpegStream(b: Uint8Array, L: JpegLayout): JpegStream {
  const parts: Uint8Array[] = [b.subarray(0, 2), ...L.keep.map(([s, e]) => b.subarray(s, e))];
  const w = jpegWalk(b, L, part => parts.push(part));
  if (!w.ended) parts.push(new Uint8Array([0xff, 0xd9]));
  const data = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { data.set(x, at); at += x.length; }
  return { data, truncated: !w.ended, trailing: w.trailing };
}

/** Walks a JPEG from its first scan to its end marker, handing on each part a PDF keeps (scans, tables between them,
 *  restarts, the end marker) without copying anything. */
export function jpegWalk(b: Uint8Array, L: JpegLayout, keep: (part: Uint8Array) => void = () => undefined): { ended: boolean; trailing: number } {
  const parts = { push: keep };
  let p = L.sos;
  let ended = false;
  while (p + 1 < b.length) {
    if (b[p] !== 0xff) break;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) { parts.push(b.subarray(p, p + 2)); p += 2; ended = true; break; }
    if (m >= 0xd0 && m <= 0xd7) { parts.push(b.subarray(p, p + 2)); p += 2; continue; }
    if (p + 4 > b.length) break;
    const end = p + 2 + u16be(b, p + 2);
    if (end > b.length) break;
    if (m === 0xda) {
      // The scan's entropy-coded data runs to the next marker that is not a stuffed zero or a restart.
      let q = end;
      for (;;) {
        q = b.indexOf(0xff, q);
        if (q < 0 || q + 1 >= b.length) { q = b.length; break; }
        const n = b[q + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { q += 2; continue; }
        if (n === 0xff) { q += 1; continue; }
        break;
      }
      parts.push(b.subarray(p, q));
      p = q;
      continue;
    }
    if (!((m >= 0xe0 && m <= 0xef) || m === 0xfe)) parts.push(b.subarray(p, end));
    p = end;
  }
  return { ended, trailing: ended ? b.length - p : 0 };
}

// ------------------------------------------------------------------ PNG

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface PngLayout {
  info: PictureInfo;
  colorType: number;
  depth: number;
  interlaced: boolean;
  /** The PLTE chunk's data (RGB triples), and the tRNS chunk's. */
  palette: Uint8Array | null;
  trns: Uint8Array | null;
  /** The iCCP chunk's compressed profile (zlib), when there is one. */
  iccCompressed: Uint8Array | null;
  /** The IDAT chunks' data, [start, end) in the file, in order (only when read whole). */
  idat: Array<[number, number]>;
  /** Bytes of one row of the file's picture data, filter byte left out, at full width. */
  rowBytes: number;
}

/** A PNG's chunks: up to the first IDAT (`whole` false: the header on the page), or all of them, IDAT data included,
 *  with every chunk's checksum checked (`whole` true, in the worker). */
export function readPng(b: Uint8Array, whole: boolean, crc?: (data: Uint8Array) => number): PngLayout {
  if (b.length < 8 || PNG_SIG.some((v, i) => b[i] !== v)) throw new Error('This is not a PNG picture.');
  let p = 8;
  let ihdr: { w: number; h: number; depth: number; ct: number; interlace: number } | null = null;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null, iccCompressed: Uint8Array | null = null;
  let srgb = false, gamma = 0, animated = false, metadata = false, ended = false;
  let exif: ExifFacts = { orientation: 1, dpi: null };
  let dpi: [number, number] | null = null;
  const idat: Array<[number, number]> = [];
  for (;;) {
    if (p + 8 > b.length) { if (whole) break; throw new NeedMore(); }
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    const s = p + 8, end = s + len;
    if (len > 0x7fffffff) throw new Error('This PNG is damaged: a chunk claims an impossible size.');
    if (type === 'IDAT' && !whole) break;
    if (end + 4 > b.length) { if (whole && type !== 'IHDR') break; throw new NeedMore(); }
    if (whole && crc && crc(b.subarray(p + 4, end)) !== u32be(b, end)) throw new Error(`This PNG is damaged: its ${type} chunk does not match its checksum.`);
    if (!ihdr && type !== 'IHDR') throw new Error('This PNG is damaged: it does not start with its header chunk.');
    switch (type) {
      case 'IHDR':
        if (len < 13) throw new Error('This PNG is damaged: its header chunk is too short.');
        ihdr = { w: u32be(b, s), h: u32be(b, s + 4), depth: b[s + 8], ct: b[s + 9], interlace: b[s + 12] };
        if (b[s + 10] !== 0 || b[s + 11] !== 0) throw new Error('This PNG uses a compression or filter method PNG does not define.');
        break;
      case 'PLTE': palette = b.subarray(s, end); break;
      case 'tRNS': trns = b.subarray(s, end); break;
      case 'iCCP': {
        const z = b.subarray(s, Math.min(end, s + 80)).indexOf(0);
        if (z > 0 && b[s + z + 1] === 0) iccCompressed = b.subarray(s + z + 2, end);
        break;
      }
      case 'sRGB': srgb = true; break;
      case 'gAMA': if (len >= 4) gamma = u32be(b, s); break;
      case 'pHYs':
        if (len >= 9 && b[s + 8] === 1) {
          const x = u32be(b, s) * 0.0254, y = u32be(b, s + 4) * 0.0254;
          if (plausible(x) && plausible(y)) dpi = [x, y];
        }
        break;
      case 'eXIf': exif = readExif(b, s, end); metadata = true; break;
      case 'acTL': animated = true; break;
      case 'IDAT':
        if (idat.length && idat[idat.length - 1][1] + 4 !== p) throw new Error('This PNG is damaged: its picture data is not in one run of chunks.');
        idat.push([s, end]);
        break;
      case 'IEND': ended = true; break;
      case 'tEXt': case 'zTXt': case 'iTXt': case 'tIME': metadata = true; break;
    }
    p = end + 4;
    if (ended) break;
  }
  if (!ihdr) throw new Error('This PNG is damaged: it has no header chunk.');
  const { w, h, depth, ct, interlace } = ihdr;
  if (!PNG_DEPTHS[ct]?.includes(depth)) throw new Error(`This PNG is damaged: color type ${ct} cannot have ${depth}-bit samples.`);
  if (interlace > 1) throw new Error('This PNG uses an interlace method PNG does not define.');
  if (!w || !h) throw new Error('This PNG is damaged: it is 0 pixels wide or high.');
  if (ct === 3 && (!palette || palette.length < 3 || palette.length % 3)) throw new Error('This PNG is damaged: its palette is missing.');
  if (whole && !idat.length) throw new Error('This PNG has no picture data.');
  const notes: string[] = [];
  const hasAlpha = ct === 4 || ct === 6;
  const alpha: PictureInfo['alpha'] = hasAlpha ? 'channel' : trns ? (ct === 3 ? 'palette' : 'key') : 'none';
  let path: PicturePath = 'png';
  if (hasAlpha || alpha === 'palette') path = 'png-decode';
  if (interlace) { path = 'png-decode'; notes.push('It is interlaced, which PDF cannot hold, so it was decoded and stored without loss.'); }
  if (gamma && !srgb && !iccCompressed && Math.abs(gamma - 45455) > 2300) notes.push(`Its gamma setting (${(100000 / gamma).toFixed(2)}) is not applied; PDF readers show its colors as stored.`);
  if (animated) notes.push('It is animated; the picture shown where animation is not played is the page.');
  const channels = ct === 2 || ct === 6 ? 3 : 1;
  const rowBytes = Math.ceil((w * PNG_CHANNELS[ct] * depth) / 8);
  const sample = depth === 16 ? 2 : 1;
  const raw = w * h * (channels + (alpha === 'none' || alpha === 'key' ? 0 : 1)) * sample;
  const info: PictureInfo = {
    width: w, height: h, channels, bits: depth, path, alpha, orientation: exif.orientation, dpi,
    icc: iccCompressed ? 'kept' : 'none', animated, metadata, notes, raw, pages: 1,
  };
  return { info, colorType: ct, depth, interlaced: interlace === 1, palette, trns, iccCompressed, idat, rowBytes };
}

// ------------------------------------------------------------------ TIFF pages, for the check on the page

/** The pages of a TIFF (reduced images such as thumbnails left out) and their size, from its directories, read in
 *  pieces: `read(offset, length)` gives that part of the file. */
export async function tiffPages(read: (offset: number, length: number) => Promise<Uint8Array>, size: number): Promise<Array<{ width: number; height: number; bits: number; samples: number }>> {
  const head = await read(0, 8);
  const le = head[0] === 0x49;
  if (!(le ? head[1] === 0x49 : head[0] === 0x4d && head[1] === 0x4d)) throw new Error('This is not a TIFF picture.');
  const r16 = (b: Uint8Array, i: number) => le ? b[i] | (b[i + 1] << 8) : u16be(b, i);
  const r32 = (b: Uint8Array, i: number) => le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : u32be(b, i);
  if (r16(head, 2) !== 42) throw new Error('This TIFF is not one FileConvert reads (BigTIFF or damaged).');
  const pages: Array<{ width: number; height: number; bits: number; samples: number }> = [];
  const seen = new Set<number>();
  for (let at = r32(head, 4), n = 0; at && at + 2 <= size && n < 10_000; n++) {
    if (seen.has(at)) break;
    seen.add(at);
    const count = r16(await read(at, 2), 0);
    const dir = await read(at + 2, count * 12 + 4);
    let width = 0, height = 0, bits = 8, samples = 1, sub = 0, bitsAt = 0;
    for (let k = 0; k < count && k * 12 + 12 <= dir.length; k++) {
      const e = k * 12, tag = r16(dir, e), type = r16(dir, e + 2);
      const value = type === 3 ? r16(dir, e + 8) : r32(dir, e + 8);
      if (tag === 256) width = value;
      else if (tag === 257) height = value;
      else if (tag === 258) { if (r32(dir, e + 4) === 1) bits = value; else bitsAt = r32(dir, e + 8); }
      else if (tag === 277) samples = value;
      else if (tag === 254) sub = value;
    }
    // Bits per sample for several samples is a list elsewhere in the file; its first value stands for all.
    if (bitsAt && bitsAt + 2 <= size) bits = r16(await read(bitsAt, 2), 0);
    if (!(sub & 1)) pages.push({ width, height, bits, samples });
    at = dir.length >= count * 12 + 4 ? r32(dir, count * 12) : 0;
  }
  if (!pages.length) throw new Error('No picture was found in this TIFF file.');
  return pages;
}
