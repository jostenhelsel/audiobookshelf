#!/usr/bin/env node
/*
 * Generates a populated audiobookshelf SQLite fixture using an OLD server checkout.
 *
 * usage: node gen-fixture.js <old-server-dir> <work-dir> <out.sqlite> [port]
 * env:   FFMPEG_PATH / FFPROBE_PATH must point at ffmpeg/ffprobe (used to synthesise media and by the server)
 *
 * <old-server-dir> = `git archive <version-bump-sha> | tar -x` with `npm install --omit=dev` (client not needed)
 * Data created: 3 authors, 2 series (+1 standalone), 6 books w/ chapters-free tiny m4b, 1 podcast w/ 3 episodes,
 * playlist (books+episode), collection, media progress, listening session, RSS feed, share link, non-root user.
 * Afterwards absolute paths (server-settings.backupPath, libraryFolders.path, libraries/folders, libraryItems.path/relPath)
 * are rewritten to /PLACEHOLDER/... placeholders.
 */
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const [serverDir, work, out, portArg] = process.argv.slice(2)
if (!serverDir || !work || !out) { console.error('usage: gen-fixture.js <old-server-dir> <work-dir> <out.sqlite> [port]'); process.exit(1) }
const PORT = portArg || '13400'
const base = `http://127.0.0.1:${PORT}`
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, url, body, token) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`)
  try { return JSON.parse(text) } catch { return text }
}
function tone(file, secs, freq, title, artist) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album=${title}`, file])
}

