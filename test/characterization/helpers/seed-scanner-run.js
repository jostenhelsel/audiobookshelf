/*
 * Drive the real scanner against a generated tree and view the result, for the scanner characterization tests.
 *   const ctx = await setupScan(api, root, { mediaType, settings })
 *   const scan = await runScan(ctx, { force })       // LibraryScanner.scanLibrary, the same code path as a library scan
 *   const items = await viewItems(ctx)               // expanded library items, scrubbed of machine-specific values
 */
const Database = require('../../../server/Database')
const LibraryScanner = require('../../../server/scanner/LibraryScanner')
const LibraryScan = require('../../../server/scanner/LibraryScan')
const { createScanLibrary } = require('./seed-scanner-fs')

// values that differ per machine/ffmpeg build (inode numbers, file sizes of encoded audio, encoder version strings, bit rates)
const DROP_KEYS = new Set(['ino', 'size', 'bitRate', 'timeBase', 'tagEncoder', 'lastScanVersion', 'addedAt', 'updatedAt', 'birthtimeMs', 'ctimeMs', 'mtimeMs', 'birthtime', 'ctime', 'mtime', 'lastScan', 'createdAt', 'tracks'])
const ROUND_KEYS = new Set(['duration', 'start', 'end'])

/** remove nondeterministic values and round durations to whole seconds (encoders differ by a few ms) */
function scrub(value, { keepSize = false } = {}) {
  const walk = (v, key) => {
    if (Array.isArray(v)) {
      const arr = v.map((x) => walk(x, key))
      // libraryFiles come back in filesystem order, which differs between machines
      if (key === 'libraryFiles') arr.sort((a, b) => (a.metadata.relPath < b.metadata.relPath ? -1 : a.metadata.relPath > b.metadata.relPath ? 1 : 0))
      return arr
    }
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v)) {
        if (DROP_KEYS.has(k) && !(keepSize && k === 'size')) continue
        out[k] = walk(v[k], k)
      }
      return out
    }
    if (typeof v === 'number' && ROUND_KEYS.has(key)) return Math.round(v)
    if (typeof v === 'string') return v.replace(/\/file\/\d+/g, '/file/<ino>') // track contentUrl embeds the inode
    return v
  }
  return walk(value)
}

/**
 * @param {import('./harness').Api|any} api
 * @param {string} root library folder path
 * @param {{ mediaType?: 'book'|'podcast', settings?: object, name?: string }} [o]
 */
async function setupScan(api, root, o = {}) {
  const { library, folder } = await createScanLibrary(root, o)
  return { api, root, library, folder, mediaType: o.mediaType || 'book', logs: [] }
}

// lines about changed mtime/ctime/birthtime depend on whether two writes landed in the same millisecond, so they are left out of the logs
const TIME_LOG = /key "(mtime|ctime|birthtime|mtimeMs|ctimeMs|birthtimeMs)"|changed: \[/

/** a new LibraryScan per run, like LibraryScanner.scan() makes; returns result counts and log lines */
async function runScan(ctx, { force = false } = {}) {
  await ctx.library.reload({ include: Database.libraryFolderModel })
  const libraryScan = new LibraryScan()
  libraryScan.setData(ctx.library)
  libraryScan.verbose = false
  const canceled = await LibraryScanner.scanLibrary(libraryScan, force)
  ctx.lastScan = libraryScan
  return {
    canceled,
    added: libraryScan.resultsAdded,
    updated: libraryScan.resultsUpdated,
    missing: libraryScan.resultsMissing,
    logs: libraryScan.logs.filter((l) => !TIME_LOG.test(l.message)).map((l) => `${l.levelName}: ${l.message}`.replace(/inode value "\d+"/g, 'inode value "<ino>"'))
  }
}

/** expanded library items of the library, sorted by relPath */
async function viewItems(ctx, opts) {
  const rows = await Database.libraryItemModel.findAll({ where: { libraryId: ctx.library.id } })
  const items = []
  for (const row of rows) {
    const expanded = await Database.libraryItemModel.getExpandedById(row.id)
    items.push(scrub(expanded.toOldJSONExpanded(), opts))
  }
  return items.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
}

/**
 * Replace the random ids of the library's rows (library, folder, items, books, authors, series) with stable labels, so snapshots
 * do not depend on the order the filesystem listed the items in (uuid labels are otherwise numbered by first appearance).
 * Log lines and emitted events of a scan that touched several items are sorted for the same reason.
 * @param {any} ctx from setupScan
 * @param {any} value JSON-able value
 * @param {{ sortArrays?: string[] }} [o] keys of arrays of strings to sort (log lines, emitted event names)
 */
async function stable(ctx, value, o = {}) {
  const labels = new Map([
    [ctx.library.id, '<library>'],
    [ctx.folder.id, '<folder>']
  ])
  for (const li of await Database.libraryItemModel.findAll({ where: { libraryId: ctx.library.id } })) {
    labels.set(li.id, `<item:${li.relPath}>`)
    labels.set(li.mediaId, `<book:${li.relPath}>`)
  }
  for (const a of await Database.authorModel.findAll({ where: { libraryId: ctx.library.id } })) labels.set(a.id, `<author:${a.name}>`)
  for (const se of await Database.seriesModel.findAll({ where: { libraryId: ctx.library.id } })) labels.set(se.id, `<series:${se.name}>`)
  let text = JSON.stringify(value)
  for (const [id, label] of labels) text = text.split(id).join(label)
  const out = JSON.parse(text)
  const sortKeys = new Set(o.sortArrays || ['logs', 'emitted'])
  const walk = (v, key) => {
    if (Array.isArray(v)) {
      const arr = v.map((x) => walk(x, key))
      if (sortKeys.has(key) && arr.every((x) => typeof x === 'string')) arr.sort()
      return arr
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return walk(out)
}

module.exports = { scrub, setupScan, runScan, viewItems, stable }
