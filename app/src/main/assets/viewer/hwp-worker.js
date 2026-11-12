// HWP 엔진(rhwp)을 화면과 다른 스레드에서 돌린다.
// 수백 쪽짜리 문서는 처음 열 때 쪽 나누기 계산에 몇 초가 걸리는데, 그동안 화면이 굳지 않게 하려는 것이다.

let rhwp = null;
let doc = null;

// rhwp는 줄바꿈 계산에 실제 글꼴 폭이 필요하다. 작업 스레드에서는 OffscreenCanvas로 잰다.
const ctx = new OffscreenCanvas(1, 1).getContext('2d');
let lastFont = '';
globalThis.measureTextWidth = (font, text) => {
  if (font !== lastFont) {
    ctx.font = font;
    lastFont = font;
  }
  return ctx.measureText(text).width;
};

async function ensureEngine() {
  if (rhwp) return rhwp;
  const mod = await import('./vendor/rhwp.js');
  await mod.default({ module_or_path: new URL('./vendor/rhwp_bg.wasm', import.meta.url) });
  rhwp = mod;
  return mod;
}

function open(bytes, password) {
  if (doc) {
    doc.free();
    doc = null;
  }
  doc = password == null
    ? new rhwp.HwpDocument(bytes)
    : rhwp.HwpDocument.openWithPassword(bytes, password);
  const count = doc.pageCount();
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const info = JSON.parse(doc.getPageInfo(i));
    sizes.push({ w: info.width || 794, h: info.height || 1123 });
  }
  return { pages: count, sizes };
}

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    await ensureEngine();
    if (op === 'open') {
      self.postMessage({ id, ok: true, ...open(data.bytes, data.password) });
    } else if (op === 'render') {
      self.postMessage({ id, ok: true, svg: doc.renderPageSvg(data.page) });
    } else {
      throw new Error(`알 수 없는 요청: ${op}`);
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && (e.message || e)) });
  }
};
