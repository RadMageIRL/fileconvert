// Writes tests/fixtures/pdf-render/multilingual.pdf by printing a page in Chrome, so the PDF holds embedded fonts the
// way real documents do. Page 1: Latin, Greek and Cyrillic (Noto Sans), Arabic (Noto Naskh Arabic, joined and right to
// left), Hebrew, Devanagari (with its conjuncts) and Thai as embedded TrueType subsets, and Japanese and Chinese (Noto
// Sans CJK, a CFF font, which Chrome writes as Type 3 glyphs). Page 2: the same text in the variable versions of the
// fonts, which Chrome also writes as Type 3 glyphs. Page 3: CSS transparency, blending, a gradient and an SVG mask,
// written as PDF transparency groups and soft masks. Characters a script's font lacks fall back to Noto Sans, so no
// font of this computer ends up in the file. The fonts are the SIL Open Font License 1.1 Noto fonts; embedding subsets
// of them in a document is allowed by that license.
//
//   node tools/make-pdf-render-fonts.mjs <folder with the static fonts NotoSansCJKjp-Regular.otf (notofonts/noto-cjk),
//                                        NotoNaskhArabic, NotoSansHebrew, NotoSansDevanagari and NotoSansThai -Regular.ttf
//                                        (notofonts.github.io), and their variable versions NotoSansJP.ttf, NotoNaskhArabic.ttf,
//                                        NotoSansDevanagari.ttf, NotoSansThai.ttf>
// (needs Playwright's Chrome channel or Chromium; Noto Sans comes from @expo-google-fonts/noto-sans)

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const fonts = resolve(process.argv[2] ?? 'local/fonts');
const url = f => pathToFileURL(f).href;
const face = (family, file) => `@font-face { font-family: '${family}'; src: url('${url(file)}'); }`;
const latin = resolve('node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${face('Latin', latin)}
${face('JP', join(fonts, 'NotoSansCJKjp-Regular.otf'))}
${face('Arabic', join(fonts, 'NotoNaskhArabic-Regular.ttf'))}
${face('Hebrew', join(fonts, 'NotoSansHebrew-Regular.ttf'))}
${face('Deva', join(fonts, 'NotoSansDevanagari-Regular.ttf'))}
${face('Thai', join(fonts, 'NotoSansThai-Regular.ttf'))}
${face('JPv', join(fonts, 'NotoSansJP.ttf'))}
${face('Arabicv', join(fonts, 'NotoNaskhArabic.ttf'))}
${face('Hebrewv', join(fonts, 'NotoSansHebrew.ttf'))}
${face('Devav', join(fonts, 'NotoSansDevanagari.ttf'))}
${face('Thaiv', join(fonts, 'NotoSansThai.ttf'))}
body { font: 18px 'Latin'; margin: 0; } h1 { font-weight: normal; }
p { margin: 0 0 14px; }
.jp { font-family: 'JP', 'Latin'; } .ar { font-family: 'Arabic', 'Latin'; direction: rtl; text-align: right; } .he { font-family: 'Hebrew', 'Latin'; direction: rtl; text-align: right; }
.hi { font-family: 'Deva', 'Latin'; } .th { font-family: 'Thai', 'Latin'; }
.v .jp { font-family: 'JPv', 'Latin'; } .v .ar { font-family: 'Arabicv', 'Latin'; } .v .he { font-family: 'Hebrewv', 'Latin'; } .v .hi { font-family: 'Devav', 'Latin'; } .v .th { font-family: 'Thaiv', 'Latin'; }
.b { page-break-before: always; position: relative; height: 900px; }
.v { page-break-before: always; }
.box { position: absolute; width: 220px; height: 160px; }
</style></head><body>
<h1>Multilingual sample</h1>
${texts()}
<div class="v"><h1>Variable fonts (drawn as Type 3 glyphs)</h1>
${texts()}
</div>
<div class="b">
  <div class="box" style="left:40px;top:40px;background:#e33;"></div>
  <div class="box" style="left:140px;top:110px;background:#33e;opacity:.5;"></div>
  <div class="box" style="left:420px;top:40px;background:#fd0;"></div>
  <div class="box" style="left:500px;top:110px;background:#0cc;mix-blend-mode:multiply;"></div>
  <div class="box" style="left:40px;top:340px;width:600px;background:linear-gradient(90deg, rgba(0,120,255,1), rgba(0,120,255,0));"></div>
  <svg style="position:absolute;left:40px;top:560px" width="600" height="220" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
    <mask id="m"><rect width="600" height="220" fill="url(#g)"/></mask></defs>
    <rect width="600" height="220" fill="#8a2be2" mask="url(#m)"/>
    <text x="20" y="120" font-family="Latin" font-size="40" fill="#000">Masked by luminosity</text>
  </svg>
</div>
</body></html>`;

/* The text of each script, set once in the fonts as they are and once in their variable versions. */
function texts() { return `<p>English: The quick brown fox jumps over the lazy dog. Fran\u00e7ais: \u00e9t\u00e9, gar\u00e7on, na\u00efve.</p>
<p>\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac: \u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1 \u03ba\u03cc\u03c3\u03bc\u03b5. \u0420\u0443\u0441\u0441\u043a\u0438\u0439: \u0434\u043e\u0431\u0440\u043e\u0435 \u0443\u0442\u0440\u043e, \u043c\u0438\u0440.</p>
<p class="jp">\u65e5\u672c\u8a9e: \u3053\u3093\u306b\u3061\u306f\u4e16\u754c\u3002\u30ab\u30bf\u30ab\u30ca\u3068\u6f22\u5b57\u3002</p>
<p class="jp">\u4e2d\u6587: \u4f60\u597d\uff0c\u4e16\u754c\u3002\u5929\u6c14\u5f88\u597d\u3002</p>
<p class="ar">\u0627\u0644\u0639\u0631\u0628\u064a\u0629: \u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645\u060c \u0627\u0644\u0643\u062a\u0627\u0628\u0629 \u0645\u0646 \u0627\u0644\u064a\u0645\u064a\u0646.</p>
<p class="he">\u05e2\u05d1\u05e8\u05d9\u05ea: \u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd.</p>
<p class="hi">\u0939\u093f\u0928\u094d\u0926\u0940: \u0928\u092e\u0938\u094d\u0924\u0947 \u0926\u0941\u0928\u093f\u092f\u093e, \u0915\u094d\u0937\u0924\u094d\u0930\u093f\u092f \u0936\u094d\u0930\u0940\u0964</p>
<p class="th">\u0e44\u0e17\u0e22: \u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e0a\u0e32\u0e27\u0e42\u0e25\u0e01</p>`; }

const dir = mkdtempSync(join(tmpdir(), 'fileconvert-fonts-'));
const page1 = join(dir, 'page.html');
writeFileSync(page1, html);
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage();
await page.goto(url(page1));
await page.evaluate(() => document.fonts.ready);
writeFileSync('tests/fixtures/pdf-render/multilingual.pdf', await page.pdf({ format: 'Letter', printBackground: true }));
await browser.close();
console.log('tests/fixtures/pdf-render/multilingual.pdf written');
