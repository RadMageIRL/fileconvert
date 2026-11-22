import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, convert, cspViolations, download, expectDone, openApp, pillow, row, unexpectedViolations } from './helpers';

// SVG to pixels (v0.2.0). Every SVG is hostile until cleaned: these tests convert drawings that try every way an
// SVG can run code or fetch something, and record every request the page and its workers make. The drawing must
// still come out right, nothing may run, and nothing may be requested except the app's own code.

const RED_BOX = '<rect x="0" y="0" width="40" height="30" fill="#ff0000"/>';
/** A 2 x 2 blue PNG, embedded as a data URL: the one kind of picture an SVG may carry. */
const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxAAGAAsfAQMU4wsAAAAAAElFTkSuQmCC';

const KITCHEN_SINK = `<?xml version="1.0"?>
<?xml-stylesheet href="https://example.com/pi.css" type="text/css"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="30" viewBox="0 0 40 30" onload="fetch('https://example.com/onload'); window.top.__pwned = 1">
  <style>@import url(https://example.com/import.css); @import "https://example.com/import-string.css"; @font-face { font-family: x; src: url(https://example.com/font.woff); } .e { fill: url(https://example.com/paint.svg#p); }</style>
  <style>rect.esc { background: u\\72l(https://example.com/escaped); }</style>
  <script>window.top.__pwned = 2; fetch('https://example.com/script');</script>
  ${RED_BOX}
  <image x="30" y="0" width="10" height="10" href="data:image/png;base64,${BLUE_PNG}"/>
  <image href="https://example.com/remote.png" width="5" height="5"/>
  <image xlink:href="/fileconvert/LICENSE.txt" width="5" height="5"/>
  <image href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxpbWFnZSBocmVmPSJodHRwczovL2V4YW1wbGUuY29tL25lc3RlZC5wbmciLz48L3N2Zz4=" width="5" height="5"/>
  <use href="https://example.com/sprite.svg#icon"/>
  <rect class="e" x="0" y="25" width="1" height="1" style="filter: url(https://example.com/filter.svg#f)"/>
  <circle cx="1" cy="1" r="1" fill="url(https://example.com/fill.svg#g)" onclick="fetch('https://example.com/click')"/>
  <filter id="f"><feImage href="https://example.com/feimage.png"/></filter>
  <a href="javascript:window.top.__pwned=3"><rect x="0" y="0" width="1" height="1" fill="#ff0000"/></a>
  <animate attributeName="href" values="javascript:alert(1)"/>
  <set attributeName="onmouseover" to="fetch('https://example.com/set')"/>
  <foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://example.com/frame"/><img xmlns="http://www.w3.org/1999/xhtml" src="https://example.com/fo.png"/></foreignObject>
</svg>`;

/** Records every request after the app is ready, from the page and its workers. */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', r => seen.push(r.url()));
  return seen;
}

const svgFile = (name: string, text: string) => ({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(text) });

