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
  const { timeoutMs = 30000, signal: outerSignal, retries = 0, ...fetchOpts } = options
  if (outerSignal?.aborted) {
    throw Object.assign(new Error('已取消加载'), { name: 'AbortError', cancelled: true })
  }
  const url = `${baseUrl(settings)}/api/paper-reader${route}`
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    let timedOut = false
    let cancelled = false
    const onOuterAbort = () => {
      cancelled = true
      ctrl.abort()
    }
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          ctrl.abort()
        }, timeoutMs)
      : null
    try {
      const res = await fetch(url, {
        ...fetchOpts,
        signal: ctrl.signal,
        headers: authHeaders(settings, fetchOpts.headers ?? {}),
      })
      if (attempt < retries && res.status >= 500) continue
      return res
    } catch (err) {
      if (cancelled || outerSignal?.aborted) {
        throw Object.assign(new Error('已取消加载'), { name: 'AbortError', cancelled: true })
      }
      const msg = String(err?.message || '')
      if (timedOut || err?.name === 'AbortError') {
        lastErr = Object.assign(new Error('请求超时，请检查网络连接或服务器响应'), { transient: true })
      } else if (err instanceof TypeError || /failed to fetch|load failed|network/i.test(msg)) {
        lastErr = Object.assign(new Error('网络连接失败，请检查服务器地址或点击「同步」离线阅读'), { transient: true })
      } else {
        lastErr = err
      }
      if (attempt >= retries || !lastErr.transient) throw lastErr
    } finally {
      if (timer) clearTimeout(timer)
      outerSignal?.removeEventListener('abort', onOuterAbort)
    }
  }
  throw lastErr
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
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

const assetUrlCache = new Map()
const coverUrlCache = new Map()
const coverLoadPromises = new Map()

function collectLocalImageRefs(reading) {
  const refs = new Set()
  const scan = text => {
    if (typeof text !== 'string' || !text.includes('![')) return
    for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const ref = m[1]
      if (ref && !/^(?:https?:|data:|blob:)/i.test(ref)) refs.add(ref)
    }
  }
  for (const b of reading?.blocks ?? []) {
    scan(b.text)
    scan(b.translation)
    scan(b.sourceText)
  }
  for (const b of reading?.originalBlocks ?? []) scan(b.text)
  return [...refs]
}

async function syncBookAssets(settings, taskId, reading, { signal, onProgress } = {}) {
  const list = collectLocalImageRefs(reading)
  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) break
    const ref = list[i]
    const existing = await offlineDb.getAsset(taskId, ref)
    if (!existing) {
      try {
        const res = await apiFetch(
          settings,
          `/pipeline/tasks/${encodeURIComponent(taskId)}/asset?path=${encodeURIComponent(ref)}`,
          { signal, timeoutMs: 25000 },
        )
        if (res.ok) {
          const blob = await res.blob()
          await offlineDb.saveAsset(taskId, ref, blob, blob.type || 'image/png')
        }
      } catch (err) {
        if (err?.cancelled) break
      }
    }
    onProgress?.(i + 1, list.length)
  }
  return list.length
}

