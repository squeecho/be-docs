// 간단 보기: 주 엔진이 읽지 못하는 형식(RTF, ODT, ODP, Word 2003 XML, Word 2·6·95)을
// 글자·표·그림만 살려 보여준다. 모든 형식을 같은 모양(블록 목록)으로 바꾼 뒤 DOM API로만 그린다.
// 문서 안의 글자가 HTML로 해석될 일이 없다.
//
// 블록: { t: 'p', align, heading, runs: [{ text, b, i, u, s, size, color } | { img, w, h }] }
//       { t: 'table', rows: [{ cells: [{ blocks, colspan, rowspan }] }] }
//       { t: 'break' }  (쪽 나눔)
//       { t: 'slide', n, blocks }

import { T } from './i18n.js';

// ---------------------------------------------------------------- 그리기

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const ALIGN = { left: 'left', start: 'left', right: 'right', end: 'right', center: 'center', justify: 'justify', both: 'justify' };

function renderRuns(p, runs, sizeBase) {
  for (const r of runs) {
    if (r.img) {
      const img = el('img', 'simple-img');
      img.src = r.img;
      img.alt = '';
      if (r.w > 0) img.style.width = `${Math.min(r.w, 2000)}px`;
      p.append(img);
      continue;
    }
    if (!r.text) continue;
    if (!r.b && !r.i && !r.u && !r.s && !r.size && !r.color) {
      p.append(r.text);
      continue;
    }
    const span = el('span', null, r.text);
    if (r.b) span.style.fontWeight = '700';
    if (r.i) span.style.fontStyle = 'italic';
    if (r.u || r.s) span.style.textDecoration = [r.u && 'underline', r.s && 'line-through'].filter(Boolean).join(' ');
    // 글자 크기는 원본 비율을 지키되 휴대폰에서 읽을 수 있는 범위로 둔다.
    if (r.size) span.style.fontSize = `${Math.max(0.7, Math.min(2.4, r.size / sizeBase)).toFixed(2)}em`;
    if (r.color && /^#[0-9a-f]{6}$/i.test(r.color) && r.color.toLowerCase() !== '#000000') span.style.color = r.color;
    p.append(span);
  }
}

// sizeBase: 원본의 이 글자 크기(pt)를 화면 기본 글자 크기로 본다. 문서는 11pt, 슬라이드는 24pt.
export function renderBlocks(blocks, parent, sizeBase = 11) {
  for (const b of blocks) {
    if (b.t === 'p') {
      const p = el(b.heading ? `h${Math.min(6, b.heading + 1)}` : 'p', 'simple-p');
      if (b.align && ALIGN[b.align]) p.style.textAlign = ALIGN[b.align];
      renderRuns(p, b.runs, sizeBase);
      if (!p.childNodes.length) p.append(' ');
      parent.append(p);
    } else if (b.t === 'table') {
      // cont: 줄이 아주 많은 표를 나눠 그린 뒷조각. 앞 조각에 붙여 한 표처럼 보이게 한다.
      const wrap = el('div', b.cont ? 'simple-table-wrap simple-table-cont' : 'simple-table-wrap');
      const table = el('table', 'simple-table');
      for (const row of b.rows) {
        const tr = el('tr');
        for (const cell of row.cells) {
          const td = el('td');
          if (cell.colspan > 1) td.colSpan = cell.colspan;
          if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
          renderBlocks(cell.blocks, td, sizeBase);
          tr.append(td);
        }
        table.append(tr);
      }
      wrap.append(table);
      parent.append(wrap);
    } else if (b.t === 'break') {
      parent.append(el('hr', 'simple-break'));
    } else if (b.t === 'slide') {
      const card = el('section', 'simple-slide');
      card.append(el('p', 'simple-slide-no', T('슬라이드 {n}', { n: b.n })));
      renderBlocks(b.blocks, card, 24);
      parent.append(card);
    }
  }
}

// 블록에서 글자만 모은다(빈 문서인지 판단용).
export function blocksText(blocks) {
  let out = '';
  for (const b of blocks) {
    if (b.t === 'p') out += b.runs.map((r) => r.text || (r.img ? '[그림]' : '')).join('');
    else if (b.t === 'table') for (const row of b.rows) for (const c of row.cells) out += blocksText(c.blocks);
    else if (b.t === 'slide') out += blocksText(b.blocks);
  }
  return out;
}

function hexToBytes(hex) {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function sniffImage(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

function imageUrl(bytes) {
  const type = sniffImage(bytes);
  return type ? URL.createObjectURL(new Blob([bytes], { type })) : null;
}

// ---------------------------------------------------------------- RTF

// 글꼴 문자 집합(\fcharset)과 코드 페이지(\ansicpg)를 브라우저 글자 해독기 이름으로 바꾼다.
const CHARSET_CP = { 0: 1252, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
function decoderLabel(cp) {
  if (cp === 949 || cp === 1361) return 'euc-kr';
  if (cp === 932) return 'shift_jis';
  if (cp === 936) return 'gbk';
  if (cp === 950) return 'big5';
  if (cp === 10000) return 'macintosh';
  if (cp === 874) return 'windows-874';
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  return 'windows-1252';
}

// 건너뛸 묶음(본문이 아닌 표·설정·머리말 등)
const RTF_SKIP = new Set([
  'stylesheet', 'info', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'mmathPr',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'pgdsctbl', 'fldinst', 'nonshppict', 'objdata',
  'objclass', 'bkmkstart', 'bkmkend', 'pntxta', 'pntxtb', 'txe', 'xe', 'tc', 'revtbl', 'filetbl', 'atnid',
  'atrfstart', 'atrfend', 'protusertbl', 'wgrffmtfilter', 'defchp', 'defpap', 'fchars', 'lchars',
  'background', 'sp', 'shprslt', 'template', 'userprops', 'docvar', 'pgptbl', 'ftnsep', 'ftnsepc', 'aftnsep',
  'aftnsepc', 'falt', 'panose', 'fname', 'keycode', 'formfield', 'datafield',
]);
// 본문 밖에 따로 모을 묶음: 머리말·꼬리말·각주·메모(글은 문서 위·아래나 "메모 보기"로 보여 준다)
const RTF_SIDE = {
  header: 'header', headerl: 'header', headerr: 'header', headerf: 'header',
  footer: 'footer', footerl: 'footer', footerr: 'footer', footerf: 'footer',
  footnote: 'footnote', annotation: 'annotation', atnauthor: 'author',
};
// 그대로 둘(본문으로 읽을) \* 묶음
const RTF_KEEP_STAR = new Set(['shppict', 'shpinst', 'shptxt', 'fldrslt', 'pn', 'listtext', 'pntext']);
const RTF_SYMBOLS = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“',
  rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ', tab: '\t', line: '\n',
};

export function parseRtf(bytes) {
  const n = bytes.length;
  const blocks = [];
  const fonts = new Map();
  const colors = [];
  const decoders = new Map();
  let ansiCp = 1252;
  let defaultFont = -1;
  let omittedPictures = 0;

  let st = { b: 0, i: 0, u: 0, s: 0, fs: 0, cf: 0, f: -1, dest: null, uc: 1, pict: null, fontDef: -1, intbl: false, align: '' };
  const stack = [];
  let para = { runs: [], align: '', intbl: false };
  let pending = [];
  let skip = 0;
  let table = null;
  let row = null;
  let cell = [];
  let rowOpen = false;
  let colorTmp = { r: 0, g: 0, b: 0, any: false };
  let star = false;
  const side = { header: [], footer: [], footnote: [], annotation: [] };
  let author = '';
  const sideText = (text) => {
    if (st.side) st.side.text += text;
  };

  const decoder = () => {
    const f = st.f >= 0 ? st.f : defaultFont;
    const cp = fonts.has(f) ? fonts.get(f) : ansiCp;
    const label = decoderLabel(cp || ansiCp);
    if (!decoders.has(label)) decoders.set(label, new TextDecoder(label));
    return decoders.get(label);
  };
  const addText = (text) => {
    if (!text) return;
    const fmt = { b: !!st.b, i: !!st.i, u: !!st.u, s: !!st.s, size: st.fs ? st.fs / 2 : 0, color: colors[st.cf] || '' };
    const last = para.runs[para.runs.length - 1];
    if (last && !last.img && last.b === fmt.b && last.i === fmt.i && last.u === fmt.u && last.s === fmt.s
      && last.size === fmt.size && last.color === fmt.color) last.text += text;
    else para.runs.push({ text, ...fmt });
  };
  const flushBytes = () => {
    if (!pending.length) return;
    const text = decoder().decode(new Uint8Array(pending));
    pending = [];
    if (!st.dest) addText(text);
    else if (st.dest === 'side') sideText(text);
  };
  const closeTable = () => {
    if (!table) return;
    if (cell.length) row.cells.push({ blocks: cell });
    if (row && row.cells.length) table.rows.push(row);
    if (table.rows.length) blocks.push(table);
    table = null;
    row = null;
    cell = [];
  };
  const endPara = () => {
    flushBytes();
    const block = { t: 'p', align: para.align || st.align, runs: para.runs };
    if (para.intbl || st.intbl || rowOpen) {
      if (!table) { table = { t: 'table', rows: [] }; row = { cells: [] }; cell = []; }
      cell.push(block);
    } else {
      closeTable();
      blocks.push(block);
    }
    para = { runs: [], align: st.align, intbl: st.intbl };
  };

  const control = (word, param, hasParam) => {
    // 대상 묶음 처리
    if (st.dest === 'skip') return;
    if (RTF_SIDE[word] && st.dest !== 'side') {
      // 머리말·각주·메모: 따로 모은다. 각주는 본문의 그 자리에 [번호]를 남긴다.
      flushBytes();
      star = false;
      const kind = RTF_SIDE[word];
      const item = { kind, text: '', who: kind === 'annotation' ? author : '' };
      if (kind === 'author') {
        st.dest = 'side';
        st.side = item;
        st.onClose = (t) => { author = t.trim(); };
        return;
      }
      side[kind].push(item);
      if (kind === 'footnote' && !st.dest) addText(`[${side.footnote.length}]`);
      st.dest = 'side';
      st.side = item;
      return;
    }
    if (star) {
      star = false;
      if (!RTF_KEEP_STAR.has(word)) { st.dest = 'skip'; return; }
    }
    if (word === 'fonttbl') { st.dest = 'fonttbl'; return; }
    if (word === 'colortbl') { st.dest = 'colortbl'; return; }
    if (RTF_SKIP.has(word)) { st.dest = 'skip'; return; }
    if (st.dest === 'fonttbl') {
      if (word === 'f') st.fontDef = param;
      else if (word === 'fcharset' && st.fontDef >= 0) fonts.set(st.fontDef, CHARSET_CP[param] || ansiCp);
      else if (word === 'cpg' && st.fontDef >= 0 && param) fonts.set(st.fontDef, param);
      return;
    }
    if (st.dest === 'colortbl') {
      if (word === 'red') { colorTmp.r = param; colorTmp.any = true; }
      else if (word === 'green') { colorTmp.g = param; colorTmp.any = true; }
      else if (word === 'blue') { colorTmp.b = param; colorTmp.any = true; }
      return;
    }
    if (word === 'pict') {
      st.dest = 'pict';
      st.pict = { type: null, hex: [], bin: null, wgoal: 0, w: 0 };
      return;
    }
    if (st.dest === 'pict') {
      const p = st.pict;
      if (word === 'pngblip') p.type = 'png';
      else if (word === 'jpegblip') p.type = 'jpeg';
      else if (word === 'emfblip' || word === 'wmetafile' || word === 'macpict' || word === 'dibitmap' || word === 'wbitmap') p.type = p.type || 'other';
      else if (word === 'picwgoal') p.wgoal = param;
      else if (word === 'picw') p.w = param;
      return;
    }
    if (st.dest === 'side') {
      flushBytes();
      if (word === 'par' || word === 'line' || word === 'cell') sideText('\n');
      else if (word === 'tab') sideText(' ');
      else if (word === 'u') { sideText(String.fromCharCode(param < 0 ? param + 65536 : param)); skip = st.uc; }
      else if (word === 'uc') st.uc = param;
      else if (word === 'f') st.f = param;
      else if (RTF_SYMBOLS[word]) sideText(RTF_SYMBOLS[word]);
      return;
    }
    if (st.dest) return;
    flushBytes();
    switch (word) {
      case 'ansicpg': ansiCp = param || 1252; break;
      case 'deff': defaultFont = param; break;
      case 'par': case 'sect': endPara(); break;
      case 'page': endPara(); blocks.push({ t: 'break' }); break;
      case 'pard': st.align = ''; st.intbl = false; para.align = ''; para.intbl = false; break;
      case 'intbl': st.intbl = true; para.intbl = true; break;
      case 'ql': case 'qc': case 'qr': case 'qj': {
        const a = { ql: 'left', qc: 'center', qr: 'right', qj: 'justify' }[word];
        st.align = a; para.align = a; break;
      }
      case 'plain': st.b = 0; st.i = 0; st.u = 0; st.s = 0; st.fs = 0; st.cf = 0; break;
      case 'b': st.b = hasParam ? param : 1; break;
      case 'i': st.i = hasParam ? param : 1; break;
      case 'ul': st.u = hasParam ? param : 1; break;
      case 'ulnone': st.u = 0; break;
      case 'strike': st.s = hasParam ? param : 1; break;
      case 'fs': st.fs = param; break;
      case 'cf': st.cf = param; break;
      case 'f': st.f = param; break;
      case 'uc': st.uc = param; break;
      case 'u': addText(String.fromCharCode(param < 0 ? param + 65536 : param)); skip = st.uc; break;
      case 'trowd':
        if (!table) { table = { t: 'table', rows: [] }; cell = []; }
        if (!row) row = { cells: [] };
        rowOpen = true;
        break;
      case 'cell': case 'nestcell':
        endPara();
        if (!table) { table = { t: 'table', rows: [] }; row = { cells: [] }; }
        row.cells.push({ blocks: cell });
        cell = [];
        break;
      case 'row': case 'nestrow':
        if (para.runs.length) endPara();
        if (table && row) { if (cell.length) row.cells.push({ blocks: cell }); table.rows.push(row); }
        row = { cells: [] };
        cell = [];
        rowOpen = false;
        break;
      default:
        if (RTF_SYMBOLS[word]) addText(RTF_SYMBOLS[word]);
    }
  };

  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0x7b) { // {
      flushBytes();
      stack.push(st);
      st = { ...st };
      star = false;
      continue;
    }
    if (c === 0x7d) { // }
      flushBytes();
      const done = st;
      st = stack.pop() || st;
      if (done.onClose && done.side && st.side !== done.side) done.onClose(done.side.text);
      if (done.dest === 'pict' && st.dest !== 'pict' && done.pict) {
        const p = done.pict;
        if ((p.type === 'png' || p.type === 'jpeg') && (p.hex.length || p.bin)) {
          const data = p.bin || hexToBytes(p.hex.join(''));
          const url = imageUrl(data);
          if (url && !st.dest) para.runs.push({ img: url, w: p.wgoal ? p.wgoal / 15 : 0 });
        } else if (!st.dest || st.dest === 'shppict') omittedPictures++;
      }
      if (done.dest === 'colortbl' && st.dest !== 'colortbl') colorTmp = { r: 0, g: 0, b: 0, any: false };
      continue;
    }
    if (c === 0x5c) { // \
      const d = bytes[i + 1];
      if (d === 0x27) { // \'hh
        const h = String.fromCharCode(bytes[i + 2], bytes[i + 3]);
        i += 3;
        if (skip > 0) { skip--; continue; }
        if (st.dest === 'pict') continue;
        pending.push(parseInt(h, 16));
        continue;
      }
      if ((d >= 0x61 && d <= 0x7a) || (d >= 0x41 && d <= 0x5a)) {
        let j = i + 1;
        while (j < n && ((bytes[j] >= 0x61 && bytes[j] <= 0x7a) || (bytes[j] >= 0x41 && bytes[j] <= 0x5a))) j++;
        const word = String.fromCharCode(...bytes.subarray(i + 1, j));
        let k = j;
        if (bytes[k] === 0x2d) k++;
        while (k < n && bytes[k] >= 0x30 && bytes[k] <= 0x39) k++;
        const hasParam = k > j && !(k === j + 1 && bytes[j] === 0x2d);
        const param = hasParam ? parseInt(String.fromCharCode(...bytes.subarray(j, k)), 10) : 0;
        if (bytes[k] === 0x20) k++;
        i = k - 1;
        if (word === 'bin' && param > 0) {
          if (st.dest === 'pict' && st.pict) st.pict.bin = bytes.slice(i + 1, i + 1 + param);
          i += param;
          continue;
        }
        if (skip > 0 && word !== 'u') { skip--; }
        control(word, param, hasParam);
        continue;
      }
      i++;
      if (d === 0x2a) { star = true; continue; }
      if (skip > 0) { skip--; continue; }
      if (st.dest === 'side') {
        flushBytes();
        if (d === 0x5c || d === 0x7b || d === 0x7d) sideText(String.fromCharCode(d));
        else if (d === 0x7e) sideText(' ');
        continue;
      }
      if (st.dest) continue;
      flushBytes();
      if (d === 0x5c || d === 0x7b || d === 0x7d) addText(String.fromCharCode(d));
      else if (d === 0x7e) addText(' ');
      else if (d === 0x5f) addText('-');
      else if (d === 0x0d || d === 0x0a) endPara();
      continue;
    }
    if (c === 0x0d || c === 0x0a) continue;
    if (st.dest === 'pict') {
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)) st.pict.hex.push(String.fromCharCode(c));
      continue;
    }
    if (st.dest === 'colortbl') {
      if (c === 0x3b) {
        const hex = (v) => v.toString(16).padStart(2, '0');
        colors.push(colorTmp.any ? `#${hex(colorTmp.r)}${hex(colorTmp.g)}${hex(colorTmp.b)}` : '');
        colorTmp = { r: 0, g: 0, b: 0, any: false };
      }
      continue;
    }
    if (st.dest && st.dest !== 'side') continue;
    if (skip > 0) { skip--; continue; }
    if (c >= 0x80) { pending.push(c); continue; }
    flushBytes();
    if (st.dest === 'side') sideText(String.fromCharCode(c));
    else addText(String.fromCharCode(c));
  }
  flushBytes();
  if (para.runs.length) endPara();
  closeTable();
  const clean = (t) => t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return {
    blocks,
    omittedPictures,
    extras: {
      header: [...new Set(side.header.map((x) => clean(x.text)).filter(Boolean))].join('\n'),
      footer: [...new Set(side.footer.map((x) => clean(x.text)).filter(Boolean))].join('\n'),
      footnotes: side.footnote.map((x) => clean(x.text)),
      comments: side.annotation.map((x) => ({ who: x.who, text: clean(x.text) })).filter((x) => x.text),
    },
  };
}

