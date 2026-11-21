#!/usr/bin/env python3
"""One end-to-end offline data-retention smoke test, using debug WebView CDP.

This is only run on a disposable GitHub Actions Android emulator. No existing
user phone or application installation is modified.
"""
import json
import re
import subprocess
import sys
import time
import urllib.request

import websocket

PACKAGE = "com.kanban.offline"
PORT = 9222
BASE = "https://appassets.androidplatform.net/assets/kanban.html"
NATIVE_XML = """<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <int name="question_count" value="17" />
  <int name="correct_count" value="14" />
  <int name="current_question" value="4" />
  <int name="next_question" value="5" />
  <boolean name="katakana_unlocked" value="true" />
  <string name="review_queue">1,3</string>
</map>
"""
SEED_JS = r"""(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('kanban_db_v2');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const store of ['tasks', 'settings', 'media']) {
    if (!db.objectStoreNames.contains(store)) throw Error('Missing IDB store: ' + store);
  }
  const board = {
    id: 'p9-board', name: 'P9 upgrade marker',
    columns: [{id: 'col_todo', title: 'To Do', color: '#aaaaaa',
      isDone: false, wipLimit: 0}]
  };
  const task = {
    id: 'p9-task', boardId: board.id, columnId: 'col_todo',
    title: 'P9 KEEP ORIGINAL TASK', description: 'Keep across upgrade',
    files: [{id: 'p9-media', name: 'marker.txt', type: 'text/plain', size: 16}],
    parentId: '', order: 0, tags: [], checklist: [], priority: 'none'
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['tasks', 'settings', 'media'], 'readwrite');
    tx.objectStore('tasks').put(task);
    tx.objectStore('settings').put({key: 'boards', value: [board]});
    tx.objectStore('settings').put({key: 'activeBoardId', value: board.id});
    tx.objectStore('settings').put({key: 'comrade_day_plan_v1',
      value: {date: '2026-11-21', ids: [task.id], updatedAt: 17}});
    tx.objectStore('media').put({
      full: new Blob(['P9 ORIGINAL MEDIA'], {type: 'text/plain'}),
      thumb: null, type: 'text/plain'
    }, 'p9-media');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || Error('IDB aborted'));
  });
  localStorage.setItem('kanban-japanese-hiragana-v1', JSON.stringify(['あ']));
  localStorage.setItem('kanban-japanese-script-v1', 'katakana');
  db.close();
  return 'seeded';
})()"""

READ_JS = r"""(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('kanban_db_v2');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const read = (store, key) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const [task, board, activeBoard, dayPlan, media] = await Promise.all([
    read('tasks', 'p9-task'), read('settings', 'boards'),
    read('settings', 'activeBoardId'),
    read('settings', 'comrade_day_plan_v1'),
    read('media', 'p9-media')
  ]);
  const value = {
    task: task && task.title,
    attachmentId: task && task.files && task.files[0] && task.files[0].id,
    board: board && board.value && board.value[0] && board.value[0].name,
    activeBoard: activeBoard && activeBoard.value,
    dayTask: dayPlan && dayPlan.value && dayPlan.value.ids[0],
    media: media && media.full && await media.full.text(),
    japanese: localStorage.getItem('kanban-japanese-hiragana-v1'),
    japaneseScript: localStorage.getItem('kanban-japanese-script-v1')
  };
  db.close();
  return value;
})()"""


def run(*args, input_text=None, check=True):
    command = list(args)
    result = subprocess.run(command, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=90)
    if check and result.returncode:
        raise RuntimeError(f"{' '.join(command)} failed: {result.stdout}")
    return result.stdout.strip()


def adb(*args, **kwargs):
    return run("adb", *args, **kwargs)


