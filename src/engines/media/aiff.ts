// AIFF and AIFF-C input. Mediabunny reads WAV but not AIFF, and both hold the same kinds of samples, so an AIFF file
// is presented to it as a WAV file: a 44-byte WAV header followed by the AIFF sample data, converted on the fly as it
// is read (big-endian samples byte-swapped, signed 8-bit samples offset). Nothing is copied ahead of time, so even
// very large files never need a second copy. Compressed AIFF-C codecs (IMA ADPCM, MACE and others) are reported.

export interface AiffInfo {
  channels: number;
  sampleRate: number;
  /** Bits per sample as stored. */
  bits: number;
  /** How the samples are stored, and what the WAV view gives Mediabunny. */
  kind: 'pcm-be' | 'pcm-le' | 'float-be' | 'ulaw' | 'alaw';
  /** Where the samples start in the file, and how many bytes they take. */
  dataOffset: number;
  dataLength: number;
}

const COMPRESSED: Record<string, string> = {
  ima4: 'IMA ADPCM', MAC3: 'MACE 3:1', MAC6: 'MACE 6:1', Qclp: 'QCELP', GSM: 'GSM', 'GSM ': 'GSM', sdx2: 'SDX2', QDMC: 'QDesign', QDM2: 'QDesign 2',
};

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** The 80-bit IEEE extended float AIFF uses for the sample rate. */
export function extended80(b: Uint8Array, at: number): number {
  const exp = ((b[at] & 0x7f) << 8) | b[at + 1];
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[at + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  return (b[at] & 0x80 ? -1 : 1) * mant * Math.pow(2, exp - 16383 - 63);
}

/** Reads an AIFF or AIFF-C file's layout, walking its chunks without reading the samples. */
export async function readAiff(file: Blob): Promise<AiffInfo> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (tag(head, 0) !== 'FORM' || (tag(head, 8) !== 'AIFF' && tag(head, 8) !== 'AIFC')) throw new Error('This is not an AIFF file.');
  const aifc = tag(head, 8) === 'AIFC';
  let comm: Uint8Array | null = null;
  let ssnd: { at: number; size: number } | null = null;
  let p = 12;
  for (let n = 0; p + 8 <= file.size && n < 10000 && !(comm && ssnd); n++) {
    const h = new Uint8Array(await file.slice(p, p + 8).arrayBuffer());
    const id = tag(h, 0);
    const size = ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0;
    if (id === 'COMM') comm = new Uint8Array(await file.slice(p + 8, p + 8 + Math.min(size, 256)).arrayBuffer());
    if (id === 'SSND') ssnd = { at: p + 8, size };
    p += 8 + size + (size & 1);
  }
  if (!comm || comm.length < 18) throw new Error('This AIFF file has no format description (COMM chunk). It may be damaged.');
  if (!ssnd) throw new Error('This AIFF file has no sound data (SSND chunk). It may be damaged or cut short.');
  const dv = new DataView(comm.buffer, comm.byteOffset, comm.byteLength);
  const channels = dv.getUint16(0);
  const frames = dv.getUint32(2);
  const bits = dv.getUint16(6);
  const sampleRate = Math.round(extended80(comm, 8));
  let kind: AiffInfo['kind'] = 'pcm-be';
  if (aifc && comm.length >= 22) {
    const c = tag(comm, 18);
    const known: Record<string, AiffInfo['kind']> = { NONE: 'pcm-be', twos: 'pcm-be', in24: 'pcm-be', in32: 'pcm-be', sowt: 'pcm-le', fl32: 'float-be', FL32: 'float-be', fl64: 'float-be', FL64: 'float-be', ulaw: 'ulaw', ULAW: 'ulaw', alaw: 'alaw', ALAW: 'alaw' };
    if (!(c in known)) throw new Error(`This AIFF-C file is compressed with ${COMPRESSED[c] ?? `"${c.trim()}"`}, which FileConvert cannot decode. Uncompressed AIFF and AIFF-C, and mu-law and A-law, are supported.`);
    kind = known[c];
  }
  const width = kind === 'ulaw' || kind === 'alaw' ? 8 : kind === 'float-be' ? (bits === 64 || tag(comm, 18).toLowerCase() === 'fl64' ? 64 : 32) : bits;
  if (!channels || channels > 32 || !sampleRate || sampleRate > 768000) throw new Error('This AIFF file describes its sound in a way that is not valid.');
  if (![8, 16, 24, 32, 64].includes(width) || (width === 64 && kind !== 'float-be')) throw new Error(`AIFF with ${bits}-bit samples is not supported.`);
  const off = new Uint8Array(await file.slice(ssnd.at, ssnd.at + 8).arrayBuffer());
  const skip = ((off[0] << 24) | (off[1] << 16) | (off[2] << 8) | off[3]) >>> 0;
  const dataOffset = ssnd.at + 8 + skip;
  const block = channels * (width / 8);
  const available = Math.max(0, Math.min(file.size, ssnd.at + ssnd.size) - dataOffset);
  const dataLength = Math.min(available, frames * block) - (Math.min(available, frames * block) % block);
  if (dataLength <= 0) throw new Error(ssnd.at + ssnd.size > file.size ? 'This AIFF file is cut short: its sound data is missing.' : 'This AIFF file holds no sound.');
  return { channels, sampleRate, bits: width, kind, dataOffset, dataLength };
}

