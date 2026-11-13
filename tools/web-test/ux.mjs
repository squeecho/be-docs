// 사용성 검사: "그려졌는가"만 보는 매트릭스가 놓치는 것들(2026-10 사용성 감사에서 나온 방향)을 상시 확인한다.
// - 안내 글의 한글 낱말이 줄 끝에서 쪼개지지 않는지(작은 폰·글자 1.3배)
// - 어두운 화면에서 주 버튼 글자 대비(4.5:1 이상)
// - 화면 스크립트가 멈춘 동안 눌린 "다른 앱"이 멈춤이 풀린 뒤 실행되지 않는지
// - 큰 표를 잘라 보여 줄 때 표 위에 전체 행 수를 알리는지
// - 비밀번호를 거듭 틀리면 몇 번째인지 알리고, 빈 칸은 보내지 않는지
// - 찾기 막대가 열리면 앱에 뒤로 가기 대상을 알리고, 뒤로 가기로 닫히는지
// - 내려 읽을 때 위쪽 바가 비켜 주고 올리면 돌아오는지
// - 위쪽 바는 파일 이름과 메뉴(⋮)만, 메뉴의 파일 공유하기·다운로드·연결 앱, 문서 안내는 한 줄로 접히고 목록으로 펼쳐지는지
// - 워드도 내려 읽을 때 위쪽 바가 접히는지, 엑셀도 올리면 위쪽 바가 다시 나오는지
// - 긴 워드는 읽기 모드로 먼저 열리고(docx는 엔진 없이 빠른 읽기, doc는 엔진 경로), 버튼으로 원본 모양으로 바뀌는지. 짧은 워드는 그대로 원본 모양인지
// - 쪽 문서(PDF·한글): 오른쪽 쪽 이동 손잡이(지금 쪽/전체 쪽, 끌어서 이동), 두 손가락 확대·축소 40%~800%를 손을 떼지 않고 한 동작으로
//   (100%를 넘나듦, 손가락 아래 자리, 확대하면 옆 스크롤·위쪽 바는 화면 왼쪽)
// - 엑셀: 줄여 보다가 시트를 바꿔도 배율이 그대로인지
// - 참고 안내(메모·노트·첨부)는 위쪽 줄 대신 메뉴에만, AutoCAD 도면의 검색용 글자 주석은 메모로 세지 않는지
// - 배율(60%·100%·200%)이 바뀌어도 위쪽 바·시트 탭·메뉴가 화면 크기 그대로 화면에 붙어 있는지(문서 종류마다)
// - 도면처럼 선이 수만 개인 PDF를 폴드 크기·폰 속도로 열고 줄이고 키워도 화면 처리가 오래 멈추지 않는지
// - 확대하면 보이는 부분을 화면 해상도로 다시 그려 흐리지 않은지, 회전된 쪽의 글자 층이 실제 글자 위에 있는지
// - PDF 이미지로 변환: 지금 쪽이 골라진 채 열림, 범위 입력·잘못된 범위 알림, 고른 쪽을 순서대로 화질대로 앱에 넘김,
//   취소·뒤로 가기·앱이 못 받을 때 되돌림, 인쇄·복사를 막은 PDF는 변환하지 않음
// 사용: node ux.mjs <port> <매트릭스 폴더>   (server.mjs가 떠 있어야 한다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from './playwright.mjs';

const { chromium } = loadPlaywright();
const [,, port, dirArg] = process.argv;
const dir = path.resolve(dirArg);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ['--no-sandbox'] } : {});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bedocs-ux-'));
let pass = 0;
let fail = 0;

async function open(file, { width = 412, height = 915, dark = false, fontScale = 1, dpr = 1, throttle = 0, init = null, lang = null, name = null, full = 0, print = false, via = browser, tooBig = 0 } = {}) {
  await fetch(`${base}/__set?` + new URLSearchParams({ f: file, name: name || path.basename(file), ...(tooBig ? { tooBig: String(tooBig) } : {}) }));
  const ctx = await via.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  if (init) await page.addInitScript(init);
  // 폰 속도 흉내: 문서를 여는 것부터 느리게
  if (throttle) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.addInitScript(({ scale, lang, full, print }) => {
    window.__r = [];
    window.__elsewhere = 0;
    window.__back = [];
    window.DocViewer = {
      report: (s) => window.__r.push(JSON.parse(s)),
      pickFile() {},
      openElsewhere() { window.__elsewhere++; },
      canOpenElsewhere: () => true,
      canShare: () => true,
      shareFile() { window.__share = (window.__share || 0) + 1; },
      shareFileAs(name) { window.__shareAs = (window.__shareAs || []).concat(name); },
      canDownload: () => !window.__noDownload,
      zoomBy(f) { window.__zoomBy = (window.__zoomBy || []).concat(f); },
      download() { window.__download = (window.__download || 0) + 1; },
      fontScale: () => scale,
      setBackTarget(open) { window.__back.push(open); },
      showScrollbars(show) { window.__scrollbars = show; },
      // 이미지로 변환: 앱이 받은 그림을 모아 둔다(window.__expFail이면 앱이 못 받은 것처럼)
      exportBegin(mode) { window.__exp = { mode, log: [`begin:${mode}`], images: [], cur: null }; return true; },
      exportPart(name, mime, b64, last) {
        const e = window.__exp;
        if (window.__expFail || !e) return false;
        // 앱처럼 조각마다 따로 푼다(조각마다 base64가 따로 끝난다)
        if (!e.cur) e.cur = { name, mime, parts: [] };
        e.cur.parts.push(b64);
        e.log.push('part');
        if (last) { e.images.push(e.cur); e.cur = null; }
        return true;
      },
      exportEnd() { window.__exp.log.push('end'); return window.__exp.images.length; },
      exportCancel() { (window.__exp || (window.__exp = { log: [], images: [] })).log.push('cancel'); },
    };
    // 앱이 알려 주는 언어(i18n.js). 없으면 한국어 화면
    if (lang) window.DocViewer.language = () => lang;
    // 앱이 알려 주는 "화면을 다 쓸 때의 창 폭"(분할 화면 흉내). 시험 중에 바꿀 수 있게 window.__full
    if (full) { window.__full = full; window.DocViewer.fullWindowWidth = () => window.__full; }
    // PDF로 저장: 앱이 인쇄 창을 여는 대신 받은 값만 적어 둔다(시험이 page.pdf로 인쇄한 뒤 beDocsPrintDone을 부른다)
    if (print) window.DocViewer.printPdf = (n, w, h) => { window.__print = { n, w, h }; return true; };
    // 인쇄(PDF 문서): 앱이 원본 PDF를 인쇄 창에 넘기는 대신 받은 값만 적어 둔다
    if (print) window.DocViewer.printFile = (n, w, h, pages) => { window.__printFile = { n, w, h, pages }; return true; };
  }, { scale: fontScale, lang, full, print });
  await page.goto(`${base}/viewer/index.html`);
  return { ctx, page };
}

const waitState = (page, states, ms = 60000) => page.waitForFunction((s) => window.__r.some((r) => s.includes(r.state)), states, { timeout: ms });

