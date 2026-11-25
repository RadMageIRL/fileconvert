"""Writes the pictures in tests/fixtures/image-pdf/ that the Images to PDF tests turn into PDFs.

    python tools/make-image-pdf-fixtures.py

Needs Python with numpy and Pillow 11.3 or later. Every picture is synthetic: gradients and a lopsided test pattern
whose top left corner is marked, so a picture shown the wrong way round is seen at once. PNGs are written by the
small encoder below, not by Pillow, so every color type, bit depth, filter type, interlacing and chunk is under
control (Pillow writes neither 16-bit color nor interlaced PNGs); each row uses the five PNG filters in turn. The
tests decode these files with their own Python decoder (tests/e2e/readers.py), never with FileConvert's. Run it
only when a fixture has to change; the files are committed.
"""

import io
import os
import struct
import zlib

import numpy as np
from PIL import Image, ImageCms

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures', 'image-pdf')
os.makedirs(OUT, exist_ok=True)


def write(name, data):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data)


# ---------------------------------------------------------------- patterns

def pattern(w, h, maxv=255):
    """RGB samples: a gradient across, another down, a third diagonal, with a marked top left corner and a bar."""
    y, x = np.mgrid[0:h, 0:w]
    r = (x * maxv) // max(1, w - 1)
    g = (y * maxv) // max(1, h - 1)
    b = ((x + y) * maxv) // max(1, w + h - 2)
    img = np.stack([r, g, maxv - b], axis=-1).astype(np.int64)
    img[: h // 4, : w // 4] = [maxv, 0, 0]           # the corner marker: top left
    img[h // 2: h // 2 + 2, :] = [0, 0, 0]           # a bar across the middle
    img[:, w - 3: w - 1] = [maxv, maxv, maxv]          # a stripe near the right edge
    return img


def alpha_ramp(w, h, maxv=255):
    """Transparency that runs from clear (left) to opaque (right), with a fully clear square and a fully opaque one."""
    y, x = np.mgrid[0:h, 0:w]
    a = (x * maxv) // max(1, w - 1)
    a[h // 4: h // 2, w // 8: w // 4] = 0
    a[h // 2:, w - w // 4:] = maxv
    return a.astype(np.int64)


# ---------------------------------------------------------------- a small PNG encoder

ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def chunk(kind, data):
    body = kind + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)


def pack_rows(samples, depth):
    """Samples (h, w, n) to rows of bytes at the bit depth, big-endian for 16 bits."""
    h, w, n = samples.shape
    rows = []
    for y in range(h):
        s = samples[y].reshape(-1)
        if depth == 16:
            rows.append(s.astype('>u2').tobytes())
        elif depth == 8:
            rows.append(s.astype(np.uint8).tobytes())
        else:
            bits = np.zeros(len(s) * depth, dtype=np.uint8)
            for k in range(depth):
                bits[k::depth] = (s >> (depth - 1 - k)) & 1
            rows.append(np.packbits(bits).tobytes())
    return rows


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def filter_rows(rows, bpp, first_filter=0):
    out = bytearray()
    prev = bytes(len(rows[0])) if rows else b''
    for i, row in enumerate(rows):
        f = (first_filter + i) % 5
        out.append(f)
        for j, v in enumerate(row):
            a = row[j - bpp] if j >= bpp else 0
            b = prev[j]
            c = prev[j - bpp] if j >= bpp else 0
            pred = (0, a, b, (a + b) >> 1, paeth(a, b, c))[f]
            out.append((v - pred) & 0xFF)
        prev = row
    return bytes(out)


def png(name, samples, ct, depth, interlace=False, palette=None, trns=None, extra=(), idat_size=700, after_idat=b''):
    """Writes a PNG of samples (h, w, n): n is 1 (gray or index), 2, 3 or 4 as the color type has."""
    h, w, n = samples.shape
    bpp = max(1, (n * depth + 7) // 8)
    if interlace:
        raw = b''
        for x0, y0, dx, dy in ADAM7:
            sub = samples[y0::dy, x0::dx]
            if sub.shape[0] and sub.shape[1]:
                raw += filter_rows(pack_rows(sub, depth), bpp, x0 + y0)
    else:
        raw = filter_rows(pack_rows(samples, depth), bpp)
    z = zlib.compress(raw, 9) + after_idat
    out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, depth, ct, 0, 0, 1 if interlace else 0))
    for kind, data in extra:
        out += chunk(kind, data)
    if palette is not None:
        out += chunk(b'PLTE', bytes(np.asarray(palette, dtype=np.uint8).reshape(-1)))
    if trns is not None:
        out += chunk(b'tRNS', trns)
    for i in range(0, len(z), idat_size):
        out += chunk(b'IDAT', z[i:i + idat_size])
    out += chunk(b'IEND', b'')
    write(name, out)
    return out


def exif_orientation(o, xres=None):
    """A little-endian EXIF block (TIFF header and one IFD) with the orientation, and a resolution when given."""
    entries = [(0x0112, 3, 1, struct.pack('<HH', o, 0))]
    data = b''
    if xres:
        base = 8 + 2 + 12 * 3 + 4
        entries += [(0x011A, 5, 1, struct.pack('<I', base)), (0x0128, 3, 1, struct.pack('<HH', 2, 0))]
        data = struct.pack('<II', xres, 1)
    ifd = struct.pack('<H', len(entries)) + b''.join(struct.pack('<HHI', t, ty, c) + v for t, ty, c, v in entries) + struct.pack('<I', 0)
    return b'II*\x00' + struct.pack('<I', 8) + ifd + data


# ---------------------------------------------------------------- PNG fixtures

W, H = 48, 32
rgb8 = pattern(W, H)
rgb16 = pattern(W, H, 65535)
gray8 = rgb8[..., :1]
gray16 = (rgb16[..., :1] * 7 + 3) % 65536
a8 = alpha_ramp(W, H)[..., None]
a16 = alpha_ramp(W, H, 65535)[..., None]

for d in (1, 2, 4, 8, 16):
    m = (1 << d) - 1
    png(f'gray{d}.png', (gray16 if d == 16 else (gray8 * m) // 255), 0, d)
png('rgb8.png', rgb8, 2, 8, extra=[(b'pHYs', struct.pack('>IIB', 11811, 11811, 1))])  # 300 per inch
png('rgb16.png', rgb16, 2, 16)
pal = [[(i * 37) % 256, (i * 91) % 256, (255 - i * 13) % 256] for i in range(256)]
for d in (1, 4, 8):
    entries = 1 << d
    idx = ((np.arange(W)[None, :] + np.arange(H)[:, None] * 3) % entries)[..., None]
    png(f'pal{d}.png', idx, 3, d, palette=pal[:entries])
idx8 = ((np.arange(W)[None, :] + np.arange(H)[:, None] * 3) % 200)[..., None]
png('pal8-trns.png', idx8, 3, 8, palette=pal[:200], trns=bytes((i * 5) % 256 for i in range(150)))
png('graya8.png', np.concatenate([gray8, a8], -1), 4, 8)
png('graya16.png', np.concatenate([gray16, a16], -1), 4, 16)
png('rgba8.png', np.concatenate([rgb8, a8], -1), 6, 8)
png('rgba16.png', np.concatenate([rgb16, a16], -1), 6, 16)
png('rgba8-opaque.png', np.concatenate([rgb8, np.full_like(a8, 255)], -1), 6, 8)
png('key-gray8.png', gray8, 0, 8, trns=struct.pack('>H', int(gray8[0, 0, 0])))
key_rgb16 = rgb16.copy()
key_rgb16[H - 4:, : W // 3] = [1234, 5678, 9012]
png('key-rgb16.png', key_rgb16, 2, 16, trns=struct.pack('>HHH', 1234, 5678, 9012))
png('int-rgb8.png', rgb8, 2, 8, interlace=True)
png('int-gray2.png', (gray8 * 3) // 255, 0, 2, interlace=True)
png('int-rgba16.png', np.concatenate([rgb16, a16], -1), 6, 16, interlace=True)
idx4 = ((np.arange(W)[None, :] // 3 + np.arange(H)[:, None]) % 16)[..., None]
png('int-pal4-trns.png', idx4, 3, 4, interlace=True, palette=pal[:16], trns=bytes([0, 64, 128, 255, 0]))
# Interlaced 2-bit gray with a transparent gray: decoded to 8 bits, so its key is scaled the same way (2 becomes 170).
png('int-gray2-key.png', (gray8 * 3) // 255, 0, 2, interlace=True, trns=struct.pack('>H', 2))
# Random samples, which the Paeth filter's ties and every filter's carries reach (a smooth pattern rarely does).
noise = np.random.default_rng(11)
png('noise-rgba8.png', noise.integers(0, 256, size=(24, 40, 4)), 6, 8)
png('noise-rgba16.png', noise.integers(0, 65536, size=(16, 24, 4)), 6, 16)
png('noise-rgb8.png', noise.integers(0, 256, size=(24, 40, 3)), 2, 8)
# The profile Pillow makes carries the time it was made; fixed here (with no profile ID) so the files are the same each run.
SRGB = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
SRGB[24:36] = struct.pack('>6H', 2026, 1, 1, 0, 0, 0)
SRGB[84:100] = bytes(16)
SRGB = bytes(SRGB)
iccp = b'sRGB fixture\x00\x00' + zlib.compress(SRGB)
png('iccp-rgb.png', rgb8, 2, 8, extra=[(b'iCCP', iccp)])
png('iccp-mismatch.png', gray8, 0, 8, extra=[(b'iCCP', iccp)])
png('gamma1.png', rgb8, 2, 8, extra=[(b'gAMA', struct.pack('>I', 100000))])
# Orientation, losslessly: the upright pattern stored so that each EXIF orientation shows it upright again.
UNDO = {1: None, 2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180, 4: Image.Transpose.FLIP_TOP_BOTTOM,
        5: Image.Transpose.TRANSPOSE, 6: Image.Transpose.ROTATE_90, 7: Image.Transpose.TRANSVERSE, 8: Image.Transpose.ROTATE_270}
upright = Image.fromarray(rgb8.astype(np.uint8))
for o in range(1, 9):
    stored = upright if UNDO[o] is None else upright.transpose(UNDO[o])
    png(f'orient{o}.png', np.asarray(stored).astype(np.int64), 2, 8, extra=[(b'eXIf', exif_orientation(o))])
# Hostile and damaged.
good = png('crc.png', rgb8, 2, 8)
bad = bytearray(good)
bad[bad.index(b'IDAT') + 10] ^= 0xFF
write('crc.png', bytes(bad))
whole = zlib.compress(filter_rows(pack_rows(rgb8, 8), 3), 9)
out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)) + chunk(b'IDAT', whole[: len(whole) // 2]) + chunk(b'IEND', b'')
write('short.png', out)
# A 16 x 16 picture whose data goes on to inflate to 64 MB: only the picture's own rows may be expanded or kept.
bomb = zlib.compressobj(9)
z = bomb.compress(filter_rows(pack_rows(np.zeros((16, 16, 1), dtype=np.int64), 8), 1))
zero = bytes(1 << 20)
for _ in range(64):
    z += bomb.compress(zero)
z += bomb.flush()
out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 0, 0, 0, 0))
for i in range(0, len(z), 65536):
    out += chunk(b'IDAT', z[i:i + 65536])
write('bomb.png', out + chunk(b'IEND', b''))
write('huge.png', b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 40000, 40000, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00')) + chunk(b'IEND', b''))

# ---------------------------------------------------------------- JPEG fixtures

JW, JH = 64, 48
photo = Image.fromarray(pattern(JW, JH).astype(np.uint8))
exif = Image.Exif()
exif[0x010F] = 'LeakyCam'
exif[0x0110] = 'LC-1000'
exif[0x8825] = {1: 'N', 2: (40.0, 26.0, 46.0), 3: 'W', 4: (79.0, 58.0, 56.0)}
XMP = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Jane Example</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>'
buf = io.BytesIO()
photo.save(buf, 'JPEG', quality=90, subsampling=2, dpi=(300, 300), exif=exif, comment=b'Secret comment from Jane Example', xmp=XMP)
write('baseline.jpg', buf.getvalue())
buf = io.BytesIO()
photo.save(buf, 'JPEG', quality=85, progressive=True, optimize=True, icc_profile=SRGB)
write('progressive-icc.jpg', buf.getvalue())
buf = io.BytesIO()
photo.convert('L').save(buf, 'JPEG', quality=90)
write('gray.jpg', buf.getvalue())
buf = io.BytesIO()
photo.convert('CMYK').save(buf, 'JPEG', quality=92)
write('cmyk.jpg', buf.getvalue())
for o in range(1, 9):
    stored = photo if UNDO[o] is None else photo.transpose(UNDO[o])
    e = Image.Exif()
    e[0x0112] = o
    buf = io.BytesIO()
    stored.save(buf, 'JPEG', quality=95, subsampling=0, exif=e)
    write(f'orient{o}.jpg', buf.getvalue())
base = open(os.path.join(OUT, 'baseline.jpg'), 'rb').read()
second = io.BytesIO()
photo.resize((16, 12)).save(second, 'JPEG', quality=50)
write('trailing.jpg', base + second.getvalue())
write('truncated.jpg', base[: int(len(base) * 0.7)])

# ---------------------------------------------------------------- other formats

Image.fromarray((gray16[..., 0]).astype(np.uint16)).save(os.path.join(OUT, 'gray16.tiff'))
print('wrote', len(os.listdir(OUT)), 'files to', os.path.normpath(OUT))
