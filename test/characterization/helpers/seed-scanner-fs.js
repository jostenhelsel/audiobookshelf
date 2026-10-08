/*
 * Filesystem fixtures for scanner characterization tests. Trees are generated at test time into a temp dir, never committed.
 *   const root = makeTree({ 'Author/Book/01.mp3': '', 'Author/Book/desc.txt': 'hello', 'Empty Dir/': null })
 * A key ending in "/" creates an empty directory. Values are file contents (string or Buffer).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('../../../server/Database')

function mkTmp(prefix = 'abs-scan-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/**
 * @param {Record<string, string|Buffer|null>} spec
 * @param {string} [root] existing dir to add to (default: new temp dir)
 * @returns {string} root dir
 */
function makeTree(spec, root = mkTmp()) {
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel)
    if (rel.endsWith('/')) {
      fs.mkdirSync(full, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content ?? '')
    }
  }
  return root
}

function rmTree(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

/**
 * Library (with default settings, optionally overridden) and one folder pointing at a real directory.
 * @param {string} folderPath
 * @param {{ mediaType?: 'book'|'podcast', name?: string, settings?: object }} [o]
 */
async function createScanLibrary(folderPath, o = {}) {
  const mediaType = o.mediaType || 'book'
  const settings = { ...Database.libraryModel.getDefaultLibrarySettingsForMediaType(mediaType), ...(o.settings || {}) }
  const library = await Database.libraryModel.create({ name: o.name || (mediaType === 'book' ? 'Books' : 'Podcasts'), mediaType, settings, extraData: {} })
  const folder = await Database.libraryFolderModel.create({ path: folderPath, libraryId: library.id })
  library.libraryFolders = [folder]
  return { library, folder }
}

module.exports = { mkTmp, makeTree, rmTree, createScanLibrary }
