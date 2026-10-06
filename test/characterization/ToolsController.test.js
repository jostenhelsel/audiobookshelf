const sinon = require('sinon')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createFileBook, createFilePodcast } = require('./helpers/seed-items-extra')
const Database = require('../../server/Database')

// ffmpeg work is behind abMergeManager / audioMetadataManager; they are replaced by recording fakes, so what is
// characterized is the controller: permission checks, item validation, option parsing and what is handed to the managers.
describe('ToolsController (characterization)', () => {
  let api, lf, book, bookNoAudio, podcast, abMerge, audioMetadata, pendingMerges, queued

  const snap = (ctx, res, label) => {
    const calls = { abMerge: [], audioMetadata: [] }
    for (const [name, fake] of [
      ['abMerge', abMerge],
      ['audioMetadata', audioMetadata]
    ]) {
      for (const [method, stub] of Object.entries(fake)) {
        for (const c of stub.getCalls()) calls[name].push({ method, args: c.args.map((a) => (Array.isArray(a) ? a.map((x) => ({ item: x.id })) : a && a.media ? { item: a.id, title: a.media.title } : a)) })
        stub.resetHistory()
      }
    }
    matchSnapshot(ctx, { res, calls, emitted: api.emitted.splice(0) }, { label, ids: ctx.ids })
  }

  beforeEach(async function () {
    pendingMerges = new Set()
    queued = new Set()
    abMerge = {
      getPendingTaskByLibraryItemId: sinon.stub().callsFake((id) => (pendingMerges.has(id) ? { task: { id: 'task-1' } } : null)),
      startAudiobookMerge: sinon.stub(),
      cancelEncode: sinon.stub()
    }
    audioMetadata = {
      getIsLibraryItemQueuedOrProcessing: sinon.stub().callsFake((id) => queued.has(id)),
      updateMetadataForItem: sinon.stub(),
      handleBatchEmbed: sinon.stub()
    }
    api = await startApi({ managers: { abMergeManager: abMerge, audioMetadataManager: audioMetadata } })
    await api.seed.users()
    lf = await createLibrary({ name: 'Books', path: `${api.tmp}/books` })
    book = (await createFileBook(lf, { title: 'Audio Book', audio: [{ filename: 'one.mp3', ino: '101' }, { filename: 'two.mp3', ino: '102' }] })).libraryItem
    bookNoAudio = (await createFileBook(lf, { title: 'No Audio Book', ebooks: [{ filename: 'b.epub', ino: '201', primary: true }] })).libraryItem
    const pl = await createLibrary({ name: 'Podcasts', mediaType: 'podcast', path: `${api.tmp}/pods` })
    podcast = (await createFilePodcast(pl, { title: 'A Podcast', episodes: [{ title: 'Ep 1', filename: 'ep1.mp3', ino: '301' }] })).libraryItem
    this.ids = new Map([
      [book.id, '<book>'],
      [bookNoAudio.id, '<book-no-audio>'],
      [podcast.id, '<podcast>']
    ])
  })

  afterEach(async () => {
    await api.stop()
  })

  const post = (url, as, json) => api.request('POST', url, { as, json })

  describe('POST /api/tools/item/:id/encode-m4b', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', `/api/tools/item/${book.id}/encode-m4b`))
    })
    it('is admin only', async function () {
      snap(this, await post(`/api/tools/item/${book.id}/encode-m4b`, 'user'), 'user')
      snap(this, await post(`/api/tools/item/${book.id}/encode-m4b`, 'guest'), 'guest')
    })
    it('404s for unknown items', async function () {
      snap(this, await post('/api/tools/item/nope/encode-m4b', 'admin'))
    })
    it('rejects invalid items', async function () {
      snap(this, await post(`/api/tools/item/${podcast.id}/encode-m4b`, 'admin'), 'podcast')
      snap(this, await post(`/api/tools/item/${bookNoAudio.id}/encode-m4b`, 'admin'), 'no audio tracks')
      await Database.libraryItemModel.update({ isMissing: true }, { where: { id: book.id } })
      snap(this, await post(`/api/tools/item/${book.id}/encode-m4b`, 'admin'), 'missing')
      await Database.libraryItemModel.update({ isMissing: false, isInvalid: true }, { where: { id: book.id } })
      snap(this, await post(`/api/tools/item/${book.id}/encode-m4b`, 'admin'), 'invalid')
    })
    it('rejects an item that is already merging', async function () {
      pendingMerges.add(book.id)
      snap(this, await post(`/api/tools/item/${book.id}/encode-m4b`, 'admin'))
    })
    it('starts a merge and passes the query as options', async function () {
      snap(this, await post(`/api/tools/item/${book.id}/encode-m4b`, 'admin'), 'no options')
      snap(this, await post(`/api/tools/item/${book.id}/encode-m4b?codec=aac&bitrate=128k&channels=2`, 'root'), 'with options')
    })
  })

  describe('DELETE /api/tools/item/:id/encode-m4b', () => {
    it('requires authentication and admin', async function () {
      snap(this, await api.request('DELETE', `/api/tools/item/${book.id}/encode-m4b`), 'anonymous')
      snap(this, await api.request('DELETE', `/api/tools/item/${book.id}/encode-m4b`, { as: 'user' }), 'user')
    })
    it('404s without a pending task, also for unknown items', async function () {
      snap(this, await api.request('DELETE', `/api/tools/item/${book.id}/encode-m4b`, { as: 'admin' }), 'no pending task')
      snap(this, await api.request('DELETE', '/api/tools/item/nope/encode-m4b', { as: 'admin' }), 'unknown item')
    })
    it('cancels a pending merge', async function () {
      pendingMerges.add(book.id)
      snap(this, await api.request('DELETE', `/api/tools/item/${book.id}/encode-m4b`, { as: 'admin' }))
    })
  })

  describe('POST /api/tools/item/:id/embed-metadata', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', `/api/tools/item/${book.id}/embed-metadata`))
    })
    it('is admin only', async function () {
      snap(this, await post(`/api/tools/item/${book.id}/embed-metadata`, 'user'), 'user')
    })
    it('404s for unknown items', async function () {
      snap(this, await post('/api/tools/item/nope/embed-metadata', 'admin'))
    })
    it('rejects invalid items with a bare 400', async function () {
      snap(this, await post(`/api/tools/item/${podcast.id}/embed-metadata`, 'admin'), 'podcast')
      snap(this, await post(`/api/tools/item/${bookNoAudio.id}/embed-metadata`, 'admin'), 'no audio')
      await Database.libraryItemModel.update({ isMissing: true }, { where: { id: book.id } })
      snap(this, await post(`/api/tools/item/${book.id}/embed-metadata`, 'admin'), 'missing')
    })
    it('rejects an item already queued', async function () {
      queued.add(book.id)
      snap(this, await post(`/api/tools/item/${book.id}/embed-metadata`, 'admin'))
    })
    it('starts the embed with parsed options', async function () {
      snap(this, await post(`/api/tools/item/${book.id}/embed-metadata`, 'admin'), 'no options')
      snap(this, await post(`/api/tools/item/${book.id}/embed-metadata?forceEmbedChapters=1&backup=1`, 'admin'), 'both options')
      snap(this, await post(`/api/tools/item/${book.id}/embed-metadata?forceEmbedChapters=true&backup=yes`, 'admin'), 'only "1" counts')
    })
  })

  describe('POST /api/tools/batch/embed-metadata', () => {
    it('requires authentication', async function () {
      snap(this, await post('/api/tools/batch/embed-metadata', undefined, { libraryItemIds: [book.id] }))
    })
    it('is admin only', async function () {
      snap(this, await post('/api/tools/batch/embed-metadata', 'user', { libraryItemIds: [book.id] }))
    })
    it('validates the payload', async function () {
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', {}), 'no ids')
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', { libraryItemIds: [] }), 'empty ids')
    })
    it('404s when any item is unknown and starts nothing', async function () {
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', { libraryItemIds: [book.id, 'nope'] }))
    })
    it('403s when the admin cannot access an item', async function () {
      const admin = await Database.userModel.findOne({ where: { username: 'admin' } })
      const permissions = { ...admin.permissions, accessAllLibraries: false, librariesAccessible: [] }
      await admin.update({ permissions })
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', { libraryItemIds: [book.id] }))
    })
    it('rejects invalid or queued items', async function () {
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', { libraryItemIds: [book.id, podcast.id] }), 'podcast')
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', { libraryItemIds: [bookNoAudio.id] }), 'no audio')
      queued.add(book.id)
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', { libraryItemIds: [book.id] }), 'queued')
    })
    it('starts the batch with parsed options', async function () {
      const other = (await createFileBook(lf, { title: 'Second Audio Book', audio: [{ filename: 'x.mp3', ino: '401' }] })).libraryItem
      this.ids.set(other.id, '<book-2>')
      snap(this, await post('/api/tools/batch/embed-metadata', 'admin', { libraryItemIds: [book.id, other.id] }), 'no options')
      snap(this, await post('/api/tools/batch/embed-metadata?forceEmbedChapters=1&backup=1', 'root', { libraryItemIds: [other.id] }), 'both options')
    })
  })
})
