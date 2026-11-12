#!/usr/bin/env python3
"""변형 파일 만들기(결정적: 같은 seed 값이면 같은 결과).

PYTHONPATH=$S/pylib python3 -I mutate.py <seeds-dir> <out-dir> [--seed 1]

종류
 - 공통 바이트 변형: 잘라내기·바이트 뒤집기·0으로 채우기·덩어리 복제/삭제·뒤에 쓰레기·앞에 1바이트·확장자 바꾸기·확장자 없음
 - ZIP 구조: 중앙 디렉터리 훼손, 크기 필드 최댓값/0, 압축 방식 99·저장(0), 항목 수, 중앙 디렉터리 없음
 - OLE 구조: 섹터 크기, FAT 수, 디렉터리 시작, FAT 자기 순환, 디렉터리 순환, 스트림 크기, 미니 기준값
 - 형식 인식 변형(semantic): xlsx 병합·크기·긴 글자·그림 위치, docx 쪽 크기·여백·글자 크기·긴 글자,
   pptx 슬라이드 크기, hwpx 쪽 크기·표 크기, HWP5 PAGE_DEF·TABLE·문단 글자 수, PDF Count·MediaBox·Kids 순환
결과: <out-dir>/manifest.jsonl (file, seed, op, name)
"""
import io, json, os, random, re, struct, sys, zipfile, zlib

if os.environ.get('PYLIB'):
    sys.path.insert(0, os.environ['PYLIB'])

SEEDS, OUT = sys.argv[1], sys.argv[2]
RNG_SEED = int(sys.argv[sys.argv.index('--seed') + 1]) if '--seed' in sys.argv else 1
os.makedirs(OUT, exist_ok=True)
manifest = open(os.path.join(OUT, 'manifest.jsonl'), 'w')
count = 0

EXT_SWAP = {  # 내용과 다른 확장자
    'hwp': ['xlsx', 'doc', 'pdf'], 'hwpx': ['docx', 'xlsx'], 'hml': ['xls'],
    'xlsx': ['hwp', 'docx', 'pptx'], 'xlsb': ['xlsx', 'hwp'], 'xls': ['doc', 'hwp', 'ppt'], 'ods': ['xlsx'],
    'csv': ['xls', 'hwp'], 'pptx': ['docx', 'xlsx'], 'ppt': ['xls', 'doc', 'hwp'],
    'docx': ['xlsx', 'hwp'], 'doc': ['xls', 'hwp', 'ppt'], 'rtf': ['docx'], 'odt': ['docx'], 'odp': ['pptx'],
    'xml': ['xls'], 'pdf': ['hwp', 'docx', 'xlsx'],
}


def emit(data, seed, op, ext=None, name=None, **params):
    global count
    stem = os.path.splitext(os.path.basename(seed))[0]
    sext = seed.rsplit('.', 1)[-1] if '.' in os.path.basename(seed) else ''
    ext = sext if ext is None else ext
    fn = f'{stem}__{op}' + (f'.{ext}' if ext else '')
    path = os.path.join(OUT, fn)
    with open(path, 'wb') as f:
        f.write(data)
    rec = {'file': path, 'seed': os.path.basename(seed), 'op': op, 'size': len(data)}
    if name:
        rec['name'] = name
    if params:
        rec['params'] = params
    manifest.write(json.dumps(rec, ensure_ascii=False) + '\n')
    count += 1


