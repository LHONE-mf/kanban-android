# Engineering agent instructions

This repository is an offline-first Android WebView Kanban app. The owner is learning programming: explain changes plainly, prefer small commits, and never claim a build or on-device test passed without evidence.

## Project map
- Android/Kotlin: `app/src/main/java/com/kanban/offline/`
- Web UI: `app/src/main/assets/`
- JavaScript sources: `app/src/main/js-src/`
- Generated bundle: `app/src/main/assets/kanban.js`
- Bundler: `tools/build_kanban_js.py`
- CI: `.github/workflows/android.yml`

## Agent skills (vendored from addyosmani/agent-skills)
Before changing code, select and read the relevant `.agents/skills/<skill>/SKILL.md`:
- Build failure or bug: `debugging-and-error-recovery`
- New logic or bug regression: `test-driven-development`
- Screens, themes, Android UI/WebView: `frontend-ui-engineering`
- More than one file: `incremental-implementation`
- Before merge or handoff: `code-review-and-quality`
- GitHub Actions, APK versioning/signing: `ci-cd-and-automation`
- Files, WebView bridges, permissions, input: `security-and-hardening`

Supporting upstream checklists live in `.agents/references/`. The original source and license are documented in `.agents/README.md`.

## Required verification
1. Read the actual code and reproduce or inspect the **first meaningful error**, not just Gradle's final summary.
2. Make the smallest safe change; keep existing features working.
3. After modifying `app/src/main/js-src/`, regenerate `kanban.js` using `python3 tools/build_kanban_js.py` and verify with `python3 tools/build_kanban_js.py --check`.
4. For Kotlin or Android changes, run `gradle :app:assembleDebug --no-daemon` with JDK 17 / Android SDK 35 when the build environment is available. Otherwise explicitly state the build was **not verified**.
5. Check light and dark themes, status/navigation bar insets, and narrow Android screens when changing UI.
6. Preserve package ID `com.kanban.offline` and stable APK signing; never commit production keystores or secrets.
7. Do not introduce network access or unsafe WebView JavaScript bridges without review.
8. Report files changed, tests actually executed, remaining limitations, and a commit link.

Do not bypass failing tests, invent success, or silently delete user data.
