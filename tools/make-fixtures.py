"""Writes the small sample files in tests/fixtures/ that the test suites convert.

    python tools/make-fixtures.py

Needs FFmpeg on PATH and Python with Pillow 11.3 or later (AVIF), pillow-heif, openpyxl and
python-docx. Every picture, sound and document here is synthetic: gradients, test patterns, sine
tones and placeholder text. Run it only when a fixture has to change; the files are committed so the
tests do not depend on these tools.
"""

import io
import json
import math
import os
import struct
import subprocess
import sys
import zipfile
import zlib

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures')
IMG = os.path.join(ROOT, 'image')
AUD = os.path.join(ROOT, 'audio')
VID = os.path.join(ROOT, 'video')
DOC = os.path.join(ROOT, 'document')
DAT = os.path.join(ROOT, 'data')
BAD = os.path.join(ROOT, 'hostile')
for d in (IMG, AUD, VID, DOC, DAT, BAD):
    os.makedirs(d, exist_ok=True)


def ffmpeg(*args):
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args]
    subprocess.run(cmd, check=True)


def write(path, data, mode='wb'):
    with open(path, mode, **({} if 'b' in mode else {'encoding': 'utf-8', 'newline': '\n'})) as f:
        f.write(data)


# ---------------------------------------------------------------- images

W, H = 320, 200


def rgba_art():
    """A gradient with a transparent hole and a half-transparent band, so alpha handling shows."""
    im = Image.new('RGBA', (W, H))
    px = im.load()
    for y in range(H):
        for x in range(W):
            r = int(255 * x / (W - 1))
            g = int(255 * y / (H - 1))
            b = 160
            a = 255
            if (x - 80) ** 2 + (y - 100) ** 2 < 40 ** 2:
                a = 0
            elif 200 <= x < 280:
                a = 128
            px[x, y] = (r, g, b, a)
    d = ImageDraw.Draw(im)
    d.rectangle([250, 20, 300, 60], fill=(255, 255, 255, 255))
    return im


def photo_art():
    """An opaque picture with a clear 'up': a dark top band and a red marker in the top-left corner."""
    im = Image.new('RGB', (W, H), (90, 140, 200))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 40], fill=(20, 30, 60))
    d.rectangle([0, 0, 30, 30], fill=(230, 30, 30))
    for i in range(0, W, 20):
        d.line([i, 60, i + 40, H], fill=(240, 240, 240), width=3)
    return im


art = rgba_art()
art.save(os.path.join(IMG, 'alpha.png'))
art.save(os.path.join(IMG, 'alpha.webp'), lossless=True)
art.save(os.path.join(IMG, 'alpha.avif'), quality=80)
art.save(os.path.join(IMG, 'alpha.tiff'), compression='tiff_lzw')
import pillow_heif  # noqa: E402

pillow_heif.register_heif_opener()
art.save(os.path.join(IMG, 'alpha.heic'), quality=80)
photo = photo_art()
photo.save(os.path.join(IMG, 'photo.jpg'), quality=90)
photo.save(os.path.join(IMG, 'photo.bmp'))
photo.save(os.path.join(IMG, 'photo.heic'), quality=80)
photo.save(os.path.join(IMG, 'photo.tiff'))
photo.convert('P', palette=Image.ADAPTIVE).save(os.path.join(IMG, 'photo.gif'))

# EXIF orientation 6: the stored pixels are rotated 90 degrees counterclockwise, and viewers
# rotate them back clockwise. A correct converter outputs 320x200 with the red corner top left.
stored = photo.transpose(Image.Transpose.ROTATE_90)
exif = Image.Exif()
exif[0x0112] = 6
exif[0x010F] = 'FileConvert fixture'
exif[0x8825] = {1: 'N', 2: (40.0, 26.0, 46.0)}  # GPS block, which the output must not carry
stored.save(os.path.join(IMG, 'rotated-exif6.jpg'), quality=90, exif=exif)