# ------------------------------------------------------------------ 공통 바이트 변형
def generic(seed, data, rng):
    n = len(data)
    ext = seed.rsplit('.', 1)[-1]
    for i, frac in enumerate([0.5, rng.uniform(0.6, 0.98)]):
        cut = max(1, int(n * frac))
        emit(data[:cut], seed, f'trunc{i}', cut=cut)
    for k in (1, 64):
        b = bytearray(data)
        pos = []
        for _ in range(k):
            p = rng.randrange(8, n) if n > 8 else rng.randrange(n)
            b[p] ^= 1 << rng.randrange(8)
            pos.append(p)
        emit(bytes(b), seed, f'flip{k}', first=pos[:4])
    if n > 8192:
        b = bytearray(data)
        p = rng.randrange(512, n - 4096)
        b[p:p + 4096] = bytes(4096)
        emit(bytes(b), seed, 'zero4k', at=p)
    if n > 2048:
        a = rng.randrange(0, n - 1024)
        L = rng.randrange(256, min(8192, n - a))
        p = rng.randrange(0, n)
        emit(data[:p] + data[a:a + L] + data[p:], seed, 'dupchunk', src=a, len=L, at=p)
    emit(data + bytes(rng.getrandbits(8) for _ in range(65536)), seed, 'append64k')
    emit(b'\x00' + data, seed, 'prepend1')
    for e in EXT_SWAP.get(ext, [])[:1]:
        emit(data, seed, f'as_{e}', ext=e)
    emit(data, seed, 'noext', ext='')


# ------------------------------------------------------------------ ZIP 구조
def zip_entries(data):
    e = data.rfind(b'PK\x05\x06')
    if e < 0:
        return None
    cnt, cdsize, cdoff = struct.unpack_from('<HII', data, e + 10)
    ents = []
    p = cdoff
    for _ in range(cnt):
        if data[p:p + 4] != b'PK\x01\x02':
            break
        method, = struct.unpack_from('<H', data, p + 10)
        csize, usize, nl, xl, cl = struct.unpack_from('<IIHHH', data, p + 20)
        lho, = struct.unpack_from('<I', data, p + 42)
        name = data[p + 46:p + 46 + nl].decode('utf-8', 'replace')
        ents.append({'cd': p, 'name': name, 'method': method, 'csize': csize, 'usize': usize, 'lho': lho})
        p += 46 + nl + xl + cl
    return {'eocd': e, 'cdoff': cdoff, 'cdsize': cdsize, 'ents': ents}


PRIMARY = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet1.bin', 'xl/sharedStrings.xml', 'word/document.xml',
           'ppt/slides/slide1.xml', 'Contents/section0.xml', 'content.xml', 'xl/workbook.xml', 'xl/workbook.bin']


def primary(z):
    for want in PRIMARY:
        for en in z['ents']:
            if en['name'].lower() == want.lower():
                return en
    return max(z['ents'], key=lambda e: e['usize'])


def zip_struct(seed, data, rng):
    z = zip_entries(data)
    if not z or not z['ents']:
        return
    pe = primary(z)
    b = bytearray(data)
    for _ in range(8):
        p = rng.randrange(z['cdoff'], z['eocd'])
        b[p] ^= 0xff
    emit(bytes(b), seed, 'zip_cdflip')

    def setboth(fn, op, **kw):
        b = bytearray(data)
        fn(b, pe)
        emit(bytes(b), seed, op, entry=pe['name'], **kw)
    setboth(lambda b, e: (struct.pack_into('<I', b, e['cd'] + 24, 0xFFFFFFFF), struct.pack_into('<I', b, e['lho'] + 22, 0xFFFFFFFF)), 'zip_usize_max')
    setboth(lambda b, e: (struct.pack_into('<I', b, e['cd'] + 20, 0x7FFFFFFF), struct.pack_into('<I', b, e['lho'] + 18, 0x7FFFFFFF)), 'zip_csize_max')
    setboth(lambda b, e: (struct.pack_into('<H', b, e['cd'] + 10, 99), struct.pack_into('<H', b, e['lho'] + 8, 99)), 'zip_method99')
    if pe['method'] == 8:
        # 압축된 내용을 "저장(무압축)"으로 표시: 엔진이 압축 바이트를 XML로 읽는다
        setboth(lambda b, e: (struct.pack_into('<H', b, e['cd'] + 10, 0), struct.pack_into('<H', b, e['lho'] + 8, 0),
                              struct.pack_into('<I', b, e['cd'] + 24, e['csize']), struct.pack_into('<I', b, e['lho'] + 22, e['csize'])), 'zip_stored_lie')
    b = bytearray(data)
    struct.pack_into('<HH', b, z['eocd'] + 8, 0xFFFF, 0xFFFF)
    emit(bytes(b), seed, 'zip_eocd_count')
    emit(data[:z['cdoff']], seed, 'zip_no_cd')


