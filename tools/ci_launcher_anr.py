#!/usr/bin/env python3
"""Print the tap coordinates only for an Android Quickstep ANR dialog.

A failed Maestro test must never be retried for an ordinary application failure.
The caller retries once only when this helper positively identifies the
system launcher ANR and its "Close app" button in the UIAutomator hierarchy.
"""
import re
import sys
import xml.etree.ElementTree as ET


def close_button_center(xml_text: str):
    root = ET.fromstring(xml_text)
    nodes = list(root.iter("node"))
    launcher_anr = any(
        node.get("text") == "Quickstep isn't responding" for node in nodes
    )
    if not launcher_anr:
        return None
    for node in nodes:
        if node.get("resource-id") != "android:id/aerr_close":
            continue
        match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
        if not match:
            continue
        left, top, right, bottom = map(int, match.groups())
        if right > left and bottom > top:
            return (left + right) // 2, (top + bottom) // 2
    return None


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: ci_launcher_anr.py <uiautomator-dump.xml>")
    try:
        with open(sys.argv[1], encoding="utf-8") as file:
            center = close_button_center(file.read())
    except (OSError, ET.ParseError) as error:
        print(f"Could not read launcher hierarchy: {error}", file=sys.stderr)
        sys.exit(1)
    if center is None:
        sys.exit(1)
    print(*center)
