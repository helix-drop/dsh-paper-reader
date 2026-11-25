import fs from 'node:fs/promises'
import path from 'node:path'
import {
  loadSourceMap,
  writeSourceMap,
  sourceMapPath,
  translationInput,
  acceptTranslation,
  saveTranslationMap,
  validateSourceMap,
  translationMapMatches,
  fileDigest,
} from '../source-map.js'
import { translationPrompt, assertAcademicPreprocessing } from '../cli.js'
import {
  nativeRequests,
  watchGlossaryProviderFailure,
  QUOTA_ABORT_WINDOW_MS,
  createQuotaAbortTracker,
  TIMEOUT_ABORT_WINDOW_MS,
  createTimeoutAbortTracker,
  formatQuotaExhaustedMessage,
} from '../glossary-transport.js'
import {
  translationChunks,
  recoverTranslationChunks,
  assembleTranslationChunks,
  restorePairVerifiedBlockIds,
} from '../translation-transport.js'
import { hash, markdownBlocks, checkMarkdownPair } from '../markdown.js'
import { exists, atomic, json, walk } from './shared.js'

export async function runTranslationStage(manager, t, stage, options = {}) {
  if (stage === 'lgProject') {
    await manager.requireGlossary(t)
    if (t.translationEngine !== 'http') {
      await manager.prepareCliTranslation(t)
      return true
    }
    if (t.input.type === 'pdf') await manager.requireDone(t, 'assemble')
    const prepared = await manager.prepareTranslationInput(t)
    const original = prepared.file
    const project = path.join(manager.dir(t.id), 'translation.lg')
    const snapshot = await manager.lg(t, '/api/session/project/snapshot', {})
    const current = snapshot.project?.path
    if (current && current !== project) {
      throw new Error('LinguaGacha已有其他工程，关闭该工程后再连接')
    }
    if (await exists(project) && !t.lgPreparationKey) {
      throw new Error('旧翻译工程没有段落清单，保留旧缓存并新建接续任务')
    }
    if (await exists(project)) {
      await manager.lg(t, '/api/session/project/open', { path: project })
    } else {
      await manager.lg(t, '/api/session/project/create', {
        path: project,
        source_paths: [original],
        project_settings: {
          source_language: t.profile.language.toUpperCase(),
          target_language: 'ZH',
        },
      })
    }
    t.lgProject = project
    if (t.lgPreparationKey && t.lgPreparationKey !== prepared.receipt.annotatedFingerprint) {
      throw new Error('HTTP 翻译工程的原文已变化，请保留旧工程并建立新任务')
    }
    t.lgPreparationKey = prepared.receipt.annotatedFingerprint
    if (!t.lgConfigured) await manager.configureLgProject(t)
    return true
  }

  if (stage === 'translate') {
    await manager.requireGlossary(t)
    await manager.translateTask(t, options)
    return true
  }

  if (stage === 'translationCheck') {
    if (t.input.type === 'pdf') await manager.requireDone(t, 'assemble')
    const src = await manager.original(t)
    const destination = t.translationPath ?? path.join(manager.dir(t.id), 'translation/translated.md')
    const source = await fs.readFile(src, 'utf8')
    let target = await fs.readFile(destination, 'utf8')
    const sourceMap = await loadSourceMap(manager, src, source)
    let targetMap = null
    try { targetMap = await loadSourceMap(manager, destination, target) } catch {}

    let initialCheck = checkMarkdownPair(source, target)
    if (!initialCheck.passed && t.translationCli?.directory) {
      const lastRaw = path.join(t.translationCli.directory, 'output')
      const lastFiles = await exists(lastRaw) ? await walk(lastRaw, /\.md$/, 5) : []
      const lastCandidates = lastFiles.filter(f => !/(?:bilingual|对照)/i.test(path.relative(lastRaw, f)))
      if (lastCandidates.length === 1) {
        try {
          await manager.acceptTranslationOutput(t, await fs.readFile(lastCandidates[0], 'utf8'))
          target = await fs.readFile(destination, 'utf8')
          try { targetMap = await loadSourceMap(manager, destination, target) } catch {}
          initialCheck = checkMarkdownPair(source, target)
        } catch {}
      }
    }

    let alignment = await json(path.join(manager.dir(t.id), 'translation/alignment.json'), null)
    if (sourceMap && (!targetMap || !translationMapMatches(sourceMap, targetMap))) {
      const manifest = await json(path.join(manager.dir(t.id), 'translation-input/block-manifest.json'), null)
      const sourceIds = manifest?.sourceIds ?? manifest?.ids
      if (
        initialCheck.passed
        && alignment?.pairing === 'explicit-block-id'
        && sourceIds
        && sourceIds.length === sourceMap.blocks.length
      ) {
        try {
          const targetBlocks = markdownBlocks(target).map((b, i) => ({
            ...sourceMap.blocks[i],
            blockId: sourceIds[i],
            markdownBlockId: b.id,
            type: b.type,
            sourceBlockId: sourceIds[i],
          }))
          await saveTranslationMap(manager, t, src, destination, source, target, targetBlocks)
          targetMap = await loadSourceMap(manager, destination, target)
          alignment = { ...alignment, targetFingerprint: hash(target) }
          await atomic(path.join(manager.dir(t.id), 'translation/alignment.json'), alignment)
        } catch {}
      }
    }

    const explicit = (
      alignment?.sourceFingerprint === hash(source)
      && alignment?.targetFingerprint === hash(target)
      && alignment?.pairing === 'explicit-block-id'
    )
    if (sourceMap && !translationMapMatches(sourceMap, targetMap)) {
      throw new Error('译文缺少当前原文的段落来源映射，不能按位置补配')
    }
    t.translationReport = {
      ...initialCheck,
      sourceFingerprint: hash(source),
      targetFingerprint: hash(target),
      explicitBlockIds: Boolean(explicit || targetMap?.pairing === 'explicit-block-id'),
      sourceMapAvailable: Boolean(sourceMap),
    }
    await atomic(path.join(manager.dir(t.id), 'translation-report.json'), t.translationReport)
    if (!t.translationReport.passed) throw new Error(t.translationReport.errors.join('；'))
    t.translationPath = destination
    return true
  }

  return false
}

