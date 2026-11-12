// CAD 도면(DWG·DXF)을 읽어 화면이 바로 그릴 수 있는 목록으로 바꾸는 작업 스레드.
// 해석은 LibreDWG(GPL-3.0, vendor/libredwg/)가 하고, 여기서는 모형 공간(Model Space)의 개체를 블록·치수까지 풀어
// 선(polyline)·채움(fill)·글자(text) 세 가지로 만든다. 큰 도면도 화면 스레드가 멈추지 않게 이 스레드에서 한다.
// 받는 것: { bytes: Uint8Array, dxf: boolean }  보내는 것: { ok, ... } 또는 { ok: false, error }
// 글자 DXF는 dxf-read.js가 직접 읽고(LibreDWG의 DXF 읽기는 큰 도면에서 매우 느리다), 못 읽을 때만 LibreDWG로 읽는다.
import { readDxf } from './dxf-read.js';

const MAX_POINTS = 6_000_000; // 넘으면 그만 그리고 알린다(휴대폰 메모리)
const MAX_DEPTH = 12; // 블록 안의 블록 깊이
const ARC_STEP = Math.PI / 36; // 원·호를 나누는 각도(5도)

// AutoCAD 색 번호(ACI) → RGB. 1~9는 정해진 색, 10~249는 24가지 색상 × 밝기·채도 10단계, 250~255는 회색.
const ACI = (() => {
  const t = new Array(256).fill(0);
  const fixed = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0x000000, 0x808080, 0xc0c0c0];
  for (let i = 0; i < 10; i++) t[i] = fixed[i];
  const vals = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15];
  for (let i = 10; i < 250; i++) {
    const h = Math.floor((i - 10) / 10) * 15;
    const k = (i - 10) % 10;
    const s = k % 2 ? 0.5 : 1;
    const v = vals[k];
    const f = (n) => {
      const kk = (n + h / 60) % 6;
      return Math.round(255 * (v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1))));
    };
    t[i] = (f(5) << 16) | (f(3) << 8) | f(1);
  }
  [0x333333, 0x5b5b5b, 0x848484, 0xadadad, 0xd6d6d6, 0xffffff].forEach((c, j) => { t[250 + j] = c; });
  t[7] = 0xffffff; // 7번은 바탕의 반대색(어두운 바탕에서 흰색)
  return t;
})();

// 색은 AutoCAD 그대로(어두운 바탕 기준) 보낸다. 흰 바탕으로 볼 때의 색 바꾸기는 화면(cad-view.js)이 한다.
const paper = (rgb) => rgb;

let lib = null;
let dwgFileType = null;

