// 긴 docx 빠른 읽기(docx-read.js)를 화면 밖에서 돌린다. 183쪽 문서의 XML 12MB도 화면을 멈추지 않는다.
import { inflateSync } from './vendor/inflate.js';
import { readDocx } from './docx-read.js';

self.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    const result = readDocx(data.bytes, inflateSync);
    result.ms = Math.round(performance.now() - started);
    self.postMessage({ ok: true, ...result }, result.images.map((im) => im.data.buffer));
  } catch (e) {
    self.postMessage({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
};
