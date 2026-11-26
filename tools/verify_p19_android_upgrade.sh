#!/usr/bin/env bash
# Run only on a fresh emulator. These two APKs are already verified by Android APK CI.
set -euo pipefail

baseline=$1
candidate=$2
serial=${ANDROID_SERIAL:-emulator-5554}
[[ $serial =~ ^emulator-[0-9]+$ ]]
device=(adb -s "$serial")
if "${device[@]}" shell pm path com.kanban.offline | grep -q '^package:'; then
    echo 'Use a fresh emulator. Comrade is already installed.' >&2
    exit 1
fi
work=$(mktemp -d)
trap '"${device[@]}" forward --remove tcp:9221 >/dev/null 2>&1 || true' EXIT

connect_kanban() {
    "${device[@]}" shell wm dismiss-keyguard
    "${device[@]}" shell am start -W -n com.kanban.offline/.MainActivity
    for ((attempt = 0; attempt < 40; attempt++)); do
        pid=$("${device[@]}" shell pidof com.kanban.offline | tr -d '\r' | cut -d' ' -f1) || true
        if [[ $pid =~ ^[0-9]+$ ]]; then
            "${device[@]}" forward tcp:9221 "localabstract:webview_devtools_remote_$pid"
            if curl -fsS --max-time 2 http://127.0.0.1:9221/json 2>/dev/null | grep -q 'assets/kanban.html'; then
                return
            fi
        fi
        sleep 2
    done
    echo 'Kanban WebView did not become available.' >&2
    return 1
}

"${device[@]}" install "$baseline"
connect_kanban
node tools/p19_android_fixture.mjs seed
node tools/p19_android_fixture.mjs snapshot "$work/before.json"
"${device[@]}" install -r "$candidate"
connect_kanban
node tools/p19_android_fixture.mjs snapshot "$work/after.json"
cmp "$work/before.json" "$work/after.json"
echo 'In-place update preserved tasks, result journal, checklist, day plan, Japanese progress, and exact media bytes.'
node tools/p19_android_fixture.mjs smoke
