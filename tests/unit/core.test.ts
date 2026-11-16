import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { allConversions, effectiveCategory, engineFor, FORMATS, formatByExtension, targetsFor } from '../../src/core/formats';
import { NameRegistry, safeBase } from '../../src/core/naming';
import { looksLikeText, sniff } from '../../src/core/sniff';
import { decodeText } from '../../src/core/text';
import { checkZip } from '../../src/core/zipcheck';
import { readHeader } from '../../src/engines/image/header';
import { encodeBmp } from '../../src/engines/image/encoders';
import { expandTabs, wrapColumns } from '../../src/engines/document/text-to-pdf';
import { cmapCoverage, missingCharacters } from '../../src/engines/document/fonts';

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const sniffFile = (p: string, name = p.split('/').pop()!) => { const b = fx(p); return sniff(b.subarray(0, 65536), b.subarray(Math.max(0, b.length - 65536)), b.length, name); };

describe('format detection reads the bytes, not the name', () => {
  const cases: Array<[string, string | null]> = [
    ['image/alpha.png', 'png'], ['image/photo.jpg', 'jpg'], ['image/alpha.webp', 'webp'], ['image/alpha.avif', 'avif'],
    ['image/alpha.heic', 'heic'], ['image/photo.bmp', 'bmp'], ['image/photo.gif', 'gif'], ['image/alpha.tiff', 'tiff'],
    ['audio/tone.mp3', 'mp3'], ['audio/tagged.mp3', 'mp3'], ['audio/tone.wav', 'wav'], ['audio/tone.flac', 'flac'], ['audio/tone.aac', 'aac'],
    ['audio/tone.m4a', 'm4a'], ['audio/tone-vorbis.ogg', 'ogg'], ['audio/tone-opus.ogg', 'ogg'],
    ['video/clip.mp4', 'mp4'], ['video/clip.webm', 'webm'], ['video/clip.mov', 'mov'], ['video/clip.mkv', 'mkv'], ['video/clip.avi', null],
    ['document/sample.txt', 'txt'], ['document/sample.md', 'md'], ['document/sample.html', 'html'], ['document/sample.docx', 'docx'],
    ['document/scanned.pdf', 'pdf'], ['document/utf16.txt', 'txt'],
    ['data/records.json', 'json'], ['data/people.csv', 'csv'], ['data/config.yaml', 'yaml'], ['data/catalog.xml', 'xml'], ['data/workbook.xlsx', 'xlsx'],
    ['hostile/random.jpg', null],
  ];
  test.each(cases)('%s is %s', (p, want) => {
    expect(sniffFile(p).format).toBe(want);
  });

  test('a PNG named .jpg is converted as PNG, with a note', () => {
    const s = sniffFile('image/png-named.jpg');
    expect(s.format).toBe('png');
    expect(s.mismatch).toMatch(/Named \.jpg but contains PNG image data/);
  });

  test('extensions alone never decide a binary format', () => {
    const png = fx('image/alpha.png');
    expect(sniff(png, png, png.length, 'song.mp3').format).toBe('png');
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    expect(sniff(exe, exe, exe.length, 'invoice.pdf')).toMatchObject({ format: null, label: 'Windows program' });
  });

  test('unsupported files get a reason', () => {
    const avi = sniffFile('video/clip.avi');
    expect(avi.reason).toMatch(/AVI is not supported yet/);
    const zip = zipSync({ 'a.txt': new Uint8Array([65]) });
    expect(sniff(zip, zip, zip.length, 'x.zip').reason).toMatch(/Extract the files/);
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniff(svg, svg, svg.length, 'x.svg').label).toBe('SVG image');
  });

  test('text versus binary', () => {
    expect(looksLikeText(new TextEncoder().encode('hello\nworld'))).toBe(true);
    expect(looksLikeText(fx('document/utf16.txt'))).toBe(true);
    expect(looksLikeText(fx('image/photo.jpg'))).toBe(false);
  });
});