async function main() {
  fs.rmSync(work, { recursive: true, force: true })
  const lib = path.join(work, 'lib'), podLib = path.join(work, 'podlib'), cfg = path.join(work, 'config'), meta = path.join(work, 'metadata')
  ;[cfg, meta].forEach((d) => fs.mkdirSync(d, { recursive: true }))
  const books = [
    ['Alice Author', 'Saga One', 1, 'Saga One Book 1'], ['Alice Author', 'Saga One', 2, 'Saga One Book 2'], ['Alice Author', 'Saga One', 3, 'Saga One Book 3'],
    ['Bob Writer', 'Saga Two', 1, 'Saga Two Book 1'], ['Bob Writer', 'Saga Two', 2, 'Saga Two Book 2'], ['Carol Scribe', null, null, 'Standalone Tale']
  ]
  books.forEach(([a, , , t], i) => tone(path.join(lib, a, t, `${t}.m4b`), 3, 300 + i * 50, t, a))
  ;['Pod Episode 1', 'Pod Episode 2', 'Pod Episode 3'].forEach((t, i) => tone(path.join(podLib, 'The Test Podcast', `${t}.mp3`), 2, 600 + i * 40, t, 'Test Podcast Host'))

  const env = { ...process.env, CONFIG_PATH: cfg, METADATA_PATH: meta, PORT, HOST: '127.0.0.1', NODE_ENV: 'production', SOURCE: 'local' }
  const srv = spawn(process.execPath, ['index.js'], { cwd: serverDir, env, stdio: ['ignore', fs.openSync(path.join(work, 'server.log'), 'w'), 2] })
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/status')).ok) break } catch {} await sleep(500) }
    await api('POST', '/init', { newRoot: { username: 'root', password: 'rootpass123' } })
    const token = (await api('POST', '/login', { username: 'root', password: 'rootpass123' })).user.token
    const T = (m, u, b) => api(m, u, b, token)
    const bookLib = (await T('POST', '/api/libraries', { name: 'Books', mediaType: 'book', folders: [{ fullPath: lib }] })).id
    const podLibId = (await T('POST', '/api/libraries', { name: 'Podcasts', mediaType: 'podcast', folders: [{ fullPath: podLib }] })).id
    for (const id of [bookLib, podLibId]) await T('POST', `/api/libraries/${id}/scan`)
    let items = [], pods = []
    for (let i = 0; i < 60 && (items.length < 6 || pods.length < 1); i++) {
      await sleep(500)
      items = (await T('GET', `/api/libraries/${bookLib}/items?limit=100`)).results
      pods = (await T('GET', `/api/libraries/${podLibId}/items?limit=100`)).results
    }
    if (items.length !== 6 || pods.length !== 1) throw new Error(`scan incomplete: ${items.length} books ${pods.length} podcasts`)
    // series + authors
    for (const it of items) {
      const b = books.find((x) => x[3] === it.media.metadata.title)
      await T('PATCH', `/api/items/${it.id}/media`, { metadata: { authors: [{ name: b[0] }], series: b[1] ? [{ name: b[1], sequence: String(b[2]) }] : [] } })
    }
    items = (await T('GET', `/api/libraries/${bookLib}/items?limit=100`)).results
    const pod = (await T('GET', `/api/items/${pods[0].id}?expanded=1`))
    const eps = pod.media.episodes
    // playlist, collection
    await T('POST', '/api/playlists', { libraryId: bookLib, name: 'Road Trip', items: items.slice(0, 3).map((i) => ({ libraryItemId: i.id })) })
    await T('POST', '/api/playlists', { libraryId: podLibId, name: 'Pod Mix', items: eps.map((e) => ({ libraryItemId: pod.id, episodeId: e.id })) })
    await T('POST', '/api/collections', { libraryId: bookLib, name: 'Favourites', description: 'fixture', books: items.slice(2, 5).map((i) => i.id) })
    // media progress
    await T('PATCH', `/api/me/progress/${items[0].id}`, { duration: 3, progress: 1, currentTime: 3, isFinished: true })
    await T('PATCH', `/api/me/progress/${items[1].id}`, { duration: 3, progress: 0.5, currentTime: 1.5, isFinished: false })
    await T('PATCH', `/api/me/progress/${pod.id}/${eps[0].id}`, { duration: 2, progress: 0.5, currentTime: 1, isFinished: false })
    // listening session (book + episode)
    for (const [id, ep] of [[items[2].id, null], [pod.id, eps[1].id]]) {
      const play = await T('POST', `/api/items/${id}/play${ep ? '/' + ep : ''}`, { deviceInfo: { clientVersion: 'fixture' }, supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/flac'], mediaPlayer: 'unknown', forceDirectPlay: true })
      await T('POST', `/api/session/${play.id}/sync`, { timeListened: 2, currentTime: 1 })
      await T('POST', `/api/session/${play.id}/close`, { timeListened: 1, currentTime: 2 })
    }
    // RSS feed, share link
    await T('POST', `/api/feeds/item/${items[3].id}/open`, { serverAddress: base, slug: 'fixture-feed', metadataDetails: { preventIndexing: true } })
    const shareBook = await T('GET', `/api/items/${items[4].id}?expanded=1`)
    await T('POST', '/api/share/mediaitem', { slug: 'fixture-share', mediaItemType: 'book', mediaItemId: shareBook.media.id, expiresAt: Date.now() + 365 * 24 * 3600 * 1000, isDownloadable: false })
    // non-root user
    await T('POST', '/api/users', { username: 'reader', password: 'readerpass1', type: 'user', isActive: true, permissions: { download: true, update: false, delete: false, upload: false, accessAllLibraries: true, accessAllTags: true, accessExplicitContent: false }, librariesAccessible: [], itemTagsSelected: [] })
    await sleep(1500)
  } finally {
    srv.kill('SIGINT'); await sleep(2000); srv.kill('SIGKILL')
  }
  // sanitise paths
  const db = path.join(cfg, 'absdatabase.sqlite')
  fs.copyFileSync(db, out)
  const sqlite3 = require(path.join(path.resolve(serverDir), 'node_modules/sqlite3'))
  const d = new sqlite3.Database(out)
  const run = (sql, p = []) => new Promise((res, rej) => d.run(sql, p, (e) => (e ? rej(e) : res())))
  const all = (sql) => new Promise((res, rej) => d.all(sql, (e, r) => (e ? rej(e) : res(r))))
  const tables = (await all("select name from sqlite_master where type='table'")).map((r) => r.name)
  // replace host paths in EVERY text column (JSON blobs such as audioFiles/libraryFiles/mediaMetadata embed them too)
  const q = (x) => x.replace(/'/g, "''")
  const subs = [[lib, '/PLACEHOLDER/books'], [podLib, '/PLACEHOLDER/podcasts'], [meta, '/PLACEHOLDER/metadata'], [cfg, '/PLACEHOLDER/config'], [path.resolve(work), '/PLACEHOLDER/work']]
  for (const t of tables) {
    const cols = (await all(`pragma table_info("${t}")`)).filter((c) => /TEXT|CHAR|JSON|CLOB|^$/i.test(c.type)).map((c) => c.name)
    for (const c of cols) {
      let expr = `"${c}"`
      for (const [from, to] of subs) expr = `replace(${expr}, '${q(from)}', '${q(to)}')`
      await run(`update "${t}" set "${c}" = ${expr} where typeof("${c}") = 'text'`)
    }
  }
  await run('vacuum')
  const ss = await all("select value from settings where key='server-settings'")
  if (ss[0]) { const v = JSON.parse(ss[0].value); v.backupPath = '/PLACEHOLDER/metadata/backups'; await run("update settings set value=? where key='server-settings'", [JSON.stringify(v)]) }
  await new Promise((r) => d.close(r))
  console.log('wrote', out)
}
main().catch((e) => { console.error(e); process.exit(1) })
