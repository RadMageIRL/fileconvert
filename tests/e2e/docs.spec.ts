import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { addFiles, convert, download, expectDone, fx, libreoffice, openApp, pyRead, row, unexpectedViolations, type FilePayload } from './helpers';

// Phase 1B documents in the browser (v0.2.0): HTML to Markdown, DOCX to HTML and Markdown, Markdown to DOCX.
// Markdown results are read back by mistune and DOCX results by python-docx and LibreOffice (tests/e2e/readers.py),
// never by the code that wrote them. No conversion may fetch anything, from anywhere.

const RICH: FilePayload = { name: 'rich.md', mimeType: 'text/markdown', buffer: readFileSync(fx('document/rich.markdown')) };
const LANGS = 'Zo\u00eb, na\u00efve, fa\u00e7ade. \u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac. \u0420\u0443\u0441\u0441\u043a\u0438\u0439. \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8\u3002 \u4e2d\u6587\u3002 \ud55c\uad6d\uc5b4. \u0627\u0644\u0639\u0631\u0628\u064a\u0629. \u05e2\u05d1\u05e8\u05d9\u05ea. \u0939\u093f\u0928\u094d\u0926\u0940. Emoji: \u{1F600} \u{1F44D}\u{1F3FD}.';

interface Md {
  headings: Array<[number, string]>; items: Array<{ depth: number; ordered: boolean; text: string }>;
  tables: Array<{ head: string[]; align: Array<string | null>; rows: string[][] }>; code: Array<{ info: string | null; text: string }>;
  quotes: string[]; links: Array<{ url: string; text: string }>; images: Array<{ url: string; alt: string }>;
  strong: string[]; em: string[]; strike: string[]; codespans: string[]; html: string[]; breaks: number; rules: number; text: string;
}
interface Docx {
  blocks: Array<{ type: 'p'; style: string; level: number | null; text: string; runs: Array<Record<string, unknown> & { text: string }> } | { type: 'table'; header: boolean; rows: string[][] }>;
  pictures: Array<{ type: string; bytes: number }>; title: string; author: string;
}

async function documentsSetting(page: Page, label: string, value: string): Promise<void> {
  const panel = page.locator('details.panel[data-cat="document"]');
  if (!(await panel.evaluate(d => (d as HTMLDetailsElement).open))) await panel.locator('summary').click();
  await panel.getByLabel(label).selectOption(value);
}

test('HTML to Markdown: structure kept, nothing unsafe, nothing fetched; mistune reads it back', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/page.html')]);
  await convert(page, 'page.html', 'Markdown');
  await expectDone(page, 'page.html');
  const md = pyRead<Md>('md', (await download(page, 'page.html', info)).path);
  expect(md.headings).toEqual([[1, 'Converting a page'], [2, 'Nested lists'], [2, 'Tables'], [3, 'Code']]);
  expect(md.items).toEqual([
    { depth: 1, ordered: false, text: 'Apples' }, { depth: 2, ordered: false, text: 'Green' }, { depth: 2, ordered: false, text: 'Red' },
    { depth: 3, ordered: true, text: 'Gala' }, { depth: 3, ordered: true, text: 'Fuji' }, { depth: 1, ordered: false, text: 'Pears' },
    { depth: 1, ordered: true, text: 'Third' }, { depth: 1, ordered: true, text: 'Fourth' },
  ]);
  expect(md.tables[0]).toEqual({ head: ['Item', 'Price', 'Note'], align: [null, 'right', null], rows: [['Tea', '2.50', 'Hot | iced'], ['Coffee', '3.00', 'Two<br><br>paragraphs']] });
  expect(md.tables[1].rows).toEqual([['no', 'header'], ['row', 'here']]);
  expect(md.code).toEqual([{ info: 'python', text: 'def greet(name):\n    return f"Hello, {name}"  # *not* emphasis\n' }]);
  expect(md.quotes).toEqual(['Quoted text.Second quoted paragraph.']);
  expect(md.links.filter(l => l.text !== 'Home' && l.text !== 'About')).toEqual([{ url: 'https://example.com/docs', text: 'link with a title' }, { url: 'relative/page.html', text: 'relative link' }]);
  expect(md.images.map(i => [i.url.slice(0, 22), i.alt])).toEqual([['data:image/png;base64,', 'Embedded red'], ['https://example.com/ph', 'Remote photo'], ['images/local.png', 'Relative picture']]);
  expect(md.strong).toEqual(['strong', 'bold']);
  expect(md.em).toEqual(['emphasis', 'italic']);
  expect(md.strike).toEqual(['deleted']);
  expect(md.codespans).toEqual(['a <code> span']);
  expect(md.html).toEqual(['<sub>', '</sub>', '<sup>', '</sup>']);
  expect(md.breaks).toBe(1);
  expect(md.rules).toBe(1);
  expect(md.text).toContain(LANGS);
  expect(md.text).toContain('\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064a');
  expect(md.text).toContain('Characters that mean something in Markdown: \\* \\_ # \\[x\\] 1. stay text.');
  for (const gone of ['alert', 'javascript', 'onclick', 'Send', 'should not appear', 'changed', 'example.com/steal', 'example.com/frame']) expect(md.text).not.toContain(gone);
  await expect(row(page, 'page.html').locator('.job-notes')).toContainText('nothing was downloaded');

  await documentsSetting(page, 'Pictures in Markdown (from DOCX or HTML)', 'describe');
  await convert(page, 'page.html', 'Markdown');
  const described = pyRead<Md>('md', (await download(page, 'page.html', info)).path);
  expect(described.images.map(i => i.alt)).toEqual(['Remote photo', 'Relative picture']);
  expect(described.text).toContain('\\[Image: Embedded red\\]');
  expect(w.outside).toEqual([]);
});

