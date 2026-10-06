#!/usr/bin/env node
/*
 * Integrity manifest for the characterization "oracle" (tests, helpers, snapshots).
 *
 * During the conversion waves nobody should change these files to make a failing test pass. The manifest makes any change
 * visible: `--check` fails when a file differs from test/characterization/ORACLE.sha256.json, and the CI guard additionally
 * fails when the manifest itself changes without an `[oracle-update]` marker in a commit message. Changing the oracle is
 * allowed, but it is a deliberate, reviewed commit:  node scripts/characterization-audit/oracle.js --update
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const dir = path.resolve(__dirname, '..', '..', 'test', 'characterization')
const manifestPath = path.join(dir, 'ORACLE.sha256.json')
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const current = {}
for (const f of walk(dir).sort()) {
  if (f === manifestPath) continue
  current[path.relative(dir, f).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
}

if (process.argv.includes('--update')) {
  fs.writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n')
  console.log(`oracle manifest updated: ${Object.keys(current).length} files`)
  process.exit(0)
}
const recorded = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {}
const changed = [...new Set([...Object.keys(current), ...Object.keys(recorded)])].filter((k) => current[k] !== recorded[k])
if (changed.length) {
  console.error(`characterization oracle changed (${changed.length} files) without a manifest update:\n  ${changed.slice(0, 20).join('\n  ')}${changed.length > 20 ? '\n  ...' : ''}\nIf this is intended, a person runs: node scripts/characterization-audit/oracle.js --update, in a reviewed commit.`)
  process.exit(1)
}
console.log(`oracle intact: ${Object.keys(current).length} files match the manifest`)
