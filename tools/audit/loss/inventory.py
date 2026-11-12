#!/usr/bin/env python3
"""완전성 오라클 3단계: 파일 구조(ZIP 부품·XML, OLE 스트림·레코드, PDF 객체)를 직접 읽어 '들어 있는 것' 목록을 만든다.

사용법:
  python3 -I inventory.py <목록> <inv 폴더> [--ref <ref 폴더>]
  목록: capture.mjs와 같은 형식. --ref 를 주면 옛 형식(doc·xls·ppt)은 reftext.py가 만든 conv.docx·xlsx·pptx로 구조를 읽는다.

결과: <inv>/<id>.json
  { id, file, fmt, via, objects: {분류: {count, samples[], chars}}, units: [{cat, text, where}], meta, error }
  objects: 화면에 보여야 하거나 알려야 하는 '물건'의 수(차트·도형·메모·각주·숨긴 시트 …)
  units:   글자 단위(문단·칸·슬라이드 글 상자 …)와 그 분류. compare.py가 뷰어 화면 글자와 맞춰 본다.
분류 이름은 compare.py의 CATEGORY 표와 같다.
"""
import hashlib, io, json, os, re, struct, sys, zipfile, zlib
from collections import defaultdict

PYLIB = os.environ.get('PYLIB') or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'pylib')
sys.path.insert(0, PYLIB)
from lxml import etree  # noqa: E402

PARSER = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True, recover=True, remove_comments=True)
IMG_OK = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'}  # 뷰어(엑셀 그림)가 보여주는 형식
BROWSER_OK = IMG_OK | {'svg', 'ico', 'avif'}       # 브라우저가 그릴 수 있는 형식
MAX_ROWS, MAX_COLS = 3000, 200


def file_id(path):
    base = f"{os.path.basename(os.path.dirname(path))}__{os.path.basename(path)}"
    base = re.sub(r'[^\w.\-가-힣]+', '_', base, flags=re.ASCII)
    return f"{base}.{hashlib.sha1(path.encode('utf-8')).hexdigest()[:6]}"


def ln(el):
    t = el.tag
    return t.rsplit('}', 1)[-1] if isinstance(t, str) else ''


def attr(el, local):
    for k, v in el.attrib.items():
        if k.rsplit('}', 1)[-1] == local:
            return v
    return None


def rid_attr(el, local):
    """r:id / r:embed 같은 관계 속성(네임스페이스 무관)."""
    for k, v in el.attrib.items():
        if k.rsplit('}', 1)[-1] == local and k.startswith('{') and 'relationships' in k:
            return v
    return None


def clean(s):
    return str(s).encode('utf-8', 'replace').decode('utf-8')


class Inv:
    def __init__(self):
        self.objects = defaultdict(lambda: {'count': 0, 'samples': [], 'chars': 0})
        self.units = []
        self.meta = {}

    def obj(self, cat, n=1, sample=None):
        sample = clean(sample) if sample else sample
        o = self.objects[cat]
        o['count'] += n
        if sample:
            s = re.sub(r'\s+', ' ', sample).strip()
            o['chars'] += len(s)
            if s and len(o['samples']) < 6 and s not in o['samples']:
                o['samples'].append(s[:160])

    def unit(self, cat, text, where=''):
        text = clean(text)
        t = re.sub(r'[ \t\r\f\v]+', ' ', text or '').strip()
        if t:
            self.units.append({'cat': cat, 'text': t[:4000], 'where': where})

    def dump(self):
        return {'objects': dict(self.objects), 'units': self.units, 'meta': self.meta}


# ---------------------------------------------------------------- ZIP 공통
class Pkg:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.names = {n.lower(): n for n in self.z.namelist()}

    def has(self, name):
        return name.lower() in self.names

    def read(self, name, limit=300_000_000):
        n = self.names.get(name.lower())
        if not n:
            return None
        info = self.z.getinfo(n)
        if info.file_size > limit:
            return None
        return self.z.read(n)

    def xml(self, name):
        b = self.read(name)
        if b is None:
            return None
        try:
            return etree.fromstring(b, PARSER)
        except Exception:
            return None

    def rels(self, part):
        d, f = os.path.split(part)
        r = self.xml(f'{d}/_rels/{f}.rels' if d else f'_rels/{f}.rels')
        out = {}
        if r is None:
            return out
        for el in r:
            if ln(el) != 'Relationship':
                continue
            tgt = el.get('Target') or ''
            mode = el.get('TargetMode')
            if mode != 'External':
                tgt = norm_path(d, tgt)
            out[el.get('Id')] = {'target': tgt, 'type': (el.get('Type') or '').rsplit('/', 1)[-1], 'external': mode == 'External'}
        return out

    def list(self, prefix):
        return [n for low, n in self.names.items() if low.startswith(prefix.lower())]


def norm_path(base, target):
    if target.startswith('/'):
        p = target[1:]
    else:
        p = os.path.normpath(os.path.join(base, target)).replace('\\', '/')
    return p


def ext_of(name):
    m = re.search(r'\.([A-Za-z0-9]+)$', name or '')
    return m.group(1).lower() if m else ''


def iter_no_fallback(root):
    """mc:Fallback(대체 표현) 밑은 건너뛰며 순회한다(같은 내용이 두 번 세지지 않게)."""
    stack = [root]
    while stack:
        el = stack.pop()
        yield el
        kids = [c for c in el if ln(c) != 'Fallback']
        stack.extend(reversed(kids))


def text_of(el, tags=('t',), skip=('Fallback', 'rPh', 'instrText', 'delText')):
    out = []

    def walk(e):
        for c in e:
            n = ln(c)
            if n in skip:
                continue
            if n in tags and c.text:
                out.append(c.text)
            elif n in ('tab',):
                out.append('\t')
            elif n in ('br', 'cr'):
                out.append('\n')
            walk(c)
    walk(el)
    return ''.join(out)


def chart_texts(pkg, part):
    """차트 부품에서 제목·계열 이름·항목 이름을 꺼낸다."""
    x = pkg.xml(part)
    if x is None:
        return [], 'chart'
    kind = 'chartex' if ln(x) == 'chartSpace' and 'chartex' in (x.tag or '') else 'chart'
    texts = []
    for el in x.iter():
        n = ln(el)
        if n == 'title':
            t = text_of(el, tags=('t', 'v'))
            if t.strip():
                texts.append(t)
        elif n == 'tx' and ln(el.getparent()) == 'ser':
            t = text_of(el, tags=('v', 't'))
            if t.strip():
                texts.append(t)
        elif n == 'cat':
            for v in el.iter():
                if ln(v) == 'v' and v.text and not re.fullmatch(r'[-+.\dEe]+', v.text.strip()):
                    texts.append(v.text)
    seen, uniq = set(), []
    for t in texts:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    types = sorted({ln(el) for el in x.iter() if ln(el).endswith('Chart') and ln(el) not in ('plotArea',)})
    return uniq[:60], kind + (':' + ','.join(types) if types else '')


def diagram_texts(pkg, part):
    x = pkg.xml(part)
    if x is None:
        return []
    out = []
    for pt in x.iter():
        if ln(pt) != 'pt' or pt.get('type') in ('parTrans', 'sibTrans', 'pres'):
            continue
        for t in pt:
            if ln(t) == 't':
                s = text_of(t)
                if s.strip():
                    out.append(s)
    return out


