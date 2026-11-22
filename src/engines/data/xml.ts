// XML reading, shared by XML to JSON and XML to tables. Nothing in a file is fetched or expanded: a DOCTYPE that
// declares entities is refused (XXE, billion laughs), any other DOCTYPE is ignored, only the five predefined and
// numeric character references are decoded, and nesting is measured before parsing.
//
// Tables from XML follow these rules (also in the README and on the pages):
//  1. The records are the elements that repeat. From the root, FileConvert steps into an element while it is the
//     only child of its parent, and stops at the first element with a child name that occurs more than once.
//     Each repeated name there is one table (one CSV each, or one sheet each in Excel).
//  2. No repeated element: the single record found that way is one row; if there is not even that, the root is
//     one row.
//  3. In a record, attributes and child elements are columns by name (an attribute whose name a child element also
//     has is @name), deeper elements are dotted columns (address.city), and an element with both attributes and
//     text gives its text to its own column (price) and its attributes to price.currency. A record's own text is in
//     a column named after the record.
//  4. An element repeated inside one record (several <tag>) is one cell holding a JSON list, or numbered columns
//     (tag.0, tag.1), as for JSON.
//  5. Every value is text; Excel output can recognize numbers (Data settings), with leading zeros kept as text.
//  6. What sits beside the records, such as a <meta> block next to them or an attribute of the element around them,
//     is repeated on every row as extra columns (meta.updated, owner), so nothing is lost; the result names them.
//     Namespace declarations (xmlns) are not data and are left out.

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { LIMITS, LimitError } from '../../core/limits';
import type { Json } from './json';

/** Rejects DOCTYPE entity declarations before any parser sees them (XXE, billion laughs). */
export function checkXmlSafety(text: string, warnings: string[]): void {
  const m = /<!DOCTYPE/i.exec(text);
  if (!m) return;
  const rest = text.slice(m.index, m.index + 200000);
  if (/<!ENTITY/i.test(rest)) {
    throw new Error('This XML declares entities in its DOCTYPE. Entity expansion is a common attack (XXE, billion laughs), so FileConvert does not convert such files. Remove the DOCTYPE block and try again.');
  }
  warnings.push('The DOCTYPE declaration was ignored; nothing it refers to is loaded.');
}

/** Measures element nesting without recursion, skipping comments, CDATA, declarations and quoted attribute values. */
export function xmlDepth(text: string): number {
  let depth = 0, max = 0;
  let i = text.indexOf('<');
  while (i !== -1 && i < text.length) {
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); i = e < 0 ? -1 : text.indexOf('<', e + 3); continue; }
    if (text.startsWith('<![CDATA[', i)) { const e = text.indexOf(']]>', i + 9); i = e < 0 ? -1 : text.indexOf('<', e + 3); continue; }
    if (text[i + 1] === '?' || text[i + 1] === '!') { const e = text.indexOf('>', i); i = e < 0 ? -1 : text.indexOf('<', e + 1); continue; }
    let j = i + 1;
    let quote = '';
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (text[i + 1] === '/') depth--;
    else if (text[j - 1] === '/') { if (depth + 1 > max) max = depth + 1; }
    else { depth++; if (depth > max) max = depth; }
    i = text.indexOf('<', j + 1);
  }
  return max;
}

