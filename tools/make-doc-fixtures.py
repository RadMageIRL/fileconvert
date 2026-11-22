"""Writes the Phase 1B document and data fixtures in tests/fixtures/ (v0.2.0): rich Markdown, HTML and DOCX
documents, XLS and ODS workbooks, JSON Lines, XML and YAML tables, and hostile files for each.

    python tools/make-doc-fixtures.py

Needs Python with Pillow, openpyxl and python-docx, and LibreOffice (soffice on PATH, or in its default Windows
folder), which writes the XLS, ODS and one of the DOCX files from sources made here. Everything is synthetic. Run it
only when a fixture has to change: the files are committed so the tests do not depend on these tools. It is kept
apart from make-fixtures.py so that running it does not rewrite the older fixtures.
"""

import base64
import datetime
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures')
DOC = os.path.join(ROOT, 'document')
DAT = os.path.join(ROOT, 'data')
BAD = os.path.join(ROOT, 'hostile')


def write(path, data):
    with open(path, 'wb' if isinstance(data, bytes) else 'w', **({} if isinstance(data, bytes) else {'encoding': 'utf-8', 'newline': '\n'})) as f:
        f.write(data)


def soffice():
    for c in (shutil.which('soffice'), r'C:\Program Files\LibreOffice\program\soffice.exe', '/usr/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'):
        if c and os.path.exists(c):
            return c
    sys.exit('LibreOffice (soffice) was not found.')


def libreoffice(src, fmt, dest):
    """Converts src with LibreOffice into dest, in a private profile so a running LibreOffice is not disturbed."""
    with tempfile.TemporaryDirectory() as tmp:
        profile = 'file:///' + os.path.join(tmp, 'profile').replace('\\', '/').lstrip('/')
        subprocess.run([soffice(), f'-env:UserInstallation={profile}', '--headless', '--convert-to', fmt, '--outdir', tmp, src], check=True, capture_output=True)
        made = [f for f in os.listdir(tmp) if f != 'profile']
        if len(made) != 1:
            sys.exit(f'LibreOffice did not convert {src}: {made}')
        shutil.move(os.path.join(tmp, made[0]), dest)


def picture_bytes(color, size, fmt):
    buf = io.BytesIO()
    Image.new('RGB', size, color).save(buf, fmt, **({'quality': 90} if fmt == 'JPEG' else {}))
    return buf.getvalue()


PNG = picture_bytes((200, 30, 40), (120, 80), 'PNG')
JPG = picture_bytes((30, 90, 200), (60, 60), 'JPEG')
B64_PNG = base64.b64encode(PNG).decode()
B64_JPG = base64.b64encode(JPG).decode()
LANGS = ('Zo\u00eb, na\u00efve, fa\u00e7ade. \u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac. \u0420\u0443\u0441\u0441\u043a\u0438\u0439. '
         '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8\u3002 \u4e2d\u6587\u3002 \ud55c\uad6d\uc5b4. \u0627\u0644\u0639\u0631\u0628\u064a\u0629. '
         '\u05e2\u05d1\u05e8\u05d9\u05ea. \u0939\u093f\u0928\u094d\u0926\u0940. Emoji: \U0001F600 \U0001F44D\U0001F3FD.')
BT = '`'

# ---------------------------------------------------------------- Markdown (stored as .markdown: *.md is not committed)

MARKDOWN = f"""# FileConvert rich sample

A paragraph with **bold**, *italic*, ***both***, ~~struck~~, {BT}inline code{BT} and a [link](https://example.com/page?a=1&b=2).

## Lists

- First bullet
- Second bullet
  - Nested bullet
    - Third level
- Back to the top

1. One
2. Two
   1. Two point one
   2. Two point two
3. Three

## Table

| Name | Score | Note |
|:-----|------:|:----:|
| Ada | 9.5 | first |
| Grace | 10 | pipe \\| inside |

## Code

{BT * 3}js
const x = 1 < 2 && "a";
console.log(x);
{BT * 3}

> A block quote
> on two lines.

## Languages

{LANGS}

## Pictures

![A red rectangle](data:image/png;base64,{B64_PNG})

![A blue square](data:image/jpeg;base64,{B64_JPG})

![Remote picture](https://example.com/remote.png)

Line one with a hard break\\
line two.

---

Final paragraph with <sub>sub</sub> and <sup>sup</sup>, H<sub>2</sub>O.<script>alert(1)</script>
"""
write(os.path.join(DOC, 'rich.markdown'), MARKDOWN)

