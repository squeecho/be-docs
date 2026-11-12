// react-docx의 알려진 문제를 묶기 전에 고친다. 고칠 자리(또는 이미 고쳐진 흔적)를 못 찾으면 빌드를 멈춘다.
import fs from 'node:fs';

const file = new URL('./node_modules/@extend-ai/react-docx/dist/index.js', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('./node_modules/@extend-ai/react-docx/package.json', import.meta.url)));
let src = fs.readFileSync(file, 'utf8');

function apply(name, before, after) {
  if (src.includes(after) && !src.includes(before)) {
    console.log(`react-docx 패치(${name}): 이미 적용됨`);
    return;
  }
  const count = src.split(before).length - 1;
  if (count !== 1) {
    console.error(`react-docx ${pkg.version} 패치(${name}): 고칠 자리를 ${count}곳 찾음(1곳이어야 함). 새 판에서 고쳐졌는지 확인하세요.`);
    process.exit(1);
  }
  src = src.replace(before, after);
  console.log(`react-docx 패치(${name}): 적용`);
}

function expect(name, code) {
  if (src.split(code).length - 1 !== 1) {
    console.error(`react-docx ${pkg.version}: ${name} 코드를 찾지 못했습니다. 라이브러리 동작을 다시 확인하세요.`);
    process.exit(1);
  }
  console.log(`react-docx ${pkg.version}: ${name} 라이브러리에 들어 있음(패치 불필요)`);
}

if (pkg.version === '0.9.2') {
  // 긴 문서를 스크롤하면 쪽수 계산이 114쪽 ↔ 115쪽처럼 오가며 끝없이 다시 그리다가
  // React가 "Maximum update depth exceeded"로 화면 전체를 내려 버린다(빈 화면).
  // 쪽수가 오가면 실측 기반 쪽 나눔을 끄는 감지 장치가 첫 화면을 숨겨 둘 때만 켜진다. 항상 켜지게 한다.
  apply('쪽수 진동 감지', `    if (!deferInitialPaginationPaint || isInitialPaginationSettled || disableMeasuredImportPagination) {
      return;
    }
    if (pageCount <= 0) {`, `    if (disableMeasuredImportPagination) {
      return;
    }
    if (pageCount <= 0) {`);
} else if (pkg.version === '0.10.0') {
  // 위 문제는 0.10.0에서 라이브러리가 같은 방식으로 고쳤다(읽기 전용 화면에서는 항상 감지).
  expect('쪽수 진동 감지', `    if (editor.canUndo || editor.canRedo || disableMeasuredImportPagination) {
      return;
    }
    if (pageCount <= 0) {`);
  // 글자마다 글꼴 문자군(한글·라틴 등)을 가르는 함수가 매번 문자열을 배열로 바꾸고 정규식 세 개를 돌려,
  // 긴 문서에서 0.9.2보다 쪽 나눔이 30~60% 느려졌다. 같은 결과를 글자별로 기억해 두고 흔한 경우(ASCII·한글 음절)는 바로 답한다.
  apply('글꼴 문자군 판별 속도', `function classifyDocxFontScript(value, style) {
  const character = Array.from(value)[0];
  if (!character) {
    return void 0;
  }
  if (style?.complexScript === true || style?.rightToLeft === true && style?.complexScript !== false) {
    return "complexScript";
  }
  const codePoint = character.codePointAt(0) ?? 0;`, `var docxFontScriptByCodePoint = new Map();
function classifyDocxFontScript(value, style) {
  if (!value) {
    return void 0;
  }
  if (style?.complexScript === true || style?.rightToLeft === true && style?.complexScript !== false) {
    return "complexScript";
  }
  const codePoint = value.codePointAt(0) ?? 0;
  if (codePoint <= 127) {
    return "ascii";
  }
  if (codePoint >= 44032 && codePoint <= 55203) {
    return "eastAsia";
  }
  if (docxFontScriptByCodePoint.has(codePoint)) {
    return docxFontScriptByCodePoint.get(codePoint);
  }
  const result = classifyDocxFontScriptSlow(String.fromCodePoint(codePoint), codePoint);
  docxFontScriptByCodePoint.set(codePoint, result);
  return result;
}
function classifyDocxFontScriptSlow(character, codePoint) {`);
  // 캐시를 읽을 때마다 지웠다 다시 넣어(최근 사용 순서 유지) 긴 키의 해시를 두 번 더 계산한다. 읽기만 한다(오래된 것부터 버림).
  apply('캐시 읽기 속도', `function getCachedValue(cache, key) {
  const cached = cache.get(key);
  if (cached === void 0) {
    return void 0;
  }
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}`, `function getCachedValue(cache, key) {
  return cache.get(key);
}`);
  // 탭 채움 점선(목차 "제목 ……… 12", 서식 "성명 ……… (인)")을 목차 스타일 문단에서만 그린다.
  // 문단의 탭 위치에 채움 문자가 지정돼 있으면 같은 방식으로 그리게 한다.
  apply('탭 채움 점선', `function paragraphUsesTabLeaders(paragraph) {
  if (!isTableOfContentsParagraph(paragraph)) {
    return false;
  }`, `function paragraphUsesTabLeaders(paragraph) {
  if (!isTableOfContentsParagraph(paragraph) && !(paragraph.style?.tabStops ?? []).some((tabStop) => tabStop.leader && tabStop.leader !== "none")) {
    return false;
  }`);
} else {
  console.error(`react-docx ${pkg.version}: 이 패치는 0.9.2·0.10.0용입니다. 새 판에서 문제가 고쳐졌는지 확인한 뒤 패치를 고치세요.`);
  process.exit(1);
}
fs.writeFileSync(file, src);
