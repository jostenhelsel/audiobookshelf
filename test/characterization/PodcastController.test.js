const fs = require('fs')
const path = require('path')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const Database = require('../../server/Database')
const opmlParser = require('../../server/utils/parsers/parseOPML')
const { createLibrary, createBook } = require('./helpers/seed-library')
const { waitFor, PNG_1X1 } = require('./helpers/seed-items-extra')
const { createUser, createProgress, audioBookExtra } = require('./helpers/seed-users-extra')
const { fixedId, rssXml, stubFeeds, recordingFake, createPodcastLibrary, createFeedPodcast } = require('./helpers/seed-podcast-extra')

const FEED = 'https://feeds.test/pod.xml'
// 2020 dates: far enough from "now" that the snapshot normalizer leaves publishedAt alone
const FEED_EPISODES = [
  { title: 'Ep 1', guid: 'guid-1', pubDate: 'Wed, 01 Jan 2020 10:00:00 GMT', url: 'https://cdn.test/ep1.mp3', season: '1', episode: '1' },
  { title: 'Ep 2', guid: 'guid-2', pubDate: 'Wed, 08 Jan 2020 10:00:00 GMT', url: 'https://cdn.test/ep2.mp3', length: 2222, season: '1', episode: '2' },
  { title: 'Brand new episode', guid: 'guid-3', pubDate: 'Wed, 15 Jan 2020 10:00:00 GMT', url: 'https://cdn.test/ep3.mp3' }
]
const OPML = `<?xml version="1.0"?><opml version="1.0"><head><title>Subs</title></head><body>
<outline text="Podcasts"><outline type="rss" text="First" title="First Pod" xmlUrl="https://feeds.test/first.xml"/><outline type="rss" text="Second" xmlUrl="https://feeds.test/second.xml"/><outline type="rss" text="No url"/></outline>
</body></opml>`

