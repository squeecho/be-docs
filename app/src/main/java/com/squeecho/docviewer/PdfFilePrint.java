package com.squeecho.docviewer;

import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

/**
 * PDF 문서 인쇄: 받아 둔 원본 PDF를 그대로 인쇄 창에 넘긴다. 화면에 그린 것과 상관없이 모든 쪽이 원래 화질로 나가고,
 * 쪽을 종이에 맞추는 것과 고른 쪽만 찍는 것은 인쇄 창이 한다(그래서 고른 쪽과 상관없이 전체를 넘긴다).
 * 열기 비밀번호가 걸린 PDF는 인쇄 창이 열지 못해 화면이 이 길로 보내지 않는다.
 */
final class PdfFilePrint extends PrintDocumentAdapter {
    private final File file;
    private final String name;
    private final int pages;
    private final Executor io;
    private final Handler main = new Handler(Looper.getMainLooper());

    PdfFilePrint(File file, String name, int pages, Executor io) {
        this.file = file;
        this.name = name;
        this.pages = pages;
        this.io = io;
    }

    @Override
    public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancel,
                         LayoutResultCallback callback, Bundle extras) {
        if (cancel.isCanceled()) {
            callback.onLayoutCancelled();
            return;
        }
        PrintDocumentInfo info = new PrintDocumentInfo.Builder(name + ".pdf")
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(pages > 0 ? pages : PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                .build();
        // 넘기는 내용(원본)은 종이·방향이 바뀌어도 같다. 처음 한 번만 "바뀜"으로 알린다.
        callback.onLayoutFinished(info, oldAttributes == null);
    }

    @Override
    public void onWrite(PageRange[] pageRanges, ParcelFileDescriptor destination, CancellationSignal cancel,
                        WriteResultCallback callback) {
        try {
            io.execute(() -> {
                String error = null;
                // 받는 쪽(destination)은 인쇄 창이 닫으므로 여기서는 쓰기만 한다.
                OutputStream out = new FileOutputStream(destination.getFileDescriptor());
                try (InputStream in = new FileInputStream(file)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while (!cancel.isCanceled() && (n = in.read(buf)) > 0) out.write(buf, 0, n);
                    out.flush();
                } catch (IOException e) {
                    error = e.toString();
                }
                String failed = error;
                main.post(() -> {
                    if (cancel.isCanceled()) callback.onWriteCancelled();
                    else if (failed != null) callback.onWriteFailed(failed);
                    else callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
                });
            });
        } catch (RejectedExecutionException e) {
            callback.onWriteFailed(e.toString());
        }
    }
}
