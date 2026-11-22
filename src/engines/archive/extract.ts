// Archive extraction: ZIP, TAR, GZ, and TAR inside GZ (.tar.gz, .tgz). This unpacks files so they can be downloaded
// or converted; it never converts one archive format into another. Every archive is treated as hostile:
//
// - Limits apply to the bytes actually unpacked, never to what the archive claims: a file that unpacks to more than
//   its listed size is stopped, a file that expands more than a set ratio is stopped as a decompression bomb, and the
//   total, the number of files and the size of the directory are capped.
// - Compressed data is fed in small pieces, so one piece cannot expand into gigabytes before a limit is checked.
// - Paths are only shown, never used: "..", absolute paths and drive letters are dropped, and each download gets a
//   safe, unique name. Links, devices, encrypted entries and unknown compression methods are listed, not unpacked.
// - Nested archives are unpacked as plain files; opening one is a separate, explicit step.
// - ZIP and gzip checksums are verified; a mismatch marks the file damaged.

import { Gunzip, Inflate } from 'fflate';
import { crc32 } from '../../core/crc32';
import { LimitError } from '../../core/limits';
import { NameRegistry, safeBase } from '../../core/naming';
import { cstr, isTarHeader, octal } from './tarheader';

export { isTarHeader };

export type ArchiveKind = 'zip' | 'tar' | 'gz';

export interface ArchiveLimits {
  /** Files that may be unpacked. */
  entries: number;
  /** Bytes that may be unpacked in all. */
  totalBytes: number;
  /** Largest expansion of one file (unpacked size over packed size) once it is past ratioFloor bytes. */
  ratio: number;
  ratioFloor: number;
}

export interface EntryWriter {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<Blob>;
  abort(): Promise<void>;
}

/** Where unpacked files go: a temporary private file, or memory. */
export type Sink = () => Promise<EntryWriter>;

export interface Extracted {
  /** The file's path inside the archive, made safe to show. */
  path: string;
  /** A safe download name, unique within this archive. */
  name: string;
  size: number;
  file: Blob;
}

export interface Skipped { path: string; reason: string }

export interface ExtractResult { entries: Extracted[]; skipped: Skipped[]; warnings: string[] }

type Progress = (fraction: number) => void;

const STEP = 64 * 1024;

// ------------------------------------------------------------------ names

/** A path to show: separators unified, "..", ".", empty parts and drive letters dropped, control characters replaced. */
export function safePath(raw: string): { path: string; unsafe: boolean } {
  const s = raw.replace(/\\/g, '/');
  const unsafe = /^\//.test(s) || /^[a-zA-Z]:/.test(s) || /(^|\/)\.\.(\/|$)/.test(s);
  const parts = s.split('/')
    .filter(p => p && p !== '.' && p !== '..' && !/^[a-zA-Z]:$/.test(p))
    .map(p => p.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '_').slice(0, 255));
  return { path: parts.join('/') || 'unnamed', unsafe };
}

/** A unique, safe download name for a path, keeping its extension (or having none, like README). */
function downloadName(names: NameRegistry, path: string): string {
  const last = path.split('/').pop() || 'unnamed';
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot + 1).replace(/[^a-z0-9]/gi, '').slice(0, 16) : '';
  return names.claim(safeBase(last), ext);
}

// ------------------------------------------------------------------ the budget all extraction shares

class Budget {
  total = 0;
  count = 0;
  constructor(readonly limits: ArchiveLimits) {}

  file(): void {
    if (++this.count > this.limits.entries) throw new LimitError(`The archive holds more than ${this.limits.entries.toLocaleString('en-US')} files, the limit.`);
  }

  /** Counts unpacked bytes; throws when the total limit is passed. */
  add(n: number): void {
    this.total += n;
    if (this.total > this.limits.totalBytes) throw new LimitError(`The files would add up to more than ${Math.round(this.limits.totalBytes / 1048576).toLocaleString('en-US')} MB, the limit for one archive here.`);
  }

