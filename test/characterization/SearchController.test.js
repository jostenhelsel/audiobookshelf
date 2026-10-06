const sinon = require('sinon')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary, createBook } = require('./helpers/seed-library')
const Database = require('../../server/Database')
const BookFinder = require('../../server/finders/BookFinder')
const PodcastFinder = require('../../server/finders/PodcastFinder')
const AuthorFinder = require('../../server/finders/AuthorFinder')

// Provider lookups hit the network, so the finders are stubbed at the module boundary; what is recorded is the controller's
// parameter handling (defaults, validation), the arguments passed to the finders and the response shaping.
describe('SearchController (characterization)', () => {
  let api, lf, item, stubs

  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    item = (await createBook(lf, { title: 'Searched Book', authors: ['Ann Author'] })).libraryItem
    stubs = {
      bookSearch: sinon.stub(BookFinder, 'search').resolves([{ title: 'Result One', author: 'Ann Author' }]),
      bookCovers: sinon.stub(BookFinder, 'findCovers').resolves(['https://example.com/cover1.jpg']),
      bookChapters: sinon.stub(BookFinder, 'findChapters').resolves({ asin: 'B000000000', chapters: [{ id: 0, title: 'One', startOffsetMs: 0 }] }),
      podcastSearch: sinon.stub(PodcastFinder, 'search').resolves([{ title: 'Pod Result', feedUrl: 'https://example.com/feed.xml' }]),
      podcastCovers: sinon.stub(PodcastFinder, 'findCovers').resolves(['https://example.com/pod.jpg']),
      author: sinon.stub(AuthorFinder, 'findAuthorByName').resolves({ id: 'asin1', name: 'Ann Author' })
    }
  })

  afterEach(async () => {
    await api.stop()
  })

  // snapshot the response plus the arguments the finders were called with, then reset the call history
  const snap = (ctx, res, label) => {
    const calls = Object.fromEntries(
      Object.entries(stubs)
        .filter(([, s]) => s.called)
        .map(([name, s]) => [name, s.getCalls().map((c) => c.args.map((a) => (a && typeof a.toJSON === 'function' ? { id: a.id } : a)))])
    )
    Object.values(stubs).forEach((s) => s.resetHistory())
    matchSnapshot(ctx, { res, calls }, { label, ids: ctx.ids })
  }
  const get = (url, as = 'user') => api.request('GET', url, { as })

  describe('GET /api/search/books', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/search/books'))
    })
    it('uses defaults and passes query params to the finder', async function () {
      snap(this, await get('/api/search/books'), 'defaults')
      snap(this, await get('/api/search/books?provider=audible&title=Dune&author=Frank%20Herbert'), 'provider title author')
      snap(this, await get('/api/search/books?title=A&title=B'), 'array param')
      snap(this, await get('/api/search/books', 'guest'), 'guest')
    })
    it('resolves the library item by id', async function () {
      this.ids = new Map([[item.id, '<item>']])
      snap(this, await get(`/api/search/books?id=${item.id}&title=x`), 'known id')
      snap(this, await get('/api/search/books?id=nope'), 'unknown id')
    })
    it('maps finder failures to 500', async function () {
      stubs.bookSearch.rejects(new Error('provider down'))
      snap(this, await get('/api/search/books'))
    })
  })

  describe('GET /api/search/covers', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/search/covers?title=x'))
    })
    it('validates the title and returns book and podcast covers', async function () {
      snap(this, await get('/api/search/covers'), 'no title')
      snap(this, await get('/api/search/covers?title='), 'empty title')
      snap(this, await get('/api/search/covers?title=Dune&author=Frank&provider=audiobookcovers'), 'book')
      snap(this, await get('/api/search/covers?title=Dune'), 'book defaults')
      snap(this, await get('/api/search/covers?title=Pod&podcast=1'), 'podcast')
      snap(this, await get('/api/search/covers?title=Pod&podcast=0'), 'podcast=0 is a book search')
    })
    it('maps finder failures to 500', async function () {
      stubs.bookCovers.rejects(new Error('boom'))
      snap(this, await get('/api/search/covers?title=Dune'))
    })
  })

  describe('GET /api/search/podcast', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/search/podcast?term=x'))
    })
    it('validates the term and searches', async function () {
      snap(this, await get('/api/search/podcast'), 'no term')
      snap(this, await get('/api/search/podcast?term=tech'), 'default country')
      snap(this, await get('/api/search/podcast?term=tech&country=de'), 'country de')
    })
    it('maps finder failures to 500', async function () {
      stubs.podcastSearch.rejects(new Error('boom'))
      snap(this, await get('/api/search/podcast?term=tech'))
    })
  })

  describe('GET /api/search/authors', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/search/authors?q=x'))
    })
    it('validates q and searches', async function () {
      snap(this, await get('/api/search/authors'), 'no q')
      snap(this, await get('/api/search/authors?q=Ann'), 'found')
      stubs.author.resolves(null)
      snap(this, await get('/api/search/authors?q=Nobody'), 'not found')
    })
    it('maps finder failures to 500', async function () {
      stubs.author.rejects(new Error('boom'))
      snap(this, await get('/api/search/authors?q=Ann'))
    })
  })

  describe('GET /api/search/chapters', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/search/chapters?asin=B000000000'))
    })
    it('validates the asin and returns chapters', async function () {
      snap(this, await get('/api/search/chapters'), 'no asin')
      snap(this, await get('/api/search/chapters?asin=not-an-asin'), 'invalid asin')
      snap(this, await get('/api/search/chapters?asin=b000000000'), 'lowercase asin, default region')
      snap(this, await get('/api/search/chapters?asin=B000000000&region=UK'), 'region uppercased')
      stubs.bookChapters.resolves(null)
      snap(this, await get('/api/search/chapters?asin=B000000000'), 'chapters not found')
    })
    it('maps finder failures to 500', async function () {
      stubs.bookChapters.rejects(new Error('boom'))
      snap(this, await get('/api/search/chapters?asin=B000000000'))
    })
  })

  describe('GET /api/search/providers', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', '/api/search/providers'))
    })
    it('lists the built-in providers', async function () {
      snap(this, await get('/api/search/providers'))
    })
    it('merges custom providers by media type', async function () {
      await Database.customMetadataProviderModel.create({ id: '11111111-1111-4111-8111-111111111111', name: 'My Books', mediaType: 'book', url: 'https://example.com/books' })
      await Database.customMetadataProviderModel.create({ id: '22222222-2222-4222-8222-222222222222', name: 'My Podcasts', mediaType: 'podcast', url: 'https://example.com/pods' })
      snap(this, await get('/api/search/providers', 'guest'))
    })
  })
})
