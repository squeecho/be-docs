// 오래된 "Android System WebView"에서는 뷰어 스크립트(최신 문법)가 아예 실행되지 않아 "불러오는 중…"에 멈춘다.
// 이 파일은 옛 문법으로만 써서 어느 웹뷰에서든 돌고, 필요한 기능이 없으면 이유와 해결 방법을 보여준다.
(function () {
  'use strict';
  var ok = typeof Promise !== 'undefined'
    && typeof HTMLScriptElement !== 'undefined' && 'noModule' in HTMLScriptElement.prototype
    && typeof structuredClone === 'function'      // Chrome 98+
    && typeof Array.prototype.at === 'function'   // Chrome 92+
    && typeof Object.hasOwn === 'function'         // Chrome 93+
    && typeof WebAssembly === 'object';

  function show(text, sub) {
    var box = document.getElementById('notice');
    if (!box) return;
    box.hidden = false;
    while (box.firstChild) box.removeChild(box.firstChild);
    var p = document.createElement('p');
    p.className = 'notice-text';
    p.textContent = text;
    box.appendChild(p);
    var s = document.createElement('p');
    s.className = 'notice-sub';
    s.textContent = sub;
    box.appendChild(s);
    var bridge = window.DocViewer;
    if (bridge && bridge.openWebViewUpdate) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-primary';
      b.textContent = UPDATE;
      b.addEventListener('click', function () { bridge.openWebViewUpdate(); });
      box.appendChild(b);
    }
    if (bridge && bridge.canOpenElsewhere && bridge.canOpenElsewhere()) {
      var o = document.createElement('button');
      o.type = 'button';
      o.className = 'btn';
      o.textContent = ELSEWHERE;
      o.addEventListener('click', function () { bridge.openElsewhere(); });
      box.appendChild(o);
    }
    try {
      if (bridge) bridge.report(JSON.stringify({ state: 'error', message: text, detail: sub }));
    } catch (e) {
      // 보고 실패는 무시한다.
    }
  }

  // 화면 언어(i18n.js와 같은 규칙): 앱이 한국어가 아니라고 하면 영어
  var EN = false;
  try {
    var lang = window.DocViewer && window.DocViewer.language ? String(window.DocViewer.language()) : 'ko';
    EN = lang.toLowerCase().indexOf('ko') !== 0;
  } catch (e) {
    EN = false;
  }
  var OLD = EN ? 'The "Android System WebView" on this phone is too old to open documents.'
    : '휴대폰의 "Android System WebView"가 오래돼 문서를 열 수 없어요.';
  var HOW = EN ? 'Update "Android System WebView" (or Chrome) in the Play Store, then open the file again.'
    : 'Play 스토어에서 "Android System WebView"(또는 Chrome)를 업데이트하고 다시 열어 주세요.';
  var UPDATE = EN ? 'Update WebView' : '웹뷰 업데이트';
  var ELSEWHERE = EN ? 'Open in another app' : '다른 앱으로 열기';
  var NOSTART = EN ? 'The viewer couldn’t start.' : '뷰어를 시작하지 못했어요.';
  if (!ok) {
    window.__beDocsUnsupported = true;
    document.addEventListener('DOMContentLoaded', function () { show(OLD, HOW); });
    return;
  }
  // 기능 검사는 통과했는데 뷰어가 시작되지 않으면(스크립트 오류 등) 30초 뒤 안내한다.
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!window.__beDocsStarted) show(NOSTART, HOW);
    }, 30000);
  });
})();
