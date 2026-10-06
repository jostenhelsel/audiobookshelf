# Baseline (commit 7d10b8f, v2.37.0)

Measured in the cloud sandbox (Node v22.22.0, x86_64, 4 CPU, 15GB). CI and pkg target Node 24, so Node 24 results still need a local run.

## Checks
| Check | Result |
|---|---|
| `npm ci` | OK (~9s), sqlite3 native binary present |
| `npm run build:server` | OK (~15s) |
| `npm run lint` | OK |
| `npm test` | 356 passing (~4s) |
| Boot smoke (`/ping`, `/status`) | 200, with `SKIP_BINARIES_CHECK=1 FFMPEG_PATH=… FFPROBE_PATH=…` |

## Sandbox limits
- No Docker daemon, so no image builds.
- pkg packaging not attempted (needs Node 24 base binary download).
- `client/dist` not built, so `/` returns 404.
- BinaryManager downloads are blocked by the proxy (405). Without the env overrides above, boot fails and leaves `temp.zip` / `libnusqlite3.so.ver` in the repo root.

## Findings
1. A fresh DB logs "Database is new. Skipping migrations", so a smoke test must use a pre-seeded older DB to exercise the migration loader.
2. `checkJs` (excluding nothing) gives 12,178 errors; 6,764 are in `server/libs`. Authored code has ~5.4k: utils 1,463, models 1,014, managers 582, scanner 563, controllers 550, objects 235, Database.js 206. Top codes: TS7006 (4,871), TS2339 (2,419), TS7053 (721).
3. Startup copies all 15 migration `.js` files to `<config>/migrations`; emitted output must stay CommonJS with the `vX.Y.Z-name.js` pattern.

## Needed from a local machine (macOS / Linux VM)
1. Node 24: `npm ci && npm run build:server && npm run lint && npm test`.
2. Boot with no env overrides (real ffmpeg/ffprobe/nunicode download path), incl. macOS arm64/x64.
3. Upgrade test: built server against a copy of a real older DB; migrations apply, library loads. Repeat per wave.
4. Client + server: `npm run client`, boot, UI served, login works.
5. Packaging: `@yao-pkg/pkg` (`node24-linux-x64`), start binary, `curl | grep Audiobookshelf`.
6. Docker: `docker buildx build`, run against a seeded config dir.
7. Library scan of a small sample library (chaptered audiobook, podcast, epub/comic) with real ffprobe.
8. Windows is unverifiable locally; keep `isWin`, path handling and `process.pkg` spots flagged for review.

## Local verification (macOS arm64 + Linux aarch64 VM, branch code identical to 7d10b8f)
| Item | Result |
|---|---|
| Node 24.21.0: `npm ci`, `build:server`, `lint`, `test` | All pass, 356 tests |
| Boot with no env overrides (macOS arm64) | ffmpeg, ffprobe, libnusqlite3 download; server boots |
| Client + login | `/` serves UI; `/init`, `/login` work; wrong password 401 |
| Upgrade v2.32.1 → branch (synthetic DB) | Migrations v2.33.0 and v2.35.0 applied; login, 2 libraries, 3 chapters, 2 episodes load; forced rescan 0/0/0 |
| pkg `node24-linux-arm64` | Builds (108 MB), serves UI, applies both migrations on old DB (loader works in pkg snapshot) |

Notes: Node 26 breaks `npm test` (mocha/yargs `require is not defined in ES module scope`); Homebrew `node@24` is actually Node 26. DB fixtures embed absolute paths (`backupPath` in server settings) and crash BackupManager at boot on another machine unless rewritten.

Not yet covered: Docker build/run, macOS x64 and macOS pkg, epub/comic scans, migrations v2.15.0–v2.26.0 end to end (the v2.32.1 DB only exercises 2 of 15), Windows.

## Upgrade smoke test (`npm run smoke:upgrade`)
Fixtures from real v2.14.0 and v2.25.1 servers (generated on the local machine). Passes on the baseline code in the sandbox (Node 22): all 15 migrations apply from v2.14.0, 3 from v2.25.1, both users log in, row counts survive except two pinned deltas:
- `playbackSessions` 2 → 0 on both: boot cleanup deletes sessions with `timeListening <= 3` (fixture sessions are exactly 3s). Expected.
- `feedEpisodes` 1 → 0 when upgrading from v2.14.0 only; the feed row survives. Probably v2.17.3's feeds-table rebuild cascading via `ON DELETE CASCADE` (not confirmed). Upstream behaviour, pinned so a change is flagged; worth a look as a possible upstream bug.
The harness was negative-tested (a migration without `up` fails both the static check and the boot).
