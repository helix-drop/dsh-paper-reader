import {
  escapeHtml,
  extractGlossaryHits,
  plainText,
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
              ? `<iframe src="${p.fallbackPdfUrl}#page=${p.page}" style="width:100%;height:100%;border:none;"></iframe>`
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
    return
  }

  let inner = ''
  if (ctrl.activeSheet === 'toc') {
    const currentBlock = ctrl.currentTopBlockId()
    const items = ctrl.outlineItems()
    const glossary = ctrl.reading.glossary ?? []
    const subTab = ctrl.tocSubTab || 'outline'
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
    } else if (subTab === 'marks') {
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
    } else {
      tabBody = `
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${
            glossary.length
              ? glossary
                  .slice(0, 120)
                  .map(
                    g => `
            <div style="padding:8px 6px;border-bottom:1px solid var(--border);font-size:13px;">
              <div style="font-weight:600;">${escapeHtml(g.source || g.src || '')} → <span style="color:var(--accent);">${escapeHtml(g.target || g.dst || '')}</span></div>
              ${g.note || g.info ? `<div style="font-size:11.5px;color:var(--fg-muted);margin-top:2px;">${escapeHtml(g.note || g.info)}</div>` : ''}
            </div>
          `
                  )
                  .join('')
              : '<p style="color:var(--fg-muted);font-size:13px;text-align:center;margin:16px 0;">本书暂无术语表</p>'
          }
        </div>
      `
    }

    inner = `
      <div class="wr-barRow">
        <div class="wr-tocTabs" style="flex:1;">
          <button type="button" class="wr-tocTab ${subTab === 'outline' ? 'active' : ''}" data-toc-tab="outline">目录 (${items.length})</button>
          <button type="button" class="wr-tocTab ${subTab === 'marks' ? 'active' : ''}" data-toc-tab="marks">划线 (${ctrl.marks.length})</button>
          <button type="button" class="wr-tocTab ${subTab === 'glossary' ? 'active' : ''}" data-toc-tab="glossary">术语 (${glossary.length})</button>
        </div>
        <button type="button" class="wr-btnGhost" data-act="close" style="padding:5px 10px;">关闭</button>
      </div>
      ${tabBody}
    `
  } else if (ctrl.activeSheet === 'drawer') {
    const b = ctrl.sheetData.block
    const transText = ctrl.reading.standaloneView === 'translation' ? b.text : (b.translation ?? b.text)
    const origText = b.sourceText ?? b.text
    const glossaryHits = extractGlossaryHits(transText, origText, ctrl.reading.glossary)
    inner = `
      <div class="wr-barRow">
        <h3 style="margin:0;font-size:16px;">双语对照${b.pdfPage ? ` · 原书第 ${b.pdfPage} 页` : ''}</h3>
        <button type="button" class="wr-btnGhost" data-act="close">关闭</button>
      </div>
      ${ctrl.hasTranslation ? `<div><div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">译文</div><p style="margin:0;line-height:1.65;">${escapeHtml(plainText(transText))}</p></div>` : ''}
      <div><div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">原文</div><p style="margin:0;line-height:1.65;color:var(--fg-muted);">${escapeHtml(plainText(origText))}</p></div>
      ${
        glossaryHits.length
          ? `
        <div>
          <div style="font-size:12px;color:var(--fg-muted);margin-bottom:4px;">命中术语</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${glossaryHits.map(g => `<span class="wr-badge">${escapeHtml(g.source)} → ${escapeHtml(g.target)}</span>`).join('')}
          </div>
        </div>
      `
          : ''
      }
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
  }

  const dockSide = Boolean(ctrl.layoutInfo?.dockSideSheet)
  host.innerHTML = `<div class="wr-sheetBackdrop ${dockSide ? 'dock-side' : ''}" data-backdrop="1"><div class="wr-sheet">${inner}</div></div>`
  host.querySelector('[data-backdrop="1"]').onclick = e => {
    if (e.target === e.currentTarget) ctrl.closeSheet()
  }
  host.querySelector('[data-act="close"]')?.addEventListener('click', () => ctrl.closeSheet())

  if (ctrl.activeSheet === 'toc') {
    host.querySelectorAll('[data-toc-tab]').forEach(btn => {
      btn.onclick = () => {
        ctrl.tocSubTab = btn.dataset.tocTab
        ctrl.renderSheet()
      }
    })
    host.querySelectorAll('[data-toc-id]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.tocId
        ctrl.closeSheet()
        ctrl.jumpToBlock(id)
      }
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
      })
      ctrl.marks.push({
        id: created?.id || 'local-' + Date.now(),
        kind: 'bookmark',
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
  }
}
