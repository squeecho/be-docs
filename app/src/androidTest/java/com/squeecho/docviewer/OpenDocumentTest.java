package com.squeecho.docviewer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.StrictMode;
import android.os.SystemClock;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 실제 기기(에뮬레이터)의 WebView로 샘플 문서를 열어, 뷰어 화면이 "rendered"를 보고하는지 확인한다.
 * CI에서는 각 화면의 스크린샷을 남긴다.
 */
@RunWith(AndroidJUnit4.class)
public class OpenDocumentTest {
    private static final long TIMEOUT_MS = 90_000;

    @BeforeClass
    public static void allowFileUris() {
        // 테스트는 카톡 대신 file:// 주소로 파일을 넘긴다. 앱 동작은 content:// 와 같다.
        StrictMode.setVmPolicy(StrictMode.VmPolicy.LAX);
    }

    @Test
    public void appHasNoInternetPermission() {
        Context app = ApplicationProvider.getApplicationContext();
        assertEquals(PackageManager.PERMISSION_DENIED,
                app.getPackageManager().checkPermission(Manifest.permission.INTERNET, app.getPackageName()));
    }

    @Test
    public void launcherShowsHome() throws Exception {
        Intent intent = new Intent(Intent.ACTION_MAIN)
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "home");
            screenshot("home");
            assertTrue(report, report.contains("\"state\":\"home\""));
        }
    }

    @Test
    public void opensHwp() throws Exception {
        assertOpens("request.hwp", "request.hwp", "application/x-hwp", "hwp");
    }

    @Test
    public void opensHwpx() throws Exception {
        assertOpens("form01.hwpx", "form01.hwpx", "application/haansofthwpx", "hwp");
    }

    @Test
    public void opensXlsx() throws Exception {
        assertOpens("quote.xlsx", "quote.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet");
    }

    @Test
    public void opensXls() throws Exception {
        assertOpens("quote.xls", "quote.xls", "application/vnd.ms-excel", "sheet");
    }

    @Test
    public void opensEucKrCsv() throws Exception {
        assertOpens("staff-cp949.csv", "staff.csv", "text/csv", "sheet");
    }

    @Test
    public void opensPdf() throws Exception {
        assertOpens("sample.pdf", "sample.pdf", "application/pdf", "pdf");
    }

    @Test
    public void opensPptx() throws Exception {
        assertOpens("plan.pptx", "plan.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation", "slides");
    }

    @Test
    public void opensLegacyPpt() throws Exception {
        assertOpens("plan.ppt", "plan.ppt", "application/vnd.ms-powerpoint", "slides");
    }

    @Test
    public void detectsHwpWithoutExtensionOrType() throws Exception {
        // 형식 정보 없이 넘어온 HWP도 내용을 보고 연다.
        assertOpens("request.hwp", "download", "application/octet-stream", "hwp");
    }

    @Test
    public void opensSharedPdf() throws Exception {
        Uri uri = Uri.fromFile(copySample("sample.pdf", "shared.pdf"));
        Intent intent = new Intent(Intent.ACTION_SEND)
                .setType("application/pdf")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            assertTrue(report, report.contains("\"state\":\"rendered\"") && report.contains("\"kind\":\"pdf\""));
        }
    }

    @Test
    public void refusesAppPrivateFileUri() throws Exception {
        // 다른 앱이 file:// 주소로 이 앱 내부 파일을 열게 하는 것을 막는다.
        Context app = ApplicationProvider.getApplicationContext();
        File secret = new File(app.getCacheDir(), "secret.csv");
        try (OutputStream os = new FileOutputStream(secret)) {
            os.write("비밀,1\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.fromFile(secret), "text/csv")
                .setClass(app, ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            // 안내는 기기 언어를 따른다(한국어 "권한" / 영어 "permission")
            assertTrue(report, report.contains("\"state\":\"error\"") && (report.contains("권한") || report.contains("permission")));
        }
    }

    private void assertOpens(String sample, String fileName, String mime, String kind) throws Exception {
        Uri uri = Uri.fromFile(copySample(sample, fileName));
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, mime)
                .setClass(ApplicationProvider.getApplicationContext(), ViewerActivity.class);
        try (ActivityScenario<ViewerActivity> scenario = ActivityScenario.launch(intent)) {
            String report = await(scenario, "rendered", "error");
            SystemClock.sleep(1500);
            screenshot(fileName);
            assertTrue(report, report.contains("\"state\":\"rendered\""));
            assertTrue(report, report.contains("\"kind\":\"" + kind + "\""));
        }
    }

    private static String await(ActivityScenario<ViewerActivity> scenario, String... states) {
        long end = SystemClock.uptimeMillis() + TIMEOUT_MS;
        List<String> seen = new ArrayList<>();
        while (SystemClock.uptimeMillis() < end) {
            scenario.onActivity(a -> {
                seen.clear();
                seen.addAll(a.reports());
            });
            for (String report : seen) {
                for (String state : states) {
                    if (report.contains("\"state\":\"" + state + "\"")) return report;
                }
            }
            SystemClock.sleep(250);
        }
        return "timeout; reports=" + seen;
    }

    private static File copySample(String sample, String fileName) throws IOException {
        Context app = ApplicationProvider.getApplicationContext();
        Context test = InstrumentationRegistry.getInstrumentation().getContext();
        // 앱 내부 폴더(file://)는 보안상 열지 않으므로 앱 전용 외부 폴더에 둔다.
        File dir = app.getExternalFilesDir("test-samples");
        assertTrue(dir != null && (dir.isDirectory() || dir.mkdirs()));
        File out = new File(dir, fileName);
        try (InputStream in = test.getAssets().open("samples/" + sample);
             OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[16 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) os.write(buf, 0, n);
        }
        return out;
    }

    private static void screenshot(String name) {
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        File dir = ApplicationProvider.getApplicationContext().getExternalFilesDir("screens");
        if (bitmap == null || dir == null) return;
        try (OutputStream out = new FileOutputStream(new File(dir, name + ".png"))) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        } catch (IOException ignored) {
            // 스크린샷은 참고용이라 실패해도 테스트 결과에 영향을 주지 않는다.
        }
    }
}
