// TAR header reading, apart from the extractor so that file detection can use it without loading fflate.

export const cstr = (b: Uint8Array, at: number, len: number) => {
  let end = at;
  while (end < at + len && b[end]) end++;
  return new TextDecoder().decode(b.subarray(at, end));
};

/** A numeric header field: octal text, or base-256 for large values (GNU). */
export function octal(b: Uint8Array, at: number, len: number): number {
  if (b[at] & 0x80) {
    let n = b[at] & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[at + i];
    return n;
  }
  const s = cstr(b, at, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** True when 512 bytes are a TAR header with a correct checksum (the checksum field counted as spaces). */
export function isTarHeader(h: Uint8Array): boolean {
  if (h.length < 512) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === octal(h, 148, 8) && sum !== 32 * 8;
}
