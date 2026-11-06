# Kanban Android

Android WebView host for the existing single-file Kanban app, with a planned native offline Bluetooth messaging module.

## Status

Initial Android project scaffold. **The original Kanban HTML has not yet been committed to this repository**, and Bluetooth messaging is not implemented. The APK is not ready for use until the HTML asset is added and the build passes.

## Build

GitHub Actions runs Gradle 8.9 / JDK 17 and uploads the debug APK. Local command: `gradle :app:assembleDebug` with Android SDK 35.

## Architecture

`app/src/main/assets/kanban.html` is the single-file UI. Kotlin uses `WebViewAssetLoader` for local HTTPS-origin assets. Future BLE messaging must use a native module with secure WebView messaging, Android runtime permissions, message IDs, TTL, deduplication and encryption.

## Data migration

Chrome and the APK have separate IndexedDB storage. Export your Kanban data in Chrome and import it into the Android app after the UI is integrated.
