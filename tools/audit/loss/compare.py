#!/usr/bin/env python3
"""완전성 오라클 4단계: 구조 목록(inventory) + 기준 글자(LibreOffice·pdftotext)와 뷰어 화면(capture)을 맞춰 본다.

사용법:
  python3 -I compare.py --capture out/capture.jsonl --inv inv --ref ref --out out/compare
결과:
  <out>.json          파일별 상세(분류별 글자 단위 수·빠진 수·빠진 예, 물건 수와 화면 증거, 안내 띠)
  <out>-files.tsv     파일별 요약(본문 덮음률, 빠진 분류, 안내 여부)
  <out>-cats.tsv      분류별 합계(파일 수·단위 수·빠진 글자 수·안내 없이 빠진 파일 수)
판정:
  글자 단위가 화면 글자(공백·문장부호 제거, NFKC, 소문자)에 그대로 있으면 found,
  12글자 조각의 80% 이상이 있으면 mostly, 30~80%면 partial, 그 아래면 missing.
  숫자만 있는 단위(엑셀 숫자 칸 등)는 서식 차이가 많아 따로 센다(num_*).
"""
import json, os, re, sys, unicodedata
from collections import defaultdict, Counter

# 분류: (한국어 이름, 기대) 기대 = show(보여야 함) / note(보이거나 알려야 함) / hidden(원본에서도 숨김, 빠져도 됨) / noted(뷰어가 이미 알림)
CATEGORY = {
    'w.body': ('워드 본문', 'show'), 'w.header': ('워드 머리말', 'show'), 'w.footer': ('워드 꼬리말', 'show'),
    'w.footnote': ('워드 각주', 'show'), 'w.endnote': ('워드 미주', 'show'), 'w.comment': ('워드 메모(검토 의견)', 'note'),
    'w.textbox': ('워드 글상자', 'show'), 'w.smartart': ('워드 SmartArt', 'show'), 'w.chart': ('워드 차트 글자', 'show'),
    'w.equation': ('워드 수식', 'show'), 'w.watermark': ('워드 워터마크', 'show'),
    'w.deleted': ('변경 추적: 삭제된 글자', 'hidden'), 'w.hidden_text': ('숨긴 글자', 'hidden'),
    'xl.cell': ('엑셀 칸 글자', 'show'), 'xl.hidden_sheet': ('엑셀 숨긴 시트 내용', 'note'), 'xl.beyond_limit': ('엑셀 표시 한도 밖', 'noted'),
    'xl.shape_text': ('엑셀 도형·글상자 글자', 'show'), 'xl.chart': ('엑셀 차트 글자', 'show'), 'xl.smartart': ('엑셀 SmartArt', 'show'),
    'xl.comment': ('엑셀 메모', 'note'), 'xl.outside_dimension': ('엑셀 시트 크기 표시(dimension) 밖 칸', 'show'), 'xl.header_footer': ('엑셀 인쇄 머리글·바닥글', 'note'),
    'p.slide_text': ('슬라이드 글자', 'show'), 'p.group_text': ('슬라이드 그룹 속 글자', 'show'), 'p.hidden_slide': ('숨긴 슬라이드 내용', 'note'),
    'p.notes': ('발표자 노트', 'note'), 'p.comment': ('슬라이드 메모', 'note'), 'p.smartart': ('슬라이드 SmartArt', 'show'),
    'p.chart': ('슬라이드 차트 글자', 'show'), 'p.equation': ('슬라이드 수식', 'show'), 'p.master_text': ('마스터·레이아웃 고정 글자', 'show'),
    'h.body': ('한글 본문', 'show'), 'h.header': ('한글 머리말', 'show'), 'h.footer': ('한글 꼬리말', 'show'),
    'h.footnote': ('한글 각주', 'show'), 'h.endnote': ('한글 미주', 'show'), 'h.shape_text': ('한글 글상자', 'show'),
    'h.caption': ('한글 캡션', 'show'), 'h.memo': ('한글 메모', 'note'), 'h.hidden_comment': ('한글 숨은 설명', 'hidden'),
    'h.master_page': ('한글 바탕쪽', 'show'), 'h.form_caption': ('한글 양식 개체 글자', 'show'),
    'pdf.page_text': ('PDF 쪽 글자', 'show'), 'pdf.annot_comment': ('PDF 주석 메모 내용', 'note'), 'pdf.freetext': ('PDF 글상자 주석', 'show'),
    'pdf.form_value': ('PDF 서식 칸 값', 'show'),
    'o.body': ('ODF 본문', 'show'), 'o.footnote': ('ODF 각주', 'show'), 'o.comment': ('ODF 메모', 'note'),
    'o.header_footer': ('ODF 머리말·꼬리말', 'show'), 'o.textbox': ('ODF 글상자', 'show'), 'o.speaker_notes': ('ODP 발표자 노트', 'note'),
    'lo.writer': ('LibreOffice 기준 글자(워드류)', 'show'), 'lo.calc': ('LibreOffice 기준 글자(엑셀, 보이는 시트)', 'show'),
    'lo.calc_hidden': ('LibreOffice 기준 글자(숨긴 시트)', 'note'), 'lo.impress': ('LibreOffice 기준 글자(슬라이드)', 'show'),
}
# 화면 글자로 확인할 수 없는(캔버스에만 그려지는) 분류: 글자 비교에서 뺀다
CANVAS_ONLY = {'pdf.freetext', 'pdf.form_value'}
# 안내 띠에 이 낱말이 있으면 그 분류를 '알렸다'고 본다
NOTE_WORDS = {
    'comment': ['메모', '댓글', '의견', '주석'], 'notes': ['노트'], 'chart': ['차트', '그래프'], 'shape': ['도형', '글상자'],
    'hidden': ['숨긴', '숨김'], 'header': ['머리', '꼬리', '바닥'], 'footnote': ['각주', '미주'], 'pic': ['그림', '이미지'],
    'equation': ['수식'], 'smartart': ['SmartArt', '스마트아트', '도해'], 'media': ['동영상', '소리', '오디오', '비디오'],
    'attachment': ['첨부'], 'form': ['서식 칸', '양식', '입력 칸'], 'simple': ['간단'],
}


