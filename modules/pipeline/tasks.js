import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mapWorkspacePath, readWorkspaceMigration } from '../../shared/workspace.js'
import { PipelineIndex, fileStamp } from './storage.js'
import { importLegacyBooks } from './legacy.js'
import { importLegacyPapers } from './papers.js'
import { readPipelineConfiguration } from './configuration.js'
import { hash, markdownBlocks } from './markdown.js'
import { BookmarkStore } from './bookmarks.js'
import { cliStatus, LINGUAGACHA_CLI } from './cli.js'
import { analyseBookGlossary } from './glossary.js'
import { commitPublication } from './publication.js'
import { assertPhaseApproved } from './phases.js'
import {
  STAGES,
  validId,
  documentIdFor,
  exists,
  atomic,
  json,
  walk,
  parseModelChoice,
  resolveFallbacks,
  visionFallbackArgs,
} from './tasks/shared.js'
import { processRunnerMethods } from './tasks/process-runner.js'
import {
  blockedPagesFromReport,
  stuckPagesFromReports,
  reopenStuckBudget,
  stuckPagesMethods,
} from './tasks/stuck-pages.js'
import { structureProfileMethods } from './tasks/structure-profile.js'
import { runTranscriptionStage, transcriptionFlowMethods } from './tasks/transcription-flow.js'
import { runTranslationStage, translationFlowMethods } from './tasks/translation-flow.js'
import { runDeliveryStage, readingPublicationMethods } from './tasks/reading-publication.js'

export {
  STAGES,
  parseModelChoice,
  resolveFallbacks,
  visionFallbackArgs,
  blockedPagesFromReport,
  stuckPagesFromReports,
  reopenStuckBudget,
}

const DEFAULT_PUBLISH_ROOT = '/Users/hao/Documents/obsidian/obsidian/MD书籍'
const SOURCE_CATALOG_IGNORE_BASENAME = /check_report|audit|README|report|manifest|REMAINING|HANDOFF|^目录\.pdf$/i
const SOURCE_CATALOG_IGNORE_DIR = /(?:[\\/])(?:ocr|runs|llm_traces|logs|ai_convert|reference)[\\/]/i

export class TaskManager {
  constructor(root, readingRoot, options = {}) {
    this.root = root
    this.migration = readWorkspaceMigration(root)
    this.readingRoot = readingRoot
    this.base = path.join(root, '.pipeline/tasks')
    this.active = new Map()
    this.locks = new Map()
    this.publishRoot = options.publishRoot ?? DEFAULT_PUBLISH_ROOT
    this.python = options.python ?? '/opt/homebrew/bin/python3'
    this.bookmarkStore = new BookmarkStore(path.join(root, '.pipeline/bookmarks-v1.json'))
    this.cliExecutable = options.cliExecutable ?? LINGUAGACHA_CLI
    this.cliStatus = options.cliStatus ?? (() => cliStatus(this.root))
    this.fetch = options.fetch ?? fetch
    this.index = new PipelineIndex(root)
    this.indexReady = null
  }

  legacyIdentityPath(file) {
    return mapWorkspacePath(this.root, file, 'identity')
  }

  storagePath(file) {
    return mapWorkspacePath(this.root, file)
  }

  dir(id) {
    if (!validId(id)) throw new Error('任务编号无效')
    return path.join(this.base, id)
  }

  docDir(t) {
    return path.join(this.dir(t.id), 'document')
  }

  aiDir(t) {
    return path.join(this.docDir(t), 'ai_convert')
  }

  async locked(id, fn) {
    const before = this.locks.get(id) ?? Promise.resolve()
    const next = before.catch(() => {}).then(fn)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }

  async get(id) {
    const task = await json(path.join(this.dir(id), 'task.json'))
    if (!task) throw new Error('任务不存在')
    if (task.state === 'running' && !this.active.has(id)) {
      task.state = 'interrupted'
      task.stages[task.stage] = { ...task.stages[task.stage], state: 'interrupted' }
      task.message = '宿主重启后任务已中断，先检查产物再续跑'
      await this.save(task)
    }
    return task
  }

