// A small reader for PDF object syntax (ISO 32000-2, 7.2 and 7.3), enough for the guard to read the dictionary
// in front of a stream: names, numbers, strings, arrays, dictionaries and indirect references. It reads
// untrusted text, so it is iterative where it matters and refuses deep nesting instead of recursing without end.

export type PdfValue =
  | null | boolean | number | string
  | { name: string }
  | { ref: [number, number] }
  | PdfValue[]
  | PdfDict;

export interface PdfDict { [key: string]: PdfValue }

const WS = new Set([0, 9, 10, 12, 13, 32]);
/** Raw characters of a name kept: enough for 127 once #xx escapes are decoded. */
const NAME_RAW = 384;

/**
 * A name as readers compare it: #xx escapes decoded, cut to 127 characters (the standard's limit). pdf.js reads longer
 * names whole; names that share their first 127 characters are taken as one here, so a name is never missed.
 */
export const normName = (raw: string): string =>
  (raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : raw).slice(0, 127);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

export class PdfSyntaxError extends Error {}

/** Reads PDF objects from `bytes`, starting at `pos`. */
export class ObjReader {
  pos: number;
  constructor(private b: Uint8Array, pos = 0, private end = b.length) { this.pos = pos; }

  private skip(): void {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WS.has(c)) { this.pos++; continue; }
      if (c === 37) { while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++; continue; }
      break;
    }
  }

  /** The next word, of which the first `keep` characters are kept. */
  private word(keep = 64): string {
    const start = this.pos;
    while (this.pos < this.end && !WS.has(this.b[this.pos]) && !DELIM.has(this.b[this.pos])) this.pos++;
    return String.fromCharCode(...this.b.subarray(start, Math.min(this.pos, start + keep)));
  }

  /** Reads one value. Nested arrays and dictionaries deeper than `maxDepth` are refused. */
  read(maxDepth = 32, depth = 0): PdfValue {
    if (depth > maxDepth) throw new PdfSyntaxError('nested too deeply');
    this.skip();
    if (this.pos >= this.end) throw new PdfSyntaxError('unexpected end');
    const b = this.b;
    const c = b[this.pos];
    if (c === 47) { // name
      this.pos++;
      return { name: normName(this.word(NAME_RAW)) };
    }
    if (c === 60 && b[this.pos + 1] === 60) { // dictionary
      this.pos += 2;
      // No prototype: a key such as /__proto__ is a key like any other.
      const d: PdfDict = Object.create(null) as PdfDict;
      for (;;) {
        this.skip();
        if (this.pos >= this.end) throw new PdfSyntaxError('unterminated dictionary');
        if (b[this.pos] === 62 && b[this.pos + 1] === 62) { this.pos += 2; return d; }
        const k = this.read(maxDepth, depth + 1);
        if (!isName(k)) throw new PdfSyntaxError('dictionary key is not a name');
        d[k.name] = this.read(maxDepth, depth + 1);
      }
    }
    if (c === 60) { // hex string
      const close = b.indexOf(62, this.pos);
      if (close < 0 || close >= this.end) throw new PdfSyntaxError('unterminated hex string');
      this.pos = close + 1;
      return '';
    }
    if (c === 40) { // literal string, with balanced parentheses and escapes
      let level = 0;
      for (; this.pos < this.end; this.pos++) {
        const x = b[this.pos];
        if (x === 92) { this.pos++; continue; }
        if (x === 40) level++;
        else if (x === 41 && --level === 0) { this.pos++; return ''; }
      }
      throw new PdfSyntaxError('unterminated string');
    }
    if (c === 91) { // array
      this.pos++;
      const a: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.pos >= this.end) throw new PdfSyntaxError('unterminated array');
        if (b[this.pos] === 93) { this.pos++; return a; }
        a.push(this.read(maxDepth, depth + 1));
      }
    }
    const w = this.word();
    if (!w) { this.pos++; throw new PdfSyntaxError('unexpected character'); }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      // Two whole numbers followed by R are a reference, as pdf.js reads them (+12 and 12.0 included).
      if (Number.isInteger(Number(w)) && Number(w) >= 0) {
        const save = this.pos;
        this.skip();
        const g = this.word();
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(g) && Number.isInteger(Number(g))) {
          this.skip();
          if (this.b[this.pos] === 82 && (this.pos + 1 >= this.end || WS.has(this.b[this.pos + 1]) || DELIM.has(this.b[this.pos + 1]))) {
            this.pos++;
            return { ref: [Number(w), Number(g)] };
          }
        }
        this.pos = save;
      }
      return Number(w);
    }
    return { name: `#keyword:${w}` };
  }
}

export const isName = (v: PdfValue | undefined, n?: string): v is { name: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && (n === undefined || v.name === n);
export const isRef = (v: PdfValue | undefined): v is { ref: [number, number] } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'ref' in v;
export const isDict = (v: PdfValue | undefined): v is PdfDict =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !('name' in v) && !('ref' in v);
export const num = (v: PdfValue | undefined): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
