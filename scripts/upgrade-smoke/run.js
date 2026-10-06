#!/usr/bin/env node
/*
 * Upgrade smoke test: boots the BUILT server (dist-server) against populated databases from older
 * releases and checks that migrations apply, no data is lost and logins still work.
 *
 *   npm run build:server && node scripts/upgrade-smoke/run.js [--keep] [--only <substring>]
 *
 * ffmpeg/ffprobe are not exercised, but BinaryManager would try to download them, so the server is started
 * with SKIP_BINARIES_CHECK=1 and FFMPEG_PATH/FFPROBE_PATH (env, else found on PATH).
 */
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const semver = require('semver')
const sqlite3 = require('sqlite3')

const root = path.resolve(__dirname, '..', '..')
const distMigrations = path.join(root, 'dist-server', 'server', 'migrations')
const srcMigrations = path.join(root, 'server', 'migrations')
const fixturesDir = path.join(__dirname, 'fixtures')
const keep = process.argv.includes('--keep')
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null
const basePort = Number(process.env.ABS_SMOKE_PORT || 13500)
const USERS = [
  ['root', 'rootpass123'],
  ['reader', 'readerpass1']
]

// Row counts that legitimately differ after upgrading, pinned to CURRENT behaviour so any change is flagged.
// - playbackSessions: boot cleanup (Database.cleanDatabase) deletes sessions with timeListening <= 3; the fixtures' sessions listened for 3s.
// - feedEpisodes (pre-2.17.3 DBs): rows are gone after migrating from v2.14.0 while the feed row survives. Probably the v2.17.3
//   feeds-table rebuild cascading through feedEpisodes' ON DELETE CASCADE (not confirmed); RssFeedManager regenerates episodes on demand.
const EXPECTED_ROWS_AFTER = {
  'abs-v2.14.0': { playbackSessions: 0, feedEpisodes: 0 },
  'abs-v2.25.1': { playbackSessions: 0 }
}

const failures = []
const check = (ok, msg) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failures.push(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const migrationVersion = (file) => file.match(/^v(\d+\.\d+\.\d+)-/)?.[1]
const sqlAll = (db, sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))))
const sqlRun = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())))
const openDb = (file, mode) => new sqlite3.Database(file, mode)
const closeDb = (db) => new Promise((r) => db.close(r))

function findBinary(envName, name) {
  if (process.env[envName]) return process.env[envName]
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
  } catch {
    return null
  }
}

async function rowCounts(file) {
  const db = openDb(file, sqlite3.OPEN_READONLY)
  const counts = {}
  const tables = (await sqlAll(db, "select name from sqlite_master where type='table' and name not like 'sqlite_%'")).map((r) => r.name)
  for (const t of tables) counts[t] = (await sqlAll(db, `select count(*) c from "${t}"`))[0].c
  await closeDb(db)
  return counts
}

// Static check: emitted migrations match the sources and expose up/down (MigrationManager compiles them as CommonJS text).
function checkEmittedMigrations() {
  console.log('emitted migrations')
  const src = fs.readdirSync(srcMigrations).filter((f) => migrationVersion(f)).map((f) => f.replace(/\.(js|ts)$/, '.js')).sort()
  const out = fs.existsSync(distMigrations) ? fs.readdirSync(distMigrations).filter((f) => f.endsWith('.js')).sort() : []
  check(JSON.stringify(src) === JSON.stringify(out), `dist-server/server/migrations has the same ${src.length} .js files as server/migrations`)
  for (const f of out) {
    const m = require(path.join(distMigrations, f))
    check(typeof m.up === 'function' && typeof m.down === 'function', `${f} exports up() and down()`)
  }
  return out
}

