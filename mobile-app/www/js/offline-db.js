const DB_NAME = 'paper-reader-mobile-v1'
const DB_VERSION = 1

export const DEFAULT_SETTINGS = {
  serverUrl: '',
  token: '',
  deviceId: '',
  deviceName: '我的移动设备',
  theme: 'paper', // paper | white | green | night | eink
  deviceMode: 'phone', // phone | eink
  pageMode: 'paginated', // paginated | scroll
  columnLayout: 'auto', // auto (1 col on phone, 2 cols on wide >=860px) | single | double
  bilingualLayout: 'auto', // auto (stacked on phone <640px, side-by-side on wide >=640px) | stacked | parallel
  tapZoneMode: 'ergonomic', // ergonomic (thumb-friendly bottom-center next) | classic | bottomNext | keysOnly (stylus/Hanwang anti-mistouch)
  showPageTurnBar: false, // explicit bottom prev/next bar for stylus-only E-ink devices (e.g. Hanwang N10)
  fontSize: 18,
  lineHeight: 1.78,
  marginX: 20,
  fontFamily: 'serif', // serif | sans | mono
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

  async deleteBook(taskId) {
    await withStore('books', 'readwrite', s => reqPromise(s.delete(taskId)))
    await withStore('pdfs', 'readwrite', s => reqPromise(s.delete(taskId))).catch(() => {})
  },

  async getAsset(taskId, ref) {
    return withStore('assets', 'readonly', s => reqPromise(s.get(`${taskId}::${ref}`))).catch(() => null)
  },

  async saveAsset(taskId, ref, blob, mimeType) {
    return withStore('assets', 'readwrite', s => reqPromise(s.put({ blob, mimeType, cachedAt: Date.now() }, `${taskId}::${ref}`)))
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
}
