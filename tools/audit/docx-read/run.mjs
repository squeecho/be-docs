// 빠른 읽기(app/src/main/assets/viewer/docx-read.js)와 워드 엔진이 읽은 구조로 만든 읽기 보기(viewer-libs/docx-entry.js의
// readingBlocks)를 같은 docx로 만들어 글을 대조한다. 엔진을 올리거나 docx-read.js를 고칠 때 돌린다.
// 사용: node tools/audit/docx-read/run.mjs <docx 목록 파일(한 줄에 절대경로)> <결과.jsonl>
//       python3 tools/audit/docx-read/analyze.py <결과.jsonl>
// 필요: viewer-libs에서 npm ci(엔진·esbuild·fflate), Playwright(tools/web-test/playwright.mjs가 찾는 것)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../../web-test/playwright.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const libs = path.join(root, 'viewer-libs');
const [,, listFile, outFile] = process.argv;
if (!listFile || !outFile) {
  console.error('사용: node run.mjs <docx 목록> <결과.jsonl>');
  process.exit(2);
}
const files = fs.readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

// 엔진과 두 변환기를 한 묶음으로 만든다(엔진은 화면 스레드에서 돌려 결과를 바로 받는다).
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-read-compare-'));
const esbuild = createRequire(path.join(libs, 'package.json'))('esbuild');
const entry = `
import { parseDocxForViewer, setWasmSource } from '@extend-ai/react-docx';
import { inflateSync } from 'fflate';
import { readingBlocks } from './docx-entry.js';
import { readDocx } from '../app/src/main/assets/viewer/docx-read.js';
setWasmSource(new URL('./docx_wasm_bg.wasm', import.meta.url).href);
const textOf = (blocks) => {
  let o = '';
  for (const b of blocks) {
    if (b.t === 'p') o += (b.heading ? '#' + b.heading + ' ' : '') + b.runs.map((r) => (r.text != null ? r.text : (r.img != null ? '[그림]' : ''))).join('') + '\\n';
    else if (b.t === 'table') {
      o += '<표>\\n';
      for (const row of b.rows) for (const c of row.cells) o += '|' + (c.colspan > 1 ? 'c' + c.colspan : '') + (c.rowspan > 1 ? 'r' + c.rowspan : '') + ' ' + textOf(c.blocks);
      o += '</표>\\n';
    } else if (b.t === 'break') o += '<쪽>\\n';
  }
  return o;
};
window.compareOne = async (url) => {
  const buf = await (await fetch(url)).arrayBuffer();
  const out = {};
  try {
    const t0 = performance.now();
    const parsed = await parseDocxForViewer(buf.slice(0), { useWorker: false, loadEmbeddedFonts: false });
    out.engineMs = Math.round(performance.now() - t0);
    const rb = readingBlocks(parsed.model);
    out.engine = textOf(rb.blocks);
    out.engineNotes = rb.extras.footnotes.length;
    out.engineOmitted = rb.omittedImages;
    rb.release();
    parsed.dispose();
  } catch (e) { out.engineErr = String((e && e.message) || e).slice(0, 200); }
  try {
    const t0 = performance.now();
    const r = readDocx(new Uint8Array(buf), inflateSync);
    out.fastMs = Math.round(performance.now() - t0);
    out.fast = textOf(r.blocks);
    out.fastNotes = r.extras.footnotes.length;
    out.fastOmitted = r.omittedImages;
    out.fastCounts = r.counts;
  } catch (e) { out.fastErr = String((e && e.message) || e).slice(0, 200); }
  return out;
};
`;
await esbuild.build({
  stdin: { contents: entry, resolveDir: libs, sourcefile: 'compare-entry.js' },
  bundle: true, format: 'esm', target: 'es2022', outfile: path.join(work, 'compare.js'), logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
});
fs.copyFileSync(path.join(libs, 'node_modules/@extend-ai/react-docx/dist/docx_wasm_bg.wasm'), path.join(work, 'docx_wasm_bg.wasm'));
fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="compare.js"></script>');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const m = /^\/f\/(\d+)$/.exec(req.url);
  const file = m ? files[Number(m[1])] : path.join(work, path.basename(req.url.split('?')[0]) || 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const out = fs.createWriteStream(outFile);
let page = null;
for (let i = 0; i < files.length; i++) {
  if (!page) {
    page = await browser.newPage();
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => !!window.compareOne);
  }
  let r;
  try {
    r = await Promise.race([
      page.evaluate((u) => window.compareOne(u), `${base}/f/${i}`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('2분 넘게 걸림')), 120000)),
    ]);
  } catch (e) {
    r = { harnessErr: String(e).slice(0, 160) };
    await page.close().catch(() => {});
    page = null; // 엔진이 멈춘 페이지는 버리고 새로 연다
  }
  out.write(`${JSON.stringify({ file: files[i], ...r })}\n`);
  if ((i + 1) % 20 === 0) console.log(`${i + 1}/${files.length}`);
}
out.end();
await browser.close();
server.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`끝: ${files.length}개 → ${outFile}`);
