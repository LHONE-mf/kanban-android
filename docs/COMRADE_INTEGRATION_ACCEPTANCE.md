# Comrade — media + mobile integration acceptance

This branch is a **review candidate**, not a published app. It combines PR #12 (C-06–C-09 attachments/media) with the mobile UX chain PR #13, #14, #16, #17, #18.

## Safety
- Do **not** merge into `main` or publish an APK until separately approved.
- Never uninstall the installed app, clear data/cache, change its package identifier or change the original signing identity.
- All offline boards, tasks, attachments, backups and Japanese learning progress must remain intact.

## What is integrated
- Compact mobile header and dropdown menu, safe-area responsiveness, Android Back and keyboard navigation.
- Per-board horizontal/vertical scrolling, touch drag cancellation and in-bounds drop checks.
- Multi-attachment staging, compressed images, gallery navigation/swipe/zoom, Android scoped file opening.
- Both test suites plus new `tests/test_combined_mobile_media.js`.

The generated `kanban.js` is rebuilt from all eight combined source modules. Source files from PR #12 were applied using checked contextual patches; the reviewed mobile changes remain as the integration branch's ancestor.

## Physical Android acceptance required (test data only)
1. Verify existing boards, task files, backups and Japanese progress **without clearing app data**.
2. In portrait and landscape, test long board names, menu items, opening/closing dialogs and Android Back.
3. Pan columns and task lists; long-press and drag a test task; cancel drag and release outside the board without changes.
4. In a disposable test task, add multiple files from separate picker visits. Check image size, gallery navigation, zoom, close and opening arbitrary non-image files.
5. Check restored tasks and attachments after app restart. Verify backup export can be read without overwriting live tasks.
6. Only after approval, use a test APK with the original app signature; install over the existing app, never uninstall.

**CI does not prove real touch behavior or live-device data preservation.**
