// be docs 뷰어 견고성·성능 감사용 공통 도구.
// - 흉내 서버(server.mjs)를 포트별로 띄우고, 파일 하나를 열어 상태·긴 작업(longtask)·화면 내용을 잰다.
// - 상태 보고·긴 작업·심장 박동(250ms)을 console.debug로 흘려보내므로, 화면 스레드가 멈춰도
//   멈추기 전까지의 기록은 그대로 남고 "언제부터 멈췄는지"를 알 수 있다.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from '../../web-test/playwright.mjs';

export const { chromium } = loadPlaywright();
export const R = path.dirname(new URL(import.meta.url).pathname);
// 결과·임시 파일 폴더(OUT), 검사할 뷰어 폴더(SNAP, 기본은 저장소의 뷰어), 흉내 서버(SERVER)
export const S = process.env.OUT || path.join(os.tmpdir(), 'bedocs-robust');
export const SNAP = process.env.SNAP || path.resolve(R, '../../../app/src/main/assets/viewer');
export const SERVER = process.env.SERVER || path.resolve(R, '../../web-test/server.mjs');
// 오래된 크롬(업데이트 안 된 웹뷰 흉내): CHROME_C103=<실행 파일> 처럼 환경 변수로 준다.
export const ENGINES = {
  local: null,
  c103: process.env.CHROME_C103,
  c106: process.env.CHROME_C106,
  c109: process.env.CHROME_C109,
  c113: process.env.CHROME_C113,
};
export const TERMINAL = ['rendered', 'error', 'password'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 허용된 포트(8951~8959)만 쓴다.
export function checkPort(p) {
  if (!(p >= 8951 && p <= 8959)) throw new Error(`port ${p} not allowed (8951-8959)`);
}

const servers = new Map();
export async function startServer(port, snap = SNAP) {
  checkPort(port);
  const proc = spawn('node', [SERVER, snap, `${snap}/vendor`, String(port)], { stdio: 'ignore' });
  servers.set(port, proc);
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/doc/info`); if (r.ok) return proc; } catch { /* 아직 */ }
    await sleep(100);
  }
  throw new Error(`server ${port} did not start`);
}
export function stopServers() { for (const p of servers.values()) { try { p.kill(); } catch { /* */ } } servers.clear(); }
process.on('exit', stopServers);
process.on('SIGINT', () => { stopServers(); process.exit(130); });
process.on('SIGTERM', () => { stopServers(); process.exit(143); });

export async function launch(engine = 'local') {
  const exe = ENGINES[engine];
  if (engine !== 'local' && !exe) throw new Error(`unknown engine ${engine}`);
  return chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {});
}

// ---- 프로세스 단위 감속(작업 스레드 포함): 렌더러 프로세스를 SIGSTOP/SIGCONT로 번갈아 멈춘다.
// CDP Emulation.setCPUThrottlingRate는 화면 스레드만 느리게 하고 작업 스레드(HWP·pdf.js·큰 엑셀 해석)는 그대로다.
function procTable() {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 1 << 26 }).toString();
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], args: m[3] }));
}
function descendants(root, table = procTable()) {
  const kids = new Map();
  for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = []; const st = [root];
  while (st.length) { const x = st.pop(); for (const k of kids.get(x) || []) { out.push(k); st.push(k.pid); } }
  return out;
}
export async function launchTracked(engine = 'local') {
  const before = new Set(descendants(process.pid).map((p) => p.pid));
  const b = await launch(engine);
  const main = descendants(process.pid).find((p) => !before.has(p.pid) && !/--type=/.test(p.args) && /chrom|headless_shell/i.test(p.args));
  b.__pid = main ? main.pid : null;
  return b;
}
export function rendererPids(browserPid) {
  return descendants(browserPid).filter((p) => /--type=renderer/.test(p.args) && !/--extension-process/.test(p.args)).map((p) => p.pid);
}
function signal(pids, sig) { for (const p of pids) { try { process.kill(p, sig); } catch { /* 이미 없음 */ } } }
export function procThrottle(browserPid, factor, period = 60) {
  let on = true; let pids = [];
  const loop = (async () => {
    for (let n = 0; on; n++) {
      if (n % 5 === 0) pids = rendererPids(browserPid);
      signal(pids, 'SIGCONT');
      await sleep(period / factor);
      if (!on) break;
      signal(pids, 'SIGSTOP');
      await sleep((period * (factor - 1)) / factor);
    }
    signal(pids, 'SIGCONT');
  })();
  return async () => { on = false; await loop; signal(rendererPids(browserPid), 'SIGCONT'); };
}

// 페이지 시작 전에 넣는 감시 코드
function initScript() {
  window.__r = [];
  const dbg = console.debug.bind(console); // 뷰어가 콘솔 개수를 줄여도 기록은 남게 미리 잡아 둔다
  const now = () => Math.round(performance.now());
  window.DocViewer = {
    report: (s) => {
      let o;
      try { o = JSON.parse(s); } catch (e) { o = { state: 'bad-report', raw: String(s).slice(0, 200) }; }
      o.t = now();
      window.__r.push(o);
      const c = { ...o };
      for (const k of Object.keys(c)) if (typeof c[k] === 'string' && c[k].length > 400) c[k] = c[k].slice(0, 400) + '…';
      dbg('__R' + JSON.stringify(c));
    },
    pickFile() {}, openElsewhere() { dbg('__OE'); }, canOpenElsewhere: () => true,
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) dbg('__LT' + JSON.stringify([Math.round(e.startTime), Math.round(e.duration)]));
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { dbg('__NOLT' + e); }
  setInterval(() => dbg('__HB' + now()), 250);
  // HWP 쪽 SVG를 나중에 검사할 수 있게 붙잡아 둔다(CSP 때문에 blob 주소를 fetch할 수 없다)
  window.__svg = [];
  const oc = URL.createObjectURL;
  URL.createObjectURL = function (b) {
    const u = oc.call(URL, b);
    try { if (b && b.type === 'image/svg+xml' && window.__svg.length < 3) window.__svg.push([u, b]); } catch (e) { /* */ }
    return u;
  };
}

// 화면 내용 검사: 글자 품질(대체 문자·제어 문자·사용자 영역 글자), 가장 긴 글자 덩어리, 문서 크기
async function probeScript() {
  const out = {};
  const doc = document.getElementById('doc');
  const notice = document.getElementById('notice');
  out.notice = notice && !notice.hidden ? notice.innerText.replace(/\s+/g, ' ').slice(0, 200) : '';
  out.docClass = doc ? doc.className : '';
  out.nodes = document.getElementsByTagName('*').length;
  out.scrollW = document.documentElement.scrollWidth;
  out.scrollH = document.documentElement.scrollHeight;
  out.vw = window.innerWidth;
  out.pages = document.querySelectorAll('.page').length;
  out.imgs = [...document.querySelectorAll('.page img')].filter((i) => i.complete && i.naturalWidth > 0).length;
  out.canvases = [...document.querySelectorAll('.page canvas')].filter((c) => c.width > 0).length;
  out.pageErrors = document.querySelectorAll('.page-error').length;
  out.cells = document.querySelectorAll('.sheet td').length;
  out.tabs = [...document.querySelectorAll('.tab')].map((t) => t.textContent.slice(0, 40));
  out.tabsMaxLen = Math.max(0, ...[...document.querySelectorAll('.tab')].map((t) => t.textContent.length));
  out.titleW = (document.getElementById('title') || {}).scrollWidth || 0;
  const ratios = [...document.querySelectorAll('.page')].slice(0, 2000).map((p) => {
    const r = p.getBoundingClientRect(); return r.height ? r.width / r.height : 0;
  });
  out.pageRatioMin = ratios.length ? Math.min(...ratios) : null;
  out.pageRatioMax = ratios.length ? Math.max(...ratios) : null;
  // 글자 모으기(문서 영역만, 최대 200만 자)
  const texts = [];
  let budget = 2e6;
  const walk = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (w.nextNode() && budget > 0) {
      const v = w.currentNode.nodeValue;
      if (!v) continue;
      texts.push(v.length > budget ? v.slice(0, budget) : v);
      budget -= v.length;
    }
    for (const h of root.querySelectorAll ? root.querySelectorAll('.webdoc-host') : []) if (h.shadowRoot) walk(h.shadowRoot);
  };
  if (doc) walk(doc);
  let maxRun = 0;
  for (const el of doc ? doc.querySelectorAll('*') : []) {
    if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) maxRun = Math.max(maxRun, el.firstChild.nodeValue.length);
  }
  for (const t of texts) maxRun = Math.max(maxRun, t.length);
  // HWP 쪽 SVG 안의 글자도 본다(첫 2쪽)
  const svgTexts = [];
  for (const [, blob] of (window.__svg || []).slice(0, 2)) {
    try {
      const svg = await blob.text();
      out.svgBytes = (out.svgBytes || 0) + svg.length;
      const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
      for (const t of d.querySelectorAll('text, tspan')) if (!t.children.length) svgTexts.push(t.textContent);
    } catch (e) { out.svgErr = String(e).slice(0, 80); }
  }
  const all = texts.join('') + svgTexts.join('');
  let bad = 0, ctrl = 0, pua = 0, letters = 0;
  for (const ch of all) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd) bad++;
    else if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c < 0xa0)) ctrl++;
    else if ((c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000) pua++;
    if (!/\s/.test(ch)) letters++;
  }
  out.textLen = all.length;
  out.letters = letters;
  out.bad = bad; out.ctrl = ctrl; out.pua = pua;
  out.maxRun = maxRun;
  out.sample = all.replace(/\s+/g, ' ').slice(0, 160);
  out.textLayer = [...document.querySelectorAll('.textLayer')].reduce((n, l) => n + l.textContent.length, 0);
  out.slideNodes = (document.querySelector('.slides-host') || { querySelectorAll: () => [] }).querySelectorAll('svg, img, canvas, p, span, div').length;
  out.wordNodes = (document.querySelector('.word-host') || { querySelectorAll: () => [] }).querySelectorAll('canvas, img, svg, span, p').length;
  return out;
}

export function withTimeout(p, ms, label = 'timeout') {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); })]).finally(() => clearTimeout(t));
}

/**
 * 파일 하나를 열어 잰다.
 * opts: { port, browser, file, name, throttle=1, budget=60000, settle=2500, viewport, shot, profile, probe=true }
 */
export async function runOne(opts) {
  const { port, browser, file } = opts;
  const name = opts.name ?? path.basename(file);
  const throttle = opts.throttle || 1;
  const budget = opts.budget || 60000;
  const settle = opts.settle ?? 2500;
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/__set?` + new URLSearchParams({ f: file, name }));
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const rec = { file, name, throttle, reports: [], lt: [], pageErrors: [], consoleErrors: [], external: [], crashed: false };
  let lastHB = 0; let hbCount = 0; let terminal = null; let terminalWall = 0;
  const t0 = Date.now();
  page.on('console', (m) => {
    const tx = m.text();
    if (tx.startsWith('__R')) {
      try {
        const o = JSON.parse(tx.slice(3)); rec.reports.push(o);
        if (!terminal && TERMINAL.includes(o.state)) { terminal = o; terminalWall = Date.now(); }
      } catch { /* */ }
    } else if (tx.startsWith('__LT')) { try { rec.lt.push(JSON.parse(tx.slice(4))); } catch { /* */ } }
    else if (tx.startsWith('__HB')) { lastHB = Number(tx.slice(4)); hbCount++; }
    else if (tx.startsWith('__NOLT')) rec.noLongtask = tx;
    else if (m.type() === 'error') { if (rec.consoleErrors.length < 8) rec.consoleErrors.push(tx.split('\n')[0].slice(0, 240)); }
    else if (m.type() === 'warning' && /TypeError|RangeError|ReferenceError|Maximum call stack|out of memory|unreachable|panicked/i.test(tx)) {
      if (rec.consoleErrors.length < 8) rec.consoleErrors.push('warn: ' + tx.split('\n')[0].slice(0, 240));
    }
  });
  page.on('pageerror', (e) => { if (rec.pageErrors.length < 8) rec.pageErrors.push(String(e && e.message || e).split('\n')[0].slice(0, 240)); });
  page.on('crash', () => { rec.crashed = true; });
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(base) && !/^(blob|data):/.test(u)) rec.external.push(u.slice(0, 120)); });
  page.on('dialog', (d) => { rec.pageErrors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  await page.addInitScript(initScript);
  let stopProc = null;
  if (opts.procThrottle > 1) {
    if (!browser.__pid) throw new Error('procThrottle needs launchTracked()');
    stopProc = procThrottle(browser.__pid, opts.procThrottle);
    rec.procThrottle = opts.procThrottle;
  }
  let cdp = null;
  try {
    cdp = await ctx.newCDPSession(page);
    if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    if (opts.profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: opts.profileInterval || 2000 });
      await cdp.send('Profiler.start');
    }
  } catch (e) { rec.cdpErr = String(e).slice(0, 120); }
  try {
    await withTimeout(page.goto(`${base}/viewer/index.html`, { waitUntil: 'commit', timeout: 30000 }), 35000, 'goto-timeout');
  } catch (e) { rec.harness = 'goto: ' + String(e.message).slice(0, 100); }
  // 끝 상태(rendered·error·password)까지 기다린다
  while (!terminal && !rec.crashed && Date.now() - t0 < budget) await sleep(100);
  // 끝 상태 뒤의 배치·그리기(긴 작업)까지 지켜본다: 끝 상태 뒤 settle ms 동안 심장 박동이 이어지면 안정된 것
  if (terminal && !rec.crashed) {
    const until = Date.now() + Math.max(budget - (Date.now() - t0), 15000);
    while (!rec.crashed && Date.now() < until) {
      if (lastHB >= terminal.t + settle) break;
      await sleep(100);
    }
  }
  if (stopProc) await stopProc();
  rec.wall = Date.now() - t0;
  rec.state = terminal ? terminal.state : (rec.crashed ? 'crash' : 'hang');
  rec.terminal = terminal;
  rec.tTerminal = terminal ? terminal.t : null;
  rec.lastHB = lastHB; rec.hbCount = hbCount;
  // 멈춤: 마지막 심장 박동 이후 지금까지(페이지 시각 기준 근사)
  const pageNowApprox = lastHB + (Date.now() - (terminalWall || t0)) * 0; // 참고용
  void pageNowApprox;
  rec.lt.sort((a, b) => a[0] - b[0]);
  const lts = rec.lt;
  rec.maxLT = lts.reduce((m, x) => Math.max(m, x[1]), 0);
  rec.tbt = lts.reduce((s, x) => s + Math.max(0, x[1] - 50), 0);
  rec.ltSum = lts.reduce((s, x) => s + x[1], 0);
  rec.ltCount = lts.length;
  if (terminal) {
    const after = lts.filter((x) => x[0] + x[1] > terminal.t);
    rec.maxLTafter = after.reduce((m, x) => Math.max(m, x[1]), 0);
    // 쓸 수 있게 된 때: 끝 상태 이후 마지막 긴 작업이 끝난 때(끝 상태 + 5초 안에 시작한 것)
    const tail = lts.filter((x) => x[0] <= terminal.t + 5000 && x[0] + x[1] > terminal.t);
    rec.tUsable = tail.length ? Math.max(terminal.t, ...tail.map((x) => x[0] + x[1])) : terminal.t;
  }
  // 응답 없는 상태로 끝났는지: 끝 상태를 못 냈고 심장 박동이 오래 끊김
  // (첫 심장 박동 전에 멈춘 경우도 포함: lastHB=0)
  rec.stuckMain = !terminal && !rec.crashed ? (Date.now() - t0) - lastHB : null;
  if (opts.probe !== false && !rec.crashed) {
    try { rec.content = await withTimeout(page.evaluate(probeScript), 15000, 'probe-timeout'); }
    catch (e) { rec.probeErr = String(e.message).slice(0, 100); }
  }
  if (opts.shot && !rec.crashed) {
    try { await withTimeout(page.screenshot({ path: opts.shot }), 15000, 'shot-timeout'); } catch (e) { rec.shotErr = String(e.message).slice(0, 80); }
  }
  if (opts.profile && cdp) {
    try {
      const { profile } = await withTimeout(cdp.send('Profiler.stop'), 30000, 'profile-timeout');
      rec.profileTop = summarizeProfile(profile);
      if (opts.profileOut) fs.writeFileSync(opts.profileOut, JSON.stringify(profile));
    } catch (e) { rec.profileErr = String(e.message).slice(0, 100); }
  }
  if (opts.keepOpen) { rec._page = page; rec._ctx = ctx; return rec; }
  try { await withTimeout(ctx.close(), 20000, 'close-timeout'); } catch (e) { rec.closeErr = String(e.message); }
  return rec;
}

