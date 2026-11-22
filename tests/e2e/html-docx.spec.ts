import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import { addFiles, convert, documentsSetting, download, expectDone, fx, libreoffice, openApp, pyRead, row, unexpectedViolations } from './helpers';

// HTML to DOCX (v0.2.0, after the Phase 1B review): the HTML is sanitized as for every output and written by the
// docx library's HTML reader, the same Word writer as Markdown to DOCX. Every result is read by python-docx and
// LibreOffice (tests/e2e/readers.py), and its XML is checked for what python-docx does not report (numbering,
// merged cells, bookmarks). Nothing may be fetched.

interface Docx {
  blocks: Array<{ type: 'p'; style: string; level: number | null; text: string; runs: Array<Record<string, unknown> & { text: string }> } | { type: 'table'; header: boolean; rows: string[][] }>;
  pictures: Array<{ type: string; bytes: number }>; title: string; author: string;
}
type Para = Extract<Docx['blocks'][number], { type: 'p' }>;
type Table = Extract<Docx['blocks'][number], { type: 'table' }>;

const LANGS = 'Zo\u00eb, na\u00efve, fa\u00e7ade. \u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac. \u0420\u0443\u0441\u0441\u043a\u0438\u0439. \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8\u3002 \u4e2d\u6587\u3002 \ud55c\uad6d\uc5b4. \u0627\u0644\u0639\u0631\u0628\u064a\u0629. \u05e2\u05d1\u05e8\u05d9\u05ea. \u0939\u093f\u0928\u094d\u0926\u0940. Emoji: \u{1F600} \u{1F44D}\u{1F3FD}.';

const paras = (d: Docx) => d.blocks.filter(b => b.type === 'p') as Para[];
const styled = (d: Docx, style: string) => paras(d).filter(p => p.style === style).map(p => p.text);
const xml = (path: string, part: string) => strFromU8(unzipSync(new Uint8Array(readFileSync(path)))[part]);

