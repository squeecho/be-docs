package com.squeecho.docviewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 문서 하나를 보여주는 화면. 카톡의 "다른 앱으로 열기"·공유, 앱 아이콘 실행 모두 여기로 온다.
 *
 * 화면은 앱에 들어 있는 웹 뷰어(assets/viewer)가 그리고, 이 클래스는 가짜 주소
 * https://appassets.androidplatform.net/ 로 오는 요청을 가로채 뷰어 파일과 문서 바이트를 직접 내준다.
 * 앱에는 인터넷 권한이 없으므로 문서가 밖으로 나갈 길이 없다.
 */
public class ViewerActivity extends Activity {
    static final String TAG = "DocViewer";
    static final String HOST = "appassets.androidplatform.net";
    private static final String BASE = "https://" + HOST;
    private static final int REQ_PICK = 1;
    private static final long STALE_CACHE_MILLIS = 6L * 60 * 60 * 1000;
    private static final String STATE_FILE = "doc.file";
    private static final String STATE_NAME = "doc.name";
    private static final String STATE_BACK_HOME = "doc.backHome";
    private static final String STATE_RECENT = "doc.recent";

    private static final String[] PICK_TYPES = {
            "application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp",
            "application/haansofthwpx", "application/vnd.hancom.hwpx", "application/hwp+zip",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/csv", "text/comma-separated-values", "text/tab-separated-values", "text/plain", "application/pdf",
            "application/illustrator", "application/vnd.adobe.illustrator", "application/postscript",
            "image/vnd.dwg", "image/x-dwg", "application/acad", "application/x-acad", "application/dwg", "application/x-dwg",
            "image/vnd.dxf", "image/x-dxf", "application/dxf", "application/x-dxf",
            "application/rtf", "text/rtf", "application/vnd.oasis.opendocument.text",
            "application/vnd.oasis.opendocument.presentation", "application/vnd.oasis.opendocument.spreadsheet",
            "application/octet-stream",
    };

    // 살아 있는 이 앱의 화면들(화면 스레드에서만 고친다). 카톡·내 파일이 새 작업 플래그로 문서를 넘기면 안드로이드는
    // 이 앱의 기존 작업(설치 직후 "열기"로 띄운 시작 화면, 전에 본 문서) 위에 새 화면을 올린다. 그대로 두면 뒤로 가기가
    // 문서를 닫은 뒤 아래 화면을 보여 줘 두 번 눌러야 나간다. 다른 앱에서 문서를 받으면 같은 작업의 이전 화면을 닫는다.
    private static final List<WeakReference<ViewerActivity>> LIVE = new ArrayList<>();

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private FrameLayout root;
    private WebView webView;
    private volatile Future<DocSession> session;
    private volatile Uri sourceUri;
    private volatile String sourceType;
    // 시작 화면 "최근 문서"(RecentDocs): 목록에서 다시 연 문서의 id, 파일 고르기로 연 문서인지, 이번에 연 문서를 기록했는지.
    // 화면에 그려지면(rendered·password) 한 번 기록한다. openGen: 여는 중에 다른 문서로 바뀌었는지 가린다.
    private volatile String recentId;
    private volatile boolean picked;
    private final AtomicBoolean recorded = new AtomicBoolean();
    private volatile int openGen;
    private final List<String> reports = new CopyOnWriteArrayList<>();
    // 쪽을 그림으로 내보내는 중인 일(화면 스크립트의 앱 호출 스레드에서 쓴다)
    private final Object exportLock = new Object();
    private ImageExport export;
    // 다운로드 폴더에 저장하는 중(연달아 눌러도 한 번만)
    private final AtomicBoolean downloading = new AtomicBoolean();

    // 웹 화면 프로세스가 죽은 횟수(문서마다 새로 센다)와, 다시 띄울지·오류로 보여줄지 판단할 상태
    private boolean started;
    private boolean reloadOnStart;
    private int rendererLosses;
    private static final int CONSOLE_LIMIT = 200;
    private int consoleLines;
    private volatile boolean rendererFailed;

    // 여는 중에 화면 스크립트가 멈추면(긴 워드 쪽 나누기 등) 웹 화면의 버튼도 눌리지 않는다. 웹 화면은 여는 동안
    // 1초마다 신호(loadingAlive)를 보내고, 신호가 끊긴 채 시간이 지나면 앱이 직접 "다른 앱으로 열기"를 띄운다.
    private static final long ESCAPE_AFTER_MILLIS = 5000;
    private static final long ESCAPE_SILENCE_MILLIS = 2500;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile long loadingSince;
    private volatile long lastAlive;
    private volatile boolean escapeShown;
    private Button escapeButton;
    private final Runnable escapeWatch = new Runnable() {
        @Override
        public void run() {
            if (loadingSince == 0) {
                hideEscape();
                return;
            }
            long now = SystemClock.uptimeMillis();
            if (now - loadingSince >= ESCAPE_AFTER_MILLIS && now - lastAlive > ESCAPE_SILENCE_MILLIS
                    && canHandOff()) {
                showEscape();
            }
            ui.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LIVE.add(new WeakReference<>(this));
        root = new FrameLayout(this);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            applyInsets(v, insets);
            return insets;
        });
        createWebView();
        setContentView(root);

        DocSession restored = savedInstanceState == null ? null : DocSession.restore(getApplicationContext(),
                savedInstanceState.getString(STATE_FILE), savedInstanceState.getString(STATE_NAME));
        io.execute(() -> {
            DocSession.sweep(this, STALE_CACHE_MILLIS);
            ImageExport.clearDir(ExportProvider.dir(this), STALE_CACHE_MILLIS);
        });
        if (restored != null) {
            Intent intent = getIntent();
            sourceUri = Intent.ACTION_SEND.equals(intent.getAction()) ? streamExtra(intent) : intent.getData();
            sourceType = intent.getType();
            session = CompletableFuture.completedFuture(restored);
            backToHome = savedInstanceState.getBoolean(STATE_BACK_HOME);
            recentId = savedInstanceState.getString(STATE_RECENT);
            if (recentId != null) restoreRecentHandoff(restored);
            showViewer();
        } else {
            openFromIntent(getIntent());
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        Future<DocSession> f = session;
        if (f == null || !f.isDone()) return;
        try {
            DocSession s = f.get();
            out.putString(STATE_FILE, s.file.getAbsolutePath());
            out.putString(STATE_NAME, s.name);
            out.putBoolean(STATE_BACK_HOME, backToHome);
            if (recentId != null) out.putString(STATE_RECENT, recentId);
        } catch (ExecutionException | InterruptedException ignored) {
            // 열지 못한 문서는 저장할 것이 없다.
        }
    }

