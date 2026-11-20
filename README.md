# Comrade — offline Android Kanban

The original Kanban application remains: boards, cards, priorities, deadlines,
attachments, calendar, mind map, Pomodoro timer, import/export and Japanese lessons.
Comrade is a standalone offline task manager.

## 🔥 Мой день
The standalone day planner lists unfinished tasks from all boards, sorts by
deadline and priority, and lets you choose and reorder tasks. Saving never changes
task titles, boards, deadlines or priorities. Previously saved day plans are kept
under the compatible settings key `comrade_day_plan_v1`.

## Updates without losing local data
Android app ID stays `com.kanban.offline` with the same stable signing key.
Download a standalone Comrade.apk via
[Releases](https://github.com/LHONE-mf/kanban-android/releases/latest)
and install OVER the existing app. Do not uninstall or clear its data.
On launch the app removes only the obsolete private cached GGUF at
`filesDir/kanban_comrade/active.gguf` and its model filename preference.
An original model in Downloads/Documents is never touched.

## Development
The JS bundle is built with `python3 tools/build_kanban_js.py`.
Tests and the Android APK are produced by GitHub Actions using JDK 17,
Gradle 9.3.1 and Android SDK 37. No physical-device validation is implied.

## Comrade 0.4.9: original icon and Android Back

The launcher and web icon reuse byte-for-byte the original PNG image files
from `LHONE-mf/comrade-`, including the adaptive foreground and five screen
densities. No new icon design is used. Android system Back first asks the
local page to handle visible dialogs. In the task editor it invokes the same
atomic Save as the Save button; validation or storage failure leaves the
editor open, preventing accidental exit. Japanese lessons Back returns to
Kanban. No change to installed data, package ID, or signing identity.

## v0.4.10 data safety and UI polish

- Export v5 fails instead of silently omitting an unreadable/missing task attachment.
- JSON backups include saved `comrade_day_plan_v1` and the five known Japanese
  learning `localStorage` keys; import validates these fields and supports older backups.
- Saving a task prepares audio metadata before inserting blobs into IndexedDB.
- CSV export remains available from board Settings, not in the crowded main header.
- This does not yet include native Android `japanese_daily` SharedPreferences in backups.
  Do not uninstall the app or clear storage to migrate. Test upgrades on-device.

## v0.4.11 C-01–C-05 candidate (NOT yet released)

- Based on the PR #8 → #9 → #10 integration chain; preserves all offline tasks,
  attachments, saved day plans, and existing Japanese learning progress.
- Kanban task cards grow to fit titles/content and scroll vertically inside columns.
- Editing a task and moving its descendants saves in **one** IndexedDB transaction.
  Failed storage writes keep the editor and previous tree unchanged.
- Attachment action rows wrap, with accessible 44px Open/Edit/Remove targets.
- Full JSON backup **v6** adds the native Android Japanese mini-quiz progress from
  `japanese_daily` (six fields) alongside the existing WebView Japanese keys.
  Older v5 archives remain importable without overwriting native progress.
- A v5/v6 archive missing a task or referenced attachment is rejected before
  replacing the existing IndexedDB state. The Android WebView backup bridge must
  be available before native mini-quiz progress can be exported.
- CI checks JavaScript, Kotlin, signing, task editor, touch targets and backups.

These changes remain **in a review branch**. Physical Android touch/restore tests
are still required before any merge into `main` or stable APK release.
See `docs/COMRADE_C01_C05_ACCEPTANCE.md` for non-destructive acceptance steps.

## C-06–C-09 media improvements (review candidate, not released)

- Multiple file picker visits accumulate attachments, including Android ClipData multi-select.
- Adaptive JPEG compression targets ~1–2 MiB where feasible; WebP encoding preserves
  transparency for compatible PNG/HEIC/WebP images. Tiny files are not recompressed.
- Task-image gallery includes an explicit close button, swipe navigation, pinch zoom
  and accessible zoom controls.
- Non-image documents use a chunked Android FileProvider ACTION_VIEW handoff with
  read-only URI permission; no direct access to IndexedDB is granted.
- Existing attachments and offline data remain unchanged. See
  `docs/COMRADE_C06_C09_ACCEPTANCE.md` for non-destructive phone checks.

No stable release or merge into main is implied; physical Android verification
remains required.
