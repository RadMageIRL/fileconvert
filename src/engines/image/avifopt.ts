// Compress AVIF: decoded by libavif at the file's own bit depth (8, 10 or 12 bits; colors as stored) and encoded again by
// libavif and libaom, lossy at a quality or to a file size, or lossless. The file's boxes are read first (ISOBMFF, HEIF):
// its size, bit depth, color (an nclx description or an ICC profile), rotation, mirroring and crop, alpha, and
// metadata. Rotation, mirroring and crop are applied to the pixels, so the result shows the same picture upright with no
// such boxes. The color goes into the new file: libavif writes an nclx box, whose primaries and transfer are set to the
// original's (an HDR picture stays PQ or HLG, Display P3 stays P3), and an ICC profile is added as a box of its own, the
// item offsets corrected for the bytes it adds. EXIF and XMP items are not written into the result, and the result says
// so. Animated AVIF (image sequences) is refused.

import { LimitError } from '../../core/limits';
import { avifDecode, avifEncode } from './codecs';
import { orient, type Picture } from './resample';

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, Math.min(b.length, at + n)));
const be16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const be32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const beN = (b: Uint8Array, p: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };

interface Box { type: string; start: number; end: number; body: number }

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = be32(b, p);
    const type = ascii(b, p + 4, 4);
    let body = p + 8;
    if (size === 1) { if (p + 16 > end) break; size = beN(b, p + 8, 8); body = p + 16; }
    else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) throw new Error('This AVIF file is damaged: a box runs past its end.');
    out.push({ type, start: p, end: p + size, body });
    p += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box, type: string, full = false) => boxes(b, box.body + (full ? 4 : 0), box.end).find(x => x.type === type);

export interface Nclx { primaries: number; transfer: number; matrix: number; full: boolean }

export interface AvifFacts {
  width: number;
  height: number;
  bits: number;
  animated: boolean;
  alpha: boolean;
  nclx: Nclx | null;
  icc: Uint8Array | null;
  /** Transformations in the order they apply: rotation (quarter turns counter-clockwise), mirror (axis), crop. */
  transforms: Array<{ kind: 'irot'; turns: number } | { kind: 'imir'; axis: number } | { kind: 'clap'; x: number; y: number; w: number; h: number }>;
  metadata: string[];
}

interface Meta { meta: Box; primary: number; props: Box[]; assoc: Map<number, number[]>; items: Map<number, string> }

function readMeta(b: Uint8Array): Meta {
  const top = boxes(b, 0, b.length);
  const meta = top.find(x => x.type === 'meta');
  if (!meta) throw new Error('This AVIF file has no picture description (meta box).');
  const kids = boxes(b, meta.body + 4, meta.end);
  const pitm = kids.find(x => x.type === 'pitm');
  const primary = pitm ? (b[pitm.body] === 0 ? be16(b, pitm.body + 4) : be32(b, pitm.body + 4)) : 1;
  const items = new Map<number, string>();
  const iinf = kids.find(x => x.type === 'iinf');
  if (iinf) {
    const v = b[iinf.body];
    for (const e of boxes(b, iinf.body + 4 + (v === 0 ? 2 : 4), iinf.end)) {
      if (e.type !== 'infe') continue;
      const ver = b[e.body];
      if (ver < 2) continue;
      const id = ver === 2 ? be16(b, e.body + 4) : be32(b, e.body + 4);
      const at = e.body + 4 + (ver === 2 ? 2 : 4) + 2;
      let type = ascii(b, at, 4);
      if (type === 'mime') {
        const name = b.indexOf(0, at + 4);
        const ct = ascii(b, name + 1, Math.min(64, e.end - name - 1)).split('\0')[0];
        if (/rdf\+xml/.test(ct)) type = 'XMP';
      }
      items.set(id, type);
    }
  }
  const iprp = kids.find(x => x.type === 'iprp');
  if (!iprp) throw new Error('This AVIF file has no picture properties.');
  const ipco = child(b, iprp, 'ipco');
  const props = ipco ? boxes(b, ipco.body, ipco.end) : [];
  const assoc = new Map<number, number[]>();
  for (const ipma of boxes(b, iprp.body, iprp.end).filter(x => x.type === 'ipma')) {
    const v = b[ipma.body], flags = beN(b, ipma.body + 1, 3);
    let p = ipma.body + 4;
    const n = be32(b, p); p += 4;
    for (let i = 0; i < n; i++) {
      const id = v < 1 ? be16(b, p) : be32(b, p); p += v < 1 ? 2 : 4;
      const k = b[p++];
      const list: number[] = [];
      for (let j = 0; j < k; j++) {
        const idx = flags & 1 ? be16(b, p) & 0x7fff : b[p] & 0x7f;
        p += flags & 1 ? 2 : 1;
        list.push(idx);
      }
      assoc.set(id, list);
    }
  }
  return { meta, primary, props, assoc, items };
}

