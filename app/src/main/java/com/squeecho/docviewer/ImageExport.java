package com.squeecho.docviewer;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 쪽을 그림으로 내보내기(PDF). 화면(웹 뷰어)이 쪽마다 그린 그림(PNG·JPG)을 base64 조각으로 넘기면
 * 사진첩(Pictures/be docs 앨범)에 저장하거나, 앱 캐시에 모았다가 다른 앱으로 보낸다(ExportProvider).
 *
 * 화면 스크립트의 앱 호출(JavaBridge 스레드)에서 불린다. 한 번에 하나만 진행하고, 실패하거나 취소하면
 * 이번에 만든 그림을 모두 지운다(반쯤 저장된 채 남지 않게).
 * 사진첩 저장은 안드로이드 10 이상에서 권한 없이 된다(앱이 만든 사진은 MediaStore에 바로 넣을 수 있다).
 */
final class ImageExport {
    static final String ALBUM = "be docs";
    private static final String TAG = ViewerActivity.TAG;
    private static final long MAX_IMAGE_BYTES = 300L * 1024 * 1024;
    private static final int MAX_IMAGES = 2000;

    private final ContentResolver resolver;
    private final File dir;
    private final String authority;
    private final boolean save;
    private final List<Uri> done = new ArrayList<>();
    private final List<File> files = new ArrayList<>();
    private String mime;
    private boolean mixed;
    private OutputStream out;
    private Uri current;
    private File currentFile;
    private long written;

    ImageExport(Context context, boolean save) {
        this.resolver = context.getContentResolver();
        this.dir = ExportProvider.dir(context);
        this.authority = ExportProvider.authority(context);
        this.save = save;
        // 보내기용 그림은 다음 내보내기 때 지운다(받는 앱이 다 읽을 시간을 준다).
        if (!save) clearDir(dir, 0);
    }

    boolean saving() {
        return save;
    }

    /** 보낼 그림 종류: 모두 같으면 그 종류, 섞였으면 image/*. */
    String mimeType() {
        return mixed || mime == null ? "image/*" : mime;
    }

    /**
     * 그림 한 장의 다음 조각(base64, 길이가 4의 배수). last면 그 그림을 마친다.
     * 이름·종류가 맞지 않거나 쓰지 못하면 false.
     */
    boolean part(String name, String type, String base64, boolean last) {
        try {
            if (base64 == null || !("image/png".equals(type) || "image/jpeg".equals(type))) return false;
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (out == null) {
                if (done.size() >= MAX_IMAGES || !looksLike(type, bytes)) return false;
                open(safeName(name, type), type);
            }
            written += bytes.length;
            if (written > MAX_IMAGE_BYTES) return false;
            out.write(bytes);
            if (last) close();
            return true;
        } catch (IOException | IllegalArgumentException | SecurityException | IllegalStateException e) {
            Log.w(TAG, "그림 내보내기 실패", e);
            return false;
        }
    }

    /** 다 만든 그림 주소들. 쓰는 중인 그림이 남아 있으면 null(실패로 본다). */
    List<Uri> finish() {
        if (out != null) return null;
        return new ArrayList<>(done);
    }

    /** 이번에 만든 그림을 모두 지운다. */
    void cancel() {
        try {
            if (out != null) out.close();
        } catch (IOException ignored) {
            // 지우는 중이다.
        }
        out = null;
        if (current != null) deleteQuietly(current);
        if (currentFile != null && !currentFile.delete()) currentFile.deleteOnExit();
        current = null;
        currentFile = null;
        if (save) {
            for (Uri uri : done) deleteQuietly(uri);
        } else {
            for (File f : files) if (!f.delete()) f.deleteOnExit();
        }
        done.clear();
        files.clear();
    }

    private void open(String name, String type) throws IOException {
        if (mime != null && !mime.equals(type)) mixed = true;
        mime = type;
        written = 0;
        if (save) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, type);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + ALBUM);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            current = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (current == null) throw new IOException("사진첩에 항목을 만들지 못함");
            out = resolver.openOutputStream(current);
            if (out == null) throw new IOException("사진첩 항목을 열지 못함");
        } else {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("캐시 폴더를 만들지 못함");
            currentFile = unique(new File(dir, name));
            out = new FileOutputStream(currentFile);
        }
    }

    private void close() throws IOException {
        out.close();
        out = null;
        if (save) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(current, v, null, null);
            done.add(current);
            current = null;
        } else {
            files.add(currentFile);
            done.add(ExportProvider.uriFor(authority, currentFile));
            currentFile = null;
        }
    }

    private void deleteQuietly(Uri uri) {
        try {
            resolver.delete(uri, null, null);
        } catch (RuntimeException e) {
            Log.w(TAG, "만들다 만 그림을 지우지 못함", e);
        }
    }

    /** 그림 파일의 첫 바이트가 말한 종류와 맞는지(PNG·JPG만 받는다). */
    static boolean looksLike(String type, byte[] b) {
        if ("image/png".equals(type)) {
            return b.length >= 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G';
        }
        return b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff;
    }

    /** 파일 이름: 글자·숫자·공백·._-() 만 남기고, 확장자를 종류에 맞춘다. 폴더 구분자 등은 _ 로 바꾼다. */
    static String safeName(String name, String type) {
        String ext = "image/png".equals(type) ? ".png" : ".jpg";
        String base = name == null ? "" : name.replaceAll("(?i)\\.(png|jpe?g)$", "");
        StringBuilder sb = new StringBuilder();
        base.codePoints().forEach(c -> {
            boolean ok = Character.isLetterOrDigit(c) || c == ' ' || c == '.' || c == '_' || c == '-' || c == '(' || c == ')';
            sb.appendCodePoint(ok ? c : '_');
        });
        String s = sb.toString().trim().replaceAll("^\\.+", "");
        if (s.isEmpty()) s = "page";
        if (s.length() > 100) s = s.substring(0, 100);
        return s + ext;
    }

    private static File unique(File f) {
        if (!f.exists()) return f;
        String n = f.getName();
        int dot = n.lastIndexOf('.');
        String stem = n.substring(0, dot);
        String ext = n.substring(dot);
        for (int i = 2; ; i++) {
            File g = new File(f.getParentFile(), stem + " (" + i + ")" + ext);
            if (!g.exists()) return g;
        }
    }

    /** 보내기용 캐시 그림 중 olderThanMillis보다 오래된 것을 지운다(0이면 모두). */
    static void clearDir(File dir, long olderThanMillis) {
        File[] list = dir.listFiles();
        if (list == null) return;
        long now = System.currentTimeMillis();
        for (File f : list) {
            if (olderThanMillis == 0 || now - f.lastModified() > olderThanMillis) {
                if (!f.delete()) f.deleteOnExit();
            }
        }
    }
}
