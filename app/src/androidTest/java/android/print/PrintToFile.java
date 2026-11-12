package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

/**
 * 계측 테스트: 웹뷰의 인쇄(PrintDocumentAdapter)를 인쇄 창 없이 PDF 파일로 받는다. 인쇄 창의 "PDF로 저장"이 하는 일과 같다.
 * 결과 콜백의 생성자가 SDK에서 같은 패키지에만 보여(@hide, @UnsupportedAppUsage라 실행은 막히지 않는다) 이 패키지에 둔다.
 * 어댑터는 메인 스레드에서 불러야 한다.
 */
public final class PrintToFile {
    /** 끝나면 한 번 불린다. 실패면 error에 까닭, 성공이면 null. */
    public interface Done {
        void done(String error);
    }

    private PrintToFile() {
    }

    public static void write(PrintDocumentAdapter adapter, PrintAttributes attributes, ParcelFileDescriptor out, Done done) {
        CancellationSignal cancel = new CancellationSignal();
        adapter.onStart();
        adapter.onLayout(null, attributes, cancel, new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                adapter.onWrite(new PageRange[]{PageRange.ALL_PAGES}, out, cancel, new PrintDocumentAdapter.WriteResultCallback() {
                    @Override
                    public void onWriteFinished(PageRange[] pages) {
                        adapter.onFinish();
                        done.done(null);
                    }

                    @Override
                    public void onWriteFailed(CharSequence error) {
                        adapter.onFinish();
                        done.done("쓰기 실패: " + error);
                    }

                    @Override
                    public void onWriteCancelled() {
                        adapter.onFinish();
                        done.done("쓰기 취소");
                    }
                });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                adapter.onFinish();
                done.done("배치 실패: " + error);
            }

            @Override
            public void onLayoutCancelled() {
                adapter.onFinish();
                done.done("배치 취소");
            }
        }, null);
    }
}
