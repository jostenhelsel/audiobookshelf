const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')

describe('characterization harness', () => {
  let api
  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
  })
  afterEach(async () => {
    await api.stop()
  })

  it('rejects unauthenticated requests', async () => {
    const res = await api.request('GET', '/api/libraries')
    expect(res.status).to.equal(401)
  })

  it('lists no libraries on an empty server', async function () {
    const res = await api.request('GET', '/api/libraries', { as: 'root' })
    matchSnapshot(this, res)
  })

  it('creates a library and records the socket emission', async function () {
    const res = await api.request('POST', '/api/libraries', { as: 'root', json: { name: 'Books', mediaType: 'book', folders: [{ fullPath: '/tmp/x-books' }] } })
    matchSnapshot(this, { res, emitted: api.emitted, watcherCalls: api.watcherCalls })
  })
})
