import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { hash, imageReferences, markdownBlocks } from './markdown.js'
import { replaceBlock } from './reader.js'
import { checkMarkdownPair } from './markdown.js'
import { resolveWorkspaceAsset } from '../../shared/workspace.js'
import { taskSourcePdf } from './source-map.js'
import { atomic, exists, json } from './tasks/shared.js'

const SYNC_CONFIG_FILE = '.pipeline/cloud-sync.json'
const PDF_CHUNK_BYTES = 8 * 1024 * 1024
const pdfHashCache = new Map()

async function hashFileStream(filePath, size, mtimeMs) {
  const cacheKey = `${filePath}:${size}:${mtimeMs}`
  const cached = pdfHashCache.get(cacheKey)
  if (cached) return cached
  const digest = await new Promise((resolve, reject) => {
    const hasher = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hasher.update(chunk))
    stream.on('end', () => resolve(hasher.digest('hex')))
    stream.on('error', reject)
  })
  if (pdfHashCache.size > 200) pdfHashCache.clear()
  pdfHashCache.set(cacheKey, digest)
  return digest
}

function assetMime(filePath) {
  if (/\.png$/i.test(filePath)) return 'image/png'
  if (/\.gif$/i.test(filePath)) return 'image/gif'
  if (/\.webp$/i.test(filePath)) return 'image/webp'
  return 'image/jpeg'
}

export function normalizeCloudUrl(url) {
  const raw = String(url ?? '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('云服务器地址格式无效，请填写完整 http(s):// 地址')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('云服务器地址必须以 http:// 或 https:// 开头')
  }
  return parsed.toString().replace(/\/+$/, '')
}

export async function readCloudSyncConfig(root) {
  const file = path.join(root, SYNC_CONFIG_FILE)
  const saved = await json(file, {})
  const cloudUrl = String(saved.cloudUrl ?? '')
  const token = String(saved.token ?? '')
  const autoSyncExplicit = Boolean(saved.autoSyncExplicit)
  return {
    cloudUrl,
    token,
    deviceName: String(saved.deviceName ?? 'PC DSH 主机'),
    includePdf: saved.includePdf !== undefined ? Boolean(saved.includePdf) : true,
    autoSync: autoSyncExplicit
      ? Boolean(saved.autoSync)
      : (saved.autoSync === true || Boolean(cloudUrl && token)),
    autoSyncExplicit,
    lastSyncAt: saved.lastSyncAt ?? null,
    lastResult: saved.lastResult ?? null,
    lastError: saved.lastError ?? null,
  }
}

export async function saveCloudSyncConfig(root, patch = {}) {
  const prev = await readCloudSyncConfig(root)
  const cloudUrl = patch.cloudUrl !== undefined
    ? normalizeCloudUrl(patch.cloudUrl)
    : prev.cloudUrl
  let token = prev.token
  if (patch.clearToken === true) token = ''
  else if (typeof patch.token === 'string' && patch.token.trim()) token = patch.token.trim()

  const autoSyncExplicit = patch.autoSync !== undefined ? true : prev.autoSyncExplicit
  const autoSync = patch.autoSync !== undefined
    ? Boolean(patch.autoSync)
    : (autoSyncExplicit ? prev.autoSync : (prev.autoSync || Boolean(cloudUrl && token)))

  const next = {
    cloudUrl,
    token,
    deviceName: typeof patch.deviceName === 'string' && patch.deviceName.trim()
      ? patch.deviceName.trim().slice(0, 80)
      : prev.deviceName,
    includePdf: patch.includePdf !== undefined ? Boolean(patch.includePdf) : prev.includePdf,
    autoSync,
    autoSyncExplicit,
    lastSyncAt: patch.lastSyncAt !== undefined ? patch.lastSyncAt : prev.lastSyncAt,
    lastResult: patch.lastResult !== undefined ? patch.lastResult : prev.lastResult,
    lastError: patch.lastError !== undefined ? patch.lastError : prev.lastError,
  }
  await atomic(path.join(root, SYNC_CONFIG_FILE), next)
  return publicSyncStatus(next)
}

