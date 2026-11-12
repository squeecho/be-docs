// 파일 하나를 열어 시간·긴 작업·내용 품질을 잰다(원인 조사용 CPU 프로필도 가능).
// node one.mjs <file> [--name 표시이름] [--throttle 6] [--engine local|c109|c113] [--budget 60000]
//                     [--proc 6(렌더러 프로세스 전체 감속)] [--port 8951] [--profile out.cpuprofile] [--shot out.png] [--json]
import { startServer, stopServers, launchTracked, runOne, classify, slimRecord } from './lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--json'));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', 8951));
await startServer(port);
const browser = await launchTracked(opt('engine', 'local'));
const rec = await runOne({
  port, browser, file, name: opt('name'), throttle: Number(opt('throttle', 1)), procThrottle: Number(opt('proc', 0)), budget: Number(opt('budget', 60000)),
  profile: !!opt('profile'), profileOut: opt('profile'), shot: opt('shot'), profileInterval: Number(opt('interval', 2000)),
});
const flags = classify(rec);
const r = slimRecord(rec);
if (args.includes('--json')) console.log(JSON.stringify({ ...r, flags }));
else {
  console.log(`${r.state}${r.terminal && r.terminal.kind ? ':' + r.terminal.kind : ''} reason=${r.terminal && r.terminal.reason || ''} tTerminal=${r.tTerminal} tUsable=${r.tUsable} maxLT=${r.maxLT} TBT=${r.tbt} lts=${r.ltCount} wall=${r.wall} flags=${flags.join(',')}`);
  console.log('reports:', r.reports.map((o) => o.state === 'hwp-stats' ? `${o.t}:${JSON.stringify(o)}` : `${o.t}:${o.state}${o.kind ? ':' + o.kind : ''}${o.message ? ' ' + o.message.slice(0, 50) : ''}${o.tech ? ' [' + o.tech.slice(0, 120) + ']' : ''}`).join(' | '));
  console.log('ltTop:', JSON.stringify(r.ltTop));
  if (r.content) console.log('content:', JSON.stringify(r.content).slice(0, 700));
  if (r.pageErrors.length) console.log('pageErrors:', r.pageErrors);
  if (r.consoleErrors.length) console.log('consoleErrors:', r.consoleErrors);
  if (r.profileTop) console.log('profile:', JSON.stringify(r.profileTop, null, 1));
}
await browser.close();
stopServers();
