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
    echo "Smoke, Japanese restart/upgrade, Kanban persistence, SAF cancellation, saved JSON validation, and restoration after app-data reset completed." >> "$GITHUB_STEP_SUMMARY"
  fi
}
trap capture_failure EXIT

# If an Android system Quickstep ANR obscures the app, save the evidence,
# dismiss only that verified system dialog, and retry this flow once.
# Do not retry ordinary Maestro failures or silently skip any assertions.
run_maestro() {
  local flow="$1" debug="$2"
  if "$HOME/.maestro/bin/maestro" test "$flow" --debug-output "$debug"; then
    return 0
  fi
  local dump_path="$debug/quickstep-anr.xml"
  mkdir -p "$debug"
  adb shell uiautomator dump /sdcard/ci-quickstep-anr.xml >/dev/null 2>&1 || return 1
  adb pull /sdcard/ci-quickstep-anr.xml "$dump_path" >/dev/null 2>&1 || return 1
  local coords x y
  coords="$(python3 tools/ci_launcher_anr.py "$dump_path")" || return 1
  read -r x y <<< "$coords"
  echo "::warning::Quickstep system ANR obscured $flow; closing launcher dialog and retrying once"
  adb exec-out screencap -p > "$debug/quickstep-anr.png" || true
  adb shell input tap "$x" "$y"
  sleep 3
  "$HOME/.maestro/bin/maestro" test "$flow" --debug-output "${debug}-retry"
}
stage="install APK v1"
adb install -r ui-apks/kanban-v1.apk
stage="navigation smoke"
run_maestro .maestro/smoke.yaml ui-screenshots/maestro-debug
stage="Japanese restart persistence"
run_maestro .maestro/japanese-progress.yaml ui-screenshots/japanese-progress-debug
stage="Kanban task creation on v1"
run_maestro .maestro/kanban-before-upgrade.yaml ui-screenshots/kanban-before-upgrade-debug
stage="upgrade to APK v2"
adb install -r ui-apks/kanban-v2.apk
stage="verify installed APK version and app data"
adb shell pm path com.kanban.offline | grep -q '^package:'
adb shell dumpsys package com.kanban.offline > ui-screenshots/package-after-upgrade.txt
grep -q 'versionCode=2' ui-screenshots/package-after-upgrade.txt
stage="Japanese progress after upgrade"
run_maestro .maestro/japanese-upgrade.yaml ui-screenshots/japanese-upgrade-debug
stage="Kanban persistence after upgrade"
run_maestro .maestro/kanban-persistence.yaml ui-screenshots/kanban-persistence-debug
adb exec-out screencap -p > ui-screenshots/kanban-after-removal.png
test -s ui-screenshots/kanban-after-removal.png
stage="Android Save As cancellation and retry"
run_maestro .maestro/android-backup-cancel.yaml ui-screenshots/android-backup-cancel-debug
stage="Android Save As backup"
run_maestro .maestro/android-backup-save.yaml ui-screenshots/android-backup-save-debug

# Do not trust the WebView success toast alone. Pull the actual document
# produced by Android's Storage Access Framework and validate its JSON bytes.
stage="verify saved SAF backup bytes"
SAVED_BACKUP_PATH="$(adb shell "find /sdcard/Download -maxdepth 1 -type f -name 'kanban-backup-????-??-??.json' -print" | tr -d '\r' | head -n 1)"
if [[ -z "$SAVED_BACKUP_PATH" ]]; then
  echo "::error::No Kanban JSON backup was created in Android Downloads"
  exit 1
fi
adb pull "$SAVED_BACKUP_PATH" "$RUNNER_TEMP/kanban-saf-export.json"
python3 tools/verify_android_backup.py "$RUNNER_TEMP/kanban-saf-export.json" \
  --expect-title "Beta upgrade persistence task" \
  --expect-title "Beta persistence smoke task"
printf "Verified SAF backup file: %s\n" "$SAVED_BACKUP_PATH" > ui-screenshots/backup-verification.txt

# The remaining steps run exclusively on a disposable CI emulator. Keep
# the exported document in Downloads while clearing the app's internal data,
# then restore through the *real* Android file picker and verify persistence.
stage="clear disposable emulator Kanban app data"
adb shell pm clear com.kanban.offline | grep -q 'Success'
stage="restore SAF backup and verify tasks after restart"
run_maestro .maestro/android-backup-restore.yaml ui-screenshots/android-backup-restore-debug
