# Kanban JavaScript structure

The Android WebView loads `app/src/main/assets/kanban.js` as **one** script.
That generated file is assembled from these ordered source files:

1. `app/src/main/js-src/core.js` — constants, state, database, utilities, filtering.
2. `app/src/main/js-src/views.js` — board rendering, mind map, calendar, dashboard.
3. `app/src/main/js-src/tasks.js` — task operations, task modal, atomic save, focus trap.
4. `app/src/main/js-src/media-dialogs.js` — image processing, lightbox, settings, confirmations, toasts and theme.
5. `app/src/main/js-src/data-transfer.js` — import, export and board clearing.
6. `app/src/main/js-src/interactions.js` — drag-and-drop, event bindings and quick add.
7. `app/src/main/js-src/android-extras.js` — timer, service worker, audio and initialization.

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
