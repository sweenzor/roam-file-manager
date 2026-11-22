# roam-file-manager

Roam Research extension: a "Files" view of the graph's uploaded files (sort, search, find unused, delete).

## Build and test

```
npm install
npm run typecheck
npm test                    # node --test on test/*.test.ts
npm run build               # esbuild src/index.ts -> extension.js (ES module, gitignored)
node test/help-graph.mjs    # built extension in Roam's public help graph, headless Playwright, no sign-in
```

`test/real-roam/run.mjs` drives Roam's Linux desktop app, signed in to a hosted test graph (CI: `.github/workflows/real-roam.yml`, needs `ROAM_EMAIL` / `ROAM_PASSWORD` secrets). It uploads and deletes files, which the help graph can't.

## Architecture

- `src/files.ts`: pure functions. Finds Roam-hosted file URLs in block text, groups them by storage path, sorting, size format.
- `src/scan.ts`: one datalog query for every block whose text has a firebasestorage URL.
- `src/store.ts`: IndexedDB `roam-file-manager`: `meta` (size, upload time, original name from Firebase Storage metadata) and `seen` (files found in blocks, per graph).
- `src/app.ts`: scan + store + view. Delete goes through `roamAlphaAPI.file.delete` after a fresh scan.
- `src/view.ts`: the table. `videoStill(row, cls)` / `videoStillUrl(row)` give a video's still (first frame, decoded once, kept in IndexedDB; the icon when this browser has no decoder, e.g. HEVC on Linux): use them wherever a video needs a picture. Plain DOM with Roam's own All Pages classes (`rm-all-pages`, `rm-pages-row`, ...), virtual rows.
- `src/index.ts`: `onload`/`onunload`. Registers the view with `roamAlphaAPI.ui.mainWindow.registerComponent(id, Component)` and opens it with `openComponent(id)`; adds the left sidebar row.

## Facts about Roam uploads (measured)

- An upload is stored at `imgs/app/<graph>/<10-char id>.<ext>` in Firebase Storage; its download URL is written into the block (`![](url)`, `{{[[pdf]]: url}}`, `[name](url)`, ...).
- The URL without its query string returns JSON metadata (size, timeCreated, `metadata.file-name`), no sign-in needed.
- Listing a graph's folder is denied (403), so unused files can only be found by remembering files seen in blocks.
- `roamAlphaAPI.file.upload` returns markdown, not a bare URL. `file.delete({ url })` needs the bare URL.

## Rules

- Follow Roam's existing UI patterns and class names. No invented text: no empty states, hints or tooltips.
- Never delete a file without the user confirming. A file that blocks still mention can be deleted (Matthew, 2026-11-22), but only behind the warning in the confirmation (broken images, can't be undone), and Enter must not confirm it.
- The help-graph test must never confirm a delete: those are Roam's own files.
- Words come from Roam's All Pages: a file's uses are its Mentions. The count opens the blocks in the right sidebar and the list stays open, as All Pages does.
