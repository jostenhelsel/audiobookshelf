const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { makeTree, rmTree, mkTmp } = require('./helpers/seed-scanner-fs')
const media = require('./helpers/seed-scanner-media')
const { scrub, setupScan, runScan, viewItems, stable } = require('./helpers/seed-scanner-run')

const Database = require('../../server/Database')
const AudioFileScanner = require('../../server/scanner/AudioFileScanner')
const MediaProbeData = require('../../server/scanner/MediaProbeData')
const LibraryScan = require('../../server/scanner/LibraryScan')
const NfoFileScanner = require('../../server/scanner/NfoFileScanner')
const OpfFileScanner = require('../../server/scanner/OpfFileScanner')

const fakeFile = (o = {}) => ({
  index: 0,
  ino: '1',
  duration: 10,
  chapters: [],
  metaTags: {},
  embeddedCoverArt: null,
  metadata: { filename: 'file.mp3', path: '/book/file.mp3' },
  trackNumFromMeta: null,
  discNumFromMeta: null,
  trackNumFromFilename: null,
  discNumFromFilename: null,
  ...o
})
const logLines = (scan) => scan.logs.map((l) => `${l.levelName}: ${l.message}`)
const future = () => Date.now() / 1000 + 600 // a clearly later mtime for modified fixture files

