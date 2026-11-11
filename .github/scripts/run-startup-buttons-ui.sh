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
"$HOME/.maestro/bin/maestro" test .maestro/startup-buttons.yaml \
  --debug-output ui-screenshots/startup-buttons-debug