async function check(name, fn) {
  // ONLY=낱말 이면 이름에 그 낱말이 든 검사만 돌린다(고치는 중에 빨리 다시 보기)
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try {
    const msg = await fn();
    if (msg) throw new Error(msg);
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}: ${String(e.message || e).split('\n')[0].slice(0, 200)}`);
  }
}

// 안내 글에서 낱말 가운데 줄바꿈("보세|요")을 찾는다.
const SPLITS = () => {
  const out = [];
  for (const root of document.querySelectorAll('#notice, .info-note, .sheet-more')) {
    if (root.offsetParent === null) continue;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      if (t.parentElement.closest('.file-card, .tech')) continue; // 파일 이름·원인 글은 아무 데서나 나뉘어도 된다
      const s = t.textContent;
      let prevTop = null;
      for (let i = 0; i < s.length; i++) {
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + 1);
        const rect = r.getClientRects()[0];
        if (!rect) continue;
        if (prevTop != null && rect.top > prevTop + 4 && /[가-힣]/.test(s[i - 1]) && /[가-힣]/.test(s[i])) out.push(`${s.slice(Math.max(0, i - 4), i)}|${s.slice(i, i + 4)}`);
        prevTop = rect.top;
      }
    }
  }
  return out;
};

const M = (f) => path.join(dir, f);

for (const [file, states] of [['locked-like.hwp', ['error']], ['archive.zip', ['error']], ['hwp5-password-1234.hwp', ['password']], ['empty-0byte.hwp', ['error']], ['word-cut-short.doc', ['error']]]) {
  await check(`한글 낱말 쪼개짐 없음: ${file}`, async () => {
    const { ctx, page } = await open(M(file), { width: 360, height: 740, fontScale: 1.3 });
    await waitState(page, states);
    const splits = await page.evaluate(SPLITS);
    await ctx.close();
    return splits.length ? `쪼개진 곳 ${splits.join(', ')}` : '';
  });
}

await check('어두운 화면 주 버튼 대비 4.5:1 이상', async () => {
  const { ctx, page } = await open(M('locked-like.hwp'), { dark: true });
  await waitState(page, ['error']);
  const ratio = await page.evaluate(() => {
    const b = document.querySelector('.btn-primary');
    const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
    const lum = ([r, g, bl]) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
    };
    const cs = getComputedStyle(b);
    const a = lum(rgb(cs.color));
    const c = lum(rgb(cs.backgroundColor));
    return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
  });
  await ctx.close();
  return ratio < 4.5 ? `대비 ${ratio.toFixed(2)}:1` : '';
});

await check('멈춘 동안 눌린 메뉴는 멈춤이 풀린 뒤 열리지 않음', async () => {
  const { ctx, page } = await open(M('word2007.docx'));
  await waitState(page, ['rendered']);
  // page.click은 화면 스크립트가 풀릴 때까지 기다렸다 새로 누르므로, 손가락 입력처럼 좌표로 바로 누른다.
  const box = await page.locator('#menu-btn').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  page.evaluate(() => {
    const end = Date.now() + 3000;
    while (Date.now() < end) { /* 긴 쪽 나누기 흉내 */ }
  });
  await page.waitForTimeout(500);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
  const stale = await page.evaluate(() => !document.getElementById('menu').hidden);
  await page.mouse.click(x, y);
  const fresh = await page.evaluate(() => !document.getElementById('menu').hidden);
  await page.click('#open-elsewhere');
  const handed = await page.evaluate(() => window.__elsewhere);
  await ctx.close();
  if (stale) return '멈춘 동안의 탭으로 메뉴가 열림';
  if (!fresh) return '평소 탭으로 메뉴가 열리지 않음';
  return handed === 1 ? '' : `연결 앱이 실행되지 않음(${handed})`;
});

// 긴 이름은 가운데를 줄이려고 두 칸으로 나눠 그린다. 나눈 자리가 띄어쓰기면 칸 끝에서 사라져 "Sales Q4"가 "SalesQ4"로 보였다.
await check('파일 이름을 나눈 자리의 띄어쓰기가 사라지지 않음(한 줄로 그린 이름과 폭이 같음)', async () => {
  const bad = [];
  for (const name of ['Operations Handbook.docx', 'Sales Q4 review.docx', '2026년 4분기 회의 자료 최종.docx']) {
    const { ctx, page } = await open(M('word-extras.docx'), { name });
    await waitState(page, ['rendered']);
    const r = await page.evaluate(() => {
      const title = document.getElementById('title');
      const parts = [...title.children].reduce((w, c) => w + c.getBoundingClientRect().width, 0);
      const probe = document.createElement('span');
      probe.className = 'bar-title';
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      probe.textContent = title.getAttribute('aria-label');
      title.parentElement.appendChild(probe);
      const whole = probe.getBoundingClientRect().width;
      probe.remove();
      return { parts: Math.round(parts * 10) / 10, whole: Math.round(whole * 10) / 10, text: [...title.children].map((c) => c.textContent).join('|') };
    });
    await ctx.close();
    if (Math.abs(r.parts - r.whole) > 1) bad.push(`${name}: 나눠 그린 폭 ${r.parts} ≠ 한 줄 ${r.whole} (${r.text})`);
  }
  return bad.join(' | ');
});

await check('위쪽 바는 파일 이름과 메뉴뿐, 메뉴의 파일 공유하기·다운로드·연결 앱이 앱으로 넘어감(다운로드는 앱이 저장할 수 있을 때만), 뒤로 가기로 메뉴가 닫힘', async () => {
  const { ctx, page } = await open(M('pdf-annotations.pdf'));
  await waitState(page, ['rendered']);
  const bar = await page.evaluate(() => [...document.querySelectorAll('#bar button')].filter((b) => b.offsetParent).map((b) => b.id));
  await page.click('#menu-btn');
  const items = await page.evaluate(() => [...document.querySelectorAll('#menu .menu-item')].filter((b) => !b.hidden).map((b) => b.textContent));
  await page.click('#menu-share');
  await page.click('#share-send'); // 이름을 그대로 두고 공유하기 → 받은 파일 그대로
  const afterShare = await page.evaluate(() => ({ share: window.__share || 0, menu: !document.getElementById('menu').hidden, sheet: !document.getElementById('share-panel').hidden }));
  await page.click('#menu-btn');
  await page.click('#menu-download');
  const afterDownload = await page.evaluate(() => ({ download: window.__download || 0, share: window.__share || 0, menu: !document.getElementById('menu').hidden }));
  // 앱이 저장할 수 없다고 하면(이미 휴대폰 저장소에 있는 file:// 파일 등) 다운로드는 메뉴에 없다
  await page.evaluate(() => { window.__noDownload = true; });
  await page.click('#menu-btn');
  const noDownload = await page.evaluate(() => document.getElementById('menu-download').hidden);
  const told = await page.evaluate(() => window.__back[window.__back.length - 1]);
  const backed = await page.evaluate(() => window.beDocsBack() && document.getElementById('menu').hidden);
  await ctx.close();
  if (bar.join() !== 'menu-btn') return `위쪽 바 버튼: ${bar.join()}`;
  if (items.join('|') !== '문서에서 찾기|이미지로 변환…|파일 공유하기…|다운로드|연결 앱…') return `메뉴: ${items.join('|')}`;
  if (afterShare.share !== 1 || afterShare.menu || afterShare.sheet) return `파일 공유하기: ${JSON.stringify(afterShare)}`;
  if (afterDownload.download !== 1 || afterDownload.share !== 1 || afterDownload.menu) return `다운로드: ${JSON.stringify(afterDownload)}`;
  if (!noDownload) return '앱이 저장할 수 없는데 다운로드가 메뉴에 보임';
  return told === true && backed ? '' : `뒤로 가기: 알림 ${told}, 닫힘 ${backed}`;
});

await check('파일 공유하기: 보낼 이름을 고칠 수 있고(확장자는 그대로), 쓸 수 없는 글자는 빼고, 비우거나 그대로 두면 받은 파일 그대로, 뒤로 가기·바깥 누르기로 닫힘', async () => {
  const { ctx, page } = await open(M('pdf-annotations.pdf'));
  await waitState(page, ['rendered']);
  const sheet = () => page.evaluate(() => ({
    open: !document.getElementById('share-panel').hidden,
    value: document.getElementById('share-input').value,
    ext: document.getElementById('share-ext').textContent,
    focused: document.activeElement && document.activeElement.id,
    selected: [document.getElementById('share-input').selectionStart, document.getElementById('share-input').selectionEnd],
    share: window.__share || 0,
    as: window.__shareAs || [],
  }));
  const openSheet = async () => { await page.click('#menu-btn'); await page.click('#menu-share'); };
  await openSheet();
  const opened = await sheet();
  const box = await page.locator('#share-panel').boundingBox();
  const vw = await page.evaluate(() => innerWidth);
  await page.fill('#share-input', ' 회의 자료 10/18: 최종 ');
  await page.press('#share-input', 'Enter');
  const renamed = await sheet();
  await openSheet();
  await page.fill('#share-input', '보고서.PDF');
  await page.click('#share-send');
  const typedExt = await sheet();
  await openSheet();
  await page.fill('#share-input', '  ');
  await page.click('#share-send');
  const emptied = await sheet();
  await openSheet();
  const told = await page.evaluate(() => window.__back[window.__back.length - 1]);
  const backed = await page.evaluate(() => window.beDocsBack() && document.getElementById('share-panel').hidden);
  await openSheet();
  await page.mouse.click(20, 120); // 바깥(문서 위)
  const outside = await sheet();
  await ctx.close();
  const info = JSON.stringify({ opened, renamed, typedExt, emptied, outside });
  if (!opened.open || opened.value !== 'pdf-annotations' || opened.ext !== '.pdf') return `시트가 원래 이름으로 열리지 않음 ${info}`;
  if (opened.focused !== 'share-input' || opened.selected[0] !== 0 || opened.selected[1] !== 15) return `이름 칸이 바로 고칠 수 있게(전체 선택) 열리지 않음 ${info}`;
  if (opened.share || opened.as.length) return `열기만 했는데 보냄 ${info}`;
  if (!(box && box.x >= 0 && box.x + box.width <= vw)) return `시트가 화면 밖 ${JSON.stringify(box)}`;
  if (renamed.open || renamed.as[0] !== '회의 자료 10 18 최종.pdf') return `고친 이름으로 보내지 않음(쓸 수 없는 글자·앞뒤 빈칸) ${info}`;
  if (typedExt.as[1] !== '보고서.pdf') return `확장자까지 쳐 넣으면 두 번 붙음 ${info}`;
  if (emptied.share !== 1 || emptied.as.length !== 2) return `이름을 비우면 받은 파일 그대로 보내야 함 ${info}`;
  if (told !== true || !backed) return `뒤로 가기로 시트가 닫히지 않음: 알림 ${told}, 닫힘 ${backed}`;
  return !outside.open && outside.share === 1 && outside.as.length === 2 ? '' : `바깥을 누르면 보내지 않고 닫혀야 함 ${info}`;
});

await check('문서 안내는 한 줄로 접히고(가장 중요한 것 먼저), 누르면 목록이 열리고 바깥을 누르면 닫힘', async () => {
  const { ctx, page } = await open(M('word-extras.docx'));
  await waitState(page, ['extras']);
  await page.waitForTimeout(300);
  const strip = await page.evaluate(() => {
    const s = document.getElementById('notes-strip');
    return { shown: !s.hidden, text: s.textContent, lines: Math.round(s.getBoundingClientRect().height / 20), visibleNotes: [...document.querySelectorAll('.info-note')].filter((n) => n.offsetParent).length };
  });
  await page.click('#notes-strip');
  const listed = await page.evaluate(() => ({ panel: !document.getElementById('notes-panel').hidden, notes: [...document.querySelectorAll('#notes-panel .info-note')].filter((n) => n.offsetParent).length }));
  const splits = await page.evaluate(SPLITS);
  await page.mouse.click(200, 300);
  const closed = await page.evaluate(() => document.getElementById('notes-panel').hidden);
  await ctx.close();
  if (!strip.shown || !/^i?수식 1개는 표시되지 않아요\.외 2개$/.test(strip.text) || strip.visibleNotes || strip.lines > 2) return `한 줄: ${JSON.stringify(strip)}`;
  if (!listed.panel || listed.notes !== 3) return `목록: ${JSON.stringify(listed)}`;
  if (splits.length) return `낱말 쪼개짐: ${splits.slice(0, 3).join(', ')}`;
  return closed ? '' : '바깥을 눌러도 목록이 닫히지 않음';
});

await check('참고 안내(메모만 있는 문서)는 위쪽 줄에 띄우지 않고 메뉴의 문서 안내에만', async () => {
  const { ctx, page } = await open(M('hwp-memo.hwp'));
  await waitState(page, ['extras']);
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ strip: !document.getElementById('notes-strip').hidden, menu: document.getElementById('menu-notes').hidden ? '' : document.getElementById('menu-notes').textContent }));
  await ctx.close();
  return !r.strip && r.menu === '문서 안내 1개' ? '' : JSON.stringify(r);
});

await check('AutoCAD 도면 PDF: 도면 글자의 검색용 주석(AutoCAD SHX Text)은 메모로 세지 않고, 진짜 메모만', async () => {
  const { ctx, page } = await open(M('pdf-autocad-shx.pdf'));
  await waitState(page, ['rendered']);
  await page.waitForFunction(() => window.__r.some((r) => r.state === 'extras'), null, { timeout: 15000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    strip: !document.getElementById('notes-strip').hidden,
    notes: [...document.querySelectorAll('#notes-list .info-note-text')].map((n) => n.textContent),
  }));
  let listed = [];
  if (r.notes.length) {
    await page.click('#menu-btn');
    await page.click('#menu-notes');
    await page.locator('.extras-note .info-note-action').first().click();
    listed = await page.evaluate(() => [...document.querySelectorAll('.list-pop .cell-pop-text')].map((x) => x.textContent));
  }
  await ctx.close();
  const info = JSON.stringify({ ...r, listed });
  if (r.strip) return `위쪽 줄에 띄움 ${info}`;
  if (r.notes.join() !== '메모 1개가 있어요.') return `메모 수가 다름 ${info}`;
  return listed.length === 1 && listed[0] === '출구 위치 다시 확인해 주세요' ? '' : `목록이 다름 ${info}`;
});

await check('큰 표는 표 위에 전체 행 수를 알림', async () => {
  const csv = path.join(tmp, 'big-5000.csv');
  fs.writeFileSync(csv, ['번호,이름', ...Array.from({ length: 4999 }, (_, i) => `${i + 1},이름${i + 1}`)].join('\n'));
  const { ctx, page } = await open(csv);
  await waitState(page, ['rendered']);
  const text = await page.evaluate(() => ({
    strip: document.getElementById('notes-strip').hidden ? '' : document.getElementById('notes-strip-text').textContent,
    end: (document.querySelector('.sheet .sheet-end') || {}).textContent || '',
  }));
  await ctx.close();
  // 문서 안내 한 줄(가장 중요한 것)과 표 끝 표시 둘 다
  return /^전체 5,000행 중 처음 3,000행/.test(text.strip) && /처음 3,000행까지만/.test(text.end) ? '' : `안내: ${JSON.stringify(text)}`;
});

await check('엑셀도 올리면 위쪽 바가 화면 맨 위에 다시 나오고, 열 머리는 그 아래에 붙음', async () => {
  const csv = path.join(tmp, 'big-peek.csv');
  fs.writeFileSync(csv, ['번호,이름', ...Array.from({ length: 400 }, (_, i) => `${i + 1},이름${i + 1}`)].join('\n'));
  const { ctx, page } = await open(csv);
  await waitState(page, ['rendered']);
  await page.waitForTimeout(300);
  const state = () => page.evaluate(() => {
    const bar = document.getElementById('bar').getBoundingClientRect();
    const head = document.querySelector('.sheet .sheet-head').getBoundingClientRect();
    return { barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom), headTop: Math.round(head.top) };
  });
  await page.mouse.move(200, 500);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
  const down = await state();
  await page.mouse.wheel(0, -150);
  await page.waitForTimeout(400);
  const up = await state();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(400);
  const again = await state();
  await ctx.close();
  if (down.barBottom > 0) return `내려도 바가 남음 ${JSON.stringify(down)}`;
  if (Math.abs(up.barTop) > 1 || up.headTop < up.barBottom - 1) return `올렸을 때 ${JSON.stringify(up)}`;
  return again.barBottom <= 0 && Math.abs(again.headTop) <= 1 ? '' : `다시 내렸을 때 ${JSON.stringify(again)}`;
});

await check('비밀번호: 빈 칸은 보내지 않고, 두 번째로 틀리면 몇 번째인지 알림', async () => {
  const { ctx, page } = await open(M('hwp5-password-1234.hwp'));
  await waitState(page, ['password']);
  await page.click('.pw-form button[type=submit]');
  const hint = await page.textContent('.pw-hint');
  for (const pw of ['1111', '2222']) {
    await page.fill('.pw-form input', pw);
    await page.click('.pw-form button[type=submit]');
    await page.waitForFunction((n) => window.__r.filter((r) => r.state === 'password').length >= n, pw === '1111' ? 2 : 3);
  }
  const title = await page.textContent('#notice .notice-text');
  await ctx.close();
  if (!/입력해 주세요/.test(hint || '')) return `빈 칸 안내 없음("${hint}")`;
  return /2번째/.test(title) ? '' : `두 번째 틀림 안내: "${title}"`;
});

await check('찾기 막대: 앱에 뒤로 가기 대상을 알리고 뒤로 가기로 닫힘', async () => {
  const { ctx, page } = await open(M('pdf-annotations.pdf'));
  await waitState(page, ['rendered']);
  await page.click('#menu-btn');
  await page.click('#find');
  await page.waitForTimeout(200);
  const told = await page.evaluate(() => window.__back.slice());
  const closed = await page.evaluate(() => window.beDocsBack() && !document.body.classList.contains('finding'));
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => window.__back.slice());
  await ctx.close();
  if (told[told.length - 1] !== true) return `앱에 알리지 않음 ${JSON.stringify(told)}`;
  if (!closed) return '뒤로 가기로 닫히지 않음';
  return after[after.length - 1] === false ? '' : `닫은 뒤 알리지 않음 ${JSON.stringify(after)}`;
});

await check('내려 읽을 때 위쪽 바가 비켜 주고 올리면 돌아옴', async () => {
  const { ctx, page } = await open(M('pdf-mixed-sizes.pdf'));
  await waitState(page, ['rendered']);
  await page.waitForTimeout(500);
  const top = () => page.evaluate(() => Math.round(document.getElementById('bar').getBoundingClientRect().bottom));
  await page.mouse.move(200, 500);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  const away = await top();
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);
  const back = await top();
  await ctx.close();
  if (away > 0) return `내려도 바가 남음(아래 끝 ${away}px)`;
  return back > 0 ? '' : '올려도 바가 돌아오지 않음';
});

for (const [file, wants] of [
  ['word-extras.docx', ['메모 1개', '수식 1개', '변경 내용']],
  ['slides-extras.pptx', ['발표자 노트 1개', '숨긴 슬라이드 1개']],
  ['hwp-memo.hwp', ['메모 15개']],
]) {
  await check(`그리지 않는 것을 알림: ${file}`, async () => {
    const { ctx, page } = await open(M(file));
    await waitState(page, ['extras']);
    const notes = await page.evaluate(() => [...document.querySelectorAll('.extras-note')].map((x) => x.textContent).join(' | '));
    // "보기"를 누르면 메모·노트 글이 목록으로 뜬다.
    let listed = true;
    const view = page.locator('.extras-note .info-note-action').filter({ hasText: /^보기$/ });
    if (await view.count()) {
      // 참고 안내(메모·노트)는 위쪽 줄이 아니라 메뉴(⋮)의 문서 안내에서 연다
      await page.click('#menu-btn');
      await page.click('#menu-notes');
      await view.first().click();
      listed = await page.evaluate(() => document.querySelectorAll('.list-pop .cell-pop-text').length > 0);
    }
    await ctx.close();
    const missing = wants.filter((w) => !notes.includes(w));
    if (missing.length) return `알림에 없음: ${missing.join(', ')} (${notes})`;
    return listed ? '' : '"보기" 목록이 비어 있음';
  });
}

// 긴 워드는 쪽 나누기가 화면을 수 초 멈추므로 읽기 모드로 먼저 열고, 버튼을 눌러야 원본 모양을 그린다.
await check('긴 워드: 읽기 모드로 바로 열리고 "원본 모양으로 보기"로 바뀜', async () => {
  const { ctx, page } = await open(M('word-long-reading.docx'));
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true });
  });
  await waitState(page, ['rendered']);
  const reading = await page.evaluate(() => {
    const end = window.__r.find((r) => r.state === 'rendered');
    const text = document.querySelector('.word-reading')?.textContent || '';
    const merged = [...document.querySelectorAll('.word-reading td')].find((td) => td.rowSpan === 4);
    return {
      view: end.view,
      reader: end.reader,
      note: !!document.querySelector('.word-reading-note'),
      header: /머리말 표식/.test(text),
      numbered: /1\. 1-1단계/.test(text),
      last: /끝 문단 표식 4729/.test(text),
      // 200줄 표는 나눠 그리되 세로로 합친 칸(99~102줄)은 한 칸으로 남고, 뒷조각은 첫 조각과 같은 칸 너비를 쓴다
      tables: document.querySelectorAll('.word-reading .simple-table').length,
      merged: !!merged && /협조 부서/.test(merged.textContent),
      aligned: !!document.querySelector('.simple-table-cont colgroup'),
      longest: Math.max(0, ...window.__lt),
    };
  });
  // docx는 엔진 없이 빠른 읽기(docx-read.js)로 연다
  const bad = Object.entries({ view: reading.view === 'reading', fast: reading.reader === 'fast', note: reading.note, header: reading.header, numbered: reading.numbered,
    last: reading.last, split: reading.tables === 2, merged: reading.merged, aligned: reading.aligned }).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) {
    await ctx.close();
    return `읽기 모드: ${bad.join(', ')} ${JSON.stringify(reading)}`;
  }
  await page.evaluate(() => { window.__lt = []; });
  // 메뉴의 "원본 모양으로 보기"(문서 안내 목록의 같은 버튼으로도 된다)
  await page.click('#menu-btn');
  await page.click('#menu-original');
  await page.waitForFunction(() => window.__r.some((r) => (r.state === 'rendered' && r.view === 'full') || r.state === 'error'), null, { timeout: 120000 });
  await page.waitForTimeout(500);
  const full = await page.evaluate(() => ({
    end: window.__r.find((r) => (r.state === 'rendered' && r.view === 'full') || r.state === 'error'),
    surfaces: document.querySelectorAll('.word-host [data-docx-page-surface]').length,
    note: !!document.querySelector('.word-reading-note') || !document.getElementById('menu-original').hidden,
    notice: !document.getElementById('notice').hidden,
    longest: Math.max(0, ...window.__lt),
  }));
  await ctx.close();
  if (full.end.state !== 'rendered' || !(full.end.pages >= 30) || !full.surfaces || full.note || full.notice) return `원본 모양: ${JSON.stringify(full)}`;
  // 기계 속도와 상관없이 비교한다: 읽기 모드의 가장 긴 멈춤은 쪽 나누기 멈춤의 1/3보다 짧아야 한다.
  return reading.longest * 3 < full.longest ? '' : `읽기 모드 멈춤 ${reading.longest}ms, 쪽 나누기 멈춤 ${full.longest}ms`;
});

await check('워드도 내려 읽을 때 위쪽 바가 접히고 올리면 돌아옴(뷰어 안 스크롤)', async () => {
  const { ctx, page } = await open(M('word-long-reading.docx'));
  await waitState(page, ['rendered']);
  await page.waitForTimeout(300);
  const state = () => page.evaluate(() => ({
    barBottom: Math.round(document.getElementById('bar').getBoundingClientRect().bottom),
    hostTop: Math.round(document.querySelector('.word-host').getBoundingClientRect().top),
  }));
  const before = await state();
  await page.mouse.move(200, 500);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
  const away = await state();
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);
  const back = await state();
  await ctx.close();
  // 접히면 바가 화면 밖으로 나가고, 그 자리를 문서(뷰어)가 쓴다
  if (!(away.barBottom <= 0 && away.hostTop < before.hostTop - 30)) return `내려도 그대로: ${JSON.stringify({ before, away })}`;
  return back.barBottom > 0 && back.hostTop >= before.hostTop - 2 ? '' : `올려도 돌아오지 않음: ${JSON.stringify(back)}`;
});

// 97–2003 doc는 빠른 읽기를 쓸 수 없어 엔진이 읽은 구조로 읽기 모드를 만든다(같은 문서의 doc판).
await check('긴 워드(doc): 엔진 경로로도 읽기 모드가 열림', async () => {
  const { ctx, page } = await open(M('word-long-reading.doc'));
  await waitState(page, ['rendered']);
  const r = await page.evaluate(() => {
    const end = window.__r.find((x) => x.state === 'rendered');
    const text = document.querySelector('.word-reading')?.textContent || '';
    return { view: end.view, reader: end.reader, numbered: /1\. 1-1단계/.test(text), last: /끝 문단 표식 4729/.test(text) };
  });
  await ctx.close();
  return r.view === 'reading' && r.reader === 'engine' && r.numbered && r.last ? '' : JSON.stringify(r);
});

await check('짧은 워드는 지금처럼 원본 모양으로 열림', async () => {
  const { ctx, page } = await open(M('word2007.docx'));
  await waitState(page, ['rendered']);
  const end = await page.evaluate(() => ({ ...window.__r.find((r) => r.state === 'rendered'), note: !!document.querySelector('.word-reading-note') }));
  await ctx.close();
  return !end.view && end.pages >= 1 && !end.note ? '' : JSON.stringify(end);
});

for (const file of ['word.rtf', 'writer.odt']) {
  await check(`간단 보기에 머리말·꼬리말이 나옴: ${file}`, async () => {
    const { ctx, page } = await open(M(file));
    await waitState(page, ['rendered']);
    const hf = await page.evaluate(() => [...document.querySelectorAll('.simple-hf')].map((x) => x.textContent).join(' | '));
    await ctx.close();
    return /머리말/.test(hf) && /꼬리말/.test(hf) ? '' : `머리말·꼬리말 없음(${hf})`;
  });
}

// 최근 문서: 앱만 켜도 목록부터(최근 연 순서, 앱이 순서를 섞어 줘도), 누르면 그 문서를 열고, ⋮로 하나 빼기(뒤로 가기·취소는 그대로),
// 모두 지우기. 다 비면 원래 시작 화면. 목록이 없으면(앱 밖·처음) 원래 시작 화면 그대로.
await check('시작 화면 최근 문서: 최근 연 순서 목록·누르면 열기·⋮ 빼기(뒤로 가기는 취소)·모두 지우기·비면 원래 시작 화면', async () => {
  await fetch(`${base}/__set`);
  const now = Date.now();
  const list = [
    { id: '00000000000000a2', name: '공사 일정표.hwp', size: 1203456, opened: now - 3 * 3600e3, kind: 'pick' },
    { id: '00000000000000a1', name: '견적서.xlsx', size: 284211, opened: now - 60e3, kind: 'copy' },
    { id: '00000000000000a3', name: '1층 평면도.dwg', size: 4567890, opened: now - 40 * 86400e3, kind: 'copy' },
  ];
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.addInitScript((list) => {
    window.__r = [];
    window.__calls = [];
    let items = list.slice();
    window.DocViewer = {
      report: (s) => window.__r.push(JSON.parse(s)), pickFile: () => window.__calls.push('pick'), canOpenElsewhere: () => false,
      fontScale: () => 1, setBackTarget() {}, appVersion: () => '0.2.0 (test)',
      recentList: () => JSON.stringify(items),
      openRecent: (id) => window.__calls.push(`open:${id}`),
      removeRecent: (id) => { window.__calls.push(`remove:${id}`); items = items.filter((x) => x.id !== id); },
      clearRecent: () => { window.__calls.push('clear'); items = []; },
    };
  }, list);
  await page.goto(`${base}/viewer/index.html`);
  await waitState(page, ['home']);
  const bad = [];
  let step = '처음';
  try {
  const names = () => page.$$eval('.recent-name', (xs) => xs.map((x) => x.textContent));
  const first = await names();
  if (first.join('|') !== '견적서.xlsx|공사 일정표.hwp|1층 평면도.dwg') bad.push(`순서 ${first.join('|')}`);
  const home = await page.evaluate(() => window.__r.find((r) => r.state === 'home'));
  if (home.recent !== 3) bad.push(`보고 ${JSON.stringify(home)}`);
  const meta = await page.$eval('.recent-item .recent-meta', (x) => x.textContent);
  if (!/^오늘 .+ · 278KB$/.test(meta)) bad.push(`날짜·크기 ${meta}`);
  if (await page.$('.home .notice-sub')) bad.push('목록이 있는데 긴 소개 글이 그대로');
  step = '목록 누르기';
  await page.click('.recent-item:nth-child(2) .recent-open');
  await page.click('.home-pick');
  // ⋮ → 뒤로 가기: 빼지 않고 닫힘
  step = '세 번째 ⋮';
  await page.click('.recent-item:nth-child(3) .recent-more');
  await page.waitForSelector('.recent-ask');
  if (!(await page.textContent('.recent-ask')).includes('사본도 지워요')) bad.push('사본 안내 없음(copy)');
  await page.evaluate(() => window.beDocsBack());
  await page.waitForTimeout(200);
  if (await page.$('.recent-ask')) bad.push('뒤로 가기로 안 닫힘');
  // 창이 열린 바로 그 순간(같은 작업 안)에 뒤로 가기를 눌러도 닫히고, 다음 누름을 삼키지 않는다
  await page.evaluate(() => { document.querySelector('.recent-item:nth-child(3) .recent-more').click(); window.beDocsBack(); });
  await page.waitForTimeout(200);
  if (await page.$('.recent-ask')) bad.push('뒤로 가기로 안 닫힘');
  // ⋮ → 목록에서 빼기
  step = '두 번째 ⋮';
  await page.click('.recent-item:nth-child(2) .recent-more');
  await page.waitForSelector('.recent-ask');
  if (!(await page.textContent('.recent-ask')).includes('원본 파일은 지워지지 않아요')) bad.push('원본 안내 없음(pick)');
  await page.click('.recent-ask .btn-primary');
  await page.waitForTimeout(200);
  const left = await names();
  if (left.join('|') !== '견적서.xlsx|1층 평면도.dwg') bad.push(`뺀 뒤 ${left.join('|')}`);
  // 모두 지우기 → 원래 시작 화면
  step = '모두 지우기';
  await page.click('.recent-clear');
  await page.waitForSelector('.recent-ask');
  if (!(await page.textContent('.recent-ask')).includes('2개')) bad.push('모두 지우기 개수 안내 없음');
  await page.click('.recent-ask .btn-primary');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ list: !!document.querySelector('.recent-list'), hero: !!document.querySelector('.home .notice-sub'), cls: document.getElementById('notice').className }));
  if (after.list || !after.hero || /home-recent/.test(after.cls)) bad.push(`비운 뒤 ${JSON.stringify(after)}`);
  const calls = await page.evaluate(() => window.__calls);
  if (calls.join(',') !== 'open:00000000000000a2,pick,remove:00000000000000a2,clear') bad.push(`호출 ${calls.join(',')}`);
  } catch (e) {
    // 어느 단계에서 멈췄는지와 그때 화면을 남긴다
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/recent-home-fail.png` }).catch(() => {});
    const calls = await page.evaluate(() => window.__calls).catch(() => []);
    bad.push(`${step}에서 멈춤(${String(e.message).split('\n')[0]}) 호출 ${calls.join(',')}`);
  }
  await ctx.close();
  return bad.join(' / ');
});

