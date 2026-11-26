// The PDF guard. Before pdf.js or the PDF editing library reads a file, this reads it as bytes, with no PDF
// library, and refuses it when reading it would take more memory than it should:
//
// - Every stream with an expanding filter (Flate, LZW, RunLength, ASCII85, ASCIIHex, and chains of them, with
//   predictors) is decoded as a count, in pieces, through its own filters (./filters.ts), and stopped as soon as
//   one stream, all streams, or the object streams a library keeps in memory pass their limits. Nothing is kept,
//   so measuring a stream that would expand to gigabytes holds a few kilobytes. pdf.js decodes fonts and large
//   pictures whole, and the editing library decodes every object stream on load, so declared sizes and picture
//   dimensions are never trusted for this.
// - Sizes that readers allocate from directly are checked: picture dimensions (in the dictionary, and in the
//   JPEG or JPEG 2000 header itself), sampled functions, and the rows predictors and fax decoders work on.
// - Objects and page dictionaries are counted, in the file and inside object streams.
// - Forms are followed: pdf.js reads a form's content again each time it is drawn, through forms inside forms and
//   annotations that share an appearance, so what that comes to is worked out from which form each name draws in its
//   own resources. Forms that draw each other in a loop, or nest too deeply or too often to work out, are refused.
// - Encrypted files cannot be measured (their streams are unreadable without the key), so they are reported, and
//   FileConvert refuses them (v0.2.0 does not decrypt). Brotli-compressed streams are refused.
//
// The limits are in src/core/limits.ts. The scan is synchronous; it runs in a worker, which is stopped to cancel it.
// It reads structure with a byte scanner, not a full parser, so a deliberately malformed file can still mislead it.

import { LIMITS, LimitError } from '../../core/limits';
import { RENDER_KEPT_PAGES } from '../../core/pdfmemory';
import { Ascii85Stage, AsciiHexStage, FlateStage, LzwStage, PredictorStage, RunLengthStage, type Sink, type Stage } from './filters';
import { isDict, isName, isRef, normName, num, ObjReader, type PdfDict, type PdfValue } from './pdfobj';

export type PdfLimits = Record<'pdfBytes' | 'pdfPages' | 'pdfStreamBytes' | 'pdfDecodedBytes' | 'pdfObjectStreamBytes' | 'pdfObjects' | 'pdfImagePixels' | 'pdfFunctionSamples' | 'pdfRowBytes', number>;

export interface PdfScan {
  /** The version in the header, such as "1.7", or null when there is none. */
  version: string | null;
  encrypted: boolean;
  /** Indirect objects, in the file and in object streams. */
  objects: number;
  /** Page dictionaries (/Type /Page), in the file and in object streams. */
  pages: number;
  streams: number;
  objectStreams: number;
  /** Bytes all expanding filters produce together, intermediate stages included. */
  decodedBytes: number;
  /** Bytes outside stream data (object headers, dictionaries, arrays, the cross-reference table): what a PDF library
   *  parses into objects when it loads the file. */
  textBytes: number;
  /** Bytes the object streams decode to, which a PDF library also parses into objects. */
  objectStreamBytes: number;
  largestStream: number;
  /** Bytes of page content once decoded: the streams that are not pictures, fonts, profiles or object streams, without
   *  padding (a run of white space or zero bytes counts its first PAD_RUN bytes only). Reading text, drawing and the
   *  cleanup's look at what each page uses read all of it. */
  contentBytes: number;
  /** The largest content stream, counted the same way: one page's content is read at once. */
  largestContent: number;
  /** Content pdf.js reads again through forms, as much of it as the 50 pages pdf.js keeps can hold. Each Do in page
   *  content draws the form its name refers to (the largest, where a name refers to several), and that form's own Do
   *  operators draw the forms their names refer to in the form's own resources (or the resources it is drawn with,
   *  when it has none), level after level, each time it is drawn; pictures count nothing. Worked out per content
   *  stream, so the 50 pages held are the costliest ones. */
  formExpansion: number;
  /** The same, for the forms that hold text (a BT operator): what reading text goes through again. */
  textFormExpansion: number;
  /** What drawing annotations reads: each entry in a page's /Annots draws its appearance form once (forms in it
   *  counted as above), so an appearance many annotations share counts once for each. Drawing only. */
  annotExpansion: number;
  /** Font programs pdf.js loads again while drawing forms, as much of it as the 50 pages it keeps can hold: a font
   *  written out in full in a form's own resources (not an object of its own) is loaded each time the form is drawn,
   *  counted as a standard font's program or the largest one in the file. Drawing only. */
  formFontBytes: number;
  /** Soft masks set while drawing the costliest page and the page before it, forms and annotations included: each time
   *  a graphics state with a soft mask is set, pdf.js draws the mask's form into page-sized canvases, which the browser
   *  frees late. */
  maskDraws: number;
  /** Content the editing library's cleanup reads through forms, each once: each Do anywhere times the
   *  largest form its name refers to, with nothing multiplied. */
  editFormExpansion: number;
  /** Bytes of page content once decoded, padding included (pdf.js keeps each decoded stream while it reads it), in all
   *  and for the largest stream. */
  rawContent: number;
  largestRawContent: number;
  /** The most streams in one page's /Contents array (1 when none has an array): with the largest stream, a bound on
   *  one page's content, which is read at once. */
  maxContents: number;
  /** Bytes of embedded font programs once decoded. pdf.js reads and converts every font a page uses, to read its text
   *  or to draw it. */
  fontBytes: number;
  images: number;
  largestImagePixels: number;
  /** Pixels of the largest JPEG 2000 picture, from its own header: decoding one costs more than a JPEG. */
  largestJpxPixels: number;
  /** A digital signature is likely (a signature dictionary or a byte range was seen); the parsed check decides. */
  signatureHint: boolean;
  /** Pictures compressed with JBIG2 or JPEG 2000. */
  jbig2: number;
  jpx: number;
  /** Soft mask dictionaries (/S /Luminosity or /S /Alpha): drawing a page that uses one takes several page-sized
   *  canvases, so drawing pages of such a PDF is estimated higher. */
  softMasks: number;
}

const enc = (s: string) => new TextEncoder().encode(s);
const STREAM = enc('stream');
const ENDSTREAM = enc('endstream');
const ENDOBJ = enc('endobj');
const latin1 = new TextDecoder('latin1');
const MB = 1048576;
/**
 * Page content counts for the memory estimate without its padding: in a run of white space or zero bytes (PDF white
 * space), only the first PAD_RUN bytes count. Drawing and text operators are separated by a byte or two of white
 * space, so they count in full, while a stream of zeros, which readers skip without allocating, counts almost nothing.
 */
const PAD_RUN = 32;
const PDF_SPACE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) PDF_SPACE[c] = 1;

/** Where a PDF token ends: white space or a delimiter. */
const TOKEN_END = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32, 40, 41, 60, 62, 91, 93, 123, 125, 47, 37]) TOKEN_END[c] = 1;

// ---- Following forms. Bounds on the work and the memory it takes; past them the file is refused, not guessed at.
/** References kept, with the object each is in and its name; distinct names; references listed in arrays. */
const MAX_REFS = 2_000_000;
const MAX_NAMES = 200_000;
const MAX_LISTED = 2_000_000;
/** Names drawn, in forms and in page content. */
const MAX_DRAWN = 2_000_000;
/** Steps in working out what forms draw, and how deep forms may be drawn inside forms. */
const MAX_STEPS = 2_000_000;
const MAX_DEPTH = 500;
/** Costs stop growing here (no overflow), and a file whose forms come to REFUSE_AT bytes of content or more is refused:
 *  no device has the memory to read it. */
const SAT = 2 ** 60;
const REFUSE_AT = 2 ** 40;
/** One object's text is read whole up to OBJECT_TEXT bytes; a larger one in pieces that overlap by OVERLAP. */
const OBJECT_TEXT = 16 * MB;
const OVERLAP = 64 * 1024;
/** The most an object stream's header (its object numbers and offsets) is read to. */
const OBJSTM_HEAD = 8 * MB;
/** A font loaded again counts at least this: the standard font program pdf.js loads for Helvetica and Arial (Arimo). */
const STANDARD_FONT = 600 * 1024;
const sat = (n: number) => (n < SAT ? n : SAT);

