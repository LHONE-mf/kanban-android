#!/usr/bin/env bash
set -euo pipefail

APK="app/build/outputs/apk/debug/app-debug.apk"
PACKAGE="com.kanban.offline"
OUT="ui-screenshots"
mkdir -p "$OUT"
adb wait-for-device
adb install -r "$APK"

capture() {
  local name="$1"
  sleep 3
  adb shell screencap -p "/sdcard/${name}.png"
  adb pull "/sdcard/${name}.png" "$OUT/${name}.png"
  adb shell uiautomator dump "/sdcard/${name}.xml" >/dev/null || true
  adb pull "/sdcard/${name}.xml" "$OUT/${name}.xml" || true
}

# First-launch Kanban: permissions and onboarding may differ on real devices.
adb shell am start -W -n "$PACKAGE/.MainActivity"
sleep 6
capture kanban-initial

# Explicit theme extras make these screenshots deterministic without
# depending on the WebView's previously stored preferences.
adb shell am force-stop "$PACKAGE"
adb shell am start -W -n "$PACKAGE/.NearbyActivity" --ez dark_theme false
capture bluetooth-light

adb shell am force-stop "$PACKAGE"
adb shell am start -W -n "$PACKAGE/.NearbyActivity" --ez dark_theme true
capture bluetooth-dark

echo "Captured screenshots to $OUT/"