export function publicSyncStatus(config) {
  return {
    cloudUrl: config.cloudUrl,
    hasToken: Boolean(config.token),
    deviceName: config.deviceName,
    includePdf: config.includePdf,
    autoSync: config.autoSync,
    configured: Boolean(config.cloudUrl && config.token),
    lastSyncAt: config.lastSyncAt,
    lastResult: config.lastResult,
    lastError: config.lastError,
  }
}

async function collectReadingAssets(manager, t, reading) {
  const refs = new Set()
  const scan = text => {
    if (typeof text !== 'string' || !text.includes('![')) return
    for (const m of imageReferences(text)) {
      const ref = m.reference
      if (!ref || /^(?:https?:|data:|blob:)/i.test(ref)) continue
      refs.add(ref)
    }
  }
  for (const b of reading.blocks ?? []) {
    scan(b.text)
    scan(b.translation)
    scan(b.sourceText)
  }
  for (const b of reading.originalBlocks ?? []) scan(b.text)
  if (!refs.size) return []

  const original = t.legacy
    ? (t.legacy.artifacts.readingPath ?? t.legacy.artifacts.original)
    : await manager.original(t).catch(() => null)
  if (!original) return []
  const base = await fs.realpath(path.dirname(original)).catch(() => null)
  if (!base) return []

  const allowedRoots = (await Promise.all(
    [manager.root, manager.readingRoot, manager.publishRoot]
      .filter(Boolean)
      .map(r => fs.realpath(r).catch(() => null)),
  )).filter(Boolean)
  const assets = []
  for (const ref of refs) {
    try {
      const wanted = resolveWorkspaceAsset(manager.root, base, ref)
      const real = await fs.realpath(wanted)
      if (!allowedRoots.some(r => real.startsWith(r + path.sep))) continue
      if (!/\.(png|jpe?g|gif|webp)$/i.test(real)) continue
      const bytes = await fs.readFile(real)
      assets.push({
        ref,
        mimeType: assetMime(real),
        sha256: hash(bytes),
        dataBase64: bytes.toString('base64'),
      })
    } catch { /* 缺失的局部图片不阻断整书推送 */ }
  }
  return assets
}

export async function exportSyncBundle(manager, taskId, { includePdfMeta = true } = {}) {
  const t = await manager.get(taskId)
  const reading = await manager.reading(taskId)
  const assets = await collectReadingAssets(manager, t, reading)
  let pdfMeta = { available: false, sha256: null, bytes: 0, filePath: null }
  if (includePdfMeta) {
    const pdfFile = await taskSourcePdf(manager, t).catch(() => null)
    if (pdfFile && await exists(pdfFile)) {
      const st = await fs.stat(pdfFile).catch(() => null)
      if (st?.isFile()) {
        const digest = await hashFileStream(pdfFile, st.size, st.mtimeMs)
        pdfMeta = {
          available: true,
          sha256: digest,
          bytes: st.size,
          filePath: pdfFile,
        }
      }
    }
  }
  const ctx = await manager.correctionContext(t).catch(() => null)
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    libraryEntry: {
      id: t.id,
      documentId: t.documentId,
      name: t.documentTitle ?? t.name,
      kind: t.kind,
      ready: true,
      updatedAt: t.updatedAt ?? new Date().toISOString(),
      ...(t.paperImport
        ? {
          author: t.paperImport.metadata?.author?.zh ?? t.paperImport.metadata?.author?.source,
          titleSource: t.paperImport.metadata?.title?.source,
          legacyPaperFile: t.paperImport.file,
        }
        : {}),
    },
    reading,
    assets,
    revisions: ctx?.record?.revisions ?? [],
    pdf: {
      available: pdfMeta.available,
      sha256: pdfMeta.sha256,
      bytes: pdfMeta.bytes,
    },
    _pdfPath: pdfMeta.filePath,
  }
}

