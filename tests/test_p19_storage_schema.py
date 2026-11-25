import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile

from tools import verify_p19_storage as storage


class P19StorageTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "fixture.zip"
        self.target = self.root / "sqlite"
        self.staging = self.root / "sqlite.staging"

    def make_archive(self, *, result="returned", corrupt=False, extra=None):
        def task(task_id, parent, attachment):
            return {
                "id": task_id, "boardId": "home", "columnId": "progress",
                "parentId": parent, "order": 1, "createdAt": 1234, "updatedAt": 2345,
                "checklist": [{"id": "item", "text": "Check", "checked": True}],
                "results": [{"id": "returned", "text": "", "createdAt": 789, "updatedAt": 891}],
                "files": [attachment],
            }
        content = b"recorded result"
        state = {
            "version": 1,
            "activeBoardId": "home",
            "boards": [{"id": "home", "columns": [{"id": "progress", "isDone": False}]}],
            "tasks": [task("child", "root", {"id": "shared", "resultId": result}),
                      task("root", "", {"id": "original"})],
            "media": [
                {"id": "original", "path": "media/000000.bin", "mime": "audio/mp4", "size": len(content)},
                {"id": "shared", "path": "media/000001.bin", "mime": "audio/mp4", "size": len(content)},
            ],
            "web": {"kanban_theme": "dark"},
            "nativeJapanese": None,
            "pomo": {"sessions": 4},
            "settings": {"comrade_day_plan_v1": {"ids": ["child"], "date": "2026-12-05"}},
        }
        files = {
            "state.json": json.dumps(state).encode(),
            "media/000000.bin": content,
            "media/000001.bin": content,
        }
        if extra:
            files[extra] = b"unused"
        manifest = {
            "format": "comrade-backup", "version": 1,
            "entries": [{"path": name, "size": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                        for name, value in files.items()],
        }
        if corrupt:
            manifest["entries"][1]["sha256"] = "0" * 64
        with ZipFile(self.source, "w") as archive:
            for name, value in files.items():
                archive.writestr(name, value)
            archive.writestr("manifest.json", json.dumps(manifest))

    def test_resume_and_deduplicate_without_merging_media_ids(self):
        self.make_archive()
        original_source = storage.sha256_file(self.source)
        save_blob = storage.copy_verified_blob

        def interruption(*args):
            save_blob(*args)
            raise OSError("disk full after publishing a staging file")

        with mock.patch.object(storage, "copy_verified_blob", side_effect=interruption):
            with self.assertRaises(OSError):
                storage.prepare(self.source, self.target)
        self.assertFalse(self.target.exists())
        self.assertEqual(len(list((self.staging / "blobs").iterdir())), 1)
        expected = {"boards": 1, "tasks": 2, "files": 2, "unique_blobs": 1}
        self.assertEqual(storage.prepare(self.source, self.target), expected)
        self.assertEqual(storage.prepare(self.source, self.target), expected)
        self.assertEqual(storage.sha256_file(self.source), original_source)
        with sqlite3.connect(self.target / "snapshot.sqlite") as db:
            self.assertEqual(db.execute("SELECT parent_id FROM tasks WHERE id = 'child'").fetchone(), ("root",))
            self.assertEqual(db.execute("SELECT result_id FROM attachments WHERE task_id = 'child'").fetchone(),
                             ("returned",))
            self.assertEqual(db.execute("SELECT count(*) FROM checklist_items").fetchone(), (2,))
        self.assertFalse(self.staging.exists())

    def test_bad_hash_never_publishes(self):
        self.make_archive(corrupt=True)
        with self.assertRaisesRegex(ValueError, "hash or size"):
            storage.prepare(self.source, self.target)
        self.assertFalse(self.target.exists())

    def test_invalid_result_never_publishes(self):
        self.make_archive(result="missing")
        with self.assertRaises(sqlite3.IntegrityError):
            storage.prepare(self.source, self.target)
        self.assertFalse(self.target.exists())

    def test_zip_cannot_supply_filesystem_path(self):
        self.make_archive(extra="../external")
        with self.assertRaisesRegex(ValueError, "Invalid ZIP member name"):
            storage.prepare(self.source, self.target)
        self.assertFalse((self.root / "external").exists())
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