# ---------------------------------------------------------------- Word (docx)
def inv_docx(path, inv):
    pkg = Pkg(path)
    ct = pkg.xml('[Content_Types].xml')
    main = 'word/document.xml'
    if ct is not None:
        for o in ct:
            if ln(o) == 'Override' and re.search(r'(document|template)\.main', o.get('ContentType') or ''):
                main = o.get('PartName', '/word/document.xml').lstrip('/')
    rels = pkg.rels(main)
    doc = pkg.xml(main)
    if doc is None:
        raise ValueError('document.xml 없음')
    inv.meta['parts'] = sorted(n for n in pkg.names if n.startswith('word/'))[:80]

    def walk_story(root, part, cat, where):
        prels = pkg.rels(part)
        # 문단 단위 글자(본문/글상자/수식/숨김/삭제를 나눈다)
        for p in root.iter():
            if ln(p) != 'p':
                continue
            # 이 문단이 글상자 안인지, Fallback 안인지
            anc = p.getparent()
            in_txbx = in_fb = False
            while anc is not None:
                n = ln(anc)
                if n == 'txbxContent':
                    in_txbx = True
                if n == 'Fallback':
                    in_fb = True
                anc = anc.getparent()
            if in_fb:
                continue
            body, hidden, deleted, eq = [], [], [], []

            def walk(e, vanish=False):
                for c in e:
                    n = ln(c)
                    if n in ('txbxContent', 'Fallback', 'p'):
                        continue  # 글상자·대체 표현·안쪽 문단은 따로 센다
                    if n == 'r':
                        rpr = next((x for x in c if ln(x) == 'rPr'), None)
                        v = vanish
                        if rpr is not None:
                            for x in rpr:
                                if ln(x) in ('vanish', 'specVanish') and attr(x, 'val') not in ('0', 'false', 'off'):
                                    v = True
                        walk(c, v)
                        continue
                    if n in ('oMath', 'oMathPara'):
                        eq.append(text_of(c, tags=('t',)))
                        inv.obj('w.equation', 1, eq[-1])
                        continue
                    if n == 't' and c.text:
                        (hidden if vanish else body).append(c.text)
                    elif n == 'delText' and c.text:
                        deleted.append(c.text)
                    elif n == 'tab' and ln(e) == 'r':
                        (hidden if vanish else body).append('\t')
                    elif n in ('br', 'cr'):
                        body.append('\n')
                    elif n == 'sym':
                        body.append('?')
                    if len(c):
                        walk(c, vanish)
            walk(p)
            t = ''.join(body)
            unit_cat = 'w.textbox' if in_txbx else cat
            if t.strip():
                inv.unit(unit_cat, t, where)
                if in_txbx:
                    inv.obj('w.textbox_para', 1, t)
            if hidden and ''.join(hidden).strip():
                inv.unit('w.hidden_text', ''.join(hidden), where)
                inv.obj('w.hidden_text', 1, ''.join(hidden))
            if deleted and ''.join(deleted).strip():
                inv.unit('w.deleted', ''.join(deleted), where)
            for e in eq:
                if e.strip():
                    inv.unit('w.equation', e, where)
        # 물건들
        for el in iter_no_fallback(root):
            n = ln(el)
            if n == 'txbxContent':
                inv.obj('w.textbox', 1, text_of(el))
            elif n == 'ins':
                inv.obj('w.tracked_ins', 1, text_of(el))
            elif n == 'del':
                inv.obj('w.tracked_del', 1, text_of(el, tags=('delText',), skip=('Fallback',)))
            elif n in ('moveFrom', 'moveTo'):
                inv.obj('w.tracked_move', 1)
            elif n == 'altChunk':
                r = prels.get(rid_attr(el, 'id'), {})
                inv.obj('w.altchunk', 1, r.get('target'))
            elif n == 'object' or n == 'OLEObject':
                if n == 'OLEObject':
                    inv.obj('w.ole', 1, el.get('ProgID'))
            elif n == 'graphicData':
                uri = el.get('uri') or ''
                if uri.endswith('/chart') or 'chartex' in uri or uri.endswith('/chartEx'):
                    for c in el.iter():
                        rid = rid_attr(c, 'id')
                        if rid and ln(c) == 'chart':
                            r = prels.get(rid)
                            texts, kind = chart_texts(pkg, r['target']) if r else ([], 'chart')
                            inv.obj('w.chart', 1, kind + ' ' + ' / '.join(texts[:3]))
                            for t in texts:
                                inv.unit('w.chart', t, where)
                elif uri.endswith('/diagram'):
                    rel = next((c for c in el.iter() if ln(c) == 'relIds'), None)
                    dm = rel is not None and prels.get(rid_attr(rel, 'dm'))
                    texts = diagram_texts(pkg, dm['target']) if dm else []
                    inv.obj('w.smartart', 1, ' / '.join(texts[:4]))
                    for t in texts:
                        inv.unit('w.smartart', t, where)
                elif 'wordprocessingCanvas' in uri:
                    inv.obj('w.canvas', 1)
                elif 'wordprocessingGroup' in uri:
                    inv.obj('w.group', 1)
                elif 'ink' in uri.lower():
                    inv.obj('w.ink', 1)
            elif n == 'blip':
                rid = rid_attr(el, 'embed') or rid_attr(el, 'link')
                r = prels.get(rid)
                if r:
                    e = ext_of(r['target'])
                    inv.obj('w.pic_ok' if e in BROWSER_OK else 'w.pic_unsupported', 1, f'{e}:{os.path.basename(r["target"])}' + (' (외부 연결)' if r['external'] else ''))
                    if r['external']:
                        inv.obj('w.pic_external', 1, r['target'])
            elif n == 'imagedata':
                rid = rid_attr(el, 'id') or rid_attr(el, 'pict')
                r = prels.get(rid)
                if r:
                    e = ext_of(r['target'])
                    inv.obj('w.vml_pic_ok' if e in BROWSER_OK else 'w.vml_pic_unsupported', 1, f'{e}:{os.path.basename(r["target"])}')
            elif n == 'textpath':
                s = el.get('string')
                if s:
                    inv.obj('w.watermark', 1, s)
                    inv.unit('w.watermark', s, where)
            elif n == 'ffData':
                kind = next((ln(c) for c in el if ln(c) in ('checkBox', 'ddList', 'textInput')), 'ff')
                inv.obj('w.formfield_' + kind, 1)
            elif n == 'checkbox' and 'w14' in (el.tag or ''):
                inv.obj('w.sdt_checkbox', 1)
            elif n == 'hyperlink':
                inv.obj('w.hyperlink', 1)
            elif n == 'fldSimple' or n == 'instrText':
                instr = (attr(el, 'instr') if n == 'fldSimple' else el.text) or ''
                k = (instr.strip().split() or [''])[0].upper()
                if k in ('TOC', 'REF', 'PAGEREF', 'SEQ', 'DATE', 'MERGEFIELD', 'INCLUDEPICTURE', 'INCLUDETEXT', 'EMBED', 'LINK', 'FORMTEXT', 'FORMCHECKBOX', 'FORMDROPDOWN', 'DOCPROPERTY', 'IF', 'QUOTE', 'AUTOTEXT'):
                    inv.obj('w.field_' + k, 1)

    walk_story(doc, main, 'w.body', 'body')
    for rid, r in rels.items():
        t = r['type']
        if t in ('header', 'footer') and pkg.has(r['target']):
            x = pkg.xml(r['target'])
            if x is not None:
                inv.obj('w.' + t, 1, text_of(x))
                walk_story(x, r['target'], 'w.' + t, t)
        elif t in ('footnotes', 'endnotes', 'comments'):
            x = pkg.xml(r['target'])
            if x is None:
                continue
            key = {'footnotes': 'footnote', 'endnotes': 'endnote', 'comments': 'comment'}[t]
            for note in x:
                if ln(note) not in ('footnote', 'endnote', 'comment'):
                    continue
                if attr(note, 'type') in ('separator', 'continuationSeparator', 'continuationNotice'):
                    continue
                txt = text_of(note)
                if key == 'comment':
                    who = attr(note, 'author') or ''
                    inv.obj('w.comment', 1, f'{who}: {txt}')
                else:
                    inv.obj('w.' + key, 1, txt)
                walk_story(note, r['target'], 'w.' + key, key)
        elif t == 'glossaryDocument':
            inv.obj('w.glossary', 1)
    for n in pkg.names:
        if n.startswith('word/embeddings/'):
            inv.obj('w.embedding', 1, os.path.basename(n))
        elif n.startswith('word/media/') and ext_of(n) in ('mp4', 'avi', 'wmv', 'mov', 'mp3', 'wav', 'wma', 'm4a'):
            inv.obj('w.media', 1, os.path.basename(n))
    if pkg.has('word/commentsExtended.xml') or pkg.has('word/commentsIds.xml'):
        inv.meta['modernComments'] = True
    # 문서 보호·형식 표시
    st = pkg.xml('word/settings.xml')
    if st is not None:
        for el in st:
            if ln(el) == 'documentProtection':
                inv.meta['protection'] = attr(el, 'edit')
            if ln(el) == 'trackRevisions':
                inv.meta['trackRevisions'] = True


