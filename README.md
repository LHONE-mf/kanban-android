# Kanban Android

An Android wrapper for the **existing single-file Kanban HTML application**, using Kotlin and Android WebView. The full Kanban UI is bundled in `app/src/main/assets/kanban.html`.

## Current state

- Full Kanban UI integrated (tasks, boards, calendar, mind map, etc.).
- Local app assets are loaded using `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/kanban.html`.
- JavaScript and DOM storage enabled for the local application.
- GitHub Actions builds a **debug APK** and publishes it as a workflow artifact.
- **No on-device verification has been performed.**

## Get the APK

Open [Actions](https://github.com/LHONE-mf/kanban-android/actions), select the latest successful **Android APK** run and download the `kanban-debug-apk` artifact. Unzip and install the APK on an Android device. The debug build is for testing, not distribution.

## Development

Edit `app/src/main/assets/kanban.html` for the Kanban UI; it remains a single file. Android-specific code is under `app/src/main/java/com/kanban/offline/`.

Build locally with JDK 17, Android SDK 35, Gradle 8.9:

```bash
gradle :app:assembleDebug
```

## Data migration

The Android WebView has **different IndexedDB storage** from Chrome. Export a JSON backup from the browser version before switching, and import it into the APK after checking file-picker support. Do not uninstall the browser app or delete its data until migration has been verified.

## Permanent signing and installable updates

Android accepts an APK update only if the **applicationId stays `com.kanban.offline`**, the **signing certificate stays the same**, and the **versionCode increases**. GitHub's default debug signing key is ephemeral; do **not** use debug APKs for reliable future updates.

### One-time setup

Generate and **back up** a release keystore on a trusted machine with a JDK installed:

```sh
keytool -genkeypair -v -keystore kanban-release.jks -alias kanban -keyalg RSA -keysize 3072 -validity 10000
```

Use strong, unique passwords. Do not commit the keystore or send passwords in an issue or chat.

Encode the file to one line (macOS/Linux):

```sh
base64 < kanban-release.jks | tr -d '\\n'
```

Open GitHub repository **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
| --- | --- |
| `KANBAN_KEYSTORE_BASE64` | One-line base64 of `kanban-release.jks` |
| `KANBAN_STORE_PASSWORD` | Keystore password |
| `KANBAN_KEY_ALIAS` | `kanban` (or the alias you chose) |
| `KANBAN_KEY_PASSWORD` | Private-key password |

Trigger **Actions → Android APK → Run workflow**. After all four secrets exist, the workflow builds and uploads **`kanban-signed-release-apk`**. Install **only** that release APK for ongoing updates. Every subsequent workflow run uses the same certificate and a higher `versionCode` (GitHub workflow run number).

**Existing debug installation:** A release APK signed by a new key **cannot** update an existing debug-signed APK. First export a JSON backup from the old app, verify the backup exists, uninstall the old debug APK, install the signed release APK, then import the backup. Do not uninstall until your backup and import path are verified. This one-time migration is necessary unless the exact previous signing key can be recovered.

**Critical:** Keep an offline backup of the keystore and passwords. Losing the signing key prevents updates to installations signed with it. Never put signing secrets in public repository files.
