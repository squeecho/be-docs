// 엑셀 조건부 서식: 칸 값에 따라 바뀌는 채우기·글자색·굵기와 데이터 막대를 계산한다.
// 규칙(sheet-format.js가 읽음)은 엑셀처럼 우선순위(priority) 순서로 적용한다. 같은 서식(예: 채우기)이 겹치면 앞선 규칙이 이기고,
// 겹치지 않는 서식(채우기 + 굵게)은 함께 입는다. "참이면 중지"가 걸린 규칙이 맞으면 뒤 규칙은 보지 않는다.
// 그리지 못하는 규칙(아이콘 집합, 표준편차 기준 평균 등)은 개수를 세어 알린다. 틀린 색을 지어내지 않는다.

const CELL_OPS = new Set(['lessThan', 'lessThanOrEqual', 'equal', 'notEqual', 'greaterThanOrEqual', 'greaterThan', 'between', 'notBetween']);
const TEXT_TYPES = new Set(['containsText', 'notContainsText', 'beginsWith', 'endsWith']);
const SIMPLE_TYPES = new Set(['containsBlanks', 'notContainsBlanks', 'containsErrors', 'notContainsErrors', 'duplicateValues', 'uniqueValues', 'top10']);
const PERIODS = new Set(['today', 'yesterday', 'tomorrow', 'last7Days', 'thisWeek', 'lastWeek', 'nextWeek', 'thisMonth', 'lastMonth', 'nextMonth']);
const POINTS = new Set(['min', 'max', 'num', 'percent', 'percentile']);
const MAX_SCAN = 200000;

// 엑셀 기본 아이콘 집합: 낮은 값 → 높은 값 순서의 [글자, 색]. 휴대폰 기본 글꼴에 있는 기호로 그린다.
const R = '#E0393E';
const Y = '#F2B416';
const G = '#2E9E4F';
const K = '#7F7F7F';
const ICONS = {
  '3Arrows': [['↓', R], ['→', Y], ['↑', G]],
  '3ArrowsGray': [['↓', K], ['→', K], ['↑', K]],
  '3Flags': [['⚑', R], ['⚑', Y], ['⚑', G]],
  '3TrafficLights1': [['●', R], ['●', Y], ['●', G]],
  '3TrafficLights2': [['●', R], ['●', Y], ['●', G]],
  '3Signs': [['◆', R], ['▲', Y], ['●', G]],
  '3Symbols': [['✖', R], ['!', Y], ['✔', G]],
  '3Symbols2': [['✖', R], ['!', Y], ['✔', G]],
  '4Arrows': [['↓', R], ['↘', Y], ['↗', Y], ['↑', G]],
  '4ArrowsGray': [['↓', K], ['↘', K], ['↗', K], ['↑', K]],
  '4RedToBlack': [['●', '#222222'], ['●', K], ['●', '#F4A6A6'], ['●', R]],
  '4Rating': [['▂', '#2F6FB5'], ['▄', '#2F6FB5'], ['▆', '#2F6FB5'], ['█', '#2F6FB5']],
  '4TrafficLights': [['●', '#222222'], ['●', R], ['●', Y], ['●', G]],
  '5Arrows': [['↓', R], ['↘', Y], ['→', Y], ['↗', Y], ['↑', G]],
  '5ArrowsGray': [['↓', K], ['↘', K], ['→', K], ['↗', K], ['↑', K]],
  '5Rating': [['▁', '#2F6FB5'], ['▂', '#2F6FB5'], ['▄', '#2F6FB5'], ['▆', '#2F6FB5'], ['█', '#2F6FB5']],
  '5Quarters': [['○', K], ['◔', K], ['◑', K], ['◕', K], ['●', K]],
}; // 범위 통계(상위·평균·중복·색 단계)를 낼 때 볼 칸 수 상한

// 숫자·"글자"·TRUE/FALSE 같은 고정값이면 { v }를, 수식이면 null을 돌려준다.
function literal(f) {
  const t = String(f == null ? '' : f).trim().replace(/^=/, '');
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return { v: Number(t) };
  const m = /^"((?:[^"]|"")*)"$/.exec(t);
  if (m) return { v: m[1].replace(/""/g, '"') };
  if (/^(TRUE|FALSE)$/i.test(t)) return { v: /^TRUE$/i.test(t) };
  return null;
}

