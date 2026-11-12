package com.squeecho.docviewer;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * 메뉴의 "다운로드": 열어 둔 문서를 휴대폰의 다운로드 폴더에 저장한다.
 * 카톡 등에서 바로 연 파일은 그 앱의 임시 공간에 있어 나중에 찾기 어렵고, 그 앱이 지우기도 한다.
 * 앱이 열 때 복사해 둔 원본(DocSession.file)을 바이트 그대로 저장한다(비밀번호 문서도 원본 그대로).
 * 안드로이드 10 이상은 권한 없이 MediaStore로 넣는다. 같은 이름이 있으면 시스템이 "이름 (1).pdf"처럼 바꾼다.
 * 시스템이 모르는 확장자(hwpx 등)는 "이름.hwpx (1)"처럼 확장자 뒤에 번호를 붙이므로 지우고 "이름 (1).hwpx"로 다시 저장한다.
 */
final class DownloadSave {
    private DownloadSave() {
    }

    /** 저장하고, 실제로 붙은 이름을 돌려준다. 실패하면 만들던 항목을 지우고 IOException. */
    static String save(Context context, File src, String name) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        String fileName = safeName(name);
        String ext = ShareCopy.ext(fileName);
        String base = fileName.substring(0, fileName.length() - ext.length());
        for (int n = 0; ; n++) {
            String wanted = n == 0 ? fileName : base + " (" + n + ")" + ext;
            Uri uri = write(resolver, src, wanted);
            String saved = nameOf(resolver, uri);
            if (saved == null) return wanted;
            // 같은 이름이 있으면 시스템이 이름을 바꾼다. 아는 확장자는 "이름 (1).pdf"로 바꾸지만, 모르는 확장자(hwpx 등)는
            // "이름.hwpx (1)"처럼 확장자 뒤에 번호를 붙여 열리지 않는 이름이 된다(기기 시험 확인). 그러면 지우고 "이름 (n).hwpx"로 다시 저장한다.
            if (ext.isEmpty() || endsWithExt(saved, ext) || n >= 20) return saved;
            deleteQuietly(resolver, uri);
        }
    }

    private static Uri write(ContentResolver resolver, File src, String fileName) throws IOException {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(fileName));
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        if (uri == null) throw new IOException("다운로드 폴더에 항목을 만들지 못함");
        try {
            try (InputStream in = new FileInputStream(src); OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("다운로드 폴더 항목을 열지 못함");
                byte[] buf = new byte[256 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
        } catch (IOException | RuntimeException e) {
            // 지우지 못한 반쯤 만든 항목은 시스템이 IS_PENDING 상태로 두었다가 정리한다.
            deleteQuietly(resolver, uri);
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
        return uri;
    }

    private static void deleteQuietly(ContentResolver resolver, Uri uri) {
        try {
            resolver.delete(uri, null, null);
        } catch (RuntimeException ignored) {
            // 지우지 못해도 저장은 계속한다.
        }
    }

    private static String nameOf(ContentResolver resolver, Uri uri) {
        try (Cursor c = resolver.query(uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
            // 이름을 못 읽어도 저장은 된다.
        }
        return null;
    }

    private static boolean endsWithExt(String name, String ext) {
        return name.toLowerCase(Locale.ROOT).endsWith(ext.toLowerCase(Locale.ROOT));
    }

    /** 파일 이름: 폴더 구분자·안 되는 글자는 _ 로, 앞의 점은 빼고, 너무 길면 확장자를 남기고 줄인다. */
    static String safeName(String name) {
        StringBuilder sb = new StringBuilder();
        (name == null ? "" : name).codePoints().forEach(c -> {
            boolean bad = c < 0x20 || c == 0x7f || "/\\:*?\"<>|".indexOf(c) >= 0;
            sb.appendCodePoint(bad ? '_' : c);
        });
        String s = sb.toString().trim().replaceAll("^\\.+", "");
        if (s.isEmpty()) s = "문서";
        if (s.length() > 150) {
            int dot = s.lastIndexOf('.');
            String ext = dot > 0 && s.length() - dot <= 10 ? s.substring(dot) : "";
            s = s.substring(0, 150 - ext.length()) + ext;
        }
        return s;
    }

    /**
     * 저장할 종류. 이름의 확장자에서 정한다(받은 앱이 알려 준 종류는 틀린 때가 많다).
     * 시스템은 종류와 확장자가 맞지 않으면 종류에 맞는 확장자를 덧붙이므로(application/octet-stream이면 ".bin"),
     * 시스템이 모르는 확장자(hwp 등)는 시스템이 모르는 종류로 주어 이름을 그대로 두게 한다.
     */
    static String mimeFor(String fileName) {
        int dot = fileName.lastIndexOf('.');
        String ext = dot >= 0 ? fileName.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (ext.isEmpty() || !ext.matches("[a-z0-9]{1,10}")) return "application/octet-stream";
        String known = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (known != null) return known;
        if ("hwp".equals(ext)) return "application/x-hwp";
        if ("hwpx".equals(ext)) return "application/haansofthwpx";
        return "application/x-be-docs-" + ext;
    }
}
