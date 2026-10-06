const { expect } = require('chai')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createFileBook, waitFor } = require('./helpers/seed-items-extra')
const Database = require('../../server/Database')
const Auth = require('../../server/Auth')
const HlsRouter = require('../../server/routers/HlsRouter')
const PlaybackSessionManager = require('../../server/managers/PlaybackSessionManager')
const PlaybackSession = require('../../server/objects/PlaybackSession')
const DeviceInfo = require('../../server/objects/DeviceInfo')
const Stream = require('../../server/objects/Stream')

/*
 * server/routers/HlsRouter.js is mounted by Server.js as `router.use('/hls', this.hlsRouter.router)` with NO authentication
 * middleware (unlike /api, which sits behind auth.ifAuthNeeded(authMiddleware)). The router gets `auth` in its constructor and never
 * uses it. Here it is mounted the same way on the harness app (after the harness's /api stub login, which does not cover /hls).
 *
 * The real PlaybackSessionManager, PlaybackSession and Stream objects are used. Cases that need a stream directory with files
 * write them by hand next to the real Stream (or let the real ffmpeg transcode, in the last describe).
 *
 * Requests go through a raw http client so encoded dots/slashes in the path reach the server unnormalised.
 */
describe('HlsRouter (characterization)', function () {
  this.timeout(30000)

  let api, manager, lf

  const ffmpegAvailable = (() => {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  /** raw GET/HEAD/... with the path sent exactly as given */
  function hls(method, rawPath, { headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(api.base)
      const req = http.request({ host: url.hostname, port: url.port, method, path: rawPath, headers }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** Stable view of a response: status, selected headers (dates/etags only as presence), text body or a binary summary */
  function view(r) {
    const h = r.headers
    const type = h['content-type'] || null
    const out = {
      status: r.status,
      headers: {
        'content-type': type,
        'content-length': h['content-length'] ?? null,
        'content-range': h['content-range'] ?? null,
        'accept-ranges': h['accept-ranges'] ?? null,
        'cache-control': h['cache-control'] ?? null,
        'x-content-type-options': h['x-content-type-options'] ?? null,
        'access-control-allow-origin': h['access-control-allow-origin'] ?? null,
        'x-powered-by': h['x-powered-by'] ?? null,
        etag: h.etag ? '<present>' : null,
        'last-modified': h['last-modified'] ? '<present>' : null
      }
    }
    if (type && type.startsWith('text/html')) {
      // express' default error page: keep only the first line of the <pre> (the stack trace holds machine-specific paths and line numbers)
      const pre = /<pre>([\s\S]*?)<\/pre>/.exec(r.buf.toString())
      out.body = { htmlErrorPage: pre ? pre[1].split('<br>')[0] : r.buf.toString() }
      out.headers['content-length'] = '<html error page length>'
    } else if (type && (type.startsWith('text/') || type.includes('mpegurl') || type.includes('json'))) out.body = r.buf.toString()
    else out.body = { bytes: r.buf.length, firstByteHex: r.buf.length ? r.buf[0].toString(16) : null }
    return out
  }

  /** briefEmitted: record only "method:event" names (session payloads are large and timing dependent) */
  const snap = (ctx, value, label, extra = {}, o = {}) => {
    const all = api.emitted.splice(0)
    const emitted = o.briefEmitted ? all.map((e) => `${e.method}:${e.args.find((a) => typeof a === 'string' && a.startsWith('stream_')) ?? e.args[0]}`) : all
    matchSnapshot(ctx, { ...value, emitted, ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }

  /**
   * One snapshot entry per response ({ res }), so each case is compared on its own. Socket emissions must be empty unless
   * `emitted` is passed, in which case they are recorded as a last entry.
   */
  const snapEach = (ctx, responses, label, { emitted = false, extra } = {}) => {
    for (const [k, r] of Object.entries(responses)) matchSnapshot(ctx, { res: view(r) }, { label: `${label}: ${k}`, ids: ctx.ids, tmpDirs: [api.tmp] })
    const all = api.emitted.splice(0)
    if (emitted) matchSnapshot(ctx, { emitted: all, ...(extra || {}) }, { label: `${label}: emitted`, ids: ctx.ids, tmpDirs: [api.tmp] })
    else {
      expect(all).to.deep.equal([])
      if (extra) matchSnapshot(ctx, extra, { label: `${label}: state`, ids: ctx.ids, tmpDirs: [api.tmp] })
    }
  }

  async function seedItem(audio) {
    const { libraryItem } = await createFileBook(lf, { title: 'Hls Book', audio, explicit: false })
    return libraryItem
  }

  /** a real PlaybackSession + real (not started) Stream registered in the real manager, like startSession does for a transcode */
  async function openStream(libraryItem, user, startTime = 0) {
    const item = await Database.libraryItemModel.getExpandedById(libraryItem.id)
    const session = new PlaybackSession()
    session.setData(item, user.id, 'test-player', new DeviceInfo(), startTime, null)
    const stream = new Stream(session.id, manager.StreamsPath, user, item, null, startTime)
    session.stream = stream
    manager.sessions.push(session)
    return { session, stream }
  }

  const SHORT = [{ filename: 'part1.mp3', ino: '1', duration: 13 }]
  const LONG = [{ filename: 'part1.mp3', ino: '1', duration: 600 }]

  beforeEach(async function () {
    api = await startApi()
    api.users = await api.seed.users()
    lf = await createLibrary({ name: 'Books', path: path.join(api.tmp, 'books') })
    manager = new PlaybackSessionManager()
    api.apiRouter.playbackSessionManager = manager
    api.app.use('/hls', new HlsRouter(new Auth(), manager).router)
  })

  afterEach(async function () {
    for (const s of manager.sessions) if (s.stream) await s.stream.close()
    await api.stop()
  })

  describe('unknown stream and authentication', () => {
    it('answers 404 for an unknown stream id without any credentials', async function () {
      this.ids = new Map()
      const r = await hls('GET', '/hls/00000000-0000-4000-8000-000000000001/output.m3u8')
      snap(this, { res: view(r) }, 'unknown stream, no credentials')
    })

    it('does not look at credentials: a bogus token, an unknown test user and a real user behave the same', async function () {
      this.ids = new Map()
      const bearer = await hls('GET', '/hls/nope/output.m3u8', { headers: { authorization: 'Bearer not-a-token' } })
      const unknown = await hls('GET', '/hls/nope/output.m3u8', { headers: { 'x-test-user': 'ghost' } })
      const real = await hls('GET', '/hls/nope/output.m3u8', { headers: { 'x-test-user': 'root' } })
      snapEach(this, { bearer, unknown, real }, 'credential variants')
      // the same stub login protects /api: confirms the harness would have answered 401 had /hls been behind it
      const apiRes = await api.request('GET', '/api/libraries')
      expect(apiRes.status).to.equal(401)
    })

    it("serves another user's stream playlist to an anonymous caller (no ownership or permission check)", async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { stream } = await openStream(item, api.users.guest)
      await stream.generatePlaylist()
      const anon = await hls('GET', `/hls/${stream.id}/output.m3u8`)
      const asOther = await hls('GET', `/hls/${stream.id}/output.m3u8`, { headers: { 'x-test-user': 'admin' } })
      expect(anon.buf.toString()).to.equal(asOther.buf.toString())
      snapEach(this, { anon, asOther }, 'anonymous vs other user')
    })

    it('answers 404 once the session has no stream (closed)', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      const before = await hls('GET', `/hls/${session.id}/output.m3u8`)
      await stream.close()
      session.stream = null
      const after = await hls('GET', `/hls/${session.id}/output.m3u8`)
      snapEach(this, { before, after }, 'before and after close', { emitted: true })
    })

    it('treats the stream id as an opaque string: traversal, encoded slashes and case do not match a session', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      const out = {}
      for (const [label, p] of Object.entries({
        dotdot: '/hls/../output.m3u8',
        encodedDotdot: '/hls/%2e%2e/output.m3u8',
        encodedSlashInStream: `/hls/${session.id}%2f..%2f${session.id}/output.m3u8`,
        upperCaseId: `/hls/${session.id.toUpperCase()}/output.m3u8`,
        emptyStream: '/hls//output.m3u8'
      })) {
        out[label] = await hls('GET', p)
      }
      snapEach(this, out, 'stream id variants')
    })
  })

  describe('route shape', () => {
    it('only GET /:stream/:file exists: other paths and methods get the express default 404 pages', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      const out = {}
      for (const [label, [m, p]] of Object.entries({
        root: ['GET', '/hls'],
        rootSlash: ['GET', '/hls/'],
        streamOnly: ['GET', `/hls/${session.id}`],
        streamSlash: ['GET', `/hls/${session.id}/`],
        extraSegment: ['GET', `/hls/${session.id}/a/output.m3u8`],
        post: ['POST', `/hls/${session.id}/output.m3u8`],
        put: ['PUT', `/hls/${session.id}/output.m3u8`],
        delete: ['DELETE', `/hls/${session.id}/output.m3u8`]
      })) {
        out[label] = await hls(m, p)
      }
      snapEach(this, out, 'other paths and methods')
    })

    it('serves HEAD like GET without a body and ignores the query string', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      const head = await hls('HEAD', `/hls/${session.id}/output.m3u8`)
      const withQuery = await hls('GET', `/hls/${session.id}/output.m3u8?token=abc&x=1`)
      const noQuery = await hls('GET', `/hls/${session.id}/output.m3u8`)
      expect(withQuery.buf.toString()).to.equal(noQuery.buf.toString())
      snapEach(this, { head, withQuery }, 'head and query')
    })
  })

  describe('playlist and file parameter handling', () => {
    it('serves the generated client playlist with its content type and caching headers', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      const uri = await stream.generatePlaylist()
      expect(uri).to.equal(`/hls/${session.id}/output.m3u8`)
      const r = await hls('GET', uri)
      snap(this, { res: view(r) }, 'client playlist', { clientPlaylistUri: uri })
    })

    it('honours Range and conditional requests through res.sendFile', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      const full = await hls('GET', `/hls/${session.id}/output.m3u8`)
      const range = await hls('GET', `/hls/${session.id}/output.m3u8`, { headers: { range: 'bytes=0-6' } })
      const badRange = await hls('GET', `/hls/${session.id}/output.m3u8`, { headers: { range: 'bytes=9999-99999' } })
      const notModified = await hls('GET', `/hls/${session.id}/output.m3u8`, { headers: { 'if-none-match': full.headers.etag } })
      snapEach(this, { full, range, badRange, notModified }, 'range and conditional')
    })

    it('rejects files whose extension is not .ts or .m3u8 with 400 (after the stream exists)', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      fs.writeFileSync(path.join(stream.streamPath, 'files.txt'), 'secret concat file')
      const out = {}
      for (const [label, f] of Object.entries({
        concatFile: 'files.txt',
        upperCase: 'output.M3U8',
        noExtension: 'output',
        m3u8Suffix: 'output.m3u8x',
        mp4: 'init.mp4',
        m4s: 'output-0.m4s',
        dotOnlyM3u8: '.m3u8',
        doubleExt: 'output.m3u8.txt',
        empty: ''
      })) {
        out[label] = await hls('GET', `/hls/${session.id}/${f}`)
      }
      snapEach(this, out, 'extension validation')
    })

    it('rejects path traversal in the file parameter with 400, before the extension check', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      // a real target outside the stream dir with a valid extension
      fs.writeFileSync(path.join(path.dirname(stream.streamPath), 'outside.ts'), 'outside stream dir')
      const out = {}
      for (const [label, f] of Object.entries({
        parentTs: '..%2foutside.ts',
        parentTsUpperHex: '..%2Foutside.ts',
        encodedDots: '%2e%2e%2foutside.ts',
        doubleParent: '..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
        parentPasswd: '..%2f..%2fetc%2fpasswd.ts',
        dotdot: '..',
        dot: '.',
        absolute: '%2fetc%2fpasswd',
        absoluteTs: '%2ftmp%2foutside.ts',
        backslash: '..%5coutside.ts',
        sameDirViaParent: `..%2f${session.id}%2foutput.m3u8`,
        dotSlash: '.%2foutput.m3u8',
        nullByte: 'output.m3u8%00.txt',
        nullByteTs: 'output.m3u8%00.ts',
        doubleEncoded: '%252e%252e%252foutside.ts'
      })) {
        out[label] = await hls('GET', `/hls/${session.id}/${f}`)
      }
      snapEach(this, out, 'path traversal attempts')
    })

    it('answers 404 for missing .ts and .m3u8 files and never emits stream_reset on a fresh stream', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      const out = {}
      for (const [label, f] of Object.entries({
        missingPlaylist: 'final-output.m3u8',
        segment: 'output-0.ts',
        farSegmentNoFurthest: 'output-500.ts',
        noNumber: 'output.ts',
        nonNumeric: 'output-abc.ts',
        negative: 'output--3.ts',
        extraDashes: 'a-5-6.ts'
      })) {
        out[label] = await hls('GET', `/hls/${session.id}/${f}`)
      }
      snapEach(this, out, 'missing files, fresh stream', { extra: { stream: { isResetting: stream.isResetting, furthestSegmentCreated: stream.furthestSegmentCreated } } })
    })

    it('parseSegmentFilename takes the number after the first dash of the basename', function () {
      const router = new HlsRouter(null, manager)
      const parsed = {}
      for (const f of ['output-12.ts', 'output-0.ts', 'output.ts', 'output-abc.ts', 'a-5-6.ts', 'output--3.ts', 'dir-7.m3u8', '-4.ts', 'output-1e2.ts', 'output- 8.ts']) parsed[f] = router.parseSegmentFilename(f)
      matchSnapshot(this, { parsed: Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, Number.isNaN(v) ? 'NaN' : v])) }, { label: 'segment number parsing' })
      expect(Number.isNaN(parsed['output.ts'])).to.equal(true)
    })

    it('validateStreamFilePath: accepts only paths strictly inside the stream dir (lexical check)', function () {
      const router = new HlsRouter(null, manager)
      const base = '/streams/abc'
      const cases = ['/streams/abc/a.ts', '/streams/abc/sub/a.ts', '/streams/abc', '/streams/abc/', '/streams/abcd/a.ts', '/streams/a.ts', '/etc/passwd', '/streams/abc/../abc/a.ts', '/streams/abc/..foo.ts']
      const results = {}
      for (const c of cases) results[c] = router.validateStreamFilePath(base, c)
      matchSnapshot(this, { results }, { label: 'validateStreamFilePath' })
      expect(results['/streams/abc/a.ts']).to.equal(true)
    })

    it('missing segment on a stream that is resetting: 404, no second reset', async function () {
      this.ids = new Map()
      const item = await seedItem(LONG)
      const { session, stream } = await openStream(item, api.users.root, 100)
      stream.isResetting = true
      const r = await hls('GET', `/hls/${session.id}/output-1.ts`)
      snap(this, { res: view(r), stream: { isResetting: stream.isResetting, startTime: stream.startTime } }, 'resetting stream')
    })

    it('missing segment before the stream start segment resets the stream, emits stream_reset and answers 404', async function () {
      this.ids = new Map()
      // 600s item, stream started at 100s: segmentStartNumber = floor((100 - 30) / 6) = 11, so segment 3 is "before the start"
      const item = await seedItem(LONG)
      const { session, stream } = await openStream(item, api.users.root, 100)
      expect(stream.segmentStartNumber).to.equal(11)
      const r = await hls('GET', `/hls/${session.id}/output-3.ts`)
      // reset() flips isResetting and calls start() (not awaited). The stream directory does not exist, so the real writeConcatFile
      // fails and the stream closes itself with an error: stream_reset first, then stream_error.
      await waitFor(() => api.emitted.some((e) => e.method === 'clientEmitter' && e.args[1] === 'stream_error'))
      snap(this, { res: view(r), stream: { startTime: stream.startTime, isResetting: stream.isResetting } }, 'reset before start segment')
    })

    it('missing segment far ahead of the furthest created segment resets the stream', async function () {
      this.ids = new Map()
      const item = await seedItem(LONG)
      const { session, stream } = await openStream(item, api.users.root)
      stream.furthestSegmentCreated = 5
      const near = await hls('GET', `/hls/${session.id}/output-15.ts`)
      const nearEmitted = api.emitted.splice(0)
      const far = await hls('GET', `/hls/${session.id}/output-16.ts`)
      await waitFor(() => api.emitted.some((e) => e.method === 'clientEmitter' && e.args[1] === 'stream_error'))
      snap(this, { near: view(near), nearEmitted, far: view(far), stream: { startTime: stream.startTime } }, 'reset when far ahead')
    })

    it('missing segment on a completed transcode is a plain 404 (no reset)', async function () {
      this.ids = new Map()
      const item = await seedItem(LONG)
      const { session, stream } = await openStream(item, api.users.root)
      stream.isTranscodeComplete = true
      stream.furthestSegmentCreated = 5
      const r = await hls('GET', `/hls/${session.id}/output-99.ts`)
      snap(this, { res: view(r) }, 'complete transcode, far segment')
    })
  })

  describe('files inside the stream directory', () => {
    it('serves .ts files and .m3u8 with their types; dotfiles, directories and symlinks', async function () {
      this.ids = new Map()
      const item = await seedItem(SHORT)
      const { session, stream } = await openStream(item, api.users.root)
      await stream.generatePlaylist()
      fs.writeFileSync(path.join(stream.streamPath, 'output-0.ts'), Buffer.from([0x47, 1, 2, 3]))
      fs.writeFileSync(path.join(stream.streamPath, '.hidden.ts'), 'dotfile')
      fs.mkdirSync(path.join(stream.streamPath, 'dir.ts'))
      fs.mkdirSync(path.join(stream.streamPath, 'dir.m3u8'))
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-hls-outside-'))
      try {
        fs.writeFileSync(path.join(outsideDir, 'secret.ts'), 'content outside the stream directory')
        fs.symlinkSync(path.join(outsideDir, 'secret.ts'), path.join(stream.streamPath, 'link.ts'))
        const out = {}
        for (const [label, f] of Object.entries({ segment: 'output-0.ts', dotfile: '.hidden.ts', dirTs: 'dir.ts', dirM3u8: 'dir.m3u8', symlinkOutside: 'link.ts' })) {
          out[label] = await hls('GET', `/hls/${session.id}/${f}`)
        }
        snapEach(this, out, 'special files')
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })

  describe('real ffmpeg transcode (success path)', function () {
    this.timeout(60000)
    let fixtureDir, mp3

    before(function () {
      if (!ffmpegAvailable) return this.skip()
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-hls-fixture-'))
      const file = path.join(fixtureDir, 'sine.mp3')
      try {
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=13', '-c:a', 'libmp3lame', '-b:a', '32k', '-y', file], { stdio: 'ignore' })
      } catch {
        fs.rmSync(fixtureDir, { recursive: true, force: true })
        fixtureDir = null
        return this.skip()
      }
      mp3 = fs.readFileSync(file)
    })

    after(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
    })

    async function startTranscode(userName = 'root') {
      const item = await seedItem([{ filename: 'part1.mp3', ino: '1', duration: 13, content: mp3 }])
      const res = await api.request('POST', `/api/items/${item.id}/play`, { as: userName, json: { forceTranscode: true, mediaPlayer: 'test-player', deviceInfo: { clientVersion: '1.0.0' } } })
      expect(res.status).to.equal(200)
      const stream = manager.getStream(res.body.id)
      expect(stream, 'stream registered in manager').to.not.equal(null)
      await waitFor(() => stream.isTranscodeComplete, 30000)
      return { res, stream, item }
    }

    it('POST /api/items/:id/play starts a transcode whose playlist and segments are served by /hls', async function () {
      this.ids = new Map()
      const { res, stream } = await startTranscode()
      const sid = res.body.id
      const playlist = await hls('GET', `/hls/${sid}/output.m3u8`)
      const finalPlaylist = await hls('GET', `/hls/${sid}/final-output.m3u8`)
      const segs = {}
      for (let i = 0; i < 4; i++) segs[`output-${i}.ts`] = await hls('GET', `/hls/${sid}/output-${i}.ts`)
      const finalLines = finalPlaylist.buf.toString().split('\n')
      expect(segs['output-0.ts'].buf.length % 188).to.equal(0)
      expect(segs['output-0.ts'].buf[0]).to.equal(0x47)
      const eventNames = [...new Set(api.emitted.map((e) => `${e.method}:${e.args.find((a) => typeof a === 'string' && a.startsWith('stream_')) || e.args[0]}`))].sort()
      matchSnapshot(
        this,
        {
          playMethod: res.body.playMethod,
          audioTracks: res.body.audioTracks.map((t) => ({ contentUrl: t.contentUrl, mimeType: t.mimeType, duration: t.duration })),
          playlist: view(playlist),
          finalPlaylist: {
            status: finalPlaylist.status,
            contentType: finalPlaylist.headers['content-type'],
            // ffmpeg's own EXTINF values vary by version, so only the structure is recorded
            tags: finalLines.filter((l) => l.startsWith('#') && !l.startsWith('#EXTINF')),
            segmentLines: finalLines.filter((l) => !l.startsWith('#') && l),
            extinfCount: finalLines.filter((l) => l.startsWith('#EXTINF')).length
          },
          // segment bytes depend on the ffmpeg build: record type, framing and presence only
          segments: Object.fromEntries(
            Object.entries(segs).map(([k, v]) => [k, v.status === 200 ? { status: 200, contentType: v.headers['content-type'], nonEmpty: v.buf.length > 0, tsFramed: v.buf.length % 188 === 0 && v.buf[0] === 0x47 } : view(v)])
          ),
          streamState: { isTranscodeComplete: stream.isTranscodeComplete, isResetting: stream.isResetting },
          eventNames
        },
        { label: 'transcode and serve', ids: this.ids, tmpDirs: [api.tmp] }
      )
    })

    it('a segment past the end of a completed transcode is 404 without reset; one before the stream start segment resets with stream_reset', async function () {
      this.ids = new Map()
      const { res, stream } = await startTranscode()
      const sid = res.body.id
      api.emitted.length = 0
      const past = await hls('GET', `/hls/${sid}/output-9.ts`)
      const pastEmitted = api.emitted.splice(0)
      // pretend the client had seeked: the stream started at 100s, so a segment before segmentStartNumber (11) forces a reset
      stream.startTime = 100
      const afterStart = await hls('GET', `/hls/${sid}/output-20.ts`)
      const early = await hls('GET', `/hls/${sid}/output-5.ts`)
      await waitFor(() => stream.isTranscodeComplete && !stream.isResetting, 30000)
      const resets = api.emitted.filter((e) => e.args[0] === 'stream_reset' || e.args[1] === 'stream_reset')
      snap(this, { past: view(past), pastEmitted, afterStart: view(afterStart), early: view(early), resets, startTime: stream.startTime }, 'seek reset after real transcode', {}, { briefEmitted: true })
    })

    it('after the stream is closed the same URLs answer 404 and the stream directory is gone', async function () {
      this.ids = new Map()
      const { res, stream } = await startTranscode()
      const sid = res.body.id
      const dir = stream.streamPath
      await stream.close()
      const playlist = await hls('GET', `/hls/${sid}/output.m3u8`)
      snap(this, { playlist: view(playlist), dirExists: fs.existsSync(dir), streamOnSession: manager.getSession(sid).stream }, 'after close', {}, { briefEmitted: true })
    })
  })
})
