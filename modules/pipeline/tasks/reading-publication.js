import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileDigest, loadSourceMap } from '../source-map.js'
import { enrichReading, replaceBlock } from '../reader.js'
import { isTraditionalChinese, convertHantToHansMarkdown } from '../zh-convert.js'
import { attachPdfLocations } from '../pdf-location.js'
import { hash, markdownBlocks, checkMarkdownPair } from '../markdown.js'
import { quoteSlices } from '../bookmarks.js'
import { requireBookGlossary, registerJointReview } from '../glossary.js'
import {
  prepareReviewAudit,
  assembleReviewAudit,
  applyReviewAudit,
  runAgyReviewAudit,
  isAgyCliModel,
} from '../review-audit.js'
import { buildPublication, commitPublication } from '../publication.js'
import { pruneTaskCaches } from '../hygiene.js'
import { assertPhaseApproved } from '../phases.js'
import { exists, atomic, json, walk } from './shared.js'
import {
  readCloudSyncConfig,
  saveCloudSyncConfig,
  publicSyncStatus,
  syncWithCloud,
} from '../sync.js'
import { createLibrarySearcher } from '../search.js'
import { resolveWorkspaceAsset } from '../../../shared/workspace.js'
import {
  buildBilingualMarkdown,
  contentDispositionFor,
  renderPdfFromReading,
  sanitizeExportFilename,
} from '../export-pdf.js'

function pickCitationStr(v) {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim()
  if (typeof v === 'object') return String(v.source ?? v.zh ?? '').trim()
  return ''
}

