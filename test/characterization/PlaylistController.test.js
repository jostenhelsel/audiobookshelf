const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const Database = require('../../server/Database')
const { createLibrary, createBook } = require('./helpers/seed-library')
const { createPodcast, createUser, audioBookExtra } = require('./helpers/seed-users-extra')
const { fixedId } = require('./helpers/seed-podcast-extra')

describe('PlaylistController (characterization)', () => {
  let api, users, lf, other, podLf, books, otherBook, pod

  beforeEach(async () => {
    api = await startApi()
    users = await api.seed.users()
    lf = await createLibrary({ name: 'Books' })
    other = await createLibrary({ name: 'Other', path: '/test/other' })
    podLf = await createLibrary({ name: 'Podcasts', mediaType: 'podcast', path: '/test/podcasts' })
    books = []
    // explicit is false (not NULL) so that user/guest accounts can see the books
    for (const title of ['Book A', 'Book B', 'Book C', 'Book D']) books.push((await createBook(lf, { title, extra: audioBookExtra({}) })).libraryItem)
    otherBook = (await createBook(other, { title: 'Elsewhere', extra: audioBookExtra({}) })).libraryItem
    pod = await createPodcast(podLf, {
      title: 'Pod',
      episodes: [
        { id: fixedId('e', 1), title: 'Ep 1' },
        { id: fixedId('e', 2), title: 'Ep 2' },
        { id: fixedId('e', 3), title: 'Ep 3' }
      ]
    })
  })

  afterEach(async () => {
    await api.stop()
  })

  const snap = (ctx, res, label) => {
    const emitted = api.emitted.splice(0)
    matchSnapshot(ctx, { res, emitted }, { label, ids: ctx.ids })
  }
  const create = (as = 'admin', over = {}) => api.request('POST', '/api/playlists', { as, json: { libraryId: lf.library.id, name: 'Road trip', description: 'for the car', items: [{ libraryItemId: books[0].id }, { libraryItemId: books[1].id }], ...over } })
  const get = (as, id) => api.request('GET', `/api/playlists/${id}`, { as })

  describe('POST /api/playlists', () => {
    it('requires authentication', async function () {
      snap(this, await api.request('POST', '/api/playlists', { json: {} }))
    })
    it('rejects invalid bodies', async function () {
      this.ids = new Map()
      snap(this, await create('admin', { name: '' }), 'empty name')
      snap(this, await create('admin', { name: '<p></p>' }), 'name of only tags')
      snap(this, await create('admin', { libraryId: undefined }), 'no library')
      snap(this, await create('admin', { description: 5 }), 'bad description')
      snap(this, await create('admin', { items: [{}] }), 'item without libraryItemId')
      snap(this, await create('admin', { items: [{ libraryItemId: 5 }] }), 'item with numeric libraryItemId')
      snap(this, await create('admin', { items: [{ libraryItemId: books[0].id, episodeId: pod.episodes[0].id }] }), 'episode on a book item')
      snap(this, await create('admin', { items: [{ libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[0].id }, { libraryItemId: pod.libraryItem.id }] }), 'podcast item without episodeId')
      snap(this, await create('admin', { items: [{ libraryItemId: books[0].id }, { libraryItemId: 'nope' }] }), 'unknown item')
      snap(this, await create('admin', { items: [{ libraryItemId: otherBook.id }] }), 'item from another library')
      snap(this, await create('admin', { items: [{ libraryItemId: pod.libraryItem.id, episodeId: fixedId('e', 99) }] }), 'unknown episode')
      snap(this, await create('admin', { libraryId: podLf.library.id, items: [{ libraryItemId: books[0].id }] }), 'book in podcast library')
    })
    it('refuses a library the user cannot access', async function () {
      await createUser({ username: 'limited', type: 'user', permissions: { accessAllLibraries: false, librariesAccessible: [other.library.id] } })
      snap(this, await create('limited'))
    })
    it('creates a book playlist as admin, user and guest', async function () {
      this.ids = new Map()
      snap(this, await create('admin'), 'admin')
      snap(this, await create('user', { name: 'User list' }), 'user')
      snap(this, await create('guest', { name: 'Guest list', description: undefined }), 'guest')
    })
    it('strips tags from the name and accepts an empty items list', async function () {
      this.ids = new Map()
      snap(this, await create('admin', { name: '<b>Bold</b> list' }), 'html name')
      snap(this, await create('admin', { name: 'Empty', items: [] }), 'no items')
      snap(this, await create('admin', { name: 'Missing items', items: undefined }), 'items omitted')
    })
    it('creates a podcast playlist', async function () {
      this.ids = new Map()
      snap(this, await create('admin', { libraryId: podLf.library.id, name: 'Eps', items: [{ libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[2].id }, { libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[0].id }] }))
    })
  })

  describe('GET routes', () => {
    it('lists only the playlists of the requesting user (deprecated route)', async function () {
      this.ids = new Map()
      snap(this, await api.request('GET', '/api/playlists'), 'unauthenticated')
      snap(this, await api.request('GET', '/api/playlists', { as: 'admin' }), 'none yet')
      // fixed ids: the list has no ORDER BY
      await Database.playlistModel.create({ id: fixedId('a', 1), userId: users.admin.id, libraryId: lf.library.id, name: 'First' })
      await Database.playlistMediaItemModel.create({ playlistId: fixedId('a', 1), mediaItemId: (await books[0].getMedia()).id, mediaItemType: 'book', order: 1 })
      await Database.playlistModel.create({ id: fixedId('a', 2), userId: users.admin.id, libraryId: other.library.id, name: 'Second' })
      await Database.playlistMediaItemModel.create({ playlistId: fixedId('a', 2), mediaItemId: (await otherBook.getMedia()).id, mediaItemType: 'book', order: 1 })
      await Database.playlistModel.create({ id: fixedId('a', 3), userId: users.user.id, libraryId: lf.library.id, name: "User's" })
      await Database.playlistMediaItemModel.create({ playlistId: fixedId('a', 3), mediaItemId: (await books[1].getMedia()).id, mediaItemType: 'book', order: 1 })
      snap(this, await api.request('GET', '/api/playlists', { as: 'admin' }), 'admin')
      snap(this, await api.request('GET', '/api/playlists', { as: 'user' }), 'user')
      snap(this, await api.request('GET', '/api/playlists', { as: 'guest' }), 'guest has none')
      await createUser({ username: 'limited', type: 'admin', permissions: { accessAllLibraries: false, librariesAccessible: [lf.library.id] } })
      await Database.playlistModel.create({ id: fixedId('a', 4), userId: (await Database.userModel.findOne({ where: { username: 'limited' } })).id, libraryId: other.library.id, name: 'Hidden library' })
      snap(this, await api.request('GET', '/api/playlists', { as: 'limited' }), 'playlist in inaccessible library is filtered out')
    })
    it('finds one, 404s, 403s for another owner and 404s for an inaccessible library', async function () {
      const { body: created } = await create('admin')
      api.emitted.splice(0)
      this.ids = new Map([[created.id, '<playlist>']])
      snap(this, await api.request('GET', `/api/playlists/${created.id}`), 'unauthenticated')
      snap(this, await get('admin', created.id), 'owner')
      snap(this, await get('user', created.id), 'other user')
      snap(this, await get('root', created.id), 'root is not the owner either')
      snap(this, await get('admin', 'not-a-real-id'), 'unknown id')
      await createUser({ username: 'limited', type: 'admin', permissions: { accessAllLibraries: false, librariesAccessible: [other.library.id] } })
      await Database.playlistModel.update({ userId: (await Database.userModel.findOne({ where: { username: 'limited' } })).id }, { where: { id: created.id } })
      snap(this, await get('limited', created.id), 'owner without library access')
    })
  })

  describe('PATCH /api/playlists/:id', () => {
    let playlist
    beforeEach(async () => {
      playlist = (await create('user', { items: [{ libraryItemId: books[0].id }, { libraryItemId: books[1].id }, { libraryItemId: books[2].id }] })).body
      api.emitted.splice(0)
    })

    it('requires authentication and ownership', async function () {
      this.ids = new Map([[playlist.id, '<playlist>']])
      snap(this, await api.request('PATCH', `/api/playlists/${playlist.id}`, { json: { name: 'x' } }), 'unauthenticated')
      snap(this, await api.request('PATCH', `/api/playlists/${playlist.id}`, { as: 'admin', json: { name: 'Hijack' } }), 'other user')
      snap(this, await api.request('PATCH', '/api/playlists/nope', { as: 'user', json: { name: 'x' } }), 'unknown id')
    })
    it('rejects invalid bodies', async function () {
      this.ids = new Map([[playlist.id, '<playlist>']])
      const patch = (json) => api.request('PATCH', `/api/playlists/${playlist.id}`, { as: 'user', json })
      snap(this, await patch({ libraryId: other.library.id }), 'libraryId')
      snap(this, await patch({ userId: users.admin.id }), 'userId')
      snap(this, await patch({ name: 5 }), 'numeric name')
      snap(this, await patch({ description: 5 }), 'numeric description')
      snap(this, await patch({ items: 'x' }), 'items not an array')
      snap(this, await patch({ items: [{}] }), 'item without libraryItemId')
      snap(this, await patch({ items: [{ libraryItemId: books[0].id, episodeId: 5 }] }), 'numeric episodeId')
      snap(this, await patch({ items: [{ libraryItemId: 'nope' }] }), 'unknown item')
      snap(this, await patch({ items: [{ libraryItemId: books[0].id }, { libraryItemId: books[1].id }] }), 'length mismatch')
    })
    it('updates name and description', async function () {
      this.ids = new Map([[playlist.id, '<playlist>']])
      const patch = (json) => api.request('PATCH', `/api/playlists/${playlist.id}`, { as: 'user', json })
      snap(this, await patch({ name: '<i>Renamed</i>', description: 'new text' }), 'both')
      snap(this, await patch({ name: 'Renamed', description: 'new text' }), 'unchanged')
      snap(this, await patch({}), 'empty body')
      snap(this, await patch({ description: '' }), 'empty description is ignored')
      snap(this, await patch({ name: '' }), 'empty name is ignored')
    })
    it('reorders items', async function () {
      this.ids = new Map([[playlist.id, '<playlist>']])
      const patch = (items) => api.request('PATCH', `/api/playlists/${playlist.id}`, { as: 'user', json: { items } })
      const res = await patch([{ libraryItemId: books[2].id }, { libraryItemId: books[0].id }, { libraryItemId: books[1].id }])
      snap(this, res, 'reorder')
      snap(this, await patch([{ libraryItemId: books[2].id }, { libraryItemId: books[0].id }, { libraryItemId: books[1].id }]), 'same order again')
      snap(this, await patch([{ libraryItemId: books[0].id }, { libraryItemId: books[0].id }, { libraryItemId: books[1].id }]), 'duplicate ids')
    })
    it('reorders podcast episodes', async function () {
      const { body: podPlaylist } = await create('admin', { libraryId: podLf.library.id, name: 'Eps', items: pod.episodes.map((e) => ({ libraryItemId: pod.libraryItem.id, episodeId: e.id })) })
      api.emitted.splice(0)
      this.ids = new Map([[podPlaylist.id, '<playlist>']])
      snap(this, await api.request('PATCH', `/api/playlists/${podPlaylist.id}`, { as: 'admin', json: { items: [pod.episodes[1], pod.episodes[2], pod.episodes[0]].map((e) => ({ libraryItemId: pod.libraryItem.id, episodeId: e.id })) } }))
    })
  })

  describe('DELETE /api/playlists/:id', () => {
    it('deletes as the owner only (any user type), then 404s', async function () {
      const { body: p1 } = await create('user')
      const { body: p2 } = await create('guest')
      api.emitted.splice(0)
      this.ids = new Map([[p1.id, '<p1>'], [p2.id, '<p2>']])
      snap(this, await api.request('DELETE', `/api/playlists/${p1.id}`), 'unauthenticated')
      snap(this, await api.request('DELETE', `/api/playlists/${p1.id}`, { as: 'root' }), 'root is not the owner')
      snap(this, await api.request('DELETE', `/api/playlists/${p1.id}`, { as: 'user' }), 'owner user')
      snap(this, await api.request('DELETE', `/api/playlists/${p2.id}`, { as: 'guest' }), 'owner guest')
      snap(this, await get('user', p1.id), 'find after delete')
      snap(this, await api.request('DELETE', `/api/playlists/${p1.id}`, { as: 'user' }), 'delete again')
      snap(this, { items: await Database.playlistMediaItemModel.count() }, 'playlist items left in DB')
    })
  })

  describe('POST /api/playlists/:id/item', () => {
    it('adds single items and validates', async function () {
      const { body: playlist } = await create('admin', { items: [{ libraryItemId: books[0].id }] })
      const { body: podPlaylist } = await create('admin', { libraryId: podLf.library.id, name: 'Eps', items: [{ libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[0].id }] })
      api.emitted.splice(0)
      this.ids = new Map([[playlist.id, '<playlist>'], [podPlaylist.id, '<podPlaylist>']])
      const add = (id, json, as = 'admin') => api.request('POST', `/api/playlists/${id}/item`, { as, json })
      snap(this, await api.request('POST', `/api/playlists/${playlist.id}/item`, { json: {} }), 'unauthenticated')
      snap(this, await add(playlist.id, {}), 'no libraryItemId')
      snap(this, await add(playlist.id, { libraryItemId: 'nope' }), 'unknown item')
      snap(this, await add(playlist.id, { libraryItemId: otherBook.id }), 'different library')
      snap(this, await add(playlist.id, { libraryItemId: books[1].id, episodeId: 'x' }), 'episode for a book')
      snap(this, await add(podPlaylist.id, { libraryItemId: pod.libraryItem.id }), 'podcast without episode')
      snap(this, await add(podPlaylist.id, { libraryItemId: pod.libraryItem.id, episodeId: fixedId('e', 99) }), 'unknown episode')
      snap(this, await add(playlist.id, { libraryItemId: books[0].id }), 'already in playlist')
      snap(this, await add(playlist.id, { libraryItemId: books[1].id }, 'user'), 'not the owner')
      snap(this, await add(playlist.id, { libraryItemId: books[1].id }), 'add book')
      snap(this, await add(podPlaylist.id, { libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[1].id }), 'add episode')
      snap(this, await add(podPlaylist.id, { libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[1].id }), 'add episode again')
      snap(this, await get('admin', playlist.id), 'follow-up GET')
    })
  })

  describe('DELETE /api/playlists/:id/item/:libraryItemId/:episodeId?', () => {
    it('removes items, renumbers and deletes the playlist when empty', async function () {
      const { body: playlist } = await create('admin', { items: [{ libraryItemId: books[0].id }, { libraryItemId: books[1].id }, { libraryItemId: books[2].id }] })
      const { body: podPlaylist } = await create('admin', { libraryId: podLf.library.id, name: 'Eps', items: pod.episodes.slice(0, 2).map((e) => ({ libraryItemId: pod.libraryItem.id, episodeId: e.id })) })
      api.emitted.splice(0)
      this.ids = new Map([[playlist.id, '<playlist>'], [podPlaylist.id, '<podPlaylist>']])
      const del = (id, tail, as = 'admin') => api.request('DELETE', `/api/playlists/${id}/item/${tail}`, { as })
      snap(this, await api.request('DELETE', `/api/playlists/${playlist.id}/item/${books[0].id}`), 'unauthenticated')
      snap(this, await del(playlist.id, books[0].id, 'user'), 'not the owner')
      snap(this, await del(playlist.id, otherBook.id), 'item not in playlist')
      snap(this, await del(playlist.id, books[0].id), 'remove first')
      snap(this, await del(playlist.id, books[0].id), 'remove first again')
      snap(this, await del(podPlaylist.id, `${pod.libraryItem.id}/${pod.episodes[0].id}`), 'remove episode')
      snap(this, await del(podPlaylist.id, `${pod.libraryItem.id}/${pod.episodes[2].id}`), 'episode not in playlist')
      snap(this, await del(podPlaylist.id, `${pod.libraryItem.id}/${pod.episodes[1].id}`), 'remove last episode')
      snap(this, await get('admin', podPlaylist.id), 'playlist gone after last item')
      snap(this, await del(playlist.id, books[1].id), 'remove second')
      snap(this, await get('admin', playlist.id), 'follow-up GET')
      snap(this, { orders: (await Database.playlistMediaItemModel.findAll({ where: { playlistId: playlist.id } })).map((i) => i.order) }, 'orders in DB')
    })
  })

  describe('POST /api/playlists/:id/batch/add', () => {
    it('adds batches and skips items already present', async function () {
      const { body: playlist } = await create('admin', { items: [{ libraryItemId: books[0].id }] })
      const { body: podPlaylist } = await create('admin', { libraryId: podLf.library.id, name: 'Eps', items: [{ libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[0].id }] })
      api.emitted.splice(0)
      this.ids = new Map([[playlist.id, '<playlist>'], [podPlaylist.id, '<podPlaylist>']])
      const add = (id, items, as = 'admin') => api.request('POST', `/api/playlists/${id}/batch/add`, { as, json: { items } })
      snap(this, await api.request('POST', `/api/playlists/${playlist.id}/batch/add`, { json: {} }), 'unauthenticated')
      snap(this, await add(playlist.id, []), 'empty')
      snap(this, await add(playlist.id, undefined), 'no items')
      snap(this, await add(playlist.id, [{ libraryItemId: 5 }]), 'bad item')
      snap(this, await add(playlist.id, [{ libraryItemId: books[1].id }, { libraryItemId: 'nope' }]), 'unknown item')
      snap(this, await add(playlist.id, [{ libraryItemId: books[1].id }], 'user'), 'not the owner')
      snap(this, await add(playlist.id, [{ libraryItemId: books[0].id }]), 'only duplicates (no emit)')
      snap(this, await add(playlist.id, [{ libraryItemId: books[0].id }, { libraryItemId: books[2].id }, { libraryItemId: books[1].id }]), 'mixed new and duplicate')
      snap(this, await add(podPlaylist.id, [{ libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[0].id }, { libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[2].id }]), 'episodes')
      snap(this, await get('admin', playlist.id), 'follow-up GET')
    })
  })

  describe('POST /api/playlists/:id/batch/remove', () => {
    it('removes batches and deletes the playlist when empty', async function () {
      const { body: playlist } = await create('admin', { items: [{ libraryItemId: books[0].id }, { libraryItemId: books[1].id }, { libraryItemId: books[2].id }] })
      api.emitted.splice(0)
      this.ids = new Map([[playlist.id, '<playlist>']])
      const remove = (items, as = 'admin') => api.request('POST', `/api/playlists/${playlist.id}/batch/remove`, { as, json: { items } })
      snap(this, await api.request('POST', `/api/playlists/${playlist.id}/batch/remove`, { json: {} }), 'unauthenticated')
      snap(this, await remove([]), 'empty')
      snap(this, await remove(undefined), 'no items')
      snap(this, await remove([{}]), 'bad item')
      snap(this, await remove([{ libraryItemId: books[0].id }], 'user'), 'not the owner')
      snap(this, await remove([{ libraryItemId: otherBook.id }, { libraryItemId: 'nope' }]), 'nothing found (no emit)')
      snap(this, await remove([{ libraryItemId: books[0].id }, { libraryItemId: otherBook.id }]), 'remove one, skip unknown')
      snap(this, await remove([{ libraryItemId: books[1].id }, { libraryItemId: books[2].id }]), 'remove the rest')
      snap(this, await get('admin', playlist.id), 'playlist gone')
    })
    it('removes episodes in a batch', async function () {
      const { body: podPlaylist } = await create('admin', { libraryId: podLf.library.id, name: 'Eps', items: pod.episodes.map((e) => ({ libraryItemId: pod.libraryItem.id, episodeId: e.id })) })
      api.emitted.splice(0)
      this.ids = new Map([[podPlaylist.id, '<podPlaylist>']])
      snap(this, await api.request('POST', `/api/playlists/${podPlaylist.id}/batch/remove`, { as: 'admin', json: { items: [{ libraryItemId: pod.libraryItem.id, episodeId: pod.episodes[1].id }] } }))
    })
  })

  describe('POST /api/playlists/collection/:collectionId', () => {
    it('creates a playlist from a collection', async function () {
      this.ids = new Map()
      const { body: collection } = await api.request('POST', '/api/collections', { as: 'admin', json: { libraryId: lf.library.id, name: 'Favourites', description: 'my picks', books: [books[2].id, books[0].id] } })
      const { body: empty } = await api.request('POST', '/api/collections', { as: 'admin', json: { libraryId: lf.library.id, name: 'Soon empty', books: [books[3].id] } })
      await api.request('DELETE', `/api/collections/${empty.id}/book/${books[3].id}`, { as: 'admin' })
      api.emitted.splice(0)
      const make = (as, id) => api.request('POST', `/api/playlists/collection/${id}`, { as })
      snap(this, await api.request('POST', `/api/playlists/collection/${collection.id}`), 'unauthenticated')
      snap(this, await make('admin', 'nope'), 'unknown collection')
      snap(this, await make('admin', empty.id), 'empty collection')
      snap(this, await make('admin', collection.id), 'admin')
      snap(this, await make('user', collection.id), 'user')
      snap(this, await make('guest', collection.id), 'guest')
      await createUser({ username: 'limited', type: 'admin', permissions: { accessAllLibraries: false, librariesAccessible: [other.library.id] } })
      snap(this, await make('limited', collection.id), 'no access to the collection library')
      snap(this, { playlists: await Database.playlistModel.count() }, 'playlists in DB')
    })
    it('silently leaves out books the user cannot see', async function () {
      this.ids = new Map()
      const { body: collection } = await api.request('POST', '/api/collections', { as: 'admin', json: { libraryId: lf.library.id, name: 'Mixed', books: [books[0].id, books[1].id] } })
      const book = await books[1].getMedia()
      await book.update({ explicit: true })
      api.emitted.splice(0)
      snap(this, await api.request('POST', `/api/playlists/collection/${collection.id}`, { as: 'user' }), 'user')
      snap(this, await api.request('POST', `/api/playlists/collection/${collection.id}`, { as: 'admin' }), 'admin')
    })
  })
})
