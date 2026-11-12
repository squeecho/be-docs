#!/usr/bin/env python3
"""말뭉치에 드물거나 없는 '빠지기 쉬운 내용'을 하나씩 넣은 시험 파일을 만든다.

사용법: python3 -I make_fixtures.py <출력 폴더> [<EMF 파일>]
  EMF 파일을 주면 엑셀·워드·파워포인트에 EMF 그림으로 넣는다(없으면 LibreOffice로 SVG에서 만든다).
각 파일에는 찾기 쉬운 표지 글자(FX-…)를 넣어 compare.py·사람이 확인하기 쉽게 했다.
"""
import io, os, re, shutil, subprocess, sys, zipfile

OUT = os.path.abspath(sys.argv[1])
os.makedirs(OUT, exist_ok=True)
WORK = os.path.join(OUT, '_work')
os.makedirs(WORK, exist_ok=True)


def png_bytes(color=(200, 30, 30), size=(120, 60), text=None):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', size, color)
    if text:
        ImageDraw.Draw(im).text((5, 5), text, fill=(255, 255, 255))
    b = io.BytesIO()
    im.save(b, 'PNG')
    return b.getvalue()


def make_emf():
    if len(sys.argv) > 2:
        return open(sys.argv[2], 'rb').read()
    svg = os.path.join(WORK, 'logo.svg')
    open(svg, 'w').write('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#1a5"/>'
                         '<text x="10" y="50" font-size="30" fill="#fff">LOGO</text></svg>')
    prof = os.path.join(WORK, 'lo-profile-fx')
    subprocess.run(['soffice', f'-env:UserInstallation=file://{prof}', '--headless', '--convert-to', 'emf', '--outdir', WORK, svg],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    return open(os.path.join(WORK, 'logo.emf'), 'rb').read()


def rezip(src, dst, replace=None, add=None):
    """ZIP 부품을 바꾸거나 더해 새 파일로 쓴다."""
    replace, add = replace or {}, add or {}
    zin = zipfile.ZipFile(src)
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
        for it in zin.infolist():
            data = zin.read(it.filename)
            if it.filename in replace:
                data = replace[it.filename](data) if callable(replace[it.filename]) else replace[it.filename]
            zout.writestr(it, data)
        for name, data in add.items():
            zout.writestr(name, data)


EMF = make_emf()

# ---------------------------------------------------------------- 엑셀
def excel():
    from openpyxl import Workbook
    from openpyxl.chart import BarChart, Reference
    from openpyxl.comments import Comment
    from openpyxl.formatting.rule import CellIsRule
    from openpyxl.styles import PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation
    from openpyxl.drawing.image import Image as XLImage
    wb = Workbook()
    ws = wb.active
    ws.title = '매출'
    ws.append(['FX-XL 월', '매출', '비용', '증감', '상태'])
    for row in [['1월', 120, 100, 20, '승인'], ['2월', 90, 110, -20, '보류'], ['3월', 150, 120, 30, '승인']]:
        ws.append(row)
    ws['B2'].comment = Comment('FX-XL-메모: 3월 수치 재확인 필요', '김과장')
    ws.conditional_formatting.add('D2:D4', CellIsRule(operator='lessThan', formula=['0'], fill=PatternFill('solid', bgColor='FFC7CE')))
    dv = DataValidation(type='list', formula1='"승인,반려,보류"')
    ws.add_data_validation(dv)
    dv.add('E2:E4')
    ws['A6'] = 'FX-XL 링크'
    ws['A6'].hyperlink = 'https://example.com/report'
    ch = BarChart()
    ch.title = 'FX-XL-차트 월별 매출 추이'
    ch.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True)
    ch.set_categories(Reference(ws, min_col=1, min_row=2, max_row=4))
    ws.add_chart(ch, 'G2')
    hid = wb.create_sheet('원가')
    hid['A1'] = 'FX-XL-숨긴시트 원가율 62%'
    hid.sheet_state = 'hidden'
    pic = wb.create_sheet('도면')
    pf = os.path.join(WORK, 'red.png')
    open(pf, 'wb').write(png_bytes(text='FX-XL-PIC-ONLY'))
    pic.add_image(XLImage(pf), 'B2')
    tmp = os.path.join(WORK, 'xl-base.xlsx')
    wb.save(tmp)
    # 도형(글상자)·EMF 그림·그림 두 장 묶음을 drawing1.xml에 더한다.
    z = zipfile.ZipFile(tmp)
    names = z.namelist()
    d1 = 'xl/drawings/drawing1.xml'
    rels = 'xl/drawings/_rels/drawing1.xml.rels'
    A = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

    def anchor(c1, r1, c2, r2, body):
        return (f'<xdr:twoCellAnchor><xdr:from><xdr:col>{c1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{r1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
                f'<xdr:to><xdr:col>{c2}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{r2}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>{body}<xdr:clientData/></xdr:twoCellAnchor>')

    def pic(id_, name, rid, x=0, y=0):
        return (f'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{id_}" name="{name}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
                f'<xdr:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="1143000" cy="571500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>')
    sp = ('<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="90" name="TextBox 1"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2286000" cy="457200"/></a:xfrm>'
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill></xdr:spPr>'
          '<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR"/><a:t>FX-XL-글상자 ※ 단가는 부가세 별도</a:t></a:r></a:p></xdr:txBody></xdr:sp>')
    arrow = ('<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="91" name="Arrow 1"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>'
             '<a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></xdr:spPr></xdr:sp>')
    grp = ('<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="92" name="Group 1"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2286000" cy="571500"/>'
           '<a:chOff x="0" y="0"/><a:chExt cx="2286000" cy="571500"/></a:xfrm></xdr:grpSpPr>' + pic(93, 'G1', 'rIdG1') + pic(94, 'G2', 'rIdG2', x=1143000) + '</xdr:grpSp>')
    extra = (anchor(0, 7, 4, 9, sp) + anchor(0, 10, 2, 12, arrow) + anchor(0, 13, 3, 16, pic(95, 'EMF logo', 'rIdE1')) + anchor(4, 13, 8, 16, grp))
    d = z.read(d1).decode()
    d = re.sub(r'(</(?:\w+:)?wsDr>)\s*$', lambda m: extra + m.group(1), d)
    # openpyxl은 기본 네임스페이스(접두사 없음)로 쓴다. 더한 요소가 쓰는 xdr·a·r 접두사를 루트에 선언한다.
    m = re.match(r'(<\?xml[^>]*>\s*)?<(\w+:)?wsDr\b[^>]*>', d)
    root = m.group(0)
    add = ''.join(f' xmlns:{k}="{v}"' for k, v in (('xdr', 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'),
                                                   ('a', 'http://schemas.openxmlformats.org/drawingml/2006/main'),
                                                   ('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')) if f'xmlns:{k}=' not in root)
    d = d.replace(root, root[:-1] + add + '>', 1)
    r = z.read(rels).decode()
    IMG = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
    r = r.replace('</Relationships>', f'<Relationship Id="rIdG1" Type="{IMG}" Target="../media/fxg1.png"/><Relationship Id="rIdG2" Type="{IMG}" Target="../media/fxg2.png"/>'
                  f'<Relationship Id="rIdE1" Type="{IMG}" Target="../media/fxlogo.emf"/></Relationships>')
    ct = z.read('[Content_Types].xml').decode()
    if 'Extension="emf"' not in ct:
        ct = ct.replace('<Default ', '<Default Extension="emf" ContentType="image/x-emf"/><Default ', 1)
    if 'Extension="png"' not in ct:
        ct = ct.replace('<Default ', '<Default Extension="png" ContentType="image/png"/><Default ', 1)
    rezip(tmp, os.path.join(OUT, 'fx-excel-objects.xlsx'), replace={d1: d.encode(), rels: r.encode(), '[Content_Types].xml': ct.encode()},
          add={'xl/media/fxg1.png': png_bytes((30, 30, 200), text='FX-G1'), 'xl/media/fxg2.png': png_bytes((30, 160, 30), text='FX-G2'), 'xl/media/fxlogo.emf': EMF})


# ---------------------------------------------------------------- 워드
def word():
    from docx import Document
    from docx.shared import Pt
    doc = Document()
    doc.add_heading('FX-W 업무 협조 요청', 1)
    p = doc.add_paragraph('FX-W-본문 아래와 같이 자재 구매에 협조를 요청드립니다.')
    doc.add_comment(p.runs, text='FX-W-메모 일정 확인 바랍니다', author='박대리', initials='PD')
    doc.add_paragraph('FX-W-수식앞')
    doc.add_paragraph('FX-W-변경추적')
    doc.add_paragraph('FX-W-글상자앞')
    doc.add_paragraph('FX-W-그림앞')
    doc.add_paragraph('FX-W-끝')
    sec = doc.sections[0]
    sec.header.paragraphs[0].text = 'FX-W-머리말 대외비'
    tmp = os.path.join(WORK, 'w-base.docx')
    doc.save(tmp)
    z = zipfile.ZipFile(tmp)
    xml = z.read('word/document.xml').decode()
    M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
    eq = ('<w:p><m:oMathPara><m:oMath><m:r><m:t>FXEQ</m:t></m:r><m:r><m:t>=</m:t></m:r><m:f><m:num><m:r><m:t>영업이익</m:t></m:r></m:num>'
          '<m:den><m:r><m:t>매출액</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara></w:p>')
    tracked = ('<w:p><w:r><w:t xml:space="preserve">납기는 </w:t></w:r><w:ins w:id="901" w:author="이부장" w:date="2026-10-01T00:00:00Z"><w:r><w:t>FX-W-삽입 11월 15일</w:t></w:r></w:ins>'
               '<w:del w:id="902" w:author="이부장" w:date="2026-10-01T00:00:00Z"><w:r><w:delText>FX-W-삭제 10월 31일</w:delText></w:r></w:del><w:r><w:t>입니다.</w:t></w:r></w:p>')
    WPS = ('xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
           'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
           'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml"')
    txbx = ('<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2743200" cy="457200"/><wp:docPr id="501" name="Text Box 1"/>'
            '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>'
            '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>'
            '<wps:txbx><w:txbxContent><w:p><w:r><w:t>FX-W-글상자 회신 기한: 10월 31일</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>'
            '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
    emf = ('<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="762000"/><wp:docPr id="502" name="Logo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
           '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo.emf"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdFxEmf"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
           '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="762000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
    alt = '<w:altChunk r:id="rIdFxAlt"/>'

    def after(marker, block):
        nonlocal xml
        i = xml.index(marker)
        j = xml.index('</w:p>', i) + len('</w:p>')
        xml = xml[:j] + block + xml[j:]
    after('FX-W-수식앞', eq)
    after('FX-W-변경추적', tracked)
    after('FX-W-글상자앞', txbx)
    after('FX-W-그림앞', emf + alt)
    xml = xml.replace('<w:document ', f'<w:document {M} {WPS} ', 1)
    # 이미 있는 접두사가 두 번 선언되면 XML 오류가 나므로 중복을 지운다
    head, rest = xml.split('>', 1) if xml.startswith('<w:document') else (None, None)
    m = re.search(r'<w:document[^>]*>', xml)
    tag = m.group(0)
    seen, attrs = set(), []
    for a in re.findall(r'\s(xmlns:\w+="[^"]*"|[\w:]+="[^"]*")', tag):
        k = a.split('=')[0]
        if k in seen:
            continue
        seen.add(k)
        attrs.append(a)
    xml = xml.replace(tag, '<w:document ' + ' '.join(attrs) + '>', 1)
    rels = z.read('word/_rels/document.xml.rels').decode()
    rels = rels.replace('</Relationships>',
                        '<Relationship Id="rIdFxEmf" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/fxlogo.emf"/>'
                        '<Relationship Id="rIdFxAlt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="fxchunk.htm"/></Relationships>')
    ct = z.read('[Content_Types].xml').decode()
    ct = ct.replace('<Default ', '<Default Extension="emf" ContentType="image/x-emf"/><Default Extension="htm" ContentType="text/html"/><Default ', 1)
    html = '<html><body><p>FX-W-HTML조각 납품 일정표: 1차 11월, 2차 12월</p></body></html>'
    rezip(tmp, os.path.join(OUT, 'fx-word-objects.docx'), replace={'word/document.xml': xml.encode(), 'word/_rels/document.xml.rels': rels.encode(), '[Content_Types].xml': ct.encode()},
          add={'word/media/fxlogo.emf': EMF, 'word/fxchunk.htm': html.encode()})


# ---------------------------------------------------------------- 파워포인트
def slides():
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[1])
    s1.shapes.title.text = 'FX-P 2분기 사업 계획'
    s1.placeholders[1].text = 'FX-P-본문 매출 목표 120억'
    s1.notes_slide.notes_text_frame.text = 'FX-P-노트 발표 시 강조: 예산 15% 증액'
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = 'FX-P-숨긴슬라이드 내부 검토용'
    s2.placeholders[1].text = '인력 재배치안'
    s2._element.set('show', '0')
    s3 = prs.slides.add_slide(prs.slide_layouts[5])
    s3.shapes.title.text = 'FX-P 지역별 매출'
    cd = CategoryChartData()
    cd.categories = ['서울', '부산', '대구']
    cd.add_series('FX-P-차트계열 매출', (10, 7, 5))
    s3.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(6), Inches(4), cd)
    s4 = prs.slides.add_slide(prs.slide_layouts[5])
    s4.shapes.title.text = 'FX-P 로고와 메모'
    pf = os.path.join(WORK, 'emf-placeholder.png')
    open(pf, 'wb').write(png_bytes(text='PLACEHOLDER'))
    s4.shapes.add_picture(pf, Inches(1), Inches(2))
    tmp = os.path.join(WORK, 'p-base.pptx')
    prs.save(tmp)
    z = zipfile.ZipFile(tmp)
    # 4번 슬라이드의 그림을 EMF로 바꾼다
    rels4 = 'ppt/slides/_rels/slide4.xml.rels'
    r4 = z.read(rels4).decode()
    m = re.search(r'Target="\.\./media/(image\d+\.png)"', r4)
    r4 = r4.replace(m.group(0), 'Target="../media/fxlogo.emf"')
    # 메모(옛 형식 comments)
    r4 = r4.replace('</Relationships>', '<Relationship Id="rIdFxCm" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments/comment1.xml"/></Relationships>')
    cm = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
          '<p:cm authorId="0" dt="2026-10-01T00:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>FX-P-메모 로고 최신 버전으로 교체</p:text></p:cm></p:cmLst>')
    authors = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
               '<p:cmAuthor id="0" name="최과장" initials="C" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>')
    prels = z.read('ppt/_rels/presentation.xml.rels').decode().replace('</Relationships>',
        '<Relationship Id="rIdFxAu" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors" Target="commentAuthors.xml"/></Relationships>')
    ct = z.read('[Content_Types].xml').decode()
    ct = ct.replace('<Default ', '<Default Extension="emf" ContentType="image/x-emf"/><Default ', 1)
    ct = ct.replace('</Types>', '<Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>'
                    '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/></Types>')
    rezip(tmp, os.path.join(OUT, 'fx-slides-objects.pptx'), replace={rels4: r4.encode(), '[Content_Types].xml': ct.encode(), 'ppt/_rels/presentation.xml.rels': prels.encode()},
          add={'ppt/media/fxlogo.emf': EMF, 'ppt/comments/comment1.xml': cm.encode(), 'ppt/commentAuthors.xml': authors.encode()})


