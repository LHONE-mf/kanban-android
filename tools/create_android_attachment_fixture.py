#!/usr/bin/env python3
"""Create a disposable Android emulator import fixture with a real stored file.

Based on the SAF-exported JSON that was verified earlier in CI. The original
backup is never modified, and this fixture is never used on a real device.
"""
import base64
import json
import struct
import sys
import zlib
from pathlib import Path

def small_png(red: int, green: int, blue: int) -> bytes:
    """A genuine 48x48 PNG for disposable offline gallery/zoom tests."""
    size = 48
    raw = b"".join(b"\x00" + bytes((red, green, blue)) * size for _ in range(size))

    def chunk(name: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + name + payload
                + struct.pack(">I", zlib.crc32(name + payload) & 0xffffffff))

    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


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
    for suffix, rgb in (("a", (36, 110, 220)), ("b", (220, 110, 36))):
        image = small_png(*rgb)
        image_id = "ci_android_zoom_" + suffix
        image_name = "kanban-zoom-" + suffix + ".png"
        data_url = "data:image/png;base64," + base64.b64encode(image).decode("ascii")
        target["files"].append({
            "id": image_id, "name": image_name,
            "type": "image/png", "size": len(image)
        })
        backup["media"][image_id] = {
            "type": "image/png", "thumb": data_url, "data": data_url
        }
    destination.write_text(json.dumps(backup, ensure_ascii=False), encoding="utf-8")
    print(f"Generated Android viewer fixture: {len(text)}-byte text attachment")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: create_android_attachment_fixture.py input.json output.json")
    make_fixture(Path(sys.argv[1]), Path(sys.argv[2]))