# ---------------------------------------------------------------- Excel (xlsx)
def col_index(ref):
    m = re.match(r'([A-Z]+)(\d+)', ref or '')
    if not m:
        return 0, 0
    c = 0
    for ch in m.group(1):
        c = c * 26 + ord(ch) - 64
    return int(m.group(2)) - 1, c - 1


def inv_xlsx(path, inv):
    pkg = Pkg(path)
    wb_part = 'xl/workbook.xml'
    for n in pkg.names:
        if re.fullmatch(r'xl/workbook\d*\.xml', n):
            wb_part = pkg.names[n]
    wb = pkg.xml(wb_part)
    if wb is None:
        raise ValueError('workbook.xml 없음')
    wrels = pkg.rels(wb_part)
    sst = []
    sx = None
    for rid, r in wrels.items():
        if r['type'] == 'sharedStrings':
            sx = pkg.xml(r['target'])
    if sx is not None:
        for si in sx:
            if ln(si) == 'si':
                sst.append(text_of(si))
    sheets = []
    for el in wb.iter():
        if ln(el) == 'sheet':
            sheets.append({'name': el.get('name'), 'state': el.get('state') or 'visible', 'rid': rid_attr(el, 'id')})
        elif ln(el) == 'definedName':
            if (el.get('name') or '').startswith('_xlnm'):
                continue
            inv.obj('xl.defined_name', 1)
        elif ln(el) == 'externalReference':
            inv.obj('xl.external_link', 1)
        elif ln(el) == 'pivotCache':
            inv.obj('xl.pivot_cache', 1)
    inv.meta['sheets'] = [(s['name'], s['state']) for s in sheets]
    for si, s in enumerate(sheets):
        r = wrels.get(s['rid'])
        if not r:
            continue
        hidden = s['state'] != 'visible'
        if r['type'] == 'chartsheet':
            inv.obj('xl.chartsheet', 1, s['name'])
            x = pkg.xml(r['target'])
            srels = pkg.rels(r['target'])
            for dr in srels.values():
                if dr['type'] == 'drawing':
                    xdraw(pkg, dr['target'], inv, s['name'], hidden, chartsheet=True)
            continue
        if r['type'] != 'worksheet':
            inv.obj('xl.other_sheet_' + r['type'], 1, s['name'])
            continue
        part = r['target']
        srels = pkg.rels(part)
        data = pkg.read(part)
        if data is None:
            continue
        cat = 'xl.hidden_sheet' if hidden else 'xl.cell'
        cells = strings = 0
        rows_hidden = 0
        beyond = 0
        min_r = None
        hf = []
        dv_lists = 0
        cf = 0
        hl = 0
        merges = 0
        sparks = 0
        ctx = etree.iterparse(io.BytesIO(data), events=('end',), huge_tree=True, recover=True, resolve_entities=False, no_network=True)
        cols_hidden = 0
        dim = None
        out_dim = []
        for _, el in ctx:
            n = ln(el)
            if n == 'dimension' and el.get('ref'):
                parts = el.get('ref').split(':')
                a, b = col_index(parts[0]), col_index(parts[-1])
                dim = (a[0], a[1], b[0], b[1])
            if n == 'c':
                ref = el.get('r')
                t = el.get('t')
                v = next((c for c in el if ln(c) == 'v'), None)
                isel = next((c for c in el if ln(c) == 'is'), None)
                txt = None
                if t == 's' and v is not None and v.text and v.text.strip().isdigit():
                    i = int(v.text)
                    txt = sst[i] if i < len(sst) else None
                elif t == 'inlineStr' and isel is not None:
                    txt = text_of(isel)
                elif t == 'str' and v is not None:
                    txt = v.text
                elif t == 'e' and v is not None:
                    txt = v.text
                if v is not None or isel is not None:
                    cells += 1
                    rr, cc = col_index(ref) if ref else (0, 0)
                    if min_r is None or rr < min_r:
                        min_r = rr
                    if dim and (rr > dim[2] or cc > dim[3]) and (dim[2] or dim[3]):
                        vv = txt if txt is not None else (v.text if v is not None else '')
                        out_dim.append(f'{ref}={vv}')
                    if txt and txt.strip():
                        strings += 1
                        start = 0 if (min_r or 0) <= 200 else min_r
                        out = rr - start >= MAX_ROWS or cc >= MAX_COLS
                        if out and not hidden:
                            beyond += 1
                            inv.unit('xl.beyond_limit', txt, f'{s["name"]}!{ref}')
                        else:
                            inv.unit(cat, txt, f'{s["name"]}!{ref}')
                el.clear()
            elif n == 'row':
                if el.get('hidden') in ('1', 'true'):
                    rows_hidden += 1
                el.clear()
            elif n == 'col':
                if el.get('hidden') in ('1', 'true'):
                    cols_hidden += int(el.get('max', 0)) - int(el.get('min', 0)) + 1
            elif n in ('oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter'):
                if el.text:
                    t = re.sub(r'&(?:"[^"]*"|\d+|[LCRPNDTAZFGBIUSXYKE])', ' ', el.text)
                    if t.strip():
                        hf.append(t)
            elif n == 'dataValidation':
                if el.get('type') == 'list':
                    dv_lists += 1
            elif n == 'conditionalFormatting':
                cf += 1
            elif n == 'hyperlink':
                hl += 1
            elif n == 'mergeCell':
                merges += 1
            elif n == 'sparkline':
                sparks += 1
            elif n == 'sheetProtection':
                inv.meta.setdefault('protectedSheets', []).append(s['name'])
        if out_dim and not hidden:
            # <dimension>(시트 크기 표시)이 실제 칸보다 작다: 일부 프로그램이 만든 파일. 엔진이 이 크기만 읽으면 칸이 잘린다.
            inv.obj('xl.outside_dimension', len(out_dim), f'{s["name"]}: dimension {":".join(map(str, dim))} 밖 ' + ', '.join(out_dim[:4]))
            for o in out_dim:
                inv.unit('xl.outside_dimension', o.split('=', 1)[1], f'{s["name"]}!{o.split("=")[0]}')
        if hidden:
            inv.obj('xl.hidden_sheet', 1, f'{s["name"]} ({s["state"]}, 칸 {cells}개)')
        if rows_hidden:
            inv.obj('xl.hidden_rows', rows_hidden, s['name'])
        if cols_hidden:
            inv.obj('xl.hidden_cols', cols_hidden, s['name'])
        if beyond:
            inv.obj('xl.beyond_limit', beyond, s['name'])
        for t in hf:
            inv.obj('xl.header_footer', 1, t)
            inv.unit('xl.header_footer', t, s['name'])
        if dv_lists:
            inv.obj('xl.dv_list', dv_lists, s['name'])
        if cf:
            inv.obj('xl.cond_format', cf, s['name'])
        if hl:
            inv.obj('xl.hyperlink', hl, s['name'])
        if sparks:
            inv.obj('xl.sparkline', sparks, s['name'])
        inv.meta.setdefault('sheetCells', {})[s['name']] = cells
        for rid, dr in srels.items():
            t = dr['type']
            if t == 'drawing':
                xdraw(pkg, dr['target'], inv, s['name'], hidden, empty_sheet=(cells == 0))
            elif t == 'comments':
                cx = pkg.xml(dr['target'])
                if cx is not None:
                    for cm in cx.iter():
                        if ln(cm) == 'comment':
                            txt = text_of(cm)
                            inv.obj('xl.comment', 1, f'{cm.get("ref")}: {txt}')
                            inv.unit('xl.comment', txt, f'{s["name"]}!{cm.get("ref")}')
            elif t == 'threadedComment':
                cx = pkg.xml(dr['target'])
                if cx is not None:
                    for cm in cx.iter():
                        if ln(cm) == 'threadedComment':
                            txt = text_of(cm, tags=('text',))
                            inv.obj('xl.threaded_comment', 1, f'{cm.get("ref")}: {txt}')
            elif t == 'vmlDrawing':
                vx = pkg.read(dr['target']) or b''
                # 메모가 아닌 VML 도형(옛 글상자·양식 컨트롤)
                for m in re.finditer(rb'<x:ClientData\s+ObjectType="(\w+)"', vx):
                    k = m.group(1).decode()
                    if k != 'Note':
                        inv.obj('xl.vml_' + k.lower(), 1)
            elif t == 'table':
                inv.obj('xl.table', 1)
            elif t == 'pivotTable':
                inv.obj('xl.pivot_table', 1, s['name'])
            elif t in ('oleObject', 'package'):
                inv.obj('xl.ole', 1, os.path.basename(dr['target']))
            elif t == 'ctrlProp':
                inv.obj('xl.form_control', 1, s['name'])
            elif t == 'slicer':
                inv.obj('xl.slicer', 1)
            elif t == 'image':  # 시트 배경 그림
                inv.obj('xl.background_image', 1, os.path.basename(dr['target']))
    for n in pkg.names:
        if n.startswith('xl/embeddings/'):
            inv.obj('xl.embedding', 1, os.path.basename(n))
        if n.startswith('xl/richdata/'):
            inv.obj('xl.richdata_part', 1, os.path.basename(n))  # 칸 안 그림(IMAGE 함수·Place in cell)
    if any(n.startswith('xl/media/') for n in pkg.names):
        inv.meta['media'] = sorted(os.path.basename(n) for n in pkg.names if n.startswith('xl/media/'))[:40]
    if pkg.has('xl/vbaProject.bin'):
        inv.obj('xl.macro', 1)


