import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_STYLES,
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
  const hasHighlight = existing.length > 0
  const activeColor = existing[0]?.color || ctrl.settings.highlightColor || 'gold'

  host.innerHTML = `
    <div class="wr-selectionCapsule wr-capsuleStack" style="left:${ctrl.selectionInfo.left}px;top:${ctrl.selectionInfo.top}px;">
      <div class="wr-capRow">
        ${hasHighlight ? '<button type="button" class="wr-capsuleBtn" data-cap="remove">取消划线</button>' : ''}
        ${HIGHLIGHT_STYLES.map(st => `<button type="button" class="wr-capsuleBtn" data-cap-style="${st.id}">${st.label}</button>`).join('')}
        <button type="button" class="wr-capsuleBtn" data-cap="note">写想法</button>
        <button type="button" class="wr-capsuleBtn" data-cap="original">看原文</button>
        <button type="button" class="wr-capsuleBtn" data-cap="correct">纠错</button>
        <button type="button" class="wr-capsuleBtn" data-cap="copy">复制</button>
      </div>
      <div class="wr-capColors">
        ${HIGHLIGHT_COLORS.map(c => `<button type="button" class="wr-capDot ${activeColor === c.id ? 'active' : ''}" data-cap-color="${c.id}" style="background:${c.hex};" title="${c.label}"></button>`).join('')}
      </div>
    </div>
  `

  const applyHighlight = async (style, color) => {
    const sel = ctrl.selectionInfo
    if (!sel) return
    ctrl.settings = await ctrl.onSettingsChange({ highlightStyle: style, highlightColor: color })
    const primary = existing[0]
    if (primary?.id) {
      await readerApi.postBookmarkAction(ctrl.settings, { updateBookmark: { id: primary.id, style, color } })
      primary.style = style
      primary.color = color
    } else {
      const created = await readerApi.postBookmarkAction(ctrl.settings, {
        source: { kind: 'task', id: ctrl.taskId },
        selection: sel,
        highlightOnly: true,
        style,
        color,
      })
      ctrl.marks.push({
        id: created?.id || 'local-' + Date.now(),
        kind: 'highlight',
        style,
        color,
        view: sel.view,
        blockId: sel.startBlockId,
        quote: sel.exact,
        exact: sel.exact,
      })
    }
    await offlineDb.saveMarks(ctrl.taskId, ctrl.marks)
    ctrl.clearSelection()
    ctrl.renderBlocks()
    ctrl.onToast('已保存划线')
  }

  host.querySelector('[data-cap="remove"]')?.addEventListener('click', async () => {
    for (const m of existing) {
      await readerApi.postBookmarkAction(
        ctrl.settings,
        m.kind === 'bookmark' ? { muteHighlight: m.id } : { removeHighlight: m.id }
      )
    }
    const rmIds = new Set(existing.map(m => m.id))
    ctrl.marks = ctrl.marks.filter(m => !rmIds.has(m.id))
    await offlineDb.saveMarks(ctrl.taskId, ctrl.marks)
    ctrl.clearSelection()
    ctrl.renderBlocks()
    ctrl.onToast('已取消划线')
  })

  host.querySelectorAll('[data-cap-style]').forEach(btn => {
    btn.onclick = () => applyHighlight(btn.dataset.capStyle, activeColor)
  })

  host.querySelectorAll('[data-cap-color]').forEach(btn => {
    btn.onclick = async () => {
      const nextColor = btn.dataset.capColor
      const style = existing[0]?.style || ctrl.settings.highlightStyle || 'highlight'
      await applyHighlight(style, nextColor)
    }
  })

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

const dockSvg = name => {
  const s = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"'
  if (name === 'toc') return `<svg ${s}><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`
  if (name === 'progress') return `<svg ${s}><circle cx="12" cy="12" r="9"/><polygon points="10 14 12 8 14 14 10 14"/></svg>`
  if (name === 'theme') return `<svg ${s}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`
  return `<span style="font-size:17px;font-weight:700;line-height:20px;letter-spacing:-0.02em;">Aa</span>`
}

const pillPercent = (val, min, max) => Math.max(0, Math.min(100, ((Number(val) - min) / (max - min)) * 100)).toFixed(1)