describe('format registry', () => {
  test('every listed conversion has an engine and a known output', () => {
    const pairs = allConversions();
    expect(pairs.length).toBeGreaterThan(100);
    for (const [from, to] of pairs) {
      expect(FORMATS[to]).toBeDefined();
      expect(engineFor(from, to, from === 'gif' ? { animated: true } : {})).toBeTruthy();
    }
  });

  test('HEIC is read but never offered as an output; AVI does not exist', () => {
    for (const [, to] of allConversions()) expect(to).not.toBe('heic');
    expect(formatByExtension('a.avi')).toBeNull();
  });

  test('the documents and data conversions are exactly the agreed ones', () => {
    expect(targetsFor('txt')).toEqual(['pdf']);
    expect(targetsFor('pdf')).toEqual(['txt']);
    expect(targetsFor('md')).toEqual(['html', 'pdf']);
    expect(targetsFor('html')).toEqual(['pdf']);
    expect(targetsFor('docx')).toEqual(['txt']);
    expect(targetsFor('json')).toEqual(['csv', 'yaml', 'xml']);
    expect(targetsFor('csv')).toEqual(['json', 'xlsx']);
    expect(targetsFor('yaml')).toEqual(['json']);
    expect(targetsFor('xml')).toEqual(['json']);
    expect(targetsFor('xlsx')).toEqual(['csv']);
  });

  test('inspection changes what is offered', () => {
    expect(targetsFor('gif', { animated: true })).toContain('mp4');
    expect(targetsFor('gif', { animated: false })).not.toContain('mp4');
    expect(effectiveCategory('mp4', { hasVideo: false })).toBe('audio');
    expect(targetsFor('mp4', { hasVideo: false, hasAudio: true })[0]).toBe('mp3');
    expect(targetsFor('mp4', { hasVideo: true, hasAudio: false })).not.toContain('mp3');
    expect(engineFor('mp4', 'gif', { hasVideo: true })).toBe('video-to-gif');
  });
});

describe('output names', () => {
  test('names are reduced to a safe base name', () => {
    expect(safeBase('../../etc/passwd.png')).toBe('passwd');
    expect(safeBase('C:\\Users\\x\\photo.final.jpg')).toBe('photo.final');
    expect(safeBase('con.png')).toBe('_con');
    expect(safeBase('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h');
    expect(safeBase('invoice\u202egpj.exe')).toBe('invoice_gpj');
    expect(safeBase('...')).toBe('file');
    expect(safeBase('  spaced   name .txt')).toBe('spaced name');
    expect(safeBase('x'.repeat(300) + '.txt').length).toBe(120);
  });

  test('two results never get the same name, case-insensitively', () => {
    const r = new NameRegistry();
    expect(r.claim('photo', 'png')).toBe('photo.png');
    expect(r.claim('Photo', 'PNG')).toBe('Photo (2).png');
    expect(r.claim('photo', 'png')).toBe('photo (3).png');
    r.release('photo.png');
    expect(r.claim('photo', 'png')).toBe('photo.png');
  });
});

describe('image headers', () => {
  test('dimensions and animation come from the header bytes', () => {
    expect(readHeader(fx('image/alpha.png'), 'png')).toMatchObject({ width: 320, height: 200, animated: false });
    expect(readHeader(fx('image/animated.png'), 'png')).toMatchObject({ animated: true, frames: 3 });
    expect(readHeader(fx('image/photo.jpg'), 'jpg')).toMatchObject({ width: 320, height: 200 });
    // Stored as 200 x 320 with EXIF orientation 6: shown, and converted, as 320 x 200.
    expect(readHeader(fx('image/rotated-exif6.jpg'), 'jpg')).toMatchObject({ width: 320, height: 200 });
    expect(readHeader(fx('image/animated.gif'), 'gif')).toMatchObject({ width: 64, height: 48, animated: true });
    // The GIF walk stops at frame two, so it must not claim a total (it would say 2 for any animation).
    expect(readHeader(fx('image/animated.gif'), 'gif').frames).toBeUndefined();
    expect(readHeader(fx('image/photo.gif'), 'gif')).toMatchObject({ animated: false, frames: 1 });
    expect(readHeader(fx('image/alpha.webp'), 'webp')).toMatchObject({ width: 320, height: 200 });
    expect(readHeader(fx('image/animated.webp'), 'webp')).toMatchObject({ animated: true });
    expect(readHeader(fx('image/photo.bmp'), 'bmp')).toMatchObject({ width: 320, height: 200 });
    expect(readHeader(fx('image/alpha.avif'), 'avif')).toMatchObject({ width: 320, height: 200 });
    expect(readHeader(fx('image/photo.heic'), 'heic')).toMatchObject({ width: 320, height: 200 });
  });

  test('a HEIF rotation (irot) of a quarter turn swaps the reported sides', () => {
    const box = (type: string, body: number[]) => { const n = 8 + body.length; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...[...type].map(c => c.charCodeAt(0)), ...body]; };
    const ispe = box('ispe', [0, 0, 0, 0, 0, 0, 0x0f, 0xa0, 0, 0, 0x0b, 0xb8]);
    const ftyp = box('ftyp', [...'heic'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0]));
    expect(readHeader(new Uint8Array([...ftyp, ...ispe, ...box('irot', [1])]), 'heic')).toMatchObject({ width: 3000, height: 4000 });
    expect(readHeader(new Uint8Array([...ftyp, ...ispe, ...box('irot', [2])]), 'heic')).toMatchObject({ width: 4000, height: 3000 });
    expect(readHeader(new Uint8Array([...ftyp, ...ispe]), 'heic')).toMatchObject({ width: 4000, height: 3000 });
  });

  test('a decompression bomb is visible before decoding', () => {
    const h = readHeader(fx('hostile/huge-dimensions.png'), 'png');
    expect(h.width! * h.height!).toBe(3.6e9);
  });
});

