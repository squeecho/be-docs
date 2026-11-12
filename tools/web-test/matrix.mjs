// manifest.tsv의 기대 결과대로 동작하는지 하나씩 확인한다(로컬 크롬).
// PDF는 pdf.js로 브라우저에서 그리므로 함께 확인한다. 내장 렌더러로 넘어가는 경우만 흉내 서버(pdftoppm)를 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright } from './playwright.mjs';
const { chromium } = loadPlaywright();
const [,, port, dirArg, shots] = process.argv;
// 서버가 다른 폴더에서 떠 있어도 찾을 수 있게 절대 경로로 넘긴다.
const dir = path.resolve(dirArg);
const rows = fs.readFileSync(`${dir}/manifest.tsv`, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'));
const base = `http://127.0.0.1:${port}`;
// CHROME=<실행 파일>: 오래된 크롬(업데이트 안 된 웹뷰 흉내)으로 돌린다. ONLY=<정규식>: 일부 파일만.
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ['--no-sandbox'] } : {});
console.log('browser', browser.version());
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
let pass = 0, fail = 0, skip = 0;
for (const [file, mime, expect, note, contains, maxMs] of rows) {
  if (only && !only.test(file)) continue;
  await fetch(`${base}/__set?` + new URLSearchParams({ f: `${dir}/${file}`, name: file }));
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true });
  const p = await ctx.newPage();
  const ext = []; p.on('request', r => { if (!r.url().startsWith(base) && !/^(blob|data):/.test(r.url())) ext.push(r.url()); });
  // pdf.js 등은 없는 기능 때문에 난 오류를 경고로 삼키고 빈 쪽을 그린다. 그런 흔적이 있으면 실패로 본다.
  const jsErrors = [];
  const isJsError = t => /TypeError|ReferenceError|SyntaxError|is not a function|is not defined|is not async iterable/.test(t);
  p.on('console', m => { if (isJsError(m.text())) jsErrors.push(m.text().split('\n')[0]); });
  p.on('pageerror', e => jsErrors.push(String(e).split('\n')[0]));
  await p.addInitScript(() => { window.__r = []; window.DocViewer = { report: s => window.__r.push(JSON.parse(s)), pickFile() {}, openElsewhere() {}, canOpenElsewhere: () => true }; });
  const t0 = Date.now();
  await p.goto(`${base}/viewer/index.html`);
  // 화면 스레드가 얼면 p.evaluate가 돌아오지 않아 시험기까지 멈춘다. 2초 안에 답이 없으면 언 것으로 보고 시계로 시간을 잰다.
  let frozen = false;
  const peek = () => Promise.race([p.evaluate(() => window.__r), new Promise((r) => setTimeout(() => r(null), 2000))]);
  const waitFor = async (states, ms = 45000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const list = await peek();
      frozen = list === null;
      const r = (list || []).find(x => states.includes(x.state));
      if (r) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  };
  let got = await waitFor(['rendered', 'error', 'password']);
  // 멈춤·느림도 결과로 본다: 끝 상태까지 걸린 시간이 허용 시간(maxMs)을 넘으면 실패.
  const tookMs = Date.now() - t0;
  const tooSlow = !!(maxMs && got && tookMs > Number(maxMs));
  if (!got) {
    // 끝 상태가 없으면(화면이 얼었으면 더 물어볼 수도 없다) 실패로 적고 다음 파일로 넘어간다.
    fail++;
    console.log(`FAIL  ${file.padEnd(32)} expect=${expect.padEnd(18)} got=${frozen ? 'FROZEN(화면 스레드 멈춤)' : 'TIMEOUT'}`);
    await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 5000))]);
    continue;
  }
  if (expect.startsWith('password:') && got && got.state === 'password') {
    await p.fill('.pw-form input', '0000'); await p.click('.pw-form button[type=submit]');
    await p.waitForSelector('text=비밀번호가 맞지 않아요', { timeout: 15000 }).catch(() => {});
    const wrongShown = await p.isVisible('text=비밀번호가 맞지 않아요');
    await p.fill('.pw-form input', expect.split(':')[1]); await p.click('.pw-form button[type=submit]');
    const r = await waitFor(['rendered', 'error']);
    got = r ? { ...r, wrongShown } : null;
  }
  await p.waitForTimeout(600);
  const hasContent = await p.evaluate(() => document.querySelectorAll('.page img, .page canvas, .sheet td, .slides-host div, .word-host canvas, .word-host span, .simple-doc .simple-p, .simple-doc img').length > 0
    || [...document.querySelectorAll('.webdoc-host')].some((h) => h.shadowRoot && h.shadowRoot.textContent.trim().length > 0)
    // CAD 도면: 캔버스에 바탕색이 아닌 점이 충분히 있어야 한다(그리기 목록은 있는데 화면이 비는 경우를 잡는다)
    || (() => {
      const c = document.querySelector('.cad-canvas');
      if (!c) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 64) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 40) n++;
      return n > 200;
    })());
  let ok;
  const [kind, sub] = expect.split(':');
  if (expect === 'no-hang') { /* 멈추지 않고 어떤 결과(오류·비밀번호 입력·표시)든 내면 통과 */ }
  if (kind === 'rendered') ok = got && got.state === 'rendered' && got.kind === sub && hasContent;
  else if (kind === 'password') ok = got && got.state === 'rendered' && got.wrongShown;
  else if (kind === 'error' && sub !== 'any') ok = got && got.state === 'error' && got.reason === sub;
  else if (expect === 'no-hang') ok = !!got;
  else ok = got && got.state === 'error';
  // PDF가 내장 렌더러로 넘어가면 도장·주석·비밀번호·글자 고르기가 빠진다. 정상 파일은 pdf.js로 그려져야 한다.
  if (kind === 'rendered' && sub === 'pdf' && got && got.engine !== 'pdfjs') ok = false;
  let textOk = true;
  if (ok && contains) {
    textOk = await p.evaluate((t) => document.body.textContent.includes(t)
      || [...document.querySelectorAll('.webdoc-host')].some((h) => h.shadowRoot && h.shadowRoot.textContent.includes(t)), contains);
    ok = textOk;
  }
  // 문서에 XML 문자 참조가 글자 그대로("&#x2022;") 보이면 실패: 엔진이 풀지 않은 값(PPT 글머리 기호 등)이 화면에 나온 것
  let refOk = true;
  if (ok && kind === 'rendered') {
    const raw = await p.evaluate(() => {
      const walk = document.createTreeWalker(document.getElementById('doc'), NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode());) if (/&#x?[0-9a-fA-F]+;/.test(n.nodeValue)) return n.nodeValue.trim().slice(0, 40);
      return '';
    });
    refOk = !raw;
    ok = refOk;
    if (raw) jsErrors.push(`문자 참조가 그대로 보임: ${raw}`);
  }
  // 여러 쪽 문서는 끝까지 넘겨 마지막 쪽에 닿는지 본다(그려지기만 하고 스크롤이 막힌 경우를 잡는다).
  let reachOk = true;
  if (ok && kind === 'rendered' && ['word', 'pdf', 'hwp'].includes(sub) && got.pages >= 2) {
    await p.evaluate(() => {
      const h = document.querySelector('.word-host');
      if (h) h.scrollTop = h.scrollHeight;
      else window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await p.waitForTimeout(1200);
    reachOk = await p.evaluate((pages) => {
      const h = document.querySelector('.word-host');
      if (h) {
        const last = h.querySelector(`[data-docx-page-index="${pages - 1}"]`);
        return h.scrollTop > 0 && !!last && last.getBoundingClientRect().top < h.getBoundingClientRect().bottom;
      }
      const all = document.querySelectorAll('.page');
      const last = all[all.length - 1];
      return window.scrollY > 0 && !!last && last.getBoundingClientRect().top < window.innerHeight;
    }, got.pages);
    ok = reachOk;
  }
  if (ext.length) ok = false;
  if (jsErrors.length) ok = false;
  if (tooSlow) ok = false;
  ok ? pass++ : fail++;
  await p.screenshot({ path: `${shots}/m-${file}.png` });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(32)} expect=${expect.padEnd(18)} got=${got ? got.state + (got.kind ? ':' + got.kind : '') : 'TIMEOUT'} ${got && got.message ? '| ' + got.message.slice(0, 40) : ''} ${ext.length ? 'EXTERNAL ' + ext[0] : ''}${textOk ? '' : ' TEXT-MISSING:' + contains}${reachOk ? '' : ' CANNOT-REACH-LAST-PAGE'}${jsErrors.length ? ' JS-ERROR: ' + jsErrors[0].slice(0, 120) : ''}${got && got.engine ? ' engine=' + got.engine : ''}${tooSlow ? ` TOO-SLOW: ${tookMs}ms > ${maxMs}ms` : ''}`);
  await ctx.close();
}
console.log(`\n합계: 통과 ${pass}, 실패 ${fail}`);
await browser.close();
process.exitCode = fail ? 1 : 0; // 셸·CI에서 실패를 알 수 있게