def xdraw(pkg, part, inv, sheet, hidden, chartsheet=False, empty_sheet=False):
    x = pkg.xml(part)
    if x is None:
        return
    rels = pkg.rels(part)
    pre = 'xl.hidden_sheet_' if hidden else 'xl.'
    per = inv.meta.setdefault('sheetObjects', {}).setdefault(sheet, {})
    orig_obj = inv.obj

    def counted(cat, n=1, sample=None):
        per[cat] = per.get(cat, 0) + n
        orig_obj(cat, n, sample)
    inv.obj = counted
    try:
        _xdraw_body(pkg, x, rels, inv, sheet, hidden, chartsheet, empty_sheet, pre)
    finally:
        inv.obj = orig_obj


def _xdraw_body(pkg, x, rels, inv, sheet, hidden, chartsheet, empty_sheet, pre):

    def visit(el, anchor_kind, in_group, first_blip):
        """first_blip: 이 앵커에서 뷰어가 쓰는 첫 그림인지(뷰어는 앵커마다 첫 blip만 쓴다)."""
        n = ln(el)
        if n == 'AlternateContent':
            ch = next((c for c in el if ln(c) == 'Choice'), None)
            req = ch.get('Requires') if ch is not None else ''
            if ch is not None and ('x14' in (req or '') or 'a14' in (req or '')) and any(ln(c) == 'sp' and any(ln(d) == 'nvSpPr' for d in c) for c in ch.iter()):
                # 양식 컨트롤(확인란·단추 등)
                for c in ch.iter():
                    if ln(c) == 'cNvPr' and c.get('name'):
                        pass
            for c in (ch if ch is not None else []):
                first_blip = visit(c, anchor_kind, in_group, first_blip)
            return first_blip
        if n == 'pic':
            blip = next((c for c in el.iter() if ln(c) == 'blip'), None)
            r = rels.get(rid_attr(blip, 'embed') or rid_attr(blip, 'link')) if blip is not None else None
            e = ext_of(r['target']) if r else ''
            shown = (anchor_kind in ('twoCellAnchor', 'oneCellAnchor') and first_blip and e in IMG_OK and not (r or {}).get('external')
                     and not hidden and not chartsheet)
            name = os.path.basename(r['target']) if r else '?'
            if shown and empty_sheet:
                inv.obj(pre + 'pic_on_empty_sheet', 1, f'{sheet}: {name}')
            elif shown:
                inv.obj(pre + 'pic_shown', 1, f'{sheet}: {name}')
            else:
                why = ('abs' if anchor_kind == 'absoluteAnchor' else 'group' if not first_blip else e or '?')
                inv.obj(pre + 'pic_dropped', 1, f'{sheet}: {name} ({why})')
            return False
        if n == 'sp':
            tx = next((c for c in el if ln(c) == 'txBody'), None)
            t = text_of(tx) if tx is not None else ''
            if t.strip():
                inv.obj(pre + 'shape_text', 1, f'{sheet}: {t}')
                inv.unit('xl.shape_text' if not hidden else 'xl.hidden_sheet', t, sheet)
            else:
                geom = next((c.get('prst') for c in el.iter() if ln(c) == 'prstGeom'), 'custom')
                inv.obj(pre + 'shape', 1, f'{sheet}: {geom}')
            # 도형 채우기로 들어간 그림
            if any(ln(c) == 'blipFill' for c in el.iter()):
                inv.obj(pre + 'shape_picture_fill', 1, sheet)
            return first_blip and not any(ln(c) == 'blip' for c in el.iter())
        if n == 'cxnSp':
            inv.obj(pre + 'connector', 1, sheet)
            return first_blip
        if n == 'graphicFrame':
            gd = next((c for c in el.iter() if ln(c) == 'graphicData'), None)
            uri = gd.get('uri') if gd is not None else ''
            if uri and (uri.endswith('/chart') or 'chartex' in uri.lower()):
                ch = next((c for c in gd.iter() if ln(c) == 'chart'), None)
                r = rels.get(rid_attr(ch, 'id')) if ch is not None else None
                texts, kind = chart_texts(pkg, r['target']) if r else ([], 'chart')
                inv.obj(pre + 'chart', 1, f'{sheet}: {kind} ' + ' / '.join(texts[:3]))
                for t in texts:
                    inv.unit('xl.chart' if not hidden else 'xl.hidden_sheet', t, sheet)
            elif uri and uri.endswith('/diagram'):
                rel = next((c for c in gd.iter() if ln(c) == 'relIds'), None)
                dm = rel is not None and rels.get(rid_attr(rel, 'dm'))
                texts = diagram_texts(pkg, dm['target']) if dm else []
                inv.obj(pre + 'smartart', 1, f'{sheet}: ' + ' / '.join(texts[:3]))
                for t in texts:
                    inv.unit('xl.smartart', t, sheet)
            elif uri and 'slicer' in uri.lower():
                inv.obj(pre + 'slicer_shape', 1, sheet)
            else:
                inv.obj(pre + 'graphic_other', 1, f'{sheet}: {uri}')
            return first_blip
        if n == 'grpSp':
            inv.obj(pre + 'group', 1, sheet)
            for c in el:
                first_blip = visit(c, anchor_kind, True, first_blip)
            return first_blip
        if n == 'contentPart':
            inv.obj(pre + 'ink', 1, sheet)
            return first_blip
        for c in el:
            first_blip = visit(c, anchor_kind, in_group, first_blip)
        return first_blip

    for anchor in x:
        k = ln(anchor)
        if k not in ('twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor', 'AlternateContent'):
            continue
        if k == 'AlternateContent':
            ch = next((c for c in anchor if ln(c) == 'Choice'), None)
            for a in (ch if ch is not None else []):
                if ln(a) in ('twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'):
                    if any(ln(c) == 'sp' and any(ln(d) == 'clientData' for d in a) for c in a) and any('ctrlProp' in str(v) or 'control' in str(v).lower() for v in []):
                        pass
                    _anchor_visit(a, visit, inv, pre, sheet)
            continue
        _anchor_visit(anchor, visit, inv, pre, sheet)


def _anchor_visit(anchor, visit, inv, pre, sheet):
    k = ln(anchor)
    # 뷰어(readSheetImages)는 앵커 안의 첫 blip만 본다.
    first = True
    for c in anchor:
        if ln(c) in ('from', 'to', 'ext', 'pos', 'clientData'):
            continue
        first = visit(c, k, False, first)


