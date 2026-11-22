import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { addFiles, convert, download, expectDone, ffdecode, ffprobe, fx, openApp, ready, row } from './helpers';

// AIFF and MPEG-TS input (v0.2.0), checked by FFmpeg: lossless results must decode to exactly the samples FFmpeg
// decodes from the source, and transport streams must give the codecs, duration and frames they hold.

/** The samples of a file as FFmpeg decodes them: mono or stereo 16-bit little-endian at the file's own rate. */
function samples(path: string): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
}

/** Largest difference between two 16-bit sample buffers, or Infinity when their lengths differ. */
function maxDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i += 2) m = Math.max(m, Math.abs(a.readInt16LE(i) - b.readInt16LE(i)));
  return m;
}

/** Decoded video frames. A transport stream lists its streams once per program too, so only the first line counts. */
const frameCount = (path: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim().split(/\s+/)[0]);

test('AIFF to WAV and FLAC is lossless: the same samples as the source, with metadata chunks read past', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('audio/tone16.aiff')]);
  await ready(page, 'tone16.aiff');
  await expect(row(page, 'tone16.aiff').locator('.job-info')).toContainText('AIFF audio');
  for (const to of ['WAV', 'FLAC']) {
    await convert(page, 'tone16.aiff', to);
    await expectDone(page, 'tone16.aiff');
    const out = (await download(page, 'tone16.aiff', info)).path;
    expect(maxDiff(samples(out), samples(fx('audio/tone16.aiff'))), to).toBe(0);
  }
});

test('AIFF-C and other AIFF sample kinds: 24-bit, signed 8-bit, little-endian, float and mu-law', async ({ page }, info) => {
  await openApp(page);
  const files = ['tone24-mono.aiff', 'tone8.aiff', 'tone-sowt.aifc', 'tone-float.aifc', 'tone-ulaw.aifc'];
  await addFiles(page, files.map(f => fx(`audio/${f}`)));
  for (const f of files) {
    await convert(page, f, 'WAV');
    await expectDone(page, f);
    const out = (await download(page, f, info)).path;
    ffdecode(out);
    // 24-bit and float sources are rounded to 16 bits for WAV; the rest must match exactly.
    expect(maxDiff(samples(out), samples(fx(`audio/${f}`))), f).toBeLessThanOrEqual(f.includes('24') || f.includes('float') ? 1 : 0);
  }
  await convert(page, 'tone24-mono.aiff', 'MP3');
  await expectDone(page, 'tone24-mono.aiff');
  const mp3 = ffprobe((await download(page, 'tone24-mono.aiff', info)).path);
  expect(mp3.streams[0].codec_name).toBe('mp3');
  expect(Number(mp3.format.duration)).toBeCloseTo(1, 1);
});

test('a compressed AIFF-C is refused, naming its codec', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('audio/tone-ima4.aifc')]);
  await ready(page, 'tone-ima4.aifc');
  await expect(row(page, 'tone-ima4.aifc')).toHaveClass(/unsupported/);
  await expect(row(page, 'tone-ima4.aifc').locator('.job-error')).toContainText('compressed with IMA ADPCM, which FileConvert cannot decode');
});

test('MPEG-TS with H.264 and AAC: to MP4 with every frame copied, and to MP3', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip-h264-aac.ts')]);
  await ready(page, 'clip-h264-aac.ts');
  await expect(row(page, 'clip-h264-aac.ts').locator('.job-info')).toContainText('H.264');
  await convert(page, 'clip-h264-aac.ts', 'MP4');
  await expectDone(page, 'clip-h264-aac.ts');
  const mp4 = (await download(page, 'clip-h264-aac.ts', info)).path;
  const probe = ffprobe(mp4);
  expect(probe.streams.map(s => s.codec_name).sort()).toEqual(['aac', 'h264']);
  expect(Number(probe.format.duration)).toBeCloseTo(2, 0);
  expect(frameCount(mp4)).toBe(frameCount(fx('video/clip-h264-aac.ts')));
  ffdecode(mp4);
  await convert(page, 'clip-h264-aac.ts', 'MP3');
  await expectDone(page, 'clip-h264-aac.ts');
  expect(ffprobe((await download(page, 'clip-h264-aac.ts', info)).path).streams[0].codec_name).toBe('mp3');
});

test('M2TS from a camcorder: the picture converts, and sound in a private stream is named rather than dropped silently', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip.m2ts')]);
  await ready(page, 'clip.m2ts');
  await expect(row(page, 'clip.m2ts').locator('.job-notes')).toContainText('sound in a private stream, as AVCHD camcorders do, which FileConvert cannot read');
  await convert(page, 'clip.m2ts', 'MP4');
  await expectDone(page, 'clip.m2ts');
  const probe = ffprobe((await download(page, 'clip.m2ts', info)).path);
  expect(probe.streams.map(s => s.codec_name)).toEqual(['h264']);
  expect(Number(probe.format.duration)).toBeCloseTo(2, 0);
});

test('MPEG-TS with AC-3 sound: Edge keeps the sound, other browsers convert the picture and say why', async ({ page, browserName }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip-h264-ac3.ts')]);
  await ready(page, 'clip-h264-ac3.ts');
  const edge = await page.evaluate(async () => (await AudioDecoder.isConfigSupported({ codec: 'ac-3', sampleRate: 48000, numberOfChannels: 2 })).supported === true);
  await convert(page, 'clip-h264-ac3.ts', 'MP4');
  await expectDone(page, 'clip-h264-ac3.ts');
  const probe = ffprobe((await download(page, 'clip-h264-ac3.ts', info)).path);
  if (edge) expect(probe.streams.map(s => s.codec_name).sort()).toEqual(['aac', 'h264']);
  else {
    expect(probe.streams.map(s => s.codec_name)).toEqual(['h264']);
    await expect(row(page, 'clip-h264-ac3.ts').locator('.job-notes')).toContainText('The audio is AC-3, which this browser cannot decode; only the video can be converted, without sound.');
  }
  void browserName;
});

test('MPEG-TS with MPEG-2 video (TV recordings): the video is named as not decodable, and its MPEG audio converts correctly', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip-mpeg2-mp2.ts')]);
  await ready(page, 'clip-mpeg2-mp2.ts');
  await expect(row(page, 'clip-mpeg2-mp2.ts').locator('.job-notes')).toContainText('The video is MPEG-2 video, which FileConvert cannot decode (TV recordings and DVDs often use it). Only the sound can be converted.');
  const menu = row(page, 'clip-mpeg2-mp2.ts').getByRole('combobox', { name: 'Convert clip-mpeg2-mp2.ts to' });
  await expect(menu.locator('option')).toHaveText(['MP3', 'WAV', 'FLAC', 'AAC', 'M4A', 'OGG']);
  await convert(page, 'clip-mpeg2-mp2.ts', 'WAV');
  await expectDone(page, 'clip-mpeg2-mp2.ts');
  const out = (await download(page, 'clip-mpeg2-mp2.ts', info)).path;
  // The browser decodes the MPEG audio; it must give what FFmpeg decodes from the same stream, give or take rounding.
  const a = samples(out), b = samples(fx('video/clip-mpeg2-mp2.ts'));
  expect(Math.abs(a.length - b.length)).toBeLessThan(4 * 1152 * 2);
  const n = Math.min(a.length, b.length) - (Math.min(a.length, b.length) % 2);
  expect(maxDiff(a.subarray(0, n), b.subarray(0, n))).toBeLessThanOrEqual(2);
});
