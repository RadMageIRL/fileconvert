// Text decoding for text-based inputs. A byte order mark wins; otherwise strict UTF-8 is tried, then
// UTF-16 without a BOM, and finally Windows-1252, which can decode any byte sequence. The result says
// which encoding was used so the interface can tell the user when it had to guess.

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
  bom: boolean;
  /** Set when the encoding was a guess. */
  warning?: string;
}

export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', bom: true };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', bom: true };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', bom: true };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom: false };
  } catch { /* not UTF-8 */ }
  const n = Math.min(bytes.length, 8192);
  let even = 0, odd = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) (i % 2 ? odd++ : even++);
  if (odd > n * 0.3 && even < n * 0.02) {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le', bom: false, warning: 'No byte order mark: read as UTF-16 (little-endian).' };
  }
  if (even > n * 0.3 && odd < n * 0.02) {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be', bom: false, warning: 'No byte order mark: read as UTF-16 (big-endian).' };
  }
  return {
    text: new TextDecoder('windows-1252').decode(bytes),
    encoding: 'windows-1252',
    bom: false,
    warning: 'The file is not valid UTF-8, so it was read as Windows-1252 (Western European). Check accented letters in the result.',
  };
}

/** Normalizes line endings to \n and removes a leading BOM character. */
export function normalizeNewlines(text: string): string {
  return text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
}

export function utf8(text: string, bom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