test('DOCX to Markdown: Word and LibreOffice documents, nested lists, code, quotes, tables, pictures', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/word-styles.docx'), fx('document/libreoffice-rich.docx')]);
  await convert(page, 'word-styles.docx', 'Markdown');
  await expectDone(page, 'word-styles.docx');
  const word = pyRead<Md>('md', (await download(page, 'word-styles.docx', info)).path);
  expect(word.headings).toEqual([[1, 'Word styles sample'], [1, 'Introduction'], [2, 'Lists'], [2, 'Quote and code'], [2, 'Tables'], [2, 'Languages'], [2, 'Pictures']]);
  expect(word.items.map(i => [i.depth, i.ordered, i.text])).toEqual([
    [1, false, 'Bullet one'], [1, false, 'Bullet two'], [2, false, 'Nested bullet'], [3, false, 'Deeper bullet'], [1, false, 'Bullet three'],
    [1, true, 'Number one'], [1, true, 'Number two'], [2, true, 'Nested number'],
  ]);
  expect(word.quotes).toEqual(['Quoted words from someone.An intense quote.']);
  expect(word.code).toEqual([{ info: null, text: 'print("code in Consolas")\n' }]);
  expect(word.codespans).toEqual(['monospace()']);
  expect(word.tables[0]).toMatchObject({ head: ['Name', 'Qty', 'Note'], rows: [['Bolts', '12', 'pipe | here'], ['Nuts', '7', 'two<br><br>paragraphs']] });
  expect(word.tables[1].rows).toEqual([['Merged across two', '', 'C'], ['a', 'b', 'c']]);
  expect(word.links).toEqual([{ url: 'https://example.com/word?x=1&y=2', text: 'hyperlink' }]);
  expect(word.images.map(i => [i.url.slice(0, 15), i.alt])).toEqual([['data:image/png;', 'A red rectangle'], ['data:image/jpeg', '']]);
  expect(word.strike).toEqual(['struck']);
  expect(word.breaks).toBe(1);
  expect(word.text).toContain(LANGS);

  await convert(page, 'libreoffice-rich.docx', 'Markdown');
  await expectDone(page, 'libreoffice-rich.docx');
  const lo = pyRead<Md>('md', (await download(page, 'libreoffice-rich.docx', info)).path);
  // LibreOffice writes one code element per line; every line is in the one code block.
  expect(lo.code).toEqual([{ info: null, text: 'def greet(name):\n    return f"Hello, {name}"  # *not* emphasis\n' }]);
  expect(lo.items.map(i => i.text)).toEqual(['Apples', 'Green', 'Red', 'Gala', 'Fuji', 'Pears', 'Third', 'Fourth']);
  expect(lo.text).not.toContain('javascript');
  await expect(row(page, 'libreoffice-rich.docx').locator('.job-notes')).toContainText('2 pictures are only linked from the document');
  expect(w.outside).toEqual([]);
});