export async function applyRemoteCorrections(manager, remoteItems = []) {
  if (!Array.isArray(remoteItems) || !remoteItems.length) return { applied: 0, skipped: 0 }
  const tasks = await manager.library()
  const byDoc = new Map()
  for (const item of tasks) {
    if (item.documentId) byDoc.set(item.documentId, item.id)
    byDoc.set(item.id, item.id)
  }

  let applied = 0
  let skipped = 0
  for (const rev of remoteItems) {
    if (!rev?.id || !rev?.documentId || !['original', 'translation'].includes(rev.view)) {
      skipped++
      continue
    }
    const taskId = byDoc.get(rev.documentId) ?? byDoc.get(rev.taskId)
    if (!taskId) {
      skipped++
      continue
    }
    try {
      await manager.locked('correction:' + rev.documentId, async () => {
        const t = await manager.get(taskId)
        const ctx = await manager.correctionContext(t)
        const existing = new Set((ctx.record?.revisions ?? []).map(r => r.id))
        if (existing.has(rev.id)) {
          skipped++
          return
        }
        const key = rev.view === 'original' ? 'source' : 'translation'
        const text = ctx.texts[key]
        if (typeof text !== 'string') {
          skipped++
          return
        }
        let targetBlockId = rev.blockId
        const current = await manager.reading(taskId)
        if (!current.standaloneView && rev.view === 'translation') {
          const idx = current.blocks.findIndex(b => b.id === rev.blockId)
          targetBlockId = idx >= 0 ? markdownBlocks(text)[idx]?.id : rev.blockId
        }
        const blocks = markdownBlocks(text)
        const block = blocks.find(b => b.id === targetBlockId)
        if (!block) {
          skipped++
          return
        }
        // Only apply if current text still matches beforeText or hasn't diverged
        if (rev.beforeText && block.text !== rev.beforeText && block.text !== rev.afterText) {
          skipped++
          return
        }
        if (block.text === rev.afterText) {
          skipped++
          return
        }
        const next = replaceBlock(text, targetBlockId, rev.afterText)
        await fs.mkdir(ctx.directory, { recursive: true })
        const files = { ...ctx.record?.files }
        const baseFile = `${ctx.baseVersion}-${rev.view}-base.md`
        if (!await exists(path.join(ctx.directory, baseFile))) {
          await fs.writeFile(path.join(ctx.directory, baseFile), text, { flag: 'wx', mode: 0o600 })
        }
        files[rev.view] = baseFile
        ctx.texts[key] = next
        const record = {
          schemaVersion: 1,
          storageVersion: 2,
          documentId: t.documentId,
          baseVersion: ctx.baseVersion,
          files,
          texts: {
            ...ctx.record?.texts,
            ...Object.fromEntries(
              ['original', 'translation']
                .filter(v => v === rev.view || ctx.record?.files?.[v])
                .map(v => [v, ctx.texts[v === 'original' ? 'source' : 'translation']]),
            ),
          },
          revisions: [
            ...(ctx.record?.revisions ?? []),
            {
              id: rev.id,
              view: rev.view,
              blockId: rev.blockId,
              at: rev.at ?? new Date().toISOString(),
              beforeText: block.text,
              afterText: rev.afterText,
              beforeFingerprint: hash(text),
              afterFingerprint: hash(next),
              reason: String(rev.reason ?? '来自云端移动设备修订').slice(0, 2000),
              sourceDevice: rev.deviceName ?? 'mobile',
            },
          ],
          structuralCheck: ctx.texts.source && ctx.texts.translation
            ? checkMarkdownPair(ctx.texts.source, ctx.texts.translation)
            : null,
          semanticVerified: false,
        }
        await atomic(ctx.manifest, record)
        applied++
      })
    } catch {
      skipped++
    }
  }
  return { applied, skipped }
}

