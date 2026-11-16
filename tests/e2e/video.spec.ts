import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { addFiles, convert, convertAllTo, cspViolations, download, downloadZip, expectDone, ffdecode, ffprobe, fx, openApp, pillow, row, tempDir, writeTemp } from './helpers';

const INPUTS = ['clip.mp4', 'clip.webm', 'clip-vp8.webm', 'clip.mov', 'clip.mkv'];
const OUTPUTS: Array<[string, string, string, string, string | null]> = [
  // label, extension, FFmpeg container, video codec, audio codec
  ['MP4', 'mp4', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac'],
  ['WebM', 'webm', 'matroska,webm', 'vp9', 'opus'],
  ['MOV', 'mov', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac'],
  ['MKV', 'mkv', 'matroska,webm', 'h264', 'aac'],
];

/** A longer 720p clip made with FFmpeg, for resizing, cancellation and progress. Cached per run. */
function bigClip(seconds = 20): string {
  const dir = join(tmpdir(), 'fileconvert-media');
  const p = join(dir, `big-${seconds}.mp4`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(p)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]);
  }
  return p;
}

test.describe('every video input to every video output', () => {
  for (const [label, ext, container, vcodec, acodec] of OUTPUTS) {
    test(`to ${label}`, async ({ page }, info) => {
      test.slow();
      const w = await openApp(page);
      await addFiles(page, INPUTS.map(f => fx(`video/${f}`)));
      await convertAllTo(page, label, 300_000);
      for (const f of INPUTS) await expectDone(page, f);
      const zip = await downloadZip(page, info);
      const dir = tempDir();
      const names = Object.keys(zip.entries);
      expect(names).toHaveLength(INPUTS.length);
      for (const name of names) {
        const path = writeTemp(dir, name, zip.entries[name]);
        expect(name.endsWith(`.${ext}`), name).toBe(true);
        const probe = ffprobe(path);
        expect(probe.format.format_name, name).toBe(container);
        const v = probe.streams.filter(s => s.codec_type === 'video');
        const a = probe.streams.filter(s => s.codec_type === 'audio');
        expect(v, name).toHaveLength(1);
        expect(v[0].codec_name, name).toBe(vcodec);
        expect([v[0].width, v[0].height], name).toEqual([320, 240]);
        expect(a, name).toHaveLength(1);
        expect(a[0].codec_name, name).toBe(acodec);
        expect(Math.abs(Number(probe.format.duration) - 2), `${name} lasts ${probe.format.duration}`).toBeLessThan(0.15);
        ffdecode(path);
      }
      expect(w.errors).toEqual([]);
      expect(await cspViolations(page)).toEqual([]);
      expect(w.outside).toEqual([]);
    });
  }
});

test('video to GIF', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip.mp4')]);
  await convert(page, 'clip.mp4', 'GIF');
  await expectDone(page, 'clip.mp4');
  await expect(row(page, 'clip.mp4').locator('.job-notes')).toContainText('GIF has no sound');
  const gif = pillow((await download(page, 'clip.mp4', info)).path);
  expect(gif.format).toBe('GIF');
  expect(gif.size).toEqual([320, 240]);
  expect(gif.frames).toBe(20);
});

test('copying streams into another container is exact: MP4 to MKV keeps the packets', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip.mp4')]);
  await convert(page, 'clip.mp4', 'MKV');
  const mkv = (await download(page, 'clip.mp4', info)).path;
  const hash = (p: string, s: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-map', s, '-c', 'copy', '-f', 'hash', '-hash', 'md5', '-'], { encoding: 'utf8' }).trim();
  expect(hash(mkv, '0:v:0')).toBe(hash(fx('video/clip.mp4'), '0:v:0'));
  expect(hash(mkv, '0:a:0')).toBe(hash(fx('video/clip.mp4'), '0:a:0'));
});

test('audio extraction from video, and removing the sound', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip.mov')]);
  await convert(page, 'clip.mov', 'MP3');
  const mp3 = ffprobe((await download(page, 'clip.mov', info)).path);
  expect(mp3.streams.map(s => s.codec_type)).toEqual(['audio']);
  expect(mp3.streams[0].codec_name).toBe('mp3');
  await convert(page, 'clip.mov', 'M4A');
  const m4a = ffprobe((await download(page, 'clip.mov', info)).path);
  expect(m4a.streams.map(s => s.codec_name)).toEqual(['aac']);
  await page.locator('details[data-cat="video"] summary').click();
  await page.getByRole('checkbox', { name: 'Remove the sound' }).check();
  await convert(page, 'clip.mov', 'MP4');
  const silent = ffprobe((await download(page, 'clip.mov', info)).path);
  expect(silent.streams.map(s => s.codec_type)).toEqual(['video']);
});

