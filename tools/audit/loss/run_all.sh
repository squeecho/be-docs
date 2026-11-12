#!/usr/bin/env bash
# 완전성 오라클 전체 실행. 새 뷰어에 다시 돌릴 때는 VIEWER·PORTS만 바꾸면 된다.
#
#   VIEWER=/path/to/viewer PORTS=8941,8942 OUT=/path/to/out bash run_all.sh <목록 파일> [재사용할 ref 폴더]
#
#   목록: 한 줄에 "절대경로" 또는 "절대경로<TAB>비밀번호"
#   1) reftext.py   LibreOffice·pdftotext 기준 글자(+옛 형식 → OOXML 변환). 뷰어와 무관하므로 ref 폴더를 재사용해도 된다.
#   2) inventory.py 파일 구조에서 물건·글자 목록(뷰어와 무관)
#   3) capture.mjs  뷰어 화면에서 글자·그림·안내 띠·잘린 칸/쪽 수집(뷰어 바뀌면 이것만 다시)
#   4) compare.py   글자 대조(분류별 빠진 단위)
#   5) summarize.py 조용한 손실 분류표(findings*.tsv)
# 브라우저 페이지는 PORTS 개수만큼 동시에 연다(공유 기계에서는 2개 이하).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIST="$(realpath "$1")"
VIEWER="${VIEWER:?VIEWER=<viewer 폴더>}"
PORTS="${PORTS:-8941,8942}"
OUT="${OUT:-$(pwd)/out-run}"
REF="${2:-$OUT/ref}"
mkdir -p "$OUT"
export LC_ALL=C.UTF-8 LANG=C.UTF-8
if [ ! -d "$REF" ] || [ -z "$(ls -A "$REF" 2>/dev/null)" ]; then
  python3 -I "$HERE/reftext.py" "$LIST" "$REF" --lo-profile "$OUT/lo-profile"
fi
python3 -I "$HERE/inventory.py" "$LIST" "$OUT/inv" --ref "$REF"
node "$HERE/capture.mjs" --viewer "$VIEWER" --list "$LIST" --out "$OUT/capture.jsonl" --shots "$OUT/shots" --ports "$PORTS" --resume
python3 -I "$HERE/compare.py" --capture "$OUT/capture.jsonl" --inv "$OUT/inv" --ref "$REF" --out "$OUT/compare"
python3 -I "$HERE/summarize.py" "$OUT/compare.json" "$OUT/findings" "$OUT/capture.jsonl" "$OUT/inv"
echo "결과: $OUT/findings-summary.tsv (분류별), $OUT/findings.tsv (파일별), $OUT/compare-cats.tsv (글자 대조)"