export const translationFlowMethods = {
  async prepareTranslationInput(t) {
    const original = await this.original(t)
    const source = await fs.readFile(original, 'utf8')
    const map = await loadSourceMap(this, original, source)
    if (t.input.type === 'pdf' && !map) throw new Error('原文尚无装配来源映射，请先补齐映射后翻译')

    const prepared = translationInput(source, map)
    const dir = path.join(this.dir(t.id), 'translation-input')
    const file = path.join(dir, 'source.md')
    const previous = await json(path.join(dir, 'block-manifest.json'), null)

    // Keep the protocol of an existing request, including completed legacy output.
    if (
      previous?.sourceFingerprint === prepared.sourceFingerprint
      && JSON.stringify(previous.sourceIds ?? previous.ids) === JSON.stringify(prepared.sourceIds)
    ) {
      const bytes = await fs.readFile(file).catch(() => null)
      if (bytes && hash(bytes) === previous.annotatedFingerprint) return { file, receipt: previous }
    }

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, prepared.text, { mode: 0o600 })
    await fs.writeFile(path.join(dir, 'original.md'), source, { mode: 0o600 })
    if (map) {
      const { pdfPath, ...data } = map
      await writeSourceMap(path.join(dir, 'original.md'), {
        ...data,
        pdf: { ...data.pdf, file: path.relative(dir, pdfPath) },
      })
    }
    const receipt = { ...prepared, text: undefined }
    await atomic(path.join(dir, 'block-manifest.json'), receipt)
    return { file, receipt }
  },

  async acceptTranslationOutput(t, output) {
    const sourceFile = await this.original(t)
    const source = await fs.readFile(sourceFile, 'utf8')
    const sourceMap = await loadSourceMap(this, sourceFile, source)
    const receipt = await json(path.join(this.dir(t.id), 'translation-input/block-manifest.json'), null)
    if (!receipt) throw new Error('缺少翻译段落清单，请先准备翻译输入')

    const result = acceptTranslation(source, output, receipt, sourceMap)
    const targetFile = path.join(this.dir(t.id), 'translation/translated.md')
    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    if (await exists(targetFile)) await fs.copyFile(targetFile, `${targetFile}.bak-${Date.now()}`)
    await fs.writeFile(targetFile, result.target, { mode: 0o600 })
    await saveTranslationMap(this, t, sourceFile, targetFile, source, result.target, result.blocks)

    await atomic(path.join(this.dir(t.id), 'translation/alignment.json'), {
      schemaVersion: 1,
      pairing: 'explicit-block-id',
      sourceFingerprint: hash(source),
      targetFingerprint: hash(result.target),
      ids: receipt.ids,
    })
    await atomic(path.join(this.dir(t.id), 'translation/typography.json'), {
      ...result.typography,
      rawOutputFingerprint: hash(output),
      targetFingerprint: hash(result.target),
    })
    delete t.stages.translationCheck
    delete t.stages.review
    delete t.stages.publish
    delete t.translationReport
    delete t.translationPath
    delete t.review
    delete t.publication
    return result
  },

  async prepareCliTranslation(t) {
    await this.requireGlossary(t)
    if (t.input.type === 'pdf') await this.requireDone(t, 'assemble')
    const status = await this.cliStatus()
    assertAcademicPreprocessing(status)
    if (t.profile.translation_model && status.model.model !== t.profile.translation_model) {
      throw new Error('CLI 翻译模型与任务指定值不一致，未发送翻译')
    }
    if (!status.model.credentialConfigured) {
      throw new Error('CLI 当前模型缺少凭证，未重试')
    }

    const dir = path.join(this.dir(t.id), 'translation-cli')
    await fs.mkdir(dir, { recursive: true })
    const prepared = await this.prepareTranslationInput(t)
    const prompt = translationPrompt(t.kind)
    const text = prepared.receipt.sourceFingerprint
    await fs.writeFile(path.join(dir, 'prompt.txt'), prompt, { mode: 0o600 })
    await fs.copyFile(prepared.file, path.join(dir, 'source.md'))

    const glossary = await json(path.join(this.dir(t.id), 'glossary.json'), [])
    await atomic(path.join(dir, 'glossary.json'), glossary)

    const legacyKey = model => hash(JSON.stringify({
      source: text,
      annotated: prepared.receipt.annotatedFingerprint,
      model,
      prompt,
      glossary,
      language: t.profile.language,
    }))
    const threshold = { ...status.model.threshold }
    delete threshold.concurrency_limit
    const stateKey = hash(JSON.stringify({
      source: text,
      annotated: prepared.receipt.annotatedFingerprint,
      prompt,
      glossary,
      language: t.profile.language,
      threshold,
    }))
    const sameBudget = model => {
      const other = { ...model?.threshold }
      delete other.concurrency_limit
      return JSON.stringify(other) === JSON.stringify(threshold)
    }

    const stored = t.cliPreparation?.key
    let key = stateKey
    let legacyModel = null
    if (stored) {
      const accepted = new Set([stateKey])
      const addLegacy = model => {
        if (!model || !sameBudget(model)) return
        const stripped = { ...model, threshold: { ...model.threshold } }
        delete stripped.threshold.concurrency_limit
        accepted.add(legacyKey(stripped))
        for (let i = 1; i <= 8; i++) {
          accepted.add(legacyKey({
            ...model,
            threshold: { ...model.threshold, concurrency_limit: i },
          }))
        }
        if (accepted.has(stored) && stored !== stateKey) legacyModel = model
      }
      addLegacy(status.model)
      addLegacy(t.translationModel)
      addLegacy(t.cliPreparation?.legacyModel)
      if (accepted.has(stored)) key = stored
    }

    t.translationEngine = 'cli'
    t.translationModel = { ...status.model, connectionVerified: false }
    t.cliPreparation = {
      key,
      sourceFingerprint: text,
      directory: dir,
      version: status.version,
      partialResumeSupported: true,
      ...(legacyModel ? { legacyModel } : {}),
    }
    await atomic(path.join(dir, 'preparation.json'), t.cliPreparation)
  },

  async translateViaCli(t, options) {
    if (t.stages.lgProject?.state !== 'done') {
      await this.prepareCliTranslation(t)
      t.stages.lgProject = { state: 'done', at: new Date().toISOString() }
      await this.save(t)
    } else {
      await this.prepareCliTranslation(t)
    }

    const prep = t.cliPreparation
    const output = path.join(this.dir(t.id), 'translation/translated.md')
    const canReuseDone = (
      !options.reanalyze
      && !options.retryErrors
      && t.translationReport?.passed !== false
      && t.stages.translationCheck?.state !== 'blocked'
      && t.translationCli?.status === 'done'
      && t.translationCli.key === prep.key
      && await exists(output)
      && hash(await fs.readFile(output)) === t.translationCli.outputFingerprint
    )
    if (canReuseDone) {
      t.translationProgress = { status: 'done', reused: true }
      return
    }

    const currentAttempt = t.translationCli?.attempt ?? 1
    const lastDir = path.join(prep.directory, 'runs', String(currentAttempt))
    const lastReceipt = await json(path.join(lastDir, 'receipt.json'), null)
    const lastRaw = path.join(lastDir, 'output')
    const lastFiles = await exists(lastRaw) ? await walk(lastRaw, /\.md$/, 5) : []
    const lastCandidates = lastFiles.filter(f => !/(?:bilingual|对照)/i.test(path.relative(lastRaw, f)))

    const readRequests = this.translationRequestLog ?? nativeRequests
    if (
      lastReceipt?.key === prep.key
      && lastReceipt.finishedEvent?.status === 'done'
      && lastCandidates.length === 1
      && !options.reanalyze
    ) {
      try {
        const sourceText = await fs.readFile(path.join(prep.directory, 'source.md'), 'utf8')
        const rawCandidate = await fs.readFile(lastCandidates[0], 'utf8')
        let candidateOutput = rawCandidate
        if (!lastReceipt.reusedBlocks) {
          const allChunks = translationChunks(sourceText)
          if (markdownBlocks(rawCandidate).some(b => !/<!--\s*dsh-block:[a-zA-Z0-9_-]+\s*-->/.test(b.text))) {
            candidateOutput = restorePairVerifiedBlockIds(allChunks, rawCandidate, await readRequests(), [lastReceipt])
          }
        } else {
          const priorReceipts = []
          const priorCached = []
          const runNames = (await fs.readdir(path.join(prep.directory, 'runs')).catch(() => []))
            .filter(n => /^\d+$/.test(n) && Number(n) < currentAttempt)
            .sort((a, b) => Number(a) - Number(b))
          for (const name of runNames) {
            const pr = await json(path.join(prep.directory, 'runs', name, 'receipt.json'), null)
            if (!pr) continue
            priorReceipts.push(pr)
            if (pr.checkpointFile) {
              const bytes = await fs.readFile(pr.checkpointFile)
              if (hash(bytes) !== pr.checkpointSha256) throw new Error('翻译恢复记录变化，请核查原始结果')
              priorCached.push(...JSON.parse(bytes))
            }
          }
          const reqs = await readRequests()
          const prior = recoverTranslationChunks(sourceText, priorReceipts, reqs, priorCached)
          const allById = new Map(translationChunks(sourceText).map(c => [c.blockId, c.text]))
          const lastInput = await fs.readFile(path.join(lastDir, 'source.md'), 'utf8')
          const lastInputChunks = translationChunks(lastInput)
          if (lastInputChunks.some(c => allById.get(c.blockId) !== c.text)) {
            throw new Error('增量翻译输入与当前原文不一致')
          }
          const lastIds = new Set(lastInputChunks.map(c => c.blockId))
          const markerRe = /<!--\s*dsh-block:([a-zA-Z0-9_-]+)\s*-->/
          const baseRecovered = prior.recovered.filter(p => {
            const pid = (String(p.src ?? '').match(markerRe) ?? String(p.dst ?? '').match(markerRe))?.[1]
            return pid && !lastIds.has(pid)
          })
          const repaired = restorePairVerifiedBlockIds(lastInputChunks, rawCandidate, reqs, [lastReceipt])
          candidateOutput = assembleTranslationChunks(sourceText, baseRecovered, repaired)
          await atomic(path.join(lastDir, 'assembled.md'), candidateOutput)
        }
        await fs.mkdir(path.dirname(output), { recursive: true })
        if (await exists(output)) await fs.copyFile(output, `${output}.bak-${Date.now()}`)
        await this.acceptTranslationOutput(t, candidateOutput)
        t.translationCli = { ...lastReceipt, status: 'done', outputFingerprint: hash(await fs.readFile(output)) }
        t.translationProgress = { status: 'done', reused: true }
        t.translationModel.connectionVerified = true
        await atomic(path.join(lastDir, 'receipt.json'), t.translationCli)
        await this.save(t)
        return
      } catch (e) {
        if (!options.retryErrors) throw e
      }
    }

    if (t.translationCli?.key === prep.key && !options.retryErrors && !options.reanalyze) {
      throw new Error('上次翻译未完成，已有结果保留；显式恢复只处理尚未完成的文本块')
    }

    const source = await fs.readFile(path.join(prep.directory, 'source.md'), 'utf8')
    const receipts = []
    const cached = []
    if (!options.reanalyze) {
      const runNames = (await fs.readdir(path.join(prep.directory, 'runs')).catch(() => []))
        .filter(n => /^\d+$/.test(n))
        .sort((a, b) => Number(a) - Number(b))
      for (const name of runNames) {
        const receipt = await json(path.join(prep.directory, 'runs', name, 'receipt.json'), null)
        // 跨通道继承：有核验摘要的完成块即可复用；adopt 按原文内容精确匹配，key 只用于同通道熔断统计
        if (!receipt) continue
        receipts.push(receipt)
        if (receipt.checkpointFile) {
          const bytes = await fs.readFile(receipt.checkpointFile)
          if (hash(bytes) !== receipt.checkpointSha256) throw new Error('翻译恢复记录变化，请核查原始结果')
          cached.push(...JSON.parse(bytes))
        }
      }
    }

    const recovery = recoverTranslationChunks(source, receipts, receipts.length ? await readRequests() : [], cached)

    // 连续失败熔断：同一通道 key 在 30 分钟内、最近一次成功之后连续失败达 10 次才停止；任何成功返回都会刷新计数
    const BREAKER_WINDOW_MS = 30 * 60 * 1000
    const BREAKER_LIMIT = 10
    const nowMs = Date.now()
    const history = []
    const seenFailDirs = new Set()
    const seenOkDirs = new Set()

    const pushBreakerReceipt = r => {
      if (!r || r.key !== prep.key) return
      const dirKey = r.directory
      const failReason = ['content_filter', 'timeout', 'output_limit'].includes(r?.providerFailure?.reason)
      const failAt = failReason ? Date.parse(r?.providerFailure?.at ?? r?.endedAt ?? r?.startedAt ?? '') : NaN
      const hasFail = Number.isFinite(failAt) && nowMs - failAt <= BREAKER_WINDOW_MS && (!dirKey || !seenFailDirs.has(dirKey))
      const okAt = Date.parse(r?.endedAt ?? r?.startedAt ?? '')
      const hasOk = (
        Number.isFinite(okAt)
        && nowMs - okAt <= BREAKER_WINDOW_MS
        && (r?.cliStats?.completed > 0 || r?.finishedEvent?.status === 'done' || r?.status === 'done')
        && (!dirKey || !seenOkDirs.has(dirKey))
      )
      if (hasOk && dirKey) seenOkDirs.add(dirKey)
      if (hasFail && dirKey) seenFailDirs.add(dirKey)
      if (hasOk && hasFail) {
        const startAt = Date.parse(r?.startedAt ?? '')
        history.push({ at: Number.isFinite(startAt) ? Math.min(startAt, failAt) : Math.min(okAt, failAt), seq: history.length, ok: true })
        history.push({ at: failAt, seq: history.length, ok: false })
      } else {
        if (hasOk) history.push({ at: okAt, seq: history.length, ok: true })
        if (hasFail) history.push({ at: failAt, seq: history.length, ok: false })
      }
    }

    for (const r of receipts) pushBreakerReceipt(r)
    const cur = t.translationCli
    if (cur?.key === prep.key) {
      pushBreakerReceipt(cur)
      const fresh = t.translationProgress?.stats?.completed ?? 0
      if (!(cur?.cliStats?.completed > 0) && fresh > 0) {
        const at = Date.parse(t.translationProgress?.timestamp ?? cur?.endedAt ?? '')
        if (Number.isFinite(at) && nowMs - at <= BREAKER_WINDOW_MS) {
          history.push({ at, seq: history.length, ok: true })
        }
      }
    }
    history.sort((a, b) => a.at - b.at || a.seq - b.seq)
    let retryCount = 0
    for (const h of history) retryCount = h.ok ? 0 : retryCount + 1
    if (recovery.pending.length && retryCount >= BREAKER_LIMIT) {
      throw new Error(`翻译供应商 30 分钟内连续失败 ${retryCount} 次且无成功返回，保留完成块并停止`)
    }

    const attempt = (t.translationCli?.attempt ?? 0) + 1
    const dir = path.join(prep.directory, 'runs', String(attempt))
    const raw = path.join(dir, 'output')
    await fs.mkdir(raw, { recursive: true })
    t.translationCli = {
      key: prep.key,
      status: 'running',
      attempt,
      startedAt: new Date().toISOString(),
      directory: dir,
      partialResumeSupported: true,
      reusedBlocks: recovery.recovered.length,
      requestedBlocks: recovery.pending.length,
      providerRetryCount: retryCount,
    }
    await this.save(t)

    const input = path.join(dir, 'source.md')
    await fs.writeFile(input, recovery.pending.map(b => b.text).join('\n\n') + '\n', { mode: 0o600 })
    const totalBlocks = recovery.recovered.length + recovery.pending.length

    const terminateChild = () => {
      const child = this.active.get(t.id)?.child
      if (child) {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGKILL') } catch {}
          }
        }, 5000)
        timer.unref()
      }
    }

    const quotaTracker = createQuotaAbortTracker({
      model: t.translationModel.model,
      initialCompleted: recovery.recovered.length,
      windowMs: options?.quotaWindowMs ?? this.quotaWindowMs ?? QUOTA_ABORT_WINDOW_MS,
      onAbort: quota => {
        t.translationCli.quotaFailure = quota
        terminateChild()
      },
    })

    let finished = false
    let providerFailure = null
    let stopWatching = () => {}
    let checkpointSaved = false

    const timeoutTracker = createTimeoutAbortTracker({
      initialCompleted: recovery.recovered.length,
      windowMs: options?.timeoutWindowMs ?? this.timeoutWindowMs ?? TIMEOUT_ABORT_WINDOW_MS,
      onAbort: failure => {
        if (providerFailure || quotaTracker.aborted) return
        providerFailure = { ...failure, at: failure.at ?? new Date().toISOString() }
        t.translationCli.providerFailure = providerFailure
        terminateChild()
      },
    })

    try {
      if (recovery.pending.length) {
        stopWatching = await (this.watchTranslationProviderFailure ?? watchGlossaryProviderFailure)(
          failure => {
            if (failure.reason === 'quota') {
              quotaTracker.onFailure(failure)
              return
            }
            if (failure.reason === 'timeout') {
              timeoutTracker.onFailure(failure)
              return
            }
            providerFailure = { ...failure, at: failure.at ?? new Date().toISOString() }
            t.translationCli.providerFailure = providerFailure
            terminateChild()
          },
          { sources: recovery.pending.map(b => b.text), model: t.translationModel.model },
        )

        const args = [
          '--cli', 'translate',
          '--input', input,
          '--output-dir', raw,
          '--source-language', t.profile.language.toUpperCase(),
          '--target-language', 'ZH',
          '--prompt', path.join(prep.directory, 'prompt.txt'),
          '--glossary', path.join(prep.directory, 'glossary.json'),
        ]
        try {
          await this.command(t, this.cliExecutable, args, {
            onLine: async line => {
              await fs.appendFile(path.join(dir, 'events.jsonl'), line + '\n', { mode: 0o600 })
              let e
              try { e = JSON.parse(line) } catch { return }
              if (e.type === 'progress') {
                if (e.stats) t.translationCli.cliStats = e.stats
                if (Number.isFinite(e.stats?.completed)) {
                  const totalDone = recovery.recovered.length + e.stats.completed
                  quotaTracker.onProgress(totalDone)
                  timeoutTracker.onProgress(totalDone)
                }
                t.translationProgress = {
                  ...e,
                  timestamp: e.timestamp ?? new Date().toISOString(),
                  reusedBlocks: recovery.recovered.length,
                  run_progress: {
                    total_line: (e.stats?.total ?? 0) + recovery.recovered.length,
                    line: (e.stats?.completed ?? 0) + recovery.recovered.length,
                    error_line: e.stats?.failed ?? 0,
                  },
                }
                await this.save(t)
              }
              if (e.type === 'finished') {
                finished = e.status === 'done'
                t.translationCli.finishedEvent = e
              }
            },
          })
        } catch (err) {
          if (!quotaTracker.aborted && !providerFailure && timeoutTracker.pending && !err.timedOut && !this.active.get(t.id)?.cancel) {
            providerFailure = { ...timeoutTracker.pending, at: timeoutTracker.pending.at ?? new Date().toISOString() }
            t.translationCli.providerFailure = providerFailure
          }
          throw err
        }

        if (timeoutTracker.aborted && !providerFailure && !quotaTracker.aborted) {
          providerFailure = { ...timeoutTracker.aborted, at: timeoutTracker.aborted.at ?? new Date().toISOString() }
          t.translationCli.providerFailure = providerFailure
        }
        if (
          !providerFailure
          && !quotaTracker.aborted
          && timeoutTracker.pending
          && !this.active.get(t.id)?.cancel
          && (!finished || (t.translationCli.cliStats?.failed ?? 0) > 0 || (t.translationCli.cliStats?.pending ?? 0) > 0)
        ) {
          providerFailure = { ...timeoutTracker.pending, at: timeoutTracker.pending.at ?? new Date().toISOString() }
          t.translationCli.providerFailure = providerFailure
        }
        if (quotaTracker.aborted) {
          t.translationCli.quotaFailure = quotaTracker.aborted
          throw Object.assign(new Error('供应商额度用尽'), { code: 'TRANSLATION_PROVIDER_QUOTA' })
        }
        if (providerFailure) throw new Error('供应商请求失败，已停止隐式重试')
        if (!finished) throw new Error('CLI 未报告完成，不能采用输出')
      }

      const files = await walk(raw, /\.md$/, 5)
      const candidates = files.filter(f => !/(?:bilingual|对照)/i.test(path.relative(raw, f)))
      if (recovery.pending.length && candidates.length !== 1) {
        throw new Error('CLI 输出 Markdown 数量异常，保留原始输出等待核验')
      }
      const rawReturned = recovery.pending.length ? await fs.readFile(candidates[0], 'utf8') : ''
      const needsMarkerRepair = recovery.pending.length > 0
        && markdownBlocks(rawReturned).some(b => !/<!--\s*dsh-block:[a-zA-Z0-9_-]+\s*-->/.test(b.text))
      const returned = needsMarkerRepair
        ? restorePairVerifiedBlockIds(
          recovery.pending,
          rawReturned,
          await readRequests(),
          [{ startedAt: t.translationCli.startedAt, endedAt: new Date().toISOString() }],
        )
        : rawReturned
      // Keep the legacy full-output receiver (including its narrow ID repair).
      const combined = recovery.recovered.length
        ? assembleTranslationChunks(source, recovery.recovered, returned)
        : returned
      await atomic(path.join(dir, 'assembled.md'), combined)
      await this.acceptTranslationOutput(t, combined)
      t.translationCli.status = 'done'
      t.translationCli.outputFingerprint = hash(await fs.readFile(output))
      t.translationModel.connectionVerified = true
    } catch (e) {
      quotaTracker.close()
      timeoutTracker.close()
      stopWatching()
      t.translationCli.endedAt = new Date().toISOString()
      let savedCount = Math.min(totalBlocks, recovery.recovered.length + (t.translationProgress?.stats?.completed ?? 0))
      try {
        const saved = recoverTranslationChunks(source, [...receipts, t.translationCli], await readRequests(), recovery.recovered)
        t.translationCli.checkpointFile = path.join(dir, 'recovered.json')
        await atomic(t.translationCli.checkpointFile, saved.recovered)
        t.translationCli.checkpointSha256 = hash(await fs.readFile(t.translationCli.checkpointFile))
        savedCount = Math.max(savedCount, saved.recovered.length)
        checkpointSaved = true
      } catch {
        t.translationCli.recoveryError = '原始日志恢复暂未完成；原始返回保留，恢复时重新核查'
        checkpointSaved = true
      }
      if (this.active.get(t.id)?.cancel) {
        t.translationCli.status = 'stopped'
      } else if (quotaTracker.aborted) {
        t.translationCli.status = 'quota-exhausted'
        t.translationCli.quotaFailure = quotaTracker.aborted
        e.code = 'TRANSLATION_PROVIDER_QUOTA'
        e.message = formatQuotaExhaustedMessage(
          t.translationModel.model,
          quotaTracker.aborted.resetHint,
          savedCount,
          totalBlocks,
        )
      } else {
        t.translationCli.status = 'error'
        if (providerFailure) {
          e.message = `翻译请求${providerFailure.reason}，已停止自动重试并保留完成块；显式恢复只处理缺失块`
        }
      }
      throw e
    } finally {
      quotaTracker.close()
      timeoutTracker.close()
      stopWatching()
      t.translationCli.endedAt = t.translationCli.endedAt ?? new Date().toISOString()
      if (t.translationCli.status !== 'done' && !checkpointSaved) {
        try {
          const saved = recoverTranslationChunks(source, [...receipts, t.translationCli], await readRequests(), recovery.recovered)
          t.translationCli.checkpointFile = path.join(dir, 'recovered.json')
          await atomic(t.translationCli.checkpointFile, saved.recovered)
          t.translationCli.checkpointSha256 = hash(await fs.readFile(t.translationCli.checkpointFile))
        } catch {
          t.translationCli.recoveryError = '原始日志恢复暂未完成；原始返回保留，恢复时重新核查'
        }
      }
      await atomic(path.join(dir, 'receipt.json'), t.translationCli)
    }
  },

  async setConnection(id, url) {
    if (this.requireHarnessModels) throw new Error('翻译连接由 DSH 管理，不接受独立模型连接')
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务')
      if (this.active.has(id)) throw new Error('运行中不能更换连接')
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('本地连接地址无效')
      }
      const invalidOrigin = (
        parsed.protocol !== 'http:'
        || parsed.hostname !== '127.0.0.1'
        || !parsed.port
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
      )
      if (invalidOrigin) throw new Error('只接受 http://127.0.0.1:端口')
      t.lgUrl = parsed.origin
      await this.lg(t, '/api/session/project/snapshot', {})
      return this.save(t)
    })
  },

  async lg(t, route, body) {
    const response = await this.fetch(t.lgUrl + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    }).catch(() => {
      throw new Error('LinguaGacha本地连接不可用')
    })
    const value = await response.json()
    if (!response.ok || !value.ok) {
      throw Object.assign(new Error(`LinguaGacha接口拒绝 ${route}`), {
        code: value.error?.code,
        status: response.status,
      })
    }
    return value.data
  },

  async translateTask(t, options) {
    await this.requireGlossary(t)
    if (t.translationEngine !== 'http') return this.translateViaCli(t, options)
    await this.requireDone(t, 'lgProject')
    if (t.input.type === 'pdf') await this.requireDone(t, 'assemble')

    const prepared = await this.prepareTranslationInput(t)
    if (t.lgPreparationKey !== prepared.receipt.annotatedFingerprint) {
      throw new Error('HTTP 翻译工程的原文版本不一致，未发送请求')
    }
    await this.ensureLgProject(t)
    t.translationModel = await this.modelStatus(t)
    if (t.profile.translation_model && t.translationModel.model !== t.profile.translation_model) {
      throw new Error('翻译模型与当前任务指定值不一致，未发送翻译请求')
    }
    if (t.translationModel.credentialConfigured === false) {
      throw new Error('当前翻译模型缺少可用密钥，请按项目配置入口更新，不重复重试')
    }

    const settings = (await this.lg(t, '/api/settings/app', {})).settings
    assertAcademicPreprocessing({ preprocessing: { cleanRuby: settings.clean_ruby } })
    const previous = {
      source_language: settings.source_language,
      target_language: settings.target_language,
    }
    t.pendingLanguageRestore = previous
    await this.save(t)

    try {
      await this.lg(t, '/api/settings/update', {
        source_language: t.profile.language.toUpperCase(),
        target_language: 'ZH',
      })
      await this.lg(t, '/api/batch-translation/start', {
        operation: 'translate',
        mode: 'continue',
        scope: { kind: 'all' },
        include_errors: options.retryErrors === true,
      })

      for (let poll = 0; ; poll++) {
        if (poll > 14400) {
          await this.lg(t, '/api/batch-translation/stop', {})
          throw new Error('翻译监测超时，请检查持久工程状态')
        }
        if (this.active.get(t.id).cancel) throw new Error('任务已停止')
        await this.ensureLgProject(t)
        const state = (await this.lg(t, '/api/batch-translation/snapshot', {})).batch_translation
        t.translationProgress = state
        await this.save(t)
        const status = state?.status
        if (['done', 'stopped', 'error'].includes(status)) {
          if (status !== 'done') throw new Error('翻译停止或失败，已完成译块保留')
          if ((state.run_progress ?? state.progress)?.error_line > 0) {
            throw new Error('翻译仍有失败块，已完成译块保留')
          }
          t.translationModel.connectionVerified = (state.run_progress ?? state.progress)?.total_tokens > 0
          break
        }
        await new Promise(r => setTimeout(r, 1500))
      }

      const generated = await this.generateTranslationFiles(t)
      const output = await walk(generated.output_path, /\.md$/, 5)
      if (output.length !== 1) throw new Error('导出文件范围异常，未自动配对')
      await fs.mkdir(path.join(this.dir(t.id), 'translation'), { recursive: true })
      await this.acceptTranslationOutput(t, await fs.readFile(output[0], 'utf8'))
    } finally {
      try {
        const snapshot = await this.lg(t, '/api/session/project/snapshot', {})
        if (snapshot.project?.path === t.lgProject) {
          await this.lg(t, '/api/session/project/close', {})
          await this.lg(t, '/api/settings/update', previous)
          delete t.pendingLanguageRestore
        } else if (!snapshot.project?.loaded) {
          await this.lg(t, '/api/settings/update', previous)
          delete t.pendingLanguageRestore
        }
      } catch {
        // Keep the exact pending language settings for an explicit recovery.
      }
    }
  },

  async generateTranslationFiles(t) {
    try {
      return await this.lg(t, '/api/translation/files/generate', {})
    } catch (error) {
      if (error.code !== 'request.route_not_found') throw error
      return this.lg(t, '/api/translation/files/export', {})
    }
  },

  async configureLgProject(t) {
    await this.ensureLgProject(t)
    const prompt = translationPrompt(t.kind)
    const view = await this.lg(t, '/api/quality/prompts/view', {})
    await this.lg(t, '/api/quality/prompts/save', {
      text: prompt,
      enabled: true,
      expected_section_revisions: view.sectionRevisions,
    })

    const glossary = await json(path.join(this.dir(t.id), 'glossary.json'), null)
    if (Array.isArray(glossary)) {
      const ruleView = await this.lg(t, '/api/quality/rules/query', { rule_type: 'glossary' })
      await this.lg(t, '/api/quality/rules/update', {
        rule_type: 'glossary',
        entries: glossary.map((e, i) => ({
          src: e.src,
          dst: e.dst,
          info: e.info ?? '',
          case_sensitive: false,
          entry_id: hash(`${e.src}:${i}`).slice(0, 20),
        })),
        meta: { enabled: true },
        expected_section_revisions: ruleView.sectionRevisions,
      })
    }
    t.lgConfigured = true
    t.translationPrompt = { version: 1, sha256: hash(prompt), genre: t.kind }
  },

  async modelStatus(t) {
    const response = await this.fetch(t.lgUrl + '/api/models/selection', {
      signal: AbortSignal.timeout(10000),
    }).catch(() => {
      throw new Error('无法读取翻译模型状态')
    })
    const selection = (await response.json()).data
    const full = await this.lg(t, '/api/models/snapshot', {})
    const model = full.snapshot?.models?.find(m => m.id === selection?.model_selection?.translation)
    if (!model) throw new Error('没有选定翻译模型')
    return {
      name: model.name,
      model: model.model_id,
      thinking: model.thinking?.level,
      credentialConfigured: model.auth_type === 'oauth'
        ? null
        : typeof model.api_key === 'string' && Boolean(model.api_key.trim()),
      connectionVerified: false,
    }
  },

  async ensureLgProject(t) {
    const snapshot = await this.lg(t, '/api/session/project/snapshot', {})
    if (!snapshot.project?.loaded && t.lgProject) {
      await this.lg(t, '/api/session/project/open', { path: t.lgProject })
      return
    }
    if (snapshot.project?.path !== t.lgProject) {
      throw new Error('LinguaGacha当前工程与任务不一致，未发送翻译')
    }
  },

  async importTranslation(id, bytes) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务')
      if (this.active.has(id)) throw new Error('运行中不能导入译文')
      if (bytes.length > 20 * 1024 * 1024) throw new Error('译文文件过大')

      if (bytes.toString('utf8').includes('dsh-block:')) {
        await this.acceptTranslationOutput(t, bytes.toString('utf8'))
      } else {
        const file = path.join(this.dir(id), 'translation/translated.md')
        await fs.mkdir(path.dirname(file), { recursive: true })
        if (await exists(file)) await fs.copyFile(file, `${file}.bak-${Date.now()}`)
        await fs.writeFile(file, bytes)
        await fs.unlink(sourceMapPath(file)).catch(e => { if (e.code !== 'ENOENT') throw e })
        await fs.unlink(path.join(this.dir(id), 'translation/alignment.json')).catch(e => {
          if (e.code !== 'ENOENT') throw e
        })
      }

      delete t.stages.translationCheck
      delete t.stages.review
      delete t.stages.publish
      delete t.translationReport
      delete t.translationPath
      delete t.review
      delete t.publication
      return this.save(t)
    })
  },

  async importSourceMap(id, view, map, pdfSourceId = '') {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy || this.active.has(id)) throw new Error('请在可编辑的空闲接续任务中导入来源映射')
      if (!['original', 'translation'].includes(view) || map.view !== view) {
        throw new Error('来源映射的文本类型无效')
      }

      const file = view === 'original'
        ? await this.original(t)
        : path.join(this.dir(id), 'translation/translated.md')
      const text = await fs.readFile(file, 'utf8')
      if (pdfSourceId) {
        const pdf = (await this.catalog()).find(s => s.id === pdfSourceId && s.type === 'pdf')
        if (!pdf || await fileDigest(pdf.path) !== map.pdf?.sha256) {
          throw new Error('所选 PDF 与映射指纹不一致')
        }
        map = { ...map, pdf: { ...map.pdf, file: path.relative(path.dirname(file), pdf.path) } }
      }
      await validateSourceMap(this, file, text, map)

      if (view === 'translation') {
        const original = await this.original(t)
        const source = await fs.readFile(original, 'utf8')
        const sourceMap = await loadSourceMap(this, original, source)
        if (!sourceMap || !translationMapMatches(sourceMap, map)) {
          throw new Error('译文映射必须保留当前原文的段落标识与指纹')
        }
      }

      await writeSourceMap(file, map)
      delete t.stages.translationCheck
      delete t.stages.review
      delete t.stages.publish
      delete t.translationReport
      delete t.review
      delete t.publication
      return this.save(t)
    })
  },
}
