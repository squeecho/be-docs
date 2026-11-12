// 엑셀 수식 계산 묶음의 입구.
// 엑셀·LibreOffice·구글 시트가 저장한 파일에는 수식의 계산 결과가 함께 들어 있어 그대로 보여주면 되지만,
// 웹 시스템의 "엑셀 다운로드"나 파이썬·자바 프로그램이 만든 파일은 결과 없이 수식만 들어 있는 경우가 있다.
// 그런 칸만 여기서 계산한다. 계산하지 못한 칸은 그대로 두고(화면에는 수식 글자가 보인다) 틀린 값을 지어내지 않는다.
//
// - 수식 해석·참조 계산: fast-formula-parser (MIT)
// - 위 라이브러리에 없는 함수(MAX·MIN·COUNTA·MATCH·SUMIFS 등): @formulajs/formulajs (MIT)
import FormulaParser from 'fast-formula-parser';
import * as formulajs from '@formulajs/formulajs';

const { FormulaError } = FormulaParser;

// fast-formula-parser에 없을 때 formulajs로 채울 함수들(엑셀 이름)
const FILL = [
  'MAX', 'MIN', 'MAXA', 'MINA', 'COUNTA', 'COUNTBLANK', 'SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'MAXIFS', 'MINIFS',
  'MATCH', 'LOOKUP', 'TEXTJOIN', 'VALUE', 'UPPER', 'LOWER', 'PROPER', 'SUBSTITUTE', 'LEN', 'RANK', 'RANK.EQ', 'RANK.AVG',
  'LARGE', 'SMALL', 'STDEV', 'STDEV.S', 'STDEV.P', 'STDEVP', 'VAR', 'VAR.S', 'VAR.P', 'MEDIAN', 'MODE', 'MODE.SNGL',
  'CHOOSE', 'SUBTOTAL', 'PERCENTILE', 'PERCENTILE.INC', 'QUARTILE', 'QUARTILE.INC', 'PMT', 'FV', 'PV', 'NPV', 'IRR',
  'RATE', 'NPER', 'AVERAGEA', 'COUNTIF', 'SUMIF', 'AVERAGEIF', 'IFS', 'SWITCH', 'CONCAT', 'DAYS', 'ISOWEEKNUM',
];

const ERRORS = {
  '#N/A': FormulaError.NA, '#VALUE!': FormulaError.VALUE, '#DIV/0!': FormulaError.DIV0, '#NUM!': FormulaError.NUM,
  '#NAME?': FormulaError.NAME, '#REF!': FormulaError.REF, '#NULL!': FormulaError.NULL,
};

function lookupFormulajs(name) {
  let fn = formulajs;
  for (const part of name.split('.')) fn = fn && fn[part];
  // RANK·STDEV처럼 이름 아래에 판(.EQ·.S)이 묶여 있는 경우 엑셀 기본 동작에 해당하는 것을 고른다.
  if (fn && typeof fn === 'object') fn = fn.EQ || fn.S || fn.INC || fn.SNGL;
  return typeof fn === 'function' ? fn : null;
}

function firstError(values) {
  for (const v of values) {
    if (v instanceof FormulaError) return v;
    if (Array.isArray(v)) {
      for (const row of v) {
        if (Array.isArray(row)) {
          for (const x of row) if (x instanceof FormulaError) return x;
        } else if (row instanceof FormulaError) return row;
      }
    }
  }
  return null;
}

// 엑셀은 MAX·MEDIAN 같은 통계 함수에서 범위 안의 빈칸·글자·논리값을 셈하지 않는다.
// 함수마다 그 규칙이 적용되는 인자 위치('*'는 전부)
const NUMBERS_ONLY = {
  MAX: '*', MIN: '*', MEDIAN: '*', MODE: '*', 'MODE.SNGL': '*', STDEV: '*', 'STDEV.S': '*', 'STDEV.P': '*',
  STDEVP: '*', VAR: '*', 'VAR.S': '*', 'VAR.P': '*', LARGE: [0], SMALL: [0], PERCENTILE: [0], 'PERCENTILE.INC': [0],
  QUARTILE: [0], 'QUARTILE.INC': [0], RANK: [1], 'RANK.EQ': [1], 'RANK.AVG': [1],
};

