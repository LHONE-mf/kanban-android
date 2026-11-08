#!/usr/bin/env bash
# Run the full Android emulator regression in one shell. Maestro flows must share
# the same failure trap and stage tracking across all commands.
set -euo pipefail
mkdir -p ui-screenshots
stage="emulator setup"
capture_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::error::Android UI regression failed (exit $status) during: $stage"
    echo "### Android UI regression failed: $stage" >> "$GITHUB_STEP_SUMMARY"
    printf "Failed stage: %s\\nExit code: %s\\n" "$stage" "$status" > ui-screenshots/failure-stage.txt
    echo "Check the android-ui-screenshots artifact for Maestro diagnostics, screenshot, package info, and logcat." >> "$GITHUB_STEP_SUMMARY"
    adb exec-out screencap -p > ui-screenshots/emulator-on-failure.png || true
    adb logcat -d -t 1500 > ui-screenshots/emulator-logcat-on-failure.txt || true
    adb shell dumpsys package com.kanban.offline > ui-screenshots/package-on-failure.txt || true
    adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
    adb pull /sdcard/window.xml ui-screenshots/window-on-failure.xml >/dev/null 2>&1 || true
  else
    echo "### Android UI regression passed" >> "$GITHUB_STEP_SUMMARY"
    echo "Smoke, Japanese restart, Kanban v1 creation, Japanese v2 upgrade, and Kanban persistence flows completed." >> "$GITHUB_STEP_SUMMARY"
  fi
}
trap capture_failure EXIT
stage="install APK v1"
adb install -r ui-apks/kanban-v1.apk
stage="navigation smoke"
"$HOME/.maestro/bin/maestro" test .maestro/smoke.yaml --debug-output ui-screenshots/maestro-debug
stage="Japanese restart persistence"
"$HOME/.maestro/bin/maestro" test .maestro/japanese-progress.yaml --debug-output ui-screenshots/japanese-progress-debug
stage="Kanban task creation on v1"
"$HOME/.maestro/bin/maestro" test .maestro/kanban-before-upgrade.yaml --debug-output ui-screenshots/kanban-before-upgrade-debug
stage="upgrade to APK v2"
adb install -r ui-apks/kanban-v2.apk
stage="verify installed APK version and app data"
adb shell pm path com.kanban.offline | grep -q '^package:'
adb shell dumpsys package com.kanban.offline > ui-screenshots/package-after-upgrade.txt
grep -q 'versionCode=2' ui-screenshots/package-after-upgrade.txt
stage="Japanese progress after upgrade"
"$HOME/.maestro/bin/maestro" test .maestro/japanese-upgrade.yaml --debug-output ui-screenshots/japanese-upgrade-debug
stage="Kanban persistence after upgrade"
"$HOME/.maestro/bin/maestro" test .maestro/kanban-persistence.yaml --debug-output ui-screenshots/kanban-persistence-debug
adb exec-out screencap -p > ui-screenshots/kanban-after-removal.png
test -s ui-screenshots/kanban-after-removal.png
