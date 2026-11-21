# Comrade P8 — Android update without data loss

This is a manual acceptance checklist for the **in-place upgrade** from an
already installed Comrade Android build to a newer, appropriately signed build.
CI checks package identity, signing configuration, WebView storage origin,
IndexedDB names and Japanese progress storage, but **cannot confirm what is
installed on an individual phone**.

## Before testing

1. Use the currently installed Comrade. Do **not uninstall** it, clear storage,
   reset the phone, or use Android Settings → Apps → Storage → Clear data.
2. In Comrade, export a full JSON backup to a location **outside the application**
   using the Android document picker (e.g. Documents or a cloud drive).
   Confirm the resulting file exists and is nonempty. Keep this backup untouched.
3. Record a baseline:
   - Board names and number of tasks on at least two boards
   - One task's description, column, checklist, deadline and attachments
   - Open a saved photo, zoom and swipe to the next photo; open a document
   - Saved "Мой день" task selection and ordering
   - Japanese web-learning script/tab and achieved progress
   - Native Japanese mini-quiz question count and katakana unlock state, if used
4. Use a test build that has the **same app ID and signing certificate** as the
   installed app, with an **Android versionCode higher** than the installed
   version. GitHub Actions uses a persistent debug key and its run number for
   this purpose, but an older or separately signed installed version may differ.
   Do not assume compatibility merely because the app is named Comrade.

## Update / verify (offline)

1. Turn off network access (airplane mode); Comrade must work offline.
2. Open the newer APK and select **Update / Install over the existing app**.
   **Never** uninstall the old app to get past an "App not installed" or
   signature/version conflict. Stop and record that error instead.
3. Launch Comrade and compare the same boards, tasks, details, checklists,
   priorities and ordering against the baseline.
4. Reopen each saved photo, verify image gallery and zoom, and open a document.
   The media content must still be available, not just its filename.
5. Check "Мой день" and both Japanese-learning progress stores.
6. Edit a noncritical existing task, save, switch boards, close Comrade,
   relaunch and confirm the edit plus original attachments remain intact.
7. Export a fresh full JSON backup to a **different filename**. Confirm the file
   exists and contains the expected boards/tasks; retain the original backup.
8. Turn network back on only after finishing the offline checks.

## Results (fill in after real Android test)

| Check | Expected | Result |
| --- | --- | --- |
| In-place installation | Android accepts Update without uninstall | Not tested |
| Offline launch | Opens existing boards | Not tested |
| Boards and task details | All original records still present | Not tested |
| Photos and attachments | Original content opens | Not tested |
| "Мой день" | Saved plan retained | Not tested |
| Japanese web progress | Progress retained | Not tested |
| Native Japanese mini-quiz | Progress retained | Not tested |
| Save, close and relaunch | New change and old data survive | Not tested |
| Export after update | JSON backup created outside app | Not tested |

**If any check fails:** stop testing; do not clear data or reinstall. Retain the
original exported backup, the newer APK's build/run number and the failing step.
Investigate before authorizing a production release.

A green CI check proves **code and build invariants**, not an on-device data
migration. The actual in-place upgrade remains an explicit manual acceptance gate.
