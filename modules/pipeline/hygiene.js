import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { atomic, exists, json } from './tasks/shared.js'
import { taskSourcePdf } from './source-map.js'

const DEFAULT_TRASH_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const DEFAULT_PDF_PAGES_MAX_BYTES = 80 * 1024 * 1024
const DEFAULT_PDF_PAGES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_PROBE_PAGES_MAX_BYTES = 40 * 1024 * 1024

function runExec(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60000 }, err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export async function cloneOrCopyFile(src, dst, mode = 0o600) {
  await fs.mkdir(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.${randomUUID()}.tmp`
  try {
    if (process.platform === 'darwin') {
      try {
        await runExec('cp', ['-c', src, tmp])
        await fs.chmod(tmp, mode).catch(() => {})
        await fs.rename(tmp, dst)
        return { cloned: true }
      } catch {
        await fs.unlink(tmp).catch(() => {})
      }
    }
    await fs.copyFile(src, tmp)
    await fs.chmod(tmp, mode).catch(() => {})
    await fs.rename(tmp, dst)
    return { cloned: false }
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

export async function streamFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => h.update(chunk))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

export async function pathStats(target) {
  let st
  try {
    st = await fs.lstat(target)
  } catch {
    return { bytes: 0, files: 0, exists: false }
  }
  if (st.isSymbolicLink()) return { bytes: 0, files: 0, exists: true }
  if (st.isFile()) return { bytes: st.size, files: 1, exists: true }
  if (!st.isDirectory()) return { bytes: 0, files: 0, exists: true }
  let bytes = 0
  let files = 0
  const stack = [target]
  while (stack.length) {
    const dir = stack.pop()
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        const fst = await fs.lstat(full).catch(() => null)
        if (fst?.isFile()) {
          bytes += fst.size
          files += 1
        }
      }
    }
  }
  return { bytes, files, exists: true }
}

export async function pruneDirByLru(dir, options = {}) {
  const maxBytes = Number(options.maxBytes ?? DEFAULT_PDF_PAGES_MAX_BYTES)
  const maxAgeMs = Number(options.maxAgeMs ?? DEFAULT_PDF_PAGES_MAX_AGE_MS)
  const filePattern = options.filePattern ?? /\.(png|jpe?g|webp|json)$/i
  const dryRun = Boolean(options.dryRun)
  const now = options.now ?? Date.now()

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const items = []
  for (const entry of entries) {
    if (!entry.isFile() || !filePattern.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    const st = await fs.lstat(full).catch(() => null)
    if (!st?.isFile()) continue
    items.push({ path: full, size: st.size, mtimeMs: st.mtimeMs })
  }

  let deletedFiles = 0
  let freedBytes = 0
  const kept = []
  for (const item of items) {
    if (maxAgeMs > 0 && now - item.mtimeMs > maxAgeMs) {
      if (!dryRun) await fs.unlink(item.path).catch(() => {})
      deletedFiles += 1
      freedBytes += item.size
    } else {
      kept.push(item)
    }
  }

  let totalBytes = kept.reduce((acc, item) => acc + item.size, 0)
  if (maxBytes >= 0 && totalBytes > maxBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const item of kept) {
      if (totalBytes <= maxBytes) break
      if (!dryRun) await fs.unlink(item.path).catch(() => {})
      totalBytes -= item.size
      deletedFiles += 1
      freedBytes += item.size
    }
  }
  return { deletedFiles, freedBytes, remainingBytes: totalBytes }
}

export class DeletedTasksStore {
  constructor(root) {
    this.file = path.join(root, '.pipeline/deleted-tasks.json')
    this.queue = Promise.resolve()
  }

  async serialized(fn) {
    const next = this.queue.catch(() => {}).then(fn)
    this.queue = next
    return next
  }

  async read() {
    const data = await json(this.file, null)
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') {
      return { schemaVersion: 1, entries: data.entries }
    }
    return { schemaVersion: 1, entries: {} }
  }

  async recordDeleted(taskOrId) {
    const id = typeof taskOrId === 'string' ? taskOrId : taskOrId?.id
    if (!id) return null
    const task = typeof taskOrId === 'object' && taskOrId ? taskOrId : { id }
    return this.serialized(async () => {
      const state = await this.read()
      state.entries[id] = {
        id,
        documentId: task.documentId ?? null,
        legacyKey: task.legacy?.key ?? null,
        paperFile: task.paperImport?.file ?? null,
        deletedAt: new Date().toISOString(),
        pendingCloudDelete: true,
      }
      await atomic(this.file, state)
      return state.entries[id]
    })
  }

  async deletedLegacyKeys() {
    const state = await this.read()
    const keys = new Set()
    for (const entry of Object.values(state.entries)) {
      if (entry?.legacyKey) keys.add(entry.legacyKey)
    }
    return keys
  }

  async pendingCloudDeletions() {
    const state = await this.read()
    return Object.values(state.entries)
      .filter(entry => entry?.id && entry.pendingCloudDelete)
      .map(entry => entry.id)
  }

  async ackCloudDeletions(ids = []) {
    const set = new Set(Array.isArray(ids) ? ids.filter(Boolean) : [])
    if (!set.size) return { acked: 0 }
    return this.serialized(async () => {
      const state = await this.read()
      let acked = 0
      for (const id of set) {
        if (state.entries[id]?.pendingCloudDelete) {
          state.entries[id].pendingCloudDelete = false
          state.entries[id].cloudDeletedAt = new Date().toISOString()
          acked += 1
        }
      }
      if (acked > 0) await atomic(this.file, state)
      return { acked }
    })
  }

  async clearLegacyKey(legacyKey) {
    if (!legacyKey) return { removed: 0 }
    return this.serialized(async () => {
      const state = await this.read()
      let removed = 0
      for (const [id, entry] of Object.entries(state.entries)) {
        if (entry?.legacyKey === legacyKey) {
          delete state.entries[id]
          removed += 1
        }
      }
      if (removed > 0) await atomic(this.file, state)
      return { removed }
    })
  }
}

export async function pruneTrash(root, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TRASH_MAX_AGE_MS
  const dryRun = Boolean(options.dryRun)
  const now = options.now ?? Date.now()
  const trashDir = path.join(root, '.pipeline/trash')
  const entries = await fs.readdir(trashDir, { withFileTypes: true }).catch(() => [])
  let removedDirs = 0
  let freedBytes = 0
  let removedFiles = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(trashDir, entry.name)
    const st = await fs.lstat(full).catch(() => null)
    if (!st) continue
    if (maxAgeMs > 0 && now - st.mtimeMs < maxAgeMs) continue
    const stats = await pathStats(full)
    if (!dryRun) await fs.rm(full, { recursive: true, force: true }).catch(() => {})
    removedDirs += 1
    freedBytes += stats.bytes
    removedFiles += stats.files
  }
  return { removedDirs, freedBytes, removedFiles }
}

export async function prunePublicGlossaryHistory(root, options = {}) {
  const keepLatest = Math.max(0, Number(options.keepLatest ?? 2))
  const dryRun = Boolean(options.dryRun)
  const histDir = path.join(root, '.pipeline/glossaries/history')
  const entries = await fs.readdir(histDir, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(histDir, entry.name)
    const st = await fs.lstat(full).catch(() => null)
    if (st?.isFile()) files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let removedFiles = 0
  let freedBytes = 0
  for (const item of files.slice(keepLatest)) {
    if (!dryRun) await fs.unlink(item.path).catch(() => {})
    removedFiles += 1
    freedBytes += item.size
  }
  return { removedFiles, freedBytes }
}

async function recordRemoval(target, category, label, dryRun, buckets) {
  const stats = await pathStats(target)
  if (!stats.exists) return 0
  if (!dryRun) await fs.rm(target, { recursive: true, force: true }).catch(() => {})
  if (stats.bytes > 0 || stats.files > 0) {
    buckets.push({ category, label, path: target, bytes: stats.bytes, files: stats.files })
  }
  return stats.bytes
}

export async function pruneTaskCaches(manager, t, options = {}) {
  if (!t?.id) return { freedBytes: 0, removedFiles: 0, items: [] }
  if (manager.active?.has(t.id) || ['running', 'interrupted'].includes(t.state)) {
    return { freedBytes: 0, removedFiles: 0, items: [], skipped: 'active' }
  }
  const mode = options.mode === 'compact' ? 'compact' : 'safe'
  const dryRun = Boolean(options.dryRun)
  const explicit = Boolean(options.explicit)
  const taskDir = manager.dir(t.id)
  const aiDir = manager.aiDir ? manager.aiDir(t) : path.join(taskDir, 'document/ai_convert')
  const label = `${t.name || t.id} (${t.id.slice(0, 8)})`
  const items = []

  const assembled = t.stages?.assemble?.state === 'done' || t.publication?.published === true
  const published = t.publication?.published === true
  const reviewPassed = t.review?.status === 'pass'
  let stuckCount = 1
  if (published) {
    stuckCount = 0
  } else if (assembled) {
    const stuck = manager.listStuckPages ? await manager.listStuckPages(t).catch(() => []) : []
    stuckCount = Array.isArray(stuck) ? stuck.length : 0
  }

  // 1. Delivery attempts, rollback snapshots & intermediate evidence
  if (published || (assembled && stuckCount === 0)) {
    const delivDir = path.join(aiDir, 'delivery')
    const chapters = await fs.readdir(delivDir, { withFileTypes: true }).catch(() => [])
    for (const ch of chapters) {
      if (!ch.isDirectory()) continue
      for (const sub of ['attempts', 'selected-before-merge', path.join('output', 'evidence')]) {
        await recordRemoval(path.join(delivDir, ch.name, sub), 'tasks/delivery/attempts+evidence', label, dryRun, items)
      }
    }
  }

  // 2. Harness request logs (including historical misplaced ai_convert/harness-requests)
  await recordRemoval(path.join(taskDir, 'harness-requests'), 'tasks/harness-requests', label, dryRun, items)
  await recordRemoval(path.join(aiDir, 'harness-requests'), 'tasks/harness-requests', label, dryRun, items)

  // 3. Stale review audit runs (keep active t.reviewAudit.auditDir)
  const activeAudit = t.reviewAudit?.auditDir
    ? await fs.realpath(t.reviewAudit.auditDir).catch(() => path.resolve(t.reviewAudit.auditDir))
    : null
  const runsDir = path.join(taskDir, 'review/audit/runs')
  const runEntries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [])
  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue
    const full = path.join(runsDir, runEntry.name)
    const real = await fs.realpath(full).catch(() => path.resolve(full))
    if (activeAudit && real === activeAudit) continue
    await recordRemoval(full, 'tasks/review/old-runs', `${label}/${runEntry.name.slice(0, 8)}`, dryRun, items)
  }

  // 4. Glossary history & orphan analysis/consolidation runs not in pipeline-receipt.json
  const gdir = path.join(taskDir, 'glossary')
  await recordRemoval(path.join(gdir, 'history'), 'tasks/glossary/history', label, dryRun, items)
  const receipt = await json(path.join(gdir, 'pipeline-receipt.json'), null)
  const referencedGlossary = new Set()
  for (const rel of Object.keys(receipt?.artifacts ?? {})) {
    const parts = rel.split(/[\\/]/).filter(Boolean)
    if (parts.length >= 2 && ['analysis', 'consolidation'].includes(parts[0])) {
      referencedGlossary.add(`${parts[0]}/${parts[1]}`)
    }
  }
  for (const job of Object.values(t.glossaryRuns ?? {})) {
    if (job?.directory) {
      const rel = path.relative(gdir, job.directory).split(path.sep).slice(0, 2).join('/')
      if (rel) referencedGlossary.add(rel)
    }
  }
  for (const kind of ['analysis', 'consolidation']) {
    const kd = path.join(gdir, kind)
    const hashes = await fs.readdir(kd, { withFileTypes: true }).catch(() => [])
    for (const h of hashes) {
      if (!h.isDirectory()) continue
      const key = `${kind}/${h.name}`
      const full = path.join(kd, h.name)
      if (!referencedGlossary.has(key)) {
        await recordRemoval(full, 'tasks/glossary/orphan-runs', `${label}/${kind}/${h.name.slice(0, 8)}`, dryRun, items)
      } else if (mode === 'compact' && published) {
        await recordRemoval(
          path.join(full, 'runs'),
          'tasks/glossary/published-runs',
          `${label}/${kind}/${h.name.slice(0, 8)}`,
          dryRun,
          items,
        )
      }
    }
  }

  // 5. Probe pages & pdf-pages caches
  const probeDir = path.join(taskDir, 'probe-pages')
  if (published || reviewPassed || explicit) {
    await recordRemoval(probeDir, 'tasks/probe-pages', label, dryRun, items)
  } else {
    const res = await pruneDirByLru(probeDir, {
      maxBytes: options.probePagesMaxBytes ?? DEFAULT_PROBE_PAGES_MAX_BYTES,
      maxAgeMs: DEFAULT_PDF_PAGES_MAX_AGE_MS,
      dryRun,
    })
    if (res.freedBytes > 0) {
      items.push({ category: 'tasks/probe-pages', label, path: probeDir, bytes: res.freedBytes, files: res.deletedFiles })
    }
  }

  const pdfPagesDir = path.join(taskDir, 'pdf-pages')
  if (explicit || mode === 'compact') {
    await recordRemoval(pdfPagesDir, 'tasks/pdf-pages', label, dryRun, items)
  } else {
    const res = await pruneDirByLru(pdfPagesDir, {
      maxBytes: options.pdfPagesMaxBytes ?? DEFAULT_PDF_PAGES_MAX_BYTES,
      maxAgeMs: DEFAULT_PDF_PAGES_MAX_AGE_MS,
      dryRun,
    })
    if (res.freedBytes > 0) {
      items.push({ category: 'tasks/pdf-pages', label, path: pdfPagesDir, bytes: res.freedBytes, files: res.deletedFiles })
    }
  }

  // 6. Compact mode extras (only for completed/published tasks with safe fallback)
  if (mode === 'compact') {
    if (published || (assembled && reviewPassed)) {
      const sourcePdf = await taskSourcePdf(manager, t).catch(() => null)
      const docPdf = path.join(manager.docDir ? manager.docDir(t) : path.join(taskDir, 'document'), 'source.pdf')
      const hasPdf = Boolean(
        (sourcePdf && await exists(sourcePdf)) || await exists(docPdf),
      )
      if (hasPdf) {
        await recordRemoval(path.join(aiDir, 'page_images'), 'tasks/page_images', label, dryRun, items)
      }
    }
    if (published) {
      await recordRemoval(path.join(taskDir, 'publication'), 'tasks/publication_bundle', label, dryRun, items)
      if (t.stages?.translationCheck?.state === 'done') {
        await recordRemoval(path.join(taskDir, 'translation-cli/runs'), 'tasks/translation-cli/runs', label, dryRun, items)
      }
    }
  }

  return {
    freedBytes: items.reduce((sum, x) => sum + x.bytes, 0),
    removedFiles: items.reduce((sum, x) => sum + x.files, 0),
    items,
  }
}

async function pruneLegacyBooks(root, options = {}) {
  const mode = options.mode === 'compact' ? 'compact' : 'safe'
  const dryRun = Boolean(options.dryRun)
  const bookRoot = path.join(root, 'Book')
  const items = []
  const entries = await fs.readdir(bookRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const bdir = path.join(bookRoot, entry.name)
    if (entry.name === '_tl_eval') {
      await recordRemoval(bdir, 'Book/_tl_eval', entry.name, dryRun, items)
      continue
    }
    if (entry.name.startsWith('_')) continue

    const bdeliv = path.join(bdir, 'ai_convert/delivery')
    const chapters = await fs.readdir(bdeliv, { withFileTypes: true }).catch(() => [])
    for (const ch of chapters) {
      if (!ch.isDirectory()) continue
      for (const sub of ['attempts', 'selected-before-merge', path.join('output', 'evidence')]) {
        await recordRemoval(path.join(bdeliv, ch.name, sub), 'Book/delivery/attempts+evidence', entry.name, dryRun, items)
      }
    }
    await recordRemoval(path.join(bdir, 'ocr_output'), 'Book/ocr_output', entry.name, dryRun, items)

    if (mode === 'compact') {
      const rootEntries = await fs.readdir(bdir).catch(() => [])
      const hasPdf = rootEntries.some(n => /\.pdf$/i.test(n))
      if (hasPdf) {
        await recordRemoval(path.join(bdir, 'ai_convert/page_images'), 'Book/page_images', entry.name, dryRun, items)
      }
    }
  }
  return items
}

export async function dedupeLargeFiles(root, options = {}) {
  if (process.platform !== 'darwin') {
    return { supported: false, clonedFiles: 0, potentialSavedBytes: 0, groups: [] }
  }
  const minBytes = Number(options.minBytes ?? 10 * 1024 * 1024)
  const dryRun = Boolean(options.dryRun)
  const bySize = new Map()
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        const st = await fs.lstat(full).catch(() => null)
        if (st?.isFile() && st.size >= minBytes) {
          const list = bySize.get(st.size) ?? []
          list.push({ path: full, size: st.size, ino: st.ino })
          bySize.set(st.size, list)
        }
      }
    }
  }

  let clonedFiles = 0
  let potentialSavedBytes = 0
  const groups = []
  for (const [size, entries] of bySize.entries()) {
    if (entries.length < 2) continue
    const byHash = new Map()
    for (const entry of entries) {
      const sha = await streamFileSha256(entry.path).catch(() => null)
      if (!sha) continue
      const group = byHash.get(sha) ?? []
      group.push(entry)
      byHash.set(sha, group)
    }
    for (const [sha, group] of byHash.entries()) {
      if (group.length < 2) continue
      // Prefer Book/ or uploads/ or document/source.pdf as canonical
      group.sort((a, b) => a.path.localeCompare(b.path))
      const canonical = group[0]
      const dupPaths = []
      for (const dup of group.slice(1)) {
        if (dup.ino === canonical.ino) continue
        if (!dryRun) {
          const st = await fs.stat(dup.path).catch(() => null)
          const res = await cloneOrCopyFile(canonical.path, dup.path, st ? (st.mode & 0o777) : 0o600)
          if (res.cloned) clonedFiles += 1
        } else {
          clonedFiles += 1
        }
        potentialSavedBytes += size
        dupPaths.push(path.relative(root, dup.path))
      }
      if (dupPaths.length) {
        groups.push({ sha256: sha.slice(0, 12), size, canonical: path.relative(root, canonical.path), clones: dupPaths })
      }
    }
  }
  return { supported: true, clonedFiles, potentialSavedBytes, groups }
}

export async function pruneWorkspace(manager, options = {}) {
  const mode = options.mode === 'compact' ? 'compact' : 'safe'
  const dryRun = Boolean(options.dryRun)
  const root = manager.root
  const tasksDir = path.join(root, '.pipeline/tasks')
  const items = []

  const taskIds = (await fs.readdir(tasksDir, { withFileTypes: true }).catch(() => []))
    .filter(e => e.isDirectory() && e.name !== 'uploads')
    .map(e => e.name)

  const referencedPaths = new Set()
  for (const tid of taskIds) {
    const t = await json(path.join(tasksDir, tid, 'task.json'), null)
    if (!t) continue
    for (const cand of [t.path, t.translationPath, t.review?.report, t.legacy?.artifacts?.sourcePdf]) {
      if (typeof cand === 'string' && cand) {
        referencedPaths.add(await fs.realpath(cand).catch(() => path.resolve(cand)))
      }
    }
    const taskRes = await pruneTaskCaches(manager, t, { mode, dryRun, explicit: true })
    items.push(...taskRes.items)
  }

  // Orphan uploads
  const uploadsDir = path.join(tasksDir, 'uploads')
  const uploadEntries = await fs.readdir(uploadsDir, { withFileTypes: true }).catch(() => [])
  for (const entry of uploadEntries) {
    const full = path.join(uploadsDir, entry.name)
    const real = await fs.realpath(full).catch(() => path.resolve(full))
    if (!referencedPaths.has(real)) {
      await recordRemoval(full, 'tasks/orphan-uploads', entry.name, dryRun, items)
    }
  }

  // Trash, backups, glossaries/history, imports/cleanup-*
  const trashRes = await pruneTrash(root, {
    maxAgeMs: options.trashMaxAgeMs ?? (dryRun ? 0 : (options.purgeTrash ? 0 : DEFAULT_TRASH_MAX_AGE_MS)),
    dryRun,
  })
  if (trashRes.freedBytes > 0) {
    items.push({ category: '.pipeline/trash', label: '回收站过期任务', path: path.join(root, '.pipeline/trash'), bytes: trashRes.freedBytes, files: trashRes.removedFiles })
  }

  const ghistRes = await prunePublicGlossaryHistory(root, { keepLatest: options.keepGlossaryHistory ?? 2, dryRun })
  if (ghistRes.freedBytes > 0) {
    items.push({ category: '.pipeline/glossaries/history', label: '公共术语历史快照', path: path.join(root, '.pipeline/glossaries/history'), bytes: ghistRes.freedBytes, files: ghistRes.removedFiles })
  }

  await recordRemoval(path.join(root, '.pipeline/backups'), '.pipeline/backups', '历史备份', dryRun, items)
  const importsEntries = await fs.readdir(path.join(root, 'imports'), { withFileTypes: true }).catch(() => [])
  for (const entry of importsEntries) {
    if (entry.isDirectory() && entry.name.startsWith('cleanup-')) {
      await recordRemoval(path.join(root, 'imports', entry.name), 'imports/cleanup', entry.name, dryRun, items)
    }
  }

  // Legacy Book/ intermediate caches
  const bookItems = await pruneLegacyBooks(root, { mode, dryRun })
  items.push(...bookItems)

  let dedupe = null
  if (options.dedupe) {
    dedupe = await dedupeLargeFiles(root, { dryRun })
  }

  const byCategory = {}
  let totalBytes = 0
  let totalFiles = 0
  for (const item of items) {
    totalBytes += item.bytes
    totalFiles += item.files
    const cat = byCategory[item.category] ?? { bytes: 0, files: 0 }
    cat.bytes += item.bytes
    cat.files += item.files
    byCategory[item.category] = cat
  }

  return {
    mode,
    dryRun,
    totalBytes,
    totalFiles,
    byCategory,
    items,
    ...(dedupe ? { dedupe } : {}),
  }
}

export async function auditWorkspace(manager, options = {}) {
  const safe = await pruneWorkspace(manager, { ...options, mode: 'safe', dryRun: true, trashMaxAgeMs: 0 })
  const compact = await pruneWorkspace(manager, { ...options, mode: 'compact', dryRun: true, trashMaxAgeMs: 0 })
  return {
    root: manager.root,
    safeBytes: safe.totalBytes,
    safeFiles: safe.totalFiles,
    safeByCategory: safe.byCategory,
    compactBytes: compact.totalBytes,
    compactFiles: compact.totalFiles,
    compactByCategory: compact.byCategory,
    ...(compact.dedupe ? { dedupe: compact.dedupe } : {}),
  }
}