function numbersIn(v) {
  return flatten(v).filter((x) => typeof x === 'number');
}

function adapt(fn, numbersOnly) {
  return (...params) => {
    const args = params.map((p, i) => {
      if (!p || p.omitted) return undefined;
      const ref = p.isRangeRef || p.isArray || Array.isArray(p.value);
      if (ref && numbersOnly && (numbersOnly === '*' || numbersOnly.includes(i))) {
        const err = firstError([p.value]);
        return err || numbersIn(p.value);
      }
      return p.value;
    });
    const err = firstError(args);
    if (err) return err;
    const out = fn(...args);
    if (out instanceof Error) return ERRORS[out.message] || FormulaError.VALUE;
    if (Array.isArray(out)) return FormulaError.VALUE; // 여러 칸으로 퍼지는 결과(동적 배열)는 다루지 않는다
    return out;
  };
}

function flatten(v) {
  if (!Array.isArray(v)) return [v];
  const out = [];
  for (const row of v) {
    if (Array.isArray(row)) out.push(...row);
    else out.push(row);
  }
  return out;
}

// XLOOKUP(찾을값, 찾을범위, 돌려줄범위, [없을때]) — 정확히 일치만 지원
function XLOOKUP(lookup, lookupArray, returnArray, ifNotFound) {
  const key = lookup && lookup.value;
  const keys = flatten(lookupArray && lookupArray.value);
  const vals = flatten(returnArray && returnArray.value);
  const norm = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
  const i = keys.findIndex((k) => norm(k) === norm(key));
  if (i >= 0 && i < vals.length) return vals[i] == null ? 0 : vals[i];
  if (ifNotFound && !ifNotFound.omitted) return ifNotFound.value;
  return FormulaError.NA;
}

// INDEX·CHOOSE는 라이브러리 안에서 참조를 직접 다루는 함수로 따로 처리돼 덮어쓸 수 없다.
// 수식 속 이름을 BEINDEX·BECHOOSE로 바꿔 아래 구현을 쓰게 한다(문자열·작은따옴표 시트 이름 안은 건드리지 않는다).
function renameFunctions(formula) {
  return formula
    .split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.replace(/\b(INDEX|CHOOSE)\s*\(/gi, (_, n) => `BE${n.toUpperCase()}(`)))
    .join('');
}

// INDEX(범위, 행, [열]) — 값만 돌려준다. 라이브러리의 INDEX는 다른 시트 범위를 가리키면 시트를 잃어버린다.
function INDEX(array, rowNum, colNum) {
  const a = array && array.value;
  const grid = Array.isArray(a) ? a.map((row) => (Array.isArray(row) ? row : [row])) : [[a]];
  let r = rowNum && !rowNum.omitted ? Math.trunc(Number(rowNum.value)) : 0;
  let c = colNum && !colNum.omitted ? Math.trunc(Number(colNum.value)) : 0;
  if (Number.isNaN(r) || Number.isNaN(c)) return FormulaError.VALUE;
  // 한 줄짜리 범위에 번호 하나만 주면 그 줄의 n번째로 본다.
  if (grid.length === 1 && (!colNum || colNum.omitted)) {
    c = r;
    r = 1;
  }
  if (c === 0 && grid[0] && grid[0].length === 1) c = 1;
  if (r === 0 && grid.length === 1) r = 1;
  if (r < 1 || c < 1) return FormulaError.VALUE; // 줄 전체·열 전체를 돌려주는 쓰임은 다루지 않는다
  if (r > grid.length || c > grid[0].length) return FormulaError.REF;
  const v = grid[r - 1][c - 1];
  return v == null ? 0 : v;
}

// CHOOSE(번호, 값1, 값2, …)
function CHOOSE(index, ...values) {
  const i = Math.trunc(Number(index && index.value));
  if (!(i >= 1 && i <= values.length)) return FormulaError.VALUE;
  const v = values[i - 1];
  return v && !v.omitted ? (v.value == null ? 0 : v.value) : 0;
}

