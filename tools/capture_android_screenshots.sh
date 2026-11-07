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

# Open the non-exported chat via its real in-app button.
# Android intentionally prevents shell from launching non-exported activities directly.
tap_label() {
  local label="$1"
  adb shell uiautomator dump /sdcard/window.xml >/dev/null
  adb pull /sdcard/window.xml "$OUT/window.xml" >/dev/null
  local coords
  coords=$(python3 - "$OUT/window.xml" "$label" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
label = sys.argv[2]
for node in root.iter("node"):
    if label in (node.get("text", "") + " " + node.get("content-desc", "")):
        bounds = re.findall(r"\d+", node.get("bounds", ""))
        if len(bounds) == 4:
            x1, y1, x2, y2 = map(int, bounds)
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
PY
)
  if [[ -z "$coords" ]]; then
    echo "Could not find UI control: $label" >&2
    return 1
  fi
  adb shell input tap $coords
}

tap_label "Чат по Bluetooth"
capture bluetooth-light

# Return to Kanban and toggle its theme through the actual UI.
adb shell input keyevent KEYCODE_BACK
sleep 2
tap_label "◐"
sleep 2
capture kanban-dark
tap_label "Чат по Bluetooth"
capture bluetooth-dark

echo "Captured screenshots to $OUT/"
