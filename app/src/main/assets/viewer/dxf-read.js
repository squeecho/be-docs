// 글자 DXF 읽기. LibreDWG의 DXF 읽기는 개체 수의 제곱으로 느려져(2만 개 3.8초, 10만 개 112초 — 데스크톱에서)
// 흔히 쓰는 개체는 여기서 직접 읽는다. 결과는 LibreDWG(convert)와 같은 모양이라 cad-worker.js의 그리기 목록 만들기를 그대로 쓴다.
// 이진 DXF는 다루지 않는다(null을 돌려주면 LibreDWG로 읽는다).
// readDxf(bytes: Uint8Array) → { tables: { BLOCK_RECORD, LAYER }, entities } | null

const DEG = Math.PI / 180;
// 선 두께 값(1/100mm) → DWG 번호(cad-worker.js의 LW 표와 같은 순서)
const LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const CODEPAGES = {
  ANSI_949: 'euc-kr', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_950: 'big5', ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_874: 'windows-874',
};

export function readDxf(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 22));
  if (head.startsWith('AutoCAD Binary DXF')) return null;
  const text = decode(bytes);
  const lines = text.split(/\r?\n/);
  const n = Math.floor(lines.length / 2);
  const codes = new Int32Array(n);
  const vals = new Array(n);
  let m = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i], 10);
    if (Number.isNaN(c)) continue;
    codes[m] = c;
    vals[m] = lines[i + 1];
    m++;
  }

  const layers = [];
  const blocks = [];
  const model = [];
  const paperSpace = [];
  let i = 0;

  const num = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : 0;
  };
  const str = (v) => (v == null ? '' : String(v).replace(/\s+$/, ''));

  // 0번 코드(다음 개체)가 나올 때까지의 [코드, 값] 목록
  const record = () => {
    const out = [];
    i++;
    while (i < m && codes[i] !== 0) {
      out.push(codes[i], vals[i]);
      i++;
    }
    return out;
  };

  // 개체 목록 읽기(ENDSEC·ENDBLK 전까지). POLYLINE 뒤의 VERTEX, INSERT 뒤의 ATTRIB는 SEQEND까지 묶는다.
  const readEntities = (into, stop) => {
    while (i < m) {
      if (codes[i] !== 0) {
        i++;
        continue;
      }
      const type = str(vals[i]);
      if (type === stop || type === 'ENDSEC' || type === 'EOF') return;
      const rec = record();
      const e = entity(type, rec);
      if (type === 'POLYLINE') {
        const verts = [];
        while (i < m && codes[i] === 0 && str(vals[i]) === 'VERTEX') verts.push(vertex(record()));
        if (i < m && codes[i] === 0 && str(vals[i]) === 'SEQEND') record();
        if (e) e.vertices = verts;
      } else if (type === 'INSERT' && e && get(rec, 66) === '1') {
        while (i < m && codes[i] === 0 && str(vals[i]) === 'ATTRIB') {
          const a = entity('ATTRIB', record());
          if (a) e.attribs.push(a);
        }
        if (i < m && codes[i] === 0 && str(vals[i]) === 'SEQEND') record();
      }
      if (!e) continue;
      if (into === model && get(rec, 67) === '1') paperSpace.push(e);
      else into.push(e);
    }
  };

  while (i < m) {
    if (codes[i] === 0 && str(vals[i]) === 'SECTION') {
      i++;
      const name = codes[i] === 2 ? str(vals[i]) : '';
      i++;
      if (name === 'TABLES') readTables();
      else if (name === 'BLOCKS') readBlocks();
      else if (name === 'ENTITIES') readEntities(model, 'ENDSEC');
      else skipSection();
      continue;
    }
    i++;
  }

  function skipSection() {
    while (i < m && !(codes[i] === 0 && str(vals[i]) === 'ENDSEC')) i++;
  }

  function readTables() {
    while (i < m) {
      if (codes[i] !== 0) {
        i++;
        continue;
      }
      const t = str(vals[i]);
      if (t === 'ENDSEC') return;
      if (t === 'LAYER') {
        const rec = record();
        const color = num(get(rec, 62, '7'));
        const lw = get(rec, 370);
        layers.push({
          name: str(get(rec, 2, '0')),
          colorIndex: Math.abs(color) || 7,
          off: color < 0,
          frozen: (num(get(rec, 70, '0')) & 1) === 1,
          lineweight: lw == null ? 31 : lwIndex(num(lw)),
        });
        continue;
      }
      i++;
    }
  }

  function readBlocks() {
    while (i < m) {
      if (codes[i] !== 0) {
        i++;
        continue;
      }
      const t = str(vals[i]);
      if (t === 'ENDSEC') return;
      if (t === 'BLOCK') {
        const rec = record();
        const b = { name: str(get(rec, 2, '')), basePoint: { x: num(get(rec, 10, '0')), y: num(get(rec, 20, '0')) }, entities: [] };
        readEntities(b.entities, 'ENDBLK');
        if (i < m && str(vals[i]) === 'ENDBLK') record();
        blocks.push(b);
        continue;
      }
      i++;
    }
  }

  const entries = blocks.filter((b) => !/^\*(model|paper)_space/i.test(b.name));
  entries.push({ name: '*Model_Space', basePoint: { x: 0, y: 0 }, entities: model });
  entries.push({ name: '*Paper_Space', basePoint: { x: 0, y: 0 }, entities: paperSpace });
  return { tables: { BLOCK_RECORD: { entries }, LAYER: { entries: layers } }, entities: model };
}

