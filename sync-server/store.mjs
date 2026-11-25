import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { BookmarkStore, quoteSlices } from '../modules/pipeline/bookmarks.js'
import { ReadingProgressStore } from '../modules/pipeline/reading-progress.js'
import { enrichReading } from '../modules/pipeline/reader.js'
import { hash, markdownBlocks } from '../modules/pipeline/markdown.js'
import { cloneOrCopyFile, pathStats, pruneDirByLru } from '../modules/pipeline/hygiene.js'
import { createLibrarySearcher } from '../modules/pipeline/search.js'
import { sanitizeNotices } from '../modules/pipeline/notices.js'

const SAFE_ID_RE = /^[\w.\-]+$/

function assertSafeId(id, label = '编号') {
  const val = String(id ?? '').trim()
  if (!val || val.length > 160 || !SAFE_ID_RE.test(val) || val.includes('..')) {
    throw new Error(`${label}无效`)
  }
  return val
}

async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => h.update(chunk))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback
    throw err
  }
}

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await fs.rename(tmp, file)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

function slimReadingBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map(b => {
    if (!b || typeof b !== 'object') return b
    const out = { ...b }
    delete out.sourceParagraphId
    delete out.pdfPages
    delete out.originalPdfPage
    if (out.sourceBlockId === out.id) delete out.sourceBlockId
    return out
  })
}

function leanReadingDoc(doc, { includeGlossary = false, slimBlocks = false } = {}) {
  if (!doc || typeof doc !== 'object') return doc
  const out = { ...doc }
  delete out.bookmarkBlocks
  if (!includeGlossary) delete out.glossary
  if (slimBlocks) {
    for (const key of [
      'blockAliases',
      'explicitPairs',
      'directoryLinks',
      'alignment',
      'sourceMapViews',
      'importWarnings',
      'sourceMapAvailable',
    ]) {
      delete out[key]
    }
    out.blocks = slimReadingBlocks(out.blocks)
    if (out.originalBlocks) out.originalBlocks = slimReadingBlocks(out.originalBlocks)
  }
  return out
}

