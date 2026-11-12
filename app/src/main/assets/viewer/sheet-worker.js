// 엑셀 파일 해석은 이 작업 스레드에서 한다. 해석하는 동안(중급 휴대폰에서 수 초) 화면이 굳지 않고,
// 손상된 파일에서 엔진이 끝나지 않아도 화면 쪽이 시간을 재다가 이 스레드를 끊을 수 있다.
// 결과(통합 문서 객체)는 구조 복제로 화면 쪽에 넘긴다.
/* global XLSX */
/* global SheetFormat */
importScripts('vendor/xlsx.full.min.js', 'sheet-format.js');
// 엔진을 다 불러왔음을 알린다. 화면 쪽은 이때부터 해석 시간을 잰다(느린 기기의 엔진 불러오기를 손상으로 오해하지 않게).
self.postMessage({ ready: true });

self.onmessage = async ({ data }) => {
  try {
    // 압축 데이터가 멀쩡한지 먼저 알린다. 화면 쪽은 멀쩡하면 시간 제한을 넉넉히 늘린다.
    self.postMessage({ checked: await zipInflates(data.bytes) });
    const wb = XLSX.read(data.bytes, data.opts);
    // 칸 서식도 여기서 읽는다(시트 XML을 훑는 일이 커서). 원본 조각은 화면 쪽에 넘기지 않는다.
    wb.Format = SheetFormat.read(XLSX, wb);
    delete wb.files;
    delete wb.cfb;
    self.postMessage({ parsed: true });
    await fillFormulas(wb);
    self.postMessage({ ok: true, wb });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && (e.message || e)) });
  }
};

// ZIP(xlsx·xlsb·ods)의 압축 항목을 fflate(끝이 보장되는 풀기)로 모두 풀어 본다. 엑셀 엔진의 압축 풀기가 끝나지 않는 것은
// 깨진 압축 데이터에서만 생기므로, 다 풀리면 엔진이 오래 걸려도 "느린 것"이지 "멈춘 것"이 아니다.
// ZIP이 아니면(97~2003 엑셀·글자) true, 깨졌거나 확인하지 못하면 false.
async function zipInflates(bytes) {
  if (typeof bytes === 'string' || !(bytes[0] === 0x50 && bytes[1] === 0x4b)) return true;
  let inflate;
  try {
    inflate = (await import('./vendor/inflate.js')).inflateSync;
  } catch (e) {
    return false;
  }
  const u16 = (p) => bytes[p] | (bytes[p + 1] << 8);
  const u32 = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return false;
  let seen = 0;
  for (let q = u32(eocd + 16); q + 46 <= bytes.length && u32(q) === 0x02014b50 && seen < 65535; seen++) {
    const method = u16(q + 10);
    const csize = u32(q + 20);
    const size = u32(q + 24);
    const off = u32(q + 42);
    q += 46 + u16(q + 28) + u16(q + 30) + u16(q + 32);
    if (method !== 8 || !csize) continue;
    if (off + 30 > bytes.length || u32(off) !== 0x04034b50) return false;
    const start = off + 30 + u16(off + 26) + u16(off + 28);
    try {
      inflate(bytes.subarray(start, start + csize), size ? { out: new Uint8Array(Math.min(size, 256 * 1024 * 1024)) } : undefined);
    } catch (e) {
      return false;
    }
  }
  return seen > 0;
}

// 결과 없이 저장된 수식(웹 시스템의 "엑셀 다운로드" 등)도 여기서 계산한다. 10초까지만 계산하고 나머지 칸은 수식 그대로 둔다.
// 계산기를 못 불러오면 화면 쪽이 대신 계산한다.
async function fillFormulas(wb) {
  let missing = 0;
  for (const name of wb.SheetNames || []) {
    const ws = wb.Sheets[name] || {};
    for (const key of Object.keys(ws)) {
      const c = ws[key];
      if (key[0] !== '!' && c && c.f && (c.t === 'z' || c.v === undefined)) missing++;
    }
  }
  if (!missing) {
    wb.FormulasFilled = true;
    return;
  }
  try {
    const mod = await import('./vendor/formula.js');
    mod.fillMissingFormulas(XLSX, wb, { limit: 20000, deadline: performance.now() + 10000 });
    wb.FormulasFilled = true;
  } catch (e) {
    // 화면 쪽에서 계산한다
  }
}