  async refreshLibraryProof(t) {
    if (t.legacy) return
    if (!t.publication?.published || !t.translationReport?.passed) {
      delete t.libraryProof
      return
    }
    try {
      const source = await this.original(t)
      const sourceStamp = await fileStamp(source)
      const targetStamp = await fileStamp(t.translationPath)
      if (t.libraryProof?.sourceStamp === sourceStamp && t.libraryProof?.targetStamp === targetStamp) return
      const src = await fs.readFile(source, 'utf8')
      const dst = await fs.readFile(t.translationPath, 'utf8')
      if (
        hash(src) !== t.translationReport.sourceFingerprint
        || hash(dst) !== t.translationReport.targetFingerprint
      ) {
        delete t.libraryProof
        return
      }
      t.libraryProof = { kind: 'pipeline', source, target: t.translationPath, sourceStamp, targetStamp }
    } catch {
      delete t.libraryProof
    }
  }

  async save(t) {
    return this.locked('save:' + t.id, async () => {
      t.schemaVersion = 2
      t.documentId = documentIdFor(t)
      t.updatedAt = new Date().toISOString()
      await this.refreshLibraryProof(t)
      const file = path.join(this.dir(t.id), 'task.json')
      await atomic(file, t)
      await this.index.put(t, await fileStamp(file))
      if (this.sessionMonitor) {
        await this.sessionMonitor.attempt(() => this.sessionMonitor.observe(t), t.id)
      }
      return t
    })
  }

  async ensureIndex() {
    if (!this.indexReady) {
      this.indexReady = (async () => {
        const stamps = await this.index.stamps()
        const taskIds = (await fs.readdir(this.base).catch(() => [])).filter(validId)
        for (const id of taskIds) {
          const file = path.join(this.dir(id), 'task.json')
          const stamp = await fileStamp(file)
          if (stamps.get(id) === stamp) continue
          const t = await this.get(id)
          let currentStamp = stamp
          if (!t.documentId || t.documentId === 'document:undefined' || t.schemaVersion !== 2) {
            const backup = path.join(this.root, '.pipeline/backups/storage-v2', `${id}.task.json`)
            await fs.mkdir(path.dirname(backup), { recursive: true })
            if (!await exists(backup)) {
              await fs.copyFile(file, backup)
              await fs.chmod(backup, 0o600)
            }
            t.input.fingerprint ??= t.inspection?.fingerprint
            t.documentId = documentIdFor(t)
            t.schemaVersion = 2
            await atomic(file, t)
            currentStamp = await fileStamp(file)
          }
          await this.refreshLibraryProof(t)
          await this.index.put(t, currentStamp)
        }
      })()
    }
    return this.indexReady
  }

  async list() {
    await this.ensureIndex()
    return this.index.all()
  }

  async listPage(query = {}) {
    await this.ensureIndex()
    return this.index.page(query)
  }

  async folders() {
    await this.ensureIndex()
    return this.index.getFolders()
  }

  async saveFolder(id, name) {
    await this.ensureIndex()
    return this.index.saveFolder(id, name)
  }

  async deleteFolder(id) {
    await this.ensureIndex()
    return this.index.deleteFolder(id)
  }

  async itemMeta() {
    await this.ensureIndex()
    return this.index.getAllItemMeta()
  }

  async setItemMeta(id, meta) {
    await this.ensureIndex()
    return this.index.setItemMeta(id, meta)
  }

  async importLegacy() {
    return this.locked('legacy-import', () => importLegacyBooks(this))
  }

  async importPapers() {
    return this.locked('paper-import', () => importLegacyPapers(this))
  }

