"""Writes the PDF safety fixtures (v0.2.0, Phase 2) into tests/fixtures/pdf/: hand-written PDFs, so no PDF
library's habits leak into them, that the PDF guard and the page cleanup are tested against.

    python tools/make-pdf-safety-fixtures.py            (needs qpdf on PATH for the encrypted and object-stream copies)
    python tools/make-pdf-safety-fixtures.py --sign     (also the signed copy; needs pyHanko and cryptography)

markers.pdf has four pages; page 2 carries a distinctive mark in every place a page's content can hide (its text,
a picture only it draws but listed in resources all pages share, an annotation, a form field and its appearance,
an outline entry, a named destination, a structure element's ActualText, an article thread bead, page piece data,
a thumbnail, and an older revision of its content left by an incremental update), so tests can prove that
removing the page leaves none of them in the file. The hostile files each try one way to make a reader use far
more memory or time than the file's size suggests. Everything is synthetic.
"""

import base64
import os
import random
import shutil
import subprocess
import sys
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures', 'pdf')
GiB = 1 << 30


def write(name, data):
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, name), 'wb') as f:
        f.write(data)


def stream(data, extra=b''):
    return b'<< /Length %d%s >>\nstream\n' % (len(data), extra) + data + b'\nendstream'


def flate(data, level=9):
    return zlib.compress(data, level)


def zeros_flate(n, chunk=16 << 20):
    """zlib data for n zero bytes, made in pieces so the zeros never sit in memory at once."""
    c = zlib.compressobj(9)
    out = []
    block = bytes(chunk)
    left = n
    while left:
        take = min(left, chunk)
        out.append(c.compress(block[:take]))
        left -= take
    out.append(c.flush())
    return b''.join(out)


def pdf(objs, root, version=b'1.7', trailer_extra=b''):
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
    out += b'trailer\n<< /Size %d /Root %d 0 R%s >>\nstartxref\n%d\n%%%%EOF\n' % (size, root, trailer_extra, xref)
    return bytes(out), offs, xref, size


def pdf_xref_stream(objs, packed, root):
    """objs: {number: body} written plainly; packed: {number: (object stream number, index)} for objects inside
    object streams. A cross-reference stream, the only kind that can point into object streams."""
    out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offs = {}
    for k in sorted(objs):
        offs[k] = len(out)
        out += b'%d 0 obj\n' % k + objs[k] + b'\nendobj\n'
    xs = max(list(objs) + list(packed)) + 1
    size = xs + 1
    rows = bytearray()
    for k in range(size):
        if k in offs:
            rows += bytes([1]) + offs[k].to_bytes(4, 'big') + bytes(2)
        elif k in packed:
            rows += bytes([2]) + packed[k][0].to_bytes(4, 'big') + packed[k][1].to_bytes(2, 'big')
        elif k == xs:
            rows += bytes([1]) + len(out).to_bytes(4, 'big') + bytes(2)
        else:
            rows += bytes(7)
    data = flate(bytes(rows))
    at = len(out)
    out += b'%d 0 obj\n<< /Type /XRef /Size %d /Root %d 0 R /W [1 4 2] /Filter /FlateDecode /Length %d >>\nstream\n' % (xs, size, root, len(data))
    out += data + b'\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n' % at
    return bytes(out)


HELV = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'


def one_page(content, resources=b'<< /Font << /F1 3 0 R >> >>', extra_objs=None, page_extra=b'', catalog_extra=b'', media=b'[0 0 612 792]'):
    objs = {
        1: b'<< /Type /Catalog /Pages 2 0 R%s >>' % catalog_extra,
        2: b'<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
        3: HELV,
        4: b'<< /Type /Page /Parent 2 0 R /MediaBox %s /Resources %s /Contents 5 0 R%s >>' % (media, resources, page_extra),
        5: content,
    }
    objs.update(extra_objs or {})
    return pdf(objs, 1)[0]


def text(s, y=700):
    return b'BT /F1 18 Tf 72 %d Td (%s) Tj ET\n' % (y, s.encode('latin-1'))


def noise(seed, w, h):
    r = random.Random(seed)
    return bytes(r.getrandbits(8) for _ in range(w * h * 3))


# ------------------------------------------------------------------ markers.pdf

