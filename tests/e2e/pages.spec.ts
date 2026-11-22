import { expect, test, type Page } from '@playwright/test';
import { FORMATS, type FormatId } from '../../src/core/formats';
import { PAGES, type ConversionPage } from '../../src/core/pages';
import { MD_SAMPLE, ORIGIN, addFiles, convert, cspViolations, download, expectDone, ffprobe, fx, openApp, pillow, ready, row, type FilePayload } from './helpers';

// The dedicated conversion pages: each one loads directly and on refresh, carries its own head and content
// in the HTML (no script needed), chooses its output for the files added, and works at 320 pixels.

/** A sample file for each input format a page is about. */
const SAMPLE: Partial<Record<FormatId, string | FilePayload>> = {
  heic: fx('image/photo.heic'), webp: fx('image/alpha.webp'), png: fx('image/alpha.png'), jpg: fx('image/photo.jpg'),
  avif: fx('image/alpha.avif'), gif: fx('image/animated.gif'), mp4: fx('video/clip.mp4'), mov: fx('video/clip.mov'),
  mkv: fx('video/clip.mkv'), webm: fx('video/clip.webm'), wav: fx('audio/tone.wav'), m4a: fx('audio/tone.m4a'),
  flac: fx('audio/tone.flac'), pdf: fx('document/sample.pdf'), md: MD_SAMPLE, json: fx('data/records.json'),
  csv: fx('data/people.csv'), xlsx: fx('data/workbook.xlsx'),
};
const sampleName = (s: string | FilePayload) => typeof s === 'string' ? s.split(/[\\/]/).pop()! : s.name;

/** Opens a page and records errors, CSP violations and outside requests, like openApp does for the home page. */
async function openPage(page: Page, p: ConversionPage) {
  const w = { errors: [] as string[], outside: [] as string[] };
  page.on('pageerror', e => w.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) w.errors.push(m.text()); });
  page.on('request', r => { const u = new URL(r.url()); if (!['blob:', 'data:'].includes(u.protocol) && u.origin !== ORIGIN) w.outside.push(r.url()); });
  const res = await page.goto(`./${p.slug}/`);
  expect(res?.status(), p.slug).toBe(200);
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
  return w;
}

test('every page loads directly and on refresh, with its own title, heading and canonical address', async ({ page }) => {
  for (const p of PAGES) {
    const w = await openPage(page, p);
    const name = `${FORMATS[p.from].label} to ${FORMATS[p.to].label}`;
    await expect(page).toHaveTitle(`${name} Converter, Free and Private | FileConvert`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Convert ${FORMATS[p.from].label} to ${FORMATS[p.to].label}`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://radmagelabs.com/fileconvert/${p.slug}/`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', p.description);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'FileConvert' })).toHaveAttribute('href', '../');
    await page.reload();
    await expect(page.locator('html[data-ready="true"]')).toBeAttached();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Convert ${FORMATS[p.from].label} to ${FORMATS[p.to].label}`);
    expect(w.errors, p.slug).toEqual([]);
    expect(w.outside, p.slug).toEqual([]);
    expect(await cspViolations(page), p.slug).toEqual([]);
  }
});

test('the content is in the HTML itself, for search engines and for browsers without scripts', async ({ browser, request }) => {
  for (const p of PAGES) {
    const res = await request.get(`./${p.slug}/`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<h2 id="guide-title">How to convert ${FORMATS[p.from].label} to ${FORMATS[p.to].label}</h2>`);
    for (const d of p.details) expect(html).toContain(d.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;'));
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]);
    expect(ld['@graph'][1]['@type']).toBe('BreadcrumbList');
    for (const r of p.related) expect(html).toContain(`href="../${r}/"`);
  }
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('./mov-to-mp4/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Convert MOV to MP4');
  await expect(page.getByRole('heading', { name: 'What happens to your files' })).toBeVisible();
  await page.getByRole('link', { name: 'MKV to MP4' }).first().click();
  await expect(page).toHaveURL(/\/fileconvert\/mkv-to-mp4\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Convert MKV to MP4');
  await ctx.close();
});

