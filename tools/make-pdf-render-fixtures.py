"""Writes the fixtures for PDF to JPG and PNG, the page previews and Remove PDF metadata (v0.2.0, Phase 2) into
tests/fixtures/pdf-render/: hand-written PDFs, so no PDF library's habits leak into them.

    python tools/make-pdf-render-fixtures.py      (needs Pillow with JPEG 2000; the multilingual fixture is made by
                                                  tools/make-pdf-render-fonts.mjs, which prints a page in Chrome)

- rotations.pdf: four pages turned 0, 90, 180 and 270 degrees, each drawn so its top, bottom and sides differ.
- boxes.pdf: a crop box inside the media box; a media box whose origin is not 0 0, with the crop box inherited from
  the page tree; a page with UserUnit 2; a crop box larger than its media box (clipped to it).
- sizes.pdf: a banner 2000 x 100 points, a page 10 x 10 points, and A0 (2384 x 3370 points: 139 megapixels at 300 dpi).
- transparency.pdf: constant opacity, a Multiply blend, a luminosity soft mask, a picture with a soft mask, a
  transparency group; page 2 paints nothing behind its shapes (for a transparent PNG background).
- annotations.pdf: annotations with appearances (a square, free text, a note, a highlight), one hidden and one not
  shown on screen (neither may appear in a picture).
- fonts-std.pdf: the standard fonts a PDF may name without including them (Helvetica, Times, Courier, Symbol,
  ZapfDingbats), which pdf.js draws from its own font files.
- fonts-sans.pdf: Helvetica and Arial in their four styles, not included, with WinAnsi accents, quotes and the euro sign.
- jpx-cmyk.pdf: a JPEG 2000 picture (pdf.js's OpenJPEG decoder), and CMYK colors and a CMYK JPEG (its color module).
- big-picture.pdf: one page showing a 30-megapixel JPEG (one gray, so the file is small): previews of it need more
  memory than a small allowance, while editing it does not.
- metadata.pdf: metadata in every place Remove PDF metadata removes it, each with a marker word (MARK-...), an
  incremental update over an older version with its own metadata, and what must stay, with markers (KEEP-...):
  a comment with its author, an attachment, a filled-in form field, a bookmark and a link.

Everything is synthetic.
"""

import io
import os
import struct
import sys
import zlib

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures', 'pdf-render')


def write(name, data):
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, name), 'wb') as f:
        f.write(data)


def stream(data, extra=b''):
    return b'<< /Length %d%s >>\nstream\n' % (len(data), extra) + data + b'\nendstream'


def flate(data):
    return zlib.compress(data, 9)


def body(objs, version=b'1.7'):
    out = bytearray(b'%PDF-' + version + b'\n%\xe2\xe3\xcf\xd3\n')
    offs = {}
    for k in sorted(objs):
        offs[k] = len(out)
        out += b'%d 0 obj\n' % k + objs[k] + b'\nendobj\n'
    return out, offs


def xref_table(offs, size, start=0):
    out = b'xref\n0 %d\n0000000000 65535 f \n' % size
    for k in range(1, size):
        out += (b'%010d 00000 n \n' % offs[k]) if k in offs else b'0000000000 65535 f \n'
    return out


def pdf(objs, root=1, info=None, file_id=None, version=b'1.7'):
    out, offs = body(objs, version)
    size = max(objs) + 1
    x = len(out)
    out += xref_table(offs, size)
    trailer = b'<< /Size %d /Root %d 0 R' % (size, root)
    if info:
        trailer += b' /Info %d 0 R' % info
    if file_id:
        trailer += b' /ID [<%s> <%s>]' % (file_id, file_id)
    out += b'trailer\n' + trailer + b' >>\nstartxref\n%d\n%%%%EOF\n' % x
    return bytes(out)


def pages(kids, extra=b''):
    return b'<< /Type /Pages /Count %d /Kids [%s]%s >>' % (len(kids), b' '.join(b'%d 0 R' % k for k in kids), extra)


