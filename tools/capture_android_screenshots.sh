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
  adb exec-out screencap -p > "$OUT/${name}.png"
  adb shell uiautomator dump "/data/local/tmp/${name}.xml" >/dev/null || true
  adb pull "/data/local/tmp/${name}.xml" "$OUT/${name}.xml" || true
}

# First-launch Kanban: permissions and onboarding may differ on real devices.
adb shell am start -W -n "$PACKAGE/.MainActivity"
sleep 6
capture kanban-initial

# Navigate via the app's learning button to capture both main screens.
tap_label() {
  local label="$1"
  adb shell uiautomator dump /data/local/tmp/window.xml >/dev/null
  adb pull /data/local/tmp/window.xml "$OUT/window.xml" >/dev/null
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

tap_label "日本語 · Учить"
capture japanese-light

# Return to Kanban and toggle its theme through the actual UI.
tap_label "← Канбан"
capture kanban-return
tap_label "◐"
capture kanban-dark

echo "Captured screenshots to $OUT/"