    /** 안드로이드 15부터 화면이 상태바·내비게이션바 아래까지 깔리므로 그만큼 비켜 준다. */
    @SuppressWarnings("deprecation")
    private static void applyInsets(android.view.View v, WindowInsets insets) {
        int left;
        int top;
        int right;
        int bottom;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            left = bars.left;
            top = bars.top;
            right = bars.right;
            bottom = bars.bottom;
        } else {
            left = insets.getSystemWindowInsetLeft();
            top = insets.getSystemWindowInsetTop();
            right = insets.getSystemWindowInsetRight();
            bottom = insets.getSystemWindowInsetBottom();
        }
        v.setPadding(left, top, right, bottom);
    }

    private void createWebView() {
        webView = new WebView(this);
        configureWebView(webView);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    /** 웹 화면을 (없으면 새로 만들어) 뷰어로 다시 연다. 받아 둔 문서(session)는 그대로 쓴다. */
    private void showViewer() {
        stopEscapeWatch();
        updateBackTarget(false);
        if (webView == null) createWebView();
        webView.setVerticalScrollBarEnabled(true);
        webView.setHorizontalScrollBarEnabled(true);
        consoleLines = 0;
        webView.loadUrl(BASE + "/viewer/index.html");
    }

    private void configureWebView(WebView view) {
        view.setBackgroundColor(getColor(R.color.viewer_bg));
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setDomStorageEnabled(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSafeBrowsingEnabled(false);
        // 웹뷰는 기본으로 시스템 글자 크기를 문서 글자에도 적용해 표·쪽 배치가 어긋난다. 문서는 원래 크기로 그리고,
        // 앱 버튼·안내 글자만 뷰어 화면(viewer.js)에서 시스템 글자 크기만큼 키운다. 문서는 두 손가락으로 확대한다.
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) s.setAlgorithmicDarkeningAllowed(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        view.addJavascriptInterface(new Bridge(), "DocViewer");
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                // 엔진이 문단·칸마다 경고를 내는 파일이 있어 기기 기록에는 문서마다 앞의 200줄, 줄마다 300자까지만 남긴다
                // (문서 글자가 기록에 길게 남지 않게도 한다).
                consoleLines++;
                if (consoleLines <= CONSOLE_LIMIT) {
                    String text = m.message();
                    if (text.length() > 300) text = text.substring(0, 300) + "…";
                    Log.i(TAG, "console: " + text + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                } else if (consoleLines == CONSOLE_LIMIT + 1) {
                    Log.i(TAG, "console: 이후 메시지는 생략");
                }
                return true;
            }
        });
        view.setWebViewClient(new Client());
    }

    // ------------------------------------------------------------ 문서 열기

    private void openFromIntent(Intent intent) {
        Uri uri = null;
        String type = intent != null ? intent.getType() : null;
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = streamExtra(intent);
        }
        if (uri != null) closeOlderScreensInTask();
        open(uri, type, false);
    }

    /** 같은 작업 안에서 이 화면 아래에 남은 이 앱의 화면(시작 화면·전에 본 문서)을 닫는다. 다른 앱의 작업은 건드리지 않는다. */
    private void closeOlderScreensInTask() {
        int task = getTaskId();
        for (WeakReference<ViewerActivity> ref : new ArrayList<>(LIVE)) {
            ViewerActivity other = ref.get();
            if (other != null && other != this && !other.isFinishing() && other.getTaskId() == task) {
                Log.i(TAG, "closing older screen under a document from another app");
                other.finish();
            }
        }
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    /** fromHome: 시작 화면의 "파일 열기"로 고른 문서. 뒤로 가기는 앱을 나가지 않고 시작 화면으로 돌아간다. */
    private void open(Uri uri, String type, boolean fromHome) {
        open(uri, type, fromHome, fromHome, null);
    }

    /** pickedFile: 파일 고르기(ACTION_OPEN_DOCUMENT)로 받은 주소. recent: 최근 문서 목록에서 다시 연 줄의 id. */
    private void open(Uri uri, String type, boolean fromHome, boolean pickedFile, String recent) {
        beginOpen(uri, type, fromHome && uri != null, pickedFile, recent);
        session = uri == null ? null : io.submit(() -> DocSession.open(getApplicationContext(), uri));
        showViewer();
    }

    private void beginOpen(Uri uri, String type, boolean home, boolean pickedFile, String recent) {
        closeSession();
        openGen++;
        backToHome = home;
        sourceUri = uri;
        sourceType = type;
        picked = pickedFile;
        recentId = recent;
        recorded.set(false);
        reports.clear();
        rendererLosses = 0;
        rendererFailed = false;
        reloadOnStart = false;
    }

    /** 시작 화면 "최근 문서"의 한 줄을 연다. 고른 파일은 원본을, 다른 앱에서 받은 문서는 앱 안의 사본을. */
    private void openRecent(String id) {
        RecentDocs.Entry e = RecentDocs.get(this, id);
        if (e == null) {
            open(null, null, false);
            return;
        }
        if (RecentDocs.KIND_PICK.equals(e.kind)) {
            open(Uri.parse(e.uri), e.mime, true, false, e.id);
            return;
        }
        beginOpen(null, e.mime, true, false, e.id);
        Context app = getApplicationContext();
        int gen = openGen;
        session = io.submit(() -> {
            DocSession s = DocSession.fromRecent(app, RecentDocs.copyFile(app, e.id), e.name);
            if (gen == openGen) sourceUri = handoffUriFor(app, s);
            return s;
        });
        showViewer();
    }

    /** 다른 앱으로 열기·공유하기에 넘길 주소(앱 안 사본을 원래 이름으로 내보내는 주소). 못 만들면 null(그 버튼만 숨는다). */
    private static Uri handoffUriFor(Context app, DocSession s) {
        try {
            return ExportProvider.shareUri(ExportProvider.authority(app), ShareCopy.make(app, s.file, s.name));
        } catch (IOException | RuntimeException ex) {
            Log.w(TAG, "최근 문서를 넘길 주소를 만들지 못함", ex);
            return null;
        }
    }

    /** 시스템이 앱을 정리했다 다시 만든 경우: 최근 문서에서 연 문서면 넘길 주소를 다시 마련한다. */
    private void restoreRecentHandoff(DocSession restored) {
        RecentDocs.Entry e = RecentDocs.get(this, recentId);
        if (e == null) return;
        sourceType = e.mime;
        if (RecentDocs.KIND_PICK.equals(e.kind)) {
            sourceUri = Uri.parse(e.uri);
            return;
        }
        Context app = getApplicationContext();
        int gen = openGen;
        io.execute(() -> {
            Uri u = handoffUriFor(app, restored);
            if (gen == openGen) sourceUri = u;
        });
    }

    /** 문서가 화면에 그려지면(또는 비밀번호를 묻게 되면) 최근 문서에 한 번 기록한다. */
    private void recordRecent() {
        DocSession s = openedSession();
        if (s == null || !recorded.compareAndSet(false, true)) return;
        Context app = getApplicationContext();
        String id = recentId;
        if (id != null) {
            RecentDocs.touch(app, id);
            return;
        }
        Uri uri = sourceUri;
        if (uri == null) return;
        String mime = typeForHandoff(uri);
        try {
            if (picked && RecentDocs.isContent(uri)) RecentDocs.recordPicked(app, uri, s.name, mime, s.file);
            else RecentDocs.recordCopy(app, s.file, s.name, mime);
        } catch (RuntimeException e) {
            Log.w(TAG, "최근 문서에 기록하지 못함", e);
        }
    }

    private void releaseSession() {
        Future<DocSession> old = session;
        if (old == null) return;
        io.execute(() -> {
            try {
                old.get().release();
            } catch (ExecutionException | InterruptedException ignored) {
                // 열리지 못한 문서는 정리할 것도 없다.
            }
        });
    }

    private void closeSession() {
        Future<DocSession> old = session;
        session = null;
        if (old == null) return;
        io.execute(() -> {
            try {
                old.get().close();
            } catch (ExecutionException | InterruptedException ignored) {
                // 열리지 못한 문서는 닫을 것도 없다.
            }
        });
    }

    private void pickFile() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, PICK_TYPES);
        try {
            startActivityForResult(pick, REQ_PICK);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.picker_unavailable, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK && resultCode == RESULT_OK && data != null && data.getData() != null) {
            open(data.getData(), data.getType(), true);
        }
    }

    private boolean canHandOff() {
        Uri uri = sourceUri;
        return uri != null && ContentResolver.SCHEME_CONTENT.equals(uri.getScheme());
    }

    private void onLoadingAlive() {
        lastAlive = SystemClock.uptimeMillis();
        if (loadingSince != 0) return;
        loadingSince = lastAlive;
        ui.post(() -> {
            ui.removeCallbacks(escapeWatch);
            ui.postDelayed(escapeWatch, 500);
        });
    }

    private void stopEscapeWatch() {
        loadingSince = 0;
        ui.post(() -> {
            ui.removeCallbacks(escapeWatch);
            hideEscape();
        });
    }

    private void showEscape() {
        if (escapeShown) return;
        if (escapeButton == null) {
            Button b = new Button(this);
            b.setText(R.string.open_elsewhere);
            b.setAllCaps(false);
            b.setTextColor(Color.WHITE);
            b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xFF0B5C8F); // viewer.css의 --accent(밝은 화면)
            bg.setCornerRadius(dp(24));
            b.setBackground(bg);
            b.setPadding(dp(24), dp(12), dp(24), dp(12));
            b.setElevation(dp(6));
            b.setContentDescription(getString(R.string.open_elsewhere_slow));
            b.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            b.setOnClickListener(v -> openElsewhere());
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
            lp.bottomMargin = dp(32);
            root.addView(b, lp);
            escapeButton = b;
        }
        escapeButton.setVisibility(View.VISIBLE);
        escapeButton.bringToFront();
        escapeShown = true;
    }

    private void hideEscape() {
        escapeShown = false;
        if (escapeButton != null) escapeButton.setVisibility(View.GONE);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private long lastHandoff;

    // 뒤로 가기를 앱이 가로채는 경우는 둘이다: 화면에 찾기 막대·팝업이 열려 있으면 그것부터 닫고(backTarget),
    // 시작 화면에서 고른 문서를 보는 중이면 시작 화면으로 돌아간다(backToHome). 그 밖에는 시스템에 맡겨
    // 다른 앱에서 연 문서는 한 번에 닫히고 그 앱으로 돌아간다.
    private volatile boolean backTarget;
    private boolean backToHome;
    private Object backCallback;

    private void updateBackTarget(boolean open) {
        backTarget = open;
        syncBackCallback();
    }

    private boolean handlesBack() {
        return (backTarget && webView != null) || backToHome;
    }

    private void handleBack() {
        if (backTarget) closeOverlay();
        else if (backToHome) open(null, null, false);
    }

    private void syncBackCallback() {
        if (Build.VERSION.SDK_INT < 33) return;
        boolean want = backTarget || backToHome;
        if (want && backCallback == null) {
            OnBackInvokedCallback cb = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
            backCallback = cb;
        } else if (!want && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((OnBackInvokedCallback) backCallback);
            backCallback = null;
        }
    }

    // 계측 테스트 진단용(화면 스레드에서만 바꾸고 읽는다): 액티비티까지 온 뒤로 가기 키(뗄 때) 수와 화면에 닫기를 요청한 수
    private int backKeysSeen;
    private int overlayCloses;

    private void closeOverlay() {
        overlayCloses++;
        if (webView != null) webView.evaluateJavascript("window.beDocsBack&&window.beDocsBack()", null);
        else updateBackTarget(false);
    }

    // 뒤로 가기 키는 초점을 가진 웹 화면으로 먼저 가서, 기기에 따라(안드로이드 14 에뮬레이터) onBackPressed까지 오지 않았다.
    // 찾기 막대·팝업이 열려 있을 때는 화면 요소로 보내기 전에 여기서 가로챈다(누를 때·뗄 때 둘 다 소비).
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) backKeysSeen++;
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && handlesBack()) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) handleBack();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    /** 웹 화면을 인쇄한다(PDF가 아닌 문서의 인쇄·PDF로 저장). 화면이 미리 인쇄 모양으로 바꿔 둔다. */
    private void startPrint(String job, double widthMm, double heightMm) {
        WebView view = webView;
        if (view == null) {
            printDone();
            return;
        }
        startPrint(job, view.createPrintDocumentAdapter(job), widthMm, heightMm);
    }

    private void startPrint(String job, PrintDocumentAdapter inner, double widthMm, double heightMm) {
        PrintManager printer = (PrintManager) getSystemService(Context.PRINT_SERVICE);
        if (printer == null) {
            printDone();
            return;
        }
        // 넘긴 인쇄(웹뷰·원본 PDF)를 그대로 쓰되, 인쇄 창이 닫히면(인쇄·저장·취소 모두) 화면을 원래대로 돌리게 알린다.
        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
            @Override
            public void onStart() {
                inner.onStart();
            }

            @Override
            public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancel,
                                 LayoutResultCallback callback, Bundle extras) {
                inner.onLayout(oldAttributes, newAttributes, cancel, callback, extras);
            }

            @Override
            public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancel,
                                WriteResultCallback callback) {
                inner.onWrite(pages, destination, cancel, callback);
            }

            @Override
            public void onFinish() {
                inner.onFinish();
                printDone();
            }
        };
        PrintAttributes attrs = new PrintAttributes.Builder()
                .setMediaSize(mediaFor(widthMm, heightMm))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                .build();
        PrintSinkForTest sink = printSinkForTest;
        if (sink != null) {
            sink.print(job, adapter, attrs);
            return;
        }
        try {
            printer.print(job, adapter, attrs);
        } catch (RuntimeException e) {
            Log.w(TAG, "인쇄 창을 열지 못함", e);
            Toast.makeText(this, R.string.pdf_save_failed, Toast.LENGTH_SHORT).show();
            printDone();
        }
    }

    private void printDone() {
        if (webView != null) webView.evaluateJavascript("window.beDocsPrintDone&&window.beDocsPrintDone()", null);
    }

    /**
     * 안드로이드 "PDF로 저장"이 받는 정해 둔 종이 중 화면(viewer.js paperFor)이 고르는 것. 목록에 없는 크기는 인쇄 창이
     * 기본 종이로 바꾸므로(AOSP PrintActivity) 화면도 이 중에서만 고른다.
     */
    private static final PrintAttributes.MediaSize[] PAPERS = {
            PrintAttributes.MediaSize.ISO_A4, PrintAttributes.MediaSize.ISO_A3, PrintAttributes.MediaSize.ISO_A5,
            PrintAttributes.MediaSize.ISO_B4, PrintAttributes.MediaSize.ISO_B5,
            PrintAttributes.MediaSize.JIS_B4, PrintAttributes.MediaSize.JIS_B5,
            PrintAttributes.MediaSize.NA_LETTER, PrintAttributes.MediaSize.NA_LEGAL, PrintAttributes.MediaSize.NA_TABLOID,
    };

    /** 종이 크기(mm)에 맞는 안드로이드 종이(세로·가로). 목록에 없으면(±3mm) 그 크기 그대로. */
    static PrintAttributes.MediaSize mediaFor(double widthMm, double heightMm) {
        double w = widthMm > 0 ? widthMm : 210;
        double h = heightMm > 0 ? heightMm : 297;
        boolean landscape = w > h;
        int milsShort = (int) Math.round(Math.min(w, h) / 25.4 * 1000);
        int milsLong = (int) Math.round(Math.max(w, h) / 25.4 * 1000);
        int near = (int) Math.round(3 / 25.4 * 1000);
        for (PrintAttributes.MediaSize paper : PAPERS) {
            PrintAttributes.MediaSize p = paper.asPortrait();
            if (Math.abs(p.getWidthMils() - milsShort) < near && Math.abs(p.getHeightMils() - milsLong) < near) {
                return landscape ? p.asLandscape() : p;
            }
        }
        int milsW = (int) Math.round(w / 25.4 * 1000);
        int milsH = (int) Math.round(h / 25.4 * 1000);
        return new PrintAttributes.MediaSize("be_docs_" + milsW + "x" + milsH, "be docs " + Math.round(w) + "×" + Math.round(h) + "mm", milsW, milsH);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (handlesBack()) {
            handleBack();
            return;
        }
        super.onBackPressed();
    }

    /** 이 앱으로 잘 안 보이는 문서를 한컴 뷰어 등 다른 앱으로 넘긴다. */
    private void openElsewhere() {
        Uri uri = sourceUri;
        if (uri == null) return;
        // 앱 버튼과 화면 버튼을 연달아 누르거나 여러 번 눌러도 앱 고르기 창은 한 번만 띄운다.
        long now = SystemClock.uptimeMillis();
        if (lastHandoff != 0 && now - lastHandoff < 1500) return;
        lastHandoff = now;
        Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, typeForHandoff(uri))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(view, getString(R.string.open_elsewhere))
                .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS,
                        new ComponentName[]{new ComponentName(this, ViewerActivity.class)});
        try {
            startActivity(chooser);
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.no_app_to_open, Toast.LENGTH_SHORT).show();
        }
    }

    // 파일 공유하기: 받은 파일(카카오톡 등이 준 content:// 주소)을 그대로 다른 앱으로 보낸다. 읽기 권한도 함께 넘긴다.
    private void shareFile() {
        Uri uri = sourceUri;
        if (uri == null || tooSoon()) return;
        sendStream(uri, typeForHandoff(uri));
    }

    // 파일 공유하기(이름을 바꿔서): 받아 둔 사본을 새 이름으로 만들어(같은 저장소라 하드 링크로 바로) 그 주소를 보낸다.
    // 확장자는 원래 것으로 고정한다. 이름이 그대로면 받은 파일을 그대로 보낸다.
    private void shareFileAs(String wanted) {
        DocSession s = openedSession();
        if (s == null || sourceUri == null) {
            shareFile();
            return;
        }
        String name = ShareCopy.nameFor(wanted, s.name);
        if (name.equals(s.name)) {
            shareFile();
            return;
        }
        if (tooSoon()) return;
        Context app = getApplicationContext();
        String type = typeForHandoff(sourceUri);
        Handler main = new Handler(Looper.getMainLooper());
        try {
            io.execute(() -> {
                try {
                    Uri uri = ExportProvider.shareUri(ExportProvider.authority(app), ShareCopy.make(app, s.file, name));
                    main.post(() -> {
                        if (!isFinishing() && !isDestroyed()) sendStream(uri, type);
                    });
                } catch (IOException | RuntimeException e) {
                    Log.w(TAG, "이름을 바꿔 공유할 파일을 만들지 못함", e);
                    main.post(() -> Toast.makeText(app, R.string.share_copy_failed, Toast.LENGTH_LONG).show());
                }
            });
        } catch (RejectedExecutionException e) {
            // 화면을 닫는 중이다.
        }
    }

    /** 앱 버튼과 화면 버튼을 연달아 누르거나 여러 번 눌러도 앱 고르기 창은 한 번만 띄운다. */
    private boolean tooSoon() {
        long now = SystemClock.uptimeMillis();
        if (lastHandoff != 0 && now - lastHandoff < 1500) return true;
        lastHandoff = now;
        return false;
    }

    private void sendStream(Uri uri, String type) {
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType(type)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri("", uri));
        Intent chooser = Intent.createChooser(send, getString(R.string.share_file))
                .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS,
                        new ComponentName[]{new ComponentName(this, ViewerActivity.class)});
        try {
            startActivity(chooser);
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.no_app_to_share, Toast.LENGTH_SHORT).show();
        }
    }

    /** 다 받아 둔 문서. 아직 여는 중이거나 열지 못했으면 null. */
    private DocSession openedSession() {
        Future<DocSession> f = session;
        if (f == null || !f.isDone()) return null;
        try {
            return f.get();
        } catch (ExecutionException | InterruptedException | CancellationException e) {
            return null;
        }
    }

    // 다운로드: 받아 둔 원본을 휴대폰의 다운로드 폴더에 저장한다(카톡 등에서 바로 연 임시 파일을 남겨 둘 때).
    // 큰 파일도 있으니 화면 스레드 밖에서 복사하고, 끝나면 저장한 이름을 알린다.
    private void downloadFile() {
        DocSession s = openedSession();
        if (s == null) return;
        Context app = getApplicationContext();
        if (!downloading.compareAndSet(false, true)) {
            Toast.makeText(app, R.string.download_busy, Toast.LENGTH_SHORT).show();
            return;
        }
        Handler main = new Handler(Looper.getMainLooper());
        try {
            io.execute(() -> {
                String msg;
                try {
                    msg = app.getString(R.string.download_done, DownloadSave.save(app, s.file, s.name));
                } catch (IOException | RuntimeException e) {
                    Log.w(TAG, "다운로드 폴더에 저장 실패", e);
                    msg = app.getString(R.string.download_failed);
                } finally {
                    downloading.set(false);
                }
                String text = msg;
                main.post(() -> Toast.makeText(app, text, Toast.LENGTH_LONG).show());
            });
        } catch (RejectedExecutionException e) {
            downloading.set(false);
        }
    }

    // 이미지로 변환한 그림 공유하기: 한 장이면 ACTION_SEND, 여러 장이면 ACTION_SEND_MULTIPLE. 받는 앱에는 그 그림들의 읽기 권한만 넘긴다.
    private void shareImages(List<Uri> uris, String type) {
        if (uris.isEmpty()) return;
        Intent send;
        if (uris.size() == 1) {
            send = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris.get(0));
        } else {
            send = new Intent(Intent.ACTION_SEND_MULTIPLE)
                    .putParcelableArrayListExtra(Intent.EXTRA_STREAM, new ArrayList<>(uris));
        }
        send.setType(type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ClipData clip = ClipData.newRawUri("", uris.get(0));
        for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        send.setClipData(clip);
        try {
            startActivity(Intent.createChooser(send, getString(R.string.share_images)));
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.no_app_to_share_images, Toast.LENGTH_SHORT).show();
        }
    }

    private String typeForHandoff(Uri uri) {
        String type = sourceType;
        if (type != null && !type.isEmpty() && !"application/octet-stream".equals(type)) return type;
        Future<DocSession> f = session;
        String name = null;
        if (f != null && f.isDone()) {
            try {
                name = f.get().name;
            } catch (ExecutionException | InterruptedException ignored) {
                // 이름을 모르면 아래 기본값을 쓴다.
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        String ext = name != null && name.lastIndexOf('.') >= 0
                ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (guessed != null) return guessed;
        if ("hwp".equals(ext)) return "application/x-hwp";
        if ("hwpx".equals(ext)) return "application/haansofthwpx";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------ 생명주기

    @Override
    protected void onStart() {
        super.onStart();
        started = true;
        // 뒤에 있는 동안 웹 화면의 신호가 늦어진 것은 멈춘 것이 아니므로 다시 기다려 준다.
        if (loadingSince != 0) lastAlive = SystemClock.uptimeMillis();
        if (reloadOnStart) {
            reloadOnStart = false;
            showViewer();
        }
    }

    @Override
    protected void onStop() {
        started = false;
        super.onStop();
    }

    /**
     * 웹 화면 프로세스가 사라졌을 때. 앱이 뒤에 있는 동안 시스템이 메모리를 위해 정리한 경우(카톡 답장 후 돌아오기 등)는
     * 돌아왔을 때 조용히 다시 연다. 화면에 보이는 중에 죽었거나 되풀이되면 문서가 너무 크거나 복잡한 것으로 보고
     * 앱을 닫지 않고 안내(다른 앱으로 열기)를 보여준다.
     */
    private void onRendererGone(WebView view, boolean crashed) {
        Log.w(TAG, "render process gone, crashed=" + crashed + ", started=" + started + ", losses=" + rendererLosses);
        if (webView == view) {
            root.removeView(view);
            webView = null;
        }
        view.destroy();
        stopEscapeWatch();
        rendererLosses++;
        if (!crashed && !started && rendererLosses <= 3) {
            reloadOnStart = true;
            return;
        }
        if (!crashed && rendererLosses <= 1) {
            showViewer();
            return;
        }
        rendererFailed = true;
        if (started) showViewer();
        else reloadOnStart = true;
    }

    @Override
    protected void onDestroy() {
        synchronized (exportLock) {
            if (export != null) export.cancel();
            export = null;
        }
        for (int i = LIVE.size() - 1; i >= 0; i--) {
            ViewerActivity a = LIVE.get(i).get();
            if (a == null || a == this) LIVE.remove(i);
        }
        // 설정 변경(글자 크기·다크 모드 등)으로 다시 만들어질 때는 사본을 남겨 새 화면이 이어서 쓴다.
        if (isChangingConfigurations()) releaseSession();
        else closeSession();
        io.shutdown();
        loadingSince = 0;
        ui.removeCallbacksAndMessages(null);
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 계측 테스트에서 웹 화면 프로세스 강제 종료(chrome://kill)·충돌(chrome://crash)을 흉내 낸다. */
    void loadUrlForTest(String url) {
        runOnUiThread(() -> {
            if (webView != null) webView.loadUrl(url);
        });
    }

    /** 계측 테스트: 기기 언어(시험 기기는 보통 영어)와 상관없이 화면 글자 언어를 정한다. null이면 기기 언어. */
    static volatile String languageForTest;

    /** 계측 테스트에서 앱이 띄운 "다른 앱으로 열기"(화면 스크립트가 멈췄을 때) 버튼이 보이는지 확인한다. */
    boolean isEscapeShownForTest() {
        return escapeShown;
    }

    /** 계측 테스트에서 시작 화면의 "파일 열기"로 문서를 고른 것처럼 연다(시스템 파일 선택 화면은 자동으로 누를 수 없다). */
    void openPickedForTest(Uri uri, String type) {
        runOnUiThread(() -> open(uri, type, true));
    }

    /** 계측 테스트에서 화면이 "뒤로 가기로 닫을 것(찾기 막대·팝업)이 열려 있다"고 알렸는지 확인한다. */
    boolean isBackTargetForTest() {
        return backTarget;
    }

    /** 계측 테스트 진단: "액티비티까지 온 뒤로 가기 키 수/닫기 요청 수/창 초점". */
    String backDiagnosticsForTest() {
        return backKeysSeen + "/" + overlayCloses + "/" + (hasWindowFocus() ? "focus" : "nofocus");
    }

    private static String jobName(String name) {
        return DownloadSave.safeName(name == null || name.trim().isEmpty() ? "be docs" : name.trim());
    }

    /** 계측 테스트: 인쇄 창 대신 인쇄할 것(웹뷰 인쇄·원본 PDF)을 받는다. 시험이 파일로 써서 쪽 수·종이를 본다. */
    interface PrintSinkForTest {
        void print(String job, PrintDocumentAdapter adapter, PrintAttributes attributes);
    }

    static volatile PrintSinkForTest printSinkForTest;

    /** 계측 테스트에서 뷰어 화면이 보고한 상태 기록을 읽는다. */
    List<String> reports() {
        return reports;
    }

    /** 계측 테스트에서 뷰어 화면에 스크립트를 실행하고 결과(JSON)를 받는다. */
    String evaluateJavascriptForTest(String script, long timeoutMillis) throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        String[] result = {null};
        runOnUiThread(() -> {
            if (webView == null) {
                done.countDown();
                return;
            }
            webView.evaluateJavascript(script, value -> {
                result[0] = value;
                done.countDown();
            });
        });
        done.await(timeoutMillis, TimeUnit.MILLISECONDS);
        return result[0];
    }

    // ------------------------------------------------------------ 웹 뷰어 ↔ 앱

    private final class Bridge {
        @JavascriptInterface
        public void report(String json) {
            if (reports.size() < 100) reports.add(json);
            Log.i(TAG, "report: " + json);
            // 문서가 보이거나 안내(오류·암호·시작 화면)로 바뀌면 여는 중 감시를 끝낸다.
            if (json != null && (json.contains("\"state\":\"rendered\"") || json.contains("\"state\":\"error\"")
                    || json.contains("\"state\":\"password\"") || json.contains("\"state\":\"home\""))) {
                stopEscapeWatch();
            }
            if (json != null && (json.contains("\"state\":\"rendered\"") || json.contains("\"state\":\"password\""))) {
                recordRecent();
            }
        }

        /** 시작 화면의 최근 문서 목록(JSON, 최근 연 순서). */
        @JavascriptInterface
        public String recentList() {
            return RecentDocs.listJson(getApplicationContext());
        }

        @JavascriptInterface
        public void openRecent(String id) {
            if (RecentDocs.validId(id)) runOnUiThread(() -> ViewerActivity.this.openRecent(id));
        }

        @JavascriptInterface
        public void removeRecent(String id) {
            if (RecentDocs.validId(id)) RecentDocs.remove(getApplicationContext(), id);
        }

        @JavascriptInterface
        public void clearRecent() {
            RecentDocs.clear(getApplicationContext());
        }

        @JavascriptInterface
        public void setBackTarget(boolean open) {
            runOnUiThread(() -> updateBackTarget(open));
        }

        @JavascriptInterface
        public void loadingAlive() {
            onLoadingAlive();
        }

        @JavascriptInterface
        public void loadingDone() {
            stopEscapeWatch();
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (PackageManager.NameNotFoundException e) {
                return "";
            }
        }

        @JavascriptInterface
        public void openWebViewUpdate() {
            runOnUiThread(() -> {
                String pkg = "com.google.android.webview";
                try {
                    android.content.pm.PackageInfo info = WebView.getCurrentWebViewPackage();
                    if (info != null) pkg = info.packageName;
                } catch (RuntimeException ignored) {
                    // 기본 웹뷰 패키지로 연다.
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(ViewerActivity.this, R.string.play_store_unavailable, Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** 화면 글자의 언어(i18n.js): 앱이 쓰는 언어 태그(ko, en-US 등). 한국어가 아니면 화면은 영어. */
        @JavascriptInterface
        public String language() {
            String forced = languageForTest;
            return forced != null ? forced : getResources().getConfiguration().getLocales().get(0).toLanguageTag();
        }

        @JavascriptInterface
        public float fontScale() {
            return getResources().getConfiguration().fontScale;
        }

        /**
         * 이 화면을 창 하나가 다 쓸 때의 문서 화면 폭(dp = CSS px). 분할 화면에서도 전체 화면 때만큼 확대할 수 있게
         * (viewer.js pageZoomMax). 폴드는 펼쳤으면 안쪽 화면, 접었으면 바깥 화면 기준. 모르면 0(창 폭 기준 그대로).
         */
        @JavascriptInterface
        public float fullWindowWidth() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return 0;
            try {
                WindowManager wm = getWindowManager();
                int max = wm.getMaximumWindowMetrics().getBounds().width();
                int now = wm.getCurrentWindowMetrics().getBounds().width();
                WebView view = webView;
                int width = view != null ? view.getWidth() : 0;
                if (max <= 0 || now <= 0 || width <= 0) return 0;
                // 창에서 문서 화면을 뺀 부분(옆 시스템 바 등)은 전체 화면일 때도 같다고 본다.
                return Math.max(0, max - (now - width)) / getResources().getDisplayMetrics().density;
            } catch (RuntimeException e) {
                return 0;
            }
        }

        @JavascriptInterface
        public void pickFile() {
            runOnUiThread(ViewerActivity.this::pickFile);
        }

        @JavascriptInterface
        public boolean canOpenElsewhere() {
            return canHandOff();
        }

        @JavascriptInterface
        public void openElsewhere() {
            runOnUiThread(ViewerActivity.this::openElsewhere);
        }

        /** 엑셀을 가로·세로로 돌린 뒤 웹뷰가 바꾼 배율을 돌리기 전 배율로 되돌린다(화면이 비율을 계산해 부른다). */
        @JavascriptInterface
        public void zoomBy(float factor) {
            if (!(factor > 0.01f && factor < 100f)) return;
            runOnUiThread(() -> {
                if (webView != null) webView.zoomBy(factor);
            });
        }

        /** 쪽 문서(PDF·한글)는 화면이 오른쪽 쪽 이동 손잡이를 그리므로 웹뷰 기본 스크롤 막대를 끈다(두 개로 보이지 않게). */
        @JavascriptInterface
        public void showScrollbars(boolean show) {
            runOnUiThread(() -> {
                if (webView == null) return;
                webView.setVerticalScrollBarEnabled(show);
                webView.setHorizontalScrollBarEnabled(show);
            });
        }

        @JavascriptInterface
        public boolean canShare() {
            return canHandOff();
        }

        @JavascriptInterface
        public void shareFile() {
            runOnUiThread(ViewerActivity.this::shareFile);
        }

        /** 파일 공유하기(고친 이름으로). 확장자는 앱이 원래 것으로 고정한다. */
        @JavascriptInterface
        public void shareFileAs(String name) {
            runOnUiThread(() -> ViewerActivity.this.shareFileAs(name));
        }

        /** 다운로드 폴더에 저장할 수 있는지: 다른 앱이 넘겨준 파일(content://)을 다 받아 둔 경우. file:// 은 이미 휴대폰 저장소에 있다. */
        @JavascriptInterface
        public boolean canDownload() {
            return canHandOff() && openedSession() != null;
        }

        @JavascriptInterface
        public void download() {
            runOnUiThread(ViewerActivity.this::downloadFile);
        }

        /**
         * 인쇄·PDF로 저장(PDF가 아닌 문서): 안드로이드 인쇄 창을 연다(웹뷰 인쇄). 사용자가 프린터나 "PDF로 저장"을 고른다.
         * 화면(viewer.js printPages)은 미리 문서를 인쇄 모양으로 바꿔 두고, 인쇄 창이 닫히면 beDocsPrintDone()으로 되돌린다.
         * 종이(mm)는 화면이 고른 것으로 미리 골라 둔다(인쇄 창에서 바꿀 수 있다).
         */
        @JavascriptInterface
        public boolean printPdf(String name, double widthMm, double heightMm) {
            String job = jobName(name);
            runOnUiThread(() -> startPrint(job, widthMm, heightMm));
            return true;
        }

        /** PDF 문서 인쇄: 받아 둔 원본 PDF를 그대로 인쇄 창에 넘긴다(PdfFilePrint). pages: 쪽 수(모르면 0). */
        @JavascriptInterface
        public boolean printFile(String name, double widthMm, double heightMm, int pages) {
            DocSession s = openedSession();
            if (s == null) return false;
            String job = jobName(name);
            runOnUiThread(() -> startPrint(job, new PdfFilePrint(s.file, job, pages, io), widthMm, heightMm));
            return true;
        }

        // ---- 쪽을 그림으로 내보내기(PDF): exportBegin("save"|"share") → 그림마다 exportPart(조각…, last) → exportEnd()
        /** 새 내보내기를 시작한다(하던 것이 있으면 지운다). save: 사진첩에 저장, 아니면 보내기. */
        @JavascriptInterface
        public boolean exportBegin(String mode) {
            synchronized (exportLock) {
                if (export != null) export.cancel();
                export = new ImageExport(getApplicationContext(), "save".equals(mode));
                return true;
            }
        }

        /** 그림 한 장의 base64 조각. 실패하면 이번에 만든 그림을 모두 지우고 false. */
        @JavascriptInterface
        public boolean exportPart(String name, String mime, String base64, boolean last) {
            synchronized (exportLock) {
                if (export == null) return false;
                if (export.part(name, mime, base64, last)) return true;
                export.cancel();
                export = null;
                return false;
            }
        }

        /** 마친다: 저장이면 알림을 띄우고, 보내기면 앱 고르기 창을 연다. 돌려주는 값은 그림 수(실패면 -1). */
        @JavascriptInterface
        public int exportEnd() {
            ImageExport job;
            List<Uri> uris;
            synchronized (exportLock) {
                job = export;
                export = null;
                if (job == null) return -1;
                uris = job.finish();
                if (uris == null) {
                    job.cancel();
                    return -1;
                }
            }
            if (job.saving()) {
                int n = uris.size();
                runOnUiThread(() -> Toast.makeText(ViewerActivity.this,
                        getResources().getQuantityString(R.plurals.gallery_saved, n, ImageExport.ALBUM, n), Toast.LENGTH_LONG).show());
            } else {
                String type = job.mimeType();
                runOnUiThread(() -> shareImages(uris, type));
            }
            return uris.size();
        }

        /** 그만두고 이번에 만든 그림을 모두 지운다. */
        @JavascriptInterface
        public void exportCancel() {
            synchronized (exportLock) {
                if (export != null) export.cancel();
                export = null;
            }
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) return false;
            // 문서 속 웹·메일·전화 링크는 사용자가 눌렀을 때만 해당 앱(브라우저·메일·전화 걸기 화면)으로 넘긴다.
            // 전화는 바로 걸지 않고 번호만 채운 화면을 연다. 그 밖의 이동은 모두 막는다.
            String scheme = url.getScheme();
            if (request.hasGesture() && scheme != null) {
                Intent target = null;
                switch (scheme.toLowerCase(Locale.ROOT)) {
                    case "https":
                    case "http":
                    case "mailto":
                        target = new Intent(Intent.ACTION_VIEW, url);
                        break;
                    case "tel":
                        target = new Intent(Intent.ACTION_DIAL, url);
                        break;
                    default:
                        break;
                }
                if (target != null) {
                    try {
                        startActivity(target);
                    } catch (ActivityNotFoundException ignored) {
                        // 열 앱이 없으면 무시한다.
                    }
                }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String scheme = url.getScheme();
            if (!"https".equals(scheme) && !"http".equals(scheme)) return null;
            if (!"https".equals(scheme) || !HOST.equals(url.getHost())) {
                return status(403, "Forbidden");
            }
            String path = url.getPath() != null ? url.getPath() : "";
            try {
                if (path.startsWith("/viewer/")) return asset(path.substring(1));
                if (path.startsWith("/doc/")) return doc(path, url);
            } catch (Exception e) {
                Log.w(TAG, "request failed: " + path, e);
                return status(500, "Error");
            }
            return status(404, "Not Found");
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // true를 돌려줘야 앱 전체가 함께 죽지 않는다.
            onRendererGone(view, detail.didCrash());
            return true;
        }
    }

    private WebResourceResponse asset(String path) throws IOException {
        if (path.contains("..")) return status(404, "Not Found");
        InputStream in;
        try {
            in = getAssets().open(path);
        } catch (FileNotFoundException e) {
            return status(404, "Not Found");
        }
        return new WebResourceResponse(mimeOf(path), null, in);
    }

    private WebResourceResponse doc(String path, Uri url) throws IOException, InterruptedException {
        Future<DocSession> f = session;
        if ("/doc/info".equals(path)) {
            if (f == null) return json("{\"empty\":true}");
            try {
                DocSession s = f.get();
                return json("{\"name\":" + quote(s.name) + ",\"size\":" + s.file.length()
                        + (rendererFailed ? ",\"rendererFailed\":true" : "") + "}");
            } catch (ExecutionException e) {
                Log.w(TAG, "open failed", e.getCause());
                String gone = recentId;
                if (gone != null && (e.getCause() instanceof FileNotFoundException || e.getCause() instanceof SecurityException)) {
                    // 최근 문서의 원본이 옮겨졌거나 지워졌다(또는 고른 파일의 권한이 풀렸다): 목록에서 빼고 그렇게 알린다.
                    RecentDocs.remove(getApplicationContext(), gone);
                    return json("{\"error\":" + quote(getString(R.string.err_recent_gone)) + "}");
                }
                if (e.getCause() instanceof DocSession.TooBigException) {
                    DocSession.TooBigException big = (DocSession.TooBigException) e.getCause();
                    return json("{\"tooBig\":true,\"name\":" + quote(big.name) + ",\"size\":" + big.size
                            + ",\"error\":" + quote(openErrorMessage(big)) + "}");
                }
                return json("{\"error\":" + quote(openErrorMessage(e.getCause())) + "}");
            }
        }
        if (f == null) return status(404, "Not Found");
        DocSession s;
        try {
            s = f.get();
        } catch (ExecutionException e) {
            return status(404, "Not Found");
        }
        switch (path) {
            case "/doc/head":
                return bytes("application/octet-stream", s.head(8192));
            case "/doc/file":
                return new WebResourceResponse("application/octet-stream", null, s.stream());
            case "/doc/pdf/info":
                try {
                    return json(s.pdfInfo());
                } catch (SecurityException e) {
                    return json("{\"error\":\"password\"}");
                } catch (IOException e) {
                    return json("{\"error\":" + quote(getString(R.string.pdf_read_failed)) + "}");
                }
            case "/doc/pdf/page":
                int index = parseInt(url.getQueryParameter("i"), -1);
                int width = parseInt(url.getQueryParameter("w"), 1200);
                return bytes("image/png", s.pdfPagePng(index, width));
            default:
                return status(404, "Not Found");
        }
    }

    private String openErrorMessage(Throwable t) {
        if (t instanceof SecurityException) return getString(R.string.err_no_permission);
        if (t instanceof FileNotFoundException) return getString(R.string.err_not_found);
        String m = t != null ? t.getMessage() : null;
        return m != null ? m : getString(R.string.err_unknown);
    }

    // ------------------------------------------------------------ 응답 도우미

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static WebResourceResponse json(String body) {
        return bytes("application/json", body.getBytes(StandardCharsets.UTF_8));
    }

    private static WebResourceResponse bytes(String mime, byte[] data) {
        return new WebResourceResponse(mime, null, 200, "OK",
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(data));
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason,
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static int parseInt(String s, int fallback) {
        try {
            return s != null ? Integer.parseInt(s) : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
