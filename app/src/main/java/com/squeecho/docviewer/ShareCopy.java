package com.squeecho.docviewer;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.util.Locale;

/**
 * 파일 공유하기에서 이름을 바꿔 보낼 때: 받아 둔 사본을 새 이름으로 캐시의 share/번호/ 아래에 둔다.
 * 사본과 같은 저장소라 하드 링크로 바로 만들고(크기와 상관없이 즉시, 자리도 더 안 씀), 안 되면 복사한다.
 * 받는 앱(카톡·메일 등)이 나중에 읽을 수 있게 바로 지우지 않고, 하루 지난 것만 다음 공유 때 정리한다.
 */
final class ShareCopy {

    static final String DIR = "share";
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;
    private static final SecureRandom RANDOM = new SecureRandom();

    private ShareCopy() {
    }

    static File dir(Context context) {
        return new File(context.getCacheDir(), DIR);
    }

    /** 원래 이름의 확장자(".hwp" 등, 없으면 ""). */
    static String ext(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        if (dot <= 0) return "";
        String ext = name.substring(dot);
        return ext.length() <= 11 && ext.substring(1).matches("[A-Za-z0-9]+") ? ext : "";
    }

    /** 보낼 이름: 고친 이름 + 원래 확장자(종류가 바뀌지 않게 고정). 비었거나 쓸 수 없는 이름이면 원래 이름. */
    static String nameFor(String wanted, String original) {
        String orig = original == null || original.isEmpty() ? "문서" : original;
        String ext = ext(orig);
        String base = wanted == null ? "" : wanted.trim();
        if (!ext.isEmpty() && base.toLowerCase(Locale.ROOT).endsWith(ext.toLowerCase(Locale.ROOT))) {
            base = base.substring(0, base.length() - ext.length()).trim();
        }
        base = DownloadSave.safeName(base.isEmpty() ? "_" : base);
        if (base.isEmpty() || base.matches("_+")) return orig;
        return DownloadSave.safeName(base + ext);
    }

    /** src를 name으로 보낼 수 있게 share/번호/name 에 만든다. */
    static File make(Context context, File src, String name) throws IOException {
        File root = dir(context);
        cleanOld(root);
        File slot = new File(root, Long.toString(System.currentTimeMillis(), 36) + "-" + Integer.toString(RANDOM.nextInt(1 << 30), 36));
        if (!slot.mkdirs()) throw new IOException("공유할 파일 자리를 만들지 못했어요.");
        File out = new File(slot, name);
        if (!out.getCanonicalFile().getParentFile().equals(slot.getCanonicalFile())) {
            throw new IOException("쓸 수 없는 이름");
        }
        try {
            Os.link(src.getAbsolutePath(), out.getAbsolutePath());
        } catch (ErrnoException e) {
            copy(src, out);
        }
        return out;
    }

    private static void copy(File src, File out) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) os.write(buf, 0, n);
        } catch (IOException | RuntimeException e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw e;
        }
    }

    private static void cleanOld(File root) {
        File[] slots = root.listFiles();
        if (slots == null) return;
        long cutoff = System.currentTimeMillis() - KEEP_MS;
        for (File slot : slots) {
            if (slot.lastModified() > cutoff) continue;
            File[] files = slot.listFiles();
            if (files != null) {
                //noinspection ResultOfMethodCallIgnored
                for (File f : files) f.delete();
            }
            //noinspection ResultOfMethodCallIgnored
            slot.delete();
        }
    }
}