def markers():
    secret_img = noise(4815, 64, 64)
    keep_img = noise(1623, 16, 16)
    thumb = noise(42, 8, 8)
    p2_content = (text('PAGE-TWO-SECRET-4815') + b'q 192 0 0 192 72 400 cm /ImSecret Do Q\n'
                  + b'/P << /MCID 0 >> BDC ' + text('Tagged text', 300) + b'EMC\n')
    old_p2 = text('OLD-REVISION-SECRET-1')
    objs = {
        1: (b'<< /Type /Catalog /Pages 2 0 R /Outlines 40 0 R /Names << /Dests 50 0 R >> /PageLabels << /Nums [0 << /S /r >>] >>'
            b' /AcroForm << /Fields [30 0 R 32 0 R] /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 3 0 R >> >> >>'
            b' /StructTreeRoot 60 0 R /MarkInfo << /Marked true >> /Threads [70 0 R] >>'),
        # The resources are inherited from the page tree and shared by every page, the secret picture included.
        2: b'<< /Type /Pages /Kids [10 0 R 12 0 R 14 0 R 16 0 R] /Count 4 /MediaBox [0 0 612 792] /Resources 4 0 R >>',
        3: HELV,
        4: b'<< /Font << /F1 3 0 R >> /XObject << /ImSecret 20 0 R /ImKeep 21 0 R >> >>',
        10: b'<< /Type /Page /Parent 2 0 R /Contents 11 0 R /Annots [24 0 R 32 0 R] >>',
        11: stream(flate(text('Page one keep') + b'q 64 0 0 64 72 400 cm /ImKeep Do Q\n'), b' /Filter /FlateDecode'),
        12: (b'<< /Type /Page /Parent 2 0 R /Contents 13 0 R /Annots [23 0 R 30 0 R] /Thumb 22 0 R /StructParents 0 /B [71 0 R]'
             b' /PieceInfo << /FileConvertTest << /LastModified (D:20261122) /Private (PIECE-SECRET-5) >> >> >>'),
        13: stream(flate(old_p2), b' /Filter /FlateDecode'),
        14: b'<< /Type /Page /Parent 2 0 R /Contents 15 0 R /Annots [25 0 R] >>',
        15: stream(flate(text('Page three keep')), b' /Filter /FlateDecode'),
        16: b'<< /Type /Page /Parent 2 0 R /Contents 17 0 R >>',
        17: stream(flate(text('Page four keep')), b' /Filter /FlateDecode'),
        20: stream(flate(secret_img), b' /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'),
        21: stream(flate(keep_img), b' /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'),
        22: stream(flate(thumb), b' /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'),
        23: b'<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (ANNOT-SECRET-2) /P 12 0 R >>',
        # Page 1 links to page 2 (the link must go when page 2 does); page 3 links to page 1 (it must stay).
        24: b'<< /Type /Annot /Subtype /Link /Rect [72 690 300 720] /Border [0 0 0] /Dest [12 0 R /Fit] >>',
        25: b'<< /Type /Annot /Subtype /Link /Rect [72 690 300 720] /Border [0 0 0] /A << /S /GoTo /D [10 0 R /Fit] >> >>',
        30: (b'<< /FT /Tx /T (secretfield) /V (FIELD-SECRET-77) /DA (/F1 12 Tf 0 g) /Type /Annot /Subtype /Widget'
             b' /Rect [72 100 300 124] /P 12 0 R /F 4 /AP << /N 31 0 R >> >>'),
        31: stream(flate(b'/Tx BMC BT /F1 12 Tf 2 6 Td (FIELD-SECRET-77) Tj ET EMC'), b' /Type /XObject /Subtype /Form /BBox [0 0 228 24] /Resources << /Font << /F1 3 0 R >> >> /Filter /FlateDecode'),
        32: (b'<< /FT /Tx /T (keepfield) /V (field kept) /DA (/F1 12 Tf 0 g) /Type /Annot /Subtype /Widget'
             b' /Rect [72 100 300 124] /P 10 0 R /F 4 /AP << /N 33 0 R >> >>'),
        33: stream(flate(b'/Tx BMC BT /F1 12 Tf 2 6 Td (field kept) Tj ET EMC'), b' /Type /XObject /Subtype /Form /BBox [0 0 228 24] /Resources << /Font << /F1 3 0 R >> >> /Filter /FlateDecode'),
        40: b'<< /Type /Outlines /First 41 0 R /Last 42 0 R /Count 2 >>',
        41: b'<< /Title (Page one) /Parent 40 0 R /Next 42 0 R /Dest [10 0 R /Fit] >>',
        42: b'<< /Title (OUTLINE-SECRET-2) /Parent 40 0 R /Prev 41 0 R /Dest [12 0 R /Fit] >>',
        50: b'<< /Names [(keep-one) [10 0 R /Fit] (secret-two) [12 0 R /Fit]] >>',
        60: b'<< /Type /StructTreeRoot /K [61 0 R] /ParentTree << /Nums [0 [61 0 R]] >> /ParentTreeNextKey 1 >>',
        61: b'<< /Type /StructElem /S /P /P 60 0 R /Pg 12 0 R /K 0 /ActualText (TAG-SECRET-9) >>',
        70: b'<< /Type /Thread /F 71 0 R /I << /Title (THREAD-SECRET-3) >> >>',
        71: b'<< /Type /Bead /T 70 0 R /N 71 0 R /V 71 0 R /P 12 0 R /R [72 300 540 700] >>',
    }
    first, offs, xref, size = pdf(objs, 1)
    # An incremental update replaces page 2's content; the old revision stays earlier in the file.
    out = bytearray(first)
    new13 = len(out)
    out += b'13 0 obj\n' + stream(flate(p2_content), b' /Filter /FlateDecode') + b'\nendobj\n'
    xref2 = len(out)
    out += b'xref\n0 1\n0000000000 65535 f \n13 1\n%010d 00000 n \n' % new13
    out += b'trailer\n<< /Size %d /Root 1 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n' % (size, xref, xref2)
    write('markers.pdf', bytes(out))
    return secret_img, keep_img, thumb