export const readerApi = {
  getCachedCoverUrl(taskId) {
    return coverUrlCache.get(taskId)
  },

  async loadCoverUrl(settings, taskId, { signal } = {}) {
    if (!taskId) return null
    if (coverUrlCache.has(taskId)) return coverUrlCache.get(taskId)
    if (signal?.aborted) return null
    if (coverLoadPromises.has(taskId)) return coverLoadPromises.get(taskId)

    const job = (async () => {
      try {
        const cached = await offlineDb.getAsset(taskId, '__cover_page_1__')
        if (cached?.blob) {
          const url = URL.createObjectURL(cached.blob)
          coverUrlCache.set(taskId, url)
          return url
        }
        if (signal?.aborted) return null
        const res = await apiFetch(
          settings,
          `/pipeline/tasks/${encodeURIComponent(taskId)}/pdf-page/1?dpi=72&format=jpeg&maxWidth=360`,
          { signal, timeoutMs: 12000 },
        )
        if (!res.ok) {
          if (res.status === 400 || res.status === 404 || res.status === 501) {
            coverUrlCache.set(taskId, null)
          }
          return null
        }
        const blob = await res.blob()
        await offlineDb.saveAsset(taskId, '__cover_page_1__', blob, blob.type || 'image/jpeg').catch(() => {})
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

  async syncAll(settings, { onProgress, syncBooks = true, includePdfs = false, signal } = {}) {
    onProgress?.({ phase: 'meta', message: '正在上传离线笔记与进度...' })
    await this.flushOutbox(settings).catch(() => {})
    onProgress?.({ phase: 'meta', message: '正在同步云端书目...' })
    const [lib, prog, bms] = await Promise.all([
      apiJson(settings, '/pipeline/library', { timeoutMs: 25000, retries: 1, signal }),
      apiJson(settings, '/pipeline/progress', { timeoutMs: 20000, signal }).catch(() => ({ items: {} })),
      apiJson(settings, '/pipeline/bookmarks', { timeoutMs: 20000, signal }).catch(() => ({ bookmarks: [] })),
    ])
    await offlineDb.saveLibraryCache(lib)
    for (const [docId, entry] of Object.entries(prog.items ?? {})) {
      await offlineDb.saveProgress(docId, entry)
    }
    if (Array.isArray(bms.bookmarks)) {
      await offlineDb.saveBookmarks(bms.bookmarks)
    }

    const docs = Array.isArray(lib.documents) ? lib.documents : []
    const validIds = new Set(docs.map(d => d.id))
    const cachedIds = await offlineDb.listCachedBookIds()
    for (const oldId of cachedIds) {
      if (!validIds.has(oldId)) await offlineDb.deleteBook(oldId)
    }

    let syncedBooks = 0
    let skippedBooks = 0
    let failedBooks = 0

    if (syncBooks && docs.length) {
      const toDownload = []
      const upToDate = []
      for (const doc of docs) {
        const cached = await offlineDb.getBook(doc.id)
        const hasBlocks = Boolean(cached?.reading?.blocks?.length)
        const sameVersion = doc.version
          ? cached?.reading?.version === doc.version
          : (!doc.updatedAt || cached?.reading?.updatedAt === doc.updatedAt)
        if (hasBlocks && sameVersion) upToDate.push({ doc, reading: cached.reading })
        else toDownload.push(doc)
      }
      skippedBooks = upToDate.length

      // Ensure inline Markdown images exist for already-cached books (no PDFs downloaded)
      for (const item of upToDate) {
        if (signal?.aborted) break
        if (collectLocalImageRefs(item.reading).length) {
          await syncBookAssets(settings, item.doc.id, item.reading, { signal }).catch(() => {})
        }
      }

      const total = toDownload.length
      if (total > 0) {
        onProgress?.({ phase: 'books', done: 0, total, skipped: skippedBooks, failed: 0, title: toDownload[0]?.name || '' })
        let nextIdx = 0
        let finished = 0
        const worker = async () => {
          while (nextIdx < total) {
            if (signal?.aborted) return
            const doc = toDownload[nextIdx++]
            try {
              const reading = await apiJson(
                settings,
                `/pipeline/tasks/${encodeURIComponent(doc.id)}/reading?lean=1`,
                { timeoutMs: 60000, retries: 1, signal },
              )
              const normalized = doc.version && !reading.version ? { ...reading, version: doc.version } : reading
              await offlineDb.saveBook(doc.id, normalized)
              await syncBookAssets(settings, doc.id, normalized, { signal }).catch(() => {})
              syncedBooks++
            } catch (err) {
              if (err?.cancelled) return
              failedBooks++
            }
            finished++
            onProgress?.({
              phase: 'books',
              done: finished,
              total,
              skipped: skippedBooks,
              failed: failedBooks,
              title: doc.name || '',
            })
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, total) }, () => worker()))
      }
    }

    let syncedPdfs = 0
    let skippedPdfs = 0
    let failedPdfs = 0

    if (includePdfs && !signal?.aborted) {
      const pdfDocs = docs.filter(d => d.hasPdf !== false)
      const pdfQueue = []
      for (const doc of pdfDocs) {
        const cachedPdf = await offlineDb.getPdf(doc.id)
        if (cachedPdf?.blob) skippedPdfs++
        else pdfQueue.push(doc)
      }
      if (pdfQueue.length > 0) {
        onProgress?.({ phase: 'pdfs', done: 0, total: pdfQueue.length, skipped: skippedPdfs, failed: 0, title: pdfQueue[0]?.name || '' })
        for (let i = 0; i < pdfQueue.length; i++) {
          if (signal?.aborted) break
          const doc = pdfQueue[i]
          try {
            const res = await apiFetch(
              settings,
              `/pipeline/tasks/${encodeURIComponent(doc.id)}/source`,
              { signal, timeoutMs: 600000 },
            )
            if (res.status === 400 || res.status === 404) {
              skippedPdfs++
            } else if (!res.ok) {
              failedPdfs++
            } else {
              const blob = await res.blob()
              await offlineDb.savePdf(doc.id, blob)
              syncedPdfs++
            }
          } catch (err) {
            if (err?.cancelled || signal?.aborted) break
            failedPdfs++
          }
          onProgress?.({
            phase: 'pdfs',
            done: i + 1,
            total: pdfQueue.length,
            skipped: skippedPdfs,
            failed: failedPdfs,
            title: doc.name || '',
          })
        }
      }
    }

    return {
      library: lib,
      progress: await offlineDb.getAllProgress(),
      bookmarks: bms.bookmarks ?? [],
      syncedBooks,
      skippedBooks,
      failedBooks,
      syncedPdfs,
      skippedPdfs,
      failedPdfs,
    }
  },

  async loadReading(settings, taskId, { preferOffline = true, forceRefresh = false, signal } = {}) {
    const cached = await offlineDb.getBook(taskId)
    if (!forceRefresh && preferOffline && cached?.reading?.blocks?.length) {
      return { reading: cached.reading, fromCache: true }
    }
    try {
      const reading = await apiJson(
        settings,
        `/pipeline/tasks/${encodeURIComponent(taskId)}/reading?lean=1`,
        { timeoutMs: 60000, retries: 1, signal },
      )
      await offlineDb.saveBook(taskId, reading)
      return { reading, fromCache: false }
    } catch (err) {
      if (err?.cancelled) throw err
      if (cached?.reading?.blocks?.length) return { reading: cached.reading, fromCache: true, offlineFallback: true }
      throw err
    }
  },

  async downloadBookOffline(settings, taskId, onProgress) {
    const reading = await apiJson(
      settings,
      `/pipeline/tasks/${encodeURIComponent(taskId)}/reading?lean=1`,
      { timeoutMs: 60000, retries: 1 },
    )
    await offlineDb.saveBook(taskId, reading)
    const assetsCount = await syncBookAssets(settings, taskId, reading, { onProgress })
    return { reading, assetsCount }
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
    try {
      const res = await apiFetch(
        settings,
        `/pipeline/tasks/${encodeURIComponent(taskId)}/pdf-page/${encodeURIComponent(page)}?dpi=${dpi}&format=jpeg&maxWidth=1400`,
        { timeoutMs: 30000, retries: 1 },
      )
      if (res.status === 501) {
        return { fallback: 'pdf' }
      }
      if (!res.ok) {
        const cachedPdf = await offlineDb.getPdf(taskId)
        if (cachedPdf?.blob) return { fallback: 'pdf' }
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `PDF 第 ${page} 页加载失败`)
      }
      const blob = await res.blob()
      return { url: URL.createObjectURL(blob) }
    } catch (err) {
      const cachedPdf = await offlineDb.getPdf(taskId)
      if (cachedPdf?.blob) return { fallback: 'pdf' }
      throw err
    }
  },

  async downloadFullPdf(settings, taskId, { signal } = {}) {
    const cached = await offlineDb.getPdf(taskId)
    if (cached?.blob) return URL.createObjectURL(cached.blob)
    const res = await apiFetch(
      settings,
      `/pipeline/tasks/${encodeURIComponent(taskId)}/source`,
      { timeoutMs: 600000, signal },
    )
    if (!res.ok) throw new Error('原 PDF 尚未同步到云端')
    const blob = await res.blob()
    await offlineDb.savePdf(taskId, blob)
    return URL.createObjectURL(blob)
  },

  async searchLibrary(settings, query, { documents = [], meta = {}, includeHidden = false, signal } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return { query: '', totalBooks: 0, totalMatches: 0, results: [] }
    const local = await offlineDb.searchAllBooks(q, { documents, meta, includeHidden })
    const isNative = typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.())
    if (!baseUrl(settings) && isNative) return local
    try {
      const qs = `q=${encodeURIComponent(q)}${includeHidden ? '&includeHidden=1' : ''}&limitBooks=25&maxMatches=5`
      const remote = await apiJson(settings, `/pipeline/search?${qs}`, { timeoutMs: 8000, retries: 0, signal })
      const merged = new Map()
      for (const item of local.results ?? []) merged.set(item.id, item)
      for (const item of remote.results ?? []) {
        const existing = merged.get(item.id)
        if (!existing || item.totalMatches > existing.totalMatches || !existing.matches?.length) {
          merged.set(item.id, item)
        }
      }
      const list = [...merged.values()].sort((a, b) => (b.totalMatches - a.totalMatches) || (Number(b.titleMatched) - Number(a.titleMatched)))
      return {
        query: q,
        totalBooks: Math.max(local.totalBooks, remote.totalBooks ?? list.length),
        totalMatches: list.reduce((s, x) => s + (x.totalMatches || 0), 0),
        offlineOnly: false,
        results: list.slice(0, 25),
      }
    } catch {
      return local
    }
  },
}
