#!/usr/bin/env python3
"""Create a disposable Android emulator import fixture with a real stored file.

Based on the SAF-exported JSON that was verified earlier in CI. The original
backup is never modified, and this fixture is never used on a real device.
"""
import base64
import json
import sys
from pathlib import Path


def make_fixture(source: Path, destination: Path) -> None:
    backup = json.loads(source.read_text(encoding="utf-8"))
    tasks = backup["tasks"]
    target = next(t for t in tasks if t.get("title") == "Beta persistence smoke task")
    text = "Kanban Android attachment viewer regression.\nСтрока あ\n".encode("utf-8")
    media_id = "ci_android_attachment_view_test"
    target.setdefault("files", []).append({
        "id": media_id, "name": "kanban-view-test.txt",
        "type": "text/plain", "size": len(text)
    })
    backup["media"][media_id] = {
        "type": "text/plain", "thumb": None,
        "data": "data:text/plain;base64," + base64.b64encode(text).decode("ascii")
    }
    destination.write_text(json.dumps(backup, ensure_ascii=False), encoding="utf-8")
    print(f"Generated Android viewer fixture: {len(text)}-byte text attachment")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: create_android_attachment_fixture.py input.json output.json")
    make_fixture(Path(sys.argv[1]), Path(sys.argv[2]))
