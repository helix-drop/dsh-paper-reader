import { offlineDb } from './offline-db.js'

function baseUrl(settings) {
  const raw = String(settings?.serverUrl ?? '').trim().replace(/\/+$/, '')
  return raw || ''
}

function authHeaders(settings, extra = {}) {
  const headers = { ...extra }
  const token = String(settings?.token ?? '').trim()
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function apiFetch(settings, route, options = {}) {
  const url = `${baseUrl(settings)}/api/paper-reader${route}`
  const res = await fetch(url, {
    ...options,
    headers: authHeaders(settings, options.headers ?? {}),
  })
  return res
}

async function apiJson(settings, route, options = {}) {
  const res = await apiFetch(settings, route, options)
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text }
  }
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`)
  return data
}

const assetUrlCache = new Map()
const coverUrlCache = new Map()
const coverLoadPromises = new Map()

export const readerApi = {
  getCachedCoverUrl(taskId) {
    return coverUrlCache.get(taskId)
  },

  async loadCoverUrl(settings, taskId) {
    if (!taskId) return null
    if (coverUrlCache.has(taskId)) return coverUrlCache.get(taskId)
    if (coverLoadPromises.has(taskId)) return coverLoadPromises.get(taskId)

    const job = (async () => {
      try {
        const cached = await offlineDb.getAsset(taskId, '__cover_page_1__')
        if (cached?.blob) {
          const url = URL.createObjectURL(cached.blob)
          coverUrlCache.set(taskId, url)
          return url
        }
        const res = await apiFetch(
          settings,
          `/pipeline/tasks/${encodeURIComponent(taskId)}/pdf-page/1?dpi=120`,
        )
        if (!res.ok) {
          if (res.status === 400 || res.status === 404 || res.status === 501) {
            coverUrlCache.set(taskId, null)
          }
          return null
        }
        const blob = await res.blob()
        await offlineDb.saveAsset(taskId, '__cover_page_1__', blob, blob.type || 'image/png').catch(() => {})
        const url = URL.createObjectURL(blob)
        coverUrlCache.set(taskId, url)
        return url
      } catch {
        return null
      } finally {
        coverLoadPromises.delete(taskId)
      }
    })()

    coverLoadPromises.set(taskId, job)
    return job
  },

  async testConnection(settings) {
    return apiJson(settings, '/sync/health')
  },

  async flushOutbox(settings) {
    const items = await offlineDb.listOutbox()
    if (!items.length) return { flushed: 0, remaining: 0 }
    let flushed = 0
    for (const item of items) {
      try {
        if (item.type === 'progress') {
          await apiJson(settings, '/pipeline/progress', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item.payload),
          })
        } else if (item.type === 'bookmark') {
          await apiJson(settings, '/pipeline/bookmarks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item.payload),
          })
        } else if (item.type === 'correction') {
          await apiJson(settings, `/pipeline/tasks/${encodeURIComponent(item.taskId)}/corrections`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item.payload),
          })
        }
        await offlineDb.removeOutbox(item.id)
        flushed++
      } catch {
        break
      }
    }
    const remaining = (await offlineDb.listOutbox()).length
    return { flushed, remaining }
  },

  async syncAll(settings) {
    await this.flushOutbox(settings).catch(() => {})
    const [lib, prog, bms] = await Promise.all([
      apiJson(settings, '/pipeline/library'),
      apiJson(settings, '/pipeline/progress').catch(() => ({ items: {} })),
      apiJson(settings, '/pipeline/bookmarks').catch(() => ({ bookmarks: [] })),
    ])
    await offlineDb.saveLibraryCache(lib)
    for (const [docId, entry] of Object.entries(prog.items ?? {})) {
      await offlineDb.saveProgress(docId, entry)
    }
    if (Array.isArray(bms.bookmarks)) {
      await offlineDb.saveBookmarks(bms.bookmarks)
    }
    return {
      library: lib,
      progress: await offlineDb.getAllProgress(),
      bookmarks: bms.bookmarks ?? [],
    }
  },

  async loadReading(settings, taskId, { preferOffline = false } = {}) {
    const cached = await offlineDb.getBook(taskId)
    if (preferOffline && cached?.reading) {
      return { reading: cached.reading, fromCache: true }
    }
    try {
      const reading = await apiJson(settings, `/pipeline/tasks/${encodeURIComponent(taskId)}/reading`)
      await offlineDb.saveBook(taskId, reading)
      return { reading, fromCache: false }
    } catch (err) {
      if (cached?.reading) return { reading: cached.reading, fromCache: true, offlineFallback: true }
      throw err
    }
  },

  async downloadBookOffline(settings, taskId, onProgress) {
    const reading = await apiJson(settings, `/pipeline/tasks/${encodeURIComponent(taskId)}/reading`)
    await offlineDb.saveBook(taskId, reading)
    const refs = new Set()
    const scan = text => {
      if (typeof text !== 'string' || !text.includes('![')) return
      for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const ref = m[1]
        if (ref && !/^(?:https?:|data:|blob:)/i.test(ref)) refs.add(ref)
      }
    }
    for (const b of reading.blocks ?? []) {
      scan(b.text)
      scan(b.translation)
      scan(b.sourceText)
    }
    for (const b of reading.originalBlocks ?? []) scan(b.text)

    const list = [...refs]
    for (let i = 0; i < list.length; i++) {
      const ref = list[i]
      const existing = await offlineDb.getAsset(taskId, ref)
      if (!existing) {
        try {
          const res = await apiFetch(settings, `/pipeline/tasks/${encodeURIComponent(taskId)}/asset?path=${encodeURIComponent(ref)}`)
          if (res.ok) {
            const blob = await res.blob()
            await offlineDb.saveAsset(taskId, ref, blob, blob.type || 'image/png')
          }
        } catch {}
      }
      onProgress?.(i + 1, list.length)
    }
    await this.loadCoverUrl(settings, taskId).catch(() => null)
    return { reading, assetsCount: list.length }
  },

  async loadAssetUrl(settings, taskId, ref) {
    const key = `${taskId}::${ref}`
    if (assetUrlCache.has(key)) return assetUrlCache.get(key)
    const cached = await offlineDb.getAsset(taskId, ref)
    if (cached?.blob) {
      const url = URL.createObjectURL(cached.blob)
      assetUrlCache.set(key, url)
      return url
    }
    const res = await apiFetch(settings, `/pipeline/tasks/${encodeURIComponent(taskId)}/asset?path=${encodeURIComponent(ref)}`)
    if (!res.ok) throw new Error('图片加载失败')
    const blob = await res.blob()
    await offlineDb.saveAsset(taskId, ref, blob, blob.type || 'image/png').catch(() => {})
    const url = URL.createObjectURL(blob)
    assetUrlCache.set(key, url)
    return url
  },

  async loadMarks(settings, taskId) {
    try {
      const res = await apiJson(settings, `/pipeline/highlights?kind=task&id=${encodeURIComponent(taskId)}`)
      const marks = res.marks ?? []
      await offlineDb.saveMarks(taskId, marks)
      return marks
    } catch {
      return offlineDb.getMarks(taskId)
    }
  },

  async saveProgress(settings, entry) {
    await offlineDb.saveProgress(entry.documentId, entry)
    try {
      const res = await apiJson(settings, '/pipeline/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
      })
      return res
    } catch {
      await offlineDb.enqueueOutbox({ type: 'progress', payload: entry })
      return { saved: true, offlineQueued: true, entry }
    }
  },

  async fetchServerProgress(settings, documentId) {
    try {
      const res = await apiJson(settings, `/pipeline/progress?documentId=${encodeURIComponent(documentId)}`)
      if (res?.entry) await offlineDb.saveProgress(documentId, res.entry)
      return res?.entry ?? null
    } catch {
      return null
    }
  },

  async postBookmarkAction(settings, payload) {
    try {
      return await apiJson(settings, '/pipeline/bookmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      await offlineDb.enqueueOutbox({ type: 'bookmark', payload })
      return { ok: true, offlineQueued: true }
    }
  },

  async submitCorrection(settings, taskId, payload) {
    try {
      const updated = await apiJson(settings, `/pipeline/tasks/${encodeURIComponent(taskId)}/corrections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      await offlineDb.saveBook(taskId, updated)
      return { reading: updated, offlineQueued: false }
    } catch (err) {
      if (String(err?.message || '').includes('结构') || String(err?.message || '').includes('注号')) {
        throw err
      }
      await offlineDb.enqueueOutbox({ type: 'correction', taskId, payload })
      return { reading: null, offlineQueued: true }
    }
  },

  async loadPdfPageImageUrl(settings, taskId, page, dpi = 180) {
    const res = await apiFetch(
      settings,
      `/pipeline/tasks/${encodeURIComponent(taskId)}/pdf-page/${encodeURIComponent(page)}?dpi=${dpi}`,
    )
    if (res.status === 501) {
      return { fallback: 'pdf' }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `PDF 第 ${page} 页加载失败`)
    }
    const blob = await res.blob()
    return { url: URL.createObjectURL(blob) }
  },

  async downloadFullPdf(settings, taskId) {
    const cached = await offlineDb.getPdf(taskId)
    if (cached?.blob) return URL.createObjectURL(cached.blob)
    const res = await apiFetch(settings, `/pipeline/tasks/${encodeURIComponent(taskId)}/source`)
    if (!res.ok) throw new Error('原 PDF 尚未同步到云端')
    const blob = await res.blob()
    await offlineDb.savePdf(taskId, blob)
    return URL.createObjectURL(blob)
  },
}
