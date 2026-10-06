const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary, createBook } = require('./helpers/seed-library')
const { enableCookies, setupTokens, createUser, audioBookExtra, createAuthSession, createPlaybackSession, hashPassword } = require('./helpers/seed-users-extra')
const Database = require('../../server/Database')
const SocketAuthority = require('../../server/SocketAuthority')

describe('UserController (characterization)', () => {
  let api, users, restoreSecret, lf, book

  beforeEach(async () => {
    api = await startApi({ managers: { playbackSessionManager: { sessions: [] } } })
    restoreSecret = setupTokens(api)
    enableCookies(api)
    users = await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    book = await createBook(lf, { title: 'Book A', authors: ['Ann Author'], extra: audioBookExtra({ duration: 1000, narrators: ['Nora'], genres: ['Fantasy'] }) })
  })

  afterEach(async () => {
    await api.stop()
    restoreSecret()
  })

  const snap = (ctx, res, label) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted }, { label, ids: ctx.ids })
  }
  const named = (extra = []) => new Map([[users.root.id, '<root>'], [users.admin.id, '<admin>'], [users.user.id, '<user>'], [users.guest.id, '<guest>'], [lf.library.id, '<library>'], [book.libraryItem.id, '<item-A>'], ...extra])
  const create = (as, json) => api.request('POST', '/api/users', { as, json })
  const patch = (as, id, json) => api.request('PATCH', `/api/users/${id}`, { as, json })

  describe('POST /api/users', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/users', { json: {} }))
    })
    it('is admin only', async function () {
      this.ids = named()
      for (const as of ['user', 'guest']) snap(this, await create(as, { username: 'new', password: 'pw' }), as)
    })
    it('validates the body', async function () {
      this.ids = named()
      snap(this, await create('admin', {}), 'empty')
      snap(this, await create('admin', { username: 'new' }), 'no password')
      snap(this, await create('admin', { password: 'pw' }), 'no username')
      snap(this, await create('admin', { username: 5, password: 'pw' }), 'username not a string')
      snap(this, await create('admin', { username: 'new', password: 5 }), 'password not a string')
      snap(this, await create('admin', { username: 'new', password: 'pw', type: 'root' }), 'type root')
      snap(this, await create('admin', { username: 'new', password: 'pw', type: 'wizard' }), 'unknown type')
      snap(this, await create('admin', { username: 'user', password: 'pw' }), 'username taken')
      snap(this, await create('admin', { username: 'USER', password: 'pw' }), 'username taken (case differs)')
    })
    it('creates a user with defaults and hashes the password', async function () {
      this.ids = named()
      const res = await create('admin', { username: 'newbie', password: 'secret' })
      snap(this, res, 'defaults')
      const row = await Database.userModel.findByPk(res.body.user.id)
      expect(row.pash).to.match(/^\$2[aby]\$/)
      expect(row.token).to.be.a('string')
    })
    it('creates users with type, permissions, library and tag restrictions', async function () {
      this.ids = named()
      snap(
        this,
        await create('root', {
          username: 'custom',
          password: 'pw',
          email: 'c@example.com',
          type: 'admin',
          isActive: true,
          permissions: { delete: true, upload: true, download: false, bogusKey: true, update: 'yes', accessAllLibraries: false, accessAllTags: false, librariesAccessible: [lf.library.id], itemTagsSelected: ['tagA'] }
        }),
        'admin with permissions'
      )
      snap(this, await create('admin', { username: 'restricted', password: 'pw', librariesAccessible: [lf.library.id], itemTagsSelected: ['tagA', 'tagB'], permissions: { accessAllLibraries: false } }), 'top level libraries and tags')
      snap(this, await create('admin', { username: 'badarrays', password: 'pw', librariesAccessible: 'all', itemTagsSelected: [1, 2], email: 5 }), 'invalid arrays and email are ignored')
      snap(this, await create('admin', { username: 'guesty', password: 'pw', type: 'guest', isActive: true }), 'guest')
      snap(this, await api.request('GET', '/api/users', { as: 'admin' }), 'list afterwards')
    })
  })

  describe('GET /api/users', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('GET', '/api/users'), 'unauthenticated')
      for (const as of ['user', 'guest']) snap(this, await api.request('GET', '/api/users', { as }), as)
    })
    it('lists users; the root token is only visible to root', async function () {
      this.ids = named()
      snap(this, await api.request('GET', '/api/users', { as: 'root' }), 'root')
      snap(this, await api.request('GET', '/api/users', { as: 'admin' }), 'admin')
    })
    it('includes the latest listening session', async function () {
      this.ids = named()
      const ctx = { user: users.user, library: lf.library, ...book }
      await createPlaybackSession(ctx, { at: '2024-03-15T12:00:00Z', title: 'older', timeListening: 10 })
      await createPlaybackSession(ctx, { at: '2024-03-17T12:00:00Z', title: 'newest', timeListening: 20 })
      snap(this, await api.request('GET', '/api/users?include=latestSession', { as: 'admin' }), 'include latestSession')
      snap(this, await api.request('GET', '/api/users?include=other', { as: 'admin' }), 'unknown include')
    })
  })

  describe('GET /api/users/online', () => {
    afterEach(() => {
      delete SocketAuthority.clients
      delete SocketAuthority.Server
    })
    it('requires authentication and admin', async function () {
      snap(this, await api.request('GET', '/api/users/online'), 'unauthenticated')
      for (const as of ['user', 'guest']) snap(this, await api.request('GET', '/api/users/online', { as }), as)
    })
    it('lists nobody online without socket clients', async function () {
      SocketAuthority.clients = {} // normally created by SocketAuthority.initialize()
      snap(this, await api.request('GET', '/api/users/online', { as: 'admin' }))
    })
    it('lists connected users with their connection counts', async function () {
      this.ids = named()
      const user = await Database.userModel.getUserById(users.user.id)
      SocketAuthority.Server = { playbackSessionManager: api.apiRouter.playbackSessionManager }
      SocketAuthority.clients = { s1: { user }, s2: { user }, s3: {} }
      snap(this, await api.request('GET', '/api/users/online', { as: 'admin' }))
    })
  })

  describe('GET /api/users/:id', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', `/api/users/${users.user.id}`))
    })
    it('non-admins get 403 for themselves and others', async function () {
      this.ids = named()
      snap(this, await api.request('GET', `/api/users/${users.user.id}`, { as: 'user' }), 'self')
      snap(this, await api.request('GET', `/api/users/${users.admin.id}`, { as: 'user' }), 'other')
      snap(this, await api.request('GET', '/api/users/nope', { as: 'user' }), 'unknown id as user')
    })
    it('404s for an unknown id', async function () {
      snap(this, await api.request('GET', '/api/users/nope', { as: 'admin' }))
    })
    it('returns the user with media progress details', async function () {
      this.ids = named()
      const itemId = book.libraryItem.id
      const second = await createBook(lf, { title: 'Book B', extra: audioBookExtra({ duration: 2000 }) })
      this.ids.set(second.libraryItem.id, '<item-B>')
      await api.request('PATCH', `/api/me/progress/${itemId}`, { as: 'user', json: { duration: 1000, currentTime: 250, progress: 0.25 } })
      await api.request('PATCH', `/api/me/progress/${second.libraryItem.id}`, { as: 'user', json: { duration: 2000, currentTime: 2000, isFinished: true } })
      api.emitted.splice(0)
      const res = await api.request('GET', `/api/users/${users.user.id}`, { as: 'admin' })
      res.body.mediaProgress.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle)) // the server returns them in database order
      snap(this, res, 'user as admin')
      snap(this, await api.request('GET', `/api/users/${users.root.id}`, { as: 'admin' }), 'root as admin hides token')
      snap(this, await api.request('GET', `/api/users/${users.root.id}`, { as: 'root' }), 'root as root')
    })
  })

  describe('PATCH /api/users/:id', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('PATCH', `/api/users/${users.user.id}`, { json: {} }))
    })
    it('is admin only, even for oneself', async function () {
      this.ids = named()
      snap(this, await patch('user', users.user.id, { email: 'x@example.com' }), 'user self')
      snap(this, await patch('guest', users.user.id, { email: 'x@example.com' }), 'guest other')
    })
    it('404s for an unknown user', async function () {
      snap(this, await patch('admin', 'nope', { email: 'x@example.com' }))
    })
    it('protects the root user', async function () {
      this.ids = named()
      snap(this, await patch('admin', users.root.id, { email: 'r@example.com' }), 'admin updates root')
      snap(this, await patch('root', users.root.id, { type: 'user', email: 'r@example.com' }), 'root keeps type root')
    })
    it('rejects invalid payloads', async function () {
      this.ids = named()
      for (const key of ['id', 'pash', 'token', 'extraData', 'bookmarks']) snap(this, await patch('admin', users.user.id, { [key]: 'x' }), `forbidden key ${key}`)
      snap(this, await patch('admin', users.user.id, { email: 5 }), 'email not a string')
      snap(this, await patch('admin', users.user.id, { username: 5 }), 'username not a string')
      snap(this, await patch('admin', users.user.id, { type: 'root' }), 'type root')
      snap(this, await patch('admin', users.user.id, { permissions: 'all' }), 'permissions not an object')
      snap(this, await patch('admin', users.user.id, { username: 'guest' }), 'username taken')
      snap(this, await api.request('GET', `/api/users/${users.user.id}`, { as: 'admin' }), 'user unchanged')
    })
    it('updates simple fields and permissions', async function () {
      this.ids = named()
      snap(this, await patch('admin', users.user.id, { email: 'u@example.com', isActive: false, lastSeen: 1700000000000 }), 'email, isActive, lastSeen')
      snap(this, await patch('admin', users.user.id, { type: 'admin' }), 'promote to admin')
      snap(this, await patch('admin', users.user.id, { permissions: { update: true, delete: true, download: false, bogusKey: true, upload: 'no' } }), 'permissions with invalid entries')
      snap(this, await patch('admin', users.user.id, { permissions: { accessAllLibraries: false, accessAllTags: false, librariesAccessible: [lf.library.id], itemTagsSelected: ['tagA'] } }), 'library and tag restrictions')
      snap(this, await patch('admin', users.user.id, { librariesAccessible: [], itemTagsSelected: [], permissions: {} }), 'top level arrays without permission changes')
      snap(this, await patch('admin', users.user.id, { permissions: { librariesAccessible: 'x', itemTagsSelected: [3] } }), 'invalid arrays are ignored')
      snap(this, await patch('admin', users.user.id, {}), 'no changes')
      snap(this, await patch('admin', users.user.id, { email: 'u@example.com', isActive: false }), 'same values')
    })
    it('changing username or password invalidates login sessions', async function () {
      this.ids = named()
      const target = await createUser({ username: 'target', type: 'user', password: 'old' })
      this.ids.set(target.id, '<target>')
      const sessionCount = async () => Database.sessionModel.count({ where: { userId: target.id } })
      await createAuthSession(target, { refreshToken: 'r1' })
      await createAuthSession(target, { refreshToken: 'r2' })
      expect(await sessionCount()).to.equal(2)
      const before = await Database.userModel.findByPk(target.id)
      snap(this, await patch('admin', target.id, { password: 'brand-new' }), 'new password')
      const after = await Database.userModel.findByPk(target.id)
      expect(after.pash).to.not.equal(before.pash)
      expect(after.pash).to.match(/^\$2[aby]\$/)
      expect(await sessionCount()).to.equal(0)
      await createAuthSession(target, { refreshToken: 'r3' })
      const res = await patch('admin', target.id, { username: 'renamed' })
      snap(this, res, 'new username')
      expect(await sessionCount()).to.equal(0)
      snap(this, await patch('admin', target.id, { username: 'Renamed' }), 'username differing only by case')
    })
    it('an admin changing their own password rotates the current session', async function () {
      this.ids = named()
      await createAuthSession(users.admin, { refreshToken: 'admin-current' })
      await createAuthSession(users.admin, { refreshToken: 'admin-other' })
      snap(this, await api.request('PATCH', `/api/users/${users.admin.id}`, { as: 'admin', json: { password: 'changed' }, headers: { 'x-refresh-token': 'admin-current' } }), 'own password')
      const remaining = await Database.sessionModel.findAll({ where: { userId: users.admin.id } })
      expect(remaining).to.have.length(1)
      expect(remaining[0].refreshToken).to.not.equal('admin-current')
    })
  })

  describe('DELETE /api/users/:id', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('DELETE', `/api/users/${users.user.id}`))
    })
    it('is admin only', async function () {
      this.ids = named()
      snap(this, await api.request('DELETE', `/api/users/${users.guest.id}`, { as: 'user' }), 'user')
      snap(this, await api.request('DELETE', `/api/users/${users.user.id}`, { as: 'guest' }), 'guest')
    })
    it('refuses to delete oneself or the root user, and 404s for unknown ids', async function () {
      this.ids = named()
      snap(this, await api.request('DELETE', `/api/users/${users.admin.id}`, { as: 'admin' }), 'self')
      snap(this, await api.request('DELETE', `/api/users/${users.root.id}`, { as: 'admin' }), 'root')
      snap(this, await api.request('DELETE', '/api/users/nope', { as: 'admin' }), 'unknown')
    })
    it('deletes a user, their playlists and unlinks their playback sessions', async function () {
      this.ids = named()
      const target = await createUser({ username: 'doomed', type: 'user' })
      this.ids.set(target.id, '<doomed>')
      await Database.playlistModel.create({ name: 'Mine', libraryId: lf.library.id, userId: target.id })
      await createPlaybackSession({ user: target, library: lf.library, ...book }, { at: '2024-03-15T12:00:00Z', timeListening: 10 })
      snap(this, await api.request('DELETE', `/api/users/${target.id}`, { as: 'admin' }), 'delete')
      expect(await Database.playlistModel.count({ where: { userId: target.id } })).to.equal(0)
      const sessions = await Database.playbackSessionModel.findAll()
      expect(sessions).to.have.length(1)
      expect(sessions[0].userId).to.equal(null)
      snap(this, await api.request('GET', `/api/users/${target.id}`, { as: 'admin' }), 'get afterwards')
      snap(this, await api.request('DELETE', `/api/users/${target.id}`, { as: 'admin' }), 'delete again')
      snap(this, await api.request('GET', '/api/users', { as: 'admin' }), 'list afterwards')
    })
  })

  describe('PATCH /api/users/:id/openid-unlink', () => {
    it('requires authentication and admin', async function () {
      this.ids = named()
      snap(this, await api.request('PATCH', `/api/users/${users.user.id}/openid-unlink`), 'unauthenticated')
      snap(this, await api.request('PATCH', `/api/users/${users.user.id}/openid-unlink`, { as: 'user' }), 'user self')
      snap(this, await api.request('PATCH', `/api/users/${users.user.id}/openid-unlink`, { as: 'guest' }), 'guest')
    })
    it('404s for an unknown user', async function () {
      snap(this, await api.request('PATCH', '/api/users/nope/openid-unlink', { as: 'admin' }))
    })
    it('is a no-op for a user without an openid link', async function () {
      this.ids = named()
      snap(this, await api.request('PATCH', `/api/users/${users.user.id}/openid-unlink`, { as: 'admin' }))
    })
    it('removes the openid link', async function () {
      this.ids = named()
      const target = await createUser({ username: 'linked', type: 'user' })
      target.extraData = { ...target.extraData, authOpenIDSub: 'sub-123' }
      target.changed('extraData', true)
      await target.save()
      this.ids.set(target.id, '<linked>')
      snap(this, await api.request('GET', '/api/users', { as: 'admin' }), 'list before')
      snap(this, await api.request('PATCH', `/api/users/${target.id}/openid-unlink`, { as: 'admin' }), 'unlink')
      snap(this, await api.request('GET', '/api/users', { as: 'admin' }), 'list after')
      expect((await Database.userModel.findByPk(target.id)).extraData.authOpenIDSub).to.equal(null)
    })
  })

  describe('listening routes', () => {
    beforeEach(async () => {
      const ctx = { user: users.user, library: lf.library, ...book }
      const other = await createBook(lf, { title: 'Book B', extra: audioBookExtra({ duration: 2000 }) })
      for (let i = 0; i < 4; i++) await createPlaybackSession(ctx, { at: `2024-03-1${i + 1}T12:00:00Z`, title: `Session ${i + 1}`, timeListening: 100 * (i + 1), authors: ['Ann Author'], date: `2024-03-1${i + 1}`, dayOfWeek: 'Monday', currentTime: i * 10 })
      await createPlaybackSession({ ...ctx, ...other }, { at: '2024-03-20T12:00:00Z', title: 'Other book', timeListening: 50, date: '2024-03-20', dayOfWeek: 'Wednesday' })
      await createPlaybackSession({ user: users.admin, library: lf.library, ...book }, { at: '2024-03-21T12:00:00Z', title: 'Admin session', timeListening: 5 })
    })

    describe('GET /api/users/:id/listening-sessions', () => {
      it('requires authentication, and non-admins may only read their own', async function () {
        this.ids = named()
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-sessions`), 'unauthenticated')
        snap(this, await api.request('GET', `/api/users/${users.admin.id}/listening-sessions`, { as: 'user' }), 'user reads admin')
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-sessions`, { as: 'guest' }), 'guest reads user')
        snap(this, await api.request('GET', '/api/users/nope/listening-sessions', { as: 'admin' }), 'unknown user')
      })
      it('returns sessions newest first, paginated, with the user attached', async function () {
        this.ids = named()
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-sessions`, { as: 'admin' }), 'admin reads user')
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-sessions`, { as: 'user' }), 'user reads self')
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-sessions?itemsPerPage=2&page=1`, { as: 'admin' }), 'page 1 of 2 per page')
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-sessions?itemsPerPage=2&page=9`, { as: 'admin' }), 'page beyond the end')
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-sessions?itemsPerPage=0`, { as: 'admin' }), 'itemsPerPage 0 falls back to 10')
        snap(this, await api.request('GET', `/api/users/${users.guest.id}/listening-sessions`, { as: 'admin' }), 'user without sessions')
      })
    })

    describe('GET /api/users/:id/listening-stats', () => {
      it('requires authentication, and non-admins may only read their own', async function () {
        this.ids = named()
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-stats`), 'unauthenticated')
        snap(this, await api.request('GET', `/api/users/${users.admin.id}/listening-stats`, { as: 'user' }), 'user reads admin')
        snap(this, await api.request('GET', '/api/users/nope/listening-stats', { as: 'admin' }), 'unknown user')
      })
      it('aggregates listening time per item, day and weekday', async function () {
        this.ids = named()
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-stats`, { as: 'admin' }), 'admin reads user')
        snap(this, await api.request('GET', `/api/users/${users.user.id}/listening-stats`, { as: 'user' }), 'user reads self')
        snap(this, await api.request('GET', `/api/users/${users.guest.id}/listening-stats`, { as: 'admin' }), 'user without sessions')
      })
    })
  })

  void hashPassword
})
