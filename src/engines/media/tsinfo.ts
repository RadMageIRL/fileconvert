// What an MPEG transport stream says it holds: the stream table (PAT and PMT) at its start. Mediabunny reads the
// streams it can decode and leaves the others out without a word, so FileConvert compares the two and names what
// cannot be converted (MPEG-2 video from TV recordings, sound in a private stream as AVCHD camcorders write it).

export interface TsStream {
  pid: number;
  type: number;
  kind: 'video' | 'audio' | 'other';
  name: string;
}

const STREAM_TYPES: Record<number, [TsStream['kind'], string]> = {
  0x01: ['video', 'MPEG-1 video'], 0x02: ['video', 'MPEG-2 video'], 0x10: ['video', 'MPEG-4 Part 2 video'],
  0x1b: ['video', 'H.264'], 0x24: ['video', 'HEVC'], 0x33: ['video', 'VVC'], 0xea: ['video', 'VC-1'],
  0x03: ['audio', 'MPEG-1 audio'], 0x04: ['audio', 'MPEG-2 audio'], 0x0f: ['audio', 'AAC'], 0x11: ['audio', 'AAC (LATM)'],
  0x80: ['audio', 'LPCM'], 0x81: ['audio', 'AC-3'], 0x82: ['audio', 'DTS'], 0x83: ['audio', 'Dolby TrueHD'],
  0x84: ['audio', 'E-AC-3'], 0x85: ['audio', 'DTS-HD'], 0x86: ['audio', 'DTS-HD Master Audio'], 0x87: ['audio', 'E-AC-3'],
};

/** Descriptors that say what a private stream (type 6) carries. */
const PRIVATE: Record<number, string> = { 0x6a: 'AC-3', 0x7a: 'E-AC-3', 0x7b: 'DTS', 0x56: 'teletext', 0x59: 'subtitles' };

/** Reads the stream table from the first part of a transport stream (188-byte packets, or 192 in M2TS). */
export function tsStreams(b: Uint8Array): TsStream[] {
  const size = b[0] === 0x47 && b[188] === 0x47 ? 188 : b[4] === 0x47 && b[196] === 0x47 ? 192 : 0;
  if (!size) return [];
  const skip = size - 188;
  const payload = (p: number): { pid: number; start: boolean; data: Uint8Array } | null => {
    const at = p + skip;
    if (b[at] !== 0x47 || at + 188 > b.length) return null;
    const pid = ((b[at + 1] & 0x1f) << 8) | b[at + 2];
    const start = (b[at + 1] & 0x40) !== 0;
    const adaptation = (b[at + 3] >> 4) & 3;
    let o = at + 4;
    if (adaptation === 2) return null;
    if (adaptation === 3) o += 1 + b[o];
    return o < at + 188 ? { pid, start, data: b.subarray(o, at + 188) } : null;
  };
  /** The section that starts in a packet (single-packet sections are all a stream table needs here). */
  const section = (data: Uint8Array) => {
    const s = data.subarray(1 + data[0]);
    const len = ((s[1] & 0x0f) << 8) | s[2];
    return s.subarray(0, Math.min(s.length, 3 + len));
  };
  let pmtPid = -1;
  for (let p = 0; p + size <= b.length && pmtPid < 0; p += size) {
    const pk = payload(p);
    if (!pk || pk.pid !== 0 || !pk.start) continue;
    const s = section(pk.data);
    if (s[0] !== 0x00 || s.length < 16) continue;
    for (let i = 8; i + 4 <= s.length - 4; i += 4) {
      const program = (s[i] << 8) | s[i + 1];
      if (program !== 0) { pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3]; break; }
    }
  }
  if (pmtPid < 0) return [];
  for (let p = 0; p + size <= b.length; p += size) {
    const pk = payload(p);
    if (!pk || pk.pid !== pmtPid || !pk.start) continue;
    const s = section(pk.data);
    if (s[0] !== 0x02 || s.length < 16) continue;
    const infoLen = ((s[10] & 0x0f) << 8) | s[11];
    const out: TsStream[] = [];
    for (let i = 12 + infoLen; i + 5 <= s.length - 4;) {
      const type = s[i];
      const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
      const esLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      let [kind, name] = STREAM_TYPES[type] ?? ['other', `stream type 0x${type.toString(16)}`];
      if (type === 0x06) {
        // A private stream: its descriptors say what it is.
        for (let d = i + 5; d + 2 <= i + 5 + esLen; d += 2 + s[d + 1]) {
          const what = PRIVATE[s[d]];
          if (what) { name = what; kind = /AC-3|DTS/.test(what) ? 'audio' : 'other'; break; }
        }
        if (name.startsWith('stream type')) name = 'a private stream';
      }
      out.push({ pid, type, kind, name });
      i += 5 + esLen;
    }
    return out;
  }
  return [];
}

/** Notes about what Mediabunny could not read, given what it found. */
export function unreadableStreams(streams: TsStream[], readable: { video: number; audio: number }): { video: string | null; audio: string[] } {
  const videos = streams.filter(s => s.kind === 'video');
  const audios = streams.filter(s => s.kind === 'audio');
  const missingAudio = Math.max(0, audios.length - readable.audio);
  const privateCount = streams.filter(s => s.type === 0x06 && s.kind === 'other' && s.name === 'a private stream').length;
  const audio: string[] = [];
  if (missingAudio) audio.push(`${missingAudio} of its sound tracks (${audios.map(a => a.name).join(', ')}) cannot be read, so the result has no sound from ${missingAudio === 1 ? 'it' : 'them'}.`);
  else if (readable.audio === 0 && privateCount && videos.length) audio.push('It may carry sound in a private stream, as AVCHD camcorders do, which FileConvert cannot read; the result has no sound from it.');
  return { video: videos.length && readable.video === 0 ? videos[0].name : null, audio };
}
