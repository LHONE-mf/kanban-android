#!/usr/bin/env python3
"""Rebuild the single WebView script from ordered, readable source sections.

Run from the repository root:
    python3 tools/build_kanban_js.py
    python3 tools/build_kanban_js.py --check

The output is intentionally a single script because the sections share
lexical variables inside one IIFE. Splitting them into independent <script>
tags would break that shared scope.
"""
from pathlib import Path
import argparse
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "app" / "src" / "main" / "js-src"
OUTPUT = ROOT / "app" / "src" / "main" / "assets" / "kanban.js"
PARTS = ("core.js", "views.js", "tasks.js", "media-dialogs.js", "data-transfer.js", "interactions.js", "android-extras.js")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated JS is outdated")
    args = parser.parse_args()
    combined = "".join((SOURCE / name).read_text(encoding="utf-8") for name in PARTS)
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != combined:
            print("kanban.js is outdated. Run: python3 tools/build_kanban_js.py", file=sys.stderr)
            return 1
        print("kanban.js matches the source modules")
        return 0
    OUTPUT.write_text(combined, encoding="utf-8")
    print(f"Built {OUTPUT.relative_to(ROOT)} from {len(PARTS)} modules")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