  /** True when a file expands more than the limit allows: a decompression bomb. */
  bomb(out: number, packed: number): boolean {
    return out > this.limits.ratioFloor && out > Math.max(1, packed) * this.limits.ratio;
  }
}

/** Raised for one file that cannot be unpacked; the others go on. */
class EntryError extends Error {}

// ------------------------------------------------------------------ ZIP

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  packed: number;
  size: number;
  offset: number;
  mode: number;
  unix: boolean;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

async function slice(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  try { return new TextDecoder('utf-8', { fatal: !utf8 }).decode(bytes); } catch { return String.fromCharCode(...bytes); }
}

async function zipDirectory(file: Blob, budget: Budget): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, file.size - (65535 + 22 + 20));
  const tail = await slice(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This ZIP file is damaged or cut short: its directory at the end is missing.');
  let count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error('This ZIP file is damaged: its ZIP64 directory locator is missing.');
    const z64 = u64(tail, loc + 8);
    const rec = await slice(file, z64, z64 + 56);
    if (rec.length < 56 || u32(rec, 0) !== 0x06064b50) throw new Error('This ZIP file is damaged: its ZIP64 directory is missing.');
    count = u64(rec, 32); cdSize = u64(rec, 40); cdOffset = u64(rec, 48);
  }
  if (count > budget.limits.entries) throw new LimitError(`The archive lists ${count.toLocaleString('en-US')} files; the limit is ${budget.limits.entries.toLocaleString('en-US')}.`);
  if (cdSize > 64 * 1048576) throw new LimitError('The archive directory is too large.');
  if (cdOffset + cdSize > file.size) throw new Error('This ZIP file is damaged or cut short: its directory points past the end of the file.');
  const cd = await slice(file, cdOffset, cdOffset + cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new Error('This ZIP file is damaged: its directory is broken.');
    const flags = u16(cd, p + 8), method = u16(cd, p + 10), crc = u32(cd, p + 16);
    let packed = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const unix = (cd[p + 5] === 3);
    const mode = unix ? (u32(cd, p + 38) >>> 16) : 0;
    let offset = u32(cd, p + 42);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (packed === 0xffffffff) { packed = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    out.push({ name, flags, method, crc, packed, size, offset, mode, unix });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const METHODS: Record<number, string> = { 12: 'bzip2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 98: 'PPMd', 9: 'Deflate64', 6: 'Implode' };

async function zipEntry(file: Blob, e: ZipEntry, writer: EntryWriter, budget: Budget, progress: (n: number) => void): Promise<number> {
  const local = await slice(file, e.offset, e.offset + 30);
  if (local.length < 30 || u32(local, 0) !== 0x04034b50) throw new EntryError('damaged: its data is not where the directory says');
  const start = e.offset + 30 + u16(local, 26) + u16(local, 28);
  if (start + e.packed > file.size) throw new EntryError('cut short: its data runs past the end of the archive');
  let out = 0, packedRead = 0, crc = 0, error: string | null = null;
  const pending: Uint8Array[] = [];
  const take = (chunk: Uint8Array) => {
    if (error) return;
    out += chunk.length;
    if (out > e.size) { error = 'unpacks to more than its listed size, a sign of a decompression bomb; stopped'; return; }
    if (budget.bomb(out, packedRead)) { error = `expands more than ${budget.limits.ratio} times, a decompression bomb; stopped`; return; }
    crc = crc32(chunk, crc);
    pending.push(chunk.slice());
  };
  const inflate = e.method === 8 ? new Inflate(chunk => take(chunk)) : null;
  for (let at = start; at < start + e.packed && !error;) {
    const piece = await slice(file, at, Math.min(start + e.packed, at + 1048576));
    for (let i = 0; i < piece.length && !error; i += STEP) {
      const part = piece.subarray(i, Math.min(piece.length, i + STEP));
      packedRead += part.length;
      const last = at + i + part.length >= start + e.packed;
      try {
        if (inflate) inflate.push(part, last); else take(part.slice());
      } catch {
        error = 'damaged: its compressed data is broken';
      }
      while (pending.length && !error) {
        const c = pending.shift()!;
        budget.add(c.length);
        await writer.write(c);
      }
    }
    at += piece.length;
    progress(piece.length);
  }
  if (error) throw new EntryError(error);
  if (out !== e.size) throw new EntryError('damaged: it unpacks to less than its listed size');
  if (crc !== e.crc) throw new EntryError('damaged: its checksum does not match');
  return out;
}

async function extractZip(file: Blob, sink: Sink, budget: Budget, progress: Progress): Promise<ExtractResult> {
  const result: ExtractResult = { entries: [], skipped: [], warnings: [] };
  const names = new NameRegistry();
  const entries = await zipDirectory(file, budget);
  let unsafe = 0, done = 0;
  const total = entries.reduce((n, e) => n + e.packed, 0) || 1;
  for (const e of entries) {
    const { path, unsafe: bad } = safePath(e.name);
    if (bad) unsafe++;
    const type = e.mode & 0o170000;
    if (e.name.endsWith('/') || (e.unix && type === 0o040000)) continue;
    if (e.unix && type === 0o120000) { result.skipped.push({ path, reason: 'a link to another file; links are not unpacked' }); continue; }
    if (e.unix && type && type !== 0o100000) { result.skipped.push({ path, reason: 'a special file (device, pipe or socket); not unpacked' }); continue; }
    if (e.flags & 1 || e.method === 99) { result.skipped.push({ path, reason: 'encrypted; FileConvert cannot open password-protected archives' }); continue; }
    if (e.method !== 0 && e.method !== 8) { result.skipped.push({ path, reason: `compressed with ${METHODS[e.method] ?? `method ${e.method}`}, which FileConvert cannot unpack` }); continue; }
    budget.file();
    const writer = await sink();
    try {
      const size = await zipEntry(file, e, writer, budget, n => { done += n; progress(done / total); });
      result.entries.push({ path, name: downloadName(names, path), size, file: await writer.finish() });
    } catch (err) {
      await writer.abort();
      if (err instanceof EntryError) result.skipped.push({ path, reason: err.message });
      else throw err;
    }
  }
  if (unsafe) result.warnings.push(`${unsafe} ${unsafe === 1 ? 'path' : 'paths'} pointed outside the archive (with .., a leading / or a drive letter); ${unsafe === 1 ? 'it is' : 'they are'} shown without those parts. Nothing is ever written outside your downloads.`);
  if (!result.entries.length && entries.length && result.skipped.length && result.skipped.every(s => s.reason.startsWith('encrypted'))) {
    throw new Error('This ZIP file is password-protected. FileConvert cannot open encrypted archives.');
  }
  return result;
}

// ------------------------------------------------------------------ byte streams for TAR and GZ

/** Pulls bytes on demand from a source of chunks, with exact-length reads, skips and a peek. */
class Reader {
  private buf: Uint8Array = new Uint8Array(0);
  private done = false;
  constructor(private next: () => Promise<Uint8Array | null>) {}

  private async fill(n: number): Promise<void> {
    while (this.buf.length < n && !this.done) {
      const c = await this.next();
      if (!c) { this.done = true; break; }
      const merged = new Uint8Array(this.buf.length + c.length);
      merged.set(this.buf);
      merged.set(c, this.buf.length);
      this.buf = merged;
    }
  }

  async peek(n: number): Promise<Uint8Array> { await this.fill(n); return this.buf.subarray(0, n); }

  async read(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(Math.min(n, this.buf.length));
    return out;
  }

  /** Streams n bytes to a callback in pieces, without holding them all. Returns the bytes actually passed. */
  async pipe(n: number, onChunk: (c: Uint8Array) => Promise<void>): Promise<number> {
    let left = n;
    while (left > 0) {
      if (!this.buf.length) await this.fill(1);
      if (!this.buf.length) break;
      const take = Math.min(left, this.buf.length, STEP * 4);
      const c = this.buf.slice(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      await onChunk(c);
    }
    return n - left;
  }
}

/** Chunks of a Blob, read in order. */
function blobChunks(file: Blob, onRead: (n: number) => void): () => Promise<Uint8Array | null> {
  let at = 0;
  return async () => {
    if (at >= file.size) return null;
    const c = await slice(file, at, Math.min(file.size, at + 1048576));
    at += c.length;
    onRead(c.length);
    return c;
  };
}

/** Decompressed chunks of a gzip Blob, fed in small pieces; stopped as a bomb past the expansion limit. */
function gunzipChunks(file: Blob, budget: Budget, onRead: (n: number) => void): { next: () => Promise<Uint8Array | null>; check(): void } {
  let at = 0, packed = 0, out = 0, error: string | null = null;
  const pending: Uint8Array[] = [];
  const gz = new Gunzip(chunk => {
    out += chunk.length;
    if (budget.bomb(out, packed)) error = `expands more than ${budget.limits.ratio} times, a decompression bomb, so it was stopped`;
    pending.push(chunk.slice());
  });
  return {
    async next() {
      while (!pending.length) {
        if (error) throw new LimitError(`This file ${error}.`);
        if (at >= file.size) return null;
        const piece = await slice(file, at, Math.min(file.size, at + STEP));
        at += piece.length;
        packed += piece.length;
        onRead(piece.length);
        try { gz.push(piece, at >= file.size); } catch { throw new Error('This gzip file is damaged: its compressed data is broken.'); }
      }
      if (error) throw new LimitError(`This file ${error}.`);
      return pending.shift()!;
    },
    check() { if (error) throw new LimitError(`This file ${error}.`); },
  };
}

// ------------------------------------------------------------------ TAR

async function extractTar(reader: Reader, sink: Sink, budget: Budget, result: ExtractResult, check: () => void = () => undefined): Promise<void> {
  const names = new NameRegistry();
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  let unsafe = 0;
  for (;;) {
    check();
    const h = await reader.read(512);
    if (h.length === 0) break;
    if (h.length < 512) throw new Error('This TAR archive is cut short.');
    if (h.every(v => v === 0)) break;
    if (!isTarHeader(h)) throw new Error('This TAR archive is damaged: a header checksum does not match.');
    const ustar = cstr(h, 257, 6).startsWith('ustar');
    let name = cstr(h, 0, 100);
    if (ustar && h[345]) name = `${cstr(h, 345, 155)}/${name}`;
    if (longName) name = longName;
    if (pax.path) name = pax.path;
    const size = pax.size !== undefined ? (/^\d{1,16}$/.test(pax.size) ? Number(pax.size) : NaN) : octal(h, 124, 12);
    // A size that is not a whole number (garbage text, a sign, an exponent) would make every later check meaningless.
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('This TAR archive is damaged: a file size is not valid.');
    const type = String.fromCharCode(h[156] || 0x30);
    longName = null;
    pax = {};
    const padded = Math.ceil(size / 512) * 512;
    const skipData = async () => { if (await reader.pipe(padded, async () => undefined) < padded) throw new Error('This TAR archive is cut short.'); };
    if (type === 'x' || type === 'L') {
      if (size > 1048576) throw new Error('This TAR archive is damaged: an extended header is too large.');
      const data = await reader.read(padded);
      if (data.length < padded) throw new Error('This TAR archive is cut short.');
      if (type === 'L') longName = cstr(data, 0, size);
      else {
        // PAX records: "length key=value\n".
        const text = new TextDecoder().decode(data.subarray(0, size));
        for (const m of text.matchAll(/(\d+) ([^=\n]+)=([^\n]*)\n/g)) pax[m[2]] = m[3];
      }
      continue;
    }
    const { path, unsafe: bad } = safePath(name);
    if (bad) unsafe++;
    if (type === 'g' || type === 'K' || type === '5') { await skipData(); continue; }
    if (type === '1' || type === '2') { result.skipped.push({ path, reason: 'a link to another file; links are not unpacked' }); await skipData(); continue; }
    if (type === '3' || type === '4' || type === '6') { result.skipped.push({ path, reason: 'a special file (device or pipe); not unpacked' }); await skipData(); continue; }
    if (type === 'S') { result.skipped.push({ path, reason: 'a sparse file, which FileConvert cannot unpack' }); await skipData(); continue; }
    if (type !== '0' && type !== '7') { result.skipped.push({ path, reason: `an entry of type "${type}", which FileConvert does not unpack` }); await skipData(); continue; }
    budget.file();
    const writer = await sink();
    let written = 0;
    try {
      written = await reader.pipe(size, async c => { budget.add(c.length); check(); await writer.write(c); });
      if (written < size) throw new Error('This TAR archive is cut short.');
      if (await reader.pipe(padded - size, async () => undefined) < padded - size) throw new Error('This TAR archive is cut short.');
      result.entries.push({ path, name: downloadName(names, path), size, file: await writer.finish() });
    } catch (err) {
      await writer.abort();
      throw err;
    }
  }
  if (unsafe) result.warnings.push(`${unsafe} ${unsafe === 1 ? 'path' : 'paths'} pointed outside the archive (with .., a leading / or a drive letter); ${unsafe === 1 ? 'it is' : 'they are'} shown without those parts. Nothing is ever written outside your downloads.`);
}

// ------------------------------------------------------------------ GZ

/** The name stored in a gzip header (FNAME), if any. */
export function gzipName(head: Uint8Array): string | null {
  if (head[0] !== 0x1f || head[1] !== 0x8b) return null;
  const flags = head[3];
  let p = 10;
  if (flags & 4) p += 2 + u16(head, 10);
  if (!(flags & 8)) return null;
  let end = p;
  while (end < head.length && head[end]) end++;
  return end < head.length ? new TextDecoder('latin1').decode(head.subarray(p, end)) : null;
}

async function extractGz(file: Blob, archiveName: string, sink: Sink, budget: Budget, progress: Progress): Promise<ExtractResult> {
  const result: ExtractResult = { entries: [], skipped: [], warnings: [] };
  let read = 0;
  const src = gunzipChunks(file, budget, n => { read += n; progress(read / file.size); });
  const reader = new Reader(src.next);
  const first = await reader.peek(512);
  const stored = gzipName(await slice(file, 0, 1024));
  const inner = stored ?? archiveName.replace(/\.(tgz)$/i, '.tar').replace(/\.gz$/i, '').replace(/\.z$/i, '');
  if (isTarHeader(first) || /\.tar$/i.test(inner)) {
    await extractTar(reader, sink, budget, result, src.check);
    return result;
  }
  budget.file();
  const writer = await sink();
  try {
    let crc = 0;
    const size = await reader.pipe(Number.MAX_SAFE_INTEGER, async c => { budget.add(c.length); crc = crc32(c, crc); await writer.write(c); });
    // A single-member gzip file ends with the CRC-32 and the size of what it holds.
    const tail = await slice(file, file.size - 8, file.size);
    if (tail.length === 8 && u32(tail, 4) === (size >>> 0) && u32(tail, 0) !== crc) throw new Error('This gzip file is damaged: its checksum does not match.');
    const { path } = safePath(inner || 'unpacked');
    result.entries.push({ path, name: downloadName(new NameRegistry(), path), size, file: await writer.finish() });
  } catch (err) {
    await writer.abort();
    throw err;
  }
  return result;
}

// ------------------------------------------------------------------ entry point

export async function extractArchive(file: Blob, kind: ArchiveKind, archiveName: string, sink: Sink, limits: ArchiveLimits, progress: Progress = () => undefined): Promise<ExtractResult> {
  const budget = new Budget(limits);
  if (kind === 'zip') return extractZip(file, sink, budget, progress);
  if (kind === 'gz') return extractGz(file, archiveName, sink, budget, progress);
  const result: ExtractResult = { entries: [], skipped: [], warnings: [] };
  let read = 0;
  await extractTar(new Reader(blobChunks(file, n => { read += n; progress(read / file.size); })), sink, budget, result);
  return result;
}
