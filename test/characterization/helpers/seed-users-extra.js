/*
 * Extra test-data helpers for user related characterization tests (Me/User/ApiKey/Stats controllers).
 * Everything is created through the real models / the real password hashing code of the server.
 */
const cookieParser = require('cookie-parser')
const Database = require('../../../server/Database')
const LocalAuthStrategy = require('../../../server/auth/LocalAuthStrategy')

const hashPassword = (password) => LocalAuthStrategy.prototype.hashPassword.call(null, password)

/**
 * The harness app has no cookie-parser, but several controllers read req.cookies (as the real Server does).
 * Insert cookie-parser at the front of the express stack of the harness app.
 * @param {{ app: import('express').Express }} api
 */
function enableCookies(api) {
  api.app.use(cookieParser())
  const stack = api.app._router.stack
  stack.unshift(stack.pop())
}

/**
 * Give the harness app a working TokenManager and a JWT secret (normally done at server start). Returns a restore function.
 *
 * server/Server.js loads Auth (and so TokenManager) before Database. The harness and most test files load Database first, so
 * TokenManager ends up holding the half-initialised circular Database export and every code path that touches
 * Database.sessionModel (session invalidation on password change) throws. Load a fresh TokenManager now that Database is
 * complete and swap it into the harness' Auth instead.
 * @param {{ apiRouter: any }} api
 */
function setupTokens(api, secret = 'characterization-test-secret') {
  const id = require.resolve('../../../server/auth/TokenManager')
  const cached = require.cache[id]
  delete require.cache[id]
  const FreshTokenManager = require(id)
  require.cache[id] = cached
  api.apiRouter.auth.tokenManager = new FreshTokenManager()
  FreshTokenManager.TokenSecret = secret
  return () => {
    FreshTokenManager.TokenSecret = null
  }
}

/**
 * Create a user with a real bcrypt password hash.
 * @param {{ username: string, type?: string, password?: string|null, permissions?: object, isActive?: boolean, email?: string }} o
 */
async function createUser(o) {
  const type = o.type || 'user'
  const permissions = { ...Database.userModel.getDefaultPermissionsForUserType(type), ...(o.permissions || {}) }
  return Database.userModel.create({
    username: o.username,
    email: o.email || null,
    pash: o.password ? await hashPassword(o.password) : '',
    token: `token-${o.username}`,
    type,
    isActive: o.isActive !== false,
    permissions,
    bookmarks: [],
    extraData: { seriesHideFromContinueListening: [] }
  })
}

/** `extra` for seed-library's createBook: audio files, duration, tags, narrators, genres */
function audioBookExtra({ id, duration = 3600, tags = [], narrators = [], genres = [], explicit = false } = {}) {
  const audioFiles = [audioFile('a.mp3', duration)]
  return { ...(id ? { id } : {}), audioFiles, duration, tags, narrators, genres, explicit }
}

/** Create a login session row for a user (what /api/login creates) */
function createAuthSession(user, o = {}) {
  const timestamps = o.createdAt || o.updatedAt ? { createdAt: o.createdAt, updatedAt: o.updatedAt } : {}
  return Database.sessionModel.create(
    {
      userId: user.id,
      ipAddress: o.ipAddress || '10.0.0.1',
      userAgent: o.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      refreshToken: o.refreshToken,
      lastRefreshToken: o.lastRefreshToken || null,
      expiresAt: o.expiresAt || new Date(Date.now() + 30 * 24 * 3600 * 1000),
      ...timestamps
    },
    { silent: !!o.updatedAt }
  )
}

/**
 * Create a playback (listening) session row with fixed timestamps.
 * @param {{ user: any, libraryItem: any, book: any, library: any }} ctx
 * @param {{ at: string, timeListening?: number, title?: string, authors?: string[], narrators?: string[], genres?: string[], date?: string, dayOfWeek?: string, currentTime?: number }} o
 */
