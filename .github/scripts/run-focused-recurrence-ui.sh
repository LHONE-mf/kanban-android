#!/usr/bin/env bash
# Focused Android UI coverage: one real weekly recurrence and cross-board UI search.
# Retry a failure only when the Android launcher (not Kanban) has an ANR dialog.
set -euo pipefail
mkdir -p ui-screenshots
adb install -r app/build/outputs/apk/debug/app-debug.apk

run_flow() {
local flow="$1"
if "$HOME/.maestro/bin/maestro" test "$flow" --debug-output ui-screenshots/$(basename "$flow" .yaml)-debug; then
  return 0
fi

# Quickstep ANRs are a known Android emulator/launcher problem. Do not retry
# actual UI assertions or silently skip any failing step.
if ! adb shell uiautomator dump /sdcard/ci-quickstep-anr.xml >/dev/null 2>&1; then return 1; fi
if ! adb pull /sdcard/ci-quickstep-anr.xml ui-screenshots/quickstep-anr.xml >/dev/null 2>&1; then return 1; fi
if ! coords="$(python3 tools/ci_launcher_anr.py ui-screenshots/quickstep-anr.xml)"; then
  echo "::error::Focused UI test failed; no verified Quickstep launcher ANR to dismiss"
  return 1
fi
read -r x y <<< "$coords"
echo "::warning::Quickstep system ANR obscured focused UI test; dismissing and retrying once"
adb exec-out screencap -p > ui-screenshots/quickstep-anr.png || true
adb shell input tap "$x" "$y"
sleep 3
"$HOME/.maestro/bin/maestro" test "$flow" --debug-output ui-screenshots/$(basename "$flow" .yaml)-retry

}

run_flow .maestro/recurring-search.yaml
python3 tools/create_search_pagination_fixture.py "$RUNNER_TEMP/kanban-pagination-ci.json"
adb push "$RUNNER_TEMP/kanban-pagination-ci.json" /sdcard/Download/kanban-pagination-ci.json
run_flow .maestro/search-pagination.yaml
