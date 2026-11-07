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
        with tempfile.TemporaryDirectory(dir=ROOT) as folder:
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
        self.assertEqual(
            sum(a.get(ns + "name", "").endswith("MainActivity") for a in activities), 1
        )
        self.assertEqual(len(activities), 1)

    def test_unused_wireless_permissions_removed(self):
        manifest = ET.parse(ROOT / "app/src/main/AndroidManifest.xml").getroot()
        ns = "{http://schemas.android.com/apk/res/android}"
        permissions = {
            p.get(ns + "name", "") for p in manifest.findall("uses-permission")
        }
        self.assertEqual(permissions, {"android.permission.RECORD_AUDIO"})
        self.assertFalse(manifest.findall("uses-feature"))

    def test_fileprovider_paths_are_restricted(self):
        paths = ET.parse(ROOT / "app/src/main/res/xml/editable_file_paths.xml").getroot()
        self.assertEqual(paths.tag, "paths")
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0].tag, "cache-path")
        self.assertEqual(paths[0].attrib.get("path"), "editable/")


class UiRegressionTests(unittest.TestCase):
    """Source-level contracts; these are not screenshot or emulator tests."""

    @classmethod
    def setUpClass(cls):
        assets = ROOT / "app/src/main/assets"
        android = ROOT / "app/src/main/java/com/kanban/offline"
        cls.html = (assets / "kanban.html").read_text(encoding="utf-8")
        cls.css = (assets / "kanban.css").read_text(encoding="utf-8")
        cls.design_css = (assets / "design-system.css").read_text(encoding="utf-8")
        cls.theme_js = (
            ROOT / "app/src/main/js-src/media-dialogs.js"
        ).read_text(encoding="utf-8")
        cls.main = (android / "MainActivity.kt").read_text(encoding="utf-8")

    def test_kanban_loads_shared_styles_and_script(self):
        for asset in ("kanban.css", "design-system.css", "kanban.js"):
            with self.subTest(asset=asset):
                self.assertIn(asset, self.html)

    def test_web_theme_has_both_palettes_and_persists(self):
        self.assertIn('[data-theme="dark"]', self.css)
        self.assertIn(':root[data-theme="dark"]', self.design_css)
        self.assertIn('document.documentElement.setAttribute(\'data-theme\', t)', self.theme_js)
        self.assertIn("localStorage.setItem('kanban_theme', t)", self.theme_js)

    def test_native_theme_bridge_and_japanese_navigation(self):
        self.assertIn("KanbanTheme.postMessage(t)", self.main)
        self.assertIn('applyMiniTheme(message.data == "dark")', self.main)
        self.assertIn('val japaneseUrl = "$appOrigin/assets/japanese.html"', self.main)
        self.assertIn('toolbar.addView(japaneseButton', self.main)
        self.assertIn('japaneseButton.text = if (url.endsWith("/japanese.html"))', self.main)

    def test_japanese_banner_controls_follow_theme(self):
        self.assertIn('findViewWithTag<Button>("mini_close")', self.main)
        self.assertIn('findViewWithTag<LinearLayout>("mini_answers")', self.main)
        self.assertIn("styleThemeButton(it, dark)", self.main)
        self.assertIn("applyMiniTheme(miniDarkTheme)", self.main)

    def test_wireless_chat_fully_removed_from_active_project(self):
        self.assertFalse((ROOT / "app/src/main/java/com/kanban/offline/NearbyActivity.kt").exists())
        self.assertIn('deleteSharedPreferences("kanban_nearby")', self.main)
        paths = [
            *(ROOT / "app/src/main").rglob("*"),
            *(ROOT / ".agents").rglob("*"),
            ROOT / "AGENTS.md",
            ROOT / ".github/copilot-instructions.md",
            ROOT / "README.md",
            ROOT / ".maestro/smoke.yaml",
            ROOT / "tools/capture_android_screenshots.sh",
        ]
        forbidden = ("nearbyactivity", "nearbybutton", "kanban_nearby",
                     "bluetooth", "блютуз")
        for path in paths:
            if not path.is_file() or path.suffix not in {".kt", ".xml", ".html",
                    ".css", ".js", ".md", ".yaml", ".sh"}:
                continue
            text = path.read_text(encoding="utf-8").lower()
            # Only intentional removal checks can mention the old feature.
            if path.name == "smoke.yaml":
                text = text.replace('- assertnotvisible: "чат по bluetooth"', "")
            if path.name == "MainActivity.kt":
                text = text.replace('deletesharedpreferences("kanban_nearby")', "")
            for token in forbidden:
                with self.subTest(path=str(path.relative_to(ROOT)), token=token):
                    self.assertNotIn(token, text)


if __name__ == "__main__":
    unittest.main()