function createPlaybackSession({ user, libraryItem, book, library }, o) {
  const at = new Date(o.at)
  return Database.playbackSessionModel.create(
    {
      userId: user.id,
      libraryId: library.id,
      mediaItemId: book.id,
      mediaItemType: 'book',
      displayTitle: o.title || book.title,
      displayAuthor: (o.authors || []).join(', '),
      duration: book.duration || 3600,
      playMethod: 0,
      mediaPlayer: 'test-player',
      startTime: 0,
      currentTime: o.currentTime ?? 60,
      serverVersion: '2.0.0-test',
      timeListening: o.timeListening ?? 60,
      mediaMetadata: { title: o.title || book.title, authors: (o.authors || []).map((name) => ({ id: `au-${name}`, name })), narrators: o.narrators || [], genres: o.genres || [] },
      date: o.date || o.at.slice(0, 10),
      dayOfWeek: o.dayOfWeek || 'Friday',
      extraData: { libraryItemId: libraryItem.id },
      createdAt: at,
      updatedAt: at
    },
    { silent: true }
  )
}

/** Force createdAt (and optionally other columns) on an existing row, e.g. to place a book in a given year */
function setRow(model, id, values) {
  return model.update(values, { where: { id }, silent: true })
}

/** Deterministic uuid for fixtures whose database order depends on the id (e.g. media progress is returned in mediaItemId order) */
const fixedId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function audioFile(name, duration) {
  return {
    index: 1,
    ino: name,
    metadata: { filename: name, ext: '.mp3', path: `/x/${name}`, relPath: name, size: 1000, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1 },
    addedAt: 1,
    updatedAt: 1,
    trackNumFromMeta: null,
    discNumFromMeta: null,
    trackNumFromFilename: null,
    discNumFromFilename: null,
    manuallyVerified: false,
    format: 'MP3',
    duration,
    bitRate: 64000,
    language: null,
    codec: 'mp3',
    timeBase: '1/14112000',
    channels: 2,
    channelLayout: 'stereo',
    chapters: [],
    embeddedCoverArt: null,
    metaTags: {},
    mimeType: 'audio/mpeg'
  }
}

/**
 * Podcast + library item + episodes.
 * @param {{ library: any, folder: any }} lf podcast library from createLibrary({ mediaType: 'podcast' })
 * @param {{ title: string, episodes: { id: string, title: string, duration?: number }[], tags?: string[] }} o
 */
async function createPodcast({ library, folder }, o) {
  const podcast = await Database.podcastModel.create({ title: o.title, author: 'Pod Author', tags: o.tags || [], genres: [], numEpisodes: o.episodes.length })
  const libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: library.id, libraryFolderId: folder.id, path: `${folder.path}/${o.title}`, relPath: o.title })
  const episodes = []
  let index = 1
  for (const e of o.episodes) {
    episodes.push(await Database.podcastEpisodeModel.create({ id: e.id, podcastId: podcast.id, index: index++, title: e.title, audioFile: audioFile(`${e.title}.mp3`, e.duration || 1800), chapters: [], extraData: {} }))
  }
  return { podcast, libraryItem, episodes }
}

/**
 * Create a media progress row (what the progress routes create) with fixed timestamps.
 * @param {any} user
 * @param {{ libraryItem: any, mediaItemId: string, episode?: boolean, podcastId?: string, duration: number, currentTime?: number, isFinished?: boolean, hidden?: boolean, updatedAt: string, finishedAt?: string, ebookProgress?: number }} o
 */
function createProgress(user, o) {
  const at = new Date(o.updatedAt)
  const progress = o.isFinished ? 1 : o.duration ? (o.currentTime || 0) / o.duration : 0
  return Database.mediaProgressModel.create(
    {
      userId: user.id,
      mediaItemId: o.mediaItemId,
      mediaItemType: o.episode ? 'podcastEpisode' : 'book',
      podcastId: o.podcastId || null,
      duration: o.duration,
      currentTime: o.currentTime || 0,
      isFinished: !!o.isFinished,
      hideFromContinueListening: !!o.hidden,
      ebookProgress: o.ebookProgress || 0,
      finishedAt: o.finishedAt ? new Date(o.finishedAt) : null,
      extraData: { libraryItemId: o.libraryItem.id, progress },
      createdAt: at,
      updatedAt: at
    },
    { silent: true }
  )
}

module.exports = { fixedId, audioFile, createPodcast, createProgress, setRow, enableCookies, setupTokens, createUser, audioBookExtra, createAuthSession, createPlaybackSession, hashPassword }
