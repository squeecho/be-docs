# 감사 도구 (배포 전에 가끔 돌리는 무거운 검사)

매트릭스(`tools/web-test/matrix.mjs`)는 "열리고 그려졌는가"를 본다. 그것만으로는 다음 같은 빈틈을 놓쳤다:
워드가 첫 쪽에서 넘어가지 않음, 엑셀 dimension이 작게 적힌 파일의 열·행 잘림, 메모·노트·도형이 말없이 빠짐.
여기 도구는 "원본에 있던 것이 화면에 다 나오는가 / 빠지면 알리는가"를 원본 파일과 대조해 센다.

## 손실 오라클 (`loss/`)

원본에서 기준 글자·물건 목록을 뽑고(LibreOffice·파일 구조 직접 해석), 뷰어 화면에서 나온 글자·그림·안내 띠를 모아 대조한다.

```bash
# 필요: LibreOffice(soffice), pdftotext·pdftoppm(poppler), Node + Playwright(tools/web-test/playwright.mjs가 찾는 것),
#       Python 3 + lxml, olefile, pypdf (시험 파일 만들 때 python-docx, openpyxl, python-pptx). PYLIB=<추가 파이썬 경로> 로 지정 가능.
# 목록: 한 줄에 "절대경로" 또는 "절대경로<TAB>비밀번호"
VIEWER=app/src/main/assets/viewer PORTS=8941,8942 OUT=/tmp/loss-run \
  bash tools/audit/loss/run_all.sh <목록 파일> [재사용할 ref 폴더]
python3 tools/audit/loss/tables.py /tmp/loss-run/findings-summary.tsv /tmp/loss-run/compare-cats.tsv   # 마크다운 표
python3 tools/audit/loss/make_fixtures.py <폴더>   # 말뭉치에 드문 내용(메모·각주·첨부·dimension 등)을 넣은 시험 파일
```

- 결과: `findings-summary.tsv`(분류별: 파일 수·개수·안내 없음/일반 안내/정확한 안내), `findings.tsv`(파일별), `compare-cats.tsv`(글자 대조).
- `note_covers`가 0인 분류는 "말없이 빠지는 것"이다. 고치거나 화면에 알려야 한다.
- 오라클 규칙은 화면 DOM 모양에 기대므로(예: `.sheet-note`, `.extras-note`), 뷰어 화면 구조를 바꾸면 `capture.mjs`·`summarize.py`도 맞춰야 한다.
  2026-10 실행 기준으로 엑셀 차트·도형·숨긴 시트 칩은 그려지는데도 "안내 없음"으로 세는 오탐이 남아 있다.

## 빠른 읽기 대조 (`docx-read/`)

긴 docx는 워드 엔진 대신 `app/src/main/assets/viewer/docx-read.js`가 문서 XML을 직접 읽어 읽기 보기로 연다(엔진의 수십 분의 1 시간).
해석기가 둘이 되므로, 같은 docx를 엔진이 읽은 구조로 만든 읽기 보기(`viewer-libs/docx-entry.js`의 `readingBlocks`)와 글을 대조한다.
엔진을 올리거나 `docx-read.js`를 고칠 때 돌린다.

```bash
node tools/audit/docx-read/run.mjs <docx 목록(한 줄에 절대경로)> /tmp/docx-read.jsonl
python3 tools/audit/docx-read/analyze.py /tmp/docx-read.jsonl
```

- 2026-10 공개 시험 파일 docx 128종(둘 다 읽은 것): 116종은 글이 같고(공백·쪽 나눔·제목 표시 무시), 엔진 글자 538,308자 중 빠른 읽기에 없는 것은 60자(0.011%)였다.
  그 60자는 Word에서도 보이지 않는 숨긴 글('Top of Form')과 수정 표시로 옮겨 간 원래 자리 글이다. 나머지 차이는 빠른 읽기가 더 보여 주는 것
  (글상자 글, 미주 번호, 쪽 나눔 표시)이다. 누락이 늘면 고칠 대상이다.

## 견고성 감사 (`robust/`)

깨진·덜 받아진·이름이 틀린 파일과 성능 절벽을 노린 파일을 대량으로 만들어 열어 보고, "끝 상태가 나왔는가·화면이 얼었는가·
이상한 글자가 보이는가"로 분류한다. 화면 스레드가 멈춰도 기록이 남도록 상태·긴 작업·심장 박동(250ms)을 콘솔로 흘려 받는다.

```bash
python3 -I tools/audit/robust/mutate.py app/src/androidTest/assets/matrix /tmp/mut      # 변형 파일(잘라내기·비트 뒤집기·확장자 바꿈·ZIP/OLE 구조 훼손 등)
python3 -I tools/audit/robust/gen.py /tmp/gen app/src/androidTest/assets/matrix          # 성능 절벽(열 전체 병합·시트 전체 수식·3천 시트·긴 표 등)
node tools/audit/robust/fuzz.mjs /tmp/mut/manifest.jsonl /tmp/fuzz.jsonl --ports 8951,8952 [--mode proc:6]  # 일괄 실행
python3 -I tools/audit/robust/summarize.py /tmp/fuzz.jsonl                               # 깃발별 묶음
node tools/audit/robust/one.mjs <파일> [--proc 6] [--profile out.cpuprofile]               # 한 파일 자세히(원인 조사)
node tools/audit/robust/minimize.mjs <원본> <변형>                                         # 엑셀 엔진이 멈추는 최소 바이트 차이
```

