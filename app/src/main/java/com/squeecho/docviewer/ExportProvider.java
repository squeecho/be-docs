package com.squeecho.docviewer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;

/**
 * 내보낸 쪽 그림을 다른 앱(카톡 등)에 보낼 때 쓰는 읽기 전용 주소(content://…export/이름).
 * 앱 캐시의 export 폴더 바로 아래 파일과, 이름을 바꿔 공유하는 문서(content://…export/share/번호/이름,
 * 캐시의 share/번호/ 바로 아래)만 읽기로만 연다. 밖에 공개하지 않고(exported=false),
 * 보낼 때 그 주소에만 읽기 권한을 잠깐 넘긴다(FLAG_GRANT_READ_URI_PERMISSION).
 */
public final class ExportProvider extends ContentProvider {

    static File dir(Context context) {
        return new File(context.getCacheDir(), "export");
    }

    static String authority(Context context) {
        return context.getPackageName() + ".export";
    }

    static Uri uriFor(String authority, File file) {
        return new Uri.Builder().scheme("content").authority(authority).appendPath(file.getName()).build();
    }

    /** ShareCopy가 만든 share/번호/이름 파일의 주소. 받는 앱에는 이 이름(DISPLAY_NAME)으로 보인다. */
    static Uri shareUri(String authority, File file) {
        return new Uri.Builder().scheme("content").authority(authority)
                .appendPath(ShareCopy.DIR).appendPath(file.getParentFile().getName()).appendPath(file.getName()).build();
    }

    private static boolean isShare(List<String> segments) {
        return segments.size() == 3 && ShareCopy.DIR.equals(segments.get(0));
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        List<String> segments = uri.getPathSegments();
        File base;
        File f;
        if (isShare(segments)) {
            if (!segments.get(1).matches("[0-9a-z]+-[0-9a-z]+")) throw new FileNotFoundException("공유 번호가 아님");
            base = new File(ShareCopy.dir(getContext()), segments.get(1));
            f = new File(base, segments.get(2));
        } else if (segments.size() == 1) {
            base = dir(getContext());
            f = new File(base, segments.get(0));
        } else {
            throw new FileNotFoundException("export 폴더 바로 아래 파일만 엽니다");
        }
        try {
            File parent = f.getCanonicalFile().getParentFile();
            if (parent == null || !parent.equals(base.getCanonicalFile())) throw new FileNotFoundException("폴더 밖");
        } catch (IOException e) {
            throw new FileNotFoundException("경로 확인 실패");
        }
        if (!f.isFile()) throw new FileNotFoundException("없는 파일");
        return f;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new SecurityException("읽기만 됩니다");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        if (name == null) return null;
        if (isShare(uri.getPathSegments())) return shareType(name);
        return name.toLowerCase(java.util.Locale.ROOT).endsWith(".png") ? "image/png" : "image/jpeg";
    }

    /** 공유하는 문서의 종류(확장자로). 모르는 확장자는 application/octet-stream. */
    static String shareType(String name) {
        String type = DownloadSave.mimeFor(name);
        return type.startsWith("application/x-be-docs-") ? "application/octet-stream" : type;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("읽기 전용");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("읽기 전용");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("읽기 전용");
    }
}
