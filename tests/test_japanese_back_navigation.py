"""Android Back on the Japanese page must return to Kanban, not exit the app."""
from pathlib import Path
import unittest

ACTIVITY = Path(__file__).resolve().parents[1] / (
    "app/src/main/java/com/kanban/offline/MainActivity.kt"
)


class JapaneseBackNavigationTest(unittest.TestCase):
    def test_native_back_returns_to_kanban_from_japanese(self):
        code = ACTIVITY.read_text(encoding="utf-8")
        handler = code.split("override fun handleOnBackPressed()", 1)[1].split(
            "private fun confirmAppExit()", 1
        )[0]
        japanese = 'webView.url?.startsWith("$appOrigin/assets/japanese.html")'
        target = 'webView.loadUrl("$appOrigin/assets/kanban.html")'
        self.assertIn(japanese, handler)
        self.assertIn(target, handler)
        self.assertLess(handler.index(japanese), handler.index("window.kanbanHandleBack"))
        self.assertIn("lastBackGestureAt = 0L", handler)


if __name__ == "__main__":
    unittest.main()
