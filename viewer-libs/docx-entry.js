// Word(docx·docm·dotx, 옛 doc) 뷰어 묶음의 입구.
// react-docx의 전체 뷰어를 읽기 전용으로 쓴다. 간이 뷰어(ReactDocxViewer)는 스타일에 걸린 번호 매기기,
// 강제 쪽 나눔, 머리말·꼬리말을 빠뜨려서 평소에는 쓰지 않고, 전체 뷰어가 오류로 멈출 때만 대신 띄운다.
// 옛 doc는 같은 엔진이 docx로 바꿔 읽는다.
import { Component, createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DocxEditorViewer, ReactDocxViewer, parseDocxForViewer, setWasmSource, useDocxEditor,
} from '@extend-ai/react-docx';
import { colorOf, makeNumbering } from '../app/src/main/assets/viewer/docx-numbering.js';

// 표 속 표가 이보다 깊으면 열지 않는다. 비정상적으로 깊은 문서는 해석하다가 화면 엔진 전체가 죽는다.
const MAX_TABLE_DEPTH = 40;

function tooDeep() {
  const err = new Error('table nesting too deep');
  err.code = 'too-deep';
  return err;
}

// ZIP 안의 한 항목을 압축을 풀면서 읽는 스트림으로 돌려준다. 못 찾거나 모르는 형식이면 null.
function zipEntryStream(bytes, name) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    if (decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)) === name) {
      if (offset + 30 > bytes.length || dv.getUint32(offset, true) !== 0x04034b50) return null;
      const start = offset + 30 + dv.getUint16(offset + 26, true) + dv.getUint16(offset + 28, true);
      const data = new Blob([bytes.subarray(start, Math.min(bytes.length, start + size))]).stream();
      if (method === 0) return data;
      if (method === 8) return data.pipeThrough(new DecompressionStream('deflate-raw'));
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// docx 본문의 표 중첩 깊이를 문서를 통째로 펼치지 않고 훑어서 잰다.
async function checkTableDepth(bytes) {
  let stream;
  try {
    stream = zipEntryStream(bytes, 'word/document.xml');
  } catch (_) {
    return; // 이 기기의 웹뷰가 압축 풀기를 지원하지 않거나 ZIP이 이상하면 라이브러리에 맡긴다.
  }
  if (!stream) return;
  const reader = stream.pipeThrough(new TextDecoderStream('latin1')).getReader();
  const tag = /<(\/?)(?:[A-Za-z_][\w.-]*:)?tbl(?=[\s>/])/g;
  let depth = 0;
  let carry = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = carry + value;
      tag.lastIndex = 0;
      let m;
      let lastEnd = 0;
      while ((m = tag.exec(text))) {
        lastEnd = tag.lastIndex;
        depth += m[1] ? -1 : 1;
        if (depth > MAX_TABLE_DEPTH) {
          reader.cancel().catch(() => {});
          throw tooDeep();
        }
      }
      // 덩어리 경계에 걸린 태그를 놓치지 않도록 끝부분을 다음 덩어리 앞에 붙인다.
      carry = text.slice(Math.max(lastEnd, text.length - 16));
    }
  } catch (e) {
    if (e && e.code === 'too-deep') throw e;
    // 압축이 깨진 경우 등은 라이브러리가 알맞은 오류를 내게 둔다.
  }
}

// 표 중첩 깊이와 문단 수·글자 수(표 칸 안 포함)를 센다. 문단·글자 수로 쪽 수와 쪽 나눔에 걸리는 시간을 가늠한다.
function measure(lists) {
  let depthMax = 0;
  let paragraphs = 0;
  let chars = 0;
  let tableRows = 0;
  const stack = lists.map((nodes) => [nodes, 0]);
  while (stack.length) {
    const [nodes, depth] = stack.pop();
    for (const node of nodes || []) {
      if (!node) continue;
      if (node.type !== 'table') {
        paragraphs++;
        for (const c of node.children || []) if (c && c.type === 'text' && c.text) chars += c.text.length;
        continue;
      }
      tableRows += (node.rows || []).length;
      const d = depth + 1;
      if (d > depthMax) depthMax = d;
      if (depthMax > MAX_TABLE_DEPTH) return { depth: depthMax, paragraphs, chars, tableRows };
      for (const row of node.rows || []) {
        for (const cell of row.cells || []) stack.push([cell.nodes, d]);
      }
    }
  }
  return { depth: depthMax, paragraphs, chars, tableRows };
}

// 화면 근처의 쪽만 그리기(가상화)는 표준 CSS zoom(크롬 128부터, Element.currentCSSZoom이 있는 판)을 전제로 쪽 위치를 잰다.
// 그 전 크롬은 zoom 안쪽의 getBoundingClientRect를 zoom 배율로 나눠 돌려줘(화면 맞춤 0.5배면 위치가 두 배), 끝까지 내려도
// 뒤쪽 쪽이 그려지지 않았다(CI #86·#88 웹뷰 113, word-12-pages: 끝에서 2~7쪽만). 그런 웹뷰에서는 모든 쪽을 그린다.
const standardZoom = typeof Element !== 'undefined' && 'currentCSSZoom' in Element.prototype;

