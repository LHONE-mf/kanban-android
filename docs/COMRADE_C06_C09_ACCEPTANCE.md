# Comrade C-06–C-09 — media stabilization and Android acceptance

## Scope and data safety
This candidate branches from `main` at `acf729aeaaa457fb376c71c62edf605c7665d8e6`.
It changes only attachment handling, viewer UI, scoped Android file handoff, tests and docs.

Do **not** uninstall the installed app, clear data/cache, change signing or package ID
`com.kanban.offline`, overwrite production files or merge/release without approval.
Offline boards, saved tasks, original attachment blobs and Japanese progress remain on-device.

## C-06 — Multiple file selection
- Android chooser explicitly permits multiple selection and gathers *all* URIs from
  `ClipData`, `data` and WebView's parser, deduplicating equivalent URIs.
- Each picker round appends to the editor's pending file list. The 50 MB per-file
  limit is enforced; no blob enters IndexedDB until Save.
- If saving fails, the task remains editable and any staged blobs are cleaned up.
- Test: select three different files, then select two more without saving.
  Five items should appear and persist after a single Save and app restart.

## C-07 — Photograph compression
- Already-small photos (up to 2 MiB) remain unchanged.
- Larger JPEGs are resized to max 1600 px and adaptively encoded. If the image
  remains too large, lower quality and max 1200 px are tried, never increasing
  the stored file size. The 1–2 MB target is **best effort**, not a guarantee.
- PNG/HEIC/WebP avoid an opaque white canvas and are encoded as WebP only where
  supported; otherwise the original file is retained. Converted WebP filenames
  get a .webp extension to match the actual blob format.
- Test an ordinary 10–15 MB JPEG, a transparent PNG, and a small JPEG.
  Inspect the saved sizes, image clarity, transparency, and reopen each.

## C-08 — Gallery viewer
- Explicit 44 px Close, Previous, Next and Zoom buttons.
- Swipe left/right to navigate when unzoomed. Two-pointer pinch controls image
  zoom (up to 5x), one-pointer drag pans while zoomed.
- Previous blob URLs are revoked on navigation and close; stale async loads
  cannot replace the newly selected image.
- Test with 3+ images, rapid swipes, pinch in/out, Android Back, video preview,
  light/dark themes and portrait/landscape. Check controls aren't hidden by bars.

## C-09 — Opening documents on Android
- A trusted-origin, main-frame-only `KanbanFileOpen` listener accepts bounded,
  ordered 32 KiB chunks and stores only a temporary private cache copy.
- Android uses `ACTION_VIEW` and `FileProvider` read-only URI grants, without
  sharing the internal IndexedDB file or granting write permissions.
- Maximum single attachment size: 50 MiB. A transfer must finish with its
  expected byte count; aborted/invalid transfers delete partial temp copies.
- Test PDF, text and office documents. Choose a capable app from the Android
  chooser, return to Comrade, reopen and verify the stored attachment unchanged.
  Test missing viewer, simultaneous requests, large files and offline mode.

## Automated verification
The GitHub Actions APK workflow includes:
- Existing Python/JavaScript regressions, signed APK and Kotlin compilation.
- `tests/test_multiple_attachments.js`
- `tests/test_photo_compression.js`
- `tests/test_lightbox_gallery.js`
- `tests/test_native_file_open.js`
- FileProvider path-restriction checks.

CI is **not** proof of physical Android gesture/SAF/third-party app compatibility.
Do not merge to main or publish until separately approved; no deployment here.
