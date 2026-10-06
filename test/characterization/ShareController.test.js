const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createFilePodcast, waitFor, PNG_1X1 } = require('./helpers/seed-items-extra')
const { libraryFolderPath, visibleFileBook, resetShareManager, mountPublicRouter } = require('./helpers/seed-delivery-extra')
const ShareManager = require('../../server/managers/ShareManager')
const Database = require('../../server/Database')
const { version } = require('../../package.json')

// ApiRouter routes (create / delete a share) go through api.request with the stub login. The PUBLIC routes are mounted by
// PublicRouter, which the harness does not mount: mountPublicRouter() puts the real PublicRouter on api.app at /public
// (no login), and `pub()` below calls it with plain fetch so cookies (share_session_id) and binary bodies can be handled.
// ShareManager is a module singleton: resetShareManager() clears its open shares/sessions between tests.
describe('ShareController (characterization)', () => {
  let api, users, lf, book, fileBook, podcast, hiddenBook

  beforeEach(async () => {
    resetShareManager()
    api = await startApi()
    users = await api.seed.users()
    mountPublicRouter(api)
    lf = await createLibrary({ name: 'Books', path: libraryFolderPath(api) })
    // createLibrary leaves settings NULL, but the share route reads library.settings.coverAspectRatio (real libraries always have them)
    await lf.library.update({ settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    const podLf = await createLibrary({ name: 'Pods', mediaType: 'podcast', path: libraryFolderPath(api, 'pods') })
    book = await visibleFileBook(lf, { title: 'Shared Book', n: 1, authors: ['Ann Author'], cover: 'cover.png', images: [{ filename: 'cover.png', ino: '190' }] })
    fileBook = await visibleFileBook(lf, { title: 'Single File', n: 2, isFile: true })
    hiddenBook = await visibleFileBook(lf, { title: 'Another Book', n: 3 })
    podcast = await createFilePodcast(podLf, { title: 'Pod', episodes: [{ title: 'Ep 1', filename: 'ep1.mp3', ino: '501' }] })
  })

  afterEach(async () => {
    resetShareManager()
    await api.stop()
  })

  // wall-clock (session date / day of week) and release version values are masked
  const jsonMask = (v) =>
    JSON.parse(JSON.stringify(v).split(`"${version}"`).join('"<version>"'), (k, val) => (k === 'date' && typeof val === 'string' ? '<date>' : k === 'dayOfWeek' && typeof val === 'string' ? '<day>' : val))
  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, jsonMask({ res, emitted, ...extra }), { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }

  /** Public (no login) request. Returns status, selected headers, the share_session_id set by the response and the body. */
  async function pub(method, url, { cookie, json } = {}) {
    const headers = {}
    if (cookie) headers.cookie = `share_session_id=${cookie}`
    let body
    if (json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(json)
    }
    const res = await fetch(api.base + url, { method, headers, body, redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    const type = res.headers.get('content-type') || ''
    let parsed
    if (type.includes('json')) parsed = JSON.parse(buf.toString())
    else if (type.startsWith('image/') || buf.subarray(0, 2).toString() === 'PK') parsed = { bytes: buf.length, startsWith: buf.subarray(0, 2).toString('latin1') === 'PK' ? 'PK' : undefined }
    else parsed = buf.toString()
    const setCookie = res.headers.get('set-cookie')
    const cookies = {}
    if (setCookie) {
      const [pair, ...attrs] = setCookie.split('; ')
      const [name, value] = pair.split('=')
      cookies.name = name
      cookies.value = value
      cookies.attributes = attrs.filter((a) => !a.startsWith('Expires='))
      cookies.hasExpires = attrs.some((a) => a.startsWith('Expires='))
    }
    const out = { status: res.status, headers: {}, body: parsed }
    for (const h of ['content-type', 'content-disposition', 'x-accel-redirect']) if (res.headers.get(h)) out.headers[h] = res.headers.get(h)
    if (setCookie) out.setCookie = { name: cookies.name, value: cookies.value === '' ? '' : '<session-id>', attributes: cookies.attributes, hasExpires: cookies.hasExpires }
    return { ...out, sessionId: cookies.value }
  }
  // snapshot a public response without the raw session id
  const pubSnap = (ctx, res, label, extra) => {
    const { sessionId, ...rest } = res
    snap(ctx, rest, label, extra)
  }

  const createShare = (as, json) => api.request('POST', '/api/share/mediaitem', { as, json })
  const HOUR = 3600 * 1000
  // create a share as setup (its share_open emission is dropped)
  const share = async (over = {}) => {
    const res = await createShare('admin', { slug: 'my-book', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: 0, isDownloadable: false, ...over })
    api.emitted.splice(0)
    return res.body
  }

  describe('POST /api/share/mediaitem', () => {
    it('requires authentication and admin', async function () {
      this.ids = new Map()
      const json = { slug: 'x', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: 0 }
      snap(this, await api.request('POST', '/api/share/mediaitem', { json }), 'no auth')
      snap(this, await createShare('user', json), 'user')
      snap(this, await createShare('guest', json), 'guest')
      matchSnapshot(this, { rows: await Database.mediaItemShareModel.count(), open: ShareManager.openMediaItemShares.length }, { label: 'nothing created' })
    })
    it('validates the body', async function () {
      this.ids = new Map()
      const ok = { slug: 'x', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: 0 }
      snap(this, await createShare('admin', {}), 'empty body')
      snap(this, await createShare('admin', { ...ok, slug: '   ' }), 'blank slug')
      snap(this, await createShare('admin', { ...ok, slug: 5 }), 'numeric slug')
      snap(this, await createShare('admin', { ...ok, mediaItemType: undefined }), 'no type')
      snap(this, await createShare('admin', { ...ok, mediaItemId: 5 }), 'numeric id')
      snap(this, await createShare('admin', { ...ok, expiresAt: undefined }), 'expiresAt missing is invalid')
      snap(this, await createShare('admin', { ...ok, expiresAt: null }), 'expiresAt null')
      snap(this, await createShare('admin', { ...ok, expiresAt: 'soon' }), 'expiresAt NaN')
      snap(this, await createShare('admin', { ...ok, expiresAt: -1 }), 'expiresAt negative')
      snap(this, await createShare('admin', { ...ok, mediaItemType: 'libraryItem' }), 'invalid type')
      snap(this, await createShare('admin', { ...ok, mediaItemId: 'does-not-exist' }), 'unknown media item')
      snap(this, await createShare('admin', { ...ok, mediaItemType: 'podcastEpisode' }), 'book id used as episode')
      matchSnapshot(this, { rows: await Database.mediaItemShareModel.count() }, { label: 'nothing created' })
    })
    it('creates a permanent book share, emits share_open and stores the row', async function () {
      this.ids = new Map([[book.book.id, '<book>'], [users.admin.id, '<admin>']])
      snap(this, await createShare('admin', { slug: 'my-book', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: 0, isDownloadable: true }), 'create')
      const row = await Database.mediaItemShareModel.findOne()
      matchSnapshot(this, { slug: row.slug, mediaItemType: row.mediaItemType, expiresAt: row.expiresAt, isDownloadable: row.isDownloadable, userId: row.userId, pash: row.pash, extraData: row.extraData }, { label: 'db row', ids: this.ids })
      expect(ShareManager.openMediaItemShares).to.have.length(1)
      expect(ShareManager.openMediaItemShares[0].timeout).to.equal(undefined)
    })
    it('schedules an expiring share (root) and defaults isDownloadable to null', async function () {
      this.ids = new Map([[book.book.id, '<book>']])
      snap(this, await createShare('root', { slug: 'expiring', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: Date.now() + HOUR }), 'create')
      expect(ShareManager.openMediaItemShares[0].timeout).to.not.equal(undefined)
    })
    it('creates a podcast episode share', async function () {
      this.ids = new Map([[podcast.episodes[0].id, '<episode>']])
      snap(this, await createShare('admin', { slug: 'episode', mediaItemType: 'podcastEpisode', mediaItemId: podcast.episodes[0].id, expiresAt: 0 }), 'create')
    })
    it('rejects duplicate item or slug with 409', async function () {
      this.ids = new Map([[book.book.id, '<book>']])
      await share()
      api.emitted.splice(0)
      snap(this, await createShare('admin', { slug: 'other', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: 0 }), 'item already shared')
      snap(this, await createShare('admin', { slug: 'my-book', mediaItemType: 'book', mediaItemId: hiddenBook.book.id, expiresAt: 0 }), 'slug in use')
      snap(this, await createShare('admin', { slug: 'my-book', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: 0 }), 'both')
    })
    it('returns 201 for an already expired share but it is destroyed at once and never reachable', async function () {
      this.ids = new Map([[book.book.id, '<book>']])
      snap(this, await createShare('admin', { slug: 'past', mediaItemType: 'book', mediaItemId: book.book.id, expiresAt: 1000 }), 'create with past expiry')
      for (let i = 0; i < 200 && (await Database.mediaItemShareModel.count()) > 0; i++) await new Promise((r) => setTimeout(r, 5)) // destroy is not awaited by the manager
      matchSnapshot(this, { rows: await Database.mediaItemShareModel.count(), open: ShareManager.openMediaItemShares.length }, { label: 'state' })
      pubSnap(this, await pub('GET', '/public/share/past'), 'public get')
    })
  })

  describe('DELETE /api/share/mediaitem/:id', () => {
    it('requires authentication and admin', async function () {
      this.ids = new Map()
      const created = await share()
      api.emitted.splice(0)
      snap(this, await api.request('DELETE', `/api/share/mediaitem/${created.id}`), 'no auth')
      snap(this, await api.request('DELETE', `/api/share/mediaitem/${created.id}`, { as: 'user' }), 'user')
      snap(this, await api.request('DELETE', `/api/share/mediaitem/${created.id}`, { as: 'guest' }), 'guest')
      expect(await Database.mediaItemShareModel.count()).to.equal(1)
    })
    it('deletes as admin, emits share_closed, drops sessions and 404s afterwards', async function () {
      this.ids = new Map()
      const created = await share({ expiresAt: Date.now() + HOUR })
      const first = await pub('GET', '/public/share/my-book')
      expect(ShareManager.openSharePlaybackSessions).to.have.length(1)
      api.emitted.splice(0)
      snap(this, await api.request('DELETE', `/api/share/mediaitem/${created.id}`, { as: 'admin' }), 'delete')
      matchSnapshot(this, { rows: await Database.mediaItemShareModel.count(), open: ShareManager.openMediaItemShares.length, sessions: ShareManager.openSharePlaybackSessions.length }, { label: 'state' })
      snap(this, await api.request('DELETE', `/api/share/mediaitem/${created.id}`, { as: 'admin' }), 'delete again')
      snap(this, await api.request('DELETE', '/api/share/mediaitem/unknown', { as: 'root' }), 'unknown id')
      pubSnap(this, await pub('GET', '/public/share/my-book', { cookie: first.sessionId }), 'public get after delete')
    })
  })

  describe('GET /public/share/:slug', () => {
    it('404s for an unknown slug', async function () {
      pubSnap(this, await pub('GET', '/public/share/nope'))
    })
    it('opens a playback session, sets the cookie and returns the share with tracks', async function () {
      this.ids = new Map([[book.book.id, '<book>'], [book.libraryItem.id, '<item>']])
      await share({ isDownloadable: true })
      const res = await pub('GET', '/public/share/my-book')
      pubSnap(this, res, 'first request')
      expect(ShareManager.openSharePlaybackSessions).to.have.length(1)
      // second request with the cookie returns the cached session, no new session
      pubSnap(this, await pub('GET', '/public/share/my-book', { cookie: res.sessionId }), 'second request with cookie')
      expect(ShareManager.openSharePlaybackSessions).to.have.length(1)
    })
    it('honours the ?t start time', async function () {
      this.ids = new Map([[book.book.id, '<book>'], [book.libraryItem.id, '<item>']])
      await share()
      const first = await pub('GET', '/public/share/my-book?t=45')
      pubSnap(this, first, 't=45 on a new session')
      pubSnap(this, await pub('GET', '/public/share/my-book?t=20', { cookie: first.sessionId }), 't=20 overrides cached time')
      pubSnap(this, await pub('GET', '/public/share/my-book?t=500', { cookie: first.sessionId }), 't beyond duration keeps cached time')
      pubSnap(this, await pub('GET', '/public/share/my-book?t=-5', { cookie: first.sessionId }), 'negative t ignored')
      api.emitted.splice(0)
      pubSnap(this, await pub('GET', '/public/share/my-book?t=500'), 't beyond duration on a new session starts at 0')
    })
    it('switching to another share closes the old session', async function () {
      this.ids = new Map([[book.book.id, '<book>'], [hiddenBook.book.id, '<other>']])
      await share()
      await share({ slug: 'other-book', mediaItemId: hiddenBook.book.id })
      const first = await pub('GET', '/public/share/my-book')
      const second = await pub('GET', '/public/share/other-book', { cookie: first.sessionId })
      pubSnap(this, second, 'other share with same cookie')
      matchSnapshot(this, { sessions: ShareManager.openSharePlaybackSessions.map((s) => ({ title: s.displayTitle, sameShareSessionId: s.shareSessionId === first.sessionId })) }, { label: 'sessions' })
    })
    it('replaces an unknown or invalid cookie (the invalid value is reused as the session id)', async function () {
      this.ids = new Map([[book.book.id, '<book>']])
      await share()
      pubSnap(this, await pub('GET', '/public/share/my-book', { cookie: '11111111-1111-4111-8111-111111111111' }), 'valid uuid4 not known')
      pubSnap(this, await pub('GET', '/public/share/my-book', { cookie: 'not-a-uuid' }), 'invalid cookie')
      matchSnapshot(this, { sessionIds: ShareManager.openSharePlaybackSessions.map((s) => s.shareSessionId) }, { label: 'session ids' })
    })
    it('404s for an expired share and removes it', async function () {
      this.ids = new Map()
      await share({ expiresAt: Date.now() + HOUR })
      ShareManager.openMediaItemShares[0].mediaItemShare.expiresAt = new Date(Date.now() - 1000) // expire it without waiting an hour
      const res = await pub('GET', '/public/share/my-book')
      // the handler does not await removeMediaItemShare: share_closed is emitted after the response, so wait for it
      await waitFor(() => api.emitted.length > 0)
      pubSnap(this, res, 'expired')
      matchSnapshot(this, { open: ShareManager.openMediaItemShares.length, rows: await Database.mediaItemShareModel.count() }, { label: 'state' })
    })
    it('404s when the shared media item is a podcast episode or has no library item', async function () {
      await share({ slug: 'episode', mediaItemType: 'podcastEpisode', mediaItemId: podcast.episodes[0].id })
      pubSnap(this, await pub('GET', '/public/share/episode'), 'podcast episode share')
      await Database.libraryItemModel.destroy({ where: { id: hiddenBook.libraryItem.id } })
      await share({ slug: 'orphan', mediaItemId: hiddenBook.book.id })
      pubSnap(this, await pub('GET', '/public/share/orphan'), 'book without library item')
    })
  })

  describe('GET /public/share/:slug/cover', () => {
    it('requires the session cookie, a matching share and session', async function () {
      this.ids = new Map()
      await share()
      await share({ slug: 'other-book', mediaItemId: hiddenBook.book.id })
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/cover'), 'no cookie')
      pubSnap(this, await pub('GET', '/public/share/nope/cover', { cookie: session.sessionId }), 'unknown slug')
      pubSnap(this, await pub('GET', '/public/share/other-book/cover', { cookie: session.sessionId }), 'session belongs to another share')
      pubSnap(this, await pub('GET', '/public/share/my-book/cover', { cookie: '11111111-1111-4111-8111-111111111111' }), 'unknown session')
    })
    it('serves the cover file', async function () {
      await share()
      const session = await pub('GET', '/public/share/my-book')
      const res = await pub('GET', '/public/share/my-book/cover', { cookie: session.sessionId })
      pubSnap(this, res, 'cover')
      expect(res.body.bytes).to.equal(PNG_1X1.length)
    })
    it('404s when the item has no cover', async function () {
      await share({ mediaItemId: hiddenBook.book.id })
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/cover', { cookie: session.sessionId }), 'no cover')
    })
    it('answers with X-Accel-Redirect when XAccel is configured', async function () {
      global.XAccel = '/protected'
      await share()
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/cover', { cookie: session.sessionId }), 'x-accel')
    })
  })

  describe('GET /public/share/:slug/track/:index', () => {
    it('requires the session cookie, a matching share and session', async function () {
      this.ids = new Map()
      await share()
      await share({ slug: 'other-book', mediaItemId: hiddenBook.book.id })
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/track/1'), 'no cookie')
      pubSnap(this, await pub('GET', '/public/share/nope/track/1', { cookie: session.sessionId }), 'unknown slug')
      pubSnap(this, await pub('GET', '/public/share/other-book/track/1', { cookie: session.sessionId }), 'session belongs to another share')
      pubSnap(this, await pub('GET', '/public/share/my-book/track/1', { cookie: '11111111-1111-4111-8111-111111111111' }), 'unknown session')
    })
    it('serves the audio tracks and 404s unknown indexes', async function () {
      await share()
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/track/1', { cookie: session.sessionId }), 'track 1')
      pubSnap(this, await pub('GET', '/public/share/my-book/track/2', { cookie: session.sessionId }), 'track 2')
      pubSnap(this, await pub('GET', '/public/share/my-book/track/3', { cookie: session.sessionId }), 'track 3 missing')
      pubSnap(this, await pub('GET', '/public/share/my-book/track/abc', { cookie: session.sessionId }), 'non numeric index')
    })
    it('answers with X-Accel-Redirect when XAccel is configured', async function () {
      global.XAccel = '/protected'
      await share()
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/track/1', { cookie: session.sessionId }), 'x-accel')
    })
  })

  describe('GET /public/share/:slug/download', () => {
    it('requires the session cookie, a downloadable share, a matching share and session', async function () {
      this.ids = new Map()
      await share({ isDownloadable: true })
      await share({ slug: 'locked', mediaItemId: hiddenBook.book.id, isDownloadable: false })
      const session = await pub('GET', '/public/share/my-book')
      const locked = await pub('GET', '/public/share/locked')
      pubSnap(this, await pub('GET', '/public/share/my-book/download'), 'no cookie')
      pubSnap(this, await pub('GET', '/public/share/nope/download', { cookie: session.sessionId }), 'unknown slug')
      pubSnap(this, await pub('GET', '/public/share/locked/download', { cookie: locked.sessionId }), 'not downloadable')
      pubSnap(this, await pub('GET', '/public/share/my-book/download', { cookie: locked.sessionId }), 'session belongs to another share')
      pubSnap(this, await pub('GET', '/public/share/my-book/download', { cookie: '11111111-1111-4111-8111-111111111111' }), 'unknown session')
    })
    it('downloads a folder item as a zip', async function () {
      await share({ isDownloadable: true })
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/download', { cookie: session.sessionId }), 'zip')
    })
    it('downloads a single file item as an attachment', async function () {
      await share({ mediaItemId: fileBook.book.id, isDownloadable: true })
      const session = await pub('GET', '/public/share/my-book')
      pubSnap(this, await pub('GET', '/public/share/my-book/download', { cookie: session.sessionId }), 'file')
    })
    it('404s when the library item is gone', async function () {
      await share({ isDownloadable: true })
      const session = await pub('GET', '/public/share/my-book')
      await Database.libraryItemModel.destroy({ where: { id: book.libraryItem.id } })
      pubSnap(this, await pub('GET', '/public/share/my-book/download', { cookie: session.sessionId }), 'item deleted')
    })
  })

  describe('PATCH /public/share/:slug/progress', () => {
    it('validates cookie, body, slug and session', async function () {
      this.ids = new Map()
      await share()
      await share({ slug: 'other-book', mediaItemId: hiddenBook.book.id })
      const session = await pub('GET', '/public/share/my-book')
      const patch = (slug, currentTime, cookie = session.sessionId) => pub('PATCH', `/public/share/${slug}/progress`, { cookie, json: currentTime === undefined ? {} : { currentTime } })
      pubSnap(this, await pub('PATCH', '/public/share/my-book/progress', { json: { currentTime: 5 } }), 'no cookie')
      pubSnap(this, await patch('my-book', undefined), 'missing currentTime')
      pubSnap(this, await patch('my-book', null), 'null currentTime')
      pubSnap(this, await patch('my-book', 'abc'), 'NaN currentTime')
      pubSnap(this, await patch('my-book', -1), 'negative currentTime')
      pubSnap(this, await patch('nope', 5), 'unknown slug')
      pubSnap(this, await patch('other-book', 5), 'session belongs to another share')
      pubSnap(this, await patch('my-book', 5, '11111111-1111-4111-8111-111111111111'), 'unknown session')
    })
    it('stores the progress in the open session, capped to the duration', async function () {
      this.ids = new Map([[book.book.id, '<book>'], [book.libraryItem.id, '<item>']])
      await share()
      const session = await pub('GET', '/public/share/my-book')
      const patch = (currentTime) => pub('PATCH', '/public/share/my-book/progress', { cookie: session.sessionId, json: { currentTime } })
      pubSnap(this, await patch(42.5), 'update')
      pubSnap(this, await pub('GET', '/public/share/my-book', { cookie: session.sessionId }), 'get shows new currentTime')
      pubSnap(this, await patch('12'), 'numeric string accepted')
      pubSnap(this, await patch(1000), 'capped to duration')
      pubSnap(this, await pub('GET', '/public/share/my-book', { cookie: session.sessionId }), 'get shows duration')
    })
  })
})
