// pdf.js(묶은 pdf.mjs)의 알려진 문제를 고친다. 고칠 자리(또는 이미 고쳐진 흔적)를 못 찾으면 빌드를 멈춘다.
// 사용: node patch-pdfjs.mjs <pdf.mjs 경로>
import fs from 'node:fs';

const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');
const MARK = '/*be-docs:path-string*/';

// 도면(CAD) PDF가 몇 초씩 멈추던 문제.
// 최신 크롬(141에서 확인)은 Path2D.closePath()가 경로 길이에 비례해 느려서, 작은 닫힌 도형이 수만 개인 경로를
// 하나씩 만들면 시간이 제곱으로 는다(닫힌 삼각형 1만6천 개: 크롬 109는 6ms, 141은 약 0.9초).
// pdf.js는 쪽의 선을 이 방식으로 만들어 무거운 도면 한 쪽에 화면 처리가 2초 넘게 멈췄고 그동안 두 손가락 확대·축소가 먹지 않았다.
// 같은 경로를 SVG 경로 글자로 만들어 한 번에 Path2D로 바꾼다(그리는 결과는 같고 시간은 길이에 비례).
// 캔버스 규칙을 그대로 따른다: 현재 점이 없을 때의 lineTo는 moveTo, 곡선은 첫 조절점에서 시작, 빈 경로의 closePath는 무시,
// 유한하지 않은 좌표가 든 명령은 무시(캔버스도 무시한다).
function patchPathBuilder() {
  if (src.includes(MARK)) {
    console.log('pdf.js 패치(경로 만들기): 이미 적용됨');
    return;
  }
  const v = '[\\w$]+';
  const re = new RegExp(
    'function makePathFromDrawOPS\\((' + v + ')\\)\\{const (' + v + ')=new Path2D;if\\(!\\1\\)return \\2;' +
    'for\\(let i=0,n=\\1\\.length;i<n;\\)switch\\(\\1\\[i\\+\\+\\]\\)\\{' +
    'case (' + v + '):\\2\\.moveTo\\(\\1\\[i\\+\\+\\],\\1\\[i\\+\\+\\]\\);break;' +
    'case (' + v + '):\\2\\.lineTo\\(\\1\\[i\\+\\+\\],\\1\\[i\\+\\+\\]\\);break;' +
    'case (' + v + '):\\2\\.bezierCurveTo\\((?:\\1\\[i\\+\\+\\],){5}\\1\\[i\\+\\+\\]\\);break;' +
    'case (' + v + '):\\2\\.quadraticCurveTo\\((?:\\1\\[i\\+\\+\\],){3}\\1\\[i\\+\\+\\]\\);break;' +
    'case (' + v + '):\\2\\.closePath\\(\\);break;' +
    'default:(' + v + ')\\(`Unrecognized drawing path operator: \\$\\{\\1\\[i-1\\]\\}`\\)\\}return \\2\\}', 'g');
  const found = [...src.matchAll(re)];
  if (found.length !== 1) {
    console.error(`pdf.js 패치(경로 만들기): 고칠 자리를 ${found.length}곳 찾음(1곳이어야 함). 새 판에서 바뀌었는지 확인하세요.`);
    process.exit(1);
  }
  const [whole, , , MOVE, LINE, CURVE, QUAD, CLOSE, WARN] = found[0];
  // 새 함수 안의 이름과 겹치면 다른 값을 가리키게 되므로 멈춘다.
  const local = new Set(['t', 'f', 's', 'h', 'i', 'n', 'a', 'b', 'c', 'd', 'x', 'y', 'Path2D', 'Number']);
  if ([MOVE, LINE, CURVE, QUAD, CLOSE, WARN].some((name) => local.has(name))) {
    console.error('pdf.js 패치(경로 만들기): 묶은 코드의 이름이 새 함수의 이름과 겹칩니다. 패치를 고쳐 주세요.');
    process.exit(1);
  }
  const body = `function makePathFromDrawOPS(t){${MARK}if(!t)return new Path2D;const f=Number.isFinite;let s="",h=!1;` +
    `for(let i=0,n=t.length;i<n;)switch(t[i++]){` +
    `case ${MOVE}:{const x=t[i++],y=t[i++];if(f(x)&&f(y)){s+="M"+x+" "+y;h=!0}break}` +
    `case ${LINE}:{const x=t[i++],y=t[i++];if(f(x)&&f(y)){s+=(h?"L":"M")+x+" "+y;h=!0}break}` +
    `case ${CURVE}:{const a=t[i++],b=t[i++],c=t[i++],d=t[i++],x=t[i++],y=t[i++];` +
    `if(f(a)&&f(b)&&f(c)&&f(d)&&f(x)&&f(y)){h||(s+="M"+a+" "+b);s+="C"+a+" "+b+" "+c+" "+d+" "+x+" "+y;h=!0}break}` +
    `case ${QUAD}:{const a=t[i++],b=t[i++],x=t[i++],y=t[i++];` +
    `if(f(a)&&f(b)&&f(x)&&f(y)){h||(s+="M"+a+" "+b);s+="Q"+a+" "+b+" "+x+" "+y;h=!0}break}` +
    `case ${CLOSE}:h&&(s+="Z");break;` +
    `default:${WARN}(\`Unrecognized drawing path operator: \${t[i-1]}\`)}` +
    `return new Path2D(s)}`;
  src = src.replace(whole, () => body);
  console.log('pdf.js 패치(경로 만들기): 적용');
}

patchPathBuilder();
// Apache-2.0(pdf.js 라이선스): 고친 파일에는 고쳤다는 안내를 눈에 띄게 둔다.
const NOTICE = '/* Modified by be docs: makePathFromDrawOPS builds the path from one SVG path string (see viewer-libs/patch-pdfjs.mjs). */\n';
if (!src.startsWith(NOTICE)) src = NOTICE + src;
fs.writeFileSync(file, src);