test('HTML to DOCX: headings, lists, tables, links, code and pictures in Word styles; python-docx and LibreOffice read it', async ({ page }, info) => {
  test.slow();
  const w = await openApp(page);
  await addFiles(page, [fx('document/page.html')]);
  await convert(page, 'page.html', 'DOCX');
  await expectDone(page, 'page.html');
  const { path, filename } = await download(page, 'page.html', info);
  expect(filename).toBe('page.docx');
  const d = pyRead<Docx>('docx', path);
  expect(d.title).toBe('FileConvert HTML sample');
  expect(d.author).toBe('');
  expect(styled(d, 'Heading 1')).toEqual(['Converting a page']);
  expect(styled(d, 'Heading 2')).toEqual(['Nested lists', 'Tables']);
  expect(styled(d, 'Heading 3')).toEqual(['Code']);
  expect(paras(d).filter(p => p.style === 'List Paragraph').map(p => [p.level, p.text])).toEqual([
    [0, 'Apples'], [1, 'Green'], [1, 'Red'], [2, 'Gala'], [2, 'Fuji'], [0, 'Pears'], [0, 'Third'], [0, 'Fourth'],
  ]);
  // The numbered list that starts at 3 still starts at 3.
  expect(xml(path, 'word/numbering.xml').includes('<w:startOverride w:val="3"/>'), 'list starts at 3').toBe(true);
  const text = paras(d).find(p => p.text.startsWith('Text with'))!;
  expect(text.runs.find(r => r.text === 'strong')).toMatchObject({ b: true });
  expect(text.runs.find(r => r.text === 'bold')).toMatchObject({ b: true });
  expect(text.runs.find(r => r.text === 'emphasis')).toMatchObject({ i: true });
  expect(text.runs.find(r => r.text === 'deleted')).toMatchObject({ strike: true });
  expect(text.runs.find(r => r.text === 'a <code> span')).toMatchObject({ rStyle: 'InlineCode' });
  expect(text.runs.find(r => r.text === 'link with a title')).toMatchObject({ link: 'https://example.com/docs' });
  expect(text.runs.find(r => r.text === 'relative link')).toMatchObject({ link: 'relative/page.html' });
  // The script link keeps its text, without a link: only the two real links are links.
  expect(text.runs.filter(r => r.link).map(r => r.link)).toEqual(['https://example.com/docs', 'relative/page.html']);
  expect(text.text).toContain('and a script link.');
  expect(text.text).toContain('Characters that mean something in Markdown: * _ # [x] 1. stay text.');
  const tables = d.blocks.filter(b => b.type === 'table') as Table[];
  expect(tables).toEqual([
    { type: 'table', header: true, rows: [['Item', 'Price', 'Note'], ['Tea', '2.50', 'Hot | iced'], ['Coffee', '3.00', 'Two\nparagraphs']] },
    { type: 'table', header: false, rows: [['no', 'header'], ['row', 'here']] },
  ]);
  expect(styled(d, 'Code Block')).toEqual(['def greet(name):\n    return f"Hello, {name}"  # *not* emphasis']);
  const all = paras(d).map(p => p.text);
  expect(all).toContain('Quoted text.');
  expect(all).toContain(LANGS);
  expect(all).toContain('\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064a \u0645\u0646 \u0627\u0644\u064a\u0645\u064a\u0646 \u0625\u0644\u0649 \u0627\u0644\u064a\u0633\u0627\u0631.');
  // The picture inside the file is in the document; the web and relative pictures are their descriptions.
  expect(d.pictures.map(p => p.type)).toEqual(['image/png']);
  expect(all.find(t => t.includes('[Image: Remote photo]'))).toContain('[Image: Relative picture]');
  const sub = paras(d).find(p => p.text.startsWith('Line'))!;
  expect(sub.runs.filter(r => r.vertAlign).map(r => [r.text, r.vertAlign])).toEqual([['2', 'subscript'], ['2', 'superscript']]);
  // The page's menu and footer are part of its body, so they are converted too.
  expect(all).toContain('Home | About');
  expect(all).toContain('Footer text');
  const json = JSON.stringify(d);
  for (const bad of ['alert', 'document.title', 'changed', 'Send', 'steal', 'frame', 'should not appear']) expect(json).not.toContain(bad);
  const notes = row(page, 'page.html').locator('.job-notes');
  await expect(notes).toContainText('Styles (fonts, colors, sizes, layout) are not applied');
  await expect(notes).toContainText('2 pictures from the web or relative addresses became their description; nothing is downloaded.');
  await expect(notes).toContainText('Removed');
  // LibreOffice opens it as a Word document and finds the same text, in reading order.
  const lo = readFileSync(libreoffice(path, 'txt:Text (encoded):UTF8'), 'utf8');
  const order = ['Home | About', 'Converting a page', 'Gala', 'Fourth', 'Hot | iced', 'def greet(name):', 'Second quoted paragraph.', LANGS, '[Image: Remote photo]', 'Footer text'];
  let at = 0;
  for (const s of order) { const i = lo.indexOf(s, at); expect(i, s).toBeGreaterThanOrEqual(at); at = i; }

  await documentsSetting(page, 'Page size (PDF and DOCX)', 'A4');
  await convert(page, 'page.html', 'DOCX');
  expect(/<w:pgSz w:w="11906" w:h="16838"/.test(xml((await download(page, 'page.html', info)).path, 'word/document.xml')), 'A4 page').toBe(true);
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});