// TRIM — 엑셀은 앞뒤 공백을 지우고 가운데 연속 공백을 하나로 줄인다.
function TRIM(text) {
  const v = text && text.value;
  if (v instanceof FormulaError) return v;
  return String(v == null ? '' : v).replace(/ +/g, ' ').trim();
}

let extraFunctions = null;
function functions() {
  if (extraFunctions) return extraFunctions;
  // 이 라이브러리에 이미 있는 함수는 그대로 쓰고, 없는 것만 채운다.
  const probe = new FormulaParser({ onCell: () => 0, onRange: () => [[0]] });
  extraFunctions = { XLOOKUP, BEINDEX: INDEX, BECHOOSE: CHOOSE, TRIM };
  for (const name of FILL) {
    if (extraFunctions[name]) continue;
    let missing = false;
    try {
      probe.parse(`${name}(1)`);
    } catch (e) {
      missing = /not implemented/i.test(String(e && (e.message || e)));
    }
    const fn = missing && lookupFormulajs(name);
    if (fn) extraFunctions[name] = adapt(fn, NUMBERS_ONLY[name]);
  }
  return extraFunctions;
}

function errorText(e) {
  return (e && e.error) || '#VALUE!';
}

// 범위 하나가 이보다 많은 칸을 가리키면 계산하지 않는다(SUM(A:XFD) 하나가 4,900만 칸을 읽어 화면이 멈췄다).
const MAX_RANGE_CELLS = 500000;

