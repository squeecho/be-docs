// 상태 조합 시험: 문서 종류 × 화면(세로·작은 폰·가로·폴드) × 밝은/어두운 화면(+ 글자 1.3배) × 배율 × 열린 것
// (메뉴·문서 안내·찾기·칸 팝업·쪽 이동 손잡이·이미지로 변환 창)을 돌며, 상태마다 같은 기준을 잰다.
// ux.mjs는 "정해 둔 순서" 시나리오를 본다. 이 시험은 그 순서 밖의 조합(배율을 바꾼 뒤 메뉴, 가로 화면에서 문서 안내,
// 어두운 화면의 팝업 글자 등)에서 앱 화면이 깨지지 않는지 본다. 2026-10 "줄인 엑셀에서 위쪽 바가 반만 보임",
// "넓은 엑셀에서 메뉴가 화면 밖에 열림"을 놓친 것을 계기로 만들었다.
//
// 기준(상태마다):
// - 위쪽 바: 보이는 영역 맨 위, 화면 폭 전체. ⋮는 화면 안에 있고 눌린다(다른 것이 덮지 않음)
// - 메뉴: 화면 안, ⋮ 아래. 항목마다 눌린다. 열면 앱에 뒤로 가기 대상을 알리고 닫으면 푼다
// - 문서 안내·칸 팝업·찾기 막대: 화면 안. 닫기·입력 칸이 눌린다. 뒤로 가기(beDocsBack)로 닫힌다
// - 시트 탭: 화면 폭 전체, 바 아래. 쪽 이동 손잡이: 화면 오른쪽 끝, 화면 안
// - 배율 100%에서 엑셀이 아닌 문서는 옆으로 넘치지 않는다
// - 글자 대비: 바 제목·메뉴 항목·안내 글이 배경과 4.5:1 이상(반투명 배경은 아래 배경과 섞어 계산)
// - 스크립트 오류가 없다
// 사용: node states.mjs <port> <매트릭스 폴더> [스크린샷 폴더]   (server.mjs가 떠 있어야 한다)
//       ONLY=pdf,hwp  → 파일 이름에 그 글자가 든 것만.  QUICK=1 → 세로 폰·밝은 화면만
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from './playwright.mjs';

const { chromium } = loadPlaywright();
const [,, port, dirArg, shotsArg] = process.argv;
const dir = path.resolve(dirArg);
const shots = shotsArg ? path.resolve(shotsArg) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ['--no-sandbox'] } : {});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bedocs-states-'));

// 화면: 갤럭시 S 시리즈 세로, 작은 폰, 가로, 폴드 펼침(안쪽 화면)
const SCREENS = [
  { name: 'phone', width: 412, height: 915, scale: 2.625 },
  { name: 'small', width: 360, height: 640, scale: 3 },
  { name: 'landscape', width: 915, height: 412, scale: 2.625 },
  { name: 'fold', width: 904, height: 1088, scale: 2 },
];

// 10쪽 PDF(쪽 이동 손잡이용)
async function tenPagePdf() {
  const file = path.join(tmp, 'ten-pages.pdf');
  const gen = await browser.newPage();
  await gen.setContent(Array.from({ length: 10 }, (_, i) => `<section style="height:1000px;page-break-after:always;font:48px sans-serif;padding:40px">쪽 ${i + 1} 견적 내용</section>`).join(''));
  await gen.pdf({ path: file, format: 'A4' });
  await gen.close();
  return file;
}

const FILES = [
  { file: null, kind: 'home' },
  { file: null, kind: 'home', recents: true },
  { file: 'excel-rich.xlsx', kind: 'sheet' },
  { file: 'csv-utf8.csv', kind: 'sheet' },
  { file: 'pdf-mixed-sizes.pdf', kind: 'pages', find: '견적' },
  { file: await tenPagePdf(), kind: 'pages', find: '견적' },
  { file: 'hwp5.0.3.0.hwp', kind: 'pages' },
  { file: 'hwp-memo.hwp', kind: 'pages' },
  { file: 'word-extras.docx', kind: 'word' },
  { file: 'word-long-reading.docx', kind: 'word' },
  { file: 'slides-extras.pptx', kind: 'slides' },
  { file: 'word.rtf', kind: 'simple' },
  { file: 'cad-2018.dwg', kind: 'cad' },
].filter((f) => !process.env.ONLY || process.env.ONLY.split(',').some((o) => (f.file || (f.recents ? 'home-recent' : 'home')).includes(o)));

