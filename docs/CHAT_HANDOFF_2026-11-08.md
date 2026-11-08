# Kanban Android — Chat handoff (2026-11-08)

## For the next ChatGPT instance

You are continuing active development of the Android Kanban app with a Japanese-learning module. **Read this file, inspect the actual repository and recent GitHub Actions logs, then implement fixes.** The user prefers concrete commits and tests over repeated status messages, and often says "Go" to authorize the next practical step. Reply in English. Do not claim tests passed unless their GitHub Actions conclusions show success.

- Repository: https://github.com/LHONE-mf/kanban-android
- Active branch: `ui-testing` (do not accidentally work on main)
- Android package: `com.kanban.offline`
- Latest inspected commit before handoff: `944ac08d75c018084eb45fe2cb98ce5fd12e0282`
- Main goal: **usable stable beta APK**; current milestone is **prove Japanese study progress survives app restart**.

## User decisions and constraints

- **Keep emulator CI running automatically** on pushes. User said: "No, keep it. We just will look at emulator run when it's necessary." Do not disable it or reduce its frequency without asking.
- User wants the app to work in practice, not just pass source-pattern checks.
- Previous requirements include consistent theme and Android system bars, proper navigation/back behavior, stable APK upgrade signing, correct app icon, Kanban data persistence, Japanese learning UI, and Japanese learning progress persistence.
- Bluetooth chat feature was deliberately removed completely; do not reintroduce it.
- The repository has a stable development signing key for APK upgrade testing; release signing can be changed later. Do not expose key material.

## Current verified state (as of handoff)

- Android APK workflow **passed** on `944ac08`: https://github.com/LHONE-mf/kanban-android/actions/runs/42480416324
- Emulator workflow **failed** on `944ac08`: https://github.com/LHONE-mf/kanban-android/actions/runs/42480416315
- Latest emulator job ID: `128730917407`. Read its logs. The normal `.maestro/smoke.yaml` flow **passed all steps**.
- The dedicated `.maestro/japanese-progress.yaml` flow:
  1. `launchApp clearState: true` — PASSED
  2. tap `日本語 · Учить` — PASSED
  3. assert `Изучено 0 / 92 знаков кана` — PASSED
  4. scroll down until `Начать с あ・い・う・え・お` — PASSED
  5. tap that lesson start button — PASSED
  6. **tap `あ` — FAILED: Element not found: Text matching regex: あ**
- Thus **no end-to-end persistence result exists**. Do not assume the app loses or retains progress based on this failure. The next task is to fix the test's selection of `あ` (inspect UI hierarchy and screenshots/artifacts or app DOM), then verify `Отметить как изученное`, `Изучено 1 / 92 знаков кана`, and a restart without clearing state.
- Two consecutive UI runs using `androidWebViewHierarchy: devtools` failed at different stages, but latest reached the kana selection. APK compilation continues to pass.

## Important repository paths

- `.maestro/smoke.yaml` — standard Android navigation screenshots and assertions.
- `.maestro/japanese-progress.yaml` — dedicated Japanese progress restart test, currently failing at `tapOn: "あ"`.
- `.github/workflows/ui-screenshots.yml` — emulator CI; runs both Maestro flows, uploads screenshots/debug artifacts.
- `.github/workflows/android.yml` — APK CI.
- `app/src/main/assets/japanese.html` — Japanese learning UI and localStorage persistence.
- `app/src/main/java/com/kanban/offline/MainActivity.kt` — native WebView and daily Japanese banner.
- `tests/test_project_checks.py` — source-level regression tests (NOT a substitute for runtime tests).

## Persistence implementation already inspected