const FORMS_UNMEASURABLE = 'This PDF draws its forms inside one another in a way FileConvert cannot measure (in a loop, or nested too deeply or too often), so it was not opened.';
const FORMS_TOO_MANY = 'This PDF draws forms inside forms so many times that reading it would take far more memory than any device has, so it was not opened.';
const REFS_TOO_MANY = 'This PDF holds more references than FileConvert follows to measure what its forms draw, so it was not opened.';

// PDF white space and comments between tokens, and a regular character (one that is not white space or a delimiter).
// A comment runs to the end of its line, so no text can be read as white space in two ways.
const SEP = String.raw`(?:[\0\t\n\f\r ]|%[^\r\n]*(?=[\r\n]|$))+`;
const REG = String.raw`[^\0\t\n\f\r /[\]<>(){}%]`;
/** A whole number as pdf.js reads one for a reference (12, +12, 12.0), and a generation. */
const OBJ_NUM = String.raw`\+?(\d+)(?:\.0*)?${SEP}[+-]?[\d.]+${SEP}R(?!${REG})`;
/** A name followed by an indirect reference: /Fm0 12 0 R. */
const NAME_REF = new RegExp(String.raw`/(${REG}+)${SEP}${OBJ_NUM}`, 'g');
/** An indirect reference: 12 0 R. */
const REF = new RegExp(OBJ_NUM, 'g');
/** An /Annots array (an /Annots key followed by "["). */
const ANNOTS = new RegExp(String.raw`/Annots(?:${SEP})?\[`, 'g');
const HEADER = /(\d+)\s+\d+\s+obj\b/g;
/** A character that is not PDF white space. */
const NOT_SPACE = /[^\0\t\n\f\r ]/;
/** Runs of zeros and of spaces, to compare decoded pieces with. */
const RUN = 65536;
const NULS = '\0'.repeat(RUN), SPACES = ' '.repeat(RUN);
/** The text is nothing but the character `run` is made of. */
const sameRun = (text: string, run: string) => {
  for (let i = 0; i < text.length; i += RUN) {
    const part = text.slice(i, i + RUN);
    if (part !== (part.length === RUN ? run : run.slice(0, part.length))) return false;
  }
  return true;
};

/** What a content stream draws by name: forms and pictures (Do), graphics states (gs, each time: one with a soft mask
 *  draws its mask's form every time it is set), and patterns (scn, SCN) and shadings (sh), each once however often
 *  (pdf.js keeps those while it reads one stream). */
interface Uses {
  drawn: Map<string, number>;
  gs: Map<string, number>;
  patterns: Set<string>;
  shadings: Set<string>;
}
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const usesOf = (u: Uses) => u.drawn.size + u.gs.size + u.patterns.size + u.shadings.size;

/**
 * Counts content bytes as it passes, leaving out padding, and what its operators draw by name (see Uses; a form or a
 * picture, a mask, a pattern: which, the resources say). A token is read only as far as telling them apart.
 */
class ContentCount implements Sink, Uses {
  n = 0;
  raw = 0;
  /** Do operators by the name before them. */
  readonly drawn = new Map<string, number>();
  readonly gs = new Map<string, number>();
  readonly patterns = new Set<string>();
  readonly shadings = new Set<string>();
  /** BT operators: the stream holds text. */
  texts = 0;
  private run = 0;
  private inName = false;
  private name = '';
  private lastName = '';
  private afterName = false;
  private tokLen = 0;
  private tok0 = 0;
  private tok1 = 0;
  private tok2 = 0;
  push(chunk: Uint8Array): void {
    let n = 0, run = this.run, tokLen = this.tokLen;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (PDF_SPACE[c]) {
        // White space ends any token; the whole run is taken at once (padding past PAD_RUN counts nothing, and a stream
        // of zeros is read as fast as it can be).
        if (this.inName) this.endName();
        else if (tokLen) { this.tokLen = tokLen; this.token(); tokLen = 0; }
        let j = i + 1;
        while (j < chunk.length && PDF_SPACE[chunk[j]]) j++;
        const len = j - i;
        if (run < PAD_RUN) n += Math.min(len, PAD_RUN - run);
        run += len;
        i = j - 1;
        continue;
      }
      run = 0;
      n++;
      if (this.inName) {
        if (!TOKEN_END[c]) { if (this.name.length < 384) this.name += String.fromCharCode(c); continue; }
        this.endName();
      }
      if (c === 47 || TOKEN_END[c]) {
        if (tokLen) { this.tokLen = tokLen; this.token(); tokLen = 0; }
        if (c === 47) { this.inName = true; this.name = ''; }
        continue;
      }
      if (tokLen === 0) this.tok0 = c;
      else if (tokLen === 1) this.tok1 = c;
      else if (tokLen === 2) this.tok2 = c;
      tokLen++;
    }
    this.tokLen = tokLen;
    this.n += n;
    this.raw += chunk.length;
    this.run = run;
  }
  /** A name ends: kept as readers compare names, for a Do after it. */
  private endName(): void {
    this.inName = false;
    this.lastName = normName(this.name);
    this.afterName = true;
  }
  /** A token other than a name ends: Do, gs, scn, SCN or sh right after a name uses it. */
  private token(): void {
    if (!this.tokLen) return;
    const n = this.tokLen, a = this.tok0, b = this.tok1, c = this.tok2;
    if (n === 2 && a === 66 && b === 84) this.texts++;
    else if (this.afterName) {
      if (n === 2 && a === 68 && b === 111) bump(this.drawn, this.lastName);
      else if (n === 2 && a === 103 && b === 115) bump(this.gs, this.lastName);
      else if (n === 2 && a === 115 && b === 104) this.shadings.add(this.lastName);
      else if (n === 3 && ((a === 115 && b === 99 && c === 110) || (a === 83 && b === 67 && c === 78))) this.patterns.add(this.lastName);
    }
    this.afterName = false;
    this.tokLen = 0;
  }
  end(): void {
    this.token();
    this.inName = false;
  }
}
const mb = (n: number) => `${Math.round(n / MB).toLocaleString('en-US')} MB`;

const FILTER_NAMES: Record<string, string> = {
  FlateDecode: 'Flate', Fl: 'Flate', LZWDecode: 'LZW', LZW: 'LZW', ASCIIHexDecode: 'AHx', AHx: 'AHx',
  ASCII85Decode: 'A85', A85: 'A85', RunLengthDecode: 'RL', RL: 'RL', DCTDecode: 'DCT', DCT: 'DCT',
  CCITTFaxDecode: 'CCF', CCF: 'CCF', JBIG2Decode: 'JBIG2', JPXDecode: 'JPX', Crypt: 'Crypt', BrotliDecode: 'Brotli', Br: 'Brotli',
};

function find(h: Uint8Array, n: Uint8Array, from: number): number {
  for (let i = h.indexOf(n[0], from); i >= 0 && i <= h.length - n.length; i = h.indexOf(n[0], i + 1)) {
    let k = 1;
    while (k < n.length && h[i + k] === n[k]) k++;
    if (k === n.length) return i;
  }
  return -1;
}

/** Counts what passes through, against one stream's limit and the file's total; then passes it on. */
class Counter implements Sink {
  count = 0;
  constructor(private scan: Scanner, private next: Sink | null, private what: string) {}
  push(chunk: Uint8Array): void {
    this.count += chunk.length;
    this.scan.add(chunk.length, this.count, this.what);
    this.next?.push(chunk);
  }
  end(): void { this.next?.end(); }
}

/** Keeps the first bytes that pass, for reading a picture's own header. */
class Head implements Sink {
  bytes = new Uint8Array(0);
  constructor(private max: number) {}
  push(chunk: Uint8Array): void {
    if (this.bytes.length >= this.max) return;
    const take = chunk.subarray(0, this.max - this.bytes.length);
    const joined = new Uint8Array(this.bytes.length + take.length);
    joined.set(this.bytes);
    joined.set(take, this.bytes.length);
    this.bytes = joined;
  }
  end(): void { /* nothing */ }
}

/** Looks for page dictionaries in the decoded text of an object stream, across piece boundaries. */
class PageCounter {
  pages = 0;
  softMasks = 0;
  contents = 0;
  signature = false;
  private tail = '';
  /** A longer tail for /Contents arrays, which are kept as a maximum, so seeing one twice does no harm. */
  private ctail = '';
  text(piece: string): void {
    const text = this.tail + piece;
    const long = this.ctail + piece;
    this.contents = Math.max(this.contents, mostContents(long));
    this.ctail = long.slice(-1024);
    this.pages += countPages(text);
    this.softMasks += countSoftMasks(text);
    if (/\/ByteRange|\/Type\s*\/Sig\b/.test(text)) this.signature = true;
    // Keep enough to see a key split between two pieces, without counting it twice.
    const cut = Math.max(0, text.length - 24);
    this.tail = text.slice(cut).replace(/^[^/]*/, '');
  }
}

