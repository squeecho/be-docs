// 워드 번호 매기기(w:numbering)를 글자로 쓴다. 엔진이 읽은 문서 구조로 만드는 읽기 보기(docx-entry.js)와
// 문서 XML을 직접 읽는 빠른 읽기 보기(docx-read.js)가 같은 번호를 내도록 함께 쓴다.
// 번호 정의 모양: { abstracts: [{ abstractNumId, levels: [{ ilvl, start, format, text, isLgl }] }],
//                 instances: [{ numId, abstractNumId, levelStartOverrides: { [ilvl]: start }, levelOverrides: [단계] }] }

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const GANADA = '가나다라마바사아자차카타파하';
const CHOSUNG = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const KO_DIGIT = '영일이삼사오육칠팔구';
const HANJA_DIGIT = '〇一二三四五六七八九';

function roman(n) {
  let out = '';
  for (const [v, r] of ROMAN) while (n >= v) { out += r; n -= v; }
  return out;
}

function letters(n) {
  let out = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
  return out;
}

// 번호 형식(w:numFmt)대로 n을 쓴다. 모르는 형식은 아라비아 숫자로.
function numberText(format, n) {
  switch (format) {
    case 'none': return '';
    case 'decimalZero': return String(n).padStart(2, '0');
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerLetter': return letters(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'ganada': return GANADA[(n - 1) % GANADA.length];
    case 'chosung': return CHOSUNG[(n - 1) % CHOSUNG.length];
    case 'decimalEnclosedCircle':
    case 'decimalEnclosedCircleChinese': return n >= 1 && n <= 20 ? CIRCLED[n - 1] : String(n);
    case 'koreanDigital': return String(n).split('').map((d) => KO_DIGIT[d]).join('');
    case 'ideographDigital':
    case 'japaneseCounting':
    case 'chineseCounting': return String(n).split('').map((d) => HANJA_DIGIT[d]).join('');
    default: return String(n);
  }
}

export function makeNumbering(meta) {
  const defs = meta.numberingDefinitions || { abstracts: [], instances: [] };
  const abstracts = new Map((defs.abstracts || []).map((a) => [a.abstractNumId, a]));
  const instances = new Map((defs.instances || []).map((i) => [i.numId, i]));
  const counters = new Map(); // numId → 단계별 현재 번호
  const level = (numId, ilvl) => {
    const inst = instances.get(numId);
    if (!inst) return null;
    const over = (inst.levelOverrides || []).find((l) => l.ilvl === ilvl);
    const base = ((abstracts.get(inst.abstractNumId) || {}).levels || []).find((l) => l.ilvl === ilvl);
    // 번호 목록은 있는데 단계 정의가 빠진 경우(엔진이 옛 doc의 목록을 읽을 때 등) 엔진의 쪽 모양처럼 "1." 꼴로 센다.
    if (!over && !base) return { ilvl, start: 1, format: 'decimal', text: `%${ilvl + 1}.` };
    const start = inst.levelStartOverrides && inst.levelStartOverrides[String(ilvl)] != null ? inst.levelStartOverrides[String(ilvl)] : (over || base).start;
    return { ...(base || {}), ...(over || {}), start: start ?? 1 };
  };
  return (numbering) => {
    if (!numbering || numbering.numId == null || numbering.numId === 0) return '';
    const { numId } = numbering;
    const ilvl = numbering.ilvl || 0;
    const lv = level(numId, ilvl);
    if (!lv) return '';
    if (lv.format === 'bullet') {
      const t = lv.text || '';
      // 기호 글꼴(Symbol·Wingdings)의 사용자 영역 글자는 휴대폰 글꼴에 없어 일반 글머리표로 바꾼다.
      // 둘째 단계 기본 글머리 "o"(Courier New)는 속이 빈 동그라미로 보이게 한다.
      if (t === 'o') return '◦ ';
      return /^[\u0020-\u007e\u00a0-\ud7ff\uf900-\ufffd]$/.test(t) ? `${t} ` : '• ';
    }
    const c = counters.get(numId) || [];
    for (let k = 0; k < ilvl; k++) if (c[k] == null) c[k] = (level(numId, k) || {}).start ?? 1;
    c[ilvl] = c[ilvl] == null ? lv.start : c[ilvl] + 1;
    c.length = ilvl + 1; // 아래 단계는 다시 처음부터
    counters.set(numId, c);
    const text = (lv.text || `%${ilvl + 1}.`).replace(/%(\d)/g, (_, d) => {
      const k = Number(d) - 1;
      const kl = k === ilvl ? lv : level(numId, k);
      return numberText(lv.isLgl ? 'decimal' : (kl || {}).format, c[k] ?? 1);
    });
    return text ? `${text} ` : '';
  };
}

export function colorOf(c) {
  if (!c || typeof c !== 'string') return undefined;
  const hex = c.replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : undefined;
}
