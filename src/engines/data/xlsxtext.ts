// Keeps characters beyond the Basic Multilingual Plane (emoji, many CJK extension characters) intact when SheetJS
// reads a workbook. Some generators (openpyxl, and so pandas) write such characters as numeric references like
// &#128512;, and SheetJS 0.20.3 decodes those with String.fromCharCode, which keeps only 16 bits: the emoji becomes
// a different, private-use character. Rewriting each such reference as its two UTF-16 surrogate references, which
// SheetJS decodes correctly, gives back the exact text. Workbooks without such references are left untouched.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const TEXT_PARTS = /^xl\/(sharedStrings|workbook|worksheets\/[^/]+)\.xml$/i;
const ASTRAL_REF = /&#(?:[xX]([0-9a-fA-F]{5,6})|(\d{5,7}));/g;

/** Rewrites one XML text; returns it unchanged when there is nothing to fix. */
export function splitAstralReferences(xml: string): { xml: string; fixed: number } {
  let fixed = 0;
  const out = xml.replace(ASTRAL_REF, (m, hex: string | undefined, dec: string | undefined) => {
    const cp = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
    if (cp <= 0xffff || cp > 0x10ffff) return m;
    fixed++;
    const v = cp - 0x10000;
    return `&#${0xd800 + (v >> 10)};&#${0xdc00 + (v & 0x3ff)};`;
  });
  return { xml: fixed ? out : xml, fixed };
}

/** The workbook with its astral character references split, or the same bytes when it has none. */
export function keepAstralCharacters(bytes: Uint8Array): Uint8Array {
  const parts = unzipSync(bytes, { filter: f => TEXT_PARTS.test(f.name) });
  const changed: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(parts)) {
    const text = strFromU8(data);
    if (!text.includes('&#')) continue;
    const r = splitAstralReferences(text);
    if (r.fixed) changed[name] = strToU8(r.xml);
  }
  if (!Object.keys(changed).length) return bytes;
  const all = unzipSync(bytes);
  Object.assign(all, changed);
  return zipSync(all, { level: 1 });
}