/** What an AVIF's boxes say. Throws with the reason for a file that is not one or is damaged. */
export function avifFacts(b: Uint8Array): AvifFacts {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') throw new Error('This is not an AVIF file.');
  const top = boxes(b, 0, b.length);
  const ftyp = top[0];
  const brands = [ascii(b, ftyp.body, 4), ...Array.from({ length: (ftyp.end - ftyp.body - 8) / 4 }, (_, i) => ascii(b, ftyp.body + 8 + 4 * i, 4))];
  const animated = brands[0] === 'avis' || top.some(x => x.type === 'moov');
  const m = readMeta(b);
  const f: AvifFacts = { width: 0, height: 0, bits: 8, animated, alpha: false, nclx: null, icc: null, transforms: [], metadata: [] };
  for (const idx of m.assoc.get(m.primary) ?? []) {
    const p = m.props[idx - 1];
    if (!p) continue;
    const s = p.body;
    if (p.type === 'ispe') { f.width = be32(b, s + 4); f.height = be32(b, s + 8); }
    else if (p.type === 'pixi') f.bits = b[s + 5] || 8;
    else if (p.type === 'colr') {
      const kind = ascii(b, s, 4);
      if (kind === 'nclx') f.nclx = { primaries: be16(b, s + 4), transfer: be16(b, s + 6), matrix: be16(b, s + 8), full: (b[s + 10] & 0x80) !== 0 };
      else if (kind === 'prof' || kind === 'rICC') f.icc = b.subarray(s + 4, p.end);
    } else if (p.type === 'irot') f.transforms.push({ kind: 'irot', turns: b[s] & 3 });
    else if (p.type === 'imir') f.transforms.push({ kind: 'imir', axis: b[s] & 1 });
    else if (p.type === 'clap') {
      const v = Array.from({ length: 8 }, (_, i) => be32(b, s + 4 * i) | 0);
      const w = v[0] / (v[1] >>> 0), h = v[2] / (v[3] >>> 0), hx = v[4] / (v[5] >>> 0), vy = v[6] / (v[7] >>> 0);
      f.transforms.push({ kind: 'clap', w, h, x: hx + (f.width - 1) / 2 - (w - 1) / 2, y: vy + (f.height - 1) / 2 - (h - 1) / 2 });
    }
  }
  for (const [id, type] of m.items) {
    if (type === 'Exif') f.metadata.push('EXIF');
    if (type === 'XMP') f.metadata.push('XMP');
    if (id !== m.primary && type === 'av01' && (m.assoc.get(id) ?? []).some(i => m.props[i - 1]?.type === 'auxC' && /alpha/.test(ascii(b, m.props[i - 1].body + 4, 64)))) f.alpha = true;
  }
  if (!f.width || !f.height) throw new Error('This AVIF file does not give its picture size.');
  return f;
}

/** The picture with the file's rotation, mirroring and crop applied, in their order. */
function transform(pic: Picture, t: AvifFacts['transforms']): { pic: Picture; note: string | null } {
  let note: string | null = null;
  for (const x of t) {
    if (x.kind === 'irot' && x.turns) pic = orient(pic, x.turns === 1 ? 8 : x.turns === 2 ? 3 : 6);
    else if (x.kind === 'imir') pic = orient(pic, x.axis === 0 ? 2 : 4);
    else if (x.kind === 'clap') {
      const left = Math.round(x.x), top = Math.round(x.y), w = Math.round(x.w), h = Math.round(x.h);
      if (left < 0 || top < 0 || w < 1 || h < 1 || left + w > pic.width || top + h > pic.height) { note = 'Its crop box (clap) does not fit the picture, so it was not applied.'; continue; }
      const out = new (pic.data.constructor as Uint8ClampedArrayConstructor)(w * h * 4) as Picture['data'];
      for (let y = 0; y < h; y++) out.set(pic.data.subarray(((top + y) * pic.width + left) * 4, ((top + y) * pic.width + left + w) * 4), y * w * 4);
      pic = { data: out, width: w, height: h };
    }
  }
  return { pic, note };
}

