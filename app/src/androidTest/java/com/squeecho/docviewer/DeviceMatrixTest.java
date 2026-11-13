package com.squeecho.docviewer;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 실제 기기(에뮬레이터)에서 확인하는 전수 테스트.
 * - 버전별 파일(manifest.tsv의 모든 행)을 카카오톡처럼 content:// 주소로 넘겨 기대 결과와 비교한다.
 * - 등록한 모든 파일 형식이 "연결 프로그램" 목록에 뜨는지 확인한다.
 * - 파이프(차례로만 읽히는 스트림)·이름 없는 파일·화면 회전(폴드 접기·펴기와 같은 구성 변경)을 확인한다.
 */
@RunWith(AndroidJUnit4.class)
public class DeviceMatrixTest {
    private static final String TAG = "DocViewerTest";

    // 화면 글자를 확인하는 시험이 많아 한국어 화면으로 돈다(시험 기기는 보통 영어). 영어 화면은 따로 시험한다.
    @Before
    public void koreanScreen() {
        ViewerActivity.languageForTest = "ko-KR";
    }

    @After
    public void deviceLanguage() {
        ViewerActivity.languageForTest = null;
    }
    // CI 에뮬레이터는 PC보다 20~30배 느리다. 한글 엔진이 PC에서 2.5초 걸려 여는 문서(hwp5.0.2.5, 17쪽 표 문서)가
    // 에뮬레이터에서는 90초 안팎이라 90초 한도에서 들쭉날쭉 실패했다. 멈춤은 그대로 잡고, 걸린 시간은 결과 줄에 남는다.
    private static final long TIMEOUT_MS = 180_000;

    private static final String[] VIEW_TYPES = {
            "application/x-hwp", "application/hwp", "application/haansofthwp", "application/vnd.hancom.hwp",
            "application/x-hwpx", "application/haansofthwpx", "application/vnd.hancom.hwpx", "application/hwp+zip",
            "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel.sheet.macroenabled.12", "application/vnd.ms-excel.sheet.binary.macroenabled.12",
            "text/csv", "text/comma-separated-values", "text/tab-separated-values",
            "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
            "application/vnd.ms-powerpoint.presentation.macroenabled.12",
            "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
            "application/vnd.ms-word.document.macroenabled.12", "application/vnd.ms-word.template.macroenabled.12",
            "application/pdf", "application/illustrator", "application/vnd.adobe.illustrator", "application/postscript",
            "image/vnd.dwg", "application/acad", "application/dwg", "image/vnd.dxf", "application/dxf",
            "application/rtf", "text/rtf", "application/vnd.oasis.opendocument.text",
            "application/vnd.oasis.opendocument.presentation", "application/vnd.oasis.opendocument.spreadsheet",
            "application/octet-stream",
    };

    // ------------------------------------------------------------ 연결 프로그램 목록

