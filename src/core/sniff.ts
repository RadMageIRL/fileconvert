// Content-based format detection. A file's name and the browser's MIME type are only hints: what counts
// is the signature in the bytes. Runs on the first and last 64 KiB of a file, so it never reads a
// whole large file, and works the same in the browser and in Node (unit tests).

import { extensionOf, formatByExtension, FORMATS, type FormatId } from './formats';
import { isTarHeader } from '../engines/archive/tarheader';

export const SNIFF_BYTES = 64 * 1024;

export interface Sniffed {
  /** The format FileConvert will treat the file as, or null when it cannot convert it. */
  format: FormatId | null;
  /** A human name for what the file is, also for formats FileConvert does not convert. */
  label: string;
  /** Why the file cannot be converted, when format is null. */
  reason?: string;
  /** Set when the file name claims a different format than the contents. */
  mismatch?: string;
}

const ascii = (b: Uint8Array, start: number, len: number) => {
  let s = '';
  for (let i = start; i < Math.min(b.length, start + len); i++) s += String.fromCharCode(b[i]);
  return s;
};
const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

const RAW_EXTS = ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'raf', 'pef', 'srw', 'x3f', '3fr', 'erf', 'kdc', 'mrw', 'iiq'];

/** Text formats told apart by the file name, since their bytes can look alike. */
const TEXT_FORMATS: FormatId[] = ['txt', 'md', 'html', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'xml'];

function unsupported(label: string, reason: string): Sniffed {
  return { format: null, label, reason };
}

function isoBrands(head: Uint8Array): { major: string; all: Set<string> } | null {
  if (head.length < 16 || ascii(head, 4, 4) !== 'ftyp') return null;
  const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  const major = ascii(head, 8, 4);
  const all = new Set([major]);
  for (let i = 16; i + 4 <= Math.min(size, head.length, 256); i += 4) all.add(ascii(head, i, 4));
  return { major, all };
}

function sniffIso(head: Uint8Array, ext: string): Sniffed | null {
  const brands = isoBrands(head);
  if (!brands) return null;
  const { major, all } = brands;
  const heicBrands = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'];
  if (major === 'avif' || major === 'avis') return { format: 'avif', label: 'AVIF image' };
  if (heicBrands.includes(major)) return { format: 'heic', label: 'HEIC image' };
  if (major === 'mif1' || major === 'msf1') {
    if (all.has('avif') || all.has('avis')) return { format: 'avif', label: 'AVIF image' };
    return { format: 'heic', label: 'HEIF image' };
  }
  if (major === 'crx ') return unsupported('Canon RAW (CR3) photo', 'Camera RAW files are not supported. Export a JPG or TIFF from your camera software first.');
  if (major === 'qt  ') return { format: 'mov', label: 'QuickTime movie' };
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') {
    if (major === 'M4P ') return unsupported('Protected AAC audio', 'This audio is protected with DRM and cannot be converted.');
    return { format: 'm4a', label: 'MPEG-4 audio' };
  }
  if (ext === 'm4a' || ext === 'm4b') return { format: 'm4a', label: 'MPEG-4 audio' };
  if (ext === 'mov' || ext === 'qt') return { format: 'mov', label: 'QuickTime movie' };
  return { format: 'mp4', label: 'MPEG-4 video' };
}

