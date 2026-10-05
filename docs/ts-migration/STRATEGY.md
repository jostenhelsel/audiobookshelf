# Agent strategy: migrating `server/` to TypeScript

## Context

`server/` is the Node/Express/Sequelize/socket.io backend of Audiobookshelf: CommonJS JS, ~92k lines, of which ~40k is vendored (`server/libs`, 244 files). The authored code is **~52k lines in ~180 files** plus ~6k lines of tests. The goal is to convert it to TypeScript with no behaviour change, using AI agents for most of the work.

Findings that shape the plan:

- **The TS toolchain is already in place.** `tsconfig.server.json` has `allowJs: true`, `strict: true`, `module: commonjs`, `outDir: dist-server`, and `noEmitOnError`. `npm run build:server`, `start`, `test`, the Dockerfile, pkg and the linux packager all already run from `dist-server/`. There are no authored `.ts` files and no `checkJs`. So migration is file-by-file `.js` to `.ts` renaming, and no build rework is needed.
- **JSDoc is already fairly dense** (controllers, models, managers, scanner, utils). `objects/` and `finders/` are the least typed. Existing `@typedef` and `import()` types can be ported mechanically to TS interfaces.
- **Safety net is uneven.** Tests are strong for utils, parsers, migrations up to v2.20, and MigrationManager. They are thin for controllers (3 of 23) and auth. There are none for scanner, Server, Auth, Database, SocketAuthority, Watcher, routers, and 20 controllers. CI runs lint, then `build:server` plus mocha, plus a pkg smoke test (`integration-test.yml`). `docs/openapi.json` exists but is lint-only.
- **Cross-cutting typing problems** (these decide the order of work):
  - ~190 untyped `global.X` uses (`ServerSettings`, `ConfigPath`, `MetadataPath`, `appRoot`, `isWin`, ...), plus a stray `global.configPath`.
  - `req.user`, `req.libraryItem`, `req.library`, etc. attached in middleware (~311 `req.user` uses).
  - Sequelize models use `super.init()` with no declared fields, and `sequelize.models.X` lookups.
  - `Database` is a god-object singleton with dynamic `xModel` properties, and a require cycle with the models.
  - Controllers rely on `@this` and `.bind(this)`.
- **Hard runtime constraints:**
  - `MigrationManager` reads emitted `dist-server/server/migrations/vX.Y.Z-*.js` as text and runs them through `new Module()._compile()`. Migrations must stay CommonJS, keep their filename pattern, and expose `up`/`down` on `module.exports`.
  - `index.js:19` derives `appRoot` from the `dist-server` basename.
  - pkg lists `dist-server/server/migrations/*.js` as assets.
  - Many `require('../package.json')` calls depend on `resolveJsonModule`.

## Strategy overview

Use **incremental, leaf-first conversion in dependency-ordered waves**. The build stays green after every merged PR. The approach follows current agentic-migration practice:

1. Build the verification harness first.
2. Do the cross-cutting types once, centrally.
3. Run narrow, parallel, mechanically verifiable agent tasks.
4. Gate every task on deterministic checks, not on agent self-report.

### Phase 0: Baseline and guardrails (human plus one agent, no conversion yet)

1. Record the baseline: `npm run lint`, `npm test`, `npm run build:server` all green on a clean checkout. Capture the pkg smoke-test result.
2. Add a **ratchet** instead of a big-bang `checkJs`. Enable `// @ts-check` per file, or run a second tsconfig. Alternatively, set `checkJs: true` and let a script report the error count per directory. Track the count in CI, and only allow it to fall.
3. Extend `eslint.config.mjs` with `typescript-eslint` for `.ts` files. Only the existing 5 rules apply today, so keep the set small and add `no-explicit-any` as a warning. Check that `no-undef` stays off for `.ts`, since TS covers it.
4. Add **characterization tests** for the zero-coverage high-risk areas before converting them. Do this as separate PRs, owned by a test-writing agent per area, written against the current JS:
   - scanner (`LibraryScanner`, `BookScanner`, `scandir` paths)
   - `Auth` / `SocketAuthority`
   - the 20 uncovered controllers, as supertest-style request tests on an in-memory SQLite DB
   - `Database` init and migrations v2.26+
   Use `docs/openapi.json` as the oracle for response shapes.
