"""Validate the disposable two-photo Android UI fixture without booting an emulator."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

from tools.create_android_attachment_fixture import make_fixture, small_png


class EmulatorPhotoFixtureTests(unittest.TestCase):
    def test_png_encoding_and_scanlines(self):
        image = small_png(40, 90, 190)
        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        offset = 8
        pixels = None
        while offset < len(image):
            size = struct.unpack(">I", image[offset:offset + 4])[0]
            tag = image[offset + 4:offset + 8]
            data = image[offset + 8:offset + 8 + size]
            checksum = struct.unpack(">I", image[offset + 8 + size:offset + 12 + size])[0]
            self.assertEqual(checksum, zlib.crc32(tag + data) & 0xffffffff)
            if tag == b"IHDR":
                self.assertEqual(struct.unpack(">II", data[:8]), (48, 48))
            if tag == b"IDAT":
                pixels = zlib.decompress(data)
            offset += 12 + size
        self.assertIsNotNone(pixels)
        self.assertEqual(len(pixels), 48 * (1 + 48 * 3))
        self.assertEqual(pixels[:4], b"\x00" + bytes((40, 90, 190)))

    def test_fixture_contains_two_distinct_images_and_original_text(self):
        with tempfile.TemporaryDirectory() as directory:
            src = Path(directory) / "src.json"
            dst = Path(directory) / "out.json"
            src.write_text(json.dumps({
                "tasks": [{"title": "Beta persistence smoke task", "files": []}],
                "media": {}
            }), encoding="utf-8")
            make_fixture(src, dst)
            backup = json.loads(dst.read_text(encoding="utf-8"))
            names = {f["name"] for f in backup["tasks"][0]["files"]}
            self.assertIn("kanban-view-test.txt", names)
            self.assertIn("kanban-zoom-a.png", names)
            self.assertIn("kanban-zoom-b.png", names)
            self.assertNotEqual(backup["media"]["ci_android_zoom_a"]["data"],
                                backup["media"]["ci_android_zoom_b"]["data"])


if __name__ == "__main__":
    unittest.main()
