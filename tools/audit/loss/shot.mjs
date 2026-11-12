// 증거 스크린샷: 파일을 열고 원하는 시트·슬라이드·쪽으로 옮겨 찍는다.
// node shot.mjs --viewer <viewer 폴더> --port 8941 --file <파일> --out <png>
//               [--tab <시트 이름>] [--slide <0부터>] [--page <0부터>] [--word-page <0부터>] [--scroll-x <px>] [--wait <ms>]
//               [--word-page-bottom <N>] [--width 412 --height 915] [--clip-cell <N>] (엑셀: 말줄임으로 잘린 N번째 칸으로 이동해 빨간 테두리)
// --port 의 흉내 서버는 이 스크립트가 띄우고 끝나면 끈다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadPlaywright } from '../../web-test/playwright.mjs';
const { chromium } = loadPlaywright();
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => { if (x.startsWith('--')) acc.push([x.slice(2), arr[i + 1]]); return acc; }, []));
const viewer = path.resolve(a.viewer);
const port = Number(a.port || 8941);
const srv = spawn('node', [new URL('../../web-test/server.mjs', import.meta.url).pathname, viewer, path.join(viewer, 'vendor'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await fetch(`${base}/__set?` + new URLSearchParams({ f: path.resolve(a.file), name: path.basename(a.file) }));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: Number(a.width || 412), height: Number(a.height || 915) }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.__r = []; window.DocViewer = { report: (s) => window.__r.push(JSON.parse(s)), pickFile() {}, openElsewhere() {}, canOpenElsewhere: () => true }; });
  await p.goto(`${base}/viewer/index.html`);
  let fin = null;
  for (let i = 0; i < 900 && !fin; i++) { await sleep(200); fin = (await p.evaluate(() => window.__r)).find((r) => ['rendered', 'error', 'password'].includes(r.state)); }
  await sleep(Number(a.wait || 2000));
  if (a.tab) {
    await p.evaluate((t) => { const b = [...document.querySelectorAll('#tabs .tab')].find((x) => x.textContent === t); if (b) { b.click(); b.scrollIntoView({ inline: 'center' }); } }, a.tab);
    await sleep(1200);
  }
  if (a.slide) {
    for (let k = 0; k < 200; k++) {
      const found = await p.evaluate((i) => { const el = document.querySelector(`[data-rpv-list-item="${i}"]`); if (el) { el.scrollIntoView({ block: 'start' }); return true; } const v = document.querySelector('.rpv-viewport'); v.scrollTop += v.clientHeight * 0.6; return false; }, Number(a.slide));
      await sleep(300);
      if (found) break;
    }
    await sleep(1500);
  }
  if (a.page) { await p.evaluate((i) => document.querySelectorAll('#doc .page')[i].scrollIntoView({ block: 'start' }), Number(a.page)); await sleep(3000); }
  if (a['word-page']) { await p.evaluate((i) => { const el = document.querySelector(`[data-docx-page-index="${i}"]`); if (el) el.scrollIntoView({ block: 'start' }); }, Number(a['word-page'])); await sleep(1500); }
  if (a['word-page-bottom']) {
    // N번째 쪽의 아래 끝(쪽 밖으로 잘리는 곳)이 화면 가운데 오게 옮긴다
    await p.evaluate((i) => {
      const el = document.querySelector(`[data-docx-page-index="${i}"] [data-docx-page-surface]`) || document.querySelector(`[data-docx-page-index="${i}"]`);
      el.scrollIntoView({ block: 'end' });
      let sc = el.parentElement;
      while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
      if (sc) sc.scrollTop += sc.clientHeight / 2;
    }, Number(a['word-page-bottom']));
    await sleep(1200);
  }
  if (a['clip-cell']) {
    // 말줄임(…)으로 잘린 칸 중 N번째(0부터)로 화면을 옮기고 그 칸 글자 길이를 출력한다
    const info = await p.evaluate((n) => {
      const w = document.querySelector('#doc .sheet');
      const tds = [...w.querySelectorAll('td')].filter((td) => td.textContent.length >= 6 && td.scrollWidth > td.clientWidth + 1);
      const td = tds[Number(n)] || tds[0];
      if (!td) return null;
      td.style.outline = '3px solid red';
      const r = td.getBoundingClientRect();
      td.scrollIntoView({ block: 'center', inline: r.width > window.innerWidth ? 'start' : 'end' });
      return { total: tds.length, len: td.textContent.length, text: td.textContent.slice(0, 200) };
    }, a['clip-cell']);
    console.log('clip-cell', JSON.stringify(info));
    await sleep(600);
  }
  if (a['scroll-x']) { await p.evaluate((x) => window.scrollTo(Number(x), window.scrollY), a['scroll-x']); await sleep(500); }
  await p.screenshot({ path: a.out });
  console.log(JSON.stringify(fin), a.out);
  await browser.close();
} finally {
  srv.kill();
}