# ---------------------------------------------------------------- PDF
def pdf():
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    font = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
    if not os.path.exists(font):
        font = next((os.path.join(r, f) for r, _, fs in os.walk('/usr/share/fonts') for f in fs if 'zenhei' in f.lower()), None)
    pdfmetrics.registerFont(TTFont('KO', font, subfontIndex=0))
    base = os.path.join(WORK, 'pdf-base.pdf')
    c = canvas.Canvas(base, pagesize=(595, 842))
    c.setFont('KO', 16)
    c.drawString(60, 780, 'FX-PDF 견적서 본문 (상세 내역은 첨부 파일 참조)')
    c.drawString(60, 740, 'FX-PDF 합계 금액: 12,000,000원')
    c.showPage()
    c.save()
    from pypdf import PdfReader, PdfWriter
    from pypdf.annotations import Text, FreeText
    from pypdf.generic import NameObject, DictionaryObject, ArrayObject, FloatObject, TextStringObject, NumberObject
    w = PdfWriter(clone_from=base)
    w.add_attachment('FX-견적_상세.csv', '품목,수량,단가\n볼트,100,50\n'.encode('utf-8'))
    note = Text(text='FX-PDF-메모 단가 재협의 필요', rect=(400, 760, 420, 780), open=False)
    w.add_annotation(page_number=0, annotation=note)
    # 첨부 파일 주석(종이 클립 아이콘)
    fs = DictionaryObject({NameObject('/Type'): NameObject('/Filespec'), NameObject('/F'): TextStringObject('FX-annot.txt'),
                           NameObject('/UF'): TextStringObject('FX-annot.txt')})
    ef_stream = w._add_object(__import__('pypdf').generic.DecodedStreamObject())
    ef_stream.get_object().set_data(b'annotation attachment')
    ef_stream.get_object()[NameObject('/Type')] = NameObject('/EmbeddedFile')
    fs[NameObject('/EF')] = DictionaryObject({NameObject('/F'): ef_stream})
    fa = DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/FileAttachment'),
                           NameObject('/Rect'): ArrayObject([FloatObject(60), FloatObject(600), FloatObject(80), FloatObject(620)]),
                           NameObject('/FS'): w._add_object(fs), NameObject('/Contents'): TextStringObject('FX-PDF-첨부주석'), NameObject('/Name'): NameObject('/Paperclip')})
    w.add_annotation(page_number=0, annotation=fa)
    with open(os.path.join(OUT, 'fx-pdf-attach-notes.pdf'), 'wb') as f:
        w.write(f)


