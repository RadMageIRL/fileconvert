"""Writes the PDF merge fixtures (v0.2.0, Phase 2) into tests/fixtures/pdf/: hand-written PDFs, so no PDF library's
habits leak into them, that Merge PDFs is tested against.

    python tools/make-pdf-merge-fixtures.py            (needs qpdf on PATH for the object-stream copy)

merge-a.pdf (3 pages) and merge-b.pdf (2 pages) between them hold what a merge has to carry or report:

- Form fields with values and appearances: a text field that takes its default appearance from the form, a check
  box, a radio group with a button on two pages, a combo box; merge-b has a text field and a check box with the same
  names as merge-a's (so they must be renamed), a field with two named parts (address.street, address.city), and a
  form font resource with the same name as merge-a's (/Helv) but a different font (Courier), which its default
  appearances use, so the font must be renamed and the appearances rewritten.
- Bookmarks, nested, one closed, with destinations of every kind: explicit, a name in the old /Dests dictionary, a
  string in the name tree, a GoTo action, and a web address.
- Links: to another page, to a named destination, to a web address, to a page by its number (as some programs
  write it), to a name that does not exist, and a named destination ("shared") that both files define.
- Layers (optional content): one hidden in each file, by an /OFF list in merge-a and by /BaseState /OFF in merge-b.
- Page attributes inherited from the page tree: resources, media box, and a rotation; a crop box.
- Document parts a merge drops, each to be reported: accessibility tags, page labels, an attachment, document
  scripts (a name-tree script and an opening action), XFA form data, and another layer configuration.
- Document information and XMP metadata in merge-a, which the merged PDF keeps.

Everything is synthetic; the scripts are inert one-liners that FileConvert never runs.
"""

import os
import shutil
import subprocess
import sys
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures', 'pdf')


def write(name, data):
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, name), 'wb') as f:
        f.write(data)


def stream(data, extra=b''):
    return b'<< /Length %d%s >>\nstream\n' % (len(data), extra) + data + b'\nendstream'


def flate(data):
    return zlib.compress(data, 9)


def pdf(objs, root, info=None, version=b'1.7'):
    """objs: {number: body}. A classic cross-reference table."""
    out = bytearray(b'%PDF-' + version + b'\n%\xe2\xe3\xcf\xd3\n')
    offs = {}
    for k in sorted(objs):
        offs[k] = len(out)
        out += b'%d 0 obj\n' % k + objs[k] + b'\nendobj\n'
    size = max(objs) + 1
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % size
    for k in range(1, size):
        out += (b'%010d 00000 n \n' % offs[k]) if k in offs else b'0000000000 65535 f \n'
    extra = b' /Info %d 0 R' % info if info else b''
    out += b'trailer\n<< /Size %d /Root %d 0 R%s >>\nstartxref\n%d\n%%%%EOF\n' % (size, root, extra, xref)
    return bytes(out)


def text(s, y=700, font=b'/F1', size=18):
    return b'BT %s %d Tf 72 %d Td (%s) Tj ET\n' % (font, size, y, s.encode('latin-1'))


def form(content, bbox, resources):
    return stream(flate(content), b' /Type /XObject /Subtype /Form /BBox %s /Resources %s /Filter /FlateDecode' % (bbox, resources))


HELV = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
COUR = b'<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'
ZADB = b'<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>'
BOX = b'0 0 0 RG 1 w 0.5 0.5 19 19 re S\n'
CHECK = BOX + b'q BT 0 g /ZaDb 14 Tf 3 4 Td (4) Tj ET Q\n'
DOT = BOX + b'0 g 10 10 m 13 10 l 13 13 l 10 13 l f\n'


