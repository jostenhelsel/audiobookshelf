const http = require('http')
const sinon = require('sinon')
const WebSocket = require('ws')
const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const Database = require('../../server/Database')
const Logger = require('../../server/Logger')
const jwt = require('../../server/libs/jsonwebtoken')

const SECRET = 'characterization-test-secret'
const SOCKET_AUTHORITY_PATHS = ['../../server/SocketAuthority', '../../server/auth/TokenManager', '../../server/managers/CoverSearchManager'].map((p) => require.resolve(p))

// Same circular-require problem as in the other harnesses: load SocketAuthority (and its TokenManager) fresh, now that Database is complete.
// The shared singleton is stubbed by startApi, so the tests use a new instance of its class.
function loadFresh() {
  const cached = SOCKET_AUTHORITY_PATHS.map((p) => require.cache[p])
  SOCKET_AUTHORITY_PATHS.forEach((p) => delete require.cache[p])
  const SocketAuthority = require(SOCKET_AUTHORITY_PATHS[0])
  const TokenManager = require(SOCKET_AUTHORITY_PATHS[1])
  const CoverSearchManager = require(SOCKET_AUTHORITY_PATHS[2])
  SOCKET_AUTHORITY_PATHS.forEach((p, i) => (cached[i] ? (require.cache[p] = cached[i]) : delete require.cache[p]))
  return { authority: new SocketAuthority.constructor(), TokenManager, CoverSearchManager }
}

/** Minimal socket.io (engine.io v4, websocket transport) client: socket.io-client is not a dependency of the server. */
function connect(port, path = '/socket.io') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}/?EIO=4&transport=websocket`)
    const events = []
    const waiters = []
    const client = {
      events,
      send: (event, ...args) => ws.send('42' + JSON.stringify([event, ...args])),
      /** next event with this name (already received or still to come) */
      next: (event, ms = 2000) => {
        const i = events.findIndex((e) => e.event === event)
        if (i > -1) return Promise.resolve(events.splice(i, 1)[0].args)
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout waiting for "${event}" (got: ${events.map((e) => e.event)})`)), ms)
          waiters.push({ event, done: (args) => (clearTimeout(t), res(args)) })
        })
      },
      /** lets pending server work run, then returns (and clears) everything received */
      drain: async () => {
        await new Promise((r) => setTimeout(r, 150))
        return events.splice(0).map((e) => [e.event, ...e.args])
      },
      close: () => new Promise((res) => (ws.readyState === WebSocket.CLOSED ? res() : (ws.once('close', res), ws.close())))
    }
    ws.on('error', reject)
    ws.on('message', (raw) => {
      const msg = raw.toString()
      if (msg[0] === '0') return ws.send('40')
      if (msg === '2') return ws.send('3')
      if (msg.startsWith('40')) return resolve(client)
      if (msg.startsWith('42')) {
        const [event, ...args] = JSON.parse(msg.slice(2))
        const w = waiters.findIndex((x) => x.event === event)
        if (w > -1) waiters.splice(w, 1)[0].done(args)
        else events.push({ event, args })
      }
    })
  })
}

