/*
 * Test-data helpers for book/podcast libraries. Create rows through the real models, with only the required fields.
 * Extend in a NEW seed-<area>.js file if a test needs more; keep this one small and stable.
 */
const Database = require('../../../server/Database')

/**
 * @param {{ name?: string, mediaType?: 'book'|'podcast', path?: string }} [o]
 */
async function createLibrary(o = {}) {
  const mediaType = o.mediaType || 'book'
  const library = await Database.libraryModel.create({ name: o.name || (mediaType === 'book' ? 'Books' : 'Podcasts'), mediaType })
  const folder = await Database.libraryFolderModel.create({ path: o.path || `/test/${library.name.toLowerCase()}`, libraryId: library.id })
  return { library, folder }
}

/**
 * Book + library item, with optional authors and series (found or created by name in the library).
 * @param {{ library: any, folder: any }} lf result of createLibrary
 * @param {{ title: string, authors?: string[], series?: {name:string, sequence?:string}[], extra?: object }} o
 */
async function createBook({ library, folder }, o) {
  const book = await Database.bookModel.create({ title: o.title, audioFiles: [], tags: [], narrators: [], genres: [], chapters: [], ...(o.extra || {}) })
  const libraryItem = await Database.libraryItemModel.create({
    libraryFiles: [],
    mediaId: book.id,
    mediaType: 'book',
    libraryId: library.id,
    libraryFolderId: folder.id,
    path: `${folder.path}/${o.title}`,
    relPath: o.title
  })
  for (const name of o.authors || []) {
    const [author] = await Database.authorModel.findOrCreate({ where: { name, libraryId: library.id }, defaults: { name, libraryId: library.id } })
    await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
  }
  for (const s of o.series || []) {
    const [series] = await Database.seriesModel.findOrCreate({ where: { name: s.name, libraryId: library.id }, defaults: { name: s.name, libraryId: library.id } })
    await Database.bookSeriesModel.create({ bookId: book.id, seriesId: series.id, sequence: s.sequence ?? null })
  }
  return { book, libraryItem }
}

module.exports = { createLibrary, createBook }
