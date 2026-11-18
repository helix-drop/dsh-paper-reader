import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { BookmarkStore, quoteSlices } from '../modules/pipeline/bookmarks.js'
import { ReadingProgressStore } from '../modules/pipeline/reading-progress.js'
import { enrichReading } from '../modules/pipeline/reader.js'
import { hash, markdownBlocks } from '../modules/pipeline/markdown.js'

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

export class CloudSyncStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir)
    this.booksDir = path.join(this.dataDir, 'books')
    this.libraryFile = path.join(this.dataDir, 'library.json')
    this.revisionsFile = path.join(this.dataDir, 'revisions.json')
    this.bookmarkStore = new BookmarkStore(path.join(this.dataDir, 'bookmarks-v1.json'))
    this.progressStore = new ReadingProgressStore(path.join(this.dataDir, 'reading-progress-v1.json'))
    this.queue = Promise.resolve()
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
        hasPdf: Boolean(state.manifest[d.id]?.hasPdf ?? d.hasPdf),
      })),
      folders: state.folders,
      meta: state.itemMeta,
    }
  }

  async getReading(taskId) {
    const dir = this.bookDir(taskId)
    const doc = await readJson(path.join(dir, 'reading.json'), null)
    if (!doc) throw new Error('云端暂未同步该文献内容')
    const state = await this.readLibraryState()
    const meta = state.manifest[taskId] ?? {}
    return {
      ...doc,
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
    await writeAtomic(path.join(dir, 'reading.json'), bundle.reading)

    return this.serialized(async () => {
      const state = await this.readLibraryState()
      const idx = state.documents.findIndex(d => d.id === taskId)
      if (idx >= 0) state.documents[idx] = bundle.libraryEntry
      else state.documents.unshift(bundle.libraryEntry)

      const prevManifest = state.manifest[taskId] ?? {}
      const hasPdf = await fs.access(path.join(dir, 'source.pdf')).then(() => true).catch(() => false)
      state.manifest[taskId] = {
        ...prevManifest,
        documentId: bundle.libraryEntry.documentId,
        version: bundle.reading.version,
        updatedAt: bundle.libraryEntry.updatedAt ?? new Date().toISOString(),
        hasPdf,
        pdfSha256: hasPdf ? prevManifest.pdfSha256 ?? null : null,
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
    await fs.rename(sourceTempFile, file)
    // Clear stale page cache when PDF changes
    await fs.rm(path.join(dir, 'pdf-pages'), { recursive: true, force: true }).catch(() => {})

    const digest = sha256 || await hashFileSha256(file)
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

  async pushState(payload = {}) {
    await this.serialized(async () => {
      const state = await this.readLibraryState()
      if (Array.isArray(payload.folders)) state.folders = payload.folders
      if (payload.itemMeta && typeof payload.itemMeta === 'object') {
        state.itemMeta = { ...state.itemMeta, ...payload.itemMeta }
      }
      await writeAtomic(this.libraryFile, state)
    })
    const progressRes = payload.progress
      ? await this.progressStore.merge(payload.progress)
      : { merged: 0 }
    const bookmarkRes = payload.bookmarksState
      ? await this.bookmarkStore.mergeState(payload.bookmarksState)
      : { merged: 0 }
    return {
      ok: true,
      progressMerged: progressRes.merged,
      bookmarksMerged: bookmarkRes.merged,
    }
  }

  async pullState() {
    const [lib, progress, bookmarksState, revisions] = await Promise.all([
      this.readLibraryState(),
      this.progressStore.list(),
      this.bookmarkStore.exportState(),
      readJson(this.revisionsFile, []),
    ])
    return {
      manifest: lib.manifest,
      folders: lib.folders,
      itemMeta: lib.itemMeta,
      progress,
      bookmarksState,
      revisions: Array.isArray(revisions) ? revisions : [],
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