# Animations: three frames, red, green, blue.
frames = [Image.new('RGB', (64, 48), c) for c in ((220, 40, 40), (40, 200, 60), (40, 60, 220))]
frames[0].save(os.path.join(IMG, 'animated.gif'), save_all=True, append_images=frames[1:], duration=200, loop=0)
frames[0].save(os.path.join(IMG, 'animated.webp'), save_all=True, append_images=frames[1:], duration=200, loop=0, lossless=True)
frames[0].save(os.path.join(IMG, 'animated.png'), save_all=True, append_images=frames[1:], duration=200, loop=0)

# Two-page TIFF.
photo.save(os.path.join(IMG, 'two-pages.tiff'), save_all=True, append_images=[art.convert('RGB')])

# A PNG whose name says JPEG.
art.save(os.path.join(IMG, 'png-named.jpg'), format='PNG')

# ---------------------------------------------------------------- audio

TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=3',
        '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]', '-map', '[a]']
ffmpeg(*TONE, '-c:a', 'pcm_s16le', os.path.join(AUD, 'tone.wav'))
ffmpeg(*TONE, '-c:a', 'libmp3lame', '-b:a', '160k', os.path.join(AUD, 'tone.mp3'))
ffmpeg(*TONE, '-c:a', 'flac', os.path.join(AUD, 'tone.flac'))
ffmpeg(*TONE, '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', os.path.join(AUD, 'tone.aac'))
ffmpeg(*TONE, '-c:a', 'aac', '-b:a', '128k', os.path.join(AUD, 'tone.m4a'))
ffmpeg(*TONE, '-c:a', 'libvorbis', '-q:a', '4', os.path.join(AUD, 'tone-vorbis.ogg'))
ffmpeg(*TONE, '-c:a', 'libopus', '-b:a', '96k', os.path.join(AUD, 'tone-opus.ogg'))
ffmpeg(*TONE, '-c:a', 'alac', os.path.join(AUD, 'tone-alac.m4a'))
# ID3 tags and cover art, which the converter has to read past.
ffmpeg(*TONE, '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', 'title=Fixture Tone',
       '-metadata', 'artist=FileConvert tests', os.path.join(AUD, 'tagged.mp3'))

# ---------------------------------------------------------------- video

SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2',
       '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2']
ffmpeg(*SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-c:a', 'aac', '-b:a', '96k',
       '-movflags', '+faststart', '-shortest', os.path.join(VID, 'clip.mp4'))
