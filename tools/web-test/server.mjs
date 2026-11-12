// ViewerActivity의 /doc/* 응답을 흉내 내는 로컬 테스트 서버
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [,, assetsDir, vendorDir, port] = process.argv;
let current = null; // { file, name }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/__set') {
      const f = u.searchParams.get('f');
      // tooBig=크기(바이트): 앱이 300MB 넘는 파일을 받지 않고 알릴 때의 응답을 흉내 낸다(ViewerActivity /doc/info)
      current = f ? { file: f, name: u.searchParams.get('name') ?? path.basename(f), tooBig: u.searchParams.get('tooBig') } : null;
      return send(res, 200, 'text/plain', 'ok');
    }
    if (u.pathname.startsWith('/viewer/vendor/')) {
      const rel = decodeURIComponent(u.pathname.slice('/viewer/vendor/'.length));
      if (rel.includes('..')) return send(res, 404, 'text/plain', 'not found');
      const p = path.join(vendorDir, rel);
      return send(res, 200, types[path.extname(p)] || 'application/octet-stream', fs.readFileSync(p));
    }
    if (u.pathname.startsWith('/viewer/')) {
      const p = path.join(assetsDir, u.pathname.slice('/viewer/'.length));
      return send(res, 200, types[path.extname(p)] || 'application/octet-stream', fs.readFileSync(p));
    }
    if (u.pathname === '/doc/info') {
      if (!current) return send(res, 200, 'application/json', JSON.stringify({ empty: true }));
      if (current.tooBig) return send(res, 200, 'application/json', JSON.stringify({ tooBig: true, name: current.name, size: +current.tooBig, error: '파일이 너무 커요(300MB 넘음).' }));
      return send(res, 200, 'application/json', JSON.stringify({ name: current.name, size: fs.statSync(current.file).size }));
    }
    if (u.pathname === '/doc/head') return send(res, 200, 'application/octet-stream', fs.readFileSync(current.file).subarray(0, 8192));
    if (u.pathname === '/doc/file') return send(res, 200, 'application/octet-stream', fs.readFileSync(current.file));
    if (u.pathname === '/doc/pdf/info') {
      const out = execFileSync('pdfinfo', ['-f', '1', '-l', '100000', current.file]).toString();
      const pages = [...out.matchAll(/Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/g)].map(m => ({ w: +m[1], h: +m[2] }));
      return send(res, 200, 'application/json', JSON.stringify({ pages }));
    }
    if (u.pathname === '/doc/pdf/page') {
      const i = +u.searchParams.get('i') + 1, w = +u.searchParams.get('w');
      const png = execFileSync('pdftoppm', ['-f', String(i), '-l', String(i), '-scale-to-x', String(w), '-scale-to-y', '-1', '-png', '-singlefile', current.file]);
      return send(res, 200, 'image/png', png);
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) { send(res, 500, 'text/plain', String(e)); }
}).listen(+port, '127.0.0.1', () => console.log('listening', port));
