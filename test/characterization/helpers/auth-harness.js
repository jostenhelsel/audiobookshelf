/**
 * Real-auth variant of the harness: the same in-memory server (startApi), plus a second express app wired like Server.js does it
 * (cookie-parser, express-session, passport.initialize/session, Auth.initPassportJs, /api behind passport's jwt strategy and
 * Auth.initAuthRoutes), so /login, /auth/refresh, /logout and bearer-token requests run the real passport strategies and TokenManager.
 *
 *   const api = await startAuthApi()          // api.* is startApi's api; plus:
 *   await api.seedAuthUsers()                 // root/admin/user with real bcrypt hashes, password = `${username}-pass`
 *   const res = await api.authRequest('POST', '/login', { json: { username: 'root', password: 'root-pass' } })
 *   res.status, res.body, res.cookies (set-cookie strings), res.headers.location
 */
const express = require('express')
const cookieParser = require('cookie-parser')
const expressSession = require('express-session')
const passport = require('passport')
const { startApi } = require('./harness')
const Database = require('../../../server/Database')

const FRESH_PATHS = ['../../../server/Auth', '../../../server/auth/TokenManager', '../../../server/auth/LocalAuthStrategy', '../../../server/auth/OidcAuthStrategy'].map((p) => require.resolve(p))

// Same circular-require problem as TokenManager in harness.js: Auth loaded before Database completed holds a half-initialised
// Database. Load a fresh copy of Auth and its strategies now that Database is complete, then restore the cached modules.
function loadFreshAuth() {
  const cached = FRESH_PATHS.map((p) => require.cache[p])
  FRESH_PATHS.forEach((p) => delete require.cache[p])
  const Auth = require(FRESH_PATHS[0])
  const TokenManager = require(FRESH_PATHS[1])
  FRESH_PATHS.forEach((p, i) => (cached[i] ? (require.cache[p] = cached[i]) : delete require.cache[p]))
  return { Auth, TokenManager }
}

async function startAuthApi(opts = {}) {
  const api = await startApi(opts)
  const { Auth, TokenManager } = loadFreshAuth()
  TokenManager.TokenSecret = 'characterization-test-secret'
  const auth = new Auth()
  // the auth rate limiter is one process-wide singleton (40 attempts per 10 minutes per IP); this suite's requests would use up the budget
  // that other suites' login/password routes need. Bypass it on this Auth instance only (rate limiting itself is not characterized here).
  auth.authRateLimiter = (req, res, next) => next()

  const app = express()
  app.use(cookieParser())
  app.use(expressSession({ secret: TokenManager.TokenSecret, resave: false, saveUninitialized: false, cookie: { secure: false } }))
  app.use(passport.initialize())
  app.use(auth.ifAuthNeeded(passport.session()))
  await auth.initPassportJs()
  const router = express.Router()
  router.use(express.json({ limit: '10mb' }))
  router.use('/api', auth.ifAuthNeeded((req, res, next) => auth.isAuthenticated(req, res, next)), api.apiRouter.router)
  await auth.initAuthRoutes(router)
  app.use(router)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  const stopBase = api.stop
  api.auth = auth
  api.authBase = base
  api.authApp = app
  api.seedAuthUsers = async () => {
    const out = {}
    for (const type of ['root', 'admin', 'user']) {
      const pash = await auth.localAuthStrategy.hashPassword(`${type}-pass`)
      out[type] = await Database.userModel.create({ username: type, pash, type, isActive: true, permissions: Database.userModel.getDefaultPermissionsForUserType(type), bookmarks: [], extraData: { seriesHideFromContinueListening: [] } })
    }
    return out
  }
  /**
   * @param {string} method
   * @param {string} url
   * @param {{ json?: any, headers?: Record<string,string>, bearer?: string, cookie?: string }} [o]
   */
  api.authRequest = async (method, url, o = {}) => {
    const headers = { ...(o.headers || {}) }
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`
    if (o.cookie) headers.cookie = o.cookie
    let body
    if (o.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(o.json)
    }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' })
    const text = await res.text()
    let parsed = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, headers: { 'content-type': res.headers.get('content-type'), location: res.headers.get('location') }, body: parsed, cookies: res.headers.getSetCookie?.() || [] }
  }
  api.stop = async () => {
    await new Promise((resolve) => server.close(resolve))
    passport.unuse('jwt')
    passport.unuse('local')
    TokenManager.TokenSecret = null
    await stopBase()
  }
  return api
}

module.exports = { startAuthApi }
