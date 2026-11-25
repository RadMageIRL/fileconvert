// Build-time rendering of the site's pages. The built index.html is the template: it carries marked regions
// (<!--fc:name--> ... <!--/fc:name-->) that are filled with static content (catalog, formats, limits) and,
// for each page in src/core/pages.ts, replaced with that page's head, heading, guide and links. Everything a
// search engine needs is in the HTML; the scripts only add behavior. Runs in Node (vite.config.ts, unit tests),
// never in the browser. Imports carry their .ts extension because Vite's config loader reads this file too.

import { allConversions, AUDIO_IN, AUDIO_OUT, effectiveCategory, FORMATS, IMAGE_IN, IMAGE_OUT, targetsFor, VIDEO_IN, VIDEO_OUT, type Category, type FormatId } from '../core/formats.ts';
import { formatBytes, LIMITS } from '../core/limits.ts';
import { CATEGORY_LABELS, commonPages, isConversion, isExtract, isNamed, isTool, pageName, pageTitle, PAGES, type ConversionPage, type Page } from '../core/pages.ts';
import { isToolId, TOOLS } from '../core/tools.ts';

/** The canonical address of the app. Every page's canonical URL is under it. */
export const SITE = 'https://radmagelabs.com/fileconvert/';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const label = (id: FormatId) => FORMATS[id].label;
const list = (ids: readonly FormatId[]) => ids.map(label).join(', ');

export const pageUrl = (p: Page) => `${SITE}${p.slug}/`;

// ------------------------------------------------------------------ regions

const REGION = (name: string) => new RegExp(`<!--fc:${name}-->[\\s\\S]*?<!--/fc:${name}-->`, 'g');

/** Replaces a marked region, keeping its markers. Throws unless the region occurs exactly once. */
export function fillRegion(html: string, name: string, content: string): string {
  const n = html.match(REGION(name))?.length ?? 0;
  if (n !== 1) throw new Error(`index.html must have exactly one <!--fc:${name}--> region; found ${n}.`);
  return html.replace(REGION(name), () => `<!--fc:${name}-->${content}<!--/fc:${name}-->`);
}

/** Removes the region markers from a finished page, with the lines that held only a marker. */
export const stripMarkers = (html: string) => html.replace(/^[ \t]*<!--\/?fc:[a-z]+-->[ \t]*\r?\n/gm, '').replace(/<!--\/?fc:[a-z]+-->/g, '');

/** Replaces one exact string, which must occur exactly once. */
function replaceOnce(html: string, find: string, replace: string): string {
  const n = html.split(find).length - 1;
  if (n !== 1) throw new Error(`Expected exactly one ${JSON.stringify(find)} in index.html; found ${n}.`);
  return html.replace(find, () => replace);
}

// ------------------------------------------------------------------ static content shared by every page

/** Search words for a page: both formats, their extensions, the category and the page's own keywords. */
export function searchTerms(p: Page): string {
  const words = new Set<string>();
  if (isNamed(p)) for (const w of p.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) words.add(w);
  // A tool page that names the conversions it serves is found by those formats (JPG to PDF by JPG and PDF), not by
  // every format its tool takes.
  const formats = isTool(p) ? (p.serves ? p.serves.flat() : TOOLS[p.tool].accepts) : isExtract(p) ? p.formats : [p.from, p.to];
  for (const id of new Set(formats)) {
    words.add(FORMATS[id].label.toLowerCase());
    for (const e of FORMATS[id].exts) words.add(e);
  }
  words.add(CATEGORY_LABELS[p.category].toLowerCase());
  for (const k of p.keywords ?? []) words.add(k.toLowerCase());
  return [...words].join(' ');
}

/** The data attributes that say what a page does: its tool, its archive formats, or its pair. */
const pageData = (p: Page) => isTool(p) ? `data-tool="${p.tool}"${p.serves ? ` data-serves="${p.serves.map(([a, b]) => `${a}>${b}`).join(' ')}"` : ''}${p.preset ? ` data-preset="${new URLSearchParams(p.preset as Record<string, string>).toString()}"` : ''}` : isExtract(p) ? `data-extract="${p.formats.join(' ')}"` : `data-from="${p.from}" data-to="${p.to}"`;

