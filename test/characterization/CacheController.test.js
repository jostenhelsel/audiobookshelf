const fs = require('fs')
const path = require('path')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const CacheManager = require('../../server/managers/CacheManager')

describe('CacheController (characterization)', () => {
  let api, cacheFiles

  beforeEach(async () => {
    api = await startApi()
    await api.seed.users()
    // real CacheManager working inside the harness temp metadata dir
    await CacheManager.ensureCachePaths()
    fs.writeFileSync(path.join(CacheManager.CoverCachePath, 'a_400.webp'), 'x')
    fs.writeFileSync(path.join(CacheManager.ImageCachePath, 'b_400.webp'), 'x')
    fs.writeFileSync(path.join(CacheManager.ItemCachePath, 'c.m4b'), 'x')
    cacheFiles = () => ({
      covers: fs.readdirSync(CacheManager.CoverCachePath),
      images: fs.readdirSync(CacheManager.ImageCachePath),
      items: fs.readdirSync(CacheManager.ItemCachePath)
    })
  })

  afterEach(async () => {
    await api.stop()
    // CacheManager is a singleton: forget the deleted temp paths so other test files see it unconfigured again
    CacheManager.CachePath = CacheManager.CoverCachePath = CacheManager.ImageCachePath = CacheManager.ItemCachePath = null
  })

  const snap = (ctx, res, label) => matchSnapshot(ctx, { res, files: cacheFiles(), emitted: api.emitted.splice(0) }, { label })

  describe('POST /api/cache/purge', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/cache/purge'))
    })
    it('is forbidden for user and guest, files stay', async function () {
      snap(this, await api.request('POST', '/api/cache/purge', { as: 'user' }), 'user')
      snap(this, await api.request('POST', '/api/cache/purge', { as: 'guest' }), 'guest')
    })
    it('purges every cache directory for admin and root', async function () {
      snap(this, await api.request('POST', '/api/cache/purge', { as: 'admin' }), 'admin')
      fs.writeFileSync(path.join(CacheManager.CoverCachePath, 'a_400.webp'), 'x')
      snap(this, await api.request('POST', '/api/cache/purge', { as: 'root' }), 'root')
    })
  })

  describe('POST /api/cache/items/purge', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/cache/items/purge'))
    })
    it('is forbidden for user and guest, files stay', async function () {
      snap(this, await api.request('POST', '/api/cache/items/purge', { as: 'user' }), 'user')
      snap(this, await api.request('POST', '/api/cache/items/purge', { as: 'guest' }), 'guest')
    })
    it('purges only the items cache for admin and root', async function () {
      snap(this, await api.request('POST', '/api/cache/items/purge', { as: 'admin' }), 'admin')
      fs.writeFileSync(path.join(CacheManager.ItemCachePath, 'c.m4b'), 'x')
      snap(this, await api.request('POST', '/api/cache/items/purge', { as: 'root' }), 'root')
    })
  })
})