async function cloudFetch(fetchImpl, cloudUrl, token, route, options = {}) {
  const headers = {
    ...(options.headers ?? {}),
    authorization: `Bearer ${token}`,
  }
  const res = await fetchImpl(`${cloudUrl}${route}`, { ...options, headers })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text }
  }
  if (!res.ok) {
    let message = String(data?.error || '').trim()
    if (/^\s*</.test(message)) {
      const titleMatch = message.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      message = (titleMatch ? titleMatch[1] : message.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    }
    const err = new Error(message || `云端同步请求失败 (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

async function uploadPdfToCloud(fetchImpl, cloudUrl, token, taskId, pdfPath, sha256, bytesTotal, onProgress) {
  const encodedId = encodeURIComponent(taskId)
  if (bytesTotal <= PDF_CHUNK_BYTES) {
    const pdfBytes = await fs.readFile(pdfPath)
    return cloudFetch(
      fetchImpl,
      cloudUrl,
      token,
      `/api/paper-reader/sync/push-pdf/${encodedId}?sha256=${encodeURIComponent(sha256)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
        body: pdfBytes,
      },
    )
  }

  const uploadId = randomUUID()
  const fh = await fs.open(pdfPath, 'r')
  const buf = Buffer.allocUnsafe(PDF_CHUNK_BYTES)
  let fallbackToStream = false
  try {
    let offset = 0
    while (offset < bytesTotal) {
      const toRead = Math.min(PDF_CHUNK_BYTES, bytesTotal - offset)
      const { bytesRead } = await fh.read(buf, 0, toRead, offset)
      if (!bytesRead) break
      const slice = buf.subarray(0, bytesRead)
      try {
        await cloudFetch(
          fetchImpl,
          cloudUrl,
          token,
          `/api/paper-reader/sync/push-pdf-chunk/${encodedId}?uploadId=${encodeURIComponent(uploadId)}&offset=${offset}&total=${bytesTotal}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: slice,
          },
        )
      } catch (err) {
        if (offset === 0 && err?.status === 404) {
          fallbackToStream = true
          break
        }
        throw err
      }
      offset += bytesRead
      const pct = Math.min(100, Math.round((offset / bytesTotal) * 100))
      onProgress?.({ detail: `上传 PDF 分片 ${pct}% (${Math.round(offset / 1048576)}/${Math.round(bytesTotal / 1048576)} MB)` })
    }
  } finally {
    await fh.close()
  }

  if (fallbackToStream) {
    return cloudFetch(
      fetchImpl,
      cloudUrl,
      token,
      `/api/paper-reader/sync/push-pdf/${encodedId}?sha256=${encodeURIComponent(sha256)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(bytesTotal),
        },
        body: createReadStream(pdfPath),
        duplex: 'half',
      },
    )
  }

  onProgress?.({ detail: '校验并合并 PDF 分片...' })
  return cloudFetch(fetchImpl, cloudUrl, token, `/api/paper-reader/sync/commit-pdf/${encodedId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ uploadId, sha256, totalBytes: bytesTotal }),
  })
}

export async function syncWithCloud(manager, options = {}) {
  const config = await readCloudSyncConfig(manager.root)
  const cloudUrl = options.cloudUrl ? normalizeCloudUrl(options.cloudUrl) : config.cloudUrl
  const token = options.token || config.token
  if (!cloudUrl || !token) {
    throw new Error('请先配置轻量云服务器地址与同步密钥 (Token)')
  }

  const fetchImpl = options.fetch ?? manager.fetch ?? fetch
  const includePdf = options.includePdf !== undefined ? Boolean(options.includePdf) : config.includePdf
  const report = patch => {
    try { options.onProgress?.(patch) } catch {}
  }

  try {
    if (config.lastError) {
      await saveCloudSyncConfig(manager.root, { lastError: null }).catch(() => {})
    }
    // 1. Pull remote state (progress, bookmarks, corrections, manifest)
    report({ phase: 'pull', detail: '拉取云端进度、书签与勘误...' })
    const remote = await cloudFetch(fetchImpl, cloudUrl, token, '/api/paper-reader/sync/pull-state')
    const progressRes = await manager.progressStore.merge(remote.progress ?? {})
    const bookmarkRes = await manager.bookmarkStore.mergeState(remote.bookmarksState ?? {})
    const correctionRes = await applyRemoteCorrections(manager, remote.revisions ?? [])

    // 2. Push local ready library text bundles first
    const library = await manager.library()
    const remoteManifest = remote.manifest ?? {}
    let pushedBooks = 0
    let pushedPdfs = 0

    const targetIds = Array.isArray(options.taskIds) && options.taskIds.length
      ? new Set(options.taskIds)
      : null
    const items = targetIds ? library.filter(item => targetIds.has(item.id)) : library
    report({ phase: 'bundles', totalBooks: items.length, completedBooks: 0, detail: '同步文献正文与附件...' })

    const pdfQueue = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      report({ phase: 'bundles', currentBook: item.name ?? item.id, completedBooks: i, totalBooks: items.length })
      const bundle = await exportSyncBundle(manager, item.id, { includePdfMeta: includePdf })
      const remoteEntry = remoteManifest[item.id]
      const versionChanged = !remoteEntry || remoteEntry.version !== bundle.reading.version || options.force === true

      if (versionChanged) {
        const { _pdfPath, ...payload } = bundle
        await cloudFetch(fetchImpl, cloudUrl, token, '/api/paper-reader/sync/push-bundle', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
        })
        pushedBooks++
      }

      if (includePdf && bundle._pdfPath && bundle.pdf.sha256) {
        const needPdf = !remoteEntry?.pdfSha256 || remoteEntry.pdfSha256 !== bundle.pdf.sha256 || options.force === true
        if (needPdf) {
          pdfQueue.push({
            id: item.id,
            name: item.name ?? item.id,
            pdfPath: bundle._pdfPath,
            sha256: bundle.pdf.sha256,
            bytes: bundle.pdf.bytes,
          })
        }
      }
    }

    // 3. Push merged progress, bookmarksState, folders, and itemMeta immediately before large PDF uploads
    report({ phase: 'state', currentBook: '', completedBooks: items.length, totalBooks: items.length, detail: '同步进度、书签与分类...' })
    const [folders, itemMeta, progress, bookmarksState] = await Promise.all([
      manager.folders(),
      manager.itemMeta(),
      manager.progressStore.list(),
      manager.bookmarkStore.exportState(),
    ])
    await cloudFetch(fetchImpl, cloudUrl, token, '/api/paper-reader/sync/push-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        deviceName: config.deviceName,
        folders,
        itemMeta,
        progress,
        bookmarksState,
      }),
    })

    // 4. Upload needed PDFs (chunked for large files, resilient per book)
    const pdfErrors = []
    for (let i = 0; i < pdfQueue.length; i++) {
      const pdfJob = pdfQueue[i]
      report({
        phase: 'pdfs',
        currentBook: pdfJob.name,
        completedBooks: i,
        totalBooks: pdfQueue.length,
        detail: `准备上传原 PDF (${Math.max(1, Math.round(pdfJob.bytes / 1048576))} MB)...`,
      })
      try {
        await uploadPdfToCloud(
          fetchImpl,
          cloudUrl,
          token,
          pdfJob.id,
          pdfJob.pdfPath,
          pdfJob.sha256,
          pdfJob.bytes,
          p => report({ phase: 'pdfs', currentBook: pdfJob.name, completedBooks: i, totalBooks: pdfQueue.length, ...p }),
        )
        pushedPdfs++
      } catch (err) {
        pdfErrors.push(`${pdfJob.name}: ${String(err?.message ?? err)}`)
      }
    }

    const summary = {
      ok: pdfErrors.length === 0,
      syncedAt: new Date().toISOString(),
      libraryCount: library.length,
      pushedBooks,
      pushedPdfs,
      pulledProgress: progressRes.merged,
      pulledBookmarks: bookmarkRes.merged,
      appliedCorrections: correctionRes.applied,
      ...(pdfErrors.length ? { pdfErrors } : {}),
    }
    const errText = pdfErrors.length ? `部分 PDF 上传失败：${pdfErrors.join('；')}` : null
    await saveCloudSyncConfig(manager.root, {
      lastSyncAt: summary.syncedAt,
      lastResult: summary,
      lastError: errText,
    })
    if (pdfErrors.length) {
      throw new Error(errText)
    }
    return summary
  } catch (err) {
    await saveCloudSyncConfig(manager.root, {
      lastError: String(err?.message ?? err),
    }).catch(() => {})
    throw err
  }
}
