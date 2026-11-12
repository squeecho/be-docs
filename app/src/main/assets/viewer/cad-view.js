// CAD 도면 화면: cad-worker.js가 만든 목록(선·채움·글자)을 캔버스에 그리고, 두 손가락 확대·축소, 끌어 옮기기,
// 마우스 휠, 두 번 톡(처음 크기)을 처리한다. 도면 좌표는 y가 위로 커지고, 화면은 아래로 커진다.
// mountCad(container, data, { topInset, background }) → { reset(), refit(), setBackground(), destroy() }
// 바탕: 'dark'(AutoCAD처럼 어두운 바탕, 도면 색 그대로) · 'paper'(흰 바탕, 흰 선은 검게, 밝은 색은 읽히게 어둡게)

const MIN_TEXT_PX = 3; // 이보다 작게 보이는 글자는 그리지 않는다(멀리서 보면 점으로 뭉개진다)
const SLOW_MS = 28; // 한 번 그리는 데 이보다 오래 걸리면 손가락이 움직이는 동안은 그려 둔 그림을 늘여 보여 준다

export function mountCad(container, data, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'cad-canvas';
  canvas.setAttribute('role', 'img');
  container.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const snap = document.createElement('canvas');
  const snapCtx = snap.getContext('2d', { alpha: false });

  const { pts, strokes, fillPts, fillRings, texts, extent } = data;
  const nStrokes = strokes.length / 4;

  // 선마다 차지하는 범위(화면 밖 선은 건너뛰고, 아주 작게 보이는 선은 생략한다). 작업 스레드가 재 둔다.
  const box = data.boxes;

  // 같은 색·두께끼리 묶어 한 번에 그린다
  const groups = new Map();
  for (let i = 0; i < nStrokes; i++) {
    const key = strokes[i * 4 + 2] * 4 + strokes[i * 4 + 3];
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  }
  const strokeGroups = [...groups.entries()].map(([key, list]) => ({
    raw: Math.floor(key / 4),
    weight: key % 4,
    list: Uint32Array.from(list),
  }));

  // 채움: 고리 수가 적힌 첫 고리부터 그 수만큼이 한 채움(구멍은 짝홀 규칙으로 뚫린다)
  const fills = [];
  for (let i = 0; i < fillRings.length; i += 5) {
    if (fillRings[i + 3]) fills.push({ at: i, rings: fillRings[i + 3], color: fillRings[i + 2], alpha: fillRings[i + 4] / 255 });
  }

  const textItems = [];
  for (let i = 0; i < texts.length; i += 10) {
    const lines = String(texts[i]).split('\n');
    textItems.push({
      lines, x: texts[i + 1], y: texts[i + 2], h: texts[i + 3], rot: texts[i + 4], raw: texts[i + 5],
      ha: texts[i + 6], va: texts[i + 7], wf: texts[i + 8] || 1, wrap: texts[i + 9], wrapped: null,
    });
  }

  let W = 0;
  let H = 0;
  let dpr = 1;
  let s = 1; // 도면 1단위 = 화면 s px
  let tx = 0; // 도면 (0, 0)의 화면 위치
  let ty = 0;
  let fitS = 1;
  let lastDrawMs = 0;
  let snapView = null; // 그려 둔 그림의 { s, tx, ty }
  let frame = 0;
  let settleTimer = 0;
  let interacting = false;
  let destroyed = false;
  let background = opts.background === 'paper' ? 'paper' : 'dark';
  const BG = { dark: '#1f2228', paper: '#ffffff' };
  const colorOf = (c) => rgb(background === 'paper' ? onPaper(c) : onDark(c));

  const topInset = () => (typeof opts.topInset === 'function' ? opts.topInset() : opts.topInset || 0);

  function size() {
    const r = container.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [canvas, snap]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
  }

  function fitView() {
    const top = topInset() + 12;
    const ew = extent[2] - extent[0];
    const eh = extent[3] - extent[1];
    const k = Math.min((W - 24) / ew, Math.max(40, H - top - 12) / eh);
    fitS = k;
    s = k;
    tx = W / 2 - ((extent[0] + extent[2]) / 2) * s;
    ty = top + (H - top - 12) / 2 + ((extent[1] + extent[3]) / 2) * s;
  }

  function draw() {
    frame = 0;
    if (destroyed) return;
    const t0 = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG[background];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 보이는 범위(도면 좌표)
    const vx0 = -tx / s;
    const vx1 = (W - tx) / s;
    const vy0 = (ty - H) / s;
    const vy1 = ty / s;
    const tiny = 0.6 / s;
    ctx.setTransform(s * dpr, 0, 0, -s * dpr, tx * dpr, ty * dpr);

    for (const f of fills) {
      ctx.beginPath();
      for (let r = 0; r < f.rings; r++) {
        const i = f.at + r * 5;
        const st = fillRings[i];
        const n = fillRings[i + 1];
        ctx.moveTo(fillPts[st * 2], fillPts[st * 2 + 1]);
        for (let k = st + 1; k < st + n; k++) ctx.lineTo(fillPts[k * 2], fillPts[k * 2 + 1]);
        ctx.closePath();
      }
      ctx.globalAlpha = f.alpha;
      ctx.fillStyle = colorOf(f.color);
      ctx.fill('evenodd');
    }
    ctx.globalAlpha = 1;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const g of strokeGroups) {
      ctx.beginPath();
      let any = false;
      for (const i of g.list) {
        const b = i * 4;
        if (box[b] > vx1 || box[b + 2] < vx0 || box[b + 1] > vy1 || box[b + 3] < vy0) continue;
        const st = strokes[i * 4];
        const n = strokes[i * 4 + 1];
        if (box[b + 2] - box[b] < tiny && box[b + 3] - box[b + 1] < tiny) {
          ctx.rect(box[b], box[b + 1], tiny, tiny);
          any = true;
          continue;
        }
        ctx.moveTo(pts[st * 2], pts[st * 2 + 1]);
        for (let k = st + 1; k < st + n; k++) ctx.lineTo(pts[k * 2], pts[k * 2 + 1]);
        any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = colorOf(g.raw);
      ctx.lineWidth = (g.weight === 2 ? 2 : g.weight === 1 ? 1.4 : 1) / s;
      ctx.stroke();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '10px sans-serif';
    for (const t of textItems) drawText(t, vx0, vx1, vy0, vy1);
    lastDrawMs = performance.now() - t0;
    // 손가락이 움직이는 동안 늘여 보여 줄 그림으로 남겨 둔다
    snapCtx.setTransform(1, 0, 0, 1, 0, 0);
    snapCtx.drawImage(canvas, 0, 0);
    snapView = { s, tx, ty };
  }

  const FONT = '"Pretendard Variable", Pretendard, "Noto Sans KR", sans-serif';

  function drawText(t, vx0, vx1, vy0, vy1) {
    const px = t.h * s;
    if (px < MIN_TEXT_PX) return;
    // 글이 화면 밖이면(넉넉히 글 높이 40배 범위) 건너뛴다
    const reach = t.h * 40 + (t.wrap || 0);
    if (t.x - reach > vx1 || t.x + reach < vx0 || t.y - reach > vy1 || t.y + reach < vy0) return;
    const lines = t.wrap ? wrapped(t) : t.lines;
    ctx.save();
    ctx.translate(t.x * s + tx, -t.y * s + ty);
    if (t.rot) ctx.rotate(-t.rot);
    if (t.wf !== 1) ctx.scale(t.wf, 1);
    ctx.font = `${px}px ${FONT}`;
    ctx.fillStyle = colorOf(t.raw);
    ctx.textAlign = t.ha === 1 ? 'center' : t.ha === 2 ? 'right' : 'left';
    const lh = px * 1.45;
    let y0;
    if (lines.length === 1) {
      ctx.textBaseline = t.va === 3 ? 'top' : t.va === 2 ? 'middle' : t.va === 1 ? 'bottom' : 'alphabetic';
      y0 = 0;
    } else {
      // 여러 줄(MTEXT): 붙는 자리가 위면 아래로, 가운데면 가운데를 기준으로, 아래면 위로 쌓는다
      ctx.textBaseline = 'top';
      const total = lh * lines.length;
      y0 = t.va === 3 ? 0 : t.va === 2 ? -total / 2 : -total;
    }
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, y0 + i * lh);
    ctx.restore();
  }

  // MTEXT 줄 바꿈 폭에 맞춰 줄을 나눈다(글 높이 100px 기준으로 한 번만 재 둔다)
  function wrapped(t) {
    if (t.wrapped) return t.wrapped;
    const out = [];
    const limit = (t.wrap / t.h) * 100;
    snapCtx.font = `100px ${FONT}`;
    for (const line of t.lines) {
      if (!line || snapCtx.measureText(line).width <= limit * 1.02) {
        out.push(line);
        continue;
      }
      let cur = '';
      for (const ch of line) {
        if (cur && snapCtx.measureText(cur + ch).width > limit * 1.02) {
          out.push(cur);
          cur = ch.trimStart();
        } else cur += ch;
      }
      if (cur) out.push(cur);
    }
    t.wrapped = out;
    return out;
  }

  // 손가락이 움직이는 동안: 빨리 그려지면 매번 다시 그리고, 무거운 도면은 그려 둔 그림을 늘여 보여 준다
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (interacting && lastDrawMs > SLOW_MS && snapView) previewSnap();
      else draw();
    });
  }

  function previewSnap() {
    const k = s / snapView.s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG[background];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, (tx - snapView.tx * k) * dpr, (ty - snapView.ty * k) * dpr);
    ctx.drawImage(snap, 0, 0);
  }

  function settle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      interacting = false;
      draw();
    }, 140);
  }

  const MAX_ZOOM = 20000;
  function zoomAt(k, x, y) {
    const ns = Math.min(fitS * MAX_ZOOM, Math.max(fitS / 8, s * k));
    const r = ns / s;
    tx = x - (x - tx) * r;
    ty = y - (y - ty) * r;
    s = ns;
  }

  // ---- 손가락·마우스
  const pointers = new Map();
  let gesture = null;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function onDown(e) {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    gesture = null;
    interacting = true;
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const prev = [...pointers.values()];
    pointers.set(e.pointerId, local(e));
    const now = [...pointers.values()];
    if (now.length === 1) {
      tx += now[0][0] - prev[0][0];
      ty += now[0][1] - prev[0][1];
    } else if (now.length >= 2) {
      const d0 = Math.hypot(prev[0][0] - prev[1][0], prev[0][1] - prev[1][1]);
      const d1 = Math.hypot(now[0][0] - now[1][0], now[0][1] - now[1][1]);
      const m0 = [(prev[0][0] + prev[1][0]) / 2, (prev[0][1] + prev[1][1]) / 2];
      const m1 = [(now[0][0] + now[1][0]) / 2, (now[0][1] + now[1][1]) / 2];
      tx += m1[0] - m0[0];
      ty += m1[1] - m0[1];
      if (d0 > 0 && d1 > 0) zoomAt(d1 / d0, m1[0], m1[1]);
    }
    interacting = true;
    schedule();
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (!pointers.size) settle();
  }

  function onWheel(e) {
    e.preventDefault();
    const [x, y] = local(e);
    interacting = true;
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), x, y);
    schedule();
    settle();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // 화면 크기가 바뀌면(돌리기·폴드 펼치기·분할 화면) 가운데에 보던 곳을 그대로 두고 다시 그린다
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const cx = (W / 2 - tx) / s;
    const cy = (ty - H / 2) / s;
    const wasFit = Math.abs(s - fitS) < fitS * 1e-6;
    size();
    const keep = s;
    fitView();
    if (!wasFit) {
      s = keep;
      tx = W / 2 - cx * s;
      ty = H / 2 + cy * s;
    }
    draw();
  }) : null;
  if (ro) ro.observe(container);

  container.dataset.background = background;
  size();
  fitView();
  draw();

  return {
    // 두 번 톡: 처음(화면에 맞춘) 크기로. 이미 처음 크기면 false
    reset() {
      if (Math.abs(s / fitS - 1) < 0.01) return false;
      fitView();
      draw();
      return true;
    },
    refit() {
      fitView();
      draw();
    },
    background: () => background,
    setBackground(mode) {
      background = mode === 'paper' ? 'paper' : 'dark';
      container.dataset.background = background;
      draw();
    },
    view: () => ({ s, tx, ty, fitS, W, H, lastDrawMs }),
    destroy() {
      destroyed = true;
      if (ro) ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      canvas.remove();
    },
  };
}

// 어두운 바탕: 아주 어두운 색(검정·짙은 회색)만 보이게 밝힌다
function onDark(c) {
  const l = lum(c);
  if (l >= 0.3) return c;
  if (l < 0.03) return 0xd8d8d8;
  // 순수한 파랑처럼 어두운 색은 밝기를 올릴 수 없어 흰색을 조금 섞는다
  const t = (0.3 - l) / (1 - l);
  const mix = (v) => Math.round(v + (255 - v) * t);
  return (mix((c >> 16) & 255) << 16) | (mix((c >> 8) & 255) << 8) | mix(c & 255);
}

// 흰 바탕: 흰색은 검정으로, 밝은 색(노랑·하늘색·연한 회색)은 읽히게 어둡게
function onPaper(c) {
  const l = lum(c);
  if (l > 0.95) return 0x000000;
  if (l <= 0.55) return c;
  return scale(c, 0.55 / l);
}

function lum(c) {
  return (0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255)) / 255;
}

function scale(c, k) {
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}

function rgb(c) {
  return `#${(c >>> 0).toString(16).padStart(6, '0')}`;
}
