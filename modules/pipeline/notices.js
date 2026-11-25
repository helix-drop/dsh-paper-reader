import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const MAX_NOTICES = 40
const DEDUPE_MS = 90_000
const PHASES = new Set(['transcription', 'translation'])
const OUTCOMES = new Set(['done', 'problem'])
const ID_RE = /^n-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TASK_ID_RE = /^[\w:-]{1,80}$/

export function clipNoticeText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function bookTitle(name) {
  return clipNoticeText(name, 80) || '未命名文献'
}

/**
 * Whether an Android client should raise a system notification.
 * E-ink mode refreshes the whole panel, so it stays silent.
 */
export function deviceWantsPipelineNotices(settings) {
  if (!settings || typeof settings !== 'object') return false
  if (settings.deviceMode === 'eink' || settings.theme === 'eink') return false
  return true
}

/**
 * Decide if a settled transcription or translation run should notify.
 * User stops stay quiet. A timeout or a blocked stage is a problem.
 * Success notifies only when that phase is actually complete.
 */
export function decidePipelineNotice(input = {}) {
  const phase = input.phase
  if (!PHASES.has(phase)) return null
  if (input.userStop === true) return null
  const problem = input.state === 'blocked' || input.timedOut === true
  const done = input.state === 'idle' && input.phaseComplete === true
  if (!problem && !done) return null
  const name = bookTitle(input.taskName)
  const detail = clipNoticeText(input.message, 160)
  const phaseName = phase === 'transcription' ? '转写' : '翻译'
  const retry = input.scope === 'retry'
  let title
  let body
  if (problem) {
    title = `${phaseName}遇到问题`
    body = detail ? `《${name}》${detail}` : `《${name}》${phaseName}已停止，需要查看任务`
  } else if (retry) {
    title = '转写重试完成'
    body = detail ? `《${name}》${detail}` : `《${name}》卡住的页面已重试通过`
  } else if (phase === 'transcription') {
    title = '转写完成'
    body = `《${name}》转写已完成，可以确认进入术语分析与翻译`
  } else {
    title = '翻译完成'
    body = `《${name}》术语分析、翻译与校验已完成，可以确认进入审校与发布`
  }
  return {
    fingerprint: [input.taskId ?? '', phase, problem ? 'problem' : 'done', retry ? 'retry' : 'phase', title, detail].join('|'),
    taskId: TASK_ID_RE.test(String(input.taskId ?? '')) ? String(input.taskId) : '',
    phase,
    outcome: problem ? 'problem' : 'done',
    title,
    body,
  }
}

export function sanitizeNotices(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : ''
    const title = clipNoticeText(item.title, 80)
    const body = clipNoticeText(item.body, 240)
    const at = typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at)) ? item.at : ''
    const taskId = typeof item.taskId === 'string' && TASK_ID_RE.test(item.taskId) ? item.taskId : ''
    if (!ID_RE.test(id) || !title || !body || !PHASES.has(item.phase) || !OUTCOMES.has(item.outcome) || !at) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, at, taskId, phase: item.phase, outcome: item.outcome, title, body })
    if (out.length >= MAX_NOTICES) break
  }
  return out
}

function appleQuote(value) {
  const text = clipNoticeText(value, 180)
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function notifyDesktop(notice, platform = process.platform) {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve(false)
  if (platform !== 'darwin' || !notice?.title || !notice?.body) return Promise.resolve(false)
  const script = `display notification ${appleQuote(notice.body)} with title "Paper Reader" subtitle ${appleQuote(notice.title)}`
  return new Promise(resolve => {
    execFile('osascript', ['-e', script], { timeout: 8000 }, error => resolve(!error))
  })
}

function publicNotice(row) {
  return {
    id: row.id,
    at: row.at,
    taskId: row.taskId,
    phase: row.phase,
    outcome: row.outcome,
    title: row.title,
    body: row.body,
  }
}

export function createNoticeStore(file, { notify = notifyDesktop, now = () => Date.now() } = {}) {
  let chain = Promise.resolve()
  const serialized = fn => {
    const job = chain.then(fn, fn)
    chain = job.then(() => {}, () => {})
    return job
  }
  const readRows = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      return []
    }
  }
  return {
    async list() {
      const rows = await serialized(readRows)
      return sanitizeNotices(rows)
    },
    async publish(draft) {
      const saved = await serialized(async () => {
        if (!draft?.fingerprint || !draft.title || !draft.body) return null
        const rows = await readRows()
        const previous = rows.find(row => row?.fingerprint === draft.fingerprint)
        if (previous && now() - Date.parse(previous.at) < DEDUPE_MS) return null
        const notice = {
          id: `n-${randomUUID()}`,
          at: new Date(now()).toISOString(),
          fingerprint: draft.fingerprint,
          taskId: draft.taskId ?? '',
          phase: draft.phase,
          outcome: draft.outcome,
          title: draft.title,
          body: draft.body,
        }
        const next = [notice, ...rows.filter(row => row?.fingerprint !== draft.fingerprint)].slice(0, MAX_NOTICES)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(next), { mode: 0o600 })
        return notice
      })
      if (saved) void Promise.resolve(notify(publicNotice(saved))).catch(() => {})
      return saved ? publicNotice(saved) : null
    },
  }
}

export async function publishTaskNotice(manager, task, meta = {}) {
  if (!manager?.notices?.publish) return null
  const decision = decidePipelineNotice({
    taskId: task?.id,
    taskName: task?.name,
    message: task?.message,
    state: task?.state,
    phase: meta.phase,
    phaseComplete: meta.phaseComplete === true,
    userStop: meta.userStop === true,
    timedOut: meta.timedOut === true,
    scope: meta.scope === 'retry' ? 'retry' : 'phase',
  })
  if (!decision) return null
  const saved = await manager.notices.publish(decision)
  if (saved) {
    try { manager.scheduleBackgroundSync?.(1500, 'pipeline-notice') } catch { /* sync is optional */ }
  }
  return saved
}
