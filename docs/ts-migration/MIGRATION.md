# JS -> TS migration: rules for agents and reviewers

Context: `docs/ts-migration/STRATEGY.md`. Goal is **no behaviour change**. Every PR/merge must leave build, lint, tests, the ratchet and the upgrade smoke test green.

## Converting a file
1. `git mv x.js x.ts` (keeps history). Convert one directory/cluster per task; never touch files outside your assignment except to fix a type that blocks you (say so in the summary).
2. **Keep the CommonJS shape.** Unconverted JS files `require()` converted ones, and `MigrationManager` runs emitted migrations as plain CommonJS text. Verified: `export =` emits exactly `module.exports = ...`; `export default` emits `{ default: ... }` and breaks every JS consumer.
   - `module.exports = Foo` / `new Foo()` / `{ up, down }` -> `export = Foo` / `export = new Foo()` / `export = { up, down }`
   - consume with `import Foo = require('./Foo')` (or `import Foo from './Foo'`, which esModuleInterop allows)
   - Files that used `exports.a = ...` may use named `export`s (that adds a non-enumerable `__esModule`; fine except in `server/migrations/`, where you must use `export = { up, down }`)
   - never use `export default`
3. Move JSDoc types into annotations and delete the redundant JSDoc type tags. Keep prose comments.
4. Keep `require('../package.json')`-style JSON loads working (`resolveJsonModule` is on); do not change `rootDir` (`.`) or `outDir` (`dist-server`).
5. Do not reformat. Prettier style is: no semicolons, single quotes, no trailing commas, print width 400. Do not reorder or rename code that is not needed for typing.
6. Do not "fix" circular requires (e.g. `Database` <-> models), `this` rebinding (`.bind(this)` in controllers), `constructor.name` uses (`ApiCacheManager`), or any logic. Typing only. If you find a bug, report it, do not fix it.
7. Fix type errors by adding real types. In order of preference: a correct type, a type guard, `unknown` plus a narrowing check, a declaration in `server/types/`. A cast is a last resort.

## Escape hatches
- `@ts-ignore` and `@ts-nocheck` are banned (lint error). `@ts-expect-error` needs a description of 10+ characters.
- `any`, `as any`, `<any>`, `as unknown as`, `@ts-expect-error` in a `.ts` file are counted by the ratchet and fail it unless the line carries an inline justification: `// escape-ok: <reason>`.

## The checks (run all before handing work back)
```
npm run build:server       # tsc, must emit
npm run lint
npm test                   # mocha on dist-server
npm run ratchet            # per-file checkJs error counts must not rise
npm run smoke:upgrade      # boots dist-server on v2.14.0 and v2.25.1 databases
```
- The ratchet counts `tsc --checkJs` errors per file (extension ignored, so a rename keeps its history; `server/libs` is excluded). Converting a file normally *lowers* its count: run `npm run ratchet:update` and include the changed `scripts/ts-ratchet/baseline.json` lines in your commit. `--update` refuses to record an increase.
- Report in your summary: files converted, ratchet before/after, number of `escape-ok` lines you added and why.
- Anything these cannot see (controllers, scanner, sockets, auth have almost no tests) needs a reviewer who reads the diff for behaviour drift, so keep diffs mechanical and small.

## Known setup items (Phase 1 will do these once, centrally)
- `server/types/` for `global.*` declarations and the Express `Request` augmentation. `tsconfig.server.json` currently has `"**/*.d.ts"` in `exclude`, which will skip those declaration files; change that when adding them.
- Sequelize model typing pattern (`declare` fields / `InferAttributes`) chosen on one model first.
- `@types/mocha`, `@types/chai`, `@types/sinon` for tests. Of the 2,162 baseline errors under `test/`, about 490 are missing mocha globals (TS2582/TS2304) and 1,190 are implicit-any (TS7005), probably cascading from untyped `chai`/`sinon` requires (not yet confirmed).
- Until Phase 1 lands, do not convert models, controllers or `Database`.

## Do not touch
`server/libs/**` (vendored, stays JS), `client/`, anything under `server/migrations/` until wave 7, and the emitted-output expectations checked by `npm run smoke:upgrade`.
