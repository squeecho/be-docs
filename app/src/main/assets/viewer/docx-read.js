// 긴 docx를 워드 엔진 없이 바로 읽기 보기로 보여 주기 위한 가벼운 해석기(작업 스레드에서 돈다).
// 엔진(wasm)은 문서 구조를 만드는 데 XML 1MB당 약 2.6초(PC)가 걸려 183쪽 문서에 33초였다. 여기서는 문서 XML을
// 한 번 훑어 간단 보기 블록(simple-view.js)으로 바로 바꾼다. 쪽 모양은 사용자가 원할 때만 엔진으로 그린다.
// 읽는 것: 본문 문단, 글자 서식(굵게·기울임·밑줄·취소선·크기·색, 스타일 상속 포함), 정렬, 제목, 번호 매기기,
//   표(가로·세로로 합친 칸, 표 속 표), 그림(PNG·JPEG·GIF·BMP·WebP), 글상자 글, 각주·미주, 머리말·꼬리말,
//   확인란, 필드 결과(필드 코드는 숨김), 수정 표시(받아들인 모습), 숨긴 글(빼고 보여 줌), 쪽 나눔(문단 중간이면 문단을 나눔)
// 고칠 때: node tools/web-test/docx-read-test.mjs(단위 시험, CI), tools/audit/docx-read/(엔진과 글 대조)
// 빠지는 것: 도형·차트·다른 형식 그림(개수만 셈), 쪽 배치, 탭 위치, 들여쓰기
import { colorOf, makeNumbering } from './docx-numbering.js';

const MAX_PART = 64 * 1024 * 1024; // 한 항목을 풀 때 상한(압축 폭탄·휴대폰 메모리 보호, 183쪽 문서의 본문이 12MB). 넘으면 엔진으로 연다
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

// ---------------------------------------------------------------- ZIP

function zipEntries(bytes) {
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const u32 = (p) => (u16(p) | (u16(p + 2) << 16)) >>> 0;
  const dec = new TextDecoder();
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) !== 0x06054b50) continue;
    const out = new Map();
    let q = u32(p + 16);
    for (let i = 0; i < 65535 && q + 46 <= bytes.length && u32(q) === 0x02014b50; i++) {
      const len = u16(q + 28);
      const name = dec.decode(bytes.subarray(q + 46, q + 46 + len)).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
      out.set(name, { method: u16(q + 10), csize: u32(q + 20), size: u32(q + 24), offset: u32(q + 42) });
      q += 46 + len + u16(q + 30) + u16(q + 32);
    }
    return { out, u16, u32 };
  }
  throw new Error('ZIP 중앙 목록이 없음');
}

function makePartReader(bytes, inflate) {
  const { out: entries, u16, u32 } = zipEntries(bytes);
  return (name) => {
    const e = entries.get(String(name).toLowerCase());
    if (!e) return null;
    if (u32(e.offset) !== 0x04034b50) throw new Error(`항목 머리글이 깨짐: ${name}`);
    if (e.size > MAX_PART || e.size === 0xffffffff) throw new Error(`항목이 너무 큼: ${name}`);
    const start = e.offset + 30 + u16(e.offset + 26) + u16(e.offset + 28);
    const raw = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`지원하지 않는 압축: ${name}`);
    return inflate(raw, { out: new Uint8Array(e.size) });
  };
}

function textOf(u8) {
  if (!u8) return '';
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  return new TextDecoder().decode(u8);
}

// ---------------------------------------------------------------- XML 훑기

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const attrRes = new Map();
function attr(attrs, name) {
  let re = attrRes.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrRes.set(name, re);
  }
  const m = re.exec(attrs);
  return m ? unescapeXml(m[1] ?? m[2]) : null;
}

