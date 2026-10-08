# Handoff: scanner characterization (for a local agent)

You are continuing Phase 0 of the Audiobookshelf JS -> TypeScript migration. Phase 0 records what the server does **today** in characterization tests so the conversion cannot change behaviour unnoticed. Your job: characterize `server/scanner/*` (about 4,450 lines, no coverage yet). Read `docs/ts-migration/STATUS.md`, `docs/ts-migration/CHARACTERIZATION.md` and `test/characterization/README.md` first. The rules in that README apply to you unchanged.

## Why local
macOS + Node 24 coverage (the cloud sandbox is Linux + Node 22), and real-world fixtures: if the user gives you a sanitized sample-library layout (folder/file names only, no copyrighted media), mirror it in generated fixtures.

## Ground rules
- Branch: `claude/dreamy-ramanujan-l3ozd4` (pull it first), or a branch cut from it. **Never push `main`. No pull request.** Push to `claude/dreamy-ramanujan-l3ozd4` only if the user says so; otherwise commit locally and tell the user.
- **Never edit `server/`.** Record current behaviour, including oddities. List oddities in the report.
- Do **not** edit `docs/ts-migration/*` (except writing your report, below), `scripts/`, `harness.js`, `snapshot.js`, or `seed-library.js`. Put new helpers in new files `test/characterization/helpers/seed-scanner-*.js`.
- Do **not** run `node scripts/characterization-audit/oracle.js --update`; the cloud session regenerates `ORACLE.sha256.json` after merging. (So `npm run oracle:check` will fail on your branch; that is expected.) Put `[oracle-update]` in the subject of every commit that touches `test/characterization/`.
- Serial steps, one commit per step, no parallel agents. Stop after any step if the user's budget is tight; every commit must leave the tree green.
- Commit trailer: `Co-Authored-By: <your model name> <noreply@anthropic.com>`.

## Test style
- One file per step: `test/characterization/<Name>.test.js`; top-level `describe('<Name> (characterization)', ...)` names the snapshot file. Use `matchSnapshot` from `helpers/snapshot.js`, `startApi` from `helpers/harness.js` (in-memory SQLite; `SocketAuthority` and `Watcher` are stubbed and recorded; `api.emitted`).
- Fixtures are **generated at test time** into a temp dir (`fs.mkdtemp`), never committed: tiny mp3/m4b/ogg via `ffmpeg -f lavfi -i sine=frequency=440:duration=1` (with ID3/MP4 tags via `-metadata`), a minimal epub (zip with `META-INF/container.xml`, an opf), a cbz (zip of 1x1 PNGs), `cover.jpg`, `metadata.json`, `.nfo`, `.opf`, `desc.txt`, `reader.txt`. `this.skip()` with a clear reason only if ffmpeg/ffprobe is missing. Keep each test fast (generate the smallest files; reuse a fixture per describe).
- Mask temp paths, ids, timestamps, inodes, and mtimes (`normalize` handles uuids/timestamps/`tmpDirs`). Sort anything the server returns in filesystem order. Never snapshot absolute paths.
- Singletons leak between tests (see "Harness/seed quirks" in CHARACTERIZATION.md): reset anything you set (`global.*`, `Database.libraryFilterData`, `Logger.logLevel`, `CacheManager`). Run each file 3x alone and the whole `npm test` twice; all must pass every time, on macOS in particular (case-insensitive filesystem, unicode normalization, mtime resolution).
- Don't stub the code under test (the audit rejects it). Stub only the boundary: network (`axios`, metadata providers via `sinon`), `SocketAuthority`.
- No `.only`, no assertion-free tests.

## Steps (commit after each; run the verification block after each)
1. **Directory scan layer** (`LibraryScanner.js` file/dir grouping, `scandir`-related utils in `server/utils/scandir.js`, `LibraryItemScanData.js`): how a folder tree becomes library items: single-file books, folders with several audio files, disc/CD subfolders, `isFile` items, series/author folder structures, ignored files (`.ignore`, `.audiobookshelf` rules, hidden files, `@eaDir`, `.DS_Store`), podcast folders, nested depth, unicode and case-sensitive names, empty folders.
2. **BookScanner + AudioFileScanner + metadata files** (`BookScanner.js`, `AudioFileScanner.js`, `MediaProbeData.js`, `AbsMetadataFileScanner.js`, `NfoFileScanner.js`, `OpfFileScanner.js`): scanning a new book (probe results, tags, chapters, cover extraction, embedded vs file cover, narrators/series parsing from folders and tags), rescan with no change / changed / removed / added files, `metadata.json` precedence, nfo/opf parsing, `epub` and `cbz` ebook items, the library settings that change behaviour (`audiobooksOnly`, `skipMatchingMediaWithAsin/Isbn`, `epubsAllowScriptedContent`, `hideSingleBookSeries`).
3. **PodcastScanner** (`PodcastScanner.js`): new podcast folder with episodes, episode title/season/number parsing from tags and filenames, rescan add/remove episodes, `metadata.json`.
4. **Scanner orchestration** (`Scanner.js`, `LibraryItemScanner.js`, `LibraryScan.js`, `ScanLogger.js`): full library scan results (counts added/updated/missing, `LibraryScan` result object, log lines), `scanLibraryItem` on one item, missing/unmissing items after files disappear and reappear, library `settings.disableWatcher`, `scanFolderUpdates` (the watcher path: pass file-change lists), `cancelLibraryScan`, `Scanner.quickMatch*` only if reachable without network (stub the provider at the `axios`/`Audible` boundary).
Skip or `it.skip('<thing>: needs <why>')` anything needing the network or a real long-running transcode, and report it.

## Verification block (after every step)
```
npm ci            # first time only
npm run build:server && npm run lint
npm test          # run twice; both must be fully green (currently 1073 passing, 6 pending before your work)
npm run audit:characterization    # must print "audit passed"; fix what it reports, never edit the audit
```
Run `UPDATE_SNAPSHOTS=1 npx mocha dist-server/test/characterization/<File>.test.js` to record, then read the snapshot diff; make sure snapshots hold meaningful data, not just empty results or errors.

## Report (so the cloud session can pick up without the user pasting anything)
After each step, append to `docs/ts-migration/SCANNER_REPORT.md` (create it; this is the only docs file you edit), committed with the step with `[skip ci]` NOT used (the commit also touches tests). Per step: date, commit SHA (fill it in the following commit or give the subject), files added, test counts, what is covered, what is skipped and why, **findings** (odd behaviours recorded as-is, with the input that shows each), singleton/harness problems hit, platform notes (macOS vs Linux differences), and the results of the verification block. If you get blocked, write why in the report and stop.

When done (or when the user stops you), tell the user to push (or push if told to) and say: "Report is in `docs/ts-migration/SCANNER_REPORT.md` on branch `claude/dreamy-ramanujan-l3ozd4`." The cloud session then merges, regenerates the oracle manifest, folds the findings into `CHARACTERIZATION.md` and `STATUS.md`, and re-verifies.