def zip_rewrite(data, edit):
    """edit(name, bytes) -> bytes|None(그대로). 순서와 mimetype(무압축)을 유지한다."""
    zin = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    zout = zipfile.ZipFile(out, 'w')
    changed = False
    for info in zin.infolist():
        body = zin.read(info.filename)
        nb = edit(info.filename, body)
        if nb is not None and nb != body:
            changed = True
            body = nb
        ct = zipfile.ZIP_STORED if info.filename == 'mimetype' else zipfile.ZIP_DEFLATED
        zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
        zi.compress_type = ct
        zout.writestr(zi, body, compresslevel=9 if ct == zipfile.ZIP_DEFLATED else None)
    zout.close()
    return out.getvalue() if changed else None


def sub_in(target, pattern, repl, count=0, flags=0):
    def edit(name, body):
        if not re.fullmatch(target, name, flags=re.I):
            return None
        s = body.decode('utf-8', 'surrogateescape')
        s2 = re.sub(pattern, repl, s, count=count, flags=flags)
        return s2.encode('utf-8', 'surrogateescape') if s2 != s else None
    return edit


def zsem(seed, data, op, edit, **kw):
    try:
        out = zip_rewrite(data, edit)
    except Exception as e:  # noqa
        print('skip', seed, op, e)
        return
    if out:
        emit(out, seed, op, **kw)


LONG_KO = ('가나다라마바사아자차카타파하' * 220000)[:3000000]


def xlsx_sem(seed, data):
    sh = r'xl/worksheets/sheet1\.xml'
    zsem(seed, data, 'x_merge_all', sub_in(sh, r'</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>', 1))
    cols = ''.join(f'<mergeCell ref="{c}1:{c}1048576"/>' for c in [chr(65 + i) for i in range(26)])
    zsem(seed, data, 'x_merge_cols', sub_in(sh, r'</sheetData>', f'</sheetData><mergeCells count="26">{cols}</mergeCells>', 1))
    zsem(seed, data, 'x_dim_huge', sub_in(sh, r'<dimension ref="[^"]*"/>', '<dimension ref="A1:XFD1048576"/>', 1))
    zsem(seed, data, 'x_sst_long', sub_in(r'xl/sharedStrings\.xml', r'<t([^>]*)>[^<]*</t>', lambda m: f'<t{m.group(1)}>{LONG_KO}</t>', 1))
    zsem(seed, data, 'x_sheetname_long', sub_in(r'xl/workbook\.xml', r'(<sheet\b[^>]*\bname=")[^"]*(")', lambda m: m.group(1) + 'A' * 200000 + m.group(2), 1))
    zsem(seed, data, 'x_numfmt_long', sub_in(r'xl/styles\.xml', r'formatCode="[^"]*"', 'formatCode="' + '0' * 20000 + '"', 0))
    zsem(seed, data, 'x_col_width_huge', sub_in(sh, r'<sheetData', '<cols><col min="1" max="16384" width="1e308" customWidth="1"/></cols><sheetData', 1))
    zsem(seed, data, 'x_row_r_huge', sub_in(sh, r'<row r="(\d+)"', lambda m: f'<row r="{1048000 + int(m.group(1))}"', 0))
    # 그림 위치(그림이 있는 파일만)
    zsem(seed, data, 'x_anchor_row_huge', sub_in(r'xl/drawings/drawing\d+\.xml', r'(<xdr:to>.*?<xdr:row>)\d+(</xdr:row>)', lambda m: m.group(1) + '2000000000' + m.group(2), 1, re.S))
    zsem(seed, data, 'x_anchor_row_1e300', sub_in(r'xl/drawings/drawing\d+\.xml', r'(<xdr:to>.*?<xdr:row>)\d+(</xdr:row>)', lambda m: m.group(1) + '1e300' + m.group(2), 1, re.S))
    zsem(seed, data, 'x_anchor_col_huge', sub_in(r'xl/drawings/drawing\d+\.xml', r'(<xdr:to>\s*<xdr:col>)\d+(</xdr:col>)', lambda m: m.group(1) + '2000000000' + m.group(2), 1, re.S))