def eval_page(expression):
    deadline = time.monotonic() + 65
    last = "WebView not ready"
    while time.monotonic() < deadline:
        try:
            pid = adb("shell", "pidof", PACKAGE).split()[0]
            sockets = adb("shell", "cat", "/proc/net/unix")
            socket = f"webview_devtools_remote_{pid}"
            if socket not in sockets:
                raise RuntimeError("WebView debug socket not yet registered")
            adb("forward", "--remove", f"tcp:{PORT}", check=False)
            adb("forward", f"tcp:{PORT}", f"localabstract:{socket}")
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=5) as response:
                pages = json.load(response)
            page = next((p for p in pages if p.get("type") == "page"
                         and p.get("url", "").startswith(BASE)), None)
            if not page:
                raise RuntimeError("Comrade Kanban page not yet loaded")
            url = page["webSocketDebuggerUrl"]
            url = re.sub(r"^ws://[^/]+/", f"ws://127.0.0.1:{PORT}/", url)
            connection = websocket.create_connection(
                url, timeout=25, suppress_origin=True
            )
            try:
                connection.send(json.dumps({
                    "id": 1, "method": "Runtime.evaluate",
                    "params": {
                        "expression": expression,
                        "awaitPromise": True, "returnByValue": True
                    }
                }))
                for _ in range(100):
                    msg = json.loads(connection.recv())
                    if msg.get("id") != 1:
                        continue
                    if "error" in msg:
                        raise RuntimeError(str(msg["error"]))
                    result = msg["result"]
                    if "exceptionDetails" in result:
                        raise RuntimeError(str(result["exceptionDetails"]))
                    if "value" not in result.get("result", {}):
                        raise RuntimeError("CDP script returned no value")
                    return result["result"]["value"]
                raise RuntimeError("No Runtime.evaluate response")
            finally:
                connection.close()
        except (OSError, ValueError, RuntimeError, KeyError, IndexError,
                websocket.WebSocketException) as exc:
            last = str(exc)
            time.sleep(2)
    raise RuntimeError(f"Cannot evaluate Comrade WebView: {last}")


def installed_version():
    data = adb("shell", "dumpsys", "package", PACKAGE)
    match = re.search(r"versionCode=(\d+)", data)
    if not match:
        raise RuntimeError("Comrade package/versionCode not installed")
    return int(match.group(1))


def check_values(actual):
    expected = {
        "task": "P9 KEEP ORIGINAL TASK",
        "attachmentId": "p9-media",
        "board": "P9 upgrade marker",
        "activeBoard": "p9-board",
        "dayTask": "p9-task",
        "media": "P9 ORIGINAL MEDIA",
        "japanese": '["あ"]',
        "japaneseScript": "katakana"
    }
    for key, value in expected.items():
        if actual.get(key) != value:
            raise AssertionError(
                f"Lost {key} across upgrade: expected {value!r}, got {actual.get(key)!r}"
            )


def check_native():
    xml = adb("shell", f"run-as {PACKAGE} cat shared_prefs/japanese_daily.xml")
    for token in (
        'name="question_count" value="17"',
        'name="correct_count" value="14"',
        'name="katakana_unlocked" value="true"',
        'name="review_queue">1,3</string>'
    ):
        if token not in xml:
            raise AssertionError("Native Japanese progress not preserved: " + token)


def launch():
    adb("shell", "am", "start", "-n", f"{PACKAGE}/.MainActivity")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: ci_android_upgrade_smoke.py baseline.apk updated.apk")
    old_apk, new_apk = sys.argv[1:]
    print("1. Install baseline and launch offline app", flush=True)
    adb("install", "-r", old_apk)
    old_version = installed_version()
    launch()
    assert eval_page(SEED_JS) == "seeded"
    check_values(eval_page(READ_JS))
    adb("shell", "am", "force-stop", PACKAGE)
    run("adb", "shell",
        f"run-as {PACKAGE} sh -c 'mkdir -p shared_prefs && cat > shared_prefs/japanese_daily.xml'",
        input_text=NATIVE_XML)
    check_native()
    print("2. In-place update without uninstall, clear-data or data reset", flush=True)
    adb("install", "-r", new_apk)
    new_version = installed_version()
    if new_version <= old_version:
        raise AssertionError(f"versionCode did not increase: {old_version} -> {new_version}")
    launch()
    check_values(eval_page(READ_JS))
    check_native()
    adb("shell", "am", "force-stop", PACKAGE)
    launch()
    check_values(eval_page(READ_JS))
    check_native()
    print("PASS: boards, task, attachment bytes, day plan, both Japanese stores "
          f"survived in-place update ({old_version} -> {new_version}) and relaunch.",
          flush=True)


if __name__ == "__main__":
    main()