describe('BMP encoder', () => {
  test('writes a valid 24-bit bottom-up BMP with padded rows', () => {
    const w = 3, hgt = 2;
    const rgba = new Uint8Array(w * hgt * 4);
    rgba.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]);
    const b = encodeBmp(rgba, w, hgt);
    const dv = new DataView(b.buffer);
    expect(String.fromCharCode(b[0], b[1])).toBe('BM');
    expect(dv.getUint32(2, true)).toBe(b.length);
    expect(dv.getInt32(18, true)).toBe(3);
    expect(dv.getInt32(22, true)).toBe(2);
    expect(dv.getUint16(28, true)).toBe(24);
    expect(b.length).toBe(54 + 12 * 2);
    // First stored row is the bottom row: pixels (1,2,3), (4,5,6), (7,8,9) as BGR.
    expect([...b.subarray(54, 63)]).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7]);
    // Second stored row is the top row: red, green, blue.
    expect([...b.subarray(66, 75)]).toEqual([0, 0, 255, 0, 255, 0, 255, 0, 0]);
  });
});

describe('ZIP pre-flight check', () => {
  test('passes an ordinary package and lists its parts', () => {
    const entries = checkZip(fx('document/sample.docx'), 'document');
    expect(entries.map(e => e.name)).toContain('word/document.xml');
  });

  test('refuses a decompression bomb by declared size', () => {
    expect(() => checkZip(fx('hostile/zip-bomb.docx'), 'document')).toThrow(/would unpack to 1536 MB/);
  });

  test('refuses a bomb whose directory lies about the size, by inflating it', () => {
    const big = zipSync({ 'word/document.xml': new Uint8Array(8 * 1048576) }, { level: 9 });
    // Rewrite the declared size (central directory and local header) to 1 KB.
    const dv = new DataView(big.buffer);
    for (let i = 0; i < big.length - 4; i++) {
      const sig = dv.getUint32(i, true);
      if (sig === 0x02014b50) dv.setUint32(i + 24, 1024, true);
      if (sig === 0x04034b50) dv.setUint32(i + 22, 1024, true);
    }
    expect(() => checkZip(big, 'document')).toThrow(/more than its directory says/);
  });

  test('refuses an unpacked size over the limit given', () => {
    const z = zipSync({ 'a.xml': new Uint8Array(3 * 1048576) });
    expect(() => checkZip(z, 'workbook', 2 * 1048576)).toThrow(/would unpack to 3 MB/);
  });

  test('a file that is not a ZIP is an error, not a crash', () => {
    expect(() => checkZip(fx('image/alpha.png'), 'document')).toThrow(/not a valid ZIP/);
  });
});

