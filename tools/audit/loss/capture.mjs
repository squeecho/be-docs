// 완전성 오라클 1단계: 뷰어가 "화면에 실제로 보여준 것"을 파일마다 모은다.
//
// 사용법:
//   node capture.mjs --viewer <viewer 폴더> [--vendor <vendor 폴더>] --list <목록> --out <out.jsonl>
//                    [--shots <스크린샷 폴더>] [--ports 8941,8942] [--max-pages 40] [--resume]
//   목록: 한 줄에 "절대경로" 또는 "절대경로<TAB>비밀번호" (비밀번호 문서는 그 비밀번호로 연다)
//   --ports 개수만큼 흉내 서버(tools/web-test/server.mjs)를 띄우고 그만큼 병렬로 연다(최대 2 권장).
//
// 파일마다 JSONL 한 줄: { id, file, final(마지막 보고), reports, notes(안내 띠 글자), notice(오류 화면 글자),
//   kind별 내용: sheet → sheets[{label, rows, cols, cells, text, images, imagesBroken, note, empty}]
//              word/slides/simple → text, media(그림·svg·캔버스·동영상 수, 깨진 그림 수)
//              pdf/hwp → pages[{i, text, ok, err, images}] (최대 --max-pages 쪽)
//   shot: 첫 화면 스크린샷 경로 }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadPlaywright } from '../../web-test/playwright.mjs';
const { chromium } = loadPlaywright();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const viewer = path.resolve(args.viewer);
const vendor = path.resolve(args.vendor || path.join(viewer, 'vendor'));
const ports = String(args.ports || '8941').split(',').map(Number);
const maxPages = Number(args['max-pages'] || 40);
const shots = args.shots ? path.resolve(args.shots) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const serverJs = new URL('../../web-test/server.mjs', import.meta.url).pathname;

const entries = fs.readFileSync(args.list, 'utf8').split('\n').filter(Boolean).map((l) => {
  const [file, password] = l.split('\t');
  return { file, password: password || null };
});
export function fileId(file) {
  const base = `${path.basename(path.dirname(file))}__${path.basename(file)}`.replace(/[^\w.\-가-힣]+/g, '_');
  return `${base}.${crypto.createHash('sha1').update(file).digest('hex').slice(0, 6)}`;
}
const done = new Set();
if (args.resume && fs.existsSync(args.out)) {
  for (const l of fs.readFileSync(args.out, 'utf8').split('\n')) {
    try { done.add(JSON.parse(l).id); } catch { /* 잘린 줄 */ }
  }
}
const out = fs.createWriteStream(args.out, { flags: args.resume ? 'a' : 'w' });