test('an address without its trailing slash is redirected, and an unknown one gets the 404 page', async ({ page, request }) => {
  const res = await request.get('./heic-to-jpg', { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(res.headers().location).toBe('/fileconvert/heic-to-jpg/');
  const missing = await request.get('./no-such-conversion/');
  expect(missing.status()).toBe(404);
  const html = await missing.text();
  expect(html).toContain('<meta name="robots" content="noindex">');
  expect(html).not.toContain('<script type="module"');
  // The 404 page is served at any depth, so its links are absolute.
  await page.goto('./deep/no/such/page/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await page.getByRole('link', { name: 'JSON to CSV' }).click();
  await expect(page).toHaveURL(/\/fileconvert\/json-to-csv\/$/);
  await expect(page.locator('html[data-ready="true"]')).toBeAttached();
});

test('the sitemap lists the home page and every page, and each address works here', async ({ request }) => {
  const xml = await (await request.get('./sitemap.xml')).text();
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  expect(locs).toEqual(['https://radmagelabs.com/fileconvert/', ...PAGES.map(p => `https://radmagelabs.com/fileconvert/${p.slug}/`)]);
  for (const loc of locs) {
    const local = await request.get(`./${loc.slice('https://radmagelabs.com/fileconvert/'.length)}`);
    expect(local.status(), loc).toBe(200);
  }
});

test('each page chooses its output for the files added, and leaves other files their usual default', async ({ page }) => {
  for (const p of PAGES) {
    await openPage(page, p);
    const sample = SAMPLE[p.from]!;
    await addFiles(page, [sample]);
    const name = sampleName(sample);
    await ready(page, name);
    await expect(row(page, name), p.slug).toHaveClass(/ready/);
    await expect(row(page, name).getByRole('combobox', { name: `Convert ${name} to` }), p.slug).toHaveValue(p.to);
  }
  // A file that cannot become JPG keeps its own first choice on the HEIC to JPG page.
  await openPage(page, PAGES.find(p => p.slug === 'heic-to-jpg')!);
  await addFiles(page, [fx('data/records.json')]);
  await ready(page, 'records.json');
  await expect(row(page, 'records.json').getByRole('combobox', { name: 'Convert records.json to' })).toHaveValue('csv');
});

test('converting on a page: HEIC to JPG and MP4 to MP3, checked by Pillow and FFmpeg', async ({ page }, info) => {
  await openPage(page, PAGES.find(p => p.slug === 'heic-to-jpg')!);
  await addFiles(page, [fx('image/photo.heic')]);
  await ready(page, 'photo.heic');
  await row(page, 'photo.heic').getByRole('button', { name: 'Convert' }).click();
  await expect(row(page, 'photo.heic')).toHaveClass(/done/, { timeout: 90_000 });
  const jpg = await download(page, 'photo.heic', info);
  expect(jpg.filename).toBe('photo.jpg');
  expect(pillow(jpg.path).format).toBe('JPEG');

  await openPage(page, PAGES.find(p => p.slug === 'mp4-to-mp3')!);
  await addFiles(page, [fx('video/clip.mp4')]);
  await convert(page, 'clip.mp4', 'MP3');
  await expectDone(page, 'clip.mp4');
  const mp3 = await download(page, 'clip.mp4', info);
  expect(mp3.filename).toBe('clip.mp3');
  const probe = ffprobe(mp3.path);
  expect(probe.streams.map(s => s.codec_name)).toEqual(['mp3']);
});

test('Share on a page passes that page\'s public address', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __shared: unknown[] }).__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: unknown) => { (window as unknown as { __shared: unknown[] }).__shared.push(d); } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  });
  await openPage(page, PAGES.find(p => p.slug === 'webp-to-png')!);
  await page.getByRole('button', { name: 'Share' }).click();
  const shared = await page.evaluate(() => (window as unknown as { __shared: Array<{ url: string }> }).__shared);
  expect(shared.map(s => s.url)).toEqual(['https://radmagelabs.com/fileconvert/webp-to-png/']);
});

test('320 pixels wide: no sideways scrolling on the home page with files, or on any page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  await page.locator('#picker').setInputFiles([
    { name: 'a-very-long-file-name-without-any-spaces-at-all-to-test-wrapping-in-narrow-layouts.png', mimeType: 'image/png', buffer: (await import('node:fs')).readFileSync(fx('image/alpha.png')) },
  ]);
  await addFiles(page, [fx('video/clip.mp4'), fx('data/workbook.xlsx'), fx('audio/tone.wav')]);
  await expect(page.locator('li.job.checking')).toHaveCount(0);
  for (const d of await page.locator('details.panel').all()) await d.locator('summary').click();
  await page.locator('#catalog-search').fill('mp3');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  for (const p of PAGES) {
    await page.goto(`./${p.slug}/`);
    await expect(page.locator('html[data-ready="true"]')).toBeAttached();
    expect(await overflow(), p.slug).toBeLessThanOrEqual(0);
  }
  await page.goto('./missing-page/');
  expect(await overflow()).toBeLessThanOrEqual(0);
});
