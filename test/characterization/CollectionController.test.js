const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary, createBook } = require('./helpers/seed-library')

// Reference characterization test: every route of one controller, as different users, snapshotting status, body and side effects.
describe('CollectionController (characterization)', () => {
  let api, lf, other, items

  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    other = await createLibrary({ name: 'Other', path: '/test/other' })
    items = []
    for (const title of ['Book A', 'Book B', 'Book C']) items.push((await createBook(lf, { title, authors: ['Ann Author'] })).libraryItem)
    items.push((await createBook(other, { title: 'Elsewhere' })).libraryItem)
  })

  afterEach(async () => {
    await api.stop()
  })

  // one snapshot per call: status + body + what was emitted since the last call
  const snap = (ctx, res, label) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted }, { label, ids: ctx.ids })
  }
  const createCollection = (as = 'admin', over = {}) => api.request('POST', '/api/collections', { as, json: { libraryId: lf.library.id, name: 'Favourites', description: 'my picks', books: [items[0].id, items[1].id], ...over } })

  describe('POST /api/collections', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/collections', { json: {} }))
    })
    it('rejects invalid bodies', async function () {
      this.ids = new Map()
      snap(this, await createCollection('admin', { name: '' }), 'empty name')
      snap(this, await createCollection('admin', { libraryId: undefined }), 'no library')
      snap(this, await createCollection('admin', { books: [] }), 'no books')
      snap(this, await createCollection('admin', { description: 5 }), 'bad description')
    })
    it('strips html from the name', async function () {
      snap(this, await createCollection('admin', { name: '<b>Bold</b> name' }))
    })
    it('ignores items from another library', async function () {
      this.ids = new Map()
      snap(this, await createCollection('admin', { books: [items[0].id, items[3].id] }))
    })
    it('creates a collection as admin, user and guest', async function () {
      this.ids = new Map()
      snap(this, await createCollection('admin'), 'admin')
      snap(this, await createCollection('user', { name: 'User collection' }), 'user')
      snap(this, await createCollection('guest', { name: 'Guest collection' }), 'guest')
    })
  })

  describe('read routes', () => {
    it('lists, finds and 404s', async function () {
      this.ids = new Map()
      const { body: created } = await createCollection('admin')
      api.emitted.splice(0)
      snap(this, await api.request('GET', '/api/collections', { as: 'admin' }), 'list')
      snap(this, await api.request('GET', `/api/collections/${created.id}`, { as: 'admin' }), 'find')
      snap(this, await api.request('GET', `/api/collections/${created.id}?include=rssfeed`, { as: 'admin' }), 'find include rssfeed')
      snap(this, await api.request('GET', '/api/collections/not-a-real-id', { as: 'admin' }), 'unknown id')
      snap(this, await api.request('GET', `/api/libraries/${lf.library.id}/collections`, { as: 'admin' }), 'library collections')
    })
  })

  describe('modify routes', () => {
    let collection
    beforeEach(async function () {
      collection = (await createCollection('admin')).body
      api.emitted.splice(0)
    })

    it('updates name, description and book order', async function () {
      this.ids = new Map([[collection.id, '<collection>']])
      snap(this, await api.request('PATCH', `/api/collections/${collection.id}`, { as: 'admin', json: { name: 'Renamed', description: 'new', books: [items[1].id, items[0].id] } }), 'full update')
      snap(this, await api.request('PATCH', `/api/collections/${collection.id}`, { as: 'admin', json: { description: 'x'.repeat(5) } }), 'partial update')
      snap(this, await api.request('PATCH', `/api/collections/${collection.id}`, { as: 'admin', json: {} }), 'no changes')
    })
    it('adds and removes single books', async function () {
      this.ids = new Map([[collection.id, '<collection>']])
      snap(this, await api.request('POST', `/api/collections/${collection.id}/book`, { as: 'admin', json: { id: items[2].id } }), 'add')
      snap(this, await api.request('POST', `/api/collections/${collection.id}/book`, { as: 'admin', json: { id: items[2].id } }), 'add again')
      snap(this, await api.request('POST', `/api/collections/${collection.id}/book`, { as: 'admin', json: { id: 'nope' } }), 'add unknown')
      snap(this, await api.request('DELETE', `/api/collections/${collection.id}/book/${items[2].id}`, { as: 'admin' }), 'remove')
      snap(this, await api.request('DELETE', `/api/collections/${collection.id}/book/${items[2].id}`, { as: 'admin' }), 'remove again')
    })
    it('adds and removes batches', async function () {
      this.ids = new Map([[collection.id, '<collection>']])
      snap(this, await api.request('POST', `/api/collections/${collection.id}/batch/add`, { as: 'admin', json: { books: [items[1].id, items[2].id] } }), 'batch add')
      // an empty list is rejected with the same 400 as any invalid body (controller requires a non-empty array)
      snap(this, await api.request('POST', `/api/collections/${collection.id}/batch/add`, { as: 'admin', json: { books: [] } }), 'batch add empty')
      snap(this, await api.request('POST', `/api/collections/${collection.id}/batch/remove`, { as: 'admin', json: { books: [items[0].id, items[2].id] } }), 'batch remove')
      snap(this, await api.request('POST', `/api/collections/${collection.id}/batch/remove`, { as: 'admin', json: {} }), 'batch remove invalid')
    })
    it('checks permissions', async function () {
      this.ids = new Map([[collection.id, '<collection>']])
      for (const as of ['user', 'guest']) {
        snap(this, await api.request('PATCH', `/api/collections/${collection.id}`, { as, json: { name: 'Hacked' } }), `${as} update`)
        snap(this, await api.request('POST', `/api/collections/${collection.id}/book`, { as, json: { id: items[2].id } }), `${as} add`)
        snap(this, await api.request('DELETE', `/api/collections/${collection.id}`, { as }), `${as} delete`)
      }
    })
    it('deletes and 404s afterwards', async function () {
      this.ids = new Map([[collection.id, '<collection>']])
      snap(this, await api.request('DELETE', `/api/collections/${collection.id}`, { as: 'admin' }), 'admin is not allowed')
      snap(this, await api.request('DELETE', `/api/collections/${collection.id}`, { as: 'root' }), 'root deletes')
      snap(this, await api.request('GET', `/api/collections/${collection.id}`, { as: 'root' }), 'find after delete')
      snap(this, await api.request('DELETE', `/api/collections/${collection.id}`, { as: 'root' }), 'delete again')
    })
  })
})
