# File Manager for Roam Research

See, sort and clean up the files uploaded to your Roam graph.

File Manager adds **Files** to the left sidebar, under All Pages. It lists every file you've
uploaded to the graph (images, PDFs, audio, video and anything else) in a table that works like
All Pages.

- **Sort** by name, type, size, mentions or date added. Newest files come first.
- **Search** by file name, type or the page a file is on.
- **Filter** by kind of file, or to files that no block mentions any more.
- Click a file's name to open it. Hover over a picture to see it larger, or over a video to play it.
  A video starts without sound; its controls turn the sound on.
- **Mentions** counts the blocks a file is in, and the page it's on is shown next to its name. Click the
  count to open those blocks in the right sidebar, the way All Pages opens a page's mentions.
- **Delete** files to free up their storage, whether or not a block still mentions them.

## Deleting files

Tick one or more files and press the trash. Roam asks you to confirm, showing each file with its
picture (a video's first frame), its size and its mentions count. Hover over a picture or video there
to see or play it, and click a mentions count to look at the blocks first: the confirmation closes,
nothing is deleted and your ticks stay.

**Deleting is permanent.** The file is removed from Roam's storage and can't be brought back.

- **A file with 0 mentions** is in none of your blocks, so nothing in your graph changes. When you
  delete a block that holds an upload, Roam keeps the file in its storage; these are the files that
  leaves behind. Sort by Mentions, or turn on **Unused** in the filter, to bring them together.
- **A file that blocks still mention** can be deleted too. The confirmation warns you first, because
  those blocks are left as they are and will show a broken image or a dead link. For these files you
  have to click the red button: Enter doesn't confirm.

Two things to know:

- File Manager can only show a file with 0 mentions if it has seen that file in a block at some point
  since it was installed. Roam doesn't let an extension list a graph's stored files, so files that lost
  their block before then don't appear. What File Manager has seen is kept on your device.
- Only files uploaded to the graph you're in can be deleted. A file pasted in from another graph is
  listed, but it belongs to that graph.

## Notes

- File sizes and upload dates come from Roam's file storage. They're fetched the first time the list is
  opened and kept on your device after that.
- A video's picture is a frame of the video itself, made the first time the video is listed and kept on
  your device. It needs your computer to be able to play the video: a video in a format it can't play
  (for example an iPhone's HEVC recording on a computer without HEVC support) keeps the video icon.

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