// 태그·글자 단위로 차례로 넘긴다(DOM을 만들지 않아 수십 MB 문서도 빠르다).
const TOKEN = /<(\/?)([^\s/>!?]+)([^>]*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[!?][^>]*>|([^<]+)/g;

function sax(xml, h) {
  const re = new RegExp(TOKEN.source, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[2]) {
      if (m[1]) h.close(m[2]);
      else {
        h.open(m[2], m[3], !!m[4]);
        if (m[4]) h.close(m[2], true);
      }
    } else if (m[6] !== undefined) {
      h.text(m[6], false);
    } else if (m[5] !== undefined) {
      h.text(m[5], true);
    }
  }
}

// 들어가지 않는 영역: 지운 글, 필드 코드, 고치기 전 서식, 콘텐츠 컨트롤 속성, 같은 내용의 대체 표현(mc:Fallback)
const SKIP = new Set([
  'w:del', 'w:moveFrom', 'mc:Fallback', 'w:instrText', 'w:delText', 'w:delInstrText', 'w:rPrChange', 'w:pPrChange',
  'w:sectPrChange', 'w:tblPrChange', 'w:tblGridChange', 'w:trPrChange', 'w:tcPrChange', 'w:numberingChange',
  'w:sdtPr', 'w:sdtEndPr', 'w:footnotePr', 'w:endnotePr', 'w:customXmlPr', 'w:fldData',
]);

function onOff(attrs) {
  const v = attr(attrs, 'w:val');
  return v == null || !/^(0|false|off|none)$/i.test(v);
}

// ---------------------------------------------------------------- 서식

function applyRun(r, name, attrs) {
  switch (name) {
    case 'w:b': r.b = onOff(attrs); break;
    case 'w:i': r.i = onOff(attrs); break;
    case 'w:u': { const v = attr(attrs, 'w:val'); r.u = v == null || v !== 'none'; break; }
    case 'w:strike': case 'w:dstrike': r.s = onOff(attrs); break;
    case 'w:sz': { const v = Number(attr(attrs, 'w:val')); if (v > 0) r.size = v / 2; break; }
    case 'w:color': { const v = attr(attrs, 'w:val'); r.color = v && v !== 'auto' ? colorOf(v) || null : null; break; }
    case 'w:vanish': r.hidden = onOff(attrs); break;
    case 'w:rStyle': r.style = attr(attrs, 'w:val'); break;
    default:
  }
}

function applyPara(p, name, attrs) {
  switch (name) {
    case 'w:pStyle': p.style = attr(attrs, 'w:val'); break;
    case 'w:jc': p.align = attr(attrs, 'w:val'); break;
    case 'w:pageBreakBefore': p.pageBreakBefore = onOff(attrs); break;
    case 'w:outlineLvl': { const v = Number(attr(attrs, 'w:val')); if (v >= 0) p.outline = v; break; }
    case 'w:ilvl': { const v = Number(attr(attrs, 'w:val')); if (v >= 0) p.ilvl = v; break; }
    case 'w:numId': { const v = Number(attr(attrs, 'w:val')); if (v >= 0) p.numId = v; break; }
    default:
  }
}

function onOffAttr(attrs, name) {
  const v = attr(attrs, name);
  return v != null && !/^(0|false|off)$/i.test(v);
}