def page(content, resources, media=b'[0 0 612 792]', extra=b'', parent=2):
    return b'<< /Type /Page /Parent %d 0 R /MediaBox %s /Resources %s /Contents %d 0 R%s >>' % (parent, media, resources, content, extra)


HELV = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'


def text(s, x, y, size=24, font=b'/F1'):
    return b'BT %s %d Tf %d %d Td (%s) Tj ET\n' % (font, size, x, y, s)


def marked_page():
    """A page whose top, bottom and sides differ: red square top left, blue bar along the bottom, green at the right."""
    return (b'1 0 0 rg 36 680 76 76 re f\n0 0 1 rg 36 36 540 30 re f\n0 0.6 0 rg 520 300 56 200 re f\n'
            b'0 g ' + text(b'TOP LEFT', 130, 700, 28) + text(b'Bottom', 250, 80, 20))


def rotations():
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV, 4: stream(marked_page())}
    kids = []
    for i, r in enumerate([0, 90, 180, 270]):
        n = 10 + i
        objs[n] = page(4, b'<< /Font << /F1 3 0 R >> >>', extra=b' /Rotate %d' % r)
        kids.append(n)
    objs[2] = pages(kids)
    write('rotations.pdf', pdf(objs))


def grid_content(x0, y0, x1, y1, step=50):
    out = bytearray()
    i = 0
    for x in range(x0, x1, step):
        for y in range(y0, y1, step):
            r, g, b = (i * 37 % 255) / 255, (i * 91 % 255) / 255, (i * 53 % 255) / 255
            out += b'%.3f %.3f %.3f rg %d %d %d %d re f\n' % (r, g, b, x, y, step - 4, step - 4)
            i += 1
    return bytes(out)


def boxes():
    res = b'<< /Font << /F1 3 0 R >> >>'
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV}
    objs[4] = stream(grid_content(0, 0, 612, 792) + b'0 g ' + text(b'CROP 100 150', 110, 470, 18))
    objs[10] = page(4, res, extra=b' /CropBox [100 150 400 500]')
    # A media box away from 0 0, its crop box inherited from an intermediate page tree node.
    objs[5] = stream(grid_content(-200, -100, 412, 692) + b'0 g ' + text(b'ORIGIN -200 -100', -150, 600, 18))
    objs[11] = b'<< /Type /Page /Parent 20 0 R /Resources %s /Contents 5 0 R >>' % res
    objs[20] = b'<< /Type /Pages /Parent 2 0 R /Count 1 /Kids [11 0 R] /MediaBox [-200 -100 412 692] /CropBox [-150 -50 350 600] >>'
    objs[6] = stream(grid_content(0, 0, 300, 200, 25) + b'0 g ' + text(b'UserUnit 2', 20, 160, 14))
    objs[12] = page(6, res, media=b'[0 0 300 200]', extra=b' /UserUnit 2')
    objs[7] = stream(grid_content(0, 0, 400, 300) + b'0 g ' + text(b'CROP PAST MEDIA', 20, 260, 16))
    objs[13] = page(7, res, media=b'[0 0 400 300]', extra=b' /CropBox [-100 -100 900 900]')
    objs[2] = b'<< /Type /Pages /Count 4 /Kids [10 0 R 20 0 R 12 0 R 13 0 R] >>'
    write('boxes.pdf', pdf(objs, version=b'1.6'))


def sizes():
    res = b'<< /Font << /F1 3 0 R >> >>'
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV}
    objs[4] = stream(b'0.9 0.5 0.1 rg 0 0 2000 100 re f\n0 g ' + text(b'A banner 2000 by 100 points', 40, 40, 36))
    objs[10] = page(4, res, media=b'[0 0 2000 100]')
    objs[5] = stream(b'1 0 0 rg 0 0 5 5 re f\n0 0 1 rg 5 5 5 5 re f\n')
    objs[11] = page(5, res, media=b'[0 0 10 10]')
    objs[6] = stream(grid_content(0, 0, 2384, 3370, 200) + b'0 g ' + text(b'A0', 100, 3200, 120))
    objs[12] = page(6, res, media=b'[0 0 2384 3370]')
    objs[2] = pages([10, 11, 12])
    write('sizes.pdf', pdf(objs))