# ------------------------------------------------------------------ hostile files

def lzw_zeros(n):
    """LZW codes (EarlyChange 1) for n zero bytes, worked out from the run's structure rather than byte by byte."""
    codes = [256]
    length_code = {1: 0}
    next_code, m, left = 258, 1, n
    while left:
        take = min(m, left)
        codes.append(length_code[take])
        left -= take
        if take == m and next_code < 4096:
            length_code[m + 1] = next_code
            next_code += 1
            m += 1
        if next_code >= 4096 and left >= m:
            # The table is full: the longest string repeats until the end.
            reps = left // m
            codes.extend([length_code[m]] * reps)
            left -= reps * m
    codes.append(257)
    # Pack with the decoder's code widths: they grow when nextCode + 1 reaches 512, 1024 and 2048.
    bits, nbits, out = 0, 0, bytearray()
    dec_next, prev = 258, None
    for c in codes:
        width = 12 if dec_next + 1 >= 2048 else 11 if dec_next + 1 >= 1024 else 10 if dec_next + 1 >= 512 else 9
        bits = (bits << width) | c
        nbits += width
        while nbits >= 8:
            nbits -= 8
            out.append((bits >> nbits) & 255)
        bits &= (1 << nbits) - 1
        if c == 256:
            dec_next, prev = 258, None
            continue
        if prev is not None and dec_next < 4096:
            dec_next += 1
        prev = c
    if nbits:
        out.append((bits << (8 - nbits)) & 255)
    return bytes(out)


