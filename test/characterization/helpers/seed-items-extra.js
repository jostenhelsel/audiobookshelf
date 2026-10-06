/*
 * Extra test-data helpers for library item characterization tests: items backed by REAL small files on disk
 * (inside the harness temp dir), with audio files, ebooks, images, chapters, podcasts and episodes.
 * File inodes are fixed strings so snapshots are stable.
 */
const fs = require('fs')
const path = require('path')
const Database = require('../../../server/Database')

// smallest valid 1x1 PNG
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const TIMES = { mtimeMs: 1000, ctimeMs: 1000, birthtimeMs: 1000 }

function fileMetadata(filePath, root, size) {
  const filename = path.basename(filePath)
  return { filename, ext: path.extname(filename), path: filePath, relPath: path.relative(root, filePath), size, ...TIMES }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return fs.statSync(filePath).size
}

function audioFileObject({ filePath, root, ino, index, duration, size, exclude }) {
  return {
    index,
    ino,
    metadata: fileMetadata(filePath, root, size),
    addedAt: 2000,
    updatedAt: 2000,
    trackNumFromMeta: index,
    discNumFromMeta: null,
    trackNumFromFilename: null,
    discNumFromFilename: null,
    manuallyVerified: false,
    exclude: !!exclude,
    format: 'MP2/3 (MPEG audio layer 2/3)',
    duration,
    bitRate: 64000,
    language: null,
    codec: 'mp3',
    timeBase: '1/14112000',
    channels: 2,
    channelLayout: 'stereo',
    chapters: [],
    metaTags: {},
    mimeType: 'audio/mpeg'
  }
}

/**
 * Book library item whose files exist on disk.
 * @param {{ library: any, folder: any }} lf result of createLibrary (folder.path must be a real writable dir)
 * @param {{
 *  title: string, dir?: string, authors?: string[], series?: {name:string, sequence?:string}[], tags?: string[], explicit?: boolean, chapters?: object[],
 *  audio?: {filename:string, ino:string, duration?:number, content?:string, exclude?:boolean}[],
 *  ebooks?: {filename:string, ino:string, primary?:boolean}[],
 *  images?: {filename:string, ino:string}[],
 *  cover?: string, isFile?: boolean, extra?: object
 * }} o
 */
async function createFileBook({ library, folder }, o) {
  const dirName = o.dir || o.title
  const itemPath = path.join(folder.path, dirName)
  fs.mkdirSync(o.isFile ? folder.path : itemPath, { recursive: true })

  const audioFiles = []
  const libraryFiles = []
  let ebookFile = null
  let totalSize = 0
  const rootForRel = o.isFile ? folder.path : itemPath
  const addLibraryFile = (filePath, ino, size, isSupplementary = null) => libraryFiles.push({ ino, metadata: fileMetadata(filePath, rootForRel, size), isSupplementary, addedAt: 2000, updatedAt: 2000 })

  let index = 1
  for (const a of o.audio || []) {
    const filePath = o.isFile ? path.join(folder.path, a.filename) : path.join(itemPath, a.filename)
    const size = writeFile(filePath, a.content ?? `audio ${a.filename}`)
    totalSize += size
    audioFiles.push(audioFileObject({ filePath, root: rootForRel, ino: a.ino, index: a.exclude ? -1 : index++, duration: a.duration ?? 60, size, exclude: a.exclude }))
    addLibraryFile(filePath, a.ino, size)
  }
  for (const e of o.ebooks || []) {
    const filePath = path.join(itemPath, e.filename)
    const size = writeFile(filePath, `ebook ${e.filename}`)
    addLibraryFile(filePath, e.ino, size, !e.primary)
    if (e.primary) ebookFile = { ino: e.ino, metadata: fileMetadata(filePath, rootForRel, size), ebookFormat: path.extname(e.filename).slice(1), addedAt: 2000, updatedAt: 2000 }
  }
  for (const img of o.images || []) {
    const filePath = path.join(itemPath, img.filename)
    const size = writeFile(filePath, PNG_1X1)
    addLibraryFile(filePath, img.ino, size)
  }

  const book = await Database.bookModel.create({
    title: o.title,
    audioFiles,
    ebookFile,
    tags: o.tags || [],
    narrators: [],
    genres: [],
    chapters: o.chapters || [],
    explicit: !!o.explicit,
    coverPath: o.cover ? path.join(itemPath, o.cover) : null,
    duration: audioFiles.filter((a) => !a.exclude).reduce((sum, a) => sum + a.duration, 0),
    ...(o.extra || {})
  })
  const libraryItem = await Database.libraryItemModel.create({
    libraryFiles,
    mediaId: book.id,
    mediaType: 'book',
    libraryId: library.id,
    libraryFolderId: folder.id,
    path: o.isFile ? audioFiles[0].metadata.path : itemPath,
    relPath: o.isFile ? audioFiles[0].metadata.filename : dirName,
    isFile: !!o.isFile,
    isMissing: false,
    isInvalid: false,
    mtime: new Date(1000),
    ctime: new Date(1000),
    birthtime: new Date(1000),
    size: totalSize
  })
  for (const name of o.authors || []) {
    const [author] = await Database.authorModel.findOrCreate({ where: { name, libraryId: library.id }, defaults: { name, libraryId: library.id } })
    await Database.bookAuthorModel.create({ bookId: book.id, authorId: author.id })
  }
  for (const s of o.series || []) {
    const [series] = await Database.seriesModel.findOrCreate({ where: { name: s.name, libraryId: library.id }, defaults: { name: s.name, libraryId: library.id } })
    await Database.bookSeriesModel.create({ bookId: book.id, seriesId: series.id, sequence: s.sequence ?? null })
  }
  return { book, libraryItem, itemPath }
}