def form(content, bbox, resources=b'<< >>', group=b''):
    return stream(content, b' /Type /XObject /Subtype /Form /BBox %s /Resources %s%s' % (bbox, resources, group))


def transparency():
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV}
    # Graphics states: half opacity, Multiply, and a luminosity soft mask whose group is a gray ramp.
    objs[4] = b'<< /Type /ExtGState /ca 0.5 /CA 0.5 >>'
    objs[5] = b'<< /Type /ExtGState /BM /Multiply >>'
    ramp = bytearray()
    for i in range(20):
        g = i / 19
        ramp += b'%.3f g %d 420 15 220 re f\n' % (g, 310 + i * 15)
    objs[6] = form(bytes(ramp), b'[0 0 612 792]', group=b' /Group << /S /Transparency /CS /DeviceGray >>')
    objs[7] = b'<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >>'
    # A picture with a soft mask: a color gradient, its alpha a radial falloff.
    w = h = 128
    rgb = bytearray()
    alpha = bytearray()
    for y in range(h):
        for x in range(w):
            rgb += bytes((x * 2, y * 2, 255 - x))
            d = ((x - 64) ** 2 + (y - 64) ** 2) ** 0.5
            alpha.append(max(0, min(255, int(255 - d * 4))))
    objs[8] = stream(flate(bytes(alpha)), b' /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode' % (w, h))
    objs[9] = stream(flate(bytes(rgb)), b' /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 8 0 R' % (w, h))
    # A transparency group drawn at half opacity as a whole: its two overlapping squares do not show through each other.
    objs[14] = form(b'1 0 0 rg 0 0 120 120 re f\n0 0 1 rg 60 60 120 120 re f\n', b'[0 0 180 180]', group=b' /Group << /S /Transparency /I true /K true >>')
    res = b'<< /Font << /F1 3 0 R >> /ExtGState << /Half 4 0 R /Mul 5 0 R /Mask 7 0 R >> /XObject << /Img 9 0 R /Grp 14 0 R >> >>'
    c = (b'1 1 1 rg 0 0 612 792 re f\n'
         b'q /Half gs 1 0 0 rg 40 560 200 160 re f 0 0 1 rg 140 620 200 160 re f Q\n'
         b'q 1 1 0 rg 360 560 200 160 re f /Mul gs 0 1 1 rg 420 620 160 140 re f Q\n'
         b'q /Mask gs 0.8 0 0.4 rg 300 420 320 220 re f Q\n'
         b'q 200 0 0 200 40 300 cm /Img Do Q\n'
         b'q /Half gs 1 0 0 1 60 60 cm /Grp Do Q\n'
         b'0 g ' + text(b'Transparency', 360, 300, 22))
    objs[10] = stream(c)
    objs[11] = page(10, res)
    # Page 2: nothing behind the shapes, so a transparent background shows through.
    objs[12] = stream(b'q /Half gs 0 0.5 1 rg 100 100 300 300 re f Q\n1 0 0 rg 250 400 200 200 re f\n')
    objs[13] = page(12, res)
    objs[2] = pages([11, 13])
    write('transparency.pdf', pdf(objs, version=b'1.7'))


