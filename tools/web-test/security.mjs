// 악성 샘플을 열고 링크를 눌러 본 뒤, 스크립트가 실행됐는지·대화상자가 떴는지·외부 요청이 나갔는지 확인한다.
import { loadPlaywright } from './playwright.mjs';
const { chromium } = loadPlaywright();
const [,, port, dirArg] = process.argv;
const dir = (await import('node:path')).resolve(dirArg);
const base = `http://127.0.0.1:${port}`;
const cases = [['xss.xlsx', 'xss.xlsx'], ['xss.pptx', 'xss.pptx'], ['xss.csv', 'xss.csv'], ['xss-html.xls', 'xss-html.xls'],
  ['xss.docx', 'xss.docx'], ['xss.doc', 'xss.doc'], ['xss.pdf', 'xss.pdf'],
  // 긴 docx는 엔진 대신 빠른 읽기(docx-read.js)로 열리므로 따로 본다
  ['xss-long.docx', 'xss-long.docx'],
  // 간단 보기: 웹 페이지 .doc(HTML·MHT), RTF, ODT, Word 2003 XML
  ['xss-web.doc', 'xss-web.doc'], ['xss.mht.doc', 'report.doc'], ['xss.rtf', 'xss.rtf'], ['xss.odt', 'xss.odt'], ['xss-2003.xml', 'xss-2003.xml'],
  ['name.xlsx', '<img src=x onerror="window.__pwned=1">.xlsx']];
const b = await chromium.launch();
let bad = 0;
for (const [file, name] of cases) {
  await fetch(`${base}/__set?` + new URLSearchParams({ f: `${dir}/${file}`, name }));
  const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const dialogs = [], ext = [], navs = [], csp = [];
  p.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  p.on('request', r => { if (!r.url().startsWith(base) && !/^(blob|data):/.test(r.url())) ext.push(r.url()); });
  p.on('framenavigated', f => { if (f === p.mainFrame() && !f.url().startsWith(base)) navs.push(f.url()); });
  p.on('console', m => { if (/Content Security Policy|Refused/.test(m.text())) csp.push(m.text().slice(0, 90)); });
  await p.addInitScript(() => { window.__r = []; window.DocViewer = { report: s => window.__r.push(JSON.parse(s)), pickFile() {}, openElsewhere() {}, canOpenElsewhere: () => true }; });
  await p.goto(`${base}/viewer/index.html`);
  await p.waitForTimeout(2500);
  // 링크처럼 보이는 것은 모두 눌러 본다
  for (const a of await p.$$('a, .slides-host [href], .slides-host [role=link], .word-host [href], .word-host [role=link]')) { try { await a.click({ timeout: 1000 }); } catch {} }
  for (const t of ['자바스크립트 링크', '링크', '클릭']) { try { await p.click(`text=${t}`, { timeout: 800 }); } catch {} }
  await p.waitForTimeout(800);
  const pwned = await p.evaluate(() => !!window.__pwned).catch(() => 'page-gone');
  // 그림자 DOM(웹 페이지 .doc) 안까지 위험한 요소가 남았는지 센다.
  const injected = await p.evaluate(() => {
    const sel = 'img[src="x"], script, svg, iframe, object, embed, [onload], [onerror], [ontoggle], [href^="javascript:" i], [href^="data:" i], meta, base, link';
    let n = document.querySelectorAll('img[src="x"], script:not([src]), svg[onload]').length;
    for (const h of document.querySelectorAll('.webdoc-host')) if (h.shadowRoot) n += h.shadowRoot.querySelectorAll(sel).length;
    return n;
  }).catch(() => -1);
  const state = await p.evaluate(() => (window.__r.at(-1) || {}).state).catch(() => '?');
  const ok = !pwned && injected === 0 && !dialogs.length && !ext.length && !navs.length;
  if (!ok) bad++;
  console.log(`${ok ? 'SAFE' : 'UNSAFE'} ${file.padEnd(14)} state=${state} pwned=${pwned} injectedNodes=${injected} dialogs=${dialogs.length} external=${ext.length} navigations=${navs.join(',') || 0} cspBlocks=${csp.length}`);
  await ctx.close();
}
console.log(bad ? `문제 ${bad}건` : '모두 안전');
await b.close();