/**
 * Reads an object stream's decoded data once: page dictionaries are counted in it (PageCounter), and each object in it
 * is handed to `onObject` whole, by the offsets in the stream's header, so what each holds is told apart by the object
 * it is in and no reference is cut in two. A header that cannot be read, or offsets out of order, make every object in
 * the stream uncertain (see Scanner.uncertain).
 */
class ObjStmObjects implements Sink {
  readonly pages = new PageCounter();
  private pos = 0;
  private head = '';
  /** Where each object starts in the decoded data, and the objects that start there. */
  private slots: Array<{ at: number; objs: number[] }> | null = null;
  private k = 0;
  private parts: string[] = [];
  private size = 0;
  private cut = false;
  private irregular = false;
  constructor(private first: number, private maxObjects: number, private onObject: (obj: number, text: string, uncertain: boolean) => void) {
    if (!(Number.isInteger(first) && first >= 0 && first <= OBJSTM_HEAD)) this.unreadable();
  }
  /** Everything after the header counts as one object of unknown number. */
  private unreadable(): void {
    this.irregular = true;
    this.slots = [{ at: 0, objs: [-1] }];
  }
  private readHead(): void {
    const pairs: Array<[number, number]> = [];
    let prev = -1, ordered = true, odd: number | null = null;
    for (const m of this.head.matchAll(/\d+/g)) {
      if (odd === null) { odd = Number(m[0]); continue; }
      const off = Number(m[0]);
      if (off <= prev) ordered = false;
      prev = off;
      pairs.push([this.first + off, odd]);
      odd = null;
      if (pairs.length > this.maxObjects) break;
    }
    this.head = '';
    if (!pairs.length || pairs.length > this.maxObjects) { this.unreadable(); return; }
    if (!ordered || odd !== null) this.irregular = true;
    pairs.sort((a, b) => a[0] - b[0]);
    const slots: Array<{ at: number; objs: number[] }> = [];
    for (const [at, obj] of pairs) {
      const last = slots[slots.length - 1];
      if (last && last.at === at) last.objs.push(obj);
      else slots.push({ at, objs: [obj] });
    }
    this.slots = slots;
  }
  push(chunk: Uint8Array): void {
    const piece = latin1.decode(chunk);
    this.pages.text(piece);
    let i = 0;
    if (!this.slots) {
      const take = Math.min(piece.length, this.first - this.pos);
      this.head += piece.slice(0, take);
      this.pos += take;
      i = take;
      if (this.pos < this.first) return;
      this.readHead();
    }
    const slots = this.slots!;
    while (i < piece.length && this.k < slots.length) {
      const s = slots[this.k];
      const end = this.k + 1 < slots.length ? slots[this.k + 1].at : Infinity;
      if (this.pos < s.at) {
        const skip = Math.min(piece.length - i, s.at - this.pos);
        i += skip;
        this.pos += skip;
        continue;
      }
      const take = Math.min(piece.length - i, end - this.pos);
      this.keep(i === 0 && take === piece.length ? piece : piece.slice(i, i + take));
      i += take;
      this.pos += take;
      if (this.pos >= end) { this.flush(); this.k++; }
    }
  }
  private keep(text: string): void {
    // White space reads the same however long it is (a line end kept, for comments), so padding is not held.
    const c0 = text.charCodeAt(0);
    if (text.length > 1 && PDF_SPACE[c0] && PDF_SPACE[text.charCodeAt(text.length - 1)]) {
      // A run of zeros or spaces, the usual padding, is told at memory speed; anything else by a search.
      if ((c0 === 0 || c0 === 32) && sameRun(text, c0 ? SPACES : NULS)) text = ' ';
      else if (!NOT_SPACE.test(text)) text = /[\r\n]/.test(text) ? '\n' : ' ';
    }
    this.parts.push(text);
    this.size += text.length;
    if (this.size <= OBJECT_TEXT) return;
    // An object larger than OBJECT_TEXT is read in overlapping pieces, and is uncertain.
    const all = this.parts.join('');
    this.cut = true;
    this.emit(all);
    this.parts = [all.slice(all.length - OVERLAP)];
    this.size = OVERLAP;
  }
  private emit(text: string): void {
    for (const obj of this.slots![this.k].objs) this.onObject(obj, text, this.irregular || this.cut);
  }
  private flush(): void {
    if (this.size) this.emit(this.parts.join(''));
    this.parts = [];
    this.size = 0;
    this.cut = false;
  }
  end(): void {
    if (!this.slots) this.readHead();
    if (this.slots && this.k < this.slots.length) this.flush();
  }
}

/**
 * The references in the file's objects: for each, the object it is in (-1 outside any), its name, and the object it
 * refers to. Kept in flat arrays, so a file with a million references holds a few megabytes for them.
 */
class RefStore {
  obj = new Int32Array(4096);
  name = new Int32Array(4096);
  target = new Int32Array(4096);
  n = 0;
  readonly ids = new Map<string, number>();
  readonly names: string[] = [];
  overflow = false;
  add(obj: number, name: string, target: number): void {
    if (target > 0x7fffffff || obj > 0x7fffffff) return;
    if (this.n >= MAX_REFS) { this.overflow = true; return; }
    let id = this.ids.get(name);
    if (id === undefined) {
      if (this.names.length >= MAX_NAMES) { this.overflow = true; return; }
      id = this.names.length;
      this.ids.set(name, id);
      this.names.push(name);
    }
    if (this.n === this.obj.length) {
      const grow = (a: Int32Array) => { const b = new Int32Array(a.length * 2); b.set(a); return b; };
      this.obj = grow(this.obj);
      this.name = grow(this.name);
      this.target = grow(this.target);
    }
    this.obj[this.n] = obj;
    this.name[this.n] = id;
    this.target[this.n] = target;
    this.n++;
  }
  /** The references grouped by a key (their object, or their name): each group's positions in `at`, from start to end. */
  group(keys: Int32Array): { at: Int32Array; span: Map<number, [number, number]> } {
    const count = new Map<number, number>();
    for (let i = 0; i < this.n; i++) count.set(keys[i], (count.get(keys[i]) ?? 0) + 1);
    const span = new Map<number, [number, number]>();
    let s = 0;
    for (const [k, c] of count) { span.set(k, [s, s]); s += c; }
    const at = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) { const g = span.get(keys[i])!; at[g[1]++] = i; }
    return { at, span };
  }
}

/**
 * Where a form's names are looked up: its own resources (in its dictionary, with any of their kinds given as objects
 * of their own in `also`, or an object of their own), the resources it is drawn with (it has none of its own), or any
 * object in the file (its dictionary could not be read). The names of every kind that draws (XObject, ExtGState,
 * Pattern, Shading) are taken together: more than any one kind holds, never less.
 */
type Scope = { kind: 'inherit' } | { kind: 'global' } | { kind: 'own'; names: Map<string, number[]>; also: number[] } | { kind: 'res'; ref: number };
const KINDS = ['XObject', 'ExtGState', 'Pattern', 'Shading'];

/** A form XObject, a tiling pattern or a mesh shading (or a stream whose dictionary could not be read, which pdf.js
 *  may still read as a form): what pdf.js reads again each time one is drawn. */
interface FormNode extends Uses {
  id: number;
  obj: number;
  /** Content bytes without padding (a shading's data in full), and whether it holds text. */
  n: number;
  texts: boolean;
  /** Fonts in its own resources written out in full (not as objects of their own), of them Type 3 fonts: pdf.js loads
   *  each again every time the form is drawn. */
  fonts: number;
  type3: number;
  scope: Scope;
  /** The scope's key once worked out: null for one it is drawn with. */
  key: string | null;
  /** A form by its dictionary (not one whose dictionary could not be read, nor a pattern or shading). */
  form: boolean;
}
const NO_NODES: FormNode[] = [];
const NO_REFS: number[] = [];
const NO_USES: Uses = { drawn: new Map(), gs: new Map(), patterns: new Set(), shadings: new Set() };

