#!/usr/bin/env python3
"""완전성 오라클 5단계: compare.py 결과에서 '조용한 손실' 후보를 분류별로 뽑는다.

사용법: python3 -I summarize.py out/compare.json out/findings
결과:
  <out>.tsv          파일 × 손실 분류 한 줄씩(개수, 근거, 안내 띠 상태, 스크린샷)
  <out>-summary.tsv  분류별 합계(파일 수, 개수, 안내 없이 빠진 파일 수, 예시 파일)
  안내 상태: none(안내 띠 없음) / generic(띠는 있으나 이 내용을 말하지 않음) / covers(이 내용을 말함)
규칙은 아래 RULES 표에 있다. 새 분류를 찾으면 여기에 더하면 된다.
"""
import json, sys
from collections import defaultdict

# 분류 키: (이름, 확인할 안내 낱말 묶음, 영향 점수 1~5)
NAMES = {
    'XL_CHART': ('엑셀 차트가 그려지지 않음', 'chart', 5),
    'XL_EMPTY_SHEET_FALSE': ('도형·차트·그림만 있는 시트를 "빈 시트예요"로 표시', 'chart', 5),
    'XL_SHAPE_TEXT': ('엑셀 도형·글상자 속 글자 빠짐', 'shape', 4),
    'XL_SHAPE': ('엑셀 도형·선·화살표·묶음 빠짐', 'shape', 3),
    'XL_PIC_DROPPED': ('엑셀 그림 빠짐(EMF·WMF·묶음 속·절대 위치)', 'pic', 4),
    'XL_PIC_SHORT': ('엑셀 그림 수가 원본보다 적음', 'pic', 4),
    'XL_COMMENT': ('엑셀 메모(노트) 빠짐', 'comment', 4),
    'XL_HIDDEN_SHEET': ('숨긴 시트(탭 없음, 안내 없음)', 'hidden', 2),
    'XL_FORM_CONTROL': ('엑셀 확인란·단추 등 양식 컨트롤 빠짐', 'form', 3),
    'XL_OLE': ('엑셀 안에 넣은 개체(다른 문서) 빠짐', 'pic', 3),
    'XL_COND_FORMAT': ('조건부 서식(빨간 칸 등 강조) 빠짐', None, 2),
    'XL_SPARKLINE': ('스파크라인(칸 안 작은 차트) 빠짐', 'chart', 2),
    'XL_OUTSIDE_DIM': ('시트 크기 표시(dimension)보다 바깥 칸이 잘림', None, 5),
    'XL_CLIPPED': ('긴 글자 칸이 말줄임(…)으로 잘리고 펼칠 수 없음', None, 3),
    'XL_CELL_TEXT': ('엑셀 칸 글자 빠짐(그 밖의 이유)', None, 4),
    'XL_DV_LIST': ('드롭다운 목록(선택지) 표시 없음', None, 1),
    'XL_HEADER_FOOTER': ('인쇄 머리글·바닥글 빠짐', 'header', 1),
    'W_COMMENT': ('워드 메모(검토 의견) 빠짐', 'comment', 4),
    'W_CHART': ('워드 차트 빠짐', 'chart', 4),
    'W_SMARTART': ('워드 SmartArt 빠짐', 'smartart', 3),
    'W_EQUATION': ('워드 수식 빠짐', 'equation', 4),
    'W_ALTCHUNK': ('워드 altChunk(끼워 넣은 HTML·RTF 본문) 빠짐', None, 4),
    'W_WATERMARK': ('워드 워터마크(대외비 등) 빠짐', None, 3),
    'W_OLE': ('워드 속 개체(엑셀 표 등) 미리보기 빠짐', 'pic', 4),
    'W_PIC_UNSUPPORTED': ('워드 EMF·WMF·TIFF 그림 빠짐', 'pic', 4),
    'W_TEXTBOX': ('워드 글상자 글자 빠짐', 'shape', 4),
    'W_HEADER_FOOTER': ('워드 머리말·꼬리말 글자 빠짐', 'header', 2),
    'W_BODY': ('워드 본문 글자 빠짐', None, 5),
    'W_TRACKED': ('변경 추적(삽입·삭제 표시)이 있다는 안내 없음', None, 2),
    'W_CLIPPED': ('쪽 아래로 넘친 글자가 잘려 안 보임', None, 4),
    'W_BROKEN_IMG': ('워드 깨진 그림 아이콘', 'pic', 3),
    'P_TEXT': ('슬라이드 글자 빠짐', None, 5),
    'P_NOTES': ('발표자 노트 빠짐', 'notes', 3),
    'P_COMMENT': ('슬라이드 메모 빠짐', 'comment', 3),
    'P_CHART': ('슬라이드 차트 빠짐(옛 ppt)', 'chart', 4),
    'P_OLE': ('슬라이드 속 개체(엑셀 표·수식 등) 빠짐', 'pic', 4),
    'P_PIC_UNSUPPORTED': ('슬라이드 EMF·WMF·TIFF 그림 빠짐', 'pic', 4),
    'P_BROKEN_IMG': ('슬라이드 깨진 그림', 'pic', 3),
    'P_MEDIA': ('동영상·소리 재생 불가, 안내 없음', 'media', 2),
    'P_MASTER': ('마스터·레이아웃 고정 글자 빠짐', None, 3),
    'H_MEMO': ('한글 메모 빠짐', 'comment', 4),
    'H_TEXT': ('한글 글자 빠짐', None, 5),
    'H_FORM': ('한글 양식 개체(확인란 등)', 'form', 3),
    'H_EQUATION': ('한글 수식', 'equation', 3),
    'H_OLE': ('한글 OLE 개체·차트', 'chart', 3),
    'PDF_ATTACHMENT': ('PDF 첨부 파일 존재를 알리지 않음', 'attachment', 4),
    'PDF_NOTE': ('PDF 메모 주석 내용 볼 수 없음', 'comment', 3),
    'PDF_NATIVE': ('pdf.js 실패 → 내장 렌더러(주석·글자 선택 빠짐) 안내 없음', None, 3),
    'PDF_TEXT': ('PDF 글자 층 빠짐', None, 2),
    'S_HEADER_FOOTER': ('간단 보기: 머리말·꼬리말 빠짐', 'header', 3),
    'S_FOOTNOTE': ('간단 보기: 각주 빠짐', 'footnote', 3),
    'S_COMMENT': ('간단 보기: 메모 빠짐', 'comment', 3),
    'S_OBJECT': ('간단 보기: 차트·개체 빠짐', 'chart', 3),
    'S_NOTES': ('간단 보기(ODP): 발표자 노트 빠짐', 'notes', 2),
    'S_TEXT': ('간단 보기: 본문 글자가 빠지거나 깨짐(코드 페이지 오판 등)', None, 4),
}

