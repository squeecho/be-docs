#!/usr/bin/env python3
"""findings-summary.tsv·compare-cats.tsv를 마크다운 표로 찍는다(보고서에 붙이기용).
사용법: python3 -I tables.py out/findings-summary.tsv out/compare-cats.tsv
"""
import csv, sys


def rows(p):
    with open(p, encoding='utf-8') as f:
        return list(csv.DictReader(f, delimiter='\t'))


summ = rows(sys.argv[1])
print('| 분류 | 영향 | 파일 수 | 개수 | 안내 없음 / 일반 문구만 / 해당 안내 | 예시 파일(개수) |')
print('|---|---|---|---|---|---|')
for r in summ:
    print(f"| {r['name']} (`{r['key']}`) | {r['score']} | {r['files']} | {r['count']} | {r['note_none']} / {r['note_generic']} / {r['note_covers']} | {r['examples']} |")
print()
if len(sys.argv) > 2:
    cats = rows(sys.argv[2])
    print('| 글자 분류 | 기대 | 파일 | 단위 | 빠진 단위 | 빠진 글자/전체 글자 | 빠진 파일(안내 없음) |')
    print('|---|---|---|---|---|---|---|')
    for r in cats:
        print(f"| {r['name']} (`{r['cat']}`) | {r['expect']} | {r['files']} | {r['units']} | {r['missing']} | {r['missChars']}/{r['chars']} | {r['filesWithMissing']}({r['filesMissingNoNote']}) |")