def hostile():
    bomb = zeros_flate(GiB)
    bomb2 = flate(bomb)  # 1 GiB behind two layers of Flate: a few kilobytes
    two = b' /Filter [/FlateDecode /FlateDecode]'
    write('bomb-content.pdf', one_page(stream(bomb2, two)))
    write('bomb-content-single.pdf', one_page(stream(zeros_flate(300 << 20), b' /Filter /FlateDecode')))
    # An object stream that expands to 1 GiB: its first object is real, the rest is padding.
    objstm_body = b'6 0 ' + b'<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] >>'
    c = zlib.compressobj(9)
    parts = [c.compress(objstm_body)]
    block = b' ' * (16 << 20)
    for _ in range(64):
        parts.append(c.compress(block))
    parts.append(c.flush())
    objstm = flate(b''.join(parts))
    write('bomb-objstm.pdf', one_page(stream(text('object stream bomb')), extra_objs={7: stream(objstm, b' /Type /ObjStm /N 1 /First 4' + two)}))
    img = stream(bomb2, b' /Type /XObject /Subtype /Image /Width 1000 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8' + two)
    write('bomb-image.pdf', one_page(stream(b'q 200 0 0 200 72 400 cm /Im0 Do Q\n'), resources=b'<< /XObject << /Im0 6 0 R >> >>', extra_objs={6: img}))
    font = (b'<< /Type /Font /Subtype /TrueType /BaseFont /Bomb /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor 7 0 R >>')
    desc = b'<< /Type /FontDescriptor /FontName /Bomb /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>'
    write('bomb-font.pdf', one_page(stream(b'BT /F2 18 Tf 72 700 Td (x) Tj ET\n'), resources=b'<< /Font << /F2 6 0 R >> >>',
                                    extra_objs={6: font, 7: desc, 8: stream(bomb2, b' /Length1 1073741824' + two)}))
    write('bomb-lzw.pdf', one_page(stream(flate(lzw_zeros(GiB)), b' /Filter [/FlateDecode /LZWDecode]')))
    write('bomb-runlength.pdf', one_page(stream(flate(b'\x81\x00' * (GiB // 128)), b' /Filter [/FlateDecode /RunLengthDecode]')))
    write('bomb-ascii85.pdf', one_page(stream(base64.a85encode(bomb2) + b'~>', b' /Filter [/ASCII85Decode /FlateDecode /FlateDecode]')))
    # A PNG predictor between two layers of Flate: the second layer reads what the predictor produces.
    rows = b''.join(b'\x00' + bomb[i:i + 100].ljust(100, b'\x00') for i in range(0, len(bomb), 100))
    write('bomb-predictor.pdf', one_page(stream(flate(rows), two + b' /DecodeParms [<< /Predictor 12 /Columns 100 >> null]')))
    # Sizes a reader allocates from directly.
    write('image-dimensions.pdf', one_page(stream(b'q 200 0 0 200 72 400 cm /Im0 Do Q\n'), resources=b'<< /XObject << /Im0 6 0 R >> >>',
                                           extra_objs={6: stream(b'\xff\xd8\xff\xd9', b' /Type /XObject /Subtype /Image /Width 50000 /Height 50000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode')}))
    sof = b'\xff\xd8\xff\xc0\x00\x11\x08' + (60000).to_bytes(2, 'big') + (60000).to_bytes(2, 'big') + b'\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01\xff\xd9'
    write('jpeg-header-size.pdf', one_page(stream(b'q 200 0 0 200 72 400 cm /Im0 Do Q\n'), resources=b'<< /XObject << /Im0 6 0 R >> >>',
                                           extra_objs={6: stream(sof, b' /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode')}))
    siz = b'\xff\x4f\xff\x51\x00\x29\x00\x00' + (60000).to_bytes(4, 'big') * 2 + bytes(8) + (60000).to_bytes(4, 'big') * 2 + bytes(8) + b'\x00\x01\x07\x01\x01\xff\xd9'
    write('jpx-header-size.pdf', one_page(stream(b'q 200 0 0 200 72 400 cm /Im0 Do Q\n'), resources=b'<< /XObject << /Im0 6 0 R >> >>',
                                          extra_objs={6: stream(siz, b' /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode')}))
    fn = stream(b'\x00' * 16, b' /FunctionType 0 /Domain [0 1 0 1] /Range [0 1] /Size [100000 100000] /BitsPerSample 8')
    write('sampled-function.pdf', one_page(stream(b'/Sh0 sh\n'), resources=b'<< /Shading << /Sh0 << /ShadingType 1 /ColorSpace /DeviceGray /Function 6 0 R >> >> >>', extra_objs={6: fn}))
    write('predictor-columns.pdf', one_page(stream(flate(b'\x00' * 64), b' /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 100000000 /Colors 4 >>')))
    write('brotli.pdf', one_page(stream(b'\x0b\x02\x80hello\x03', b' /Filter /BrotliDecode')))
    write('codec-chain.pdf', one_page(stream(flate(b'x' * 64), b' /Filter [/DCTDecode /FlateDecode]')))
    # Counts and structure.
    write('count-lie.pdf', pdf({1: b'<< /Type /Catalog /Pages 2 0 R >>', 2: b'<< /Type /Pages /Kids [4 0 R] /Count 2000000000 >>', 3: HELV,
                                4: b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
                                5: stream(text('A page tree that claims two billion pages'))}, 1)[0])
    write('huge-mediabox.pdf', one_page(stream(text('A page fourteen million points wide')), media=b'[0 0 14400000 14400000]'))
    write('deep-nesting.pdf', one_page(stream(text('deep')), page_extra=b' /Deep ' + b'[' * 100000 + b']' * 100000))
    write('page-loop.pdf', pdf({1: b'<< /Type /Catalog /Pages 2 0 R >>', 2: b'<< /Type /Pages /Kids [2 0 R 4 0 R] /Count 2 >>', 3: HELV,
                                4: b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>', 5: stream(text('loop'))}, 1)[0])
    # 6,000 pages, more than the 5,000 allowed: every page object inside object streams, so only decoding finds them.
    n = 6000
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 3: HELV, 5: stream(text('one of many'))}
    kids = []
    packed = {}
    per = 500
    first_page = 10
    stm = 10000
    for s in range(0, n, per):
        nums = list(range(first_page + s, first_page + min(n, s + per)))
        kids += nums
        for i, num in enumerate(nums):
            packed[num] = (stm, i)
        body = [b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>' for _ in nums]
        offsets, at = [], 0
        for b in body:
            offsets.append(at)
            at += len(b) + 1
        headr = b' '.join(b'%d %d' % (num, off) for num, off in zip(nums, offsets)) + b'\n'
        objs[stm] = stream(flate(headr + b'\n'.join(body)), b' /Type /ObjStm /N %d /First %d /Filter /FlateDecode' % (len(nums), len(headr)))
        stm += 1
    objs[2] = b'<< /Type /Pages /Kids [%s] /Count %d >>' % (b' '.join(b'%d 0 R' % k for k in kids), n)
    write('pages-6000.pdf', pdf_xref_stream(objs, packed, 1))
    # 50 MB of drawing operators: under every limit, but slow to draw; for cancel and time tests.
    write('operator-flood.pdf', one_page(stream(flate(b'0 0 m 1 1 l S\n' * ((50 << 20) // 14) + text('end')), b' /Filter /FlateDecode')))


def qpdf_copies():
    q = shutil.which('qpdf')
    if not q:
        sys.exit('qpdf was not found on PATH; it writes the encrypted and object-stream copies.')
    m = os.path.join(ROOT, 'markers.pdf')
    subprocess.run([q, '--object-streams=generate', m, os.path.join(ROOT, 'markers-objstm.pdf')], check=True)
    subprocess.run([q, '--encrypt', '--user-password=', '--owner-password=owner', '--bits=256', '--', m, os.path.join(ROOT, 'encrypted-owner.pdf')], check=True)
    subprocess.run([q, '--encrypt', '--user-password=user', '--owner-password=owner', '--bits=256', '--', m, os.path.join(ROOT, 'encrypted-user.pdf')], check=True)


def signed():
    """markers.pdf with an approval signature, by pyHanko with a throwaway self-signed certificate."""
    import datetime
    import tempfile
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'FileConvert test signer')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650)).sign(key, hashes.SHA256()))
    with tempfile.TemporaryDirectory() as tmp:
        kp, cp = os.path.join(tmp, 'key.pem'), os.path.join(tmp, 'cert.pem')
        open(kp, 'wb').write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        open(cp, 'wb').write(cert.public_bytes(serialization.Encoding.PEM))
        signer = signers.SimpleSigner.load(kp, cp, ca_chain_files=(), key_passphrase=None)
        with open(os.path.join(ROOT, 'markers-objstm.pdf'), 'rb') as inf:
            w = IncrementalPdfFileWriter(inf)
            fields.append_signature_field(w, fields.SigFieldSpec(sig_field_name='Signature1', on_page=0, box=(320, 72, 540, 132)))
            with open(os.path.join(ROOT, 'signed.pdf'), 'wb') as outf:
                signers.PdfSigner(signers.PdfSignatureMetadata(field_name='Signature1', reason='Test signature'), signer=signer).sign_pdf(w, output=outf)


if __name__ == '__main__':
    random.seed(1)
    secret, keep, thumb = markers()
    # The raw pixels of the pictures, for tests that search a result for them.
    write('markers-secret-pixels.bin', secret)
    hostile()
    qpdf_copies()
    if '--sign' in sys.argv:
        signed()
    print('PDF safety fixtures written to', os.path.normpath(ROOT))
