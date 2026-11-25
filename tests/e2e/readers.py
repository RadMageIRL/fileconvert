"""Independent readers for FileConvert's document and data results, used by the browser tests.

    python -I readers.py <kind> <path>

Prints JSON. csv and tsv use Python's csv module; json and jsonl the json module; xlsx openpyxl (formulas and their
saved results, number formats, merged cells, sheet states); docx python-docx (paragraph styles, list levels, run
formatting, links, tables and pictures); md mistune (CommonMark with GFM tables); mdzip zipfile, mistune and Pillow
(a Markdown ZIP, extracted and its picture links followed); media zipfile (a DOCX's pictures); pdf qpdf, pypdf,
Xpdf pdftotext and PDFium (a PDF's structure, text and rendered pages); pdfdeep qpdf, pypdf and PDFium (what a
merge keeps: bookmarks, links, named destinations, form fields, layers, page boxes, renders); render PDFium (pictures
of PDF pages compared with its own rendering); pdfmeta qpdf, pypdf, Pillow and PDFium (what metadata a PDF holds, and
what stays). None of them shares code with the browser engines.
"""

import csv
import datetime
import io
import json
import os
import sys


def plain(v):
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    return v


def read_csv(path, delimiter):
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.reader(f, delimiter=delimiter))


def read_xlsx(path):
    import openpyxl
    formulas = openpyxl.load_workbook(path)
    values = openpyxl.load_workbook(path, data_only=True)
    out = []
    for ws in formulas.worksheets:
        wv = values[ws.title]
        rows, cells = [], {}
        for row in ws.iter_rows():
            r = []
            for c in row:
                cached = wv[c.coordinate].value
                r.append(plain(cached))
                if c.value is not None:
                    cells[c.coordinate] = {'type': c.data_type, 'format': c.number_format}
                    if c.data_type == 'f':
                        cells[c.coordinate]['formula'] = str(c.value)
            rows.append(r)
        out.append({'name': ws.title, 'state': ws.sheet_state, 'merged': sorted(str(m) for m in ws.merged_cells.ranges), 'rows': rows, 'cells': cells})
    return out


def read_docx(path):
    import docx
    from docx.oxml.ns import qn
    d = docx.Document(path)
    blocks = []
    for el in d.element.body.iterchildren():
        tag = el.tag.split('}')[1]
        if tag == 'p':
            p = docx.text.paragraph.Paragraph(el, d)
            numpr = el.find('.//' + qn('w:numPr'))
            level = None
            if numpr is not None and numpr.find(qn('w:ilvl')) is not None:
                level = int(numpr.find(qn('w:ilvl')).get(qn('w:val')))
            runs = []
            for r in el.iter(qn('w:r')):
                text = ''.join(t.text or '' for t in r.iter(qn('w:t')))
                rp = r.find(qn('w:rPr'))
                f = {}
                if rp is not None:
                    for k in ('b', 'i', 'strike', 'vertAlign', 'rFonts', 'rStyle'):
                        e = rp.find(qn('w:' + k))
                        if e is not None:
                            f[k] = e.get(qn('w:val')) or e.get(qn('w:ascii')) or True
                if r.find('.//' + qn('w:drawing')) is not None:
                    f['picture'] = True
                if r.find(qn('w:br')) is not None:
                    f['break'] = True
                parent = r.getparent()
                if parent.tag == qn('w:hyperlink'):
                    rid = parent.get(qn('r:id'))
                    f['link'] = d.part.rels[rid].target_ref if rid in d.part.rels else None
                runs.append({'text': text, **f})
            blocks.append({'type': 'p', 'style': p.style.name if p.style is not None else None, 'level': level, 'text': p.text, 'runs': runs})
        elif tag == 'tbl':
            t = docx.table.Table(el, d)
            blocks.append({'type': 'table', 'header': el.find('.//' + qn('w:tblHeader')) is not None, 'rows': [[c.text for c in row.cells] for row in t.rows]})
    pictures = []
    for shape in d.inline_shapes:
        blip = shape._inline.graphic.graphicData.pic.blipFill.blip
        part = d.part.related_parts[blip.embed]
        pictures.append({'type': part.content_type, 'bytes': len(part.blob), 'width': shape.width, 'height': shape.height})
    core = d.core_properties
    return {'blocks': blocks, 'pictures': pictures, 'title': core.title, 'author': core.author}


def read_md(path):
    """Markdown parsed by mistune (CommonMark with GFM tables and strikethrough), summarized from its syntax tree."""
    import mistune
    with open(path, encoding='utf-8') as f:
        text = f.read()
    tree = mistune.create_markdown(renderer='ast', plugins=['table', 'strikethrough'])(text)
    out = {'headings': [], 'items': [], 'tables': [], 'code': [], 'quotes': [], 'links': [], 'images': [], 'strong': [], 'em': [], 'strike': [], 'codespans': [], 'html': [], 'breaks': 0, 'rules': 0}

    def plain(nodes):
        s = ''
        for n in nodes or []:
            t = n['type']
            if t in ('text', 'codespan', 'inline_html'):
                s += n.get('raw', '')
            elif t in ('linebreak', 'softbreak'):
                s += '\n' if t == 'linebreak' else ' '
            elif t == 'image':
                s += ''
            else:
                s += plain(n.get('children'))
        return s

    def walk(nodes, depth=0, ordered=None):
        for n in nodes or []:
            t = n['type']
            kids = n.get('children')
            if t == 'heading':
                out['headings'].append([n['attrs']['level'], plain(kids)])
            elif t == 'list':
                walk(kids, depth + 1, n['attrs'].get('ordered'))
                continue
            elif t == 'list_item':
                first = next((k for k in kids or [] if k['type'] in ('paragraph', 'block_text')), None)
                out['items'].append({'depth': depth, 'ordered': bool(ordered), 'text': plain(first.get('children')) if first else ''})
            elif t == 'table':
                head = next(k for k in kids if k['type'] == 'table_head')
                body = next((k for k in kids if k['type'] == 'table_body'), {'children': []})
                out['tables'].append({'head': [plain(c.get('children')) for c in head['children']], 'align': [c['attrs'].get('align') for c in head['children']],
                                      'rows': [[plain(c.get('children')) for c in r['children']] for r in body['children']]})
                continue
            elif t == 'block_code':
                out['code'].append({'info': (n.get('attrs') or {}).get('info'), 'text': n.get('raw', '')})
            elif t == 'block_quote':
                out['quotes'].append(plain([{'type': 'x', 'children': [p for p in kids]}]))
            elif t == 'link':
                out['links'].append({'url': n['attrs']['url'], 'text': plain(kids)})
            elif t == 'image':
                out['images'].append({'url': n['attrs']['url'][:40], 'alt': plain(kids)})
            elif t == 'strong':
                out['strong'].append(plain(kids))
            elif t == 'emphasis':
                out['em'].append(plain(kids))
            elif t == 'strikethrough':
                out['strike'].append(plain(kids))
            elif t == 'codespan':
                out['codespans'].append(n.get('raw', ''))
            elif t in ('inline_html', 'block_html'):
                out['html'].append(n.get('raw', ''))
            elif t == 'linebreak':
                out['breaks'] += 1
            elif t == 'thematic_break':
                out['rules'] += 1
            walk(kids, depth, ordered)

    walk(tree)
    out['text'] = text
    return out


