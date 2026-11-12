// pdf.js 작업 스레드 입구. 오래된 웹뷰에 없는 기능을 먼저 채운 뒤 pdf.js 작업 스레드를 불러온다.
// 작업 스레드를 못 띄우면 pdf.js가 이 파일을 화면 쪽에서 불러 WorkerMessageHandler를 찾으므로 그대로 내보낸다.
import './pdf-polyfills.js';
export * from './vendor/pdfjs/pdf.worker.mjs';
