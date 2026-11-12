package com.squeecho.docviewer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 테스트 APK의 assets 파일을 content:// 주소로 내주는 제공자. 카카오톡 같은 앱이 파일을 넘기는 방식을 흉내 낸다.
 *
 * 주소 형식: content://com.squeecho.docviewer.test.files/{mode}/{assets 안 경로}
 * - mode=file : 탐색 가능한 파일로 내준다(일반적인 FileProvider)
 * - mode=pipe : 처음부터 차례로만 읽히는 파이프로 내준다(스트리밍하는 앱)
 * - mode=noname : 파일 이름(DISPLAY_NAME)을 알려주지 않는다
 */
public class TestFilesProvider extends ContentProvider {
    static final String AUTHORITY = "com.squeecho.docviewer.test.files";

    static Uri uri(String mode, String assetPath) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY)
                .appendPath(mode).appendEncodedPath(Uri.encode(assetPath, "/")).build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private static String mode(Uri uri) {
        return uri.getPathSegments().get(0);
    }

    private static String assetPath(Uri uri) {
        return uri.getPath().substring(mode(uri).length() + 2);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols);
        Object[] row = new Object[cols.length];
        String path = assetPath(uri);
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) {
                row[i] = "noname".equals(mode(uri)) ? null : path.substring(path.lastIndexOf('/') + 1);
            } else if (OpenableColumns.SIZE.equals(cols[i])) {
                row[i] = null;
            }
        }
        c.addRow(row);
        return c;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        AssetManager assets = getContext().getAssets();
        String path = assetPath(uri);
        try {
            if ("pipe".equals(mode(uri))) {
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createReliablePipe();
                InputStream in = assets.open(path);
                new Thread(() -> {
                    try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]); InputStream src = in) {
                        byte[] buf = new byte[8192];
                        for (int n; (n = src.read(buf)) > 0; ) out.write(buf, 0, n);
                    } catch (IOException ignored) {
                        // 읽는 쪽이 먼저 닫으면 여기로 온다.
                    }
                }).start();
                return pipe[0];
            }
            File f = new File(getContext().getCacheDir(), "provided-" + path.replace('/', '_'));
            try (InputStream in = assets.open(path); OutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
        } catch (IOException e) {
            throw new FileNotFoundException(path + ": " + e.getMessage());
        }
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
}