// ---------------------------------------------------------------- XML 공용

function kids(node) {
  return node ? [...node.childNodes].filter((x) => x.nodeType === 1) : [];
}

function attr(node, local) {
  if (!node || !node.attributes) return null;
  for (const a of node.attributes) if (a.localName === local) return a.value;
  return null;
}

function first(node, local) {
  if (!node) return null;
  const list = node.getElementsByTagNameNS('*', local);
  return list.length ? list[0] : null;
}

// 요소 안 문단(text:p·text:h) 글을 줄마다 모은다.
function paraText(node) {
  return [...node.getElementsByTagNameNS('*', 'p'), ...node.getElementsByTagNameNS('*', 'h')]
    .map((p) => p.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

function lengthPx(v) {
  const m = /^([\d.]+)(cm|mm|in|pt|px)?$/.exec(v || '');
  if (!m) return 0;
  const x = Number(m[1]);
  return { cm: x * 37.8, mm: x * 3.78, in: x * 96, pt: x * 96 / 72, px: x }[m[2] || 'px'] || 0;
}

// ---------------------------------------------------------------- ODT·ODP (OpenDocument)

function odfStyles(...docs) {
  const map = new Map();
  for (const doc of docs) {
    if (!doc) continue;
    for (const s of doc.getElementsByTagNameNS('*', 'style')) {
      if (s.namespaceURI && !s.namespaceURI.includes(':style:')) continue;
      const name = attr(s, 'name');
      if (!name) continue;
      const tp = kids(s).find((k) => k.localName === 'text-properties');
      const pp = kids(s).find((k) => k.localName === 'paragraph-properties');
      const weight = tp && attr(tp, 'font-weight');
      const size = tp && attr(tp, 'font-size');
      map.set(name, {
        parent: attr(s, 'parent-style-name'),
        b: weight ? weight === 'bold' || Number(weight) >= 600 : undefined,
        i: tp && attr(tp, 'font-style') ? attr(tp, 'font-style') === 'italic' : undefined,
        u: tp && attr(tp, 'text-underline-style') ? attr(tp, 'text-underline-style') !== 'none' : undefined,
        s: tp && attr(tp, 'text-line-through-style') ? attr(tp, 'text-line-through-style') !== 'none' : undefined,
        color: tp ? attr(tp, 'color') : null,
        size: size && /pt$/.test(size) ? parseFloat(size) : 0,
        align: pp ? attr(pp, 'text-align') : null,
      });
    }
  }
  const resolve = (name, depth = 0) => {
    const s = map.get(name);
    if (!s || depth > 5) return {};
    const parent = s.parent ? resolve(s.parent, depth + 1) : {};
    const out = { ...parent };
    for (const k of ['b', 'i', 'u', 's']) if (s[k] !== undefined) out[k] = s[k];
    if (s.color) out.color = s.color;
    if (s.size) out.size = s.size;
    if (s.align) out.align = s.align;
    return out;
  };
  return resolve;
}

function odfConvert(root, ctx) {
  const blocks = [];
  const inline = (node, fmt, runs) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        const t = ch.nodeValue.replace(/[\r\n]+/g, ' ');
        if (t) runs.push({ text: t, ...fmt });
        continue;
      }
      if (ch.nodeType !== 1) continue;
      switch (ch.localName) {
        case 's': runs.push({ text: ' '.repeat(Number(attr(ch, 'c') || 1)), ...fmt }); break;
        case 'tab': runs.push({ text: '\t', ...fmt }); break;
        case 'line-break': runs.push({ text: '\n', ...fmt }); break;
        case 'span': inline(ch, { ...fmt, ...ctx.style(attr(ch, 'style-name')) }, runs); break;
        case 'note': {
          // 각주·미주: 본문 그 자리에는 [번호]를 남기고 글은 문서 끝에 모은다.
          const bodyEl = kids(ch).find((k) => k.localName === 'note-body');
          if (ctx.footnotes && bodyEl) {
            ctx.footnotes.push(paraText(bodyEl));
            runs.push({ text: `[${ctx.footnotes.length}]`, ...fmt });
          }
          break;
        }
        case 'annotation': {
          if (ctx.comments) {
            const who = kids(ch).find((k) => k.localName === 'creator');
            const t = paraText(ch);
            if (t) ctx.comments.push({ who: who ? who.textContent.trim() : '', text: t });
          }
          break;
        }
        case 'bookmark': case 'bookmark-start': case 'bookmark-end':
        case 'soft-page-break': case 'reference-mark': break;
        case 'frame': {
          const img = kids(ch).find((k) => k.localName === 'image');
          const url = img && ctx.image(attr(img, 'href'));
          if (url) runs.push({ img: url, w: lengthPx(attr(ch, 'width')) });
          else if (img) ctx.omitted++;
          const box = kids(ch).find((k) => k.localName === 'text-box');
          if (box) runs.push(...flattenRuns(walk(box, fmt)));
          break;
        }
        default: inline(ch, fmt, runs);
      }
    }
  };
  const flattenRuns = (bs) => {
    const out = [];
    for (const b of bs) if (b.t === 'p') { if (out.length) out.push({ text: '\n' }); out.push(...b.runs); }
    return out;
  };
  const para = (node, extra = {}) => {
    const st = ctx.style(attr(node, 'style-name'));
    const heading = node.localName === 'h' ? Number(attr(node, 'outline-level') || 1) : 0;
    const fmt = { b: st.b || !!heading, i: st.i, u: st.u, s: st.s, color: st.color, size: st.size };
    const runs = extra.prefix ? [{ text: extra.prefix }] : [];
    inline(node, fmt, runs);
    return { t: 'p', align: st.align, heading, runs };
  };
  const walk = (node, inherited = {}, depth = 0) => {
    const out = [];
    for (const ch of kids(node)) {
      switch (ch.localName) {
        case 'p': case 'h': out.push(para(ch)); break;
        case 'list': {
          for (const item of kids(ch)) {
            const inner = walk(item, inherited, depth + 1);
            const firstP = inner.find((b) => b.t === 'p' && !b.listed);
            if (firstP) {
              firstP.runs.unshift({ text: `${'\u00a0\u00a0'.repeat(depth)}• ` });
              firstP.listed = true;
            }
            out.push(...inner);
          }
          break;
        }
        case 'table': out.push(odfTable(ch)); break;
        case 'section': case 'list-item': case 'list-header': case 'text-box': case 'g':
          out.push(...walk(ch, inherited, depth)); break;
        case 'frame': case 'custom-shape': case 'rect': case 'ellipse': {
          const runs = [];
          inline({ childNodes: [ch] }, {}, runs);
          const inner = walk(ch, inherited, depth);
          if (runs.some((r) => r.img)) out.push({ t: 'p', runs: runs.filter((r) => r.img) });
          out.push(...inner);
          break;
        }
        default: break;
      }
    }
    return out;
  };
  const odfTable = (node) => {
    const rows = [];
    const addRows = (container) => {
      for (const ch of kids(container)) {
        if (ch.localName === 'table-row') {
          const cells = [];
          for (const c of kids(ch)) {
            if (c.localName !== 'table-cell') continue;
            cells.push({ blocks: walk(c), colspan: Number(attr(c, 'number-columns-spanned') || 1), rowspan: Number(attr(c, 'number-rows-spanned') || 1) });
          }
          const repeat = Math.min(50, Number(attr(ch, 'number-rows-repeated') || 1));
          for (let r = 0; r < repeat; r++) rows.push({ cells });
        } else if (/^table-(header-rows|rows|row-group)$/.test(ch.localName)) addRows(ch);
      }
    };
    addRows(node);
    return { t: 'table', rows };
  };
  return { walk, blocks };
}

