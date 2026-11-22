import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { answers, NOT_SUPPORTED, parseQuery } from '../../src/app/catalog';
import { allConversions, FORMATS } from '../../src/core/formats';
import { commonPages, pageName, pageTitle, PAGES } from '../../src/core/pages';
import { fillRegion, fillStatics, pageProblems, pageUrl, render404, renderPage, settingsHint, SITE, sitemapXml, stripMarkers } from '../../src/site/render';

const template = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
/** The home page as the build makes it, with its static content filled in. */
const home = fillStatics(template);
const byName = (slug: string) => PAGES.find(p => p.slug === slug)!;

describe('the page list', () => {
  test('has no problems: real conversions, unique slugs, titles and descriptions, existing related pages', () => {
    expect(pageProblems()).toEqual([]);
  });

  test('holds the planned pages whose conversions are in place', () => {
    expect(PAGES.map(p => p.slug).sort()).toEqual([
      'avif-to-jpg', 'csv-to-json', 'flac-to-mp3', 'gif-to-mp4', 'heic-to-jpg', 'heic-to-png', 'jpg-to-png', 'json-to-csv',
      'json-to-xlsx', 'm4a-to-mp3', 'markdown-to-pdf', 'mkv-to-mp4', 'mov-to-mp4', 'mp4-to-gif', 'mp4-to-mp3', 'pdf-to-text',
      'png-to-ico', 'png-to-jpg', 'png-to-webp', 'wav-to-mp3', 'webm-to-mp4', 'webp-to-jpg', 'webp-to-png', 'xlsx-to-csv', 'xlsx-to-json',
    ]);
  });

  test('every page names a conversion the registry performs', () => {
    const pairs = new Set(allConversions().map(([a, b]) => `${a}>${b}`));
    for (const p of PAGES) expect(pairs.has(`${p.from}>${p.to}`), p.slug).toBe(true);
  });

  test('the checks catch a page for a conversion that does not exist, and duplicates', () => {
    const fake = { ...byName('heic-to-jpg'), slug: 'jpg-to-heic', from: 'jpg' as const, to: 'heic' as const };
    (PAGES as unknown as unknown[]).push(fake, { ...byName('png-to-jpg') });
    try {
      const problems = pageProblems();
      expect(problems).toContain('page jpg-to-heic: FileConvert does not convert jpg to heic');
      expect(problems).toContain('page jpg-to-heic: duplicate description');
      expect(problems).toContain('page png-to-jpg: duplicate slug');
    } finally {
      (PAGES as unknown as unknown[]).splice(-2, 2);
    }
  });

  test('titles fit in search results and the common list is ordered and unique', () => {
    for (const p of PAGES) expect(pageTitle(p).length, p.slug).toBeLessThanOrEqual(60);
    const common = commonPages().map(p => p.common);
    expect(common).toEqual([...common].sort((a, b) => a! - b!));
    expect(new Set(common).size).toBe(common.length);
  });

  test('each page says which settings apply, in words', () => {
    expect(settingsHint(byName('heic-to-jpg'))).toMatch(/^Images settings/);
    expect(settingsHint(byName('mp4-to-mp3'))).toMatch(/^Audio settings/);
    expect(settingsHint(byName('mp4-to-gif'))).toMatch(/GIF width/);
    expect(settingsHint(byName('mov-to-mp4'))).toMatch(/^Video settings/);
    expect(settingsHint(byName('json-to-csv'))).toMatch(/^Data settings/);
    expect(settingsHint(byName('markdown-to-pdf'))).toMatch(/page size/);
    expect(settingsHint(byName('pdf-to-text'))).toBe('');
  });
});

