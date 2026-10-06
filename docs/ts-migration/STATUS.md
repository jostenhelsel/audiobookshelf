# Status and hand-off (read this first when resuming)

Branch `claude/dreamy-ramanujan-l3ozd4` (root for all work; fork `jostenhelsel/audiobookshelf`, public, so Actions minutes are free). Rollback points by SHA: `ROLLBACK_POINTS.md`. Plan: `STRATEGY.md`. Rules for conversion agents: `MIGRATION.md`. Findings about current server behaviour: `CHARACTERIZATION.md`.

## Where we are
Phase 0 (safety net) is mostly done: upgrade smoke test (real v2.14.0/v2.25.1 DBs), `checkJs` ratchet (7,576 errors baseline), typescript-eslint, characterization tests for all 23 controllers (about 610 tests; 202/202 route handlers hit), audit + oracle manifest + CI guard. Last verified commit: see the final row of `ROLLBACK_POINTS.md`.

## Remaining Phase 0
1. Characterize what the controller suites don't reach: `Auth.js` routes (login/refresh/logout/OIDC, real JWT auth instead of the stub login), `Database` init, `SocketAuthority` event handling, scanner (`server/scanner/*`, generate audio/epub/cbz fixtures; ffmpeg/ffprobe exist in the sandbox), `Server.js` boot, `HlsRouter`.
2. Harness gaps reported by agents, to fix centrally before those suites: load a fresh copy of `Auth.js` (same circular-require problem as `TokenManager`, already handled for that), stub `Watcher.onFileAdded/onFileRemoved/onFileRename`, set `global.appRoot`, reset `Logger.logLevel` and `Database.libraryFilterData` between tests, `api.request` should expose `set-cookie` and allow GET bodies. `createLibrary` leaves `settings` NULL and `createBook` leaves `explicit` NULL (see CHARACTERIZATION.md).
3. Optional: emit-diff check (compile converted TS and diff against the original JS emit; strongest guard against behaviour change), `nyc` line/branch coverage of `server/controllers`.
Then Phase 1 (shared types: `server/types/` for globals and the Express `Request` augmentation, Sequelize typing pattern proven on one model, `@types/mocha|chai|sinon`; remember `tsconfig.server.json` excludes `**/*.d.ts`), then waves.

## Decisions made with the user
- Parallel agents work in local git worktrees; I merge their branches onto the single working branch with merge commits (Option A). Switch to pushed sub-branches/PRs only if correctness problems appear (needs the user's explicit OK to push other branches).
- Push at natural checkpoints after local checks pass (build, lint, `npm test`, `npm run ratchet`, `npm run smoke:upgrade`, `npm run audit:characterization`); use `[skip ci]` for docs-only commits and `[oracle-update]` for any commit touching `test/characterization/`.
- Don't open PRs unless asked. No visualizations/widgets unless asked.
- The user runs macOS tests via a local agent (Node 24; Windows untestable). Asked of them, still open: run `npm test` three times on the branch (a snapshot flaked once on macOS before the tie fix); optional sanitized sample-library layout for scanner tests; Docker build/run at wave boundaries.
- Git tags cannot be pushed from the sandbox (remote hangs up); the SHA table is the source of truth.

## Working notes for the orchestrator
- Sandbox: Node 22 (CI uses 24), `npm ci` works (~9s), `SKIP_BINARIES_CHECK=1 FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe` to boot the server, no Docker daemon, `npm test` takes ~100s.
- `Agent` with `isolation: "worktree"` may create the worktree from the OLD baseline commit, not the branch head. Tell every agent to run `git merge --ff-only claude/dreamy-ramanujan-l3ozd4` first, and `ln -s /home/user/audiobookshelf/node_modules node_modules` (not `npm ci`). Verify each returned commit touches only the intended paths, merge with `--no-ff`, re-run all checks on the merge result, then remove the worktree (`git worktree remove --force`) and delete the merged branch. `.claude/worktrees/` is excluded locally via `.git/info/exclude`.
- Agent reports are claims: the merge plus the full checks (and the audit) are the verification.
- Don't `pkill -f` a pattern that also matches your own command line; don't chain `sleep` (blocked).
- Findings in `CHARACTERIZATION.md` are candidate upstream issues (some security-relevant); none were fixed. The `feedEpisodes` loss when upgrading from v2.14.0 is in `BASELINE.md`.
