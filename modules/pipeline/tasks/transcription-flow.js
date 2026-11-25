import fs from 'node:fs/promises'
import path from 'node:path'
import { buildSourceMap, sourceMapPath } from '../source-map.js'
import { readPipelineConfiguration } from '../configuration.js'
import { hash, markdownBlocks, checkMarkdownPair } from '../markdown.js'
import {
  VISION,
  TEXT,
  ASSEMBLER,
  VERIFY_DELIVERIES,
  APPLY_SOURCE_EDIT,
  exists,
  atomic,
  json,
  walk,
  visionFallbackArgs,
} from './shared.js'
import { hasUntriedVisionModel, reopenStuckBudget, retireRetryAttempt } from './stuck-pages.js'

export async function runTranscriptionStage(manager, t, stage, options = {}) {
  const doc = manager.docDir(t)
  const ai = manager.aiDir(t)
  const vision = s => `${VISION}/${s}`
  const text = s => `${TEXT}/${s}`

  if (stage === 'inspect') {
    if (t.input.type === 'markdown') {
      const source = await fs.readFile(t.path, 'utf8')
      t.inspection = {
        fingerprint: hash(source),
        verdict: 'MARKDOWN',
        blocks: markdownBlocks(source).length,
        pages: 0,
      }
    } else {
      const out = await manager.py(t, 'document_pipeline.py', ['inspect', t.path])
      t.inspection = JSON.parse(out.trim().split('\n').at(-1))
    }
    await manager.analyzeProfile(t, options)
    return true
  }

  if (stage === 'normalize') {
    if (t.input.type !== 'pdf') throw new Error('Markdown无需PDF范围处理')
    const out = await manager.py(t, 'document_pipeline.py', [
      'normalize',
      t.path,
      '--profile', path.join(manager.dir(t.id), 'profile.json'),
      '--out', doc,
    ])
    const result = JSON.parse(out.trim().split('\n').at(-1))
    t.scope = {
      fingerprint: result.profile.source_fingerprint,
      profileFingerprint: hash(await fs.readFile(path.join(doc, 'document_profile.json'))),
      pages: result.pages,
    }
    return true
  }

  if (stage === 'images') {
    await manager.requireDone(t, 'normalize')
    await manager.py(t, vision('extract_page_images.py'), [
      path.join(doc, 'source.pdf'),
      '--out', path.join(ai, 'page_images'),
    ])
    await manager.ensureTaskCover?.(t).catch(() => null)
    return true
  }

  if (['paddle', 'mineru'].includes(stage)) {
    await manager.requireDone(t, 'normalize')
    if (t.inspection.verdict === 'BORN-DIGITAL') throw new Error('可靠文字层不调用云 OCR')
    const config = await readPipelineConfiguration(manager.root, manager.modelService)
    if (!config.ocr.find(s => s.id === stage)?.configured) throw new Error('先填写OCR服务密钥')

    const raw = await json(path.join(doc, `raw_pages_${stage}.json`), null)
    if (raw?.pages?.length === t.scope?.pages) {
      if (stage === 'paddle') {
        await fs.copyFile(path.join(doc, 'raw_pages_paddle.json'), path.join(doc, 'raw_pages.json'))
      }
      return true
    }

    const output = path.join(doc, 'ocr_output', stage)
    const args = [path.join(doc, 'source.pdf'), '--out', doc, '--out-dir', output, '--suffix', stage]
    const meta = await json(path.join(output, stage === 'paddle' ? 'paddle_meta.json' : 'batch_meta.json'), null)
    if (stage === 'paddle') {
      if (options.resumeId) {
        args.push('--job-id', String(options.resumeId))
      } else if (meta) {
        args.push('--resume-meta', path.join(output, 'paddle_meta.json'))
        if (meta.model) args.push('--model', String(meta.model))
      }
    }
    if (stage === 'mineru' && (options.resumeId || meta?.batch_id)) {
      args.push('--batch-id', String(options.resumeId ?? meta.batch_id))
    }
    await manager.py(t, vision(stage === 'paddle' ? 'paddle_ocr.py' : 'mineru_ocr.py'), args)
    if (stage === 'paddle') {
      await fs.copyFile(path.join(doc, 'raw_pages_paddle.json'), path.join(doc, 'raw_pages.json'))
    }
    return true
  }

  if (stage === 'prepare') {
    await manager.requireDone(t, 'normalize')
    if (['paper', 'chapter'].includes(t.kind)) await manager.ensureSinglePieceStructure(t)
    const curated = (
      await exists(path.join(ai, 'book_analysis.json'))
      && await exists(path.join(ai, 'chapters.json'))
      && await exists(path.join(ai, 'toc.json'))
    )

    if (t.inspection.verdict !== 'BORN-DIGITAL') {
      await manager.requireDone(t, 'images')
      await atomic(path.join(ai, 'ocr-policy.json'), { mode: 'on-demand-regions' })
      if (!['paper', 'chapter'].includes(t.kind) && !curated && !t.structureConfirmed) {
        throw new Error('书籍缺少已确认的章节结构，请在面板核对确认章节或在 DSH 进行结构观察')
      }
      await manager.py(t, vision('gate_check.py'), [doc, '--phase', '2'])
      t.transcriptionPlan = {
        method: 'vision',
        referenceType: 'optional_regional_ocr',
        ocrPolicy: 'on_demand_regions',
        worker: { ...t.worker },
      }
      await manager.ensureTaskCover?.(t).catch(() => null)
      t.observationConfirmed = true
    } else {
      let reference = null
      const isVision = t.profile?.transcription_method !== 'text_layer'
      if (!['paper', 'chapter'].includes(t.kind) && !curated && !t.structureConfirmed) {
        throw new Error('书籍缺少已确认的章节结构，请在面板核对确认章节或在 DSH 进行结构观察')
      }
      if (isVision) {
        await manager.requireDone(t, 'images')
        reference = await manager.ensureTextLayerReference(t)
      }
      const hasBookAnalysis = await exists(path.join(ai, 'book_analysis.json'))
      const useMetricsOnly = hasBookAnalysis && (curated || t.structureConfirmed || ['paper', 'chapter'].includes(t.kind))
      await manager.py(t, text('tl_convert.py'), [doc, 'prepare', ...(useMetricsOnly ? ['--metrics-only'] : ['--force'])])
      if (isVision) {
        t.transcriptionPlan = {
          method: 'vision',
          referenceType: 'pdf_text_layer',
          referenceDirectory: reference,
          independentOcr: false,
          ocrPolicy: 'vision_first_then_configured_fallbacks_ocr_last',
          worker: { ...t.worker },
        }
        await manager.py(t, vision('gate_check.py'), [doc, '--phase', '2'])
      }
      await manager.ensureTaskCover?.(t).catch(() => null)
      t.observationConfirmed = true
    }
    return true
  }

  if (stage === 'transcribe') {
    await manager.requireDone(t, 'prepare', 'images')
    if (t.inspection.verdict === 'BORN-DIGITAL' && t.profile?.transcription_method === 'text_layer') {
      await manager.py(t, text('tl_convert.py'), [doc, 'extract'])
      await manager.ensureTaskCover?.(t).catch(() => null)
      return true
    }

    await manager.py(t, vision('gate_check.py'), [doc, '--phase', '2'])
    const allChapters = await manager.chapters(t)
    if (options.chapterId !== undefined && !/^\d{3,6}$/.test(String(options.chapterId))) {
      throw new Error('章节编号无效')
    }
    const chapterList = options.chapterId
      ? allChapters.filter(c => String(c.id) === String(options.chapterId))
      : allChapters
    if (options.chapterId && !chapterList.length) throw new Error(`未找到章节 ${options.chapterId}`)

    const concurrency = Math.min(3, Math.max(1, Number(options.concurrency ?? t.transcriptionConcurrency ?? 2)))
    const queue = [...chapterList]
    let firstError = null
    const chapterErrors = []
    const pageConcurrency = String(t.pageConcurrency ?? (['paper', 'chapter'].includes(t.kind) ? 4 : 2))

    const runChapter = async c => {
      if (manager.active.get(t.id)?.cancel) throw new Error('任务已停止')
      const stateFile = path.join(ai, 'delivery', `chapter_${c.id}`, 'state.json')
      const state = await json(stateFile, null)
      const report = state?.finished
        ? await json(path.join(ai, 'delivery', `chapter_${c.id}`, 'output/report.json'), null)
        : null
      if (report?.quality_status === 'program_checks_passed') {
        const verifyArgs = [VERIFY_DELIVERIES, path.join(manager.root, VISION), doc, '--chapter', c.id]
        await manager.command(t, manager.python, verifyArgs)
      } else {
        const reopened = []
        if (state?.finished && report?.quality_status === 'pending') {
          const unverified = new Set((report?.input_protocol?.unverified_pages ?? []).map(Number))
          for (const [page, b] of Object.entries(state.attempts ?? {})) {
            if (!/^\d+$/.test(page) || !hasUntriedVisionModel(b, t.worker)) continue
            if (!options.retryErrors && !b.last_failed && !unverified.has(Number(page))) continue
            if (reopenStuckBudget(b)) reopened.push(page)
          }
          if (reopened.length) {
            await atomic(stateFile, state)
            const attemptsDir = path.join(path.dirname(stateFile), 'attempts')
            for (const page of reopened) {
              const used = Number(state.attempts[page]?.used ?? 1)
              if (Number.isFinite(used)) await retireRetryAttempt(attemptsDir, Number(page), used + 1)
            }
          }
        }
        const retrySet = new Set(reopened)
        if (options.retryErrors && report?.quality_status === 'pending') {
          for (const [page, b] of Object.entries(state.attempts ?? {})) {
            if (/^\d+$/.test(page) && Number(b.used) < 2 && !b.models_exhausted) retrySet.add(page)
          }
        }
        const retryPages = [...retrySet].sort((a, b) => Number(a) - Number(b))
        await manager.py(t, vision('bounded_chapter.py'), [
          doc,
          '--chapter', c.id,
          ...(retryPages.length ? ['--pages', retryPages.join(',')] : []),
          '--provider', t.worker.provider,
          '--model', t.worker.model,
          '--timeout', String(t.worker.timeout),
          '--concurrency', pageConcurrency,
          ...visionFallbackArgs(t.worker),
        ])
      }
      await manager.acceptTranscriptionDelivery(t, c.id)
    }

    const pool = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length && !firstError) {
        if (manager.active.get(t.id)?.cancel) throw new Error('任务已停止')
        const c = queue.shift()
        if (!c) break
        try {
          await runChapter(c)
        } catch (err) {
          if (err.code === 'CHAPTER_VALIDATION_PENDING') {
            chapterErrors.push(err)
            continue
          }
          if (!firstError) firstError = err
          throw err
        }
      }
    })
    const results = await Promise.allSettled(pool)
    const rejected = [...results.filter(r => r.status === 'rejected').map(r => r.reason), ...chapterErrors]
    if (rejected.length === 1) throw rejected[0]
    if (rejected.length > 1) throw new Error(rejected.map(e => e?.message || String(e)).join('；'))
    await manager.ensureTaskCover?.(t).catch(() => null)
    return true
  }

  if (stage === 'verify') {
    if (options.chapterId !== undefined && !/^\d{3,6}$/.test(String(options.chapterId))) {
      throw new Error('章节编号无效')
    }
    if ((t.stages.transcribe?.state !== 'done' || options.chapterId) && t.profile?.transcription_method !== 'text_layer') {
      const errs = []
      let verifyErr = null
      const verifyArgs = [
        VERIFY_DELIVERIES,
        path.join(manager.root, VISION),
        doc,
        ...(options.chapterId ? ['--chapter', String(options.chapterId)] : []),
      ]
      try {
        await manager.command(t, manager.python, verifyArgs)
      } catch (e) {
        verifyErr = e
      }

      const canonical = await manager.chapters(t).catch(() => [])
      const canonicalIds = canonical.length ? new Set(canonical.map(c => String(c.id))) : null
      const entries = await fs.readdir(path.join(ai, 'delivery')).catch(() => [])
      const targetNames = entries
        .filter(n => /^chapter_\d+$/.test(n) && (
          options.chapterId
            ? n === `chapter_${options.chapterId}`
            : (!canonicalIds || canonicalIds.has(n.slice('chapter_'.length)))
        ))
        .sort()

      for (const name of targetNames) {
        const state = await json(path.join(ai, 'delivery', name, 'state.json'), null)
        if (!state?.finished) continue
        try {
          await manager.acceptTranscriptionDelivery(t, name.slice('chapter_'.length))
        } catch (e) {
          errs.push(e)
        }
      }
      if (errs.length === 1) throw errs[0]
      if (errs.length > 1) throw new Error(errs.map(e => e?.message || String(e)).join('；'))
      if (verifyErr) throw verifyErr
      return true
    }

    await manager.requireDone(t, 'transcribe')
    if (t.inspection.verdict === 'BORN-DIGITAL' && t.profile?.transcription_method === 'text_layer') {
      await manager.py(t, text('verify_textlayer_structure.py'), [doc])
    }
    await manager.py(t, vision('verify_page_json.py'), [doc, '--all'])
    return true
  }

  if (stage === 'assemble') {
    await manager.requireDone(t, 'verify')
    for (const c of await manager.chapters(t)) {
      await manager.command(t, manager.python, [ASSEMBLER, manager.root, doc, '--chapter', c.id])
    }
    await manager.py(t, vision('verify_output.py'), [path.join(ai, 'chapters')])
    await manager.py(t, vision('gate_check.py'), [doc, '--phase', '3c'])
    if (['book', 'collection'].includes(t.kind)) {
      await manager.command(t, manager.python, [ASSEMBLER, manager.root, doc, '--title', String(t.profile?.title || t.name)])
      const fullMd = (await walk(path.join(ai, 'book'), /-full\.md$/, 2))[0]
      if (!fullMd) throw new Error('未找到整书拼接产物 *-full.md')
      await manager.py(t, vision('audit_book.py'), [doc])
      const whole = await fs.readFile(fullMd, 'utf8')
      const check = checkMarkdownPair(whole, whole)
      if (!check.passed) throw new Error('整书拼接后的脚注或附件结构异常：' + check.errors.join('；'))
    }
    t.sourceMap = await manager.generateSourceMap(t)
    await manager.ensureTaskCover?.(t).catch(() => null)
    return true
  }

  return false
}

