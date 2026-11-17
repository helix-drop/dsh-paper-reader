import fs from 'node:fs/promises'
import path from 'node:path'
import { VISION, VERIFY_DELIVERIES, atomic, json, parseModelChoice } from './shared.js'

export function blockedPagesFromReport(errors) {
  const pages = new Set()
  for (const error of errors ?? []) {
    const text = String(error)
    if (!/\bBLOCKED\b/.test(text)) continue
    for (const match of text.matchAll(/(?:page\s+|page_)(\d+)/g)) pages.add(Number(match[1]))
    for (const match of text.matchAll(/(?<!\w)(\d+):p\1_\d+\b/g)) pages.add(Number(match[1]))
  }
  return [...pages]
}

export function stuckPagesFromReports(chapters) {
  const pages = []
  for (const chapter of chapters ?? []) {
    const passed = chapter?.quality === 'program_checks_passed'
    const blocked = new Set(chapter?.blockedPages ?? [])
    for (const [key, budget] of Object.entries(chapter?.attempts ?? {})) {
      if (!/^\d+$/.test(key) || !budget) continue
      // A passed chapter keeps its vision pages. An OCR copy can still be replaced by a chosen model.
      const ocrCopy = budget.fallback_applied === 'ocr_layout_cleaned'
      if (passed && !ocrCopy) continue
      const last = (budget.history ?? []).at(-1) ?? {}
      const rejectedOcr = ocrCopy && last.state !== 'selected' && (Number(budget.used) >= 2 || budget.last_failed)
      const rejectedBlock = !passed && blocked.has(Number(key)) && Number(budget.used) >= 2 && last.state !== 'selected'
      if (!budget.models_exhausted && !rejectedBlock && !rejectedOcr) continue
      pages.push({
        chapterId: String(chapter.chapterId),
        page: Number(key),
        reason: String(last.error_message || last.failure_kind || last.reason || last.outcome || '已配置模型均已失败').slice(0, 180),
        models: (last.model_failures ?? last.calls ?? []).map(call => call?.model).filter(Boolean).slice(0, 4),
      })
    }
  }
  return pages
}

export function reopenStuckBudget(budget) {
  if (!budget || (!budget.models_exhausted && !(Number(budget.used) >= 2))) return false
  budget.models_exhausted = false
  if (Number(budget.used) >= 2) budget.used = 1
  budget.last_failed = true
  const last = (budget.history ?? []).at(-1)
  if (last) last.models_exhausted = false
  return true
}

async function retireRetryAttempt(dir, page, round) {
  const pad = String(page).padStart(3, '0')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const names = [
    `page_${pad}_round_${round}`,
    `page_${pad}_round_${round}_fallback_1`,
    `page_${pad}_round_${round}_fallback_2`,
  ]
  for (const name of names) {
    const from = path.join(dir, name)
    try { await fs.access(from) } catch { continue }
    await fs.rename(from, path.join(dir, `${name}.previous-${stamp}`))
  }
}

