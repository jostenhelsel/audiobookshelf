/*
 * Extra test-data helpers for the Misc/FileSystem/Backup/CustomMetadataProvider characterization tests.
 */
const Database = require('../../../server/Database')

const fixedId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * Visible (explicit=false) book + item with tags and genres and a fixed id, so ordering is deterministic.
 * @param {{ library: any, folder: any }} lf
 * @param {{ n: number, title: string, tags?: string[], genres?: string[], itemPath?: string }} o
 */
async function createTaggedBook({ library, folder }, o) {
  const book = await Database.bookModel.create({ id: fixedId(o.n), title: o.title, titleIgnorePrefix: o.title, audioFiles: [], tags: o.tags || [], narrators: [], genres: o.genres || [], chapters: [], explicit: false })
  const libraryItem = await Database.libraryItemModel.create({
    id: fixedId(1000 + o.n),
    libraryFiles: [],
    mediaId: book.id,
    mediaType: 'book',
    libraryId: library.id,
    libraryFolderId: folder.id,
    path: o.itemPath || `${folder.path}/${o.title}`,
    relPath: o.title
  })
  return { book, libraryItem }
}

/**
 * Podcast + item with tags and genres and a fixed id.
 */
async function createTaggedPodcast({ library, folder }, o) {
  const podcast = await Database.podcastModel.create({ id: fixedId(500 + o.n), title: o.title, titleIgnorePrefix: o.title, author: 'Pod Author', tags: o.tags || [], genres: o.genres || [], explicit: false, numEpisodes: 0 })
  const libraryItem = await Database.libraryItemModel.create({
    id: fixedId(1500 + o.n),
    libraryFiles: [],
    mediaId: podcast.id,
    mediaType: 'podcast',
    libraryId: library.id,
    libraryFolderId: folder.id,
    path: o.itemPath || `${folder.path}/${o.title}`,
    relPath: o.title
  })
  return { podcast, libraryItem }
}

/** Custom metadata provider with a fixed id */
async function createProvider(o) {
  return Database.customMetadataProviderModel.create({ id: fixedId(o.n), name: o.name, mediaType: o.mediaType || 'book', url: o.url || 'https://example.invalid/search', authHeaderValue: o.authHeaderValue ?? null })
}

module.exports = { fixedId, createTaggedBook, createTaggedPodcast, createProvider }