    @Test
    public void appearsInOpenWithListForEveryRegisteredType() {
        Context app = ApplicationProvider.getApplicationContext();
        PackageManager pm = app.getPackageManager();
        Uri uri = TestFilesProvider.uri("file", "matrix/hwp5.0.3.0.hwp");
        List<String> missing = new ArrayList<>();
        for (String type : VIEW_TYPES) {
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, type);
            if (!resolvesToUs(pm.queryIntentActivities(view, 0), app)) missing.add("VIEW " + type);
            Intent send = new Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri);
            if (!resolvesToUs(pm.queryIntentActivities(send, 0), app)) missing.add("SEND " + type);
        }
        // 일반 글(.txt)은 열기 목록에만 뜬다(공유 받기에 넣으면 링크·글 공유마다 목록에 뜬다).
        Intent text = new Intent(Intent.ACTION_VIEW).setDataAndType(TestFilesProvider.uri("file", "matrix/text-memo.txt"), "text/plain");
        if (!resolvesToUs(pm.queryIntentActivities(text, 0), app)) missing.add("VIEW text/plain");
        Intent sendText = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "https://example.com");
        if (resolvesToUs(pm.queryIntentActivities(sendText, 0), app)) missing.add("SEND text/plain에 뜨면 안 됨");
        assertTrue("목록에 안 뜨는 형식: " + missing, missing.isEmpty());
    }

    private static boolean resolvesToUs(List<ResolveInfo> list, Context app) {
        for (ResolveInfo r : list) {
            if (app.getPackageName().equals(r.activityInfo.packageName)
                    && ViewerActivity.class.getName().equals(r.activityInfo.name)) return true;
        }
        return false;
    }

    // ------------------------------------------------------------ 버전별 전수 테스트

    @Test
    public void versionMatrix() throws Exception {
        // 결과가 웹뷰 판에 따라 달라질 수 있어(오래된 웹뷰에 없는 기능) 어떤 판으로 돌았는지 남긴다.
        android.content.pm.PackageInfo webView = android.webkit.WebView.getCurrentWebViewPackage();
        Log.i(TAG, "WEBVIEW " + (webView == null ? "unknown" : webView.packageName + " " + webView.versionName));
        List<String[]> rows = readManifest();
        // 일부만 다시 볼 때(Run workflow의 matrix-only): 파일 이름에 그 낱말(쉼표로 여럿)이 든 줄만 돌린다.
        String only = InstrumentationRegistry.getArguments().getString("matrixOnly", "").trim();
        StringBuilder table = new StringBuilder();
        int failures = 0;
        for (String[] row : rows) {
            if (!only.isEmpty() && !containsAny(row[0], only)) continue;
            String file = row[0];
            String mime = row[1];
            String expect = row[2];
            String contains = row.length > 4 ? row[4] : "";
            long started = SystemClock.uptimeMillis();
            String outcome;
            try {
                outcome = openAndJudge(TestFilesProvider.uri("file", "matrix/" + file), mime, expect, contains, file);
            } catch (Throwable t) {
                outcome = "FAIL exception " + t;
            }
            long ms = SystemClock.uptimeMillis() - started;
            if (outcome.startsWith("FAIL")) failures++;
            String line = String.format("%-4s %-34s %-18s %6dms %s", outcome.startsWith("FAIL") ? "FAIL" : "PASS",
                    file, expect, ms, outcome);
            Log.i(TAG, line);
            table.append(line).append('\n');
        }
        Log.i(TAG, "버전별 결과\n" + table);
        assertEquals("버전별 테스트 실패 " + failures + "건\n" + table, 0, failures);
    }

    private String openAndJudge(Uri uri, String mime, String expect, String contains, String shotName) throws Exception {
        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String report = await(scenario, "rendered", "error", "password");
            if (expect.startsWith("password:") && report.contains("\"state\":\"password\"")) {
                String pw = expect.substring("password:".length());
                activity[0].evaluateJavascriptForTest(
                        "(function(){var i=document.querySelector('.pw-form input');i.value=" + jsString(pw)
                                + ";document.querySelector('.pw-form button[type=submit]').click();return true;})()", 5000);
                report = await(scenario, "rendered", "error");
            }
            // 느린 기기에서는 "표시 완료" 뒤에도 페이지 그림을 해석하는 데 시간이 걸린다. 최대 15초까지 다시 확인한다.
            String probe = "(function(){var n=0;document.querySelectorAll('.page img').forEach(function(i){if(i.complete&&i.naturalWidth>0)n++;});"
                    + "document.querySelectorAll('.page canvas').forEach(function(c){if(c.width>0)n++;});"
                    + "return JSON.stringify({imgs:n,cells:document.querySelectorAll('.sheet td').length,"
                    + "slides:document.querySelectorAll('.slides-host div').length,"
                    // 워드: 원본 모양(엔진이 그린 글자) 또는 긴 문서의 읽기 모드(문단)
                    + "word:document.querySelectorAll('.word-host span, .word-host .simple-p').length,"
                    // 간단 보기: 일반 문서 칸 + 웹 페이지 .doc(그림자 DOM 안) 글자 수
                    + "simple:(function(){var s=document.querySelector('.simple-doc');var w=document.querySelector('.webdoc-host');"
                    + "return s?s.textContent.trim().length:(w&&w.shadowRoot?w.shadowRoot.textContent.trim().length:0);})(),"
                    + "has:" + (contains.isEmpty() ? "true" : "(document.body.textContent.indexOf(" + jsString(contains) + ")>=0"
                    + "||Array.prototype.some.call(document.querySelectorAll('.webdoc-host'),function(h){return h.shadowRoot&&h.shadowRoot.textContent.indexOf("
                    + jsString(contains) + ")>=0;}))")
                    + ",pageErrors:document.querySelectorAll('.page-error').length"
                    // CAD 도면: 캔버스에서 바탕색이 아닌 점 수(64바이트마다 하나씩 본다)
                    + ",cad:(function(){var c=document.querySelector('.cad-canvas');if(!c)return 0;"
                    + "var d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,n=0;"
                    + "for(var i=0;i<d.length;i+=64){if(Math.abs(d[i]-d[0])+Math.abs(d[i+1]-d[1])+Math.abs(d[i+2]-d[2])>40)n++;}return n;})()"
                    + ",msg:(document.getElementById('notice')||{}).textContent||''});})()";
            String verdict = "";
            long until = SystemClock.uptimeMillis() + 15_000;
            do {
                SystemClock.sleep(700);
                String content = activity[0].evaluateJavascriptForTest(probe, 5000);
                verdict = judge(expect, report, content == null ? "" : content);
            } while (verdict.startsWith("FAIL") && expect.startsWith("rendered:") && report.contains("\"state\":\"rendered\"")
                    && SystemClock.uptimeMillis() < until);
            // 여러 쪽 문서는 끝까지 넘겨 마지막 쪽에 닿아야 한다(그려지기만 하고 스크롤이 막힌 경우를 잡는다).
            java.util.regex.Matcher pages = java.util.regex.Pattern.compile("\"pages\":(\\d+)").matcher(report);
            if (!verdict.startsWith("FAIL") && pages.find() && Integer.parseInt(pages.group(1)) >= 2
                    && (expect.equals("rendered:word") || expect.equals("rendered:pdf") || expect.equals("rendered:hwp")
                    || expect.equals("rendered:slides"))) {
                // 사람이 하듯 끝까지 내려 본다. 워드 엔진은 스크롤이 멈추고 잠깐 뒤에 화면 근처의 쪽을 그려(느린 기기는 몇 초)
                // 내린 뒤 다시 내리지 않고 최대 10초 기다리며 본다(다시 내리면 엔진이 또 기다린다, CI #86 word-12-pages).
                // 쪽이 늦게 그려져 문서가 길어졌으면 다시 내려 본다(최대 3번).
                String reach = null;
                long scrolled = SystemClock.uptimeMillis();
                for (int attempt = 0; attempt < 3 && !"true".equals(reach); attempt++) {
                    activity[0].evaluateJavascriptForTest(SCROLL_TO_END, 5000);
                    scrolled = SystemClock.uptimeMillis();
                    do {
                        SystemClock.sleep(500);
                        reach = activity[0].evaluateJavascriptForTest(
                                String.format(java.util.Locale.ROOT, REACH_CHECK, Integer.parseInt(pages.group(1)) - 1), 5000);
                    } while (!"true".equals(reach) && SystemClock.uptimeMillis() - scrolled < 10_000);
                }
                Log.i(TAG, "마지막 쪽 " + shotName + ": " + ("true".equals(reach) ? "내린 뒤 " + (SystemClock.uptimeMillis() - scrolled) + "ms에 보임" : "안 보임"));
                if (!"true".equals(reach)) {
                    // 원인을 CI 로그만으로 알 수 있게 스크롤 위치·문서 높이·마지막 쪽 위치를 남긴다.
                    verdict = "FAIL cannot reach last page " + activity[0].evaluateJavascriptForTest(REACH_DIAG, 5000) + " " + verdict;
                }
            }
            // 다 열린 뒤에는 앱이 띄우는 "다른 앱으로 열기"(화면 스크립트가 멈췄을 때만)가 남아 있으면 안 된다.
            boolean[] escape = {false};
            scenario.onActivity(a -> escape[0] = a.isEscapeShownForTest());
            if (escape[0] && !report.startsWith("timeout") && !verdict.startsWith("FAIL")) {
                verdict = "FAIL native escape button left on screen " + verdict;
            }
            screenshot("matrix-" + shotName);
            return verdict;
        }
    }

    static final String SCROLL_TO_END = "(function(){var h=document.querySelector('.word-host')||document.querySelector('.rpv-viewport');"
            + "if(h)h.scrollTop=h.scrollHeight;else window.scrollTo(0,document.documentElement.scrollHeight);return 1;})()";

    static final String REACH_DIAG = "(function(){var h=document.querySelector('.word-host');var all=document.querySelectorAll('.page');"
            + "var p=all[all.length-1];return JSON.stringify({host:!!h,scrollY:Math.round(window.scrollY),"
            + "hostTop:h?Math.round(h.scrollTop):null,hostH:h?h.scrollHeight:null,docH:document.documentElement.scrollHeight,"
            + "vh:window.innerHeight,vw:window.innerWidth,pages:all.length,lastTop:p?Math.round(p.getBoundingClientRect().top):null,"
            + "lastH:p?Math.round(p.getBoundingClientRect().height):null,barAway:document.getElementById('bar').className,"
            // 워드 쪽 모양·PPT: 지금 그려 둔 쪽·슬라이드 번호(엔진은 화면 근처만 그린다)
            + "docx:Array.prototype.map.call(document.querySelectorAll('[data-docx-page-index]'),function(e){return e.getAttribute('data-docx-page-index');}).join(','),"
            + "slides:Array.prototype.filter.call(document.querySelectorAll('[data-rpv-list-item]'),function(e){return !!e.querySelector('.rpv-normalized-slide');})"
            + ".map(function(e){return e.getAttribute('data-rpv-list-item');}).join(',')});})()";

    // %1$d: 마지막 쪽 번호(0부터). 한 화면에 다 들어가 스크롤할 것이 없는 문서(슬라이드 두 장 등)는 내리지 않아도 닿은 것으로 본다.
    static final String REACH_CHECK = "(function(){var h=document.querySelector('.word-host');"
            + "if(h){var last=h.querySelector('[data-docx-page-index=\"%1$d\"]');"
            + "return (h.scrollTop>0||h.scrollHeight<=h.clientHeight+1)&&!!last&&last.getBoundingClientRect().top<h.getBoundingClientRect().bottom;}"
            // PPT: 마지막 슬라이드 칸에 슬라이드가 그려져 있고 화면 안에
            + "var v=document.querySelector('.rpv-viewport');"
            + "if(v){var it=v.querySelector('[data-rpv-list-item=\"%1$d\"]');"
            + "return (v.scrollTop>0||v.scrollHeight<=v.clientHeight+1)&&!!it&&!!it.querySelector('.rpv-normalized-slide')"
            + "&&it.getBoundingClientRect().top<v.getBoundingClientRect().bottom;}"
            + "var all=document.querySelectorAll('.page');var p=all[all.length-1];"
            + "return (window.scrollY>0||document.documentElement.scrollHeight<=window.innerHeight+1)&&!!p&&p.getBoundingClientRect().top<window.innerHeight;})()";

    private static int cadPixels(String content) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("cad\\\\?\":(\\d+)").matcher(content);
        return m.find() ? Integer.parseInt(m.group(1)) : 0;
    }

    private static boolean containsAny(String name, String words) {
        for (String w : words.split(",")) {
            if (!w.trim().isEmpty() && name.contains(w.trim())) return true;
        }
        return false;
    }

    private static String judge(String expect, String report, String content) {
        boolean rendered = report.contains("\"state\":\"rendered\"");
        boolean error = report.contains("\"state\":\"error\"");
        String detail = report + " " + content;
        if (expect.equals("no-hang")) return report.startsWith("timeout") ? "FAIL " + detail : "ok " + detail;
        if (expect.startsWith("rendered:")) {
            String kind = expect.substring("rendered:".length());
            boolean hasContent = kind.equals("sheet") ? !content.contains("cells\\\":0")
                    : kind.equals("slides") ? !content.contains("slides\\\":0")
                    : kind.equals("word") ? !content.contains("word\\\":0")
                    : kind.equals("simple") ? !content.contains("simple\\\":0")
                    : kind.equals("cad") ? cadPixels(content) > 200 : !content.contains("imgs\\\":0");
            boolean ok = rendered && report.contains("\"kind\":\"" + kind + "\"") && hasContent && content.contains("has\\\":true");
            // 내장 렌더러로 넘어가면 보이긴 해도 도장·주석·비밀번호·글자 고르기가 빠진다. 정상 PDF는 pdf.js로 그려야 한다.
            if (kind.equals("pdf") && !report.contains("\"engine\":\"pdfjs\"")) ok = false;
            return (ok ? "ok " : "FAIL ") + detail;
        }
        if (expect.startsWith("password:")) return (rendered ? "ok " : "FAIL ") + detail;
        // 안내 문구는 바뀔 수 있어 화면이 보고한 이유(reason)로 판정한다.
        if (expect.startsWith("error:") && !expect.equals("error:any")) {
            String reason = "\"reason\":\"" + expect.substring("error:".length()) + "\"";
            return (error && report.contains(reason) ? "ok " : "FAIL ") + detail;
        }
        return (error ? "ok " : "FAIL ") + detail;
    }

    // ------------------------------------------------------------ 넘겨받는 방식

    @Test
    public void opensFromStreamingPipeProvider() throws Exception {
        String result = openAndJudge(TestFilesProvider.uri("pipe", "matrix/hwp5.0.3.0.hwp"),
                "application/x-hwp", "rendered:hwp", "", "pipe-hwp");
        assertTrue(result, result.startsWith("ok"));
        result = openAndJudge(TestFilesProvider.uri("pipe", "matrix/pdf-1.7.pdf"),
                "application/pdf", "rendered:pdf", "", "pipe-pdf");
        assertTrue(result, result.startsWith("ok"));
    }

    @Test
    public void opensWithoutDisplayNameOrType() throws Exception {
        String result = openAndJudge(TestFilesProvider.uri("noname", "matrix/excel97-biff8.xls"),
                "application/octet-stream", "rendered:sheet", "철판 2T", "noname-xls");
        assertTrue(result, result.startsWith("ok"));
    }

    // ------------------------------------------------------------ 화면 회전·폴드

    @Test
    public void keepsDocumentOnConfigurationChange() throws Exception {
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/hwp5.1.0.1.hwp"), "application/x-hwp")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] before = {null};
            scenario.onActivity(a -> before[0] = a);
            scenario.onActivity(a -> a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            SystemClock.sleep(3000);
            screenshot("rotate-landscape");
            scenario.onActivity(a -> a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            SystemClock.sleep(3000);
            ViewerActivity[] after = {null};
            int[] loadings = {0};
            scenario.onActivity(a -> {
                after[0] = a;
                for (String r : a.reports()) if (r.contains("\"state\":\"loading\"")) loadings[0]++;
            });
            assertTrue("화면 회전 때 화면을 새로 만들었다", before[0] == after[0]);
            assertEquals("화면 회전 때 문서를 다시 불러왔다", 1, loadings[0]);
            // 회전 직후에는 쪽을 다시 그리느라 화면 스크립트가 잠시 바빠 답이 늦을 수 있다(에뮬레이터에서 5초 넘게 걸린 적이 있다).
            // 20초까지 다시 묻고, 걸린 시간을 남긴다(늘 오래 걸리면 회전 성능 문제로 따로 본다).
            String content = null;
            long asked = SystemClock.uptimeMillis();
            long until = asked + 20_000;
            while (SystemClock.uptimeMillis() < until && (content == null || content.equals("0"))) {
                content = after[0].evaluateJavascriptForTest(
                        "(function(){var n=0;document.querySelectorAll('.page img').forEach(function(i){if(i.naturalWidth>0)n++;});return n;})()", 5000);
                if (content == null || content.equals("0")) SystemClock.sleep(500);
            }
            Log.i(TAG, "회전 뒤 쪽 그림 확인까지 " + (SystemClock.uptimeMillis() - asked) + "ms: " + content);
            assertTrue("회전 뒤 페이지가 비었다: " + content, content != null && !content.equals("0"));
        }
    }

    // ------------------------------------------------------------ PDF 주석·서식 칸

    @Test
    public void pdfShowsStampsFormValuesAndAnnotations() throws Exception {
        // 도장(스탬프 주석)·입력된 서식 칸·사각 주석을 각각 빨강·초록·파랑으로 그린 PDF.
        // 안드로이드 내장 렌더러는 이것들을 그리지 않아 계약서·신청서가 빈칸·도장 없이 보였다.
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/pdf-annotations.pdf"), "application/pdf")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String counts = null;
            long until = SystemClock.uptimeMillis() + 15_000;
            do {
                SystemClock.sleep(700);
                counts = activity[0].evaluateJavascriptForTest("(function(){var c=document.querySelector('.page canvas');"
                        + "if(!c||!c.width)return 'none';var d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;"
                        + "var r=0,g=0,b=0;for(var i=0;i<d.length;i+=4){var R=d[i],G=d[i+1],B=d[i+2];"
                        + "if(R>200&&G<60&&B<60)r++;else if(B>200&&R<60&&G<60)b++;else if(G>150&&R<60&&B<60)g++;}"
                        + "return r+','+g+','+b;})()", 5000);
            } while ((counts == null || counts.contains("none")) && SystemClock.uptimeMillis() < until);
            screenshot("pdf-annotations");
            Log.i(TAG, "PDF 주석 색 픽셀(빨강,초록,파랑): " + counts);
            String[] rgb = counts == null ? new String[0] : counts.replace("\"", "").split(",");
            assertEquals("PDF 주석을 그리지 못했다: " + counts, 3, rgb.length);
            assertTrue("도장(스탬프)이 안 보인다: " + counts, Integer.parseInt(rgb[0]) > 100);
            assertTrue("서식 칸 값이 안 보인다: " + counts, Integer.parseInt(rgb[1]) > 100);
            assertTrue("사각 주석이 안 보인다: " + counts, Integer.parseInt(rgb[2]) > 100);
        }
    }

    // ------------------------------------------------------------ 엑셀 속 그림

    @Test
    public void excelShowsEmbeddedLogoAndSeal() throws Exception {
        // 견적서의 회사 로고·직인 그림. SheetJS 무료판은 그림을 읽지 않아 앱이 직접 읽어 얹는다(xlsx와 옛 xls 모두).
        assertSheetImages("matrix/excel-images.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "excel-images");
        assertSheetImages("matrix/excel-images.xls", "application/vnd.ms-excel", "excel-images-xls");
    }

    @Test
    public void excelShowsCellFillsWithReadableText() throws Exception {
        // 칸 배경색: 진한 머리글은 흰 글자, 연한 합계 줄은 검은 글자(파일의 글자색, 배경과 대비가 모자라면 배경 밝기로 정한다).
        // 흰색 채우기는 눈금선 감추기용이 많아 기본 배경으로 둔다(어두운 화면에서 흰 판이 튀지 않게).
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/excel-fills.xlsx"),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String result = activity[0].evaluateJavascriptForTest(FILL_CHECK, 5000);
            screenshot("excel-fills");
            assertEquals("엑셀 칸 배경색·글자 대비가 기대와 다르다", "7", result);
        }
    }

    static final String FILL_CHECK = "(function(){var n=0;"
            + "document.querySelectorAll('.sheet td').forEach(function(td){var t=td.textContent,s=td.style;"
            + "if(t==='품목'&&s.backgroundColor==='rgb(31, 78, 120)'&&s.color==='rgb(255, 255, 255)')n+=1;"
            + "if(t==='합계'&&s.backgroundColor==='rgb(255, 242, 204)'&&(s.color==='rgb(31, 31, 31)'||s.color==='rgb(0, 0, 0)'))n+=2;"
            + "if(t==='비고'&&!s.backgroundColor)n+=4;});"
            + "return n;})()";

    @Test
    public void excelKeepsLayoutFreezeChartsAndNotes() throws Exception {
        // 엑셀에서 본 모양을 유지하는지: 틀 고정(머리 3줄·A열), 숨긴 행 10·열 H, 메모 표시, 숨긴 시트 칩, 차트 2개.
        // 차트에 저장된 값이 없으면 칸 값으로 그리고, 옛 xls 차트는 그리지 못하는 대신 빠졌다고 알려야 한다.
        String xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        assertRichSheet("matrix/excel-rich.xlsx", xlsx, "freeze,charts2,comment,hiddenSheet,hiddenRow,hiddenCol", "excel-rich");
        assertRichSheet("matrix/excel-chart-nocache.xlsx", xlsx, "freeze,charts2,comment,hiddenSheet,hiddenRow,hiddenCol",
                "excel-chart-nocache");
        // LibreOffice가 xls로 내보낼 때 틀 고정을 기록하지 않아 이 파일엔 틀 고정이 없다(실제 xls 틀 고정은 PC 검사에서 확인).
        assertRichSheet("matrix/excel-rich.xls", "application/vnd.ms-excel",
                "charts0,comment,hiddenSheet,hiddenRow,hiddenCol,chartNote", "excel-rich-xls");
    }

    @Test
    public void excelShowsConditionalFormatting() throws Exception {
        // 조건부 서식: 100 초과 초록·50 미만 빨강(빈칸도 0으로 보아 빨강), 수식 규칙($D2="완료")의 파란 굵은 글자,
        // 데이터 막대, 신호등 아이콘 7개, 상위 2개 주황 + 평균 이상 굵게(겹치지 않는 서식은 함께 입는다).
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/excel-conditional.xlsx"),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String result = null;
            long until = SystemClock.uptimeMillis() + 10_000;
            do {
                SystemClock.sleep(500);
                result = activity[0].evaluateJavascriptForTest(CF_CHECK, 5000);
            } while (!"63".equals(result) && SystemClock.uptimeMillis() < until);
            screenshot("excel-conditional");
            assertEquals("엑셀 조건부 서식이 기대와 다르다", "63", result);
        }
    }

    static final String CF_CHECK = "(function(){var n=0;var td=function(r,c){var tr=document.querySelector('tr[data-r=\"'+r+'\"]');"
            + "return tr?tr.querySelector('td[data-c=\"'+c+'\"]'):null;};"
            + "var a=td(1,1);if(a&&a.style.backgroundColor==='rgb(198, 239, 206)')n+=1;"
            + "var b=td(7,1);if(b&&b.style.backgroundColor==='rgb(255, 199, 206)')n+=2;"
            + "var c=td(4,0);if(c&&c.style.color==='rgb(0, 112, 192)'&&c.style.fontWeight==='700')n+=4;"
            + "var d=td(1,4);if(d&&/linear-gradient/.test(d.style.backgroundImage))n+=8;"
            + "if(document.querySelectorAll('.cf-icon').length===7)n+=16;"
            + "var e=td(1,6);if(e&&e.style.backgroundColor==='rgb(244, 177, 131)'&&e.style.fontWeight==='700')n+=32;"
            + "return n;})()";

    @Test
    public void documentExtrasAreAnnounced() throws Exception {
        // 엔진이 그리지 않는 것(메모·발표자 노트·수정 표시·수식·숨긴 슬라이드)을 조용히 빼지 않고 문서 위에 알려야 한다.
        assertExtras("matrix/word-extras.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                new String[]{"메모 1개", "수식 1개", "변경 내용"});
        assertExtras("matrix/slides-extras.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                new String[]{"발표자 노트 1개", "숨긴 슬라이드 1개"});
        assertExtras("matrix/hwp-memo.hwp", "application/x-hwp", new String[]{"메모 15개"});
    }

    @Test
    public void englishScreenWhenPhoneIsNotKorean() throws Exception {
        // 한국어가 아닌 휴대폰: 문서 안내가 영어로(한글 메모 15개 → "Comments (15)"), 한국어 글자 없이
        ViewerActivity.languageForTest = "en-US";
        assertExtras("matrix/hwp-memo.hwp", "application/x-hwp", new String[]{"Comments (15)"});
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/hwp-memo.hwp"), "application/x-hwp")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            await(scenario, "rendered", "error");
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String menu = activity[0].evaluateJavascriptForTest("(function(){return [].map.call(document.querySelectorAll('#menu .menu-item'),"
                    + "function(x){return x.textContent;}).join('|')+' lang='+document.documentElement.lang;})()", 5000);
            assertTrue("영어 메뉴가 아니다: " + menu, menu != null && menu.contains("Share file") && menu.contains("lang=en"));
            assertFalse("메뉴에 한국어가 남았다: " + menu, menu.matches("(?s).*[가-힣].*"));
        }
    }

    private void assertExtras(String path, String mime, String[] expected) throws Exception {
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", path), mime)
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "extras", "error");
            assertTrue(path + ": " + report, report.contains("\"state\":\"extras\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String notes = activity[0].evaluateJavascriptForTest("(function(){return [].map.call(document.querySelectorAll('.extras-note'),"
                    + "function(x){return x.textContent;}).join(' | ');})()", 5000);
            screenshot("extras-" + path.replaceAll("[^a-z0-9]+", "-"));
            for (String want : expected) assertTrue(path + ": 알림에 \"" + want + "\"이 없다: " + notes, notes != null && notes.contains(want));
        }
    }

    static final String RICH_CHECK = "(function(){var q=function(s){return document.querySelectorAll(s).length;};var o=[];"
            + "if(q('table.sheet-head tbody tr')===3&&q('td.stick-left')>0)o.push('freeze');"
            + "o.push('charts'+q('.sheet-chart svg'));"
            + "if(q('td.has-note')>0)o.push('comment');"
            + "var t=document.body.textContent;"
            + "if(t.indexOf('숨긴 시트 1개')>=0)o.push('hiddenSheet');"
            + "if(!document.querySelector('tr[data-r=\"9\"]')&&document.querySelector('tr[data-r=\"8\"]'))o.push('hiddenRow');"
            + "var h=[].map.call(document.querySelectorAll('th.col-head'),function(x){return x.textContent;}).join('');"
            + "if(h.indexOf('G')>=0&&h.indexOf('H')<0&&t.indexOf('열 1개')>=0)o.push('hiddenCol');"
            + "if(t.indexOf('차트 2개는 표시되지 않아요')>=0)o.push('chartNote');"
            + "return o.join(',');})()";

    private void assertRichSheet(String path, String mime, String expected, String shot) throws Exception {
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", path), mime)
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String result;
            long until = SystemClock.uptimeMillis() + 15_000;
            do {
                SystemClock.sleep(500);
                result = activity[0].evaluateJavascriptForTest(RICH_CHECK, 5000);
                if (result != null) result = result.replace("\"", "");
            } while (!expected.equals(result) && SystemClock.uptimeMillis() < until);
            screenshot(shot);
            assertEquals(path + ": 엑셀 모양(틀 고정·숨김·메모·차트)이 기대와 다르다", expected, result);
        }
    }

    private void assertSheetImages(String path, String mime, String shot) throws Exception {
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", path), mime)
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String count = null;
            long until = SystemClock.uptimeMillis() + 10_000;
            do {
                SystemClock.sleep(500);
                count = activity[0].evaluateJavascriptForTest("(function(){var n=0;"
                        + "document.querySelectorAll('.sheet-image').forEach(function(i){if(i.complete&&i.naturalWidth>0)n++;});"
                        + "return n;})()", 5000);
            } while (!"2".equals(count) && SystemClock.uptimeMillis() < until);
            screenshot(shot);
            assertEquals(path + ": 엑셀 속 그림(로고·직인)이 안 보인다", "2", count);
        }
    }

    @Test
    public void nativeEscapeAppearsWhileViewerScriptIsBusy() throws Exception {
        // 긴 워드 쪽 나누기처럼 화면 스크립트가 오래 멈추면 웹 화면의 버튼도 눌리지 않는다. 그때는 앱이 직접
        // "다른 앱으로 열기"를 띄워야 하고, 다 열렸다는 신호가 오면 치워야 한다.
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/excel-fills.xlsx"),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            boolean[] shown = {false};
            scenario.onActivity(a -> shown[0] = a.isEscapeShownForTest());
            assertFalse("다 열린 문서 위에 앱 버튼이 떠 있다", shown[0]);
            // 여는 중 신호를 한 번 보낸 뒤 화면 스크립트를 9초 동안 멈춘다(응답은 기다리지 않는다).
            activity[0].evaluateJavascriptForTest("(function(){DocViewer.loadingAlive();"
                    + "var e=Date.now()+9000;while(Date.now()<e){}return 1;})()", 100);
            long until = SystemClock.uptimeMillis() + 8_000;
            while (!shown[0] && SystemClock.uptimeMillis() < until) {
                SystemClock.sleep(250);
                scenario.onActivity(a -> shown[0] = a.isEscapeShownForTest());
            }
            screenshot("native-escape");
            assertTrue("화면 스크립트가 멈췄는데 앱의 \"다른 앱으로 열기\"가 뜨지 않았다", shown[0]);
            // 스크립트가 풀리고 다 열렸다는 신호가 오면 버튼을 치운다.
            activity[0].evaluateJavascriptForTest("(function(){DocViewer.loadingDone();return 1;})()", 15_000);
            until = SystemClock.uptimeMillis() + 3_000;
            do {
                SystemClock.sleep(250);
                scenario.onActivity(a -> shown[0] = a.isEscapeShownForTest());
            } while (shown[0] && SystemClock.uptimeMillis() < until);
            assertFalse("다 열렸다는 신호 뒤에도 앱 버튼이 남아 있다", shown[0]);
        }
    }

    @Test
    public void backClosesFindBarBeforeLeavingDocument() throws Exception {
        // 찾기 막대를 연 채 뒤로 가기를 누르면 문서가 닫히지 않고 찾기 막대만 닫혀야 한다. 한 번 더 누르면 평소처럼 나간다.
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/pdf-annotations.pdf"), "application/pdf")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            // 자판이 뜨면 첫 뒤로 가기는 자판을 닫는 데 쓰이므로 입력 칸에서 초점을 뺀다.
            String opened = activity[0].evaluateJavascriptForTest("(function(){document.getElementById('find').click();"
                    + "document.activeElement&&document.activeElement.blur();"
                    + "return document.body.classList.contains('finding');})()", 5000);
            assertEquals("찾기 막대가 열리지 않았다", "true", opened);
            // 입력 칸에 초점이 가면 자판이 뜨고, 자판이 떠 있으면 첫 뒤로 가기는 자판을 닫는다(안드로이드 기본 동작).
            // 자판은 늦게 올라오기도 해서(안드로이드 13 에뮬레이터) 실제로 내려간 것을 확인할 때까지 내린다.
            boolean[] ime = {true};
            long imeUntil = SystemClock.uptimeMillis() + 6_000;
            while (ime[0] && SystemClock.uptimeMillis() < imeUntil) {
                scenario.onActivity(a -> {
                    a.getSystemService(android.view.inputmethod.InputMethodManager.class)
                            .hideSoftInputFromWindow(a.getWindow().getDecorView().getWindowToken(), 0);
                    android.view.WindowInsets insets = a.getWindow().getDecorView().getRootWindowInsets();
                    ime[0] = insets != null && insets.isVisible(android.view.WindowInsets.Type.ime());
                });
                SystemClock.sleep(400);
            }
            Log.i(TAG, "뒤로 가기 시험: 자판 " + (ime[0] ? "아직 보임" : "내려감"));
            boolean[] target = {false};
            long until = SystemClock.uptimeMillis() + 3_000;
            while (!target[0] && SystemClock.uptimeMillis() < until) {
                SystemClock.sleep(200);
                scenario.onActivity(a -> target[0] = a.isBackTargetForTest());
            }
            assertTrue("찾기 막대를 열었는데 앱이 뒤로 가기 대상을 받지 못했다", target[0]);
            SystemClock.sleep(800);
            // CI #27~#30에서 이 시험이 세 기기에 번갈아 실패했는데, 진단해 보니 누를 때 우리 창에 입력 초점이 없어(0/0/nofocus)
            // 키가 앱에 오지 않았다. 에뮬레이터가 부팅 직후 다른 앱의 "응답 없음" 대화상자를 띄우는 일이 잦다.
            // 무엇이 초점을 쥐었는지 남기고, 시스템 대화상자를 닫은 뒤 초점이 돌아오기를 기다린다.
            android.app.UiAutomation ui = InstrumentationRegistry.getInstrumentation().getUiAutomation();
            boolean[] focus = {false};
            long focusUntil = SystemClock.uptimeMillis() + 10_000;
            boolean dialogsClosed = false;
            while (true) {
                scenario.onActivity(a -> focus[0] = a.hasWindowFocus());
                if (focus[0] || SystemClock.uptimeMillis() > focusUntil) break;
                if (!dialogsClosed) {
                    Log.i(TAG, "뒤로 가기 시험: 창 초점 없음 " + focusedWindow(ui));
                    shell(ui, "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS");
                    dialogsClosed = true;
                }
                SystemClock.sleep(300);
            }
            if (dialogsClosed) Log.i(TAG, "뒤로 가기 시험: 시스템 대화상자 닫은 뒤 창 초점 " + (focus[0] ? "돌아옴" : "여전히 없음 " + focusedWindow(ui)));
            // 막대가 아직 열려 있으면 사람이 쓰는 흐름처럼 한 번 더 누른다. 문서가 닫히면 안 되는 것은 누를 때마다 확인하고,
            // 몇 번째에 닫혔는지·키가 앱에 왔는지 남긴다. 초점이 끝내 돌아오지 않으면(앱 밖의 창 문제) 같은 키를
            // 액티비티에 직접 넣어 앱의 뒤로 가기 처리를 확인하고, 그렇게 했다고 남긴다.
            String still = "true";
            String[] diag = {""};
            int presses = 0;
            while ("true".equals(still) && presses < 2) {
                if (focus[0]) {
                    InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
                } else {
                    scenario.onActivity(a -> {
                        a.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_BACK));
                        a.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_BACK));
                    });
                    Log.i(TAG, "뒤로 가기 시험: 창 초점이 없어 키를 액티비티에 직접 넣음");
                }
                presses++;
                long closeUntil = SystemClock.uptimeMillis() + 3_000;
                do {
                    SystemClock.sleep(250);
                    assertEquals("뒤로 가기에 문서가 닫혔다", Lifecycle.State.RESUMED, scenario.getState());
                    still = activity[0].evaluateJavascriptForTest("(function(){return document.body.classList.contains('finding');})()", 5000);
                } while ("true".equals(still) && SystemClock.uptimeMillis() < closeUntil);
                scenario.onActivity(a -> diag[0] = a.backDiagnosticsForTest());
                Log.i(TAG, "뒤로 가기 시험: " + presses + "번째 누름 뒤 막대 " + ("true".equals(still) ? "열림" : "닫힘")
                        + ", 키/닫기/초점 " + diag[0]);
            }
            screenshot("back-closes-find");
            assertEquals("뒤로 가기에 찾기 막대가 닫히지 않았다(자판 " + (ime[0] ? "보임" : "내려감") + ", 키/닫기/초점 " + diag[0] + ")",
                    "false", still);
        }
    }

    // ------------------------------------------------------------ 뒤로 가기로 나가기

    @Test
    public void documentFromOtherAppClosesScreensUnderIt() throws Exception {
        // 설치 직후 "열기"로 띄운 시작 화면이 남아 있을 때 내 파일·카톡이 새 작업 플래그로 문서를 넘기면 안드로이드는
        // 문서 화면을 그 시작 화면 위에 올린다. 그대로 두면 뒤로 가기를 두 번 눌러야 나간다(시작 화면이 한 번 더 보임).
        Context app = ApplicationProvider.getApplicationContext();
        app.startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setClass(app, ViewerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ViewerActivity home = resumedViewer(null);
        ViewerActivity doc = null;
        try {
            assertTrue("시작 화면이 뜨지 않았다", home != null);
            app.startActivity(new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(TestFilesProvider.uri("file", "matrix/csv-utf8.csv"), "text/csv")
                    .setClass(app, ViewerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            doc = resumedViewer(home);
            assertTrue("문서 화면이 뜨지 않았다", doc != null);
            Log.i(TAG, "뒤로 가기 시험: 시작 화면 작업 " + home.getTaskId() + ", 문서 화면 작업 " + doc.getTaskId());
            long until = SystemClock.uptimeMillis() + 10_000;
            while (!home.isDestroyed() && SystemClock.uptimeMillis() < until) SystemClock.sleep(200);
            assertTrue("문서 화면 아래에 시작 화면이 남았다(뒤로 가기를 두 번 눌러야 나간다)", home.isFinishing() || home.isDestroyed());
            boolean[] root = {false};
            ViewerActivity d = doc;
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> root[0] = d.isTaskRoot());
            assertTrue("문서 화면이 작업의 맨 아래가 아니다", root[0]);
        } finally {
            ViewerActivity h = home;
            ViewerActivity d = doc;
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                if (d != null) d.finish();
                if (h != null && !h.isFinishing()) h.finish();
            });
        }
    }

    @Test
    public void backFromPickedDocumentReturnsToHome() throws Exception {
        // 시작 화면의 "파일 열기"로 고른 문서는 뒤로 가기에 앱을 나가지 않고 시작 화면으로 돌아가 다른 파일을 고를 수 있다.
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(ViewerActivity.class)) {
            String home = await(scenario, "home");
            assertTrue(home, home.contains("\"state\":\"home\""));
            scenario.onActivity(a -> a.openPickedForTest(TestFilesProvider.uri("file", "matrix/csv-utf8.csv"), "text/csv"));
            SystemClock.sleep(500);
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            scenario.onActivity(a -> {
                a.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_BACK));
                a.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_BACK));
            });
            SystemClock.sleep(500);
            String back = await(scenario, "home");
            assertTrue("뒤로 가기에 시작 화면으로 돌아가지 않았다: " + back, back.contains("\"state\":\"home\""));
            assertEquals("뒤로 가기에 앱이 닫혔다", Lifecycle.State.RESUMED, scenario.getState());
        }
    }

    @Test
    public void recentDocumentsReopenFromHome() throws Exception {
        // 다른 앱(카톡 등)이 넘긴 문서와 시작 화면에서 고른 문서가 "최근 문서"에 최근 연 순서로 남고, 앱만 켜도 목록이 나오며,
        // 목록에서 다시 열린다(다른 앱이 넘긴 문서는 앱 안 사본으로). 다시 연 문서는 맨 위로, 빼면 사본도 지워진다.
        // 시험 제공자는 계속 읽을 권한(takePersistableUriPermission)을 줄 수 없어 고른 문서도 사본으로 기억된다.
        android.content.Context ctx = ApplicationProvider.getApplicationContext();
        RecentDocs.awaitIdle(); // 앞 시험에서 연 문서의 기록이 끝난 뒤에 비운다
        RecentDocs.clear(ctx);
        try {
            Intent view = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(TestFilesProvider.uri("file", "matrix/excel2007.xlsx"),
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                    .setClass(ctx, ViewerActivity.class);
            try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(view)) {
                String report = await(scenario, "rendered", "error");
                assertTrue(report, report.contains("\"state\":\"rendered\""));
                SystemClock.sleep(300);
                RecentDocs.awaitIdle();
            }
            String afterView = RecentDocs.listJson(ctx);
            assertTrue("다른 앱에서 연 문서가 최근 문서에 없다: " + afterView,
                    afterView.contains("excel2007.xlsx") && afterView.contains("\"kind\":\"copy\""));
            String excelId = new org.json.JSONArray(afterView).getJSONObject(0).getString("id");
            assertTrue("앱 안 사본이 없다", RecentDocs.copyFile(ctx, excelId).isFile());

            try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(ViewerActivity.class)) {
                String home = await(scenario, "home");
                assertTrue("앱을 켜면 최근 문서 1개가 보여야 한다: " + home, home.contains("\"recent\":1"));
                scenario.onActivity(a -> a.openPickedForTest(TestFilesProvider.uri("file", "matrix/csv-utf8.csv"), "text/csv"));
                SystemClock.sleep(500);
                String picked = await(scenario, "rendered", "error");
                assertTrue(picked, picked.contains("\"state\":\"rendered\""));
                SystemClock.sleep(300);
                RecentDocs.awaitIdle();
                pressBack(scenario);
                String home2 = await(scenario, "home");
                assertTrue("고른 문서까지 2개여야 한다: " + home2, home2.contains("\"recent\":2"));
                ViewerActivity[] activity = {null};
                scenario.onActivity(a -> activity[0] = a);
                String names = "(function(){return [].map.call(document.querySelectorAll('.recent-name'),function(x){return x.textContent;}).join('|');})()";
                String order = activity[0].evaluateJavascriptForTest(names, 5000);
                assertTrue("최근 연 순서가 아니다: " + order, order.startsWith("\"csv-utf8.csv|excel2007.xlsx"));
                screenshot("recent-home");

                // 목록의 두 번째(다른 앱에서 연 엑셀)를 다시 연다: 원래 앱의 권한 없이 앱 안 사본으로 열린다
                activity[0].evaluateJavascriptForTest("document.querySelectorAll('.recent-open')[1].click()", 5000);
                SystemClock.sleep(500);
                String again = await(scenario, "rendered", "error");
                assertTrue("목록에서 다시 열지 못했다: " + again,
                        again.contains("\"state\":\"rendered\"") && again.contains("\"kind\":\"sheet\""));
                SystemClock.sleep(300);
                RecentDocs.awaitIdle();
                pressBack(scenario);
                await(scenario, "home");
                scenario.onActivity(a -> activity[0] = a);
                String order2 = activity[0].evaluateJavascriptForTest(names, 5000);
                assertTrue("다시 연 문서가 맨 위로 오지 않았다: " + order2, order2.startsWith("\"excel2007.xlsx|csv-utf8.csv"));

                // 맨 위 줄의 ⋮ → "목록에서 빼기": 목록과 앱 안 사본에서 함께 지워진다
                activity[0].evaluateJavascriptForTest("document.querySelector('.recent-item .recent-more').click()", 5000);
                SystemClock.sleep(500);
                activity[0].evaluateJavascriptForTest("document.querySelector('.recent-ask .btn-primary').click()", 5000);
                SystemClock.sleep(500);
                String left = RecentDocs.listJson(ctx);
                assertFalse("뺀 문서가 목록에 남았다: " + left, left.contains("excel2007.xlsx"));
                assertTrue("남은 문서가 사라졌다: " + left, left.contains("csv-utf8.csv"));
                assertFalse("뺀 문서의 사본이 남았다", RecentDocs.copyFile(ctx, excelId).exists());
            }
        } finally {
            RecentDocs.clear(ctx);
        }
    }

    private static void pressBack(ActivityScenario<ViewerActivity> scenario) {
        scenario.onActivity(a -> {
            a.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_BACK));
            a.dispatchKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_BACK));
        });
        SystemClock.sleep(500);
    }

    // 지금 앞에 떠 있는 뷰어 화면(not이 아닌 것)을 기다린다.
    private static ViewerActivity resumedViewer(ViewerActivity not) {
        ViewerActivity[] found = {null};
        long until = SystemClock.uptimeMillis() + 20_000;
        while (found[0] == null && SystemClock.uptimeMillis() < until) {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                for (android.app.Activity a : ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) {
                    if (a instanceof ViewerActivity && a != not) found[0] = (ViewerActivity) a;
                }
            });
            if (found[0] == null) SystemClock.sleep(200);
        }
        return found[0];
    }

    @Test
    public void excelKeepsZoomWhenRotated() throws Exception {
        // 화면보다 조금 넓은 엑셀을 100%로 보다가 가로로 돌리면 웹뷰가 "줄일 수 있는 만큼 대비 배율"을 지켜 2배 넘게 키웠다
        // (열이 더 보여야 할 때 같은 열이 크게 보임). 화면이 앱에 부탁해(zoomBy) 돌리기 전 배율로 되돌려야 한다.
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/excel-rich.xlsx"),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        android.app.UiAutomation ui = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String scale = "(function(){return Math.round(visualViewport.scale*100)/100+'|'+innerWidth;})()";
            String before = activity[0].evaluateJavascriptForTest(scale, 5000);
            ui.setRotation(android.app.UiAutomation.ROTATION_FREEZE_90);
            SystemClock.sleep(3000);
            String land = activity[0].evaluateJavascriptForTest(scale, 5000);
            screenshot("excel-rotated");
            ui.setRotation(android.app.UiAutomation.ROTATION_FREEZE_0);
            SystemClock.sleep(3000);
            String back = activity[0].evaluateJavascriptForTest(scale, 5000);
            Log.i(TAG, "엑셀 회전 배율|폭: 세로 " + before + ", 가로 " + land + ", 다시 세로 " + back);
            float s0 = Float.parseFloat(before.replace("\"", "").split("\\|")[0]);
            float s1 = Float.parseFloat(land.replace("\"", "").split("\\|")[0]);
            float s2 = Float.parseFloat(back.replace("\"", "").split("\\|")[0]);
            assertTrue("가로로 돌리니 배율이 바뀜: " + before + " → " + land, Math.abs(s1 - s0) < 0.05f);
            assertTrue("다시 세로로 돌리니 배율이 바뀜: " + before + " → " + back, Math.abs(s2 - s0) < 0.05f);
        } finally {
            ui.setRotation(android.app.UiAutomation.ROTATION_UNFREEZE);
        }
    }

    // ------------------------------------------------------------ 화면 다시 만들기·글자 크기

    @Test
    public void reopensFromCachedCopyWhenRecreated() throws Exception {
        // 다크 모드 전환 등으로 화면이 다시 만들어지면 받아 둔 사본으로 이어서 연다(카톡 권한이 만료돼도 열리게).
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/excel2007.xlsx"),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            scenario.recreate();
            String again = await(scenario, "rendered", "error");
            assertTrue(again, again.contains("\"state\":\"rendered\"") && again.contains("\"kind\":\"sheet\""));
        }
    }

    @Test
    public void keepsDocumentTextSizeWhenSystemFontIsLarge() throws Exception {
        // 웹뷰는 기본으로 시스템 글자 크기를 문서 글자에도 곱해 표·쪽 배치가 어긋난다. 문서는 원래 크기, 앱 버튼만 커져야 한다.
        android.app.UiAutomation ui = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        String before = shell(ui, "settings get system font_scale").trim();
        try {
            shell(ui, "settings put system font_scale 1.3");
            SystemClock.sleep(1500);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(TestFilesProvider.uri("file", "matrix/csv-utf8.csv"), "text/csv")
                    .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
            try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
                String report = await(scenario, "rendered", "error");
                assertTrue(report, report.contains("\"state\":\"rendered\""));
                ViewerActivity[] activity = {null};
                scenario.onActivity(a -> activity[0] = a);
                String sizes = activity[0].evaluateJavascriptForTest("(function(){"
                        + "var td=document.querySelector('.sheet td'),t=document.getElementById('title');"
                        + "return getComputedStyle(td).fontSize+'|'+getComputedStyle(t).fontSize;})()", 5000);
                screenshot("font-scale-1.3");
                Log.i(TAG, "글자 크기 1.3배일 때 표·제목 글자 크기: " + sizes);
                String[] px = sizes == null ? new String[0] : sizes.replace("\"", "").replace("px", "").split("\\|");
                assertEquals("크기를 읽지 못했다: " + sizes, 2, px.length);
                float cell = Float.parseFloat(px[0]);
                float title = Float.parseFloat(px[1]);
                assertTrue("문서(표) 글자가 시스템 글자 크기만큼 커졌다: " + sizes, cell < 14.5f);
                assertTrue("앱 제목 글자가 시스템 글자 크기를 따르지 않았다: " + sizes, title > 16.5f);
            }
        } finally {
            shell(ui, "settings put system font_scale " + (before.isEmpty() || before.equals("null") ? "1.0" : before));
        }
    }

    // 지금 입력 초점을 가진 창(dumpsys window의 mCurrentFocus 줄)
    private static String focusedWindow(android.app.UiAutomation ui) {
        try {
            for (String line : shell(ui, "dumpsys window").split("\n")) {
                if (line.contains("mCurrentFocus")) return line.trim();
            }
        } catch (IOException e) {
            return "dumpsys 실패: " + e;
        }
        return "mCurrentFocus 없음";
    }

    private static String shell(android.app.UiAutomation ui, String command) throws IOException {
        try (android.os.ParcelFileDescriptor pfd = ui.executeShellCommand(command);
             java.io.InputStream in = new android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    // ------------------------------------------------------------ 웹 화면 프로세스가 사라질 때

    @Test
    public void reopensDocumentWhenRendererKilledInBackground() throws Exception {
        // 카톡 답장 등으로 앱이 뒤에 있는 사이 시스템이 웹 화면 프로세스를 정리해도, 돌아오면 문서가 다시 보여야 한다.
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/word2007.docx"),
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.onActivity(a -> {
                a.reports().clear();
                a.loadUrlForTest("chrome://kill");
            });
            SystemClock.sleep(3000);
            scenario.moveToState(Lifecycle.State.RESUMED);
            String again = await(scenario, "rendered", "error");
            screenshot("renderer-killed-reopened");
            assertTrue(again, again.contains("\"state\":\"rendered\"") && again.contains("\"kind\":\"word\""));
            boolean[] finishing = {true};
            scenario.onActivity(a -> finishing[0] = a.isFinishing());
            assertFalse("웹 화면 프로세스가 정리됐다고 앱이 닫혔다", finishing[0]);
        }
    }

    @Test
    public void showsNoticeWhenRendererCrashes() throws Exception {
        // 문서 때문에 웹 화면이 죽으면 앱을 닫지 않고 "다른 앱으로 열기" 안내를 보여야 한다.
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/hwp5.0.3.0.hwp"), "application/x-hwp")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            scenario.onActivity(a -> {
                a.reports().clear();
                a.loadUrlForTest("chrome://crash");
            });
            String after = await(scenario, "error");
            screenshot("renderer-crashed-notice");
            assertTrue(after, after.contains("\"reason\":\"memory\""));
        }
    }

    // ------------------------------------------------------------ 도우미

    private static List<String[]> readManifest() throws IOException {
        Context test = InstrumentationRegistry.getInstrumentation().getContext();
        List<String[]> rows = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                test.getAssets().open("matrix/manifest.tsv"), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                if (line.isEmpty() || line.startsWith("#")) continue;
                rows.add(line.split("\t", -1));
            }
        }
        return rows;
    }

    @Test
    public void exportPagesSavesToGalleryAndCleansUp() throws Exception {
        // 쪽을 이미지로 → 사진첩에 저장: 고른 2쪽이 Pictures/be docs 앨범에 JPG로 들어가야 한다. 시험 뒤 지운다.
        Context context = ApplicationProvider.getApplicationContext();
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/pdf-1.7.pdf"), "application/pdf")
                .setClass(context, ViewerActivity.class);
        android.content.ContentResolver resolver = context.getContentResolver();
        Uri images = android.provider.MediaStore.Images.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String where = android.provider.MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND "
                + android.provider.MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
        String[] args = {"%" + ImageExport.ALBUM + "%", "pdf-1.7_p%"};
        resolver.delete(images, where, args);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String opened = activity[0].evaluateJavascriptForTest("(function(){document.getElementById('menu-export').click();"
                    + "var i=document.querySelector('.export-range input');i.value='1-2';"
                    + "document.querySelector('.export-range button').click();"
                    + "return document.querySelector('.export-count').textContent;})()", 5000);
            assertEquals("쪽을 고르지 못했다", "\"2쪽 선택\"", opened);
            activity[0].evaluateJavascriptForTest("(function(){document.querySelector('.export-actions .btn:not(.btn-primary)').click();return 1;})()", 5000);
            String done = await(scenario, "export", "export-error");
            assertTrue(done, done.contains("\"state\":\"export\"") && done.contains("\"pages\":2"));
            List<String> names = new ArrayList<>();
            try (android.database.Cursor c = resolver.query(images,
                    new String[]{android.provider.MediaStore.MediaColumns._ID, android.provider.MediaStore.MediaColumns.DISPLAY_NAME},
                    where, args, android.provider.MediaStore.MediaColumns.DISPLAY_NAME)) {
                while (c != null && c.moveToNext()) {
                    names.add(c.getString(1));
                    Uri one = android.content.ContentUris.withAppendedId(images, c.getLong(0));
                    try (java.io.InputStream in = resolver.openInputStream(one)) {
                        byte[] head = new byte[3];
                        assertEquals(3, in.read(head));
                        boolean png = c.getString(1).endsWith(".png") && (head[0] & 0xff) == 0x89 && head[1] == 'P';
                        boolean jpg = c.getString(1).endsWith(".jpg") && (head[0] & 0xff) == 0xff && (head[1] & 0xff) == 0xd8;
                        assertTrue("PNG·JPG가 아니거나 이름과 다르다: " + c.getString(1), png || jpg);
                    }
                }
            }
            // 글자 쪽은 PNG, 사진이 많은 쪽은 JPG
            assertTrue("사진첩에 든 그림: " + names, names.size() == 2
                    && names.get(0).matches("pdf-1\\.7_p1\\.(png|jpg)") && names.get(1).matches("pdf-1\\.7_p2\\.(png|jpg)"));
        } finally {
            resolver.delete(images, where, args);
        }
    }

    @Test
    public void downloadSavesOriginalToDownloadsFolder() throws Exception {
        // 메뉴의 다운로드: 다른 앱이 넘겨준 파일(content://)을 원본 바이트 그대로 다운로드 폴더에 저장해야 한다. 시험 뒤 지운다.
        Context context = ApplicationProvider.getApplicationContext();
        Context test = InstrumentationRegistry.getInstrumentation().getContext();
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/pdf-1.7.pdf"), "application/pdf")
                .setClass(context, ViewerActivity.class);
        android.content.ContentResolver resolver = context.getContentResolver();
        Uri downloads = android.provider.MediaStore.Downloads.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String where = android.provider.MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND "
                + android.provider.MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
        String[] args = {android.os.Environment.DIRECTORY_DOWNLOADS + "%", "pdf-1.7%.pdf"};
        resolver.delete(downloads, where, args);
        byte[] original = readAll(test.getAssets().open("matrix/pdf-1.7.pdf"));
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            String shown = activity[0].evaluateJavascriptForTest("(function(){document.getElementById('menu-btn').click();"
                    + "var d=document.getElementById('menu-download');var s=!d.hidden;d.click();return s;})()", 5000);
            assertEquals("메뉴에 다운로드가 없다", "true", shown);
            // 저장은 화면 스레드 밖에서 한다. 나타날 때까지 기다린다.
            List<String> names = new ArrayList<>();
            byte[] saved = null;
            for (long end = SystemClock.uptimeMillis() + 15000; saved == null && SystemClock.uptimeMillis() < end; ) {
                names.clear();
                try (android.database.Cursor c = resolver.query(downloads,
                        new String[]{android.provider.MediaStore.MediaColumns._ID, android.provider.MediaStore.MediaColumns.DISPLAY_NAME},
                        where + " AND " + android.provider.MediaStore.MediaColumns.IS_PENDING + "=0", args, null)) {
                    while (c != null && c.moveToNext()) {
                        names.add(c.getString(1));
                        saved = readAll(resolver.openInputStream(android.content.ContentUris.withAppendedId(downloads, c.getLong(0))));
                    }
                }
                if (saved == null) SystemClock.sleep(300);
            }
            assertEquals("다운로드 폴더에 든 파일: " + names, java.util.Collections.singletonList("pdf-1.7.pdf"), names);
            assertTrue("원본과 바이트가 다르다", java.util.Arrays.equals(original, saved));
        } finally {
            resolver.delete(downloads, where, args);
        }
    }

    @Test
    public void downloadKeepsHangulDocumentExtensions() throws Exception {
        // 시스템이 모르는 확장자(hwp·hwpx)도 이름 그대로 저장돼야 한다(종류가 맞지 않으면 시스템이 ".bin" 등을 덧붙인다).
        Context context = ApplicationProvider.getApplicationContext();
        android.content.ContentResolver resolver = context.getContentResolver();
        Uri downloads = android.provider.MediaStore.Downloads.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String where = android.provider.MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
        String[] args = {"be-docs-download-test%"};
        resolver.delete(downloads, where, args);
        File src = new File(context.getCacheDir(), "download-test.bin");
        try (OutputStream out = new FileOutputStream(src)) {
            out.write("HWP Document File".getBytes(StandardCharsets.US_ASCII));
        }
        try {
            assertEquals("be-docs-download-test 한글.hwp", DownloadSave.save(context, src, "be-docs-download-test 한글.hwp"));
            assertEquals("be-docs-download-test.hwpx", DownloadSave.save(context, src, "be-docs-download-test.hwpx"));
            assertEquals("be-docs-download-test_a_b.pdf", DownloadSave.save(context, src, "be-docs-download-test/a:b.pdf"));
            // 같은 이름이 있으면 지우거나 덮지 않고 다른 이름으로
            // 시스템은 모르는 확장자(hwpx) 뒤에 번호를 붙인다("….hwpx (1)") — 앱이 "… (1).hwpx"로 고친다
            String again = DownloadSave.save(context, src, "be-docs-download-test.hwpx");
            assertTrue("같은 이름을 덮었거나 확장자가 깨졌다: " + again, !"be-docs-download-test.hwpx".equals(again) && again.endsWith(".hwpx"));
            String third = DownloadSave.save(context, src, "be-docs-download-test.hwpx");
            assertTrue("세 번째 이름: " + third, !third.equals(again) && !"be-docs-download-test.hwpx".equals(third) && third.endsWith(".hwpx"));
            String pdf = DownloadSave.save(context, src, "be-docs-download-test/a:b.pdf");
            assertTrue("pdf 두 번째 이름: " + pdf, !"be-docs-download-test_a_b.pdf".equals(pdf) && pdf.endsWith(".pdf"));
        } finally {
            resolver.delete(downloads, where, args);
            //noinspection ResultOfMethodCallIgnored
            src.delete();
        }
    }

    @Test
    public void printPaperFollowsDocumentPage() {
        // PDF로 저장: 인쇄 창의 종이를 화면이 고른 종이로 미리 고른다. 안드로이드 "PDF로 저장"은 정해 둔 크기만 받으므로
        // 화면(viewer.js paperFor)이 고르는 종이는 모두 안드로이드의 정해 둔 크기(같은 id)로 넘어가야 한다.
        android.print.PrintAttributes.MediaSize a4 = ViewerActivity.mediaFor(210.0, 297.0);
        assertEquals(android.print.PrintAttributes.MediaSize.ISO_A4.getId(), a4.getId());
        assertTrue(a4.isPortrait());
        android.print.PrintAttributes.MediaSize a4Wide = ViewerActivity.mediaFor(297.0, 210.0);
        assertEquals(android.print.PrintAttributes.MediaSize.ISO_A4.getId(), a4Wide.getId());
        assertTrue(!a4Wide.isPortrait());
        assertEquals(android.print.PrintAttributes.MediaSize.NA_LETTER.getId(), ViewerActivity.mediaFor(215.9, 279.4).getId());
        double[][] papers = {{297, 420}, {148, 210}, {250, 353}, {176, 250}, {257, 364}, {182, 257}, {215.9, 355.6}, {279.4, 431.8}};
        String[] ids = {
                android.print.PrintAttributes.MediaSize.ISO_A3.getId(), android.print.PrintAttributes.MediaSize.ISO_A5.getId(),
                android.print.PrintAttributes.MediaSize.ISO_B4.getId(), android.print.PrintAttributes.MediaSize.ISO_B5.getId(),
                android.print.PrintAttributes.MediaSize.JIS_B4.getId(), android.print.PrintAttributes.MediaSize.JIS_B5.getId(),
                android.print.PrintAttributes.MediaSize.NA_LEGAL.getId(), android.print.PrintAttributes.MediaSize.NA_TABLOID.getId(),
        };
        for (int i = 0; i < papers.length; i++) {
            assertEquals(papers[i][0] + "×" + papers[i][1], ids[i], ViewerActivity.mediaFor(papers[i][0], papers[i][1]).getId());
            assertEquals(papers[i][1] + "×" + papers[i][0], ids[i], ViewerActivity.mediaFor(papers[i][1], papers[i][0]).getId());
        }
        // 목록에 없는 크기는 그대로 넘긴다(화면은 넘기지 않지만, 넘어오면 인쇄 창이 기본 종이로 바꾼다)
        android.print.PrintAttributes.MediaSize slide = ViewerActivity.mediaFor(338.7, 190.5);
        assertEquals(13335, slide.getWidthMils());
        assertEquals(7500, slide.getHeightMils());
    }

    @Test
    public void savesDocumentsAsPdfThroughWebViewPrinting() throws Exception {
        // PDF로 저장·인쇄: 인쇄 창이 받는 것(웹뷰의 실제 인쇄 결과, PDF 문서는 원본)을 파일로 받아 쪽 수·종이·첫 쪽과 마지막 쪽의 내용을 본다.
        // 워드·PPT 엔진은 평소 화면 근처만 그려, 인쇄하는 동안 모든 쪽을 그리지 않으면 마지막 쪽이 비거나 쪽 수가 모자란다.
        // 16:9 슬라이드는 안드로이드 PDF 종이 목록에 없어 가로 A4에 맞춰 담는다(인쇄는 둘레 10mm 여백).
        String[][] cases = {
                // 파일, 형식, 쪽 수, 결과 쪽 크기(pt), 메뉴
                {"matrix/word-12-pages.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "12", "612x792", "menu-pdf"},
                {"matrix/slides-12.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "12", "842x595", "menu-pdf"},
                {"matrix/hwp5.0.2.5.hwp", "application/x-hwp", "17", "595x842", "menu-pdf"},
                {"matrix/slides-12.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "12", "842x595", "menu-print"},
                // PDF 문서 인쇄는 원본을 그대로 넘긴다(쪽 크기도 원본 그대로, 종이에 맞추는 것은 인쇄 창이)
                {"matrix/pdf-1.7.pdf", "application/pdf", "4", "720x540", "menu-print"},
        };
        Context context = ApplicationProvider.getApplicationContext();
        File out = new File(context.getCacheDir(), "print-test.pdf");
        try {
            for (String[] c : cases) {
                //noinspection ResultOfMethodCallIgnored
                out.delete();
                java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
                String[] result = {null, null}; // 오류, 인쇄 이름
                ViewerActivity.printSinkForTest = (job, adapter, attributes) -> {
                    result[1] = job + " " + attributes.getMediaSize().getId() + " " + attributes.getMediaSize().getWidthMils() + "x" + attributes.getMediaSize().getHeightMils();
                    // 인쇄 창의 "PDF로 저장"이 넘기는 값: 고른 종이, 300dpi, 여백 없음
                    android.print.PrintAttributes pdf = new android.print.PrintAttributes.Builder()
                            .setMediaSize(attributes.getMediaSize())
                            .setResolution(new android.print.PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                            .setMinMargins(android.print.PrintAttributes.Margins.NO_MARGINS)
                            .setColorMode(android.print.PrintAttributes.COLOR_MODE_COLOR)
                            .build();
                    try {
                        android.os.ParcelFileDescriptor fd = android.os.ParcelFileDescriptor.open(out,
                                android.os.ParcelFileDescriptor.MODE_CREATE | android.os.ParcelFileDescriptor.MODE_TRUNCATE
                                        | android.os.ParcelFileDescriptor.MODE_READ_WRITE);
                        android.print.PrintToFile.write(adapter, pdf, fd, error -> {
                            try {
                                fd.close();
                            } catch (IOException ignored) {
                                // 닫기 실패는 결과에 영향이 없다
                            }
                            result[0] = error;
                            done.countDown();
                        });
                    } catch (IOException | RuntimeException | LinkageError e) {
                        result[0] = String.valueOf(e);
                        done.countDown();
                    }
                };
                Intent intent = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(TestFilesProvider.uri("file", c[0]), c[1])
                        .setClass(context, ViewerActivity.class);
                try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
                    String report = await(scenario, "rendered", "error");
                    assertTrue(c[0] + ": " + report, report.contains("\"state\":\"rendered\""));
                    ViewerActivity[] activity = {null};
                    scenario.onActivity(a -> activity[0] = a);
                    String shown = activity[0].evaluateJavascriptForTest(
                            "(function(){document.getElementById('menu-btn').click();return !document.getElementById('" + c[4] + "').hidden;})()", 5000);
                    assertEquals(c[0] + ": 메뉴에 " + c[4] + "이 보여야 함", "true", shown);
                    activity[0].evaluateJavascriptForTest("document.getElementById('" + c[4] + "').click()", 5000);
                    assertTrue(c[0] + ": 인쇄가 끝나지 않음", done.await(TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS));
                    Log.i(TAG, c[4] + " " + c[0] + ": " + result[1] + ", 결과 " + (result[0] == null ? "성공" : result[0]));
                    assertEquals(c[0] + ": 웹뷰 인쇄 실패", null, result[0]);
                    // 인쇄가 끝나면(beDocsPrintDone) 화면이 원래대로
                    String restored = "";
                    long end = SystemClock.uptimeMillis() + 10000;
                    while (SystemClock.uptimeMillis() < end) {
                        restored = activity[0].evaluateJavascriptForTest("(function(){var h=document.documentElement.className;"
                                + "return h.indexOf('printing')<0&&!document.getElementById('print-root')&&!document.querySelector('.print-wait');})()", 5000);
                        if ("true".equals(restored)) break;
                        SystemClock.sleep(250);
                    }
                    assertEquals(c[0] + ": 인쇄 뒤 화면이 원래대로 돌아오지 않음", "true", restored);
                    try (android.os.ParcelFileDescriptor fd = android.os.ParcelFileDescriptor.open(out, android.os.ParcelFileDescriptor.MODE_READ_ONLY);
                         android.graphics.pdf.PdfRenderer pdf = new android.graphics.pdf.PdfRenderer(fd)) {
                        int pages = pdf.getPageCount();
                        String size;
                        int firstInk;
                        int lastInk;
                        try (android.graphics.pdf.PdfRenderer.Page page = pdf.openPage(0)) {
                            size = page.getWidth() + "x" + page.getHeight();
                            firstInk = ink(page);
                        }
                        try (android.graphics.pdf.PdfRenderer.Page page = pdf.openPage(pages - 1)) {
                            lastInk = ink(page);
                        }
                        Log.i(TAG, c[4] + " " + c[0] + ": " + pages + "쪽, " + size + "pt, 글자·그림 점 첫 쪽 " + firstInk + " 마지막 쪽 " + lastInk);
                        assertEquals(c[0] + ": 쪽 수", Integer.parseInt(c[2]), pages);
                        String[] want = c[3].split("x");
                        String[] got = size.split("x");
                        assertTrue(c[0] + ": 종이 " + size + "pt(기대 " + c[3] + ")",
                                Math.abs(Integer.parseInt(got[0]) - Integer.parseInt(want[0])) <= 2
                                        && Math.abs(Integer.parseInt(got[1]) - Integer.parseInt(want[1])) <= 2);
                        assertTrue(c[0] + ": 첫 쪽이 비었음", firstInk > 50);
                        assertTrue(c[0] + ": 마지막 쪽이 비었음(모든 쪽을 그리지 않고 인쇄)", lastInk > 50);
                    }
                }
            }
        } finally {
            ViewerActivity.printSinkForTest = null;
            //noinspection ResultOfMethodCallIgnored
            out.delete();
        }
    }

    @Test
    public void pdfSaveOpensPrintScreenAndRestoresWhenClosed() throws Exception {
        // PDF로 저장의 실제 인쇄 창: 고른 종이(레터 문서 → 레터)로 열리고, 뒤로 가기로 닫으면 화면이 원래대로 돌아온다.
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(TestFilesProvider.uri("file", "matrix/word-12-pages.docx"),
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        android.app.UiAutomation ui = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            ViewerActivity[] activity = {null};
            scenario.onActivity(a -> activity[0] = a);
            activity[0].evaluateJavascriptForTest(
                    "(function(){document.getElementById('menu-btn').click();document.getElementById('menu-pdf').click();})()", 5000);
            // 인쇄 작업 조회는 메인 스레드에서(PrintManager·PrintJob은 메인 스레드용). 인쇄 창이 위에 있어 문서 화면은 멈춘 상태다.
            android.print.PrintManager printer = (android.print.PrintManager) activity[0].getSystemService(Context.PRINT_SERVICE);
            android.print.PrintJobInfo[] found = {null};
            long end = SystemClock.uptimeMillis() + 30000;
            while (found[0] == null && SystemClock.uptimeMillis() < end) {
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                    for (android.print.PrintJob j : printer.getPrintJobs()) {
                        android.print.PrintJobInfo info = j.getInfo();
                        if (info != null && "word-12-pages".equals(info.getLabel()) && info.getState() == android.print.PrintJobInfo.STATE_CREATED) {
                            found[0] = info;
                        }
                    }
                });
                if (found[0] == null) SystemClock.sleep(250);
            }
            android.print.PrintJobInfo job = found[0];
            assertTrue("인쇄 창이 열리지 않음", job != null);
            android.print.PrintAttributes.MediaSize media = job.getAttributes().getMediaSize();
            Log.i(TAG, "인쇄 창: " + job.getLabel() + ", 종이 " + (media == null ? null : media.getId() + " " + media.getWidthMils() + "x" + media.getHeightMils()));
            assertTrue("인쇄 창 종이: " + media, media != null && android.print.PrintAttributes.MediaSize.NA_LETTER.getId().equals(media.getId()) && media.isPortrait());
            SystemClock.sleep(3000);
            screenshot("print-dialog");
            String restored = "";
            for (int i = 0; i < 3 && !"true".equals(restored); i++) {
                shell(ui, "input keyevent KEYCODE_BACK");
                end = SystemClock.uptimeMillis() + 8000;
                while (SystemClock.uptimeMillis() < end) {
                    restored = activity[0].evaluateJavascriptForTest("(function(){var h=document.documentElement.className;"
                            + "return h.indexOf('printing')<0&&!document.querySelector('.print-wait');})()", 5000);
                    if ("true".equals(restored)) break;
                    SystemClock.sleep(250);
                }
            }
            assertEquals("인쇄 창을 닫은 뒤 화면이 원래대로 돌아오지 않음", "true", restored);
            assertEquals("인쇄 창을 닫은 뒤 문서 화면이 아님", Lifecycle.State.RESUMED, scenario.getState());
        }
    }

    /** 쪽을 작게 그려 흰색이 아닌 점의 수(글자·그림이 있는지). */
    private static int ink(android.graphics.pdf.PdfRenderer.Page page) {
        Bitmap bitmap = Bitmap.createBitmap(Math.max(1, page.getWidth() / 3), Math.max(1, page.getHeight() / 3), Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(android.graphics.Color.WHITE);
        page.render(bitmap, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
        int[] px = new int[bitmap.getWidth() * bitmap.getHeight()];
        bitmap.getPixels(px, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());
        bitmap.recycle();
        int n = 0;
        for (int p : px) {
            if (android.graphics.Color.red(p) + android.graphics.Color.green(p) + android.graphics.Color.blue(p) < 600) n++;
        }
        return n;
    }

    @Test
    public void shareCopyUsesEditedNameButKeepsExtension() throws Exception {
        // 파일 공유하기에서 고친 이름: 확장자는 원래 것, 쓸 수 없는 글자는 _, 비우면 원래 이름
        assertEquals("회의 자료.hwp", ShareCopy.nameFor("회의 자료", "원본.hwp"));
        assertEquals("보고서.hwpx", ShareCopy.nameFor("보고서.HWPX", "원본.hwpx"));
        assertEquals("a_b.pdf", ShareCopy.nameFor("a/b", "x.pdf"));
        assertEquals("원본.xlsx", ShareCopy.nameFor("   ", "원본.xlsx"));
        assertEquals("원본.xlsx", ShareCopy.nameFor("///", "원본.xlsx"));
        assertEquals("새 이름", ShareCopy.nameFor("새 이름", "확장자없음"));

        // 받는 앱이 보는 이름(DISPLAY_NAME)·종류·내용이 맞고, 원본 사본과 같은 바이트다
        Context context = ApplicationProvider.getApplicationContext();
        File src = new File(context.getCacheDir(), "share-test.bin");
        byte[] body = "HWP Document File 공유 시험".getBytes(StandardCharsets.UTF_8);
        try (OutputStream out = new FileOutputStream(src)) {
            out.write(body);
        }
        File made = ShareCopy.make(context, src, "회의 자료 10_18.hwp");
        try {
            Uri uri = ExportProvider.shareUri(ExportProvider.authority(context), made);
            android.content.ContentResolver resolver = context.getContentResolver();
            try (android.database.Cursor c = resolver.query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                assertTrue(c != null && c.moveToFirst());
                assertEquals("회의 자료 10_18.hwp", c.getString(0));
            }
            assertEquals("application/x-hwp", resolver.getType(uri));
            assertArrayEquals(body, readAll(resolver.openInputStream(uri)));
            // 같은 이름으로 또 공유해도 앞의 것을 덮지 않는다(받는 앱이 아직 읽는 중일 수 있다)
            File again = ShareCopy.make(context, src, "회의 자료 10_18.hwp");
            assertTrue(!again.equals(made) && made.isFile() && again.isFile());
            // 공유 폴더 밖은 열지 않는다
            Uri outside = uri.buildUpon().path("share/../../export/x").build();
            try {
                resolver.openInputStream(outside).close();
                throw new AssertionError("share 폴더 밖이 열렸다");
            } catch (java.io.FileNotFoundException | SecurityException | NullPointerException expected) {
                // 기대한 동작
            }
        } finally {
            //noinspection ResultOfMethodCallIgnored
            src.delete();
        }
    }

    private static byte[] readAll(java.io.InputStream in) throws IOException {
        try (java.io.InputStream is = in; java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = is.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    @Test
    public void exportShareAddressIsReadOnlyAndStaysInItsFolder() throws Exception {
        // 보내기용 주소(ExportProvider): 만든 그림을 읽을 수 있고, 쓰기·폴더 밖 파일은 막혀야 한다.
        Context context = ApplicationProvider.getApplicationContext();
        // 새 내보내기는 시작할 때 지난번 그림을 지우므로(ImageExport), PNG가 아닌 내용 거절은 먼저 확인한다.
        assertFalse("PNG가 아닌 내용을 그림으로 받았다", new ImageExport(context, false).part("x", "image/png", "AAAAAAAA", true));
        ImageExport job = new ImageExport(context, false);
        // 1×1 PNG
        String png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        assertTrue(job.part("시험/../쪽", "image/png", png, true));
        List<Uri> uris = job.finish();
        assertEquals(1, uris.size());
        Uri uri = uris.get(0);
        assertEquals("image/png", context.getContentResolver().getType(uri));
        try (java.io.InputStream in = context.getContentResolver().openInputStream(uri)) {
            byte[] head = new byte[4];
            assertEquals(4, in.read(head));
            assertEquals('P', head[1]);
        }
        try (android.database.Cursor c = context.getContentResolver().query(uri, null, null, null, null)) {
            assertTrue(c != null && c.moveToFirst());
            assertEquals("시험_.._쪽.png", c.getString(c.getColumnIndexOrThrow(android.provider.OpenableColumns.DISPLAY_NAME)));
        }
        boolean writeBlocked = false;
        try (OutputStream out = context.getContentResolver().openOutputStream(uri)) {
            if (out != null) out.write(1);
        } catch (SecurityException | IOException e) {
            writeBlocked = true;
        }
        assertTrue("보내기용 주소에 쓸 수 있다", writeBlocked);
        File secret = new File(context.getCacheDir(), "secret.txt");
        try (OutputStream out = new FileOutputStream(secret)) {
            out.write(1);
        }
        Uri escape = Uri.parse("content://" + ExportProvider.authority(context) + "/..%2Fsecret.txt");
        boolean escapeBlocked = false;
        try (java.io.InputStream in = context.getContentResolver().openInputStream(escape)) {
            escapeBlocked = in == null;
        } catch (IOException | SecurityException e) {
            escapeBlocked = true;
        }
        //noinspection ResultOfMethodCallIgnored
        secret.delete();
        assertTrue("export 폴더 밖 파일이 열렸다", escapeBlocked);
        job.cancel();
    }

    private static String await(ActivityScenario<ViewerActivity> scenario, String... states) {
        long end = SystemClock.uptimeMillis() + TIMEOUT_MS;
        List<String> seen = new ArrayList<>();
        while (SystemClock.uptimeMillis() < end) {
            scenario.onActivity(a -> {
                seen.clear();
                seen.addAll(a.reports());
            });
            for (int i = seen.size() - 1; i >= 0; i--) {
                for (String state : states) {
                    if (seen.get(i).contains("\"state\":\"" + state + "\"")) return seen.get(i);
                }
            }
            SystemClock.sleep(250);
        }
        return "timeout; reports=" + seen;
    }

    private static String jsString(String s) {
        return ViewerActivity.quote(s);
    }

    private static void screenshot(String name) {
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        File dir = ApplicationProvider.getApplicationContext().getExternalFilesDir("screens");
        if (bitmap == null || dir == null) return;
        try (OutputStream out = new FileOutputStream(new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_") + ".png"))) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 80, out);
        } catch (IOException ignored) {
            // 스크린샷은 참고용이다.
        }
    }
}