- WebView has `domStorageEnabled = true`, with assets served via `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/...`.
- Japanese known kana: `localStorage` key `kanban-japanese-hiragana-v1`, `persist()` updates storage and progress.
- Quiz progress: `kanban-japanese-quiz-progress-v1`; review progress: `kanban-japanese-review-v1`.
- Script selection: `kanban-japanese-script-v1`; active tab: `kanban-japanese-active-tab-v1`.
- Native daily banner state uses Android `SharedPreferences("japanese_daily", MODE_PRIVATE)`.
- The UI progress counter includes **92** total hiragana + katakana symbols. It starts at 0/92.
- In `japanese.html`, `#begin` calls into the learning view, `#kanaGrid` is populated with dynamic buttons for kana, and `#markKana` toggles learned state. Check actual DOM/visibility before choosing selectors. A direct `tapOn: "あ"` currently fails despite tapping the start button successfully.

## Suggested immediate steps

1. Inspect latest Maestro debug artifact and `japanese.html` markup/JS to see why the kana grid's first `あ` is not accessible. It may be off-screen, hidden, have a different accessibility label, or require a scroll. Prefer a robust, scoped selector, `scrollUntilVisible`, or a deterministic in-app test hook over fragile raw text matching. Do not weaken the assertion to a meaningless pass.
2. Fix `.maestro/japanese-progress.yaml`, commit to `ui-testing`, and inspect the actual emulator run.
3. Once the first kana can be selected, confirm marking it learned, restart with `clearState: false`, and assert the persisted 1/92 count. Also test navigation away/back if useful.
4. If Maestro DevTools hierarchy remains unreliable, consider an **ADB/WebView or native instrumentation-backed persistence assertion** that checks saved state reliably; preserve the UI smoke flow.
5. After persistence is proven, resume beta blockers: app upgrade/install over previous APK, Kanban CRUD/persistence, system bars/themes, Japanese banner consistency, and final beta distribution.

## Recent commits in this effort

- `8330601` — source-level regression contracts for Japanese progress.
- `facb4b6` — added dedicated Japanese progress emulator flow.
- `cba4025` — integrated progress flow into emulator CI.
- `de3e817` — tried Hiragana tab navigation (didn't work).
- `faf1ba8` — Maestro installer retries and fail-fast.
- `a323de2` — scroll to lesson start.
- `056a8f8` — wait for WebView startup in smoke flow.
- `ae73e73` / `944ac08` — enable DevTools WebView hierarchy and longer progress wait.

## Working style

Use GitHub connector tools to inspect/edit files and Actions logs, commit small meaningful fixes, and provide a link to each important commit/run. Be explicit about `passed`, `failed`, `queued`, and `in progress`. Avoid unnecessary CI-triggering commits or claiming completion prematurely. The user's next message in the new chat may simply be "Go"; treat that as permission to continue this plan.

## Update — 2026-11-08 (branch ui-testing, commit ff24221)

The verified emulator failure above is historical, **not** a verified outcome for the current head. Since handoff, the branch has gained:
- Explicitly labeled kana buttons for Maestro and Japanese restart/upgrade flows.
- Two signed APK builds (versionCode 1 and 2), installed in place with certificate and installed-version checks.
- Kanban IndexedDB task creation before upgrade and persistence checks after upgrade/restart.
- Emulator failure-stage diagnostics, screenshots, package dumps, and logcat artifacts.
- Runtime JavaScript tests exercising the real Japanese learned-kana, review grading, and quiz-answer handlers with failed localStorage writes.
- A syntax test for both inline Japanese scripts, invoked in both Android workflows. Its regex escaping was fixed at ff24221.
- Rollback and retry for learned-kana saves, spaced-repetition grades, and quiz answers when storage writes fail.

**Do not report CI success without checking the new run.** The GitHub connector currently exposes only PR-triggered runs through fetch_commit_workflow_runs, so recent push-triggered Actions conclusions have not been verified here. Open https://github.com/LHONE-mf/kanban-android/actions/workflows/ui-screenshots.yml and inspect the newest run, including its android-ui-screenshots artifact on failure. Keep push-triggered emulator CI enabled.

Next priority: establish a passing end-to-end Maestro run for Japanese progress across restart and v1→v2 upgrade, then Kanban task persistence. Fix the first concrete failure reported by that run; avoid adding unrelated tests before checking it.