// 2007 이전 DXF는 도면의 코드 페이지(한국어 ANSI_949 등)로, 그 뒤는 UTF-8로 저장된다.
function decode(bytes) {
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(probe);
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(probe);
  const old = ver ? ver[1] < 'AC1021' : false;
  const enc = old && cp ? CODEPAGES[cp[1].toUpperCase()] : null;
  if (enc) {
    try {
      return new TextDecoder(enc).decode(bytes);
    } catch (_) {
      // 그 코드 페이지를 모르면 UTF-8로 읽는다
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function lwIndex(v) {
  if (v === -1) return 29;
  if (v === -2) return 30;
  if (v < 0) return 31;
  let best = 0;
  for (let k = 0; k < LW.length; k++) if (Math.abs(LW[k] - v) < Math.abs(LW[best] - v)) best = k;
  return best;
}

function get(rec, code, def) {
  for (let k = 0; k < rec.length; k += 2) if (rec[k] === code) return rec[k + 1];
  return def;
}

function f(rec, code, def = 0) {
  const v = get(rec, code);
  if (v == null) return def;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : def;
}

function pt(rec, cx, cy) {
  return { x: f(rec, cx), y: f(rec, cy) };
}

function common(type, rec) {
  const lw = get(rec, 370);
  return {
    type,
    layer: String(get(rec, 8, '0')).trim(),
    colorIndex: get(rec, 62) == null ? 256 : f(rec, 62),
    lineweight: lw == null ? 29 : lwIndex(parseFloat(lw)),
    isVisible: f(rec, 60) !== 1,
    extrusionDirection: { x: f(rec, 210), y: f(rec, 220), z: f(rec, 230, 1) },
  };
}

function vertex(rec) {
  return { x: f(rec, 10), y: f(rec, 20), bulge: f(rec, 42), flag: f(rec, 70) };
}

function textOf(rec) {
  // MTEXT는 긴 글을 3번 코드 여러 개로 나누고 마지막을 1번 코드에 둔다
  let s = '';
  for (let k = 0; k < rec.length; k += 2) if (rec[k] === 3) s += rec[k + 1];
  return s + (get(rec, 1, '') || '');
}

function entity(type, rec) {
  const e = common(type, rec);
  switch (type) {
    case 'LINE':
      return { ...e, startPoint: pt(rec, 10, 20), endPoint: pt(rec, 11, 21) };
    case 'LWPOLYLINE': {
      const verts = [];
      for (let k = 0; k < rec.length; k += 2) {
        const c = rec[k];
        const v = parseFloat(rec[k + 1]);
        if (c === 10) verts.push({ x: v, y: 0, bulge: 0 });
        else if (c === 20 && verts.length) verts[verts.length - 1].y = v;
        else if (c === 42 && verts.length) verts[verts.length - 1].bulge = v;
      }
      // 닫힘 표시를 DWG(LibreDWG)와 같은 512로
      return { ...e, flag: f(rec, 70) & 1 ? 512 : 0, vertices: verts };
    }
    case 'POLYLINE': {
      const flag = f(rec, 70);
      // 다각형 메시·면 메시는 3D라 그리지 않는다
      if (flag & (16 | 64)) return { ...e, type: 'POLYFACE' };
      return { ...e, type: flag & 8 ? 'POLYLINE3D' : 'POLYLINE2D', flag, vertices: [] };
    }
    case 'CIRCLE':
      return { ...e, center: pt(rec, 10, 20), radius: f(rec, 40) };
    case 'ARC':
      return { ...e, center: pt(rec, 10, 20), radius: f(rec, 40), startAngle: f(rec, 50) * DEG, endAngle: f(rec, 51) * DEG };
    case 'ELLIPSE':
      return {
        ...e, center: pt(rec, 10, 20), majorAxisEndPoint: pt(rec, 11, 21), axisRatio: f(rec, 40, 1),
        startAngle: f(rec, 41), endAngle: f(rec, 42, Math.PI * 2),
      };
    case 'SPLINE': {
      const knots = [];
      const cps = [];
      const fit = [];
      const weights = [];
      for (let k = 0; k < rec.length; k += 2) {
        const c = rec[k];
        const v = parseFloat(rec[k + 1]);
        if (c === 40) knots.push(v);
        else if (c === 41) weights.push(v);
        else if (c === 10) cps.push({ x: v, y: 0 });
        else if (c === 20 && cps.length) cps[cps.length - 1].y = v;
        else if (c === 11) fit.push({ x: v, y: 0 });
        else if (c === 21 && fit.length) fit[fit.length - 1].y = v;
      }
      weights.forEach((w, k) => { if (cps[k]) cps[k].w = w; });
      return { ...e, flag: f(rec, 70), degree: f(rec, 71, 3), knots, controlPoints: cps, fitPoints: fit };
    }
    case 'TEXT':
      return {
        ...e, text: get(rec, 1, ''), startPoint: pt(rec, 10, 20), endPoint: pt(rec, 11, 21), textHeight: f(rec, 40, 1),
        rotation: f(rec, 50) * DEG, xScale: f(rec, 41, 1), halign: f(rec, 72), valign: f(rec, 73),
      };
    case 'ATTRIB':
      // 숨긴 속성(70번 1비트)은 그리지 않는다
      if (f(rec, 70) & 1) return null;
      return {
        ...e, text: {
          text: get(rec, 1, ''), startPoint: pt(rec, 10, 20), endPoint: pt(rec, 11, 21), textHeight: f(rec, 40, 1),
          rotation: f(rec, 50) * DEG, xScale: f(rec, 41, 1), halign: f(rec, 72), valign: f(rec, 74),
        },
      };
    case 'MTEXT': {
      const dir = get(rec, 11) != null ? pt(rec, 11, 21) : null;
      return {
        ...e, text: textOf(rec), insertionPoint: pt(rec, 10, 20), textHeight: f(rec, 40, 1), rectWidth: f(rec, 41),
        attachmentPoint: f(rec, 71, 1), rotation: f(rec, 50) * DEG, direction: dir,
      };
    }
    case 'INSERT':
      return {
        ...e, name: String(get(rec, 2, '')).trim(), insertionPoint: pt(rec, 10, 20), xScale: f(rec, 41, 1), yScale: f(rec, 42, 1),
        rotation: f(rec, 50) * DEG, columnCount: f(rec, 70, 1), rowCount: f(rec, 71, 1), columnSpacing: f(rec, 44), rowSpacing: f(rec, 45),
        attribs: [],
      };
    case 'DIMENSION':
    case 'ARC_DIMENSION':
    case 'LARGE_RADIAL_DIMENSION':
      return {
        ...e, name: String(get(rec, 2, '')).trim(), textPoint: pt(rec, 11, 21), measurement: f(rec, 42),
        text: get(rec, 1, ''), textRotation: f(rec, 53) * DEG,
      };
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      return { ...e, corner1: pt(rec, 10, 20), corner2: pt(rec, 11, 21), corner3: pt(rec, 12, 22), corner4: pt(rec, 13, 23) };
    case 'LEADER': {
      const verts = [];
      for (let k = 0; k < rec.length; k += 2) {
        if (rec[k] === 10) verts.push({ x: parseFloat(rec[k + 1]), y: 0 });
        else if (rec[k] === 20 && verts.length) verts[verts.length - 1].y = parseFloat(rec[k + 1]);
      }
      return { ...e, vertices: verts };
    }
    case 'HATCH':
      return { ...e, ...hatch(rec) };
    case 'SEQEND':
    case 'VERTEX':
      return null;
    default:
      return e; // 그리지 못하는 개체도 넘겨 수를 센다(cad-worker.js가 알린다)
  }
}

// 해치 경계: 91 경로 수, 경로마다 92 종류(2비트면 폴리선: 72 볼록 여부, 73 닫힘, 93 점 수, 10·20·42),
// 아니면 93 모서리 수, 모서리마다 72 종류(1 선, 2 원호, 3 타원호, 4 스플라인)
function hatch(rec) {
  let k = 0;
  const at = (code) => {
    while (k < rec.length && rec[k] !== code) k += 2;
    return k < rec.length;
  };
  const next = () => {
    const v = parseFloat(rec[k + 1]);
    k += 2;
    return v;
  };
  const read = (code) => (at(code) ? next() : 0);
  const solidFill = f(rec, 70);
  const patternName = String(get(rec, 2, '')).trim();
  const paths = [];
  if (!at(91)) return { solidFill, patternName, boundaryPaths: paths };
  const count = next();
  for (let p = 0; p < count && k < rec.length; p++) {
    const flags = read(92);
    if (flags & 2) {
      const hasBulge = read(72);
      read(73);
      const nv = read(93);
      const vertices = [];
      for (let v = 0; v < nv && k < rec.length; v++) {
        const x = read(10);
        const y = read(20);
        let bulge = 0;
        if (hasBulge && rec[k] === 42) bulge = next();
        vertices.push({ x, y, bulge });
      }
      paths.push({ vertices });
    } else {
      const ne = read(93);
      const edges = [];
      for (let q = 0; q < ne && k < rec.length; q++) {
        const type = read(72);
        if (type === 1) {
          edges.push({ type, start: { x: read(10), y: read(20) }, end: { x: read(11), y: read(21) } });
        } else if (type === 2) {
          const center = { x: read(10), y: read(20) };
          const radius = read(40);
          const s = read(50) * DEG;
          const en = read(51) * DEG;
          edges.push({ type, center, radius, startAngle: s, endAngle: en, isCCW: read(73) === 1 });
        } else if (type === 3) {
          const center = { x: read(10), y: read(20) };
          const end = { x: read(11), y: read(21) };
          const ratio = read(40);
          const s = read(50) * DEG;
          const en = read(51) * DEG;
          edges.push({ type, center, end, axisRatio: ratio, startAngle: s, endAngle: en, isCCW: read(73) === 1 });
        } else if (type === 4) {
          const degree = read(94);
          read(73);
          read(74);
          const nk = read(95);
          const nc = read(96);
          const knots = [];
          for (let j = 0; j < nk; j++) knots.push(read(40));
          const controlPoints = [];
          for (let j = 0; j < nc; j++) {
            const cp = { x: read(10), y: read(20) };
            if (rec[k] === 42) cp.w = next();
            controlPoints.push(cp);
          }
          edges.push({ type, degree, knots, controlPoints, fitPoints: [] });
        } else break;
      }
      paths.push({ edges });
    }
    // 이 경로의 원본 개체 참조(97 수, 330 × 수)를 건너뛴다
    if (rec[k] === 97) {
      const refs = next();
      for (let r = 0; r < refs && rec[k] === 330; r++) k += 2;
    }
  }
  return { solidFill, patternName, boundaryPaths: paths };
}
