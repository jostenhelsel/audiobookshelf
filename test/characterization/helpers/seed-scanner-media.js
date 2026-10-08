/*
 * Media fixtures for scanner characterization tests: tiny audio files via ffmpeg (sine tone, optional tags / embedded cover /
 * chapters), a STORE-only zip writer for epub and cbz, and a 1x1 PNG. Everything is generated at test time.
 * Use hasFfmpeg() in a before() hook and this.skip() when it is false.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

function hasFfmpeg() {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' })
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let jpegCache = null
/** a tiny red jpeg (made by ffmpeg once per process) */
function makeJpeg() {
  if (!jpegCache) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'abs-jpg-')), 'c.jpg')
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=8x8', '-frames:v', '1', out])
    jpegCache = fs.readFileSync(out)
    fs.rmSync(path.dirname(out), { recursive: true, force: true })
  }
  return jpegCache
}

/**
 * @param {string} file output path; the extension picks the container (.mp3 .m4b .m4a .ogg .flac ...)
 * @param {{ seconds?: number, tags?: Record<string,string>, cover?: boolean, chapters?: {title:string, start:number, end:number}[] }} [o]
 *   tags are passed as ffmpeg -metadata key=value; chapters are written through an ffmetadata file
 */
function makeAudio(file, o = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const ext = path.extname(file).slice(1).toLowerCase()
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${o.seconds ?? 1}`]
  let coverFile = null
  let metaFile = null
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-mk-'))
  try {
    if (o.cover) {
      coverFile = path.join(tmp, 'cover.jpg')
      fs.writeFileSync(coverFile, makeJpeg())
      args.push('-i', coverFile)
    }
    if (o.chapters?.length) {
      metaFile = path.join(tmp, 'meta.txt')
      const lines = [';FFMETADATA1']
      for (const c of o.chapters) lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(c.end * 1000)}`, `title=${c.title}`)
      fs.writeFileSync(metaFile, lines.join('\n') + '\n')
      args.push('-i', metaFile)
    }
    // inputs: 0 = audio, then cover and/or chapters metadata in the order added
    args.push('-map', '0:a')
    let next = 1
    if (coverFile) {
      args.push('-map', `${next}:v`, '-c:v', ext === 'mp3' ? 'mjpeg' : 'copy', '-disposition:v', 'attached_pic')
      next++
    }
    if (metaFile) args.push('-map_metadata', String(next), '-map_chapters', String(next))
    const codec = { mp3: 'libmp3lame', m4b: 'aac', m4a: 'aac', mp4: 'aac', ogg: 'libopus', opus: 'libopus', flac: 'flac' }[ext]
    if (codec) args.push('-c:a', codec)
    if (ext === 'mp3') args.push('-id3v2_version', '3')
    for (const [k, v] of Object.entries(o.tags || {})) args.push('-metadata', `${k}=${v}`)
    args.push(file)
    execFileSync(FFMPEG, args)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return file
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** STORE-only zip; entries is { 'path/in/zip': string|Buffer }, written in key order */
function makeZip(file, entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // utf8 names
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const count = Object.keys(entries).length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([...locals, centralBuf, end]))
  return file
}

/**
 * @param {string} file
 * @param {{ title?: string, creators?: {name:string, role?:string}[], series?: string, seriesIndex?: string, subjects?: string[], publisher?: string, date?: string, language?: string, description?: string, isbn?: string, cover?: boolean }} [o]
 */
function makeEpub(file, o = {}) {
  const dc = [`<dc:title>${o.title ?? 'Epub Title'}</dc:title>`]
  for (const c of o.creators || []) dc.push(`<dc:creator opf:role="${c.role || 'aut'}">${c.name}</dc:creator>`)
  for (const s of o.subjects || []) dc.push(`<dc:subject>${s}</dc:subject>`)
  if (o.publisher) dc.push(`<dc:publisher>${o.publisher}</dc:publisher>`)
  if (o.date) dc.push(`<dc:date>${o.date}</dc:date>`)
  if (o.language) dc.push(`<dc:language>${o.language}</dc:language>`)
  if (o.description) dc.push(`<dc:description>${o.description}</dc:description>`)
  if (o.isbn) dc.push(`<dc:identifier opf:scheme="ISBN">${o.isbn}</dc:identifier>`)
  const metas = []
  if (o.series) metas.push(`<meta name="calibre:series" content="${o.series}"/>`)
  if (o.seriesIndex) metas.push(`<meta name="calibre:series_index" content="${o.seriesIndex}"/>`)
  if (o.cover) metas.push('<meta name="cover" content="cover-img"/>')
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0">
<metadata>${dc.join('')}${metas.join('')}</metadata>
<manifest>${o.cover ? '<item id="cover-img" href="images/cover.png" media-type="image/png"/>' : ''}<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/></spine>
</package>`
  const entries = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': opf,
    'OEBPS/c1.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hi</p></body></html>'
  }
  if (o.cover) entries['OEBPS/images/cover.png'] = PNG_1X1
  return makeZip(file, entries)
}

/** @param {string} file @param {{ images?: number, comicInfo?: string }} [o] */
function makeCbz(file, o = {}) {
  const entries = {}
  for (let i = 1; i <= (o.images ?? 2); i++) entries[`page${String(i).padStart(2, '0')}.png`] = PNG_1X1
  if (o.comicInfo) entries['ComicInfo.xml'] = o.comicInfo
  return makeZip(file, entries)
}

module.exports = { hasFfmpeg, makeAudio, makeJpeg, makeZip, makeEpub, makeCbz, PNG_1X1 }
