const fs = require('fs')
const os = require('os')
const path = require('path')
const sinon = require('sinon')
const { expect } = require('chai')
const { startApi } = require('./helpers/harness')
const { matchSnapshot } = require('./helpers/snapshot')
const { createLibrary, createBook } = require('./helpers/seed-library')

const Database = require('../../server/Database')
const Logger = require('../../server/Logger')
const packageJson = require('../../package.json')

const SINGLETON_FIELDS = ['sequelize', 'dbPath', 'isNew', 'hasRootUser', 'settings', 'libraryFilterData', 'serverSettings', 'notificationSettings', 'emailSettings', 'supportsUnaccent', 'supportsUnicodeFoldings']
const rows = async (sql) => (await Database.sequelize.query(sql))[0]
const logCalls = (stub) => stub.getCalls().map((c) => c.args.map((a) => (a instanceof Error ? `Error: ${a.message}` : a)))

describe('Database (characterization)', function () {
  this.timeout(30000)

  describe('init() on a real database file', () => {
    let tmp, saved, savedGlobals, logs, savedLogLevel

    beforeEach(() => {
      // ServerSettings defaults its logLevel from Logger.logLevel, which other suites change
      savedLogLevel = Logger.logLevel
      Logger.logLevel = 0
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-char-db-'))
      saved = Object.fromEntries(SINGLETON_FIELDS.map((f) => [f, Database[f]]))
      savedGlobals = { ConfigPath: global.ConfigPath, MetadataPath: global.MetadataPath, ServerSettings: global.ServerSettings }
      global.ConfigPath = path.join(tmp, 'config')
      global.MetadataPath = path.join(tmp, 'metadata')
      fs.mkdirSync(global.ConfigPath)
      fs.mkdirSync(global.MetadataPath)
      Database.libraryFilterData = {}
      Database.hasRootUser = false
      logs = {}
      for (const level of ['info', 'warn', 'error', 'debug']) logs[level] = sinon.stub(Logger, level)
    })

    afterEach(async () => {
      if (Database.sequelize && Database.sequelize !== saved.sequelize) {
        // User.js keeps a module-private user cache that outlives the database (see harness stop())
        if (Database.userModel) for (const user of await Database.userModel.findAll().catch(() => [])) await user.destroy().catch(() => {})
        await Database.sequelize.close().catch(() => {})
      }
      sinon.restore()
      Logger.logLevel = savedLogLevel
      for (const f of SINGLETON_FIELDS) Database[f] = saved[f]
      for (const [k, v] of Object.entries(savedGlobals)) {
        if (v === undefined) delete global[k]
        else global[k] = v
      }
      delete process.env.SQLITE_CACHE_SIZE
      delete process.env.SQLITE_TEMP_STORE
      delete process.env.NUSQLITE3_PATH
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    const snap = (ctx, value, label) => matchSnapshot(ctx, value, { label, tmpDirs: [tmp] })
    const tables = async () => (await rows(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)).map((r) => r.name)
    const columns = async (table) => (await rows(`PRAGMA table_info('${table}')`)).map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}`)

    it('checkHasDb is false before the file exists and true after', async function () {
      Database.dbPath = path.join(global.ConfigPath, 'absdatabase.sqlite')
      const before = await Database.checkHasDb()
      fs.writeFileSync(Database.dbPath, '')
      const after = await Database.checkHasDb()
      snap(this, { before, after, infoLogs: logCalls(logs.info) })
    })

    it('creates a new database: file, flags, models, tables, triggers and default settings', async function () {
      await Database.init()
      const state = {
        dbPath: Database.dbPath,
        fileExists: fs.existsSync(Database.dbPath),
        isNew: Database.isNew,
        hasRootUser: Database.hasRootUser,
        supportsUnaccent: Database.supportsUnaccent,
        supportsUnicodeFoldings: Database.supportsUnicodeFoldings,
        models: Object.keys(Database.models),
        tables: await tables(),
        triggers: (await rows(`SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY name`)),
        configDir: fs.readdirSync(global.ConfigPath).sort(),
        migrationsMeta: (await rows(`SELECT key, value FROM migrationsMeta ORDER BY key`)).map((r) => ({ key: r.key, value: r.key === 'version' || r.key === 'maxVersion' ? (r.value === packageJson.version ? '<package version>' : r.value) : r.value })),
        settingRows: (await rows(`SELECT key FROM settings ORDER BY key`)).map((r) => r.key),
        infoLogs: logCalls(logs.info),
        errorLogs: logCalls(logs.error)
      }
      snap(this, state)
    })

    it('model accessors map to the registered models', async function () {
      await Database.init()
      const accessors = ['userModel', 'sessionModel', 'apiKeyModel', 'libraryModel', 'libraryFolderModel', 'authorModel', 'seriesModel', 'bookModel', 'bookSeriesModel', 'bookAuthorModel', 'podcastModel', 'podcastEpisodeModel', 'libraryItemModel', 'mediaProgressModel', 'collectionModel', 'collectionBookModel', 'playlistModel', 'playlistMediaItemModel', 'feedModel', 'feedEpisodeModel', 'playbackSessionModel', 'customMetadataProviderModel', 'mediaItemShareModel', 'deviceModel']
      snap(this, Object.fromEntries(accessors.map((a) => [a, Database[a]?.name])))
      expect(Database.models.setting).to.exist
    })

    it('associations of every model', async function () {
      await Database.init()
      const out = {}
      for (const [name, model] of Object.entries(Database.models).sort(([a], [b]) => (a < b ? -1 : 1))) {
        out[name] = Object.fromEntries(
          Object.entries(model.associations)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([alias, a]) => [alias, `${a.associationType} ${a.target.name} fk=${a.foreignKey}`])
        )
      }
      snap(this, out)
    })

    it('key columns of the main tables', async function () {
      await Database.init()
      const out = {}
      for (const t of ['users', 'libraries', 'libraryItems', 'books', 'podcasts', 'podcastEpisodes', 'settings', 'sessions', 'apiKeys', 'mediaProgresses', 'playbackSessions', 'bookAuthors', 'bookSeries']) out[t] = await columns(t)
      snap(this, out)
    })

    it('indexes created by the models', async function () {
      await Database.init()
      const idx = await rows(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY tbl_name, name`)
      snap(this, idx)
    })

    it('keeps default settings in memory only: a new database stores no settings rows until something saves them', async function () {
      await Database.init()
      const stored = await Database.models.setting.findAll({ order: [['key', 'ASC']] })
      expect(Database.serverSettings.version).to.equal(packageJson.version)
      expect(Database.serverSettings.buildNumber).to.equal(packageJson.buildNumber)
      snap(this, {
        storedKeys: stored.map((s) => s.key),
        serverSettings: { ...Database.serverSettings.toJSON(), version: '<package version>' },
        globalServerSettingsMatches: JSON.stringify(global.ServerSettings) === JSON.stringify(Database.serverSettings.toJSON()),
        emailSettings: Database.emailSettings.toJSON(),
        notificationSettings: Database.notificationSettings.toJSON(),
        settingsArrayIds: Database.settings.map((s) => s.id)
      })
    })

    it('does not create a root user; createRootUser then sets hasRootUser', async function () {
      await Database.init()
      const before = { hasRootUser: Database.hasRootUser, users: await Database.userModel.count() }
      const auth = { generateAccessToken: ({ id, username }) => `token-for-${username}` }
      const created = await Database.createRootUser('boss', 'pash-hash', auth)
      const user = await Database.userModel.findOne({ where: { username: 'boss' } })
      snap(this, {
        before,
        created,
        hasRootUser: Database.hasRootUser,
        user: { type: user.type, username: user.username, pash: user.pash, token: user.token === `token-for-boss` ? 'token-for-boss' : user.token, isActive: user.isActive, bookmarks: user.bookmarks, extraData: user.extraData, permissions: user.permissions }
      })
    })

    it('opens an existing database: isNew false, data and settings kept, version untouched', async function () {
      await Database.init()
      await Database.createRootUser('boss', 'pash', { generateAccessToken: () => 'tok' })
      Database.serverSettings.scannerParseSubtitle = true
      Database.serverSettings.chromecastEnabled = true
      await Database.updateServerSettings()
      logs.info.resetHistory()
      await Database.disconnect()

      const existedBefore = await Database.checkHasDb()
      await Database.init()
      snap(this, {
        existedBefore,
        isNew: Database.isNew,
        hasRootUser: Database.hasRootUser,
        users: await Database.userModel.count(),
        scannerParseSubtitle: Database.serverSettings.scannerParseSubtitle,
        chromecastEnabled: Database.serverSettings.chromecastEnabled,
        version: Database.serverSettings.version === packageJson.version ? '<package version>' : Database.serverSettings.version,
        upgradeLogged: logs.info.getCalls().some((c) => /upgrade detected/.test(c.args[0])),
        migrationsSkippedLogged: logs.info.getCalls().some((c) => /Database is new/.test(c.args[0])),
        infoLogs: logCalls(logs.info)
      })
    })

    it('logs a server upgrade and rewrites version/buildNumber when the stored version differs', async function () {
      await Database.init()
      await Database.models.setting.updateSettingObj({ ...Database.serverSettings.toJSON(), version: '2.30.0', buildNumber: 7 })
      await Database.disconnect()
      logs.info.resetHistory()
      await Database.init()
      const stored = (await Database.models.setting.findByPk('server-settings')).value
      snap(this, {
        loaded: { version: Database.serverSettings.version === packageJson.version ? '<package version>' : Database.serverSettings.version, buildNumber: Database.serverSettings.buildNumber === packageJson.buildNumber ? '<package build>' : Database.serverSettings.buildNumber },
        stored: { version: stored.version === packageJson.version ? '<package version>' : stored.version, buildNumber: stored.buildNumber === packageJson.buildNumber ? '<package build>' : stored.buildNumber },
        upgradeLog: logs.info.getCalls().map((c) => c.args[0]).filter((m) => /upgrade/.test(m)).map((m) => m.split(packageJson.version).join('<package version>'))
      })
    })

    it('logs a build upgrade when only the buildNumber differs', async function () {
      await Database.init()
      await Database.models.setting.updateSettingObj({ ...Database.serverSettings.toJSON(), buildNumber: 5 })
      await Database.disconnect()
      logs.info.resetHistory()
      await Database.init()
      snap(this, {
        buildNumberIsPackage: Database.serverSettings.buildNumber === packageJson.buildNumber,
        buildLog: logs.info.getCalls().map((c) => c.args[0]).filter((m) => /build upgraded/.test(m)).map((m) => m.split(packageJson.version).join('<package version>'))
      })
    })

    it('init(true) on an existing database is treated as new and drops all data', async function () {
      await Database.init()
      await Database.createRootUser('boss', 'pash', { generateAccessToken: () => 'tok' })
      Database.serverSettings.chromecastEnabled = true
      await Database.updateServerSettings()
      await Database.disconnect()
      await Database.init(true)
      snap(this, {
        isNew: Database.isNew,
        hasRootUser: Database.hasRootUser,
        users: await Database.userModel.count(),
        storedSettingKeys: (await Database.models.setting.findAll()).map((s) => s.key),
        chromecastEnabled: Database.serverSettings.chromecastEnabled
      })
    })

    it('reconnect() re-runs init against the same file', async function () {
      await Database.init()
      await Database.createRootUser('boss', 'pash', { generateAccessToken: () => 'tok' })
      await Database.disconnect()
      await Database.reconnect()
      snap(this, { isNew: Database.isNew, hasRootUser: Database.hasRootUser, users: await Database.userModel.count(), connectLogs: logCalls(logs.info).filter((l) => /Reconnecting|Disconnecting/.test(l[0])) })
    })

    it('fails with "Database migration failed" on a file that is not a sqlite database', async function () {
      Database.dbPath = null
      fs.writeFileSync(path.join(global.ConfigPath, 'absdatabase.sqlite'), 'this is not a sqlite database, it is just text. '.repeat(100))
      let error = null
      try {
        await Database.init()
      } catch (e) {
        error = e.message
      }
      snap(this, { error, isNew: Database.isNew, errorLogs: logs.error.getCalls().map((c) => [c.args[0], c.args[1]?.message]) }, 'corrupt file')
    })

    it('creates a missing config directory itself (sqlite storage dir) and initializes a new database', async function () {
      global.ConfigPath = path.join(tmp, 'missing-dir')
      let error = null
      try {
        await Database.init()
      } catch (e) {
        error = e.message
      }
      snap(this, { error, isNew: Database.isNew, configDirExists: fs.existsSync(global.ConfigPath), dbFileExists: fs.existsSync(Database.dbPath), errorLogs: logs.error.getCalls().map((c) => [c.args[0], c.args[1]?.message]) })
    })

    it('connect() returns false when the NUSQLITE3 extension cannot be loaded', async function () {
      Database.dbPath = path.join(global.ConfigPath, 'absdatabase.sqlite')
      process.env.NUSQLITE3_PATH = path.join(tmp, 'does-not-exist.so')
      const ok = await Database.connect()
      await Database.sequelize.close()
      snap(this, { ok, supportsUnaccent: Database.supportsUnaccent, supportsUnicodeFoldings: Database.supportsUnicodeFoldings, errorLogs: logs.error.getCalls().map((c) => c.args[0].split(tmp).join('<tmp>')) })
    })

    it('connect() applies the allowed SQLITE_* pragmas from the environment', async function () {
      Database.dbPath = path.join(global.ConfigPath, 'absdatabase.sqlite')
      process.env.SQLITE_CACHE_SIZE = '-4000'
      process.env.SQLITE_TEMP_STORE = '2'
      const ok = await Database.connect()
      const cache = await rows('PRAGMA cache_size')
      const temp = await rows('PRAGMA temp_store')
      await Database.sequelize.close()
      snap(this, { ok, cache, temp, infoLogs: logCalls(logs.info).map((l) => l.map((s) => String(s).split(tmp).join('<tmp>'))) })
    })

    it('connect() ignores an invalid pragma value but still succeeds', async function () {
      Database.dbPath = path.join(global.ConfigPath, 'absdatabase.sqlite')
      process.env.SQLITE_CACHE_SIZE = 'not-a-number; DROP'
      const ok = await Database.connect()
      await Database.sequelize.close()
      snap(this, { ok, errorLogs: logs.error.getCalls().map((c) => c.args[0]) })
    })

    it('triggers keep libraryItems title and author names in sync with books and authors', async function () {
      await Database.init()
      const lf = await createLibrary()
      const { book, libraryItem } = await createBook(lf, { title: 'Original', authors: ['Jane Doe', 'John Roe'] })
      const read = async () => (await Database.libraryItemModel.findByPk(libraryItem.id)).get({ plain: true })
      const pick = (li) => ({ title: li.title, titleIgnorePrefix: li.titleIgnorePrefix, authorNamesFirstLast: li.authorNamesFirstLast, authorNamesLastFirst: li.authorNamesLastFirst })
      const afterCreate = pick(await read())
      await Database.bookModel.update({ title: 'The Renamed', titleIgnorePrefix: 'Renamed, The' }, { where: { id: book.id } })
      const afterBookUpdate = pick(await read())
      const author = await Database.authorModel.findOne({ where: { name: 'Jane Doe' } })
      await author.update({ name: 'Janet Doe', lastFirst: 'Doe, Janet' })
      const afterAuthorUpdate = pick(await read())
      await Database.bookAuthorModel.destroy({ where: { bookId: book.id, authorId: author.id } })
      const afterBookAuthorDelete = pick(await read())
      snap(this, { afterCreate, afterBookUpdate, afterAuthorUpdate, afterBookAuthorDelete })
    })

    it('addTriggers is idempotent', async function () {
      await Database.init()
      const before = await rows(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
      logs.info.resetHistory()
      await Database.addTriggers()
      const after = await rows(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
      expect(after).to.deep.equal(before)
      snap(this, { count: after.length, addedLogs: logs.info.getCalls().length })
    })

    it('cleans orphaned and invalid rows while initializing an existing database', async function () {
      await Database.init()
      const lf = await createLibrary()
      const { book } = await createBook(lf, { title: 'Keeper', series: [{ name: 'Kept Series' }] })
      await Database.seriesModel.create({ name: 'Empty Series', libraryId: lf.library.id })
      await Database.bookModel.create({ title: 'Orphan Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
      await Database.podcastModel.create({ title: 'Orphan Podcast', tags: [], genres: [] })
      await Database.playbackSessionModel.create({ mediaItemId: book.id, mediaItemType: 'book', timeListening: 3, displayTitle: 'short' })
      await Database.playbackSessionModel.create({ mediaItemId: book.id, mediaItemType: 'book', timeListening: 4, displayTitle: 'long enough' })
      await Database.disconnect()
      await Database.init()
      snap(this, {
        books: (await Database.bookModel.findAll({ order: [['title', 'ASC']] })).map((b) => b.title),
        podcasts: await Database.podcastModel.count(),
        series: (await Database.seriesModel.findAll()).map((s) => s.name),
        playbackSessions: (await Database.playbackSessionModel.findAll()).map((s) => s.displayTitle),
        warnLogs: logs.warn.getCalls().map((c) => c.args[0])
      })
    })
  })

  describe('in-memory state (harness database)', () => {
    let api, savedLogLevel

    beforeEach(async () => {
      savedLogLevel = Logger.logLevel
      Logger.logLevel = 0 // ServerSettings defaults its logLevel from Logger.logLevel, which other suites change
      api = await startApi()
    })
    afterEach(async () => {
      await api.stop()
      Logger.logLevel = savedLogLevel
    })

    const snap = (ctx, value, label) => matchSnapshot(ctx, value, { label, tmpDirs: [api.tmp] })

    describe('settings persistence', () => {
      it('getOldSettings on an empty settings table yields defaults for all three', async function () {
        const s = await Database.models.setting.getOldSettings()
        snap(this, { settings: s.settings, server: s.serverSettings.toJSON(), email: s.emailSettings.toJSON(), notification: s.notificationSettings.toJSON() })
      })

      it('updateServerSettings round-trips through the settings table and refreshes global.ServerSettings', async function () {
        Database.serverSettings.scannerFindCovers = true
        Database.serverSettings.sortingIgnorePrefix = true
        Database.serverSettings.sortingPrefixes = ['the', 'an']
        Database.serverSettings.backupsToKeep = 9
        Database.serverSettings.language = 'de'
        await Database.updateServerSettings()
        const reloaded = (await Database.models.setting.getOldSettings()).serverSettings
        snap(this, {
          storedKeys: (await Database.models.setting.findAll()).map((s) => s.key),
          reloaded: reloaded.toJSON(),
          global: global.ServerSettings,
          equal: JSON.stringify(reloaded.toJSON()) === JSON.stringify(Database.serverSettings.toJSON())
        })
      })

      it('updateSetting persists email settings including ereader devices', async function () {
        Database.emailSettings.host = 'smtp.example.test'
        Database.emailSettings.port = 587
        Database.emailSettings.secure = false
        Database.emailSettings.user = 'mailer'
        Database.emailSettings.pass = 'secret'
        Database.emailSettings.fromAddress = 'abs@example.test'
        Database.emailSettings.ereaderDevices = [{ name: 'Kindle', email: 'kindle@example.test', availabilityOption: 'adminOrUp', users: [] }]
        await Database.updateSetting(Database.emailSettings)
        const reloaded = (await Database.models.setting.getOldSettings()).emailSettings
        snap(this, { storedKeys: (await Database.models.setting.findAll()).map((s) => s.key), reloaded: reloaded.toJSON(), hostOnly: reloaded.host })
      })

      it('updateSetting persists notification settings with notifications', async function () {
        const res = Database.notificationSettings.update({ appriseApiUrl: 'http://apprise.test/notify', maxFailedAttempts: 2 })
        Database.notificationSettings.notifications.push(new (require('../../server/objects/Notification'))({ id: 'n1', libraryId: null, eventName: 'onPodcastEpisodeDownloaded', urls: ['json://x'], titleTemplate: 't', bodyTemplate: 'b', enabled: true, type: 'info' }))
        await Database.updateSetting(Database.notificationSettings)
        const reloaded = (await Database.models.setting.getOldSettings()).notificationSettings
        snap(this, { updateReturned: res, reloaded: reloaded.toJSON(), isUseable: reloaded.isUseable })
      })

      it('updateSetting upserts: a second save replaces the row instead of adding one', async function () {
        Database.serverSettings.backupsToKeep = 2
        await Database.updateServerSettings()
        Database.serverSettings.backupsToKeep = 3
        const result = await Database.updateServerSettings()
        const all = await Database.models.setting.findAll()
        snap(this, { count: all.length, backupsToKeep: all[0].value.backupsToKeep, resultIsArray: Array.isArray(result), resultKeyedBy: Array.isArray(result) ? result[0].key : null })
      })
    })

    describe('methods without a connected sequelize', () => {
      it('return false instead of throwing', async function () {
        const original = Database.sequelize
        try {
          Database.sequelize = null
          const out = {
            models: Object.keys(Database.models),
            userModel: Database.userModel ?? null,
            createRootUser: await Database.createRootUser('x', 'y', {}),
            updateServerSettings: Database.updateServerSettings(),
            updateSetting: Database.updateSetting({ toJSON: () => ({}) }),
            getPlaybackSessions: Database.getPlaybackSessions(),
            getPlaybackSession: Database.getPlaybackSession('abc'),
            createPlaybackSession: Database.createPlaybackSession({}),
            updatePlaybackSession: Database.updatePlaybackSession({}),
            removePlaybackSession: Database.removePlaybackSession('abc')
          }
          snap(this, out)
        } finally {
          Database.sequelize = original
        }
      })
    })

    describe('playback session helpers', () => {
      it('create, get, update, list (with where) and remove an old-format session', async function () {
        const { user } = Object.assign({}, { user: (await api.seed.users()).user })
        const lf = await createLibrary()
        const { book, libraryItem } = await createBook(lf, { title: 'Played', authors: ['Auth'] })
        const PlaybackSession = require('../../server/objects/PlaybackSession')
        const session = new PlaybackSession({
          id: 'play_1',
          userId: user.id,
          libraryId: lf.library.id,
          libraryItemId: libraryItem.id,
          bookId: book.id,
          mediaType: 'book',
          mediaMetadata: { title: 'Played' },
          displayTitle: 'Played',
          displayAuthor: 'Auth',
          duration: 100,
          playMethod: 0,
          mediaPlayer: 'unknown',
          date: '2024-01-02',
          dayOfWeek: 'Tuesday',
          timeListening: 10,
          startTime: 0,
          currentTime: 5,
          startedAt: 1700000000000,
          updatedAt: 1700000000000
        })
        const created = await Database.createPlaybackSession(session)
        const fetched = await Database.getPlaybackSession(session.id)
        session.timeListening = 20
        session.currentTime = 9
        const updated = await Database.updatePlaybackSession(session)
        const refetched = await Database.getPlaybackSession(session.id)
        const listAll = await Database.getPlaybackSessions()
        const listMatch = await Database.getPlaybackSessions({ userId: user.id })
        const listNone = await Database.getPlaybackSessions({ userId: '00000000-0000-4000-8000-000000000000' })
        const removed = await Database.removePlaybackSession(session.id)
        const afterRemove = await Database.getPlaybackSession(session.id)
        snap(this, { created: created?.id ? 'row' : created, fetched: fetched?.toJSON(), updated, refetched: { timeListening: refetched.timeListening, currentTime: refetched.currentTime }, listAll: listAll.length, listMatch: listMatch.length, listNone: listNone.length, removed, afterRemove: afterRemove ?? null }, 'session lifecycle')
      })
    })

    describe('library filter data helpers', () => {
      const fresh = () => ({
        lib1: { tags: ['a', 'b'], genres: ['g1', 'g2'], narrators: ['n1', 'n2'], series: [{ id: 's1', name: 'Series One' }], authors: [{ id: 'au1', name: 'Author One' }], publishers: ['p1'], publishedDecades: ['2000'], languages: ['en'], numIssues: 0 },
        lib2: { tags: ['b', 'c'], genres: ['g2'], narrators: [], series: [], authors: [], publishers: [], publishedDecades: [], languages: [], numIssues: 0 }
      })
      beforeEach(() => {
        Database.libraryFilterData = fresh()
      })

      it('tags: replace and remove apply to every library; add is per library and de-duplicates', async function () {
        Database.replaceTagInFilterData('b', 'B2')
        const afterReplace = JSON.parse(JSON.stringify(Database.libraryFilterData))
        Database.replaceTagInFilterData('missing', 'x')
        Database.removeTagFromFilterData('a')
        Database.addTagsToFilterData('lib1', ['new', 'new', 'B2'])
        Database.addTagsToFilterData('unknown-lib', ['zzz'])
        Database.addTagsToFilterData('lib2', [])
        Database.addTagsToFilterData('lib2', null)
        snap(this, { afterReplace: afterReplace.lib1.tags.concat(afterReplace.lib2.tags), tags: { lib1: Database.libraryFilterData.lib1.tags, lib2: Database.libraryFilterData.lib2.tags }, unknownLibCreated: 'unknown-lib' in Database.libraryFilterData })
      })

      it('genres: replace and remove apply to every library; add is per library and de-duplicates', async function () {
        Database.replaceGenreInFilterData('g2', 'G2')
        Database.removeGenreFromFilterData('g1')
        Database.addGenresToFilterData('lib2', ['g3', 'g3', 'G2'])
        Database.addGenresToFilterData('unknown-lib', ['x'])
        snap(this, { lib1: Database.libraryFilterData.lib1.genres, lib2: Database.libraryFilterData.lib2.genres })
      })

      it('narrators: replace/remove/add are per library', async function () {
        Database.replaceNarratorInFilterData('lib1', 'n1', 'N1')
        Database.replaceNarratorInFilterData('lib1', 'absent', 'x')
        Database.replaceNarratorInFilterData('unknown-lib', 'n1', 'x')
        Database.removeNarratorFromFilterData('lib1', 'n2')
        Database.removeNarratorFromFilterData('unknown-lib', 'n2')
        Database.addNarratorsToFilterData('lib2', ['n9', 'n9'])
        Database.addNarratorsToFilterData('unknown-lib', ['n9'])
        snap(this, { lib1: Database.libraryFilterData.lib1.narrators, lib2: Database.libraryFilterData.lib2.narrators })
      })

      it('series and authors: add de-duplicates by id and remove filters by id', async function () {
        Database.addSeriesToFilterData('lib1', 'Series Two', 's2')
        Database.addSeriesToFilterData('lib1', 'Renamed Series One', 's1')
        Database.addSeriesToFilterData('unknown-lib', 'x', 'x')
        Database.addAuthorToFilterData('lib1', 'Author Two', 'au2')
        Database.addAuthorToFilterData('lib1', 'Renamed Author One', 'au1')
        Database.addAuthorToFilterData('unknown-lib', 'x', 'x')
        const added = JSON.parse(JSON.stringify(Database.libraryFilterData.lib1))
        Database.removeSeriesFromFilterData('lib1', 's1')
        Database.removeAuthorFromFilterData('lib1', 'au1')
        Database.removeSeriesFromFilterData('unknown-lib', 's1')
        Database.removeAuthorFromFilterData('unknown-lib', 'au1')
        snap(this, { series: added.series, authors: added.authors, afterRemove: { series: Database.libraryFilterData.lib1.series, authors: Database.libraryFilterData.lib1.authors } })
      })

      it('publisher, decade and language add ignore falsy and duplicate values', async function () {
        Database.addPublisherToFilterData('lib1', 'p2')
        Database.addPublisherToFilterData('lib1', 'p1')
        Database.addPublisherToFilterData('lib1', '')
        Database.addPublisherToFilterData('lib1', null)
        Database.addPublishedDecadeToFilterData('lib1', '2010')
        Database.addPublishedDecadeToFilterData('lib1', '2000')
        Database.addPublishedDecadeToFilterData('lib1', 0)
        Database.addLanguageToFilterData('lib1', 'de')
        Database.addLanguageToFilterData('lib1', 'en')
        Database.addLanguageToFilterData('lib1', undefined)
        Database.addPublisherToFilterData('unknown-lib', 'x')
        Database.addPublishedDecadeToFilterData('unknown-lib', 'x')
        Database.addLanguageToFilterData('unknown-lib', 'x')
        snap(this, { publishers: Database.libraryFilterData.lib1.publishers, publishedDecades: Database.libraryFilterData.lib1.publishedDecades, languages: Database.libraryFilterData.lib1.languages, libraries: Object.keys(Database.libraryFilterData) })
      })

      it('checkAuthorExists / checkSeriesExists / getAuthorIdByName / getSeriesIdByName use the cache when set and the database otherwise', async function () {
        const lf = await createLibrary()
        const { book } = await createBook(lf, { title: 'B', authors: ['Real Author'], series: [{ name: 'Real Series' }] })
        const author = await Database.authorModel.findOne({ where: { name: 'Real Author' } })
        const series = await Database.seriesModel.findOne({ where: { name: 'Real Series' } })
        const lib = lf.library.id
        const noCache = {
          authorExists: await Database.checkAuthorExists(lib, author.id),
          authorMissing: await Database.checkAuthorExists(lib, 'nope'),
          seriesExists: await Database.checkSeriesExists(lib, series.id),
          seriesMissing: await Database.checkSeriesExists(lib, 'nope'),
          authorIdByName: await Database.getAuthorIdByName(lib, 'Real Author'),
          authorIdByNameMissing: await Database.getAuthorIdByName(lib, 'Nobody'),
          seriesIdByName: await Database.getSeriesIdByName(lib, 'Real Series'),
          seriesIdByNameMissing: await Database.getSeriesIdByName(lib, 'No Series')
        }
        // cache present but empty: the database is NOT consulted
        Database.libraryFilterData[lib] = { authors: [], series: [], tags: [], genres: [], narrators: [] }
        const emptyCache = {
          authorExists: await Database.checkAuthorExists(lib, author.id),
          seriesExists: await Database.checkSeriesExists(lib, series.id),
          authorIdByName: await Database.getAuthorIdByName(lib, 'Real Author'),
          seriesIdByName: await Database.getSeriesIdByName(lib, 'Real Series')
        }
        Database.addAuthorToFilterData(lib, 'Real Author', author.id)
        Database.addSeriesToFilterData(lib, 'Real Series', series.id)
        const filled = {
          authorExists: await Database.checkAuthorExists(lib, author.id),
          seriesExists: await Database.checkSeriesExists(lib, series.id),
          authorIdByName: await Database.getAuthorIdByName(lib, 'Real Author'),
          seriesIdByName: await Database.getSeriesIdByName(lib, 'Real Series')
        }
        const ids = new Map([[author.id, '<author>'], [series.id, '<series>'], [lib, '<library>'], [book.id, '<book>']])
        matchSnapshot(this, { noCache, emptyCache, filled }, { ids, tmpDirs: [api.tmp] })
      })

      it('resetLibraryIssuesFilterData counts missing or invalid items and ignores libraries without cache', async function () {
        const lf = await createLibrary()
        await createBook(lf, { title: 'ok' })
        const missing = await createBook(lf, { title: 'missing' })
        const invalid = await createBook(lf, { title: 'invalid' })
        await Database.libraryItemModel.update({ isMissing: true }, { where: { id: missing.libraryItem.id } })
        await Database.libraryItemModel.update({ isInvalid: true }, { where: { id: invalid.libraryItem.id } })
        await Database.resetLibraryIssuesFilterData('not-cached')
        Database.libraryFilterData[lf.library.id] = { numIssues: 99 }
        await Database.resetLibraryIssuesFilterData(lf.library.id)
        snap(this, { numIssues: Database.libraryFilterData[lf.library.id].numIssues, notCachedCreated: 'not-cached' in Database.libraryFilterData })
      })
    })

    describe('cleanDatabase', () => {
      const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

      it('removes books, podcasts and library items without counterpart, empty series, orphan playlist/collection rows', async function () {
        const lf = await createLibrary()
        const users = await api.seed.users()
        await createBook(lf, { title: 'Keeper', series: [{ name: 'Kept' }] })
        await Database.seriesModel.create({ name: 'Empty', libraryId: lf.library.id })
        await Database.bookModel.create({ title: 'Orphan Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
        await Database.podcastModel.create({ title: 'Orphan Podcast', tags: [], genres: [] })
        await Database.libraryItemModel.create({ libraryFiles: [], mediaId: uuid(1), mediaType: 'book', libraryId: lf.library.id, libraryFolderId: lf.folder.id, path: '/x/no-media', relPath: 'no-media' })
        const collection = await Database.collectionModel.create({ name: 'C', libraryId: lf.library.id })
        await Database.collectionBookModel.create({ collectionId: collection.id, bookId: uuid(2) }).catch((e) => e)
        const playlist = await Database.playlistModel.create({ name: 'P', libraryId: lf.library.id, userId: users.user.id })
        await Database.playlistMediaItemModel.create({ playlistId: playlist.id, mediaItemId: uuid(3), mediaItemType: 'book' }).catch((e) => e)
        const before = {
          books: await Database.bookModel.count(),
          podcasts: await Database.podcastModel.count(),
          libraryItems: await Database.libraryItemModel.count(),
          series: await Database.seriesModel.count(),
          collectionBooks: await Database.collectionBookModel.count(),
          playlistMediaItems: await Database.playlistMediaItemModel.count()
        }
        await Database.cleanDatabase()
        const after = {
          books: (await Database.bookModel.findAll()).map((b) => b.title),
          podcasts: await Database.podcastModel.count(),
          libraryItems: await Database.libraryItemModel.count(),
          series: (await Database.seriesModel.findAll()).map((s) => s.name),
          collectionBooks: await Database.collectionBookModel.count(),
          playlistMediaItems: await Database.playlistMediaItemModel.count()
        }
        snap(this, { before, after, warnLogs: Logger.warn.getCalls().map((c) => c.args[0]) })
      })

      it('removes playback sessions of 3 seconds or less, duplicate media progress (keeping the newest) and expired sessions, and deactivates expired api keys', async function () {
        const { user } = await api.seed.users()
        const lf = await createLibrary()
        const { book } = await createBook(lf, { title: 'B' })
        await Database.playbackSessionModel.bulkCreate([
          { mediaItemId: book.id, mediaItemType: 'book', timeListening: 0, displayTitle: 'zero' },
          { mediaItemId: book.id, mediaItemType: 'book', timeListening: 3, displayTitle: 'three' },
          { mediaItemId: book.id, mediaItemType: 'book', timeListening: 4, displayTitle: 'four' }
        ])
        await Database.mediaProgressModel.bulkCreate(
          [
            { id: uuid(11), userId: user.id, mediaItemId: book.id, mediaItemType: 'book', duration: 10, currentTime: 1, updatedAt: new Date('2024-01-01T00:00:00Z') },
            { id: uuid(12), userId: user.id, mediaItemId: book.id, mediaItemType: 'book', duration: 10, currentTime: 2, updatedAt: new Date('2024-02-01T00:00:00Z') },
            { id: uuid(13), userId: user.id, mediaItemId: book.id, mediaItemType: 'book', duration: 10, currentTime: 3, updatedAt: new Date('2024-02-01T00:00:00Z') }
          ],
          { silent: true }
        )
        await Database.sessionModel.bulkCreate([
          { ipAddress: 'expired', refreshToken: 'a', expiresAt: new Date(Date.now() - 1000), userId: user.id },
          { ipAddress: 'valid', refreshToken: 'b', expiresAt: new Date(Date.now() + 3600 * 1000), userId: user.id }
        ])
        await Database.apiKeyModel.bulkCreate([
          { name: 'expired-key', expiresAt: new Date(Date.now() - 1000), isActive: true, permissions: {}, userId: user.id },
          { name: 'future-key', expiresAt: new Date(Date.now() + 3600 * 1000), isActive: true, permissions: {}, userId: user.id },
          { name: 'no-expiry-key', expiresAt: null, isActive: true, permissions: {}, userId: user.id }
        ])
        await Database.cleanDatabase()
        snap(this, {
          playbackSessions: (await Database.playbackSessionModel.findAll({ order: [['displayTitle', 'ASC']] })).map((s) => s.displayTitle),
          mediaProgress: (await Database.mediaProgressModel.findAll({ order: [['id', 'ASC']] })).map((m) => ({ currentTime: m.currentTime })),
          sessions: (await Database.sessionModel.findAll()).map((s) => s.ipAddress),
          apiKeys: (await Database.apiKeyModel.findAll({ order: [['name', 'ASC']] })).map((k) => ({ name: k.name, isActive: k.isActive })),
          warnLogs: Logger.warn.getCalls().map((c) => c.args[0].replace(/"[0-9a-f-]{36}"/g, '"<id>"')),
          infoLogs: Logger.info.getCalls().map((c) => c.args[0])
        })
      })

      it('cleanupExpiredSessions and deactivateExpiredApiKeys swallow and log database errors', async function () {
        const stubs = [sinon.stub(Database.sessionModel, 'cleanupExpiredSessions').rejects(new Error('boom-session')), sinon.stub(Database.apiKeyModel, 'deactivateExpiredApiKeys').rejects(new Error('boom-key'))]
        await Database.cleanupExpiredSessions()
        await Database.deactivateExpiredApiKeys()
        stubs.forEach((s) => s.restore())
        snap(this, { errorLogs: Logger.error.getCalls().map((c) => c.args[0]) })
      })
    })

    describe('utility methods', () => {
      it('compareVersions', async function () {
        const pairs = [['2.3.0', '2.3.0'], ['2.3.1', '2.3.0'], ['2.3.0', '2.3.1'], ['2.10.0', '2.9.0'], ['2.3.0', '2.3.0-beta'], ['v2.3.0', '2.3.0'], ['', '2.3.0'], ['2.3.0', null], [undefined, undefined]]
        snap(this, pairs.map(([a, b]) => ({ a, b, result: Database.compareVersions(a, b) })))
      })

      it('convertToSnakeCase', async function () {
        snap(this, ['update_libraryItems_title', 'authorNamesFirstLast', 'ABC', '', 'already_snake'].map((s) => ({ s, out: Database.convertToSnakeCase(s) })))
      })

      it('TextSearchQuery builds LIKE expressions (escaped) without unaccent support', async function () {
        const q = await Database.createTextSearchQuery("it's 100% a_test")
        snap(this, { supportsUnaccent: q.supportsUnaccent, hasAccents: q.hasAccents, expression: q.matchExpression('books.title'), constructedBy: q.constructor.name })
      })

      it('TextSearchQuery with unaccent support wraps the column unless the query has accents', async function () {
        const run = async (query) => {
          const q = new Database.TextSearchQuery(Database.sequelize, true, query)
          // the sqlite test database has no unaccent() function, so init() cannot run; set the flag init() would compute
          q.hasAccents = query.includes('é')
          return q.matchExpression('title')
        }
        snap(this, { plain: await run('cafe'), accented: await run('café') })
      })

      it('TextSearchQuery.init with unaccent support fails when the sqlite function is missing', async function () {
        const q = new Database.TextSearchQuery(Database.sequelize, true, 'cafe')
        let error = null
        try {
          await q.init()
        } catch (e) {
          error = e.message
        }
        snap(this, { error })
      })

      it('hasRootUser and the root user lookup', async function () {
        const before = await Database.userModel.getHasRootUser()
        await api.seed.users()
        const after = await Database.userModel.getHasRootUser()
        snap(this, { before, after, flag: Database.hasRootUser })
      })

      it('model accessors resolve to registered model names; the model list of a built sequelize', async function () {
        snap(this, { models: Object.keys(Database.models), settingsModelRegistered: !!Database.models.setting })
      })

      it('has no getLibraryItem(s)/getPodcastEpisode helpers (they live on the models)', async function () {
        snap(this, { getLibraryItem: typeof Database.getLibraryItem, getLibraryItems: typeof Database.getLibraryItems, getPodcastEpisode: typeof Database.getPodcastEpisode, libraryItemModelFindByPk: typeof Database.libraryItemModel.findByPk })
      })

      it('a fresh Database instance has the documented initial state', async function () {
        const Fresh = Database.constructor
        const d = new Fresh()
        snap(this, { sequelize: d.sequelize, dbPath: d.dbPath, isNew: d.isNew, hasRootUser: d.hasRootUser, settings: d.settings, libraryFilterData: d.libraryFilterData, serverSettings: d.serverSettings, notificationSettings: d.notificationSettings, emailSettings: d.emailSettings, supportsUnaccent: d.supportsUnaccent, supportsUnicodeFoldings: d.supportsUnicodeFoldings, models: d.models, userModel: d.userModel ?? null })
      })
    })
  })
})
