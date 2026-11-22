# File Manager for Roam Research

See, sort and clean up the files uploaded to your Roam graph.

File Manager adds **Files** to the left sidebar, under All Pages. It lists every file you've
uploaded to the graph (images, PDFs, audio, video and anything else) in a table that works like
All Pages.

- **Sort** by name, type, size, mentions or date added. Newest files come first.
- **Search** by file name, type or the page a file is on.
- **Filter** by kind of file, or to files that no block mentions any more.
- Click a file's name to open it. Hover over its picture to see it larger.
- **Mentions** counts the blocks a file is in, and the page it's on is shown next to its name. Click the
  count to open those blocks in the right sidebar, the way All Pages opens a page's mentions.
- **Delete** files that have no mentions, to free up their storage.

## Deleting files

When you delete a block that holds an upload, Roam keeps the file in its storage. File Manager is how
you find those files and remove them.

1. A file that no block mentions shows **0** under Mentions. Sort by Mentions, or turn on **Unused** in
   the filter, to bring these files together.
2. Tick the files and press the trash. The trash only works while every ticked file has 0 mentions, so a
   file that is still in one of your blocks can't be deleted by mistake.
3. Roam asks you to confirm, listing each file. Deleting is permanent: the file is removed from Roam's
   storage and can't be brought back.

Two things to know:

- File Manager can only show a file with 0 mentions if it has seen that file in a block at some point
  since it was installed. Roam doesn't let an extension list a graph's stored files, so files that lost
  their block before then don't appear. What File Manager has seen is kept on your device.
- Only files uploaded to the graph you're in can be deleted. A file pasted in from another graph is
  listed, but it belongs to that graph.

## Notes

- File sizes and upload dates come from Roam's file storage. They're fetched the first time the list is
  opened and kept on your device after that.

## Development

```
npm install
npm test             # unit tests
npm run build        # writes extension.js
node test/help-graph.mjs   # the build in Roam's public help graph, headless (needs Playwright)
```

To load a build in Roam: Settings > Roam Depot > enable developer mode, then load this folder.
`test/real-roam/run.mjs` runs the build in Roam's desktop app against a hosted test graph; see
`.github/workflows/real-roam.yml`.
