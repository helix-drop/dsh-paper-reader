import { escapeHtml, WEREAD_THEMES, WEREAD_FONTS, bookCoverPalette, resolveFontStack, renderLibrarySearchSectionHtml, renderSyncStatusCardHtml } from './reading-core.js'
import { offlineDb } from './offline-db.js'
import { readerApi } from './api.js'
import { nativeBridge } from './native-bridge.js'
import { ReaderController } from './reader-controller.js'

const appEl = document.getElementById('app')

const APP_VERSION = '0.2.0'
const state = {
  tab: 'shelf', // shelf | notes | settings
  settings: null,
  library: { documents: [], folders: [], meta: {} },
  progress: {},
  bookmarks: [],
  cachedIds: new Set(),
  cachedPdfIds: new Set(),
  outboxCount: 0,
  searchQuery: '',
  libSearch: { loading: false, query: '', data: null, timer: null, ctrl: null },
  selectedFolder: 'all',
  noteSearch: '',
  noteDocFilter: '',
  syncing: false,
  syncProgressText: '',
  syncProgress: null,
  syncStatus: null,
  syncAbortController: null,
  downloadingId: '',
  openingId: '',
  openingTitle: '',
  openAbortController: null,
  coverAbortController: null,
  keyCaptureTarget: null, // 'prev' | 'next' | null
  reader: null,
  shelfPage: 0,
  shelfTotalPages: 1,
  toastMsg: '',
  toastTimer: null,
}

function abortCovers() {
  if (state.coverAbortController) {
    state.coverAbortController.abort()
    state.coverAbortController = null
  }
}

function currentSyncCardHtml(showActions = true) {
  const docs = state.library.documents ?? []
  const pdfTotal = docs.filter(d => d.hasPdf !== false).length
  return renderSyncStatusCardHtml({
    syncing: state.syncing, syncProgress: state.syncProgress, syncStatus: state.syncStatus,
    cachedMd: state.cachedIds.size, totalDocs: docs.length,
    cachedPdf: state.cachedPdfIds.size, totalPdfDocs: pdfTotal,
    outboxCount: state.outboxCount,
    serverConfigured: Boolean(state.settings?.serverUrl || !nativeBridge.isNative()),
    hasCancel: Boolean(state.syncAbortController), showActions,
  })
}

function bindSyncCardActions(root = appEl) {
  root?.querySelectorAll('[data-act="cancel-sync"]').forEach(b => { b.onclick = () => state.syncAbortController?.abort() })
  root?.querySelectorAll('[data-act="sync-now"]').forEach(b => { b.onclick = () => performSync(false) })
  root?.querySelectorAll('[data-act="goto-settings"]').forEach(b => { b.onclick = () => { state.tab = 'settings'; render() } })
}

function renderStatusBanners() {
  let syncEl = document.getElementById('wr-sync-bar')
  if (!state.syncing || !state.syncProgressText || state.reader) {
    syncEl?.remove()
  } else {
    if (!syncEl) {
      syncEl = document.createElement('div'); syncEl.id = 'wr-sync-bar'; syncEl.className = 'wr-syncFloatBar'; document.body.appendChild(syncEl)
    }
    syncEl.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">↻ ${escapeHtml(state.syncProgressText)}</span><button type="button" class="wr-btnGhost" data-act="cancel-sync" style="padding:4px 10px;font-size:12px;flex-shrink:0;">取消</button>`
    syncEl.querySelector('[data-act="cancel-sync"]').onclick = () => state.syncAbortController?.abort()
  }
  appEl.querySelectorAll('[data-role="sync-card-host"]').forEach(host => {
    host.innerHTML = currentSyncCardHtml(state.tab !== 'settings'); bindSyncCardActions(host)
  })

  let openEl = document.getElementById('wr-opening-banner')
  if (!state.openingId || !state.openingTitle || state.reader) {
    openEl?.remove()
  } else {
    if (!openEl) {
      openEl = document.createElement('div')
      openEl.id = 'wr-opening-banner'
      openEl.className = 'wr-syncFloatBar'
      document.body.appendChild(openEl)
    }
    openEl.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">正在下载正文：${escapeHtml(state.openingTitle)}...</span><button type="button" class="wr-btnGhost" data-act="cancel-open" style="padding:4px 10px;font-size:12px;flex-shrink:0;">取消</button>`
    openEl.querySelector('[data-act="cancel-open"]').onclick = () => {
      state.openAbortController?.abort()
    }
  }
}

function showToast(msg) {
  state.toastMsg = msg
  clearTimeout(state.toastTimer)
  renderToast()
  state.toastTimer = setTimeout(() => {
    state.toastMsg = ''
    renderToast()
  }, 2600)
}

function renderToast() {
  let el = document.getElementById('wr-global-toast')
  if (!state.toastMsg) {
    if (el) el.remove()
    return
  }
  if (!el) {
    el = document.createElement('div')
    el.id = 'wr-global-toast'
    el.className = 'wr-toast'
    document.body.appendChild(el)
  }
  el.textContent = state.toastMsg
}

function applyThemeAttributes(settings) {
  const themeId = settings.theme || 'paper'
  document.body.setAttribute('data-theme', themeId)
  document.body.setAttribute('data-eink', settings.deviceMode === 'eink' || themeId === 'eink' ? 'true' : 'false')
  const found = WEREAD_THEMES.find(t => t.id === themeId)
  const bg = found ? found.bg : '#f6f1e7'
  const metaTheme = document.querySelector('meta[name="theme-color"]')
  if (metaTheme) metaTheme.setAttribute('content', bg)
  void nativeBridge.setAppearance({ bgColor: bg, dark: Boolean(found?.dark) })
}

async function updateSettings(patch) {
  state.settings = await offlineDb.saveSettings(patch)
  applyThemeAttributes(state.settings)
  return state.settings
}

async function refreshLocalState() {
  const [lib, progress, bookmarks, cachedIds, cachedPdfIds, outbox, syncStatus] = await Promise.all([
    offlineDb.getLibraryCache(),
    offlineDb.getAllProgress(),
    offlineDb.getBookmarks(),
    offlineDb.listCachedBookIds(),
    offlineDb.listCachedPdfIds(),
    offlineDb.listOutbox(),
    offlineDb.getSyncStatus(),
  ])
  state.library = lib; state.progress = progress; state.bookmarks = bookmarks
  state.cachedIds = cachedIds; state.cachedPdfIds = cachedPdfIds
  state.outboxCount = outbox.length; state.syncStatus = syncStatus
}

