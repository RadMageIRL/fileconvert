"""Writes the fixtures for the image optimization tools (v0.2.0, Phase 3) into tests/fixtures/optimize/: small synthetic
pictures, each made here, for Compress PNG, JPG, WebP and AVIF and Resize images.

    python tools/make-optimize-fixtures.py      (needs Pillow 11 with AVIF and WebP, NumPy and pypng; the 10-bit HDR
                                                 AVIF needs FFmpeg with libaom on the PATH, and is skipped without it)

PNG: photo-like RGB saved with quick settings; RGBA with partial alpha and noise under transparent pixels; an 8-bit
palette with transparency; 16-bit RGB whose values all fit in 8 bits, and true 16-bit RGB; gray content stored as RGB
with an RGB color profile; text, EXIF (orientation 6), gamma, chromaticities and physical size; interlaced; an animated
PNG of three frames; one cut short and one with a bad checksum.
JPEG: 4:2:0 and 4:4:4 photos; progressive; gray; CMYK; EXIF orientation 6 with a color profile, a comment and XMP;
restart markers; a Multi-Picture (MPF) file whose index points at a second picture after the first; one cut short.
WebP: lossy, lossless, lossy with alpha, one with a color profile and EXIF, and an animated one.
AVIF: 8-bit, with alpha, with a color profile, turned by an irot box, with an EXIF item, animated, and 10-bit PQ HDR.
GIF and BMP for Resize images.

Everything is synthetic and deterministic (the same bytes every time with the same library versions).
"""

import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

import numpy as np
import png
from PIL import Image, ImageCms

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures', 'optimize')
rng = np.random.default_rng(20261125)


def write(name, data):
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, name), 'wb') as f:
        f.write(data)


def chunk(t, data):
    return struct.pack('>I', len(data)) + t + data + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)


def chunks_of(b):
    p, out = 8, []
    while p < len(b):
        n = struct.unpack('>I', b[p:p + 4])[0]
        out.append((b[p + 4:p + 8], b[p + 8:p + 8 + n]))
        p += 12 + n
    return out


def with_chunks(b, extra):
    parts = chunks_of(b)
    i = next(k for k, (t, _) in enumerate(parts) if t == b'IDAT')
    return b'\x89PNG\r\n\x1a\n' + b''.join(chunk(t, d) for t, d in parts[:i] + extra + parts[i:])


def pypng(arr, w, h, **kw):
    buf = io.BytesIO()
    png.Writer(w, h, compression=1, **kw).write(buf, [r.tolist() for r in np.ascontiguousarray(arr)])
    return buf.getvalue()