5. Add a **boot smoke test** to CI: build, start with a temp config dir, and hit `/ping` and `/status`. It runs against `dist-server`, so it covers the migration-loader path (apply all migrations to an empty DB).
6. Add an **emitted-output diff check**: the set of files and the `module.exports` shape under `dist-server/server/migrations/` must stay unchanged. Migrations are the highest-risk area.
7. Write a short `MIGRATION.md` conventions doc that every agent receives as context:
   - rename with `git mv` so history is kept
   - no behaviour changes
   - no `any` unless commented
   - no `@ts-ignore` (use `@ts-expect-error` with a reason, and count them)
   - keep the CommonJS output
   - keep `require` of JSON working
   - do not reformat (printWidth 400, no semicolons, single quotes)
   - one directory per PR

### Phase 1: Shared type foundation (single agent, sequential, reviewed by a human)

This is the one phase that is **not** parallelized, because every later task depends on it.

- `server/types/globals.d.ts`: `declare global` for every `global.*` variable. Replace `global.configPath` with `global.ConfigPath` as a separate small fix, and flag it.
- `server/types/express.d.ts`: augment `Express.Request` with `user`, `libraryItem`, `library`, `author`, `series`, `collection`, `playlist`, and so on. Where a field is route-specific, prefer a typed request interface (`RequestWithUser`, `RequestWithLibraryItem`). Decide this once for all controllers.
- Sequelize strategy: pick one pattern (`InferAttributes<X>` / `InferCreationAttributes<X>` with `declare` fields), and prove it on one model (`Author`) plus one of its controller call sites.
- A `Database` typing plan. Give it a typed `xModel` property list, and keep the singleton export.
- Port the shared `@typedef`s into `server/types/` (the controllers' request typedefs, the old-JSON shapes).
- `server/libs/`: **leave it as JS.** Exclude it from `checkJs`, keep `allowJs`, and add `.d.ts` stubs only for the wrappers that callers use heavily (`fsExtra`, `fluentFfmpeg` already has one). Swapping vendored libs for npm packages is out of scope because behaviour could differ. Raise it as a follow-up.

Exit criteria: all of it compiles, tests pass, and one model plus one controller are fully converted as a **reference implementation** that later agents imitate.

### Phase 2: Conversion waves (parallel agents, one directory or cluster per PR)

Order leaf-to-root, so each wave imports only already-typed modules. Sizes are authored lines.

| Wave | Scope | Size | Notes |
|---|---|---|---|
| 1 | `utils/` (minus `migrations/` and `queries/`), `Logger` | ~10k | Pure functions, best test coverage. Good for calibrating the agent. Skip `htmlEntities.js` (2.2k-line data table) and convert it last, by script. |
| 2 | `providers/`, `finders/`, `objects/` | ~5k | Least typed, so most new interfaces are written here. |
| 3 | `models/` | ~7.7k | Sequelize pattern from the Phase 1 reference. One agent per model cluster (Book/LibraryItem/Podcast, User/Session/Device, the rest). Convert `Database.js` at the end of this wave. |
| 4 | `utils/queries/`, `scanner/` | ~8k | Needs the Phase 0 scanner tests first. |
| 5 | `managers/`, `auth/`, `routers/`, `SocketAuthority`, `Watcher` | ~9k | Singletons and cycles. Do `MigrationManager` by hand, with a human review. |
| 6 | `controllers/` | ~9.4k | Mostly mechanical once the Express types exist. One agent per 2 to 3 controllers. `LibraryController` (1.5k) and `LibraryItemController` (1.25k) each get their own task. |
| 7 | `Server.js`, `Auth.js`, `index.js`, `dev.js`, `migrations/` (15 files), `utils/migrations/` | ~6k | Last, with a human review. Migrations convert but must keep emitting the same CommonJS shape (see Phase 0 step 6). |

Within a wave, tasks are independent (different files, no shared edits). Run **up to ~5 agents concurrently**, each in its own git worktree (`isolation: "worktree"`), each opening its own PR. Rebase on `main` between waves, and never let two agents touch the same file.

### Per-task agent loop (the unit of work)

Each worker agent gets: the target file list, `MIGRATION.md`, the Phase 1 reference files, and the exact checks to pass. The loop is:

1. `git mv x.js x.ts`, then convert imports to `import x = require()` / `import ... from` consistently with the reference, keeping CommonJS output.
2. Port the JSDoc types to annotations and delete the JSDoc type tags.
3. Fix `tsc` errors by **adding types, not by casting**. Track `any`, `as unknown as`, and `@ts-expect-error` counts in the PR description.
4. Run, in order: `npm run build:server`, `npm run lint`, `npm test`, plus the boot smoke test. All must pass.
5. Diff-review its own change for behaviour drift: any changed logic or dead-code removal must be reverted unless it is a typing fix. Note `this`-rebinding and `constructor.name` uses (`ApiCacheManager`) specifically.
6. Open the PR with the checklist filled in.

### Review and verification layers

- **Independent reviewer agent per PR** (a fresh context, `code-review` skill): checks for behaviour drift, `any` creep, and mismatches with `MIGRATION.md`. It does not see the author's reasoning.
- **Mechanical gates in CI**: `tsc`, lint, mocha, the pkg smoke test, the boot smoke test, the emitted-migrations check, and the `any` / `@ts-expect-error` ratchet.
- **Human review is reserved for** Phase 1, `Database`, `MigrationManager`, `Auth`, `Server.js`, and the migration files. Everything else is spot-checked.
- **Wave-end regression run:** a full Docker build and a manual upgrade test from the previous release's database, to exercise the migrations end to end.

### Hardening afterwards (optional, separate effort)

Turn on `noImplicitAny` debt cleanup for `any`s left behind, replace `any` request bodies with validated types, evaluate swapping vendored libs for typed npm packages, remove `checkJs` exclusions, and make `docs/openapi.json` an enforced contract.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Behaviour drift hidden by thin tests | Phase 0 characterization tests first. Convert untested areas last. |
| Migration loader breaks (`Module._compile`, filename filter, pkg assets) | Emitted-output check, boot smoke test with real migrations, human review of wave 7. |
| Agents silence errors with `any`/casts | Ratchet metrics in CI, reviewer agent, the explicit rule in `MIGRATION.md`. |
| Inconsistent patterns across parallel agents | Phase 1 reference implementation and shared type files. Same context for every agent. |
| Merge conflicts with upstream feature work | Small per-directory PRs, rebase between waves, and avoid large reformatting (keep prettier settings). |
| Require cycles (`Database` <-> models) break under `import` | Keep `require` in the cyclic spots, or lazy imports as today. Do not "fix" cycles in this effort. |
| `strict: true` is already set, so every converted file is checked at full strictness | Expected. Budget the most time for models, `Database` and controllers. |

## Critical files

- `tsconfig.server.json`, `package.json` (build/test scripts, `pkg` block), `eslint.config.mjs`, `Dockerfile`, `build/linuxpackager`
- `server/managers/MigrationManager.js`, `server/migrations/*.js`, `index.js` (the `appRoot` logic)
- `server/Database.js`, `server/models/*.js`, `server/Server.js`, `server/Auth.js`, `server/SocketAuthority.js`
- Existing test layout: `test/server/**`, and `docs/openapi.json` as a contract

## Verification (applies to the whole migration)

- Per PR: `npm run build:server && npm run lint && npm test`, plus the boot smoke test.
- Per wave: the pkg smoke test (`.github/workflows/integration-test.yml` steps run locally) and a Docker image build.
- Final: start the server on a copy of a real v2.x DB, confirm migrations apply and the client loads, and compare the emitted `dist-server` file list and migration exports against the baseline.
