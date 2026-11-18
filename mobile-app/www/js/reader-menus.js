import {
  WEREAD_FONTS,
  WEREAD_SPACING_PRESETS,
  WEREAD_THEMES,
  escapeHtml,
} from './reading-core.js'
import { readerApi } from './api.js'
import { offlineDb } from './offline-db.js'

export function renderSelectionCapsule(ctrl, host) {
  if (!host) return
  if (!ctrl.selectionInfo) {
    host.innerHTML = ''
    return
  }
  const existing = ctrl.marks.filter(
    m =>
      m.view === ctrl.selectionInfo.view &&
      m.exact === ctrl.selectionInfo.exact &&
      (m.blockId === ctrl.selectionInfo.startBlockId || m.blockId === ctrl.selectionInfo.endBlockId)
  )
  const hasHighlight = existing.some(m => m.kind === 'highlight')

  host.innerHTML = `
    <div class="wr-selectionCapsule" style="left:${ctrl.selectionInfo.left}px;top:${ctrl.selectionInfo.top}px;">
      <button type="button" class="wr-capsuleBtn" data-cap="highlight">${hasHighlight ? '取消划线' : '划线'}</button>
      <button type="button" class="wr-capsuleBtn" data-cap="note">写想法</button>
      <button type="button" class="wr-capsuleBtn" data-cap="original">看原文</button>
      <button type="button" class="wr-capsuleBtn" data-cap="correct">纠错</button>
      <button type="button" class="wr-capsuleBtn" data-cap="copy">复制</button>
    </div>
  `

  host.querySelector('[data-cap="highlight"]').onclick = async () => {
    const sel = ctrl.selectionInfo
    if (!sel) return
    if (hasHighlight) {
      const hIds = [...new Set(existing.filter(m => m.kind === 'highlight').map(m => m.id))]
      for (const id of hIds) {
        await readerApi.postBookmarkAction(ctrl.settings, { source: { kind: 'task', id: ctrl.taskId }, removeHighlight: id })
      }
      ctrl.marks = ctrl.marks.filter(m => !hIds.includes(m.id))
      ctrl.onToast('已取消划线')
    } else {
      const created = await readerApi.postBookmarkAction(ctrl.settings, {
        source: { kind: 'task', id: ctrl.taskId },
        selection: sel,
        highlightOnly: true,
      })
      ctrl.marks.push({
        id: created?.id || 'local-' + Date.now(),
        kind: 'highlight',
        view: sel.view,
        blockId: sel.startBlockId,
        quote: sel.exact,
        exact: sel.exact,
      })
      ctrl.onToast('已划线')
    }
    await offlineDb.saveMarks(ctrl.taskId, ctrl.marks)
    ctrl.clearSelection()
    ctrl.renderBlocks()
  }

  host.querySelector('[data-cap="note"]').onclick = () => {
    const sel = ctrl.selectionInfo
    ctrl.activeSheet = 'noteEditor'
    ctrl.sheetData = { selection: sel }
    ctrl.clearSelection()
    ctrl.renderSheet()
  }

  host.querySelector('[data-cap="original"]').onclick = () => {
    const id = ctrl.selectionInfo?.startBlockId
    ctrl.clearSelection()
    if (id) ctrl.openBilingualDrawer(id)
  }

  host.querySelector('[data-cap="correct"]').onclick = () => {
    const sel = ctrl.selectionInfo
    ctrl.clearSelection()
    if (sel) ctrl.openCorrectionSheet(sel.startBlockId, sel.view)
  }

  host.querySelector('[data-cap="copy"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(ctrl.selectionInfo.exact)
      ctrl.onToast('已复制')
    } catch {}
    ctrl.clearSelection()
  }
}

function bindBanner(ctrl, host) {
  const dismiss = host.querySelector('[data-banner="dismiss"]')
  const jump = host.querySelector('[data-banner="jump"]')
  if (dismiss) {
    dismiss.onclick = () => {
      ctrl.syncBanner = null
      ctrl.renderChrome()
    }
  }
  if (jump) {
    jump.onclick = () => {
      const target = ctrl.syncBanner
      ctrl.syncBanner = null
      if (target?.blockId) ctrl.jumpToBlock(target.blockId, target.view)
      else ctrl.renderChrome()
    }
  }
}

