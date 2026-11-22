import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { PYTHON, convert, download, expectDone, ffprobe, fx, openApp, row } from './helpers';

// Animated pictures (v0.2.0): animation is kept as GIF, WebP, MP4 and WebM, with each frame's timing, the loop
// count, disposal, blending and transparency. Outputs are read back by Pillow (pixels) and by parsing the WebP
// file itself (frame durations and loop count, which Pillow reports shifted by one frame).

interface Frames { frames: number; durations: number[]; loop: number | null; px: number[][][] }

const POINTS: Array<[number, number]> = [[8, 15], [20, 15], [31, 15], [3, 3]];

/** Frame count, durations, loop count and sample pixels of each frame of an animated GIF or WebP. */
function frames(path: string): Frames {
  const script = [
    'import sys, json, struct', 'from PIL import Image',
    'im = Image.open(sys.argv[1]); px = []; durations = []',
    'for i in range(im.n_frames):', '    im.seek(i); f = im.convert("RGBA"); px.append([list(f.getpixel(p)) for p in json.loads(sys.argv[2])]); durations.append(im.info.get("duration"))',
    'loop = im.info.get("loop")',
    'b = open(sys.argv[1], "rb").read()',
    'if b[:4] == b"RIFF":',
    '    durations = []; p = 12',
    '    while p + 8 <= len(b):',
    '        t = b[p:p+4]; n = struct.unpack("<I", b[p+4:p+8])[0]',
    '        if t == b"ANMF": durations.append(int.from_bytes(b[p+8+12:p+8+15], "little"))',
    '        if t == b"ANIM": loop = struct.unpack("<H", b[p+8+4:p+8+6])[0]',
    '        p += 8 + n + (n & 1)',
    'print(json.dumps({"frames": im.n_frames, "durations": durations, "loop": loop, "px": px}))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path, JSON.stringify(POINTS)], { encoding: 'utf8' }));
}

/** Pixels match within a tolerance; two fully transparent pixels match whatever their color. */
const close = (a: number[], b: number[], tol: number) => (a[3] === 0 && b[3] === 0) || a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Opens the app and adds a file. */
async function add(page: Page, file: string) {
  await openApp(page);
  await page.locator('#picker').setInputFiles([fx(file)]);
}

test('the output menu says which formats keep the animation', async ({ page }) => {
  await add(page, 'image/anim-alpha.webp');
  const menu = row(page, 'anim-alpha.webp').getByRole('combobox', { name: 'Convert anim-alpha.webp to' });
  await expect(menu.locator('option')).toContainText(['PNG (first frame)', 'JPG (first frame)', 'WebP (animated)', 'GIF (animated)', 'MP4', 'WebM']);
  await expect(row(page, 'anim-alpha.webp').locator('.job-notes')).toContainText('only the first frame will be kept');
});

test('GIF to animated WebP: every disposal method, the timing and the loop come through', async ({ page }, info) => {
  await add(page, 'image/anim-dispose.gif');
  await convert(page, 'anim-dispose.gif', 'WebP (animated)');
  await expectDone(page, 'anim-dispose.gif');
  const src = frames(fx('image/anim-dispose.gif'));
  const out = frames((await download(page, 'anim-dispose.gif', info)).path);
  expect(out.frames).toBe(4);
  expect(out.durations).toEqual([100, 200, 300, 400]);
  expect(out.loop).toBe(0);
  for (let f = 0; f < 4; f++) for (let p = 0; p < POINTS.length; p++) expect(close(out.px[f][p], src.px[f][p], 12), `frame ${f} point ${p}: ${out.px[f][p]} vs ${src.px[f][p]}`).toBe(true);
  await expect(row(page, 'anim-dispose.gif').locator('.job-status')).toContainText('4 frames, animated');
});

test('APNG with blending and restore-to-previous: frames as the PNG specification defines them, as GIF and WebP', async ({ page }, info) => {
  // Worked out from the APNG specification: blue; then half red blended over it (purple, opaque) in the middle;
  // then the middle restored to blue and a green spot blended in the top-left corner.
  const blue = [0, 0, 255, 255], purple = [128, 0, 127, 255], green = [0, 255, 0, 255];
  // Sample points: (8, 15), (20, 15), (31, 15), (3, 3); the blended square covers x 10 to 29, y 5 to 24.
  const expected = [[blue, blue, blue, blue], [blue, purple, blue, blue], [blue, blue, blue, green]];
  await add(page, 'image/anim-blend.png');
  for (const [label, tol, loop] of [['GIF (animated)', 8, 1], ['WebP (animated)', 12, 2]] as const) {
    await convert(page, 'anim-blend.png', label);
    await expectDone(page, 'anim-blend.png');
    const out = frames((await download(page, 'anim-blend.png', info)).path);
    expect(out.frames, label).toBe(3);
    expect(out.durations, label).toEqual([100, 250, 500]);
    // Plays twice: WebP stores the number of plays; GIF stores repeats after the first play.
    expect(out.loop, label).toBe(loop);
    for (let f = 0; f < 3; f++) for (let p = 0; p < POINTS.length; p++) expect(close(out.px[f][p], expected[f][p], tol), `${label} frame ${f} point ${p}: ${out.px[f][p]}`).toBe(true);
  }
});

test('animated WebP to GIF keeps timing and on/off transparency, and says partly transparent pixels changed', async ({ page }, info) => {
  await add(page, 'image/anim-alpha.webp');
  await convert(page, 'anim-alpha.webp', 'GIF (animated)');
  await expectDone(page, 'anim-alpha.webp');
  const out = frames((await download(page, 'anim-alpha.webp', info)).path);
  expect(out.frames).toBe(3);
  expect(out.durations).toEqual([120, 80, 300]);
  expect(out.loop).toBe(0);
  expect(out.px[0][0]).toEqual([255, 0, 0, 255]);
  expect(out.px[0][2][3]).toBe(0);
  expect(out.px[2][1]).toEqual([0, 160, 0, 255]);
  await expect(row(page, 'anim-alpha.webp').locator('.job-notes')).toContainText('partly transparent pixels became fully opaque or fully transparent');
});

test('animated APNG and WebP to MP4 and WebM: every frame, for as long as it lasts', async ({ page }, info) => {
  await add(page, 'image/anim-blend.png');
  await page.locator('#picker').setInputFiles([fx('image/anim-alpha.webp')]);
  for (const [file, to, seconds] of [['anim-blend.png', 'MP4', 0.85], ['anim-alpha.webp', 'WebM', 0.5]] as const) {
    await convert(page, file, to);
    await expectDone(page, file);
    const probe = ffprobe((await download(page, file, info)).path);
    const v = probe.streams.find(s => s.codec_type === 'video')!;
    // Firefox cannot encode H.264 at this tiny size; FileConvert then uses VP9 in the MP4 and says so.
    if (to === 'MP4' && v.codec_name !== 'h264') {
      expect(v.codec_name, file).toBe('vp9');
      await expect(row(page, file).locator('.job-notes')).toContainText('cannot encode H.264 at this size');
    } else expect(v.codec_name, file).toBe(to === 'MP4' ? 'h264' : 'vp9');
    expect(Number(probe.format.duration), file).toBeCloseTo(seconds, 1);
    const count = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', (await download(page, file, info)).path], { encoding: 'utf8' }).trim();
    expect(Number(count), file).toBe(3);
  }
});
