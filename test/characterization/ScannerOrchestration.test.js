const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const axios = require('axios')
const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { rmTree, mkTmp } = require('./helpers/seed-scanner-fs')
const media = require('./helpers/seed-scanner-media')
const { setupScan, runScan, viewItems, stable } = require('./helpers/seed-scanner-run')

const Database = require('../../server/Database')
const Logger = require('../../server/Logger')
const TaskManager = require('../../server/managers/TaskManager')
const Task = require('../../server/objects/Task')
const LibraryScan = require('../../server/scanner/LibraryScan')
const ScanLogger = require('../../server/scanner/ScanLogger')
const LibraryScanner = require('../../server/scanner/LibraryScanner')
const LibraryItemScanner = require('../../server/scanner/LibraryItemScanner')
const Scanner = require('../../server/scanner/Scanner')
const { LogLevel, ScanResult } = require('../../server/utils/constants')

const future = () => Date.now() / 1000 + 600 // a clearly later mtime for modified fixture files
const scanResultName = (n) => Object.keys(ScanResult).find((k) => ScanResult[k] === n)
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  return null
}

describe('ScannerOrchestration (characterization)', function () {
  this.timeout(60000)
  let api, root
  let savedTasks

  beforeEach(async () => {
    api = await startApi()
    root = mkTmp()
    savedTasks = TaskManager.tasks
    TaskManager.tasks = []
    scansStarted = 0
    savedBefore = 0
    // the real server has <metadata>/logs (the Logger creates it); LibraryScan.saveLog() only creates the last folder
    fs.mkdirSync(path.join(api.tmp, 'metadata', 'logs'), { recursive: true })
  })
  afterEach(async () => {
    // singleton state of the scanners
    LibraryScanner.cancelLibraryScan = {}
    LibraryScanner.librariesScanning = []
    LibraryScanner.scanningFilesChanged = false
    LibraryScanner.pendingFileUpdatesToScan = []
    TaskManager.tasks = savedTasks
    await api.stop()
    rmTree(root)
  })

  const snap = (ctx, value, label) => matchSnapshot(ctx, value, { label, tmpDirs: [root, api.tmp] })
  const needFfmpeg = function () {
    if (!media.hasFfmpeg()) this.skip()
  }
  const book = (...p) => path.join(root, 'Author', 'Book One', ...p)
  const bump = (file) => fs.utimesSync(file, future(), future())

  // task events as sent to clients, with the elapsed time (which varies) masked
  const maskElapsed = (value) =>
    JSON.parse(
      JSON.stringify(value)
        .replace(/"elapsed":\d+/g, '"elapsed":"<elapsed>"')
        .replace(/ \(\d+[^)"]*\)"/g, ' (<elapsed>)"')
    )
  const taskEvents = () => api.emitted.filter((e) => ['task_started', 'task_finished'].includes(e.args[0])).map((e) => ({ event: e.args[0], task: maskElapsed(e.args[1]) }))
  const loggerCalls = (level) =>
    Logger[level]
      .getCalls()
      .map((c) => c.args.map((a) => (a instanceof Error ? `Error: ${a.message}` : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))
      .map((l) => l.replace(/completed in \S+|canceled after \S+/, (m) => m.split(' ')[0] + ' <elapsed>').replace(/\d{4}-\d{2}-\d{2}_/, '<date>_'))

  // LibraryScanner.scan() saves the scan log without awaiting it, so the "Scan log saved" message can arrive during the next step
  let scansStarted = 0
  const savedLogCount = () => Logger.info.getCalls().filter((c) => /Scan log saved/.test(String(c.args[0]))).length
  let savedBefore = 0
  const scan = async (library, force) => {
    scansStarted++
    await LibraryScanner.scan(library, force)
    await waitFor(() => savedLogCount() + savedBefore >= scansStarted)
  }
  const resetLoggerHistory = () => {
    savedBefore += savedLogCount()
    Logger.info.resetHistory()
  }

  describe('LibraryScan and ScanLogger (no scan)', () => {
    it('LibraryScan: ids, counters, result strings, toJSON and logs', function () {
      const scan = new LibraryScan()
      const library = { id: 'lib-1', name: 'My Library', mediaType: 'book', libraryFolders: [{ path: '/x' }], toJSON: () => ({ id: 'lib-1', name: 'My Library' }) }
      const before = { id: scan.id, type: scan.type, stats: scan.resultStats }
      scan.setData(library)
      scan.resultsAdded = 2
      scan.resultsUpdated = 1
      scan.resultsMissing = 3
      scan.addLog(LogLevel.INFO, 'first', 'second', 3)
      scan.addLog(LogLevel.WARN, 'warning')
      scan.setComplete()
      scan.elapsed = 65000
      const none = new LibraryScan()
      none.setData(library, 'match')
      none.elapsed = 2000
      snap(this, {
        before,
        getters: { libraryId: scan.libraryId, libraryName: scan.libraryName, libraryMediaType: scan.libraryMediaType, libraryFolders: scan.libraryFolders, type: scan.type, idLooksLikeUuid: /^[0-9a-f-]{36}$/.test(scan.id) },
        resultStats: scan.resultStats,
        scanResults: scan.scanResults,
        noChanges: none.scanResults,
        noChangesType: none.type,
        json: { ...scan.toJSON(), id: '<id>', startedAt: '<t>', finishedAt: '<t>' },
        logs: scan.logs.map((l) => ({ levelName: l.levelName, level: l.level, message: l.message, hasTimestamp: !!l.timestamp })),
        logFilenameShape: scan.logFilename.replace(scan.id, '<id>').replace(/^\d{4}-\d{2}-\d{2}/, '<date>')
      })
    })

    it('LibraryScan.saveLog fails when <metadata>/logs does not exist (it creates only logs/scans, not parents)', async function () {
      fs.rmSync(path.join(api.tmp, 'metadata', 'logs'), { recursive: true })
      const scan = new LibraryScan()
      scan.setData({ id: 'lib-1', name: 'My Library', mediaType: 'book', libraryFolders: [], toJSON: () => ({ id: 'lib-1' }) })
      const error = await scan.saveLog().then(
        () => null,
        (err) => err.code
      )
      snap(this, { error })
    })

    it('LibraryScan.saveLog writes <metadata>/logs/scans/<date>_<id>.txt as json lines', async function () {
      const scan = new LibraryScan()
      scan.setData({ id: 'lib-1', name: 'My Library', mediaType: 'book', libraryFolders: [], toJSON: () => ({ id: 'lib-1' }) })
      scan.addLog(LogLevel.INFO, 'hello')
      scan.setComplete()
      await scan.saveLog()
      const dir = path.join(api.tmp, 'metadata', 'logs', 'scans')
      const files = fs.readdirSync(dir)
      const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').split('\n')
      snap(this, { files: files.map((f) => f.replace(scan.id, '<id>').replace(/^\d{4}-\d{2}-\d{2}/, '<date>')), lines: lines.length, endsWithNewline: lines[lines.length - 1] === '', header: Object.keys(JSON.parse(lines[0])), logKeys: Object.keys(JSON.parse(lines[1])), message: JSON.parse(lines[1]).message })
    })

    it('ScanLogger: same logging API without a library', function () {
      const sl = new ScanLogger()
      const before = { id: sl.id, type: sl.type, name: sl.name, authorsNumBooksChangedIds: [...sl.authorsNumBooksChangedIds] }
      sl.setData('libraryItem', 'Some/Item')
      sl.addLog(LogLevel.DEBUG, 'a', 'b')
      sl.addLog(LogLevel.ERROR, 'c')
      sl.setComplete()
      snap(this, { before, json: { ...sl.toJSON(), id: '<id>', startedAt: '<t>', finishedAt: '<t>' }, logs: sl.logs.map((l) => `${l.levelName}: ${l.message}`), hasElapsed: typeof sl.elapsed === 'number' })
    })
  })

  describe('LibraryScanner.scan: a whole library scan', () => {
    beforeEach(needFfmpeg)

    const makeBooks = () => {
      media.makeAudio(path.join(root, 'Author/Book One/01.mp3'), { tags: { album: 'Book One', artist: 'Author' } })
      media.makeAudio(path.join(root, 'Author/Book Two/01.mp3'), { tags: { album: 'Book Two', artist: 'Author' } })
      media.makeAudio(path.join(root, 'Standalone.mp3'), { tags: { album: 'Standalone' } })
    }
    const libraryRow = async (c) => {
      await c.library.reload()
      return { lastScanSet: !!c.library.lastScan, lastScanVersion: c.library.lastScanVersion, lastScanMetadataPrecedence: c.library.extraData?.lastScanMetadataPrecedence }
    }

    it('first scan: result counts, task events, library lastScan, items added in chunks and events', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await scan(c.library)
      snap(this, await stable(c, { tasks: taskEvents(), library: await libraryRow(c), items: (await viewItems(c)).map((i) => i.relPath), info: loggerCalls('info'), emitted: api.emitted.filter((e) => !String(e.args[0]).startsWith('task_')).map((e) => `${e.method}:${e.args[0]}`) }))
    })

    it('second scan with nothing changed: no changes needed', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await scan(c.library)
      api.emitted.length = 0
      resetLoggerHistory()
      await scan(c.library)
      snap(this, await stable(c, { tasks: taskEvents(), info: loggerCalls('info'), emitted: api.emitted.filter((e) => !String(e.args[0]).startsWith('task_')).map((e) => e.args[0]) }))
    })

    it('scan after changes: one added, one updated, one missing', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await scan(c.library)
      api.emitted.length = 0
      media.makeAudio(path.join(root, 'Author/Book Three/01.mp3'), { tags: { album: 'Book Three' } })
      media.makeAudio(path.join(root, 'Author/Book One/02.mp3'))
      fs.rmSync(path.join(root, 'Author/Book Two'), { recursive: true })
      await scan(c.library)
      const items = await viewItems(c)
      snap(
        this,
        await stable(c, {
          tasks: taskEvents(),
          items: items.map((i) => ({ relPath: i.relPath, isMissing: i.isMissing, numTracks: i.media.numTracks })),
          emitted: api.emitted
            .filter((e) => !String(e.args[0]).startsWith('task_'))
            .map((e) => `${e.method}:${e.args[0]}:${Array.isArray(e.args[1]) ? e.args[1].length : ''}`)
            .sort()
        })
      )
    })

    it('a missing item that returns is found again; an item moved with the same inode keeps its row', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await scan(c.library)
      const idsBefore = Object.fromEntries((await Database.libraryItemModel.findAll()).map((i) => [i.relPath, i.id]))
      // Book Two disappears, Book One is renamed (same inode)
      fs.renameSync(path.join(root, 'Author/Book Two'), path.join(root, 'Hidden Away'))
      fs.renameSync(path.join(root, 'Author/Book One'), path.join(root, 'Author/Renamed One'))
      const second = await runScan(c)
      const afterSecond = (await viewItems(c)).map((i) => ({ relPath: i.relPath, path: i.path, isMissing: i.isMissing }))
      fs.renameSync(path.join(root, 'Hidden Away'), path.join(root, 'Author/Book Two'))
      const third = await runScan(c)
      const items = await Database.libraryItemModel.findAll()
      snap(
        this,
        await stable(c, {
          second: { added: second.added, updated: second.updated, missing: second.missing, logs: second.logs },
          afterSecond,
          third: { added: third.added, updated: third.updated, missing: third.missing, logs: third.logs },
          final: (await viewItems(c)).map((i) => ({ relPath: i.relPath, isMissing: i.isMissing })),
          sameRows: items.every((i) => Object.values(idsBefore).includes(i.id)),
          count: items.length
        })
      )
    })

    it('forced rescan re-reads metadata even when files did not change', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await scan(c.library)
      resetLoggerHistory()
      api.emitted.length = 0
      await scan(c.library, true)
      snap(this, await stable(c, { tasks: taskEvents(), info: loggerCalls('info') }))
    })

    it('a changed library metadataPrecedence forces a rescan on the next scan and is stored as lastScanMetadataPrecedence', async function () {
      media.makeAudio(path.join(root, 'Author/Book One/01.mp3'), { tags: { album: 'Tag Title' } })
      const c = await setupScan(api, root)
      await scan(c.library)
      const first = await libraryRow(c)
      c.library.settings = { ...c.library.settings, metadataPrecedence: ['audioMetatags', 'folderStructure'] }
      c.library.changed('settings', true)
      await c.library.save()
      resetLoggerHistory()
      await scan(c.library)
      snap(this, await stable(c, { first, second: await libraryRow(c), info: loggerCalls('info'), titleNow: (await viewItems(c))[0].media.metadata.title }))
    })

    it('a library without folders is not scanned', async function () {
      const c = await setupScan(api, root)
      await Database.libraryFolderModel.destroy({ where: { libraryId: c.library.id } })
      await c.library.reload({ include: Database.libraryFolderModel })
      await LibraryScanner.scan(c.library)
      snap(this, { warn: loggerCalls('warn'), tasks: taskEvents(), scanning: LibraryScanner.librariesScanning })
    })

    it('a library already scanning is refused', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      LibraryScanner.librariesScanning.push(c.library.id)
      await LibraryScanner.scan(c.library)
      snap(this, await stable(c, { error: loggerCalls('error'), tasks: taskEvents(), items: (await viewItems(c)).length }))
    })

    it('cancelLibraryScan stops a running scan: no lastScan update and a "canceled by user" task', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await c.library.reload({ include: Database.libraryFolderModel })
      const promise = LibraryScanner.scan(c.library)
      const flagsBefore = { scanning: LibraryScanner.isLibraryScanning(c.library.id) }
      LibraryScanner.setCancelLibraryScan(c.library.id)
      await promise
      await waitFor(() => savedLogCount() >= 1)
      snap(this, await stable(c, { flagsBefore, tasks: taskEvents(), library: await libraryRow(c), items: (await viewItems(c)).length, scanningAfter: LibraryScanner.librariesScanning, cancelFlagsAfter: LibraryScanner.cancelLibraryScan, info: loggerCalls('info') }))
    })

    it('setCancelLibraryScan does nothing when the library is not scanning', async function () {
      const c = await setupScan(api, root)
      LibraryScanner.setCancelLibraryScan(c.library.id)
      snap(this, { flags: LibraryScanner.cancelLibraryScan })
    })

    it('the scan log is saved under <metadata>/logs/scans after the scan', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await scan(c.library)
      const dir = path.join(api.tmp, 'metadata', 'logs', 'scans')
      const file = await waitFor(() => fs.existsSync(dir) && fs.readdirSync(dir)[0])
      const lines = fs
        .readFileSync(path.join(dir, file), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      snap(
        this,
        await stable(
          c,
          {
            header: { type: lines[0].type, resultsAdded: lines[0].resultsAdded, resultsUpdated: lines[0].resultsUpdated, resultsMissing: lines[0].resultsMissing, libraryName: lines[0].library.name },
            messages: lines.slice(1).map((l) => `${l.levelName}: ${l.message}`)
          },
          { sortArrays: ['messages'] }
        )
      )
    })

    it('POST /api/libraries/:id/scan answers first, then scans; ?force=1 forces; non-admins are refused', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      const users = await api.seed.users()
      expect(users.user).to.exist
      const refused = await api.request('POST', `/api/libraries/${c.library.id}/scan`, { as: 'user' })
      const accepted = await api.request('POST', `/api/libraries/${c.library.id}/scan`, { as: 'admin' })
      await waitFor(async () => !LibraryScanner.isLibraryScanning(c.library.id) && (await Database.libraryItemModel.count()) === 3)
      await waitFor(() => taskEvents().some((t) => t.event === 'task_finished'))
      const forced = await api.request('POST', `/api/libraries/${c.library.id}/scan?force=1`, { as: 'root' })
      await waitFor(() => taskEvents().filter((t) => t.event === 'task_finished').length === 2)
      snap(this, await stable(c, { refused: refused.status, accepted: accepted.status, forced: forced.status, items: (await viewItems(c)).map((i) => i.relPath), tasks: taskEvents().map((t) => ({ event: t.event, action: t.task.action, results: t.task.data.scanResults })) }))
    })

    it('podcast library scan', async function () {
      media.makeAudio(path.join(root, 'Pod One/ep1.mp3'), { tags: { title: 'E1' } })
      media.makeAudio(path.join(root, 'Pod Two/ep1.mp3'), { tags: { title: 'E1' } })
      const c = await setupScan(api, root, { mediaType: 'podcast' })
      await scan(c.library)
      snap(this, await stable(c, { tasks: taskEvents(), library: await libraryRow(c), items: (await viewItems(c)).map((i) => `${i.relPath}: ${i.media.numEpisodes}`) }))
    })

    it('scanFolder: a library folder that no longer exists makes all its items missing', async function () {
      makeBooks()
      const c = await setupScan(api, root)
      await scan(c.library)
      rmTree(root)
      Logger.error.resetHistory()
      const second = await runScan(c)
      snap(this, await stable(c, { second: { added: second.added, updated: second.updated, missing: second.missing }, error: loggerCalls('error'), items: (await viewItems(c)).map((i) => ({ relPath: i.relPath, isMissing: i.isMissing })) }))
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('LibraryItemScanner', () => {
    beforeEach(needFfmpeg)

    const scanned = async (settings) => {
      media.makeAudio(book('01.mp3'), { tags: { album: 'Book One', artist: 'Author' } })
      media.makeAudio(path.join(root, 'Standalone.mp3'), { tags: { album: 'Standalone' } })
      const c = await setupScan(api, root, { settings })
      await runScan(c)
      api.emitted.length = 0
      const items = await Database.libraryItemModel.findAll({ where: { libraryId: c.library.id } })
      c.byRel = Object.fromEntries(items.map((i) => [i.relPath, i]))
      return c
    }
    const itemEvents = () => api.emitted.map((e) => `${e.method}:${e.args[0]}`)

    it('scanLibraryItem: up to date, updated (file added), item not found, library not found', async function () {
      const c = await scanned()
      const item = c.byRel['Author/Book One']
      const upToDate = await LibraryItemScanner.scanLibraryItem(item.id)
      const eventsUpToDate = itemEvents()
      media.makeAudio(book('02.mp3'))
      api.emitted.length = 0
      const updated = await LibraryItemScanner.scanLibraryItem(item.id)
      const eventsUpdated = itemEvents()
      const unknown = await LibraryItemScanner.scanLibraryItem('00000000-0000-4000-8000-000000000000')
      await Database.libraryModel.destroy({ where: { id: c.library.id } })
      const noLibrary = await LibraryItemScanner.scanLibraryItem(item.id).catch((e) => `throws ${e.message}`)
      snap(this, await stable(c, { upToDate: scanResultName(upToDate), updated: scanResultName(updated), unknown: scanResultName(unknown), noLibrary: typeof noLibrary === 'number' ? scanResultName(noLibrary) : noLibrary, eventsUpToDate, eventsUpdated, errors: loggerCalls('error'), numTracks: (await Database.bookModel.findByPk(item.mediaId)).audioFiles.length }))
    })

    it('scanLibraryItem: files removed from disk, then the whole item folder removed', async function () {
      const c = await scanned()
      const item = c.byRel['Author/Book One']
      fs.rmSync(book('01.mp3'))
      media.makeAudio(book('02.mp3'))
      const filesSwapped = await LibraryItemScanner.scanLibraryItem(item.id)
      fs.rmSync(path.join(root, 'Author'), { recursive: true })
      const folderGone = await LibraryItemScanner.scanLibraryItem(item.id)
      const row = await Database.libraryItemModel.findByPk(item.id)
      snap(this, await stable(c, { filesSwapped: scanResultName(filesSwapped), folderGone: scanResultName(folderGone), isMissing: row.isMissing, libraryFiles: row.libraryFiles.length, logsInfo: loggerCalls('info') }))
    })

    it('scanLibraryItem with watcher details (item folder renamed): path and relPath follow', async function () {
      const c = await scanned()
      const item = c.byRel['Author/Book One']
      fs.renameSync(book(), path.join(root, 'Author', 'Renamed'))
      const result = await LibraryItemScanner.scanLibraryItem(item.id, { relPath: 'Author/Renamed', path: path.join(root, 'Author', 'Renamed'), libraryFolderId: c.folder.id, isFile: false })
      const row = await Database.libraryItemModel.findByPk(item.id)
      snap(this, await stable(c, { result: scanResultName(result), path: row.path, relPath: row.relPath, files: row.libraryFiles.map((f) => f.metadata.path), events: itemEvents() }))
    })

    it('scanLibraryItem on an isFile item treats the file path as a folder (watcher details are needed for isFile)', async function () {
      const c = await scanned()
      const item = c.byRel['Standalone.mp3']
      const result = await LibraryItemScanner.scanLibraryItem(item.id)
      const row = await Database.libraryItemModel.findByPk(item.id)
      const withDetails = await LibraryItemScanner.scanLibraryItem(item.id, { relPath: 'Standalone.mp3', path: path.join(root, 'Standalone.mp3'), isFile: true })
      snap(this, await stable(c, { result: scanResultName(result), isFile: row.isFile, libraryFiles: row.libraryFiles.length, isMissing: row.isMissing, withDetails: scanResultName(withDetails), errors: loggerCalls('error'), info: loggerCalls('info') }))
    })

    it('a file the watcher is still writing (pending) is skipped during a scan', async function () {
      const c = await scanned()
      const Watcher = require('../../server/Watcher')
      const item = c.byRel['Author/Book One']
      media.makeAudio(book('02.mp3'))
      const saved = Watcher.pendingFileUpdates
      Watcher.pendingFileUpdates = [{ path: path.posix.join(book(), '02.mp3').split(path.sep).join('/') }]
      let result
      try {
        result = await LibraryItemScanner.scanLibraryItem(item.id)
      } finally {
        Watcher.pendingFileUpdates = saved
      }
      const row = await Database.libraryItemModel.findByPk(item.id)
      snap(this, await stable(c, { result: scanResultName(result), files: row.libraryFiles.map((f) => f.metadata.relPath), info: loggerCalls('info') }))
    })

    it('POST /api/items/:id/scan reports the ScanResult name; non-admins and isFile items are refused', async function () {
      const c = await scanned()
      await api.seed.users()
      const item = c.byRel['Author/Book One']
      const upToDate = await api.request('POST', `/api/items/${item.id}/scan`, { as: 'admin' })
      media.makeAudio(book('02.mp3'))
      const updated = await api.request('POST', `/api/items/${item.id}/scan`, { as: 'admin' })
      const forbidden = await api.request('POST', `/api/items/${item.id}/scan`, { as: 'user' })
      const isFile = await api.request('POST', `/api/items/${c.byRel['Standalone.mp3'].id}/scan`, { as: 'admin' })
      snap(this, { upToDate: [upToDate.status, upToDate.body], updated: [updated.status, updated.body], forbidden: forbidden.status, isFile: isFile.status })
    })

    it('scanPotentialNewLibraryItem: a folder with files becomes an item, an empty folder is ignored', async function () {
      const c = await scanned()
      media.makeAudio(path.join(root, 'New Author/New Book/01.mp3'), { tags: { album: 'New Book', artist: 'New Author' } })
      fs.mkdirSync(path.join(root, 'Empty Folder'), { recursive: true })
      await c.library.reload({ include: Database.libraryFolderModel })
      const created = await LibraryItemScanner.scanPotentialNewLibraryItem(path.join(root, 'New Author/New Book'), c.library, c.folder, false)
      const empty = await LibraryItemScanner.scanPotentialNewLibraryItem(path.join(root, 'Empty Folder'), c.library, c.folder, false)
      const root1 = await LibraryItemScanner.scanPotentialNewLibraryItem(path.join(root, 'Standalone.mp3'), c.library, c.folder, true)
      snap(this, await stable(c, { created: created && { relPath: created.relPath, title: created.media.title, authors: created.media.authors.map((a) => a.name) }, empty, standaloneAgain: root1 && root1.relPath, events: itemEvents(), info: loggerCalls('info') }))
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('LibraryScanner.scanFilesChanged (the watcher path)', () => {
    beforeEach(needFfmpeg)

    const setup = async (opts = {}) => {
      media.makeAudio(book('01.mp3'), { tags: { album: 'Book One', artist: 'Author' } })
      media.makeAudio(path.join(root, 'Author/Book Two/01.mp3'), { tags: { album: 'Book Two', artist: 'Author' } })
      const c = await setupScan(api, root, opts)
      await runScan(c)
      api.emitted.length = 0
      return c
    }
    const update = (c, relPath, type = 'added') => ({ libraryId: c.library.id, folderId: c.folder.id, path: `${root}/${relPath}`, relPath: `/${relPath}`, type })
    const watcherRun = async (c, updates) => {
      const task = TaskManager.createAndAddTask('watcher-scan', { text: 'Scanning file changes', key: 'MessageTaskScanningFileChanges', subs: [] }, null, true, { libraryId: c.library.id, libraryName: c.library.name })
      api.emitted.length = 0
      await LibraryScanner.scanFilesChanged(updates, task)
      return { scanResults: maskElapsed(task.data.scanResults), isFinished: task.isFinished, events: api.emitted.map((e) => `${e.method}:${e.args[0]}`).sort() }
    }
    const rows = async (c) => (await viewItems(c)).map((i) => ({ relPath: i.relPath, isMissing: i.isMissing, isFile: i.isFile, numTracks: i.media.numTracks ?? i.media.numEpisodes, files: i.libraryFiles.map((f) => f.metadata.relPath) }))

    it('a new item folder is added', async function () {
      const c = await setup()
      media.makeAudio(path.join(root, 'Author/Book Three/01.mp3'), { tags: { album: 'Book Three', artist: 'Author' } })
      fs.writeFileSync(path.join(root, 'Author/Book Three/cover.jpg'), media.makeJpeg())
      const result = await watcherRun(c, [update(c, 'Author/Book Three/01.mp3'), update(c, 'Author/Book Three/cover.jpg')])
      snap(this, await stable(c, { result, items: await rows(c), debug: loggerCalls('debug').filter((l) => /Folder update|Folder scan results/.test(l)) }))
    })

    it('a root-level media file becomes an isFile item', async function () {
      const c = await setup()
      media.makeAudio(path.join(root, 'Loose Book.mp3'), { tags: { album: 'Loose Book' } })
      const result = await watcherRun(c, [update(c, 'Loose Book.mp3')])
      snap(this, await stable(c, { result, items: await rows(c) }))
    })

    it('a file added to, modified in and removed from an existing item', async function () {
      const c = await setup()
      media.makeAudio(book('02.mp3'))
      const added = await watcherRun(c, [update(c, 'Author/Book One/02.mp3')])
      const afterAdd = await rows(c)
      fs.writeFileSync(book('desc.txt'), 'hello')
      const textAdded = await watcherRun(c, [update(c, 'Author/Book One/desc.txt')])
      fs.rmSync(book('01.mp3'))
      const removed = await watcherRun(c, [update(c, 'Author/Book One/01.mp3', 'deleted')])
      snap(this, await stable(c, { added, afterAdd, textAdded, removed, final: await rows(c) }))
    })

    it('an item folder deleted from disk is marked missing', async function () {
      const c = await setup()
      fs.rmSync(path.join(root, 'Author/Book Two'), { recursive: true })
      const result = await watcherRun(c, [update(c, 'Author/Book Two/01.mp3', 'deleted')])
      snap(this, await stable(c, { result, items: await rows(c), info: loggerCalls('info').filter((l) => /marking as missing/.test(l)) }))
    })

    it('an item folder moved (deleted + added with the same inode) keeps its row', async function () {
      const c = await setup()
      const before = (await Database.libraryItemModel.findOne({ where: { relPath: 'Author/Book Two' } })).id
      fs.renameSync(path.join(root, 'Author/Book Two'), path.join(root, 'Moved Book'))
      const result = await watcherRun(c, [update(c, 'Author/Book Two/01.mp3', 'deleted'), update(c, 'Moved Book/01.mp3')])
      const after = await Database.libraryItemModel.findAll()
      snap(this, await stable(c, { result, items: await rows(c), sameRow: after.some((i) => i.id === before && i.relPath === 'Moved Book'), count: after.length }))
    })

    it('changes that do not matter are ignored: hidden files, unknown extensions, non-media outside an item', async function () {
      const c = await setup()
      fs.writeFileSync(path.join(root, 'Stray.txt'), 'x')
      fs.writeFileSync(path.join(root, 'Author/Book One/.DS_Store'), 'x')
      fs.writeFileSync(path.join(root, 'Author/Book One/notes.xyz'), 'x')
      const result = await watcherRun(c, [update(c, 'Stray.txt'), update(c, 'Author/Book One/.DS_Store'), update(c, 'Author/Book One/notes.xyz')])
      snap(this, await stable(c, { result, items: await rows(c), info: loggerCalls('info').filter((l) => /No important/.test(l)) }))
    })

    it('a cover added to a folder with no item does not create an item', async function () {
      const c = await setup()
      fs.mkdirSync(path.join(root, 'Just Art'), { recursive: true })
      fs.writeFileSync(path.join(root, 'Just Art/cover.jpg'), media.makeJpeg())
      const result = await watcherRun(c, [update(c, 'Just Art/cover.jpg')])
      snap(this, await stable(c, { result, items: await rows(c) }))
    })

    it('files in a parent directory of an existing item are ignored', async function () {
      const c = await setup()
      media.makeAudio(path.join(root, 'Author/loose.mp3'))
      const result = await watcherRun(c, [update(c, 'Author/loose.mp3')])
      snap(this, await stable(c, { result, items: await rows(c), warn: loggerCalls('warn') }))
    })

    it('audiobooksOnly: updates without an audio file for an unknown folder are ignored', async function () {
      const c = await setup({ settings: { audiobooksOnly: true } })
      fs.mkdirSync(path.join(root, 'Ebook Folder'), { recursive: true })
      media.makeEpub(path.join(root, 'Ebook Folder/b.epub'), { title: 'E' })
      const result = await watcherRun(c, [update(c, 'Ebook Folder/b.epub')])
      snap(this, await stable(c, { result, items: await rows(c) }))
    })

    it('an update for a path that does not exist (deleted before the scan ran) is ignored', async function () {
      const c = await setup()
      const result = await watcherRun(c, [update(c, 'Gone Author/Gone Book/01.mp3')])
      snap(this, await stable(c, { result, items: await rows(c), info: loggerCalls('info').filter((l) => /does not exist/.test(l)) }))
    })

    it('podcast library: an episode added to an existing podcast', async function () {
      media.makeAudio(path.join(root, 'Pod/ep1.mp3'), { tags: { title: 'E1' } })
      const c = await setupScan(api, root, { mediaType: 'podcast' })
      await runScan(c)
      media.makeAudio(path.join(root, 'Pod/ep2.mp3'), { tags: { title: 'E2' } })
      const result = await watcherRun(c, [update(c, 'Pod/ep2.mp3')])
      snap(this, await stable(c, { result, items: await rows(c) }))
    })

    it('an empty or missing update list returns immediately; an unknown library is skipped', async function () {
      const c = await setup()
      const task = TaskManager.createAndAddTask('watcher-scan', { text: 't', key: 'k', subs: [] }, null, true, {})
      const empty = await LibraryScanner.scanFilesChanged([], task)
      const nothing = await LibraryScanner.scanFilesChanged(undefined, task)
      api.emitted.length = 0
      const unknown = await watcherRun(c, [{ libraryId: '00000000-0000-4000-8000-000000000000', folderId: c.folder.id, path: `${root}/x/y.mp3`, relPath: '/x/y.mp3', type: 'added' }])
      snap(this, { empty: empty ?? null, nothing: nothing ?? null, taskTouched: task.isFinished, unknown, errors: loggerCalls('error') })
    })

    it('updates arriving while a watcher scan runs are queued and replayed afterwards', async function () {
      const c = await setup()
      media.makeAudio(path.join(root, 'Author/Book Three/01.mp3'), { tags: { album: 'Book Three' } })
      const task = TaskManager.createAndAddTask('watcher-scan', { text: 't', key: 'k', subs: [] }, null, true, {})
      LibraryScanner.scanningFilesChanged = true
      await LibraryScanner.scanFilesChanged([update(c, 'Author/Book Three/01.mp3')], task)
      const queued = { queueLength: LibraryScanner.pendingFileUpdatesToScan.length, itemsBefore: (await rows(c)).length, taskFinished: task.isFinished }
      LibraryScanner.scanningFilesChanged = false
      const [updates, queuedTask] = LibraryScanner.pendingFileUpdatesToScan.shift()
      await LibraryScanner.scanFilesChanged(updates, queuedTask)
      snap(this, await stable(c, { queued, afterReplay: await rows(c), scanningAfter: LibraryScanner.scanningFilesChanged, queueAfter: LibraryScanner.pendingFileUpdatesToScan.length, debug: loggerCalls('debug').filter((l) => /queue/.test(l)) }))
    })

    it('scanFolderUpdates and getFileUpdatesGrouped', async function () {
      const c = await setup()
      media.makeAudio(path.join(root, 'Author/Book Four/01.mp3'))
      await c.library.reload({ include: Database.libraryFolderModel })
      const grouped = LibraryScanner.getFileUpdatesGrouped([update(c, 'a/1.mp3'), update(c, 'b/2.mp3'), { ...update(c, 'c/3.mp3'), folderId: 'other-folder' }])
      const groupedView = Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k === c.folder.id ? '<folder>' : k, { libraryId: v.libraryId === c.library.id ? '<library>' : v.libraryId, files: v.fileUpdates.map((f) => f.relPath) }]))
      const results = await LibraryScanner.scanFolderUpdates(c.library, c.folder, { 'Author/Book Four': ['01.mp3'], 'Author/Book One': ['01.mp3'], 'Nowhere/Nothing': ['x.mp3'] })
      snap(this, await stable(c, { groupedView, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, scanResultName(v)])), items: (await rows(c)).map((i) => i.relPath) }))
    })

    it.skip('library settings.disableWatcher: needs the real chokidar-based Watcher, which the harness stubs (Watcher.addLibrary/updateLibrary calls are recorded in the LibraryController tests)', function () {})
  })

  // ---------------------------------------------------------------------------------------------------------------------------
  describe('Scanner quick match (provider stubbed at axios)', () => {
    beforeEach(needFfmpeg)

    const AUDIBLE_BOOK = {
      asin: 'B000000001',
      title: 'Matched Title',
      subtitle: 'Matched Subtitle',
      authors: [{ name: 'Match Author' }, { name: 'Second Author' }],
      narrators: [{ name: 'Narr One' }, { name: 'Narr Two' }],
      publisherName: 'Match Publisher',
      summary: '<p>Matched <b>summary</b></p>',
      releaseDate: '2019-04-02',
      genres: [
        { type: 'genre', name: 'Fantasy' },
        { type: 'tag', name: 'Epic' }
      ],
      seriesPrimary: { name: 'Match Series', position: 'Book 2' },
      language: 'english',
      runtimeLengthMin: 1,
      formatType: 'unabridged',
      isbn: '9780000000001',
      region: 'us',
      rating: '4.5'
    }
    let getStub
    const stubAudible = (book = AUDIBLE_BOOK) => {
      getStub = sinon.stub(axios, 'get').callsFake(async (url) => {
        if (String(url).includes('api.audnex.us/books/')) return { data: book }
        if (String(url).includes('/1.0/catalog/products')) return { data: { products: book ? [{ asin: book.asin }] : [] } }
        throw new Error(`unexpected request ${url}`)
      })
    }
    afterEach(() => {
      getStub = null
    })

    const matchSetup = async (tags = { album: 'Book One', artist: 'Old Author' }, settings) => {
      media.makeAudio(book('01.mp3'), { tags })
      const c = await setupScan(api, root, { settings })
      await runScan(c)
      api.emitted.length = 0
      const row = await Database.libraryItemModel.findOne({ where: { libraryId: c.library.id } })
      c.itemId = row.id
      c.expanded = () => Database.libraryItemModel.getExpandedById(c.itemId)
      return c
    }
    const meta = (item) => {
      const j = item.toOldJSONExpanded()
      const m = j.media.metadata
      return {
        title: m.title,
        subtitle: m.subtitle,
        authors: m.authors.map((a) => a.name),
        narrators: m.narrators,
        series: m.series.map((s) => `${s.name} #${s.sequence}`),
        genres: m.genres,
        tags: j.media.tags,
        publisher: m.publisher,
        publishedYear: m.publishedYear,
        description: m.description,
        asin: m.asin,
        isbn: m.isbn,
        language: m.language,
        explicit: m.explicit,
        abridged: m.abridged,
        coverPath: j.media.coverPath
      }
    }
    const requestedUrls = () => getStub.getCalls().map((c) => String(c.args[0]).replace(/\?.*/, '?<query>'))

    it('quick match fills empty fields only (title, existing author kept)', async function () {
      stubAudible()
      const c = await matchSetup()
      const result = await Scanner.quickMatchLibraryItem(api.apiRouter, await c.expanded(), { provider: 'audible' })
      snap(this, await stable(c, { result: { updated: result.updated, warning: result.warning }, after: meta(await c.expanded()), requests: requestedUrls(), emitted: api.emitted.map((e) => `${e.method}:${e.args[0]}`).sort() }))
    })

    it('quick match with overrideDetails replaces title, authors and series and removes the old author', async function () {
      stubAudible()
      const c = await matchSetup({ album: 'Book One', artist: 'Old Author', series: 'Old Series', 'series-part': '1' })
      const result = await Scanner.quickMatchLibraryItem(api.apiRouter, await c.expanded(), { provider: 'audible', overrideDetails: true })
      snap(this, await stable(c, { result: { updated: result.updated }, after: meta(await c.expanded()), authorsInLibrary: (await Database.authorModel.findAll()).map((a) => a.name).sort(), seriesInLibrary: (await Database.seriesModel.findAll()).map((s) => s.name).sort(), emitted: api.emitted.map((e) => `${e.method}:${e.args[0]}`).sort() }))
    })

    it('quick match uses the server setting scannerPreferMatchedMetadata when no override flags are passed', async function () {
      stubAudible()
      const c = await matchSetup()
      const saved = Database.serverSettings.scannerPreferMatchedMetadata
      Database.serverSettings.scannerPreferMatchedMetadata = true
      try {
        const options = { provider: 'audible' }
        await Scanner.quickMatchLibraryItem(api.apiRouter, await c.expanded(), options)
        snap(this, await stable(c, { options, after: meta(await c.expanded()) }))
      } finally {
        Database.serverSettings.scannerPreferMatchedMetadata = saved
      }
    })

    it('quick match with no result returns a warning and changes nothing', async function () {
      stubAudible(null)
      const c = await matchSetup()
      const before = meta(await c.expanded())
      const result = await Scanner.quickMatchLibraryItem(api.apiRouter, await c.expanded(), { provider: 'audible' })
      snap(this, await stable(c, { result, unchanged: JSON.stringify(before) === JSON.stringify(meta(await c.expanded())), numRequests: requestedUrls().length }))
    })

    it('quick match with an explicit title/author/asin searches with those', async function () {
      stubAudible()
      const c = await matchSetup()
      await Scanner.quickMatchLibraryItem(api.apiRouter, await c.expanded(), { provider: 'audible', title: 'Other Title', author: 'Other Author', asin: 'B000000001' })
      snap(this, { requests: requestedUrls(), queries: getStub.getCalls().map((call) => call.args[1]?.params ?? null) })
    })

    it('podcast quick match through the iTunes search (no feed url, so no episode matching)', async function () {
      sinon.stub(axios, 'get').callsFake(async (url) => {
        if (String(url).includes('itunes.apple.com/search')) return { data: { results: [{ collectionId: 4242, artistId: 99, collectionName: 'Matched Podcast', artistName: 'Podcast Host', releaseDate: '2020-01-01T00:00:00Z', primaryGenreName: 'Tech', genres: ['Technology', 'News'], collectionViewUrl: 'https://itunes.invalid/p', collectionExplicitness: 'notExplicit' }] } }
        throw new Error(`unexpected request ${url}`)
      })
      media.makeAudio(path.join(root, 'My Podcast/ep1.mp3'), { tags: { title: 'E1' } })
      const c = await setupScan(api, root, { mediaType: 'podcast' })
      await runScan(c)
      api.emitted.length = 0
      const row = await Database.libraryItemModel.findOne({ where: { libraryId: c.library.id } })
      const expanded = await Database.libraryItemModel.getExpandedById(row.id)
      const result = await Scanner.quickMatchLibraryItem(api.apiRouter, expanded, { provider: 'itunes', overrideDetails: false })
      const after = (await Database.libraryItemModel.getExpandedById(row.id)).toOldJSONExpanded().media.metadata
      snap(this, await stable(c, { updated: result.updated, after: { title: after.title, author: after.author, genres: after.genres, itunesId: after.itunesId, itunesArtistId: after.itunesArtistId, releaseDate: after.releaseDate, itunesPageUrl: after.itunesPageUrl, explicit: after.explicit }, emitted: api.emitted.map((e) => `${e.method}:${e.args[0]}`) }))
    })

    describe('matchLibraryItems (match all)', () => {
      const makeThree = async (settings) => {
        media.makeAudio(path.join(root, 'A Plain/01.mp3'), { tags: { album: 'A Plain' } })
        media.makeAudio(path.join(root, 'B With Asin/01.mp3'), { tags: { album: 'B With Asin', asin: 'B0ASIN0000' } })
        media.makeAudio(path.join(root, 'C With Isbn/01.mp3'), { tags: { album: 'C With Isbn', isbn: '9781234567897' } })
        const c = await setupScan(api, root, { settings })
        await runScan(c)
        c.library.provider = 'audible'
        await c.library.save()
        await c.library.reload({ include: Database.libraryFolderModel })
        api.emitted.length = 0
        return c
      }
      const titles = async () => (await Promise.all((await Database.libraryItemModel.findAll()).map(async (i) => [i.relPath, (await Database.libraryItemModel.getExpandedById(i.id)).media.asin]))).sort()

      it('every item is matched by default', async function () {
        stubAudible()
        const c = await makeThree()
        await Scanner.matchLibraryItems(api.apiRouter, c.library)
        snap(this, await stable(c, { asins: await titles(), tasks: taskEvents().map((t) => ({ event: t.event, action: t.task.action, results: t.task.data.scanResults, description: t.task.description })), numRequests: requestedUrls().length, scanning: LibraryScanner.librariesScanning }))
      })

      it('skipMatchingMediaWithAsin and skipMatchingMediaWithIsbn skip items that already have one', async function () {
        stubAudible()
        const c = await makeThree({ skipMatchingMediaWithAsin: true, skipMatchingMediaWithIsbn: true })
        await Scanner.matchLibraryItems(api.apiRouter, c.library)
        snap(this, await stable(c, { asins: await titles(), tasks: taskEvents().map((t) => ({ event: t.event, results: t.task.data.scanResults })), numRequests: requestedUrls().length }))
      })

      it('podcast libraries are refused, a library already scanning is refused, an empty library fails the task', async function () {
        stubAudible()
        const pod = await setupScan(api, root, { mediaType: 'podcast' })
        await Scanner.matchLibraryItems(api.apiRouter, pod.library)
        const podErrors = loggerCalls('error')
        Logger.error.resetHistory()
        const c = await makeThree()
        LibraryScanner.librariesScanning.push(c.library.id)
        await Scanner.matchLibraryItems(api.apiRouter, c.library)
        const scanningErrors = loggerCalls('error')
        LibraryScanner.librariesScanning = []
        await Database.libraryItemModel.destroy({ where: { libraryId: c.library.id } })
        api.emitted.length = 0
        await Scanner.matchLibraryItems(api.apiRouter, c.library)
        snap(this, await stable(c, { podErrors, scanningErrors, emptyTasks: taskEvents().map((t) => ({ event: t.event, isFailed: t.task.isFailed, error: t.task.error, description: t.task.description })), requests: requestedUrls().length }))
      })

      it('GET /api/libraries/:id/matchall is admin only and answers before matching finishes', async function () {
        stubAudible()
        const c = await makeThree()
        await api.seed.users()
        const forbidden = await api.request('GET', `/api/libraries/${c.library.id}/matchall`, { as: 'user' })
        const ok = await api.request('GET', `/api/libraries/${c.library.id}/matchall`, { as: 'admin' })
        await waitFor(() => taskEvents().some((t) => t.event === 'task_finished'))
        snap(this, await stable(c, { forbidden: forbidden.status, ok: ok.status, asins: await titles() }))
      })
    })
  })
})