function readStyles(xml) {
  const styles = new Map();
  const defaults = { r: {}, p: {} };
  let defaultPara = null;
  if (!xml) return { styles, defaults, defaultPara };
  const stack = [];
  let cur = null;
  sax(xml, {
    open(name, attrs, self) {
      const parent = stack[stack.length - 1];
      const gp = stack[stack.length - 2];
      const ggp = stack[stack.length - 3];
      if (!self) stack.push(name);
      if (name === 'w:style') {
        cur = { type: attr(attrs, 'w:type'), id: attr(attrs, 'w:styleId'), p: {}, r: {} };
        if (cur.id) styles.set(cur.id, cur);
        if (cur.type === 'paragraph' && cur.id && onOffAttr(attrs, 'w:default')) defaultPara = cur.id;
      } else if (name === 'w:name' && parent === 'w:style' && cur) cur.name = attr(attrs, 'w:val') || '';
      else if (name === 'w:basedOn' && parent === 'w:style' && cur) cur.basedOn = attr(attrs, 'w:val');
      else if (parent === 'w:rPr') {
        // 스타일의 글자 서식(w:style > w:rPr)과 문서 기본 글자 서식(w:rPrDefault > w:rPr)
        const target = gp === 'w:style' && cur ? cur.r : (gp === 'w:rPrDefault' ? defaults.r : null);
        if (target) applyRun(target, name, attrs);
      } else if (parent === 'w:pPr' || (parent === 'w:numPr' && gp === 'w:pPr')) {
        // 스타일의 문단 서식(w:style > w:pPr, 번호는 w:style > w:pPr > w:numPr)과 문서 기본 문단 서식
        const owner = parent === 'w:pPr' ? gp : ggp;
        if (owner === 'w:style' && cur) applyPara(cur.p, name, attrs);
        else if (owner === 'w:pPrDefault') applyPara(defaults.p, name, attrs);
      }
    },
    close(name, self) {
      if (!self) stack.pop();
      if (name === 'w:style') cur = null;
    },
    text() {},
  });
  return { styles, defaults, defaultPara };
}

// 스타일 상속(basedOn)을 펴서 문단 서식·글자 서식을 한 번만 계산해 둔다.
function styleResolver({ styles, defaults, defaultPara }) {
  const chain = (id) => {
    const out = [];
    for (let s = styles.get(id), guard = 0; s && guard < 30; s = styles.get(s.basedOn), guard++) out.unshift(s);
    return out;
  };
  const paraCache = new Map();
  const charCache = new Map();
  const para = (id) => {
    const key = id || '';
    if (paraCache.has(key)) return paraCache.get(key);
    const p = { ...defaults.p };
    const r = { ...defaults.r };
    let heading = 0;
    // 문단 스타일이 없으면 문서의 기본 문단 스타일(w:default="1", 한글 워드에서는 이름이 Normal이고 ID가 "a"인 경우가 많다)
    let list = chain(id);
    if (!list.length && defaultPara) list = chain(defaultPara);
    for (const s of list) {
      Object.assign(p, s.p);
      Object.assign(r, s.r);
      const m = /^(?:heading|제목)\s*([1-9])$/i.exec(s.name || '');
      if (m) heading = Number(m[1]);
    }
    if (p.outline != null && p.outline < 9) heading = p.outline + 1;
    const out = { p, r, heading };
    paraCache.set(key, out);
    return out;
  };
  const char = (id) => {
    if (!id) return null;
    if (charCache.has(id)) return charCache.get(id);
    const r = {};
    for (const s of chain(id)) Object.assign(r, s.r);
    charCache.set(id, r);
    return r;
  };
  return { para, char };
}

