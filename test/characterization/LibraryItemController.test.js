const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createFileBook, createFilePodcast, waitFor } = require('./helpers/seed-items-extra')
const Database = require('../../server/Database')
const CacheManager = require('../../server/managers/CacheManager')
const CoverManager = require('../../server/managers/CoverManager')
const Scanner = require('../../server/scanner/Scanner')
const LibraryItemScanner = require('../../server/scanner/LibraryItemScanner')
const AudioFileScanner = require('../../server/scanner/AudioFileScanner')
const ffmpegHelpers = require('../../server/utils/ffmpegHelpers')
const { ScanResult } = require('../../server/utils/constants')

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

/*
 * Every /api/items route. Scanner, cover download, ffprobe and the playback/podcast/cron/audio-metadata managers are
 * replaced at the module boundary (sinon / fake managers); everything else (models, files in the temp dir, permissions,
 * serialization) is real.
 */
describe('LibraryItemController (characterization)', () => {
  let api, users, libs, items, fakes, stubs

  beforeEach(async function () {
    fakes = {
      playbackSessionManager: {
        startSessionRequest: sinon.stub().callsFake((req, res, episodeId) => res.json({ fakeSession: true, libraryItemId: req.libraryItem.id, episodeId })),
        calls: []
      },
      podcastManager: {
        getEpisodeDownloadsInQueue: sinon.stub().returns([]),
        currentDownload: null
      },
      cronManager: { checkUpdatePodcastCron: sinon.stub() },
      audioMetadataManager: { getMetadataObjectForApi: (li) => ffmpegHelpers.getFFMetadataObject(li, li.media.includedAudioFiles.length) }
    }
    api = await startApi({ managers: fakes })
    users = await api.seed.users()
    await CacheManager.ensureCachePaths()

    libs = {
      books: await createLibrary({ name: 'Books', path: path.join(api.tmp, 'books') }),
      other: await createLibrary({ name: 'Other', path: path.join(api.tmp, 'other') }),
      pods: await createLibrary({ name: 'Podcasts', mediaType: 'podcast', path: path.join(api.tmp, 'pods') })
    }
    const full = await createFileBook(libs.books, {
      title: 'The Book',
      authors: ['Ann Author'],
      series: [{ name: 'Saga', sequence: '1' }],
      tags: ['fiction'],
      chapters: [
        { id: 0, start: 0, end: 60, title: 'Chapter 1' },
        { id: 1, start: 60, end: 120, title: 'Chapter 2' }
      ],
      audio: [
        { filename: '01 one.mp3', ino: '101' },
        { filename: '02 two.mp3', ino: '102' }
      ],
      ebooks: [
        { filename: 'book.epub', ino: '201', primary: true },
        { filename: 'extra.pdf', ino: '202' }
      ],
      images: [{ filename: 'cover.png', ino: '301' }],
      cover: 'cover.png'
    })
    const second = await createFileBook(libs.books, {
      title: 'Second Book',
      authors: ['Bob Writer'],
      audio: [{ filename: 'only.mp3', ino: '401' }],
      images: [{ filename: 'folder.png', ino: '402' }]
    })
    const ebookOnly = await createFileBook(libs.books, { title: 'Ebook Only', authors: ['Bob Writer'], ebooks: [{ filename: 'solo.epub', ino: '501', primary: true }, { filename: 'solo.pdf', ino: '502' }] })
    const single = await createFileBook(libs.books, { title: 'Single File', isFile: true, audio: [{ filename: 'single.m4b', ino: '601' }] })
    const explicit = await createFileBook(libs.books, { title: 'Explicit Book', explicit: true, audio: [{ filename: 'e.mp3', ino: '701' }] })
    const foreign = await createFileBook(libs.other, { title: 'Foreign Book', audio: [{ filename: 'f.mp3', ino: '801' }] })
    const pod = await createFilePodcast(libs.pods, {
      title: 'The Podcast',
      author: 'Pod Author',
      episodes: [
        { title: 'Episode 1', filename: 'ep1.mp3', ino: '901' },
        { title: 'Episode 2', filename: 'ep2.mp3', ino: '902' }
      ]
    })
    items = { book: full.libraryItem, second: second.libraryItem, ebookOnly: ebookOnly.libraryItem, single: single.libraryItem, explicit: explicit.libraryItem, foreign: foreign.libraryItem, podcast: pod.libraryItem, episodes: pod.episodes, paths: { book: full.itemPath, second: second.itemPath, ebookOnly: ebookOnly.itemPath, podcast: pod.itemPath } }

    stubs = {
      download: sinon.stub(CoverManager, 'downloadCoverFromUrlNew'),
      quickMatch: sinon.stub(Scanner, 'quickMatchLibraryItem'),
      scan: sinon.stub(LibraryItemScanner, 'scanLibraryItem').resolves(ScanResult.UPDATED),
      probe: sinon.stub(AudioFileScanner, 'probeAudioFile').resolves({ format: { duration: '60.0' }, streams: [{ codec_name: 'mp3' }] })
    }

    this.ids = new Map([
      [items.book.id, '<book>'],
      [items.second.id, '<second>'],
      [items.ebookOnly.id, '<ebook-only>'],
      [items.single.id, '<single>'],
      [items.explicit.id, '<explicit>'],
      [items.foreign.id, '<foreign>'],
      [items.podcast.id, '<podcast>'],
      [items.episodes[0].id, '<episode-1>'],
      [items.episodes[1].id, '<episode-2>'],
      [libs.books.library.id, '<lib-books>'],
      [libs.other.library.id, '<lib-other>'],
      [libs.pods.library.id, '<lib-pods>'],
      [users.root.id, '<root>'],
      [users.admin.id, '<admin>'],
      [users.user.id, '<user>'],
      [users.guest.id, '<guest>']
    ])
  })

  afterEach(async () => {
    await api.stop()
    // CacheManager is a singleton: forget the deleted temp paths so other test files see it unconfigured again
    CacheManager.CachePath = CacheManager.CoverCachePath = CacheManager.ImageCachePath = CacheManager.ItemCachePath = null
  })

  // ---------------------------------------------------------------------------------------------------------------------------
  const compressEmitted = (e) => (e.method === 'libraryItemEmitter' ? { method: e.method, event: e.args[0], id: e.args[1]?.id } : e)
  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0).map(compressEmitted)
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  // batch routes process items in database (random uuid) order: replace ids by their names and sort so the snapshot is stable
  const labelled = (ctx, v) => {
    let out = JSON.stringify(v)
    for (const [id, name] of ctx.ids) out = out.split(id).join(name)
    return out
  }
  const snapSorted = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted
      .splice(0)
      .map(compressEmitted)
      .sort((a, b) => (labelled(ctx, a) < labelled(ctx, b) ? -1 : 1))
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const byLabel = (ctx, list, key) => [...list].sort((a, b) => (labelled(ctx, key(a)) < labelled(ctx, key(b)) ? -1 : 1))
  const req = (method, url, as, json) => api.request(method, url, { as, json })
  const get = (id, as = 'root', query = '') => req('GET', `/api/items/${id}${query}`, as)
  /** raw http for binary / header-sensitive routes */
  const raw = async (url, { as, headers = {}, body = true } = {}) => {
    const res = await fetch(api.base + url, { headers: { ...(as ? { 'x-test-user': as } : {}), ...headers }, redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    const type = res.headers.get('content-type')
    const out = { status: res.status, type, disposition: res.headers.get('content-disposition'), accel: res.headers.get('x-accel-redirect'), cache: res.headers.get('cache-control') }
    if (body && !/image\/|zip/.test(type || '')) out.body = buf.toString('utf8')
    else if (body && /image\//.test(type || '')) out.bytes = buf.length
    return out
  }
  const setPerms = async (username, perms) => {
    const u = await Database.userModel.findOne({ where: { username } })
    await u.update({ permissions: { ...u.permissions, ...perms } })
  }
  const dbState = async () => ({
    items: (await Database.libraryItemModel.findAll({ order: [['relPath', 'ASC']] })).map((li) => li.relPath),
    authors: (await Database.authorModel.findAll({ order: [['name', 'ASC']] })).map((a) => a.name),
    series: (await Database.seriesModel.findAll({ order: [['name', 'ASC']] })).map((s) => s.name),
    episodes: (await Database.podcastEpisodeModel.findAll({ order: [['title', 'ASC']] })).map((e) => e.title),
    feeds: await Database.feedModel.count(),
    progress: await Database.mediaProgressModel.count()
  })
  const exists = (...paths) => Object.fromEntries(paths.map((p) => [path.relative(api.tmp, p), fs.existsSync(p)]))
  const readMetadataJson = (id) => {
    const p = path.join(global.MetadataPath, 'items', id, 'metadata.json')
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
  }
  const nameAuthors = async (ctx) => {
    for (const a of await Database.authorModel.findAll()) ctx.ids.set(a.id, `<author ${a.name}>`)
  }
  const createFeed = (item) => Database.feedModel.create({ slug: 'feed-slug', entityType: 'libraryItem', entityId: item.id, entityUpdatedAt: new Date(1000), serverAddress: 'http://localhost', feedURL: '/feed/feed-slug', title: 'Feed', description: 'd', author: 'a', ownerName: 'o', ownerEmail: 'o@x', explicit: false, preventIndexing: true })
  const createProgress = (user, item, extra = {}) => Database.mediaProgressModel.create({ userId: user.id, mediaItemId: item.mediaId, mediaItemType: 'book', duration: 120, currentTime: 30, isFinished: false, extraData: { libraryItemId: item.id }, ...extra })

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('GET /api/items/:id', () => {
    it('requires authentication and 404s for unknown ids', async function () {
      snap(this, await api.request('GET', `/api/items/${items.book.id}`), 'anonymous')
      snap(this, await get('nope'), 'unknown id')
    })
    it('returns the minified item or the expanded item', async function () {
      snap(this, await get(items.book.id, 'user'), 'default')
      snap(this, await get(items.book.id, 'user', '?expanded=1'), 'expanded')
      snap(this, await get(items.podcast.id, 'guest', '?expanded=1'), 'podcast expanded')
      snap(this, await get(items.single.id, 'user', '?expanded=1'), 'single file item expanded')
    })
    it('includes the user progress', async function () {
      await createProgress(users.user, items.book)
      snap(this, await get(items.book.id, 'user', '?expanded=1&include=progress'), 'with progress')
      snap(this, await get(items.book.id, 'admin', '?expanded=1&include=progress'), 'user without progress')
      snap(this, await get(items.book.id, 'user', '?include=progress'), 'include ignored without expanded')
    })
    it('includes progress for a podcast episode', async function () {
      await createProgress(users.user, { id: items.podcast.id, mediaId: items.episodes[0].id }, { mediaItemType: 'podcastEpisode', podcastId: items.podcast.mediaId })
      snap(this, await get(items.podcast.id, 'user', `?expanded=1&include=progress&episode=${items.episodes[0].id}`), 'episode progress')
      snap(this, await get(items.podcast.id, 'user', `?expanded=1&include=progress&episode=${items.episodes[1].id}`), 'other episode')
    })
    it('includes the rss feed and share', async function () {
      snap(this, await get(items.book.id, 'admin', '?expanded=1&include=rssfeed,share'), 'no feed')
      await createFeed(items.book)
      snap(this, await get(items.book.id, 'admin', '?expanded=1&include=rssfeed,share'), 'feed as admin')
      snap(this, await get(items.book.id, 'user', '?expanded=1&include=rssfeed,share'), 'feed as user')
    })
    it('includes podcast downloads', async function () {
      snap(this, await get(items.podcast.id, 'user', '?expanded=1&include=downloads'), 'nothing queued')
      const download = (id) => ({ libraryItemId: id, toJSONForClient: () => ({ id: 'dl-1', libraryItemId: id, episodeTitle: 'Episode 3' }) })
      fakes.podcastManager.getEpisodeDownloadsInQueue.returns([download(items.podcast.id)])
      fakes.podcastManager.currentDownload = download(items.podcast.id)
      snap(this, await get(items.podcast.id, 'user', '?expanded=1&include=downloads'), 'queued and downloading')
    })
    it('checks library access, tags and explicit content', async function () {
      snap(this, await get(items.explicit.id, 'user'), 'explicit as user')
      snap(this, await get(items.explicit.id, 'admin'), 'explicit as admin')
      await setPerms('user', { accessAllLibraries: false, librariesAccessible: [libs.other.library.id] })
      snap(this, await get(items.book.id, 'user'), 'library not accessible')
      snap(this, await get(items.foreign.id, 'user'), 'library accessible')
      await setPerms('guest', { accessAllTags: false, itemTagsSelected: ['nonfiction'] })
      snap(this, await get(items.book.id, 'guest'), 'tag not selected')
      await setPerms('guest', { itemTagsSelected: ['fiction'] })
      snap(this, await get(items.book.id, 'guest'), 'tag selected')
    })
  })

  describe('DELETE /api/items/:id', () => {
    it('requires authentication, delete permission and an existing item', async function () {
      snap(this, await api.request('DELETE', `/api/items/${items.book.id}`), 'anonymous')
      for (const as of ['admin', 'user', 'guest']) snap(this, await req('DELETE', `/api/items/${items.book.id}`, as), `${as} has no delete permission`)
      snap(this, await req('DELETE', '/api/items/nope', 'root'), 'unknown id')
      snap(this, await get(items.book.id), 'item still exists', { state: await dbState() })
    })
    it('soft deletes: removes db rows, progress, playlists, feed and cleans empty authors/series but keeps files', async function () {
      await createProgress(users.user, items.book)
      await createFeed(items.book)
      fs.mkdirSync(path.join(global.MetadataPath, 'items', items.book.id), { recursive: true })
      fs.writeFileSync(path.join(global.MetadataPath, 'items', items.book.id, 'metadata.json'), '{}')
      fs.writeFileSync(path.join(CacheManager.CoverCachePath, `${items.book.id}_400.webp`), 'x')
      snap(this, await req('DELETE', `/api/items/${items.book.id}`, 'root'), 'delete', { state: await dbState(), files: exists(items.paths.book, path.join(global.MetadataPath, 'items', items.book.id), path.join(CacheManager.CoverCachePath, `${items.book.id}_400.webp`)) })
      snap(this, await get(items.book.id), 'get after delete')
      snap(this, await req('DELETE', `/api/items/${items.book.id}`, 'root'), 'delete again')
    })
    it('keeps authors that still have other books', async function () {
      snap(this, await req('DELETE', `/api/items/${items.second.id}`, 'root'), 'delete second', { state: await dbState() })
    })
    it('hard deletes files from disk', async function () {
      snap(this, await req('DELETE', `/api/items/${items.second.id}?hard=1`, 'root'), 'hard delete', { state: await dbState(), files: exists(items.paths.second) })
    })
    it('hard deletes a single file item', async function () {
      snap(this, await req('DELETE', `/api/items/${items.single.id}?hard=1`, 'root'), 'hard delete single', { files: exists(items.single.path) })
    })
    it('deletes a podcast with its episodes progress', async function () {
      await createProgress(users.user, { id: items.podcast.id, mediaId: items.episodes[0].id }, { mediaItemType: 'podcastEpisode', podcastId: items.podcast.mediaId })
      snap(this, await req('DELETE', `/api/items/${items.podcast.id}?hard=1`, 'root'), 'delete podcast', { state: await dbState(), files: exists(items.paths.podcast) })
    })
    it('allows a user granted delete permission', async function () {
      await setPerms('user', { delete: true })
      snap(this, await req('DELETE', `/api/items/${items.second.id}`, 'user'), 'user with delete permission')
    })
  })

  describe('GET /api/items/:id/download', () => {
    it('requires authentication, download permission and an existing item', async function () {
      snap(this, await raw(`/api/items/${items.book.id}/download`), 'anonymous')
      snap(this, await raw('/api/items/nope/download', { as: 'user' }), 'unknown id')
      await setPerms('user', { download: false })
      snap(this, await raw(`/api/items/${items.book.id}/download`, { as: 'user' }), 'no download permission')
    })
    it('zips a folder item', async function () {
      snap(this, await raw(`/api/items/${items.book.id}/download`, { as: 'user', body: false }), 'zip')
    })
    it('sends a single file item as is', async function () {
      snap(this, await raw(`/api/items/${items.single.id}/download`, { as: 'guest' }), 'single file')
    })
    it('404s when the single file is gone', async function () {
      fs.rmSync(items.single.path)
      snap(this, await raw(`/api/items/${items.single.id}/download`, { as: 'guest' }), 'missing file')
    })
  })

  describe('PATCH /api/items/:id/media', () => {
    const patch = (id, as, json) => req('PATCH', `/api/items/${id}/media`, as, json)
    it('requires authentication and update permission', async function () {
      snap(this, await api.request('PATCH', `/api/items/${items.book.id}/media`, { json: {} }), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await patch(items.book.id, as, { metadata: { title: 'x' } }), `${as} cannot update`)
      snap(this, await patch('nope', 'admin', {}), 'unknown id')
    })
    it('updates book metadata', async function () {
      snap(
        this,
        await patch(items.book.id, 'admin', {
          metadata: { title: 'New Title', subtitle: 'Sub', publishedYear: 1999, publisher: 'Pub', description: '<p>Hello <script>alert(1)</script><b>there</b></p>', isbn: '123', asin: 'B0TEST', language: 'English', explicit: true, abridged: true, narrators: ['N One', 'N Two'], genres: ['Fantasy'] },
          tags: ['a', 'b']
        }),
        'full update'
      )
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'expanded after update', { metadataFile: readMetadataJson(items.book.id) })
    })
    it('reports no change when nothing differs, and ignores invalid values', async function () {
      snap(this, await patch(items.book.id, 'admin', { metadata: { title: 'The Book' } }), 'same title')
      snap(this, await patch(items.book.id, 'admin', { metadata: { title: ['x'], narrators: [1, 2], genres: 'x' }, tags: [5] }), 'invalid types')
      snap(this, await patch(items.book.id, 'admin', {}), 'empty payload')
    })
    it('accepts an empty title (recorded as is)', async function () {
      snap(this, await patch(items.book.id, 'admin', { metadata: { title: '' } }))
    })
    it('adds, updates and removes series', async function () {
      snap(this, await patch(items.book.id, 'admin', { metadata: { series: [{ name: 'Saga', sequence: '2' }, { name: 'New Series', sequence: '1' }] } }), 'add and update sequence')
      snap(this, await patch(items.book.id, 'admin', { metadata: { series: [{ name: 'New Series' }] } }), 'remove Saga (becomes empty and is deleted)', { state: await dbState() })
      snap(this, await patch(items.book.id, 'admin', { metadata: { series: [{ nope: true }] } }), 'invalid series ignored')
      snap(this, await patch(items.book.id, 'admin', { metadata: { series: [] } }), 'remove all')
    })
    it('adds and removes authors', async function () {
      snap(this, await patch(items.book.id, 'admin', { metadata: { authors: [{ name: 'Ann Author' }, { name: '  New Author  ' }, { name: 5 }, {}] } }), 'add author (trimmed)')
      await nameAuthors(this)
      snapSorted(this, await patch(items.book.id, 'admin', { metadata: { authors: [{ name: 'Bob Writer' }] } }), 'replace authors, Ann and New Author are deleted', { state: await dbState() })
      snap(this, await patch(items.book.id, 'admin', { metadata: { authors: [] } }), 'remove all authors')
    })
    it('updates a cover from a url (cover download stubbed)', async function () {
      stubs.download.resolves({ cover: path.join(items.paths.book, 'downloaded.png') })
      snap(this, await patch(items.book.id, 'admin', { url: 'https://example.com/c.png' }), 'url ok')
      snap(this, { status: 0, body: stubs.download.getCalls().map((c) => c.args) }, 'download args')
      stubs.download.resolves({ error: 'Cover download failed' })
      snap(this, await patch(items.book.id, 'admin', { url: 'https://example.com/c.png' }), 'url error')
      stubs.download.resolves(null)
      snap(this, await patch(items.book.id, 'admin', { url: 'https://example.com/c.png' }), 'url unknown error')
      snap(this, await patch(items.single.id, 'admin', { url: 'https://example.com/c.png' }), 'single file item gets no item path')
      snap(this, { status: 0, body: stubs.download.getCalls().map((c) => c.args) }, 'all download args')
    })
    it('requires upload permission for a url cover', async function () {
      await setPerms('user', { update: true })
      snap(this, await patch(items.book.id, 'user', { url: 'https://example.com/c.png' }), 'update but no upload')
      snap(this, await patch(items.book.id, 'user', { metadata: { title: 'Allowed' } }), 'update only')
    })
    it('updates podcast media and auto download schedule', async function () {
      snap(this, await patch(items.podcast.id, 'admin', { autoDownloadSchedule: 'not a cron' }), 'invalid cron')
      snap(this, await patch(items.podcast.id, 'admin', { autoDownloadEpisodes: true, autoDownloadSchedule: '0 6 * * *', maxEpisodesToKeep: 5, maxNewEpisodesToDownload: 2, metadata: { title: 'Renamed Pod', author: 'New Author', feedUrl: 'https://example.com/feed.xml', explicit: true, genres: ['Tech'], type: 'serial' }, tags: ['t'] }), 'update')
      snap(this, { status: 0, body: fakes.cronManager.checkUpdatePodcastCron.getCalls().map((c) => c.args[0].id) }, 'cron checked')
      snap(this, await patch(items.podcast.id, 'admin', { metadata: { description: 'About' } }), 'no cron change')
      snap(this, await get(items.podcast.id, 'root', '?expanded=1'), 'podcast after update', { metadataFile: readMetadataJson(items.podcast.id), cronCalls: fakes.cronManager.checkUpdatePodcastCron.callCount })
    })
  })

  describe('POST /api/items/:id/cover', () => {
    const post = (id, as, json) => req('POST', `/api/items/${id}/cover`, as, json)
    it('requires authentication, update and upload permission', async function () {
      snap(this, await api.request('POST', `/api/items/${items.book.id}/cover`, { json: { url: 'x' } }), 'anonymous')
      snap(this, await post(items.book.id, 'user', { url: 'https://example.com/c.png' }), 'user')
      await setPerms('user', { update: true })
      snap(this, await post(items.book.id, 'user', { url: 'https://example.com/c.png' }), 'user with update but no upload')
      snap(this, await post('nope', 'admin', {}), 'unknown id')
    })
    it('rejects requests without file or url', async function () {
      snap(this, await post(items.book.id, 'admin', {}), 'empty body')
      snap(this, await post(items.book.id, 'admin', { url: '' }), 'empty url')
    })
    it('sets the cover from a url (download stubbed)', async function () {
      stubs.download.resolves({ cover: path.join(items.paths.book, 'new.png') })
      snap(this, await post(items.book.id, 'admin', { url: 'https://example.com/c.png' }), 'ok')
      snap(this, { status: 0, body: stubs.download.getCalls().map((c) => c.args) }, 'download args')
      snap(this, await get(items.book.id, 'root'), 'item after', {})
    })
    it('maps cover errors', async function () {
      stubs.download.resolves({ error: 'Invalid image' })
      snap(this, await post(items.book.id, 'admin', { url: 'https://example.com/c.png' }), 'download error')
      stubs.download.resolves({})
      snap(this, await post(items.book.id, 'admin', { url: 'https://example.com/c.png' }), 'no cover returned')
    })
    it.skip('POST /api/items/:id/cover (multipart file): needs the express-fileupload middleware, which the harness does not mount (req.files)', () => {})
  })

  describe('PATCH /api/items/:id/cover', () => {
    const patch = (id, as, json) => req('PATCH', `/api/items/${id}/cover`, as, json)
    it('requires authentication and update permission', async function () {
      snap(this, await api.request('PATCH', `/api/items/${items.second.id}/cover`, { json: { cover: 'x' } }), 'anonymous')
      snap(this, await patch(items.second.id, 'user', { cover: 'x' }), 'user')
      snap(this, await patch('nope', 'admin', { cover: 'x' }), 'unknown id')
    })
    it('validates the cover path (errors are 500)', async function () {
      snap(this, await patch(items.second.id, 'admin', {}), 'no cover')
      snap(this, await patch(items.second.id, 'admin', { cover: 'https://example.com/c.png' }), 'http url')
      snap(this, await patch(items.second.id, 'admin', { cover: path.join(items.paths.second, 'unknown.png') }), 'not a library file')
      snap(this, await patch(items.second.id, 'admin', { cover: path.join(items.paths.second, 'only.mp3') }), 'not an image')
      fs.rmSync(path.join(items.paths.second, 'folder.png'))
      snap(this, await patch(items.second.id, 'admin', { cover: path.join(items.paths.second, 'folder.png') }), 'file missing on disk')
    })
    it('sets the cover from a library image, copying it into the metadata dir', async function () {
      snap(this, await patch(items.second.id, 'admin', { cover: path.join(items.paths.second, 'folder.png') }), 'set', { files: exists(path.join(global.MetadataPath, 'items', items.second.id, 'cover.png')) })
      snap(this, await get(items.second.id, 'root', '?expanded=1'), 'item after')
      snap(this, await patch(items.second.id, 'admin', { cover: path.join(global.MetadataPath, 'items', items.second.id, 'cover.png') }), 'copied path is not a library file')
    })
    it('is a no-op when the cover is already set', async function () {
      snap(this, await patch(items.book.id, 'admin', { cover: path.join(items.paths.book, 'cover.png') }), 'already set')
    })
  })

  describe('DELETE /api/items/:id/cover', () => {
    const del = (id, as) => req('DELETE', `/api/items/${id}/cover`, as)
    it('requires authentication and delete permission', async function () {
      snap(this, await api.request('DELETE', `/api/items/${items.book.id}/cover`), 'anonymous')
      for (const as of ['admin', 'user']) snap(this, await del(items.book.id, as), `${as} has no delete permission`)
      snap(this, await del('nope', 'root'), 'unknown id')
    })
    it('removes the cover and purges the cover cache', async function () {
      const cached = path.join(CacheManager.CoverCachePath, `${items.book.id}_400.webp`)
      fs.writeFileSync(cached, 'x')
      snap(this, await del(items.book.id, 'root'), 'remove', { files: exists(cached, path.join(items.paths.book, 'cover.png')) })
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'item after')
      snap(this, await del(items.book.id, 'root'), 'remove again (no emit)')
    })
  })

  describe('GET /api/items/:id/cover', () => {
    const cover = (id, query = '', o = {}) => raw(`/api/items/${id}/cover${query}`, { as: 'user', ...o })
    it('requires authentication', async function () {
      snap(this, await raw(`/api/items/${items.book.id}/cover`), 'anonymous')
    })
    it('serves the raw cover file', async function () {
      snap(this, await cover(items.book.id, '?raw=1'), 'raw')
      snap(this, await cover(items.book.id, '?raw=1&ts=123'), 'raw with ts sets cache-control')
      snap(this, await cover(items.second.id, '?raw=1'), 'raw without cover')
      snap(this, await cover('nope', '?raw=1'), 'raw unknown item')
      fs.rmSync(path.join(items.paths.book, 'cover.png'))
      snap(this, await cover(items.book.id, '?raw=1'), 'raw cover file missing on disk')
    })
    it('redirects with X-Accel when configured', async function () {
      global.XAccel = '/protected'
      snap(this, await cover(items.book.id, '?raw=1'), 'raw')
      fs.writeFileSync(path.join(CacheManager.CoverCachePath, `${items.book.id}_400.webp`), 'x')
      snap(this, await cover(items.book.id), 'cached')
    })
    it('serves a cached resized cover', async function () {
      fs.writeFileSync(path.join(CacheManager.CoverCachePath, `${items.book.id}_400.webp`), 'cached-webp')
      fs.writeFileSync(path.join(CacheManager.CoverCachePath, `${items.book.id}_200x300.jpeg`), 'cached-jpeg')
      snap(this, await cover(items.book.id), 'default (webp 400)')
      snap(this, await cover(items.book.id, '?width=200&height=300&format=jpeg'), 'jpeg 200x300')
      snap(this, await cover(items.second.id, '', { headers: { accept: 'image/png' } }), 'accept without webp falls back to jpeg (uncached, no cover)')
    })
    it('validates id and options', async function () {
      snap(this, await cover('nope'), 'not a uuid')
      snap(this, await cover(items.book.id, '?format=gif'), 'bad format')
      snap(this, await cover(items.second.id, '?width=-5'), 'negative width (item without cover, so no resize happens)')
      snap(this, await cover(items.second.id, '?width=abc'), 'non numeric width (item without cover)')
      snap(this, await cover(items.second.id), 'uncached item without cover')
      snap(this, await cover('11111111-1111-4111-8111-111111111111'), 'uuid of unknown item')
    })
    it('does not check library access (recorded)', async function () {
      await setPerms('user', { accessAllLibraries: false, librariesAccessible: [libs.other.library.id] })
      snap(this, await cover(items.book.id, '?raw=1'), 'user without library access still gets the cover')
    })
    it.skip('GET /api/items/:id/cover (cache miss with a cover): needs ffmpeg to resize the image (resizeImage)', () => {})
  })

  describe('POST /api/items/:id/match', () => {
    const match = (id, as, json) => req('POST', `/api/items/${id}/match`, as, json)
    const matchCalls = () => stubs.quickMatch.getCalls().map((c) => ({ item: c.args[1].id, options: c.args[2] }))
    it('requires authentication and update permission', async function () {
      snap(this, await api.request('POST', `/api/items/${items.book.id}/match`, { json: {} }), 'anonymous')
      snap(this, await match(items.book.id, 'user', {}), 'user')
      snap(this, await match('nope', 'admin', {}), 'unknown id')
    })
    it('passes sanitized options to the scanner (stubbed) and returns its result', async function () {
      stubs.quickMatch.resolves({ updated: true, libraryItem: { id: 'x', title: 'Matched' } })
      snap(this, await match(items.book.id, 'admin', { provider: 'audible', title: 'T', author: 'A', isbn: '1', asin: 'B', overrideCover: 1, overrideDetails: 0, ignored: 'x' }), 'all options')
      snap(this, await match(items.book.id, 'admin', { provider: 5, title: '', author: ['a'], overrideCover: false }), 'invalid options dropped')
      snap(this, await match(items.book.id, 'admin'), 'no body')
      stubs.quickMatch.resolves({ warning: 'No results found' })
      snap(this, await match(items.podcast.id, 'root', { provider: 'itunes' }), 'warning result')
      snap(this, { status: 0, body: matchCalls() }, 'scanner calls')
    })
  })

  describe('POST /api/items/:id/play and /play/:episodeId', () => {
    it('requires authentication, 404s for unknown items', async function () {
      snap(this, await api.request('POST', `/api/items/${items.book.id}/play`), 'anonymous')
      snap(this, await req('POST', '/api/items/nope/play', 'user', {}), 'unknown id')
    })
    it('starts a session for any user (no update permission needed)', async function () {
      for (const as of ['user', 'guest']) snap(this, await req('POST', `/api/items/${items.book.id}/play`, as, {}), `${as} plays book`)
      snap(this, await req('POST', `/api/items/${items.podcast.id}/play`, 'user', {}), 'podcast without episode id')
    })
    it('404s for items without audio tracks', async function () {
      snap(this, await req('POST', `/api/items/${items.ebookOnly.id}/play`, 'user', {}), 'ebook only')
    })
    it('checks access', async function () {
      await setPerms('user', { accessAllLibraries: false, librariesAccessible: [libs.other.library.id] })
      snap(this, await req('POST', `/api/items/${items.book.id}/play`, 'user', {}), 'no library access')
      snap(this, await req('POST', `/api/items/${items.explicit.id}/play`, 'guest', {}), 'explicit content')
    })
    it('starts podcast episode sessions', async function () {
      snap(this, await req('POST', `/api/items/${items.podcast.id}/play/${items.episodes[1].id}`, 'user', {}), 'episode')
      snap(this, await req('POST', `/api/items/${items.podcast.id}/play/nope`, 'user', {}), 'unknown episode')
      snap(this, await req('POST', `/api/items/${items.book.id}/play/${items.episodes[0].id}`, 'user', {}), 'book is not a podcast')
      snap(this, await api.request('POST', `/api/items/${items.podcast.id}/play/${items.episodes[1].id}`), 'anonymous')
    })
  })

  describe('PATCH /api/items/:id/tracks', () => {
    const patch = (id, as, json) => req('PATCH', `/api/items/${id}/tracks`, as, json)
    it('requires authentication and update permission', async function () {
      snap(this, await api.request('PATCH', `/api/items/${items.book.id}/tracks`, { json: {} }), 'anonymous')
      snap(this, await patch(items.book.id, 'user', { orderedFileData: [{ ino: '101' }] }), 'user')
      snap(this, await patch('nope', 'admin', {}), 'unknown id')
    })
    it('validates the payload (bare 400s)', async function () {
      snap(this, await patch(items.podcast.id, 'admin', { orderedFileData: [{ ino: '901' }] }), 'podcast')
      snap(this, await patch(items.book.id, 'admin', {}), 'no data')
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: [] }), 'empty')
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: 'x' }), 'not an array')
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: [{ ino: '999' }] }), 'unknown ino')
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: [{ ino: '101' }, null] }), 'null entry')
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: [{ ino: '301' }] }), 'ino of a non audio file')
    })
    it('reorders and excludes tracks', async function () {
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: [{ ino: '102' }, { ino: '101' }] }), 'reorder')
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: [{ ino: '101' }, { ino: '102', exclude: true }] }), 'exclude one')
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'expanded after')
    })
    it('drops audio files left out of the payload', async function () {
      snap(this, await patch(items.book.id, 'admin', { orderedFileData: [{ ino: '102' }] }), 'only one listed')
    })
  })

  describe('POST /api/items/:id/scan', () => {
    const scan = (id, as) => req('POST', `/api/items/${id}/scan`, as, {})
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', `/api/items/${items.book.id}/scan`), 'anonymous')
      snap(this, await scan(items.book.id, 'user'), 'user')
      snap(this, await scan('nope', 'admin'), 'unknown id')
      snap(this, { status: 0, body: stubs.scan.callCount }, 'scanner not called')
    })
    it('scans (scanner stubbed) and names the result', async function () {
      snap(this, await scan(items.book.id, 'admin'), 'updated')
      stubs.scan.resolves(ScanResult.UPTODATE)
      snap(this, await scan(items.book.id, 'root'), 'up to date')
      stubs.scan.resolves(ScanResult.REMOVED)
      snap(this, await scan(items.podcast.id, 'root'), 'removed')
      stubs.scan.resolves(99)
      snap(this, await scan(items.book.id, 'root'), 'unknown result value')
      snap(this, { status: 0, body: stubs.scan.getCalls().map((c) => c.args) }, 'scanner calls')
    })
    it('refuses single file items with a 500', async function () {
      snap(this, await scan(items.single.id, 'admin'))
    })
  })

  describe('GET /api/items/:id/metadata-object', () => {
    const getObj = (id, as) => req('GET', `/api/items/${id}/metadata-object`, as)
    it('requires authentication and admin', async function () {
      snap(this, await api.request('GET', `/api/items/${items.book.id}/metadata-object`), 'anonymous')
      snap(this, await getObj(items.book.id, 'user'), 'user')
      snap(this, await getObj('nope', 'admin'), 'unknown id')
    })
    it('returns the ffmetadata object', async function () {
      snap(this, await getObj(items.book.id, 'admin'), 'book')
    })
    it('400s for invalid items', async function () {
      snap(this, await getObj(items.podcast.id, 'admin'), 'podcast')
      snap(this, await getObj(items.ebookOnly.id, 'admin'), 'no audio')
      await Database.libraryItemModel.update({ isMissing: true }, { where: { id: items.book.id } })
      snap(this, await getObj(items.book.id, 'admin'), 'missing')
    })
  })

  describe('POST /api/items/:id/chapters', () => {
    const post = (id, as, json) => req('POST', `/api/items/${id}/chapters`, as, json)
    const chapter = (title, start, end) => ({ title, start, end })
    it('requires authentication and update permission', async function () {
      snap(this, await api.request('POST', `/api/items/${items.book.id}/chapters`, { json: {} }), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await post(items.book.id, as, { chapters: [] }), as)
      snap(this, await post('nope', 'admin', { chapters: [] }), 'unknown id')
    })
    it('500s for items that cannot have chapters', async function () {
      snap(this, await post(items.podcast.id, 'admin', { chapters: [chapter('a', 0, 1)] }), 'podcast')
      snap(this, await post(items.ebookOnly.id, 'admin', { chapters: [chapter('a', 0, 1)] }), 'no audio')
      await Database.libraryItemModel.update({ isMissing: true }, { where: { id: items.book.id } })
      snap(this, await post(items.book.id, 'admin', { chapters: [chapter('a', 0, 1)] }), 'missing')
    })
    it('validates chapters', async function () {
      snap(this, await post(items.book.id, 'admin', {}), 'no chapters')
      snap(this, await post(items.book.id, 'admin', { chapters: 'x' }), 'not an array')
      snap(this, await post(items.book.id, 'admin', { chapters: [{ title: '', start: 0, end: 1 }] }), 'empty title')
      snap(this, await post(items.book.id, 'admin', { chapters: [{ title: 'a', start: '0', end: 1 }] }), 'string start')
      snap(this, await post(items.book.id, 'admin', { chapters: [{ title: 'a', start: 0 }] }), 'missing end')
      snap(this, await post(items.book.id, 'admin', { chapters: [{ title: 5, start: 0, end: 1 }] }), 'numeric title')
    })
    it('updates, replaces and detects unchanged chapters', async function () {
      snap(this, await post(items.book.id, 'admin', { chapters: [chapter('Chapter 1', 0, 60), chapter('Chapter 2', 60, 120)] }), 'unchanged')
      snap(this, await post(items.book.id, 'admin', { chapters: [chapter('Intro', 0, 30), chapter('Chapter 2', 30, 120)] }), 'edited in place')
      snap(this, await post(items.book.id, 'admin', { chapters: [chapter('One', 0, 40), chapter('Two', 40, 80), chapter('Three', 80, 120)] }), 'different count')
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'after', { metadataFile: readMetadataJson(items.book.id) })
      snap(this, await post(items.book.id, 'admin', { chapters: [] }), 'clear all')
    })
  })

  describe('GET /api/items/:id/ffprobe/:fileid', () => {
    const probe = (id, fileid, as) => req('GET', `/api/items/${id}/ffprobe/${fileid}`, as)
    it('requires authentication and admin', async function () {
      snap(this, await api.request('GET', `/api/items/${items.book.id}/ffprobe/101`), 'anonymous')
      snap(this, await probe(items.book.id, '101', 'user'), 'user')
      snap(this, await probe('nope', '101', 'admin'), 'unknown item')
    })
    it('404s for unknown files and non audio files', async function () {
      snap(this, await probe(items.book.id, '999', 'admin'), 'unknown file')
      snap(this, await probe(items.book.id, '301', 'admin'), 'image file')
      snap(this, await probe(items.book.id, '201', 'admin'), 'ebook file')
    })
    it('returns ffprobe data (ffprobe stubbed)', async function () {
      snap(this, await probe(items.book.id, '101', 'admin'), 'book audio file')
      snap(this, await probe(items.podcast.id, '902', 'root'), 'podcast episode file')
      snap(this, { status: 0, body: stubs.probe.getCalls().map((c) => c.args) }, 'probed paths')
    })
  })

  describe('GET /api/items/:id/file/:fileid', () => {
    it('requires authentication, a known item and file', async function () {
      snap(this, await raw(`/api/items/${items.book.id}/file/101`), 'anonymous')
      snap(this, await raw('/api/items/nope/file/101', { as: 'user' }), 'unknown item')
      snap(this, await raw(`/api/items/${items.book.id}/file/999`, { as: 'user' }), 'unknown file')
    })
    it('serves library files with mime types', async function () {
      snap(this, await raw(`/api/items/${items.book.id}/file/101`, { as: 'guest' }), 'mp3')
      snap(this, await raw(`/api/items/${items.single.id}/file/601`, { as: 'user' }), 'm4b')
      snap(this, await raw(`/api/items/${items.book.id}/file/301`, { as: 'user' }), 'png')
      snap(this, await raw(`/api/items/${items.book.id}/file/201`, { as: 'user' }), 'epub')
      snap(this, await raw(`/api/items/${items.podcast.id}/file/901`, { as: 'user' }), 'podcast episode')
    })
    it('checks access and honours X-Accel', async function () {
      snap(this, await raw(`/api/items/${items.explicit.id}/file/701`, { as: 'user' }), 'explicit content')
      global.XAccel = '/protected'
      snap(this, await raw(`/api/items/${items.book.id}/file/101`, { as: 'user' }), 'x-accel')
    })
    it('lets the file stream fail when it is gone from disk', async function () {
      fs.rmSync(path.join(items.paths.book, '01 one.mp3'))
      const r = await raw(`/api/items/${items.book.id}/file/101`, { as: 'user' })
      snap(this, { status: r.status, type: r.type }, 'missing file')
    })
  })

  describe('DELETE /api/items/:id/file/:fileid', () => {
    const del = (id, fileid, as) => req('DELETE', `/api/items/${id}/file/${fileid}`, as)
    it('requires authentication and delete permission', async function () {
      snap(this, await api.request('DELETE', `/api/items/${items.book.id}/file/301`), 'anonymous')
      for (const as of ['admin', 'user']) snap(this, await del(items.book.id, '301', as), `${as} has no delete permission`)
      snap(this, await del('nope', '301', 'root'), 'unknown item')
      snap(this, await del(items.book.id, '999', 'root'), 'unknown file')
    })
    it('deletes an image library file', async function () {
      snap(this, await del(items.book.id, '301', 'root'), 'delete', { files: exists(path.join(items.paths.book, 'cover.png')) })
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'after')
    })
    it('deletes an audio file and flags the item missing when nothing playable is left', async function () {
      snap(this, await del(items.book.id, '101', 'root'), 'one of two tracks')
      snap(this, await get(items.book.id, 'root'), 'book after')
      snap(this, await del(items.second.id, '401', 'root'), 'last track')
      snap(this, await get(items.second.id, 'root'), 'second after (missing)')
    })
    it('deletes the primary ebook and a supplementary ebook', async function () {
      snap(this, await del(items.book.id, '201', 'root'), 'primary ebook')
      snap(this, await del(items.book.id, '202', 'root'), 'supplementary ebook')
      snap(this, await get(items.book.id, 'root'), 'after')
    })
    it('deletes a podcast episode with its progress', async function () {
      await createProgress(users.user, { id: items.podcast.id, mediaId: items.episodes[0].id }, { mediaItemType: 'podcastEpisode', podcastId: items.podcast.mediaId })
      snap(this, await del(items.podcast.id, '901', 'root'), 'delete episode file', { state: await dbState() })
      snap(this, await get(items.podcast.id, 'root', '?expanded=1'), 'after')
    })
    it('still updates the item when the file is already gone from disk', async function () {
      fs.rmSync(path.join(items.paths.book, 'cover.png'))
      snap(this, await del(items.book.id, '301', 'root'))
    })
  })

  describe('GET /api/items/:id/file/:fileid/download', () => {
    const dl = (id, fileid, o = { as: 'user' }) => raw(`/api/items/${id}/file/${fileid}/download`, o)
    it('requires authentication, item, file', async function () {
      snap(this, await dl(items.book.id, '101', {}), 'anonymous')
      snap(this, await dl('nope', '101'), 'unknown item')
      snap(this, await dl(items.book.id, '999'), 'unknown file')
    })
    it('requires download permission', async function () {
      await setPerms('user', { download: false })
      snap(this, await dl(items.book.id, '101'), 'no download permission')
    })
    it('downloads with content-disposition', async function () {
      snap(this, await dl(items.book.id, '101'), 'mp3')
      snap(this, await dl(items.single.id, '601'), 'm4b desktop')
      snap(this, await dl(items.single.id, '601', { as: 'user', headers: { 'user-agent': IPHONE } }), 'm4b on iphone gets audio/m4b')
      snap(this, await dl(items.book.id, '301'), 'png')
    })
    it('honours X-Accel and reports missing files', async function () {
      global.XAccel = '/protected'
      snap(this, await dl(items.book.id, '101'), 'x-accel')
      global.XAccel = ''
      fs.rmSync(path.join(items.paths.book, '02 two.mp3'))
      snap(this, await dl(items.book.id, '102'), 'file gone from disk')
    })
  })

  describe('GET /api/items/:id/ebook/:fileid?', () => {
    const ebook = (id, fileid = '', as = 'user') => raw(`/api/items/${id}/ebook/${fileid}`, { as })
    it('requires authentication, 404s for unknown item/file', async function () {
      snap(this, await raw(`/api/items/${items.book.id}/ebook`), 'anonymous')
      snap(this, await ebook('nope'), 'unknown item')
      snap(this, await ebook(items.book.id, '999'), 'unknown file id')
    })
    it('serves the primary ebook, or a chosen ebook file', async function () {
      snap(this, await ebook(items.book.id), 'primary')
      snap(this, await ebook(items.book.id, '201'), 'by id (epub)')
      snap(this, await ebook(items.book.id, '202'), 'supplementary pdf')
    })
    it('validates the file id and primary presence', async function () {
      snap(this, await ebook(items.book.id, '101'), 'audio file id')
      snap(this, await ebook(items.second.id), 'no ebook')
      snap(this, await ebook(items.podcast.id), 'podcast')
    })
    it('honours X-Accel and reports files gone from disk', async function () {
      global.XAccel = '/protected'
      snap(this, await ebook(items.book.id), 'x-accel')
      global.XAccel = ''
      fs.rmSync(path.join(items.paths.book, 'book.epub'))
      snap(this, await ebook(items.book.id), 'gone from disk')
    })
  })

  describe('PATCH /api/items/:id/ebook/:fileid/status', () => {
    const toggle = (id, fileid, as) => req('PATCH', `/api/items/${id}/ebook/${fileid}/status`, as)
    it('requires authentication and update permission', async function () {
      snap(this, await api.request('PATCH', `/api/items/${items.book.id}/ebook/202/status`), 'anonymous')
      snap(this, await toggle(items.book.id, '202', 'user'), 'user')
      snap(this, await toggle('nope', '202', 'admin'), 'unknown item')
      snap(this, await toggle(items.book.id, '999', 'admin'), 'unknown file')
    })
    it('validates the item and file', async function () {
      snap(this, await toggle(items.podcast.id, '901', 'admin'), 'podcast')
      snap(this, await toggle(items.book.id, '101', 'admin'), 'audio file')
      snap(this, await toggle(items.book.id, '301', 'admin'), 'image file')
    })
    it('makes a supplementary ebook the primary one and back', async function () {
      snap(this, await toggle(items.book.id, '202', 'admin'), 'pdf becomes primary')
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'after promote')
      snap(this, await toggle(items.book.id, '202', 'admin'), 'pdf back to supplementary')
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'after demote')
    })
    it('flags an ebook-only item missing when its primary ebook is demoted', async function () {
      snap(this, await toggle(items.ebookOnly.id, '501', 'admin'), 'demote only primary')
      snap(this, await get(items.ebookOnly.id, 'root'), 'after (missing)')
      snap(this, await toggle(items.ebookOnly.id, '502', 'admin'), 'promote pdf')
      snap(this, await get(items.ebookOnly.id, 'root'), 'after promote (present again)')
    })
  })

  // ---- batch routes ---------------------------------------------------------------------------------------------------------
  describe('POST /api/items/batch/delete', () => {
    const del = (as, json, query = '') => req('POST', `/api/items/batch/delete${query}`, as, json)
    it('requires authentication and delete permission', async function () {
      snap(this, await api.request('POST', '/api/items/batch/delete', { json: { libraryItemIds: [items.book.id] } }), 'anonymous')
      for (const as of ['admin', 'user']) snap(this, await del(as, { libraryItemIds: [items.book.id] }), `${as} has no delete permission`)
    })
    it('validates the body', async function () {
      snap(this, await del('root', {}), 'no ids')
      snap(this, await del('root', { libraryItemIds: [] }), 'empty')
      snap(this, await del('root', { libraryItemIds: 'abc' }), 'not an array')
      snap(this, await del('root', { libraryItemIds: ['nope'] }), 'only unknown ids')
      snap(this, await get(items.book.id), 'nothing was deleted', { state: await dbState() })
    })
    it('checks access to every item before deleting any', async function () {
      await setPerms('user', { delete: true, accessAllLibraries: false, librariesAccessible: [libs.books.library.id] })
      snap(this, await del('user', { libraryItemIds: [items.book.id, items.foreign.id] }), 'one inaccessible', { state: await dbState() })
    })
    it('soft deletes several items, ignoring unknown ids', async function () {
      await createProgress(users.user, items.second)
      snapSorted(this, await del('root', { libraryItemIds: [items.book.id, items.second.id, 'nope'] }), 'delete', { state: await dbState(), files: exists(items.paths.book, items.paths.second) })
    })
    it('hard deletes files', async function () {
      snapSorted(this, await del('root', { libraryItemIds: [items.second.id, items.podcast.id, items.single.id] }, '?hard=1'), 'hard delete', { state: await dbState(), files: exists(items.paths.second, items.paths.podcast, items.single.path) })
    })
  })

  describe('POST /api/items/batch/update', () => {
    const update = (as, json) => req('POST', '/api/items/batch/update', as, json)
    it('requires authentication and update permission', async function () {
      snap(this, await api.request('POST', '/api/items/batch/update', { json: [] }), 'anonymous')
      snap(this, await update('user', [{ id: items.book.id, mediaPayload: {} }]), 'user')
    })
    it('validates the payload', async function () {
      snap(this, await update('admin', {}), 'not an array')
      snap(this, await update('admin', []), 'empty')
      snap(this, await update('admin', [{ mediaPayload: {} }]), 'missing id')
      snap(this, await update('admin', [{ id: items.book.id, mediaPayload: {} }, { id: items.book.id, mediaPayload: {} }]), 'duplicate id')
      snap(this, await update('admin', [{ id: items.book.id, mediaPayload: {} }, { id: 'nope', mediaPayload: {} }]), 'unknown id')
    })
    it('checks access to every item', async function () {
      await setPerms('admin', { accessAllLibraries: false, librariesAccessible: [libs.books.library.id] })
      snap(this, await update('admin', [{ id: items.book.id, mediaPayload: { metadata: { title: 'X' } } }, { id: items.foreign.id, mediaPayload: { metadata: { title: 'Y' } } }]), 'one inaccessible')
    })
    it('updates several items and counts only the changed ones', async function () {
      snap(
        this,
        await update('admin', [
          { id: items.book.id, mediaPayload: { metadata: { title: 'Batch Title', authors: [{ name: 'Bob Writer' }], series: [{ name: 'Batch Saga', sequence: '3' }] }, tags: ['x'] } },
          { id: items.second.id, mediaPayload: { metadata: { title: 'Second Book' } } },
          { id: items.podcast.id, mediaPayload: { metadata: { author: 'Batch Author' } } }
        ]),
        'update'
      )
      snap(this, await get(items.book.id, 'root', '?expanded=1'), 'book after', { state: await dbState(), metadataFile: readMetadataJson(items.book.id) })
      snap(this, await get(items.podcast.id, 'root', '?expanded=1'), 'podcast after')
    })
    it('skips podcasts with an invalid cron expression but still succeeds', async function () {
      snap(this, await update('admin', [{ id: items.podcast.id, mediaPayload: { autoDownloadSchedule: 'bad cron' } }]), 'invalid cron')
    })
  })

  describe('POST /api/items/batch/get', () => {
    const batchGet = (as, json) => req('POST', '/api/items/batch/get', as, json)
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/items/batch/get', { json: { libraryItemIds: [items.book.id] } }))
    })
    it('answers 403 for a missing id list (recorded)', async function () {
      snap(this, await batchGet('user', {}), 'no ids')
      snap(this, await batchGet('user', { libraryItemIds: [] }), 'empty')
    })
    it('returns the expanded items that exist', async function () {
      const res = await batchGet('guest', { libraryItemIds: [items.book.id, items.podcast.id, 'nope'] })
      res.body.libraryItems = byLabel(this, res.body.libraryItems, (li) => li.id) // returned in database order
      snap(this, res, 'with an unknown id')
      snap(this, await batchGet('user', { libraryItemIds: ['nope'] }), 'only unknown ids')
    })
    it('checks access to every item', async function () {
      snap(this, await batchGet('user', { libraryItemIds: [items.book.id, items.explicit.id] }), 'explicit item blocks the batch')
      await setPerms('user', { accessAllLibraries: false, librariesAccessible: [libs.other.library.id] })
      snap(this, await batchGet('user', { libraryItemIds: [items.foreign.id] }), 'accessible')
      snap(this, await batchGet('user', { libraryItemIds: [items.foreign.id, items.book.id] }), 'one inaccessible')
    })
  })

  describe('POST /api/items/batch/quickmatch', () => {
    const qm = (as, json) => req('POST', '/api/items/batch/quickmatch', as, json)
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', '/api/items/batch/quickmatch', { json: {} }), 'anonymous')
      snap(this, await qm('user', { libraryItemIds: [items.book.id] }), 'user')
    })
    it('validates the body (bare 400s)', async function () {
      snap(this, await qm('admin', {}), 'no ids')
      snap(this, await qm('admin', { libraryItemIds: [] }), 'empty')
      snap(this, await qm('admin', { libraryItemIds: ['nope'] }), 'only unknown ids')
    })
    it('responds first, then matches each item (scanner stubbed) and notifies the user by socket', async function () {
      stubs.quickMatch.callsFake(async (_router, li) => (li.id === items.book.id ? { updated: true } : { warning: 'No results found' }))
      const res = await qm('admin', { libraryItemIds: [items.book.id, items.second.id, 'nope'], options: { provider: 'audible', overrideCover: 1, overrideDetails: 0, ignored: true } })
      await waitFor(() => api.emitted.some((e) => e.method === 'clientEmitter'))
      const calls = byLabel(this, stubs.quickMatch.getCalls().map((c) => ({ item: c.args[1].id, options: c.args[2] })), (c) => c.item)
      snap(this, res, 'two items', { calls })
    })
    it('reports success false when nothing was updated', async function () {
      stubs.quickMatch.resolves({ nothing: true })
      const res = await qm('root', { libraryItemIds: [items.book.id], options: { provider: 7 } })
      await waitFor(() => api.emitted.some((e) => e.method === 'clientEmitter'))
      snap(this, res, 'no updates', { calls: stubs.quickMatch.getCalls().map((c) => c.args[2]) })
    })
  })

  describe('POST /api/items/batch/scan', () => {
    const scan = (as, json) => req('POST', '/api/items/batch/scan', as, json)
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', '/api/items/batch/scan', { json: {} }), 'anonymous')
      snap(this, await scan('user', { libraryItemIds: [items.book.id] }), 'user')
    })
    it('validates the body (bare 400s)', async function () {
      snap(this, await scan('admin', {}), 'no ids')
      snap(this, await scan('admin', { libraryItemIds: [] }), 'empty')
      snap(this, await scan('admin', { libraryItemIds: ['nope'] }), 'only unknown ids')
    })
    it('responds first, then scans folder items only (scanner stubbed)', async function () {
      const reset = sinon.spy(Database, 'resetLibraryIssuesFilterData')
      const res = await scan('admin', { libraryItemIds: [items.book.id, items.single.id, items.second.id, 'nope'] })
      await waitFor(() => reset.called)
      await reset.returnValues[0]
      snap(this, res, 'scan', { scanned: byLabel(this, stubs.scan.getCalls().map((c) => c.args[0]), (id) => id), resetFor: reset.getCalls().map((c) => c.args[0]) })
    })
  })
})
