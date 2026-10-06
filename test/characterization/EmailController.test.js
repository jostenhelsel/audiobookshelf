const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { libraryFolderPath, visibleFileBook, stubTransport } = require('./helpers/seed-delivery-extra')
const EmailManager = require('../../server/managers/EmailManager')
const Database = require('../../server/Database')

// The real EmailManager runs; only nodemailer.createTransport is stubbed (no SMTP, no network). The stub records the
// transport options and every verify()/sendMail() call.
describe('EmailController (characterization)', () => {
  let api, users, lf, ebookItem, audioOnlyItem, smtp

  beforeEach(async () => {
    api = await startApi({ managers: { emailManager: new EmailManager() } })
    users = await api.seed.users()
    smtp = stubTransport()
    lf = await createLibrary({ name: 'Books', path: libraryFolderPath(api) })
    ebookItem = (await visibleFileBook(lf, { title: 'With Ebook', n: 1, ebook: true })).libraryItem
    audioOnlyItem = (await visibleFileBook(lf, { title: 'Audio Only', n: 2 })).libraryItem
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const smtpCalls = () => ({
    createTransport: smtp.createTransport.getCalls().map((c) => c.args),
    verify: smtp.transport.verify.callCount,
    sendMail: smtp.transport.sendMail.getCalls().map((c) => c.args)
  })
  const SETTINGS = { host: 'smtp.example.test', port: 587, secure: false, rejectUnauthorized: false, user: 'mailer', pass: 'secret-pass', testAddress: 'test@example.test', fromAddress: 'abs@example.test' }

  describe('GET /api/emails/settings', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/emails/settings'))
    })
    it('returns default settings to admins and 404 to user/guest', async function () {
      for (const as of ['root', 'admin', 'user', 'guest']) snap(this, await api.request('GET', '/api/emails/settings', { as }), as)
    })
  })

  describe('PATCH /api/emails/settings', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('PATCH', '/api/emails/settings', { json: SETTINGS }), 'no auth')
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'user', json: SETTINGS }), 'user')
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'guest', json: SETTINGS }), 'guest')
      snap(this, await api.request('GET', '/api/emails/settings', { as: 'admin' }), 'unchanged')
    })
    it('updates settings, coercing types, and persists them', async function () {
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'admin', json: SETTINGS }), 'admin update')
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'root', json: { port: 'abc', secure: 0, unknownKey: 1 } }), 'coerce port and secure')
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'root', json: { port: '2525' } }), 'string port')
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'root', json: { port: '2525' } }), 'no changes')
      snap(this, await api.request('GET', '/api/emails/settings', { as: 'admin' }), 'get after update')
      const stored = await Database.models.setting.findOne({ where: { key: 'email-settings' } })
      matchSnapshot(this, stored.value, { label: 'db row', tmpDirs: [api.tmp] })
    })
    it('validates ereaderDevices passed in settings', async function () {
      this.ids = new Map()
      const devices = [
        { name: 'Kindle', email: 'kindle@example.test', availabilityOption: 'bogus' },
        { name: 'No email' },
        { name: 'Specific no users', email: 'a@example.test', availabilityOption: 'specificUsers' },
        { name: 'Guests', email: 'g@example.test', availabilityOption: 'guestOrUp', users: [users.user.id] },
        { name: 'Specific', email: 's@example.test', availabilityOption: 'specificUsers', users: [users.user.id] }
      ]
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'admin', json: { ereaderDevices: devices } }), 'devices filtered and defaulted')
      snap(this, await api.request('PATCH', '/api/emails/settings', { as: 'admin', json: { ereaderDevices: 'nope' } }), 'non-array ignored')
    })
  })

  describe('POST /api/emails/test', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', '/api/emails/test'), 'no auth')
      snap(this, await api.request('POST', '/api/emails/test', { as: 'user' }), 'user')
      matchSnapshot(this, smtpCalls(), { label: 'smtp calls' })
    })
    it('sends the test email using the transport built from settings', async function () {
      await api.request('PATCH', '/api/emails/settings', { as: 'admin', json: SETTINGS })
      snap(this, await api.request('POST', '/api/emails/test', { as: 'admin' }), 'admin', { smtp: smtpCalls() })
    })
    it('falls back to the from address when there is no test address', async function () {
      await api.request('PATCH', '/api/emails/settings', { as: 'admin', json: { ...SETTINGS, testAddress: '' } })
      snap(this, await api.request('POST', '/api/emails/test', { as: 'root' }), 'root', { smtp: smtpCalls() })
    })
    it('returns 400 when the SMTP config cannot be verified', async function () {
      smtp.transport.verify.callsFake(async () => {
        throw new Error('connect ECONNREFUSED')
      })
      snap(this, await api.request('POST', '/api/emails/test', { as: 'admin' }), 'verify throws', { smtp: smtpCalls() })
    })
    it('returns the sendMail error message with 400', async function () {
      smtp.transport.sendMail.callsFake(async () => {
        throw new Error('550 mailbox unavailable')
      })
      snap(this, await api.request('POST', '/api/emails/test', { as: 'admin' }), 'sendMail throws', { smtp: smtpCalls() })
    })
  })

  describe('POST /api/emails/ereader-devices', () => {
    const post = (as, json) => api.request('POST', '/api/emails/ereader-devices', { as, json })
    it('requires authentication and admin', async function () {
      snap(this, await api.request('POST', '/api/emails/ereader-devices', { json: { ereaderDevices: [] } }), 'no auth')
      snap(this, await post('user', { ereaderDevices: [] }), 'user')
      snap(this, await post('guest', { ereaderDevices: [] }), 'guest')
    })
    it('validates the payload', async function () {
      snap(this, await post('admin', {}), 'missing')
      snap(this, await post('admin', { ereaderDevices: 'x' }), 'not an array')
      snap(this, await post('admin', { ereaderDevices: [{ name: 'Only name' }] }), 'device without email')
      snap(this, await post('admin', { ereaderDevices: [{ email: 'a@example.test' }] }), 'device without name')
    })
    it('saves devices, emits to admins and persists', async function () {
      this.ids = new Map()
      const devices = [
        { name: 'Kindle', email: 'kindle@example.test', availabilityOption: 'userOrUp' },
        { name: 'Kobo', email: 'kobo@example.test', availabilityOption: 'specificUsers', users: [users.user.id] }
      ]
      snap(this, await post('admin', { ereaderDevices: devices }), 'save')
      snap(this, await post('admin', { ereaderDevices: devices }), 'same again emits nothing')
      snap(this, await post('root', { ereaderDevices: [{ name: 'Kindle', email: 'new@example.test' }] }), 'replace with defaults')
      snap(this, await post('root', { ereaderDevices: [] }), 'empty list clears all devices')
      snap(this, await api.request('GET', '/api/emails/settings', { as: 'admin' }), 'settings')
    })
  })

  describe('POST /api/emails/send-ebook-to-device', () => {
    const send = (as, json) => api.request('POST', '/api/emails/send-ebook-to-device', { as, json })
    beforeEach(async () => {
      await api.request('PATCH', '/api/emails/settings', { as: 'admin', json: SETTINGS })
      await api.request('POST', '/api/emails/ereader-devices', {
        as: 'admin',
        json: {
          ereaderDevices: [
            { name: 'AdminDevice', email: 'admin-dev@example.test', availabilityOption: 'adminOrUp' },
            { name: 'UserDevice', email: 'user-dev@example.test', availabilityOption: 'userOrUp' },
            { name: 'GuestDevice', email: 'guest-dev@example.test', availabilityOption: 'guestOrUp' },
            { name: 'SpecificDevice', email: 'specific-dev@example.test', availabilityOption: 'specificUsers', users: [users.user.id] }
          ]
        }
      })
      api.emitted.splice(0)
    })
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/emails/send-ebook-to-device', { json: {} }))
    })
    it('404s for unknown device, item and items without an ebook', async function () {
      snap(this, await send('admin', { libraryItemId: ebookItem.id, deviceName: 'Nope' }), 'unknown device')
      snap(this, await send('admin', {}), 'empty body')
      snap(this, await send('admin', { libraryItemId: 'unknown-id', deviceName: 'AdminDevice' }), 'unknown item')
      snap(this, await send('admin', { libraryItemId: audioOnlyItem.id, deviceName: 'AdminDevice' }), 'item without ebook')
      matchSnapshot(this, smtpCalls(), { label: 'no mail sent' })
    })
    it('enforces device availability per user type', async function () {
      this.ids = new Map()
      for (const device of ['AdminDevice', 'UserDevice', 'GuestDevice', 'SpecificDevice']) {
        for (const as of ['admin', 'user', 'guest']) {
          const res = await send(as, { libraryItemId: ebookItem.id, deviceName: device })
          snap(this, res, `${as} -> ${device}`)
        }
      }
      expect(smtp.transport.sendMail.callCount).to.equal(3 + 3 + 1) // admin: Admin/User/Guest devices, user: User/Guest/Specific, guest: Guest
    })
    it('sends the ebook as an attachment', async function () {
      this.ids = new Map()
      snap(this, await send('user', { libraryItemId: ebookItem.id, deviceName: 'UserDevice' }), 'user sends', { smtp: smtpCalls() })
    })
    it('returns 400 when verify fails or sendMail fails', async function () {
      smtp.transport.verify.callsFake(async () => false)
      snap(this, await send('admin', { libraryItemId: ebookItem.id, deviceName: 'AdminDevice' }), 'verify false')
      smtp.transport.verify.callsFake(async () => true)
      smtp.transport.sendMail.callsFake(async () => {
        throw new Error('552 attachment too large')
      })
      snap(this, await send('admin', { libraryItemId: ebookItem.id, deviceName: 'AdminDevice' }), 'sendMail fails')
    })
    it('403s for a user without access to the item library', async function () {
      const restricted = await Database.userModel.create({ username: 'restricted', pash: 'hash', token: 'token-restricted', type: 'user', isActive: true, permissions: { ...Database.userModel.getDefaultPermissionsForUserType('user'), accessAllLibraries: false, librariesAccessible: [] }, bookmarks: [], extraData: {} })
      expect(restricted.username).to.equal('restricted')
      snap(this, await send('restricted', { libraryItemId: ebookItem.id, deviceName: 'GuestDevice' }), 'no library access')
    })
  })
})
