// 전수 테스트: 파일 목록을 여러 작업자로 나눠 뷰어에 하나씩 열고 결과를 분류한다.
// 분류: rendered(내용 확인됨) / rendered-empty(보고는 성공인데 내용 없음) / error(안내 표시) / password / hang(시간 초과)
// 외부 주소로 나간 요청, 콘솔 오류, 처리되지 않은 예외도 함께 기록한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright } from './playwright.mjs';
const { chromium } = loadPlaywright();

const [,, assets, vendor, listFile, outFile, workersArg = '4', vp = 'phone'] = process.argv;
const files = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
const W = Number(workersArg);
const viewports = { phone: { width: 412, height: 915 }, fold: { width: 884, height: 1104 } };
const server = new URL('./server.mjs', import.meta.url).pathname;
const procs = [];
for (let w = 0; w < W; w++) procs.push(spawn('node', [server, assets, vendor, String(8800 + w)], { stdio: 'ignore' }));
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch();
const out = fs.createWriteStream(outFile);
let done = 0;

async function runOne(port, file) {
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/__set?` + new URLSearchParams({ f: file, name: path.basename(file) }));
  const ctx = await browser.newContext({ viewport: viewports[vp], deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [], external = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('request', r => { const u = r.url(); if (!u.startsWith(base) && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u.slice(0, 120)); });
  page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.addInitScript(() => { window.__r = []; window.DocViewer = { report: s => window.__r.push(JSON.parse(s)), pickFile() {}, openElsewhere() {}, canOpenElsewhere: () => true }; });
  const t0 = Date.now();
  let final = null;
  try {
    await page.goto(`${base}/viewer/index.html`, { timeout: 20000 });
    for (let i = 0; i < 300 && !final; i++) {
      await page.waitForTimeout(100);
      const reps = await page.evaluate(() => window.__r);
      final = reps.find(r => ['rendered', 'error', 'password'].includes(r.state));
    }
  } catch (e) { errors.push('harness: ' + e.message.slice(0, 120)); }
  const ms = Date.now() - t0;
  let content = null;
  const probe = () => page.evaluate(() => {
      const imgs = [...document.querySelectorAll('.page img')];
      const okImgs = imgs.filter(i => i.complete && i.naturalWidth > 0).length
        + [...document.querySelectorAll('.page canvas')].filter(c => c.width > 0).length;
      const pageErrors = document.querySelectorAll('.page-error').length;
      const cells = [...document.querySelectorAll('.sheet td')].filter(td => td.textContent.trim()).length;
      const host = document.querySelector('.slides-host');
      const slideText = host ? host.innerText.trim().length : 0;
      const slideNodes = host ? host.querySelectorAll('svg, img, canvas, p, span, div').length : 0;
      const word = document.querySelector('.word-host');
      const wordText = word ? word.innerText.trim().length : 0;
      const wordNodes = word ? word.querySelectorAll('canvas, img, svg, span, p').length : 0;
      const simple = document.querySelector('.simple-doc');
      const web = document.querySelector('.webdoc-host');
      const simpleText = simple ? simple.innerText.trim().length : web && web.shadowRoot ? web.shadowRoot.textContent.trim().length : 0;
      return { okImgs, pageErrors, cells, slideText, slideNodes, wordText, wordNodes, simpleText, reports: window.__r.filter(r => r.state === 'page-error').length };
    });
  if (final && final.state === 'rendered') {
    // 내용이 보일 때까지 최대 10초 기다린다(무거운 페이지는 이미지 해석에 시간이 걸린다).
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      content = await probe();
      if (content.okImgs > 0 || content.cells > 0 || content.slideNodes > 0 || content.wordNodes > 0 || content.simpleText > 0 || content.pageErrors > 0) break;
    }
  }
  let cls = !final ? 'hang' : final.state;
  if (cls === 'rendered') {
    const c = content;
    const k = final.kind;
    const hasContent = (k === 'hwp' || k === 'pdf') ? c.okImgs > 0 : k === 'sheet' ? c.cells > 0 : k === 'word' ? c.wordNodes > 0 : k === 'simple' ? c.simpleText > 0 : c.slideNodes > 0;
    if (!hasContent) cls = 'rendered-empty';
    else if (c.pageErrors || c.reports) cls = 'rendered-partial';
  }
  const rec = { file: path.relative(path.dirname(listFile), file), cls, kind: final && final.kind, pages: final && (final.pages ?? final.sheets), ms, msg: final && final.state === 'error' ? (final.message + ' ' + (final.detail || '')).replace(/\s+/g, ' ').slice(0, 160) : undefined, content, errors: errors.slice(0, 3), external: external.slice(0, 3) };
  out.write(JSON.stringify(rec) + '\n');
  await ctx.close();
  done++;
  if (done % 25 === 0) console.log(`${done}/${files.length}`);
}

const queue = [...files];
await Promise.all(Array.from({ length: W }, (_, w) => (async () => {
  for (let f; (f = queue.shift()); ) await runOne(8800 + w, f);
})()));
out.end();
await browser.close();
procs.forEach(p => p.kill());
