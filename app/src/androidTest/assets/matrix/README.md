# 버전별 테스트 파일

`manifest.tsv`: 파일 이름, 넘겨줄 MIME, 기대 결과, 설명, 화면에 보여야 할 글자.

기대 결과
- `rendered:<hwp|sheet|slides|word|pdf>` — 해당 형식으로 표시되고 내용이 보여야 한다
- `password:<비밀번호>` — 비밀번호 입력창이 뜨고, 입력하면 표시돼야 한다
- `error:password` — "비밀번호가 걸린 문서" 안내
- `error:protected` — "보안 프로그램으로 잠긴 문서 같아요" 안내(깨진 글자를 보여 주면 안 된다)
- `error:unsupported` — "지원하지 않는 형식" 안내
- `error:any` — 멈추지 않고 안내
- `no-hang` — 멈추지 않고 어떤 결과든(안내·비밀번호 입력창·표시) 낸다

출처
- `hwp3-hangul97.hwp`, `fuzz-ofz*.hwp`: LibreOffice core `hwpfilter/qa/cppunit/data/pass` (MPL-2.0)
- `hwp5.1.1.0-distribution.hwp`, `hwp5.0.3.4-blank.hwp`: neolord0/hwplib `sample_hwp` (Apache-2.0)
- `hwp5.0.2.5.hwp`, `hwp5.1.0.1.hwp`, `hwpx-5.1.0.0.hwpx`, `hml-hwpml.hml`, `hwp-memo.hwp`(`samples/basic/english.hwp`): edwardkim/rhwp `samples` (MIT)
- `excel3-biff3.xls`, `excel4-biff4.xls`, `excel95-biff5.xls`, `excel-binary.xlsb`, `excel-password-*`, `ppt95.ppt`, `ppt-password.ppt`, `pptm-macro.pptm`,
  `word95.doc`, `word6.doc`, `word2.doc`, `word-password-*`, `word-empty.doc`: Apache POI `test-data` (Apache-2.0)
- `locked-like*`: 직접 만든 가짜 잠금 파일(짧은 머리글 + 고정 씨앗 의사난수). 실제 DRM 업체 형식이 아니다(업체 형식은 공개돼 있지 않음)
- `excel-rich.xlsx`·`excel-rich.xls`(LibreOffice 변환)·`excel-chart-nocache.xlsx`(차트의 저장된 값을 지운 판), `excel-conditional.xlsx`(xlsxwriter),
  `excel-dimension-small.xlsx`(`excel-fills.xlsx`의 시트 크기 표시만 A1:B3으로 줄인 판), `word-extras.docx`(python-docx, 수정 표시·수식은 XML로 넣음),
  `slides-extras.pptx`(python-pptx), `text-memo.txt`, `archive.zip`: 직접 만든 파일
- 견고성 감사에서 나온 파일: `word-cut-short.doc`(`word97-2003.doc` 앞부분만), `excel-as-doc.doc`·`excel-junk-before.xls`(`excel-images.xls` 그대로·앞에 0 한 바이트),
  `hwp-as-xlsx.xlsx`(`hwp5.0.2.5.hwp` 그대로), `writer-damaged.odt`(`writer.odt`의 비트 64개를 뒤집은 판), `excel-zip-endless.xlsx`(`excel-formula-nocache.xlsx`의 비트를 뒤집고 줄인 판),
  `excel-formula-wholesheet.xlsx`·`excel-merge-whole-columns.xlsx`·`csv-utf16le-nobom.csv`·`kakao-chat.txt`: 직접 만든 파일(이름·번호는 지어낸 것)
  `hml-as-xls.xls`(`hml-hwpml.hml` 그대로), `csv-noext`(`csv-utf8.csv` 그대로, 확장자만 없앰)
- `word-12-pages.docx`(python-docx, 쪽 나누기로 12쪽)·`slides-12.pptx`(python-pptx, 16:9 12장): PDF로 저장이 화면 근처만이 아니라 모든 쪽·슬라이드를 그리는지(직접 만든 파일)
- `pptx-bullet-entity.pptx`: `pptx-2007.pptx`의 슬라이드 2에서 글머리 기호를 XML 문자 참조(`char="&#x2022;"`·`&#8211;`)로,
  본문 한 줄을 `R&amp;D &lt;재고&gt; &#x2192; 개선`으로 바꾼 판(파이썬 zipfile로 직접 고침)
- `word-long-reading.docx`: python-docx로 만든 긴 문서(약 6만 자, 200줄 표에 세로로 합친 칸, 머리말·번호 목록). 만드는 법은 `tools/web-test/gen-long-word.py`
- `word-long-reading.doc`: 위 문서를 LibreOffice로 Word 97–2003 형식으로 저장한 판(`soffice --headless --convert-to doc`)
- `cad-2018.dwg`·`cad-r14.dwg`: LibreDWG 저장소(GPL-3.0) `test/test-data`의 `example_2018.dwg`·`example_r14.dwg`
- `cad-korean-cp949.dxf`: 직접 만든 R2000 DXF(코드 페이지 ANSI_949, 도면층·꺼진 도면층·블록·볼록 폴리선·채운 해치·한글 TEXT/MTEXT),
  `cad-truncated.dwg`: `cad-2018.dwg`의 앞 20KB만 남긴 판(잘린 도면이 멈추지 않고 오류를 내는지)
- 나머지: 직접 만든 파일(LibreOffice·pypdf·rhwp 변환 포함, 비밀번호 xlsx·docx·pptx는 msoffcrypto-tool로 암호화)