async function performSync(silent = false, options = {}) {
  if (state.syncing) return
  abortCovers()
  const includePdfs = options.includePdfs !== undefined ? Boolean(options.includePdfs) : Boolean(state.settings?.syncIncludePdfs)
  const ctrl = new AbortController()
  state.syncAbortController = ctrl; state.syncing = true
  state.syncProgress = { phase: 'start', phaseLabel: includePdfs ? '准备下载所有 MD 与原 PDF' : '正在连接云端同步书目与正文', pct: 3 }
  state.syncProgressText = state.syncProgress.phaseLabel
  render()
  try {
    let lastCountRefresh = 0
    const res = await readerApi.syncAll(state.settings, {
      syncBooks: true, includePdfs, signal: ctrl.signal,
      onProgress: p => {
        state.syncProgress = p
        const frac = p.total > 0 ? ` ${p.done}/${p.total}` : ''
        state.syncProgressText = `${p.phaseLabel || '同步中'}${frac}${p.title ? `：${p.title}` : ''}`
        if (p.phase === 'books' && p.done - lastCountRefresh >= 4) {
          lastCountRefresh = p.done
          void offlineDb.listCachedBookIds().then(ids => { state.cachedIds = ids })
        } else if (p.phase === 'pdfs') {
          void offlineDb.listCachedPdfIds().then(ids => { state.cachedPdfIds = ids })
        }
        renderStatusBanners()
      },
    })
    await refreshLocalState()
    const summary = {
      at: Date.now(), ok: !ctrl.signal.aborted, aborted: ctrl.signal.aborted, error: '',
      totalDocs: res.totalDocs ?? (state.library.documents?.length ?? 0),
      addedBooks: res.addedBooks || 0, renamedBooks: res.renamedBooks || 0, removedBooks: res.removedBooks || 0,
      syncedBooks: res.syncedBooks || 0, skippedBooks: res.skippedBooks || 0, failedBooks: res.failedBooks || 0,
      syncedPdfs: res.syncedPdfs || 0, skippedPdfs: res.skippedPdfs || 0, failedPdfs: res.failedPdfs || 0,
    }
    state.syncStatus = summary; await offlineDb.saveSyncStatus(summary)
    if (ctrl.signal.aborted) {
      showToast('已取消剩余下载（已完成部分已离线保存）')
    } else if (!silent) {
      const notes = [
        res.addedBooks ? `新增 ${res.addedBooks}` : '',
        res.renamedBooks ? `改名 ${res.renamedBooks}` : '',
        res.syncedBooks ? `更新 ${res.syncedBooks}` : '',
        includePdfs && res.syncedPdfs ? `PDF +${res.syncedPdfs}` : '',
        res.failedBooks || res.failedPdfs ? `失败 ${(res.failedBooks || 0) + (res.failedPdfs || 0)}` : '',
      ].filter(Boolean)
      showToast(notes.length ? `同步完成（${notes.join('，')}）` : `已同步全部 ${summary.totalDocs} 篇正文（均已是最新）`)
    }
  } catch (err) {
    const msg = ctrl.signal.aborted ? '已手动取消同步' : (err.message || '同步失败，当前显示离线缓存')
    const errSummary = { ...(state.syncStatus || {}), at: Date.now(), ok: false, aborted: ctrl.signal.aborted, error: msg }
    state.syncStatus = errSummary; await offlineDb.saveSyncStatus(errSummary).catch(() => {})
    if (!ctrl.signal.aborted && !silent) showToast(msg)
  } finally {
    state.syncing = false; state.syncProgress = null; state.syncProgressText = ''
    if (state.syncAbortController === ctrl) state.syncAbortController = null
    render()
  }
}

async function openBook(taskId, blockId = '', view = '', searchQuery = '') {
  if (!taskId || state.openingId === taskId) return
  state.openAbortController?.abort()
  abortCovers()

  const ctrl = new AbortController()
  const doc = state.library.documents?.find(d => d.id === taskId)
  state.openingId = taskId
  state.openAbortController = ctrl
  state.openingTitle = ''

  const waitTimer = setTimeout(() => {
    if (state.openingId === taskId && !ctrl.signal.aborted) {
      state.openingTitle = doc?.name || '文献正文'
      renderStatusBanners()
    }
  }, 150)

  try {
    const res = await readerApi.loadReading(state.settings, taskId, {
      preferOffline: true,
      signal: ctrl.signal,
    })
    if (state.openingId !== taskId || ctrl.signal.aborted) return
    state.cachedIds.add(taskId)
    clearTimeout(waitTimer)
    state.openingId = ''
    state.openingTitle = ''
    state.openAbortController = null
    renderStatusBanners()

    state.reader = new ReaderController({
      root: appEl,
      taskId,
      reading: res.reading,
      settings: state.settings,
      initialBlockId: blockId,
      initialView: view,
      initialSearchQuery: searchQuery,
      onToast: showToast,
      onSettingsChange: async patch => updateSettings(patch),
      onExit: async () => {
        state.reader?.destroy()
        state.reader = null
        await refreshLocalState()
        render()
      },
    })
    await state.reader.mount()
    if (res.offlineFallback) showToast('离线模式打开')
  } catch (err) {
    if (!err?.cancelled && !ctrl.signal.aborted) {
      showToast(err.message || '无法打开该文献')
    }
  } finally {
    clearTimeout(waitTimer)
    if (state.openAbortController === ctrl) {
      state.openingId = ''
      state.openingTitle = ''
      state.openAbortController = null
    }
    renderStatusBanners()
  }
}

function progressForDoc(doc) {
  if (!doc) return null
  const keys = [
    doc.documentId,
    doc.id,
    doc.id ? `document:${doc.id}` : null,
    doc.documentId?.startsWith('document:') ? doc.documentId.slice(9) : null,
  ].filter(Boolean)
  let best = null
  for (const k of keys) {
    const entry = state.progress[k]
    if (entry && (!best || (entry.updatedAt || 0) > (best.updatedAt || 0))) {
      best = entry
    }
  }
  return best
}