/** A form's scope, from its /Resources, and the fonts written out in full in them. */
function scopeOf(res: PdfValue | undefined): { scope: Scope; fonts: number; type3: number } {
  if (isRef(res)) return { scope: { kind: 'res', ref: res.ref[0] }, fonts: 0, type3: 0 };
  if (!isDict(res)) return { scope: { kind: 'inherit' }, fonts: 0, type3: 0 };
  const d = res as PdfDict;
  const names = new Map<string, number[]>(), also: number[] = [];
  const put = (k: string, o: number) => { const l = names.get(k); if (l) l.push(o); else names.set(k, [o]); };
  for (const kind of KINDS) {
    const c = d[kind];
    if (isRef(c)) { also.push(c.ref[0]); continue; }
    if (!isDict(c)) continue;
    for (const [k, v] of Object.entries(c as PdfDict)) {
      if (isRef(v)) { put(k, v.ref[0]); continue; }
      if (!isDict(v)) continue;
      // A graphics state written out in full: its soft mask (or the mask's form); a shading pattern: its shading.
      const g = v as PdfDict, sm = g.SMask;
      if (isRef(sm)) put(k, sm.ref[0]);
      else if (isDict(sm) && isRef((sm as PdfDict).G)) put(k, ((sm as PdfDict).G as { ref: [number, number] }).ref[0]);
      if (isRef(g.Shading)) put(k, g.Shading.ref[0]);
    }
  }
  let fonts = 0, type3 = 0;
  if (isDict(d.Font)) {
    for (const v of Object.values(d.Font as PdfDict)) {
      if (!isDict(v)) continue;
      fonts++;
      if (isName((v as PdfDict).Subtype, 'Type3')) type3++;
    }
  }
  return { scope: { kind: 'own', names, also }, fonts, type3 };
}

const countPages = (text: string) => (text.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g) ?? []).length;
/** The most references in one /Contents array in this text. */
const mostContents = (text: string) => {
  let most = 0;
  for (const m of text.matchAll(/\/Contents\s*\[([^\]]*)\]/g)) most = Math.max(most, (m[1].match(/\d+\s+\d+\s+R/g) ?? []).length);
  return most;
};
const countSoftMasks = (text: string) => (text.match(/\/S\s*\/(?:Luminosity|Alpha)(?![A-Za-z0-9])/g) ?? []).length;

/** The references in the array that starts at text[i] ("["), up to its own "]", reading strings and comments as a
 *  reader does (to the end of the text when it has none). */
function refsIn(text: string, i: number): number[] {
  let depth = 0, end = text.length;
  scan: for (let j = i; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 40) {
      for (let level = 0; j < text.length; j++) {
        const x = text.charCodeAt(j);
        if (x === 92) j++;
        else if (x === 40) level++;
        else if (x === 41 && --level === 0) break;
      }
    } else if (c === 37) {
      while (j < text.length && text.charCodeAt(j) !== 10 && text.charCodeAt(j) !== 13) j++;
    } else if (c === 91) depth++;
    else if (c === 93 && --depth === 0) { end = j + 1; break scan; }
  }
  const out: number[] = [];
  for (const m of text.slice(i, end).matchAll(REF)) out.push(Number(m[1]));
  return out;
}

/** The width and height in a JPEG's frame header, or null. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** The image size in a JPEG 2000 codestream's SIZ marker (bare, or inside a JP2 file), or null. */
export function jpxSize(b: Uint8Array): { width: number; height: number } | null {
  const at = find(b, new Uint8Array([0xff, 0x4f, 0xff, 0x51]), 0);
  if (at < 0 || at + 22 > b.length) return null;
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const xsiz = u32(at + 8), ysiz = u32(at + 12), x0 = u32(at + 16), y0 = u32(at + 20);
  return { width: Math.max(0, xsiz - x0), height: Math.max(0, ysiz - y0) };
}

class Scanner {
  decoded = 0;
  objectStreamBytes = 0;
  fed = 0;
  report: PdfScan = {
    version: null, encrypted: false, objects: 0, pages: 0, streams: 0, objectStreams: 0, decodedBytes: 0, textBytes: 0,
    objectStreamBytes: 0, largestStream: 0, contentBytes: 0, largestContent: 0, formExpansion: 0, textFormExpansion: 0, annotExpansion: 0, formFontBytes: 0, maskDraws: 0, editFormExpansion: 0,
    rawContent: 0, largestRawContent: 0, maxContents: 1, fontBytes: 0, images: 0, largestImagePixels: 0, largestJpxPixels: 0, signatureHint: false, jbig2: 0, jpx: 0, softMasks: 0,
  };
  /** For following forms: the references in every object, the forms by object number, what page content draws
   *  (stream by stream, and in all), what every Do anywhere draws (for editing), and the arrays the file holds as
   *  objects of their own and in /Annots keys. */
  private refs = new RefStore();
  private nodes = new Map<number, FormNode[]>();
  private nodeCount = 0;
  private drawnCount = 0;
  private drawnOverflow = false;
  private pageUses: Uses[] = [];
  private pageUsesCount = 0;
  private pageStreams = 0;
  private pageOverflow = false;
  /** What all page content uses together (patterns and shadings: once each, as for one page). */
  private topUses: Uses = { drawn: new Map(), gs: new Map(), patterns: new Set(), shadings: new Set() };
  private flatDrawn = new Map<string, number>();
  /** The largest embedded font program, decoded. */
  private largestFont = 0;
  private arrays = new Map<number, number[]>();
  private annots: number[][] = [];
  private listed = 0;
  /** Objects whose text could not be told apart from others' (an object stream with an unreadable header or offsets
   *  out of order, or an object too large to read whole): a form never takes its names from one of these. */
  private uncertain = new Set<number>();
  /** The object number of the stream being measured, from its header, and whether its dictionary could be read. */
  private objNum = -1;
  private unread = false;
  /** The last object header in the text examineText last read: its object number, and where the header ends. */
  private lastHead: [number, number] | null = null;
  constructor(private b: Uint8Array, private L: PdfLimits) {}

  /** Notes what one object's text holds: references with names, /Annots arrays, and the references in the object when
   *  it is an array. */
  scanObject(obj: number, text: string, uncertain: boolean): void {
    if (uncertain && obj >= 0) this.uncertain.add(obj);
    for (const m of text.matchAll(NAME_REF)) this.refs.add(obj, normName(m[1]), Number(m[2]));
    if (text.includes('/Annots')) for (const m of text.matchAll(ANNOTS)) this.list(this.annots, refsIn(text, (m.index ?? 0) + m[0].length - 1));
    if (obj >= 0) {
      const s = text.search(NOT_SPACE);
      if (s >= 0 && text.charCodeAt(s) === 91) {
        const refs = refsIn(text, s);
        const had = this.arrays.get(obj);
        if (had) { this.listed += refs.length; had.push(...refs.slice(0, Math.max(0, MAX_LISTED - this.listed))); }
        else this.list(null, refs, obj);
      }
    }
  }

  private list(to: number[][] | null, refs: number[], obj = -1): void {
    this.listed += refs.length;
    if (this.listed > MAX_LISTED) { this.refs.overflow = true; return; }
    if (to) to.push(refs);
    else this.arrays.set(obj, refs);
  }

  /** Called for every decoded piece: checks one stream's size and the file's total. */
  add(n: number, streamSoFar: number, what: string): void {
    this.decoded += n;
    if (streamSoFar > this.report.largestStream) this.report.largestStream = streamSoFar;
    if (streamSoFar > this.L.pdfStreamBytes) throw new LimitError(`This PDF has ${what} that expands past ${mb(this.L.pdfStreamBytes)} when decompressed, far more than a document needs, so it was not opened (a "decompression bomb" makes a small file use gigabytes of memory).`);
    if (this.decoded > this.L.pdfDecodedBytes) throw new LimitError(`This PDF's compressed data expands past ${mb(this.L.pdfDecodedBytes)} in all, the limit, so it was not opened.`);
  }