def annotations():
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV}
    objs[4] = stream(b'0 g ' + text(b'Annotations on this page', 72, 720, 20))
    ap = lambda content, bbox, res=b'<< /Font << /F1 3 0 R >> >>': form(content, bbox, res)
    objs[20] = ap(b'0 0 1 RG 4 w 2 2 196 96 re S\n', b'[0 0 200 100]')
    objs[21] = b'<< /Type /Annot /Subtype /Square /Rect [72 560 272 660] /C [0 0 1] /AP << /N 20 0 R >> /F 4 /T (Reviewer) /Contents (A square) >>'
    objs[22] = ap(b'1 1 0.8 rg 0 0 220 60 re f 0 g ' + text(b'Free text note', 8, 22, 16), b'[0 0 220 60]')
    objs[23] = b'<< /Type /Annot /Subtype /FreeText /Rect [320 600 540 660] /DA (/F1 16 Tf 0 g) /AP << /N 22 0 R >> /F 4 /Contents (Free text note) >>'
    objs[24] = ap(b'1 0.85 0 rg 0 0 24 24 re f 0 g 4 4 16 16 re S\n', b'[0 0 24 24]')
    objs[25] = b'<< /Type /Annot /Subtype /Text /Rect [80 480 104 504] /AP << /N 24 0 R >> /F 4 /T (Reviewer) /Contents (A sticky note) >>'
    objs[26] = ap(b'/Multiply gs 1 1 0 rg 0 0 300 24 re f\n', b'[0 0 300 24]', b'<< /ExtGState << /Multiply << /BM /Multiply >> >> >>')
    objs[27] = b'<< /Type /Annot /Subtype /Highlight /Rect [68 712 368 736] /QuadPoints [68 736 368 736 68 712 368 712] /C [1 1 0] /AP << /N 26 0 R >> /F 4 >>'
    # Hidden (flag 2) and not shown on screen (NoView, flag 32): neither may appear.
    objs[28] = ap(b'1 0 0 rg 0 0 100 100 re f\n', b'[0 0 100 100]')
    objs[29] = b'<< /Type /Annot /Subtype /Square /Rect [400 300 500 400] /AP << /N 28 0 R >> /F 2 >>'
    objs[30] = b'<< /Type /Annot /Subtype /Square /Rect [400 150 500 250] /AP << /N 28 0 R >> /F 32 >>'
    objs[10] = page(4, b'<< /Font << /F1 3 0 R >> >>', extra=b' /Annots [21 0 R 23 0 R 25 0 R 27 0 R 29 0 R 30 0 R]')
    objs[2] = pages([10])
    write('annotations.pdf', pdf(objs))


def fonts_std():
    names = [b'Helvetica', b'Helvetica-Bold', b'Helvetica-Oblique', b'Times-Roman', b'Times-Italic', b'Times-Bold', b'Courier', b'Courier-Bold', b'Symbol', b'ZapfDingbats']
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>'}
    fonts = b''
    content = bytearray()
    for i, n in enumerate(names):
        objs[20 + i] = b'<< /Type /Font /Subtype /Type1 /BaseFont /%s%s >>' % (n, b'' if n in (b'Symbol', b'ZapfDingbats') else b' /Encoding /WinAnsiEncoding')
        fonts += b'/F%d %d 0 R ' % (i, 20 + i)
        sample = b'abgdeAB 12345' if n in (b'Symbol', b'ZapfDingbats') else n + b': The quick brown fox jumps 0123'
        content += b'BT /F%d 20 Tf 50 %d Td (%s) Tj ET\n' % (i, 740 - i * 60, sample)
    objs[3] = stream(bytes(content))
    objs[10] = page(3, b'<< /Font << %s>> >>' % fonts)
    objs[2] = pages([10])
    write('fonts-std.pdf', pdf(objs))