const procs = ports.map((port) => spawn('node', [serverJs, viewer, vendor, String(port)], { stdio: 'ignore' }));
process.on('exit', () => procs.forEach((p) => p.kill()));
await new Promise((r) => setTimeout(r, 1000));
// 흉내 서버가 떴는지 확인한다(포트가 아직 다른 프로세스에 잡혀 있으면 여기서 멈춘다).
for (const port of ports) {
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    try { ok = (await fetch(`http://127.0.0.1:${port}/viewer/index.html`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!ok) { console.error(`port ${port}: 흉내 서버가 응답하지 않음(포트 사용 중?)`); procs.forEach((p) => p.kill()); process.exit(2); }
}
let browser = await chromium.launch();

const INIT = () => {
  // HWP 쪽 SVG는 blob 주소로 <img>에 들어간다. CSP 때문에 fetch로 다시 읽을 수 없으니 만들 때 Blob을 붙잡아 둔다.
  window.__blobs = new Map();
  const orig = URL.createObjectURL;
  URL.createObjectURL = function (b) {
    const u = orig.call(URL, b);
    try { if (b && /svg/.test(b.type)) window.__blobs.set(u, b); } catch (_) { /* 무시 */ }
    return u;
  };
  window.__media = (root) => {
    const imgs = [...root.querySelectorAll('img')];
    return {
      img: imgs.length,
      imgBroken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
      svg: root.querySelectorAll('svg').length,
      svgImage: root.querySelectorAll('svg image').length,
      canvas: root.querySelectorAll('canvas').length,
      video: root.querySelectorAll('video').length,
      audio: root.querySelectorAll('audio').length,
      iframe: root.querySelectorAll('iframe, object, embed').length,
    };
  };
  // 도형·글상자·워드아트를 SVG 그림(<img src="data:image/svg+xml…">·blob)으로 그리는 경우가 있다. 그 안의 글자도 화면 글자로 센다.
  window.__svgText = async (root) => {
    const out = [];
    for (const im of root.querySelectorAll('img')) {
      const src = im.getAttribute('src') || '';
      let svg = null;
      try {
        if (src.startsWith('data:image/svg+xml')) {
          const i = src.indexOf(',');
          const head = src.slice(0, i);
          const body = src.slice(i + 1);
          svg = head.includes(';base64') ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : decodeURIComponent(body);
        } else if (src.startsWith('blob:') && window.__blobs.has(src)) {
          svg = await window.__blobs.get(src).text();
        }
      } catch (_) { /* 무시 */ }
      if (!svg) continue;
      const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const t = [...d.querySelectorAll('text, foreignObject')].map((n) => n.textContent).join('\n');
      if (t.trim()) out.push(t);
    }
    return out.join('\n');
  };
  window.__r = [];
  window.DocViewer = { report: (s) => window.__r.push(JSON.parse(s)), pickFile() {}, openElsewhere() { window.__elsewhere = (window.__elsewhere || 0) + 1; }, canOpenElsewhere: () => true };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAP = 3_000_000;

async function waitFinal(p, ms) {
  for (let t = 0; t < ms; t += 200) {
    const reps = await p.evaluate(() => window.__r);
    const f = reps.find((r) => ['rendered', 'error', 'password'].includes(r.state));
    if (f) return f;
    await sleep(200);
  }
  return null;
}

async function common(p) {
  return p.evaluate(() => ({
    reports: window.__r,
    // 안내는 문서 안내 목록(평소에는 접혀 있음)에 있으므로 보이는 글(innerText)이 아니라 textContent로 읽는다.
    notes: [...document.querySelectorAll('.info-note')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    notice: (() => { const n = document.getElementById('notice'); return n && !n.hidden ? n.innerText.replace(/\s+/g, ' ').trim() : ''; })(),
    pageErrors: document.querySelectorAll('.page-error').length,
  }));
}

async function captureSheet(p) {
  const tabCount = await p.evaluate(() => document.querySelectorAll('#tabs .tab').length);
  const tabsHidden = await p.evaluate(() => document.getElementById('tabs').hidden);
  const sheets = [];
  let total = 0;
  for (let i = 0; i < Math.max(1, tabCount); i++) {
    if (tabCount) await p.evaluate((i) => document.querySelectorAll('#tabs .tab')[i].click(), i);
    await sleep(250);
    await p.evaluate(() => { const w = document.querySelector('#doc .sheet'); if (w && w.renderUntil) w.renderUntil(1e9); });
    await sleep(600);
    const s = await p.evaluate((cap) => {
      const w = document.querySelector('#doc .sheet');
      const tab = document.querySelector('#tabs .tab[aria-selected="true"]');
      if (!w) return { label: tab ? tab.textContent : '', missing: true };
      const trs = [...w.querySelectorAll('tbody > tr')];
      let cells = 0;
      const lines = [];
      let size = 0;
      for (const tr of trs) {
        const vals = [...tr.querySelectorAll('td')].map((td) => td.textContent);
        const nonEmpty = vals.filter((v) => v.trim());
        cells += nonEmpty.length;
        if (nonEmpty.length && size < cap) { const line = nonEmpty.join('\t'); lines.push(line); size += line.length; }
      }
      // 칸 너비(최대 28em)를 넘는 글자는 말줄임(…)으로 잘리고 펼쳐 볼 방법이 없다: 잘린 칸을 센다.
      let clipped = 0, clippedChars = 0;
      const clipSamples = [];
      for (const td of w.querySelectorAll('td')) {
        const t = td.textContent;
        if (t.length < 6) continue;
        if (td.scrollWidth > td.clientWidth + 1) {
          clipped++;
          const visible = Math.max(0, Math.round(t.length * td.clientWidth / td.scrollWidth));
          clippedChars += t.length - visible;
          if (clipSamples.length < 5) clipSamples.push({ len: t.length, shownApprox: visible, text: t.slice(0, 120) });
        }
      }
      const imgs = [...w.querySelectorAll('.sheet-image')];
      const note = [...document.querySelectorAll('#notes-list .sheet-note')].map((n) => n.textContent).join(' ');
      return {
        label: tab ? tab.textContent : '',
        rows: trs.length,
        cols: Math.max(0, w.querySelectorAll('thead th.col-head').length - 1),
        cells,
        text: lines.join('\n'),
        images: imgs.length,
        imagesBroken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        note: note.replace(/\s+/g, ' ').trim(),
        empty: !!w.querySelector('.sheet-empty'),
        more: (w.querySelector('.sheet-more') || {}).textContent || '',
        clipped, clippedChars, clipSamples,
      };
    }, CAP - total);
    total += (s.text || '').length;
    sheets.push(s);
  }
  return { sheets, tabsHidden };
}

async function captureWord(p) {
  // 쪽이 모두 DOM에 있다(가상화 없음). 글자가 더 늘지 않을 때까지 잠깐 기다린다.
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const n = await p.evaluate(() => (document.querySelector('.word-host') || document.getElementById('doc')).innerText.length);
    if (n === last) break;
    last = n;
    await sleep(700);
  }
  return p.evaluate(() => {
    const MEDIA = window.__media;
    const h = document.querySelector('.word-host') || document.getElementById('doc');
    return {
      text: h.innerText,
      pagesInDom: document.querySelectorAll('[data-docx-page-wrapper]').length,
      clip: (() => {
        // 쪽 면(overflow: clip) 밖으로 나간 글자: DOM에는 있지만 화면에서 잘려 안 보인다.
        let nodes = 0, out = 0, outChars = 0, tiny = 0;
        const samples = [];
        for (const surf of document.querySelectorAll('[data-docx-page-surface]')) {
          const sr = surf.getBoundingClientRect();
          const tw = document.createTreeWalker(surf, NodeFilter.SHOW_TEXT);
          for (let n; (n = tw.nextNode()); ) {
            const t = n.nodeValue;
            if (!t.trim()) continue;
            nodes++;
            const rg = document.createRange();
            rg.selectNodeContents(n);
            const r = rg.getBoundingClientRect();
            if (!r.width || !r.height) { tiny++; continue; }
            const slack = 2;
            if (r.top > sr.bottom - slack || r.bottom < sr.top + slack || r.left > sr.right - slack || r.right < sr.left + slack
              || r.bottom > sr.bottom + r.height * 0.5) {
              out++;
              outChars += t.trim().length;
              if (samples.length < 6) samples.push({ page: surf.closest('[data-docx-page-index]') ? surf.closest('[data-docx-page-index]').dataset.docxPageIndex : '?', text: t.trim().slice(0, 100) });
            }
          }
        }
        return { nodes, out, outChars, tiny, samples };
      })(),
      media: MEDIA(h),
      fallbackSimple: !!document.querySelector('.word-fallback-note'),
    };
  });
}

async function svgTextOf(p, sel) {
  return p.evaluate((sel) => { const h = document.querySelector(sel); return h ? window.__svgText(h) : ''; }, sel);
}

async function captureSlides(p) {
  // react-pptx는 화면 근처 슬라이드만 DOM에 둔다. 안쪽 스크롤 칸을 내리며 슬라이드별 글자를 모은다.
  const per = new Map();
  const svgPer = new Map();
  const media = new Map();
  const collect = async () => {
    const items = await p.evaluate(() => {
      const MEDIA = window.__media;
      return [...document.querySelectorAll('[data-rpv-list-item]')].map((w) => ({ i: Number(w.dataset.rpvListItem), text: w.innerText, n: w.querySelectorAll('*').length, media: MEDIA(w) }));
    });
    const svgs = await p.evaluate(async () => {
      const o = {};
      for (const w of document.querySelectorAll('[data-rpv-list-item]')) o[w.dataset.rpvListItem] = await window.__svgText(w);
      return o;
    });
    for (const [i, t] of Object.entries(svgs)) if (t && (!svgPer.has(Number(i)) || svgPer.get(Number(i)).length < t.length)) svgPer.set(Number(i), t);
    for (const it of items) {
      if (!per.has(it.i) || per.get(it.i).length < it.text.length) per.set(it.i, it.text);
      if (it.n && (!media.has(it.i) || media.get(it.i).n < it.n)) media.set(it.i, { n: it.n, ...it.media });
    }
  };
  const legacyText = await p.evaluate(() => (document.querySelector('.slides-host') || document.getElementById('doc')).innerText);
  const hasV = await p.evaluate(() => !!document.querySelector('.rpv-viewport'));
  if (hasV) {
    await sleep(500);
    for (let k = 0; k < 400; k++) {
      await collect();
      const end = await p.evaluate(() => {
        const v = document.querySelector('.rpv-viewport');
        const before = v.scrollTop;
        v.scrollTop = before + v.clientHeight * 0.6;
        return v.scrollTop === before;
      });
      await sleep(350);
      if (end) { await collect(); break; }
    }
    await p.evaluate(() => { document.querySelector('.rpv-viewport').scrollTop = 0; });
  }
  const slideCount = await p.evaluate(() => document.querySelectorAll('[data-rpv-list-item]').length);
  const idx = [...per.keys()].sort((a, b) => a - b);
  const totals = {};
  for (const m of media.values()) for (const [k, v] of Object.entries(m)) if (k !== 'n') totals[k] = (totals[k] || 0) + v;
  return {
    slideCount,
    slides: idx.map((i) => ({ i, text: per.get(i), media: media.get(i) || null })),
    text: hasV ? idx.map((i) => per.get(i)).join('\n') : legacyText,
    media: totals,
    svgText: [...svgPer.values()].join('\n'),
    emptySlides: idx.filter((i) => !(media.get(i) && media.get(i).n > 3)).length,
  };
}

async function capturePages(p, kind) {
  const n = await p.evaluate(() => document.querySelectorAll('#doc .page').length);
  const pages = [];
  for (let i = 0; i < Math.min(n, maxPages); i++) {
    await p.evaluate((i) => document.querySelectorAll('#doc .page')[i].scrollIntoView({ block: 'start' }), i);
    let rec = null;
    for (let t = 0; t < 40; t++) {
      await sleep(250);
      rec = await p.evaluate(async ({ i, kind }) => {
        const pg = document.querySelectorAll('#doc .page')[i];
        const err = !!pg.querySelector('.page-error');
        if (kind === 'pdf') {
          const layer = pg.querySelector('.textLayer');
          const canvas = pg.querySelector('canvas');
          const img = pg.querySelector('img');
          if (err) return { i, err: true };
          if (img && img.complete && img.naturalWidth) return { i, ok: true, native: true, text: '' };
          // 글자 층은 붙인 뒤에 채워진다. 다 채워지면 뷰어가 pg.textDivs를 단다.
          if (!canvas || !layer || !pg.textDivs) return null;
          return { i, ok: true, text: layer.textContent };
        }
        const img = pg.querySelector('img');
        if (err) return { i, err: true };
        if (!img || !img.complete || !img.naturalWidth) return null;
        const blob = window.__blobs.get(img.src);
        if (!blob) return { i, ok: true, text: '', noBlob: true };
        const svg = await blob.text();
        const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const text = [...d.querySelectorAll('text')].map((t) => t.textContent).join('');
        const hrefs = [...d.querySelectorAll('image')].map((im) => (im.getAttribute('href') || im.getAttribute('xlink:href') || '').slice(0, 40).replace(/;base64,.*/, ''));
        const types = {};
        for (const h of hrefs) { const m = /^data:([^;,]+)/.exec(h); const k = m ? m[1] : h.split(':')[0] || 'none'; types[k] = (types[k] || 0) + 1; }
        return { i, ok: true, text, images: types, svgBytes: svg.length };
      }, { i, kind });
      if (rec) break;
    }
    pages.push(rec || { i, timeout: true });
  }
  await p.evaluate(() => window.scrollTo(0, 0));
  return { pageCount: n, pages };
}

async function captureSimple(p) {
  return p.evaluate(() => {
    const MEDIA = window.__media;
    const s = document.querySelector('.simple-doc');
    const w = document.querySelector('.webdoc-host');
    if (s) return { text: s.innerText, media: MEDIA(s) };  // 간단 보기는 SVG 그림을 쓰지 않는다
    if (w && w.shadowRoot) return { text: w.shadowRoot.textContent, media: MEDIA(w.shadowRoot) };
    return { text: document.getElementById('doc').innerText, media: {} };
  });
}

async function runOne(port, { file, password }) {
  const id = fileId(file);
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/__set?` + new URLSearchParams({ f: file, name: path.basename(file) }));
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 160)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  p.on('dialog', (d) => d.dismiss());
  await p.addInitScript(INIT);
  const t0 = Date.now();
  const rec = { id, file, name: path.basename(file) };
  try {
    await p.goto(`${base}/viewer/index.html`, { timeout: 30000 });
    const ext = path.extname(file).toLowerCase();
    let final = await waitFinal(p, /\.(docx?|docm|dotx|dot|dotm)$/.test(ext) ? 180000 : 90000);
    if (final && final.state === 'password' && password) {
      await p.fill('.pw-form input', password);
      await p.click('.pw-form button');
      await sleep(500);
      for (let t = 0; t < 600; t++) {
        const reps = await p.evaluate(() => window.__r);
        const f = reps.filter((r) => ['rendered', 'error'].includes(r.state)).pop();
        if (f) { final = f; break; }
        await sleep(200);
      }
    }
    rec.final = final;
    if (final && final.state === 'rendered') {
      await sleep(1500);
      const k = final.kind;
      if (k === 'sheet') Object.assign(rec, await captureSheet(p));
      else if (k === 'word') { Object.assign(rec, await captureWord(p)); rec.svgText = await svgTextOf(p, '.word-host'); }
      else if (k === 'slides') Object.assign(rec, await captureSlides(p));
      else if (k === 'pdf' || k === 'hwp') Object.assign(rec, await capturePages(p, k));
      else if (k === 'simple') Object.assign(rec, await captureSimple(p));
      if (k === 'sheet') {
        // 첫 시트(처음 열렸을 때 고른 시트)로 돌아가 스크린샷
        await p.evaluate(() => { const t = document.querySelector('#tabs .tab'); window.scrollTo(0, 0); return t; });
      }
    }
    Object.assign(rec, await common(p));
    if (rec.text && rec.text.length > CAP) rec.text = rec.text.slice(0, CAP);
    if (shots) {
      rec.shot = path.join(shots, `${id}.png`);
      await p.screenshot({ path: rec.shot, timeout: 20000 }).catch(() => { rec.shot = null; });
    }
  } catch (e) {
    rec.harnessError = String(e && e.message || e).slice(0, 300);
  }
  rec.ms = Date.now() - t0;
  rec.errors = errors.slice(0, 5);
  out.write(JSON.stringify(rec) + '\n');
  await ctx.close().catch(() => {});
  return rec;
}

const queue = entries.filter((e) => !done.has(fileId(e.file)));
console.log(`files: ${queue.length} (skipped ${entries.length - queue.length})`);
let n = 0;
await Promise.all(ports.map(async (port) => {
  for (let e; (e = queue.shift()); ) {
    let r;
    try {
      r = await runOne(port, e);
    } catch (err) {
      // 브라우저가 죽었으면 다시 띄운다.
      console.log('restart browser:', String(err).slice(0, 100));
      try { await browser.close(); } catch { /* 무시 */ }
      browser = await chromium.launch();
      continue;
    }
    n++;
    console.log(`${n}\t${r.final ? r.final.state + ':' + (r.final.kind || r.final.reason || '') : 'TIMEOUT'}\t${r.ms}ms\t${r.id}`);
  }
}));
out.end();
await browser.close();
procs.forEach((p) => p.kill());
