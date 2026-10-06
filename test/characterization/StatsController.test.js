const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary, createBook } = require('./helpers/seed-library')
const { audioBookExtra, createPlaybackSession, setRow } = require('./helpers/seed-users-extra')
const Database = require('../../server/Database')

describe('StatsController (characterization)', () => {
  let api, users

  beforeEach(async () => {
    api = await startApi()
    users = await api.seed.users()
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label) => matchSnapshot(ctx, { res }, { label, ids: ctx.ids })

  // two books added in 2024 (with sizes, durations, narrators, genres), one added in 2023, plus listening sessions in 2024
  async function seedData() {
    const lf = await createLibrary({ name: 'Books' })
    const a = await createBook(lf, { title: 'Book A', authors: ['Ann Author'], extra: audioBookExtra({ duration: 1000, narrators: ['Nora'], genres: ['Fantasy'] }) })
    const b = await createBook(lf, { title: 'Book B', authors: ['Bob Writer'], extra: audioBookExtra({ duration: 2000, narrators: ['Nick'], genres: ['Mystery'] }) })
    const c = await createBook(lf, { title: 'Book C', authors: ['Cy Old'], extra: audioBookExtra({ duration: 500 }) })
    const d = { at: '2024-03-15T12:00:00Z' }
    for (const [x, size] of [
      [a, 1000],
      [b, 5000]
    ]) {
      await setRow(Database.libraryItemModel, x.libraryItem.id, { size, createdAt: new Date(d.at) })
      await setRow(Database.bookModel, x.book.id, { createdAt: new Date(d.at) })
    }
    await setRow(Database.libraryItemModel, c.libraryItem.id, { size: 300, createdAt: new Date('2023-06-15T12:00:00Z') })
    await setRow(Database.bookModel, c.book.id, { createdAt: new Date('2023-06-15T12:00:00Z') })
    await setRow(Database.authorModel, (await Database.authorModel.findOne({ where: { name: 'Ann Author' } })).id, { createdAt: new Date(d.at) })
    const ctx = (x) => ({ user: users.user, library: lf.library, ...x })
    await createPlaybackSession(ctx(a), { at: '2024-03-15T12:00:00Z', timeListening: 600, authors: ['Ann Author'], narrators: ['Nora'], genres: ['Fantasy', 'Audiobook'] })
    await createPlaybackSession(ctx(a), { at: '2024-03-16T12:00:00Z', timeListening: 300, authors: ['Ann Author'], narrators: ['Nora'], genres: ['Fantasy'] })
    await createPlaybackSession(ctx(b), { at: '2024-05-10T12:00:00Z', timeListening: 800, authors: ['Bob Writer'], narrators: ['Nick'], genres: ['Mystery'] })
    await createPlaybackSession(ctx(c), { at: '2023-06-15T12:00:00Z', timeListening: 111, authors: ['Cy Old'] })
  }

  describe('GET /api/stats/server', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/stats/server'))
    })
    it('is admin only', async function () {
      for (const as of ['user', 'guest']) snap(this, await api.request('GET', '/api/stats/server', { as }), as)
    })
    it('returns zero totals for an empty server', async function () {
      snap(this, await api.request('GET', '/api/stats/server', { as: 'root' }))
    })
    it('returns sizes and counts for books and podcasts', async function () {
      await seedData()
      const pl = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: '/test/pods' })
      const podcast = await Database.podcastModel.create({ title: 'Pod', tags: [], genres: [] })
      const li = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: pl.library.id, libraryFolderId: pl.folder.id, path: '/test/pods/Pod', relPath: 'Pod', size: 700 })
      await Database.podcastEpisodeModel.create({ podcastId: podcast.id, title: 'Ep 1', index: 1, audioFile: { index: 1, metadata: { filename: 'e.mp3' }, duration: 10 } })
      await Database.podcastEpisodeModel.create({ podcastId: podcast.id, title: 'Ep 2', index: 2, audioFile: { index: 1, metadata: { filename: 'e2.mp3' }, duration: 10 } })
      for (const as of ['admin', 'root']) snap(this, await api.request('GET', '/api/stats/server', { as }), as)
      void li
    })
  })

  describe('GET /api/stats/year/:year', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/stats/year/2024'))
    })
    it('is admin only', async function () {
      for (const as of ['user', 'guest']) snap(this, await api.request('GET', '/api/stats/year/2024', { as }), as)
    })
    it('rejects invalid years', async function () {
      for (const year of ['abc', '1999', '10000', '2024.5x']) snap(this, await api.request('GET', `/api/stats/year/${year}`, { as: 'admin' }), year)
    })
    it('returns zeros for a year without data', async function () {
      snap(this, await api.request('GET', '/api/stats/year/2020', { as: 'admin' }))
    })
    it('aggregates books and listening for 2024 and 2023', async function () {
      this.ids = new Map()
      await seedData()
      snap(this, await api.request('GET', '/api/stats/year/2024', { as: 'admin' }), '2024 as admin')
      snap(this, await api.request('GET', '/api/stats/year/2024', { as: 'root' }), '2024 as root')
      snap(this, await api.request('GET', '/api/stats/year/2023', { as: 'root' }), '2023')
    })
  })
})