function renderBookCoverHtml(doc, isEink, badgeText = '') {
  const pal = bookCoverPalette(doc.name, isEink)
  const kindLabel = { book: '整书', paper: '论文', chapter: '章节', collection: '合集' }
  const coverState = doc.hasPdf === false ? null : readerApi.getCachedCoverUrl(doc.id)
  const coverImgHtml = typeof coverState === 'string'
    ? `<img class="wr-bookCoverImg loaded" src="${escapeHtml(coverState)}" alt="" />`
    : coverState === null
      ? ''
      : `<img class="wr-bookCoverImg" data-cover-task="${escapeHtml(doc.id)}" alt="" />`
  return `
    <div class="wr-bookCover" style="background:${pal.bg};color:${pal.fg};">
      ${coverImgHtml}
      ${badgeText ? `<span class="wr-bookCoverBadge">${escapeHtml(badgeText)}</span>` : ''}
      <div class="wr-bookCoverTitle">${escapeHtml(doc.name || '未命名文献')}</div>
      <div class="wr-bookCoverAuthor">${escapeHtml(doc.author || kindLabel[doc.kind] || 'DSH 文献')}</div>
    </div>
  `
}

let coverHydrateToken = 0
async function hydrateShelfCovers() {
  const token = ++coverHydrateToken
  if (state.syncing || state.openingId || state.reader) return
  abortCovers()
  const ctrl = new AbortController()
  state.coverAbortController = ctrl

  const imgs = [...appEl.querySelectorAll('img.wr-bookCoverImg[data-cover-task]')].slice(0, 12)
  if (!imgs.length) return
  const byTask = new Map()
  for (const img of imgs) {
    const taskId = img.getAttribute('data-cover-task')
    if (!taskId) continue
    if (!byTask.has(taskId)) byTask.set(taskId, [])
    byTask.get(taskId).push(img)
  }
  const tasks = [...byTask.keys()]
  const concurrency = 2
  let idx = 0
  const worker = async () => {
    while (idx < tasks.length) {
      if (token !== coverHydrateToken || ctrl.signal.aborted || state.syncing || state.openingId) return
      const taskId = tasks[idx++]
      const url = await readerApi.loadCoverUrl(state.settings, taskId, { signal: ctrl.signal })
      if (token !== coverHydrateToken || ctrl.signal.aborted) return
      for (const el of byTask.get(taskId) ?? []) {
        el.removeAttribute('data-cover-task')
        if (url) {
          el.src = url
          el.classList.add('loaded')
        } else {
          el.remove()
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()))
}

function renderShelf() {
  return `
    <div class="wr-searchRow">
      <input type="search" class="wr-input" placeholder="全库搜索书名、作者或正文（原文/译文）..." value="${escapeHtml(state.searchQuery)}" data-act="search-shelf" />
    </div>
    <div id="wr-shelf-results">${renderShelfBody()}</div>
  `
}

function renderShelfBody() {
  const docs = (state.library.documents ?? []).filter(d => {
    const meta = state.library.meta?.[d.id] ?? {}
    if (meta.hidden) return false
    if (state.selectedFolder !== 'all') {
      const ids = meta.folderId ? String(meta.folderId).split(',').map(s => s.trim()).filter(Boolean) : []
      if (state.selectedFolder === 'uncategorized') {
        if (ids.length) return false
      } else if (!ids.includes(state.selectedFolder)) {
        return false
      }
    }
    if (state.searchQuery.trim()) {
      const hay = [d.name, d.author, d.titleSource].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(state.searchQuery.trim().toLowerCase())) return false
    }
    return true
  }).slice().sort((a, b) => {
    const pa = progressForDoc(a)?.updatedAt || 0
    const pb = progressForDoc(b)?.updatedAt || 0
    return pb - pa
  })

  const folders = state.library.folders ?? []
  const kindLabel = { book: '整书', paper: '论文', chapter: '章节', collection: '合集' }
  const isEink = state.settings?.deviceMode === 'eink' || state.settings?.theme === 'eink'
  const shelfLayout = state.settings?.shelfLayout || 'list'
  const pageSize = shelfLayout === 'grid'
    ? (window.innerWidth >= 980 ? 12 : 9)
    : (window.innerWidth >= 980 ? 9 : 6)
  state.shelfTotalPages = isEink ? Math.max(1, Math.ceil(docs.length / pageSize)) : 1
  state.shelfPage = Math.max(0, Math.min(state.shelfTotalPages - 1, state.shelfPage))
  const visibleDocs = isEink ? docs.slice(state.shelfPage * pageSize, (state.shelfPage + 1) * pageSize) : docs

  // Find most recently read book for the top "Continue Reading" hero banner
  const recentDoc = !state.searchQuery.trim() && state.selectedFolder === 'all' && state.shelfPage === 0
    ? docs.find(d => (progressForDoc(d)?.percent || 0) > 0)
    : null
  const recentProg = recentDoc ? progressForDoc(recentDoc) : null

  const allDocs = state.library.documents ?? []
  const mdMissing = allDocs.filter(d => !state.cachedIds.has(d.id)).length
  const pdfDocsCount = allDocs.filter(d => d.hasPdf !== false).length
  const pdfCachedCount = allDocs.filter(d => d.hasPdf !== false && state.cachedPdfIds.has(d.id)).length

  const searching = Boolean(state.searchQuery.trim())
  return `
    ${recentDoc ? `
      <div class="wr-heroContinue" data-open-book="${escapeHtml(recentDoc.id)}">
        ${renderBookCoverHtml(recentDoc, isEink)}
        <div class="wr-heroBody">
          <span class="wr-heroTag">最近阅读 · 读至 ${recentProg?.percent || 0}%${recentProg?.pageIndex ? `（第 ${recentProg.pageIndex} 页）` : ''}</span>
          <h3 class="wr-heroTitle">${escapeHtml(recentDoc.name)}</h3>
          <div class="wr-heroMeta">${escapeHtml([recentDoc.author, recentDoc.titleSource].filter(Boolean).join(' · ') || '双语精读文献')}</div>
          <div>
            <button type="button" class="wr-btnPrimary" data-read-book="${escapeHtml(recentDoc.id)}" style="padding:5px 14px;font-size:12px;">继续阅读 ›</button>
          </div>
        </div>
      </div>
    ` : ''}
    ${!searching ? `<div class="wr-pillRow">
      <button type="button" class="wr-pill ${state.selectedFolder === 'all' ? 'active' : ''}" data-folder="all">全部 (${allDocs.length})</button>
      <button type="button" class="wr-pill ${state.selectedFolder === 'uncategorized' ? 'active' : ''}" data-folder="uncategorized">未归类</button>
      ${folders.map(f => `<button type="button" class="wr-pill ${state.selectedFolder === f.id ? 'active' : ''}" data-folder="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`).join('')}
    </div>
    ${allDocs.length ? `
      <div class="wr-bulkDownloadRow">
        <button type="button" class="wr-btnGhost wr-bulkBtn" data-act="dl-all-md" ${state.syncing ? 'disabled' : ''}>↓ 下载所有 MD 文件${mdMissing > 0 ? `（缺 ${mdMissing}）` : '（已全）'}</button>
        <button type="button" class="wr-btnGhost wr-bulkBtn" data-act="dl-all-files" ${state.syncing ? 'disabled' : ''}>↓ 下载所有文件${pdfDocsCount > 0 ? `（含 PDF ${pdfCachedCount}/${pdfDocsCount}）` : ''}</button>
        ${state.syncing && state.syncAbortController ? '<button type="button" class="wr-btnGhost wr-bulkBtn" data-act="cancel-sync">取消下载</button>' : ''}
      </div>
    ` : ''}
    <div data-role="sync-card-host">${currentSyncCardHtml(true)}</div>` : ''}
    <div id="wr-lib-search-host">${renderLibrarySearchSectionHtml(state.libSearch, state.searchQuery, docs)}</div>
    ${searching ? '' : !visibleDocs.length ? `
      <div class="wr-card" style="text-align:center;color:var(--fg-muted);">
        <p style="margin:12px 0;">${state.library.documents?.length ? '没有匹配的文献' : '书架为空，请先在「设置」配置轻量云服务器并点击同步。'}</p>
      </div>
    ` : shelfLayout === 'grid' ? `
      <div class="wr-bookGrid">
        ${visibleDocs.map(d => {
          const prog = progressForDoc(d)
          const pct = prog?.percent || 0
          const isCached = state.cachedIds.has(d.id)
          return `
            <div class="wr-gridBookItem" data-open-book="${escapeHtml(d.id)}">
              ${renderBookCoverHtml(d, isEink, isCached ? '离线' : '')}
              <h4 class="wr-gridBookName">${escapeHtml(d.name)}</h4>
              <span class="wr-gridBookProg">${pct > 0 ? `已读 ${pct}%` : '未读'}</span>
            </div>
          `
        }).join('')}
      </div>
    ` : `
      <div class="wr-bookList">
        ${visibleDocs.map(d => {
          const prog = progressForDoc(d)
          const pct = prog?.percent || 0
          const isCached = state.cachedIds.has(d.id)
          const hasPdfCached = state.cachedPdfIds.has(d.id)
          const busy = state.downloadingId === d.id
          return `
            <div class="wr-bookCard wr-bookCardWithCover" data-open-book="${escapeHtml(d.id)}">
              ${renderBookCoverHtml(d, isEink)}
              <div class="wr-bookCardMain">
                <div class="wr-bookTop">
                  <div style="min-width:0;">
                    <h3 class="wr-bookTitle">${escapeHtml(d.name)}</h3>
                    <div class="wr-bookMeta">${escapeHtml([d.author, d.titleSource, kindLabel[d.kind] || d.kind].filter(Boolean).join(' · '))}</div>
                  </div>
                  <span class="wr-badge ${isCached ? 'offline' : ''}" style="flex-shrink:0;">${isCached ? (hasPdfCached ? 'MD+PDF' : '已离线') : '云端'}</span>
                </div>
                <div class="wr-progressTrack"><div class="wr-progressFill" style="width:${pct}%"></div></div>
                <div class="wr-bookActions">
                  <span style="font-size:12px;color:var(--fg-muted);">${pct > 0 ? `已读 ${pct}%${prog?.pageIndex ? ` · 第 ${prog.pageIndex} 页` : ''}` : '未读'}</span>
                  <div style="display:flex;gap:6px;">
                    <button type="button" class="wr-btnGhost" data-dl-book="${escapeHtml(d.id)}" style="padding:5px 10px;font-size:12px;">${busy ? '下载中...' : isCached ? '更新离线' : '缓存离线'}</button>
                    <button type="button" class="wr-btnPrimary" data-read-book="${escapeHtml(d.id)}" style="padding:5px 12px;font-size:12px;">${pct > 0 ? '继续阅读' : '开始阅读'}</button>
                  </div>
                </div>
              </div>
            </div>
          `
        }).join('')}
      </div>
    `}
    ${searching || !isEink || state.shelfTotalPages <= 1 ? '' : `
      <div class="wr-einkPager" style="margin-top:12px;">
        <button type="button" class="wr-btnGhost" data-shelf-page="prev" ${state.shelfPage <= 0 ? 'disabled' : ''}>‹ 上一页</button>
        <span style="font-size:12px;color:var(--fg-muted);">书架 第 ${state.shelfPage + 1} / ${state.shelfTotalPages} 页</span>
        <button type="button" class="wr-btnGhost" data-shelf-page="next" ${state.shelfPage >= state.shelfTotalPages - 1 ? 'disabled' : ''}>下一页 ›</button>
      </div>
    `}
  `
}

function renderNotes() {
  const docsMap = new Map()
  for (const b of state.bookmarks) {
    if (b.documentId && !docsMap.has(b.documentId)) {
      docsMap.set(b.documentId, b.document?.title || b.documentId)
    }
  }
  const shown = state.bookmarks.filter(b => {
    if (state.noteDocFilter && b.documentId !== state.noteDocFilter) return false
    if (!state.noteSearch.trim()) return true
    const hay = [b.quote, b.comment, ...(b.tags ?? []), b.document?.title].join(' ').toLowerCase()
    return hay.includes(state.noteSearch.trim().toLowerCase())
  })

  return `
    <div class="wr-searchRow">
      <input type="search" class="wr-input" placeholder="搜索划线摘录、想法或标签..." value="${escapeHtml(state.noteSearch)}" data-act="search-notes" />
    </div>
    <div style="margin-bottom:10px;">
      <select class="wr-input" data-act="filter-note-doc">
        <option value="">全部书籍（${state.bookmarks.length}）</option>
        ${[...docsMap.entries()].map(([id, title]) => `<option value="${escapeHtml(id)}" ${state.noteDocFilter === id ? 'selected' : ''}>${escapeHtml(title)}</option>`).join('')}
      </select>
    </div>
    ${!shown.length ? '<div class="wr-card" style="text-align:center;color:var(--fg-muted);">暂无书签或想法</div>' : shown.map(b => `
      <div class="wr-card">
        <div style="font-size:12px;color:var(--fg-muted);margin-bottom:6px;">${escapeHtml(b.document?.title || '')}</div>
        <blockquote class="wr-quoteBox" style="margin-bottom:8px;">${escapeHtml(b.quote)}</blockquote>
        ${b.comment ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.55;">${escapeHtml(b.comment)}</p>` : ''}
        <div class="wr-barRow">
          <span style="font-size:11px;color:var(--fg-muted);">${escapeHtml((b.tags ?? []).join(' · '))}</span>
          <div style="display:flex;gap:6px;">
            <button type="button" class="wr-btnGhost" data-jump-note="${escapeHtml(b.id)}" style="padding:4px 10px;font-size:12px;">回看原文</button>
            <button type="button" class="wr-btnGhost" data-del-note="${escapeHtml(b.id)}" style="padding:4px 10px;font-size:12px;">删除</button>
          </div>
        </div>
      </div>
    `).join('')}
  `
}

function renderSettings() {
  const s = state.settings
  const colMode = s.columnLayout || 'auto'
  const biMode = s.bilingualLayout || 'auto'
  const tapMode = s.tapZoneMode || 'ergonomic'
  const curTheme = s.theme || 'paper'
  const curFont = s.fontFamily || 'serif'
  return `
    <div class="wr-card">
      <h3 class="wr-cardTitle">云端书库连接</h3>
      <label class="wr-field">云服务器地址（留空则使用当前页面同源地址）
        <input type="url" class="wr-input" id="set-url" placeholder="https://reader.example.com" value="${escapeHtml(s.serverUrl)}" />
      </label>
      <label class="wr-field">同步密钥（Bearer Token）
        <input type="password" class="wr-input" id="set-token" placeholder="输入服务器 SYNC_TOKEN" value="${escapeHtml(s.token)}" />
      </label>
      <label class="wr-field">当前设备名称（用于跨端进度提示）
        <input type="text" class="wr-input" id="set-devname" value="${escapeHtml(s.deviceName)}" />
      </label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="wr-btnGhost" data-act="save-conn">保存连接</button>
        <button type="button" class="wr-btnGhost" data-act="test-conn">测试连通</button>
        <button type="button" class="wr-btnPrimary" data-act="sync-now" ${state.syncing ? 'disabled' : ''}>${state.syncing ? '同步中...' : '立即同步'}</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        <button type="button" class="wr-btnGhost" data-act="dl-all-md" ${state.syncing ? 'disabled' : ''}>↓ 下载所有 MD 文件</button>
        <button type="button" class="wr-btnGhost" data-act="dl-all-files" ${state.syncing ? 'disabled' : ''}>↓ 下载所有文件（含 PDF）</button>
        ${state.syncing && state.syncAbortController ? '<button type="button" class="wr-btnGhost" data-act="cancel-sync">取消下载</button>' : ''}
      </div>
      <div class="wr-field" style="margin-top:10px;margin-bottom:0;">顶部「↻ 同步」默认下载范围
        <div class="wr-segGroup">
          <button type="button" class="wr-segBtn ${!s.syncIncludePdfs ? 'active' : ''}" data-sync-scope="md">所有 MD 文件（推荐，PDF 按需）</button>
          <button type="button" class="wr-segBtn ${s.syncIncludePdfs ? 'active' : ''}" data-sync-scope="all">所有文件（含全部 PDF）</button>
        </div>
      </div>
      <div data-role="sync-card-host" style="margin-top:10px;">${currentSyncCardHtml(false)}</div>
    </div>

    <div class="wr-card">
      <h3 class="wr-cardTitle">阅读主题背景与字体预览</h3>
      <div class="wr-field">背景主题（阅读页底部「背景」菜单可随时切换）
        <div class="wr-swatchScroll" style="margin-top:6px;">
          ${WEREAD_THEMES.map(t => `
            <button type="button" class="wr-swatchItem ${curTheme === t.id ? 'active' : ''}" data-set-theme="${t.id}">
              <span class="wr-swatchCircle" style="background:${t.swatch};color:${t.fg};border-color:${curTheme === t.id ? 'var(--accent)' : t.border};">${curTheme === t.id ? '✓' : (t.id === 'eink' ? '墨' : '')}</span>
              <span>${escapeHtml(t.label)}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="wr-field" style="margin-bottom:0;">默认阅读字体（阅读页底部「Aa」菜单可精细调节字重/间距）
        <div class="wr-fontGrid" style="margin-top:6px;">
          ${WEREAD_FONTS.map(f => `
            <button type="button" class="wr-fontCard ${curFont === f.id ? 'active' : ''}" data-set-font="${f.id}">
              <span class="wr-fontCardTitle" style="font-family:${escapeHtml(f.stack)};">${escapeHtml(f.label)}</span>
              <span class="wr-fontCardSub">${escapeHtml(f.sub)}</span>
            </button>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="wr-card">
      <h3 class="wr-cardTitle">终端形态与屏幕优化预设</h3>
      <div class="wr-segGroup" style="width:100%;margin-bottom:8px;flex-wrap:wrap;">
        <button type="button" class="wr-segBtn ${s.deviceMode === 'phone' ? 'active' : ''}" style="flex:1;" data-devmode="phone">安卓手机竖屏</button>
        <button type="button" class="wr-segBtn ${s.deviceMode === 'eink' && tapMode !== 'keysOnly' ? 'active' : ''}" style="flex:1;" data-devmode="eink">汉王墨水屏 (触控+按键)</button>
        <button type="button" class="wr-segBtn ${s.deviceMode === 'eink' && tapMode === 'keysOnly' ? 'active' : ''}" style="flex:1;" data-devmode="eink-stylus">汉王 N10 (电磁笔+侧键)</button>
      </div>
      <p style="margin:0 0 10px;font-size:12px;color:var(--fg-muted);line-height:1.5;">
        • <b>安卓手机竖屏</b>：20:9 单栏沉浸、上下叠排双语、屏幕下半中区单手拇指下翻、底部抽屉交互。<br/>
        • <b>汉王墨水屏宽屏</b>：纯黑白零动画防残影、宽屏自动双栏对开/左右并排双语对照、右侧无闪烁停靠栏、书架与目录零滚动分页。<br/>
        • <b>汉王 N10 电磁笔专享</b>：开启手写笔防误触翻页（仅侧键与底部显式翻页栏翻页，防止电磁笔悬停划线时误翻页）。
      </p>
      <div class="wr-field">分栏版式
        <div class="wr-segGroup">
          <button type="button" class="wr-segBtn ${colMode === 'auto' ? 'active' : ''}" data-set-col="auto">自动(宽屏双栏)</button>
          <button type="button" class="wr-segBtn ${colMode === 'single' ? 'active' : ''}" data-set-col="single">单栏适宽</button>
          <button type="button" class="wr-segBtn ${colMode === 'double' ? 'active' : ''}" data-set-col="double">双栏对开</button>
        </div>
      </div>
      <div class="wr-field">双语对照排版
        <div class="wr-segGroup">
          <button type="button" class="wr-segBtn ${biMode === 'auto' ? 'active' : ''}" data-set-bi="auto">自动(手机上下/宽屏左右)</button>
          <button type="button" class="wr-segBtn ${biMode === 'stacked' ? 'active' : ''}" data-set-bi="stacked">上下叠排</button>
          <button type="button" class="wr-segBtn ${biMode === 'parallel' ? 'active' : ''}" data-set-bi="parallel">左右并排</button>
        </div>
      </div>
      <div class="wr-field" style="margin-bottom:0;">点击翻页热区
        <div class="wr-segGroup" style="flex-wrap:wrap;">
          <button type="button" class="wr-segBtn ${tapMode === 'ergonomic' ? 'active' : ''}" data-set-tap="ergonomic">单手拇指</button>
          <button type="button" class="wr-segBtn ${tapMode === 'classic' ? 'active' : ''}" data-set-tap="classic">经典三区</button>
          <button type="button" class="wr-segBtn ${tapMode === 'bottomNext' ? 'active' : ''}" data-set-tap="bottomNext">下半屏下翻</button>
          <button type="button" class="wr-segBtn ${tapMode === 'keysOnly' ? 'active' : ''}" data-set-tap="keysOnly">笔防误触(按键翻页)</button>
        </div>
      </div>
    </div>

    <div class="wr-card">
      <h3 class="wr-cardTitle">物理翻页键 / 汉王 9 键侧键适配</h3>
      <p style="margin:0 0 8px;font-size:12px;color:var(--fg-muted);">
        已内置音量键、PageUp/PageDown 及汉王方向键 (DPAD 19/20/21/22)。<br/>
        当前上一页按键：${escapeHtml(s.prevKeys.join(', '))}<br/>
        当前下一页按键：${escapeHtml(s.nextKeys.join(', '))}
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="wr-btnGhost" data-capture="prev">${state.keyCaptureTarget === 'prev' ? '请按下实体上一页键...' : '录制上一页按键'}</button>
        <button type="button" class="wr-btnGhost" data-capture="next">${state.keyCaptureTarget === 'next' ? '请按下实体下一页键...' : '录制下一页按键'}</button>
      </div>
    </div>

    <p style="margin:8px 0 16px;text-align:center;font-size:12px;color:var(--fg-muted);">
      DSH 双语精读 客户端 v${escapeHtml(APP_VERSION)}
    </p>
  `
}

function render() {
  renderStatusBanners()
  if (state.reader) return
  const bodyHtml = state.tab === 'notes' ? renderNotes() : state.tab === 'settings' ? renderSettings() : renderShelf()
  const shelfLayout = state.settings?.shelfLayout || 'list'

  appEl.innerHTML = `
    <div class="wr-shell">
      <header class="wr-topbar">
        <span class="wr-brand">DSH 双语精读</span>
        <div style="display:flex;align-items:center;gap:8px;">
          ${state.outboxCount > 0 ? `<span class="wr-badge">待传 ${state.outboxCount}</span>` : ''}
          ${state.tab === 'shelf' ? `
            <button type="button" class="wr-iconBtn" data-act="toggle-shelf-layout">${shelfLayout === 'grid' ? '☰ 列表' : '⊞ 宫格'}</button>
          ` : ''}
          <button type="button" class="wr-iconBtn" data-act="top-sync">${state.syncing ? '同步中...' : '↻ 同步'}</button>
        </div>
      </header>
      <main class="wr-main">${bodyHtml}</main>
      <nav class="wr-tabbar">
        <button type="button" class="wr-tabBtn ${state.tab === 'shelf' ? 'active' : ''}" data-tab="shelf">书架</button>
        <button type="button" class="wr-tabBtn ${state.tab === 'notes' ? 'active' : ''}" data-tab="notes">笔记</button>
        <button type="button" class="wr-tabBtn ${state.tab === 'settings' ? 'active' : ''}" data-tab="settings">设置</button>
      </nav>
    </div>
  `

  appEl.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      state.tab = btn.dataset.tab
      render()
    }
  })

  appEl.querySelector('[data-act="top-sync"]').onclick = () => performSync(false)
  const layoutBtn = appEl.querySelector('[data-act="toggle-shelf-layout"]')
  if (layoutBtn) {
    layoutBtn.onclick = async () => {
      const next = (state.settings?.shelfLayout || 'list') === 'grid' ? 'list' : 'grid'
      await updateSettings({ shelfLayout: next })
      state.shelfPage = 0
      render()
    }
  }

  const bindDownloadActions = beforeRun => {
    appEl.querySelectorAll('[data-act="dl-all-md"]').forEach(btn => {
      btn.onclick = async () => { await beforeRun?.(); await performSync(false, { includePdfs: false }) }
    })
    appEl.querySelectorAll('[data-act="dl-all-files"]').forEach(btn => {
      btn.onclick = async () => { await beforeRun?.(); await performSync(false, { includePdfs: true }) }
    })
    bindSyncCardActions(appEl)
  }

  if (state.tab === 'shelf') {
    const bindSearchHits = root => {
      root?.querySelectorAll('[data-act="clear-shelf-search"]').forEach(el => {
        el.onclick = () => { state.searchQuery = ''; render() }
      })
      root?.querySelectorAll('[data-open-book]').forEach(el => { el.onclick = () => openBook(el.dataset.openBook) })
      root?.querySelectorAll('[data-search-jump]').forEach(btn => {
        btn.onclick = () => openBook(btn.dataset.searchJump, btn.dataset.jumpBlock, btn.dataset.jumpView, state.searchQuery.trim())
      })
    }
    const scheduleSearch = () => {
      clearTimeout(state.libSearch.timer); state.libSearch.ctrl?.abort()
      const q = state.searchQuery.trim()
      if (!q) {
        state.libSearch = { loading: false, query: '', data: null, timer: null, ctrl: null }
        const h = document.getElementById('wr-lib-search-host'); if (h) h.innerHTML = ''; return
      }
      const ctrl = new AbortController()
      state.libSearch = { ...state.libSearch, loading: true, query: q, ctrl }
      const paint = () => {
        const h = document.getElementById('wr-lib-search-host'); if (!h) return
        const tl = q.toLowerCase()
        const tMatches = (state.library.documents ?? []).filter(d => [d.name, d.author, d.titleSource].filter(Boolean).join(' ').toLowerCase().includes(tl))
        h.innerHTML = renderLibrarySearchSectionHtml(state.libSearch, state.searchQuery, tMatches); bindSearchHits(h)
      }
      paint()
      state.libSearch.timer = setTimeout(async () => {
        try {
          const data = await readerApi.searchLibrary(state.settings, q, {
            documents: state.library.documents ?? [], meta: state.library.meta ?? {}, signal: ctrl.signal,
          })
          if (!ctrl.signal.aborted && state.searchQuery.trim() === q) {
            state.libSearch = { ...state.libSearch, loading: false, query: q, data }; paint()
          }
        } catch {}
      }, 140)
    }
    const bindShelfBody = () => {
      bindDownloadActions()
      const root = document.getElementById('wr-shelf-results') || appEl
      root.querySelectorAll('[data-folder]').forEach(btn => { btn.onclick = () => { state.selectedFolder = btn.dataset.folder; state.shelfPage = 0; render() } })
      root.querySelector('[data-shelf-page="prev"]')?.addEventListener('click', () => { if (state.shelfPage > 0) { state.shelfPage--; render() } })
      root.querySelector('[data-shelf-page="next"]')?.addEventListener('click', () => { if (state.shelfPage < state.shelfTotalPages - 1) { state.shelfPage++; render() } })
      root.querySelectorAll('[data-read-book]').forEach(btn => { btn.onclick = e => { e.stopPropagation(); openBook(btn.dataset.readBook) } })
      root.querySelectorAll('[data-dl-book]').forEach(btn => {
        btn.onclick = async e => {
          e.stopPropagation(); const id = btn.dataset.dlBook; state.downloadingId = id; render()
          try {
            const res = await readerApi.downloadBookOffline(state.settings, id); state.cachedIds.add(id)
            showToast(`已缓存离线（含 ${res.assetsCount} 张插图）`)
          } catch (err) { showToast(err.message || '离线下载失败') } finally { state.downloadingId = ''; render() }
        }
      })
      bindSearchHits(root); hydrateShelfCovers()
    }
    bindShelfBody()
    const search = appEl.querySelector('[data-act="search-shelf"]')
    if (search) search.oninput = () => {
      state.searchQuery = search.value; state.shelfPage = 0
      const box = document.getElementById('wr-shelf-results')
      if (box) { box.innerHTML = renderShelfBody(); bindShelfBody(); scheduleSearch() }
      else render()
    }
  } else if (state.tab === 'notes') {
    const ns = appEl.querySelector('[data-act="search-notes"]')
    if (ns) ns.oninput = () => { state.noteSearch = ns.value; render() }
    const nd = appEl.querySelector('[data-act="filter-note-doc"]')
    if (nd) nd.onchange = () => { state.noteDocFilter = nd.value; render() }
    appEl.querySelectorAll('[data-jump-note]').forEach(btn => {
      btn.onclick = () => {
        const mark = state.bookmarks.find(b => b.id === btn.dataset.jumpNote)
        if (!mark) return
        const taskId = mark.source?.id || state.library.documents?.find(d => d.documentId === mark.documentId)?.id
        if (!taskId) return showToast('未找到对应书籍')
        openBook(taskId, mark.selector?.startBlockId || '', mark.selector?.view || 'translation')
      }
    })
    appEl.querySelectorAll('[data-del-note]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.delNote
        await readerApi.postBookmarkAction(state.settings, { remove: id })
        state.bookmarks = state.bookmarks.filter(b => b.id !== id)
        await offlineDb.saveBookmarks(state.bookmarks)
        showToast('已删除书签')
        render()
      }
    })
  } else if (state.tab === 'settings') {
    const readConn = () => ({
      serverUrl: document.getElementById('set-url').value.trim().replace(/\/+$/, ''),
      token: document.getElementById('set-token').value.trim(),
      deviceName: document.getElementById('set-devname').value.trim() || '我的移动设备',
    })
    appEl.querySelector('[data-act="save-conn"]').onclick = async () => {
      await updateSettings(readConn())
      showToast('连接配置已保存')
    }
    appEl.querySelector('[data-act="test-conn"]').onclick = async () => {
      const next = await updateSettings(readConn())
      try {
        const res = await readerApi.testConnection(next)
        showToast(`连接成功！云端共 ${res.documents ?? 0} 篇文献`)
      } catch (err) {
        showToast(err.message || '连接失败')
      }
    }
    appEl.querySelector('[data-act="sync-now"]').onclick = async () => {
      await updateSettings(readConn())
      await performSync(false)
    }
    bindDownloadActions(() => updateSettings(readConn()))
    appEl.querySelectorAll('[data-sync-scope]').forEach(btn => {
      btn.onclick = async () => {
        await updateSettings({ syncIncludePdfs: btn.dataset.syncScope === 'all' })
        render()
      }
    })
    appEl.querySelectorAll('[data-set-theme]').forEach(btn => {
      btn.onclick = async () => {
        const theme = btn.dataset.setTheme
        await updateSettings({
          theme,
          deviceMode: theme === 'eink' ? 'eink' : state.settings.deviceMode === 'eink' ? 'phone' : state.settings.deviceMode,
        })
        render()
      }
    })
    appEl.querySelectorAll('[data-set-font]').forEach(btn => {
      btn.onclick = async () => {
        await updateSettings({ fontFamily: btn.dataset.setFont })
        render()
      }
    })
    appEl.querySelectorAll('[data-devmode]').forEach(btn => {
      btn.onclick = async () => {
        const presets = {
          'eink-stylus': [{ deviceMode: 'eink', theme: 'eink', tapZoneMode: 'keysOnly', showPageTurnBar: true }, '已启用汉王 N10 电磁笔+侧键专享模式'],
          eink: [{ deviceMode: 'eink', theme: 'eink', tapZoneMode: 'classic', showPageTurnBar: false }, '已启用汉王墨水屏模式'],
          phone: [{ deviceMode: 'phone', theme: 'paper', tapZoneMode: 'ergonomic', showPageTurnBar: false }, '已切换为安卓手机竖屏模式'],
        }
        const [patch, msg] = presets[btn.dataset.devmode] || presets.phone
        await updateSettings({ ...patch, columnLayout: 'auto', bilingualLayout: 'auto' })
        showToast(msg); render()
      }
    })
    appEl.querySelectorAll('[data-set-col]').forEach(btn => { btn.onclick = async () => { await updateSettings({ columnLayout: btn.dataset.setCol }); render() } })
    appEl.querySelectorAll('[data-set-bi]').forEach(btn => { btn.onclick = async () => { await updateSettings({ bilingualLayout: btn.dataset.setBi }); render() } })
    appEl.querySelectorAll('[data-set-tap]').forEach(btn => {
      btn.onclick = async () => {
        await updateSettings({ tapZoneMode: btn.dataset.setTap, showPageTurnBar: btn.dataset.setTap === 'keysOnly' ? true : state.settings.showPageTurnBar })
        render()
      }
    })
    appEl.querySelectorAll('[data-capture]').forEach(btn => {
      btn.onclick = async () => {
        const dir = btn.dataset.capture
        if (state.keyCaptureTarget === dir) {
          state.keyCaptureTarget = null
          await nativeBridge.stopKeyCapture()
        } else {
          state.keyCaptureTarget = dir
          await nativeBridge.startKeyCapture()
        }
        render()
      }
    })
  }
}