  async adoptLegacy(id) {
    return this.locked(id, async () => {
      const old = await this.get(id)
      const file = old.legacy?.artifacts?.original
      if (!file) throw new Error('尚无完整装配原文，不能另建任务重置转写预算')
      const text = await fs.readFile(file, 'utf8')
      const fingerprint = hash(text)
      const existing = (await this.list()).find(
        t => t.sourceHistory?.taskId === id && t.input.fingerprint === fingerprint,
      )
      if (existing) {
        if (!old.libraryProof) await this.setItemMeta(id, { hidden: true })
        return existing
      }

      const now = new Date().toISOString()
      const t = {
        id: randomUUID(),
        documentId: old.documentId,
        documentTitle: old.name,
        name: old.name + ' · 接续',
        kind: old.kind,
        input: { id: hash(file), name: path.basename(file), type: 'markdown', fingerprint },
        path: file,
        worker: { provider: 'not_required', model: '现成 Markdown，不需转写', timeout: 600 },
        state: 'idle',
        stage: 'inspect',
        createdAt: now,
        stages: { inspect: { state: 'done', at: now } },
        inspection: { fingerprint, verdict: 'MARKDOWN', blocks: markdownBlocks(text).length, pages: 0 },
        profile: {
          document_type: old.kind,
          language: old.profile?.language ?? '',
          confirmed: false,
          source_fingerprint: fingerprint,
        },
        sourceHistory: {
          taskId: id,
          directory: old.legacy.directory,
          audit: old.legacy.artifacts.audit,
          budgets: old.legacy.artifacts.budgetFiles,
          transcriptionRepeated: false,
          originalQualityVerified: false,
        },
        bookmarks: [],
        log: [{ stage: 'legacyAdoption', command: '已有 Markdown 接续', exitCode: 0, endedAt: now }],
        lgUrl: '',
        message: '原项目成果、日志和转写预算保留；接续只处理现有 Markdown。',
      }
      if (!old.libraryProof) await this.setItemMeta(id, { hidden: true })
      return this.save(t)
    })
  }

  async catalog() {
    const files = [
      ...(await walk(path.join(this.root, 'Book'), /\.pdf$|\.md$|\.markdown$/i, 4)),
      ...(await walk(path.join(this.readingRoot, 'src'), /\.pdf$/i, 1)),
      ...(await walk(path.join(this.base, 'uploads'), /\.md$|\.markdown$|\.pdf$/i, 1)),
    ]
    const filtered = files.filter(
      f => !SOURCE_CATALOG_IGNORE_BASENAME.test(path.basename(f)) && !SOURCE_CATALOG_IGNORE_DIR.test(f),
    )
    const sources = []
    for (const f of filtered) {
      const st = await fs.stat(f)
      const relRoot = f.startsWith(this.root + path.sep) ? this.root : this.readingRoot
      sources.push({
        id: hash(f),
        name: path.relative(relRoot, f),
        type: /\.pdf$/i.test(f) ? 'pdf' : 'markdown',
        displayName: path.basename(f).replace(/^[a-f0-9-]{36}-/i, ''),
        bytes: st.size,
        path: f,
      })
    }
    return sources
  }