describe('PodcastController (characterization)', () => {
  let api, users, lf, podLf, pod, noFeed, book, feeds, podcastManager, cronManager

  beforeEach(async () => {
    podcastManager = recordingFake({
      getParsedOPMLFileFeeds: (text) => opmlParser.parse(text),
      checkAndDownloadNewEpisodes: async () => [{ title: 'Brand new episode', guid: 'guid-3' }],
      getEpisodeDownloadsInQueue: (id) => [{ toJSONForClient: () => ({ id: 'dl-1', libraryItemId: id, episodeDisplayTitle: 'Queued episode', isFinished: false }) }]
    })
    cronManager = recordingFake()
    api = await startApi({ managers: { podcastManager, cronManager } })
    users = await api.seed.users()
    feeds = stubFeeds({ [FEED]: rssXml({ title: 'Feed Podcast', episodes: FEED_EPISODES }) })
    podLf = await createPodcastLibrary(api.tmp)
    pod = await createFeedPodcast(podLf, {
      title: 'Local Pod',
      feedURL: FEED,
      episodes: [
        { title: 'Ep 1', filename: 'ep1.mp3', ino: 'ino-1' },
        { title: 'Ep 2', filename: 'ep2.mp3', ino: 'ino-2' },
        { title: 'Ep 3', filename: 'ep3.mp3', ino: 'ino-3' }
      ]
    })
    noFeed = await createFeedPodcast(podLf, { title: 'No Feed Pod', episodes: [] })
    // explicit is false (not NULL) so that user/guest accounts can see podcasts
    await pod.podcast.update({ explicit: false })
    await noFeed.podcast.update({ explicit: false })
    lf = await createLibrary({ name: 'Books' })
    book = (await createBook(lf, { title: 'A Book', extra: audioBookExtra({}) })).libraryItem
  })

  afterEach(async () => {
    feeds.restore()
    await api.stop()
  })

  // inode numbers come from the real filesystem
  const scrub = (v) => {
    if (Array.isArray(v)) return v.map(scrub)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'ino' && typeof x === 'string' && /^\d+$/.test(x) ? '<ino>' : scrub(x)]))
    return v
  }
  const calls = () => [...podcastManager.calls.splice(0), ...cronManager.calls.splice(0).map((c) => ({ cron: true, ...c }))].map(({ method, args, cron }) => ({ method: cron ? `cronManager.${method}` : method, args: args.map((a) => (a === cronManager ? '<cronManager>' : a && a.id && a.media ? { libraryItem: a.id } : a && a.dataValues && a.dataValues.path ? { folder: a.id, path: a.path } : a)) }))
  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, scrub({ res, emitted, ...extra }), { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const E = (n) => fixedId('e', n)
  const ep = (i) => pod.episodes[i].id
  const withCalls = () => ({ calls: calls() })

  describe('POST /api/podcasts', () => {
    const newPod = (over = {}) => {
      const { media, ...rest } = over
      return {
        libraryId: podLf.library.id,
        folderId: podLf.folder.id,
        path: path.join(podLf.folder.path, 'New Pod'),
        media: { metadata: { title: 'New Pod', author: 'New Author', feedUrl: 'https://feeds.test/new.xml', description: '<p>About <script>x</script>it</p>', genres: ['Tech'], explicit: false, language: 'en' }, autoDownloadEpisodes: true, autoDownloadSchedule: '0 1 * * *', tags: ['t1'], ...media },
        ...rest
      }
    }
    const create = (as, json) => api.request('POST', '/api/podcasts', { as, json })

    it('requires authentication and an admin', async function () {
      this.ids = new Map()
      snap(this, await create(undefined, newPod()), 'unauthenticated')
      snap(this, await create('user', newPod()), 'user')
      snap(this, await create('guest', newPod()), 'guest')
    })
    it('rejects invalid bodies', async function () {
      this.ids = new Map()
      snap(this, await create('admin', { ...newPod(), media: undefined }), 'no media')
      snap(this, await create('admin', { ...newPod(), media: {} }), 'no metadata')
      snap(this, await create('admin', newPod({ media: { autoDownloadSchedule: 'every day' } })), 'bad cron')
      snap(this, await create('admin', newPod({ libraryId: 'nope' })), 'unknown library')
      snap(this, await create('admin', newPod({ folderId: 'nope' })), 'unknown folder')
      snap(this, await create('admin', newPod({ path: undefined })), 'no path')
      snap(this, await create('admin', newPod({ path: '   ' })), 'blank path')
      snap(this, await create('admin', newPod({ path: path.join(api.tmp, 'elsewhere', 'Pod') })), 'path outside the folder')
      snap(this, await create('admin', newPod({ path: pod.itemPath })), 'podcast exists at path')
      snap(this, { dirExists: fs.existsSync(path.join(api.tmp, 'elsewhere')), items: await Database.libraryItemModel.count() }, 'nothing created')
    })
    it('creates a podcast as admin and root', async function () {
      this.ids = new Map()
      const res = await create('admin', newPod())
      await waitFor(() => cronManager.calls.length)
      snap(this, res, 'admin', { ...withCalls(), dirCreated: fs.existsSync(path.join(podLf.folder.path, 'New Pod')) })
      snap(this, await create('root', newPod({ path: path.join(podLf.folder.path, 'Nested', 'Deep Pod'), media: { autoDownloadEpisodes: false, autoDownloadSchedule: undefined, metadata: { title: 'The Deep Pod', itunesId: 12345 } } })), 'root nested, no auto download, numeric itunesId', { ...withCalls() })
      snap(this, await api.request('GET', `/api/libraries/${podLf.library.id}/items?sort=media.metadata.title`, { as: 'admin' }), 'library items afterwards')
    })
    it('downloads the cover when imageUrl is given', async function () {
      this.ids = new Map()
      feeds.restore()
      feeds = stubFeeds({ 'https://img.test/cover.png': { image: PNG_1X1 } })
      snap(this, await create('admin', newPod({ path: path.join(podLf.folder.path, 'Cover Pod'), media: { autoDownloadEpisodes: false, metadata: { title: 'Cover Pod', imageUrl: 'https://img.test/cover.png' } } })), 'cover downloaded', { requests: feeds.requests, files: fs.readdirSync(path.join(podLf.folder.path, 'Cover Pod')) })
      snap(this, await create('admin', newPod({ path: path.join(podLf.folder.path, 'Bad Cover'), media: { autoDownloadEpisodes: false, metadata: { title: 'Bad Cover', imageUrl: 'https://img.test/missing.png' } } })), 'cover download fails, podcast still created', { files: fs.readdirSync(path.join(podLf.folder.path, 'Bad Cover')) })
    })
  })

  describe('POST /api/podcasts/feed', () => {
    const feed = (as, rssFeed) => api.request('POST', '/api/podcasts/feed', { as, json: rssFeed === undefined ? {} : { rssFeed } })
    it('requires an admin and validates the url', async function () {
      snap(this, await feed(undefined, FEED), 'unauthenticated')
      snap(this, await feed('user', FEED), 'user')
      snap(this, await feed('guest', FEED), 'guest')
      snap(this, await feed('admin', undefined), 'no url')
      snap(this, await feed('admin', 'not a url'), 'invalid url')
      snap(this, await feed('admin', 5), 'numeric url')
    })
    it('returns the parsed feed, or 404 when the request fails', async function () {
      snap(this, await feed('admin', FEED), 'admin', { requests: feeds.requests.splice(0) })
      snap(this, await feed('root', FEED), 'root')
      snap(this, await feed('admin', 'https://feeds.test/missing.xml'), 'feed request fails', { requests: feeds.requests.splice(0) })
    })
  })

  describe('POST /api/podcasts/opml/parse', () => {
    const parse = (as, body) => api.request('POST', '/api/podcasts/opml/parse', { as, json: body })
    it('parses OPML text through the podcast manager', async function () {
      snap(this, await parse(undefined, { opmlText: OPML }), 'unauthenticated', withCalls())
      snap(this, await parse('user', { opmlText: OPML }), 'user', withCalls())
      snap(this, await parse('admin', {}), 'no text', withCalls())
      snap(this, await parse('admin', { opmlText: OPML }), 'admin', withCalls())
      snap(this, await parse('root', { opmlText: '<opml></opml>' }), 'no feeds', withCalls())
    })
  })

  describe('POST /api/podcasts/opml/create', () => {
    const create = (as, body) => api.request('POST', '/api/podcasts/opml/create', { as, json: body })
    it('validates and hands the feeds to the podcast manager', async function () {
      this.ids = new Map()
      const good = { feeds: ['https://feeds.test/first.xml', 'https://feeds.test/second.xml'], libraryId: podLf.library.id, folderId: podLf.folder.id, autoDownloadEpisodes: true }
      snap(this, await create(undefined, good), 'unauthenticated')
      snap(this, await create('user', good), 'user')
      snap(this, await create('admin', { ...good, feeds: undefined }), 'no feeds')
      snap(this, await create('admin', { ...good, feeds: [] }), 'empty feeds')
      snap(this, await create('admin', { ...good, feeds: ['https://ok.test/x.xml', 'garbage'] }), 'invalid feed url')
      snap(this, await create('admin', { ...good, libraryId: undefined }), 'no library')
      snap(this, await create('admin', { ...good, folderId: undefined }), 'no folder')
      snap(this, await create('admin', { ...good, folderId: 'nope' }), 'unknown folder')
      snap(this, await create('admin', { ...good, libraryId: lf.library.id }), 'folder of another library', withCalls())
      snap(this, await create('admin', good), 'admin', withCalls())
      snap(this, await create('root', { ...good, autoDownloadEpisodes: undefined }), 'root without auto download', withCalls())
    })
  })

  describe('middleware (item lookup and permissions)', () => {
    it('404s, 500s and 403s before reaching the handler', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      const hidden = await createFeedPodcast(podLf, { title: 'Hidden', feedURL: FEED, episodes: [] })
      await hidden.podcast.update({ explicit: true })
      await createUser({ username: 'limited', type: 'admin', permissions: { accessAllLibraries: false, librariesAccessible: [lf.library.id] } })
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/downloads`), 'unauthenticated')
      snap(this, await api.request('GET', '/api/podcasts/nope/downloads', { as: 'admin' }), 'unknown item')
      snap(this, await api.request('GET', `/api/podcasts/${book.id}/downloads`, { as: 'admin' }), 'item is a book')
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/downloads`, { as: 'limited' }), 'no access to the library')
      snap(this, await api.request('GET', `/api/podcasts/${hidden.libraryItem.id}/downloads`, { as: 'user' }), 'explicit podcast hidden from user')
      snap(this, await api.request('GET', `/api/podcasts/${hidden.libraryItem.id}/downloads`, { as: 'admin' }), 'explicit podcast visible to admin')
    })
  })

  describe('GET /api/podcasts/:id/checknew', () => {
    it('checks for new episodes', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>'], [noFeed.libraryItem.id, '<noFeed>']])
      const check = (id, q = '', as = 'admin') => api.request('GET', `/api/podcasts/${id}/checknew${q}`, { as })
      snap(this, await check(pod.libraryItem.id, '', null), 'unauthenticated', withCalls())
      snap(this, await check(pod.libraryItem.id, '', 'user'), 'user', withCalls())
      snap(this, await check(noFeed.libraryItem.id), 'no feed url', withCalls())
      snap(this, await check(pod.libraryItem.id), 'default limit', withCalls())
      snap(this, await check(pod.libraryItem.id, '?limit=7'), 'limit 7', withCalls())
      snap(this, await check(pod.libraryItem.id, '?limit=abc'), 'non numeric limit', withCalls())
      snap(this, await check(pod.libraryItem.id, '?limit=0', 'root'), 'limit 0 as root', withCalls())
      podcastManager.checkAndDownloadNewEpisodes = async () => null
      snap(this, await check(pod.libraryItem.id), 'manager returns nothing', withCalls())
    })
  })

  describe('GET /api/podcasts/:id/downloads and /clear-queue', () => {
    it('lists the download queue for any user who can see the item', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      for (const as of ['admin', 'user', 'guest']) snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/downloads`, { as }), as, withCalls())
    })
    it('clears the queue as admin only', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      const clear = (as) => api.request('GET', `/api/podcasts/${pod.libraryItem.id}/clear-queue`, { as })
      snap(this, await clear(null), 'unauthenticated', withCalls())
      snap(this, await clear('user'), 'user', withCalls())
      snap(this, await clear('guest'), 'guest', withCalls())
      snap(this, await clear('admin'), 'admin', withCalls())
      snap(this, await clear('root'), 'root', withCalls())
      snap(this, await api.request('GET', '/api/podcasts/nope/clear-queue', { as: 'admin' }), 'unknown item', withCalls())
    })
  })

  describe('GET /api/podcasts/:id/search-episode', () => {
    it('searches the feed for an episode title', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>'], [noFeed.libraryItem.id, '<noFeed>']])
      const search = (id, q, as = 'admin') => api.request('GET', `/api/podcasts/${id}/search-episode${q}`, { as })
      snap(this, await search(pod.libraryItem.id, '?title=Ep 2', null), 'unauthenticated')
      snap(this, await search(noFeed.libraryItem.id, '?title=x'), 'no feed url')
      snap(this, await search(pod.libraryItem.id, '?title=Ep 2'), 'admin', { requests: feeds.requests.splice(0) })
      snap(this, await search(pod.libraryItem.id, '?title=Brand new', 'user'), 'any user can search')
      snap(this, await search(pod.libraryItem.id, '?title=zzzzzzzzzzzz'), 'no match')
    })
    it('answers 500 when the title is missing or not a string', async function () {
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/search-episode`, { as: 'admin' }), 'no title')
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/search-episode?title=a&title=b`, { as: 'admin' }), 'title twice')
    })
    it('returns no episodes when the feed cannot be fetched', async function () {
      await pod.podcast.update({ feedURL: 'https://feeds.test/missing.xml' })
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/search-episode?title=Ep`, { as: 'admin' }))
    })
  })

  describe('POST /api/podcasts/:id/download-episodes', () => {
    it('validates and queues the episodes through the manager', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      const dl = (id, body, as = 'admin') => api.request('POST', `/api/podcasts/${id}/download-episodes`, { as, json: body })
      const episodes = [{ title: 'Brand new episode', enclosure: { url: 'https://cdn.test/ep3.mp3', length: 1, type: 'audio/mpeg' }, guid: 'guid-3' }]
      snap(this, await dl(pod.libraryItem.id, episodes, null), 'unauthenticated', withCalls())
      snap(this, await dl(pod.libraryItem.id, episodes, 'user'), 'user', withCalls())
      snap(this, await dl(pod.libraryItem.id, episodes, 'guest'), 'guest', withCalls())
      snap(this, await dl(pod.libraryItem.id, {}), 'not an array', withCalls())
      snap(this, await dl(pod.libraryItem.id, []), 'empty array', withCalls())
      snap(this, await dl('nope', episodes), 'unknown item', withCalls())
      snap(this, await dl(pod.libraryItem.id, episodes), 'admin', withCalls())
      snap(this, await dl(pod.libraryItem.id, episodes, 'root'), 'root', withCalls())
    })
  })

  describe('POST /api/podcasts/:id/match-episodes', () => {
    it('requires an admin', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      const match = (id, q = '', as) => api.request('POST', `/api/podcasts/${id}/match-episodes${q}`, { as })
      snap(this, await match(pod.libraryItem.id), 'unauthenticated')
      snap(this, await match(pod.libraryItem.id, '', 'user'), 'user')
      snap(this, await match(pod.libraryItem.id, '', 'guest'), 'guest')
    })
    it('fills missing episode details from the feed, then has nothing left to match', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      const match = (q = '') => api.request('POST', `/api/podcasts/${pod.libraryItem.id}/match-episodes${q}`, { as: 'admin' })
      snap(this, await match(), 'first match', { requests: feeds.requests.splice(0) })
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/episode/${ep(0)}`, { as: 'admin' }), 'matched episode')
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/episode/${ep(2)}`, { as: 'admin' }), 'episode without a match is unchanged')
      snap(this, await match(), 'second match (matched episodes are skipped)', { requests: feeds.requests.splice(0) })
    })
    it('only overwrites existing details with override=1', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      await Database.podcastEpisodeModel.update({ description: 'old description' }, { where: { id: [ep(0), ep(1)] } })
      const match = (q = '') => api.request('POST', `/api/podcasts/${pod.libraryItem.id}/match-episodes${q}`, { as: 'admin' })
      snap(this, await match(), 'without override')
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/episode/${ep(1)}`, { as: 'admin' }), 'description kept')
      await Database.podcastEpisodeModel.update({ enclosureURL: null, enclosureSize: null, enclosureType: null }, { where: { id: [ep(0), ep(1), ep(2)] } })
      snap(this, await match('?override=1'), 'with override')
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/episode/${ep(1)}`, { as: 'admin' }), 'description overridden')
    })
    it('matches nothing when the feed cannot be fetched or the podcast has no feed', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>'], [noFeed.libraryItem.id, '<noFeed>']])
      await pod.podcast.update({ feedURL: 'https://feeds.test/missing.xml' })
      snap(this, await api.request('POST', `/api/podcasts/${pod.libraryItem.id}/match-episodes`, { as: 'admin' }), 'feed fails')
      snap(this, await api.request('POST', `/api/podcasts/${noFeed.libraryItem.id}/match-episodes`, { as: 'root' }), 'no feed url')
    })
  })

  describe('GET /api/podcasts/:id/episode/:episodeId', () => {
    it('returns an episode or 404', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      const get = (id, epId, as) => api.request('GET', `/api/podcasts/${id}/episode/${epId}`, { as })
      snap(this, await get(pod.libraryItem.id, ep(0)), 'unauthenticated')
      for (const as of ['admin', 'user', 'guest']) snap(this, await get(pod.libraryItem.id, ep(1), as), as)
      snap(this, await get(pod.libraryItem.id, E(99), 'admin'), 'unknown episode')
      snap(this, await get(noFeed.libraryItem.id, ep(0), 'admin'), 'episode of another podcast')
      snap(this, await get('nope', ep(0), 'admin'), 'unknown item')
    })
  })

  describe('PATCH /api/podcasts/:id/episode/:episodeId', () => {
    const patch = (epId, body, as = 'admin', id = pod.libraryItem.id) => api.request('PATCH', `/api/podcasts/${id}/episode/${epId}`, { as, json: body })

    it('requires update permission', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      snap(this, await patch(ep(0), { title: 'x' }, null), 'unauthenticated')
      snap(this, await patch(ep(0), { title: 'x' }, 'user'), 'user')
      snap(this, await patch(ep(0), { title: 'x' }, 'guest'), 'guest')
      snap(this, await patch(E(99), { title: 'x' }), 'unknown episode')
      snap(this, await patch(ep(0), { title: 'x' }, 'admin', 'nope'), 'unknown item')
    })
    it('updates supported string fields and sanitizes html', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      snap(this, await patch(ep(0), { title: 'New title', subtitle: '<b>Sub</b><script>alert(1)</script>', description: '<p>Hello <a href="http://x.test" onclick="evil()">link</a><img src=x onerror=evil()></p>', pubDate: 'Fri, 03 Jan 2020 10:00:00 GMT', season: '2', episode: '5', episodeType: 'bonus' }), 'strings')
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/episode/${ep(0)}`, { as: 'admin' }), 'follow-up GET')
      snap(this, await patch(ep(0), { title: 'New title' }), 'no change (no emit)')
      snap(this, await patch(ep(1), { title: 5, description: null, unknownKey: 'x', id: 'hack' }), 'wrong types and unsupported keys are ignored')
      snap(this, await patch(ep(1), {}), 'empty body')
    })
    it('updates enclosure, chapters and publishedAt', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      snap(this, await patch(ep(2), { enclosure: { url: 'https://cdn.test/new.mp3', type: 'audio/mpeg', length: '999' } }), 'enclosure')
      snap(this, await patch(ep(2), { enclosure: { url: 'https://cdn.test/other.mp3' } }), 'enclosure url only')
      snap(this, await patch(ep(2), { enclosure: { type: 'audio/mpeg' } }), 'enclosure without url is ignored')
      snap(this, await patch(ep(2), { enclosure: null }), 'enclosure null clears it')
      snap(this, await patch(ep(2), { chapters: [{ id: 0, title: 'Intro', start: 5, end: 10 }] }), 'chapters')
      snap(this, await patch(ep(2), { chapters: [{ id: 0, title: 'Zero start', start: 0, end: 10 }] }), 'chapter with start 0 is rejected silently')
      snap(this, await patch(ep(2), { chapters: 'x' }), 'chapters not an array')
      snap(this, await patch(ep(2), { publishedAt: 1577872800000 }), 'publishedAt')
      snap(this, await patch(ep(2), { publishedAt: '1577872800000' }), 'publishedAt string is ignored')
    })
  })

  describe('DELETE /api/podcasts/:id/episode/:episodeId', () => {
    const del = (epId, q = '', as = 'root', id = pod.libraryItem.id) => api.request('DELETE', `/api/podcasts/${id}/episode/${epId}${q}`, { as })

    it('requires delete permission (root only by default)', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      snap(this, await del(ep(0), '', null), 'unauthenticated')
      snap(this, await del(ep(0), '', 'admin'), 'admin')
      snap(this, await del(ep(0), '', 'user'), 'user')
      snap(this, await del(ep(0), '', 'guest'), 'guest')
      snap(this, await del(E(99)), 'unknown episode')
      snap(this, await del(ep(0), '', 'root', 'nope'), 'unknown item')
    })
    it('removes an episode but keeps the file, and cleans progress and playlists', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      await createProgress(users.user, { libraryItem: pod.libraryItem, mediaItemId: ep(0), episode: true, podcastId: pod.podcast.id, duration: 30, currentTime: 10, updatedAt: '2024-01-01T00:00:00Z' })
      await createProgress(users.user, { libraryItem: pod.libraryItem, mediaItemId: ep(1), episode: true, podcastId: pod.podcast.id, duration: 30, currentTime: 20, updatedAt: '2024-01-01T00:00:00Z' })
      const playlist = await Database.playlistModel.create({ userId: users.user.id, libraryId: podLf.library.id, name: 'Episodes' })
      await Database.playlistMediaItemModel.bulkCreate([
        { playlistId: playlist.id, mediaItemId: ep(0), mediaItemType: 'podcastEpisode', order: 1 },
        { playlistId: playlist.id, mediaItemId: ep(1), mediaItemType: 'podcastEpisode', order: 2 }
      ])
      const state = async () => ({
        files: fs.readdirSync(pod.itemPath).sort(),
        episodes: (await Database.podcastEpisodeModel.findAll({ where: { podcastId: pod.podcast.id }, order: [['index', 'ASC']] })).map((e) => e.title),
        progress: await Database.mediaProgressModel.count(),
        playlistItems: await Database.playlistMediaItemModel.count()
      })
      snap(this, await state(), 'state before')
      snap(this, await del(ep(0)), 'soft delete')
      snap(this, await state(), 'state after soft delete')
      snap(this, await del(ep(0)), 'delete again')
      snap(this, await api.request('GET', `/api/podcasts/${pod.libraryItem.id}/episode/${ep(0)}`, { as: 'admin' }), 'find after delete')
    })
    it('hard delete removes the audio file too', async function () {
      this.ids = new Map([[pod.libraryItem.id, '<pod>']])
      snap(this, await del(ep(1), '?hard=1'), 'hard delete', { filesLeft: fs.readdirSync(pod.itemPath).sort() })
      snap(this, await del(ep(2), '?hard=0'), 'hard=0 keeps the file', { filesLeft: fs.readdirSync(pod.itemPath).sort() })
      snap(this, await api.request('GET', `/api/items/${pod.libraryItem.id}`, { as: 'admin' }), 'item afterwards')
    })
  })
})
