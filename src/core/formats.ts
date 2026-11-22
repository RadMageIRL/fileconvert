// The format registry: every format FileConvert reads or writes, and which conversions exist. The interface,
// the README's support table check (tests/unit/formats.test.ts) and the engines all read from here, so a
// conversion is offered only if it is listed below.

export type Category = 'image' | 'audio' | 'video' | 'document' | 'data';

export type FormatId =
  | 'jpg' | 'png' | 'webp' | 'avif' | 'heic' | 'bmp' | 'gif' | 'tiff'
  | 'mp3' | 'wav' | 'flac' | 'aac' | 'm4a' | 'ogg'
  | 'mp4' | 'webm' | 'mov' | 'mkv'
  | 'txt' | 'pdf' | 'md' | 'html' | 'docx'
  | 'json' | 'csv' | 'tsv' | 'yaml' | 'xml' | 'xlsx';

export interface Format {
  id: FormatId;
  /** Short name shown in menus. */
  label: string;
  /** Extension written on output files, without the dot. */
  ext: string;
  /** Extensions recognized on input files. */
  exts: readonly string[];
  mime: string;
  category: Category;
  /** One line shown under the output menu when this format is chosen. */
  hint?: string;
}

const f = (id: FormatId, label: string, ext: string, exts: string[], mime: string, category: Category, hint?: string): Format =>
  ({ id, label, ext, exts, mime, category, hint });

