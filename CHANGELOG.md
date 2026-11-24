# Changelog

## 0.1.0

- Files in the left sidebar: every file uploaded to the graph, with type, size, mentions and date added.
- Sort, search and filter. Find files that no block mentions any more.
- The number of files in the graph above the list, and how many of them a search or filter leaves.
- A progress bar in the middle of the list while file sizes are fetched for the first time, and while a long sort runs. The list waits under it.
- Videos show a frame of the video as their picture. Hover over a picture to see it larger, or over a video to play it.
- Delete files, with Roam's confirmation showing each file's picture, mentions and size. Deleting a file that blocks still mention warns that it leaves broken images and can't be undone.
- Thumbnail view: a button next to the filter shows the files as pictures in place of the list. Videos play in their tile, with the player's controls once the pointer is on them.
- Local graphs: Files lists and shows the files a local graph's blocks hold. Deleting, and finding unused files, is for hosted graphs only: Roam's extension API can't list or delete a local graph's files.
- Deleting goes through `roamAlphaAPI.file.delete` only, and only for files stored right in this graph's own folder. After each delete Roam's file storage is asked whether the file is gone: a file it still has is reported as not deleted.
- The delete confirmation: Enter on a focused button presses that button (Cancel cancels), a held Enter key doesn't confirm, and unloading the extension closes the confirmation.
