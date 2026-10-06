#!/usr/bin/env node
/*
 * Audit of the characterization suite for tests that pass without proving anything.
 *
 *   node scripts/characterization-audit/audit.js [routes.json]
 *
 * routes.json = output of `ROUTE_COVERAGE=1 ROUTE_COVERAGE_FILE=routes.json npm test` (adds route coverage checks).
 * Exits 1 on hard problems (.only, tests with no assertion, obsolete/unused snapshot keys, routes without a success response);
 * everything else is printed for a human to judge (masking, stubs, error-heavy snapshots, swallowed errors, skips).
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const dir = path.join(root, 'test', 'characterization')
const snapDir = path.join(dir, 'snapshots')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'))
const helpers = fs.readdirSync(path.join(dir, 'helpers')).filter((f) => f.endsWith('.js'))
const problems = []
const notes = []
const problem = (m) => problems.push(m)

// split a test file into it() blocks (heuristic: from one `it(`/`it.skip(` line to the next)
function itBlocks(src) {
  const lines = src.split('\n')
  const starts = []
  lines.forEach((l, i) => {
    if (/^\s*(it|it\.skip|it\.only)\(/.test(l)) starts.push(i)
  })
  return starts.map((s, k) => ({ title: (lines[s].match(/\(\s*['"`](.+?)['"`]/) || [])[1] || lines[s].trim(), skip: /it\.skip\(/.test(lines[s]), body: lines.slice(s, starts[k + 1] ?? lines.length).join('\n'), line: s + 1 }))
}

let totalTests = 0
let totalSkips = 0
const ASSERT = /\b\w*([sS]nap\w*|expect|assert)\w*\s*\(|\.should\b|\bnew Error\(/
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
  if (/\b(describe|it)\.only\(/.test(src)) problem(`${f}: contains .only`)
  const blocks = itBlocks(src)
  totalTests += blocks.length
  for (const b of blocks) {
    if (b.skip) {
      totalSkips++
      notes.push(`skip: ${f}:${b.line} ${b.title}`)
      continue
    }
    if (!ASSERT.test(b.body)) problem(`${f}:${b.line} "${b.title}" has no snapshot/expect/assert`)
  }
  const swallow = (src.match(/catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\)\s*=>\s*(\{\s*\})?\s*\)/g) || []).length
  if (swallow) notes.push(`swallowed errors: ${f} has ${swallow} empty catch/.catch(() => {})`)
  const loose = (src.match(/to\.be\.oneOf|to\.exist|to\.be\.ok\b|to\.be\.a\('(number|string|object)'\)|status\)?\.to\.be\.(below|lessThan|at\.most)/g) || []).length
  if (loose) notes.push(`loose assertions: ${f} has ${loose} (oneOf/exist/ok/typeof/status ranges)`)
}

// places where data is reshaped before a snapshot (judge whether they hide behaviour)
const RESHAPE = /\b(delete\s+[\w.[\]'"]+|stable\w*\(|mask\w*\(|redact\w*\(|\.sort\(|<redacted>|<masked>|\.replace\(|\.filter\()/g
for (const f of [...files.map((x) => path.join(dir, x)), ...helpers.map((x) => path.join(dir, 'helpers', x))]) {
  const n = (fs.readFileSync(f, 'utf8').match(RESHAPE) || []).length
  if (n) notes.push(`reshaping (delete/stable/mask/sort/replace/filter): ${path.relative(dir, f)} x${n}`)
}

// stubs: anything stubbing the code under test is a red flag
const stubTargets = {}
for (const f of [...files, ...helpers.map((h) => `helpers/${h}`)]) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
  for (const m of src.matchAll(/sinon\.(?:stub|replace|spy)\(\s*([\w.]+)\s*,\s*['"](\w+)['"]\)([^\n]*)/g)) {
    const key = `${m[1]}.${m[2]}`
    ;(stubTargets[key] ||= new Set()).add(f.replace(/^helpers\//, ''))
    // injecting a failure (.rejects/.throws) to record how the code responds is fine; replacing behaviour of code under test is not
    if ((/Controller\.|Model\./.test(key)) && !/\.(rejects|throws)\(/.test(m[3])) problem(`replaces behaviour of code under test: ${key} in ${f}`)
  }
}
notes.push(`stubbed boundaries (${Object.keys(stubTargets).length}): ${Object.entries(stubTargets).map(([k, v]) => `${k} [${[...v].length}]`).join(', ')}`)

// snapshots
let entries = 0
let errorHeavy = []
const seen = new Map()
const used = new Set()
for (const sf of fs.readdirSync(snapDir).filter((f) => f.endsWith('.json'))) {
  const snaps = JSON.parse(fs.readFileSync(path.join(snapDir, sf), 'utf8'))
  let err = 0
  let total = 0
  let emptySuccess = 0
  for (const [k, v] of Object.entries(snaps)) {
    entries++
    used.add(`${sf}::${k}`)
    const h = JSON.stringify(v)
    if (!seen.has(h)) seen.set(h, [])
    seen.get(h).push(`${sf}::${k}`)
    const res = v?.res || v
    if (res && typeof res.status === 'number') {
      total++
      if (res.status >= 400) err++
      else if (res.status < 300 && (res.body === null || res.body === '' || (typeof res.body === 'object' && Object.keys(res.body || {}).length === 0))) emptySuccess++
    }
  }
  if (total) {
    const pct = Math.round((100 * err) / total)
    notes.push(`snapshot ${sf}: ${total} responses, ${pct}% error statuses, ${emptySuccess} successful with empty body`)
    if (pct > 70 && total - err < 6) errorHeavy.push(`${sf} (${pct}% errors, only ${total - err} successes)`)
  }
}
if (errorHeavy.length) problem(`mostly error responses: ${errorHeavy.join(', ')}`)
const dups = [...seen.values()].filter((v) => v.length > 3 && JSON.stringify(v).length > 0)
for (const d of dups) {
  const sample = JSON.stringify(JSON.parse(JSON.stringify(Object.values(JSON.parse(fs.readFileSync(path.join(snapDir, d[0].split('::')[0]), 'utf8')))[0])))
  if (d.length > 8) notes.push(`identical snapshot value repeated ${d.length}x (first: ${d[0]})`)
}
notes.push(`${files.length} test files, ${totalTests} it() blocks (${totalSkips} skipped), ${entries} snapshot entries`)

// obsolete / unused snapshot keys (reported by the harness at exit when SNAPSHOT_REPORT=1)
const usedFile = process.env.SNAPSHOT_USED_FILE
if (usedFile && fs.existsSync(usedFile)) {
  const ran = new Set(JSON.parse(fs.readFileSync(usedFile, 'utf8')))
  const unused = [...used].filter((k) => !ran.has(k))
  if (unused.length) problem(`${unused.length} snapshot entries were not compared by any test (obsolete?): ${unused.slice(0, 5).join('; ')}${unused.length > 5 ? ' ...' : ''}`)
  else notes.push(`all ${used.size} snapshot entries were compared by a test in the last run`)
}

// route coverage
const routesFile = process.argv[2]
if (routesFile) {
  const { all, hits } = JSON.parse(fs.readFileSync(routesFile, 'utf8'))
  const handlers = all.filter((r) => !/ \/\^/.test(r)) // regex layers are cache middleware, not handlers
  const never = handlers.filter((r) => !hits[r])
  const noSuccess = handlers.filter((r) => hits[r] && !hits[r].some((c) => c >= 200 && c < 400))
  if (never.length) problem(`routes never hit: ${never.join(', ')}`)
  if (noSuccess.length) problem(`routes with no 2xx/3xx response: ${noSuccess.join(', ')}`)
  notes.push(`routes: ${handlers.length} handlers, ${handlers.length - never.length} hit, ${handlers.length - never.length - noSuccess.length} with a success response`)
}

console.log(notes.map((n) => `  ${n}`).join('\n'))
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  ! ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('\naudit passed')
