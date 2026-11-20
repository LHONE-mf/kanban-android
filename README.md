# Comrade — offline Android Kanban

The original Kanban application remains: boards, cards, priorities, deadlines,
attachments, calendar, mind map, Pomodoro timer, import/export and Japanese lessons.
Comrade is a standalone offline task manager.

## 🔥 Мой день
The standalone day planner lists unfinished tasks from all boards, sorts by
deadline and priority, and lets you choose and reorder tasks. Saving never changes
task titles, boards, deadlines or priorities. Previously saved day plans are kept
under the compatible settings key `comrade_day_plan_v1`.

## Updates without losing local data
Android app ID stays `com.kanban.offline` with the same stable signing key.
Download a standalone Comrade.apk via
[Releases](https://github.com/LHONE-mf/kanban-android/releases/latest)
and install OVER the existing app. Do not uninstall or clear its data.
On launch the app removes only the obsolete private cached GGUF at
`filesDir/kanban_comrade/active.gguf` and its model filename preference.
An original model in Downloads/Documents is never touched.

## Development
The JS bundle is built with `python3 tools/build_kanban_js.py`.
Tests and the Android APK are produced by GitHub Actions using JDK 17,
Gradle 9.3.1 and Android SDK 37. No physical-device validation is implied.

## Comrade 0.4.9: original icon and Android Back

The launcher and web icon reuse byte-for-byte the original PNG image files
from `LHONE-mf/comrade-`, including the adaptive foreground and five screen
densities. No new icon design is used. Android system Back first asks the
local page to handle visible dialogs. In the task editor it invokes the same
atomic Save as the Save button; validation or storage failure leaves the
editor open, preventing accidental exit. Japanese lessons Back returns to
Kanban. No change to installed data, package ID, or signing identity.
