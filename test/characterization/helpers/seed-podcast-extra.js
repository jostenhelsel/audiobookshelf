/*
 * Extra test-data helpers for Playlist/Session/Podcast characterization tests:
 *  - RSS feed XML + an axios adapter that serves it (network boundary stub, nothing leaves the process)
 *  - recording fakes for playbackSessionManager / podcastManager / cronManager
 *  - podcast libraries backed by a real folder, open (in-memory) playback sessions
 */
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const axios = require('axios')
const PlaybackSession = require('../../../server/objects/PlaybackSession')
const { createLibrary } = require('./seed-library')
const { createFilePodcast } = require('./seed-items-extra')

const fixedId = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** RSS document with `episodes`: { title, guid, pubDate, url, length?, type?, season?, episode? } */
function rssXml({ title = 'Feed Podcast', author = 'Feed Author', episodes = [] } = {}) {
  const items = episodes
    .map(
      (e) => `<item>
  <title>${e.title}</title>
  <description>Description of ${e.title}</description>
  <guid isPermaLink="false">${e.guid}</guid>
  <pubDate>${e.pubDate}</pubDate>
  <enclosure url="${e.url}" length="${e.length || 1234}" type="${e.type || 'audio/mpeg'}"/>
  ${e.season ? `<itunes:season>${e.season}</itunes:season>` : ''}
  ${e.episode ? `<itunes:episode>${e.episode}</itunes:episode>` : ''}
</item>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>${title}</title>
  <description>About ${title}</description>
  <link>https://feeds.test/site</link>
  <language>en</language>
  <itunes:author>${author}</itunes:author>
  <itunes:explicit>no</itunes:explicit>
  <itunes:type>episodic</itunes:type>
  ${items}
</channel>
</rss>`
}

/**
 * Serve `feeds` ({ [url]: xmlString | { image: Buffer } }) through axios' adapter; any other URL fails like a 404.
 * Returns { requests, restore }. The server's podcast code calls axios() directly, so the adapter is the module boundary.
 */
function stubFeeds(feeds) {
  const original = axios.defaults.adapter
  const requests = []
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method, url: config.url, responseType: config.responseType })
    const feed = feeds[config.url]
    if (feed === undefined) {
      const err = new Error('Request failed with status code 404')
      err.response = { status: 404 }
      throw err
    }
    const data = typeof feed === 'string' ? Buffer.from(feed) : Readable.from([feed.image])
    return { data, status: 200, statusText: 'OK', headers: { 'content-type': typeof feed === 'string' ? 'application/rss+xml' : 'image/png' }, config, request: {} }
  }
  return { requests, restore: () => (axios.defaults.adapter = original) }
}

/** Recording fake: every method call is pushed to `calls` and returns the value from `returns[method]` */
function recordingFake(returns = {}, extra = {}) {
  const calls = []
  const handler = {
    get(target, prop) {
      if (prop === 'calls') return calls
      if (prop in target) return target[prop]
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      return (...args) => {
        calls.push({ method: prop, args })
        const r = returns[prop]
        return typeof r === 'function' ? r(...args) : r
      }
    }
  }
  return new Proxy({ ...extra }, handler)
}

/** Podcast library whose folder is a real directory inside `root` */
async function createPodcastLibrary(root, o = {}) {
  const folderPath = path.join(root, o.dir || 'podcasts')
  fs.mkdirSync(folderPath, { recursive: true })
  return createLibrary({ name: o.name || 'Podcasts', mediaType: 'podcast', path: folderPath })
}

/** Podcast item with a feed url and N on-disk episodes (episode ids ascending, see createFilePodcast) */
async function createFeedPodcast(lf, o) {
  const res = await createFilePodcast(lf, { title: o.title, author: 'Pod Author', episodes: o.episodes || [] })
  if (o.feedURL !== undefined) await res.podcast.update({ feedURL: o.feedURL })
  return res
}

/** Open (in-memory) playback session object like the PlaybackSessionManager keeps */
function openSession(o) {
  const session = new PlaybackSession({
    id: o.id,
    userId: o.userId,
    libraryId: o.libraryId,
    libraryItemId: o.libraryItemId,
    bookId: o.bookId || null,
    episodeId: o.episodeId || null,
    mediaType: o.mediaType || 'book',
    mediaMetadata: { title: o.title || 'Open session' },
    chapters: [],
    displayTitle: o.title || 'Open session',
    displayAuthor: 'Someone',
    coverPath: null,
    duration: 3600,
    playMethod: o.playMethod ?? 0,
    mediaPlayer: 'test-player',
    deviceInfo: { clientName: 'Test Client', deviceId: 'dev-1' },
    serverVersion: '2.0.0-test',
    date: '2024-01-02',
    dayOfWeek: 'Tuesday',
    timeListening: 10,
    startTime: 0,
    currentTime: 5,
    startedAt: 1700000000000,
    updatedAt: 1700000000000
  })
  session.audioTracks = o.audioTracks || []
  return session
}

module.exports = { fixedId, rssXml, stubFeeds, recordingFake, createPodcastLibrary, createFeedPodcast, openSession }