await check('시작 화면의 앱 정보: 개인정보·최근 문서 보관 안내·한글 문서 출처·be docs GPL 안내(소스 주소)·오픈소스 라이선스 전문 13개(LibreDWG 포함)', async () => {
  await fetch(`${base}/__set`);
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__r = [];
    window.DocViewer = { report: (s) => window.__r.push(JSON.parse(s)), pickFile() {}, canOpenElsewhere: () => false, fontScale: () => 1, setBackTarget() {} };
  });
  await page.goto(`${base}/viewer/index.html`);
  await waitState(page, ['home']);
  await page.click('.home-link');
  await page.waitForSelector('.list-pop');
  const r = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.list-pop .cell-pop-label')].map((x) => x.textContent);
    const texts = [...document.querySelectorAll('.list-pop .cell-pop-text')].map((x) => x.textContent);
    return {
      labels, short: texts.filter((t) => t.length < 200).length, privacy: /인터넷을 쓰지 않아요/.test(texts[0] || ''), hwp: /공개 문서를 참고하여/.test(texts[2] || ''),
      recent: /이 휴대폰의 be docs 안에만/.test(texts[1] || '') && /백업으로도 내보내지 않아요/.test(texts[1] || ''),
      gpl: /GPL\) 3판 또는 그 이후 판/.test(texts[3] || '') && /보증도 하지 않아요/.test(texts[3] || '') && (texts[3] || '').includes('https://github.com/squeecho/be-docs'),
      libredwg: texts[labels.findIndex((l) => l.startsWith('LibreDWG'))]?.includes('GNU GENERAL PUBLIC LICENSE') || false,
    };
  });
  await ctx.close();
  // 라이선스 전문은 길다(짧으면 파일을 못 읽은 것). 앞 네 개(개인정보·최근 문서·한글 출처·be docs 사용권)만 짧다.
  return r.labels.length === 17 && r.short === 4 && r.privacy && r.recent && r.hwp && r.gpl && r.libredwg ? ''
    : JSON.stringify({ n: r.labels.length, short: r.short, privacy: r.privacy, recent: r.recent, hwp: r.hwp, gpl: r.gpl, libredwg: r.libredwg });
});

// 영어 화면: 휴대폰(앱) 언어가 한국어가 아니면 앱 글자(메뉴·안내·버튼·오류·비밀번호·시작 화면)에 한국어가 남지 않는다.
// 문서 내용(시트 이름·본문 등)은 문서 그대로이므로 앱이 만든 글자만 본다.
await check('영어 화면: 메뉴·문서 안내·공유 창·비밀번호·오류·압축 파일·시작 화면에 한국어가 남지 않음(문서 내용은 그대로)', async () => {
  const HANGUL = /[\uac00-\ud7a3]/;
  const bad = [];
  const ui = (page) => page.evaluate(() => {
    const pick = (sel) => [...document.querySelectorAll(sel)].map((x) => x.textContent.trim()).filter(Boolean);
    const attrs = [...document.querySelectorAll('#bar [aria-label], #screen [aria-label], #notice [aria-label], #notice [placeholder], #screen [placeholder]')]
      .flatMap((x) => [x.getAttribute('aria-label'), x.getAttribute('placeholder')]).filter(Boolean)
      .filter((v) => !v.includes(document.title)); // 파일 이름이 든 것(제목)은 빼고
    return [...pick('#menu .menu-item'), ...pick('#notes-list .info-note-text'), ...pick('#notes-list .info-note-action'),
      ...pick('#notes-panel .notes-panel-title'), ...pick('#notes-close'), ...pick('#share-panel p, #share-panel button'),
      ...pick('#notice .notice-text, #notice .notice-sub, #notice button, #notice summary'), ...attrs];
  });
  for (const f of ['word-extras.docx', 'excel-rich.xlsx', 'slides-extras.pptx', 'pdf-annotations.pdf', 'hwp-memo.hwp']) {
    const { ctx, page } = await open(M(f), { lang: 'en-US' });
    await waitState(page, ['rendered']);
    await page.waitForTimeout(1500); // 문서 안내(메모·노트 수)는 표시 뒤에 붙는다
    // 글자만 보는 검사라 바로 누른다. 엑셀(넓은 문서)에서 메뉴가 열리는 동안 playwright가 누르려 하면, 다시 시도하며 화면을 옮기고
    // 메뉴가 화면을 따라 움직여 끝없이 '움직이는 중'으로 본다(손가락은 화면을 옮기지 않으니 앱 문제는 아님)
    await page.evaluate(() => { document.getElementById('menu-btn').click(); document.getElementById('menu-share').click(); });
    const texts = await ui(page);
    const lang = await page.evaluate(() => document.documentElement.lang);
    await ctx.close();
    for (const t of texts) if (HANGUL.test(t)) bad.push(`${f}: ${t}`);
    if (lang !== 'en') bad.push(`${f}: html lang ${lang}`);
    if (!texts.includes('Share file…') || !texts.includes('Share')) bad.push(`${f}: 영어 메뉴·공유 창이 아님 ${JSON.stringify(texts.slice(0, 8))}`);
  }
  for (const [f, states] of [['excel-password-standard.xlsx', ['password']], ['archive.zip', ['error']], ['empty-0byte.hwp', ['error']], ['locked-like.docx', ['error']], [null, ['home']]]) {
    const { ctx, page } = await open(f ? M(f) : '', { lang: 'en-US' });
    await waitState(page, states);
    if (states[0] === 'password') {
      await page.fill('.pw-form input', 'wrong-password');
      await page.click('.pw-form .btn-primary');
      await page.waitForSelector('.pw-wrong', { timeout: 30000 });
    }
    const texts = await ui(page);
    await ctx.close();
    for (const t of texts) if (HANGUL.test(t)) bad.push(`${f || '시작 화면'}: ${t}`);
    if (!texts.length) bad.push(`${f || '시작 화면'}: 글자를 못 찾음`);
  }
  return bad.length ? bad.slice(0, 12).join(' | ') : '';
});

await check('엑셀: 줄여 보다가 시트를 바꿔도(빈 시트로 갔다 와도) 배율이 그대로, 100%로 키우면 넓혀 둔 폭을 풂', async () => {
  const { ctx, page } = await open(M('excel-rich.xlsx'));
  await waitState(page, ['rendered']);
  const cdp = await ctx.newCDPSession(page);
  const scale = () => page.evaluate(() => Math.round(visualViewport.scale * 100) / 100);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 0.6 });
  await page.waitForTimeout(400);
  const zoomed = await scale();
  await page.evaluate(() => document.querySelectorAll('.tab[data-i]')[1].click());
  await page.waitForTimeout(500);
  const other = await scale();
  await page.evaluate(() => document.querySelectorAll('.tab[data-i]')[0].click());
  await page.waitForTimeout(500);
  const back = await scale();
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await page.waitForTimeout(400);
  const minWidth = await page.evaluate(() => document.getElementById('doc').style.minWidth);
  await ctx.close();
  if (zoomed !== 0.6) return `줄이지 못함(${zoomed})`;
  if (other !== 0.6 || back !== 0.6) return `시트를 바꾸니 배율이 바뀜: 다른 시트 ${other}, 돌아와서 ${back}`;
  return minWidth ? `100%로 키워도 넓혀 둔 폭이 남음(${minWidth})` : '';
});

