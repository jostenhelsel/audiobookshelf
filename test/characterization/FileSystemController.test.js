const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary, createBook } = require('./helpers/seed-library')
const { createTaggedBook } = require('./helpers/seed-misc-extra')
const { createUser } = require('./helpers/seed-library-extra')
const Database = require('../../server/Database')

describe('FileSystemController (characterization)', () => {
  let api, root

  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
    // the controller hides some app dirs relative to global.appRoot (restored by api.stop)
    global.appRoot = path.join(api.tmp, 'app')
    root = path.join(api.tmp, 'fs')
    for (const dir of ['fs/Alpha/Inner/Deep', 'fs/Beta', 'fs/Gamma', 'app/node_modules', 'app/client', 'app/config', 'app/books', 'app/metadata']) fs.mkdirSync(path.join(api.tmp, dir), { recursive: true })
    fs.writeFileSync(path.join(root, 'file.txt'), 'not a directory')
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label) => {
    // directory order from readdir is not guaranteed
    if (Array.isArray(res.body?.directories)) res.body.directories.sort((a, b) => (a.path < b.path ? -1 : 1))
    matchSnapshot(ctx, { res }, { label, tmpDirs: [api.tmp] })
  }
  const list = (as, query = '') => api.request('GET', `/api/filesystem${query}`, { as })
  const q = (p, extra = '') => `?path=${encodeURIComponent(p)}${extra}`

  describe('GET /api/filesystem', () => {
    it('requires authentication and admin', async function () {
      snap(this, await list(undefined), 'anonymous')
      snap(this, await list('user'), 'user')
      snap(this, await list('guest'), 'guest')
    })
    it('lists directories of a path, only directories', async function () {
      snap(this, await list('admin', q(root)), 'admin')
      snap(this, await list('root', q(root, '&level=2')), 'root with level 2')
      snap(this, await list('admin', q(path.join(root, 'Alpha'), '&level=abc')), 'non numeric level falls back to 0')
      snap(this, await list('admin', q(path.join(root, 'Beta'))), 'empty directory')
    })
    it('lists a file path as empty (readdir fails)', async function () {
      snap(this, await list('admin', q(path.join(root, 'file.txt'))))
    })
    it('hides app directories like node_modules, client, config and metadata', async function () {
      snap(this, await list('admin', q(global.appRoot)))
    })
    it('validates the path', async function () {
      snap(this, await list('admin', '?path=relative/dir'), 'relative')
      snap(this, await list('admin', q(path.join(root, 'missing'))), 'missing')
    })
    it('lists the filesystem root when no path is given', async function () {
      const res = await list('admin')
      expect(res.status).to.equal(200)
      expect(res.body.posix).to.equal(true)
      expect(res.body.directories).to.be.an('array')
      for (const d of res.body.directories) {
        expect(d.level).to.equal(0)
        expect(d.path).to.equal(`/${d.dirname}`)
      }
      matchSnapshot(this, { status: res.status, posix: res.body.posix, level: [...new Set(res.body.directories.map((d) => d.level))] }, { label: 'root listing facts' })
    })
    it('reports posix=false when isWin is set', async function () {
      global.isWin = true
      // with a path the drive listing is skipped; only getWindowsDrives (no path) would need the OS
      snap(this, await list('admin', q(root)), 'windows with path')
    })
  })

  describe('POST /api/filesystem/pathexists', () => {
    let lf
    const check = (as, json) => api.request('POST', '/api/filesystem/pathexists', { as, json })
    beforeEach(async () => {
      lf = await createLibrary({ name: 'Books', path: root })
    })

    it('requires authentication and upload permission', async function () {
      snap(this, await check(undefined, { directory: 'Alpha', folderPath: root }), 'anonymous')
      snap(this, await check('guest', { directory: 'Alpha', folderPath: root }), 'guest')
    })
    it('validates the body', async function () {
      snap(this, await check('admin', {}), 'empty')
      snap(this, await check('admin', { directory: 'Alpha' }), 'no folderPath')
      snap(this, await check('admin', { directory: 5, folderPath: root }), 'directory not a string')
      snap(this, await check('admin', { directory: '', folderPath: root }), 'empty directory')
    })
    it('404s for an unknown library folder', async function () {
      snap(this, await check('admin', { directory: 'Alpha', folderPath: path.join(root, 'nope') }))
    })
    it('rejects traversal outside the library folder', async function () {
      snap(this, await check('admin', { directory: '../app', folderPath: root }), 'parent')
      snap(this, await check('admin', { directory: '../../etc', folderPath: root }), 'deeper')
    })
    it('reports existing and missing directories', async function () {
      snap(this, await check('admin', { directory: 'Alpha', folderPath: root }), 'existing')
      snap(this, await check('user', { directory: 'Alpha/Inner', folderPath: root }), 'user has no upload permission by default')
      snap(this, await check('root', { directory: 'file.txt', folderPath: root }), 'existing file')
      snap(this, await check('admin', { directory: 'Missing', folderPath: root }), 'missing')
      snap(this, await check('admin', { directory: '/Alpha/', folderPath: root }), 'leading and trailing slash')
    })
    it('detects a library item in a parent subdirectory', async function () {
      await createTaggedBook(lf, { n: 1, title: 'Held', itemPath: path.join(root, 'Writer') })
      await createTaggedBook(lf, { n: 2, title: 'Deeper', itemPath: path.join(root, 'Series') })
      snap(this, await check('admin', { directory: 'Writer/NewBook', folderPath: root }), 'one level below an item')
      snap(this, await check('admin', { directory: 'Series/1/NewBook', folderPath: root }), 'two levels below an item')
      snap(this, await check('admin', { directory: 'Other/NewBook', folderPath: root }), 'no item there')
      snap(this, await check('admin', { directory: 'Series/1/2/NewBook', folderPath: root }), 'three levels is too deep')
    })
    it('allows a user with upload permission', async function () {
      await createUser('uploader', 'user', (p) => {
        p.upload = true
      })
      snap(this, await check('uploader', { directory: 'Alpha/Inner', folderPath: root }), 'existing nested')
    })
    it('respects library access of the user', async function () {
      await createBook(lf, { title: 'x' })
      await createUser('limited', 'user', (p) => {
        p.accessAllLibraries = false
        p.librariesAccessible = []
        p.upload = true
      })
      snap(this, await check('limited', { directory: 'Alpha', folderPath: root }), 'no access to library')
      expect(await Database.libraryFolderModel.count()).to.equal(1)
    })
  })
})
