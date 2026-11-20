# Comrade C-01–C-05: integration and acceptance

## Integration baseline — C-01
This branch is based on `fix/comrade-readable-task-cards` at `e66070a8cf8634545b6f84436b7243d43435287f`, which already contains:
- PR #8 (`fix/comrade-original-icon-android-back-audit`): Android Back handling, original launcher icon.
- PR #9 (`fix/comrade-backup-integrity-polish`): SAF chunked backups, day plan and WebView Japanese progress, media integrity.
- PR #10 (`fix/comrade-readable-task-cards`): content-driven card height, title-first and vertical column scrolling.

Do not merge to `main`, deploy, uninstall, clear app data or change `com.kanban.offline` or the signing key without separate approval.

## Implemented in this branch
- **C-02**: inherited dynamic task-card heights (`flex-shrink:0`) and column scroll from PR #10; automated layout regression retained.
- **C-03**: edited task + descendants commit in one IndexedDB transaction; failures leave in-memory tree and editor unchanged. Android Back invokes task save; trying to close while saving is blocked.
- **C-04**: attachment names wrap; Open/Edit/Remove have a dedicated, wrapping action row with >=44px targets; modal content scrolls independently of its footer.
- **C-05**: backup v6 includes native Android `japanese_daily` quiz progress in addition to v5 WebView Japanese keys, day plan, files, boards and tasks. Native bridge is allowed only for the trusted app origin/main frame. Native restore validates all six fields and writes persistent preferences before updating the live quiz. Missing native section in older archives leaves native progress untouched. A v5+ archive with missing task/media records is rejected before replacing user data.

## Automated checks (GitHub Actions)
- Python project regressions.
- JavaScript bundle is byte-for-byte generated from the eight source files, `node --check`.
- Task titles/priority badges/scrolling, atomic task save and failure rollback, attachment touch targets.
- Android Back navigation and icon integrity.
- Full backup integrity, SAF transfer protocol, native mini-quiz read/restore contract and validation, daily planning.
- Kotlin compilation, signed debug APK generation and certificate validation.

**Automated tests are not physical-device acceptance**. Do not announce release readiness until the following checks pass on the user's installed Android device.

## Physical Android acceptance checklist (non-destructive)
1. Take a verified full backup first, keeping the app installed. Never test restore by clearing its data.
2. Open Kanban with 10+ tasks in one column, including 200-character names and long descriptions. Swipe vertically: cards must not compress, titles and badges must remain readable. Swipe horizontally to another column; drag/reorder tasks without triggering unintended scrolling.
3. Edit a task with a child, change its status/column and press system Back. Both parent and child must remain in the destination after reopening and after app restart. Try an invalid empty title: the editor must remain open. Do not inject storage failures into actual production data.
4. Attach several files, scroll to the bottom of a long editor and use each Open/Edit/Remove control. None may activate Duplicate/Save/Delete accidentally. Check with soft keyboard open/closed and light/dark themes.
5. Export a v6 full backup using Android Storage Access Framework. Verify that the file was actually saved and includes `nativeJapanese`, all task files and the saved day plan. Cancel a second export and confirm no success message or partial document.
6. On an isolated test profile/device, import the v6 archive and verify task counts, nested tasks, media bytes, Japanese WebView progress and native mini-quiz counters and queue. Test an older v5 archive: native progress must stay unchanged. Corrupt a **copy** of a v6 archive by removing one referenced file; import must fail before changing existing test data.
7. Install the signed APK **over** the existing app only after confirming the signing identity, never uninstall or clear storage. Test app restart, Android Back and navigation.

## Known constraints
- No device testing has been run from this development session.
- Cross-storage restore uses IndexedDB transaction, WebView localStorage restoration and Android SharedPreferences; these are different storage engines and cannot commit atomically together. Restore failures are reported; the previous native data is not overwritten if native validation fails.
- Some old backups may lack native Japanese state; these cannot reconstruct what they never captured.
