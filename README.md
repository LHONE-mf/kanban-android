# Kanban Android

An offline Kanban application using Kotlin and Android WebView, with boards,
nested tasks, attachments, reminders and Japanese learning. The web UI is
bundled locally under `app/src/main/assets/`.

## Current state

- Full Kanban UI integrated (tasks, boards, calendar, mind map, etc.).
- Local app assets are loaded using `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/kanban.html`.
- JavaScript and DOM storage enabled for the local application.
- GitHub Actions builds a **debug APK**, verifies its stable development signing
  certificate and package ID, and publishes it as a workflow artifact.
- Automated Android emulator checks cover startup, navigation, search and
  persistence. Physical OnePlus and TalkBack acceptance remains open. See
  [development status](docs/DEVELOPMENT_STATUS.md) for exact evidence and remaining work.

## Get the APK

Open [Actions](https://github.com/LHONE-mf/kanban-android/actions), select a
successful **Android APK** run on `ui-testing` and download `kanban-debug-apk`.
Check the commit and its Android smoke result before installing. Unzip the
artifact and install the APK as an update over the existing app. Export a full
backup first. If Android reports a signing conflict, keep the existing app and
report the error; uninstalling can erase local data. The development APK is for
testing. See [Android testing](TESTING_ANDROID.md).

## Development

Edit `app/src/main/assets/kanban.html` and `kanban.css` for markup/styles, and
`app/src/main/js-src/` for JavaScript. Rebuild the generated bundle after source
changes:

```bash
python3 tools/build_kanban_js.py
python3 tools/build_kanban_js.py --check
node --check app/src/main/assets/kanban.js
```

Android-specific code is under `app/src/main/java/com/kanban/offline/`.
Read [AGENTS.md](AGENTS.md) and the regression commands in
[the APK workflow](.github/workflows/android.yml) before changing code.

Build locally with JDK 17, Android SDK 35, Gradle 8.9:

```bash
gradle :app:assembleDebug
```

## Data migration

The Android WebView has **different IndexedDB storage** from Chrome. Export a JSON backup from the browser version before switching, and import it into the APK after checking file-picker support. Do not uninstall the browser app or delete its data until migration has been verified.

## Permanent signing and installable updates

Android accepts an APK update only if the **applicationId stays
`com.kanban.offline`**, the **signing certificate stays the same**, and the
**versionCode increases**. This repository's APK workflow restores the existing
stable development key and uses its workflow run number as `versionCode`.
Keep that signing identity for updates to existing development installations.
This development key is not a private production release key.

### Optional production release signing setup

Changing to a production release key is a separate migration decision. A new
certificate cannot update an installation signed with the development key.
Do not replace existing signing keys as part of routine development.

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

After all four secrets exist, **Actions → Android APK → Run workflow** also
builds and uploads **`kanban-signed-release-apk`**. Subsequent release updates
must use that same release certificate and a higher workflow run number.

**Existing installation:** If an APK cannot update it because the certificates
differ, preserve the installation and its exported backup. Recover the original
signer or agree on a separately verified migration. Uninstalling is not a
routine update step.

**Critical:** Keep an offline backup of the keystore and passwords. Losing the signing key prevents updates to installations signed with it. Never put signing secrets in public repository files.
