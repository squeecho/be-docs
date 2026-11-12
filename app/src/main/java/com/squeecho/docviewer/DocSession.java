package com.squeecho.docviewer;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.Normalizer;

/**
 * 열려 있는 문서 하나. 받은 파일을 앱 캐시에 복사해 두고, 뷰어 화면이 요청하는 바이트·PDF 페이지를 내준다.
 * 캐시에 복사하는 이유: 카톡 등이 넘겨주는 스트림은 한 번만 읽히거나 탐색이 안 될 수 있는데,
 * PdfRenderer는 탐색 가능한 파일이 필요하다.
 */
final class DocSession implements Closeable {
    private static final long MAX_BYTES = 300L * 1024 * 1024;
    private static final long MAX_PIXELS = 12_000_000L;
    static final String CACHE_DIR = "open";

    final String name;
    final File file;

    private ParcelFileDescriptor pdfFd;
    private PdfRenderer pdf;
    private boolean closed;

    private DocSession(String name, File file) {
        this.name = name;
        this.file = file;
    }

    /** 받을 수 있는 크기(300MB)를 넘는 파일. 화면이 "300MB가 넘는 파일은 열 수 없어요"로 알린다. size: 아는 크기(모르면 -1). */
    static final class TooBigException extends IOException {
        final String name;
        final long size;

        TooBigException(String message, String name, long size) {
            super(message);
            this.name = name;
            this.size = size;
        }
    }

