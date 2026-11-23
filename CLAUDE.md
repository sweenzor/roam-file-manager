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
- `src/scan.ts`: finds the blocks whose text has a firebasestorage URL. Which blocks: one datalog query for their uids, the only step that reads every block's text. The blocks themselves: `pull_many`, 100 at a time with a pause between.
- `src/local.ts`, `src/transit.ts`: a local graph's files through Roam's desktop app (list, delete), Transit as Roam's page speaks it.
- `src/store.ts`: IndexedDB `roam-file-manager`: `meta` (size, upload time, original name from Firebase Storage metadata) and `seen` (files found in blocks, per graph).
- `src/app.ts`: scan + store + view. Delete goes through `roamAlphaAPI.file.delete` after a fresh scan.
- `src/view.ts`: the table. `videoStill(row, cls)` / `videoStillUrl(row)` give a video's still (first frame, decoded once, kept in IndexedDB; the icon when this browser has no decoder, e.g. HEVC on Linux): use them wherever a video needs a picture. Plain DOM with Roam's own All Pages classes (`rm-all-pages`, `rm-pages-row`, ...), virtual rows. `state.grid` draws the same rows as tiles (thumbnail view): same selection and virtual drawing, several files to a line. A video's tile is its still alone until the pointer is on it or it is clicked; then it gets the browser's controls and plays in place (an idle `<video controls>` gets a loading circle drawn over it for good in Roam's desktop app). Tiles have no columns, so the header row is hidden and the toolbar carries a select-all box by the trash and one sort button beside the search. That button and its menu copy Roam's own card grid, the extension browser in Settings > Roam Depot (measured signed in, 2026-11-22): `button.bp3-button.bp3-icon-standard.bp3-minimal.bp3-icon-sort` right after the search input, opening `ul.bp3-menu` with two items per field ("Downloads (high to low)", "Created (newest first)", "Alphabetical (A to Z)"), `li.bp3-menu-divider` between fields, the one in use `bp3-active bp3-intent-primary`.
- `src/index.ts`: `onload`/`onunload`. Registers the view with `roamAlphaAPI.ui.mainWindow.registerComponent(id, Component)` and opens it with `openComponent(id)`; adds the left sidebar row.

## Facts about Roam uploads (measured)

- An upload is stored at `imgs/app/<graph>/<10-char id>.<ext>` in Firebase Storage; its download URL is written into the block (`![](url)`, `{{[[pdf]]: url}}`, `[name](url)`, ...).
- The URL without its query string returns JSON metadata (size, timeCreated, `metadata.file-name`), no sign-in needed.
- Listing a graph's folder is denied (403), so unused files can only be found by remembering files seen in blocks.
- `roamAlphaAPI.file.upload` returns markdown, not a bare URL. `file.delete({ url })` needs the bare URL.

## Local graphs (measured, Roam desktop 0.0.42, 2026-11-23)

- An upload to a local graph (`#/offline/<name>`, writable on a paid account) is written as `local-asset://<graph>/<10-char id>.<ext>` (images `![](…)`, pdf/audio/video `{{[[pdf]]: …}}`, other files the bare address: no original name is kept anywhere). The desktop app stores it in `~/.config/Roam Research/local-graph-uploads/<graph>/uploads/` and serves it at `http://127.0.0.1:<server-port, 3333>/local-asset/<graph>/<file>` with CORS `*` (no Content-Length); Roam's blocks draw from there, canvas reads of pictures and video frames work.
- `roamAlphaAPI.file.delete` throws "delete-file is not available for offline graphs"; `file.get` asserts. Roam's own Settings > Attachments lists and deletes through the desktop app's main process: `window.postMessage({msgType: 'roam-electron-renderer-message-to-main', dataInTransit: <transit>})`, answered by a `roam-electron-main-message-to-renderer` message. `src/local.ts` asks the same two things (`:roam.files/graph-files` for `{:relemma/graph-name g}`: name, size, upload-t, mime-type, download-url; mutation `roam.electron/delete-graph-file` with the file id: `{:roam.files/deleted true|false}`). Recorded answers in `test/transit.test.ts`.
- In the browser, `file.upload` in a local graph throws: only the desktop app has local files. `src/scan.ts` looks for both address kinds in a local graph, only firebasestorage in a hosted one.
- `test/real-roam/local.mjs` (second step of Real Roam) makes a new local graph on the runner each run.

## Reading a large graph (measured in the help graph: 13,495 blocks, 541 with a file)

- A query in the window stops Roam for as long as it runs (`async.q` too). One query for the file blocks with their pages took 30 ms: 7 ms to read every block's text (0.55 ms per 1,000 blocks, grows with the graph) and the rest to join the 541 matches. So the query now asks for uids only, and the blocks are read with `pull_many`, 100 at a time (4 ms each).
- Scans nobody asked for (8 s after load, every 10 minutes) wait until nothing was typed or clicked for 3 s (`QUIET_MS` in `src/index.ts`).
- Roam's engine scales linearly with rows, up to 2 million made-up rows passed in as a query input (that path is 14 times slower per row than the graph's own index, so its absolute times mean nothing).
- Slicing the query by pages doesn't help: for a list of pages datascript scans every `:block/page` datom per slice; one page at a time uses the index but costs 0.3 ms a page.
- `roamAlphaAPI.data.backend.q` (documented: "run against the backend (off thread)", runs locally when the graph has no backend, is encrypted or offline) answers in about 290 ms with the window free until the answer is parsed (13 ms for 541 uids). Not used: it reads the backend's copy of the graph, and whether that keeps up with a block written a second ago is not established. A build that used it failed Real Roam and Screenshots on 2026-11-22 (reason not pinned down); `run.mjs` logs what the backend answers next to the window, for the record.
- Real Roam, hosted test graph filled to 20k / 100k / 300k blocks with 2,000 file links (Big graph run on c81a341, 2026-11-22): the uid query froze the window 23 / 71 / 228 ms (the old one-query form 63 / 131 / 388), reading the blocks 4 to 7 ms a chunk, opening Files froze it 0.2 / 0.6 / 0.8 s at the longest (All Pages: 0.06 / 0.12 / 0.18 s). `backend.q` answered in 124 / 490 / 1507 ms and froze nothing at the first two sizes; in Real Roam it had a block written seconds earlier. Sort and search on 2,000 files: no stall.
- After that run had added and deleted 300,000 blocks, the hosted graph took over 3 minutes to open once ("Your graph is taking quite a bit of time to load ... magic to make it fast again"), and Real Roam failed meanwhile; then it opened in 2 s again. So a push only runs the script's clean-up check; a fill is a run by hand, with nothing else needing the graph for the next half hour.
- `test/real-roam/big-graph.mjs` (the Big graph workflow) times all this in real Roam at several graph sizes. On a local graph of up to a million blocks when the test account can make one (it can since it got a plan on 2026-11-23; before that Roam answered "To create new local graphs you must choose a plan"). Otherwise on the hosted test graph, up to 300,000 blocks, on pages titled `rfm-big …` that it deletes again and checks are gone after a reload (`clean only` input for leftovers). It shares the `real-roam` concurrency group, and that group keeps only one waiting run: a push must not start more than two of Real Roam, Screenshots and Big graph.