// CPU 프로필에서 자기 시간(self time)이 큰 함수와 파일별 합계
export function summarizeProfile(profile) {
  const { nodes, samples, timeDeltas } = profile;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) || 0) + (timeDeltas[i] || 0));
  const fn = new Map(); const file = new Map();
  for (const [id, us] of self) {
    const n = byId.get(id); if (!n) continue;
    const cf = n.callFrame;
    const f = (cf.url || '').split('/').pop() || `(${cf.functionName || 'native'})`;
    const key = `${cf.functionName || '(anon)'} @ ${f}:${cf.lineNumber + 1}`;
    fn.set(key, (fn.get(key) || 0) + us);
    file.set(f, (file.get(f) || 0) + us);
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, us]) => [n, Math.round(us / 1000)]);
  return { files: top(file, 8), funcs: top(fn, 15) };
}

// 결과 분류(흔한 판정)
export function classify(rec, { freezeMs = 2000, ttcMs = 20000 } = {}) {
  const flags = [];
  if (rec.crashed) flags.push('CRASH');
  if (rec.state === 'hang') flags.push(rec.stuckMain != null && rec.stuckMain > 5000 ? 'HANG-MAIN-FROZEN' : 'HANG');
  if (rec.maxLT > freezeMs) flags.push(`FREEZE>${freezeMs / 1000}s`);
  if (rec.tTerminal != null && rec.tTerminal > ttcMs) flags.push(`SLOW>${ttcMs / 1000}s`);
  if (rec.pageErrors.length) flags.push('PAGEERROR');
  if (rec.external.length) flags.push('EXTERNAL');
  const c = rec.content;
  if (rec.state === 'rendered' && c) {
    const k = rec.terminal.kind;
    const has = (k === 'hwp' || k === 'pdf') ? (c.imgs + c.canvases) > 0 : k === 'sheet' ? c.cells > 0 : k === 'word' ? c.wordNodes > 0 : k === 'slides' ? c.slideNodes > 0 : c.letters > 0;
    if (!has) flags.push('RENDERED-EMPTY');
    const junk = c.bad + c.ctrl + c.pua;
    if (c.letters > 40 && junk / Math.max(1, c.letters) > 0.25) flags.push('GARBAGE-CHARS');
    if (c.maxRun > 50000) flags.push('ABSURD-STRING');
    if (c.scrollW > 60000 || c.scrollH > 3e6) flags.push('GIANT-LAYOUT');
    if (c.tabsMaxLen > 31) flags.push('LONG-TAB');
    if (c.pageRatioMin != null && (c.pageRatioMin < 0.02 || c.pageRatioMax > 50)) flags.push('ODD-PAGE-SHAPE');
    if (c.nodes > 300000) flags.push('DOM-HUGE');
  }
  return flags;
}

// 간단한 작업 풀: ports 수만큼 동시에 돌린다
export async function pool(items, ports, worker) {
  const q = [...items];
  await Promise.all(ports.map(async (port) => {
    for (let it; (it = q.shift()) !== undefined;) await worker(it, port);
  }));
}

export function slimRecord(rec) {
  const { _page, _ctx, ...r } = rec;
  r.reports = r.reports.map((o) => { const c = { ...o }; for (const k of ['tech', 'detail']) if (c[k] && c[k].length > 160) c[k] = c[k].slice(0, 160); return c; });
  r.ltTop = [...r.lt].sort((a, b) => b[1] - a[1]).slice(0, 6);
  delete r.lt;
  return r;
}