export const FORMATS: Readonly<Record<FormatId, Format>> = {
  jpg: f('jpg', 'JPG', 'jpg', ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/jpeg', 'image', 'Lossy, no transparency.'),
  png: f('png', 'PNG', 'png', ['png', 'apng'], 'image/png', 'image', 'Lossless, keeps transparency.'),
  webp: f('webp', 'WebP', 'webp', ['webp'], 'image/webp', 'image', 'Small files, keeps transparency.'),
  avif: f('avif', 'AVIF', 'avif', ['avif'], 'image/avif', 'image', 'Smallest files, slower to encode, keeps transparency.'),
  heic: f('heic', 'HEIC', 'heic', ['heic', 'heif', 'hif'], 'image/heic', 'image'),
  bmp: f('bmp', 'BMP', 'bmp', ['bmp', 'dib'], 'image/bmp', 'image', 'Uncompressed 24-bit, no transparency.'),
  gif: f('gif', 'GIF', 'gif', ['gif'], 'image/gif', 'image', '256 colors, on/off transparency.'),
  tiff: f('tiff', 'TIFF', 'tiff', ['tif', 'tiff'], 'image/tiff', 'image', 'Uncompressed, keeps transparency.'),

  mp3: f('mp3', 'MP3', 'mp3', ['mp3'], 'audio/mpeg', 'audio', 'Plays everywhere.'),
  wav: f('wav', 'WAV', 'wav', ['wav', 'wave'], 'audio/wav', 'audio', 'Uncompressed 16-bit PCM.'),
  flac: f('flac', 'FLAC', 'flac', ['flac'], 'audio/flac', 'audio', 'Lossless compression.'),
  aac: f('aac', 'AAC', 'aac', ['aac', 'adts'], 'audio/aac', 'audio', 'AAC-LC in a raw ADTS stream.'),
  m4a: f('m4a', 'M4A', 'm4a', ['m4a', 'm4b'], 'audio/mp4', 'audio', 'AAC-LC in an MP4 audio file.'),
  ogg: f('ogg', 'OGG', 'ogg', ['ogg', 'oga', 'opus'], 'audio/ogg', 'audio', 'Opus audio in an Ogg file.'),

  mp4: f('mp4', 'MP4', 'mp4', ['mp4', 'm4v'], 'video/mp4', 'video', 'H.264 video and AAC audio.'),
  webm: f('webm', 'WebM', 'webm', ['webm'], 'video/webm', 'video', 'VP9 video and Opus audio.'),
  mov: f('mov', 'MOV', 'mov', ['mov', 'qt'], 'video/quicktime', 'video', 'H.264 video and AAC audio in QuickTime.'),
  mkv: f('mkv', 'MKV', 'mkv', ['mkv', 'mk3d', 'mka'], 'video/x-matroska', 'video', 'H.264 video and AAC audio in Matroska.'),

  txt: f('txt', 'TXT', 'txt', ['txt', 'text', 'log'], 'text/plain', 'document', 'Plain UTF-8 text.'),
  pdf: f('pdf', 'PDF', 'pdf', ['pdf'], 'application/pdf', 'document'),
  md: f('md', 'Markdown', 'md', ['md', 'markdown', 'mdown', 'mkd'], 'text/markdown', 'document'),
  html: f('html', 'HTML', 'html', ['html', 'htm', 'xhtml'], 'text/html', 'document', 'A standalone page with scripts removed.'),
  docx: f('docx', 'DOCX', 'docx', ['docx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'),

  json: f('json', 'JSON', 'json', ['json', 'geojson'], 'application/json', 'data'),
  csv: f('csv', 'CSV', 'csv', ['csv'], 'text/csv', 'data'),
  tsv: f('tsv', 'TSV', 'tsv', ['tsv', 'tab'], 'text/tab-separated-values', 'data', 'Tab-separated values.'),
  yaml: f('yaml', 'YAML', 'yaml', ['yaml', 'yml'], 'application/yaml', 'data'),
  xml: f('xml', 'XML', 'xml', ['xml'], 'application/xml', 'data'),
  xlsx: f('xlsx', 'XLSX', 'xlsx', ['xlsx'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'data'),
};

export const IMAGE_OUT: readonly FormatId[] = ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff'];
export const AUDIO_OUT: readonly FormatId[] = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'];
export const VIDEO_OUT: readonly FormatId[] = ['mp4', 'webm', 'mov', 'mkv', 'gif'];

export const IMAGE_IN: readonly FormatId[] = ['jpg', 'png', 'webp', 'avif', 'heic', 'bmp', 'gif', 'tiff'];
export const AUDIO_IN: readonly FormatId[] = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'];
export const VIDEO_IN: readonly FormatId[] = ['mp4', 'webm', 'mov', 'mkv'];

/** What the inspection step learned about a media or image file; it changes which outputs make sense. */
export interface InputTraits {
  animated?: boolean;
  hasVideo?: boolean;
  hasAudio?: boolean;
}

/** The engine that performs a conversion. */
export type Engine = 'image' | 'media' | 'gif-to-video' | 'video-to-gif' | 'document' | 'data';

const DOCUMENT_ROUTES: Partial<Record<FormatId, FormatId[]>> = {
  txt: ['pdf'],
  pdf: ['txt'],
  md: ['html', 'pdf'],
  html: ['pdf'],
  docx: ['txt'],
};
const DATA_ROUTES: Partial<Record<FormatId, FormatId[]>> = {
  json: ['csv', 'xlsx', 'tsv', 'yaml', 'xml'],
  csv: ['json', 'xlsx', 'tsv'],
  tsv: ['json', 'xlsx', 'csv'],
  yaml: ['json'],
  xml: ['json'],
  xlsx: ['csv', 'json', 'tsv'],
};

/** The category a file is converted as, after inspection (an MP4 with no video track is audio). */
export function effectiveCategory(input: FormatId, traits: InputTraits = {}): Category {
  const cat = FORMATS[input].category;
  if (cat === 'video' && traits.hasVideo === false) return 'audio';
  if (cat === 'audio' && traits.hasVideo === true && input === 'm4a') return 'video';
  return cat;
}

/** Output formats offered for an input. The first entry is the default choice. */
export function targetsFor(input: FormatId, traits: InputTraits = {}): FormatId[] {
  const cat = effectiveCategory(input, traits);
  switch (cat) {
    case 'image': {
      const preferred: Partial<Record<FormatId, FormatId>> = {
        jpg: 'png', png: 'jpg', webp: 'png', avif: 'jpg', heic: 'jpg', bmp: 'png', gif: 'png', tiff: 'png',
      };
      const first = preferred[input] ?? 'png';
      const list = [first, ...IMAGE_OUT.filter(x => x !== first)];
      if (input === 'gif' && traits.animated) list.push('mp4', 'webm');
      return list;
    }
    case 'audio': {
      if (traits.hasAudio === false) return [];
      const first: FormatId = input === 'mp3' ? 'wav' : 'mp3';
      return [first, ...AUDIO_OUT.filter(x => x !== first)];
    }
    case 'video': {
      const first: FormatId = input === 'mp4' ? 'webm' : 'mp4';
      const list = [first, ...VIDEO_OUT.filter(x => x !== first)];
      if (traits.hasAudio !== false) list.push(...AUDIO_OUT);
      return list;
    }
    case 'document':
      return [...(DOCUMENT_ROUTES[input] ?? [])];
    case 'data':
      return [...(DATA_ROUTES[input] ?? [])];
  }
}

export function engineFor(input: FormatId, to: FormatId, traits: InputTraits = {}): Engine {
  const cat = effectiveCategory(input, traits);
  if (cat === 'image') return (to === 'mp4' || to === 'webm') ? 'gif-to-video' : 'image';
  if (cat === 'video' && to === 'gif') return 'video-to-gif';
  if (cat === 'audio' || cat === 'video') return 'media';
  return cat === 'document' ? 'document' : 'data';
}

/** Every input/output pair FileConvert can perform, for the support table and its test. */
export function allConversions(): Array<[FormatId, FormatId]> {
  const pairs: Array<[FormatId, FormatId]> = [];
  for (const id of Object.keys(FORMATS) as FormatId[]) {
    const traits: InputTraits = id === 'gif' ? { animated: true } : {};
    for (const to of targetsFor(id, traits)) pairs.push([id, to]);
  }
  return pairs;
}

export function formatByExtension(name: string): FormatId | null {
  const ext = extensionOf(name);
  if (!ext) return null;
  for (const fmt of Object.values(FORMATS)) if (fmt.exts.includes(ext)) return fmt.id;
  return null;
}

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