# ---------------------------------------------------------------- PowerPoint (pptx)
def inv_pptx(path, inv):
    pkg = Pkg(path)
    pres_part = 'ppt/presentation.xml'
    pres = pkg.xml(pres_part)
    if pres is None:
        raise ValueError('presentation.xml 없음')
    prels = pkg.rels(pres_part)
    order = []
    for el in pres.iter():
        if ln(el) == 'sldId':
            r = prels.get(rid_attr(el, 'id'))
            if r:
                order.append(r['target'])
    inv.meta['slides'] = len(order)
    used_layouts = {}
    for si, part in enumerate(order, 1):
        x = pkg.xml(part)
        if x is None:
            inv.obj('p.slide_missing', 1, part)
            continue
        srels = pkg.rels(part)
        hidden = x.get('show') in ('0', 'false')
        cat = 'p.hidden_slide' if hidden else 'p.slide_text'
        where = f'slide{si}'
        if hidden:
            inv.obj('p.hidden_slide', 1, f'{si}번 슬라이드')
        lay = next((r['target'] for r in srels.values() if r['type'] == 'slideLayout'), None)
        if lay and not hidden:
            used_layouts[lay] = x.get('showMasterSp') not in ('0', 'false')
        inv_pptx_tree(pkg, x, srels, inv, cat, where, hidden)
        for r in srels.values():
            t = r['type']
            if t == 'notesSlide':
                nx = pkg.xml(r['target'])
                if nx is None:
                    continue
                for sp in nx.iter():
                    if ln(sp) != 'sp':
                        continue
                    ph = next((c for c in sp.iter() if ln(c) == 'ph'), None)
                    if ph is not None and ph.get('type') in ('sldImg', 'sldNum', 'hdr', 'ftr', 'dt'):
                        continue
                    tx = next((c for c in sp if ln(c) == 'txBody'), None)
                    if tx is None:
                        continue
                    for p in tx:
                        if ln(p) == 'p':
                            t2 = text_of(p)
                            if t2.strip():
                                inv.unit('p.notes', t2, where)
                    t2 = text_of(tx)
                    if t2.strip():
                        inv.obj('p.notes', 1, f'{si}: {t2}')
            elif t == 'comments':
                cx = pkg.xml(r['target'])
                if cx is not None:
                    for cm in cx.iter():
                        if ln(cm) == 'cm':
                            t2 = text_of(cm, tags=('text', 't'))
                            if t2.strip():
                                inv.obj('p.comment', 1, f'{si}: {t2}')
                                inv.unit('p.comment', t2, where)
            elif t in ('video', 'audio', 'media'):
                inv.obj('p.media_' + t, 1, os.path.basename(r['target']) + (' (외부)' if r['external'] else ''))
    # 모든 슬라이드에 깔리는 레이아웃·마스터의 고정 글자(자리 표시자가 아닌 글 상자)
    seen = set()
    for lay, show_master in used_layouts.items():
        targets = [lay]
        if show_master:
            lrels = pkg.rels(lay)
            m = next((r['target'] for r in lrels.values() if r['type'] == 'slideMaster'), None)
            lx = pkg.xml(lay)
            if m and lx is not None and lx.get('showMasterSp') not in ('0', 'false'):
                targets.append(m)
        for t in targets:
            if t in seen:
                continue
            seen.add(t)
            mx = pkg.xml(t)
            if mx is None:
                continue
            for sp in mx.iter():
                if ln(sp) != 'sp':
                    continue
                if any(ln(c) == 'ph' for c in sp.iter()):
                    continue
                tx = next((c for c in sp if ln(c) == 'txBody'), None)
                t2 = text_of(tx) if tx is not None else ''
                if t2.strip():
                    inv.obj('p.master_text', 1, t2)
                    inv.unit('p.master_text', t2, os.path.basename(t))
            mrels = pkg.rels(t)
            for el in mx.iter():
                if ln(el) == 'blip':
                    r = mrels.get(rid_attr(el, 'embed'))
                    if r:
                        e = ext_of(r['target'])
                        inv.obj('p.master_pic_ok' if e in BROWSER_OK else 'p.master_pic_unsupported', 1, f'{e}:{os.path.basename(r["target"])}')
    for n in pkg.names:
        if n.startswith('ppt/embeddings/'):
            inv.obj('p.embedding', 1, os.path.basename(n))
    if pkg.has('ppt/vbaProject.bin'):
        inv.obj('p.macro', 1)
    if any(n.startswith('ppt/comments/modernComment') for n in pkg.names):
        for n in pkg.names:
            if n.startswith('ppt/comments/modernComment'):
                cx = pkg.xml(pkg.names[n])
                if cx is not None:
                    for cm in cx.iter():
                        if ln(cm) == 'cm':
                            t2 = text_of(cm)
                            if t2.strip():
                                inv.obj('p.comment', 1, t2)
                                inv.unit('p.comment', t2, n)


def inv_pptx_tree(pkg, x, srels, inv, cat, where, hidden):
    def visit(el, in_group=False):
        n = ln(el)
        if n == 'AlternateContent':
            ch = next((c for c in el if ln(c) == 'Choice'), None)
            if ch is not None:
                req = ch.get('Requires') or ''
                if 'a14' in req and any(ln(c) == 'm' for c in ch.iter()):
                    inv.obj('p.equation', 1, text_of(ch))
                    inv.unit('p.equation', text_of(ch), where)
                    return
                for c in ch:
                    visit(c, in_group)
            return
        if n == 'sp':
            nv = next((c for c in el.iter() if ln(c) == 'cNvPr'), None)
            if nv is not None and nv.get('hidden') in ('1', 'true'):
                inv.obj('p.hidden_shape', 1)
                return
            tx = next((c for c in el if ln(c) == 'txBody'), None)
            if tx is not None:
                for p in tx:
                    if ln(p) == 'p':
                        t = text_of(p)
                        if t.strip():
                            inv.unit(cat if not in_group or hidden else 'p.group_text', t, where)
                if any(ln(c) == 'm' for c in tx.iter()):
                    inv.obj('p.equation', 1)
            if in_group:
                inv.obj('p.group_shape', 1)
            for c in el.iter():
                if ln(c) == 'blip':
                    r = srels.get(rid_attr(c, 'embed'))
                    if r:
                        e = ext_of(r['target'])
                        inv.obj('p.shape_fill_pic_ok' if e in BROWSER_OK else 'p.shape_fill_pic_unsupported', 1, f'{e}:{os.path.basename(r["target"])}')
            return
        if n == 'grpSp':
            for c in el:
                visit(c, True)
            return
        if n == 'pic':
            blip = next((c for c in el.iter() if ln(c) == 'blip'), None)
            r = srels.get(rid_attr(blip, 'embed') or rid_attr(blip, 'link')) if blip is not None else None
            e = ext_of(r['target']) if r else ''
            media = [c for c in el.iter() if ln(c) in ('videoFile', 'audioFile', 'media', 'quickTimeFile', 'wavAudioFile')]
            if media:
                inv.obj('p.media_shape', 1, f'{where}: ' + ','.join(ln(m) for m in media))
            inv.obj('p.pic_ok' if e in BROWSER_OK else 'p.pic_unsupported', 1, f'{where}: {e}:{os.path.basename(r["target"]) if r else "?"}')
            return
        if n == 'graphicFrame':
            gd = next((c for c in el.iter() if ln(c) == 'graphicData'), None)
            uri = (gd.get('uri') if gd is not None else '') or ''
            if uri.endswith('/table'):
                inv.obj('p.table', 1, where)
                for tc in gd.iter():
                    if ln(tc) == 'tc':
                        t = text_of(tc)
                        if t.strip():
                            inv.unit(cat, t, where)
            elif uri.endswith('/chart') or 'chartex' in uri.lower():
                ch = next((c for c in gd.iter() if ln(c) == 'chart'), None)
                r = srels.get(rid_attr(ch, 'id')) if ch is not None else None
                texts, kind = chart_texts(pkg, r['target']) if r else ([], 'chart')
                inv.obj('p.chart', 1, f'{where}: {kind} ' + ' / '.join(texts[:3]))
                for t in texts:
                    inv.unit('p.chart', t, where)
            elif uri.endswith('/diagram'):
                rel = next((c for c in gd.iter() if ln(c) == 'relIds'), None)
                dm = rel is not None and srels.get(rid_attr(rel, 'dm'))
                texts = diagram_texts(pkg, dm['target']) if dm else []
                inv.obj('p.smartart', 1, f'{where}: ' + ' / '.join(texts[:3]))
                for t in texts:
                    inv.unit('p.smartart', t, where)
            elif uri.endswith('/ole') or any(ln(c) == 'oleObj' for c in gd.iter()):
                o = next((c for c in gd.iter() if ln(c) == 'oleObj'), None)
                inv.obj('p.ole', 1, f'{where}: ' + ((o.get('progId') or o.get('name') or '') if o is not None else ''))
                for c in gd.iter():
                    if ln(c) == 'blip':
                        r = srels.get(rid_attr(c, 'embed'))
                        if r:
                            e = ext_of(r['target'])
                            inv.obj('p.ole_preview_ok' if e in BROWSER_OK else 'p.ole_preview_unsupported', 1, f'{where}: {e}')
            else:
                inv.obj('p.graphic_other', 1, f'{where}: {uri}')
            return
        if n == 'contentPart':
            inv.obj('p.ink', 1, where)
            return
        if n == 'cxnSp':
            return
        for c in el:
            visit(c, in_group)
    tree = next((c for c in x.iter() if ln(c) == 'spTree'), None)
    if tree is not None:
        visit(tree)
    for el in x.iter():
        if ln(el) == 'hlinkClick' and rid_attr(el, 'id'):
            inv.obj('p.hyperlink', 1)
        if ln(el) == 'timing':
            inv.obj('p.animation', 1)
            break
    for el in x.iter():
        if ln(el) == 'transition' and len(el):
            inv.obj('p.transition', 1)
            break