## Rules

- Follow Roam's existing UI patterns and class names. No invented text: no empty states, hints or tooltips.
- Never delete a file without the user confirming. A file that blocks still mention can be deleted (Matthew, 2026-11-22), but only behind the warning in the confirmation (broken images, can't be undone), and Enter must not confirm it.
- The help-graph test must never confirm a delete: those are Roam's own files.
- Waiting (Matthew, 2026-11-22): something custom for this view, not Roam's toast. A box with a progress bar in the middle of the view, the list dimmed and locked under it, while the first open fetches sizes (`FilesView.progress`), and while a sort predicted to take over 250 ms runs. No text in it.
- Words come from Roam's All Pages: a file's uses are its Mentions. The count opens the blocks in the right sidebar and the list stays open, as All Pages does.

## Test account plan

Real-Roam CI signs in to a Roam test account with a Believer plan (without a plan its local graphs are read-only). Each signed-in real-Roam run (`test/real-roam/run.mjs`) reads the plan from Roam's Billing page with `test/real-roam/plan.mjs` (account menu > Billing on the graph list, else Settings > Account > Open Billing) and fails if it isn't Believer or ends within a year.

## Local graphs

`test/real-roam/local-graph.mjs` (Local graph workflow, runs on a push that changes it) makes a local graph by going to `#/offline/<name>`, in a browser and the desktop app, writes to it, checks it survives a restart, and tries Files there. In a local graph an upload is stored as `local-asset://<graph>/<id>.<ext>`, not in Firebase Storage, so Files does not list it (measured 2026-11-23). Pictures are taken inside the graph only (Roam's graph list shows the account's email), with anything like an email covered, and the workflow drops any picture where text recognition finds an @ before committing.
