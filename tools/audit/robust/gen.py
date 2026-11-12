#!/usr/bin/env python3
"""성능 절벽을 노리는 합성 입력(현실에서 올 법한 모양 위주).
python3 -I gen.py <out-dir> <seeds-dir>
결과: <out-dir>/manifest.jsonl (file, op, why)
"""
import io, json, os, random, re, struct, sys, zipfile, zlib

if os.environ.get('PYLIB'):
    sys.path.insert(0, os.environ['PYLIB'])
OUT, SEEDS = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
man = open(os.path.join(OUT, 'manifest.jsonl'), 'w')
rng = random.Random(5)
KO = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호'


def emit(name, data, why):
    p = os.path.join(OUT, name)
    open(p, 'wb').write(data)
    man.write(json.dumps({'file': p, 'op': name.rsplit('.', 1)[0], 'size': len(data), 'why': why}, ensure_ascii=False) + '\n')
    print(name, len(data))


def ko(n):
    return ''.join(rng.choice(KO) for _ in range(n))


# ---------------------------------------------------------------- 엑셀 다운로드(HTML 표 .xls), 2003 XML, CSV, TXT
rows = []
for i in range(20000):
    rows.append('<tr>' + ''.join(f'<td>{ko(4)}{i}</td>' if c % 3 == 0 else f'<td>{rng.randint(0, 99999999):,}</td>' for c in range(12)) + '</tr>')
html = '<html><head><meta charset="euc-kr"></head><body><table border=1>' + '<tr>' + ''.join(f'<th>항목{c}</th>' for c in range(12)) + '</tr>' + ''.join(rows) + '</table></body></html>'
emit('html_table_20k.xls', html.encode('euc-kr'), '웹 시스템 "엑셀 다운로드"(HTML 표 2만 행, EUC-KR) - 글자 파일이라 작업 스레드를 거치지 않음')

x = ['<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Sheet1"><Table>']
for i in range(20000):
    x.append('<Row>' + ''.join(f'<Cell><Data ss:Type="String">{ko(4)}{i}</Data></Cell>' if c % 2 == 0 else f'<Cell><Data ss:Type="Number">{rng.randint(0, 999999)}</Data></Cell>' for c in range(10)) + '</Row>')
x.append('</Table></Worksheet></Workbook>')
emit('spreadsheetml_20k.xls', ''.join(x).encode('utf-8'), 'Excel 2003 XML 2만 행 - 화면 스레드에서 해석')

emit('csv_one_field_2mb.csv', ('"' + 'A' * 2_000_000 + '"\n').encode(), 'CSV 한 칸에 200만 자(따옴표 안)')
emit('txt_one_line_2mb.txt', ('x' * 2_000_000).encode(), '줄바꿈 없는 2MB 글자 파일(.txt는 표로 열림)')
chat = ['홍길동 님과 카카오톡 대화', '저장한 날짜 : 2026-10-08 오전 9:12', '']
for i in range(30000):
    chat.append(f'2026년 {1 + i % 12}월 {1 + i % 28}일 오후 {1 + i % 12}:{i % 60:02d}, {rng.choice(["홍길동", "김철수", "이영희"])} : {ko(rng.randint(5, 40))}, {ko(3)}')
emit('kakao_chat_export.txt', '\n'.join(chat).encode('utf-8'), '카카오톡 "대화 내보내기" txt(쉼표 포함 3만 줄) - 표로 보이는지')
emit('csv_utf16le_nobom.csv', '이름,부서,전화\n'.encode('utf-16le') + ''.join(f'{ko(3)},{ko(2)}팀,010-{i:04d}-1234\n' for i in range(3000)).encode('utf-16le'), 'BOM 없는 UTF-16 CSV - EUC-KR로 잘못 풀리는지')


# ---------------------------------------------------------------- xlsx (XML 직접 작성)
def xlsx(sheet_xml, sst=None, extra=None, styles=None, wb_extra=''):
    b = io.BytesIO()
    z = zipfile.ZipFile(b, 'w', zipfile.ZIP_DEFLATED)
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Default Extension="png" ContentType="image/png"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          + ('<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' if sst else '')
          + ('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' if styles else '')
          + ('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' if extra else '')
          + '</Types>')
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    z.writestr('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' + wb_extra + '</workbook>')
    rels = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    if sst:
        rels += '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
        z.writestr('xl/sharedStrings.xml', sst)
    if styles:
        rels += '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        z.writestr('xl/styles.xml', styles)
    z.writestr('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>')
    z.writestr('xl/worksheets/sheet1.xml', sheet_xml)
    if extra:
        for k, v in extra.items():
            z.writestr(k, v)
    z.close()
    return b.getvalue()