export class CloudSyncStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir)
    this.booksDir = path.join(this.dataDir, 'books')
    this.blobsPdfDir = path.join(this.dataDir, 'blobs', 'pdfs')
    this.libraryFile = path.join(this.dataDir, 'library.json')
    this.revisionsFile = path.join(this.dataDir, 'revisions.json')
    this.noticesFile = path.join(this.dataDir, 'pipeline-notices.json')
    this.bookmarkStore = new BookmarkStore(path.join(this.dataDir, 'bookmarks-v1.json'))
    this.progressStore = new ReadingProgressStore(path.join(this.dataDir, 'reading-progress-v1.json'))
    this.librarySearcher = createLibrarySearcher()
    this.queue = Promise.resolve()
  }

  blobPdfPath(sha256) {
    const val = String(sha256 ?? '').trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(val)) return null
    return path.join(this.blobsPdfDir, `${val}.pdf`)
  }

  async linkOrClonePdf(src, dst) {
    await fs.mkdir(path.dirname(dst), { recursive: true })
    const tmp = `${dst}.${randomUUID()}.tmp`
    try {
      try {
        await fs.link(src, tmp)
        await fs.rename(tmp, dst)
        return { linked: true }
      } catch {
        await fs.unlink(tmp).catch(() => {})
      }
      await cloneOrCopyFile(src, dst, 0o600)
      return { linked: false }
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  }

  async serialized(fn) {
    const job = this.queue.catch(() => {}).then(fn)
    this.queue = job
    return job
  }

  bookDir(taskId) {
    return path.join(this.booksDir, assertSafeId(taskId, '任务编号'))
  }

  async readLibraryState() {
    const state = await readJson(this.libraryFile, null)
    if (state && typeof state === 'object') {
      return {
        documents: Array.isArray(state.documents) ? state.documents : [],
        folders: Array.isArray(state.folders) ? state.folders : [],
        itemMeta: state.itemMeta && typeof state.itemMeta === 'object' ? state.itemMeta : {},
        manifest: state.manifest && typeof state.manifest === 'object' ? state.manifest : {},
      }
    }
    return { documents: [], folders: [], itemMeta: {}, manifest: {} }
  }

  async libraryPayload() {
    const state = await this.readLibraryState()
    return {
      documents: state.documents.map(d => ({
        ...d,
        version: state.manifest[d.id]?.version ?? d.version ?? null,
        hasPdf: Boolean(state.manifest[d.id]?.hasPdf ?? d.hasPdf),
        hasCover: Boolean(state.manifest[d.id]?.hasCover ?? d.hasCover),
        coverPage: state.manifest[d.id]?.coverPage ?? d.coverPage ?? null,
        coverSha256: state.manifest[d.id]?.coverSha256 ?? d.coverSha256 ?? null,
      })),
      folders: state.folders,
      meta: state.itemMeta,
    }
  }

  async searchLibrary({
    q = '',
    taskId = '',
    view = 'all',
    includeHidden = false,
    limitBooks = 30,
    maxMatchesPerBook = 6,
  } = {}) {
    const payload = await this.libraryPayload()
    const visibleDocs = (payload.documents ?? [])
      .filter(d => Boolean(taskId) || includeHidden || !payload.meta?.[d.id]?.hidden)
      .map(d => ({ ...d, stamp: d.version ?? '' }))
    return this.librarySearcher({
      documents: visibleDocs,
      query: q,
      taskId,
      view,
      limitBooks,
      maxMatchesPerBook,
      loadDoc: async meta => {
        const doc = await this.getReading(meta.id).catch(() => null)
        return { reading: doc, stamp: doc?.version ?? meta.stamp ?? '' }
      },
    })
  }

  async getReading(taskId, { includeGlossary = false, slimBlocks = false } = {}) {
    const dir = this.bookDir(taskId)
    const doc = await readJson(path.join(dir, 'reading.json'), null)
    if (!doc) throw new Error('云端暂未同步该文献内容')
    const state = await this.readLibraryState()
    const meta = state.manifest[taskId] ?? {}
    return {
      ...leanReadingDoc(doc, { includeGlossary, slimBlocks }),
      pdfAvailable: Boolean(meta.hasPdf),
      pdfSha256: meta.pdfSha256 ?? null,
    }
  }

  async getAsset(taskId, ref) {
    const dir = this.bookDir(taskId)
    const map = await readJson(path.join(dir, 'assets-map.json'), {})
    const entry = map[String(ref ?? '')]
    if (!entry?.file) throw new Error('云端附件不存在')
    const filePath = path.join(dir, 'assets', path.basename(entry.file))
    const bytes = await fs.readFile(filePath)
    return { bytes, mimeType: entry.mimeType || 'image/png' }
  }

  async hasAssetFile(taskId, ref) {
    const dir = this.bookDir(taskId)
    const map = await readJson(path.join(dir, 'assets-map.json'), {})
    const entry = map[String(ref ?? '')]
    if (!entry?.file) return false
    const filePath = path.join(dir, 'assets', path.basename(entry.file))
    return fs.access(filePath).then(() => true).catch(() => false)
  }

  async pdfPath(taskId) {
    const dir = this.bookDir(taskId)
    const file = path.join(dir, 'source.pdf')
    await fs.access(file)
    return file
  }

  async pushBundle(bundle) {
    if (!bundle?.libraryEntry?.id || !bundle?.reading) {
      throw new Error('同步包格式无效')
    }
    const taskId = assertSafeId(bundle.libraryEntry.id, '任务编号')
    const dir = this.bookDir(taskId)
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true })

    const assetsMap = {}
    for (const asset of bundle.assets ?? []) {
      if (!asset?.ref || !asset?.dataBase64) continue
      const ext = asset.mimeType === 'image/png'
        ? '.png'
        : asset.mimeType === 'image/gif'
          ? '.gif'
          : asset.mimeType === 'image/webp'
            ? '.webp'
            : '.jpg'
      const filename = `${(asset.sha256 || hash(asset.ref)).slice(0, 24)}${ext}`
      const bytes = Buffer.from(asset.dataBase64, 'base64')
      await fs.writeFile(path.join(dir, 'assets', filename), bytes, { mode: 0o600 })
      assetsMap[asset.ref] = { file: filename, mimeType: asset.mimeType || 'image/png' }
    }

    await writeAtomic(path.join(dir, 'assets-map.json'), assetsMap)
    await writeAtomic(path.join(dir, 'reading.json'), leanReadingDoc(bundle.reading))

    // Prune stale asset files no longer referenced by assets-map.json
    const keepAssets = new Set(Object.values(assetsMap).map(e => path.basename(e.file)))
    const assetEntries = await fs.readdir(path.join(dir, 'assets'), { withFileTypes: true }).catch(() => [])
    for (const entry of assetEntries) {
      if (entry.isFile() && !keepAssets.has(entry.name)) {
        await fs.unlink(path.join(dir, 'assets', entry.name)).catch(() => {})
      }
    }

    return this.serialized(async () => {
      const state = await this.readLibraryState()
      const hasCoverAsset = Boolean(bundle.libraryEntry.hasCover && assetsMap['__cover__.jpg']?.file)
      const normalizedEntry = {
        ...bundle.libraryEntry,
        hasCover: hasCoverAsset,
        coverPage: bundle.libraryEntry.coverPage ?? null,
        coverSha256: hasCoverAsset ? (bundle.libraryEntry.coverSha256 ?? null) : null,
      }
      const idx = state.documents.findIndex(d => d.id === taskId)
      if (idx >= 0) state.documents[idx] = normalizedEntry
      else state.documents.unshift(normalizedEntry)

      const prevManifest = state.manifest[taskId] ?? {}
      const hasPdf = await fs.access(path.join(dir, 'source.pdf')).then(() => true).catch(() => false)
      state.manifest[taskId] = {
        ...prevManifest,
        documentId: normalizedEntry.documentId,
        version: bundle.reading.version,
        updatedAt: normalizedEntry.updatedAt ?? new Date().toISOString(),
        hasPdf,
        pdfSha256: hasPdf ? prevManifest.pdfSha256 ?? null : null,
        hasCover: hasCoverAsset,
        coverPage: normalizedEntry.coverPage,
        coverSha256: normalizedEntry.coverSha256,
      }
      await writeAtomic(this.libraryFile, state)
      return { ok: true, taskId, version: bundle.reading.version, assets: Object.keys(assetsMap).length }
    })
  }

  async savePdf(taskId, bytes, sha256 = '') {
    const safeId = assertSafeId(taskId, '任务编号')
    if (!bytes?.length) throw new Error('PDF 内容为空')
    const dir = this.bookDir(safeId)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `source.pdf.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' })
      const digest = sha256 || hash(bytes)
      return await this.savePdfFromFile(safeId, tmp, bytes.length, digest)
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  }

  async savePdfFromFile(taskId, sourceTempFile, bytesLen, sha256 = '') {
    const safeId = assertSafeId(taskId, '任务编号')
    if (!bytesLen || bytesLen <= 0) throw new Error('PDF 内容为空')
    const dir = this.bookDir(safeId)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'source.pdf')
    const digest = sha256 || await hashFileSha256(sourceTempFile)
    const blobFile = this.blobPdfPath(digest)
    if (blobFile) {
      await fs.mkdir(this.blobsPdfDir, { recursive: true })
      const existsBlob = await fs.access(blobFile).then(() => true).catch(() => false)
      if (!existsBlob) {
        try {
          await fs.rename(sourceTempFile, blobFile)
        } catch {
          await cloneOrCopyFile(sourceTempFile, blobFile, 0o600)
          await fs.unlink(sourceTempFile).catch(() => {})
        }
      } else {
        await fs.unlink(sourceTempFile).catch(() => {})
      }
      await this.linkOrClonePdf(blobFile, file)
    } else {
      await fs.rename(sourceTempFile, file)
    }
    // Clear stale page cache when PDF changes
    await fs.rm(path.join(dir, 'pdf-pages'), { recursive: true, force: true }).catch(() => {})

    return this.serialized(async () => {
      const state = await this.readLibraryState()
      state.manifest[safeId] = {
        ...(state.manifest[safeId] ?? {}),
        hasPdf: true,
        pdfSha256: digest,
        pdfUpdatedAt: new Date().toISOString(),
      }
      await writeAtomic(this.libraryFile, state)
      return { ok: true, taskId: safeId, sha256: digest, bytes: bytesLen }
    })
  }

  async linkPdfBySha(taskId, sha256) {
    const safeId = assertSafeId(taskId, '任务编号')
    const blobFile = this.blobPdfPath(sha256)
    if (!blobFile) throw new Error('PDF 指纹无效')
    const digest = String(sha256).trim().toLowerCase()

    return this.serialized(async () => {
      let sourceBlob = await fs.access(blobFile).then(() => blobFile).catch(() => null)
      const state = await this.readLibraryState()
      if (!sourceBlob) {
        for (const [otherId, meta] of Object.entries(state.manifest)) {
          if (!meta?.hasPdf || meta.pdfSha256 !== digest) continue
          const candidate = path.join(this.bookDir(otherId), 'source.pdf')
          if (await fs.access(candidate).then(() => true).catch(() => false)) {
            await fs.mkdir(this.blobsPdfDir, { recursive: true })
            await this.linkOrClonePdf(candidate, blobFile)
            sourceBlob = blobFile
            break
          }
        }
      }
      if (!sourceBlob) {
        throw Object.assign(new Error('云端尚无匹配的 PDF 缓存'), { status: 404 })
      }
      const dir = this.bookDir(safeId)
      const target = path.join(dir, 'source.pdf')
      await this.linkOrClonePdf(sourceBlob, target)
      await fs.rm(path.join(dir, 'pdf-pages'), { recursive: true, force: true }).catch(() => {})
      const st = await fs.stat(target)
      state.manifest[safeId] = {
        ...(state.manifest[safeId] ?? {}),
        hasPdf: true,
        pdfSha256: digest,
        pdfUpdatedAt: new Date().toISOString(),
      }
      await writeAtomic(this.libraryFile, state)
      return { ok: true, taskId: safeId, sha256: digest, bytes: st.size, deduplicated: true }
    })
  }

  async writePdfChunk(taskId, { uploadId, offset = 0, chunk, totalBytes = 0 } = {}) {
    const safeId = assertSafeId(taskId, '任务编号')
    const safeUploadId = assertSafeId(uploadId, '上传编号')
    if (!chunk?.length) throw new Error('PDF 分片内容为空')
    const numericOffset = Number(offset)
    if (!Number.isInteger(numericOffset) || numericOffset < 0) {
      throw new Error('PDF 分片偏移量无效')
    }
    const uploadsDir = path.join(this.bookDir(safeId), 'uploads')
    await fs.mkdir(uploadsDir, { recursive: true })
    const partFile = path.join(uploadsDir, `${safeUploadId}.part`)
    const flags = numericOffset === 0 ? 'w' : 'r+'
    let fh
    try {
      fh = await fs.open(partFile, flags, 0o600)
    } catch (err) {
      if (err?.code === 'ENOENT' && numericOffset > 0) {
        throw new Error('PDF 上传会话不存在或已过期，请重试')
      }
      throw err
    }
    try {
      await fh.write(chunk, 0, chunk.length, numericOffset)
    } finally {
      await fh.close()
    }
    return {
      ok: true,
      taskId: safeId,
      uploadId: safeUploadId,
      offset: numericOffset,
      received: numericOffset + chunk.length,
      totalBytes: Number(totalBytes) || undefined,
    }
  }

  async commitPdfUpload(taskId, { uploadId, sha256 = '', totalBytes = 0 } = {}) {
    const safeId = assertSafeId(taskId, '任务编号')
    const safeUploadId = assertSafeId(uploadId, '上传编号')
    const uploadsDir = path.join(this.bookDir(safeId), 'uploads')
    const partFile = path.join(uploadsDir, `${safeUploadId}.part`)
    const st = await fs.stat(partFile).catch(() => null)
    if (!st?.isFile() || st.size <= 0) {
      throw new Error('PDF 上传临时文件缺失或为空')
    }
    if (totalBytes && Number(totalBytes) !== st.size) {
      await fs.unlink(partFile).catch(() => {})
      throw new Error(`PDF 分片总大小不匹配（期望 ${totalBytes} 字节，实收 ${st.size} 字节）`)
    }
    const actualDigest = await hashFileSha256(partFile)
    if (sha256 && actualDigest !== sha256) {
      await fs.unlink(partFile).catch(() => {})
      throw new Error('PDF 分片校验失败（SHA-256 不匹配）')
    }
    return this.savePdfFromFile(safeId, partFile, st.size, actualDigest)
  }

  async saveFolder(id, name) {
    return this.serialized(async () => {
      const state = await this.readLibraryState()
      const fName = String(name ?? '').trim()
      if (!fName) throw new Error('文件夹名称不能为空')
      const folderId = id || randomUUID()
      const idx = state.folders.findIndex(f => f.id === folderId)
      const entry = { id: folderId, name: fName, createdAt: idx >= 0 ? state.folders[idx].createdAt : new Date().toISOString() }
      if (idx >= 0) state.folders[idx] = entry
      else state.folders.push(entry)
      await writeAtomic(this.libraryFile, state)
      return entry
    })
  }

  async deleteFolder(id) {
    return this.serialized(async () => {
      const state = await this.readLibraryState()
      state.folders = state.folders.filter(f => f.id !== id)
      for (const meta of Object.values(state.itemMeta)) {
        if (!meta?.folderId) continue
        const list = String(meta.folderId).split(',').map(s => s.trim()).filter(Boolean)
        if (list.includes(id)) {
          meta.folderId = list.filter(x => x !== id).join(',') || null
        }
      }
      await writeAtomic(this.libraryFile, state)
      return { ok: true }
    })
  }

  async setItemMeta(id, patch) {
    return this.serialized(async () => {
      const state = await this.readLibraryState()
      const prev = state.itemMeta[id] ?? { folderId: null, hidden: false }
      const next = {
        id,
        folderId: patch.folderId !== undefined ? patch.folderId : prev.folderId,
        hidden: patch.hidden !== undefined ? Boolean(patch.hidden) : Boolean(prev.hidden),
      }
      state.itemMeta[id] = next
      await writeAtomic(this.libraryFile, state)
      return next
    })
  }

  async _cleanupOrphanBlobs(state) {
    const activeHashes = new Set(
      Object.values(state.manifest ?? {})
        .filter(m => m?.hasPdf && m.pdfSha256)
        .map(m => String(m.pdfSha256).toLowerCase()),
    )
    const entries = await fs.readdir(this.blobsPdfDir, { withFileTypes: true }).catch(() => [])
    let removedFiles = 0
    let freedBytes = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.pdf')) continue
      const digest = entry.name.slice(0, -4).toLowerCase()
      if (activeHashes.has(digest)) continue
      const full = path.join(this.blobsPdfDir, entry.name)
      const st = await fs.lstat(full).catch(() => null)
      await fs.unlink(full).catch(() => {})
      if (st?.isFile()) {
        removedFiles += 1
        freedBytes += st.size
      }
    }
    return { removedFiles, freedBytes }
  }

  async deleteTasks(ids = []) {
    const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map(id => assertSafeId(id, '任务编号')))]
    if (!cleanIds.length) return { ok: true, deletedTaskIds: [] }
    const deleteSet = new Set(cleanIds)
    return this.serialized(async () => {
      const state = await this.readLibraryState()
      const removedDocIds = new Set(
        state.documents.filter(d => deleteSet.has(d.id)).map(d => d.documentId).filter(Boolean),
      )
      state.documents = state.documents.filter(d => !deleteSet.has(d.id))
      for (const id of cleanIds) {
        if (state.manifest[id]?.documentId) removedDocIds.add(state.manifest[id].documentId)
        delete state.manifest[id]
        delete state.itemMeta[id]
      }
      await writeAtomic(this.libraryFile, state)

      for (const id of cleanIds) {
        await fs.rm(this.bookDir(id), { recursive: true, force: true }).catch(() => {})
      }

      const remainingDocIds = new Set(state.documents.map(d => d.documentId).filter(Boolean))
      const revisions = await readJson(this.revisionsFile, [])
      if (Array.isArray(revisions) && revisions.length) {
        const filtered = revisions.filter(r => (
          !deleteSet.has(r.taskId)
          && (!r.documentId || !removedDocIds.has(r.documentId) || remainingDocIds.has(r.documentId))
        ))
        if (filtered.length !== revisions.length) {
          await writeAtomic(this.revisionsFile, filtered)
        }
      }
      await this._cleanupOrphanBlobs(state)
      return { ok: true, deletedTaskIds: cleanIds }
    })
  }

  async cleanupStaleUploads({ maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    const entries = await fs.readdir(this.booksDir, { withFileTypes: true }).catch(() => [])
    let removedFiles = 0
    let freedBytes = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const uploadsDir = path.join(this.booksDir, entry.name, 'uploads')
      const files = await fs.readdir(uploadsDir, { withFileTypes: true }).catch(() => [])
      for (const f of files) {
        if (!f.isFile()) continue
        const full = path.join(uploadsDir, f.name)
        const st = await fs.lstat(full).catch(() => null)
        if (!st?.isFile()) continue
        if (maxAgeMs <= 0 || now - st.mtimeMs >= maxAgeMs) {
          await fs.unlink(full).catch(() => {})
          removedFiles += 1
          freedBytes += st.size
        }
      }
      const left = await fs.readdir(uploadsDir).catch(() => [])
      if (left.length === 0) await fs.rmdir(uploadsDir).catch(() => {})
    }
    return { removedFiles, freedBytes }
  }

  async pruneCache(options = {}) {
    const pdfPagesMaxBytes = options.pdfPagesMaxBytes ?? 80 * 1024 * 1024
    const pdfPagesMaxAgeMs = options.pdfPagesMaxAgeMs ?? 30 * 24 * 60 * 60 * 1000
    const uploadStats = await this.cleanupStaleUploads({
      maxAgeMs: options.uploadMaxAgeMs ?? 24 * 60 * 60 * 1000,
    })
    let removedFiles = uploadStats.removedFiles
    let freedBytes = uploadStats.freedBytes

    const bookEntries = await fs.readdir(this.booksDir, { withFileTypes: true }).catch(() => [])
    const state = await this.readLibraryState()
    const validIds = new Set([
      ...state.documents.map(d => d.id),
      ...Object.keys(state.manifest ?? {}),
    ])
    for (const entry of bookEntries) {
      if (!entry.isDirectory()) continue
      const bdir = path.join(this.booksDir, entry.name)
      if (options.removeOrphanBooks && !validIds.has(entry.name)) {
        const stats = await pathStats(bdir)
        await fs.rm(bdir, { recursive: true, force: true }).catch(() => {})
        removedFiles += stats.files
        freedBytes += stats.bytes
        continue
      }
      const res = await pruneDirByLru(path.join(bdir, 'pdf-pages'), {
        maxBytes: pdfPagesMaxBytes,
        maxAgeMs: pdfPagesMaxAgeMs,
        filePattern: /^page_\d+_dpi\d+(?:_w\d+)?\.(?:png|jpe?g)$/i,
      })
      removedFiles += res.deletedFiles
      freedBytes += res.freedBytes

      if (options.compactReadings !== false) {
        const readingFile = path.join(bdir, 'reading.json')
        const st = await fs.stat(readingFile).catch(() => null)
        if (st?.isFile()) {
          const doc = await readJson(readingFile, null).catch(() => null)
          if (doc && (doc.bookmarkBlocks !== undefined || doc.glossary !== undefined)) {
            await writeAtomic(readingFile, leanReadingDoc(doc))
            const nextSt = await fs.stat(readingFile).catch(() => null)
            if (nextSt?.isFile() && st.size > nextSt.size) {
              freedBytes += st.size - nextSt.size
            }
          }
        }
      }
    }
    const blobStats = await this._cleanupOrphanBlobs(state)
    removedFiles += blobStats.removedFiles
    freedBytes += blobStats.freedBytes
    return { ok: true, removedFiles, freedBytes }
  }

  async listPipelineNotices() {
    return sanitizeNotices(await readJson(this.noticesFile, []))
  }

  async replacePipelineNotices(list) {
    const clean = sanitizeNotices(list)
    await this.serialized(async () => {
      await writeAtomic(this.noticesFile, clean)
    })
    return clean
  }

  async pushState(payload = {}) {
    let deletedTaskIds = []
    if (Array.isArray(payload.deleteTaskIds) && payload.deleteTaskIds.length) {
      const delRes = await this.deleteTasks(payload.deleteTaskIds)
      deletedTaskIds = delRes.deletedTaskIds
    }
    const readingTitleUpdates = []
    let renamedBooks = 0
    await this.serialized(async () => {
      const state = await this.readLibraryState()
      if (Array.isArray(payload.folders)) state.folders = payload.folders
      if (payload.itemMeta && typeof payload.itemMeta === 'object') {
        state.itemMeta = { ...state.itemMeta, ...payload.itemMeta }
      }
      if (Array.isArray(payload.documentsMeta)) {
        for (const meta of payload.documentsMeta) {
          if (!meta?.id) continue
          const idx = state.documents.findIndex(d => d.id === meta.id)
          if (idx < 0) continue
          const prev = state.documents[idx]
          const nextName = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : prev.name
          const changed = nextName !== prev.name
            || (meta.author !== undefined && meta.author !== prev.author)
            || (meta.titleSource !== undefined && meta.titleSource !== prev.titleSource)
            || (meta.kind !== undefined && meta.kind !== prev.kind)
            || (meta.hasCover !== undefined && Boolean(meta.hasCover) !== Boolean(prev.hasCover))
            || (meta.coverPage !== undefined && meta.coverPage !== prev.coverPage)
            || (meta.coverSha256 !== undefined && meta.coverSha256 !== prev.coverSha256)
          if (!changed) continue
          if (nextName !== prev.name) {
            renamedBooks += 1
            readingTitleUpdates.push({ id: meta.id, title: nextName })
          }
          const hasCoverWanted = meta.hasCover !== undefined ? Boolean(meta.hasCover) : Boolean(prev.hasCover)
          const hasCoverAllowed = hasCoverWanted
            ? await this.hasAssetFile(meta.id, '__cover__.jpg')
            : false
          const nextHasCover = meta.hasCover !== undefined ? hasCoverAllowed : Boolean(prev.hasCover && hasCoverAllowed)
          state.documents[idx] = {
            ...prev,
            name: nextName,
            ...(meta.author !== undefined ? { author: meta.author } : {}),
            ...(meta.titleSource !== undefined ? { titleSource: meta.titleSource } : {}),
            ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
            ...(meta.legacyPaperFile !== undefined ? { legacyPaperFile: meta.legacyPaperFile } : {}),
            ...(meta.hasCover !== undefined ? {
              hasCover: nextHasCover,
              coverPage: meta.coverPage ?? null,
              coverSha256: nextHasCover ? (meta.coverSha256 ?? null) : null,
            } : {}),
          }
          if (state.manifest[meta.id]) {
            state.manifest[meta.id] = {
              ...state.manifest[meta.id],
              updatedAt: new Date().toISOString(),
              ...(meta.hasCover !== undefined ? {
                hasCover: nextHasCover,
                coverPage: meta.coverPage ?? null,
                coverSha256: nextHasCover ? (meta.coverSha256 ?? null) : null,
              } : {}),
            }
          }
        }
      }
      await writeAtomic(this.libraryFile, state)
    })
    for (const upd of readingTitleUpdates) {
      try {
        const readingFile = path.join(this.bookDir(upd.id), 'reading.json')
        const doc = await readJson(readingFile, null)
        if (doc && doc.title !== upd.title) {
          await writeAtomic(readingFile, { ...doc, title: upd.title })
        }
      } catch {}
    }
    const progressRes = payload.progress
      ? await this.progressStore.merge(payload.progress)
      : { merged: 0 }
    const bookmarkRes = payload.bookmarksState
      ? await this.bookmarkStore.mergeState(payload.bookmarksState)
      : { merged: 0 }
    if (Array.isArray(payload.pipelineNotices)) {
      await this.replacePipelineNotices(payload.pipelineNotices)
    }
    return {
      ok: true,
      progressMerged: progressRes.merged,
      bookmarksMerged: bookmarkRes.merged,
      renamedBooks,
      deletedTaskIds,
    }
  }

  async pullState() {
    const [lib, progress, bookmarksState, revisions, pipelineNotices] = await Promise.all([
      this.readLibraryState(),
      this.progressStore.list(),
      this.bookmarkStore.exportState(),
      readJson(this.revisionsFile, []),
      this.listPipelineNotices(),
    ])
    const knownSet = new Set()
    const blobEntries = await fs.readdir(this.blobsPdfDir, { withFileTypes: true }).catch(() => [])
    for (const entry of blobEntries) {
      if (entry.isFile() && /^[a-f0-9]{64}\.pdf$/i.test(entry.name)) {
        knownSet.add(entry.name.slice(0, -4).toLowerCase())
      }
    }
    for (const [id, meta] of Object.entries(lib.manifest ?? {})) {
      if (!meta?.hasPdf || !meta.pdfSha256) continue
      const existsPdf = await fs.access(path.join(this.bookDir(id), 'source.pdf')).then(() => true).catch(() => false)
      if (existsPdf) knownSet.add(String(meta.pdfSha256).toLowerCase())
    }
    const manifest = {}
    for (const [id, meta] of Object.entries(lib.manifest ?? {})) {
      const hasCoverAsset = meta?.hasCover ? await this.hasAssetFile(id, '__cover__.jpg') : false
      manifest[id] = { ...meta, hasCoverAsset }
    }
    return {
      manifest,
      folders: lib.folders,
      itemMeta: lib.itemMeta,
      knownPdfSha256: [...knownSet],
      progress,
      bookmarksState,
      revisions: Array.isArray(revisions) ? revisions : [],
      pipelineNotices,
    }
  }

  async bookmarkDocument(source, view = 'original') {
    if (!source?.id) throw new Error('书签文档无效')
    const doc = await this.getReading(source.id)
    return {
      id: doc.documentId ?? `task:${source.id}`,
      title: doc.title,
      kind: doc.kind ?? 'paper',
      source: { kind: 'task', id: source.id },
      version: doc.version,
      blocks: doc.standaloneView === 'translation'
        ? (view === 'original' ? (doc.originalBlocks ?? []) : doc.blocks.map(b => ({ ...b, translation: b.text })))
        : doc.blocks,
    }
  }

  async readingMarks(source) {
    const doc = await this.bookmarkDocument(source, 'original')
    const [highlights, bookmarks] = await Promise.all([
      this.bookmarkStore.highlights({ documentId: doc.id }),
      this.bookmarkStore.list({ documentId: doc.id }),
    ])
    const marks = []
    const push = (item, kind) => {
      if (item.selector?.type !== 'TextQuoteSelector') return
      for (const slice of quoteSlices(doc.blocks, item.selector)) {
        marks.push({
          id: item.id,
          kind,
          style: item.style ?? 'highlight',
          color: item.color ?? 'gold',
          view: item.selector.view === 'translation' ? 'translation' : 'original',
          blockId: slice.blockId,
          quote: slice.quote,
          exact: item.quote,
          comment: item.comment ?? '',
        })
      }
    }
    for (const item of highlights) push(item, 'highlight')
    for (const item of bookmarks) {
      if (item.highlight !== false) push(item, 'bookmark')
    }
    return marks
  }

  async saveSelectionBookmark(args) {
    if (args.muteHighlight) return this.bookmarkStore.muteHighlight(args.muteHighlight)
    if (args.removeHighlight) return this.bookmarkStore.removeHighlight(args.removeHighlight)
    if (args.updateBookmark?.id) return this.bookmarkStore.update(args.updateBookmark.id, args.updateBookmark)
    if (args.remove) return this.bookmarkStore.remove(args.remove)
    const doc = await this.bookmarkDocument(args.source, args.selection?.view)
    return args.highlightOnly
      ? this.bookmarkStore.addHighlight(doc, args)
      : this.bookmarkStore.add(doc, args)
  }

  async correctReading(taskId, args = {}) {
    const safeId = assertSafeId(taskId, '任务编号')
    if (!['original', 'translation'].includes(args.view)) {
      throw new Error('编辑文本类型无效')
    }
    const replacement = String(args.text ?? '')
    if (!replacement.trim() || replacement.length > 100000) {
      throw new Error('段落须为1至100000字')
    }

    return this.serialized(async () => {
      const dir = this.bookDir(safeId)
      const readingFile = path.join(dir, 'reading.json')
      const doc = await readJson(readingFile, null)
      if (!doc) throw new Error('云端暂未同步该文献')
      if (args.version && doc.version !== args.version) {
        throw new Error('文档已由其他设备修改，请刷新后再保存')
      }

      const blocks = Array.isArray(doc.blocks) ? doc.blocks : []
      let targetIdx = blocks.findIndex(b => b.id === args.blockId)
      let beforeText = ''
      let updatedBlocks = blocks
      let updatedOriginal = doc.originalBlocks

      if (doc.standaloneView === 'translation' && args.view === 'original' && Array.isArray(doc.originalBlocks)) {
        const origIdx = doc.originalBlocks.findIndex(b => b.id === args.blockId)
        if (origIdx < 0) throw new Error('段落已经变化，请重新打开编辑')
        const origBlock = doc.originalBlocks[origIdx]
        const parsed = markdownBlocks(replacement)
        if (parsed.length !== 1 || parsed[0].type !== origBlock.type || parsed[0].level !== origBlock.level) {
          throw new Error('勘误须保留当前段落结构；章节和段落拆分需另行处理')
        }
        beforeText = origBlock.text
        updatedOriginal = doc.originalBlocks.map((b, i) => (i === origIdx ? { ...b, text: replacement } : b))
      } else {
        if (targetIdx < 0) throw new Error('段落已经变化，请重新打开编辑')
        const blk = blocks[targetIdx]
        const isTranslatedField = !doc.standaloneView && args.view === 'translation'
        const currentFieldText = isTranslatedField ? (blk.translation ?? '') : blk.text
        const parsed = markdownBlocks(replacement)
        if (parsed.length !== 1 || parsed[0].type !== blk.type || parsed[0].level !== blk.level) {
          throw new Error('勘误须保留当前段落结构；章节和段落拆分需另行处理')
        }
        beforeText = currentFieldText
        updatedBlocks = blocks.map((b, i) => {
          if (i !== targetIdx) return b
          return isTranslatedField ? { ...b, translation: replacement } : { ...b, text: replacement }
        })
      }

      const nextDoc = enrichReading({
        ...doc,
        blocks: updatedBlocks,
        originalBlocks: updatedOriginal,
        version: undefined,
        correctionCount: (doc.correctionCount ?? 0) + 1,
      })

      await writeAtomic(readingFile, nextDoc)

      const state = await this.readLibraryState()
      if (state.manifest[safeId]) {
        state.manifest[safeId].version = nextDoc.version
        state.manifest[safeId].updatedAt = new Date().toISOString()
        await writeAtomic(this.libraryFile, state)
      }

      const revisions = await readJson(this.revisionsFile, [])
      revisions.push({
        id: randomUUID(),
        taskId: safeId,
        documentId: doc.documentId,
        view: args.view,
        blockId: args.blockId,
        beforeText,
        afterText: replacement,
        reason: String(args.reason ?? '').slice(0, 2000),
        deviceName: String(args.deviceName ?? 'mobile').slice(0, 80),
        at: new Date().toISOString(),
      })
      await writeAtomic(this.revisionsFile, revisions.slice(-2000))
      return this.getReading(safeId)
    })
  }
}