def fonts_sans():
    """Helvetica (Type 1) and Arial (TrueType) in their four styles, none included, as many PDF writers leave them:
    pdf.js draws them all with its sans-serif font files. WinAnsi accents, quotes, the euro sign and the middle dot."""
    helv = [b'Helvetica', b'Helvetica-Bold', b'Helvetica-Oblique', b'Helvetica-BoldOblique']
    arial = [(b'Arial', 400, 0), (b'Arial,Bold', 700, 0), (b'Arial,Italic', 400, -12), (b'Arial,BoldItalic', 700, -12)]
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>'}
    fonts = b''
    k = 0
    for n in helv:
        objs[20 + k] = b'<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding /WinAnsiEncoding >>' % n
        fonts += b'/F%d %d 0 R ' % (k, 20 + k)
        k += 1
    for n, weight, angle in arial:
        objs[40 + k] = (b'<< /Type /FontDescriptor /FontName /%s /Flags %d /FontBBox [-665 -325 2000 1006] /ItalicAngle %d'
                        b' /Ascent 905 /Descent -212 /CapHeight 716 /StemV %d /FontWeight %d >>' % (n, 32 + (64 if angle else 0), angle, 80 if weight == 400 else 140, weight))
        objs[20 + k] = b'<< /Type /Font /Subtype /TrueType /BaseFont /%s /Encoding /WinAnsiEncoding /FontDescriptor %d 0 R >>' % (n, 40 + k)
        fonts += b'/F%d %d 0 R ' % (k, 20 + k)
        k += 1
    sample = b'Hamburgefonstiv 0123 \\300\\351\\356\\365\\374 \\307\\361\\337 \\200\\223\\224\\225\\226\\227\\205\\231 \\267'
    content = bytearray()
    for i, n in enumerate(helv + [a[0] for a in arial]):
        y = 750 - i * 90
        content += b'BT /F%d 10 Tf 40 %d Td (%s:) Tj ET\n' % (i, y, n)
        content += b'BT /F%d 28 Tf 40 %d Td (%s) Tj ET\n' % (i, y - 34, sample)
    objs[3] = stream(bytes(content))
    objs[10] = page(3, b'<< /Font << %s>> >>' % fonts)
    objs[2] = pages([10])
    write('fonts-sans.pdf', pdf(objs))


def jpx_cmyk():
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV}
    img = Image.new('RGB', (160, 120))
    px = img.load()
    for y in range(120):
        for x in range(160):
            px[x, y] = (x * 255 // 159, y * 255 // 119, 128 if (x // 20 + y // 20) % 2 else 32)
    b = io.BytesIO()
    img.save(b, 'JPEG2000', irreversible=False)
    jp2 = b.getvalue()
    objs[4] = stream(jp2, b' /Type /XObject /Subtype /Image /Width 160 /Height 120 /Filter /JPXDecode')
    objs[5] = stream(b'q 320 0 0 240 146 450 cm /Jpx Do Q\n0 g ' + text(b'JPEG 2000 picture', 146, 410, 18))
    objs[10] = page(5, b'<< /Font << /F1 3 0 R >> /XObject << /Jpx 4 0 R >> >>')
    cmyk = Image.new('CMYK', (120, 80))
    q = cmyk.load()
    for y in range(80):
        for x in range(120):
            q[x, y] = (x * 2, y * 3, 0 if x < 60 else 200, 0)
    b = io.BytesIO()
    cmyk.save(b, 'JPEG', quality=95)
    # Pillow writes CMYK JPEGs Adobe-style (inverted), so the picture needs the inverted Decode.
    objs[6] = stream(b.getvalue(), b' /Type /XObject /Subtype /Image /Width 120 /Height 80 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0 1 0 1 0 1 0]')
    objs[7] = stream(b'1 0 0 0 k 50 600 120 120 re f\n0 1 0 0 k 200 600 120 120 re f\n0 0 1 0 k 350 600 120 120 re f\n0 0 0 1 k 50 450 120 120 re f\n'
                     b'0.5 0.2 0 0.1 k 200 450 270 120 re f\nq 360 0 0 240 50 150 cm /Cmyk Do Q\n0 g ' + text(b'CMYK', 50, 100, 18))
    objs[11] = page(7, b'<< /Font << /F1 3 0 R >> /XObject << /Cmyk 6 0 R >> >>')
    objs[2] = pages([10, 11])
    write('jpx-cmyk.pdf', pdf(objs))


def big_picture():
    img = Image.new('L', (6000, 5000), 180)
    b = io.BytesIO()
    img.save(b, 'JPEG', quality=50)
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV}
    objs[4] = stream(b.getvalue(), b' /Type /XObject /Subtype /Image /Width 6000 /Height 5000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode')
    objs[5] = stream(b'q 540 0 0 450 36 300 cm /Big Do Q\n0 g ' + text(b'A 30-megapixel picture', 36, 260, 18))
    objs[10] = page(5, b'<< /Font << /F1 3 0 R >> /XObject << /Big 4 0 R >> >>')
    objs[2] = pages([10])
    write('big-picture.pdf', pdf(objs))


# ------------------------------------------------------------------ metadata