def docx_sem(seed, data):
    d = r'word/document\.xml'
    zsem(seed, data, 'w_pgsz_tiny', sub_in(d, r'<w:pgSz\b[^>]*/>', '<w:pgSz w:w="20" w:h="20"/>', 0))
    zsem(seed, data, 'w_margin_exceed', sub_in(d, r'<w:pgMar\b[^>]*/>', '<w:pgMar w:top="20000" w:right="20000" w:bottom="20000" w:left="20000" w:header="0" w:footer="0" w:gutter="0"/>', 0))
    zsem(seed, data, 'w_pgsz_huge', sub_in(d, r'<w:pgSz\b[^>]*/>', '<w:pgSz w:w="2147483647" w:h="2147483647"/>', 0))
    zsem(seed, data, 'w_font_huge', sub_in(d, r'<w:rPr>', '<w:rPr><w:sz w:val="3276"/>', 0))
    zsem(seed, data, 'w_long_run', sub_in(d, r'<w:t([^>]*)>[^<]*</w:t>', lambda m: f'<w:t{m.group(1)}>{LONG_KO[:1500000]}</w:t>', 1))
    zsem(seed, data, 'w_gridspan_huge', sub_in(d, r'<w:tcPr>', '<w:tcPr><w:gridSpan w:val="100000"/>', 1))
    zsem(seed, data, 'w_indent_neg', sub_in(d, r'<w:pPr>', '<w:pPr><w:ind w:left="-99999999" w:right="99999999"/>', 0))
    # 문단 2만 배
    def explode(name, body):
        if name != 'word/document.xml':
            return None
        s = body.decode('utf-8')
        m = re.search(r'<w:p\b[^>]*>.*?</w:p>', s, re.S)
        if not m:
            return None
        return (s[:m.end()] + m.group(0) * 20000 + s[m.end():]).encode('utf-8')
    zsem(seed, data, 'w_para_x20000', explode)


def pptx_sem(seed, data):
    p = r'ppt/presentation\.xml'
    zsem(seed, data, 'p_sldsz_zero', sub_in(p, r'<p:sldSz\b[^>]*/>', '<p:sldSz cx="0" cy="0"/>', 1))
    zsem(seed, data, 'p_sldsz_huge', sub_in(p, r'<p:sldSz\b[^>]*/>', '<p:sldSz cx="2147483647" cy="2147483647"/>', 1))
    zsem(seed, data, 'p_sldsz_thin', sub_in(p, r'<p:sldSz\b[^>]*/>', '<p:sldSz cx="9144000" cy="1"/>', 1))
    zsem(seed, data, 'p_ext_huge', sub_in(r'ppt/slides/slide1\.xml', r'<a:ext cx="\d+" cy="\d+"/>', '<a:ext cx="99999999999" cy="99999999999"/>', 0))
    zsem(seed, data, 'p_long_text', sub_in(r'ppt/slides/slide1\.xml', r'<a:t>[^<]*</a:t>', f'<a:t>{LONG_KO[:1500000]}</a:t>', 1))
    zsem(seed, data, 'p_font_huge', sub_in(r'ppt/slides/slide1\.xml', r'<a:rPr\b', '<a:rPr sz="400000"', 0))