export const transcriptionFlowMethods = {
  async acceptTranscriptionDelivery(t, chapter) {
    return this.locked('delivery:' + t.id, async () => {
      const directory = path.join(this.aiDir(t), 'delivery', 'chapter_' + chapter)
      const reportFile = path.join(directory, 'output/report.json')
      const report = await json(reportFile, null)
      const state = await json(path.join(directory, 'state.json'), null)
      if (!report || !state?.finished) throw new Error('转写交付记录不完整，不能认定完成')

      t.transcriptionDeliveries = {
        ...t.transcriptionDeliveries,
        [chapter]: {
          reportFile,
          quality: report.quality_status,
          attempts: state.attempts,
          errors: report.errors,
        },
      }

      if (report.errors?.some(e => /source changed since this run.s input snapshot/.test(String(e)))) {
        throw new Error('底本与转写输入快照不一致，停止后续章节并保留成果')
      }
      if (report.input_protocol?.required !== true || !Array.isArray(report.input_protocol.unverified_pages)) {
        throw new Error('转写缺少独立视觉或受控 OCR 降级的文件指纹回执；保留候选与预算，不进入翻译')
      }
      if (report.input_protocol.unverified_pages.length) {
        const pagesText = report.input_protocol.unverified_pages.join('、')
        throw Object.assign(
          new Error(`章节 ${chapter}（第 ${pagesText} 页）转写缺少独立视觉或受控 OCR 降级的文件指纹回执；保留候选与预算，不进入翻译`),
          { code: 'CHAPTER_VALIDATION_PENDING' },
        )
      }
      if (report.quality_status !== 'program_checks_passed') {
        throw Object.assign(
          new Error('转写仅交付待核查稿，章节 ' + chapter + ' 未通过程序验收；预算保留，不进入翻译'),
          { code: 'CHAPTER_VALIDATION_PENDING' },
        )
      }

      const selected = path.resolve(state.book)
      const base = path.resolve(directory)
      if (!selected.startsWith(base + path.sep)) throw new Error('交付来源目录无效')

      const chList = await this.chapters(t).catch(() => [])
      const chInfo = chList.find(c => String(c.id) === String(chapter))
      const attemptPages = new Set(Object.keys(state.attempts || {}).map(Number))

      const belongsToChapter = (kind, baseName) => {
        if (kind === 'notes') return baseName === `chapter_${chapter}.json`
        if (kind === 'body') {
          const m = baseName.match(/^page_(\d+)\.json$/)
          if (!m) return false
          const pageNum = Number(m[1])
          if (attemptPages.has(pageNum)) return true
          if (chInfo && pageNum >= chInfo.start_page && pageNum <= chInfo.end_page) return true
          if (chInfo?.note_pages && pageNum >= chInfo.note_pages[0] && pageNum <= chInfo.note_pages[1]) return true
          return false
        }
        return false
      }

      for (const kind of ['body', 'notes']) {
        for (const file of await walk(path.join(selected, 'ai_convert/edits', kind), /\.json$/, 1)) {
          const baseName = path.basename(file)
          const target = path.join(this.aiDir(t), 'edits', kind, baseName)
          await fs.mkdir(path.dirname(target), { recursive: true })
          if (belongsToChapter(kind, baseName)) {
            await fs.copyFile(file, target)
          } else {
            const rel = `ai_convert/edits/${kind}/${baseName}`
            const initialHash = state.source_hashes?.[rel]
            if (initialHash) {
              const currentHash = hash(await fs.readFile(file))
              if (currentHash !== initialHash) {
                throw new Error(`交付候选包含其他章节的不同转写内容，禁止跨章覆盖：${baseName}`)
              }
            }
          }
        }
      }

      const obsSrcDir = path.join(selected, 'ai_convert/marker_review/observations')
      for (const file of await walk(obsSrcDir, /^page_\d+\.json$/, 1)) {
        const baseName = path.basename(file)
        if (!belongsToChapter('body', baseName)) continue
        const idx = await json(file, null)
        if (!idx?.record || path.basename(idx.record) !== idx.record || typeof idx.sha256 !== 'string') continue
        const recSrc = path.join(obsSrcDir, idx.record)
        const recBytes = await fs.readFile(recSrc).catch(() => null)
        if (!recBytes || hash(recBytes) !== idx.sha256) continue
        const obsDstDir = path.join(this.aiDir(t), 'marker_review/observations')
        await fs.mkdir(obsDstDir, { recursive: true })
        await fs.copyFile(recSrc, path.join(obsDstDir, idx.record))
        await fs.copyFile(file, path.join(obsDstDir, baseName))
      }

      const ledger = await fs.readFile(path.join(selected, 'ai_convert/worker_audit.jsonl'), 'utf8')
      const target = path.join(this.aiDir(t), 'worker_audit.jsonl')
      const old = await fs.readFile(target, 'utf8').catch(() => '')
      const lines = new Set(old.split('\n').filter(Boolean))
      const extra = ledger.split('\n').filter(l => l && !lines.has(l))
      if (extra.length) {
        const prefix = old && !old.endsWith('\n') ? '\n' : ''
        await fs.appendFile(target, prefix + extra.join('\n') + '\n', { mode: 0o600 })
      }
    })
  },

  async generateSourceMap(t) {
    const map = await buildSourceMap(this, t)
    if (!map) return null
    return {
      path: sourceMapPath(await this.original(t)),
      markdownSha256: map.markdownSha256,
      mappedBlocks: map.blocks.filter(b => b.pdfPages.length).length,
      blocks: map.blocks.length,
    }
  },

  async updateConcurrency(id, concurrency, pageConcurrency) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (this.active.has(id)) throw new Error('任务正在运行，不能修改并发度')
      if (concurrency !== undefined) {
        const val = Math.min(3, Math.max(1, Number(concurrency) || 2))
        t.transcriptionConcurrency = val
        t.message = `已将整书转写并发度调整为 ${val} 章并行。`
      }
      if (pageConcurrency !== undefined) {
        const pval = Math.min(6, Math.max(1, Number(pageConcurrency) || 4))
        t.pageConcurrency = pval
        t.message = `已将单篇/单章页面转写并发度调整为 ${pval} 页并行。`
      }
      return this.save(t)
    })
  },

  async resetTranscription(id, { cleanChapters = false, cleanSessions = true } = {}) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (this.active.has(id)) throw new Error('任务正在运行，请先停止任务后再重置')
      if (t.legacy) throw new Error('旧项目归档记录保持只读')

      const ai = this.aiDir(t)
      await fs.rm(path.join(ai, 'delivery'), { recursive: true, force: true }).catch(() => {})
      await fs.rm(path.join(this.dir(t.id), 'harness-requests'), { recursive: true, force: true }).catch(() => {})
      await fs.rm(path.join(ai, 'harness-requests'), { recursive: true, force: true }).catch(() => {})
      await fs.rm(path.join(ai, 'worker_audit.jsonl'), { force: true }).catch(() => {})
      await fs.rm(path.join(ai, 'chapters'), { recursive: true, force: true }).catch(() => {})
      await fs.rm(path.join(ai, 'edits'), { recursive: true, force: true }).catch(() => {})
      await fs.rm(path.join(this.dir(t.id), 'review'), { recursive: true, force: true }).catch(() => {})

      if (cleanChapters) {
        await fs.rm(path.join(ai, 'chapters.json'), { force: true }).catch(() => {})
        await fs.rm(path.join(ai, 'toc.json'), { force: true }).catch(() => {})
        await fs.rm(path.join(ai, 'book_analysis.json'), { force: true }).catch(() => {})
        t.structureConfirmed = false
        t.observationConfirmed = false
      }

      if (cleanChapters || t.stages.prepare?.state === 'blocked') delete t.stages.prepare
      delete t.stages.transcribe
      delete t.stages.verify
      delete t.stages.assemble
      delete t.stages.glossary
      delete t.stages.lgProject
      delete t.stages.translate
      delete t.stages.translationCheck
      delete t.stages.review
      delete t.stages.publish

      t.state = 'ready'
      t.stage = cleanChapters ? 'prepare' : (t.stages.images?.state === 'done' ? 'prepare' : 'images')
      t.message = '已清除历史转写产物、交付快照与会话记录，可重新开始转写。'
      delete t.translationReport
      delete t.transcriptionPlan

      if (cleanSessions) {
        if (this.sessionMonitor) {
          await this.sessionMonitor.resetSessions(t)
        } else {
          const sessFile = path.join(this.dir(t.id), 'sessions.json')
          try {
            const data = JSON.parse(await fs.readFile(sessFile, 'utf8'))
            data.previousSessions = { ...(data.previousSessions ?? {}), ...(data.sessions ?? {}) }
            data.sessions = {}
            data.recorded = {}
            data.authorizedStage = null
            await fs.writeFile(sessFile, JSON.stringify(data, null, 2), { mode: 0o600 })
          } catch {}
          await fs.writeFile(path.join(this.dir(t.id), 'execution-events.jsonl'), '', { mode: 0o600 }).catch(() => {})
        }
      }

      await this.save(t)
      return t
    })
  },

  async applySourceEdit(id, { mode = 'source_edit', chapterId, review } = {}) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (this.active.has(id)) throw new Error('任务正在运行，请等待当前执行结束后再应用核证修补')
      if (t.legacy) throw new Error('旧项目归档记录保持只读')
      const normalizedChapter = String(chapterId ?? review?.chapter ?? '').replace(/^chapter_(\d{3,6})$/, '$1')
      if (!/^\d{3,6}$/.test(normalizedChapter)) throw new Error('请提供有效的章节编号 chapterId（如 "005"）')
      if (!review || typeof review !== 'object' || Array.isArray(review)) {
        throw new Error('请提供原页核证修补对象 review（须包含 basis 等核证说明）')
      }
      const scratchDir = path.join(this.dir(t.id), 'source-edit-requests')
      await fs.mkdir(scratchDir, { recursive: true })
      const reqFile = path.join(scratchDir, `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      try {
        await atomic(reqFile, review)
        const out = await this.command(t, this.python, [
          APPLY_SOURCE_EDIT,
          path.join(this.root, VISION),
          this.docDir(t),
          '--chapter', normalizedChapter,
          '--mode', mode === 'note_continuation' ? 'note_continuation' : 'source_edit',
          '--review-file', reqFile,
        ])
        const parsed = JSON.parse(out.trim().split('\n').at(-1))
        if (parsed.qualityStatus === 'program_checks_passed') {
          try { await this.acceptTranscriptionDelivery(t, normalizedChapter) } catch {}
        }
        await this.save(t)
        return parsed
      } finally {
        await fs.unlink(reqFile).catch(() => {})
      }
    })
  },
}