// ------------------------------------------------------------------ writing the color into libavif's file

/** Sets the primaries and transfer of the primary item's nclx box in place (libavif's own matrix and range are kept, as
 *  they say how its YUV was made). False when the file has none. */
export function patchNclx(out: Uint8Array, primaries: number, transfer: number): boolean {
  const m = readMeta(out);
  for (const idx of m.assoc.get(m.primary) ?? []) {
    const p = m.props[idx - 1];
    if (p?.type === 'colr' && ascii(out, p.body, 4) === 'nclx') {
      out[p.body + 4] = primaries >> 8; out[p.body + 5] = primaries & 255;
      out[p.body + 6] = transfer >> 8; out[p.body + 7] = transfer & 255;
      return true;
    }
  }
  return false;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Adds an ICC profile (a colr box of type prof) to the primary item of an AVIF libavif made: the property goes at the end
 * of ipco, its association into ipma, and every item offset in iloc moves by the bytes the meta box grows (libavif puts
 * the picture data after it). Null when the file is not laid out as expected, so the caller says the profile was not kept.
 */
export function addIcc(b: Uint8Array, icc: Uint8Array): Uint8Array | null {
  const top = boxes(b, 0, b.length);
  const meta = top.find(x => x.type === 'meta');
  if (!meta || top.findIndex(x => x.type === 'mdat') < top.indexOf(meta)) return null;
  const kids = boxes(b, meta.body + 4, meta.end);
  const iprp = kids.find(x => x.type === 'iprp'), iloc = kids.find(x => x.type === 'iloc');
  if (!iprp || !iloc) return null;
  const ipco = child(b, iprp, 'ipco');
  const ipmas = boxes(b, iprp.body, iprp.end).filter(x => x.type === 'ipma');
  if (!ipco || ipmas.length !== 1) return null;
  const ipma = ipmas[0];
  const m = readMeta(b);
  const index = m.props.length + 1;
  const v = b[ipma.body], flags = beN(b, ipma.body + 1, 3);
  if (!(flags & 1) && index > 127) return null;
  const colr = box('colr', concat([Uint8Array.from([0x70, 0x72, 0x6f, 0x66]), icc])); // 'prof'
  const newIpco = box('ipco', concat([b.subarray(ipco.body, ipco.end), colr]));
  // ipma again, the new property added to the primary item's associations.
  const parts: number[] = [v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255];
  let p = ipma.body + 4;
  const n = be32(b, p); p += 4;
  parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  for (let i = 0; i < n; i++) {
    const idLen = v < 1 ? 2 : 4;
    const id = beN(b, p, idLen);
    for (let k = 0; k < idLen; k++) parts.push(b[p + k]);
    p += idLen;
    const k = b[p++];
    const add = id === m.primary;
    parts.push(k + (add ? 1 : 0));
    const each = flags & 1 ? 2 : 1;
    for (let j = 0; j < k * each; j++) parts.push(b[p + j]);
    p += k * each;
    if (add) { if (flags & 1) parts.push((index >> 8) & 0x7f, index & 255); else parts.push(index & 0x7f); }
  }
  const newIpma = box('ipma', Uint8Array.from(parts));
  const otherIprp = boxes(b, iprp.body, iprp.end).filter(x => x.type !== 'ipco' && x.type !== 'ipma').map(x => b.subarray(x.start, x.end));
  const newIprp = box('iprp', concat([newIpco, newIpma, ...otherIprp]));
  const grow = newIprp.length - (iprp.end - iprp.start);
  // iloc with every offset moved by `grow`.
  const il = b.subarray(iloc.start, iloc.end).slice();
  const s = iloc.body - iloc.start;
  const ver = il[s];
  const offSize = il[s + 4] >> 4, lenSize = il[s + 4] & 15, baseSize = il[s + 5] >> 4, idxSize = ver >= 1 ? il[s + 5] & 15 : 0;
  let q = s + 6;
  const count = ver < 2 ? be16(il, q) : be32(il, q); q += ver < 2 ? 2 : 4;
  const shift = (at: number, size: number) => {
    if (!size) return true;
    const val = beN(il, at, size) + grow;
    if (val >= 2 ** (8 * size)) return false;
    let x = val;
    for (let i = size - 1; i >= 0; i--) { il[at + i] = x % 256; x = Math.floor(x / 256); }
    return true;
  };
  for (let i = 0; i < count; i++) {
    q += ver < 2 ? 2 : 4;
    let method = 0;
    if (ver >= 1) { method = be16(il, q) & 15; q += 2; }
    q += 2; // data reference index
    const baseAt = q; q += baseSize;
    const extents = be16(il, q); q += 2;
    if (method === 0 && baseSize && !shift(baseAt, baseSize)) return null;
    for (let e = 0; e < extents; e++) {
      q += idxSize;
      if (method === 0 && !baseSize && !shift(q, offSize)) return null;
      q += offSize + lenSize;
    }
  }
  const newKids = kids.map(k => (k === iprp ? newIprp : k === iloc ? il : b.subarray(k.start, k.end)));
  const metaHead = b.subarray(meta.start + 8, meta.body + 4); // version and flags
  const newMeta = box('meta', concat([metaHead, ...newKids]));
  return concat(top.map(t => (t === meta ? newMeta : b.subarray(t.start, t.end))));
}

// ------------------------------------------------------------------ Compress AVIF

export interface AvifOptions {
  mode: 'lossy' | 'lossless' | 'target';
  quality: number;
  targetBytes?: number;
  removeMetadata: boolean;
  measure: boolean;
}

export interface AvifResult {
  bytes: Uint8Array;
  original: boolean;
  width: number;
  height: number;
  lossless: boolean;
  bits: number;
  quality?: number;
  changes: string[];
  removed: string[];
  kept: string[];
  notes: string[];
  pixels?: { before: Uint8ClampedArray | Uint16Array; after: Uint8ClampedArray | Uint16Array; width: number; height: number };
}

export const AVIF_TARGET_QUALITY = { min: 10, max: 90 } as const;
/** Pictures larger than this are compressed at a quality, not searched for a size: each try is a full AVIF encode. */
export const AVIF_TARGET_PIXELS = 16_000_000;

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

export async function compressAvif(b: Uint8Array, o: AvifOptions, progress: (s: string) => void): Promise<AvifResult> {
  const f = avifFacts(b);
  if (f.animated) throw new LimitError('This AVIF is an animation (an image sequence). Compressing animated AVIF is not supported here, so it was not changed.');
  if (f.bits > 12) throw new LimitError(`This AVIF has ${f.bits} bits per channel; this tool reads up to 12.`);
  if (o.mode === 'target' && f.width * f.height > AVIF_TARGET_PIXELS) throw new LimitError(`This AVIF is ${(f.width * f.height / 1e6).toFixed(1)} megapixels; to a file size works up to ${AVIF_TARGET_PIXELS / 1e6} megapixels, since each try is a full AVIF encode. Choose a quality instead.`);
  progress('Decoding');
  const raw = await avifDecode(b, f.bits);
  const t = transform({ data: raw.data, width: raw.width, height: raw.height }, f.transforms);
  const pic = t.pic;
  const notes: string[] = t.note ? [t.note] : [];
  const changes: string[] = [];
  if (f.transforms.some(x => (x.kind === 'irot' && x.turns) || x.kind === 'imir')) changes.push('Turned or mirrored as the file says, in the pixels themselves; the result has no rotation or mirroring box.');
  if (f.transforms.some(x => x.kind === 'clap') && !t.note) changes.push(`Cropped as the file says (its clean aperture), to ${pic.width} x ${pic.height}.`);
  const bitDepth = (f.bits === 10 || f.bits === 12 ? f.bits : 8) as 8 | 10 | 12;
  const lossless = o.mode === 'lossless';
  const removed: string[] = [], kept: string[] = [];
  if (f.metadata.length) (o.removeMetadata ? removed : notes).push(o.removeMetadata ? `${f.metadata.join(' and ')} (inside the AVIF)` : `Its ${f.metadata.join(' and ')} metadata is not written into the result (this tool does not carry AVIF metadata).`);
  const make = async (q: number) => {
    let out = await avifEncode(pic.data, pic.width, pic.height, { quality: q, lossless, bitDepth, subsample: 1, speed: 6 });
    if (f.nclx && (f.nclx.primaries !== 1 || f.nclx.transfer !== 13) && f.nclx.primaries !== 2) {
      if (!patchNclx(out, f.nclx.primaries, f.nclx.transfer)) notes.push('Its color description (nclx) could not be written into the result.');
    }
    if (f.icc) {
      const withIcc = addIcc(out, f.icc);
      if (withIcc) out = withIcc;
      else notes.push('Its color profile could not be written into the result.');
    }
    return out;
  };
  if (f.icc) kept.push('Color profile (ICC), so colors look the same');
  if (f.nclx && f.nclx.primaries !== 2) kept.push(`Color description (primaries ${f.nclx.primaries}, transfer ${f.nclx.transfer})`);
  let out: Uint8Array, quality: number | undefined;
  if (o.mode === 'target' && o.targetBytes) {
    const target = o.targetBytes;
    if (b.length <= target && !t.note && f.transforms.length === 0) return { bytes: b, original: true, width: f.width, height: f.height, lossless: false, bits: f.bits, changes: [], removed: [], kept, notes: [`It is already ${fmtSize(b.length)}, within the ${fmtSize(target)} asked for, so it was not recompressed.`] };
    let lo: number = AVIF_TARGET_QUALITY.min, hi: number = AVIF_TARGET_QUALITY.max, best: { q: number; out: Uint8Array } | null = null, tries = 0;
    while (lo <= hi && tries < 6) {
      const mid = Math.round((lo + hi) / 2);
      progress(`Trying quality ${mid}`);
      const x = await make(mid);
      tries++;
      if (x.length <= target) { best = { q: mid, out: x }; lo = mid + 1; } else hi = mid - 1;
    }
    if (!best) {
      const x = await make(AVIF_TARGET_QUALITY.min);
      if (x.length > target) throw new LimitError(`At quality ${AVIF_TARGET_QUALITY.min}, the lowest this tool uses, the file is still ${fmtSize(x.length)}, more than the ${fmtSize(target)} asked for. Make the picture smaller (Resize images) to get there.`);
      best = { q: AVIF_TARGET_QUALITY.min, out: x };
    }
    out = best.out; quality = best.q;
  } else {
    quality = lossless ? undefined : Math.max(1, Math.min(100, Math.round(o.quality)));
    progress(lossless ? 'Encoding without loss' : `Encoding at quality ${quality}`);
    out = await make(quality ?? 100);
  }
  if (lossless) {
    progress('Checking every pixel');
    const back = await avifDecode(out, f.bits);
    if (back.width !== pic.width || back.height !== pic.height || !same(back.data, pic.data)) {
      throw new LimitError('Lossless AVIF did not keep every pixel of this picture exactly (AVIF stores colors as YUV), so it was not used. Choose a quality instead.');
    }
  }
  if (out.length >= b.length && f.transforms.length === 0) {
    return { bytes: b, original: true, width: f.width, height: f.height, lossless: false, bits: f.bits, changes: [], removed: [], kept, notes: [lossless ? 'Without loss, the file would not be smaller, so it was kept as it was.' : `At quality ${quality} the file would not be smaller, so it was kept as it was.`] };
  }
  let pixels: AvifResult['pixels'];
  if (o.measure && !lossless) {
    progress('Measuring the similarity');
    pixels = { before: pic.data, after: (await avifDecode(out, f.bits)).data, width: pic.width, height: pic.height };
  }
  return { bytes: out, original: false, width: pic.width, height: pic.height, lossless, bits: f.bits, quality, changes, removed, kept, notes, pixels };
}

function same(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
