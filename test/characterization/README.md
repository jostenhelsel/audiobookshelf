# Characterization tests

Record what the server does **today** so the JS -> TS migration cannot change it unnoticed. They are not a statement that the behaviour is right: odd responses (for example a 500 status with a validation message) are recorded as they are. Do not fix server behaviour here; list oddities in your summary.

They run the real `ApiRouter` (routing, middleware, permissions, controllers, models, serialization) on an in-memory SQLite DB behind a stub login, with `SocketAuthority` and `Watcher` stubbed and recorded. See `helpers/harness.js` for the API and `CollectionController.test.js` for the reference pattern. `npm test` runs them.

## Writing a controller's tests
1. File `<Controller>.test.js` in this folder; the top-level `describe` is `'<Controller> (characterization)'` (it names the snapshot file).
2. Cover **every route** the controller has in `server/routers/*.js` (grep `<Controller>.`). For each: unauthenticated (401), each user type that matters (`root`, `admin`, `user`, `guest` come from `api.seed.users()`; defaults: only root can delete, `user`/`guest` cannot update), validation failures (400), unknown ids (404), and the success path with its side effects: a follow-up GET, `api.emitted` (socket events), `api.watcherCalls`, DB rows.
3. Snapshot with `matchSnapshot(this, { res, emitted }, { label, ids: this.ids })`. Share one `this.ids = new Map()` per test so ids get stable labels across calls; use `new Map([[realId, '<name>']])` to name an important id.
4. Test data: `helpers/seed-library.js` (`createLibrary`, `createBook`) or your own `helpers/seed-<area>.js`. **Do not edit** `harness.js`, `snapshot.js` or `seed-library.js` for one test's needs; if the harness itself is wrong, say so in your summary.
5. Managers (playback sessions, backups, podcasts, email, ...) are not started. Pass fakes: `startApi({ managers: { backupManager: {...} } })`. Anything touching ffmpeg, the network, SMTP or the real filesystem: stub at the module boundary with sinon, or `it.skip('<route>: needs <thing>')` and report it.
6. Uploads: `api.request(method, url, { form: { fields: {k: 'v'}, files: [{ name: 'cover', filename: 'a.png', content: <Buffer|string>, type: 'image/png' }] } })` sends multipart; the harness mounts the same `express-fileupload` options as `Server.js`, so handlers see `req.files`.
7. Never change files under `server/`.

## Recording and verifying
```
npm run build:server
UPDATE_SNAPSHOTS=1 npx mocha dist-server/test/characterization/<Controller>.test.js   # record, then READ the snapshot diff
npx mocha dist-server/test/characterization/<Controller>.test.js                      # run it 3x: must pass every time (no flaky ordering, ids, times)
```
Snapshots (`snapshots/*.json`) are committed. A failing snapshot means behaviour changed: either you broke something or the change is intended and the snapshot is re-recorded in a reviewed commit. Check that snapshots hold meaningful data, not just error responses, before handing back.

Before handing back also run `npm run lint`, `npm test`, `npm run ratchet`. This folder is excluded from the ratchet (`tsconfig.check.json`) while it stays JS.
