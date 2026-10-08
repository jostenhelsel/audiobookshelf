const fs = require('fs')
const path = require('path')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { rmTree, mkTmp } = require('./helpers/seed-scanner-fs')
const media = require('./helpers/seed-scanner-media')
const { setupScan, runScan, viewItems, stable } = require('./helpers/seed-scanner-run')

const Database = require('../../server/Database')
const AudioFileScanner = require('../../server/scanner/AudioFileScanner')
const LibraryScan = require('../../server/scanner/LibraryScan')

const logLines = (scan) => scan.logs.map((l) => `${l.levelName}: ${l.message}`)
const future = () => Date.now() / 1000 + 600 // a clearly later mtime for modified fixture files

describe('ScannerPodcast (characterization)', function () {
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
  const pod = (...p) => path.join(root, 'My Podcast', ...p)
  // tags shared by every episode: the podcast's own metadata is read from the FIRST scanned episode, and the scan order is the
  // filesystem order, so tests keep these identical across episodes
  const showTags = { album: 'Show Album', album_artist: 'Show Host', genre: 'Technology;News', language: 'eng', 'itunes-id': '12345', 'podcast-type': 'serial' }

  const brief = (i) => ({
    relPath: i.relPath,
    isMissing: i.isMissing,
    title: i.media.metadata.title,
    author: i.media.metadata.author,
    description: i.media.metadata.description,
    genres: i.media.metadata.genres,
    language: i.media.metadata.language,
    type: i.media.metadata.type,
    itunesId: i.media.metadata.itunesId,
    feedUrl: i.media.metadata.feedUrl,
    explicit: i.media.metadata.explicit,
    tags: i.media.tags,
    coverPath: i.media.coverPath,
    numEpisodes: i.media.numEpisodes,
    autoDownloadEpisodes: i.media.autoDownloadEpisodes,
    autoDownloadSchedule: i.media.autoDownloadSchedule,
    maxNewEpisodesToDownload: i.media.maxNewEpisodesToDownload,
    episodes: i.media.episodes
      .map((e) => ({
        file: e.audioFile.metadata.relPath,
        title: e.title,
        subtitle: e.subtitle,
        season: e.season,
        episode: e.episode,
        episodeType: e.episodeType,
        pubDate: e.pubDate,
        publishedAtIsSet: !!e.publishedAt,
        description: e.description,
        duration: Math.round(e.audioFile.duration),
        index: e.audioFile.index,
        chapters: e.chapters.length
      }))
      .sort((a, b) => (a.file < b.file ? -1 : 1)),
    libraryFiles: i.libraryFiles.map((f) => f.metadata.relPath)
  })

  describe('tag mapping (no files)', () => {
    it('setPodcastMetadataFromAudioMetaTags', function () {
      const run = (metaTags) => {
        const scan = new LibraryScan()
        const metadata = { title: 'Folder Title' }
        AudioFileScanner.setPodcastMetadataFromAudioMetaTags({ metaTags }, metadata, scan)
        return { metadata, logs: logLines(scan) }
      }
      snap(this, {
        allTags: run({ tagAlbum: ' Album ', tagAlbumArtist: 'Album Artist', tagArtist: 'Artist', tagGenre: 'Tech / News', tagLanguage: 'en', tagItunesId: '99', tagPodcastType: 'episodic' }),
        alternates: run({ tagSeries: 'Series Title', tagArtist: 'Only Artist' }),
        albumBeatsSeries: run({ tagAlbum: 'Album', tagSeries: 'Series' }),
        nothing: run({})
      })
    })

    it('setPodcastEpisodeMetadataFromAudioMetaTags', function () {
      const run = (metaTags, episode = {}) => {
        const scan = new LibraryScan()
        const podcastEpisode = { audioFile: { metaTags }, ...episode }
        AudioFileScanner.setPodcastEpisodeMetadataFromAudioMetaTags(podcastEpisode, scan)
        const { audioFile, ...rest } = podcastEpisode
        return { episode: rest, logs: logLines(scan) }
      }
      snap(this, {
        allTags: run({ tagComment: 'Comment', tagDescription: 'Description', tagSubtitle: 'Sub', tagDate: '2021-05-04T10:00:00Z', tagDisc: '2', tagTrack: '7', tagTitle: 'Ep Title', tagEpisodeType: 'bonus' }),
        alternates: run({ tagDescription: 'Description only', tagSeriesPart: '12' }),
        invalidDate: run({ tagDate: 'not a date' }),
        yearOnlyDate: run({ tagDate: '2019' }),
        invalidEpisodeType: run({ tagEpisodeType: 'special' }),
        trailerType: run({ tagEpisodeType: 'trailer' }),
        existingKept: run({ tagSubtitle: 'New' }, { title: 'Kept', subtitle: 'Old' })
      })
    })
  })

  describe('scanning a new podcast', () => {
    beforeEach(needFfmpeg)

    const scanOnce = async (o = {}) => {
      const c = await setupScan(api, root, { mediaType: 'podcast', ...o })
      const scan = await runScan(c)
      return { c, view: await stable(c, { scan, items: (await viewItems(c)).map(brief), emitted: emittedNames() }) }
    }

    it('episodes with tags: title, subtitle, season, episode, type, date, description, and podcast metadata from the first episode', async function () {
      media.makeAudio(pod('ep1.mp3'), { tags: { ...showTags, title: 'First Episode', subtitle: 'The start', date: '2021-05-04T10:00:00Z', disc: '1', track: '1', comment: 'About the first', 'episode-type': 'full' } })
      media.makeAudio(pod('ep2.mp3'), { tags: { ...showTags, title: 'Second Episode', date: '2021-05-11T10:00:00Z', disc: '1', track: '2', description: 'About the second', 'episode-type': 'bonus' } })
      media.makeAudio(pod('ep3.mp3'), { tags: { ...showTags, title: 'Third Episode', date: 'garbage', 'episode-type': 'nonsense' } })
      snap(this, (await scanOnce()).view)
    })

    it('without tags the folder is the title and file names are the episode titles (season/episode are not parsed from names)', async function () {
      media.makeAudio(pod('S01E02 - Some Name.mp3'))
      media.makeAudio(pod('Episode 12.mp3'))
      media.makeAudio(pod('2020-01-05 Dated.m4a'))
      snap(this, (await scanOnce()).view)
    })

    it('cover.jpg is the cover, otherwise the first image, otherwise embedded art is extracted', async function () {
      media.makeAudio(path.join(root, 'With Cover/a.mp3'), { cover: true })
      fs.writeFileSync(path.join(root, 'With Cover/cover.jpg'), media.makeJpeg())
      fs.writeFileSync(path.join(root, 'With Cover/aaa.png'), media.PNG_1X1)
      media.makeAudio(path.join(root, 'First Image/a.mp3'), { cover: true })
      fs.writeFileSync(path.join(root, 'First Image/zzz.png'), media.PNG_1X1)
      fs.writeFileSync(path.join(root, 'First Image/bbb.jpg'), media.makeJpeg())
      media.makeAudio(path.join(root, 'Embedded/a.mp3'), { cover: true })
      media.makeAudio(path.join(root, 'No Cover/a.mp3'))
      snap(this, (await scanOnce()).view)
    })

    it('metadata.json fills podcast fields (feed url, itunes ids, tags, type, explicit) over tags', async function () {
      media.makeAudio(pod('ep1.mp3'), { tags: { ...showTags, title: 'Ep' } })
      fs.writeFileSync(
        pod('metadata.json'),
        JSON.stringify({
          title: 'Json Podcast',
          author: 'Json Host',
          description: '<p>Json <i>description</i><script>x()</script></p>',
          releaseDate: '2020-01-01',
          genres: ['Json Genre'],
          tags: ['t1'],
          feedURL: 'https://example.invalid/feed.xml',
          imageURL: 'https://example.invalid/img.jpg',
          itunesPageURL: 'https://example.invalid/itunes',
          itunesId: '777',
          itunesArtistId: '888',
          asin: 'B00JSON000',
          language: 'fr',
          explicit: true,
          podcastType: 'episodic'
        })
      )
      snap(this, (await scanOnce()).view)
    })

    it('old nested metadata.json format and invalid json', async function () {
      media.makeAudio(path.join(root, 'Nested/a.mp3'))
      fs.writeFileSync(path.join(root, 'Nested/metadata.json'), JSON.stringify({ metadata: { title: 'Nested Title', author: 'Nested Author', feedUrl: 'https://example.invalid/old.xml', type: 'serial', explicit: false }, tags: ['x'] }))
      media.makeAudio(path.join(root, 'Broken/a.mp3'))
      fs.writeFileSync(path.join(root, 'Broken/metadata.json'), '{ nope')
      snap(this, (await scanOnce()).view)
    })

    it('folders: season subfolders become separate podcasts, nested author folders keep the last folder as title, root files are ignored', async function () {
      media.makeAudio(path.join(root, 'root-episode.mp3'))
      media.makeAudio(path.join(root, 'Podcast B/Season 1/a.mp3'))
      media.makeAudio(path.join(root, 'Podcast B/Season 2/a.mp3'))
      media.makeAudio(path.join(root, 'Network/Podcast C/a.mp3'))
      fs.mkdirSync(path.join(root, 'Empty Podcast'), { recursive: true })
      snap(this, (await scanOnce()).view)
    })

    it('corrupt audio is skipped; a folder with nothing playable is not added', async function () {
      media.makeAudio(path.join(root, 'Half/a.mp3'))
      fs.writeFileSync(path.join(root, 'Half/b.mp3'), 'garbage')
      fs.mkdirSync(path.join(root, 'Bad'), { recursive: true })
      fs.writeFileSync(path.join(root, 'Bad/a.mp3'), 'garbage')
      snap(this, (await scanOnce()).view)
    })

    it('storeMetadataWithItem writes metadata.json into the podcast folder', async function () {
      global.ServerSettings = { ...global.ServerSettings, storeMetadataWithItem: true }
      media.makeAudio(pod('ep1.mp3'), { tags: { ...showTags, title: 'Ep' } })
      const { c, view } = await scanOnce()
      snap(this, { view, written: JSON.parse(fs.readFileSync(pod('metadata.json'), 'utf8')), libraryFilesOnItem: (await viewItems(c))[0].libraryFiles.map((f) => f.metadata.relPath) })
    })

    it('the saved metadata.json copy lists the podcast fields', async function () {
      media.makeAudio(pod('ep1.mp3'), { tags: { ...showTags, title: 'Ep' } })
      const { c } = await scanOnce()
      const item = (await viewItems(c))[0]
      snap(this, JSON.parse(fs.readFileSync(path.join(api.tmp, 'metadata', 'items', item.id, 'metadata.json'), 'utf8')))
    })
  })

  describe('rescanning a podcast', () => {
    beforeEach(needFfmpeg)

    const bump = (file) => fs.utimesSync(file, future(), future())
    // first scan, change, second scan; returns the values to snapshot
    async function rescanAfter(setup, change, { force = false } = {}) {
      setup()
      const c = await setupScan(api, root, { mediaType: 'podcast' })
      const first = await runScan(c)
      const before = (await viewItems(c)).map(brief)
      api.emitted.length = 0
      await change(c)
      const second = await runScan(c, { force })
      const after = (await viewItems(c)).map(brief)
      return { c, view: await stable(c, { first: { added: first.added }, before, second: { added: second.added, updated: second.updated, missing: second.missing, logs: second.logs }, after, emitted: emittedNames() }) }
    }
    const twoEpisodes = () => {
      media.makeAudio(pod('ep1.mp3'), { tags: { ...showTags, title: 'One' } })
      media.makeAudio(pod('ep2.mp3'), { tags: { ...showTags, title: 'Two' } })
    }

    it('nothing changed', async function () {
      snap(this, (await rescanAfter(twoEpisodes, async () => {})).view)
    })

    it('forced rescan with nothing changed', async function () {
      snap(this, (await rescanAfter(twoEpisodes, async () => {}, { force: true })).view)
    })

    it('an episode added', async function () {
      snap(this, (await rescanAfter(twoEpisodes, async () => media.makeAudio(pod('ep3.mp3'), { tags: { ...showTags, title: 'Three', disc: '2', track: '5' } }))).view)
    })

    it('an episode removed: its media progress and playlist entries go with it', async function () {
      const { view } = await rescanAfter(twoEpisodes, async (ctx) => {
        const users = await api.seed.users()
        const item = (await Database.libraryItemModel.findAll({ where: { libraryId: ctx.library.id } }))[0]
        const episodes = await Database.podcastEpisodeModel.findAll({ where: { podcastId: item.mediaId } })
        const doomed = episodes.find((e) => e.audioFile.metadata.relPath === 'ep1.mp3')
        const kept = episodes.find((e) => e.audioFile.metadata.relPath === 'ep2.mp3')
        await Database.mediaProgressModel.create({ userId: users.user.id, mediaItemId: doomed.id, mediaItemType: 'podcastEpisode', duration: 1, currentTime: 0.5, isFinished: false, podcastId: item.mediaId, extraData: { libraryItemId: item.id } })
        await Database.mediaProgressModel.create({ userId: users.user.id, mediaItemId: kept.id, mediaItemType: 'podcastEpisode', duration: 1, currentTime: 0.5, isFinished: false, podcastId: item.mediaId, extraData: { libraryItemId: item.id } })
        const playlist = await Database.playlistModel.create({ name: 'Mine', libraryId: ctx.library.id, userId: users.user.id, description: null })
        await Database.playlistMediaItemModel.create({ playlistId: playlist.id, mediaItemId: doomed.id, mediaItemType: 'podcastEpisode', order: 1 })
        api.emitted.length = 0
        fs.rmSync(pod('ep1.mp3'))
      })
      snap(this, { view, progressLeft: (await Database.mediaProgressModel.findAll()).length, playlistsLeft: (await Database.playlistModel.findAll()).length })
    })

    it('a modified episode file re-reads its tags into the episode', async function () {
      snap(
        this,
        (
          await rescanAfter(twoEpisodes, async () => {
            media.makeAudio(pod('ep1.mp3'), { tags: { ...showTags, title: 'One Retitled', comment: 'new description', track: '9' } })
            bump(pod('ep1.mp3'))
          })
        ).view
      )
    })

    it('a modified episode file that became corrupt keeps its old episode', async function () {
      snap(
        this,
        (
          await rescanAfter(twoEpisodes, async () => {
            fs.writeFileSync(pod('ep2.mp3'), 'corrupt')
            bump(pod('ep2.mp3'))
          })
        ).view
      )
    })

    it('a cover added, then removed', async function () {
      const { c, view } = await rescanAfter(twoEpisodes, async () => fs.writeFileSync(pod('cover.jpg'), media.makeJpeg()))
      snap(this, view)
      fs.rmSync(pod('cover.jpg'))
      const third = await runScan(c)
      snap(this, await stable(c, { removed: { updated: third.updated, logs: third.logs }, after: (await viewItems(c)).map(brief) }), 'cover removed')
    })

    it('metadata.json added and edited; the saved copy under <metadata>/items still wins afterwards', async function () {
      const { c, view } = await rescanAfter(twoEpisodes, async () => fs.writeFileSync(pod('metadata.json'), JSON.stringify({ title: 'Json Title', author: 'Json Author', tags: ['a'] })))
      snap(this, view)
      fs.writeFileSync(pod('metadata.json'), JSON.stringify({ title: 'Json Title 2', description: 'v2' }))
      bump(pod('metadata.json'))
      const edited = await runScan(c)
      snap(this, await stable(c, { edited: { updated: edited.updated, logs: edited.logs }, after: (await viewItems(c)).map(brief) }), 'edited')
    })

    it('every audio file removed but the folder remains: the podcast is not marked missing and keeps its episodes', async function () {
      snap(
        this,
        (
          await rescanAfter(twoEpisodes, async () => {
            fs.rmSync(pod('ep1.mp3'))
            fs.rmSync(pod('ep2.mp3'))
          })
        ).view
      )
    })

    it('the whole podcast folder removed: the podcast is marked missing', async function () {
      snap(
        this,
        (
          await rescanAfter(twoEpisodes, async () => {
            // create the other file BEFORE deleting: ext4/overlayfs hands a freed inode to the next new file, and the scanner would then
            // treat `Other` as a rename of the deleted podcast (inode match); APFS does not reuse inodes that fast
            media.makeAudio(path.join(root, 'Other/ep.mp3'))
            fs.rmSync(pod(), { recursive: true })
          })
        ).view
      )
    })
  })
})