test('DOCX to HTML: a standalone page that runs and loads nothing; LibreOffice reads it too', async ({ page, context }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/word-styles.docx')]);
  await convert(page, 'word-styles.docx', 'HTML');
  await expectDone(page, 'word-styles.docx');
  const { path } = await download(page, 'word-styles.docx', info);
  const html = readFileSync(path, 'utf8');
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
  expect(html).toContain('<title>Word styles sample</title>');
  // Opened on its own, the page asks for nothing.
  const view = await context.newPage();
  const requests: string[] = [];
  view.on('request', r => { if (!r.url().startsWith('data:')) requests.push(r.url()); });
  await view.setContent(html, { waitUntil: 'load' });
  expect(await view.locator('h1').allTextContents()).toEqual(['Word styles sample', 'Introduction']);
  expect(await view.locator('ul ul ul li').allTextContents()).toEqual(['Deeper bullet']);
  expect(await view.locator('ol ol li').allTextContents()).toEqual(['Nested number']);
  expect(await view.locator('blockquote p').count()).toBe(2);
  expect(await view.locator('pre').textContent()).toBe('print("code in Consolas")');
  expect(await view.locator('p code').textContent()).toBe('monospace()');
  expect(await view.locator('td[colspan="2"]').textContent()).toBe('Merged across two');
  expect(await view.locator('img[src^="data:image/"]').count()).toBe(2);
  expect(await view.locator('img').evaluateAll(imgs => imgs.map(i => (i as HTMLImageElement).naturalWidth))).toEqual([120, 60]);
  expect(await view.locator('sub').textContent()).toBe('2');
  expect(requests).toEqual([]);
  await view.close();
  const text = readFileSync(libreoffice(path, 'txt:Text (encoded):UTF8'), 'utf8');
  for (const line of ['Word styles sample', 'Deeper bullet', 'Quoted words from someone.', 'print("code in Consolas")', 'pipe | here', LANGS]) expect(text).toContain(line);
  expect(w.outside).toEqual([]);
});

