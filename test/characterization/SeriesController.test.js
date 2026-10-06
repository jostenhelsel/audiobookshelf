const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createVisibleBook: createBook, createUser, setProgress } = require('./helpers/seed-library-extra')
const Database = require('../../server/Database')

// Both routes of SeriesController (GET is deprecated in favour of /api/libraries/:id/series/:seriesId but still routed).
describe('SeriesController (characterization)', () => {
  let api, lf, other, users, saga, solo, otherSeries, books, hiddenBook

  beforeEach(async () => {
    api = await startApi()
    users = await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    other = await createLibrary({ name: 'Other', path: '/test/other' })
    books = []
    for (const [title, seq] of [['Saga 1', '1'], ['Saga 2', '2'], ['Saga 10', '10']]) books.push(await createBook(lf, { title, series: [{ name: 'Saga', sequence: seq }] }))
    solo = (await createBook(lf, { title: 'Standalone', series: [{ name: 'Solo Series', sequence: '1' }] })).book
    // a series whose only book is explicit (hidden from users that block explicit content)
    hiddenBook = await createBook(lf, { title: 'Spicy', series: [{ name: 'Spicy Series', sequence: '1' }], extra: { explicit: true } })
    await createBook(other, { title: 'Elsewhere', series: [{ name: 'Elsewhere Series' }] })
    saga = await Database.seriesModel.findOne({ where: { name: 'Saga' } })
    otherSeries = await Database.seriesModel.findOne({ where: { name: 'Elsewhere Series' } })
    await Database.seriesModel.update({ description: 'An epic' }, { where: { id: saga.id } })
    await setProgress(users.user, books[0].book.id, { isFinished: true })
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids })
  }
  const names = () => new Map([[saga.id, '<saga>'], [otherSeries.id, '<other-series>']])
  const seriesRow = async (id) => {
    const s = await Database.seriesModel.findByPk(id)
    return s && { id: s.id, name: s.name, nameIgnorePrefix: s.nameIgnorePrefix, description: s.description }
  }

  describe('GET /api/series/:id', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', `/api/series/${saga.id}`))
    })
    it('returns a series for every user type', async function () {
      this.ids = names()
      for (const as of ['root', 'admin', 'user', 'guest']) snap(this, await api.request('GET', `/api/series/${saga.id}`, { as }), as)
    })
    it('includes progress and rssfeed', async function () {
      this.ids = names()
      snap(this, await api.request('GET', `/api/series/${saga.id}?include=progress`, { as: 'user' }), 'progress for user with a finished book')
      snap(this, await api.request('GET', `/api/series/${saga.id}?include=progress`, { as: 'admin' }), 'progress for admin without progress')
      snap(this, await api.request('GET', `/api/series/${saga.id}?include=rssfeed`, { as: 'admin' }), 'rssfeed (none open)')
      snap(this, await api.request('GET', `/api/series/${saga.id}?include=progress, rssfeed,unknown`, { as: 'user' }), 'multiple includes with spaces')
    })
    it('returns open rss feed details', async function () {
      this.ids = names()
      await Database.feedModel.create({ slug: 'saga-feed', entityType: 'series', entityId: saga.id, entityUpdatedAt: new Date(0), serverAddress: 'http://localhost', feedURL: 'http://localhost/feed/saga-feed', coverPath: null, preventIndexing: true, ownerName: null, ownerEmail: null, userId: users.admin.id, title: 'Saga', description: 'd', author: 'a', language: 'en' })
      snap(this, await api.request('GET', `/api/series/${saga.id}?include=rssfeed`, { as: 'admin' }), 'rssfeed open')
    })
    it('404s for unknown ids, empty series and inaccessible books', async function () {
      this.ids = names()
      snap(this, await api.request('GET', '/api/series/not-a-real-id', { as: 'admin' }), 'unknown id')
      const emptySeries = await Database.seriesModel.create({ name: 'Empty', libraryId: lf.library.id })
      snap(this, await api.request('GET', `/api/series/${emptySeries.id}`, { as: 'admin' }), 'series without books')
      await createUser('limited', 'user', (p) => {
        p.accessAllLibraries = false
        p.librariesAccessible = [other.library.id]
      })
      await createUser('spicy', 'user', (p) => {
        p.accessExplicitContent = true
      })
      snap(this, await api.request('GET', `/api/series/${saga.id}`, { as: 'limited' }), 'library not accessible')
      snap(this, await api.request('GET', `/api/series/${otherSeries.id}`, { as: 'limited' }), 'accessible library')
      const spicy = await Database.seriesModel.findOne({ where: { name: 'Spicy Series' } })
      snap(this, await api.request('GET', `/api/series/${spicy.id}`, { as: 'user' }), 'explicit-only series hidden from user without explicit access')
      snap(this, await api.request('GET', `/api/series/${spicy.id}`, { as: 'spicy' }), 'explicit-only series visible with explicit access')
    })
  })

  describe('PATCH /api/series/:id', () => {
    it('requires authentication and update permission', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { json: { name: 'x' } }), 'anonymous')
      for (const as of ['user', 'guest']) snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as, json: { name: 'Hacked' } }), as)
      snap(this, { row: await seriesRow(saga.id) }, 'row unchanged')
    })
    it('rejects invalid payloads', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as: 'admin', json: {} }), 'empty')
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as: 'admin', json: { name: 5, description: null, other: 'x' } }), 'wrong types')
      snap(this, await api.request('PATCH', `/api/series/nope`, { as: 'admin', json: { name: 'x' } }), 'unknown id')
    })
    it('updates name and description', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as: 'admin', json: { name: 'The Saga', description: 'Updated' } }), 'admin full update')
      snap(this, { row: await seriesRow(saga.id) }, 'row after full update')
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as: 'root', json: { description: 'Root edit' } }), 'root partial update')
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as: 'root', json: { description: 'Root edit' } }), 'no change emits nothing')
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as: 'root', json: { name: '' } }), 'empty name accepted')
      snap(this, await api.request('PATCH', `/api/series/${saga.id}`, { as: 'root', json: { name: 'Saga' } }), 'duplicate names are not checked')
      snap(this, await api.request('GET', `/api/series/${saga.id}`, { as: 'admin' }), 'find after update')
    })
  })
})
