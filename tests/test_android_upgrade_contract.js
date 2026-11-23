// P8: guard the compatibility contract required for an in-place Android upgrade.
// These static checks do not claim that a real on-device upgrade was executed.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path,'utf8');
const gradle = read('app/build.gradle.kts');
const manifest = read('app/src/main/AndroidManifest.xml');
const activity = read('app/src/main/java/com/kanban/offline/MainActivity.kt');
const core = read('app/src/main/js-src/core.js');
const japanese = read('app/src/main/assets/japanese.html');
const transfer = read('app/src/main/js-src/data-transfer.js');
const workflow = read('.github/workflows/android.yml');

// Same Android package ID, installation path and signing identity are mandatory.
assert.match(gradle, /applicationId\s*=\s*"com\.kanban\.offline"/);
assert.match(gradle, /namespace\s*=\s*"com\.kanban\.offline"/);
assert.match(gradle, /versionCode\s*=\s*System\.getenv\("KANBAN_VERSION_CODE"\)\?\.toIntOrNull\(\)\s*\?:\s*1/);
assert.match(gradle, /signingConfig\s*=\s*signingConfigs\.getByName\("stableDebug"\)/);
assert.match(gradle, /storeFile\s*=\s*file\(requireNotNull\(debugKeystore\)\)/);
assert.match(workflow, /KANBAN_DEBUG_KEYSTORE_PATH:[^\n]*\$\{\{ github\.workspace \}\}\/\.github\/keys\/kanban-debug\.keystore/);
assert.match(workflow, /base64 --decode \.github\/keys\/kanban-debug\.keystore\.b64/);
assert.match(workflow, /KANBAN_VERSION_CODE:\s*\$\{\{ github\.run_number \}\}/);
assert.match(workflow, /apksigner" verify --print-certs/);
assert.match(workflow, /test -n "\$ACTUAL" && test "\$ACTUAL" = "\$EXPECTED"/);
assert.match(workflow, /name='com\.kanban\.offline'/);
assert.match(manifest, /android:name="\.MainActivity"/);
assert.match(manifest, /android:allowBackup="false"/);
assert.match(manifest, /android:authorities="\$\{applicationId\}\.editablefiles"/);

// WebView IndexedDB and localStorage are tied to this stable origin and profile.
assert.match(activity, /private val appOrigin = "https:\/\/appassets\.androidplatform\.net"/);
assert.match(activity, /\.addPathHandler\("\/assets\/", WebViewAssetLoader\.AssetsPathHandler\(this\)\)/);
assert.match(activity, /settings\.domStorageEnabled = true/);
assert.ok(activity.includes('webView.loadUrl("$appOrigin/assets/kanban.html")'));
assert.doesNotMatch(activity, /WebView\.setDataDirectorySuffix\s*\(/);
assert.doesNotMatch(activity, /WebStorage\.getInstance\(\)\.deleteAllData\s*\(/);
assert.doesNotMatch(activity, /clearCache\s*\(true\)/);
assert.doesNotMatch(activity, /deleteDatabase\s*\(/);

// Keep the same DB name and object stores when updating the application.
for (const [name,value] of [
  ['DB_NAME','kanban_db_v2'],['DB_VERSION','1'],
  ['STORE_TASKS','tasks'],['STORE_SETTINGS','settings'],['STORE_MEDIA','media']
]) {
  const expected = name === 'DB_VERSION'
    ? new RegExp('const '+name+'\\s*=\\s*'+value+'\\s*;')
    : new RegExp('const '+name+'\\s*=\\s*\\x27'+value+'\\x27\\s*;');
  assert.match(core,expected,'storage invariant '+name);
}
assert.match(core, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
assert.match(core, /if \(!d\.objectStoreNames\.contains\(STORE_TASKS\)\)/);
assert.match(core, /if \(!d\.objectStoreNames\.contains\(STORE_SETTINGS\)\)/);
assert.match(core, /if \(!d\.objectStoreNames\.contains\(STORE_MEDIA\)\)/);
assert.doesNotMatch(core, /indexedDB\.deleteDatabase\s*\(/);
assert.doesNotMatch(core, /localStorage\.clear\s*\(/);
assert.match(core, /const LEGACY_KEYS\s*=\s*\['kanban_tasks_v2', 'kanban_tasks_v3', 'kanban_data_v4'\]/);
assert.match(core, /comrade_day_plan_v1/);

// Japanese progress has two different persisted stores, both must survive.
assert.match(activity, /getSharedPreferences\("japanese_daily", MODE_PRIVATE\)/);
assert.match(activity, /private fun createDailyBanner\(/);
assert.match(activity, /prefs\.getInt\("question_count", 0\)/);
assert.match(activity, /prefs\.getInt\("correct_count", 0\)/);
assert.match(activity, /prefs\.getString\("review_queue", ""\)/);
assert.match(transfer, /const JAPANESE_BACKUP_KEYS = \[/);
assert.match(transfer, /nativeJapanese:|nativeJapanese\)/);
assert.match(japanese, /kanban-japanese-hiragana-v1/);
assert.match(japanese, /kanban-japanese-script-v1/);

// Startup-only cleanup may remove obsolete model copies, not app data.
const cleanupStart = activity.indexOf('private fun removeOldModelCopy()');
const cleanupEnd = activity.indexOf('private val filePicker', cleanupStart);
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
const cleanup = activity.slice(cleanupStart,cleanupEnd);
assert.match(cleanup, /File\(filesDir,"kanban_comrade"\)/);
assert.match(cleanup, /File\(directory,"active\.gguf"\)\.delete\(\)/);
assert.match(cleanup, /File\(directory,"active\.gguf\.part"\)\.delete\(\)/);
assert.doesNotMatch(cleanup, /deleteRecursively\s*\(|clear\s*\(|japanese_daily|kanban_db_v2/);

// A build artifact is not a published APK without explicit workflow dispatch.
assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.publish_apk == true && github\.ref == 'refs\/heads\/main'/);
console.log('P8: stable Android package, signing, version, WebView origin, IndexedDB and Japanese storage contract passed.');