self.onmessage = async (event) => {
  const { bytes, dxf } = event.data || {};
  try {
    if (dxf) {
      let own = null;
      try {
        own = readDxf(bytes);
      } catch (e) {
        own = null;
      }
      if (own && (own.entities.length || own.tables.BLOCK_RECORD.entries.some((b) => b.entities.length))) {
        const out = build(own);
        out.reader = 'dxf-read';
        self.postMessage(out, [out.pts.buffer, out.strokes.buffer, out.boxes.buffer, out.fillPts.buffer, out.fillRings.buffer]);
        return;
      }
    }
    if (!lib) {
      const mod = await import('./vendor/libredwg/dist/libredwg-web.js');
      dwgFileType = mod.Dwg_File_Type;
      lib = await mod.LibreDwg.create(new URL('./vendor/libredwg/wasm', import.meta.url).href);
    }
    const Dwg_File_Type = dwgFileType;
    const data = lib.dwg_read_data(bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer,
      dxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG);
    if (data == null) throw new Error('read failed');
    let db;
    try {
      db = lib.convert(data);
    } finally {
      try {
        lib.dwg_free(data);
      } catch (_) {
        // 메모리 정리 실패는 결과에 영향이 없다(스레드를 곧 끝낸다).
      }
    }
    const out = build(db);
    out.reader = 'libredwg';
    self.postMessage(out, [out.pts.buffer, out.strokes.buffer, out.boxes.buffer, out.fillPts.buffer, out.fillRings.buffer]);
  } catch (e) {
    self.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
};

function build(db) {
  const blocks = new Map();
  for (const b of (db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || []) blocks.set(b.name, b);
  const layers = new Map();
  for (const l of (db.tables && db.tables.LAYER && db.tables.LAYER.entries) || []) layers.set(l.name, l);

  // 모형 공간이 비어 있으면 배치(종이 공간)를 그린다.
  const model = blocks.get('*Model_Space') || blocks.get('*MODEL_SPACE');
  let top = (model && model.entities && model.entities.length ? model.entities : null) || db.entities || [];
  let space = 'model';
  const paperBlock = blocks.get('*Paper_Space') || blocks.get('*PAPER_SPACE');
  const paperCount = paperBlock && paperBlock.entities ? paperBlock.entities.filter((e) => e.type !== 'VIEWPORT').length : 0;
  if (!countDrawable(top) && paperCount) {
    top = paperBlock.entities;
    space = 'paper';
  }

  const pts = []; // 선의 점(x, y …)
  const strokes = []; // 선마다 [첫 점 번호, 점 수, 색, 두께 단계]
  const fillPts = [];
  const fillRings = []; // 채움마다 [첫 고리 점 번호, 점 수, 색, 고리 수(이 채움에 속한 고리), 진하기(0~255)]
  const texts = []; // [글, x, y, 높이, 회전, 색, 가로 정렬(0 왼 1 가운데 2 오른), 세로 정렬(0 기준선 1 아래 2 가운데 3 위), 너비 비율, 줄 바꿈 폭]
  const skipped = {}; // 그리지 못한 개체 수(종류별)
  let truncated = false;
  let entities = 0;

  const skip = (type) => { skipped[type] = (skipped[type] || 0) + 1; };

  const layerOf = (e, inherited) => {
    const name = e.layer === '0' && inherited ? inherited : e.layer;
    return { name, info: layers.get(name) };
  };

  // 색: 256 = 도면층 색, 0 = 블록 색(블록을 넣은 개체의 색), 그 밖의 번호는 그 색
  const colorOf = (e, layer, blockColor) => {
    const ci = e.colorIndex;
    if (ci === 0) return blockColor;
    if (ci === 256 || ci == null || ci < 0) {
      const lc = layer.info ? Math.abs(layer.info.colorIndex) : 7;
      return paper(ACI[lc] != null ? ACI[lc] : 0);
    }
    return paper(ACI[ci] != null ? ACI[ci] : 0);
  };

  // 선 두께. DWG에는 번호(0~23 = 0~2.11mm, 29 도면층 따름, 30 블록 따름, 31 기본값)로 들어 있다.
  // 0.5mm 이상은 굵게, 0.3mm 이상은 조금 굵게 그린다.
  const LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
  const weightOf = (e, layer) => {
    let w = e.lineweight;
    if (w === 29 || w == null) w = layer.info ? layer.info.lineweight : 31;
    const mm = w >= 0 && w < LW.length ? LW[w] : 0;
    return mm >= 50 ? 2 : mm >= 30 ? 1 : 0;
  };

  const T = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  // 개체 좌표계(OCS)가 뒤집힌 개체(돌출 방향 z가 음수)는 x를 뒤집어 그린다.
  const ocs = (m, e) => (e.extrusionDirection && e.extrusionDirection.z < 0 ? mul(m, [-1, 0, 0, 1, 0, 0]) : m);

  const line = (m, list, closed, color, weight) => {
    if (truncated || list.length < 2) return;
    if (pts.length / 2 + list.length > MAX_POINTS) {
      truncated = true;
      return;
    }
    const start = pts.length / 2;
    for (const [x, y] of list) {
      const p = T(m, x, y);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
      pts.push(p[0], p[1]);
    }
    if (closed) {
      const p = T(m, list[0][0], list[0][1]);
      pts.push(p[0], p[1]);
    }
    strokes.push(start, pts.length / 2 - start, color, weight);
  };

  const fill = (m, rings, color, alpha) => {
    if (truncated) return;
    let first = true;
    const count = rings.filter((r) => r.length >= 3).length;
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const start = fillPts.length / 2;
      for (const [x, y] of ring) {
        const p = T(m, x, y);
        fillPts.push(p[0], p[1]);
      }
      fillRings.push(start, ring.length, color, first ? count : 0, alpha);
      first = false;
    }
  };

  // 시작·끝 각도에서 반시계 방향으로 잰 범위(0보다 크고 한 바퀴 이하). 각도가 여러 바퀴로 들어와도 한 바퀴로 줄인다.
  const sweep = (a0, a1) => {
    const full = Math.PI * 2;
    let span = ((a1 - a0) % full + full) % full;
    if (span < 1e-9) span = full;
    return span;
  };

  const arcPoints = (cx, cy, r, a0, a1) => {
    const span = sweep(a0, a1);
    const n = Math.max(4, Math.ceil(span / ARC_STEP));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (span * i) / n;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
  };

  // 볼록(bulge)이 있는 두 점 사이를 호로 잇는다(폴리선·해치 경계).
  const bulgePoints = (p, q, b) => {
    if (!b) return [[q[0], q[1]]];
    const theta = 4 * Math.atan(b);
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const chord = Math.hypot(dx, dy);
    if (!chord) return [[q[0], q[1]]];
    const r = chord / (2 * Math.sin(theta / 2));
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const h = r * Math.cos(theta / 2);
    const cx = mx - (h * dy) / chord;
    const cy = my + (h * dx) / chord;
    const a0 = Math.atan2(p[1] - cy, p[0] - cx);
    // 폴리선 호는 짧은 것이 많아(구름 표시는 수천 개) 10도마다 나눈다
    const n = Math.max(2, Math.ceil(Math.abs(theta) / (ARC_STEP * 2)));
    const out = [];
    for (let i = 1; i <= n; i++) {
      const a = a0 + (theta * i) / n;
      out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)]);
    }
    return out;
  };

  const polyPoints = (verts, closed) => {
    const out = [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (!i) out.push([v.x, v.y]);
      const nx = i + 1 < verts.length ? verts[i + 1] : closed ? verts[0] : null;
      if (nx) out.push(...bulgePoints([v.x, v.y], [nx.x, nx.y], v.bulge || 0));
    }
    return out;
  };

  const ellipsePoints = (c, major, ratio, a0, a1) => {
    const mx = major.x;
    const my = major.y;
    const nx = -my * ratio;
    const ny = mx * ratio;
    const span = a1 == null ? Math.PI * 2 : sweep(a0 || 0, a1);
    const n = Math.max(8, Math.ceil(span / ARC_STEP));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = (a0 || 0) + (span * i) / n;
      out.push([c.x + mx * Math.cos(t) + nx * Math.sin(t), c.y + my * Math.cos(t) + ny * Math.sin(t)]);
    }
    return out;
  };

  // B-스플라인(가중치 포함): 조정점·매듭이 있으면 그 곡선을, 맞춤점만 있으면 그 점들을 지나는 매끈한 곡선(캣멀-롬)을 그린다.
  const splinePoints = (e) => {
    const cps = e.controlPoints || [];
    const knots = e.knots || [];
    const deg = e.degree || 3;
    if (cps.length > deg && knots.length === cps.length + deg + 1) {
      const w = cps.map((p) => (p.w != null ? p.w : p.weight != null ? p.weight : 1));
      const lo = knots[deg];
      const hi = knots[cps.length];
      const n = Math.min(400, Math.max(16, cps.length * 8));
      const out = [];
      for (let s = 0; s <= n; s++) {
        const u = s === n ? hi - 1e-9 * (hi - lo) : lo + ((hi - lo) * s) / n;
        let k = deg;
        while (k < cps.length - 1 && knots[k + 1] <= u) k++;
        const dx = [];
        const dy = [];
        const dw = [];
        for (let j = 0; j <= deg; j++) {
          const p = cps[k - deg + j];
          const ww = w[k - deg + j];
          dx.push(p.x * ww);
          dy.push(p.y * ww);
          dw.push(ww);
        }
        for (let r = 1; r <= deg; r++) {
          for (let j = deg; j >= r; j--) {
            const i = k - deg + j;
            const den = knots[i + deg - r + 1] - knots[i];
            const a = den ? (u - knots[i]) / den : 0;
            dx[j] = (1 - a) * dx[j - 1] + a * dx[j];
            dy[j] = (1 - a) * dy[j - 1] + a * dy[j];
            dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
          }
        }
        out.push([dx[deg] / dw[deg], dy[deg] / dw[deg]]);
      }
      return out;
    }
    const fp = (e.fitPoints && e.fitPoints.length ? e.fitPoints : cps).map((p) => [p.x, p.y]);
    if (fp.length < 3) return fp;
    const out = [fp[0]];
    for (let i = 0; i < fp.length - 1; i++) {
      const p0 = fp[Math.max(0, i - 1)];
      const p1 = fp[i];
      const p2 = fp[i + 1];
      const p3 = fp[Math.min(fp.length - 1, i + 2)];
      for (let s = 1; s <= 12; s++) {
        const t = s / 12;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push([0, 1].map((d) => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2
          + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
      }
    }
    return out;
  };

  const text = (m, str, x, y, h, rot, color, ha, va, wf, wrap) => {
    if (!str || !h) return;
    const p = T(m, x, y);
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const ang = Math.atan2(m[1], m[0]);
    texts.push(str, p[0], p[1], h * sy, (rot || 0) + ang, color, ha, va, (wf || 1) * (sy ? sx / sy : 1), wrap ? wrap * sx : 0);
  };

  const hatchRings = (e) => {
    const rings = [];
    for (const path of e.boundaryPaths || []) {
      if (path.vertices && path.vertices.length) {
        rings.push(polyPoints(path.vertices, true));
        continue;
      }
      const ring = [];
      for (const edge of path.edges || []) {
        if (edge.type === 1 && edge.start && edge.end) {
          if (!ring.length) ring.push([edge.start.x, edge.start.y]);
          ring.push([edge.end.x, edge.end.y]);
        } else if (edge.type === 2 && edge.center) {
          let a0 = edge.startAngle || 0;
          let a1 = edge.endAngle || 0;
          if (edge.isCCW === false || edge.isCCW === 0) {
            const pts2 = arcPoints(edge.center.x, edge.center.y, edge.radius, Math.PI * 2 - a1, Math.PI * 2 - a0)
              .map(([x, y]) => [x, 2 * edge.center.y - y]).reverse();
            ring.push(...pts2);
          } else ring.push(...arcPoints(edge.center.x, edge.center.y, edge.radius, a0, a1));
        } else if (edge.type === 3 && edge.center && edge.end) {
          ring.push(...ellipsePoints(edge.center, edge.end, edge.lengthOfMinorAxis || edge.axisRatio || 1, edge.startAngle, edge.endAngle));
        } else if (edge.type === 4) {
          ring.push(...splinePoints(edge));
        }
      }
      if (ring.length) rings.push(ring);
    }
    return rings;
  };

  const draw = (list, m, depth, inheritedLayer, blockColor) => {
    for (const e of list) {
      if (truncated) return;
      if (!e || e.isVisible === false) continue;
      const layer = layerOf(e, inheritedLayer);
      if (layer.info && (layer.info.off || layer.info.frozen)) continue;
      const color = colorOf(e, layer, blockColor);
      const weight = weightOf(e, layer);
      const mm = ocs(m, e);
      entities++;
      switch (e.type) {
        case 'LINE':
          line(m, [[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]], false, color, weight);
          break;
        case 'LWPOLYLINE':
          // 닫힘 표시: DWG(LibreDWG)는 512, DXF는 1(dxf-read.js가 512로 바꿔 둔다)
          line(mm, polyPoints(e.vertices || [], (e.flag & 512) === 512), false, color, weight);
          break;
        case 'POLYLINE2D':
        case 'POLYLINE3D':
        case 'POLYLINE':
          line(e.type === 'POLYLINE3D' ? m : mm, polyPoints((e.vertices || []).filter((v) => !(v.flag & 16)), (e.flag & 1) === 1), false, color, weight);
          break;
        case 'CIRCLE':
          line(mm, arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2), false, color, weight);
          break;
        case 'ARC':
          line(mm, arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), false, color, weight);
          break;
        case 'ELLIPSE':
          line(m, ellipsePoints(e.center, e.majorAxisEndPoint, e.axisRatio, e.startAngle, e.endAngle), false, color, weight);
          break;
        case 'SPLINE':
          line(m, splinePoints(e), false, color, weight);
          break;
        case 'LEADER':
          line(m, (e.vertices || []).map((v) => [v.x, v.y]), false, color, weight);
          break;
        case '3DFACE':
          line(m, [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map((v) => [v.x, v.y]), true, color, weight);
          break;
        case 'SOLID':
        case 'TRACE':
          // 꼭짓점 순서가 1·2·4·3이다
          fill(mm, [[e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].filter(Boolean).map((v) => [v.x, v.y])], color, 255);
          break;
        case 'HATCH': {
          const rings = hatchRings(e);
          // 단색 채움은 그대로, 무늬 해치는 옅은 색으로 대신한다(무늬 선은 그리지 않는다).
          fill(mm, rings, color, e.solidFill ? 255 : 46);
          if (!e.solidFill) skip('HATCH_PATTERN');
          break;
        }
        case 'TEXT':
        case 'ATTRIB': {
          const t = e.type === 'ATTRIB' ? e.text || {} : e;
          const str = cleanText(e.type === 'ATTRIB' ? t.text : e.text);
          const ha = t.halign || 0;
          const va = t.valign || 0;
          const at = (ha || va) && t.endPoint && (t.endPoint.x || t.endPoint.y) ? t.endPoint : t.startPoint;
          if (!at) break;
          const hMap = { 0: 0, 1: 1, 2: 2, 3: 0, 4: 1, 5: 0 };
          text(mm, str, at.x, at.y, t.textHeight, t.rotation, color, hMap[ha] ?? 0, ha === 4 ? 2 : va, t.xScale, 0);
          break;
        }
        case 'MTEXT': {
          const ap = e.attachmentPoint || 1;
          const rot = e.direction && (e.direction.x || e.direction.y) ? Math.atan2(e.direction.y, e.direction.x) : e.rotation || 0;
          text(m, cleanMText(e.text), e.insertionPoint.x, e.insertionPoint.y, e.textHeight, rot, color,
            (ap - 1) % 3, [3, 2, 1][Math.floor((ap - 1) / 3)], 1, e.rectWidth || 0);
          break;
        }
        case 'DIMENSION':
        case 'ARC_DIMENSION':
        case 'LARGE_RADIAL_DIMENSION': {
          const b = blocks.get(e.name);
          if (b && b.entities && depth < MAX_DEPTH) draw(b.entities, m, depth + 1, layer.name, color);
          else if (e.textPoint) text(m, cleanMText(e.text) || fmtNumber(e.measurement), e.textPoint.x, e.textPoint.y, 2.5, e.textRotation, color, 1, 2, 1, 0);
          break;
        }
        case 'INSERT': {
          const b = blocks.get(e.name);
          if (!b || !b.entities || depth >= MAX_DEPTH) break;
          const sx = e.xScale || 1;
          const sy = e.yScale || 1;
          // 비정상적인 배율(해석이 깨진 블록)은 도면 전체를 덮으므로 그리지 않는다.
          if (Math.abs(sx) > 1e4 || Math.abs(sy) > 1e4) {
            skip('INSERT_BROKEN');
            break;
          }
          const r = e.rotation || 0;
          const base = b.basePoint || { x: 0, y: 0 };
          const cols = Math.max(1, e.columnCount || 1);
          const rows = Math.max(1, e.rowCount || 1);
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          for (let row = 0; row < rows && !truncated; row++) {
            for (let col = 0; col < cols && !truncated; col++) {
              const ox = col * (e.columnSpacing || 0);
              const oy = row * (e.rowSpacing || 0);
              const ip = [e.insertionPoint.x + ox * cos - oy * sin, e.insertionPoint.y + ox * sin + oy * cos];
              let n = [sx * cos, sx * sin, -sy * sin, sy * cos, ip[0], ip[1]];
              n = mul(n, [1, 0, 0, 1, -base.x, -base.y]);
              draw(b.entities, mul(mm, n), depth + 1, layer.name, color);
            }
          }
          for (const a of e.attribs || []) draw([a], m, depth + 1, layer.name, color);
          break;
        }
        case 'ATTDEF':
        case 'VIEWPORT':
        case 'POINT':
        case 'XLINE':
        case 'RAY':
        case 'WIPEOUT':
          break; // 그리지 않는 개체(정의·화면틀·무한선·가림)
        default:
          skip(e.type);
      }
    }
  };

  draw(top, [1, 0, 0, 1, 0, 0], 0, null, 0);

  // 처음 보여 줄 범위: 튀어 나간 점(깨진 개체·멀리 있는 점)에 끌려가지 않게 점들의 1%~99% 범위로 잡는다.
  const extent = robustExtent(pts, fillPts, texts);
  const ox = (extent[0] + extent[2]) / 2;
  const oy = (extent[1] + extent[3]) / 2;
  const P = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    P[i] = pts[i] - ox;
    P[i + 1] = pts[i + 1] - oy;
  }
  const F = new Float32Array(fillPts.length);
  for (let i = 0; i < fillPts.length; i += 2) {
    F[i] = fillPts[i] - ox;
    F[i + 1] = fillPts[i + 1] - oy;
  }
  for (let i = 0; i < texts.length; i += 10) {
    texts[i + 1] -= ox;
    texts[i + 2] -= oy;
  }
  // 선마다 차지하는 범위(화면 밖 선 건너뛰기용). 큰 도면에서 화면 스레드가 멈추지 않게 여기서 잰다.
  const S = Uint32Array.from(strokes);
  const boxes = new Float32Array((S.length / 4) * 4);
  for (let i = 0, b = 0; i < S.length; i += 4, b += 4) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = S[i], e = S[i] + S[i + 1]; k < e; k++) {
      const x = P[k * 2];
      const y = P[k * 2 + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    boxes[b] = x0;
    boxes[b + 1] = y0;
    boxes[b + 2] = x1;
    boxes[b + 3] = y1;
  }
  return {
    ok: true,
    space,
    entities,
    truncated,
    skipped,
    extent: [extent[0] - ox, extent[1] - oy, extent[2] - ox, extent[3] - oy],
    pts: P,
    strokes: S,
    boxes,
    fillPts: F,
    fillRings: Uint32Array.from(fillRings),
    texts,
  };
}

