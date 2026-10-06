/*
 * Snapshot helper for characterization tests.
 *
 * Records the CURRENT behaviour of the server (normalized JSON) so a refactor that changes it fails loudly.
 * One JSON file per test file in test/characterization/snapshots/, keyed by "<suite> <test> [label]".
 *   UPDATE_SNAPSHOTS=1 npm test     writes/overwrites snapshots (review the diff before committing)
 * Snapshots live in the SOURCE tree; tests run from dist-server, so the repo root is found by walking up.
 */
const fs = require('fs')
const path = require('path')
const { expect } = require('chai')

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/
const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/
const TIME_KEY = /(At|Time|Date|Ms|Added|Updated|Created|Seen|Played|Started|Finished|Expires|Birthtime|Mtime|Ctime)$/
const EPOCH_MS_MIN = 1e11 // anything above this is a ms timestamp (year 1973+)

const repoRoot = () => {
  const parts = __dirname.split(path.sep)
  const i = parts.lastIndexOf('dist-server')
  return i > -1 ? parts.slice(0, i).join(path.sep) || path.sep : path.resolve(__dirname, '..', '..', '..')
}
const snapshotDir = () => path.join(repoRoot(), 'test', 'characterization', 'snapshots')

/**
 * Replace nondeterministic values (UUIDs by first appearance, timestamps, JWTs, tmp paths) so snapshots are stable.
 * @param {any} value
 * @param {{ ids?: Map<string,string>, tmpDirs?: string[] }} [ctx]
 */
function normalize(value, ctx = {}) {
  const ids = ctx.ids || new Map()
  const tmpDirs = ctx.tmpDirs || []
  const idFor = (id) => {
    const key = id.toLowerCase()
    if (!ids.has(key)) ids.set(key, `<uuid-${ids.size + 1}>`)
    return ids.get(key)
  }
  const str = (s) => {
    if (JWT.test(s)) return '<jwt>'
    if (ISO_DATE.test(s)) return '<iso-date>'
    let out = s.replace(UUID, idFor)
    for (const d of tmpDirs) out = out.split(d).join('<tmp>')
    return out
  }
  const walk = (v, key) => {
    if (v === null || v === undefined) return v
    if (typeof v === 'string') return str(v)
    if (typeof v === 'number') {
      if (v <= EPOCH_MS_MIN) return v
      // a ms timestamp: by key name, or because it is within ~a year of now (catches fields like lastUpdate)
      return (key && TIME_KEY.test(key)) || Math.abs(v - Date.now()) < 400 * 24 * 3600 * 1000 ? '<timestamp>' : v
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v)) out[str(k)] = walk(v[k], k)
      return out
    }
    return v
  }
  return walk(value)
}

const files = new Map()
function load(file) {
  if (!files.has(file)) files.set(file, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {})
  return files.get(file)
}

/**
 * Compare `value` with the stored snapshot for this test.
 * @param {import('mocha').Context} ctx the mocha `this` of the test
 * @param {any} value
 * @param {{ label?: string, ids?: Map<string,string>, tmpDirs?: string[] }} [opts] share `ids` across calls in one test for stable cross-references
 */
function matchSnapshot(ctx, value, opts = {}) {
  const test = ctx.test || ctx.currentTest
  const titles = []
  for (let s = test.parent; s && s.title; s = s.parent) titles.unshift(s.title)
  const key = [...titles, test.title, opts.label].filter(Boolean).join(' > ')
  const fileTitle = titles[0] || 'root'
  const file = path.join(snapshotDir(), `${fileTitle.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`)
  const snaps = load(file)
  usedKeys.add(`${path.basename(file)}::${key}`)
  const actual = normalize(JSON.parse(JSON.stringify(value === undefined ? null : value)), opts)
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    if (process.env.CI) throw new Error('UPDATE_SNAPSHOTS=1 is not allowed in CI: snapshots are only re-recorded by a person, in a reviewed commit')
    snaps[key] = actual
    const sorted = Object.fromEntries(Object.entries(snaps).sort(([a], [b]) => (a < b ? -1 : 1)))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n')
    return
  }
  if (!(key in snaps)) throw new Error(`No snapshot for "${key}" in ${path.relative(repoRoot(), file)}. Run with UPDATE_SNAPSHOTS=1 to record it.`)
  expect(actual, `snapshot "${key}"`).to.deep.equal(snaps[key])
}

// SNAPSHOT_USED_FILE=<path> npm test records every snapshot entry that was compared, so the audit can find obsolete entries
const usedKeys = new Set()
if (process.env.SNAPSHOT_USED_FILE) process.on('exit', () => fs.writeFileSync(process.env.SNAPSHOT_USED_FILE, JSON.stringify([...usedKeys].sort(), null, 2)))

module.exports = { matchSnapshot, normalize }