  run(): PdfScan {
    const b = this.b;
    if (b.length > this.L.pdfBytes) throw new LimitError(`The PDF is larger than ${mb(this.L.pdfBytes)}, the limit.`);
    const head = latin1.decode(b.subarray(0, 1024));
    const v = /%PDF-(\d\.\d)/.exec(head);
    this.report.version = v ? v[1] : null;
    let text = 0; // start of the text not yet examined (outside stream data)
    for (let at = find(b, STREAM, 0); at >= 0; at = find(b, STREAM, at + 1)) {
      // "endstream", or "stream" inside a word, is not a stream keyword.
      if (at >= 3 && b[at - 3] === 101 && b[at - 2] === 110 && b[at - 1] === 100) continue;
      const after = b[at + 6];
      if (after !== 10 && after !== 13 && after !== 32) continue;
      if (at < text) continue;
      this.examineText(text, at);
      const start = at + 6 + (after === 13 && b[at + 7] === 10 ? 2 : 1);
      const dict = this.dictBefore();
      const end = this.stream(dict, start);
      text = end;
      at = Math.max(at, end - 1);
    }
    this.examineText(text, b.length);
    this.report.decodedBytes = this.decoded;
    this.report.objectStreamBytes = this.objectStreamBytes;
    if (this.report.objects > this.L.pdfObjects) throw new LimitError(`This PDF has ${this.report.objects.toLocaleString('en-US')} objects; the limit is ${this.L.pdfObjects.toLocaleString('en-US')}.`);
    if (this.report.pages > this.L.pdfPages) throw new LimitError(`This PDF has ${this.report.pages.toLocaleString('en-US')} pages; the limit is ${this.L.pdfPages.toLocaleString('en-US')}.`);
    this.measureForms();
    return this.report;
  }