def read_mdzip(path):
    """A Markdown ZIP (Markdown with its pictures as files), checked as someone who extracts it would meet it.

    zipfile checks every entry's CRC and lists the names, which must be relative, forward-slashed, free of '..' and
    flagged UTF-8 when they are not ASCII. The ZIP is then extracted into a new folder, the Markdown there is read
    by mistune, and every picture it refers to (Markdown images, and img tags in HTML kept inside it) is resolved
    against the extracted files; raster pictures are decoded by Pillow, SVG files are searched for script.
    """
    import hashlib
    import re
    import tempfile
    import zipfile
    import mistune
    from PIL import Image
    z = zipfile.ZipFile(path)
    entries = []
    for i in z.infolist():
        data = z.read(i)
        entries.append({'name': i.filename, 'size': i.file_size, 'utf8': bool(i.flag_bits & 0x800), 'dir': i.is_dir(),
                        'sha256': hashlib.sha256(data).hexdigest(), 'stored': i.compress_type == zipfile.ZIP_STORED})
    bad_crc = z.testzip()
    unsafe = [e['name'] for e in entries if e['name'].startswith('/') or '\\' in e['name'] or '..' in e['name'].split('/') or re.match(r'^[A-Za-z]:', e['name'])]
    nonascii_unflagged = [e['name'] for e in entries if any(ord(c) > 127 for c in e['name']) and not e['utf8']]
    out = tempfile.mkdtemp(prefix='mdzip-')
    if not unsafe:
        z.extractall(out)
    mds = [e['name'] for e in entries if e['name'].endswith('.md')]
    images = []
    html_path = None
    if len(mds) == 1:
        md_path = os.path.join(out, *mds[0].split('/'))
        with open(md_path, encoding='utf-8') as f:
            text = f.read()
        tree = mistune.create_markdown(renderer='ast', plugins=['table', 'strikethrough'])(text)
        urls = []

        def walk(nodes):
            for n in nodes or []:
                if n['type'] == 'image':
                    urls.append(n['attrs']['url'])
                elif n['type'] in ('inline_html', 'block_html'):
                    urls.extend(re.findall(r'<img[^>]*\bsrc="([^"]+)"', n.get('raw', '')))
                walk(n.get('children'))
        walk(tree)
        for url in urls:
            target = os.path.normpath(os.path.join(os.path.dirname(md_path), *url.split('/')))
            info = {'url': url, 'exists': os.path.isfile(target) and target.startswith(os.path.normpath(out) + os.sep)}
            if info['exists']:
                with open(target, 'rb') as f:
                    raw = f.read()
                info['sha256'] = hashlib.sha256(raw).hexdigest()
                if url.endswith('.svg'):
                    low = raw.decode('utf-8').lower()
                    info['format'] = 'SVG'
                    info['script'] = '<script' in low or 'onload' in low or 'https://' in low
                else:
                    with Image.open(io.BytesIO(raw)) as im:
                        im.load()
                        info['format'], info['width'], info['height'] = im.format, im.width, im.height
            images.append(info)
        # The extracted Markdown as a page, made by mistune, so a browser can show it from the extracted folder.
        html_path = os.path.join(os.path.dirname(md_path), 'rendered-by-mistune.html')
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write('<!doctype html><meta charset="utf-8">' + mistune.create_markdown(plugins=['table', 'strikethrough'], escape=False)(text))
    return {'entries': entries, 'bad_crc': bad_crc, 'unsafe': unsafe, 'nonascii_unflagged': nonascii_unflagged,
            'markdown': mds, 'images': images, 'extracted': out, 'html': html_path}


def read_pdf(path):
    """A PDF as independent programs see it: qpdf checks its structure and writes a fully decompressed copy (for
    searching every object and stream), pypdf lists pages, text, annotations, form fields, outline titles, named
    destinations and catalog entries, Xpdf's pdftotext gives the text in reading order, and PDFium renders each page
    at 72 dpi (the SHA-256 of each bitmap, so pages can be compared with the source's)."""
    import hashlib
    import shutil
    import subprocess
    import tempfile
    import pypdf
    import pypdfium2
    qpdf = shutil.which('qpdf') or 'C:/msys64/ucrt64/bin/qpdf.exe'
    check = subprocess.run([qpdf, '--check', path], capture_output=True, text=True)
    decompressed = os.path.join(tempfile.mkdtemp(prefix='pdf-'), 'qdf.pdf')
    subprocess.run([qpdf, '--qdf', '--object-streams=disable', '--decode-level=all', path, decompressed], capture_output=True)
    r = pypdf.PdfReader(path)
    root = r.trailer['/Root']
    names = []
    try:
        names = sorted(r.named_destinations.keys())
    except Exception:
        pass

    def titles(items, depth=0):
        out = []
        for it in items:
            if isinstance(it, list):
                out += titles(it, depth + 1)
            else:
                out.append(it.title)
        return out
    fields = sorted((r.get_fields() or {}).keys())
    pdftotext = shutil.which('pdftotext')
    text = subprocess.run([pdftotext, '-enc', 'UTF-8', path, '-'], capture_output=True).stdout.decode('utf-8', 'replace') if pdftotext else ''
    doc = pypdfium2.PdfDocument(path)
    renders = []
    for i in range(len(doc)):
        bitmap = doc[i].render(scale=1).to_numpy()
        renders.append(hashlib.sha256(bitmap.tobytes()).hexdigest())
    return {
        'qpdf': {'ok': check.returncode == 0 and 'No syntax or stream encoding errors' in check.stdout, 'out': (check.stdout + check.stderr).strip()[-400:]},
        'pages': len(r.pages),
        'text': [p.extract_text() for p in r.pages],
        'annots': [[a.get_object().get('/Subtype') for a in (p.get('/Annots') or [])] for p in r.pages],
        'fields': fields,
        'outlines': titles(r.outline),
        'dests': names,
        'catalog': sorted(k for k in root.keys()),
        'pdftotext': text,
        'renders': renders,
        'decompressed': decompressed,
    }