# ---------------------------------------------------------------- HWPX
HWPX_CTRL = {
    'footNote': 'h.footnote', 'endNote': 'h.endnote', 'header': 'h.header', 'footer': 'h.footer',
    'hiddenComment': 'h.hidden_comment', 'memo': 'h.memo', 'masterPage': 'h.master_page',
}
HWPX_SHAPES = {'rect', 'ellipse', 'arc', 'polygon', 'curve', 'line', 'connectLine', 'container', 'textart'}
HWPX_FORMS = {'btn', 'radioBtn', 'checkBtn', 'comboBox', 'edit', 'listBox', 'scrollBar'}


def inv_hwpx(path, inv):
    pkg = Pkg(path)
    secs = sorted((n for n in pkg.names if re.fullmatch(r'contents/section\d+\.xml', n)), key=lambda s: int(re.findall(r'\d+', s)[0]))
    if not secs:
        raise ValueError('section 없음')
    bins = {}
    hdr = pkg.xml('Contents/content.hpf')
    if hdr is not None:
        for it in hdr.iter():
            if ln(it) == 'item' and it.get('id'):
                bins[it.get('id')] = it.get('href') or ''
    for sn in secs:
        x = pkg.xml(pkg.names[sn])
        if x is None:
            continue
        for el in x.iter():
            n = ln(el)
            if n == 'p':
                # 문단 글자(안쪽 subList 문단은 따로)
                parts = []

                def walk(e):
                    for c in e:
                        k = ln(c)
                        if k in ('subList', 'p', 'drawText', 'caption'):
                            continue
                        if k == 't':
                            if c.text:
                                parts.append(c.text)
                            for cc in c:  # <hp:t>글<hp:tab/>글</hp:t>
                                if ln(cc) == 'tab':
                                    parts.append('\t')
                                elif ln(cc) in ('fwSpace', 'nbSpace'):
                                    parts.append(' ')
                                if cc.tail:
                                    parts.append(cc.tail)
                            continue
                        walk(c)
                walk(el)
                t = ''.join(parts)
                if not t.strip():
                    continue
                cat = 'h.body'
                anc = el.getparent()
                while anc is not None:
                    k = ln(anc)
                    if k in HWPX_CTRL:
                        cat = HWPX_CTRL[k]
                        break
                    if k == 'drawText':
                        cat = 'h.shape_text'
                        break
                    if k == 'caption':
                        cat = 'h.caption'
                        break
                    if k == 'fieldBegin' and anc.get('type') == 'MEMO':
                        cat = 'h.memo'
                        break
                    anc = anc.getparent()
                inv.unit(cat, t, os.path.basename(sn))
                if cat != 'h.body':
                    inv.obj(cat, 1, t)
            elif n == 'equation':
                sc = next((c for c in el if ln(c) == 'script'), None)
                inv.obj('h.equation', 1, sc.text if sc is not None else '')
            elif n == 'chart':
                inv.obj('h.chart', 1)
            elif n == 'ole':
                inv.obj('h.ole', 1, el.get('binaryItemIDRef'))
            elif n == 'pic':
                img = next((c for c in el.iter() if ln(c) == 'img'), None)
                ref = img.get('binaryItemIDRef') if img is not None else None
                e = ext_of(bins.get(ref, '')) if ref else ''
                inv.obj('h.pic_ok' if e in BROWSER_OK else 'h.pic_unsupported', 1, f'{e}:{ref}')
            elif n in HWPX_SHAPES:
                inv.obj('h.shape_' + n, 1)
            elif n in HWPX_FORMS:
                cap = el.get('caption') or el.get('name') or ''
                inv.obj('h.form_' + n, 1, cap)
                if cap and n in ('btn', 'radioBtn', 'checkBtn'):
                    inv.unit('h.form_caption', cap, os.path.basename(sn))
            elif n == 'video':
                inv.obj('h.video', 1)
            elif n == 'compose':
                inv.obj('h.compose', 1)
            elif n == 'dutmal':
                inv.obj('h.dutmal', 1, el.get('mainText') or '')
            elif n == 'fieldBegin':
                inv.obj('h.field_' + (el.get('type') or '?'), 1, el.get('name'))
            elif n == 'pageHiding':
                if any(el.get(k) == '1' for k in el.attrib):
                    inv.obj('h.page_hiding', 1)
    for n in pkg.names:
        if n.startswith('contents/masterpage') or n.startswith('contents/history'):
            inv.obj('h.part_' + os.path.basename(n).split('.')[0].rstrip('0123456789'), 1)
        if n.startswith('bindata/'):
            e = ext_of(n)
            inv.obj('h.bindata_' + e, 1)
    for mp in [n for n in pkg.names if n.startswith('contents/masterpage')]:
        x = pkg.xml(pkg.names[mp])
        if x is not None:
            for t in x.iter():
                if ln(t) == 't' and t.text and t.text.strip():
                    inv.unit('h.master_page', t.text, mp)
                    inv.obj('h.master_page_text', 1, t.text)


# ---------------------------------------------------------------- HWP 5.0 (OLE + 레코드)
HWP_CTRL = {'fn  ': 'h.footnote', 'en  ': 'h.endnote', 'head': 'h.header', 'foot': 'h.footer', 'tcmt': 'h.hidden_comment',
            'gso ': 'h.shape_text', 'tbl ': 'h.body', '%%me': 'h.memo'}


def hwp_para_text(b):
    """PARA_TEXT(UTF-16LE)에서 조판 부호(확장·인라인 8글자)를 빼고 글자만 꺼낸다."""
    units = []
    i = 0
    n = len(b) // 2
    while i < n:
        ch = b[2 * i] | (b[2 * i + 1] << 8)
        if ch < 32:
            if ch in (10, 13):
                units.append(10)
                i += 1
            elif ch == 24:
                units.append(45)
                i += 1
            elif ch in (30, 31):
                units.append(32)
                i += 1
            elif ch == 9:
                units.append(9)
                i += 8
            elif ch in (0, 25, 26, 27, 28, 29):
                i += 1
            else:
                i += 8
        else:
            units.append(ch)
            i += 1
    return struct.pack(f'<{len(units)}H', *units).decode('utf-16le', 'replace')


