const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { makeTree, rmTree, createScanLibrary } = require('./helpers/seed-scanner-fs')

const Database = require('../../server/Database')
const fileUtils = require('../../server/utils/fileUtils')
const scanUtils = require('../../server/utils/scandir')
const LibraryScanner = require('../../server/scanner/LibraryScanner')
const LibraryScan = require('../../server/scanner/LibraryScan')
const LibraryItemScanData = require('../../server/scanner/LibraryItemScanData')

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sortedGroups = (groups) => Object.fromEntries(Object.keys(groups).sort(byKey).map((k) => [k, Array.isArray(groups[k]) ? [...groups[k]].sort(byKey) : groups[k]]))
const fileSummary = (lf) => ({ relPath: lf.metadata.relPath, filename: lf.metadata.filename, ext: lf.metadata.ext, fileType: lf.fileType, size: lf.metadata.size, isSupplementary: lf.isSupplementary })
const itemSummary = (d) => ({
  relPath: d.relPath,
  isFile: d.isFile,
  mediaType: d.mediaType,
  hasIno: !!d.ino,
  mediaMetadata: d.mediaMetadata,
  libraryFiles: d.libraryFiles.map(fileSummary).sort((a, b) => byKey(a.relPath, b.relPath))
})
const sortedItems = (items) => items.map(itemSummary).sort((a, b) => byKey(a.relPath, b.relPath))
// timestamp-change lines depend on whether two writes landed in the same millisecond, and inode numbers differ per machine
const TIME_LOG = /key "(mtime|ctime|birthtime|mtimeMs|ctimeMs|birthtimeMs)"|changed: \[/
const logLines = (scan) => scan.logs.filter((l) => !TIME_LOG.test(l.message)).map((l) => `${l.levelName}: ${l.message}`.replace(/inode value "\d+"/g, 'inode value "<ino>"'))
const fileItems = (relPaths) => relPaths.map((relPath) => fileUtils.getFilePathItemFromFileUpdate({ relPath, path: `/lib/${relPath}` }))

describe('ScannerDirectory (characterization)', function () {
  this.timeout(30000)

  describe('fileUtils.shouldIgnoreFile', () => {
    it('reports why a path is ignored', function () {
      const paths = [
        'Author/Book/01.mp3',
        '.hidden.mp3',
        'Book/.hidden.mp3',
        '.hiddendir/Book/01.mp3',
        'Book/.DS_Store',
        '@eaDir/Book/01.mp3',
        'Book/@eaDir/01.mp3',
        'Book/my@eaDirbook.mp3',
        'Book/01.mp3.part',
        'Book/01.TMP',
        'Book/01.crdownload',
        'Book/01.download',
        'Book/01.bak',
        'Book/01.old',
        'Book/01.temp',
        'Book/01.tempfile',
        'Book/01.tempfile~',
        'Book/01.partial',
        'Book/.ignore',
        'Book/noext'
      ]
      matchSnapshot(this, Object.fromEntries(paths.map((p) => [p, fileUtils.shouldIgnoreFile(p)])))
    })
  })

  describe('fileUtils.recurseFiles on a real tree', () => {
    let root
    before(() => {
      root = makeTree({
        'root.mp3': '',
        'Author/Book/01.mp3': '',
        'Author/Book/cover.jpg': '',
        'Author/Book/.hidden.mp3': '',
        'Author/Book/02.mp3.part': '',
        'Ignored/.ignore': '',
        'Ignored/x.mp3': '',
        'Ignored/Sub/y.mp3': '',
        'Ignored2/Sub/.ignore': '',
        'Ignored2/Sub/z.mp3': '',
        'Ignored2/keep.mp3': '',
        'Synology/@eaDir/thumb.mp3': '',
        '.hiddendir/h.mp3': '',
        'Empty Folder/': null,
        'Unicode Bôök/ファイル.mp3': '',
        'Deep/a/b/c/d/e.mp3': ''
      })
    })
    after(() => rmTree(root))

    it('lists non-ignored files, with depth, relative dir and extension', async function () {
      const list = await fileUtils.recurseFiles(root)
      const out = list
        .map((i) => ({ name: i.name, path: i.path, reldirpath: i.reldirpath, extension: i.extension, deep: i.deep, fullpathUnderRoot: i.fullpath.startsWith(root + '/') }))
        .sort((a, b) => byKey(a.path, b.path))
      // the list is sorted least deep first, only the order within one depth is up to the filesystem
      const depths = list.map((i) => i.deep)
      matchSnapshot(this, { files: out, sortedByDepth: depths.every((d, i) => i === 0 || depths[i - 1] <= d) })
    })

    it('a root .ignore file does not ignore anything (only .ignore in a subdirectory counts)', async function () {
      const r = makeTree({ '.ignore': '', 'a.mp3': '', 'Book/b.mp3': '' })
      try {
        const list = await fileUtils.recurseFiles(r)
        matchSnapshot(this, list.map((i) => i.path).sort(byKey))
      } finally {
        rmTree(r)
      }
    })

    it('returns [] for a path that does not exist', async function () {
      const list = await fileUtils.recurseFiles(path.join(root, 'nope'))
      expect(list).to.deep.equal([])
    })

    it('relPathToReplace changes the relative paths', async function () {
      const list = await fileUtils.recurseFiles(path.join(root, 'Author'), root)
      matchSnapshot(this, list.map((i) => ({ path: i.path, reldirpath: i.reldirpath, deep: i.deep })).sort((a, b) => byKey(a.path, b.path)))
    })
  })

  describe('groupFileItemsIntoLibraryItemDirs (pure)', () => {
    it('groups book files: root files, folders, series/author nesting, CD dirs, extra files', function () {
      const items = fileItems([
        'Standalone.mp3',
        'Standalone.jpg',
        'root-notes.txt',
        'Single Folder/book.m4b',
        'Single Folder/cover.jpg',
        'Author/Series/Book 1/01.mp3',
        'Author/Series/Book 1/02.mp3',
        'Author/Series/Book 1/desc.txt',
        'Author/Series/Book 1/metadata.json',
        'Multi Disc/CD 1/a.mp3',
        'Multi Disc/CD 2/b.mp3',
        'Multi Disc/cover.jpg',
        'Author/Disc Book/Disc 1/a.mp3',
        'Author/Disc Book/Disk2/b.mp3',
        'Author/Disc Book/disc 03/c.mp3',
        'Author/Nested/Deep/Deeper/a.mp3',
        'Author/Nested/Deep/Deeper/CD 1/b.mp3',
        'Text Only/readme.txt',
        'Ebook Only/book.epub',
        'Mixed/book.epub',
        'Mixed/audio.mp3',
        'Uppercase/TRACK.MP3',
        'Unknown/file.xyz',
        'Unknown/a.mp3'
      ])
      matchSnapshot(this, sortedGroups(scanUtils.groupFileItemsIntoLibraryItemDirs('book', items, false)))
    })

    it('treats a folder named like a CD dir only as a CD dir when it is directly below the item folder', function () {
      const items = fileItems(['Book/CD 1/a.mp3', 'Book/Extras/CD 2/b.mp3', 'CD 1/c.mp3', 'Author/CD1/d.mp3', 'Author/CD 1000/e.mp3', 'Author/cd 12/f.mp3'])
      matchSnapshot(this, sortedGroups(scanUtils.groupFileItemsIntoLibraryItemDirs('book', items, false)))
    })

    it('audiobooksOnly drops ebook-only items and root ebook files', function () {
      const items = fileItems(['root.epub', 'root.mp3', 'Ebook Only/book.epub', 'Mixed/book.epub', 'Mixed/audio.mp3'])
      matchSnapshot(this, {
        all: sortedGroups(scanUtils.groupFileItemsIntoLibraryItemDirs('book', items, false)),
        audiobooksOnly: sortedGroups(scanUtils.groupFileItemsIntoLibraryItemDirs('book', items, true))
      })
    })

    it('podcast libraries ignore root files and ebooks, and fold subfolders into the top folder', function () {
      const items = fileItems(['root.mp3', 'Podcast A/ep1.mp3', 'Podcast A/ep2.mp3', 'Podcast A/cover.jpg', 'Podcast B/Season 1/ep1.mp3', 'Podcast B/Season 2/ep1.mp3', 'Podcast C/book.epub', 'Podcast D/CD 1/ep.mp3'])
      matchSnapshot(this, sortedGroups(scanUtils.groupFileItemsIntoLibraryItemDirs('podcast', items, false)))
    })

    it('includeNonMediaFiles (watcher) groups text/metadata/image files by themselves too', function () {
      const items = fileItems(['Book/cover.jpg', 'Book/desc.txt', 'Book/metadata.json', 'Book/a.opf', 'Book/x.xyz', 'Other/Sub/reader.txt', 'root.jpg', 'root.mp3'])
      matchSnapshot(this, {
        withoutNonMedia: sortedGroups(scanUtils.groupFileItemsIntoLibraryItemDirs('book', items, false, false)),
        withNonMedia: sortedGroups(scanUtils.groupFileItemsIntoLibraryItemDirs('book', items, false, true))
      })
    })

    it('empty input gives an empty grouping', function () {
      expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', [], false)).to.deep.equal({})
    })
  })

  describe('getBookDataFromDir / getPodcastDataFromDir / getDataFromMediaDir (folder name parsing)', () => {
    let savedServerSettings
    beforeEach(() => {
      savedServerSettings = global.ServerSettings
      global.ServerSettings = { scannerParseSubtitle: false }
    })
    afterEach(() => {
      global.ServerSettings = savedServerSettings
    })

    const dirs = [
      'Title',
      'Author/Title',
      'Author/Series/Title',
      'Author/Series/Book 2 - Title',
      'Author/Series/Vol. 3 Title Here - Subtitle',
      'Author/Series/Title - Vol 12',
      'Author/Series/1980 - Book 2 - Title',
      'Author/Series/100 - Book Title',
      'Author/Series/6. Title',
      'Author/Series/0.5 - Book Title',
      'Author/Series/101 Dalmations',
      'Author/Series/Volume 12. Title - Subtitle',
      'Author/Series/Title - volume 9 - Subtitle',
      'Author/Series/Book 1 - Title {Narrator One, Narrator Two}',
      'Author/Series/Title [B0015T963C]',
      'Author/Series/[B0015T963C] Title',
      'Author/Series/Title[B0015T963C]',
      'Author/Series/Title [b0015t963c]',
      'Author/Series/(2012) - Title',
      'Author/Series/2012 - Title',
      'Author/Series/Book 4 - 2012 - Title - Subtitle {Nar}',
      'Author/Title - Subtitle',
      'Author/Title (2012)',
      'Author/1984',
      'Author One, Author Two/Title',
      'Author One & Author Two/Title',
      'Last, First/Title',
      'Library Root/Author/Series/Title',
      'Library Root/Extra/Author/Series/Title',
      'Series Title 2 of 3/Book',
      'Author/Series/Title.With.Dots',
      'Ünïcode Author/Séries/Titel ファイル'
    ]

    it('parses folder structure into title/author/series/sequence/narrators/asin/year (subtitle parsing off)', function () {
      matchSnapshot(this, Object.fromEntries(dirs.map((d) => [d, scanUtils.getBookDataFromDir(d, false)])))
    })

    it('parses subtitle too when asked', function () {
      matchSnapshot(this, Object.fromEntries(dirs.map((d) => [d, scanUtils.getBookDataFromDir(d, true)])))
    })

    it('the sequence is only parsed when there is a series folder', function () {
      matchSnapshot(this, { noSeriesFolder: scanUtils.getBookDataFromDir('Author/Book 2 - Title'), withSeriesFolder: scanUtils.getBookDataFromDir('Author/Series/Book 2 - Title') })
    })

    it('podcast folders only give a title (the last path part)', function () {
      matchSnapshot(this, { simple: scanUtils.getDataFromMediaDir('podcast', '/pods', 'My Podcast'), nested: scanUtils.getDataFromMediaDir('podcast', '/pods', 'Network/My Podcast') })
    })

    it('getDataFromMediaDir joins the folder path and honours global scannerParseSubtitle', function () {
      const book = scanUtils.getDataFromMediaDir('book', '/audiobooks', 'Author/Series/Book 1 - Title - Subtitle')
      global.ServerSettings = { scannerParseSubtitle: true }
      const bookWithSubtitle = scanUtils.getDataFromMediaDir('book', '/audiobooks', 'Author/Series/Book 1 - Title - Subtitle')
      matchSnapshot(this, { book, bookWithSubtitle })
    })

    it('getDataFromMediaDir converts Windows separators in the relative path', function () {
      matchSnapshot(this, scanUtils.getDataFromMediaDir('book', '/audiobooks', 'Author\\Series\\Book 1 - Title'))
    })
  })

  describe('LibraryScanner.scanFolder on a real tree', () => {
    let api, root

    beforeEach(async () => {
      api = await startApi()
    })
    afterEach(async () => {
      await api.stop()
      if (root) rmTree(root)
      root = null
    })

    it('book library: how a folder tree becomes library items', async function () {
      root = makeTree({
        'Standalone Book.mp3': 'aaaa',
        'Standalone Ebook.epub': 'bb',
        'Stray Cover.jpg': '',
        'notes.txt': '',
        'Single/book.m4b': 'cccc',
        'Single/cover.jpg': 'dd',
        'Single/desc.txt': 'description',
        'Single/reader.txt': 'reader',
        'Single/metadata.json': '{}',
        'Single/book.nfo': '',
        'Single/book.opf': '',
        'Single/Extras/bonus.pdf': 'pp',
        'Author A/Series X/Book 1 - Title One/01.mp3': '1',
        'Author A/Series X/Book 1 - Title One/02.mp3': '22',
        'Author A/Standalone Title/part1.mp3': '',
        'Multi Disc/CD 1/a.mp3': '',
        'Multi Disc/CD 2/b.mp3': '',
        'Multi Disc/cover.jpg': '',
        'Ignored/.ignore': '',
        'Ignored/x.mp3': '',
        'Hidden Files/.hidden.mp3': '',
        'Hidden Files/visible.mp3': '',
        '@eaDir/thumb.mp3': '',
        'With Partial/a.mp3': '',
        'With Partial/b.mp3.part': '',
        'With Partial/.DS_Store': '',
        'Empty Folder/': null,
        'Text Only/readme.txt': '',
        'Ebook Only/book.epub': '',
        'Ebook Only/book.cbz': '',
        'Unicode Bôök/ファイル.mp3': '',
        'Uppercase Ext/TRACK.MP3': '',
        'Deep/a/b/c/d/e.mp3': ''
      })
      const { library, folder } = await createScanLibrary(root)
      const items = await LibraryScanner.scanFolder(library, folder)
      matchSnapshot(this, { count: items.length, items: sortedItems(items) })
    })

    it('book library with audiobooksOnly', async function () {
      root = makeTree({ 'root.epub': '', 'root.mp3': '', 'Ebook Only/book.epub': '', 'Mixed/book.epub': '', 'Mixed/audio.mp3': '' })
      const { library, folder } = await createScanLibrary(root, { settings: { audiobooksOnly: true } })
      const items = await LibraryScanner.scanFolder(library, folder)
      matchSnapshot(this, sortedItems(items))
    })

    it('item data: folder item vs root file item (path, relPath, folder/library ids, ino, timestamps, size)', async function () {
      root = makeTree({ 'Root File.mp3': '12345', 'Folder Book/a.mp3': '123', 'Folder Book/b.mp3': '45' })
      const { library, folder } = await createScanLibrary(root)
      const items = (await LibraryScanner.scanFolder(library, folder)).sort((a, b) => byKey(a.relPath, b.relPath))
      const stat = (p) => fs.statSync(p, { bigint: false })
      matchSnapshot(this, {
        items: items.map((d) => ({
          relPath: d.relPath,
          isFile: d.isFile,
          pathIsUnderRoot: d.path === path.posix.join(root, d.relPath),
          libraryFolderIdMatches: d.libraryFolderId === folder.id,
          libraryIdMatches: d.libraryId === library.id,
          inoMatchesDiskInode: d.ino === String(stat(d.path).ino),
          mtimeMatchesDisk: d.mtimeMs === stat(d.path).mtimeMs,
          libraryItemObject: (({ ino, path: p, mtime, ctime, birthtime, lastScan, lastScanVersion, libraryFiles, libraryId, libraryFolderId, ...rest }) => ({ ...rest, numLibraryFiles: libraryFiles.length, lastScanVersionIsString: typeof lastScanVersion === 'string', timesAreNumbers: [mtime, ctime, birthtime].every((n) => typeof n === 'number') }))(d.libraryItemObject)
        }))
      })
    })

    it('podcast library: root files are ignored, subfolders belong to the podcast folder', async function () {
      root = makeTree({
        'root-episode.mp3': '',
        'Podcast A/ep1.mp3': '',
        'Podcast A/ep2.m4a': '',
        'Podcast A/cover.jpg': '',
        'Podcast A/metadata.json': '{}',
        'Podcast B/Season 1/ep1.mp3': '',
        'Podcast B/Season 2/ep1.mp3': '',
        'Podcast C/book.epub': '',
        'Podcast D/': null,
        'Author/Podcast E/ep.mp3': ''
      })
      const { library, folder } = await createScanLibrary(root, { mediaType: 'podcast' })
      const items = await LibraryScanner.scanFolder(library, folder)
      matchSnapshot(this, sortedItems(items))
    })

    it('a folder that does not exist gives no items', async function () {
      const { library, folder } = await createScanLibrary('/nonexistent/abs-scan-folder')
      expect(await LibraryScanner.scanFolder(library, folder)).to.deep.equal([])
    })

    it('a folder with no media gives no items', async function () {
      root = makeTree({ 'Empty/': null, 'Text/readme.txt': '' })
      const { library, folder } = await createScanLibrary(root)
      expect(await LibraryScanner.scanFolder(library, folder)).to.deep.equal([])
    })

    it('the parsed names depend on the scannerParseSubtitle server setting', async function () {
      root = makeTree({ 'Author/Series/Book 1 - Title - Sub/a.mp3': '' })
      const { library, folder } = await createScanLibrary(root)
      const saved = global.ServerSettings
      try {
        global.ServerSettings = { ...saved, scannerParseSubtitle: false }
        const without = (await LibraryScanner.scanFolder(library, folder))[0].mediaMetadata
        global.ServerSettings = { ...saved, scannerParseSubtitle: true }
        const withSub = (await LibraryScanner.scanFolder(library, folder))[0].mediaMetadata
        matchSnapshot(this, { without, withSub })
      } finally {
        global.ServerSettings = saved
      }
    })
  })

  describe('LibraryItemScanData against an existing library item', () => {
    let api, root, library, folder, libraryScan

    beforeEach(async () => {
      api = await startApi()
      root = makeTree({ 'Book/01.mp3': 'one', 'Book/02.mp3': 'two!', 'Book/cover.jpg': 'img' })
      ;({ library, folder } = await createScanLibrary(root))
      libraryScan = new LibraryScan()
      libraryScan.setData(library)
    })
    afterEach(async () => {
      await api.stop()
      rmTree(root)
    })

    const scanBook = async () => (await LibraryScanner.scanFolder(library, folder)).find((i) => i.relPath === 'Book')
    async function createExisting(scanData) {
      const book = await Database.bookModel.create({ title: 'Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      return Database.libraryItemModel.create({ ...scanData.libraryItemObject, mediaId: book.id, libraryFiles: scanData.libraryFiles.map((lf) => lf.toJSON()) })
    }
    const summarize = (scanData, changed) => ({
      changed,
      hasChanges: scanData.hasChanges,
      hasPathChange: scanData.hasPathChange,
      hasLibraryFileChanges: scanData.hasLibraryFileChanges,
      hasAudioFileChanges: scanData.hasAudioFileChanges,
      added: scanData.libraryFilesAdded.map((f) => f.metadata.relPath),
      removed: scanData.libraryFilesRemoved.map((f) => f.metadata.relPath),
      modified: scanData.libraryFilesModified.map((m) => ({ old: m.old.metadata.relPath, new: m.new.metadata.relPath, oldSize: m.old.metadata.size, newSize: m.new.metadata.size })),
      audioAdded: scanData.audioLibraryFilesAdded.map((f) => f.metadata.relPath),
      audioRemoved: scanData.audioLibraryFilesRemoved.map((f) => f.metadata.relPath),
      audioModified: scanData.audioLibraryFilesModified.map((m) => m.old.metadata.relPath),
      imageAdded: scanData.imageLibraryFilesAdded.map((f) => f.metadata.relPath),
      imageRemoved: scanData.imageLibraryFilesRemoved.map((f) => f.metadata.relPath),
      ebookAdded: scanData.ebookLibraryFilesAdded.map((f) => f.metadata.relPath),
      logs: logLines(libraryScan).map((l) => l.split(root).join('<root>'))
    })

    it('an unchanged item has no changes', async function () {
      const existing = await createExisting(await scanBook())
      const next = await scanBook()
      const changed = await next.checkLibraryItemData(existing, libraryScan)
      matchSnapshot(this, summarize(next, changed), { tmpDirs: [root] })
    })

    it('added, modified and removed files are detected and the item row is updated', async function () {
      const existing = await createExisting(await scanBook())
      fs.writeFileSync(path.join(root, 'Book/03.mp3'), 'three')
      fs.writeFileSync(path.join(root, 'Book/desc.txt'), 'desc')
      fs.writeFileSync(path.join(root, 'Book/02.mp3'), 'two! and more bytes')
      fs.rmSync(path.join(root, 'Book/cover.jpg'))
      const next = await scanBook()
      const changed = await next.checkLibraryItemData(existing, libraryScan)
      await existing.reload()
      matchSnapshot(this, {
        ...summarize(next, changed),
        rowSize: existing.size,
        rowFiles: existing.libraryFiles.map((f) => f.metadata.relPath).sort(byKey),
        rowLastScanVersionSet: !!existing.lastScanVersion
      }, { tmpDirs: [root] })
    })

    it('a renamed file with the same inode is a modification (matched by inode), not remove + add', async function () {
      const existing = await createExisting(await scanBook())
      fs.renameSync(path.join(root, 'Book/01.mp3'), path.join(root, 'Book/renamed.mp3'))
      const next = await scanBook()
      const changed = await next.checkLibraryItemData(existing, libraryScan)
      matchSnapshot(this, summarize(next, changed), { tmpDirs: [root] })
    })

    it('a missing item that is found again is flagged found', async function () {
      const scanData = await scanBook()
      const existing = await createExisting(scanData)
      existing.isMissing = true
      await existing.save()
      const next = await scanBook()
      const changed = await next.checkLibraryItemData(existing, libraryScan)
      await existing.reload()
      matchSnapshot(this, { ...summarize(next, changed), isMissing: existing.isMissing }, { tmpDirs: [root] })
    })

    it('a changed relPath/path counts as a path change', async function () {
      const scanData = await scanBook()
      const existing = await createExisting(scanData)
      existing.relPath = 'Old Name'
      existing.path = path.posix.join(root, 'Old Name')
      await existing.save()
      const next = await scanBook()
      const changed = await next.checkLibraryItemData(existing, libraryScan)
      matchSnapshot(this, summarize(next, changed), { tmpDirs: [root] })
    })

    it('new ebook files on an existing item are marked supplementary', async function () {
      const existing = await createExisting(await scanBook())
      fs.writeFileSync(path.join(root, 'Book/extra.epub'), 'epub')
      const next = await scanBook()
      const changed = await next.checkLibraryItemData(existing, libraryScan)
      await existing.reload()
      matchSnapshot(this, { ...summarize(next, changed), rowEbook: existing.libraryFiles.filter((f) => f.fileType === 'ebook').map((f) => ({ relPath: f.metadata.relPath, isSupplementary: f.isSupplementary })) }, { tmpDirs: [root] })
    })

    it('named file getters find desc.txt, reader.txt, metadata.json, metadata.abs, .opf and .nfo files', async function () {
      fs.writeFileSync(path.join(root, 'Book/desc.txt'), 'd')
      fs.writeFileSync(path.join(root, 'Book/reader.txt'), 'r')
      fs.writeFileSync(path.join(root, 'Book/metadata.json'), '{}')
      fs.writeFileSync(path.join(root, 'Book/metadata.abs'), '')
      fs.writeFileSync(path.join(root, 'Book/Meta.OPF'), '')
      fs.writeFileSync(path.join(root, 'Book/info.NFO'), '')
      const d = await scanBook()
      const name = (lf) => lf?.metadata.relPath ?? null
      matchSnapshot(this, {
        desc: name(d.descTxtLibraryFile),
        reader: name(d.readerTxtLibraryFile),
        json: name(d.metadataJsonLibraryFile),
        abs: name(d.metadataAbsLibraryFile),
        opf: name(d.metadataOpfLibraryFile),
        nfo: name(d.metadataNfoLibraryFile),
        audio: d.audioLibraryFiles.map(name).sort(byKey),
        image: d.imageLibraryFiles.map(name),
        ebook: d.ebookLibraryFiles.map(name)
      })
    })

    it('checkAudioFileRemoved / checkEbookFileRemoved', async function () {
      const d = new LibraryItemScanData({ libraryFiles: [], mediaMetadata: {} })
      const af = (p, ino) => ({ ino, metadata: { path: p, ext: path.extname(p) } })
      d.libraryFilesRemoved = [af('/b/1.mp3', '10')]
      const results = {
        audioRemovedByPath: d.checkAudioFileRemoved({ ino: '99', metadata: { path: '/b/1.mp3' } }),
        audioRemovedByIno: d.checkAudioFileRemoved({ ino: '10', metadata: { path: '/b/other.mp3' } }),
        audioNotRemoved: d.checkAudioFileRemoved({ ino: '11', metadata: { path: '/b/2.mp3' } })
      }
      const noRemovals = new LibraryItemScanData({ libraryFiles: [], mediaMetadata: {} })
      results.audioNothingRemoved = noRemovals.checkAudioFileRemoved({ ino: '10', metadata: { path: '/b/1.mp3' } })
      // no ebook files in the scan: any existing ebook is considered removed
      results.ebookNoneScanned = noRemovals.checkEbookFileRemoved({ ino: '1', metadata: { path: '/b/a.epub' } })
      const withEbook = new LibraryItemScanData({ libraryFiles: [{ ino: '5', metadata: { path: '/b/a.epub', ext: '.epub' } }], mediaMetadata: {} })
      results.ebookSamePath = withEbook.checkEbookFileRemoved({ ino: '1', metadata: { path: '/b/a.epub' } })
      results.ebookSameIno = withEbook.checkEbookFileRemoved({ ino: '5', metadata: { path: '/b/moved.epub' } })
      results.ebookDifferent = withEbook.checkEbookFileRemoved({ ino: '6', metadata: { path: '/b/other.epub' } })
      matchSnapshot(this, results)
    })

    it('setBookMetadataFromFilenames only copies parsed values that are set', function () {
      const d = new LibraryItemScanData({ libraryFiles: [], mediaMetadata: { title: 'T', subtitle: null, asin: 'B0015T963C', publishedYear: '2012', authors: ['A One', 'A Two'], narrators: [], seriesName: 'S', seriesSequence: '2' } })
      const target = { title: 'Old', subtitle: 'Old Sub', narrators: ['Keep'] }
      d.setBookMetadataFromFilenames(target)
      const noSeq = new LibraryItemScanData({ libraryFiles: [], mediaMetadata: { title: 'T', seriesName: 'S', seriesSequence: null } })
      const target2 = {}
      noSeq.setBookMetadataFromFilenames(target2)
      matchSnapshot(this, { target, target2 })
    })
  })
})
