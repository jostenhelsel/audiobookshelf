const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createVisibleBook, createAuthor, linkAuthor, createPodcast, createUser, setProgress, makeAudioFile } = require('./helpers/seed-library-extra')
const Database = require('../../server/Database')
const LibraryScanner = require('../../server/scanner/LibraryScanner')
const Scanner = require('../../server/scanner/Scanner')
const zipHelpers = require('../../server/utils/zipHelpers')
const opmlGenerator = require('../../server/utils/generators/opmlGenerator')

// Every route of LibraryController (28). Scanner, matcher and zip streaming are stubbed at the module boundary and the calls are recorded;
// podcast/cron managers are small fakes. Folder paths used by create/update are real directories inside the harness tmp dir.
describe('LibraryController (characterization)', () => {
  let api, users, lf, other, pod, items, podcast, cron, queue

  beforeEach(async () => {
    cron = { updateLibraryScanCron: sinon.spy() }
    queue = { currentDownload: undefined, queue: [] }
    api = await startApi({
      managers: {
        cronManager: cron,
        podcastManager: { getDownloadQueueDetails: (libraryId) => ({ libraryId, ...queue }), generateOPMLFileText: (podcasts) => opmlGenerator.generate(podcasts) }
      }
    })
    users = await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    other = await createLibrary({ name: 'Other', path: '/test/other' })
    pod = await createLibrary({ name: 'Podcasts', mediaType: 'podcast', path: '/test/podcasts' })
    let order = 1
    for (const l of [lf, other, pod]) {
      await l.library.update({ displayOrder: order++, settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType(l.library.mediaType) })
    }

    // (books have a single author each: multi-author books come back in an order that depends on random ids in several listings)
    // books: distinct authors/series/narrators/genres/durations so lists, filters and stats have real content
    items = {}
    const books = [
      { title: 'Alpha', authors: ['Ann Author'], series: [{ name: 'Saga', sequence: '1' }], extra: { narrators: ['Nora', 'Ned'], genres: ['Fantasy'], tags: ['fav'], duration: 3600, publishedYear: '2001' }, size: 3000 },
      { title: 'Beta', authors: ['Ann Author'], series: [{ name: 'Saga', sequence: '2' }], extra: { narrators: ['Nora'], genres: ['Fantasy', 'Sci-Fi'], duration: 7200, publishedYear: '2005' }, size: 5000 },
      { title: 'Gamma', authors: ['Bob Builder'], extra: { narrators: [], genres: ['Sci-Fi'], duration: 100 }, size: 100 },
      { title: 'Epsilon', authors: ['Ann Author'], extra: { narrators: ['Ned'], genres: ['Fantasy'], duration: 50 }, size: 50 },
      { title: 'Zeta', authors: ['Bob Builder'], extra: { narrators: [], genres: [], duration: 25 }, size: 25 }
    ]
    let day = 1
    for (const b of books) {
      b.extra.audioFiles = [makeAudioFile(`${lf.folder.path}/${b.title}`, `${b.title}.mp3`, b.extra.duration)]
      const created = await createVisibleBook(lf, b)
      await created.libraryItem.update({ size: b.size })
      await Database.libraryItemModel.update({ createdAt: new Date(Date.UTC(2024, 0, day)), updatedAt: new Date(Date.UTC(2024, 0, day)) }, { where: { id: created.libraryItem.id }, silent: true })
      day++
      items[b.title] = created
    }
    // an item with an issue (missing files) and one in another library
    items.Delta = await createVisibleBook(lf, { title: 'Delta', authors: ['Cy Cleaner'], series: [{ name: 'Solo', sequence: '1' }] })
    await items.Delta.libraryItem.update({ isMissing: true })
    items.Elsewhere = await createVisibleBook(other, { title: 'Elsewhere', authors: ['Eve Else'] })
    podcast = await createPodcast(pod, { title: 'Pod One', itunesId: '123', feedURL: 'https://example.test/feed.xml', episodes: ['Ep 1', 'Ep 2'] })
    const podTwo = await createPodcast(pod, { title: 'Pod Two', itunesId: '456', feedURL: 'https://example.test/two.xml', episodes: ['Only'] })
    await podcast.libraryItem.update({ size: 2000 })
    await podTwo.libraryItem.update({ size: 1000 })
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    const watcherCalls = api.watcherCalls.splice(0)
    // filter params carry base64-encoded random ids (and the server echoes them back as filterBy): make them readable so they normalize like ids
    const decodeB64Ids = (v) =>
      JSON.parse(
        JSON.stringify(v).replace(/[A-Za-z0-9+/]{48}/g, (m) => {
          const decoded = Buffer.from(m, 'base64').toString()
          return /^[0-9a-f-]{36}$/i.test(decoded) ? `b64(${decoded})` : m
        })
      )
    matchSnapshot(ctx, decodeB64Ids({ res, emitted, ...(watcherCalls.length ? { watcherCalls } : {}), ...extra }), { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const names = () =>
    new Map([
      [lf.library.id, '<books>'],
      [other.library.id, '<other>'],
      [pod.library.id, '<podcasts>'],
      [lf.folder.id, '<books-folder>']
    ])
  // the 'discover' shelf picks random books; keep only its shape so snapshots stay deterministic
  const stableShelves = (res) => ({ ...res, body: Array.isArray(res.body) ? res.body.map((s) => (s.id === 'discover' ? { id: s.id, type: s.type, numEntities: s.entities.length } : s)) : res.body })
  const get = (url, as = 'admin') => api.request('GET', url, { as })
  const L = () => `/api/libraries/${lf.library.id}`
  const P = () => `/api/libraries/${pod.library.id}`
  const libraryRows = async () => (await Database.libraryModel.findAll({ include: Database.libraryFolderModel, order: [['displayOrder', 'ASC']] })).map((l) => ({ id: l.id, name: l.name, displayOrder: l.displayOrder, mediaType: l.mediaType, icon: l.icon, provider: l.provider, folders: l.libraryFolders.map((f) => f.path).sort() }))
  // LibraryItem's afterDestroy hook destroys the media row without awaiting it, so row counts need a moment to settle after deletes
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100))
  const itemCount = async () => {
    await settle()
    return { libraryItems: await Database.libraryItemModel.count(), books: await Database.bookModel.count(), authors: await Database.authorModel.count(), series: await Database.seriesModel.count() }
  }

  describe('POST /api/libraries', () => {
    const body = (over = {}) => ({ name: 'New Library', folders: [{ fullPath: path.join(api.tmp, 'new-lib') }], ...over })
    it('requires authentication and admin', async function () {
      this.ids = names()
      snap(this, await api.request('POST', '/api/libraries', { json: body() }), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await api.request('POST', '/api/libraries', { as, json: body() }), as)
      snap(this, { rows: await libraryRows() }, 'rows unchanged')
    })
    it('rejects invalid bodies', async function () {
      this.ids = names()
      const post = (json) => api.request('POST', '/api/libraries', { as: 'admin', json })
      snap(this, await post(body({ name: '' })), 'empty name')
      snap(this, await post(body({ name: 5 })), 'numeric name')
      snap(this, await post({ name: 'x' }), 'no folders')
      snap(this, await post(body({ folders: [] })), 'empty folders array (accepted?)')
      snap(this, await post(body({ folders: [{}] })), 'folder without path')
      snap(this, await post(body({ folders: ['x'] })), 'folder not object')
      snap(this, await post(body({ icon: 5 })), 'icon not string')
      snap(this, await post(body({ provider: ['x'] })), 'provider not string')
      snap(this, await post(body({ settings: [] })), 'settings array')
      snap(this, await post(body({ settings: { metadataPrecedence: 'x' } })), 'bad metadataPrecedence')
      snap(this, await post(body({ settings: { autoScanCronExpression: 5 } })), 'bad cron type')
      snap(this, await post(body({ settings: { markAsFinishedPercentComplete: 'abc' } })), 'percent NaN')
      snap(this, await post(body({ settings: { markAsFinishedPercentComplete: 101 } })), 'percent too large')
      snap(this, await post(body({ settings: { markAsFinishedTimeRemaining: -1 } })), 'time remaining negative')
      snap(this, await post(body({ settings: { coverAspectRatio: 'x' } })), 'wrong setting type')
      snap(this, await post(body({ provider: 'custom-missing' })), 'unknown custom provider')
      snap(this, { rows: await libraryRows() }, 'rows unchanged')
    })
    it('creates a book library with defaults', async function () {
      this.ids = names()
      snap(this, await api.request('POST', '/api/libraries', { as: 'admin', json: body() }), 'create')
      snap(this, { rows: await libraryRows(), dirExists: fs.existsSync(path.join(api.tmp, 'new-lib')) }, 'rows')
      snap(this, await get('/api/libraries'), 'list')
    })
    it('creates a podcast library with custom settings', async function () {
      this.ids = names()
      const res = await api.request('POST', '/api/libraries', { as: 'root', json: { name: 'More Pods', mediaType: 'podcast', icon: 'podcast', provider: 'itunes', folders: [{ path: path.join(api.tmp, 'pods-a') }, { fullPath: path.join(api.tmp, 'pods-b') }], settings: { disableWatcher: true, autoScanCronExpression: '0 3 * * *', podcastSearchRegion: 'uk', markAsFinishedPercentComplete: '90', markAsFinishedTimeRemaining: null, unknownSetting: 1 } } })
      snap(this, res, 'create podcast library')
    })
    it('reports a 500 if the library cannot be created', async function () {
      this.ids = names()
      sinon.stub(Database.libraryModel, 'create').rejects(new Error('boom'))
      snap(this, await api.request('POST', '/api/libraries', { as: 'admin', json: body() }), 'create fails')
    })
    it('rejects folders that cannot be created', async function () {
      this.ids = names()
      fs.writeFileSync(path.join(api.tmp, 'a-file'), 'x')
      snap(this, await api.request('POST', '/api/libraries', { as: 'admin', json: { name: 'Bad', folders: [{ path: path.join(api.tmp, 'a-file', 'sub') }] } }), 'folder under a file')
    })
  })

  describe('GET /api/libraries', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/libraries'))
    })
    it('lists libraries in display order, filtered by access', async function () {
      this.ids = names()
      await createUser('limited', 'user', (p) => {
        p.accessAllLibraries = false
        p.librariesAccessible = [other.library.id]
      })
      snap(this, await get('/api/libraries', 'root'), 'root')
      snap(this, await get('/api/libraries', 'guest'), 'guest')
      snap(this, await get('/api/libraries', 'limited'), 'limited user')
    })
    it('includes stats', async function () {
      this.ids = names()
      snap(this, await get('/api/libraries?include=stats'), 'include stats')
    })
  })

  describe('GET /api/libraries/:id', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', L()))
    })
    it('returns a library, with optional filterdata', async function () {
      this.ids = names()
      snap(this, await get(L()), 'plain')
      snap(this, await get(L(), 'user'), 'as user')
      snap(this, await get(`${L()}?include=filterdata`), 'include filterdata')
      snap(this, await get(`${P()}?include=filterdata`), 'podcast include filterdata')
    })
    it('403s without library access and 404s for unknown ids', async function () {
      this.ids = names()
      await createUser('limited', 'user', (p) => {
        p.accessAllLibraries = false
        p.librariesAccessible = [other.library.id]
      })
      snap(this, await get(L(), 'limited'), 'library not accessible')
      snap(this, await get(`/api/libraries/${other.library.id}`, 'limited'), 'library accessible')
      snap(this, await get('/api/libraries/not-a-real-id'), 'unknown id')
      snap(this, await get('/api/libraries/not-a-real-id', 'limited'), 'unknown id as limited user')
    })
    it('validates pagination query params in the shared middleware', async function () {
      this.ids = names()
      snap(this, await get(`${L()}/items?limit=-1`), 'negative limit')
      snap(this, await get(`${L()}/items?page=-2`), 'negative page')
      snap(this, await get(`${L()}/items?limit=1.5`), 'fractional limit')
      snap(this, await get(`${L()}/items?limit=abc&sort=media.metadata.title`), 'non-numeric limit becomes 0')
    })
  })

  describe('PATCH /api/libraries/:id', () => {
    const patch = (json, as = 'admin', id = () => lf.library.id) => api.request('PATCH', `/api/libraries/${id()}`, { as, json })
    it('requires authentication and admin', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', L(), { json: { name: 'x' } }), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await patch({ name: 'Hacked' }, as), as)
      snap(this, await patch({ name: 'x' }, 'admin', () => 'nope'), 'unknown id')
      snap(this, { rows: await libraryRows() }, 'rows unchanged')
    })
    it('rejects invalid payloads', async function () {
      this.ids = names()
      snap(this, await patch({ name: 5 }), 'name not string')
      snap(this, await patch({ icon: {} }), 'icon not string')
      snap(this, await patch({ displayOrder: 'abc' }), 'displayOrder NaN')
      snap(this, await patch({ provider: 'custom-missing' }), 'unknown custom provider')
      snap(this, await patch({ settings: { metadataPrecedence: 'x' } }), 'bad metadataPrecedence')
      snap(this, await patch({ settings: { autoScanCronExpression: 5 } }), 'bad cron')
      snap(this, await patch({ settings: { podcastSearchRegion: 5 } }), 'bad region')
      snap(this, await patch({ settings: { markAsFinishedPercentComplete: 'abc' } }), 'percent NaN')
      snap(this, await patch({ settings: { markAsFinishedPercentComplete: 101 } }), 'percent > 100')
      snap(this, await patch({ settings: { markAsFinishedTimeRemaining: 'abc' } }), 'time NaN')
      snap(this, await patch({ settings: { markAsFinishedTimeRemaining: -5 } }), 'time negative')
      snap(this, await patch({ settings: { disableWatcher: 'yes' } }), 'wrong boolean type')
      snap(this, await patch({ settings: { podcastSearchRegion: 5 } }, 'admin', () => pod.library.id), 'bad region on podcast library')
      snap(this, { rows: await libraryRows() }, 'rows unchanged')
    })
    it('updates name, icon, provider and display order', async function () {
      this.ids = names()
      snap(this, await patch({ name: 'Renamed', icon: 'books', provider: 'audible', displayOrder: 5 }), 'update')
      snap(this, await patch({ name: 'Renamed' }), 'same values still emit nothing new')
      snap(this, await patch({}), 'empty body')
      snap(this, await patch({ mediaType: 'podcast' }), 'media type can be changed')
      snap(this, { rows: await libraryRows() }, 'rows')
    })
    it('updates settings and triggers watcher / cron side effects', async function () {
      this.ids = names()
      snap(this, await patch({ settings: { disableWatcher: true } }), 'disableWatcher')
      snap(this, await patch({ settings: { autoScanCronExpression: '0 4 * * *', coverAspectRatio: 0, skipMatchingMediaWithAsin: true } }), 'cron and others', { cronCalls: cron.updateLibraryScanCron.args.map((a) => a[0].id) })
      snap(this, await patch({ settings: { markAsFinishedPercentComplete: '75', markAsFinishedTimeRemaining: 30, metadataPrecedence: ['fileMetadata', 'folderStructure'], unknownKey: 1 } }), 'numbers and precedence')
      snap(this, await patch({ settings: { markAsFinishedPercentComplete: null, autoScanCronExpression: null } }), 'null values')
      snap(this, await get(L()), 'library afterwards')
    })
    it('adds folders (creating directories)', async function () {
      this.ids = names()
      const second = path.join(api.tmp, 'second-folder')
      snap(this, await patch({ folders: [{ id: lf.folder.id, fullPath: lf.folder.path }, { path: second }] }), 'add folder')
      snap(this, { rows: await libraryRows(), dirExists: fs.existsSync(second) }, 'rows')
    })
    it('removes folders together with their items', async function () {
      this.ids = names()
      const extraFolder = await Database.libraryFolderModel.create({ path: '/test/books-2', libraryId: lf.library.id })
      this.ids.set(extraFolder.id, '<books-folder-2>')
      const inFolder = await createVisibleBook({ library: lf.library, folder: extraFolder }, { title: 'Folder Book', authors: ['Fay Folder'], series: [{ name: 'Folder Series', sequence: '1' }] })
      await createVisibleBook({ library: lf.library, folder: extraFolder }, { title: 'Alpha Two', authors: ['Ann Author'] })
      const before = await itemCount()
      snap(this, await patch({ folders: [{ id: lf.folder.id, path: lf.folder.path }] }), 'remove folder')
      snap(this, { before, after: await itemCount(), rows: await libraryRows(), removedBookGone: !(await Database.libraryItemModel.findByPk(inFolder.libraryItem.id)) }, 'rows and counts')
    })
    it('removes a podcast folder with its episodes', async function () {
      this.ids = names()
      snap(this, await patch({ folders: [] }, 'admin', () => pod.library.id), 'remove all folders of podcast library')
      await settle()
      snap(this, { counts: { items: await Database.libraryItemModel.count({ where: { libraryId: pod.library.id } }), podcasts: await Database.podcastModel.count() } }, 'counts')
    })
    it('rejects folders that cannot be created', async function () {
      this.ids = names()
      fs.writeFileSync(path.join(api.tmp, 'a-file'), 'x')
      snap(this, await patch({ folders: [{ id: lf.folder.id, path: lf.folder.path }, { path: path.join(api.tmp, 'a-file', 'sub') }] }), 'folder under a file')
    })
  })

  describe('DELETE /api/libraries/:id', () => {
    it('requires authentication and admin', async function () {
      this.ids = names()
      snap(this, await api.request('DELETE', L()), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await api.request('DELETE', L(), { as }), as)
      snap(this, await api.request('DELETE', '/api/libraries/nope', { as: 'admin' }), 'unknown id')
    })
    it('deletes a library with its items, collections and reorders the rest', async function () {
      this.ids = names()
      const collection = await Database.collectionModel.create({ name: 'Mine', libraryId: lf.library.id })
      await Database.collectionBookModel.create({ collectionId: collection.id, bookId: items.Alpha.book.id, order: 1 })
      const before = await itemCount()
      snap(this, await api.request('DELETE', L(), { as: 'admin' }), 'admin deletes')
      snap(this, { before, after: await itemCount(), collections: await Database.collectionModel.count(), rows: await libraryRows() }, 'rows and counts')
      snap(this, await get(L()), 'find after delete')
      snap(this, await api.request('DELETE', L(), { as: 'admin' }), 'delete again')
    })
    it('deletes a podcast library', async function () {
      this.ids = names()
      snap(this, await api.request('DELETE', P(), { as: 'root' }), 'root deletes podcast library')
      await settle()
      snap(this, { podcasts: await Database.podcastModel.count(), episodes: await Database.podcastEpisodeModel.count(), rows: await libraryRows() }, 'rows and counts')
    })
  })

  describe('GET /api/libraries/:id/items', () => {
    const sorted = '?sort=media.metadata.title'
    it('requires authentication', async function () {
      snap(this, await api.request('GET', `${L()}/items`))
    })
    it('lists, sorts, paginates and filters', async function () {
      this.ids = names()
      snap(this, await get(`${L()}/items${sorted}`), 'sorted by title')
      snap(this, await get(`${L()}/items${sorted}&desc=1&minified=1`), 'desc minified')
      snap(this, await get(`${L()}/items${sorted}&limit=2&page=0`), 'page 1')
      snap(this, await get(`${L()}/items${sorted}&limit=2&page=1`), 'page 2')
      snap(this, await get(`${L()}/items${sorted}&limit=2&page=5`), 'page out of range')
      snap(this, await get(`${L()}/items?sort=media.duration&desc=1&minified=1`), 'sort by duration')
      snap(this, await get(`${L()}/items${sorted}&filter=genres.${Buffer.from('Sci-Fi').toString('base64')}&minified=1`), 'filter by genre')
      snap(this, await get(`${L()}/items${sorted}&filter=authors.${Buffer.from(String((await Database.authorModel.findOne({ where: { name: 'Bob Builder' } })).id)).toString('base64')}&minified=1`), 'filter by author')
      snap(this, await get(`${L()}/items${sorted}&filter=issues&minified=1`), 'filter issues')
      snap(this, await get(`${L()}/items${sorted}&filter=tags.${Buffer.from('fav').toString('base64')}&minified=1`), 'filter by tag')
      snap(this, await get(`${L()}/items${sorted}&include=rssfeed,numeric&minified=1`), 'include params')
    })
    it('filters by series, collapses series and handles no-series', async function () {
      this.ids = names()
      const saga = await Database.seriesModel.findOne({ where: { name: 'Saga' } })
      this.ids.set(saga.id, '<saga>')
      const enc = (v) => Buffer.from(v).toString('base64')
      snap(this, await get(`${L()}/items${sorted}&filter=series.${enc(saga.id)}&minified=1`), 'filter by series')
      snap(this, await get(`${L()}/items${sorted}&filter=series.${enc(saga.id)}&collapseseries=1&minified=1`), 'series filter with collapseseries')
      snap(this, await get(`${L()}/items${sorted}&filter=series.${enc('no-series')}&minified=1`), 'no-series')
      snap(this, await get(`${L()}/items${sorted}&collapseseries=1&minified=1`), 'collapse all series')
    })
    it('respects user permissions and progress filters', async function () {
      this.ids = names()
      await setProgress(users.user, items.Alpha.book.id, { isFinished: true })
      await setProgress(users.user, items.Beta.book.id, { currentTime: 40 })
      await createUser('tagged', 'user', (p) => {
        p.accessAllTags = false
        p.itemTagsSelected = ['fav']
      })
      const enc = (v) => Buffer.from(v).toString('base64')
      snap(this, await get(`${L()}/items${sorted}&minified=1`, 'tagged'), 'tag restricted user')
      snap(this, await get(`${L()}/items${sorted}&filter=progress.${enc('finished')}&minified=1`, 'user'), 'finished for user')
      snap(this, await get(`${L()}/items${sorted}&filter=progress.${enc('in-progress')}&minified=1`, 'user'), 'in progress for user')
      snap(this, await get(`${L()}/items${sorted}&filter=progress.${enc('not-started')}&minified=1`, 'user'), 'not started for user')
    })
    it('lists podcast items', async function () {
      this.ids = names()
      snap(this, await get(`${P()}/items${sorted}`), 'podcast library')
    })
  })

  describe('DELETE /api/libraries/:id/issues', () => {
    it('requires authentication and admin', async function () {
      this.ids = names()
      snap(this, await api.request('DELETE', `${L()}/issues`), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await api.request('DELETE', `${L()}/issues`, { as }), as)
    })
    it('removes missing items and cleans up empty authors and series', async function () {
      this.ids = names()
      const before = await itemCount()
      snap(this, await api.request('DELETE', `${L()}/issues`, { as: 'admin' }), 'admin removes issues')
      snap(this, { before, after: await itemCount() }, 'counts')
      snap(this, await api.request('DELETE', `${L()}/issues`, { as: 'admin' }), 'nothing left to remove')
    })
    it('removes invalid items in a podcast library', async function () {
      this.ids = names()
      await podcast.libraryItem.update({ isInvalid: true })
      snap(this, await api.request('DELETE', `${P()}/issues`, { as: 'root' }), 'podcast issues')
      await settle()
      snap(this, { podcasts: await Database.podcastModel.count(), episodes: await Database.podcastEpisodeModel.count() }, 'counts')
    })
  })

  describe('GET /api/libraries/:id/episode-downloads', () => {
    it('returns the download queue from the podcast manager', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${P()}/episode-downloads`), 'anonymous')
      snap(this, await get(`${P()}/episode-downloads`), 'empty queue')
      queue = { currentDownload: { id: 'dl1', episodeDisplayTitle: 'Ep 1' }, queue: [{ id: 'dl2' }] }
      snap(this, await get(`${P()}/episode-downloads`, 'user'), 'with queue as user')
      snap(this, await get('/api/libraries/nope/episode-downloads'), 'unknown library')
    })
  })

  describe('GET /api/libraries/:id/series', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', `${L()}/series`))
    })
    it('lists, sorts, paginates and filters series', async function () {
      this.ids = names()
      snap(this, await get(`${L()}/series?sort=name`), 'sort by name, no limit')
      snap(this, await get(`${L()}/series?sort=name&limit=10`), 'sort by name')
      snap(this, await get(`${L()}/series?sort=name&desc=1&limit=1&page=1`), 'desc page 2')
      snap(this, await get(`${L()}/series?sort=numBooks&desc=1&limit=10`), 'sort by numBooks')
      snap(this, await get(`${L()}/series?sort=name&minified=1&include=rssfeed&limit=10`), 'minified with rssfeed')
      snap(this, await get(`${L()}/series?sort=name&limit=10`, 'user'), 'as user')
      snap(this, await get(`${L()}/series?sort=name&limit=10&filter=genres.${Buffer.from('Sci-Fi').toString('base64')}`), 'filter by genre')
      snap(this, await get(`${L()}/series?sort=addedAt&limit=10`), 'sort by addedAt')
    })
  })

  describe('GET /api/libraries/:id/series/:seriesId', () => {
    it('returns a series with optional progress and rssfeed', async function () {
      this.ids = names()
      const saga = await Database.seriesModel.findOne({ where: { name: 'Saga' } })
      const solo = await Database.seriesModel.findOne({ where: { name: 'Solo' } })
      this.ids.set(saga.id, '<saga>')
      await setProgress(users.user, items.Alpha.book.id, { isFinished: true })
      await setProgress(users.user, items.Beta.book.id, { isFinished: true })
      snap(this, await api.request('GET', `${L()}/series/${saga.id}`), 'anonymous')
      snap(this, await get(`${L()}/series/${saga.id}`), 'plain')
      snap(this, await get(`${L()}/series/${saga.id}?include=progress,rssfeed`), 'progress and rssfeed as admin')
      snap(this, await get(`${L()}/series/${saga.id}?include=progress`, 'user'), 'all finished as user')
      snap(this, await get(`${L()}/series/${solo.id}?include=progress`), 'series whose only book is missing')
    })
    it('404s for unknown series and series of another library', async function () {
      this.ids = names()
      const saga = await Database.seriesModel.findOne({ where: { name: 'Saga' } })
      this.ids.set(saga.id, '<saga>')
      snap(this, await get(`${L()}/series/nope`), 'unknown series')
      snap(this, await get(`/api/libraries/${other.library.id}/series/${saga.id}`), 'series in another library')
      snap(this, await get(`/api/libraries/nope/series/${saga.id}`), 'unknown library')
    })
  })

  describe('GET /api/libraries/:id/collections', () => {
    it('lists collections for the library', async function () {
      this.ids = names()
      let order0 = 1
      for (const [name, titles] of [['Favourites', ['Alpha', 'Beta']], ['Short', ['Gamma']]]) {
        const c = await Database.collectionModel.create({ name, libraryId: lf.library.id, description: `${name} desc`, createdAt: new Date(Date.UTC(2024, 1, order0++)) })
        let order = 1
        for (const t of titles) await Database.collectionBookModel.create({ collectionId: c.id, bookId: items[t].book.id, order: order++ })
      }
      await Database.collectionModel.create({ name: 'Other lib', libraryId: other.library.id })
      snap(this, await api.request('GET', `${L()}/collections`), 'anonymous')
      snap(this, await get(`${L()}/collections?sort=name`), 'all')
      snap(this, await get(`${L()}/collections?limit=1&page=1`), 'paginated')
      snap(this, await get(`${L()}/collections?include=rssfeed&minified=1`, 'user'), 'include rssfeed as user')
      snap(this, await get(`/api/libraries/${other.library.id}/collections`), 'other library')
    })
  })

  describe('GET /api/libraries/:id/playlists', () => {
    it('lists the current user playlists in the library', async function () {
      this.ids = names()
      const mine = await Database.playlistModel.create({ name: 'Mine', libraryId: lf.library.id, userId: users.admin.id, description: null })
      await Database.playlistMediaItemModel.create({ playlistId: mine.id, mediaItemId: items.Alpha.book.id, mediaItemType: 'book', order: 1 })
      await Database.playlistMediaItemModel.create({ playlistId: mine.id, mediaItemId: items.Gamma.book.id, mediaItemType: 'book', order: 2 })
      await Database.playlistModel.create({ name: 'Theirs', libraryId: lf.library.id, userId: users.user.id })
      snap(this, await api.request('GET', `${L()}/playlists`), 'anonymous')
      snap(this, await get(`${L()}/playlists`), 'admin')
      snap(this, await get(`${L()}/playlists?limit=1&page=1`), 'paginated beyond end')
      snap(this, await get(`${L()}/playlists`, 'user'), 'user')
      snap(this, await get(`${L()}/playlists`, 'guest'), 'guest has none')
    })
  })

  describe('GET /api/libraries/:id/personalized', () => {
    it('builds home page shelves for books', async function () {
      this.ids = names()
      await setProgress(users.admin, items.Alpha.book.id, { currentTime: 30 })
      snap(this, await api.request('GET', `${L()}/personalized`), 'anonymous')
      snap(this, stableShelves(await get(`${L()}/personalized`)), 'admin')
      snap(this, stableShelves(await get(`${L()}/personalized?limit=1&include=rssfeed`)), 'limit 1')
      snap(this, stableShelves(await get(`${L()}/personalized`, 'user')), 'user')
    })
    it('builds home page shelves for podcasts', async function () {
      this.ids = names()
      snap(this, await get(`${P()}/personalized`), 'podcast admin')
    })
  })

  describe('GET /api/libraries/:id/filterdata', () => {
    it('returns filter data', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${L()}/filterdata`), 'anonymous')
      snap(this, await get(`${L()}/filterdata`), 'book library')
      snap(this, await get(`${P()}/filterdata`, 'user'), 'podcast library as user')
    })
  })

  describe('GET /api/libraries/:id/search', () => {
    it('validates the query', async function () {
      this.ids = names()
      snap(this, await get(`${L()}/search`), 'no q')
      snap(this, await get(`${L()}/search?q=`), 'empty q')
      snap(this, await get(`${L()}/search?q=a&q=b`), 'q twice (array)')
      snap(this, await api.request('GET', `${L()}/search?q=alpha`), 'anonymous')
    })
    it('finds books, authors, series, narrators, tags and genres', async function () {
      this.ids = names()
      snap(this, await get(`${L()}/search?q=alpha`), 'book by title')
      snap(this, await get(`${L()}/search?q=ann`), 'author')
      snap(this, await get(`${L()}/search?q=saga`), 'series')
      snap(this, await get(`${L()}/search?q=nora`), 'narrator')
      snap(this, await get(`${L()}/search?q=fav`), 'tag')
      snap(this, await get(`${L()}/search?q=zzzz`), 'no results')
      snap(this, await get(`${L()}/search?q=a&limit=1`), 'limit 1')
      snap(this, await get(`${L()}/search?q=elsewhere`), 'item of another library is not found')
    })
    it('searches podcasts', async function () {
      this.ids = names()
      snap(this, await get(`${P()}/search?q=pod`), 'podcast titles')
    })
  })

  describe('GET /api/libraries/:id/stats', () => {
    it('returns book library stats', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${L()}/stats`), 'anonymous')
      snap(this, await get(`${L()}/stats`), 'admin')
      snap(this, await get(`${L()}/stats`, 'user'), 'user')
    })
    it('returns podcast library stats', async function () {
      this.ids = names()
      snap(this, await get(`${P()}/stats`), 'podcast')
    })
  })

  describe('GET /api/libraries/:id/authors', () => {
    it('lists authors with number of books', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${L()}/authors`), 'anonymous')
      snap(this, await get(`${L()}/authors`), 'unpaginated (admin sees authors with only missing books)')
      snap(this, await get(`${L()}/authors`, 'user'), 'user')
      snap(this, await get(`${L()}/authors?limit=2&page=0&sort=name`), 'paginated by name')
      snap(this, await get(`${L()}/authors?limit=2&page=1&sort=name&desc=1`), 'page 2 desc')
      snap(this, await get(`${L()}/authors?sort=lastFirst`), 'sort lastFirst')
      snap(this, await get(`${L()}/authors?sort=numBooks&desc=1&limit=3&page=0`), 'numBooks sort paginated')
      snap(this, await get(`${L()}/authors?sort=numBooks`), 'numBooks sort unpaginated')
      snap(this, await get(`${L()}/authors?limit=abc&page=0&sort=name&minified=1&include=items`), 'invalid limit falls back to unpaginated')
    })
    it('admin sees authors without books, users do not', async function () {
      this.ids = names()
      await createAuthor(lf.library, { name: 'Zed Empty' })
      snap(this, await get(`${L()}/authors?sort=name&limit=10&page=0`), 'admin')
      snap(this, await get(`${L()}/authors?sort=name&limit=10&page=0`, 'user'), 'user')
    })
  })

  describe('narrator routes', () => {
    const enc = (n) => encodeURIComponent(Buffer.from(n).toString('base64'))
    const narratorsOf = async () => Object.fromEntries((await Database.bookModel.findAll({ order: [['title', 'ASC']] })).map((b) => [b.title, b.narrators]))

    it('GET lists narrators with counts', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${L()}/narrators`), 'anonymous')
      snap(this, await get(`${L()}/narrators`), 'book library')
      snap(this, await get(`${L()}/narrators`, 'guest'), 'guest')
      snap(this, await get(`${P()}/narrators`), 'podcast library')
    })
    it('PATCH renames a narrator on all books', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `${L()}/narrators/${enc('Nora')}`, { json: { name: 'Norah' } }), 'anonymous')
      snap(this, await api.request('PATCH', `${L()}/narrators/${enc('Nora')}`, { as: 'user', json: { name: 'Norah' } }), 'user forbidden')
      snap(this, await api.request('PATCH', `${L()}/narrators/${enc('Nora')}`, { as: 'admin', json: {} }), 'no name')
      snap(this, await api.request('PATCH', `${L()}/narrators/${enc('Nora')}`, { as: 'admin', json: { name: 'Norah' } }), 'rename')
      snap(this, { narrators: await narratorsOf() }, 'books afterwards')
      snap(this, await api.request('PATCH', `${L()}/narrators/${enc('Ned')}`, { as: 'admin', json: { name: 'Norah' } }), 'merge into existing narrator')
      snap(this, await api.request('PATCH', `${L()}/narrators/${enc('Nobody')}`, { as: 'admin', json: { name: 'Anyone' } }), 'unknown narrator updates nothing')
      snap(this, { narrators: await narratorsOf() }, 'books after merge')
      snap(this, await get(`${L()}/narrators`), 'list afterwards')
    })
    it('DELETE removes a narrator from all books', async function () {
      this.ids = names()
      snap(this, await api.request('DELETE', `${L()}/narrators/${enc('Nora')}`), 'anonymous')
      snap(this, await api.request('DELETE', `${L()}/narrators/${enc('Nora')}`, { as: 'guest' }), 'guest forbidden')
      snap(this, await api.request('DELETE', `${L()}/narrators/${enc('Nora')}`, { as: 'admin' }), 'admin removes')
      snap(this, { narrators: await narratorsOf() }, 'books afterwards')
      snap(this, await api.request('DELETE', `${L()}/narrators/${enc('Nora')}`, { as: 'admin' }), 'again updates nothing')
      snap(this, await api.request('DELETE', `/api/libraries/nope/narrators/${enc('Nora')}`, { as: 'admin' }), 'unknown library')
    })
  })

  describe('GET /api/libraries/:id/matchall', () => {
    it('starts a library match with the scanner stubbed', async function () {
      this.ids = names()
      const stub = sinon.stub(Scanner, 'matchLibraryItems').resolves()
      snap(this, await api.request('GET', `${L()}/matchall`), 'anonymous')
      snap(this, await api.request('GET', `${L()}/matchall`, { as: 'user' }), 'user forbidden')
      snap(this, { calls: stub.callCount }, 'no scanner calls so far')
      snap(this, await api.request('GET', `${L()}/matchall`, { as: 'admin' }), 'admin')
      snap(this, await api.request('GET', `${P()}/matchall`, { as: 'root' }), 'podcast library (scanner decides)')
      snap(this, { calls: stub.args.map(([ctx, library]) => ({ ctxIsApiRouter: ctx === api.apiRouter, libraryId: library.id, name: library.name })) }, 'scanner calls')
      snap(this, await api.request('GET', '/api/libraries/nope/matchall', { as: 'root' }), 'unknown library')
    })
  })

  describe('POST /api/libraries/:id/scan', () => {
    it('triggers a scan with the scanner stubbed', async function () {
      this.ids = names()
      const stub = sinon.stub(LibraryScanner, 'scan').resolves()
      snap(this, await api.request('POST', `${L()}/scan`), 'anonymous')
      snap(this, await api.request('POST', `${L()}/scan`, { as: 'user' }), 'user forbidden')
      snap(this, await api.request('POST', '/api/libraries/nope/scan', { as: 'admin' }), 'unknown library')
      snap(this, { calls: stub.callCount }, 'no scans so far')
      snap(this, await api.request('POST', `${L()}/scan`, { as: 'admin' }), 'admin scan')
      snap(this, await api.request('POST', `${L()}/scan?force=1`, { as: 'root' }), 'root forced scan')
      snap(this, await api.request('POST', `${L()}/scan?force=true`, { as: 'root' }), 'force=true is not forced')
      await new Promise((r) => setTimeout(r, 100))
      snap(this, { calls: stub.args.map(([library, force]) => ({ libraryId: library.id, force })) }, 'scanner calls')
    })
  })

  describe('GET /api/libraries/:id/recent-episodes', () => {
    it('lists recent episodes of a podcast library', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${P()}/recent-episodes`), 'anonymous')
      snap(this, await get(`${P()}/recent-episodes`), 'no limit')
      snap(this, await get(`${P()}/recent-episodes?limit=10`), 'all')
      snap(this, await get(`${P()}/recent-episodes?limit=2&page=0`), 'first page')
      snap(this, await get(`${P()}/recent-episodes?limit=2&page=1`), 'second page')
      snap(this, await get(`${P()}/recent-episodes?limit=10`, 'user'), 'user')
      snap(this, await get(`${L()}/recent-episodes`), 'book library is 404')
    })
  })

  describe('GET /api/libraries/:id/opml', () => {
    it('returns an OPML file for podcasts', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${P()}/opml`), 'anonymous')
      const res = await get(`${P()}/opml`)
      snap(this, res, 'podcast library')
      snap(this, await get(`${P()}/opml`, 'user'), 'user')
      snap(this, await get(`${L()}/opml`), 'book library (empty file)')
    })
  })

  describe('POST /api/libraries/order', () => {
    const order = (json, as = 'admin') => api.request('POST', '/api/libraries/order', { as, json })
    it('requires authentication and admin', async function () {
      this.ids = names()
      snap(this, await api.request('POST', '/api/libraries/order', { json: [] }), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await order([], as), as)
    })
    it('rejects invalid bodies', async function () {
      this.ids = names()
      snap(this, await order({}), 'not an array')
      snap(this, await order([{ id: lf.library.id }]), 'missing newOrder')
      snap(this, await order([{ id: lf.library.id, newOrder: '2' }]), 'newOrder string')
      snap(this, await order([{ id: 5, newOrder: 2 }]), 'numeric id')
      snap(this, await order([{ id: 'nope', newOrder: 2 }]), 'unknown library')
      snap(this, await order([{ id: lf.library.id, newOrder: 9 }, { id: 'nope', newOrder: 2 }]), 'partially applied before the unknown id fails')
      snap(this, { rows: await libraryRows() }, 'rows')
    })
    it('reorders libraries', async function () {
      this.ids = names()
      snap(this, await order([]), 'empty array')
      snap(this, await order([{ id: lf.library.id, newOrder: 1 }]), 'already up to date')
      snap(this, await order([{ id: pod.library.id, newOrder: 1 }, { id: lf.library.id, newOrder: 2 }, { id: other.library.id, newOrder: 3 }]), 'reorder')
      snap(this, await get('/api/libraries'), 'list afterwards')
    })
  })

  describe('POST /api/libraries/:id/remove-metadata', () => {
    it('requires authentication and admin', async function () {
      this.ids = names()
      snap(this, await api.request('POST', `${L()}/remove-metadata`), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await api.request('POST', `${L()}/remove-metadata`, { as }), as)
    })
    it('removes metadata.json / metadata.abs files', async function () {
      this.ids = names()
      const dir = path.join(api.tmp, 'books-on-disk')
      fs.mkdirSync(dir)
      const files = { json: path.join(dir, 'metadata.json'), abs: path.join(dir, 'metadata.abs'), missing: path.join(dir, 'gone', 'metadata.json') }
      fs.writeFileSync(files.json, '{}')
      fs.writeFileSync(files.abs, 'x')
      const lib = (p, filename) => ({ metadata: { filename, path: p, relPath: filename } })
      await items.Alpha.libraryItem.update({ libraryFiles: [lib(files.json, 'metadata.json'), lib(files.abs, 'metadata.abs')] })
      await items.Beta.libraryItem.update({ libraryFiles: [lib(files.missing, 'metadata.json')] })
      snap(this, await api.request('POST', `${L()}/remove-metadata`, { as: 'admin' }), 'default removes metadata.json (one file already gone)', { exists: { json: fs.existsSync(files.json), abs: fs.existsSync(files.abs) } })
      snap(this, await api.request('POST', `${L()}/remove-metadata?ext=abs`, { as: 'admin' }), 'ext=abs', { exists: { json: fs.existsSync(files.json), abs: fs.existsSync(files.abs) } })
      snap(this, await api.request('POST', `${L()}/remove-metadata?ext=abs`, { as: 'admin' }), 'ext=abs again (file gone from disk, still listed)')
      snap(this, await api.request('POST', `${L()}/remove-metadata?ext=other`, { as: 'admin' }), 'unknown ext falls back to json')
      snap(this, await api.request('POST', `${P()}/remove-metadata`, { as: 'root' }), 'library without any metadata files')
      snap(this, await api.request('POST', '/api/libraries/nope/remove-metadata', { as: 'root' }), 'unknown library')
    })
  })

  describe('GET /api/libraries/:id/podcast-titles', () => {
    it('lists podcasts for admins only', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `${P()}/podcast-titles`), 'anonymous')
      snap(this, await get(`${P()}/podcast-titles`, 'user'), 'user forbidden')
      snap(this, await get(`${P()}/podcast-titles`, 'admin'), 'admin')
      snap(this, await get(`${L()}/podcast-titles`, 'admin'), 'book library has none')
      snap(this, await get('/api/libraries/nope/podcast-titles', 'admin'), 'unknown library')
    })
  })

  describe('GET /api/libraries/:id/download', () => {
    it('validates the request and streams a zip (zip helper stubbed)', async function () {
      this.ids = names()
      const stub = sinon.stub(zipHelpers, 'zipDirectoriesPipe').callsFake(async (paths, filename, res) => {
        res.send('zip-bytes')
      })
      const ids = (...t) => t.map((x) => items[x].libraryItem.id).join(',')
      this.ids.set(items.Alpha.libraryItem.id, '<alpha-item>')
      this.ids.set(items.Gamma.libraryItem.id, '<gamma-item>')
      this.ids.set(items.Elsewhere.libraryItem.id, '<elsewhere-item>')
      snap(this, await api.request('GET', `${L()}/download?ids=${ids('Alpha')}`), 'anonymous')
      await createUser('nodownload', 'user', (p) => {
        p.download = false
      })
      snap(this, await get(`${L()}/download?ids=${ids('Alpha')}`, 'nodownload'), 'no download permission')
      snap(this, await get(`${L()}/download`), 'no ids')
      snap(this, await get(`${L()}/download?ids=a&ids=b`), 'ids array')
      snap(this, await get(`${L()}/download?ids=nope`), 'unknown ids')
      snap(this, await get(`${L()}/download?ids=${ids('Elsewhere')}`), 'item from another library')
      snap(this, await get(`${L()}/download?ids=${ids('Alpha', 'Gamma')}`), 'two items')
      snap(this, await get(`${L()}/download?ids=${ids('Alpha')},nope`, 'user'), 'one valid and one unknown id as user')
      snap(this, { calls: stub.args.map(([paths, filename]) => ({ paths, filename: filename.replace(/\d+/, '<now>') })) }, 'zip calls')
    })
    it('maps zip failures through the error handler', async function () {
      this.ids = names()
      sinon.stub(zipHelpers, 'zipDirectoriesPipe').rejects(new Error('disk on fire'))
      const handler = sinon.stub(zipHelpers, 'handleDownloadError').callsFake((error, res) => res.status(500).send(`handled: ${error.message}`))
      snap(this, await get(`${L()}/download?ids=${items.Alpha.libraryItem.id}`), 'zip rejects')
      snap(this, { handlerCalls: handler.callCount }, 'handler')
    })
    it.skip('GET /api/libraries/:id/download (real zip): needs real library item files on disk and archiver streaming (binary, non-deterministic)', () => {})
  })
})