def tiff_ascii(tags):
    """A little-endian TIFF block with ASCII tags (the body of an EXIF segment)."""
    n = len(tags)
    data_at = 8 + 2 + n * 12 + 4
    entries = b''
    blob = b''
    for tag, value in tags:
        v = value + b'\0'
        entries += struct.pack('<HHII', tag, 2, len(v), data_at + len(blob))
        blob += v
    return b'II*\0' + struct.pack('<I', 8) + struct.pack('<H', n) + entries + struct.pack('<I', 0) + blob


def seg(marker, payload):
    return bytes((0xFF, marker)) + struct.pack('>H', len(payload) + 2) + payload


def jpeg_with_metadata():
    img = Image.new('RGB', (64, 48))
    px = img.load()
    for y in range(48):
        for x in range(64):
            px[x, y] = (x * 4, y * 5, 128)
    b = io.BytesIO()
    img.save(b, 'JPEG', quality=90)
    j = b.getvalue()
    assert j[:2] == b'\xff\xd8'
    extra = (seg(0xE1, b'Exif\0\0' + tiff_ascii([(0x010F, b'MARK-EXIF-CAMERA-5150'), (0x8298, b'MARK-EXIF-OWNER-7342')]))
             + seg(0xE1, b'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description photoshop:Credit="MARK-JPEG-XMP-2611"/></x:xmpmeta>')
             + seg(0xED, b'Photoshop 3.0\0' + b'8BIM\x04\x04\0\0\0\0\0\x20' + b'MARK-IPTC-BYLINE-8820'.ljust(32, b' '))
             + seg(0xFE, b'MARK-JPEG-COMMENT-1934'))
    # After the picture's end: a second picture's worth of data, as some cameras add.
    return j[:2] + extra + j[2:] + b'MARK-JPEG-TRAILER-4006' * 4


def xmp(marker, pdfa=False):
    extra = b' xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B"' if pdfa else b''
    return (b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            b'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"' + extra + b'><dc:creator><rdf:Seq><rdf:li>' + marker +
            b'</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')


