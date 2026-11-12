"""빠른 읽기와 엔진 읽기 보기의 글 대조 결과(run.mjs가 만든 jsonl)를 요약한다.

같은 글(공백·쪽 나눔 표시·제목 표시 무시)인 문서 수, 엔진에는 있는데 빠른 읽기에 없는 글자 수(누락)를 센다.
누락은 0에 가까워야 한다. 빠른 읽기에만 있는 글(글상자·미주 번호 등)은 누락으로 세지 않는다.
사용: python3 tools/audit/docx-read/analyze.py <결과.jsonl> [보여 줄 문서 수]
"""
import difflib
import json
import re
import sys


def norm(s):
    return re.sub(r'\s+|<쪽>|#\d ', '', s or '')


def main():
    rows = [json.loads(line) for line in open(sys.argv[1], encoding='utf-8')]
    show = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    stats = {'문서': len(rows), '둘 다 읽음': 0, '같음': 0, '엔진만 실패': 0, '빠른 읽기만 실패': 0, '둘 다 실패': 0, '도구 오류': 0}
    engine_chars = 0
    missing = 0
    worst = []
    for r in rows:
        if r.get('harnessErr'):
            stats['도구 오류'] += 1
            continue
        e_err, f_err = bool(r.get('engineErr')), bool(r.get('fastErr'))
        if e_err and f_err:
            stats['둘 다 실패'] += 1
            continue
        if e_err:
            stats['엔진만 실패'] += 1
            continue
        if f_err:
            stats['빠른 읽기만 실패'] += 1
            print('빠른 읽기만 실패:', r['file'], r['fastErr'])
            continue
        stats['둘 다 읽음'] += 1
        a, b = norm(r['engine']), norm(r['fast'])
        engine_chars += len(a)
        if a == b:
            stats['같음'] += 1
            continue
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        lost = [(i1, i2) for op, i1, i2, _j1, _j2 in sm.get_opcodes() if op in ('delete', 'replace')]
        n = sum(i2 - i1 for i1, i2 in lost)
        missing += n
        if n:
            worst.append((n, r['file'], [a[i1:i2][:50] for i1, i2 in lost[:3]]))
    print(stats)
    pct = missing / engine_chars * 100 if engine_chars else 0
    print(f'엔진 글자 {engine_chars:,}자 중 빠른 읽기에 없는 글자 {missing:,}자({pct:.3f}%)')
    for n, f, samples in sorted(worst, reverse=True)[:show]:
        print(f'  {n:6d}  {f}  {samples}')


if __name__ == '__main__':
    main()
