import fs from 'node:fs/promises'
import path from 'node:path'
import { splitModel } from '../harness-models.js'
import { mergeProfileAnalysis, normalizeProfileAnalysis, profileReadiness } from '../profile-analysis.js'
import { assertAcademicPreprocessing } from '../cli.js'
import { normalizeReviewConfig, isAgyCliModel } from '../review-audit.js'
import { normalizeGlossaryDomains } from '../glossary-semantics.js'
import { PHASES, phaseReady, assertPhaseApproved } from '../phases.js'
import { hash } from '../markdown.js'
import { ensureTaskCover } from '../cover.js'
import { taskSourcePdf } from '../source-map.js'
import {
  VISION,
  TEXT,
  ANALYZER,
  RESOLVE_ENDNOTES,
  OCR_REGION_SCRIPT,
  PROBE_PAGES_SCRIPT,
  exists,
  atomic,
  json,
  parseModelChoice,
  resolveFallbacks,
  visionFallbackArgs,
} from './shared.js'

export const structureProfileMethods = {
  async confirmed(t) {
    if (!t.profile?.confirmed) throw new Error('先检查输入并确认结构配置')
    if (t.profile.source_fingerprint !== hash(await fs.readFile(t.path))) {
      throw new Error('源文件已变化，必须重新确认')
    }
    if (t.scope && t.scope.fingerprint !== hash(await fs.readFile(path.join(this.docDir(t), 'source.pdf')))) {
      throw new Error(
        '范围底本或页映射已变化，停止处理：document/source.pdf 与范围快照不一致；不要更换阶段或 retryErrors/reanalyze 反复试运行，先核查底本变化',
      )
    }
    if (t.scope && t.scope.profileFingerprint !== hash(await fs.readFile(path.join(this.docDir(t), 'document_profile.json')))) {
      throw new Error(
        '文档体例与范围快照不一致；若仅调整体例且物理范围未变，使用 document_pipeline sync_profile 校验同步，再续跑；不要用 reanalyze 或 reset_transcription 试探',
      )
    }
  },

  async updateWorker(id, workerId) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目模型记录保持只读；请接续现有 Markdown 后再配置后续任务')
      if (t.legacy?.progress?.auditRecords || t.legacy?.progress?.budget?.length) {
        throw new Error('旧任务的模型与历史预算保留，不能切换后重新转写')
      }
      if (this.active.has(id) || t.state === 'running') throw new Error('任务正在运行，不能更换转写模型')

      const choice = await this.requireModel(parseModelChoice(workerId))
      const kept = (t.worker.fallbacks ?? []).filter(
        item => !(item.provider === choice.provider && item.model === choice.model),
      )
      t.worker = {
        provider: choice.provider,
        model: choice.model,
        timeout: t.worker.timeout ?? 600,
        ...(kept.length ? { fallbacks: kept } : {}),
      }
      if (t.transcriptionPlan) {
        t.transcriptionPlan = { ...t.transcriptionPlan, worker: structuredClone(t.worker) }
      }
      t.message = '转写模型已更新；继续前请确认阶段配置，已有成果、处理记录与已用预算保留'
      return this.save(t)
    })
  },

  async updateFallbacks(id, fallbackIds) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目模型记录保持只读；请接续现有 Markdown 后再配置后续任务')
      if (this.active.has(id)) throw new Error('任务正在运行，不能更换兜底模型')

      const fallbacks = resolveFallbacks(`${t.worker.provider}:${t.worker.model}`, fallbackIds)
      for (const f of fallbacks) await this.requireModel(f)
      if (fallbacks.length) t.worker.fallbacks = fallbacks
      else delete t.worker.fallbacks
      if (t.transcriptionPlan) {
        t.transcriptionPlan = { ...t.transcriptionPlan, worker: structuredClone(t.worker) }
      }
      t.message = fallbacks.length
        ? '兜底模型已更新，不重置主模型与已用预算'
        : '已清除兜底模型，不重置主模型与已用预算'
      return this.save(t)
    })
  },

  async modelPreferences() {
    const file = path.join(this.root, '.pipeline', 'preferences.json')
    const saved = await json(file, null)
    const models = saved?.models && typeof saved.models === 'object' ? saved.models : {}
    return {
      schemaVersion: 1,
      updatedAt: saved?.updatedAt ?? null,
      models: {
        transcription: models.transcription ?? {},
        translation: models.translation ?? {},
        delivery: models.delivery ?? {},
      },
      glossaryDomains: normalizeGlossaryDomains(saved?.glossaryDomains ?? []),
    }
  },

  async saveModelPreferences(patch = {}) {
    return this.locked('preferences', async () => {
      const current = await this.modelPreferences()
      const nextModels = { ...current.models }
      for (const phase of ['transcription', 'translation', 'delivery']) {
        const incoming = patch?.models?.[phase]
        if (incoming && typeof incoming === 'object') {
          nextModels[phase] = { ...nextModels[phase], ...incoming }
        }
      }
      const next = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        models: nextModels,
        glossaryDomains: patch.glossaryDomains !== undefined
          ? normalizeGlossaryDomains(patch.glossaryDomains)
          : current.glossaryDomains,
      }
      await atomic(path.join(this.root, '.pipeline', 'preferences.json'), next)
      return next
    })
  },

  async updateReviewConfig(id, config) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (this.active.has(id) && t.stage === 'review') throw new Error('审校阶段运行中，不能更换审校模型')
      t.reviewConfig = normalizeReviewConfig(config)
      await this.requireModel(splitModel(t.reviewConfig.orchestratorModel))
      if (t.reviewConfig.workerModel !== 'inherit') {
        await this.requireModel(splitModel(t.reviewConfig.workerModel))
      }
      t.message = '审校模型与分包 Worker 配置已更新'
      const saved = await this.save(t)
      await this.saveModelPreferences({ models: { delivery: t.reviewConfig } }).catch(() => {})
      return saved
    })
  },

  async confirmPhase(id, choices) {
    const phase = choices.phase
    if (!PHASES.some(p => p.id === phase)) throw new Error('阶段无效')
    const previous = await this.get(id)
    phaseReady(previous, phase)
    if (this.active.has(id)) throw new Error('任务运行中不能确认下一阶段')
    if (phase !== 'delivery' && !choices.orchestratorModel) throw new Error('请选择本阶段的编排模型')

    const orchestratorEffort = typeof choices.orchestratorEffort === 'string' ? choices.orchestratorEffort : ''
    if (choices.orchestratorModel) {
      await this.requireModel({
        ...splitModel(choices.orchestratorModel),
        ...(orchestratorEffort ? { reasoningEffort: orchestratorEffort } : {}),
      })
    }

    if (phase === 'transcription' && previous.input.type === 'pdf') {
      if (!choices.workerId) throw new Error('请选择转写模型')
      if (choices.workerId !== `${previous.worker.provider}:${previous.worker.model}`) {
        await this.updateWorker(id, choices.workerId)
      }
      if (choices.fallbackIds) await this.updateFallbacks(id, choices.fallbackIds)
    }

    let translationModel
    let reviewConfig
    if (phase === 'translation') {
      if ([...this.active.values()].some(a => a.translationCli)) {
        throw new Error('LinguaGacha 运行中不能更换或确认模型')
      }
      if (choices.translationProfile) await this.selectTranslationModel(choices.translationProfile)
      const status = await this.cliStatus()
      assertAcademicPreprocessing(status)
      if (!status.model?.credentialConfigured) throw new Error('当前术语与翻译模型缺少凭证')
      translationModel = { name: status.model.name, model: status.model.model }
    }

    if (phase === 'delivery') {
      reviewConfig = normalizeReviewConfig(choices.reviewConfig)
      if (!reviewConfig.orchestratorModel) throw new Error('请选择审校模型')
      if (this.modelService) {
        await this.requireModel({
          ...splitModel(reviewConfig.orchestratorModel),
          ...(reviewConfig.orchestratorEffort ? { reasoningEffort: reviewConfig.orchestratorEffort } : {}),
        })
        if (reviewConfig.workerModel !== 'inherit') {
          await this.requireModel(splitModel(reviewConfig.workerModel))
        }
      }
    }

    return this.locked(id, async () => {
      const t = await this.get(id)
      phaseReady(t, phase)
      if (this.active.has(id)) throw new Error('任务正在运行')

      if (reviewConfig) {
        t.reviewConfig = reviewConfig
        if (!isAgyCliModel(reviewConfig.orchestratorModel) && t.reviewProgress) {
          delete t.reviewProgress.conversationId
          delete t.reviewProgress.childConversations
          delete t.reviewProgress.logFile
          delete t.reviewProgress.pid
        }
      }
      if (translationModel && this.requireHarnessModels) t.translationEngine = 'cli'
      if (translationModel) {
        t.profile = {
          ...t.profile,
          glossary_model: translationModel.model,
          translation_model: translationModel.model,
        }
      }
      if (phase === 'translation' && choices.glossaryDomains !== undefined) {
        t.glossaryDomains = normalizeGlossaryDomains(choices.glossaryDomains)
      }
      t.phaseApproval = {
        phase,
        confirmedAt: new Date().toISOString(),
        orchestratorModel: choices.orchestratorModel,
        orchestratorEffort,
        workerId: `${t.worker.provider}:${t.worker.model}`,
        fallbacks: t.worker.fallbacks ?? [],
        ...(translationModel ? { translationModel } : {}),
        ...(reviewConfig ? { reviewConfig, publishAccepted: false } : {}),
      }
      t.message = `已确认${PHASES.find(p => p.id === phase).name}阶段；其他阶段须另行在面板确认`
      const saved = await this.save(t)
      const prefModels = {}
      if (phase === 'transcription') {
        prefModels.transcription = {
          orchestratorModel: choices.orchestratorModel ?? '',
          orchestratorEffort,
          workerId: `${t.worker.provider}:${t.worker.model}`,
          fallbackIds: (t.worker.fallbacks ?? []).map(f => `${f.provider}:${f.model}`),
        }
      } else if (phase === 'translation') {
        prefModels.translation = {
          orchestratorModel: choices.orchestratorModel ?? '',
          orchestratorEffort,
          ...(choices.translationProfile ? { translationProfile: choices.translationProfile } : {}),
        }
      } else if (phase === 'delivery' && reviewConfig) {
        prefModels.delivery = reviewConfig
      }
      const prefPatch = { models: prefModels }
      if (phase === 'translation' && choices.glossaryDomains !== undefined) {
        prefPatch.glossaryDomains = t.glossaryDomains
      }
      await this.saveModelPreferences(prefPatch).catch(() => {})
      return saved
    })
  },

  async checkPhaseModel(t, stage) {
    assertPhaseApproved(t, stage)
    if (this.requireHarnessModels && !this.modelService) throw new Error('DSH 模型服务尚未就绪')
    if (this.modelService && stage === 'transcribe') {
      await this.requireModel(t.worker)
      for (const f of t.worker.fallbacks ?? []) await this.requireModel(f)
    }
    if (['glossary', 'lgProject', 'translate'].includes(stage)) {
      if (this.requireHarnessModels && t.translationEngine === 'http') {
        throw new Error('旧版翻译连接已停用，请从 DSH 目录重新选择模型并确认翻译阶段')
      }
      const status = await this.cliStatus()
      const approved = t.phaseApproval.translationModel
      if (!approved || status.model.name !== approved.name || status.model.model !== approved.model) {
        throw new Error('术语与翻译模型已变化，请在面板重新选择并确认，不自动换模型')
      }
    }
  },

  async analyzeProfile(t, options = {}) {
    const fingerprint = t.inspection.fingerprint
    const directory = path.join(this.dir(t.id), 'profile-analysis')
    const fallbackArgs = visionFallbackArgs(t.worker)
    const fallbacks = fallbackArgs.filter((_, i) => i % 2 === 1).map(id => parseModelChoice(id))
    const workerCallText = await fs.readFile(path.join(this.root, VISION, 'worker_call.py'), 'utf8').catch(e => {
      if (e.code === 'ENOENT') return ''
      throw e
    })
    const runtimeFingerprint = hash(await fs.readFile(ANALYZER, 'utf8') + '\n' + workerCallText)
    let report = await json(path.join(directory, 'analysis.json'), null)

    const failureRuntimeChanged = report?.status === 'model_failed' && report.runtimeFingerprint !== runtimeFingerprint
    const shouldRun = (
      options.reanalyze
      || options.retryErrors
      || failureRuntimeChanged
      || report?.schemaVersion !== 1
      || report.fingerprint !== fingerprint
      || !['complete', 'model_failed', 'local_only'].includes(report.status)
      || report.provider !== t.worker.provider
      || report.model !== t.worker.model
      || JSON.stringify(report.fallbacks ?? []) !== JSON.stringify(fallbacks)
      || (report.kind && report.kind !== t.kind)
    )

    if (shouldRun) {
      t.message = '正在采样分析文档语言、版面与注释体例'
      await this.save(t)
      const args = [
        ANALYZER,
        '--source', t.path,
        '--output', directory,
        '--root', this.root,
        '--provider', t.worker.provider,
        '--model', t.worker.model,
        '--kind', t.kind,
        ...fallbackArgs,
      ]
      await this.command(t, this.python, args)
      if (this.active.get(t.id)?.cancel) throw new Error('任务已停止')
      report = await json(path.join(directory, 'analysis.json'), null)
      if (!report || report.fingerprint !== fingerprint) {
        throw new Error('结构分析未生成当前源文件的结果')
      }
      report = { ...report, runtimeFingerprint, kind: t.kind, fallbacks }
      await atomic(path.join(directory, 'analysis.json'), report)
    }

    if (hash(await fs.readFile(t.path)) !== fingerprint) {
      throw new Error('源文件在分析期间发生变化，请重新检查')
    }
    report = normalizeProfileAnalysis(report)
    const preserveSaved = await exists(path.join(this.dir(t.id), 'profile.json'))
    t.profile = mergeProfileAnalysis(t, report, { preserveSaved })
    t.profileAnalysis = { ...report, appliedAt: new Date().toISOString(), preservedUserProfile: preserveSaved }
    if (t.input?.type === 'pdf' && t.cover?.source !== 'manual') {
      await ensureTaskCover(this, t, {
        page: t.profile?.cover_page,
        force: t.profile?.cover_page !== undefined && t.profile?.cover_page !== t.cover?.page,
        source: 'profile',
      }).catch(() => null)
    }
  },

  async updateProfile(id, profile) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务')
      if (this.active.has(id)) throw new Error('运行中不能修改结构')
      if (t.stages.normalize?.state === 'done' || t.stages.lgProject?.state === 'done') {
        throw new Error('底本已确定，结构变更须建立新任务')
      }
      if (!t.inspection) throw new Error('先完成输入检查')

      const docType = ['book', 'paper', 'chapter', 'collection'].includes(profile.document_type)
        ? profile.document_type
        : t.kind
      t.kind = docType
      profile = { ...profile, document_type: docType, source_fingerprint: t.inspection.fingerprint }

      const file = path.join(this.dir(id), 'profile.candidate.json')
      await atomic(file, profile)
      if (t.input.type === 'pdf') {
        await this.py(t, 'document_pipeline.py', ['validate', t.path, '--profile', file])
      } else if (profile.confirmed !== true || !/^[a-z]{2,3}$/.test(profile.language ?? '')) {
        throw new Error('请确认原文语言与范围')
      }
      await fs.rename(file, path.join(this.dir(id), 'profile.json'))
      t.profile = profile
      if (t.input?.type === 'pdf' && profile.cover_page !== undefined) {
        await ensureTaskCover(this, t, {
          page: profile.cover_page === null || profile.cover_page === '' ? null : Number(profile.cover_page),
          force: true,
          source: 'manual',
        }).catch(() => null)
      }
      delete t.stages.translationCheck
      delete t.stages.publish
      return this.save(t)
    })
  },

  async syncProfile(id) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目记录保持只读')
      if (!t.inspection || !t.scope) throw new Error('任务尚未完成范围规范化')

      const candidatePath = path.join(this.dir(id), 'profile.candidate.json')
      const profilePath = path.join(this.dir(id), 'profile.json')
      const docProfilePath = path.join(this.docDir(t), 'document_profile.json')
      const baPath = path.join(this.aiDir(t), 'book_analysis.json')

      let sourceProfile = t.profile || {}
      if (await exists(candidatePath)) {
        try {
          sourceProfile = { ...sourceProfile, ...JSON.parse(await fs.readFile(candidatePath, 'utf8')) }
        } catch {}
      } else if (await exists(profilePath)) {
        try {
          sourceProfile = { ...sourceProfile, ...JSON.parse(await fs.readFile(profilePath, 'utf8')) }
        } catch {}
      }

      const pdfPath = path.join(this.docDir(t), 'source.pdf')
      if (await exists(pdfPath)) {
        const pdfHash = hash(await fs.readFile(pdfPath))
        if (t.scope.fingerprint !== pdfHash) {
          throw new Error('底本 source.pdf 物理内容已变化，必须重新规范化或新建任务')
        }
      }

      await atomic(profilePath, sourceProfile)
      t.profile = sourceProfile

      if (await exists(docProfilePath)) {
        const curDocProfile = await json(docProfilePath, {})
        const updatedDocProfile = { ...curDocProfile, ...sourceProfile }
        await atomic(docProfilePath, updatedDocProfile)
        t.scope.profileFingerprint = hash(await fs.readFile(docProfilePath))
      }

      if (await exists(baPath)) {
        const curBa = await json(baPath, {})
        const effectiveBa = { ...curBa, ...sourceProfile }
        await atomic(baPath, effectiveBa)
        const newBaHash = hash(await fs.readFile(baPath))

        const deliveryBase = path.join(this.aiDir(t), 'delivery')
        if (await exists(deliveryBase)) {
          for (const d of await fs.readdir(deliveryBase).catch(() => [])) {
            const stPath = path.join(deliveryBase, d, 'state.json')
            if (await exists(stPath)) {
              try {
                const st = JSON.parse(await fs.readFile(stPath, 'utf8'))
                if (st.source_hashes && 'ai_convert/book_analysis.json' in st.source_hashes) {
                  st.source_hashes['ai_convert/book_analysis.json'] = newBaHash
                  await atomic(stPath, st)
                }
              } catch {}
            }
          }
        }
      }

      await this.save(t)
      return {
        ok: true,
        scope: t.scope,
        profile: t.profile,
        message: '底本体例与指纹快照已无损同步，所有阶段可安全续跑。',
      }
    })
  },

  async ensureTaskCover(t, options = {}) {
    return ensureTaskCover(this, t, options)
  },

  async setTaskCoverPage(id, coverPage) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      const hasPdf = t.input?.type === 'pdf' || Boolean(await taskSourcePdf(this, t).catch(() => null))
      if (!hasPdf) throw new Error('仅支持为含源 PDF 的文献设置封面页')
      const rawEmpty = coverPage === null || coverPage === '' || coverPage === undefined
      const page = rawEmpty ? null : Number(coverPage)
      await ensureTaskCover(this, t, { page, force: true, source: 'manual' })
      t.message = page ? `已标记第 ${page} 页为封面页并生成静态封面图` : '已标记为无独立封面'
      const saved = await this.save(t)
      this.scheduleBackgroundSync?.(4000, 'cover')
      return saved
    })
  },

  async autoConfirmProfileAndScope(t) {
    if (t.profile?.confirmed) return t.profile
    if (!t.inspection) throw new Error('先完成输入检查')

    const candidateFile = /^[\w-]{8,100}$/.test(String(t?.id))
      ? path.join(this.dir(t.id), 'profile.candidate.json')
      : null
    if (candidateFile && await exists(candidateFile)) {
      try {
        const candidate = JSON.parse(await fs.readFile(candidateFile, 'utf8'))
        if (candidate && typeof candidate === 'object') {
          t.profile = { ...(t.profile || {}), ...candidate }
        }
      } catch {}
    }

    if (!t.profileAnalysis) await this.analyzeProfile(t)
    if (t.profileAnalysis?.status === 'model_failed' && !t.profile?.language) {
      const codes = (t.profileAnalysis.attempts ?? []).map(a => a.errorCode).filter(Boolean)
      const suffix = codes.length ? `；失败代码：${[...new Set(codes)].join('、')}` : ''
      throw new Error(
        `体例分析失败，已选模型及已配置兜底均未产生有效结果${suffix}。修复调用配置后续跑；同一失败不会自动重复请求。`,
      )
    }

    const readiness = profileReadiness(t)
    if (!readiness.ready) {
      throw Object.assign(new Error(readiness.message), {
        code: 'PROFILE_INCOMPLETE',
        missing: readiness.missing,
      })
    }

    const docType = (['book', 'paper', 'chapter', 'collection'].includes(t.profile?.document_type)
      ? t.profile.document_type
      : t.kind) || 'book'
    t.kind = docType

    const totalPages = Number(t.inspection?.pages ?? 0)
    const startPage = Number(t.profile?.start_page || 1)
    const endPage = Number(t.profile?.end_page || (totalPages > 0 ? totalPages : 1))
    const language = String(t.profile.language).trim().toLowerCase()
    const profile = {
      ...t.profile,
      document_type: docType,
      language,
      start_page: startPage,
      end_page: endPage,
      source_fingerprint: t.inspection.fingerprint,
      confirmed: true,
    }

    const file = path.join(this.dir(t.id), 'profile.candidate.json')
    await atomic(file, profile)
    if (t.input.type === 'pdf' && await exists(t.path)) {
      await this.py(t, 'document_pipeline.py', ['validate', t.path, '--profile', file])
    }
    await fs.rename(file, path.join(this.dir(t.id), 'profile.json'))
    t.profile = profile
    if (t.input?.type === 'pdf' && t.cover?.source !== 'manual') {
      await ensureTaskCover(this, t, {
        page: profile.cover_page,
        force: profile.cover_page !== undefined && profile.cover_page !== t.cover?.page,
        source: 'profile',
      }).catch(() => null)
    }
    delete t.stages.translationCheck
    delete t.stages.publish
    t.message = '模型已自动确认文档体例、语言与有效底本范围'
    await this.save(t)
    return t.profile
  },

  async saveChapterStructureData(t, chapters) {
    const ai = this.aiDir(t)
    await fs.mkdir(ai, { recursive: true })
    if (!Array.isArray(chapters) || chapters.length === 0) {
      throw new Error('至少需要确认一个有效章节')
    }
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]
      const invalidNotePages = c.note_pages && (
        !Array.isArray(c.note_pages)
        || c.note_pages.length !== 2
        || !c.note_pages.every(p => Number.isInteger(p) && p > 0 && (!t.scope?.pages || p <= t.scope.pages))
        || c.note_pages[0] > c.note_pages[1]
      )
      const invalidRange = (
        !c.title
        || !Number.isInteger(c.start_page)
        || !Number.isInteger(c.end_page)
        || c.start_page > c.end_page
        || c.start_page < 1
        || (t.scope?.pages && c.end_page > t.scope.pages)
        || (c.id && !/^[a-zA-Z0-9_-]{1,32}$/.test(c.id))
        || chapters.slice(0, i).some(p => p.id && p.id === c.id)
        || invalidNotePages
      )
      if (invalidRange) throw new Error(`章节 ${c.id || i + 1} 起止页码无效`)
      if (i > 0 && c.start_page <= chapters[i - 1].end_page) {
        throw new Error(`章节 ${c.id || i + 1} 页范围不能重叠`)
      }
    }

    let resolvedChapters = chapters
    const isBookEndNotes = t.profile?.note_location === 'book_end_notes' || t.profile?.book_type === 'endnote_only'
    const docPdf = path.join(this.docDir(t), 'source.pdf')
    if (isBookEndNotes && await exists(docPdf)) {
      try {
        const out = await this.command(t, this.python, [RESOLVE_ENDNOTES, docPdf, JSON.stringify(chapters)])
        const parsed = JSON.parse(out.trim().split('\n').at(-1))
        if (Array.isArray(parsed) && parsed.length > 0) resolvedChapters = parsed
      } catch {}
    }

    const isNotesEntry = c => (
      c.role_hint === 'notes'
      || (isBookEndNotes && /(?:^|\b)(?:notes?|anmerkungen|endnotes?|annotations?|注释)(?:\b|$)/i.test(c.title))
    )
    const bodyChapters = isBookEndNotes ? resolvedChapters.filter(c => !isNotesEntry(c)) : resolvedChapters
    const chapterIds = bodyChapters.map((c, i) => c.id || String(i + 1).padStart(3, '0'))
    if (new Set(chapterIds).size !== chapterIds.length) throw new Error('章节编号重复')

    const chJson = bodyChapters.map((c, idx) => ({
      id: c.id || String(idx + 1).padStart(3, '0'),
      title: String(c.title).trim(),
      start_page: c.start_page,
      end_page: c.end_page,
      note_pages: (
        Array.isArray(c.note_pages)
        && c.note_pages.length === 2
        && typeof c.note_pages[0] === 'number'
        && typeof c.note_pages[1] === 'number'
      ) ? c.note_pages : null,
    }))
    const tocJson = resolvedChapters.map(c => ({
      title: c.title,
      printed_start: c.start_page,
      target_pdf_page: c.start_page,
      offset: 0,
      role_hint: isNotesEntry(c) ? 'endnotes' : (c.role_hint || 'chapter'),
    }))

    const baPath = path.join(ai, 'book_analysis.json')
    const ba = await json(baPath, {})
    const effectiveBa = {
      ...ba,
      title: String(t.profile?.title || t.name || 'Untitled').trim(),
      document_type: t.kind,
      language: t.profile?.language || '',
      book_type: t.profile?.book_type || 'footnote_only',
      note_numbering: t.profile?.note_numbering || 'per_chapter',
      note_location: t.profile?.note_location
        || (t.profile?.book_type === 'footnote_only' ? 'per_page_bottom' : 'chapter_end_notes'),
      layout: t.profile?.layout || 'single',
    }

    await atomic(path.join(ai, 'chapters.json'), chJson)
    await atomic(path.join(ai, 'toc.json'), tocJson)
    await atomic(path.join(ai, 'book_analysis.json'), effectiveBa)
    delete t.stages.prepare
    delete t.stages.verify
    delete t.stages.assemble
    t.structureConfirmed = true
    t.observationConfirmed = true
    t.message = '章节结构与目录已确认，可直接执行结构准备与阶段门禁。'
    await this.save(t)
    return t
  },

  async autoConfirmChapterStructure(t) {
    if (t.structureConfirmed || t.observationConfirmed) return
    if (['paper', 'chapter'].includes(t.kind)) {
      await this.ensureSinglePieceStructure(t)
      t.structureConfirmed = true
      t.observationConfirmed = true
      return
    }
    const ai = this.aiDir(t)
    const hasCurated = (
      await exists(path.join(ai, 'chapters.json'))
      && await exists(path.join(ai, 'book_analysis.json'))
      && await exists(path.join(ai, 'toc.json'))
    )
    if (hasCurated) {
      t.structureConfirmed = true
      t.observationConfirmed = true
      return
    }
    let candidatesResult = null
    try {
      candidatesResult = await this.structureCandidates(t.id)
    } catch {}
    let chapters = candidatesResult?.candidates || []
    const total = Number(t.scope?.pages ?? t.inspection?.pages ?? 0)
    if (!Array.isArray(chapters) || chapters.length === 0) {
      const title = String(t.profile?.title || t.name || 'Untitled').trim()
      chapters = [{ id: '001', title, start_page: 1, end_page: total > 0 ? total : 1, note_pages: null }]
    }
    await this.saveChapterStructureData(t, chapters)
  },

  async chapters(t) {
    return json(path.join(this.aiDir(t), 'chapters.json'), [])
  },

  async ensureSinglePieceStructure(t) {
    if (!['paper', 'chapter'].includes(t.kind)) return
    const ai = this.aiDir(t)
    const total = Number(t.scope?.pages ?? 0)
    if (total < 1) throw new Error('缺少规范化页数，请先完成范围与布局')
    await fs.mkdir(ai, { recursive: true })

    const title = String(t.profile?.title || t.name || 'Untitled').trim()
    const bookType = t.profile?.book_type || 'footnote_only'
    const tocPath = path.join(ai, 'toc.json')
    const chPath = path.join(ai, 'chapters.json')
    const baPath = path.join(ai, 'book_analysis.json')

    if (!await exists(tocPath)) {
      await atomic(tocPath, [{
        title,
        printed_start: 1,
        target_pdf_page: 1,
        offset: 0,
        role_hint: 'chapter',
        source: 'single_paper_profile',
      }])
    }

    if (!await exists(chPath)) {
      let notePages = null
      if (['endnote_only', 'mixed'].includes(bookType)) {
        if (t.profile?.note_start_page && t.profile?.note_end_page) {
          const docProf = await json(path.join(this.docDir(t), 'document_profile.json'), {})
          const map = docProf?.source_page_map ?? []
          const s = map.find(m => m.source_page === t.profile.note_start_page)?.logical_page ?? 1
          const e = map.find(m => m.source_page === t.profile.note_end_page)?.logical_page ?? total
          notePages = [s, e]
        } else {
          notePages = [1, total]
        }
      }
      await atomic(chPath, [{ id: '001', title, start_page: 1, end_page: total, note_pages: notePages }])
    }

    if (!await exists(baPath)) {
      await atomic(baPath, {
        title,
        document_type: t.kind,
        language: t.profile?.language || '',
        book_type: bookType,
        note_numbering: t.profile?.note_numbering || 'continuous',
        note_location: t.profile?.note_location || 'per_page_bottom',
        layout: t.profile?.layout || 'single',
      })
    }
  },

  async structureCandidates(id) {
    const t = await this.get(id)
    const existingChapters = await this.chapters(t)
    if (existingChapters && existingChapters.length > 0) {
      const toc = await json(path.join(this.aiDir(t), 'toc.json'), []).catch(() => [])
      const tocMap = new Map(toc.map(item => [item.title, item.role_hint]))
      const candidates = existingChapters.map((c, i) => ({
        id: c.id,
        num: i + 1,
        title: c.title,
        start_page: c.start_page,
        end_page: c.end_page,
        role_hint: c.role_hint ?? tocMap.get(c.title) ?? toc[i]?.role_hint ?? 'chapter',
        part_hint: Boolean(c.part_hint),
      }))
      const total = Number(t.scope?.pages ?? t.inspection?.pages ?? candidates.at(-1)?.end_page ?? 0)
      const res = {
        total_pages: total,
        candidates,
        source_page_map: [],
        kind: t.kind,
        confirmed: Boolean(t.structureConfirmed),
        existingChapters,
        source: 'confirmed',
      }
      return { ...res, structure: res }
    }

    if (t.input.type !== 'pdf') {
      const res = {
        total_pages: 0,
        candidates: [],
        source_page_map: [],
        kind: t.kind,
        confirmed: Boolean(t.structureConfirmed),
        existingChapters: [],
      }
      return { ...res, structure: res }
    }

    const doc = this.docDir(t)
    if (!await exists(path.join(doc, 'source.pdf')) || !await exists(path.join(doc, 'document_profile.json'))) {
      throw new Error('请先完成正文范围与规范化底本处理')
    }
    const out = await this.py(t, 'document_pipeline.py', ['structure', doc])
    const result = JSON.parse(out.trim().split('\n').at(-1))
    const res = { ...result, confirmed: Boolean(t.structureConfirmed), existingChapters }
    return { ...res, structure: res }
  },

  async confirmStructure(id, args) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (this.active.has(id)) throw new Error('运行中不能修改结构')
      const ai = this.aiDir(t)
      await fs.mkdir(ai, { recursive: true })

      const auditStat = await fs.stat(path.join(ai, 'worker_audit.jsonl')).catch(() => ({ size: 0 }))
      if (t.stages.transcribe || (t.log ?? []).some(l => l.stage === 'transcribe') || auditStat.size > 0) {
        throw new Error('已尝试转写，不能改章节编号或范围以重置预算；请保留现有任务核查')
      }
      if (args.delegateObservation) {
        t.structureConfirmed = false
        t.observationConfirmed = false
        t.message = '已选择由 DSH 会话派发观察 worker 补齐结构与注释范围。'
        await atomic(path.join(ai, 'structure_delegate.json'), {
          requestedAt: new Date().toISOString(),
          note: args.note ?? '',
        })
        return this.save(t)
      }
      return this.saveChapterStructureData(t, args.chapters)
    })
  },

  async ocrRegion(id, { page, region = [0, 0, 1, 1], reason = '' }) {
    const invalidRegion = (
      !Number.isInteger(page)
      || page < 1
      || !Array.isArray(region)
      || region.length !== 4
      || region.some(n => typeof n !== 'number' || !Number.isFinite(n))
      || region[0] < 0
      || region[1] < 0
      || region[2] > 1
      || region[3] > 1
      || region[0] >= region[2]
      || region[1] >= region[3]
    )
    if (invalidRegion) {
      throw new Error('请指定有效页码和区域坐标 [左,上,右,下]，坐标范围为 0 到 1')
    }
    return this.locked('ocr:' + id, async () => {
      const t = await this.get(id)
      assertPhaseApproved(t, t.phaseApproval?.phase ?? 'transcription')
      const docPdf = path.join(this.docDir(t), 'source.pdf')
      const hasNormalized = t.stages.normalize?.state === 'done' && await exists(docPdf)
      if (hasNormalized && page > t.scope?.pages) throw new Error('OCR 页码超出当前文档范围')
      const targetPdf = hasNormalized ? docPdf : (t.path ?? t.input?.path)
      if (!targetPdf || !await exists(targetPdf)) {
        throw new Error('未找到当前任务的原始或规范化 PDF 底本')
      }
      const output = await this.command(t, this.python, [
        OCR_REGION_SCRIPT,
        targetPdf,
        '--page', String(page),
        '--region', JSON.stringify(region),
        '--out', path.join(this.dir(id), 'ocr-regions'),
        '--runtime', path.join(this.root, VISION),
        '--config', path.join(this.root, '.kimi-code/skills/fnm-ai-convert/config.json'),
        '--reason', reason,
      ])
      return JSON.parse(output.trim().split('\n').at(-1))
    })
  },

  async probePage(id, { page, pages, options = {} } = {}) {
    const t = await this.get(id)
    if (t.input?.type !== 'pdf' && !t.path?.endsWith('.pdf')) {
      throw new Error('当前任务输入不是 PDF 文档，无需页面探测')
    }
    let targetPages = []
    if (Array.isArray(pages) && pages.length) targetPages = pages
    else if (Number.isInteger(page)) targetPages = [page]
    else throw new Error('请指定要探测的有效页码 (page 或 pages)')

    targetPages = [...new Set(targetPages)].sort((a, b) => a - b)
    if (!targetPages.length || targetPages.length > 8 || targetPages.some(p => !Number.isInteger(p) || p < 1)) {
      throw new Error('请指定 1 到 8 个有效正整数页码进行受控探测')
    }

    const docPdf = path.join(this.docDir(t), 'source.pdf')
    const pdfPath = await exists(docPdf) ? docPdf : (t.path ?? t.input?.path)
    if (!pdfPath || !await exists(pdfPath)) {
      throw new Error('未找到当前任务的原始或规范化 PDF 底本')
    }
    const outDir = path.join(this.dir(id), 'probe-pages')
    await fs.mkdir(outDir, { recursive: true })
    const args = [PROBE_PAGES_SCRIPT, pdfPath, outDir, '--pages', JSON.stringify(targetPages)]
    if (options.textLimit && Number.isInteger(options.textLimit)) {
      args.push('--text-limit', String(options.textLimit))
    }
    const output = await this.command(t, this.python, args)
    const result = JSON.parse(output.trim().split('\n').at(-1))
    return {
      taskId: t.id,
      taskName: t.name,
      ...result,
      instructions: '返回页面图像已保存于 probe-pages 目录，可直接使用 read_image 查看原页布局；若页面含有文本层，已直接提取于 text 字段。',
    }
  },

  async ensureTextLayerReference(t) {
    const doc = this.docDir(t)
    const text = s => `${TEXT}/${s}`
    const reference = path.join(this.dir(t.id), 'reference/text-layer')
    const raw = await json(path.join(doc, 'raw_pages.json'), null)
    if (
      raw?.pages?.length === t.scope?.pages
      && await exists(path.join(doc, 'raw_pages_paddle.json'))
      && await exists(path.join(doc, 'raw_pages_mineru.json'))
    ) {
      return reference
    }

    await fs.mkdir(reference, { recursive: true })
    await fs.copyFile(path.join(doc, 'source.pdf'), path.join(reference, 'source.pdf'))
    await fs.copyFile(path.join(doc, 'document_profile.json'), path.join(reference, 'document_profile.json'))

    const docAi = path.join(doc, 'ai_convert')
    const refAi = path.join(reference, 'ai_convert')
    await fs.mkdir(refAi, { recursive: true })
    for (const name of ['chapters.json', 'toc.json', 'book_analysis.json']) {
      if (await exists(path.join(docAi, name))) {
        await fs.copyFile(path.join(docAi, name), path.join(refAi, name))
      }
    }
    if (!await exists(path.join(reference, 'raw_pages.json'))) {
      await this.py(t, text('tl_convert.py'), [reference, 'prepare', '--force'])
      await this.py(t, text('tl_convert.py'), [reference, 'extract', '--force', '--raw-only'])
    }
    for (const file of ['raw_pages.json', 'raw_pages_paddle.json', 'raw_pages_mineru.json']) {
      await fs.copyFile(path.join(reference, file), path.join(doc, file))
    }
    return reference
  },
}
