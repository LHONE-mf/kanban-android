# Kanban Android

An Android wrapper for the **existing single-file Kanban HTML application**, using Kotlin and Android WebView. The full Kanban UI is bundled in `app/src/main/assets/kanban.html`.

## Current state

- Full Kanban UI integrated (tasks, boards, calendar, mind map, etc.).
- Local app assets are loaded using `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/kanban.html`.
- JavaScript and DOM storage enabled for the local application.
- GitHub Actions builds a **debug APK** and publishes it as a workflow artifact.
- **Bluetooth messaging and multi-hop mesh are not yet implemented.**
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

## Bluetooth plan

1. Implement a native BLE discovery/connection layer with Android 12+ runtime permissions and an app-specific message transport.
2. Add a secure, origin-restricted JavaScript↔Kotlin messaging bridge.
3. Add peer identities, conversation storage, encryption, and offline queueing.
4. Add relay with TTL, message deduplication, and explicit forwarding controls.
5. Test on at least three physical Android phones; evaluate background restrictions and battery use.
