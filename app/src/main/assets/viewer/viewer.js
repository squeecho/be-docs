// be docs 뷰어 화면.
// 안드로이드 쪽(ViewerActivity)이 같은 출처의 /doc/* 경로로 문서를 넘겨주면,
// 여기서 파일 형식을 판별해 HWP·HWPX는 rhwp, 엑셀·CSV는 SheetJS, PPT·PPTX는 react-pptx,
// Word(docx·doc)는 react-docx, PDF는 안드로이드 PdfRenderer로 그린다.

import { T, joinList, localizeStatic } from './i18n.js';

const MAX_SHEET_ROWS = 3000;
const MAX_SHEET_COLS = 200;

const SUPPORTED = '한글(hwp, hwpx) · 워드(docx, doc) · 엑셀(xlsx, xls, csv) · 파워포인트(pptx, ppt) · PDF · CAD(dwg, dxf) · 기타(일러스트 ai, rtf, odt, odp)';

const $ = (id) => document.getElementById(id);
const bridge = window.DocViewer || null;

// 엔진(문서 그리기 라이브러리)이 칸·문단마다 경고를 내는 파일이 있다. 앱으로 넘어가는 콘솔 메시지는 하나하나 비용이 들어
// 화면 쪽 메시지는 문서마다 300개까지만 내보낸다(앱도 기기 기록에 200줄까지만 남긴다).
if (bridge) {
  let left = 300;
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[k].bind(console);
    console[k] = (...args) => {
      if (left-- > 0) orig(...args);
    };
  }
}

// 문서는 원래 크기로 그리고(앱이 웹뷰 글자 확대를 끔), 앱 버튼·안내 글자만 시스템 글자 크기를 따른다.
try {
  const scale = bridge && bridge.fontScale ? Number(bridge.fontScale()) : 1;
  if (scale > 1) document.documentElement.style.setProperty('--ui-scale', String(Math.min(scale, 1.6)));
} catch (_) {
  // 글자 크기를 못 읽으면 기본 크기로 둔다.
}

function report(state) {
  // 다 열었거나(표시·오류·비밀번호 입력) 시작 화면이면 여는 중 안내를 멈춘다.
  if (state && ['rendered', 'error', 'password', 'home'].includes(state.state)) stopSlowWatch();
  // PDF로 저장(printPlan)이 쓴다: 다 열었는지와 쪽·슬라이드 수(워드는 읽기 모드에서 쪽 모양으로 바꾸면 다시 알린다)
  if (state && state.state === 'rendered') {
    docInfo.rendered = true;
    if (state.pages) docInfo.pages = state.pages;
  }
  try {
    if (bridge) bridge.report(JSON.stringify(state));
  } catch (_) {
    // 진단용 보고가 실패해도 화면 표시는 계속한다.
  }
}

// 여는 중 안내: 오래 걸리면 단계별로 안내를 바꾸고(걸린 시간 표시) 다른 앱으로 넘길 길을 보여 준다.
// 화면 스크립트가 바쁘면(긴 워드 쪽 나누기 등) 이 안내도, 웹 화면의 버튼도 멈춘다. 그래서 1초마다 앱에 신호를 보내고,
// 신호가 끊기면 앱이 화면 위에 자체 버튼("다른 앱으로 열기")을 띄운다(ViewerActivity).
const SLOW_STAGES = [
  [5000, T('큰 문서는 여는 데 시간이 조금 걸려요.')],
  [15000, T('생각보다 오래 걸리고 있어요. 급하면 다른 앱으로 열어 보세요.')],
  [45000, T('아직 여는 중이에요. 휴대폰에 따라 몇 분 걸리기도 해요.')],
];
let slowWatch = null;

function startSlowWatch() {
  if (slowWatch) return;
  const started = Date.now();
  const tick = () => {
    const box = $('notice');
    // 여는 중 막대가 사라졌으면(문서 표시·오류·암호 안내 등으로 바뀜) 감시를 멈춘다.
    if (box.hidden || !box.querySelector('.progress')) {
      stopSlowWatch();
      return;
    }
    try {
      if (bridge && bridge.loadingAlive) bridge.loadingAlive();
    } catch (_) {
      // 앱이 신호를 받지 못해도 화면 안내는 계속한다.
    }
    const ms = Date.now() - started;
    const stage = SLOW_STAGES.filter(([t]) => ms >= t).pop();
    if (!stage) return;
    let hint = box.querySelector('.slow-hint');
    if (!hint) {
      hint = el('p', 'notice-sub slow-hint');
      box.append(hint);
    }
    hint.textContent = T('{msg} ({s}초째)', { msg: stage[1], s: Math.floor(ms / 1000) });
    if (canElsewhere() && !box.querySelector('.slow-elsewhere')) {
      const b = el('button', 'btn slow-elsewhere', T('다른 앱으로 열기'));
      b.type = 'button';
      b.addEventListener('click', openElsewhere);
      box.append(b);
    }
  };
  slowWatch = setInterval(tick, 1000);
  tick();
}

function stopSlowWatch() {
  if (!slowWatch) return;
  clearInterval(slowWatch);
  slowWatch = null;
  try {
    if (bridge && bridge.loadingDone) bridge.loadingDone();
  } catch (_) {
    // 무시
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function getBytes(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------- 안내 화면
// 못 여는 경우도 "오류 화면" 대신 파일 카드와 다음 할 일(다른 앱으로 열기)을 보여준다.
// 기술적인 원인은 접힌 "자세히" 안에만 둔다. 내용이 빠지거나 단순해진 경우는 숨기지 않고 작은 안내로 알린다.

// 지금 연 파일(이름·크기). main()이 채운다.
const docInfo = { name: '', size: 0, kind: '', rendered: false, pages: 0 };

const FILE_TONES = {
  hwp: 'hwp', hwpx: 'hwp', hwt: 'hwp', hml: 'hwp', cell: 'sheet', show: 'slides',
  doc: 'word', docx: 'word', docm: 'word', dot: 'word', dotx: 'word', dotm: 'word', rtf: 'word', odt: 'word',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', xlsb: 'sheet', xlt: 'sheet', xltx: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  ppt: 'slides', pptx: 'slides', pptm: 'slides', pps: 'slides', ppsx: 'slides', pot: 'slides', potx: 'slides', odp: 'slides',
  pdf: 'pdf',
};

function canElsewhere() {
  try {
    return !!(bridge && bridge.canOpenElsewhere());
  } catch (_) {
    return false;
  }
}

// 화면 스크립트가 멈춘 동안(긴 워드 쪽 나누기 등) 눌린 탭은 멈춤이 풀린 뒤 한꺼번에 처리된다. 문서가 뜨자마자
// 앱 고르기 창이 여러 번 튀어나오지 않게, 2초 넘게 밀린 탭은 버린다(멈춘 동안에는 앱이 띄운 버튼이 대신 받는다).
function freshTap(e) {
  return !e || typeof e.timeStamp !== 'number' || performance.now() - e.timeStamp < 2000;
}

function openElsewhere(e) {
  if (!freshTap(e)) return;
  if (bridge) bridge.openElsewhere();
}

function sizeText(bytes) {
  if (!(bytes > 0)) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 종이 모양 아이콘 + 확장자 띠
function fileBadge(name) {
  const ext = extOf(name);
  const badge = el('div', 'file-badge');
  badge.dataset.tone = FILE_TONES[ext] || 'other';
  badge.append(el('span', 'file-badge-ext', (ext || 'FILE').slice(0, 4).toUpperCase()));
  return badge;
}

function fileCard() {
  const card = el('div', 'file-card');
  card.append(fileBadge(docInfo.name));
  if (docInfo.name) card.append(el('p', 'file-name', docInfo.name));
  const size = sizeText(docInfo.size);
  if (size) card.append(el('p', 'file-meta', size));
  return card;
}

function resetView() {
  document.body.classList.remove('word-mode', 'slides-mode');
  document.documentElement.classList.remove('cad-mode');
  if (cadCtl) {
    cadCtl.destroy();
    cadCtl = null;
  }
  $('notice').classList.remove('home');
  clearNotices();
  $('find').hidden = true;
  $('menu-export').hidden = true;
  if (exportCtl) {
    exportCtl.destroy();
    exportCtl = null;
  }
  $('menu-original').hidden = true;
  const doc = $('doc');
  doc.className = '';
  doc.replaceChildren();
  doc.style.removeProperty('--page-zoom');
  doc.style.removeProperty('--page-base');
  document.documentElement.classList.remove('paged');
  $('tabs').hidden = true;
  $('pager').hidden = true;
  showNativeScrollbars(true);
}

// 웹뷰 기본 스크롤 막대. 쪽 문서는 오른쪽 쪽 이동 손잡이와 겹쳐 두 개로 보이므로 끈다.
function showNativeScrollbars(show) {
  if (bridge && bridge.showScrollbars) bridge.showScrollbars(show);
}

function showNotice(text, sub, actions) {
  resetView();
  const box = $('notice');
  box.replaceChildren();
  box.hidden = false;
  box.append(el('p', 'notice-text', text));
  if (sub) box.append(el('p', 'notice-sub', sub));
  if (actions && actions.length) {
    const row = el('div', 'actions');
    for (const [label, onClick, primary] of actions) {
      const b = el('button', primary ? 'btn btn-primary' : 'btn', label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      row.append(b);
    }
    box.append(row);
  }
}

function hideNotice() {
  $('notice').hidden = true;
}

// 여는 중: 파일 카드 + 움직이는 막대. 막대는 화면 합성 단계에서만 움직이므로(transform)
// 무거운 계산으로 스크립트가 잠시 멈춰도 계속 움직여 "멈춘 앱"처럼 보이지 않는다.
function showLoading(text, sub) {
  const box = $('notice');
  box.replaceChildren(fileCard());
  const bar = el('div', 'progress');
  bar.append(el('i'));
  box.append(bar, el('p', 'notice-text', text || T('여는 중이에요')));
  if (sub) box.append(el('p', 'notice-sub', sub));
  box.hidden = false;
  startSlowWatch();
}

// 못 여는 경우의 안내. reason: password·protected·unsupported·damaged·empty·complex·memory·read
function failWith(reason, title, body, tech) {
  resetView();
  const box = $('notice');
  box.replaceChildren(fileCard());
  box.hidden = false;
  box.append(el('p', 'notice-text', title));
  if (body) box.append(el('p', 'notice-sub', body));
  // 빈 파일은 다른 앱도 열 수 없으니 넘기는 버튼을 두지 않는다. 넘길 수 없는 경우(파일 고르기로 연 경우 등)에는 다른 파일을 고르게 한다.
  if (canElsewhere() && reason !== 'empty') {
    const b = el('button', 'btn btn-primary', T('다른 앱으로 열기'));
    b.type = 'button';
    b.addEventListener('click', openElsewhere);
    box.append(b);
  } else if (bridge && bridge.pickFile) {
    const b = el('button', 'btn', T('다른 파일 열기'));
    b.type = 'button';
    b.addEventListener('click', () => bridge.pickFile());
    box.append(b);
  }
  if (tech) {
    const more = el('details', 'tech');
    more.append(el('summary', null, T('자세히')), el('p', null, tech));
    box.append(more);
  }
  report({ state: 'error', reason, message: title, detail: body || '', tech: tech || '' });
}

// 사용자에게 보여줄 안내를 담은 오류(형식별 코드가 던지고 main()이 failWith로 보여준다)
function userError(reason, title, body, tech) {
  const err = new Error(title);
  err.userFacing = true;
  err.reason = reason;
  err.detail = body;
  err.tech = tech;
  return err;
}

// 화면 위쪽의 작은 안내 띠(간단 보기·서식 단순화·계산한 칸 등). 원래 모양은 다른 앱으로 볼 수 있게 한다.
function infoNote(text, withAction = true) {
  const note = el('div', 'info-note');
  note.append(el('span', 'info-note-icon', 'i'), el('span', 'info-note-text', text));
  if (withAction && canElsewhere()) {
    const b = el('button', 'info-note-action', T('다른 앱으로 열기'));
    b.type = 'button';
    b.addEventListener('click', openElsewhere);
    note.append(b);
  }
  return note;
}

// 안내 띠 + 그 자리에서 할 수 있는 동작 한 가지(숨긴 칸 보기 등)
function actionNote(text, label, onClick) {
  const note = el('div', 'info-note');
  note.append(el('span', 'info-note-icon', 'i'), el('span', 'info-note-text', text));
  const b = el('button', 'info-note-action', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  note.append(b);
  return note;
}

// 문서 안내(그리지 못한 것·읽기 모드·잘라 보여 준 것 등)는 문서 위에 띠로 쌓지 않고 위쪽 바 아래 한 줄로 접는다.
// 한 줄에는 가장 중요한 안내와 남은 개수만 보이고, 누르면 전체 목록(각 안내의 동작 버튼 포함)이 아래에서 올라온다.
// scope: 'doc'(문서 전체) · 'sheet'(지금 보는 시트, 시트를 바꾸면 바뀐다). priority가 높을수록 앞(한 줄 요약)에 온다:
// 3 내용을 잘라 보여 줌·읽기 모드, 2 보이지 않는 내용·간단한 방식, 1 그 밖의 알림.
function addNotice(note, { scope = 'doc', priority = Number(note.dataset.priority) || 1 } = {}) {
  note.dataset.scope = scope;
  note.dataset.priority = String(priority);
  const list = $('notes-list');
  const after = [...list.children].find((n) => Number(n.dataset.priority) < priority);
  list.insertBefore(note, after || null);
}

function clearNotices(scope) {
  for (const n of [...$('notes-list').children]) if (!scope || n.dataset.scope === scope) n.remove();
}

// 위쪽 안내 줄은 보이는 내용에 영향이 있을 때만(우선순위 2 이상: 표가 잘림·그리지 못한 것·다른 방식으로 엶·읽기 모드)
// 띄운다. 메모·노트·첨부·숨긴 행 같은 참고 안내(1)는 메뉴(⋮)의 "문서 안내"에서만 본다. 별일 아닌 것까지 문서 위에
// 경고처럼 띄우면 앱이 복잡하고 불안해 보인다(구글 드라이브는 띄우지 않는다).
function renderNotesStrip() {
  const items = [...$('notes-list').children];
  const strip = $('notes-strip');
  const menuItem = $('menu-notes');
  strip.hidden = !items.length || Number(items[0].dataset.priority) < 2;
  menuItem.hidden = !items.length;
  if (!items.length) {
    closeNotes();
    return;
  }
  const first = items[0].querySelector('.info-note-text');
  const text = first ? first.textContent : '';
  const more = items.length > 1 ? T('외 {n}개', { n: items.length - 1 }) : '';
  $('notes-strip-text').textContent = text;
  $('notes-strip-more').textContent = more;
  strip.setAttribute('aria-label', T('문서 안내 {n}개: {text}', { n: items.length, text }));
  menuItem.textContent = T('문서 안내 {n}개', { n: items.length });
  syncBarHeight();
}

function openNotes(e) {
  if (!freshTap(e) || !$('notes-list').children.length) return;
  $('notes-panel').hidden = false;
  $('notes-close').focus({ preventScroll: true });
}

function closeNotes() {
  $('notes-panel').hidden = true;
}

// 위쪽 바 메뉴(⋮): 문서에서 찾기(PDF)·원본 모양으로 보기(긴 워드)·문서 안내·파일 공유하기·연결 앱.
// 쓸 수 없는 항목은 숨긴다. 열린 동안 바깥을 누르면 그 누름은 문서로 가지 않고 메뉴만 닫힌다.
// 화면 층(#screen: 메뉴·문서 안내·칸 팝업·찾기 막대·쪽 이동 손잡이)을 보이는 영역에 붙인다. 웹뷰는 position: fixed를
// 화면이 아니라 "레이아웃 영역"에 붙이는데, 엑셀처럼 화면보다 작게 줄일 수 있는 문서에서는 이 영역이 시트 폭만큼 넓어져
// 100%에서도 메뉴가 화면 밖(오른쪽)에 열렸다. 두 손가락으로 확대·축소하면 fixed도 함께 커지고 작아진다.
// 층을 늘 보이는 영역 자리·크기로 옮기고 배율을 되돌린다(transform이 걸린 층이 안의 fixed의 기준이 된다).
function followScreen() {
  const vv = window.visualViewport;
  if (!vv) return;
  const layer = $('screen');
  let queued = false;
  let last = '';
  const update = () => {
    queued = false;
    const s = vv.scale;
    const t = `translate(${vv.offsetLeft}px, ${vv.offsetTop}px) scale(${1 / s})|${vv.width * s}x${vv.height * s}`;
    if (t === last) return;
    last = t;
    layer.style.transform = t.split('|')[0];
    layer.style.width = `${vv.width * s}px`;
    layer.style.height = `${vv.height * s}px`;
    // 엑셀이 아닌 문서의 위쪽 바도 확대한 동안 화면 크기 그대로 보이는 영역 맨 위에(엑셀은 followSheetViewport가 맡는다).
    // 문서 전체가 아니라 바에만 값을 넣는다(큰 표에서 문서 전체 스타일을 다시 계산하지 않게).
    const bar = $('bar');
    bar.style.setProperty('--vv-x', `${vv.offsetLeft}px`);
    bar.style.setProperty('--vv-y', `${vv.offsetTop}px`);
    bar.style.setProperty('--vv-z', String(1 / s));
    bar.classList.toggle('bar-zoomed', Math.abs(s - 1) > 0.001);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  update();
}

function setupMenu() {
  const btn = $('menu-btn');
  const menu = $('menu');
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    if (!freshTap(e)) return;
    if (!menu.hidden) {
      close();
      return;
    }
    $('menu-share').hidden = !canShare();
    $('menu-download').hidden = !canDownload();
    $('menu-print').hidden = !canPrint();
    $('menu-pdf').hidden = !canSavePdf();
    $('menu-cad-bg').hidden = !cadCtl;
    if (cadCtl) $('menu-cad-bg').textContent = cadCtl.background() === 'dark' ? T('흰 바탕으로 보기') : T('어두운 바탕으로 보기');
    $('open-elsewhere').hidden = !canElsewhere();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) close();
  });
  document.addEventListener('click', (e) => {
    const panel = $('notes-panel');
    if (!panel.hidden && !panel.contains(e.target) && !menu.contains(e.target)) {
      closeNotes();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const share = $('share-panel');
    if (!share.hidden && !share.contains(e.target)) {
      closeShare();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (menu.hidden || menu.contains(e.target) || btn.contains(e.target)) return;
    close();
    e.stopPropagation();
    e.preventDefault();
  }, true);
  $('menu-notes').addEventListener('click', openNotes);
  $('menu-share').addEventListener('click', shareFile);
  $('share-send').addEventListener('click', sendShare);
  $('share-cancel').addEventListener('click', closeShare);
  $('share-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    sendShare();
  });
  $('menu-download').addEventListener('click', downloadFile);
  $('menu-print').addEventListener('click', printDocument);
  $('menu-pdf').addEventListener('click', () => printPages('pdf'));
  $('menu-cad-bg').addEventListener('click', () => {
    if (!cadCtl) return;
    const next = cadCtl.background() === 'dark' ? 'paper' : 'dark';
    cadCtl.setBackground(next);
    try {
      localStorage.setItem('be-docs.cad-background', next);
    } catch (_) {
      // 기억하지 못해도 이번에는 바뀐다.
    }
  });
  $('open-elsewhere').addEventListener('click', openElsewhere);
  $('notes-strip').addEventListener('click', openNotes);
  $('notes-close').addEventListener('click', closeNotes);
  // 목록 안의 동작(원본 모양으로 보기·메모 보기·숨기기 취소 등)을 누르면 목록을 닫고 그 동작을 보여 준다.
  $('notes-panel').addEventListener('click', (e) => {
    if (e.target.closest('.info-note-action')) closeNotes();
  });
  new MutationObserver(renderNotesStrip).observe($('notes-list'), { childList: true, subtree: true, characterData: true });
  window.beDocsCloseMenu = close;
}

function canShare() {
  try {
    return !!(bridge && bridge.canShare && bridge.canShare());
  } catch (_) {
    return false;
  }
}

// 파일 공유하기: 받은 파일을 다른 앱(카카오톡·메일·드라이브 등)으로 보낸다. 보내기 전에 아래 시트에서 이름을 고칠 수 있다
// (확장자는 그대로, 종류가 바뀌지 않게). 이름을 그대로 두면 받은 파일을 그대로 보내고, 고치면 앱이 그 이름의 사본을 보낸다.
function splitName(name) {
  const m = /^(.+?)(\.[A-Za-z0-9]{1,10})$/.exec(name || '');
  return m ? [m[1], m[2]] : [name || '', ''];
}

// 파일 이름에 쓸 수 없는 글자(\ / : * ? " < > | 와 제어 문자)는 빈칸으로, 앞의 점은 뺀다.
function cleanFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
}

function shareFile(e) {
  if (!freshTap(e) || !bridge) return;
  if (!bridge.shareFileAs) {
    if (bridge.shareFile) bridge.shareFile();
    return;
  }
  const [base, ext] = splitName(docInfo.name || T('문서'));
  const input = $('share-input');
  input.value = base;
  $('share-ext').textContent = ext;
  $('share-panel').hidden = false;
  input.focus();
  input.setSelectionRange(0, input.value.length);
}

function closeShare() {
  $('share-input').blur();
  $('share-panel').hidden = true;
}

function sendShare() {
  const [base, ext] = splitName(docInfo.name || T('문서'));
  let typed = cleanFileName($('share-input').value);
  // 확장자까지 쳐 넣었으면 한 번만 붙인다
  if (ext && typed.toLowerCase().endsWith(ext.toLowerCase())) typed = typed.slice(0, -ext.length).trim();
  const name = (typed || base) + ext;
  closeShare();
  if (name === docInfo.name) bridge.shareFile();
  else bridge.shareFileAs(name);
}

function canDownload() {
  try {
    return !!(bridge && bridge.canDownload && bridge.canDownload());
  } catch (_) {
    return false;
  }
}

// 다운로드: 카톡 등에서 바로 연 파일(그 앱의 임시 공간에 있음)을 휴대폰의 다운로드 폴더에 남긴다.
// 앱이 열 때 받아 둔 원본을 그대로 저장하고, 저장한 이름은 앱이 알린다.
function downloadFile(e) {
  if (!freshTap(e)) return;
  if (bridge && bridge.download) bridge.download();
}

// 목록 팝업(메모·노트 보기). 뒤로 가기·닫기·바깥 누르기로 닫힌다.
// 팝업의 닫기 줄. 긴 목록(메모·라이선스)도 끝까지 내리지 않고 닫을 수 있게 상자 아래에 붙는다.
function popFoot(close) {
  const foot = el('div', 'cell-pop-foot');
  foot.append(close);
  return foot;
}

function showListPopup(title, items) {
  document.querySelector('.cell-pop')?.remove();
  const pop = el('div', 'cell-pop list-pop');
  pop.setAttribute('role', 'dialog');
  pop.append(el('div', 'cell-pop-addr', title));
  for (const it of items.slice(0, 500)) {
    const head = [it.where, it.who].filter(Boolean).join(' · ');
    if (head) pop.append(el('div', 'cell-pop-label', head));
    pop.append(el('div', 'cell-pop-text', it.text));
  }
  const close = el('button', 'btn', T('닫기'));
  close.type = 'button';
  pop.append(popFoot(close));
  const done = (e) => {
    if (pop.contains(e.target) && e.target !== close) return;
    e.stopPropagation();
    pop.remove();
    document.removeEventListener('click', done, true);
  };
  $('screen').append(pop);
  setTimeout(() => document.addEventListener('click', done, true), 0);
  close.focus({ preventScroll: true });
}

// 엔진이 그리지 않는 것 안내: readable = [[이름, 항목들]](글을 꺼내 "보기"로), lost = 그리지 못한 것들, info = 그 밖의 알림
function extrasNotes({ readable = [], lost = [], info = [] }) {
  const out = [];
  const has = readable.filter(([, items]) => items.length);
  if (has.length) {
    const label = joinList(has.map(([name, items]) => T('{name} {n}개', { name, n: items.length.toLocaleString() })));
    const all = has.flatMap(([name, items]) => items.map((it) => ({ ...it, where: [has.length > 1 ? name : '', it.where].filter(Boolean).join(' · ') })));
    const note = actionNote(T('{label}가 있어요.', { label }), T('보기'), () => showListPopup(label, all));
    note.classList.add('extras-note');
    note.dataset.priority = '1';
    out.push(note);
  }
  if (lost.length) {
    const note = infoNote(T('{list}는 표시되지 않아요.', { list: joinList(lost) }));
    note.classList.add('extras-note');
    note.dataset.priority = '2';
    out.push(note);
  }
  for (const [t, withAction] of info) {
    const note = infoNote(t, withAction);
    note.classList.add('extras-note');
    out.push(note);
  }
  return out;
}

// 형식별로 엔진이 그리지 않는 것을 파일에서 직접 세고(메모·노트는 글까지) 문서 위에 알린다. 실패해도 문서는 그대로 둔다.
async function addDocExtras(kind, bytes, container) {
  try {
    const mod = await import('./doc-extras.js');
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    let parts = null;
    if (zip) {
      // 압축은 작은 fflate로 푼다. 못 불러올 때만 SheetJS를 쓴다(약 1MB라 느린 휴대폰에서는 문서가 보인 직후 1초 남짓 멈춘다).
      if (!(await loadInflate())) await loadScript('vendor/xlsx.full.min.js');
      parts = lazyZip(window.XLSX, bytes);
    }
    let x = null;
    if (kind === 'word' && zip) {
      const e = mod.docxExtras(parts);
      x = { readable: [[T('메모'), e.comments]], lost: [], info: [] };
      if (e.objects) x.lost.push(T('삽입 개체(엑셀 표 등) {n}개', { n: e.objects }));
      if (e.metafiles) x.lost.push(T('EMF·WMF 그림 {n}개', { n: e.metafiles }));
      if (e.equations) x.lost.push(T('수식 {n}개', { n: e.equations }));
      if (e.altChunks) x.lost.push(T('다른 문서에서 가져온 내용 {n}개', { n: e.altChunks }));
      if (e.wordArt) x.lost.push(T('WordArt {n}개', { n: e.wordArt }));
      if (e.watermark) x.lost.push(T('워터마크'));
      if (e.tracked) x.info.push([T('적용하지 않은 변경 내용이 있어요. 모두 적용한 모습으로 보여요.'), false]);
    } else if (kind === 'word' && isOle(bytes)) {
      const n = mod.docObjects(bytes);
      if (n) x = { lost: [T('삽입 개체(엑셀 표 등) {n}개', { n })] };
    } else if (kind === 'slides' && zip) {
      const e = mod.pptxExtras(parts);
      x = {
        readable: [
          [T('발표자 노트'), e.notes.map((n) => ({ where: T('{n}번 슬라이드', { n: n.slide }), text: n.text }))],
          [T('메모'), e.comments.map((c) => ({ where: T('{n}번 슬라이드', { n: c.slide }), who: c.who, text: c.text }))],
        ],
        lost: e.objects ? [T('삽입 개체(엑셀 표 등) {n}개', { n: e.objects })] : [],
        info: e.hidden.length ? [[T('숨긴 슬라이드 {n}개({list}번)도 함께 보여요.', { n: e.hidden.length, list: joinList(e.hidden.slice(0, 8)) }), false]] : [],
      };
    } else if (kind === 'hwp') {
      let memos = [];
      if (zip) memos = mod.hwpxMemos(parts);
      else if (isOle(bytes)) {
        await loadScript('vendor/xlsx.full.min.js');
        memos = mod.hwp5Memos(window.XLSX, bytes);
      }
      x = { readable: [[T('메모'), memos]] };
    }
    if (!x) return;
    const notes = extrasNotes(x);
    if (notes.length && container.isConnected) {
      notes.forEach((n) => addNotice(n));
      report({ state: 'extras', kind, notes: notes.length });
    }
  } catch (e) {
    console.warn('문서 속 메모·개체를 읽지 못함', e);
  }
}

// "PDF 호환 파일 만들기"를 끄고 저장한 일러스트레이터 파일은 PDF 부분에 그림 대신
// "This is an Adobe Illustrator file that was saved without PDF content…" 안내 한 쪽만 들어 있다.
async function illustratorWithoutPdf(pdf) {
  try {
    if (pdf.numPages > 1) return false;
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
    return /saved\s+without\s+PDF\s+content/i.test(text.replace(/\s+/g, ' '));
  } catch (_) {
    return false;
  }
}

// PDF: 메모 주석(검토 의견)과 첨부 파일. 쪽이 많으면 앞 300쪽만 본다.
async function addPdfExtras(pdf, container) {
  try {
    const files = [];
    const notes = [];
    try {
      // pdf.js 6부터는 Map, 그 전에는 일반 객체로 돌려준다.
      const att = await pdf.getAttachments();
      const entries = att instanceof Map ? [...att.entries()] : Object.entries(att || {});
      for (const [k, v] of entries) files.push((v && v.filename) || k);
    } catch (_) {
      // 첨부 목록이 없거나 읽지 못하면 넘어간다.
    }
    const SKIP = new Set(['Link', 'Widget', 'FreeText', 'Popup']);
    // AutoCAD는 SHX 글꼴 글자를 선으로 그리면서, 검색되도록 같은 글자를 작성자 "AutoCAD SHX Text"인 주석으로 함께 넣는다.
    // 도면에 이미 보이는 글자이므로 메모로 세지 않는다(구글 드라이브·아크로뱃 설정처럼).
    const shx = (a) => /^autocad shx text$/i.test(((a.titleObj && a.titleObj.str) || a.title || '').trim());
    for (let i = 1; i <= Math.min(pdf.numPages, 300); i++) {
      const annots = await (await pdf.getPage(i)).getAnnotations({ intent: 'display' });
      for (const a of annots) {
        if (a.subtype === 'FileAttachment') files.push((a.file && a.file.filename) || T('첨부 파일'));
        else if (!SKIP.has(a.subtype) && !shx(a)) {
          const t = ((a.contentsObj && a.contentsObj.str) || a.contents || '').trim();
          if (t) notes.push({ where: T('{n}쪽', { n: i }), who: (a.titleObj && a.titleObj.str) || a.title || '', text: t });
        }
      }
    }
    const x = { readable: [[T('메모'), notes]], info: [] };
    if (files.length) {
      x.info.push([T('첨부 파일 {n}개({list}{more})가 있어요. 첨부 파일은 다른 앱에서 열어 주세요.', { n: files.length, list: files.slice(0, 3).join(', '), more: files.length > 3 ? T(' 등') : '' }), true]);
    }
    const out = extrasNotes(x);
    if (out.length && container.isConnected) {
      out.forEach((n) => addNotice(n));
      report({ state: 'extras', kind: 'pdf', notes: out.length });
    }
  } catch (e) {
    console.warn('PDF 메모·첨부를 읽지 못함', e);
  }
}

function showHome() {
  $('bar').hidden = true;
  const box = $('notice');
  box.replaceChildren();
  box.hidden = false;
  box.classList.add('home');
  const icon = el('img', 'home-icon');
  icon.src = 'app-icon.png';
  icon.alt = '';
  box.append(icon, el('h1', null, 'be docs'));
  box.append(el('p', 'notice-sub',
    T('광고 없는 가벼운 문서 뷰어\n받은 파일을 열 때 나오는 앱 목록에서 be docs를 고르세요.\n\n지원: 한글(hwp, hwpx) · 워드(docx, doc)\n엑셀(xlsx, xls, csv) · 파워포인트(pptx, ppt) · PDF\n도면: CAD(dwg, dxf) · 일러스트(ai)\n기타: rtf · odt · odp')));
  const b = el('button', 'btn btn-primary', T('파일 열기'));
  b.type = 'button';
  b.addEventListener('click', () => bridge && bridge.pickFile());
  box.append(b);
  const version = bridge && bridge.appVersion ? bridge.appVersion() : '';
  if (version) box.append(el('p', 'home-version', T('버전 {v}', { v: version })));
  const info = el('button', 'home-link', T('앱 정보·오픈소스 라이선스'));
  info.type = 'button';
  info.addEventListener('click', showAppInfo);
  box.append(info);
  report({ state: 'home' });
}

// 앱 정보: 개인정보 처리(아무것도 내보내지 않음), 한글 문서 형식 출처, 함께 넣은 오픈소스의 라이선스 전문(vendor/*.LICENSE.txt)
const APP_LICENSES = [
  ['rhwp', 'MIT', 'rhwp'], ['React', 'MIT', 'react'], ['@extend-ai/react-docx', 'MIT', 'react-docx'],
  ['@extend-ai/react-pptx', 'MIT', 'react-pptx'], ['pdf.js', 'Apache-2.0', 'pdfjs'], ['SheetJS Community Edition', 'Apache-2.0', 'xlsx'],
  ['fast-formula-parser', 'MIT', 'fast-formula-parser'], ['@formulajs/formulajs', 'MIT', 'formulajs'], ['fflate', 'MIT', 'fflate'],
  ['@noble/hashes', 'MIT', 'noble-hashes'], ['@noble/ciphers', 'MIT', 'noble-ciphers'], [T('Pretendard(글꼴)'), 'SIL OFL 1.1', 'pretendard'],
  ['LibreDWG (@mlightcad/libredwg-web)', 'GPL-3.0', 'libredwg'],
];

// be docs 자체의 라이선스. CAD 도면 엔진(LibreDWG)이 GPL-3.0이라 앱 전체를 GPL-3.0(또는 그 이후 판)으로 낸다.
// 소스는 공개 저장소에 판마다 올린다(scripts/publish-source.sh). 개발 저장소는 비공개로 둔다.
const APP_SOURCE_URL = 'https://github.com/squeecho/be-docs';

async function showAppInfo() {
  const items = [
    { where: T('개인정보'), text: T('be docs는 인터넷을 쓰지 않아요(인터넷 권한 없음). 연 문서는 휴대폰 안에서만 읽고 어디로도 보내지 않으며, 사용 기록이나 개인정보를 모으지 않아요. 파일 공유하기·다운로드·이미지로 변환(공유하기·사진첩에 저장)은 직접 고를 때만 해요.') },
    { where: T('한글 문서'), text: T('본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.') },
    {
      where: T('be docs 라이선스'),
      text: T('be docs는 자유 소프트웨어예요. GNU 일반 공중 사용 허가서(GPL) 3판 또는 그 이후 판에 따라 다시 배포하거나 고칠 수 있어요. 아무런 보증도 하지 않아요. 소스 코드: {url}', { url: APP_SOURCE_URL }),
    },
  ];
  const texts = await Promise.all(APP_LICENSES.map(([, , file]) => fetch(`vendor/${file}.LICENSE.txt`)
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '')));
  APP_LICENSES.forEach(([name, kind], i) => items.push({ where: `${name} — ${kind}`, text: texts[i].trim() || kind }));
  showListPopup(T('앱 정보·오픈소스 라이선스'), items);
}

// ---------------------------------------------------------------- 형식 판별

const EXT_HWP = new Set(['hwp', 'hwpx', 'hwt', 'hml', 'hwpml']);
const EXT_SHEET = new Set(['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'xlt', 'xlsb', 'ods']);
const EXT_SLIDES = new Set(['pptx', 'pptm', 'ppsx', 'potx', 'ppt', 'pps', 'pot']);
const EXT_TEXT = new Set(['csv', 'tsv', 'txt']);
const EXT_WORD = new Set(['doc', 'docx', 'docm', 'dotx', 'dotm', 'dot']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// 화면 쪽 압축 풀기는 fflate(MIT)로 한다. SheetJS의 압축 풀기는 깨진 데이터에서 끝나지 않거나(무한 반복)
// 메모리를 다 쓸 때까지 늘어나는데(1바이트 깨진 ODT에서 28초 멈춤), fflate는 바로 오류로 끝난다.
let safeInflate = null;
async function loadInflate() {
  if (!safeInflate) {
    try {
      safeInflate = (await import('./vendor/inflate.js')).inflateSync;
    } catch (e) {
      console.warn('inflate:', e);
    }
  }
  return safeInflate;
}

// ZIP에서 필요한 항목만 그때그때 푼다(전체를 풀면 큰 문서에서 화면이 굳는다). Map처럼 keys()·has()·get(이름)을 쓴다.
// 중앙 목록이 깨졌으면(항목 수가 모자라면) 파일 앞에서부터 항목 머리글을 직접 훑어 찾는다.
// 풀지 못한 항목은 null이다. 원래 크기만큼만 풀어 압축 폭탄으로 메모리가 터지지 않게 한다.
function lazyZip(XLSX, bytes, inflate = safeInflate) {
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const u32 = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  const entries = new Map();
  const dec = new TextDecoder();
  let listed = 0;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) !== 0x06054b50) continue;
    listed = u16(p + 10);
    let q = u32(p + 16);
    for (let i = 0; i < 20000 && q + 46 <= bytes.length && u32(q) === 0x02014b50; i++) {
      const len = u16(q + 28);
      const name = dec.decode(bytes.subarray(q + 46, q + 46 + len)).replace(/^\/+/, '').toLowerCase();
      entries.set(name, { method: u16(q + 10), csize: u32(q + 20), size: u32(q + 24), offset: u32(q + 42) });
      q += 46 + len + u16(q + 30) + u16(q + 32);
    }
    break;
  }
  if (entries.size < listed || !entries.size) {
    for (let p = 0, i = 0; p + 30 <= bytes.length && i < 20000 && u32(p) === 0x04034b50; i++) {
      const len = u16(p + 26);
      const start = p + 30 + len + u16(p + 28);
      let csize = u32(p + 18);
      let size = u32(p + 22);
      if ((u16(p + 6) & 8) && !csize) {
        // 크기가 항목 뒤(데이터 설명자 PK 07 08)에 적힌 경우: 설명자의 압축 크기가 지금까지의 거리와 맞거나,
        // 설명자 바로 뒤에 다음 항목 머리글이 오는 곳을 찾는다(설명자 숫자까지 깨진 파일이 있다).
        const next = (x) => x === 0x04034b50 || x === 0x02014b50;
        let d = start;
        while (d + 16 <= bytes.length && !(u32(d) === 0x08074b50 && (u32(d + 8) === d - start || next(u32(d + 16))))) d++;
        if (d + 16 > bytes.length) break;
        csize = d - start;
        size = u32(d + 12);
      }
      const name = dec.decode(bytes.subarray(p + 30, p + 30 + len)).replace(/^\/+/, '').toLowerCase();
      if (!entries.has(name)) entries.set(name, { method: u16(p + 8), csize, size, offset: p });
      p = start + csize;
      if (u32(p) === 0x08074b50) p += 16;
    }
  }
  const cache = new Map();
  return {
    keys: () => entries.keys(),
    has: (name) => entries.has(name.toLowerCase()),
    get(name) {
      const key = name.toLowerCase();
      if (cache.has(key)) return cache.get(key);
      const e = entries.get(key);
      let out = null;
      if (e && u32(e.offset) === 0x04034b50) {
        const start = e.offset + 30 + u16(e.offset + 26) + u16(e.offset + 28);
        const raw = bytes.subarray(start, start + e.csize);
        try {
          if (e.method === 0) out = raw;
          else if (e.method === 8 && inflate) out = inflate(raw, e.size ? { out: new Uint8Array(Math.min(e.size, 256 * 1024 * 1024)) } : undefined);
          else if (e.method === 8) out = Uint8Array.from(XLSX.CFB.utils._inflateRaw(raw, e.size));
        } catch (err) {
          console.warn(`압축 항목을 풀지 못함: ${key}`, err);
        }
      }
      cache.set(key, out);
      return out;
    },
  };
}

// ZIP 끝 표시(EOCD)에 적힌 항목 수가 실제 중앙 목록과 다르면(65535 등) 엑셀 엔진이 없는 항목을 수만 번 읽느라 20초 넘게 걸린다.
// 실제로 센 수로 고친 사본을 넘긴다(ZIP64 파일은 건드리지 않는다).
function repairZipCount(bytes) {
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const u32 = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) !== 0x06054b50) continue;
    if (p >= 20 && u32(p - 20) === 0x07064b50) return bytes;
    let n = 0;
    for (let q = u32(p + 16); n < 65535 && q + 46 <= bytes.length && u32(q) === 0x02014b50; n++) q += 46 + u16(q + 28) + u16(q + 30) + u16(q + 32);
    if (!n || (u16(p + 8) === n && u16(p + 10) === n)) return bytes;
    console.warn(`ZIP 항목 수 고침: ${u16(p + 10)} → ${n}`);
    const copy = bytes.slice();
    copy[p + 8] = n & 0xff;
    copy[p + 9] = n >> 8;
    copy[p + 10] = n & 0xff;
    copy[p + 11] = n >> 8;
    return copy;
  }
  return bytes;
}

// 문서 구조(Office·한글·OpenDocument)가 없는 그냥 압축 파일인지
function isPlainArchive(bytes) {
  const names = zipNames(bytes);
  return !!names && names.length > 0
    && !names.some((x) => /^(\[Content_Types\]\.xml|mimetype|Contents\/|word\/|xl\/|ppt\/|META-INF\/|version\.xml)/i.test(x));
}

// ZIP 안의 파일 이름 목록(끝의 중앙 목록에서 읽는다). 읽지 못하면 null.
function zipNames(bytes) {
  const n = bytes.length;
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const u32 = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  for (let p = n - 22; p >= Math.max(0, n - 65557); p--) {
    if (u32(p) !== 0x06054b50) continue;
    const names = [];
    let q = u32(p + 16);
    const decoder = new TextDecoder();
    for (let i = 0; i < 5000 && q + 46 <= n && u32(q) === 0x02014b50; i++) {
      const len = u16(q + 28);
      names.push(decoder.decode(bytes.subarray(q + 46, q + 46 + len)));
      q += 46 + len + u16(q + 30) + u16(q + 32);
    }
    return names;
  }
  return null;
}

function startsWith(bytes, sig) {
  return sig.every((b, i) => bytes[i] === b);
}

// 확장자보다 파일 내용(시그니처)을 우선한다. 카톡이 넘겨주는 이름·형식 정보가 틀릴 수 있어서다.
export function detectKind(head, name) {
  const ext = extOf(name);
  // UTF-8 머리 표시(BOM)는 떼고 본다(BOM이 붙은 HML을 .xls 이름으로 보내면 XML 판별이 빗나가 표로 열렸다).
  const text = latin1(head).replace(/^\xef\xbb\xbf/, '');
  if (text.slice(0, 1024).includes('%PDF-')) return 'pdf';
  // 일러스트레이터(.ai)는 "PDF 호환 파일 만들기"(기본값)로 저장하면 PDF라 위에서 PDF로 연다.
  // PostScript로 시작하면 일러스트레이터 8 이전 형식이나 EPS다(그리려면 PostScript 해석기가 있어야 해 열지 않는다).
  if ((ext === 'ai' || ext === 'eps' || ext === 'ps') && text.startsWith('%!PS')) return 'postscript';
  // CAD 도면: DWG는 판 표시("AC1015" 등)로 시작하고, DXF는 글자(SECTION으로 시작) 또는 이진 DXF다.
  if (/^AC1\d{3}/.test(text)) return 'cad';
  if (ext === 'dxf' && (/^\s*0\s*\r?\n\s*SECTION/.test(text) || text.startsWith('AutoCAD Binary DXF') || /^\s*999\s*\r?\n/.test(text))) return 'cad';
  // 한컴오피스의 한셀·한쇼 문서
  if (ext === 'cell' || ext === 'show') return 'hancom-other';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // OLE 컨테이너: HWP 5.0, 옛 엑셀(xls), 옛 파워포인트(ppt), 옛 워드(doc), 비밀번호 걸린 docx·xlsx·pptx
    if (EXT_WORD.has(ext)) return 'word';
    if (EXT_SHEET.has(ext)) return 'sheet';
    if (EXT_HWP.has(ext)) return 'hwp';
    if (EXT_SLIDES.has(ext)) return 'slides';
    return 'ole';
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    // ZIP 컨테이너: HWPX, xlsx, pptx, docx, OpenDocument
    if (text.includes('application/hwp+zip') || text.includes('Contents/')) return 'hwp';
    // mimetype 항목 바로 뒤에 다음 항목의 "PK" 서명이 붙어 있으므로 알려진 이름만 맞춘다.
    const odf = /application\/vnd\.oasis\.opendocument\.(spreadsheet|text|presentation|graphics)/.exec(text);
    if (odf) return { spreadsheet: 'sheet', text: 'odt', presentation: 'odp' }[odf[1]] || 'unknown';
    if (text.includes('word/')) return 'word';
    if (text.includes('xl/')) return 'sheet';
    if (text.includes('ppt/')) return 'slides';
    if (EXT_HWP.has(ext)) return 'hwp';
    if (EXT_SHEET.has(ext)) return 'sheet';
    if (EXT_SLIDES.has(ext)) return 'slides';
    if (EXT_WORD.has(ext)) return 'word';
    return 'zip';
  }
  if (text.startsWith('HWP Document File')) return 'hwp';
  if (/^\s*<\?xml/.test(text) && text.includes('HWPML')) return 'hwp';
  if (/^\s*<\?xml/.test(text) && text.includes('urn:schemas-microsoft-com:office:spreadsheet')) return 'sheet';
  if (text.startsWith('{\\rtf')) return 'rtf';
  if (/^\s*<\?xml/.test(text) && text.includes('schemas.microsoft.com/office/word/2003/wordml')) return 'wordxml';
  if (ext === 'rtf') return 'rtf';
  if (ext === 'odt') return 'odt';
  if (ext === 'odp') return 'odp';
  // 웹 시스템의 "워드 다운로드"는 HTML·MHT를 .doc 이름으로 주기도 한다.
  if (EXT_WORD.has(ext) && /^\s*(<!doctype html|<html|MIME-Version:)/i.test(text.slice(0, 2048).replace(/^\xef\xbb\xbf/, ''))) return 'webdoc';
  if (EXT_WORD.has(ext)) return 'word';
  if (EXT_TEXT.has(ext)) return 'csv';
  if (EXT_SHEET.has(ext)) return 'sheet';
  if (EXT_HWP.has(ext)) return 'hwp';
  if (EXT_SLIDES.has(ext)) return 'slides';
  return 'unknown';
}

// ---------------------------------------------------------------- 페이지 목록 (HWP·PDF 공용)

// 페이지 자리를 먼저 깔고, 화면 근처에 온 페이지만 그린다. 멀어진 페이지는 메모리를 위해 비운다.
function mountPages(sizes, loadPage, unloadPage) {
  const doc = $('doc');
  doc.className = 'pages';
  doc.replaceChildren();
  pageZoom = 1;
  doc.style.removeProperty('--page-zoom');
  document.documentElement.classList.add('paged');
  setPageBase();
  // 웹뷰로 확대해 둔 채 쪽 문서가 열리면 웹뷰 배율을 되돌린다(쪽 문서에서는 웹뷰 확대를 꺼서 손가락으로는 되돌릴 수 없다).
  const vv = window.visualViewport;
  if (vv && vv.scale > 1.01 && bridge && bridge.zoomBy) {
    try { bridge.zoomBy(1 / vv.scale); } catch (_) { /* 앱이 받지 못해도 쪽 확대는 쓸 수 있다 */ }
  }
  onPageZoomEnd = null;
  onPageResize = null;
  onPageGestureEnd = null;
  pageGesture = false;
  const pageEls = sizes.map(({ w, h }, i) => {
    const page = el('div', 'page');
    page.style.aspectRatio = `${w} / ${h}`;
    page.dataset.i = String(i);
    doc.append(page);
    return page;
  });

  const loaded = new Set();
  // 그리는 범위(near)와 비우는 범위(far)를 따로 둔다. 같으면 경계 근처에서 조금 올렸다 내리기만 해도
  // 비웠다가 다시 그려 "불러오는 중"이 다시 보였다.
  const near = (entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.i);
      if (e.isIntersecting && !loaded.has(i)) {
        loaded.add(i);
        loadPage(i, e.target);
      }
    }
  };
  const far = (entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.i);
      if (!e.isIntersecting && loaded.has(i)) {
        loaded.delete(i);
        unloadPage(i, e.target);
      }
    }
  };
  // 미리 그려 두는 범위는 화면 높이의 2배, 비우는 것은 3배 밖. 축소하면 한 화면에 쪽이 더 많이 들어오므로 범위를 그만큼 줄여
  // 그려 둔 쪽 수를 비슷하게 둔다(확대하면 쪽이 길어져 같은 범위에 드는 쪽이 저절로 적어진다).
  let ios = [];
  const watch = () => {
    ios.forEach((o) => o.disconnect());
    const z = Math.min(1, Math.max(pageZoom, PAGE_ZOOM_MIN));
    ios = [new IntersectionObserver(near, { rootMargin: `${Math.round(200 * z)}% 0px` }),
      new IntersectionObserver(far, { rootMargin: `${Math.round(300 * z)}% 0px` })];
    for (const o of ios) pageEls.forEach((p) => o.observe(p));
  };
  watch();
  pageZoomCtl = { pageEls, done: () => { watch(); if (onPageZoomEnd) onPageZoomEnd(); } };
  setupPageZoom();

  setupPager(pageEls);
  return pageEls;
}

// y(화면 좌표)에 걸친 쪽 번호. 쪽은 위에서 아래로 나열돼 있어 반씩 나눠 찾는다(쪽이 수백 개여도 가볍게).
function pageIndexAt(pageEls, y) {
  let lo = 0;
  let hi = pageEls.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pageEls[mid].getBoundingClientRect().bottom > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---------------------------------------------------------------- 쪽 문서 확대·축소(두 손가락)
// 쪽 문서(PDF·한글)는 확대·축소를 40%~800%(분할 화면은 더, pageZoomMax) 모두 앱이 직접 한다(쪽 폭을 바꾼다). 웹뷰의 확대는 끈다(html.paged).
// 예전에는 100% 아래는 앱이, 위는 웹뷰가 맡았는데, 둘 중 누가 맡을지는 손가락이 닿을 때 정해져서
// 60%에서 120%로 가려면 100%에서 손을 뗐다가 다시 벌려야 했다(한 동작으로 100%를 넘지 못함).
// 100%보다 크면 쪽이 화면보다 넓어져 옆으로도 스크롤한다. 손을 떼면 보이는 부분만 그 배율의 해상도로 다시 그린다(PDF detail).
const PAGE_ZOOM_MIN = 0.4;
const PAGE_ZOOM_MAX = 8;
// 분할 화면에서 창 폭 기준 800%보다 더 키울 때의 한도(아주 좁은 창에서 쪽이 끝없이 커지지 않게)
const PAGE_ZOOM_SPLIT_MAX = 24;
let pageZoom = 1;
let pageZoomCtl = null;
let onPageZoomEnd = null;
// PDF 쪽을 그림으로 내보내기 창(문서마다 새로 만든다. setupPdfExport)
let exportCtl = null;
let cadCtl = null; // CAD 도면 화면(cad-view.js)
// 쪽 폭이 바뀐 직후(두 손가락으로 줄이고 키우는 동안 매번). PDF는 여기서 글자 층을 새 폭에 맞춘다.
let onPageResize = null;
// 두 손가락이 닿아 있는 동안(쪽 문서). 이때는 쪽을 새로 그리기 시작하지 않고, 손을 떼면 onPageGestureEnd로 이어 그린다.
let pageGesture = false;
let onPageGestureEnd = null;

// 100%일 때의 쪽 폭(px, 넓은 화면에서도 1400px까지). 쪽 폭 = 이 값 × 배율. 바뀌었으면 true.
// 비율(%)이 아니라 px로 두는 까닭: 확대해 쪽이 화면보다 넓어지면 body도 그만큼 넓혀(fit-content) 위쪽 바(sticky)가
// 옆으로 스크롤해도 화면 왼쪽에 붙어 있게 하는데, 쪽 폭이 body 폭의 비율이면 서로를 따라 커진다.
function setPageBase() {
  const doc = $('doc');
  if (!doc.classList.contains('pages')) return false;
  const w = `${pageBaseFor(document.documentElement.clientWidth || window.innerWidth)}px`;
  if (doc.style.getPropertyValue('--page-base') === w) return false;
  doc.style.setProperty('--page-base', w);
  return true;
}

// 창 폭(px)에서 여백을 뺀 100% 쪽 폭(1400px까지)
function pageBaseFor(width) {
  const cs = getComputedStyle($('doc'));
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return Math.max(1, Math.min(1400, width - pad));
}

// 확대 한도: 이 화면을 창 하나가 다 쓸 때의 800% 크기까지. 앱이 그 창 폭(dp = CSS px)을 알려 준다.
// 폴드 안쪽 화면을 반씩 나눠 쓰면(분할 화면) 창 폭 기준 800%는 전체 화면 때의 절반 크기라 도면 글자가 덜 커졌다.
// 접은 바깥 화면·일반 휴대폰처럼 창이 화면을 다 쓰면 지금처럼 800%다.
function pageZoomMax() {
  let full = 0;
  try {
    full = Number(window.DocViewer && window.DocViewer.fullWindowWidth && window.DocViewer.fullWindowWidth()) || 0;
  } catch (e) {
    full = 0;
  }
  const base = pageBaseFor(document.documentElement.clientWidth || window.innerWidth);
  if (!(full > base)) return PAGE_ZOOM_MAX;
  return Math.min(PAGE_ZOOM_SPLIT_MAX, Math.max(PAGE_ZOOM_MAX, PAGE_ZOOM_MAX * pageBaseFor(full) / base));
}

// 화면 점(fx, fy)에 보이던 쪽의 같은 자리가 change()로 쪽 크기가 바뀐 뒤에도 그 점에 오게 스크롤을 맞춘다. 바뀐 뒤 그 쪽의 자리를 돌려준다.
function keepSpot(fx, fy, change) {
  const ctl = pageZoomCtl;
  if (!ctl || !ctl.pageEls.length) {
    change();
    return null;
  }
  const anchor = ctl.pageEls[pageIndexAt(ctl.pageEls, fy)];
  const before = anchor.getBoundingClientRect();
  const ax = before.width ? (fx - before.left) / before.width : 0;
  const ay = before.height ? (fy - before.top) / before.height : 0;
  if (change() === false) return before;
  const after = anchor.getBoundingClientRect();
  window.scrollBy(after.left + ax * after.width - fx, after.top + ay * after.height - fy);
  return after;
}

// 쪽 폭을 z배로 바꾸고, 손가락 사이(fx, fy: 화면 좌표)에 있던 쪽의 같은 자리를 손가락 아래에 둔다.
function setPageZoom(z, fx, fy) {
  if (!pageZoomCtl || !pageZoomCtl.pageEls.length) return;
  const doc = $('doc');
  const after = keepSpot(fx, fy, () => {
    pageZoom = z;
    doc.style.setProperty('--page-zoom', String(z));
    doc.classList.toggle('zoomed-out', z < 0.999);
  });
  if (onPageResize) onPageResize(after.width);
}

// 화면 폭이 바뀌면(돌리기·폴드 펼치기) 100%일 때의 쪽 폭을 다시 잰다. 보던 곳(화면 위쪽)은 그대로 보이게 한다.
// 쪽 폭이 px라 쪽 크기가 바뀌어도 브라우저가 스크롤 자리를 지켜 주지 않는다(scroll anchoring은 폭 값이 바뀌면 쉰다).
function onPagesResize() {
  if (!$('doc').classList.contains('pages')) return;
  keepSpot(window.innerWidth / 2, Math.min(120, window.innerHeight * 0.25), setPageBase);
  // 분할 화면에서 크게 키운 채 전체 화면으로 돌아오면 그 화면의 한도까지 줄인다.
  const max = pageZoomMax();
  if (pageZoom > max && pageZoomCtl) {
    setPageZoom(max, window.innerWidth / 2, Math.min(120, window.innerHeight * 0.25));
    pageZoomCtl.done();
  }
}

function setupPageZoom() {
  if (setupPageZoom.done) return;
  setupPageZoom.done = true;
  let pinch = null;
  let frame = 0;
  let pending = null;
  let focus = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const flush = () => {
    frame = 0;
    if (pending) {
      $('doc').style.setProperty('--pinch-k', String(pending.k));
      setPageZoom(pending.z, pending.x, pending.y);
    }
    pending = null;
  };
  window.addEventListener('resize', onPagesResize);
  // 손가락 입력은 기다리게 하지 않는다(passive). 화면이 다른 일(쪽 그리기)로 바빠도 스크롤이 바로 반응하게.
  // 웹뷰 확대는 화면 설정으로 막는다(html.paged { touch-action: pan-x pan-y }). 두 손가락을 함께 움직이는 스크롤은 웹뷰가 한다.
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2 && pageZoomCtl) pageGesture = true;
    if (e.touches.length !== 2) {
      if (e.touches.length > 2) pinch = null;
      return;
    }
    // 메뉴·문서 안내·이미지로 변환 창 위의 두 손가락은 문서를 확대하지 않는다.
    const onScreen = [...e.touches].some((t) => t.target && t.target.closest && t.target.closest('#screen'));
    if (!pageZoomCtl || !$('doc').classList.contains('pages') || onScreen || document.body.classList.contains('export-open')) {
      pinch = null;
      return;
    }
    const d = dist(e.touches);
    pinch = d > 10 ? { d0: d, z0: pageZoom, zf: pageZoom, on: false, max: pageZoomMax() } : null;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    const r = dist(e.touches) / pinch.d0;
    // 두 손가락으로 스크롤만 할 때 배율이 흔들리지 않게, 간격이 조금(3%) 바뀐 뒤부터 맡는다.
    if (!pinch.on) {
      if (Math.abs(r - 1) < 0.03) return;
      pinch.on = true;
    }
    // 손가락이 움직이는 동안은 글자 층(보이지 않는 글자 조각 수천 개)의 배치를 쉬고, 쪽 그림은 다시 그리지 않고 늘이기만 한다
    // (viewer.css .pages.pinching). 손을 떼면 한 번만 다시 배치하고 다시 그린다.
    const doc = $('doc');
    if (!doc.classList.contains('pinching')) {
      doc.style.setProperty('--pinch-k', '1');
      doc.classList.add('pinching');
    }
    focus = {
      x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
      y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
    };
    const z = Math.min(pinch.max, Math.max(PAGE_ZOOM_MIN, pinch.z0 * r));
    // 고정해 둔 크기(zf)에서 많이 줄면 그 크기로 다시 고정한다. 큰 크기 그대로 줄이면 새로 보이는 넓은 부분을
    // 큰 해상도로 그려야 해 오히려 느리다. 많이 키운 때도(3배) 너무 흐리지 않게 다시 고정한다.
    let k = z / pinch.zf;
    if (k < 0.7 || k > 3) {
      pinch.zf = z;
      k = 1;
    }
    pending = { z, k, x: focus.x, y: focus.y };
    if (!frame) frame = requestAnimationFrame(flush);
  }, { passive: true });
  const end = (e) => {
    if (e.touches.length < 2 && pageGesture) {
      pageGesture = false;
      if (onPageGestureEnd) setTimeout(onPageGestureEnd, 0);
    }
    if (e.touches.length < 2 && !(pinch && pinch.on)) stopPinching();
    if (!pinch || e.touches.length >= 2) return;
    const was = pinch;
    pinch = null;
    if (!was.on) return;
    if (frame) {
      cancelAnimationFrame(frame);
      flush();
    }
    // 화면 폭에 거의 맞으면(95~105%) 딱 맞춘다.
    if (pageZoom !== 1 && pageZoom > 0.95 && pageZoom < 1.05) {
      setPageZoom(1, focus ? focus.x : window.innerWidth / 2, focus ? focus.y : window.innerHeight / 2);
    }
    stopPinching();
    if (pageZoomCtl) pageZoomCtl.done();
    if (window.followPager) window.followPager(true);
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}

// 확대·축소한 채 화면을 두 번 톡 누르면 화면 폭에 맞춘 처음 크기로 돌아간다(구글 드라이브의 PDF 보기처럼).
// PDF·한글은 앱이 쪽 폭을 바꾸고(누른 자리를 그대로 두고), 엑셀·워드·PPT 등은 웹뷰 배율을 1로 되돌린다(앱 zoomBy).
// 버튼·링크·메뉴·안내 창 위에서 누른 것은 두 번 누름으로 보지 않는다. 처음 크기일 때는 아무것도 하지 않는다.
const DOUBLE_TAP_MS = 300;
const TAP_MOVE_PX = 12;
const DOUBLE_TAP_NEAR_PX = 48;

function setupDoubleTapReset() {
  let start = null;
  let last = null;
  const ignore = (t) => t && t.closest && t.closest('a, button, input, select, textarea, label, summary, [role="dialog"], #bar, #tabs, #screen, .notice, .findbar');
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) {
      start = null;
      last = null;
      return;
    }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, at: Date.now(), target: e.target, moved: false };
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', (e) => {
    if (!start) return;
    const t = e.touches[0];
    if (e.touches.length !== 1 || Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_MOVE_PX) start.moved = true;
  }, { passive: true, capture: true });
  document.addEventListener('touchend', (e) => {
    const tap = start;
    start = null;
    const now = Date.now();
    if (!tap || tap.moved || e.touches.length || now - tap.at > DOUBLE_TAP_MS || ignore(tap.target)) {
      last = null;
      return;
    }
    if (last && now - last.at < DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) < DOUBLE_TAP_NEAR_PX) {
      last = null;
      resetZoom(tap.x, tap.y);
      return;
    }
    last = { x: tap.x, y: tap.y, at: now };
  }, { passive: true, capture: true });
}

function resetZoom(x, y) {
  if (cadCtl) return cadCtl.reset();
  if ($('doc').classList.contains('pages') && pageZoomCtl && pageZoomCtl.pageEls.length) {
    if (Math.abs(pageZoom - 1) < 0.01) return false;
    setPageZoom(1, x, y);
    pageZoomCtl.done();
    if (window.followPager) window.followPager(true);
    return true;
  }
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) < 0.01 || !bridge || !bridge.zoomBy) return false;
  // 엑셀은 첫 번 누름에 칸 팝업이 열렸을 수 있다. 크기를 되돌리면서 닫는다.
  const pop = document.querySelector('.cell-pop');
  if (pop) pop.remove();
  try {
    bridge.zoomBy(1 / vv.scale);
  } catch (_) {
    return false;
  }
  return true;
}

function stopPinching() {
  const doc = $('doc');
  doc.classList.remove('pinching');
  doc.style.removeProperty('--pinch-k');
}

// ---------------------------------------------------------------- 쪽 이동 손잡이(오른쪽)
// 구글 드라이브의 PDF 보기처럼 움직이는 동안만 오른쪽에 손잡이가 나타나 "지금 쪽/전체 쪽"을 알리고,
// 손잡이를 끌면 문서의 그 위치로 간다. 화면 층(followScreen) 안에 있어 확대한 동안에도 화면 크기 그대로 오른쪽에 붙어 있다.
const SCROLLER_TOP = 72; // 위쪽 바 아래부터
const SCROLLER_BOTTOM = 24;
const THUMB_H = 56;
let pagerOff = null;

function setupPager(pageEls) {
  if (pagerOff) pagerOff();
  pagerOff = null;
  window.followPager = null;
  const pager = $('pager');
  if (pageEls.length < 2) {
    pager.hidden = true;
    return;
  }
  pager.hidden = false;
  pager.classList.add('idle');
  showNativeScrollbars(false);
  const label = $('pager-label');
  const thumb = $('pager-thumb');
  thumb.setAttribute('aria-valuemin', '1');
  thumb.setAttribute('aria-valuemax', String(pageEls.length));
  const vv = window.visualViewport;
  let timer = 0;
  let queued = false;
  let dragging = null;

  const geometry = () => {
    const scale = vv ? vv.scale : 1;
    const viewH = vv ? vv.height : window.innerHeight;
    const h = viewH * scale; // 손잡이 층의 높이(배율 1의 화면 높이)
    return {
      scale,
      h,
      top: vv ? vv.pageTop : window.scrollY,
      viewTop: vv ? vv.offsetTop : 0,
      viewH,
      max: Math.max(1, document.documentElement.scrollHeight - viewH),
      track: Math.max(1, h - SCROLLER_TOP - SCROLLER_BOTTOM - THUMB_H),
    };
  };
  const update = (show) => {
    queued = false;
    const g = geometry();
    const p = Math.min(1, Math.max(0, g.top / g.max));
    pager.style.setProperty('--thumb-y', `${Math.round(SCROLLER_TOP + p * g.track)}px`);
    // 맨 끝까지 내렸으면 마지막 쪽(마지막 쪽이 화면보다 짧아 위쪽 1/3 선에 닿지 않아도)
    const i = g.top >= g.max - 2 ? pageEls.length - 1 : pageIndexAt(pageEls, g.viewTop + g.viewH / 3);
    label.textContent = `${i + 1}/${pageEls.length}`;
    thumb.setAttribute('aria-valuenow', String(i + 1));
    if (show) {
      pager.classList.remove('idle');
      clearTimeout(timer);
      if (!dragging) timer = setTimeout(() => pager.classList.add('idle'), 1500);
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => update(true));
  };
  // 손잡이 층 안의 y. 손가락 좌표(clientY)는 확대와 상관없는 문서 화면 좌표라 보이는 영역 기준으로 바꾼다.
  const layerY = (e, g) => (e.clientY - g.viewTop) * g.scale;
  const onDown = (e) => {
    if (pager.classList.contains('idle')) return;
    e.preventDefault();
    try { thumb.setPointerCapture(e.pointerId); } catch (_) { /* 이미 끝난 손가락 */ }
    const g = geometry();
    const thumbTop = SCROLLER_TOP + Math.min(1, Math.max(0, g.top / g.max)) * g.track;
    dragging = { id: e.pointerId, grab: layerY(e, g) - thumbTop };
    pager.classList.add('dragging');
    clearTimeout(timer);
  };
  const onMove = (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    e.preventDefault();
    const g = geometry();
    const p = Math.min(1, Math.max(0, (layerY(e, g) - dragging.grab - SCROLLER_TOP) / g.track));
    window.scrollTo(window.scrollX, p * g.max - g.viewTop);
  };
  const onUp = (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    dragging = null;
    pager.classList.remove('dragging');
    update(true);
  };
  thumb.addEventListener('pointerdown', onDown);
  thumb.addEventListener('pointermove', onMove);
  thumb.addEventListener('pointerup', onUp);
  thumb.addEventListener('pointercancel', onUp);
  window.addEventListener('scroll', schedule, { passive: true });
  if (vv) {
    vv.addEventListener('scroll', schedule);
    vv.addEventListener('resize', schedule);
  }
  window.followPager = update;
  pagerOff = () => {
    clearTimeout(timer);
    thumb.removeEventListener('pointerdown', onDown);
    thumb.removeEventListener('pointermove', onMove);
    thumb.removeEventListener('pointerup', onUp);
    thumb.removeEventListener('pointercancel', onUp);
    window.removeEventListener('scroll', schedule);
    if (vv) {
      vv.removeEventListener('scroll', schedule);
      vv.removeEventListener('resize', schedule);
    }
  };
  update(false);
}

// 쪽 하나를 못 그렸을 때: 빨간 오류 대신 빈 종이에 안내와 "다시 시도"를 둔다.
function pageError(page, i, retry) {
  const box = el('div', 'page-error');
  box.append(el('p', null, T('{n}쪽 미리 보기를 만들지 못했어요', { n: i + 1 })));
  if (retry) {
    const b = el('button', 'btn', T('다시 시도'));
    b.type = 'button';
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      page.replaceChildren();
      retry();
    });
    box.append(b);
  }
  page.replaceChildren(box);
}

// ---------------------------------------------------------------- HWP·HWPX

// HWP 엔진은 hwp-worker.js(별도 스레드)에서 돈다. 큰 문서를 열거나 그리는 동안에도 화면이 굳지 않는다.
let hwpWorker = null;
let hwpSeq = 0;
const hwpPending = new Map();

function hwpCall(op, payload = {}, transfer = []) {
  if (!hwpWorker) {
    hwpWorker = new Worker(new URL('./hwp-worker.js', import.meta.url), { type: 'module' });
    hwpWorker.onmessage = ({ data }) => {
      const p = hwpPending.get(data.id);
      if (!p) return;
      hwpPending.delete(data.id);
      if (data.ok) p.resolve(data);
      else p.reject(new Error(data.error));
    };
    hwpWorker.onerror = (e) => {
      const err = new Error(`HWP 엔진 오류: ${e.message || '알 수 없음'}`);
      hwpPending.forEach((p) => p.reject(err));
      hwpPending.clear();
    };
  }
  const id = ++hwpSeq;
  return new Promise((resolve, reject) => {
    hwpPending.set(id, { resolve, reject });
    hwpWorker.postMessage({ id, op, ...payload }, transfer);
  });
}

// 비밀번호를 물어야 하는 오류인지. 손상된 HWP는 "잘못된 HWP3 암호 문서: 암호 본문이 없습니다"처럼 '암호'라는 말을 담아 와서
// 그 말만 보고 비밀번호를 물으면 없는 비밀번호를 찾게 된다. 비밀번호를 요구하는 오류만 고른다.
function isPasswordError(e) {
  const m = String(e && (e.message || e));
  if (/잘못된 HWP3 암호 문서|암호 본문이|블록 경계|본문이 없습니다|압축 해제 결과|시그니처/.test(m)) return false;
  return /비밀번호|암호화된 문서|암호 문서입니다|encrypt|password/i.test(m);
}

let wrongPasswords = 0;

function askPassword(wrong) {
  if (wrong) wrongPasswords++;
  return new Promise((resolve) => {
    resetView();
    const box = $('notice');
    box.replaceChildren(fileCard());
    box.hidden = false;
    // 두 번째부터는 몇 번째인지 적어 "눌렀는데 그대로"로 보이지 않게 한다.
    const title = wrong
      ? T('비밀번호가 맞지 않아요') + (wrongPasswords > 1 ? T(' ({n}번째)', { n: wrongPasswords }) : '')
      : T('비밀번호로 보호된 문서예요');
    const head = el('p', wrong ? 'notice-text pw-wrong' : 'notice-text', title);
    head.setAttribute('role', wrong ? 'alert' : 'status');
    box.append(head, el('p', 'notice-sub', wrong
      ? T('대소문자와 한/영 상태를 확인해 주세요.')
      : T('비밀번호를 입력하면 열려요.')));
    const form = el('form', 'pw-form');
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = T('비밀번호');
    input.setAttribute('aria-label', T('비밀번호'));
    const ok = el('button', 'btn btn-primary', T('열기'));
    ok.type = 'submit';
    const peek = el('button', 'btn pw-peek', T('보기'));
    peek.type = 'button';
    peek.setAttribute('aria-pressed', 'false');
    peek.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      peek.textContent = show ? T('숨기기') : T('보기');
      peek.setAttribute('aria-pressed', String(show));
      input.focus();
    });
    const hint = el('p', 'notice-sub pw-hint');
    form.append(input, ok, peek);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!input.value) {
        hint.textContent = T('비밀번호를 입력해 주세요.');
        input.focus();
        return;
      }
      showLoading(T('비밀번호를 확인하고 있어요'));
      setTimeout(() => resolve(input.value), 0);
    });
    box.append(form, hint);
    // 여러 번 틀리면 비밀번호를 다시 확인할 길과 다른 앱으로 넘길 길을 함께 보여 준다.
    if (wrongPasswords >= 3) {
      box.append(el('p', 'notice-sub', T('보낸 사람에게 비밀번호를 다시 물어보세요.')));
      if (canElsewhere()) {
        const b = el('button', 'btn', T('다른 앱으로 열기'));
        b.type = 'button';
        b.addEventListener('click', openElsewhere);
        box.append(b);
      }
    }
    input.focus();
    report({ state: 'password', wrong: wrongPasswords });
  });
}

// 문서를 여는 동안 움직이는 막대를 보여준다. 오래 걸릴 때의 안내와 "다른 앱으로 열기"는 startSlowWatch가 맡는다.
function showOpening(text) {
  showLoading(text);
  return () => {};
}

async function openHwp(bytes) {
  // 작업 스레드로 넘길 때는 복사본을 보낸다. 실패하면 같은 바이트로 엑셀·파워포인트를 시도하기 때문이다.
  const send = (password) => {
    const copy = bytes.slice();
    return hwpCall('open', { bytes: copy, password }, [copy.buffer]);
  };
  try {
    return await send(null);
  } catch (e) {
    if (!isPasswordError(e)) throw e;
  }
  // 망가진 옛 HWP는 머리글의 "암호" 표시가 켜져 있어 엔진이 비밀번호를 요구하기도 한다. 임시 비밀번호로 한 번 열어 보아
  // 암호 본문 자체가 없다고 나오면 손상된 파일로 안내한다(없는 비밀번호를 찾게 하지 않는다).
  try {
    return await send('\u0000be-docs-probe');
  } catch (e) {
    if (!isPasswordError(e)) throw e;
  }
  for (let wrong = false; ; wrong = true) {
    const pw = await askPassword(wrong);
    try {
      return await send(pw);
    } catch (e) {
      if (!/일치하지 않|password/i.test(String(e && (e.message || e)))) throw e;
    }
  }
}

async function showHwp(bytes) {
  const stopTimer = showOpening();
  let opened;
  try {
    opened = await openHwp(bytes);
  } finally {
    stopTimer();
  }
  const { pages: count, sizes } = opened;
  if (!count) throw new Error('빈 문서');
  hideNotice();
  hwpPrint = { count, sizes };

  // 페이지 SVG는 <img>로 띄운다. 페이지마다 id가 겹쳐도 서로 섞이지 않고, SVG 안의 스크립트도 실행되지 않는다.
  const urls = new Map();
  const queue = [];
  let busy = false;
  let renderedOnce = false;

  const dist = (p) => {
    const r = p.getBoundingClientRect();
    return Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
  };

  const pump = async () => {
    if (busy || pageGesture || !queue.length) return;
    busy = true;
    // 화면 중앙에서 가까운 페이지부터 그린다.
    queue.sort((a, b) => dist(a.page) - dist(b.page));
    const { i, page } = queue.shift();
    try {
      const { svg } = await hwpCall('render', { page: i });
      if (page.isConnected && !urls.has(i) && page.dataset.wanted === '1') {
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        urls.set(i, url);
        const img = el('img');
        img.alt = T('{n}쪽', { n: i + 1 });
        img.decoding = 'async';
        img.src = url;
        page.replaceChildren(img);
        if (!renderedOnce) {
          renderedOnce = true;
          report({ state: 'rendered', kind: 'hwp', pages: count });
          addDocExtras('hwp', bytes, $('doc'));
        }
      }
    } catch (e) {
      pageError(page, i, () => {
        if (page.dataset.wanted !== '1') return;
        queue.push({ i, page });
        pump();
      });
      report({ state: 'page-error', kind: 'hwp', page: i, detail: String(e) });
    }
    busy = false;
    pump();
  };

  mountPages(sizes, (i, page) => {
    page.dataset.wanted = '1';
    queue.push({ i, page });
    pump();
  }, (i, page) => {
    page.dataset.wanted = '0';
    const qi = queue.findIndex((q) => q.i === i);
    if (qi >= 0) queue.splice(qi, 1);
    const url = urls.get(i);
    if (url) { URL.revokeObjectURL(url); urls.delete(i); }
    page.replaceChildren();
  });
  onPageGestureEnd = pump;
}

// ---------------------------------------------------------------- 인쇄·PDF로 저장(한글·워드·엑셀·PPT·간단 보기), PDF 문서 인쇄
// 둘 다 안드로이드 인쇄 창(웹뷰 인쇄 + PrintManager)을 연다. 인쇄는 프린터를, PDF로 저장은 프린터 목록의 "PDF로 저장"을 고른다
// (인쇄 창은 지난번에 고른 곳을 기억해 앱이 미리 고를 수 없다). 글자는 글자 그대로 들어가 PDF에서 고르고 찾을 수 있고,
// 한글 쪽은 SVG라 확대해도 깨지지 않는다. PDF 문서는 이미 PDF라 "PDF로 저장"은 내지 않고(다운로드로 저장),
// 인쇄는 받아 둔 원본 PDF를 그대로 넘긴다(printPdfFile).
// 인쇄 직전에 문서 종류마다 인쇄용 모양을 준비하고(printPlan), 인쇄할 때만 그 모양이 된다(viewer.css의 @media print).
// 앱이 인쇄 창을 닫으면 window.beDocsPrintDone()을 불러 화면을 원래대로 돌린다.
const MM_PER_PX = 25.4 / 96;
const MM_PER_PT = 25.4 / 72;
let printing = false;
let hwpPrint = null;
// PDF 문서 인쇄: 첫 쪽 크기(pt), 작성자가 인쇄를 막았는지, 열기 비밀번호가 걸렸는지(인쇄 창이 원본을 열지 못한다)
let pdfPrint = null;

// 안드로이드 "PDF로 저장"은 정해 둔 종이 크기만 받고, 목록에 없는 크기(슬라이드 16:9 등)는 기본 종이(한국은 A4)로 바꾼다
// (AOSP PrintSpooler PrintActivity: createFakePdfPrinter·updatePrintAttributesFromCapabilities).
// 그래서 문서 쪽이 흔한 종이(±3mm)면 그 종이로, 아니면 같은 방향의 A4로 고르고 쪽을 그 종이에 맞춰 담는다.
// 앱(ViewerActivity.mediaFor)도 같은 종이를 안드로이드의 정해 둔 크기로 넘긴다.
const PAPERS = [[210, 297], [297, 420], [148, 210], [250, 353], [176, 250], [257, 364], [182, 257], [215.9, 279.4], [215.9, 355.6], [279.4, 431.8]];

function paperFor(w, h) {
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  const [ps, pl] = PAPERS.find(([a, b]) => Math.abs(a - short) < 3 && Math.abs(b - long) < 3) || PAPERS[0];
  return w > h ? { w: pl, h: ps } : { w: ps, h: pl };
}

function canSavePdf() {
  return !printing && !!(bridge && bridge.printPdf) && docInfo.rendered && docInfo.kind !== 'pdf' && !!printPlan();
}

function canPrint() {
  if (docInfo.kind === 'pdf') return !printing && !!(bridge && bridge.printFile) && docInfo.rendered && !!pdfPrint;
  return canSavePdf();
}

function printDocument() {
  if (docInfo.kind === 'pdf') printPdfFile();
  else printPages('print');
}

// PDF 문서 인쇄: 화면에 그린 것이 아니라 받아 둔 원본 PDF를 앱이 그대로 인쇄 창에 넘긴다(모든 쪽·원래 화질, 쪽 맞춤은 인쇄 창이).
function printPdfFile() {
  if (printing || !pdfPrint) return;
  if (pdfPrint.blocked) {
    printWait().fail(T('작성자가 인쇄를 막아 둔 문서예요.'));
    return;
  }
  if (pdfPrint.password) {
    printWait().fail(T('비밀번호로 보호된 PDF는 여기서 인쇄할 수 없어요. 다른 앱에서 열어 인쇄해 주세요.'));
    return;
  }
  const page = paperFor(pdfPrint.w * MM_PER_PT, pdfPrint.h * MM_PER_PT);
  printing = true;
  window.beDocsPrintDone = () => {
    window.beDocsPrintDone = null;
    printing = false;
  };
  let ok = false;
  try {
    ok = bridge.printFile(splitName(docInfo.name || '')[0] || 'be docs', page.w, page.h, docInfo.pages || 0);
  } catch (e) {
    console.warn('인쇄 창을 열지 못함', e);
  }
  if (!ok) {
    window.beDocsPrintDone = null;
    printing = false;
    printWait().fail(T('인쇄 창을 열지 못했어요. 다시 해 보세요.'));
    return;
  }
  report({ state: 'print', mode: 'pdf-file' });
}

function printPlan(mode = 'pdf') {
  const doc = $('doc');
  if (docInfo.kind === 'hwp' && hwpPrint) return hwpPrintPlan(hwpPrint);
  const host = doc.querySelector('.word-host');
  if (host && host.querySelector('[data-docx-page-index]')) return wordPagesPlan(host);
  const slides = doc.querySelector('.slides-host');
  // 프린터는 종이 가장자리를 찍지 못해 인쇄할 때는 슬라이드 둘레에 10mm를 둔다(PDF는 종이 가득)
  if (slides && slides.querySelector('.rpv-normalized-slide')) return slidesPlan(slides, mode === 'print' ? 10 : 0);
  const sheet = doc.querySelector('.sheet');
  if (sheet && document.body.classList.contains('sheet-mode')) return sheetPlan(sheet);
  // 워드 읽기 모드·간단 보기(txt·RTF·ODT 등)·웹 페이지 .doc: 글 흐름 그대로 A4에 이어서
  if (doc.querySelector('.simple-doc, .webdoc-host')) return { mode: 'flow', page: { w: 210, h: 297 }, margin: 15, prepare: async () => {}, cleanup: () => {} };
  return null;
}

// 한글: 모든 쪽을 그린 인쇄용 사본을 따로 만든다. 화면의 쪽은 보이는 근처만 그려 두고, 확대 상태와도 상관없게.
function hwpPrintPlan({ count, sizes }) {
  const urls = [];
  return {
    mode: 'sheets',
    page: paperFor(sizes[0].w * MM_PER_PX, sizes[0].h * MM_PER_PX),
    margin: 0,
    prepare: async (progress) => {
      const root = printRoot();
      const imgs = [];
      for (let i = 0; i < count; i++) {
        const { svg } = await hwpCall('render', { page: i });
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        urls.push(url);
        const img = el('img');
        img.alt = '';
        img.src = url;
        const sheet = el('div', 'print-sheet');
        sheet.append(img);
        root.append(sheet);
        imgs.push(img);
        progress(i + 1, count);
      }
      await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
    },
    cleanup: () => {
      const root = $('print-root');
      if (root) root.remove();
      urls.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}

function printRoot() {
  const old = $('print-root');
  if (old) old.remove();
  const root = el('div');
  root.id = 'print-root';
  document.body.append(root);
  return root;
}

// 워드(쪽 모양): 엔진은 화면 근처의 쪽만 그린다. 인쇄하는 동안만 모든 쪽을 그리게 하고, 화면 폭 맞춤 배율을 풀어 한 쪽 = 종이 한 장.
// 쪽이 종이보다 크면(흔한 종이가 아닌 큰 쪽) 종이에 맞춰 줄인다.
function wordPagesPlan(host) {
  const first = host.querySelector('[data-docx-page-index]');
  const w = parseFloat(first.style.width) || 793.7;
  const h = parseFloat(first.style.minHeight) || parseFloat(first.style.height) || 1122.5;
  const page = paperFor(w * MM_PER_PX, h * MM_PER_PX);
  let mod = null;
  return {
    mode: 'word-pages',
    page,
    margin: 0,
    prepare: async (progress) => {
      host.style.setProperty('--print-fit', String(Math.min(1, page.w / (w * MM_PER_PX), page.h / (h * MM_PER_PX))));
      mod = await import('./vendor/docx-view.js');
      if (!mod.setAllPages || !mod.setAllPages(host, true)) return;
      await waitAll(() => host.querySelectorAll('[data-docx-page-index]').length, docInfo.pages, progress);
    },
    cleanup: () => {
      host.style.removeProperty('--print-fit');
      if (mod && mod.setAllPages) mod.setAllPages(host, false);
    },
  };
}

// PPT: 슬라이드 한 장 = 종이 한 장. 슬라이드 크기(16:9 등)는 안드로이드 PDF 종이 목록에 없어 가로 A4에 맞춰 키우고 가운데에 둔다
// (파워포인트에서 슬라이드를 A4에 인쇄할 때처럼). margin(mm): 종이 둘레 여백. 엔진은 화면 근처의 슬라이드만 그리므로 인쇄하는 동안만 모두 그린다.
function slidesPlan(host, margin) {
  const slide = host.querySelector('.rpv-normalized-slide');
  const w = (parseFloat(slide.style.width) || 960) * MM_PER_PX;
  const h = (parseFloat(slide.style.height) || 540) * MM_PER_PX;
  const page = paperFor(w, h);
  const areaW = page.w - 2 * margin;
  const areaH = page.h - 2 * margin;
  // 종이를 꽉 채우면 반올림으로 다음 쪽에 넘쳐 빈 쪽이 낄 수 있어 1% 덜 키운다
  const fit = Math.min(areaW / w, areaH / h) * 0.99;
  let mod = null;
  return {
    mode: 'slides',
    page,
    margin,
    prepare: async (progress) => {
      host.style.setProperty('--print-fit', String(fit));
      host.style.setProperty('--print-top', `${((areaH - h * fit) / 2).toFixed(2)}mm`);
      mod = await import('./vendor/pptx-view.js');
      if (!mod.setAllSlides || !mod.setAllSlides(host, true)) return;
      await waitAll(() => host.querySelectorAll('.rpv-normalized-slide').length, docInfo.pages, progress);
    },
    cleanup: () => {
      host.style.removeProperty('--print-fit');
      host.style.removeProperty('--print-top');
      if (mod && mod.setAllSlides) mod.setAllSlides(host, false);
    },
  };
}

// 엑셀: 지금 보는 시트를 끝까지 그리고 가로 A4 폭에 맞춰 줄인다(넓은 표가 잘리지 않게).
function sheetPlan(sheet) {
  return {
    mode: 'sheet',
    page: { w: 297, h: 210 },
    margin: 10,
    prepare: async () => {
      if (sheet.renderUntil) sheet.renderUntil(Number.MAX_SAFE_INTEGER);
      await nextPaint();
      const width = Math.max(1, ...[...sheet.querySelectorAll('table')].map((t) => t.scrollWidth));
      const avail = (297 - 20) / MM_PER_PX;
      sheet.style.setProperty('--print-zoom', String(Math.min(1, avail / width)));
    },
    cleanup: () => sheet.style.removeProperty('--print-zoom'),
  };
}

// 엔진이 모든 쪽을 그릴 때까지 기다린다(쪽 수를 모르면 잠깐만). 늦어져도 그린 데까지 인쇄한다.
async function waitAll(count, total, progress, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    await nextPaint();
    const n = count();
    if (total) progress(Math.min(n, total), total);
    if (!total || n >= total || Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// mode: 'print'(인쇄) | 'pdf'(PDF로 저장). 같은 인쇄 창을 연다.
async function printPages(mode) {
  if (printing) return;
  const plan = printPlan(mode);
  if (!plan || !bridge || !bridge.printPdf) return;
  printing = true;
  const toPrint = mode === 'print';
  const wait = printWait(toPrint ? T('인쇄할 준비를 하고 있어요…') : T('PDF로 저장할 준비를 하고 있어요…'));
  const html = document.documentElement;
  try {
    await plan.prepare((done, total) => wait.update(toPrint
      ? T('인쇄할 준비를 하고 있어요… ({done}/{total})', { done, total })
      : T('PDF로 저장할 준비를 하고 있어요… ({done}/{total})', { done, total })));
    const rule = el('style');
    rule.id = 'print-page';
    rule.textContent = `@page { size: ${plan.page.w.toFixed(1)}mm ${plan.page.h.toFixed(1)}mm; margin: ${plan.margin}mm; }`;
    document.head.append(rule);
    html.classList.add('printing', `print-${plan.mode}`);
    await nextPaint();
    wait.close();
    const finished = new Promise((resolve) => { window.beDocsPrintDone = resolve; });
    const name = splitName(docInfo.name || '')[0] || 'be docs';
    if (!bridge.printPdf(name, plan.page.w, plan.page.h)) throw new Error('인쇄 창을 열지 못함');
    report({ state: 'print', mode: plan.mode, to: mode });
    await finished;
  } catch (e) {
    console.warn('인쇄·PDF로 저장하지 못함', e);
    wait.fail(toPrint ? T('인쇄 창을 열지 못했어요. 다시 해 보세요.') : T('PDF로 저장하지 못했어요. 다시 해 보세요.'));
  } finally {
    window.beDocsPrintDone = null;
    html.classList.remove('printing', `print-${plan.mode}`);
    const rule = $('print-page');
    if (rule) rule.remove();
    try {
      plan.cleanup();
    } catch (e) {
      console.warn('인쇄 정리', e);
    }
    printing = false;
  }
}

// 준비하는 동안(한글·워드는 모든 쪽을 그린다) 화면 아래에 띄우는 안내. 글 없이 만들면 fail(글)로 알림만 잠깐 띄운다.
function printWait(text = '') {
  const box = el('div', 'print-wait');
  box.setAttribute('role', 'status');
  box.textContent = text;
  if (text) $('screen').append(box);
  let timer = 0;
  return {
    update: (msg) => {
      box.textContent = msg;
    },
    fail: (msg) => {
      box.textContent = msg;
      if (!box.isConnected) $('screen').append(box);
      clearTimeout(timer);
      timer = setTimeout(() => box.remove(), 3000);
    },
    close: () => {
      if (!timer) box.remove();
    },
  };
}

// ---------------------------------------------------------------- PDF

function pdfTargetWidth() {
  const css = document.documentElement.clientWidth || window.innerWidth;
  return Math.max(600, Math.min(2560, Math.round(css * (window.devicePixelRatio || 1) * 1.5)));
}

// PDF는 pdf.js(Firefox의 PDF 엔진)로 그린다. 안드로이드 내장 렌더러는 도장·서식 칸 값·메모 같은 주석을 그리지 않고
// 글자를 고를 수 없어서다. pdf.js가 열지 못하는 파일은 안드로이드 내장 렌더러로 다시 시도한다.
let pdfjsLib = null;

async function loadPdfjs() {
  if (!pdfjsLib) {
    // 오래된 웹뷰에 없는 기능부터 채운다(작업 스레드는 pdf-worker.js가 같은 일을 한다).
    await import('./pdf-polyfills.js');
    pdfjsLib = await import('./vendor/pdfjs/pdf.mjs');
    // 절대 주소로 준다. 작업 스레드를 못 띄울 때 pdf.js가 이 주소를 import()하는데, 상대 이름은 거기서 풀리지 않는다.
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf-worker.js', import.meta.url).href;
  }
  return pdfjsLib;
}

async function showPdf() {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (e) {
    console.warn('pdf.js 불러오기 실패, 내장 렌더러 사용', e);
    return showPdfNative();
  }
  const bytes = await getBytes('/doc/file');
  const illustrator = extOf(docInfo.name) === 'ai';
  const stopTimer = showOpening(illustrator ? T('일러스트레이터 파일을 여는 중이에요') : undefined);
  let pdf;
  let askedPassword = false;
  try {
    const task = pdfjs.getDocument({
      data: bytes,
      cMapUrl: 'vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
      wasmUrl: 'vendor/pdfjs/wasm/',
      isEvalSupported: false,
      enableXfa: false,
    });
    // 열기 비밀번호가 걸린 PDF는 한글 문서처럼 비밀번호를 물어본다.
    task.onPassword = (update, reason) => {
      stopTimer();
      askedPassword = true;
      askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then(update);
    };
    pdf = await task.promise;
  } catch (e) {
    stopTimer();
    console.warn('pdf.js가 열지 못함, 내장 렌더러로 다시 시도', e);
    return showPdfNative();
  }

  // 쪽 크기(포인트). 쪽마다 다를 수 있다(가로·세로·A3 섞임). 쪽이 많으면 몇 초 걸려 경과 시간 표시를 그 뒤에 끈다.
  const sizes = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const v = (await pdf.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ w: v.width, h: v.height });
    }
  } finally {
    stopTimer();
  }
  if (!sizes.length) throw new Error('빈 문서');
  if (illustrator && await illustratorWithoutPdf(pdf)) {
    failWith('unsupported', T('PDF 호환 없이 저장된 일러스트레이터 파일이에요'),
      T('보낸 사람에게 일러스트레이터에서 "PDF 호환 파일 만들기"를 켜고 다시 저장해 달라고 하세요. 다른 앱으로 열어도 같은 안내만 보일 수 있어요.'),
      T('PDF 부분에 그림 대신 안내 글만 있음'));
    return;
  }
  hideNotice();
  if (illustrator) {
    const note = infoNote(T('일러스트레이터 파일은 함께 저장된 PDF 미리보기로 보여 줘요. 레이어·아트보드 밖의 개체·편집 정보는 보이지 않을 수 있어요.'), false);
    note.dataset.priority = '2';
    addNotice(note);
    renderNotesStrip();
  }

  let pixelWidth = pdfCanvasWidth();
  let renderedOnce = false;
  const tasks = new Map();
  // 쪽은 한 번에 하나씩, 화면 가운데에 가까운 쪽부터 그린다. 사진이 많은 쪽은 하나에 몇 초씩 화면 처리를 붙잡는데,
  // 줄여서 여러 쪽이 한꺼번에 들어오면 동시에 다 그리느라 두 손가락 확대·축소가 수십 초 먹히지 않았다(고정된 것처럼).
  // 두 손가락을 대고 있는 동안에는 새로 그리기 시작하지 않는다(pageGesture).
  // 확대해 보고 있는 부분을 선명하게 다시 그리는 일(detail)이 있으면 그것부터 한다(지금 보고 있는 곳).
  const wanted = new Map();
  let drawing = false;
  let detail = null;
  // 지나간 쪽의 작은 그림(가로 640px JPG, 한 장 수십 KB). 메모리를 아끼려고 멀어진 쪽을 비울 때 이것을 대신 둔다.
  // 되돌아오면 바로 보이고(흐린 듯 잠깐), 선명한 그림을 다 그리면 바꿔 끼운다. 쪽 번호 → { url, from: 원본 폭 }
  const snaps = new Map();
  const smallCopy = (canvas) => {
    const w = Math.min(640, canvas.width);
    const h = Math.max(1, Math.round((canvas.height * w) / canvas.width));
    const c = el('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return c;
  };
  const snapImg = (url) => {
    const img = el('img', 'pdf-snap');
    img.alt = '';
    img.decoding = 'async';
    img.src = url;
    return img;
  };
  const keepSnap = (i, canvas, pageEl) => {
    const cur = snaps.get(i);
    if (cur && cur.from >= canvas.width * 0.66) return;
    const c = smallCopy(canvas);
    const from = canvas.width;
    c.toBlob((blob) => {
      freeCanvas(c);
      if (!blob) return;
      const prev = snaps.get(i);
      if (prev) URL.revokeObjectURL(prev.url);
      snaps.delete(i);
      const url = URL.createObjectURL(blob);
      snaps.set(i, { url, from });
      // 아주 긴 문서는 오래된 것부터 놓아준다(400장, 약 20MB)
      if (snaps.size > 400) {
        const [k, v] = snaps.entries().next().value;
        URL.revokeObjectURL(v.url);
        snaps.delete(k);
      }
      // JPG가 늦어 비운 쪽에 임시로 둔 작은 캔버스는 이 그림으로 바꾼다(캔버스가 메모리를 더 쓴다). 다 풀어 둔 뒤 바꿔 빈 틈이 없게.
      const hold = pageEl.querySelector('canvas.pdf-snap');
      if (!hold) return;
      const img = snapImg(url);
      img.decode().catch(() => {}).then(() => {
        if (!hold.isConnected) return;
        hold.replaceWith(img);
        freeCanvas(hold);
      });
    }, 'image/jpeg', 0.8);
  };
  const fromCenter = (el) => {
    const r = el.getBoundingClientRect();
    return Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
  };
  const pump = async () => {
    if (drawing || pageGesture) return;
    let job = null;
    if (detail && detail.wanted) {
      job = () => detail.draw();
    } else if (wanted.size) {
      let next = null;
      for (const [i, el] of wanted) {
        const d = fromCenter(el);
        if (!next || d < next.d) next = { i, el, d };
      }
      wanted.delete(next.i);
      if (!next.el.isConnected) {
        pump();
        return;
      }
      job = () => drawPage(next.i, next.el);
    }
    if (!job) return;
    drawing = true;
    try {
      await job();
    } finally {
      drawing = false;
      setTimeout(pump, 0);
    }
  };
  const loadPage = (i, pageEl) => {
    pageEl.away = false;
    wanted.set(i, pageEl);
    pump();
  };
  // 글자 층은 쪽 원래 크기(1pt = 1px)로 한 번만 배치하고 화면에는 늘리기(transform)만 한다.
  // 쪽 폭이 바뀔 때(두 손가락 축소·화면 회전)마다 글자 조각 수천 개를 다시 배치하느라 움직임마다 몇백 ms씩 멈췄다.
  const fitLayer = (pageEl, width) => {
    const layer = pageEl.textLayerEl;
    if (!layer || !layer.isConnected) return;
    const k = width / layer.baseWidth;
    layer.style.transform = `scale(${k}) ${LAYER_ROTATION[layer.dataset.mainRotation] || ''}`;
  };
  const fitLayers = (width) => {
    const w = width || pageEls[0].getBoundingClientRect().width;
    pageEls.forEach((pageEl) => fitLayer(pageEl, w));
  };
  const drawPage = async (i, pageEl) => {
    const page = await pdf.getPage(i + 1);
    // 기다리는 사이 화면 범위를 벗어났으면 그리지 않는다(그리면 다시 비울 계기가 없어 메모리에 남는다).
    if (pageEl.away) return;
    const base = sizes[i];
    // 화면 폭에 맞춘 해상도로 그리되, 너무 큰 쪽은 캔버스 한도(4096px)를 넘지 않게 한다.
    // 축소한 동안은 한 화면에 쪽이 많이 들어오므로 해상도를 낮춰(최대 절반) 메모리를 아낀다. 다시 키우면 선명하게 다시 그린다.
    const scale = pdfPageScale(base, pixelWidth);
    const viewport = page.getViewport({ scale });
    const canvas = el('canvas', 'pdf-base');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    // 이미 그려 둔 쪽을 다른 해상도로 다시 그리거나, 비워 둔 쪽에 작은 그림이 있으면 다 그린 뒤에 바꿔 끼운다(그동안 빈 쪽이 보이지 않게).
    // 처음 그리는 쪽도 화면 밖에서 다 그린 뒤에 붙인다. 붙여 둔 캔버스에 조금씩 그리면 웹뷰가 프레임마다 그 큰 그림을
    // 화면 층에 다시 올려(사진 많은 PDF에서 화면 스레드 시간의 대부분) 스크롤과 다른 쪽 그리기가 느려졌다.
    const old = pageEl.querySelector('canvas.pdf-base') || pageEl.querySelector('.pdf-snap');
    if (!old) {
      pageEl.querySelectorAll('canvas').forEach(freeCanvas);
      pageEl.replaceChildren();
      pageEl.textLayerEl = null;
      pageEl.textDivs = null;
    }
    const task = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE });
    tasks.set(i, task);
    try {
      await task.promise;
    } catch (e) {
      freeCanvas(canvas);
      if (e && e.name === 'RenderingCancelledException') return;
      if (old && pageEl.contains(old)) return; // 전에 그린 그림은 그대로 둔다
      pageError(pageEl, i, () => loadPage(i, pageEl));
      report({ state: 'page-error', kind: 'pdf', page: i });
      return;
    } finally {
      if (tasks.get(i) === task) tasks.delete(i);
    }
    if (pageEl.away) {
      freeCanvas(canvas);
      return;
    }
    if (old) {
      if (!pageEl.contains(old)) {
        freeCanvas(canvas);
        return;
      }
      old.replaceWith(canvas);
      if (old.tagName === 'CANVAS') freeCanvas(old);
    } else {
      pageEl.replaceChildren(canvas);
    }
    keepSnap(i, canvas, pageEl);
    if (pageEl.textLayerEl && pageEl.textLayerEl.isConnected) return; // 글자 층·링크는 해상도와 상관없어 한 번만 만든다
    // 길게 눌러 글자를 고르고 복사할 수 있게 투명한 글자 층을 얹는다. 찾기 결과도 이 층에 칠한다.
    try {
      const layer = el('div', 'textLayer');
      layer.style.setProperty('--total-scale-factor', '1');
      pageEl.append(layer);
      const vp1 = page.getViewport({ scale: 1 });
      const textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport: vp1,
      });
      // 크기는 쪽 원래 크기(회전 전)로 못 박는다. 화면 크기에는 fitLayer가 늘려 맞춘다.
      const { pageWidth, pageHeight } = vp1.rawDims;
      layer.style.width = `${pageWidth}px`;
      layer.style.height = `${pageHeight}px`;
      layer.baseWidth = base.w;
      pageEl.textLayerEl = layer;
      fitLayer(pageEl, pageEl.getBoundingClientRect().width);
      await textLayer.render();
      if (!layer.isConnected) return;
      pageEl.textDivs = textLayer.textDivs;
      if (search) search.paint(i);
    } catch (e) {
      console.warn('글자 층을 만들지 못함', e);
    }
    // 문서 속 웹·메일·전화 링크를 누를 수 있게 투명한 링크를 얹는다(앱이 눌렀을 때만 브라우저 등으로 넘긴다).
    try {
      const annots = await page.getAnnotations({ intent: 'display' });
      if (!pageEl.contains(canvas)) return;
      const vp = page.getViewport({ scale: 1 });
      for (const a of annots) {
        if (a.subtype !== 'Link' || !a.url || !/^(https?:|mailto:|tel:)/i.test(a.url)) continue;
        // PDF 좌표(아래가 0)를 화면 좌표로 바꾼다: viewport.transform = [a, b, c, d, e, f]
        const [ta, tb, tc, td, te, tf] = vp.transform;
        const at = (x, y) => [ta * x + tc * y + te, tb * x + td * y + tf];
        const [x1, y1] = at(a.rect[0], a.rect[1]);
        const [x2, y2] = at(a.rect[2], a.rect[3]);
        const link = el('a', 'pdf-link');
        link.href = a.url;
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', a.url);
        link.style.left = `${(Math.min(x1, x2) / vp.width) * 100}%`;
        link.style.top = `${(Math.min(y1, y2) / vp.height) * 100}%`;
        link.style.width = `${(Math.abs(x2 - x1) / vp.width) * 100}%`;
        link.style.height = `${(Math.abs(y2 - y1) / vp.height) * 100}%`;
        pageEl.append(link);
      }
    } catch (e) {
      console.warn('링크를 읽지 못함', e);
    }
    if (!renderedOnce) {
      renderedOnce = true;
      report({ state: 'rendered', kind: 'pdf', pages: sizes.length, engine: 'pdfjs' });
    }
  };
  const unloadPage = (i, pageEl) => {
    pageEl.away = true;
    wanted.delete(i);
    const t = tasks.get(i);
    if (t) t.cancel();
    tasks.delete(i);
    pageEl.textDivs = null;
    pageEl.textLayerEl = null;
    const snap = snaps.get(i);
    // 작은 그림(JPG)을 아직 못 만들었으면(휴대폰이 바쁘면 몇 초 늦는다) 지금 쪽 그림에서 바로 작게 떠 둔다.
    // 그러지 않으면 그 사이 멀어진 쪽은 되돌아올 때 빈 칸("불러오는 중")으로 보였다. JPG가 나오면 그것으로 바꾼다(keepSnap).
    const base = pageEl.querySelector('canvas.pdf-base');
    const hold = !snap && base && base.width ? smallCopy(base) : null;
    pageEl.querySelectorAll('canvas').forEach(freeCanvas);
    if (snap) {
      pageEl.replaceChildren(snapImg(snap.url));
    } else if (hold) {
      hold.className = 'pdf-snap';
      pageEl.replaceChildren(hold);
    } else {
      pageEl.replaceChildren();
    }
    // 멀어진 쪽의 그리기 자료(선·그림 목록)도 놓아준다. 도면처럼 선이 많은 쪽은 한 쪽에 수십 MB다.
    // 다시 오면 작업 스레드가 다시 읽는다. 그리는 중이면 pdf.js가 끝난 뒤에 놓아준다.
    pdf.getPage(i + 1).then((p) => p.cleanup()).catch(() => {});
  };

  // ---- 확대해 보는 부분을 선명하게(아크로뱃·pdf.js 뷰어의 확대 보기처럼)
  // 쪽 그림은 화면 폭에 맞춘 해상도라 웹뷰가 확대하면 그만큼 흐려진다. 손을 떼고 잠깐 멈추면
  // 보이는 부분(+조금 여유)만 화면 해상도로 다시 그려 그 자리에 겹친다. 배율이 1 가까이로 돌아오면 지운다.
  const DETAIL_MIN_SCALE = 1.1;
  const DETAIL_MAX_PX = 12e6; // 겹쳐 그리는 그림 하나의 크기 상한(약 48MB)
  detail = {
    wanted: false,
    task: null,
    timer: 0,
    request() {
      clearTimeout(this.timer);
      if (this.task) this.task.cancel();
      this.timer = setTimeout(() => {
        this.wanted = true;
        pump();
      }, 250);
    },
    clear(except) {
      for (const c of $('doc').querySelectorAll('canvas.pdf-detail')) {
        if (except && except.has(c)) continue;
        c.remove();
        freeCanvas(c);
      }
    },
    async draw() {
      this.wanted = false;
      const vv = window.visualViewport;
      const s = vv ? vv.scale : 1;
      // 쪽 확대(pageZoom)는 쪽 폭 자체를 키우고, 웹뷰 배율(s)은 그 위에 곱해진다. 쪽 그림은 100% 폭 해상도다.
      if (!vv || s * pageZoom < DETAIL_MIN_SCALE) {
        this.clear();
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      // 보이는 영역(레이아웃 뷰포트 좌표). 조금씩 움직여도 다시 그리지 않게 사방에 15% 여유를 둔다.
      const view = { l: vv.offsetLeft, t: vv.offsetTop, r: vv.offsetLeft + vv.width, b: vv.offsetTop + vv.height };
      const mx = vv.width * 0.15;
      const my = vv.height * 0.15;
      const keep = new Set();
      for (let i = pageIndexAt(pageEls, view.t - my); i < pageEls.length; i++) {
        const pageEl = pageEls[i];
        const r = pageEl.getBoundingClientRect();
        if (r.top >= view.b + my) break;
        const base = pageEl.querySelector('canvas.pdf-base');
        if (!base || r.width <= 0) continue;
        const seen = { x0: Math.max(r.left, view.l), y0: Math.max(r.top, view.t), x1: Math.min(r.right, view.r), y1: Math.min(r.bottom, view.b) };
        if (seen.x1 <= seen.x0 || seen.y1 <= seen.y0) continue;
        // 쪽 안 좌표(CSS px)로 그릴 영역과 해상도(CSS px → 기기 픽셀)
        const box = {
          x0: Math.max(0, seen.x0 - mx - r.left), y0: Math.max(0, seen.y0 - my - r.top),
          x1: Math.min(r.width, seen.x1 + mx - r.left), y1: Math.min(r.height, seen.y1 + my - r.top),
        };
        const bw = box.x1 - box.x0;
        const bh = box.y1 - box.y0;
        const k = Math.min(s * dpr, Math.sqrt(DETAIL_MAX_PX / (bw * bh)), 4096 / bw, 4096 / bh);
        // 쪽 그림보다 별로 선명해지지 않으면 그리지 않는다.
        if (k * r.width < base.width * 1.15) continue;
        // 이미 겹쳐 둔 그림이 보이는 부분을 같은 해상도로 덮고 있으면 그대로 둔다.
        const cur = pageEl.querySelector('canvas.pdf-detail');
        if (cur && cur.box && cur.k >= k * 0.9 && Math.abs(cur.pageW - r.width) < 0.5
          && cur.box.x0 <= seen.x0 - r.left + 0.5 && cur.box.y0 <= seen.y0 - r.top + 0.5
          && cur.box.x1 >= seen.x1 - r.left - 0.5 && cur.box.y1 >= seen.y1 - r.top - 0.5) {
          keep.add(cur);
          continue;
        }
        const page = await pdf.getPage(i + 1);
        if (!pageEl.contains(base)) continue;
        const viewport = page.getViewport({ scale: (r.width / sizes[i].w) * k });
        const px = Math.floor(box.x0 * k);
        const py = Math.floor(box.y0 * k);
        const canvas = el('canvas', 'pdf-detail');
        canvas.width = Math.max(1, Math.ceil(box.x1 * k) - px);
        canvas.height = Math.max(1, Math.ceil(box.y1 * k) - py);
        canvas.style.left = `${(px / k / r.width) * 100}%`;
        canvas.style.top = `${(py / k / r.height) * 100}%`;
        canvas.style.width = `${(canvas.width / k / r.width) * 100}%`;
        canvas.style.height = `${(canvas.height / k / r.height) * 100}%`;
        const task = page.render({ canvas, viewport, transform: [1, 0, 0, 1, -px, -py], annotationMode: pdfjs.AnnotationMode.ENABLE });
        this.task = task;
        try {
          await task.promise;
        } catch (e) {
          freeCanvas(canvas);
          if (!(e && e.name === 'RenderingCancelledException')) console.warn('확대 부분을 그리지 못함', e);
          return; // 화면이 다시 움직였다: 멈춘 뒤에 새로 그린다(request)
        } finally {
          if (this.task === task) this.task = null;
        }
        if (!pageEl.contains(base) || Math.abs(pageEl.getBoundingClientRect().width - r.width) > 0.5) {
          freeCanvas(canvas);
          continue;
        }
        canvas.box = box;
        canvas.k = k;
        canvas.pageW = r.width;
        if (cur && pageEl.contains(cur)) {
          cur.replaceWith(canvas);
          freeCanvas(cur);
        } else {
          base.after(canvas);
        }
        keep.add(canvas);
      }
      this.clear(keep);
    },
  };

  let search = null;
  const pageEls = mountPages(sizes, loadPage, unloadPage);
  onPageGestureEnd = pump;
  // 확대해 겹쳐 둔 선명한 부분(detail)은 쪽 크기의 비율로 놓여 있어 쪽 폭이 바뀌어도 제자리를 지킨다.
  // 손가락이 움직이는 동안은 그대로 늘이고 줄이다가 손을 떼면 새 배율로 다시 그린다(onPageZoomEnd).
  onPageResize = (width) => {
    if (detail.task) detail.task.cancel();
    fitLayers(width);
  };
  search = setupPdfSearch(pdf, pageEls);
  setupPdfExport(pdf, pdfjs, sizes, pageEls, snaps);
  // 인쇄: 원본 PDF를 인쇄 창에 넘긴다. 열기 비밀번호가 걸린 원본은 인쇄 창이 열지 못하고, 작성자가 인쇄를 막은 문서는 인쇄하지 않는다.
  pdfPrint = { w: sizes[0].w, h: sizes[0].h, blocked: false, password: askedPassword };
  pdf.getPermissions().then((perms) => {
    if (perms && ![...perms].includes((pdfjs.PermissionFlag || { PRINT: 4 }).PRINT)) pdfPrint.blocked = true;
  }).catch((e) => console.warn('문서 권한을 읽지 못함', e));
  onPageZoomEnd = () => {
    const w = pageEls[0].getBoundingClientRect().width;
    pageEls.forEach((pageEl, i) => {
      const canvas = pageEl.querySelector('canvas.pdf-base');
      if (!canvas) return;
      if (canvas.width < pdfPageScale(sizes[i], pixelWidth) * sizes[i].w * 0.8) loadPage(i, pageEl);
    });
    fitLayers(w);
    detail.request();
  };
  if (window.visualViewport) {
    const onView = () => detail.request();
    window.visualViewport.addEventListener('resize', onView);
    window.visualViewport.addEventListener('scroll', onView);
    window.addEventListener('scroll', onView, { passive: true });
  }
  // 첫 쪽들을 그린 뒤에 메모 주석·첨부 파일을 훑는다(그리기와 다투지 않게).
  setTimeout(() => addPdfExtras(pdf, $('doc')), 1500);

  // 폴드를 펼쳐 화면이 넓어지면 보이는 쪽을 더 선명하게 다시 그리고, 글자 층 배율을 맞춘다.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitLayers();
      detail.clear();
      detail.request();
      const next = pdfCanvasWidth();
      if (next <= pixelWidth * 1.2) return;
      pixelWidth = next;
      pageEls.forEach((pageEl, i) => {
        if (pageEl.querySelector('canvas.pdf-base')) loadPage(i, pageEl);
      });
    }, 300);
  });
}

// 글자 층 회전(pdf.js pdf_viewer.css의 [data-main-rotation] 규칙). 크기 맞춤(scale)과 함께 한 transform에 넣는다.
const LAYER_ROTATION = { 90: 'rotate(90deg) translateY(-100%)', 180: 'rotate(180deg) translate(-100%, -100%)', 270: 'rotate(270deg) translateX(-100%)' };

// 다 쓴 캔버스의 그림 메모리를 바로 돌려준다(쓰레기 수거를 기다리지 않게).
function freeCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

// ---------------------------------------------------------------- PDF 이미지로 변환(보내기·사진첩에 저장)
// 메뉴(⋮)의 "이미지로 변환…" → 쪽 고르기 창(쪽 그림 격자에서 여러 장 누르기, "1-3, 5" 범위 입력, 전체 선택)
// → 고른 쪽을 pdf.js로 한 장씩 그려 앱으로 넘긴다(bridge.exportBegin → exportPart 조각들 → exportEnd).
// 앱이 사진첩(be docs 앨범)에 넣거나, 보내기 창(카톡 등)을 연다. 실패·취소하면 이번에 만든 그림은 앱이 모두 지운다.
// 해상도: 400dpi(기본)·600dpi. 글자·선만 있는 쪽은 PNG(손실 없음), 사진이 많은 쪽은 JPG(품질 0.95)로 만든다.
const EXPORT_QUALITY = {
  dpi400: { label: '400dpi', dpi: 400 },
  dpi600: { label: '600dpi', dpi: 600 },
};
// PNG는 쪽을 가로 띠로 나눠 그리면서 바로 PNG로 이어 쓴다. 메모리는 띠 하나(약 800만 화소, 32MB)만큼만 쓰므로
// 쪽 전체를 한 캔버스에 그리면 폰이 버티지 못하는 해상도(A3 600dpi = 약 7천만 화소)도 만든다.
const EXPORT_PNG_MAX_PX = 150e6; // 한 장 화소 상한(A1 600dpi 정도). 넘으면 해상도를 줄인다
const EXPORT_MAX_SIDE = 16384; // 한 변 상한(캔버스 폭 한도)
const EXPORT_STRIP_PX = 8e6;
// JPG(사진 쪽)는 쪽 전체를 한 캔버스에 그려 바꾼다. 한 장 2,400만 화소까지(사진 쪽은 원래 사진 해상도 이상은 의미가 없다).
// 메모리가 모자라 그리지 못하면 0.7배씩 줄여 두 번까지 다시 그린다.
const EXPORT_JPG_MAX_PX = 24e6;
// 쪽 안 사진의 화소가 쪽을 150dpi로 본 화소의 25% 이상이면 사진 쪽(스캔·사진 자료). 작은 로고는 PNG 그대로.
const EXPORT_PHOTO_SHARE = 0.25;
const EXPORT_CHUNK = 1 << 20; // 앱으로 넘기는 조각(base64 글자 수, 4의 배수)
const THUMB_PX = 220; // 고르기 창 쪽 그림의 가로 픽셀

// "1-3, 5, 8~10, 12-" 같은 쪽 범위 → 0부터 센 쪽 번호. 잘못된 조각이 있으면 bad에 그 조각을 돌려준다.
function parsePageRanges(text, n) {
  const pages = new Set();
  const src = String(text || '').replace(/[~〜–—]/g, '-').replace(/쪽|페이지|p\.?/gi, ' ').replace(/\s*-\s*/g, '-').trim();
  if (!src) return { pages, bad: '' };
  for (const tok of src.split(/[\s,;·]+/)) {
    if (!tok) continue;
    const m = /^(\d*)-(\d*)$/.exec(tok);
    let a;
    let b;
    if (/^\d+$/.test(tok)) a = b = Number(tok);
    else if (m && (m[1] || m[2])) {
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : n;
    } else return { pages, bad: tok };
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > n) return { pages, bad: tok };
    for (let k = a; k <= b; k++) pages.add(k - 1);
  }
  return { pages, bad: null };
}

function canExportImages() {
  return !!(bridge && bridge.exportBegin && bridge.exportPart && bridge.exportEnd && bridge.exportCancel);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function canvasBlob(canvas, mime, q) {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, q));
}

// ---- PNG를 띠 단위로 이어 쓰기(8비트 RGB, 행 필터 Up, 압축은 브라우저 내장 zlib: CompressionStream('deflate'))
const PNG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = PNG_CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

function joinBytes(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// W×H RGB PNG. rows(rgba, n)로 위에서부터 n행씩 넣고 end()로 마친다. 만든 바이트는 emit(bytes, last)로 차례대로 나간다.
function pngWriter(W, H, emit) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8; // 8비트
  ihdr[9] = 2; // RGB
  let head = joinBytes([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)]);
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  let pending = [];
  let pendingLen = 0;
  const flush = async (all) => {
    if (!pendingLen || (!all && pendingLen < 1 << 19)) return;
    const idat = pngChunk('IDAT', joinBytes(pending));
    pending = [];
    pendingLen = 0;
    await emit(head ? joinBytes([head, idat]) : idat, false);
    head = null;
  };
  const drain = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending.push(value);
      pendingLen += value.length;
      await flush(false);
    }
  })();
  const prev = new Uint8Array(W * 3);
  const stride = 1 + W * 3;
  return {
    async rows(rgba, n) {
      const out = new Uint8Array(stride * n);
      for (let r = 0; r < n; r++) {
        let o = r * stride;
        out[o++] = 2; // Up: 바로 위 행과의 차이(도면처럼 같은 색이 이어지면 잘 줄어든다)
        let s = r * W * 4;
        for (let j = 0; j < W * 3; s += 4) {
          for (let ch = 0; ch < 3; ch++, j++) {
            const v = rgba[s + ch];
            out[o + j] = (v - prev[j]) & 255;
            prev[j] = v;
          }
        }
      }
      await writer.ready;
      await writer.write(out);
    },
    async end() {
      await writer.close();
      await drain;
      await flush(true);
      const iend = pngChunk('IEND', new Uint8Array(0));
      await emit(head ? joinBytes([head, iend]) : iend, true);
    },
    abort() {
      writer.abort().catch(() => {});
    },
  };
}

function setupPdfExport(pdf, pdfjs, sizes, pageEls, snaps) {
  const item = $('menu-export');
  if (!canExportImages()) return;
  item.hidden = false;
  const n = sizes.length;
  const digits = String(n).length;
  const base = (docInfo.name || T('문서')).replace(/\.[^.]+$/, '').slice(0, 60) || T('문서');
  let quality = 'dpi400';
  try {
    if (localStorage.getItem('be-docs.export-dpi') === 'dpi600') quality = 'dpi600';
  } catch (_) {
    // 기억하지 못해도 기본값으로 쓴다.
  }
  const selected = new Set();
  let panel = null;
  let ui = null;
  let busy = null;
  let blocked = null; // 작성자가 인쇄·복사를 모두 막은 문서

  // 작성자가 인쇄와 복사를 모두 막아 둔 문서는 그림으로 내보내지 않는다(그림은 인쇄·복사와 같은 결과다).
  // pdf.js는 판에 따라 허용 목록을 배열이나 Set으로 준다. 권한 설정이 없는 문서는 null.
  pdf.getPermissions().then((perms) => {
    if (!perms) return;
    const list = [...perms];
    const F = pdfjs.PermissionFlag || { PRINT: 4, COPY: 16 };
    if (!list.includes(F.PRINT) && !list.includes(F.COPY)) blocked = T('작성자가 인쇄와 복사를 막아 둔 문서라 이미지로 변환할 수 없어요.');
  }).catch((e) => console.warn('문서 권한을 읽지 못함', e));

  // 문서 화면에 그려 두지 않은 쪽은 그린 뒤 pdf.js 그리기 자료를 놓아준다(도면은 한 쪽에 수십 MB).
  const release = (i, page) => {
    if (!pageEls[i].querySelector('canvas.pdf-base')) page.cleanup();
  };

  // ---- 쪽 그림(고르기 창). 보이는 것만 작게 그려 JPG로 바꿔 둔다(캔버스는 바로 비운다).
  const thumbWanted = [];
  let thumbBusy = false;
  const urls = [];
  const pumpThumbs = async () => {
    if (thumbBusy || busy || !panel || panel.hidden || !thumbWanted.length) return;
    // 지금 보이는 곳(격자 가운데)에 가장 가까운 쪽부터(빨리 넘기면 지나간 쪽보다 지금 쪽이 먼저)
    const g = ui.grid.getBoundingClientRect();
    const mid = (g.top + g.bottom) / 2;
    let at = 0;
    let best = Infinity;
    thumbWanted.forEach((j, k) => {
      const r = j.img.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < best) {
        best = d;
        at = k;
      }
    });
    const job = thumbWanted.splice(at, 1)[0];
    thumbBusy = true;
    try {
      // 문서 화면에서 이미 그린 쪽은 남겨 둔 작은 그림을 그대로 쓴다
      const snap = snaps && snaps.get(job.i);
      if (!job.img.src && snap) job.img.src = snap.url;
      if (!job.img.src) {
        const page = await pdf.getPage(job.i + 1);
        const viewport = page.getViewport({ scale: THUMB_PX / sizes[job.i].w });
        const c = el('canvas');
        c.width = Math.max(1, Math.floor(viewport.width));
        c.height = Math.max(1, Math.floor(viewport.height));
        await page.render({ canvas: c, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
        const blob = await canvasBlob(c, 'image/jpeg', 0.8);
        freeCanvas(c);
        release(job.i, page);
        if (blob) {
          const u = URL.createObjectURL(blob);
          urls.push(u);
          job.img.src = u;
        }
      }
    } catch (e) {
      console.warn('쪽 그림을 만들지 못함', e);
    } finally {
      thumbBusy = false;
      setTimeout(pumpThumbs, 0);
    }
  };

  const refresh = () => {
    const count = selected.size;
    for (const b of ui.grid.children) {
      const on = selected.has(Number(b.dataset.i));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    ui.count.textContent = count ? T('{n}쪽 선택', { n: count }) : T('변환할 쪽을 골라 주세요');
    ui.all.textContent = count === n ? T('선택 해제') : T('전체 선택');
    ui.share.disabled = !count || !!busy;
    ui.save.disabled = !count || !!busy;
    for (const b of ui.quality.children) b.setAttribute('aria-checked', String(b.dataset.q === quality));
    ui.qualityNote.textContent = T('PNG(손실 없음) · 사진이 많은 쪽은 JPG');
  };

  const say = (text, bad) => {
    ui.msg.textContent = text || '';
    ui.msg.classList.toggle('bad', !!bad);
  };

  const build = () => {
    panel = el('section', 'export-panel');
    panel.id = 'export-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', T('이미지로 변환'));
    panel.hidden = true;
    const scrim = el('div', 'export-scrim');
    scrim.addEventListener('click', () => {
      if (!busy) close(); // 만드는 중에는 바깥을 잘못 눌러도 그만두지 않는다(취소 버튼으로)
    });

    const head = el('div', 'export-head');
    head.append(el('p', 'export-title', T('이미지로 변환')));
    const all = el('button', 'btn export-all', T('전체 선택'));
    all.type = 'button';
    const cancel = el('button', 'btn export-close', T('닫기'));
    cancel.type = 'button';
    head.append(all, cancel);

    const range = el('form', 'export-range');
    const input = el('input');
    input.type = 'text';
    input.inputMode = 'text';
    input.enterKeyHint = 'done';
    input.autocomplete = 'off';
    input.placeholder = T('쪽 범위 예: 1-3, 5 (전체 {n}쪽)', { n });
    input.setAttribute('aria-label', T('쪽 범위'));
    const pick = el('button', 'btn', T('고르기'));
    pick.type = 'submit';
    range.append(input, pick);

    const grid = el('div', 'export-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', T('쪽'));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target.querySelector('img');
        if (!img.src && !thumbWanted.some((j) => j.img === img)) thumbWanted.push({ i: Number(e.target.dataset.i), img });
        io.unobserve(e.target);
      }
      pumpThumbs();
    }, { root: grid, rootMargin: '300px 0px' });
    for (let i = 0; i < n; i++) {
      const b = el('button', 'export-thumb');
      b.type = 'button';
      b.dataset.i = String(i);
      b.setAttribute('aria-label', T('{n}쪽', { n: i + 1 }));
      const frame = el('span', 'export-frame');
      frame.style.aspectRatio = `${sizes[i].w} / ${sizes[i].h}`;
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      frame.append(img);
      b.append(frame, el('span', 'export-num', String(i + 1)), el('span', 'export-check'));
      grid.append(b);
      io.observe(b);
    }

    const foot = el('div', 'export-foot');
    const row = el('div', 'export-row');
    const count = el('p', 'export-count');
    const qualityBox = el('div', 'export-quality');
    qualityBox.setAttribute('role', 'radiogroup');
    qualityBox.setAttribute('aria-label', T('화질'));
    for (const [key, q] of Object.entries(EXPORT_QUALITY)) {
      const b = el('button', 'export-q', q.label);
      b.type = 'button';
      b.dataset.q = key;
      b.setAttribute('role', 'radio');
      qualityBox.append(b);
    }
    row.append(count, qualityBox);
    const qualityNote = el('p', 'export-qnote');
    const actions = el('div', 'export-actions');
    const save = el('button', 'btn', T('사진첩에 저장'));
    save.type = 'button';
    const share = el('button', 'btn btn-primary', T('공유하기'));
    share.type = 'button';
    actions.append(save, share);
    const msg = el('p', 'export-msg');
    msg.setAttribute('role', 'status');
    const note = el('p', 'export-note', T('카톡은 사진 화질을 "원본"으로 보내야 해상도가 그대로 가요.'));
    const note2 = el('p', 'export-note', T('사진첩에 저장하면 사진 백업(구글 포토 등)에도 올라갈 수 있어요.'));
    foot.append(row, qualityNote, actions, msg, note, note2);

    const progress = el('div', 'export-progress');
    progress.hidden = true;
    const ptext = el('p', 'export-ptext');
    const bar = el('div', 'export-bar');
    const fill = el('span');
    bar.append(fill);
    const stop = el('button', 'btn', T('취소'));
    stop.type = 'button';
    progress.append(ptext, bar, stop);

    panel.append(head, range, grid, foot, progress);
    $('screen').append(scrim, panel);
    ui = { scrim, grid, input, all, count, quality: qualityBox, qualityNote, save, share, msg, progress, ptext, fill };

    // 쪽 그림을 누르면 고르고, 다시 누르면 뺀다.
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.export-thumb');
      if (!b || busy) return;
      const i = Number(b.dataset.i);
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      say('');
      refresh();
    });
    all.addEventListener('click', () => {
      if (busy) return;
      if (selected.size === n) selected.clear();
      else for (let i = 0; i < n; i++) selected.add(i);
      say('');
      refresh();
    });
    range.addEventListener('submit', (e) => {
      e.preventDefault();
      if (busy) return;
      const { pages, bad } = parsePageRanges(input.value, n);
      if (bad !== null || !pages.size) {
        say(bad ? T('"{bad}"을 알아보지 못했어요. 1~{n} 사이 쪽 번호로 적어 주세요(예: 1-3, 5).', { bad, n }) : T('쪽 번호를 적어 주세요(예: 1-3, 5).'), true);
        return;
      }
      selected.clear();
      for (const i of pages) selected.add(i);
      input.blur();
      say('');
      refresh();
      ui.grid.querySelector(`[data-i="${Math.min(...pages)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    qualityBox.addEventListener('click', (e) => {
      const b = e.target.closest('.export-q');
      if (!b || busy) return;
      quality = b.dataset.q;
      try {
        localStorage.setItem('be-docs.export-dpi', quality);
      } catch (_) {
        // 이번에만 쓴다.
      }
      refresh();
    });
    cancel.addEventListener('click', () => close());
    stop.addEventListener('click', () => stopRun());
    save.addEventListener('click', (e) => freshTap(e) && run('save'));
    share.addEventListener('click', (e) => freshTap(e) && run('share'));
  };

  // 사진이 많은 쪽(스캔·사진 자료)인지: 쪽 안 사진들의 화소 합으로 본다.
  const photoPage = async (i, page) => {
    try {
      const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
      const O = pdfjs.OPS;
      let px = 0;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const f = ops.fnArray[k];
        const a = ops.argsArray[k];
        if (f === O.paintImageXObject || f === O.paintImageXObjectRepeat) px += (a[1] || 0) * (a[2] || 0);
        else if (f === O.paintInlineImageXObject && a[0]) px += (a[0].width || 0) * (a[0].height || 0);
      }
      const { w, h } = sizes[i];
      return px >= EXPORT_PHOTO_SHARE * (w / 72) * (h / 72) * 150 * 150;
    } catch (e) {
      console.warn('쪽 내용을 살피지 못함(PNG로 만든다)', e);
      return false;
    }
  };

  // 앱으로 그림 바이트를 넘긴다(base64 조각). last면 그 그림을 마친다.
  const sendBytes = async (fileName, mime, bytes, last) => {
    const b64 = await blobToBase64(bytes instanceof Blob ? bytes : new Blob([bytes]));
    for (let at = 0; at < b64.length; at += EXPORT_CHUNK) {
      if (busy.cancelled) throw new Error('그만둠');
      if (!bridge.exportPart(fileName, mime, b64.slice(at, at + EXPORT_CHUNK), last && at + EXPORT_CHUNK >= b64.length)) {
        throw new Error('앱이 그림을 받지 못함');
      }
    }
  };

  // PNG: 쪽을 가로 띠로 그려 이어 쓴다(흰 바탕). onPart(0~1)로 쪽 안 진행을 알린다.
  const streamPng = async (i, page, fileName, onPart) => {
    const { w, h } = sizes[i];
    const scale = Math.min(EXPORT_QUALITY[quality].dpi / 72, Math.sqrt(EXPORT_PNG_MAX_PX / (w * h)), EXPORT_MAX_SIDE / Math.max(w, h));
    const viewport = page.getViewport({ scale });
    const W = Math.max(1, Math.floor(viewport.width));
    const H = Math.max(1, Math.floor(viewport.height));
    const stripH = Math.max(16, Math.min(H, Math.floor(EXPORT_STRIP_PX / W)));
    const png = pngWriter(W, H, (bytes, last) => sendBytes(fileName, 'image/png', bytes, last));
    // 띠는 위아래로 PAD행씩 겹쳐 그리고 가운데만 쓴다. 캔버스 가장자리 근처(재어 보니 4행으로는 모자라고 32행이면 충분)를
    // 지나는 선은 흐림(안티에일리어싱)이 달라져 띠 경계에 희미한 줄이 생겼다(통째로 그린 것과 경계 행만 달랐다).
    const PAD = 32;
    const c = el('canvas');
    c.width = W;
    c.height = Math.min(H, stripH + 2 * PAD);
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    try {
      for (let y = 0; y < H; y += stripH) {
        if (busy.cancelled) throw new Error('그만둠');
        const rows = Math.min(stripH, H - y);
        const top = Math.max(0, y - PAD);
        const height = Math.min(H, y + rows + PAD) - top;
        if (height !== c.height) c.height = height;
        const task = page.render({ canvas: c, viewport, transform: [1, 0, 0, 1, 0, -top], annotationMode: pdfjs.AnnotationMode.ENABLE });
        busy.task = task;
        await task.promise;
        busy.task = null;
        await png.rows(ctx.getImageData(0, y - top, W, rows).data, rows);
        onPart((y + rows) / H);
      }
      await png.end();
    } catch (e) {
      png.abort();
      throw e;
    } finally {
      freeCanvas(c);
    }
  };

  // JPG(사진 쪽): 쪽 전체를 한 캔버스에 그려 바꾼다. 메모리가 모자라 실패하면 조금 줄여 다시 그린다.
  const renderJpg = async (i, page) => {
    const { w, h } = sizes[i];
    let scale = Math.min(EXPORT_QUALITY[quality].dpi / 72, Math.sqrt(EXPORT_JPG_MAX_PX / (w * h)), 8192 / Math.max(w, h));
    for (let attempt = 0; ; attempt++) {
      const viewport = page.getViewport({ scale });
      const c = el('canvas');
      c.width = Math.max(1, Math.floor(viewport.width));
      c.height = Math.max(1, Math.floor(viewport.height));
      try {
        const task = page.render({ canvas: c, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE });
        busy.task = task;
        await task.promise;
        busy.task = null;
        const blob = await canvasBlob(c, 'image/jpeg', 0.95);
        if (blob) return blob;
        if (attempt >= 2) throw new Error('그림으로 바꾸지 못함');
      } catch (e) {
        if (busy.cancelled || (e && e.name === 'RenderingCancelledException') || attempt >= 2) throw e;
        console.warn(`${i + 1}쪽을 ${Math.round(scale * 72)}dpi로 그리지 못해 줄여서 다시 그림`, e);
      } finally {
        freeCanvas(c);
      }
      scale *= 0.7;
    }
  };

  const progress = (done, total) => {
    ui.ptext.textContent = T('이미지로 변환 중 {a}/{b}', { a: Math.min(total, Math.floor(done) + 1), b: total });
    ui.fill.style.width = `${Math.round((done / total) * 100)}%`;
  };

  const run = async (mode) => {
    if (busy || !selected.size) return;
    if (blocked) {
      say(blocked, true);
      return;
    }
    const pages = [...selected].sort((a, b) => a - b);
    busy = { cancelled: false, task: null };
    say('');
    ui.progress.hidden = false;
    progress(0, pages.length);
    refresh();
    let failed = false;
    try {
      if (!bridge.exportBegin(mode)) throw new Error('시작하지 못함');
      for (let k = 0; k < pages.length && !busy.cancelled; k++) {
        const i = pages[k];
        const page = await pdf.getPage(i + 1);
        try {
          const stem = `${base}_p${String(i + 1).padStart(digits, '0')}`;
          if (await photoPage(i, page)) {
            const blob = await renderJpg(i, page);
            if (busy.cancelled) break;
            await sendBytes(`${stem}.jpg`, 'image/jpeg', blob, true);
          } else {
            await streamPng(i, page, `${stem}.png`, (f) => progress(k + f, pages.length));
          }
        } finally {
          release(i, page);
        }
        progress(k + 1, pages.length);
      }
      if (busy.cancelled) {
        bridge.exportCancel();
        say(T('그만뒀어요.'));
        return;
      }
      const made = bridge.exportEnd();
      if (made !== pages.length) throw new Error(`앱이 ${made}장만 받음`);
      report({ state: 'export', mode, pages: made, quality });
    } catch (e) {
      if (busy.cancelled) {
        bridge.exportCancel();
        say(T('그만뒀어요.'));
        return;
      }
      failed = true;
      console.warn('이미지 내보내기 실패', e);
      try {
        bridge.exportCancel();
      } catch (_) {
        // 앱이 이미 지웠다.
      }
      say(mode === 'save' ? T('사진첩에 저장하지 못했어요. 휴대폰 저장 공간을 확인해 주세요.') : T('이미지로 변환하지 못했어요. 쪽 수를 줄여 다시 해 보세요.'), true);
      report({ state: 'export-error', mode, message: String((e && e.message) || e) });
    } finally {
      busy = null;
      ui.progress.hidden = true;
      refresh();
      pumpThumbs();
    }
    if (!failed) close(); // 저장은 앱이 알림을 띄우고, 공유하기는 앱 고르기 창이 뜬다
  };

  const stopRun = () => {
    if (!busy) return;
    busy.cancelled = true;
    if (busy.task) busy.task.cancel();
  };

  const open = (e) => {
    if (!freshTap(e)) return;
    if (!panel) build();
    if (blocked) say(blocked, true);
    // 지금 보고 있는 쪽을 먼저 골라 둔다(가장 흔한 쓰임: 이 쪽을 그림으로).
    if (!selected.size) selected.add(pageIndexAt(pageEls, window.innerHeight / 2));
    refresh();
    panel.hidden = false;
    ui.scrim.hidden = false;
    document.body.classList.add('export-open');
    const first = ui.grid.querySelector(`[data-i="${Math.min(...selected)}"]`);
    if (first) first.scrollIntoView({ block: 'center' });
    pumpThumbs();
  };

  const close = () => {
    if (!panel) return;
    if (busy) {
      stopRun();
      return;
    }
    panel.hidden = true;
    ui.scrim.hidden = true;
    document.body.classList.remove('export-open');
  };

  item.onclick = open;
  exportCtl = {
    close,
    // 문서를 바꾸면 쪽 그림 메모리를 놓아준다.
    destroy: () => {
      stopRun();
      for (const u of urls) URL.revokeObjectURL(u);
      if (panel) {
        panel.remove();
        ui.scrim.remove();
      }
      document.body.classList.remove('export-open');
    },
  };
}

// ---------------------------------------------------------------- PDF 찾기
// 쪽마다 글자를 꺼내 이어 붙인 뒤(띄어쓰기·대소문자·한글 조합 차이는 무시) 찾고,
// 찾은 글자 조각을 글자 층(textLayer)의 해당 조각에 색칠한다. 글자 조각은 getTextContent 항목과 순서가 같다.

function searchNorm(text) {
  return text.normalize('NFKC').toLowerCase();
}

function setupPdfSearch(pdf, pageEls) {
  const texts = new Map(); // 쪽 → { chars, map }: 이어 붙인 글자와 각 글자의 조각 번호
  let hits = [];
  let current = -1;
  let runId = 0;

  const pageText = async (i) => {
    if (texts.has(i)) return texts.get(i);
    const content = await (await pdf.getPage(i + 1)).getTextContent();
    let chars = '';
    const map = [];
    content.items.forEach((item, k) => {
      for (const ch of searchNorm(item.str || '')) {
        if (/\s/.test(ch)) continue;
        chars += ch;
        for (let n = 0; n < ch.length; n++) map.push(k);
      }
    });
    const t = { chars, map };
    texts.set(i, t);
    return t;
  };

  // 찾기 막대(위쪽에 고정)
  const bar = el('form', 'findbar');
  bar.hidden = true;
  const input = el('input');
  input.type = 'search';
  input.placeholder = T('문서에서 찾기');
  input.enterKeyHint = 'search';
  const count = el('span', 'find-count', '');
  const prev = el('button', 'find-btn', '▲');
  const next = el('button', 'find-btn', '▼');
  const close = el('button', 'find-btn find-close', T('닫기'));
  prev.type = 'button';
  next.type = 'button';
  close.type = 'button';
  prev.setAttribute('aria-label', T('이전'));
  next.setAttribute('aria-label', T('다음'));
  bar.append(input, count, prev, next, close);
  $('screen').append(bar);

  // 메뉴의 "문서에서 찾기"
  const open = $('find');
  open.hidden = false;

  const paint = (i) => {
    const divs = pageEls[i] && pageEls[i].textDivs;
    if (!divs) return;
    for (const d of divs) d.classList.remove('search-hit', 'search-current');
    hits.forEach((h, n) => {
      if (h.page !== i) return;
      for (let k = h.a; k <= h.b; k++) if (divs[k]) divs[k].classList.add(n === current ? 'search-current' : 'search-hit');
    });
  };
  const paintAll = () => pageEls.forEach((_, i) => paint(i));
  const show = () => {
    if (!hits.length) return;
    const h = hits[current];
    paintAll();
    const page = pageEls[h.page];
    const span = page.textDivs && page.textDivs[h.a];
    (span || page).scrollIntoView({ block: 'center' });
    count.textContent = `${current + 1} / ${hits.length}`;
    report({ state: 'search', query: input.value, hits: hits.length, current: current + 1, page: h.page + 1 });
  };
  const go = (delta) => {
    if (!hits.length) return;
    current = (current + delta + hits.length) % hits.length;
    show();
  };

  const run = async () => {
    const id = ++runId;
    const q = searchNorm(input.value).replace(/\s+/g, '');
    hits = [];
    current = -1;
    paintAll();
    if (!q) { count.textContent = ''; return; }
    let anyText = false;
    for (let i = 0; i < pageEls.length; i++) {
      if (pageEls.length > 20 && i % 10 === 0) count.textContent = T('{a}/{b}쪽 찾는 중', { a: i + 1, b: pageEls.length });
      const t = await pageText(i);
      if (id !== runId) return; // 새로 찾기 시작함
      if (t.chars) anyText = true;
      for (let from = 0; ;) {
        const k = t.chars.indexOf(q, from);
        if (k < 0) break;
        hits.push({ page: i, a: t.map[k], b: t.map[k + q.length - 1] });
        from = k + 1;
      }
    }
    if (!hits.length) {
      count.textContent = anyText ? T('찾는 글자가 없어요') : T('스캔한 문서라 글자를 찾을 수 없어요');
      report({ state: 'search', query: input.value, hits: 0, scanned: !anyText });
      return;
    }
    current = 0;
    show();
  };

  bar.addEventListener('submit', (ev) => {
    ev.preventDefault();
    input.blur();
    if (hits.length && searchNorm(input.value).replace(/\s+/g, '') === (bar.dataset.last || '')) go(1);
    else {
      bar.dataset.last = searchNorm(input.value).replace(/\s+/g, '');
      run();
    }
  });
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  open.addEventListener('click', () => {
    bar.hidden = false;
    document.body.classList.add('finding');
    input.focus();
  });
  close.addEventListener('click', () => {
    bar.hidden = true;
    document.body.classList.remove('finding');
    hits = [];
    current = -1;
    paintAll();
    count.textContent = '';
  });
  return { paint, run: (q) => { input.value = q; bar.dataset.last = searchNorm(q).replace(/\s+/g, ''); return run(); }, go };
}

// 캔버스 해상도: 화면 폭 × 화면 배율(기기 픽셀 그대로). 확대하면 보이는 부분만 따로 선명하게 다시 그린다(detail).
// 쪽 전체 그림은 100%보다 크게 그리지 않는다(800%면 한 쪽이 수백 MB). 줄이면 그만큼 작게(최소 절반).
// 쪽마다 메모리를 많이 쓰지 않도록 상한을 둔다.
function pdfPageScale(base, pixelWidth) {
  return Math.min(pixelWidth * Math.min(1, Math.max(pageZoom, 0.5)) / base.w, 4096 / Math.max(base.w, base.h));
}

function pdfCanvasWidth() {
  const css = document.documentElement.clientWidth || window.innerWidth;
  return Math.max(600, Math.min(2400, Math.round(css * (window.devicePixelRatio || 1))));
}

async function showPdfNative() {
  const meta = await getJson('/doc/pdf/info');
  if (meta.error === 'password') {
    failWith('password', T('비밀번호로 보호된 PDF예요'), T('다른 앱에서 비밀번호를 입력해 열어 주세요.'), T('pdf.js 없이 내장 렌더러로 여는 중'));
    return;
  }
  if (meta.error) throw new Error(meta.error);
  const sizes = meta.pages;
  if (!sizes.length) throw new Error('빈 문서');
  hideNotice();
  pdfPrint = { w: sizes[0].w, h: sizes[0].h, blocked: false, password: false };

  let width = pdfTargetWidth();
  let renderedOnce = false;
  const pageEls = mountPages(sizes, (i, page) => {
    const img = el('img');
    img.alt = T('{n}쪽', { n: i + 1 });
    img.decoding = 'async';
    img.onload = () => {
      if (!renderedOnce) {
        renderedOnce = true;
        report({ state: 'rendered', kind: 'pdf', pages: sizes.length });
      }
    };
    const load = () => {
      img.src = `/doc/pdf/page?i=${i}&w=${width}&t=${Date.now()}`;
      page.replaceChildren(img);
    };
    img.onerror = () => {
      pageError(page, i, load);
      report({ state: 'page-error', kind: 'pdf', page: i });
    };
    load();
  }, (_i, page) => {
    page.replaceChildren();
  });
  // pdf.js가 열지 못해 안드로이드 내장 렌더러로 그린 경우: 그림으로만 보이므로 빠지는 기능을 알린다.
  addNotice(infoNote(T('기본 방식으로 열었어요. 메모·글자 선택·찾기는 쓸 수 없어요.')), { priority: 2 });

  // 폴드를 펼쳐 화면이 넓어지면 보이는 페이지를 더 선명하게 다시 그린다.
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = pdfTargetWidth();
      if (next <= width * 1.2) return;
      width = next;
      pageEls.forEach((page, i) => {
        const img = page.querySelector('img');
        if (img) img.src = `/doc/pdf/page?i=${i}&w=${width}`;
      });
    }, 300);
  });
}

// ---------------------------------------------------------------- 엑셀·CSV

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} 로드 실패`));
    document.head.append(s);
  });
}

// 한국에서 만든 CSV는 EUC-KR(CP949)인 경우가 많다. UTF-8로 안 읽히면 EUC-KR로 읽는다.
// 머리 표시(BOM) 없는 UTF-16: 숫자·쉼표·줄바꿈 같은 영문 글자의 윗바이트 0이 한쪽 자리(홀수·짝수)에만 몰려 있다.
function utf16WithoutBom(bytes) {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 8) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  // 한글 음절 중에도 아랫바이트가 0인 글자('저' U+C800 등)가 있어 반대쪽 0도 조금은 있다. 한쪽이 4배 이상 많으면 본다.
  const half = n / 2;
  if (odd >= half * 0.2 && even <= half * 0.15 && odd >= even * 4) return 'utf-16le';
  if (even >= half * 0.2 && odd <= half * 0.15 && even >= odd * 4) return 'utf-16be';
  return null;
}

export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const utf16 = utf16WithoutBom(bytes);
  if (utf16) return new TextDecoder(utf16).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

// 라이브러리마다 다른 "비밀번호 보호" 오류를 알아본다. 깨진 ZIP이 내는 "Unsupported ZIP encryption"은 제외한다.
function isPasswordProtectedError(e) {
  const m = String(e && (e.message || e));
  if (/ZIP encryption/i.test(m)) return false;
  return /password-protected|password protection|ECMA-376 Encrypted|Encryption Flags|EncryptionInfo|Encrypted PowerPoint/i.test(m);
}

// 비밀번호를 풀 수 없는 형식(97~2003 엑셀·워드·파워포인트의 보호 문서, DRM 등)
function passwordError() {
  return userError('password', T('비밀번호로 보호된 문서예요'),
    T('이 방식으로 보호된 문서는 다른 앱에서 비밀번호를 입력해 열어 주세요.'));
}

// 글자 파일인지(이진 형식이 아닌지) 본다. "엑셀 다운로드"로 받는 .xls 중에는 HTML 표나 탭 구분 글자 파일이 많다.
function isTextLike(bytes) {
  if ((bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) || (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  const n = Math.min(bytes.length, 4096);
  if (!n) return false;
  if (utf16WithoutBom(bytes)) return true;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

function countOutsideQuotes(text, ch) {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === ch) n++;
  }
  return n;
}

// CSV·TSV를 원문 글자 그대로 읽는다. SheetJS는 '00123'을 123으로 바꾸거나 첫 칸이 '<'면 HTML로 오인한다.
export function parseDelimited(text, maxRows, quotes = true) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const sample = text.slice(0, 8192);
  let d = ',';
  let best = 0;
  for (const c of [',', '\t', ';', '|']) {
    const k = countOutsideQuotes(sample, c);
    if (k > best) { best = k; d = c; }
  }
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let i = 0;
  const end = () => { row.push(field); field = ''; rows.push(row); row = []; };
  for (; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (quotes && c === '"' && field === '') inQ = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      end();
    } else field += c;
  }
  // 끝까지 닫히지 않은 따옴표가 있으면 나머지가 한 칸에 몰리므로, 따옴표를 글자로 보고 다시 읽는다.
  if (quotes && inQ && i >= text.length) return parseDelimited(text, maxRows, false);
  if (i >= text.length && (field !== '' || row.length)) end();
  // 다 읽지 못한 나머지는 줄 수만 센다.
  let total = rows.length;
  let last = i - 1;
  for (let j = text.indexOf('\n', i); j >= 0; j = text.indexOf('\n', j + 1)) {
    total++;
    last = j;
  }
  // 마지막 줄 끝에 줄바꿈이 없어도 한 줄로 센다.
  if (i < text.length && text.slice(last + 1).trim()) total++;
  return { rows, total };
}

const NUMBER_LIKE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;

function delimitedWorkbook(XLSX, text) {
  const { rows, total } = parseDelimited(text, MAX_SHEET_ROWS);
  const ws = {};
  let maxC = 0;
  rows.forEach((r, ri) => {
    maxC = Math.max(maxC, r.length);
    r.forEach((v, ci) => {
      if (v === '') return;
      // 글자는 그대로 두고, 숫자처럼 보이는 칸만 오른쪽 정렬 표시를 위해 형식을 'n'으로 둔다(0으로 시작하는 번호는 제외).
      const numeric = NUMBER_LIKE.test(v) && !/^[-+]?0\d/.test(v);
      ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: numeric ? 'n' : 's', v, w: v };
    });
  });
  const lastR = Math.max(0, rows.length - 1);
  const lastC = Math.max(0, maxC - 1);
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastR, c: lastC } });
  if (total > rows.length) ws['!fullref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: total - 1, c: lastC } });
  return { SheetNames: [T('시트1')], Sheets: { [T('시트1')]: ws } };
}

async function readWorkbook(bytes, kind) {
  await loadScript('vendor/xlsx.full.min.js');
  await loadScript('sheet-format.js');
  const XLSX = window.XLSX;
  const opts = { sheetRows: MAX_SHEET_ROWS + 1, cellHTML: false, cellFormula: true, cellNF: true, cellStyles: true, sheetStubs: true };
  try {
    if (kind === 'csv' || isTextLike(bytes)) {
      // 인코딩(UTF-8·EUC-KR·UTF-16)을 먼저 풀어야 한글이 깨지지 않는다.
      const text = decodeText(bytes);
      const headText = text.slice(0, 65536);
      if (kind !== 'csv' && (/<table[\s>]/i.test(headText) || headText.includes('urn:schemas-microsoft-com:office:spreadsheet'))) {
        return await readWorkbookGuarded(XLSX, text, { ...opts, type: 'string' }, bytes.length);
      }
      return delimitedWorkbook(XLSX, text);
    }
    // 엑셀 구조(OLE·ZIP·BIFF 기록)가 없는 이진 파일은 엔진이 글자 표(PRN)로 억지로 읽어 깨진 글자만 보인다. 바로 안내한다.
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const biff = bytes[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(bytes[1]);
    if (!isOle(bytes) && !zip && !biff) {
      throw userError('damaged', T('엑셀 파일로 읽을 수 없어요'), T('파일이 손상됐거나 엑셀 파일이 아니에요. 다른 앱에서 열어 보세요.'),
        T('알려진 엑셀 구조 없음(앞부분 {h})', { h: [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ') }));
    }
    // 원본 조각(bookFiles)은 칸 서식·틀 고정·그림을 읽을 때 쓴다(sheet-format.js).
    return await readWorkbookGuarded(XLSX, zip ? repairZipCount(bytes) : bytes, { ...opts, bookFiles: true, type: 'array' }, bytes.length);
  } catch (e) {
    if (isPasswordProtectedError(e) && isOle(bytes)) {
      // 97~2003 xls의 비밀번호: showSheet가 비밀번호를 물어 풀고 다시 읽는다.
      const err = passwordError();
      err.legacyXls = true;
      throw err;
    }
    throw isPasswordProtectedError(e) ? passwordError() : e;
  }
}

// 엑셀 해석은 크기와 상관없이 작업 스레드에서 하고 시간을 잰다. 9KB짜리 xlsb도 화면을 7초 막았고, 압축 데이터가 조금
// 깨진 xlsx는 엔진의 압축 풀기가 끝나지 않아 화면이 영구히 멈췄다. 시간이 넘으면 작업 스레드를 끊고 안내로 넘긴다.
async function readWorkbookGuarded(XLSX, input, opts, size) {
  // 작은 파일은 느린 폰에서도 몇 초면 끝난다. 큰 파일은 1MB마다 8초씩 더 기다린다(10MB → 1분 40초, 최대 3분).
  const limit = Math.min(180000, 20000 + Math.round((size / (1024 * 1024)) * 8000));
  try {
    return await readWorkbookInWorker(input, opts, limit);
  } catch (e) {
    if (!e || !e.workerFailed) throw e;
    console.warn('엑셀 작업 스레드를 못 써서 화면 쪽에서 읽음', e);
  }
  const wb = XLSX.read(input, opts);
  wb.Format = window.SheetFormat.read(XLSX, wb);
  return wb;
}

// 풀기 모듈이 모르는 보호 방식(XOR 난독화 등)은 비밀번호 안내로 바꾼다.
function encryptionError(e) {
  return e && e.code === 'unsupported-encryption'
    ? userError('password', T('비밀번호로 보호된 문서예요'), T('이 방식으로 보호된 문서는 다른 앱에서 열어 주세요.'), e.message)
    : e;
}

// 비밀번호 걸린 97~2003 xls(RC4·RC4 CryptoAPI)를 풀어 같은 모양의 파일로 돌려준다.
async function decryptLegacyXls(bytes) {
  const XLSX = window.XLSX;
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  const entry = XLSX.CFB.find(cfb, 'Workbook') || XLSX.CFB.find(cfb, 'Book');
  if (!entry || !entry.content) throw passwordError();
  const stream = entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
  const mod = await import('./vendor/office-crypto.js');
  let enc;
  try {
    enc = mod.readXlsEncryption(stream);
  } catch (e) {
    throw encryptionError(e);
  }
  if (!enc) throw passwordError();
  for (let wrong = false; ; wrong = true) {
    const pw = await askPassword(wrong);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const out = mod.decryptXlsStream(enc, pw, stream);
    if (out) {
      entry.content = out;
      return new Uint8Array(XLSX.CFB.write(cfb, { type: 'array' }));
    }
  }
}

// 비밀번호 걸린 97~2003 doc(RC4·RC4 CryptoAPI)를 풀어 같은 모양의 파일로 돌려준다.
async function decryptLegacyDoc(bytes) {
  await loadScript('vendor/xlsx.full.min.js');
  const XLSX = window.XLSX;
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  const content = (e) => (e && e.content ? (e.content instanceof Uint8Array ? e.content : Uint8Array.from(e.content)) : null);
  const wordEntry = XLSX.CFB.find(cfb, 'WordDocument');
  const wordDocument = content(wordEntry);
  if (!wordDocument) throw passwordError();
  const mod = await import('./vendor/office-crypto.js');
  const tableEntry = XLSX.CFB.find(cfb, mod.docTableName(wordDocument));
  const dataEntry = XLSX.CFB.find(cfb, 'Data');
  const streams = { wordDocument, table: content(tableEntry), data: content(dataEntry) };
  if (!streams.table) throw passwordError();
  let enc;
  try {
    enc = mod.readDocEncryption(wordDocument, streams.table);
  } catch (e) {
    throw encryptionError(e);
  }
  if (!enc) throw passwordError();
  for (let wrong = false; ; wrong = true) {
    const pw = await askPassword(wrong);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const out = mod.decryptDocStreams(enc, pw, streams);
    if (out) {
      wordEntry.content = out.wordDocument;
      tableEntry.content = out.table;
      if (out.data) dataEntry.content = out.data;
      return new Uint8Array(XLSX.CFB.write(cfb, { type: 'array' }));
    }
  }
}

// 엑셀은 파일 본문을 받는 동안 작업 스레드를 미리 띄워 둔다(작업 스레드가 엔진을 읽는 시간, 느린 폰에서 0.5초 남짓을 숨긴다).
// 미리 띄운 스레드가 엔진을 못 읽으면 그 오류를 기억해 두었다가 화면 쪽 해석으로 넘긴다(안 그러면 답 없는 스레드를 기다린다).
let warmSheet = null;
function dropWarmSheet() {
  if (warmSheet) warmSheet.worker.terminate();
  warmSheet = null;
}

function warmSheetWorker() {
  if (warmSheet) return;
  try {
    const w = { worker: new Worker(new URL('./sheet-worker.js', import.meta.url)), error: null, ready: false };
    w.worker.onerror = (ev) => { w.error = ev; };
    w.worker.onmessage = ({ data }) => { if (data && data.ready) w.ready = true; };
    warmSheet = w;
  } catch (e) {
    warmSheet = null;
  }
}

// 작업 스레드에서 엑셀을 읽는다. 시간은 단계마다 잰다: 엔진을 불러오는 동안(느린 기기에서 길 수 있다)은 1분까지 기다리고,
// 해석이 limit을 넘으면 손상으로 보고 끊는다. 다만 작업 스레드가 압축 데이터를 끝까지 풀어 봐서 멀쩡하면(엔진이 끝나지 않을
// 원인이 없으면) 4.5배(작은 파일 90초)까지 기다린다: 정상 xlsb 하나가 엔진의 시트 이름 오독으로 느린 에뮬레이터에서 20초를 넘겼다.
// 해석이 끝난 뒤 수식 계산은 작업 스레드가 스스로 10초에서 멈춘다.
function readWorkbookInWorker(input, opts, limit = 0) {
  return new Promise((resolve, reject) => {
    const warm = warmSheet;
    warmSheet = null;
    const workerFailed = (message) => {
      const err = new Error(message);
      err.workerFailed = true;
      reject(err);
    };
    if (warm && warm.error) {
      warm.worker.terminate();
      workerFailed(`작업 스레드 오류: ${warm.error.message || '알 수 없음'}`);
      return;
    }
    let worker;
    try {
      worker = warm ? warm.worker : new Worker(new URL('./sheet-worker.js', import.meta.url));
    } catch (e) {
      e.workerFailed = true;
      reject(e);
      return;
    }
    let timer = 0;
    const arm = (ms, onTimeout) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        worker.terminate();
        onTimeout();
      }, ms);
    };
    const stuck = (what) => () => reject(userError('damaged', T('파일을 읽다가 멈췄어요'), T('파일 일부가 손상됐거나 너무 복잡해요. 다른 앱에서 열어 보세요.'), what));
    let allowed = limit;
    const parsing = () => {
      if (allowed > 0) arm(allowed, stuck(T('엑셀 해석이 {s}초 안에 끝나지 않음', { s: Math.round(allowed / 1000) })));
      else clearTimeout(timer);
    };
    worker.onmessage = ({ data }) => {
      if (data.ready) return parsing();
      if (data.checked !== undefined) {
        // 압축이 멀쩡하면 느린 것일 뿐이므로 넉넉히 기다린다(시간은 엔진을 불러온 때부터 다시 잰다).
        if (data.checked && limit > 0) {
          allowed = Math.min(300000, Math.round(limit * 4.5));
          parsing();
        }
        return undefined;
      }
      if (data.parsed) {
        if (allowed > 0) arm(10000 + allowed, stuck(T('엑셀 해석 뒤 정리가 끝나지 않음')));
        return undefined;
      }
      clearTimeout(timer);
      worker.terminate();
      if (data.ok) resolve(data.wb);
      else reject(new Error(data.error));
      return undefined;
    };
    worker.onerror = (ev) => {
      clearTimeout(timer);
      worker.terminate();
      workerFailed(`작업 스레드 오류: ${ev.message || '알 수 없음'}`);
    };
    if (warm && warm.ready) parsing();
    else arm(60000, () => workerFailed('작업 스레드가 1분 안에 엔진을 불러오지 못함'));
    if (typeof input === 'string') worker.postMessage({ bytes: input, opts });
    else {
      const copy = input.slice();
      worker.postMessage({ bytes: copy, opts }, [copy.buffer]);
    }
  });
}

function colName(c) {
  let s = '';
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}

// 결과값 없이 수식만 저장된 칸이 있으면 수식 계산기를 불러 계산한다(엑셀·LibreOffice가 저장한 파일은 해당 없음).
async function fillFormulas(XLSX, wb) {
  if (wb.FormulasFilled) return 0; // 작업 스레드에서 이미 계산했다
  let missing = 0;
  for (const name of wb.SheetNames || []) {
    const ws = wb.Sheets[name] || {};
    for (const key of Object.keys(ws)) {
      const c = ws[key];
      if (key[0] !== '!' && c && c.f && (c.t === 'z' || c.v === undefined)) missing++;
    }
  }
  if (!missing) return 0;
  try {
    const mod = await import('./vendor/formula.js');
    // 작업 스레드를 못 쓸 때만 여기서 계산한다. 화면이 굳는 동안이므로 3초까지만.
    return mod.fillMissingFormulas(XLSX, wb, { limit: 20000, deadline: performance.now() + 3000 });
  } catch (e) {
    console.warn('formula:', e);
    return 0;
  }
}

// 엑셀 한국어판 날짜·시간 서식: aaa(요일)·aaaa(○요일), 한국어 지정([$-412])의 ddd·dddd, 오전/오후(AM/PM).
// SheetJS는 이것들을 영어(Wed, PM)나 글자 그대로(aaa)로 보여줘서 직접 맞춘다.
const KO_DAYS = ['일', '월', '화', '수', '목', '금', '토'];

function koreanDateText(XLSX, cell, date1904) {
  const z = cell.z;
  if (cell.t !== 'n' || typeof cell.v !== 'number' || typeof z !== 'string' || !/[aA]|[dD]{3}/.test(z)) return null;
  const parts = z.split(/("(?:[^"]|"")*"|\\.)/);
  const plain = parts.filter((_, i) => i % 2 === 0).join('');
  const ko = /\[\$-(?:412|0412|ko)/i.test(plain);
  const hasA = /a{3,4}/i.test(plain.replace(/AM\/PM|A\/P/gi, ''));
  const hasAmPm = /AM\/PM/i.test(plain);
  const hasD = ko && /d{3,4}/i.test(plain);
  if (!hasA && !hasAmPm && !hasD) return null;
  const serial = Math.floor(cell.v) + (date1904 ? 1462 : 0);
  const day = KO_DAYS[new Date(Date.UTC(1899, 11, 30) + serial * 86400000).getUTCDay()];
  const fmt = parts.map((p, i) => {
    if (i % 2) return p;
    let q = p.replace(/aaaa/gi, `"${day}요일"`).replace(/aaa/gi, `"${day}"`);
    if (ko) q = q.replace(/dddd/gi, `"${day}요일"`).replace(/ddd/gi, `"${day}"`);
    return q;
  }).join('');
  try {
    let out = XLSX.SSF.format(fmt, cell.v, { date1904 });
    if (hasAmPm) out = out.replace(/\bAM\b/, '오전').replace(/\bPM\b/, '오후');
    return out;
  } catch (_) {
    return null;
  }
}

// 엑셀 내장 날짜 서식 14번("간단한 날짜")·22번은 컴퓨터 지역 설정을 따라 한국어 엑셀에서는 2026-10-07처럼 보인다.
// SheetJS는 미국식(10/7/26)으로 바꾸고, 한국어판 전용 내장 서식(27·31·32번 등)도 14번으로 처리해서 한국식으로 고쳐 보여준다.
const LOCALE_FORMATS = { 'm/d/yy': 'yyyy-mm-dd', 'm/d/yy h:mm': 'yyyy-mm-dd h:mm' };

function localeDateText(XLSX, cell, date1904) {
  if (cell.t !== 'n' || typeof cell.v !== 'number') return null;
  // 한국어판 전용 내장 서식은 서식 문자열 없이 미국식 날짜 글자(10/7/26)만 남는다.
  const guessed = !cell.z && typeof cell.w === 'string' && /^\d{1,2}\/\d{1,2}\/\d{2}( \d{1,2}:\d{2})?$/.test(cell.w)
    ? (cell.w.includes(':') ? 'm/d/yy h:mm' : 'm/d/yy') : null;
  const fmt = LOCALE_FORMATS[cell.z || guessed];
  if (!fmt) return null;
  try {
    return XLSX.SSF.format(fmt, cell.v, { date1904 });
  } catch (_) {
    return null;
  }
}

// [DBNum1]~[DBNum4] 한국어 숫자 표기. 견적서의 "일금 ○○원정"처럼 금액을 한글·한자로 쓸 때 쓴다.
// 글자 고르기는 LibreOffice의 한국어 표기와 같게 맞췄다(예: 12345 → 일만이천삼백사십오, [DBNum2] → 壹萬貳阡參佰四拾伍).
const DBNUM = {
  1: { digits: '零一二三四五六七八九', small: ['千', '百', '十', ''], big: ['', '万', '億', '兆'], zero: false },
  2: { digits: '零壹貳參四伍六七八九', small: ['阡', '佰', '拾', ''], big: ['', '萬', '億', '兆'], zero: true },
  3: { digits: '０１２３４５６７８９', small: ['천', '백', '십', ''], big: ['', '만', '억', '조'], zero: false },
  4: { digits: '영일이삼사오육칠팔구', small: ['천', '백', '십', ''], big: ['', '만', '억', '조'], zero: false },
};

function koreanNumber(n, style) {
  const t = DBNUM[style];
  if (n === 0) return t.digits[0];
  const groups = [];
  for (let x = n; x > 0; x = Math.floor(x / 10000)) groups.push(x % 10000);
  let out = '';
  let pendingZero = false;
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g];
    const ds = String(group).padStart(4, '0');
    let wrote = false;
    pendingZero = false; // 零은 한 묶음(네 자리) 안에서만 넣는다
    for (let i = 0; i < 4; i++) {
      const d = Number(ds[i]);
      if (d === 0) {
        if (out) pendingZero = true;
        continue;
      }
      if (pendingZero && t.zero) out += t.digits[0];
      pendingZero = false;
      out += t.digits[d] + t.small[i];
      wrote = true;
    }
    if (wrote) out += t.big[g];
  }
  return out;
}

function dbnumText(XLSX, cell) {
  const z = cell.z;
  if (cell.t !== 'n' || typeof cell.v !== 'number' || typeof z !== 'string') return null;
  const m = /\[DBNum([1-4])\]/i.exec(z);
  if (!m) return null;
  // [$-412] 같은 언어 지정은 지운다(SheetJS가 '$'로 찍는다). [$₩-412]처럼 기호가 있는 통화 표시는 남긴다.
  let fmt = z.replace(/\[DBNum[1-4]\]/gi, '').replace(/\[\$-[0-9A-Fa-f]+\]/g, '');
  const v = cell.v;
  if (Number.isInteger(v) && v >= 0 && v < 1e16) {
    const words = koreanNumber(v, Number(m[1]));
    // 따옴표 밖의 숫자 자리(General·G/표준·#,##0 등)를 한글 표기로 바꾸고, 앞뒤 글자는 그대로 둔다.
    let replaced = false;
    fmt = fmt.split(/("(?:[^"]|"")*")/).map((p, i) => {
      if (i % 2 || replaced) return p;
      return p.replace(/General|G\/표준|[#0?][#0?,.]*/i, () => {
        replaced = true;
        return `"${words}"`;
      });
    }).join('');
    if (!replaced) fmt = `"${words}"`;
  }
  try {
    return XLSX.SSF.format(fmt.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0], v);
  } catch (_) {
    return null;
  }
}

// 서식의 [Red]·[Blue] 같은 글자색(음수를 빨갛게 등). 엑셀은 파일에 영어 이름으로 저장한다.
const FORMAT_COLORS = { red: 'var(--num-red)', blue: 'var(--num-blue)', green: 'var(--num-green)', magenta: 'var(--num-magenta)' };

function formatColor(cell) {
  if (cell.t !== 'n' || typeof cell.v !== 'number' || typeof cell.z !== 'string' || !cell.z.includes('[')) return null;
  const sections = cell.z.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const sec = cell.v < 0 && sections.length > 1 ? sections[1]
    : cell.v === 0 && sections.length > 2 ? sections[2] : sections[0];
  const m = /\[(red|blue|green|magenta)\]/i.exec(sec);
  return m ? FORMAT_COLORS[m[1].toLowerCase()] : null;
}

// 칸 배경색(단색 채우기, 테마 색은 엔진이 RGB로 풀어 준다). 흰색 채우기는 눈금선을 감추려고 쓰는 경우가 많아
// 기본 배경으로 둔다(어두운 화면에서 흰 판이 튀지 않게).
function fillColor(cell) {
  const s = cell.s;
  if (!s || s.patternType !== 'solid' || !s.fgColor) return null;
  const m = /^(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(s.fgColor.rgb || '');
  return m && m[1].toUpperCase() !== 'FFFFFF' ? m[1] : null;
}

// 엔진이 글자색은 읽지 못하므로, 배경을 칠한 칸은 배경 밝기에 맞춰 글자색을 정한다(어두운 화면 설정에서도 읽히게).
function textOn(hex) {
  const n = parseInt(hex, 16);
  const luma = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma < 140 ? '#ffffff' : '#1f1f1f';
}

// 휴대폰 화면 크기(CSS 픽셀). 넓은 표를 띄우면 innerWidth·innerHeight는 표 크기로 커지므로 쓰지 않는다.
function screenSize() {
  const d = document.documentElement;
  return { w: Math.min(window.innerWidth, d.clientWidth || window.innerWidth), h: Math.min(window.innerHeight, d.clientHeight || window.innerHeight) };
}

// 엑셀 칸 서식(sheet-format.js가 읽은 글꼴·정렬·테두리)을 화면 표기로 바꾼다.
const BORDER_CSS = {
  thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', double: '3px double',
  dashed: '1px dashed', dotted: '1px dotted', mediumDashed: '2px dashed', dashDot: '1px dashed',
  dashDotDot: '1px dotted', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed',
};
const H_CSS = { left: 'left', center: 'center', right: 'right', justify: 'justify', fill: 'left', centerContinuous: 'center', distributed: 'justify' };
const V_CSS = { top: 'top', center: 'middle', bottom: 'bottom', justify: 'middle', distributed: 'middle' };

function relLuminance(hex) {
  const n = parseInt(hex, 16);
  const ch = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

function contrastRatio(a, b) {
  const x = relLuminance(a);
  const y = relLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// 칸에 글꼴·색·정렬·테두리를 입힌다. 글자색이 배경과 거의 같으면(검은 글자 + 어두운 화면 등) 읽히는 색으로 바꾼다.
// cf: 조건부 서식이 입히는 서식({ fill, color, b, i, u, s, bar }) — 칸 자체 서식보다 앞선다(엑셀과 같음).
function styleCell(td, cell, ctx, cf) {
  const numColor = formatColor(cell);
  const fill = (cf && cf.fill ? cf.fill.slice(1).toUpperCase() : null) || fillColor(cell);
  const xf = ctx.fmt && cell.xf != null ? ctx.fmt.xfs[cell.xf] : null;
  const font = xf ? ctx.fmt.fonts[xf.f] : null;
  if (fill) td.style.backgroundColor = `#${fill}`;
  const bg = fill || ctx.surface;
  const fontColor = (cf && cf.color) || (font && font.color);
  if (numColor) td.style.color = numColor;
  else if (fontColor && contrastRatio(fontColor.slice(1), bg) >= 2.2) td.style.color = fontColor;
  else if (fill) td.style.color = textOn(fill);
  const pick = (k) => (cf && cf[k] != null ? cf[k] : !!(font && font[k]));
  if (pick('b')) td.style.fontWeight = '700';
  else if (font && font.b) td.style.fontWeight = '400';
  if (pick('i')) td.style.fontStyle = 'italic';
  if (pick('u') || pick('s')) td.style.textDecoration = [pick('u') ? 'underline' : '', pick('s') ? 'line-through' : ''].join(' ').trim();
  if (font) {
    if (font.sz && Math.abs(font.sz - ctx.baseSz) > 0.4) td.style.fontSize = `${(font.sz * 4 / 3).toFixed(1)}px`;
    if (font.serif) td.style.fontFamily = 'serif';
  }
  // 데이터 막대: 값 크기만큼 칸 왼쪽부터 반투명 막대를 깐다(글자는 그 위에 그대로).
  if (cf && cf.bar) {
    const c = /^#[0-9a-f]{6}$/i.test(cf.bar.color) ? cf.bar.color : '#638EC6';
    const pct = Math.round(cf.bar.pct * 10) / 10;
    td.style.backgroundImage = `linear-gradient(to right, ${c}a6 0, ${c}a6 ${pct}%, transparent ${pct}%)`;
    if (cf.bar.hideValue) td.style.color = 'transparent';
  }
  if (!xf) return null;
  if (xf.h && H_CSS[xf.h]) td.style.textAlign = H_CSS[xf.h];
  if (xf.v && xf.v !== 'bottom') td.style.verticalAlign = V_CSS[xf.v] || 'bottom';
  if (xf.wrap) td.classList.add('wrap');
  if (xf.indent) td.style.paddingLeft = `${4 + xf.indent * 9}px`;
  for (const [k, side] of [['l', 'Left'], ['r', 'Right'], ['t', 'Top'], ['b', 'Bottom']]) {
    const b = xf.bd && xf.bd[k];
    if (!b) continue;
    const c = b[1] && contrastRatio(b[1].slice(1), ctx.surface) >= 1.6 ? b[1] : 'var(--xl-border)';
    td.style[`border${side}`] = `${BORDER_CSS[b[0]] || '1px solid'} ${c}`;
  }
  return xf;
}

// 칸 글자(화면에 보이는 그대로)
// 엑셀 칸 하나에 들어가는 글자는 32,767자까지다. 프로그램이 만든 파일에는 수백만 자짜리 칸도 있어(화면 2초 멈춤) 그 뒤는 줄인다.
const CELL_TEXT_MAX = 32767;

function cellText(XLSX, cell, date1904) {
  const text = cellTextFull(XLSX, cell, date1904);
  return text.length > CELL_TEXT_MAX ? `${text.slice(0, CELL_TEXT_MAX)}…` : text;
}

function cellTextFull(XLSX, cell, date1904) {
  const present = (x) => x != null && x !== '';
  // 계산 결과가 저장되지 않은 수식 칸(일부 프로그램이 만든 파일)은 수식을 그대로 보여준다.
  if (cell.t === 'z') return cell.f ? `=${cell.f}` : '';
  const korean = koreanDateText(XLSX, cell, date1904) ?? dbnumText(XLSX, cell) ?? localeDateText(XLSX, cell, date1904);
  if (korean != null) return korean;
  if (present(cell.w)) return String(cell.w);
  if (present(cell.v)) return String(cell.v);
  return '';
}

function cellComment(cell) {
  if (!cell || !Array.isArray(cell.c) || !cell.c.length) return '';
  return cell.c.map((c) => [c.a, c.t].filter(Boolean).join(': ')).join('\n').trim();
}

// 칸을 누르면 잘린 글자·메모를 전부 보여 준다.
function showCellPopup(address, text, note) {
  document.querySelector('.cell-pop')?.remove();
  const pop = el('div', 'cell-pop');
  pop.setAttribute('role', 'dialog');
  pop.append(el('div', 'cell-pop-addr', address));
  if (text) pop.append(el('div', 'cell-pop-text', text));
  if (note) {
    pop.append(el('div', 'cell-pop-label', T('메모')));
    pop.append(el('div', 'cell-pop-text', note));
  }
  const close = el('button', 'btn', T('닫기'));
  close.type = 'button';
  pop.append(popFoot(close));
  const done = () => {
    pop.remove();
    document.removeEventListener('click', outside, true);
  };
  const outside = (e) => {
    if (!pop.contains(e.target) || e.target === close) {
      e.stopPropagation();
      done();
    }
  };
  $('screen').append(pop);
  setTimeout(() => document.addEventListener('click', outside, true), 0);
  close.focus({ preventScroll: true });
}

// 표는 DOM API(textContent)로만 만든다. 칸 내용이 HTML로 해석될 일이 없다.
// opts: { fmt: 통합 문서 서식(sheet-format.js), sheet: 이 시트의 보기 설정, showHidden, onShowHidden, drawings }
function renderSheet(XLSX, ws, date1904, opts = {}) {
  const wrap = el('div', 'sheet');
  const ref = ws['!ref'];
  const info = opts.drawings || null;
  if (!ref) {
    wrap.append(el('p', 'sheet-empty', T('빈 시트예요.')));
    return wrap;
  }
  const fmt = opts.fmt || null;
  const sheet = opts.sheet || null;
  const range = XLSX.utils.decode_range(ref);
  // 엑셀처럼 A1부터 보여준다(자료가 아주 멀리서 시작하는 경우는 빼고). 위쪽 빈 줄에 놓인 로고·제목 그림도 자리가 생긴다.
  if (range.s.r <= 200) range.s.r = 0;
  if (range.s.c <= 50) range.s.c = 0;
  // 그림·차트가 자료 범위 밖(오른쪽·아래)에 놓였으면 그 칸까지 표를 넓혀 엑셀처럼 격자 위에 보이게 한다.
  for (const im of (info && info.objects) || []) {
    const endC = im.to ? im.to.c : im.from.c + Math.ceil(im.cx / 9525 / 64);
    const endR = im.to ? im.to.r : im.from.r + Math.ceil(im.cy / 9525 / 20);
    range.e.c = Math.max(range.e.c, Math.min(endC, range.s.c + 60));
    range.e.r = Math.max(range.e.r, Math.min(endR, range.s.r + MAX_SHEET_ROWS - 1));
  }
  const lastCol = Math.min(range.e.c, range.s.c + MAX_SHEET_COLS - 1);
  const lastRow = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);

  // 숨긴 행·열은 엑셀처럼 빼고 그린다(안내 띠에서 펼칠 수 있다).
  const hiddenRow = (r) => !opts.showHidden && !!(sheet && sheet.rows[r] && sheet.rows[r].hidden);
  const hiddenCol = (c) => !opts.showHidden && !!(sheet && sheet.cols[c] && sheet.cols[c].hidden);
  const cols = [];
  for (let c = range.s.c; c <= lastCol; c++) if (!hiddenCol(c)) cols.push(c);
  const rows = [];
  for (let r = range.s.r; r <= lastRow; r++) if (!hiddenRow(r)) rows.push(r);
  let hiddenRows = 0;
  let hiddenCols = 0;
  if (sheet) {
    for (let r = range.s.r; r <= lastRow; r++) if (sheet.rows[r] && sheet.rows[r].hidden) hiddenRows++;
    for (let c = range.s.c; c <= lastCol; c++) if (sheet.cols[c] && sheet.cols[c].hidden) hiddenCols++;
  }
  const rowPos = new Map(rows.map((r, i) => [r, i]));
  const colPos = new Map(cols.map((c, i) => [c, i]));

  const dense = Array.isArray(ws['!data']) ? ws['!data'] : null;
  const cellAt = (r, c) => (dense ? (dense[r] || [])[c] : ws[XLSX.utils.encode_cell({ r, c })]);
  const hasValue = (cell) => !!cell && ((cell.v != null && cell.v !== '') || (cell.t === 'z' && !!cell.f));
  // 조건부 서식(값에 따라 바뀌는 색): 칸을 그릴 때 그 칸에 맞는 규칙을 계산한다.
  let cond = null;
  try {
    cond = opts.cond ? opts.cond(cellAt, XLSX.utils.decode_range(ref)) : null;
  } catch (e) {
    console.warn('조건부 서식을 계산하지 못함', e);
  }

  // 병합 칸: 보이는 첫 칸이 span을 갖고 나머지는 건너뛴다(왼쪽 위 칸이 숨겨져도 표가 어긋나지 않게).
  const spans = new Map();
  const covered = new Set();
  const inMerge = new Set();
  const mergeEnd = new Map(); // 병합 칸이 이 행 아래로 이어지면 여기서 표를 나누면 안 된다
  for (const m of ws['!merges'] || []) {
    // 열 전체를 합친 병합(B1:B1048576 등)도 있으므로 그릴 범위 안으로 잘라서 펼친다(전체를 펼치면 수십 초 멈춘다).
    if (m.e.r < range.s.r || m.s.r > lastRow || m.e.c < range.s.c || m.s.c > lastCol) continue;
    const mr = rows.filter((r) => r >= m.s.r && r <= m.e.r);
    const mc = cols.filter((c) => c >= m.s.c && c <= m.e.c);
    for (let r = Math.max(m.s.r, range.s.r); r <= Math.min(m.e.r, lastRow); r++) {
      for (let c = Math.max(m.s.c, range.s.c); c <= Math.min(m.e.c, lastCol); c++) inMerge.add(`${r}:${c}`);
    }
    if (!mr.length || !mc.length) continue;
    spans.set(`${mr[0]}:${mc[0]}`, { rows: mr.length, cols: mc.length, src: { r: m.s.r, c: m.s.c } });
    for (const r of mr) for (const c of mc) if (r !== mr[0] || c !== mc[0]) covered.add(`${r}:${c}`);
    for (let i = 0; i < mr.length - 1; i++) mergeEnd.set(mr[i], Math.max(mergeEnd.get(mr[i]) || 0, mr[mr.length - 1]));
  }

  // 열 너비: 엑셀에 너비가 적혀 있으면 그 너비로 고정하고(긴 글자는 엑셀처럼 옆 빈 칸으로 넘친다),
  // 없으면(웹 시스템이 만든 파일·CSV) 글자에 맞춘 뒤 고정한다.
  const excelWidths = !!(sheet && sheet.widths);
  const colPx = (c) => (sheet && sheet.cols[c] && sheet.cols[c].px != null ? sheet.cols[c].px : (sheet ? sheet.defCol : 64));
  const ROW_HEAD = 44;
  const ctx = {
    cond,
    fmt,
    baseSz: (fmt && fmt.fonts[0] && fmt.fonts[0].sz) || 11,
    surface: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '24262B' : 'FFFFFF',
  };
  if (fmt) {
    wrap.classList.add('excel');
    wrap.style.setProperty('--cell-font', `${(ctx.baseSz * 4 / 3).toFixed(1)}px`);
  }
  if (sheet && sheet.grid === false) wrap.classList.add('no-grid');

  let widths = null; // [행 머리, 보이는 열...] 픽셀
  const colgroup = () => {
    const g = el('colgroup');
    for (const w of widths) {
      const col = el('col');
      col.style.width = `${w}px`;
      g.append(col);
    }
    return g;
  };
  const totalWidth = () => widths.reduce((a, b) => a + b, 0);
  if (excelWidths) widths = [ROW_HEAD, ...cols.map((c) => Math.max(colPx(c), 2))];

  // 틀 고정: 위쪽 행은 열 머리와 함께 위에 붙고, 왼쪽 열은 행 머리와 함께 왼쪽에 붙는다.
  // 화면을 너무 많이 가리면(행 35% 넘게·열 절반 넘게) 붙이지 않는다.
  let freezeRows = 0;
  let freezeCols = 0;
  if (sheet && sheet.freeze) {
    const fr = rows.filter((r) => r < sheet.freeze.r);
    const fc = cols.filter((c) => c < sheet.freeze.c);
    const crossesRows = (ws['!merges'] || []).some((m) => m.s.r < sheet.freeze.r && m.e.r >= sheet.freeze.r);
    const crossesCols = (ws['!merges'] || []).some((m) => m.s.c < sheet.freeze.c && m.e.c >= sheet.freeze.c);
    if (fr.length && fr.length <= 30 && !crossesRows) freezeRows = fr.length;
    if (fc.length && !crossesCols) freezeCols = fc.length;
  }
  const stickyLeft = []; // 보이는 열 순서 → 왼쪽에서 띄울 거리(고정 열만)

  const addRow = (tbody, r) => {
    const tr = el('tr');
    tr.dataset.r = String(r);
    const rowInfo = sheet && sheet.rows[r];
    if (rowInfo && rowInfo.px) tr.style.height = `${rowInfo.px}px`;
    tr.append(el('th', 'row-head', String(r + 1)));
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const key = `${r}:${c}`;
      if (covered.has(key)) continue;
      const span = spans.get(key);
      const src = span ? span.src : { r, c };
      const cell = cellAt(src.r, src.c);
      const td = el('td');
      let cf = null;
      if (ctx.cond) {
        try {
          cf = ctx.cond.at(src.r, src.c, cell);
        } catch (_) {
          cf = null;
        }
      }
      if (!cell && cf) styleCell(td, { t: 'z' }, ctx, cf);
      if (cell) {
        const text = cellText(XLSX, cell, date1904);
        if (cell.t) td.dataset.t = cell.t;
        const xf = styleCell(td, cell, ctx, cf);
        // 왼쪽 정렬 글자가 칸보다 길면 엑셀처럼 오른쪽 빈 칸들 위로 이어 보이게 한다(가운데 맞춤 이어가기 포함).
        const across = xf && xf.h === 'centerContinuous';
        const leftText = !xf || !xf.h || xf.h === 'left';
        if (excelWidths && !span && text && (across || (leftText && cell.t === 's')) && !(xf && xf.wrap)) {
          let spill = 0;
          for (let j = i + 1; j < cols.length && spill < 2400; j++) {
            const nc = cols[j];
            if (inMerge.has(`${r}:${nc}`) || hasValue(cellAt(r, nc))) break;
            spill += colPx(nc);
          }
          if (spill > 0) {
            td.classList.add('spill');
            if (across) td.classList.add('spill-center');
            td.style.setProperty('--spill', `${spill}px`);
            td.append(el('span', 'spill-text', text));
          } else td.textContent = text;
        } else td.textContent = text;
        const note = cellComment(cell);
        if (note) td.classList.add('has-note');
        // 조건부 서식 아이콘(신호등·화살표 등)은 칸 왼쪽에, 값은 원래 자리에 둔다.
        if (cf && cf.icon) {
          const icon = el('span', 'cf-icon', cf.icon.glyph);
          icon.style.color = cf.icon.color;
          icon.setAttribute('aria-hidden', 'true');
          if (cf.icon.hideValue) td.replaceChildren(icon);
          else td.prepend(icon);
        }
      }
      if (span) {
        if (span.rows > 1) td.rowSpan = span.rows;
        if (span.cols > 1) td.colSpan = span.cols;
      }
      // 고정 열 칸이라도 글자가 옆 칸으로 넘치면(표 제목 등) 붙이지 않는다(넘친 글자가 가려지지 않게).
      if (i < freezeCols && stickyLeft[i] != null && !td.classList.contains('spill')) td.classList.add('stick-left');
      td.dataset.c = String(c);
      tr.append(td);
    }
    tbody.append(tr);
  };
  const addRows = (tbody, from, to) => {
    for (let i = from; i <= to; i++) addRow(tbody, rows[i]);
  };
  // 보이는 행 순서로 나눌 자리를 고른다(병합이 걸쳐 있으면 그 끝까지).
  const safeEnd = (end) => {
    let e = Math.min(end, rows.length - 1);
    while (e < rows.length - 1 && mergeEnd.has(rows[e])) e = Math.min(rows.length - 1, rowPos.get(mergeEnd.get(rows[e])) ?? e + 1);
    return e;
  };

  const table = el('table', 'sheet-body');
  const thead = el('thead');
  const headRow = el('tr', 'col-heads');
  headRow.append(el('th', 'col-head corner', ''));
  cols.forEach((c, i) => {
    const th = el('th', i < freezeCols ? 'col-head stick-left' : 'col-head', colName(c));
    th.dataset.c = String(c);
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);
  const setLefts = () => {
    let x = widths[0];
    for (let i = 0; i < freezeCols; i++) {
      stickyLeft[i] = x;
      x += widths[i + 1];
    }
  };
  if (widths) {
    table.prepend(colgroup());
    table.style.width = `${totalWidth()}px`;
    table.style.tableLayout = 'fixed';
    setLefts();
  }

  // 처음 200행은 바로 그린다. 나머지 행은 읽는 사람이 표 끝 가까이 내려오면 100행씩 표 조각으로 이어 붙인다.
  // 행이 수천 개인 시트를 한꺼번에 그리면 행을 붙일 때마다 배치 계산이 표 전체에 걸려(중급 휴대폰 근사에서
  // 한 번에 0.5초 안팎) 화면이 굳는다. 화면 밖으로 지나간 조각은 브라우저가 배치·그리기를 건너뛴다(content-visibility).
  const tbody = el('tbody');
  const firstEnd = rows.length ? safeEnd(Math.max(199, freezeRows - 1)) : -1;
  addRows(tbody, 0, firstEnd);
  table.append(tbody);
  wrap.append(table);
  let next = firstEnd + 1;
  let lastPart = table;
  // 글자에 맞춘 열 너비를 재서 고정한다(나머지 조각과 위에 붙는 머리가 같은 너비를 쓰게).
  // 너비 정보가 없는 시트는 처음 그린 행의 글자에 맞춰 너비를 고정한다. 그러면 뒤쪽 행의 더 긴 값(예: 1000.5)이 잘리므로,
  // 나머지 행에서 열마다 가장 긴 글자를 찾아 재고 그만큼 넓힌다(28em까지, 합친 칸은 빼고).
  const widenForRest = () => {
    const sample = table.querySelector('tbody td');
    const font = sample ? getComputedStyle(sample).font : '14px sans-serif';
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    const longest = cols.map(() => '');
    let budget = 300000;
    for (let k = next; k < rows.length && budget > 0; k++) {
      const r = rows[k];
      for (let i = 0; i < cols.length; i++, budget--) {
        const key = `${r}:${cols[i]}`;
        if (covered.has(key) || (spans.get(key) && spans.get(key).cols > 1)) continue;
        const cell = cellAt(r, cols[i]);
        if (!cell) continue;
        for (const line of cellText(XLSX, cell, date1904).split('\n')) if (line.length > longest[i].length) longest[i] = line;
      }
    }
    const cap = (parseFloat(font) || 14) * 28;
    longest.forEach((t, i) => {
      if (!t) return;
      const w = Math.ceil(Math.min(cap, measure.measureText(t).width + 20));
      if (w > widths[i + 1]) widths[i + 1] = w;
    });
  };
  const fixWidths = () => {
    if (widths) return;
    // 너비가 적히지 않은 시트는 글자에 맞춘 너비를 쓰되, 아주 긴 글자(합친 칸의 긴 제목 등) 하나로 열이 화면 수백 개만큼
    // 넓어지지 않게 글자 28자 폭에서 멈춘다(넘친 글자는 "…", 칸을 누르면 전체).
    const capPx = (parseFloat(getComputedStyle(headRow.children[0] || headRow).fontSize) || 14) * 28;
    widths = [...headRow.children].map((th, i) => (i ? Math.min(th.getBoundingClientRect().width, Math.max(capPx, 400)) : th.getBoundingClientRect().width));
    if (next < rows.length) {
      try {
        widenForRest();
      } catch (e) {
        console.warn('열 너비를 넓히지 못함', e);
      }
    }
    table.prepend(colgroup());
    table.style.width = `${totalWidth()}px`;
    table.style.tableLayout = 'fixed';
    setLefts();
  };
  const appendPart = () => {
    if (next >= rows.length) return false;
    fixWidths();
    const t = el('table', 'sheet-part');
    t.append(colgroup());
    t.style.width = `${totalWidth()}px`;
    t.style.tableLayout = 'fixed';
    const end = safeEnd(next + 99);
    const body = el('tbody');
    addRows(body, next, end);
    t.append(body);
    lastPart.after(t);
    lastPart = t;
    next = end + 1;
    return true;
  };

  // 열 머리(와 고정 행)를 따로 떼어 화면 위에 붙인다. 표 조각이 여러 개여도 함께 따라온다.
  wrap.stickHead = () => {
    if (!rows.length || wrap.querySelector('.sheet-head')) return;
    fixWidths();
    const head = el('table', 'sheet-head');
    head.append(colgroup());
    head.style.width = `${totalWidth()}px`;
    head.style.tableLayout = 'fixed';
    head.append(thead);
    if (freezeRows) {
      const hb = el('tbody');
      const trs = [...tbody.children].slice(0, freezeRows);
      // 고정 행이 화면 높이의 35%를 넘으면 붙이지 않는다(나머지를 볼 자리가 없어진다).
      const h = trs.reduce((n, tr) => n + tr.getBoundingClientRect().height, 0);
      if (h <= screenSize().h * 0.35) hb.append(...trs);
      head.append(hb);
    }
    table.before(head);
    // 고정 열이 화면 폭의 절반을 넘으면 붙이지 않는다.
    if (freezeCols && stickyLeft[freezeCols - 1] + widths[freezeCols] > screenSize().w * 0.5) {
      wrap.querySelectorAll('.stick-left').forEach((td) => td.classList.remove('stick-left'));
      freezeCols = 0;
    } else if (freezeCols) {
      // 글자에 맞춘 너비를 잰 뒤라면 이미 그린 행에도 고정을 입힌다.
      wrap.querySelectorAll('tr').forEach((tr) => {
        for (const td of tr.children) {
          if (td.tagName !== 'TD' || td.classList.contains('spill')) continue;
          const pos = colPos.get(Number(td.dataset.c));
          if (pos == null || pos >= freezeCols) break;
          td.classList.add('stick-left');
        }
      });
    }
  };

  // 그려진 마지막 행 근처에 오면 다음 조각을 붙인다.
  const sentinel = el('div', 'sheet-more');
  if (next < rows.length) {
    sentinel.textContent = T('{n}행 더 있어요', { n: (rows.length - next).toLocaleString() });
    table.after(sentinel);
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      appendPart();
      lastPart.after(sentinel);
      if (next >= rows.length) {
        io.disconnect();
        sentinel.remove();
      } else {
        sentinel.textContent = T('{n}행 더 있어요', { n: (rows.length - next).toLocaleString() });
        // 화면이 아직 감시 영역 안이면(빠르게 내린 경우) 한 번 더 확인한다.
        io.unobserve(sentinel);
        io.observe(sentinel);
      }
    }, { rootMargin: '0px 0px 1500px 0px' });
    io.observe(sentinel);
  }
  // 아직 그리지 않은 행까지 모두 그린다(그 행에 놓인 그림 위치를 잴 때만 쓴다).
  wrap.renderUntil = (row) => {
    const target = rows.findIndex((r) => r >= row);
    const until = target < 0 ? rows.length - 1 : target;
    while (next <= until && appendPart()) { /* 이어서 그린다 */ }
    if (next >= rows.length) sentinel.remove();
    else lastPart.after(sentinel);
  };

  // 칸을 누르면 잘린 글자·메모를 보여 준다.
  wrap.addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td');
    if (!td || !wrap.contains(td)) return;
    const span = td.querySelector('.spill-text');
    const box = span || td;
    const clipped = box.scrollWidth > box.clientWidth + 1 || td.scrollHeight > td.clientHeight + 1;
    const r = Number(td.parentElement.dataset.r);
    const c = Number(td.dataset.c);
    const cell = cellAt(r, c);
    const note = cellComment(cell);
    if (!clipped && !note) return;
    showCellPopup(`${colName(c)}${r + 1}`, td.textContent, note);
  });

  // 앱이 계산한 수식 칸 수(보이는 범위 안). 있는 칸만 훑는다.
  let computed = 0;
  let notes = 0;
  for (const key of Object.keys(ws)) {
    const cell = ws[key];
    if (key[0] === '!' || !cell) continue;
    if (!cell.computed && !cellComment(cell)) continue;
    const at = XLSX.utils.decode_cell(key);
    if (at.r < range.s.r || at.r > lastRow || at.c < range.s.c || at.c > lastCol) continue;
    if (cell.computed) computed++;
    if (cellComment(cell)) notes++;
  }

  const full = ws['!fullref'] ? XLSX.utils.decode_range(ws['!fullref']) : range;
  // 이 시트의 안내는 문서 안내(위쪽 바 아래 한 줄)로 보낸다. 시트를 바꾸면 그 시트의 안내로 바뀐다(showSheetNotices).
  const notices = [];
  const notice = (note, priority) => {
    note.classList.add('sheet-note');
    note.dataset.priority = String(priority);
    notices.push(note);
    return note;
  };
  // 잘라서 보여 줄 때: 안내 맨 앞(한 줄 요약)에 전체 행·열 수를 알리고, 표 끝에도 짧게 적는다(끝까지 내려 "다 봤다"고 오해하지 않게).
  const cut = [];
  if (full.e.r > lastRow) {
    // 엔진이 읽기를 멈춘 곳(3,001행)이 아니라 파일에 적힌 마지막 행으로 전체 수를 센다. 모르면 수를 말하지 않는다.
    const totalRow = Math.max(full.e.r, (sheet && sheet.lastRow) || 0);
    const shown = (lastRow - range.s.r + 1).toLocaleString();
    cut.push(totalRow > MAX_SHEET_ROWS || (sheet && sheet.lastRow != null)
      ? T('전체 {a}행 중 처음 {s}행만 보여요.', { a: (totalRow - range.s.r + 1).toLocaleString(), s: shown })
      : T('처음 {s}행만 보여요(뒤에 더 있어요).', { s: shown }));
  }
  if (full.e.c > lastCol) cut.push(T('전체 {a}열 중 처음 {s}열만 보여요.', { a: (full.e.c - range.s.c + 1).toLocaleString(), s: MAX_SHEET_COLS }));
  if (cut.length) {
    notice(infoNote(T('{cut} 전체는 다른 앱에서 볼 수 있어요.', { cut: cut.join(' ') })), 3).classList.add('sheet-cut-note');
    const end = [];
    if (full.e.r > lastRow) end.push(T('처음 {n}행까지만 보여요.', { n: (lastRow - range.s.r + 1).toLocaleString() }));
    if (full.e.c > lastCol) end.push(T('처음 {n}열까지만 보여요.', { n: MAX_SHEET_COLS }));
    wrap.append(el('p', 'sheet-end', T('{cut} 전체는 다른 앱에서 볼 수 있어요.', { cut: end.join(' ') })));
  }
  const skippedCond = cond ? cond.skipped() : 0;
  const missing = info && info.missing ? missingText({ ...info.missing, cond: (info.missing.cond || 0) + skippedCond }) : (skippedCond ? missingText({ cond: skippedCond }) : '');
  if (missing) notice(infoNote(missing), 2);
  if (computed) notice(infoNote(T('결과가 저장되지 않은 수식 {n}칸은 앱이 계산했어요. 원본 엑셀과 다를 수 있어요.', { n: computed.toLocaleString() }), false), 2);
  if (notes) notice(infoNote(T('메모가 있는 칸 {n}개는 모서리의 빨간 삼각형을 누르면 볼 수 있어요.', { n: notes.toLocaleString() }), false), 1);
  if ((hiddenRows || hiddenCols) && opts.onShowHidden) {
    const what = joinList([hiddenRows ? T('행 {n}개', { n: hiddenRows.toLocaleString() }) : '', hiddenCols ? T('열 {n}개', { n: hiddenCols.toLocaleString() }) : ''].filter(Boolean));
    notice(opts.showHidden
      ? actionNote(T('숨긴 {what}도 보이고 있어요.', { what }), T('다시 숨기기'), () => opts.onShowHidden(false))
      : actionNote(T('숨긴 {what}가 있어요.', { what }), T('숨기기 취소'), () => opts.onShowHidden(true)), 1);
  }
  wrap.notices = notices;
  return wrap;
}

// 지금 보는 시트의 안내로 바꾼다(문서 전체 안내는 그대로).
function showSheetNotices(wrap) {
  clearNotices('sheet');
  for (const n of (wrap && wrap.notices) || []) addNotice(n, { scope: 'sheet' });
}

// 보여 주지 못한 그림·차트·도형 안내 글
function missingText(m) {
  const parts = [];
  if (m.charts) parts.push(T('차트 {n}개', { n: m.charts }));
  if (m.shapes) parts.push(T('도형·글상자 {n}개', { n: m.shapes }));
  if (m.pictures) parts.push(T('그림 {n}개(EMF·WMF 형식)', { n: m.pictures }));
  if (m.controls) parts.push(T('버튼·확인란 {n}개', { n: m.controls }));
  if (m.notes) parts.push(T('메모 {n}개', { n: m.notes }));
  if (m.cond) parts.push(T('조건부 서식 {n}개(값에 따라 바뀌는 색·아이콘)', { n: m.cond }));
  if (m.other) parts.push(T('개체 {n}개', { n: m.other }));
  return parts.length ? T('{list}는 표시되지 않아요.', { list: joinList(parts) }) : '';
}

function setZoomRange(minScale) {
  const meta = document.querySelector('meta[name="viewport"]');
  meta.setAttribute('content',
    `width=device-width, initial-scale=1, minimum-scale=${minScale}, maximum-scale=8, user-scalable=yes`);
}

// ---------------------------------------------------------------- 엑셀 속 그림(로고·직인 등)
// SheetJS 무료판은 그림을 읽지 않는다. xlsx(ZIP) 안의 그림 위치(drawing)를 직접 읽어 표 위에 얹는다.
// 표의 열 너비가 엑셀과 달라서 위치는 "어느 칸 근처"로 맞추고, 그림 크기는 비율을 지킨다.
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = base.split('/');
  out.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

function partXml(parts, name) {
  const b = parts.get(name.toLowerCase());
  return b ? new DOMParser().parseFromString(new TextDecoder().decode(b), 'application/xml') : null;
}

function byName(node, local) {
  return node ? [...node.getElementsByTagNameNS('*', local)] : [];
}

function partRels(parts, part) {
  const rels = new Map();
  const xml = partXml(parts, part.replace(/([^/]+)$/, '_rels/$1.rels'));
  for (const r of byName(xml, 'Relationship')) {
    if (r.getAttribute('TargetMode') === 'External') continue;
    rels.set(r.getAttribute('Id'), { type: r.getAttribute('Type') || '', target: resolvePart(part, r.getAttribute('Target') || '') });
  }
  return rels;
}

function anchorPoint(node) {
  const num = (k) => Number((byName(node, k)[0] || {}).textContent || 0);
  return { c: num('col'), cOff: num('colOff'), r: num('row'), rOff: num('rowOff') };
}

// ZIP 안에 이 글자(파일 이름 일부)가 있는지 바이트로 훑는다. 압축을 풀지 않으므로 큰 파일에서도 빠르다.
function bytesInclude(bytes, ascii) {
  const first = ascii.charCodeAt(0);
  const end = bytes.length - ascii.length;
  outer: for (let i = 0; i <= end; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < ascii.length; j++) if (bytes[i + j] !== ascii.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

const kidEl = (node, local) => (node ? [...node.children].find((n) => n.localName === local) || null : null);

// 문서 테마 색(이름 → RRGGBB). SheetJS가 읽은 색 목록(lt1·dk1·…·accent6 순서)
function themeMap(wb) {
  const out = {};
  const scheme = wb && wb.Themes && wb.Themes.themeElements && wb.Themes.themeElements.clrScheme;
  for (const c of Array.isArray(scheme) ? scheme : []) if (c && c.name && c.rgb) out[c.name] = String(c.rgb).slice(-6).toUpperCase();
  return out;
}

// 글상자·도형: 모양·채우기·선·문단(정렬)·글자(크기·굵기·색)
function parseShape(sp, theme, chart) {
  const spPr = kidEl(sp, 'spPr');
  const style = kidEl(sp, 'style');
  const prst = kidEl(spPr, 'prstGeom');
  const geom = prst ? prst.getAttribute('prst') : 'rect';
  let fill = chart.fillOf(spPr, theme);
  const ref = (name) => {
    const r = kidEl(style, name);
    return r && r.getAttribute('idx') !== '0' ? chart.drawingColor(r.firstElementChild, theme) : null;
  };
  if (fill == null) fill = ref('fillRef');
  let line = chart.lineOf(spPr, theme);
  if (!line || line.color == null) line = { color: line && line.color === 'none' ? 'none' : ref('lnRef'), w: (line && line.w) || 1 };
  const fontRef = kidEl(style, 'fontRef');
  const defColor = fontRef && fontRef.firstElementChild ? chart.drawingColor(fontRef.firstElementChild, theme) : null;
  const body = kidEl(sp, 'txBody');
  const bodyPr = kidEl(body, 'bodyPr');
  const paras = [];
  for (const p of body ? [...body.children].filter((n) => n.localName === 'p') : []) {
    const pPr = kidEl(p, 'pPr');
    const runs = [];
    for (const r of p.children) {
      if (r.localName === 'br') { runs.push({ t: '\n' }); continue; }
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const rPr = kidEl(r, 'rPr');
      const t = kidEl(r, 't');
      runs.push({
        t: t ? t.textContent : '',
        sz: rPr && rPr.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : null,
        b: rPr ? rPr.getAttribute('b') === '1' : false,
        i: rPr ? rPr.getAttribute('i') === '1' : false,
        color: rPr ? chart.fillOf(rPr, theme) : null,
      });
    }
    paras.push({ align: pPr ? pPr.getAttribute('algn') : null, runs });
  }
  const xfrm = kidEl(spPr, 'xfrm');
  return {
    kind: geom === 'line' || geom === 'straightConnector1' ? 'line' : 'shape',
    geom,
    fill,
    line,
    color: defColor,
    anchor: bodyPr ? bodyPr.getAttribute('anchor') || 't' : 't',
    paras,
    rot: xfrm ? Number(xfrm.getAttribute('rot') || 0) / 60000 : 0,
    flipH: xfrm ? xfrm.getAttribute('flipH') === '1' : false,
    flipV: xfrm ? xfrm.getAttribute('flipV') === '1' : false,
  };
}

// 묶음 안 도형의 위치(묶음 상자에 대한 비율)
function childFrac(node, groupXfrm) {
  const xfrm = kidEl(kidEl(node, 'spPr') || kidEl(node, 'grpSpPr'), 'xfrm');
  const off = kidEl(xfrm, 'off');
  const ext = kidEl(xfrm, 'ext');
  const chOff = kidEl(groupXfrm, 'chOff');
  const chExt = kidEl(groupXfrm, 'chExt');
  if (!off || !ext || !chExt) return null;
  const n = (e, k) => Number(e.getAttribute(k) || 0);
  const cw = n(chExt, 'cx') || 1;
  const chh = n(chExt, 'cy') || 1;
  return {
    x: (n(off, 'x') - (chOff ? n(chOff, 'x') : 0)) / cw,
    y: (n(off, 'y') - (chOff ? n(chOff, 'y') : 0)) / chh,
    w: n(ext, 'cx') / cw,
    h: n(ext, 'cy') / chh,
  };
}

// xlsx 시트의 그림·차트·도형을 모두 읽는다. 보여 줄 수 없는 것은 종류별로 센다(안내 띠에 쓴다).
async function readSheetDrawings(XLSX, bytes, wb) {
  const result = new Map();
  let parts;
  if (wb.files) {
    parts = new Map();
    for (const [k, e] of Object.entries(wb.files)) if (e && e.content && e.content.length) parts.set(k.replace(/^\/+/, '').toLowerCase(), e.content);
  } else {
    if (!bytesInclude(bytes, 'xl/drawings/')) return result; // 그림이 없는 파일은 다시 풀지 않는다
    await loadInflate();
    parts = lazyZip(XLSX, bytes); // 필요한 조각만 푼다(큰 파일에서 전체를 다시 풀면 화면이 굳는다)
  }
  if (![...parts.keys()].some((k) => k.startsWith('xl/drawings/') && !k.includes('vmldrawing'))) return result;
  const wbPart = 'xl/workbook.xml';
  const wbXml = partXml(parts, wbPart);
  if (!wbXml) return result;
  const chart = await import('./sheet-chart.js');
  const theme = themeMap(wb);
  // 차트가 값 대신 칸 주소만 가진 경우 그 칸을 읽는다: 'Sheet 1'!$A$2:$A$9
  const resolveRef = (f, numeric) => {
    const m = /^\(?(?:'((?:[^']|'')+)'|([^!'(]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?\)?$/.exec(String(f).trim());
    if (!m) return null;
    const ws = wb.Sheets[m[1] ? m[1].replace(/''/g, "'") : m[2]];
    if (!ws) return null;
    const a = XLSX.utils.decode_cell(m[3] + m[4]);
    const b = m[5] ? XLSX.utils.decode_cell(m[5] + m[6]) : a;
    const out = [];
    for (let r = a.r; r <= b.r && out.length < 5000; r++) {
      for (let c = a.c; c <= b.c && out.length < 5000; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        out.push(!cell || cell.v == null ? null : numeric ? cell.v : (cell.w ?? String(cell.v)));
      }
    }
    return out;
  };
  const wbRels = partRels(parts, wbPart);
  for (const sh of byName(wbXml, 'sheet')) {
    const rel = wbRels.get(sh.getAttributeNS(R_NS, 'id') || sh.getAttribute('r:id'));
    if (!rel) continue;
    const sheetRels = partRels(parts, rel.target);
    const drawings = [...sheetRels.values()].filter((r) => /\/drawing$/.test(r.type));
    if (!drawings.length) continue;
    const objects = [];
    const missing = { charts: 0, shapes: 0, pictures: 0, other: 0 };
    for (const d of drawings) {
      const dXml = partXml(parts, d.target);
      const dRels = partRels(parts, d.target);
      const root = dXml && dXml.documentElement;
      for (const anchor of root ? [...root.children] : []) {
        if (!/Anchor$/.test(anchor.localName)) continue;
        const box = {
          from: anchor.localName === 'absoluteAnchor' ? { c: 0, cOff: 0, r: 0, rOff: 0 } : anchorPoint(kidEl(anchor, 'from')),
          to: anchor.localName === 'twoCellAnchor' ? anchorPoint(kidEl(anchor, 'to')) : null,
          cx: Number((kidEl(anchor, 'ext') || { getAttribute: () => 0 }).getAttribute('cx')) || 0,
          cy: Number((kidEl(anchor, 'ext') || { getAttribute: () => 0 }).getAttribute('cy')) || 0,
        };
        if (anchor.localName === 'absoluteAnchor') {
          const pos = kidEl(anchor, 'pos');
          box.from.cOff = Number(pos && pos.getAttribute('x')) || 0;
          box.from.rOff = Number(pos && pos.getAttribute('y')) || 0;
          box.abs = true;
        }
        const visit = (node, frac) => {
          const at = (o) => objects.push({ ...box, ...o, frac });
          switch (node.localName) {
            case 'pic': {
              const blip = byName(node, 'blip')[0];
              const media = blip && dRels.get(blip.getAttributeNS(R_NS, 'embed'));
              const ext = media && media.target.split('.').pop().toLowerCase();
              const data = media && parts.get(media.target.toLowerCase());
              if (data && IMAGE_TYPES[ext]) at({ kind: 'image', url: URL.createObjectURL(new Blob([data], { type: IMAGE_TYPES[ext] })) });
              else missing.pictures++;
              break;
            }
            case 'graphicFrame': {
              const gd = byName(node, 'graphicData')[0];
              const uri = gd ? gd.getAttribute('uri') || '' : '';
              if (/\/chart$/.test(uri)) {
                const c = byName(gd, 'chart')[0];
                const cRel = c && dRels.get(c.getAttributeNS(R_NS, 'id'));
                const cXml = cRel && partXml(parts, cRel.target);
                let model = null;
                try {
                  model = cXml ? chart.parseChart(cXml, theme, resolveRef) : null;
                } catch (e) {
                  console.warn('차트를 읽지 못함', e);
                }
                if (model) at({ kind: 'chart', model });
                else missing.charts++;
              } else if (/chartex/.test(uri)) missing.charts++;
              else if (/diagram/.test(uri)) missing.shapes++;
              else missing.other++;
              break;
            }
            case 'sp':
            case 'cxnSp': {
              const s = parseShape(node, theme, chart);
              if (node.localName === 'cxnSp') s.kind = 'line';
              const hasText = s.paras.some((p) => p.runs.some((r) => r.t.trim()));
              // 채우기·선·글자가 모두 없는 도형(투명한 클릭 영역 등)은 그리지 않는다.
              if (s.kind === 'line' ? s.line.color !== 'none' : (hasText || (s.fill && s.fill !== 'none') || (s.line.color && s.line.color !== 'none'))) at(s);
              break;
            }
            case 'grpSp': {
              const gx = kidEl(kidEl(node, 'grpSpPr'), 'xfrm');
              for (const child of node.children) {
                if (!['sp', 'cxnSp', 'pic', 'grpSp', 'graphicFrame'].includes(child.localName)) continue;
                const f = childFrac(child, gx);
                if (!f) { missing.shapes++; continue; }
                visit(child, frac ? { x: frac.x + f.x * frac.w, y: frac.y + f.y * frac.h, w: f.w * frac.w, h: f.h * frac.h } : f);
              }
              break;
            }
            case 'AlternateContent': {
              // 새 기능(슬라이서·잉크 등)은 대신 보여 줄 내용(Fallback)을 함께 저장한다.
              const fb = kidEl(node, 'Fallback') || kidEl(node, 'Choice');
              const inner = fb && fb.firstElementChild;
              if (inner) visit(inner, frac);
              else missing.other++;
              break;
            }
            case 'contentPart':
              missing.other++;
              break;
            default:
          }
        };
        for (const node of anchor.children) {
          if (['from', 'to', 'ext', 'pos', 'clientData'].includes(node.localName)) continue;
          visit(node, null);
        }
      }
    }
    if (!objects.length && !Object.values(missing).some(Boolean)) continue;
    // 엑셀의 열 너비(글자 수)·행 높이(포인트)를 화면 픽셀로 바꿔 둔다(그림 위치 비율 계산용).
    const sheetText = new TextDecoder().decode(parts.get(rel.target.toLowerCase()) || new Uint8Array());
    const cols = [];
    for (const m of sheetText.matchAll(/<(?:\w+:)?col\b[^>]*>/g)) {
      const a = (k) => (new RegExp(`\\b${k}="([^"]+)"`).exec(m[0]) || [])[1];
      const w = Number(a('width'));
      if (!w) continue;
      for (let c = Number(a('min')); c <= Number(a('max')) && c <= 512; c++) cols[c - 1] = Math.round(w * 7 + 5);
    }
    const rows = [];
    for (const m of sheetText.matchAll(/<(?:\w+:)?row\b[^>]*\bht="([\d.]+)"[^>]*>/g)) {
      const r = (/\br="(\d+)"/.exec(m[0]) || [])[1];
      if (r) rows[Number(r) - 1] = Number(m[1]) * 96 / 72;
    }
    result.set(sh.getAttribute('name'), { objects, cols, rows, missing, chartModule: chart });
  }
  return result;
}

// 차트를 누르면 값 표를 보여 준다(색만으로 구분하지 않게, 정확한 값을 볼 수 있게).
function showChartTable(model, table) {
  document.querySelector('.cell-pop')?.remove();
  const pop = el('div', 'cell-pop chart-pop');
  pop.setAttribute('role', 'dialog');
  pop.append(el('div', 'cell-pop-addr', model.title || T('차트 값')));
  const t = el('table', 'chart-table');
  const thead = el('tr');
  for (const h of table.head) thead.append(el('th', null, h));
  t.append(thead);
  for (const row of table.rows.slice(0, 500)) {
    const tr = el('tr');
    row.forEach((v, i) => tr.append(el(i ? 'td' : 'th', null, v)));
    t.append(tr);
  }
  const scroller = el('div', 'chart-table-wrap');
  scroller.append(t);
  pop.append(scroller);
  const close = el('button', 'btn', T('닫기'));
  close.type = 'button';
  pop.append(popFoot(close));
  const done = (e) => {
    if (pop.contains(e.target) && e.target !== close) return;
    e.stopPropagation();
    pop.remove();
    document.removeEventListener('click', done, true);
  };
  $('screen').append(pop);
  setTimeout(() => document.addEventListener('click', done, true), 0);
}

function shapeElement(o, w, h, surface) {
  if (o.kind === 'line') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(Math.max(1, w)));
    svg.setAttribute('height', String(Math.max(1, h)));
    svg.setAttribute('class', 'sheet-shape-line');
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('x1', o.flipH ? w : 0);
    ln.setAttribute('y1', o.flipV ? h : 0);
    ln.setAttribute('x2', o.flipH ? 0 : w);
    ln.setAttribute('y2', o.flipV ? 0 : h);
    ln.setAttribute('stroke', o.line.color && o.line.color !== 'none' ? `#${o.line.color}` : 'var(--xl-border)');
    ln.setAttribute('stroke-width', String(Math.max(1, Math.min(6, o.line.w || 1))));
    svg.append(ln);
    return svg;
  }
  const box = el('div', 'sheet-shape');
  if (o.fill && o.fill !== 'none') box.style.background = `#${o.fill}`;
  if (o.line.color && o.line.color !== 'none') box.style.border = `${Math.max(1, Math.min(6, Math.round(o.line.w || 1)))}px solid #${o.line.color}`;
  if (o.geom === 'ellipse') box.style.borderRadius = '50%';
  else if (o.geom === 'roundRect') box.style.borderRadius = `${Math.round(Math.min(w, h) * 0.16)}px`;
  if (o.rot) box.style.transform = `rotate(${o.rot}deg)`;
  box.style.justifyContent = o.anchor === 'ctr' ? 'center' : o.anchor === 'b' ? 'flex-end' : 'flex-start';
  const bg = o.fill && o.fill !== 'none' ? o.fill : surface;
  for (const p of o.paras) {
    const para = el('div', 'sheet-shape-p');
    para.style.textAlign = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[p.align] || 'left';
    for (const r of p.runs) {
      if (r.t === '\n') { para.append(el('br')); continue; }
      const span = el('span', null, r.t);
      if (r.sz) span.style.fontSize = `${(r.sz * 4 / 3).toFixed(1)}px`;
      if (r.b) span.style.fontWeight = '700';
      if (r.i) span.style.fontStyle = 'italic';
      const c = r.color && r.color !== 'none' ? r.color : o.color;
      // 글자색이 바탕과 거의 같으면(투명 상자의 검은 글자 + 어두운 화면 등) 읽히는 색으로 바꾼다.
      if (c && contrastRatio(c, bg) >= 2.2) span.style.color = `#${c}`;
      else span.style.color = bg === surface ? 'var(--text)' : `#${textOn(bg).slice(1)}`;
      para.append(span);
    }
    if (!p.runs.length) para.append(el('br'));
    box.append(para);
  }
  // 좁은 글상자는 글이 잘릴 수 있어 누르면 전체 글을 보여 준다.
  const full = o.paras.map((p) => p.runs.map((r) => r.t).join('')).join('\n').trim();
  if (full) {
    box.classList.add('has-text');
    box.setAttribute('role', 'button');
    box.addEventListener('click', () => showListPopup(T('글상자'), [{ text: full }]));
  }
  return box;
}

// 표가 화면에 놓인 뒤 칸 위치를 재서 그림·차트·도형을 얹는다.
function placeSheetObjects(wrap, info, range) {
  if (!info || !info.objects || !info.objects.length) return;
  const base = wrap.getBoundingClientRect();
  const heads = new Map([...wrap.querySelectorAll('th.col-head[data-c]')].map((th) => [Number(th.dataset.c), th.getBoundingClientRect()]));
  const trs = new Map([...wrap.querySelectorAll('tr[data-r]')].map((tr) => [Number(tr.dataset.r), tr]));
  if (!heads.size || !trs.size) return;
  const cKeys = [...heads.keys()].sort((a, b) => a - b);
  const rKeys = [...trs.keys()].sort((a, b) => a - b);
  const rowBox = new Map();
  const rect = (r) => {
    if (!rowBox.has(r)) rowBox.set(r, trs.get(r).getBoundingClientRect());
    return rowBox.get(r);
  };
  const excelCol = (c) => info.cols[c] || 64;
  const excelRow = (r) => info.rows[r] || 20;
  // 숨긴 열·행은 폭 0으로, 그린 범위 밖은 기본 크기로 이어 잰다.
  const ourCol = (c) => {
    const b = heads.get(c);
    if (b) return { at: b.left - base.left, size: b.width };
    const next = cKeys.find((k) => k > c);
    if (next != null) return { at: heads.get(next).left - base.left, size: 0 };
    const lastC = cKeys[cKeys.length - 1];
    return { at: heads.get(lastC).right - base.left + (c - lastC - 1) * 64, size: 64 };
  };
  const ourRow = (r) => {
    if (trs.has(r)) { const b = rect(r); return { at: b.top - base.top, size: b.height }; }
    const next = rKeys.find((k) => k > r);
    if (next != null) return { at: rect(next).top - base.top, size: 0 };
    const lastR = rKeys[rKeys.length - 1];
    return { at: rect(lastR).bottom - base.top + (r - lastR - 1) * 22, size: 22 };
  };
  const EMU_PX = 9525;
  const point = (p, c) => {
    const col = ourCol(p.c);
    const row = ourRow(p.r);
    return {
      x: col.at + Math.min(1, p.cOff / EMU_PX / excelCol(p.c)) * col.size,
      y: row.at + Math.min(1, p.rOff / EMU_PX / excelRow(p.r)) * row.size,
      col: c,
    };
  };
  const surface = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '24262B' : 'FFFFFF';
  // 고정 열과 겹치는 차트·도형은 고정 칸(불투명 바탕) 위에 그린다. 나머지는 가로로 넘길 때 고정 칸 밑으로 지나간다.
  const frozenRight = Math.max(0, ...[...wrap.querySelectorAll('.stick-left')].slice(0, 40).map((td) => td.getBoundingClientRect().right - base.left));
  for (const o of info.objects) {
    const { from, to } = o;
    if (from.c < range.s.c || from.r < range.s.r || from.r > rKeys[rKeys.length - 1] + 200) continue;
    let x;
    let y;
    let w;
    let h;
    if (o.abs) {
      const origin = point({ c: range.s.c, cOff: 0, r: range.s.r, rOff: 0 });
      x = origin.x + from.cOff / EMU_PX;
      y = origin.y + from.rOff / EMU_PX;
      w = o.cx / EMU_PX;
      h = o.cy / EMU_PX;
    } else if (o.kind === 'image') {
      // 그림은 엑셀의 픽셀 크기와 비율을 지킨다(로고·직인이 늘어나지 않게).
      const a = point(from);
      x = a.x;
      y = a.y;
      w = o.cx / EMU_PX;
      h = o.cy / EMU_PX;
      if (to) {
        w = -from.cOff / EMU_PX + to.cOff / EMU_PX;
        for (let c = from.c; c < to.c; c++) w += excelCol(c);
        h = -from.rOff / EMU_PX + to.rOff / EMU_PX;
        for (let r = from.r; r < to.r; r++) h += excelRow(r);
      }
    } else {
      // 차트·도형은 놓인 칸 범위에 맞춘다(글상자가 엑셀처럼 같은 칸들 위에 오게).
      const a = point(from);
      x = a.x;
      y = a.y;
      if (to) {
        const b = point(to);
        w = b.x - a.x;
        h = b.y - a.y;
        // 작은 도형(꺾쇠·화살표 머리·표시 기호)은 엑셀의 픽셀 크기를 지킨다. 우리 행이 글자 때문에 엑셀보다 높으면
        // 칸에 맞춰 늘어나 이웃과 겹쳐 보이기 때문이다.
        let wx = -from.cOff / EMU_PX + to.cOff / EMU_PX;
        for (let c = from.c; c < to.c; c++) wx += excelCol(c);
        let hx = -from.rOff / EMU_PX + to.rOff / EMU_PX;
        for (let r = from.r; r < to.r; r++) hx += excelRow(r);
        if (o.kind !== 'chart' && wx > 0 && hx > 0 && wx <= 48 && hx <= 48) {
          w = wx;
          h = hx;
        }
      } else {
        w = o.cx / EMU_PX;
        h = o.cy / EMU_PX;
      }
    }
    if (o.frac) {
      x += o.frac.x * w;
      y += o.frac.y * h;
      w *= o.frac.w;
      h *= o.frac.h;
    }
    if (!(w > 0 || h > 0) || (o.kind !== 'line' && !(w > 0 && h > 0))) continue;
    let node;
    if (o.kind === 'image') {
      node = el('img', 'sheet-image');
      node.src = o.url;
      node.alt = '';
    } else if (o.kind === 'chart') {
      node = el('div', 'sheet-chart');
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', T('{name} — 눌러서 값 보기', { name: o.model.title || T('차트') }));
      node.append(info.chartModule.renderChart(o.model, Math.max(80, w), Math.max(60, h)));
      node.addEventListener('click', () => showChartTable(o.model, info.chartModule.chartTable(o.model)));
    } else {
      node = shapeElement(o, w, h, surface);
    }
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    if (x < frozenRight) node.style.zIndex = '1';
    node.style.width = `${Math.max(1, w)}px`;
    node.style.height = `${Math.max(1, h)}px`;
    wrap.append(node);
  }
}

// ---------------------------------------------------------------- 옛 엑셀(xls) 속 그림
// xls(BIFF8)는 그림을 OfficeArt 형식으로 담는다: 통합 문서 앞부분의 MsoDrawingGroup에 그림 창고(BStore)가 있고,
// 시트마다 MsoDrawing에 도형(그림 번호 pib + 칸 기준 위치 ClientAnchor)이 있다. [MS-XLS]·[MS-ODRAW]를 따른다.
// 위치는 xlsx 그림과 같은 모양(EMU 단위 칸 안 위치)으로 바꿔 placeSheetObjects에 넘긴다.

// 비트맵(DIB)은 파일 머리를 붙여야 <img>로 보인다.
function dibToBmp(dib) {
  const dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = dv.getUint32(0, true);
  const bitCount = dv.getUint16(14, true);
  const clrUsed = headerSize >= 40 ? dv.getUint32(32, true) : 0;
  const palette = (clrUsed || (bitCount <= 8 ? 1 << bitCount : 0)) * 4;
  const out = new Uint8Array(14 + dib.length);
  const o = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  o.setUint32(2, out.length, true);
  o.setUint32(10, 14 + headerSize + palette, true);
  out.set(dib, 14);
  return out;
}

function officeArtRecords(data, start, end, visit) {
  for (let p = start; p + 8 <= end;) {
    const verInst = data[p] | (data[p + 1] << 8);
    const type = data[p + 2] | (data[p + 3] << 8);
    const len = (data[p + 4] | (data[p + 5] << 8) | (data[p + 6] << 16) | (data[p + 7] << 24)) >>> 0;
    const body = p + 8;
    if (body + len > end && (verInst & 0xf) !== 0xf) break;
    visit({ type, instance: verInst >> 4, container: (verInst & 0xf) === 0xf, body, end: Math.min(end, body + len) });
    p = body + len;
  }
}

function readXlsImages(XLSX, bytes) {
  const result = new Map();
  if (!oleHas(bytes, 'Workbook')) return result;
  const cfb = XLSX.CFB.read(bytes, { type: 'array' });
  const entry = XLSX.CFB.find(cfb, 'Workbook');
  if (!entry || !entry.content) return result;
  const wb = entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
  const u16 = (p) => wb[p] | (wb[p + 1] << 8);
  const u32 = (p) => (wb[p] | (wb[p + 1] << 8) | (wb[p + 2] << 16) | (wb[p + 3] << 24)) >>> 0;

  // 1) 기록(BIFF)을 훑어 그림 창고, 시트 이름·시작 위치, 시트별 도형·열 너비·행 높이를 모은다.
  const groupParts = [];
  const sheetsAt = new Map(); // BOF 위치 → 시트 이름
  const sheets = [];
  let cur = null;
  let lastType = 0;
  for (let p = 0; p + 4 <= wb.length;) {
    const type = u16(p);
    const len = u16(p + 2);
    const body = wb.subarray(p + 4, p + 4 + len);
    if (type === 0x0085 && len >= 8) { // BoundSheet8
      const pos = u32(p + 4);
      const cch = wb[p + 10];
      const wide = wb[p + 11] & 1;
      const nameBytes = wb.subarray(p + 12, p + 12 + cch * (wide ? 2 : 1));
      const name = wide ? new TextDecoder('utf-16le').decode(nameBytes) : latin1(nameBytes);
      sheetsAt.set(pos, name);
    } else if (type === 0x0809) { // BOF
      cur = sheetsAt.has(p) ? { name: sheetsAt.get(p), drawing: [], cols: [], rows: [], defCol: 64, defRow: 20 } : null;
      if (cur) sheets.push(cur);
    } else if (type === 0x00eb) {
      groupParts.push(body);
    } else if (type === 0x00ec && cur) {
      cur.drawing.push(body);
    } else if (type === 0x003c) { // CONTINUE: 바로 앞 기록에 이어진다
      if (lastType === 0x00eb) groupParts.push(body);
      else if (lastType === 0x00ec && cur) cur.drawing.push(body);
    } else if (cur && type === 0x007d && len >= 6) { // COLINFO: 너비는 글자 1/256 단위
      const px = Math.round((u16(p + 8) / 256) * 7 + 5);
      for (let c = u16(p + 4); c <= u16(p + 6) && c < 512; c++) cur.cols[c] = px;
    } else if (cur && type === 0x0208 && len >= 8) { // ROW: 높이는 1/20pt
      if (!(u16(p + 12) & 0x8000)) cur.rows[u16(p + 4)] = (u16(p + 10) & 0x7fff) / 20 * 96 / 72;
    } else if (cur && type === 0x0055 && len >= 2) { // DEFCOLWIDTH(글자 수)
      cur.defCol = u16(p + 4) * 7 + 5;
    }
    if (type !== 0x003c) lastType = type;
    p += 4 + len;
  }
  if (!groupParts.length) return result;

  // 2) 그림 창고: BSE 순서대로(그림 번호는 1부터)
  const join = (parts) => {
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  };
  const dgg = join(groupParts);
  const blips = [];
  const findStore = (start, end) => officeArtRecords(dgg, start, end, (r) => {
    if (r.type === 0xf001) {
      officeArtRecords(dgg, r.body, r.end, (bse) => {
        if (bse.type !== 0xf007) { blips.push(null); return; }
        const cbName = dgg[bse.body + 33];
        let blip = null;
        officeArtRecords(dgg, bse.body + 36 + cbName, bse.end, (b) => {
          if (blip) return;
          const two = b.instance & 1;
          if (b.type === 0xf01e || b.type === 0xf01d || b.type === 0xf02a || b.type === 0xf01f) {
            const data = dgg.slice(b.body + (two ? 33 : 17), b.end);
            const bin = b.type === 0xf01f ? dibToBmp(data) : data;
            const mime = b.type === 0xf01e ? 'image/png' : b.type === 0xf01f ? 'image/bmp' : 'image/jpeg';
            blip = URL.createObjectURL(new Blob([bin], { type: mime }));
          }
        });
        blips.push(blip); // EMF·WMF 그림은 보여줄 수 없어 비워 둔다
      });
    } else if (r.container) findStore(r.body, r.end);
  });
  findStore(0, dgg.length);

  // 3) 시트별 도형: 그림 번호와 칸 기준 위치
  const EMU_PX = 9525;
  for (const sh of sheets) {
    if (!sh.drawing.length) continue;
    const dg = join(sh.drawing);
    const images = [];
    let emf = 0;
    const colPx = (c) => sh.cols[c] || sh.defCol;
    const rowPx = (r) => sh.rows[r] || sh.defRow;
    // 도형은 맨 바깥 묶음(SpgrContainer) 안에 들어 있다. 그 안의 묶음 도형은 위치 기준이 달라 건너뛴다.
    const walk = (start, end, depth, inGroup) => officeArtRecords(dg, start, end, (r) => {
      if (r.type === 0xf004) { // SpContainer: 그림 한 개
        let pib = 0;
        let anchor = null;
        officeArtRecords(dg, r.body, r.end, (x) => {
          if (x.type === 0xf00b) { // FOPT: 속성 목록
            for (let k = 0; k < x.instance; k++) {
              const q = x.body + k * 6;
              if (((dg[q] | (dg[q + 1] << 8)) & 0x3fff) === 0x0104) {
                pib = (dg[q + 2] | (dg[q + 3] << 8) | (dg[q + 4] << 16) | (dg[q + 5] << 24)) >>> 0;
              }
            }
          } else if (x.type === 0xf010 && x.end - x.body >= 18) { // ClientAnchor(칸 + 칸 안 비율)
            const v = (k) => dg[x.body + k] | (dg[x.body + k + 1] << 8);
            anchor = { c1: v(2), dx1: v(4), r1: v(6), dy1: v(8), c2: v(10), dx2: v(12), r2: v(14), dy2: v(16) };
          }
        });
        const url = pib && blips[pib - 1];
        if (pib && !url && anchor) emf++; // EMF·WMF 그림
        if (url && anchor) {
          images.push({
            from: { c: anchor.c1, cOff: (anchor.dx1 / 1024) * colPx(anchor.c1) * EMU_PX, r: anchor.r1, rOff: (anchor.dy1 / 256) * rowPx(anchor.r1) * EMU_PX },
            to: { c: anchor.c2, cOff: (anchor.dx2 / 1024) * colPx(anchor.c2) * EMU_PX, r: anchor.r2, rOff: (anchor.dy2 / 256) * rowPx(anchor.r2) * EMU_PX },
            cx: 0, cy: 0, url,
          });
        }
      } else if (r.type === 0xf003) {
        if (!inGroup) walk(r.body, r.end, depth + 1, true);
      } else if (r.container && depth < 4) walk(r.body, r.end, depth + 1, inGroup);
    });
    walk(0, dg.length, 0, false);
    if (images.length || emf) {
      const cols = [];
      const rows = [];
      for (const im of images) {
        for (let c = im.from.c; c <= im.to.c; c++) cols[c] = colPx(c);
        for (let r = im.from.r; r <= im.to.r; r++) rows[r] = rowPx(r);
      }
      result.set(sh.name, { objects: images.map((im) => ({ ...im, kind: 'image' })), cols, rows, missing: { pictures: emf } });
    }
  }
  return result;
}

// 엑셀 시트 이름은 31자까지이고 제어 문자를 쓸 수 없다. 엔진이 이름을 잘못 읽은 파일(일부 xlsb)은 이름이
// 수백만 자짜리 깨진 글자가 되어, 탭에 그대로 쓰면 휴대폰 웹뷰가 글자 배치에만 1분 넘게 멈춘다. 그럴 땐 순서로 부른다.
function sheetLabel(name, i) {
  return typeof name === 'string' && name.length <= 31 && !/[\u0000-\u001f]/.test(name) ? name : T('시트 {n}', { n: i + 1 });
}

// 칸이 하나도 없는 시트의 xlsx 안 내용이 XML이 아니면(압축 방식 표시가 틀리는 등 손상) "빈 시트"라고 하지 않고 손상으로 알린다.
// 손상된 시트 이름 모음을 돌려준다. 모든 시트가 그렇게 비었으면 파일 전체를 손상으로 안내한다.
async function damagedSheets(XLSX, bytes, wb) {
  const out = new Set();
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return out;
  const names = wb.SheetNames || [];
  const empty = names.filter((n) => !Object.keys(wb.Sheets[n] || {}).some((k) => k[0] !== '!'));
  if (!empty.length) return out;
  await loadInflate();
  const z = lazyZip(XLSX, bytes);
  const xml = (k) => {
    const b = z.get(k);
    return b ? new TextDecoder().decode(b) : '';
  };
  // 시트 이름 → 파일 안 위치(xl/workbook.xml의 r:id → xl/_rels/workbook.xml.rels)
  const rels = new Map();
  for (const m of xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0]);
    const target = /\bTarget="([^"]+)"/.exec(m[0]);
    if (id && target) rels.set(id[1], resolvePart('xl/workbook.xml', target[1]).toLowerCase());
  }
  const looksXml = (k) => {
    const b = z.get(k);
    return !!b && latin1(b.subarray(0, 64)).replace(/^\xef\xbb\xbf/, '').trimStart().startsWith('<');
  };
  for (const m of xml('xl/workbook.xml').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0]);
    const rid = /\br:id="([^"]+)"/.exec(m[0]);
    const part = rid && rels.get(rid[1]);
    const n = name && unescapeXmlText(name[1]);
    if (n && empty.includes(n) && part && /\.xml$/.test(part) && z.has(part) && !looksXml(part)) out.add(n);
  }
  if (out.size && empty.length === names.length) {
    throw userError('damaged', T('시트 내용을 읽지 못했어요'), T('파일 일부가 손상됐을 수 있어요. 다른 앱에서 열어 보세요.'), T('손상된 시트: {list}', { list: [...out].join(', ') }));
  }
  return out;
}

function unescapeXmlText(t) {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function damagedSheetView() {
  const wrap = el('div', 'sheet');
  wrap.append(infoNote(T('이 시트는 손상돼 읽지 못했어요. 다른 시트는 볼 수 있어요.')));
  return wrap;
}

async function showSheet(bytes, kind) {
  let wb;
  try {
    wb = await readWorkbook(bytes, kind);
  } catch (e) {
    if (!e || !e.legacyXls) throw e;
    bytes = await decryptLegacyXls(bytes);
    wb = await readWorkbook(bytes, kind);
  }
  const XLSX = window.XLSX;
  const names = wb.SheetNames || [];
  if (!names.length) throw new Error('시트가 없음');
  const damaged = await damagedSheets(XLSX, bytes, wb);
  await fillFormulas(XLSX, wb);
  let drawings = new Map();
  if (kind !== 'csv' && (bytes[0] === 0x50 && bytes[1] === 0x4b || isOle(bytes))) {
    try {
      drawings = isOle(bytes) ? readXlsImages(XLSX, bytes) : await readSheetDrawings(XLSX, bytes, wb);
    } catch (e) {
      console.warn('엑셀 그림·차트를 읽지 못함', e);
    }
  }
  // 원본 조각은 다 읽었으니 놓아준다(큰 파일의 메모리).
  delete wb.files;
  delete wb.cfb;
  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
  // 조건부 서식이 있으면 계산기를 불러 둔다(수식으로 거는 규칙이 있을 때만 수식 계산기도).
  let cond = null;
  const sheetFormats = wb.Format && wb.Format.sheets ? Object.values(wb.Format.sheets) : [];
  if (sheetFormats.some((sf) => sf && sf.cf)) {
    try {
      const mod = await import('./sheet-cond.js');
      let evalAt = null;
      if (sheetFormats.some((sf) => sf && mod.needsFormulas(sf.cf))) {
        try {
          const formulas = await import('./vendor/formula.js');
          evalAt = formulas.conditionEvaluator(XLSX, wb);
        } catch (e) {
          console.warn('조건부 서식 수식 계산기를 불러오지 못함', e);
        }
      }
      cond = { mod, evalAt };
    } catch (e) {
      console.warn('조건부 서식 계산기를 불러오지 못함', e);
    }
  }
  hideNotice();
  setZoomRange(0.25);

  const doc = $('doc');
  doc.className = '';
  document.body.classList.add('sheet-mode');
  followSheetViewport();
  // 다시 100%로 키우면 시트를 바꿀 때 넓혀 둔 폭을 푼다(빈 오른쪽으로 밀리지 않게).
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (window.visualViewport.scale >= 0.99 && doc.style.minWidth) doc.style.minWidth = '';
    });
  }
  const tabs = $('tabs');
  tabs.replaceChildren();
  const rendered = new Map();
  const showHidden = new Set();

  // 엑셀처럼 숨김 시트는 빼고(탭 끝의 "숨긴 시트"로 펼친다), 저장할 때 선택돼 있던 시트를 먼저 보여준다.
  const sheetMeta = (wb.Workbook && wb.Workbook.Sheets) || [];
  let visible = names.map((_, i) => i).filter((i) => !(sheetMeta[i] && sheetMeta[i].Hidden));
  if (!visible.length) visible = names.map((_, i) => i);
  const hiddenSheets = names.map((_, i) => i).filter((i) => !visible.includes(i));
  const view = wb.Workbook && wb.Workbook.Views && wb.Workbook.Views[0];
  const active = view && Number.isInteger(view.activeTab) ? view.activeTab : -1;
  const first = visible.includes(active) ? active : visible[0];
  tabs.hidden = visible.length < 2 && !hiddenSheets.length;

  // 이 시트에서 보여 주지 못하는 것(차트·도형·메모 등)
  const missingFor = (name, ws) => {
    const info = drawings.get(name);
    const missing = { ...((info && info.missing) || {}) };
    const sf = wb.Format && wb.Format.sheets ? wb.Format.sheets[name] : null;
    if (sf && isOle(bytes)) {
      // xls는 차트·도형·단추를 기록(OBJ)으로만 센다(그림은 따로 얹는다).
      if (sf.charts) missing.charts = (missing.charts || 0) + sf.charts;
      if (sf.shapes) missing.shapes = (missing.shapes || 0) + sf.shapes;
      if (sf.controls) missing.controls = (missing.controls || 0) + sf.controls;
      if (sf.notes && !Object.keys(ws || {}).some((k) => k[0] !== '!' && ws[k] && ws[k].c)) missing.notes = sf.notes;
      if (sf.cfRules) missing.cond = sf.cfRules;
    }
    if (sf && sf.cf && !cond) missing.cond = sf.cf.blocks.reduce((n, b) => n + b.rules.length, 0) + (sf.cf.extOnly || 0);
    return missing;
  };

  const select = (idx) => {
    tabs.querySelectorAll('.tab[data-i]').forEach((t) => t.setAttribute('aria-selected', String(Number(t.dataset.i) === idx)));
    const name = names[idx];
    const ws = wb.Sheets[name];
    const info = drawings.get(name) || null;
    const fresh = !rendered.has(idx);
    // 칸은 없고 칸에 붙인 차트·글상자만 있는 시트: 빈 격자를 깔고 엑셀처럼 제자리에 얹는다(차트만 쌓으면 글상자가 빠진다).
    if (fresh && ws && !ws['!ref'] && info && info.objects.some((o) => !o.abs && o.from)) {
      const ends = info.objects.filter((o) => o.from).map((o) => o.to || o.from);
      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(...ends.map((e) => e.r)), c: Math.max(...ends.map((e) => e.c)) } });
    }
    if (fresh) {
      const missing = missingFor(name, ws);
      const drawn = { ...(info || { objects: [], cols: [], rows: [] }), missing };
      const sf = wb.Format && wb.Format.sheets ? wb.Format.sheets[name] || null : null;
      const wrap = ws && ws['!ref']
        ? renderSheet(XLSX, ws, date1904, {
          fmt: wb.Format || null,
          sheet: sf,
          cond: cond && sf && sf.cf ? (cellAt, used) => cond.mod.makeConditional({
            cf: sf.cf,
            dxfs: (wb.Format && wb.Format.dxfs) || [],
            cellAt,
            used,
            date1904,
            evalFormula: cond.evalAt ? (f, br, bc, r, c) => cond.evalAt(name, f, br, bc, r, c) : null,
          }) : null,
          drawings: drawn,
          showHidden: showHidden.has(idx),
          onShowHidden: (on) => {
            if (on) showHidden.add(idx);
            else showHidden.delete(idx);
            rendered.delete(idx);
            select(idx);
          },
        })
        : damaged.has(name) ? damagedSheetView() : renderObjectSheet(drawn);
      rendered.set(idx, wrap);
    }
    const wrap = rendered.get(idx);
    // 보던 배율을 지킨다. 줄여 보다가 빈 시트·좁은 시트로 바꾸면 웹뷰는 내용보다 작게 줄일 수 없어 배율을 100%로
    // 되돌리고, 넓은 시트로 돌아와도 그대로다. 줄여 보는 동안에는 문서 폭을 지금 보이는 폭 이상으로 둔다.
    const vv = window.visualViewport;
    if (vv && vv.scale < 0.99) doc.style.minWidth = `${Math.ceil(vv.width) + 1}px`;
    doc.replaceChildren(wrap);
    showSheetNotices(wrap);
    window.scrollTo(0, 0);
    if (window.followSheetViewport) window.followSheetViewport();
    if (!fresh) return;
    requestAnimationFrame(() => {
      // 열 머리·고정 행을 위에 붙이고, 그림·차트·도형이 놓인 행까지 그린 뒤 칸 위치를 재서 얹는다.
      if (wrap.stickHead) wrap.stickHead();
      if (info && info.objects.length && ws && ws['!ref'] && wrap.renderUntil) {
        const range = window.XLSX.utils.decode_range(ws['!ref']);
        if (range.s.r <= 200) range.s.r = 0;
        if (range.s.c <= 50) range.s.c = 0;
        wrap.renderUntil(Math.max(...info.objects.map((o) => (o.to ? o.to.r : o.from.r))));
        placeSheetObjects(wrap, info, range);
      }
    });
  };

  const addTab = (i, hidden) => {
    const t = el('button', hidden ? 'tab tab-hidden' : 'tab', hidden ? T('{name} (숨김)', { name: sheetLabel(names[i], i) }) : sheetLabel(names[i], i));
    t.type = 'button';
    t.dataset.i = String(i);
    t.setAttribute('role', 'tab');
    t.addEventListener('click', () => select(i));
    tabs.append(t);
    return t;
  };
  visible.forEach((i) => addTab(i, false));
  if (hiddenSheets.length) {
    const more = el('button', 'tab tab-more', T('숨긴 시트 {n}개', { n: hiddenSheets.length }));
    more.type = 'button';
    more.addEventListener('click', () => {
      more.remove();
      const added = hiddenSheets.map((i) => addTab(i, true));
      added[0].scrollIntoView({ inline: 'center', block: 'nearest' });
    });
    tabs.append(more);
  }
  select(first);
  const activeTab = tabs.querySelector('[aria-selected="true"]');
  if (activeTab) activeTab.scrollIntoView({ inline: 'center', block: 'nearest' });
  report({ state: 'rendered', kind: 'sheet', sheets: visible.length, hiddenSheets: hiddenSheets.length });
}

// 확대·축소를 허용한 화면에서는 넓은 표를 손가락으로 끌어도 문서가 '스크롤'되지 않고 확대된 화면이 이동한다
// (layout viewport가 표 크기로 커진다). 그래서 position: sticky 대신 이동한 거리를 재서 열 머리·행 번호·고정 칸을 옮긴다.
let followInstalled = false;
function followSheetViewport() {
  if (followInstalled) return;
  followInstalled = true;
  // 옆으로 따라오는 칸들은 규칙 하나로 옮긴다. 표 전체에 CSS 변수를 바꾸면 칸 수만 개의 스타일을 매번 다시 계산해
  // 내릴수록 멈춤이 길어졌다(10만 칸 시트, CPU 4배 느리게: 이어 그릴 때마다 0.26→0.48초).
  const style = document.createElement('style');
  style.textContent = '.sheet .row-head, .sheet .corner, .sheet .stick-left, .sheet .sheet-end, .sheet .sheet-more { transform: translateX(0px); }';
  document.head.append(style);
  const rule = style.sheet.cssRules[0];
  let queued = false;
  let lastX = 0;
  let lastY = 0;
  let lastPage = null;
  let lastHead = null;
  let lastTop = 0;
  let lastBar = '';
  let lastZ = 1;
  let layoutZ = 1;
  let settleTimer = 0;
  let peek = false;
  // 바·탭을 키우거나 줄인 만큼 아래 내용을 밀거나 당긴다. 손가락으로 배율을 바꾸는 동안에는 그대로 두고
  // 멈춘 뒤에 맞춘다(배율을 바꾸는 중에 내용이 손가락 아래에서 흔들리지 않게).
  const settle = (z) => {
    layoutZ = z;
    const bar = $('bar');
    const tabs = $('tabs');
    bar.style.marginBottom = z !== 1 ? `${(z - 1) * bar.offsetHeight}px` : '';
    tabs.style.marginBottom = z !== 1 && !tabs.hidden ? `${(z - 1) * tabs.offsetHeight}px` : '';
    schedule();
  };
  const update = () => {
    queued = false;
    const vv = window.visualViewport;
    const pageLeft = Math.max(0, vv ? vv.pageLeft : window.scrollX);
    const pageTop = vv ? vv.pageTop : window.scrollY;
    const sheetMode = document.body.classList.contains('sheet-mode');
    // 위쪽 바·시트 탭은 배율과 상관없이 화면 크기 그대로: 줄여 보면 화면 전체 폭에, 키워 보면 글자가 커지지 않고 ⋮도 화면 안에.
    const scale = vv ? vv.scale : 1;
    const z = sheetMode && Math.abs(scale - 1) > 0.001 ? 1 / scale : 1;
    const zs = z !== 1 ? ` scale(${z})` : '';
    if (z !== layoutZ) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => settle(z), 180);
    }
    if (pageLeft !== lastPage || z !== lastZ) {
      lastPage = pageLeft;
      lastZ = z;
      $('tabs').style.transform = sheetMode ? `translateX(${pageLeft}px)${zs}` : '';
    }
    // 위쪽 바: 내려 읽을 때는 표와 함께 위로 지나가고, 조금이라도 올리면 화면 맨 위에 다시 나온다(열 머리는 그 아래에 붙는다).
    if (pageTop < lastTop - 6) peek = true;
    else if (pageTop > lastTop + 6) peek = false;
    lastTop = pageTop;
    const bar = $('bar');
    const lift = sheetMode && peek && pageTop > bar.offsetTop ? Math.round(pageTop - bar.offsetTop) : 0;
    const barTransform = sheetMode ? `translate(${pageLeft}px, ${lift}px)${zs}` : '';
    if (barTransform !== lastBar) {
      lastBar = barTransform;
      bar.style.transform = barTransform;
      bar.classList.toggle('bar-peek', lift > 0);
    }
    const cover = lift ? bar.offsetHeight * z : 0;
    const wrap = document.querySelector('#doc > .sheet');
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const left = r.left + window.scrollX + 12; // 표 왼쪽 여백(.sheet padding)
    const top = r.top + window.scrollY;
    const fx = Math.round(Math.max(0, Math.min(pageLeft - left, r.width - 140)));
    if (fx !== lastX) {
      lastX = fx;
      rule.style.transform = `translateX(${fx}px)`;
    }
    const head = wrap.querySelector('.sheet-head');
    // 머리 줄 위에 안내 띠가 있으면 그만큼 아래에서 붙기 시작한다(offsetTop은 옮긴 거리와 무관한 원래 자리).
    const headTop = head ? top + head.offsetTop : 0;
    const fy = head ? Math.round(Math.max(0, Math.min(pageTop + cover - headTop, r.height - head.offsetTop - head.offsetHeight - 60))) : 0;
    if (head && (fy !== lastY || head !== lastHead)) {
      lastY = fy;
      lastHead = head;
      head.style.transform = `translateY(${fy}px)`;
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  window.addEventListener('scroll', schedule, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('scroll', schedule);
    window.visualViewport.addEventListener('resize', schedule);
  }
  // 가로·세로로 돌려도 보던 배율 그대로. 웹뷰는 돌릴 때 "가장 작게 줄일 수 있는 배율 대비 지금 배율"을 지켜서,
  // 화면보다 조금 넓은 시트는 세로 100% → 가로 222%처럼 커져 열이 더 보이는 대신 같은 열이 크게 보였다.
  // 화면 폭이 바뀐 직후(0.6초 안) 배율이 달라졌으면 앱에 돌리기 전 배율로 되돌려 달라고 한 번 부탁한다.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let keep = vv.scale;
    let lastWidth = document.documentElement.clientWidth;
    let rotateUntil = 0;
    let asked = false;
    vv.addEventListener('resize', () => {
      const w = document.documentElement.clientWidth;
      const now = performance.now();
      if (w !== lastWidth) {
        lastWidth = w;
        rotateUntil = now + 600;
        asked = false;
      }
      if (now < rotateUntil) {
        if (!asked && Math.abs(vv.scale / keep - 1) > 0.02 && document.body.classList.contains('sheet-mode') && bridge && bridge.zoomBy) {
          asked = true;
          bridge.zoomBy(keep / vv.scale);
        }
        return;
      }
      keep = vv.scale;
    });
  }
  // 시트를 바꾸면 그 시트의 안내 줄이 생기거나 없어져 바 높이가 바뀐다. 키우거나 줄여 보는 중이면 밀고 당긴 거리를 다시 맞춘다
  // (안 맞추면 200%에서 시트를 바꿀 때 탭이 바를 덮어 ⋮가 눌리지 않았다).
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (layoutZ !== 1) settle(layoutZ); }).observe($('bar'));
    new ResizeObserver(() => { if (layoutZ !== 1) settle(layoutZ); }).observe($('tabs'));
  }
  window.followSheetViewport = schedule;
  schedule();
}

// 칸 없이 차트만 있는 시트(차트 시트)
function renderObjectSheet(info) {
  const wrap = el('div', 'sheet sheet-objects');
  const charts = ((info && info.objects) || []).filter((o) => o.kind === 'chart');
  if (!charts.length) wrap.append(el('p', 'sheet-empty', T('빈 시트예요.')));
  const maxW = Math.max(240, Math.min(screenSize().w - 24, 900));
  for (const o of charts) {
    let w = o.cx / 9525 || 640;
    let h = o.cy / 9525 || 400;
    if (w > maxW) {
      h = (h * maxW) / w;
      w = maxW;
    }
    const node = el('div', 'sheet-chart static');
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', T('{name} — 눌러서 값 보기', { name: o.model.title || T('차트') }));
    node.append(info.chartModule.renderChart(o.model, w, h));
    node.addEventListener('click', () => showChartTable(o.model, info.chartModule.chartTable(o.model)));
    wrap.append(node);
  }
  const missing = info && info.missing ? missingText(info.missing) : '';
  if (missing) {
    const note = infoNote(missing);
    note.classList.add('sheet-note');
    note.dataset.priority = '2';
    wrap.notices = [note];
  }
  return wrap;
}

// ---------------------------------------------------------------- 파워포인트(PPT·PPTX)

function loadStyle(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

// react-pptx가 슬라이드를 화면 폭에 맞춰 세로로 이어서 보여준다. 구형 PPT도 같은 엔진이 직접 읽는다.
// 글머리 기호 글자(a:buChar char="&#x2022;")의 XML 문자 참조를 엔진(react-pptx)이 풀지 않아 "&#x2022;"가 글자 그대로
// 보였다(본문 글자는 제대로 푼다. 2026-10 사용자 보고: 상권 분석 PPT). 그린 글머리 기호(data-rpv-bullet)만 풀어 준다.
// 창 크기가 바뀌면 엔진이 다시 그리므로 새로 생기는 것도 지켜본다.
const XML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlRefs(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, ref) => {
    if (ref[0] !== '#') return XML_NAMED[ref];
    const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

function watchSlideBullets(host) {
  const fix = () => {
    for (const b of host.querySelectorAll('[data-rpv-bullet]')) {
      const t = b.textContent;
      if (!t.includes('&')) continue;
      const d = decodeXmlRefs(t);
      if (d !== t) b.textContent = d;
    }
  };
  new MutationObserver(fix).observe(host, { childList: true, subtree: true });
}

async function showSlides(bytes) {
  loadStyle('vendor/pptx-view.css');
  const mod = await import('./vendor/pptx-view.js');
  document.body.classList.add('slides-mode');
  const doc = $('doc');
  doc.className = 'slides';
  const host = el('div', 'slides-host');
  doc.replaceChildren(host);
  watchSlideBullets(host);
  const legacy = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  let warnings = 0;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('시간 초과')), 60000);
      mod.mountPresentation(host, bytes, {
        onLoad: (presentation) => {
          clearTimeout(timer);
          const slides = presentation && presentation.document ? presentation.document.slides.length : 0;
          if (legacy) {
            addNotice(infoNote(T('예전 PPT 형식이라 정렬·글머리 기호·글자 색 같은 서식이 원본과 다를 수 있어요.')));
          }
          hideNotice();
          report({ state: 'rendered', kind: 'slides', pages: slides });
          addDocExtras('slides', bytes, doc);
          resolve();
        },
        onError: (e) => {
          clearTimeout(timer);
          const err = e instanceof Error ? e : new Error(String(e && (e.message || e)));
          reject(isPasswordProtectedError(err) ? passwordError() : err);
        },
        onWarning: (w) => {
          if (warnings++ < 20) console.warn('slides:', w && w.code, w && w.message);
        },
      });
    });
  } catch (e) {
    document.body.classList.remove('slides-mode');
    doc.className = '';
    // PowerPoint 95는 엔진이 못 읽는다. 손상 안내 대신 형식 안내를 한다(97 이후 ppt에는 Header 항목이 없다).
    if (legacy && !(e && e.userFacing) && oleHas(bytes, 'Header') && oleHas(bytes, 'PowerPoint Document')) {
      throw userError('unsupported', T('PowerPoint 95 형식이라 다른 앱에서 열어 주세요'), T('너무 오래된 형식이라 be docs에서는 열 수 없어요.'), String(e && (e.message || e)));
    }
    throw e;
  }
}

// ---------------------------------------------------------------- 워드(DOCX·DOC)

// OLE 컨테이너 안에 이 이름의 항목이 있는지 본다. 디렉터리 항목(128바이트 단위)의 이름 칸(UTF-16LE, 대소문자 무시)과
// 이름 길이 칸이 함께 맞아야 한다(본문 글자 속 같은 단어와 헷갈리지 않게).
function oleHas(bytes, name) {
  const lower = (c) => (c >= 0x41 && c <= 0x5a ? c | 0x20 : c);
  const want = (name.length + 1) * 2;
  outer: for (let i = 0; i + 128 <= bytes.length; i += 128) {
    if (bytes[i + 64] !== want || bytes[i + 65] !== 0) continue;
    for (let j = 0; j < name.length; j++) {
      if (bytes[i + j * 2 + 1] !== 0 || lower(bytes[i + j * 2]) !== lower(name.charCodeAt(j))) continue outer;
    }
    return true;
  }
  return false;
}

function isOle(bytes) {
  return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

// 97~2003 문서(OLE) 앞에 몇 바이트가 붙어 온 경우(전송 중 덧붙음): 앞을 잘라 낸다. OLE 안의 위치는 파일 처음 기준이라 그대로 맞는다.
function skipJunkBeforeOle(bytes) {
  if (isOle(bytes)) return bytes;
  // 다른 형식으로 시작하는 파일(ZIP·PDF·RTF·한글 3.0·XML/HTML)은 그 안에 든 OLE 조각을 집지 않도록 건드리지 않는다.
  const head = latin1(bytes.subarray(0, 32));
  if (/^(PK|%PDF|\{\\rtf|HWP Document|\s*<)/.test(head)) return bytes;
  const n = Math.min(bytes.length - 512, 512);
  for (let i = 1; i < n; i++) {
    if (bytes[i] === 0xd0 && bytes[i + 1] === 0xcf && isOle(bytes.subarray(i, i + 8))) {
      console.warn(`OLE 앞의 ${i}바이트를 건너뜀`);
      return bytes.subarray(i);
    }
  }
  return bytes;
}

// 97~2003 문서(OLE)는 확장자보다 안의 본문 항목으로 형식을 정한다(엑셀 파일을 .doc로, 한글 파일을 .xlsx로 저장해 보낸 경우).
// 다른 문서를 품은 문서(엑셀 표를 넣은 워드 등)도 있어, 확장자가 말하는 본문 항목이 아예 없을 때만 바꾼다.
const OLE_MAIN = { hwp: ['FileHeader'], sheet: ['Workbook', 'Book'], slides: ['PowerPoint Document'], word: ['WordDocument'] };

function oleKind(bytes, kind) {
  // 확장자로 형식을 모르는 OLE('ole')는 main()이 한글 → 엑셀 → PPT → 워드 순으로 차례로 열어 본다.
  if (!OLE_MAIN[kind] || oleHas(bytes, 'EncryptedPackage')) return kind;
  const has = (k) => OLE_MAIN[k].some((n) => oleHas(bytes, n));
  if (has(kind)) return kind;
  // 엑셀 표는 다른 문서에 자주 끼워 넣어져 있어(항목 이름이 문서 안 어디에나 보인다) 마지막에 본다.
  for (const k of ['hwp', 'slides', 'word', 'sheet']) if (k !== kind && has(k)) return k;
  return kind;
}

// 파일 끝이 잘렸는지(내려받기가 덜 끝남): 97~2003 문서(OLE)는 할당표가 쓴다고 한 마지막 칸이 파일 밖에 있고,
// ZIP 문서(xlsx·docx·hwpx 등)는 끝에 있어야 할 중앙 목록 끝 표시가 없다. 잘렸으면 원인 글을, 아니면 null을 돌려준다.
// (잘린 OLE 파일은 본문 항목 이름도 잘려 나가 "보안 프로그램으로 잠긴 문서"로 잘못 안내하던 것)
function cutShort(bytes) {
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const u32 = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  if (isOle(bytes) && bytes.length >= 512) {
    const shift = u16(0x1e);
    if (shift !== 9 && shift !== 12) return null;
    const ss = 1 << shift;
    const perSector = ss / 4;
    let lastUsed = -1;
    const fatCount = Math.min(u32(0x2c), 109);
    for (let i = 0; i < fatCount; i++) {
      const fat = u32(0x4c + i * 4);
      if (fat >= 0xfffffffa) continue;
      lastUsed = Math.max(lastUsed, fat);
      const at = (fat + 1) * ss;
      if (at + ss > bytes.length) continue; // 할당표 칸 자체가 잘렸다(아래 비교에서 걸린다)
      // 다음 칸을 가리키는 항목만 센다(빈 칸을 "사용 안 함" 대신 "사슬 끝"으로 채우는 프로그램이 있다).
      for (let k = 0; k < perSector; k++) {
        const next = u32(at + k * 4);
        if (next < 0xfffffffa) lastUsed = Math.max(lastUsed, i * perSector + k, next);
      }
    }
    for (const at of [0x30, 0x3c, 0x44]) {
      const id = u32(at);
      if (id < 0xfffffffa) lastUsed = Math.max(lastUsed, id);
    }
    const need = (lastUsed + 1) * ss; // 마지막으로 쓰는 칸이 시작하는 곳
    return lastUsed >= 0 && need >= bytes.length ? T('OLE 파일이 {a}바이트에서 끝남(쓰는 칸은 {b}바이트 넘어까지)', { a: bytes.length, b: need }) : null;
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (u32(p) === 0x06054b50) return null;
    return T('ZIP 끝의 중앙 목록 표시가 없음');
  }
  return null;
}

// 회사 문서보안(DRM)으로 잠긴 파일은 문서 확장자를 단 채 알려진 문서 구조 없이 무작위에 가까운 바이트로 채워져 있다.
// 업체별 파일 서명은 공개돼 있지 않아 업체를 가리지 않고, 그 특징이 뚜렷할 때만 "잠긴 문서 같아요"로 안내한다.
// 엑셀 엔진은 이런 파일도 글자 표로 읽어 깨진 글자를 수백 줄 보여 주므로 엔진에 넘기기 전에 거른다.
const EXT_DOC_ANY = new Set([...EXT_HWP, ...EXT_SHEET, ...EXT_SLIDES, ...EXT_WORD, ...EXT_TEXT, 'pdf', 'rtf', 'odt', 'odp']);
// 압축·그림 파일은 내용이 무작위처럼 보여도 보안 문서가 아니다(이름만 바뀐 파일).
const NOT_LOCKED_SIGS = [[0x50, 0x4b], [0x1f, 0x8b], [0x37, 0x7a, 0xbc, 0xaf], [0x52, 0x61, 0x72, 0x21], [0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47], [0x47, 0x49, 0x46, 0x38]];

function byteEntropy(bytes) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let h = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function lockedByContent(bytes, name) {
  if (!EXT_DOC_ANY.has(extOf(name)) || bytes.length < 8192 || isOle(bytes)) return null;
  if (NOT_LOCKED_SIGS.some((sig) => startsWith(bytes, sig))) return null;
  const head = latin1(bytes.subarray(0, 8192));
  // 한글 3.0은 머리글 뒤 본문이 압축돼 있고, PDF도 압축된 내용이 대부분이다.
  if (head.startsWith('HWP Document File') || head.includes('%PDF-')) return null;
  const start = bytes.length >> 2;
  const h = byteEntropy(bytes.subarray(start, start + 262144));
  return h >= 7.9 ? T('알려진 문서 구조 없음 · 내용이 무작위에 가까움({h} bit/byte)', { h: h.toFixed(2) }) : null;
}

// OLE 컨테이너인데 한글·워드·엑셀·파워포인트 본문 항목이 하나도 없으면 다른 프로그램이 감싼 파일이다.
// 정상 파일에는 필요 없는 검사라 엔진이 모두 실패한 뒤에만 본다.
const OLE_DOC_STREAMS = ['FileHeader', 'Workbook', 'WordDocument', 'PowerPoint Document', 'Book', 'EncryptedPackage', 'PP40'];

function lockedOle(bytes, name) {
  if (!EXT_DOC_ANY.has(extOf(name)) || !isOle(bytes)) return null;
  return OLE_DOC_STREAMS.some((s) => oleHas(bytes, s)) ? null : T('OLE 컨테이너 안에 문서 본문 항목이 없음');
}

function showLocked(tech) {
  failWith('protected', T('보안 프로그램으로 잠긴 문서 같아요'),
    T('회사 보안(DRM)이 걸린 파일은 그 회사의 보안 앱이 있어야 열려요. 보낸 사람에게 보안을 해제한 파일이나 PDF로 다시 받아 보세요.'), tech);
}

function isOldWordError(e) {
  return /wIdent 0xA5DC|wIdent 0xA699|Unsupported legacy Word version/i.test(String(e && (e.message || e)));
}

function wordError(e) {
  const m = String(e && (e.message || e));
  if (/Encrypted \.doc|XOR obfuscation/i.test(m)) return passwordError();
  if (e && e.code === 'too-deep') {
    return userError('complex', T('표 안에 표가 너무 깊게 들어 있는 문서예요'), T('다른 앱에서 열어 보세요.'), T('표 중첩이 40단계를 넘음'));
  }
  return e instanceof Error ? e : new Error(m);
}

// 화면에 한 번 그려진 뒤에 이어 간다(무거운 계산 전에 안내가 먼저 보이게).
function nextPaint() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
}

// 긴 워드 문서는 쪽 나누기가 화면 스레드를 오래 멈춘다(중급 휴대폰 근사: 31쪽 약 5초, 124쪽 약 10초).
// 분량이 이 쪽수 이상이면 글·표·그림을 위에서 아래로 이어 보여 주는 읽기 보기로 먼저 연다.
const WORD_READING_PAGES = 30;
// 읽기 보기에서 쪽 모양으로 바꿀 때 기다리는 한도(느린 휴대폰의 183쪽 문서도 넉넉히 들어간다)
const WORD_FULL_TIMEOUT = 300000;

// 문서에 적힌 쪽수(docProps)는 없거나 틀린 경우가 많아(183쪽 문서에 1쪽) 글자·문단·표 줄 수로도 어림한다.
// 한 쪽에 한글 약 1,300자, 표·목록이 많은 문서는 문단 80개·표 줄 40개로 잡았다. 워드 문서 297개에 맞춰 보면
// 31쪽 이상 문서는 모두 걸리고, 그 밖에는 멈춤이 가장 긴 20쪽 그림 문서만 걸린다(21쪽 이하 나머지는 그대로 쪽 모양).
function wordSize({ storedPages, paragraphs, chars, tableRows }) {
  const stored = storedPages || 0;
  const load = Math.max(stored, chars / 1300, paragraphs / 80, tableRows / 40);
  // 화면에 보여 줄 쪽수는 문서에 적힌 값이 글 분량과 크게 어긋나지 않을 때만 쓴다(어림값은 서양 글에서 크게 틀려 보여 주지 않는다).
  const plausible = stored && stored >= Math.max(chars / 2000, paragraphs / 90) / 2;
  return { reading: load >= WORD_READING_PAGES, pages: plausible ? stored : 0, load: Math.round(load) };
}

// 읽기 보기: 엔진이 읽은 문서 모델을 간단 보기 블록으로 바꿔 그린다. "쪽 모양으로 보기"를 누르면 그때 쪽을 나눈다.
// 문단이 수천 개면 한꺼번에 그려도 1초 넘게 멈추므로 첫 화면 분량만 바로 그리고 나머지는 조금씩 이어 붙인다.
// 분량은 문단 1, 표 칸 1로 센다(CPU 4배 감속에서 한 번에 0.2초 안팎).
const READING_FIRST_WEIGHT = 150;
const READING_CHUNK_WEIGHT = 300;
const READING_TABLE_ROWS = 100;

// 줄이 아주 많은 표(183쪽 문서의 948줄 표)는 한 표로 그리면 칸 너비 계산에만 수 초가 걸린다.
// 세로로 합친 칸이 걸치지 않는 줄에서 끊어 여러 표로 잇고, 뒷조각은 첫 조각의 칸 너비를 그대로 쓴다(alignSegment).
function splitLongTables(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.t !== 'table' || b.rows.length <= READING_TABLE_ROWS * 1.5) {
      out.push(b);
      continue;
    }
    const group = {};
    let start = 0;
    let reach = 0; // 위 줄들에서 세로로 합친 칸이 닿는 줄(이 줄 전에는 끊지 않는다)
    for (let r = 0; r < b.rows.length; r++) {
      if (r - start >= READING_TABLE_ROWS && reach <= r) {
        out.push({ ...b, rows: b.rows.slice(start, r), cont: start > 0, group });
        start = r;
      }
      for (const c of b.rows[r].cells) reach = Math.max(reach, r + (c.rowspan || 1));
    }
    out.push({ ...b, rows: b.rows.slice(start), cont: start > 0, group });
  }
  return out;
}

// 첫 조각의 칸 경계(왼쪽·오른쪽 x)를 모든 칸에서 모아 열마다 너비를 구한다. 합친 칸이 많아 경계가 하나라도
// 비면 빈 배열(조각마다 자동 너비로 둔다).
function tableColumns(table) {
  const edges = [];
  const taken = []; // 줄마다 위에서 세로로 합친 칸이 차지한 열
  const rows = [...table.rows];
  rows.forEach((row, r) => {
    let col = 0;
    for (const cell of row.cells) {
      while (taken[r] && taken[r][col]) col++;
      const rect = cell.getBoundingClientRect();
      if (edges[col] === undefined) edges[col] = rect.left;
      if (edges[col + cell.colSpan] === undefined) edges[col + cell.colSpan] = rect.right;
      for (let k = 1; k < cell.rowSpan && r + k < rows.length; k++) {
        taken[r + k] = taken[r + k] || [];
        for (let c = col; c < col + cell.colSpan; c++) taken[r + k][c] = true;
      }
      col += cell.colSpan;
    }
  });
  const cols = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    if (edges[i] === undefined || edges[i + 1] === undefined || edges[i + 1] <= edges[i]) return [];
    cols.push(edges[i + 1] - edges[i]);
  }
  return cols;
}

// 나눈 표의 뒷조각을 첫 조각과 같은 칸 너비로 고정한다(고정 배치라 칸 너비 계산도 빨라진다).
function alignSegment(table, group) {
  if (!group.cols && group.first) group.cols = tableColumns(group.first);
  if (!group.cols || !group.cols.length) return;
  const cols = el('colgroup');
  for (const w of group.cols) {
    const col = el('col');
    col.style.width = `${w}px`;
    cols.append(col);
  }
  table.prepend(cols);
  table.style.tableLayout = 'fixed';
  table.style.width = `${group.cols.reduce((a, w) => a + w, 0)}px`;
}

function blockWeight(b) {
  if (b.t !== 'table') return 1;
  let n = 0;
  for (const row of b.rows) n += row.cells.length;
  return n;
}

async function showWordReading(view, pages, host, doc) {
  const simple = await import('./simple-view.js');
  const page = el('article', 'simple-doc word-reading');
  const { header, footer, footnotes } = view.extras;
  if (header) page.append(el('p', 'simple-hf', header));
  const blocks = splitLongTables(view.blocks);
  let next = 0;
  let switched = false;
  const draw = (budget) => {
    for (let w = 0, start = next; next < blocks.length && (next === start || w + blockWeight(blocks[next]) <= budget); next++) {
      const b = blocks[next];
      w += blockWeight(b);
      simple.renderBlocks([b], page);
      if (!b.group) continue;
      const table = page.lastElementChild.querySelector('table');
      if (b.cont) alignSegment(table, b.group);
      else b.group.first = table;
    }
  };
  draw(READING_FIRST_WEIGHT);
  host.replaceChildren(page);
  host.scrollTop = 0;
  let text = pages ? T('긴 문서(약 {n}쪽)라 읽기 모드로 열었어요. 쪽 나눔과 배치는 원본과 달라요.', { n: pages }) : T('긴 문서라 읽기 모드로 열었어요. 쪽 나눔과 배치는 원본과 달라요.');
  if (view.omittedImages) text += T(' 빠진 그림 {n}개는 원본 모양에서 볼 수 있어요.', { n: view.omittedImages });
  // 원본 모양으로 바꾸는 길은 두 곳: 문서 안내의 버튼과 메뉴(⋮)의 "원본 모양으로 보기"
  const toFull = () => {
    if (switched) return;
    switched = true;
    note.remove();
    menuItem.hidden = true;
    menuItem.onclick = null;
    showWordFull(view, pages, host, doc).catch((e) => {
      const err = wordError(e);
      failWith(err.reason || 'read', T('원본 모양으로 열지 못했어요'), T('파일을 다시 열면 읽기 모드로 볼 수 있어요.'), String(err.tech || err.message));
    });
  };
  const note = actionNote(text, T('원본 모양으로 보기'), toFull);
  note.classList.add('word-reading-note');
  addNotice(note, { priority: 3 });
  const menuItem = $('menu-original');
  menuItem.hidden = false;
  menuItem.onclick = toFull;
  // 첫 화면이 그려진 뒤 나머지를 이어 붙인다(사이사이 화면이 움직이고 손가락에 반응한다).
  await nextPaint();
  while (next < blocks.length && !switched) {
    draw(READING_CHUNK_WEIGHT);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (switched) return;
  if (footnotes.length) {
    const box = el('section', 'simple-footnotes');
    box.append(el('p', 'simple-hf', T('각주')));
    footnotes.forEach((t, i) => box.append(el('p', 'simple-p', `[${i + 1}] ${t}`)));
    page.append(box);
  }
  if (footer) page.append(el('p', 'simple-hf', footer));
  report({ state: 'rendered', kind: 'word', view: 'reading', reader: view.reader || 'engine' });
}

// 읽기 보기에서 쪽 모양으로 바꾼다(버튼을 눌렀을 때, 또는 읽기 보기를 만들지 못했을 때). 쪽을 나누는 동안 화면이 멈춘다.
async function showWordFull(view, pages, host, doc) {
  stopSlowWatch();
  showLoading(T('쪽을 나누고 있어요'), (pages ? T('약 {n}쪽 분량이에요. ', { n: pages }) : '') + T('잠시만 기다려 주세요.'));
  await nextPaint();
  let timer;
  try {
    const full = await Promise.race([
      view.showFull(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('시간 초과')), view.timeout || WORD_FULL_TIMEOUT); }),
    ]);
    hideNotice();
    report({ state: 'rendered', kind: 'word', view: 'full', pages: full });
    watchWordClipping(host, doc);
  } finally {
    clearTimeout(timer);
  }
}

// 워드 엔진의 문서 해석(작업 스레드)은 XML 크기에 거의 비례한다(PC에서 1MB당 약 2.6초: 본문 XML 12.5MB인 183쪽 docx가 33초).
// 느린 휴대폰에서 정상 문서가 "시간 초과"로 끝나지 않게 기다리는 한도를 XML 크기(doc는 파일 크기)에 맞춘다.
// 그동안 여는 중 막대와 "다른 앱으로 열기"는 계속 보인다.
function wordParseBudget(bytes) {
  const xml = bytes[0] === 0x50 && bytes[1] === 0x4b ? zipXmlSizes(bytes).total : bytes.length * 2;
  return Math.min(600000, 90000 + Math.round((xml / 1048576) * 15000));
}

// ZIP 중앙 목록에서 XML 항목들의 압축 전 크기 합(total)과 본문(word/document.xml) 크기를 센다(풀지 않는다).
function zipXmlSizes(bytes) {
  const out = { total: 0, document: 0 };
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const u32 = (p) => (u16(p) | (u16(p + 2) << 16)) >>> 0;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) !== 0x06054b50) continue;
    let q = u32(p + 16);
    for (let i = 0; i < 20000 && q + 46 <= bytes.length && u32(q) === 0x02014b50; i++) {
      const len = u16(q + 28);
      const name = String.fromCharCode(...bytes.subarray(q + 46, q + 46 + Math.min(len, 200)));
      if (/\.xml$/i.test(name)) out.total += u32(q + 24);
      if (/^\/?word\/document\.xml$/i.test(name)) out.document = u32(q + 24);
      q += 46 + len + u16(q + 30) + u16(q + 32);
    }
    break;
  }
  return out;
}

// 긴 docx 빠른 읽기: 엔진(wasm)은 문서 구조를 만드는 데 XML 1MB당 약 2.6초(PC)가 걸린다. 본문이 이 크기 이상이면
// 작업 스레드에서 문서 XML을 직접 읽어(docx-read.js, 183쪽 문서 PC 0.4초) 길면 읽기 보기로 바로 보여 주고,
// 엔진은 "쪽 모양으로 보기"를 누를 때만 쓴다. 짧은 문서이거나 읽지 못하면 지금처럼 엔진으로 연다.
// 30쪽 분량이 되려면 본문 XML이 적어도 이만큼은 된다(한글 1,300자 × 30쪽 × 글자당 3바이트).
const FAST_READ_MIN_XML = 120 * 1024;
const WORD_MAX_TABLE_DEPTH = 40;

function readDocxFast(bytes) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./docx-read-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    let timer = 0;
    const done = (fn, value) => {
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    timer = setTimeout(() => done(reject, new Error('빠른 읽기 시간 초과')), 60000);
    worker.onmessage = ({ data }) => (data && data.ok ? done(resolve, data) : done(reject, new Error((data && data.error) || '빠른 읽기 실패')));
    worker.onerror = (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      done(reject, new Error((ev && ev.message) || '빠른 읽기 작업 스레드 오류'));
    };
    worker.postMessage({ bytes });
  });
}

async function tryFastRead(bytes) {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
  if (zipXmlSizes(bytes).document < FAST_READ_MIN_XML) return null;
  try {
    return await readDocxFast(bytes);
  } catch (e) {
    console.warn('word: 빠른 읽기 실패, 엔진으로 연다', e);
    return null;
  }
}

// 빠른 읽기 결과를 읽기 보기(showWordReading)가 쓰는 모양으로 바꾼다. 그림은 blob 주소로, 쪽 모양은 그때 엔진으로.
function fastReadingView(fast, bytes, host, doc) {
  const urls = fast.images.map((im) => URL.createObjectURL(new Blob([im.data], { type: im.type })));
  const linkImages = (blocks) => {
    for (const b of blocks) {
      if (b.t === 'p') {
        for (const r of b.runs) if (typeof r.img === 'number') r.img = urls[r.img];
      } else if (b.t === 'table') {
        for (const row of b.rows) for (const c of row.cells) linkImages(c.blocks);
      }
    }
  };
  linkImages(fast.blocks);
  return {
    blocks: fast.blocks,
    extras: fast.extras,
    omittedImages: fast.omittedImages,
    reader: 'fast',
    // 쪽 모양은 엔진이 문서를 처음부터 읽고 나서 나누므로 해석 시간만큼 더 기다린다.
    timeout: wordParseBudget(bytes) + WORD_FULL_TIMEOUT,
    showFull: () => import('./vendor/docx-view.js').then((mod) => new Promise((resolve, reject) => {
      mod.mountDocument(host, bytes, {
        onParsed: () => null,
        onLoad: (info) => {
          urls.forEach((u) => URL.revokeObjectURL(u));
          resolve(info.pages);
        },
        onFallback: (e) => wordFallbackNote(doc, e),
      }).catch(reject);
    })),
  };
}

// 쪽 모양 뷰어가 오류로 멈춰 엔진의 간이 뷰어로 바뀌었을 때
function wordFallbackNote(doc, e) {
  console.warn('word: 간이 보기로 전환', e);
  if (!document.querySelector('.word-fallback-note')) {
    const note = infoNote(T('기본 방식으로 열었어요. 번호·머리말 같은 일부 서식이 빠질 수 있어요.'));
    note.classList.add('word-fallback-note');
    addNotice(note, { priority: 2 });
  }
  report({ state: 'word-fallback', message: String(e && (e.message || e)).slice(0, 200) });
}

// 엔진으로 연다: 문서를 읽고(작업 스레드) 길면 엔진이 읽은 구조로 읽기 보기, 아니면 쪽 모양.
// 분량이 많으면(중급 휴대폰 기준 수 초 이상 멈춤) 쪽 나눔 전에 미리 알린다. onSize로 어림한 분량을 돌려준다.
async function openWordWithEngine(bytes, host, doc, stopTimer, onSize) {
  const mod = await import('./vendor/docx-view.js');
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error('시간 초과')), wordParseBudget(bytes));
    mod.mountDocument(host, bytes, {
      onLoad: (info) => {
        clearTimeout(timer);
        resolve({ pages: info.pages });
      },
      onReading: (view) => {
        clearTimeout(timer);
        resolve({ reading: view });
      },
      onParsed: async (counts) => {
        const size = wordSize(counts);
        onSize(size);
        report({ state: 'word-size', ...counts, load: size.load, reader: 'engine' });
        if (size.reading) return { reading: true };
        if (size.pages < 15 && counts.paragraphs < 300) return null;
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error('시간 초과')), Math.min(600000, 90000 + counts.paragraphs * 20));
        stopTimer();
        const about = size.pages >= 15 ? T('약 {n}쪽 분량이에요. ', { n: size.pages }) : '';
        showLoading(T('쪽을 나누고 있어요'), about + T('잠시만 기다려 주세요.'));
        // 안내가 화면에 그려진 뒤에 무거운 계산을 시작한다.
        await nextPaint();
        return null;
      },
      onFallback: (e) => wordFallbackNote(doc, e),
    }).catch((e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// react-docx가 쪽 단위로 화면 폭에 맞춰 보여준다. 옛 doc도 같은 엔진이 docx로 바꿔 읽는다.
// 긴 docx는 엔진 없이 먼저 읽기 보기로 연다(tryFastRead).
async function showWord(bytes, decrypted = false) {
  // 비밀번호 걸린 docx는 ZIP이 아니라 OLE 안에 암호화된 내용(EncryptedPackage)만 들어 있다.
  if (isOle(bytes) && oleHas(bytes, 'EncryptedPackage')) throw passwordError();
  // Word 2.0(DB A5)·DOS용 Word와 Write(31 BE)는 OLE 이전의 단독 형식이다. 글자만 간단히 보여준다.
  if ((bytes[0] === 0xdb && bytes[1] === 0xa5) || (bytes[0] === 0x31 && bytes[1] === 0xbe)) return showSimple('oldword', bytes);
  const stopTimer = showOpening();
  const doc = $('doc');
  const host = el('div', 'word-host');
  try {
    document.body.classList.add('word-mode');
    doc.className = 'word';
    doc.replaceChildren(host);
    let size = null;
    let opened = null;
    const fast = await tryFastRead(bytes);
    if (fast) {
      size = wordSize(fast.counts);
      report({ state: 'word-size', ...fast.counts, load: size.load, reader: 'fast', parseMs: fast.ms });
      if (fast.counts.depth > WORD_MAX_TABLE_DEPTH) {
        const err = new Error('table nesting too deep');
        err.code = 'too-deep';
        throw err;
      }
      if (size.reading) opened = { reading: fastReadingView(fast, bytes, host, doc) };
    }
    if (!opened) opened = await openWordWithEngine(bytes, host, doc, stopTimer, (s2) => { size = s2; });
    hideNotice();
    window.scrollTo(0, 0);
    if (opened.reading) {
      try {
        await showWordReading(opened.reading, size.pages, host, doc);
      } catch (e) {
        // 읽기 보기를 만들지 못하면 오류 대신 원래대로 쪽 모양으로 연다.
        console.warn('word: 읽기 모드 실패, 원본 모양으로', e);
        for (const n of document.querySelectorAll('.word-reading-note')) n.remove();
        $('menu-original').hidden = true;
        await showWordFull(opened.reading, size.pages, host, doc);
      }
    } else {
      report({ state: 'rendered', kind: 'word', pages: opened.pages });
    }
    addDocExtras('word', bytes, doc);
    if (!opened.reading) watchWordClipping(host, doc);
  } catch (e) {
    document.body.classList.remove('word-mode');
    doc.className = '';
    doc.replaceChildren();
    stopTimer();
    // Word 6·95(0xA5DC)와 그 이전 Word는 엔진이 못 읽는다. 본문 글자만 간단히 보여준다.
    if (isOldWordError(e)) return showSimple('oldword', bytes);
    // 비밀번호 걸린 97~2003 doc: 비밀번호를 물어 풀고 다시 연다.
    if (!decrypted && isOle(bytes) && /Encrypted \.doc files are not supported/.test(String(e && (e.message || e)))) {
      return showWord(await decryptLegacyDoc(bytes), true);
    }
    throw wordError(e);
  } finally {
    stopTimer();
  }
}

// 워드 엔진은 쪽 높이를 넘친 글(여러 쪽에 걸친 큰 표 칸 등)을 쪽 아래에서 잘라 버린다. 화면에 나온 쪽을 훑어
// 잘린 글이 있으면 문서 위에 어느 쪽인지 알리고, 잘린 글을 꺼내 보여 준다. 엔진이 그린 DOM은 건드리지 않는다.
function watchWordClipping(host, doc) {
  const found = new Map();
  const seen = new WeakSet();
  let note = null;
  const scan = () => {
    for (const surf of host.querySelectorAll('[data-docx-page-surface]')) {
      if (seen.has(surf)) continue;
      const wrapper = surf.closest('[data-docx-page-index]');
      const page = wrapper ? Number(wrapper.getAttribute('data-docx-page-index')) + 1 : 0;
      if (!page || found.has(page)) continue;
      // 쪽을 넘는 문단은 엔진이 다음 쪽에 같은 글을 다시 그리기도 한다. 다음 쪽에 보이는 글은 잘린 것으로 세지 않으므로
      // 다음 쪽이 아직 그려지지 않았으면 나중에 다시 본다.
      const nextWrapper = host.querySelector(`[data-docx-page-index="${page}"]`);
      const nextSurf = nextWrapper && nextWrapper.querySelector('[data-docx-page-surface]');
      if (nextWrapper && !nextSurf) continue;
      seen.add(surf);
      const shownNext = new Set();
      if (nextSurf) {
        const nb = nextSurf.getBoundingClientRect();
        for (const sp of nextSurf.querySelectorAll('span')) {
          if (sp.firstElementChild) continue;
          const r = sp.getBoundingClientRect();
          if (r.height > 0 && r.bottom > nb.top && r.top < nb.bottom - 1) shownNext.add(sp.textContent.trim());
        }
      }
      const bottom = surf.getBoundingClientRect().bottom;
      const hidden = [];
      for (const sp of surf.querySelectorAll('span')) {
        if (sp.firstElementChild || !sp.textContent.trim() || shownNext.has(sp.textContent.trim())) continue;
        const r = sp.getBoundingClientRect();
        if (r.height > 0 && r.top >= bottom - 1) hidden.push(sp.textContent);
      }
      const text = hidden.join(' ').replace(/\s+/g, ' ').trim();
      if (text.length >= 2) found.set(page, text);
    }
    if (!found.size) return;
    const pages = [...found.keys()].sort((a, b) => a - b);
    const label = T('{pages}쪽{more}은 아래쪽 글이 잘려 보여요.', { pages: joinList(pages.slice(0, 5)), more: pages.length > 5 ? T(' 등') : '', c: Math.min(pages.length, 5) });
    if (note) {
      note.querySelector('.info-note-text').textContent = label;
      return;
    }
    note = actionNote(label, T('잘린 글 보기'), () => showListPopup(T('잘린 글'),
      [...found.entries()].sort((a, b) => a[0] - b[0]).map(([p, t]) => ({ where: T('{n}쪽 아래', { n: p }), text: t }))));
    note.classList.add('extras-note');
    if (host.isConnected) addNotice(note, { priority: 2 });
    report({ state: 'clipped', kind: 'word', pages });
  };
  let timer = 0;
  host.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 400);
  }, { passive: true });
  setTimeout(scan, 300);
}

// ---------------------------------------------------------------- 간단 보기(RTF·ODT·ODP·Word 2003 XML·Word 2~95·웹 페이지 .doc)

async function readZip(bytes) {
  await loadScript('vendor/xlsx.full.min.js');
  await loadInflate();
  return lazyZip(window.XLSX, bytes);
}

async function oleStream(bytes, name) {
  await loadScript('vendor/xlsx.full.min.js');
  const cfb = window.XLSX.CFB.read(bytes, { type: 'array' });
  const entry = window.XLSX.CFB.find(cfb, name);
  if (!entry || !entry.content) throw new Error(`${name} 없음`);
  return entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content);
}

// 사람이 읽는 글 파일인지: 이진 바이트가 없고, 풀어 낸 글에 제어 문자·깨진 글자(�)가 거의 없다. 웹 문서(<…)는 제외한다.
function readableText(bytes) {
  if (!bytes.length || !isTextLike(bytes)) return false;
  const text = decodeText(bytes.subarray(0, 65536));
  if (/^\s*</.test(text)) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd || c === 0x7f) bad++;
  }
  return bad <= text.length * 0.01;
}

// 줄마다 탭(또는 쉼표)으로 칸이 고르게 나뉘어 있으면 표 자료로 본다.
// 카카오톡 "대화 내보내기" 글: "2026년 10월 8일 오후 3:01, 홍길동 : …"(휴대폰)·"[홍길동] [오후 3:01] …"(PC)
const CHAT_LINE = /^(\d{4}[년.]\s*\d{1,2}[월.]\s*\d{1,2}일?\.?\s*(오전|오후)?\s*\d{1,2}:\d{2}|\[[^\]]+\]\s*\[(오전|오후)\s*\d{1,2}:\d{2}\]|-{5,}.*\d{4}년)/;

function looksTabular(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, 60);
  if (lines.length < 2) return false;
  // 대화 기록은 줄마다 쉼표가 하나씩 있어도 표가 아니다.
  if (lines.filter((l) => CHAT_LINE.test(l)).length >= lines.length * 0.3) return false;
  for (const sep of ['\t', ',']) {
    const counts = lines.map((l) => countOutsideQuotes(l, sep)); // "영업팀, 2파트"처럼 따옴표 안 쉼표는 칸 나눔이 아니다
    const freq = new Map();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) || 0) + 1);
    let mode = 0;
    let best = 0;
    for (const [c, f] of freq) if (f > best) [mode, best] = [c, f];
    if (best < lines.length * (sep === '\t' ? 0.6 : 0.8)) continue;
    // 쉼표 하나로 두 칸인데 쉼표 뒤에 띄어쓰기가 대부분이면 문장이다("네, 알겠습니다").
    if (sep === ',' && mode === 1 && lines.filter((l) => /, /.test(l)).length >= lines.length * 0.5) continue;
    return true;
  }
  return false;
}

const SIMPLE_LABEL = {
  rtf: 'RTF 문서', odt: 'ODT 문서', odp: 'ODP 발표 자료', wordxml: 'Word 2003 XML 문서', oldword: '오래된 Word 문서', text: '텍스트 파일',
};

// ---------------------------------------------------------------- CAD 도면(DWG·DXF)
// LibreDWG(GPL-3.0)로 작업 스레드(cad-worker.js)에서 읽어 선·채움·글자 목록으로 받고, 캔버스(cad-view.js)에 그린다.
// 엔진(약 11MB)은 도면을 열 때만 불러오고, 다 읽으면 스레드를 끝내 메모리를 돌려준다.
const CAD_SKIP_NAMES = {
  '3DSOLID': '3D 솔리드', REGION: '영역', BODY: '3D 몸체', MESH: '메시', SURFACE: '곡면', ACAD_TABLE: '표',
  MULTILEADER: '여러 줄 지시선', MLINE: '다중선', TOLERANCE: '공차 기호', IMAGE: '그림', OLE2FRAME: 'OLE 개체',
  OLEFRAME: 'OLE 개체', INSERT_BROKEN: '읽지 못한 블록', POLYFACE: '3D 메시', UNDERLAY: '참조 파일', PDFUNDERLAY: '참조 PDF', DWFUNDERLAY: '참조 DWF',
};

function readCad(bytes, dxf) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker('cad-worker.js', { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      reject(userError('complex', T('도면이 너무 크거나 복잡해요'), T('다른 앱으로 열어 주세요.'), T('2분 안에 다 읽지 못함')));
    }, 120000);
    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error((e && e.message) || 'cad worker failed'));
    };
    const copy = bytes.slice();
    worker.postMessage({ bytes: copy, dxf }, [copy.buffer]);
  });
}

async function showCad(bytes, dxf) {
  showLoading(T('도면을 여는 중이에요'), T('큰 도면은 몇 초 걸릴 수 있어요'));
  const data = await readCad(bytes, dxf);
  if (!data || !data.ok) {
    throw userError('damaged', T('도면을 읽지 못했어요'), T('파일이 손상됐거나 아직 열 수 없는 CAD 형식이에요. 다른 앱으로 열어 주세요.'), (data && data.error) || '');
  }
  if (!data.strokes.length && !data.fillRings.length && !data.texts.length) {
    // 덜 받아진(잘린) 도면도 여기로 온다: 읽기는 끝났지만 그릴 개체가 하나도 없다
    throw userError('damaged', T('그릴 내용을 찾지 못했어요'), T('파일이 손상됐거나 덜 받아졌거나 비어 있는 도면이에요. 다른 앱으로 열어 확인해 주세요.'), T('개체 {n}개', { n: data.entities || 0 }));
  }
  const { mountCad } = await import('./cad-view.js');
  hideNotice();
  const note = infoNote(T('CAD 도면은 간단히 보여 줘요. 점선 같은 선 모양·글꼴·해치 무늬는 원본과 다를 수 있어요.'));
  note.dataset.priority = '2';
  addNotice(note);
  const missing = Object.entries(data.skipped || {}).filter(([k]) => k !== 'HATCH_PATTERN');
  if (missing.length) {
    const n = missing.reduce((a, [, c]) => a + c, 0);
    const list = missing.map(([k, c]) => `${T(CAD_SKIP_NAMES[k] || k)} ${c}`).join(', ');
    const miss = infoNote(T('그리지 못한 개체 {n}개({list})는 보이지 않아요.', { n, list }));
    miss.dataset.priority = '2';
    addNotice(miss);
  }
  if (data.truncated) {
    const big = infoNote(T('도면이 너무 커서 일부만 그렸어요. 전체는 다른 앱으로 열어 주세요.'));
    big.dataset.priority = '3';
    addNotice(big);
  }
  if (data.space === 'paper') addNotice(infoNote(T('모형 공간이 비어 있어 배치(종이 공간)를 보여 줘요.'), false));
  renderNotesStrip();
  const doc = $('doc');
  doc.className = 'cad';
  document.documentElement.classList.add('cad-mode');
  showNativeScrollbars(false);
  let background = 'dark';
  try {
    if (localStorage.getItem('be-docs.cad-background') === 'paper') background = 'paper';
  } catch (_) {
    // 기억해 둔 바탕을 못 읽으면 어두운 바탕(AutoCAD처럼)
  }
  cadCtl = mountCad(doc, data, {
    background,
    topInset: () => {
      const bar = $('bar');
      return bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0;
    },
  });
  // 시험·진단용: 지금 배율과 마지막으로 한 번 그리는 데 걸린 시간
  window.__beDocsCadView = () => (cadCtl ? cadCtl.view() : null);
  report({
    state: 'rendered', kind: 'cad', format: dxf ? 'dxf' : 'dwg', reader: data.reader, entities: data.entities,
    strokes: data.strokes.length / 4, texts: data.texts.length / 10, fills: data.fillRings.length / 5,
  });
}

async function showSimple(kind, bytes) {
  if (kind === 'webdoc') return showWebDoc(bytes);
  const mod = await import('./simple-view.js');
  let result;
  if (kind === 'rtf') result = mod.parseRtf(bytes);
  else if (kind === 'odt' || kind === 'odp') result = await mod.parseOdf(await readZip(bytes), kind);
  else if (kind === 'wordxml') result = mod.parseWordXml(decodeText(bytes));
  else if (kind === 'text') {
    const lines = decodeText(bytes).split(/\r\n|\r|\n/);
    result = { blocks: lines.slice(0, 20000).map((l) => ({ t: 'p', runs: [{ text: l }] })), cut: lines.length > 20000 ? lines.length : 0 };
  }
  else if (kind === 'oldword') {
    try {
      if (bytes[0] === 0x31 && bytes[1] === 0xbe) result = mod.parseOldWordText(bytes, 'write');
      else if (isOle(bytes)) result = mod.parseOldWordText(await oleStream(bytes, 'WordDocument'), 'word');
      else result = mod.parseOldWordText(bytes, 'word');
    } catch (e) {
      if (e && e.code === 'encrypted') throw passwordError();
      throw userError('unsupported', T('Word 95 이전 형식이라 다른 앱에서 열어 주세요'), T('본문을 읽지 못했어요.'), String(e && e.message));
    }
  }
  if (!mod.blocksText(result.blocks).trim()) throw new Error('빈 문서');

  const page = el('article', kind === 'odp' ? 'simple-doc simple-slides' : kind === 'text' ? 'simple-doc simple-text' : 'simple-doc');
  mod.renderBlocks(result.blocks, page);
  // 머리말·꼬리말·각주는 본문 위·아래에 따로 보여 준다(간단 보기라 쪽마다 반복하지 않는다).
  const extras = result.extras || {};
  if (extras.header) page.prepend(el('p', 'simple-hf', extras.header));
  if (extras.footnotes && extras.footnotes.length) {
    const box = el('section', 'simple-footnotes');
    box.append(el('p', 'simple-hf', T('각주')));
    extras.footnotes.forEach((t, i) => box.append(el('p', 'simple-p', `[${i + 1}] ${t}`)));
    page.append(box);
  }
  if (extras.footer) page.append(el('p', 'simple-hf', extras.footer));
  let note = result.textOnly
    ? T('{kind}라 글자만 보여요. 표·그림·서식은 다른 앱에서 확인해 주세요.', { kind: T(SIMPLE_LABEL[kind]) })
    : T('{kind}라 글꼴·배치가 원본과 다를 수 있어요.', { kind: T(SIMPLE_LABEL[kind]) });
  if (result.omittedPictures) note += T(' 그림 {n}개는 표시하지 못했어요.', { n: result.omittedPictures });
  // 글 파일은 원래 모양이 글 그대로라 줄였다는 안내가 필요 없다(너무 길어 자른 경우만 알린다).
  if (kind === 'text') note = result.cut ? T('전체 {n}줄 중 처음 20,000줄만 보여요.', { n: result.cut.toLocaleString() }) : '';
  const doc = $('doc');
  doc.className = 'simple';
  doc.replaceChildren(page);
  if (note) addNotice(infoNote(note), { priority: kind === 'text' ? 3 : result.textOnly || result.omittedPictures ? 2 : 1 });
  extrasNotes({ readable: [[T('메모'), extras.comments || []], [T('발표자 노트'), extras.notes || []]] }).forEach((n) => addNotice(n));
  hideNotice();
  window.scrollTo(0, 0);
  report({ state: 'rendered', kind: 'simple', format: kind });
}

// 웹 페이지(HTML·MHT)를 .doc 이름으로 준 경우: 스크립트·외부 연결을 모두 걷어낸 뒤 그림자 DOM 안에 그린다.
// 앱 화면과 스타일이 섞이지 않고, 남은 HTML이 있어도 CSP(스크립트·외부 그림 차단)가 한 번 더 막는다.
function decodeHtml(bytes, declared) {
  if ((bytes[0] === 0xef && bytes[1] === 0xbb) || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return decodeText(bytes);
  }
  const m = declared || (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(latin1(bytes.subarray(0, 8192))) || [])[1];
  if (m && !/utf-?8/i.test(m)) {
    try {
      return new TextDecoder(m.toLowerCase()).decode(bytes);
    } catch (_) {
      // 모르는 이름이면 아래에서 판별한다.
    }
  }
  return decodeText(bytes);
}

function base64Bytes(text) {
  const raw = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function quotedPrintableBytes(text) {
  const out = [];
  const s = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

// MHT(웹 보관 파일): 첫 HTML 부분과 그림 부분을 꺼낸다.
function parseMht(bytes) {
  const text = latin1(bytes);
  const boundary = (/boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(text) || [])[1];
  if (!boundary) throw new Error('MHT 경계 없음');
  const parts = text.split(`--${boundary}`).slice(1);
  let html = null;
  const resources = new Map();
  for (const part of parts) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).replace(/^\r?\n\r?\n/, '');
    const header = (name) => (new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head) || [])[1] || '';
    const type = header('Content-Type').toLowerCase();
    const enc = header('Content-Transfer-Encoding').toLowerCase();
    const data = enc.includes('base64') ? base64Bytes(body) : enc.includes('quoted') ? quotedPrintableBytes(body)
      : Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
    if (!html && type.startsWith('text/html')) {
      html = decodeHtml(data, (/charset\s*=\s*"?([\w-]+)/i.exec(type) || [])[1]);
    } else if (type.startsWith('image/')) {
      const url = URL.createObjectURL(new Blob([data], { type: type.split(';')[0] }));
      const loc = header('Content-Location').trim();
      const cid = header('Content-ID').trim().replace(/^<|>$/g, '');
      if (loc) {
        resources.set(loc.toLowerCase(), url);
        resources.set(loc.split(/[\\/]/).pop().toLowerCase(), url);
      }
      if (cid) resources.set(`cid:${cid}`.toLowerCase(), url);
    }
  }
  if (html == null) throw new Error('MHT 안에 HTML 없음');
  return { html, resources };
}

// SVG·MathML은 통째로 뺀다(애니메이션 요소가 링크를 javascript: 주소로 바꿀 수 있다).
const WEBDOC_DROP = 'script,iframe,frame,frameset,object,embed,applet,link,meta,base,template,audio,video,source,track,portal,svg,math';

// CSS 안의 외부 주소(url(...))를 지운다. CSP가 막긴 하지만 요청 시도조차 하지 않게 한다.
function cleanCss(text) {
  return text.replace(/@import[^;]+;?/gi, '').replace(/url\(\s*(?!['"]?data:image\/)[^)]*\)/gi, 'none');
}

// 지운 그림 수를 돌려준다(파일 밖에 있던 그림은 보여줄 수 없어 안내에 적는다).
function sanitizeWebDoc(doc, resources) {
  doc.querySelectorAll(WEBDOC_DROP).forEach((n) => n.remove());
  let droppedImages = 0;
  for (const node of doc.querySelectorAll('*')) {
    for (const a of [...node.attributes]) {
      const name = a.name.toLowerCase();
      const value = a.value.trim();
      if (name.startsWith('on') || name === 'formaction' || name === 'srcdoc' || name === 'target' || name === 'ping') {
        node.removeAttribute(a.name);
      } else if (name === 'style') {
        node.setAttribute('style', cleanCss(value));
      } else if (name === 'href' || name === 'xlink:href' || name === 'action') {
        if (!/^(https?:|mailto:|tel:|#)/i.test(value)) node.removeAttribute(a.name);
      } else if (name === 'src' || name === 'background' || name === 'poster' || name === 'srcset') {
        const local = resources.get(value.toLowerCase()) || resources.get(value.split(/[\\/]/).pop().toLowerCase());
        if (local && name === 'src') node.setAttribute('src', local);
        else if (!/^data:image\//i.test(value) || name !== 'src') {
          node.removeAttribute(a.name);
          if (name === 'src' && node.tagName === 'IMG') {
            droppedImages++;
            node.remove();
            break;
          }
        }
      }
    }
    if (/^(input|button|select|textarea)$/i.test(node.tagName)) node.setAttribute('disabled', '');
  }
  return droppedImages;
}

function showWebDoc(bytes) {
  const isMht = /^\s*(MIME-Version:|Content-Type:\s*multipart)/i.test(latin1(bytes.subarray(0, 2048)));
  const { html, resources } = isMht ? parseMht(bytes) : { html: decodeHtml(bytes), resources: new Map() };
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const droppedImages = sanitizeWebDoc(parsed, resources);
  if (!parsed.body || !parsed.body.textContent.trim() && !parsed.body.querySelector('img')) throw new Error('빈 문서');

  const host = el('div', 'webdoc-host');
  const root = host.attachShadow({ mode: 'open' });
  const base = document.createElement('style');
  base.textContent = ':host{display:block;background:#fff;color:#000;}'
    + '.body{padding:16px;overflow-wrap:anywhere;font-family:sans-serif;line-height:1.5}'
    + '.body img{max-width:100%;height:auto}.body table{max-width:100%}'
    + '.wide{overflow-x:auto}';
  root.append(base);
  // 문서의 스타일은 그대로 쓰되 외부 파일을 부르는 @import는 빼고, body·html 선택자를 그림자 DOM 안의 이름으로 바꾼다.
  for (const st of parsed.querySelectorAll('style')) {
    const copy = document.createElement('style');
    copy.textContent = cleanCss(st.textContent)
      .replace(/(^|[\s,}>])html(?=[\s,{.:#[>])/gi, '$1:host')
      .replace(/(^|[\s,}>])body(?=[\s,{.:#[>])/gi, '$1.body');
    root.append(copy);
    st.remove();
  }
  const body = document.createElement('div');
  body.className = 'body';
  const bodyStyle = parsed.body.getAttribute('style');
  if (bodyStyle) body.setAttribute('style', bodyStyle);
  for (const child of [...parsed.body.childNodes]) body.append(document.importNode(child, true));
  for (const t of body.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'wide';
    t.replaceWith(wrap);
    wrap.append(t);
  }
  root.append(body);

  const doc = $('doc');
  doc.className = 'simple';
  const lost = droppedImages ? T(' 문서 밖에 있던 그림 {n}개는 표시하지 못했어요.', { n: droppedImages }) : '';
  doc.replaceChildren(host);
  addNotice(infoNote(T('웹 페이지 형식으로 저장된 문서라 쪽 나눔·글꼴이 원본과 다를 수 있어요.{lost}', { lost })), { priority: lost ? 2 : 1 });
  hideNotice();
  window.scrollTo(0, 0);
  report({ state: 'rendered', kind: 'simple', format: isMht ? 'mht' : 'html' });
}

// ---------------------------------------------------------------- 비밀번호 걸린 xlsx·docx·pptx

// OLE 안의 EncryptionInfo·EncryptedPackage를 비밀번호로 풀어 원래 ZIP을 돌려준다.
// 97~2003 형식(RC4)·인증서 암호·DRM은 풀 수 없어 안내 카드로 넘긴다.
async function decryptOffice(bytes) {
  await loadScript('vendor/xlsx.full.min.js');
  const cfb = window.XLSX.CFB.read(bytes, { type: 'array' });
  const stream = (name) => {
    const e = window.XLSX.CFB.find(cfb, name);
    return e && e.content ? (e.content instanceof Uint8Array ? e.content : Uint8Array.from(e.content)) : null;
  };
  const info = stream('EncryptionInfo');
  const pkg = stream('EncryptedPackage');
  if (!info || !pkg) throw passwordError();
  const mod = await import('./vendor/office-crypto.js');
  let parsed;
  try {
    parsed = mod.readEncryptionInfo(info);
  } catch (e) {
    throw encryptionError(e);
  }
  for (let wrong = false; ; wrong = true) {
    const pw = await askPassword(wrong);
    // 열쇠를 만드는 계산(휴대폰에서 1초 안팎) 전에 "여는 중" 화면이 먼저 그려지게 한다.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const out = mod.decryptPackage(parsed, pw, pkg);
    if (out) return out;
  }
}

// ---------------------------------------------------------------- 시작

// 긴 파일 이름은 가운데를 줄이고 끝부분(버전·확장자)은 남긴다. 누르면 전체 이름을 여러 줄로 보여 준다.
function setTitle(name) {
  const title = $('title');
  const cut = Math.max(0, name.length - 14);
  // 두 칸(flex)으로 나누면 칸 끝의 띄어쓰기가 사라진다("회의 자료" → "회의자료"). 나눈 자리의 띄어쓰기는 붙는 띄어쓰기로.
  const keep = (s) => s.replace(/^\s|\s$/g, '\u00a0');
  const head = el('span', 'bar-title-head', keep(name.slice(0, cut)));
  const tail = el('span', 'bar-title-tail', keep(name.slice(cut)));
  title.replaceChildren(head, tail);
  title.setAttribute('aria-label', name);
  title.onclick = () => $('bar').classList.toggle('bar-full-name');
}

// 뒤로 가기: 찾기 막대·칸 팝업·차트 값 표가 열려 있으면 그것부터 닫는다(문서 전체가 닫히지 않게).
// 열린 것이 있을 때만 앱에 알려 뒤로 가기를 가로채게 한다(평소에는 시스템 뒤로 가기 그대로).
function watchBackTargets() {
  window.beDocsBack = () => {
    if (!$('menu').hidden) {
      window.beDocsCloseMenu();
      return true;
    }
    if (!$('notes-panel').hidden) {
      closeNotes();
      return true;
    }
    if (!$('share-panel').hidden) {
      closeShare();
      return true;
    }
    if (document.body.classList.contains('export-open') && exportCtl) {
      exportCtl.close();
      return true;
    }
    const pop = document.querySelector('#screen > .cell-pop');
    if (pop) {
      const close = pop.querySelector('.cell-pop-foot > button');
      if (close) close.click();
      else pop.remove();
      return true;
    }
    if (document.body.classList.contains('finding')) {
      document.querySelector('.find-close')?.click();
      return true;
    }
    return false;
  };
  if (!bridge || !bridge.setBackTarget) return;
  let last = false;
  const sync = () => {
    const open = !!document.querySelector('#screen > .cell-pop') || document.body.classList.contains('finding')
      || document.body.classList.contains('export-open')
      || !$('menu').hidden || !$('notes-panel').hidden || !$('share-panel').hidden;
    if (open === last) return;
    last = open;
    try {
      bridge.setBackTarget(open);
    } catch (_) {
      // 앱이 받지 못해도 화면은 그대로 쓴다.
    }
  };
  new MutationObserver(sync).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
  // 칸 팝업·차트 값 표는 화면 층(#screen)에 붙는다
  new MutationObserver(sync).observe($('screen'), { childList: true });
  for (const id of ['menu', 'notes-panel', 'share-panel']) new MutationObserver(sync).observe($(id), { attributes: true, attributeFilter: ['hidden'] });
}

// 위쪽 바: 내려 읽을 때는 비켜 주고, 올리면 다시 보인다(엑셀은 옆으로도 따라오는 방식을 따로 쓴다).
// PDF·한글·간단 보기는 페이지가, 워드·파워포인트는 뷰어 안의 상자가 스크롤한다. 둘 다 본다(스크롤 이벤트는 올라오지 않아 잡아서 본다).
function peekBar() {
  const last = new WeakMap();
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    const page = t === document || t === document.documentElement;
    if (!page && !(t.classList && (t.classList.contains('word-host') || t.closest('.slides-host')))) return;
    const y = page ? window.scrollY : t.scrollTop;
    const key = page ? document : t;
    const lastY = last.has(key) ? last.get(key) : 0;
    last.set(key, y);
    const bar = $('bar');
    if (document.body.classList.contains('sheet-mode') || document.body.classList.contains('finding')) {
      bar.classList.remove('bar-away');
    } else if (y > lastY + 6 && y > 120) {
      if (!bar.classList.contains('bar-away')) syncBarHeight();
      bar.classList.add('bar-away');
    } else if (y < lastY - 6 || y < 60) {
      bar.classList.remove('bar-away');
    }
  }, { passive: true, capture: true });
}

// 워드·파워포인트에서 바를 접을 때 쓸 높이(문서 안내 줄이 있으면 두 줄)
function syncBarHeight() {
  const bar = $('bar');
  if (!bar.hidden) document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
}

async function main() {
  window.__beDocsStarted = true;
  localizeStatic();
  peekBar();
  setupMenu();
  followScreen();
  watchBackTargets();
  setupDoubleTapReset();
  if (window.__beDocsUnsupported) return;
  const info = await getJson('/doc/info');
  if (info.empty) {
    showHome();
    return;
  }
  $('bar').hidden = false;
  setTitle(info.name || T('문서'));
  document.title = info.name || 'be docs';
  docInfo.name = info.name || '';
  docInfo.size = Number(info.size) || 0;
  showLoading(T('여는 중이에요'));
  // 300MB가 넘는 파일: 앱이 받아 두기 전에(크기를 알면 곧바로) 알려 준다
  if (info.tooBig) {
    const mb = info.size > 0 ? Math.round(info.size / 1048576) : 0;
    failWith('too-big', T('300MB가 넘는 파일은 열 수 없어요'),
      mb ? T('이 파일은 {n}MB예요. 다른 앱으로 열거나 컴퓨터에서 열어 주세요.', { n: mb }) : T('다른 앱으로 열거나 컴퓨터에서 열어 주세요.'),
      T('한도 300MB'));
    return;
  }
  if (info.error) {
    failWith('read', T('파일을 가져오지 못했어요'), info.error);
    return;
  }
  if (info.rendererFailed) {
    failWith('memory', T('문서가 커서 다른 앱에서 여는 게 좋아요'), T('휴대폰 메모리가 부족해 화면을 그리다 멈췄어요.'), 'renderer process gone');
    return;
  }
  if (info.size === 0) {
    failWith('empty', T('내용이 없는 빈 파일이에요'), T('파일을 받은 곳에서 다시 받아 주세요. 다운로드가 덜 끝났을 수 있어요.'), T('0바이트'));
    return;
  }

  const head = await getBytes('/doc/head');
  const kind = detectKind(head, info.name);
  docInfo.kind = kind;
  report({ state: 'loading', kind, name: info.name });
  if (kind === 'sheet') warmSheetWorker();

  let bytes = null;
  try {
    if (kind === 'pdf') {
      await showPdf();
      return;
    }
    if (kind === 'postscript') {
      failWith('unsupported', extOf(info.name) === 'ai' ? T('옛 일러스트레이터 형식이라 열 수 없어요') : T('EPS·PostScript 파일은 열 수 없어요'),
        T('일러스트레이터에서 "PDF 호환 파일 만들기"를 켜고 다시 저장하거나, 다른 앱으로 열어 주세요.'), T('PostScript 형식(%!PS)'));
      return;
    }
    bytes = await getBytes('/doc/file');
    bytes = skipJunkBeforeOle(bytes);
    let k = isOle(bytes) ? oleKind(bytes, kind === 'unknown' ? 'ole' : kind) : kind;
    // 비밀번호 걸린 xlsx·docx·pptx: 먼저 풀고, 풀린 내용(ZIP)으로 형식을 다시 판별한다.
    if (isOle(bytes) && oleHas(bytes, 'EncryptedPackage')) {
      bytes = await decryptOffice(bytes);
      k = detectKind(bytes.subarray(0, 8192), info.name);
      report({ state: 'decrypted', kind: k });
    }
    const locked = lockedByContent(bytes, info.name);
    if (locked) {
      showLocked(locked);
      return;
    }
    if (k === 'hwp') {
      await showHwp(bytes);
    } else if (k === 'csv' && extOf(info.name) === 'txt' && !looksTabular(decodeText(bytes.subarray(0, 65536)))) {
      // 메모 같은 일반 글 .txt는 표가 아니라 글 그대로 보여 준다(엑셀 '유니코드 텍스트' 같은 탭 자료는 표로).
      await showSimple('text', bytes);
    } else if (k === 'sheet' || k === 'csv') {
      await showSheet(bytes, k);
    } else if (k === 'slides') {
      await showSlides(bytes);
    } else if (k === 'word') {
      await showWord(bytes);
    } else if (k === 'cad') {
      await showCad(bytes, !/^AC1\d{3}/.test(latin1(bytes.subarray(0, 6))));
    } else if (k === 'zip' && isPlainArchive(bytes)) {
      const names = zipNames(bytes) || [];
      const docs = names.filter((x) => /\.(hwpx?|docx?|xlsx?|pptx?|pdf|csv)$/i.test(x));
      failWith('unsupported', T('압축 파일이에요'),
        T('"내 파일" 앱에서 압축을 푼 뒤 안의 문서를 열어 주세요.') + (docs.length ? T(' 안에 문서 {n}개가 들어 있어요.', { n: docs.length }) : ''),
        T('압축 안 파일: {list}{more}', { list: names.slice(0, 8).join(', '), more: names.length > 8 ? T(' 외 {n}개', { n: names.length - 8 }) : '' }));
    } else if (k === 'ole' || k === 'zip') {
      // 이름만으로 구분이 안 되는 컨테이너: 한글 → 엑셀 → 파워포인트 → 워드 순으로 열어 본다.
      // OLE 안에 워드 본문(WordDocument)이 보이면 워드를 먼저 시도한다(워드 문서를 품은 엑셀일 수도 있어 나머지도 이어서 시도).
      const tries = [
        ['hwp', () => showHwp(bytes)],
        ['sheet', () => showSheet(bytes, 'sheet')],
        ['slides', () => showSlides(bytes)],
        ['word', () => showWord(bytes)],
      ];
      if (k === 'ole' && oleHas(bytes, 'WordDocument')) tries.unshift(tries.pop());
      let last = null;
      for (const [name, run] of tries) {
        try {
          await run();
          last = null;
          break;
        } catch (e) {
          // 한글 엔진은 다른 형식에도 오류를 내므로 그 안내는 넘기고, 나머지는 사용자 안내(비밀번호 등)면 바로 보여준다.
          if (name !== 'hwp' && e && e.userFacing) throw e;
          last = e;
        }
      }
      if (last) throw last;
    } else if (k === 'rtf' || k === 'odt' || k === 'odp' || k === 'wordxml' || k === 'webdoc') {
      await showSimple(k, bytes);
    } else if (k === 'unknown' && readableText(bytes)) {
      // 확장자가 없거나 모르는 글 파일(메모·기록 등): 내용이 읽히는 글이면 글(또는 표)로 보여 준다.
      if (looksTabular(decodeText(bytes.subarray(0, 65536)))) await showSheet(bytes, 'csv');
      else await showSimple('text', bytes);
    } else if (k === 'hancom-other') {
      failWith('unsupported', T('한셀·한쇼 문서는 다른 앱에서 열어 주세요'), T('한컴오피스 뷰어 같은 앱에서 열 수 있어요.'));
    } else {
      failWith('unsupported', T('다른 앱에서 열어야 하는 파일이에요'), T('be docs가 여는 형식: {list}', { list: T(SUPPORTED) }), T('형식 판별: {k}', { k }));
    }
    dropWarmSheet(); // 엑셀로 짐작해 미리 띄웠는데 쓰지 않은 작업 스레드(탭 글자 .xls·다른 형식으로 밝혀진 파일)
  } catch (e) {
    console.error(e);
    dropWarmSheet();
    const cut = bytes && !(e && e.reason === 'password') && cutShort(bytes);
    const locked = !cut && !(e && e.userFacing) && bytes && lockedOle(bytes, info.name);
    if (cut) {
      failWith('damaged', T('파일을 끝까지 받지 못했어요'), T('파일 뒷부분이 없어요. 파일을 받은 곳에서 다시 받아 주세요.'), cut);
    } else if (locked) showLocked(locked);
    else showFailure(e);
  }
}

// 형식별 코드가 던진 오류를 안내 화면으로 바꾼다. 원인 글은 "자세히" 안에만 둔다.
function showFailure(e) {
  const tech = String(e && (e.tech || e.message || e)).slice(0, 300);
  if (e && e.userFacing) failWith(e.reason || 'damaged', e.message, e.detail, e.tech);
  else if (isPasswordProtectedError(e)) {
    const p = passwordError();
    failWith('password', p.message, p.detail, tech);
  } else {
    failWith('damaged', T('이 파일은 다른 앱에서 열어 보세요'),
      T('다운로드가 덜 끝났거나 be docs가 읽지 못하는 구성이에요. 파일을 받은 곳에서 다시 받으면 열릴 수도 있어요.'), tech);
  }
}

main().catch((e) => showFailure(e));