function countDrawable(list) {
  let n = 0;
  for (const e of list || []) if (e && e.type !== 'VIEWPORT') n++;
  return n;
}

function robustExtent(pts, fillPts, texts) {
  const xs = [];
  const ys = [];
  const take = (arr) => {
    const step = Math.max(2, Math.floor(arr.length / 200000) * 2);
    for (let i = 0; i + 1 < arr.length; i += step) {
      xs.push(arr[i]);
      ys.push(arr[i + 1]);
    }
  };
  take(pts);
  take(fillPts);
  for (let i = 0; i < texts.length; i += 10) {
    xs.push(texts[i + 1]);
    ys.push(texts[i + 2]);
  }
  if (!xs.length) return [0, 0, 1, 1];
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  // 1%~99% 범위를 중심으로 잡고, 그 바깥이 중심 폭의 절반 안쪽이면(정상적인 가장자리 개체) 끝까지 넣는다.
  // 그보다 멀리 떨어진 점(깨진 개체·잘못 찍힌 점)만 처음 화면에서 뺀다.
  const k = xs.length > 200 ? Math.floor(xs.length * 0.01) : 0;
  let x0 = xs[k];
  let x1 = xs[xs.length - 1 - k];
  let y0 = ys[k];
  let y1 = ys[ys.length - 1 - k];
  const cw = Math.max(x1 - x0, y1 - y0, 1e-9);
  // 정렬된 값에서 lim 안쪽의 가장 먼 값
  const reachLow = (arr, v, lim) => {
    for (let i = 0; i < arr.length && arr[i] < v; i++) if (arr[i] >= lim) return arr[i];
    return v;
  };
  const reachHigh = (arr, v, lim) => {
    for (let i = arr.length - 1; i >= 0 && arr[i] > v; i--) if (arr[i] <= lim) return arr[i];
    return v;
  };
  x0 = reachLow(xs, x0, x0 - cw * 0.5);
  x1 = reachHigh(xs, x1, x1 + cw * 0.5);
  y0 = reachLow(ys, y0, y0 - cw * 0.5);
  y1 = reachHigh(ys, y1, y1 + cw * 0.5);
  // 글자는 기준점만 넣었으므로 가장자리에 조금 여유를 둔다
  const padX = (x1 - x0) * 0.02 || 1;
  const padY = (y1 - y0) * 0.02 || 1;
  x0 -= padX;
  x1 += padX;
  y0 -= padY;
  y1 += padY;
  if (x1 - x0 < 1e-9) x1 = x0 + 1;
  if (y1 - y0 < 1e-9) y1 = y0 + 1;
  return [x0, y0, x1, y1];
}