    static DocSession open(Context context, Uri uri) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        rejectPrivateFile(context, uri);
        String name = displayName(resolver, uri, context.getString(R.string.doc_default_name));
        // 크기를 알려 주는 앱(내 파일·드라이브 등)이면 복사하기 전에 바로 알린다. 모르면 복사하다 넘는 순간 멈춘다.
        long declared = declaredSize(resolver, uri);
        if (declared > MAX_BYTES) throw new TooBigException(context.getString(R.string.err_too_big), name, declared);
        File dir = new File(context.getCacheDir(), CACHE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException(context.getString(R.string.err_temp_dir));
        }
        File copy = File.createTempFile("doc", ".bin", dir);
        try (InputStream in = resolver.openInputStream(uri);
             OutputStream out = new FileOutputStream(copy)) {
            if (in == null) {
                throw new IOException(context.getString(R.string.err_cannot_open));
            }
            byte[] buf = new byte[64 * 1024];
            long total = 0;
            for (int n; (n = in.read(buf)) > 0; ) {
                total += n;
                if (total > MAX_BYTES) {
                    throw new TooBigException(context.getString(R.string.err_too_big), name, declared);
                }
                out.write(buf, 0, n);
            }
        } catch (IOException | RuntimeException e) {
            //noinspection ResultOfMethodCallIgnored
            copy.delete();
            throw e;
        }
        return new DocSession(name, copy);
    }

    /**
     * 다른 앱이 file:// 주소로 이 앱의 내부 파일(캐시에 받아 둔 문서 등)을 열게 하는 것을 막는다.
     * 외부 저장소의 file:// 주소는 예전 파일 관리자 호환을 위해 그대로 연다.
     */
    /**
     * 앱이 뒤에 있는 동안 시스템이 앱을 정리했다가 다시 만들 때, 받아 둔 사본으로 다시 연다.
     * 카톡이 준 읽기 권한은 그때 사라졌을 수 있어서 원래 주소를 다시 읽지 않는다. 우리 캐시 폴더의 파일만 받는다.
     */
    static DocSession restore(Context context, String path, String name) {
        if (path == null || name == null) return null;
        try {
            File dir = new File(context.getCacheDir(), CACHE_DIR).getCanonicalFile();
            File file = new File(path).getCanonicalFile();
            if (!dir.equals(file.getParentFile()) || !file.isFile()) return null;
            //noinspection ResultOfMethodCallIgnored
            file.setLastModified(System.currentTimeMillis()); // 오래된 사본 정리에서 지워지지 않게
            return new DocSession(name, file);
        } catch (IOException e) {
            return null;
        }
    }

    private static void rejectPrivateFile(Context context, Uri uri) throws IOException {
        if (!ContentResolver.SCHEME_FILE.equals(uri.getScheme()) || uri.getPath() == null) return;
        String target = new File(uri.getPath()).getCanonicalPath();
        String[] privateDirs = {
                context.getApplicationInfo().dataDir,
                context.getFilesDir().getParent(),
                context.getCacheDir().getParent(),
        };
        for (String dir : privateDirs) {
            if (dir == null) continue;
            String base = new File(dir).getCanonicalPath();
            if (target.equals(base) || target.startsWith(base + File.separator)) {
                throw new SecurityException(context.getString(R.string.err_private_file));
            }
        }
    }

    private static long declaredSize(ContentResolver resolver, Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            String path = uri.getPath();
            return path != null && ContentResolver.SCHEME_FILE.equals(uri.getScheme()) ? new File(path).length() : -1;
        }
        try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (RuntimeException ignored) {
            // 크기를 못 얻으면 복사하면서 잰다.
        }
        return -1;
    }

    private static String displayName(ContentResolver resolver, Uri uri, String fallback) {
        return Normalizer.normalize(rawDisplayName(resolver, uri, fallback), Normalizer.Form.NFC);
    }

    /** 맥에서 만든 파일은 한글 이름이 자모로 풀려(NFD) 오기도 해서, 위에서 NFC로 합친다. */
    private static String rawDisplayName(ContentResolver resolver, Uri uri, String fallback) {
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME},
                    null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) {
                    String name = c.getString(0);
                    if (name != null && !name.isEmpty()) return name;
                }
            } catch (RuntimeException ignored) {
                // 이름을 못 얻어도 문서는 열 수 있다.
            }
        }
        String last = uri.getLastPathSegment();
        return last != null && !last.isEmpty() ? last : fallback;
    }

    byte[] head(int max) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[max];
            int len = 0;
            for (int n; len < max && (n = in.read(buf, len, max - len)) > 0; ) len += n;
            byte[] out = new byte[len];
            System.arraycopy(buf, 0, out, 0, len);
            return out;
        }
    }

    InputStream stream() throws IOException {
        return new FileInputStream(file);
    }

    /** 페이지 크기 목록(JSON). 비밀번호가 걸린 PDF면 SecurityException. */
    synchronized String pdfInfo() throws IOException {
        PdfRenderer r = renderer();
        StringBuilder sb = new StringBuilder("{\"pages\":[");
        for (int i = 0, n = r.getPageCount(); i < n; i++) {
            try (PdfRenderer.Page page = r.openPage(i)) {
                if (i > 0) sb.append(',');
                sb.append("{\"w\":").append(page.getWidth())
                        .append(",\"h\":").append(page.getHeight()).append('}');
            }
        }
        return sb.append("]}").toString();
    }

    /** PDF 한 페이지를 지정한 가로 픽셀로 그려 PNG로 돌려준다. */
    byte[] pdfPagePng(int index, int width) throws IOException {
        Bitmap bitmap = renderPdfPage(index, width);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            return out.toByteArray();
        } finally {
            bitmap.recycle();
        }
    }

    private synchronized Bitmap renderPdfPage(int index, int width) throws IOException {
        PdfRenderer r = renderer();
        if (index < 0 || index >= r.getPageCount()) {
            throw new IOException("쪽 번호가 범위를 벗어남: " + index);
        }
        try (PdfRenderer.Page page = r.openPage(index)) {
            int w = Math.max(200, Math.min(width, 3000));
            int h = Math.max(1, Math.round((float) w * page.getHeight() / page.getWidth()));
            if ((long) w * h > MAX_PIXELS) {
                double scale = Math.sqrt((double) MAX_PIXELS / ((long) w * h));
                w = Math.max(1, (int) (w * scale));
                h = Math.max(1, (int) (h * scale));
            }
            Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bitmap.eraseColor(Color.WHITE);
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
            return bitmap;
        }
    }

    private PdfRenderer renderer() throws IOException {
        if (closed) throw new IOException("이미 닫힌 문서");
        if (pdf == null) {
            ParcelFileDescriptor fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            try {
                pdf = new PdfRenderer(fd);
                pdfFd = fd;
            } catch (Exception e) {
                // 안드로이드 PDF 엔진은 XFA 문서 등에서 선언되지 않은 java.lang.Exception도 던진다.
                fd.close();
                if (e instanceof IOException) throw (IOException) e;
                if (e instanceof RuntimeException) throw (RuntimeException) e;
                throw new IOException(e.getMessage(), e);
            }
        }
        return pdf;
    }

    @Override
    public synchronized void close() {
        release();
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** PDF 렌더러만 닫고 사본 파일은 남긴다(화면을 다시 만들 때 새 세션이 이어서 쓴다). */
    synchronized void release() {
        if (closed) return;
        closed = true;
        if (pdf != null) {
            pdf.close();
            pdf = null;
        }
        if (pdfFd != null) {
            try {
                pdfFd.close();
            } catch (IOException ignored) {
                // 닫기 실패는 무시한다.
            }
            pdfFd = null;
        }
    }

    /** 앱이 강제 종료돼 남은 오래된 임시 파일을 지운다. */
    static void sweep(Context context, long olderThanMillis) {
        File[] files = new File(context.getCacheDir(), CACHE_DIR).listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - olderThanMillis;
        for (File f : files) {
            if (f.lastModified() < cutoff) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }
}