async function handleCapturedKey(codeOrName) {
  if (!state.keyCaptureTarget) return
  const targetField = state.keyCaptureTarget === 'prev' ? 'prevKeys' : 'nextKeys'
  const current = state.settings[targetField] ?? []
  if (!current.includes(codeOrName)) {
    await updateSettings({ [targetField]: [...current, codeOrName] })
  }
  state.keyCaptureTarget = null
  await nativeBridge.stopKeyCapture()
  showToast(`已绑定按键: ${codeOrName}`)
  render()
}

window.addEventListener('keydown', e => {
  if (state.keyCaptureTarget) {
    e.preventDefault()
    void handleCapturedKey(e.key || e.keyCode)
    return
  }
  if (!state.reader && state.tab === 'shelf' && state.settings) {
    const isPrev = state.settings.prevKeys?.includes(e.key) || state.settings.prevKeys?.includes(e.keyCode)
    const isNext = state.settings.nextKeys?.includes(e.key) || state.settings.nextKeys?.includes(e.keyCode)
    if (isPrev && state.shelfPage > 0) {
      e.preventDefault()
      state.shelfPage--
      render()
    } else if (isNext && state.shelfPage < state.shelfTotalPages - 1) {
      e.preventDefault()
      state.shelfPage++
      render()
    }
  }
})