function fmtNumber(v) {
  if (!Number.isFinite(v)) return '';
  return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

// TEXT의 특수 기호: %%d 도(°), %%p 플러스마이너스(±), %%c 지름(⌀), %%u·%%o 밑줄·윗줄(표시만 지움), %%nnn 문자 번호
function cleanText(s) {
  return String(s || '')
    .replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, '⌀')
    .replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%')
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// MTEXT 서식 코드를 지우고 글만 남긴다(\P 줄바꿈, \S 분수, 글꼴·높이·색 지정 등).
function cleanMText(s) {
  let t = String(s || '');
  // 줄 바꿈은 대문자 \P만이다(소문자 \p…;는 문단 정렬 같은 서식이라 아래에서 지운다)
  t = t.replace(/\\P/g, '\n').replace(/\\~/g, ' ');
  t = t.replace(/\\S([^;]*?)[#^/]([^;]*);/g, '$1/$2');
  t = t.replace(/\\[fFhHwWcCtTqQaAp][^;\\]*;/g, '');
  t = t.replace(/\\[LlOoKkNn]/g, '');
  t = t.replace(/\\([\\{}])/g, '\u0000$1');
  t = t.replace(/[{}]/g, '');
  t = t.replace(/\u0000/g, '');
  return cleanText(t).replace(/\r/g, '');
}