/**
 * Podcast library item with episodes whose audio files exist on disk.
 * @param {{ library: any, folder: any }} lf
 * @param {{ title: string, dir?: string, author?: string, autoDownloadSchedule?: string, episodes?: {title:string, filename:string, ino:string, duration?:number}[] }} o
 */
async function createFilePodcast({ library, folder }, o) {
  const dirName = o.dir || o.title
  const itemPath = path.join(folder.path, dirName)
  fs.mkdirSync(itemPath, { recursive: true })
  const podcast = await Database.podcastModel.create({
    title: o.title,
    author: o.author || null,
    tags: [],
    genres: [],
    autoDownloadEpisodes: false,
    autoDownloadSchedule: o.autoDownloadSchedule || '0 0 * * 1',
    numEpisodes: (o.episodes || []).length
  })
  const libraryFiles = []
  let totalSize = 0
  const episodes = []
  let index = 1
  for (const e of o.episodes || []) {
    const filePath = path.join(itemPath, e.filename)
    const size = writeFile(filePath, `episode ${e.filename}`)
    totalSize += size
    const audioFile = audioFileObject({ filePath, root: itemPath, ino: e.ino, index: 1, duration: e.duration ?? 30, size })
    libraryFiles.push({ ino: e.ino, metadata: audioFile.metadata, isSupplementary: null, addedAt: 2000, updatedAt: 2000 })
    // fixed ascending ids: episodes are loaded in primary key order, random uuids would make the order (and snapshots) vary
    episodes.push(await Database.podcastEpisodeModel.create({ id: `e0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, podcastId: podcast.id, index: index++, title: e.title, audioFile, chapters: [], extraData: {}, publishedAt: new Date(5000 * index) }))
  }
  const libraryItem = await Database.libraryItemModel.create({
    libraryFiles,
    mediaId: podcast.id,
    mediaType: 'podcast',
    libraryId: library.id,
    libraryFolderId: folder.id,
    path: itemPath,
    relPath: dirName,
    isFile: false,
    isMissing: false,
    isInvalid: false,
    mtime: new Date(1000),
    ctime: new Date(1000),
    birthtime: new Date(1000),
    size: totalSize
  })
  return { podcast, episodes, libraryItem, itemPath }
}

/** Poll until `fn()` is truthy (for work that continues after the HTTP response was sent). */
async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

module.exports = { createFileBook, createFilePodcast, waitFor, PNG_1X1 }
