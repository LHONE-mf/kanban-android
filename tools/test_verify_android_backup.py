#!/usr/bin/env python3
"""Regression tests for SAF attachment byte verification."""
import base64
import json
import tempfile
import unittest
from pathlib import Path
from verify_android_backup import verify

TEXT = "Kanban Android attachment viewer regression.\nСтрока あ\n"
class IntegrityTests(unittest.TestCase):
    def test_exact_bytes_and_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "backup.json"
            data = {
                "version": 4, "app": "kanban-mindmap",
                "exportedAt": "2026-11-09T00:00:00Z",
                "activeBoardId": "b", "boards": [{"id": "b"}],
                "tasks": [{"id": "t", "boardId": "b", "title": "Task",
                           "files": [{"id": "m"}]}],
                "media": {}
            }
            def write(payload):
                data["media"]["m"] = {
                    "data": "data:text/plain;base64," +
                    base64.b64encode(payload).decode("ascii")}
                path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            write(TEXT.encode("utf-8"))
            verify(path, ["Task"], ["m"], TEXT.replace("\n", "\\n"))
            write(TEXT.replace("あ", "?").encode("utf-8"))
            with self.assertRaisesRegex(AssertionError, "Attachment bytes changed"):
                verify(path, ["Task"], ["m"], TEXT.replace("\n", "\\n"))

if __name__ == "__main__":
    unittest.main()
