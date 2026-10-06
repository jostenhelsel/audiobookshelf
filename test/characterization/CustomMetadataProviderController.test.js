const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createProvider, fixedId } = require('./helpers/seed-misc-extra')
const Database = require('../../server/Database')

describe('CustomMetadataProviderController (characterization)', () => {
  let api

  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids })
  }
  const create = (as, json) => api.request('POST', '/api/custom-metadata-providers', { as, json })

  describe('GET /api/custom-metadata-providers', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('GET', '/api/custom-metadata-providers'), 'anonymous')
      snap(this, await api.request('GET', '/api/custom-metadata-providers', { as: 'user' }), 'user')
      snap(this, await api.request('GET', '/api/custom-metadata-providers', { as: 'guest' }), 'guest')
    })
    it('lists providers (raw rows incl. authHeaderValue)', async function () {
      this.ids = new Map()
      snap(this, await api.request('GET', '/api/custom-metadata-providers', { as: 'admin' }), 'empty')
      await createProvider({ n: 1, name: 'Books One', authHeaderValue: 'Bearer secret' })
      await createProvider({ n: 2, name: 'Pods', mediaType: 'podcast' })
      const res = await api.request('GET', '/api/custom-metadata-providers', { as: 'admin' })
      res.body.providers.sort((a, b) => (a.id < b.id ? -1 : 1))
      snap(this, res, 'two providers (admin)')
      snap(this, await api.request('GET', '/api/custom-metadata-providers', { as: 'root' }), 'root')
    })
  })

  describe('POST /api/custom-metadata-providers', () => {
    it('requires authentication and admin', async function () {
      snap(this, await create(undefined, { name: 'x', url: 'https://a.b', mediaType: 'book' }), 'anonymous')
      snap(this, await create('user', { name: 'x', url: 'https://a.b', mediaType: 'book' }), 'user')
      snap(this, await create('guest', { name: 'x', url: 'https://a.b', mediaType: 'book' }), 'guest')
      expect(await Database.customMetadataProviderModel.count()).to.equal(0)
    })
    it('validates the body', async function () {
      this.ids = new Map()
      snap(this, await create('admin', {}), 'empty')
      snap(this, await create('admin', { name: 'x', url: 'https://a.b' }), 'no media type')
      snap(this, await create('admin', { name: 'x', url: 'not a url', mediaType: 'book' }), 'invalid url')
      snap(this, await create('admin', { name: 'x', url: 'https://a.b', mediaType: 'movie' }), 'unknown media type')
      snap(this, await create('admin', { name: 'x', url: 12, mediaType: 'book' }), 'url not a string')
      // oddity: an unknown mediaType is accepted and stored (only the 'movie' request above created a row)
      expect(await Database.customMetadataProviderModel.count()).to.equal(1)
    })
    it('creates providers and emits an event', async function () {
      this.ids = new Map()
      snap(this, await create('admin', { name: 'My Books', url: 'https://example.invalid/books', mediaType: 'book', authHeaderValue: 'Bearer abc' }), 'book with auth header')
      snap(this, await create('root', { name: 'My Pods', url: 'http://localhost:3000/pods', mediaType: 'podcast' }), 'podcast without auth header')
      snap(this, await create('admin', { name: 'Empty header', url: 'ftp://host/x', mediaType: 'book', authHeaderValue: '' }), 'empty auth header becomes null, ftp url accepted')
      const rows = await Database.customMetadataProviderModel.findAll({ order: [['name', 'ASC']] })
      matchSnapshot(this, rows.map((r) => ({ name: r.name, mediaType: r.mediaType, url: r.url, authHeaderValue: r.authHeaderValue })), { label: 'rows', ids: this.ids })
    })
  })

  describe('DELETE /api/custom-metadata-providers/:id', () => {
    it('requires authentication and admin', async function () {
      const p = await createProvider({ n: 1, name: 'P' })
      snap(this, await api.request('DELETE', `/api/custom-metadata-providers/${p.id}`), 'anonymous')
      snap(this, await api.request('DELETE', `/api/custom-metadata-providers/${p.id}`, { as: 'user' }), 'user')
      expect(await Database.customMetadataProviderModel.count()).to.equal(1)
    })
    it('404s on unknown id', async function () {
      snap(this, await api.request('DELETE', `/api/custom-metadata-providers/${fixedId(99)}`, { as: 'admin' }))
    })
    it('deletes and resets libraries that used the provider', async function () {
      this.ids = new Map()
      const book = await createProvider({ n: 1, name: 'Book provider', mediaType: 'book' })
      const pod = await createProvider({ n: 2, name: 'Pod provider', mediaType: 'podcast' })
      const books = await createLibrary({ name: 'Books' })
      const pods = await createLibrary({ name: 'Podcasts', mediaType: 'podcast', path: '/test/pods' })
      const keep = await createLibrary({ name: 'Keep', path: '/test/keep' })
      await books.library.update({ provider: `custom-${book.id}` })
      await pods.library.update({ provider: `custom-${pod.id}` })
      await keep.library.update({ provider: `custom-${pod.id}x` })

      snap(this, await api.request('DELETE', `/api/custom-metadata-providers/${book.id}`, { as: 'admin' }), 'delete book provider')
      snap(this, await api.request('DELETE', `/api/custom-metadata-providers/${pod.id}`, { as: 'root' }), 'delete podcast provider')
      snap(this, await api.request('DELETE', `/api/custom-metadata-providers/${pod.id}`, { as: 'root' }), 'delete again')
      const libs = await Database.libraryModel.findAll({ order: [['name', 'ASC']] })
      matchSnapshot(this, libs.map((l) => ({ name: l.name, provider: l.provider })), { label: 'library providers', ids: this.ids })
      snap(this, await api.request('GET', '/api/custom-metadata-providers', { as: 'admin' }), 'list after')
    })
  })
})