window.addEventListener('reader:key-captured', e => {
  if (state.keyCaptureTarget && e.detail?.keyCode != null) {
    void handleCapturedKey(e.detail.keyCode)
  }
})

window.addEventListener('reader:physical-key', e => {
  if (state.reader || state.tab !== 'shelf') return
  if (e.detail?.direction === 'prev' && state.shelfPage > 0) {
    state.shelfPage--
    render()
  } else if (e.detail?.direction === 'next' && state.shelfPage < state.shelfTotalPages - 1) {
    state.shelfPage++
    render()
  }
})

window.addEventListener('online', () => {
  if (state.settings) void readerApi.flushOutbox(state.settings).then(() => refreshLocalState()).then(() => render())
})

let lastBackExitAt = 0
nativeBridge.setBackHandler(() => {
  if (state.reader) return state.reader.handleBack()
  if (state.openingId) { state.openAbortController?.abort(); return true }
  if (state.tab !== 'shelf') { state.tab = 'shelf'; render(); return true }
  if (state.searchQuery || state.selectedFolder !== 'all') {
    state.searchQuery = ''
    state.libSearch = { loading: false, query: '', data: null, timer: null, ctrl: null }
    state.selectedFolder = 'all'
    state.shelfPage = 0
    render()
    return true
  }
  const now = Date.now()
  if (now - lastBackExitAt < 1800) return false
  lastBackExitAt = now
  showToast('再按一次退出应用')
  return true
})

async function bootstrap() {
  state.settings = await offlineDb.getSettings()
  applyThemeAttributes(state.settings)
  await refreshLocalState()
  render()
  // Silent background sync if configured or served from sync-server
  if (state.settings.serverUrl || !nativeBridge.isNative()) {
    void performSync(true)
  }
}

bootstrap()
