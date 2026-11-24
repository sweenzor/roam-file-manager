# Changelog

## 0.1.0

- Files in the left sidebar: every file uploaded to the graph, with type, size, mentions and date added.
- Sort, search and filter. Find files that no block mentions any more.
- The number of files in the graph above the list, and how many of them a search or filter leaves.
- A progress bar in the middle of the list while file sizes are fetched for the first time, and while a long sort runs. The list waits under it.
- Videos show a frame of the video as their picture. Hover over a picture to see it larger, or over a video to play it.
- Delete files, with Roam's confirmation showing each file's picture, mentions and size. Deleting a file that blocks still mention warns that it leaves broken images and can't be undone.
- Thumbnail view: a button next to the filter shows the files as pictures in place of the list. Videos play in their tile, with the player's controls once the pointer is on them.
- Local graphs (Roam's desktop app): Files lists the files a local graph keeps on the computer, finds the ones no block mentions any more, and deletes them through `roamAlphaAPI.file.delete`.
- Deleting goes through `roamAlphaAPI.file.delete` only, and only for files stored right in this graph's own folder. After each delete Roam's file storage is asked whether the file is gone: a file it still has is reported as not deleted.
- The delete confirmation: Enter on a focused button presses that button (Cancel cancels), a held Enter key doesn't confirm, and unloading the extension closes the confirmation.
- Before a file with 0 mentions is deleted, the graph is checked once more: block text, Roam's PDF pages (`:pdf/url`) and block props (where a drawing keeps its pictures), but not the image sizes Roam leaves in props. A file still in use is kept, with a message saying why. If the check fails nothing is deleted. A PDF that a PDF page still shows isn't listed as unused.
- The delete confirmation can't be closed while its delete runs, and leaving Files ends the delete before its next file.
