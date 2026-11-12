# 사용: python3 gen-long-word.py <저장할 경로>   (python-docx 필요)
# 읽기 보기 시험용 긴 워드 문서(약 40쪽): 제목·번호 목록·머리말·긴 표(세로 합친 칸 포함)·끝 표식
import sys
from docx import Document
from docx.shared import Pt
out = sys.argv[1]
d = Document()
d.sections[0].header.paragraphs[0].text = '사내 업무 안내서 · 머리말 표식'
d.add_heading('업무 처리 안내서', 0)
body = ('이 문단은 읽기 보기 시험을 위해 만든 긴 문서의 본문입니다. 부서별 협조 사항과 처리 기한, 담당자 확인 절차를 '
        '차례대로 적었습니다. 실제 회사나 사람과는 관계없는 지어낸 내용입니다. ')
for ch in range(1, 13):
    d.add_heading(f'{ch}장 처리 절차', 1)
    for k in range(1, 4):
        d.add_paragraph(f'{ch}-{k}단계 확인 사항', style='List Number')
    for k in range(22):
        d.add_paragraph(body * 2)
    if ch == 6:
        t = d.add_table(rows=200, cols=4)
        t.style = 'Table Grid'
        for r in range(200):
            cells = t.rows[r].cells
            cells[0].text = f'{r + 1}'
            cells[1].text = f'항목 {r + 1:03d}'
            cells[2].text = '협조 부서 확인 후 처리'
            cells[3].text = f'{(r * 37) % 1000:,}원'
        # 세로로 합친 칸(99~102줄): 표를 100줄에서 나눠 그리면 이 칸이 잘리므로 102줄 뒤에서 끊어야 한다
        t.cell(98, 2).merge(t.cell(101, 2))
p = d.add_paragraph('끝 문단 표식 4729')
d.save(out)
