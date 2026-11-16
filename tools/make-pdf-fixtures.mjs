// Writes the PDF fixtures that need a real layout engine, by printing pages in Chrome:
//   tests/fixtures/document/sample.pdf  two pages of text
//   tests/fixtures/document/mixed.pdf   a page of text, then a page that is only a picture (like a scan)
// node tools/make-pdf-fixtures.mjs   (needs Playwright's Chrome channel or Chromium)

import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage();

await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px serif} .b{page-break-before:always}</style></head><body>
<h1>FileConvert PDF sample</h1>
<p>The first paragraph of the first page, with caf\u00e9 and na\u00efve.</p>
<p>Second paragraph: numbers 12345 and a Greek word \u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1.</p>
<h2 class="b">Second page</h2>
<p>This line is on page two.</p>
</body></html>`);
writeFileSync('tests/fixtures/document/sample.pdf', await page.pdf({ format: 'Letter' }));

// A picture of text, drawn on a canvas, so page two has an image and no text layer.
const png = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 200);
  x.fillStyle = '#000'; x.font = '28px serif'; x.fillText('This is a picture of text.', 20, 100);
  return c.toDataURL('image/png');
});
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px serif} .b{page-break-before:always}</style></head><body>
<p>Page one has real text.</p>
<div class="b"><img src="${png}" width="600" height="200"></div>
</body></html>`);
writeFileSync('tests/fixtures/document/mixed.pdf', await page.pdf({ format: 'Letter' }));
await browser.close();
console.log('PDF fixtures written');
