import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { answers, NOT_SUPPORTED, parseQuery } from '../../src/app/catalog';
import { allConversions, FORMATS } from '../../src/core/formats';
import { commonPages, isConversion, isNamed, pageName, pageTitle, PAGES, type ConversionPage } from '../../src/core/pages';
import { fillRegion, fillStatics, pageProblems, pageUrl, render404, renderPage, settingsHint, SITE, sitemapXml, stripMarkers } from '../../src/site/render';

const template = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
/** The home page as the build makes it, with its static content filled in. */
const home = fillStatics(template);
const byName = (slug: string) => PAGES.find(p => p.slug === slug)! as ConversionPage;

describe('the page list', () => {
  test('has no problems: real conversions, unique slugs, titles and descriptions, existing related pages', () => {
    expect(pageProblems()).toEqual([]);
  });

  test('holds the planned pages whose conversions are in place', () => {
    expect(PAGES.map(p => p.slug).sort()).toEqual([
      'aiff-to-mp3', 'avif-to-jpg', 'csv-to-json', 'docx-to-html', 'docx-to-markdown', 'extract-tar', 'extract-zip', 'flac-to-mp3', 'gif-to-mp4', 'gif-to-webp',
      'heic-to-jpg', 'heic-to-png', 'html-to-docx', 'html-to-markdown', 'images-to-tiff', 'jpg-to-png', 'json-to-csv', 'json-to-jsonl',
      'json-to-xlsx', 'jsonl-to-csv', 'm4a-to-mp3', 'markdown-to-docx', 'markdown-to-pdf', 'mkv-to-mp4', 'mov-to-mp4', 'mp4-to-gif', 'mp4-to-mp3', 'ods-to-csv', 'ods-to-xlsx', 'pdf-to-text',
      'png-to-ico', 'png-to-jpg', 'png-to-webp', 'remove-image-metadata', 'svg-to-jpg', 'svg-to-png', 'ts-to-mp4', 'wav-to-mp3', 'webm-to-mp4', 'webp-to-gif', 'webp-to-jpg', 'webp-to-png',
      'xls-to-csv', 'xls-to-xlsx', 'xlsx-to-csv', 'xlsx-to-json', 'xml-to-csv', 'xml-to-xlsx', 'yaml-to-csv',
    ]);
  });

  test('an extraction page is the converter with its archive formats named, and the checks hold it to archives', () => {
    const zip = PAGES.find(p => p.slug === 'extract-zip')!;
    expect(zip).toMatchObject({ kind: 'extract', formats: ['zip'], category: 'archive' });
    const html = renderPage(home, zip);
    expect(html).toContain('data-page="extract-zip" data-extract="zip"');
    expect(html).not.toMatch(/<html[^>]*data-tool=/);
    expect(html).toContain('<h1 id="title">Extract files from a ZIP</h1>');
    expect(html).toContain('<strong>Drop ZIP files here</strong>');
    expect(html).toContain('Unpacking runs in this browser tab');
    expect(renderPage(home, PAGES.find(p => p.slug === 'extract-tar')!)).toContain('<strong>Drop TAR, TAR.GZ, TGZ or GZ files here</strong>');
    // On the home page it is listed with the tools.
    expect(home).toMatch(/<h2 class="common-sub">Tools<\/h2><ul class="chips">.*href="\.\/extract-zip\/"/);
  });

  test('the README table lists exactly the document and data conversions the registry performs', () => {
    const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8');
    const byLabel = new Map(Object.values(FORMATS).map(f => [f.label, f.id] as const));
    const listed = new Set<string>();
    let section = '';
    for (const line of readme.split('\n')) {
      const m = /^\| (?:\*\*(\w+):\*\* )?([^|]+?) \| ([^|]+?) \|$/.exec(line);
      if (!m) continue;
      if (m[1]) section = m[1];
      if (section !== 'Documents' && section !== 'Data') continue;
      for (const from of m[2].split(', ')) for (const to of m[3].split(', ')) {
        expect(byLabel.has(from) && byLabel.has(to), `${from} to ${to}`).toBe(true);
        listed.add(`${byLabel.get(from)}>${byLabel.get(to)}`);
      }
    }
    const registry = allConversions().filter(([a]) => ['document', 'data'].includes(FORMATS[a].category)).map(([a, b]) => `${a}>${b}`);
    expect([...listed].sort()).toEqual(registry.sort());
  });

  test('every page names a conversion the registry performs', () => {
    const pairs = new Set(allConversions().map(([a, b]) => `${a}>${b}`));
    for (const p of PAGES) if (isConversion(p)) expect(pairs.has(`${p.from}>${p.to}`), p.slug).toBe(true);
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
    // Conversions and tools are listed separately on the home page; each list has its own order.
    for (const group of [commonPages().filter(isNamed), commonPages().filter(isConversion)]) {
      const common = group.map(p => p.common);
      expect(common).toEqual([...common].sort((a, b) => a! - b!));
      expect(new Set(common).size).toBe(common.length);
    }
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
    expect(out).toContain('<b>JPG, PNG, WebP, AVIF, HEIC, BMP, GIF, TIFF, ICO, SVG</b> to JPG, PNG, WebP, AVIF, GIF, BMP, TIFF, ICO');
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
    expect(answers(parseQuery('webp to mp4'), none)).toEqual(['WebP to MP4 is supported. Add your file to the converter at the top of the page and choose MP4.']);
    const yaml = answers(parseQuery('yaml'), none);
    expect(yaml).toContain('YAML converts to JSON, CSV, XLSX, TSV.');
    expect(yaml).toContain('YAML can be made from JSON.');
    // Archives are unpacked, never converted, and that is what is said about them.
    expect(answers(parseQuery('zip'), none)).toEqual(['ZIP archives are unpacked, not converted: add one to the converter at the top of the page and choose Extract files, then download the files inside or convert them.']);
    expect(answers(parseQuery('tgz to png'), none)[0]).toMatch(/^GZ archives are unpacked, not converted/);
    expect(answers(parseQuery('zip to tar'), none)[1]).toBe('FileConvert does not turn one archive format into another, such as ZIP to TAR.');
    expect(answers(parseQuery('pdf to zip'), none)).toEqual(['FileConvert unpacks ZIP, TAR and GZ archives but does not make them, apart from downloading several converted files together as one ZIP.']);
    expect(answers(parseQuery('rar'), none)).toEqual(['RAR and 7-Zip archives are not supported. ZIP, TAR and GZ archives can be unpacked, and their files converted.']);
  });

  test('formats listed as not supported are really not in the registry', () => {
    // When one of these becomes supported, its entry must go.
    const known = new Set(Object.values(FORMATS).flatMap(f => [f.id, ...f.exts]));
    for (const k of Object.keys(NOT_SUPPORTED)) expect(known.has(k), k).toBe(false);
  });
});
