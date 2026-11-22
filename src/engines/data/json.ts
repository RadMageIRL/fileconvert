// JSON values as the data engine passes them around: parsed with integers beyond 2^53 kept exact (as BigInt), checked
// for nesting depth without recursion, and written back with those integers' digits exactly as they were.

import { LIMITS, LimitError } from '../../core/limits';

export type Json = null | boolean | number | bigint | string | Json[] | { [k: string]: Json };

export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What parsing met that the notes must name. A caller that parses many values (JSON Lines) passes one tally and
 * writes the notes once; otherwise parseJson writes them itself.
 */
export interface JsonTally {
  /** Keys that appeared again in the same object; JSON.parse keeps the last value, as every JSON reader does. */
  duplicates: number;
  firstDuplicate?: string;
  /** Values (lines) that had a repeated key. */
  valuesWithDuplicates: number;
  /** Integers beyond 2^53 whose digits the engine did not expose. */
  unsafe: number;
}

export const newTally = (): JsonTally => ({ duplicates: 0, valuesWithDuplicates: 0, unsafe: 0 });

/** The notes for a tally, with `per` naming what one parsed value is ("line") when there were several. */
export function tallyNotes(t: JsonTally, warnings: string[], per?: string): void {
  if (t.duplicates) {
    const where = per && t.valuesWithDuplicates ? ` on ${plural(t.valuesWithDuplicates, per)}` : '';
    warnings.push(`${plural(t.duplicates, 'repeated key')} in the same object${where} (first: "${t.firstDuplicate}"): JSON keeps one value per key, so, as every JSON reader does, the last value was used and the earlier ${t.duplicates === 1 ? 'one was' : 'ones were'} not converted.`);
  }
  if (t.unsafe) warnings.push(`${plural(t.unsafe, 'number')} larger than 9007199254740991 may have lost precision; this browser does not expose the original digits.`);
}

/** Parses JSON, keeping integers beyond 2^53 exact as BigInt where the engine gives the source text. */
export function parseJson(text: string, warnings: string[], tally?: JsonTally): Json {
  const scan = scanJson(text);
  const depth = scan.depth;
  if (depth > LIMITS.dataDepth) throw new LimitError(`The data is nested ${depth} levels deep; the limit is ${LIMITS.dataDepth}.`);
  let unsafe = 0;
  let value: Json;
  try {
    value = JSON.parse(text.replace(/^\ufeff/, ''), function (this: unknown, _key: string, v: unknown, ctx?: { source?: string }) {
      if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) {
        if (ctx && typeof ctx.source === 'string' && /^-?\d+$/.test(ctx.source)) return BigInt(ctx.source);
        unsafe++;
      }
      return v;
    }) as Json;
  } catch (e) {
    throw new Error(`This is not valid JSON: ${(e as Error).message}`);
  }
  checkDepth(value);
  const t = tally ?? newTally();
  t.unsafe += unsafe;
  if (scan.duplicates) {
    t.duplicates += scan.duplicates;
    t.valuesWithDuplicates++;
    t.firstDuplicate ??= scan.firstDuplicate;
  }
  if (!tally) tallyNotes(t, warnings);
  return value;
}

/**
 * One pass over JSON text before parsing: the bracket nesting (a parser with a reviver recurses per level) and the
 * keys repeated within one object, which JSON.parse would otherwise drop without a word. Invalid JSON is left to
 * the parser to report.
 */
export function scanJson(text: string): { depth: number; duplicates: number; firstDuplicate?: string } {
  let depth = 0, max = 0, duplicates = 0, firstDuplicate: string | undefined;
  // One entry per open bracket: an object's keys so far (made at its first key), or null for a list.
  const open: Array<Set<string> | null | undefined> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      const start = i;
      let escaped = false;
      for (i++; i < text.length; i++) {
        const d = text.charCodeAt(i);
        if (d === 92) { escaped = true; i++; } // backslash: skip the escaped character
        else if (d === 34) break;
      }
      if (expectKey) {
        expectKey = false;
        let key = text.slice(start + 1, i);
        if (escaped) {
          try { key = JSON.parse(text.slice(start, i + 1)) as string; } catch { /* the parser reports it */ }
        }
        const top = open.length - 1;
        const keys = open[top] ?? (open[top] = new Set());
        if (keys.has(key)) { duplicates++; firstDuplicate ??= key; } else keys.add(key);
      }
    } else if (c === 123) { if (++depth > max) max = depth; open.push(undefined); expectKey = true; }
    else if (c === 91) { if (++depth > max) max = depth; open.push(null); expectKey = false; }
    else if (c === 93 || c === 125) { depth--; open.pop(); expectKey = false; }
    else if (c === 44) expectKey = open.length > 0 && open[open.length - 1] !== null;
  }
  return { depth: max, duplicates, firstDuplicate };
}

/** Bracket nesting of JSON text, measured before parsing. */
export const jsonDepth = (text: string): number => scanJson(text).depth;

/** Throws when nesting is deeper than the limit, without recursion. */
export function checkDepth(value: unknown, limit: number = LIMITS.dataDepth): void {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d > limit) throw new LimitError(`The data is nested more than ${limit} levels deep, the limit.`);
    for (const child of Array.isArray(v) ? v : Object.values(v as object)) {
      if (child !== null && typeof child === 'object') stack.push([child, d + 1]);
    }
  }
}

/**
 * JSON.stringify that writes BigInt values as their exact digits, as the JSON they came from had them. Each BigInt is
 * first written as a marker string: a NUL character (which JSON.stringify always escapes as \u0000) and a random
 * nonce, so no text in the data can be mistaken for one.
 */
export function stringifyJson(value: unknown, indent?: number): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('');
  let big = false;
  const text = JSON.stringify(value, (_k, v) => {
    if (typeof v !== 'bigint') return v;
    big = true;
    return `\u0000${nonce}:${v.toString()}`;
  }, indent);
  return big ? text.replace(new RegExp(`"\\\\u0000${nonce}:(-?\\d+)"`, 'g'), '$1') : text;
}
