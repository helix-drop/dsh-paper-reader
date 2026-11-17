import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hash, imageReferences, markdownBlocks } from './markdown.js'
import { replaceBlock } from './reader.js'
import { checkMarkdownPair } from './markdown.js'
import { resolveWorkspaceAsset } from '../../shared/workspace.js'
import { taskSourcePdf } from './source-map.js'
import { atomic, exists, json } from './tasks/shared.js'

const SYNC_CONFIG_FILE = '.pipeline/cloud-sync.json'

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
  return {
    cloudUrl: String(saved.cloudUrl ?? ''),
    token: String(saved.token ?? ''),
    deviceName: String(saved.deviceName ?? 'PC DSH 主机'),
    includePdf: Boolean(saved.includePdf),
    autoSync: Boolean(saved.autoSync),
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

  const next = {
    cloudUrl,
    token,
    deviceName: typeof patch.deviceName === 'string' && patch.deviceName.trim()
      ? patch.deviceName.trim().slice(0, 80)
      : prev.deviceName,
    includePdf: patch.includePdf !== undefined ? Boolean(patch.includePdf) : prev.includePdf,
    autoSync: patch.autoSync !== undefined ? Boolean(patch.autoSync) : prev.autoSync,
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

  const allowedRoots = [manager.root, manager.readingRoot, manager.publishRoot].filter(Boolean)
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
        const bytes = await fs.readFile(pdfFile)
        pdfMeta = {
          available: true,
          sha256: hash(bytes),
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
    throw new Error(data?.error || `云端同步请求失败 (${res.status})`)
  }
  return data
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

  try {
    // 1. Pull remote state (progress, bookmarks, corrections, manifest)
    const remote = await cloudFetch(fetchImpl, cloudUrl, token, '/api/paper-reader/sync/pull-state')
    const progressRes = await manager.progressStore.merge(remote.progress ?? {})
    const bookmarkRes = await manager.bookmarkStore.mergeState(remote.bookmarksState ?? {})
    const correctionRes = await applyRemoteCorrections(manager, remote.revisions ?? [])

    // 2. Push local ready library books if new or updated
    const library = await manager.library()
    const remoteManifest = remote.manifest ?? {}
    let pushedBooks = 0
    let pushedPdfs = 0

    const targetIds = Array.isArray(options.taskIds) && options.taskIds.length
      ? new Set(options.taskIds)
      : null

    for (const item of library) {
      if (targetIds && !targetIds.has(item.id)) continue
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
          const pdfBytes = await fs.readFile(bundle._pdfPath)
          await cloudFetch(
            fetchImpl,
            cloudUrl,
            token,
            `/api/paper-reader/sync/push-pdf/${encodeURIComponent(item.id)}?sha256=${encodeURIComponent(bundle.pdf.sha256)}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/pdf' },
              body: pdfBytes,
            },
          )
          pushedPdfs++
        }
      }
    }

    // 3. Push merged progress, bookmarksState, folders, and itemMeta
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

    const summary = {
      ok: true,
      syncedAt: new Date().toISOString(),
      libraryCount: library.length,
      pushedBooks,
      pushedPdfs,
      pulledProgress: progressRes.merged,
      pulledBookmarks: bookmarkRes.merged,
      appliedCorrections: correctionRes.applied,
    }
    await saveCloudSyncConfig(manager.root, {
      lastSyncAt: summary.syncedAt,
      lastResult: summary,
      lastError: null,
    })
    return summary
  } catch (err) {
    await saveCloudSyncConfig(manager.root, {
      lastError: String(err?.message ?? err),
    }).catch(() => {})
    throw err
  }
}
