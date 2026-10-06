const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { setupTokens, createUser } = require('./helpers/seed-users-extra')
const Database = require('../../server/Database')

describe('ApiKeyController (characterization)', () => {
  let api, users, restoreSecret

  beforeEach(async () => {
    api = await startApi()
    restoreSecret = setupTokens(api)
    users = await api.seed.users()
  })

  afterEach(async () => {
    await api.stop()
    restoreSecret()
  })

  const snap = (ctx, res, label) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted }, { label, ids: ctx.ids })
  }
  const ids = () =>
    new Map([
      [users.root.id, '<root>'],
      [users.admin.id, '<admin>'],
      [users.user.id, '<user>'],
      [users.guest.id, '<guest>']
    ])
  const create = (as, json) => api.request('POST', '/api/api-keys', { as, json })

  describe('POST /api/api-keys', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/api-keys', { json: {} }))
    })
    it('is admin only', async function () {
      for (const as of ['user', 'guest']) snap(this, await create(as, { name: 'k', userId: users.user.id }), as)
    })
    it('validates the body', async function () {
      this.ids = ids()
      snap(this, await create('admin', {}), 'no name')
      snap(this, await create('admin', { name: 5, userId: users.user.id }), 'name not a string')
      snap(this, await create('admin', { name: 'k', userId: users.user.id, expiresIn: 'soon' }), 'expiresIn not a number')
      snap(this, await create('admin', { name: 'k', userId: users.user.id, expiresIn: -5 }), 'expiresIn negative')
      snap(this, await create('admin', { name: 'k' }), 'no userId')
      snap(this, await create('admin', { name: 'k', userId: 7 }), 'userId not a string')
      snap(this, await create('admin', { name: 'k', userId: 'nope' }), 'unknown user')
      snap(this, await api.request('GET', '/api/api-keys', { as: 'admin' }), 'nothing created')
    })
    it('only root can create a key for the root user', async function () {
      this.ids = ids()
      snap(this, await create('admin', { name: 'root key', userId: users.root.id }), 'admin for root')
      const res = await create('root', { name: 'root key', userId: users.root.id, isActive: true })
      snap(this, { ...res, body: { apiKey: { ...res.body.apiKey, apiKey: typeof res.body.apiKey.apiKey } } }, 'root for root')
    })
    it('creates keys with and without expiry', async function () {
      this.ids = ids()
      const permanent = await create('admin', { name: 'permanent', userId: users.user.id })
      const active = await create('root', { name: 'active', userId: users.admin.id, isActive: true, expiresIn: 3600 })
      snap(this, { ...permanent, body: { apiKey: { ...permanent.body.apiKey, apiKey: typeof permanent.body.apiKey.apiKey } } }, 'permanent')
      // expiresAt is Date.now() + expiresIn: only check it, the rest is snapshotted
      const expiresIn = new Date(active.body.apiKey.expiresAt).valueOf() - Date.now()
      if (!(expiresIn > 3590 * 1000 && expiresIn <= 3600 * 1000)) throw new Error(`unexpected expiresAt ${active.body.apiKey.expiresAt}`)
      snap(this, { ...active, body: { apiKey: { ...active.body.apiKey, expiresAt: '<in 1h>', apiKey: typeof active.body.apiKey.apiKey } } }, 'active with expiry')
    })
  })

  describe('GET /api/api-keys', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('GET', '/api/api-keys'), 'unauthenticated')
      for (const as of ['user', 'guest']) snap(this, await api.request('GET', '/api/api-keys', { as }), as)
    })
    it('lists keys with user and creator', async function () {
      this.ids = ids()
      snap(this, await api.request('GET', '/api/api-keys', { as: 'admin' }), 'empty')
      await create('admin', { name: 'one', userId: users.user.id })
      await create('root', { name: 'two', userId: users.guest.id, isActive: true })
      snap(this, await api.request('GET', '/api/api-keys', { as: 'admin' }), 'two keys')
    })
  })

  describe('PATCH /api/api-keys/:id', () => {
    let key, rootKey
    beforeEach(async function () {
      key = (await create('admin', { name: 'one', userId: users.user.id })).body.apiKey
      rootKey = (await create('root', { name: 'root key', userId: users.root.id })).body.apiKey
      api.emitted.splice(0)
    })
    const patch = (as, id, json) => api.request('PATCH', `/api/api-keys/${id}`, { as, json })

    it('requires authentication and admin', async function () {
      this.ids = ids()
      snap(this, await api.request('PATCH', `/api/api-keys/${key.id}`, { json: { isActive: true } }), 'unauthenticated')
      for (const as of ['user', 'guest']) snap(this, await patch(as, key.id, { isActive: true }), as)
    })
    it('404s for an unknown key', async function () {
      snap(this, await patch('admin', 'nope', { isActive: true }))
    })
    it('validates the body', async function () {
      this.ids = ids()
      snap(this, await patch('admin', key.id, { isActive: 'yes' }), 'isActive not boolean')
      snap(this, await patch('admin', key.id, { userId: 5 }), 'userId not string')
      snap(this, await patch('admin', key.id, { userId: 'nope' }), 'unknown user')
      snap(this, await patch('admin', key.id, { userId: users.root.id }), 'admin moves key to root user')
    })
    it('updates isActive and userId, and ignores everything else', async function () {
      this.ids = ids()
      snap(this, await patch('admin', key.id, { isActive: true }), 'activate')
      snap(this, await patch('admin', key.id, { isActive: true }), 'activate again (no change)')
      snap(this, await patch('admin', key.id, { userId: users.guest.id, name: 'ignored' }), 'change user, name ignored')
      snap(this, await patch('admin', key.id, {}), 'empty body')
      snap(this, await api.request('GET', '/api/api-keys', { as: 'admin' }), 'list afterwards')
    })
    it('only root can update a key that belongs to root', async function () {
      this.ids = ids()
      snap(this, await patch('admin', rootKey.id, { isActive: true }), 'admin')
      snap(this, await patch('root', rootKey.id, { isActive: true }), 'root')
    })
  })

  describe('DELETE /api/api-keys/:id', () => {
    it('requires authentication and admin', async function () {
      const key = (await create('admin', { name: 'one', userId: users.user.id })).body.apiKey
      this.ids = ids()
      snap(this, await api.request('DELETE', `/api/api-keys/${key.id}`), 'unauthenticated')
      for (const as of ['user', 'guest']) snap(this, await api.request('DELETE', `/api/api-keys/${key.id}`, { as }), as)
    })
    it('deletes a key and 404s afterwards', async function () {
      this.ids = ids()
      const key = (await create('admin', { name: 'one', userId: users.user.id })).body.apiKey
      const other = (await create('admin', { name: 'other', userId: users.user.id })).body.apiKey
      api.emitted.splice(0)
      snap(this, await api.request('DELETE', `/api/api-keys/${key.id}`, { as: 'admin' }), 'admin deletes')
      snap(this, await api.request('DELETE', `/api/api-keys/${key.id}`, { as: 'admin' }), 'again')
      snap(this, await api.request('GET', '/api/api-keys', { as: 'admin' }), 'list afterwards')
      void other
    })
    it('deleting a user cascades to its keys', async function () {
      this.ids = ids()
      const extra = await createUser({ username: 'temp', type: 'user' })
      await create('admin', { name: 'temp key', userId: extra.id })
      this.ids.set(extra.id, '<temp>')
      snap(this, await api.request('DELETE', `/api/users/${extra.id}`, { as: 'root' }), 'delete user')
      snap(this, await api.request('GET', '/api/api-keys', { as: 'admin' }), 'list afterwards')
      void Database
    })
  })
})
