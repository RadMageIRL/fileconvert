import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { PYTHON, addFiles, convertAllTo, downloadZip, expectDone, fx, near, openApp, pillow, tempDir, writeTemp } from './helpers';

// The picture formats added in v0.2.0 in the full matrix: ICO and SVG to every picture output, and every picture
// input to ICO. images.spec.ts covers the v0.1 inputs to the v0.1 outputs. Every result is read by Pillow.

const OUTPUTS: Array<[string, string, string]> = [
  ['JPG', 'jpg', 'JPEG'], ['PNG', 'png', 'PNG'], ['WebP', 'webp', 'WEBP'], ['AVIF', 'avif', 'AVIF'],
  ['GIF', 'gif', 'GIF'], ['BMP', 'bmp', 'BMP'], ['TIFF', 'tiff', 'TIFF'],
];
/** A 40 x 30 red drawing with a blue square in the top right corner. */
const DRAWING = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#ff0000"/><rect x="30" width="10" height="10" fill="#0000ff"/></svg>');
const SVG = { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: DRAWING };

/** The sizes in an ICO and the alpha of each picture's top-left pixel, as Pillow reads them. */
function icoSizes(path: string): Array<{ size: number[]; corner: number }> {
  const script = [
    'import sys, json', 'from PIL import Image', 'im = Image.open(sys.argv[1]); out = []',
    'assert im.format == "ICO", im.format',
    'for s in sorted(im.info["sizes"]):',
    '    im.size = s; im.load(); a = im.convert("RGBA"); out.append({"size": list(a.size), "corner": a.getpixel((0, 0))[3]})',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync(PYTHON, ['-I', '-c', script, path], { encoding: 'utf8' }));
}

test.describe('ICO and SVG to every picture output', () => {
  for (const [label, ext, pilFormat] of OUTPUTS) {
    test(`to ${label}`, async ({ page }, info) => {
      const w = await openApp(page);
      await addFiles(page, [fx('image/icon-png.ico'), SVG]);
      await convertAllTo(page, label);
      await expectDone(page, 'icon-png.ico');
      await expectDone(page, 'drawing.svg');
      const zip = await downloadZip(page, info);
      expect(Object.keys(zip.entries).sort()).toEqual([`drawing.${ext}`, `icon-png.${ext}`]);
      const dir = tempDir();
      // The largest picture in the icon is the one converted.
      expect(pillow(writeTemp(dir, `icon-png.${ext}`, zip.entries[`icon-png.${ext}`])).size).toEqual([256, 256]);
      const svg = pillow(writeTemp(dir, `drawing.${ext}`, zip.entries[`drawing.${ext}`]), [[10, 10], [35, 5]]);
      expect(svg.format).toBe(pilFormat);
      expect(svg.size).toEqual([40, 30]);
      expect(near(svg.px[0], [255, 0, 0], 40), `red: ${svg.px[0]}`).toBe(true);
      expect(near(svg.px[1], [0, 0, 255], 40), `blue: ${svg.px[1]}`).toBe(true);
      expect(w.outside).toEqual([]);
    });
  }
});

test('every picture input to ICO: a favicon with 16, 32 and 48 pixel pictures, a wide picture centered', async ({ page }, info) => {
  test.slow();
  const inputs = ['alpha.png', 'alpha.webp', 'alpha.avif', 'alpha.heic', 'alpha.tiff', 'photo.jpg', 'photo.bmp', 'photo.gif', 'icon-bmp.ico'];
  await openApp(page);
  await addFiles(page, [...inputs.map(f => fx(`image/${f}`)), SVG]);
  await convertAllTo(page, 'ICO');
  for (const f of [...inputs, 'drawing.svg']) await expectDone(page, f);
  const zip = await downloadZip(page, info);
  const dir = tempDir();
  expect(Object.keys(zip.entries)).toHaveLength(inputs.length + 1);
  for (const [name, data] of Object.entries(zip.entries)) {
    expect(name).toMatch(/\.ico$/);
    const sizes = icoSizes(writeTemp(dir, name, data));
    expect(sizes.map(s => s.size), name).toEqual([[16, 16], [32, 32], [48, 48]]);
    // 320 x 200 pictures and the 40 x 30 drawing are wider than tall: the top rows are transparent padding.
    if (!name.startsWith('icon-bmp')) for (const s of sizes) expect(s.corner, `${name} ${s.size}`).toBe(0);
  }
});
