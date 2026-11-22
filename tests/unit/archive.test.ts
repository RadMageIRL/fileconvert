import { describe, expect, test } from 'vitest';
import { gzipSync, zipSync, type Zippable } from 'fflate';
import { extractArchive, gzipName, isTarHeader, safePath, type ArchiveLimits, type Sink } from '../../src/engines/archive/extract';

// Archive extraction (v0.2.0). Every archive here is built in the test, many of them hostile: limits must hold
// against what is actually unpacked, names must never become paths, and failed files must leave nothing behind.

const enc = (s: string) => new TextEncoder().encode(s);
const text = async (b: Blob) => new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()));
const LIMITS: ArchiveLimits = { entries: 100, totalBytes: 64 * 1048576, ratio: 100, ratioFloor: 1048576 };

/** An in-memory sink that counts writers still open or aborted. */
function memorySink() {
  const state = { open: 0, aborted: 0, finished: 0 };
  const sink: Sink = async () => {
    state.open++;
    const parts: Uint8Array[] = [];
    return {
      async write(c) { parts.push(c); },
      async finish() { state.open--; state.finished++; return new Blob(parts as Uint8Array<ArrayBuffer>[]); },
      async abort() { state.open--; state.aborted++; parts.length = 0; },
    };
  };
  return { sink, state };
}

const run = (bytes: Uint8Array, kind: 'zip' | 'tar' | 'gz', name = 'archive', limits: Partial<ArchiveLimits> = {}) => {
  const m = memorySink();
  return { m, result: extractArchive(new Blob([bytes as Uint8Array<ArrayBuffer>]), kind, name, m.sink, { ...LIMITS, ...limits }) };
};

/** Offsets of a ZIP's central directory entries, to tamper with them. */
function centralEntries(zip: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= zip.length; i++) if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 1 && zip[i + 3] === 2) out.push(i);
  return out;
}
const setU16 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 0xff; b[at + 1] = v >> 8; };
const setU32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset).setUint32(at, v >>> 0, true);