def read_pdf_deep(path):
    """What a merge has to keep, as pypdf, qpdf and PDFium see it, page numbers 0-based: every page's boxes, rotation,
    text and annotations (each link's target page or address, each widget's field and state, whether it has an
    appearance); bookmarks as a tree with their target pages and open or closed state; named destinations (name tree
    and the old /Dests dictionary) with their pages; form fields by full name with value, type and default appearance,
    and the form's fonts by resource name; layers with the hidden ones; page dictionaries in the whole file (more
    than the page count means hidden copies); and each page rendered by PDFium (SHA-256 of the bitmap, at 72 dpi, and
    with form fields drawn through PDFium's form engine)."""
    import hashlib
    import shutil
    import subprocess
    import tempfile
    import pypdf
    import pypdfium2
    from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NameObject, NullObject, NumberObject, TextStringObject, ByteStringObject
    qpdf = shutil.which('qpdf') or 'C:/msys64/ucrt64/bin/qpdf.exe'
    check = subprocess.run([qpdf, '--check', path], capture_output=True, text=True)
    decompressed = os.path.join(tempfile.mkdtemp(prefix='pdf-'), 'qdf.pdf')
    subprocess.run([qpdf, '--qdf', '--object-streams=disable', '--decode-level=all', path, decompressed], capture_output=True)
    with open(decompressed, 'rb') as f:
        qdf = f.read()
    import re
    page_objects = len(re.findall(rb'/Type\s*/Page(?![a-zA-Z])', qdf))
    r = pypdf.PdfReader(path)
    root = r.trailer['/Root'].get_object()
    page_ids = {p.indirect_reference.idnum: i for i, p in enumerate(r.pages)}

    def obj(v):
        return v.get_object() if isinstance(v, IndirectObject) else v

    def text(v):
        v = obj(v)
        if isinstance(v, (TextStringObject, ByteStringObject, str)):
            return str(v)
        return None

    name_tree = {}

    def walk_names(node, depth=0):
        node = obj(node)
        if not isinstance(node, DictionaryObject) or depth > 32:
            return
        arr = obj(node.get('/Names'))
        if isinstance(arr, ArrayObject):
            for i in range(0, len(arr) - 1, 2):
                k = obj(arr[i])
                key = k.original_bytes.decode('latin-1') if hasattr(k, 'original_bytes') else str(k)
                name_tree.setdefault(key, arr[i + 1])
        for kid in obj(node.get('/Kids')) or []:
            walk_names(kid, depth + 1)
    names = obj(root.get('/Names'))
    if isinstance(names, DictionaryObject):
        walk_names(names.get('/Dests'))
    old_dests = obj(root.get('/Dests'))

    def dest_page(d, follow=True):
        d = obj(d)
        if isinstance(d, (TextStringObject, ByteStringObject, NameObject, str)) and follow:
            key = d.original_bytes.decode('latin-1') if hasattr(d, 'original_bytes') else str(d)
            if isinstance(d, NameObject):
                key = str(d)[1:]
            target = name_tree.get(key)
            if target is None and isinstance(old_dests, DictionaryObject):
                target = old_dests.get('/' + key)
            return dest_page(target, False) if target is not None else 'missing'
        if isinstance(d, DictionaryObject):
            d = obj(d.get('/D'))
        if isinstance(d, ArrayObject) and len(d):
            first = d[0]
            if isinstance(first, IndirectObject):
                return page_ids.get(first.idnum, 'not-a-page')
            return 'number' if isinstance(first, NumberObject) else 'bad'
        return None

    def action(a):
        a = obj(a)
        if not isinstance(a, DictionaryObject):
            return None
        s = a.get('/S')
        if s == '/GoTo':
            return {'page': dest_page(a.get('/D'))}
        if s == '/URI':
            return {'uri': text(a.get('/URI'))}
        return {'action': str(s)}

    def outline(first, depth=0):
        out = []
        item = obj(first)
        seen = set()
        while isinstance(item, DictionaryObject) and id(item) not in seen and depth < 64:
            seen.add(id(item))
            entry = {'title': text(item.get('/Title'))}
            if '/Dest' in item:
                entry['page'] = dest_page(item['/Dest'])
            elif '/A' in item:
                entry.update(action(item['/A']) or {})
            count = obj(item.get('/Count'))
            if '/First' in item:
                entry['open'] = not (isinstance(count, NumberObject) and int(count) < 0)
                entry['count'] = int(count) if isinstance(count, NumberObject) else None
                entry['children'] = outline(item['/First'], depth + 1)
            out.append(entry)
            item = obj(item.get('/Next'))
        return out
    outlines = obj(root.get('/Outlines'))

    def full_name(f):
        parts = []
        node = f
        for _ in range(64):
            if '/T' in node:
                parts.append(text(node['/T']))
            parent = obj(node.get('/Parent'))
            if not isinstance(parent, DictionaryObject):
                break
            node = parent
        return '.'.join(reversed(parts))

    def inherited(f, key):
        node = f
        for _ in range(64):
            if key in node:
                return obj(node[key])
            node = obj(node.get('/Parent'))
            if not isinstance(node, DictionaryObject):
                return None
        return None

    pages = []
    for i, p in enumerate(r.pages):
        annots = []
        for a in obj(p.get('/Annots')) or []:
            a = obj(a)
            entry = {'subtype': str(a.get('/Subtype'))}
            if a.get('/Subtype') == '/Link':
                if '/Dest' in a:
                    entry['page'] = dest_page(a['/Dest'])
                elif '/A' in a:
                    entry.update(action(a['/A']) or {'action': None})
            if a.get('/Subtype') == '/Widget':
                entry['field'] = full_name(a)
                entry['as'] = str(a.get('/AS')) if '/AS' in a else None
                entry['ap'] = '/AP' in a
            if a.get('/Subtype') == '/FreeText':
                entry['da'] = text(a.get('/DA'))
            if '/Contents' in a:
                entry['contents'] = text(a['/Contents'])
            annots.append(entry)
        pages.append({
            'mediabox': [float(x) for x in p.mediabox], 'cropbox': [float(x) for x in p.cropbox], 'rotate': p.rotation,
            'text': p.extract_text(), 'annots': annots,
        })
    fields = {}
    af = obj(root.get('/AcroForm'))

    def walk_fields(f, depth=0):
        f = obj(f)
        if not isinstance(f, DictionaryObject) or depth > 64:
            return
        kids = [obj(k) for k in obj(f.get('/Kids')) or []]
        named = [k for k in kids if '/T' in k]
        if named:
            for k in named:
                walk_fields(k, depth + 1)
            return
        v = inherited(f, '/V')
        if isinstance(v, DictionaryObject):
            v = 'signature' if v.get('/Type') == '/Sig' or '/ByteRange' in v else 'dictionary'
        fields[full_name(f)] = {
            'value': text(v) if text(v) is not None else (str(v) if v is not None else None),
            'type': str(inherited(f, '/FT')),
            'da': text(inherited(f, '/DA')) or (text(af.get('/DA')) if isinstance(af, DictionaryObject) else None),
        }
    form = None
    if isinstance(af, DictionaryObject):
        for f in obj(af.get('/Fields')) or []:
            walk_fields(f)
        dr = obj(af.get('/DR'))
        fonts = obj(dr.get('/Font')) if isinstance(dr, DictionaryObject) else None
        form = {
            'da': text(af.get('/DA')),
            'fonts': {str(k)[1:]: str(obj(v).get('/BaseFont')) for k, v in fonts.items()} if isinstance(fonts, DictionaryObject) else {},
            'needAppearances': bool(obj(af.get('/NeedAppearances'))),
            'co': len(obj(af.get('/CO')) or []),
        }
    layers = None
    oc = obj(root.get('/OCProperties'))
    if isinstance(oc, DictionaryObject):
        d = obj(oc.get('/D')) or {}
        groups = [obj(g) for g in obj(oc.get('/OCGs')) or []]
        base_off = d.get('/BaseState') == '/OFF'
        on = {id(obj(g)) for g in obj(d.get('/ON')) or []}
        off = {id(obj(g)) for g in obj(d.get('/OFF')) or []}
        layers = {
            'groups': [text(g.get('/Name')) for g in groups],
            'hidden': sorted(text(g.get('/Name')) for g in groups if (id(g) not in on) if (base_off or id(g) in off)),
            'configs': '/Configs' in oc,
        }
    dests = {k: dest_page(v, False) for k, v in name_tree.items()}
    if isinstance(old_dests, DictionaryObject):
        for k, v in old_dests.items():
            dests.setdefault(str(k)[1:], dest_page(v, False))
    info = r.trailer.get('/Info')
    info = obj(info) if info is not None else None
    doc = pypdfium2.PdfDocument(path)
    renders, form_renders = [], []
    for i in range(len(doc)):
        renders.append(hashlib.sha256(doc[i].render(scale=1).to_numpy().tobytes()).hexdigest())
    import contextlib
    import io as _io
    # pypdfium2 prints a note when a file has XFA data (its build has no XFA); the AcroForm fields still draw.
    with contextlib.redirect_stderr(_io.StringIO()), contextlib.redirect_stdout(_io.StringIO()):
        doc.init_forms()
    for i in range(len(doc)):
        form_renders.append(hashlib.sha256(doc[i].render(scale=1, may_draw_forms=True).to_numpy().tobytes()).hexdigest())
    return {
        'qpdf': {'ok': check.returncode == 0 and 'No syntax or stream encoding errors' in check.stdout, 'out': (check.stdout + check.stderr).strip()[-400:]},
        'version': r.pdf_header,
        'pages': pages,
        'pageObjects': page_objects,
        'outline': outline(outlines.get('/First')) if isinstance(outlines, DictionaryObject) else [],
        'outlineCount': int(obj(outlines.get('/Count'))) if isinstance(outlines, DictionaryObject) and '/Count' in outlines else None,
        'dests': dests,
        'fields': fields,
        'form': form,
        'layers': layers,
        'catalog': sorted(k for k in root.keys()),
        'info': {str(k): text(v) for k, v in info.items()} if isinstance(info, DictionaryObject) else None,
        'metadata': '/Metadata' in root,
        'renders': renders,
        'formRenders': form_renders,
        'decompressed': decompressed,
    }