export async function parseOdf(parts, kind) {
  const xml = (name) => {
    const b = parts.get(name);
    return b ? new DOMParser().parseFromString(new TextDecoder().decode(b), 'application/xml') : null;
  };
  const content = xml('content.xml');
  if (!content) throw new Error('content.xml 없음');
  const style = odfStyles(xml('styles.xml'), content);
  const urls = new Map();
  const ctx = {
    style: (name) => (name ? style(name) : {}),
    omitted: 0,
    footnotes: [],
    comments: [],
    image: (href) => {
      if (!href) return null;
      const key = href.replace(/^\.\//, '').toLowerCase();
      if (!urls.has(key)) urls.set(key, parts.has(key) ? imageUrl(parts.get(key)) : null);
      return urls.get(key);
    },
  };
  const { walk } = odfConvert(content, ctx);
  const body = first(content, 'body');
  let blocks;
  const notes = [];
  if (kind === 'odp') {
    blocks = [];
    let n = 0;
    for (const page of body.getElementsByTagNameNS('*', 'page')) {
      n++;
      blocks.push({ t: 'slide', n, blocks: walk(page) });
      const nt = kids(page).filter((k) => k.localName === 'notes').map(paraText).join('\n').trim();
      if (nt) notes.push({ where: T('{n}번 슬라이드', { n }), text: nt });
    }
  } else {
    blocks = walk(first(body, 'text') || body);
  }
  // 머리말·꼬리말은 styles.xml의 기본 쪽 모양(master-page)에 있다.
  const styles = xml('styles.xml');
  const hf = (local) => (styles ? [...styles.getElementsByTagNameNS('*', local)].map(paraText).filter(Boolean) : []);
  return {
    blocks,
    omittedPictures: ctx.omitted,
    extras: {
      header: [...new Set(hf('header'))].join('\n'),
      footer: [...new Set(hf('footer'))].join('\n'),
      footnotes: ctx.footnotes,
      comments: ctx.comments,
      notes,
    },
  };
}

// ---------------------------------------------------------------- Word 2003 XML (WordprocessingML 2003)

export function parseWordXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const bins = new Map();
  for (const b of doc.getElementsByTagNameNS('*', 'binData')) {
    try {
      const raw = atob((b.textContent || '').replace(/\s+/g, ''));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      bins.set(attr(b, 'name'), bytes);
    } catch (_) { /* 깨진 그림은 건너뛴다 */ }
  }
  const styles = new Map();
  for (const s of doc.getElementsByTagNameNS('*', 'style')) {
    const rPr = kids(s).find((k) => k.localName === 'rPr');
    const pPr = kids(s).find((k) => k.localName === 'pPr');
    styles.set(attr(s, 'styleId'), {
      b: !!(rPr && kids(rPr).some((k) => k.localName === 'b' && attr(k, 'val') !== 'off')),
      size: rPr && kids(rPr).find((k) => k.localName === 'sz') ? Number(attr(kids(rPr).find((k) => k.localName === 'sz'), 'val')) / 2 : 0,
      align: pPr && kids(pPr).find((k) => k.localName === 'jc') ? attr(kids(pPr).find((k) => k.localName === 'jc'), 'val') : null,
    });
  }
  let omitted = 0;
  const on = (node, local) => {
    const k = node && kids(node).find((x) => x.localName === local);
    return !!k && !/^(off|false|0|none)$/.test(attr(k, 'val') || '');
  };
  const runFmt = (rPr, base) => {
    if (!rPr) return base;
    const sz = kids(rPr).find((k) => k.localName === 'sz');
    const color = kids(rPr).find((k) => k.localName === 'color');
    return {
      b: kids(rPr).some((k) => k.localName === 'b') ? on(rPr, 'b') : base.b,
      i: kids(rPr).some((k) => k.localName === 'i') ? on(rPr, 'i') : base.i,
      u: on(rPr, 'u') || base.u,
      s: on(rPr, 'strike') || base.s,
      size: sz ? Number(attr(sz, 'val')) / 2 : base.size,
      color: color && /^[0-9a-f]{6}$/i.test(attr(color, 'val') || '') ? `#${attr(color, 'val')}` : base.color,
    };
  };
  const runsOf = (node, base, runs) => {
    for (const ch of kids(node)) {
      if (ch.localName === 'r') {
        const fmt = runFmt(kids(ch).find((k) => k.localName === 'rPr'), base);
        for (const x of kids(ch)) {
          if (x.localName === 't') runs.push({ text: x.textContent, ...fmt });
          else if (x.localName === 'tab') runs.push({ text: '\t', ...fmt });
          else if (x.localName === 'br') runs.push({ text: '\n', ...fmt });
          else if (x.localName === 'pict') {
            const im = first(x, 'imagedata');
            const bytes = im && bins.get(attr(im, 'src'));
            const url = bytes && imageUrl(bytes);
            if (url) runs.push({ img: url, w: 0 });
            else omitted++;
          }
        }
      } else if (/^(hlink|fldSimple|smartTag|ins)$/.test(ch.localName)) runsOf(ch, base, runs);
    }
  };
  const para = (p) => {
    const pPr = kids(p).find((k) => k.localName === 'pPr');
    const pStyle = pPr && kids(pPr).find((k) => k.localName === 'pStyle');
    const st = (pStyle && styles.get(attr(pStyle, 'val'))) || {};
    const jc = pPr && kids(pPr).find((k) => k.localName === 'jc');
    const runs = [];
    runsOf(p, { b: st.b, size: st.size }, runs);
    return { t: 'p', align: jc ? attr(jc, 'val') : st.align, runs };
  };
  const walk = (node) => {
    const out = [];
    for (const ch of kids(node)) {
      if (ch.localName === 'p') out.push(para(ch));
      else if (ch.localName === 'tbl') {
        const rows = [];
        for (const tr of kids(ch).filter((k) => k.localName === 'tr')) {
          const cells = [];
          for (const tc of kids(tr).filter((k) => k.localName === 'tc')) {
            const tcPr = kids(tc).find((k) => k.localName === 'tcPr');
            const span = tcPr && kids(tcPr).find((k) => k.localName === 'gridSpan');
            cells.push({ blocks: walk(tc), colspan: span ? Number(attr(span, 'val')) : 1 });
          }
          rows.push({ cells });
        }
        out.push({ t: 'table', rows });
      } else if (/^(sect|sub-section|body|sdt|sdtContent)$/.test(ch.localName)) out.push(...walk(ch));
    }
    return out;
  };
  const body = first(doc, 'body');
  if (!body) throw new Error('본문 없음');
  return { blocks: walk(body), omittedPictures: omitted };
}

