// 화면 글자 번역 점검(브라우저 없이): 코드의 T('원문', {…})마다 영어가 있고, 영어의 {자리}·[n|…]에 쓰는 이름을
// 그 호출이 넘기는지, index.html에 적힌 한국어(글자·aria-label·placeholder)에도 영어가 있는지 본다.
// 빠뜨리면 영어 화면에 한국어가 그대로 나온다(T는 원문으로 돌아간다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/src/main/assets/viewer');
const { englishOf } = await import(path.join(dir, 'i18n.js'));
const HANGUL = /[가-힣]/;
const problems = [];
let calls = 0;

// 따옴표 문자열 하나를 읽는다(\\', \\n 등은 JS처럼 푼다)
function readString(src, at) {
  const q = src[at];
  let out = '';
  let i = at + 1;
  for (; i < src.length && src[i] !== q; i++) {
    if (src[i] === '\\') {
      const n = src[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else out += src[i];
  }
  return { text: out, end: i + 1 };
}

// T('…', { a, b: x, … }) 에서 넘기는 이름들
function argNames(src, at) {
  let i = at;
  while (/\s/.test(src[i])) i++;
  if (src[i] !== ',') return [];
  i++;
  while (/\s/.test(src[i])) i++;
  if (src[i] !== '{') return null; // 변수로 넘김: 이름을 모른다
  let depth = 0;
  let part = '';
  const parts = [];
  for (; i < src.length; i++) {
    const c = src[i];
    if ('{[('.includes(c)) depth++;
    if ('}])'.includes(c)) depth--;
    if (depth === 0) break;
    if (depth === 1 && c === ',') { parts.push(part); part = ''; continue; }
    if (!(depth === 1 && c === '{')) part += c;
  }
  parts.push(part);
  return parts.map((p) => (/^\s*(\w+)/.exec(p) || [])[1]).filter(Boolean);
}

for (const file of ['viewer.js', 'simple-view.js', 'sheet-chart.js']) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const re = /\bT\((['"])/g;
  for (let m; (m = re.exec(src));) {
    const { text: ko, end } = readString(src, m.index + 2);
    calls++;
    if (!HANGUL.test(ko)) continue;
    const en = englishOf(ko);
    if (en == null) { problems.push(`${file}: 영어 없음: ${ko}`); continue; }
    if (HANGUL.test(en) && !en.includes('(This product')) problems.push(`${file}: 영어에 한국어가 남음: ${en}`);
    const names = argNames(src, end);
    const used = [...en.matchAll(/\{(\w+)\}|\[(\w+)\|/g)].map((x) => x[1] || x[2]);
    const koUsed = [...ko.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    if (names) for (const u of new Set([...used, ...koUsed])) if (!names.includes(u)) problems.push(`${file}: "${ko}"에 {${u}}를 넘기지 않음`);
    if (!names && (used.length || koUsed.length)) problems.push(`${file}: "${ko}"의 자리 값을 확인할 수 없음`);
  }
}

// 변수로 T에 넘기는 원문(정의 자리에서 감싸지 않은 것)
const viewer = fs.readFileSync(path.join(dir, 'viewer.js'), 'utf8');
const supported = /const SUPPORTED = '([^']+)'/.exec(viewer)[1];
const simple = [.../SIMPLE_LABEL = \{([^}]+)\}/.exec(viewer)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
for (const ko of [supported, ...simple]) if (englishOf(ko) == null) problems.push(`viewer.js: 영어 없음(변수): ${ko}`);

// index.html에 적힌 한국어
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
for (const m of html.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) {
  const ko = m[1].trim();
  if (englishOf(ko) == null) problems.push(`index.html: 영어 없음: ${ko}`);
}
for (const m of html.matchAll(/(?:aria-label|placeholder)="([^"]*[가-힣][^"]*)"/g)) {
  if (englishOf(m[1]) == null) problems.push(`index.html: 영어 없음(속성): ${m[1]}`);
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`FAIL 번역 점검: ${problems.length}건 (T 호출 ${calls}개)`);
  process.exit(1);
}
console.log(`PASS 번역 점검: T 호출 ${calls}개, index.html 포함 영어 빠짐 없음`);