test('rotation metadata is respected', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('video/rotated.mp4')]);
  await expect(row(page, 'rotated.mp4').locator('.job-info')).toContainText('240 x 320');
  await convert(page, 'rotated.mp4', 'WebM');
  await expectDone(page, 'rotated.mp4');
  const out = (await download(page, 'rotated.mp4', info)).path;
  const frame = join(tempDir(), 'f.png');
  execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-frames:v', '1', frame]);
  expect(pillow(frame).size).toEqual([240, 320]);
});

test('resolution: 720p down to 360p, never enlarged, with real progress', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  const big = bigClip(8);
  await addFiles(page, [big, fx('video/clip.mp4')]);
  await page.locator('details[data-cat="video"] summary').click();
  await page.locator('details[data-cat="video"]').getByRole('combobox', { name: 'Resolution' }).selectOption('360');
  const name = big.split(/[\\/]/).pop()!;
  await page.evaluate(() => {
    (window as unknown as { __fractions: number[] }).__fractions = [];
    new MutationObserver(() => {
      const p = document.querySelector('li.job.converting progress') as HTMLProgressElement | null;
      if (p && p.hasAttribute('value')) (window as unknown as { __fractions: number[] }).__fractions.push(p.value);
    }).observe(document.getElementById('queue')!, { subtree: true, childList: true, attributes: true });
  });
  await convert(page, name, 'MP4', 240_000);
  await expectDone(page, name);
  const fractions = await page.evaluate(() => (window as unknown as { __fractions: number[] }).__fractions);
  const distinct = new Set(fractions.map(f => Math.round(f * 100)));
  expect(distinct.size, `progress values ${[...distinct].join(',')}`).toBeGreaterThan(3);
  expect([...distinct].every(v => v >= 0 && v <= 100)).toBe(true);
  const v = ffprobe((await download(page, name, info)).path).streams.find(s => s.codec_type === 'video')!;
  expect([v.width, v.height]).toEqual([640, 360]);
  await convert(page, 'clip.mp4', 'MP4');
  const small = ffprobe((await download(page, 'clip.mp4', info)).path).streams.find(s => s.codec_type === 'video')!;
  expect([small.width, small.height]).toEqual([320, 240]);
});

test('cancel stops a conversion, frees its temporary file, and the file can be converted again', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  const big = bigClip(20);
  const name = big.split(/[\\/]/).pop()!;
  await addFiles(page, [big]);
  await page.locator('details[data-cat="video"] summary').click();
  await page.locator('details[data-cat="video"]').getByRole('combobox', { name: 'Quality' }).selectOption('medium');
  await page.locator('details[data-cat="video"]').getByRole('combobox', { name: 'Resolution' }).selectOption('480');
  const r = row(page, name);
  await expect(r).toHaveClass(/ready/);
  await r.locator('select').first().selectOption({ label: 'WebM' });
  await r.getByRole('button', { name: 'Convert' }).click();
  await expect(r.locator('progress')).toHaveAttribute('value', /0\.[1-9]/, { timeout: 60_000 });
  // The page keeps responding while the video encodes in the background.
  const lag = await page.evaluate(() => new Promise<number>(res => { const t = performance.now(); setTimeout(() => res(performance.now() - t), 0); }));
  expect(lag).toBeLessThan(200);
  expect((await page.evaluate(() => (window as unknown as { __fileconvert: { tempFiles(): Promise<string[]> } }).__fileconvert.tempFiles())).length).toBe(1);
  await r.getByRole('button', { name: 'Cancel' }).click();
  await expect(r).toHaveClass(/canceled/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fileconvert: { tempFiles(): Promise<string[]> } }).__fileconvert.tempFiles())).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __fileconvert: { engines: { media: { active: number } } } }).__fileconvert.engines.media.active)).toBe(0);
  await page.locator('details[data-cat="video"]').getByRole('combobox', { name: 'Quality' }).selectOption('original');
  await page.locator('details[data-cat="video"]').getByRole('combobox', { name: 'Resolution' }).selectOption('0');
  await convert(page, name, 'MKV', 120_000);
  await expectDone(page, name);
  expect(ffprobe((await download(page, name, info)).path).format.format_name).toBe('matroska,webm');
  expect((await page.evaluate(() => (window as unknown as { __fileconvert: { tempFiles(): Promise<string[]> } }).__fileconvert.tempFiles())).length).toBe(1);
  await page.locator('#clear').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fileconvert: { tempFiles(): Promise<string[]> } }).__fileconvert.tempFiles())).toEqual([]);
});

test('AVI and undecodable inputs are explained', async ({ page }) => {
  await openApp(page);
  await addFiles(page, [fx('video/clip.avi')]);
  await expect(row(page, 'clip.avi')).toHaveClass(/unsupported/);
  await expect(row(page, 'clip.avi').locator('.job-error')).toContainText('AVI is not supported yet');
});