def hwpx_sem(seed, data):
    s = r'Contents/section\d+\.xml'
    zsem(seed, data, 'hx_page_tiny', sub_in(s, r'(<hp:pagePr\b[^>]*?)width="\d+"([^>]*?)height="\d+"', r'\1width="100"\2height="100"', 0))
    zsem(seed, data, 'hx_page_h1', sub_in(s, r'(<hp:pagePr\b[^>]*?height=")\d+(")', r'\g<1>1\2', 0))
    zsem(seed, data, 'hx_page_huge', sub_in(s, r'(<hp:pagePr\b[^>]*?)width="\d+"([^>]*?)height="\d+"', r'\1width="2147483647"\2height="2147483647"', 0))
    zsem(seed, data, 'hx_margin_exceed', sub_in(s, r'<hp:margin\b[^>]*/>', '<hp:margin header="0" footer="0" gutter="0" left="60000" right="60000" top="90000" bottom="90000"/>', 0))
    zsem(seed, data, 'hx_tbl_huge', sub_in(s, r'rowCnt="\d+" colCnt="\d+"', 'rowCnt="65535" colCnt="65535"', 1))
    zsem(seed, data, 'hx_long_text', sub_in(s, r'<hp:t>[^<]*</hp:t>', f'<hp:t>{LONG_KO[:1500000]}</hp:t>', 1))
    zsem(seed, data, 'hx_charsz_huge', sub_in(r'Contents/header\.xml', r'(<hh:charPr\b[^>]*?height=")\d+(")', r'\g<1>4000000\2', 0))

    def explode(name, body):
        if not re.fullmatch(s, name):
            return None
        t = body.decode('utf-8')
        ms = list(re.finditer(r'<hp:p\b[^>]*>(?:(?!<hp:p\b).)*?</hp:p>', t, re.S))
        if len(ms) < 2:
            return None
        m = ms[-1]
        return (t[:m.end()] + m.group(0) * 20000 + t[m.end():]).encode('utf-8')
    zsem(seed, data, 'hx_para_x20000', explode)


