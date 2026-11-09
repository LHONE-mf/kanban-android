#!/usr/bin/env python3
"""Regression tests for SAF attachment byte verification."""
import base64
import binascii
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

            # A syntactically valid JSON export must still reject corrupted media.
            data["media"]["m"]["data"] = "data:text/plain;base64,%%%invalid"
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises((ValueError, binascii.Error)):
                verify(path, ["Task"], ["m"])

            # A payload without a task referencing it is not a restorable attachment.
            write(TEXT.encode("utf-8"))
            data["tasks"][0]["files"] = []
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "has no owning task"):
                verify(path, ["Task"], ["m"])

            # Missing media must be detected rather than silently ignored.
            data["media"].clear()
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "Expected attachment missing"):
                verify(path, ["Task"], ["m"])


    def test_binary_attachment_exact_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "backup.json"
            payload = bytes([0, 255, 128, 10, 13, 0, 42])
            backup = {
                "version": 4, "app": "kanban-mindmap",
                "exportedAt": "2026-11-09T00:00:00Z",
                "activeBoardId": "b", "boards": [{"id": "b"}],
                "tasks": [{"id": "t", "boardId": "b", "title": "Task",
                           "files": [{"id": "binary"}]}],
                "media": {"binary": {"data": "data:application/octet-stream;base64,"
                           + base64.b64encode(payload).decode("ascii")}}
            }
            path.write_text(json.dumps(backup), encoding="utf-8")
            verify(path, ["Task"], ["binary"], expected_media_hex=payload.hex())
            with self.assertRaisesRegex(AssertionError, "Attachment bytes changed"):
                verify(path, ["Task"], ["binary"], expected_media_hex="00ff800a0d002b")
            # The binary check must reject a conflicting text expectation.
            with self.assertRaisesRegex(AssertionError, "Choose either text or hexadecimal"):
                verify(path, ["Task"], ["binary"],
                       expected_media_text="text", expected_media_hex=payload.hex())

            # A second attachment ID makes a single-payload assertion ambiguous.
            with self.assertRaisesRegex(AssertionError, "requires one expected media ID"):
                verify(path, ["Task"], ["binary", "binary"],
                       expected_media_hex=payload.hex())



if __name__ == "__main__":
    unittest.main()
