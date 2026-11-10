# Kanban development status

Active branch: `ui-testing`. M4 search and organization are in progress; M0–M3
still require the remaining device acceptance checks. The dated chat handoff
is historical context, not a current test report.

## Reliability

- [x] Board deletion commits task removal and board settings in one IndexedDB
  transaction. Failed writes leave visible tasks, reminders and media intact.
  Successful deletion closes the old board settings.
- [x] Fast regression covers aborted/synchronous writes, subtasks, other boards,
  cancelled deletion, and deleting an empty or the last board.
- [x] Chromium at 360px verifies actual IndexedDB abort/clone-error rollback,
  successful deletion, reload persistence, and unchanged Japanese progress.
- [ ] Targeted Android flow: delete a board after moving a recurring task,
  verify cross-board search, then restart and verify the surviving task.
- [ ] Physical-device upgrade and broader acceptance checklist in
  `TESTING_ANDROID.md`; no signing or storage migration is part of this change.

## M4 search

- [x] Existing executable regression covers cross-board/nested search, Unicode,
  combined filters, My Day, reset, pagination, renamed boards, removed tags,
  safe result text, and exact task navigation.
- [ ] Audit real-browser pagination and navigation with large datasets,
  including focus/scroll continuity after loading more results.

The APK workflow runs on every push. Full Android UI coverage is manual or
triggered by editing its workflow; the focused recurrence/search flow runs
when its Maestro file or workflow changes. Record exact workflow results in
the execution handoff; a passing build does not establish device acceptance.