export function renderReaderChrome(ctrl, host) {
  if (!host) return
  const bannerHtml = ctrl.syncBanner
    ? `
      <div class="wr-syncBanner">
        <span>同步到「${escapeHtml(ctrl.syncBanner.deviceName || '其他设备')}」的进度（${ctrl.syncBanner.percent || 1}%）</span>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button type="button" class="wr-btnGhost" data-banner="dismiss" style="padding:4px 8px;font-size:12px;">忽略</button>
          <button type="button" class="wr-btnPrimary" data-banner="jump" style="padding:4px 10px;font-size:12px;">跳转</button>
        </div>
      </div>
    `
    : ''

  if (!ctrl.barsVisible) {
    host.innerHTML = bannerHtml
    bindBanner(ctrl, host)
    return
  }

  const viewSegs = ctrl.hasTranslation
    ? `
      <div class="wr-segGroup">
        <button type="button" class="wr-segBtn ${ctrl.viewMode === 'translation' ? 'active' : ''}" data-view="translation">译文</button>
        <button type="button" class="wr-segBtn ${ctrl.viewMode === 'bilingual' ? 'active' : ''}" data-view="bilingual">双语</button>
        <button type="button" class="wr-segBtn ${ctrl.viewMode === 'original' ? 'active' : ''}" data-view="original">原文</button>
      </div>
    `
    : `<span style="font-size:13px;font-weight:600;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ctrl.reading.title || '')}</span>`

  const s = ctrl.settings
  const panel = ctrl.activeBottomPanel || 'progress'
  const colMode = s.columnLayout || 'auto'
  const biMode = s.bilingualLayout || 'auto'
  const tapMode = s.tapZoneMode || 'ergonomic'

  let panelHtml = ''
  if (panel === 'progress') {
    const pct =
      s.pageMode === 'scroll'
        ? Math.min(
            100,
            Math.max(
              1,
              Math.round(
                ((ctrl.viewportEl?.scrollTop ?? 0) /
                  Math.max(1, (ctrl.viewportEl?.scrollHeight ?? 1) - (ctrl.viewportEl?.clientHeight ?? 0))) *
                  100
              )
            )
          )
        : Math.min(100, Math.max(1, Math.round(((ctrl.currentPage + 1) / Math.max(1, ctrl.totalPages)) * 100)))
    panelHtml = `
      <div class="wr-dockPanel">
        <div style="text-align:center;font-size:12px;color:var(--fg-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${escapeHtml(ctrl.currentChapterLabel())} · ${s.pageMode === 'scroll' ? `滚动 ${pct}%` : `第 ${ctrl.currentPage + 1}/${ctrl.totalPages} 页 (${pct}%)`}
        </div>
        <div class="wr-barRow">
          <button type="button" class="wr-btnGhost" data-act="prev-chapter" style="padding:6px 10px;font-size:12px;">上一章</button>
          ${
            s.pageMode === 'paginated'
              ? `<input type="range" min="1" max="${ctrl.totalPages}" value="${ctrl.currentPage + 1}" data-act="scrub" style="flex:1;" />`
              : `<div style="flex:1;text-align:center;font-size:12px;color:var(--fg-muted);">上下连续滚动阅读中</div>`
          }
          <button type="button" class="wr-btnGhost" data-act="next-chapter" style="padding:6px 10px;font-size:12px;">下一章</button>
        </div>
        <div class="wr-barRow" style="flex-wrap:wrap;gap:6px;">
          <span style="font-size:12px;color:var(--fg-muted);">翻页方式</span>
          <div class="wr-segGroup">
            <button type="button" class="wr-segBtn ${s.pageMode === 'paginated' && s.pageTransition !== 'none' ? 'active' : ''}" data-pagemode="slide">平移翻页</button>
            <button type="button" class="wr-segBtn ${s.pageMode === 'paginated' && s.pageTransition === 'none' ? 'active' : ''}" data-pagemode="none">瞬切翻页</button>
            <button type="button" class="wr-segBtn ${s.pageMode === 'scroll' ? 'active' : ''}" data-pagemode="scroll">上下滚动</button>
          </div>
        </div>
        <div class="wr-barRow" style="flex-wrap:wrap;gap:6px;">
          <span style="font-size:12px;color:var(--fg-muted);">分栏与对照</span>
          <div class="wr-segGroup">
            <button type="button" class="wr-segBtn ${colMode === 'auto' ? 'active' : ''}" data-col-layout="auto">自动分栏</button>
            <button type="button" class="wr-segBtn ${colMode === 'single' ? 'active' : ''}" data-col-layout="single">单栏</button>
            <button type="button" class="wr-segBtn ${colMode === 'double' ? 'active' : ''}" data-col-layout="double">双栏</button>
          </div>
          <div class="wr-segGroup">
            <button type="button" class="wr-segBtn ${biMode === 'stacked' ? 'active' : ''}" data-bi-layout="stacked">双语叠排</button>
            <button type="button" class="wr-segBtn ${biMode === 'parallel' ? 'active' : ''}" data-bi-layout="parallel">双语并排</button>
          </div>
        </div>
      </div>
    `
  } else if (panel === 'theme') {
    panelHtml = `
      <div class="wr-dockPanel">
        <div class="wr-barRow">
          <span style="font-size:12px;color:var(--fg-muted);">亮度</span>
          <span style="font-size:13px;">🔅</span>
          <input type="range" min="35" max="100" step="1" value="${s.brightness ?? 100}" data-typo="brightness" style="flex:1;" />
          <span style="font-size:13px;">🔆</span>
          <button type="button" class="wr-btnGhost" data-act="eink" style="padding:5px 10px;font-size:12px;">${s.theme === 'eink' ? '✓ 水墨屏' : '水墨屏'}</button>
        </div>
        <div class="wr-swatchScroll">
          ${WEREAD_THEMES.map(
            t => `
            <button type="button" class="wr-swatchItem ${s.theme === t.id ? 'active' : ''}" data-theme-pick="${t.id}">
              <span class="wr-swatchCircle" style="background:${t.swatch};color:${t.fg};border-color:${s.theme === t.id ? 'var(--accent)' : t.border};">
                ${s.theme === t.id ? '✓' : t.id === 'eink' ? '墨' : ''}
              </span>
              <span>${t.label}</span>
            </button>
          `
          ).join('')}
        </div>
      </div>
    `
  } else if (panel === 'typography') {
    const activePreset =
      WEREAD_SPACING_PRESETS.find(
        p =>
          Math.abs(p.lineHeight - Number(s.lineHeight)) < 0.03 &&
          Math.abs(p.paraSpacing - Number(s.paraSpacing ?? 0.85)) < 0.05
      )?.id || ''
    panelHtml = `
      <div class="wr-dockPanel">
        <div class="wr-stepperBar">
          <button type="button" class="wr-stepBtn" data-font-step="-1">A-</button>
          <input type="range" min="14" max="32" step="1" value="${s.fontSize || 18}" data-typo="fontSize" style="flex:1;" />
          <span style="font-size:12px;font-weight:700;min-width:34px;text-align:center;">${s.fontSize || 18}</span>
          <button type="button" class="wr-stepBtn" data-font-step="1">A+</button>
        </div>
        <div class="wr-barRow">
          <span style="font-size:12px;color:var(--fg-muted);">字重粗细</span>
          <div class="wr-segGroup">
            ${[
              [400, '标准'],
              [450, '适中'],
              [500, '中粗'],
              [600, '加粗'],
            ]
              .map(
                ([w, label]) =>
                  `<button type="button" class="wr-segBtn ${(s.fontWeight || 400) === w ? 'active' : ''}" data-font-weight="${w}">${label}</button>`
              )
              .join('')}
          </div>
        </div>
        <div class="wr-fontGrid">
          ${WEREAD_FONTS.map(
            f => `
            <button type="button" class="wr-fontCard ${s.fontFamily === f.id ? 'active' : ''}" data-font="${f.id}">
              <span class="wr-fontCardTitle" style="font-family:${escapeHtml(f.stack)};">${escapeHtml(f.label)}</span>
              <span class="wr-fontCardSub">${escapeHtml(f.sub)}</span>
            </button>
          `
          ).join('')}
        </div>
        <div class="wr-barRow" style="flex-wrap:wrap;gap:6px;">
          <span style="font-size:12px;color:var(--fg-muted);">版面疏密</span>
          <div class="wr-segGroup">
            ${WEREAD_SPACING_PRESETS.map(
              p =>
                `<button type="button" class="wr-segBtn ${activePreset === p.id ? 'active' : ''}" data-spacing-preset="${p.id}">${p.label}</button>`
            ).join('')}
          </div>
          <div class="wr-segGroup">
            <button type="button" class="wr-segBtn ${s.textIndent ? 'active' : ''}" data-act="toggle-indent">首行缩进</button>
            <button type="button" class="wr-segBtn ${(s.textAlign || 'justify') === 'justify' ? 'active' : ''}" data-act="toggle-align">${(s.textAlign || 'justify') === 'justify' ? '两端对齐' : '左对齐'}</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;">
          <label class="wr-field" style="margin:0;">行距 ${s.lineHeight}
            <input type="range" min="1.35" max="2.35" step="0.05" value="${s.lineHeight}" data-typo="lineHeight" />
          </label>
          <label class="wr-field" style="margin:0;">段距 ${s.paraSpacing ?? 0.85}
            <input type="range" min="0.35" max="1.5" step="0.05" value="${s.paraSpacing ?? 0.85}" data-typo="paraSpacing" />
          </label>
          <label class="wr-field" style="margin:0;">边距 ${s.marginX}px
            <input type="range" min="10" max="42" step="2" value="${s.marginX}" data-typo="marginX" />
          </label>
        </div>
        <div class="wr-barRow" style="flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--fg-muted);">点击翻页热区</span>
          <div class="wr-segGroup" style="flex-wrap:wrap;">
            <button type="button" class="wr-segBtn ${tapMode === 'ergonomic' ? 'active' : ''}" data-tap-mode="ergonomic">单手拇指</button>
            <button type="button" class="wr-segBtn ${tapMode === 'classic' ? 'active' : ''}" data-tap-mode="classic">经典三区</button>
            <button type="button" class="wr-segBtn ${tapMode === 'bottomNext' ? 'active' : ''}" data-tap-mode="bottomNext">下半屏</button>
            <button type="button" class="wr-segBtn ${tapMode === 'keysOnly' ? 'active' : ''}" data-tap-mode="keysOnly">防误触</button>
          </div>
        </div>
      </div>
    `
  }

  host.innerHTML = `
    ${bannerHtml}
    <div class="wr-overlayTop">
      <button type="button" class="wr-btnGhost" data-act="back" style="padding:6px 10px;">‹ 书架</button>
      ${viewSegs}
      <div style="display:flex;gap:6px;">
        ${ctrl.reading.pdfLocationAvailable || ctrl.reading.pdfAvailable ? '<button type="button" class="wr-btnGhost" data-act="pdf" style="padding:6px 10px;">原页PDF</button>' : ''}
        <button type="button" class="wr-btnGhost" data-act="drawer" style="padding:6px 10px;">本段对照</button>
      </div>
    </div>
    <div class="wr-overlayBottom">
      ${panelHtml}
      <div class="wr-dockNav">
        <button type="button" class="wr-dockBtn" data-act="toc">
          <span class="wr-dockIcon">☰</span>
          <span>目录/笔记</span>
        </button>
        <button type="button" class="wr-dockBtn ${panel === 'progress' ? 'active' : ''}" data-dock-panel="progress">
          <span class="wr-dockIcon">⇄</span>
          <span>进度/版式</span>
        </button>
        <button type="button" class="wr-dockBtn ${panel === 'theme' ? 'active' : ''}" data-dock-panel="theme">
          <span class="wr-dockIcon">◐</span>
          <span>背景/亮度</span>
        </button>
        <button type="button" class="wr-dockBtn ${panel === 'typography' ? 'active' : ''}" data-dock-panel="typography">
          <span class="wr-dockIcon">Aa</span>
          <span>字体/排版</span>
        </button>
      </div>
    </div>
  `

  bindBanner(ctrl, host)
  host.querySelector('[data-act="back"]').onclick = () => ctrl.onExit()
  host.querySelectorAll('[data-view]').forEach(btn => {
    btn.onclick = () => {
      const nextView = btn.dataset.view
      if (nextView === ctrl.viewMode) return
      const anchor = ctrl.currentTopBlockId()
      ctrl.viewMode = nextView
      ctrl.pendingBlockId = anchor
      ctrl.barsVisible = false
      ctrl.render()
      ctrl.scheduleSaveProgress()
    }
  })
  host.querySelectorAll('[data-dock-panel]').forEach(btn => {
    btn.onclick = () => {
      ctrl.activeBottomPanel = btn.dataset.dockPanel
      ctrl.renderChrome()
    }
  })
  host.querySelector('[data-act="toc"]').onclick = () => {
    ctrl.barsVisible = false
    ctrl.activeSheet = 'toc'
    const items = ctrl.outlineItems()
    const currentBlock = ctrl.currentTopBlockId()
    const activeIdx = Math.max(0, items.findIndex(it => it.id === currentBlock))
    ctrl.tocPage = Math.floor(activeIdx / 10)
    ctrl.renderChrome()
    ctrl.renderSheet()
  }
  const pdfBtn = host.querySelector('[data-act="pdf"]')
  if (pdfBtn) {
    pdfBtn.onclick = () => {
      const block = ctrl.visibleBlocks().find(b => b.id === ctrl.currentTopBlockId())
      ctrl.barsVisible = false
      ctrl.renderChrome()
      ctrl.openPdfViewer(block?.pdfPage || 1)
    }
  }
  host.querySelector('[data-act="drawer"]').onclick = () => {
    const id = ctrl.currentTopBlockId() || ctrl.visibleBlocks()[0]?.id
    ctrl.barsVisible = false
    ctrl.renderChrome()
    if (id) ctrl.openBilingualDrawer(id)
  }
  host.querySelector('[data-act="prev-chapter"]')?.addEventListener('click', () => ctrl.prevChapter())
  host.querySelector('[data-act="next-chapter"]')?.addEventListener('click', () => ctrl.nextChapter())
  const scrub = host.querySelector('[data-act="scrub"]')
  if (scrub) {
    scrub.oninput = () => {
      ctrl.currentPage = Math.max(0, Math.min(ctrl.totalPages - 1, Number(scrub.value) - 1))
      ctrl.applyPageTransform()
    }
    scrub.onchange = () => {
      ctrl.scheduleSaveProgress()
      ctrl.renderChrome()
    }
  }
  host.querySelectorAll('[data-pagemode]').forEach(btn => {
    btn.onclick = async () => {
      const mode = btn.dataset.pagemode
      const anchor = ctrl.currentTopBlockId()
      if (mode === 'scroll') {
        ctrl.settings = await ctrl.onSettingsChange({ pageMode: 'scroll' })
      } else {
        ctrl.settings = await ctrl.onSettingsChange({ pageMode: 'paginated', pageTransition: mode })
      }
      ctrl.pendingBlockId = anchor
      ctrl.render()
    }
  })
  host.querySelectorAll('[data-theme-pick]').forEach(btn => {
    btn.onclick = async () => {
      const t = btn.dataset.themePick
      ctrl.settings = await ctrl.onSettingsChange({ theme: t, deviceMode: t === 'eink' ? 'eink' : 'phone' })
      ctrl.applyTypographyVars()
      ctrl.renderPageTurnBar()
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
  host.querySelector('[data-act="eink"]')?.addEventListener('click', async () => {
    const toEink = ctrl.settings.theme !== 'eink'
    ctrl.settings = await ctrl.onSettingsChange({
      theme: toEink ? 'eink' : 'paper',
      deviceMode: toEink ? 'eink' : 'phone',
    })
    ctrl.applyTypographyVars()
    ctrl.renderPageTurnBar()
    ctrl.recomputeLayout(true)
    ctrl.renderChrome()
  })
  host.querySelectorAll('[data-font-step]').forEach(btn => {
    btn.onclick = async () => {
      const delta = Number(btn.dataset.fontStep)
      const nextSize = Math.max(14, Math.min(32, (Number(ctrl.settings.fontSize) || 18) + delta))
      ctrl.settings = await ctrl.onSettingsChange({ fontSize: nextSize })
      ctrl.applyTypographyVars()
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
  host.querySelectorAll('[data-font-weight]').forEach(btn => {
    btn.onclick = async () => {
      ctrl.settings = await ctrl.onSettingsChange({ fontWeight: Number(btn.dataset.fontWeight) })
      ctrl.applyTypographyVars()
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
  host.querySelectorAll('[data-font]').forEach(btn => {
    btn.onclick = async () => {
      ctrl.settings = await ctrl.onSettingsChange({ fontFamily: btn.dataset.font })
      ctrl.applyTypographyVars()
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
  host.querySelectorAll('[data-spacing-preset]').forEach(btn => {
    btn.onclick = async () => {
      const preset = WEREAD_SPACING_PRESETS.find(p => p.id === btn.dataset.spacingPreset)
      if (!preset) return
      ctrl.settings = await ctrl.onSettingsChange({
        lineHeight: preset.lineHeight,
        paraSpacing: preset.paraSpacing,
        marginX: preset.marginX,
      })
      ctrl.applyTypographyVars()
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
  host.querySelector('[data-act="toggle-indent"]')?.addEventListener('click', async () => {
    ctrl.settings = await ctrl.onSettingsChange({ textIndent: !ctrl.settings.textIndent })
    ctrl.applyTypographyVars()
    ctrl.recomputeLayout(true)
    ctrl.renderChrome()
  })
  host.querySelector('[data-act="toggle-align"]')?.addEventListener('click', async () => {
    const next = (ctrl.settings.textAlign || 'justify') === 'justify' ? 'left' : 'justify'
    ctrl.settings = await ctrl.onSettingsChange({ textAlign: next })
    ctrl.applyTypographyVars()
    ctrl.recomputeLayout(true)
    ctrl.renderChrome()
  })
  host.querySelectorAll('[data-typo]').forEach(inp => {
    inp.oninput = () => {
      const k = inp.dataset.typo
      if (k === 'brightness') {
        ctrl.settings.brightness = Number(inp.value)
        ctrl.applyTypographyVars()
      }
    }
    inp.onchange = async () => {
      ctrl.settings = await ctrl.onSettingsChange({ [inp.dataset.typo]: Number(inp.value) })
      ctrl.applyTypographyVars()
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
  host.querySelectorAll('[data-col-layout]').forEach(btn => {
    btn.onclick = async () => {
      ctrl.settings = await ctrl.onSettingsChange({ columnLayout: btn.dataset.colLayout })
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
  host.querySelectorAll('[data-bi-layout]').forEach(btn => {
    btn.onclick = async () => {
      ctrl.settings = await ctrl.onSettingsChange({ bilingualLayout: btn.dataset.biLayout })
      ctrl.pendingBlockId = ctrl.currentTopBlockId()
      ctrl.renderBlocks()
      ctrl.renderChrome()
    }
  })
  host.querySelectorAll('[data-tap-mode]').forEach(btn => {
    btn.onclick = async () => {
      ctrl.settings = await ctrl.onSettingsChange({ tapZoneMode: btn.dataset.tapMode })
      ctrl.renderPageTurnBar()
      ctrl.recomputeLayout(true)
      ctrl.renderChrome()
    }
  })
}