describe('text', () => {
  test('encodings: BOMs, UTF-8, and the Windows-1252 fallback is reported', () => {
    expect(decodeText(fx('document/utf16.txt'))).toMatchObject({ encoding: 'utf-16le', bom: true });
    expect(decodeText(fx('document/utf16.txt')).text).toContain('caf\u00e9 \u2713');
    const latin = decodeText(fx('document/latin1.txt'));
    expect(latin.encoding).toBe('windows-1252');
    expect(latin.text).toContain('caf\u00e9, \u00a33');
    expect(latin.warning).toMatch(/Windows-1252/);
  });

  test('tabs expand to the next stop and long lines wrap by code point', () => {
    expect(expandTabs('a\tb', 4)).toBe('a   b');
    expect(expandTabs('\tx', 8)).toBe('        x');
    expect(wrapColumns('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(wrapColumns('\u{1F600}\u{1F600}\u{1F600}', 2)).toEqual(['\u{1F600}\u{1F600}', '\u{1F600}']);
  });

  test('font coverage: Noto Sans has Latin, Greek and Cyrillic but not CJK', () => {
    const font = new Uint8Array(readFileSync(join(__dirname, '..', '..', 'node_modules', '@expo-google-fonts', 'noto-sans', '400Regular', 'NotoSans_400Regular.ttf')));
    const covers = cmapCoverage(font);
    expect(missingCharacters('caf\u00e9 \u03ba\u03b1\u03bb\u03b7 \u043f\u0440\u0438', covers).count).toBe(0);
    expect(missingCharacters('\u6f22\u5b57 ok', covers)).toEqual({ count: 2, examples: ['\u6f22', '\u5b57'] });
  });
});

describe('DOCX text from Mammoth HTML', () => {
  test('paragraphs, breaks, nested lists, tables and entities', async () => {
    const { mammothHtmlToText } = await import('../../src/engines/document/docx');
    const html = '<h1>Title</h1><p>A line<br />broken &amp; joined</p><ul><li>One<ul><li>Sub</li></ul></li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol>'
      + '<table><tr><td><p>Name</p></td><td><p>Value</p></td></tr><tr><td><p>A</p><p>B</p></td><td><p>1</p></td></tr></table><p><img src="" />After</p>';
    const r = mammothHtmlToText(html);
    expect(r.text).toBe('Title\nA line\nbroken & joined\n- One\n  - Sub\n- Two\n1. First\n2. Second\nName\tValue\nA B\t1\nAfter\n');
    expect(r.images).toBe(1);
  });
});

describe('mutation-found gaps', () => {
  test('a password-protected package is refused', () => {
    const z = zipSync({ 'word/document.xml': new TextEncoder().encode('<w/>') });
    const dv = new DataView(z.buffer);
    for (let i = 0; i < z.length - 4; i++) {
      if (dv.getUint32(i, true) === 0x02014b50) dv.setUint16(i + 8, dv.getUint16(i + 8, true) | 1, true);
    }
    expect(() => checkZip(z, 'document')).toThrow(/password protected/);
  });

  test('JPEG size comes from the frame header even when a Huffman table comes first', () => {
    const seg = (m: number, body: number[]) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
    const bytes = new Uint8Array([0xff, 0xd8, ...seg(0xc4, new Array(20).fill(7)), ...seg(0xc0, [8, 0x01, 0x2c, 0x02, 0x58, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])]);
    expect(readHeader(bytes, 'jpg')).toMatchObject({ width: 600, height: 300 });
  });
});