/** A TAR file from entries: name, type, data, and an optional link target; checksums computed. */
function tar(entries: Array<{ name: string; type?: string; data?: string; prefix?: string }>, end = true): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const h = new Uint8Array(512);
    h.set(enc(e.name.slice(0, 100)));
    h.set(enc('0000644\0'), 100);
    h.set(enc('0000000\0'), 108);
    h.set(enc('0000000\0'), 116);
    const data = enc(e.data ?? '');
    h.set(enc(data.length.toString(8).padStart(11, '0') + '\0'), 124);
    h.set(enc('00000000000\0'), 136);
    h[156] = (e.type ?? '0').charCodeAt(0);
    h.set(enc('ustar\0'), 257);
    h.set(enc('00'), 263);
    if (e.prefix) h.set(enc(e.prefix), 345);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    h.set(enc(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    blocks.push(h);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  if (end) blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

describe('ZIP', () => {
  test('unpacks stored and deflated files, keeps their paths to show, and gives unique safe names', async () => {
    const zip = zipSync({ 'a/readme.txt': enc('hello'), 'b/readme.txt': [enc('world'), { level: 0 }], 'README': enc('no extension'), 'docs/': new Uint8Array(0) });
    const { m, result } = run(zip, 'zip');
    const r = await result;
    expect(r.entries.map(e => [e.path, e.name, e.size])).toEqual([['a/readme.txt', 'readme.txt', 5], ['b/readme.txt', 'readme (2).txt', 5], ['README', 'README', 12]]);
    expect(await text(r.entries[1].file)).toBe('world');
    expect(m.state).toMatchObject({ open: 0, aborted: 0 });
  });

  test('paths that point outside, absolute paths, drive letters and control characters are shown safely', async () => {
    const files: Zippable = { '../../evil.txt': enc('1'), '/etc/passwd': enc('2'), 'C:\\Windows\\x.dll': enc('3'), 'ok/\u202egnp.exe': enc('4'), 'CON': enc('5') };
    const r = await run(zipSync(files), 'zip').result;
    expect(r.entries.map(e => [e.path, e.name])).toEqual([['evil.txt', 'evil.txt'], ['etc/passwd', 'passwd'], ['Windows/x.dll', 'x.dll'], ['ok/_gnp.exe', '_gnp.exe'], ['CON', '_CON']]);
    expect(r.warnings[0]).toMatch(/^3 paths pointed outside the archive/);
    for (const e of r.entries) expect(e.name).not.toMatch(/[\\/:\u0000-\u001f\u202e]/);
  });

  test('links, encrypted entries and unknown compression are listed, not unpacked', async () => {
    const zip = zipSync({ 'link': [enc('/etc/shadow'), { os: 3, attrs: (0o120777 << 16) >>> 0 }], 'secret.txt': enc('top secret'), 'packed.bin': enc('bzip2 data'), 'plain.txt': enc('fine') });
    const cd = centralEntries(zip);
    // secret.txt: the encrypted flag in the directory and the local header; packed.bin: method 12 (bzip2).
    setU16(zip, cd[1] + 8, 1);
    setU16(zip, cd[2] + 10, 12);
    const r = await run(zip, 'zip').result;
    expect(r.entries.map(e => e.path)).toEqual(['plain.txt']);
    expect(r.skipped).toEqual([
      { path: 'link', reason: 'a link to another file; links are not unpacked' },
      { path: 'secret.txt', reason: 'encrypted; FileConvert cannot open password-protected archives' },
      { path: 'packed.bin', reason: 'compressed with bzip2, which FileConvert cannot unpack' },
    ]);
  });

  test('an archive that is all encrypted is refused as password-protected', async () => {
    const zip = zipSync({ 'a.txt': enc('a'), 'b.txt': enc('b') });
    for (const at of centralEntries(zip)) setU16(zip, at + 8, 1);
    await expect(run(zip, 'zip').result).rejects.toThrow('This ZIP file is password-protected.');
  });

  test('sizes that lie are caught against the bytes actually unpacked, and the partial file is discarded', async () => {
    const big = new Uint8Array(4 * 1048576);
    const zip = zipSync({ 'bomb.bin': big, 'short.bin': enc('0123456789'), 'crc.txt': enc('checksum') });
    const cd = centralEntries(zip);
    setU32(zip, cd[0] + 24, 1000);      // bomb.bin claims 1,000 bytes
    setU32(zip, cd[1] + 24, 20);        // short.bin claims more than it holds
    setU32(zip, cd[2] + 16, 0xdeadbeef); // crc.txt has the wrong checksum
    const { m, result } = run(zip, 'zip');
    const r = await result;
    expect(r.entries).toEqual([]);
    expect(r.skipped.map(s => s.reason)).toEqual([
      'unpacks to more than its listed size, a sign of a decompression bomb; stopped',
      'damaged: it unpacks to less than its listed size',
      'damaged: its checksum does not match',
    ]);
    expect(m.state).toMatchObject({ open: 0, aborted: 3, finished: 0 });
  });

  test('an honest decompression bomb is stopped by the expansion limit, a large total by the total limit', async () => {
    const zeros = new Uint8Array(20 * 1048576);
    const r = await run(zipSync({ 'zeros.bin': zeros }), 'zip').result;
    expect(r.skipped[0].reason).toMatch(/^expands more than 100 times, a decompression bomb; stopped/);
    await expect(run(zipSync({ 'a.bin': new Uint8Array(3 * 1048576).fill(7) }, { level: 0 }), 'zip', 'x', { totalBytes: 2 * 1048576 }).result).rejects.toThrow(/add up to more than 2 MB/);
  });

  test('too many entries is refused from the directory, before anything is unpacked', async () => {
    const files: Zippable = {};
    for (let i = 0; i < 30; i++) files[`f${i}.txt`] = enc(String(i));
    const { m, result } = run(zipSync(files), 'zip', 'x', { entries: 25 });
    await expect(result).rejects.toThrow('The archive lists 30 files; the limit is 25.');
    expect(m.state.finished).toBe(0);
  });

  test('truncated and malformed ZIP files are refused with a reason', async () => {
    const zip = zipSync({ 'a.txt': enc('a'.repeat(5000)) });
    await expect(run(zip.subarray(0, zip.length - 30), 'zip').result).rejects.toThrow(/damaged or cut short/);
    const junk = new Uint8Array(200);
    junk.set([0x50, 0x4b, 3, 4]);
    await expect(run(junk, 'zip').result).rejects.toThrow(/damaged or cut short/);
  });

  test('a nested archive is unpacked as a file, never opened', async () => {
    const inner = zipSync({ 'deep.txt': enc('deep') });
    const r = await run(zipSync({ 'inner.zip': inner, 'top.txt': enc('top') }), 'zip').result;
    expect(r.entries.map(e => [e.path, e.size])).toEqual([['inner.zip', inner.length], ['top.txt', 3]]);
  });
});

describe('TAR', () => {
  test('files, ustar prefixes, long names (GNU and PAX); directories skipped; links and devices listed', async () => {
    const long = 'x'.repeat(150) + '.txt';
    const t = tar([
      { name: 'dir/', type: '5' },
      { name: 'dir/a.txt', data: 'alpha' },
      { name: 'b.txt', prefix: 'deep/path', data: 'beta' },
      { name: '././@LongLink', type: 'L', data: long + '\0' },
      { name: 'ignored', data: 'gnu long' },
      { name: 'PaxHeaders/x', type: 'x', data: `${('path=pax/' + long).length + 4} path=pax/${long}\n` },
      { name: 'ignored2', data: 'pax long' },
      { name: 'link', type: '2' },
      { name: 'hard', type: '1' },
      { name: 'dev', type: '3' },
    ]);
    const r = await run(t, 'tar').result;
    expect(r.entries.map(e => [e.path, e.size])).toEqual([['dir/a.txt', 5], ['deep/path/b.txt', 4], [long, 8], [`pax/${long}`, 8]]);
    expect(await text(r.entries[3].file)).toBe('pax long');
    expect(r.skipped).toEqual([
      { path: 'link', reason: 'a link to another file; links are not unpacked' },
      { path: 'hard', reason: 'a link to another file; links are not unpacked' },
      { path: 'dev', reason: 'a special file (device or pipe); not unpacked' },
    ]);
  });

  test('traversal names are shown safely; a bad checksum and a cut-off archive are refused', async () => {
    const r = await run(tar([{ name: '../../../etc/cron.d/evil', data: 'x' }]), 'tar').result;
    expect(r.entries[0].path).toBe('etc/cron.d/evil');
    expect(r.warnings[0]).toMatch(/^1 path pointed outside the archive/);
    const bad = tar([{ name: 'a.txt', data: 'a' }]);
    bad[0] ^= 1;
    await expect(run(bad, 'tar').result).rejects.toThrow('a header checksum does not match');
    const cut = tar([{ name: 'a.txt', data: 'a'.repeat(3000) }], false);
    await expect(run(cut.subarray(0, 1500), 'tar').result).rejects.toThrow('This TAR archive is cut short.');
    expect(isTarHeader(new Uint8Array(512))).toBe(false);
  });

  test('a size that is not a whole number is refused, from a PAX header or the header itself', async () => {
    for (const bad of ['abc', '-5', '1e309', '12.5']) {
      const record = ` size=${bad}\n`;
      const t = tar([{ name: 'PaxHeaders/x', type: 'x', data: `${record.length + String(record.length + 2).length}${record}` }, { name: 'a.txt', data: 'a' }]);
      await expect(run(t, 'tar').result, bad).rejects.toThrow('This TAR archive is damaged: a file size is not valid.');
    }
    const t = tar([{ name: 'a.txt', data: 'a' }]);
    t.set(new TextEncoder().encode('zzzzzzzzzzz\0'), 124);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : t[i];
    t.set(new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    await expect(run(t, 'tar').result).rejects.toThrow('This TAR archive is damaged: a file size is not valid.');
  });

  test('a GNU base-256 size is read; a block holding only a checksum is not a header', async () => {
    const t = tar([{ name: 'big.bin', data: 'hello' }]);
    // The size field in base-256: the top bit set, then the value big-endian.
    t.fill(0, 124, 136);
    t[124] = 0x80;
    t[135] = 5;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : t[i];
    t.set(new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    const r = await run(t, 'tar').result;
    expect(r.entries.map(e => [e.path, e.size])).toEqual([['big.bin', 5]]);
    expect(await text(r.entries[0].file)).toBe('hello');
    const empty = new Uint8Array(512);
    empty.set(new TextEncoder().encode('000400\0 '), 148);
    expect(isTarHeader(empty)).toBe(false);
  });

  test('the file limit counts files actually found', async () => {
    const t = tar(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
    await expect(run(t, 'tar', 'x', { entries: 5 }).result).rejects.toThrow('more than 5 files');
  });
});

describe('GZ', () => {
  test('one file, named from the gzip header or from the archive name', async () => {
    const named = gzipSync(enc('csv,data\n1,2\n'), { filename: 'report.csv' });
    expect(gzipName(named)).toBe('report.csv');
    const r = await run(named, 'gz', 'whatever.gz').result;
    expect(r.entries.map(e => [e.path, e.name])).toEqual([['report.csv', 'report.csv']]);
    expect(await text(r.entries[0].file)).toBe('csv,data\n1,2\n');
    const plain = await run(gzipSync(enc('hello')), 'gz', 'notes.txt.gz').result;
    expect(plain.entries[0].name).toBe('notes.txt');
  });

  test('a TAR inside gzip (.tar.gz, .tgz) is unpacked as a TAR', async () => {
    const r = await run(gzipSync(tar([{ name: 'a.txt', data: 'A' }, { name: 'b/c.txt', data: 'C' }])), 'gz', 'bundle.tgz').result;
    expect(r.entries.map(e => e.path)).toEqual(['a.txt', 'b/c.txt']);
  });

  test('a gzip bomb is stopped by the expansion limit; a wrong checksum is caught', async () => {
    await expect(run(gzipSync(new Uint8Array(20 * 1048576)), 'gz', 'z.gz').result).rejects.toThrow(/decompression bomb/);
    const gz = gzipSync(enc('some text'));
    gz[gz.length - 8] ^= 0xff;
    await expect(run(gz, 'gz', 'x.gz').result).rejects.toThrow('its checksum does not match');
  });
});

describe('names', () => {
  test('safePath', () => {
    expect(safePath('a/./b//c')).toEqual({ path: 'a/b/c', unsafe: false });
    expect(safePath('..\\..\\x')).toEqual({ path: 'x', unsafe: true });
    expect(safePath('D:/data/f.txt')).toEqual({ path: 'data/f.txt', unsafe: true });
    expect(safePath('')).toEqual({ path: 'unnamed', unsafe: false });
  });
});
