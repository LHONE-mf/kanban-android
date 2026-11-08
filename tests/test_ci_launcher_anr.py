"""The emulator recovery may only dismiss a proven Android launcher ANR."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from ci_launcher_anr import close_button_center


class QuickstepAnrTests(unittest.TestCase):
    def test_dismiss_only_quickstep_anr(self):
        hierarchy = """<hierarchy>
            <node text="Quickstep isn't responding" resource-id="android:id/alertTitle"/>
            <node text="Close app" resource-id="android:id/aerr_close"
                  bounds="[70,1143][1010,1269]"/>
        </hierarchy>"""
        self.assertEqual(close_button_center(hierarchy), (540, 1206))

    def test_other_app_anr_is_not_dismissed(self):
        hierarchy = """<hierarchy>
            <node text="Kanban isn't responding" resource-id="android:id/alertTitle"/>
            <node text="Close app" resource-id="android:id/aerr_close"
                  bounds="[70,1143][1010,1269]"/>
        </hierarchy>"""
        self.assertIsNone(close_button_center(hierarchy))

    def test_no_close_button_is_not_dismissed(self):
        hierarchy = """<hierarchy>
            <node text="Quickstep isn't responding" resource-id="android:id/alertTitle"/>
        </hierarchy>"""
        self.assertIsNone(close_button_center(hierarchy))

    def test_malformed_button_bounds_are_rejected(self):
        hierarchy = """<hierarchy>
            <node text="Quickstep isn't responding" resource-id="android:id/alertTitle"/>
            <node resource-id="android:id/aerr_close" bounds="bad"/>
        </hierarchy>"""
        self.assertIsNone(close_button_center(hierarchy))


if __name__ == "__main__":
    unittest.main()
