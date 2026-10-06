/*
 * Extra helpers for the "delivery" controllers (Email, Notification, RSSFeed, Share):
 *  - visibleFileBook: a book with real audio files on disk that is visible to non-admin users (explicit = false)
 *  - stubTransport: record SMTP calls instead of connecting (sinon stub of nodemailer.createTransport)
 *  - stubAxiosPost: record apprise calls instead of using the network
 *  - resetShareManager: ShareManager is a module singleton, so clear its state between tests
 *  - mountPublicRouter: mounts the real PublicRouter on api.app under /public (like Server.js does) with no login stub
 */
const path = require('path')
const sinon = require('sinon')
const nodemailer = require('nodemailer')
const axios = require('axios')
const PublicRouter = require('../../../server/routers/PublicRouter')
const ShareManager = require('../../../server/managers/ShareManager')
const PlaybackSessionManager = require('../../../server/managers/PlaybackSessionManager')
const { createFileBook } = require('./seed-items-extra')

/** Library folder inside the harness temp dir (createFileBook writes real files there) */
function libraryFolderPath(api, name = 'books') {
  return path.join(api.tmp, name)
}

/**
 * Book with two audio files (and optionally an ebook), visible to every user type. `n` gives a stable ascending id.
 * @param {{ library:any, folder:any }} lf
 * @param {{ title: string, n?: number, audio?: boolean, ebook?: boolean, extra?: object, cover?: string, images?: {filename:string, ino:string}[], authors?: string[], series?: {name:string, sequence?:string}[], isFile?: boolean }} o
 */
function visibleFileBook(lf, o) {
  const n = o.n ?? 1
  const pad = String(n).padStart(2, '0')
  return createFileBook(lf, {
    title: o.title,
    authors: o.authors,
    series: o.series,
    cover: o.cover,
    images: o.images,
    isFile: o.isFile,
    audio:
      o.audio === false
        ? []
        : [
            { filename: 'part1.mp3', ino: `${n}01`, duration: 60 },
            { filename: 'part2.mp3', ino: `${n}02`, duration: 30 }
          ].slice(0, o.isFile ? 1 : 2),
    ebooks: o.ebook ? [{ filename: 'book.epub', ino: `${n}03`, primary: true }] : [],
    explicit: false,
    extra: { id: `b0000000-0000-4000-8000-0000000000${pad}`, ...(o.extra || {}) }
  })
}

/**
 * Stub nodemailer.createTransport. `transport.verify`/`sendMail` are sinon stubs recording the calls.
 * @param {{ verify?: Function, sendMail?: Function }} [o]
 */
function stubTransport(o = {}) {
  const transport = {
    verify: sinon.stub().callsFake(o.verify || (async () => true)),
    sendMail: sinon.stub().callsFake(o.sendMail || (async () => ({ messageId: 'fake-message-id' })))
  }
  const createTransport = sinon.stub(nodemailer, 'createTransport').callsFake(() => transport)
  return { transport, createTransport }
}

/** Replace axios.post (used for apprise). The stub's calls hold [url, payload, config]. */
function stubAxiosPost(impl) {
  return sinon.stub(axios, 'post').callsFake(impl || (async () => ({ data: { ok: true } })))
}

function resetShareManager() {
  for (const s of ShareManager.openMediaItemShares) s.timeout?.clear()
  ShareManager.openMediaItemShares = []
  ShareManager.openSharePlaybackSessions = []
}

/**
 * Mount the REAL PublicRouter on api.app at /public (as Server.js does). The harness only mounts ApiRouter under /api
 * behind the stub login; the public routes have no login. getDeviceInfo is the real PlaybackSessionManager method
 * (IP / user agent parsing, device row in the in-memory DB); the rest of that manager is not needed by the share routes.
 */
function mountPublicRouter(api) {
  const playbackSessionManager = { getDeviceInfo: PlaybackSessionManager.prototype.getDeviceInfo }
  const publicRouter = new PublicRouter(playbackSessionManager)
  api.app.use('/public', publicRouter.router)
  return publicRouter
}

module.exports = { libraryFolderPath, visibleFileBook, stubTransport, stubAxiosPost, resetShareManager, mountPublicRouter }