async function runFixture(fixture, index, migrationFiles) {
  const name = fixture.replace(/\.sqlite$/, '')
  const dbVersion = name.match(/v(\d+\.\d+\.\d+)/)[1]
  console.log(name)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-smoke-'))
  const cfg = path.join(tmp, 'config')
  const meta = path.join(tmp, 'metadata')
  fs.mkdirSync(cfg, { recursive: true })
  fs.mkdirSync(path.join(meta, 'backups'), { recursive: true })
  const dbFile = path.join(cfg, 'absdatabase.sqlite')
  fs.copyFileSync(path.join(fixturesDir, fixture), dbFile)
  const before = await rowCounts(dbFile)

  // fixtures carry placeholder paths; BackupManager needs a writable backupPath at boot
  const db = openDb(dbFile)
  const ss = JSON.parse((await sqlAll(db, "select value from settings where key='server-settings'"))[0].value)
  ss.backupPath = path.join(meta, 'backups')
  await sqlRun(db, "update settings set value=? where key='server-settings'", [JSON.stringify(ss)])
  await closeDb(db)

  const port = basePort + index
  const base = `http://127.0.0.1:${port}`
  const logFile = path.join(tmp, 'server.log')
  const ffmpeg = findBinary('FFMPEG_PATH', 'ffmpeg')
  const ffprobe = findBinary('FFPROBE_PATH', 'ffprobe')
  const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', SKIP_BINARIES_CHECK: '1' }
  if (ffmpeg) env.FFMPEG_PATH = ffmpeg
  if (ffprobe) env.FFPROBE_PATH = ffprobe
  const logFd = fs.openSync(logFile, 'w')
  const srv = spawn(process.execPath, [path.join(root, 'dist-server', 'index.js'), '--config', cfg, '--metadata', meta, '--port', String(port)], { cwd: root, env, stdio: ['ignore', logFd, logFd] })
  let exited = null
  srv.on('exit', (code) => (exited = code))

  try {
    let up = false
    for (let i = 0; i < 120 && exited === null; i++) {
      try {
        if ((await fetch(base + '/status')).ok) {
          up = true
          break
        }
      } catch {}
      await sleep(500)
    }
    check(up, `server boots on migrated database${exited !== null ? ` (exited with code ${exited})` : ''}`)
    const log = fs.readFileSync(logFile, 'utf8')
    if (!up) return console.log(log.split('\n').slice(-25).join('\n'))

    const expected = migrationFiles.filter((f) => semver.gt(migrationVersion(f), dbVersion))
    const ran = log.match(/Migrations to run: (.*)/)?.[1] ?? ''
    for (const f of expected) check(ran.includes(f.replace(/\.js$/, '')), `migration ${f} ran`)
    check(/Migrations successfully applied/.test(log), 'MigrationManager reported success')
    check(!/\] ERROR:/.test(log.replace(/ZippedAssetDownloader.*|BinaryManager.*/g, '')), 'no ERROR lines in server log')

    for (const [username, password] of USERS) {
      const res = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-return-tokens': 'true' }, body: JSON.stringify({ username, password }) })
      const body = res.ok ? await res.json() : null
      const token = body?.user?.accessToken || body?.user?.token
      check(!!token, `login works for ${username}`)
      if (username === 'root' && token) {
        const libs = await (await fetch(base + '/api/libraries', { headers: { Authorization: `Bearer ${token}` } })).json()
        check(libs.libraries?.length === 2, `API lists 2 libraries (got ${libs.libraries?.length})`)
      }
    }
  } finally {
    srv.kill('SIGINT')
    for (let i = 0; i < 20 && exited === null; i++) await sleep(250)
    if (exited === null) srv.kill('SIGKILL')
    await sleep(300)
  }

  // data survival: every pre-existing table must keep its row count
  const after = await rowCounts(dbFile)
  for (const [t, c] of Object.entries(before)) {
    if (t === 'migrationsMeta') continue
    const want = EXPECTED_ROWS_AFTER[name]?.[t] ?? c
    check(after[t] === want, `table ${t}: ${c} rows before, expect ${want} after${want !== c ? ' (known delta)' : ''}, got ${after[t]}`)
  }
  const verDb = openDb(dbFile, sqlite3.OPEN_READONLY)
  const version = (await sqlAll(verDb, "select value from migrationsMeta where key='version'"))[0]?.value
  await closeDb(verDb)
  check(version === require(path.join(root, 'package.json')).version, `migrationsMeta.version is now ${version}`)
  if (keep) console.log(`  kept ${tmp}`)
  else fs.rmSync(tmp, { recursive: true, force: true })
}

async function main() {
  if (!fs.existsSync(path.join(root, 'dist-server', 'index.js'))) throw new Error('dist-server missing: run `npm run build:server` first')
  const migrationFiles = checkEmittedMigrations()
  const fixtures = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.sqlite') && (!only || f.includes(only))).sort()
  for (let i = 0; i < fixtures.length; i++) await runFixture(fixtures[i], i, migrationFiles)
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed')
  process.exit(failures.length ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
