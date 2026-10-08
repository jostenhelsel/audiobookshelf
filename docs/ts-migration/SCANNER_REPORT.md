# Scanner characterization report

Written by the local agent (macOS, Node 24.21) following `SCANNER_HANDOFF.md`. One section per step.

## Step 1: directory scan layer
- Date: 2026-10-08. Commit: subject `test: characterize scanner directory layer ... [oracle-update]` (SHA = the commit that adds this section).
- Files added: `test/characterization/ScannerDirectory.test.js` (33 tests), `snapshots/ScannerDirectory_characterization_.json`, `helpers/seed-scanner-fs.js` (temp-tree builder + `createScanLibrary`, which gives the library real default settings and a real folder path).
- Covered: `fileUtils.shouldIgnoreFile` and `recurseFiles` on a real tree (dotfiles/dotdirs, `@eaDir`, temp extensions, `.ignore` in subdirs vs root, empty dirs, unicode, depth); `groupFileItemsIntoLibraryItemDirs` (root files, series/author nesting, CD/disc dirs, `audiobooksOnly`, podcast rules, watcher `includeNonMediaFiles`); folder-name parsing (`getBookDataFromDir`, with/without subtitle parsing, `getDataFromMediaDir`, Windows separators); `LibraryScanner.scanFolder` on book and podcast libraries (items, library files, file types, sizes, ids, ino/timestamps checked against disk, missing folder, no media, `scannerParseSubtitle`); `LibraryItemScanData` against a real DB item (`checkLibraryItemData`: unchanged, added/modified/removed files, rename matched by inode, missing -> found, path change, new ebook becomes supplementary; file getters; `checkAudioFileRemoved`/`checkEbookFileRemoved`; `setBookMetadataFromFilenames`).
- Skipped: none. `.audiobookshelf` rules from the handoff do not exist in this code (only `.ignore`, dotfiles, `@eaDir`, temp extensions), so nothing to test.
- Findings (recorded as-is; see the snapshot for exact values):
  - `.ignore` in the library root is ignored as a plain dotfile; only a `.ignore` in a subdirectory hides that directory (and everything below it). `Ignored2/Sub/.ignore` hides `Sub` but not `Ignored2/keep.mp3`.
  - `@eaDir` matches anywhere in the path as a substring: `Book/my@eaDirbook.mp3` is ignored.
  - Ignore extensions are matched case-insensitively (`01.TMP` ignored); `.partial` is not ignored.
  - `Deep/a/b/c/d/e.mp3` becomes one item `Deep/a/b/c/d` with title `d`, series `c`, author `B` (only the last three folder levels are used, the rest of the path is dropped from the metadata).
  - `Series Title 2 of 3/Book` gives author `Series Title of 3` (the name parser drops the lone `2`).
  - `Title[B0015T963C]` (no space before the bracket) is not an ASIN and stays in the title; lowercase ASIN is not matched either.
  - Sequence is only parsed when there is a series folder (`Author/Book 2 - Title` keeps `Book 2 - Title`). `101 Dalmations` is not a sequence, `101. Dalmations` would be.
  - A CD dir is recognized only directly below the item folder: `Book/Extras/CD 2/b.mp3` is filed as `Extras/CD 2/b.mp3` of `Book`; `CD 1/c.mp3` at the root groups under `CD 1`; `CD 1000` (4 digits) is not a CD dir.
  - In a podcast library every subfolder with audio is its own item: `Podcast B/Season 1` and `Season 2` are two podcasts titled `Season 1`/`Season 2`, while the group function (pure, unit test) folds only when files sit directly in the top folder. Root files and ebooks are ignored.
  - `ebook` files (`.epub`, `.cbz`) in a folder with audio get `isSupplementary: null` on first scan; only files added to an existing item are set to `true`.
  - `hasLibraryFileChanges` returns a count (number), not a boolean as its JSDoc says.
  - A rename inside an item (same inode) is reported as a modification, with `hasAudioFileChanges` true and no add/remove.
- Singleton/harness problems: pure-function tests (no `startApi`) write the real `Logger` debug/error output to the console; harmless but noisy. Snapshots mask nothing for log lines: timestamp-change and inode log lines are filtered or masked in the test because they depend on whether two writes land in the same millisecond.
- Platform notes: `fs.realpathSync` on the temp dir is needed on macOS (`/var` -> `/private/var`). No case-variant file names are created (case-insensitive FS). Unicode names are written NFC; APFS preserved them.
- **Pre-existing failure on this machine, not from this step:** `AuthRoutes.test.js` (4 tests) fails when the system time zone is not UTC (snapshot has `"timeZone": "UTC"`; here `Pacific/Auckland`). Run the suite with `TZ=UTC`. Suggest the cloud session pins `process.env.TZ` or masks `timeZone` in that snapshot.
- Verification (TZ=UTC): build ok, lint clean, `npm test` x2: 1106 passing, 6 pending, 0 failing (1073 + 33); `audit:characterization`: audit passed (29 files, 2233 snapshot entries, 202/202 handlers). `ScannerDirectory.test.js` alone x3 green. `oracle:check` not run (expected to fail).