# ---------------------------------------------------------------- HTML page (for HTML to Markdown)

HTML = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FileConvert HTML sample</title>
<style>body {{ font-family: serif; background: url(https://example.com/bg.png); }}</style>
<link rel="stylesheet" href="https://example.com/site.css">
<script>document.title = 'changed';</script>
</head>
<body>
<nav><a href="/">Home</a> | <a href="/about">About</a></nav>
<main>
<article>
<h1>Converting a page</h1>
<p>Text with <strong>strong</strong>, <b>bold</b>, <em>emphasis</em>, <i>italic</i>, <del>deleted</del>, <code>a &lt;code&gt; span</code>,
a <a href="https://example.com/docs" title="Docs">link with a title</a>, a <a href="relative/page.html">relative link</a> and
<a href="javascript:alert(1)">a script link</a>. Characters that mean something in Markdown: * _ # [x] 1. stay text.</p>
<h2>Nested lists</h2>
<ul>
<li>Apples
<ul><li>Green</li><li>Red<ol><li>Gala</li><li>Fuji</li></ol></li></ul>
</li>
<li>Pears</li>
</ul>
<ol start="3"><li>Third</li><li>Fourth</li></ol>
<h2>Tables</h2>
<table>
<thead><tr><th align="left">Item</th><th align="right">Price</th><th>Note</th></tr></thead>
<tbody>
<tr><td>Tea</td><td align="right">2.50</td><td>Hot | iced</td></tr>
<tr><td>Coffee</td><td align="right">3.00</td><td><p>Two</p><p>paragraphs</p></td></tr>
</tbody>
</table>
<table><tr><td>no</td><td>header</td></tr><tr><td>row</td><td>here</td></tr></table>
<h3>Code</h3>
<pre><code class="language-python">def greet(name):
    return f"Hello, {{name}}"  # *not* emphasis
</code></pre>
<blockquote><p>Quoted text.</p><p>Second quoted paragraph.</p></blockquote>
<p>{LANGS}</p>
<p dir="rtl">\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064a \u0645\u0646 \u0627\u0644\u064a\u0645\u064a\u0646 \u0625\u0644\u0649 \u0627\u0644\u064a\u0633\u0627\u0631.</p>
<p><img src="data:image/png;base64,{B64_PNG}" alt="Embedded red"> <img src="https://example.com/photo.jpg" alt="Remote photo"> <img src="images/local.png" alt="Relative picture"></p>
<p>Line<br>break, H<sub>2</sub>O and x<sup>2</sup>.</p>
<hr>
<form action="https://example.com/steal"><input name="q"><button>Send</button></form>
<iframe src="https://example.com/frame"></iframe>
<p onclick="alert(2)">A paragraph with an event handler.</p>
<!-- a comment that should not appear -->
</article>
</main>
<footer><p>Footer text</p></footer>
</body>
</html>
"""
write(os.path.join(DOC, 'page.html'), HTML)

# ---------------------------------------------------------------- DOCX written by python-docx, with Word's style names

import docx  # noqa: E402
from docx.enum.text import WD_BREAK  # noqa: E402
from docx.oxml import OxmlElement  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402
from docx.shared import Pt  # noqa: E402


def hyperlink(paragraph, url, text):
    rid = paragraph.part.relate_to(url, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', is_external=True)
    link = OxmlElement('w:hyperlink')
    link.set(qn('r:id'), rid)
    run = OxmlElement('w:r')
    rpr = OxmlElement('w:rPr')
    style = OxmlElement('w:rStyle')
    style.set(qn('w:val'), 'Hyperlink')
    rpr.append(style)
    run.append(rpr)
    t = OxmlElement('w:t')
    t.text = text
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def header_row(table):
    trpr = table.rows[0]._tr.get_or_add_trPr()
    h = OxmlElement('w:tblHeader')
    trpr.append(h)


d = docx.Document()
d.core_properties.author = ''
d.add_paragraph('Word styles sample', style='Title')
d.add_heading('Introduction', level=1)
p = d.add_paragraph('Plain text, ')
p.add_run('bold').bold = True
p.add_run(', ')
p.add_run('italic').italic = True
p.add_run(', ')
r = p.add_run('struck')
r.font.strike = True
p.add_run(', H')
r = p.add_run('2')
r.font.subscript = True
p.add_run('O, x')
r = p.add_run('2')
r.font.superscript = True
p.add_run(' and a ')
hyperlink(p, 'https://example.com/word?x=1&y=2', 'hyperlink')
p.add_run('.')
p = d.add_paragraph('A line')
p.add_run().add_break(WD_BREAK.LINE)
p.add_run('broken in two.')
d.add_heading('Lists', level=2)
d.add_paragraph('Bullet one', style='List Bullet')
d.add_paragraph('Bullet two', style='List Bullet')
d.add_paragraph('Nested bullet', style='List Bullet 2')
d.add_paragraph('Deeper bullet', style='List Bullet 3')
d.add_paragraph('Bullet three', style='List Bullet')
d.add_paragraph('Number one', style='List Number')
d.add_paragraph('Number two', style='List Number')
d.add_paragraph('Nested number', style='List Number 2')
d.add_heading('Quote and code', level=2)
d.add_paragraph('Quoted words from someone.', style='Quote')
d.add_paragraph('An intense quote.', style='Intense Quote')
code = d.add_paragraph()
r = code.add_run('print("code in Consolas")')
r.font.name = 'Consolas'
p = d.add_paragraph('Inline ')
r = p.add_run('monospace()')
r.font.name = 'Courier New'
p.add_run(' inside text.')
d.add_heading('Tables', level=2)
t = d.add_table(rows=3, cols=3)
t.style = 'Table Grid'
for i, row in enumerate([('Name', 'Qty', 'Note'), ('Bolts', '12', 'pipe | here'), ('Nuts', '7', '')]):
    for j, v in enumerate(row):
        t.cell(i, j).text = v
header_row(t)
t.cell(2, 2).paragraphs[0].add_run('two')
t.cell(2, 2).add_paragraph('paragraphs')
t2 = d.add_table(rows=2, cols=3)
t2.style = 'Table Grid'
merged = t2.cell(0, 0).merge(t2.cell(0, 1))
merged.text = 'Merged across two'
t2.cell(0, 2).text = 'C'
t2.cell(1, 0).text = 'a'
t2.cell(1, 1).text = 'b'
t2.cell(1, 2).text = 'c'
d.add_heading('Languages', level=2)
d.add_paragraph(LANGS)
d.add_heading('Pictures', level=2)
d.add_picture(io.BytesIO(PNG))
d.paragraphs[-1].runs[0]._r.xpath('.//wp:docPr')[0].set('descr', 'A red rectangle')
d.add_picture(io.BytesIO(JPG))
d.add_paragraph('The end.')
docx_path = os.path.join(DOC, 'word-styles.docx')
d.save(docx_path)

# ---------------------------------------------------------------- DOCX written by LibreOffice (its own style names, a linked picture)

with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, 'libreoffice-rich.html')
    body = HTML.split('<article>')[1].split('</article>')[0]
    body = body.replace('<form', '<!--').replace('</form>', '-->').replace('<iframe', '<!--').replace('</iframe>', '-->').replace(' onclick="alert(2)"', '')
    write(src, f'<!doctype html><html><head><meta charset="utf-8"><title>LibreOffice sample</title></head><body>{body}</body></html>')
    libreoffice(src, 'docx:MS Word 2007 XML', os.path.join(DOC, 'libreoffice-rich.docx'))

# ---------------------------------------------------------------- hostile DOCX: macros named, a script link, an embedded style map, a linked picture

with zipfile.ZipFile(docx_path) as z:
    parts = {n: z.read(n) for n in z.namelist()}
doc_xml = parts['word/document.xml'].decode('utf-8')
rels = parts['word/_rels/document.xml.rels'].decode('utf-8')
rels = rels.replace('</Relationships>',
                    '<Relationship Id="rIdJs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>'
                    '<Relationship Id="rIdFar" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/tracker.png" TargetMode="External"/>'
                    '</Relationships>')
js_link = '<w:p><w:hyperlink r:id="rIdJs"><w:r><w:t>Click me</w:t></w:r></w:hyperlink></w:p>'
far_pic = ('<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="99" name="far" descr="Tracker"/>'
           '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
           '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="99" name="far"/><pic:cNvPicPr/></pic:nvPicPr>'
           '<pic:blipFill><a:blip r:link="rIdFar"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>'
           '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
doc_xml = doc_xml.replace('<w:body>', '<w:body>' + js_link + far_pic, 1)
parts['word/document.xml'] = doc_xml.encode('utf-8')
parts['word/_rels/document.xml.rels'] = rels.encode('utf-8')
# A Mammoth style map inside the document that would turn paragraphs into script elements, if it were honored.
parts['mammoth/style-map'] = b"p => script:fresh\nr => iframe\n"
ct = parts['[Content_Types].xml'].decode('utf-8')
parts['[Content_Types].xml'] = ct.replace('</Types>', '<Override PartName="/mammoth/style-map" ContentType="text/prs.mammoth.style-map"/></Types>').encode('utf-8')
root_rels = parts['_rels/.rels'].decode('utf-8')
parts['_rels/.rels'] = root_rels.replace('</Relationships>', '<Relationship Id="rIdMammoth" Type="http://schemas.zwobble.org/mammoth/style-map" Target="/mammoth/style-map"/></Relationships>').encode('utf-8')
parts['word/vbaProject.bin'] = b'not really a macro project'
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in parts.items():
        z.writestr(name, data)
write(os.path.join(BAD, 'hostile.docx'), buf.getvalue())

# ---------------------------------------------------------------- hostile HTML

write(os.path.join(BAD, 'hostile.html'), """<!doctype html>
<html><head><meta http-equiv="refresh" content="0;url=https://example.com/"><base href="https://example.com/">
<link rel="stylesheet" href="https://example.com/x.css"><script src="https://example.com/x.js"></script></head>
<body onload="alert(1)">
<h1>Hostile page</h1>
<img src="https://example.com/pixel.gif" onerror="alert(2)" alt="pixel">
<a href="javascript:alert(3)">script link</a> <a href="JaVaScRiPt:alert(4)">mixed case</a> <a href="data:text/html,<script>alert(5)</script>">data link</a>
<svg><script>alert(6)</script><image href="https://example.com/svg.png"/></svg>
<iframe srcdoc="<script>alert(7)</script>"></iframe>
<object data="https://example.com/x.swf"></object><embed src="https://example.com/x.swf">
<div style="background:url(https://example.com/bg.png)">styled</div>
<p>Safe <b>text</b> survives.</p>
<math><mi xlink:href="javascript:alert(8)">x</mi></math>
<noscript><p title="</noscript><img src=x onerror=alert(9)>">noscript trick</p></noscript>
<template><img src="https://example.com/t.png"></template>
</body></html>
""")

# ---------------------------------------------------------------- XLS and ODS workbooks (LibreOffice writes both from one source)

import openpyxl  # noqa: E402

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Data'
ws.append(['Text', 'Number', 'Date', 'DateTime', 'Time', 'Percent', 'Money', 'Flag', 'Empty', 'Formula', 'Error'])
ws.append(['Zo\u00eb \u65e5\u672c \U0001F600 \u0645\u0631\u062d\u0628\u0627', 0.1 + 0.2, datetime.date(2026, 11, 22), datetime.datetime(2026, 11, 22, 14, 30, 5), datetime.time(14, 30), 0.25, 1234.5, True, None, '=B2*2', '=1/0'])
ws.append(['Line one\nLine two', -1234.5678, datetime.date(1900, 3, 1), datetime.datetime(2000, 2, 29, 23, 59, 59), datetime.time(0, 0, 1), 1.5, -0.01, False, None, '=SUM(B2:B3)', None])
ws.append([None] * 11)
ws.append(['01234', 123456789012345, datetime.date(1999, 12, 31), None, None, None, None, None, None, '=A5&"!"', None])
ws.append(['=not a formula', 1e21, None, None, None, None, None, None, None, None, None])
for r in (2, 3, 5):
    ws.cell(r, 3).number_format = 'yyyy-mm-dd'
for r in (2, 3):
    ws.cell(r, 4).number_format = 'yyyy-mm-dd hh:mm:ss'
    ws.cell(r, 5).number_format = 'hh:mm:ss'
    ws.cell(r, 6).number_format = '0%'
    ws.cell(r, 7).number_format = '#,##0.00'
ws['A5'].data_type = 's'
ws['A6'].data_type = 's'
ws.column_dimensions['A'].width = 30
ws2 = wb.create_sheet('Second')
ws2.append(['Merged heading', None, 'C'])
ws2.append([1, 2, 3])
ws2.merge_cells('A1:B1')
ws3 = wb.create_sheet('Hidden')
ws3.append(['secret', 42])
ws3.sheet_state = 'hidden'
with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, 'legacy.xlsx')
    wb.save(src)
    libreoffice(src, 'xls:MS Excel 97', os.path.join(DAT, 'legacy.xls'))
    libreoffice(src, 'ods', os.path.join(DAT, 'legacy.ods'))

# ---------------------------------------------------------------- JSON Lines

events = [
    {'id': 1, 'user': {'name': 'Ada', 'city': 'London'}, 'tags': ['a', 'b'], 'ok': True, 'n': 9007199254740993},
    {'id': 2, 'user': {'name': 'Zo\u00eb \U0001F600', 'city': '\u6771\u4eac'}, 'tags': [], 'ok': False, 'note': 'line\nbreak, "quoted"'},
    {'id': 3, 'user': {'name': '=cmd', 'city': None}, 'ok': None, 'extra': 1.5},
]
lines = [json.dumps(e, ensure_ascii=False, separators=(',', ':')) for e in events]
# The 2^53 + 1 integer is written exactly, as Python does.
write(os.path.join(DAT, 'events.jsonl'), '\r\n'.join([lines[0], lines[1], '', lines[2]]) + '\r\n')
write(os.path.join(BAD, 'bad-line.jsonl'), '{"a":1}\n{"a":2}\n{"a": oops}\n{"a":4}\n')

# ---------------------------------------------------------------- XML and YAML tables

write(os.path.join(DAT, 'library.xml'), """<?xml version="1.0" encoding="UTF-8"?>
<library xmlns:x="urn:example" owner="Town">
  <meta><updated>2026-11-22</updated></meta>
  <book id="b1" lang="en">
    <title>Converting Files</title>
    <author>Ada</author>
    <price currency="USD">12.50</price>
    <isbn>0123456789</isbn>
    <tag>data</tag>
    <tag>privacy</tag>
    <x:shelf>A1</x:shelf>
  </book>
  <book id="b2">
    <title>Privacy &amp; You \u2713</title>
    <author>Zo\u00eb</author>
    <summary><![CDATA[Contains <markup> that is text.]]></summary>
    <tag>privacy</tag>
  </book>
  <book id="b3">
    <title>=HYPERLINK("x")</title>
    <author/>
    <price currency="EUR">9</price>
  </book>
  <magazine id="m1"><title>Monthly</title><issue>11</issue></magazine>
  <magazine id="m2"><title>Weekly</title><issue>47</issue></magazine>
</library>
""")
write(os.path.join(DAT, 'inventory.yaml'), """# Inventory, as YAML
defaults: &defaults
  unit: piece
  taxable: true
items:
  - sku: A-001
    name: Bolt
    qty: 120
    price: 0.25
    <<: *defaults
    sizes: [M4, M5]
  - sku: '00042'
    name: "Nut \u2713"
    qty: 0
    price: 0.1
    <<: *defaults
    dims: {w: 5, h: 2.5}
  - sku: B-7
    name: =SUM(1)
    qty: null
    released: 2026-11-22
""")
write(os.path.join(BAD, 'unsafe-tags.yaml'), """- !!python/object/apply:os.system ["echo owned"]
- !!js/function "function () { return 1 }"
- !ruby/object:Gem::Installer {a: 1}
- plain
""")
write(os.path.join(BAD, 'deep.yaml'), '[' * 20000 + ']' * 20000 + '\n')
write(os.path.join(BAD, 'external-dtd.xml'), '<?xml version="1.0"?>\n<!DOCTYPE r SYSTEM "https://example.com/r.dtd">\n<r><row><a>1</a></row><row><a>2</a></row></r>\n')

print('Phase 1B fixtures written to', os.path.normpath(ROOT))