  /**
   * What forms make pdf.js read, once the whole file has been read (forms, and the resources that name them, can be
   * anywhere in it). See formExpansion, textFormExpansion, annotExpansion, formFontBytes and editFormExpansion.
   *
   * pdf.js reads a form's content again each time it is drawn, and with it what the form uses: the forms inside it
   * (Do), the form of a soft mask each time a graphics state with one is set (gs), each pattern and shading it paints
   * with (scn, SCN, sh: once per drawing), and each font written out in full in its own resources (loaded again). So a
   * form drawn 1,000 times that draws another 1,000 times reads the inner one a million times. A form takes its names
   * from its own resources, or from the resources it is drawn with when it has none; page content takes them from
   * anywhere in the file (a name that refers to several counts the costliest). pdf.js skips a form that is already
   * being drawn further up, so forms that draw each other in a loop are worked out path by path, as it reads them,
   * within a number of steps; past that, or nested deeper than MAX_DEPTH, the file is refused.
   */
  private measureForms(): void {
    const r = this.report, refs = this.refs, nodes = this.nodes;
    const contentsId = refs.ids.get('Contents');
    // A /Contents array that is an object of its own bounds one page's streams too.
    if (contentsId !== undefined) {
      for (let i = 0; i < refs.n; i++) {
        if (refs.name[i] !== contentsId) continue;
        const a = this.arrays.get(refs.target[i]);
        if (a && a.length > r.maxContents) r.maxContents = a.length;
      }
    }
    if (!nodes.size) return;
    if (refs.overflow || this.drawnOverflow) throw new LimitError(REFS_TOO_MANY);
    const byObj = refs.group(refs.obj), byName = refs.group(refs.name);
    const globals = new Map<string, number[]>();
    /** The objects a name refers to anywhere in the file. */
    const globalOf = (name: string): number[] => {
      let out = globals.get(name);
      if (out) return out;
      const id = refs.ids.get(name), g = id === undefined ? undefined : byName.span.get(id);
      const set = new Set<number>();
      if (g) for (let j = g[0]; j < g[1]; j++) set.add(refs.target[byName.at[j]]);
      out = [...set];
      globals.set(name, out);
      return out;
    };
    /** The names in one object and what they refer to; null when it is not known or is uncertain. */
    const fromObj = (o: number): Map<string, number[]> | null => {
      const g = byObj.span.get(o);
      if (!g || this.uncertain.has(o)) return null;
      const m = new Map<string, number[]>();
      for (let j = g[0]; j < g[1]; j++) {
        const i = byObj.at[j], name = refs.names[refs.name[i]];
        const l = m.get(name);
        if (l) l.push(refs.target[i]); else m.set(name, [refs.target[i]]);
      }
      return m;
    };

    // ---- Each form's scope: 'G' for anywhere in the file, null for the one it is drawn with.
    const scopes = new Map<string, Map<string, number[]>>();
    const keyOf = (d: FormNode): string | null => {
      const s = d.scope;
      if (s.kind === 'inherit') return null;
      if (s.kind === 'global') return 'G';
      const key = s.kind === 'own' ? `n${d.id}` : `r${s.ref}`;
      if (scopes.has(key)) return key;
      let map: Map<string, number[]> | null;
      const also: number[] = [];
      if (s.kind === 'own') { map = new Map(s.names); also.push(...s.also); }
      else {
        map = fromObj(s.ref);
        // Kinds of resource given as objects of their own: their names too.
        if (map) for (const kind of KINDS) also.push(...(map.get(kind) ?? NO_REFS));
      }
      for (const x of also) {
        const m = map && fromObj(x);
        if (!m) { map = null; break; }
        for (const [k, v] of m) map!.set(k, [...(map!.get(k) ?? NO_REFS), ...v]);
      }
      // Resources the guard cannot read are looked up anywhere in the file: more than they hold, never less.
      if (!map) return 'G';
      scopes.set(key, map);
      return key;
    };
    for (const defs of nodes.values()) for (const d of defs) d.key = keyOf(d);
    const lookup = (key: string, name: string): number[] => key === 'G' ? globalOf(name) : scopes.get(key)!.get(name) ?? NO_REFS;

    // ---- What a name each operator uses may draw: a form or picture (Do), the form of a graphics state's soft mask
    // (gs), a tiling pattern or a shading pattern's mesh (scn, SCN), a mesh shading (sh).
    type Op = 'Do' | 'gs' | 'pat' | 'sh';
    const gId = refs.ids.get('G'), smaskId = refs.ids.get('SMask'), shadingId = refs.ids.get('Shading');
    const reached = new Map<string, number[]>();
    const reach = (op: Op, scope: string, name: string): number[] => {
      const k = `${op}\u0000${scope}\u0000${name}`;
      let out = reached.get(k);
      if (out) return out;
      const set = new Set<number>();
      for (const o of lookup(scope, name)) {
        if (nodes.has(o)) { set.add(o); continue; }
        if (op === 'Do' || op === 'sh') continue;
        // A graphics state (its /SMask, and the mask's /G) or a shading pattern (its /Shading): one or two objects on.
        const via = [o];
        for (let v = 0; v < via.length && v < 8; v++) {
          const g = byObj.span.get(via[v]);
          if (!g) continue;
          for (let j = g[0]; j < g[1]; j++) {
            const i = byObj.at[j], t = refs.target[i], nm = refs.name[i];
            if (op === 'gs' ? nm !== gId && nm !== smaskId : nm !== shadingId) continue;
            if (nodes.has(t)) set.add(t);
            else if (v === 0) via.push(t);
          }
        }
      }
      out = [...set];
      reached.set(k, out);
      return out;
    };

    // ---- Editing: each Do anywhere times the largest form its name refers to anywhere (the cleanup reads each once).
    let flat = 0;
    for (const [name, n] of this.flatDrawn) {
      let size = 0;
      for (const o of globalOf(name)) for (const d of nodes.get(o) ?? NO_NODES) if (d.form && d.n > size) size = d.n;
      flat = sat(flat + n * size);
    }
    r.editFormExpansion = flat;

    // ---- Annotations: the forms each entry in an /Annots array may draw (the entry itself, the forms its own object
    // names, and those in an appearance dictionary or the appearance states under /N that are objects of their own).
    const apId = refs.ids.get('AP'), nId = refs.ids.get('N'), annotsId = refs.ids.get('Annots');
    const occurrences: number[][] = [...this.annots];
    if (annotsId !== undefined) {
      for (let i = 0; i < refs.n; i++) {
        if (refs.name[i] !== annotsId) continue;
        const a = this.arrays.get(refs.target[i]);
        if (a) occurrences.push(a);
      }
    }
    const drawsFrom = new Map<number, number[]>();
    const apForms = new Set<number>();
    const candidates = (e: number): number[] => {
      let out = drawsFrom.get(e);
      if (out) return out;
      const set = new Set<number>();
      if (nodes.has(e)) set.add(e);
      const via = [e];
      for (let k = 0; k < via.length && k < 64; k++) {
        const g = byObj.span.get(via[k]);
        if (!g) continue;
        for (let j = g[0]; j < g[1]; j++) {
          const i = byObj.at[j], t = refs.target[i];
          if (nodes.has(t)) set.add(t);
          else if ((refs.name[i] === apId && k === 0) || refs.name[i] === nId) via.push(t);
        }
      }
      out = [...set];
      for (const o of out) apForms.add(o);
      drawsFrom.set(e, out);
      return out;
    };
    for (const occ of occurrences) for (const e of occ) candidates(e);

    // ---- Forms nothing draws (a form no page uses, say): what they draw counts once, as before.
    const targeted = new Set<number>();
    const mark = (u: Uses, scope: string) => {
      for (const name of u.drawn.keys()) for (const o of reach('Do', scope, name)) targeted.add(o);
      for (const name of u.gs.keys()) for (const o of reach('gs', scope, name)) targeted.add(o);
      for (const name of u.patterns) for (const o of reach('pat', scope, name)) targeted.add(o);
      for (const name of u.shadings) for (const o of reach('sh', scope, name)) targeted.add(o);
    };
    mark(this.topUses, 'G');
    for (const defs of nodes.values()) for (const d of defs) mark(d, d.key ?? 'G');

    // A font written out in full is loaded again each time: as large as a standard font's program, or as the largest
    // program in the file; a Type 3 font also reads its glyphs' content, at most all the content in the file.
    const fontLoad = Math.max(STANDARD_FONT, this.largestFont);
    /** Content read in all, content of forms with text (what reading text goes through), font programs loaded, and
     *  soft masks set (each takes page-sized canvases while the page is drawn). */
    type Cost = [number, number, number, number];
    const ZERO: Cost = [0, 0, 0, 0];
    const CYCLE = new Error('forms drawn in a loop');
    /** What drawing a form (or the costliest form a name may draw) costs. With `paths`, a form already being drawn
     *  further up counts nothing, as in pdf.js, and nothing below the top is kept. */
    const evaluator = (paths: boolean) => {
      let steps = 0;
      const memo = new Map<string, Cost>(), bests = new Map<string, Cost>(), stack = new Set<number>();
      /** What the uses of a stream or form cost, its names looked up in `scope`; patterns and shadings `once` times. */
      const usesCost = (u: Uses, scope: string, depth: number, once = 1): Cost => {
        let t = 0, x = 0, f = 0, m = 0;
        for (const [name, c] of u.drawn) {
          const [bt, bx, bf, bm] = best('Do', scope, name, depth);
          t = sat(t + c * bt); x = sat(x + c * bx); f = sat(f + c * bf); m = sat(m + c * bm);
        }
        for (const [name, c] of u.gs) {
          const [bt, , bf, bm] = best('gs', scope, name, depth);
          const masked = reach('gs', scope, name).length ? 1 : 0;
          t = sat(t + c * bt); f = sat(f + c * bf); m = sat(m + c * (masked + bm));
        }
        for (const [op, names] of [['pat', u.patterns], ['sh', u.shadings]] as const) {
          for (const name of names) {
            const [bt, , bf, bm] = best(op, scope, name, depth);
            t = sat(t + once * bt); f = sat(f + once * bf); m = sat(m + once * bm);
          }
        }
        return [t, x, f, m];
      };
      const visit = (d: FormNode, inh: string, depth: number): Cost => {
        const scope = d.key ?? inh;
        const k = d.key === null ? `${d.id}@${inh}` : `${d.id}`;
        const keep = !paths || stack.size === 0;
        if (keep) { const hit = memo.get(k); if (hit) return hit; }
        if (stack.has(d.obj)) { if (paths) return ZERO; throw CYCLE; }
        if (depth > MAX_DEPTH) throw new LimitError(FORMS_UNMEASURABLE);
        stack.add(d.obj);
        const [t, x, f, m] = usesCost(d, scope, depth + 1);
        stack.delete(d.obj);
        const out: Cost = [sat(d.n + d.type3 * r.contentBytes + t), sat((d.texts ? d.n : 0) + x), sat((d.fonts + d.type3) * fontLoad + f), m];
        if (keep) memo.set(k, out);
        return out;
      };
      const best = (op: Op, scope: string, name: string, depth: number): Cost => {
        const k = `${op}\u0000${scope}\u0000${name}`;
        const keep = !paths || stack.size === 0;
        if (keep) { const hit = bests.get(k); if (hit) return hit; }
        const out: Cost = [0, 0, 0, 0];
        for (const o of reach(op, scope, name)) {
          for (const e of nodes.get(o) ?? NO_NODES) {
            if (++steps > MAX_STEPS) throw new LimitError(FORMS_UNMEASURABLE);
            const v = visit(e, scope, depth);
            for (let i = 0; i < 4; i++) if (v[i] > out[i]) out[i] = v[i];
          }
        }
        if (keep) bests.set(k, out);
        return out;
      };
      return { page: (u: Uses, once: number) => usesCost(u, 'G', 0, once), form: (d: FormNode) => visit(d, 'G', 0) };
    };

    const measure = (E: ReturnType<typeof evaluator>) => {
      // Page content, stream by stream, then the forms nothing draws; then annotations, /Annots array by /Annots array
      // (each entry draws the costliest form it may draw). Each part is kept in all, and for the costliest stream.
      const part = () => [0, 0];
      const pages = { t: part(), x: part(), f: part(), m: part() }, annots = { t: part(), f: part(), m: part() };
      const add = (into: number[], v: number) => { into[0] = sat(into[0] + v); if (v > into[1]) into[1] = v; };
      const streams = this.pageOverflow ? [this.topUses] : this.pageUses;
      for (const u of streams) {
        const [t, x, f, m] = E.page(u, this.pageOverflow ? this.pageStreams : 1);
        add(pages.t, t); add(pages.x, x); add(pages.f, f); add(pages.m, m);
      }
      for (const defs of nodes.values()) {
        for (const d of defs) {
          if (targeted.has(d.obj) || apForms.has(d.obj)) continue;
          const [t, x, f] = E.form(d);
          add(pages.t, t - d.n); add(pages.x, x - (d.texts ? d.n : 0)); add(pages.f, f - (d.fonts + d.type3) * fontLoad);
        }
      }
      const each = new Map<number, Cost>();
      for (const occ of occurrences) {
        let t = 0, f = 0, m = 0;
        for (const e of occ) {
          let c = each.get(e);
          if (!c) {
            c = [0, 0, 0, 0];
            for (const o of drawsFrom.get(e) ?? NO_REFS) for (const d of nodes.get(o) ?? NO_NODES) { const v = E.form(d); if (v[0] > c[0] || v[3] > c[3]) c = [Math.max(c[0], v[0]), 0, Math.max(c[2], v[2]), Math.max(c[3], v[3])]; }
            each.set(e, c);
          }
          t = sat(t + c[0]); f = sat(f + c[2]); m = sat(m + c[3]);
        }
        add(annots.t, t); add(annots.f, f); add(annots.m, m);
      }
      // The 50 pages pdf.js holds are the costliest: at most 50 pages of the costliest streams (a page may have several).
      // Soft masks take their canvases while a page is drawn, and the browser still holds the page before's: the
      // costliest page's, twice.
      const held = ([total, one]: number[], per: number) => Math.min(total, sat(RENDER_KEPT_PAGES * per * one));
      const mc = r.maxContents;
      return {
        forms: held(pages.t, mc), text: held(pages.x, mc), annots: held(annots.t, 1), fonts: sat(held(pages.f, mc) + held(annots.f, 1)),
        masks: sat(Math.min(pages.m[0], 2 * pages.m[1] * mc) + Math.min(annots.m[0], 2 * annots.m[1])),
      };
    };
    let out: ReturnType<typeof measure>;
    try {
      out = measure(evaluator(false));
    } catch (e) {
      if (e !== CYCLE) throw e;
      out = measure(evaluator(true));
    }
    r.formExpansion = out.forms;
    r.textFormExpansion = out.text;
    r.annotExpansion = out.annots;
    r.formFontBytes = out.fonts;
    r.maskDraws = out.masks;
    if (out.forms + out.annots + out.fonts >= REFUSE_AT) throw new LimitError(FORMS_TOO_MANY);
  }

