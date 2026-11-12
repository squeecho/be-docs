# 뷰어 화면 테스트 도구 (PC용)

안드로이드 없이 PC의 크롬(Playwright)으로 뷰어 화면(`app/src/main/assets/viewer`)을 시험한다.
`server.mjs`가 앱의 `/doc/*` 응답을 흉내 낸다. PDF는 앱과 똑같이 브라우저에서 pdf.js로 그리고,
pdf.js가 못 열어 안드로이드 내장 렌더러로 넘어가는 경우만 `pdftoppm`으로 흉내 낸다.

준비: `../../scripts/fetch-vendor.sh`, `npm i -g playwright`, poppler-utils(pdfinfo·pdftoppm)

```bash
# 먼저 흉내 서버를 띄운다
node server.mjs ../../app/src/main/assets/viewer ../../app/src/main/assets/viewer/vendor 8731 &

# 버전별 99종: 기대 결과(manifest.tsv)와 비교
mkdir -p /tmp/shots && node matrix.mjs 8731 ../../app/src/androidTest/assets/matrix /tmp/shots

# 업데이트 안 된 웹뷰 흉내: 오래된 크롬 실행 파일로 돌린다(ONLY=정규식으로 일부 파일만).
# 예: npm pack @sparticuz/chromium@113.0.1 → bin/*.br 을 brotli로 풀어 chromium 실행 파일을 얻는다.
CHROME=/path/to/chromium-113/chromium ONLY=pdf node matrix.mjs 8731 ../../app/src/androidTest/assets/matrix /tmp/shots
# 판정: 기대 결과 + 화면 내용 + 외부 요청 없음 + 삼켜진 JS 오류(TypeError 등) 없음 + PDF는 pdf.js로 그렸는지

# 사용성 시나리오(정해 둔 순서): 바 숨김·메뉴·문서 안내·찾기·뒤로 가기·쪽 문서 확대·축소(한 동작으로 100% 넘나듦)·쪽 이동 손잡이·배율별 바·메뉴,
# 무거운 도면 PDF의 반응(폴드 크기·CPU 4배 느리게)·확대 후 선명도·회전된 쪽 글자 층 등. ONLY=낱말 은 이름에 그 낱말이 든 검사만.
node ux.mjs 8731 ../../app/src/androidTest/assets/matrix

# 상태 조합: 문서 11종 × 화면(세로·작은 폰·가로·폴드) × 밝은/어두운 화면(+글자 1.3배) × 배율 × 열린 것(메뉴·문서 안내·
# 찾기·칸 팝업·손잡이) × 회전. 상태마다 화면 안·눌림·글자 대비·뒤로 가기 대상·옆 넘침·스크립트 오류를 잰다.
# QUICK=1 은 세로 폰·밝은 화면만, ONLY=pdf,hwp 는 그 글자가 든 파일만. 세 번째 인자 폴더에 상태별 스크린샷.
node states.mjs 8731 ../../app/src/androidTest/assets/matrix /tmp/states

# 전부 한 번에(서버를 띄우고 단위·매트릭스·사용성·상태 조합·보안 시험을 차례로): ./run-all.sh  (CHROME=… 로 옛 크롬)

# 악성 입력(스크립트 실행·외부 요청·페이지 이동이 없어야 한다). 샘플은 xss-samples/ 에 있다:
# xlsx·pptx·csv·HTML .xls·docx·doc·pdf, 간단 보기용 웹 페이지 .doc(HTML·MHT)·RTF·ODT·Word 2003 XML, 이름에 HTML을 넣은 파일
node security.mjs 8731 xss-samples

# 긴 docx 빠른 읽기(docx-read.js) 단위 시험: 서버·브라우저 없이 노드로(CI 빌드에서도 돈다)
node docx-read-test.mjs

# 대량 파일: 목록 파일의 모든 파일을 4개씩 병렬로 열어 rendered/error/hang 분류
node sweep.mjs ../../app/src/main/assets/viewer ../../app/src/main/assets/viewer/vendor files.lst results.jsonl 4
```
