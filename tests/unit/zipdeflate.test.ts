import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { unzipSync, Zip, Zlib, zlibSync } from 'fflate';
import { crc32 } from '../../src/core/crc32';
import { NativeDeflate } from '../../src/core/zipdeflate';
import { readPng } from '../../src/engines/pdf/imageinfo';
import { decodePng } from '../../src/engines/pdf/pngdecode';
import { filteredRows, rgbaRows } from '../../src/engines/image/pngwrite';
import { resample } from '../../src/engines/image/resample';

// The rows that showed fflate 0.8.3's streaming deflate making invalid data (v0.2.0, Phase 3): tests/fixtures/optimize/
// rgba.png resized to 120 x 90 and filtered as the PNG writer filters it.
async function troubleRows(): Promise<Uint8Array> {
  const b = new Uint8Array(readFileSync('tests/fixtures/optimize/rgba.png'));
  const L = readPng(b, true, crc32);
  const p = decodePng(b, L);
  const n = L.info.width * L.info.height;
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    d[4 * i] = p.color[3 * i]; d[4 * i + 1] = p.color[3 * i + 1]; d[4 * i + 2] = p.color[3 * i + 2]; d[4 * i + 3] = p.alpha ? p.alpha[i] : 255;
  }
  const r = resample({ data: d, width: L.info.width, height: L.info.height }, 120, 90);
  const parts: Uint8Array[] = [];
  await filteredRows(rgbaRows(r.data, 120, 90), async x => { parts.push(x.slice()); });
  return Uint8Array.from(Buffer.concat(parts));
}

describe('deflate for the batch ZIP and the PNG writer', () => {
  test('fflate 0.8.3 streams these rows into invalid data at level 6, but not in one piece: so neither path uses its stream', async () => {
    const raw = await troubleRows();
    const parts: Uint8Array[] = [];
    const z = new Zlib({ level: 6 });
    z.ondata = c => parts.push(c.slice());
    z.push(raw, true);
    // If this ever stops throwing, a newer fflate has fixed its streaming deflate.
    expect(() => inflateSync(Buffer.concat(parts))).toThrow(/invalid distance too far back/);
    expect(Buffer.compare(inflateSync(zlibSync(raw, { level: 6 })), Buffer.from(raw))).toBe(0);
  });

  test('a text entry deflated by the platform\'s own zlib reads back byte for byte, and is compressed', async () => {
    const raw = await troubleRows();
    const text = new TextEncoder().encode('name,value\n' + 'alpha,1\nbeta,2\n'.repeat(5000));
    const parts: Uint8Array[] = [];
    let failure: Error | null = null;
    const zip = new Zip((err, chunk) => { if (err) failure = err; else parts.push(chunk); });
    for (const [name, data] of [['rows.txt', raw], ['table.csv', text]] as const) {
      const entry = new NativeDeflate(name);
      zip.add(entry);
      for (let i = 0; i < data.length; i += 4096) entry.push(data.subarray(i, i + 4096), false);
      entry.push(new Uint8Array(0), true);
      await entry.done();
    }
    zip.end();
    expect(failure).toBeNull();
    const file = Uint8Array.from(Buffer.concat(parts));
    const back = unzipSync(file);
    expect(Buffer.compare(Buffer.from(back['rows.txt']), Buffer.from(raw))).toBe(0);
    expect(Buffer.compare(Buffer.from(back['table.csv']), Buffer.from(text))).toBe(0);
    // Deflated (method 8), and much smaller than the text.
    expect(file[8]).toBe(8);
    expect(file.length).toBeLessThan(raw.length + text.length / 10);
  });
});
