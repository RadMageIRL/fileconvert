import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { docxToHtml, mammothHtmlToText } from '../../src/engines/document/docx';
import { renderDocx } from '../../src/engines/document/docxwrite';

// Phase 1B documents (v0.2.0), the worker side: Mammoth's HTML for DOCX to HTML and Markdown, and the docx library
// for Markdown to DOCX. The page side (sanitizing, Turndown) needs a browser and is in tests/e2e/docs.spec.ts.

const fx = (p: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', p)));

describe('DOCX to HTML (Mammoth, before sanitizing)', () => {
  test('Word styles: title, headings, quotes, lists to three levels, tables, links, pictures, code by font', async () => {
    const r = await docxToHtml(fx('document/word-styles.docx'));
    const h = r.html;
    expect(h).toContain('<h1>Word styles sample</h1>');
    expect(h).toContain('<h1>Introduction</h1>');
    expect(h).toContain('<strong>bold</strong>');
    expect(h).toContain('<em>italic</em>');
    expect(h).toContain('<s>struck</s>');
    expect(h).toContain('H<sub>2</sub>O');
    expect(h).toContain('x<sup>2</sup>');
    expect(h).toContain('<a href="https://example.com/word?x=1&amp;y=2">hyperlink</a>');
    expect(h).toContain('A line<br />broken in two.');
    expect(h).toMatch(/<ul><li>Bullet one<\/li><li>Bullet two<ul><li>Nested bullet<ul><li>Deeper bullet<\/li><\/ul><\/li><\/ul><\/li><li>Bullet three<\/li><\/ul>/);
    expect(h).toMatch(/<ol><li>Number one<\/li><li>Number two<ol><li>Nested number<\/li><\/ol><\/li><\/ol>/);
    expect(h).toContain('<blockquote><p>Quoted words from someone.</p><p>An intense quote.</p></blockquote>');
    expect(h).toContain('<pre>print("code in Consolas")</pre>');
    expect(h).toContain('Inline <code>monospace()</code> inside text.');
    expect(h).toContain('<td colspan="2"><p>Merged across two</p></td>');
    expect(h).toContain('<p>pipe | here</p>');
    expect(h).toContain('\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8');
    expect(h).toContain('\u{1F44D}\u{1F3FD}');
    expect((h.match(/<img [^>]*src="data:image\/(png|jpeg);base64,/g) ?? []).length).toBe(2);
    expect(h).toContain('alt="A red rectangle"');
    expect(r.pictures).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  test('LibreOffice styles: code and quotation styles, header rows, and a picture that was only linked', async () => {
    const r = await docxToHtml(fx('document/libreoffice-rich.docx'));
    expect(r.html).toContain('<h1>Converting a page</h1>');
    // One code element per line; the page joins them into one code block before Markdown is written.
    expect(r.html).toMatch(/<pre><code>def greet\(name\):<\/code>\n<code> {4}return f"Hello, \{name\}"/);
    expect(r.warnings).toEqual(['2 pictures are only linked from the document, to a file or web address. They were not fetched and are left out.']);
    expect(r.html).toContain('<code>a &lt;code&gt; span</code>');
    expect(r.html).toMatch(/<blockquote><p>Quoted text\.<\/p><p>Second quoted paragraph\.<\/p><\/blockquote>/);
    expect(r.html).toMatch(/<thead><tr><th>/);
  });

  test('a hostile DOCX: its own style map is ignored, the linked picture is not fetched, macros are named', async () => {
    const r = await docxToHtml(fx('hostile/hostile.docx'));
    expect(r.html).not.toMatch(/<script|<iframe/);
    expect(r.html).toContain('<h1>Introduction</h1>');
    expect(r.warnings).toContain('1 picture is only linked from the document, to a file or web address. It was not fetched and is left out.');
    expect(r.warnings).toContain('The document contains macros or embedded objects. They were not opened or run.');
    // The javascript: link is in Mammoth's HTML; the page's sanitizer removes it before anything uses the HTML.
    expect(r.html).toContain('javascript:alert(1)');
  });

  test('zip bombs and files that are not Word documents are refused before Mammoth opens them', async () => {
    await expect(docxToHtml(fx('hostile/zip-bomb.docx'))).rejects.toThrow(/unpack|limit|bomb/i);
    await expect(docxToHtml(fx('data/types.xlsx'))).rejects.toThrow(/not a Word document/);
  });

  test('plain text keeps code blocks as lines', () => {
    expect(mammothHtmlToText('<p>a</p><pre>x = 1\ny = 2</pre><p>b</p>').text).toBe('a\nx = 1\ny = 2\nb\n');
  });
});

describe('Markdown to DOCX (docx library, from clean HTML)', () => {
  const PNG = readFileSync(join(__dirname, '..', 'fixtures', 'image', 'alpha.png')).toString('base64');
  const html = '<h1>Title \u00e9</h1><p>Some <strong>bold</strong> and <em>italic</em> with <code>code</code> and a <a href="https://example.com/">link</a>.</p>'
    + '<ul><li>one<ul><li>nested</li></ul></li></ul><ol><li>first</li></ol>'
    + '<table><thead><tr><th>A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    + '<pre><code>let x = 1;\nlet y = 2;</code></pre><blockquote><p>quoted</p></blockquote>'
    + `<p><img src="data:image/png;base64,${PNG}" alt="alpha"></p><p>H<sub>2</sub>O and x<sup>2</sup>, \u65e5\u672c \u{1F600}</p>`;

  test('a Word package with the right parts, styles, numbering, a picture, and no author', async () => {
    const r = await renderDocx(html, 'Title \u00e9', 'LETTER');
    const parts = unzipSync(r.bytes);
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml']));
    const doc = strFromU8(parts['word/document.xml']);
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('<w:pStyle w:val="CodeBlock"/>');
    expect(doc).toContain('<w:rStyle w:val="InlineCode"/>');
    expect(doc).toContain('<w:tblHeader/>');
    expect(doc).toContain('<w:vertAlign w:val="subscript"/>');
    expect(doc).toContain('\u65e5\u672c \u{1F600}');
    expect(doc).toMatch(/<w:pgSz w:w="12240" w:h="15840"/);
    expect(Object.keys(parts).filter(n => n.startsWith('word/media/'))).toHaveLength(1);
    expect(strFromU8(parts['word/styles.xml'])).toContain('w:styleId="CodeBlock"');
    const core = strFromU8(parts['docProps/core.xml']);
    expect(core).toContain('<dc:title>Title \u00e9</dc:title>');
    expect(core).not.toMatch(/Un-named/);
    expect(r.warnings).toEqual([]);
  });

  test('A4 pages; anything Word cannot hold is reported, never fetched', async () => {
    const r = await renderDocx('<p>x</p><p><img src="https://example.com/x.png" alt="far"></p><video src="v.mp4"></video><p><a href="javascript:alert(1)">bad</a></p>', 'T', 'A4');
    expect(strFromU8(unzipSync(r.bytes)['word/document.xml'])).toMatch(/<w:pgSz w:w="11906" w:h="16838"/);
    expect(r.warnings).toEqual(expect.arrayContaining(['1 picture without data was left out.', '1 part of the document that Word cannot hold was left out.', '1 link that could run code kept its text without the link.']));
  });
});
