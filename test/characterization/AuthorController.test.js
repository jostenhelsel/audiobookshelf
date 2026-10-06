const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary } = require('./helpers/seed-library')
const { createVisibleBook: createBook, createAuthor, linkAuthor, createUser } = require('./helpers/seed-library-extra')
const Database = require('../../server/Database')
const AuthorFinder = require('../../server/finders/AuthorFinder')
const CacheManager = require('../../server/managers/CacheManager')

// Every route of AuthorController. Network (Audnexus lookups, image downloads) is stubbed at the AuthorFinder boundary;
// image resizing (ffmpeg) is not available, so only the 400/404/cache-hit/raw paths of GET image are recorded.
describe('AuthorController (characterization)', () => {
  let api, lf, other, ann, bob, otherAuthor, bookA, bookB, bookC

  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    other = await createLibrary({ name: 'Other', path: '/test/other' })
    ann = await createAuthor(lf.library, { name: 'Ann Author', description: 'Writes things', asin: 'B000000001' })
    bob = await createAuthor(lf.library, { name: 'Bob Builder' })
    otherAuthor = await createAuthor(other.library, { name: 'Elsewhere Writer' })
    bookA = await createBook(lf, { title: 'Book A', series: [{ name: 'Saga', sequence: '2' }] })
    bookB = await createBook(lf, { title: 'Book B', series: [{ name: 'Saga', sequence: '1' }] })
    bookC = await createBook(lf, { title: 'Book C' })
    await linkAuthor(bookA.book, ann)
    await linkAuthor(bookB.book, ann)
    await linkAuthor(bookC.book, bob)
    await createBook(other, { title: 'Elsewhere Book' }).then((b) => linkAuthor(b.book, otherAuthor))
  })

  afterEach(async () => {
    CacheManager.ImageCachePath = null
    await api.stop()
  })

  const snap = (ctx, res, label, extra = {}) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted, ...extra }, { label, ids: ctx.ids, tmpDirs: [api.tmp] })
  }
  const names = () =>
    new Map([
      [ann.id, '<ann>'],
      [bob.id, '<bob>'],
      [otherAuthor.id, '<other-author>']
    ])
  const authorRows = async () => (await Database.authorModel.findAll({ order: [['name', 'ASC']] })).map((a) => ({ id: a.id, name: a.name, lastFirst: a.lastFirst, asin: a.asin, description: a.description, imagePath: a.imagePath }))
  const bookAuthorRows = async () => {
    const rows = await Database.bookAuthorModel.findAll()
    const titles = { [bookA.book.id]: 'A', [bookB.book.id]: 'B', [bookC.book.id]: 'C' }
    return rows.map((r) => `${titles[r.bookId] || 'other'}:${r.authorId}`).sort()
  }

  describe('GET /api/authors/:id', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('GET', `/api/authors/${ann.id}`))
    })
    it('returns an author, optionally with items and series', async function () {
      this.ids = names()
      for (const as of ['admin', 'user', 'guest']) snap(this, await api.request('GET', `/api/authors/${ann.id}`, { as }), `plain as ${as}`)
      snap(this, await api.request('GET', `/api/authors/${ann.id}?include=items`, { as: 'admin' }), 'include items')
      snap(this, await api.request('GET', `/api/authors/${ann.id}?include=items,series`, { as: 'admin' }), 'include items and series')
      snap(this, await api.request('GET', `/api/authors/${ann.id}?include=items,series`, { as: 'user' }), 'include items and series as user')
      snap(this, await api.request('GET', `/api/authors/${ann.id}?include=series`, { as: 'admin' }), 'include series only')
    })
    it('404s for unknown ids and inaccessible libraries', async function () {
      this.ids = names()
      await createUser('limited', 'user', (p) => {
        p.accessAllLibraries = false
        p.librariesAccessible = [other.library.id]
      })
      snap(this, await api.request('GET', '/api/authors/not-a-real-id', { as: 'admin' }), 'unknown id')
      snap(this, await api.request('GET', `/api/authors/${ann.id}`, { as: 'limited' }), 'library not accessible')
      snap(this, await api.request('GET', `/api/authors/${otherAuthor.id}`, { as: 'limited' }), 'accessible library')
    })
  })

  describe('PATCH /api/authors/:id', () => {
    it('rejects invalid payloads', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { as: 'admin', json: {} }), 'empty')
      snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { as: 'admin', json: { name: 5, bogus: 'x' } }), 'wrong types')
      snap(this, await api.request('PATCH', `/api/authors/nope`, { as: 'admin', json: { name: 'x' } }), 'unknown id')
    })
    it('checks permissions', async function () {
      this.ids = names()
      for (const as of ['user', 'guest']) snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { as, json: { name: 'Hacked' } }), as)
      snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { json: { name: 'Hacked' } }), 'anonymous')
      snap(this, { rows: await authorRows() }, 'rows unchanged')
    })
    it('updates description and asin without touching books', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { as: 'admin', json: { description: 'New bio', asin: 'B000000002' } }), 'update')
      snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { as: 'admin', json: { description: 'New bio' } }), 'no change')
      snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { as: 'admin', json: { description: null, asin: null } }), 'null values')
    })
    it('renames and updates lastFirst', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/authors/${ann.id}`, { as: 'admin', json: { name: 'Anne Writer' } }), 'rename')
      snap(this, await api.request('GET', `/api/authors/${ann.id}?include=items`, { as: 'admin' }), 'after rename')
      snap(this, { rows: await authorRows() }, 'rows')
    })
    it('merges into an existing author with the same name', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/authors/${bob.id}`, { as: 'admin', json: { name: 'Ann Author' } }), 'merge')
      snap(this, await api.request('GET', `/api/authors/${bob.id}`, { as: 'admin' }), 'merged author gone')
      snap(this, await api.request('GET', `/api/authors/${ann.id}?include=items`, { as: 'admin' }), 'target author')
      snap(this, { rows: await authorRows(), bookAuthors: await bookAuthorRows() }, 'rows')
    })
    it('merges an author with no books', async function () {
      this.ids = names()
      const empty = await createAuthor(lf.library, { name: 'Nobody' })
      this.ids.set(empty.id, '<nobody>')
      snap(this, await api.request('PATCH', `/api/authors/${empty.id}`, { as: 'admin', json: { name: 'Bob Builder' } }), 'merge empty')
    })
    it('does not merge across libraries', async function () {
      this.ids = names()
      snap(this, await api.request('PATCH', `/api/authors/${bob.id}`, { as: 'admin', json: { name: 'Elsewhere Writer' } }), 'same name other library')
      snap(this, { rows: await authorRows() }, 'rows')
    })
  })

  describe('DELETE /api/authors/:id', () => {
    it('checks permissions', async function () {
      this.ids = names()
      snap(this, await api.request('DELETE', `/api/authors/${ann.id}`), 'anonymous')
      for (const as of ['admin', 'user', 'guest']) snap(this, await api.request('DELETE', `/api/authors/${ann.id}`, { as }), as)
    })
    it('deletes as root, removes from books and 404s afterwards', async function () {
      this.ids = names()
      snap(this, await api.request('DELETE', `/api/authors/${ann.id}`, { as: 'root' }), 'root deletes')
      snap(this, { rows: await authorRows(), bookAuthors: await bookAuthorRows() }, 'rows')
      snap(this, await api.request('GET', `/api/authors/${ann.id}`, { as: 'root' }), 'find after delete')
      snap(this, await api.request('DELETE', `/api/authors/${ann.id}`, { as: 'root' }), 'delete again')
      snap(this, await api.request('DELETE', '/api/authors/nope', { as: 'root' }), 'unknown id')
    })
  })

  describe('POST /api/authors/:id/match', () => {
    it('matches by name, updating asin, description and image', async function () {
      this.ids = names()
      const byName = sinon.stub(AuthorFinder, 'findAuthorByName').resolves({ asin: 'B000000099', name: 'Ann Author', description: 'Matched bio', image: 'https://example.test/ann.jpg' })
      const save = sinon.stub(AuthorFinder, 'saveAuthorImage').resolves({ path: '/metadata/authors/ann.jpg' })
      snap(this, await api.request('POST', `/api/authors/${ann.id}/match`, { as: 'admin', json: { q: 'Ann Author', region: 'uk' } }), 'match by name', { finderCalls: { byName: byName.args, saveImage: save.args } })
    })
    it('matches by asin and reports no updates when nothing differs', async function () {
      this.ids = names()
      const byAsin = sinon.stub(AuthorFinder, 'findAuthorByASIN').resolves({ asin: 'B000000001', name: 'Ann Author', description: 'Writes things' })
      sinon.stub(AuthorFinder, 'findAuthorByName').resolves(null)
      snap(this, await api.request('POST', `/api/authors/${ann.id}/match`, { as: 'admin', json: { asin: 'b000000001' } }), 'match by asin no updates', { finderCalls: { byAsin: byAsin.args } })
      snap(this, await api.request('POST', `/api/authors/${ann.id}/match`, { as: 'admin', json: { asin: 'not-an-asin', q: 'x' } }), 'invalid asin falls back to name search')
    })
    it('404s when nothing is found and checks permissions', async function () {
      this.ids = names()
      sinon.stub(AuthorFinder, 'findAuthorByName').resolves(null)
      snap(this, await api.request('POST', `/api/authors/${ann.id}/match`, { as: 'admin', json: { q: 'nobody' } }), 'not found')
      snap(this, await api.request('POST', `/api/authors/${ann.id}/match`, { as: 'admin', json: {} }), 'no query')
      snap(this, await api.request('POST', `/api/authors/${ann.id}/match`, { as: 'user', json: { q: 'x' } }), 'user')
      snap(this, await api.request('POST', `/api/authors/nope/match`, { as: 'admin', json: { q: 'x' } }), 'unknown id')
    })
  })

  describe('POST /api/authors/:id/image', () => {
    it('validates the payload and permissions', async function () {
      this.ids = names()
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'admin', json: {} }), 'no url')
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'admin', json: { url: 'ftp://x/y.jpg' } }), 'bad url')
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'admin', json: { url: 5 } }), 'non-string url')
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'guest', json: { url: 'https://x/y.jpg' } }), 'guest')
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'user', json: { url: 'https://x/y.jpg' } }), 'user')
    })
    it('saves a downloaded image', async function () {
      this.ids = names()
      sinon.stub(AuthorFinder, 'saveAuthorImage').callsFake(async (id) => ({ path: path.join(api.tmp, 'metadata', 'authors', `${id}.jpg`) }))
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'admin', json: { url: 'https://example.test/ann.jpg' } }), 'success')
      snap(this, { rows: await authorRows() }, 'rows')
    })
    it('reports download failures', async function () {
      this.ids = names()
      const stub = sinon.stub(AuthorFinder, 'saveAuthorImage')
      stub.onFirstCall().resolves({ error: 'Failed to download' })
      stub.onSecondCall().resolves(undefined)
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'admin', json: { url: 'https://example.test/ann.jpg' } }), 'download error')
      snap(this, await api.request('POST', `/api/authors/${ann.id}/image`, { as: 'admin', json: { url: 'https://example.test/ann.jpg' } }), 'no result')
    })
  })

  describe('image routes', () => {
    let imagePath
    beforeEach(async () => {
      imagePath = path.join(api.tmp, 'ann.png')
      fs.writeFileSync(imagePath, Buffer.from('not-really-a-png'))
      ann.imagePath = imagePath
      await ann.save()
      CacheManager.ImageCachePath = path.join(api.tmp, 'imgcache')
      fs.mkdirSync(CacheManager.ImageCachePath)
    })

    it('GET image: raw, cached, invalid and missing', async function () {
      this.ids = names()
      const unknownUuid = '11111111-1111-4111-8111-111111111111'
      snap(this, await api.request('GET', `/api/authors/${ann.id}/image?raw=1`), 'requires authentication')
      const raw = await api.request('GET', `/api/authors/${ann.id}/image?raw=1`, { as: 'admin' })
      snap(this, { status: raw.status, body: raw.body }, 'raw')
      snap(this, await api.request('GET', `/api/authors/${bob.id}/image?raw=1`, { as: 'admin' }), 'raw, author without image')
      snap(this, await api.request('GET', `/api/authors/${unknownUuid}/image?raw=1`, { as: 'admin' }), 'raw, unknown id')
      snap(this, await api.request('GET', `/api/authors/${ann.id}/image?format=gif`, { as: 'admin' }), 'invalid format')
      snap(this, await api.request('GET', `/api/authors/${bob.id}/image?width=-5`, { as: 'admin' }), 'negative width (author without image)')
      snap(this, await api.request('GET', `/api/authors/not-a-uuid/image`, { as: 'admin' }), 'not a uuid')
      snap(this, await api.request('GET', `/api/authors/${bob.id}/image?format=jpeg`, { as: 'admin' }), 'no image for author')
      fs.writeFileSync(path.join(CacheManager.ImageCachePath, `${ann.id}_400.jpeg`), 'cached-bytes')
      const cached = await api.request('GET', `/api/authors/${ann.id}/image?format=jpeg`, { as: 'admin' })
      snap(this, { status: cached.status, type: cached.headers['content-type'], body: cached.body }, 'cache hit')
    })
    it.skip('GET /api/authors/:id/image (resize): needs ffmpeg to resize the image into the cache', () => {})

    it('DELETE image: removes file and clears imagePath', async function () {
      this.ids = names()
      snap(this, await api.request('DELETE', `/api/authors/${bob.id}/image`, { as: 'root' }), 'author without image')
      snap(this, await api.request('DELETE', `/api/authors/${ann.id}/image`, { as: 'admin' }), 'admin forbidden')
      snap(this, await api.request('DELETE', `/api/authors/${ann.id}/image`, { as: 'user' }), 'user forbidden')
      snap(this, await api.request('DELETE', `/api/authors/${ann.id}/image`, { as: 'root' }), 'root deletes', { fileExists: fs.existsSync(imagePath) })
      snap(this, await api.request('DELETE', `/api/authors/${ann.id}/image`, { as: 'root' }), 'again')
      snap(this, await api.request('DELETE', `/api/authors/nope/image`, { as: 'root' }), 'unknown id')
    })
  })
})