- 깃발: `HANG`(끝 상태 없음) · `HANG-MAIN-FROZEN`(화면 스레드까지 멈춤) · `FREEZE>Ns` · `SLOW>20s` · `PAGEERROR` · `GARBAGE-CHARS`·`GIANT-LAYOUT`(깨진 글자 표 등).
- `--mode proc:6`은 렌더러 프로세스 전체를 번갈아 멈춰 6배 느리게 한다. 크롬 개발 도구의 CPU 감속은 화면 스레드만 느리게 하고
  작업 스레드(HWP·pdf.js·엑셀 해석)는 그대로라, 그것만으로는 느린 폰을 흉내 내지 못한다.
- 포트는 8951~8959만 쓴다(다른 시험과 같은 포트를 쓰면 `__set` 상태가 섞여 결과가 엉킨다).
- 여기서 찾은 결함은 작은 시험 파일로 줄여 매트릭스에 넣는다(`word-cut-short.doc`, `excel-zip-endless.xlsx` 등). 매트릭스는 끝 상태까지 걸린
  시간 상한(`maxMs`)과 화면 스레드가 언 경우도 실패로 본다.

## 사용성 검사 (`tools/web-test/ux.mjs`)

매번 돌려도 되는 가벼운 검사라 `web-test`에 있다(서버를 띄운 뒤 `node tools/web-test/ux.mjs <port> app/src/androidTest/assets/matrix`).

## 2026-10 감사에서 정한 방향

1. **완전성**: 그려졌는지가 아니라 "원본의 무엇이 빠졌는지"를 센다(손실 오라클). 빠지는 것은 개수라도 알린다.
2. **끝까지 써 보기**: 여러 쪽 문서는 마지막 쪽까지 넘겨 본다(매트릭스·기기 시험에 들어감).
3. **멈춤·급한 사용자**: CPU를 느리게 하고, 멈춘 동안 누른 탭이 나중에 엉뚱하게 실행되지 않는지 본다(`ux.mjs`, 기기 시험의 앱 탈출 버튼).
4. **역할극**: 비밀번호를 틀리는 사람, 큰 표 끝을 보려는 사람, 뒤로 가기를 누르는 사람처럼 실제 행동 순서로 검사한다.
5. **망가진 입력**: 덜 받아진 파일·확장자가 틀린 파일·비트가 깨진 파일·성능 절벽 파일을 대량으로 만들어 연다(견고성 감사).
   결함을 고치면 그 결함을 다시 만드는 작은 파일을 매트릭스에 넣고, **고치기 전 코드에서 그 행이 실패하는지**까지 확인한다
   (시험이 결함을 실제로 잡는지 보는 것. 처음 만든 카톡 대화 파일은 너무 짧아 고치기 전 코드도 통과해서 다시 만들었다).
6. **느린 기기에서 정상 파일 오탐**: 시간 제한·감시를 넣으면 "멈춘 파일"뿐 아니라 "느린 정상 파일"도 걸린다. 감시를 바꾸면
   `node tools/audit/robust/one.mjs <정상 파일> --proc 12`(렌더러 프로세스 전체 12배 감속)로 정상 파일이 끝까지 열리는지 본다
   (20초 감시를 처음 넣었을 때 정상 xlsb가 CI 에뮬레이터에서 걸렸고, 이 방법으로 PC에서 재현했다).
7. **시험 환경이 실제와 같은 경로를 타는지**: 자동화 브라우저는 `navigator.webdriver`가 true라서 워드 엔진이 보이는 쪽만 그리기를 끄고
   모든 쪽을 그렸다(실제 기기에서는 3~4쪽만 그림). 그 탓에 워드 멈춤을 2~3배 길게 쟀다. `tools/web-test/playwright.mjs`가 모든 도구에서
   이 표시를 끈다. 엔진이 환경을 보고 다르게 움직이는 곳(webdriver, 화면 크기, 터치 여부, 글꼴)이 없는지 새 엔진을 넣을 때마다 확인한다.
   CPU 감속도 같다: 개발자 도구식(CDP) 감속은 화면 스레드만 느리게 하고 작업 스레드(워드 해석·엑셀 해석)는 그대로라, 여는 데 걸리는
   전체 시간을 덜 잰다(183쪽 워드: CDP 4배에서 41초에 열렸지만 프로세스 4배 감속에서는 90초 한도에 걸려 오류로 끝났다).
   멈춤(화면 스레드)은 CDP로, 전체 시간과 시간 제한은 `--proc`로 잰다.
