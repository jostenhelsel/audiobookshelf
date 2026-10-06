const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary, createBook } = require('./helpers/seed-library')
const { fixedId, enableCookies, setupTokens, createUser, audioBookExtra, createPodcast, createProgress, createAuthSession, createPlaybackSession } = require('./helpers/seed-users-extra')
const Database = require('../../server/Database')

describe('MeController (characterization)', () => {
  let api, users, restoreSecret, lf, secretLib, podLib, A, B, C, D, pod, restricted

  const BOOKMARKS = [
    { libraryItemId: null, time: 10, title: 'Intro', createdAt: 1700000000000 },
    { libraryItemId: null, time: 60, title: 'Chapter 2', createdAt: 1700000001000 },
    { libraryItemId: null, time: 5, title: 'Book B mark', createdAt: 1700000002000 }
  ]

  beforeEach(async () => {
    api = await startApi({ managers: { playbackSessionManager: { sessions: [] } } })
    restoreSecret = setupTokens(api)
    enableCookies(api)
    users = await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    secretLib = await createLibrary({ name: 'Secret', path: '/test/secret' })
    podLib = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: '/test/pods' })
    A = await createBook(lf, { title: 'Book A', authors: ['Ann Author'], series: [{ name: 'Saga', sequence: '1' }], extra: audioBookExtra({ id: fixedId(1), duration: 3600, tags: ['public'], narrators: ['Nora'], genres: ['Fantasy'] }) })
    B = await createBook(lf, { title: 'Book B', authors: ['Bob Writer'], extra: audioBookExtra({ id: fixedId(2), duration: 1800, tags: ['secret'] }) })
    C = await createBook(lf, { title: 'Book C', extra: audioBookExtra({ id: fixedId(3), duration: 600, tags: ['public'] }) })
    D = await createBook(secretLib, { title: 'Book D', extra: audioBookExtra({ id: fixedId(4), duration: 900, tags: ['public'] }) })
    pod = await createPodcast(podLib, {
      title: 'Pod',
      episodes: [
        { id: fixedId(11), title: 'Ep 1' },
        { id: fixedId(12), title: 'Ep 2' }
      ]
    })
    restricted = await createUser({ username: 'restricted', type: 'user', permissions: { accessAllLibraries: false, librariesAccessible: [lf.library.id], accessAllTags: false, itemTagsSelected: ['public'] } })

    // progress for `user` (newest first by updatedAt: ep1, A, C, B) and `admin`. Seeded before any request so the user cache is not stale.
    await createProgress(users.user, { libraryItem: A.libraryItem, mediaItemId: A.book.id, duration: 3600, currentTime: 300, updatedAt: '2024-03-15T12:00:00Z' })
    await createProgress(users.user, { libraryItem: B.libraryItem, mediaItemId: B.book.id, duration: 1800, currentTime: 1800, isFinished: true, finishedAt: '2024-03-10T12:00:00Z', updatedAt: '2024-03-10T12:00:00Z' })
    await createProgress(users.user, { libraryItem: C.libraryItem, mediaItemId: C.book.id, duration: 600, currentTime: 60, hidden: true, updatedAt: '2024-03-12T12:00:00Z' })
    await createProgress(users.user, { libraryItem: pod.libraryItem, mediaItemId: fixedId(11), episode: true, podcastId: pod.podcast.id, duration: 1800, currentTime: 120, updatedAt: '2024-03-20T12:00:00Z' })
    await createProgress(users.admin, { libraryItem: A.libraryItem, mediaItemId: A.book.id, duration: 3600, currentTime: 100, updatedAt: '2024-03-16T12:00:00Z' })

    await users.user.update({
      bookmarks: [
        { ...BOOKMARKS[0], libraryItemId: A.libraryItem.id },
        { ...BOOKMARKS[1], libraryItemId: A.libraryItem.id },
        { ...BOOKMARKS[2], libraryItemId: B.libraryItem.id }
      ]
    })

    const ctx = { user: users.user, library: lf.library, ...A }
    for (let i = 0; i < 3; i++) await createPlaybackSession(ctx, { at: `2024-03-1${i + 1}T12:00:00Z`, title: `Session ${i + 1}`, timeListening: 100 * (i + 1), authors: ['Ann Author'], narrators: ['Nora'], genres: ['Fantasy'], date: `2024-03-1${i + 1}`, dayOfWeek: 'Monday', currentTime: i * 10 })
    await createPlaybackSession({ user: users.user, library: lf.library, ...C }, { at: '2024-03-18T12:00:00Z', title: 'Book C session', timeListening: 40, date: '2024-03-18', dayOfWeek: 'Thursday' })
    await createPlaybackSession({ user: users.admin, library: lf.library, ...A }, { at: '2024-03-19T12:00:00Z', title: 'Admin session', timeListening: 7 })
  })

  afterEach(async () => {
    await api.stop()
    restoreSecret()
  })

  const snap = (ctx, res, label) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted }, { label, ids: ctx.ids })
  }
  const named = (extra = []) => new Map([[users.root.id, '<root>'], [users.admin.id, '<admin>'], [users.user.id, '<user>'], [users.guest.id, '<guest>'], [restricted.id, '<restricted>'], [lf.library.id, '<library>'], [A.libraryItem.id, '<item-A>'], [B.libraryItem.id, '<item-B>'], [C.libraryItem.id, '<item-C>'], [D.libraryItem.id, '<item-D>'], [pod.libraryItem.id, '<podcast>'], ...extra])
  const get = (url, as, headers) => api.request('GET', url, { as, headers })

  describe('GET /api/me', () => {
    it('requires authentication', async function () {
      snap(this, await get('/api/me'))
    })
    it('returns the current user for every user type', async function () {
      this.ids = named()
      for (const as of ['root', 'admin', 'user', 'guest', 'restricted']) snap(this, await get('/api/me', as), as)
    })
  })

  describe('GET /api/me/sessions', () => {
    beforeEach(async () => {
      await createAuthSession(users.user, { refreshToken: 'rt-current', createdAt: new Date('2024-03-03T10:00:00Z'), updatedAt: new Date('2024-03-03T12:00:00Z') })
      await createAuthSession(users.user, { refreshToken: 'rt-new', lastRefreshToken: 'rt-old', ipAddress: '10.0.0.2', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', createdAt: new Date('2024-03-02T10:00:00Z'), updatedAt: new Date('2024-03-04T12:00:00Z') })
      await createAuthSession(users.user, { refreshToken: 'rt-expired', expiresAt: new Date('2020-01-01T00:00:00Z'), createdAt: new Date('2024-03-01T10:00:00Z'), updatedAt: new Date('2024-03-05T12:00:00Z') })
      await createAuthSession(users.user, { refreshToken: 'rt-no-ua', userAgent: null, createdAt: new Date('2024-03-01T10:00:00Z'), updatedAt: new Date('2024-03-01T12:00:00Z') })
      await createAuthSession(users.admin, { refreshToken: 'rt-admin', createdAt: new Date('2024-03-03T10:00:00Z'), updatedAt: new Date('2024-03-03T12:00:00Z') })
    })
    it('requires authentication', async function () {
      snap(this, await get('/api/me/sessions'))
    })
    it('lists unexpired sessions newest first and flags the current one', async function () {
      this.ids = named()
      snap(this, await get('/api/me/sessions', 'user'), 'no refresh token')
      snap(this, await get('/api/me/sessions', 'user', { 'x-refresh-token': 'rt-current' }), 'current by refresh token')
      snap(this, await get('/api/me/sessions', 'user', { 'x-refresh-token': 'rt-old' }), 'current by last refresh token')
      snap(this, await get('/api/me/sessions', 'user', { cookie: 'refresh_token=rt-new' }), 'current by cookie')
      snap(this, await get('/api/me/sessions', 'admin'), 'admin')
    })
    it('paginates and clamps the paging parameters', async function () {
      this.ids = named()
      snap(this, await get('/api/me/sessions?itemsPerPage=2', 'user'), 'first page')
      snap(this, await get('/api/me/sessions?itemsPerPage=2&page=1', 'user'), 'second page')
      snap(this, await get('/api/me/sessions?itemsPerPage=2&page=5', 'user'), 'past the end')
      snap(this, await get('/api/me/sessions?itemsPerPage=0&page=-3', 'user'), 'zero and negative values')
      snap(this, await get('/api/me/sessions?itemsPerPage=abc&page=abc', 'user'), 'non numeric values')
    })
    it('returns an empty page for guests and users without sessions', async function () {
      this.ids = named()
      snap(this, await get('/api/me/sessions', 'guest'), 'guest')
      snap(this, await get('/api/me/sessions?itemsPerPage=3&page=2', 'guest'), 'guest with paging')
      snap(this, await get('/api/me/sessions', 'root'), 'root without sessions')
    })
  })

  describe('DELETE /api/me/sessions/:id', () => {
    let own, others
    beforeEach(async () => {
      own = await createAuthSession(users.user, { refreshToken: 'rt-own', createdAt: new Date('2024-03-03T10:00:00Z'), updatedAt: new Date('2024-03-03T12:00:00Z') })
      others = await createAuthSession(users.admin, { refreshToken: 'rt-admin', createdAt: new Date('2024-03-03T10:00:00Z'), updatedAt: new Date('2024-03-03T12:00:00Z') })
    })
    const del = (as, id) => api.request('DELETE', `/api/me/sessions/${id}`, { as })
    it('requires authentication', async function () {
      snap(this, await api.request('DELETE', `/api/me/sessions/${own.id}`))
    })
    it('rejects guests, invalid ids and unknown sessions', async function () {
      this.ids = named([
        [own.id, '<own-session>'],
        [others.id, '<admin-session>']
      ])
      snap(this, await del('guest', own.id), 'guest')
      snap(this, await del('user', 'not-a-uuid'), 'invalid id')
      snap(this, await del('user', '11111111-1111-4111-8111-111111111111'), 'unknown id')
      snap(this, await del('user', others.id), 'session of another user')
      expect(await Database.sessionModel.count()).to.equal(2)
    })
    it('deletes an own session', async function () {
      this.ids = named([
        [own.id, '<own-session>'],
        [others.id, '<admin-session>']
      ])
      snap(this, await del('user', own.id), 'delete')
      snap(this, await del('user', own.id), 'delete again')
      snap(this, await get('/api/me/sessions', 'user'), 'list afterwards')
      snap(this, await get('/api/me/sessions', 'admin'), 'admin session untouched')
    })
  })

  describe('GET /api/me/progress', () => {
    it('requires authentication', async function () {
      snap(this, await get('/api/me/progress'))
    })
    it('returns all media progress of the user only', async function () {
      this.ids = named()
      snap(this, await get('/api/me/progress', 'user'), 'user')
      snap(this, await get('/api/me/progress', 'admin'), 'admin')
      snap(this, await get('/api/me/progress', 'guest'), 'guest without progress')
    })
  })

  describe('GET /api/me/progress/:id/:episodeId?', () => {
    it('requires authentication', async function () {
      snap(this, await get(`/api/me/progress/${A.libraryItem.id}`))
    })
    it('finds progress for books and episodes, 404 otherwise', async function () {
      this.ids = named()
      snap(this, await get(`/api/me/progress/${A.libraryItem.id}`, 'user'), 'book in progress')
      snap(this, await get(`/api/me/progress/${B.libraryItem.id}`, 'user'), 'finished book')
      snap(this, await get(`/api/me/progress/${C.libraryItem.id}`, 'user'), 'hidden book')
      snap(this, await get(`/api/me/progress/${pod.libraryItem.id}/${fixedId(11)}`, 'user'), 'episode')
      snap(this, await get(`/api/me/progress/${pod.libraryItem.id}/${fixedId(12)}`, 'user'), 'episode without progress')
      snap(this, await get(`/api/me/progress/${D.libraryItem.id}`, 'user'), 'item without progress')
      snap(this, await get('/api/me/progress/unknown', 'user'), 'unknown item')
      snap(this, await get(`/api/me/progress/${A.libraryItem.id}`, 'guest'), 'guest')
    })
  })

  describe('PATCH /api/me/progress/:libraryItemId/:episodeId?', () => {
    const patch = (as, url, json) => api.request('PATCH', url, { as, json })
    it('requires authentication', async function () {
      snap(this, await patch(undefined, `/api/me/progress/${D.libraryItem.id}`, { currentTime: 5 }))
    })
    it('creates progress for a book (as admin, user and guest)', async function () {
      this.ids = named()
      snap(this, await patch('user', `/api/me/progress/${D.libraryItem.id}`, { duration: 900, currentTime: 90, progress: 0.1 }), 'user')
      snap(this, await get(`/api/me/progress/${D.libraryItem.id}`, 'user'), 'user progress afterwards')
      snap(this, await patch('guest', `/api/me/progress/${D.libraryItem.id}`, { duration: 900, currentTime: 9 }), 'guest')
      snap(this, await get(`/api/me/progress/${D.libraryItem.id}`, 'guest'), 'guest progress afterwards')
      snap(this, await patch('admin', `/api/me/progress/${C.libraryItem.id}`, { isFinished: true, duration: 600 }), 'admin creates a finished progress')
      snap(this, await get(`/api/me/progress/${C.libraryItem.id}`, 'admin'), 'admin progress afterwards')
      snap(this, await patch('root', `/api/me/progress/${C.libraryItem.id}`, { ebookLocation: 'epubcfi(/6/2)', ebookProgress: 0.5 }), 'root with ebook progress')
      snap(this, await get(`/api/me/progress/${C.libraryItem.id}`, 'root'), 'root progress afterwards')
    })
    it('updates, finishes and resets existing progress', async function () {
      this.ids = named()
      snap(this, await patch('user', `/api/me/progress/${A.libraryItem.id}`, { currentTime: 600, progress: 1 / 6 }), 'update time')
      snap(this, await get(`/api/me/progress/${A.libraryItem.id}`, 'user'), 'after update')
      snap(this, await patch('user', `/api/me/progress/${A.libraryItem.id}`, { currentTime: 3595 }), 'within 10s of the end finishes it')
      snap(this, await get(`/api/me/progress/${A.libraryItem.id}`, 'user'), 'after auto finish')
      snap(this, await patch('user', `/api/me/progress/${A.libraryItem.id}`, { isFinished: false }), 'unfinish')
      snap(this, await get(`/api/me/progress/${A.libraryItem.id}`, 'user'), 'after unfinish')
      snap(this, await patch('user', `/api/me/progress/${A.libraryItem.id}`, { currentTime: 1800, markAsFinishedPercentComplete: 40 }), 'finish by percent')
      snap(this, await patch('user', `/api/me/progress/${B.libraryItem.id}`, { isFinished: true }), 'finish an already finished book')
      snap(this, await patch('user', `/api/me/progress/${C.libraryItem.id}`, { currentTime: 100 }), 'moving a hidden item unhides it')
      snap(this, await get(`/api/me/progress/${C.libraryItem.id}`, 'user'), 'hidden item afterwards')
      snap(this, await patch('user', `/api/me/progress/${B.libraryItem.id}`, { hideFromContinueListening: true }), 'hide an item')
      snap(this, await get('/api/me', 'user'), 'user afterwards')
    })
    it('handles podcast items and episodes', async function () {
      this.ids = named()
      snap(this, await patch('user', `/api/me/progress/${pod.libraryItem.id}/${fixedId(12)}`, { duration: 1800, currentTime: 30 }), 'new episode progress')
      snap(this, await patch('user', `/api/me/progress/${pod.libraryItem.id}/${fixedId(11)}`, { currentTime: 900 }), 'update episode progress')
      snap(this, await get(`/api/me/progress/${pod.libraryItem.id}/${fixedId(11)}`, 'user'), 'episode afterwards')
      snap(this, await patch('user', `/api/me/progress/${pod.libraryItem.id}/${fixedId(99)}`, { currentTime: 1 }), 'unknown episode')
      snap(this, await patch('user', `/api/me/progress/${pod.libraryItem.id}`, { currentTime: 1 }), 'podcast without episode id')
    })
    it('404s for unknown items', async function () {
      this.ids = named()
      snap(this, await patch('user', '/api/me/progress/unknown', { currentTime: 1 }), 'unknown item')
    })
    it('does not check library access (any authenticated user can write progress)', async function () {
      this.ids = named()
      snap(this, await patch('restricted', `/api/me/progress/${D.libraryItem.id}`, { duration: 900, currentTime: 9 }), 'restricted user, item in another library')
      snap(this, await patch('restricted', `/api/me/progress/${B.libraryItem.id}`, { duration: 1800, currentTime: 9 }), 'restricted user, item with a hidden tag')
    })
  })

  describe('PATCH /api/me/progress/batch/update', () => {
    const batch = (as, json) => api.request('PATCH', '/api/me/progress/batch/update', { as, json })
    it('requires authentication', async function () {
      snap(this, await batch(undefined, []))
    })
    it('rejects empty payloads', async function () {
      snap(this, await batch('user', []), 'empty array')
      snap(this, await batch('user', {}), 'object without length')
      snap(this, await api.request('PATCH', '/api/me/progress/batch/update', { as: 'user' }), 'no body')
    })
    it('applies valid entries and skips invalid ones', async function () {
      this.ids = named()
      snap(
        this,
        await batch('user', [
          { libraryItemId: D.libraryItem.id, duration: 900, currentTime: 100 },
          { libraryItemId: 'unknown', currentTime: 1 },
          { libraryItemId: A.libraryItem.id, currentTime: 900 },
          { libraryItemId: pod.libraryItem.id, episodeId: fixedId(12), duration: 1800, currentTime: 10 },
          { libraryItemId: pod.libraryItem.id, episodeId: fixedId(99) }
        ]),
        'mixed batch'
      )
      snap(this, await get('/api/me/progress', 'user'), 'progress afterwards')
      snap(this, await batch('user', [{ libraryItemId: 'unknown' }, { libraryItemId: pod.libraryItem.id }]), 'only invalid entries (no event, still 200)')
    })
  })

  describe('DELETE /api/me/progress/:id', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('DELETE', '/api/me/progress/x'))
    })
    it('removes own progress by progress id only', async function () {
      this.ids = named()
      const progress = (await get('/api/me/progress', 'user')).body.mediaProgress
      const adminProgress = (await get('/api/me/progress', 'admin')).body.mediaProgress[0]
      const target = progress.find((p) => p.libraryItemId === C.libraryItem.id)
      snap(this, await api.request('DELETE', `/api/me/progress/${adminProgress.id}`, { as: 'user' }), 'progress of another user')
      snap(this, await api.request('DELETE', '/api/me/progress/unknown', { as: 'user' }), 'unknown id')
      snap(this, await api.request('DELETE', `/api/me/progress/${target.id}`, { as: 'user' }), 'delete')
      snap(this, await api.request('DELETE', `/api/me/progress/${target.id}`, { as: 'user' }), 'delete again')
      snap(this, await get('/api/me/progress', 'user'), 'progress afterwards')
      snap(this, await get('/api/me/progress', 'admin'), 'admin progress untouched')
    })
  })

  describe('GET /api/me/progress/:id/remove-from-continue-listening', () => {
    it('requires authentication', async function () {
      snap(this, await get('/api/me/progress/x/remove-from-continue-listening'))
    })
    it('hides a progress entry by progress id', async function () {
      this.ids = named()
      const progress = (await get('/api/me/progress', 'user')).body.mediaProgress
      const open = progress.find((p) => p.libraryItemId === A.libraryItem.id)
      const hidden = progress.find((p) => p.libraryItemId === C.libraryItem.id)
      const adminProgress = (await get('/api/me/progress', 'admin')).body.mediaProgress[0]
      snap(this, await get(`/api/me/progress/${open.id}/remove-from-continue-listening`, 'user'), 'hide')
      snap(this, await get(`/api/me/progress/${open.id}/remove-from-continue-listening`, 'user'), 'hide again (already hidden, no event)')
      snap(this, await get(`/api/me/progress/${hidden.id}/remove-from-continue-listening`, 'user'), 'already hidden before')
      snap(this, await get(`/api/me/progress/${adminProgress.id}/remove-from-continue-listening`, 'user'), 'progress of another user')
      snap(this, await get('/api/me/progress/unknown/remove-from-continue-listening', 'user'), 'unknown id')
      snap(this, await get('/api/me/items-in-progress', 'user'), 'items in progress afterwards')
    })
  })

  describe('bookmarks', () => {
    const send = (method, url, as, json) => api.request(method, url, { as, json })

    describe('GET /api/me/bookmarks', () => {
      it('requires authentication', async function () {
        snap(this, await get('/api/me/bookmarks'))
      })
      it('returns all bookmarks of the user', async function () {
        this.ids = named()
        snap(this, await get('/api/me/bookmarks', 'user'), 'user')
        snap(this, await get('/api/me/bookmarks', 'admin'), 'admin without bookmarks')
      })
    })

    describe('GET /api/me/bookmarks/:libraryItemId', () => {
      it('requires authentication', async function () {
        snap(this, await get(`/api/me/bookmarks/${A.libraryItem.id}`))
      })
      it('returns bookmarks of one item, 404 and 403 otherwise', async function () {
        this.ids = named()
        snap(this, await get(`/api/me/bookmarks/${A.libraryItem.id}`, 'user'), 'item A')
        snap(this, await get(`/api/me/bookmarks/${B.libraryItem.id}`, 'user'), 'item B')
        snap(this, await get(`/api/me/bookmarks/${C.libraryItem.id}`, 'user'), 'item without bookmarks')
        snap(this, await get(`/api/me/bookmarks/${pod.libraryItem.id}`, 'user'), 'podcast item')
        snap(this, await get('/api/me/bookmarks/unknown', 'user'), 'unknown item')
        snap(this, await get(`/api/me/bookmarks/${A.libraryItem.id}`, 'restricted'), 'restricted user can access A')
        snap(this, await get(`/api/me/bookmarks/${B.libraryItem.id}`, 'restricted'), 'restricted user, hidden tag')
        snap(this, await get(`/api/me/bookmarks/${D.libraryItem.id}`, 'restricted'), 'restricted user, other library')
      })
    })

    describe('POST /api/me/item/:id/bookmark', () => {
      it('requires authentication', async function () {
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, undefined, { time: 1, title: 'x' }))
      })
      it('validates access and body', async function () {
        this.ids = named()
        snap(this, await send('POST', '/api/me/item/unknown/bookmark', 'user', { time: 1, title: 'x' }), 'unknown item')
        snap(this, await send('POST', `/api/me/item/${D.libraryItem.id}/bookmark`, 'restricted', { time: 1, title: 'x' }), 'no access (library)')
        snap(this, await send('POST', `/api/me/item/${B.libraryItem.id}/bookmark`, 'restricted', { time: 1, title: 'x' }), 'no access (tag)')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { title: 'x' }), 'no time')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 'abc', title: 'x' }), 'time not a number')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: null, title: 'x' }), 'null time')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 5 }), 'no title')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 5, title: '' }), 'empty title')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 5, title: 7 }), 'title not a string')
        snap(this, await get('/api/me/bookmarks', 'user'), 'bookmarks unchanged')
      })
      it('creates bookmarks, and renames an existing one at the same time', async function () {
        this.ids = named()
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 120.5, title: 'New mark' }), 'create')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 120.5, title: 'Renamed' }), 'same time renames')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: '30', title: 'String time' }), 'numeric string time is stored as given')
        snap(this, await send('POST', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 0, title: 'Start' }), 'time 0')
        snap(this, await send('POST', `/api/me/item/${C.libraryItem.id}/bookmark`, 'guest', { time: 1, title: 'Guest mark' }), 'guest')
        snap(this, await get('/api/me/bookmarks', 'user'), 'bookmarks afterwards')
        snap(this, await get('/api/me/bookmarks', 'guest'), 'guest bookmarks')
      })
      it('creates bookmarks on podcast items', async function () {
        this.ids = named()
        snap(this, await send('POST', `/api/me/item/${pod.libraryItem.id}/bookmark`, 'user', { time: 3, title: 'Podcast mark' }))
      })
    })

    describe('PATCH /api/me/item/:id/bookmark', () => {
      it('requires authentication', async function () {
        snap(this, await send('PATCH', `/api/me/item/${A.libraryItem.id}/bookmark`, undefined, { time: 10, title: 'x' }))
      })
      it('validates access and body', async function () {
        this.ids = named()
        snap(this, await send('PATCH', '/api/me/item/unknown/bookmark', 'user', { time: 10, title: 'x' }), 'unknown item')
        snap(this, await send('PATCH', `/api/me/item/${D.libraryItem.id}/bookmark`, 'restricted', { time: 10, title: 'x' }), 'no access')
        snap(this, await send('PATCH', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { title: 'x' }), 'no time')
        snap(this, await send('PATCH', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 10 }), 'no title')
        snap(this, await send('PATCH', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 99, title: 'x' }), 'no bookmark at that time')
        snap(this, await send('PATCH', `/api/me/item/${C.libraryItem.id}/bookmark`, 'user', { time: 10, title: 'x' }), 'no bookmark on that item')
      })
      it('renames a bookmark', async function () {
        this.ids = named()
        snap(this, await send('PATCH', `/api/me/item/${A.libraryItem.id}/bookmark`, 'user', { time: 10, title: 'Renamed intro' }), 'rename')
        snap(this, await get(`/api/me/bookmarks/${A.libraryItem.id}`, 'user'), 'bookmarks afterwards')
      })
    })

    describe('DELETE /api/me/item/:id/bookmark/:time', () => {
      it('requires authentication', async function () {
        snap(this, await send('DELETE', `/api/me/item/${A.libraryItem.id}/bookmark/10`))
      })
      it('validates access and time', async function () {
        this.ids = named()
        snap(this, await send('DELETE', '/api/me/item/unknown/bookmark/10', 'user'), 'unknown item')
        snap(this, await send('DELETE', `/api/me/item/${D.libraryItem.id}/bookmark/10`, 'restricted'), 'no access')
        snap(this, await send('DELETE', `/api/me/item/${A.libraryItem.id}/bookmark/abc`, 'user'), 'time not a number')
        snap(this, await send('DELETE', `/api/me/item/${A.libraryItem.id}/bookmark/99`, 'user'), 'no bookmark at that time')
      })
      it('deletes a bookmark', async function () {
        this.ids = named()
        snap(this, await send('DELETE', `/api/me/item/${A.libraryItem.id}/bookmark/10`, 'user'), 'delete')
        snap(this, await send('DELETE', `/api/me/item/${A.libraryItem.id}/bookmark/10`, 'user'), 'delete again')
        snap(this, await get('/api/me/bookmarks', 'user'), 'bookmarks afterwards')
      })
    })
  })

  describe('GET /api/me/listening-sessions', () => {
    it('requires authentication', async function () {
      snap(this, await get('/api/me/listening-sessions'))
    })
    it('lists the own sessions newest first with paging', async function () {
      this.ids = named()
      snap(this, await get('/api/me/listening-sessions', 'user'), 'user')
      snap(this, await get('/api/me/listening-sessions?itemsPerPage=2&page=1', 'user'), 'page 1 of 2 per page')
      snap(this, await get('/api/me/listening-sessions?itemsPerPage=2&page=7', 'user'), 'past the end')
      snap(this, await get('/api/me/listening-sessions?itemsPerPage=0', 'user'), 'itemsPerPage 0 falls back to 10')
      snap(this, await get('/api/me/listening-sessions', 'admin'), 'admin')
      snap(this, await get('/api/me/listening-sessions', 'guest'), 'guest without sessions')
    })
  })

  describe('GET /api/me/item/listening-sessions/:libraryItemId/:episodeId?', () => {
    it('requires authentication', async function () {
      snap(this, await get(`/api/me/item/listening-sessions/${A.libraryItem.id}`))
    })
    it('lists sessions of one item', async function () {
      this.ids = named()
      snap(this, await get(`/api/me/item/listening-sessions/${A.libraryItem.id}`, 'user'), 'item A')
      snap(this, await get(`/api/me/item/listening-sessions/${A.libraryItem.id}?itemsPerPage=2&page=1`, 'user'), 'item A page 1')
      snap(this, await get(`/api/me/item/listening-sessions/${C.libraryItem.id}`, 'user'), 'item C')
      snap(this, await get(`/api/me/item/listening-sessions/${B.libraryItem.id}`, 'user'), 'item without sessions')
      snap(this, await get(`/api/me/item/listening-sessions/${A.libraryItem.id}`, 'admin'), 'admin only sees own sessions')
    })
    it('handles podcasts, unknown items and access', async function () {
      this.ids = named()
      snap(this, await get(`/api/me/item/listening-sessions/${pod.libraryItem.id}/${fixedId(11)}`, 'user'), 'podcast episode without sessions')
      snap(this, await get(`/api/me/item/listening-sessions/${pod.libraryItem.id}`, 'user'), 'podcast without episode id')
      snap(this, await get(`/api/me/item/listening-sessions/${pod.libraryItem.id}/${fixedId(99)}`, 'user'), 'podcast with unknown episode')
      snap(this, await get('/api/me/item/listening-sessions/unknown', 'user'), 'unknown item')
      snap(this, await get(`/api/me/item/listening-sessions/${D.libraryItem.id}`, 'restricted'), 'no library access')
      snap(this, await get(`/api/me/item/listening-sessions/${B.libraryItem.id}`, 'restricted'), 'no tag access')
      snap(this, await get(`/api/me/item/listening-sessions/${A.libraryItem.id}/${fixedId(11)}`, 'user'), 'book with an episode id of another item')
    })
  })

  describe('GET /api/me/listening-stats', () => {
    it('requires authentication', async function () {
      snap(this, await get('/api/me/listening-stats'))
    })
    it('aggregates listening time of the user', async function () {
      this.ids = named()
      snap(this, await get('/api/me/listening-stats', 'user'), 'user')
      snap(this, await get('/api/me/listening-stats', 'admin'), 'admin')
      snap(this, await get('/api/me/listening-stats', 'guest'), 'guest without sessions')
    })
  })

  describe('GET /api/me/items-in-progress', () => {
    it('requires authentication', async function () {
      snap(this, await get('/api/me/items-in-progress'))
    })
    it('returns unfinished items (books and podcast episodes) newest progress first', async function () {
      this.ids = named()
      snap(this, await get('/api/me/items-in-progress', 'user'), 'user')
      snap(this, await get('/api/me/items-in-progress', 'admin'), 'admin')
      snap(this, await get('/api/me/items-in-progress', 'guest'), 'guest without progress')
    })
    it('applies the limit parameter', async function () {
      this.ids = named()
      snap(this, await get('/api/me/items-in-progress?limit=2', 'user'), 'limit 2')
      snap(this, await get('/api/me/items-in-progress?limit=0', 'user'), 'limit 0 falls back to 25')
      snap(this, await get('/api/me/items-in-progress?limit=abc', 'user'), 'invalid limit falls back to 25')
    })
    it('does not filter by library access', async function () {
      this.ids = named()
      const patch = (id) => api.request('PATCH', `/api/me/progress/${id}`, { as: 'restricted', json: { duration: 900, currentTime: 9 } })
      expect((await patch(D.libraryItem.id)).status).to.equal(200)
      expect((await patch(B.libraryItem.id)).status).to.equal(200)
      api.emitted.splice(0)
      snap(this, await get('/api/me/items-in-progress', 'restricted'), 'restricted user sees items they cannot access')
    })
  })

  describe('series continue listening', () => {
    let series
    beforeEach(async () => {
      series = await Database.seriesModel.findOne({ where: { name: 'Saga' } })
    })
    it('requires authentication', async function () {
      snap(this, await get('/api/me/series/x/remove-from-continue-listening'), 'remove')
      snap(this, await get('/api/me/series/x/readd-to-continue-listening'), 'readd')
    })
    it('404s for unknown series', async function () {
      snap(this, await get('/api/me/series/unknown/remove-from-continue-listening', 'user'), 'remove')
      snap(this, await get('/api/me/series/unknown/readd-to-continue-listening', 'user'), 'readd')
    })
    it('hides and re-adds a series', async function () {
      this.ids = named([[series.id, '<series-Saga>']])
      snap(this, await get(`/api/me/series/${series.id}/readd-to-continue-listening`, 'user'), 'readd when not hidden (no event)')
      snap(this, await get(`/api/me/series/${series.id}/remove-from-continue-listening`, 'user'), 'remove')
      snap(this, await get(`/api/me/series/${series.id}/remove-from-continue-listening`, 'user'), 'remove again (no event)')
      snap(this, await get('/api/me', 'user'), 'user afterwards')
      snap(this, await get(`/api/me/series/${series.id}/remove-from-continue-listening`, 'guest'), 'guest remove')
      snap(this, await get(`/api/me/series/${series.id}/readd-to-continue-listening`, 'user'), 'readd')
      snap(this, await get('/api/me', 'user'), 'user after readd')
    })
  })

  describe('GET /api/me/stats/year/:year', () => {
    it('requires authentication', async function () {
      snap(this, await get('/api/me/stats/year/2024'))
    })
    it('rejects invalid years', async function () {
      for (const year of ['abc', '1999', '10000']) snap(this, await get(`/api/me/stats/year/${year}`, 'user'), year)
    })
    it('aggregates the year for the user', async function () {
      this.ids = named()
      snap(this, await get('/api/me/stats/year/2024', 'user'), 'user 2024')
      snap(this, await get('/api/me/stats/year/2024', 'admin'), 'admin 2024')
      snap(this, await get('/api/me/stats/year/2023', 'user'), 'user 2023 without data')
      snap(this, await get('/api/me/stats/year/2024', 'guest'), 'guest 2024 without data')
    })
  })

  describe('POST /api/me/ereader-devices', () => {
    const post = (as, json) => api.request('POST', '/api/me/ereader-devices', { as, json })
    const device = (name, userIds) => ({ name, email: `${name}@example.com`, availabilityOption: 'specificUsers', users: userIds })
    it('requires authentication', async function () {
      snap(this, await post(undefined, { ereaderDevices: [] }))
    })
    it('validates the payload', async function () {
      this.ids = named()
      snap(this, await post('user', {}), 'no devices')
      snap(this, await post('user', { ereaderDevices: 'x' }), 'devices not an array')
      snap(this, await post('user', { ereaderDevices: [{ name: 'a' }] }), 'no email')
      snap(this, await post('user', { ereaderDevices: [{ email: 'a@example.com' }] }), 'no name')
      snap(this, await post('user', { ereaderDevices: [{ name: 'a', email: 'a@example.com', availabilityOption: 'adminOrUp' }] }), 'wrong availability')
      snap(this, await post('user', { ereaderDevices: [device('a', [users.admin.id])] }), 'other user')
      snap(this, await post('user', { ereaderDevices: [device('a', [users.user.id, users.admin.id])] }), 'two users')
      snap(this, await post('user', { ereaderDevices: [device('a', [users.user.id]), device('a', [users.user.id])] }), 'duplicate names in payload')
    })
    it('stores the devices of the user next to those of others', async function () {
      this.ids = named()
      Database.emailSettings.update({ ereaderDevices: [{ name: 'Shared', email: 'shared@example.com', availabilityOption: 'adminOrUp' }] })
      snap(this, await post('user', { ereaderDevices: [device('Kindle', [users.user.id])] }), 'user adds a device')
      snap(this, await post('admin', { ereaderDevices: [device('Admin Kobo', [users.admin.id])] }), 'admin adds a device')
      snap(this, await post('admin', { ereaderDevices: [device('Kindle', [users.admin.id])] }), 'admin duplicate name of another user (devices of others still count for the duplicate check)')
      snap(this, await post('admin', { ereaderDevices: [device('Shared', [users.admin.id])] }), 'admin duplicate name of a shared device')
      snap(this, await post('user', { ereaderDevices: [device('Kindle', [users.user.id]), device('Second', [users.user.id])] }), 'user replaces own devices with two')
      snap(this, await post('user', { ereaderDevices: [] }), 'user removes own devices')
      snap(this, await get('/api/me', 'user'), 'user afterwards')
      expect(Database.emailSettings.ereaderDevices.map((d) => d.name).sort()).to.deep.equal(['Admin Kobo', 'Shared'])
    })
  })

  describe('PATCH /api/me/password', () => {
    const patch = (as, json, headers) => api.request('PATCH', '/api/me/password', { as, json, headers })
    let pwUser
    beforeEach(async () => {
      pwUser = await createUser({ username: 'pwuser', type: 'user', password: 'old-password' })
    })
    it('requires authentication', async function () {
      snap(this, await patch(undefined, { password: 'a', newPassword: 'b' }))
    })
    it('rejects guests and invalid payloads', async function () {
      this.ids = named()
      snap(this, await patch('guest', { password: 'hash', newPassword: 'b' }), 'guest')
      snap(this, await patch('pwuser', {}), 'empty body')
      snap(this, await patch('pwuser', { password: 5, newPassword: 'b' }), 'password not a string')
      snap(this, await patch('pwuser', { password: 'old-password' }), 'no new password')
    })
    it('rejects a wrong current password and an empty new password for non-root users', async function () {
      this.ids = named()
      const before = (await Database.userModel.findByPk(pwUser.id)).pash
      snap(this, await patch('pwuser', { password: 'wrong', newPassword: 'new-password' }), 'wrong password')
      snap(this, await patch('pwuser', { password: 'old-password', newPassword: '' }), 'empty new password')
      snap(this, await patch('pwuser', { password: 'old-password', newPassword: null }), 'null new password')
      expect((await Database.userModel.findByPk(pwUser.id)).pash).to.equal(before)
    })
    it('changes the password and invalidates all login sessions', async function () {
      this.ids = named()
      await createAuthSession(pwUser, { refreshToken: 'pw-1' })
      await createAuthSession(pwUser, { refreshToken: 'pw-2' })
      const before = (await Database.userModel.findByPk(pwUser.id)).pash
      snap(this, await patch('pwuser', { password: 'old-password', newPassword: 'new-password' }), 'change')
      const after = (await Database.userModel.findByPk(pwUser.id)).pash
      expect(after).to.not.equal(before)
      expect(after).to.match(/^\$2[aby]\$/)
      expect(await Database.sessionModel.count({ where: { userId: pwUser.id } })).to.equal(0)
      snap(this, await patch('pwuser', { password: 'old-password', newPassword: 'again' }), 'old password no longer works')
    })
    it('with a refresh token keeps the current session and returns new tokens', async function () {
      this.ids = named()
      await createAuthSession(pwUser, { refreshToken: 'pw-current' })
      await createAuthSession(pwUser, { refreshToken: 'pw-other' })
      snap(this, await patch('pwuser', { password: 'old-password', newPassword: 'new-password' }, { 'x-refresh-token': 'pw-current' }), 'change with refresh token')
      const sessions = await Database.sessionModel.findAll({ where: { userId: pwUser.id } })
      expect(sessions).to.have.length(1)
      expect(sessions[0].refreshToken).to.not.equal('pw-current')
    })
    it('with an unknown refresh token invalidates everything and returns only a status', async function () {
      this.ids = named()
      await createAuthSession(pwUser, { refreshToken: 'pw-other' })
      snap(this, await patch('pwuser', { password: 'old-password', newPassword: 'new-password' }, { 'x-refresh-token': 'not-a-session' }), 'unknown refresh token')
      expect(await Database.sessionModel.count({ where: { userId: pwUser.id } })).to.equal(0)
    })
    it('lets a root user without password set one and clear it again', async function () {
      this.ids = named()
      const rootless = await createUser({ username: 'rootless', type: 'root', password: '' })
      snap(this, await patch('rootless', { password: null, newPassword: 'first-password' }), 'set a password from empty')
      snap(this, await patch('rootless', { password: 'first-password', newPassword: null }), 'clear the password (root only)')
      expect((await Database.userModel.findByPk(rootless.id)).pash).to.equal('')
    })
  })
})