NOTE_WORDS = {
    'comment': ['메모', '댓글', '의견', '주석'], 'notes': ['노트'], 'chart': ['차트', '그래프'], 'shape': ['도형', '글상자'],
    'hidden': ['숨긴', '숨김'], 'header': ['머리', '꼬리', '바닥'], 'footnote': ['각주', '미주'], 'pic': ['그림', '이미지'],
    'equation': ['수식'], 'smartart': ['SmartArt', '스마트아트'], 'media': ['동영상', '소리', '오디오', '비디오'],
    'attachment': ['첨부'], 'form': ['양식', '확인란', '입력 칸'],
}


def ocount(r, *keys):
    return sum((r['objects'].get(k) or {}).get('count', 0) for k in keys)


def osamples(r, *keys):
    out = []
    for k in keys:
        out += (r['objects'].get(k) or {}).get('samples', [])
    return out[:3]


def miss(r, *cats):
    m = u = 0
    ex = []
    for c in cats:
        v = (r.get('cats') or {}).get(c)
        if v:
            m += v['missing']
            u += v['units']
            ex += v['examples'][:3]
    return m, u, ex


def rules(r, cap):
    f = []
    ev = r.get('evidence') or {}
    add = lambda key, n, detail: f.append((key, n, detail))
    k = r.get('kind')
    if k == 'sheet':
        n = ocount(r, 'xl.chart', 'xl.chartsheet')
        if n: add('XL_CHART', n, '; '.join(osamples(r, 'xl.chart', 'xl.chartsheet')))
        so = ((cap.get('inv') or {}).get('meta') or {}).get('sheetObjects') or {}
        false_empty = [s for s in ev.get('emptySheets') or [] if so.get(s)]
        if false_empty: add('XL_EMPTY_SHEET_FALSE', len(false_empty), ', '.join(f"{s}: {so[s]}" for s in false_empty[:4]))
        n = ocount(r, 'xl.shape_text')
        if n:
            m, u, ex = miss(r, 'xl.shape_text')
            add('XL_SHAPE_TEXT', n, f'글자 단위 {m}/{u} 화면에 없음; ' + ' | '.join(ex[:2] or osamples(r, 'xl.shape_text')))
        n = ocount(r, 'xl.shape', 'xl.connector', 'xl.ink', 'xl.smartart', 'xl.graphic_other')
        if n: add('XL_SHAPE', n, '; '.join(osamples(r, 'xl.shape', 'xl.connector')))
        # 칸 없는 시트의 그림(pic_on_empty_sheet)은 시트가 '빈 시트예요'로 나올 때만 빠진다 → XL_EMPTY_SHEET_FALSE에서 센다
        n = ocount(r, 'xl.pic_dropped', 'xl.background_image', 'xl.richdata_part')
        if n: add('XL_PIC_DROPPED', n, '; '.join(osamples(r, 'xl.pic_dropped', 'xl.richdata_part')))
        shown = ocount(r, 'xl.pic_shown')
        if shown and (ev.get('sheetImages') or 0) < shown:
            add('XL_PIC_SHORT', shown - (ev.get('sheetImages') or 0), f"원본(뷰어가 보여야 할) {shown}장, 화면 {ev.get('sheetImages')}장")
        n = ocount(r, 'xl.comment', 'xl.threaded_comment')
        if n:
            m, u, ex = miss(r, 'xl.comment')
            add('XL_COMMENT', n, f'메모 글 {m}/{u}개는 화면 어디에도 없음; ' + ' | '.join(ex[:2]))
        n = ocount(r, 'xl.hidden_sheet')
        if n: add('XL_HIDDEN_SHEET', n, '; '.join(osamples(r, 'xl.hidden_sheet')))
        n = ocount(r, 'xl.form_control', 'xl.vml_checkbox', 'xl.vml_button', 'xl.vml_drop', 'xl.vml_radio', 'xl.vml_list')
        if n: add('XL_FORM_CONTROL', ocount(r, 'xl.form_control') or n, '; '.join(osamples(r, 'xl.vml_checkbox', 'xl.vml_button', 'xl.form_control')))
        n = ocount(r, 'xl.ole', 'xl.embedding')
        if n: add('XL_OLE', ocount(r, 'xl.ole') or n, '; '.join(osamples(r, 'xl.ole', 'xl.embedding')))
        n = ocount(r, 'xl.cond_format')
        if n: add('XL_COND_FORMAT', n, '')
        n = ocount(r, 'xl.sparkline')
        if n: add('XL_SPARKLINE', n, '')
        n = ocount(r, 'xl.outside_dimension')
        if n: add('XL_OUTSIDE_DIM', n, '; '.join(osamples(r, 'xl.outside_dimension')))
        clipped = sum((s.get('clipped') or 0) for s in cap.get('sheets') or [])
        if clipped:
            ex = [f"{x['len']}자 중 약 {x['shownApprox']}자만 보임: {x['text'][:60]}" for s in cap.get('sheets') or [] for x in (s.get('clipSamples') or [])][:2]
            add('XL_CLIPPED', clipped, ' | '.join(ex))
        m, u, ex = miss(r, 'xl.cell')
        if m: add('XL_CELL_TEXT', m, ' | '.join(ex[:3]))
        n = ocount(r, 'xl.dv_list')
        if n: add('XL_DV_LIST', n, '')
        n = ocount(r, 'xl.header_footer')
        if n:
            m, u, ex = miss(r, 'xl.header_footer')
            if m: add('XL_HEADER_FOOTER', m, ' | '.join(ex[:2]))
    elif k == 'word':
        n = ocount(r, 'w.comment')
        if n:
            m, u, ex = miss(r, 'w.comment')
            add('W_COMMENT', n, f'메모 글 {m}/{u} 화면에 없음; ' + ' | '.join(ex[:2]))
        n = ocount(r, 'w.chart')
        if n:
            m, u, ex = miss(r, 'w.chart')
            # 차트는 SVG 그림으로 그려진다(capture의 svgText). 그 글자까지 없을 때만 손실로 본다.
            if m: add('W_CHART', n, f'차트 글자 {m}/{u} 없음; ' + '; '.join(osamples(r, 'w.chart')))
        n = ocount(r, 'w.smartart')
        if n: add('W_SMARTART', n, '; '.join(osamples(r, 'w.smartart')))
        m, u, ex = miss(r, 'w.equation')
        if ocount(r, 'w.equation') and m: add('W_EQUATION', m, ' | '.join(ex[:2]))
        n = ocount(r, 'w.altchunk')
        if n: add('W_ALTCHUNK', n, '; '.join(osamples(r, 'w.altchunk')))
        m, u, ex = miss(r, 'w.watermark')
        if m: add('W_WATERMARK', m, ' | '.join(ex[:2]))
        n = ocount(r, 'w.ole')
        media = ev.get('media') or {}
        # 미리보기 그림이 EMF·WMF면 뷰어는 'emf'·'wmf' 글자만 적힌 빈 상자를 그린다(capture 글자에 'emf'·'wmf'가 남는다)
        if n: add('W_OLE', n, '; '.join(osamples(r, 'w.ole', 'w.vml_pic_unsupported')))
        n = ocount(r, 'w.pic_unsupported') + max(0, ocount(r, 'w.vml_pic_unsupported') - ocount(r, 'w.ole'))
        if n: add('W_PIC_UNSUPPORTED', n, '; '.join(osamples(r, 'w.pic_unsupported', 'w.vml_pic_unsupported')))
        m, u, ex = miss(r, 'w.textbox')
        if m: add('W_TEXTBOX', m, ' | '.join(ex[:2]))
        m, u, ex = miss(r, 'w.header', 'w.footer')
        if m: add('W_HEADER_FOOTER', m, ' | '.join(ex[:2]))
        m, u, ex = miss(r, 'w.body', 'w.footnote', 'w.endnote')
        if m: add('W_BODY', m, ' | '.join(ex[:3]))
        n = ocount(r, 'w.tracked_ins', 'w.tracked_del', 'w.tracked_move')
        if n: add('W_TRACKED', n, '삭제된 글자는 숨기고 삽입은 그냥 본문으로 보임')
        clip = cap.get('clip') or {}
        if clip.get('out'):
            add('W_CLIPPED', clip['out'], ' | '.join(f"{s['page']}쪽: {s['text'][:60]}" for s in clip.get('samples', [])[:3]))
        if media.get('imgBroken'): add('W_BROKEN_IMG', media['imgBroken'], '')
    elif k == 'slides':
        m, u, ex = miss(r, 'p.slide_text', 'p.group_text', 'p.smartart', 'p.equation')
        if m: add('P_TEXT', m, f'{m}/{u} 단위; ' + ' | '.join(ex[:3]))
        m2, u2, ex2 = miss(r, 'p.notes')
        if ocount(r, 'p.notes'): add('P_NOTES', ocount(r, 'p.notes'), f'노트 글 {m2}/{u2} 단위는 슬라이드에도 없음; ' + ' | '.join(ex2[:2]))
        if ocount(r, 'p.comment'): add('P_COMMENT', ocount(r, 'p.comment'), '; '.join(osamples(r, 'p.comment')))
        m3, u3, ex3 = miss(r, 'p.chart')
        if m3 and r.get('fmt') == 'pptx': add('P_CHART', ocount(r, 'p.chart'), f'차트 글자 {m3}/{u3} 없음; ' + ' | '.join(ex3[:2]))
        n = ocount(r, 'p.ole')
        if n: add('P_OLE', n, f"미리보기 EMF·WMF {ocount(r, 'p.ole_preview_unsupported')}개; " + '; '.join(osamples(r, 'p.ole')))
        n = ocount(r, 'p.pic_unsupported', 'p.master_pic_unsupported', 'p.shape_fill_pic_unsupported')
        if n: add('P_PIC_UNSUPPORTED', n, '; '.join(osamples(r, 'p.pic_unsupported', 'p.master_pic_unsupported')))
        media = ev.get('media') or {}
        if media.get('imgBroken'): add('P_BROKEN_IMG', media['imgBroken'], '')
        n = ocount(r, 'p.media_shape', 'p.media_video', 'p.media_audio')
        if n: add('P_MEDIA', n, '; '.join(osamples(r, 'p.media_video', 'p.media_audio', 'p.media_shape')))
        m4, u4, ex4 = miss(r, 'p.master_text')
        if m4: add('P_MASTER', m4, ' | '.join(ex4[:2]))
        m5, u5, ex5 = miss(r, 'lo.impress')
        if m5 and not m: add('P_TEXT', m5, f'(LibreOffice 기준) {m5}/{u5} 줄; ' + ' | '.join(ex5[:3]))
    elif k == 'hwp':
        m, u, ex = miss(r, 'h.memo')
        if ocount(r, 'h.memo', 'h.memo_list'): add('H_MEMO', max(ocount(r, 'h.memo_list'), ocount(r, 'h.memo')), f'메모 글 {m}/{u} 단위 화면에 없음; ' + ' | '.join(ex[:2]))
        if not r.get('pagesCut'):
            m, u, ex = miss(r, 'h.body', 'h.header', 'h.footer', 'h.footnote', 'h.endnote', 'h.shape_text', 'h.caption', 'h.master_page')
            if m: add('H_TEXT', m, ' | '.join(ex[:3]))
        n = ocount(r, 'h.form_object') or ocount(r, 'h.form_btn', 'h.form_checkBtn', 'h.form_radioBtn', 'h.form_comboBox', 'h.form_edit', 'h.form_listBox')
        if n: add('H_FORM', n, '')
        n = ocount(r, 'h.equation')
        if n: add('H_EQUATION', n, '; '.join(osamples(r, 'h.equation')))
        n = ocount(r, 'h.ole', 'h.chart', 'h.chart_data', 'h.ole_component')
        if n: add('H_OLE', n, '')
    elif k == 'pdf':
        n = ocount(r, 'pdf.attachment', 'pdf.attachment_annot')
        if n: add('PDF_ATTACHMENT', n, '; '.join(osamples(r, 'pdf.attachment', 'pdf.attachment_annot')))
        n = sum(v['count'] for kk, v in r['objects'].items() if kk.startswith('pdf.annot_') and not kk.startswith(('pdf.annot_Link', 'pdf.annot_Popup')) and v['samples'] and ':' in v['samples'][0])
        m, u, ex = miss(r, 'pdf.annot_comment')
        if m: add('PDF_NOTE', m, ' | '.join(ex[:2]))
        if ev.get('native'): add('PDF_NATIVE', 1, '')
        if not r.get('pagesCut'):
            m, u, ex = miss(r, 'pdf.page_text')
            if m: add('PDF_TEXT', m, f'{m}/{u} 줄; ' + ' | '.join(ex[:2]))
    elif k == 'simple':
        n = ocount(r, 'r.header', 'r.footer', 'o.header', 'o.footer')
        if n: add('S_HEADER_FOOTER', n, ' | '.join(miss(r, 'o.header_footer')[2][:2]))
        n = ocount(r, 'r.footnote', 'o.footnote', 'o.endnote', 'o.note')
        if n: add('S_FOOTNOTE', n, ' | '.join(miss(r, 'o.footnote')[2][:2]))
        n = ocount(r, 'r.comment', 'o.comment')
        if n: add('S_COMMENT', n, ' | '.join(miss(r, 'o.comment')[2][:2]))
        n = ocount(r, 'o.chart', 'o.object', 'r.ole')
        if n: add('S_OBJECT', n, '')
        n = ocount(r, 'o.speaker_notes')
        if n: add('S_NOTES', n, '')
        m, u, ex = miss(r, 'w.body', 'o.body', 'lo.writer')
        if m and u and m / u > 0.05: add('S_TEXT', m, f'{m}/{u} 단위; ' + ' | '.join(ex[:2]))
    return f