test('every video input to GIF and to every audio format', async ({ page }, info) => {
  test.slow();
  await openApp(page);
  await addFiles(page, INPUTS.map(f => fx(`video/${f}`)));
  await convertAllTo(page, 'GIF', 300_000);
  for (const f of INPUTS) await expectDone(page, f);
  const gifs = await downloadZip(page, info);
  const dir = tempDir();
  for (const [name, data] of Object.entries(gifs.entries)) {
    const im = pillow(writeTemp(dir, name, data));
    expect(im.format, name).toBe('GIF');
    expect(im.size, name).toEqual([320, 240]);
    expect(im.frames, name).toBe(20);
  }
  for (const [label, codec] of [['MP3', 'mp3'], ['WAV', 'pcm_s16le'], ['FLAC', 'flac'], ['AAC', 'aac'], ['M4A', 'aac'], ['OGG', 'opus']]) {
    await convertAllTo(page, label, 300_000);
    for (const f of INPUTS) await expectDone(page, f);
    const zip = await downloadZip(page, info);
    for (const [name, data] of Object.entries(zip.entries)) {
      const path = writeTemp(dir, `${label}-${name}`, data);
      const probe = ffprobe(path);
      expect(probe.streams.map(s => s.codec_type), name).toEqual(['audio']);
      expect(probe.streams[0].codec_name, name).toBe(codec);
      ffdecode(path);
    }
  }
});

test('descriptive tags are kept, a recording location is not', async ({ page }, info) => {
  const dir = tempDir();
  const src = join(dir, 'tagged.mov');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx('video/clip.mov'), '-c', 'copy', '-metadata', 'title=Fixture Clip', '-metadata', 'artist=FileConvert tests',
    '-metadata', 'location=+40.4462-079.9822/', '-movflags', 'use_metadata_tags', src]);
  expect(JSON.stringify(ffprobe(src).format)).toContain('+40.4462-079.9822');
  await openApp(page);
  await addFiles(page, [src, fx('audio/tagged.mp3')]);
  await convert(page, 'tagged.mov', 'MP4');
  await expectDone(page, 'tagged.mov');
  const tags = JSON.stringify(ffprobe((await download(page, 'tagged.mov', info)).path).format);
  expect(tags).toContain('Fixture Clip');
  expect(tags).toContain('FileConvert tests');
  expect(tags).not.toContain('40.4462');
  await convert(page, 'tagged.mp3', 'FLAC');
  const flac = JSON.stringify(ffprobe((await download(page, 'tagged.mp3', info)).path).format);
  expect(flac).toContain('Fixture Tone');
  expect(flac).toContain('FileConvert tests');
});

test('raw container fields such as a location or a private note are not carried over', async ({ page }, info) => {
  // Without the tag filter, Mediabunny carries raw fields into outputs of the same family (MKV to MKV,
  // MP3 to MP3), so these are the cases that prove the filter works.
  const dir = tempDir();
  const mkv = join(dir, 'located.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx('video/clip.mkv'), '-c', 'copy', '-metadata', 'title=Fixture Clip', '-metadata', 'LOCATION=+40.4462-079.9822/', mkv]);
  const mp3 = join(dir, 'private.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx('audio/tagged.mp3'), '-c', 'copy', '-metadata', 'PRIVATE_NOTE=secret-raw-value', '-id3v2_version', '3', mp3]);
  expect(JSON.stringify(ffprobe(mkv).format)).toContain('40.4462');
  expect(JSON.stringify(ffprobe(mp3).format)).toContain('secret-raw-value');
  await openApp(page);
  await addFiles(page, [mkv, mp3]);
  await convert(page, 'located.mkv', 'MKV');
  await expectDone(page, 'located.mkv');
  const v = JSON.stringify(ffprobe((await download(page, 'located.mkv', info)).path).format);
  expect(v).toContain('Fixture Clip');
  expect(v).not.toContain('40.4462');
  await convert(page, 'private.mp3', 'MP3');
  await expectDone(page, 'private.mp3');
  const a = JSON.stringify(ffprobe((await download(page, 'private.mp3', info)).path).format);
  expect(a).toContain('Fixture Tone');
  expect(a).not.toContain('secret-raw-value');
});

test('M4A to AAC copies the audio frames without re-encoding them', async ({ page }, info) => {
  await openApp(page);
  await addFiles(page, [fx('audio/tone.m4a')]);
  await convert(page, 'tone.m4a', 'AAC');
  const aac = (await download(page, 'tone.m4a', info)).path;
  const sizes = (p: string) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', p], { encoding: 'utf8' }).trim().split(/\r?\n/).map(l => parseInt(l, 10));
  // The same frames, each with the 7-byte ADTS header added: copied, not re-encoded.
  expect(sizes(aac).map(n => n - 7)).toEqual(sizes(fx('audio/tone.m4a')));
});