describe('rendering', () => {
  test('a region must exist exactly once', () => {
    expect(() => fillRegion('<p></p>', 'hero', 'x')).toThrow(/exactly one <!--fc:hero-->/);
    expect(() => fillRegion('<!--fc:a--><!--/fc:a--><!--fc:a--><!--/fc:a-->', 'a', 'x')).toThrow(/found 2/);
    expect(fillRegion('<!--fc:a-->old<!--/fc:a-->', 'a', '$& new')).toBe('<!--fc:a-->$& new<!--/fc:a-->');
  });

  test('the home page gets its catalog, formats and limits as static HTML', () => {
    const out = stripMarkers(home);
    expect(out).not.toMatch(/<!--\/?fc:/);
    for (const p of PAGES) expect(out).toContain(`<a href="./${p.slug}/"><span class="cat-name">${pageName(p)}</span>`);
    expect(out).toContain('<h2 id="common-title">Common conversions</h2>');
    expect(out).toContain('<b>JPG, PNG, WebP, AVIF, HEIC, BMP, GIF, TIFF, ICO</b> to JPG, PNG, WebP, AVIF, GIF, BMP, TIFF, ICO');
    expect(out).toMatch(/<li>Size limits: pictures up to 100 megapixels and 300 MB/);
    expect(out).toContain('<p class="promise">Convert files. Upload nothing.</p>');
  });

  test('a conversion page has its own head, heading, guide and canonical address, one folder down', () => {
    const p = byName('heic-to-jpg');
    const html = stripMarkers(renderPage(home, p));
    expect(html).toContain('<title>HEIC to JPG Converter, Free and Private | FileConvert</title>');
    expect(html).toContain(`<meta name="description" content="${p.description}">`);
    expect(html).toContain('<link rel="canonical" href="https://radmagelabs.com/fileconvert/heic-to-jpg/">');
    expect(html).toContain('<meta property="og:url" content="https://radmagelabs.com/fileconvert/heic-to-jpg/">');
    expect(html).toContain('data-root="../" data-page="heic-to-jpg" data-from="heic" data-to="jpg"');
    expect(html).toContain('<h1 id="title">Convert HEIC to JPG</h1>');
    expect(html).toContain('<h2 id="guide-title">How to convert HEIC to JPG</h2>');
    expect(html).toContain('<strong>Drop HEIC files here</strong>');
    expect(html).toContain('<li class="cat-item current" data-cat="image" data-slug="heic-to-jpg" ');
    expect(html).toContain('<a href="../heic-to-jpg/" aria-current="page">');
    expect(html).toContain('<a href="../">FileConvert</a>');
    expect(html).not.toContain('<h2 id="common-title">');
    // Only one head: the home page's title, description and canonical address are gone.
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).not.toContain('href="https://radmagelabs.com/fileconvert/">');
    // Every relative link points one folder up; none still points at the page's own folder.
    expect(html).not.toMatch(/\b(href|src)="\.\//);
  });

  test('the structured data is valid JSON with a breadcrumb, with every "<" escaped so the script element stays closed', () => {
    const html = renderPage(home, byName('mp4-to-mp3'));
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1];
    const data = JSON.parse(json);
    expect(data['@graph'][0]).toMatchObject({ '@type': 'WebApplication', url: 'https://radmagelabs.com/fileconvert/mp4-to-mp3/' });
    expect(data['@graph'][1].itemListElement.map((i: { name: string }) => i.name)).toEqual(['FileConvert', 'MP4 to MP3']);
    expect(json).not.toContain('<');
  });

  test('every page is different where it matters', () => {
    const titles = new Set<string>(), descriptions = new Set<string>(), bodies = new Set<string>();
    for (const p of PAGES) {
      const html = renderPage(home, p);
      titles.add(/<title>(.*?)<\/title>/.exec(html)![1]);
      descriptions.add(/<meta name="description" content="(.*?)">/.exec(html)![1]);
      bodies.add(/<section class="guide"[\s\S]*?<\/section>/.exec(html)![0]);
    }
    expect([titles.size, descriptions.size, bodies.size]).toEqual([PAGES.length, PAGES.length, PAGES.length]);
  });

  test('the 404 page asks not to be indexed, loads no scripts and links with absolute paths', () => {
    const html = stripMarkers(render404(home.replace('<script type="module" src="./src/main.ts"></script>', '<script type="module" crossorigin src="./assets/index-x.js"></script>')));
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toMatch(/<script type="module"/);
    expect(html).not.toContain('id="picker"');
    expect(html).not.toContain('id="privacy-pill"');
    expect(html).toContain('<a href="/fileconvert/heic-to-jpg/">');
    expect(html).toContain('<script src="/fileconvert/theme.js"></script>');
    expect(html).not.toMatch(/\b(href|src)="\.\.?\//);
  });

  test('the sitemap lists the home page and every page, at their canonical addresses', () => {
    const xml = sitemapXml('2026-11-22');
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
    expect(locs).toEqual([SITE, ...PAGES.map(pageUrl)]);
    expect(new Set(locs).size).toBe(locs.length);
    expect(xml.match(/<lastmod>2026-11-22<\/lastmod>/g)).toHaveLength(locs.length);
    expect(sitemapXml(null)).not.toContain('lastmod');
  });
});

describe('catalog search', () => {
  test('format words are read from labels, extensions and everyday names', () => {
    expect(parseQuery('Convert HEIC to JPEG').formats).toEqual(['heic', 'jpg']);
    expect(parseQuery('excel to json').formats).toEqual(['xlsx', 'json']);
    expect(parseQuery('tif').formats).toEqual(['tiff']);
    expect(parseQuery('iphone photo').tokens).toEqual(['iphone', 'photo']);
  });

  test('conversions without a page are answered from the registry', () => {
    const none = () => false;
    expect(answers(parseQuery('bmp to tiff'), none)).toEqual(['BMP to TIFF is supported. Add your file to the converter at the top of the page and choose TIFF.']);
    expect(answers(parseQuery('heic to jpg'), (a, b) => a === 'heic' && b === 'jpg')).toEqual([]);
    expect(answers(parseQuery('jpg to heic'), none)[0]).toMatch(/^HEIC is read but not written/);
    expect(answers(parseQuery('docx to pdf'), none)).toEqual(['FileConvert does not convert DOCX to PDF.']);
    expect(answers(parseQuery('avi to mp4'), none)[0]).toMatch(/^AVI video is not supported yet/);
    const yaml = answers(parseQuery('yaml'), none);
    expect(yaml).toContain('YAML converts to JSON.');
    expect(yaml).toContain('YAML can be made from JSON.');
  });

  test('formats listed as not supported are really not in the registry', () => {
    // When one of these becomes supported, its entry must go.
    const known = new Set(Object.values(FORMATS).flatMap(f => [f.id, ...f.exts]));
    for (const k of Object.keys(NOT_SUPPORTED)) expect(known.has(k), k).toBe(false);
  });
});