// allPages: 인쇄(PDF로 저장)하는 동안만 모든 쪽을 그린다. 평소에는 엔진이 화면 근처의 쪽만 그린다(가상화).
function FullViewer({ parsed, onPages, allPages }) {
  const editor = useDocxEditor({ document: parsed });
  return h(DocxEditorViewer, {
    editor,
    mode: 'read-only',
    defaultZoom: 'fit-width',
    pageGapBackgroundColor: 'transparent',
    onPageCountChange: onPages,
    pageVirtualization: allPages || !standardZoom ? { enabled: false } : undefined,
    style: { width: '100%', height: '100%' },
  });
}

// 그린 곳(container)마다 "모든 쪽 그리기" 스위치. viewer.js가 인쇄 전후에 부른다(setAllPages).
const allPagesSwitch = new WeakMap();

export function setAllPages(container, on) {
  const set = allPagesSwitch.get(container);
  if (!set) return false;
  set(!!on);
  return true;
}

function SimpleViewer({ parsed, onShown }) {
  useEffect(() => {
    onShown();
  }, []);
  return h('div', { style: { width: '100%', height: '100%', overflow: 'auto' } },
    h(ReactDocxViewer, { document: parsed, defaultZoom: 'fit-width' }));
}

// ---------------------------------------------------------------- 긴 문서 읽기 보기
// 엔진의 쪽 나눔은 첫 화면 전에 문서 전체의 문단·표 높이를 계산해서, 긴 문서(30쪽 이상)에서는 중급 휴대폰 근사로 5~10초
// 화면이 멈춘다. 긴 문서는 엔진이 읽은 문서 구조를 간단 보기 블록(simple-view.js와 같은 모양)으로 바꿔 쪽 나눔 없이 바로
// 보여 주고, 사용자가 "쪽 모양으로 보기"를 누를 때만 쪽을 나눈다.
// 블록: { t: 'p', align, heading, runs: [{ text, b, i, u, s, size, color } | { img, w }] } · { t: 'table', rows } · { t: 'break' }

export function readingBlocks(model) {
  const meta = model.metadata || {};
  const styles = new Map((meta.paragraphStyles || []).map((d) => [d.id, d]));
  const styleProp = (styleId, key) => {
    for (let id = styleId, guard = 0; id && guard < 20; guard++) {
      const d = styles.get(id);
      if (!d) break;
      if (d[key] != null) return d[key];
      id = d.basedOnId;
    }
    return undefined;
  };
  const numberLabel = makeNumbering(meta);
  const urls = [];
  const notes = [];
  const noteIndex = new Map();
  let omittedImages = 0;

  const runOf = (child) => {
    if (!child) return null;
    if (child.type === 'text') {
      const st = child.style || {};
      let text = child.text || '';
      if (child.noteReference && child.noteReference.kind === 'footnote') {
        const id = child.noteReference.id;
        if (!noteIndex.has(id)) {
          noteIndex.set(id, notes.length + 1);
          const def = (meta.footnotes || []).find((f) => f.id === id);
          notes.push(def ? def.text : '');
        }
        text = `[${noteIndex.get(id)}]`;
      }
      if (!text) return null;
      return { text, b: !!st.bold, i: !!st.italic, u: !!st.underline, s: !!st.strike, size: st.fontSizePt, color: colorOf(st.color) };
    }
    if (child.type === 'image') {
      const type = child.contentType || '';
      if (child.data && /^image\/(png|jpe?g|gif|bmp|webp)$/i.test(type)) {
        const url = URL.createObjectURL(new Blob([child.data], { type }));
        urls.push(url);
        return { img: url, w: child.widthPx || 0 };
      }
      if (child.src && /^(blob:|data:image\/(png|jpe?g|gif|bmp|webp))/i.test(child.src)) return { img: child.src, w: child.widthPx || 0 };
      omittedImages++;
      return null;
    }
    if (child.type === 'form-field') {
      if (child.fieldType === 'checkbox') return { text: child.checked ? (child.checkedSymbol || '☒') : (child.uncheckedSymbol || '☐') };
      const text = child.value || child.placeholder || '';
      return text ? { text } : null;
    }
    return null;
  };

  const convert = (nodes, out) => {
    for (const node of nodes || []) {
      if (!node) continue;
      if (node.type === 'table') {
        const rows = [];
        const origin = []; // 열 번호 → 위에서 이어지는(세로로 합친) 칸
        for (const row of node.rows || []) {
          const cells = [];
          let col = (row.style && row.style.gridBefore) || 0;
          for (const cell of row.cells || []) {
            const st = cell.style || {};
            const span = Math.max(1, st.gridSpan || 1);
            if (st.vMergeContinuation && origin[col]) {
              origin[col].rowspan = (origin[col].rowspan || 1) + 1;
            } else {
              const c = { blocks: [], colspan: span, rowspan: 1 };
              convert(cell.nodes, c.blocks);
              cells.push(c);
              for (let k = 0; k < span; k++) origin[col + k] = c;
            }
            col += span;
          }
          rows.push({ cells });
        }
        out.push({ t: 'table', rows });
        continue;
      }
      const st = node.style || {};
      if (st.pageBreakBefore || styleProp(st.styleId, 'pageBreakBefore')) out.push({ t: 'break' });
      const heading = st.headingLevel || styleProp(st.styleId, 'headingLevel');
      const label = numberLabel(st.numbering || styleProp(st.styleId, 'numbering'));
      const runs = [];
      if (label) runs.push({ text: label });
      for (const child of node.children || []) {
        const r = runOf(child);
        if (r) runs.push(r);
      }
      out.push({ t: 'p', align: st.align || styleProp(st.styleId, 'align'), heading: heading || 0, runs });
    }
  };

  const blocks = [];
  convert(model.nodes, blocks);
  const textOf = (sections) => {
    const tmp = [];
    for (const sec of sections || []) {
      if (sec.referenceType && sec.referenceType !== 'default') continue;
      convert(sec.nodes, tmp);
      break;
    }
    return tmp.filter((b) => b.t === 'p').map((b) => b.runs.map((r) => r.text || '').join('')).join(' ').replace(/\s+/g, ' ').trim();
  };
  return {
    blocks,
    extras: { header: textOf(meta.headerSections), footer: textOf(meta.footerSections), footnotes: notes },
    omittedImages,
    release: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}

// 전체 뷰어가 오류로 멈추면 빈 화면 대신 간이 뷰어로 바꿔 보여준다.
class Fallback extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    if (this.props.onFallback) this.props.onFallback(error);
  }

  render() {
    if (this.state.failed) return h(SimpleViewer, { parsed: this.props.parsed, onShown: this.props.onSimpleShown });
    return this.props.children;
  }
}