test('a hostile SVG is drawn correctly while nothing in it runs and nothing is fetched', async ({ page }, info) => {
  const w = await openApp(page);
  const requests = recordRequests(page);
  await page.locator('#picker').setInputFiles([svgFile('attack.svg', KITCHEN_SINK)]);
  await convert(page, 'attack.svg', 'PNG');
  await expectDone(page, 'attack.svg');
  const { path } = await download(page, 'attack.svg', info);
  const p = pillow(path, [[10, 10], [35, 5], [20, 28]]);
  expect(p.size).toEqual([40, 30]);
  expect(p.px[0]).toEqual([255, 0, 0, 255]);
  expect(p.px[1]).toEqual([0, 0, 255, 255]); // the embedded PNG is drawn
  expect(p.px[2]).toEqual([255, 0, 0, 255]);
  const notes = row(page, 'attack.svg').locator('.job-notes');
  // The script element and the javascript: link.
  await expect(notes).toContainText('2 scripts were removed; nothing in the file ran.');
  // onload and onclick (the <set> that adds one is animation).
  await expect(notes).toContainText('2 event handlers were removed.');
  // Exact, so that each kind is known to be removed: the stylesheet instruction, @import (both forms), @font-face, three CSS
  // url()s, the remote and same-origin images, the nested SVG image, <use> and <feImage>.
  await expect(notes).toContainText('12 references to files, fonts or stylesheets outside the SVG were removed; nothing was downloaded.');
  await expect(notes).toContainText('1 block of HTML content (foreignObject) was removed');
  await expect(notes).toContainText('Animation was removed');
  await expect(notes).toContainText('A stylesheet with CSS escapes was removed');
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  // Only the app's own code may load; no other site, and not the same-origin file the SVG pointed at.
  const own = new URL('./', ORIGIN + '/fileconvert/').pathname;
  for (const u of requests) {
    const url = new URL(u);
    if (url.protocol === 'blob:' || url.protocol === 'data:') continue;
    expect(url.origin, u).toBe(ORIGIN);
    expect(url.pathname, u).toMatch(new RegExp(`^${own}(assets|pdfjs)/`));
  }
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('SVGs that declare entities, are too large to draw, or are not valid XML are refused with a reason', async ({ page }) => {
  await openApp(page);
  const requests = recordRequests(page);
  await page.locator('#picker').setInputFiles([
    svgFile('bomb.svg', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>'),
    svgFile('xxe.svg', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>'),
    svgFile('huge.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000">${RED_BOX}</svg>`),
    svgFile('broken.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>'),
  ]);
  for (const [name, message] of [['bomb.svg', 'declares entities'], ['xxe.svg', 'declares entities'], ['huge.svg', 'more than the limit'], ['broken.svg', 'not valid XML']] as const) {
    await convert(page, name, 'PNG');
    await expect(row(page, name), name).toHaveClass(/failed/);
    await expect(row(page, name).locator('.job-error'), name).toContainText(message);
  }
  for (const u of requests) if (!u.startsWith('blob:') && !u.startsWith('data:')) expect(new URL(u).pathname, u).toMatch(/\/(assets|pdfjs)\//);
});

test('size: units and viewBox give the drawing its size, the SVG size setting scales it, and it stays sharp', async ({ page }, info) => {
  await openApp(page);
  const drawing = (attrs: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  await page.locator('#picker').setInputFiles([
    svgFile('mm.svg', drawing('width="20mm" height="10mm" viewBox="0 0 20 10"')),
    svgFile('viewbox.svg', drawing('viewBox="0 0 64 32"')),
    svgFile('nosize.svg', drawing('')),
  ]);
  const sizes: Record<string, number[]> = {};
  for (const n of ['mm.svg', 'viewbox.svg', 'nosize.svg']) {
    await convert(page, n, 'PNG');
    await expectDone(page, n);
    sizes[n] = pillow((await download(page, n, info)).path).size;
  }
  expect(sizes).toEqual({ 'mm.svg': [76, 38], 'viewbox.svg': [64, 32], 'nosize.svg': [300, 150] });

  const panel = page.locator('details.panel[data-cat="image"]');
  await panel.locator('summary').click();
  await panel.getByLabel('SVG size').selectOption('1024');
  await convert(page, 'viewbox.svg', 'JPG');
  await expectDone(page, 'viewbox.svg');
  const big = pillow((await download(page, 'viewbox.svg', info)).path, [[1, 256], [1022, 256], [512, 256]]);
  expect(big.size).toEqual([1024, 512]);
  // The internal gradient reference is kept: dark on the left, light on the right.
  expect(big.px[0][0]).toBeLessThan(20);
  expect(big.px[1][0]).toBeGreaterThan(235);
  await expect(row(page, 'viewbox.svg').locator('.job-notes')).toContainText("Drawn at 1024 x 512 pixels; the SVG's own size is 64 x 32.");
  expect(await cspViolations(page)).toEqual([]);
});

test('transparency: PNG keeps it, JPG fills it with the background color', async ({ page }, info) => {
  await openApp(page);
  await page.locator('#picker').setInputFiles([svgFile('dot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="4" fill="#00ff00"/></svg>')]);
  await convert(page, 'dot.svg', 'PNG');
  const png = pillow((await download(page, 'dot.svg', info)).path, [[0, 0], [10, 10]]);
  expect(png.px).toEqual([[0, 0, 0, 0], [0, 255, 0, 255]]);
  await convert(page, 'dot.svg', 'JPG');
  const jpg = pillow((await download(page, 'dot.svg', info)).path, [[0, 0]]);
  expect(jpg.px[0].slice(0, 3).every(v => v > 245)).toBe(true);
});
