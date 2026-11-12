// 엑셀 차트(xl/charts/chartN.xml)를 파일에 저장된 값(캐시)으로 다시 그린다.
// 새로 설계하는 차트가 아니라 남이 만든 문서를 보여 주는 것이므로 종류·색·제목·보조 축은 파일을 따른다.
// 파일에 색이 없으면 엑셀처럼 문서 테마의 강조색을 차례로 쓴다. 글자는 모두 textContent로 넣는다.

import { T } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const kids = (node, local) => (node ? [...node.children].filter((n) => n.localName === local) : []);
const kid = (node, local) => kids(node, local)[0] || null;
const all = (node, local) => (node ? [...node.getElementsByTagNameNS('*', local)] : []);
const val = (node, local) => {
  const n = kid(node, local);
  return n ? n.getAttribute('val') : null;
};
const on = (node, local, dflt = false) => {
  const v = val(node, local);
  return v == null ? (kid(node, local) ? true : dflt) : v === '1' || v === 'true';
};

// ---------------------------------------------------------------- 색 (DrawingML)

function hexToHsl(hex) {
  const n = parseInt(hex, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const x = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return (x(r) + x(g) + x(b)).toUpperCase();
}

const SCHEME_ALIAS = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

// <a:srgbClr|schemeClr|sysClr|prstClr> + lumMod·lumOff·tint·shade → 'RRGGBB'
export function drawingColor(node, theme) {
  if (!node) return null;
  let hex = null;
  if (node.localName === 'srgbClr') hex = node.getAttribute('val');
  else if (node.localName === 'schemeClr') {
    const name = node.getAttribute('val');
    hex = theme[SCHEME_ALIAS[name] || name] || null;
  } else if (node.localName === 'sysClr') hex = node.getAttribute('lastClr') || (node.getAttribute('val') === 'window' ? 'FFFFFF' : '000000');
  else if (node.localName === 'prstClr') hex = { black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000', yellow: 'FFFF00', gray: '808080' }[node.getAttribute('val')] || null;
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  let [h, s, l] = hexToHsl(hex);
  for (const m of node.children) {
    const v = Number(m.getAttribute('val')) / 100000;
    if (m.localName === 'lumMod') l *= v;
    else if (m.localName === 'lumOff') l += v;
    else if (m.localName === 'tint') l = l * v + (1 - v);
    else if (m.localName === 'shade') l *= v;
  }
  return hslToHex(h, s, Math.min(1, Math.max(0, l)));
}

// <a:solidFill>·<a:gradFill>(첫 색)·<a:noFill> → 'RRGGBB' | 'none' | null(정해지지 않음)
export function fillOf(spPr, theme) {
  if (!spPr) return null;
  for (const n of spPr.children) {
    if (n.localName === 'noFill') return 'none';
    if (n.localName === 'solidFill') return drawingColor(n.firstElementChild, theme);
    if (n.localName === 'gradFill') {
      const gs = all(n, 'gs')[0];
      return gs ? drawingColor(gs.firstElementChild, theme) : null;
    }
    if (n.localName === 'pattFill') return drawingColor(kid(kid(n, 'fgClr'), 'srgbClr') || (kid(n, 'fgClr') || {}).firstElementChild, theme);
  }
  return null;
}

export function lineOf(spPr, theme) {
  const ln = kid(spPr, 'ln');
  if (!ln) return null;
  const color = fillOf(ln, theme);
  const w = Number(ln.getAttribute('w') || 0) / 12700; // EMU → pt
  return { color, w: w ? w * 96 / 72 : null };
}

// ---------------------------------------------------------------- 읽기

function richText(node) {
  if (!node) return '';
  return all(node, 'p').map((p) => all(p, 't').map((t) => t.textContent).join('')).join('\n').trim();
}

function cacheValues(ref, resolve) {
  // c:numRef/c:numCache, c:strRef/c:strCache, c:multiLvlStrRef(가장 안쪽 단계), c:numLit/c:strLit
  if (!ref) return [];
  let cache = all(ref, 'numCache')[0] || all(ref, 'strCache')[0] || all(ref, 'numLit')[0] || all(ref, 'strLit')[0];
  const multi = all(ref, 'multiLvlStrCache')[0];
  if (!cache && multi) cache = kid(multi, 'lvl');
  if (!cache) {
    // 보고서 프로그램이 만든 파일은 저장된 값 없이 칸 주소(c:f)만 적기도 한다. 그 칸을 통합 문서에서 읽는다.
    const f = all(ref, 'f')[0];
    const numeric = !!(all(ref, 'numRef')[0] || all(ref, 'numLit')[0]);
    return (f && resolve && resolve(f.textContent, numeric)) || [];
  }
  const count = Number(val(cache, 'ptCount') || (multi && val(multi, 'ptCount')) || 0);
  const out = new Array(count).fill(null);
  for (const pt of kids(cache, 'pt')) {
    const i = Number(pt.getAttribute('idx'));
    const v = kid(pt, 'v');
    if (i >= 0 && i < 100000) out[i] = v ? v.textContent : null;
  }
  return out;
}

const TYPES = {
  barChart: 'bar', bar3DChart: 'bar', lineChart: 'line', line3DChart: 'line', stockChart: 'line',
  pieChart: 'pie', pie3DChart: 'pie', ofPieChart: 'pie', doughnutChart: 'doughnut',
  areaChart: 'area', area3DChart: 'area', scatterChart: 'scatter', radarChart: 'radar',
};

// 차트 XML 문서 → 그리기 모델. 그릴 수 없는 종류만 있으면 null.
export function parseChart(doc, theme, resolve) {
  const chart = all(doc, 'chart').find((n) => n.namespaceURI === C_NS && n.parentElement && n.parentElement.localName === 'chartSpace');
  const plot = kid(chart, 'plotArea');
  if (!plot) return null;
  const valAxes = new Map();
  for (const ax of kids(plot, 'valAx')) {
    valAxes.set(val(ax, 'axId'), {
      right: val(ax, 'axPos') === 'r' || val(ax, 'axPos') === 't',
      deleted: on(ax, 'delete'),
      format: kid(ax, 'numFmt') ? kid(ax, 'numFmt').getAttribute('formatCode') : null,
      grid: !!kid(ax, 'majorGridlines'),
      min: val(kid(ax, 'scaling'), 'min'),
      max: val(kid(ax, 'scaling'), 'max'),
      title: richText(kid(ax, 'title')),
    });
  }
  const catAx = kid(plot, 'catAx') || kid(plot, 'dateAx');
  const groups = [];
  let skipped = 0;
  let seriesIndex = 0;
  for (const g of plot.children) {
    const type = TYPES[g.localName];
    if (!g.localName.endsWith('Chart')) continue;
    if (!type || type === 'radar') {
      skipped += kids(g, 'ser').length || 1;
      continue;
    }
    const axIds = kids(g, 'axId').map((a) => a.getAttribute('val'));
    const axis = axIds.map((id) => valAxes.get(id)).find(Boolean) || null;
    const vary = on(g, 'varyColors');
    const group = {
      type,
      dir: val(g, 'barDir') || 'col',
      grouping: val(g, 'grouping') || (type === 'bar' ? 'clustered' : 'standard'),
      gap: Number(val(g, 'gapWidth') || 150),
      hole: Number(val(g, 'holeSize') || 50),
      firstAngle: Number(val(g, 'firstSliceAng') || 0),
      scatterLines: type === 'scatter' && !['marker', 'none'].includes(val(g, 'scatterStyle') || 'lineMarker'),
      axis,
      labels: on(kid(g, 'dLbls'), 'showVal'),
      percentLabels: on(kid(g, 'dLbls'), 'showPercent'),
      series: [],
    };
    for (const ser of kids(g, 'ser')) {
      const idx = Number(val(ser, 'idx') ?? seriesIndex);
      seriesIndex++;
      const spPr = kid(ser, 'spPr');
      let color = type === 'line' || (type === 'scatter' && group.scatterLines) ? (lineOf(spPr, theme) || {}).color : fillOf(spPr, theme);
      if (!color || color === 'none') color = (type === 'line' ? null : (lineOf(spPr, theme) || {}).color) || null;
      const tx = kid(ser, 'tx');
      const name = tx ? String(cacheValues(tx, resolve)[0] ?? richText(tx) ?? (kid(tx, 'v') || {}).textContent ?? '') : '';
      const cats = cacheValues(kid(ser, 'cat') || kid(ser, 'xVal'), resolve);
      const vals = cacheValues(kid(ser, 'val') || kid(ser, 'yVal'), resolve).map((v) => (v == null || v === '' ? null : Number(v)));
      const points = new Map();
      for (const dp of kids(ser, 'dPt')) {
        const c = fillOf(kid(dp, 'spPr'), theme);
        if (c && c !== 'none') points.set(Number(val(dp, 'idx')), c);
      }
      const marker = kid(ser, 'marker');
      group.series.push({
        idx, name, cats, vals, color: color && color !== 'none' ? color : null, points,
        noLine: (lineOf(spPr, theme) || {}).color === 'none',
        marker: !(marker && val(marker, 'symbol') === 'none'),
        labels: on(kid(ser, 'dLbls'), 'showVal', group.labels),
        lineWidth: (lineOf(spPr, theme) || {}).w || null,
      });
    }
    if (group.series.length) groups.push(group);
  }
  if (!groups.length) return null;
  // 값을 하나도 찾지 못한 차트는 빈 틀을 그리지 않는다(보이지 않는다고 안내한다).
  if (!groups.some((g) => g.series.some((s) => s.vals.some((v) => v != null && Number.isFinite(v))))) return null;
  // 계열 색이 없으면 엑셀처럼 테마 강조색 1~6을 차례로(7번째부터는 어둡게) 쓴다.
  const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((k) => theme[k] || null);
  const fallback = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
  const auto = (i) => {
    const base = accents[i % 6] || fallback[i % 6];
    const round = Math.floor(i / 6);
    if (!round) return base;
    const [h, s, l] = hexToHsl(base);
    return hslToHex(h, s, l * (round % 2 ? 0.6 : 1.2));
  };
  for (const g of groups) {
    for (const s of g.series) if (!s.color) s.color = auto(s.idx);
  }
  const pieColors = Array.from({ length: 12 }, (_, i) => auto(i));
  const primary = groups.find((g) => !(g.axis && g.axis.right)) || groups[0];
  const series = groups.flatMap((g) => g.series);
  let title = richText(kid(kid(chart, 'title'), 'tx')) || '';
  const autoDeleted = on(chart, 'autoTitleDeleted');
  if (!title && kid(chart, 'title') && series.length === 1) title = series[0].name;
  if (!title && !autoDeleted && series.length === 1 && groups[0].type !== 'pie' && groups[0].type !== 'doughnut') title = series[0].name;
  const legend = kid(chart, 'legend');
  return {
    title,
    groups,
    primary,
    legend: legend ? (val(legend, 'legendPos') || 'r') : null,
    catTitle: richText(kid(catAx, 'title')),
    catHidden: catAx ? on(catAx, 'delete') : false,
    reverseCats: catAx ? val(kid(catAx, 'scaling'), 'orientation') === 'maxMin' : false,
    pieColors,
    skipped,
  };
}

// ---------------------------------------------------------------- 그리기

function svgEl(tag, attrs = {}, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
}

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function niceScale(min, max, count) {
  if (min === max) {
    if (max === 0) max = 1;
    else if (max > 0) min = 0;
    else max = 0;
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { lo, hi, ticks, step };
}

function formatter(format, percent) {
  const f = format || '';
  if (percent || /%/.test(f)) {
    const d = (/\.(0+)%/.exec(f) || ['', ''])[1].length;
    return (v) => `${(v * (percent ? 1 : 100)).toFixed(d)}%`;
  }
  const d = (/\.(0+)/.exec(f) || ['', ''])[1].length;
  const group = /#,##0|,/.test(f) || !f || f === 'General';
  return (v) => (Number.isFinite(v) ? v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: f && f !== 'General' ? d : 2, useGrouping: group }) : '');
}

const INK = '#404040';
const MUTED = '#767676';
const GRID = '#d9d9d9';

// 글자 폭 어림(한글·한자는 글자 크기만큼, 영문·숫자는 그 절반 남짓)
function textWidth(text, fs) {
  let w = 0;
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) w += fs;
    else if (ch === ' ') w += fs * 0.3;
    else if (/[A-Z0-9%#@&WM]/.test(ch)) w += fs * 0.64;
    else w += fs * 0.55;
  }
  return w;
}

// 주어진 폭에 들어가게 자르고 말줄임표를 붙인다.
function fitText(text, maxWidth, fs) {
  const s = String(text ?? '');
  if (textWidth(s, fs) <= maxWidth) return s;
  const chars = [...s];
  while (chars.length > 1 && textWidth(`${chars.join('')}…`, fs) > maxWidth) chars.pop();
  return `${chars.join('')}…`;
}

// 모델 → <svg> (가로 w, 세로 h 픽셀). 바탕은 엑셀처럼 흰색(어두운 화면에서도 차트 색이 그대로 보이게).
export function renderChart(model, w, h) {
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img', 'font-family': 'sans-serif' });
  svg.append(svgEl('rect', { x: 0, y: 0, width: w, height: h, fill: '#ffffff', stroke: '#d9d9d9' }));
  const fs = Math.max(9, Math.min(12, Math.round(Math.min(w, h) / 22)));
  let top = 8;
  let bottom = h - 8;
  let left = 8;
  let right = w - 8;
  if (model.title) {
    const t = svgEl('text', { x: w / 2, y: top + fs + 2, 'text-anchor': 'middle', 'font-size': fs + 2, 'font-weight': 700, fill: INK }, fitText(model.title, w - 16, fs + 2));
    svg.append(t);
    top += fs + 10;
  }
  svg.setAttribute('aria-label', model.title || T('차트'));
  const pieLike = model.primary.type === 'pie' || model.primary.type === 'doughnut';
  // 범례
  const items = pieLike
    ? model.primary.series[0].cats.map((c, i) => ({ name: c ?? String(i + 1), color: pieColor(model, i) }))
    : model.groups.flatMap((g) => g.series.map((s) => ({ name: s.name || T('계열 {n}', { n: s.idx + 1 }), color: s.color, line: g.type === 'line' })));
  if (model.legend && items.length) {
    const lfs = fs - 1;
    if (model.legend === 'r' || model.legend === 'l' || model.legend === 'tr') {
      const lw = Math.min(w * 0.35, 16 + Math.max(...items.map((it) => textWidth(it.name, lfs))));
      const x0 = model.legend === 'l' ? left : right - lw;
      let y = Math.max(top, (top + bottom) / 2 - (items.length * (lfs + 6)) / 2);
      for (const it of items.slice(0, Math.floor((bottom - top) / (lfs + 6)))) {
        svg.append(svgEl('rect', { x: x0, y: y + 1, width: 9, height: 9, rx: 2, fill: `#${it.color}` }));
        svg.append(svgEl('text', { x: x0 + 13, y: y + lfs - 1, 'font-size': lfs, fill: INK }, fitText(it.name, lw - 14, lfs)));
        y += lfs + 6;
      }
      if (model.legend === 'l') left += lw + 6;
      else right -= lw + 6;
    } else {
      const rowsY = [];
      let x = left;
      let row = 0;
      const widths = items.map((it) => 24 + Math.min(textWidth(it.name, lfs), (right - left) * 0.45));
      items.forEach((it, i) => {
        if (x + widths[i] > right && x > left) { row++; x = left; }
        rowsY.push({ it, x, row });
        x += widths[i];
      });
      const rowsN = Math.min(3, row + 1);
      const ly = model.legend === 't' ? top : bottom - rowsN * (lfs + 6);
      for (const p of rowsY.filter((p) => p.row < rowsN)) {
        const y = ly + p.row * (lfs + 6);
        svg.append(svgEl('rect', { x: p.x, y: y + 1, width: 9, height: 9, rx: 2, fill: `#${p.it.color}` }));
        svg.append(svgEl('text', { x: p.x + 13, y: y + lfs - 1, 'font-size': lfs, fill: INK }, fitText(p.it.name, (right - left) * 0.45, lfs)));
      }
      if (model.legend === 't') top += rowsN * (lfs + 6) + 4;
      else bottom -= rowsN * (lfs + 6) + 4;
    }
  }
  if (pieLike) drawPie(svg, model, left, top, right, bottom, fs);
  else drawCartesian(svg, model, left, top, right, bottom, fs);
  return svg;
}

// 원형 차트는 조각마다 색이 다르다(파일에 조각 색이 없으면 테마 강조색 순서).
function pieColor(model, i) {
  const s = model.primary.series[0];
  return s.points.get(i) || model.pieColors[i % model.pieColors.length];
}

function drawPie(svg, model, left, top, right, bottom, fs) {
  const g = model.primary;
  const s = g.series[0];
  const vals = s.vals.map((v) => (v > 0 ? v : 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (!sum) return;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const r = Math.max(10, Math.min(right - left, bottom - top) / 2 - 4);
  const inner = g.type === 'doughnut' ? r * Math.min(0.9, Math.max(0.1, g.hole / 100)) : 0;
  let a = (g.firstAngle * Math.PI) / 180;
  vals.forEach((v, i) => {
    if (!v) return;
    const a2 = a + (v / sum) * Math.PI * 2;
    const p = (ang, rad) => [cx + rad * Math.sin(ang), cy - rad * Math.cos(ang)];
    const [x1, y1] = p(a, r);
    const [x2, y2] = p(a2, r);
    const large = a2 - a > Math.PI ? 1 : 0;
    let d;
    if (v === sum) {
      d = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
      if (inner) d += ` M ${cx - inner} ${cy} a ${inner} ${inner} 0 1 1 ${2 * inner} 0 a ${inner} ${inner} 0 1 1 ${-2 * inner} 0`;
    } else if (inner) {
      const [x3, y3] = p(a2, inner);
      const [x4, y4] = p(a, inner);
      d = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
    } else {
      d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    }
    svg.append(svgEl('path', { d, fill: `#${pieColor(model, i)}`, stroke: '#ffffff', 'stroke-width': 1.5, 'fill-rule': 'evenodd' }));
    if (g.labels || g.percentLabels || s.labels) {
      const mid = (a + a2) / 2;
      const [lx, ly] = p(mid, inner ? (r + inner) / 2 : r * 0.62);
      const text = g.percentLabels ? `${Math.round((v / sum) * 100)}%` : formatter(null)(s.vals[i]);
      svg.append(svgEl('text', { x: lx, y: ly + fs / 3, 'text-anchor': 'middle', 'font-size': fs - 1, fill: '#ffffff', 'font-weight': 700 }, text));
    }
    a = a2;
  });
}

function drawCartesian(svg, model, left, top, right, bottom, fs) {
  const primary = model.primary;
  const horizontal = primary.type === 'bar' && primary.dir === 'bar';
  const cats = (primary.series.find((s) => s.cats.length) || { cats: [] }).cats;
  const n = Math.max(cats.length, ...model.groups.flatMap((g) => g.series.map((s) => s.vals.length)));
  if (!n) return;
  const scaleFor = (groups) => {
    let min = 0;
    let max = 0;
    let percent = false;
    for (const g of groups) {
      if (g.grouping === 'stacked' || g.grouping === 'percentStacked') {
        percent = percent || g.grouping === 'percentStacked';
        for (let i = 0; i < n; i++) {
          let pos = 0;
          let neg = 0;
          let tot = 0;
          for (const s of g.series) tot += Math.abs(s.vals[i] || 0);
          for (const s of g.series) {
            const v = g.grouping === 'percentStacked' ? (tot ? (s.vals[i] || 0) / tot * 100 : 0) : (s.vals[i] || 0);
            if (v >= 0) pos += v;
            else neg += v;
          }
          max = Math.max(max, pos);
          min = Math.min(min, neg);
        }
      } else {
        for (const s of g.series) {
          for (const v of s.vals) {
            if (v == null || !Number.isFinite(v)) continue;
            max = Math.max(max, v);
            min = Math.min(min, v);
          }
        }
      }
    }
    const ax = groups[0] && groups[0].axis;
    if (ax && ax.min != null) min = Number(ax.min);
    if (ax && ax.max != null) max = Number(ax.max);
    const sc = niceScale(min, max, 5);
    if (ax && ax.min != null) sc.lo = Number(ax.min);
    if (ax && ax.max != null) sc.hi = Number(ax.max);
    sc.fmt = formatter(ax && ax.format, percent);
    sc.axis = ax;
    return sc;
  };
  const scatter = primary.type === 'scatter';
  const left1 = model.groups.filter((g) => !(g.axis && g.axis.right));
  const right1 = model.groups.filter((g) => g.axis && g.axis.right);
  const sc1 = scaleFor(left1.length ? left1 : model.groups);
  const sc2 = right1.length && left1.length ? scaleFor(right1) : null;
  const labelW = (sc) => Math.max(...sc.ticks.map((t) => sc.fmt(t).length)) * fs * 0.62 + 6;
  const catLabelH = model.catHidden ? 0 : fs + 6;
  let pl = left + (horizontal ? Math.min((right - left) * 0.35, Math.max(...cats.map((c) => textWidth(c, fs - 1)), 8) + 6) : (sc1.axis && sc1.axis.deleted ? 4 : labelW(sc1)));
  let pr = right - (sc2 ? labelW(sc2) : 6);
  const pt = top + 4;
  const pb = bottom - (horizontal ? fs + 6 : catLabelH) - (model.catTitle ? fs + 4 : 0);
  if (pr - pl < 20 || pb - pt < 20) return;
  // 값 축(눈금·격자)
  const valPos = (sc, v) => (horizontal ? pl + ((v - sc.lo) / (sc.hi - sc.lo || 1)) * (pr - pl) : pb - ((v - sc.lo) / (sc.hi - sc.lo || 1)) * (pb - pt));
  for (const t of sc1.ticks) {
    const p = valPos(sc1, t);
    if (!sc1.axis || sc1.axis.grid !== false) {
      svg.append(horizontal
        ? svgEl('line', { x1: p, y1: pt, x2: p, y2: pb, stroke: GRID, 'stroke-width': 1 })
        : svgEl('line', { x1: pl, y1: p, x2: pr, y2: p, stroke: GRID, 'stroke-width': 1 }));
    }
    if (!(sc1.axis && sc1.axis.deleted)) {
      svg.append(horizontal
        ? svgEl('text', { x: p, y: pb + fs + 2, 'text-anchor': 'middle', 'font-size': fs - 1, fill: MUTED }, sc1.fmt(t))
        : svgEl('text', { x: pl - 4, y: p + fs / 3, 'text-anchor': 'end', 'font-size': fs - 1, fill: MUTED }, sc1.fmt(t)));
    }
  }
  if (sc2) {
    for (const t of sc2.ticks) {
      const p = valPos(sc2, t);
      svg.append(svgEl('text', { x: pr + 4, y: p + fs / 3, 'text-anchor': 'start', 'font-size': fs - 1, fill: MUTED }, sc2.fmt(t)));
    }
  }
  // 분류 축
  const band = (horizontal ? pb - pt : pr - pl) / n;
  const catAt = (i) => {
    const k = model.reverseCats ? n - 1 - i : i;
    return horizontal ? pb - (k + 0.5) * band : pl + (k + 0.5) * band;
  };
  if (!model.catHidden && !scatter) {
    const widest = Math.max(...cats.map((c) => textWidth(c, fs - 1)), fs);
    const stride = horizontal ? Math.max(1, Math.ceil((fs + 2) / band)) : Math.max(1, Math.ceil((Math.min(widest, fs * 6) + 6) / band));
    for (let i = 0; i < n; i += stride) {
      const label = fitText(cats[i] ?? String(i + 1), horizontal ? pl - left - 6 : band * stride - 4, fs - 1);
      svg.append(horizontal
        ? svgEl('text', { x: pl - 4, y: catAt(i) + fs / 3, 'text-anchor': 'end', 'font-size': fs - 1, fill: MUTED }, label)
        : svgEl('text', { x: catAt(i), y: pb + fs + 2, 'text-anchor': 'middle', 'font-size': fs - 1, fill: MUTED }, label));
    }
  }
  if (model.catTitle) svg.append(svgEl('text', { x: (pl + pr) / 2, y: bottom - 2, 'text-anchor': 'middle', 'font-size': fs - 1, fill: INK }, fitText(model.catTitle, pr - pl, fs - 1)));
  // 축선
  svg.append(horizontal
    ? svgEl('line', { x1: valPos(sc1, Math.max(sc1.lo, Math.min(0, sc1.hi))), y1: pt, x2: valPos(sc1, Math.max(sc1.lo, Math.min(0, sc1.hi))), y2: pb, stroke: '#bfbfbf' })
    : svgEl('line', { x1: pl, y1: valPos(sc1, Math.max(sc1.lo, Math.min(0, sc1.hi))), x2: pr, y2: valPos(sc1, Math.max(sc1.lo, Math.min(0, sc1.hi))), stroke: '#bfbfbf' }));

  // 막대 → 면적 → 선 → 점 순서로 그린다(엑셀과 같은 겹침).
  const order = { bar: 0, area: 1, line: 2, scatter: 3 };
  const groups = [...model.groups].sort((a, b) => order[a.type] - order[b.type]);
  const bars = groups.filter((g) => g.type === 'bar');
  const clusteredCount = bars.reduce((k, g) => k + (g.grouping === 'clustered' || g.grouping === 'standard' ? g.series.length : 1), 0) || 1;
  let barSlot = 0;
  for (const g of groups) {
    const sc = g.axis && g.axis.right && sc2 ? sc2 : sc1;
    const zero = valPos(sc, Math.max(sc.lo, Math.min(0, sc.hi)));
    const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked';
    const totals = new Array(n).fill(0).map((_, i) => g.series.reduce((a, s) => a + Math.abs(s.vals[i] || 0), 0));
    const val = (s, i) => (g.grouping === 'percentStacked' ? (totals[i] ? (s.vals[i] || 0) / totals[i] * 100 : 0) : s.vals[i]);
    if (g.type === 'bar') {
      const groupW = band / (1 + g.gap / 100);
      const slots = stacked ? 1 : g.series.length;
      const barW = groupW / clusteredCount;
      const pos = new Array(n).fill(0);
      const neg = new Array(n).fill(0);
      g.series.forEach((s, k) => {
        for (let i = 0; i < n; i++) {
          const v = val(s, i);
          if (v == null || !Number.isFinite(v)) continue;
          let a;
          let b;
          if (stacked) {
            const base = v >= 0 ? pos[i] : neg[i];
            a = valPos(sc, base);
            b = valPos(sc, base + v);
            if (v >= 0) pos[i] += v;
            else neg[i] += v;
          } else {
            a = zero;
            b = valPos(sc, v);
          }
          const slot = stacked ? barSlot : barSlot + k;
          const off = -groupW / 2 + slot * barW;
          const c = catAt(i) + off;
          const fill = `#${s.points.get(i) || s.color}`;
          const rect = horizontal
            ? svgEl('rect', { x: Math.min(a, b), y: c, width: Math.max(0.5, Math.abs(b - a)), height: Math.max(1, barW - 1), fill })
            : svgEl('rect', { x: c, y: Math.min(a, b), width: Math.max(1, barW - 1), height: Math.max(0.5, Math.abs(b - a)), fill });
          svg.append(rect);
          if (s.labels) {
            svg.append(horizontal
              ? svgEl('text', { x: Math.max(a, b) + 3, y: c + barW / 2 + fs / 3, 'font-size': fs - 2, fill: INK }, sc.fmt(v))
              : svgEl('text', { x: c + barW / 2, y: Math.min(a, b) - 3, 'text-anchor': 'middle', 'font-size': fs - 2, fill: INK }, sc.fmt(v)));
          }
        }
      });
      barSlot += slots;
    } else if (g.type === 'area') {
      const base = new Array(n).fill(0);
      for (const s of g.series) {
        const top1 = [];
        const bot = [];
        for (let i = 0; i < n; i++) {
          const v = val(s, i) || 0;
          const b0 = stacked ? base[i] : 0;
          top1.push(`${catAt(i)},${valPos(sc, b0 + v)}`);
          bot.unshift(`${catAt(i)},${valPos(sc, b0)}`);
          if (stacked) base[i] += v;
        }
        svg.append(svgEl('polygon', { points: [...top1, ...bot].join(' '), fill: `#${s.color}`, 'fill-opacity': stacked ? 1 : 0.75 }));
      }
    } else if (g.type === 'line' || g.type === 'scatter') {
      const base = new Array(n).fill(0);
      for (const s of g.series) {
        const pts = [];
        const xsNum = g.type === 'scatter' ? s.cats.map(Number) : null;
        let xlo = 0;
        let xhi = 1;
        if (xsNum && xsNum.some(Number.isFinite)) {
          const f = xsNum.filter(Number.isFinite);
          const xs = niceScale(Math.min(...f), Math.max(...f), 5);
          xlo = xs.lo;
          xhi = xs.hi;
        }
        for (let i = 0; i < n; i++) {
          let v = val(s, i);
          if (v == null || !Number.isFinite(v)) { pts.push(null); continue; }
          if (stacked) { base[i] += v; v = base[i]; }
          const x = xsNum && Number.isFinite(xsNum[i]) ? pl + ((xsNum[i] - xlo) / (xhi - xlo || 1)) * (pr - pl) : catAt(i);
          pts.push([x, valPos(sc, v)]);
        }
        const width = Math.min(4, Math.max(1.5, s.lineWidth || 2));
        if ((g.type === 'line' || g.scatterLines) && !s.noLine) {
          let d = '';
          let pen = false;
          for (const p of pts) {
            if (!p) { pen = false; continue; }
            d += `${pen ? 'L' : 'M'} ${p[0]} ${p[1]} `;
            pen = true;
          }
          if (d) svg.append(svgEl('path', { d, fill: 'none', stroke: `#${s.color}`, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        }
        if (s.marker || g.type === 'scatter') {
          for (const p of pts) if (p) svg.append(svgEl('circle', { cx: p[0], cy: p[1], r: 3.5, fill: `#${s.color}`, stroke: '#ffffff', 'stroke-width': 1.5 }));
        }
        if (s.labels) {
          pts.forEach((p, i) => {
            if (p) svg.append(svgEl('text', { x: p[0], y: p[1] - 6, 'text-anchor': 'middle', 'font-size': fs - 2, fill: INK }, sc.fmt(val(s, i))));
          });
        }
      }
    }
  }
}

// 차트를 누르면 보여 줄 값 표(계열 × 분류)
export function chartTable(model) {
  const pieLike = model.primary.type === 'pie' || model.primary.type === 'doughnut';
  const series = model.groups.flatMap((g) => g.series);
  const n = Math.max(...series.map((s) => Math.max(s.vals.length, s.cats.length)));
  const cats = (series.find((s) => s.cats.length) || { cats: [] }).cats;
  const head = ['', ...series.map((s) => s.name || T('계열 {n}', { n: s.idx + 1 }))];
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([cats[i] ?? String(i + 1), ...series.map((s) => (s.vals[i] == null ? '' : formatter(null)(s.vals[i])))]);
  return { head: pieLike ? ['', head[1]] : head, rows: pieLike ? rows.map((r) => r.slice(0, 2)) : rows };
}