const renderPillSliderHtml = ({ typo, left, center, right, min, max, step, val }) => {
  const pct = pillPercent(val, min, max)
  return `
    <div class="wr-pillSlider" data-pill-for="${typo}">
      <span class="wr-pillEdge wr-pillEdgeL">${left}</span>
      <div class="wr-pillInner">
        <div class="wr-pillThumb" data-thumb-for="${typo}" style="left:${pct}%;transform:translate(-${pct}%,-50%);">${center}</div>
      </div>
      <span class="wr-pillEdge wr-pillEdgeR">${right}</span>
      <input type="range" class="wr-pillRange" min="${min}" max="${max}" step="${step}" value="${val}" data-typo="${typo}" data-min="${min}" data-max="${max}" />
    </div>
  `
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
    ctrl.typoSubView = 'main'
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
        <div data-role="scrub-label" style="text-align:center;font-size:12px;color:var(--fg-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
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
    const sub = ctrl.typoSubView || 'main'
    const fontObj = WEREAD_FONTS.find(f => f.id === (s.fontFamily || 'serif')) || WEREAD_FONTS[0]
    const activePreset = WEREAD_SPACING_PRESETS.find(
      p => Math.abs(p.lineHeight - Number(s.lineHeight)) < 0.04 && Math.abs(p.paraSpacing - Number(s.paraSpacing ?? 0.68)) < 0.08
    )?.id || ''
    const letterVal = Number(s.letterSpacing ?? 0.015)

    if (sub === 'fonts') {
      const fontCat = ctrl.fontCat || 'all'
      const shownFonts = WEREAD_FONTS.filter(f => fontCat === 'all' || f.cat === fontCat)
      panelHtml = `
        <div class="wr-dockPanel wr-dockCompact">
          <div class="wr-subHead">
            <button type="button" class="wr-btnGhost" data-typo-sub="main" style="padding:4px 10px;font-size:12px;">‹ 返回</button>
            <strong style="font-size:13px;">字体与字重</strong>
            <div class="wr-segGroup">
              ${[[400, '标准'], [450, '适中'], [500, '中粗'], [600, '加粗']].map(([w, lbl]) => `<button type="button" class="wr-segBtn ${(s.fontWeight || 450) === w ? 'active' : ''}" data-font-weight="${w}">${lbl}</button>`).join('')}
            </div>
          </div>
          <div class="wr-barRow" style="gap:6px;">
            <div class="wr-segGroup" style="width:100%;display:flex;">
              ${[['all', '全部'], ['serif', '宋体'], ['kaiti', '楷仿'], ['sans', '黑圆'], ['western', '西文']].map(([cid, clabel]) => `<button type="button" class="wr-segBtn ${fontCat === cid ? 'active' : ''}" data-font-cat="${cid}" style="flex:1;padding:5px 4px;">${clabel}</button>`).join('')}
            </div>
          </div>
          <div class="wr-fontGrid" style="max-height:210px;overflow-y:auto;">
            ${shownFonts.map(f => `
              <button type="button" class="wr-fontCard ${s.fontFamily === f.id ? 'active' : ''}" data-font="${f.id}">
                <span class="wr-fontCardTitle" style="font-family:${escapeHtml(f.stack)};">${escapeHtml(f.label)}</span>
                <span class="wr-fontCardSub">${escapeHtml(f.sub)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `
    } else if (sub === 'layout') {
      panelHtml = `
        <div class="wr-dockPanel wr-dockCompact">
          <div class="wr-subHead">
            <button type="button" class="wr-btnGhost" data-typo-sub="main" style="padding:4px 10px;font-size:12px;">‹ 返回</button>
            <strong style="font-size:13px;">排版与疏密精调</strong>
            <div class="wr-segGroup">
              <button type="button" class="wr-segBtn ${s.textIndent ? 'active' : ''}" data-act="toggle-indent">首行缩进</button>
              <button type="button" class="wr-segBtn ${(s.textAlign || 'justify') === 'justify' ? 'active' : ''}" data-act="toggle-align">${(s.textAlign || 'justify') === 'justify' ? '两端对齐' : '左对齐'}</button>
            </div>
          </div>
          <div class="wr-barRow" style="gap:6px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--fg-muted);">疏密预设</span>
            <div class="wr-segGroup" style="flex:1;display:flex;">
              ${WEREAD_SPACING_PRESETS.map(p => `<button type="button" class="wr-segBtn ${activePreset === p.id ? 'active' : ''}" data-spacing-preset="${p.id}" style="flex:1;padding:5px 4px;">${p.label}</button>`).join('')}
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;">
            <label class="wr-field" style="margin:0;">字距 <span data-val-for="letterSpacing">${letterVal.toFixed(3)}em</span>
              <input type="range" min="-0.02" max="0.08" step="0.005" value="${letterVal}" data-typo="letterSpacing" />
            </label>
            <label class="wr-field" style="margin:0;">段距 <span data-val-for="paraSpacing">${Number(s.paraSpacing ?? 0.68).toFixed(2)}em</span>
              <input type="range" min="0.25" max="1.5" step="0.05" value="${s.paraSpacing ?? 0.68}" data-typo="paraSpacing" />
            </label>
          </div>
        </div>
      `
    } else if (sub === 'turn') {
      panelHtml = `
        <div class="wr-dockPanel wr-dockCompact">
          <div class="wr-subHead">
            <button type="button" class="wr-btnGhost" data-typo-sub="main" style="padding:4px 10px;font-size:12px;">‹ 返回</button>
            <strong style="font-size:13px;">翻页方式与触控热区</strong>
            <span style="font-size:11px;color:var(--fg-muted);">${s.pageMode === 'scroll' ? '上下滚动' : s.pageTransition === 'none' ? '瞬切翻页' : '平滑平移'}</span>
          </div>
          <div class="wr-barRow" style="gap:6px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--fg-muted);">翻页动效</span>
            <div class="wr-segGroup">
              <button type="button" class="wr-segBtn ${s.pageMode === 'paginated' && s.pageTransition !== 'none' ? 'active' : ''}" data-pagemode="slide">平滑平移</button>
              <button type="button" class="wr-segBtn ${s.pageMode === 'paginated' && s.pageTransition === 'none' ? 'active' : ''}" data-pagemode="none">瞬切无动画</button>
              <button type="button" class="wr-segBtn ${s.pageMode === 'scroll' ? 'active' : ''}" data-pagemode="scroll">上下滚动</button>
            </div>
          </div>
          <div class="wr-barRow" style="gap:6px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--fg-muted);">点击热区</span>
            <div class="wr-segGroup" style="flex-wrap:wrap;">
              <button type="button" class="wr-segBtn ${tapMode === 'ergonomic' ? 'active' : ''}" data-tap-mode="ergonomic">单手拇指</button>
              <button type="button" class="wr-segBtn ${tapMode === 'classic' ? 'active' : ''}" data-tap-mode="classic">经典三区</button>
              <button type="button" class="wr-segBtn ${tapMode === 'bottomNext' ? 'active' : ''}" data-tap-mode="bottomNext">下半屏</button>
              <button type="button" class="wr-segBtn ${tapMode === 'keysOnly' ? 'active' : ''}" data-tap-mode="keysOnly">防误触</button>
            </div>
          </div>
        </div>
      `
    } else {
      const turnLabel = s.pageMode === 'scroll' ? '上下滚动' : s.pageTransition === 'none' ? '瞬切翻页' : '平滑翻页'
      panelHtml = `
        <div class="wr-dockPanel wr-dockCompact wr-weReadTypoMain">
          ${renderPillSliderHtml({ typo: 'fontSize', left: 'A', center: String(s.fontSize || 19), right: 'A', min: 14, max: 32, step: 1, val: s.fontSize || 19 })}
          <div class="wr-dualPillRow">
            ${renderPillSliderHtml({ typo: 'marginX', left: '小', center: '边距', right: '大', min: 10, max: 42, step: 2, val: s.marginX || 22 })}
            ${renderPillSliderHtml({ typo: 'lineHeight', left: '紧', center: '行距', right: '松', min: 1.35, max: 2.35, step: 0.05, val: s.lineHeight || 1.85 })}
          </div>
          <div class="wr-pillActionRow">
            <button type="button" class="wr-actionPill" data-typo-sub="fonts" style="font-family:${escapeHtml(fontObj.stack)};"><span>${escapeHtml(fontObj.label)}${(s.fontWeight || 450) >= 500 ? ' · 粗' : ''}</span><span class="wr-chev">›</span></button>
            <button type="button" class="wr-actionPill ${s.textIndent ? 'active-soft' : ''}" data-typo-sub="layout"><span>${s.textIndent ? '首行缩进 ✓' : '无缩进 · 版式'}</span><span class="wr-chev">›</span></button>
            <button type="button" class="wr-actionPill" data-typo-sub="turn"><span>${turnLabel}</span><span class="wr-chev">›</span></button>
          </div>
        </div>
      `
    }
  }

  host.innerHTML = `
    ${bannerHtml}
    <div class="wr-overlayTop">
      <button type="button" class="wr-btnGhost" data-act="back" style="padding:5px 10px;font-size:12.5px;">‹ 书架</button>
      ${viewSegs}
      <div style="display:flex;gap:5px;">
        <button type="button" class="wr-btnGhost" data-act="search-book" style="padding:5px 8px;font-size:13px;" title="全书搜索">🔍</button>
        ${ctrl.reading.pdfLocationAvailable || ctrl.reading.pdfAvailable ? '<button type="button" class="wr-btnGhost" data-act="pdf" style="padding:5px 9px;font-size:12px;">PDF</button>' : ''}
        <button type="button" class="wr-btnGhost" data-act="drawer" style="padding:5px 9px;font-size:12px;">对照</button>
      </div>
    </div>
    <div class="wr-overlayBottom">
      ${panelHtml}
      <div class="wr-dockNav">
        <button type="button" class="wr-dockBtn" data-act="toc">
          <span class="wr-dockIcon">${dockSvg('toc')}</span>
          <span>目录</span>
        </button>
        <button type="button" class="wr-dockBtn ${panel === 'progress' ? 'active' : ''}" data-dock-panel="progress">
          <span class="wr-dockIcon">${dockSvg('progress')}</span>
          <span>进度</span>
        </button>
        <button type="button" class="wr-dockBtn ${panel === 'theme' ? 'active' : ''}" data-dock-panel="theme">
          <span class="wr-dockIcon">${dockSvg('theme')}</span>
          <span>背景</span>
        </button>
        <button type="button" class="wr-dockBtn ${panel === 'typography' ? 'active' : ''}" data-dock-panel="typography">
          <span class="wr-dockIcon">${dockSvg('typo')}</span>
          <span>排版</span>
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
  host.querySelector('[data-act="search-book"]')?.addEventListener('click', () => {
    ctrl.barsVisible = false
    ctrl.renderChrome()
    ctrl.openSearchSheet()
  })
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
      const lbl = host.querySelector('[data-role="scrub-label"]')
      if (lbl) {
        const pct = Math.min(100, Math.max(1, Math.round(((ctrl.currentPage + 1) / Math.max(1, ctrl.totalPages)) * 100)))
        lbl.textContent = `${ctrl.currentChapterLabel()} · 第 ${ctrl.currentPage + 1}/${ctrl.totalPages} 页 (${pct}%)`
      }
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
  host.querySelectorAll('[data-font-cat]').forEach(btn => {
    btn.onclick = () => {
      ctrl.fontCat = btn.dataset.fontCat
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
        letterSpacing: preset.letterSpacing ?? 0.01,
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
  host.querySelectorAll('[data-typo-sub]').forEach(btn => {
    btn.onclick = () => {
      ctrl.typoSubView = btn.dataset.typoSub
      ctrl.renderChrome()
    }
  })
  host.querySelectorAll('[data-typo]').forEach(inp => {
    inp.oninput = () => {
      const k = inp.dataset.typo
      const val = Number(inp.value)
      ctrl.settings[k] = val
      const isEink = ctrl.settings.deviceMode === 'eink' || ctrl.settings.theme === 'eink'
      if (!isEink || k === 'brightness') {
        ctrl.applyTypographyVars()
        if (k === 'marginX') document.documentElement.style.setProperty('--reader-pad-x', `${val}px`)
      }
      const thumb = host.querySelector(`[data-thumb-for="${k}"]`)
      if (thumb && inp.dataset.min !== undefined) {
        const pct = pillPercent(val, Number(inp.dataset.min), Number(inp.dataset.max))
        thumb.style.left = `${pct}%`
        thumb.style.transform = `translate(-${pct}%,-50%)`
        if (k === 'fontSize') thumb.textContent = String(Math.round(val))
      }
      const valSpan = host.querySelector(`[data-val-for="${k}"]`)
      if (valSpan) valSpan.textContent = `${val.toFixed(k === 'letterSpacing' ? 3 : 2)}em`
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