# ---------------------------------------------------------------- RTF (머리말·각주·메모)
def rtf():
    s = (r'{\rtf1\ansi\ansicpg949\deff0{\fonttbl{\f0\fnil\fcharset129 Malgun Gothic;}}'
         r'{\header \pard FX-RTF-머리말 대외비\par}'
         r'\pard FX-RTF-본문 회의 결과를 알려 드립니다{\super\chftn{\footnote\pard\super\chftn FX-RTF-각주 참석자 5명\par}}.\par'
         r'\pard 다음 회의는 11월입니다{\*\atnid KIM}{\*\atnauthor 김}\chatn{\*\annotation\pard FX-RTF-메모 장소 미정\par}.\par}')
    # 한글은 \uN? 로 넣는다
    def esc(t):
        return ''.join(c if ord(c) < 128 else f'\\u{ord(c) if ord(c) < 32768 else ord(c) - 65536}?' for c in t)
    open(os.path.join(OUT, 'fx-rtf-notes.rtf'), 'w', encoding='ascii').write(esc(s))


if __name__ == '__main__':
    for fn in (excel, word, slides, pdf, rtf):
        try:
            fn()
            print('ok', fn.__name__)
        except Exception as e:
            import traceback
            traceback.print_exc()
            print('FAIL', fn.__name__, e)