/** The WAV header that describes the same samples: PCM, IEEE float, mu-law or A-law. */
export function wavHeader(a: AiffInfo): Uint8Array {
  const h = new Uint8Array(44);
  const dv = new DataView(h.buffer);
  const format = a.kind === 'float-be' ? 3 : a.kind === 'ulaw' ? 7 : a.kind === 'alaw' ? 6 : 1;
  const block = a.channels * (a.bits / 8);
  h.set([0x52, 0x49, 0x46, 0x46]);
  dv.setUint32(4, 36 + a.dataLength, true);
  h.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, a.channels, true);
  dv.setUint32(24, a.sampleRate, true);
  dv.setUint32(28, a.sampleRate * block, true);
  dv.setUint16(32, block, true);
  dv.setUint16(34, a.bits, true);
  h.set([0x64, 0x61, 0x74, 0x61], 36);
  dv.setUint32(40, a.dataLength, true);
  return h;
}

/** Converts sample bytes from AIFF order to WAV order, in place. `bytes` starts on a sample boundary. */
export function toWavOrder(bytes: Uint8Array, a: AiffInfo): void {
  const w = a.bits / 8;
  if (a.kind === 'pcm-le' || a.kind === 'ulaw' || a.kind === 'alaw') {
    if (a.kind === 'pcm-le' && w === 1) for (let i = 0; i < bytes.length; i++) bytes[i] ^= 0x80;
    return;
  }
  if (w === 1) { for (let i = 0; i < bytes.length; i++) bytes[i] ^= 0x80; return; } // signed 8-bit to WAV's unsigned
  for (let i = 0; i + w <= bytes.length; i += w) {
    for (let a0 = i, b0 = i + w - 1; a0 < b0; a0++, b0--) { const t = bytes[a0]; bytes[a0] = bytes[b0]; bytes[b0] = t; }
  }
}

/** A source of bytes that reads like the equivalent WAV file. */
export function wavView(file: Blob, a: AiffInfo): { getSize(): number; read(start: number, end: number): Promise<Uint8Array> } {
  const header = wavHeader(a);
  const w = a.bits / 8;
  return {
    getSize: () => header.length + a.dataLength,
    async read(start: number, end: number) {
      const out = new Uint8Array(end - start);
      let at = 0;
      if (start < header.length) {
        const part = header.subarray(start, Math.min(end, header.length));
        out.set(part);
        at = part.length;
      }
      if (end > header.length) {
        const from = Math.max(start, header.length) - header.length;
        const to = end - header.length;
        // Read whole samples so each one is converted entirely.
        const alignedFrom = from - (from % w);
        const alignedTo = Math.min(a.dataLength, to + ((w - (to % w)) % w));
        const raw = new Uint8Array(await file.slice(a.dataOffset + alignedFrom, a.dataOffset + alignedTo).arrayBuffer());
        toWavOrder(raw, a);
        out.set(raw.subarray(from - alignedFrom, from - alignedFrom + (to - from)), at);
      }
      return out;
    },
  };
}