def norm(s):
    s = unicodedata.normalize('NFKC', s or '').lower()
    return re.sub(r'[\W_]+', '', s)


def numeric(n):
    return not re.search(r'[^\d]', n)


def match(nu, hay, hayset=None, raw=None):
    """nu(정규화된 단위)가 화면 글자 hay 안에 얼마나 있는지: found/mostly/partial/missing"""
    if hayset is not None and nu in hayset:
        return 'found', 1.0
    if nu in hay:
        return 'found', 1.0
    r = 0.0
    if len(nu) >= 16:
        step = 12
        chunks = [nu[i:i + step] for i in range(0, len(nu) - step + 1, step)]
        r = sum(1 for c in chunks if c in hay) / max(1, len(chunks))
    # 어절(띄어쓰기 단위) 비교: 수식·조판 부호가 문장 중간에 끼어 통째 비교가 깨지는 경우
    if raw is not None:
        toks = [t for t in (norm(x) for x in re.split(r'\s+', raw)) if len(t) >= 2]
        if toks:
            got = [t for t in toks if t in hay]
            tr = sum(len(t) for t in got) / sum(len(t) for t in toks)
            r = max(r, tr)
    return ('mostly' if r >= 0.8 else 'partial' if r >= 0.3 else 'missing'), r


def load_capture(path):
    caps = {}
    for line in open(path, encoding='utf-8'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        caps[r['id']] = r
    return caps


def viewer_text(cap):
    k = (cap.get('final') or {}).get('kind')
    cells = set()
    if k == 'sheet':
        parts = []
        for s in cap.get('sheets') or []:
            parts.append(s.get('label') or '')
            parts.append(s.get('text') or '')
            for line in (s.get('text') or '').split('\n'):
                for c in line.split('\t'):
                    n = norm(c)
                    if n:
                        cells.add(n)
        t = '\n'.join(parts)
    elif k in ('pdf', 'hwp'):
        t = '\n'.join((p or {}).get('text') or '' for p in cap.get('pages') or [])
    else:
        t = (cap.get('text') or '') + '\n' + (cap.get('svgText') or '')
    return t, cells


def lo_units(ref, fid, inv):
    """LibreOffice 기준 글자를 단위로 자른다."""
    d = os.path.join(ref, fid)
    out = []
    if not os.path.isdir(d):
        return out
    hidden_sheets = {n for n, st in (inv.get('meta') or {}).get('sheets', []) if st != 'visible'}
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if n == 'writer.txt':
            for line in open(p, encoding='utf-8', errors='replace'):
                if line.strip():
                    out.append({'cat': 'lo.writer', 'text': line.strip(), 'where': 'writer'})
        elif n == 'impress.txt':
            for line in open(p, encoding='utf-8', errors='replace'):
                if line.strip():
                    out.append({'cat': 'lo.impress', 'text': line.strip(), 'where': 'impress'})
        elif n.startswith('calc-') and n.endswith('.csv'):
            sheet = n[5:-4]
            cat = 'lo.calc_hidden' if sheet in hidden_sheets else 'lo.calc'
            import csv
            try:
                with open(p, encoding='utf-8', errors='replace', newline='') as f:
                    for ri, row in enumerate(csv.reader(f)):
                        if ri >= 3000:
                            break
                        for ci, c in enumerate(row[:200]):
                            if c.strip():
                                out.append({'cat': cat, 'text': c.strip(), 'where': f'{sheet}!R{ri + 1}C{ci + 1}'})
            except Exception:
                pass
        elif n == 'pdf.txt':
            pages = open(p, encoding='utf-8', errors='replace').read().split('\f')
            for pi, page in enumerate(pages[:40]):
                for line in page.split('\n'):
                    if line.strip():
                        out.append({'cat': 'pdf.page_text', 'text': line.strip(), 'where': f'p{pi + 1}'})
    return out


def note_covers(notes, words):
    return any(any(w in n for w in words) for n in notes)


def compare_file(cap, inv, ref):
    final = cap.get('final') or {}
    rec = {'id': cap['id'], 'file': cap['file'], 'state': final.get('state'), 'kind': final.get('kind'), 'reason': final.get('reason'),
           'engine': final.get('engine'), 'notes': cap.get('notes') or [], 'shot': cap.get('shot'), 'fmt': inv.get('fmt') if inv else None,
           'via': inv.get('via') if inv else None}
    if final.get('state') != 'rendered':
        rec['skip'] = 'not-rendered'
        return rec
    hay_raw, cellset = viewer_text(cap)
    hay = norm(hay_raw)
    rec['viewerChars'] = len(hay)
    # 쪽 수 한도: HWP·PDF는 capture가 앞 40쪽만 읽는다
    pages_cut = cap.get('pageCount') and len(cap.get('pages') or []) < cap.get('pageCount')
    rec['pagesCut'] = bool(pages_cut)
    units = list((inv or {}).get('units') or []) + lo_units(ref, cap['id'], inv or {})
    cats = defaultdict(lambda: {'units': 0, 'chars': 0, 'missing': 0, 'missChars': 0, 'partial': 0, 'num_units': 0, 'num_missing': 0, 'examples': [], 'numExamples': []})
    seen = set()
    stem = cap['id'].rsplit('.', 1)[0]
    for u in units:
        cat = u['cat']
        if cat in CANVAS_ONLY:
            continue
        # LibreOffice가 바꾼 파일에서 '파일 이름' 필드가 임시 경로·이름으로 바뀐 것은 비교에서 뺀다
        if '/ref/tmp' in u['text'] or stem in u['text']:
            continue
        nu = norm(u['text'])
        if len(nu) < 2:
            continue
        key = (cat, nu)
        if key in seen:
            continue
        seen.add(key)
        c = cats[cat]
        if numeric(nu):
            c['num_units'] += 1
            st, _ = match(nu, hay, cellset)
            if st == 'missing':
                c['num_missing'] += 1
                if len(c['numExamples']) < 5:
                    c['numExamples'].append(f"{u['where']}: {u['text'][:40]}")
            continue
        c['units'] += 1
        c['chars'] += len(nu)
        st, r = match(nu, hay, cellset, u['text'])
        if st == 'missing':
            c['missing'] += 1
            c['missChars'] += len(nu)
            if len(c['examples']) < 8:
                c['examples'].append(f"[{u['where']}] {u['text'][:150]}")
        elif st == 'partial':
            c['partial'] += 1
            c['missChars'] += int(len(nu) * (1 - r))
    rec['cats'] = {k: v for k, v in cats.items()}
    # 물건(비글자) 목록과 화면 증거
    objs = (inv or {}).get('objects') or {}
    rec['objects'] = {k: {'count': v['count'], 'samples': v['samples'][:3]} for k, v in objs.items()}
    ev = {}
    if final.get('kind') == 'sheet':
        ev['sheetImages'] = sum((s.get('images') or 0) for s in cap.get('sheets') or [])
        ev['sheetImagesBroken'] = sum((s.get('imagesBroken') or 0) for s in cap.get('sheets') or [])
        ev['emptySheets'] = [s.get('label') for s in cap.get('sheets') or [] if s.get('empty')]
        ev['tabs'] = [s.get('label') for s in cap.get('sheets') or []]
        ev['sheetNotes'] = [s.get('note') for s in cap.get('sheets') or [] if s.get('note')]
    elif final.get('kind') in ('word', 'slides', 'simple'):
        ev['media'] = cap.get('media')
        if final.get('kind') == 'slides':
            ev['slideCount'] = cap.get('slideCount')
            ev['reportedSlides'] = final.get('pages')
    elif final.get('kind') in ('pdf', 'hwp'):
        ev['pageCount'] = cap.get('pageCount')
        ev['captured'] = len(cap.get('pages') or [])
        imgs = Counter()
        for p in cap.get('pages') or []:
            for k, v in ((p or {}).get('images') or {}).items():
                imgs[k] += v
        ev['svgImageTypes'] = dict(imgs)
        ev['pageErrors'] = sum(1 for p in cap.get('pages') or [] if (p or {}).get('err'))
        ev['native'] = final.get('engine') != 'pdfjs' and final.get('kind') == 'pdf'
    rec['evidence'] = ev
    allnotes = rec['notes'] + ev.get('sheetNotes', [])
    rec['noteAny'] = bool(allnotes)
    rec['noteCovers'] = {k: note_covers(allnotes, w) for k, w in NOTE_WORDS.items() if note_covers(allnotes, w)}
    return rec


def main():
    a = sys.argv
    get = lambda k, d=None: a[a.index(k) + 1] if k in a else d
    caps = {}
    # 쉼표로 여러 capture 파일을 줄 수 있다(뒤의 것이 같은 파일의 앞 결과를 덮는다: 쪽 수 늘린 재실행 등)
    for cp in get('--capture').split(','):
        for k, v in load_capture(cp).items():
            if v.get('harnessError') and k in caps:
                continue  # 하네스 오류로 잘린 기록은 앞의 정상 기록을 덮지 않는다
            caps[k] = v
    invdir, ref, out = get('--inv'), get('--ref'), get('--out')
    res = []
    for fid, cap in caps.items():
        p = os.path.join(invdir, fid + '.json')
        inv = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else None
        res.append(compare_file(cap, inv, ref))
    json.dump(res, open(out + '.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    # 파일별 요약
    with open(out + '-files.tsv', 'w', encoding='utf-8') as f:
        f.write('id\tstate\tkind\tfmt\tbody_cov\tmissing_show\tmissing_note\tnote\tobjects\n')
        for r in res:
            if r.get('skip'):
                f.write(f"{r['id']}\t{r['state']}\t{r.get('kind')}\t{r.get('fmt')}\t\t\t\t{r.get('reason') or ''}\t\n")
                continue
            show = {k: v for k, v in r['cats'].items() if CATEGORY.get(k, ('', 'show'))[1] == 'show'}
            tot = sum(v['chars'] for v in show.values())
            miss = sum(v['missChars'] for v in show.values())
            cov = 1 - miss / tot if tot else 1
            ms = ','.join(f"{k}:{v['missing']}/{v['units']}" for k, v in show.items() if v['missing'])
            mn = ','.join(f"{k}:{v['missing']}/{v['units']}" for k, v in r['cats'].items() if CATEGORY.get(k, ('', 'show'))[1] == 'note' and v['missing'])
            objs = ','.join(f"{k}={v['count']}" for k, v in r['objects'].items())
            f.write(f"{r['id']}\t{r['state']}\t{r.get('kind')}\t{r.get('fmt')}\t{cov:.3f}\t{ms}\t{mn}\t{' | '.join(r['notes'])[:120]}\t{objs[:400]}\n")
    # 분류별 합계
    agg = defaultdict(lambda: Counter())
    for r in res:
        if r.get('skip'):
            continue
        for k, v in r['cats'].items():
            a2 = agg[k]
            a2['files'] += 1
            a2['units'] += v['units']
            a2['missing'] += v['missing']
            a2['missChars'] += v['missChars']
            a2['chars'] += v['chars']
            if v['missing']:
                a2['filesWithMissing'] += 1
                if not r['noteAny']:
                    a2['filesMissingNoNote'] += 1
    with open(out + '-cats.tsv', 'w', encoding='utf-8') as f:
        f.write('cat\tname\texpect\tfiles\tunits\tmissing\tchars\tmissChars\tfilesWithMissing\tfilesMissingNoNote\n')
        for k, v in sorted(agg.items()):
            name, exp = CATEGORY.get(k, (k, '?'))
            f.write(f"{k}\t{name}\t{exp}\t{v['files']}\t{v['units']}\t{v['missing']}\t{v['chars']}\t{v['missChars']}\t{v['filesWithMissing']}\t{v['filesMissingNoNote']}\n")
    print('files', len(res))


if __name__ == '__main__':
    main()
