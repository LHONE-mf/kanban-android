# Android smoke-test checklist

For development testing, use a **successful APK workflow on the `ui-testing`
branch** (not an unverified commit). For release acceptance, use the approved
release build. If you already have app data, **do not uninstall the existing
app** just to update it: uninstalling may erase locally stored boards and
attachments. Make an export backup first. If Android reports a signing
conflict, do not uninstall to work around it; report the error instead.

## 1. Launch and offline behavior
- [ ] Launch with internet enabled; app opens without a blank screen.
- [ ] Turn on airplane mode, force-close and reopen; boards and tasks still load.
- [ ] Switch between Kanban, dashboard, mind map and calendar without errors.

## 2. Data safety
- [ ] Export a full backup and keep the file.
- [ ] Create a test board, three tasks, a checklist item, a tag and a deadline.
- [ ] Force-close and reopen; all test data is present.
- [ ] Move a task to Done; verify due-today and due-week filters exclude it.
- [ ] Import a backup only after checking the import preview/warnings; verify restored content.

## 3. Shared visual design
- [ ] Compare buttons on the board, task editor, settings and Japanese screen.
- [ ] Test both light and dark themes: readable labels, icons and button states.
- [ ] Open task editor, settings, confirmation and attachment preview; dialog
      colors, corners, form fields and action buttons match the main screen.
- [ ] Open 'New board' and 'Add mind-map node': the app-styled name dialog appears,
      not an Android browser prompt.
- [ ] Cancel a name dialog and confirm nothing was created.
- [ ] Type a name and submit; item is created.
- [ ] With Android keyboard open, verify Save/Cancel remain reachable by scrolling.
- [ ] Rotate the phone (if enabled); dialogs do not clip offscreen.
- [ ] Check text size/accessibility settings; buttons and labels remain readable.

## 4. Task workflow
- [ ] Add a task through quick-add and through the full task editor.
- [ ] Edit task title, description, priority, deadline, checklist and tags.
- [ ] Move a task between columns; drag/drop and task opening still work.
- [ ] Test undo where offered.
- [ ] Add an image or audio attachment and reopen it.
- [ ] Rename an audio recording using the styled dialog.

## 5. Japanese learning
- [ ] Switch hiragana/katakana; force-close and reopen; selection is remembered.
- [ ] Complete several quiz questions; score persists after reopening.
- [ ] Switch scripts during a quiz; question changes to the chosen script.
- [ ] Test writing canvas and dark theme.
- [ ] Navigate away and back; progress remains saved.

## 6. Search and navigation accessibility (physical Android device)
- [ ] With TalkBack enabled, swipe through all five navigation tabs. Each
      should announce its name, tab role and selected state.
- [ ] Double-tap Search, enter a task title and traverse results. Each result
      should announce the task and board; open one from another board.
- [ ] Edit a task and use Android Back. The editor should close without
      losing edits or leaving TalkBack focus behind a closed dialog.
- [ ] Increase Android font/display size and verify tab scrolling, Search,
      filters and editor controls remain reachable.
- [ ] With a hardware keyboard, Left/Right and Home/End navigate tabs and
      Enter/Space still activate controls; touch must remain functional.
- [ ] Turn TalkBack off; verify quick-add, Search and task editing again.

## Reporting bugs
Include: device model, Android version, light/dark theme, screen name,
steps to reproduce, expected vs actual result, and a screenshot or screen recording.
Avoid sharing exported backups publicly: they can contain private task information.