test('Markdown to DOCX: python-docx and LibreOffice read the Word document', async ({ page }, info) => {
  test.slow();
  const w = await openApp(page);
  await addFiles(page, [RICH]);
  await convert(page, 'rich.md', 'DOCX');
  await expectDone(page, 'rich.md');
  const { path, filename } = await download(page, 'rich.md', info);
  expect(filename).toBe('rich.docx');
  const d = pyRead<Docx>('docx', path);
  const paras = d.blocks.filter(b => b.type === 'p') as Array<Extract<Docx['blocks'][number], { type: 'p' }>>;
  const styled = (style: string) => paras.filter(p => p.style === style).map(p => p.text);
  expect(styled('Heading 1')).toEqual(['FileConvert rich sample']);
  expect(styled('Heading 2')).toEqual(['Lists', 'Table', 'Code', 'Languages', 'Pictures']);
  expect(paras.filter(p => p.style === 'List Paragraph').map(p => [p.level, p.text])).toEqual([
    [0, 'First bullet'], [0, 'Second bullet'], [1, 'Nested bullet'], [2, 'Third level'], [0, 'Back to the top'],
    [0, 'One'], [0, 'Two'], [1, 'Two point one'], [1, 'Two point two'], [0, 'Three'],
  ]);
  const runs = paras[1].runs;
  expect(runs.find(r => r.text === 'bold')).toMatchObject({ b: true });
  expect(runs.find(r => r.text === 'italic')).toMatchObject({ i: true });
  expect(runs.find(r => r.text === 'both')).toMatchObject({ b: true, i: true });
  expect(runs.find(r => r.text === 'struck')).toMatchObject({ strike: true });
  expect(runs.find(r => r.text === 'inline code')).toMatchObject({ rStyle: 'InlineCode' });
  expect(runs.find(r => r.text === 'link')).toMatchObject({ link: 'https://example.com/page?a=1&b=2' });
  const table = d.blocks.find(b => b.type === 'table') as Extract<Docx['blocks'][number], { type: 'table' }>;
  expect(table).toEqual({ type: 'table', header: true, rows: [['Name', 'Score', 'Note'], ['Ada', '9.5', 'first'], ['Grace', '10', 'pipe | inside']] });
  expect(styled('Code Block')).toEqual(['const x = 1 < 2 && "a";\nconsole.log(x);']);
  expect(paras.map(p => p.text)).toContain(LANGS);
  expect(paras.map(p => p.text)).toContain('[Image: Remote picture]');
  expect(d.pictures.map(p => p.type)).toEqual(['image/png', 'image/jpeg']);
  const last = paras.find(p => p.text.startsWith('Final paragraph'))!;
  expect(last.runs.filter(r => r.vertAlign).map(r => [r.text, r.vertAlign])).toEqual([['sub', 'subscript'], ['sup', 'superscript'], ['2', 'subscript']]);
  expect(JSON.stringify(d)).not.toContain('alert');
  expect(d.title).toBe('FileConvert rich sample');
  expect(d.author).toBe('');
  // LibreOffice opens it as a Word document and finds the same text, in reading order.
  const text = readFileSync(libreoffice(path, 'txt:Text (encoded):UTF8'), 'utf8');
  const order = ['FileConvert rich sample', 'Nested bullet', 'Two point two', 'pipe | inside', 'console.log(x);', 'A block quote on two lines.', LANGS, '[Image: Remote picture]', 'line two.'];
  let at = 0;
  for (const s of order) { const i = text.indexOf(s, at); expect(i, s).toBeGreaterThanOrEqual(at); at = i; }
  await expect(row(page, 'rich.md').locator('.job-notes')).toContainText('nothing is downloaded');

  await documentsSetting(page, 'Page size (PDF and DOCX)', 'A4');
  await convert(page, 'rich.md', 'DOCX');
  const a4 = unzipSync(new Uint8Array(readFileSync((await download(page, 'rich.md', info)).path)));
  expect(strFromU8(a4['word/document.xml'])).toMatch(/<w:pgSz w:w="11906" w:h="16838"/);
  expect(w.outside).toEqual([]);
});

test('hostile HTML and DOCX: scripts, handlers, script links, frames and remote loads all stay out', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('hostile/hostile.html'), fx('hostile/hostile.docx')]);
  await convert(page, 'hostile.html', 'Markdown');
  await expectDone(page, 'hostile.html');
  const md = pyRead<Md>('md', (await download(page, 'hostile.html', info)).path);
  expect(md.headings).toEqual([[1, 'Hostile page']]);
  expect(md.links).toEqual([]);
  expect(md.images).toEqual([{ url: 'https://example.com/pixel.gif', alt: 'pixel' }]);
  for (const bad of ['alert', 'javascript', 'onerror', 'srcdoc', '<svg', '<iframe', '<object', '<embed', 'noscript trick', 'x.css', 'x.js', 't.png', 'svg.png', 'bg.png']) expect(md.text).not.toContain(bad);
  expect(md.text).toContain('Safe **text** survives.');
  await expect(row(page, 'hostile.html').locator('.job-notes')).toContainText('Removed');
  for (const [label, ext] of [['Markdown', 'md'], ['HTML', 'html']] as const) {
    await convert(page, 'hostile.docx', label);
    await expectDone(page, 'hostile.docx');
    const out = readFileSync((await download(page, 'hostile.docx', info)).path, 'utf8');
    expect(out, ext).not.toMatch(/javascript:|<script|<iframe|tracker\.png/i);
    expect(out, ext).toContain('Click me');
    const notes = row(page, 'hostile.docx').locator('.job-notes');
    await expect(notes).toContainText('1 picture is only linked from the document');
    await expect(notes).toContainText('macros or embedded objects');
  }
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});