function sniffMpegAudio(head: Uint8Array, ext: string): Sniffed | null {
  let at = 0;
  const tagged = ascii(head, 0, 3) === 'ID3' && head.length >= 10;
  if (tagged) {
    const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    at = 10 + tagSize + ((head[5] & 0x10) ? 10 : 0);
    if (at + 4 > head.length) {
      // The tag (usually cover art) is longer than the bytes read. Trust the name for what follows.
      if (ext === 'aac') return { format: 'aac', label: 'AAC audio' };
      if (ext === 'flac') return { format: 'flac', label: 'FLAC audio' };
      return { format: 'mp3', label: 'MP3 audio' };
    }
    if (ascii(head, at, 4) === 'fLaC') return { format: 'flac', label: 'FLAC audio' };
  }
  // Skip any zero padding after a tag.
  if (tagged) while (at < head.length && at < 4096 && head[at] === 0) at++;
  const b0 = head[at], b1 = head[at + 1], b2 = head[at + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return tagged ? { format: 'mp3', label: 'MP3 audio' } : null;
  const layer = (b1 >> 1) & 3;
  if (layer === 0) {
    // ADTS: MPEG-2/4 AAC. The sampling frequency index (bits 2..5 of the third byte) must be valid.
    if ((b1 & 0xf6) === 0xf0 && ((b2 >> 2) & 0xf) < 13) return { format: 'aac', label: 'AAC audio' };
    return null;
  }
  const version = (b1 >> 3) & 3;
  const bitrate = (b2 >> 4) & 0xf;
  const rate = (b2 >> 2) & 3;
  if (version === 1 || bitrate === 0xf || bitrate === 0 || rate === 3) return null;
  if (layer !== 1) return unsupported(`MPEG Layer ${layer === 2 ? 'II' : 'I'} audio`, 'Only MPEG Layer III (MP3) audio is supported, not Layer I or II.');
  return { format: 'mp3', label: 'MP3 audio' };
}

function sniffOgg(head: Uint8Array): Sniffed {
  // The first page's first packet names the codec. The page header is 27 bytes plus the segment table.
  const segments = head[26] ?? 0;
  const at = 27 + segments;
  const id = ascii(head, at, 8);
  if (id.startsWith('\x01vorbis')) return { format: 'ogg', label: 'Ogg Vorbis audio' };
  if (id === 'OpusHead') return { format: 'ogg', label: 'Ogg Opus audio' };
  if (id.startsWith('\x7fFLAC')) return { format: 'ogg', label: 'Ogg FLAC audio' };
  if (id.startsWith('\x80theora')) return unsupported('Ogg Theora video', 'Theora video is not supported. MP4, WebM, MOV and MKV are.');
  if (id.startsWith('Speex')) return unsupported('Ogg Speex audio', 'Speex audio is not supported.');
  return unsupported('Ogg file', 'This Ogg file holds a codec FileConvert does not recognize.');
}

/** Finds the ZIP central directory in the tail and returns the entry names, or null. */
export function zipEntryNames(tail: Uint8Array, limit = 400): string[] | null {
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 22 - 65535); i--) {
    if (tail[i] !== 0x50 || tail[i + 1] !== 0x4b || tail[i + 2] !== 5 || tail[i + 3] !== 6) continue;
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const cdSize = dv.getUint32(i + 12, true);
    if (cdSize > i) return null; // the directory starts before the bytes we have
    const names: string[] = [];
    let p = i - cdSize;
    while (p + 46 <= i && dv.getUint32(p, true) === 0x02014b50 && names.length < limit) {
      const nameLen = dv.getUint16(p + 28, true);
      const extra = dv.getUint16(p + 30, true);
      const comment = dv.getUint16(p + 32, true);
      names.push(new TextDecoder().decode(tail.subarray(p + 46, p + 46 + nameLen)));
      p += 46 + nameLen + extra + comment;
    }
    return names;
  }
  return null;
}