// 배율이 바뀌어도 앱 화면(위쪽 바·시트 탭·메뉴)은 화면 크기 그대로 화면에 붙어 있어야 한다.
// 문서 종류마다 60%(줄일 수 있는 문서만)·100%·200%에서 메뉴를 열고 화면 기준(보이는 영역 왼쪽 위 = 0, 화면 px)으로 잰다.
for (const file of ['excel-rich.xlsx', 'csv-utf8.csv', 'pdf-mixed-sizes.pdf', 'hwp5.0.3.0.hwp', 'word-extras.docx', 'slides-extras.pptx']) {
  await check(`배율이 바뀌어도 위쪽 바·탭·메뉴는 화면 크기 그대로: ${file}`, async () => {
    const { ctx, page } = await open(M(file));
    await waitState(page, ['rendered']);
    await page.waitForTimeout(400);
    const cdp = await ctx.newCDPSession(page);
    const measure = () => page.evaluate(() => {
      const vv = visualViewport;
      const scr = (el) => {
        if (!el || el.hidden) return null;
        const r = el.getBoundingClientRect();
        if (!r.width) return null;
        return { x: Math.round((r.left - vv.offsetLeft) * vv.scale), y: Math.round((r.top - vv.offsetTop) * vv.scale), w: Math.round(r.width * vv.scale), h: Math.round(r.height * vv.scale) };
      };
      return { scale: Math.round(vv.scale * 100) / 100, screenW: Math.round(vv.width * vv.scale), screenH: Math.round(vv.height * vv.scale), bar: scr(document.getElementById('bar')), tabs: scr(document.getElementById('tabs')), btn: scr(document.getElementById('menu-btn')), menu: scr(document.getElementById('menu')) };
    });
    const problems = [];
    let base = null;
    for (const want of [1, 0.6, 2]) {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: want });
      await page.waitForTimeout(500);
      await page.evaluate(() => document.getElementById('menu-btn').click());
      await page.waitForTimeout(300);
      const m = await measure();
      await page.evaluate(() => { if (!document.getElementById('menu').hidden) document.getElementById('menu-btn').click(); });
      await page.waitForTimeout(200);
      if (!base) base = m;
      const at = `${m.scale}배`;
      const near = (a, b) => Math.abs(a - b) <= 2;
      if (!m.bar || !near(m.bar.x, 0) || !near(m.bar.w, m.screenW) || !near(m.bar.h, base.bar.h)) problems.push(`${at} 바 ${JSON.stringify(m.bar)}`);
      if (!m.btn || !near(m.btn.x, base.btn.x) || !near(m.btn.y, base.btn.y)) problems.push(`${at} ⋮ ${JSON.stringify(m.btn)}`);
      if (!m.menu || m.menu.x < 0 || m.menu.x + m.menu.w > m.screenW + 1 || m.menu.y < m.btn.y + m.btn.h - 8 || m.menu.y > m.screenH) problems.push(`${at} 메뉴 ${JSON.stringify(m.menu)}`);
      if (m.tabs && (!near(m.tabs.x, 0) || !near(m.tabs.w, m.screenW) || m.tabs.y < m.bar.y + m.bar.h - 2)) problems.push(`${at} 탭 ${JSON.stringify(m.tabs)}`);
    }
    await ctx.close();
    return problems.join(' / ');
  });
}

// 쪽이 많은 PDF(10쪽)를 브라우저로 만든다(쪽 이동 손잡이·축소 시험용).
async function tenPagePdf() {
  const file = path.join(tmp, 'ten-pages.pdf');
  if (fs.existsSync(file)) return file;
  const gen = await browser.newPage();
  await gen.setContent(Array.from({ length: 10 }, (_, i) => `<section style="height:1000px;page-break-after:always;font:48px sans-serif;padding:40px">쪽 ${i + 1}</section>`).join(''));
  await gen.pdf({ path: file, format: 'A4' });
  await gen.close();
  return file;
}

// 손가락 입력(CDP). pts: [[x, y], ...]
const touch = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });

await check('쪽 이동 손잡이: 기본 스크롤 막대는 끄고, 내리면 오른쪽에 "지금 쪽/전체 쪽"이 나오고, 끌면 끝까지 가며 마지막 쪽을 알림', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  const cdp = await ctx.newCDPSession(page);
  const state = () => page.evaluate(() => ({
    idle: document.getElementById('pager').classList.contains('idle'),
    label: document.getElementById('pager-label').textContent,
    atEnd: scrollY >= document.documentElement.scrollHeight - innerHeight - 2,
    right: Math.round(innerWidth - document.getElementById('pager-thumb').getBoundingClientRect().right),
    nativeBars: window.__scrollbars,
  }));
  const first = await state();
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(400);
  const moved = await state();
  const box = await page.locator('#pager-thumb').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await touch(cdp, 'touchStart', [[x, y]]);
  for (let k = 1; k <= 12; k++) await touch(cdp, 'touchMove', [[x, y + k * 60]]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(300);
  const dragged = await state();
  await page.waitForTimeout(2000);
  const later = await state();
  await ctx.close();
  if (!first.idle) return '열자마자 손잡이가 보임';
  if (first.nativeBars !== false) return `웹뷰 기본 스크롤 막대를 끄지 않음(손잡이와 두 개로 보임): ${first.nativeBars}`;
  if (moved.idle || !/^[2-9]\/10$/.test(moved.label) || moved.right !== 0) return `내려도 손잡이가 안 보이거나 쪽 표시가 이상함 ${JSON.stringify(moved)}`;
  if (!dragged.atEnd || dragged.label !== '10/10') return `끌어도 끝까지 안 감 ${JSON.stringify(dragged)}`;
  return later.idle ? '' : '멈춘 뒤에도 손잡이가 남음';
});

// 사진이 많은 PDF(쪽마다 압축이 잘 안 되는 큰 그림). 2026-10 폰에서 "줄인 뒤 다시 키우려니 고정됨"의 원인:
// 줄이면 여러 쪽을 한꺼번에 그리느라 화면 처리가 수십 초 막혔다.
async function photoPdf() {
  const file = path.join(tmp, 'photo-pages.pdf');
  if (fs.existsSync(file)) return file;
  const gen = await browser.newPage();
  await gen.setContent('<body style="margin:0"></body>');
  await gen.evaluate(() => {
    const urls = [];
    for (let k = 0; k < 3; k++) {
      // 사진처럼 압축이 잘 안 되는 2400×3200 그림(작은 색 조각을 흐리게)
      const src = document.createElement('canvas');
      src.width = 600;
      src.height = 800;
      const s = src.getContext('2d');
      const img = s.createImageData(src.width, src.height);
      let seed = k * 9973 + 1;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        img.data[i] = seed & 255; img.data[i + 1] = (seed >> 8) & 255; img.data[i + 2] = (seed >> 16) & 255; img.data[i + 3] = 255;
      }
      s.putImageData(img, 0, 0);
      const c = document.createElement('canvas');
      c.width = 2400;
      c.height = 3200;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.filter = 'blur(1.5px)';
      g.drawImage(src, 0, 0, c.width, c.height);
      urls.push(c.toDataURL('image/jpeg', 0.92));
    }
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('section');
      s.style.cssText = 'height:1060px;page-break-after:always';
      s.innerHTML = `<h1 style="font:40px sans-serif">견적 ${i + 1}쪽</h1><img style="width:100%;height:900px;object-fit:cover">`;
      s.querySelector('img').src = urls[i % 3];
      document.body.append(s);
    }
  });
  await gen.waitForTimeout(500);
  await gen.pdf({ path: file, format: 'A4' });
  await gen.close();
  return file;
}

await check('사진 많은 PDF를 폰 속도로: 줄였다 다시 키울 때 손가락에 바로 반응(쪽을 한꺼번에 그리느라 막히지 않음)', async () => {
  const { ctx, page } = await open(await photoPdf());
  await waitState(page, ['rendered'], 120000);
  await page.waitForTimeout(1500);
  // 동작 하나가 끝나기까지: 첫 손가락 움직임(입력 시각 e.timeStamp)부터 쪽 폭이 마지막으로 바뀐 시각까지를 화면 안에서 잰다.
  // 이전 판은 동작 하나에 14초가 걸렸다(움직임마다 그리기가 끝나길 기다림).
  await page.evaluate(() => {
    window.__g = { start: 0, last: 0 };
    document.addEventListener('touchmove', (e) => { if (e.touches.length === 2 && !window.__g.start) window.__g.start = e.timeStamp; }, { passive: true, capture: true });
    new MutationObserver(() => { window.__g.last = performance.now(); }).observe(document.getElementById('doc'), { attributes: true, attributeFilter: ['style'] });
  });
  const took = async () => {
    // 쪽 폭이 1초 동안 그대로일 때까지(최대 30초) 기다린 뒤 잰다
    let prev = -1;
    for (let t = 0; t < 30; t++) {
      await page.waitForTimeout(1000);
      const g = await page.evaluate(() => window.__g.last);
      if (g === prev) break;
      prev = g;
    }
    const ms = await page.evaluate(() => Math.round(window.__g.last - window.__g.start));
    await page.evaluate(() => { window.__g = { start: 0, last: 0 }; });
    return ms;
  };
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const pinch = async (from, to) => {
    await touch(cdp, 'touchStart', [[206 - from / 2, 450], [206 + from / 2, 450]]);
    for (let k = 1; k <= 14; k++) { const d = from + (to - from) * k / 14; await touch(cdp, 'touchMove', [[206 - d / 2, 450], [206 + d / 2, 450]]); await page.waitForTimeout(16); }
    await touch(cdp, 'touchEnd', []);
    return took();
  };
  const lat = [await pinch(300, 110)];
  const small = await page.evaluate(() => document.getElementById('doc').style.getPropertyValue('--page-zoom'));
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 500)); await page.waitForTimeout(250); }
  // 40%에서 2.5배로 벌리면 100%(줄인 만큼만 되돌린다. 더 벌리면 100%를 넘어 확대된다)
  lat.push(await pinch(110, 275));
  const back = await page.evaluate(() => document.getElementById('doc').style.getPropertyValue('--page-zoom'));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await ctx.close();
  const info = JSON.stringify({ small, back, lat });
  if (!(Number(small) < 0.6)) return `모아도 줄지 않음 ${info}`;
  if (back !== '1') return `벌려도 원래 폭으로 안 돌아옴(고정) ${info}`;
  return Math.max(...lat) < 5000 ? '' : `손가락에 늦게 반응(동작 하나에 ${Math.max(...lat)}ms) ${info}`;
});

await check('사진 많은 PDF를 끝까지 내렸다가 올려도 이미 본 쪽이 다시 빈 칸("불러오는 중")으로 보이지 않음(남겨 둔 작은 그림)', async () => {
  // 폰 속도(CPU 4배 느리게): PC 속도로는 다시 그리기가 금방 끝나 빈 칸이 잡히지 않는다.
  // 작은 그림(JPG) 만들기는 휴대폰이 바쁘면 몇 초 늦는다(CPU 4배에서 3초 넘게 잼). 그 사이 멀어진 쪽도 빈 칸이 되지 않아야 해서
  // JPG가 늘 4초 늦게 나오게 한다(늦지 않으면 이 경우를 가끔만 지나가 시험이 들쭉날쭉했다).
  const { ctx, page } = await open(await photoPdf(), {
    throttle: 4,
    init: () => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
        return toBlob.call(this, (blob) => setTimeout(() => cb(blob), 4000), ...rest);
      };
    },
  });
  await waitState(page, ['rendered'], 120000);
  const blank = () => page.evaluate(() => [...document.querySelectorAll('.page')].filter((p) => {
    const r = p.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && !p.querySelector('canvas.pdf-base, .pdf-snap');
  }).length);
  // 내려가며 쪽마다 다 그려질 때까지 기다린다(처음 보는 쪽은 그리는 동안 빈 칸이 보일 수 있다)
  const H = await page.evaluate(() => innerHeight);
  let steps = 0;
  while (await page.evaluate(() => scrollY + innerHeight < document.documentElement.scrollHeight - 2) && steps < 60) {
    await page.evaluate((h) => window.scrollBy(0, h), H);
    steps++;
    for (let t = 0; t < 100 && await blank(); t++) await page.waitForTimeout(100);
  }
  await page.waitForTimeout(500);
  // 올라오며 화면에 빈 칸이 있는지 바로 본다
  const seen = [];
  while (await page.evaluate(() => scrollY > 0)) {
    await page.evaluate((h) => window.scrollBy(0, -h), H);
    await page.waitForTimeout(30);
    seen.push(await blank());
  }
  const snaps = await page.evaluate(() => document.querySelectorAll('.pdf-snap').length);
  await ctx.close();
  if (steps < 5) return `충분히 내려가지 못함(${steps}번)`;
  return seen.every((n) => n === 0) ? '' : `되돌아올 때 빈 칸이 보임 ${JSON.stringify(seen)} (작은 그림 ${snaps}장)`;
});

await check('두 손가락 축소의 메모리: 60쪽 PDF를 40%로 줄여 끝까지 훑어도 그린 쪽 그림 크기가 100%일 때보다 크지 않음', async () => {
  const file = path.join(tmp, 'sixty-pages.pdf');
  const gen = await browser.newPage();
  await gen.setContent(Array.from({ length: 60 }, (_, i) => `<section style="height:1000px;page-break-after:always;font:40px sans-serif;padding:40px">쪽 ${i + 1}</section>`).join(''));
  await gen.pdf({ path: file, format: 'A4' });
  await gen.close();
  const { ctx, page } = await open(file);
  await waitState(page, ['rendered']);
  const cdp = await ctx.newCDPSession(page);
  const stat = () => page.evaluate(() => {
    const cs = [...document.querySelectorAll('.page canvas')];
    return { canvases: cs.length, mpx: cs.reduce((a, c) => a + c.width * c.height, 0) / 1e6, maxW: Math.max(0, ...cs.map((c) => c.width)) };
  });
  const sweep = async () => {
    let peak = { canvases: 0, mpx: 0 };
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H; y += 700) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(120);
      const s = await stat();
      if (s.mpx > peak.mpx) peak = s;
      if (s.canvases > peak.canvases) peak.canvases = s.canvases;
    }
    await page.waitForTimeout(800);
    return { peak, end: await stat() };
  };
  const full = await sweep();
  await page.evaluate(() => window.scrollTo(0, 0));
  await touch(cdp, 'touchStart', [[46, 450], [366, 450]]);
  for (let k = 1; k <= 20; k++) await touch(cdp, 'touchMove', [[46 + k * 10, 450], [366 - k * 10, 450]]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(800);
  const small = await sweep();
  // 40% × 2.5 = 100%
  await touch(cdp, 'touchStart', [[176, 450], [236, 450]]);
  for (let k = 1; k <= 20; k++) await touch(cdp, 'touchMove', [[176 - k * 2.25, 450], [236 + k * 2.25, 450]]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(1500);
  const back = await stat();
  await ctx.close();
  const info = JSON.stringify({ full: full.peak, small: small.peak, smallEnd: small.end, back });
  if (small.peak.mpx > full.peak.mpx * 1.1) return `줄였을 때 더 큼 ${info}`;
  if (small.peak.canvases > 16) return `줄였을 때 그린 쪽이 너무 많음 ${info}`;
  if (!(small.end.maxW <= full.end.maxW * 0.6)) return `줄였을 때 해상도를 낮추지 않음 ${info}`;
  return back.maxW >= full.end.maxW ? '' : `다시 키웠는데 선명하게 다시 그리지 않음 ${info}`;
});

