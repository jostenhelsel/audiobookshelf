const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createFilePodcast } = require('./helpers/seed-items-extra')
const { libraryFolderPath, visibleFileBook } = require('./helpers/seed-delivery-extra')
const Database = require('../../server/Database')

// The real RssFeedManager runs against the in-memory DB (open/close/list never touch the network; the files it reads
// are the real small files seeded inside api.tmp). Feed ids are random UUIDs, so they are normalized; slugs and the server
// address are supplied by the tests and therefore stable.
describe('RSSFeedController (characterization)', () => {
  let api, users, lf, podLf, itemA, itemB, noAudio, pod, collection, series, emptySeries, emptyCollection

  beforeEach(async () => {
    api = await startApi()
    users = await api.seed.users()
    lf = await createLibrary({ name: 'Books', path: libraryFolderPath(api) })
    podLf = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: libraryFolderPath(api, 'pods') })
    itemA = await visibleFileBook(lf, { title: 'Book A', n: 1, authors: ['Ann Author'], series: [{ name: 'Saga', sequence: '1' }], cover: 'cover.png', images: [{ filename: 'cover.png', ino: '190' }] })
    itemB = await visibleFileBook(lf, { title: 'Book B', n: 2, authors: ['Bob Writer'], series: [{ name: 'Saga', sequence: '2' }] })
    noAudio = await visibleFileBook(lf, { title: 'No Audio', n: 3, audio: false, series: [{ name: 'Silent', sequence: '1' }] })
    pod = await createFilePodcast(podLf, { title: 'Pod', author: 'Pat', episodes: [{ title: 'Ep 1', filename: 'ep1.mp3', ino: '501' }, { title: 'Ep 2', filename: 'ep2.mp3', ino: '502' }] })
    await Database.podcastModel.update({ explicit: false }, { where: { id: pod.podcast.id } })
    const created = await api.request('POST', '/api/collections', { as: 'admin', json: { libraryId: lf.library.id, name: 'Favourites', description: 'my picks', books: [itemA.libraryItem.id, itemB.libraryItem.id] } })
    collection = created.body
    emptyCollection = (await api.request('POST', '/api/collections', { as: 'admin', json: { libraryId: lf.library.id, name: 'Quiet', books: [noAudio.libraryItem.id] } })).body
    series = await Database.seriesModel.findOne({ where: { name: 'Saga' } })
    emptySeries = await Database.seriesModel.findOne({ where: { name: 'Silent' } })
    api.emitted.splice(0)
  })

  afterEach(async () => {
    await api.stop()
  })

  // episode pubDate strings of book feeds are derived from the current time (now + track index), so they are masked
  // The order of a feed's episodes (feedEpisodes are loaded without ORDER BY) is not stable, so they are sorted by file path.
  const maskPubDates = (v) =>
    JSON.parse(JSON.stringify(v), (k, val) => {
      if (k === 'pubDate' && typeof val === 'string') return '<pubDate>'
      if (k === 'episodes' && Array.isArray(val)) return [...val].sort((a, b) => (a.fullPath < b.fullPath ? -1 : 1))
      return val
    })
  const snap = (ctx, res, label, extra = {}) => {
    res = maskPubDates(res)
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const ADDRESS = 'https://abs.example.test'
  const body = (slug, over = {}) => ({ serverAddress: ADDRESS, slug, ...over })
  const open = (as, kind, id, json) => api.request('POST', `/api/feeds/${kind}/${id}/open`, { as, json })
  const feedRows = async () => (await Database.feedModel.findAll({ order: [['slug', 'ASC']] })).map((f) => ({ slug: f.slug, entityType: f.entityType, entityId: f.entityId, feedURL: f.feedURL, title: f.title, preventIndexing: f.preventIndexing }))

  describe('GET /api/feeds', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('GET', '/api/feeds'), 'no auth')
      snap(this, await api.request('GET', '/api/feeds', { as: 'user' }), 'user')
      snap(this, await api.request('GET', '/api/feeds', { as: 'guest' }), 'guest')
    })
    it('lists no feeds, then all open feeds with episodes', async function () {
      this.ids = new Map([[itemA.libraryItem.id, '<item-a>'], [pod.libraryItem.id, '<pod>'], [collection.id, '<collection>']])
      snap(this, await api.request('GET', '/api/feeds', { as: 'admin' }), 'empty')
      await open('admin', 'item', itemA.libraryItem.id, body('feed-a', { metadataDetails: { preventIndexing: false, ownerName: 'Ann', ownerEmail: 'ann@example.test' } }))
      await open('root', 'item', pod.libraryItem.id, body('feed-pod'))
      await open('admin', 'collection', collection.id, body('feed-collection'))
      await open('admin', 'series', series.id, body('feed-series'))
      api.emitted.splice(0)
      snap(this, await api.request('GET', '/api/feeds', { as: 'admin' }), 'admin list')
      snap(this, await api.request('GET', '/api/feeds', { as: 'root' }), 'root list')
    })
  })

  describe('POST /api/feeds/item/:itemId/open', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', `/api/feeds/item/${itemA.libraryItem.id}/open`, { json: body('x') }), 'no auth')
      snap(this, await open('user', 'item', itemA.libraryItem.id, body('x')), 'user')
      snap(this, await open('guest', 'item', itemA.libraryItem.id, body('x')), 'guest')
      matchSnapshot(this, await feedRows(), { label: 'no feeds created' })
    })
    it('validates item and body', async function () {
      this.ids = new Map([[itemA.libraryItem.id, '<item-a>']])
      snap(this, await open('admin', 'item', 'unknown-id', body('x')), 'unknown item')
      snap(this, await open('admin', 'item', itemA.libraryItem.id, {}), 'no body fields')
      snap(this, await open('admin', 'item', itemA.libraryItem.id, { serverAddress: ADDRESS }), 'no slug')
      snap(this, await open('admin', 'item', itemA.libraryItem.id, { slug: 'x' }), 'no server address')
      snap(this, await open('admin', 'item', itemA.libraryItem.id, { serverAddress: 5, slug: 'x' }), 'non-string address')
      snap(this, await open('admin', 'item', noAudio.libraryItem.id, body('x')), 'item without audio tracks')
      matchSnapshot(this, await feedRows(), { label: 'no feeds created' })
    })
    it('opens a book feed, emits rss_feed_open and rejects a duplicate slug', async function () {
      this.ids = new Map([[itemA.libraryItem.id, '<item-a>'], [itemB.libraryItem.id, '<item-b>']])
      snap(this, await open('admin', 'item', itemA.libraryItem.id, body('feed-a')), 'defaults')
      snap(this, await open('admin', 'item', itemA.libraryItem.id, body('feed-a')), 'duplicate slug same item')
      snap(this, await open('root', 'item', itemB.libraryItem.id, body('feed-a')), 'duplicate slug other item')
      snap(this, await open('root', 'item', itemB.libraryItem.id, body('feed-b', { metadataDetails: { preventIndexing: false, ownerName: 'Bob', ownerEmail: 'bob@example.test' } })), 'with metadata details')
      snap(this, await open('root', 'item', itemB.libraryItem.id, body('feed-b2', { metadataDetails: { preventIndexing: 'yes', ownerName: 5, ownerEmail: '' } })), 'odd metadata details')
      matchSnapshot(this, await feedRows(), { label: 'feed rows', ids: this.ids })
    })
    it('opens a podcast feed', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      snap(this, await open('admin', 'item', pod.libraryItem.id, body('feed-pod')), 'podcast')
    })
    it('closes a feed it opened and 404s afterwards', async function () {
      this.ids = new Map()
      const { body: opened } = await open('admin', 'item', itemA.libraryItem.id, body('feed-a'))
      api.emitted.splice(0)
      snap(this, await api.request('POST', `/api/feeds/${opened.feed.id}/close`, { as: 'admin' }), 'close')
      snap(this, await api.request('POST', `/api/feeds/${opened.feed.id}/close`, { as: 'admin' }), 'close again')
      snap(this, await open('admin', 'item', itemA.libraryItem.id, body('feed-a')), 'slug reusable after close')
    })
  })

  describe('POST /api/feeds/collection/:collectionId/open', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', `/api/feeds/collection/${collection.id}/open`, { json: body('x') }), 'no auth')
      snap(this, await open('user', 'collection', collection.id, body('x')), 'user')
      snap(this, await open('guest', 'collection', collection.id, body('x')), 'guest')
    })
    it('validates body, collection and tracks', async function () {
      this.ids = new Map([[collection.id, '<collection>']])
      snap(this, await open('admin', 'collection', collection.id, {}), 'no body fields')
      snap(this, await open('admin', 'collection', 'unknown-id', body('x')), 'unknown collection')
      snap(this, await open('admin', 'collection', emptyCollection.id, body('x')), 'collection without audio tracks')
      snap(this, await open('admin', 'collection', 'unknown-id', {}), 'unknown collection and invalid body (body checked first)')
      matchSnapshot(this, await feedRows(), { label: 'no feeds created' })
    })
    it('opens a collection feed and rejects a duplicate slug', async function () {
      this.ids = new Map([[collection.id, '<collection>'], [itemA.libraryItem.id, '<item-a>'], [itemB.libraryItem.id, '<item-b>']])
      snap(this, await open('admin', 'collection', collection.id, body('feed-collection', { metadataDetails: { preventIndexing: false } })), 'open')
      snap(this, await open('admin', 'collection', collection.id, body('feed-collection')), 'duplicate slug')
      matchSnapshot(this, await feedRows(), { label: 'feed rows', ids: this.ids })
    })
  })

  describe('POST /api/feeds/series/:seriesId/open', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', `/api/feeds/series/${series.id}/open`, { json: body('x') }), 'no auth')
      snap(this, await open('user', 'series', series.id, body('x')), 'user')
      snap(this, await open('guest', 'series', series.id, body('x')), 'guest')
    })
    it('validates body, series and tracks', async function () {
      this.ids = new Map([[series.id, '<series>']])
      snap(this, await open('admin', 'series', series.id, {}), 'no body fields')
      snap(this, await open('admin', 'series', 'unknown-id', body('x')), 'unknown series')
      snap(this, await open('admin', 'series', emptySeries.id, body('x')), 'series without audio tracks')
      matchSnapshot(this, await feedRows(), { label: 'no feeds created' })
    })
    it('opens a series feed and rejects a duplicate slug', async function () {
      this.ids = new Map([[series.id, '<series>'], [itemA.libraryItem.id, '<item-a>'], [itemB.libraryItem.id, '<item-b>']])
      snap(this, await open('admin', 'series', series.id, body('feed-series', { metadataDetails: { ownerName: 'Series Owner' } })), 'open')
      snap(this, await open('admin', 'series', series.id, body('feed-series')), 'duplicate slug')
      matchSnapshot(this, await feedRows(), { label: 'feed rows', ids: this.ids })
    })
  })

  describe('POST /api/feeds/:id/close', () => {
    it('requires authentication and admin', async function () {
      const { body: opened } = await open('admin', 'item', itemA.libraryItem.id, body('feed-a'))
      this.ids = new Map()
      snap(this, await api.request('POST', `/api/feeds/${opened.feed.id}/close`), 'no auth')
      snap(this, await api.request('POST', `/api/feeds/${opened.feed.id}/close`, { as: 'user' }), 'user')
      snap(this, await api.request('POST', `/api/feeds/${opened.feed.id}/close`, { as: 'guest' }), 'guest')
      matchSnapshot(this, await feedRows(), { label: 'feed still open', ids: this.ids })
    })
    it('404s for an unknown feed', async function () {
      snap(this, await api.request('POST', '/api/feeds/unknown-id/close', { as: 'admin' }))
    })
    it('closes collection and series feeds as root and removes episodes', async function () {
      this.ids = new Map()
      const c = (await open('admin', 'collection', collection.id, body('feed-collection'))).body
      const s = (await open('admin', 'series', series.id, body('feed-series'))).body
      api.emitted.splice(0)
      snap(this, await api.request('POST', `/api/feeds/${c.feed.id}/close`, { as: 'root' }), 'close collection feed')
      snap(this, await api.request('POST', `/api/feeds/${s.feed.id}/close`, { as: 'admin' }), 'close series feed')
      snap(this, await api.request('GET', '/api/feeds', { as: 'admin' }), 'list after close')
      matchSnapshot(this, { feedEpisodes: await Database.feedEpisodeModel.count() }, { label: 'episode rows left' })
    })
  })
})