def merge_a():
    xmp = (b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF'
           b' xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""'
           b' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Merge A</rdf:li>'
           b'</rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
    p1 = (text('Alpha page one') + b'/OC /ocOn BDC ' + text('Alpha layer shown', 600) + b'EMC\n'
          + b'/OC /ocOff BDC ' + text('ALPHA HIDDEN LAYER', 560) + b'EMC\n' + text('Go to page three', 500, size=12)
          + text('Go to page two by name', 470, size=12) + text('Web page', 440, size=12))
    objs = {
        1: (b'<< /Type /Catalog /Pages 2 0 R /Outlines 40 0 R /Names << /Dests 50 0 R >> /Dests 51 0 R'
            b' /AcroForm << /Fields [30 0 R 32 0 R 34 0 R 38 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 3 0 R /ZaDb 5 0 R >> >> >>'
            b' /OCProperties << /OCGs [60 0 R 61 0 R] /D << /Name (Default) /OFF [61 0 R] /Order [60 0 R 61 0 R] >> >>'
            b' /Metadata 70 0 R /Lang (en-US) /PageLayout /OneColumn /OpenAction [10 0 R /Fit] >>'),
        # Resources and the media box are inherited from the root; page 3 inherits its rotation from node 4.
        2: b'<< /Type /Pages /Kids [10 0 R 12 0 R 4 0 R] /Count 3 /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /Helv 3 0 R >> >> >>',
        3: HELV,
        4: b'<< /Type /Pages /Parent 2 0 R /Kids [14 0 R] /Count 1 /Rotate 180 >>',
        5: ZADB,
        10: (b'<< /Type /Page /Parent 2 0 R /Contents 11 0 R /Annots [20 0 R 21 0 R 22 0 R]'
             b' /Resources << /Font << /F1 3 0 R >> /Properties << /ocOn 60 0 R /ocOff 61 0 R >> >> >>'),
        11: stream(flate(p1), b' /Filter /FlateDecode'),
        12: b'<< /Type /Page /Parent 2 0 R /Contents 13 0 R /Annots [31 0 R 32 0 R 35 0 R 38 0 R] >>',
        13: stream(flate(text('Alpha page two') + text('Name', 640, size=10) + text('Agree', 590, size=10) + text('Choice', 540, size=10)), b' /Filter /FlateDecode'),
        14: b'<< /Type /Page /Parent 4 0 R /Contents 15 0 R /Annots [36 0 R] /CropBox [36 36 576 756] >>',
        15: stream(flate(text('Alpha page three') + text('Choice B', 540, size=10)), b' /Filter /FlateDecode'),
        20: b'<< /Type /Annot /Subtype /Link /Rect [72 495 300 515] /Border [0 0 0] /Dest [14 0 R /XYZ 0 792 null] >>',
        21: b'<< /Type /Annot /Subtype /Link /Rect [72 465 300 485] /Border [0 0 0] /Dest (a-two) >>',
        22: b'<< /Type /Annot /Subtype /Link /Rect [72 435 300 455] /Border [0 0 0] /A << /S /URI /URI (https://example.com/alpha) >> >>',
        # name: no /DA of its own, so it takes the form's (/Helv 0 Tf 0 g).
        30: b'<< /FT /Tx /T (name) /V (Alice) /Kids [31 0 R] >>',
        31: (b'<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [150 630 400 654] /P 12 0 R /F 4 /AP << /N 39 0 R >> >>'),
        39: form(b'/Tx BMC q BT /Helv 12 Tf 0 g 2 7 Td (Alice) Tj ET Q EMC', b'[0 0 250 24]', b'<< /Font << /Helv 3 0 R >> >>'),
        32: (b'<< /FT /Btn /T (agree) /V /Yes /AS /Yes /Type /Annot /Subtype /Widget /Rect [150 582 170 602] /P 12 0 R /F 4'
             b' /MK << /CA (4) >> /AP << /N << /Yes 33 0 R /Off 37 0 R >> >> >>'),
        33: form(CHECK, b'[0 0 20 20]', b'<< /Font << /ZaDb 5 0 R >> >>'),
        37: form(BOX, b'[0 0 20 20]', b'<< >>'),
        34: b'<< /FT /Btn /Ff 49152 /T (choice) /V /B /Kids [35 0 R 36 0 R] >>',
        35: (b'<< /Type /Annot /Subtype /Widget /Parent 34 0 R /Rect [150 532 170 552] /P 12 0 R /F 4 /AS /Off'
             b' /AP << /N << /A 41 0 R /Off 37 0 R >> >> >>'),
        36: (b'<< /Type /Annot /Subtype /Widget /Parent 34 0 R /Rect [150 532 170 552] /P 14 0 R /F 4 /AS /B'
             b' /AP << /N << /B 41 0 R /Off 37 0 R >> >> >>'),
        41: form(DOT, b'[0 0 20 20]', b'<< >>'),
        38: (b'<< /FT /Ch /Ff 131072 /T (color) /Opt [(Red) (Green)] /V (Green) /DA (/Helv 12 Tf 0 g) /Type /Annot /Subtype /Widget'
             b' /Rect [300 630 450 654] /P 12 0 R /F 4 /AP << /N 42 0 R >> >>'),
        42: form(b'/Tx BMC q BT /Helv 12 Tf 0 g 2 7 Td (Green) Tj ET Q EMC', b'[0 0 150 24]', b'<< /Font << /Helv 3 0 R >> >>'),
        40: b'<< /Type /Outlines /First 43 0 R /Last 47 0 R /Count 4 >>',
        43: b'<< /Title (Chapter A1) /Parent 40 0 R /Next 45 0 R /First 44 0 R /Last 44 0 R /Count 1 /Dest [10 0 R /Fit] >>',
        44: b'<< /Title (Section A1.1) /Parent 43 0 R /Dest /a-sec >>',
        45: b'<< /Title (Chapter A2) /Parent 40 0 R /Prev 43 0 R /Next 46 0 R /A << /S /GoTo /D (a-two) >> >>',
        46: b'<< /Title (Closed A3) /Parent 40 0 R /Prev 45 0 R /Next 47 0 R /First 48 0 R /Last 48 0 R /Count -1 /Dest [14 0 R /Fit] >>',
        48: b'<< /Title (A3 child) /Parent 46 0 R /Dest [14 0 R /XYZ 0 300 null] >>',
        47: b'<< /Title (Web link) /Parent 40 0 R /Prev 46 0 R /A << /S /URI /URI (https://example.com/) >> >>',
        50: b'<< /Names [(a-two) [12 0 R /Fit] (shared) [14 0 R /Fit]] >>',
        51: b'<< /a-sec [10 0 R /XYZ 0 400 null] >>',
        60: b'<< /Type /OCG /Name (Alpha shown) >>',
        61: b'<< /Type /OCG /Name (Alpha hidden) >>',
        70: stream(xmp, b' /Type /Metadata /Subtype /XML'),
        71: b'<< /Title (Merge A) /Author (Test A) /Subject (FileConvert merge fixture) >>',
    }
    write('merge-a.pdf', pdf(objs, 1, info=71))


def merge_b():
    p1 = (text('Bravo page one') + b'/OC /ocShow BDC ' + text('Bravo layer shown', 600) + b'EMC\n'
          + b'/OC /ocHide BDC ' + text('BRAVO HIDDEN LAYER', 560) + b'EMC\n'
          + b'/P << /MCID 0 >> BDC ' + text('Tagged bravo text', 520) + b'EMC\n'
          + text('Next page by number', 470, size=12) + text('Nowhere', 440, size=12) + text('Shared name', 410, size=12))
    objs = {
        1: (b'<< /Type /Catalog /Pages 2 0 R /Outlines 40 0 R /Names << /Dests 50 0 R /EmbeddedFiles 51 0 R /JavaScript 52 0 R >>'
            b' /PageLabels << /Nums [0 << /S /r >>] >> /StructTreeRoot 60 0 R /MarkInfo << /Marked true >>'
            b' /AcroForm << /Fields [30 0 R 32 0 R 34 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> /XFA 55 0 R >>'
            b' /OCProperties << /OCGs [64 0 R 65 0 R] /D << /BaseState /OFF /ON [64 0 R] >> /Configs [<< /Name (All) /ON [64 0 R 65 0 R] >>] >>'
            b' /OpenAction << /S /JavaScript /JS (var opened = 1;) >> >>'),
        2: b'<< /Type /Pages /Kids [10 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] >>',
        # Courier under the same resource name merge-a uses for Helvetica.
        3: COUR,
        4: b'<< /Type /Pages /Parent 2 0 R /Kids [12 0 R] /Count 1 /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> >>',
        5: HELV,
        10: (b'<< /Type /Page /Parent 2 0 R /Contents 11 0 R /StructParents 0 /Annots [20 0 R 21 0 R 22 0 R 30 0 R 31 0 R 33 0 R 34 0 R 35 0 R 23 0 R 24 0 R 25 0 R]'
             b' /Resources << /Font << /F1 5 0 R >> /Properties << /ocShow 64 0 R /ocHide 65 0 R >> >> >>'),
        11: stream(flate(p1), b' /Filter /FlateDecode'),
        12: b'<< /Type /Page /Parent 4 0 R /Contents 13 0 R /CropBox [0 0 600 780] >>',
        13: stream(flate(text('Bravo page two')), b' /Filter /FlateDecode'),
        20: b'<< /Type /Annot /Subtype /Link /Rect [72 465 300 485] /Border [0 0 0] /StructParent 1 /A << /S /GoTo /D [1 /Fit] >> >>',
        21: b'<< /Type /Annot /Subtype /Link /Rect [72 435 300 455] /Border [0 0 0] /Dest (nowhere) >>',
        22: b'<< /Type /Annot /Subtype /Link /Rect [72 405 300 425] /Border [0 0 0] /A << /S /GoTo /D (shared) >> >>',
        23: (b'<< /Type /Annot /Subtype /FreeText /Rect [350 700 550 730] /Contents (Bravo note) /DA (/Helv 12 Tf 0 g)'
              b' /AP << /N 26 0 R >> >>'),
        26: form(b'q BT /Helv 12 Tf 0 g 2 10 Td (Bravo note) Tj ET Q', b'[0 0 200 30]', b'<< /Font << /Helv 3 0 R >> >>'),
        24: b'<< /Type /Annot /Subtype /Text /Rect [560 700 580 720] /Contents (Bravo sticky note) /Popup 25 0 R /Open false >>',
        25: b'<< /Type /Annot /Subtype /Popup /Rect [560 600 760 700] /Parent 24 0 R /Open false >>',
        # name: the same name as merge-a's text field; its own default appearance uses /Helv, Courier here.
        30: (b'<< /FT /Tx /T (name) /V (Bob) /DA (/Helv 10 Tf 0 0 1 rg) /Type /Annot /Subtype /Widget /Rect [150 300 400 324] /P 10 0 R /F 4'
             b' /AP << /N 36 0 R >> >>'),
        36: form(b'/Tx BMC q BT /Helv 10 Tf 0 0 1 rg 2 7 Td (Bob) Tj ET Q EMC', b'[0 0 250 24]', b'<< /Font << /Helv 3 0 R >> >>'),
        32: b'<< /T (address) /FT /Tx /Kids [31 0 R 33 0 R] >>',
        31: (b'<< /T (street) /V (1 Main St) /Parent 32 0 R /Type /Annot /Subtype /Widget /Rect [150 260 400 284] /P 10 0 R /F 4'
             b' /AP << /N 37 0 R >> >>'),
        37: form(b'/Tx BMC q BT /Helv 12 Tf 0 g 2 7 Td (1 Main St) Tj ET Q EMC', b'[0 0 250 24]', b'<< /Font << /Helv 3 0 R >> >>'),
        33: (b'<< /T (city) /V (Springfield) /Parent 32 0 R /Type /Annot /Subtype /Widget /Rect [150 230 400 254] /P 10 0 R /F 4'
             b' /AP << /N 38 0 R >> >>'),
        38: form(b'/Tx BMC q BT /Helv 12 Tf 0 g 2 7 Td (Springfield) Tj ET Q EMC', b'[0 0 250 24]', b'<< /Font << /Helv 3 0 R >> >>'),
        # agree: the same name as merge-a's check box; off here.
        34: (b'<< /FT /Btn /T (agree) /V /Off /AS /Off /Type /Annot /Subtype /Widget /Rect [150 190 170 210] /P 10 0 R /F 4'
             b' /AP << /N << /Yes 39 0 R /Off 41 0 R >> >> >>'),
        35: b'<< /Type /Annot /Subtype /Link /Rect [72 150 300 170] /Border [0 0 0] /A << /S /URI /URI (https://example.com/bravo) >> >>',
        39: form(BOX + b'0 g 4 4 12 12 re f\n', b'[0 0 20 20]', b'<< >>'),
        41: form(BOX, b'[0 0 20 20]', b'<< >>'),
        40: b'<< /Type /Outlines /First 43 0 R /Last 44 0 R /Count 2 >>',
        43: b'<< /Title (Chapter B1) /Parent 40 0 R /Next 44 0 R /Dest [10 0 R /Fit] >>',
        44: b'<< /Title (Chapter B2) /Parent 40 0 R /Prev 43 0 R /Dest (shared) >>',
        50: b'<< /Names [(shared) [12 0 R /XYZ 0 792 null]] >>',
        51: b'<< /Names [(note.txt) 53 0 R] >>',
        52: b'<< /Names [(init) << /S /JavaScript /JS (var ready = 1;) >>] >>',
        53: b'<< /Type /Filespec /F (note.txt) /UF (note.txt) /EF << /F 54 0 R >> >>',
        54: stream(b'An attached note.', b' /Type /EmbeddedFile'),
        55: stream(b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>'),
        60: b'<< /Type /StructTreeRoot /K [61 0 R] /ParentTree << /Nums [0 [61 0 R]] >> /ParentTreeNextKey 1 >>',
        61: b'<< /Type /StructElem /S /P /P 60 0 R /Pg 10 0 R /K 0 >>',
        64: b'<< /Type /OCG /Name (Bravo shown) >>',
        65: b'<< /Type /OCG /Name (Bravo hidden) >>',
        71: b'<< /Title (Merge B) /Author (Test B) >>',
    }
    write('merge-b.pdf', pdf(objs, 1, info=71, version=b'1.6'))


def qpdf_copies():
    q = shutil.which('qpdf')
    if not q:
        sys.exit('qpdf was not found on PATH; it writes the object-stream copy.')
    subprocess.run([q, '--object-streams=generate', os.path.join(ROOT, 'merge-b.pdf'), os.path.join(ROOT, 'merge-b-objstm.pdf')], check=True)


if __name__ == '__main__':
    merge_a()
    merge_b()
    qpdf_copies()
    print('PDF merge fixtures written to', os.path.normpath(ROOT))
