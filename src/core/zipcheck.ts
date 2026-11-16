// Pre-flight check for ZIP-based inputs (DOCX, XLSX). Before a library unpacks a package into memory, this
// reads the central directory and then inflates every part as a stream, counting bytes and discarding them,
// so a decompression bomb is refused whether or not its directory lies about the sizes.

import { Inflate } from 'fflate';
import { LIMITS, LimitError } from './limits';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  encrypted: boolean;
}

function findEocd(dv: DataView): number {
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) throw new Error('The file is not a valid ZIP package (no end of central directory).');
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('The ZIP64 directory locator is missing.');
    const z64 = Number(dv.getBigUint64(loc + 8, true));
    if (z64 + 56 > bytes.length || dv.getUint32(z64, true) !== 0x06064b50) throw new Error('The ZIP64 directory is damaged.');
    count = Number(dv.getBigUint64(z64 + 32, true));
    cdSize = Number(dv.getBigUint64(z64 + 40, true));
    cdOffset = Number(dv.getBigUint64(z64 + 48, true));
  }
  if (count > LIMITS.zipEntries) throw new LimitError(`The package has ${count} parts; the limit is ${LIMITS.zipEntries}.`);
  if (cdOffset + cdSize > bytes.length) throw new Error('The ZIP directory points past the end of the file.');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP directory is damaged.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: the 64-bit values appear only for the fields that are saturated.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(dv.getBigUint64(q, true)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(dv.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, offset, encrypted: (flags & 1) === 1 });
    p = end + commentLen;
  }
  return entries;
}

/**
 * Throws unless the package is safe to unpack: no encryption, only stored or deflated parts, and the parts
 * really inflate to no more than the limits allow. Returns the entries.
 */
export function checkZip(bytes: Uint8Array, kind: string, maxInflated: number = LIMITS.zipInflatedBytes): ZipEntry[] {
  const entries = readCentralDirectory(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let declared = 0;
  for (const en of entries) {
    if (en.encrypted) throw new Error(`This ${kind} is password protected. Remove the password and try again.`);
    if (en.method !== 0 && en.method !== 8) throw new Error(`This ${kind} uses an unsupported compression method (${en.method}).`);
    declared += en.size;
  }
  if (declared > maxInflated) throw new LimitError(`This ${kind} would unpack to ${Math.round(declared / 1048576)} MB; the limit is ${Math.round(maxInflated / 1048576)} MB.`);
  let actual = 0;
  for (const en of entries) {
    const lp = en.offset;
    if (lp + 30 > bytes.length || dv.getUint32(lp, true) !== 0x04034b50) throw new Error(`The ${kind} is damaged (part ${en.name}).`);
    const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
    if (start + en.compressedSize > bytes.length) throw new Error(`The ${kind} is truncated (part ${en.name}).`);
    if (en.method === 0) {
      actual += en.compressedSize;
    } else {
      let out = 0;
      let over = false;
      const inf = new Inflate((chunk) => {
        out += chunk.length;
        if (out > en.size + 1024 || actual + out > maxInflated) over = true;
      });
      const src = bytes.subarray(start, start + en.compressedSize);
      const STEP = 1 << 12;
      for (let i = 0; i < src.length && !over; i += STEP) inf.push(src.subarray(i, Math.min(src.length, i + STEP)), i + STEP >= src.length);
      if (over) {
        throw new LimitError(`This ${kind} unpacks to more than its directory says or more than ${Math.round(maxInflated / 1048576)} MB (part ${en.name}). It looks like a decompression bomb, so it was not opened.`);
      }
      actual += out;
    }
    if (en.compressedSize > 0 && actual / Math.max(1, bytes.length) > LIMITS.zipRatio) {
      throw new LimitError(`This ${kind} expands more than ${LIMITS.zipRatio} times. It looks like a decompression bomb, so it was not opened.`);
    }
  }
  return entries;
}