export function needsFormulas(cf) {
  if (!cf) return false;
  return cf.blocks.some((b) => b.rules.some((r) => r.type === 'expression'
    || (r.type === 'cellIs' && r.formulas.some((f) => !literal(f)))));
}

const rgb = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const mix = (a, b, t) => toHex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));

// 엑셀 비교: 빈칸은 상대에 따라 0 또는 ""로 보고, 종류가 다르면 숫자 < 글자 < 논리값 순서다. 글자는 대소문자를 가리지 않는다.
function compare(a, b) {
  if (a == null) a = typeof b === 'string' ? '' : 0;
  if (b == null) b = typeof a === 'string' ? '' : 0;
  const rank = (x) => (typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  if (typeof a === 'string') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const x = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const i = Math.floor(x);
  return i + 1 < sorted.length ? sorted[i] + (sorted[i + 1] - sorted[i]) * (x - i) : sorted[i];
}

/**
 * cf: 시트의 조건부 서식({ blocks, extOnly }), dxfs: 서식 목록, cellAt(r, c): 칸,
 * used: 자료 범위({s, e}), date1904, evalFormula(formula, baseR, baseC, r, c): 수식 계산(없으면 수식 규칙은 건너뜀)
 */
export function makeConditional({ cf, dxfs, cellAt, used, date1904, evalFormula }) {
  const rules = [];
  for (const b of cf.blocks) for (const r of b.rules) rules.push({ ...r, ranges: b.ranges, base: b.ranges[0].s });
  rules.sort((a, b) => a.priority - b.priority);
  let skipped = cf.extOnly || 0;
  let budget = 200000; // 수식 규칙을 계산할 칸 수 상한(아주 큰 범위에서 멈추지 않게)

  const pointOk = (p) => p && POINTS.has(p.type) && (p.type === 'min' || p.type === 'max' || Number.isFinite(Number(p.val)));
  for (const r of rules) {
    let ok = false;
    if (r.type === 'cellIs') ok = CELL_OPS.has(r.op) && r.formulas.length >= (r.op === 'between' || r.op === 'notBetween' ? 2 : 1)
      && r.formulas.every((f) => literal(f) || evalFormula);
    else if (r.type === 'expression') ok = !!evalFormula && !!r.formulas[0];
    else if (TEXT_TYPES.has(r.type)) ok = r.text != null;
    else if (r.type === 'aboveAverage') ok = !r.stdDev;
    else if (r.type === 'timePeriod') ok = PERIODS.has(r.period);
    else if (r.type === 'colorScale') ok = !!r.scale && r.scale.colors.length >= 2 && r.scale.colors.every(Boolean)
      && r.scale.cfvo.length === r.scale.colors.length && r.scale.cfvo.every(pointOk);
    else if (r.type === 'dataBar') ok = !!r.bar && r.bar.cfvo.length >= 2 && r.bar.cfvo.every(pointOk);
    else if (r.type === 'iconSet') ok = !!r.icons && !!ICONS[r.icons.set] && r.icons.cfvo.length === ICONS[r.icons.set].length
      && r.icons.cfvo.every(pointOk);
    else ok = SIMPLE_TYPES.has(r.type);
    r.ok = ok;
    if (!ok) skipped++;
  }

  const value = (cell) => {
    if (!cell || cell.t === 'z' || cell.v == null || cell.v === '') return null;
    if (cell.t === 'e') return { error: true };
    if (cell.v instanceof Date) return (cell.v - Date.UTC(1899, 11, 30)) / 86400000;
    return cell.v;
  };
  const isError = (v) => v && typeof v === 'object' && v.error;
  const asText = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)).toLowerCase();
  const inRange = (g, r, c) => r >= g.s.r && r <= g.e.r && c >= g.s.c && c <= g.e.c;

  // 범위 통계는 처음 필요할 때 한 번만 낸다.
  const stats = (rule) => {
    if (rule.stats) return rule.stats;
    const nums = [];
    const counts = new Map();
    let seen = 0;
    for (const g of rule.ranges) {
      const r0 = Math.max(g.s.r, used.s.r);
      const r1 = Math.min(g.e.r, used.e.r);
      const c0 = Math.max(g.s.c, used.s.c);
      const c1 = Math.min(g.e.c, used.e.c);
      for (let r = r0; r <= r1 && seen < MAX_SCAN; r++) {
        for (let c = c0; c <= c1 && seen < MAX_SCAN; c++) {
          seen++;
          const v = value(cellAt(r, c));
          if (v == null || isError(v)) continue;
          if (typeof v === 'number') nums.push(v);
          const k = typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
    const sorted = nums.slice().sort((a, b) => a - b);
    rule.stats = {
      sorted,
      counts,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN,
    };
    return rule.stats;
  };
  const point = (p, st) => {
    if (p.type === 'min') return st.min;
    if (p.type === 'max') return st.max;
    const v = Number(p.val);
    if (p.type === 'num') return v;
    if (p.type === 'percent') return st.min + (st.max - st.min) * v / 100;
    return percentile(st.sorted, v / 100);
  };

  const today = () => {
    const d = new Date();
    return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000) - (date1904 ? 1462 : 0);
  };
  const inPeriod = (period, v) => {
    if (typeof v !== 'number') return false;
    const day = Math.floor(v);
    const t = today();
    const dow = (t + (date1904 ? 1462 : 0) + 6) % 7; // 0 = 일요일(1899-12-30은 토요일)
    const date = (serial) => new Date(Date.UTC(1899, 11, 30) + (serial + (date1904 ? 1462 : 0)) * 86400000);
    const ym = (serial) => {
      const x = date(serial);
      return x.getUTCFullYear() * 12 + x.getUTCMonth();
    };
    switch (period) {
      case 'today': return day === t;
      case 'yesterday': return day === t - 1;
      case 'tomorrow': return day === t + 1;
      case 'last7Days': return day <= t && day > t - 7;
      case 'thisWeek': return day >= t - dow && day <= t - dow + 6;
      case 'lastWeek': return day >= t - dow - 7 && day <= t - dow - 1;
      case 'nextWeek': return day >= t - dow + 7 && day <= t - dow + 13;
      case 'thisMonth': return ym(day) === ym(t);
      case 'lastMonth': return ym(day) === ym(t) - 1;
      case 'nextMonth': return ym(day) === ym(t) + 1;
      default: return false;
    }
  };

  const operand = (rule, i, r, c) => {
    const lit = literal(rule.formulas[i]);
    if (lit) return lit.v;
    if (budget-- <= 0) return undefined;
    return evalFormula(rule.formulas[i], rule.base.r, rule.base.c, r, c);
  };

  // 규칙이 이 칸에 맞는지. 색 단계는 색, 데이터 막대는 막대 정보, 나머지는 true/false.
  const test = (rule, r, c, v) => {
    switch (rule.type) {
      case 'cellIs': {
        if (isError(v)) return false;
        const a = operand(rule, 0, r, c);
        if (a === undefined) return false;
        if (rule.op === 'between' || rule.op === 'notBetween') {
          const b = operand(rule, 1, r, c);
          if (b === undefined) return false;
          const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
          const inside = compare(v, lo) >= 0 && compare(v, hi) <= 0;
          return rule.op === 'between' ? inside : !inside;
        }
        const k = compare(v, a);
        return { lessThan: k < 0, lessThanOrEqual: k <= 0, equal: k === 0, notEqual: k !== 0, greaterThanOrEqual: k >= 0, greaterThan: k > 0 }[rule.op];
      }
      case 'expression': {
        if (budget-- <= 0) return false;
        const out = evalFormula(rule.formulas[0], rule.base.r, rule.base.c, r, c);
        return out === true || (typeof out === 'number' && out !== 0);
      }
      case 'containsText': return !isError(v) && asText(v).includes(rule.text.toLowerCase());
      case 'notContainsText': return isError(v) || !asText(v).includes(rule.text.toLowerCase());
      case 'beginsWith': return !isError(v) && asText(v).startsWith(rule.text.toLowerCase());
      case 'endsWith': return !isError(v) && asText(v).endsWith(rule.text.toLowerCase());
      case 'containsBlanks': return !isError(v) && asText(v).trim() === '';
      case 'notContainsBlanks': return isError(v) || asText(v).trim() !== '';
      case 'containsErrors': return !!isError(v);
      case 'notContainsErrors': return !isError(v);
      case 'timePeriod': return inPeriod(rule.period, v);
      case 'duplicateValues':
      case 'uniqueValues': {
        if (v == null || isError(v)) return false;
        const k = typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`;
        const n = stats(rule).counts.get(k) || 0;
        return rule.type === 'duplicateValues' ? n > 1 : n === 1;
      }
      case 'top10': {
        if (typeof v !== 'number') return false;
        const { sorted } = stats(rule);
        if (!sorted.length) return false;
        const n = Math.max(1, rule.percent ? Math.floor(sorted.length * rule.rank / 100) : rule.rank);
        if (rule.bottom) return v <= sorted[Math.min(n, sorted.length) - 1];
        return v >= sorted[Math.max(0, sorted.length - n)];
      }
      case 'aboveAverage': {
        if (typeof v !== 'number') return false;
        const { avg } = stats(rule);
        if (!Number.isFinite(avg)) return false;
        if (rule.above) return rule.equal ? v >= avg : v > avg;
        return rule.equal ? v <= avg : v < avg;
      }
      case 'colorScale': {
        if (typeof v !== 'number') return false;
        const st = stats(rule);
        const pts = rule.scale.cfvo.map((p) => point(p, st));
        const cols = rule.scale.colors;
        if (pts.some((p) => !Number.isFinite(p))) return false;
        if (v <= pts[0]) return cols[0];
        for (let i = 1; i < pts.length; i++) {
          if (v <= pts[i]) return pts[i] === pts[i - 1] ? cols[i] : mix(cols[i - 1], cols[i], (v - pts[i - 1]) / (pts[i] - pts[i - 1]));
        }
        return cols[cols.length - 1];
      }
      case 'dataBar': {
        if (typeof v !== 'number') return false;
        const st = stats(rule);
        const lo = point(rule.bar.cfvo[0], st);
        const hi = point(rule.bar.cfvo[rule.bar.cfvo.length - 1], st);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
        const t = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 1;
        const minL = Math.min(100, Math.max(0, rule.bar.min));
        const maxL = Math.min(100, Math.max(minL, rule.bar.max));
        return { pct: minL + (maxL - minL) * t, color: rule.bar.color, hideValue: !rule.bar.showValue };
      }
      case 'iconSet': {
        if (typeof v !== 'number') return false;
        const st = stats(rule);
        const pts = rule.icons.cfvo.map((p) => point(p, st));
        if (pts.some((p) => !Number.isFinite(p))) return false;
        let k = 0;
        for (let i = 1; i < pts.length; i++) if (rule.icons.cfvo[i].gte ? v >= pts[i] : v > pts[i]) k = i;
        if (rule.icons.reverse) k = pts.length - 1 - k;
        const [glyph, color] = ICONS[rule.icons.set][k];
        return { glyph, color, hideValue: !rule.icons.showValue };
      }
      default:
        return false;
    }
  };

  // 행마다 걸리는 규칙만 추려 둔다(규칙이 많은 파일에서 칸마다 전부 훑지 않게).
  const rowRules = new Map();
  const forRow = (r) => {
    let list = rowRules.get(r);
    if (!list) {
      list = rules.filter((rule) => rule.ok && rule.ranges.some((g) => r >= g.s.r && r <= g.e.r));
      rowRules.set(r, list);
    }
    return list;
  };

  return {
    skipped: () => skipped,
    // 이 칸에 입힐 서식: { fill, color, b, i, u, s, bar, icon } 또는 null
    at(r, c, cell) {
      const list = forRow(r);
      if (!list.length) return null;
      let out = null;
      const v = value(cell);
      for (const rule of list) {
        if (!rule.ranges.some((g) => inRange(g, r, c))) continue;
        let hit;
        try {
          hit = test(rule, r, c, v);
        } catch (_) {
          hit = false;
        }
        if (!hit) continue;
        out = out || {};
        if (rule.type === 'colorScale') {
          if (!out.fill) out.fill = hit;
        } else if (rule.type === 'dataBar') {
          if (!out.bar) out.bar = hit;
        } else if (rule.type === 'iconSet') {
          if (!out.icon) out.icon = hit;
        } else {
          const d = rule.dxf != null ? dxfs[rule.dxf] : null;
          if (d) for (const k of ['fill', 'color', 'b', 'i', 'u', 's']) if (d[k] != null && out[k] == null) out[k] = d[k];
        }
        if (rule.stop) break;
      }
      return out;
    },
  };
}
