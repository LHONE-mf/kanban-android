# Development APK signing

The adjacent `kanban-debug.keystore.b64` contains a **publicly shared, development-only**
Android debug signing key. The GitHub Actions workflow restores it to
`~/.android/debug.keystore` before running `assembleDebug`.

This allows successive debug APKs built by this repository to update one
another, provided their package ID remains `com.kanban.offline` and their
versionCode increases. The key is deliberately NOT private: **never use this
key to sign a production release or a Play Store build.**

The first APK built with this key cannot update an app installed from an older
ephemeral CI debug key. Uninstall that old app once (after exporting any data).
After installing the new development APK, later development builds can update
it in place.

The optional release APK is signed separately using the repository's four
`KANBAN_*` signing secrets; that release key must remain private. A release
APK signed with a different certificate cannot update the debug APK.

To verify the APK on a build runner:
```sh
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs app/build/outputs/apk/debug/app-debug.apk
```
