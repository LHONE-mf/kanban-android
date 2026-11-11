# Kanban development status

Active branch: `ui-testing`. M4 search and organization are in progress; M0–M3
still require the remaining device acceptance checks. The dated chat handoff
is historical context, not a current test report.

## Reliability

- [x] Quick-add preserves a new draft typed while the preceding task save is
  pending, including a second task with the same title. Repeated submit remains
  blocked during the write; successful unchanged drafts clear and failed saves
  retain their text. The regression fails before the fix and passes after it.
  Local verification: 27 Python tests, 30 Node suites, bundle check and syntax
  check. Native build/startup results for this change are pending CI.
- [x] Board deletion commits task removal and board settings in one IndexedDB
  transaction. Failed writes leave visible tasks, reminders and media intact.
  Successful deletion closes the old board settings.
- [x] Fast regression covers aborted/synchronous writes, subtasks, other boards,
  cancelled deletion, and deleting an empty or the last board.
- [x] Chromium at 360px verifies actual IndexedDB abort/clone-error rollback,
  successful deletion, reload persistence, and unchanged Japanese progress.
- [x] Targeted Android flow: delete a board after moving a recurring task,
  verify cross-board search, then restart and verify the surviving task.
  Passed at `d9a740c`: [focused Android run](https://github.com/LHONE-mf/kanban-android/actions/runs/42889859826).
- [ ] Physical-device upgrade and broader acceptance checklist in
  `TESTING_ANDROID.md`; no signing or storage migration is part of this change.
- [x] Japanese learned-kana and Kanban tasks survive the signed v1→v2
  emulator upgrade. Android Back saves an edited description through restart;
  the flow targets the editable placeholder and verifies typing before Back.
- [x] Real Android SAF export/cancel/retry, exported JSON byte verification,
  restore/restart and native attachment opening pass at `68fbd57`.
  [Runtime evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42893892362).
  That run then stopped at photo navigation: four fixed swipes left its
  controls offscreen. The photo flow now scrolls to the actual photo button;
  its zoom/gallery assertions and media round-trip checks remain intact.
- [x] Imported board/media IDs that match Object property names remain
  enumerable and keep stable references. Executable coverage uses the real
  import, rebucketing and export functions, including a complete round-trip
  and legacy task-array compatibility. Chromium also verifies real file import,
  confirmation, backup download, attachments and database reload in both themes.

## M4 search

- [x] Dashboard totals summarize every board without switching the active board;
  executable regression and APK/startup smoke passed at `74fda7f`:
  [APK](https://github.com/LHONE-mf/kanban-android/actions/runs/42987300667),
  [Android startup](https://github.com/LHONE-mf/kanban-android/actions/runs/42987300479).
- [x] Existing executable regression covers cross-board/nested search, Unicode,
  combined filters, My Day, reset, pagination, renamed boards, removed tags,
  safe result text, and exact task navigation.
- [x] Loading another search page focuses its first new task, including the
  final page when the load-more button disappears. Runtime checks use 215
  tasks across two boards at 320/768/1024/1440px in light and dark themes:
  pagination, focus/scroll, combined filters, Cyrillic/Japanese queries,
  reset, and exact nested-task navigation.
- [x] Android 215-task pagination, combined board/priority filters, reset, exact nested-task opening and restart passed at `683b958`: [emulator evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42956499586).
- [x] Android startup smoke exercises all five tabs, including horizontal
  navigation on a narrow emulator; creates a task, searches across boards,
  restarts and verifies persistence. Passed at `2a256d9`:
  [Android navigation evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42985957999).
  [APK evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42985957991).
- [x] Keyboard Left/Right/Home/End navigation updates active tab, focus and
  `aria-selected`; regression guards the multi-tab selector that once disabled
  Android buttons. APK and startup smoke passed at `8ca21c4`.
- [ ] TalkBack and physical-device acceptance (not established by emulator).

The APK workflow runs on every push. Full Android UI coverage is manual or
triggered by editing its workflow; the focused recurrence/search flow runs
when its Maestro file or workflow changes. Record exact workflow results in
the execution handoff; a passing build does not establish device acceptance.

## Japanese backup validation

- Serialized learned-kana, review and quiz progress is validated during import
  planning, before replacing boards or writing learning storage. Malformed
  progress rejects the import and preserves existing records. Missing newer
  quiz fields and legacy numeric-string counters remain supported.
- Verified by failing-before-fix regression, real import-planning tests, all
  fast suites, and real browser file import in both themes.

## Android pagination regression

- Synthetic 215-task/two-board import fixture and focused Maestro flow cover
  three pages, exact nested-task opening, board/priority filters, reset and restart.
  The focused recurrence/search workflow executes both flows; native evidence
  is required before marking the Android pagination acceptance complete.

## Long-list navigation

- A pinned return control brings search and filters back into reach without
  clearing the query, changing filters, or discarding loaded pages. Browser
  checks cover 215 tasks in both themes at 320/768/1024/1440px; the Android
  pagination flow also exercises return from page three and narrowing the query.

## Search relevance

- Exact multi-word titles rank ahead of newer expanded titles. Unicode width,
  case and whitespace normalization remain supported; deadline ordering stays
  primary when a deadline filter is active. Failing-before-fix regression
  covers the previous recency tie and full-width query text.
