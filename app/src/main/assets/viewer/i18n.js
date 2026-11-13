// 화면 글자의 언어. 휴대폰(앱) 언어가 한국어면 한국어, 그 밖의 언어는 영어로 보여 준다.
// 원문(한국어)이 그대로 열쇠다: T('비밀번호') → 영어 화면이면 'Password'. 영어가 없으면 원문 그대로(빈칸 대신).
// {이름} 자리는 vars 값으로 채우고, 영어의 [n|단수|복수]는 vars.n이 1이면 단수, 아니면 복수를 고른다.
// 앱 밖(시험 화면 등, 앱이 언어를 알려 주지 않을 때)은 한국어.

function detect() {
  try {
    const b = typeof self !== 'undefined' ? self.DocViewer : null;
    if (b && b.language) return String(b.language()).toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch (_) {
    // 언어를 못 읽으면 한국어로 둔다.
  }
  return 'ko';
}

export const LANG = detect();

const EN = {
  // 여는 중·공통 버튼
  '여는 중이에요': 'Opening…',
  '불러오는 중…': 'Loading…',
  '큰 문서는 여는 데 시간이 조금 걸려요.': 'Large documents take a little while to open.',
  '생각보다 오래 걸리고 있어요. 급하면 다른 앱으로 열어 보세요.': 'This is taking longer than expected. If you’re in a hurry, open it in another app.',
  '아직 여는 중이에요. 휴대폰에 따라 몇 분 걸리기도 해요.': 'Still opening. On some phones this can take a few minutes.',
  '{msg} ({s}초째)': '{msg} ({s}s)',
  '다른 앱으로 열기': 'Open in another app',
  '다른 파일 열기': 'Open another file',
  '자세히': 'Details',
  '닫기': 'Close',
  '취소': 'Cancel',
  '보기': 'Show',
  '숨기기': 'Hide',
  '열기': 'Open',
  '다시 시도': 'Try again',
  '이전': 'Previous',
  '다음': 'Next',
  '문서': 'Document',
  '메뉴': 'Menu',

  // 위쪽 바 메뉴·문서 안내
  '문서에서 찾기': 'Find in document',
  '이미지로 변환…': 'Convert to images…',
  '원본 모양으로 보기': 'View original layout',
  '문서 안내': 'Document notes',
  '파일 공유하기…': 'Share file…',
  '다운로드': 'Download',
  'PDF로 저장': 'Save as PDF',
  'PDF로 저장할 준비를 하고 있어요…': 'Preparing the PDF…',
  'PDF로 저장할 준비를 하고 있어요… ({done}/{total})': 'Preparing the PDF… ({done}/{total})',
  'PDF로 저장하지 못했어요. 다시 해 보세요.': "Couldn't save as PDF. Please try again.",
  '인쇄': 'Print',
  '인쇄할 준비를 하고 있어요…': 'Preparing to print…',
  '인쇄할 준비를 하고 있어요… ({done}/{total})': 'Preparing to print… ({done}/{total})',
  '인쇄 창을 열지 못했어요. 다시 해 보세요.': "Couldn't open printing. Please try again.",
  '작성자가 인쇄를 막아 둔 문서예요.': 'The author has blocked printing for this document.',
  '비밀번호로 보호된 PDF는 여기서 인쇄할 수 없어요. 다른 앱에서 열어 인쇄해 주세요.': "Password-protected PDFs can't be printed here. Open it in another app to print.",
  '연결 앱…': 'Open with…',
  '쪽 이동': 'Go to page',
  '외 {n}개': '+{n} more',
  '문서 안내 {n}개: {text}': '{n} document [n|note|notes]: {text}',
  '문서 안내 {n}개': '{n} document [n|note|notes]',

  // 파일 공유하기
  '파일 공유하기': 'Share file',
  '보낼 파일 이름': 'File name to send',
  '받는 사람에게 이 이름으로 보내져요.': 'The recipient will see this name.',
  '공유하기': 'Share',

  // 시작 화면·앱 정보
  '광고 없는 가벼운 문서 뷰어\n받은 파일을 열 때 나오는 앱 목록에서 be docs를 고르세요.\n\n지원: 한글(hwp, hwpx) · 워드(docx, doc)\n엑셀(xlsx, xls, csv) · 파워포인트(pptx, ppt) · PDF\n도면: CAD(dwg, dxf) · 일러스트(ai)\n기타: rtf · odt · odp':
    'A light, ad-free document viewer\nWhen you open a file you received, choose be docs from the list of apps.\n\nSupports: HWP (hwp, hwpx) · Word (docx, doc)\nExcel (xlsx, xls, csv) · PowerPoint (pptx, ppt) · PDF\nDrawings: CAD (dwg, dxf) · Illustrator (ai)\nOther: rtf · odt · odp',
  '파일 열기': 'Open a file',
  // 시작 화면 — 최근 문서
  '최근 문서': 'Recent documents',
  '모두 지우기': 'Clear all',
  '최근 문서 모두 지우기': 'Clear recent documents',
  '최근 문서 {n}개를 목록에서 모두 빼요. 이 앱 안에 보관한 사본도 지워요. 원본 파일은 그대로예요.': 'Removes all {n} [n|document|documents] from Recent documents and deletes the copies kept in this app. Original files stay as they are.',
  '목록에서 빼기': 'Remove from list',
  '{name} 목록에서 빼기': 'Remove {name} from the list',
  '최근 문서 목록에서 빼요. 이 앱 안에 보관한 사본도 지워요. 받은 앱에 있는 원본은 그대로예요.': 'Removes it from Recent documents and deletes the copy kept in this app. The original in the app you received it from stays as it is.',
  '최근 문서 목록에서 빼요. 원본 파일은 지워지지 않아요.': 'Removes it from Recent documents. The original file is not deleted.',
  '다른 앱에서 받은 문서는 목록에서 다시 열 수 있게 이 앱 안에 사본을 보관해요(최근 {n}개·500MB까지). 휴대폰 밖으로는 보내지 않아요.': 'Documents you received in other apps are kept as a copy inside this app so you can reopen them here (latest {n}, up to 500 MB). Nothing leaves your phone.',
  '지원: 한글 · 워드 · 엑셀 · 파워포인트 · PDF · CAD(dwg, dxf) · 일러스트(ai) · rtf · odt · odp': 'Supports: HWP · Word · Excel · PowerPoint · PDF · CAD (dwg, dxf) · Illustrator (ai) · rtf · odt · odp',
  '오늘 {t}': 'Today {t}',
  '어제 {t}': 'Yesterday {t}',
  '시작 화면의 최근 문서 목록은 이 휴대폰의 be docs 안에만 저장돼요. 다른 앱에서 받은 문서는 다시 열 수 있게 사본을 함께 보관하고(최근 30개·500MB까지, 오래된 것부터 자동으로 지움), 백업으로도 내보내지 않아요. 목록의 ⋮나 "모두 지우기"로 언제든 지울 수 있고, 앱을 지우면 함께 지워져요.': 'The Recent documents list on the start screen is stored only inside be docs on this phone. For documents received in other apps, a copy is kept so you can reopen them (latest 30, up to 500 MB; oldest are removed automatically) and it is not included in backups. Remove items any time with ⋮ or "Clear all"; uninstalling the app deletes them too.',
  '버전 {v}': 'Version {v}',
  '앱 정보·오픈소스 라이선스': 'About · Open-source licenses',
  'Pretendard(글꼴)': 'Pretendard (font)',
  '개인정보': 'Privacy',
  '한글 문서': 'HWP documents',
  'be docs는 인터넷을 쓰지 않아요(인터넷 권한 없음). 연 문서는 휴대폰 안에서만 읽고 어디로도 보내지 않으며, 사용 기록이나 개인정보를 모으지 않아요. 파일 공유하기·다운로드·이미지로 변환(공유하기·사진첩에 저장)은 직접 고를 때만 해요.':
    'be docs doesn’t use the internet (no internet permission). Documents you open are read only on your phone and never sent anywhere, and no usage data or personal information is collected. Sharing a file, downloading and converting to images (share or save to gallery) happen only when you choose them.',
  '본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.':
    '본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.\n(This product was developed with reference to the HWP (.hwp) document format specification published by Hancom Inc.)',

  // 지원 형식·못 여는 파일
  '한글(hwp, hwpx) · 워드(docx, doc) · 엑셀(xlsx, xls, csv) · 파워포인트(pptx, ppt) · PDF · CAD(dwg, dxf) · 기타(일러스트 ai, rtf, odt, odp)':
    'HWP (hwp, hwpx) · Word (docx, doc) · Excel (xlsx, xls, csv) · PowerPoint (pptx, ppt) · PDF · CAD (dwg, dxf) · Other (Illustrator ai, rtf, odt, odp)',
  '파일을 가져오지 못했어요': 'Couldn’t get the file',
  '도면이 너무 크거나 복잡해요': 'This drawing is too large or complex',
  '다른 앱으로 열어 주세요.': 'Please open it in another app.',
  '2분 안에 다 읽지 못함': 'Not read within 2 minutes',
  '도면을 여는 중이에요': 'Opening the drawing',
  'be docs 라이선스': 'be docs license',
  'be docs는 자유 소프트웨어예요. GNU 일반 공중 사용 허가서(GPL) 3판 또는 그 이후 판에 따라 다시 배포하거나 고칠 수 있어요. 아무런 보증도 하지 않아요. 소스 코드: {url}': 'be docs is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License, version 3 or any later version. It comes with ABSOLUTELY NO WARRANTY. Source code: {url}',
  '흰 바탕으로 보기': 'White background',
  '어두운 바탕으로 보기': 'Dark background',
  '큰 도면은 몇 초 걸릴 수 있어요': 'Large drawings can take a few seconds',
  '도면을 읽지 못했어요': "Couldn't read the drawing",
  '파일이 손상됐거나 아직 열 수 없는 CAD 형식이에요. 다른 앱으로 열어 주세요.': "The file is damaged or in a CAD format that can't be opened yet. Please open it in another app.",
  '그릴 내용을 찾지 못했어요': 'Nothing to draw was found',
  '파일이 손상됐거나 덜 받아졌거나 비어 있는 도면이에요. 다른 앱으로 열어 확인해 주세요.': 'The drawing is damaged, incompletely downloaded or empty. Please check it in another app.',
  'CAD 도면은 간단히 보여 줘요. 점선 같은 선 모양·글꼴·해치 무늬는 원본과 다를 수 있어요.': 'CAD drawings are shown in a simple view. Line types such as dashes, fonts and hatch patterns may differ from the original.',
  '그리지 못한 개체 {n}개({list})는 보이지 않아요.': "{n} objects that couldn't be drawn ({list}) aren't shown.",
  '도면이 너무 커서 일부만 그렸어요. 전체는 다른 앱으로 열어 주세요.': 'The drawing is too large, so only part of it is shown. Open it in another app to see all of it.',
  '모형 공간이 비어 있어 배치(종이 공간)를 보여 줘요.': 'Model space is empty, so the layout (paper space) is shown.',
  '3D 솔리드': '3D solid', '영역': 'region', '3D 몸체': '3D body', '3D 메시': '3D mesh', '메시': 'mesh', '곡면': 'surface', '표': 'table',
  '여러 줄 지시선': 'multileader', '다중선': 'multiline', '공차 기호': 'tolerance', '그림': 'image', 'OLE 개체': 'OLE object',
  '읽지 못한 블록': 'unreadable block', '참조 파일': 'underlay', '참조 PDF': 'PDF underlay', '참조 DWF': 'DWF underlay',
  '300MB가 넘는 파일은 열 수 없어요': "Files over 300 MB can't be opened",
  '이 파일은 {n}MB예요. 다른 앱으로 열거나 컴퓨터에서 열어 주세요.': 'This file is {n} MB. Open it in another app or on a computer.',
  '다른 앱으로 열거나 컴퓨터에서 열어 주세요.': 'Open it in another app or on a computer.',
  '한도 300MB': 'Limit 300 MB',
  '옛 일러스트레이터 형식이라 열 수 없어요': "This older Illustrator format can't be opened",
  'EPS·PostScript 파일은 열 수 없어요': "EPS and PostScript files can't be opened",
  '일러스트레이터에서 "PDF 호환 파일 만들기"를 켜고 다시 저장하거나, 다른 앱으로 열어 주세요.': 'Re-save it in Illustrator with "Create PDF Compatible File" turned on, or open it in another app.',
  'PostScript 형식(%!PS)': 'PostScript format (%!PS)',
  '일러스트레이터 파일을 여는 중이에요': 'Opening the Illustrator file',
  'PDF 호환 없이 저장된 일러스트레이터 파일이에요': 'This Illustrator file was saved without PDF content',
  '보낸 사람에게 일러스트레이터에서 "PDF 호환 파일 만들기"를 켜고 다시 저장해 달라고 하세요. 다른 앱으로 열어도 같은 안내만 보일 수 있어요.': 'Ask the sender to re-save it in Illustrator with "Create PDF Compatible File" turned on. Other apps may show the same message.',
  'PDF 부분에 그림 대신 안내 글만 있음': 'The PDF part holds only a notice, no artwork',
  '일러스트레이터 파일은 함께 저장된 PDF 미리보기로 보여 줘요. 레이어·아트보드 밖의 개체·편집 정보는 보이지 않을 수 있어요.': 'Illustrator files are shown from the PDF preview saved with them. Layers, objects outside the artboard and editing data may not appear.',
  '문서가 커서 다른 앱에서 여는 게 좋아요': 'This document is large — it’s better to open it in another app',
  '휴대폰 메모리가 부족해 화면을 그리다 멈췄어요.': 'The phone ran out of memory while drawing the document.',
  '내용이 없는 빈 파일이에요': 'This file is empty',
  '파일을 받은 곳에서 다시 받아 주세요. 다운로드가 덜 끝났을 수 있어요.': 'Download it again from where you got it. The download may not have finished.',
  '0바이트': '0 bytes',
  '압축 파일이에요': 'This is a compressed (ZIP) file',
  '"내 파일" 앱에서 압축을 푼 뒤 안의 문서를 열어 주세요.': 'Extract it in your Files app, then open the document inside.',
  ' 안에 문서 {n}개가 들어 있어요.': ' It contains {n} [n|document|documents].',
  '압축 안 파일: {list}{more}': 'files in archive: {list}{more}',
  ' 외 {n}개': ' and {n} more',
  '한셀·한쇼 문서는 다른 앱에서 열어 주세요': 'Please open Hancell/Hanshow documents in another app',
  '한컴오피스 뷰어 같은 앱에서 열 수 있어요.': 'Apps such as Hancom Office Viewer can open them.',
  '다른 앱에서 열어야 하는 파일이에요': 'This file needs to be opened in another app',
  'be docs가 여는 형식: {list}': 'Formats be docs can open: {list}',
  '형식 판별: {k}': 'detected format: {k}',
  '파일을 끝까지 받지 못했어요': 'The file wasn’t fully received',
  '파일 뒷부분이 없어요. 파일을 받은 곳에서 다시 받아 주세요.': 'The end of the file is missing. Download it again from where you got it.',
  '이 파일은 다른 앱에서 열어 보세요': 'Try opening this file in another app',
  '다운로드가 덜 끝났거나 be docs가 읽지 못하는 구성이에요. 파일을 받은 곳에서 다시 받으면 열릴 수도 있어요.':
    'The download may be incomplete, or the file is built in a way be docs can’t read. Downloading it again may help.',
  '보안 프로그램으로 잠긴 문서 같아요': 'This document seems to be locked by security software',
  '회사 보안(DRM)이 걸린 파일은 그 회사의 보안 앱이 있어야 열려요. 보낸 사람에게 보안을 해제한 파일이나 PDF로 다시 받아 보세요.':
    'Files protected by company security (DRM) open only in that company’s security app. Ask the sender for an unlocked copy or a PDF.',
  '표 안에 표가 너무 깊게 들어 있는 문서예요': 'Tables are nested too deeply in this document',
  '다른 앱에서 열어 보세요.': 'Try opening it in another app.',
  '표 중첩이 40단계를 넘음': 'table nesting exceeds 40 levels',
  'OLE 파일이 {a}바이트에서 끝남(쓰는 칸은 {b}바이트 넘어까지)': 'OLE file ends at {a} bytes (used sectors extend past {b} bytes)',
  'ZIP 끝의 중앙 목록 표시가 없음': 'ZIP end-of-central-directory record missing',
  '알려진 문서 구조 없음 · 내용이 무작위에 가까움({h} bit/byte)': 'no known document structure · content is near-random ({h} bit/byte)',
  'OLE 컨테이너 안에 문서 본문 항목이 없음': 'no document body stream in the OLE container',

  // 비밀번호
  '비밀번호로 보호된 문서예요': 'This document is password-protected',
  '비밀번호가 맞지 않아요': 'Wrong password',
  ' ({n}번째)': ' (attempt {n})',
  '대소문자와 한/영 상태를 확인해 주세요.': 'Check upper/lower case and your keyboard language.',
  '비밀번호를 입력하면 열려요.': 'Enter the password to open it.',
  '비밀번호': 'Password',
  '비밀번호를 입력해 주세요.': 'Please enter the password.',
  '비밀번호를 확인하고 있어요': 'Checking the password…',
  '보낸 사람에게 비밀번호를 다시 물어보세요.': 'Ask the sender for the password again.',
  '비밀번호로 보호된 PDF예요': 'This PDF is password-protected',
  '다른 앱에서 비밀번호를 입력해 열어 주세요.': 'Open it in another app and enter the password there.',
  'pdf.js 없이 내장 렌더러로 여는 중': 'opening with the built-in renderer (no pdf.js)',
  '이 방식으로 보호된 문서는 다른 앱에서 비밀번호를 입력해 열어 주세요.': 'Documents protected this way need to be opened in another app with the password.',
  '이 방식으로 보호된 문서는 다른 앱에서 열어 주세요.': 'Documents protected this way need to be opened in another app.',

  // 쪽 문서(PDF·한글)
  '{n}쪽': 'Page {n}',
  '{n}쪽 미리 보기를 만들지 못했어요': 'Couldn’t create a preview of page {n}',
  '기본 방식으로 열었어요. 메모·글자 선택·찾기는 쓸 수 없어요.': 'Opened in basic mode. Comments, text selection and search aren’t available.',
  '찾는 글자가 없어요': 'No matches',
  '스캔한 문서라 글자를 찾을 수 없어요': 'This is a scanned document, so text can’t be searched',
  '{a}/{b}쪽 찾는 중': 'Searching page {a}/{b}',

  // 이미지로 변환
  '이미지로 변환': 'Convert to images',
  '작성자가 인쇄와 복사를 막아 둔 문서라 이미지로 변환할 수 없어요.': 'The author has blocked printing and copying, so this document can’t be converted to images.',
  '{n}쪽 선택': '{n} [n|page|pages] selected',
  '변환할 쪽을 골라 주세요': 'Choose pages to convert',
  '선택 해제': 'Deselect all',
  '전체 선택': 'Select all',
  'PNG(손실 없음) · 사진이 많은 쪽은 JPG': 'PNG (lossless) · JPG for photo-heavy pages',
  '쪽 범위 예: 1-3, 5 (전체 {n}쪽)': 'Page range, e.g. 1-3, 5 ({n} [n|page|pages])',
  '쪽 범위': 'Page range',
  '고르기': 'Select',
  '쪽': 'Pages',
  '화질': 'Quality',
  '사진첩에 저장': 'Save to gallery',
  '카톡은 사진 화질을 "원본"으로 보내야 해상도가 그대로 가요.': 'Messaging apps may shrink images — send them at “original” quality to keep the full resolution.',
  '사진첩에 저장하면 사진 백업(구글 포토 등)에도 올라갈 수 있어요.': 'Images saved to your gallery may also be uploaded by photo backup (e.g., Google Photos).',
  '"{bad}"을 알아보지 못했어요. 1~{n} 사이 쪽 번호로 적어 주세요(예: 1-3, 5).': 'Couldn’t understand “{bad}”. Enter page numbers between 1 and {n} (e.g., 1-3, 5).',
  '쪽 번호를 적어 주세요(예: 1-3, 5).': 'Enter page numbers (e.g., 1-3, 5).',
  '이미지로 변환 중 {a}/{b}': 'Converting to images {a}/{b}',
  '그만뒀어요.': 'Stopped.',
  '사진첩에 저장하지 못했어요. 휴대폰 저장 공간을 확인해 주세요.': 'Couldn’t save to the gallery. Check your phone’s free storage.',
  '이미지로 변환하지 못했어요. 쪽 수를 줄여 다시 해 보세요.': 'Couldn’t convert to images. Try again with fewer pages.',

  // 문서 속 메모·노트·빠진 것
  '{name} {n}개': '{name} ({n})',
  '{label}가 있어요.': 'This document has {label}.',
  '{list}는 표시되지 않아요.': '{list} can’t be shown.',
  '메모': 'Comments',
  '발표자 노트': 'Speaker notes',
  '삽입 개체(엑셀 표 등) {n}개': '{n} embedded [n|object|objects] (Excel tables, etc.)',
  'EMF·WMF 그림 {n}개': '{n} EMF/WMF [n|picture|pictures]',
  '수식 {n}개': '{n} [n|equation|equations]',
  '다른 문서에서 가져온 내용 {n}개': '{n} [n|part|parts] imported from other documents',
  'WordArt {n}개': '{n} WordArt [n|item|items]',
  '워터마크': 'the watermark',
  '적용하지 않은 변경 내용이 있어요. 모두 적용한 모습으로 보여요.': 'There are tracked changes. They’re shown as if all were accepted.',
  '{n}번 슬라이드': 'Slide {n}',
  '슬라이드 {n}': 'Slide {n}',
  '숨긴 슬라이드 {n}개({list}번)도 함께 보여요.': '{n} hidden [n|slide is|slides are] also shown (slide {list}).',
  '첨부 파일': 'attachment',
  '첨부 파일 {n}개({list}{more})가 있어요. 첨부 파일은 다른 앱에서 열어 주세요.': 'This PDF has {n} [n|attachment|attachments] ({list}{more}). Open attachments in another app.',
  ' 등': ', …',

  // 엑셀
  '시트1': 'Sheet1',
  '시트 {n}': 'Sheet {n}',
  '{name} (숨김)': '{name} (hidden)',
  '숨긴 시트 {n}개': '{n} hidden [n|sheet|sheets]',
  '빈 시트예요.': 'This sheet is empty.',
  '{n}행 더 있어요': '{n} more [n|row|rows]',
  '전체 {a}행 중 처음 {s}행만 보여요.': 'Showing the first {s} of {a} rows.',
  '처음 {s}행만 보여요(뒤에 더 있어요).': 'Showing the first {s} rows (there are more).',
  '전체 {a}열 중 처음 {s}열만 보여요.': 'Showing the first {s} of {a} columns.',
  '{cut} 전체는 다른 앱에서 볼 수 있어요.': '{cut} Open in another app to see everything.',
  '처음 {n}행까지만 보여요.': 'Only the first {n} rows are shown.',
  '처음 {n}열까지만 보여요.': 'Only the first {n} columns are shown.',
  '결과가 저장되지 않은 수식 {n}칸은 앱이 계산했어요. 원본 엑셀과 다를 수 있어요.': '{n} formula [n|cell|cells] had no saved result, so the app calculated them. Values may differ from Excel.',
  '메모가 있는 칸 {n}개는 모서리의 빨간 삼각형을 누르면 볼 수 있어요.': 'Tap the red triangle in a cell’s corner to see its comment ({n} [n|cell|cells]).',
  '행 {n}개': '{n} [n|row|rows]',
  '열 {n}개': '{n} [n|column|columns]',
  '숨긴 {what}도 보이고 있어요.': 'Showing {what} that were hidden.',
  '다시 숨기기': 'Hide again',
  '숨긴 {what}가 있어요.': 'There are {what} hidden.',
  '숨기기 취소': 'Show hidden',
  '차트 {n}개': '{n} [n|chart|charts]',
  '도형·글상자 {n}개': '{n} [n|shape or text box|shapes or text boxes]',
  '그림 {n}개(EMF·WMF 형식)': '{n} EMF/WMF [n|picture|pictures]',
  '버튼·확인란 {n}개': '{n} [n|button or checkbox|buttons or checkboxes]',
  '메모 {n}개': '{n} [n|comment|comments]',
  '조건부 서식 {n}개(값에 따라 바뀌는 색·아이콘)': '{n} conditional [n|format|formats] (value-based colors or icons)',
  '개체 {n}개': '{n} [n|object|objects]',
  '차트': 'Chart',
  '차트 값': 'Chart values',
  '계열 {n}': 'Series {n}',
  '{name} — 눌러서 값 보기': '{name} — tap to see values',
  '글상자': 'Text box',
  '엑셀 파일로 읽을 수 없어요': 'Can’t read this as an Excel file',
  '파일이 손상됐거나 엑셀 파일이 아니에요. 다른 앱에서 열어 보세요.': 'The file is damaged or isn’t an Excel file. Try opening it in another app.',
  '알려진 엑셀 구조 없음(앞부분 {h})': 'no known Excel structure (starts with {h})',
  '파일을 읽다가 멈췄어요': 'Reading the file stalled',
  '파일 일부가 손상됐거나 너무 복잡해요. 다른 앱에서 열어 보세요.': 'Part of the file may be damaged or too complex. Try opening it in another app.',
  '엑셀 해석이 {s}초 안에 끝나지 않음': 'Excel parsing didn’t finish within {s}s',
  '엑셀 해석 뒤 정리가 끝나지 않음': 'cleanup after Excel parsing didn’t finish',
  '시트 내용을 읽지 못했어요': 'Couldn’t read the sheet',
  '파일 일부가 손상됐을 수 있어요. 다른 앱에서 열어 보세요.': 'Part of the file may be damaged. Try opening it in another app.',
  '손상된 시트: {list}': 'damaged sheets: {list}',
  '이 시트는 손상돼 읽지 못했어요. 다른 시트는 볼 수 있어요.': 'This sheet is damaged and couldn’t be read. Other sheets are available.',

  // 파워포인트·워드·간단 보기
  '예전 PPT 형식이라 정렬·글머리 기호·글자 색 같은 서식이 원본과 다를 수 있어요.': 'This is an older PPT format, so formatting such as alignment, bullets and text color may differ from the original.',
  'PowerPoint 95 형식이라 다른 앱에서 열어 주세요': 'This is a PowerPoint 95 file — please open it in another app',
  '너무 오래된 형식이라 be docs에서는 열 수 없어요.': 'This format is too old for be docs to open.',
  '긴 문서(약 {n}쪽)라 읽기 모드로 열었어요. 쪽 나눔과 배치는 원본과 달라요.': 'Opened this long document (about {n} pages) in reading mode. Page breaks and layout differ from the original.',
  '긴 문서라 읽기 모드로 열었어요. 쪽 나눔과 배치는 원본과 달라요.': 'Opened this long document in reading mode. Page breaks and layout differ from the original.',
  ' 빠진 그림 {n}개는 원본 모양에서 볼 수 있어요.': ' {n} omitted [n|picture is|pictures are] visible in the original layout.',
  '원본 모양으로 열지 못했어요': 'Couldn’t open the original layout',
  '파일을 다시 열면 읽기 모드로 볼 수 있어요.': 'Reopen the file to view it in reading mode.',
  '각주': 'Footnotes',
  '쪽을 나누고 있어요': 'Laying out pages…',
  '약 {n}쪽 분량이에요. ': 'About {n} pages. ',
  '잠시만 기다려 주세요.': 'Please wait a moment.',
  '기본 방식으로 열었어요. 번호·머리말 같은 일부 서식이 빠질 수 있어요.': 'Opened in basic mode. Some formatting such as numbering and headers may be missing.',
  '{pages}쪽{more}은 아래쪽 글이 잘려 보여요.': 'Text at the bottom of [c|page|pages] {pages}{more} is cut off.',
  '잘린 글 보기': 'Show cut-off text',
  '잘린 글': 'Cut-off text',
  '{n}쪽 아래': 'Bottom of page {n}',
  'RTF 문서': 'RTF document',
  'ODT 문서': 'ODT document',
  'ODP 발표 자료': 'ODP presentation',
  'Word 2003 XML 문서': 'Word 2003 XML document',
  '오래된 Word 문서': 'old Word document',
  '텍스트 파일': 'text file',
  '{kind}라 글자만 보여요. 표·그림·서식은 다른 앱에서 확인해 주세요.': 'Showing text only ({kind}). Check tables, pictures and formatting in another app.',
  '{kind}라 글꼴·배치가 원본과 다를 수 있어요.': 'Fonts and layout may differ from the original ({kind}).',
  ' 그림 {n}개는 표시하지 못했어요.': ' {n} [n|picture|pictures] couldn’t be shown.',
  '전체 {n}줄 중 처음 20,000줄만 보여요.': 'Showing the first 20,000 of {n} lines.',
  'Word 95 이전 형식이라 다른 앱에서 열어 주세요': 'This is a pre-Word 95 file — please open it in another app',
  '본문을 읽지 못했어요.': 'Couldn’t read the document text.',
  ' 문서 밖에 있던 그림 {n}개는 표시하지 못했어요.': ' {n} [n|picture|pictures] stored outside the document couldn’t be shown.',
  '웹 페이지 형식으로 저장된 문서라 쪽 나눔·글꼴이 원본과 다를 수 있어요.{lost}': 'This document was saved as a web page, so page breaks and fonts may differ from the original.{lost}',
};

function num(v) {
  return Number(String(v).replace(/,/g, ''));
}

/** 원문(한국어)으로 화면 글자를 찾는다. 영어 화면이 아니거나 영어가 없으면 원문에 vars만 채운다. */
export function T(ko, vars) {
  let s = LANG === 'en' && Object.prototype.hasOwnProperty.call(EN, ko) ? EN[ko] : ko;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (LANG === 'en') s = s.replace(/\[(\w+)\|([^|\]]*)\|([^\]]*)\]/g, (m, k, one, many) => (vars && k in vars && num(vars[k]) === 1 ? one : many));
  return s;
}

/** 시험용: 이 원문의 영어가 있는지, 있으면 무엇인지 */
export function englishOf(ko) {
  return Object.prototype.hasOwnProperty.call(EN, ko) ? EN[ko] : null;
}

/** 여러 항목을 한 줄로: 한국어는 가운뎃점, 영어는 쉼표 */
export function joinList(items) {
  return items.join(LANG === 'en' ? ', ' : '·');
}

/** index.html에 적힌 글자(메뉴·버튼·안내)와 aria-label·placeholder를 화면 언어로 바꾼다. */
export function localizeStatic(root = document) {
  document.documentElement.lang = LANG;
  if (LANG === 'ko') return;
  for (const node of root.querySelectorAll('*')) {
    if (node.childNodes.length === 1 && node.firstChild.nodeType === 3) {
      const text = node.textContent.trim();
      if (/[가-힣]/.test(text)) node.textContent = T(text);
    }
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      const v = node.getAttribute(attr);
      if (v && /[가-힣]/.test(v)) node.setAttribute(attr, T(v));
    }
  }
}
