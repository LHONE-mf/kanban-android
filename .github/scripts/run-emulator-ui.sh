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
    echo "Smoke, Japanese restart/upgrade, Kanban persistence, SAF save/restore, and native attachment viewer all completed." >> "$GITHUB_STEP_SUMMARY"
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
  # Maestro 2.x occasionally loses its driver transport before the first
  # command (DeviceServerDiedException during deviceInfo). At that point no
  # app interactions have occurred, so restarting this flow once is safe.
  # Never retry real UI assertion failures or a crash mid-flow.
  if grep -R -Fq --include='maestro.log' "Device server died during 'deviceInfo'" "$debug" 2>/dev/null; then
    echo "::warning::Maestro driver died during startup of $flow; retrying once"
    adb wait-for-device
    sleep 2
    "$HOME/.maestro/bin/maestro" test "$flow" --debug-output "${debug}-driver-retry"
    return $?
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
stage="prepare disposable Android attachment fixture"
python3 tools/create_android_attachment_fixture.py \
  "$RUNNER_TEMP/kanban-saf-export.json" "$RUNNER_TEMP/kanban-attachment-ci.json"
adb push "$RUNNER_TEMP/kanban-attachment-ci.json" /sdcard/Download/kanban-attachment-ci.json
stage="open stored attachment in native Android viewer"
# Clear pre-existing logs so the native intent assertion belongs to this flow.
adb logcat -c
run_maestro .maestro/android-attachment-open.yaml ui-screenshots/android-attachment-open-debug
stage="verify native ACTION_VIEW intent was dispatched"
adb logcat -d -s KanbanAttachmentOpen:I '*:S' > ui-screenshots/attachment-open-intent-log.txt
grep -Fq 'ACTION_VIEW chooser dispatched' ui-screenshots/attachment-open-intent-log.txt
echo 'Native ACTION_VIEW intent dispatched successfully.' >> "$GITHUB_STEP_SUMMARY"

# ACTION_VIEW can leave the system resolver or an external viewer in front.
# Maestro stopApp only stops our package; it cannot dismiss another app.
# Return to the home screen, then explicitly foreground Kanban before the
# next Save As flow. This preserves all IndexedDB data on the CI emulator.
stage="return from external attachment viewer to Kanban"
# The API 35 emulator resolves text/plain to com.android.htmlviewer, which
# can remain above our activity even after a HOME + am start cycle. Only in
# this disposable CI emulator, close that external viewer after verifying
# ACTION_VIEW was dispatched. Never clear Kanban data or uninstall the APK.
adb shell am force-stop com.android.htmlviewer
adb shell input keyevent KEYCODE_HOME
adb shell am start -W -n com.kanban.offline/.MainActivity > ui-screenshots/attachment-return-to-kanban.txt
adb shell dumpsys activity activities > ui-screenshots/attachment-return-activity.txt
grep -q 'topResumedActivity=.*com.kanban.offline/.MainActivity' ui-screenshots/attachment-return-activity.txt

# Now export a backup containing a real imported attachment, not just empty
# media. All destructive reset steps below apply ONLY to the CI emulator.
stage="export backup with attachment payload"
adb shell rm -f "$SAVED_BACKUP_PATH"
run_maestro .maestro/android-backup-save.yaml ui-screenshots/android-backup-media-save-debug
stage="verify backup contains the original attachment bytes"
MEDIA_BACKUP_PATH="$(adb shell "find /sdcard/Download -maxdepth 1 -type f -name 'kanban-backup-????-??-??.json' -print" | tr -d '\r' | head -n 1)"
test -n "$MEDIA_BACKUP_PATH"
adb pull "$MEDIA_BACKUP_PATH" "$RUNNER_TEMP/kanban-media-export.json"
python3 tools/verify_android_backup.py "$RUNNER_TEMP/kanban-media-export.json" \
  --expect-title "Beta upgrade persistence task" \
  --expect-title "Beta persistence smoke task" \
  --expect-media "ci_android_attachment_view_test" \
  --expect-media-text "$(python3 -c 'print("Kanban Android attachment viewer regression.\\nСтрока あ\\n", end="")')"
stage="restore media-containing backup on disposable emulator"
adb shell pm clear com.kanban.offline | grep -q 'Success'
run_maestro .maestro/android-backup-restore.yaml ui-screenshots/android-backup-media-restore-debug
stage="verify restored task retains its file attachment"
run_maestro .maestro/android-attachment-restored.yaml ui-screenshots/android-attachment-restored-debug