// 통합 문서의 칸을 읽어 수식을 계산하는 엔진. 결과 없는 수식 칸은 필요할 때 계산해 둔다(순환 참조는 #REF!).
// deadline(performance.now 시각)을 넘기면 칸을 읽다가도 멈춘다(수식 하나가 오래 걸려도 거기서 끊는다).
function makeEngine(XLSX, wb, { deadline: until = Infinity } = {}) {
  let deadline = until;
  const sheets = new Map();
  for (const name of wb.SheetNames || []) sheets.set(name.toLowerCase(), { name, ws: wb.Sheets[name] });
  const memo = new Map();
  const visiting = new Set();
  const sheetOf = (name) => sheets.get(String(name || '').toLowerCase());
  const UNSUPPORTED = Symbol('unsupported');

  // 시간이 넘었거나 범위가 너무 큰 계산은 "중단"한다. 라이브러리가 함수 안의 오류를 값(#ERROR!)으로 바꿔 삼킬 수 있어
  // 중단 횟수를 세어 두고, 계산 중에 중단이 있었던 칸과 그 칸에 기대는 칸은 값을 짓지 않고 수식 그대로 둔다.
  let aborts = 0;
  const ABORTED = Symbol('aborted');
  const abort = (why) => {
    aborts++;
    const e = new Error(why);
    e.formulaAbort = true;
    throw e;
  };
  const ranges = new Map();
  let rangeCells = 0;
  let reads = 0;
  const valueOf = (sheetName, r, c) => {
    if ((++reads & 1023) === 0 && performance.now() > deadline) abort('formula deadline');
    const s = sheetOf(sheetName);
    if (!s) return FormulaError.REF;
    const addr = XLSX.utils.encode_cell({ r, c });
    const cell = s.ws[addr];
    if (!cell || cell.t === 'z' && !cell.f) return null;
    if (cell.f && (cell.t === 'z' || cell.v === undefined)) {
      const v = evaluate(s.name, addr, cell);
      return v === UNSUPPORTED ? FormulaError.VALUE : v;
    }
    if (cell.t === 'e') return ERRORS[cell.w] || FormulaError.VALUE;
    if (cell.t === 'd') return (cell.v - new Date(Date.UTC(1899, 11, 30))) / 86400000;
    return cell.v === undefined ? null : cell.v;
  };

  let parser;
  const evaluate = (sheetName, addr, cell) => {
    const key = `${sheetName}!${addr}`;
    if (memo.has(key)) {
      const m = memo.get(key);
      if (m === ABORTED) abort('depends on an aborted cell');
      return m;
    }
    if (visiting.has(key)) return FormulaError.REF; // 순환 참조
    visiting.add(key);
    const abortsBefore = aborts;
    let result;
    try {
      const pos = XLSX.utils.decode_cell(addr);
      const formula = renameFunctions(String(cell.f).replace(/_xlfn\.|_xlws\./gi, ''));
      result = parser.parse(formula, { sheet: sheetName, row: pos.r + 1, col: pos.c + 1 });
      if (Array.isArray(result)) result = Array.isArray(result[0]) ? result[0][0] : result[0];
    } catch (_) {
      result = UNSUPPORTED;
    }
    visiting.delete(key);
    if (aborts !== abortsBefore) {
      memo.set(key, ABORTED);
      abort('aborted');
    }
    memo.set(key, result);
    return result;
  };

  parser = new FormulaParser({
    functions: functions(),
    onCell: ({ sheet, row, col }) => valueOf(sheet, row - 1, col - 1),
    onRange: ({ sheet, from, to }) => {
      const s = sheetOf(sheet);
      if (!s || !s.ws['!ref']) return [[null]];
      // A:A 같은 열 전체 참조는 실제 자료가 있는 범위까지만 본다.
      const used = XLSX.utils.decode_range(s.ws['!ref']);
      const r1 = Math.min(to.row - 1, used.e.r);
      const c1 = Math.min(to.col - 1, used.e.c);
      if ((Math.max(r1, from.row - 1) - from.row + 2) * (Math.max(c1, from.col - 1) - from.col + 2) > MAX_RANGE_CELLS) {
        abort('range too large');
      }
      // 같은 범위(VLOOKUP의 $A$1:$C$3000 등)를 수식마다 다시 읽지 않게 기억해 둔다. 칸 값은 한 번 정해지면 바뀌지 않는다.
      const key = `${s.name}!${from.row}:${from.col}:${r1}:${c1}`;
      const hit = ranges.get(key);
      if (hit) return hit.map((row) => row.slice());
      const rows = [];
      for (let r = from.row - 1; r <= Math.max(r1, from.row - 1); r++) {
        const row = [];
        for (let c = from.col - 1; c <= Math.max(c1, from.col - 1); c++) row.push(valueOf(s.name, r, c));
        rows.push(row);
      }
      const size = rows.length * rows[0].length;
      if (size >= 64 && rangeCells + size <= 4000000) {
        rangeCells += size;
        ranges.set(key, rows.map((row) => row.slice()));
      }
      return rows;
    },
  });
  return { sheets, evaluate, parser, UNSUPPORTED, setDeadline: (t) => { deadline = t; } };
}

/**
 * 결과값 없이 수식만 있는 칸을 계산해 칸(v·t·w)을 채운다.
 * XLSX: SheetJS, wb: 읽어 둔 통합 문서. 계산한 칸 수를 돌려준다.
 * limit: 계산할 칸 수 상한, deadline: 이 시각(performance.now)까지만 계산한다.
 */