def note_state(r, group):
    notes = (r.get('notes') or []) + ((r.get('evidence') or {}).get('sheetNotes') or [])
    if not notes:
        return 'none'
    if group and any(any(w in n for w in NOTE_WORDS[group]) for n in notes):
        return 'covers'
    return 'generic'


def main():
    res = json.load(open(sys.argv[1], encoding='utf-8'))
    out = sys.argv[2]
    caps = {}
    capfile = sys.argv[3] if len(sys.argv) > 3 else 'out/capture.jsonl'
    for cf in capfile.split(','):
        for line in open(cf, encoding='utf-8'):
            try:
                c = json.loads(line)
                if c.get('harnessError') and c['id'] in caps:
                    continue
                caps[c['id']] = c
            except Exception:
                pass
    invdir = sys.argv[4] if len(sys.argv) > 4 else 'inv'
    import os
    rows = []
    for r in res:
        if r.get('skip'):
            continue
        cap = caps.get(r['id'], {})
        p = os.path.join(invdir, r['id'] + '.json')
        cap['inv'] = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
        for key, n, detail in rules(r, cap):
            name, group, score = NAMES[key]
            rows.append({'key': key, 'id': r['id'], 'file': r['file'], 'kind': r.get('kind'), 'fmt': r.get('fmt'), 'n': n, 'detail': detail,
                         'note': note_state(r, group), 'notes': ' | '.join(r.get('notes') or [])[:100], 'shot': r.get('shot') or ''})
    with open(out + '.tsv', 'w', encoding='utf-8') as f:
        f.write('key\tname\tid\tkind\tfmt\tcount\tnote\tdetail\tshot\n')
        for x in rows:
            detail = ' '.join(x['detail'].split())[:300]
            f.write(f"{x['key']}\t{NAMES[x['key']][0]}\t{x['id']}\t{x['kind']}\t{x['fmt']}\t{x['n']}\t{x['note']}\t{detail}\t{x['shot']}\n")
    agg = defaultdict(lambda: {'files': 0, 'count': 0, 'none': 0, 'generic': 0, 'covers': 0, 'examples': []})
    for x in rows:
        a = agg[x['key']]
        a['files'] += 1
        a['count'] += x['n']
        a[x['note']] += 1
        if len(a['examples']) < 4:
            a['examples'].append(f"{x['id'].rsplit('.', 1)[0]}({x['n']})")
    with open(out + '-summary.tsv', 'w', encoding='utf-8') as f:
        f.write('key\tname\tscore\tfiles\tcount\tnote_none\tnote_generic\tnote_covers\texamples\n')
        for key, a in sorted(agg.items(), key=lambda kv: (-NAMES[kv[0]][2], -kv[1]['files'])):
            f.write(f"{key}\t{NAMES[key][0]}\t{NAMES[key][2]}\t{a['files']}\t{a['count']}\t{a['none']}\t{a['generic']}\t{a['covers']}\t{', '.join(a['examples'])}\n")
    print('rows', len(rows))


if __name__ == '__main__':
    main()
