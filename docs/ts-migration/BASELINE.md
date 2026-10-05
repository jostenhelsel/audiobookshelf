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
