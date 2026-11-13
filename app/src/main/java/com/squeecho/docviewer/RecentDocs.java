package com.squeecho.docviewer;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 시작 화면의 "최근 문서": 최근에 연(화면에 그려진) 문서를 최근 연 순서로 기억한다. 이 휴대폰의 앱 안(files/recent)에만 둔다.
 * <ul>
 * <li>파일 고르기로 연 문서(pick): 원본을 다시 열 수 있게 읽기 권한을 계속 받아 두고(takePersistableUriPermission) 사본은 두지 않는다.</li>
 * <li>카톡·메일 등 다른 앱이 넘긴 문서(copy): 그 앱이 준 읽기 권한은 화면을 닫으면 사라져 사본을 둔다. 열 때 받아 둔 캐시 사본에
 *     하드 링크를 걸어(같은 저장소라 즉시, 자리도 더 안 씀) 캐시 사본이 지워져도 남게 한다. 같은 내용(SHA-256)은 하나만.</li>
 * </ul>
 * 최근 {@value #MAX_ENTRIES}개, 사본은 합계 {@link #MAX_COPY_BYTES}까지(넘으면 오래된 것부터 지움). 앱 백업은 꺼져 있어
 * (AndroidManifest allowBackup=false) 사본이 구글 백업으로 나가지 않는다. 앱을 지우면 함께 지워진다.
 * 목록 고치기(읽고-고치고-쓰기)는 모두 LOCK 안에서 한 번에 한다. 사본의 내용 확인(SHA-256)처럼 오래 걸리는 일만 WORK에서 한다.
 */
final class RecentDocs {
    private static final String TAG = "DocViewer";
    static final int MAX_ENTRIES = 30;
    static final long MAX_COPY_BYTES = 500L * 1024 * 1024;
    private static final String DIR = "recent";
    private static final String INDEX = "index.json";
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    private static final Object LOCK = new Object();
    private static final SecureRandom RANDOM = new SecureRandom();

    static final String KIND_PICK = "pick";
    static final String KIND_COPY = "copy";

    /** 목록 한 줄. id는 무작위 16자리 16진수(사본 파일 이름으로도 쓴다). */
    static final class Entry {
        String id;
        String kind;
        String name;
        String mime;
        long size;
        long opened;
        String uri;   // pick: 원본 주소
        String sha;   // copy: 내용 SHA-256(같은 문서를 다시 받으면 하나로)

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id).put("kind", kind).put("name", name).put("size", size).put("opened", opened);
            if (mime != null) o.put("mime", mime);
            if (uri != null) o.put("uri", uri);
            if (sha != null) o.put("sha", sha);
            return o;
        }

        static Entry fromJson(JSONObject o) {
            Entry e = new Entry();
            e.id = o.optString("id", "");
            e.kind = o.optString("kind", "");
            e.name = o.optString("name", "");
            e.mime = o.has("mime") ? o.optString("mime") : null;
            e.size = o.optLong("size", 0);
            e.opened = o.optLong("opened", 0);
            e.uri = o.has("uri") ? o.optString("uri") : null;
            e.sha = o.has("sha") ? o.optString("sha") : null;
            return e;
        }
    }

    private RecentDocs() {
    }

    static File dir(Context context) {
        return new File(context.getFilesDir(), DIR);
    }

    private static File copies(Context context) {
        return new File(dir(context), "files");
    }

    static boolean validId(String id) {
        return id != null && id.matches("[0-9a-f]{16}");
    }

    /** 사본 파일(copy 줄). id를 검사해 목록 폴더 밖을 가리키지 못하게 한다. */
    static File copyFile(Context context, String id) {
        if (!validId(id)) throw new IllegalArgumentException("bad id");
        return new File(copies(context), id);
    }

    // ------------------------------------------------------------ 읽기

    /** 화면에 줄 목록(최근 연 순서). 사본이 사라진 copy 줄은 빼고 보여 준다. */
    static String listJson(Context context) {
        List<Entry> list = load(context);
        JSONArray out = new JSONArray();
        for (Entry e : list) {
            if (KIND_COPY.equals(e.kind) && !copyFile(context, e.id).isFile()) continue;
            JSONObject o = new JSONObject();
            try {
                o.put("id", e.id).put("name", e.name).put("size", e.size).put("opened", e.opened).put("kind", e.kind);
            } catch (JSONException ignored) {
                continue;
            }
            out.put(o);
        }
        return out.toString();
    }

    static Entry get(Context context, String id) {
        if (!validId(id)) return null;
        for (Entry e : load(context)) if (e.id.equals(id)) return e;
        return null;
    }

    private static List<Entry> load(Context context) {
        synchronized (LOCK) {
            List<Entry> list = new ArrayList<>();
            File f = new File(dir(context), INDEX);
            if (!f.isFile()) return list;
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[(int) Math.min(f.length(), 4L * 1024 * 1024)];
                int len = 0;
                for (int n; len < buf.length && (n = in.read(buf, len, buf.length - len)) > 0; ) len += n;
                JSONArray arr = new JSONArray(new String(buf, 0, len, StandardCharsets.UTF_8));
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    Entry e = Entry.fromJson(o);
                    if (validId(e.id) && (KIND_PICK.equals(e.kind) || KIND_COPY.equals(e.kind))) list.add(e);
                }
            } catch (IOException | JSONException e) {
                Log.w(TAG, "최근 문서 목록을 읽지 못함(새로 시작)", e);
            }
            list.sort((a, b) -> Long.compare(b.opened, a.opened));
            return list;
        }
    }

    private static void save(Context context, List<Entry> list) {
        synchronized (LOCK) {
            File d = dir(context);
            if (!d.isDirectory() && !d.mkdirs()) return;
            JSONArray arr = new JSONArray();
            try {
                for (Entry e : list) arr.put(e.toJson());
            } catch (JSONException e) {
                return;
            }
            File tmp = new File(d, INDEX + ".tmp");
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(arr.toString().getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                Log.w(TAG, "최근 문서 목록을 쓰지 못함", e);
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                return;
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(new File(d, INDEX));
        }
    }

    // ------------------------------------------------------------ 기록

    /**
     * 파일 고르기로 연 문서. 원본을 다시 열 읽기 권한을 받아 둔다(문서를 고른 화면이 살아 있을 때 불러야 한다).
     * 권한을 계속 받을 수 없는 곳이면 사본으로 기억한다.
     */
    static void recordPicked(Context context, Uri uri, String name, String mime, File opened) {
        Context app = context.getApplicationContext();
        boolean kept;
        try {
            app.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            kept = true;
        } catch (SecurityException e) {
            kept = false;
        }
        if (!kept) {
            recordCopy(app, opened, name, mime);
            return;
        }
        long size = opened.length();
        String key = uri.toString();
        synchronized (LOCK) {
            List<Entry> list = load(app);
            Entry e = null;
            for (Entry x : list) if (KIND_PICK.equals(x.kind) && key.equals(x.uri)) e = x;
            if (e == null) {
                e = new Entry();
                e.id = newId();
                e.kind = KIND_PICK;
                e.uri = key;
                list.add(e);
            }
            e.name = name;
            e.mime = mime;
            e.size = size;
            e.opened = System.currentTimeMillis();
            trimAndSave(app, list);
        }
    }

    /**
     * 다른 앱이 넘긴 문서. 열 때 받아 둔 캐시 사본(opened)에 지금 바로 하드 링크를 걸고(문서를 닫으면 캐시 사본이 지워지므로),
     * 같은 내용이 이미 있는지는 뒤에서 확인한다.
     */
    static void recordCopy(Context context, File opened, String name, String mime) {
        Context app = context.getApplicationContext();
        File d = copies(app);
        if (!d.isDirectory() && !d.mkdirs()) return;
        String id = newId();
        File target = new File(d, id);
        boolean linked;
        try {
            Os.link(opened.getAbsolutePath(), target.getAbsolutePath());
            // 목록 정리(trimAndSave)가 목록에 오르기 전의 새 사본을 지우지 않게(1분 안 것은 남긴다)
            //noinspection ResultOfMethodCallIgnored
            target.setLastModified(System.currentTimeMillis());
            linked = true;
        } catch (ErrnoException e) {
            linked = false;
        }
        boolean finalLinked = linked;
        run(() -> {
            try {
                if (!finalLinked) copy(opened, target);
                String sha = sha256(target);
                synchronized (LOCK) {
                List<Entry> list = load(app);
                Entry same = null;
                for (Entry x : list) if (KIND_COPY.equals(x.kind) && sha.equals(x.sha) && copyFile(app, x.id).isFile()) same = x;
                if (same != null) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                    same.name = name;
                    same.mime = mime;
                    same.opened = System.currentTimeMillis();
                } else {
                    Entry e = new Entry();
                    e.id = id;
                    e.kind = KIND_COPY;
                    e.name = name;
                    e.mime = mime;
                    e.size = target.length();
                    e.sha = sha;
                    e.opened = System.currentTimeMillis();
                    list.add(e);
                }
                trimAndSave(app, list);
                }
            } catch (IOException | RuntimeException e) {
                Log.w(TAG, "최근 문서 사본을 만들지 못함", e);
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
        });
    }

    /** 목록에서 다시 연 문서: 연 시각만 새로. */
    static void touch(Context context, String id) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            List<Entry> list = load(app);
            for (Entry e : list) {
                if (e.id.equals(id)) {
                    e.opened = System.currentTimeMillis();
                    trimAndSave(app, list);
                    return;
                }
            }
        }
    }

    /** 한 줄 빼기(사본·받아 둔 권한도 함께 정리). */
    static void remove(Context context, String id) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            List<Entry> list = load(app);
            List<Entry> keep = new ArrayList<>();
            for (Entry e : list) {
                if (e.id.equals(id)) forget(app, e);
                else keep.add(e);
            }
            save(app, keep);
        }
    }

    /** 모두 지우기. 목록에 없는 남은 사본도 지운다. */
    static void clear(Context context) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            for (Entry e : load(app)) forget(app, e);
            save(app, new ArrayList<>());
            File[] left = copies(app).listFiles();
            if (left == null) return;
            long now = System.currentTimeMillis();
            for (File f : left) {
                // 지금 막 기록 중인(1분 안에 링크한) 사본은 그 기록이 끝나며 목록에 오른다. 그 밖은 지운다.
                if (now - f.lastModified() > 60_000) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        }
    }

    /** 시험용: 쌓인 일이 끝날 때까지 기다린다. */
    static void awaitIdle() {
        try {
            WORK.submit(() -> { }).get();
        } catch (Exception ignored) {
            // 기다리지 못해도 시험이 다음 확인에서 알린다.
        }
    }

    // ------------------------------------------------------------ 내부

    private static void run(Runnable r) {
        WORK.execute(() -> {
            try {
                r.run();
            } catch (RuntimeException e) {
                Log.w(TAG, "최근 문서 정리 실패", e);
            }
        });
    }

    /** 최근 순서로 MAX_ENTRIES개, 사본은 합계 MAX_COPY_BYTES까지 남기고 나머지는 지운다. 목록에 없는 사본도 지운다. */
    private static void trimAndSave(Context app, List<Entry> list) {
        list.sort((a, b) -> Long.compare(b.opened, a.opened));
        List<Entry> keep = new ArrayList<>();
        long bytes = 0;
        for (Entry e : list) {
            boolean ok = keep.size() < MAX_ENTRIES;
            if (ok && KIND_COPY.equals(e.kind)) {
                long size = copyFile(app, e.id).length();
                ok = bytes + size <= MAX_COPY_BYTES || keep.isEmpty();
                if (ok) bytes += size;
            }
            if (ok) keep.add(e);
            else forget(app, e);
        }
        save(app, keep);
        File[] files = copies(app).listFiles();
        if (files == null) return;
        long now = System.currentTimeMillis();
        for (File f : files) {
            boolean listed = false;
            for (Entry e : keep) if (e.id.equals(f.getName())) listed = true;
            // 막 링크를 걸고 아직 목록에 넣기 전인 사본(1분 안)은 남긴다
            if (!listed && now - f.lastModified() > 60_000) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    private static void forget(Context app, Entry e) {
        if (KIND_COPY.equals(e.kind)) {
            //noinspection ResultOfMethodCallIgnored
            copyFile(app, e.id).delete();
        } else if (e.uri != null) {
            try {
                app.getContentResolver().releasePersistableUriPermission(Uri.parse(e.uri), Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // 이미 풀린 권한
            }
        }
    }

    private static String newId() {
        return String.format(Locale.ROOT, "%016x", RANDOM.nextLong());
    }

    private static void copy(File src, File out) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) os.write(buf, 0, n);
        }
    }

    private static String sha256(File f) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    /** content:// 주소인지(파일 고르기 결과는 늘 content://). */
    static boolean isContent(Uri uri) {
        return uri != null && ContentResolver.SCHEME_CONTENT.equals(uri.getScheme());
    }
}
