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

`test/real-roam/screenshots.mjs` takes the README's pictures the same way (CI: `.github/workflows/screenshots.yml`): it uploads the made-up files drawn by `test/real-roam/demo-files.mjs`, takes the pictures at 2x into `docs/images`, cancels both delete confirmations and removes its files and pages again. The workflow commits the pictures and re-pins the README's image links to that commit.

## Releasing to Roam Depot

- Every feature is in the README with a picture. A new feature gets a step in `screenshots.mjs` and a picture in the README.
- Run the Screenshots workflow on the release branch before the release, so the pictures show the build being released. Its commits get no checks, so the last commit of a release must not be the workflow's.
- README image links are absolute and pinned to a commit (Roam Depot shows the README).

## Architecture

- `src/files.ts`: pure functions. Finds Roam-hosted file URLs in block text, groups them by storage path, sorting, size format.
- `src/scan.ts`: finds the blocks whose text has a firebasestorage URL. Which blocks: one datalog query, asked of Roam's backend (`roamAlphaAPI.data.backend.q`, off the window's thread; Roam runs it in the window itself for an encrypted, local or offline graph). The blocks themselves: `pull_many` in the window, 100 at a time with a pause between. The check before a delete (`keysAnywhere`) always searches in the window.
- `src/store.ts`: IndexedDB `roam-file-manager`: `meta` (size, upload time, original name from Firebase Storage metadata) and `seen` (files found in blocks, per graph).
- `src/app.ts`: scan + store + view. Delete goes through `roamAlphaAPI.file.delete` after a fresh scan.
- `src/view.ts`: the table. `videoStill(row, cls)` / `videoStillUrl(row)` give a video's still (first frame, decoded once, kept in IndexedDB; the icon when this browser has no decoder, e.g. HEVC on Linux): use them wherever a video needs a picture. Plain DOM with Roam's own All Pages classes (`rm-all-pages`, `rm-pages-row`, ...), virtual rows.
- `src/index.ts`: `onload`/`onunload`. Registers the view with `roamAlphaAPI.ui.mainWindow.registerComponent(id, Component)` and opens it with `openComponent(id)`; adds the left sidebar row.

## Facts about Roam uploads (measured)

- An upload is stored at `imgs/app/<graph>/<10-char id>.<ext>` in Firebase Storage; its download URL is written into the block (`![](url)`, `{{[[pdf]]: url}}`, `[name](url)`, ...).
- The URL without its query string returns JSON metadata (size, timeCreated, `metadata.file-name`), no sign-in needed.
- Listing a graph's folder is denied (403), so unused files can only be found by remembering files seen in blocks.
- `roamAlphaAPI.file.upload` returns markdown, not a bare URL. `file.delete({ url })` needs the bare URL.

## Reading a large graph (measured in the help graph: 13,495 blocks, 541 with a file)

- One query in the window for the file blocks with their pages froze Roam for about 30 ms: 7 ms to read every block's text (0.55 ms per 1,000 blocks, grows with the graph) and the rest to join the 541 matches.
- `data.backend.q` answers in about 290 ms with the window free, then parsing the answer takes about 13 ms for 541 uids (40 ms for 13,495). `pull_many` of 100 blocks by uid takes 4 ms. So the freeze no longer grows with the graph, only with the number of file blocks.
- The backend can lag the window, so an open list reads the graph again 3 s and 10 s after opening (`READ_AGAIN` in `src/app.ts`).
- Slicing the query by pages doesn't help: datascript scans every `:block/page` datom for each slice.
- Not measured on a large graph: the test account has no plan, so it can't make a graph (a local graph opened by its address is read-only). Roam's engine scales linearly with rows up to 2 million (made-up rows passed in as a query input).

## Rules

- Follow Roam's existing UI patterns and class names. No invented text: no empty states, hints or tooltips.
- Never delete a file without the user confirming. A file that blocks still mention can be deleted (Matthew, 2026-11-22), but only behind the warning in the confirmation (broken images, can't be undone), and Enter must not confirm it.
- The help-graph test must never confirm a delete: those are Roam's own files.
- Waiting (Matthew, 2026-11-22): something custom for this view, not Roam's toast. A box with a progress bar in the middle of the view, the list dimmed and locked under it, while the first open fetches sizes (`FilesView.progress`), and while a sort predicted to take over 250 ms runs. No text in it.
- Words come from Roam's All Pages: a file's uses are its Mentions. The count opens the blocks in the right sidebar and the list stays open, as All Pages does.
