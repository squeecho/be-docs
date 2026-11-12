// 변형 파일 일괄 실행·분류. mutate.py가 만든 manifest.jsonl을 읽는다.
// node fuzz.mjs <manifest.jsonl> <out.jsonl> [--budget 30000] [--ports 8951,8952] [--mode none|cdp:6|proc:6]
//              [--engine local|c109|c113] [--only 정규식] [--repro dir]
// 분류(flags): HANG(끝 상태 없음) / HANG-MAIN-FROZEN(화면 스레드까지 멈춤) / CRASH(렌더러 죽음) / PAGEERROR(처리 안 된 예외)
//   FREEZE>Ns(한 번에 N초 넘게 화면 멈춤) / GARBAGE-CHARS·ABSURD-STRING·GIANT-LAYOUT·LONG-TAB·ODD-PAGE-SHAPE(이상한 내용)
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServers, launchTracked, runOne, classify, slimRecord, pool } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const [manifest, outFile] = args;
const budget = Number(opt('budget', 30000));
const ports = opt('ports', '8951,8952').split(',').map(Number);
const mode = opt('mode', 'none');
const engine = opt('engine', 'local');
const reproDir = opt('repro');
const freezeMs = Number(opt('freeze', 1000));
const only = opt('only') ? new RegExp(opt('only')) : null;
const done = new Set();
if (fs.existsSync(outFile)) for (const l of fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) done.add(JSON.parse(l).file);
let items = fs.readFileSync(manifest, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (only) items = items.filter((m) => only.test(m.file) || only.test(m.op));
items = items.filter((m) => !done.has(m.file));
const [mk, mr] = mode.split(':');
const rate = Number(mr || 1);
const out = fs.createWriteStream(outFile, { flags: 'a' });
const browsers = new Map();
for (const p of ports) { await startServer(p); browsers.set(p, await launchTracked(engine)); }
console.log(`fuzz: ${items.length} mutants budget=${budget} mode=${mode} engine=${engine}`);
let n = 0;
await pool(items, ports, async (m, port) => {
  let browser = browsers.get(port);
  if (!browser.isConnected()) { browser = await launchTracked(engine); browsers.set(port, browser); }
  let rec;
  try {
    rec = await runOne({ port, browser, file: m.file, name: m.name, budget, settle: 2000, throttle: mk === 'cdp' ? rate : 1, procThrottle: mk === 'proc' ? rate : 0 });
  } catch (e) {
    rec = { file: m.file, state: 'harness-error', error: String(e.message || e).slice(0, 200), reports: [], lt: [], pageErrors: [], consoleErrors: [], external: [] };
  }
  if (rec.closeErr || rec.state === 'harness-error' || rec.crashed) {
    // 멈춘 페이지를 못 닫았으면 브라우저를 새로 띄운다
    try { await browser.close(); } catch { /* */ }
    browsers.set(port, await launchTracked(engine));
  }
  const flags = rec.state === 'harness-error' ? ['HARNESS'] : classify(rec, { freezeMs });
  const r = slimRecord(rec);
  const t = r.terminal || {};
  const row = {
    file: m.file, seed: m.seed, op: m.op, size: m.size, mode, engine, state: r.state, kind: t.kind || (r.reports.find((x) => x.kind) || {}).kind,
    reason: t.reason, msg: t.message, tech: t.tech && t.tech.slice(0, 200), tTerminal: r.tTerminal, maxLT: r.maxLT, tbt: r.tbt, stuckMain: r.stuckMain,
    flags, pageErrors: r.pageErrors, consoleErrors: r.consoleErrors.slice(0, 3), crashed: r.crashed, closeErr: r.closeErr,
    reports: r.reports.map((o) => [o.t, o.state, o.kind || o.reason || o.format || '']),
    content: r.content && { notice: r.content.notice && r.content.notice.slice(0, 120), letters: r.content.letters, bad: r.content.bad, ctrl: r.content.ctrl, pua: r.content.pua, maxRun: r.content.maxRun, scrollW: r.content.scrollW, scrollH: r.content.scrollH, nodes: r.content.nodes, pages: r.content.pages, cells: r.content.cells, tabs: r.content.tabs.slice(0, 4), sample: r.content.sample && r.content.sample.slice(0, 100) },
  };
  out.write(JSON.stringify(row) + '\n');
  if (reproDir && flags.some((f) => /HANG|CRASH|PAGEERROR|FREEZE|GARBAGE|ABSURD|GIANT|LONG-TAB|ODD/.test(f))) {
    fs.mkdirSync(reproDir, { recursive: true });
    try { fs.copyFileSync(m.file, path.join(reproDir, path.basename(m.file))); } catch { /* */ }
  }
  n++;
  console.log(`[${n}/${items.length}] ${String(row.state).padEnd(8)} ${String(row.reason || row.kind || '').padEnd(9)} t=${String(row.tTerminal).padStart(6)} maxLT=${String(row.maxLT).padStart(6)} ${flags.join(',')} ${path.basename(m.file)}`);
});
out.end();
for (const b of browsers.values()) { try { await b.close(); } catch { /* */ } }
stopServers();