await check('두 손가락 축소: 모으면 쪽이 작아지고(최소 40%) 손가락 아래 쪽이 그대로, 벌리면 원래 폭으로', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  const cdp = await ctx.newCDPSession(page);
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, 2200);
  await page.waitForTimeout(400);
  const look = () => page.evaluate(() => {
    const pages = [...document.querySelectorAll('.page')];
    const at = pages.findIndex((p) => p.getBoundingClientRect().bottom > 450);
    return { w: Math.round(pages[0].getBoundingClientRect().width), at, scale: visualViewport.scale, zoomed: document.getElementById('doc').classList.contains('zoomed-out') };
  });
  const before = await look();
  const cx = 206;
  const cy = 450;
  await touch(cdp, 'touchStart', [[cx - 160, cy], [cx + 160, cy]]);
  for (let k = 1; k <= 14; k++) await touch(cdp, 'touchMove', [[cx - 160 + k * 10, cy], [cx + 160 - k * 10, cy]]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(500);
  const small = await look();
  // 40% × 2.5 = 100%
  await touch(cdp, 'touchStart', [[cx - 50, cy], [cx + 50, cy]]);
  for (let k = 1; k <= 14; k++) await touch(cdp, 'touchMove', [[cx - 50 - k * 75 / 14, cy], [cx + 50 + k * 75 / 14, cy]]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(500);
  const back = await look();
  await ctx.close();
  if (!(small.w <= before.w * 0.5 && small.w >= before.w * 0.38) || !small.zoomed) return `모아도 쪽이 작아지지 않음 ${JSON.stringify({ before, small })}`;
  if (small.scale !== 1) return `웹뷰 배율이 바뀜 ${small.scale}`;
  if (small.at !== before.at) return `손가락 아래 쪽이 바뀜 ${before.at}→${small.at}`;
  return back.w === before.w && !back.zoomed ? '' : `벌려도 원래 폭으로 안 돌아옴 ${JSON.stringify(back)}`;
});

await check('두 손가락 확대·축소: 손을 떼지 않고 한 동작으로 100%를 넘나듦(60%→120%→60%), 손가락 아래 자리가 그대로, 확대하면 옆으로 끝까지 가고 위쪽 바는 화면 왼쪽에', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  const cdp = await ctx.newCDPSession(page);
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(400);
  const zoom = () => page.evaluate(() => Number(document.getElementById('doc').style.getPropertyValue('--page-zoom') || 1));
  // 화면 점(x, y) 아래의 문서 자리: 쪽 번호와 쪽 안 비율
  const spot = (x, y) => page.evaluate(([x, y]) => {
    const pages = [...document.querySelectorAll('.page')];
    const i = pages.findIndex((p) => p.getBoundingClientRect().bottom > y);
    const r = pages[i].getBoundingClientRect();
    return { i, fx: Math.round(((x - r.left) / r.width) * 1000) / 1000, fy: Math.round(((y - r.top) / r.height) * 1000) / 1000 };
  }, [x, y]);
  // 100%보다 작으면 쪽이 화면 가운데에 있어(옆으로 스크롤할 곳이 없다) 가로 자리는 지킬 수 없다. 세로 자리만 본다.
  const far = (a, b, x = false) => a.i !== b.i || Math.abs(a.fy - b.fy) > 0.02 || (x && Math.abs(a.fx - b.fx) > 0.02);
  // 한 동작: 손가락 간격 from → to, 움직이는 동안의 배율을 모은다
  const gesture = async (cx, cy, from, to) => {
    const seen = [];
    await touch(cdp, 'touchStart', [[cx - from / 2, cy], [cx + from / 2, cy]]);
    for (let k = 1; k <= 16; k++) {
      const d = from + (to - from) * k / 16;
      await touch(cdp, 'touchMove', [[cx - d / 2, cy], [cx + d / 2, cy]]);
      await page.waitForTimeout(20);
      seen.push(await zoom());
    }
    const held = await spot(cx, cy);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(500);
    return { seen, held };
  };
  const cx = 150;
  const cy = 450;
  await gesture(cx, cy, 300, 180); // 60%로
  const z60 = await zoom();
  const s0 = await spot(cx, cy);
  const up = await gesture(cx, cy, 100, 200); // 한 동작으로 2배: 60% → 120%
  const z120 = await zoom();
  const s1 = await spot(cx, cy);
  const scale = await page.evaluate(() => visualViewport.scale);
  // 100%보다 크면 가로 자리도 손가락 아래 그대로(120% → 240%)
  const s2 = await spot(cx, cy);
  const wide = await gesture(cx, cy, 100, 200);
  const z240 = await zoom();
  const s3 = await spot(cx, cy);
  await gesture(cx, cy, 200, 100);
  // 확대한 채 옆으로: 왼쪽 끝과 오른쪽 끝까지 갈 수 있고, 위쪽 바는 늘 화면 왼쪽에 화면 폭 그대로
  const edge = (x) => page.evaluate(async (x) => {
    window.scrollTo(x, scrollY);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = document.querySelectorAll('.page')[0].getBoundingClientRect();
    const bar = document.getElementById('bar').getBoundingClientRect();
    return { x: Math.round(scrollX), left: Math.round(p.left), right: Math.round(p.right), w: innerWidth, barLeft: Math.round(bar.left), barW: Math.round(bar.width) };
  }, x);
  const leftEnd = await edge(0);
  const rightEnd = await edge(1e6);
  // 오른쪽 끝에서 연 메뉴도 화면 안에
  const menu = await page.evaluate(async () => {
    document.getElementById('menu-btn').click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = document.getElementById('menu').getBoundingClientRect();
    const out = { left: Math.round(m.left), right: Math.round(m.right), w: innerWidth, shown: m.width > 0 };
    window.beDocsBack && window.beDocsBack();
    return out;
  });
  await edge(0);
  const down = await gesture(cx, cy, 200, 100); // 다시 한 동작으로 120% → 60%
  const zBack = await zoom();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  await ctx.close();
  const info = JSON.stringify({ z60, z120, z240, zBack, s0, s1, s2, s3, up: up.seen, down: down.seen, scale, leftEnd, rightEnd, menu });
  if (Math.abs(z60 - 0.6) > 0.02) return `먼저 60%로 줄이지 못함 ${info}`;
  if (Math.abs(z120 - 1.2) > 0.02) return `한 동작으로 60%→120%가 안 됨(100%에서 멈춤) ${info}`;
  if (!up.seen.some((z) => z > 0.7 && z < 0.95) || !up.seen.some((z) => z > 1.05 && z < 1.15)) return `움직이는 동안 100% 앞뒤를 이어 지나지 않음 ${info}`;
  if (scale !== 1) return `웹뷰 배율이 바뀜(쪽 문서는 앱이 확대) ${info}`;
  if (far(s0, up.held) || far(s0, s1)) return `손가락 아래 자리가 바뀜 ${info}`;
  if (Math.abs(z240 - 2.4) > 0.03 || far(s2, wide.held, true) || far(s2, s3, true)) return `확대한 채 더 확대하면 손가락 아래 자리가 바뀜 ${info}`;
  if (!(rightEnd.x > 40) || leftEnd.left < 0 || rightEnd.right > rightEnd.w) return `확대한 쪽의 왼쪽·오른쪽 끝까지 가지 못함 ${info}`;
  if (leftEnd.barLeft !== 0 || rightEnd.barLeft !== 0 || rightEnd.barW !== rightEnd.w) return `옆으로 스크롤하면 위쪽 바가 화면 밖으로 밀림 ${info}`;
  if (!menu.shown || menu.left < 0 || menu.right > menu.w) return `옆으로 스크롤한 채 연 메뉴가 화면 밖 ${info}`;
  if (Math.abs(zBack - 0.6) > 0.02) return `한 동작으로 120%→60%가 안 됨 ${info}`;
  return overflow ? `줄였는데 옆으로 넘침 ${info}` : '';
});

await check('두 손가락 확대: 800%까지(그 이상은 멈춤), 줄이면 40%까지, 화면 폭 가까이(95~105%)에서 손을 떼면 100%에 맞춤', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  const cdp = await ctx.newCDPSession(page);
  const zoom = () => page.evaluate(() => Number(document.getElementById('doc').style.getPropertyValue('--page-zoom') || 1));
  const gesture = async (from, to) => {
    await touch(cdp, 'touchStart', [[206 - from / 2, 450], [206 + from / 2, 450]]);
    for (let k = 1; k <= 12; k++) { const d = from + (to - from) * k / 12; await touch(cdp, 'touchMove', [[206 - d / 2, 450], [206 + d / 2, 450]]); await page.waitForTimeout(16); }
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(400);
    return zoom();
  };
  const max = [await gesture(40, 380), await gesture(40, 380)];
  await gesture(380, 20);
  const min = await gesture(380, 20);
  const snap = await gesture(100, 260); // 40% × 2.6 = 104%
  const w = await page.evaluate(() => [Math.round(document.querySelector('.page').getBoundingClientRect().width), innerWidth]);
  await ctx.close();
  const info = JSON.stringify({ max, min, snap, w });
  if (max[1] !== 8) return `800%까지 확대되지 않거나 넘어감 ${info}`;
  if (min !== 0.4) return `40%까지 줄지 않거나 더 줄어듦 ${info}`;
  return snap === 1 && w[0] === w[1] - 12 ? '' : `100% 가까이에서 화면 폭에 맞추지 않음 ${info}`;
});

// 폴드 안쪽 화면을 반씩 나눠 쓰면 창 폭이 절반이라 창 폭 기준 800%는 전체 화면 때의 절반 크기였다(2026-10 사용자 보고:
// 분할 화면에서 도면이 덜 커짐). 한도는 "화면을 다 쓰는 창"의 800% 쪽 폭. 창이 화면을 다 쓰면 그대로 800%.
await check('분할 화면(창 404px, 화면 823px)에서도 전체 화면 800%와 같은 크기까지 확대, 전체 화면으로 돌아오면 그 한도로', async () => {
  const gestureAt = (page, cdp, cx) => async (from, to) => {
    await touch(cdp, 'touchStart', [[cx - from / 2, 400], [cx + from / 2, 400]]);
    for (let k = 1; k <= 12; k++) { const d = from + (to - from) * k / 12; await touch(cdp, 'touchMove', [[cx - d / 2, 400], [cx + d / 2, 400]]); await page.waitForTimeout(16); }
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(400);
    return page.evaluate(() => ({ z: Number(document.getElementById('doc').style.getPropertyValue('--page-zoom') || 1), w: Math.round(document.querySelector('.page').getBoundingClientRect().width) }));
  };
  const out = {};
  {
    const { ctx, page } = await open(await tenPagePdf(), { width: 404, height: 640, full: 823 });
    await waitState(page, ['rendered']);
    const g = gestureAt(page, await ctx.newCDPSession(page), 202);
    await g(40, 380);
    out.split = await g(40, 380);
    await page.setViewportSize({ width: 823, height: 640 }); // 분할을 끝내고 전체 화면으로
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    out.back = await page.evaluate(() => ({ z: Number(document.getElementById('doc').style.getPropertyValue('--page-zoom') || 1), w: Math.round(document.querySelector('.page').getBoundingClientRect().width) }));
    await ctx.close();
  }
  for (const [key, opts] of [['whole', { width: 412, height: 915, full: 412 }], ['noBridge', { width: 404, height: 640 }]]) {
    const { ctx, page } = await open(await tenPagePdf(), opts);
    await waitState(page, ['rendered']);
    const g = gestureAt(page, await ctx.newCDPSession(page), opts.width / 2);
    await g(40, 380);
    out[key] = await g(40, 380);
    await ctx.close();
  }
  const fullMax = 8 * (823 - 12); // 전체 화면(823px)에서 800%일 때 쪽 폭
  const info = JSON.stringify(out);
  if (Math.abs(out.split.w - fullMax) > 2) return `분할 화면에서 전체 화면 800% 크기(${fullMax}px)까지 커지지 않음 ${info}`;
  if (Math.abs(out.back.w - fullMax) > 2 || Math.abs(out.back.z - 8) > 0.01) return `전체 화면으로 돌아와 한도(800%)로 줄지 않음 ${info}`;
  if (out.whole.z !== 8) return `창이 화면을 다 쓰면 800% 그대로여야 함 ${info}`;
  return out.noBridge.z === 8 ? '' : `앱이 화면 폭을 알려 주지 않으면 800% 그대로여야 함 ${info}`;
});

