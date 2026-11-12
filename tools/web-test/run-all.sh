#!/usr/bin/env bash
# 뷰어 화면 시험을 전부 차례로 돌린다. 하나라도 실패하면 마지막에 실패로 끝난다.
# 사용: ./run-all.sh [포트]   옛 크롬: CHROME=/path/to/chromium ./run-all.sh   빠르게: QUICK=1 ./run-all.sh
set -u
cd "$(dirname "$0")"
port="${1:-8731}"
assets=../../app/src/main/assets/viewer
matrix=../../app/src/androidTest/assets/matrix
out="$(mktemp -d)"
node server.mjs "$assets" "$assets/vendor" "$port" > "$out/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; rm -rf "$out"' EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/viewer/index.html" && break; sleep 0.2; done

failed=()
run() {
  local name="$1"; shift
  echo "== $name"
  if "$@" > "$out/$name.log" 2>&1; then
    tail -1 "$out/$name.log"
  else
    grep -E "^FAIL|합계|조합 [0-9]+개|Error" "$out/$name.log" | head -20
    failed+=("$name")
  fi
}
run 단위 node docx-read-test.mjs
run 번역 node i18n-test.mjs
run 매트릭스 node matrix.mjs "$port" "$matrix" "$out/shots"
run 사용성 node ux.mjs "$port" "$matrix"
run 상태조합 node states.mjs "$port" "$matrix"
run 보안 node security.mjs "$port" xss-samples

if [ ${#failed[@]} -eq 0 ]; then echo "모두 통과"; else echo "실패: ${failed[*]}"; exit 1; fi