export const stuckPagesMethods = {
  async listStuckPages(t) {
    const dir = path.join(this.aiDir(t), 'delivery')
    const chapters = []
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const match = name.match(/^chapter_(\d+)$/)
      if (!match) continue
      const state = await json(path.join(dir, name, 'state.json'), null)
      const report = await json(path.join(dir, name, 'output/report.json'), null)
      if (!state?.attempts) continue

      const blocked = new Set(blockedPagesFromReport(report?.errors))
      const blockedAnchors = new Set()
      for (const err of report?.errors ?? []) {
        const text = String(err)
        if (!/\bBLOCKED\b/.test(text)) continue
        for (const m of text.matchAll(/\[\^([^\]]+)\]/g)) blockedAnchors.add(`[^${m[1]}]`)
      }

      if (blockedAnchors.size) {
        const selectedAi = path.join(dir, name, 'selected/book/ai_convert')
        const notes = await json(path.join(selectedAi, `edits/notes/chapter_${match[1]}.json`), null)
        for (const def of notes?.definitions ?? []) {
          if (!blockedAnchors.has(def?.anchor)) continue
          for (const pg of [def.source_page, def.continued_on_page]) {
            if (Number.isInteger(pg) && state.attempts[String(pg)]) blocked.add(pg)
          }
        }
        const bodyDir = path.join(selectedAi, 'edits/body')
        for (const bf of await fs.readdir(bodyDir).catch(() => [])) {
          const bm = bf.match(/^page_(\d+)\.json$/)
          if (!bm || !state.attempts[String(Number(bm[1]))]) continue
          const bp = Number(bm[1])
          if (blocked.has(bp)) continue
          const bdata = await json(path.join(bodyDir, bf), null)
          const rawStr = JSON.stringify(bdata ?? {})
          for (const anchor of blockedAnchors) {
            const num = anchor.slice(2, -1)
            if (rawStr.includes(anchor) || (num && /^\d+$/.test(num) && rawStr.includes(`(${num})`))) {
              blocked.add(bp)
              break
            }
          }
        }
      }

      chapters.push({
        chapterId: match[1],
        quality: report?.quality_status ?? '',
        attempts: state.attempts,
        blockedPages: [...blocked],
      })
    }
    return stuckPagesFromReports(chapters)
  },

  async retryStuckPages(id, workerId) {
    const choice = await this.requireModel(parseModelChoice(workerId))
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目记录保持只读')
      if (this.active.has(id) || t.state === 'running') throw new Error('任务正在运行')
      if (t.phaseApproval?.phase !== 'transcription') throw new Error('请先确认转写阶段')
      const pages = await this.listStuckPages(t)
      if (!pages.length) throw new Error('没有模型已耗尽且章节仍未通过的页面')

      const byChapter = new Map()
      for (const page of pages) {
        byChapter.set(page.chapterId, [...(byChapter.get(page.chapterId) ?? []), page.page])
      }

      t.state = 'running'
      t.stage = 'transcribe'
      t.message = `正在用 ${choice.model} 重试第 ${pages.map(page => page.page).join('、')} 页`
      const active = { cancel: false, child: null, children: new Set(), requestedStage: 'transcribe' }
      this.active.set(id, active)
      await this.save(t)

      const doc = this.docDir(t)
      active.promise = (async () => {
        let pending = null
        for (const [chapterId, pageNums] of byChapter) {
          if (active.cancel) throw new Error('任务已停止')
          const stateFile = path.join(this.aiDir(t), 'delivery', `chapter_${chapterId}`, 'state.json')
          const state = await json(stateFile, null)
          if (!state?.attempts) throw new Error(`章节 ${chapterId} 缺少预算记录`)
          for (const page of pageNums) reopenStuckBudget(state.attempts[String(page)])
          await atomic(stateFile, state)

          const attemptsDir = path.join(path.dirname(stateFile), 'attempts')
          for (const page of pageNums) {
            const used = Number(state.attempts[String(page)]?.used)
            if (Number.isFinite(used)) await retireRetryAttempt(attemptsDir, page, used + 1)
          }

          await this.py(
            t,
            `${VISION}/bounded_chapter.py`,
            [
              doc,
              '--chapter', chapterId,
              '--pages', pageNums.join(','),
              '--provider', choice.provider,
              '--model', choice.model,
              '--timeout', String(t.worker?.timeout ?? 600),
              '--concurrency', '1',
            ],
            { models: [choice] },
          )

          const verifyArgs = [VERIFY_DELIVERIES, path.join(this.root, VISION), doc, '--chapter', chapterId]
          try {
            await this.command(t, this.python, verifyArgs)
          } catch (error) {
            if (active.cancel) throw error
            pending = pending ?? error
          }
          try {
            await this.acceptTranscriptionDelivery(t, chapterId)
          } catch (error) {
            pending = error?.code === 'CHAPTER_VALIDATION_PENDING' ? error : (pending ?? error)
          }
        }

        const chapters = await this.chapters(t)
        const passed = chapters.length > 0 && chapters.every(
          chapter => t.transcriptionDeliveries?.[chapter.id]?.quality === 'program_checks_passed',
        )
        if (passed) {
          t.stages.transcribe = { state: 'done', at: new Date().toISOString() }
          delete t.stages.verify
          t.stage = 'verify'
          t.state = 'idle'
          t.message = `已用 ${choice.model} 重试第 ${pages.map(page => page.page).join('、')} 页，相关章节已通过`
          return
        }

        t.state = 'blocked'
        t.stage = 'verify'
        t.stages.transcribe = { state: 'blocked' }
        t.stages.verify = { state: 'blocked' }
        t.message = pending?.code === 'CHAPTER_VALIDATION_PENDING'
          ? pending.message
          : (pending?.message || `已用 ${choice.model} 重试指定页面，章节仍未通过`)
      })().catch(error => {
        t.state = active.cancel ? 'paused' : 'blocked'
        t.stages.transcribe = { state: t.state === 'paused' ? 'stopped' : 'blocked' }
        t.message = error.message
      }).finally(async () => {
        try {
          await this.save(t)
        } finally {
          this.active.delete(id)
        }
      })
      return t
    })
  },
}