// 확대한 채 두 번 톡 누르면 화면 폭에 맞춘 크기(100%)로(구글 드라이브 PDF 보기처럼, 2026-10 사용자 요청).
// 한 번 누름·처음 크기에서의 두 번 누름·위쪽 바 위의 두 번 누름은 아무것도 하지 않는다.
await check('두 번 톡: 확대한 PDF는 100%로, 엑셀은 웹뷰 배율 1로(한 번 누름·100%·위쪽 바에서는 그대로)', async () => {
  const out = {};
  {
    const { ctx, page } = await open(await tenPagePdf());
    await waitState(page, ['rendered']);
    const cdp = await ctx.newCDPSession(page);
    const zoom = () => page.evaluate(() => Number(document.getElementById('doc').style.getPropertyValue('--page-zoom') || 1));
    const tap = async (x, y) => { await touch(cdp, 'touchStart', [[x, y]]); await touch(cdp, 'touchEnd', []); };
    const doubleTap = async (x, y) => { await tap(x, y); await page.waitForTimeout(80); await tap(x, y); await page.waitForTimeout(400); };
    await doubleTap(206, 500);
    out.atFit = await zoom();
    await touch(cdp, 'touchStart', [[186, 450], [226, 450]]);
    for (let k = 1; k <= 12; k++) { const d = 40 + 140 * k / 12; await touch(cdp, 'touchMove', [[206 - d / 2, 450], [206 + d / 2, 450]]); await page.waitForTimeout(16); }
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(400);
    out.zoomed = await zoom();
    await tap(206, 500);
    await page.waitForTimeout(500);
    out.singleTap = await zoom();
    // 확대해 내려가면 위쪽 바는 비켜 있다. 조금 올려 바가 다시 나오게 한 뒤 바 위를 두 번 누른다.
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollBy(0, -80));
    await page.waitForTimeout(500);
    out.barHit = await page.evaluate(() => { const t = document.elementFromPoint(206, 28); return t ? (t.closest('#bar') ? 'bar' : t.className || t.tagName) : null; });
    await doubleTap(206, 28); // 위쪽 바
    out.onBar = await zoom();
    await doubleTap(206, 500);
    out.reset = await zoom();
    out.pageW = await page.evaluate(() => [Math.round(document.querySelector('.page').getBoundingClientRect().width), innerWidth]);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(M('excel-rich.xlsx'));
    await waitState(page, ['rendered']);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await page.waitForTimeout(400);
    for (let k = 0; k < 2; k++) { await touch(cdp, 'touchStart', [[200, 600]]); await touch(cdp, 'touchEnd', []); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    out.excel = await page.evaluate(() => window.__zoomBy || []);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await page.waitForTimeout(300);
    for (let k = 0; k < 2; k++) { await touch(cdp, 'touchStart', [[200, 600]]); await touch(cdp, 'touchEnd', []); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
    out.excelAtOne = await page.evaluate(() => (window.__zoomBy || []).length);
    await ctx.close();
  }
  const info = JSON.stringify(out);
  if (out.atFit !== 1) return `100%에서 두 번 누르니 배율이 바뀜 ${info}`;
  if (!(out.zoomed > 1.5)) return `먼저 확대하지 못함 ${info}`;
  if (out.singleTap !== out.zoomed) return `한 번 누름에 배율이 바뀜 ${info}`;
  if (out.barHit !== 'bar') return `위쪽 바를 다시 보이게 하지 못함(시험 준비) ${info}`;
  if (out.onBar !== out.zoomed) return `위쪽 바에서 두 번 누름에 배율이 바뀜 ${info}`;
  if (out.reset !== 1 || out.pageW[0] !== out.pageW[1] - 12) return `두 번 눌러도 화면 폭(100%)으로 돌아오지 않음 ${info}`;
  if (out.excel.length !== 1 || Math.abs(out.excel[0] - 0.5) > 0.02) return `엑셀: 두 번 눌러 웹뷰 배율을 1로 되돌리지 않음 ${info}`;
  return out.excelAtOne === 1 ? '' : `엑셀: 배율 1에서 두 번 누름에도 배율을 바꿈 ${info}`;
});

// PDF로 저장(2026-10 사용자 요청): 앱의 인쇄 창 대신 page.pdf로 인쇄해 쪽 수·종이 크기를 본다.
// 휴대폰처럼 워드·PPT 엔진이 화면 근처만 그리게(navigator.webdriver가 참이면 엔진이 모든 쪽을 그려 시험이 되지 않는다) 따로 띄운다.
// 안드로이드 "PDF로 저장"은 정해 둔 종이만 받고 그 밖의 크기는 기본 종이로 바꾼다(AOSP PrintActivity). 그래서 화면이 앱에 넘긴
// 종이가 그 목록에 있는지 보고, 인쇄도 CSS @page가 아니라 앱에 넘긴 종이로 한다(안드로이드 웹뷰는 인쇄 창의 종이로 인쇄한다).
const pdfInfo = (buf) => {
  const s = buf.toString('latin1');
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(s);
  return { pages: (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length, size: box ? [Math.round(+box[1]), Math.round(+box[2])] : null };
};
await check('PDF로 저장: 한글 17쪽·워드 12쪽(화면엔 일부)·PPT 12장(화면엔 일부, 가로 A4)·엑셀·글 파일을 안드로이드 종이로, 끝나면 화면 원래대로, PDF 문서엔 메뉴 없음', async () => {
  const real = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'], ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  const bad = [];
  try {
    const cases = [
      ['hwp5.0.2.5.hwp', 17, [595, 842]],
      ['word-12-pages.docx', 12, [612, 792]],
      ['slides-12.pptx', 12, [842, 595]],
      ['excel-rich.xlsx', 1, [842, 595]],
      ['text-memo.txt', 1, [595, 842]],
      ['pdf-annotations.pdf', 0, null],
    ];
    for (const [f, want, size] of cases) {
      const { ctx, page } = await open(M(f), { print: true, via: real });
      try {
        await waitState(page, ['rendered']);
        await page.waitForTimeout(800);
        const before = await page.evaluate(() => document.querySelectorAll('[data-docx-page-index], .rpv-normalized-slide').length);
        const shown = await page.evaluate(() => { document.getElementById('menu-btn').click(); return !document.getElementById('menu-pdf').hidden; });
        if (!want) {
          if (shown) bad.push(`${f}: PDF 문서인데 "PDF로 저장"이 보임`);
          continue;
        }
        if (!shown) { bad.push(`${f}: 메뉴에 "PDF로 저장"이 없음`); continue; }
        await page.evaluate(() => document.getElementById('menu-pdf').click());
        await page.waitForFunction(() => window.__print, null, { timeout: 60000 });
        const paper = await page.evaluate(() => [window.__print.w, window.__print.h]);
        const known = [[210, 297], [297, 420], [148, 210], [250, 353], [176, 250], [257, 364], [182, 257], [215.9, 279.4], [215.9, 355.6], [279.4, 431.8]];
        if (!known.some(([a, b]) => Math.abs(Math.min(...paper) - a) < 0.5 && Math.abs(Math.max(...paper) - b) < 0.5)) bad.push(`${f}: 안드로이드 PDF 종이 목록에 없는 종이 ${paper}`);
        const pdf = await page.pdf({ width: `${paper[0]}mm`, height: `${paper[1]}mm`, printBackground: true });
        // PDF_OUT=폴더 이면 만든 PDF를 남긴다(눈으로 확인할 때)
        if (process.env.PDF_OUT) fs.writeFileSync(path.join(process.env.PDF_OUT, `${f}.pdf`), pdf);
        const info = pdfInfo(pdf);
        // 인쇄하는 동안 실제로 그려 둔 쪽·슬라이드 수(그리지 않은 자리도 쪽 나눔은 생겨 PDF 쪽 수만으로는 모자란다)
        const drawn = await page.evaluate(() => document.querySelectorAll('[data-docx-page-index], .rpv-normalized-slide').length);
        if (/docx|pptx/.test(f) && drawn !== want) bad.push(`${f}: 인쇄할 때 그려 둔 쪽·슬라이드 ${drawn}(기대 ${want})`);
        if (f.endsWith('.pptx')) {
          // 슬라이드(16:9)는 가로 A4에 맞춰 키우고 가운데에: 폭 ≈ 종이 폭의 99%, 위 여백 ≈ (종이 높이 - 슬라이드 높이) / 2
          await page.emulateMedia({ media: 'print' });
          const g = await page.evaluate(() => {
            const w = document.querySelector('[data-rpv-slide-wrapper]').getBoundingClientRect();
            const item = document.querySelector('[data-rpv-list-item]').getBoundingClientRect();
            return { w: Math.round(w.width), h: Math.round(w.height), top: Math.round(w.top - item.top) };
          });
          await page.emulateMedia({ media: null });
          const pw = (paper[0] / 25.4) * 96;
          const ph = (paper[1] / 25.4) * 96;
          if (Math.abs(g.w - pw * 0.99) > 3 || Math.abs(g.top - (ph - g.h) / 2) > 3) bad.push(`${f}: 슬라이드가 종이에 맞게 가운데 있지 않음 ${JSON.stringify(g)}(종이 ${Math.round(pw)}×${Math.round(ph)}px)`);
        }
        await page.evaluate(() => window.beDocsPrintDone());
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => ({ cls: document.documentElement.className, root: !!document.getElementById('print-root'), wait: !!document.querySelector('.print-wait'), name: window.__print.n }));
        if (info.pages !== want) bad.push(`${f}: ${info.pages}쪽(기대 ${want}쪽, 화면에 그려 둔 것 ${before})`);
        if (!info.size || Math.abs(info.size[0] - size[0]) > 2 || Math.abs(info.size[1] - size[1]) > 2) bad.push(`${f}: 종이 ${JSON.stringify(info.size)}(기대 ${size})`);
        if (/printing/.test(after.cls) || after.root || after.wait) bad.push(`${f}: 인쇄 뒤 화면이 원래대로 안 돌아옴 ${JSON.stringify(after)}`);
        if (after.name !== f.replace(/\.[^.]+$/, '')) bad.push(`${f}: 인쇄 이름 ${after.name}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await real.close();
  }
  return bad.join(' | ');
});

// 2026-11 사용자 요청: 일러스트레이터(.ai)는 PDF 호환 저장이면 PDF로 열고 한계를 알리며, 300MB 넘는 파일은 열 수 없다고 알린다.
await check('일러스트(ai): PDF 호환 파일은 그림과 한계 안내 띠·인쇄(PDF로 저장 없음), 300MB 넘는 파일은 크기와 함께 열 수 없다는 안내', async () => {
  const bad = [];
  {
    const { ctx, page } = await open(M('illustrator-pdf.ai'), { print: true });
    try {
      await waitState(page, ['rendered']);
      await page.waitForTimeout(600);
      const out = await page.evaluate(() => {
        document.getElementById('menu-btn').click();
        return {
          strip: document.getElementById('notes-strip').hidden ? '' : document.getElementById('notes-strip-text').textContent,
          canvas: document.querySelectorAll('.page canvas').length,
          print: !document.getElementById('menu-print').hidden,
          pdf: !document.getElementById('menu-pdf').hidden,
        };
      });
      if (!/일러스트레이터 파일은 함께 저장된 PDF 미리보기/.test(out.strip)) bad.push(`한계 안내 띠 없음 ${JSON.stringify(out)}`);
      if (!out.canvas) bad.push('그림을 그리지 않음');
      if (!out.print || out.pdf) bad.push(`메뉴 ${JSON.stringify(out)}(인쇄만 있어야 함)`);
    } finally {
      await ctx.close();
    }
  }
  {
    const { ctx, page } = await open(M('illustrator-pdf.ai'), { name: '큰 시안.ai', tooBig: 412 * 1048576 });
    try {
      await waitState(page, ['error']);
      const out = await page.evaluate(() => ({ r: window.__r.find((x) => x.state === 'error'), text: document.getElementById('notice').textContent, title: document.title, elsewhere: !!document.querySelector('#notice .btn-primary') }));
      if (out.r.reason !== 'too-big' || !/300MB가 넘는 파일은 열 수 없어요/.test(out.text) || !/412MB/.test(out.text)) bad.push(`300MB 안내 ${JSON.stringify(out)}`);
      if (!out.elsewhere) bad.push('300MB 안내에 다른 앱으로 열기 버튼 없음');
      if (!/큰 시안/.test(out.text)) bad.push(`파일 이름이 안 보임 ${out.text}`);
    } finally {
      await ctx.close();
    }
  }
  return bad.join(' | ');
});

// 2026-11 사용자 요청: CAD 도면(DWG·DXF). DWG는 LibreDWG(GPL-3.0, 약 11MB)를 도면을 열 때만 불러오고,
// DXF는 직접 읽는다(LibreDWG의 DXF 읽기는 10만 개에 112초). 다른 문서를 열 때는 CAD 파일을 하나도 받지 않는다.
async function bigDxf() {
  const file = path.join(tmp, 'big-100k.dxf');
  if (fs.existsSync(file)) return file;
  const out = ['  0', 'SECTION', '  2', 'ENTITIES'];
  for (let i = 0; i < 316; i++) {
    for (let j = 0; j < 316; j++) {
      out.push('  0', 'LINE', '  8', `L${i % 7}`, ' 62', String(((i + j) % 7) + 1), ' 10', String(i * 1000), ' 20', String(j * 1000), ' 11', String(i * 1000 + 800), ' 21', String(j * 1000 + 600));
    }
  }
  out.push('  0', 'ENDSEC', '  0', 'EOF');
  fs.writeFileSync(file, out.join('\n') + '\n');
  return file;
}

await check('CAD 도면: DWG·DXF를 그리고 한계 안내, 두 손가락 확대·두 번 톡 처음 크기·바탕 바꾸기(기억), 인쇄 메뉴 없음, 엔진은 DWG일 때만, 큰 DXF도 빨리', async () => {
  const bad = [];
  const real = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'], ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  try {
    // 1) 한국어 DXF: 직접 읽기, 안내 띠, 메뉴, 바탕, 손가락
    {
      const { ctx, page } = await open(M('cad-korean-cp949.dxf'), { via: real, print: true });
      const reqs = [];
      page.on('request', (r) => reqs.push(r.url()));
      try {
        await waitState(page, ['rendered']);
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => window.__r.find((x) => x.state === 'rendered'));
        if (r.kind !== 'cad' || r.reader !== 'dxf-read' || r.texts !== 2) bad.push(`DXF 보고 ${JSON.stringify(r)}`);
        if (reqs.some((u) => /libredwg/.test(u))) bad.push('DXF인데 DWG 엔진을 받음');
        const strip = await page.evaluate(() => (document.getElementById('notes-strip').hidden ? '' : document.getElementById('notes-strip-text').textContent));
        if (!/CAD 도면은 간단히 보여 줘요/.test(strip)) bad.push(`한계 안내 띠 없음: ${strip}`);
        const menu = await page.evaluate(() => {
          document.getElementById('menu-btn').click();
          const m = (id) => !document.getElementById(id).hidden;
          return { print: m('menu-print'), pdf: m('menu-pdf'), bg: m('menu-cad-bg') && document.getElementById('menu-cad-bg').textContent };
        });
        if (menu.print || menu.pdf || menu.bg !== '흰 바탕으로 보기') bad.push(`메뉴 ${JSON.stringify(menu)}`);
        const corner = () => page.evaluate(() => { const d = document.querySelector('.cad-canvas').getContext('2d').getImageData(4, 4, 1, 1).data; return [d[0], d[1], d[2]]; });
        const dark = await corner();
        await page.evaluate(() => document.getElementById('menu-cad-bg').click());
        await page.waitForTimeout(200);
        const white = await corner();
        if (!(dark[0] < 60 && white[0] > 240)) bad.push(`바탕 바꾸기: 어두운 ${dark} → 흰 ${white}`);
        const saved = await page.evaluate(() => localStorage.getItem('be-docs.cad-background'));
        if (saved !== 'paper') bad.push(`바탕을 기억하지 않음 ${saved}`);
        // 두 손가락으로 벌리면 커지고, 두 번 톡이면 처음 크기
        const cdp = await ctx.newCDPSession(page);
        const view = () => page.evaluate(() => window.__beDocsCadView());
        const fit = (await view()).s;
        await touch(cdp, 'touchStart', [[186, 450], [226, 450]]);
        for (let k = 1; k <= 12; k++) { const d = 40 + 200 * k / 12; await touch(cdp, 'touchMove', [[206 - d / 2, 450], [206 + d / 2, 450]]); await page.waitForTimeout(16); }
        await touch(cdp, 'touchEnd', []);
        await page.waitForTimeout(400);
        const zoomed = (await view()).s;
        const tap = async () => { await touch(cdp, 'touchStart', [[206, 500]]); await touch(cdp, 'touchEnd', []); };
        await tap();
        await page.waitForTimeout(80);
        await tap();
        await page.waitForTimeout(400);
        const back = (await view()).s;
        if (!(zoomed > fit * 3)) bad.push(`두 손가락 확대: ${fit} → ${zoomed}`);
        if (Math.abs(back / fit - 1) > 0.01) bad.push(`두 번 톡: ${zoomed} → ${back}(처음 ${fit})`);
        // 웹뷰 자체 확대는 일어나지 않아야 한다(캔버스가 직접 처리)
        const vv = await page.evaluate(() => (window.visualViewport ? visualViewport.scale : 1));
        if (Math.abs(vv - 1) > 0.01) bad.push(`웹뷰 배율이 바뀜 ${vv}`);
      } finally {
        await ctx.close();
      }
    }
    // 2) 기억한 흰 바탕으로 다시 열림 + DWG는 LibreDWG로
    {
      const { ctx, page } = await open(M('cad-2018.dwg'), { via: real, init: () => { try { localStorage.setItem('be-docs.cad-background', 'paper'); } catch (_) {} } });
      try {
        await waitState(page, ['rendered']);
        const r = await page.evaluate(() => window.__r.find((x) => x.state === 'rendered'));
        if (r.reader !== 'libredwg' || !(r.strokes > 50)) bad.push(`DWG 보고 ${JSON.stringify(r)}`);
        const c = await page.evaluate(() => { const d = document.querySelector('.cad-canvas').getContext('2d').getImageData(4, 4, 1, 1).data; return d[0]; });
        if (c < 240) bad.push(`기억한 흰 바탕으로 열리지 않음 ${c}`);
        const strip = await page.evaluate(() => [...document.querySelectorAll('#notes-list .info-note-text')].map((n) => n.textContent).join(' | '));
        if (!/그리지 못한 개체 \d+개\(/.test(strip)) bad.push(`그리지 못한 개체 안내 없음: ${strip}`);
      } finally {
        await ctx.close();
      }
    }
    // 3) 다른 문서(PDF·한글)는 CAD 파일을 하나도 받지 않는다
    for (const f of ['pdf-1.7.pdf', 'hwp5.0.2.5.hwp']) {
      const { ctx, page } = await open(M(f), { via: real });
      const reqs = [];
      page.on('request', (r) => reqs.push(r.url()));
      try {
        await waitState(page, ['rendered']);
        const cad = reqs.filter((u) => /libredwg|cad-|dxf-read/.test(u));
        if (cad.length) bad.push(`${f}: CAD 파일을 받음 ${cad.map((u) => u.split('/').pop())}`);
      } finally {
        await ctx.close();
      }
    }
    // 4) 선 10만 개 DXF: 5초 안에 열리고, 읽는 동안 화면 스레드가 오래 멈추지 않는다(읽기는 작업 스레드)
    {
      const { ctx, page } = await open(await bigDxf(), {
        via: real,
        init: () => {
          window.__long = [];
          try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch (_) {}
        },
      });
      try {
        const t0 = Date.now();
        await waitState(page, ['rendered'], 60000);
        const ms = Date.now() - t0;
        const r = await page.evaluate(() => ({ r: window.__r.find((x) => x.state === 'rendered'), long: Math.max(0, ...window.__long), draw: window.__beDocsCadView().lastDrawMs }));
        if (ms > 5000 || r.r.strokes !== 99856) bad.push(`큰 DXF ${ms}ms ${JSON.stringify(r.r)}`);
        if (r.long > 600) bad.push(`큰 DXF: 화면이 ${r.long}ms 멈춤(한 번 그리기 ${Math.round(r.draw)}ms)`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await real.close();
  }
  return bad.join(' | ');
});

// CI #86·#88(웹뷰 113): 워드 엔진의 "화면 근처 쪽만 그리기"가 표준 CSS zoom 전 크롬에서 쪽 위치를 두 배쯤 잘못 재
// 끝까지 내려도 뒤쪽 쪽이 그려지지 않았다. 표준 zoom이 없는 판(Element.currentCSSZoom 없음)에서는 모든 쪽을 그린다.
await check('워드 쪽 모양: 표준 CSS zoom이 없는 옛 웹뷰(크롬 128 전)는 모든 쪽을, 최신은 화면 근처만 그리고 끝까지 내리면 마지막 쪽', async () => {
  const real = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'], ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  const bad = [];
  try {
    for (const old of [false, true]) {
      const { ctx, page } = await open(M('word-12-pages.docx'), { via: real, init: old ? () => { delete Element.prototype.currentCSSZoom; } : null });
      try {
        await waitState(page, ['rendered']);
        await page.waitForTimeout(1000);
        const drawn = () => page.evaluate(() => [...document.querySelectorAll('[data-docx-page-index]')].map((e) => +e.dataset.docxPageIndex));
        const first = await drawn();
        await page.evaluate(() => { const h = document.querySelector('.word-host'); h.scrollTop = h.scrollHeight; });
        await page.waitForTimeout(1000);
        const end = await drawn();
        if (old && first.length !== 12) bad.push(`옛 웹뷰: 처음에 그린 쪽 ${first}(12쪽 모두여야 함)`);
        if (!old && first.length >= 12) bad.push(`최신 웹뷰: 처음부터 모든 쪽을 그림 ${first}(화면 근처만이어야 함)`);
        if (!end.includes(11)) bad.push(`${old ? '옛' : '최신'} 웹뷰: 끝까지 내려도 마지막 쪽이 없음 ${end}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await real.close();
  }
  return bad.join(' | ');
});

await check('인쇄: PPT는 프린터 여백(10mm) 안에 가운데, PDF 문서는 원본을 인쇄 창에(종이·쪽 수), 인쇄를 막은 PDF는 이유만 알림', async () => {
  const real = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'], ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  const bad = [];
  try {
    {
      const { ctx, page } = await open(M('slides-12.pptx'), { print: true, via: real });
      try {
        await waitState(page, ['rendered']);
        await page.waitForTimeout(800);
        const items = await page.evaluate(() => {
          document.getElementById('menu-btn').click();
          return { print: !document.getElementById('menu-print').hidden, pdf: !document.getElementById('menu-pdf').hidden };
        });
        if (!items.print || !items.pdf) bad.push(`PPT: 메뉴 ${JSON.stringify(items)}(인쇄·PDF로 저장 둘 다 있어야 함)`);
        await page.evaluate(() => document.getElementById('menu-print').click());
        await page.waitForFunction(() => window.__print, null, { timeout: 60000 });
        const paper = await page.evaluate(() => [window.__print.w, window.__print.h]);
        const info = pdfInfo(await page.pdf({ width: `${paper[0]}mm`, height: `${paper[1]}mm`, printBackground: true }));
        await page.emulateMedia({ media: 'print' });
        const g = await page.evaluate(() => {
          const w = document.querySelector('[data-rpv-slide-wrapper]').getBoundingClientRect();
          const item = document.querySelector('[data-rpv-list-item]').getBoundingClientRect();
          return { w: Math.round(w.width), h: Math.round(w.height), top: Math.round(w.top - item.top) };
        });
        await page.emulateMedia({ media: null });
        const m = (10 / 25.4) * 96;
        const aw = (paper[0] / 25.4) * 96 - 2 * m;
        const ah = (paper[1] / 25.4) * 96 - 2 * m;
        if (info.pages !== 12 || !info.size || Math.abs(info.size[0] - 842) > 2) bad.push(`PPT 인쇄: ${info.pages}쪽 ${JSON.stringify(info.size)}(기대 12쪽 가로 A4)`);
        if (Math.abs(g.w - aw * 0.99) > 3 || Math.abs(g.top - (ah - g.h) / 2) > 3) bad.push(`PPT 인쇄: 슬라이드가 여백 안에 가운데 있지 않음 ${JSON.stringify(g)}(여백 안 ${Math.round(aw)}×${Math.round(ah)}px)`);
        await page.evaluate(() => window.beDocsPrintDone());
      } finally {
        await ctx.close();
      }
    }
    for (const [f, blocked] of [['pdf-mixed-sizes.pdf', false], ['pdf-no-print-copy.pdf', true]]) {
      const { ctx, page } = await open(M(f), { print: true, via: real });
      try {
        await waitState(page, ['rendered']);
        await page.waitForTimeout(800);
        const items = await page.evaluate(() => {
          document.getElementById('menu-btn').click();
          return { print: !document.getElementById('menu-print').hidden, pdf: !document.getElementById('menu-pdf').hidden };
        });
        if (!items.print || items.pdf) { bad.push(`${f}: 메뉴 ${JSON.stringify(items)}(인쇄만 있어야 함)`); continue; }
        await page.evaluate(() => document.getElementById('menu-print').click());
        await page.waitForTimeout(500);
        const out = await page.evaluate(() => ({ call: window.__printFile || null, msg: document.querySelector('.print-wait')?.textContent || '', pages: document.querySelectorAll('.page').length }));
        if (blocked) {
          if (out.call || !/인쇄를 막아/.test(out.msg)) bad.push(`${f}: 인쇄를 막은 PDF인데 ${JSON.stringify(out)}`);
        } else {
          const c = out.call;
          // 첫 쪽이 A4 세로인 문서: A4 종이, 쪽 수는 문서 그대로, 이름은 확장자 없이
          if (!c || c.n !== f.replace(/\.pdf$/, '') || Math.round(c.w) !== 210 || Math.round(c.h) !== 297 || c.pages !== out.pages) bad.push(`${f}: 인쇄 창에 넘긴 값 ${JSON.stringify(out)}`);
          await page.evaluate(() => window.beDocsPrintDone());
          const again = await page.evaluate(() => { document.getElementById('menu-btn').click(); document.getElementById('menu-btn').click(); return !document.getElementById('menu-print').hidden; });
          if (!again) bad.push(`${f}: 인쇄 창이 닫힌 뒤 다시 인쇄할 수 없음`);
        }
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await real.close();
  }
  return bad.join(' | ');
});

// 도면(CAD)처럼 작은 닫힌 도형이 수만 개인 PDF. 2026-10 폴드에서 "확대·축소가 잘되다가 어느 순간 먹통"의 원인:
// 최신 크롬은 Path2D.closePath()가 경로 길이에 비례해 느려 pdf.js가 쪽 하나를 그리는 데 화면 처리를 2초 넘게 붙잡았고
// (viewer-libs/patch-pdfjs.mjs로 고침), 두 손가락으로 쪽 폭을 바꿀 때마다 글자 층 수천 조각을 다시 배치해 움직임마다 수백 ms가 걸렸다.
async function cadPdf() {
  const file = path.join(tmp, 'cad-like.pdf');
  if (fs.existsSync(file)) return file;
  const gen = await browser.newPage();
  await gen.setContent('<body style="margin:0"></body>');
  await gen.evaluate(() => {
    for (let p = 0; p < 4; p++) {
      let seed = p + 1;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      let d = '';
      for (let i = 0; i < 20000; i++) d += `M${(rnd() * 780).toFixed(1)} ${(rnd() * 1080).toFixed(1)}l2 3l2 -3z`;
      let words = '';
      for (let i = 0; i < 300; i++) words += `<text x="${(rnd() * 700).toFixed(0)}" y="${(rnd() * 1080).toFixed(0)}" font-size="6">작업대(1200*700)</text>`;
      const s = document.createElement('section');
      s.style.cssText = 'height:1123px;page-break-after:always';
      s.innerHTML = `<svg width="794" height="1123" viewBox="0 0 794 1123"><path d="${d}" fill="none" stroke="#000" stroke-width="0.4"/>${words}</svg>`;
      document.body.append(s);
    }
  });
  await gen.pdf({ path: file, format: 'A4' });
  await gen.close();
  return file;
}

await check('도면처럼 선이 수만 개인 PDF를 폴드 크기·폰 속도로: 쪽을 그리는 동안 화면 처리가 오래 멈추지 않고, 두 손가락 축소·확대가 움직임마다 바로 반응', async () => {
  const src = await (await fetch(`${base}/viewer/vendor/pdfjs/pdf.mjs`)).text();
  if (!src.includes('/*be-docs:path-string*/')) return 'pdf.js 경로 만들기 패치가 빠짐(scripts/fetch-vendor.sh → viewer-libs/patch-pdfjs.mjs)';
  const { ctx, page } = await open(await cadPdf(), {
    width: 904, height: 1088, dpr: 2, throttle: 4,
    init: () => {
      window.__long = [];
      window.__frames = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {}
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__frames.push(Math.round(e.duration)); }).observe({ type: 'long-animation-frame' }); } catch { window.__frames = null; }
    },
  });
  await waitState(page, ['rendered'], 120000);
  await page.waitForTimeout(4000); // 화면 근처 쪽들을 다 그릴 때까지
  const opening = await page.evaluate(() => Math.max(0, ...window.__long.splice(0)));
  const cdp = await ctx.newCDPSession(page);
  const pinch = async (from, to) => {
    await page.evaluate(() => { if (window.__frames) window.__frames.length = 0; window.__long.length = 0; });
    const t = Date.now();
    await touch(cdp, 'touchStart', [[452 - from / 2, 544], [452 + from / 2, 544]]);
    for (let k = 1; k <= 12; k++) { const d = from + (to - from) * k / 12; await touch(cdp, 'touchMove', [[452 - d / 2, 544], [452 + d / 2, 544]]); await page.waitForTimeout(16); }
    await touch(cdp, 'touchEnd', []);
    const took = Date.now() - t;
    await page.waitForTimeout(1500);
    return page.evaluate((took) => ({
      took,
      zoom: document.getElementById('doc').style.getPropertyValue('--page-zoom') || '1',
      slowFrames: window.__frames ? window.__frames.filter((d) => d > 200).length : -1,
      longest: Math.max(0, ...window.__long),
    }), took);
  };
  const out = await pinch(500, 150);
  const back = await pinch(150, 375); // 40% × 2.5 = 100%
  await ctx.close();
  const info = JSON.stringify({ opening, out, back });
  // 고치기 전(같은 조건): 여는 중 한 번에 약 10초 멈춤, 동작 하나에 프레임 12개가 각각 0.4초 넘게 걸림
  if (opening > 2500) return `쪽을 그리는 동안 화면 처리가 ${opening}ms 멈춤 ${info}`;
  if (!(Number(out.zoom) < 0.6) || back.zoom !== '1') return `줄이거나 다시 키우지 못함 ${info}`;
  if (out.slowFrames > 3 || back.slowFrames > 3) return `손가락을 움직이는 동안 느린 프레임이 많음(쪽 폭이 바뀔 때마다 다시 배치) ${info}`;
  return Math.max(out.longest, back.longest) < 2500 ? '' : `동작 중 화면 처리가 오래 멈춤 ${info}`;
});

await check('확대하면 보이는 부분을 화면 해상도로 다시 그려 겹치고(흐리지 않게), 되돌리면 지움', async () => {
  const { ctx, page } = await open(await tenPagePdf(), { dpr: 2 });
  await waitState(page, ['rendered']);
  await page.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(page);
  const pinch = async (from, to) => {
    await touch(cdp, 'touchStart', [[206 - from / 2, 400], [206 + from / 2, 400]]);
    for (let k = 1; k <= 12; k++) { const d = from + (to - from) * k / 12; await touch(cdp, 'touchMove', [[206 - d / 2, 400], [206 + d / 2, 400]]); await page.waitForTimeout(16); }
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(1500);
  };
  // 쪽 확대(쪽 폭) × 웹뷰 배율. 그림 밀도는 CSS px당 캔버스 픽셀이라 화면 밀도(dpr 2 × 웹뷰 배율)면 흐리지 않다.
  const look = () => page.evaluate(() => {
    const vv = visualViewport;
    const cx = vv.offsetLeft + vv.width / 2;
    const cy = vv.offsetTop + vv.height / 2;
    const z = Number(document.getElementById('doc').style.getPropertyValue('--page-zoom') || 1);
    return {
      s: Math.round(vv.scale * 100) / 100,
      zoom: Math.round(vv.scale * z * 100) / 100,
      base: Math.max(0, ...[...document.querySelectorAll('canvas.pdf-base')].map((c) => Math.round((c.width / c.getBoundingClientRect().width) * 100) / 100)),
      details: [...document.querySelectorAll('canvas.pdf-detail')].map((c) => {
        const r = c.getBoundingClientRect();
        return { density: Math.round((c.width / r.width) * 100) / 100, coversCenter: r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy };
      }),
    };
  });
  await pinch(100, 380);
  const zoomed = await look();
  await pinch(380, 100);
  const back = await look();
  await ctx.close();
  const info = JSON.stringify({ zoomed, back });
  if (!(zoomed.zoom > 2)) return `확대되지 않음 ${info}`;
  const sharp = zoomed.details.filter((d) => d.coversCenter && d.density >= zoomed.s * 2 * 0.85 && d.density >= zoomed.base * 2);
  if (!sharp.length) return `확대한 부분을 화면 해상도로 다시 그리지 않음(흐림) ${info}`;
  return back.details.length === 0 && back.zoom === 1 ? '' : `되돌렸는데 겹친 그림이 남음 ${info}`;
});

// 쪽마다 /Rotate 0·90·180·270인 PDF(글자는 표준 글꼴 Helvetica)
function rotatedPdf() {
  const file = path.join(tmp, 'rotated.pdf');
  if (fs.existsSync(file)) return file;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const rot of [0, 90, 180, 270]) {
    let text = 'BT /F1 28 Tf 60 760 Td';
    for (let k = 0; k < 6; k++) text += `${k ? ' 0 -110 Td' : ''} (XXXXXXXX ROT${rot}) Tj`;
    text += ' ET';
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Rotate ${rot} /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length + 2} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, pdf, 'latin1');
  return file;
}

await check('회전된 쪽(90·180·270도)도 글자 층이 실제 글자 위에 있음(길게 눌러 고르기·찾기 표시 위치)', async () => {
  const { ctx, page } = await open(rotatedPdf(), { dpr: 2 });
  await waitState(page, ['rendered']);
  const res = [];
  for (let p = 0; p < 4; p++) {
    await page.evaluate((i) => document.querySelectorAll('.page')[i].scrollIntoView(), p);
    await page.waitForFunction((i) => document.querySelectorAll('.page')[i].querySelectorAll('.textLayer span').length >= 6
      && document.querySelectorAll('.page')[i].querySelector('canvas.pdf-base'), p, { timeout: 15000 });
    await page.waitForTimeout(500);
    // 글자 조각 자리의 캔버스에 어두운 점(실제 글자)이 얼마나 있는지
    res.push(await page.evaluate((i) => {
      const pg = document.querySelectorAll('.page')[i];
      const c = pg.querySelector('canvas.pdf-base');
      const g = c.getContext('2d');
      const pr = pg.getBoundingClientRect();
      const sx = c.width / pr.width;
      const sy = c.height / pr.height;
      return Math.min(...[...pg.querySelectorAll('.textLayer span')].filter((s) => s.textContent.includes('XXXX')).map((s) => {
        const b = s.getBoundingClientRect();
        const d = g.getImageData(Math.max(0, Math.floor((b.left - pr.left) * sx)), Math.max(0, Math.floor((b.top - pr.top) * sy)),
          Math.max(1, Math.floor(b.width * sx)), Math.max(1, Math.floor(b.height * sy))).data;
        let dark = 0;
        for (let k = 0; k < d.length; k += 4) if (d[k] < 128) dark++;
        return Math.round((dark / (d.length / 4)) * 100);
      }));
    }, p));
  }
  await ctx.close();
  // 맞으면 조각마다 약 20%, 어긋나면 0~6%
  return res.every((v) => v >= 10) ? '' : `글자 층이 실제 글자와 어긋남(쪽별 최소 어두운 점 비율 %) ${JSON.stringify(res)}`;
});

// ---- PDF 이미지로 변환
const openExport = async (page) => {
  // 내려 읽는 중에는 위쪽 바가 비켜 있어 page.click이 바를 보이려고 문서를 끌어올린다. 보던 쪽이 바뀌지 않게 직접 누른다.
  await page.evaluate(() => { document.getElementById('menu-btn').click(); document.getElementById('menu-export').click(); });
  await page.waitForSelector('#export-panel:not([hidden])');
  await page.waitForTimeout(300);
};
const exportState = (page) => page.evaluate(() => ({
  selected: [...document.querySelectorAll('.export-thumb.on')].map((b) => Number(b.dataset.i) + 1),
  count: document.querySelector('.export-count').textContent,
  msg: document.querySelector('.export-msg').textContent,
  open: !document.getElementById('export-panel').hidden,
  log: window.__exp ? window.__exp.log.filter((l) => l !== 'part') : [],
}));
// 앱이 받은 그림을 풀어 크기를 잰다
const exportedImages = (page) => page.evaluate(() => Promise.all((window.__exp.images || []).map(async (im) => {
  const parts = im.parts.map((b) => {
    const bin = atob(b);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  });
  const blob = new Blob(parts, { type: im.mime });
  const bmp = await createImageBitmap(blob);
  return { name: im.name, mime: im.mime, w: bmp.width, h: bmp.height, kb: Math.round(blob.size / 1024) };
})));

await check('이미지로 변환: 지금 보던 쪽이 골라진 채 열리고, "2-4, 7"로 고른 4쪽을 순서대로 기본 400dpi PNG로 앱에 넘기고 창이 닫힘(공유하기)', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  await page.evaluate(() => document.querySelectorAll('.page')[2].scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  await openExport(page);
  const first = await exportState(page);
  await page.fill('.export-range input', '2-4, 7');
  await page.click('.export-range button');
  const picked = await exportState(page);
  await page.click('.export-actions .btn-primary');
  await page.waitForFunction(() => window.__exp && window.__exp.log.includes('end'), null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const after = await exportState(page);
  const images = await exportedImages(page);
  const told = await page.evaluate(() => window.__back[window.__back.length - 1]);
  await ctx.close();
  const info = JSON.stringify({ images: images.map((m) => `${m.name} ${m.mime} ${m.w}x${m.h}`), first, picked, after });
  if (first.selected.join() !== '3') return `지금 쪽(3)이 미리 골라지지 않음 ${info}`;
  if (picked.selected.join() !== '2,3,4,7' || picked.count !== '4쪽 선택') return `범위로 고르지 못함 ${info}`;
  if (after.log.join() !== 'begin:share,end' || after.open) return `공유하기 흐름이 다름 ${info}`;
  if (images.map((m) => m.name).join() !== 'ten-pages_p02.png,ten-pages_p03.png,ten-pages_p04.png,ten-pages_p07.png') return `이름·순서가 다름 ${info}`;
  // A4 400dpi ≈ 3307×4677(크롬이 만든 A4는 595.9×842.9pt라 3310×4682). 글자만 있는 쪽은 PNG
  if (!images.every((m) => m.mime === 'image/png' && Math.abs(m.w - 3308) <= 5 && Math.abs(m.h - 4680) <= 8)) return `해상도·종류가 다름 ${info}`;
  return told === false ? '' : '창을 닫았는데 뒤로 가기 대상을 풀지 않음';
});

await check('이미지로 변환: 600dpi는 쪽마다 600dpi PNG(A3도 줄이지 않음, 한 장 1억5천만 화소 안)(사진첩에 저장)', async () => {
  const { ctx, page } = await open(M('pdf-mixed-sizes.pdf'));
  await waitState(page, ['rendered']);
  await openExport(page);
  await page.click('.export-q[data-q="dpi600"]');
  await page.click('.export-all');
  const st = await exportState(page);
  await page.click('.export-actions .btn:not(.btn-primary)');
  await page.waitForFunction(() => window.__exp && window.__exp.log.includes('end'), null, { timeout: 90000 });
  const images = await exportedImages(page);
  const sizes = await page.evaluate(() => [...document.querySelectorAll('.page')].map((p) => p.style.aspectRatio));
  await ctx.close();
  const info = JSON.stringify({ st, images, sizes });
  if (st.selected.length !== images.length || !images.length) return `전체를 넘기지 않음 ${info}`;
  if (!images.every((m) => m.mime === 'image/png' && m.name.endsWith('.png'))) return `PNG가 아님 ${info}`;
  if (!images.every((m) => m.w * m.h <= 150e6 * 1.001)) return `화소 상한을 넘음 ${info}`;
  // 변 = pt × 600/72(아주 큰 쪽만 상한까지 줄임)
  const ok = images.every((m, i) => {
    const [w, h] = sizes[i].split('/').map(Number);
    const want = Math.min(600 / 72, Math.sqrt(150e6 / (w * h)), 16384 / Math.max(w, h));
    return Math.abs(m.w - Math.floor(w * want)) <= 2;
  });
  return ok ? '' : `해상도가 600dpi(또는 상한)가 아님 ${info}`;
});

await check('이미지로 변환: 사진이 많은 쪽은 JPG, 휴대폰 메모리가 모자라 큰 그림을 못 만들면 줄여서 다시 만들어 넘김(실패로 끝나지 않음)', async () => {
  // 1,000만 화소가 넘는 캔버스는 그림으로 바꾸지 못하는 폰을 흉내 낸다(toBlob이 null).
  const { ctx, page } = await open(await photoPdf(), {
    init: () => {
      const orig = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
        if (this.width * this.height > 10e6) { setTimeout(() => cb(null), 0); return; }
        return orig.call(this, cb, ...rest);
      };
    },
  });
  await waitState(page, ['rendered'], 120000);
  await openExport(page);
  await page.click('.export-actions .btn-primary');
  await page.waitForFunction(() => window.__exp && (window.__exp.log.includes('end') || window.__exp.log.includes('cancel')), null, { timeout: 120000 });
  const st = await exportState(page);
  const images = await exportedImages(page);
  await ctx.close();
  const info = JSON.stringify({ st, images });
  // A4 400dpi(1,550만 화소)는 막히고 0.7배(약 760만 화소)로 만들어야 한다
  if (!st.log.includes('end') || images.length !== 1) return `다시 만들지 못하고 실패함 ${info}`;
  if (images[0].mime !== 'image/jpeg' || !images[0].name.endsWith('.jpg')) return `사진 쪽이 JPG가 아님 ${info}`;
  const px = images[0].w * images[0].h;
  return px <= 10e6 && px > 5e6 ? '' : `줄인 크기가 이상함 ${info}`;
});

await check('이미지로 변환: 띠로 나눠 이어 쓴 PNG가 쪽을 통째로 그린 것과 같음(띠 경계에 줄이 생기지 않음)', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  await openExport(page);
  await page.click('.export-actions .btn-primary');
  await page.waitForFunction(() => window.__exp && window.__exp.log.includes('end'), null, { timeout: 120000 });
  const r = await page.evaluate(async () => {
    const im = window.__exp.images[0];
    const parts = im.parts.map((x) => {
      const bin = atob(x);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    });
    const bmp = await createImageBitmap(new Blob(parts, { type: im.mime }));
    // 같은 쪽을 같은 배율로 한 번에 그린다
    const L = await import('./vendor/pdfjs/pdf.mjs');
    L.GlobalWorkerOptions.workerSrc = new URL('./pdf-worker.js', location.href).href;
    const data = new Uint8Array(await (await fetch('/doc/file')).arrayBuffer());
    const doc = await L.getDocument({ data, standardFontDataUrl: 'vendor/pdfjs/standard_fonts/', isEvalSupported: false }).promise;
    const p = await doc.getPage(Number(im.name.match(/_p0*(\d+)\./)[1]));
    const viewport = p.getViewport({ scale: 400 / 72 });
    const c = document.createElement('canvas');
    c.width = Math.floor(viewport.width);
    c.height = Math.floor(viewport.height);
    await p.render({ canvas: c, viewport, annotationMode: L.AnnotationMode.ENABLE }).promise;
    if (c.width !== bmp.width || c.height !== bmp.height) return { size: [c.width, c.height, bmp.width, bmp.height] };
    const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const c2 = document.createElement('canvas');
    c2.width = bmp.width;
    c2.height = bmp.height;
    c2.getContext('2d').drawImage(bmp, 0, 0);
    const b = c2.getContext('2d').getImageData(0, 0, c2.width, c2.height).data;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 8) diff++;
    return { diff, total: a.length / 4, strips: Math.ceil(c.height / Math.floor(8e6 / c.width)) };
  });
  await ctx.close();
  if (r.size) return `크기가 다름 ${JSON.stringify(r)}`;
  if (r.strips < 2) return `띠가 하나뿐이라 경계를 보지 못함 ${JSON.stringify(r)}`;
  return r.diff <= r.total * 1e-4 ? '' : `통째로 그린 것과 다름 ${JSON.stringify(r)}`;
});

