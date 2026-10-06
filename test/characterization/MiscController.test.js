const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const sinon = require('sinon')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createUser } = require('./helpers/seed-library-extra')
const { createTaggedBook, createTaggedPodcast, fixedId } = require('./helpers/seed-misc-extra')
const Database = require('../../server/Database')
const Logger = require('../../server/Logger')
const Watcher = require('../../server/Watcher')
const TaskManager = require('../../server/managers/TaskManager')

describe('MiscController (characterization)', () => {
  let api, calls, backupManager, audioMetadataManager, savedLogLevel

  beforeEach(async () => {
    // the default server setting logLevel is read from the Logger singleton (depends on dev/prod) and PATCH /api/settings changes it
    savedLogLevel = Logger.logLevel
    Logger.logLevel = 2
    calls = []
    backupManager = { updateCronSchedule: () => calls.push({ method: 'backupManager.updateCronSchedule' }) }
    audioMetadataManager = { getQueuedTaskData: () => ({ queue: [{ libraryItemId: 'li-1' }], processing: null }) }
    api = await startApi({ managers: { backupManager, audioMetadataManager } })
    await api.seed.users()
    // Watcher is stubbed by the harness for some methods only; these three would reach the real scanner
    for (const method of ['onFileAdded', 'onFileRemoved', 'onFileRename']) sinon.stub(Watcher, method).callsFake((...args) => calls.push({ method: `Watcher.${method}`, args }))
    // Auth.js was loaded while Database was still half-initialised (circular import), so Auth.getUserLoginResponsePayload
    // (POST /api/authorize) throws and the request hangs. Use a fresh copy of Auth.js, as the harness does for TokenManager.
    const authPath = require.resolve('../../server/Auth')
    const cachedAuth = require.cache[authPath]
    delete require.cache[authPath]
    const FreshAuth = require(authPath)
    require.cache[authPath] = cachedAuth
    api.apiRouter.auth = new FreshAuth()
    // switching auth strategies would initialise passport strategies / OIDC discovery
    for (const method of ['useAuthStrategy', 'unuseAuthStrategy']) sinon.stub(api.apiRouter.auth, method).callsFake((...args) => calls.push({ method: `auth.${method}`, args }))
  })

  afterEach(async () => {
    Database.libraryFilterData = {}
    Logger.logManager = null
    Logger.logLevel = savedLogLevel
    TaskManager.tasks = []
    delete process.env.ALLOW_IFRAME
    await api.stop()
  })

  // host/build dependent settings are removed before snapshotting
  const clean = (res) => {
    const out = JSON.parse(JSON.stringify(res))
    for (const s of [out.body?.serverSettings, out.body]) {
      if (s && typeof s === 'object') for (const k of ['timeZone', 'version', 'buildNumber']) delete s[k]
    }
    return out
  }
  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    const c = calls.splice(0)
    matchSnapshot(ctx, { res: clean(res), emitted, ...(c.length ? { calls: c } : {}), ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const rq = (method, url, as, json) => api.request(method, url, { as, json })
  const b64 = (s) => encodeURIComponent(Buffer.from(s).toString('base64'))

  // all routes that are admin-only must reject user and guest
  describe('permissions', () => {
    it('anonymous requests get 401 on every route', async function () {
      const routes = [
        ['POST', '/api/upload'],
        ['GET', '/api/tasks'],
        ['PATCH', '/api/settings'],
        ['PATCH', '/api/sorting-prefixes'],
        ['POST', '/api/authorize'],
        ['GET', '/api/tags'],
        ['POST', '/api/tags/rename'],
        ['DELETE', '/api/tags/abc'],
        ['GET', '/api/genres'],
        ['POST', '/api/genres/rename'],
        ['DELETE', '/api/genres/abc'],
        ['POST', '/api/validate-cron'],
        ['GET', '/api/auth-settings'],
        ['PATCH', '/api/auth-settings'],
        ['POST', '/api/watcher/update'],
        ['GET', '/api/logger-data']
      ]
      for (const [method, url] of routes) snap(this, await rq(method, url), `${method} ${url}`)
    })
    it('user and guest are forbidden on admin-only routes', async function () {
      const routes = [
        ['PATCH', '/api/settings', { language: 'de' }],
        ['PATCH', '/api/sorting-prefixes', { sortingPrefixes: ['x'] }],
        ['GET', '/api/tags'],
        ['POST', '/api/tags/rename', { tag: 'a', newTag: 'b' }],
        ['DELETE', '/api/tags/YQ%3D%3D'],
        ['GET', '/api/genres'],
        ['POST', '/api/genres/rename', { genre: 'a', newGenre: 'b' }],
        ['DELETE', '/api/genres/YQ%3D%3D'],
        ['GET', '/api/auth-settings'],
        ['PATCH', '/api/auth-settings', { authOpenIDButtonText: 'x' }],
        ['POST', '/api/watcher/update', { libraryId: 'l', path: '/p', type: 'add' }],
        ['GET', '/api/logger-data']
      ]
      for (const [method, url, json] of routes) {
        for (const as of ['user', 'guest']) snap(this, await rq(method, url, as, json), `${method} ${url} ${as}`)
      }
      expect(Database.serverSettings.language).to.not.equal('de')
    })
  })

  describe('POST /api/upload', () => {
    let lf, podcastLf, root
    const file = (name, content = 'data', filename = name) => ({ name, filename, content, type: 'audio/mpeg' })
    const upload = (as, fields, files = [file('0', 'audio-bytes', 'chapter 1.mp3')]) => api.request('POST', '/api/upload', { as, form: { fields, files } })
    const tree = (dir) => {
      const out = []
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) walk(p)
          else out.push(`${path.relative(dir, p)} (${fs.statSync(p).size} bytes)`)
        }
      }
      walk(dir)
      return out
    }
    beforeEach(async () => {
      root = path.join(api.tmp, 'uploads')
      fs.mkdirSync(path.join(root, 'books'), { recursive: true })
      fs.mkdirSync(path.join(root, 'pods'), { recursive: true })
      lf = await createLibrary({ name: 'Books', path: path.join(root, 'books') })
      podcastLf = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: path.join(root, 'pods') })
    })
    const fields = (over = {}) => ({ title: 'My Book', author: 'Jane Doe', series: 'Saga', library: lf.library.id, folder: lf.folder.id, ...over })

    it('rejects users without upload permission and missing files', async function () {
      this.ids = new Map()
      snap(this, await upload('guest', fields()), 'guest')
      snap(this, await upload('user', fields()), 'user has no upload permission by default')
      snap(this, await api.request('POST', '/api/upload', { as: 'admin', form: { fields: fields() } }), 'no files')
    })
    it('validates the fields', async function () {
      this.ids = new Map()
      snap(this, await upload('admin', fields({ title: '' })), 'empty title')
      snap(this, await upload('admin', fields({ library: '' })), 'empty library')
      snap(this, await upload('admin', fields({ folder: '' })), 'empty folder')
      snap(this, await upload('admin', fields({ library: fixedId(77) })), 'unknown library')
      snap(this, await upload('admin', fields({ folder: fixedId(78) })), 'unknown folder')
      expect(tree(root)).to.deep.equal([])
    })
    it('checks library access', async function () {
      this.ids = new Map()
      await createUser('uploader', 'user', (p) => {
        p.upload = true
        p.accessAllLibraries = false
        p.librariesAccessible = [podcastLf.library.id]
      })
      snap(this, await upload('uploader', fields()), 'no access')
      snap(this, await upload('uploader', fields({ library: podcastLf.library.id, folder: podcastLf.folder.id, title: 'Pod Show' })), 'access')
      expect(tree(root)).to.deep.equal(['pods/Pod Show/chapter 1.mp3 (11 bytes)'])
    })
    it('stores book uploads under author/series/title', async function () {
      this.ids = new Map()
      snap(this, await upload('admin', fields(), [file('0', 'audio-bytes', 'chapter 1.mp3'), file('1', 'second', 'cover.jpg')]), 'author, series, title')
      snap(this, await upload('root', fields({ series: '', title: 'No Series' })), 'no series')
      snap(this, await upload('admin', fields({ series: '', author: '', title: 'Title Only' })), 'title only')
      expect(tree(root)).to.deep.equal(['books/Jane Doe/No Series/chapter 1.mp3 (11 bytes)', 'books/Jane Doe/Saga/My Book/chapter 1.mp3 (11 bytes)', 'books/Jane Doe/Saga/My Book/cover.jpg (6 bytes)', 'books/Title Only/chapter 1.mp3 (11 bytes)'])
    })
    it('stores podcast uploads one folder deep and ignores author and series', async function () {
      this.ids = new Map()
      snap(this, await upload('admin', fields({ library: podcastLf.library.id, folder: podcastLf.folder.id, title: 'Cast' })), 'podcast')
      expect(tree(root)).to.deep.equal(['pods/Cast/chapter 1.mp3 (11 bytes)'])
    })
    it('sanitizes directory parts and file names', async function () {
      this.ids = new Map()
      snap(this, await upload('admin', fields({ title: 'Why: Not?', author: '../Evil/Author', series: 'a<b>c' }), [file('0', 'x', 'we/ird:na*me?.mp3')]), 'illegal characters')
      snap(this, await upload('admin', fields({ title: '..', author: '', series: '' })), 'dots only title becomes empty part')
      matchSnapshot(this, { files: tree(root) }, { label: 'files on disk', tmpDirs: [api.tmp] })
    })
    it('overwrites an existing file with the same name', async function () {
      this.ids = new Map()
      await upload('admin', fields({ author: '', series: '' }), [file('0', 'first', 'a.mp3')])
      await upload('admin', fields({ author: '', series: '' }), [file('0', 'second!', 'a.mp3')])
      expect(tree(root)).to.deep.equal(['books/My Book/a.mp3 (7 bytes)'])
    })
  })

  describe('GET /api/tasks', () => {
    it('lists tasks and optionally the queue', async function () {
      this.ids = new Map()
      snap(this, await rq('GET', '/api/tasks', 'user'), 'empty as user')
      const task = TaskManager.createAndAddTask('embed-metadata', { text: 'Embedding', key: 'MessageTaskEmbeddingMetadata' }, { text: 'Item', key: 'x', subs: ['a'] }, true, { libraryItemId: 'li-1' })
      api.emitted.splice(0)
      snap(this, await rq('GET', '/api/tasks', 'guest'), 'one task as guest')
      snap(this, await rq('GET', '/api/tasks?include=queue', 'admin'), 'include queue')
      snap(this, await rq('GET', '/api/tasks?include=other,queue', 'admin'), 'include list')
      TaskManager.taskFinished(task)
      snap(this, await rq('GET', '/api/tasks', 'admin'), 'after finish')
    })
  })

  describe('PATCH /api/settings', () => {
    const patch = (as, json) => rq('PATCH', '/api/settings', as, json)
    it('validates the body', async function () {
      snap(this, await api.request('PATCH', '/api/settings', { as: 'admin', headers: { 'content-type': 'application/json' }, json: undefined }), 'no body')
      sinon.stub(console, 'error') // body-parser errors are logged by express (restored by api.stop)
      const bad = await patch('admin', 'a string')
      matchSnapshot(this, { status: bad.status }, { label: 'string body is rejected by the json parser' })
      snap(this, await patch('admin', { allowedOrigins: 'https://a.example' }), 'allowedOrigins not an array')
      process.env.ALLOW_IFRAME = '1'
      snap(this, await patch('admin', { allowIframe: false }), 'cannot disable iframe with env')
      snap(this, await patch('admin', { allowIframe: 'false' }), 'string "false" is not rejected by the iframe check and is stored as a string')
      snap(this, await patch('admin', { allowIframe: true }), 'enabling is fine')
    })
    it('updates patchable keys only and persists them', async function () {
      snap(this, await patch('admin', { language: 'de', dateFormat: 'dd/MM/yyyy', timeFormat: 'HH:mm', bookshelfView: 'standard', scannerFindCovers: true, backupsToKeep: 5, logLevel: 2, allowedOrigins: ['https://a.example'] }), 'admin updates')
      snap(this, await patch('root', { tokenSecret: 'hacked', backupPath: '/evil', authActiveAuthMethods: ['openid'], version: '0.0.0', unknown: 1, maxBackupSize: 3 }), 'root update ignores non patchable keys')
      expect(Database.serverSettings.tokenSecret).to.not.equal('hacked')
      const stored = await Database.models.setting.getOldSettings()
      matchSnapshot(this, { language: stored.serverSettings.language, dateFormat: stored.serverSettings.dateFormat, backupsToKeep: stored.serverSettings.backupsToKeep, maxBackupSize: stored.serverSettings.maxBackupSize, backupPath: stored.serverSettings.backupPath, activeMethods: stored.serverSettings.authActiveAuthMethods }, { label: 'persisted', tmpDirs: [api.tmp] })
    })
    it('reports no change when values are identical and ignores empty updates', async function () {
      snap(this, await patch('admin', { language: 'en-us' }), 'same value')
      snap(this, await patch('admin', {}), 'empty object')
      snap(this, await patch('admin', { notPatchable: true }), 'only unknown keys')
      snap(this, await patch('admin', []), 'array body is accepted as object')
    })
    it('updates the backup schedule through the backup manager', async function () {
      snap(this, await patch('admin', { backupSchedule: '30 1 * * *' }), 'set schedule')
      snap(this, await patch('admin', { backupSchedule: '30 1 * * *' }), 'same schedule makes no update')
      snap(this, await patch('admin', { backupSchedule: false }), 'disable schedule')
      snap(this, await patch('admin', { language: 'fr' }), 'unrelated update does not touch the schedule')
    })
    it('does not validate value types', async function () {
      snap(this, await patch('admin', { backupsToKeep: 'many', scannerFindCovers: 'yes', bookshelfView: 'bogus' }), 'garbage values are stored as given')
    })
  })

  describe('PATCH /api/sorting-prefixes', () => {
    const patch = (as, json) => rq('PATCH', '/api/sorting-prefixes', as, json)
    it('validates the body', async function () {
      snap(this, await patch('admin', {}), 'missing')
      snap(this, await patch('admin', { sortingPrefixes: [] }), 'empty array')
      snap(this, await patch('admin', { sortingPrefixes: 'the' }), 'string with length')
      snap(this, await patch('admin', { sortingPrefixes: ['', '  ', null, 5] }), 'only blank entries')
      expect(Database.serverSettings.sortingPrefixes).to.deep.equal(['the', 'a'])
    })
    it('normalises prefixes and recomputes sort titles of books, podcasts and series', async function () {
      this.ids = new Map()
      const lf = await createLibrary({ name: 'Books' })
      const plf = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: '/test/pods' })
      await createTaggedBook(lf, { n: 1, title: 'The Hobbit' })
      await createTaggedBook(lf, { n: 2, title: 'Le Petit Prince' })
      await createTaggedBook(lf, { n: 3, title: 'Plain' })
      await createTaggedPodcast(plf, { n: 1, title: 'A Show' })
      await Database.seriesModel.create({ id: fixedId(900), name: 'The Saga', nameIgnorePrefix: 'The Saga', libraryId: lf.library.id })
      await Database.seriesModel.create({ id: fixedId(901), name: 'Le Series', nameIgnorePrefix: 'Le Series', libraryId: lf.library.id })
      const rows = async () => ({
        books: (await Database.bookModel.findAll({ order: [['id', 'ASC']] })).map((b) => [b.title, b.titleIgnorePrefix]),
        podcasts: (await Database.podcastModel.findAll({ order: [['id', 'ASC']] })).map((p) => [p.title, p.titleIgnorePrefix]),
        series: (await Database.seriesModel.findAll({ order: [['id', 'ASC']] })).map((s) => [s.name, s.nameIgnorePrefix])
      })
      matchSnapshot(this, await rows(), { label: 'rows before', ids: this.ids })
      snap(this, await patch('admin', { sortingPrefixes: [' The ', 'THE', 'a', 'an', null, ''] }), 'default prefixes, deduplicated and lower-cased')
      matchSnapshot(this, await rows(), { label: 'rows after default prefixes', ids: this.ids })
      snap(this, await patch('root', { sortingPrefixes: ['le'] }), 'only le')
      matchSnapshot(this, await rows(), { label: 'rows after le', ids: this.ids })
      snap(this, await patch('admin', { sortingPrefixes: ['le'] }), 'same again updates no rows')
      const stored = await Database.models.setting.getOldSettings()
      matchSnapshot(this, { persisted: stored.serverSettings.sortingPrefixes }, { label: 'persisted' })
    })
  })

  describe('POST /api/authorize', () => {
    it('returns the login payload of the authenticated user', async function () {
      this.ids = new Map()
      const lf = await createLibrary({ name: 'Books' })
      const res = await rq('POST', '/api/authorize', 'admin')
      expect(res.body.userDefaultLibraryId).to.equal(lf.library.id)
      snap(this, res, 'admin')
      snap(this, await rq('POST', '/api/authorize', 'guest'), 'guest')
      snap(this, await rq('POST', '/api/authorize', 'root'), 'root')
    })
    it('works without libraries', async function () {
      this.ids = new Map()
      snap(this, await rq('POST', '/api/authorize', 'user'), 'user without libraries')
    })
  })

  describe('tags', () => {
    let lf, plf
    beforeEach(async () => {
      lf = await createLibrary({ name: 'Books' })
      plf = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: '/test/pods' })
      await createTaggedBook(lf, { n: 1, title: 'Alpha', tags: ['Fantasy', 'epic'], genres: ['Fiction'] })
      await createTaggedBook(lf, { n: 2, title: 'Beta', tags: ['sci-fi', 'Fantasy'], genres: ['Fiction', 'Drama'] })
      await createTaggedBook(lf, { n: 3, title: 'Gamma' })
      await createTaggedPodcast(plf, { n: 1, title: 'Pod', tags: ['epic', 'Zebra'], genres: ['Tech', 'Drama'] })
      Database.libraryFilterData = { [lf.library.id]: { tags: ['Fantasy', 'epic', 'sci-fi'], genres: ['Fiction', 'Drama'] }, [plf.library.id]: { tags: ['epic', 'Zebra'], genres: ['Tech', 'Drama'] } }
    })
    const storedTags = async () => ({
      books: (await Database.bookModel.findAll({ order: [['id', 'ASC']] })).map((b) => [b.title, b.tags]),
      podcasts: (await Database.podcastModel.findAll()).map((p) => [p.title, p.tags])
    })
    const filterTags = () => Object.fromEntries(Object.entries(Database.libraryFilterData).map(([k, v]) => [k === lf.library.id ? 'books' : 'pods', v.tags]))

    it('GET /api/tags lists distinct tags sorted case-insensitively', async function () {
      this.ids = new Map()
      snap(this, await rq('GET', '/api/tags', 'admin'), 'admin')
      snap(this, await rq('GET', '/api/tags', 'root'), 'root')
    })
    it('GET /api/tags is empty without tagged items', async function () {
      await Database.bookModel.update({ tags: [] }, { where: {} })
      await Database.podcastModel.update({ tags: [] }, { where: {} })
      snap(this, await rq('GET', '/api/tags', 'admin'))
    })
    it('POST /api/tags/rename validates, renames and merges', async function () {
      this.ids = new Map()
      snap(this, await rq('POST', '/api/tags/rename', 'admin', {}), 'empty body')
      snap(this, await rq('POST', '/api/tags/rename', 'admin', { tag: 'Fantasy' }), 'no new tag')
      snap(this, await rq('POST', '/api/tags/rename', 'admin', { tag: 'missing', newTag: 'other' }), 'unknown tag')
      snap(this, await rq('POST', '/api/tags/rename', 'admin', { tag: 'sci-fi', newTag: 'Science Fiction' }), 'rename')
      matchSnapshot(this, { stored: await storedTags(), filter: filterTags() }, { label: 'after rename', ids: this.ids })
      snap(this, await rq('POST', '/api/tags/rename', 'root', { tag: 'epic', newTag: 'Fantasy' }), 'merge into existing (item and podcast)')
      matchSnapshot(this, { stored: await storedTags(), filter: filterTags() }, { label: 'after merge', ids: this.ids })
      snap(this, await rq('GET', '/api/tags', 'admin'), 'tags after')
    })
    it('DELETE /api/tags/:tag removes a base64 encoded tag everywhere', async function () {
      this.ids = new Map()
      snap(this, await rq('DELETE', `/api/tags/${b64('nope')}`, 'admin'), 'unknown tag')
      snap(this, await rq('DELETE', `/api/tags/${b64('Fantasy')}`, 'admin'), 'delete Fantasy')
      matchSnapshot(this, { stored: await storedTags(), filter: filterTags() }, { label: 'after delete', ids: this.ids })
      snap(this, await rq('DELETE', `/api/tags/${b64('epic')}`, 'root'), 'delete epic (book and podcast)')
      snap(this, await rq('DELETE', '/api/tags/not-base64!', 'admin'), 'garbage parameter decodes to some other tag')
    })
  })

  describe('genres', () => {
    let lf, plf
    beforeEach(async () => {
      lf = await createLibrary({ name: 'Books' })
      plf = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: '/test/pods' })
      await createTaggedBook(lf, { n: 1, title: 'Alpha', genres: ['Fiction'] })
      await createTaggedBook(lf, { n: 2, title: 'Beta', genres: ['Fiction', 'Drama'] })
      await createTaggedBook(lf, { n: 3, title: 'Gamma' })
      await createTaggedPodcast(plf, { n: 1, title: 'Pod', genres: ['Tech', 'Drama'] })
      Database.libraryFilterData = { [lf.library.id]: { tags: [], genres: ['Fiction', 'Drama'] }, [plf.library.id]: { tags: [], genres: ['Tech', 'Drama'] } }
    })
    const storedGenres = async () => ({
      books: (await Database.bookModel.findAll({ order: [['id', 'ASC']] })).map((b) => [b.title, b.genres]),
      podcasts: (await Database.podcastModel.findAll()).map((p) => [p.title, p.genres])
    })
    const filterGenres = () => Object.fromEntries(Object.entries(Database.libraryFilterData).map(([k, v]) => [k === lf.library.id ? 'books' : 'pods', v.genres]))

    it('GET /api/genres lists distinct genres in discovery order (not sorted)', async function () {
      this.ids = new Map()
      snap(this, await rq('GET', '/api/genres', 'admin'), 'admin')
      await Database.bookModel.update({ genres: [] }, { where: {} })
      await Database.podcastModel.update({ genres: [] }, { where: {} })
      snap(this, await rq('GET', '/api/genres', 'root'), 'none')
    })
    it('POST /api/genres/rename validates, renames and merges', async function () {
      this.ids = new Map()
      snap(this, await rq('POST', '/api/genres/rename', 'admin', {}), 'empty body')
      snap(this, await rq('POST', '/api/genres/rename', 'admin', { newGenre: 'x' }), 'no genre')
      snap(this, await rq('POST', '/api/genres/rename', 'admin', { genre: 'missing', newGenre: 'other' }), 'unknown genre')
      snap(this, await rq('POST', '/api/genres/rename', 'admin', { genre: 'Tech', newGenre: 'Technology' }), 'rename')
      matchSnapshot(this, { stored: await storedGenres(), filter: filterGenres() }, { label: 'after rename', ids: this.ids })
      snap(this, await rq('POST', '/api/genres/rename', 'root', { genre: 'Drama', newGenre: 'Fiction' }), 'merge')
      matchSnapshot(this, { stored: await storedGenres(), filter: filterGenres() }, { label: 'after merge', ids: this.ids })
    })
    it('DELETE /api/genres/:genre removes a base64 encoded genre everywhere', async function () {
      this.ids = new Map()
      snap(this, await rq('DELETE', `/api/genres/${b64('nope')}`, 'admin'), 'unknown genre')
      snap(this, await rq('DELETE', `/api/genres/${b64('Drama')}`, 'admin'), 'delete Drama')
      matchSnapshot(this, { stored: await storedGenres(), filter: filterGenres() }, { label: 'after delete', ids: this.ids })
    })
  })

  describe('POST /api/validate-cron', () => {
    it('validates cron expressions (any authenticated user)', async function () {
      snap(this, await rq('POST', '/api/validate-cron', 'user', {}), 'missing')
      snap(this, await rq('POST', '/api/validate-cron', 'user', { expression: '' }), 'empty')
      snap(this, await rq('POST', '/api/validate-cron', 'guest', { expression: 'not a cron' }), 'invalid')
      snap(this, await rq('POST', '/api/validate-cron', 'guest', { expression: '99 * * * *' }), 'out of range')
      snap(this, await rq('POST', '/api/validate-cron', 'user', { expression: '0 * * * *' }), 'valid')
      snap(this, await rq('POST', '/api/validate-cron', 'admin', { expression: '*/5 1-3 * * 1,3' }), 'valid with lists and ranges')
      snap(this, await rq('POST', '/api/validate-cron', 'admin', { expression: '* * * * * *' }), 'six fields (seconds)')
      snap(this, await rq('POST', '/api/validate-cron', 'admin', { expression: 5 }), 'number')
    })
  })

  describe('POST /api/watcher/update', () => {
    const post = (as, json) => rq('POST', '/api/watcher/update', as, json)
    it('validates the body', async function () {
      snap(this, await post('admin', {}), 'empty')
      snap(this, await post('admin', { libraryId: 'l', path: '/p' }), 'no type')
      snap(this, await post('admin', { libraryId: 'l', type: 'add' }), 'no path')
      snap(this, await post('admin', { libraryId: 'l', path: '/p', type: 'bogus' }), 'unknown type')
      snap(this, await post('admin', { libraryId: 'l', path: '/new', type: 'rename' }), 'rename without oldPath')
    })
    it('forwards add, unlink and rename to the watcher', async function () {
      snap(this, await post('admin', { libraryId: 'lib-1', path: '/books/a.mp3', type: 'add' }), 'add')
      snap(this, await post('root', { libraryId: 'lib-1', path: '/books/a.mp3', type: 'unlink' }), 'unlink')
      snap(this, await post('admin', { libraryId: 'lib-1', path: '/books/new.mp3', oldPath: '/books/old.mp3', type: 'rename' }), 'rename')
    })
  })

  describe('auth settings', () => {
    const patch = (as, json) => rq('PATCH', '/api/auth-settings', as, json)
    it('GET returns the authentication settings', async function () {
      snap(this, await rq('GET', '/api/auth-settings', 'admin'), 'admin')
      snap(this, await rq('GET', '/api/auth-settings', 'root'), 'root')
    })
    it('PATCH validates the body', async function () {
      sinon.stub(console, 'error') // body-parser errors are logged by express (restored by api.stop)
      const bad = await patch('admin', 'text')
      matchSnapshot(this, { status: bad.status }, { label: 'string body is rejected by the json parser' })
      snap(this, await patch('admin', {}), 'empty')
      snap(this, await patch('admin', { notAKey: 1, authOpenIDIssuerURL: undefined }), 'unknown key')
    })
    it('PATCH changes strings, booleans and sanitizes the login message', async function () {
      snap(this, await patch('admin', { authOpenIDIssuerURL: 'https://issuer.example', authOpenIDButtonText: 'SSO', authOpenIDAutoLaunch: true, authOpenIDAutoRegister: true, authOpenIDClientID: 'cid', authOpenIDClientSecret: 'sec', authOpenIDMatchExistingBy: 'email', authOpenIDSubfolderForRedirectURLs: '/abs' }), 'set openid values')
      snap(this, await patch('root', { authLoginCustomMessage: '<b>Hello</b><script>alert(1)</script>' }), 'login message is sanitized')
      snap(this, await patch('admin', { authLoginCustomMessage: '<script>x</script>' }), 'message that sanitizes to empty becomes null')
      snap(this, await patch('admin', { authOpenIDIssuerURL: '', authOpenIDSubfolderForRedirectURLs: '' }), 'empty string: null except subfolder')
      snap(this, await patch('admin', { authOpenIDIssuerURL: null }), 'null on null is no change')
      snap(this, await rq('GET', '/api/auth-settings', 'admin'), 'settings after')
    })
    it('PATCH ignores wrongly typed values', async function () {
      snap(this, await patch('admin', { authOpenIDAutoLaunch: 'true', authOpenIDAutoRegister: 1, authOpenIDButtonText: 5, authOpenIDIssuerURL: ['x'] }))
    })
    it('PATCH switches auth methods and tells the auth manager', async function () {
      snap(this, await patch('admin', { authActiveAuthMethods: [] }), 'empty list ignored')
      snap(this, await patch('admin', { authActiveAuthMethods: ['bogus'] }), 'unsupported only ignored')
      snap(this, await patch('admin', { authActiveAuthMethods: 'openid' }), 'not an array ignored')
      snap(this, await patch('admin', { authActiveAuthMethods: ['local', 'openid', 'bogus'] }), 'add openid, drop bogus')
      snap(this, await patch('admin', { authActiveAuthMethods: ['openid', 'local'] }), 'same set in other order is no change')
      snap(this, await patch('admin', { authActiveAuthMethods: ['openid'] }), 'remove local')
      snap(this, await patch('admin', { authActiveAuthMethods: ['local'] }), 'back to local only')
    })
    it('PATCH validates mobile redirect URIs', async function () {
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: 'audiobookshelf://oauth' }), 'not an array')
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: ['*', 'audiobookshelf://oauth'] }), 'wildcard mixed with others')
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: ['not a uri'] }), 'bad uri')
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: [5] }), 'non string')
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: ['audiobookshelf://oauth', 'myapp://host/path/x'] }), 'valid uris')
      expect(Database.serverSettings.authOpenIDMobileRedirectURIs).to.deep.equal(['audiobookshelf://oauth', 'myapp://host/path/x'])
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: ['myapp://host/path/x', 'audiobookshelf://oauth'] }), 'same uris other order are no change')
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: ['*'] }), 'wildcard alone')
      snap(this, await patch('admin', { authOpenIDMobileRedirectURIs: [] }), 'empty array is valid and clears')
    })
    it('PATCH persists changes', async function () {
      await patch('admin', { authOpenIDButtonText: 'Persisted', authOpenIDMobileRedirectURIs: ['abs://cb'] })
      const stored = await Database.models.setting.getOldSettings()
      matchSnapshot(this, { text: stored.serverSettings.authOpenIDButtonText, uris: stored.serverSettings.authOpenIDMobileRedirectURIs })
    })
  })

  describe('GET /api/logger-data', () => {
    it('returns the most recent daily logs of the log manager', async function () {
      Logger.logManager = { getMostRecentCurrentDailyLogs: () => [{ timestamp: '2024-01-01 00:00:00.000', source: 'Server', message: 'hello', levelName: 'INFO', level: 2 }] }
      snap(this, await rq('GET', '/api/logger-data', 'admin'), 'admin')
      Logger.logManager = { getMostRecentCurrentDailyLogs: () => '' }
      snap(this, await rq('GET', '/api/logger-data', 'root'), 'no logs yet')
    })
    it.skip('GET /api/logger-data: with Logger.logManager unset (null) the async handler throws and the request hangs (no try/catch)', () => {})
  })
})
