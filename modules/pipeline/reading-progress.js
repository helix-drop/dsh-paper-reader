import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return asNumber
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('阅读进度数据无效')
  const documentId = String(raw.documentId ?? '').trim()
  if (!documentId || documentId.length > 300) throw new Error('文档编号无效')
  const updatedAt = toTimestamp(raw.updatedAt)
  const percent = Number.isFinite(Number(raw.percent))
    ? Math.max(0, Math.min(100, Math.round(Number(raw.percent))))
    : 0
  const page = Number.isFinite(Number(raw.page)) && Number(raw.page) > 0
    ? Math.round(Number(raw.page))
    : null
  const totalPages = Number.isFinite(Number(raw.totalPages)) && Number(raw.totalPages) > 0
    ? Math.round(Number(raw.totalPages))
    : null
  const view = ['original', 'translation', 'bilingual'].includes(raw.view)
    ? raw.view
    : 'translation'

  return {
    documentId,
    taskId: raw.taskId ? String(raw.taskId).slice(0, 120) : '',
    blockId: raw.blockId ? String(raw.blockId).slice(0, 160) : '',
    view,
    version: raw.version ? String(raw.version).slice(0, 160) : '',
    page,
    totalPages,
    percent,
    title: raw.title ? String(raw.title).slice(0, 200) : '',
    deviceId: raw.deviceId ? String(raw.deviceId).slice(0, 120) : '',
    deviceName: raw.deviceName ? String(raw.deviceName).slice(0, 120) : '',
    updatedAt,
    updatedIso: new Date(updatedAt).toISOString(),
  }
}

export class ReadingProgressStore {
  constructor(file) {
    this.file = file
    this.queue = Promise.resolve()
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed?.schemaVersion !== 1 || !parsed.items || typeof parsed.items !== 'object') {
        throw new Error('invalid')
      }
      return parsed
    } catch (err) {
      if (err?.code === 'ENOENT') return { schemaVersion: 1, items: {} }
      throw new Error('阅读进度数据格式异常，保留原文件')
    }
  }

  async change(fn) {
    const job = this.queue.catch(() => {}).then(async () => {
      const state = await this.read()
      const value = await fn(state)
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        await fs.rename(temp, this.file)
      } finally {
        await fs.unlink(temp).catch(() => {})
      }
      return value
    })
    this.queue = job
    return job
  }

  async get(documentId) {
    const state = await this.read()
    return state.items[String(documentId ?? '')] ?? null
  }

  async list() {
    const state = await this.read()
    return { ...state.items }
  }

  async put(raw, { force = false } = {}) {
    const next = normalizeEntry(raw)
    return this.change(state => {
      const prev = state.items[next.documentId]
      if (!force && prev && prev.updatedAt > next.updatedAt) {
        return { saved: false, entry: prev, conflict: true }
      }
      state.items[next.documentId] = next
      return { saved: true, entry: next, conflict: false }
    })
  }

  async merge(entries) {
    if (!entries || typeof entries !== 'object') return { merged: 0, items: await this.list() }
    const list = Array.isArray(entries) ? entries : Object.values(entries)
    return this.change(state => {
      let merged = 0
      for (const raw of list) {
        let next
        try {
          next = normalizeEntry(raw)
        } catch {
          continue
        }
        const prev = state.items[next.documentId]
        if (!prev || next.updatedAt > prev.updatedAt) {
          state.items[next.documentId] = next
          merged++
        }
      }
      return { merged, items: { ...state.items } }
    })
  }
}