await check('이미지로 변환: 잘못된 범위는 알려 주고 고른 쪽을 바꾸지 않음, "3-1"·"8-"·"~2" 같은 표기도 알아들음', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  await openExport(page);
  const tryRange = async (v) => {
    await page.fill('.export-range input', v);
    await page.click('.export-range button');
    return exportState(page);
  };
  const before = await exportState(page);
  const bad = [];
  for (const v of ['0-3', 'abc', '11', '2,,x']) {
    const st = await tryRange(v);
    if (st.selected.join() !== before.selected.join() || !st.msg) bad.push(`${v}: ${JSON.stringify(st)}`);
  }
  const good = {};
  for (const v of ['3-1', '8-', '~2', '5쪽, 6 - 7']) good[v] = (await tryRange(v)).selected.join();
  await ctx.close();
  if (bad.length) return `잘못된 범위를 받아들이거나 알리지 않음 ${bad.join(' / ')}`;
  const want = { '3-1': '1,2,3', '8-': '8,9,10', '~2': '1,2', '5쪽, 6 - 7': '5,6,7' };
  return JSON.stringify(good) === JSON.stringify(want) ? '' : `범위를 잘못 읽음 ${JSON.stringify(good)}`;
});

await check('이미지로 변환: 만드는 중 뒤로 가기는 그만두고(앱에 취소, 끝내기는 안 부름) 창은 남아 알리고, 다시 뒤로 가기로 닫힘', async () => {
  const { ctx, page } = await open(await tenPagePdf(), { throttle: 6 });
  await waitState(page, ['rendered'], 120000);
  await openExport(page);
  await page.click('.export-q[data-q="dpi600"]');
  await page.click('.export-all');
  await page.click('.export-actions .btn-primary');
  await page.waitForFunction(() => window.__exp && window.__exp.images.length >= 1, null, { timeout: 120000 });
  const mid = await page.evaluate(() => window.beDocsBack());
  await page.waitForFunction(() => window.__exp.log.includes('cancel') || window.__exp.log.includes('end'), null, { timeout: 120000 });
  await page.waitForTimeout(500);
  const st = await exportState(page);
  const made = await page.evaluate(() => window.__exp.images.length);
  const closed = await page.evaluate(() => window.beDocsBack() && document.getElementById('export-panel').hidden);
  await ctx.close();
  const info = JSON.stringify({ mid, st, made });
  if (!mid || st.log.includes('end') || !st.log.includes('cancel')) return `그만두지 않음 ${info}`;
  if (!st.open || !st.msg) return `창이 닫히거나 알리지 않음 ${info}`;
  if (made >= 10) return `다 만든 뒤에야 멈춤 ${info}`;
  return closed ? '' : '다시 뒤로 가기로 닫히지 않음';
});

