"""Independent readers for FileConvert's document and data results, used by the browser tests.

    python -I readers.py <kind> <path>

Prints JSON. csv and tsv use Python's csv module; json and jsonl the json module; xlsx openpyxl (formulas and their
saved results, number formats, merged cells, sheet states); docx python-docx (paragraph styles, list levels, run
formatting, links, tables and pictures); md mistune (CommonMark with GFM tables); mdzip zipfile, mistune and Pillow
(a Markdown ZIP, extracted and its picture links followed); media zipfile (a DOCX's pictures); pdf qpdf, pypdf,
Xpdf pdftotext and PDFium (a PDF's structure, text and rendered pages); pdfdeep qpdf, pypdf and PDFium (what a
merge keeps: bookmarks, links, named destinations, form fields, layers, page boxes, renders). None of them shares
code with the browser engines.
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


def read_media(path):
    """The picture parts of a DOCX (word/media), by SHA-256, as zipfile reads them."""
    import hashlib
    import zipfile
    z = zipfile.ZipFile(path)
    return {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/')}


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
else:
    sys.exit('unknown kind ' + kind)
print(json.dumps(result, ensure_ascii=False))
