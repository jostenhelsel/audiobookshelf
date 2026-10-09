const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const WebSocket = require('ws')
const { expect } = require('chai')
const { matchSnapshot } = require('./helpers/snapshot')

// Boots the REAL server (dist-server/index.js -> Server.start()) as a child process on a temp config/metadata dir and a free port, and talks to it
// over HTTP and websockets. A child process, because Server.start() installs process-wide SIGINT / unhandledRejection (process.exit(1)) handlers,
// listens on a port and starts managers; none of that can be undone inside the mocha process. Covers what the in-process harness cannot:
// startup sequence, express middleware order (headers, cors, base path rewriting), status/ping/init, auth wiring, socket.io mounting, shutdown.
describe('Server boot (characterization)', function () {
  this.timeout(60000)

  const ROOT = (() => {
    const parts = __dirname.split(path.sep)
    const i = parts.lastIndexOf('dist-server')
    return i > -1 ? parts.slice(0, i).join(path.sep) || path.sep : path.resolve(__dirname, '..', '..')
  })()
  const INDEX = path.join(ROOT, 'dist-server', 'index.js')

  const freePort = () =>
    new Promise((resolve) => {
      const s = net.createServer()
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address()
        s.close(() => resolve(port))
      })
    })
  // the server refuses to start without FFMPEG_PATH / FFPROBE_PATH (even with SKIP_BINARIES_CHECK=1); it does not run them while booting
  const which = (name, envName) => {
    if (process.env[envName]) return process.env[envName]
    try {
      return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split('\n')[0].trim() || null
    } catch {
      return null
    }
  }
  const FFMPEG = which('ffmpeg', 'FFMPEG_PATH')
  const FFPROBE = which('ffprobe', 'FFPROBE_PATH')
  before(function () {
    if (!FFMPEG || !FFPROBE) this.skip()
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** @type {{ proc: import('child_process').ChildProcess, port: number, base: string, cfg: string, meta: string, tmp: string, lines: string[], exit: Promise<{code:number|null, signal:string|null}> } | null} */
  let srv = null
  const running = []

  /**
   * @param {{ basePath?: string, env?: Record<string,string>, tmp?: string }} [o] `tmp`: reuse the config/metadata dirs of an earlier boot (a restart)
   */
  async function boot(o = {}) {
    const tmp = o.tmp || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abs-boot-')))
    const cfg = path.join(tmp, 'config')
    const meta = path.join(tmp, 'metadata')
    const port = await freePort()
    const env = { ...process.env, TZ: 'UTC', NODE_ENV: 'production', HOST: '127.0.0.1', SKIP_BINARIES_CHECK: '1', FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE, SOURCE: 'local', ROUTER_BASE_PATH: o.basePath ?? '/audiobookshelf', ...o.env }
    const proc = spawn(process.execPath, [INDEX, '--config', cfg, '--metadata', meta, '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = []
    let buf = ''
    const onData = (d) => {
      buf += d.toString()
      const parts = buf.split('\n')
      buf = parts.pop()
      lines.push(...parts)
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    const exit = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })))
    const s = { proc, port, base: `http://127.0.0.1:${port}`, cfg, meta, tmp, lines, exit, basePath: env.ROUTER_BASE_PATH }
    running.push(s)
    srv = s
    // ready = /ping answers
    const deadline = Date.now() + 40000
    for (;;) {
      if (Date.now() > deadline) throw new Error(`server did not become ready:\n${lines.slice(-20).join('\n')}`)
      if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}):\n${lines.slice(-20).join('\n')}`)
      try {
        const r = await fetch(`${s.base}${s.basePath}/ping`)
        if (r.status === 200) break
      } catch {}
      await sleep(150)
    }
    return s
  }

  async function shutdown(s, keepFiles) {
    if (s.proc.exitCode === null && s.proc.signalCode === null) {
      s.proc.kill('SIGINT')
      await Promise.race([s.exit, sleep(10000).then(() => s.proc.kill('SIGKILL'))])
      await s.exit
    }
    if (!keepFiles) fs.rmSync(s.tmp, { recursive: true, force: true })
  }

  const tmpDirsToRemove = []
  afterEach(async () => {
    while (running.length) await shutdown(running.pop())
    while (tmpDirsToRemove.length) fs.rmSync(tmpDirsToRemove.pop(), { recursive: true, force: true })
    srv = null
  })

  /** one request; records status, a fixed set of headers and the parsed body. Paths are relative to the server origin (include the base path yourself). */
  async function get(p, o = {}) {
    const res = await fetch(srv.base + p, { method: o.method || 'GET', headers: o.headers, body: o.json !== undefined ? JSON.stringify(o.json) : undefined, redirect: 'manual', ...(o.json !== undefined ? { headers: { 'content-type': 'application/json', ...o.headers } } : {}) })
    const text = await res.text()
    let body = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {}
    const h = (n) => res.headers.get(n)
    const headers = {}
    for (const n of ['content-type', 'content-security-policy', 'referrer-policy', 'x-powered-by', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials', 'location', 'set-cookie']) {
      if (h(n) !== null) headers[n] = n === 'set-cookie' ? '<set>' : h(n)
    }
    return { status: res.status, headers, body }
  }
  const mask = (v) => {
    // paths of the temp dir, and the random port
    const tmp = srv.tmp
    return JSON.parse(JSON.stringify(v ?? null).split(tmp).join('<tmp>').split(String(srv.port)).join('<port>'))
  }
  const BP = '/audiobookshelf'
  const snapshot = (ctx, v, label) => matchSnapshot(ctx, mask(v), label ? { label } : {})

  /** log lines without the timestamp, tmp paths, port and versions */
  const logLines = (s) =>
    s.lines
      .map((l) => l.replace(/^\[[^\]]+\]\s*/, '').split(s.tmp).join('<tmp>').split(String(s.port)).join('<port>'))
      .filter((l) => !/Received ping/.test(l)) // one per readiness poll
      .map((l) => l.replace(/\d{4}-\d{2}-\d{2}\.txt/, '<date>.txt').replace(/v\d+\.\d+\.\d+[-\w.]*/g, 'v<version>').replace(/Node\.js Version: .*/, 'Node.js Version: <node>').replace(/Platform: .*/, 'Platform: <platform>').replace(/Arch: .*/, 'Arch: <arch>'))

  async function ws(p) {
    return new Promise((resolve) => {
      const sock = new WebSocket(`ws://127.0.0.1:${srv.port}${p}/?EIO=4&transport=websocket`)
      const got = []
      sock.on('message', (m) => {
        const msg = m.toString()
        got.push(msg[0] === '0' ? '0{open}' : msg.replace(/"sid":"[^"]+"/, '"sid":"<sid>"'))
        if (msg[0] === '0') sock.send('40')
        if (msg.startsWith('40')) sock.close()
      })
      sock.on('close', () => resolve({ opened: true, got }))
      sock.on('error', (e) => resolve({ opened: false, error: e.message.replace(String(srv.port), '<port>') }))
    })
  }

  describe('default base path (/audiobookshelf), fresh server', () => {
    beforeEach(async () => {
      await boot()
    })

    it('logs the startup sequence', async function () {
      await sleep(300)
      snapshot(this, { lines: logLines(srv) })
    })

    it('creates the database and the metadata folders', async function () {
      const ls = (d) =>
        fs
          .readdirSync(d)
          .filter((n) => !/-(wal|shm)$/.test(n))
          .sort()
      snapshot(this, { config: ls(srv.cfg), metadata: ls(srv.meta) })
    })

    it('answers ping, healthcheck and status (not initialized)', async function () {
      snapshot(this, { ping: await get(`${BP}/ping`), healthcheck: await get(`${BP}/healthcheck`), status: await get(`${BP}/status`) })
    })

    it('prepends the base path to requests that lack it, and 404s unknown paths', async function () {
      snapshot(this, { bare: await get('/ping'), bareStatus: await get('/status'), unknown: await get(`${BP}/nope`), unknownApi: await get(`${BP}/api/nope`), prefixLookalike: await get('/audiobookshelfx/ping') })
    })

    it('sets the security headers and no x-powered-by', async function () {
      const res = await get(`${BP}/ping`)
      snapshot(this, { headers: res.headers })
      expect(res.headers['x-powered-by']).to.equal(undefined)
    })

    it('only sends CORS headers for the mobile origins on item cover/ebook routes (or allowed origins)', async function () {
      const cover = `${BP}/api/items/00000000-0000-4000-8000-000000000000/cover`
      snapshot(this, {
        capacitorCover: await get(cover, { headers: { origin: 'capacitor://localhost' } }),
        localhostCover: await get(cover, { headers: { origin: 'http://localhost' } }),
        otherOriginCover: await get(cover, { headers: { origin: 'https://evil.example' } }),
        optionsCover: await get(cover, { method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } }),
        capacitorPing: await get(`${BP}/ping`, { headers: { origin: 'capacitor://localhost' } }),
        optionsPing: await get(`${BP}/ping`, { method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } })
      })
    })

    it('requires authentication on /api but not on /hls, /public, /feed, /status', async function () {
      snapshot(this, {
        api: await get(`${BP}/api/libraries`),
        apiBadToken: await get(`${BP}/api/libraries`, { headers: { authorization: 'Bearer nope' } }),
        hls: await get(`${BP}/hls/unknown/output.m3u8`),
        publicShare: await get(`${BP}/public/share/unknown`),
        feed: await get(`${BP}/feed/unknown`),
        feedCover: await get(`${BP}/feed/unknown/cover`),
        feedItem: await get(`${BP}/feed/unknown/item/ep/file.mp3`)
      })
    })

    it('serves nothing for the web client when it has not been built, and a dynamic client route falls through to 404 or the index', async function () {
      snapshot(this, { root: await get(`${BP}/`), item: await get(`${BP}/item/abc`), library: await get(`${BP}/library/abc`), staticFile: await get(`${BP}/Logo.png`) })
    })

    it('mounts socket.io under both the base path and the legacy root path', async function () {
      snapshot(this, { legacy: await ws('/socket.io'), based: await ws(`${BP}/socket.io`), other: await ws('/other.io') })
    })

    it('shuts down on SIGINT: logs, exits with 0', async function () {
      srv.proc.kill('SIGINT')
      const { code, signal } = await srv.exit
      const lines = logLines(srv).filter((l) => /SIGINT|Stopping Server|Closed|closing|closed|Server stopped/i.test(l))
      snapshot(this, { code, signal, lines })
    })
  })

  describe('initializing a new server (POST /init)', () => {
    beforeEach(async () => {
      await boot()
    })

    it('creates the root user once, then answers 500 to a second /init', async function () {
      const before = await get(`${BP}/status`)
      const first = await get(`${BP}/init`, { method: 'POST', json: { newRoot: { username: 'root', password: 'pw' } } })
      const statusAfter = await get(`${BP}/status`)
      const again = await get(`${BP}/init`, { method: 'POST', json: { newRoot: { username: 'other', password: 'x' } } })
      snapshot(this, { before: before.body.isInit, first, statusAfter, again })
    })

    it('logs in with the password given to /init and reaches the api with the access token', async function () {
      const init = await get(`${BP}/init`, { method: 'POST', json: { newRoot: { username: 'boss', password: 'boss-pass' } } })
      const bad = await get(`${BP}/login`, { method: 'POST', json: { username: 'boss', password: 'wrong' } })
      const login = await get(`${BP}/login`, { method: 'POST', json: { username: 'boss', password: 'boss-pass' } })
      const token = login.body?.user?.accessToken
      expect(token).to.be.a('string')
      const auth = { authorization: `Bearer ${token}` }
      const libraries = await get(`${BP}/api/libraries`, { headers: auth })
      const me = await get(`${BP}/api/me`, { headers: auth })
      const status = await get(`${BP}/status`)
      const noPrefix = await get(`/api/libraries`, { headers: auth })
      const ping = await get(`${BP}/api/ping`, { headers: auth })
      const login2 = { ...login, body: { ...login.body, user: { ...login.body.user, accessToken: '<jwt>', token: '<jwt>' } } }
      snapshot(this, { init, bad, login: login2, libraries, me: { status: me.status, username: me.body?.username, type: me.body?.type }, status, noPrefix, ping })
    })

    it('treats an empty username as root and an empty password as no password', async function () {
      const init = await get(`${BP}/init`, { method: 'POST', json: { newRoot: {} } })
      const login = await get(`${BP}/login`, { method: 'POST', json: { username: 'root', password: '' } })
      snapshot(this, { init, loginStatus: login.status, loginUser: login.body?.user && { username: login.body.user.username, type: login.body.user.type } })
    })

    it('a /init request without newRoot throws inside the async handler: the unhandledRejection handler logs it and exits the whole process with 1', async function () {
      const res = await Promise.race([get(`${BP}/init`, { method: 'POST', json: {} }).catch((e) => ({ error: e.constructor.name })), sleep(5000).then(() => ({ hung: true }))])
      const { code, signal } = await Promise.race([srv.exit, sleep(10000).then(() => ({ code: 'still running' }))])
      const fatal = logLines(srv).filter((l) => /Unhandled rejection|TypeError/.test(l)).map((l) => l.slice(0, 80))
      snapshot(this, { res, code, signal, fatal })
    })
  })

  describe('empty base path with ALLOW_CORS and ALLOW_IFRAME', () => {
    beforeEach(async () => {
      await boot({ basePath: '', env: { ALLOW_CORS: '1', ALLOW_IFRAME: '1' } })
    })

    it('serves from the root and allows any origin (ALLOW_IFRAME is not applied on a fresh database)', async function () {
      snapshot(this, {
        ping: await get('/ping', { headers: { origin: 'https://anything.example' } }),
        status: await get('/status'),
        options: await get('/api/libraries', { method: 'OPTIONS', headers: { origin: 'https://anything.example' } }),
        prefixed: await get('/audiobookshelf/ping'),
        socket: await ws('/socket.io')
      })
    })

    it('logs the empty base path as /', async function () {
      snapshot(this, { lines: logLines(srv).filter((l) => /base path|Listening/i.test(l)) })
    })
  })

  describe('restart on an existing database', () => {
    it('keeps the root user, skips migrations, and applies ALLOW_IFRAME from the environment on the second start', async function () {
      const first = await boot({ env: { ALLOW_IFRAME: '1' } })
      tmpDirsToRemove.push(first.tmp)
      const firstHeaders = (await get(`${BP}/ping`)).headers
      await get(`${BP}/init`, { method: 'POST', json: { newRoot: { username: 'root', password: 'pw' } } })
      await shutdown(first, true)
      running.pop()

      const second = await boot({ tmp: first.tmp, env: { ALLOW_IFRAME: '1' } })
      const secondPing = await get(`${BP}/ping`)
      const status = await get(`${BP}/status`)
      const login = await get(`${BP}/login`, { method: 'POST', json: { username: 'root', password: 'pw' } })
      await sleep(200)
      snapshot(this, {
        firstHeaders,
        secondHeaders: secondPing.headers,
        isInit: status.body.isInit,
        hasPaths: 'ConfigPath' in status.body,
        loginStatus: login.status,
        lines: logLines(second).filter((l) => /absdatabase|MigrationManager|Db |Init|ServerSettings|JWT|Backups Found/i.test(l))
      })
    })
  })
})
