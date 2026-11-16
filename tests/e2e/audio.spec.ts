import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { addFiles, convert, convertAllTo, cspViolations, download, downloadZip, expectDone, ffdecode, ffprobe, fx, openApp, row, tempDir, writeTemp } from './helpers';

function aacSeconds(path: string): number {
  const [rate, packets] = execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=sample_rate,nb_read_packets', '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim().split(',').map(Number);
  return (packets * 1024) / rate;
}

const INPUTS = ['tone.wav', 'tone.mp3', 'tagged.mp3', 'tone.flac', 'tone.aac', 'tone.m4a', 'tone-vorbis.ogg', 'tone-opus.ogg'];
// Output label, extension, FFmpeg's container name (any of), codec.
const OUTPUTS: Array<[string, string, string, string]> = [
  ['MP3', 'mp3', 'mp3', 'mp3'],
  ['WAV', 'wav', 'wav', 'pcm_s16le'],
  ['FLAC', 'flac', 'flac', 'flac'],
  ['AAC', 'aac', 'aac', 'aac'],
  ['M4A', 'm4a', 'mov,mp4,m4a,3gp,3g2,mj2', 'aac'],
  ['OGG', 'ogg', 'ogg', 'opus'],
];

test.describe('every audio input to every audio output', () => {
  for (const [label, ext, container, codec] of OUTPUTS) {
    test(`to ${label}`, async ({ page }, info) => {
      test.slow();
      const w = await openApp(page);
      await addFiles(page, INPUTS.map(f => fx(`audio/${f}`)));
      await convertAllTo(page, label);
      for (const f of INPUTS) await expectDone(page, f);
      const zip = await downloadZip(page, info);
      const names = Object.keys(zip.entries).sort();
      expect(names).toHaveLength(INPUTS.length);
      // Five inputs are named tone.*, so the results are tone.ext, tone (2).ext and so on, never overwritten.
      expect(names.filter(n => n.startsWith('tone'))).toHaveLength(7);
      expect(new Set(names.map(n => n.toLowerCase())).size).toBe(names.length);
      const dir = tempDir();
      for (const name of names) {
        const path = writeTemp(dir, name, zip.entries[name]);
        expect(name.endsWith(`.${ext}`)).toBe(true);
        const probe = ffprobe(path);
        const a = probe.streams.filter(s => s.codec_type === 'audio');
        expect(a, name).toHaveLength(1);
        expect(probe.streams.filter(s => s.codec_type === 'video'), name).toHaveLength(0);
        expect(probe.format.format_name, name).toBe(container);
        expect(a[0].codec_name, name).toBe(codec);
        expect(Number(a[0].channels), name).toBe(2);
        // Raw AAC (ADTS) has no duration field; FFmpeg only estimates it from the bitrate, so count the frames.
        const seconds = ext === 'aac' ? aacSeconds(path) : Number(probe.format.duration);
        expect(Math.abs(seconds - 3), `${name} lasts ${seconds}`).toBeLessThan(0.12);
        ffdecode(path);
      }
      expect(w.errors).toEqual([]);
      expect(await cspViolations(page)).toEqual([]);
      expect(w.outside).toEqual([]);
    });
  }
});

test('bitrate, sample rate and channel settings are applied', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('audio/tone.wav')]);
  await page.locator('details[data-cat="audio"] summary').click();
  const panel = page.locator('details[data-cat="audio"]');
  await panel.getByRole('combobox', { name: /Bitrate/ }).selectOption('96');
  await panel.getByRole('combobox', { name: 'Channels' }).selectOption('1');
  await panel.getByRole('combobox', { name: 'Sample rate' }).selectOption('48000');
  await convert(page, 'tone.wav', 'MP3');
  await expectDone(page, 'tone.wav');
  const low = ffprobe((await download(page, 'tone.wav', info)).path);
  expect(low.streams[0].channels).toBe(1);
  expect(Number(low.streams[0].sample_rate)).toBe(48000);
  expect(Number(low.format.bit_rate)).toBeLessThan(110_000);
  await panel.getByRole('combobox', { name: /Bitrate/ }).selectOption('320');
  await panel.getByRole('combobox', { name: 'Channels' }).selectOption('0');
  await convert(page, 'tone.wav', 'MP3');
  const high = ffprobe((await download(page, 'tone.wav', info)).path);
  expect(high.streams[0].channels).toBe(2);
  expect(Number(high.format.bit_rate)).toBeGreaterThan(280_000);
});

test('round trip: WAV to FLAC to WAV is lossless', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('audio/tone.wav')]);
  await convert(page, 'tone.wav', 'FLAC');
  const flac = (await download(page, 'tone.wav', info)).path;
  await page.locator('#clear').click();
  await addFiles(page, [flac]);
  const name = flac.split(/[\\/]/).pop()!;
  await convert(page, name, 'WAV');
  await expectDone(page, name);
  const wav = (await download(page, name, info)).path;
  const { readFileSync } = await import('node:fs');
  const pcm = (p: string) => { const b = readFileSync(p); const i = b.indexOf('data'); return b.subarray(i + 8); };
  expect(Buffer.compare(pcm(wav), pcm(fx('audio/tone.wav')))).toBe(0);
});

test('audio a browser cannot decode is reported before converting', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('audio/tone-alac.m4a')]);
  await expect(row(page, 'tone-alac.m4a')).toHaveClass(/unsupported/);
  await expect(row(page, 'tone-alac.m4a').locator('.job-error')).toContainText(/cannot decode|could not be read|cannot read/);
});
