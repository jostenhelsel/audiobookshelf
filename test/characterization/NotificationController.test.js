const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { stubAxiosPost } = require('./helpers/seed-delivery-extra')
const NotificationManager = require('../../server/managers/NotificationManager')
const Database = require('../../server/Database')
const { version } = require('../../package.json')

// The real NotificationManager runs; only axios.post (the apprise call) is stubbed and recorded. NotificationManager is a
// module singleton with a "sending" flag and a delay timer, so each test resets its state and uses a 1ms delay.
describe('NotificationController (characterization)', () => {
  let api, axiosPost

  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
    NotificationManager.sendingNotification = false
    NotificationManager.notificationQueue = []
    axiosPost = stubAxiosPost()
  })

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 20)) // let the notificationFinished() timer run
    await api.stop()
  })

  const maskVersion = (v) => JSON.parse(JSON.stringify(v).split(`v${version}`).join('v<version>'))
  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, maskVersion({ res, emitted, ...extra }), { label, ids: ctx.ids })
  }
  // the onTest event data holds the package version, which changes with every release
  const apprise = () => axiosPost.getCalls().map((c) => c.args)
  const wait = () => new Promise((r) => setTimeout(r, 20))
  const configure = async (as = 'admin', json = { appriseApiUrl: 'http://apprise.example.test/notify' }) => {
    const res = await api.request('PATCH', '/api/notifications', { as, json })
    Database.notificationSettings.notificationDelay = 1
    return res
  }
  const NEW = { eventName: 'onTest', urls: ['json://hooks.example.test/a'], titleTemplate: 'Title {{version}}', bodyTemplate: 'Body {{version}}', enabled: true, type: 'info' }
  const create = (as, over = {}) => api.request('POST', '/api/notifications', { as, json: { ...NEW, ...over } })
  const AUTH_ROUTES = [
    ['GET', '/api/notifications'],
    ['PATCH', '/api/notifications'],
    ['GET', '/api/notificationdata'],
    ['GET', '/api/notifications/test'],
    ['POST', '/api/notifications'],
    ['DELETE', '/api/notifications/some-id'],
    ['PATCH', '/api/notifications/some-id'],
    ['GET', '/api/notifications/some-id/test']
  ]

  describe('authentication and permissions', () => {
    it('requires authentication on every route', async function () {
      for (const [method, url] of AUTH_ROUTES) snap(this, await api.request(method, url, method === 'GET' ? {} : { json: {} }), `${method} ${url}`)
    })
    it('rejects user and guest with 403 on every route', async function () {
      for (const as of ['user', 'guest']) for (const [method, url] of AUTH_ROUTES) snap(this, await api.request(method, url, method === 'GET' ? { as } : { as, json: { ...NEW } }), `${as} ${method} ${url}`)
      expect(axiosPost.callCount).to.equal(0)
      matchSnapshot(this, Database.notificationSettings.toJSON(), { label: 'settings unchanged' })
    })
  })

  describe('GET /api/notifications and /api/notificationdata', () => {
    it('returns event data and default settings to admin and root', async function () {
      snap(this, await api.request('GET', '/api/notifications', { as: 'admin' }), 'admin')
      snap(this, await api.request('GET', '/api/notifications', { as: 'root' }), 'root')
    })
    it('returns only the event data on the deprecated route', async function () {
      snap(this, await api.request('GET', '/api/notificationdata', { as: 'admin' }), 'admin')
    })
  })

  describe('PATCH /api/notifications', () => {
    it('updates apprise settings and persists them', async function () {
      snap(this, await api.request('PATCH', '/api/notifications', { as: 'admin', json: { appriseApiUrl: 'http://apprise.example.test/notify', maxFailedAttempts: '3', maxNotificationQueue: 'abc', notificationDelay: 5 } }), 'update')
      snap(this, await api.request('GET', '/api/notifications', { as: 'admin' }), 'get after update')
      snap(this, await api.request('PATCH', '/api/notifications', { as: 'root', json: {} }), 'empty body resets to defaults')
      snap(this, await api.request('GET', '/api/notifications', { as: 'root' }), 'get after reset')
      const row = await Database.models.setting.findOne({ where: { key: 'notification-settings' } })
      matchSnapshot(this, row.value, { label: 'db row' })
    })
  })

  describe('POST /api/notifications', () => {
    it('creates notifications and returns the settings', async function () {
      this.ids = new Map()
      snap(this, await create('admin'), 'create enabled')
      snap(this, await create('root', { eventName: 'onBackupFailed', urls: ['json://x', 'mailto://y'], enabled: false, type: undefined, libraryId: 'lib-1' }), 'create disabled with two urls')
      snap(this, await api.request('GET', '/api/notifications', { as: 'admin' }), 'list')
    })
    it('silently ignores payloads without eventName or with empty urls', async function () {
      snap(this, await create('admin', { eventName: '' }), 'no event name')
      snap(this, await create('admin', { urls: [] }), 'empty urls')
      snap(this, await api.request('POST', '/api/notifications', { as: 'admin', json: {} }), 'empty body (no eventName short-circuits before urls is read)')
    })
    it.skip('POST /api/notifications: without a urls property createNotification throws (payload.urls.length) in an async handler with no try/catch, so the request hangs', () => {})
  })

  describe('PATCH /api/notifications/:id', () => {
    let notification
    beforeEach(async () => {
      notification = (await create('admin')).body.notifications[0]
      api.emitted.splice(0)
    })
    it('404s for an unknown notification id', async function () {
      snap(this, await api.request('PATCH', '/api/notifications/unknown', { as: 'admin', json: { id: notification.id, enabled: false } }), 'unknown url id')
    })
    it('updates fields, and resets failure counters when re-enabled', async function () {
      this.ids = new Map([[notification.id, '<notification>']])
      snap(this, await api.request('PATCH', `/api/notifications/${notification.id}`, { as: 'admin', json: { id: notification.id, titleTemplate: 'New {{version}}', urls: ['json://b', 'json://c'], enabled: false, eventName: 'onBackupFailed', type: 'warning' } }), 'update')
      snap(this, await api.request('PATCH', `/api/notifications/${notification.id}`, { as: 'admin', json: { id: notification.id, titleTemplate: 'New {{version}}' } }), 'no changes')
      snap(this, await api.request('PATCH', `/api/notifications/${notification.id}`, { as: 'root', json: { id: notification.id, enabled: true } }), 're-enable')
    })
    it('uses the id in the body, not the one in the url', async function () {
      this.ids = new Map([[notification.id, '<notification>']])
      snap(this, await api.request('PATCH', `/api/notifications/${notification.id}`, { as: 'admin', json: { id: 'other-id', titleTemplate: 'Ignored' } }), 'body id unknown')
      snap(this, await api.request('PATCH', `/api/notifications/${notification.id}`, { as: 'admin', json: { titleTemplate: 'Ignored too' } }), 'body without id')
    })
  })

  describe('DELETE /api/notifications/:id', () => {
    it('deletes a notification as admin and 404s afterwards', async function () {
      this.ids = new Map()
      const first = (await create('admin')).body.notifications[0]
      const second = (await create('admin', { eventName: 'onBackupFailed' })).body.notifications[1]
      api.emitted.splice(0)
      snap(this, await api.request('DELETE', `/api/notifications/${first.id}`, { as: 'admin' }), 'delete first')
      snap(this, await api.request('DELETE', `/api/notifications/${first.id}`, { as: 'admin' }), 'delete again')
      snap(this, await api.request('DELETE', '/api/notifications/unknown', { as: 'root' }), 'unknown')
      snap(this, await api.request('DELETE', `/api/notifications/${second.id}`, { as: 'root' }), 'root deletes second')
    })
  })

  describe('GET /api/notifications/test', () => {
    it('does nothing when apprise is not configured', async function () {
      snap(this, await api.request('GET', '/api/notifications/test', { as: 'admin' }), 'unconfigured', { apprise: apprise() })
    })
    it('posts the onTest notification to apprise and records the firing', async function () {
      this.ids = new Map()
      await configure()
      await create('admin')
      await create('admin', { eventName: 'onBackupFailed', urls: ['json://other'] })
      await create('admin', { enabled: false, urls: ['json://disabled'] })
      api.emitted.splice(0)
      snap(this, await api.request('GET', '/api/notifications/test', { as: 'admin' }), 'fire', { apprise: apprise() })
      await wait()
      snap(this, await api.request('GET', '/api/notifications', { as: 'admin' }), 'settings after firing')
    })
    it('counts failures with ?fail=1 and disables after max failed attempts', async function () {
      this.ids = new Map()
      await configure('admin', { appriseApiUrl: 'http://apprise.example.test/notify', maxFailedAttempts: 2 })
      await create('admin')
      api.emitted.splice(0)
      for (const n of [1, 2, 3]) {
        snap(this, await api.request('GET', '/api/notifications/test?fail=1', { as: 'root' }), `fail ${n}`, { apprise: apprise() })
        await wait()
      }
      snap(this, await api.request('GET', '/api/notifications', { as: 'admin' }), 'settings after failures')
    })
    it('records a failed attempt when apprise rejects', async function () {
      this.ids = new Map()
      axiosPost.callsFake(async () => {
        throw new Error('ECONNREFUSED')
      })
      await configure()
      await create('admin')
      api.emitted.splice(0)
      snap(this, await api.request('GET', '/api/notifications/test', { as: 'admin' }), 'apprise down', { apprise: apprise() })
    })
  })

  describe('GET /api/notifications/:id/test', () => {
    it('400s when apprise is not configured and 404s for unknown ids', async function () {
      this.ids = new Map()
      const n = (await create('admin')).body.notifications[0]
      snap(this, await api.request('GET', `/api/notifications/${n.id}/test`, { as: 'admin' }), 'not configured')
      snap(this, await api.request('GET', '/api/notifications/unknown/test', { as: 'admin' }), 'unknown id')
      expect(axiosPost.callCount).to.equal(0)
    })
    it('sends the test data for the notification event', async function () {
      this.ids = new Map()
      await configure()
      const a = (await create('admin', { eventName: 'onBackupCompleted', titleTemplate: 'Backup {{backupCount}}', bodyTemplate: '{{backupPath}} ({{backupSize}})' })).body.notifications[0]
      const b = (await create('admin', { eventName: 'onPodcastEpisodeDownloaded', titleTemplate: '{{podcastTitle}}: {{episodeTitle}}', bodyTemplate: '{{episodeDescription}}' })).body.notifications[1]
      api.emitted.splice(0)
      snap(this, await api.request('GET', `/api/notifications/${a.id}/test`, { as: 'admin' }), 'backup completed', { apprise: apprise() })
      snap(this, await api.request('GET', `/api/notifications/${b.id}/test`, { as: 'root' }), 'episode downloaded', { apprise: apprise().slice(1) })
    })
    it('returns 500 when apprise fails', async function () {
      this.ids = new Map()
      await configure()
      const n = (await create('admin')).body.notifications[0]
      axiosPost.callsFake(async () => {
        throw new Error('boom')
      })
      snap(this, await api.request('GET', `/api/notifications/${n.id}/test`, { as: 'admin' }), 'apprise error')
    })
  })
})