# ------------------------------------------------------------------ OLE 구조
def ole_parse(data):
    if data[:8] != b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':
        return None
    shift, = struct.unpack_from('<H', data, 0x1e)
    ss = 1 << shift
    nfat, firstdir = struct.unpack_from('<II', data, 0x2c)
    difat = struct.unpack_from('<109I', data, 0x4c)
    fatsecs = [s for s in difat[:nfat] if s < 0xFFFFFFFA]
    off = lambda s: (s + 1) * ss
    fat = []
    for s in fatsecs:
        fat += struct.unpack_from(f'<{ss // 4}I', data, off(s))
    chain, s = [], firstdir
    while s < 0xFFFFFFFA and s < len(fat) and len(chain) < 10000:
        chain.append(s)
        s = fat[s]
    dirents = []
    for s in chain:
        for k in range(ss // 128):
            p = off(s) + k * 128
            if p + 128 > len(data):
                break
            nl, = struct.unpack_from('<H', data, p + 64)
            name = data[p:p + max(0, nl - 2)].decode('utf-16le', 'replace')
            typ = data[p + 66]
            start, size = struct.unpack_from('<II', data, p + 116)
            dirents.append({'off': p, 'name': name, 'type': typ, 'start': start, 'size': size})
    return {'ss': ss, 'fat': fat, 'fatsecs': fatsecs, 'off': off, 'dirents': dirents}


MAIN_STREAMS = ['FileHeader', 'Workbook', 'Book', 'WordDocument', 'PowerPoint Document', 'Section0', 'DocInfo']


def ole_struct(seed, data):
    o = ole_parse(data)
    if not o:
        return
    def put(op, fn):
        b = bytearray(data)
        try:
            fn(b)
        except Exception as e:  # noqa
            print('skip', seed, op, e)
            return
        emit(bytes(b), seed, op)
    put('ole_sector_shift16', lambda b: struct.pack_into('<H', b, 0x1e, 16))
    put('ole_sector_shift31', lambda b: struct.pack_into('<H', b, 0x1e, 31))
    put('ole_nfat_huge', lambda b: struct.pack_into('<I', b, 0x2c, 0xFFFFFFFF))
    put('ole_dir_bad', lambda b: struct.pack_into('<I', b, 0x30, 0x7FFFFFF0))
    put('ole_minicut_zero', lambda b: struct.pack_into('<I', b, 0x38, 0))
    put('ole_minicut_max', lambda b: struct.pack_into('<I', b, 0x38, 0xFFFFFFFF))
    put('ole_difat_loop', lambda b: struct.pack_into('<II', b, 0x44, o['fatsecs'][0] if o['fatsecs'] else 0, 1))
    regular = [d for d in o['dirents'] if d['type'] == 2 and d['size'] >= 4096]
    big = max(regular, key=lambda d: d['size']) if regular else None
    if big:
        # 큰 스트림 사슬의 둘째 섹터가 자기 자신을 가리키게(FAT 순환)
        s1 = big['start']
        s2 = o['fat'][s1] if s1 < len(o['fat']) else None
        tgt = s2 if s2 is not None and s2 < 0xFFFFFFFA else s1
        def fatloop(b, tgt=tgt):
            per = o['ss'] // 4
            fs = o['fatsecs'][tgt // per]
            struct.pack_into('<I', b, o['off'](fs) + (tgt % per) * 4, tgt)
        put('ole_fat_selfloop', fatloop)
        def fatback(b, tgt=tgt, s1=s1):
            per = o['ss'] // 4
            fs = o['fatsecs'][tgt // per]
            struct.pack_into('<I', b, o['off'](fs) + (tgt % per) * 4, s1)
        put('ole_fat_backloop', fatback)
    for d in o['dirents']:
        if d['name'] in MAIN_STREAMS:
            put(f'ole_size_huge_{re.sub(r"[^A-Za-z0-9]", "", d["name"])}', lambda b, d=d: struct.pack_into('<I', b, d['off'] + 120, 0x7FFFFFF0))
            break
    if o['dirents']:
        root = o['dirents'][0]
        put('ole_dir_child_self', lambda b: struct.pack_into('<I', b, root['off'] + 76, 0))
        if len(o['dirents']) > 2:
            e1 = o['dirents'][1]
            put('ole_dir_sib_cycle', lambda b: (struct.pack_into('<I', b, e1['off'] + 68, 1), struct.pack_into('<I', b, e1['off'] + 72, 1)))


# ------------------------------------------------------------------ HWP 5.0 본문 레코드
def hwp_records(raw):
    p, out = 0, []
    while p + 4 <= len(raw):
        h, = struct.unpack_from('<I', raw, p)
        tag, lvl, size = h & 0x3ff, (h >> 10) & 0x3ff, (h >> 20) & 0xfff
        hp = p
        p += 4
        if size == 0xfff:
            size, = struct.unpack_from('<I', raw, p)
            p += 4
        out.append((tag, lvl, p, size, hp))
        p += size
    return out


def hwp_sem(seed, data):
    try:
        import olefile
    except ImportError:
        print('no olefile')
        return
    import shutil, tempfile
    ole = olefile.OleFileIO(io.BytesIO(data))
    if not ole.exists('BodyText/Section0'):
        return
    fh = ole.openstream('FileHeader').read()
    compressed = bool(fh[36] & 1)
    rawc = ole.openstream('BodyText/Section0').read()
    orig_len = len(rawc)
    raw = zlib.decompress(rawc, -15) if compressed else rawc
    ole.close()
    recs = hwp_records(raw)

    def build(op, fn):
        b = bytearray(raw)
        if fn(b) is False:
            return
        nb = bytes(b)
        if compressed:
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            nb = co.compress(nb) + co.flush()
        if len(nb) > orig_len:
            print('skip(too big)', seed, op)
            return
        nb = nb + bytes(orig_len - len(nb))
        tmp = tempfile.NamedTemporaryFile(delete=False, dir=OUT, suffix='.tmp')
        tmp.write(data)
        tmp.close()
        o2 = olefile.OleFileIO(tmp.name, write_mode=True)
        o2.write_stream('BodyText/Section0', nb)
        o2.close()
        out = open(tmp.name, 'rb').read()
        os.unlink(tmp.name)
        emit(out, seed, op)

    pagedefs = [r for r in recs if r[0] == 73]
    tables = [r for r in recs if r[0] == 77]
    paras = [r for r in recs if r[0] == 66]
    if pagedefs:
        _, _, p, size, _ = pagedefs[0]
        build('h5_page_tiny', lambda b: struct.pack_into('<II', b, p, 100, 100))
        build('h5_page_h0', lambda b: struct.pack_into('<I', b, p + 4, 0))
        build('h5_page_huge', lambda b: struct.pack_into('<II', b, p, 0x7FFFFFFF, 0x7FFFFFFF))
        build('h5_margin_exceed', lambda b: struct.pack_into('<IIII', b, p + 8, 60000, 60000, 90000, 90000))
    if tables:
        _, _, p, size, _ = tables[0]
        build('h5_table_huge', lambda b: struct.pack_into('<HH', b, p + 4, 65535, 65535))
    if paras:
        _, _, p, size, _ = paras[0]
        build('h5_para_nchars', lambda b: struct.pack_into('<I', b, p, 0x7FFFFFFF))
        if len(paras) > 3:
            _, _, p2, _, _ = paras[len(paras) // 2]
            build('h5_para_nchars_mid', lambda b: struct.pack_into('<I', b, p2, 0x00FFFFFF))


# ------------------------------------------------------------------ PDF (글자로 된 부분만)
def pdf_sem(seed, data):
    s = data.decode('latin1')
    def rep(op, pat, repl, cnt=0):
        t = re.sub(pat, repl, s, count=cnt)
        if t != s:
            emit(t.encode('latin1'), seed, op)
    rep('pdf_count_huge', r'/Count\s+\d+', '/Count 2000000000')
    rep('pdf_mediabox_zero', r'/MediaBox\s*\[[^\]]*\]', '/MediaBox [0 0 0 0]')
    rep('pdf_mediabox_huge', r'/MediaBox\s*\[[^\]]*\]', '/MediaBox [0 0 14400000 14400000]')
    rep('pdf_mediabox_thin', r'/MediaBox\s*\[[^\]]*\]', '/MediaBox [0 0 612 0.01]')
    rep('pdf_startxref_bad', r'startxref\s+\d+', 'startxref 999999999')
    rep('pdf_length_huge', r'/Length\s+\d+', '/Length 999999999', 1)
    m = re.search(r'(\d+)\s+0\s+obj\s*<<(?:(?!endobj).)*?/Type\s*/Pages', s, re.S)
    if m:
        rep('pdf_kids_self', r'/Kids\s*\[[^\]]*\]', f'/Kids [{m.group(1)} 0 R]', 1)


# ------------------------------------------------------------------ 실행
def main():
    rng = random.Random(RNG_SEED)
    for fn in sorted(os.listdir(SEEDS)):
        path = os.path.join(SEEDS, fn)
        data = open(path, 'rb').read()
        ext = fn.rsplit('.', 1)[-1].lower()
        generic(path, data, random.Random(f'{RNG_SEED}:{fn}'))
        if data[:2] == b'PK':
            zip_struct(path, data, random.Random(f'{RNG_SEED}:z:{fn}'))
            if ext in ('xlsx', 'xlsm'):
                xlsx_sem(path, data)
            elif ext == 'docx':
                docx_sem(path, data)
            elif ext == 'pptx':
                pptx_sem(path, data)
            elif ext == 'hwpx':
                hwpx_sem(path, data)
        if data[:4] == b'\xd0\xcf\x11\xe0':
            ole_struct(path, data)
            if ext == 'hwp':
                try:
                    hwp_sem(path, data)
                except Exception as e:  # noqa
                    print('hwp_sem fail', fn, e)
        if b'%PDF-' in data[:1024]:
            pdf_sem(path, data)
    manifest.close()
    print('mutants:', count)


main()
