/*
 * Extra test-data helpers for Library/Author/Series characterization tests (authors with metadata, podcasts, media progress...).
 * Created through the real models with only the fields a test needs.
 */
const Database = require('../../../server/Database')
const { createBook } = require('./seed-library')

/**
 * @param {{ id: string }} library
 * @param {{ name: string, description?: string, asin?: string, imagePath?: string, lastFirst?: string }} o
 */
async function createAuthor(library, o) {
  return Database.authorModel.create({ name: o.name, lastFirst: o.lastFirst ?? Database.authorModel.getLastFirst(o.name), description: o.description ?? null, asin: o.asin ?? null, imagePath: o.imagePath ?? null, libraryId: library.id })
}

/** Link an existing author to an existing book */
async function linkAuthor(book, author) {
  return Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
}

/**
 * createBook with explicit=false (createBook leaves it NULL, and users without explicit-content access only see books where
 * explicit = 0, so NULL books are invisible to the default 'user' and 'guest' accounts).
 */
function createVisibleBook(lf, o) {
  return createBook(lf, { ...o, extra: { explicit: false, ...(o.extra || {}) } })
}

/** A complete audio file record (as stored in book.audioFiles) so items count as having tracks */
function makeAudioFile(dir, filename, duration, index = 1) {
  return {
    index,
    ino: String(1000 + index),
    metadata: { filename, ext: '.mp3', path: `${dir}/${filename}`, relPath: filename, size: 1000, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1 },
    addedAt: 1,
    updatedAt: 1,
    trackNumFromMeta: index,
    discNumFromMeta: null,
    trackNumFromFilename: null,
    discNumFromFilename: null,
    manuallyVerified: false,
    format: 'MP3',
    duration,
    bitRate: 128000,
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
 * @param {{ library: any, folder: any }} lf
 * @param {{ title: string, itunesId?: string, feedURL?: string, episodes?: string[], extra?: object }} o
 */
async function createPodcast({ library, folder }, o) {
  const podcast = await Database.podcastModel.create({ title: o.title, titleIgnorePrefix: o.title, author: 'Pod Author', feedURL: o.feedURL ?? null, itunesId: o.itunesId ?? null, description: 'about', tags: [], genres: ['Tech'], explicit: false, numEpisodes: (o.episodes || []).length, ...(o.extra || {}) })
  const libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: podcast.id, mediaType: 'podcast', libraryId: library.id, libraryFolderId: folder.id, path: `${folder.path}/${o.title}`, relPath: o.title })
  const episodes = []
  let index = 1
  for (const title of o.episodes || []) {
    episodes.push(
      await Database.podcastEpisodeModel.create({
        podcastId: podcast.id,
        title,
        index,
        season: '',
        episode: '',
        episodeType: 'full',
        pubDate: 'Mon, 01 Jan 2024 00:00:00 GMT',
        publishedAt: new Date(Date.UTC(2024, 0, index)),
        audioFile: { index: 1, metadata: { filename: `${title}.mp3`, path: `${libraryItem.path}/${title}.mp3`, relPath: `${title}.mp3`, size: 1000 }, duration: 600, ino: String(index) },
        chapters: []
      })
    )
    index++
  }
  return { podcast, libraryItem, episodes }
}

/** Book progress row for a user (User objects are cached per request, so call before the first request as that user) */
async function setProgress(user, bookId, o = {}) {
  return Database.mediaProgressModel.create({ userId: user.id, mediaItemId: bookId, mediaItemType: 'book', duration: 100, currentTime: o.isFinished ? 100 : (o.currentTime ?? 10), isFinished: !!o.isFinished, extraData: {}, ...(o.isFinished ? { finishedAt: new Date() } : {}) })
}

/**
 * Extra user (type 'user' by default) with tweaked permissions, e.g. createUser('limited', 'user', (p) => { p.accessAllLibraries = false; p.librariesAccessible = [id] })
 * Authenticate as it with api.request(..., { as: 'limited' }).
 */
async function createUser(username, type = 'user', tweak) {
  const permissions = Database.userModel.getDefaultPermissionsForUserType(type)
  if (tweak) tweak(permissions)
  return Database.userModel.create({ username, pash: 'hash', token: `token-${username}`, type, isActive: true, permissions, bookmarks: [], extraData: { seriesHideFromContinueListening: [] } })
}

module.exports = { makeAudioFile, createVisibleBook, createAuthor, linkAuthor, createPodcast, setProgress, createUser }
