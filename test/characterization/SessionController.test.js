const fs = require('fs')
const path = require('path')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const Database = require('../../server/Database')
const ShareManager = require('../../server/managers/ShareManager')
const PublicRouter = require('../../server/routers/PublicRouter')
const { createLibrary, createBook } = require('./helpers/seed-library')
const { createPlaybackSession, audioBookExtra } = require('./helpers/seed-users-extra')
const { recordingFake, openSession } = require('./helpers/seed-podcast-extra')

describe('SessionController (characterization)', () => {
  let api, users, lf, book, item, manager, openSessions

  // the fake playback session manager records what each route asks of it
  const makeManager = () => {
    openSessions = []
    return recordingFake(
      {
        getSession: (id) => openSessions.find((s) => s.id === id),
        removeSession: async (id) => {
          openSessions = openSessions.filter((s) => s.id !== id)
        },
        syncSessionRequest: (user, session, body, res) => res.json({ fake: 'syncSessionRequest' }),
        closeSessionRequest: (user, session, body, res) => res.json({ fake: 'closeSessionRequest' }),
        syncLocalSessionRequest: (req, res) => res.json({ fake: 'syncLocalSessionRequest' }),
        syncLocalSessionsRequest: (req, res) => res.json({ fake: 'syncLocalSessionsRequest' })
      },
      { get sessions() { return openSessions } }
    )
  }
  // manager calls with the express objects reduced to the facts that matter
  const managerCalls = () =>
    manager.calls.splice(0).map(({ method, args }) => ({
      method,
      args: args.map((a) => {
        if (a && a.headers && a.body !== undefined) return { request: { user: a.user?.username, body: a.body } }
        if (a && typeof a.json === 'function' && typeof a.status === 'function') return '<res>'
        if (a && a.username && a.permissions) return { user: a.username }
        if (a && a.id && a.userId) return { session: a.id }
        return a
      })
    }))

  beforeEach(async () => {
    manager = makeManager()
    api = await startApi({ managers: { playbackSessionManager: manager } })
    users = await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    const created = await createBook(lf, { title: 'Listened Book', authors: ['Ann Author'], extra: audioBookExtra({ duration: 3600 }) })
    book = created.book
    item = created.libraryItem
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const dbSession = (user, at, o = {}) => createPlaybackSession({ user, libraryItem: item, book, library: lf.library }, { at, ...o })

  describe('GET /api/sessions', () => {
    let s
    beforeEach(async () => {
      s = []
      s.push(await dbSession(users.admin, '2024-01-01T10:00:00Z', { title: 'Zeta', timeListening: 30, currentTime: 100 }))
      s.push(await dbSession(users.user, '2024-01-02T10:00:00Z', { title: 'Alpha', timeListening: 20, currentTime: 300 }))
      s.push(await dbSession(users.admin, '2024-01-03T10:00:00Z', { title: 'Mid', timeListening: 10, currentTime: 200 }))
      s.push(await dbSession(users.guest, '2024-01-04T10:00:00Z', { title: 'Beta', timeListening: 40, currentTime: 400 }))
      s.push(await dbSession(users.root, '2024-01-05T10:00:00Z', { title: 'Omega', timeListening: 50, currentTime: 500 }))
      await Database.deviceModel.create({ deviceId: 'dev-1', clientName: 'Test Client', clientVersion: '1.0', ipAddress: '10.0.0.1', extraData: { osName: 'Linux' }, userId: users.admin.id }).then((d) => s[0].update({ deviceId: d.id }, { silent: true }))
    })
    const list = (q = '', as = 'admin') => api.request('GET', `/api/sessions${q}`, { as })

    it('requires authentication and an admin', async function () {
      this.ids = new Map()
      snap(this, await api.request('GET', '/api/sessions'), 'unauthenticated')
      snap(this, await list('', 'user'), 'user')
      snap(this, await list('', 'guest'), 'guest')
    })
    it('lists the first page for admin and root', async function () {
      this.ids = new Map()
      snap(this, await list('', 'admin'), 'admin')
      snap(this, await list('', 'root'), 'root')
    })
    it('sorts, filters and paginates', async function () {
      this.ids = new Map()
      snap(this, await list('?sort=displayTitle'), 'sort displayTitle asc')
      snap(this, await list('?sort=displayTitle&desc=1'), 'sort displayTitle desc')
      snap(this, await list('?sort=timeListening&desc=1&itemsPerPage=2'), 'sort timeListening desc, 2 per page')
      snap(this, await list('?sort=currentTime&itemsPerPage=2&page=1'), 'page 1')
      snap(this, await list('?sort=currentTime&itemsPerPage=2&page=2'), 'last page')
      snap(this, await list('?sort=currentTime&itemsPerPage=2&page=9'), 'page beyond the end')
      snap(this, await list(`?user=${users.admin.id}`), 'user filter')
      snap(this, await list('?user=not-a-uuid'), 'invalid user filter is ignored')
    })
    it('falls back for invalid query values', async function () {
      this.ids = new Map()
      snap(this, await list('?sort=bogus'), 'invalid sort')
      snap(this, await list('?itemsPerPage=0'), 'itemsPerPage 0')
      snap(this, await list('?itemsPerPage=-3'), 'negative itemsPerPage')
      snap(this, await list('?itemsPerPage=abc&page=abc'), 'non numeric paging')
      snap(this, await list('?page=-1&itemsPerPage=2'), 'negative page')
    })
  })

  describe('GET /api/sessions/open', () => {
    it('requires an admin and lists open sessions with their user and share sessions', async function () {
      this.ids = new Map()
      openSessions.push(openSession({ id: '11111111-1111-4111-8111-111111111111', userId: users.user.id, libraryId: lf.library.id, libraryItemId: item.id, bookId: book.id }))
      openSessions.push(openSession({ id: '22222222-2222-4222-8222-222222222222', userId: '99999999-9999-4999-8999-999999999999', libraryId: lf.library.id, libraryItemId: item.id, bookId: book.id, title: 'Orphan' }))
      const savedShare = ShareManager.openSharePlaybackSessions
      ShareManager.openSharePlaybackSessions = [openSession({ id: '33333333-3333-4333-8333-333333333333', userId: null, libraryId: lf.library.id, libraryItemId: item.id, bookId: book.id, title: 'Shared' })]
      try {
        snap(this, await api.request('GET', '/api/sessions/open'), 'unauthenticated')
        snap(this, await api.request('GET', '/api/sessions/open', { as: 'user' }), 'user')
        snap(this, await api.request('GET', '/api/sessions/open', { as: 'admin' }), 'admin')
        snap(this, await api.request('GET', '/api/sessions/open', { as: 'root' }), 'root')
        openSessions.length = 0
        ShareManager.openSharePlaybackSessions = []
        snap(this, await api.request('GET', '/api/sessions/open', { as: 'admin' }), 'none open')
      } finally {
        ShareManager.openSharePlaybackSessions = savedShare
      }
    })
  })

  describe('open session routes (/api/session/:id)', () => {
    const SID = '11111111-1111-4111-8111-111111111111'
    beforeEach(() => {
      const audioTracks = [{ index: 1, startOffset: 0, duration: 3600, title: 'a.mp3', contentUrl: `/public/session/${SID}/track/1`, mimeType: 'audio/mpeg', metadata: null }]
      openSessions.push(openSession({ id: SID, userId: users.user.id, libraryId: lf.library.id, libraryItemId: item.id, bookId: book.id, audioTracks }))
    })

    it('GET returns the open session with its library item', async function () {
      this.ids = new Map([[SID, '<session>']])
      snap(this, await api.request('GET', `/api/session/${SID}`), 'unauthenticated')
      snap(this, await api.request('GET', `/api/session/${SID}`, { as: 'user' }), 'owner')
      snap(this, await api.request('GET', `/api/session/${SID}`, { as: 'admin' }), 'admin may read others')
      snap(this, await api.request('GET', `/api/session/${SID}`, { as: 'guest' }), 'other non-admin')
      snap(this, await api.request('GET', '/api/session/nope', { as: 'user' }), 'unknown id')
    })
    it('POST sync passes the body to the manager', async function () {
      this.ids = new Map([[SID, '<session>']])
      const body = { currentTime: 42, timeListened: 7, duration: 3600 }
      snap(this, await api.request('POST', `/api/session/${SID}/sync`, { json: body }), 'unauthenticated', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/sync`, { as: 'user', json: body }), 'owner', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/sync`, { as: 'admin', json: body }), 'admin on another user session', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/sync`, { as: 'guest', json: body }), 'other non-admin', { calls: managerCalls() })
      snap(this, await api.request('POST', '/api/session/nope/sync', { as: 'user', json: body }), 'unknown id', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/sync`, { as: 'user' }), 'no body', { calls: managerCalls() })
    })
    it('POST close passes the body, or null for an empty body', async function () {
      this.ids = new Map([[SID, '<session>']])
      const body = { currentTime: 99, timeListened: 3, duration: 3600 }
      snap(this, await api.request('POST', `/api/session/${SID}/close`, { json: body }), 'unauthenticated', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/close`, { as: 'user', json: body }), 'owner with sync data', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/close`, { as: 'user', json: {} }), 'owner with empty body', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/close`, { as: 'user' }), 'owner without body', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/close`, { as: 'root', json: body }), 'root', { calls: managerCalls() })
      snap(this, await api.request('POST', `/api/session/${SID}/close`, { as: 'guest', json: body }), 'other non-admin', { calls: managerCalls() })
      snap(this, await api.request('POST', '/api/session/nope/close', { as: 'user', json: body }), 'unknown id', { calls: managerCalls() })
    })
  })

  describe('POST /api/session/local and /api/session/local-all', () => {
    it('hands the request to the manager', async function () {
      snap(this, await api.request('POST', '/api/session/local', { json: {} }), 'local unauthenticated', { calls: managerCalls() })
      snap(this, await api.request('POST', '/api/session/local', { as: 'user', json: { id: 'local_1', libraryItemId: item.id, currentTime: 12 } }), 'local', { calls: managerCalls() })
      snap(this, await api.request('POST', '/api/session/local', { as: 'guest' }), 'local guest without body', { calls: managerCalls() })
      snap(this, await api.request('POST', '/api/session/local-all', { json: {} }), 'local-all unauthenticated', { calls: managerCalls() })
      snap(this, await api.request('POST', '/api/session/local-all', { as: 'admin', json: { sessions: [{ id: 'local_1' }, { id: 'local_2' }], deviceInfo: { deviceId: 'd' } } }), 'local-all', { calls: managerCalls() })
    })
  })

  describe('DELETE /api/sessions/:id', () => {
    it('deletes as root only, closing open sessions first', async function () {
      const a = await dbSession(users.user, '2024-02-01T10:00:00Z', { title: 'A' })
      const b = await dbSession(users.admin, '2024-02-02T10:00:00Z', { title: 'B' })
      openSessions.push(openSession({ id: b.id, userId: users.admin.id, libraryId: lf.library.id, libraryItemId: item.id, bookId: book.id }))
      this.ids = new Map([[a.id, '<A>'], [b.id, '<B>']])
      const del = (id, as) => api.request('DELETE', `/api/sessions/${id}`, { as })
      snap(this, await del(a.id), 'unauthenticated')
      snap(this, await del(a.id, 'admin'), 'admin', { calls: managerCalls() })
      snap(this, await del(a.id, 'user'), 'owner user', { calls: managerCalls() })
      snap(this, await del('not-a-session', 'root'), 'unknown id')
      snap(this, await del(a.id, 'root'), 'root deletes closed session', { calls: managerCalls() })
      snap(this, await del(a.id, 'root'), 'delete again')
      snap(this, await del(b.id, 'root'), 'root deletes an open session', { calls: managerCalls(), openLeft: openSessions.length })
      snap(this, { rows: await Database.playbackSessionModel.count() }, 'rows left')
    })
  })

  describe('POST /api/sessions/batch/delete', () => {
    it('validates, requires an admin and deletes in bulk', async function () {
      const ids = []
      for (const [i, user] of [users.user, users.admin, users.guest, users.root].entries()) ids.push((await dbSession(user, `2024-03-0${i + 1}T10:00:00Z`)).id)
      openSessions.push(openSession({ id: ids[1], userId: users.admin.id, libraryId: lf.library.id, libraryItemId: item.id, bookId: book.id }))
      this.ids = new Map(ids.map((id, i) => [id, `<s${i}>`]))
      const del = (sessions, as = 'admin') => api.request('POST', '/api/sessions/batch/delete', { as, json: { sessions } })
      snap(this, await api.request('POST', '/api/sessions/batch/delete', { json: { sessions: ids } }), 'unauthenticated')
      snap(this, await del(ids, 'user'), 'user')
      snap(this, await del(ids, 'guest'), 'guest')
      snap(this, await del(undefined), 'no sessions')
      snap(this, await del([]), 'empty')
      snap(this, await del('x'), 'not an array')
      snap(this, await del([ids[0], 'nope']), 'invalid id (nothing deleted)')
      snap(this, { rows: await Database.playbackSessionModel.count() }, 'rows before')
      snap(this, await del([ids[0], ids[1], '99999999-9999-4999-8999-999999999999']), 'admin deletes two and an unknown id', { calls: managerCalls(), openLeft: openSessions.length })
      snap(this, { rows: await Database.playbackSessionModel.count() }, 'rows after admin')
      snap(this, await del([ids[2], ids[3]], 'root'), 'root deletes the rest', { calls: managerCalls() })
      snap(this, { rows: await Database.playbackSessionModel.count() }, 'rows after root')
    })
  })

  describe('GET /public/session/:id/track/:index', () => {
    const SID = '11111111-1111-4111-8111-111111111111'
    let trackPath
    const track = (o = {}) => ({ index: 1, contentUrl: `/public/session/${SID}/track/1`, metadata: { path: trackPath }, ...o })
    const getTrack = async (url) => {
      const res = await fetch(api.base + url, { redirect: 'manual' })
      const text = await res.text()
      return { status: res.status, headers: { 'content-type': res.headers.get('content-type'), location: res.headers.get('location'), 'x-accel-redirect': res.headers.get('x-accel-redirect') }, body: text }
    }
    beforeEach(() => {
      api.app.use('/public', new PublicRouter(manager).router)
      trackPath = path.join(api.tmp, 'track.m4b')
      fs.writeFileSync(trackPath, 'fake audio bytes')
    })
    const open = (o = {}) => {
      openSessions.length = 0
      openSessions.push(openSession({ id: SID, userId: users.user.id, libraryId: lf.library.id, libraryItemId: item.id, bookId: book.id, audioTracks: [track(), track({ index: 2, metadata: {} })], ...o }))
    }

    it('validates the session and track', async function () {
      this.ids = new Map([[SID, '<session>']])
      open()
      snap(this, await getTrack(`/public/session/${SID}/track/abc`), 'invalid index')
      snap(this, await getTrack('/public/session/nope/track/1'), 'unknown session')
      snap(this, await getTrack(`/public/session/${SID}/track/7`), 'unknown track')
      snap(this, await getTrack(`/public/session/${SID}/track/2`), 'track without a file path')
      snap(this, await getTrack(`/public/session/${SID}/track/0`), 'index 0 for a book')
    })
    it('streams the file without authentication, with the audio mime type', async function () {
      this.ids = new Map([[SID, '<session>']])
      open()
      snap(this, await getTrack(`/public/session/${SID}/track/1`), 'book track')
      open({ mediaType: 'podcast', bookId: null, episodeId: 'e0000000-0000-4000-8000-000000000001', audioTracks: [track({ index: null })] })
      snap(this, await getTrack(`/public/session/${SID}/track/0`), 'podcast track with null index requested as 0')
    })
    it('redirects transcode sessions and supports X-Accel', async function () {
      this.ids = new Map([[SID, '<session>']])
      open({ playMethod: 2, audioTracks: [track({ contentUrl: '/hls/some-stream/output-0.ts' })] })
      snap(this, await getTrack(`/public/session/${SID}/track/1`), 'transcode redirect')
      open()
      global.XAccel = '/audiobooks'
      snap(this, await getTrack(`/public/session/${SID}/track/1`), 'x-accel')
      global.XAccel = ''
    })
  })
})
