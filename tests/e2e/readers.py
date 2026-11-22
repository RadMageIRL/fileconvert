"""Independent readers for FileConvert's document and data results, used by the browser tests.

    python -I readers.py <kind> <path>

Prints JSON. csv and tsv use Python's csv module; json and jsonl the json module; xlsx openpyxl (formulas and their
saved results, number formats, merged cells, sheet states); docx python-docx (paragraph styles, list levels, run
formatting, links, tables and pictures); md mistune (CommonMark with GFM tables). None of them shares code with the
browser engines.
"""

import csv
import datetime
import io
import json
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
else:
    sys.exit('unknown kind ' + kind)
print(json.dumps(result, ensure_ascii=False))
