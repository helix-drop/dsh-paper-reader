import { searchBookContent } from './reading-core.js'

const DB_NAME = 'paper-reader-mobile-v1'
const DB_VERSION = 1

export const DEFAULT_SETTINGS = {
  serverUrl: '',
  token: '',
  deviceId: '',
  deviceName: '我的移动设备',
  shelfLayout: 'list', // list (书封+详情卡片) | grid (微信读书三列书封宫格)
  theme: 'paper', // white | paper | kraft | green | cyan | rose | gray | dark | night | eink
  deviceMode: 'phone', // phone | eink
  pageMode: 'paginated', // paginated | scroll
  pageTransition: 'slide', // slide (微信读书平滑平移) | none (瞬切无动画)
  columnLayout: 'auto', // auto (1 col on phone, 2 cols on wide >=860px) | single | double
  bilingualLayout: 'auto', // auto (stacked on phone <640px, side-by-side on wide >=640px) | stacked | parallel
  tapZoneMode: 'ergonomic', // ergonomic (thumb-friendly bottom-center next) | classic | bottomNext | keysOnly (stylus/Hanwang anti-mistouch)
  showPageTurnBar: false, // explicit bottom prev/next bar for stylus-only E-ink devices (e.g. Hanwang N10)
  fontSize: 19,
  fontWeight: 450, // 400 | 450 | 500 | 600
  lineHeight: 1.85,
  letterSpacing: 0.015,
  paraSpacing: 0.68,
  marginX: 22,
  textIndent: true, // 首行缩进两字符
  textAlign: 'justify', // justify | left
  brightness: 100, // 35..100
  fontFamily: 'serif', // serif | fzsong | cangjin | kaiti | fangsong | sans | hyqihei | yuan | literary | mono
  highlightStyle: 'highlight',
  highlightColor: 'gold',
  showFlyleaf: true,
  syncIncludePdfs: false, // false: 同步仅拉取 MD 正文与插图（PDF 按需）; true: 同时下载全量 PDF
  prevKeys: ['VolumeUp', 'PageUp', 'ArrowLeft', 'ArrowUp', 24, 92, 19, 21],
  nextKeys: ['VolumeDown', 'PageDown', 'ArrowRight', 'ArrowDown', 25, 93, 20, 22],
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of ['kv', 'books', 'assets', 'pdfs', 'progress', 'marks', 'outbox']) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, store === 'outbox' ? { keyPath: 'id' } : undefined)
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore(storeName, mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)
    let result
    Promise.resolve(fn(store))
      .then(val => {
        result = val
      })
      .catch(err => {
        try { tx.abort() } catch {}
        reject(err)
      })
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
  })
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export const offlineDb = {
  async getSettings() {
    const saved = await withStore('kv', 'readonly', s => reqPromise(s.get('settings'))).catch(() => null)
    const merged = { ...DEFAULT_SETTINGS, ...(saved || {}) }
    if (!merged.deviceId) {
      merged.deviceId = randomId()
      await this.saveSettings(merged).catch(() => {})
    }
    return merged
  },

  async saveSettings(patch) {
    const prev = await withStore('kv', 'readonly', s => reqPromise(s.get('settings'))).catch(() => ({}))
    const next = { ...DEFAULT_SETTINGS, ...(prev || {}), ...patch }
    await withStore('kv', 'readwrite', s => reqPromise(s.put(next, 'settings')))
    return next
  },

  async getLibraryCache() {
    return (await withStore('kv', 'readonly', s => reqPromise(s.get('library'))).catch(() => null))
      ?? { documents: [], folders: [], meta: {}, syncedAt: null }
  },

  async saveLibraryCache(payload) {
    return withStore('kv', 'readwrite', s => reqPromise(s.put({ ...payload, syncedAt: Date.now() }, 'library')))
  },

  async getSyncStatus() {
    return (await withStore('kv', 'readonly', s => reqPromise(s.get('sync_status'))).catch(() => null))
  },

  async saveSyncStatus(status) {
    return withStore('kv', 'readwrite', s => reqPromise(s.put(status, 'sync_status')))
  },

  async getBook(taskId) {
    return withStore('books', 'readonly', s => reqPromise(s.get(taskId))).catch(() => null)
  },

  async saveBook(taskId, reading) {
    return withStore('books', 'readwrite', s => reqPromise(s.put({ taskId, reading, cachedAt: Date.now() }, taskId)))
  },

  async listCachedBookIds() {
    const keys = await withStore('books', 'readonly', s => reqPromise(s.getAllKeys())).catch(() => [])
    return new Set(keys)
  },

  async listCachedPdfIds() {
    const keys = await withStore('pdfs', 'readonly', s => reqPromise(s.getAllKeys())).catch(() => [])
    return new Set(keys)
  },

  async deleteBook(taskId) {
    await withStore('books', 'readwrite', s => reqPromise(s.delete(taskId))).catch(() => {})
    await withStore('pdfs', 'readwrite', s => reqPromise(s.delete(taskId))).catch(() => {})
    await withStore('marks', 'readwrite', s => reqPromise(s.delete(`marks:${taskId}`))).catch(() => {})
    await withStore('assets', 'readwrite', s => new Promise((resolve, reject) => {
      const req = s.openCursor()
      const prefix = `${taskId}::`
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) { resolve(); return }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete()
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })).catch(() => {})
  },

  async getAsset(taskId, ref) {
    return withStore('assets', 'readonly', s => reqPromise(s.get(`${taskId}::${ref}`))).catch(() => null)
  },

  async saveAsset(taskId, ref, blob, mimeType, sha256 = null) {
    return withStore('assets', 'readwrite', s => reqPromise(s.put({ blob, mimeType, sha256, cachedAt: Date.now() }, `${taskId}::${ref}`)))
  },

  async deleteAsset(taskId, ref) {
    return withStore('assets', 'readwrite', s => reqPromise(s.delete(`${taskId}::${ref}`))).catch(() => {})
  },

  async getPdf(taskId) {
    return withStore('pdfs', 'readonly', s => reqPromise(s.get(taskId))).catch(() => null)
  },

  async savePdf(taskId, blob) {
    return withStore('pdfs', 'readwrite', s => reqPromise(s.put({ blob, cachedAt: Date.now() }, taskId)))
  },

  async getAllProgress() {
    const rows = await withStore('progress', 'readonly', async s => {
      const keys = await reqPromise(s.getAllKeys())
      const vals = await reqPromise(s.getAll())
      const out = {}
      keys.forEach((k, i) => { out[k] = vals[i] })
      return out
    }).catch(() => ({}))
    return rows
  },

  async saveProgress(documentId, entry) {
    if (!documentId) return
    const prev = await withStore('progress', 'readonly', s => reqPromise(s.get(documentId))).catch(() => null)
    if (prev && prev.updatedAt > entry.updatedAt) return prev
    await withStore('progress', 'readwrite', s => reqPromise(s.put(entry, documentId)))
    return entry
  },

  async getMarks(taskId) {
    return (await withStore('marks', 'readonly', s => reqPromise(s.get(`marks:${taskId}`))).catch(() => null)) ?? []
  },

  async saveMarks(taskId, marks) {
    return withStore('marks', 'readwrite', s => reqPromise(s.put(marks, `marks:${taskId}`)))
  },

  async getBookmarks() {
    return (await withStore('marks', 'readonly', s => reqPromise(s.get('all_bookmarks'))).catch(() => null)) ?? []
  },

  async saveBookmarks(list) {
    return withStore('marks', 'readwrite', s => reqPromise(s.put(list, 'all_bookmarks')))
  },

  async enqueueOutbox(action) {
    const item = { id: randomId(), createdAt: Date.now(), ...action }
    await withStore('outbox', 'readwrite', s => reqPromise(s.put(item)))
    return item
  },

  async listOutbox() {
    const items = await withStore('outbox', 'readonly', s => reqPromise(s.getAll())).catch(() => [])
    return items.sort((a, b) => a.createdAt - b.createdAt)
  },

  async removeOutbox(id) {
    return withStore('outbox', 'readwrite', s => reqPromise(s.delete(id)))
  },

  async searchAllBooks(query, { documents = [], meta = {}, includeHidden = false, limitBooks = 25, maxMatchesPerBook = 5 } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return { query: '', totalBooks: 0, totalMatches: 0, offlineOnly: true, results: [] }
    const docById = new Map((documents || []).map(d => [d.id, d]))
    const cachedIds = await this.listCachedBookIds()
    const results = []
    let totalMatches = 0
    for (const rawId of cachedIds) {
      const id = String(rawId || '')
      if (!id) continue
      if (!includeHidden && meta?.[id]?.hidden) continue
      const cached = await this.getBook(id)
      const reading = cached?.reading
      if (!reading) continue
      const docMeta = docById.get(id) || {}
      const name = docMeta.name || reading.title || id
      const author = docMeta.author || reading.metadata?.author?.zh || reading.metadata?.author?.source || ''
      const titleMatched = [name, author, docMeta.titleSource].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase())
      const res = searchBookContent(reading, q, { maxMatches: maxMatchesPerBook })
      if (!titleMatched && res.totalMatches === 0) continue
      totalMatches += res.totalMatches
      results.push({
        id,
        documentId: docMeta.documentId ?? reading.documentId ?? null,
        name,
        author,
        kind: docMeta.kind ?? reading.kind ?? 'paper',
        titleMatched,
        totalMatches: res.totalMatches,
        truncated: res.truncated,
        matches: res.matches,
      })
    }
    results.sort((a, b) => (b.totalMatches - a.totalMatches) || (Number(b.titleMatched) - Number(a.titleMatched)))
    return {
      query: q,
      totalBooks: results.length,
      totalMatches,
      offlineOnly: true,
      results: results.slice(0, limitBooks),
    }
  },
}