describe('SocketAuthority (characterization)', function () {
  // real sockets and short sleeps; a test that outran the default 2s would otherwise keep using the next test's server
  this.timeout(10000)
  let api, users, httpServer, port, authority, TokenManager, CoverSearchManager, cancelLibraryScan, clients
  const token = (user, extra = {}, opts = {}) => jwt.sign({ userId: user.id, username: user.username, ...extra }, SECRET, opts)
  const open = async (path) => {
    const c = await connect(port, path)
    clients.push(c)
    return c
  }
  /** connects, authenticates with the user's jwt and returns the client after its init event */
  const login = async (user) => {
    const c = await open()
    c.send('auth', token(user))
    c.init = (await c.next('init'))[0]
    return c
  }
  const settle = () => new Promise((r) => setTimeout(r, 150))

  beforeEach(async () => {
    api = await startApi()
    users = await api.seed.users()
    ;({ authority, TokenManager, CoverSearchManager } = loadFresh())
    TokenManager.TokenSecret = SECRET
    clients = []
    cancelLibraryScan = sinon.spy()
    httpServer = http.createServer()
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
    port = httpServer.address().port
    authority.initialize({ server: httpServer, playbackSessionManager: { sessions: [] }, cancelLibraryScan })
  })

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()))
    await authority.close()
    await new Promise((r) => httpServer.close(r))
    TokenManager.TokenSecret = null
    delete global.RouterBasePath
    await api.stop()
  })

  describe('connection and authentication', () => {
    it('answers ping with pong, and tracks an unauthenticated socket without a user', async function () {
      const c = await open()
      c.send('ping')
      await c.next('pong')
      const tracked = Object.values(authority.clients).map((x) => ({ hasUser: !!x.user, keys: Object.keys(x).sort() }))
      matchSnapshot(this, { tracked, usersOnline: authority.getUsersOnline() })
    })

    it('removes an unauthenticated socket on disconnect', async function () {
      const c = await open()
      await c.close()
      await settle()
      matchSnapshot(this, { remaining: Object.keys(authority.clients).length })
    })

    it('authenticates with a bearer jwt: user gets init without usersOnline, admin gets usersOnline', async function () {
      const user = await login(users.user)
      const admin = await login(users.admin)
      matchSnapshot(this, { user: user.init, admin: admin.init, usersOnlineAfter: authority.getUsersOnline().map((u) => ({ username: u.username, connections: u.connections, keys: Object.keys(u).sort() })) })
      expect(user.init.usersOnline).to.equal(undefined)
      expect((await Database.userModel.findByPk(users.user.id)).lastSeen).to.not.equal(null)
    })

    it('tells admins when a user comes online and when they go offline', async function () {
      const admin = await login(users.admin)
      const user = await login(users.user)
      const online = await admin.next('user_online')
      await user.close()
      const offline = await admin.next('user_offline')
      matchSnapshot(this, { online: { username: online[0].username, keys: Object.keys(online[0]).sort() }, offline: { username: offline[0].username } })
      expect(Object.keys(authority.clients)).to.have.length(1)
    })

    it('counts several sockets of one user as connections of a single online user', async function () {
      await login(users.user)
      await login(users.user)
      const online = authority.getUsersOnline()
      matchSnapshot(this, online.map((u) => ({ username: u.username, connections: u.connections })))
      expect(authority.getClientsForUser(users.user.id)).to.have.length(2)
    })

    it('rejects invalid, refresh-type, expired and unknown-user tokens and inactive users', async function () {
      const results = {}
      const attempt = async (name, tok) => {
        const c = await open()
        c.send('auth', tok)
        results[name] = (await c.next('auth_failed'))[0]
      }
      await attempt('garbage', 'not-a-jwt')
      await attempt('wrongSecret', jwt.sign({ userId: users.user.id }, 'other-secret'))
      await attempt('refreshType', token(users.user, { type: 'refresh' }))
      await attempt('noUserId', jwt.sign({ foo: 1 }, SECRET))
      await attempt('expired', token(users.user, {}, { expiresIn: -60 }))
      await attempt('unknownUser', jwt.sign({ userId: '00000000-0000-4000-8000-000000000000' }, SECRET))
      await users.guest.update({ isActive: false })
      await attempt('inactive', token(users.guest))
      matchSnapshot(this, results)
      expect(Object.values(authority.clients).filter((c) => c.user)).to.have.length(0)
    })

    it('authenticates with an api key and rejects inactive, unknown and expired keys', async function () {
      const make = async (name, o = {}) => {
        const id = require('crypto').randomUUID()
        const jwtForKey = await Database.apiKeyModel.generateApiKey(SECRET, id, name, o.expiresIn)
        const key = await Database.apiKeyModel.create({ id, name, userId: users.user.id, isActive: o.isActive ?? true, expiresAt: null, createdByUserId: users.admin.id, permissions: Database.apiKeyModel.getDefaultPermissions() })
        return { key, jwtForKey }
      }
      const results = {}
      const record = async (name, tok) => {
        const c = await open()
        c.send('auth', tok)
        await settle()
        results[name] = await c.drain()
      }
      const active = await make('active')
      const inactive = await make('inactive', { isActive: false })
      const expired = await make('expired', { expiresIn: 1 })
      await record('active', active.jwtForKey)
      await record('inactive', inactive.jwtForKey)
      await record('unknown', await Database.apiKeyModel.generateApiKey(SECRET, '00000000-0000-4000-8000-000000000000', 'ghost'))
      // let the 1s expiry pass
      await new Promise((r) => setTimeout(r, 1200))
      await record('expired', expired.jwtForKey)
      const row = await Database.apiKeyModel.findByPk(expired.key.id)
      matchSnapshot(this, { results, expiredKeyActiveAfter: row.isActive })
    })

    it('re-authenticating a socket as another user switches the associated user', async function () {
      const c = await login(users.user)
      c.send('auth', token(users.admin))
      const init = (await c.next('init'))[0]
      matchSnapshot(this, { init: { username: init.username, hasUsersOnline: !!init.usersOnline }, associated: Object.values(authority.clients).map((x) => x.user.username) })
    })
  })

  describe('emitters', () => {
    it('emitter reaches every authenticated client, honours the filter and skips unauthenticated sockets', async function () {
      const user = await login(users.user)
      const admin = await login(users.admin)
      const anon = await open()
      authority.emitter('hello', { n: 1 })
      authority.emitter('only_admins', { n: 2 }, (u) => u.isAdminOrUp)
      matchSnapshot(this, { user: await user.drain(), admin: (await admin.drain()).filter(([e]) => e !== 'user_online'), anon: await anon.drain() })
    })

    it('clientEmitter targets one user; adminEmitter targets admins and root', async function () {
      const user = await login(users.user)
      const user2 = await login(users.user)
      const admin = await login(users.admin)
      const root = await login(users.root)
      await Promise.all([user.drain(), user2.drain(), admin.drain(), root.drain()])
      authority.clientEmitter(users.user.id, 'for_user', { a: 1 })
      authority.clientEmitter('no-such-user', 'nobody', {})
      authority.adminEmitter('for_admins', { b: 2 })
      matchSnapshot(this, { user: await user.drain(), user2: await user2.drain(), admin: await admin.drain(), root: await root.drain() })
    })

    it('libraryItemEmitter and libraryItemsEmitter send toOldJSONExpanded to clients that can access the item', async function () {
      const user = await login(users.user)
      const admin = await login(users.admin)
      await Promise.all([user.drain(), admin.drain()])
      // a user limited to one library cannot see items of another
      await users.guest.update({ permissions: { ...users.guest.permissions, accessAllLibraries: false, librariesAccessible: ['lib-a'] } })
      const limited = await login(users.guest)
      await limited.drain()
      const mk = (id, libraryId, media = {}) => ({ libraryId, media: { tags: [], ...media }, toOldJSONExpanded: () => ({ id }) })
      authority.libraryItemEmitter('item_added', mk('one', 'lib-a'))
      authority.libraryItemEmitter('item_added', mk('two', 'lib-b'))
      authority.libraryItemsEmitter('items_updated', [mk('three', 'lib-a'), mk('four', 'lib-b'), mk('five', 'lib-b', { explicit: true })])
      matchSnapshot(this, { user: await user.drain(), admin: await admin.drain(), limited: await limited.drain() })
    })
  })

  describe('client events', () => {
    it('cancel_scan is forwarded to the server for admins only', async function () {
      const user = await login(users.user)
      const admin = await login(users.admin)
      user.send('cancel_scan', 'lib-1')
      await settle()
      const afterUser = cancelLibraryScan.callCount
      admin.send('cancel_scan', 'lib-2')
      await settle()
      matchSnapshot(this, { afterUser, calls: cancelLibraryScan.args })
    })

    it('message_all_users sends admin_message to all authenticated clients for admins only', async function () {
      const user = await login(users.user)
      const admin = await login(users.admin)
      await Promise.all([user.drain(), admin.drain()])
      user.send('message_all_users', { message: 'from user' })
      await settle()
      const afterUser = [await user.drain(), await admin.drain()]
      admin.send('message_all_users', { message: 'from admin' })
      admin.send('message_all_users', {})
      matchSnapshot(this, { afterUser, user: await user.drain(), admin: await admin.drain() })
    })

    it('set_log_listener validates the level and the role; remove_log_listener always removes', async function () {
      const add = sinon.stub(Logger, 'addSocketListener')
      const remove = sinon.stub(Logger, 'removeSocketListener')
      try {
        const user = await login(users.user)
        const admin = await login(users.admin)
        user.send('set_log_listener', 1)
        admin.send('set_log_listener', 1)
        admin.send('set_log_listener', 99)
        admin.send('set_log_listener', '1')
        admin.send('set_log_listener', 1.5)
        admin.send('remove_log_listener')
        await settle()
        matchSnapshot(this, { adds: add.args.map(([socket, level]) => [typeof socket.id, level]), removes: remove.callCount > 0 })
      } finally {
        add.restore()
        remove.restore()
      }
    })

    it('serves a second socket.io path when RouterBasePath is set', async function () {
      // fresh authority, because initialize() reads global.RouterBasePath
      await authority.close() // also closes the http server
      httpServer = http.createServer()
      await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
      port = httpServer.address().port
      authority.clients = {}
      global.RouterBasePath = '/audiobooks'
      authority.initialize({ server: httpServer, playbackSessionManager: { sessions: [] }, cancelLibraryScan })
      const legacy = await open('/socket.io')
      const based = await open('/audiobooks/socket.io')
      legacy.send('ping')
      based.send('ping')
      await Promise.all([legacy.next('pong'), based.next('pong')])
      matchSnapshot(this, { paths: authority.socketIoServers.map((io) => io.path), clients: Object.keys(authority.clients).length })
    })
  })

  describe('cover search over the socket', () => {
    it('rejects unauthenticated and invalid requests', async function () {
      const anon = await open()
      anon.send('search_covers', { requestId: 'r1', title: 'x' })
      const unauth = (await anon.next('cover_search_error'))[0]
      const user = await login(users.user)
      user.send('search_covers', { requestId: 'r2' })
      const invalid = (await user.next('cover_search_error'))[0]
      user.send('search_covers', { title: 'x' })
      const noId = (await user.next('cover_search_error'))[0]
      matchSnapshot(this, { unauth, invalid, noId })
    })

    it('streams results, completion and provider errors, and reports a failed search', async function () {
      const start = sinon.stub(CoverSearchManager, 'startSearch')
      start.onFirstCall().callsFake(async (requestId, params, onResult, onComplete, onError) => {
        onResult({ provider: 'p1', covers: ['a', 'b'], total: 2 })
        onError('p2', 'boom')
        onComplete()
      })
      start.onSecondCall().rejects(new Error('search failed'))
      const user = await login(users.user)
      user.send('search_covers', { requestId: 'ok', title: 'T', author: 'A', provider: 'google', podcast: false })
      await settle()
      const first = await user.drain()
      user.send('search_covers', { requestId: 'bad', title: 'T' })
      await settle()
      const second = await user.drain()
      matchSnapshot(this, { first, second, startArgs: start.args.map(([id, params]) => [id, params]) })
    })

    it('cancel_cover_search needs a user and only answers when a search was cancelled', async function () {
      const cancel = sinon.stub(CoverSearchManager, 'cancelSearch')
      cancel.withArgs('known').returns(true)
      cancel.returns(false)
      const anon = await open()
      anon.send('cancel_cover_search', 'known')
      const user = await login(users.user)
      user.send('cancel_cover_search', 'known')
      user.send('cancel_cover_search', 'unknown')
      await settle()
      matchSnapshot(this, { anon: await anon.drain(), user: await user.drain(), cancelCalls: cancel.args })
    })
  })

  describe('close', () => {
    it('closes every socket.io server and empties the list', async function () {
      const c = await open()
      await authority.close()
      matchSnapshot(this, { servers: authority.socketIoServers.length })
      await c.close()
    })
  })
})
