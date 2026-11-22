// JSON values as the data engine passes them around: parsed with integers beyond 2^53 kept exact (as BigInt), checked
// for nesting depth without recursion, and written back with those integers' digits exactly as they were.

import { LIMITS, LimitError } from '../../core/limits';

export type Json = null | boolean | number | bigint | string | Json[] | { [k: string]: Json };

export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Parses JSON, keeping integers beyond 2^53 exact as BigInt where the engine gives the source text. */
export function parseJson(text: string, warnings: string[]): Json {
  const depth = jsonDepth(text);
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
  if (unsafe) warnings.push(`${plural(unsafe, 'number')} larger than 9007199254740991 may have lost precision; this browser does not expose the original digits.`);
  checkDepth(value);
  return value;
}

/** Bracket nesting of JSON text, measured before parsing (a parser with a reviver recurses per level). */
export function jsonDepth(text: string): number {
  let depth = 0, max = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) { if (++depth > max) max = depth; }
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}

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