  async upload(name, bytes) {
    if (typeof name !== 'string' || !/\.(md|markdown|pdf)$/i.test(name) || bytes.length > 100 * 1024 * 1024) {
      throw new Error('只接受不超过100 MB的PDF或Markdown')
    }
    const safeName = path.basename(name).replace(/[^\w.\-一-鿿]/g, '_')
    const file = path.join(this.base, 'uploads', `${randomUUID()}-${safeName}`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
    return { sourceId: hash(file), filename: path.basename(name) }
  }

  async create(args) {
    const source = (await this.catalog()).find(s => s.id === args.sourceId)
    if (!source) throw new Error('请选择已登记的源文件')
    const isAuto = args.kind === 'auto' || !args.kind
    const detection = isAuto ? await this.detectSource(args.sourceId) : null
    if (detection) args = { ...args, kind: detection.kind }
    if (!['book', 'paper', 'chapter', 'collection'].includes(args.kind)) {
      throw new Error('文档类型无效')
    }

    const fingerprint = hash(await fs.readFile(source.path))
    if (args.forceNew !== true) {
      const existing = (await this.list()).find(
        t => t.kind === args.kind && t.input.fingerprint === fingerprint,
      )
      if (existing && await exists(existing.path)) return { ...existing, reused: true }
    }

    let provider
    let model
    let timeout
    if (args.workerId) {
      const choice = parseModelChoice(args.workerId)
      provider = choice.provider
      model = choice.model
      timeout = 600
    } else {
      const config = await readPipelineConfiguration(this.root, this.modelService)
      const worker = config.workers.find(w => w.default)
      if (!worker?.selectable) throw new Error('此模型不能作主转写')
      provider = worker.provider
      model = worker.model
      timeout = worker.timeout
    }

    const fallbacks = resolveFallbacks(`${provider}:${model}`, args.fallbackIds ?? [])
    await this.requireModel({ provider, model })
    for (const f of fallbacks) await this.requireModel(f)

    const t = {
      id: randomUUID(),
      name: String(args.name || source.displayName || path.basename(source.path)).slice(0, 150),
      kind: args.kind,
      typeSuggestion: detection,
      input: { ...source, fingerprint },
      path: source.path,
      worker: { provider, model, timeout, ...(fallbacks.length ? { fallbacks } : {}) },
      state: 'queued',
      stage: 'inspect',
      createdAt: new Date().toISOString(),
      stages: {},
      bookmarks: [],
      log: [],
      lgUrl: '',
    }
    await fs.mkdir(this.dir(t.id), { recursive: true })
    return this.save(t)
  }

  async detectSource(sourceId) {
    const source = (await this.catalog()).find(s => s.id === sourceId)
    if (!source) throw new Error('源文件未登记')
    return new Promise((resolve, reject) => execFile(
      this.python,
      [path.join(this.root, 'lingua/detect_document.py'), source.path],
      { cwd: this.root, timeout: 20000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error) return reject(new Error('类型识别未完成，可手动选择文档类型'))
        try {
          resolve({ ...JSON.parse(stdout), suggestedName: source.displayName ?? path.basename(source.path) })
        } catch {
          reject(new Error('类型识别结果无效'))
        }
      },
    ))
  }