// 시작 화면의 최근 문서(긴 이름·여러 형식·오늘/어제/예전 날짜)
const RECENTS = (() => {
  const now = Date.now();
  return [
    { id: '0000000000000001', name: '2026 매장 리뉴얼 견적서_최종_수정본(거래처 확인용).xlsx', size: 284211, opened: now - 5 * 60e3, kind: 'copy' },
    { id: '0000000000000002', name: '공사 일정표.hwp', size: 1203456, opened: now - 3 * 3600e3, kind: 'pick' },
    { id: '0000000000000003', name: '1층 평면도.dwg', size: 4567890, opened: now - 26 * 3600e3, kind: 'copy' },
    { id: '0000000000000004', name: 'Quarterly_Business_Review_Presentation_FINAL_v12.pptx', size: 9876543, opened: now - 5 * 86400e3, kind: 'copy' },
    { id: '0000000000000005', name: 'contract.pdf', size: 345678, opened: now - 400 * 86400e3, kind: 'pick' },
    { id: '0000000000000006', name: '메모.txt', size: 1234, opened: now - 8 * 86400e3, kind: 'copy' },
  ];
})();

const fails = [];
let states = 0;

// 페이지 안에서 상태를 잰다. 화면 기준 좌표(보이는 영역 왼쪽 위 = 0, 화면 px = CSS px × 배율)로 본다.
const INSPECT = () => {
  window.__inspect = (what) => {
    const vv = window.visualViewport;
    const s = vv.scale;
    const W = vv.width * s;
    const H = vv.height * s;
    const out = [];
    const scr = (el) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left - vv.offsetLeft) * s, y: (r.top - vv.offsetTop) * s, w: r.width * s, h: r.height * s, r };
    };
    const shown = (el) => el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const name = (el) => el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').filter(Boolean).slice(0, 2).join('.')}` : ''}` : 'null';
    const inScreen = (label, el, tol = 1) => {
      const b = scr(el);
      if (b.x < -tol || b.y < -tol || b.x + b.w > W + tol || b.y + b.h > H + tol) out.push(`${label} 화면 밖 ${JSON.stringify({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), W: Math.round(W), H: Math.round(H) })}`);
      return b;
    };
    const hit = (label, el) => {
      const r = el.getBoundingClientRect();
      const got = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!got || !(got === el || el.contains(got))) out.push(`${label} 눌리지 않음(${name(got)}이 덮음)`);
    };
    // 반투명 배경은 아래 배경과 섞는다
    const rgba = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number).concat(m.length === 3 ? [1] : []) : [0, 0, 0, 0]; };
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let acc = rgba(getComputedStyle(document.body).backgroundColor);
      if (acc[3] < 1) acc = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) {
        const [r, g, b, a] = layers[i];
        acc = [r * a + acc[0] * (1 - a), g * a + acc[1] * (1 - a), b * a + acc[2] * (1 - a), 1];
      }
      return acc;
    };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const contrast = (label, el, min = 4.5) => {
      const fg = rgba(getComputedStyle(el).color);
      const bg = bgOf(el);
      const blended = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
      const a = lum(blended);
      const b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < min) out.push(`${label} 글자 대비 ${ratio.toFixed(2)}:1`);
    };
    const bar = document.getElementById('bar');
    if (what.bar && shown(bar) && !bar.classList.contains('bar-away')) {
      const b = scr(bar);
      if (Math.abs(b.x) > 2 || Math.abs(b.w - W) > 2) out.push(`바가 화면 폭에 안 맞음 ${JSON.stringify({ x: Math.round(b.x), w: Math.round(b.w), W: Math.round(W) })}`);
      if (what.atTop && Math.abs(b.y) > 2) out.push(`바가 맨 위가 아님 y=${Math.round(b.y)}`);
      const btn = document.getElementById('menu-btn');
      inScreen('⋮', btn);
      hit('⋮', btn);
      contrast('바 제목', document.getElementById('title'));
      const strip = document.getElementById('notes-strip');
      if (shown(strip)) contrast('안내 한 줄', strip.querySelector('.notes-strip-text'));
    }
    const tabs = document.getElementById('tabs');
    if (what.bar && what.atTop && shown(tabs)) {
      const t = scr(tabs);
      const b = scr(bar);
      if (Math.abs(t.x) > 2 || Math.abs(t.w - W) > 2) out.push(`탭이 화면 폭에 안 맞음 ${JSON.stringify({ x: Math.round(t.x), w: Math.round(t.w) })}`);
      if (t.y < b.y + b.h - 2) out.push(`탭이 바에 가려짐 ${Math.round(t.y)} < ${Math.round(b.y + b.h)}`);
      for (const tab of tabs.querySelectorAll('.tab')) if (scr(tab).x < W - 10 && scr(tab).x + scr(tab).w > 10) contrast(`탭 "${tab.textContent.slice(0, 8)}"`, tab);
    }
    const menu = document.getElementById('menu');
    if (what.menu) {
      if (!shown(menu)) out.push('메뉴가 안 열림');
      else {
        const m = inScreen('메뉴', menu);
        const btn = scr(document.getElementById('menu-btn'));
        if (m.y < btn.y + btn.h - 8) out.push(`메뉴가 ⋮를 가림 ${Math.round(m.y)} < ${Math.round(btn.y + btn.h)}`);
        for (const item of menu.querySelectorAll('.menu-item')) {
          if (!shown(item)) continue;
          hit(`메뉴 "${item.textContent}"`, item);
          contrast(`메뉴 "${item.textContent}"`, item);
        }
      }
    }
    const panel = document.getElementById('notes-panel');
    if (what.notes) {
      if (!shown(panel)) out.push('문서 안내가 안 열림');
      else {
        const p = inScreen('문서 안내', panel);
        if (p.h > H * 0.8) out.push(`문서 안내가 너무 큼 ${Math.round(p.h)}/${Math.round(H)}`);
        hit('문서 안내 닫기', document.getElementById('notes-close'));
        const first = panel.querySelector('.info-note');
        if (first) contrast('문서 안내 글', first.querySelector('p, span') || first);
      }
    }
    if (what.pop) {
      const pop = document.querySelector('#screen > .cell-pop');
      if (!pop) out.push('칸 팝업이 안 열림');
      else {
        inScreen('칸 팝업', pop);
        const close = pop.querySelector('.cell-pop-foot > button');
        if (!close) out.push('칸 팝업 닫기 버튼 없음');
        if (close) hit('칸 팝업 닫기', close);
        const text = pop.querySelector('.cell-pop-text, .cell-pop-note');
        if (text) contrast('칸 팝업 글', text);
      }
    }
    if (what.find) {
      const fb = document.querySelector('.findbar');
      if (!fb) out.push('찾기 막대가 안 열림');
      else {
        const f = inScreen('찾기 막대', fb);
        if (Math.abs(f.x) > 2 || Math.abs(f.w - W) > 2) out.push(`찾기 막대가 화면 폭에 안 맞음 ${JSON.stringify({ x: Math.round(f.x), w: Math.round(f.w) })}`);
        hit('찾기 입력 칸', fb.querySelector('input'));
      }
    }
    if (what.export) {
      const p = document.getElementById('export-panel');
      if (!shown(p)) out.push('이미지로 변환 창이 안 열림');
      else {
        inScreen('이미지로 창', p);
        const parts = [['닫기', '.export-close'], ['전체 선택', '.export-all'], ['범위 입력', '.export-range input'], ['고르기', '.export-range button'],
          ['공유하기', '.export-actions .btn-primary'], ['사진첩에 저장', '.export-actions .btn:not(.btn-primary)'], ['고른 쪽', '.export-thumb.on'], ['화질', '.export-q']];
        for (const [label, sel] of parts) {
          const el = p.querySelector(sel);
          if (!el) { out.push(`이미지로 ${label} 없음`); continue; }
          inScreen(`이미지로 ${label}`, el);
          hit(`이미지로 ${label}`, el);
        }
        for (const [label, sel] of [['제목', '.export-title'], ['선택 수', '.export-count'], ['공유하기', '.export-actions .btn-primary'], ['사진첩에 저장', '.export-actions .btn:not(.btn-primary)'], ['안내 글', '.export-note']]) {
          const el = p.querySelector(sel);
          if (el) contrast(`이미지로 ${label}`, el);
        }
        const g = p.querySelector('.export-grid').getBoundingClientRect();
        if (g.height < 100) out.push(`이미지로 쪽 그림 칸이 너무 좁음 ${Math.round(g.height)}px`);
      }
    }
    if (what.pager) {
      const pager = document.getElementById('pager');
      if (!shown(pager) || pager.classList.contains('idle')) out.push('쪽 이동 손잡이가 안 보임');
      else {
        const t = inScreen('손잡이', document.getElementById('pager-thumb'));
        if (Math.abs(t.x + t.w - W) > 2) out.push(`손잡이가 오른쪽 끝이 아님 ${Math.round(t.x + t.w)}/${Math.round(W)}`);
        inScreen('쪽 표시', document.getElementById('pager-label'));
        hit('손잡이', document.getElementById('pager-thumb'));
        contrast('쪽 표시', document.getElementById('pager-label'));
      }
    }
    if (what.recentHome) {
      for (const [label, sel] of [['제목', '#notice h1'], ['최근 문서', '.recent-top h2'], ['모두 지우기', '.recent-clear'], ['문서 이름', '.recent-item .recent-name'], ['날짜·크기', '.recent-item .recent-meta'], ['형식', '.recent-item .file-badge-ext']]) {
        const e = document.querySelector(sel);
        if (!e || !shown(e)) { out.push(`${label} 없음`); continue; }
        inScreen(label, e);
        contrast(label, e);
      }
      const pick = document.querySelector('.home-pick');
      if (!pick) out.push('파일 열기 버튼 없음');
      else { inScreen('파일 열기', pick); hit('파일 열기', pick); contrast('파일 열기', pick); }
      for (const [label, sel] of [['첫 문서', '.recent-open'], ['⋮', '.recent-more'], ['모두 지우기', '.recent-clear']]) {
        const e = document.querySelector(sel);
        if (e) {
          hit(label, e);
          const r = e.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) out.push(`${label} 누를 곳이 작음 ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      for (const n of document.querySelectorAll('.recent-name')) if (n.scrollWidth > n.clientWidth + 1) out.push(`이름이 옆으로 넘침 "${n.textContent.slice(0, 12)}"`);
      const rows = [...document.querySelectorAll('.recent-item')];
      if (rows.length && scr(rows[0]).y > H * 0.45) out.push(`목록이 화면 아래쪽에서 시작 y=${Math.round(scr(rows[0]).y)}/${Math.round(H)}`);
    }
    if (what.recentFoot) {
      for (const [label, sel] of [['보관 안내', '.recent-note'], ['지원 형식', '.home-support'], ['버전', '.home-foot .home-version'], ['앱 정보', '.home-foot .home-link']]) {
        const e = document.querySelector(sel);
        if (!e || !shown(e)) { out.push(`${label} 없음`); continue; }
        inScreen(label, e);
        contrast(label, e);
      }
    }
    if (what.home) {
      const texts = [...document.querySelectorAll('#notice h1, #notice .notice-sub, #notice .home-link, #notice .home-version')].filter(shown);
      if (texts.length < 3) out.push(`시작 화면 글이 모자람(${texts.length})`);
      for (const t of texts) { inScreen(`시작 "${t.textContent.slice(0, 10)}"`, t); contrast(`시작 "${t.textContent.slice(0, 10)}"`, t); }
      const btn = document.querySelector('#notice .btn-primary');
      if (!btn) out.push('파일 열기 버튼 없음');
      else { inScreen('파일 열기', btn); hit('파일 열기', btn); contrast('파일 열기', btn); }
    }
    if (what.noOverflow && Math.abs(s - 1) < 0.01) {
      const sw = document.documentElement.scrollWidth;
      if (sw > window.innerWidth + 1) out.push(`옆으로 넘침 ${sw} > ${window.innerWidth}`);
    }
    return out;
  };
};

async function run(spec, screen, dark, fontScale) {
  const label = `${spec.file ? path.basename(spec.file) : spec.recents ? '시작 화면(최근 문서)' : '시작 화면'} · ${screen.name}${dark ? ' · 어두움' : ''}${fontScale !== 1 ? ` · 글자 ${fontScale}배` : ''}`;
  if (spec.file) {
    const f = path.isAbsolute(spec.file) ? spec.file : path.join(dir, spec.file);
    await fetch(`${base}/__set?` + new URLSearchParams({ f, name: path.basename(f) }));
  } else {
    await fetch(`${base}/__set`);
  }
  const ctx = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.scale, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));
  await page.addInitScript(({ scale, recents }) => {
    window.__r = [];
    window.__back = [];
    window.DocViewer = {
      report: (s) => window.__r.push(JSON.parse(s)),
      pickFile() {}, openElsewhere() {}, canOpenElsewhere: () => true, canShare: () => true, shareFile() {}, shareFileAs() {}, canDownload: () => true, download() {},
      fontScale: () => scale, setBackTarget(open) { window.__back.push(open); }, showScrollbars() {},
      zoomBy(f) { window.__zoomReq = f; },
      recentList: () => JSON.stringify(recents || []), openRecent() {}, removeRecent() {}, clearRecent() {},
      appVersion: () => '0.2.0 (test)',
      exportBegin() { return true; }, exportPart() { return true; }, exportEnd() { return 1; }, exportCancel() {},
    };
  }, { scale: fontScale, recents: spec.recents ? RECENTS : null });
  await page.addInitScript(INSPECT);
  const problems = [];
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: path.join(shots, `${label.replace(/[^\w가-힣.-]+/g, '_')}__${name}.png`) });
  };
  const inspect = async (stateName, what) => {
    states++;
    // 열리고 닫히는 움직임(아래에서 올라오는 상자 등)이 끝난 뒤에 잰다
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
    const out = await page.evaluate((w) => window.__inspect(w), what);
    for (const p of out) problems.push(`[${stateName}] ${p}`);
    if (out.length) await shot(stateName);
  };
  // CAD 도면: 캔버스가 화면을 꽉 채우고(돌린 뒤에도) 도면이 실제로 그려져 있어야 한다
  const cadFills = () => page.evaluate(() => {
    const c = document.querySelector('.cad-canvas');
    if (!c) return '도면 캔버스가 없음';
    const b = c.getBoundingClientRect();
    if (Math.abs(b.width - innerWidth) > 1 || Math.abs(b.height - innerHeight) > 1) return `캔버스 ${Math.round(b.width)}×${Math.round(b.height)}가 화면 ${innerWidth}×${innerHeight}과 다름`;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 64) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 40) n++;
    return n > 200 ? '' : `도면이 거의 그려지지 않음(점 ${n}개)`;
  });
  const lastBack = () => page.evaluate(() => window.__back[window.__back.length - 1]);
  const goBack = () => page.evaluate(() => window.beDocsBack && window.beDocsBack());
  const setScale = async (cdp, v) => {
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: v });
    await page.waitForTimeout(450);
  };
  try {
    await page.goto(`${base}/viewer/index.html`);
    await page.waitForFunction(() => window.__r.some((r) => ['rendered', 'home', 'error'].includes(r.state)), null, { timeout: 120000 });
    const end = await page.evaluate(() => window.__r.find((r) => ['rendered', 'home', 'error'].includes(r.state)));
    if (end.state === 'error') problems.push(`열리지 않음 ${JSON.stringify(end)}`);
    await page.waitForTimeout(600);
    const cdp = await ctx.newCDPSession(page);
    const doc = spec.kind !== 'home';
    const noOverflow = spec.kind !== 'sheet';

    if (!doc && spec.recents) {
      await inspect('시작(최근 문서)', { noOverflow: true, recentHome: true });
      await shot('시작_최근문서');
      // ⋮ → 빼기 묻는 창: 화면 안, 버튼 눌림, 뒤로 가기로 닫힘
      await page.evaluate(() => document.querySelector('.recent-more')?.click());
      await page.waitForTimeout(400);
      await inspect('최근 문서 빼기', { pop: true });
      await shot('최근문서_빼기');
      if (await lastBack() !== true) problems.push('[최근 문서 빼기] 뒤로 가기 대상을 알리지 않음');
      await goBack();
      await page.waitForTimeout(300);
      if (await page.evaluate(() => !!document.querySelector('#screen > .cell-pop'))) problems.push('[최근 문서 빼기] 뒤로 가기로 안 닫힘');
      // 끝까지 내려도(설명·버전·앱 정보) 화면 안
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      await inspect('시작(최근 문서) 끝', { noOverflow: true, recentFoot: true });
    } else if (!doc) {
      await inspect('시작', { noOverflow: true, home: true });
      await shot('시작');
      await page.evaluate(() => document.querySelector('.home-link')?.click());
      await page.waitForTimeout(400);
      await inspect('앱 정보', { pop: true });
      if (await lastBack() !== true) problems.push('[앱 정보] 뒤로 가기 대상을 알리지 않음');
      await goBack();
      await page.waitForTimeout(300);
      if (await page.evaluate(() => !!document.querySelector('#screen > .cell-pop'))) problems.push('[앱 정보] 뒤로 가기로 안 닫힘');
    } else {
      await inspect('기본', { bar: true, atTop: true, noOverflow });
      if (spec.kind === 'cad') { const c = await cadFills(); if (c) problems.push(`[기본] ${c}`); }
      await shot('기본');
      // 메뉴
      await page.evaluate(() => document.getElementById('menu-btn').click());
      await page.waitForTimeout(250);
      await inspect('메뉴', { bar: true, atTop: true, menu: true });
      if (await lastBack() !== true) problems.push('[메뉴] 뒤로 가기 대상을 알리지 않음');
      await shot('메뉴');
      const items = await page.evaluate(() => [...document.querySelectorAll('#menu .menu-item')].filter((b) => !b.hidden).map((b) => b.id));
      await goBack();
      await page.waitForTimeout(250);
      if (await page.evaluate(() => !document.getElementById('menu').hidden)) problems.push('[메뉴] 뒤로 가기로 안 닫힘');
      if (await lastBack() !== false) problems.push('[메뉴] 닫은 뒤 뒤로 가기 대상을 풀지 않음');
      // 문서 안내
      if (items.includes('menu-notes')) {
        await page.evaluate(() => { document.getElementById('menu-btn').click(); document.getElementById('menu-notes').click(); });
        await page.waitForTimeout(400);
        await inspect('문서 안내', { notes: true });
        await shot('문서안내');
        await goBack();
        await page.waitForTimeout(300);
        if (await page.evaluate(() => !document.getElementById('notes-panel').hidden)) problems.push('[문서 안내] 뒤로 가기로 안 닫힘');
      }
      // 찾기(PDF)
      if (items.includes('find')) {
        await page.evaluate(() => { document.getElementById('menu-btn').click(); document.getElementById('find').click(); });
        await page.waitForTimeout(400);
        if (spec.find) {
          await page.evaluate((q) => { const i = document.querySelector('.findbar input'); i.value = q; i.dispatchEvent(new Event('input', { bubbles: true })); }, spec.find);
          await page.waitForTimeout(800);
        }
        await inspect('찾기', { find: true });
        await shot('찾기');
        if (await lastBack() !== true) problems.push('[찾기] 뒤로 가기 대상을 알리지 않음');
        await goBack();
        await page.waitForTimeout(300);
        if (await page.evaluate(() => document.body.classList.contains('finding'))) problems.push('[찾기] 뒤로 가기로 안 닫힘');
      }
      // 이미지로 변환(PDF): 지금 쪽이 골라진 채 열리고, 뒤로 가기로 닫힌다
      if (items.includes('menu-export')) {
        await page.evaluate(() => { document.getElementById('menu-btn').click(); document.getElementById('menu-export').click(); });
        await page.waitForTimeout(600);
        await inspect('이미지로', { export: true });
        await shot('이미지로');
        if (await lastBack() !== true) problems.push('[이미지로] 뒤로 가기 대상을 알리지 않음');
        await goBack();
        await page.waitForTimeout(300);
        if (await page.evaluate(() => !document.getElementById('export-panel').hidden)) problems.push('[이미지로] 뒤로 가기로 안 닫힘');
        if (await lastBack() !== false) problems.push('[이미지로] 닫은 뒤 뒤로 가기 대상을 풀지 않음');
      }
      // 칸 팝업(엑셀): 메모가 있는 칸, 없으면 글자가 있는 첫 칸
      if (spec.kind === 'sheet') {
        // 팝업은 메모가 있거나 글자가 잘린 칸에서만 뜬다
        const opened = await page.evaluate(() => {
          const clipped = (t) => { const b = t.querySelector('.spill-text') || t; return b.scrollWidth > b.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1; };
          const td = document.querySelector('.sheet td.has-note') || [...document.querySelectorAll('.sheet td')].find((t) => t.textContent.trim() && clipped(t));
          if (!td) return false;
          td.click();
          return true;
        });
        if (opened) {
          await page.waitForTimeout(350);
          await inspect('칸 팝업', { pop: true });
          await shot('칸팝업');
          if (await lastBack() !== true) problems.push('[칸 팝업] 뒤로 가기 대상을 알리지 않음');
          await goBack();
          await page.waitForTimeout(300);
          if (await page.evaluate(() => !!document.querySelector('#screen > .cell-pop'))) problems.push('[칸 팝업] 뒤로 가기로 안 닫힘');
          if (await lastBack() !== false) problems.push('[칸 팝업] 닫은 뒤 뒤로 가기 대상을 풀지 않음');
        }
      }
      // 쪽 문서: 내려 읽기(바가 비켜 주고 손잡이가 나옴) → 조금 올리기(바가 돌아옴)
      if (spec.kind === 'pages') {
        const pages = await page.evaluate(() => document.querySelectorAll('.page').length);
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.waitForTimeout(450);
        if (pages >= 2) {
          await inspect('내려 읽기', { pager: true, noOverflow });
          await shot('내려읽기');
        }
        await page.evaluate(() => window.scrollBy(0, -120));
        await page.waitForTimeout(450);
        await inspect('올리기', { bar: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(300);
      }
      // 배율: 줄일 수 있는 문서(화면보다 넓은 엑셀)는 60%, 모두 200%.
      // CAD 도면은 화면 배율을 막고(touch-action: none) 도면만 확대하므로 화면 배율 상태가 생기지 않는다.
      const wide = await page.evaluate(() => document.documentElement.scrollWidth >= window.innerWidth / 0.6);
      for (const v of spec.kind === 'cad' ? [] : spec.kind === 'sheet' && wide ? [0.6, 2] : [2]) {
        await setScale(cdp, v);
        const actual = await page.evaluate(() => Math.round(visualViewport.scale * 100) / 100);
        if (Math.abs(actual - v) > 0.01) { problems.push(`[배율 ${v}] 배율이 ${actual}로 됨`); continue; }
        await inspect(`배율 ${v}`, { bar: true, atTop: true });
        await page.evaluate(() => document.getElementById('menu-btn').click());
        await page.waitForTimeout(250);
        await inspect(`배율 ${v} 메뉴`, { bar: true, atTop: true, menu: true });
        await shot(`배율${v}_메뉴`);
        await goBack();
        await page.waitForTimeout(200);
        // 확대한 채로 연 이미지로 변환 창도 화면 크기 그대로
        if (await page.evaluate(() => !document.getElementById('menu-export').hidden)) {
          await page.evaluate(() => { document.getElementById('menu-btn').click(); document.getElementById('menu-export').click(); });
          await page.waitForTimeout(500);
          await inspect(`배율 ${v} 이미지로`, { export: true });
          await shot(`배율${v}_이미지로`);
          await goBack();
          await page.waitForTimeout(200);
        }
        if (spec.kind === 'sheet') {
          const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab[data-i]')].length);
          if (tabs >= 2) {
            await page.evaluate(() => document.querySelectorAll('.tab[data-i]')[1].click());
            await page.waitForTimeout(500);
            const after = await page.evaluate(() => Math.round(visualViewport.scale * 100) / 100);
            if (Math.abs(after - v) > 0.01) problems.push(`[배율 ${v} 시트 바꾸기] 배율이 ${after}로 바뀜`);
            await inspect(`배율 ${v} 시트 바꾼 뒤`, { bar: true, atTop: true });
            await page.evaluate(() => document.querySelectorAll('.tab[data-i]')[0].click());
            await page.waitForTimeout(400);
          }
        }
        await setScale(cdp, 1);
      }
      await inspect('배율 되돌린 뒤', { bar: true, atTop: true, noOverflow });

      // 회전(세로 폰에서만): 조금 내려 읽다가 가로로 돌리고 다시 세로로. 보던 곳·배율이 그대로이고 바·메뉴가 화면에 맞아야 한다.
      if (screen.name === 'phone' && !dark && fontScale === 1) {
        const where = () => page.evaluate(() => {
          const pages = [...document.querySelectorAll('.page')];
          // 보이는 영역 맨 위 근처(화면 높이가 바뀌어도 같은 곳을 가리키게)
          const vy = visualViewport.offsetTop + Math.min(120, visualViewport.height * 0.25);
          if (pages.length) return { kind: '쪽', i: pages.findIndex((p) => p.getBoundingClientRect().bottom > vy) };
          const host = document.querySelector('.word-host, .slides-host');
          if (host) {
            const max = host.scrollHeight - host.clientHeight;
            return { kind: '비율', i: max > 0 ? Math.round((host.scrollTop / max) * 100) : 0 };
          }
          const rows = [...document.querySelectorAll('#doc tr[data-r]')];
          if (rows.length) { const r = rows.find((x) => x.getBoundingClientRect().bottom > vy); return { kind: '행', i: r ? Number(r.dataset.r) : -1 }; }
          const max = document.documentElement.scrollHeight - innerHeight;
          return { kind: '비율', i: max > 0 ? Math.round((scrollY / max) * 100) : 0 };
        });
        // 앱이 부탁받은 배율 되돌리기를 흉내 낸다(실제 앱은 웹뷰 zoomBy)
        const zoomFix = async () => {
          const f = await page.evaluate(() => { const v = window.__zoomReq; window.__zoomReq = null; return v; });
          if (f) await setScale(cdp, (await page.evaluate(() => visualViewport.scale)) * f);
        };
        await page.evaluate(() => {
          const host = document.querySelector('.word-host, .slides-host');
          if (host) host.scrollTop = (host.scrollHeight - host.clientHeight) * 0.4;
          else window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.4);
        });
        await page.waitForTimeout(600);
        const before = await where();
        const scale0 = await page.evaluate(() => visualViewport.scale);
        for (const [w, h, name] of [[screen.height, screen.width, '가로로 돌린 뒤'], [screen.width, screen.height, '세로로 되돌린 뒤']]) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(900);
          await zoomFix();
          const now = await where();
          const sc = await page.evaluate(() => visualViewport.scale);
          if (Math.abs(sc / scale0 - 1) > 0.02) problems.push(`[${name}] 배율이 ${scale0.toFixed(2)} → ${sc.toFixed(2)}로 바뀜`);
          const tol = before.kind === '비율' ? 6 : 1;
          const scrollable = await page.evaluate(() => { const host = document.querySelector('.word-host, .slides-host'); return host ? host.scrollHeight > host.clientHeight + 40 : document.documentElement.scrollHeight > innerHeight + 40; });
          if (scrollable && before.i >= 0 && (now.kind !== before.kind || Math.abs(now.i - before.i) > tol)) problems.push(`[${name}] 보던 곳이 바뀜 ${before.kind} ${before.i} → ${now.i}`);
          await inspect(name, { bar: true, noOverflow });
          if (spec.kind === 'cad') { const c = await cadFills(); if (c) problems.push(`[${name}] ${c}`); }
          await page.evaluate(() => document.getElementById('menu-btn').click());
          await page.waitForTimeout(250);
          await inspect(`${name} 메뉴`, { menu: true });
          await shot(name.replace(/ /g, ''));
          await goBack();
          await page.waitForTimeout(200);
        }
      }
    }
  } catch (e) {
    problems.push(`시험 중 오류: ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
  }
  for (const e of errors) problems.push(`스크립트 오류: ${e}`);
  await ctx.close();
  const ok = !problems.length;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${problems.join('\n      ')}`}`);
  if (!ok) fails.push({ label, problems });
}

const combos = [];
for (const spec of FILES) {
  for (const screen of process.env.QUICK ? SCREENS.slice(0, 1) : SCREENS) {
    for (const dark of process.env.QUICK ? [false] : [false, true]) combos.push([spec, screen, dark, 1]);
  }
  combos.push([spec, SCREENS[0], false, 1.3]);
}
for (const c of combos) await run(...c);

console.log(`\n조합 ${combos.length}개, 상태 ${states}개 확인. 실패 조합 ${fails.length}개`);
fs.rmSync(tmp, { recursive: true, force: true });
await browser.close();
process.exit(fails.length ? 1 : 0);