test('HTML to DOCX: page structure Markdown never has - sections, figures, merged and nested cells, links within the page', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('document/structure.html')]);
  await convert(page, 'structure.html', 'DOCX');
  await expectDone(page, 'structure.html');
  const { path } = await download(page, 'structure.html', info);
  const d = pyRead<Docx>('docx', path);
  expect(d.title).toBe('Page structure sample');
  expect(styled(d, 'Heading 1')).toEqual(['Page structure']);
  expect(styled(d, 'Heading 2')).toEqual(['Part 2']);
  expect([styled(d, 'Heading 4'), styled(d, 'Heading 5'), styled(d, 'Heading 6')]).toEqual([['Fourth level'], ['Fifth level'], ['Sixth level']]);
  const all = paras(d).map(p => p.text);
  for (const t of ['Site header', 'A paragraph inside two divs.', 'Loose text in a div.', 'A JPEG with a caption', 'Term', 'Its definition',
    'Summary line', 'Text inside details.', 'Aside text.', 'Site footer']) expect(all, t).toContain(t);
  expect(styled(d, 'Code Block')).toEqual(['def f():\n    return 1']);
  const marks = paras(d).find(p => p.text.startsWith('underlined'))!;
  expect(marks.runs.find(r => r.text === 'struck')).toMatchObject({ strike: true });
  expect(marks.text).toContain('\u201ca quotation\u201d');
  // JPEG, GIF and PNG are in the document (the PNG twice); WebP and SVG, which Word cannot show, are their descriptions.
  expect(d.pictures.map(p => p.type).sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/png']);
  expect(all.find(t => t.includes('[Image: WebP picture]'))).toContain('[Image: SVG drawing]');
  await expect(row(page, 'structure.html').locator('.job-notes')).toContainText('2 pictures in formats Word cannot show became their description. PNG, JPEG, GIF and BMP pictures inside the HTML file are included.');
  // The table keeps its merged cells (python-docx repeats a merged cell's text) and the table inside a cell.
  const [table] = d.blocks.filter(b => b.type === 'table') as Table[];
  expect(table.rows).toEqual([['Two columns wide', 'Two columns wide', 'Third'], ['Two rows tall', 'b1', 'c1'], ['Two rows tall', 'b2', '']]);
  const doc = xml(path, 'word/document.xml');
  const has = (re: RegExp) => re.test(doc);
  expect(has(/<w:gridSpan w:val="2"\/>/), 'two columns merged').toBe(true);
  expect(has(/<w:vMerge w:val="restart"\/>[\s\S]*<w:vMerge w:val="continue"\/>/), 'two rows merged').toBe(true);
  expect(doc.match(/<w:tbl>/g)).toHaveLength(2);
  expect(has(/<w:tbl>(?:(?!<\/w:tbl>)[\s\S])*<w:tbl>[\s\S]*Nested cell/), 'a table inside the table').toBe(true);
  // The link to #part-2 points at a bookmark on that heading.
  expect(has(/<w:hyperlink w:history="1" w:anchor="part_2">/), 'link to the bookmark').toBe(true);
  expect(has(/<w:pStyle w:val="Heading2"\/><\/w:pPr><w:bookmarkStart w:name="part_2" w:id="\d+"\/>/), 'bookmark on the heading').toBe(true);
  expect(xml(path, 'word/numbering.xml').includes('<w:startOverride w:val="7"/>'), 'list starts at 7').toBe(true);
  const lo = readFileSync(libreoffice(path, 'txt:Text (encoded):UTF8'), 'utf8');
  for (const t of ['Two columns wide', 'Nested cell', 'Seventh', 'Text in a span']) expect(lo).toContain(t);
  expect(w.outside).toEqual([]);
});

test('hostile HTML to DOCX: no script, handler, script link, frame or remote load reaches the Word document', async ({ page }, info) => {
  const w = await openApp(page);
  await addFiles(page, [fx('hostile/hostile.html')]);
  await convert(page, 'hostile.html', 'DOCX');
  await expectDone(page, 'hostile.html');
  const path = (await download(page, 'hostile.html', info)).path;
  const parts = unzipSync(new Uint8Array(readFileSync(path)));
  const everything = Object.values(parts).map(b => strFromU8(b)).join('\n');
  for (const bad of ['alert', 'javascript', 'onerror', 'srcdoc', '<script', 'x.css', 'x.js', 't.png', 'svg.png', 'bg.png', 'example.com/pixel.gif']) expect(everything).not.toContain(bad);
  // A DOCX holds no external relationships: nothing in it can be fetched when it is opened.
  expect(strFromU8(parts['word/_rels/document.xml.rels'])).not.toContain('TargetMode="External"');
  const d = pyRead<Docx>('docx', path);
  expect(styled(d, 'Heading 1')).toEqual(['Hostile page']);
  expect(paras(d).map(p => p.text)).toContain('Safe text survives.');
  await expect(row(page, 'hostile.html').locator('.job-notes')).toContainText('Removed');
  expect(w.outside).toEqual([]);
  expect(await unexpectedViolations(page)).toEqual([]);
});
