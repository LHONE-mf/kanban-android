"""Fast, dependency-free regression tests for the WebView bundle and Android project."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "tools" / "build_kanban_js.py"
spec = importlib.util.spec_from_file_location("build_kanban_js", BUILDER)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BundleTests(unittest.TestCase):
    def test_bundle_is_up_to_date(self):
        expected = "".join(
            (build.SOURCE / part).read_text(encoding="utf-8")
            for part in build.PARTS
        )
        self.assertEqual(build.OUTPUT.read_text(encoding="utf-8"), expected)

    def test_check_rejects_stale_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source"
            source.mkdir()
            for part in build.PARTS:
                (source / part).write_text("/* " + part + " */\n", encoding="utf-8")
            output = Path(folder) / "kanban.js"
            output.write_text("outdated", encoding="utf-8")
            original_source, original_output, original_argv = build.SOURCE, build.OUTPUT, sys.argv
            try:
                build.SOURCE, build.OUTPUT = source, output
                sys.argv = ["build_kanban_js.py", "--check"]
                self.assertEqual(build.main(), 1)
                sys.argv = ["build_kanban_js.py"]
                self.assertEqual(build.main(), 0)
                sys.argv = ["build_kanban_js.py", "--check"]
                self.assertEqual(build.main(), 0)
            finally:
                build.SOURCE, build.OUTPUT, sys.argv = original_source, original_output, original_argv


class AndroidProjectTests(unittest.TestCase):
    def test_manifest_is_well_formed_and_has_activity(self):
        manifest = ET.parse(ROOT / "app/src/main/AndroidManifest.xml").getroot()
        self.assertEqual(manifest.tag, "manifest")
        ns = "{http://schemas.android.com/apk/res/android}"
        activities = manifest.findall(".//activity")
        self.assertTrue(any(a.get(ns + "name", "").endswith("MainActivity") for a in activities))
        self.assertTrue(any(a.get(ns + "name", "").endswith("NearbyActivity") for a in activities))

    def test_fileprovider_paths_are_restricted(self):
        paths = ET.parse(ROOT / "app/src/main/res/xml/editable_file_paths.xml").getroot()
        self.assertEqual(paths.tag, "paths")
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0].tag, "cache-path")
        self.assertEqual(paths[0].attrib.get("path"), "editable/")


if __name__ == "__main__":
    unittest.main()