// ---------------------------------------------------------------- Word 2·6·95, Write (글자만)

// 본문 글자는 파일 안에 이어서 들어 있다(fcMin~fcMac). 표·그림·서식은 버리고 문단만 살린다.
// 문서 언어(lid) → 코드 페이지. 표에 없는 언어는 서유럽(1252)으로 보고 아래에서 내용으로 다시 판별한다.
const LID_ENCODING = {
  0x0412: 'euc-kr', 0x0411: 'shift_jis', 0x0404: 'big5', 0x0804: 'gbk', 0x0c04: 'big5',
  0x0419: 'windows-1251', 0x0422: 'windows-1251', 0x0423: 'windows-1251', 0x0402: 'windows-1251', 0x0c1a: 'windows-1251', 0x042f: 'windows-1251',
  0x0405: 'windows-1250', 0x0415: 'windows-1250', 0x040e: 'windows-1250', 0x041b: 'windows-1250', 0x0424: 'windows-1250', 0x041a: 'windows-1250', 0x0418: 'windows-1250',
  0x0408: 'windows-1253', 0x041f: 'windows-1254', 0x040d: 'windows-1255', 0x0401: 'windows-1256',
  0x0425: 'windows-1257', 0x0426: 'windows-1257', 0x0427: 'windows-1257', 0x041e: 'windows-874', 0x042a: 'windows-1258',
};

