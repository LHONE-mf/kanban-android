# Android smoke-test checklist

Build/install the APK from the latest main branch. If you already have app data,
**do not uninstall the existing app** just to update it: uninstalling may erase
locally stored boards and attachments. Make an export backup first.

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

## Reporting bugs
Include: device model, Android version, light/dark theme, screen name,
steps to reproduce, expected vs actual result, and a screenshot or screen recording.
Avoid sharing exported backups publicly: they can contain private task information.