  /** Text between streams: object headers, page dictionaries, trailers; and each object in it, read for what it holds. */
  private examineText(from: number, to: number): void {
    if (to <= from) return;
    this.report.textBytes += to - from;
    // Object headers: object number, where the header starts, where it ends.
    const heads: number[] = [];
    let whole = '';
    // Large text regions are read in pieces that overlap a little, so a key is never cut in two.
    for (let p = from; p < to; p += 4 * MB) {
      const text = latin1.decode(this.b.subarray(p, Math.min(to, p + 4 * MB + 64)));
      if (p === from && to - from <= 4 * MB + 64) whole = text;
      const own = p + 4 * MB >= to ? text : text.slice(0, 4 * MB);
      for (const m of text.matchAll(HEADER)) if ((m.index ?? 0) < own.length) heads.push(Number(m[1]), p + (m.index ?? 0), p + (m.index ?? 0) + m[0].length);
      this.report.pages += countPages(own);
      this.report.maxContents = Math.max(this.report.maxContents, mostContents(text));
      this.report.softMasks += countSoftMasks(own);
      if (/\/ByteRange|\/Type\s*\/Sig\b/.test(text)) this.report.signatureHint = true;
      for (const m of text.matchAll(/trailer\s*<</g)) {
        const d = this.readDict(p + (m.index ?? 0) + m[0].length - 2);
        if (d && 'Encrypt' in d) this.report.encrypted = true;
      }
    }
    this.report.objects += heads.length / 3;
    this.lastHead = heads.length ? [heads[heads.length - 3], heads[heads.length - 1]] : null;
    // Each object runs from its header to its "endobj" (or the next header, or the stream it holds).
    for (let i = 0; i < heads.length; i += 3) {
      const start = heads[i + 2], limit = i + 3 < heads.length ? heads[i + 4] : to;
      const e = find(this.b.subarray(start, limit), ENDOBJ, 0);
      const end = e < 0 ? limit : start + e;
      if (whole) this.scanObject(heads[i], whole.slice(start - from, end - from), false);
      else if (end - start <= OBJECT_TEXT) this.scanObject(heads[i], latin1.decode(this.b.subarray(start, end)), false);
      else for (let p = start; p < end; p += OBJECT_TEXT - OVERLAP) this.scanObject(heads[i], latin1.decode(this.b.subarray(p, Math.min(end, p + OBJECT_TEXT))), true);
    }
  }

