# Kanban JavaScript structure

The Android WebView loads `app/src/main/assets/kanban.js` as **one** script.
That generated file is assembled from these ordered source files:

1. `app/src/main/js-src/core.js` — constants, state, database, utilities, filtering.
2. `app/src/main/js-src/views.js` — board rendering, mind map, calendar, dashboard.
3. `app/src/main/js-src/actions.js` — task actions, dialogs, import/export, events, audio, startup.

**Edit the source files, not the generated `kanban.js`.**

After editing, from the repository root:

```sh
python3 tools/build_kanban_js.py
python3 tools/build_kanban_js.py --check
```

Commit both the edited source and rebuilt `kanban.js`. The build uses only
Python's standard library and does not require internet access. The bundler
concatenates the sources byte-for-byte in order, preserving the existing IIFE,
shared lexical scope, startup order, offline behavior and local storage.

Do not replace this with separate ordinary HTML script tags: the sections
share `let` and `const` bindings and are not independent browser modules.
