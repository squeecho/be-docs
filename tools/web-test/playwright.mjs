// playwright를 이 폴더(npm i) 또는 전역 설치에서 찾는다.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

// 자동화 브라우저는 navigator.webdriver가 true라서, 워드 엔진(react-docx)이 실제 기기와 다르게 보이는 쪽만 그리는
// 기능(가상화)을 끄고 모든 쪽을 그렸다. 그 탓에 워드 멈춤을 실제보다 2~3배 길게 쟀다(48쪽: 16초 ↔ 실제 조건 6.8초, CPU 4배 감속).
// 기기의 웹뷰와 같은 경로를 타도록 모든 시험 도구에서 이 표시를 끈다.
const REAL_DEVICE_ARGS = ['--disable-blink-features=AutomationControlled'];

export function loadPlaywright() {
  const bases = [import.meta.url];
  try { bases.push(execSync('npm root -g').toString().trim() + '/'); } catch { /* 전역 npm이 없으면 건너뛴다 */ }
  for (const base of bases) {
    let pw;
    try { pw = createRequire(base)('playwright'); } catch { continue; /* 다음 위치를 찾는다 */ }
    const launch = pw.chromium.launch.bind(pw.chromium);
    const chromium = Object.create(pw.chromium);
    chromium.launch = (opts = {}) => launch({ ...opts, args: [...(opts.args || []), ...REAL_DEVICE_ARGS] });
    return { ...pw, chromium };
  }
  throw new Error('playwright가 필요합니다: npm i -g playwright');
}