function sniffZip(head: Uint8Array, tail: Uint8Array, ext: string): Sniffed {
  const names = zipEntryNames(tail) ?? [];
  const first = ascii(head, 30, Math.min(head[26] | (head[27] << 8), 64));
  const has = (p: string) => names.some(n => n.startsWith(p)) || first.startsWith(p);
  if (has('word/')) return { format: 'docx', label: 'Word document' };
  if (has('xl/')) return { format: 'xlsx', label: 'Excel workbook' };
  if (has('ppt/')) return unsupported('PowerPoint presentation', 'PowerPoint files are not supported.');
  if (names.includes('mimetype') || first === 'mimetype') {
    const mime = ascii(head, 38, 60);
    if (mime.includes('epub')) return unsupported('EPUB book', 'EPUB books are not supported.');
    if (mime.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return { format: 'ods', label: 'OpenDocument spreadsheet' };
    if (mime.includes('opendocument')) return unsupported('OpenDocument file', 'OpenDocument text (ODT) and presentations (ODP) are not supported. ODS spreadsheets are.');
  }
  if (names.length === 0 && (ext === 'docx' || ext === 'xlsx' || ext === 'ods')) {
    // The directory is beyond the bytes read (a very large package). Let the engine check it fully.
    if (ext === 'ods') return { format: 'ods', label: 'OpenDocument spreadsheet' };
    return ext === 'docx' ? { format: 'docx', label: 'Word document' } : { format: 'xlsx', label: 'Excel workbook' };
  }
  return { format: 'zip', label: 'ZIP archive' };
}

/** UTF-16LE bytes of a name, as an OLE compound file's directory stores it. */
const utf16 = (name: string) => [...name].flatMap(c => [c.charCodeAt(0), 0]);
function hasBytes(b: Uint8Array, sig: number[]): boolean {
  outer: for (let i = 0; i + sig.length <= b.length; i++) {
    for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * An OLE compound file: Excel 97-2003 (XLS), or Word, PowerPoint or an Outlook message. The directory names the
 * streams; when it lies beyond the bytes read (a large file), the extension decides.
 */
function sniffCompound(head: Uint8Array, ext: string): Sniffed {
  if (hasBytes(head, utf16('Workbook')) || hasBytes(head, [0x42, 0, 0x6f, 0, 0x6f, 0, 0x6b, 0, 0, 0]) || ((ext === 'xls' || ext === 'xlt') && !hasBytes(head, utf16('WordDocument')))) {
    return { format: 'xls', label: 'Excel 97-2003 workbook' };
  }
  if (hasBytes(head, utf16('WordDocument')) || ext === 'doc' || ext === 'dot') return unsupported('Word 97-2003 document', 'Word 97-2003 (DOC) documents are not supported. Save it as DOCX first.');
  if (hasBytes(head, utf16('PowerPoint Document')) || ext === 'ppt' || ext === 'pps') return unsupported('PowerPoint 97-2003 presentation', 'PowerPoint files are not supported.');
  if (hasBytes(head, utf16('__substg1.0_')) || ext === 'msg') return unsupported('Outlook message', 'Outlook MSG files are not supported.');
  return unsupported('Legacy Office file', 'This older Office file is not an Excel workbook. Excel 97-2003 (XLS) workbooks are supported; Word, PowerPoint and Outlook files are not.');
}

/**
 * JSON Lines: the first line is a complete JSON object or list, and the next one starts another. Pretty-printed JSON
 * starts with a line that is only a bracket, and minified JSON is a single line, so neither is taken for it.
 */
function looksLikeJsonLines(text: string): boolean {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2 || !/^[[{]/.test(lines[0]) || !/^[[{]/.test(lines[1])) return false;
  try {
    const v: unknown = JSON.parse(lines[0]);
    return v !== null && typeof v === 'object';
  } catch {
    return false;
  }
}

/** True when the bytes look like text: no NUL bytes outside a UTF-16 pattern and no other control bytes in bulk. */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  if (starts(head, [0xff, 0xfe]) || starts(head, [0xfe, 0xff])) return true;
  let nul = 0, ctrl = 0;
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) {
    const c = head[i];
    if (c === 0) nul++;
    else if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  if (nul > 0) {
    // UTF-16 without a BOM: every other byte is zero for Latin text.
    let even = 0, odd = 0;
    for (let i = 0; i < n; i++) if (head[i] === 0) (i % 2 ? odd++ : even++);
    return (odd > n * 0.3 && even < n * 0.02) || (even > n * 0.3 && odd < n * 0.02);
  }
  return ctrl < n * 0.02;
}

function sniffText(head: Uint8Array, ext: string, size: number): Sniffed {
  if (size === 0) {
    const byExt = formatByExtension('x.' + ext);
    if (byExt && TEXT_FORMATS.includes(byExt)) return { format: byExt, label: FORMATS[byExt].label + ' file (empty)' };
    return { format: 'txt', label: 'Empty text file' };
  }
  let text = '';
  try {
    text = new TextDecoder('utf-8').decode(head.subarray(0, 4096));
    if (head[0] === 0xff && head[1] === 0xfe) text = new TextDecoder('utf-16le').decode(head.subarray(0, 4096));
    if (head[0] === 0xfe && head[1] === 0xff) text = new TextDecoder('utf-16be').decode(head.subarray(0, 4096));
  } catch { /* undecodable: treated as plain text below */ }
  const t = text.replace(/^\ufeff/, '').trimStart().toLowerCase();
  if (ext === 'svg' || /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(t)) {
    return { format: 'svg', label: 'SVG image' };
  }
  if (ext === 'rtf' || t.startsWith('{\\rtf')) return unsupported('Rich Text document', 'RTF documents are not supported.');
  const byExt = formatByExtension('x.' + ext);
  // NDJSON is often saved as .json; it is read as JSON Lines when its lines say so.
  if ((byExt === 'json' || !byExt) && /^[[{]/.test(t) && looksLikeJsonLines(new TextDecoder('utf-8').decode(head).replace(/^\ufeff/, ''))) {
    return { format: 'jsonl', label: 'JSON Lines file' };
  }
  if (byExt && TEXT_FORMATS.includes(byExt)) {
    return { format: byExt, label: FORMATS[byExt].label + ' file' };
  }
  if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/.test(t)) return { format: 'html', label: 'HTML page' };
  if (t.startsWith('<?xml') || /^<[a-z_][\w.-]*(:[\w.-]+)?[\s>/]/.test(t)) return { format: 'xml', label: 'XML file' };
  if (t.startsWith('{') || t.startsWith('[')) return { format: 'json', label: 'JSON file' };
  return { format: 'txt', label: ext ? `Plain text (.${ext})` : 'Plain text' };
}

function detect(head: Uint8Array, tail: Uint8Array, size: number, ext: string, name?: string): Sniffed {
  if (starts(head, [0xff, 0xd8, 0xff])) return { format: 'jpg', label: 'JPEG image' };
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: 'png', label: 'PNG image' };
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { format: 'gif', label: 'GIF image' };
  if (ascii(head, 0, 4) === 'RIFF') {
    const kind = ascii(head, 8, 4);
    if (kind === 'WEBP') return { format: 'webp', label: 'WebP image' };
    if (kind === 'WAVE') return { format: 'wav', label: 'WAV audio' };
    if (kind === 'AVI ') return unsupported('AVI video', 'AVI is not supported yet. MP4, WebM, MOV and MKV are.');
    return unsupported('RIFF file', 'This RIFF file is not a WAV, WebP or AVI file.');
  }
  if (ascii(head, 0, 2) === 'BM' && head.length >= 18) {
    const dib = head[14] | (head[15] << 8) | (head[16] << 16) | (head[17] << 24);
    if ([12, 16, 40, 52, 56, 64, 108, 124].includes(dib)) return { format: 'bmp', label: 'BMP image' };
  }
  if (starts(head, [0x49, 0x49, 0x2a, 0x00]) || starts(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    if (RAW_EXTS.includes(ext)) return unsupported('Camera RAW photo', 'Camera RAW files are not supported. Export a JPG or TIFF from your camera software first.');
    return { format: 'tiff', label: 'TIFF image' };
  }
  if (starts(head, [0x49, 0x49, 0x2b, 0x00]) || starts(head, [0x4d, 0x4d, 0x00, 0x2b])) {
    return unsupported('BigTIFF image', 'BigTIFF (TIFF files over 4 GB) is not supported.');
  }
  const iso = sniffIso(head, ext);
  if (iso) return iso;
  if (starts(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    const h = ascii(head, 0, 64);
    if (h.includes('webm')) return { format: 'webm', label: 'WebM video' };
    return { format: 'mkv', label: 'Matroska video' };
  }
  if (ascii(head, 0, 4) === 'fLaC') return { format: 'flac', label: 'FLAC audio' };
  if (ascii(head, 0, 4) === 'FORM' && (ascii(head, 8, 4) === 'AIFF' || ascii(head, 8, 4) === 'AIFC')) return { format: 'aiff', label: ascii(head, 8, 4) === 'AIFC' ? 'AIFF-C audio' : 'AIFF audio' };
  if (ascii(head, 0, 4) === 'OggS') return sniffOgg(head);
  if (ascii(head, 0, 1024).includes('%PDF-')) return { format: 'pdf', label: 'PDF document' };
  if (starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06])) return sniffZip(head, tail, ext);
  // TAR: the ustar mark in the first header, or a valid header checksum on a .tar file (old TARs have no mark).
  if (head.length >= 512 && (ascii(head, 257, 5) === 'ustar' || ext === 'tar') && isTarHeader(head)) return { format: 'tar', label: 'TAR archive' };
  // A UTF-16 byte order mark (FF FE, FE FF) also looks like an MPEG audio frame header; text wins.
  if ((starts(head, [0xff, 0xfe]) || starts(head, [0xfe, 0xff])) && looksLikeText(head)) return sniffText(head, ext, size);
  const mpeg = sniffMpegAudio(head, ext);
  if (mpeg) return mpeg;
  if (ascii(head, 0, 4) === 'Rar!') return unsupported('RAR archive', 'RAR archives are not supported. ZIP, TAR and GZ archives can be unpacked.');
  if (starts(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return unsupported('7-Zip archive', '7-Zip archives are not supported. ZIP, TAR and GZ archives can be unpacked.');
  if (starts(head, [0x1f, 0x8b, 0x08])) return { format: 'gz', label: ext === 'tgz' || /\.tar\.gz$/i.test(name ?? '') ? 'TAR archive, gzipped' : 'Gzip file' };
  if (ascii(head, 0, 2) === 'MZ') return unsupported('Windows program', 'Programs are not converted.');
  if (starts(head, [0x7f, 0x45, 0x4c, 0x46])) return unsupported('Linux program', 'Programs are not converted.');
  if (ascii(head, 0, 4) === '8BPS') return unsupported('Photoshop document', 'PSD files are not supported.');
  if (starts(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return sniffCompound(head, ext);
  if ((starts(head, [0x00, 0x00, 0x01, 0x00]) || starts(head, [0x00, 0x00, 0x02, 0x00])) && head.length >= 22) {
    // An icon directory: a sane picture count and a first picture that starts after the directory.
    const count = head[4] | (head[5] << 8);
    const first = (head[18] | (head[19] << 8) | (head[20] << 16) | (head[21] << 24)) >>> 0;
    if (count > 0 && count <= 256 && first >= 6 + count * 16 && first < size) return { format: 'ico', label: head[2] === 2 ? 'Windows cursor' : 'Windows icon' };
  }
  if (starts(head, [0xff, 0x0a]) || starts(head, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return unsupported('JPEG XL image', 'JPEG XL is not supported yet.');
  if (starts(head, [0x30, 0x26, 0xb2, 0x75])) return unsupported('Windows Media file', 'WMA and WMV files are not supported.');
  // MPEG transport stream: a sync byte every 188 bytes, or every 192 in the M2TS variant (AVCHD camcorders).
  if (starts(head, [0x47]) && head.length > 376 && head[188] === 0x47 && head[376] === 0x47) return { format: 'ts', label: 'MPEG transport stream' };
  if (head.length > 388 && head[4] === 0x47 && head[196] === 0x47 && head[388] === 0x47) return { format: 'ts', label: 'MPEG transport stream (M2TS)' };
  if (looksLikeText(head)) return sniffText(head, ext, size);
  return unsupported('Unknown file', 'FileConvert does not recognize this file type.');
}

/**
 * Detects a file's format from its first and last bytes. `tail` may be the same array as `head` for
 * small files. `name` is used only to break ties (plain text kinds, M4A versus MP4) and to warn when
 * the extension disagrees with the contents.
 */
export function sniff(head: Uint8Array, tail: Uint8Array, size: number, name: string): Sniffed {
  const ext = extensionOf(name);
  const result = detect(head, tail, size, ext, name);
  const claimed = formatByExtension(name);
  if (result.format && claimed && claimed !== result.format) {
    const family = (x: FormatId) => (x === 'm4a' || x === 'mp4' || x === 'mov') ? 'iso' : (x === 'mkv' || x === 'webm') ? 'mkv' : x;
    const both = TEXT_FORMATS.includes(claimed) && TEXT_FORMATS.includes(result.format);
    if (family(claimed) !== family(result.format) && !both) {
      result.mismatch = `Named .${ext} but contains ${result.label} data. It will be converted as ${FORMATS[result.format].label}.`;
    }
  }
  return result;
}

/** Reads the head and tail of a Blob and sniffs it. */
export async function sniffBlob(blob: Blob, name: string): Promise<Sniffed> {
  const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
  const tail = blob.size > SNIFF_BYTES ? new Uint8Array(await blob.slice(Math.max(0, blob.size - SNIFF_BYTES)).arrayBuffer()) : head;
  return sniff(head, tail, blob.size, name);
}
