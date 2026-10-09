const { expect } = require('chai')
const { startAuthApi } = require('./helpers/auth-harness')
const { matchSnapshot } = require('./helpers/snapshot')

// Real passport (local + jwt strategies), TokenManager and Auth.initAuthRoutes on in-memory SQLite, wired as in Server.js.
// The controller suites use a stub login instead, so this is the only place real token handling is pinned.
// OpenID is not configured (authActiveAuthMethods defaults to local), so only the routes' behaviour without a provider is recorded.
describe('Auth routes (characterization)', () => {
  let api
  const pass = (u) => `${u}-pass`
  const login = (username, password, headers) => api.authRequest('POST', '/login', { json: { username, password }, headers })
  const cookieOf = (res, name) => (res.cookies.find((c) => c.startsWith(`${name}=`)) || '').split(';')[0]
  // cookie values are random/JWTs: keep name, attributes and whether the value is empty
  // the server settings in login responses hold the random temp dir of the test and an environment-dependent logLevel
  const maskTmp = (v) => {
    const out = JSON.parse(JSON.stringify(v ?? null).replace(/[^"\\]*abs-char-[A-Za-z0-9]+/g, '<tmp>'))
    // the default logLevel setting is read from the Logger singleton, which depends on dev/prod mode
    if (out?.serverSettings?.logLevel !== undefined) out.serverSettings.logLevel = '<env>'
    // the default timeZone setting is the machine's (process.env.TZ)
    if (out?.serverSettings?.timeZone !== undefined) out.serverSettings.timeZone = '<env>'
    return out
  }
  const scrub = (res) => ({
    status: res.status,
    location: res.headers.location,
    body: maskTmp(res.body),
    cookies: res.cookies.map((c) => {
      const [nv, ...attrs] = c.split('; ')
      const [name, value] = [nv.slice(0, nv.indexOf('=')), nv.slice(nv.indexOf('=') + 1)]
      return { name, value: value === '' ? '' : '<value>', attrs: attrs.filter((a) => !/^Expires=/i.test(a)) }
    })
  })

  beforeEach(async () => {
    api = await startAuthApi()
    await api.seedAuthUsers()
  })
  afterEach(async () => {
    await api.stop()
  })

  describe('POST /login', () => {
    it('logs in with a valid password and sets the refresh cookie', async function () {
      const res = await login('root', pass('root'))
      matchSnapshot(this, scrub(res))
      expect(res.body.user.accessToken).to.be.a('string')
      expect(res.body.user.refreshToken).to.equal(null)
    })

    it('returns the refresh token in the body (no cookie) when x-return-tokens is true', async function () {
      const res = await login('root', pass('root'), { 'x-return-tokens': 'true' })
      matchSnapshot(this, scrub(res))
      expect(res.body.user.refreshToken).to.be.a('string')
      expect(cookieOf(res, 'refresh_token')).to.equal('')
    })

    it('rejects a wrong password, an unknown user and a missing body with 401', async function () {
      const wrong = await login('root', 'nope')
      const unknown = await login('nobody', 'nope')
      const empty = await api.authRequest('POST', '/login', { json: {} })
      const noBody = await api.authRequest('POST', '/login')
      matchSnapshot(this, { wrong: scrub(wrong), unknown: scrub(unknown), empty: scrub(empty), noBody: scrub(noBody) })
    })

    it('rejects an inactive user', async function () {
      const Database = require('../../server/Database')
      await Database.userModel.update({ isActive: false }, { where: { username: 'user' } })
      const res = await login('user', pass('user'))
      matchSnapshot(this, scrub(res))
    })
  })

  describe('bearer authentication on /api', () => {
    it('accepts the access token as a bearer header and as ?token=', async function () {
      const { body } = await login('admin', pass('admin'))
      const token = body.user.accessToken
      const header = await api.authRequest('GET', '/api/libraries', { bearer: token })
      const query = await api.authRequest('GET', `/api/libraries?token=${token}`)
      matchSnapshot(this, { header: scrub(header), query: scrub(query) })
    })

    it('rejects missing, malformed and wrongly signed tokens with 401', async function () {
      const jwt = require('jsonwebtoken')
      const { body } = await login('admin', pass('admin'))
      const forged = jwt.sign({ userId: body.user.id, username: 'admin' }, 'some-other-secret')
      const results = {
        none: await api.authRequest('GET', '/api/libraries'),
        garbage: await api.authRequest('GET', '/api/libraries', { bearer: 'garbage' }),
        forged: await api.authRequest('GET', '/api/libraries', { bearer: forged })
      }
      matchSnapshot(this, Object.fromEntries(Object.entries(results).map(([k, v]) => [k, scrub(v)])))
    })

    it('lets cover and author image GETs through without authentication', async function () {
      const cover = await api.authRequest('GET', '/api/items/does-not-exist/cover')
      const image = await api.authRequest('GET', '/api/authors/does-not-exist/image')
      const post = await api.authRequest('POST', '/api/items/does-not-exist/cover')
      matchSnapshot(this, { cover: scrub(cover), image: scrub(image), post: scrub(post) })
    })
  })

  describe('POST /auth/refresh', () => {
    it('401s without a refresh token', async function () {
      matchSnapshot(this, scrub(await api.authRequest('POST', '/auth/refresh')))
    })

    it('401s for an invalid refresh token', async function () {
      const cookie = await api.authRequest('POST', '/auth/refresh', { cookie: 'refresh_token=garbage' })
      const header = await api.authRequest('POST', '/auth/refresh', { headers: { 'x-refresh-token': 'garbage' } })
      matchSnapshot(this, { cookie: scrub(cookie), header: scrub(header) })
    })

    it('issues a new access token from the cookie and keeps the refresh token out of the body', async function () {
      const first = await login('root', pass('root'))
      const res = await api.authRequest('POST', '/auth/refresh', { cookie: cookieOf(first, 'refresh_token') })
      matchSnapshot(this, scrub(res))
      expect(res.body.user.refreshToken).to.equal(null)
      const works = await api.authRequest('GET', '/api/libraries', { bearer: res.body.user.accessToken })
      expect(works.status).to.equal(200)
    })

    it('uses x-refresh-token over the cookie and returns the refresh token in the body', async function () {
      const first = await login('root', pass('root'), { 'x-return-tokens': 'true' })
      const res = await api.authRequest('POST', '/auth/refresh', { headers: { 'x-refresh-token': first.body.user.refreshToken } })
      matchSnapshot(this, scrub(res))
      expect(res.body.user.refreshToken).to.be.a('string')
    })

    it('records whether the same refresh token can be used twice', async function () {
      const first = await login('root', pass('root'), { 'x-return-tokens': 'true' })
      const token = first.body.user.refreshToken
      const one = await api.authRequest('POST', '/auth/refresh', { headers: { 'x-refresh-token': token } })
      const two = await api.authRequest('POST', '/auth/refresh', { headers: { 'x-refresh-token': token } })
      matchSnapshot(this, { one: one.status, two: two.status, twoBody: two.status === 200 ? '<ok>' : two.body })
    })
  })

  describe('POST /logout', () => {
    it('clears the cookies and returns a null redirect_url', async function () {
      const first = await login('root', pass('root'))
      const res = await api.authRequest('POST', '/logout', { cookie: cookieOf(first, 'refresh_token') })
      matchSnapshot(this, scrub(res))
    })

    it('invalidates the refresh token', async function () {
      const first = await login('root', pass('root'))
      const cookie = cookieOf(first, 'refresh_token')
      await api.authRequest('POST', '/logout', { cookie })
      const res = await api.authRequest('POST', '/auth/refresh', { cookie })
      matchSnapshot(this, scrub(res))
    })

    it('works without a refresh token', async function () {
      matchSnapshot(this, scrub(await api.authRequest('POST', '/logout')))
    })

    it('allDevices=1 invalidates every session of the user', async function () {
      const a = await login('root', pass('root'), { 'x-return-tokens': 'true' })
      const b = await login('root', pass('root'), { 'x-return-tokens': 'true' })
      const out = await api.authRequest('POST', '/logout?allDevices=1', { headers: { 'x-refresh-token': a.body.user.refreshToken } })
      const refreshA = await api.authRequest('POST', '/auth/refresh', { headers: { 'x-refresh-token': a.body.user.refreshToken } })
      const refreshB = await api.authRequest('POST', '/auth/refresh', { headers: { 'x-refresh-token': b.body.user.refreshToken } })
      matchSnapshot(this, { out: scrub(out), refreshA: scrub(refreshA), refreshB: scrub(refreshB) })
    })
  })

  describe('openid routes without a configured provider', () => {
    it('GET /auth/openid/config requires an admin and an issuer', async function () {
      const root = await login('root', pass('root'))
      const user = await login('user', pass('user'))
      const noAuth = await api.authRequest('GET', '/auth/openid/config?issuer=http://x')
      const asUser = await api.authRequest('GET', '/auth/openid/config?issuer=http://x', { bearer: user.body.user.accessToken })
      const noIssuer = await api.authRequest('GET', '/auth/openid/config', { bearer: root.body.user.accessToken })
      matchSnapshot(this, { noAuth: scrub(noAuth), asUser: scrub(asUser), noIssuer: scrub(noIssuer) })
    })
  })
})
