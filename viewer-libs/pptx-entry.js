// PPT·PPTX 표시용 묶음(@extend-ai/react-pptx). 뷰어 화면(viewer.js)은 mountPresentation()과 인쇄할 때 setAllSlides()를 부른다.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactPptxViewer, setWasmSource } from '@extend-ai/react-pptx';

// 그린 곳(container)마다 "모든 슬라이드 그리기" 스위치. 인쇄(PDF로 저장)하는 동안만 켠다(평소에는 화면 근처만 그린다).
const allSlidesSwitch = new WeakMap();

export function setAllSlides(container, on) {
  const set = allSlidesSwitch.get(container);
  if (!set) return false;
  set(!!on);
  return true;
}

export function mountPresentation(container, bytes, handlers = {}) {
  setWasmSource(new URL('./pptx_wasm_bg.wasm', import.meta.url).href);
  const root = createRoot(container);
  // 같은 뷰어를 다시 그려도(모든 슬라이드 켜고 끄기) 다 읽었다는 알림은 한 번만 넘긴다.
  let loaded = false;
  const onLoad = (presentation) => {
    if (loaded) return;
    loaded = true;
    if (handlers.onLoad) handlers.onLoad(presentation);
  };
  const draw = (allSlides) => root.render(createElement(ReactPptxViewer, {
    source: bytes,
    mode: 'continuous',
    defaultZoom: 'fit-width',
    showToolbar: false,
    showThumbnails: false,
    showNotes: false,
    height: '100%',
    style: { width: '100%', height: '100%', background: 'var(--bg)' },
    viewportStyle: { background: 'var(--bg)' },
    virtualization: allSlides ? false : undefined,
    onLoad,
    onError: handlers.onError,
    onWarning: handlers.onWarning,
  }));
  draw(false);
  allSlidesSwitch.set(container, draw);
  return () => root.unmount();
}
