#!/usr/bin/env python3
"""Validate a real SAF-exported Kanban JSON file from Android emulator CI.

The export is copied from Android shared storage after the system Save As dialog
has completed. This checks the produced bytes, not merely the success toast.
"""
import argparse
import base64
import json
from pathlib import Path


def verify(path: Path, expected_titles: list[str], expected_media: list[str] | None = None, expected_media_text: str | None = None) -> None:
    with path.open("r", encoding="utf-8") as source:
        backup = json.load(source)

    if not isinstance(backup, dict) or backup.get("version") != 4:
        raise AssertionError("Expected a v4 Kanban JSON backup")
    if backup.get("app") != "kanban-mindmap":
        raise AssertionError("Unexpected backup app identifier")
    if not isinstance(backup.get("exportedAt"), str):
        raise AssertionError("Missing export timestamp")

    boards, tasks, media = backup.get("boards"), backup.get("tasks"), backup.get("media")
    if not isinstance(boards, list) or not boards:
        raise AssertionError("Backup has no boards")
    if not isinstance(tasks, list) or not isinstance(media, dict):
        raise AssertionError("Malformed tasks or media data")

    board_ids = [board.get("id") for board in boards if isinstance(board, dict)]
    if len(board_ids) != len(boards) or len(set(board_ids)) != len(board_ids):
        raise AssertionError("Invalid or duplicate board IDs")
    if backup.get("activeBoardId") not in board_ids:
        raise AssertionError("Active board does not exist in backup")

    task_ids = [task.get("id") for task in tasks if isinstance(task, dict)]
    if len(task_ids) != len(tasks) or len(set(task_ids)) != len(task_ids):
        raise AssertionError("Invalid or duplicate task IDs")
    if any(task.get("boardId") not in board_ids for task in tasks):
        raise AssertionError("Task references a missing board")

    titles = {task.get("title") for task in tasks}
    missing = set(expected_titles) - titles
    if missing:
        raise AssertionError(f"Saved file is missing expected tasks: {sorted(missing)}")

    # When attachments are present, ensure the JSON stores valid data URLs and
    # that the backing media can be decoded, rather than mere placeholder IDs.
    for media_id, entry in media.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("data"), str):
            raise AssertionError(f"Invalid media entry: {media_id}")
        data = entry["data"]
        if not data.startswith("data:") or ";base64," not in data:
            raise AssertionError(f"Media is missing its base64 payload: {media_id}")
        base64.b64decode(data.split(",", 1)[1], validate=True)

    for media_id in expected_media or []:
        if media_id not in media:
            raise AssertionError(f"Expected attachment missing from exported backup: {media_id}")
        matching = [task for task in tasks if any(
            f.get("id") == media_id for f in task.get("files", [])
        )]
        if not matching:
            raise AssertionError(f"Exported attachment {media_id} has no owning task")
        data = media[media_id]["data"].split(",", 1)[1]
        if not base64.b64decode(data, validate=True):
            raise AssertionError(f"Exported attachment {media_id} is empty")

    if expected_media_text is not None:
        if len(expected_media or []) != 1:
            raise AssertionError("Exact media-text check requires one expected media ID")
        media_id = expected_media[0]
        encoded = media[media_id]["data"].split(",", 1)[1]
        actual = base64.b64decode(encoded, validate=True)
        expected = expected_media_text.replace(chr(92) + "n", chr(10)).encode("utf-8")
        if actual != expected:
            raise AssertionError(
                f"Attachment bytes changed during SAF export: "
                f"expected {len(expected)} bytes, got {len(actual)}"
            )

    print(
        f"Verified SAF backup JSON: {len(boards)} boards, "
        f"{len(tasks)} tasks, {len(media)} media entries; "
        f"expected tasks found: {', '.join(expected_titles)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path, help="JSON file pulled from the Android document provider")
    parser.add_argument("--expect-title", action="append", default=[], dest="expected_titles")
    parser.add_argument("--expect-media", action="append", default=[], dest="expected_media")
    parser.add_argument(
        "--expect-media-text",
        help="Exact UTF-8 attachment content expected after SAF export",
    )
    args = parser.parse_args()
    verify(args.backup, args.expected_titles, args.expected_media, args.expect_media_text)


if __name__ == "__main__":
    main()
