import {
  buildFootnoteIndex,
  computeViewportLayout,
  escapeHtml,
  extractGlossaryHits,
  footnoteDisplayNumbers,
  plainText,
  renderBlockBodyHtml,
  resolveFootnote,
  resolveTapZoneAction,
  validateCorrectionMarkers,
} from './reading-core.js'
import { readerApi } from './api.js'
import { offlineDb } from './offline-db.js'
import { nativeBridge } from './native-bridge.js'

function nowClock() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export class ReaderController {
  constructor({ root, taskId, reading, settings, initialBlockId, initialView, onExit, onToast, onSettingsChange }) {
    this.root = root
    this.taskId = taskId
    this.reading = reading
    this.settings = settings
    this.onExit = onExit
    this.onToast = onToast
    this.onSettingsChange = onSettingsChange

    const hasTrans = Boolean(reading.comparisonAvailable || reading.blocks?.some(b => b.translation) || reading.standaloneView === 'translation')
    if (initialView && ['original', 'translation', 'bilingual'].includes(initialView)) {
      this.viewMode = initialView === 'original' || hasTrans ? initialView : 'original'
    } else {
      this.viewMode = hasTrans ? 'translation' : 'original'
    }

    this.hasTranslation = hasTrans
    this.marks = []
    this.barsVisible = false
    this.activeSheet = null // 'toc' | 'typography' | 'drawer' | 'footnote' | 'noteEditor' | 'correction' | 'pdf'
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
    this.destroyed = false
    this.touchStart = null
    this.lastSwipeAt = 0
  }

  async mount() {
    await nativeBridge.setImmersive(true)
    await nativeBridge.setSelectionMenuDisabled(true)
    await nativeBridge.configureKeys({
      enabled: true,
      prevKeys: this.settings.prevKeys,
      nextKeys: this.settings.nextKeys,
    })

    this.marks = await readerApi.loadMarks(this.settings, this.taskId).catch(() => [])
    this.render()
    this.bindGlobalEvents()
    this.checkRemoteProgress()
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.saveTimer)
    clearTimeout(this.selectionTimer)
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
    const list = this.viewMode === 'original'
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
    this.onResize = () => this.recomputeLayout(true)
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
    const fontMap = {
      serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, serif',
      sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif',
      mono: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
    }
    r.setProperty('--reader-size', `${s.fontSize}px`)
    r.setProperty('--reader-lh', String(s.lineHeight))
    r.setProperty('--reader-pad-x', `${this.layoutInfo?.horizontalPadding ?? s.marginX}px`)
    r.setProperty('--reader-font', fontMap[s.fontFamily] || fontMap.serif)
  }

  render() {
    this.applyTypographyVars()
    this.root.innerHTML = `
      <div class="wr-reader" data-role="reader">
        <div class="wr-readerMiniTop">
          <span data-role="chapter-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:75%">${escapeHtml(this.reading.title || '')}</span>
          <span data-role="view-badge">${this.viewMode === 'bilingual' ? '双语' : this.viewMode === 'original' ? '原文' : '译文'}</span>
        </div>
        <div class="wr-readerViewport ${this.settings.pageMode === 'scroll' ? 'scroll-mode' : ''}" data-role="viewport">
          <div class="wr-pagesTrack" data-role="track">
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
    const noteNumbers = footnoteDisplayNumbers(this.activeBlocks(), this.reading.kind === 'paper' ? [] : outline, isTrans && !this.reading.standaloneView)
    const origNoteNumbers = this.viewMode === 'bilingual'
      ? footnoteDisplayNumbers(this.reading.originalBlocks ?? this.reading.blocks ?? [], this.reading.kind === 'paper' ? [] : (this.reading.originalOutline?.outline ?? []), false)
      : noteNumbers

    const marksByBlock = new Map()
    const activeViewKey = this.viewMode === 'original' ? 'original' : 'translation'
    for (const m of this.marks) {
      if (m.view !== activeViewKey && !(this.viewMode === 'bilingual' && m.view === 'original')) continue
      if (!marksByBlock.has(m.blockId)) marksByBlock.set(m.blockId, [])
      marksByBlock.get(m.blockId).push(m)
    }

    const useParallelBilingual = this.viewMode === 'bilingual' && this.layoutInfo.effectiveBilingual === 'parallel'

    const html = blocks.map(b => {
      const mainText = this.viewMode === 'original'
        ? (b.sourceText ?? b.text)
        : (this.reading.standaloneView === 'translation' ? b.text : (b.translation ?? b.text))
      const blockMarks = (marksByBlock.get(b.id) ?? []).filter(m => m.view === (this.viewMode === 'original' ? 'original' : 'translation'))
      const showTrigger = this.viewMode === 'translation' && Boolean(b.sourceText || b.pdfPage)
      const body = renderBlockBodyHtml(mainText, b, {
        view: this.viewMode === 'original' ? 'original' : 'translation',
        marks: blockMarks,
        noteNumbers,
        showDrawerTrigger: showTrigger,
      })

      if (this.viewMode === 'bilingual' && b.sourceText && b.sourceText !== mainText) {
        const srcMarks = (marksByBlock.get(b.id) ?? []).filter(m => m.view === 'original')
        const srcHtml = renderBlockBodyHtml(b.sourceText, b, {
          view: 'original',
          marks: srcMarks,
          noteNumbers: origNoteNumbers,
          showDrawerTrigger: Boolean(b.pdfPage),
        })
        if (useParallelBilingual) {
          return `<div class="wr-block bilingual-parallel" data-block-id="${escapeHtml(b.id)}"><div class="wr-bilingualPrimary" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="translation">${body}</div><div class="wr-bilingualSource" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="original">${srcHtml}</div></div>`
        }
        const bilingualExtra = `<div class="wr-bilingualSource" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="original">${srcHtml}</div>`
        return `<div class="wr-block" data-block-id="${escapeHtml(b.id)}" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="translation">${body}${bilingualExtra}</div>`
      }

      return `<div class="wr-block" data-block-id="${escapeHtml(b.id)}" data-bookmark-block="${escapeHtml(b.id)}" data-bookmark-view="${this.viewMode === 'original' ? 'original' : 'translation'}">${body}</div>`
    }).join('')

    this.columnsEl.innerHTML = html
    this.hydrateImages()
    requestAnimationFrame(() => this.recomputeLayout(false))
  }

  hydrateImages() {
    const imgs = this.columnsEl?.querySelectorAll('img[data-asset-ref]') ?? []
    for (const img of imgs) {
      const ref = img.getAttribute('data-asset-ref')
      readerApi.loadAssetUrl(this.settings, this.taskId, ref)
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

    // If screen rotated across 640px threshold while in bilingual mode, re-render blocks to toggle stacked vs parallel
    if (this.viewMode === 'bilingual' && prevBilingual && prevBilingual !== layout.effectiveBilingual) {
      this.pendingBlockId = this.currentTopBlockId()
      this.renderBlocks()
      return
    }

    if (this.settings.pageMode === 'scroll') {
      this.viewportEl.classList.remove('two-col-spread')
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

    this.viewportEl.classList.toggle('two-col-spread', layout.colsPerSpread === 2)
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
    if (this.settings.pageMode === 'scroll') {
      this.viewportEl?.scrollBy({ top: -Math.round((this.viewportEl?.clientHeight || 500) * 0.85) })
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
    if (this.settings.pageMode === 'scroll') {
      this.viewportEl?.scrollBy({ top: Math.round((this.viewportEl?.clientHeight || 500) * 0.85) })
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

  jumpToBlock(blockId, viewMode) {
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
    if (immediate) {
      void readerApi.saveProgress(this.settings, entry)
    } else {
      void readerApi.saveProgress(this.settings, entry)
    }
  }

  bindReaderInteractions() {
    const vp = this.viewportEl
    if (!vp) return

    vp.addEventListener('scroll', () => {
      if (this.settings.pageMode === 'scroll') {
        this.updatePageIndicator()
        this.scheduleSaveProgress()
      }
    }, { passive: true })

    // Support both finger touch and Hanwang Wacom electromagnetic stylus (PointerEvent)
    vp.addEventListener('pointerdown', e => {
      if (e.button && e.button !== 0) return
      this.touchStart = { x: e.clientX, y: e.clientY, time: Date.now(), pointerType: e.pointerType }
    }, { passive: true })

    vp.addEventListener('pointerup', e => {
      if (!this.touchStart) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) {
        this.touchStart = null
        setTimeout(() => this.inspectSelection(), 60)
        return
      }
      const dx = e.clientX - this.touchStart.x
      const dy = e.clientY - this.touchStart.y
      const dt = Date.now() - this.touchStart.time
      this.touchStart = null
      if (this.settings.pageMode === 'paginated' && this.settings.tapZoneMode !== 'keysOnly' && dt < 450 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        this.lastSwipeAt = Date.now()
        if (dx < 0) this.nextPage()
        else this.prevPage()
      }
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
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return
      if (this.selectionInfo) {
        this.clearSelection()
        return
      }
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
    try { window.getSelection()?.removeAllRanges() } catch {}
    this.renderCapsule()
  }

  renderCapsule() {
    const host = this.root.querySelector('[data-role="capsule"]')
    if (!host) return
    if (!this.selectionInfo) {
      host.innerHTML = ''
      return
    }
    const existing = this.marks.filter(m => m.view === this.selectionInfo.view && m.exact === this.selectionInfo.exact && (m.blockId === this.selectionInfo.startBlockId || m.blockId === this.selectionInfo.endBlockId))
    const hasHighlight = existing.some(m => m.kind === 'highlight')

    host.innerHTML = `
      <div class="wr-selectionCapsule" style="left:${this.selectionInfo.left}px;top:${this.selectionInfo.top}px;">
        <button type="button" class="wr-capsuleBtn" data-cap="highlight">${hasHighlight ? '取消划线' : '划线'}</button>
        <button type="button" class="wr-capsuleBtn" data-cap="note">写想法</button>
        <button type="button" class="wr-capsuleBtn" data-cap="original">看原文</button>
        <button type="button" class="wr-capsuleBtn" data-cap="correct">纠错</button>
        <button type="button" class="wr-capsuleBtn" data-cap="copy">复制</button>
      </div>
    `

    host.querySelector('[data-cap="highlight"]').onclick = async () => {
      const sel = this.selectionInfo
      if (!sel) return
      if (hasHighlight) {
        const hIds = [...new Set(existing.filter(m => m.kind === 'highlight').map(m => m.id))]
        for (const id of hIds) {
          await readerApi.postBookmarkAction(this.settings, { source: { kind: 'task', id: this.taskId }, removeHighlight: id })
        }
        this.marks = this.marks.filter(m => !hIds.includes(m.id))
        this.onToast('已取消划线')
      } else {
        const created = await readerApi.postBookmarkAction(this.settings, {
          source: { kind: 'task', id: this.taskId },
          selection: sel,
          highlightOnly: true,
        })
        this.marks.push({
          id: created?.id || 'local-' + Date.now(),
          kind: 'highlight',
          view: sel.view,
          blockId: sel.startBlockId,
          quote: sel.exact,
          exact: sel.exact,
        })
        this.onToast('已划线')
      }
      await offlineDb.saveMarks(this.taskId, this.marks)
      this.clearSelection()
      this.renderBlocks()
    }

    host.querySelector('[data-cap="note"]').onclick = () => {
      const sel = this.selectionInfo
      this.activeSheet = 'noteEditor'
      this.sheetData = { selection: sel }
      this.clearSelection()
      this.renderSheet()
    }

    host.querySelector('[data-cap="original"]').onclick = () => {
      const id = this.selectionInfo?.startBlockId
      this.clearSelection()
      if (id) this.openBilingualDrawer(id)
    }

    host.querySelector('[data-cap="correct"]').onclick = () => {
      const sel = this.selectionInfo
      this.clearSelection()
      if (sel) this.openCorrectionSheet(sel.startBlockId, sel.view)
    }

    host.querySelector('[data-cap="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(this.selectionInfo.exact); this.onToast('已复制') } catch {}
      this.clearSelection()
    }
  }

  renderChrome() {
    const host = this.root.querySelector('[data-role="chrome"]')
    if (!host) return
    const bannerHtml = this.syncBanner ? `
      <div class="wr-syncBanner">
        <span>同步到「${escapeHtml(this.syncBanner.deviceName || '其他设备')}」的进度（${this.syncBanner.percent || 1}%）</span>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button type="button" class="wr-btnGhost" data-banner="dismiss" style="padding:4px 8px;font-size:12px;">忽略</button>
          <button type="button" class="wr-btnPrimary" data-banner="jump" style="padding:4px 10px;font-size:12px;">跳转</button>
        </div>
      </div>
    ` : ''

    if (!this.barsVisible) {
      host.innerHTML = bannerHtml
      this.bindBanner(host)
      return
    }

    const viewSegs = this.hasTranslation
      ? `
        <div class="wr-segGroup">
          <button type="button" class="wr-segBtn ${this.viewMode === 'translation' ? 'active' : ''}" data-view="translation">译文</button>
          <button type="button" class="wr-segBtn ${this.viewMode === 'bilingual' ? 'active' : ''}" data-view="bilingual">双语</button>
          <button type="button" class="wr-segBtn ${this.viewMode === 'original' ? 'active' : ''}" data-view="original">原文</button>
        </div>
      `
      : ''

    host.innerHTML = `
      ${bannerHtml}
      <div class="wr-overlayTop">
        <button type="button" class="wr-btnGhost" data-act="back">‹ 书架</button>
        ${viewSegs}
        <div style="display:flex;gap:6px;">
          ${this.reading.pdfLocationAvailable || this.reading.pdfAvailable ? '<button type="button" class="wr-btnGhost" data-act="pdf">PDF</button>' : ''}
          <button type="button" class="wr-btnGhost" data-act="toc">目录</button>
        </div>
      </div>
      <div class="wr-overlayBottom">
        <div class="wr-barRow">
          <span style="font-size:12px;color:var(--fg-muted);">${this.settings.pageMode === 'scroll' ? '滚动阅读' : `第 ${this.currentPage + 1}/${this.totalPages} 页`}</span>
          ${this.settings.pageMode === 'paginated' ? `<input type="range" min="1" max="${this.totalPages}" value="${this.currentPage + 1}" data-act="scrub" style="flex:1;" />` : '<div style="flex:1"></div>'}
          <button type="button" class="wr-btnGhost" data-act="togglePageMode">${this.settings.pageMode === 'paginated' ? '切滚动' : '切分页'}</button>
        </div>
        <div class="wr-barRow">
          <button type="button" class="wr-btnGhost" data-act="typography">Aa 排版与主题</button>
          <button type="button" class="wr-btnGhost" data-act="eink">${this.settings.theme === 'eink' ? '✓ 墨水屏模式' : '墨水屏模式'}</button>
          <button type="button" class="wr-btnGhost" data-act="drawer">对照当前段</button>
        </div>
      </div>
    `

    this.bindBanner(host)
    host.querySelector('[data-act="back"]').onclick = () => this.onExit()
    host.querySelectorAll('[data-view]').forEach(btn => {
      btn.onclick = () => {
        const nextView = btn.dataset.view
        if (nextView === this.viewMode) return
        const anchor = this.currentTopBlockId()
        this.viewMode = nextView
        this.pendingBlockId = anchor
        this.barsVisible = false
        this.render()
        this.scheduleSaveProgress()
      }
    })
    host.querySelector('[data-act="toc"]').onclick = () => {
      this.barsVisible = false
      this.activeSheet = 'toc'
      const items = this.outlineItems()
      const currentBlock = this.currentTopBlockId()
      const activeIdx = Math.max(0, items.findIndex(it => it.id === currentBlock))
      this.tocPage = Math.floor(activeIdx / 10)
      this.renderChrome()
      this.renderSheet()
    }
    const pdfBtn = host.querySelector('[data-act="pdf"]')
    if (pdfBtn) {
      pdfBtn.onclick = () => {
        const block = this.visibleBlocks().find(b => b.id === this.currentTopBlockId())
        this.barsVisible = false
        this.renderChrome()
        this.openPdfViewer(block?.pdfPage || 1)
      }
    }
    const scrub = host.querySelector('[data-act="scrub"]')
    if (scrub) {
      scrub.oninput = () => {
        this.currentPage = Math.max(0, Math.min(this.totalPages - 1, Number(scrub.value) - 1))
        this.applyPageTransform()
      }
      scrub.onchange = () => this.scheduleSaveProgress()
    }
    host.querySelector('[data-act="togglePageMode"]').onclick = async () => {
      const anchor = this.currentTopBlockId()
      const next = this.settings.pageMode === 'paginated' ? 'scroll' : 'paginated'
      this.settings = await this.onSettingsChange({ pageMode: next })
      this.pendingBlockId = anchor
      this.render()
    }
    host.querySelector('[data-act="typography"]').onclick = () => {
      this.barsVisible = false
      this.activeSheet = 'typography'
      this.renderChrome()
      this.renderSheet()
    }
    host.querySelector('[data-act="eink"]').onclick = async () => {
      const toEink = this.settings.theme !== 'eink'
      this.settings = await this.onSettingsChange({
        theme: toEink ? 'eink' : 'paper',
        deviceMode: toEink ? 'eink' : 'phone',
      })
      this.renderPageTurnBar()
      this.recomputeLayout(true)
      this.renderChrome()
    }
    host.querySelector('[data-act="drawer"]').onclick = () => {
      const id = this.currentTopBlockId() || this.visibleBlocks()[0]?.id
      this.barsVisible = false
      this.renderChrome()
      if (id) this.openBilingualDrawer(id)
    }
  }

  bindBanner(host) {
    const dismiss = host.querySelector('[data-banner="dismiss"]')
    const jump = host.querySelector('[data-banner="jump"]')
    if (dismiss) dismiss.onclick = () => { this.syncBanner = null; this.renderChrome() }
    if (jump) {
      jump.onclick = () => {
        const target = this.syncBanner
        this.syncBanner = null
        if (target?.blockId) this.jumpToBlock(target.blockId, target.view)
        else this.renderChrome()
      }
    }
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

    // Also resolve counterpart footnote if available
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
    const raw = view === 'original'
      ? (block.sourceText ?? block.text)
      : (this.reading.standaloneView === 'translation' ? block.text : (block.translation ?? block.text))
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
      const res = await readerApi.loadPdfPageImageUrl(this.settings, this.taskId, this.pdfState.page, this.settings.theme === 'eink' ? 200 : 180)
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

  closeSheet() {
    this.activeSheet = null
    this.sheetData = null
    this.renderSheet()
  }

  renderSheet() {
    const host = this.root.querySelector('[data-role="sheet"]')
    if (!host) return
    if (!this.activeSheet) {
      host.innerHTML = ''
      return
    }

    if (this.activeSheet === 'pdf') {
      const p = this.pdfState
      host.innerHTML = `
        <div class="wr-modalFull">
          <div class="wr-topbar">
            <button type="button" class="wr-btnGhost" data-act="close">‹ 返回阅读</button>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" class="wr-btnGhost" data-pdf="prev">上一页</button>
              <span style="font-size:13px;font-weight:600;">第 ${p.page} 页</span>
              <button type="button" class="wr-btnGhost" data-pdf="next">下一页</button>
            </div>
            <button type="button" class="wr-btnGhost" data-pdf="zoom">${p.zoom}%</button>
          </div>
          <div class="wr-pdfCanvasWrap">
            ${p.loading ? '<p>正在渲染原书 PDF 页面...</p>' : p.error ? `<p style="color:#dc2626;">${escapeHtml(p.error)}</p>` : p.fallbackPdfUrl ? `<iframe src="${p.fallbackPdfUrl}#page=${p.page}" style="width:100%;height:100%;border:none;"></iframe>` : `<img class="wr-pdfPageImg" src="${p.imgUrl}" style="width:${p.zoom}%;max-width:none;" />`}
          </div>
        </div>
      `
      host.querySelector('[data-act="close"]').onclick = () => this.closeSheet()
      host.querySelector('[data-pdf="prev"]').onclick = () => { if (p.page > 1) this.loadPdfPage(p.page - 1) }
      host.querySelector('[data-pdf="next"]').onclick = () => this.loadPdfPage(p.page + 1)
      host.querySelector('[data-pdf="zoom"]').onclick = () => {
        p.zoom = p.zoom === 100 ? 150 : p.zoom === 150 ? 200 : 100
        this.renderSheet()
      }
      return
    }

    let inner = ''
    if (this.activeSheet === 'toc') {
      const currentBlock = this.currentTopBlockId()
      const items = this.outlineItems()
      const usePagination = this.settings.deviceMode === 'eink' || this.settings.theme === 'eink' || items.length > 12
      const pageSize = 10
      this.tocTotalPages = usePagination ? Math.max(1, Math.ceil(items.length / pageSize)) : 1
      this.tocPage = Math.max(0, Math.min(this.tocTotalPages - 1, this.tocPage))
      const slice = usePagination ? items.slice(this.tocPage * pageSize, (this.tocPage + 1) * pageSize) : items

      inner = `
        <div class="wr-barRow">
          <h3 style="margin:0;font-size:16px;">目录（${items.length}）</h3>
          <button type="button" class="wr-btnGhost" data-act="close">关闭</button>
        </div>
        <div>
          ${slice.length ? slice.map(it => `
            <button type="button" class="wr-tocItem ${it.id === currentBlock ? 'active' : ''}" data-toc-id="${escapeHtml(it.id)}" style="padding-left:${(it.level - 1) * 14 + 6}px;">
              ${escapeHtml(it.label)}
            </button>
          `).join('') : '<p style="color:var(--fg-muted);font-size:13px;">本文档暂无目录结构</p>'}
        </div>
        ${usePagination && this.tocTotalPages > 1 ? `
          <div class="wr-einkPager">
            <button type="button" class="wr-btnGhost" data-toc-page="prev" ${this.tocPage <= 0 ? 'disabled' : ''}>‹ 上一章页</button>
            <span style="font-size:12px;color:var(--fg-muted);">第 ${this.tocPage + 1} / ${this.tocTotalPages} 页</span>
            <button type="button" class="wr-btnGhost" data-toc-page="next" ${this.tocPage >= this.tocTotalPages - 1 ? 'disabled' : ''}>下一章页 ›</button>
          </div>
        ` : ''}
      `
    } else if (this.activeSheet === 'typography') {
      const s = this.settings
      const colMode = s.columnLayout || 'auto'
      const biMode = s.bilingualLayout || 'auto'
      const tapMode = s.tapZoneMode || 'ergonomic'
      inner = `
        <div class="wr-barRow">
          <h3 style="margin:0;font-size:16px;">排版、分栏与操控</h3>
          <button type="button" class="wr-btnGhost" data-act="close">完成</button>
        </div>
        <div class="wr-themeChips">
          ${[
            ['paper', '纸质'],
            ['white', '纯白'],
            ['green', '护眼'],
            ['night', '夜间'],
            ['eink', '墨水屏'],
          ].map(([id, label]) => `<button type="button" class="wr-themeChip ${s.theme === id ? 'active' : ''}" data-theme-pick="${id}">${label}</button>`).join('')}
        </div>
        <label class="wr-field">字号 (${s.fontSize}px)
          <input type="range" min="14" max="28" step="1" value="${s.fontSize}" data-typo="fontSize" />
        </label>
        <label class="wr-field">行距 (${s.lineHeight})
          <input type="range" min="1.4" max="2.3" step="0.05" value="${s.lineHeight}" data-typo="lineHeight" />
        </label>
        <label class="wr-field">页边距 (${s.marginX}px)
          <input type="range" min="10" max="40" step="2" value="${s.marginX}" data-typo="marginX" />
        </label>
        <div class="wr-field">字体
          <div class="wr-segGroup">
            <button type="button" class="wr-segBtn ${s.fontFamily === 'serif' ? 'active' : ''}" data-font="serif">宋体/衬线</button>
            <button type="button" class="wr-segBtn ${s.fontFamily === 'sans' ? 'active' : ''}" data-font="sans">黑体/无衬线</button>
            <button type="button" class="wr-segBtn ${s.fontFamily === 'mono' ? 'active' : ''}" data-font="mono">等宽</button>
          </div>
        </div>
        <div class="wr-field">分栏版式（适配宽屏墨水屏 / 手机横竖屏）
          <div class="wr-segGroup">
            <button type="button" class="wr-segBtn ${colMode === 'auto' ? 'active' : ''}" data-col-layout="auto">自动(宽屏双栏)</button>
            <button type="button" class="wr-segBtn ${colMode === 'single' ? 'active' : ''}" data-col-layout="single">单栏适宽</button>
            <button type="button" class="wr-segBtn ${colMode === 'double' ? 'active' : ''}" data-col-layout="double">双栏对开</button>
          </div>
        </div>
        <div class="wr-field">双语对照排版（手机竖屏 vs 墨水屏宽屏）
          <div class="wr-segGroup">
            <button type="button" class="wr-segBtn ${biMode === 'auto' ? 'active' : ''}" data-bi-layout="auto">自动适配</button>
            <button type="button" class="wr-segBtn ${biMode === 'stacked' ? 'active' : ''}" data-bi-layout="stacked">上下叠排</button>
            <button type="button" class="wr-segBtn ${biMode === 'parallel' ? 'active' : ''}" data-bi-layout="parallel">左右并排</button>
          </div>
        </div>
        <div class="wr-field">触控与手写笔翻页热区
          <div class="wr-segGroup" style="flex-wrap:wrap;">
            <button type="button" class="wr-segBtn ${tapMode === 'ergonomic' ? 'active' : ''}" data-tap-mode="ergonomic">单手拇指</button>
            <button type="button" class="wr-segBtn ${tapMode === 'classic' ? 'active' : ''}" data-tap-mode="classic">经典三区</button>
            <button type="button" class="wr-segBtn ${tapMode === 'bottomNext' ? 'active' : ''}" data-tap-mode="bottomNext">下半屏下翻</button>
            <button type="button" class="wr-segBtn ${tapMode === 'keysOnly' ? 'active' : ''}" data-tap-mode="keysOnly">手写笔防误触</button>
          </div>
        </div>
        <div class="wr-barRow">
          <span style="font-size:12px;color:var(--fg-muted);">底部显式翻页栏（适合电磁笔点按 / 无触控机型）</span>
          <button type="button" class="wr-btnGhost" data-act="toggle-pt-bar" style="padding:5px 10px;font-size:12px;">${s.showPageTurnBar || tapMode === 'keysOnly' ? '✓ 已开启' : '开启'}</button>
        </div>
      `
    } else if (this.activeSheet === 'drawer') {
      const b = this.sheetData.block
      const transText = this.reading.standaloneView === 'translation' ? b.text : (b.translation ?? b.text)
      const origText = b.sourceText ?? b.text
      const glossaryHits = extractGlossaryHits(transText, origText, this.reading.glossary)
      inner = `
        <div class="wr-barRow">
          <h3 style="margin:0;font-size:16px;">双语对照${b.pdfPage ? ` · 原书第 ${b.pdfPage} 页` : ''}</h3>
          <button type="button" class="wr-btnGhost" data-act="close">关闭</button>
        </div>
        ${this.hasTranslation ? `<div><div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">译文</div><p style="margin:0;line-height:1.65;">${escapeHtml(plainText(transText))}</p></div>` : ''}
        <div><div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">原文</div><p style="margin:0;line-height:1.65;color:var(--fg-muted);">${escapeHtml(plainText(origText))}</p></div>
        ${glossaryHits.length ? `
          <div>
            <div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">命中术语</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${glossaryHits.map(g => `<span class="wr-badge">${escapeHtml(g.source)} → ${escapeHtml(g.target)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        <div class="wr-barRow" style="margin-top:4px;">
          <button type="button" class="wr-btnGhost" data-act="correct-from-drawer">段落纠错</button>
          ${b.pdfPage ? `<button type="button" class="wr-btnPrimary" data-act="open-pdf-page">查看原 PDF 第 ${b.pdfPage} 页</button>` : ''}
        </div>
      `
    } else if (this.activeSheet === 'footnote') {
      const d = this.sheetData
      const shown = d.showAlt && d.altEntry ? d.altEntry : d.entry
      inner = `
        <div class="wr-barRow">
          <h3 style="margin:0;font-size:16px;">注释 [${escapeHtml(d.fnId)}]</h3>
          <div style="display:flex;gap:6px;">
            ${d.altEntry ? `<button type="button" class="wr-btnGhost" data-act="toggle-fn">${d.showAlt ? '看当前语言' : '看对应语言'}</button>` : ''}
            <button type="button" class="wr-btnGhost" data-act="close">关闭</button>
          </div>
        </div>
        <p style="margin:0;line-height:1.7;font-size:15px;">${shown ? escapeHtml(shown.text) : '未找到该脚注定义'}</p>
      `
    } else if (this.activeSheet === 'noteEditor') {
      const sel = this.sheetData.selection
      inner = `
        <div class="wr-barRow">
          <h3 style="margin:0;font-size:16px;">写想法 · 书签</h3>
          <button type="button" class="wr-btnGhost" data-act="close">取消</button>
        </div>
        <blockquote class="wr-quoteBox">${escapeHtml(sel.exact)}</blockquote>
        <textarea class="wr-textarea" data-note="comment" placeholder="写下你的批注或想法..."></textarea>
        <input class="wr-input" data-note="tags" placeholder="标签（用逗号分隔，可留空）" />
        <button type="button" class="wr-btnPrimary" data-act="save-note">保存书签与想法</button>
      `
    } else if (this.activeSheet === 'correction') {
      const d = this.sheetData
      inner = `
        <div class="wr-barRow">
          <h3 style="margin:0;font-size:16px;">段落勘误（${d.view === 'original' ? '修改原文' : '修改译文'}）</h3>
          <button type="button" class="wr-btnGhost" data-act="close">取消</button>
        </div>
        <p style="margin:0;font-size:12px;color:var(--fg-muted);">请保留原有注号（如 [^1]）与标题层级，保存后将同步到云端与 PC。</p>
        <textarea class="wr-textarea" data-corr="text" style="min-height:140px;">${escapeHtml(d.raw)}</textarea>
        <input class="wr-input" data-corr="reason" placeholder="勘误说明（选填）" />
        <button type="button" class="wr-btnPrimary" data-act="save-corr">保存修订</button>
      `
    }

    const dockSide = Boolean(this.layoutInfo?.dockSideSheet)
    host.innerHTML = `<div class="wr-sheetBackdrop ${dockSide ? 'dock-side' : ''}" data-backdrop="1"><div class="wr-sheet">${inner}</div></div>`
    host.querySelector('[data-backdrop="1"]').onclick = e => { if (e.target === e.currentTarget) this.closeSheet() }
    host.querySelector('[data-act="close"]')?.addEventListener('click', () => this.closeSheet())

    if (this.activeSheet === 'toc') {
      host.querySelectorAll('[data-toc-id]').forEach(btn => {
        btn.onclick = () => {
          const id = btn.dataset.tocId
          this.closeSheet()
          this.jumpToBlock(id)
        }
      })
      host.querySelector('[data-toc-page="prev"]')?.addEventListener('click', () => this.turnTocPage(-1))
      host.querySelector('[data-toc-page="next"]')?.addEventListener('click', () => this.turnTocPage(1))
    } else if (this.activeSheet === 'typography') {
      host.querySelectorAll('[data-theme-pick]').forEach(btn => {
        btn.onclick = async () => {
          const t = btn.dataset.themePick
          this.settings = await this.onSettingsChange({ theme: t, deviceMode: t === 'eink' ? 'eink' : 'phone' })
          this.renderSheet()
        }
      })
      host.querySelectorAll('[data-typo]').forEach(inp => {
        inp.onchange = async () => {
          this.settings = await this.onSettingsChange({ [inp.dataset.typo]: Number(inp.value) })
          this.applyTypographyVars()
          this.recomputeLayout(true)
          this.renderSheet()
        }
      })
      host.querySelectorAll('[data-font]').forEach(btn => {
        btn.onclick = async () => {
          this.settings = await this.onSettingsChange({ fontFamily: btn.dataset.font })
          this.applyTypographyVars()
          this.recomputeLayout(true)
          this.renderSheet()
        }
      })
      host.querySelectorAll('[data-col-layout]').forEach(btn => {
        btn.onclick = async () => {
          this.settings = await this.onSettingsChange({ columnLayout: btn.dataset.colLayout })
          this.recomputeLayout(true)
          this.renderSheet()
        }
      })
      host.querySelectorAll('[data-bi-layout]').forEach(btn => {
        btn.onclick = async () => {
          this.settings = await this.onSettingsChange({ bilingualLayout: btn.dataset.biLayout })
          this.pendingBlockId = this.currentTopBlockId()
          this.renderBlocks()
          this.renderSheet()
        }
      })
      host.querySelectorAll('[data-tap-mode]').forEach(btn => {
        btn.onclick = async () => {
          this.settings = await this.onSettingsChange({ tapZoneMode: btn.dataset.tapMode })
          this.renderPageTurnBar()
          this.recomputeLayout(true)
          this.renderSheet()
        }
      })
      host.querySelector('[data-act="toggle-pt-bar"]')?.addEventListener('click', async () => {
        this.settings = await this.onSettingsChange({ showPageTurnBar: !this.settings.showPageTurnBar })
        this.renderPageTurnBar()
        this.recomputeLayout(true)
        this.renderSheet()
      })
    } else if (this.activeSheet === 'drawer') {
      const b = this.sheetData.block
      host.querySelector('[data-act="correct-from-drawer"]').onclick = () => {
        this.openCorrectionSheet(b.id, this.viewMode === 'original' ? 'original' : 'translation')
      }
      host.querySelector('[data-act="open-pdf-page"]')?.addEventListener('click', () => {
        this.openPdfViewer(b.pdfPage)
      })
    } else if (this.activeSheet === 'footnote') {
      host.querySelector('[data-act="toggle-fn"]')?.addEventListener('click', () => {
        this.sheetData.showAlt = !this.sheetData.showAlt
        this.renderSheet()
      })
    } else if (this.activeSheet === 'noteEditor') {
      host.querySelector('[data-act="save-note"]').onclick = async () => {
        const comment = host.querySelector('[data-note="comment"]').value
        const tagsRaw = host.querySelector('[data-note="tags"]').value
        const tags = tagsRaw.split(/[，,]/).map(s => s.trim()).filter(Boolean)
        const created = await readerApi.postBookmarkAction(this.settings, {
          source: { kind: 'task', id: this.taskId },
          selection: this.sheetData.selection,
          comment,
          tags,
        })
        this.marks.push({
          id: created?.id || 'local-' + Date.now(),
          kind: 'bookmark',
          view: this.sheetData.selection.view,
          blockId: this.sheetData.selection.startBlockId,
          quote: this.sheetData.selection.exact,
          exact: this.sheetData.selection.exact,
          comment,
        })
        await offlineDb.saveMarks(this.taskId, this.marks)
        this.closeSheet()
        this.renderBlocks()
        this.onToast(created?.offlineQueued ? '已离线暂存书签，联网后自动同步' : '已保存书签')
      }
    } else if (this.activeSheet === 'correction') {
      host.querySelector('[data-act="save-corr"]').onclick = async () => {
        const d = this.sheetData
        const nextText = host.querySelector('[data-corr="text"]').value
        const reason = host.querySelector('[data-corr="reason"]').value
        try {
          validateCorrectionMarkers(d.raw, nextText)
          const res = await readerApi.submitCorrection(this.settings, this.taskId, {
            blockId: d.block.id,
            view: d.view,
            version: this.reading.version,
            text: nextText,
            reason,
            deviceName: this.settings.deviceName,
          })
          if (res.reading) {
            this.reading = res.reading
            this.pendingBlockId = d.block.id
            this.closeSheet()
            this.renderBlocks()
            this.onToast('勘误已保存并同步到云端')
          } else {
            this.closeSheet()
            this.onToast('已加入离线同步队列，联网后提交')
          }
        } catch (err) {
          this.onToast(err.message)
        }
      }
    }
  }
}