const ENTITY = /&(lt|gt|amp|apos|quot|#\d+|#x[0-9a-fA-F]+);/g;
function decodeEntities(s: string): string {
  return s.replace(ENTITY, (m, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'apos': return "'";
      case 'quot': return '"';
    }
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

function decodeTree(v: unknown): unknown {
  if (typeof v === 'string') return decodeEntities(v);
  if (Array.isArray(v)) return v.map(decodeTree);
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = decodeTree(x);
    return o;
  }
  return v;
}

/**
 * Parses XML text into a tree: attributes are keys starting with @, element text is #text, repeated elements are
 * lists, and every value is text.
 */
export function parseXml(raw: string, warnings: string[]): Record<string, Json> {
  const text = raw.replace(/^\ufeff/, '');
  checkXmlSafety(text, warnings);
  const depth = xmlDepth(text);
  if (depth > LIMITS.dataDepth) throw new LimitError(`The XML is nested ${depth} levels deep; the limit is ${LIMITS.dataDepth}.`);
  const valid = XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (valid !== true) throw new Error(`This is not well-formed XML: ${valid.err.msg} (line ${valid.err.line}, column ${valid.err.col}).`);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
    htmlEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    allowBooleanAttributes: true,
    removeNSPrefix: false,
    // The depth is already checked above with a clear message; the parser's own cap (100 by default) sits past it.
    maxNestedTags: LIMITS.dataDepth + 1,
  });
  const tree = decodeTree(parser.parse(text)) as Record<string, Json>;
  if (/<!\[CDATA\[/.test(text)) warnings.push('CDATA sections were merged into the element text.');
  return tree;
}

const isObject = (v: Json | undefined): v is { [k: string]: Json } => v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
const childNames = (o: { [k: string]: Json }) => Object.keys(o).filter(k => !k.startsWith('@') && k !== '#text');

/**
 * A record as a flat map of column names to text: @attr, child, child.grandchild, element text in the element's own
 * column, and repeated children as a JSON list (or numbered columns).
 */
export function flattenXmlRecord(rec: Json, arrays: 'json' | 'columns', name: string): Map<string, Json> {
  const out = new Map<string, Json>();
  const walk = (v: Json, path: string) => {
    if (!isObject(v)) {
      if (Array.isArray(v)) {
        if (arrays === 'columns') { v.forEach((x, i) => walk(x, `${path}.${i}`)); return; }
        out.set(path, JSON.stringify(v));
        return;
      }
      out.set(path, v);
      return;
    }
    for (const [k, x] of fields(v)) {
      if (k === '#text') { out.set(path, x); continue; }
      walk(x, `${path}.${k}`);
    }
  };
  if (!isObject(rec)) {
    // A record that is only text: <tag>value</tag>.
    out.set(name, Array.isArray(rec) ? JSON.stringify(rec) : rec);
    return out;
  }
  for (const [k, x] of fields(rec)) {
    // The record's own text, beside its attributes or children, is in the column named after the record.
    if (k === '#text') { out.set(name, x); continue; }
    walk(x, k);
  }
  return out;
}

/**
 * An element's text, then its attributes, then its children, each by the name its column takes. An attribute is
 * named as it is (id, not @id: a leading @ would make spreadsheets read the heading as a formula), unless a child
 * element has the same name, when it keeps the @.
 */
function fields(o: { [k: string]: Json }): Array<[string, Json]> {
  const keys = Object.keys(o);
  const kids = keys.filter(k => !k.startsWith('@') && k !== '#text');
  const attrs = keys.filter(k => k.startsWith('@')).map((k): [string, Json] => [kids.includes(k.slice(1)) ? k : k.slice(1), o[k]]);
  return [...keys.filter(k => k === '#text').map((k): [string, Json] => [k, o[k]]), ...attrs, ...kids.map((k): [string, Json] => [k, o[k]])];
}

export interface XmlTable {
  /** The repeated element's name, which names the CSV file or the sheet. */
  name: string;
  records: Json[];
}

export interface XmlTables {
  tables: XmlTable[];
  /**
   * What sits beside the records: attributes of the elements around them (namespace declarations aside) and the
   * other children of the element that holds them. Repeated on every row, so nothing is lost.
   */
  context: Map<string, Json>;
}

/** Finds the records in a parsed XML tree by the rules at the top of this file. */
export function xmlTables(tree: Record<string, Json>, arrays: 'json' | 'columns', warnings: string[]): XmlTables {
  const roots = Object.keys(tree);
  if (roots.length !== 1) throw new Error('The XML has no single root element.');
  let name = roots[0];
  let node: Json = tree[name];
  const path = [name];
  const context = new Map<string, Json>();
  const attributes = (o: { [k: string]: Json }) => {
    for (const [k, v] of Object.entries(o)) if (k.startsWith('@') && !/^@xmlns(:|$)/.test(k)) context.set(k.slice(1), v);
  };
  for (;;) {
    if (!isObject(node)) {
      // The root, or the only child, is just text: one row, one column.
      warnings.push(`The XML has no repeated element, so <${name}> became one row.`);
      return { tables: [{ name, records: [node] }], context };
    }
    const here = node;
    const kids = childNames(here);
    const repeated = kids.filter(k => Array.isArray(here[k]));
    if (repeated.length) {
      attributes(here);
      for (const k of kids.filter(k => !repeated.includes(k))) for (const [col, v] of flattenXmlRecord(here[k], arrays, k)) context.set(col === k ? k : `${k}.${col}`, v);
      if (typeof here['#text'] === 'string' && here['#text']) context.set('#text', here['#text']);
      return { tables: repeated.map(k => ({ name: k, records: here[k] as Json[] })), context };
    }
    // One child element that has children of its own: a wrapper, such as <response><items>; step into it.
    if (kids.length === 1 && isObject(here[kids[0]]) && childNames(here[kids[0]] as { [k: string]: Json }).length) {
      const only = here[kids[0]] as { [k: string]: Json };
      attributes(here);
      const leaves = childNames(only).every(k => !isObject(only[k]) && !Array.isArray(only[k]));
      if (leaves) {
        // A single record (<catalog><book><title/>...</book></catalog>): one row.
        warnings.push(`<${kids[0]}> appears once, so it became one row.`);
        return { tables: [{ name: kids[0], records: [only] }], context };
      }
      name = kids[0];
      node = only;
      path.push(name);
      continue;
    }
    // Several different children, none repeated: this element is the one record.
    warnings.push(`The XML has no repeated element, so <${path.join('/')}> became one row.`);
    return { tables: [{ name, records: [here] }], context };
  }
}
