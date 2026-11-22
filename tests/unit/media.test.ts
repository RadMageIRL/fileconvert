import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { extended80, readAiff, toWavOrder, wavHeader, wavView } from '../../src/engines/media/aiff';
import { tsStreams, unreadableStreams } from '../../src/engines/media/tsinfo';

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));
const blob = (p: string) => new Blob([fx(p)]);

describe('AIFF', () => {
  test('reads the layout of each kind: rate, channels, sample size and where the samples are', async () => {
    expect(await readAiff(blob('audio/tone16.aiff'))).toMatchObject({ channels: 2, sampleRate: 44100, bits: 16, kind: 'pcm-be', dataLength: 44100 * 4 });
    expect(await readAiff(blob('audio/tone24-mono.aiff'))).toMatchObject({ channels: 1, sampleRate: 48000, bits: 24, kind: 'pcm-be' });
    expect(await readAiff(blob('audio/tone-sowt.aifc'))).toMatchObject({ kind: 'pcm-le', bits: 16 });
    expect(await readAiff(blob('audio/tone-float.aifc'))).toMatchObject({ kind: 'float-be', bits: 32 });
    expect(await readAiff(blob('audio/tone-ulaw.aifc'))).toMatchObject({ kind: 'ulaw', bits: 8, sampleRate: 8000 });
    await expect(readAiff(blob('audio/tone-ima4.aifc'))).rejects.toThrow('compressed with IMA ADPCM');
    await expect(readAiff(new Blob([fx('audio/tone16.aiff').subarray(0, 60)]))).rejects.toThrow('This AIFF file is cut short: its sound data is missing.');
  });

  test('the 80-bit sample rate, the WAV header, and samples turned to WAV order', () => {
    expect(extended80(new Uint8Array([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]), 0)).toBe(44100);
    const h = wavHeader({ channels: 2, sampleRate: 44100, bits: 16, kind: 'pcm-be', dataOffset: 0, dataLength: 400 });
    expect(new TextDecoder().decode(h.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(h.buffer).getUint16(20, true)).toBe(1);
    expect(new DataView(h.buffer).getUint32(40, true)).toBe(400);
    const be = new Uint8Array([0x12, 0x34, 0xab, 0xcd]);
    toWavOrder(be, { channels: 1, sampleRate: 1, bits: 16, kind: 'pcm-be', dataOffset: 0, dataLength: 4 });
    expect([...be]).toEqual([0x34, 0x12, 0xcd, 0xab]);
    const s8 = new Uint8Array([0x00, 0x7f, 0x80]);
    toWavOrder(s8, { channels: 1, sampleRate: 1, bits: 8, kind: 'pcm-be', dataOffset: 0, dataLength: 3 });
    expect([...s8]).toEqual([0x80, 0xff, 0x00]);
  });

  test('the WAV view reads the same bytes whichever ranges are asked for, even ones that split a sample', async () => {
    const b = blob('audio/tone24-mono.aiff');
    const view = wavView(b, await readAiff(b));
    const whole = await view.read(0, view.getSize());
    for (const [s, e] of [[0, 10], [43, 47], [44, 45], [45, 1001], [1000, 1003], [view.getSize() - 5, view.getSize()]]) {
      expect([...await view.read(s, e)]).toEqual([...whole.subarray(s, e)]);
    }
  });
});

describe('MPEG transport stream tables', () => {
  test('streams by type, including a private stream and the 192-byte M2TS layout', () => {
    expect(tsStreams(fx('video/clip-h264-aac.ts')).map(s => [s.kind, s.name])).toEqual([['video', 'H.264'], ['audio', 'AAC']]);
    expect(tsStreams(fx('video/clip-h264-ac3.ts')).map(s => s.name)).toEqual(['H.264', 'AC-3']);
    expect(tsStreams(fx('video/clip-mpeg2-mp2.ts')).map(s => s.name)).toEqual(['MPEG-2 video', 'MPEG-1 audio']);
    expect(tsStreams(fx('video/clip.m2ts')).map(s => [s.kind, s.name])).toEqual([['video', 'H.264'], ['other', 'a private stream']]);
    expect(tsStreams(fx('video/clip.mp4'))).toEqual([]);
  });

  test('what cannot be read is named', () => {
    expect(unreadableStreams(tsStreams(fx('video/clip-mpeg2-mp2.ts')), { video: 0, audio: 1 })).toEqual({ video: 'MPEG-2 video', audio: [] });
    expect(unreadableStreams(tsStreams(fx('video/clip.m2ts')), { video: 1, audio: 0 }).audio[0]).toMatch(/private stream, as AVCHD camcorders do/);
    expect(unreadableStreams(tsStreams(fx('video/clip-h264-ac3.ts')), { video: 1, audio: 0 }).audio[0]).toMatch(/^1 of its sound tracks \(AC-3\) cannot be read/);
    expect(unreadableStreams(tsStreams(fx('video/clip-h264-aac.ts')), { video: 1, audio: 1 })).toEqual({ video: null, audio: [] });
  });
});
