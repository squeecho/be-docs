// 같은 길이의 원본·변형 파일에서, SheetJS XLSX.read가 멈추는(시간 초과) 최소 바이트 차이를 찾는다(델타 디버깅).
// node minimize.mjs <seed> <mutant> [timeoutMs=4000] [mode=read|cfb]
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
const [seedF, mutF, tmo = '4000', mode = 'read'] = process.argv.slice(2);
const XPATH = (process.env.SNAP || new URL('../../../app/src/main/assets/viewer', import.meta.url).pathname) + '/vendor/xlsx.full.min.js';
const seed = fs.readFileSync(seedF), mut = fs.readFileSync(mutF);
if (seed.length !== mut.length) throw new Error('lengths differ');
const diffs = [];
for (let i = 0; i < seed.length; i++) if (seed[i] !== mut[i]) diffs.push(i);
console.log('diff bytes', diffs.length);
const src = `const { parentPort, workerData } = require('worker_threads'); const XLSX = require(${JSON.stringify(XPATH)});
const t = Date.now(); let r = 'ok';
try { if (workerData.mode === 'cfb') XLSX.CFB.read(workerData.buf, { type: 'buffer' }); else XLSX.read(workerData.buf, { type: 'buffer', sheetRows: 3001, cellHTML: false, cellFormula: true, cellNF: true, cellStyles: true, sheetStubs: true }); } catch (e) { r = 'err: ' + String(e.message).slice(0, 100); }
parentPort.postMessage({ r, ms: Date.now() - t });`;
function test(idx) {
  const b = Buffer.from(seed);
  for (const i of idx) b[i] = mut[i];
  return new Promise((res) => {
    const w = new Worker(src, { eval: true, workerData: { buf: b, mode } });
    const t = setTimeout(() => { w.terminate(); res({ hang: true }); }, Number(tmo));
    w.on('message', (m) => { clearTimeout(t); w.terminate(); res({ hang: false, ...m }); });
    w.on('error', (e) => { clearTimeout(t); res({ hang: false, r: 'werr ' + e.message }); });
  });
}
let cur = diffs;
console.log('full mutant:', await test(cur));
let n = 2;
while (cur.length >= 2) {
  const size = Math.ceil(cur.length / n);
  let reduced = false;
  for (let s = 0; s < cur.length; s += size) {
    const comp = cur.slice(0, s).concat(cur.slice(s + size));
    if (comp.length && (await test(comp)).hang) { cur = comp; n = Math.max(n - 1, 2); reduced = true; break; }
  }
  if (!reduced) { if (n >= cur.length) break; n = Math.min(cur.length, n * 2); }
}
console.log('minimal diff offsets:', cur.map((i) => `${i}(0x${i.toString(16)}): ${seed[i].toString(16)}->${mut[i].toString(16)}`).join(', '));
const b = Buffer.from(seed); for (const i of cur) b[i] = mut[i];
const outF = mutF.replace(/(\.[^.]+)?$/, '.min$1');
fs.writeFileSync(outF, b);
console.log('wrote', outF, await test(cur));