function inferTaskCitation(task) {
  const bib = task.profile?.bibliography ?? {}
  const meta = task.paperImport?.metadata ?? {}
  const pubObj = meta.publication && typeof meta.publication === 'object' ? meta.publication : null
  const rawTitle = String(task.name ?? meta.title?.zh ?? meta.title?.source ?? '').trim()
  const bibTitle = String(bib.title ?? '').trim()
  const bibOrigTitle = String(bib.original_title ?? bib.originalTitle ?? '').trim()
  const profTitle = String(task.profile?.title ?? meta.title?.source ?? '').trim()
  const inputBase = path.basename(String(task.input?.name ?? ''), path.extname(String(task.input?.name ?? '')))
  const isCjk = s => /[\u4e00-\u9fff]/.test(String(s ?? ''))
  let authors = String(bib.authors ?? '').trim() || pickCitationStr(meta.author)
  let title = rawTitle || bibTitle
  let originalTitle = bibOrigTitle || (profTitle && profTitle !== title ? profTitle : '')
  if (!originalTitle && bibTitle && bibTitle !== title && !isCjk(bibTitle)) {
    originalTitle = bibTitle
  }
  let year = String(bib.year ?? pubObj?.year ?? '').trim()
  if (!year) {
    const yearMatch = (profTitle || rawTitle || inputBase).match(/\b((?:18|19|20)\d{2})\b/)
    if (yearMatch) year = yearMatch[1]
  }
  const authorDash = profTitle.match(/^([A-Za-zÀ-ÖØ-öø-ÿ.\s,'&-]{2,48}?)\s+[-–—]\s+(.+?)(?:\s*\((?:18|19|20)\d{2}\))?$/)
  if (authorDash) {
    if (!authors) authors = authorDash[1].trim()
    if (!originalTitle || originalTitle === profTitle) originalTitle = authorDash[2].trim()
  }
  const pubStr = typeof meta.publication === 'string' ? meta.publication.trim() : ''
  const rawKind = String(bib.kind ?? '').toLowerCase()
  const taskKind = String(task.kind ?? task.profile?.document_type ?? '').toLowerCase()
  const kind = ['book', 'paper', 'collection', 'incollection'].includes(rawKind)
    ? rawKind
    : rawKind === 'chapter'
      ? 'incollection'
      : taskKind === 'paper'
        ? (pubObj?.book ? 'incollection' : 'paper')
        : taskKind === 'chapter'
          ? 'incollection'
          : taskKind === 'collection'
            ? 'collection'
            : 'book'
  const isPaper = kind === 'paper'
  const isIncollection = kind === 'incollection'
  const bookTitle = String(bib.book_title ?? bib.bookTitle ?? (pubObj?.book ? pickCitationStr(pubObj.book.zh ?? pubObj.book) : '')).trim()
  const originalBookTitle = String(bib.original_book_title ?? bib.originalBookTitle ?? (pubObj?.book ? pickCitationStr(pubObj.book.source ?? '') : '')).trim()
  return {
    kind,
    title,
    subtitle: String(bib.subtitle ?? '').trim(),
    originalTitle,
    authors,
    editors: String(bib.editors ?? '').trim(),
    translators: String(bib.translators ?? '').trim(),
    bookTitle,
    originalBookTitle,
    publisher: String(bib.publisher ?? (pubObj ? pickCitationStr(pubObj.publisher) : (isPaper ? '' : pubStr))).trim(),
    journal: String(bib.journal ?? (pubObj && !isIncollection ? pickCitationStr(pubObj.journal) : (isPaper ? pubStr : ''))).trim(),
    year,
    volume: String(bib.volume ?? '').trim(),
    issue: String(bib.issue ?? pubObj?.issue ?? '').trim(),
    pages: String(bib.pages ?? pubObj?.pages ?? '').trim(),
    isbn: String(bib.isbn ?? pubObj?.isbn ?? '').trim(),
    doi: String(bib.doi ?? pubObj?.doi ?? '').trim(),
  }
}

function mergeTaskCitation(autoCite, savedCite, fallbackTitle = '') {
  const merged = { ...(autoCite ?? {}) }
  if (savedCite) {
    for (const [k, v] of Object.entries(savedCite)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') merged[k] = v
    }
  }
  if (!merged.title) merged.title = fallbackTitle
  return { ...merged, saved: Boolean(savedCite) }
}

export async function runDeliveryStage(manager, t, stage, options = {}) {
  if (stage === 'review') {
    await manager.requireDone(t, 'translationCheck')
    const report = path.join(manager.dir(t.id), 'review/report.md')
    let reportContent = ''
    try { reportContent = await fs.readFile(report, 'utf8') } catch {}
    if (
      !reportContent
      || options.runAgy === true
      || options.sessionOrchestrated === true
      || options.force === true
      || (manager.modelService && t.reviewAudit && t.review?.status === 'needs-work')
    ) {
      await runAgyReviewAudit(manager, t, options)
    }
    await registerJointReview(manager, t, report)
    if (t.publication && !t.publication.published) {
      delete t.publication
      if (t.stages?.publish?.state !== 'done') delete t.stages.publish
    }
    return true
  }

  if (stage === 'publish') {
    await manager.requireDone(t, 'translationCheck', 'review')
    t.publication = await manager.publishPreview(t)
    return true
  }

  return false
}

export const readingPublicationMethods = {
  async original(t) {
    if (t.sourceRevision) {
      const r = t.sourceRevision
      if (
        !r.record.startsWith(this.dir(t.id) + path.sep)
        || await fileDigest(r.record) !== r.recordFingerprint
        || await fileDigest(r.path) !== r.sourceFingerprint
      ) {
        throw new Error('原文修订记录或文件发生变化，请重新核验')
      }
      const saved = await json(r.record)
      if (
        saved.path !== r.path
        || saved.sourceFingerprint !== r.sourceFingerprint
        || saved.originalFingerprint !== r.originalFingerprint
        || !r.path.startsWith(this.dir(t.id) + path.sep)
        || await fileDigest(saved.baseSource) !== saved.baseFingerprint
      ) {
        throw new Error('原文修订来源不一致')
      }
      return r.path
    }
    if (t.legacy?.artifacts?.original) return t.legacy.artifacts.original
    if (t.input.type === 'markdown') return t.path

    const files = await walk(path.join(this.aiDir(t), 'book'), /\.md$/, 4)
    const full = files.filter(f => /-full\.md$/.test(f))
    if (full.length > 1) throw new Error('存在多份整书原文，须先核实来源')
    if (full.length === 1) return full[0]

    const chapters = (await walk(path.join(this.aiDir(t), 'chapters'), /\.md$/, 1))
      .filter(f => !/[.]review-[a-f0-9]{64}[.]md$/.test(f))
    if (t.kind !== 'book' && t.kind !== 'collection' && chapters.length === 1) return chapters[0]
    throw new Error('尚无经过装配的原文 Markdown')
  },

  async requireGlossary(t) {
    return requireBookGlossary(this, t)
  },

  async requireGlossaryForPublish(t) {
    const receipt = path.join(this.dir(t.id), 'glossary/pipeline-receipt.json')
    if (await exists(receipt) || t.glossaryReport?.schemaVersion === 4) {
      return this.requireGlossary(t)
    }
    if (
      t.stages?.glossary?.state === 'done'
      && t.review?.status === 'pass'
      && await exists(path.join(this.dir(t.id), 'glossary.json'))
    ) {
      return null
    }
    return this.requireGlossary(t)
  },

  async prepareReviewAudit(id, options = {}) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      assertPhaseApproved(t, 'review')
      t.reviewAudit = await prepareReviewAudit(this, t, options)
      const v = await assembleReviewAudit(this, t, { auditDir: t.reviewAudit.auditDir })
      const now = new Date().toISOString()
      const isAgy = isAgyCliModel(t.reviewConfig?.orchestratorModel)
      const prev = t.reviewProgress ?? {}

      t.stage = 'review'
      if (options.force && !v.complete) {
        if (t.stages?.review?.state === 'done') delete t.stages.review
        delete t.review
        if (t.publication && !t.publication.published) {
          delete t.publication
          if (t.stages?.publish?.state !== 'done') delete t.stages.publish
        }
      }
      t.reviewProgress = {
        ...prev,
        engine: isAgy ? 'agy-bridge' : 'dsh-session',
        phase: 'session-review',
        status: v.complete && !v.unresolved?.length ? 'done' : 'running',
        runId: prev.engine === 'dsh-session' && prev.runId ? prev.runId : randomUUID(),
        totalPackets: t.reviewAudit.totalPackets,
        completedPackets: v.completed,
        receivedPackets: v.completed,
        passedPackets: t.reviewAudit.totalPackets - (t.reviewAudit.pendingPackets?.length ?? 0),
        model: t.reviewConfig?.orchestratorModel ?? t.phaseApproval?.orchestratorModel ?? null,
        startedAt: prev.engine === 'dsh-session' && prev.startedAt ? prev.startedAt : now,
        lastInteractionAt: now,
      }
      if (!isAgy) {
        delete t.reviewProgress.conversationId
        delete t.reviewProgress.childConversations
        delete t.reviewProgress.logFile
        delete t.reviewProgress.pid
      }
      await this.save(t)
      return t.reviewAudit
    })
  },

  async assembleReviewAudit(id, options = {}) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      assertPhaseApproved(t, 'review')
      const v = await assembleReviewAudit(this, t, options)
      const now = new Date().toISOString()
      const isAgy = isAgyCliModel(t.reviewConfig?.orchestratorModel)
      const pending = t.reviewAudit?.manifest
        ? t.reviewAudit.manifest
          .filter(p => !v.validPackets.includes(p.id) || v.unresolved.some(u => u.packet === p.id))
          .map(p => p.id)
        : []
      if (t.reviewAudit && pending.length >= 0) t.reviewAudit.pendingPackets = pending

      t.reviewProgress = {
        ...(t.reviewProgress ?? {}),
        engine: isAgy ? 'agy-bridge' : 'dsh-session',
        phase: 'session-review',
        status: v.complete && !v.unresolved?.length ? 'done' : t.reviewProgress?.status ?? 'running',
        totalPackets: v.total,
        completedPackets: v.completed,
        receivedPackets: v.completed,
        passedPackets: v.total - pending.length,
        patchCount: v.patchCount,
        glossaryDecisionCount: v.glossaryDecisionCount,
        lastInteractionAt: now,
      }
      if (!isAgy) {
        delete t.reviewProgress.conversationId
        delete t.reviewProgress.childConversations
        delete t.reviewProgress.logFile
        delete t.reviewProgress.pid
      }
      await this.save(t)
      return v
    })
  },

  async applyReviewAudit(id, options = {}) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      assertPhaseApproved(t, 'review')
      const v = await applyReviewAudit(this, t, options)
      await this.save(t)
      return v
    })
  },

  async runAgyReviewAudit(id, options = {}) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      assertPhaseApproved(t, 'review')
      const v = await runAgyReviewAudit(this, t, {
        ...options,
        model: t.reviewConfig.orchestratorModel,
        effort: t.reviewConfig.orchestratorEffort,
      })
      await this.save(t)
      return v
    })
  },

  async bookmarkDocument(source, view = 'original') {
    if (source?.kind === 'task') {
      const t = await this.get(source.id)
      const doc = await this.reading(t.id)
      return {
        id: t.documentId ?? 'document:' + t.input.fingerprint,
        title: t.name,
        kind: t.kind,
        source: { kind: 'task', id: t.id },
        version: doc.version ?? hash(doc.fingerprint + '|' + (t.translationReport?.targetFingerprint ?? '')),
        blocks: doc.standaloneView === 'translation'
          ? (view === 'original' ? (doc.originalBlocks ?? []) : doc.blocks.map(b => ({ ...b, translation: b.text })))
          : doc.blocks,
      }
    }
    if (source?.kind !== 'paper' || typeof source.id !== 'string' || !/^[\w.\-一-鿿]+\.json$/u.test(source.id)) {
      throw new Error('书签文档无效')
    }
    const file = await fs.realpath(path.join(this.readingRoot, source.id))
    const base = await fs.realpath(this.readingRoot)
    if (!file.startsWith(base + path.sep)) throw new Error('书签文档路径无效')
    const raw = await fs.readFile(file, 'utf8')
    const doc = JSON.parse(raw)
    if (doc.status !== 'done') throw new Error('此文档尚未完成处理')
    return {
      id: 'paper:' + String(doc.id ?? source.id),
      title: doc.title?.zh ?? doc.title?.source ?? doc.id,
      kind: 'paper',
      source: { kind: 'paper', id: source.id },
      version: hash(raw),
      blocks: (doc.blocks ?? []).map(b => ({
        id: String(b.id),
        text: b.source ?? b.text,
        translation: b.text,
      })),
    }
  },

  async bookmarks(query = {}) {
    const saved = await this.bookmarkStore.list(query)
    const ids = new Set(saved.map(b => b.id))
    await this.ensureIndex()
    const summaries = await this.index.summaries()

    for (const t of summaries) {
      for (const b of t.bookmarks ?? []) {
        const documentId = t.documentId ?? 'document:' + t.input.fingerprint
        if (ids.has(b.id)) continue
        if (query.documentId && query.documentId !== documentId) continue
        if (query.q && ![b.excerpt, b.note, t.name].join(' ').toLowerCase().includes(query.q.toLowerCase())) {
          continue
        }
        saved.push({
          ...b,
          documentId,
          source: { kind: 'task', id: t.id },
          document: { id: documentId, title: t.name, kind: t.kind },
          quote: b.excerpt,
          comment: b.note,
          tags: [],
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          selector: {
            type: 'LegacyBlockSelector',
            startBlockId: b.blockId,
            endBlockId: b.blockId,
            view: 'original',
          },
        })
      }
    }

    const migrated = (await this.list()).filter(t => t.paperImport)
    for (const b of saved) {
      if (b.source?.kind === 'paper') {
        const t = migrated.find(item => item.paperImport.file === b.source.id)
        if (t) b.source = { kind: 'task', id: t.id }
      }
    }
    const names = new Map(summaries.map(t => [t.id, t]))
    const docIndexes = new Map()
    const cleanHeading = raw => String(raw ?? '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/[*`_]/g, '')
      .trim()
    const buildPairedIndex = (origText, transText) => {
      const origBlocks = origText ? markdownBlocks(origText) : []
      const transBlocks = transText ? markdownBlocks(transText) : []
      const paired = origBlocks.length > 0 && origBlocks.length === transBlocks.length
      const original = new Map()
      const translation = new Map()
      let origChap = ''
      let transChap = ''
      const updateChap = (blk, i, cur) => {
        if (blk?.type !== 'heading') return cur
        const title = cleanHeading(blk.text)
        if (title && (blk.level >= 2 || i > 0) && !/^(目录|table of contents|contents|sommaire|inhaltsverzeichnis)$/i.test(title)) {
          return title
        }
        return cur
      }
      if (paired) {
        for (let i = 0; i < origBlocks.length; i++) {
          origChap = updateChap(origBlocks[i], i, origChap)
          transChap = updateChap(transBlocks[i], i, transChap)
          const origId = String(origBlocks[i].id)
          const transId = String(transBlocks[i].id)
          original.set(origId, { order: i, chapter: origChap })
          translation.set(origId, { order: i, chapter: transChap || origChap })
          if (transId !== origId) {
            translation.set(transId, { order: i, chapter: transChap || origChap })
          }
        }
      } else {
        for (let i = 0; i < origBlocks.length; i++) {
          origChap = updateChap(origBlocks[i], i, origChap)
          original.set(String(origBlocks[i].id), { order: i, chapter: origChap })
        }
        for (let i = 0; i < transBlocks.length; i++) {
          transChap = updateChap(transBlocks[i], i, transChap)
          translation.set(String(transBlocks[i].id), { order: i, chapter: transChap })
        }
      }
      return { original, translation }
    }
    const formatPages = nums => {
      const valid = [...new Set((nums ?? []).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
      if (!valid.length) return ''
      return valid.length === 1 ? String(valid[0]) : `${valid[0]}-${valid[valid.length - 1]}`
    }
    const loadDocIndex = async taskId => {
      if (docIndexes.has(taskId)) return docIndexes.get(taskId)
      let entry = { available: false, original: null, translation: null, pagesByBlock: new Map(), autoCitation: null }
      if (names.has(taskId)) {
        try {
          const task = await this.get(taskId)
          entry.available = true
          entry.autoCitation = inferTaskCitation(task)
          const origPath = task.legacy ? task.legacy.artifacts?.original : await this.original(task).catch(() => null)
          const transPath = task.legacy ? task.legacy.artifacts?.readingPath : task.translationPath
          const origText = origPath ? await fs.readFile(origPath, 'utf8').catch(() => '') : ''
          const transText = transPath && transPath !== origPath ? await fs.readFile(transPath, 'utf8').catch(() => '') : origText
          const built = buildPairedIndex(origText, transText)
          entry.original = built.original
          entry.translation = built.translation
          if (origPath && origText) {
            const sm = await loadSourceMap(this, origPath, origText).catch(() => null)
            if (sm?.blocks?.length) {
              for (const blk of sm.blocks) {
                const p = formatPages(blk.logicalPages?.length ? blk.logicalPages : blk.pdfPages)
                if (p && blk.markdownBlockId) entry.pagesByBlock.set(String(blk.markdownBlockId), p)
              }
            }
          }
          if (task.paperImport?.blockIds?.length && task.paperImport?.pages?.length && origText) {
            const origBlocks = markdownBlocks(origText)
            for (let i = 0; i < Math.min(origBlocks.length, task.paperImport.pages.length); i++) {
              const pg = task.paperImport.pages[i]
              if (pg != null && String(pg).trim()) {
                entry.pagesByBlock.set(String(origBlocks[i].id), String(pg).trim())
              }
            }
          }
        } catch {}
      }
      docIndexes.set(taskId, entry)
      return entry
    }
    for (const b of saved) {
      if (b.source?.kind === 'task') {
        if (names.has(b.source.id)) {
          const t = names.get(b.source.id)
          b.document = { ...b.document, title: t.name, kind: t.kind }
        }
        const idx = await loadDocIndex(b.source.id)
        b.sourceAvailable = idx.available
        const blockId = String(b.selector?.startBlockId ?? b.blockId ?? '')
        const pref = b.selector?.view === 'translation' ? [idx.translation, idx.original] : [idx.original, idx.translation]
        const hit = blockId ? (pref[0]?.get(blockId) ?? pref[1]?.get(blockId) ?? null) : null
        b.blockOrder = hit ? hit.order : null
        b.chapter = hit ? hit.chapter : ''
        b.pages = blockId ? (idx.pagesByBlock.get(blockId) ?? '') : ''
        if (idx.autoCitation || b.document?.citation) {
          const savedCite = b.document?.citation ?? null
          const merged = { ...(idx.autoCitation ?? {}) }
          if (savedCite) {
            for (const [k, v] of Object.entries(savedCite)) {
              if (v !== undefined && v !== null && String(v).trim() !== '') merged[k] = v
            }
          }
          if (!merged.title) merged.title = b.document?.title ?? ''
          b.document = { ...b.document, citation: { ...merged, saved: Boolean(savedCite) } }
        }
      } else {
        b.sourceAvailable = true
        b.blockOrder = null
        b.chapter = ''
        b.pages = ''
      }
    }
    return saved.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  async readingMarks(source) {
    const doc = await this.bookmarkDocument(source, 'original')
    const [highlights, bookmarks] = await Promise.all([
      this.bookmarkStore.highlights({ documentId: doc.id }),
      this.bookmarkStore.list({ documentId: doc.id }),
    ])
    const marks = []
    const push = (item, kind) => {
      if (item.selector?.type !== 'TextQuoteSelector') return
      for (const slice of quoteSlices(doc.blocks, item.selector)) {
        marks.push({
          id: item.id,
          kind,
          style: item.style ?? 'highlight',
          color: item.color ?? 'gold',
          view: item.selector.view === 'translation' ? 'translation' : 'original',
          blockId: slice.blockId,
          quote: slice.quote,
          exact: item.quote,
          comment: item.comment ?? '',
        })
      }
    }
    for (const item of highlights) push(item, 'highlight')
    for (const item of bookmarks) {
      if (item.highlight !== false) push(item, 'bookmark')
    }
    return marks
  },

  async saveSelectionBookmark(args) {
    if (args.updateDocumentCitation?.documentId) {
      return this.bookmarkStore.updateDocumentCitation(
        args.updateDocumentCitation.documentId,
        args.updateDocumentCitation.citation,
      )
    }
    if (args.muteHighlight) return this.bookmarkStore.muteHighlight(args.muteHighlight)
    if (args.removeHighlight) return this.bookmarkStore.removeHighlight(args.removeHighlight)
    if (args.updateBookmark?.id) return this.bookmarkStore.update(args.updateBookmark.id, args.updateBookmark)
    if (args.remove) {
      const hit = (await this.bookmarks()).find(b => b.id === args.remove)
      if (hit?.selector.type === 'LegacyBlockSelector') {
        return this.bookmark(hit.source.id, { remove: args.remove })
      }
      return this.bookmarkStore.remove(args.remove)
    }
    const doc = await this.bookmarkDocument(args.source, args.selection?.view)
    return args.highlightOnly
      ? this.bookmarkStore.addHighlight(doc, args)
      : this.bookmarkStore.add(doc, args)
  },

  async baseReading(id) {
    const t = await this.get(id)
    if (t.legacy) {
      const f = t.legacy.artifacts.readingPath
      if (!f) throw new Error('此书尚无可阅读的装配成果')
      const text = await fs.readFile(f, 'utf8')
      if (hash(text) !== t.legacy.readingFingerprint) {
        throw new Error('旧成品已变化，先重新扫描原项目再阅读')
      }
      const isTranslation = Boolean(t.legacy.artifacts.translation && f !== t.legacy.artifacts.original)
      const blocks = markdownBlocks(text)
      const source = t.legacy.artifacts.original
        ? await fs.readFile(t.legacy.artifacts.original, 'utf8')
        : null
      const originalBlocks = source ? markdownBlocks(source) : null
      if (t.paperImport && source && hash(source) !== t.input.fingerprint) {
        throw new Error('论文原文快照已变化，保留修订并核验快照')
      }
      const bookmarkBlocks = [
        ...new Map(
          [
            ...(originalBlocks ?? []),
            ...(isTranslation ? blocks.map(b => ({ ...b, translation: b.text })) : blocks),
          ].map(b => [b.id, b]),
        ).values(),
      ]
      return {
        id,
        title: t.name,
        fingerprint: hash(text),
        blocks,
        originalBlocks,
        version: hash(text + '|' + (source ?? '')),
        bookmarkBlocks,
        standaloneView: isTranslation ? 'translation' : 'original',
        bookmarks: t.bookmarks ?? [],
      }
    }

    const file = await this.original(t)
    const source = await fs.readFile(file, 'utf8')
    const blocks = markdownBlocks(source)
    const translated = t.translationPath ? await fs.readFile(t.translationPath, 'utf8') : ''
    const translation = (
      t.translationReport?.passed
      && t.translationReport.sourceFingerprint === hash(source)
      && t.translationReport.targetFingerprint === hash(translated)
    ) ? markdownBlocks(translated) : []
    return {
      id,
      title: t.name,
      fingerprint: hash(source),
      blocks: blocks.map((b, i) => ({ ...b, translation: translation[i]?.text })),
      bookmarks: t.bookmarks.map(b => ({ ...b, stale: !blocks.some(block => block.id === b.blockId) })),
    }
  },

  zhConvertCacheFile(sourceHash) {
    return path.join(this.root, '.pipeline/zh-convert', sourceHash + '.md')
  },

  async convertedZhTranslation(sourceText, { generate = false } = {}) {
    if (!sourceText) return null
    const file = this.zhConvertCacheFile(hash(sourceText))
    try {
      return await fs.readFile(file, 'utf8')
    } catch {}
    if (!generate) return null
    const converted = await convertHantToHansMarkdown(sourceText)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, converted, { mode: 0o600 })
      await fs.rename(tmp, file)
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
    return converted
  },

  async convertTraditionalToSimplified(id, args = {}) {
    return this.locked(id, async () => {
      const enabled = args.enabled !== false
      const t = await this.get(id)
      const base = await this.baseReading(id)
      const hasExternal = t.legacy
        ? Boolean(t.legacy.artifacts.translation && t.legacy.artifacts.readingPath !== t.legacy.artifacts.original)
        : base.blocks.some(b => b.translation)
      if (hasExternal) throw new Error('此文档已有译文，无需繁简转换')

      if (enabled) {
        const original = t.legacy
          ? t.legacy.artifacts.original ?? t.legacy.artifacts.readingPath
          : await this.original(t)
        const source = original ? await fs.readFile(original, 'utf8') : ''
        if (!isTraditionalChinese(source)) {
          throw new Error('当前文档不是繁体中文，暂不能进行繁简转换')
        }
        const converted = await this.convertedZhTranslation(source, { generate: true })
        t.zhConvert = {
          enabled: true,
          target: 'hans',
          sourceFingerprint: hash(source),
          targetFingerprint: hash(converted),
          updatedAt: new Date().toISOString(),
        }
      } else {
        delete t.zhConvert
      }
      await this.save(t)
      return this.reading(id)
    })
  },

  async readingTexts(t, base) {
    const original = t.legacy
      ? t.legacy.artifacts.original ?? t.legacy.artifacts.readingPath
      : await this.original(t)
    const target = t.legacy
      ? (t.legacy.artifacts.translation && t.legacy.artifacts.readingPath !== original
        ? t.legacy.artifacts.readingPath
        : null)
      : (base.blocks.some(b => b.translation) ? t.translationPath : null)
    const source = original ? await fs.readFile(original, 'utf8') : null
    let translation = target ? await fs.readFile(target, 'utf8') : null
    let zhConverted = false
    if (!translation && t.zhConvert?.enabled && source) {
      translation = await this.convertedZhTranslation(source, { generate: true })
      zhConverted = Boolean(translation)
    }
    return { source, translation, original, target, zhConverted }
  },

  async correctionContext(t) {
    const base = await this.baseReading(t.id)
    const texts = await this.readingTexts(t, base)
    const baseVersion = hash((texts.source ?? '') + '|' + (texts.translation ?? ''))
    const directory = path.join(this.root, '.pipeline/documents', hash(t.documentId))
    const manifest = path.join(directory, baseVersion + '.json')
    const record = await json(manifest, null)

    if (record) {
      for (const view of ['original', 'translation']) {
        const textKey = view === 'original' ? 'source' : 'translation'
        if (typeof record.texts?.[view] === 'string') {
          texts[textKey] = record.texts[view]
          continue
        }
        const f = record.storageVersion === 2 ? null : record.files?.[view]
        if (f) {
          if (path.basename(f) !== f) throw new Error('修订记录路径异常')
          texts[textKey] = await fs.readFile(path.join(directory, f), 'utf8')
        }
      }
    }
    return { base, texts, directory, manifest, record, baseVersion }
  },

  async reading(id) {
    const t = await this.get(id)
    const ctx = await this.correctionContext(t)
    const { base, texts, record } = ctx
    let doc = base

    if (texts.zhConverted) {
      const blocks = markdownBlocks(texts.source)
      const target = texts.translation ? markdownBlocks(texts.translation) : []
      doc = {
        ...base,
        standaloneView: undefined,
        originalBlocks: null,
        bookmarkBlocks: undefined,
        blocks: blocks.map((b, i) => ({ ...b, translation: target[i]?.text })),
        version: hash((texts.source ?? '') + '|' + (texts.translation ?? '')),
      }
    } else if (record) {
      if (base.standaloneView) {
        doc = {
          ...base,
          blocks: markdownBlocks(base.standaloneView === 'translation' ? texts.translation : texts.source),
          originalBlocks: texts.source ? markdownBlocks(texts.source) : null,
          version: hash((texts.source ?? '') + '|' + (texts.translation ?? '')),
        }
      } else {
        const blocks = markdownBlocks(texts.source)
        const target = texts.translation ? markdownBlocks(texts.translation) : []
        doc = {
          ...base,
          blocks: blocks.map((b, i) => ({ ...b, translation: target[i]?.text })),
          version: hash(texts.source + '|' + (texts.translation ?? '')),
        }
      }
    }

    if (t.paperImport) {
      const src = doc.originalBlocks ?? []
      const ids = t.paperImport.blockIds
      doc = {
        ...doc,
        documentId: t.documentId,
        metadata: t.paperImport.metadata,
        glossary: t.paperImport.glossary,
        importWarnings: t.paperImport.warnings,
        explicitPairs: src.length === doc.blocks.length && src.length === ids.length,
        blockAliases: {
          original: Object.fromEntries(ids.map((itemId, i) => [itemId, src[i]?.id])),
          translation: Object.fromEntries(ids.map((itemId, i) => [itemId, doc.blocks[i]?.id])),
        },
      }
    }

    if (t.glossaryReport?.schemaVersion === 4 && t.glossaryReport.cleaningCompleted === true) {
      const file = path.join(this.dir(t.id), 'glossary.json')
      const terms = await json(file, [])
      if (hash(await fs.readFile(file)) === t.glossaryReport.effectiveFingerprint) {
        doc = {
          ...doc,
          glossary: terms.map(e => ({ source: e.src, target: e.dst, note: e.info })),
        }
      }
    }

    const zhConvertEligible = !texts.translation && !texts.zhConverted && isTraditionalChinese(texts.source ?? '')
    const savedDocCite = await this.bookmarkStore.read()
      .then(st => st.documents?.[t.documentId]?.citation ?? null)
      .catch(() => null)
    const citation = mergeTaskCitation(inferTaskCitation(t), savedDocCite, t.documentTitle ?? t.name ?? doc.title ?? '')
    return attachPdfLocations(
      this,
      t,
      enrichReading({
        ...doc,
        title: t.documentTitle ?? t.name ?? doc.title,
        kind: t.kind,
        documentId: t.documentId,
        citation,
        zhConverted: Boolean(texts.zhConverted),
        zhConvertEligible,
        version: hash((texts.source ?? '') + '|' + (texts.translation ?? '')),
        correctionCount: record?.revisions?.length ?? 0,
        correctionReview: record?.structuralCheck ?? null,
      }),
    )
  },

  async correctReading(id, args) {
    const t = await this.get(id)
    return this.locked('correction:' + t.documentId, async () => {
      if (this.active.has(id)) throw new Error('任务正在处理，暂不能保存勘误')
      if (!['original', 'translation'].includes(args.view)) throw new Error('编辑文本类型无效')

      const current = await this.reading(id)
      if (current.version !== args.version) {
        throw new Error('文档已由另一窗口修改，请重新打开后保存')
      }
      const ctx = await this.correctionContext(t)
      const key = args.view === 'original' ? 'source' : 'translation'
      const text = ctx.texts[key]
      if (text === null) throw new Error('此文档没有对应文本')

      let blockId = args.blockId
      if (!current.standaloneView && args.view === 'translation') {
        const i = current.blocks.findIndex(b => b.id === blockId)
        blockId = markdownBlocks(text)[i]?.id
      }
      const next = replaceBlock(text, blockId, args.text)
      if (next === text) return current

      await fs.mkdir(ctx.directory, { recursive: true })
      const files = { ...ctx.record?.files }
      // Keep one initial snapshot per view and paragraph deltas; no full-book copy per correction.
      const token = randomUUID()
      const baseFile = `${ctx.baseVersion}-${args.view}-base.md`
      if (!await exists(path.join(ctx.directory, baseFile))) {
        await fs.writeFile(path.join(ctx.directory, baseFile), text, { flag: 'wx', mode: 0o600 })
      }
      files[args.view] = baseFile

      const beforeBlock = markdownBlocks(text).find(b => b.id === blockId)
      ctx.texts[key] = next
      const record = {
        schemaVersion: 1,
        storageVersion: 2,
        documentId: t.documentId,
        baseVersion: ctx.baseVersion,
        files,
        texts: {
          ...ctx.record?.texts,
          ...Object.fromEntries(
            ['original', 'translation']
              .filter(view => view === args.view || ctx.record?.files?.[view])
              .map(view => [view, ctx.texts[view === 'original' ? 'source' : 'translation']]),
          ),
        },
        revisions: [
          ...(ctx.record?.revisions ?? []),
          {
            id: token,
            view: args.view,
            blockId: args.blockId,
            at: new Date().toISOString(),
            beforeText: beforeBlock.text,
            afterText: args.text,
            beforeFingerprint: hash(text),
            afterFingerprint: hash(next),
            reason: String(args.reason ?? '').slice(0, 2000),
          },
        ],
        structuralCheck: ctx.texts.source && ctx.texts.translation
          ? checkMarkdownPair(ctx.texts.source, ctx.texts.translation)
          : null,
        semanticVerified: false,
      }
      await atomic(ctx.manifest, record)
      this.scheduleBackgroundSync?.(4000, 'correction')
      return this.reading(id)
    })
  },

  async readingDownload(id, view) {
    const t = await this.get(id)
    await this.baseReading(id)
    const ctx = await this.correctionContext(t)
    const value = view === 'original' ? ctx.texts.source : ctx.texts.translation ?? ctx.texts.source
    if (value === null) throw new Error('尚无对应文本')
    return value
  },

  async _collectExportAssetDataUris(t, reading) {
    const map = new Map()
    const refs = new Set()
    const scan = text => {
      if (typeof text !== 'string' || !text.includes('![')) return
      for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const ref = m[1]
        if (ref && !/^(?:https?:|data:|blob:)/i.test(ref)) refs.add(ref)
      }
    }
    for (const b of reading?.blocks ?? []) {
      scan(b.text)
      scan(b.translation)
      scan(b.sourceText)
    }
    for (const b of reading?.originalBlocks ?? []) scan(b.text)
    if (!refs.size) return map

    const origFile = t.legacy
      ? (t.legacy.artifacts?.readingPath ?? t.legacy.artifacts?.original)
      : await this.original(t).catch(() => null)
    if (!origFile) return map
    const base = await fs.realpath(path.dirname(origFile)).catch(() => null)
    if (!base) return map
    const allowedRoots = (await Promise.all(
      [this.root, this.readingRoot, this.publishRoot]
        .filter(Boolean)
        .map(r => fs.realpath(r).catch(() => null)),
    )).filter(Boolean)
    const mimeOf = f => (/\.png$/i.test(f) ? 'image/png' : /\.gif$/i.test(f) ? 'image/gif' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg')

    for (const ref of refs) {
      try {
        const wanted = resolveWorkspaceAsset(this.root, base, ref)
        const real = await fs.realpath(wanted)
        if (!allowedRoots.some(r => real.startsWith(r + path.sep))) continue
        if (!/\.(png|jpe?g|gif|webp)$/i.test(real)) continue
        const bytes = await fs.readFile(real)
        map.set(ref, `data:${mimeOf(real)};base64,${bytes.toString('base64')}`)
      } catch {}
    }
    return map
  },

  async readingDownloadExport(id, { kind = 'translation', format = 'md', typography = {} } = {}) {
    const safeKind = ['translation', 'original', 'bilingual'].includes(kind) ? kind : 'translation'
    const safeFormat = format === 'pdf' ? 'pdf' : 'md'
    const t = await this.get(id)
    const docTitle = t.documentTitle ?? t.name ?? 'document'
    const suffix = safeKind === 'bilingual' ? '双语对照' : safeKind === 'original' ? '原文' : '译文'
    const filename = sanitizeExportFilename(docTitle, suffix, safeFormat)

    if (safeFormat === 'md') {
      const text = safeKind === 'bilingual'
        ? buildBilingualMarkdown(await this.reading(id))
        : await this.readingDownload(id, safeKind)
      return {
        bytes: Buffer.from(text, 'utf8'),
        mimeType: 'text/markdown; charset=utf-8',
        filename,
        disposition: contentDispositionFor(filename),
      }
    }

    const reading = await this.reading(id)
    if (safeKind === 'translation' && !reading.comparisonAvailable && reading.standaloneView !== 'translation' && !reading.blocks?.some(b => b.translation)) {
      const ctx = await this.correctionContext(t)
      if (!ctx.texts.translation && !ctx.texts.source) throw new Error('尚无对应文本')
    }
    if (safeKind === 'bilingual' && !reading.comparisonAvailable) {
      throw new Error('本文档暂无原文与译文双语对照内容')
    }
    const assetDataUris = await this._collectExportAssetDataUris(t, reading)
    const pdfBytes = await renderPdfFromReading(reading, { mode: safeKind, assetDataUris, typography })
    return {
      bytes: pdfBytes,
      mimeType: 'application/pdf',
      filename,
      disposition: contentDispositionFor(filename),
    }
  },

  async bookmark(id, args) {
    return this.locked(id, async () => {
      if (this.active.has(id)) throw new Error('正在保存处理状态，阶段结束后可添加书签')
      const t = await this.get(id)
      const doc = await this.reading(id)
      if (args.remove) {
        t.bookmarks = t.bookmarks.filter(b => b.id !== args.remove)
      } else {
        const block = doc.blocks.find(b => b.id === args.blockId)
        if (!block) throw new Error('书签段落已变化')
        const mark = t.bookmarks.find(b => b.blockId === block.id) ?? { id: randomUUID(), blockId: block.id }
        Object.assign(mark, {
          note: String(args.note ?? '').slice(0, 4000),
          excerpt: block.text.slice(0, 140),
          fingerprint: doc.fingerprint,
        })
        if (!t.bookmarks.includes(mark)) t.bookmarks.push(mark)
      }
      return this.save(t)
    })
  },

  async publishPreview(t) {
    await (this.requireGlossaryForPublish ? this.requireGlossaryForPublish(t) : this.requireGlossary(t))
    return buildPublication(this, t)
  },

  async publicationPreview(id) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.publication?.published) return t
      if (this.active.has(id)) throw new Error('运行中不能生成发布清单')
      assertPhaseApproved(t, 'review')
      await this.requireDone(t, 'translationCheck', 'review')
      t.publication = await this.publishPreview(t)
      return this.save(t)
    })
  },

  async publish(id, accepted) {
    return this.locked(id, async () => {
      const t = await this.get(id)
      if (t.legacy) throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务')
      if (this.active.has(id)) throw new Error('运行中不能发布')
      if (accepted !== true) throw new Error('请核对发布清单并明确确认发布')
      await this.confirmed(t)
      await this.requireDone(t, 'translationCheck', 'review')
      await (this.requireGlossaryForPublish ? this.requireGlossaryForPublish(t) : this.requireGlossary(t))
      assertPhaseApproved(t, 'review')
      t.publication = await commitPublication(this, t, true)
      t.stages.publish = { state: 'done', at: new Date().toISOString() }
      t.message = '已发布，文献已可阅读'
      const saved = await this.save(t)
      await pruneTaskCaches(this, saved, { mode: 'safe' }).catch(() => {})
      this.scheduleBackgroundSync?.(3000, 'publish')
      return saved
    })
  },

  async getReadingProgress(documentId) {
    if (documentId) return { entry: await this.progressStore.get(documentId) }
    return { items: await this.progressStore.list() }
  },

  async saveReadingProgress(args) {
    if (Array.isArray(args?.items)) {
      const res = await this.progressStore.merge(args.items)
      if (res?.merged > 0) this.scheduleBackgroundSync?.(3000, 'progress')
      return res
    }
    const res = await this.progressStore.put(args ?? {}, { force: args?.force === true })
    if (res?.saved) this.scheduleBackgroundSync?.(3000, 'progress')
    return res
  },

  _bgSyncState() {
    if (!this._bgSync) {
      this._bgSync = {
        running: false,
        queued: false,
        queuedArgs: null,
        startedAt: null,
        finishedAt: null,
        phase: '',
        currentBook: '',
        completedBooks: 0,
        totalBooks: 0,
        detail: '',
        initialTimer: null,
        timer: null,
        debounceTimer: null,
        stopped: false,
      }
    }
    return this._bgSync
  },

  backgroundSyncSnapshot() {
    const s = this._bgSyncState()
    return {
      running: s.running,
      queued: s.queued,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      phase: s.phase,
      currentBook: s.currentBook,
      completedBooks: s.completedBooks,
      totalBooks: s.totalBooks,
      detail: s.detail,
    }
  },

  async cloudSyncStatus() {
    const config = await readCloudSyncConfig(this.root, this.index)
    return {
      ...publicSyncStatus(config),
      background: this.backgroundSyncSnapshot(),
    }
  },

  async saveCloudSync(args) {
    const saved = await saveCloudSyncConfig(this.root, args ?? {}, this.index)
    if (saved.configured && saved.autoSync && args?.startBackground !== false) {
      await this.triggerBackgroundSync({ reason: 'config' })
    }
    return {
      ...saved,
      background: this.backgroundSyncSnapshot(),
    }
  },

  async syncCloud(args = {}) {
    const state = this._bgSyncState()
    return this.locked('cloud-sync', async () => {
      const wasRunning = state.running
      if (!wasRunning) {
        state.running = true
        state.startedAt = new Date().toISOString()
        state.phase = 'pull'
        state.detail = '准备同步...'
      }
      try {
        return await syncWithCloud(this, {
          ...args,
          onProgress: patch => {
            Object.assign(state, patch)
            args.onProgress?.(patch)
          },
        })
      } finally {
        if (!wasRunning) {
          state.running = false
          state.finishedAt = new Date().toISOString()
          state.phase = ''
          state.currentBook = ''
          state.detail = ''
        }
      }
    })
  },

  async triggerBackgroundSync(args = {}) {
    const config = await readCloudSyncConfig(this.root, this.index)
    if (!config.cloudUrl || !config.token) {
      throw new Error('请先配置轻量云服务器地址与同步密钥 (Token)')
    }
    const state = this._bgSyncState()
    state.stopped = false
    if (state.running) {
      state.queued = true
      state.queuedArgs = { ...(state.queuedArgs ?? {}), ...args }
      return {
        ok: true,
        accepted: true,
        alreadyRunning: true,
        ...(await this.cloudSyncStatus()),
      }
    }

    state.running = true
    state.queued = false
    state.startedAt = new Date().toISOString()
    state.phase = 'pull'
    state.currentBook = ''
    state.completedBooks = 0
    state.totalBooks = 0
    state.detail = '后台同步已启动...'

    const runLoop = async initialArgs => {
      let nextArgs = initialArgs
      try {
        while (nextArgs && !state.stopped) {
          const currentArgs = nextArgs
          nextArgs = null
          await this.syncCloud({
            ...currentArgs,
            onProgress: patch => Object.assign(state, patch),
          }).catch(() => {})
          if (state.queued && !state.stopped) {
            state.queued = false
            nextArgs = state.queuedArgs ?? {}
            state.queuedArgs = null
          }
        }
      } finally {
        state.running = false
        state.queued = false
        state.queuedArgs = null
        state.finishedAt = new Date().toISOString()
        state.phase = ''
        state.currentBook = ''
        state.detail = ''
      }
    }

    void runLoop(args)
    return {
      ok: true,
      accepted: true,
      ...(await this.cloudSyncStatus()),
    }
  },

  scheduleBackgroundSync(delayMs = 4000, reason = 'mutation') {
    const state = this._bgSyncState()
    if (state.stopped) return
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(async () => {
      state.debounceTimer = null
      if (state.stopped) return
      try {
        const cfg = await readCloudSyncConfig(this.root, this.index)
        if (cfg.cloudUrl && cfg.token && cfg.autoSync) {
          await this.triggerBackgroundSync({ reason })
        }
      } catch {}
    }, delayMs)
    state.debounceTimer.unref?.()
  },

  startBackgroundSync({ initialDelayMs = 3000, intervalMs = 3 * 60 * 1000 } = {}) {
    this.stopBackgroundSync()
    const state = this._bgSyncState()
    state.stopped = false
    const tick = async reason => {
      if (state.stopped || state.running) return
      try {
        const cfg = await readCloudSyncConfig(this.root, this.index)
        if (cfg.cloudUrl && cfg.token && cfg.autoSync) {
          await this.triggerBackgroundSync({ reason })
        }
      } catch {}
    }
    state.initialTimer = setTimeout(() => {
      state.initialTimer = null
      void tick('startup')
    }, initialDelayMs)
    state.initialTimer.unref?.()
    state.timer = setInterval(() => {
      void tick('interval')
    }, intervalMs)
    state.timer.unref?.()
  },

  stopBackgroundSync() {
    const state = this._bgSyncState()
    state.stopped = true
    state.queued = false
    state.queuedArgs = null
    if (state.initialTimer) {
      clearTimeout(state.initialTimer)
      state.initialTimer = null
    }
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer)
      state.debounceTimer = null
    }
  },

  async searchLibrary({
    q = '',
    taskId = '',
    view = 'all',
    includeHidden = false,
    limitBooks = 30,
    maxMatchesPerBook = 6,
  } = {}) {
    if (!this._librarySearcher) {
      this._librarySearcher = createLibrarySearcher()
    }
    const docs = await this.library()
    const itemMeta = await this.itemMeta()
    const rows = await this.index.library()
    const stampById = new Map(rows.map(r => [
      r.task?.id,
      `${r.task?.updatedAt ?? ''}:${r.proof?.readingStamp ?? r.proof?.sourceStamp ?? ''}:${r.proof?.targetStamp ?? ''}`,
    ]))
    const visibleDocs = docs
      .filter(d => Boolean(taskId) || includeHidden || !itemMeta?.[d.id]?.hidden)
      .map(d => ({ ...d, stamp: stampById.get(d.id) ?? '' }))
    return this._librarySearcher({
      documents: visibleDocs,
      query: q,
      taskId,
      view,
      limitBooks,
      maxMatchesPerBook,
      loadDoc: async meta => ({
        reading: await this.reading(meta.id),
        stamp: meta.stamp,
      }),
    })
  },
}