function readNumbering(xml) {
  const abstracts = [];
  const instances = [];
  if (!xml) return { abstracts, instances };
  const stack = [];
  let abs = null;
  let inst = null;
  let lvl = null;
  let overIlvl = null;
  sax(xml, {
    open(name, attrs, self) {
      const parent = stack[stack.length - 1];
      if (!self) stack.push(name);
      switch (name) {
        case 'w:abstractNum':
          abs = { abstractNumId: Number(attr(attrs, 'w:abstractNumId')), levels: [] };
          abstracts.push(abs);
          break;
        case 'w:num':
          inst = { numId: Number(attr(attrs, 'w:numId')), abstractNumId: null, levelStartOverrides: {}, levelOverrides: [] };
          instances.push(inst);
          break;
        case 'w:abstractNumId': if (parent === 'w:num' && inst) inst.abstractNumId = Number(attr(attrs, 'w:val')); break;
        case 'w:lvlOverride': overIlvl = Number(attr(attrs, 'w:ilvl')); break;
        case 'w:startOverride':
          if (parent === 'w:lvlOverride' && inst && overIlvl != null) inst.levelStartOverrides[String(overIlvl)] = Number(attr(attrs, 'w:val'));
          break;
        case 'w:lvl': {
          lvl = { ilvl: Number(attr(attrs, 'w:ilvl')) || 0 };
          if (parent === 'w:abstractNum' && abs) abs.levels.push(lvl);
          else if (parent === 'w:lvlOverride' && inst) inst.levelOverrides.push(lvl);
          break;
        }
        case 'w:start': if (parent === 'w:lvl' && lvl) lvl.start = Number(attr(attrs, 'w:val')); break;
        case 'w:numFmt': if (parent === 'w:lvl' && lvl) lvl.format = attr(attrs, 'w:val'); break;
        case 'w:lvlText': if (parent === 'w:lvl' && lvl) lvl.text = attr(attrs, 'w:val') ?? ''; break;
        case 'w:isLgl': if (parent === 'w:lvl' && lvl) lvl.isLgl = onOff(attrs); break;
        default:
      }
    },
    close(name, self) {
      if (!self) stack.pop();
      if (name === 'w:lvl') lvl = null;
      else if (name === 'w:abstractNum') abs = null;
      else if (name === 'w:num') inst = null;
      else if (name === 'w:lvlOverride') overIlvl = null;
    },
    text() {},
  });
  return { abstracts, instances };
}

