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

async function fetchAndStoreCover(settings, taskId, wantSha, { signal } = {}) {
  const route = `/pipeline/tasks/${encodeURIComponent(taskId)}/cover${wantSha ? `?v=${encodeURIComponent(wantSha)}` : ''}`
  const res = await apiFetch(settings, route, { signal, timeoutMs: 12000 })
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) {
      coverUrlCache.set(taskId, wantSha ? { url: null, sha256: wantSha } : null)
    }
    return null
  }
  const blob = await res.blob()
  if (!blob?.size || (blob.type && !blob.type.startsWith('image/'))) return null
  await offlineDb.saveAsset(taskId, '__cover__.jpg', blob, blob.type || 'image/jpeg', wantSha || null).catch(() => {})
  const url = URL.createObjectURL(blob)
  coverUrlCache.set(taskId, { url, sha256: wantSha })
  return url
}

export const readerApi = {
  getCachedCoverUrl(taskId, expectedSha = '') {
    if (!coverUrlCache.has(taskId)) return undefined
    const cached = coverUrlCache.get(taskId)
    if (!cached) return expectedSha ? undefined : cached
    if (typeof cached === 'object') {
      if (expectedSha && cached.sha256 !== expectedSha) return undefined
      return cached.url
    }
    return cached
  },

  async syncBookCover(settings, doc, { signal } = {}) {
    const taskId = doc?.id
    if (!taskId) return false
    await offlineDb.deleteAsset(taskId, '__cover_page_1__').catch(() => {})
    if (doc.hasCover !== true) {
      await offlineDb.deleteAsset(taskId, '__cover__.jpg').catch(() => {})
      coverUrlCache.set(taskId, null)
      return false
    }
    const wantSha = String(doc.coverSha256 ?? '')
    const cached = await offlineDb.getAsset(taskId, '__cover__.jpg')
    if (cached?.blob && cached.blob.size > 0 && (!wantSha || cached.sha256 === wantSha)) {
      const cur = coverUrlCache.get(taskId)
      if (!cur || typeof cur !== 'object' || !cur.url || (wantSha && cur.sha256 !== wantSha)) {
        coverUrlCache.set(taskId, { url: URL.createObjectURL(cached.blob), sha256: cached.sha256 || wantSha || '' })
      }
      return false
    }
    if (coverUrlCache.get(taskId) === null || (coverUrlCache.get(taskId)?.url === null)) {
      coverUrlCache.delete(taskId)
    }
    if (signal?.aborted) return false
    try {
      return Boolean(await fetchAndStoreCover(settings, taskId, wantSha, { signal }))
    } catch {
      return false
    }
  },

  async loadCoverUrl(settings, taskId, { signal, hasCover = true, coverSha256 = '' } = {}) {
    if (!taskId || hasCover === false) return null
    const wantSha = String(coverSha256 ?? '')
    const mem = this.getCachedCoverUrl(taskId, wantSha)
    if (mem !== undefined) return mem
    if (signal?.aborted) return null
    const inflightKey = `${taskId}:${wantSha}`
    if (coverLoadPromises.has(inflightKey)) return coverLoadPromises.get(inflightKey)

    const job = (async () => {
      try {
        const cached = await offlineDb.getAsset(taskId, '__cover__.jpg')
        if (cached?.blob && cached.blob.size > 0 && (!wantSha || cached.sha256 === wantSha)) {
          const url = URL.createObjectURL(cached.blob)
          coverUrlCache.set(taskId, { url, sha256: cached.sha256 || wantSha })
          return url
        }
        if (signal?.aborted || !baseUrl(settings)) return null
        return await fetchAndStoreCover(settings, taskId, wantSha, { signal })
      } catch {
        return null
      } finally {
        coverLoadPromises.delete(inflightKey)
      }
    })()

    coverLoadPromises.set(inflightKey, job)
    return job
  },

  async testConnection(settings) {
    return apiJson(settings, '/sync/health')
  },

  async flushOutbox(settings, { onProgress, signal } = {}) {
    const items = await offlineDb.listOutbox()
    if (!items.length) return { flushed: 0, remaining: 0 }
    let flushed = 0
    for (let i = 0; i < items.length; i++) {
      if (signal?.aborted) break
      const item = items[i]
      onProgress?.({ phase: 'outbox', phaseLabel: '上传离线记录', done: i, total: items.length, pct: Math.round((i / items.length) * 15) })
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
    const prevLib = await offlineDb.getLibraryCache().catch(() => ({ documents: [] }))
    const prevById = new Map((prevLib?.documents ?? []).map(d => [d.id, d]))

    onProgress?.({ phase: 'outbox', phaseLabel: '上传离线笔记与进度', pct: 5, message: '检查待上传队列...' })
    await this.flushOutbox(settings, { onProgress, signal }).catch(() => {})

    onProgress?.({ phase: 'library', phaseLabel: '拉取云端书目与进度', pct: 12, message: '请求云端最新书目...' })
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
    let removedBooks = 0
    const cachedIds = await offlineDb.listCachedBookIds()
    for (const oldId of cachedIds) {
      if (!validIds.has(oldId)) {
        await offlineDb.deleteBook(oldId)
        removedBooks++
      }
    }

    let addedBooks = 0
    let renamedBooks = 0
    for (const doc of docs) {
      const prev = prevById.get(doc.id)
      if (!prev) addedBooks++
      else if (prev.name && doc.name && prev.name !== doc.name) renamedBooks++
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
        if (hasBlocks && sameVersion) {
          if (doc.name && cached.reading.title !== doc.name) {
            const updatedReading = { ...cached.reading, title: doc.name }
            await offlineDb.saveBook(doc.id, updatedReading)
            upToDate.push({ doc, reading: updatedReading })
          } else {
            upToDate.push({ doc, reading: cached.reading })
          }
        } else {
          toDownload.push(doc)
        }
      }
      skippedBooks = upToDate.length

      // Ensure inline Markdown images exist for already-cached books (only emit progress when missing assets exist)
      const assetCandidates = []
      for (const item of upToDate) {
        if (signal?.aborted) break
        const refs = collectLocalImageRefs(item.reading)
        if (!refs.length) continue
        let missing = false
        for (const ref of refs) {
          if (!(await offlineDb.getAsset(item.doc.id, ref))) { missing = true; break }
        }
        if (missing) assetCandidates.push(item)
      }
      if (assetCandidates.length > 0) {
        for (let i = 0; i < assetCandidates.length; i++) {
          if (signal?.aborted) break
          const item = assetCandidates[i]
          onProgress?.({
            phase: 'assets',
            phaseLabel: '补全内嵌插图',
            done: i,
            total: assetCandidates.length,
            skipped: skippedBooks,
            failed: 0,
            pct: Math.round(20 + (i / assetCandidates.length) * 15),
            title: item.doc.name || '',
          })
          await syncBookAssets(settings, item.doc.id, item.reading, { signal }).catch(() => {})
        }
      }

      const total = toDownload.length
      if (total > 0) {
        onProgress?.({
          phase: 'books',
          phaseLabel: '下载 MD 正文（含原文与译文）',
          done: 0,
          total,
          skipped: skippedBooks,
          failed: 0,
          pct: 25,
          title: toDownload[0]?.name || '',
        })
        let nextIdx = 0
        let finished = 0
        const maxBookPct = includePdfs ? 65 : 98
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
              const normalized = {
                ...reading,
                ...(doc.name ? { title: doc.name } : {}),
                ...(doc.version && !reading.version ? { version: doc.version } : {}),
              }
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
              phaseLabel: '下载 MD 正文（含原文与译文）',
              done: finished,
              total,
              skipped: skippedBooks,
              failed: failedBooks,
              pct: Math.round(25 + (finished / total) * (maxBookPct - 25)),
              title: doc.name || '',
            })
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, total) }, () => worker()))
      }
    }

    if (!signal?.aborted && docs.length) {
      let cIdx = 0
      const coverWorker = async () => {
        while (cIdx < docs.length && !signal?.aborted) {
          const doc = docs[cIdx++]
          await this.syncBookCover(settings, doc, { signal }).catch(() => {})
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, docs.length) }, () => coverWorker()))
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
        onProgress?.({
          phase: 'pdfs',
          phaseLabel: '下载原 PDF 文件',
          done: 0,
          total: pdfQueue.length,
          skipped: skippedPdfs,
          failed: 0,
          pct: 68,
          title: pdfQueue[0]?.name || '',
        })
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
            phaseLabel: '下载原 PDF 文件',
            done: i + 1,
            total: pdfQueue.length,
            skipped: skippedPdfs,
            failed: failedPdfs,
            pct: Math.round(68 + ((i + 1) / pdfQueue.length) * 30),
            title: doc.name || '',
          })
        }
      }
    }

    return {
      library: lib,
      progress: await offlineDb.getAllProgress(),
      bookmarks: bms.bookmarks ?? [],
      totalDocs: docs.length,
      addedBooks,
      renamedBooks,
      removedBooks,
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