def inv_hwp5(path, inv):
    import olefile
    ole = olefile.OleFileIO(path)
    fh = ole.openstream('FileHeader').read()
    props = struct.unpack('<I', fh[36:40])[0]
    compressed, password, distribution = props & 1, props & 2, props & 4
    inv.meta.update({'compressed': bool(compressed), 'password': bool(password), 'distribution': bool(distribution)})
    for e in ole.listdir():
        if e[0] == 'BinData' and len(e) == 2:
            ext = ext_of(e[1])
            inv.obj('h.bindata_' + ext, 1, e[1])
            if ext in ('wmf', 'emf', 'tif', 'tiff', 'pcx', 'pic', 'wpg', 'cgm'):
                inv.obj('h.pic_unsupported_bindata', 1, e[1])
    if password or distribution:
        inv.meta['textSkipped'] = True
        return
    secs = sorted((e for e in ole.listdir() if e[0] == 'BodyText'), key=lambda e: int(re.findall(r'\d+', e[1])[0] or 0))
    for e in secs:
        raw = ole.openstream(e).read()
        if compressed:
            try:
                raw = zlib.decompress(raw, -15)
            except Exception:
                inv.obj('h.section_unreadable', 1, e[1])
                continue
        pos = 0
        stack = []  # (level, kind)
        memo_level = None  # MEMO_LIST(93) 뒤의 문단은 메모 글이다(같은 수준에 이어진다)
        while pos + 4 <= len(raw):
            h = struct.unpack_from('<I', raw, pos)[0]
            pos += 4
            tag, level, size = h & 0x3FF, (h >> 10) & 0x3FF, (h >> 20) & 0xFFF
            if size == 0xFFF:
                if pos + 4 > len(raw):
                    break
                size = struct.unpack_from('<I', raw, pos)[0]
                pos += 4
            body = raw[pos:pos + size]
            pos += size
            while stack and stack[-1][0] >= level:
                stack.pop()
            if memo_level is not None and level < memo_level:
                memo_level = None
            if tag == 71 and len(body) >= 4:  # CTRL_HEADER
                cid = struct.pack('>I', struct.unpack_from('<I', body, 0)[0]).decode('latin1')
                stack.append((level, cid))
                key = {'tbl ': 'table', 'gso ': 'gso', 'eqed': 'equation', 'fn  ': 'footnote', 'en  ': 'endnote', 'head': 'header',
                       'foot': 'footer', 'tcmt': 'hidden_comment', 'form': 'form', '%%me': 'memo', '%hlk': 'hyperlink', 'tdut': 'dutmal',
                       'tcps': 'compose', 'bokm': 'bookmark', 'idxm': 'index_mark', 'pghd': 'page_hiding'}.get(cid)
                if key:
                    inv.obj('h.ctrl_' + key, 1)
                elif cid.startswith('%'):
                    inv.obj('h.field_' + cid.strip('%').strip(), 1)
            elif tag == 76 and len(body) >= 4:  # SHAPE_COMPONENT
                sid = struct.pack('>I', struct.unpack_from('<I', body, 0)[0]).decode('latin1')
                inv.obj('h.shape_' + sid.strip('$').strip(), 1)
            elif tag == 84:
                inv.obj('h.ole_component', 1)
            elif tag == 88 and len(body) >= 6:  # EQEDIT
                n = struct.unpack_from('<H', body, 4)[0]
                script = body[6:6 + 2 * n].decode('utf-16le', 'replace')
                inv.obj('h.equation', 1, script)
            elif tag == 90:
                inv.obj('h.textart', 1)
            elif tag == 91:
                inv.obj('h.form_object', 1)
            elif tag == 93:
                inv.obj('h.memo_list', 1)
                memo_level = level
            elif tag == 95:
                inv.obj('h.chart_data', 1)
            elif tag == 98:
                inv.obj('h.video', 1)
            elif tag == 67:  # PARA_TEXT
                t = hwp_para_text(body)
                if not t.strip():
                    continue
                cat = 'h.body'
                for _, kind in ([] if memo_level is not None else reversed(stack)):
                    if kind in HWP_CTRL:
                        cat = HWP_CTRL[kind]
                        if kind != 'tbl ':
                            break
                if memo_level is not None:
                    cat = 'h.memo'
                for line in t.split('\n'):
                    if line.strip():
                        inv.unit(cat, line, e[1])
                if cat != 'h.body':
                    inv.obj(cat, 1, t)


# ---------------------------------------------------------------- PDF
def inv_pdf(path, inv, max_pages=40):
    from pypdf import PdfReader
    from pypdf.generic import IndirectObject
    r = PdfReader(path, strict=False)
    if r.is_encrypted:
        try:
            if not r.decrypt(''):
                inv.meta['encrypted'] = 'user-password'
                return
            inv.meta['encrypted'] = 'owner-only'
        except Exception as e:
            inv.meta['encrypted'] = f'unreadable: {e}'
            return
    res = lambda o: o.get_object() if isinstance(o, IndirectObject) else o
    root = res(r.trailer['/Root'])
    inv.meta['pages'] = len(r.pages)
    for i, page in enumerate(r.pages):
        annots = res(page.get('/Annots')) or []
        for a in annots:
            try:
                a = res(a)
                st = str(a.get('/Subtype', '?')).lstrip('/')
            except Exception:
                continue
            if st in ('Link', 'Popup'):
                inv.obj('pdf.annot_' + st, 1)
                continue
            ap = a.get('/AP') is not None
            flags = int(a.get('/F', 0) or 0)
            hidden = bool(flags & 2)
            contents = a.get('/Contents')
            txt = str(contents) if contents is not None else ''
            if st == 'Widget':
                ft = str(res(a.get('/FT') or (res(a.get('/Parent')) or {}).get('/FT', '')) or '')
                v = a.get('/V') if a.get('/V') is not None else (res(a.get('/Parent')) or {}).get('/V')
                inv.obj('pdf.widget' + ('' if ap else '_noAP'), 1, f'p{i + 1} {ft} {str(v)[:60] if v is not None else ""}')
                if v is not None and ft == '/Tx' and str(v).strip():
                    inv.unit('pdf.form_value', str(v), f'p{i + 1}')
                continue
            inv.obj('pdf.annot_' + st + ('' if ap else '_noAP') + ('_hidden' if hidden else ''), 1, f'p{i + 1}: {txt}' if txt else f'p{i + 1}')
            if st == 'FileAttachment':
                fs = res(a.get('/FS'))
                name = str((fs or {}).get('/UF') or (fs or {}).get('/F') or '') if hasattr(fs, 'get') else str(fs)
                inv.obj('pdf.attachment_annot', 1, f'p{i + 1}: {name}')
            if txt.strip() and st not in ('FreeText',):
                inv.unit('pdf.annot_comment', txt, f'p{i + 1}')
            if st == 'FreeText' and txt.strip():
                inv.unit('pdf.freetext', txt, f'p{i + 1}')
    names = res(root.get('/Names')) or {}
    ef = res(names.get('/EmbeddedFiles')) if hasattr(names, 'get') else None
    if ef is not None:
        def walk(node):
            node = res(node)
            arr = res(node.get('/Names')) or []
            for k in range(0, len(arr), 2):
                inv.obj('pdf.attachment', 1, str(arr[k]))
            for kid in res(node.get('/Kids')) or []:
                walk(kid)
        walk(ef)
    if hasattr(names, 'get') and names.get('/JavaScript') is not None:
        inv.obj('pdf.javascript', 1)
    af = res(root.get('/AcroForm'))
    if af is not None:
        fields = res(af.get('/Fields')) or []
        inv.obj('pdf.acroform_fields', len(fields))
        if af.get('/XFA') is not None:
            inv.obj('pdf.xfa', 1)
        if af.get('/NeedAppearances'):
            inv.obj('pdf.need_appearances', 1)
    oc = res(root.get('/OCProperties'))
    if oc is not None:
        ocgs = res(oc.get('/OCGs')) or []
        inv.obj('pdf.layers', len(ocgs))
        d = res(oc.get('/D')) or {}
        off = res(d.get('/OFF')) or []
        if off:
            names_off = []
            for o in off:
                try:
                    names_off.append(str(res(o).get('/Name')))
                except Exception:
                    pass
            inv.obj('pdf.layers_off', len(off), ', '.join(names_off))
    if root.get('/Outlines') is not None:
        ol = res(root.get('/Outlines'))
        inv.obj('pdf.outline', int(ol.get('/Count', 1) or 1) if hasattr(ol, 'get') else 1)
    if root.get('/Collection') is not None:
        inv.obj('pdf.portfolio', 1)
    if root.get('/OpenAction') is not None:
        oa = res(root.get('/OpenAction'))
        if hasattr(oa, 'get') and str(oa.get('/S')) == '/JavaScript':
            inv.obj('pdf.javascript', 1)