  async rename(id, name) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (this.active.has(id)) throw new Error('任务运行中暂不能改名')
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) {
        throw new Error('任务名称须为1至150字')
      }
      t.name = name.trim()
      if (t.documentTitle) t.documentTitle = name.trim()
      return this.save(t)
    })
  }

  async library() {
    await this.importPapers()
    await this.ensureIndex()
    const result = []
    const seen = new Set()
    for (const { task: t, proof } of await this.index.library()) {
      let valid = proof.kind === 'legacy'
        ? await fileStamp(proof.readingPath) === proof.readingStamp
        : await fileStamp(proof.source) === proof.sourceStamp && await fileStamp(proof.target) === proof.targetStamp
      if (!valid && proof.kind === 'legacy') {
        const full = await this.get(t.id)
        const stamp = await fileStamp(proof.readingPath)
        if (stamp && hash(await fs.readFile(proof.readingPath)) === full.legacy?.readingFingerprint) {
          full.libraryProof = { ...proof, readingStamp: stamp }
          await this.save(full)
          valid = true
        }
      }
      if (!valid) {
        await this.index.clearProof(t.id)
        continue
      }
      const docKey = t.documentId ?? t.id
      if (seen.has(docKey)) continue
      seen.add(docKey)
      result.push({
        id: t.id,
        documentId: t.documentId,
        name: t.documentTitle ?? t.name,
        kind: t.kind,
        ready: true,
        ...(t.paperImport
          ? {
            author: t.paperImport.metadata.author?.zh ?? t.paperImport.metadata.author?.source,
            titleSource: t.paperImport.metadata.title?.source,
            legacyPaperFile: t.paperImport.file,
          }
          : {}),
      })
    }
    return result
  }

  async deleteTask(id) {
    return this.locked(id, async () => {
      if (this.active.has(id)) throw new Error('任务正在运行，不能删除')
      await this.ensureIndex()
      await this.index.removeTask(id)
      const taskDir = this.dir(id)
      const trashDir = path.join(this.root, '.pipeline/trash', id)
      try {
        await fs.mkdir(path.dirname(trashDir), { recursive: true })
        await fs.rename(taskDir, trashDir)
      } catch {
        try { await fs.rm(taskDir, { recursive: true, force: true }) } catch {}
      }
      return { ok: true }
    })
  }

  async openSource(id) {
    const t = await this.get(id)
    const source = t.legacy?.artifacts?.sourcePdf ?? (t.input.type === 'pdf' ? t.path : null)
    if (!source || !await exists(source)) throw new Error('未找到该任务对应的原 PDF 文件')
    return new Promise((resolve, reject) => {
      execFile('open', [source], err => {
        if (err) reject(new Error('调用系统预览失败: ' + err.message))
        else resolve({ ok: true, path: source })
      })
    })
  }

  async requireDone(t, ...stages) {
    for (const s of stages) {
      if (t.stages[s]?.state !== 'done') {
        throw new Error(`先完成${STAGES.find(x => x.id === s)?.name ?? s}`)
      }
    }
  }

  async start(id, stage, options = {}, execution = {}) {
    return this.locked(id, async () => {
      if (['translate_prepare', 'translation_prepare', 'prepare_translation'].includes(stage)) {
        stage = 'lgProject'
      }
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目记录保持只读；请接续现有原文，保留转写预算')
      if (this.active.has(id)) throw new Error('此任务正在运行')
      assertPhaseApproved(t, stage)
      if (this.requireExecutionSessions && !this.sessionMonitor && !['review', 'publish'].includes(stage)) {
        throw new Error('DSH 会话服务尚未就绪，处理尚未启动')
      }
      if (this.sessionMonitor && !['review', 'publish'].includes(stage)) {
        await this.sessionMonitor.ensure(t)
      }

      const isPdf = t.input?.type === 'pdf'
      const transcriptionSteps = isPdf
        ? ['inspect', 'normalize', 'images', 'prepare', 'transcribe', 'verify', 'assemble']
        : ['inspect']
      const translationSteps = ['glossary', 'lgProject', 'translate', 'translationCheck']
      const deliverySteps = stage === 'publish' ? ['publish'] : ['review']

      let macroPhase = null
      let steps = null
      if (stage === 'transcription' || transcriptionSteps.includes(stage)) {
        macroPhase = 'transcription'
        steps = transcriptionSteps
      } else if (stage === 'translation' || translationSteps.includes(stage)) {
        macroPhase = 'translation'
        steps = translationSteps
      } else if (stage === 'delivery' || deliverySteps.includes(stage)) {
        macroPhase = 'delivery'
        steps = deliverySteps
      }

      if (!steps && !STAGES.some(s => s.id === stage)) throw new Error('处理入口无效')

      const isChain = stage !== 'verify' && !options.singleStep && Boolean(macroPhase)
      const executionChain = isChain ? steps : [stage]

      let startIndex = 0
      if (isChain) {
        const requestedIndex = executionChain.indexOf(stage)
        const firstPendingIndex = executionChain.findIndex(s => t.stages[s]?.state !== 'done')
        startIndex = Math.max(0, requestedIndex >= 0 ? requestedIndex : (firstPendingIndex >= 0 ? firstPendingIndex : 0))
        if (firstPendingIndex >= 0 && firstPendingIndex < startIndex) {
          startIndex = firstPendingIndex
        }
      }

      const initialStep = executionChain[startIndex] || stage
      if (initialStep === 'inspect' && (t.scope || t.stages.lgProject?.state === 'done')) {
        throw new Error('底本已锁定，变更输入须建立新任务')
      }
      if (['lgProject', 'translate'].includes(initialStep)) await this.requireGlossary(t)
      if (isChain && initialStep === 'normalize' && !t.profile?.confirmed) {
        await this.autoConfirmProfileAndScope(t)
      }
      if (initialStep !== 'inspect') await this.confirmed(t)

      const lingua = ['glossary', 'translate', 'lgProject'].some(s => executionChain.includes(s))
      if (lingua && [...this.active.keys()].some(other => other !== id && this.active.get(other).translationCli)) {
        throw new Error('LinguaGacha 正在处理另一任务')
      }
      if (t.translationEngine === 'http' && ['translate', 'lgProject'].some(s => executionChain.includes(s)) && !t.lgUrl) {
        throw new Error('先连接 LinguaGacha 本地服务')
      }

      execution.signal?.throwIfAborted()
      if (execution.sessionId) {
        t.execution = {
          sessionId: execution.sessionId,
          requestedStage: stage,
          startedAt: new Date().toISOString(),
        }
      }
      t.stage = initialStep
      t.state = 'running'
      t.message = `正在执行${STAGES.find(s => s.id === initialStep)?.name ?? initialStep}`

      const active = {
        sessionId: execution.sessionId,
        requestedStage: stage,
        cancel: false,
        child: null,
        children: new Set(),
        translationCli: lingua,
        lgUrl: t.translationEngine === 'http' && ['translate', 'lgProject'].some(s => executionChain.includes(s))
          ? t.lgUrl
          : null,
      }
      this.active.set(id, active)
      await this.save(t)

      active.promise = (async () => {
        for (let i = startIndex; i < executionChain.length; i++) {
          const currentStage = executionChain[i]
          if (active.cancel) {
            t.state = 'paused'
            t.stages[currentStage] = { state: 'stopped' }
            t.message = '任务已暂停，已完成阶段保留'
            await this.save(t)
            break
          }

          const skipCompleted = (
            t.stages[currentStage]?.state === 'done'
            && !options.reanalyze
            && !options.retryErrors
            && !(currentStage === 'review' && (options.runAgy === true || options.sessionOrchestrated === true))
          )
          if (skipCompleted) continue

          if (currentStage === 'normalize' && !t.profile?.confirmed) {
            await this.autoConfirmProfileAndScope(t)
          }
          if (currentStage === 'prepare' && ['book', 'collection'].includes(t.kind) && !t.structureConfirmed && !t.observationConfirmed) {
            await this.autoConfirmChapterStructure(t)
          }

          if (currentStage !== 'inspect') await this.confirmed(t)
          if (['lgProject', 'translate'].includes(currentStage)) await this.requireGlossary(t)
          if (
            currentStage === 'transcribe'
            && t.stages.transcribe?.state === 'done'
            && (t.inspection?.verdict !== 'BORN-DIGITAL' || t.profile.transcription_method === 'vision')
          ) {
            for (const c of await this.chapters(t)) {
              try {
                await this.acceptTranscriptionDelivery(t, c.id)
              } catch (e) {
                t.state = 'blocked'
                t.stages.transcribe = { state: 'blocked' }
                t.message = e.message
                await this.save(t)
                throw e
              }
            }
          }

          t.stage = currentStage
          t.stages[currentStage] = { state: 'running' }
          t.message = `正在执行${STAGES.find(s => s.id === currentStage)?.name ?? currentStage}`
          await this.save(t)

          await this.perform(t, currentStage, options)
          if (currentStage === 'review' && t.review?.status === 'needs-work') {
            throw Object.assign(
              new Error('审校结果已返回，但仍有未决问题；请查看分包原因并补充证据或处理术语冲突'),
              { code: 'REVIEW_NEEDS_WORK' },
            )
          }

          if (currentStage === 'verify' && t.input?.type === 'pdf' && (t.stages.transcribe?.state !== 'done' || options.chapterId)) {
            delete t.stages.verify
          } else if (currentStage === 'transcribe' && options.chapterId) {
            const allChapters = await this.chapters(t).catch(() => [])
            const allPassed = allChapters.length > 0 && allChapters.every(
              c => t.transcriptionDeliveries?.[c.id]?.quality === 'program_checks_passed',
            )
            if (allPassed) t.stages.transcribe = { state: 'done', at: new Date().toISOString() }
            else delete t.stages.transcribe
          } else {
            t.stages[currentStage] = { state: 'done', at: new Date().toISOString() }
          }
          await this.save(t)

          if (active.cancel) {
            t.state = 'paused'
            t.message = '任务已暂停，已完成阶段保留'
            await this.save(t)
            break
          }

          if (currentStage === 'publish' && !t.publication?.published) {
            assertPhaseApproved(t, 'publish')
            t.publication = await commitPublication(this, t, true)
            await this.save(t)
          }
        }

        if (!active.cancel) {
          t.state = 'idle'
          if (!isChain) {
            t.message = `${STAGES.find(s => s.id === t.stage)?.name ?? t.stage}已完成`
          } else if (macroPhase === 'transcription') {
            t.message = '转写已完成，请在面板选择模型并确认进入术语分析与翻译'
          } else if (macroPhase === 'translation') {
            t.message = '术语分析、翻译与校验已完成，请在面板选择模型并确认进入审校与发布'
          } else if (macroPhase === 'delivery') {
            t.message = t.publication?.published ? '已发布，文献已可阅读' : '审校已完成，确认发布清单后再发布'
          } else {
            t.message = t.stage === 'inspect'
              ? (t.profileAnalysis?.status === 'model_failed'
                ? '模型结构分析未完成，已保留程序检查结果，可重试分析或核对配置。'
                : '结构分析已完成。')
              : '阶段已完成'
          }
        }
      })().catch(e => {
        const failed = t.stage
        const paused = active.cancel || ['AGY_IDLE_TIMEOUT', 'REVIEW_IDLE_TIMEOUT'].includes(e.code)
        t.stages[failed] = { state: paused ? 'stopped' : 'blocked' }
        t.state = paused ? 'paused' : 'blocked'
        t.message = active.cancel && ['paddle', 'mineru'].includes(failed)
          ? '已停止本地等待；云端任务可能继续，恢复时复用已保存的任务编号'
          : String(e.message)
      }).finally(async () => {
        if (execution.sessionId) {
          t.execution = { ...t.execution, endedAt: new Date().toISOString(), state: t.state }
        }
        try {
          await this.save(t)
        } finally {
          this.active.delete(id)
        }
      })

      return t
    })
  }

  async stop(id) {
    const active = this.active.get(id)
    if (!active) return this.get(id)
    active.cancel = true
    for (const c of active.controllers ?? []) c.abort()
    if (active.children) {
      for (const child of active.children) {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        const timer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
        }, 5000)
        timer.unref()
      }
    }
    if (active.child) {
      try { process.kill(-active.child.pid, 'SIGTERM') } catch {}
      const child = active.child
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }, 5000)
      timer.unref()
    }
    if (active.lgUrl && (await this.get(id)).stage === 'translate') {
      await this.lg(await this.get(id), '/api/batch-translation/stop', {})
    }
    await active.promise
    return this.get(id)
  }

  async perform(t, stage, options = {}) {
    if (['lgProject', 'translate'].includes(stage)) {
      return this.locked('linguagacha-cli', async () => {
        await this.checkPhaseModel(t, stage)
        return this.performBody(t, stage, options)
      })
    }
    await this.checkPhaseModel(t, stage)
    if (stage === 'review') {
      options = {
        ...options,
        model: t.reviewConfig.orchestratorModel,
        effort: t.reviewConfig.orchestratorEffort,
      }
    }
    return this.performBody(t, stage, options)
  }

  async performBody(t, stage, options = {}) {
    if (await runTranscriptionStage(this, t, stage, options)) return
    if (stage === 'glossary') {
      await analyseBookGlossary(this, t, options)
      return
    }
    if (await runTranslationStage(this, t, stage, options)) return
    if (await runDeliveryStage(this, t, stage, options)) return
  }
}

Object.assign(
  TaskManager.prototype,
  processRunnerMethods,
  stuckPagesMethods,
  structureProfileMethods,
  transcriptionFlowMethods,
  translationFlowMethods,
  readingPublicationMethods,
)