  private readDict(pos: number): PdfDict | null {
    try {
      const v = new ObjReader(this.b, pos, Math.min(this.b.length, pos + 1 * MB)).read();
      return isDict(v) ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * The dictionary in front of a "stream" keyword: read forward from the last object header in the text since the end
   * of the previous stream (examineText has just found it), however far back that is.
   */
  private dictBefore(): PdfDict {
    this.objNum = this.lastHead ? this.lastHead[0] : -1;
    this.unread = false;
    if (!this.lastHead) return {};
    const d = this.readDict(this.lastHead[1]);
    if (!d) this.unread = true;
    return d ?? {};
  }

  private addNode(obj: number, c: { n: number; texts: number }, u: Uses, scope: Scope, form: boolean, fonts: number, type3: number): void {
    this.drawnCount += usesOf(u);
    if (this.drawnCount > MAX_DRAWN) this.drawnOverflow = true;
    const uses = this.drawnOverflow ? NO_USES : { drawn: u.drawn, gs: u.gs, patterns: u.patterns, shadings: u.shadings };
    const d: FormNode = { id: this.nodeCount++, obj, n: c.n, texts: c.texts > 0, ...uses, fonts, type3, scope, key: null, form };
    const defs = this.nodes.get(obj);
    if (defs) defs.push(d); else this.nodes.set(obj, [d]);
  }

  /** What one page content stream draws: kept stream by stream (past MAX_DRAWN names, only in all). */
  private addPageUses(c: Uses): void {
    const t = this.topUses;
    for (const [name, n] of c.drawn) t.drawn.set(name, (t.drawn.get(name) ?? 0) + n);
    for (const [name, n] of c.gs) t.gs.set(name, (t.gs.get(name) ?? 0) + n);
    for (const name of c.patterns) t.patterns.add(name);
    for (const name of c.shadings) t.shadings.add(name);
    this.pageStreams++;
    if (this.pageOverflow) return;
    this.pageUsesCount += usesOf(c);
    if (this.pageUsesCount > MAX_DRAWN) { this.pageOverflow = true; this.pageUses = []; return; }
    this.pageUses.push({ drawn: c.drawn, gs: c.gs, patterns: c.patterns, shadings: c.shadings });
  }

  /** Measures one stream; returns where the text after it starts. */
  private stream(dict: PdfDict, start: number): number {
    const b = this.b;
    const r = this.report;
    r.streams++;
    // Where the data ends, for continuing the scan: its /Length when "endstream" follows it, else the next "endstream".
    const len = num(dict.Length);
    let end = -1;
    if (len !== null && len >= 0 && start + len <= b.length) {
      let e = start + len;
      while (e < b.length && (b[e] === 10 || b[e] === 13 || b[e] === 32)) e++;
      if (find(b.subarray(e, e + 9), ENDSTREAM, 0) === 0) end = e + 9;
    }
    if (end < 0) {
      const e = find(b, ENDSTREAM, start);
      end = e < 0 ? b.length : e + 9;
    }
    const type = isName(dict.Type) ? dict.Type.name : '';
    if (type === 'XRef' && 'Encrypt' in dict) r.encrypted = true;
    if (type === 'XRef') {
      const index = Array.isArray(dict.Index) ? dict.Index : [0, num(dict.Size) ?? 0];
      let entries = 0;
      for (let i = 1; i < index.length; i += 2) entries += Math.max(0, num(index[i]) ?? 0);
      if (entries > this.L.pdfObjects * 4) throw new LimitError(`This PDF's cross-reference stream claims ${entries.toLocaleString('en-US')} entries, far more than the file holds, so it was not opened.`);
    }
    const objstm = type === 'ObjStm';
    if (objstm) {
      r.objectStreams++;
      r.objects += Math.max(0, num(dict.N) ?? 0);
    }
    const image = isName(dict.Subtype, 'Image');
    if (image) {
      r.images++;
      const w = num(dict.Width), h = num(dict.Height);
      if (w !== null && h !== null) this.picture(w, h, 'dictionary');
    }
    if (num(dict.FunctionType) === 0 && Array.isArray(dict.Size)) {
      let samples = 1;
      for (const s of dict.Size) samples *= Math.max(1, num(s) ?? 1);
      samples *= Math.max(1, Array.isArray(dict.Range) ? dict.Range.length / 2 : 1);
      if (samples > this.L.pdfFunctionSamples) throw new LimitError(`This PDF has a sampled function with ${samples.toLocaleString('en-US')} samples; the limit is ${this.L.pdfFunctionSamples.toLocaleString('en-US')}, so it was not opened.`);
    }
    const filters = this.filters(dict);
    if (filters.some(f => f.name === 'Brotli')) throw new Error('This PDF uses Brotli compression, which FileConvert does not open.');
    const what = objstm ? 'an object stream' : image ? 'a picture' : 'a stream';
    // The stages, last first: a counter at the end, the image codec's header reader if there is one.
    const CODECS = ['DCT', 'JPX', 'JBIG2', 'CCF'];
    if (filters.slice(0, -1).some(f => CODECS.includes(f.name))) throw new Error('This PDF uses an unusual chain of compression filters (a picture codec followed by another filter), so it was not opened.');
    const codec = filters.length && CODECS.includes(filters[filters.length - 1].name) ? filters[filters.length - 1] : null;
    const expanding = filters.slice(0, codec ? -1 : undefined).filter(f => f.name !== 'Crypt');
    if (codec?.name === 'JBIG2') r.jbig2++;
    if (codec?.name === 'JPX') r.jpx++;
    if (codec?.name === 'CCF') this.row(num(codec.parms.Columns) ?? 1728, 1, 1, 'a fax picture');
    const headSink = codec && (codec.name === 'DCT' || codec.name === 'JPX') ? new Head(256 * 1024) : null;
    const objects = objstm ? new ObjStmObjects(num(dict.First) ?? -1, this.L.pdfObjects, (o, t, u) => this.scanObject(o, t, u)) : null;
    const pages = objects?.pages;
    // A font program (FontFile, FontFile2, FontFile3) or page content, as far as a dictionary tells: content has no type
    // or subtype and is not a color profile.
    const font = 'Length1' in dict || 'Length2' in dict || 'Length3' in dict || isName(dict.Subtype, 'Type1C') || isName(dict.Subtype, 'CIDFontType0C') || isName(dict.Subtype, 'OpenType');
    const plain = !font && !type && !image && !('Subtype' in dict) && !('N' in dict) && !codec;
    const tally = { n: 0, push(c: Uint8Array) { this.n += c.length; }, end() { /* nothing */ } };
    const form = isName(dict.Subtype, 'Form') && !codec;
    // A tiling pattern has content and resources as a form has; a mesh shading (types 4 to 7) has data pdf.js decodes.
    const tiling = num(dict.PatternType) === 1 && !codec;
    const mesh = (num(dict.ShadingType) ?? 0) >= 4 && !codec;
    const content = plain || form || tiling ? new ContentCount() : null;
    let next: Sink = headSink ?? objects ?? content ?? tally;
    let objectCounter: Counter | null = null;
    if (objstm) next = objectCounter = new Counter(this, next, what);
    const stages: Stage[] = [];
    for (let i = expanding.length - 1; i >= 0; i--) {
      const f = expanding[i];
      const predictor = num(f.parms.Predictor) ?? 1;
      if ((f.name === 'Flate' || f.name === 'LZW') && predictor > 1) {
        const columns = num(f.parms.Columns) ?? 1, colors = num(f.parms.Colors) ?? 1, bpc = num(f.parms.BitsPerComponent) ?? 8;
        this.row(columns, colors, bpc, what);
        const counted = i === expanding.length - 1 && objectCounter ? next : new Counter(this, next, what);
        next = new PredictorStage(counted, predictor, columns, colors, bpc);
      }
      const out = i === expanding.length - 1 && objectCounter && !(predictor > 1 && (f.name === 'Flate' || f.name === 'LZW')) ? next : new Counter(this, next, what);
      const stage: Stage | null = f.name === 'Flate' ? new FlateStage(out)
        : f.name === 'LZW' ? new LzwStage(out, num(f.parms.EarlyChange) ?? 1)
        : f.name === 'RL' ? new RunLengthStage(out)
        : f.name === 'AHx' ? new AsciiHexStage(out)
        : f.name === 'A85' ? new Ascii85Stage(out)
        : null;
      if (!stage) continue;
      stages.unshift(stage);
      next = stage;
    }
    if (stages.length || headSink) {
      // Feed from the data's start until the first stage reaches its own end of data.
      const first = stages[0];
      const sink: Sink = first ?? headSink!;
      // A picture's header is read from its own data only: reading on past a small picture counted the bytes after
      // it as work, so a manual with thousands of small JPEG pictures was refused as too much work to read.
      const stop = first ? b.length : Math.min(end, start + 256 * 1024);
      // Pieces grow from 256 bytes to 64 KB: a short stream is not fed (and its feeding counted) far past its own end,
      // which made a file of thousands of small streams look like far more work than it is, while a long stream is
      // soon read 64 KB at a time. The work limit below is unchanged.
      for (let p = start, size = 256; p < stop && !(first?.done); p += size, size = Math.min(65536, size * 2)) {
        const piece = b.subarray(p, Math.min(stop, p + size));
        this.fed += piece.length;
        if (this.fed > b.length * 8 + 64 * MB) throw new LimitError('This PDF\'s structure makes it far more work to read than its size suggests, so it was not opened.');
        sink.push(piece);
      }
      sink.end();
    }
    const streamSize = stages.length ? tally.n : Math.max(0, len ?? end - start - 9);
    // An object stream that is not compressed is read as it is: what it holds counts the same.
    if (objects && !stages.length) {
      const data = b.subarray(start, Math.min(b.length, start + streamSize));
      objects.push(data);
      objects.end();
      objectCounter!.count += data.length;
    }
    if (content) {
      // Uncompressed content was not fed through the stages: count it from the file.
      if (!stages.length) { content.push(b.subarray(start, Math.min(b.length, start + streamSize))); content.end(); }
      if (form || plain) for (const [name, n] of content.drawn) this.flatDrawn.set(name, (this.flatDrawn.get(name) ?? 0) + n);
      if ((form || tiling) && this.objNum >= 0) {
        const s = scopeOf(dict.Resources);
        this.addNode(this.objNum, content, content, s.scope, form, s.fonts, s.type3);
      }
      if (plain && !form) {
        r.contentBytes += content.n;
        r.rawContent += content.raw;
        if (content.n > r.largestContent) r.largestContent = content.n;
        if (content.raw > r.largestRawContent) r.largestRawContent = content.raw;
        if (!tiling && usesOf(content)) this.addPageUses(content);
        // A mesh shading is decoded whole wherever it is used; a stream whose dictionary could not be read may be a
        // form to pdf.js, so it is followed as one, with any names.
        if (mesh && this.objNum >= 0) this.addNode(this.objNum, { n: content.raw, texts: 0 }, NO_USES, { kind: 'inherit' }, false, 0, 0);
        else if (this.unread && this.objNum >= 0 && !tiling) this.addNode(this.objNum, content, content, { kind: 'global' }, false, 0, 0);
      }
    } else if (font && !codec) {
      r.fontBytes += streamSize;
      if (streamSize > this.largestFont) this.largestFont = streamSize;
    }
    if (objectCounter) {
      this.objectStreamBytes += objectCounter.count;
      if (this.objectStreamBytes > this.L.pdfObjectStreamBytes) throw new LimitError(`This PDF's object streams expand past ${mb(this.L.pdfObjectStreamBytes)} in all, the limit, so it was not opened.`);
    }
    if (pages) {
      r.pages += pages.pages;
      r.maxContents = Math.max(r.maxContents, pages.contents);
      r.softMasks += pages.softMasks;
      if (pages.signature) r.signatureHint = true;
    }
    if (headSink) {
      const size = codec!.name === 'DCT' ? jpegSize(headSink.bytes) : jpxSize(headSink.bytes);
      if (size) this.picture(size.width, size.height, codec!.name === 'DCT' ? 'JPEG data' : 'JPEG 2000 data');
    }
    return end;
  }

  private filters(dict: PdfDict): Array<{ name: string; parms: PdfDict }> {
    const f = dict.Filter ?? dict.F;
    const parms = dict.DecodeParms ?? dict.DP;
    const names: PdfValue[] = Array.isArray(f) ? f : f === undefined || f === null ? [] : [f];
    const plist: PdfValue[] = Array.isArray(parms) ? parms : [parms ?? null];
    return names.map((n, i) => {
      // A filter given by reference cannot be read here; Flate is assumed, the expanding filter almost all files use.
      const name = isName(n) ? FILTER_NAMES[n.name] ?? `?${n.name}` : isRef(n) ? 'Flate' : '?';
      const p = plist[i];
      return { name, parms: isDict(p) ? p : {} };
    }).filter(x => !x.name.startsWith('?'));
  }

  private picture(width: number, height: number, from: string): void {
    const px = Math.max(0, width) * Math.max(0, height);
    if (px > this.report.largestImagePixels) this.report.largestImagePixels = px;
    if (from === 'JPEG 2000 data' && px > this.report.largestJpxPixels) this.report.largestJpxPixels = px;
    if (px > this.L.pdfImagePixels) throw new LimitError(`This PDF has a picture of ${Math.round(width).toLocaleString('en-US')} by ${Math.round(height).toLocaleString('en-US')} pixels (in its ${from}), more than the ${(this.L.pdfImagePixels / 1e6).toLocaleString('en-US')} million pixels allowed, so it was not opened.`);
  }

  private row(columns: number, colors: number, bpc: number, what: string): void {
    const bytes = Math.ceil((Math.max(1, columns) * Math.max(1, colors) * Math.max(1, bpc)) / 8);
    if (!Number.isFinite(bytes) || bytes > this.L.pdfRowBytes) throw new LimitError(`This PDF has ${what} whose rows would be ${mb(bytes)} each, far more than a document needs, so it was not opened.`);
  }
}

/** Scans a PDF's bytes and returns what it holds, or throws a LimitError saying which limit it passes. */
export function scanPdf(bytes: Uint8Array, limits: PdfLimits = LIMITS): PdfScan {
  return new Scanner(bytes, limits).run();
}

/** The message for a PDF FileConvert does not open because it is encrypted (v0.2.0 does not decrypt). It says that
 *  this includes PDFs that open without a password, since those converted before v0.2.0. */
export const ENCRYPTED_MESSAGE = 'This PDF is encrypted, so FileConvert does not open it. Encrypted PDFs are not supported, including ones that open without a password and only restrict printing, copying or editing. FileConvert never removes a PDF\'s protection; open it in the app that made it, or ask its owner for an unprotected copy.';