# ---------------------------------------------------------------- ODF (odt·ods·odp)
def inv_odf(path, inv):
    pkg = Pkg(path)
    x = pkg.xml('content.xml')
    if x is None:
        raise ValueError('content.xml 없음')
    mime = (pkg.read('mimetype') or b'').decode('ascii', 'ignore')
    inv.meta['mime'] = mime
    kind = 'odp' if 'presentation' in mime else 'ods' if 'spreadsheet' in mime else 'odt'
    for el in x.iter():
        n = ln(el)
        if n == 'note':
            body = next((c for c in el if ln(c) == 'note-body'), None)
            t = text_of(body, tags=('p', 'h', 'span', 's')) if body is not None else ''
            t = ''.join(body.itertext()) if body is not None else ''
            inv.obj('o.' + (el.get('{urn:oasis:names:tc:opendocument:xmlns:text:1.0}note-class') or 'note'), 1, t)
            inv.unit('o.footnote', t, 'note')
        elif n == 'annotation':
            t = ' '.join(''.join(p.itertext()) for p in el if ln(p) in ('p', 'list'))
            inv.obj('o.comment', 1, t)
            inv.unit('o.comment', t, 'annotation')
        elif n == 'object' or n == 'object-ole':
            href = attr(el, 'href') or ''
            sub = pkg.xml(href.strip('./') + '/content.xml') if href else None
            k = 'chart' if sub is not None and any(ln(c) == 'chart' for c in sub.iter()) else 'object'
            inv.obj('o.' + k, 1, href)
        elif n == 'image':
            href = attr(el, 'href') or ''
            e = ext_of(href)
            inv.obj('o.pic_ok' if e in BROWSER_OK else 'o.pic_unsupported', 1, href)
        elif n == 'notes' and kind == 'odp':
            t = ' '.join(''.join(p.itertext()) for p in el.iter() if ln(p) == 'p')
            if t.strip():
                inv.obj('o.speaker_notes', 1, t)
                inv.unit('o.speaker_notes', t, 'notes')
        elif n == 'tracked-changes':
            inv.obj('o.tracked_changes', len(el))
        elif n == 'table' and kind == 'ods':
            if el.get('{urn:oasis:names:tc:opendocument:xmlns:table:1.0}display') == 'false':
                inv.obj('o.hidden_sheet', 1, attr(el, 'name'))
        elif n == 'text-box':
            t = ''.join(el.itertext())
            if t.strip():
                inv.obj('o.textbox', 1, t)
        elif n == 'p' and kind != 'ods':
            anc = el.getparent()
            cat = 'o.body'
            while anc is not None:
                k = ln(anc)
                if k in ('note', 'annotation', 'notes'):
                    cat = None
                    break
                if k == 'text-box':
                    cat = 'o.textbox'
                    break
                anc = anc.getparent()
            if cat:
                t = ''.join(c for c in el.itertext())
                inv.unit(cat, t, 'content')
    st = pkg.xml('styles.xml')
    if st is not None:
        for el in st.iter():
            if ln(el) in ('header', 'footer', 'header-left', 'footer-left', 'header-first', 'footer-first'):
                t = ' '.join(''.join(p.itertext()) for p in el.iter() if ln(p) == 'p')
                if t.strip():
                    inv.obj('o.' + ln(el).split('-')[0], 1, t)
                    inv.unit('o.header_footer', t, 'styles')


# ---------------------------------------------------------------- RTF (조각 수만 센다; 글자 기준은 LibreOffice)
def inv_rtf(path, inv):
    b = open(path, 'rb').read()
    s = b.decode('latin1')
    for k, cat in (('\\header', 'r.header'), ('\\footer', 'r.footer'), ('\\footnote', 'r.footnote'), ('\\annotation', 'r.comment'),
                   ('\\shptxt', 'r.textbox'), ('\\object', 'r.ole'), ('\\field', 'r.field')):
        n = len(re.findall(re.escape(k) + r'(?![a-z])', s))
        if n:
            inv.obj(cat, n)
    for m in re.finditer(r'\\(emfblip|wmetafile\d*|pngblip|jpegblip|macpict|dibitmap\d*|wbitmap\d*|pmmetafile\d*)', s):
        k = re.sub(r'\d+$', '', m.group(1))
        inv.obj('r.pict_' + k, 1)


# ---------------------------------------------------------------- 진입점
def sniff(path):
    with open(path, 'rb') as f:
        head = f.read(8192)
    if b'%PDF-' in head[:1024]:
        return 'pdf'
    if head.startswith(b'\xd0\xcf\x11\xe0'):
        return 'ole'
    if head.startswith(b'PK\x03\x04'):
        try:
            names = zipfile.ZipFile(path).namelist()
        except Exception:
            return 'zip-bad'
        low = [n.lower() for n in names]
        if any(n.startswith('contents/section') for n in low):
            return 'hwpx'
        if 'word/document.xml' in low or any(n.startswith('word/') for n in low):
            return 'docx'
        if any(n.startswith('xl/') for n in low):
            return 'xlsx'
        if any(n.startswith('ppt/') for n in low):
            return 'pptx'
        if 'content.xml' in low:
            return 'odf'
        return 'zip'
    if head.startswith(b'{\\rtf'):
        return 'rtf'
    if head.startswith(b'HWP Document File'):
        return 'hwp3'
    return 'other'


def inventory(path, ref):
    inv = Inv()
    rec = {'id': file_id(path), 'file': path}
    kind = sniff(path)
    rec['fmt'] = kind
    try:
        if kind == 'docx':
            inv_docx(path, inv)
        elif kind == 'xlsx':
            inv_xlsx(path, inv)
        elif kind == 'pptx':
            inv_pptx(path, inv)
        elif kind == 'hwpx':
            inv_hwpx(path, inv)
        elif kind == 'pdf':
            inv_pdf(path, inv)
        elif kind == 'odf':
            inv_odf(path, inv)
        elif kind == 'rtf':
            inv_rtf(path, inv)
        elif kind == 'ole':
            import olefile
            o = olefile.OleFileIO(path)
            streams = {'/'.join(e) for e in o.listdir()}
            rec['oleStreams'] = sorted(streams)[:40]
            if 'FileHeader' in streams:
                rec['fmt'] = 'hwp5'
                inv_hwp5(path, inv)
            else:
                conv = None
                if ref:
                    d = os.path.join(ref, rec['id'])
                    for e in ('docx', 'xlsx', 'pptx'):
                        if os.path.exists(os.path.join(d, f'conv.{e}')):
                            conv = (e, os.path.join(d, f'conv.{e}'))
                if 'EncryptedPackage' in streams:
                    rec['fmt'] = 'ooxml-encrypted'
                elif conv:
                    rec['fmt'] = 'ole-' + conv[0]
                    rec['via'] = 'libreoffice'
                    {'docx': inv_docx, 'xlsx': inv_xlsx, 'pptx': inv_pptx}[conv[0]](conv[1], inv)
                else:
                    rec['fmt'] = 'ole-unconverted'
                # 옛 형식에서 직접 볼 수 있는 단서
                for s in streams:
                    if s.startswith('ObjectPool/') or s.startswith('MBD'):
                        inv.obj('ole.embedded_storage', 1, s.split('/')[1] if '/' in s else s)
                        break
                if any(s.startswith('_SX_DB') or s == '_VBA_PROJECT_CUR' or s.startswith('Macros') for s in streams):
                    inv.obj('ole.macro', 1)
    except Exception as e:
        rec['error'] = f'{type(e).__name__}: {e}'[:300]
    rec.update(inv.dump())
    return rec


def main():
    lst, outdir = sys.argv[1], sys.argv[2]
    ref = sys.argv[sys.argv.index('--ref') + 1] if '--ref' in sys.argv else None
    os.makedirs(outdir, exist_ok=True)
    n = 0
    for line in open(lst, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line:
            continue
        path = line.split('\t')[0]
        rec = inventory(path, ref)
        with open(os.path.join(outdir, rec['id'] + '.json'), 'w', encoding='utf-8') as f:
            json.dump(rec, f, ensure_ascii=False)
        n += 1
        if n % 50 == 0:
            print(n, flush=True)
    print('done', n)


if __name__ == '__main__':
    main()
