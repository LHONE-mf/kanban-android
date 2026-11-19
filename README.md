# Kanban Android

An Android wrapper for the **existing single-file Kanban HTML application**, using Kotlin and Android WebView. The full Kanban UI is bundled in `app/src/main/assets/kanban.html`.

## Current state

- Full Kanban UI integrated (tasks, boards, calendar, mind map, etc.).
- Local app assets are loaded using `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/kanban.html`.
- JavaScript and DOM storage enabled for the local application.
- GitHub Actions builds a **debug APK** and publishes it as a workflow artifact.
- Experimental native BLE direct chat is included: foreground discovery/advertising, peer selection, and short GATT write messages. **No encryption, authentication, delivery guarantees, or multi-hop mesh yet. Do not send sensitive messages.**
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

## Experimental nearby chat

On two Android phones, install the same APK. Enable Bluetooth (and location services on Android 10/11 if required), tap **Bluetooth chat** then **Start discovery and advertising** on both phones, grant the permissions, select the other device from the peer list, and send a short message (up to 100 UTF-8 bytes). Keep the chat screens open. This is an early prototype and has **not been tested on physical devices**. Bluetooth hardware may not support advertising on every phone. Stop nearby when finished.

## Bluetooth plan

1. Implement a native BLE discovery/connection layer with Android 12+ runtime permissions and an app-specific message transport.
2. Add a secure, origin-restricted JavaScript↔Kotlin messaging bridge.
3. Add peer identities, conversation storage, encryption, and offline queueing.
4. Add relay with TTL, message deduplication, and explicit forwarding controls.
5. Test on at least three physical Android phones; evaluate background restrictions and battery use.

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

## ★ Comrade — встроенный локальный помощник Kanban (эксперимент v0.3.0)

Новый чат открывается поверх доски. **Данные Kanban остаются в прежнем IndexedDB**,
никакой миграции или очистки БД нет. Пакет `com.kanban.offline` и постоянная
подпись обновлений сохранены.

- Прямые команды «Покажи просроченные задачи», «Добавь задачу проверить электроды завтра»,
  «Закрой задачу проверить электроды» работают без запуска модели.
- Для остальных команд выберите GGUF 1–2B Q4 один раз через кнопку Comrade.
  Файл копируется в приватное хранилище Kanban, при открытии APK сама модель
  **не загружается в RAM**. Она загружается при сложном сообщении и выгружается
  при закрытии чата. После четырёх обращений обновляется контекст.
- Модель получает небольшой список досок и задач (локально, без облачного API),
  предлагает только `list`, `create`, `complete`, `move` либо уточнение.
  Модель **не может исполнять SQL/JS** или напрямую менять базу.
- Создание и изменение задачи **требуют подтверждения**. Удаление через чат
  не разрешено. Сами изменения сохраняются существующим IndexedDB API.
- Приложение Comrade и Kanban используют разные Android-песочницы, поэтому
  импортированный в Comrade GGUF нужно будет один раз выбрать и в Kanban.
- Обновлена минимальная версия до Android 11 (`minSdk=30`) из-за AiKit.
  Модель не включена в APK. Для свободных запросов без GGUF ассистент попросит
  импортировать модель. Нет доступа к другим программам или автоматической
  фоновой генерации.

### Проверка на телефоне

Проверить статус GitHub Actions и скачать подписанный `kanban-debug-apk`.
**Не удаляйте старую установку и не очищайте её данные.**
Откройте Comrade, проверьте список задач без модели, затем создание тестовой
задачи с подтверждением. Сравните доску после возвращения в Kanban.
После этого импортируйте GGUF 1–2B и проверьте запрос свободным языком.

## Comrade AI task manager (v0.4.0)

Kanban is now branded **Comrade** without changing `applicationId=com.kanban.offline`,
the existing stable signing certificate, IndexedDB origin, or the Japanese-learning
data stored in app preferences. **Install as an update; never uninstall the original
app or clear app data.**

Press **★ AI** in the main toolbar. Short phrases are handled without loading any
neural network. For other phrases, select a local GGUF file, preferably a small
instruction-tuned **0.8–2B Q4** model; this APK does not download or bundle models.
Current AiKit 1.0.0 compatibility varies by GGUF architecture; the lightweight
Qwen3-1.7B is a starting candidate, not a measured performance guarantee.
The model only turns free language into a restricted action plan: it cannot run
JavaScript, query IndexedDB directly or delete tasks.

Available actions: list open/today/overdue tasks, search by words, create task,
mark complete, move between columns, update deadline/priority/title/description,
create a subtask. Mutations require an explicit user instruction and a separate
**Confirm** click. The model sees a bounded selection of relevant task titles
and board names (maximum 12 tasks). Any unrecognised or ambiguous operation
is refused or clarified; no automatic deletion or bulk database changes.
A local **Журнал** button shows up to 50 successful confirmed changes.

Native engine is initialised only when an LLM command is needed. It is unloaded
when chat closes, the Android app backgrounds, or after 90 seconds idle.
Model selection is persisted privately and switching GGUF does not change the
Kanban database. The old separate Comrade app's model files and SQLite
are **not automatically migrated** into Kanban/Comrade.

Privacy: no internet permission added, no server calls, no background agent.
No guarantee of accurate parsing for every human instruction; check the
confirmation before approving any write. PWA/web version supports direct
rule-based commands without native LLM.