def metadata():
    objs = {}
    objs[1] = (b'<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R /Outlines 40 0 R /AcroForm << /Fields [50 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >>'
               b' /Names << /EmbeddedFiles << /Names [(KEEP-ATTACHMENT-NAME.txt) 60 0 R] >> >> /SpiderInfo << /V 1.0 /MARK-SPIDER-URL (MARK-SPIDER-3378) >>'
               b' /PieceInfo << /MarkApp << /LastModified (D:20200101000000Z) /Private (MARK-CATALOG-PIECE-6644) >> >> >>')
    objs[3] = HELV
    objs[4] = b'<< /Title (MARK-TITLE-4417) /Author (MARK-AUTHOR-OLD-1001) /Producer (MARK-PRODUCER-OLD-1002) >>'
    objs[5] = stream(xmp(b'MARK-DOC-XMP-OLD-1003', pdfa=True), b' /Type /Metadata /Subtype /XML')
    jpeg = jpeg_with_metadata()
    objs[6] = stream(xmp(b'MARK-IMAGE-XMP-5521'), b' /Type /Metadata /Subtype /XML')
    objs[7] = stream(jpeg, b' /Type /XObject /Subtype /Image /Width 64 /Height 48 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Metadata 6 0 R')
    thumb = bytes([200, 30, 30] * 16 * 16)
    objs[8] = stream(thumb, b' /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8')
    objs[9] = stream(b'0 g ' + text(b'KEEP-PAGE-TEXT-3141 visible text', 72, 720, 18) + b'q 256 0 0 192 72 450 cm /Im Do Q\n' + text(b'Fill in the field:', 72, 380, 14))
    objs[10] = (b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im 7 0 R >> >>'
                b' /Annots [30 0 R 31 0 R 51 0 R] /Thumb 8 0 R /LastModified (D:20210304050607Z) /Metadata 11 0 R'
                b' /PieceInfo << /MarkApp << /LastModified (D:20210304050607Z) /Private (MARK-PAGE-PIECE-2468) >> >> >>')
    objs[11] = stream(xmp(b'MARK-PAGE-XMP-7788'), b' /Type /Metadata /Subtype /XML')
    objs[2] = pages([10])
    # A comment with its author, and a link: they stay.
    objs[20] = form(b'1 0.9 0.3 rg 0 0 24 24 re f\n', b'[0 0 24 24]')
    objs[30] = b'<< /Type /Annot /Subtype /Text /Rect [400 700 424 724] /T (KEEP-COMMENT-AUTHOR-9090) /Contents (KEEP-COMMENT-TEXT) /M (D:20220202020202Z) /AP << /N 20 0 R >> /F 4 >>'
    objs[31] = b'<< /Type /Annot /Subtype /Link /Rect [72 700 300 740] /Border [0 0 0] /A << /S /URI /URI (https://example.com/KEEP-LINK) >> >>'
    objs[40] = b'<< /Type /Outlines /First 41 0 R /Last 41 0 R /Count 1 >>'
    objs[41] = b'<< /Title (KEEP-BOOKMARK-1212) /Parent 40 0 R /Dest [10 0 R /XYZ 0 792 0] >>'
    # A text field with a value and its appearance.
    objs[52] = form(b'/Tx BMC q BT /Helv 12 Tf 0 g 2 6 Td (KEEP-FIELD-VALUE-5656) Tj ET Q EMC\n', b'[0 0 220 24]', b'<< /Font << /Helv 3 0 R >> >>')
    objs[50] = b'<< /FT /Tx /T (name) /V (KEEP-FIELD-VALUE-5656) /Kids [51 0 R] >>'
    objs[51] = b'<< /Type /Annot /Subtype /Widget /Parent 50 0 R /Rect [200 370 420 394] /P 10 0 R /AP << /N 52 0 R >> /F 4 >>'
    objs[61] = stream(b'KEEP-ATTACHMENT-CONTENT', b' /Type /EmbeddedFile /Params << /Size 23 >>')
    objs[60] = b'<< /Type /Filespec /F (KEEP-ATTACHMENT-NAME.txt) /UF (KEEP-ATTACHMENT-NAME.txt) /EF << /F 61 0 R >> >>'
    first = pdf(objs, info=4, file_id=b'4D41524B2D4F4C442D49442D30303031')  # "MARK-OLD-ID-0001"
    # An incremental update: new document information and XMP; the old ones stay in the file's first part.
    upd = {4: b'<< /Title (MARK-TITLE-4417) /Author (MARK-AUTHOR-7731) /Subject (MARK-SUBJECT-2290) /Keywords (MARK-KEYWORDS-6012) /Creator (MARK-CREATOR-8156)'
              b' /Producer (MARK-PRODUCER-3349) /CreationDate (D:20200101120000Z) /ModDate (D:20230405060708Z) /Trapped /False /Department (MARK-CUSTOM-4521) >>',
           5: stream(xmp(b'MARK-DOC-XMP-9977', pdfa=True), b' /Type /Metadata /Subtype /XML')}
    out = bytearray(first)
    prev = int(first.rsplit(b'startxref\n', 1)[1].split(b'\n')[0])
    offs = {}
    for k in sorted(upd):
        offs[k] = len(out)
        out += b'%d 0 obj\n' % k + upd[k] + b'\nendobj\n'
    x = len(out)
    out += b'xref\n'
    for k in sorted(upd):
        out += b'%d 1\n%010d 00000 n \n' % (k, offs[k])
    size = max(objs) + 1
    out += b'trailer\n<< /Size %d /Root 1 0 R /Info 4 0 R /Prev %d /ID [<4D41524B2D4F4C442D49442D30303031> <4D41524B2D4F4C442D49442D30303032>] >>\nstartxref\n%d\n%%%%EOF\n' % (size, prev, x)
    write('metadata.pdf', bytes(out))


if __name__ == '__main__':
    for f in (rotations, boxes, sizes, transparency, annotations, fonts_std, fonts_sans, jpx_cmyk, big_picture, metadata):
        f()
    print('written to', os.path.normpath(ROOT), file=sys.stderr)
