#!/usr/bin/env python3
"""Write synthetic data exclusively for disposable Android CI emulators."""
import json
import sys
from pathlib import Path


def fixture():
    boards = [{"id": board, "name": "CI Search " + board,
               "columns": [{"id": "todo", "title": "To Do", "isDone": False}]}
              for board in ("A", "B")]
    tasks = [{"id": f"page-{i}", "boardId": "A" if i < 100 else "B",
              "columnId": "todo", "title": f"CI pagination {i:03}",
              "parentId": "page-100" if i == 214 else "",
              "priority": "high" if i % 2 == 0 else "low",
              "updatedAt": 1000 - i, "createdAt": 1,
              "tags": [], "files": [], "checklist": []}
             for i in range(215)]
    return {"version": 4, "app": "kanban-mindmap", "activeBoardId": "A",
            "boards": boards, "tasks": tasks, "media": {}}


if __name__ == "__main__":
    Path(sys.argv[1]).write_text(json.dumps(fixture()), encoding="utf-8")
