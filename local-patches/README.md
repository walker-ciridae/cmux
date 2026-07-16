# Local patches not tracked by git

## pierre-trees-FileTreeView-two-tone.js

Modified copy of `webviews/node_modules/@pierre/trees/dist/render/FileTreeView.js`
(package `@pierre/trees@1.0.0-beta.4`). The `renderRowDecoration` text branch is
changed to split the decoration text into per-token spans with
`data-loc="add"/"del"` so the file-tree +/- LOC badges can be colored green/red
(styled in `fileTreeUnsafeCSS` in `webviews/src/pierre-options.ts`).

After a fresh `bun install`, copy this file back over the node_modules path
before running the webviews build.
