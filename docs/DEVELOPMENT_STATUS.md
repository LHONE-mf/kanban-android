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
  check. APK build passed at `802abe0`:
  [build evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42991026964).
  Android five-tab/startup, task create/open, search and restart smoke also passed:
  [Android evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42991026969).
- [x] Quick-add completion updates its original board's task list and names that
  board in the confirmation even if the user switches boards during the write.
  A regression exercises the real quick-add, board-switch, sanitization and
  search functions with a deferred storage boundary: one result on the correct
  board, unchanged navigation, and no board mutations when storage fails.
  It fails before the fix. All 27 Python tests and 31 Node suites pass locally;
  APK build passed at `aa0597f`:
  [build evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42991664282).
  Android startup smoke also passed:
  [Android evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42991664545).
- [x] Deletion and duplication also retain their source-board task list while
  storage is pending. Switching boards no longer leaves deleted subtrees in
  search or puts duplicates on another board. Regression reproduces both bugs
  before the fix and verifies subtree undo, reminders, navigation and unchanged
  boards on failed writes. Undo refuses a board that was subsequently deleted,
  preserving the surviving board and avoiding orphaned task/reminder writes.
  All 27 Python tests and 33 Node suites pass locally;
  APK build passed at `89f9a0d`:
  [build evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42993587221).
  Android startup smoke also passed:
  [Android evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42993587183).
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
- [x] Expanded Android startup smoke: reach Settings through the mobile menu,
  edit and cancel a board name, reopen Settings, and close it using Android Back.
  The later exact search-result label verifies that cancellation did not rename
  the board. Passed at `6f73962`:
  [Android evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42994233882),
  [APK evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42994233931).
  Existing five-tab/task/search/restart assertions remain in place.

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

## Large-collection filtering

- Filter-only search and My Day skip normalization of descriptions, titles and
  checklists when there are no search words. Filters, deadline/recent ordering,
  nested tasks, exact counts and pagination retain their existing behavior.
- A deterministic regression covers 10,000 tasks across ten boards, combined
  filters, Unicode tags, My Day, stable page expansion and full-text matching.
  It fails before the change because filter-only search normalizes over 28
  million unrelated text characters; it passes after the change.
- Local Node comparison (20 measured iterations after three warm-ups): median
  filter-only search 81.87 ms before / 0.73 ms after, using 10,000 tasks with
  3,750-character descriptions. Text-query medians were 83.77 / 86.28 ms.
  These measure the search function on the development host, not Android UI
  response time. All 27 Python tests and 32 Node suites pass; generated bundle
  and JavaScript syntax checks pass. APK build passed at `6a0d6fb`:
  [build evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42992530728).
  Android startup smoke also passed:
  [Android evidence](https://github.com/LHONE-mf/kanban-android/actions/runs/42992530719).

## Next priorities

- [ ] Exercise a board/notification navigation change while the task editor is
  saving multiple attachments. Verify that the real save path retains the
  original board and all media, and that a finishing save cannot close a newer
  editor. Investigate with a failing regression before changing behavior.
- [ ] Complete physical OnePlus/TalkBack and broader upgrade acceptance from
  `TESTING_ANDROID.md`. Emulator results do not establish those checks.

M4 remains in progress. M5 productivity work stays deferred while these
navigation and data-safety checks remain open.
