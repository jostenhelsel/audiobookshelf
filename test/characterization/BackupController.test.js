const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const sinon = require('sinon')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const Database = require('../../server/Database')

// BackupManager is not started: a fake records every call the controller makes on it.
describe('BackupController (characterization)', () => {
  let api, calls, manager, backupDir

  const makeBackup = (id, filename, extra = {}) => ({ id, filename, fullPath: path.join(backupDir, filename), toJSON: () => ({ id, filename, datePretty: 'Mon, Jan 1', fileSize: 12, ...extra }) })

  beforeEach(async () => {
    calls = []
    manager = {
      backups: [],
      backupPath: null,
      backupPathEnvSet: false,
      requestCreateBackup: (res) => {
        calls.push({ method: 'requestCreateBackup' })
        res.json({ backups: manager.backups.map((b) => b.toJSON()) })
      },
      removeBackup: async (backup) => {
        calls.push({ method: 'removeBackup', id: backup.id })
        manager.backups = manager.backups.filter((b) => b.id !== backup.id)
      },
      uploadBackup: (req, res) => {
        calls.push({ method: 'uploadBackup', file: { name: req.files.file.name, size: req.files.file.size, mimetype: req.files.file.mimetype } })
        res.sendStatus(200)
      },
      requestApplyBackup: (apiCacheManager, backup, res) => {
        calls.push({ method: 'requestApplyBackup', id: backup.id, hasApiCacheManager: !!apiCacheManager })
        res.sendStatus(200)
      },
      reload: async () => {
        calls.push({ method: 'reload', backupPath: Database.serverSettings.backupPath })
      }
    }
    api = await startApi({ managers: { backupManager: manager } })
    await api.seed.users()
    backupDir = path.join(api.tmp, 'backups')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'a.audiobookshelf'), 'backup-a-content')
    manager.backupPath = backupDir
    manager.backups = [makeBackup('2020-01-01T0000', 'a.audiobookshelf'), makeBackup('2020-01-02T0000', 'b.audiobookshelf', { fileSize: 99 })]
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted, calls: calls.splice(0), ...extra }, { label, tmpDirs: [api.tmp] })
  }
  const req = (method, url, as, o = {}) => api.request(method, url, { as, ...o })

  describe('permissions', () => {
    it('every route requires authentication and admin', async function () {
      // identical 401/403 answers across routes are the behavior: the admin middleware rejects before any handler or manager call ('calls' stays empty)
      const routes = [
        ['GET', '/api/backups'],
        ['POST', '/api/backups'],
        ['DELETE', '/api/backups/2020-01-01T0000'],
        ['GET', '/api/backups/2020-01-01T0000/download'],
        ['GET', '/api/backups/2020-01-01T0000/apply'],
        ['POST', '/api/backups/upload'],
        ['PATCH', '/api/backups/path']
      ]
      for (const [method, url] of routes) {
        snap(this, await req(method, url), `${method} ${url} anonymous`)
        snap(this, await req(method, url, 'user'), `${method} ${url} user`)
        snap(this, await req(method, url, 'guest'), `${method} ${url} guest`)
      }
      expect(manager.backups).to.have.length(2)
    })
  })

  describe('GET /api/backups', () => {
    it('lists backups, location and env flag', async function () {
      snap(this, await req('GET', '/api/backups', 'admin'), 'admin')
      manager.backupPathEnvSet = true
      manager.backups = []
      snap(this, await req('GET', '/api/backups', 'root'), 'root, none, env set')
    })
  })

  describe('POST /api/backups', () => {
    it('delegates to the backup manager', async function () {
      snap(this, await req('POST', '/api/backups', 'admin'))
    })
  })

  describe('DELETE /api/backups/:id', () => {
    it('removes a backup and 404s for unknown ids', async function () {
      snap(this, await req('DELETE', '/api/backups/nope', 'admin'), 'unknown')
      snap(this, await req('DELETE', '/api/backups/2020-01-01T0000', 'admin'), 'remove')
      snap(this, await req('DELETE', '/api/backups/2020-01-01T0000', 'admin'), 'remove again')
    })
  })

  describe('GET /api/backups/:id/download', () => {
    it('sends the backup file', async function () {
      const res = await req('GET', '/api/backups/2020-01-01T0000/download', 'admin')
      snap(this, { status: res.status, headers: res.headers, body: res.body }, 'file')
    })
    it('404s for unknown ids', async function () {
      snap(this, await req('GET', '/api/backups/nope/download', 'admin'))
    })
    it('answers 204 for X-Accel when configured', async function () {
      global.XAccel = '/protected'
      const res = await req('GET', '/api/backups/2020-01-01T0000/download', 'admin')
      snap(this, res, 'x-accel')
    })
    it('fails when the file is missing on disk', async function () {
      const res = await req('GET', '/api/backups/2020-01-02T0000/download', 'admin')
      matchSnapshot(this, { status: res.status }, { label: 'missing file' })
    })
  })

  describe('GET /api/backups/:id/apply', () => {
    it('delegates to the manager with the api cache manager', async function () {
      snap(this, await req('GET', '/api/backups/nope/apply', 'admin'), 'unknown')
      snap(this, await req('GET', '/api/backups/2020-01-02T0000/apply', 'root'), 'apply')
    })
  })

  describe('POST /api/backups/upload', () => {
    it('hands the uploaded file to the manager', async function () {
      snap(this, await req('POST', '/api/backups/upload', 'admin', { form: { files: [{ name: 'file', filename: 'restore.audiobookshelf', content: 'zip-bytes', type: 'application/zip' }] } }), 'file')
    })
    it('rejects a wrong field name with 500', async function () {
      snap(this, await req('POST', '/api/backups/upload', 'admin', { form: { files: [{ name: 'other', filename: 'x.audiobookshelf', content: 'zip' }] } }), 'wrong field')
    })
    it('throws (500) when the request is not multipart', async function () {
      // req.files is undefined, `req.files.file` throws a TypeError; only the status is stable (express prints the stack)
      sinon.stub(console, 'error') // express logs the stack (restored by api.stop)
      const res = await req('POST', '/api/backups/upload', 'admin', { json: {} })
      matchSnapshot(this, { status: res.status, calls }, { label: 'no files' })
    })
  })

  describe('PATCH /api/backups/path', () => {
    const patch = (as, json) => req('PATCH', '/api/backups/path', as, { json })
    it('validates the body', async function () {
      snap(this, await patch('admin', {}), 'empty')
      snap(this, await patch('admin', { path: '   ' }), 'blank')
      snap(this, await patch('admin', { path: 5 }), 'not a string')
    })
    it('does nothing when the path is unchanged', async function () {
      snap(this, await patch('admin', { path: backupDir }))
      expect(Database.serverSettings.backupPath).to.not.equal(backupDir)
    })
    it('creates a new folder, saves the setting and reloads the manager', async function () {
      const target = path.join(api.tmp, 'newbackups')
      snap(this, await patch('admin', { path: target }), 'new folder')
      expect(fs.existsSync(target)).to.equal(true)
      expect(Database.serverSettings.backupPath).to.equal(target)
      const settings = await Database.models.setting.getOldSettings()
      matchSnapshot(this, { persisted: settings.serverSettings.backupPath }, { label: 'persisted', tmpDirs: [api.tmp] })
    })
    it('accepts an existing folder and normalises the path', async function () {
      const existing = path.join(api.tmp, 'existing')
      fs.mkdirSync(existing)
      snap(this, await patch('root', { path: existing + '/./' }), 'existing folder with dot segment')
    })
    it('fails when the parent folder does not exist', async function () {
      const target = path.join(api.tmp, 'missing-parent', 'child')
      snap(this, await patch('admin', { path: target }), 'no parent')
      expect(fs.existsSync(target)).to.equal(false)
    })
  })
})