def read_pdf_turns(path):
    """Each page rendered by PDFium at 72 dpi with no extra turn and with 90, 180 and 270 degrees added (SHA-256 of
    each bitmap), so a page turned by FileConvert can be compared with PDFium turning the source page itself."""
    import hashlib
    import pypdfium2
    doc = pypdfium2.PdfDocument(path)
    return [[hashlib.sha256(doc[i].render(scale=1, rotation=r).to_numpy().tobytes()).hexdigest() for r in (0, 90, 180, 270)] for i in range(len(doc))]


def read_pdf_order(path):
    """The text of every page, in page order, as pypdf and PDFium each read it (for page orders of thousands of pages,
    where rendering every page would be slow), with qpdf's structure check."""
    import shutil
    import subprocess
    import pypdf
    import pypdfium2
    qpdf = shutil.which('qpdf') or 'C:/msys64/ucrt64/bin/qpdf.exe'
    check = subprocess.run([qpdf, '--check', path], capture_output=True, text=True)
    doc = pypdfium2.PdfDocument(path)
    return {
        'qpdf': check.returncode == 0 and 'No syntax or stream encoding errors' in check.stdout,
        'pypdf': [p.extract_text().strip() for p in pypdf.PdfReader(path).pages],
        'pdfium': [doc[i].get_textpage().get_text_range().strip() for i in range(len(doc))],
    }