const pageLink = (p: Page, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="./${p.slug}/">${esc(pageName(p))}</a>`;

export function catalogHtml(): string {
  const cats = (Object.keys(CATEGORY_LABELS) as Category[]).filter(c => PAGES.some(p => p.category === c));
  return cats.map(c => {
    const items = PAGES.filter(p => p.category === c).map(p =>
      `<li class="cat-item" data-cat="${c}" data-slug="${p.slug}" ${pageData(p)} data-terms="${esc(searchTerms(p))}"><a href="./${p.slug}/"><span class="cat-name">${esc(pageName(p))}</span><span class="cat-blurb">${esc(p.blurb)}</span></a></li>`);
    return `<section class="cat-group" data-cat="${c}" aria-labelledby="cat-${c}"><h3 id="cat-${c}">${CATEGORY_LABELS[c]}</h3><ul class="cat-list">${items.join('')}</ul></section>`;
  }).join('');
}

/** The category filter buttons, one per category that has pages. Shown by the catalog script. */
export function catalogChipsHtml(): string {
  const cats = (Object.keys(CATEGORY_LABELS) as Category[]).filter(c => PAGES.some(p => p.category === c));
  return [`<button type="button" class="chip" data-cat="" aria-pressed="true">All</button>`,
    ...cats.map(c => `<button type="button" class="chip" data-cat="${c}" aria-pressed="false">${CATEGORY_LABELS[c]}</button>`)].join('');
}

export function commonHtml(): string {
  const list = (pages: Page[]) => pages.map(p => `<li>${pageLink(p, 'chip')}</li>`).join('');
  const tools = commonPages().filter(isNamed);
  return `<nav class="common" aria-labelledby="common-title"><h2 id="common-title">Common conversions</h2><ul class="chips">${list(commonPages().filter(isConversion))}</ul>`
    + (tools.length ? `<h2 class="common-sub">Tools</h2><ul class="chips">${list(tools)}</ul>` : '') + '</nav>';
}

/** "A to B, C or D" for every input of a category, straight from the registry. */
function routes(cat: Category): Array<[string, string]> {
  const ins = (Object.keys(FORMATS) as FormatId[]).filter(f => FORMATS[f].category === cat && targetsFor(f).length);
  const or = (ids: FormatId[]) => ids.length > 1 ? `${ids.slice(0, -1).map(label).join(', ')} or ${label(ids[ids.length - 1])}` : label(ids[0]);
  return ins.map(f => [label(f), or(targetsFor(f))]);
}

export function formatsHtml(): string {
  const card = (title: string, pairs: Array<[string, string]>, note: string) =>
    `<div class="fmt"><h3>${esc(title)}</h3>${pairs.length ? `<ul class="pairs">${pairs.map(([a, b]) => `<li><b>${esc(a)}</b> to ${esc(b)}</li>`).join('')}</ul>` : ''}<p>${esc(note)}</p></div>`;
  return [
    card('Images', [[list(IMAGE_IN), list(IMAGE_OUT)], ['Animated GIF, WebP or PNG', 'GIF, WebP, MP4 or WebM, keeping the animation']], 'Resize, set quality, keep transparency where the format allows it. HEIC and SVG are read but not written; an SVG is drawn at the size you choose.'),
    card('Audio', [[list(AUDIO_IN), list(AUDIO_OUT)], ['Sound from a video', list(AUDIO_OUT)]], 'Choose bitrate, sample rate and channels. OGG output is Opus.'),
    card('Video', [[list(VIDEO_IN), list(VIDEO_OUT)]], 'Choose resolution and quality, or remove the sound. Uses your browser\'s video encoders, often on the graphics chip.'),
    card('Documents', routes('document'), 'PDFs have real, selectable text; Markdown, HTML and DOCX keep their structure, not their look. PDF pages can also be saved as JPG or PNG pictures. Scanned PDFs need OCR, which is not done.'),
    card('Data', routes('data'), 'Nested data, encodings, worksheets, dates and spreadsheet formulas are handled explicitly.'),
    // Archives are unpacked, not converted, so this card has no "A to B" lines.
    card('Archives', [], 'ZIP, TAR, GZ and .tar.gz archives are unpacked: download the files inside, or convert them without adding them again. Archives are never converted into another archive format. Links, encrypted files and archives inside archives are listed, not opened.'),
  ].join('');
}

export function limitsHtml(): string {
  const items = [
    'HEIC is read but not written: the open HEVC encoders are GPL-licensed and patent-encumbered, and none is practical in a browser.',
    'AVI and WMA are not supported yet. MP4, WebM, MOV, MKV and MPEG-TS video and AIFF audio are read.',
    'Audio and video use your browser\'s WebCodecs. Current Chrome, Edge and Firefox have them. Which codecs work depends on the browser and the computer: Firefox cannot decode HEVC video, for example, and AAC encoding falls back to a built-in encoder where the browser has none.',
    'DOCX to PDF and PDF to DOCX are not offered. Page layout cannot be reproduced faithfully in a browser, and I would rather not offer a conversion that quietly rearranges your document.',
    'Markdown and HTML to PDF keep the document structure (headings, lists, tables, code, links, embedded PNG and JPEG pictures) in a clean default style. Stylesheets are not applied and remote images are not downloaded.',
    'Conversions between Markdown, HTML and DOCX keep the structure, not the look: fonts, colors, layout, headers and footers, comments and tracked changes are not carried over, and nothing a document links to is fetched.',
    'XLS and ODS to XLSX keep values, formulas, number formats and merged cells, not cell formatting, charts, pictures, comments or macros.',
    'The PDF font covers Latin, Greek and Cyrillic. Other scripts, such as Chinese, Arabic or Hindi, are reported and do not show.',
    'Animated GIF, WebP and PNG (APNG) keep their animation as GIF, WebP, MP4 or WebM; formats that hold one picture get the first frame, and the menu says which is which. Animated WebP and APNG need ImageDecoder, which current Chrome, Edge and Firefox have. Animated AVIF is read as its first frame.',
    'Converted pictures lose their metadata (EXIF, GPS). Remove photo metadata takes it out of JPG, PNG and WebP photos without converting them. HEIC and TIFF color profiles are not applied.',
    'SVG files are cleaned before they are drawn: scripts, animation, HTML content and anything outside the file (images, fonts, stylesheets) are removed, and text uses the fonts on this device.',
    'ZIP, TAR and GZ archives are unpacked; RAR and 7-Zip are not supported. Encrypted, linked and unusually compressed files in an archive are listed but not unpacked.',
    `Size limits: pictures up to ${LIMITS.imagePixels / 1e6} megapixels and ${formatBytes(LIMITS.imageBytes)}, audio and video up to ${formatBytes(LIMITS.mediaBytes)}, PDFs up to ${formatBytes(LIMITS.pdfBytes)}, text to PDF up to ${formatBytes(LIMITS.textToPdfBytes)}, data files up to ${formatBytes(LIMITS.dataBytes)}, SVG files up to ${formatBytes(LIMITS.svgBytes)}, archives up to ${LIMITS.archiveEntries.toLocaleString('en-US')} files and ${formatBytes(LIMITS.archiveBytes)} unpacked.`,
  ];
  return items.map(i => `<li>${esc(i)}</li>`).join('');
}

/** Fills the static regions of index.html. Used for the home page in development and in the build. */
export function fillStatics(html: string): string {
  let out = fillRegion(html, 'common', commonHtml());
  out = fillRegion(out, 'chips', catalogChipsHtml());
  out = fillRegion(out, 'catalog', catalogHtml());
  out = fillRegion(out, 'formats', formatsHtml());
  out = fillRegion(out, 'limits', limitsHtml());
  return out;
}

// ------------------------------------------------------------------ conversion pages

/** Which settings panel applies to a page's conversion, in words. */
export function settingsHint(p: ConversionPage): string {
  const fromCat = effectiveCategory(p.from, p.from === 'gif' ? { animated: true } : {});
  const toCat = FORMATS[p.to].category;
  if (fromCat === 'image') return toCat === 'image' ? 'Images settings to change the quality, the size or the background color for transparent areas' : 'Images settings to change the background color for transparent areas';
  if (toCat === 'audio') return 'Audio settings to change the bitrate, the sample rate or the channels';
  if (fromCat === 'video' && p.to === 'gif') return 'Video settings to change the GIF width or frame rate';
  if (fromCat === 'video') return 'Video settings to change the resolution or the quality, or to remove the sound';
  // XLS and ODS to XLSX rewrite the whole workbook; no setting changes it.
  if (fromCat === 'data' && p.to === 'xlsx' && (p.from === 'xls' || p.from === 'ods')) return '';
  if (fromCat === 'data') return 'Data settings to change separators, the header row and how values are read';
  if (p.to === 'pdf' || p.to === 'docx') return 'Documents settings to change the page size';
  if (p.to === 'md') return 'Documents settings to choose whether pictures stay inside the Markdown';
  return '';
}

function pageJsonLd(p: Page): string {
  const url = pageUrl(p);
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication', name: `FileConvert: ${pageName(p)}${isNamed(p) ? '' : ' converter'}`, url,
        applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any modern web browser', isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, description: p.description,
        author: { '@type': 'Person', name: 'RadMageIRL' }, publisher: { '@type': 'Organization', name: 'RadMage Labs', url: 'https://radmagelabs.com/' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'FileConvert', item: SITE },
          { '@type': 'ListItem', position: 2, name: pageName(p), item: url },
        ],
      },
    ],
  };
  // "<" is escaped so no text can close the script element.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function pageHead(p: Page): string {
  const url = pageUrl(p);
  return [
    `<title>${esc(pageTitle(p))}</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:title" content="${esc(`${pageName(p)}${isNamed(p) ? '' : ' converter'} | FileConvert`)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<script type="application/ld+json">${pageJsonLd(p)}</script>`,
  ].join('\n  ');
}

function pageHero(p: Page): string {
  return `<section class="hero hero-page" aria-labelledby="title">
      <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="./">FileConvert</a></li><li><span aria-current="page">${esc(pageName(p))}</span></li></ol></nav>
      <h1 id="title">${isNamed(p) ? esc(p.name) : `Convert ${esc(label(p.from))} to ${esc(label(p.to))}`}</h1>
      <p class="promise">Convert files. Upload nothing.</p>
      <p class="lede">${esc(p.intro)}</p>
    </section>`;
}

/** The How to steps: written for a tool, generated for a conversion. */
function steps(p: Page): string {
  if (isNamed(p)) return p.steps.map(t => `<li>${esc(t).replace(/^([^.]+\.)/, '<strong>$1</strong>')}</li>`).join('\n        ');
  const a = esc(label(p.from)), b = esc(label(p.to));
  const hint = settingsHint(p);
  return [
    `<li><strong>Add your ${a} files.</strong> Drop them on this page or press Choose files. Add as many as you like.</li>`,
    `<li><strong>${b} is already chosen.</strong> ${hint ? `Open ${esc(hint)}.` : 'There is nothing else to set.'}</li>`,
    '<li><strong>Convert and download.</strong> Press Convert or Convert all, then download each result or all of them as one ZIP.</li>',
  ].join('\n        ');
}

const howTo = (p: Page) => isNamed(p) ? `How to ${esc(p.name.charAt(0).toLowerCase() + p.name.slice(1))}` : `How to convert ${esc(label(p.from))} to ${esc(label(p.to))}`;

function pageGuide(p: Page): string {
  const related = p.related.map(s => PAGES.find(x => x.slug === s)!).map(r => `<li>${pageLink(r, 'chip')}</li>`).join('');
  return `<section class="guide" aria-labelledby="guide-title">
      <h2 id="guide-title">${howTo(p)}</h2>
      <ol class="steps">
        ${steps(p)}
      </ol>
      <div class="guide-grid">
        <div class="guide-card"><h3>What happens to your files</h3><ul>${p.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>
        <div class="guide-card"><h3>Good to know</h3><ul>${p.limits.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>
      </div>
      <p class="guide-note"><strong>Nothing is uploaded.</strong> ${isTool(p) ? 'The tool' : isExtract(p) ? 'Unpacking' : 'The conversion'} runs in this browser tab, and the page's security policy does not allow it to send your files anywhere. Privacy, at the bottom of the page, explains how.</p>
      <nav class="related" aria-labelledby="related-title"><h3 id="related-title">Related</h3><ul class="chips">${related}</ul></nav>
    </section>`;
}

/** Points a page one folder down at the shared files: "./x" becomes "../x". */
const oneLevelDown = (html: string) => html.replace(/\b(href|src)="\.\//g, '$1="../');

/** A conversion or tool page, made from the built home page. A tool page opens its tool in place of the converter. */
export function renderPage(home: string, p: Page): string {
  let html = fillRegion(home, 'head', `\n  ${pageHead(p)}\n`);
  html = replaceOnce(html, 'data-root="./"', `data-root="../" data-page="${p.slug}" ${pageData(p)}`);
  html = fillRegion(html, 'hero', pageHero(p));
  if (isConversion(p)) html = fillRegion(html, 'drop', `<strong>Drop ${esc(label(p.from))} files here</strong>`);
  if (isExtract(p)) html = fillRegion(html, 'drop', `<strong>Drop ${esc(p.formats.map(f => f === 'gz' ? 'TAR.GZ, TGZ or GZ' : label(f)).join(', '))} files here</strong>`);
  html = fillRegion(html, 'common', '');
  html = fillRegion(html, 'guide', pageGuide(p));
  html = html.replace(`<li class="cat-item" data-cat="${p.category}" data-slug="${p.slug}" `, `<li class="cat-item current" data-cat="${p.category}" data-slug="${p.slug}" `)
    .replace(`<a href="./${p.slug}/"><span class="cat-name">`, `<a href="./${p.slug}/" aria-current="page"><span class="cat-name">`);
  return oneLevelDown(html);
}

/**
 * The page GitHub Pages serves for an address that does not exist, at any depth. It links with absolute
 * /fileconvert/ paths (both hosts serve the app there), loads no scripts, and asks not to be indexed.
 */
export function render404(home: string): string {
  let html = fillRegion(home, 'head', '\n  <title>Page not found | FileConvert</title>\n  <meta name="robots" content="noindex">\n');
  html = replaceOnce(html, 'data-root="./"', 'data-root="/fileconvert/"');
  html = fillRegion(html, 'hero', `<section class="hero" aria-labelledby="title">
      <h1 id="title">Page not found</h1>
      <p class="lede">There is no FileConvert page at this address. <a href="./">Open FileConvert</a> to convert your files, or pick a conversion below.</p>
    </section>`);
  for (const r of ['app', 'common', 'guide', 'chips', 'info', 'pill']) html = fillRegion(html, r, '');
  html = html.replace(/<script type="module"[^>]*><\/script>\s*/g, '').replace(/<link rel="modulepreload"[^>]*>\s*/g, '');
  return html.replace(/\b(href|src)="\.\//g, '$1="/fileconvert/');
}

export function sitemapXml(lastmod: string | null): string {
  const urls = [SITE, ...PAGES.map(pageUrl)];
  const mod = lastmod ? `<lastmod>${lastmod}</lastmod>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u}</loc>${mod}</url>`).join('\n')}\n</urlset>\n`;
}

/**
 * Checks the page list before anything is built: every page names a conversion FileConvert performs,
 * slugs, titles and descriptions are unique and well formed, and related pages exist. Returns problems.
 */
export function pageProblems(): string[] {
  const problems: string[] = [];
  const pairs = new Set(allConversions().map(([a, b]) => `${a}>${b}`));
  const seen = { slug: new Set<string>(), title: new Set<string>(), description: new Set<string>() };
  for (const p of PAGES) {
    const where = `page ${p.slug}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) problems.push(`${where}: the slug must be lowercase words joined by hyphens`);
    if (isTool(p)) { if (!isToolId(p.tool)) problems.push(`${where}: there is no tool ${p.tool}`); }
    else if (isExtract(p)) { if (!p.formats.length || p.formats.some(f => FORMATS[f].category !== 'archive')) problems.push(`${where}: an extraction page names archive formats only`); }
    else if (!pairs.has(`${p.from}>${p.to}`)) problems.push(`${where}: FileConvert does not convert ${p.from} to ${p.to}`);
    for (const [k, v] of [['slug', p.slug], ['title', pageTitle(p)], ['description', p.description]] as const) {
      if (seen[k].has(v)) problems.push(`${where}: duplicate ${k}`);
      seen[k].add(v);
    }
    if (pageTitle(p).length > 60) problems.push(`${where}: the title is ${pageTitle(p).length} characters; keep it to 60`);
    if (p.description.length < 70 || p.description.length > 160) problems.push(`${where}: the description is ${p.description.length} characters; keep it between 70 and 160`);
    if (p.details.length < 2 || p.limits.length < 1) problems.push(`${where}: needs at least two details and one limit`);
    for (const r of p.related) {
      if (r === p.slug || !PAGES.some(x => x.slug === r)) problems.push(`${where}: related page ${r} does not exist`);
    }
    const text = [p.blurb, p.description, p.intro, ...p.details, ...p.limits, ...(p.keywords ?? []), ...(isNamed(p) ? [p.name, p.title, ...p.steps] : [])].join(' ');
    if (/[^\x20-\x7e]/.test(text)) problems.push(`${where}: text must be plain ASCII`);
  }
  return problems;
}