export function fillMissingFormulas(XLSX, wb, { limit = 20000, deadline = Infinity } = {}) {
  const pending = [];
  for (const name of wb.SheetNames || []) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    for (const addr of Object.keys(ws)) {
      if (addr[0] === '!') continue;
      const c = ws[addr];
      if (c && c.f && (c.t === 'z' || c.v === undefined)) pending.push([name, addr, c]);
    }
  }
  if (!pending.length) return 0;
  const { evaluate, UNSUPPORTED } = makeEngine(XLSX, wb, { deadline });

  let done = 0;
  for (const [sheetName, addr, cell] of pending) {
    if (done >= limit || performance.now() > deadline) break;
    let v;
    try {
      v = evaluate(sheetName, addr, cell);
    } catch (e) {
      if (!(e && e.formulaAbort)) throw e;
      v = UNSUPPORTED; // 시간이 넘었거나 너무 큰 범위: 이 칸은 수식 그대로 둔다
    }
    done++;
    if (v === UNSUPPORTED || v === undefined) continue;
    if (v instanceof FormulaError) {
      cell.t = 'e';
      cell.v = 0;
      cell.w = errorText(v);
    } else if (typeof v === 'number') {
      cell.t = 'n';
      cell.v = v;
      try {
        cell.w = XLSX.SSF.format(cell.z || 'General', v);
      } catch (_) {
        cell.w = String(v);
      }
    } else if (typeof v === 'boolean') {
      cell.t = 'b';
      cell.v = v;
      cell.w = v ? 'TRUE' : 'FALSE';
    } else if (v === null) {
      cell.t = 'n';
      cell.v = 0;
      cell.w = XLSX.SSF.format(cell.z || 'General', 0);
    } else {
      cell.t = 's';
      cell.v = String(v);
      cell.w = String(v);
    }
    cell.computed = true;
  }
  return done;
}

const colIndex = (letters) => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};
const colLetters = (c) => {
  let s = '';
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
};

// 조건부 서식 수식의 상대 참조($ 없는 행·열)를 (dr, dc)만큼 옮긴다. 글자("…")·시트 이름('…') 안과 함수 이름은 건드리지 않는다.
export function shiftFormula(formula, dr, dc) {
  if (!dr && !dc) return formula;
  return String(formula)
    .split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|[^A-Za-z0-9_.$])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g,
      (m, pre, absC, col, absR, row) => {
        let c = colIndex(col);
        let r = Number(row) - 1;
        if (!absC) c += dc;
        if (!absR) r += dr;
        if (c < 0 || r < 0 || c > 16383 || r > 1048575) return `${pre}#REF!`;
        return `${pre}${absC}${colLetters(c)}${absR}${r + 1}`;
      })))
    .join('');
}

/**
 * 조건부 서식 수식 계산기. (시트 이름, 수식, 기준 행·열, 이 칸의 행·열) → 값. 계산하지 못하면 undefined.
 * 수식은 규칙 범위의 왼쪽 위 칸을 기준으로 적혀 있어, 칸마다 상대 참조를 옮겨 계산한다.
 */
export function conditionEvaluator(XLSX, wb, { budgetMs = 4000 } = {}) {
  const { parser, setDeadline } = makeEngine(XLSX, wb);
  // 화면 쪽에서 표를 그리며 계산하므로 계산 시간을 모두 합쳐 budgetMs까지만 쓴다(그 뒤로는 계산하지 않는다).
  let left = budgetMs;
  // 행 강조($D2="완료")처럼 열이 고정된 수식은 한 행의 칸들이 같은 수식이 된다. 옮긴 수식 글자로 결과를 기억해 다시 계산하지 않는다
  // (ROW()·COLUMN()처럼 칸 위치를 보는 함수가 있으면 기억하지 않는다).
  const cache = new Map();
  return (sheetName, formula, baseR, baseC, r, c) => {
    if (left <= 0) return undefined;
    const t0 = performance.now();
    setDeadline(t0 + left);
    try {
      const f = renameFunctions(shiftFormula(String(formula).replace(/^=/, ''), r - baseR, c - baseC).replace(/_xlfn\.|_xlws\./gi, ''));
      const positional = /\b(ROW|COLUMN|ROWS|COLUMNS|OFFSET|INDIRECT|CELL|ADDRESS)\s*\(/i.test(f);
      const key = `${sheetName}\u0000${f}`;
      if (!positional && cache.has(key)) return cache.get(key);
      let v = parser.parse(f, { sheet: sheetName, row: r + 1, col: c + 1 });
      if (Array.isArray(v)) v = Array.isArray(v[0]) ? v[0][0] : v[0];
      if (v instanceof FormulaError) v = undefined;
      if (!positional) {
        if (cache.size > 100000) cache.clear();
        cache.set(key, v);
      }
      return v;
    } catch (_) {
      return undefined;
    } finally {
      left -= performance.now() - t0;
    }
  };
}
