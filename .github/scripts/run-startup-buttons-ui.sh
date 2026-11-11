#!/usr/bin/env bash
# Fast Android startup regression. Fail on a real broken button; never
# treat screen visibility alone as proof that the app initialized.
set -euo pipefail
mkdir -p ui-screenshots
capture_failure() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "::error::Startup button smoke failed (exit $status)"
    adb exec-out screencap -p > ui-screenshots/startup-failure.png || true
    adb logcat -d -t 900 > ui-screenshots/startup-failure-logcat.txt || true
  fi
}
trap capture_failure EXIT
adb install -r app/build/outputs/apk/debug/app-debug.apk
if "$HOME/.maestro/bin/maestro" test .maestro/startup-buttons.yaml \
  --debug-output ui-screenshots/startup-buttons-debug; then
  exit 0
fi

# Retry only when the Android *launcher* is visibly unresponsive. Never retry
# a regular Kanban assertion failure, or a crash, as that could hide a regression.
if ! adb shell uiautomator dump /sdcard/ci-quickstep-anr.xml >/dev/null 2>&1; then exit 1; fi
if ! adb pull /sdcard/ci-quickstep-anr.xml ui-screenshots/quickstep-anr.xml >/dev/null 2>&1; then exit 1; fi
if ! coords="$(python3 tools/ci_launcher_anr.py ui-screenshots/quickstep-anr.xml)"; then
  echo "::error::Startup UI failed without a verified Quickstep launcher ANR"
  exit 1
fi
read -r x y <<< "$coords"
echo "::warning::Verified Quickstep ANR obscured startup UI; dismissing the system dialog and retrying once"
adb exec-out screencap -p > ui-screenshots/quickstep-anr.png || true
adb shell input tap "$x" "$y"
sleep 3
"$HOME/.maestro/bin/maestro" test .maestro/startup-buttons.yaml \
  --debug-output ui-screenshots/startup-buttons-retry
