// JSON Lines (also called NDJSON): one JSON value per line, UTF-8, lines ended by LF or CRLF.
//
// Reading is strict, so no record is ever dropped silently: every line that is not blank must be one complete JSON
// value, or the conversion stops and names the line. Blank lines are skipped and counted. Each value keeps its
// type, and integers beyond 2^53 keep their digits, as in a JSON file.
//
// Writing puts each value on its own line in compact JSON (JSON escapes line breaks inside strings, so a value can
// never span two lines), with LF line endings and a final LF.

import { LIMITS, LimitError } from '../../core/limits';
import { parseJson, plural, stringifyJson, type Json } from './json';

export function readJsonLines(text: string, warnings: string[]): Json[] {
  const lines = text.replace(/^\ufeff/, '').split('\n');
  const values: Json[] = [];
  let blank = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) {
      // The final line break leaves one empty piece; that is not a blank line in the file.
      if (i < lines.length - 1) blank++;
      continue;
    }
    if (values.length >= LIMITS.jsonlLines) throw new LimitError(`The file has more than ${LIMITS.jsonlLines.toLocaleString('en-US')} lines, the limit.`);
    try {
      values.push(parseJson(line, warnings));
    } catch (e) {
      if (e instanceof LimitError) throw new LimitError(`Line ${i + 1}: ${e.message}`);
      const whole = text.trim();
      if (values.length === 0 && (whole.startsWith('[') || whole.startsWith('{'))) {
        // Pretty-printed JSON saved as .jsonl: say so, rather than only "line 1 is not valid".
        try {
          parseJson(whole, []);
          throw new Error('This is a JSON document spread over several lines, not JSON Lines (one value per line). Rename it to .json to convert it as JSON.');
        } catch (inner) {
          if (/not JSON Lines/.test((inner as Error).message)) throw inner;
        }
      }
      throw new Error(`Line ${i + 1} is not a complete JSON value, so nothing was converted: ${(e as Error).message.replace(/^This is not valid JSON: /, '')}`);
    }
  }
  if (values.length === 0) throw new Error('The file has no JSON values.');
  if (blank) warnings.push(`${plural(blank, 'blank line')} skipped.`);
  return values;
}

export function writeJsonLines(values: readonly Json[]): string {
  let out = '';
  for (const v of values) out += stringifyJson(v) + '\n';
  return out;
}