# ---------------------------------------------------------------- Images to PDF

ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def unpredict(data, columns, colors, bpc, rows=None):
    """Undoes PNG row filters (PNG files, and PDF's Predictor 10 to 15), returning the rows without their filter bytes."""
    import numpy as np
    bpp = max(1, (colors * bpc + 7) // 8)
    rowbytes = (columns * colors * bpc + 7) // 8
    n = rows if rows is not None else len(data) // (rowbytes + 1)
    out = np.zeros((n, rowbytes), dtype=np.int64)
    prev = np.zeros(rowbytes, dtype=np.int64)
    for y in range(n):
        f = data[y * (rowbytes + 1)]
        cur = np.frombuffer(data, dtype=np.uint8, count=rowbytes, offset=y * (rowbytes + 1) + 1).astype(np.int64).copy()
        if f == 0:
            pass
        elif f == 2:
            cur = (cur + prev) & 0xFF
        else:
            for i in range(rowbytes):
                a = cur[i - bpp] if i >= bpp else 0
                b = prev[i]
                if f == 1:
                    cur[i] = (cur[i] + a) & 0xFF
                elif f == 3:
                    cur[i] = (cur[i] + ((a + b) >> 1)) & 0xFF
                else:
                    c = prev[i - bpp] if i >= bpp else 0
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 0xFF
        out[y] = cur
        prev = cur
    return out


def unpack(rows, width, n, bpc):
    """Rows of bytes to samples (h, w, n) at the bit depth (big-endian for 16 bits)."""
    import numpy as np
    h = rows.shape[0]
    if bpc == 16:
        b = rows.astype(np.uint16)
        s = (b[:, 0::2] << 8) | b[:, 1::2]
        return s[:, : width * n].reshape(h, width, n).astype(np.int64)
    if bpc == 8:
        return rows[:, : width * n].reshape(h, width, n)
    bits = np.unpackbits(rows.astype(np.uint8), axis=1)[:, : width * n * bpc].reshape(h, width * n, bpc)
    vals = np.zeros((h, width * n), dtype=np.int64)
    for k in range(bpc):
        vals = (vals << 1) | bits[:, :, k]
    return vals.reshape(h, width, n)


def png_source(path):
    """A PNG decoded by this file's own decoder: its samples at their own depth, its alpha, palette, color key and
    orientation."""
    import zlib
    import numpy as np
    from PIL import Image
    b = open(path, 'rb').read()
    p = 8
    idat = b''
    info = {'palette': None, 'trns': None}
    while p < len(b):
        n = int.from_bytes(b[p:p + 4], 'big')
        kind = b[p + 4:p + 8]
        data = b[p + 8:p + 8 + n]
        if kind == b'IHDR':
            w, h, depth, ct, _, _, interlace = int.from_bytes(data[:4], 'big'), int.from_bytes(data[4:8], 'big'), data[8], data[9], data[10], data[11], data[12]
        elif kind == b'PLTE':
            info['palette'] = data
        elif kind == b'tRNS':
            info['trns'] = data
        elif kind == b'IDAT':
            idat += data
        p += 12 + n
    spp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    raw = zlib.decompressobj().decompress(idat)
    if interlace:
        samples = np.zeros((h, w, spp), dtype=np.int64)
        at = 0
        for x0, y0, dx, dy in ADAM7:
            pw, ph = max(0, -(-(w - x0) // dx)), max(0, -(-(h - y0) // dy))
            if not pw or not ph:
                continue
            rb = (pw * spp * depth + 7) // 8
            part = raw[at: at + ph * (rb + 1)]
            at += ph * (rb + 1)
            samples[y0::dy, x0::dx] = unpack(unpredict(part, pw, spp, depth, ph), pw, spp, depth)
    else:
        samples = unpack(unpredict(raw, w, spp, depth, h), w, spp, depth)
    colors = 3 if ct in (2, 6) else 1
    orientation = 1
    try:
        orientation = Image.open(path).getexif().get(0x0112, 1)
    except Exception:
        pass
    return {'ct': ct, 'depth': depth, 'w': w, 'h': h, 'color': samples[..., :colors], 'alpha': samples[..., colors] if ct in (4, 6) else None,
            'palette': info['palette'], 'trns': info['trns'], 'orientation': orientation}


def jpeg_without_metadata(b):
    """A JPEG with its APPn segments other than JFIF and Adobe, and its comments, taken out (between scans too), cut
    at its end marker: what a PDF should hold. Walked by this file's own code."""
    out = bytearray(b[:2])
    p = 2
    while p + 1 < len(b):
        m = b[p + 1]
        if b[p] != 0xFF:
            break
        if m == 0xFF:
            p += 1
            continue
        if m == 0xD9:
            out += b[p:p + 2]
            return bytes(out), p + 2
        if 0xD0 <= m <= 0xD7:
            out += b[p:p + 2]
            p += 2
            continue
        end = p + 2 + int.from_bytes(b[p + 2:p + 4], 'big')
        if m == 0xDA:
            q = end
            while True:
                q = b.find(b'\xff', q)
                if q < 0 or q + 1 >= len(b):
                    q = len(b)
                    break
                n = b[q + 1]
                if n == 0 or 0xD0 <= n <= 0xD7:
                    q += 2
                    continue
                if n == 0xFF:
                    q += 1
                    continue
                break
            out += b[p:q]
            p = q
            continue
        keep = not ((0xE0 <= m <= 0xEF) or m == 0xFE) or (m == 0xE0 and b[p + 4:p + 9] == b'JFIF\x00') or (m == 0xEE and b[p + 4:p + 9] == b'Adobe')
        if keep:
            out += b[p:end]
        p = end
    return bytes(out + b'\xff\xd9'), None


def pdf_image(xobj):
    """A PDF image XObject decoded by this file's own code (zlib and the PNG predictor; JPEG data by Pillow): its
    samples (h, w, n) at its own depth, and the facts of its dictionary."""
    import io
    import zlib
    import numpy as np
    from PIL import Image
    d = xobj
    w, h, bpc = int(d['/Width']), int(d['/Height']), int(d.get('/BitsPerComponent', 8))
    cs = d.get('/ColorSpace')
    cs = cs.get_object() if hasattr(cs, 'get_object') else cs
    facts = {'width': w, 'height': h, 'bpc': bpc, 'filter': str(d.get('/Filter')), 'decode': [float(x) for x in d['/Decode']] if '/Decode' in d else None,
             'mask': [int(x) for x in d['/Mask']] if isinstance(d.get('/Mask'), list) else None}
    n = 1
    if isinstance(cs, list):
        kind = str(cs[0])
        if kind == '/ICCBased':
            prof = cs[1].get_object()
            n = int(prof['/N'])
            import hashlib
            facts['cs'] = f'ICCBased:{n}'
            facts['icc'] = hashlib.sha256(prof.get_data()).hexdigest()
        elif kind == '/Indexed':
            base = cs[1].get_object() if hasattr(cs[1], 'get_object') else cs[1]
            look = cs[3].get_object() if hasattr(cs[3], 'get_object') else cs[3]
            look = look.get_data() if hasattr(look, 'get_data') else bytes(look.original_bytes if hasattr(look, 'original_bytes') else look)
            facts['cs'] = f'Indexed:{"ICCBased" if isinstance(base, list) else str(base)[1:]}:{int(cs[2])}'
            facts['palette'] = look.hex()
        else:
            facts['cs'] = kind[1:]
    else:
        facts['cs'] = str(cs)[1:]
        n = {'DeviceGray': 1, 'DeviceRGB': 3, 'DeviceCMYK': 4}[facts['cs']]
    raw = xobj._data
    if facts['filter'] == '/DCTDecode':
        facts['raw'] = raw
        img = Image.open(io.BytesIO(raw))
        img.draft(None, None)
        arr = np.asarray(img).astype(np.int64)
        if arr.ndim == 2:
            arr = arr[..., None]
        return arr, facts
    data = zlib.decompress(raw)
    parms = d.get('/DecodeParms')
    if parms and int(parms.get('/Predictor', 1)) >= 10:
        rows = unpredict(data, int(parms['/Columns']), int(parms['/Colors']), int(parms['/BitsPerComponent']), h)
    else:
        rb = (w * n * bpc + 7) // 8
        rows = np.frombuffer(data[: rb * h], dtype=np.uint8).reshape(h, rb).astype(np.int64)
    facts['predictor'] = int(parms.get('/Predictor', 1)) if parms else 1
    return unpack(rows, w, n, bpc), facts


def png_rgba8(s):
    """A decoded PNG (png_source) as 8-bit RGBA, the way a PDF reader shows it: 16-bit samples by their high byte,
    fewer than 8 bits scaled up, palettes looked up, a color key made transparent."""
    import numpy as np
    c, d, ct = s['color'], s['depth'], s['ct']
    to8 = (lambda v: v >> 8) if d == 16 else (lambda v: (v * 255) // ((1 << d) - 1)) if d < 8 else (lambda v: v)
    h, w = c.shape[:2]
    if ct == 3:
        pal = np.frombuffer(s['palette'], dtype=np.uint8).astype(np.int64).reshape(-1, 3)
        rgb = pal[c[..., 0]]
        lut = np.full(256, 255, dtype=np.int64)
        if s['trns'] is not None:
            t = np.frombuffer(s['trns'], dtype=np.uint8).astype(np.int64)
            lut[: len(t)] = t
        a = lut[c[..., 0]]
    else:
        rgb = to8(np.repeat(c, 3, axis=-1) if c.shape[-1] == 1 else c)
        a = to8(s['alpha']) if s['alpha'] is not None else np.full((h, w), 255, dtype=np.int64)
        if s['trns'] is not None and ct in (0, 2):
            n = c.shape[-1]
            key = np.array([int.from_bytes(s['trns'][2 * k: 2 * k + 2], 'big') for k in range(n)])
            a = np.where((c == key).all(-1), 0, a)
    return np.concatenate([rgb, a[..., None]], -1)


def oriented(arr, o):
    """Samples (h, w, n) as an EXIF orientation shows them."""
    import numpy as np
    if o == 2: return arr[:, ::-1]
    if o == 3: return arr[::-1, ::-1]
    if o == 4: return arr[::-1]
    if o == 5: return arr.transpose(1, 0, 2)
    if o == 6: return arr.transpose(1, 0, 2)[:, ::-1]
    if o == 7: return arr.transpose(1, 0, 2)[::-1, ::-1]
    if o == 8: return arr.transpose(1, 0, 2)[::-1]
    return arr


def cmyk_reference(samples, w, h, pw, ph):
    """A one-page PDF holding CMYK samples (h, w, 4) uncompressed, as plain DeviceCMYK with no Decode array, drawn over
    the whole page: what a CMYK JPEG should look like once its inversion is undone."""
    import numpy as np
    data = np.asarray(samples, dtype=np.uint8).tobytes()
    content = f'q {pw} 0 0 {ph} 0 0 cm /Im0 Do Q'.encode()
    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw} {ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'.encode(),
        f'<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Length {len(data)} >>\nstream\n'.encode() + data + b'\nendstream',
        f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'\nendstream',
    ]
    out = b'%PDF-1.7\n'
    offs = []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += f'{i + 1} 0 obj\n'.encode() + o + b'\nendobj\n'
    x = len(out)
    out += f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010d} 00000 n \n'.encode() for o in offs)
    out += f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode()
    return out


def read_image_pdf_light(r, check, full, per_page):
    """For large results: qpdf's checks, each page's size and its picture's dictionary, and for a JPEG whether the stream
    is the file without its metadata (readers.py's own walk); no picture is decoded."""
    pages = []
    for i, page in enumerate(r.pages):
        img = list(page['/Resources']['/XObject'].values())[0].get_object()
        source = per_page[min(i, len(per_page) - 1)][0]
        info = {'source': os.path.basename(source), 'size': [round(float(x), 3) for x in page.mediabox[2:]],
                'image': {'width': int(img['/Width']), 'height': int(img['/Height']), 'bpc': int(img.get('/BitsPerComponent', 8)),
                          'filter': str(img.get('/Filter')), 'smask': '/SMask' in img}}
        if source.lower().endswith('.jpg'):
            info['jpegSame'] = img._data == jpeg_without_metadata(open(source, 'rb').read())[0]
        pages.append(info)
    return {'qpdf': check.returncode == 0 and 'No syntax or stream encoding errors' in check.stdout, 'qpdfDecode': full.returncode == 0,
            'qpdfOut': (check.stdout + check.stderr + full.stderr).strip()[-600:], 'pages': pages, 'pageCount': len(r.pages)}


def read_image_pdf(spec_path):
    """An Images to PDF result against its sources (a JSON spec: {pdf, sources: [path, ...]}, one page per source):
    qpdf's checks, each page's size, its drawing matrix and clip, and its picture decoded by this file's code and by
    PDFium, compared with the source decoded the same independent ways."""
    import hashlib
    import re
    import shutil
    import subprocess
    import tempfile
    import numpy as np
    import pypdf
    import pypdfium2
    from PIL import Image, ImageOps
    from PIL import ImageFile
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    spec = json.load(open(spec_path, encoding='utf-8'))
    path = spec['pdf']
    qpdf = shutil.which('qpdf') or 'C:/msys64/ucrt64/bin/qpdf.exe'
    check = subprocess.run([qpdf, '--check', path], capture_output=True, text=True)
    full = subprocess.run([qpdf, '--decode-level=all', '--object-streams=disable', path, os.path.join(tempfile.mkdtemp(prefix='pdf-'), 'all.pdf')], capture_output=True, text=True)
    r = pypdf.PdfReader(path)
    doc = pypdfium2.PdfDocument(path)
    pages = []
    # One page per picture, every page of a multi-page TIFF (its reduced images, such as thumbnails, left out).
    per_page = []
    for s in spec['sources']:
        frames = 1
        if s.lower().endswith(('.tif', '.tiff')):
            im = Image.open(s)
            frames = getattr(im, 'n_frames', 1)
        per_page += [(s, k) for k in range(frames)]
    if spec.get('light'):
        # Large results hold pictures past pypdf's own 75 MB stream limit, which it keeps against hostile files.
        import dataclasses
        from pypdf import _configuration as pc
        pc.CURRENT_CONFIGURATION.set(dataclasses.replace(pc.get_configuration(), maximum_declared_stream_length=4_000_000_000))
        r = pypdf.PdfReader(path)
        return read_image_pdf_light(r, check, full, per_page)
    for i, page in enumerate(r.pages):
        info = {'size': [round(float(x), 3) for x in page.mediabox[2:]]}
        content = page.get_contents().get_data().decode('latin-1')
        nums = r'(-?[\d.]+)'
        m = re.search(r'\s'.join([nums] * 6) + r'\s+cm', content)
        info['matrix'] = [round(float(x), 3) for x in m.groups()] if m else None
        c = re.search(r'\s'.join([nums] * 4) + r'\s+re\s+W\s+n', content)
        info['clip'] = [round(float(x), 3) for x in c.groups()] if c else None
        xobjs = page['/Resources']['/XObject']
        img = list(xobjs.values())[0].get_object()
        arr, facts = pdf_image(img)
        sm = img.get('/SMask')
        alpha = None
        if sm is not None:
            alpha, sfacts = pdf_image(sm.get_object())
            facts['smask'] = {'bpc': sfacts['bpc'], 'cs': sfacts['cs']}
        else:
            facts['smask'] = None
        raw = facts.pop('raw', None)
        info['image'] = facts
        source, frame = per_page[min(i, len(per_page) - 1)]
        info['source'] = os.path.basename(source)
        ext = os.path.splitext(source)[1].lower()
        upright = None  # the source as shown, 8-bit RGB, for the render
        if ext == '.png':
            s = png_source(source)
            want = s['color']
            if facts['bpc'] == 8 and s['depth'] < 8 and s['ct'] == 0:
                want = (want * 255 + ((1 << s['depth']) - 1) // 2) // ((1 << s['depth']) - 1)
            info['exact'] = bool(want.shape == arr.shape and (want == arr).all())
            if s['ct'] in (4, 6):
                a = s['alpha'][..., None]
                info['alphaExact'] = None if alpha is None else bool(a.shape == alpha.shape and (a == alpha).all())
                info['alphaOpaque'] = bool((s['alpha'] == (1 << s['depth']) - 1).all())
            elif s['ct'] == 3 and s['trns'] is not None:
                t = np.frombuffer(s['trns'], dtype=np.uint8).astype(np.int64)
                lut = np.full(256, 255, dtype=np.int64)
                lut[: len(t)] = t
                a = lut[s['color'][..., 0]][..., None]
                info['alphaExact'] = None if alpha is None else bool(a.shape == alpha.shape and (a == alpha).all())
            if 'palette' in facts:
                info['paletteExact'] = facts['palette'] == s['palette'][: len(facts['palette']) // 2].hex()
            upright = oriented(png_rgba8(s), s['orientation'])
        elif ext in ('.jpg', '.jpeg'):
            b = open(source, 'rb').read()
            expected, _ = jpeg_without_metadata(b)
            info['jpegSame'] = raw == expected if raw is not None else None
            info['metadataFree'] = raw is not None and not any(x in raw for x in (b'Exif', b'LeakyCam', b'Jane Example', b'http://ns.adobe.com/xap', b'Secret'))
            src = Image.open(source)
            src.draft(None, None)
            sarr = np.asarray(src).astype(np.int64)
            if sarr.ndim == 2:
                sarr = sarr[..., None]
            info['exact'] = bool(sarr.shape == arr.shape and (sarr == arr).all())
            upright = np.asarray(ImageOps.exif_transpose(Image.open(source)).convert('RGBA')).astype(np.int64)
            if sarr.shape[-1] == 4 and spec.get('pictureSize'):
                # CMYK: PDFium draws the page and a plain DeviceCMYK copy of Pillow's samples (which undo Adobe's
                # inversion); the two must look the same, so the Decode array the PDF gives is the right one.
                pw, ph = float(page.mediabox[2]), float(page.mediabox[3])
                ref = pypdfium2.PdfDocument(cmyk_reference(sarr, sarr.shape[1], sarr.shape[0], pw, ph))
                s = sarr.shape[1] / pw
                mine = np.asarray(doc[i].render(scale=s).to_pil().convert('RGB')).astype(np.int64)
                want = np.asarray(ref[0].render(scale=s).to_pil().convert('RGB')).astype(np.int64)
                d = abs(mine - want)
                info['cmykRender'] = {'mean': round(float(d.mean()), 3), 'max': int(d.max())}
                upright = None
        else:
            try:
                import pillow_heif
                pillow_heif.register_heif_opener()
            except Exception:
                pass
            im = Image.open(source)
            if frame:
                im.seek(frame)
            upright = np.asarray(ImageOps.exif_transpose(im).convert('RGBA')).astype(np.int64) if im.mode != 'I;16' else np.repeat(np.concatenate([(np.asarray(im).astype(np.int64) >> 8)[..., None]] * 3 + [np.full(im.size[::-1] + (1,), 255)], -1), 1, axis=-1)
            got = arr if arr.shape[-1] == 3 else np.repeat(arr, 3, axis=-1)
            if facts['bpc'] == 8 and got.shape[:2] == upright.shape[:2]:
                # Colors under fully transparent pixels do not show, and decoders differ there; compare the rest.
                seen = upright[..., 3] > 0
                info['diffMean'] = float(abs(got - upright[..., :3])[seen].mean()) if seen.any() else 0.0
        # PDFium renders the page at the picture's own resolution (one image pixel per render pixel when the page is the
        # picture's size), composited on white; compared with the source as shown, composited the same way.
        pw, ph = page.mediabox[2], page.mediabox[3]
        if upright is not None:
            scale = upright.shape[1] / float(pw) if spec.get('pictureSize') else 1
            bmp = np.asarray(doc[i].render(scale=scale).to_pil().convert('RGB')).astype(np.int64)
            a = upright[..., 3:4] / 255.0
            comp = np.round(upright[..., :3] * a + 255 * (1 - a)).astype(np.int64)
            # A page size in points can round the render a pixel short; compare what both cover.
            if spec.get('pictureSize') and abs(bmp.shape[0] - comp.shape[0]) <= 1 and abs(bmp.shape[1] - comp.shape[1]) <= 1:
                hh, ww = min(bmp.shape[0], comp.shape[0]), min(bmp.shape[1], comp.shape[1])
                d = abs(bmp[:hh, :ww] - comp[:hh, :ww])
                info['render'] = {'mean': round(float(d.mean()), 3), 'max': int(d.max())}
            info['renderShape'] = list(bmp.shape[:2])
        # PDFium's own decoding of the picture (its image object's bitmap, before any drawing).
        try:
            objs = [o for o in doc[i].get_objects() if o.type == pypdfium2.raw.FPDF_PAGEOBJ_IMAGE]
            if objs:
                pil = objs[0].get_bitmap(render=False).to_pil().convert('RGB')
                info['pdfiumImage'] = list(pil.size)
        except Exception as e:
            info['pdfiumImage'] = str(e)
        pages.append(info)
    return {'qpdf': check.returncode == 0 and 'No syntax or stream encoding errors' in check.stdout, 'qpdfDecode': full.returncode == 0,
            'qpdfOut': (check.stdout + check.stderr + full.stderr).strip()[-600:], 'pages': pages, 'pageCount': len(r.pages)}


def read_media(path):
    """The picture parts of a DOCX (word/media), by SHA-256, as zipfile reads them."""
    import hashlib
    import zipfile
    z = zipfile.ZipFile(path)
    return {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/')}


def render_compare(spec_path):
    """Pictures of PDF pages compared with PDFium's rendering of the same pages. The spec (JSON) lists
    {pdf, page, picture, dpi, transparent}; for each: both sizes, the mean difference in levels, the share of pixels
    off by more than 48 levels, the same two after both are reduced 4 times, how much of each is ink, the format and
    mode of the picture, and its alpha at the top left corner and at a point (when given)."""
    import numpy as np
    import pypdfium2 as pdfium
    from PIL import Image
    with open(spec_path, encoding='utf-8') as f:
        spec = json.load(f)
    docs = {}
    out = []
    for item in spec:
        if item['pdf'] not in docs:
            d = pdfium.PdfDocument(item['pdf'])
            d.init_forms()
            docs[item['pdf']] = d
        page = docs[item['pdf']][item['page'] - 1]
        transparent = item.get('transparent', False)
        ref = page.render(scale=item['dpi'] / 72, may_draw_forms=True, fill_color=(255, 255, 255, 0 if transparent else 255)).to_pil()
        got_raw = Image.open(item['picture'])
        got_raw.load()
        mode = 'RGBA' if transparent else 'RGB'
        ref = ref.convert(mode)
        got = got_raw.convert(mode)
        w, h = min(ref.width, got.width), min(ref.height, got.height)
        a = np.asarray(ref, dtype=np.int16)[:h, :w]
        b = np.asarray(got, dtype=np.int16)[:h, :w]
        if transparent:
            # A transparent pixel's color does not show: colors are compared as they would be drawn over something.
            a = np.concatenate([a[..., :3] * a[..., 3:] // 255, a[..., 3:]], axis=2)
            b = np.concatenate([b[..., :3] * b[..., 3:] // 255, b[..., 3:]], axis=2)
        d = np.abs(a - b)
        k = 4 if min(w, h) >= 16 else 1
        hh, ww = h // k * k, w // k * k

        def red(x):
            x = x[:hh, :ww].astype(np.float32)
            return x.reshape(hh // k, k, ww // k, k, x.shape[2]).mean(axis=(1, 3))

        rd = np.abs(red(a) - red(b))
        r = {
            'ref': [ref.width, ref.height], 'got': [got_raw.width, got_raw.height], 'format': got_raw.format, 'mode': got_raw.mode,
            'mean': round(float(d.mean()), 3), 'off48': round(float((d.max(axis=2) > 48).mean()), 5),
            'mean4': round(float(rd.mean()), 3), 'off4_32': round(float((rd.max(axis=2) > 32).mean()), 5),
            'inkRef': round(float((a[..., :3].min(axis=2) < 200).mean()), 4), 'inkGot': round(float((b[..., :3].min(axis=2) < 200).mean()), 4),
        }
        if got_raw.mode in ('RGBA', 'LA'):
            alpha = np.asarray(got_raw.convert('RGBA'))[..., 3]
            r['alphaCorner'] = int(alpha[2, 2])
            if 'point' in item:
                x, y = item['point']
                r['alphaAt'] = int(alpha[y, x])
        if got_raw.format == 'JPEG':
            r['cornerRgb'] = [int(v) for v in np.asarray(got_raw.convert('RGB'))[2, 2]]
        out.append(r)
    return out


def jpeg_segments(b):
    """The markers of a JPEG's header and scans, and whether data follows its end (its own walk)."""
    if b[:2] != b'\xff\xd8':
        return {'markers': [], 'trailing': -1}
    p, marks = 2, []
    while p + 1 < len(b):
        if b[p] != 0xFF:
            return {'markers': marks, 'trailing': -1}
        m = b[p + 1]
        if m == 0xFF:
            p += 1
            continue
        if m == 0xD9:
            return {'markers': marks + ['D9'], 'trailing': len(b) - p - 2}
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            p += 2
            continue
        n = (b[p + 2] << 8) | b[p + 3]
        name = '%02X' % m
        if 0xE0 <= m <= 0xEF:
            name += ':' + b[p + 4:p + 4 + 12].split(b'\0')[0].decode('latin1', 'replace')
        marks.append(name)
        q = p + 2 + n
        if m == 0xDA:
            while q + 1 < len(b):
                if b[q] == 0xFF and b[q + 1] not in (0x00, 0xFF) and not (0xD0 <= b[q + 1] <= 0xD7):
                    break
                q += 1
        p = q
    return {'markers': marks, 'trailing': -1}


def read_pdf_meta(path):
    """What a PDF holds of metadata, read with qpdf (every stream decoded, object streams undone), pypdf and PDFium:
    the marker words found anywhere in its decoded bytes, its document information and XMP, its trailer identifier,
    the segments of each JPEG picture and its decoded pixels, what stays (comments, bookmarks, links, form values,
    attachments), qpdf's check and a hash of each page as PDFium draws it."""
    import hashlib
    import re
    import subprocess
    import pypdf
    import pypdfium2 as pdfium
    from PIL import Image
    check = subprocess.run(['qpdf', '--check', path], capture_output=True, text=True)
    # Marker words anywhere: qpdf's view with general filters undone (JPEG data left as it is, so its segments can be
    # read), the file's own bytes (an older version, objects nothing uses), and every stream in them that inflates.
    import zlib
    qdf = subprocess.run(['qpdf', '--qdf', '--object-streams=disable', '--decode-level=generalized', path, '-'], capture_output=True)
    raw = qdf.stdout
    whole = open(path, 'rb').read()
    texts = [raw, whole]
    for m in re.finditer(rb'stream\r?\n', whole):
        try:
            texts.append(zlib.decompressobj().decompress(whole[m.end():m.end() + (64 << 20)]))
        except zlib.error:
            pass
    pat = re.compile(rb'(?:MARK|KEEP)-[A-Z-]+-?\d*')
    words = sorted(set(w.decode() for t in texts for w in pat.findall(t)))
    r = pypdf.PdfReader(path)
    info = r.trailer.get('/Info')
    info = {str(k): str(v) for k, v in info.get_object().items()} if info is not None else None
    root = r.trailer['/Root'].get_object()
    file_id = [bytes(x.original_bytes if hasattr(x, 'original_bytes') else x).hex().upper() for x in r.trailer['/ID']] if '/ID' in r.trailer else None
    jpegs = []
    for page in r.pages:
        xo = page['/Resources'].get('/XObject', {})
        for k in xo:
            o = xo[k].get_object()
            if o.get('/Filter') == '/DCTDecode':
                data = o._data
                seg = jpeg_segments(data)
                img = Image.open(io.BytesIO(data))
                img.load()
                seg['pixels'] = hashlib.sha256(img.convert('RGB').tobytes()).hexdigest()
                seg['size'] = len(data)
                jpegs.append(seg)
    annots = []
    for page in r.pages:
        for a in page.get('/Annots', []) or []:
            a = a.get_object()
            annots.append({'subtype': str(a.get('/Subtype')), 'author': str(a['/T']) if '/T' in a else None, 'contents': str(a['/Contents']) if '/Contents' in a else None})
    outline = [str(o.title) for o in r.outline if not isinstance(o, list)]
    fields = {k: str(v.get('/V')) for k, v in (r.get_fields() or {}).items()}
    attachments = sorted(r.attachments.keys())
    pdf = pdfium.PdfDocument(path)
    pdf.init_forms()
    renders = [hashlib.sha256(pdf[i].render(scale=1, may_draw_forms=True).to_pil().convert('RGB').tobytes()).hexdigest() for i in range(len(pdf))]
    return {
        'qpdf': {'ok': check.returncode == 0 and 'No syntax or stream encoding errors' in check.stdout, 'out': (check.stdout + check.stderr)[-400:]},
        'words': words, 'info': info, 'xmp': '/Metadata' in root, 'id': file_id, 'catalog': sorted(str(k) for k in root.keys()),
        'jpegs': jpegs, 'annots': annots, 'outline': outline, 'fields': fields, 'attachments': attachments, 'renders': renders,
        'pieceInfo': raw.count(b'/PieceInfo'), 'lastModified': raw.count(b'/LastModified'), 'thumb': raw.count(b'/Thumb'), 'metadataKeys': raw.count(b'/Metadata'),
        'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(),
    }


kind, path = sys.argv[1], sys.argv[2]
sys.stdout.reconfigure(encoding='utf-8')
if kind == 'csv':
    result = read_csv(path, ',')
elif kind == 'tsv':
    result = read_csv(path, '\t')
elif kind == 'json':
    with open(path, encoding='utf-8') as f:
        result = json.load(f)
elif kind == 'jsonl':
    with open(path, encoding='utf-8') as f:
        text = f.read()
    assert text.endswith('\n'), 'JSON Lines must end with a line break'
    result = [json.loads(line) for line in text.split('\n')[:-1]]
elif kind == 'xlsx':
    result = read_xlsx(path)
elif kind == 'docx':
    result = read_docx(path)
elif kind == 'md':
    result = read_md(path)
elif kind == 'mdzip':
    result = read_mdzip(path)
elif kind == 'media':
    result = read_media(path)
elif kind == 'pdf':
    result = read_pdf(path)
elif kind == 'pdfdeep':
    result = read_pdf_deep(path)
elif kind == 'pdfturns':
    result = read_pdf_turns(path)
elif kind == 'pdforder':
    result = read_pdf_order(path)
elif kind == 'imagepdf':
    result = read_image_pdf(path)
elif kind == 'render':
    result = render_compare(path)
elif kind == 'pdfmeta':
    result = read_pdf_meta(path)
else:
    sys.exit('unknown kind ' + kind)
print(json.dumps(result, ensure_ascii=False))