// 옛 Word(2~95)·Write 본문의 글자 코드를 고른다. 언어 표시가 서유럽·영어인데 실제로는 한국어·러시아어인 문서가 있어
// 그때만 내용으로 판별한다: EUC-KR로 풀었을 때 대부분 한글이면 한국어, 글자의 절반 넘게가 0xC0 이상이면 키릴(1251).
function oldWordEncoding(raw, lid, korean) {
  if (korean) return 'euc-kr';
  const byLid = LID_ENCODING[lid];
  if (byLid) return byLid;
  let high = 0;
  let letters = 0;
  for (const b of raw) {
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) letters++;
    else if (b >= 0xc0) {
      high++;
      letters++;
    }
  }
  if (high > 8) {
    const ko = new TextDecoder('euc-kr').decode(raw);
    let hangul = 0;
    let other = 0;
    for (const ch of ko) {
      const c = ch.charCodeAt(0);
      if (c >= 0xac00 && c <= 0xd7a3) hangul++;
      else if (c >= 0x80) other++;
    }
    if (hangul > 8 && hangul >= (hangul + other) * 0.8) return 'euc-kr';
    if (high > letters * 0.5) return 'windows-1251';
  }
  return 'windows-1252';
}

export function parseOldWordText(stream, kind) {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let start;
  let end;
  let korean = false;
  if (kind === 'write') {
    start = 0x80;
    end = dv.getUint32(0x0e, true);
  } else {
    start = dv.getUint32(0x18, true);
    end = dv.getUint32(0x1c, true);
    korean = dv.getUint16(0x06, true) === 0x0412;
    if (dv.getUint16(0x0a, true) & 0x0100) {
      const err = new Error('encrypted');
      err.code = 'encrypted';
      throw err;
    }
  }
  if (!(start > 0 && end > start && end <= stream.length)) throw new Error('본문 위치를 찾지 못함');
  const raw = stream.subarray(start, end);
  const text = new TextDecoder(oldWordEncoding(raw, kind === 'write' ? 0 : dv.getUint16(0x06, true), korean)).decode(raw);
  const blocks = [];
  let field = 0;
  let line = '';
  const push = () => { blocks.push({ t: 'p', runs: line ? [{ text: line }] : [] }); line = ''; };
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0x13) { field = 1; continue; }        // 필드 시작: 명령어는 건너뛴다
    if (c === 0x14) { field = 0; continue; }        // 필드 결과부터 보여준다
    if (c === 0x15) { field = 0; continue; }
    if (field) continue;
    if (c === 0x0d) push();
    else if (c === 0x07) line += '  │  ';           // 표 칸 끝
    else if (c === 0x0b) line += '\n';
    else if (c === 0x0c) { push(); blocks.push({ t: 'break' }); }
    else if (c === 0x09) line += '\t';
    else if (c === 0x1e) line += '-';
    else if (c < 0x20 || c === 0x1f) continue;
    else line += ch;
  }
  if (line) push();
  return { blocks, omittedPictures: 0, textOnly: true };
}