export async function mountDocument(container, bytes, handlers = {}) {
  setWasmSource(new URL('./docx_wasm_bg.wasm', import.meta.url).href);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) await checkTableDepth(bytes);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = await parseDocxForViewer(buffer);
  const meta = parsed.model.metadata || {};
  const size = measure([parsed.model.nodes]);
  for (const s of [...(meta.headerSections || []), ...(meta.footerSections || [])]) {
    const d = measure([s.nodes]).depth;
    if (d > size.depth) size.depth = d;
  }
  if (size.depth > MAX_TABLE_DEPTH) {
    parsed.dispose();
    throw tooDeep();
  }
  // 쪽 나눔 계산은 화면 스레드에서 돌아 분량이 많으면 잠시 멈춘 듯 보인다. 그 전에 안내하거나(onParsed가 기다림)
  // 읽기 보기로 바로 열지({ reading: true }) 정할 기회를 준다.
  // 문서에 적힌 쪽수(docProps)는 틀린 경우가 많아(222쪽 문서에 1쪽) 문단·글자 수를 함께 넘긴다.
  const decision = handlers.onParsed
    ? await handlers.onParsed({
      storedPages: meta.documentPageCount || 0, paragraphs: size.paragraphs, chars: size.chars, tableRows: size.tableRows,
      // 해석에 걸린 시간(작업 스레드에서 XML 읽기 · 문서 구조 만들기). 느린 문서의 원인을 알아보는 데 쓴다.
      parseMs: Math.round((parsed.timings && parsed.timings.parseMs) || 0),
      buildMs: Math.round((parsed.timings && parsed.timings.modelConstructionMs) || 0),
    })
    : null;
  let root = null;
  let reading = null;
  // 쪽 모양(전체 뷰어)을 그린다. 쪽 수를 알게 되면 끝난다. 그 전까지 보이던 것(빠른 읽기 보기)은 이때 비운다.
  const renderFull = (onPages) => {
    container.replaceChildren();
    root = createRoot(container);
    let loaded = false;
    const loadedOnce = (pages) => {
      if (loaded) return;
      loaded = true;
      onPages(pages);
    };
    const draw = (allPages) => root.render(h(Fallback, {
      parsed,
      onFallback: (error) => {
        if (handlers.onFallback) handlers.onFallback(error);
      },
      onSimpleShown: () => loadedOnce(meta.documentPageCount || 0),
    }, h(FullViewer, {
      parsed,
      allPages,
      onPages: (pages) => {
        if (pages) loadedOnce(pages);
      },
    })));
    draw(false);
    allPagesSwitch.set(container, draw);
  };
  if (decision && decision.reading) {
    try {
      reading = readingBlocks(parsed.model);
    } catch (e) {
      // 문서 구조가 예상과 달라 읽기 보기를 만들지 못하면 원래대로 쪽 모양으로 그린다.
      console.warn('읽기 보기를 만들지 못함', e);
    }
  }
  if (reading) {
    handlers.onReading({
      blocks: reading.blocks,
      extras: reading.extras,
      omittedImages: reading.omittedImages,
      showFull: () => new Promise((resolve) => {
        renderFull(resolve);
      }),
    });
  } else {
    renderFull((pages) => {
      if (handlers.onLoad) handlers.onLoad({ pages });
    });
  }
  return () => {
    if (root) root.unmount();
    if (reading) reading.release();
    parsed.dispose();
  };
}
