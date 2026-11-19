import {
  buildFootnoteIndex,
  computeViewportLayout,
  escapeHtml,
  footnoteDisplayNumbers,
  renderBlockBodyHtml,
  resolveFontStack,
  resolveFootnote,
  resolveSwipeDecision,
  resolveTapZoneAction,
} from './reading-core.js'
import { readerApi } from './api.js'
import { offlineDb } from './offline-db.js'
import { nativeBridge } from './native-bridge.js'
import { renderReaderChrome, renderSelectionCapsule } from './reader-menus.js'
import { renderReaderSheet } from './reader-sheets.js'

function nowClock() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export class ReaderController {
  constructor({ root, taskId, reading, settings, initialBlockId, initialView, initialSearchQuery = '', onExit, onToast, onSettingsChange }) {
    this.root = root
    this.taskId = taskId
    this.reading = reading
    this.settings = settings
    this.onExit = onExit
    this.onToast = onToast
    this.onSettingsChange = onSettingsChange
    this.searchQuery = initialSearchQuery || ''

    const hasTrans = Boolean(
      reading.comparisonAvailable || reading.blocks?.some(b => b.translation) || reading.standaloneView === 'translation'
    )
    if (initialView && ['original', 'translation', 'bilingual'].includes(initialView)) {
      this.viewMode = initialView === 'original' || hasTrans ? initialView : 'original'
    } else {
      this.viewMode = hasTrans ? 'translation' : 'original'
    }

    this.hasTranslation = hasTrans
    this.marks = []
    this.barsVisible = false
    this.activeBottomPanel = 'progress' // 'progress' | 'theme' | 'typography'
    this.tocSubTab = 'outline' // 'outline' | 'marks'
    this.activeSheet = null // 'toc' | 'drawer' | 'footnote' | 'noteEditor' | 'correction' | 'pdf'
    this.sheetData = null
    this.selectionInfo = null
    this.currentPage = 0
    this.totalPages = 1
    this.pendingBlockId = initialBlockId || ''
    this.syncBanner = null
    this.pdfState = { page: 1, zoom: 100, loading: false, error: '', imgUrl: '', fallbackPdfUrl: '' }
    this.layoutInfo = null
    this.tocPage = 0
    this.tocTotalPages = 1

    this.viewportEl = null
    this.trackEl = null
    this.columnsEl = null
    this.saveTimer = null
    this.selectionTimer = null
    this.clockTimer = null
    this.resizeTimer = null
    this.destroyed = false
    this.touchStart = null
    this.lastSwipeAt = 0
    this.lastSelectionDismissAt = 0
    this.lastChapterJump = null
  }

  async mount() {
    await nativeBridge.setImmersive(true)
    await nativeBridge.setSelectionMenuDisabled(true)
    await nativeBridge.configureKeys({
      enabled: true,
      prevKeys: this.settings.prevKeys,
      nextKeys: this.settings.nextKeys,
    })

    this.marks = await offlineDb.getMarks(this.taskId).catch(() => [])
    this.render()
    this.bindGlobalEvents()
    void this.refreshRemoteInBackground()
  }

  async refreshRemoteInBackground() {
    void this.checkRemoteProgress()
    try {
      const remoteMarks = await readerApi.loadMarks(this.settings, this.taskId)
      if (this.destroyed || !Array.isArray(remoteMarks)) return
      if (JSON.stringify(remoteMarks) !== JSON.stringify(this.marks)) {
        this.marks = remoteMarks
        this.renderBlocks()
      }
    } catch {}
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.saveTimer)
    clearTimeout(this.selectionTimer)
    clearTimeout(this.resizeTimer)
    clearInterval(this.clockTimer)
    this.saveProgressNow(true)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('reader:physical-key', this.onPhysicalKey)
    document.removeEventListener('selectionchange', this.onSelectionChange)
    nativeBridge.setImmersive(false)
    nativeBridge.setSelectionMenuDisabled(false)
    nativeBridge.configureKeys({ enabled: false, prevKeys: [], nextKeys: [] })
  }

  async checkRemoteProgress() {
    if (!this.reading?.documentId) return
    const allLocal = await offlineDb.getAllProgress()
    const local = allLocal[this.reading.documentId]
    if (!this.pendingBlockId && local?.blockId) {
      this.pendingBlockId = local.blockId
      if (local.view && ['original', 'translation', 'bilingual'].includes(local.view)) {
        this.viewMode = local.view
      }
      this.renderBlocks()
    }
    const remote = await readerApi.fetchServerProgress(this.settings, this.reading.documentId)
    if (this.destroyed || !remote?.blockId) return
    if (!local || (remote.updatedAt > (local.updatedAt || 0) && remote.blockId !== local.blockId)) {
      if (!local) {
        this.pendingBlockId = remote.blockId
        if (remote.view && ['original', 'translation', 'bilingual'].includes(remote.view)) {
          this.viewMode = remote.view
        }
        this.renderBlocks()
      } else {
        this.syncBanner = remote
        this.renderChrome()
      }
    }
  }

  activeBlocks() {
    if (this.viewMode === 'original' && this.reading.standaloneView === 'translation' && this.reading.originalBlocks) {
      return this.reading.originalBlocks
    }
    return this.reading.blocks ?? []
  }

  hiddenSet() {
    const list =
      this.viewMode === 'original'
        ? (this.reading.originalOutline?.hiddenBlocks ?? [])
        : (this.reading.hiddenBlocks ?? [])
    return new Set(list)
  }

  visibleBlocks() {
    const hidden = this.hiddenSet()
    return this.activeBlocks().filter(b => !hidden.has(b.id))
  }

  outlineItems() {
    if (this.viewMode === 'original') {
      return this.reading.originalOutline?.outline ?? this.reading.outline ?? []
    }
    return this.reading.outline ?? []
  }

  bindGlobalEvents() {
    this.onResize = () => {
      if (this.activeSheet === 'noteEditor' || this.activeSheet === 'correction') return
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => { if (!this.destroyed) this.recomputeLayout(true) }, 90)
    }
    this.onKeyDown = e => {
      const isPrev = this.settings.prevKeys.includes(e.key) || this.settings.prevKeys.includes(e.keyCode)
      const isNext = this.settings.nextKeys.includes(e.key) || this.settings.nextKeys.includes(e.keyCode) || e.key === ' '
      if (this.activeSheet) {
        if (e.key === 'Escape') {
          this.closeSheet()
        } else if (this.activeSheet === 'toc' && (isPrev || isNext)) {
          e.preventDefault()
          this.turnTocPage(isPrev ? -1 : 1)
        } else if (this.activeSheet === 'pdf' && (isPrev || isNext)) {
          e.preventDefault()
          const nextP = this.pdfState.page + (isPrev ? -1 : 1)
          if (nextP >= 1) void this.loadPdfPage(nextP)
        }
        return
      }
      if (isPrev) {
        e.preventDefault()
        this.prevPage()
      } else if (isNext) {
        e.preventDefault()
        this.nextPage()
      }
    }
    this.onPhysicalKey = e => {
      const dir = e.detail?.direction
      if (this.activeSheet) {
        if (this.activeSheet === 'toc') this.turnTocPage(dir === 'prev' ? -1 : 1)
        else if (this.activeSheet === 'pdf') {
          const nextP = this.pdfState.page + (dir === 'prev' ? -1 : 1)
          if (nextP >= 1) void this.loadPdfPage(nextP)
        }
        return
      }
      if (dir === 'prev') this.prevPage()
      else if (dir === 'next') this.nextPage()
    }
    this.onSelectionChange = () => {
      clearTimeout(this.selectionTimer)
      this.selectionTimer = setTimeout(() => this.inspectSelection(), 200)
    }
    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('reader:physical-key', this.onPhysicalKey)
    document.addEventListener('selectionchange', this.onSelectionChange)
    this.clockTimer = setInterval(() => {
      const el = this.root.querySelector('[data-role="clock"]')
      if (el) el.textContent = nowClock()
    }, 30000)
  }

  applyTypographyVars() {
    const s = this.settings
    const r = document.documentElement.style
    r.setProperty('--reader-size', `${s.fontSize || 18}px`)
    r.setProperty('--reader-weight', String(s.fontWeight || 400))
    r.setProperty('--reader-lh', String(s.lineHeight || 1.78))
    r.setProperty('--reader-para-gap', `${s.paraSpacing ?? 0.85}em`)
    r.setProperty('--reader-indent', s.textIndent ? '2em' : '0em')
    r.setProperty('--reader-align', s.textAlign || 'justify')
    r.setProperty('--reader-pad-x', `${this.layoutInfo?.horizontalPadding ?? s.marginX}px`)
    r.setProperty('--reader-font', resolveFontStack(s.fontFamily))
    const dim = Math.max(0, Math.min(0.65, (100 - Number(s.brightness ?? 100)) / 100))
    r.setProperty('--reader-dimmer', dim.toFixed(2))
    if (this.trackEl) {
      this.trackEl.classList.toggle('no-anim', s.pageTransition === 'none' || s.theme === 'eink' || s.deviceMode === 'eink')
    }
  }

  render() {
    this.applyTypographyVars()
    this.root.innerHTML = `
      <div class="wr-reader" data-role="reader">
        <div class="wr-brightnessDimmer"></div>
        <div class="wr-readerMiniTop">
          <span data-role="chapter-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:75%">${escapeHtml(this.reading.title || '')}</span>
          <span data-role="view-badge">${this.viewMode === 'bilingual' ? '双语' : this.viewMode === 'original' ? '原文' : '译文'}</span>
        </div>
        <div class="wr-readerViewport ${this.settings.pageMode === 'scroll' ? 'scroll-mode' : ''}" data-role="viewport">
          <div class="wr-pagesTrack ${this.settings.pageTransition === 'none' ? 'no-anim' : ''}" data-role="track">
            <div class="${this.settings.pageMode === 'scroll' ? 'wr-scrollFlow' : 'wr-columns'}" data-role="columns"></div>
          </div>
        </div>
        <div data-role="page-turn-bar"></div>
        <div class="wr-readerMiniBottom">
          <span data-role="page-indicator">1 / 1</span>
          <span data-role="clock">${nowClock()}</span>
        </div>
        <div data-role="chrome"></div>
        <div data-role="capsule"></div>
        <div data-role="sheet"></div>
      </div>
    `

    this.viewportEl = this.root.querySelector('[data-role="viewport"]')
    this.trackEl = this.root.querySelector('[data-role="track"]')
    this.columnsEl = this.root.querySelector('[data-role="columns"]')

    this.bindReaderInteractions()
    this.renderPageTurnBar()
    this.renderBlocks()
    this.renderChrome()
  }

  renderPageTurnBar() {
    const host = this.root.querySelector('[data-role="page-turn-bar"]')
    if (!host) return
    const show = Boolean(this.settings.showPageTurnBar || this.settings.tapZoneMode === 'keysOnly')
    if (!show) {
      host.innerHTML = ''
      return
    }
    host.innerHTML = `
      <div class="wr-pageTurnBar">
        <button type="button" class="wr-pageTurnBtn" data-pt="prev">‹ 上一页</button>
        <button type="button" class="wr-pageTurnBtn" data-pt="toc">目录</button>
        <button type="button" class="wr-pageTurnBtn" data-pt="drawer">本段对照</button>
        <button type="button" class="wr-pageTurnBtn" data-pt="menu">菜单设置</button>
        <button type="button" class="wr-pageTurnBtn" data-pt="next">下一页 ›</button>
      </div>
    `
    host.querySelector('[data-pt="prev"]').onclick = () => this.prevPage()
    host.querySelector('[data-pt="next"]').onclick = () => this.nextPage()
    host.querySelector('[data-pt="toc"]').onclick = () => {
      this.barsVisible = false
      this.activeSheet = 'toc'
      this.renderChrome()
      this.renderSheet()
    }
    host.querySelector('[data-pt="drawer"]').onclick = () => {
      const id = this.currentTopBlockId() || this.visibleBlocks()[0]?.id
      if (id) this.openBilingualDrawer(id)
    }
    host.querySelector('[data-pt="menu"]').onclick = () => {
      this.barsVisible = !this.barsVisible
      this.renderChrome()
    }
  }

  computeCurrentLayout() {
    const W = Math.max(240, this.viewportEl?.clientWidth || window.innerWidth || 390)
    const H = Math.max(240, this.viewportEl?.clientHeight || window.innerHeight || 844)
    return computeViewportLayout({
      width: W,
      height: H,
      columnLayout: this.settings.columnLayout || 'auto',
      bilingualLayout: this.settings.bilingualLayout || 'auto',
      viewMode: this.viewMode,
      marginX: this.settings.marginX,
    })
  }

  renderBlocks() {
    if (!this.columnsEl) return
    this.layoutInfo = this.computeCurrentLayout()
    this.applyTypographyVars()

    const blocks = this.visibleBlocks()
    const isTrans = this.viewMode !== 'original'
    const outline = this.outlineItems()
    const noteNumbers = footnoteDisplayNumbers(
      this.activeBlocks(),
      this.reading.kind === 'paper' ? [] : outline,
      isTrans && !this.reading.standaloneView
    )
    const origNoteNumbers =
      this.viewMode === 'bilingual'
        ? footnoteDisplayNumbers(
            this.reading.originalBlocks ?? this.reading.blocks ?? [],
            this.reading.kind === 'paper' ? [] : (this.reading.originalOutline?.outline ?? []),
            false
          )
        : noteNumbers

    const marksByBlock = new Map()
    const activeViewKey = this.viewMode === 'original' ? 'original' : 'translation'
    for (const m of this.marks) {
      if (m.view !== activeViewKey && !(this.viewMode === 'bilingual' && m.view === 'original')) continue
      if (!marksByBlock.has(m.blockId)) marksByBlock.set(m.blockId, [])
      marksByBlock.get(m.blockId).push(m)
    }

    const useParallelBilingual = this.viewMode === 'bilingual' && this.layoutInfo.effectiveBilingual === 'parallel'

    const html = blocks
      .map(b => {
        const mainText =
          this.viewMode === 'original'
            ? (b.sourceText ?? b.text)
            : this.reading.standaloneView === 'translation'
            ? b.text
            : (b.translation ?? b.text)
        const blockMarks = (marksByBlock.get(b.id) ?? []).filter(
          m => m.view === (this.viewMode === 'original' ? 'original' : 'translation')
        )
        const showTrigger = this.viewMode === 'translation' && Boolean(b.sourceText || b.pdfPage)
        const body = renderBlockBodyHtml(mainText, b, {
          view: this.viewMode === 'original' ? 'original' : 'translation',
          marks: blockMarks,
          noteNumbers,
          showDrawerTrigger: showTrigger,
          searchQuery: this.searchQuery,
        })

        if (this.viewMode === 'bilingual' && b.sourceText && b.sourceText !== mainText) {
          const srcMarks = (marksByBlock.get(b.id) ?? []).filter(m => m.view === 'original')
          const srcHtml = renderBlockBodyHtml(b.sourceText, b, {
            view: 'original',
            marks: srcMarks,
            noteNumbers: origNoteNumbers,
            showDrawerTrigger: Boolean(b.pdfPage),
            searchQuery: this.searchQuery,
          })
          if (useParallelBilingual) {
            return `<div class="wr-block bilingual-parallel" data-block-id="${escapeHtml(b.id)}"><div class="wr-bilingualPrimary" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="translation">${body}</div><div class="wr-bilingualSource" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="original">${srcHtml}</div></div>`
          }
          const bilingualExtra = `<div class="wr-bilingualSource" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="original">${srcHtml}</div>`
          return `<div class="wr-block" data-block-id="${escapeHtml(b.id)}" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="translation">${body}${bilingualExtra}</div>`
        }

        return `<div class="wr-block" data-block-id="${escapeHtml(b.id)}" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="${this.viewMode === 'original' ? 'original' : 'translation'}">${body}</div>`
      })
      .join('')

    this.columnsEl.innerHTML = html
    this.hydrateImages()
    requestAnimationFrame(() => this.recomputeLayout(false))
  }

  hydrateImages() {
    const imgs = this.columnsEl?.querySelectorAll('img[data-asset-ref]') ?? []
    for (const img of imgs) {
      const ref = img.getAttribute('data-asset-ref')
      readerApi
        .loadAssetUrl(this.settings, this.taskId, ref)
        .then(url => {
          if (this.destroyed) return
          img.src = url
          img.onload = () => this.recomputeLayout(true)
        })
        .catch(() => {
          img.alt = `[图片暂不可用: ${ref}]`
        })
    }
  }

  recomputeLayout(preserveCurrent = true) {
    if (!this.viewportEl || !this.columnsEl || !this.trackEl) return

    const prevBilingual = this.layoutInfo?.effectiveBilingual
    const layout = this.computeCurrentLayout()
    this.layoutInfo = layout
    this.applyTypographyVars()

    if (this.viewMode === 'bilingual' && prevBilingual && prevBilingual !== layout.effectiveBilingual) {
      this.pendingBlockId = this.currentTopBlockId()
      this.renderBlocks()
      return
    }

    if (this.settings.pageMode === 'scroll') {
      this.viewportEl.classList.remove('two-col-spread')
      this.trackEl.style.width = ''
      this.columnsEl.style.width = ''
      this.columnsEl.style.height = ''
      this.columnsEl.style.columnWidth = ''
      this.trackEl.style.transform = ''
      if (this.pendingBlockId) {
        const target = this.columnsEl.querySelector(`[data-block-id="${CSS.escape(this.pendingBlockId)}"]`)
        if (target) target.scrollIntoView({ block: 'start' })
        this.pendingBlockId = ''
      }
      this.updatePageIndicator()
      return
    }

    const anchorBlock = preserveCurrent && !this.pendingBlockId ? this.currentTopBlockId() : this.pendingBlockId
    const spreadW = layout.spreadWidth
    const H = layout.height

    this.viewportEl.scrollLeft = 0
    this.viewportEl.scrollTop = 0
    this.viewportEl.classList.toggle('two-col-spread', layout.colsPerSpread === 2)
    this.trackEl.style.width = `${spreadW}px`
    this.columnsEl.style.width = `${spreadW}px`
    this.columnsEl.style.height = `${H}px`
    this.columnsEl.style.columnWidth = `${layout.colWidth}px`

    const totalWidth = this.columnsEl.scrollWidth
    this.totalPages = Math.max(1, Math.ceil((totalWidth - 4) / spreadW))

    if (anchorBlock) {
      const el = this.columnsEl.querySelector(`[data-block-id="${CSS.escape(anchorBlock)}"]`)
      if (el) {
        const colIdx = Math.max(0, Math.min(this.totalPages - 1, Math.floor((el.offsetLeft + 4) / spreadW)))
        this.currentPage = colIdx
      }
      this.pendingBlockId = ''
    } else {
      this.currentPage = Math.max(0, Math.min(this.totalPages - 1, this.currentPage))
    }

    this.applyPageTransform(spreadW)
  }

  applyPageTransform(spreadW = this.layoutInfo?.spreadWidth || this.viewportEl?.clientWidth || 360) {
    if (!this.trackEl) return
    if (this.viewportEl && this.settings.pageMode !== 'scroll') {
      this.viewportEl.scrollLeft = 0
      this.viewportEl.scrollTop = 0
    }
    this.trackEl.style.transform = `translate3d(${-this.currentPage * spreadW}px, 0, 0)`
    this.updatePageIndicator()
  }

  currentTopBlockId() {
    if (!this.columnsEl || !this.viewportEl) return ''
    if (this.settings.pageMode === 'scroll') {
      const top = this.viewportEl.getBoundingClientRect().top + 24
      for (const el of this.columnsEl.querySelectorAll('.wr-block[data-block-id]')) {
        if (el.getBoundingClientRect().bottom > top) return el.getAttribute('data-block-id') || ''
      }
      return ''
    }
    const spreadW = this.layoutInfo?.spreadWidth || Math.max(240, this.viewportEl.clientWidth)
    const minLeft = this.currentPage * spreadW
    const maxLeft = (this.currentPage + 1) * spreadW
    let fallback = ''
    for (const el of this.columnsEl.querySelectorAll('.wr-block[data-block-id]')) {
      const id = el.getAttribute('data-block-id') || ''
      if (el.offsetLeft >= minLeft - 4 && el.offsetLeft < maxLeft) return id
      if (el.offsetLeft < minLeft) fallback = id
    }
    return fallback
  }

  currentChapterLabel() {
    const blockId = this.currentTopBlockId()
    const blocks = this.visibleBlocks()
    const idx = blocks.findIndex(b => b.id === blockId)
    const outline = this.outlineItems()
    if (!outline.length) return this.reading.title || ''
    if (idx < 0) return outline[0].label
    const order = new Map(blocks.map((b, i) => [b.id, i]))
    let active = outline[0].label
    for (const item of outline) {
      const oIdx = order.get(item.id)
      if (oIdx !== undefined && oIdx <= idx) active = item.label
    }
    return active
  }

  updatePageIndicator() {
    const ind = this.root.querySelector('[data-role="page-indicator"]')
    const chEl = this.root.querySelector('[data-role="chapter-title"]')
    const badgeEl = this.root.querySelector('[data-role="view-badge"]')
    if (chEl) chEl.textContent = this.currentChapterLabel()
    if (badgeEl) {
      const viewName = this.viewMode === 'bilingual' ? '双语' : this.viewMode === 'original' ? '原文' : '译文'
      const spreadSuffix = this.settings.pageMode === 'paginated' && this.layoutInfo?.colsPerSpread === 2 ? ' · 双栏' : ''
      badgeEl.textContent = `${viewName}${spreadSuffix}`
    }
    if (!ind) return
    if (this.settings.pageMode === 'scroll') {
      const maxScroll = Math.max(1, (this.viewportEl?.scrollHeight ?? 1) - (this.viewportEl?.clientHeight ?? 0))
      const pct = Math.min(100, Math.max(1, Math.round(((this.viewportEl?.scrollTop ?? 0) / maxScroll) * 100)))
      ind.textContent = `滚动 · ${pct}%`
    } else {
      const pct = Math.min(100, Math.max(1, Math.round(((this.currentPage + 1) / this.totalPages) * 100)))
      ind.textContent = `第 ${this.currentPage + 1} / ${this.totalPages} 页 · ${pct}%`
    }
  }

  prevPage() {
    this.lastChapterJump = null
    if (this.settings.pageMode === 'scroll') {
      const behavior = this.settings.theme === 'eink' || this.settings.deviceMode === 'eink' ? 'instant' : 'smooth'
      this.viewportEl?.scrollBy({ top: -Math.round((this.viewportEl?.clientHeight || 500) * 0.85), behavior })
      return
    }
    if (this.currentPage > 0) {
      this.currentPage--
      this.applyPageTransform()
      this.scheduleSaveProgress()
    } else {
      this.onToast('已是第一页')
    }
  }

  nextPage() {
    this.lastChapterJump = null
    if (this.settings.pageMode === 'scroll') {
      const behavior = this.settings.theme === 'eink' || this.settings.deviceMode === 'eink' ? 'instant' : 'smooth'
      this.viewportEl?.scrollBy({ top: Math.round((this.viewportEl?.clientHeight || 500) * 0.85), behavior })
      return
    }
    if (this.currentPage < this.totalPages - 1) {
      this.currentPage++
      this.applyPageTransform()
      this.scheduleSaveProgress()
    } else {
      this.onToast('已是最后一页')
    }
  }

  jumpToBlock(blockId, viewMode, opts = {}) {
    if (!opts.fromChapter) this.lastChapterJump = null
    if (viewMode && viewMode !== this.viewMode && (viewMode === 'original' || this.hasTranslation)) {
      this.viewMode = viewMode
      this.pendingBlockId = blockId
      this.render()
      return
    }
    this.pendingBlockId = blockId
    this.recomputeLayout(false)
    this.scheduleSaveProgress()
  }

  stepChapter(delta) {
    const items = this.outlineItems()
    if (!items.length) return this.onToast('本文档无章节目录')
    const blocks = this.visibleBlocks()
    const order = new Map(blocks.map((b, i) => [b.id, i]))
    const top = items.filter(it => (it.level || 1) <= 1 && order.has(it.id))
    const targets = top.length > 1 ? top : items.filter(it => order.has(it.id))
    if (!targets.length) return this.onToast('本文档无有效章节节点')

    let pos = -1
    if (this.lastChapterJump?.viewMode === this.viewMode) {
      pos = targets.findIndex(it => it.id === this.lastChapterJump.id)
    }
    if (pos < 0) {
      const curIdx = order.get(this.currentTopBlockId()) ?? 0
      for (let i = 0; i < targets.length; i++) {
        if ((order.get(targets[i].id) ?? 0) <= curIdx) pos = i
      }
    }
    const nextPos = delta < 0 ? pos - 1 : pos + 1
    if (nextPos < 0) return this.onToast('已在第一章')
    if (nextPos >= targets.length) return this.onToast('已是最后一章')
    const target = targets[nextPos]
    this.lastChapterJump = { id: target.id, viewMode: this.viewMode }
    this.jumpToBlock(target.id, undefined, { fromChapter: true })
    this.onToast(`已跳转：${target.label}`)
  }

  prevChapter() {
    this.stepChapter(-1)
  }

  nextChapter() {
    this.stepChapter(1)
  }

  scheduleSaveProgress() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveProgressNow(false), 900)
  }

  saveProgressNow(immediate = false) {
    if (!this.reading?.documentId) return
    const blockId = this.currentTopBlockId()
    if (!blockId) return
    let percent = 1
    let page = this.currentPage + 1
    let totalPages = this.totalPages
    if (this.settings.pageMode === 'scroll' && this.viewportEl) {
      const maxScroll = Math.max(1, this.viewportEl.scrollHeight - this.viewportEl.clientHeight)
      percent = Math.min(100, Math.max(1, Math.round((this.viewportEl.scrollTop / maxScroll) * 100)))
      page = 1
      totalPages = 1
    } else {
      percent = Math.min(100, Math.max(1, Math.round(((this.currentPage + 1) / Math.max(1, this.totalPages)) * 100)))
    }
    const entry = {
      documentId: this.reading.documentId,
      taskId: this.taskId,
      blockId,
      view: this.viewMode,
      version: this.reading.version,
      page,
      totalPages,
      percent,
      title: this.reading.title,
      deviceId: this.settings.deviceId,
      deviceName: this.settings.deviceName,
      updatedAt: Date.now(),
    }
    void readerApi.saveProgress(this.settings, entry)
  }

  bindReaderInteractions() {
    const vp = this.viewportEl
    if (!vp) return

    vp.addEventListener(
      'scroll',
      () => {
        if (this.settings.pageMode === 'scroll') {
          this.updatePageIndicator()
          this.scheduleSaveProgress()
        }
      },
      { passive: true }
    )

    let gesture = null
    const isInteractive = t => Boolean(t?.closest?.('[data-fn-id],[data-drawer-block],button,a,input,textarea,select'))
    const resetDrag = () => {
      if (this.trackEl) {
        this.trackEl.classList.remove('dragging')
        if (this.settings.pageMode === 'paginated') this.applyPageTransform()
      }
    }
    const startGesture = (x, y, isTouch, pointerType, target) => {
      if (this.activeSheet || this.selectionInfo || isInteractive(target)) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return
      if (this.settings.tapZoneMode === 'keysOnly' && pointerType === 'pen') return
      const spreadW = this.layoutInfo?.spreadWidth || Math.max(240, vp.clientWidth)
      const noAnim = this.settings.pageTransition === 'none' || this.settings.theme === 'eink' || this.settings.deviceMode === 'eink'
      gesture = { mode: 'pending', x, y, dx: 0, dy: 0, time: Date.now(), isTouch, spreadW, noAnim }
    }
    const moveGesture = (x, y, ev) => {
      if (!gesture) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) { gesture = null; resetDrag(); return }
      const dx = x - gesture.x, dy = y - gesture.y
      gesture.dx = dx; gesture.dy = dy
      if (gesture.mode === 'pending') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        if (this.settings.pageMode === 'paginated' && this.settings.tapZoneMode !== 'keysOnly' && Math.abs(dx) > Math.abs(dy) * 1.15) {
          gesture.mode = 'swipe'
          if (this.barsVisible) { this.barsVisible = false; this.renderChrome() }
          if (!gesture.noAnim && this.trackEl) this.trackEl.classList.add('dragging')
        } else {
          gesture.mode = 'other'
          return
        }
      }
      if (gesture.mode === 'swipe') {
        if (ev?.cancelable) ev.preventDefault()
        if (!gesture.noAnim && this.trackEl) {
          const damp = (this.currentPage === 0 && dx > 0) || (this.currentPage >= this.totalPages - 1 && dx < 0) ? 0.28 : 1
          this.trackEl.style.transform = `translate3d(${-this.currentPage * gesture.spreadW + dx * damp}px, 0, 0)`
        }
      }
    }
    const endGesture = (x, y, cancelled) => {
      const g = gesture; gesture = null
      if (!g) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) { resetDrag(); setTimeout(() => this.inspectSelection(), 60); return }
      const dx = (x ?? g.x + g.dx) - g.x, dy = (y ?? g.y + g.dy) - g.y, dt = Date.now() - g.time
      if (this.trackEl) this.trackEl.classList.remove('dragging')
      if (cancelled || this.settings.pageMode !== 'paginated' || this.settings.tapZoneMode === 'keysOnly') {
        if (g.mode === 'swipe') this.applyPageTransform(g.spreadW)
        return
      }
      if (g.mode === 'swipe' || (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.2)) {
        const decision = resolveSwipeDecision({ dx, dy, dt, spreadWidth: g.spreadW })
        this.lastSwipeAt = Date.now()
        if (decision === 'next') this.nextPage()
        else if (decision === 'prev') this.prevPage()
        else this.applyPageTransform(g.spreadW)
      }
    }

    vp.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { gesture = null; resetDrag(); return }
      startGesture(e.touches[0].clientX, e.touches[0].clientY, true, 'touch', e.target)
    }, { passive: true })
    vp.addEventListener('touchmove', e => {
      if (gesture?.isTouch && e.touches.length === 1) moveGesture(e.touches[0].clientX, e.touches[0].clientY, e)
    }, { passive: false })
    vp.addEventListener('touchend', e => {
      if (gesture?.isTouch) { const t = e.changedTouches[0]; endGesture(t?.clientX, t?.clientY, false) }
    }, { passive: true })
    vp.addEventListener('touchcancel', () => {
      if (gesture?.isTouch) endGesture(null, null, true)
    }, { passive: true })

    vp.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || (e.button && e.button !== 0)) return
      startGesture(e.clientX, e.clientY, false, e.pointerType, e.target)
    }, { passive: true })
    vp.addEventListener('pointermove', e => {
      if (gesture && !gesture.isTouch && e.pointerType !== 'touch') moveGesture(e.clientX, e.clientY, e)
    })
    vp.addEventListener('pointerup', e => {
      if (gesture && !gesture.isTouch && e.pointerType !== 'touch') endGesture(e.clientX, e.clientY, false)
    }, { passive: true })
    vp.addEventListener('pointercancel', e => {
      if (gesture && !gesture.isTouch && e.pointerType !== 'touch') endGesture(null, null, true)
    }, { passive: true })

    vp.addEventListener('click', e => {
      if (Date.now() - this.lastSwipeAt < 280) return
      const fnBtn = e.target.closest?.('[data-fn-id]')
      if (fnBtn) {
        e.stopPropagation()
        this.openFootnoteSheet(fnBtn.dataset.fnId, fnBtn.dataset.fnView, fnBtn.dataset.fnBlock)
        return
      }
      const drawerBtn = e.target.closest?.('[data-drawer-block]')
      if (drawerBtn) {
        e.stopPropagation()
        this.openBilingualDrawer(drawerBtn.dataset.drawerBlock)
        return
      }
      const markEl = e.target.closest?.('mark[data-mark-ids]')
      if (markEl && (!window.getSelection() || window.getSelection().isCollapsed)) {
        e.stopPropagation()
        this.openMarkDetail(markEl.dataset.markIds)
        return
      }
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return
      if (this.selectionInfo) {
        this.clearSelection()
        return
      }
      if (Date.now() - this.lastSelectionDismissAt < 320) return
      if (this.barsVisible) {
        this.barsVisible = false
        this.renderChrome()
        return
      }
      const rect = vp.getBoundingClientRect()
      const xRatio = (e.clientX - rect.left) / Math.max(1, rect.width)
      const yRatio = (e.clientY - rect.top) / Math.max(1, rect.height)
      const action = resolveTapZoneAction({
        xRatio,
        yRatio,
        tapZoneMode: this.settings.tapZoneMode || 'ergonomic',
        isPortraitPhone: Boolean(this.layoutInfo?.isPortraitPhone),
      })
      if (action === 'prev') this.prevPage()
      else if (action === 'next') this.nextPage()
      else if (action === 'menu') {
        this.barsVisible = true
        this.renderChrome()
      }
    })
  }

  inspectSelection() {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      if (this.selectionInfo) {
        this.selectionInfo = null
        this.lastSelectionDismissAt = Date.now()
        this.renderCapsule()
      }
      return
    }
    const range = sel.getRangeAt(0)
    const elOf = n => (n.nodeType === 1 ? n : n.parentElement)
    const startEl = elOf(range.startContainer)?.closest?.('[data-bookmark-block]')
    const endEl = elOf(range.endContainer)?.closest?.('[data-bookmark-block]')
    if (!startEl || !endEl || !this.columnsEl?.contains(startEl) || !this.columnsEl?.contains(endEl)) return

    const view = startEl.dataset.bookmarkView === 'original' ? 'original' : 'translation'
    if (view !== (endEl.dataset.bookmarkView === 'original' ? 'original' : 'translation')) return

    const clean = r => {
      const box = document.createElement('div')
      box.append(r.cloneContents())
      box.querySelectorAll('.wr-blockTrigger, .wr-fnRef').forEach(n => n.remove())
      box.querySelectorAll('p,h1,h2,h3,h4,blockquote').forEach(n => n.append(document.createTextNode(' ')))
      return box.textContent.replace(/\s+/g, ' ').trim()
    }
    const exact = clean(range)
    if (!exact || exact.length > 20000) return

    const prefixRange = range.cloneRange()
    prefixRange.selectNodeContents(startEl)
    prefixRange.setEnd(range.startContainer, range.startOffset)
    const suffixRange = range.cloneRange()
    suffixRange.selectNodeContents(endEl)
    suffixRange.setStart(range.endContainer, range.endOffset)
    const rect = range.getBoundingClientRect()

    this.selectionInfo = {
      exact,
      prefix: clean(prefixRange).slice(-80),
      suffix: clean(suffixRange).slice(0, 80),
      startBlockId: startEl.dataset.bookmarkBlock,
      endBlockId: endEl.dataset.bookmarkBlock,
      view,
      left: Math.max(10, Math.min(rect.left, window.innerWidth - 290)),
      top: rect.top > 72 ? rect.top - 48 : Math.min(window.innerHeight - 60, rect.bottom + 10),
    }
    this.renderCapsule()
  }

  clearSelection() {
    this.selectionInfo = null
    this.lastSelectionDismissAt = Date.now()
    try {
      window.getSelection()?.removeAllRanges()
    } catch {}
    this.renderCapsule()
  }

  renderCapsule() {
    renderSelectionCapsule(this, this.root.querySelector('[data-role="capsule"]'))
  }

  renderChrome() {
    renderReaderChrome(this, this.root.querySelector('[data-role="chrome"]'))
  }

  turnTocPage(delta) {
    if (this.activeSheet !== 'toc') return
    const next = Math.max(0, Math.min(this.tocTotalPages - 1, this.tocPage + delta))
    if (next !== this.tocPage) {
      this.tocPage = next
      this.renderSheet()
    }
  }

  openBilingualDrawer(blockId) {
    const block = this.activeBlocks().find(b => b.id === blockId)
    if (!block) return
    this.activeSheet = 'drawer'
    this.sheetData = { block }
    this.renderSheet()
  }

  openFootnoteSheet(fnId, view, originBlockId) {
    const isTrans = view === 'translation' && !this.reading.standaloneView
    const blocks = isTrans ? this.reading.blocks : (this.reading.originalBlocks ?? this.reading.blocks)
    const idx = buildFootnoteIndex(blocks, isTrans)
    const entry = resolveFootnote(idx, fnId)

    const altBlocks = isTrans ? (this.reading.originalBlocks ?? this.reading.blocks) : this.reading.blocks
    const altIdx = buildFootnoteIndex(altBlocks, !isTrans && !this.reading.standaloneView)
    const altEntry = this.hasTranslation ? resolveFootnote(altIdx, fnId) : null

    this.activeSheet = 'footnote'
    this.sheetData = { fnId, entry, altEntry, showAlt: false, view, originBlockId }
    this.renderSheet()
  }

  openCorrectionSheet(blockId, view) {
    const block = this.activeBlocks().find(b => b.id === blockId)
    if (!block) return
    const raw =
      view === 'original'
        ? (block.sourceText ?? block.text)
        : this.reading.standaloneView === 'translation'
        ? block.text
        : (block.translation ?? block.text)
    this.activeSheet = 'correction'
    this.sheetData = { block, view, raw }
    this.renderSheet()
  }

  async openPdfViewer(page = 1) {
    this.activeSheet = 'pdf'
    this.pdfState = {
      page: Math.max(1, Number(page) || 1),
      zoom: 100,
      loading: true,
      error: '',
      imgUrl: '',
      fallbackPdfUrl: '',
    }
    this.renderSheet()
    await this.loadPdfPage(this.pdfState.page)
  }

  async loadPdfPage(page) {
    this.pdfState.page = Math.max(1, Number(page) || 1)
    this.pdfState.loading = true
    this.pdfState.error = ''
    this.renderSheet()
    try {
      const res = await readerApi.loadPdfPageImageUrl(
        this.settings,
        this.taskId,
        this.pdfState.page,
        this.settings.theme === 'eink' ? 200 : 180
      )
      if (this.destroyed || this.activeSheet !== 'pdf') return
      if (res.fallback === 'pdf') {
        const pdfUrl = await readerApi.downloadFullPdf(this.settings, this.taskId)
        this.pdfState.fallbackPdfUrl = pdfUrl
        this.pdfState.loading = false
      } else {
        this.pdfState.imgUrl = res.url
        this.pdfState.loading = false
      }
    } catch (err) {
      this.pdfState.loading = false
      this.pdfState.error = err.message || '加载 PDF 页面失败'
    }
    this.renderSheet()
  }

  openSearchSheet() { this.activeSheet = 'search'; this.renderSheet() }
  openMarkDetail(ids) { this.activeSheet = 'markDetail'; this.sheetData = { ids }; this.renderSheet() }
  closeSheet() {
    this.activeSheet = null
    this.sheetData = null
    this.renderSheet()
  }

  handleBack() {
    if (this.activeSheet) { this.closeSheet(); return true }
    if (this.selectionInfo) { this.clearSelection(); return true }
    if (this.barsVisible) { this.barsVisible = false; this.renderChrome(); return true }
    void this.onExit()
    return true
  }

  renderSheet() {
    renderReaderSheet(this, this.root.querySelector('[data-role="sheet"]'))
  }
}