// 머리말·꼬리말·각주처럼 글자만 필요한 부분: 문단 사이를 띄우고 필드 코드·지운 글은 뺀다.
function plainParagraphs(xml, onItem) {
  const stack = [];
  let skip = 0;
  let fields = [];
  let text = '';
  let item = null;
  sax(xml, {
    open(name, attrs, self) {
      if (skip) { if (!self) skip++; return; }
      if (SKIP.has(name)) { if (!self) skip = 1; return; }
      if (!self) stack.push(name);
      if (onItem && (name === 'w:footnote' || name === 'w:endnote')) {
        item = { id: attr(attrs, 'w:id'), type: attr(attrs, 'w:type') };
        text = '';
        fields = [];
      } else if (name === 'w:tab' && stack[stack.length - 2] === 'w:r') text += ' ';
      else if (name === 'w:fldChar') {
        const t = attr(attrs, 'w:fldCharType');
        if (t === 'begin') fields.push('code');
        else if (t === 'separate' && fields.length) fields[fields.length - 1] = 'result';
        else if (t === 'end') fields.pop();
      }
    },
    close(name, self) {
      if (skip) { if (!self) skip--; return; }
      if (!self) stack.pop();
      if (name === 'w:p') text += ' ';
      else if (onItem && (name === 'w:footnote' || name === 'w:endnote') && item) {
        onItem(item, text.replace(/\s+/g, ' ').trim());
        item = null;
      }
    },
    text(t, cdata) {
      if (skip || stack[stack.length - 1] !== 'w:t') return;
      if (fields.length && fields[fields.length - 1] === 'code') return;
      text += cdata ? t : unescapeXml(t);
    },
  });
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- 그 밖의 도움

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  for (const seg of (base + target).split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

function readRels(xml, base) {
  const map = new Map();
  if (!xml) return map;
  for (const m of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    const type = attr(m[1], 'Type') || '';
    if (!id || !target || attr(m[1], 'TargetMode') === 'External') continue;
    map.set(id, { path: resolvePath(base, target), type });
  }
  return map;
}

// 기호 글꼴(Wingdings·Symbol)의 자주 쓰는 글자는 비슷한 유니코드 글자로, 나머지 사용자 영역 글자는 글머리표로
const SYMBOLS = { 0xfc: '✓', 0xfb: '✗', 0xfd: '☒', 0xfe: '☑', 0xa8: '☐', 0x6f: '☐', 0x71: '❑', 0xa7: '▪', 0x9f: '•', 0xb7: '•', 0xd8: '➢', 0xe0: '→', 0xe8: '➔', 0x76: '❖', 0x6e: '■', 0x6c: '●' };
function symbolChar(attrs) {
  const code = parseInt(attr(attrs, 'w:char') || '', 16);
  if (!(code > 0)) return '';
  if (code >= 0xf000 && code <= 0xf0ff) return SYMBOLS[code - 0xf000] || '•';
  if (code >= 0xe000 && code <= 0xf8ff) return '•';
  return String.fromCodePoint(code);
}

function vmlWidth(attrs) {
  const style = attr(attrs, 'style') || '';
  const m = /(?:^|;)\s*width\s*:\s*([\d.]+)\s*(pt|px|in|cm|mm)?/i.exec(style);
  if (!m) return 0;
  const v = Number(m[1]);
  const unit = (m[2] || 'px').toLowerCase();
  const px = { pt: 4 / 3, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[unit] * v;
  return Math.round(px) || 0;
}

const ALIGNS = { left: 'left', start: 'left', right: 'right', end: 'right', center: 'center', both: 'justify', distribute: 'justify', justify: 'justify' };

// ---------------------------------------------------------------- 본문

function readBody(xml, ctx) {
  const blocks = [];
  const targets = [blocks];
  const tables = [];
  const paras = [];
  const drawings = [];
  const fields = [];
  const stack = [];
  const counts = { paragraphs: 0, chars: 0, tableRows: 0, depth: 0 };
  const sections = { header: null, footer: null };
  let skip = 0;
  let txbx = 0;
  let checkbox = null;

  const runProps = (para) => {
    const run = para.run;
    if (run && run.props) return run.props;
    const ps = ctx.styles.para(para.p.style);
    const direct = run ? run.r : {};
    const cs = ctx.styles.char(direct.style);
    const all = { ...ps.r, ...(cs || {}), ...direct };
    const props = {
      b: !!all.b, i: !!all.i, u: !!all.u, s: !!all.s, size: all.size || 0, color: all.color || null, hidden: !!all.hidden,
    };
    props.key = `${+props.b}${+props.i}${+props.u}${+props.s}|${props.size}|${props.color}`;
    if (run) run.props = props;
    return props;
  };

  const addText = (text, countIt) => {
    const para = paras[paras.length - 1];
    if (!para || !text) return;
    const props = runProps(para);
    if (props.hidden) return;
    if (countIt && !txbx) counts.chars += text.length;
    para.any = true;
    const last = para.runs[para.runs.length - 1];
    if (last && last.key === props.key && last.text != null) last.text += text;
    else {
      para.runs.push({
        text, b: props.b, i: props.i, u: props.u, s: props.s, size: props.size || undefined, color: props.color || undefined, key: props.key,
      });
    }
  };

  const finishPara = () => {
    const para = paras.pop();
    if (!para) return;
    if (!txbx) counts.paragraphs++;
    const ps = ctx.styles.para(para.p.style);
    // 제목은 스타일(제목 1~9, 스타일의 개요 수준)로만 정한다. 문단에 직접 준 개요 수준은 탐색용이라 Word에서도 모양이 바뀌지 않는다.
    const heading = ps.heading;
    const numId = para.p.numId != null ? para.p.numId : ps.p.numId;
    const ilvl = para.p.ilvl != null ? para.p.ilvl : (ps.p.ilvl || 0);
    // 문단 중간의 쪽 나눔에서 문단을 나눈다(앞뒤 글이 붙지 않게). 끝에 있던 쪽 나눔은 빈 조각이라 나눔 표시만 남는다.
    const parts = [...para.parts, para.runs];
    for (const part of parts) for (const r of part) delete r.key;
    const label = numId ? ctx.numberLabel({ numId, ilvl }) : '';
    if (label) parts[0].unshift({ text: label });
    const out = targets[targets.length - 1];
    const pageBreak = para.p.pageBreakBefore != null ? para.p.pageBreakBefore : ps.p.pageBreakBefore;
    if (pageBreak || para.breakBefore) out.push({ t: 'break' });
    const align = ALIGNS[para.p.align || ps.p.align] || undefined;
    parts.forEach((runs, k) => {
      if (k) out.push({ t: 'break' });
      if (!k || runs.length) out.push({ t: 'p', align, heading: heading || 0, runs });
    });
    for (const b of para.deferred) out.push(b);
  };

  const finishDrawing = () => {
    const d = drawings.pop();
    if (!d) return;
    const para = paras[paras.length - 1];
    if (d.embed) {
      const index = ctx.image(d.embed);
      if (index >= 0 && para) {
        para.runs.push({ img: index, w: d.w || 0 });
        para.any = true;
      } else if (index < 0) ctx.omitted++;
    } else if (d.chart) ctx.omitted++;
  };

  const finishCell = () => {
    const t = tables[tables.length - 1];
    if (!t || !t.cell) return;
    const cell = t.cell;
    t.cell = null;
    targets.pop();
    const row = t.row;
    if (!row) return;
    const col = row.col;
    if (cell.vmerge === 'continue' && t.origin[col]) {
      t.origin[col].rowspan++;
    } else {
      const c = { blocks: cell.blocks, colspan: cell.span, rowspan: 1 };
      row.cells.push(c);
      for (let k = 0; k < cell.span; k++) t.origin[col + k] = c;
    }
    row.col += cell.span;
  };

  const handlers = {
    open(name, attrs, self) {
      if (skip) { if (!self) skip++; return; }
      if (SKIP.has(name)) { if (!self) skip = 1; return; }
      const parent = stack[stack.length - 1];
      const gp = stack[stack.length - 2];
      if (!self) stack.push(name);
      const para = paras[paras.length - 1];
      const table = tables[tables.length - 1];
      switch (name) {
        case 'w:p': paras.push({ p: {}, runs: [], parts: [], deferred: [], run: null, any: false }); break;
        case 'w:r': if (para) para.run = { r: {} }; break;
        case 'w:tab': if (parent === 'w:r') addText('\t', false); break;
        case 'w:br':
          if (parent === 'w:r' && para) {
            if (attr(attrs, 'w:type') !== 'page') addText('\n', false);
            else if (runProps(para).hidden) break;
            else if (para.any || para.parts.length) {
              para.parts.push(para.runs);
              para.runs = [];
            } else para.breakBefore = true;
          }
          break;
        case 'w:cr': if (parent === 'w:r') addText('\n', false); break;
        case 'w:noBreakHyphen': if (parent === 'w:r') addText('-', false); break;
        case 'w:sym': if (parent === 'w:r') addText(symbolChar(attrs), false); break;
        case 'w:footnoteReference':
        case 'w:endnoteReference':
          // 숨긴 글자 속 참조는 번호도 매기지 않는다(본문에 표시가 없는데 각주 번호만 밀리지 않게).
          if (para && !runProps(para).hidden) addText(ctx.noteMarker(name === 'w:endnoteReference' ? 'end' : 'foot', attr(attrs, 'w:id')), false);
          break;
        case 'w:fldChar': {
          const t = attr(attrs, 'w:fldCharType');
          if (t === 'begin') fields.push('code');
          else if (t === 'separate' && fields.length) fields[fields.length - 1] = 'result';
          else if (t === 'end') fields.pop();
          break;
        }
        case 'w:checkBox': checkbox = { checked: null, def: false }; break;
        case 'w:checked': if (checkbox) checkbox.checked = onOff(attrs); break;
        case 'w:default': if (checkbox && parent === 'w:checkBox') checkbox.def = onOff(attrs); break;
        case 'w:drawing': case 'w:pict': case 'w:object': drawings.push({ embed: null, w: 0, chart: false }); break;
        case 'wp:extent': { const d = drawings[drawings.length - 1]; if (d && !d.w) d.w = Math.round(Number(attr(attrs, 'cx')) / 9525) || 0; break; }
        case 'a:blip': { const d = drawings[drawings.length - 1]; if (d && !d.embed) d.embed = attr(attrs, 'r:embed'); break; }
        case 'v:imagedata': { const d = drawings[drawings.length - 1]; if (d && !d.embed) d.embed = attr(attrs, 'r:id'); break; }
        case 'v:shape': { const d = drawings[drawings.length - 1]; if (d && !d.w) d.w = vmlWidth(attrs); break; }
        case 'c:chart': { const d = drawings[drawings.length - 1]; if (d) d.chart = true; break; }
        case 'w:txbxContent': txbx++; targets.push([]); break;
        case 'w:tbl':
          tables.push({ rows: [], origin: [], row: null, cell: null });
          if (tables.length > counts.depth) counts.depth = tables.length;
          break;
        case 'w:tr': if (table) table.row = { cells: [], col: 0 }; if (!txbx) counts.tableRows++; break;
        case 'w:gridBefore': if (parent === 'w:trPr' && table && table.row) table.row.col = Number(attr(attrs, 'w:val')) || 0; break;
        case 'w:tc':
          if (table) {
            table.cell = { blocks: [], span: 1, vmerge: null };
            targets.push(table.cell.blocks);
          }
          break;
        case 'w:gridSpan': if (parent === 'w:tcPr' && table && table.cell) table.cell.span = Math.max(1, Math.min(1000, Number(attr(attrs, 'w:val')) || 1)); break;
        case 'w:vMerge': if (parent === 'w:tcPr' && table && table.cell) table.cell.vmerge = attr(attrs, 'w:val') === 'restart' ? 'restart' : 'continue'; break;
        case 'w:headerReference':
        case 'w:footerReference':
          if (parent === 'w:sectPr') {
            const kind = name === 'w:headerReference' ? 'header' : 'footer';
            const type = attr(attrs, 'w:type') || 'default';
            if (type === 'default' && !sections[kind]) sections[kind] = attr(attrs, 'r:id');
          }
          break;
        default:
          if (parent === 'w:rPr') {
            if (gp === 'w:r' && para && para.run) applyRun(para.run.r, name, attrs);
          } else if (para && (parent === 'w:pPr' || (parent === 'w:numPr' && gp === 'w:pPr'))) {
            applyPara(para.p, name, attrs);
          }
      }
    },
    close(name, self) {
      if (skip) { if (!self) skip--; return; }
      if (!self) stack.pop();
      switch (name) {
        case 'w:r': { const para = paras[paras.length - 1]; if (para) para.run = null; break; }
        case 'w:p':
          finishPara();
          // 필드 코드는 한 문단 안에서 끝난다. 끝 표시가 없는 깨진 필드가 뒤 문단을 모두 숨기지 않게 결과로 본다.
          if (fields.length && fields[fields.length - 1] === 'code') fields[fields.length - 1] = 'result';
          break;
        case 'w:checkBox':
          if (checkbox) {
            addText((checkbox.checked ?? checkbox.def) ? '☒' : '☐', false);
            checkbox = null;
          }
          break;
        case 'w:drawing': case 'w:pict': case 'w:object': finishDrawing(); break;
        case 'w:txbxContent': {
          const inner = targets.pop();
          txbx--;
          const para = paras[paras.length - 1];
          if (para) para.deferred.push(...inner);
          else targets[targets.length - 1].push(...inner);
          break;
        }
        case 'w:tc': finishCell(); break;
        case 'w:tr': { const t = tables[tables.length - 1]; if (t && t.row) { t.rows.push({ cells: t.row.cells }); t.row = null; } break; }
        case 'w:tbl': {
          const t = tables.pop();
          if (t) targets[targets.length - 1].push({ t: 'table', rows: t.rows });
          break;
        }
        default:
      }
    },
    text(t, cdata) {
      if (skip || stack[stack.length - 1] !== 'w:t') return;
      if (fields.length && fields[fields.length - 1] === 'code') return;
      addText(cdata ? t : unescapeXml(t), true);
    },
  };
  sax(xml, handlers);
  // 닫히지 않은 문단·표(잘린 문서)도 버리지 않는다: 열린 태그를 안쪽부터 닫는다.
  skip = 0;
  while (stack.length) handlers.close(stack[stack.length - 1]);
  while (paras.length) finishPara();
  return { blocks, counts, sections };
}

// ---------------------------------------------------------------- 입구

export function readDocx(bytes, inflate) {
  const part = makePartReader(bytes, inflate);
  const rootRels = readRels(textOf(part('_rels/.rels')), '');
  let main = 'word/document.xml';
  for (const r of rootRels.values()) if (/\/officeDocument$/.test(r.type)) main = r.path;
  const base = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const docXml = textOf(part(main));
  if (!docXml) throw new Error('본문(document.xml)이 없음');
  const relsPath = `${base}_rels/${main.slice(base.length)}.rels`;
  const rels = readRels(textOf(part(relsPath)), base);
  const relOfType = (suffix) => [...rels.values()].find((r) => r.type.endsWith(suffix));

  const stylesRel = relOfType('/styles');
  const numberingRel = relOfType('/numbering');
  const styles = styleResolver(readStyles(stylesRel ? textOf(part(stylesRel.path)) : ''));
  const numberLabel = makeNumbering({ numberingDefinitions: readNumbering(numberingRel ? textOf(part(numberingRel.path)) : '') });

  // 각주·미주는 본문에 나온 차례로 [1], [2]…를 붙이고 글은 끝에 모은다.
  let noteTexts = null;
  const noteText = (kind, id) => {
    if (!noteTexts) {
      noteTexts = { foot: new Map(), end: new Map() };
      for (const [kind2, suffix] of [['foot', '/footnotes'], ['end', '/endnotes']]) {
        const rel = relOfType(suffix);
        const xml = rel ? textOf(part(rel.path)) : '';
        if (!xml) continue;
        plainParagraphs(xml, (item, text) => {
          if (item.type && item.type !== 'normal') return;
          noteTexts[kind2].set(item.id, text);
        });
      }
    }
    return noteTexts[kind].get(id) || '';
  };
  const notes = [];
  const noteIndex = new Map();
  const images = [];
  const imageIndex = new Map();
  const ctx = {
    styles,
    numberLabel,
    omitted: 0,
    noteMarker(kind, id) {
      const key = `${kind}:${id}`;
      if (!noteIndex.has(key)) {
        noteIndex.set(key, notes.length + 1);
        notes.push(noteText(kind, id));
      }
      return `[${noteIndex.get(key)}]`;
    },
    image(rId) {
      const rel = rels.get(rId);
      if (!rel) return -1;
      if (imageIndex.has(rel.path)) return imageIndex.get(rel.path);
      const ext = (/\.([a-z0-9]+)$/i.exec(rel.path) || [])[1];
      const type = IMAGE_TYPES[(ext || '').toLowerCase()];
      let data = null;
      try {
        data = type ? part(rel.path) : null;
      } catch (_) {
        data = null;
      }
      const index = data ? images.push({ type, data: data.slice() }) - 1 : -1;
      imageIndex.set(rel.path, index);
      return index;
    },
  };

  const body = readBody(docXml, ctx);
  const hf = (id) => {
    const rel = id && rels.get(id);
    try {
      return rel ? plainParagraphs(textOf(part(rel.path))) : '';
    } catch (_) {
      return '';
    }
  };
  let storedPages = 0;
  try {
    const app = textOf(part('docProps/app.xml'));
    storedPages = Number((/<Pages>(\d+)<\/Pages>/.exec(app) || [])[1]) || 0;
  } catch (_) {
    storedPages = 0;
  }
  return {
    counts: { storedPages, ...body.counts },
    blocks: body.blocks,
    extras: { header: hf(body.sections.header), footer: hf(body.sections.footer), footnotes: notes },
    images,
    omittedImages: ctx.omitted,
  };
}
