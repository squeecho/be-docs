#!/usr/bin/env bash
# GitHub Actions 에뮬레이터에서 계측 테스트를 돌리고, 스크린샷·로그를 build/ci-output 에 모은다.
set -uo pipefail
cd "$(dirname "$0")/.."
out=build/ci-output
mkdir -p "$out"
adb logcat -G 16M || true
adb logcat -c || true
# 부팅 직후 에뮬레이터는 시스템 앱(gms 등)의 "응답 없음"·오류 대화상자를 자주 띄워, 시험 중인 앱 창의 입력 초점을 가져간다
# (CI #30: 뒤로 가기 키가 앱에 오지 않음, 창 초점 없음). 시험 동안 이런 대화상자를 띄우지 않게 한다.
adb shell settings put global hide_error_dialogs 1 || true
# 부팅 직후 몇 분 동안 시스템 앱(gms 등)이 "응답 없음"으로 정리되는데, 그때 gms 글꼴 제공자에 연결돼 있던 앱도 함께 죽는다
# (CI #29·#31 안드로이드 14: "depends on provider ...fonts.provider.FontsProvider in dying proc ...gms.persistent"로
# 첫 시험 중 앱 프로세스 종료. 앱은 글꼴 제공자를 직접 쓰지 않고 웹뷰가 연결한다). 응답 없음이 60초 동안 새로 나오지
# 않을 때까지(최대 4분) 기다린 뒤 시험을 시작한다.
settle_start=$(date +%s)
anr_last=""
anr_quiet=$settle_start
while [ $(( $(date +%s) - settle_start )) -lt 240 ]; do
  anr_now=$(adb logcat -d -b events 2>/dev/null | grep -c "am_anr" || true)
  if [ "$anr_now" != "$anr_last" ]; then anr_last=$anr_now; anr_quiet=$(date +%s); fi
  [ $(( $(date +%s) - anr_quiet )) -ge 60 ] && break
  sleep 5
done
echo "시험 전 시스템 안정 대기: $(( $(date +%s) - settle_start ))초(부팅 뒤 응답 없음 ${anr_last:-0}건)"

# 일부만 다시 돌릴 때(Run workflow의 tests·matrix-only, 기기 시험 시간·비용을 줄인다):
# TESTS=클래스#메서드(쉼표로 여럿), MATRIX_ONLY=버전별 시험에서 파일 이름에 든 낱말(쉼표로 여럿). 비우면 전부.
only=()
[ -n "${TESTS:-}" ] && only+=("-Pandroid.testInstrumentationRunnerArguments.class=$TESTS")
[ -n "${MATRIX_ONLY:-}" ] && only+=("-Pandroid.testInstrumentationRunnerArguments.matrixOnly=$MATRIX_ONLY")
[ ${#only[@]} -gt 0 ] && echo "일부만 시험: ${only[*]}"
./gradlew --no-daemon connectedDebugAndroidTest \
  -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true "${only[@]}"
status=$?

adb logcat -d -s DocViewer:V DocViewerTest:V AndroidRuntime:E chromium:W > "$out/logcat.txt" || true
echo "----- 버전별 결과 -----"
grep -E "DocViewerTest: WEBVIEW " "$out/logcat.txt" | sed -E 's/.*DocViewerTest: //' | head -1 || true
grep -E "DocViewerTest: (PASS|FAIL) " "$out/logcat.txt" | sed -E 's/.*DocViewerTest: //' | awk '!seen[$0]++' | cut -c1-400 || true
# 기기 시험이 남기는 진단(회전 뒤 다시 그리기까지 걸린 시간, 뒤로 가기 때 자판 상태 등)
grep -E "DocViewerTest: (회전 뒤|뒤로 가기 시험|PDF 주석|마지막 쪽|menu-pdf|menu-print|인쇄 창)" "$out/logcat.txt" | sed -E 's/.*DocViewerTest: //' | cut -c1-300 || true
echo "----- 오류 로그 -----"
grep -E "request failed|render process gone" "$out/logcat.txt" | tail -20 || true
# 웹 화면의 콘솔 오류(엔진 오류·작업 스레드 실패 등)도 남긴다. 실패한 줄의 원인을 CI 로그만으로 찾을 수 있게.
grep -E "DocViewer: console: " "$out/logcat.txt" | grep -iE "error|오류|실패|fail" | cut -c1-300 | tail -30 || true
# 앱이 죽은 경우 어느 프로세스·어느 코드인지 알 수 있게 AndroidRuntime 블록을 통째로 남긴다(Process: 줄 포함).
grep -E -A12 "AndroidRuntime: FATAL EXCEPTION" "$out/logcat.txt" | cut -c1-240 | tail -80 || true
# 자바 예외 없이 앱 프로세스가 사라진 경우(계측이 "Process crashed"로 끊김): 시스템이 죽였는지(메모리·응답 없음),
# 네이티브 충돌(Fatal signal)인지 남긴다. CI #29 안드로이드 14에서 첫 시험 중 이렇게 끊겼는데 원인이 로그에 없었다.
echo "----- 앱 프로세스 종료 -----"
adb logcat -d -b events | grep -E "am_(kill|proc_died|crash)" | grep -i "docviewer" | tail -10 || true
adb logcat -d | grep -E "Fatal signal|has died|lowmemorykiller|Killing [0-9]+:io\.github\.squeecho" | grep -iE "docviewer|Fatal signal|lowmemorykiller" | cut -c1-240 | tail -15 || true
# 응답 없음(ANR): 어느 스레드가 무엇을 하다 막혔는지 남긴다(CI 산출물을 못 받는 경우에도 로그만으로 보이게).
echo "----- 응답 없음(ANR) -----"
adb logcat -d -b events | grep -E "am_anr" | tail -5 || true
adb logcat -d | grep -E "ANR in|Input dispatching timed out|Reason: " | tail -10 || true
adb root >/dev/null 2>&1 && timeout 30 adb wait-for-device && sleep 2
if adb shell ls /data/anr >/dev/null 2>&1; then
  adb pull /data/anr "$out/anr" >/dev/null 2>&1 || true
  for f in "$out"/anr/*; do
    [ -f "$f" ] || continue
    echo "== $(basename "$f")"
    grep -A25 '^"main"' "$f" | head -30 || true
  done
fi
# 실패한 시험의 메시지(계측이 중간에 끊겨 Gradle 출력에 안 나오는 경우)
find app/build/outputs/androidTest-results -name '*.xml' -exec grep -h -o '<failure[^>]*message="[^"]*"' {} + 2>/dev/null | cut -c1-600 | head -10 || true
adb pull /sdcard/Android/data/com.squeecho.docviewer/files/screens "$out/" || true
cp -r app/build/reports/androidTests "$out/test-report" 2>/dev/null || true
exit $status