describe('ScannerBook (characterization)', function () {
  this.timeout(60000)
  let api, root

  beforeEach(async () => {
    api = await startApi()
    root = mkTmp()
  })
  afterEach(async () => {
    await api.stop()
    rmTree(root)
  })

  const snap = (ctx, value, label) => matchSnapshot(ctx, value, { label, tmpDirs: [root, api.tmp] })
  const needFfmpeg = function () {
    if (!media.hasFfmpeg()) this.skip()
  }
  const emittedNames = () => api.emitted.map((e) => e.method + ':' + e.args[0])

  describe('AudioFileScanner helpers (no files)', () => {
    it('isSequential / removeDupes', function () {
      snap(this, {
        isSequential: [[], null, [1], [1, 2, 3], [1, 3], [3, 2, 1], [0, 1, 1, 2], [2, 3, 4]].map((n) => [n, AudioFileScanner.isSequential(n)]),
        removeDupes: [[], null, [5], [1, 1, 2, 2, 3], [3, 2, 1], [1, 2, 2, 5, 5, 4]].map((n) => [n, AudioFileScanner.removeDupes(n)])
      })
    })

    it('runSmartTrackOrder: orders by filename or meta track numbers, discs, and sets index', function () {
      const names = (files) => files.map((f) => `${f.index}:${f.metadata.filename}`)
      const mk = (filename, o) => fakeFile({ metadata: { filename, path: '/b/' + filename }, ...o })
      const cases = {
        empty: AudioFileScanner.runSmartTrackOrder('b', []).length,
        byFilenameNumbers: names(AudioFileScanner.runSmartTrackOrder('b', [mk('c.mp3', { trackNumFromFilename: 3 }), mk('a.mp3', { trackNumFromFilename: 1 }), mk('b.mp3', { trackNumFromFilename: 2 })])),
        byMetaNumbers: names(AudioFileScanner.runSmartTrackOrder('b', [mk('x.mp3', { trackNumFromMeta: 2 }), mk('y.mp3', { trackNumFromMeta: 1 })])),
        filenameWinsWhenMoreDistinctNumbers: names(AudioFileScanner.runSmartTrackOrder('b', [mk('a.mp3', { trackNumFromFilename: 2, trackNumFromMeta: 1 }), mk('b.mp3', { trackNumFromFilename: 1, trackNumFromMeta: 1 })])),
        metaWinsOnTie: names(AudioFileScanner.runSmartTrackOrder('b', [mk('a.mp3', { trackNumFromFilename: 2, trackNumFromMeta: 1 }), mk('b.mp3', { trackNumFromFilename: 1, trackNumFromMeta: 2 })])),
        discsFromMeta: names(AudioFileScanner.runSmartTrackOrder('b', [mk('d2t1.mp3', { discNumFromMeta: 2, trackNumFromMeta: 1 }), mk('d1t2.mp3', { discNumFromMeta: 1, trackNumFromMeta: 2 }), mk('d1t1.mp3', { discNumFromMeta: 1, trackNumFromMeta: 1 })])),
        discsFromFilename: names(AudioFileScanner.runSmartTrackOrder('b', [mk('2-1.mp3', { discNumFromFilename: 2, trackNumFromFilename: 1 }), mk('1-2.mp3', { discNumFromFilename: 1, trackNumFromFilename: 2 }), mk('1-1.mp3', { discNumFromFilename: 1, trackNumFromFilename: 1 })])),
        discGapIsNotSequential: names(AudioFileScanner.runSmartTrackOrder('b', [mk('a.mp3', { discNumFromMeta: 1, trackNumFromMeta: 2 }), mk('b.mp3', { discNumFromMeta: 3, trackNumFromMeta: 1 })])),
        noNumbersKeepsInputOrder: names(AudioFileScanner.runSmartTrackOrder('b', [mk('b.mp3'), mk('a.mp3'), mk('c.mp3')]))
      }
      snap(this, cases)
    })

    it('getTrackAndDiscNumberFromFilename', function () {
      const lf = (filename, dir = '/lib/Book') => ({ metadata: { filename, path: `${dir}/${filename}` } })
      const run = (filename, meta = {}, dir) => AudioFileScanner.getTrackAndDiscNumberFromFilename(meta, lf(filename, dir))
      snap(this, {
        plain: run('01.mp3'),
        prefixed: run('Track 07.mp3'),
        firstNumberWins: run('Chapter 12 - Part 3.mp3'),
        fourDigits: run('12345.mp3'),
        noNumber: run('intro.mp3'),
        discInName: run('Disc 2 - 05.mp3'),
        cdInName: run('CD1 track 3.mp3'),
        discFromFolder: run('04.mp3', {}, '/lib/Book/CD 02'),
        folderBeatsName: run('Disc 1 04.mp3', {}, '/lib/Book/Disk 3'),
        titleRemovedFromName: run('My Book 2 - 03.mp3', { title: 'My Book 2' }),
        authorAndSeriesRemoved: run('Some Author Saga 05.mp3', { author: 'Some Author', series: 'Saga' }),
        publishedYearRemoved: run('2012 - 08.mp3', { publishedYear: '2012' }),
        discTooManyDigits: run('disc 123 4.mp3')
      })
    })

    it('parseGenresString', function () {
      snap(this, Object.fromEntries(['', 'Fantasy', 'Fantasy;Sci-Fi; History', 'Fantasy / Sci-Fi', 'A//B', 'A/B;C', ';;', 'Sci-Fi & Fantasy'].map((g) => [g, AudioFileScanner.parseGenresString(g)])))
    })

    it('setBookMetadataFromAudioMetaTags: tag mapping, alternate tags, series variants', function () {
      const run = (metaTags, bookMetadata = {}) => {
        const scan = new LibraryScan()
        AudioFileScanner.setBookMetadataFromAudioMetaTags('Folder Title', [fakeFile({ metaTags })], bookMetadata, scan)
        return { bookMetadata, logs: logLines(scan) }
      }
      snap(this, {
        allTags: run({ tagComposer: ' N One & N Two ', tagDescription: 'desc', tagComment: 'comment', tagPublisher: 'Pub', tagDate: '2012', tagSubtitle: 'Sub', tagAlbum: 'Album', tagTitle: 'Title', tagArtist: 'A One, A Two', tagAlbumArtist: 'Album Artist', tagGenre: 'Fantasy;Sci-Fi', tagSeries: 'Series', tagSeriesPart: '2', tagIsbn: '123', tagLanguage: 'en', tagASIN: 'B0015T963C' }),
        alternateTags: run({ tagComment: 'comment only', tagTitle: 'Title only', tagAlbumArtist: 'Album Artist only' }),
        groupingSeries: run({ tagGrouping: 'Series A; Series B #2; Series C #1.5' }),
        groupingIgnoredWhenSeriesTagSet: run({ tagSeries: 'Real', tagGrouping: 'Other #3' }),
        multipleSeriesTags: run({ tagSeries: 'S1; S2', tagSeriesPart: '1; 2' }),
        multipleSeriesMismatch: run({ tagSeries: 'S1; S2', tagSeriesPart: '1' }),
        multipleSeriesMismatch2: run({ tagSeries: 'S1; S2', tagSeriesPart: '1; 2; 3' }),
        seriesWithoutPart: run({ tagSeries: 'Lonely' }),
        nonStringIgnored: run({ tagTitle: 5, tagAlbum: '' }),
        existingValuesKeptWhenNoTag: run({ tagPublisher: 'New' }, { title: 'Folder', publisher: 'Old', subtitle: 'Keep' })
      })
    })

    it('getBookChaptersFromAudioFiles: embedded chapters, per-file chapters, tag titles, filenames', function () {
      const run = (files, bookTitle = 'Book') => {
        const scan = new LibraryScan()
        const chapters = AudioFileScanner.getBookChaptersFromAudioFiles(bookTitle, files, scan)
        return { chapters, logs: logLines(scan) }
      }
      const ch = (id, start, end, title) => ({ id, start, end, title })
      const f = (filename, o) => fakeFile({ metadata: { filename, path: '/b/' + filename }, ...o })
      snap(this, {
        singleFileEmbedded: run([f('a.m4b', { duration: 100, chapters: [ch(0, 0, 50, 'One'), ch(1, 50, 100, 'Two')] })]),
        sameEmbeddedInAllFiles: run([f('a.m4b', { chapters: [ch(0, 0, 5, 'One'), ch(1, 5, 10, 'Two')] }), f('b.m4b', { chapters: [ch(0, 0, 5, 'One'), ch(1, 5, 10, 'Two')] })]),
        differentEmbeddedPerFile: run([f('a.mp3', { duration: 10, chapters: [ch(0, 0, 5, 'A1'), ch(1, 5, 10, 'A2')] }), f('b.mp3', { duration: 20, chapters: [ch(0, 0, 20, 'B1')] })]),
        shortEmbeddedChaptersSkipped: run([f('a.mp3', { duration: 10, chapters: [ch(0, 0, 0.05, 'Blip'), ch(1, 0.05, 10, 'Real')] }), f('b.mp3', { duration: 10, chapters: [ch(0, 0, 10, 'Other')] })]),
        fileWithoutDurationSkipped: run([f('a.mp3', { duration: 10, chapters: [ch(0, 0, 10, 'A')] }), f('b.mp3', { duration: 0, chapters: [ch(0, 0, 10, 'B')] })]),
        noChaptersSingleFile: run([f('a.mp3')]),
        filenamesAsChapters: run([f('01 Intro.mp3', { duration: 10 }), f('02 Middle.mp3', { duration: 20 })]),
        uniqueTagTitlesAsChapters: run([f('a.mp3', { duration: 10, metaTags: { tagTitle: 'Intro' } }), f('b.mp3', { duration: 20, metaTags: { tagTitle: 'Middle' } })]),
        tagTitleEqualToBookTitleFallsBack: run([f('a.mp3', { duration: 10, metaTags: { tagTitle: 'Book' } }), f('b.mp3', { duration: 20, metaTags: { tagTitle: 'Middle' } })]),
        duplicateTagTitlesFallBack: run([f('a.mp3', { duration: 10, metaTags: { tagTitle: 'Same' } }), f('b.mp3', { duration: 20, metaTags: { tagTitle: 'Same' } })]),
        missingFilenameFallsBackToChapterN: run([f(undefined, { duration: 10, metadata: { path: '/b/x.mp3' } }), f('b.mp3', { duration: 5 })])
      })
    })

    it('MediaProbeData.construct / setData', function () {
      const probe = new MediaProbeData()
      probe.setData({ video_stream: { codec: 'mjpeg' }, format: 'MP3', duration: 12.3, size: 100, audio_stream: { bit_rate: 64000, codec: 'mp3', time_base: '1/14112000', language: 'eng', channel_layout: 'stereo', channels: 2, sample_rate: 44100 }, bit_rate: 70000, chapters: [{ id: 0, start: 0, end: 12.3, title: 'c' }], tags: { tagTitle: 'T', tagTrack: '3/9', tagDisc: '1/2' } })
      const noVideo = new MediaProbeData()
      noVideo.setData({ video_stream: null, format: 'M4B', duration: 1, size: 1, audio_stream: { codec: 'aac' }, bit_rate: 5000, tags: {} })
      const constructed = new MediaProbeData({ duration: 5, unknown: 'x', audioMetaTags: { tagTitle: 'Q', tagTrack: '2' } })
      snap(this, {
        probe: { ...probe, audioMetaTags: { tags: probe.audioMetaTags.toJSON(), track: probe.trackNumber, disc: probe.audioMetaTags.discNumber } },
        noVideo: { embeddedCoverArt: noVideo.embeddedCoverArt, videoStream: noVideo.videoStream, bitRate: noVideo.bitRate, chapters: noVideo.chapters },
        constructed: { duration: constructed.duration, hasUnknown: 'unknown' in constructed, tags: constructed.audioMetaTags.toJSON() }
      })
    })
  })

  describe('probing real audio files', () => {
    beforeEach(needFfmpeg)

    it('AudioFileScanner.scan reads tags, track/disc numbers, cover art flag and chapters', async function () {
      media.makeAudio(path.join(root, 'tagged.mp3'), { tags: { title: 'Song', artist: 'Someone', album: 'Album', track: '2/5', disc: '1/2', composer: 'Reader', genre: 'Fantasy;Sci-Fi', date: '2012', comment: 'a comment' }, cover: true })
      media.makeAudio(path.join(root, 'chapters.m4b'), {
        seconds: 4,
        tags: { title: 'M4B Title', artist: 'M4B Author' },
        cover: true,
        chapters: [
          { title: 'One', start: 0, end: 2 },
          { title: 'Two', start: 2, end: 4 }
        ]
      })
      media.makeAudio(path.join(root, 'plain.ogg'), { tags: { title: 'Opus Title' } })
      media.makeAudio(path.join(root, 'flac.flac'))
      fs.writeFileSync(path.join(root, 'broken.mp3'), 'this is not audio')
      const lf = (name) => ({ metadata: { path: path.join(root, name), filename: name, relPath: name, ext: path.extname(name), size: 1 }, ino: '1' })
      const out = {}
      for (const name of ['tagged.mp3', 'chapters.m4b', 'plain.ogg', 'flac.flac', 'broken.mp3']) {
        const audioFile = await AudioFileScanner.scan('book', lf(name), { title: 'Folder' })
        out[name] = audioFile ? scrub(audioFile.toJSON()) : null
      }
      snap(this, out)
    })

    it('executeMediaFileScans drops files that cannot be probed and keeps input order', async function () {
      media.makeAudio(path.join(root, '1.mp3'))
      fs.writeFileSync(path.join(root, '2.mp3'), 'garbage')
      media.makeAudio(path.join(root, '3.mp3'))
      const lf = (name) => ({ metadata: { path: path.join(root, name), filename: name, relPath: name, ext: '.mp3', size: 1 }, ino: name })
      const files = await AudioFileScanner.executeMediaFileScans('book', { mediaMetadata: { title: 'x' } }, [lf('1.mp3'), lf('2.mp3'), lf('3.mp3')])
      snap(
        this,
        files.map((f) => ({ filename: f.metadata.filename, trackNumFromFilename: f.trackNumFromFilename }))
      )
    })

    it('probeAudioFile returns the raw ffprobe output', async function () {
      media.makeAudio(path.join(root, 'a.mp3'), { tags: { title: 'Raw' } })
      const raw = await AudioFileScanner.probeAudioFile(path.join(root, 'a.mp3'))
      snap(this, { keys: Object.keys(raw).sort(), formatName: raw.format?.format_name, streamCodecs: raw.streams?.map((s) => s.codec_name), titleTag: raw.format?.tags?.title })
    })
  })

  describe('scanning a new book', () => {
    beforeEach(needFfmpeg)

    // scan the tree once; the snapshot value is returned so the test body takes the snapshot
    const scanOnce = async (o = {}) => {
      const c = await setupScan(api, root, o.library)
      const scan = await runScan(c)
      return { c, view: await stable(c, { scan, items: await viewItems(c), emitted: emittedNames() }) }
    }

    it('a single audio file in the library root (isFile item)', async function () {
      media.makeAudio(path.join(root, 'Single Book.mp3'), { tags: { title: 'Tagged Title', artist: 'Tagged Author' } })
      snap(this, (await scanOnce()).view)
    })

    it('folder with several tracks: ordering, duration, chapters from files, folder and tag metadata', async function () {
      const dir = path.join(root, 'Author Name/Series Name/Book 3 - Great Title {Reader One}')
      media.makeAudio(path.join(dir, '10 Last.mp3'), { tags: { title: 'Last', track: '3/3' } })
      media.makeAudio(path.join(dir, '02 Middle.mp3'), { tags: { title: 'Middle', track: '2/3' } })
      media.makeAudio(path.join(dir, '01 First.mp3'), { tags: { title: 'First', track: '1/3' } })
      snap(this, (await scanOnce()).view)
    })

    it('multi-disc folders order by disc then track', async function () {
      const dir = path.join(root, 'Disc Book')
      media.makeAudio(path.join(dir, 'CD 2/01.mp3'))
      media.makeAudio(path.join(dir, 'CD 1/02.mp3'))
      media.makeAudio(path.join(dir, 'CD 1/01.mp3'))
      snap(this, (await scanOnce()).view)
    })

    it('cover.jpg in the folder is the cover; desc.txt and reader.txt fill description and narrator', async function () {
      const dir = path.join(root, 'Covered')
      media.makeAudio(path.join(dir, 'a.mp3'), { tags: { title: 'T', artist: 'A' }, cover: true })
      fs.writeFileSync(path.join(dir, 'cover.jpg'), media.makeJpeg())
      fs.writeFileSync(path.join(dir, 'other.png'), media.PNG_1X1)
      fs.writeFileSync(path.join(dir, 'desc.txt'), '  A description from desc.txt  \n')
      fs.writeFileSync(path.join(dir, 'reader.txt'), 'Reader One, Reader Two\nsecond line ignored\n')
      snap(this, (await scanOnce()).view)
    })

    it('without cover.jpg the first image file is the cover; embedded art is only extracted when there is no image', async function () {
      const dir = path.join(root, 'Images')
      media.makeAudio(path.join(dir, 'a.mp3'), { cover: true })
      fs.writeFileSync(path.join(dir, 'zzz.png'), media.PNG_1X1)
      fs.writeFileSync(path.join(dir, 'aaa.jpg'), media.makeJpeg())
      const c = await setupScan(api, root)
      await runScan(c)
      const items = await viewItems(c)
      snap(this, { coverFile: path.basename(items[0].media.coverPath), metadataItemsDirExists: fs.existsSync(path.join(api.tmp, 'metadata', 'items', items[0].id, 'cover.jpg')) })
    })

    it('embedded cover art is extracted to <metadata>/items/<id>/cover.jpg (png art would be cover.png)', async function () {
      media.makeAudio(path.join(root, 'Embedded/a.m4b'), { cover: true, tags: { title: 'T' } })
      const c = await setupScan(api, root)
      await runScan(c)
      const items = await viewItems(c)
      const coverPath = items[0].media.coverPath
      snap(this, { coverRelativeToMetadata: path.relative(path.join(api.tmp, 'metadata'), coverPath).replace(items[0].id, '<id>'), exists: fs.existsSync(coverPath), isJpeg: fs.readFileSync(coverPath).subarray(0, 2).toString('hex') === 'ffd8' })
    })

    it('storeCoverWithItem puts the extracted cover next to the audio files (never for isFile items)', async function () {
      global.ServerSettings = { ...global.ServerSettings, storeCoverWithItem: true }
      media.makeAudio(path.join(root, 'In Folder/a.mp3'), { cover: true })
      media.makeAudio(path.join(root, 'Root File.mp3'), { cover: true })
      const c = await setupScan(api, root)
      await runScan(c)
      const items = await viewItems(c)
      snap(this, Object.fromEntries(items.map((i) => [i.relPath, { coverPath: i.media.coverPath, libraryFiles: i.libraryFiles.map((f) => f.metadata.relPath).sort() }])), undefined)
    })

    it('chapters embedded in an m4b are used', async function () {
      media.makeAudio(path.join(root, 'Chaptered/book.m4b'), {
        seconds: 4,
        tags: { title: 'Chaptered', artist: 'Au' },
        chapters: [
          { title: 'Intro', start: 0, end: 2 },
          { title: 'Body', start: 2, end: 4 }
        ]
      })
      snap(this, (await scanOnce()).view)
    })

    it('a corrupt audio file is skipped; a folder where nothing can be probed is not added', async function () {
      media.makeAudio(path.join(root, 'Half Good/01.mp3'))
      makeTree({ 'Half Good/02.mp3': 'garbage', 'All Bad/01.mp3': 'garbage', 'All Bad/cover.jpg': '' }, root)
      snap(this, (await scanOnce()).view)
    })

    it('metadata precedence: default order, a custom order, and an invalid source name', async function () {
      const dir = path.join(root, 'Folder Author/Folder Series/Book 2 - Folder Title')
      media.makeAudio(path.join(dir, 'a.mp3'), { tags: { album: 'Tag Title', artist: 'Tag Author', series: 'Tag Series', 'series-part': '7', date: '1999' } })
      const c = await setupScan(api, root)
      await runScan(c)
      const dflt = (await viewItems(c))[0].media.metadata
      const pick = (m) => ({ title: m.title, authors: m.authors.map((a) => a.name), series: m.series.map((s) => `${s.name} #${s.sequence}`), publishedYear: m.publishedYear })

      // same tree, tags before folder structure, plus a bogus source
      const root2 = makeTree({}, mkTmp())
      try {
        fs.cpSync(root, root2, { recursive: true })
        fs.rmSync(path.join(root2, 'metadata'), { recursive: true, force: true })
        const c2 = await setupScan(api, root2, { settings: { metadataPrecedence: ['audioMetatags', 'folderStructure', 'bogusSource'] } })
        const scan = await runScan(c2)
        const custom = (await viewItems(c2))[0].media.metadata
        snap(this, { default: pick(dflt), custom: pick(custom), logs: scan.logs.filter((l) => /precedence|Invalid/.test(l)) })
      } finally {
        rmTree(root2)
      }
    })

    it('metadata.json overrides tags (default precedence), empty arrays and nulls do not', async function () {
      const dir = path.join(root, 'Json Book')
      media.makeAudio(path.join(dir, 'a.mp3'), { tags: { album: 'Tag Title', artist: 'Tag Author', composer: 'Tag Narrator', genre: 'Tag Genre' } })
      fs.writeFileSync(
        path.join(dir, 'metadata.json'),
        JSON.stringify({
          title: 'Json Title',
          subtitle: 'Json Subtitle',
          authors: ['Json Author'],
          narrators: [],
          series: ['Json Series #4', 'Other Series'],
          genres: [],
          tags: ['t1', 't2'],
          publishedYear: 2020,
          publisher: null,
          description: '<p>Json <b>description</b><script>alert(1)</script></p>',
          isbn: '9781234567890',
          asin: 'B000000000',
          language: 'French',
          explicit: 'true',
          abridged: true,
          chapters: [
            { id: 0, start: 0, end: 0.5, title: 'First' },
            { id: 1, start: 0.5, end: 1, title: 'Second' }
          ]
        })
      )
      snap(this, (await scanOnce()).view)
    })

    it('metadata.json variants: old nested format, invalid json, invalid chapter, wrong types', async function () {
      media.makeAudio(path.join(root, 'Nested/a.mp3'))
      fs.writeFileSync(path.join(root, 'Nested/metadata.json'), JSON.stringify({ metadata: { title: 'Nested Title', authors: ['Nested Author'], explicit: 'false' }, tags: ['x'] }))
      media.makeAudio(path.join(root, 'Invalid/a.mp3'))
      fs.writeFileSync(path.join(root, 'Invalid/metadata.json'), '{ not json')
      media.makeAudio(path.join(root, 'BadChapter/a.mp3'))
      fs.writeFileSync(path.join(root, 'BadChapter/metadata.json'), JSON.stringify({ title: 'Bad Chapter', chapters: [{ id: 0, start: 'x', end: 1, title: 'c' }] }))
      media.makeAudio(path.join(root, 'WrongTypes/a.mp3'))
      fs.writeFileSync(path.join(root, 'WrongTypes/metadata.json'), JSON.stringify({ title: ['no'], subtitle: 5, authors: 'single', explicit: 'maybe', publishedYear: {}, narrators: ['A', 'A', ' ', 7] }))
      snap(this, (await scanOnce()).view)
    })

    it('.nfo, .opf, desc.txt and reader.txt feed metadata (default order: nfo, txt, opf)', async function () {
      const dir = path.join(root, 'Files Book')
      media.makeAudio(path.join(dir, 'a.mp3'))
      fs.writeFileSync(path.join(dir, 'book.nfo'), ['Title: Nfo Title: Nfo Subtitle', 'Author: Nfo One, Nfo Two', 'Narrator: Nfo Reader', 'Series Name: Nfo Series', 'Position in Series: 3', 'Genre: Nfo Genre, Other', 'Publisher: Nfo Pub', 'Release Date: June 2011', 'ASIN: B0NFO00000', 'Unabridged: Yes', 'Language: English', '', 'Book Description', '=====', 'Nfo description line', ''].join('\n'))
      fs.writeFileSync(path.join(dir, 'desc.txt'), 'Txt description wins over nfo')
      fs.writeFileSync(
        path.join(dir, 'book.opf'),
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0"><metadata><dc:title>Opf Title</dc:title><dc:creator opf:role="aut">Opf Author</dc:creator><dc:publisher>Opf Pub</dc:publisher><dc:date>2005-05-05</dc:date><dc:subject>Opf Genre</dc:subject><dc:identifier opf:scheme="ISBN">9780000000002</dc:identifier><meta name="calibre:series" content="Opf Series"/><meta name="calibre:series_index" content="9"/></metadata></package>`
      )
      snap(this, (await scanOnce()).view)
    })

    it('NfoFileScanner / OpfFileScanner merge rules on a metadata object', async function () {
      const nfo = path.join(root, 'a.nfo')
      fs.writeFileSync(nfo, ['Title: T', 'Author: A', 'Genre: G', 'Tags: t1, t2', 'Series Name: S', 'Position in Series: 2', 'Abridged: No'].join('\n'))
      const withExisting = { title: 'Old', genres: ['Keep?'], tags: [], authors: ['Old Author'], series: [{ name: 'Old', sequence: '1' }], narrators: ['Old Nar'], publisher: 'Old Pub' }
      await NfoFileScanner.scanBookNfoFile({ metadata: { path: nfo } }, withExisting)
      const empty = path.join(root, 'empty.nfo')
      fs.writeFileSync(empty, '')
      const untouched = { title: 'Same' }
      await NfoFileScanner.scanBookNfoFile({ metadata: { path: empty } }, untouched)
      const opf = path.join(root, 'a.opf')
      fs.writeFileSync(opf, '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>OT</dc:title></metadata></package>')
      const opfTarget = { title: 'Old', authors: ['Keep'], genres: ['Keep'] }
      await OpfFileScanner.scanBookOpfFile({ metadata: { path: opf } }, opfTarget)
      const badOpf = path.join(root, 'bad.opf')
      fs.writeFileSync(badOpf, 'not xml at all')
      const badTarget = { title: 'Same' }
      await OpfFileScanner.scanBookOpfFile({ metadata: { path: badOpf } }, badTarget)
      snap(this, { withExisting, untouched, opfTarget, badTarget })
    })

    it('an epub alone: metadata and cover come from the epub', async function () {
      media.makeEpub(path.join(root, 'Epub Book/book.epub'), { title: 'Epub Title', creators: [{ name: 'Epub Author' }, { name: 'Epub Narrator', role: 'nrt' }], series: 'Epub Series', seriesIndex: '2', subjects: ['Epub Genre'], publisher: 'Epub Pub', date: '2015-03-01', language: 'en', description: 'Epub description', isbn: '9781111111111', cover: true })
      snap(this, (await scanOnce()).view)
    })

    it('an epub as a root file, and a cbz with ComicInfo.xml', async function () {
      media.makeEpub(path.join(root, 'Root Epub.epub'), { title: 'Root Epub Title', creators: [{ name: 'Root Author' }] })
      media.makeCbz(path.join(root, 'Comic Book/comic.cbz'), { comicInfo: '<ComicInfo><Series>Comic Series</Series><Number>5</Number><Summary>Comic summary</Summary></ComicInfo>' })
      media.makeCbz(path.join(root, 'Plain Comic/comic.cbz'))
      snap(this, (await scanOnce()).view)
    })

    it('audio plus ebook: tags win over the epub, the epub is the ebook file, other ebooks are supplementary', async function () {
      const dir = path.join(root, 'Audio And Ebook')
      media.makeAudio(path.join(dir, 'a.mp3'), { tags: { album: 'Audio Title' } })
      media.makeEpub(path.join(dir, 'z.epub'), { title: 'Epub Title', creators: [{ name: 'Epub Author' }] })
      media.makeCbz(path.join(dir, 'a.cbz'))
      fs.writeFileSync(path.join(dir, 'm.pdf'), '%PDF')
      snap(this, (await scanOnce()).view)
    })

    it('without an epub the first ebook found is used (pdf has no metadata parser)', async function () {
      fs.mkdirSync(path.join(root, 'Pdf Book'), { recursive: true })
      fs.writeFileSync(path.join(root, 'Pdf Book/b.pdf'), '%PDF')
      fs.writeFileSync(path.join(root, 'Pdf Book/a.mobi'), 'mobi')
      snap(this, (await scanOnce()).view)
    })

    it('audiobooksOnly: ebooks are not added as ebook files, ebook-only folders are ignored', async function () {
      media.makeAudio(path.join(root, 'Audio And Ebook/a.mp3'))
      media.makeEpub(path.join(root, 'Audio And Ebook/b.epub'), { title: 'E' })
      media.makeEpub(path.join(root, 'Ebook Only/b.epub'), { title: 'E' })
      snap(this, (await scanOnce({ library: { settings: { audiobooksOnly: true } } })).view)
    })

    it('two books by the same author in the same series share the author and series; events are emitted', async function () {
      media.makeAudio(path.join(root, 'Shared Author/Shared Series/Book 1 - One/a.mp3'))
      media.makeAudio(path.join(root, 'Shared Author/Shared Series/Book 2 - Two/a.mp3'))
      const c = await setupScan(api, root)
      const scan = await runScan(c)
      const authors = await Database.authorModel.findAll({ where: { libraryId: c.library.id } })
      const series = await Database.seriesModel.findAll({ where: { libraryId: c.library.id } })
      const items = (await viewItems(c)).map((i) => ({ relPath: i.relPath, authors: i.media.metadata.authors.map((a) => a.name), series: i.media.metadata.series.map((s) => `${s.name} #${s.sequence}`) }))
      const emitted = api.emitted.map((e) => (e.args[0] === 'authors_num_books_updated' ? `${e.method}:${e.args[0]}:${e.args[1].authors.map((a) => a.numBooks).join(',')}` : `${e.method}:${e.args[0]}`))
      snap(this, await stable(c, { scan, items, numAuthors: authors.length, numSeries: series.length, authorLastFirst: authors.map((a) => a.lastFirst), emitted }))
    })

    it('saveMetadataFile writes metadata.json to <metadata>/items/<id>, or into the item folder with storeMetadataWithItem', async function () {
      media.makeAudio(path.join(root, 'Meta One/a.mp3'), { tags: { album: 'Meta One', artist: 'Author One', series: 'S', 'series-part': '2', genre: 'G1;G2' } })
      const c = await setupScan(api, root)
      await runScan(c)
      const item = (await viewItems(c))[0]
      const fileInMetadata = JSON.parse(fs.readFileSync(path.join(api.tmp, 'metadata', 'items', item.id, 'metadata.json'), 'utf8'))

      global.ServerSettings = { ...global.ServerSettings, storeMetadataWithItem: true }
      media.makeAudio(path.join(root, 'Meta Two/a.mp3'), { tags: { album: 'Meta Two' } })
      const scan2 = await runScan(c)
      const items = await viewItems(c)
      const two = items.find((i) => i.relPath === 'Meta Two')
      snap(this, { fileInMetadata, inItemFolder: fs.existsSync(path.join(root, 'Meta Two/metadata.json')), twoLibraryFiles: two.libraryFiles.map((f) => f.metadata.relPath).sort(), scan2Logs: scan2.logs })
    })
  })

  describe('rescanning a book', () => {
    beforeEach(needFfmpeg)

    const brief = (i) => ({
      relPath: i.relPath,
      isMissing: i.isMissing,
      title: i.media.metadata.title,
      authors: i.media.metadata.authors.map((a) => a.name),
      narrators: i.media.metadata.narrators,
      series: i.media.metadata.series.map((s) => `${s.name} #${s.sequence}`),
      genres: i.media.metadata.genres,
      description: i.media.metadata.description,
      coverPath: i.media.coverPath,
      ebook: i.media.ebookFile?.metadata.relPath ?? null,
      duration: i.media.duration,
      audio: i.media.audioFiles.map((a) => a.metadata.relPath),
      audioTagAlbums: i.media.audioFiles.map((a) => a.metaTags.tagAlbum ?? null),
      chapters: i.media.chapters.map((c) => `${c.title} ${c.start}-${c.end}`),
      libraryFiles: i.libraryFiles.map((f) => `${f.metadata.relPath}${f.isSupplementary === null ? '' : f.isSupplementary ? ' (supplementary)' : ' (main)'}`)
    })
    // run a first scan, apply `change`, scan again, snapshot before/after
    async function rescanAfter(setup, change, { force = false, settings } = {}) {
      setup()
      const c = await setupScan(api, root, { settings })
      const first = await runScan(c)
      const before = (await viewItems(c)).map(brief)
      api.emitted.length = 0
      await change(c)
      const second = await runScan(c, { force })
      const after = (await viewItems(c)).map(brief)
      return { c, view: await stable(c, { first: { added: first.added, updated: first.updated, missing: first.missing }, before, second: { added: second.added, updated: second.updated, missing: second.missing, logs: second.logs }, after, emitted: emittedNames() }) }
    }
    const bump = (file) => fs.utimesSync(file, future(), future())
    const book = () => path.join(root, 'Rescan Book')

    it('nothing changed: no updates, also with a forced rescan', async function () {
      snap(
        this,
        (
          await rescanAfter(
            () => media.makeAudio(path.join(book(), '01.mp3'), { tags: { album: 'Same' } }),
            async () => {}
          )
        ).view
      )
    })

    it('forced rescan with no changes finds nothing to update', async function () {
      snap(
        this,
        (
          await rescanAfter(
            () => media.makeAudio(path.join(book(), '01.mp3'), { tags: { album: 'Same' } }),
            async () => {},
            { force: true }
          )
        ).view
      )
    })

    it('an audio file added: tracks and duration follow, chapters stay as saved in the metadata.json copy', async function () {
      snap(
        this,
        (
          await rescanAfter(
            () => {
              media.makeAudio(path.join(book(), '01.mp3'), { tags: { title: 'One' } })
              media.makeAudio(path.join(book(), '02.mp3'), { tags: { title: 'Two' } })
            },
            async () => media.makeAudio(path.join(book(), '03.mp3'), { tags: { title: 'Three' } })
          )
        ).view
      )
    })

    it('an audio file removed: the book keeps the other tracks (chapters stay as saved)', async function () {
      snap(
        this,
        (
          await rescanAfter(
            () => {
              media.makeAudio(path.join(book(), '01.mp3'), { tags: { title: 'One' } })
              media.makeAudio(path.join(book(), '02.mp3'), { tags: { title: 'Two' } })
            },
            async () => fs.rmSync(path.join(book(), '01.mp3'))
          )
        ).view
      )
    })

    it('an audio file replaced by a corrupt file keeps its old audio entry (item is not set missing); restored: updated again', async function () {
      const r = await rescanAfter(
        () => media.makeAudio(path.join(book(), '01.mp3'), { tags: { album: 'Fragile' } }),
        async () => {
          fs.writeFileSync(path.join(book(), '01.mp3'), 'corrupted')
          bump(path.join(book(), '01.mp3'))
        }
      )
      const c = r.c
      snap(this, r.view)
      media.makeAudio(path.join(book(), '01.mp3'), { tags: { album: 'Fragile' } })
      bump(path.join(book(), '01.mp3'))
      const third = await runScan(c)
      snap(this, await stable(c, { restored: { added: third.added, updated: third.updated, logs: third.logs }, after: (await viewItems(c)).map(brief) }), 'restored')
    })

    it('tags changed in an audio file: the audio file tags update but the saved metadata.json copy keeps title, author and narrator', async function () {
      snap(
        this,
        (
          await rescanAfter(
            () => media.makeAudio(path.join(book(), '01.mp3'), { tags: { album: 'Old Title', artist: 'Old Author', composer: 'Old Narrator' } }),
            async () => {
              media.makeAudio(path.join(book(), '01.mp3'), { tags: { album: 'New Title', artist: 'New Author', composer: 'New Narrator' } })
              bump(path.join(book(), '01.mp3'))
            }
          )
        ).view
      )
    })

    it('a cover image added, then removed', async function () {
      const r = await rescanAfter(
        () => media.makeAudio(path.join(book(), '01.mp3')),
        async () => fs.writeFileSync(path.join(book(), 'cover.jpg'), media.makeJpeg())
      )
      const c = r.c
      snap(this, r.view)
      fs.rmSync(path.join(book(), 'cover.jpg'))
      const third = await runScan(c)
      snap(this, await stable(c, { removed: { updated: third.updated, logs: third.logs }, after: (await viewItems(c)).map(brief) }), 'cover removed')
    })

    it('metadata.json added, edited, then deleted (the copy saved in <metadata>/items still applies)', async function () {
      const r = await rescanAfter(
        () => media.makeAudio(path.join(book(), '01.mp3'), { tags: { album: 'Tag Title' } }),
        async () => fs.writeFileSync(path.join(book(), 'metadata.json'), JSON.stringify({ title: 'Json Title', authors: ['Json Author'], series: ['Json Series #1'], description: 'v1' }))
      )
      const c = r.c
      snap(this, r.view)
      fs.writeFileSync(path.join(book(), 'metadata.json'), JSON.stringify({ title: 'Json Title 2', authors: ['Other Author'], description: 'v2' }))
      bump(path.join(book(), 'metadata.json'))
      const edited = await runScan(c)
      const afterEdit = (await viewItems(c)).map(brief)
      fs.rmSync(path.join(book(), 'metadata.json'))
      const deleted = await runScan(c)
      snap(
        this,
        await stable(c, { edited: { updated: edited.updated, logs: edited.logs }, afterEdit, deleted: { updated: deleted.updated, logs: deleted.logs }, afterDelete: (await viewItems(c)).map(brief), authors: (await Database.authorModel.findAll()).map((a) => a.name).sort(), series: (await Database.seriesModel.findAll()).map((s) => s.name).sort(), emitted: emittedNames() }),
        'edit and delete'
      )
    })

    it('an ebook added to an audiobook becomes the ebook file; removed again it is cleared', async function () {
      const r = await rescanAfter(
        () => media.makeAudio(path.join(book(), '01.mp3')),
        async () => media.makeEpub(path.join(book(), 'book.epub'), { title: 'Epub' })
      )
      const c = r.c
      snap(this, r.view)
      fs.rmSync(path.join(book(), 'book.epub'))
      const third = await runScan(c)
      snap(this, await stable(c, { removed: { updated: third.updated, logs: third.logs }, after: (await viewItems(c)).map(brief) }), 'ebook removed')
    })

    it('turning on audiobooksOnly drops the ebook file on the next rescan', async function () {
      const r = await rescanAfter(
        () => {
          media.makeAudio(path.join(book(), '01.mp3'))
          media.makeEpub(path.join(book(), 'book.epub'), { title: 'Epub' })
        },
        async (ctx) => {
          ctx.library.settings = { ...ctx.library.settings, audiobooksOnly: true }
          ctx.library.changed('settings', true)
          await ctx.library.save()
        },
        { force: true }
      )
      const c = r.c
      snap(this, r.view)
      expect(c).to.exist
    })

    it('a series that no book uses any more is deleted along with its feed (series_removed event)', async function () {
      snap(
        this,
        (
          await rescanAfter(
            () => {
              media.makeAudio(path.join(book(), '01.mp3'))
              fs.writeFileSync(path.join(book(), 'metadata.json'), JSON.stringify({ series: ['Doomed Series #1'], authors: ['Doomed Author'] }))
            },
            async () => {
              fs.writeFileSync(path.join(book(), 'metadata.json'), JSON.stringify({ series: ['Kept Series #2'], authors: ['Kept Author'] }))
              bump(path.join(book(), 'metadata.json'))
            }
          )
        ).view
      )
    })
  })
})
