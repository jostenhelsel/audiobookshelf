# Characterization tests: coverage and findings

`test/characterization/` records the server's current HTTP behaviour (real `ApiRouter`, middleware, permissions, controllers, models, serialization; in-memory SQLite; stub login; `SocketAuthority`/`Watcher` stubbed and recorded). See `test/characterization/README.md` for how it works and how to extend it. A failing snapshot means behaviour changed.

## Coverage
All 23 controllers, every route in `ApiRouter`, `PublicRouter` and the controllers' public routes. About 610 tests, 6 skipped. `npm test` runs 967 tests in ~100s.

| Controller | Tests | Controller | Tests |
|---|---|---|---|
| Library | 64 | Playlist | 21 |
| LibraryItem | 110 | Session | 14 |
| Me | 67 | Podcast | 27 |
| User | 35 | Misc | 38 |
| Author | 20 | FileSystem | 15 |
| Series | 8 | Backup | 17 |
| Collection | 11 | CustomMetadataProvider | 8 |
| Search | 19 | Email | 19 |
| Tools | 22 | Notification | 18 |
| Cache | 6 | RSSFeed | 16 |
| ApiKey | 15 | Share | 29 |
| Stats | 9 | | |

`AuthRoutes.test.js` (17 tests) runs the real passport local and jwt strategies, `TokenManager` and `Auth.initAuthRoutes` (via `helpers/auth-harness.js`): `/login`, `/auth/refresh`, `/logout`, bearer/`?token=` auth on `/api`, the unauthenticated cover/author-image GETs, and `/auth/openid/config` without a provider.

Skipped (6): real zip download (`GET /libraries/:id/download`), author image resize (needs ffmpeg), item cover upload and cover cache-miss resize (LibraryItem), `POST /notifications` without `urls` (hangs), `GET /logger-data` with no log manager (hangs).

## Not covered yet
The OIDC flow (`/auth/openid`, `/callback`, `/mobile-redirect`; needs a fake identity provider), auth rate limiting (429 after 40 attempts), `Database.js` init, `SocketAuthority` event handling, the scanner (`scanner/*`), `Server.js` boot, `HlsRouter`, and anything needing ffmpeg/real media. The upgrade smoke test (`scripts/upgrade-smoke`) covers migrations end to end.

## Findings (recorded as-is, nothing fixed)
Reported by the test-writing agents while reading the code and recording responses; not independently verified beyond the snapshots. Candidates for upstream issues, roughly by importance.

**Access control / data exposure**
- `GET /api/series/:id` ignores library access: a user limited to library B gets 200 for a series in library A.
- `PATCH /api/me/progress/:libraryItemId` has no library or tag access check; a restricted user can write progress for items they cannot access, and `GET /me/items-in-progress` then returns them (also items hidden from continue listening).
- `GET /api/items/:id/cover` has no `checkCanAccessLibraryItem` check.
- `GET /api/custom-metadata-providers` returns raw rows including `authHeaderValue` in clear text.
- `PATCH /api/api-keys/:id` with no effective change returns `apiKey.user` as the full user row including `pash` and `token`.
- `POST /api/me/ereader-devices`: the duplicate-name 400 leaks that another user's private device has that name.
- `POST /api/validate-cron` has no permission check.

**Hangs (async handlers without try/catch under Express 4; the request never completes)**
- `POST /api/items/batch/update` with an entry that has `id` but no `mediaPayload`.
- `POST /api/notifications` with `eventName` but no `urls`.
- `GET /api/logger-data` when `Logger.logManager` is null.
- `GET /api/authors/:id/image` when the image cache path is unset.
- `GET /api/sessions` when a device's `extraData` is null.
- `GET /api/users/online` before `SocketAuthority.initialize()`.

**Wrong status codes / messages**
- `POST /api/collections/:id/batch/remove` with no body: 500 with the message "Invalid request body".
- `POST /api/items/batch/get` with no ids: 403 "Invalid payload" (should be 400).
- `PATCH /api/items/:id/cover` validation errors, `POST /api/items/:id/chapters` on a podcast/no-audio/missing item, `POST /api/items/:id/scan` on an `isFile` item: bare 500.
- `GET /api/podcasts/:id/search-episode` with no/duplicate `title`, and podcast middleware on a book item: bare 500. `POST /podcasts/opml/parse` and `download-episodes` with empty body: bare 400.
- `POST /api/backups/upload` without multipart: TypeError -> 500.
- `GET /api/users/:id` for a non-admin is let through by middleware, then the handler returns 403, even for their own id.
- Email routes return 404 to user/guest where notification and RSS routes return 403. `GET /api/sessions` for non-admins is 404.
- `GET /api/notifications/test` returns 200 even if nothing fires.
- `PATCH /api/notifications/:id` ignores the URL id and updates by the body id.

