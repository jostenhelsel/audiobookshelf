#!/usr/bin/env node
/*
 * Type-error ratchet for the JS -> TS migration.
 *
 * Runs tsc with checkJs over the authored code (tsconfig.check.json) and compares per-file error counts, plus the number of
 * unjustified type-escape hatches in .ts files, against scripts/ts-ratchet/baseline.json. The run fails if any file gets worse
 * or a file that is not in the baseline has errors. Improvements pass; lock them in with `--update`.
 *
 *   node scripts/ts-ratchet/check.js            check against the baseline
 *   node scripts/ts-ratchet/check.js --update   rewrite the baseline (refused if anything got worse, unless --allow-increase)
 *
 * File keys drop the extension, so renaming x.js to x.ts keeps its history.
 * Escape hatches (`: any`, `as any`, `<any>`, `as unknown as`, @ts-expect-error/ignore/nocheck) are exempt on a line that carries an
 * `escape-ok: <reason>` comment.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const baselinePath = path.join(__dirname, 'baseline.json')
const update = process.argv.includes('--update')
const allowIncrease = process.argv.includes('--allow-increase')
const ESCAPE = /(:\s*any\b|\bas any\b|<any>|\bas unknown as\b|@ts-expect-error|@ts-ignore|@ts-nocheck)/
const keyOf = (file) => file.replace(/\\/g, '/').replace(/\.d\.ts$/, '').replace(/\.(js|ts)$/, '')

function countErrors() {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const res = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.check.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  const out = `${res.stdout}\n${res.stderr}`
  const errors = {}
  let total = 0
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error TS\d+:/)
    const g = !m && line.match(/^error TS\d+:/)
    if (!m && !g) continue
    const key = m ? keyOf(m[1]) : '<global>'
    // vendored code stays JS: tsc still follows requires into it and checks it, so don't count it
    if (key.startsWith('server/libs/')) continue
    errors[key] = (errors[key] || 0) + 1
    total++
  }
  if (total === 0 && res.status !== 0 && !/server\/libs\//.test(out)) throw new Error(`tsc failed without reporting errors:\n${out.slice(0, 2000)}`)
  return errors
}

function countEscapes() {
  const escapes = {}
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!['node_modules', 'libs'].includes(e.name)) walk(full)
      } else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        const n = fs.readFileSync(full, 'utf8').split('\n').filter((l) => ESCAPE.test(l) && !/escape-ok:/.test(l)).length
        if (n) escapes[keyOf(path.relative(root, full))] = n
      }
    }
  }
  for (const d of ['server', 'test']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d))
  return escapes
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)

function compare(kind, now, base) {
  const worse = []
  const better = []
  for (const k of new Set([...Object.keys(now), ...Object.keys(base)])) {
    const n = now[k] || 0
    const b = base[k] || 0
    if (n > b) worse.push(`${k}: ${b} -> ${n}${k in base ? '' : ' (not in baseline)'}`)
    else if (n < b) better.push(`${k}: ${b} -> ${n}`)
  }
  console.log(`${kind}: ${sum(base)} in baseline, ${sum(now)} now (${better.length} files improved, ${worse.length} worse)`)
  return { worse, better }
}

const now = { errors: sorted(countErrors()), escapes: sorted(countEscapes()) }
const hasBaseline = fs.existsSync(baselinePath)
const base = hasBaseline ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { errors: {}, escapes: {} }
const e = compare('checkJs type errors', now.errors, base.errors)
const x = compare('type escape hatches in .ts files', now.escapes, base.escapes)
const worse = [...e.worse.map((l) => `errors   ${l}`), ...x.worse.map((l) => `escapes  ${l}`)]

if (update) {
  if (worse.length && !allowIncrease && hasBaseline) {
    console.error(`Refusing to update: things got worse (pass --allow-increase to override):\n  ${worse.join('\n  ')}`)
    process.exit(1)
  }
  fs.writeFileSync(baselinePath, JSON.stringify(now, null, 2) + '\n')
  console.log(`baseline updated: ${sum(now.errors)} errors across ${Object.keys(now.errors).length} files`)
} else if (worse.length) {
  console.error(`\nRatchet failed. Fix these (or justify escapes with an inline "escape-ok: <reason>" comment):\n  ${worse.join('\n  ')}`)
  process.exit(1)
} else {
  if (e.better.length || x.better.length) console.log('Progress detected: run `npm run ratchet:update` to lock it in.')
  console.log('Ratchet passed.')
}
