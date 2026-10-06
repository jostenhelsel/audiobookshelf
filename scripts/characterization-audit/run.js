#!/usr/bin/env node
// Runs the full characterization suite with route-coverage and snapshot-usage recording, then the audit.
//   npm run audit:characterization      (needs `npm run build:server` first; the npm script does it)
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-audit-'))
const routes = path.join(tmp, 'routes.json')
const used = path.join(tmp, 'used.json')
const env = { ...process.env, ROUTE_COVERAGE: '1', ROUTE_COVERAGE_FILE: routes, SNAPSHOT_USED_FILE: used }
const mocha = spawnSync(process.execPath, [path.join(root, 'node_modules', 'mocha', 'bin', 'mocha.js'), 'dist-server/test'], { cwd: root, env, stdio: 'inherit' })
if (mocha.status !== 0) process.exit(mocha.status || 1)
const audit = spawnSync(process.execPath, [path.join(__dirname, 'audit.js'), routes], { cwd: root, env, stdio: 'inherit' })
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(audit.status || 0)