**Missing validation**
- `PATCH /api/settings` stores any types (`backupsToKeep: "many"`, `bookshelfView: "bogus"`); `allowIframe: "false"` (string) passes and is stored as a string. `POST /custom-metadata-providers` accepts any `mediaType` and URL scheme.
- `POST /api/libraries` accepts `folders: []` despite a "non-empty" message; `PATCH /libraries/:id` accepts a `mediaType` change; `POST /libraries/order` partially applies entries before failing on an unknown id.
- `POST /api/users` username uniqueness is case-sensitive while login lookup is case-insensitive; `PATCH /users/:id` accepts a case-only rename.
- `PATCH /api/playlists/:id` accepts duplicate item ids (`[A, A, B]`); `POST /playlists` accepts empty `items`; `POST /playlists/collection/:id` silently drops books the user can't see.
- `POST /api/share/mediaitem`: `expiresAt` in the past returns 201 and `share_open` but the row is deleted immediately; no `expiresAt` gives 400 (clients must send 0 for "never"); a podcast-episode share is created (201) but its public GET returns 404.
- `GET /public/share/:slug` reuses an arbitrary cookie value (even a non-uuid) as the new session id.
- `POST /api/upload`: a title that sanitizes to empty puts files in the library root; author `../Evil/Author` becomes the directory `..EvilAuthor`.

**Determinism problems in the server (matter for tests and for reasoning about behaviour)**
- Many queries have no `ORDER BY`, so list/author/episode order follows random UUIDs (series and collection listings, `GET /users/:id` media progress, feed episodes). Year stats use `ORDER BY RANDOM()` for top-N ties; the personalized "discover" shelf is random.
- `LibraryItem` `afterDestroy` calls `media.destroy()` without awaiting; row counts right after library/issue/folder deletion are racy.
- `GET /libraries/:id/series` and `/recent-episodes` return empty `results` (correct `total`) without a `limit`.
- Tag/genre rename-merge leaves duplicates in `Database.libraryFilterData`; `GET /genres` is unsorted while `GET /tags` is sorted.

**Auth routes (from `AuthRoutes.test.js`)**
- A refresh token can be used any number of times: `/auth/refresh` does not rotate it, so a stolen token stays valid until logout.
- `GET /api/items/:id/cover` and `/api/authors/:id/image` skip authentication entirely (by design, via `ignorePatterns`); an unknown id answers 400 rather than 404.
- `/logout` needs no authentication and always answers 200 `{ redirect_url: null }`, even with no token at all.
- An empty or missing login body gives 400 (passport) while a wrong password or unknown user gives 401, which tells a client the body shape was wrong.

**Harness/seed quirks to remember when writing more tests**
- `User.js` keeps a module-private LRU of users that outlives the database; the harness now evicts them in `stop()`, otherwise a later test's username lookup returns a previous test's user.
- The auth rate limiter is a process-wide singleton; `startAuthApi` bypasses it on its own `Auth` instance.
- `createBook` leaves `explicit` NULL, which hides books from `user`/`guest`; `createLibrary` leaves `library.settings` NULL (public share GET then 500s).
- Singletons leak between tests unless reset: `CacheManager` (reset by the harness), `ShareManager`, `Logger.logLevel`, `Database.libraryFilterData`, the rate limiter on `PATCH /me/password` (40 calls per 10 minutes per process).
- `api.request` returns only `content-type` in `headers`; `set-cookie` values are on the non-enumerable `res.cookies`. It still cannot send a body on GET; use `fetch` against `api.base` for that.

## How the suite is kept honest
`npm run audit:characterization` (see `test/characterization/README.md`) measures instead of trusting claims: 202 of 202 route handlers are hit and each has at least one 2xx/3xx response; every snapshot entry is compared by a test; no `.only`, no assertion-free test, no stub that replaces code under test; the only reshaping of responses before snapshotting is sorting where the server's own order is random, masking of times/versions/ids, and reducing the random "discover" shelf to its size. `npm run oracle:check` plus the Characterization Guard workflow stop the oracle from changing without a deliberate `[oracle-update]` commit.

Found by this sweep: a flaky snapshot on macOS (rows seeded in the same millisecond tie on `createdAt`, which the server sorts by; fixed in the harness and covered by a self-test) and two stale snapshot entries (removed).
