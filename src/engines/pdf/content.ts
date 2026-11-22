// Which named resources a content stream uses (ISO 32000-2, 8 and 9): fonts (Tf), XObjects (Do), graphics states
// (gs), shadings (sh), color spaces (cs, CS, and an inline picture's /CS), patterns (scn, SCN) and marked-content
// properties (BDC, DP). The page cleanup keeps only these in a page's resources, so a picture listed in resources
// that many pages share, but drawn only on a removed page, does not stay in the file.

export type ResourceKind = 'Font' | 'XObject' | 'ExtGState' | 'Shading' | 'ColorSpace' | 'Pattern' | 'Properties';

export type UsedResources = Record<ResourceKind, Set<string>>;

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

type Token = { name: string } | { op: string } | { other: true };

/** Reads the operators and operands of a content stream. Returns null when the stream cannot be read safely. */
export function usedResources(bytes: Uint8Array): UsedResources | null {
  const used: UsedResources = { Font: new Set(), XObject: new Set(), ExtGState: new Set(), Shading: new Set(), ColorSpace: new Set(), Pattern: new Set(), Properties: new Set() };
  const operands: Token[] = [];
  let i = 0;
  const n = bytes.length;
  const word = () => {
    const s = i;
    while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++;
    return String.fromCharCode(...bytes.subarray(s, Math.min(i, s + 127)));
  };
  let depth = 0; // inside an array or dictionary operand
  while (i < n) {
    const c = bytes[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++; continue; }
    if (c === 40) { // string
      let level = 0;
      for (; i < n; i++) {
        if (bytes[i] === 92) { i++; continue; }
        if (bytes[i] === 40) level++;
        else if (bytes[i] === 41 && --level === 0) { i++; break; }
      }
      if (level > 0) return null;
      if (!depth) operands.push({ other: true });
      continue;
    }
    if (c === 60 && bytes[i + 1] === 60) { depth++; i += 2; continue; }
    if (c === 62 && bytes[i + 1] === 62) { if (--depth < 0) return null; i += 2; if (!depth) operands.push({ other: true }); continue; }
    if (c === 60) { const e = bytes.indexOf(62, i); if (e < 0) return null; i = e + 1; if (!depth) operands.push({ other: true }); continue; }
    if (c === 91) { depth++; i++; continue; }
    if (c === 93) { if (--depth < 0) return null; i++; if (!depth) operands.push({ other: true }); continue; }
    if (c === 123 || c === 125 || c === 41 || c === 62) { i++; continue; }
    if (c === 47) { i++; const nm = word().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))); if (!depth) operands.push({ name: nm }); continue; }
    const w = word();
    if (!w) { i++; continue; }
    if (depth) continue;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w) || w === 'true' || w === 'false' || w === 'null') { operands.push({ other: true }); continue; }
    // An operator.
    const last = operands[operands.length - 1];
    const name = (t: Token | undefined) => (t && 'name' in t ? t.name : null);
    switch (w) {
      case 'Do': { const x = name(last); if (x) used.XObject.add(x); break; }
      case 'Tf': { const x = name(operands[operands.length - 2]); if (x) used.Font.add(x); break; }
      case 'gs': { const x = name(last); if (x) used.ExtGState.add(x); break; }
      case 'sh': { const x = name(last); if (x) used.Shading.add(x); break; }
      case 'cs': case 'CS': { const x = name(last); if (x) used.ColorSpace.add(x); break; }
      case 'scn': case 'SCN': { const x = name(last); if (x) used.Pattern.add(x); break; }
      case 'BDC': case 'DP': { const x = name(last); if (x) used.Properties.add(x); break; }
      case 'BI': {
        // An inline picture: its dictionary up to ID, then binary data up to EI.
        const id = findWord(bytes, 'ID', i);
        if (id < 0) return null;
        const dict = new TextDecoder('latin1').decode(bytes.subarray(i, id));
        const cs = /\/(?:CS|ColorSpace)\s*\/([^\s/[\]<>()]+)/.exec(dict);
        if (cs) used.ColorSpace.add(cs[1]);
        const ei = findEI(bytes, id + 3);
        if (ei < 0) return null;
        i = ei + 2;
        break;
      }
      default: break;
    }
    operands.length = 0;
  }
  return used;
}

function findWord(b: Uint8Array, w: string, from: number): number {
  const a = w.charCodeAt(0), c = w.charCodeAt(1);
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] === a && b[i + 1] === c && WS.has(b[i - 1]) && (i + 2 >= b.length || WS.has(b[i + 2]))) return i;
  }
  return -1;
}

/** The end of inline picture data: "EI" with white space before it and white space or the end after it. */
function findEI(b: Uint8Array, from: number): number {
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= b.length || WS.has(b[i + 2]))) return i;
  }
  return -1;
}