def photo(w, h, noise=5):
    y, x = np.mgrid[0:h, 0:w]
    base = np.stack([128 + 100 * np.sin(x / 17.0) * np.cos(y / 23.0), 128 + 90 * np.cos(y / 13.0), 128 + 60 * np.sin((x + 2 * y) / 29.0)], -1)
    base[h // 3:h // 3 + 4, :] = 24
    base[:, w // 2:w // 2 + 3] = 232
    return np.clip(base + rng.normal(0, noise, (h, w, 3)), 0, 255).astype(np.uint8)


def zero_times(b):
    """The creation and modification times in an ISOBMFF movie's mvhd, tkhd and mdhd boxes, set to 0."""
    b = bytearray(b)
    for box in (b'mvhd', b'tkhd', b'mdhd'):
        i = 0
        while (i := b.find(box, i)) >= 0:
            v = b[i + 4]
            n = 8 if v == 1 else 4
            b[i + 8:i + 8 + 2 * n] = b'\0' * (2 * n)
            i += 4
    return bytes(b)


def pil(im, fmt, **kw):
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    return buf.getvalue()


SRGB = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
SRGB[24:36] = b'\0' * 12  # the profile's creation date, so the fixtures are the same every time
SRGB[84:100] = b'\0' * 16  # and its ID, an MD5 made with that date (0 means none)
SRGB = bytes(SRGB)
# An RGB profile that is not sRGB: sRGB with its description changed and no profile ID.
OTHER = bytearray(SRGB)
k = OTHER.find(b'sRGB')
if k >= 0:
    OTHER[k:k + 4] = b'xRGB'
OTHER[84:100] = b'\0' * 16
OTHER = bytes(OTHER)
EXIF6 = b'MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0'


def png_fixtures():
    W, H = 160, 120
    rgb = photo(W, H)
    write('rgb.png', pypng(rgb.reshape(H, -1), W, H, greyscale=False))
    alpha = np.tile(np.linspace(0, 255, W).astype(np.uint8), (H, 1))
    alpha[:, :24] = 0
    rgba = np.dstack([rgb, alpha])
    rgba[:, :24, :3] = rng.integers(0, 256, (H, 24, 3), dtype=np.uint8)
    write('rgba.png', pypng(rgba.reshape(H, -1), W, H, greyscale=False, alpha=True))
    pal = [(i * 16, 255 - i * 16, (i * 37) % 256, 255 if i % 4 else 0) for i in range(16)]
    idx = ((np.arange(W)[None, :] // 10 + np.arange(H)[:, None] // 10) % 16).astype(np.uint8)
    write('palette.png', pypng(idx, W, H, palette=pal, bitdepth=8))
    write('rgb16-8.png', pypng((rgb.astype(np.uint16) * 257).reshape(H, -1), W, H, greyscale=False, bitdepth=16))
    r16 = rng.integers(0, 65536, (H, W, 3), dtype=np.uint16)
    r16[:, :, 0] = np.linspace(0, 65535, W).astype(np.uint16)[None, :]
    write('rgb16.png', pypng(r16.reshape(H, -1), W, H, greyscale=False, bitdepth=16))
    g = rgb[:, :, 0]
    b = pypng(np.dstack([g, g, g]).reshape(H, -1), W, H, greyscale=False)
    write('gray-rgb-icc.png', with_chunks(b, [(b'iCCP', b'Custom\0\0' + zlib.compress(OTHER))]))
    b = pypng(rgb.reshape(H, -1), W, H, greyscale=False)
    write('meta.png', with_chunks(b, [
        (b'gAMA', struct.pack('>I', 45455)),
        (b'cHRM', struct.pack('>8I', 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000)),
        (b'pHYs', struct.pack('>IIB', 11811, 11811, 1)),
        (b'eXIf', EXIF6),
        (b'tEXt', b'Author\0MARK-AUTHOR-PNG'),
        (b'iTXt', b'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>MARK-XMP-PNG</x:xmpmeta>'),
        (b'tIME', struct.pack('>HBBBBB', 2026, 11, 25, 12, 0, 0)),
    ]))
    write('interlaced.png', pypng(rgb.reshape(H, -1), W, H, greyscale=False, interlace=True))
    frames = [Image.fromarray(np.roll(rgba, 16 * i, axis=1)) for i in range(3)]
    write('animated.png', pil(frames[0], 'PNG', save_all=True, append_images=frames[1:], duration=[100, 200, 300], loop=0, disposal=1, blend=0, compress_level=1))
    good = open(os.path.join(ROOT, 'rgb.png'), 'rb').read()
    write('truncated.png', good[:len(good) // 2])
    bad = bytearray(good)
    bad[60] ^= 0x5a
    write('badcrc.png', bytes(bad))


def app(marker, body):
    return bytes([0xff, marker]) + struct.pack('>H', len(body) + 2) + body


def jpeg_fixtures():
    W, H = 320, 240
    im = Image.fromarray(photo(W, H))
    write('photo.jpg', pil(im, 'JPEG', quality=92, subsampling=2))
    write('photo444.jpg', pil(im, 'JPEG', quality=92, subsampling=0))
    write('progressive.jpg', pil(im, 'JPEG', quality=90, progressive=True))
    write('gray.jpg', pil(im.convert('L'), 'JPEG', quality=90))
    write('cmyk.jpg', pil(im.convert('CMYK'), 'JPEG', quality=90))
    write('restart.jpg', pil(im, 'JPEG', quality=90, restart_marker_blocks=4))
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x010F] = 'MARK-MAKE-JPEG'
    b = pil(im, 'JPEG', quality=92, exif=exif.tobytes(), icc_profile=SRGB, comment=b'MARK-COMMENT-JPEG')
    xmp = app(0xe1, b'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>MARK-XMP-JPEG</x:xmpmeta>')
    write('exif-icc.jpg', b[:2] + xmp + b[2:])
    # MPF: a primary picture whose APP2 index points at a second, smaller picture placed after its end.
    second = pil(Image.fromarray(photo(80, 60, 2)), 'JPEG', quality=80)
    primary = pil(im, 'JPEG', quality=92)

    def mpf(offset):
        # TIFF header (big-endian), IFD with MPFVersion, NumberOfImages and MPEntry (two entries of 16 bytes).
        ifd = struct.pack('>H', 3)
        entries_at = 8 + 2 + 3 * 12 + 4
        ifd += struct.pack('>HHI4s', 0xb000, 7, 4, b'0100')
        ifd += struct.pack('>HHII', 0xb001, 4, 1, 2)
        ifd += struct.pack('>HHII', 0xb002, 7, 32, entries_at)
        ifd += struct.pack('>I', 0)
        e1 = struct.pack('>IIIHH', 0x20030000, 0, 0, 0, 0)
        e2 = struct.pack('>IIIHH', 0x00000000, len(second), offset, 0, 0)
        return b'MPF\0' + b'MM\0*' + struct.pack('>I', 8) + ifd + e1 + e2
    seg = app(0xe2, mpf(0))
    head = primary[:2] + seg
    body = primary[2:]
    tiff_at = len(primary[:2]) + 4 + 4  # marker and length, then "MPF\0"
    offset = len(head) + len(body) - tiff_at
    write('mpf.jpg', primary[:2] + app(0xe2, mpf(offset)) + body + second)
    good = open(os.path.join(ROOT, 'photo.jpg'), 'rb').read()
    write('truncated.jpg', good[:len(good) * 2 // 3])


def webp_fixtures():
    W, H = 160, 120
    rgb = photo(W, H)
    im = Image.fromarray(rgb)
    write('lossy.webp', pil(im, 'WEBP', quality=95, method=4))
    write('lossless.webp', pil(im, 'WEBP', lossless=True, quality=20, method=0))
    alpha = np.tile(np.linspace(0, 255, W).astype(np.uint8), (H, 1))
    write('alpha.webp', pil(Image.fromarray(np.dstack([rgb, alpha])), 'WEBP', quality=95, alpha_quality=100))
    exif = Image.Exif()
    exif[0x010F] = 'MARK-MAKE-WEBP'
    write('meta.webp', pil(im, 'WEBP', quality=95, icc_profile=OTHER, exif=exif.tobytes()))
    frames = [Image.fromarray(np.roll(rgb, 16 * i, axis=1)) for i in range(3)]
    write('animated.webp', pil(frames[0], 'WEBP', save_all=True, append_images=frames[1:], duration=100, quality=80))


def avif_fixtures():
    W, H = 128, 96
    rgb = photo(W, H)
    im = Image.fromarray(rgb)
    write('photo.avif', pil(im, 'AVIF', quality=90))
    alpha = np.tile(np.linspace(0, 255, W).astype(np.uint8), (H, 1))
    write('alpha.avif', pil(Image.fromarray(np.dstack([rgb, alpha])), 'AVIF', quality=90))
    write('icc.avif', pil(im, 'AVIF', quality=90, icc_profile=OTHER))
    e = Image.Exif()
    e[0x0112] = 6
    write('rotated.avif', pil(Image.fromarray(photo(W, 64)), 'AVIF', quality=90, exif=e.tobytes()))
    e = Image.Exif()
    e[0x010F] = 'MARK-MAKE-AVIF'
    write('exif.avif', pil(im, 'AVIF', quality=90, exif=e.tobytes()))
    frames = [Image.fromarray(np.roll(rgb, 16 * i, axis=1)) for i in range(3)]
    write('animated.avif', zero_times(pil(frames[0], 'AVIF', save_all=True, append_images=frames[1:], duration=100, quality=80)))
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        print('FFmpeg not found: hdr10.avif not written', file=sys.stderr)
        return
    # 10-bit PQ (BT.2020): a gradient in 16-bit RGB through FFmpeg's AVIF writer with libaom.
    t = tempfile.mkdtemp()
    src = os.path.join(t, 'g.png')
    g16 = np.zeros((H, W, 3), np.uint16)
    g16[:, :, 0] = np.linspace(0, 40000, W)[None, :]
    g16[:, :, 1] = np.linspace(0, 30000, H)[:, None]
    g16[:, :, 2] = 20000
    # Texture, so that compressing it again gives a smaller file whose color description can be checked (a smooth
    # gradient is a few hundred bytes, which no result beats). Its own generator, so the fixtures after it stay the same.
    g16 = np.clip(g16.astype(np.int32) + np.random.default_rng(2020).integers(-3000, 3000, g16.shape), 0, 65535).astype(np.uint16)
    with open(src, 'wb') as f:
        f.write(pypng(g16.reshape(H, -1), W, H, greyscale=False, bitdepth=16))
    out = os.path.join(t, 'hdr10.avif')
    subprocess.run([ffmpeg, '-v', 'error', '-y', '-i', src, '-c:v', 'libaom-av1', '-still-picture', '1', '-pix_fmt', 'yuv420p10le', '-crf', '4',
                    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'pc', '-frames:v', '1', out], check=True)
    write('hdr10.avif', open(out, 'rb').read())
    shutil.rmtree(t)


def other_fixtures():
    im = Image.fromarray(photo(120, 90))
    write('picture.gif', pil(im.convert('P', palette=Image.Palette.ADAPTIVE), 'GIF'))
    write('picture.bmp', pil(im, 'BMP'))


if __name__ == '__main__':
    png_fixtures()
    jpeg_fixtures()
    webp_fixtures()
    avif_fixtures()
    other_fixtures()
    print('written to', os.path.normpath(ROOT), file=sys.stderr)
