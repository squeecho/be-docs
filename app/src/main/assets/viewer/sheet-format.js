// 엑셀 칸 서식(글꼴·정렬·테두리)과 시트 보기 설정(열 너비·행 높이·숨김·틀 고정·눈금선)을 읽는다.
// SheetJS 무료판은 글꼴·채우기·정렬 목록은 읽지만 칸마다 몇 번 서식인지, 테두리, 틀 고정, 눈금선 숨김은 버린다.
// xlsx는 SheetJS가 풀어 둔 원본 조각(bookFiles)에서, xls(BIFF8)는 통합 문서 스트림의 기록에서 직접 읽는다.
// 화면 스레드와 큰 파일용 작업 스레드(sheet-worker.js)에서 같이 쓰므로 일반 스크립트로 두고 DOM을 쓰지 않는다.
/* global self */
(function (root) {
  'use strict';

  const MAX_ROWS = 3001; // 화면에 그리는 행 수(viewer.js의 MAX_SHEET_ROWS + 1)와 맞춘다

  // 엑셀 97~2003 기본 색표(색 번호 0~63). 64는 글자 기본색(검정), 65는 배경 기본색(흰색).
  const PALETTE = [
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
    '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
    '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
    '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
    '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
    '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
    '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  ];

  // 테두리 선 모양: xls 번호 → xlsx 이름
  const LINE = ['', 'thin', 'medium', 'dashed', 'dotted', 'thick', 'double', 'hair',
    'mediumDashed', 'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot'];
  const H_ALIGN = [null, 'left', 'center', 'right', 'fill', 'justify', 'centerContinuous', 'distributed'];
  const V_ALIGN = ['top', 'center', 'bottom', 'justify', 'distributed'];

  const utf8 = (b) => new TextDecoder().decode(b);
  const attr = (s, k) => {
    const m = new RegExp(`\\b${k}="([^"]*)"`).exec(s);
    return m ? m[1] : null;
  };
  const truthy = (v) => v === '1' || v === 'true';

  // 엑셀 열 너비(글자 수) → 화면 픽셀. 기본 글꼴(맑은 고딕·Calibri 11pt)의 숫자 폭 7px 기준.
  // 엑셀 열 너비 → 화면 픽셀(ECMA-376 18.3.1.13). 파일의 width는 여백을 포함한 "숫자 폭(MDW)" 단위이고,
  // MDW는 통합 문서 기본 글꼴의 숫자 폭이다(Calibri 11 → 7px, 맑은 고딕 11 → 8px: 한국어판 기본 열 8.38 = 72px).
  const widthPx = (w, mdw = 7) => Math.max(0, Math.trunc(((256 * w + Math.trunc(128 / mdw)) / 256) * mdw));
  // 기본 열 너비(글자 수, 여백 제외) → 픽셀: 여백 5px을 더해 8px 단위로 올린다(Calibri 8 → 64px, 맑은 고딕 8 → 72px).
  const baseWidthPx = (chars, mdw = 7) => Math.ceil((chars * mdw + 5) / 8) * 8;
  const DIGIT_EM = [
    [/calibri/i, 0.507], [/arial|helvetica|liberation sans/i, 0.556], [/tahoma/i, 0.546], [/verdana/i, 0.636],
    [/times/i, 0.5], [/cambria/i, 0.556], [/segoe/i, 0.55], [/맑은|malgun/i, 0.55],
    [/굴림|돋움|바탕|궁서|gulim|dotum|batang|gungsuh/i, 0.55], [/明體|明朝|ming|宋体|simsun|ゴシック|gothic|mincho|新細/i, 0.5],
  ];
  const mdwFor = (name, sz) => {
    const em = (DIGIT_EM.find(([re]) => re.test(name || '')) || [0, 0.55])[1];
    return Math.max(5, Math.round((Number(sz) || 11) * 96 / 72 * em));
  };
  const ptPx = (pt) => Math.round(pt * 96 / 72);

  // ---------------------------------------------------------------- 색

  // ECMA-376 18.8.19: 밝기(tint) 보정. -1(검게)~1(희게).
  function applyTint(hex, tint) {
    if (!tint) return hex;
    const n = parseInt(hex, 16);
    let r = ((n >> 16) & 255) / 255;
    let g = ((n >> 8) & 255) / 255;
    let b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    let l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
    const hue = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
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

  function themeList(wb) {
    const scheme = wb && wb.Themes && wb.Themes.themeElements && wb.Themes.themeElements.clrScheme;
    return Array.isArray(scheme) ? scheme.map((c) => (c && c.rgb ? String(c.rgb).slice(-6).toUpperCase() : null)) : [];
  }

  // xlsx <color rgb|theme|indexed|auto tint> 속성 글 → '#RRGGBB' 또는 null(자동색)
  function xmlColor(attrs, theme) {
    if (!attrs) return null;
    if (truthy(attr(attrs, 'auto'))) return null;
    const tint = Number(attr(attrs, 'tint') || 0);
    const rgb = attr(attrs, 'rgb');
    if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) return `#${applyTint(rgb.slice(-6).toUpperCase(), tint)}`;
    const th = attr(attrs, 'theme');
    if (th != null && theme[Number(th)]) return `#${applyTint(theme[Number(th)], tint)}`;
    const ix = attr(attrs, 'indexed');
    if (ix != null && Number(ix) < 64) return `#${applyTint(PALETTE[Number(ix)], tint)}`;
    return null;
  }

  // SheetJS가 읽은 색 객체({rgb, theme, tint, indexed, auto})
  function objColor(c, theme) {
    if (!c || c.auto) return null;
    if (c.rgb && /^[0-9a-f]{6,8}$/i.test(c.rgb)) return `#${String(c.rgb).slice(-6).toUpperCase()}`;
    if (c.theme != null && theme[c.theme]) return `#${applyTint(theme[c.theme], c.tint || 0)}`;
    if (c.indexed != null && c.indexed < 64) return `#${PALETTE[c.indexed]}`;
    return null;
  }

  const SERIF = /바탕|명조|궁서|batang|myeongjo|gungsuh|serif|times|georgia|garamond|mincho|song/i;

  // ---------------------------------------------------------------- xlsx

  function partText(files, name) {
    const e = files[name] || files[name.replace(/^\//, '')] || files[`/${name}`];
    return e && e.content ? utf8(e.content) : '';
  }

  function resolveTarget(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const out = base.split('/');
    out.pop();
    for (const seg of target.split('/')) {
      if (seg === '..') out.pop();
      else if (seg && seg !== '.') out.push(seg);
    }
    return out.join('/');
  }

  function relsOf(files, part) {
    const rels = new Map();
    const xml = partText(files, part.replace(/([^/]+)$/, '_rels/$1.rels'));
    for (const m of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
      if (attr(m[1], 'TargetMode') === 'External') continue;
      rels.set(attr(m[1], 'Id'), { type: attr(m[1], 'Type') || '', target: resolveTarget(part, attr(m[1], 'Target') || '') });
    }
    return rels;
  }

  function xlsxBorders(styles, theme) {
    const list = [];
    const block = /<(?:\w+:)?borders\b[^>]*>([\s\S]*?)<\/(?:\w+:)?borders>/.exec(styles);
    if (!block) return list;
    for (const m of block[1].matchAll(/<(?:\w+:)?border\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?border>)/g)) {
      const sides = {};
      for (const s of (m[2] || '').matchAll(/<(?:\w+:)?(left|right|top|bottom|start|end)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/g)) {
        const style = attr(s[2], 'style');
        if (!style || style === 'none') continue;
        const c = /<(?:\w+:)?color\b([^>]*)\/?>/.exec(s[3] || '');
        const key = s[1] === 'start' ? 'l' : s[1] === 'end' ? 'r' : s[1][0];
        sides[key] = [style, xmlColor(c && c[1], theme)];
      }
      list.push(sides);
    }
    return list;
  }

  // ---------------------------------------------------------------- 조건부 서식(xlsx)

  const unescapeXml = (t) => t.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'amp') return '&';
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
  });

  // 조건부 서식이 입히는 서식 목록(dxf): 채우기·글자색·굵기·기울임·밑줄·취소선
  function xlsxDxfs(styles, theme) {
    const list = [];
    const block = /<(?:\w+:)?dxfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?dxfs>/.exec(styles);
    if (!block) return list;
    for (const m of block[1].matchAll(/<(?:\w+:)?dxf\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?dxf>)/g)) {
      const x = m[1] || '';
      const d = {};
      const font = /<(?:\w+:)?font\b[^>]*>([\s\S]*?)<\/(?:\w+:)?font>/.exec(x);
      if (font) {
        const flag = (tag) => {
          const t = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)\\/?>`).exec(font[1]);
          if (!t) return null;
          const v = attr(t[1], 'val');
          return v !== '0' && v !== 'false';
        };
        const b = flag('b');
        const i = flag('i');
        const st = flag('strike');
        if (b != null) d.b = b;
        if (i != null) d.i = i;
        if (st != null) d.s = st;
        const u = /<(?:\w+:)?u\b([^>]*?)\/?>/.exec(font[1]);
        if (u) d.u = attr(u[1], 'val') !== 'none';
        const c = /<(?:\w+:)?color\b([^>]*?)\/?>/.exec(font[1]);
        if (c) {
          const col = xmlColor(c[1], theme);
          if (col) d.color = col;
        }
      }
      const fill = /<(?:\w+:)?patternFill\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?patternFill>)/.exec(x);
      if (fill && attr(fill[1], 'patternType') !== 'none') {
        // 조건부 서식의 단색 채우기는 bgColor에 적힌다(일부 프로그램은 fgColor).
        const bg = /<(?:\w+:)?bgColor\b([^>]*?)\/?>/.exec(fill[2] || '');
        const fg = /<(?:\w+:)?fgColor\b([^>]*?)\/?>/.exec(fill[2] || '');
        const col = (bg && xmlColor(bg[1], theme)) || (fg && xmlColor(fg[1], theme));
        if (col) d.fill = col;
      }
      list.push(d);
    }
    return list;
  }

  // "A1:B5 D3 C:C 2:4" → 범위 목록(0부터)
  function decodeSqref(text) {
    const out = [];
    const colNum = (l) => {
      let n = 0;
      for (const ch of l.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
      return n - 1;
    };
    const one = (ref) => {
      const m = /^\$?([A-Za-z]{1,3})?\$?(\d+)?$/.exec(ref);
      if (!m || (!m[1] && !m[2])) return null;
      return { c: m[1] ? colNum(m[1]) : null, r: m[2] ? Number(m[2]) - 1 : null };
    };
    for (const part of String(text || '').trim().split(/\s+/)) {
      if (!part) continue;
      const [a, b] = part.split(':');
      const s = one(a);
      const e = one(b || a);
      if (!s || !e) continue;
      out.push({
        s: { r: s.r == null ? 0 : s.r, c: s.c == null ? 0 : s.c },
        e: { r: e.r == null ? 1048575 : e.r, c: e.c == null ? 16383 : e.c },
      });
    }
    return out;
  }

  // 시트 XML 끝부분의 <conditionalFormatting>을 읽는다. 엑셀 2010 확장(x14)에만 있는 규칙은 개수만 센다.
  function xlsxConditional(xml, theme) {
    const at = xml.lastIndexOf('sheetData>');
    const tail = at >= 0 ? xml.slice(at) : xml;
    if (!/conditionalFormatting/.test(tail)) return null;
    const blocks = [];
    const ids = new Set();
    let ext = 0;
    const extIds = [];
    for (const m of tail.matchAll(/<(\w+:)?conditionalFormatting\b([^>]*)>([\s\S]*?)<\/\1conditionalFormatting>/g)) {
      const prefix = m[1] || '';
      if (prefix && prefix !== 'x:' && prefix !== 'main:') {
        // x14:conditionalFormatting: 기본 규칙에 딸린 꾸밈(데이터 막대 모양 등)은 건너뛰고, 그 밖의 규칙만 센다.
        for (const r of m[3].matchAll(/<(?:\w+:)?cfRule\b([^>]*)>/g)) {
          extIds.push(attr(r[1], 'id'));
          ext++;
        }
        continue;
      }
      const ranges = decodeSqref(attr(m[2], 'sqref'));
      if (!ranges.length) continue;
      const rules = [];
      for (const r of m[3].matchAll(/<(?:\w+:)?cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?cfRule>)/g)) {
        const a = r[1];
        const inner = r[2] || '';
        const num = (k, d) => (attr(a, k) != null ? Number(attr(a, k)) : d);
        const rule = {
          type: attr(a, 'type') || '',
          priority: num('priority', 0),
          dxf: attr(a, 'dxfId') != null ? Number(attr(a, 'dxfId')) : null,
          op: attr(a, 'operator'),
          text: attr(a, 'text') != null ? unescapeXml(attr(a, 'text')) : null,
          stop: truthy(attr(a, 'stopIfTrue')),
          formulas: [...inner.matchAll(/<(?:\w+:)?formula>([\s\S]*?)<\/(?:\w+:)?formula>/g)].map((f) => unescapeXml(f[1]).trim()),
          rank: num('rank', 10),
          percent: truthy(attr(a, 'percent')),
          bottom: truthy(attr(a, 'bottom')),
          above: attr(a, 'aboveAverage') !== '0' && attr(a, 'aboveAverage') !== 'false',
          equal: truthy(attr(a, 'equalAverage')),
          stdDev: num('stdDev', 0),
          period: attr(a, 'timePeriod'),
        };
        const cfvos = (x) => [...x.matchAll(/<(?:\w+:)?cfvo\b([^>]*?)\/?>/g)].map((c) => ({
          type: attr(c[1], 'type'), val: attr(c[1], 'val'), gte: attr(c[1], 'gte') !== '0',
        }));
        const colors = (x) => [...x.matchAll(/<(?:\w+:)?color\b([^>]*?)\/?>/g)].map((c) => xmlColor(c[1], theme));
        const scale = /<(?:\w+:)?colorScale>([\s\S]*?)<\/(?:\w+:)?colorScale>/.exec(inner);
        if (scale) rule.scale = { cfvo: cfvos(scale[1]), colors: colors(scale[1]) };
        const bar = /<(?:\w+:)?dataBar\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?dataBar>/.exec(inner);
        if (bar) {
          rule.bar = {
            cfvo: cfvos(bar[2]),
            color: colors(bar[2])[0] || '#638EC6',
            min: attr(bar[1], 'minLength') != null ? Number(attr(bar[1], 'minLength')) : 10,
            max: attr(bar[1], 'maxLength') != null ? Number(attr(bar[1], 'maxLength')) : 90,
            showValue: attr(bar[1], 'showValue') !== '0',
          };
        }
        const icon = /<(?:\w+:)?iconSet\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?iconSet>/.exec(inner);
        if (icon) {
          rule.icons = {
            set: attr(icon[1], 'iconSet') || '3TrafficLights1',
            reverse: truthy(attr(icon[1], 'reverse')),
            showValue: attr(icon[1], 'showValue') !== '0',
            cfvo: cfvos(icon[2]),
          };
        }
        const id = /<(?:\w+:)?id>([^<]*)<\/(?:\w+:)?id>/.exec(inner);
        if (id) ids.add(id[1]);
        rules.push(rule);
      }
      if (rules.length) blocks.push({ ranges, rules });
    }
    // 기본 규칙과 짝이 있는 확장(데이터 막대 꾸밈)은 빼고, 확장에만 있는 규칙을 그리지 못한 것으로 센다.
    const extOnly = extIds.filter((id) => !id || !ids.has(id)).length;
    if (!blocks.length && !extOnly) return null;
    return { blocks, extOnly: ext ? extOnly : 0 };
  }

  function readXlsx(XLSX, wb) {
    const files = wb.files;
    if (!files) return null;
    const theme = themeList(wb);
    const st = wb.Styles || {};
    const fonts = (st.Fonts || []).map((f) => ({
      b: !!f.bold, i: !!f.italic, u: !!f.underline, s: !!f.strike,
      sz: Number(f.sz) || 0, color: objColor(f.color, theme), serif: SERIF.test(f.name || ''),
    }));
    const stylesXml = partText(files, 'xl/styles.xml');
    const borders = xlsxBorders(stylesXml, theme);
    const xfs = (st.CellXf || []).map((x) => {
      const a = x.alignment || {};
      return {
        f: Number(x.fontId) || 0,
        h: a.horizontal && a.horizontal !== 'general' ? a.horizontal : null,
        v: a.vertical || 'bottom',
        wrap: !!a.wrapText && a.wrapText !== '0' && a.wrapText !== 'false',
        indent: Number(a.indent) || 0,
        rot: Number(a.textRotation) || 0,
        shrink: !!a.shrinkToFit && a.shrinkToFit !== '0' && a.shrinkToFit !== 'false',
        bd: borders[Number(x.borderId) || 0] || {},
      };
    });
    const out = { fonts, xfs, sheets: {}, dxfs: xlsxDxfs(stylesXml, theme) };
    const f0 = (st.Fonts || [])[0] || {};
    const mdw = mdwFor(f0.name, f0.sz);
    const wbPart = 'xl/workbook.xml';
    const rels = relsOf(files, wbPart);
    const meta = (wb.Workbook && wb.Workbook.Sheets) || [];
    wb.SheetNames.forEach((name, i) => {
      const rel = rels.get(meta[i] && meta[i].id);
      const ws = wb.Sheets[name];
      if (!rel || !ws) return;
      const xml = partText(files, rel.target);
      out.sheets[name] = xlsxSheet(XLSX, ws, xml, theme, mdw);
      out.sheets[name].part = rel.target;
    });
    return out;
  }

  function xlsxSheet(XLSX, ws, xml, theme, mdw = 7) {
    const info = { grid: true, freeze: null, defCol: baseWidthPx(8, mdw), defRow: 20, cols: [], rows: [], widths: false };
    const head = xml.slice(0, Math.min(xml.length, (xml.search(/<(?:\w+:)?sheetData\b/) + 1 || 4000) + 200));
    const view = /<(?:\w+:)?sheetView\b([^>]*)>/.exec(head);
    if (view && (attr(view[1], 'showGridLines') === '0' || attr(view[1], 'showGridLines') === 'false')) info.grid = false;
    const pane = /<(?:\w+:)?pane\b([^>]*)\/?>/.exec(head);
    if (pane && /frozen/i.test(attr(pane[1], 'state') || '')) {
      const r = Math.round(Number(attr(pane[1], 'ySplit') || 0));
      const c = Math.round(Number(attr(pane[1], 'xSplit') || 0));
      if (r > 0 || c > 0) info.freeze = { r, c };
    }
    const fmt = /<(?:\w+:)?sheetFormatPr\b([^>]*)\/?>/.exec(head);
    if (fmt) {
      const dc = Number(attr(fmt[1], 'defaultColWidth'));
      const bc = Number(attr(fmt[1], 'baseColWidth'));
      if (dc) info.defCol = widthPx(dc, mdw);
      else if (bc) info.defCol = baseWidthPx(bc, mdw);
      const dr = Number(attr(fmt[1], 'defaultRowHeight'));
      if (dr) info.defRow = ptPx(dr);
    }
    (ws['!cols'] || []).forEach((c, i) => {
      if (!c) return;
      const px = c.width != null ? widthPx(Number(c.width), mdw) : null;
      if (px != null) info.widths = true;
      info.cols[i] = { px, hidden: !!c.hidden };
    });
    (ws['!rows'] || []).forEach((r, i) => {
      if (!r || i >= MAX_ROWS) return;
      info.rows[i] = { px: r.hpt != null ? ptPx(Number(r.hpt)) : null, hidden: !!r.hidden };
    });
    // 엔진은 화면에 그릴 행까지만 읽어 전체 크기를 모를 수 있다. 마지막 행 번호를 뒤에서부터 찾아 둔다(잘렸다고 알릴 때 쓴다).
    const lastRowAt = Math.max(xml.lastIndexOf('<row '), xml.lastIndexOf(':row '));
    if (lastRowAt >= 0) {
      const lr = /\br="(\d+)"/.exec(xml.slice(lastRowAt, lastRowAt + 200));
      if (lr) info.lastRow = Number(lr[1]) - 1;
    }
    const cf = xlsxConditional(xml, theme);
    if (cf) info.cf = cf;
    // 칸마다 서식 번호(s)를 붙인다. 행 순서로 저장되므로 화면에 그릴 행을 넘으면 그만 읽는다.
    const start = xml.search(/<(?:\w+:)?sheetData\b/);
    if (start < 0) return info;
    const re = /<(?:\w+:)?c\s([^>]*?)\/?>/g;
    re.lastIndex = start;
    for (let m; (m = re.exec(xml));) {
      const a = m[1];
      const ref = /\br="([A-Z]+)(\d+)"/.exec(a);
      if (!ref) continue;
      if (Number(ref[2]) > MAX_ROWS) break;
      const s = /\bs="(\d+)"/.exec(a);
      if (!s || s[1] === '0') continue;
      const addr = ref[1] + ref[2];
      const cell = ws[addr];
      if (cell) cell.xf = Number(s[1]);
      else ws[addr] = { t: 'z', xf: Number(s[1]) };
    }
    return info;
  }

  // ---------------------------------------------------------------- xls (BIFF8)

  function readXls(XLSX, wb) {
    const cfb = wb.cfb;
    if (!cfb || !Array.isArray(cfb.FullPaths)) return null; // BIFF2~4(OLE 컨테이너가 아닌 옛 xls)
    const entry = XLSX.CFB.find(cfb, 'Workbook');
    if (!entry || !entry.content) return null; // BIFF5(Book)는 서식 기록 모양이 달라 건너뛴다
    const d = entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
    const u16 = (p) => d[p] | (d[p + 1] << 8);
    const u32 = (p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
    const palette = PALETTE.slice();
    const fontsRaw = [];
    // 기본 글꼴(FONT 0)은 시트 기록보다 앞에 있으므로 시트를 읽을 때는 이미 알고 있다.
    let mdwCache = 0;
    const xlsMdw = () => mdwCache || (fontsRaw.length ? (mdwCache = mdwFor(fontsRaw[0].name, fontsRaw[0].sz)) : 7);
    const xfsRaw = [];
    const names = new Map(); // BOF 위치 → 시트 이름
    const sheets = {};
    let cur = null;
    let depth = 0; // 시트 안에 끼어 있는 차트 등 하위 흐름
    const setXf = (r, c, ixfe) => {
      if (!cur || r >= MAX_ROWS) return;
      const ws = wb.Sheets[cur.name];
      if (!ws) return;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell) cell.xf = ixfe;
      else if (ixfe) ws[addr] = { t: 'z', xf: ixfe };
    };
    for (let p = 0; p + 4 <= d.length;) {
      const type = u16(p);
      const len = u16(p + 2);
      const b = p + 4;
      if (b + len > d.length) break;
      if (type === 0x0809) { // BOF
        if (names.has(p)) {
          cur = { name: names.get(p), grid: true, freeze: null, defCol: baseWidthPx(8, xlsMdw()), defRow: 17, cols: [], rows: [], widths: false, charts: 0, shapes: 0, notes: 0, controls: 0 };
          sheets[cur.name] = cur;
          depth = 0;
        } else if (cur) {
          depth++;
        }
      } else if (type === 0x000a) { // EOF
        if (depth > 0) depth--;
        else cur = null;
      } else if (depth > 0) {
        // 끼어 있는 차트 흐름의 기록은 건너뛴다
      } else if (type === 0x0031 && len >= 14) { // FONT
        const nameLen = d[b + 14];
        const wide = d[b + 15] & 1;
        const nameBytes = d.subarray(b + 16, b + 16 + nameLen * (wide ? 2 : 1));
        const fname = wide ? new TextDecoder('utf-16le').decode(nameBytes) : String.fromCharCode(...nameBytes);
        fontsRaw.push({ sz: u16(b) / 20, grbit: u16(b + 2), icv: u16(b + 4), bls: u16(b + 6), uls: d[b + 10], name: fname });
      } else if (type === 0x00e0 && len >= 20) { // XF
        xfsRaw.push({ ifnt: u16(b), al: d[b + 6], trot: d[b + 7], ind: d[b + 8], b1: u32(b + 10), b2: u32(b + 14) });
      } else if (type === 0x0092 && len >= 2) { // PALETTE: 색 번호 8부터 바꾼다
        const n = u16(b);
        for (let i = 0; i < n && 8 + i < 64; i++) {
          const q = b + 2 + i * 4;
          palette[8 + i] = [d[q], d[q + 1], d[q + 2]].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
        }
      } else if (type === 0x0085 && len >= 8) { // BoundSheet8
        const cch = d[b + 6];
        const wide = d[b + 7] & 1;
        const nb = d.subarray(b + 8, b + 8 + cch * (wide ? 2 : 1));
        names.set(u32(b), wide ? new TextDecoder('utf-16le').decode(nb) : String.fromCharCode(...nb));
      } else if (cur) {
        if (type === 0x023e && len >= 2) { // WINDOW2
          const g = u16(b);
          cur.grid = !!(g & 0x0002);
          cur.frozen = !!(g & 0x0008);
        } else if (type === 0x0041 && len >= 4) { // PANE
          if (cur.frozen) {
            const c = u16(b);
            const r = u16(b + 2);
            if (r > 0 || c > 0) cur.freeze = { r, c };
          }
        } else if (type === 0x01b1) { // CF: 조건부 서식 규칙(옛 xls는 그리지 않고 개수만 알린다)
          cur.cfRules = (cur.cfRules || 0) + 1;
        } else if (type === 0x0200 && len >= 10) { // DIMENSIONS: 실제 쓰인 범위(마지막 행+1, 마지막 열+1)
          const rwMac = u32(b + 4);
          const colMac = u16(b + 10);
          if (rwMac > 0) cur.lastRow = rwMac - 1;
          if (colMac > 0) cur.lastCol = colMac - 1;
        } else if (type === 0x0055 && len >= 2) { // DEFCOLWIDTH(글자 수)
          cur.defCol = baseWidthPx(u16(b), xlsMdw());
        } else if (type === 0x0225 && len >= 4) { // DEFAULTROWHEIGHT(1/20pt)
          const h = u16(b + 2);
          if (h) cur.defRow = ptPx(h / 20);
        } else if (type === 0x007d && len >= 10) { // COLINFO
          const px = widthPx(u16(b + 4) / 256, xlsMdw());
          const hidden = !!(u16(b + 8) & 1);
          for (let c = u16(b); c <= u16(b + 2) && c < 16384; c++) {
            cur.cols[c] = { px, hidden };
            if (c > 255) break;
          }
          cur.widths = true;
        } else if (type === 0x0208 && len >= 16) { // ROW
          const r = u16(b);
          if (r < MAX_ROWS) {
            const h = u16(b + 6);
            const g = u16(b + 12);
            cur.rows[r] = { px: (h & 0x8000) ? null : ptPx((h & 0x7fff) / 20), hidden: !!(g & 0x0020) };
          }
        } else if (type === 0x005d && len >= 6 && u16(b) === 0x15) { // OBJ: 첫 조각(ftCmo)의 종류
          const ot = u16(b + 4);
          if (ot === 5) cur.charts++;
          else if (ot === 0x19) cur.notes++;
          else if ([1, 2, 3, 4, 6, 9, 0x1e].includes(ot)) cur.shapes++;
          else if ([7, 0x0b, 0x0c, 0x0d, 0x0e, 0x10, 0x11, 0x12, 0x14].includes(ot)) cur.controls++;
        } else if (len >= 6 && (type === 0x0201 || type === 0x0203 || type === 0x0204 || type === 0x0205
          || type === 0x027e || type === 0x00fd || type === 0x0006 || type === 0x00d6)) {
          setXf(u16(b), u16(b + 2), u16(b + 4));
        } else if (type === 0x00bd && len >= 6) { // MULRK: (ixfe, RK) 반복
          const r = u16(b);
          const c0 = u16(b + 2);
          const n = (len - 6) / 6;
          for (let i = 0; i < n; i++) setXf(r, c0 + i, u16(b + 4 + i * 6));
        } else if (type === 0x00be && len >= 6) { // MULBLANK: ixfe 반복
          const r = u16(b);
          const c0 = u16(b + 2);
          const n = (len - 6) / 2;
          for (let i = 0; i < n; i++) setXf(r, c0 + i, u16(b + 4 + i * 2));
        }
      }
      p = b + len;
    }
    const color = (icv) => (icv < 64 ? `#${palette[icv]}` : null);
    // 글꼴 번호 4는 없다(4보다 큰 번호는 하나씩 당겨 읽는다).
    const fonts = fontsRaw.map((f) => ({
      b: f.bls >= 700, i: !!(f.grbit & 0x02), u: f.uls === 1 || f.uls === 2 || f.uls === 0x21 || f.uls === 0x22,
      s: !!(f.grbit & 0x08), sz: f.sz, color: f.icv === 0x7fff || f.icv >= 64 ? null : color(f.icv), serif: SERIF.test(f.name),
    }));
    const xfs = xfsRaw.map((x) => {
      const side = (dg, icv) => (dg ? [LINE[dg] || 'thin', icv >= 64 ? null : color(icv)] : null);
      const bd = {};
      const l = side(x.b1 & 0xf, (x.b1 >>> 16) & 0x7f);
      const r = side((x.b1 >>> 4) & 0xf, (x.b1 >>> 23) & 0x7f);
      const t = side((x.b1 >>> 8) & 0xf, x.b2 & 0x7f);
      const bt = side((x.b1 >>> 12) & 0xf, (x.b2 >>> 7) & 0x7f);
      if (l) bd.l = l;
      if (r) bd.r = r;
      if (t) bd.t = t;
      if (bt) bd.b = bt;
      return {
        f: x.ifnt >= 4 ? x.ifnt - 1 : x.ifnt,
        h: H_ALIGN[x.al & 7] || null,
        v: V_ALIGN[(x.al >> 4) & 7] || 'bottom',
        wrap: !!(x.al & 0x08),
        indent: x.ind & 0x0f,
        rot: x.trot,
        shrink: !!(x.ind & 0x10),
        bd,
      };
    });
    for (const sh of Object.values(sheets)) delete sh.frozen;
    return { fonts, xfs, sheets };
  }

  // SheetJS가 읽은 통합 문서에 칸 서식 번호(cell.xf)를 붙이고, 서식 목록·시트 보기 설정을 돌려준다.
  // 원본 조각(wb.files·wb.cfb)은 그림·차트를 읽을 때 다시 쓰므로 그대로 둔다.
  // 파일에 적힌 시트 크기(xlsx <dimension>, xls DIMENSIONS)가 실제보다 작으면 엔진은 칸을 다 읽고도 범위를 그만큼으로 잘라
  // 보여 준다(웹 시스템이 만든 파일에서 열·행이 조용히 사라짐). 읽힌 칸으로 범위를 다시 잡는다.
  function fixRanges(XLSX, wb) {
    for (const name of wb.SheetNames || []) {
      const ws = wb.Sheets[name];
      if (!ws || Array.isArray(ws['!data'])) continue;
      let r0 = Infinity;
      let c0 = Infinity;
      let r1 = -1;
      let c1 = -1;
      for (const k of Object.keys(ws)) {
        if (k[0] === '!') continue;
        const a = XLSX.utils.decode_cell(k);
        if (a.r < 0 || a.c < 0) continue;
        if (a.r < r0) r0 = a.r;
        if (a.c < c0) c0 = a.c;
        if (a.r > r1) r1 = a.r;
        if (a.c > c1) c1 = a.c;
      }
      if (r1 < 0) continue;
      const cur = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
      if (cur && r1 <= cur.e.r && c1 <= cur.e.c && r0 >= cur.s.r && c0 >= cur.s.c) continue;
      const s = cur ? { r: Math.min(r0, cur.s.r), c: Math.min(c0, cur.s.c) } : { r: r0, c: c0 };
      const e = cur ? { r: Math.max(r1, cur.e.r), c: Math.max(c1, cur.e.c) } : { r: r1, c: c1 };
      ws['!ref'] = XLSX.utils.encode_range({ s, e });
      if (ws['!fullref']) {
        const f = XLSX.utils.decode_range(ws['!fullref']);
        ws['!fullref'] = XLSX.utils.encode_range({ s: { r: Math.min(f.s.r, s.r), c: Math.min(f.s.c, s.c) }, e: { r: Math.max(f.e.r, e.r), c: Math.max(f.e.c, e.c) } });
      }
    }
  }

  function read(XLSX, wb) {
    try {
      fixRanges(XLSX, wb);
    } catch (e) {
      if (root.console) root.console.warn('시트 범위를 다시 잡지 못함', e);
    }
    try {
      if (wb.files) return readXlsx(XLSX, wb);
      if (wb.cfb) return readXls(XLSX, wb);
    } catch (e) {
      if (root.console) root.console.warn('엑셀 서식을 읽지 못함', e);
    }
    return null;
  }

  root.SheetFormat = { read, applyTint, PALETTE };
})(typeof self !== 'undefined' ? self : this);