await check('이미지로 변환: 앱이 그림을 받지 못하면(저장 공간 부족 등) 실패를 알리고 앱에 취소를 알림', async () => {
  const { ctx, page } = await open(await tenPagePdf());
  await waitState(page, ['rendered']);
  await openExport(page);
  await page.evaluate(() => { window.__expFail = true; });
  await page.click('.export-actions .btn:not(.btn-primary)');
  await page.waitForFunction(() => window.__exp && window.__exp.log.includes('cancel'), null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const st = await exportState(page);
  const reported = await page.evaluate(() => window.__r.some((r) => r.state === 'export-error'));
  await ctx.close();
  if (st.log.includes('end') || !st.open) return `실패했는데 끝냄 ${JSON.stringify(st)}`;
  if (!/저장하지 못했어요/.test(st.msg)) return `실패를 알리지 않음 ${JSON.stringify(st)}`;
  return reported ? '' : '실패를 앱 기록으로 남기지 않음';
});

await check('이미지로 변환: 작성자가 인쇄·복사를 막은 PDF는 변환하지 않고 이유를 알림(보기는 그대로)', async () => {
  const { ctx, page } = await open(M('pdf-no-print-copy.pdf'));
  await waitState(page, ['rendered']);
  await page.waitForTimeout(300);
  await openExport(page);
  await page.click('.export-actions .btn-primary');
  await page.waitForTimeout(800);
  const st = await exportState(page);
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas.pdf-base').length);
  await ctx.close();
  if (st.log.length) return `앱에 넘김 ${JSON.stringify(st)}`;
  if (!/인쇄와 복사를 막아/.test(st.msg)) return `이유를 알리지 않음 ${JSON.stringify(st)}`;
  return canvases ? '' : '문서가 보이지 않음';
});

console.log(`\n합계: 통과 ${pass}, 실패 ${fail}`);
fs.rmSync(tmp, { recursive: true, force: true });
await browser.close();
process.exit(fail ? 1 : 0);
