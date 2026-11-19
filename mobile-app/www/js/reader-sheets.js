import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_STYLES,
  escapeHtml,
  plainText,
  renderSearchSnippetHtml,
  searchBookContent,
  validateCorrectionMarkers,
} from './reading-core.js'
import { readerApi } from './api.js'
import { offlineDb } from './offline-db.js'

export function renderReaderSheet(ctrl, host) {
  if (!host) return
  if (!ctrl.activeSheet) {
    host.innerHTML = ''
    return
  }

  if (ctrl.activeSheet === 'pdf') {
    const p = ctrl.pdfState
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
          ${
            p.loading
              ? '<p>正在渲染原书 PDF 页面...</p>'
              : p.error
              ? `<p style="color:#dc2626;">${escapeHtml(p.error)}</p>`
              : p.fallbackPdfUrl
              ? `<div style="width:100%;height:100%;display:flex;flex-direction:column;">
                  <div class="wr-barRow" style="padding:8px 12px;background:var(--surface);border-bottom:1px solid var(--border);justify-content:space-between;">
                    <span style="font-size:12px;color:var(--fg-muted);">已加载完整原 PDF 离线副本</span>
                    <a class="wr-btnPrimary" href="${p.fallbackPdfUrl}" download="source-${escapeHtml(ctrl.taskId)}.pdf" target="_blank" rel="noopener noreferrer" style="padding:4px 10px;font-size:12px;text-decoration:none;">外部打开 / 保存 PDF</a>
                  </div>
                  <iframe src="${p.fallbackPdfUrl}#page=${p.page}" style="width:100%;flex:1;border:none;"></iframe>
                </div>`
              : `<img class="wr-pdfPageImg" src="${p.imgUrl}" style="width:${p.zoom}%;max-width:none;" />`
          }
        </div>
      </div>
    `
    host.querySelector('[data-act="close"]').onclick = () => ctrl.closeSheet()
    host.querySelector('[data-pdf="prev"]').onclick = () => {
      if (p.page > 1) ctrl.loadPdfPage(p.page - 1)
    }
    host.querySelector('[data-pdf="next"]').onclick = () => ctrl.loadPdfPage(p.page + 1)
    host.querySelector('[data-pdf="zoom"]').onclick = () => {
      p.zoom = p.zoom === 100 ? 150 : p.zoom === 150 ? 200 : 100
      ctrl.renderSheet()
    }
    const wrap = host.querySelector('.wr-pdfCanvasWrap')
    if (wrap) {
      let sx = 0, sy = 0
      wrap.addEventListener('touchstart', e => {
        if (p.zoom === 100 && e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY }
      }, { passive: true })
      wrap.addEventListener('touchend', e => {
        if (p.zoom !== 100 || !sx) return
        const t = e.changedTouches[0]
        const dx = (t?.clientX ?? sx) - sx, dy = (t?.clientY ?? sy) - sy
        sx = 0
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          if (dx < 0) ctrl.loadPdfPage(p.page + 1)
          else if (p.page > 1) ctrl.loadPdfPage(p.page - 1)
        }
      }, { passive: true })
    }
    return
  }

  let inner = ''
  if (ctrl.activeSheet === 'toc') {
    const currentBlock = ctrl.currentTopBlockId()
    const items = ctrl.outlineItems()
    const subTab = ctrl.tocSubTab === 'marks' ? 'marks' : 'outline'
    const usePagination = ctrl.settings.deviceMode === 'eink' || ctrl.settings.theme === 'eink' || items.length > 12
    const pageSize = 10
    ctrl.tocTotalPages = usePagination ? Math.max(1, Math.ceil(items.length / pageSize)) : 1
    ctrl.tocPage = Math.max(0, Math.min(ctrl.tocTotalPages - 1, ctrl.tocPage))
    const slice = usePagination ? items.slice(ctrl.tocPage * pageSize, (ctrl.tocPage + 1) * pageSize) : items

    let tabBody = ''
    if (subTab === 'outline') {
      tabBody = `
        <div>
          ${
            slice.length
              ? slice
                  .map(
                    it => `
            <button type="button" class="wr-tocItem ${it.id === currentBlock ? 'active' : ''}" data-toc-id="${escapeHtml(it.id)}" style="padding-left:${(it.level - 1) * 14 + 6}px;">
              ${escapeHtml(it.label)}
            </button>
          `
                  )
                  .join('')
              : '<p style="color:var(--fg-muted);font-size:13px;">本文档暂无目录结构</p>'
          }
        </div>
        ${
          usePagination && ctrl.tocTotalPages > 1
            ? `
          <div class="wr-einkPager">
            <button type="button" class="wr-btnGhost" data-toc-page="prev" ${ctrl.tocPage <= 0 ? 'disabled' : ''}>‹ 上一章页</button>
            <span style="font-size:12px;color:var(--fg-muted);">第 ${ctrl.tocPage + 1} / ${ctrl.tocTotalPages} 页</span>
            <button type="button" class="wr-btnGhost" data-toc-page="next" ${ctrl.tocPage >= ctrl.tocTotalPages - 1 ? 'disabled' : ''}>下一章页 ›</button>
          </div>
        `
            : ''
        }
      `
    } else {
      tabBody = `
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${
            ctrl.marks.length
              ? ctrl.marks
                  .map(
                    m => `
            <div class="wr-card" style="margin:0;padding:10px 12px;cursor:pointer;" data-toc-id="${escapeHtml(m.blockId)}">
              <blockquote class="wr-quoteBox" style="margin-bottom:${m.comment ? '6px' : '0'};">${escapeHtml(m.quote)}</blockquote>
              ${m.comment ? `<p style="margin:0;font-size:13px;line-height:1.5;">💭 ${escapeHtml(m.comment)}</p>` : ''}
            </div>
          `
                  )
                  .join('')
              : '<p style="color:var(--fg-muted);font-size:13px;text-align:center;margin:16px 0;">本书暂无划线或想法</p>'
          }
        </div>
      `
    }

    const tocQ = String(ctrl.tocSearch || '').trim()
    const pct = ctrl.totalPages > 0 ? Math.min(100, Math.round(((ctrl.currentPage + 1) / ctrl.totalPages) * 100)) : 0
    const buildTocBody = () => {
      if (tocQ) {
        const res = searchBookContent(ctrl.reading, tocQ, { maxMatches: 80 })
        if (!res.matches.length) return '<p style="color:var(--fg-muted);font-size:13px;padding:12px 0;">未在本书中找到匹配内容</p>'
        return `<div style="display:flex;flex-direction:column;gap:6px;">
          <div style="font-size:11.5px;color:var(--fg-muted);">共 ${res.totalMatches} 处匹配</div>
          ${res.matches.map(h => `<button type="button" class="wr-searchHitCard" data-toc-hit="${escapeHtml(h.blockId)}" data-toc-view="${escapeHtml(h.view)}">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span class="wr-searchTag">${h.view === 'original' ? '原文' : '译文'}</span>${h.chapterLabel ? `<span class="wr-searchChapter">${escapeHtml(h.chapterLabel)}</span>` : ''}</div>
            <div class="wr-searchSnippetText">${renderSearchSnippetHtml(h.snippet, h.matchOffset, h.matchLen)}</div>
          </button>`).join('')}
        </div>`
      }
      return tabBody
    }

    inner = `
      <div class="wr-barRow" style="gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ctrl.reading.title || '阅读目录')}</div>
          <div style="font-size:11px;color:var(--fg-muted);">已读 ${pct}% · 共 ${ctrl.marks.length} 条划线笔记</div>
        </div>
        <button type="button" class="wr-btnGhost" data-toc-bm="1" style="padding:4px 9px;font-size:12px;">+ 书签</button>
        <button type="button" class="wr-btnGhost" data-act="close" style="padding:4px 10px;">关闭</button>
      </div>
      <div class="wr-barRow" style="gap:6px;">
        <input type="search" class="wr-input" data-toc-search="1" value="${escapeHtml(ctrl.tocSearch || '')}" placeholder="在目录内直接搜索本书内容..." style="flex:1;padding:6px 10px;font-size:12.5px;" />
      </div>
      <div class="wr-tocTabs">
        <button type="button" class="wr-tocTab ${subTab === 'outline' && !tocQ ? 'active' : ''}" data-toc-tab="outline">目录 (${items.length})</button>
        <button type="button" class="wr-tocTab ${subTab === 'marks' && !tocQ ? 'active' : ''}" data-toc-tab="marks">划线 (${ctrl.marks.length})</button>
      </div>
      <div data-role="toc-body">${buildTocBody()}</div>
    `
  } else if (ctrl.activeSheet === 'drawer') {
    const b = ctrl.sheetData.block
    const transText = ctrl.reading.standaloneView === 'translation' ? b.text : (b.translation ?? b.text)
    const origText = b.sourceText ?? b.text
    inner = `
      <div class="wr-barRow">
        <h3 style="margin:0;font-size:16px;">双语对照${b.pdfPage ? ` · 原书第 ${b.pdfPage} 页` : ''}</h3>
        <button type="button" class="wr-btnGhost" data-act="close">关闭</button>
      </div>
      ${ctrl.hasTranslation ? `<div><div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">译文</div><p style="margin:0;line-height:1.65;">${escapeHtml(plainText(transText))}</p></div>` : ''}
      <div><div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">原文</div><p style="margin:0;line-height:1.65;color:var(--fg-muted);">${escapeHtml(plainText(origText))}</p></div>
      <div class="wr-barRow" style="margin-top:4px;">
        <button type="button" class="wr-btnGhost" data-act="correct-from-drawer">段落纠错</button>
        ${b.pdfPage ? `<button type="button" class="wr-btnPrimary" data-act="open-pdf-page">查看原 PDF 第 ${b.pdfPage} 页</button>` : ''}
      </div>
    `
  } else if (ctrl.activeSheet === 'footnote') {
    const d = ctrl.sheetData
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
  } else if (ctrl.activeSheet === 'noteEditor') {
    const sel = ctrl.sheetData.selection
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
  } else if (ctrl.activeSheet === 'correction') {
    const d = ctrl.sheetData
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
  } else if (ctrl.activeSheet === 'search') {
    const q = String(ctrl.searchQuery ?? '')
    inner = `
      <div class="wr-barRow">
        <h3 style="margin:0;font-size:16px;">全书内容搜索</h3>
        <button type="button" class="wr-btnGhost" data-act="close">关闭</button>
      </div>
      <div class="wr-barRow" style="gap:6px;">
        <input type="search" class="wr-input" data-book-search="1" value="${escapeHtml(q)}" placeholder="搜索本书原文或译文内容..." style="flex:1;" />
        ${q ? '<button type="button" class="wr-btnGhost" data-clear-search="1" style="padding:6px 10px;font-size:12px;">清空</button>' : ''}
      </div>
      <div data-role="book-search-status" style="font-size:12px;color:var(--fg-muted);"></div>
      <div data-role="book-search-list" style="display:flex;flex-direction:column;gap:8px;"></div>
    `
  } else if (ctrl.activeSheet === 'markDetail') {
    const tokens = String(ctrl.sheetData?.ids || '').split(',').filter(Boolean)
    const ids = new Set(tokens.map(tok => { const cut = tok.lastIndexOf(':'); return cut >= 0 ? tok.slice(0, cut) : tok }))
    const matched = (ctrl.marks || []).filter(m => ids.has(m.id))
    inner = `
      <div class="wr-barRow">
        <h3 style="margin:0;font-size:16px;">划线与想法</h3>
        <button type="button" class="wr-btnGhost" data-act="close">关闭</button>
      </div>
      ${matched.length ? matched.map(m => {
        const curStyle = m.style || 'highlight'
        const curColor = m.color || 'gold'
        return `
        <div class="wr-card" style="margin:0;display:flex;flex-direction:column;gap:8px;" data-mark-card="${escapeHtml(m.id)}">
          <div style="font-size:11px;color:var(--fg-muted);">${m.view === 'original' ? '原文' : '译文'} · ${m.kind === 'bookmark' ? '想法/书签' : '划线'}</div>
          <blockquote class="wr-quoteBox" style="margin:0;">${escapeHtml(m.quote || m.exact || '')}</blockquote>
          <div class="wr-barRow" style="flex-wrap:wrap;gap:6px;">
            <div class="wr-segGroup">
              ${HIGHLIGHT_STYLES.map(st => `<button type="button" class="wr-segBtn ${curStyle === st.id ? 'active' : ''}" data-mk-style="${st.id}" data-mk-id="${escapeHtml(m.id)}">${st.label}</button>`).join('')}
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${HIGHLIGHT_COLORS.map(c => `<button type="button" class="wr-markColorSwatch ${curColor === c.id ? 'active' : ''}" data-mk-color="${c.id}" data-mk-id="${escapeHtml(m.id)}" style="background:${c.hex};" title="${c.label}"></button>`).join('')}
            </div>
          </div>
          <textarea class="wr-textarea" data-mark-comment="${escapeHtml(m.id)}" placeholder="写下或修改想法批注..." style="min-height:76px;">${escapeHtml(m.comment || '')}</textarea>
          <div class="wr-barRow" style="justify-content:flex-end;gap:8px;">
            <button type="button" class="wr-btnGhost" data-del-mark="${escapeHtml(m.id)}" data-del-kind="${escapeHtml(m.kind || 'highlight')}" style="color:#dc2626;padding:5px 12px;font-size:12px;">取消划线</button>
            <button type="button" class="wr-btnPrimary" data-save-mark="${escapeHtml(m.id)}" style="padding:5px 12px;font-size:12px;">保存想法</button>
          </div>
        </div>
      `
      }).join('') : '<p style="color:var(--fg-muted);font-size:13px;">未找到该划线记录</p>'}
    `
  }

  const dockSide = Boolean(ctrl.layoutInfo?.dockSideSheet)
  host.innerHTML = `<div class="wr-sheetBackdrop ${dockSide ? 'dock-side' : ''}" data-backdrop="1"><div class="wr-sheet">${inner}</div></div>`
  host.querySelector('[data-backdrop="1"]').onclick = e => {
    if (e.target === e.currentTarget) ctrl.closeSheet()
  }
  host.querySelector('[data-act="close"]')?.addEventListener('click', () => ctrl.closeSheet())

  if (ctrl.activeSheet === 'toc') {
    const bindTocNav = () => {
      host.querySelectorAll('[data-toc-id]').forEach(btn => {
        btn.onclick = () => { const id = btn.dataset.tocId; ctrl.closeSheet(); ctrl.jumpToBlock(id) }
      })
      host.querySelectorAll('[data-toc-hit]').forEach(btn => {
        btn.onclick = () => { ctrl.searchQuery = String(ctrl.tocSearch || '').trim(); ctrl.closeSheet(); ctrl.jumpToSearchMatch(btn.dataset.tocHit, btn.dataset.tocView) }
      })
    }
    bindTocNav()
    host.querySelectorAll('[data-toc-tab]').forEach(btn => {
      btn.onclick = () => { ctrl.tocSearch = ''; ctrl.tocSubTab = btn.dataset.tocTab; ctrl.renderSheet() }
    })
    host.querySelector('[data-toc-search="1"]')?.addEventListener('input', e => {
      ctrl.tocSearch = e.target.value
      const q = ctrl.tocSearch.trim()
      const body = host.querySelector('[data-role="toc-body"]')
      if (!q || !body) { if (!q) ctrl.renderSheet(); return }
      const res = searchBookContent(ctrl.reading, q, { maxMatches: 80 })
      body.innerHTML = res.matches.length
        ? `<div style="display:flex;flex-direction:column;gap:6px;"><div style="font-size:11.5px;color:var(--fg-muted);">共 ${res.totalMatches} 处匹配</div>${res.matches.map(h => `<button type="button" class="wr-searchHitCard" data-toc-hit="${escapeHtml(h.blockId)}" data-toc-view="${escapeHtml(h.view)}"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span class="wr-searchTag">${h.view === 'original' ? '原文' : '译文'}</span>${h.chapterLabel ? `<span class="wr-searchChapter">${escapeHtml(h.chapterLabel)}</span>` : ''}</div><div class="wr-searchSnippetText">${renderSearchSnippetHtml(h.snippet, h.matchOffset, h.matchLen)}</div></button>`).join('')}</div>`
        : '<p style="color:var(--fg-muted);font-size:13px;padding:12px 0;">未在本书中找到匹配内容</p>'
      bindTocNav()
    })
    host.querySelector('[data-toc-bm="1"]')?.addEventListener('click', async () => {
      const bid = ctrl.currentTopBlockId()
      const blk = (ctrl.reading.blocks || []).find(b => b.id === bid)
      if (!blk) return
      const v = ctrl.viewMode === 'original' ? 'original' : 'translation'
      const exact = plainText(v === 'original' ? (blk.sourceText ?? blk.text) : (blk.translation ?? blk.text)).slice(0, 120)
      if (!exact) return
      const created = await readerApi.postBookmarkAction(ctrl.settings, {
        source: { kind: 'task', id: ctrl.taskId },
        selection: { view: v, startBlockId: bid, endBlockId: bid, exact },
        style: ctrl.settings.highlightStyle || 'highlight',
        color: ctrl.settings.highlightColor || 'gold',
      })
      ctrl.marks.push({ id: created?.id || 'local-' + Date.now(), kind: 'bookmark', view: v, blockId: bid, quote: exact, exact, style: ctrl.settings.highlightStyle || 'highlight', color: ctrl.settings.highlightColor || 'gold' })
      await offlineDb.saveMarks(ctrl.taskId, ctrl.marks)
      ctrl.onToast('已加入当前段落书签')
      ctrl.renderSheet()
    })
    host.querySelector('[data-toc-page="prev"]')?.addEventListener('click', () => ctrl.turnTocPage(-1))
    host.querySelector('[data-toc-page="next"]')?.addEventListener('click', () => ctrl.turnTocPage(1))
  } else if (ctrl.activeSheet === 'drawer') {
    const b = ctrl.sheetData.block
    host.querySelector('[data-act="correct-from-drawer"]').onclick = () => {
      ctrl.openCorrectionSheet(b.id, ctrl.viewMode === 'original' ? 'original' : 'translation')
    }
    host.querySelector('[data-act="open-pdf-page"]')?.addEventListener('click', () => {
      ctrl.openPdfViewer(b.pdfPage)
    })
  } else if (ctrl.activeSheet === 'footnote') {
    host.querySelector('[data-act="toggle-fn"]')?.addEventListener('click', () => {
      ctrl.sheetData.showAlt = !ctrl.sheetData.showAlt
      ctrl.renderSheet()
    })
  } else if (ctrl.activeSheet === 'noteEditor') {
    host.querySelector('[data-act="save-note"]').onclick = async () => {
      const comment = host.querySelector('[data-note="comment"]').value
      const tagsRaw = host.querySelector('[data-note="tags"]').value
      const tags = tagsRaw
        .split(/[，,]/)
        .map(s => s.trim())
        .filter(Boolean)
      const created = await readerApi.postBookmarkAction(ctrl.settings, {
        source: { kind: 'task', id: ctrl.taskId },
        selection: ctrl.sheetData.selection,
        comment,
        tags,
        style: ctrl.settings.highlightStyle || 'highlight',
        color: ctrl.settings.highlightColor || 'gold',
      })
      ctrl.marks.push({
        id: created?.id || 'local-' + Date.now(),
        kind: 'bookmark',
        style: ctrl.settings.highlightStyle || 'highlight',
        color: ctrl.settings.highlightColor || 'gold',
        view: ctrl.sheetData.selection.view,
        blockId: ctrl.sheetData.selection.startBlockId,
        quote: ctrl.sheetData.selection.exact,
        exact: ctrl.sheetData.selection.exact,
        comment,
      })
      await offlineDb.saveMarks(ctrl.taskId, ctrl.marks)
      ctrl.closeSheet()
      ctrl.renderBlocks()
      ctrl.onToast(created?.offlineQueued ? '已离线暂存书签，联网后自动同步' : '已保存书签')
    }
  } else if (ctrl.activeSheet === 'correction') {
    host.querySelector('[data-act="save-corr"]').onclick = async () => {
      const d = ctrl.sheetData
      const nextText = host.querySelector('[data-corr="text"]').value
      const reason = host.querySelector('[data-corr="reason"]').value
      try {
        validateCorrectionMarkers(d.raw, nextText)
        const res = await readerApi.submitCorrection(ctrl.settings, ctrl.taskId, {
          blockId: d.block.id,
          view: d.view,
          version: ctrl.reading.version,
          text: nextText,
          reason,
          deviceName: ctrl.settings.deviceName,
        })
        if (res.reading) {
          ctrl.reading = res.reading
          ctrl.pendingBlockId = d.block.id
          ctrl.closeSheet()
          ctrl.renderBlocks()
          ctrl.onToast('勘误已保存并同步到云端')
        } else {
          ctrl.closeSheet()
          ctrl.onToast('已加入离线同步队列，联网后提交')
        }
      } catch (err) {
        ctrl.onToast(err.message)
      }
    }
  } else if (ctrl.activeSheet === 'search') {
    const input = host.querySelector('[data-book-search="1"]')
    const statusEl = host.querySelector('[data-role="book-search-status"]')
    const listEl = host.querySelector('[data-role="book-search-list"]')
    const renderHits = () => {
      const q = String(ctrl.searchQuery || '').trim()
      if (!q) {
        statusEl.textContent = '输入关键词，可检索当前书籍的原文与译文段落。'
        listEl.innerHTML = ''
        return
      }
      const res = searchBookContent(ctrl.reading, q, { maxMatches: 120 })
      statusEl.textContent = res.matches.length
        ? `共找到 ${res.totalMatches} 处匹配（显示 ${res.matches.length} 段，点击定位并高亮）`
        : '全书中未找到匹配内容'
      listEl.innerHTML = res.matches
        .map(
          h => `
        <button type="button" class="wr-libSearchHitBtn" data-search-block="${escapeHtml(h.blockId)}" data-search-view="${escapeHtml(h.view)}">
          <span class="wr-searchTag">${h.view === 'original' ? '原文' : '译文'}</span>
          ${h.chapterLabel ? `<span class="wr-searchChapter">${escapeHtml(h.chapterLabel)}</span>` : ''}
          <span class="wr-searchSnippetText">${renderSearchSnippetHtml(h.snippet, h.matchOffset, h.matchLen)}</span>
        </button>
      `
        )
        .join('')
      listEl.querySelectorAll('[data-search-block]').forEach(btn => {
        btn.onclick = () => {
          const bid = btn.dataset.searchBlock
          const bview = btn.dataset.searchView
          ctrl.closeSheet()
          if (bview && bview !== ctrl.viewMode && (bview === 'original' || ctrl.hasTranslation)) {
            ctrl.jumpToBlock(bid, bview)
          } else {
            ctrl.pendingBlockId = bid
            ctrl.renderBlocks()
            ctrl.scheduleSaveProgress()
          }
        }
      })
    }
    renderHits()
    if (input) {
      input.oninput = () => {
        ctrl.searchQuery = input.value
        renderHits()
      }
      setTimeout(() => input.focus(), 40)
    }
    host.querySelector('[data-clear-search="1"]')?.addEventListener('click', () => {
      ctrl.searchQuery = ''
      ctrl.renderBlocks()
      ctrl.renderSheet()
    })
  } else if (ctrl.activeSheet === 'markDetail') {
    const patchMark = async (id, patch) => {
      await readerApi.postBookmarkAction(ctrl.settings, { updateBookmark: { id, ...patch } })
      const m = ctrl.marks.find(x => x.id === id)
      if (m) Object.assign(m, patch)
      await offlineDb.saveMarks(ctrl.taskId, ctrl.marks)
      ctrl.renderBlocks()
    }
    host.querySelectorAll('[data-mk-style]').forEach(btn => {
      btn.onclick = async () => { await patchMark(btn.dataset.mkId, { style: btn.dataset.mkStyle }); ctrl.renderSheet(); ctrl.onToast('已切换样式') }
    })
    host.querySelectorAll('[data-mk-color]').forEach(btn => {
      btn.onclick = async () => { await patchMark(btn.dataset.mkId, { color: btn.dataset.mkColor }); ctrl.renderSheet(); ctrl.onToast('已更换颜色') }
    })
    host.querySelectorAll('[data-save-mark]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.saveMark
        const comment = host.querySelector(`[data-mark-comment="${id}"]`)?.value ?? ''
        await patchMark(id, { comment, kind: comment.trim() ? 'bookmark' : undefined })
        ctrl.closeSheet()
        ctrl.onToast('想法已保存')
      }
    })
    host.querySelectorAll('[data-del-mark]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.delMark
        const kind = btn.dataset.delKind
        await readerApi.postBookmarkAction(ctrl.settings, kind === 'bookmark' ? { muteHighlight: id } : { removeHighlight: id })
        ctrl.marks = ctrl.marks.filter(m => m.id !== id)
        await offlineDb.saveMarks(ctrl.taskId, ctrl.marks)
        ctrl.closeSheet()
        ctrl.renderBlocks()
        ctrl.onToast('已取消高亮')
      }
    })
  }
}