ffmpeg(*SRC, '-c:v', 'libvpx-vp9', '-b:v', '300k', '-c:a', 'libopus', '-b:a', '64k', '-shortest', os.path.join(VID, 'clip.webm'))
ffmpeg(*SRC, '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libvorbis', '-shortest', os.path.join(VID, 'clip-vp8.webm'))
ffmpeg(*SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', os.path.join(VID, 'clip.mov'))
ffmpeg(*SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', os.path.join(VID, 'clip.mkv'))
ffmpeg(*SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', os.path.join(VID, 'silent.mp4'))
ffmpeg(*SRC, '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', os.path.join(VID, 'clip.avi'))
# Display matrix rotation of 90 degrees: stored 320x240, shown 240x320.
ffmpeg('-display_rotation', '-90', '-i', os.path.join(VID, 'silent.mp4'), '-c', 'copy', os.path.join(VID, 'rotated.mp4'))

# ---------------------------------------------------------------- documents

LOREM = ('Converting files should not mean uploading them. This sample paragraph is long enough to wrap '
         'across several lines of a PDF page, and it carries accented letters (caf\u00e9, na\u00efve, '
         '\u00fcber, \u00e5ngstr\u00f6m) and a Greek word (\u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1) '
         'so that font coverage is exercised.')
lines = ['FileConvert text sample', '=======================', '']
for i in range(1, 121):
    lines.append(f'{i:03d}. {LOREM if i % 10 == 1 else "Line " + str(i) + " of the sample text file."}')
lines.append('\tA tab-indented line, and the end of the file.')
write(os.path.join(DOC, 'sample.txt'), '\n'.join(lines) + '\n', 'w')
with open(os.path.join(DOC, 'utf16.txt'), 'wb') as f:
    f.write('\ufeffUTF-16 text with a BOM: caf\u00e9 \u2713\r\nSecond line.\r\n'.encode('utf-16-le'))
with open(os.path.join(DOC, 'latin1.txt'), 'wb') as f:
    f.write('Windows-1252 text: caf\u00e9, \u00a33, na\u00efve.\r\n'.encode('cp1252'))

PIXEL = ('data:image/png;base64,'
         'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC')
md = f"""# FileConvert Markdown sample

A paragraph with **bold**, *italic*, `inline code` and a [link](https://radmagelabs.com/).

## Lists

- First item
- Second item with **emphasis**
  - A nested item
1. Numbered one
2. Numbered two

## Code

```js
function hello(name) {{
  return `Hello, ${{name}}`;
}}
```

## Table

| Format | Kind | Lossy |
|--------|------|-------|
| PNG | Image | No |
| MP3 | Audio | Yes |

> A block quote that spans
> two source lines.

![A tiny embedded image]({PIXEL})

![A remote image that must not be fetched](https://example.com/remote.png)

<p onclick="alert(1)">Inline HTML paragraph.</p>
<script>window.__fileconvertPwned = true</script>
<a href="javascript:alert(1)">A javascript: link</a>

---

Final paragraph: caf\u00e9 and \u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1.
"""
# Stored as .txt: the repository keeps no Markdown files besides README and CHANGELOG. The tests hand it
# to the app under the name sample.md.
write(os.path.join(DOC, 'markdown-sample.txt'), md, 'w')

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FileConvert HTML sample</title>
<style>body {{ font-family: serif; }} .note {{ color: #a00; }}</style>
<link rel="stylesheet" href="https://example.com/remote.css">
<script>window.__fileconvertPwned = true</script>
</head>
<body>
<h1>FileConvert HTML sample</h1>
<p>A paragraph with <strong>bold</strong>, <em>italic</em>, <code>code</code> and a <a href="https://radmagelabs.com/">link</a>.</p>
<p class="note">A styled note.</p>
<h2>A list</h2>
<ul><li>One</li><li>Two<ul><li>Two point one</li></ul></li></ul>
<h2>A table</h2>
<table border="1"><thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta</td><td>2</td></tr></tbody></table>
<pre>preformatted
  text block</pre>
<img src="{PIXEL}" alt="Embedded pixel" width="32" height="32">
<img src="https://example.com/remote.png" alt="Remote image">
<iframe src="https://example.com/"></iframe>
<form action="https://example.com/"><input name="q"></form>
<img src="x" onerror="window.__fileconvertPwned = true">
<p>The end: caf\u00e9.</p>
</body>
</html>
"""
write(os.path.join(DOC, 'sample.html'), html, 'w')

# Scanned-style PDF: two pages that are pictures only, with no text layer.
scan = Image.new('RGB', (850, 1100), 'white')
d = ImageDraw.Draw(scan)
d.text((100, 100), 'This page is a picture of text, not text.', fill='black')
scan.save(os.path.join(DOC, 'scanned.pdf'), save_all=True, append_images=[scan.copy()], resolution=100)

import docx  # noqa: E402
from docx.shared import Pt  # noqa: E402

doc = docx.Document()
doc.add_heading('FileConvert DOCX sample', level=1)
doc.add_paragraph('A first paragraph with ').add_run('bold text').bold = True
p = doc.add_paragraph('Before the tab\tafter the tab.')
p = doc.add_paragraph('A line')
p.add_run().add_break()
p.add_run('broken in two.')
doc.add_paragraph('First bullet', style='List Bullet')
doc.add_paragraph('Second bullet', style='List Bullet')
t = doc.add_table(rows=2, cols=2)
t.cell(0, 0).text, t.cell(0, 1).text, t.cell(1, 0).text, t.cell(1, 1).text = 'Name', 'Value', 'Alpha', '1'
doc.add_paragraph('Accents: caf\u00e9, na\u00efve. Greek: \u03ba\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1.')
doc.save(os.path.join(DOC, 'sample.docx'))

# ---------------------------------------------------------------- data

records = [
    {'id': 1, 'name': 'Ada', 'email': 'ada@example.com', 'active': True, 'score': 9.5,
     'tags': ['admin', 'ops'], 'address': {'city': 'London', 'zip': '01234'}},
    {'id': 2, 'name': 'Grace, "Amazing"', 'email': 'grace@example.com', 'active': False, 'score': None,
     'tags': [], 'address': {'city': 'New York', 'zip': '10001'}, 'note': 'Line one\nLine two'},
    {'id': 3, 'name': 'Linus \u00e9\u00e8\u00ea \u2713', 'email': 'linus@example.org', 'active': True, 'score': 7,
     'tags': ['dev'], 'address': {'city': 'Portland', 'zip': '97201'}},
]
write(os.path.join(DAT, 'records.json'), json.dumps(records, indent=2, ensure_ascii=False) + '\n', 'w')
csv_text = ('id,name,email,amount,joined,zip,comment\r\n'
            '1,Ada Lovelace,ada@example.com,1200.50,2024-01-15,01234,"Says ""hello"", often"\r\n'
            '2,Grace Hopper,grace@example.com,-35,2023-12-01,10001,"Multi\r\nline"\r\n'
            '3,Linus \u00e9\u00e8,linus@example.org,0,2022-07-04,97201,\r\n')
write(os.path.join(DAT, 'people.csv'), '\ufeff' + csv_text, 'w')
write(os.path.join(DAT, 'semicolon.csv'), 'a;b;c\n1;2,5;x\n4;5,25;y\n', 'w')
yaml_text = """# FileConvert YAML sample
defaults: &defaults
  retries: 3
  timeout: 2.5
services:
  - name: web
    <<: *defaults
    ports: [80, 443]
    enabled: true
  - name: worker
    <<: *defaults
    enabled: false
    note: |
      Multi-line
      literal text
released: 2026-11-15
empty: null
"""
write(os.path.join(DAT, 'config.yaml'), yaml_text, 'w')
xml_text = """<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns:x="urn:example">
  <book id="b1" lang="en">
    <title>Converting Files</title>
    <author>Ada</author>
    <price currency="USD">12.50</price>
    <x:tag>one</x:tag>
  </book>
  <book id="b2">
    <title>Privacy &amp; You</title>
    <author>Grace</author>
    <summary><![CDATA[Contains <markup> that is text.]]></summary>
  </book>
</catalog>
"""
write(os.path.join(DAT, 'catalog.xml'), xml_text, 'w')

import openpyxl  # noqa: E402
import datetime  # noqa: E402

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'People'
ws.append(['Name', 'Joined', 'Amount', 'Zip', 'Active'])
ws.append(['Ada', datetime.date(2024, 1, 15), 1200.5, '01234', True])
ws.append(['Grace', datetime.date(2023, 12, 1), -35, '10001', False])
ws.append(['Comma, "quoted"', datetime.date(2022, 7, 4), 0, '97201', True])
ws['B2'].number_format = 'yyyy-mm-dd'
ws['B3'].number_format = 'yyyy-mm-dd'
ws['B4'].number_format = 'yyyy-mm-dd'
ws2 = wb.create_sheet('Totals')
ws2.append(['Metric', 'Value'])
ws2.append(['Count', 3])
ws2.append(['Note', 'placeholder'])
ws2['B3'] = '=1+1 is text here'
ws2['B3'].data_type = 's'  # text that starts with =, not a formula
# A real formula. openpyxl stores no cached result, as many generators do; the converter has to say so.
ws2.append(['Doubled', '=B2*2'])
wb.save(os.path.join(DAT, 'workbook.xlsx'))

# ---------------------------------------------------------------- workbooks with every kind of value (v0.2.0)
from openpyxl.utils.datetime import CALENDAR_MAC_1904  # noqa: E402

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Types'
ws.append(['Text', 'Number', 'Date', 'DateTime', 'Time', 'Percent', 'Flag', 'Empty', 'Error', 'Big'])
ws.append(['Zoë 日本 \U0001F600 مرحبا', 0.1 + 0.2, datetime.date(2026, 11, 22), datetime.datetime(2026, 11, 22, 14, 30, 5), datetime.time(14, 30), 0.25, True, None, '#DIV/0!', 9007199254740993])
ws.append(['=not a formula', -1234.5678, datetime.date(1900, 3, 1), datetime.datetime(2000, 2, 29, 23, 59, 59), datetime.time(0, 0, 1), 1.5, False, None, None, 12345678901234567890])
ws.append([None] * 10)
ws.append(['last', 1e21, None, None, None, None, None, None, None, None])
for r in (2, 3):
    ws.cell(r, 3).number_format = 'yyyy-mm-dd'
    ws.cell(r, 4).number_format = 'yyyy-mm-dd hh:mm:ss'
    ws.cell(r, 5).number_format = 'hh:mm:ss'
    ws.cell(r, 6).number_format = '0%'
ws['A3'].data_type = 's'
ws['I2'].data_type = 'e'
ws2 = wb.create_sheet('Second')
ws2.append(['a', 'b'])
ws2.append([1, 2])
wb.save(os.path.join(DAT, 'types.xlsx'))

wb = openpyxl.Workbook()
wb.epoch = CALENDAR_MAC_1904
ws = wb.active
ws.title = 'Mac'
ws.append(['When'])
ws.append([datetime.date(2026, 11, 22)])
ws['A2'].number_format = 'yyyy-mm-dd'
wb.save(os.path.join(DAT, 'dates1904.xlsx'))

# ---------------------------------------------------------------- hostile inputs

write(os.path.join(BAD, 'xxe.xml'), '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>\n', 'w')
laughs = ['<?xml version="1.0"?>', '<!DOCTYPE lolz [', '<!ENTITY lol "lol">']
for i in range(1, 10):
    prev = 'lol' if i == 1 else f'lol{i - 1}'
    laughs.append(f'<!ENTITY lol{i} "' + ('&' + prev + ';') * 10 + '">')
laughs += [']>', '<lolz>&lol9;</lolz>']
write(os.path.join(BAD, 'billion-laughs.xml'), '\n'.join(laughs) + '\n', 'w')
bomb = ['a: &a ["x","x","x","x","x","x","x","x","x"]']
for c, p in zip('bcdefghi', 'abcdefgh'):
    bomb.append(f'{c}: &{c} [' + ','.join(['*' + p] * 9) + ']')
write(os.path.join(BAD, 'yaml-bomb.yaml'), '\n'.join(bomb) + '\n', 'w')
write(os.path.join(BAD, 'formulas.csv'), 'name,value\n"=HYPERLINK(""https://example.com"",""click"")",1\n+SUM(1;2),2\n@cmd,3\n-5,4\n', 'w')
deep = '[' * 5000 + ']' * 5000
write(os.path.join(BAD, 'deep.json'), deep, 'w')
write(os.path.join(BAD, 'random.jpg'), bytes((i * 7919) % 256 for i in range(4096)))
with open(os.path.join(IMG, 'alpha.png'), 'rb') as f:
    png = f.read()
write(os.path.join(BAD, 'truncated.png'), png[: len(png) // 2])


def png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


# PNG that claims 60000 x 60000 pixels (3.6 gigapixels) with almost no data: a decompression bomb.
huge = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 60000, 60000, 8, 6, 0, 0, 0))
huge += png_chunk(b'IDAT', zlib.compress(b'\x00' * 1024)) + png_chunk(b'IEND', b'')
write(os.path.join(BAD, 'huge-dimensions.png'), huge)
# A DOCX whose document part inflates to 1.5 GB from about 1.5 MB.
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    with z.open('word/document.xml', 'w', force_zip64=True) as w:
        block = b' ' * (1 << 20)
        for _ in range(1536):
            w.write(block)
write(os.path.join(BAD, 'zip-bomb.docx'), buf.getvalue())
write(os.path.join(BAD, 'not-a-pdf.pdf'), b'%PDF-1.7\n% only a header, then nothing usable\n')
write(os.path.join(BAD, 'empty.csv'), b'')
print('fixtures written to', os.path.normpath(ROOT))