NS = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
STY = ('<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts>'
       '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>'
       '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fillId="2" applyFill="1"/></cellXfs></styleSheet>')


def col(c):
    s = ''
    c += 1
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


# 1MB 미만인데 풀면 거대한 시트(작업 스레드 기준 1MB 아래라 화면 스레드에서 해석)
body = ''.join(f'<row r="{r}">' + ''.join(f'<c r="{col(c)}{r}" s="1"/>' for c in range(60)) + '</row>' for r in range(1, 8001))
d = xlsx(NS + '<dimension ref="A1:BH8000"/><sheetData>' + body + '</sheetData></worksheet>', styles=STY)
emit('xlsx_styled_blank_480k_cells.xlsx', d, '칠만 된 빈 칸 48만 개(압축 %dKB) - 1MB 미만이라 화면 스레드에서 해석' % (len(d) // 1024))
sst = '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + ''.join(f'<si><t>{i}</t></si>' for i in range(350000)) + '</sst>'
body = ''.join(f'<row r="{r}"><c r="A{r}" t="s"><v>{r - 1}</v></c></row>' for r in range(1, 3001))
d = xlsx(NS + '<sheetData>' + body + '</sheetData></worksheet>', sst=sst)
emit('xlsx_sst_350k.xlsx', d, '공유 문자열 35만 개(시트는 3천 행만 사용)')
# 결과 없는 수식(openpyxl 등): VLOOKUP 3천 행
body = ''.join(f'<row r="{r}"><c r="A{r}"><v>{r}</v></c><c r="B{r}" t="inlineStr"><is><t>{ko(3)}</t></is></c><c r="C{r}"><v>{r * 7}</v></c>'
               f'<c r="D{r}"><f>VLOOKUP(A{r},$A$1:$C$3000,3,FALSE)</f></c><c r="E{r}"><f>SUMIF($A$1:$A$3000,"&lt;"&amp;A{r},$C$1:$C$3000)</f></c></row>' for r in range(1, 3001))
emit('xlsx_formula_vlookup_3k.xlsx', xlsx(NS + '<sheetData>' + body + '</sheetData></worksheet>'), '결과값 없는 VLOOKUP·SUMIF 수식 6천 개 - 화면 스레드 계산(8초 한도)')
body = ''.join(f'<row r="{r}"><c r="A{r}"><v>{r}</v></c><c r="B{r}"><f>SUM(A:XFD)</f></c></row>' for r in range(1, 50))
emit('xlsx_formula_wholesheet.xlsx', xlsx(NS + '<dimension ref="A1:XFD3000"/><sheetData>' + body + '</sheetData></worksheet>'), '결과 없는 =SUM(A:XFD) 49개(사용 범위가 넓은 시트)')
# 한 칸에 아주 긴 글자(엑셀 한도 32767자를 넘는 값)
body = f'<row r="1"><c r="A1" t="inlineStr"><is><t>{ko(800_000)}</t></is></c></row>'
emit('xlsx_cell_800k_chars.xlsx', xlsx(NS + '<sheetData>' + body + '</sheetData></worksheet>'), '칸 하나에 한글 80만 자(엔진 오독 흉내)')
body = ''.join(f'<row r="{r}">' + ''.join(f'<c r="{col(c)}{r}" t="inlineStr"><is><t>{ko(300)}</t></is></c>' for c in range(30)) + '</row>' for r in range(1, 401))
emit('xlsx_long_text_cells.xlsx', xlsx(NS + '<sheetData>' + body + '</sheetData></worksheet>'), '칸마다 300자 × 30열 × 400행')
# 병합 범위 폭탄(엑셀에서 열 전체 병합 = A1:A1048576 같은 것)
merges = ''.join(f'<mergeCell ref="{col(c)}1:{col(c)}1048576"/>' for c in range(30))
emit('xlsx_merge_whole_columns.xlsx', xlsx(NS + '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="30">' + merges + '</mergeCells></worksheet>'), '열 전체 병합 30개(A1:A1048576 …)')
emit('xlsx_merge_one_column.xlsx', xlsx(NS + '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="B1:B1048576"/></mergeCells></worksheet>'), '열 하나 전체 병합(B열 선택 후 병합)')
emit('xlsx_merge_4_columns.xlsx', xlsx(NS + '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="B1:E1048576"/></mergeCells></worksheet>'), 'B:E 네 열 전체 병합')
# 큰 xlsx(>1MB, 작업 스레드) + 로고 그림 → 그림 읽기가 화면 스레드에서 ZIP 전체를 다시 푼다
png = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000') + struct.pack('>I', zlib.crc32(bytes.fromhex('4948445200000001000000010806000000'))) + bytes.fromhex('0000000a49444154789c6360000000020001') + b'\xe5\x27\xde\xfc' + bytes.fromhex('0000000049454e44ae426082')
body = ''.join(f'<row r="{r}">' + ''.join(f'<c r="{col(c)}{r}"><v>{rng.randint(0, 10 ** 9)}</v></c>' for c in range(20)) + '</row>' for r in range(1, 60001))
drawing = ('<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
           '<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'
           '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="logo"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>')
extra = {
    'xl/worksheets/_rels/sheet1.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
    'xl/drawings/drawing1.xml': drawing,
    'xl/drawings/_rels/drawing1.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>',
    'xl/media/image1.png': png,
}
d = xlsx(NS + '<sheetData>' + body + '</sheetData><drawing r:id="rId1"/></worksheet>', extra=extra)
emit('xlsx_big_with_logo.xlsx', d, '120만 칸 큰 xlsx(%dMB) + 로고 그림 1개' % (len(d) >> 20))
d2 = xlsx(NS + '<sheetData>' + body + '</sheetData></worksheet>')
emit('xlsx_big_no_logo.xlsx', d2, '위와 같은 파일에서 그림만 뺀 비교군')
# 그림 위치가 아주 먼 행(손상 흉내): 그림 칸 계산 반복
d = xlsx(NS + '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>', extra={**extra, 'xl/drawings/drawing1.xml': drawing.replace('<xdr:row>5</xdr:row>', '<xdr:row>400000000</xdr:row>')})
emit('xlsx_anchor_row_4e8.xlsx', d, '그림 끝 행 4억(손상)')
# 시트 3천 개(탭 버튼 3천 개)
b = io.BytesIO()
z = zipfile.ZipFile(b, 'w', zipfile.ZIP_DEFLATED)
N = 3000
z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, N + 1)) + '</Types>')
z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
z.writestr('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + ''.join(f'<sheet name="{ko(3)}{i}" sheetId="{i}" r:id="rId{i}"/>' for i in range(1, N + 1)) + '</sheets></workbook>')
z.writestr('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, N + 1)) + '</Relationships>')
for i in range(1, N + 1):
    z.writestr(f'xl/worksheets/sheet{i}.xml', NS + f'<sheetData><row r="1"><c r="A1"><v>{i}</v></c></row></sheetData></worksheet>')
z.close()
emit('xlsx_3000_sheets.xlsx', b.getvalue(), '시트 3천 개')


# ---------------------------------------------------------------- PDF
def pdf(pages_content, mediabox=(0, 0, 595, 842), extra_objs=None, resources='<< /Font << /F1 4 0 R >> >>'):
    objs = {}
    n = len(pages_content)
    first_page = 5
    kids = ' '.join(f'{first_page + 2 * i} 0 R' for i in range(n))
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
    objs[2] = f'<< /Type /Pages /Kids [{kids}] /Count {n} >>'
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    stream_objs = {}
    for i, c in enumerate(pages_content):
        po = first_page + 2 * i
        objs[po] = f'<< /Type /Page /Parent 2 0 R /MediaBox [{" ".join(map(str, mediabox))}] /Resources {resources} /Contents {po + 1} 0 R >>'
        stream_objs[po + 1] = c
    for k, v in (extra_objs or {}).items():
        if isinstance(v, (bytes, tuple)):
            stream_objs[k] = v
        else:
            objs[k] = v
    out = io.BytesIO()
    out.write(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offs = {}
    for k in sorted(set(objs) | set(stream_objs)):
        offs[k] = out.tell()
        if k in stream_objs:
            data = stream_objs[k]
            if isinstance(data, tuple):
                dct, data = data
            else:
                dct = ''
            raw = data if isinstance(data, bytes) else data.encode('latin1')
            comp = zlib.compress(raw, 6)
            out.write(f'{k} 0 obj\n<< /Length {len(comp)} /Filter /FlateDecode {dct} >>\nstream\n'.encode() + comp + b'\nendstream\nendobj\n')
        else:
            out.write(f'{k} 0 obj\n{objs[k]}\nendobj\n'.encode('latin1'))
    xref = out.tell()
    mx = max(offs) + 1
    out.write(f'xref\n0 {mx}\n0000000000 65535 f \n'.encode())
    for k in range(1, mx):
        out.write((f'{offs[k]:010d} 00000 n \n' if k in offs else '0000000000 65535 f \n').encode())
    out.write(f'trailer\n<< /Size {mx} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return out.getvalue()


emit('pdf_3000_pages.pdf', pdf([f'BT /F1 24 Tf 72 720 Td (Page {i + 1}) Tj ET' for i in range(3000)]), '3천 쪽 PDF(쪽 크기를 쪽마다 차례로 읽음)')
txt = ['BT /F1 4 Tf']
for i in range(40000):
    txt.append(f'1 0 0 1 {10 + (i % 140) * 4} {20 + (i // 140) * 2.8:.1f} Tm ({i % 1000}) Tj')
txt.append('ET')
emit('pdf_dense_text_40k.pdf', pdf(['\n'.join(txt)]), '글자 조각 4만 개 한 쪽(도면·큰 표 PDF) - 글자 층을 화면 스레드에서 만듦')
path = ['0.1 w 10 10 m']
for i in range(300000):
    path.append(f'{rng.uniform(10, 585):.1f} {rng.uniform(10, 832):.1f} l')
path.append('S')
emit('pdf_path_300k.pdf', pdf(['\n'.join(path)]), '선분 30만 개짜리 경로 1개(도면)')
W = H = 12000
img = zlib.compress(bytes(W) * 1, 9) if False else None
raw = b''.join(bytes([(r // 50) % 256]) * W for r in range(H))
emit('pdf_image_12000px.pdf', pdf(['q 595 0 0 842 0 0 cm /Im1 Do Q'], resources='<< /XObject << /Im1 3 0 R >> >>',
                                  extra_objs={3: (f'/Type /XObject /Subtype /Image /Width {W} /Height {H} /ColorSpace /DeviceGray /BitsPerComponent 8', raw)}),
     '12000×12000 회색 그림 1장(스캔 원본급)')


# ---------------------------------------------------------------- docx(긴 표·긴 문서)
def docx_from(seed, body_xml):
    zin = zipfile.ZipFile(os.path.join(SEEDS, seed))
    out = io.BytesIO()
    z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)
    for info in zin.infolist():
        data = zin.read(info.filename)
        if info.filename == 'word/document.xml':
            s = data.decode('utf-8')
            s = re.sub(r'<w:body>.*?(<w:sectPr\b)', lambda m: '<w:body>' + body_xml + m.group(1), s, flags=re.S)
            data = s.encode('utf-8')
        z.writestr(info.filename, data)
    z.close()
    return out.getvalue()


def tc(t, w=1500):
    return f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>{t}</w:t></w:r></w:p></w:tc>'


rows_x = ''.join('<w:tr>' + ''.join(tc(f'{ko(6)} {r}') for _ in range(6)) + '</w:tr>' for r in range(4000))
tbl = '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid>' + '<w:gridCol w:w="1500"/>' * 6 + '</w:tblGrid>' + rows_x + '</w:tbl><w:p/>'
emit('docx_table_4000rows.docx', docx_from('word2007.docx', tbl), '4천 행 표 하나(명단·대장) - 쪽 나누기')
paras = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{ko(rng.randint(60, 200))} {i}</w:t></w:r></w:p>' for i in range(12000))
emit('docx_12000_paras.docx', docx_from('word2007.docx', paras), '문단 1만2천 개(약 300쪽)')
emit('docx_one_para_300k.docx', docx_from('word2007.docx', f'<w:p><w:r><w:t>{ko(300000)}</w:t></w:r></w:p>'), '띄어쓰기 없는 30만 자 문단 하나')
man.close()