# ---------------------------------------------------------------- 엑셀: 시트 크기 표시(dimension)가 틀린 파일(웹 시스템 내보내기 흉내)
def excel_dimension():
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = '목록'
    ws.append(['FX-DIM 번호', '부서', '사업명', '금액', '담당자', '비고'])
    for i in range(1, 31):
        ws.append([i, '하천관리과', f'FX-DIM 사업 {i}', i * 1000, f'담당{i}', f'FX-DIM-비고{i}'])
    tmp = os.path.join(WORK, 'dim.xlsx')
    wb.save(tmp)
    for name, ref in (('fx-xl-dim-a1.xlsx', 'A1'), ('fx-xl-dim-small.xlsx', 'A1:C10')):
        def fix(b, ref=ref):
            x = b.decode()
            x = re.sub(r'<dimension ref="[^"]*"\s*/>', f'<dimension ref="{ref}"/>', x)
            return x.encode()
        rezip(tmp, os.path.join(OUT, name), replace={'xl/worksheets/sheet1.xml': fix})


if __name__ == '__main__' and len(sys.argv) > 1:
    excel_dimension()
    print('ok excel_dimension')


# ---------------------------------------------------------------- 엑셀: '자동 줄 바꿈'한 긴 글자 칸(비고·사업 내용)
def excel_wrap():
    from openpyxl import Workbook
    from openpyxl.styles import Alignment
    wb = Workbook()
    ws = wb.active
    ws.title = '점검결과'
    ws.append(['FX-WRAP 번호', '점검 항목', '비고'])
    long = ('FX-WRAP-비고 현장 점검 결과 배수로 일부 구간에 토사가 쌓여 있어 우기 전 준설이 필요함. 시공사에 10월 31일까지 조치 계획 제출을 요청했으며, '
            '미제출 시 계약 조건에 따라 지체상금을 부과할 예정임. 끝-FX-WRAP-END')
    ws.append([1, '배수로 상태', long])
    ws.column_dimensions['C'].width = 40
    ws['C2'].alignment = Alignment(wrap_text=True, vertical='top')
    ws.row_dimensions[2].height = 120
    wb.save(os.path.join(OUT, 'fx-xl-wrap-text.xlsx'))


if __name__ == '__main__' and len(sys.argv) > 1:
    excel_wrap()
    print('ok excel_wrap')


# ---------------------------------------------------------------- 웹 시스템의 "워드 다운로드"(HTML을 .doc 이름으로): 안에 SVG 차트·수식(MathML)·iframe
def webdoc():
    html = ('<html><head><meta charset="utf-8"></head><body>'
            '<h1>FX-WEB 월간 실적 보고</h1><p>FX-WEB-본문 아래 그래프와 같이 실적이 개선되었습니다.</p>'
            '<svg width="300" height="120" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="40" width="50" height="70" fill="#36c"/>'
            '<rect x="80" y="20" width="50" height="90" fill="#36c"/><text x="10" y="15">FX-WEB-SVG차트 1분기 대비 2분기</text></svg>'
            '<p>FX-WEB-수식앞</p><math><mi>FXMATH</mi><mo>=</mo><mfrac><mi>이익</mi><mi>매출</mi></mfrac></math>'
            '<p>FX-WEB-끝</p></body></html>')
    open(os.path.join(OUT, 'fx-webdoc-svg.doc'), 'w', encoding='utf-8').write(html)


if __name__ == '__main__' and len(sys.argv) > 1:
    webdoc()
    print('ok webdoc')
