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
        self.assertFalse(any(a.get(ns + "name", "").endswith("NearbyActivity") for a in activities))
        # Audio notes still require microphone permission; BLE permissions must not return.
        permissions = {p.get(ns + "name") for p in manifest.findall("uses-permission")}
        self.assertIn("android.permission.RECORD_AUDIO", permissions)
        self.assertFalse(any("BLUETOOTH" in p or p == "android.permission.ACCESS_FINE_LOCATION"
                             for p in permissions if p))

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

    def test_native_theme_bridge(self):
        self.assertIn("KanbanTheme.postMessage(t)", self.main)
        self.assertIn('applyMiniTheme(message.data == "dark")', self.main)

    def test_removed_bluetooth_chat_does_not_return(self):
        self.assertNotIn("Чат по Bluetooth", self.main)
        self.assertNotIn("NearbyActivity", self.main)
        self.assertFalse((ROOT / "app/src/main/java/com/kanban/offline/NearbyActivity.kt").exists())
        manifest = (ROOT / "app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertNotIn(".NearbyActivity", manifest)
        self.assertNotIn("android.permission.BLUETOOTH", manifest)

    def test_japanese_banner_controls_follow_theme(self):
        self.assertIn('findViewWithTag<Button>("mini_close")', self.main)
        self.assertIn('findViewWithTag<LinearLayout>("mini_answers")', self.main)
        self.assertIn("styleThemeButton(it, dark)", self.main)
        self.assertIn("applyMiniTheme(miniDarkTheme)", self.main)

    def test_card_priority_is_top_aligned_and_always_visible(self):
        views = (ROOT / "app/src/main/js-src/views.js").read_text(encoding="utf-8")
        self.assertIn('class="task-card-meta"', views)
        self.assertIn("priority === 'none' ? 'Без приоритета'", views)
        self.assertIn("card.setAttribute('aria-label',", views)
        self.assertIn(".task-card-meta {", self.css)
        self.assertIn(".task-priority.p-none", self.css)

    def test_mobile_board_keeps_vertical_room_and_japanese_panel_is_optional(self):
        self.assertIn("overflow-x:auto; overflow-y:hidden; padding:6px 10px;", self.css)
        self.assertIn(".toolbar > * { flex-shrink:0; }", self.css)
        self.assertIn(".column { height:100%; max-height:100%; min-height:0; }", self.css)
        self.assertIn("private var miniExpanded = false", self.main)
        self.assertIn("if (miniExpanded && !bannerDismissedThisSession", self.main)
        self.assertIn('contentDescription = "Показать или скрыть японское задание"', self.main)

    def test_rejected_comrade_proposals_are_editable_and_can_retry_with_llm(self):
        assistant = (ROOT / "app/src/main/js-src/assistant.js").read_text(encoding="utf-8")
        engine = (ROOT / "app/src/main/java/com/kanban/offline/KanbanAssistantEngine.kt").read_text(encoding="utf-8")
        self.assertIn("comradeReviewCreate(draft)", assistant)
        self.assertIn("comradeAIRewrite(draft)", assistant)
        self.assertIn("comradeRewriteResolve", assistant)
        self.assertIn("Другой вариант", assistant)
        self.assertIn("purpose:'rewrite_title'", assistant)
        self.assertIn('if (purpose == "rewrite_title")', engine)
        self.assertIn('value.optString("purpose")', self.main)
        self.assertIn(".comrade-draft-field", self.css)

    def test_comrade_bounded_actions_do_not_clear_database(self):
        code = (ROOT / "app/src/main/js-src/assistant.js").read_text(encoding="utf-8")
        for symbol in ("comradeCreateTask(", "comradeChangeTask(", "comradeList(", "comradeConfirm("):
            self.assertIn(symbol, code)
        self.assertIn("dbPutTask(", code)
        self.assertNotIn("indexedDB.deleteDatabase", code)
        self.assertNotIn("eval(", code)
        html = (ROOT / "app/src/main/assets/kanban.html").read_text(encoding="utf-8")
        self.assertIn('id="comradeOpen"', html)


if __name__ == "__main__":
    unittest.main()
