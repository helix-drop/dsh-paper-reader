function ReaderPage({ t, onClose, sessionForPaper, promptSession, listModels, selectSessionModel, openSession }) {
  const [view, setView] = useState('library')
  const [documents, setDocuments] = useState(null)
  const [failure, setFailure] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [readingTarget, setReadingTarget] = useState(null)
  const [category, setCategory] = useState('all')
  const [processingReading, setProcessingReading] = useState(null)
  const [readerMeta, setReaderMeta] = useState(null)
  const [folders, setFolders] = useState([])
  const [itemMeta, setItemMeta] = useState({})
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [showHidden, setShowHidden] = useState(false)
  const [assignModal, setAssignModal] = useState(null)
  const [renameModal, setRenameModal] = useState(null)
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false)
  const [draggedDocId, setDraggedDocId] = useState(null)
  const [dragOverFolder, setDragOverFolder] = useState(null)
  const [sortMode, setSortMode] = useState('recent')
  const [readingTick, setReadingTick] = useState(0)
  const [toast, setToast] = useState('')
  const [serverProgress, setServerProgress] = useState({})
  const [cloudSyncOpen, setCloudSyncOpen] = useState(false)
  const [cloudSyncStatus, setCloudSyncStatus] = useState(null)
  const lastCloudSyncAtRef = useRef(null)
  const exitPipelineReadingRef = useRef(null)

  const isReading = view === 'reader' || !!processingReading

  const showToast = msg => {
    setToast(msg)
    setTimeout(() => setToast(''), 2600)
  }

  const loadLibrary = useCallback(async () => {
    setFailure('')
    setReadingTick(t => t + 1)
    try {
      const [r, pr] = await Promise.all([
        fetch('/api/paper-reader/pipeline/library'),
        fetch('/api/paper-reader/pipeline/progress').catch(() => null),
      ])
      const v = await r.json()
      if (!r.ok) throw new Error(v.error ?? '文献库加载失败')
      const docs = v.documents ?? []
      setDocuments(docs)
      if (v.folders) setFolders(v.folders)
      if (v.meta) setItemMeta(v.meta)
      let srvItems = {}
      if (pr?.ok) {
        const pv = await pr.json().catch(() => null)
        if (pv?.items) {
          srvItems = pv.items
          setServerProgress(pv.items)
        }
      }
      // Migrate historical localStorage reading progress to backend store so cloud sync picks up all books
      try {
        const toMigrate = []
        for (const d of docs) {
          const keys = [
            d.documentId,
            d.id,
            d.id ? 'document:' + d.id : null,
            d.documentId && d.documentId.startsWith('document:') ? d.documentId.slice(9) : null,
          ].filter(Boolean)
          let localBest = null
          let srvBest = null
          for (const k of keys) {
            const s = srvItems[k]
            if (s && (!srvBest || (s.updatedAt || 0) > (srvBest.updatedAt || 0))) srvBest = s
            try {
              const raw = localStorage.getItem('paper-reader-reading:' + k) || sessionStorage.getItem('paper-reader-reading:' + k)
              if (raw) {
                const p = JSON.parse(raw)
                if (p && typeof p === 'object') {
                  const pTime = Number(p.updatedAt) || 1
                  if (!localBest || pTime > (Number(localBest.updatedAt) || 1)) localBest = { ...p, updatedAt: pTime }
                }
              }
            } catch {}
          }
          if (localBest && (!srvBest || localBest.updatedAt > (Number(srvBest.updatedAt) || 0))) {
            toMigrate.push({
              ...localBest,
              documentId: d.documentId || ('document:' + d.id),
              taskId: localBest.taskId || d.id,
              title: localBest.title || d.name,
              deviceName: localBest.deviceName || 'PC DSH',
            })
          }
        }
        if (toMigrate.length) {
          const mr = await fetch('/api/paper-reader/pipeline/progress', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: toMigrate }),
          })
          if (mr.ok) {
            const mv = await mr.json().catch(() => null)
            if (mv?.items) setServerProgress(mv.items)
          }
        }
      } catch {}
    } catch (e) {
      setFailure(e.message)
    }
  }, [])

  useEffect(() => { loadLibrary() }, [loadLibrary])
  useEffect(() => {
    let alive = true
    const poll = () => {
      fetch('/api/paper-reader/pipeline/sync/status')
        .then(r => (r.ok ? r.json() : null))
        .then(v => {
          if (!alive || !v) return
          setCloudSyncStatus(v)
          if (v.lastSyncAt && lastCloudSyncAtRef.current && v.lastSyncAt !== lastCloudSyncAtRef.current) {
            loadLibrary()
          }
          if (v.lastSyncAt) lastCloudSyncAtRef.current = v.lastSyncAt
        })
        .catch(() => {})
    }
    poll()
    const ms = cloudSyncStatus?.background?.running ? 3000 : 45000
    const timer = setInterval(poll, ms)
    return () => { alive = false; clearInterval(timer) }
  }, [cloudSyncStatus?.background?.running, cloudSyncOpen, loadLibrary])
  useEffect(() => {
    if (view === 'library') {
      setReadingTick(t => t + 1)
    }
  }, [view])
  useEffect(() => { setOffset(0) }, [query, category, selectedFolder, showHidden, documents?.length, sortMode])

  const openDocument = (id, blockId = '', readingView = '') => {
    setReadingTarget({ id, blockId, view: readingView })
    setView('reader')
  }
  const closeReading = () => {
    setReadingTarget(null)
    setReaderMeta(null)
    setView('library')
    setReadingTick(t => t + 1)
    loadLibrary()
  }
  const handleCloseReading = () => {
    setReadingTick(t => t + 1)
    if (view === 'reader') closeReading()
    else {
      exitPipelineReadingRef.current?.()
      setProcessingReading(null)
    }
  }

  const openPaper = (file, blockId, readingView) => {
    const d = documents?.find(d => d.legacyPaperFile === file)
    if (d) openDocument(d.id, blockId, readingView)
    else setFailure('旧书签的论文尚未接入，请刷新文献库')
  }

  const nav = v => {
    if (view === 'reader') {
      setReadingTarget(null)
      setReaderMeta(null)
    }
    if (v === 'processing' && processingReading) {
      exitPipelineReadingRef.current?.()
      setProcessingReading(null)
    }
    setView(v)
    if (v === 'library') loadLibrary()
  }

  const CATEGORIES = [
    { id: 'all', label: '全部' },
    { id: 'book', label: '整本书' },
    { id: 'paper', label: '论文' },
    { id: 'chapter', label: '章节' },
    { id: 'collection', label: '合集' }
  ]

  const handleCreateFolder = () => {
    setCreateFolderModalOpen(true)
  }

  const onFolderCreated = f => {
    setFolders(prev => [...prev.filter(x => x.id !== f.id), f])
    setSelectedFolder(f.id)
    showToast(`已创建文件夹「${f.name}」`)
  }

  const handleDeleteFolder = async (e, f) => {
    e.stopPropagation()
    if (!window.confirm(`确定删除文件夹「${f.name}」？其中的文献将变为未归类。`)) return
    try {
      const r = await fetch('/api/paper-reader/pipeline/folders/' + encodeURIComponent(f.id), { method: 'DELETE' })
      if (!r.ok) throw new Error('删除失败')
      setFolders(prev => prev.filter(x => x.id !== f.id))
      if (selectedFolder === f.id) setSelectedFolder('all')
      showToast(`已删除文件夹「${f.name}」`)
    } catch (e) {
      alert('删除失败: ' + e.message)
    }
  }

  const toggleHideDoc = async id => {
    const meta = itemMeta[id] ?? {}
    const nextHidden = !meta.hidden
    setItemMeta(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), hidden: nextHidden } }))
    try {
      await fetch('/api/paper-reader/pipeline/items/' + encodeURIComponent(id) + '/meta', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hidden: nextHidden })
      })
      showToast(nextHidden ? '已隐藏文献' : '已取消隐藏')
    } catch {}
  }

  const handleDeleteDoc = async (id, name) => {
    if (!window.confirm('确定删除文献「' + name + '」？')) return
    try {
      const r = await fetch('/api/paper-reader/pipeline/tasks/' + encodeURIComponent(id), { method: 'DELETE' })
      if (!r.ok) throw new Error('删除失败')
      setDocuments(prev => (prev ?? []).filter(d => d.id !== id))
      showToast('已删除')
    } catch (e) {
      alert('删除失败: ' + e.message)
    }
  }

  const handleDocRenamed = (id, newName) => {
    setDocuments(prev => prev ? prev.map(d => d.id === id ? { ...d, name: newName } : d) : prev)
    showToast('已修改文献名称')
  }

  const handleSaveAssign = async (targetId, folderId) => {
    const current = (itemMeta[targetId]?.folderId ? String(itemMeta[targetId].folderId).split(',').map(s => s.trim()).filter(Boolean) : [])
    let next
    if (folderId === null) {
      next = null
    } else if (typeof folderId === 'string' && folderId.includes(',')) {
      next = folderId
    } else if (current.includes(folderId)) {
      return
    } else {
      next = [...current, folderId].join(',')
    }
    setItemMeta(prev => ({ ...prev, [targetId]: { ...(prev[targetId] ?? {}), folderId: next } }))
    try {
      await fetch('/api/paper-reader/pipeline/items/' + encodeURIComponent(targetId) + '/meta', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: next })
      })
    } catch {}
  }

  const handleRemoveAssign = async (targetId, folderId) => {
    const current = (itemMeta[targetId]?.folderId ? String(itemMeta[targetId].folderId).split(',').map(s => s.trim()).filter(Boolean) : [])
    const next = current.filter(id => id !== folderId).join(',') || null
    setItemMeta(prev => ({ ...prev, [targetId]: { ...(prev[targetId] ?? {}), folderId: next } }))
    try {
      await fetch('/api/paper-reader/pipeline/items/' + encodeURIComponent(targetId) + '/meta', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: next })
      })
    } catch {}
  }

  // Compute folder counts
  const folderCounts = useMemo(() => {
    const c = { all: (documents ?? []).length, uncategorized: 0 }
    for (const f of folders) c[f.id] = 0
    for (const d of (documents ?? [])) {
      const meta = itemMeta[d.id] ?? {}
      const assigned = (meta.folderId ? String(meta.folderId).split(',').map(s => s.trim()).filter(Boolean) : [])
      if (assigned.length === 0) {
        c.uncategorized++
      } else {
        for (const fId of assigned) {
          if (c[fId] !== undefined) c[fId]++
        }
      }
    }
    return c
  }, [documents, folders, itemMeta])

  // Compute category counts
  const categoryCounts = useMemo(() => {
    const c = { all: (documents ?? []).length, book: 0, paper: 0, chapter: 0, collection: 0 }
    for (const d of (documents ?? [])) {
      if (c[d.kind] !== undefined) c[d.kind]++
    }
    return c
  }, [documents])

  const getDocumentProgress = useCallback(d => {
    if (!d) return null
    let best = null
    const keys = [
      d.documentId,
      d.id,
      d.id ? 'document:' + d.id : null,
      d.documentId && d.documentId.startsWith('document:') ? d.documentId.slice(9) : null
    ].filter(Boolean)
    for (const k of keys) {
      const srv = serverProgress[k]
      if (srv && (!best || (srv.updatedAt || 0) > (best.updatedAt || 0))) best = srv
      try {
        const raw = localStorage.getItem('paper-reader-reading:' + k) || sessionStorage.getItem('paper-reader-reading:' + k)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && (!best || (parsed.updatedAt || 0) > (best.updatedAt || 0))) {
            best = parsed
          }
        }
      } catch {}
    }
    return best
  }, [serverProgress])

  const progressMap = useMemo(() => {
    const map = {}
    for (const d of documents ?? []) {
      map[d.id] = getDocumentProgress(d)
    }
    return map
  }, [documents, readingTick, getDocumentProgress])

  const shown = useMemo(() => {
    const filtered = (documents ?? []).filter(d => {
      const meta = itemMeta[d.id] ?? {}
      if (!showHidden && meta.hidden) return false
      if (selectedFolder !== 'all') {
        const currentIds = (meta.folderId ? String(meta.folderId).split(',').map(s => s.trim()).filter(Boolean) : [])
        if (selectedFolder === 'uncategorized') {
          if (currentIds.length > 0) return false
        } else {
          if (!currentIds.includes(selectedFolder)) return false
        }
      }
      if (category !== 'all' && d.kind !== category) return false
      if (!query.trim()) return true
      return [d.name, d.author, d.titleSource].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase())
    })

    if (sortMode === 'recent') {
      return filtered.slice().sort((a, b) => {
        const pA = progressMap[a.id]
        const pB = progressMap[b.id]
        const timeA = pA?.updatedAt || (pA && pA.percent > 0 ? 1 : 0) || 0
        const timeB = pB?.updatedAt || (pB && pB.percent > 0 ? 1 : 0) || 0
        if (timeA && timeB) {
          if (timeB !== timeA) return timeB - timeA
        } else if (timeA && !timeB) {
          return -1
        } else if (!timeA && timeB) {
          return 1
        }
        return 0
      })
    }
    return filtered
  }, [documents, itemMeta, showHidden, selectedFolder, category, query, sortMode, progressMap])

  const currentFilterName = useMemo(() => {
    if (selectedFolder === 'all') return '全部文献'
    if (selectedFolder === 'uncategorized') return '未归类'
    const f = folders.find(x => x.id === selectedFolder)
    return f ? f.name : selectedFolder
  }, [selectedFolder, folders])

  const readingTitle = view === 'reader'
    ? (documents?.find(d => d.id === readingTarget?.id)?.name || '双语精读')
    : (processingReading?.title || '双语精读')
  const readingScript = (view === 'reader' ? readerMeta?.script : processingReading?.script) ?? detectZhScript(readingTitle)

  // Modern Prototype Top Header
  const top = isReading ? (
    h('header', { className: 'rr-header' },
      h('div', { className: 'rr-breadcrumb' },
        button(h(React.Fragment, null, icon('back', 14), '返回文献库'), handleCloseReading, 'rr-headerBackBtn', { style: { marginRight: 6 } }),
        h('span', { style: { color: '#d4d4d8' } }, '/'),
        h('span', { className: 'rr-breadcrumbTitle', ...zhScriptAttrs(readingScript), style: { fontWeight: 600, color: '#18181b', marginLeft: 6 } }, readingTitle)
      ),
      h('div', { className: 'rr-headerActions' },
        button(h(React.Fragment, null, icon('close', 15), '退出阅读'), handleCloseReading, 'rr-buttonQuiet')
      )
    )
  ) : (
    h('header', { className: 'rr-header' },
      h('div', { className: 'rr-topNavWrap' },
        h('div', { className: 'rr-brandPill' },
          h('span', { className: 'rr-brandDot' }),
          h('span', null, 'PAPER READER')
        ),
        h('div', { style: { width: 1, height: 16, background: '#e4e4e7' } }),
        h('nav', { className: 'rr-navTabs' },
          button('文献库', () => nav('library'), `rr-navTab ${view === 'library' ? 'rr-navTabActive' : ''}`),
          button('处理流水线', () => nav('processing'), `rr-navTab ${view === 'processing' ? 'rr-navTabActive' : ''}`),
          button('书签', () => nav('bookmarks'), `rr-navTab ${view === 'bookmarks' ? 'rr-navTabActive' : ''}`)
        )
      ),
      h('div', { className: 'rr-headerActions' },
        button(
          cloudSyncStatus?.background?.running ? '云同步 · 后台同步中' : '云同步',
          () => setCloudSyncOpen(true),
          'rr-buttonQuiet',
          {
            title: cloudSyncStatus?.background?.running
              ? `后台同步中：${cloudSyncStatus.background.currentBook || cloudSyncStatus.background.detail || ''}`
              : (cloudSyncStatus?.lastSyncAt
                  ? `上次后台同步：${new Date(cloudSyncStatus.lastSyncAt).toLocaleString()}`
                  : '配置轻量云服务器并开启后台自动同步'),
          },
        ),
        button(icon('refresh', 16), loadLibrary, 'rr-buttonQuiet rr-buttonIcon', { 'aria-label': '刷新文献库', title: '刷新文献库' }),
        button(h(React.Fragment, null, icon('close', 15), '退出'), onClose, 'rr-buttonQuiet')
      )
    )
  )

  let content
  const props = { sessionForPaper, promptSession, openSession, listModels, selectSessionModel }
  if (view === 'processing') {
    content = h(PipelinePanel, { ...props, mode: 'processing', onReadingChange: setProcessingReading, exitReadingRef: exitPipelineReadingRef })
  } else if (view === 'reader' && readingTarget) {
    content = h(PipelinePanel, { ...props, mode: 'reader', initialTaskId: readingTarget.id, initialBlockId: readingTarget.blockId, initialView: readingTarget.view, onCloseReading: closeReading, onReadingChange: setReaderMeta })
  } else if (view === 'bookmarks') {
    content = h(BookmarkLibrary, { onOpenPaper: openPaper, onOpenTask: openDocument })
  } else {
    // VIEW 1: 文献库 (Library) 2-Column Layout
    content = h('div', { className: 'rr-libraryLayout' },
      // Left Sidebar Drawer (width: 240px)
      h('aside', { className: 'rr-librarySidebar' },
        h('div', { className: 'rr-sidebarHead' },
          h('span', { className: 'rr-sidebarTitle' }, '文献分类'),
          h('button', { type: 'button', className: 'rr-sidebarAddBtn', onClick: handleCreateFolder, title: '新建文件夹' }, '+ 文件夹')
        ),
        h('nav', { className: 'rr-folderListNav', id: 'folder-list' },
          // 全部文献
          h('button', {
            type: 'button',
            className: `rr-folderBtn ${selectedFolder === 'all' ? 'rr-folderBtnActive' : ''} ${dragOverFolder === 'all' ? 'rr-folderDropHover' : ''}`,
            onClick: () => setSelectedFolder('all'),
            onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dragOverFolder !== 'all') setDragOverFolder('all') },
            onDragLeave: () => { if (dragOverFolder === 'all') setDragOverFolder(null) },
            onDrop: e => {
              e.preventDefault()
              setDragOverFolder(null)
              setDraggedDocId(null)
              showToast('已在全部文献中')
            }
          },
            h('div', { className: 'rr-folderBtnLeft' },
              icon('triangleRight', 10),
              h('span', null, '全部文献')
            ),
            h('span', { className: 'rr-folderCount' }, folderCounts.all)
          ),
          // 未归类 (Drop target: clears all folders)
          h('button', {
            type: 'button',
            className: `rr-folderBtn ${selectedFolder === 'uncategorized' ? 'rr-folderBtnActive' : ''} ${dragOverFolder === 'uncategorized' ? 'rr-folderDropHover' : ''}`,
            onClick: () => setSelectedFolder('uncategorized'),
            onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverFolder !== 'uncategorized') setDragOverFolder('uncategorized') },
            onDragLeave: () => { if (dragOverFolder === 'uncategorized') setDragOverFolder(null) },
            onDrop: async e => {
              e.preventDefault()
              const id = e.dataTransfer.getData('text/plain')
              setDragOverFolder(null)
              setDraggedDocId(null)
              if (id) {
                await handleSaveAssign(id, null)
                showToast('已移至未归类')
              }
            }
          },
            h('div', { className: 'rr-folderBtnLeft' },
              icon('triangleRight', 10),
              h('span', null, '未归类')
            ),
            h('span', { className: 'rr-folderCount' }, folderCounts.uncategorized)
          ),
          // Section label: 我的文件夹
          h('div', { className: 'rr-folderSectionLabel' },
            icon('triangleDown', 8),
            h('span', null, '我的文件夹')
          ),
          // Custom folders
          folders.map(f => {
            const isCurrent = selectedFolder === f.id
            const isHover = dragOverFolder === f.id
            return h('button', {
              key: f.id,
              type: 'button',
              className: `rr-folderBtn ${isCurrent ? 'rr-folderBtnActive' : ''} ${isHover ? 'rr-folderDropHover' : ''}`,
              onClick: () => setSelectedFolder(f.id),
              onDragOver: e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dragOverFolder !== f.id) setDragOverFolder(f.id) },
              onDragLeave: () => { if (dragOverFolder === f.id) setDragOverFolder(null) },
              onDrop: async e => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/plain')
                setDragOverFolder(null)
                setDraggedDocId(null)
                if (id) {
                  const current = (itemMeta[id]?.folderId ? String(itemMeta[id].folderId).split(',').map(s => s.trim()).filter(Boolean) : [])
                  if (current.includes(f.id)) {
                    showToast(`已在「${f.name}」中`)
                  } else {
                    await handleSaveAssign(id, f.id)
                    showToast(`已归入「${f.name}」`)
                  }
                }
              }
            },
              h('div', { className: 'rr-folderBtnLeft' },
                icon('triangleRight', 10),
                h('span', null, f.name)
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { className: 'rr-folderCount' }, folderCounts[f.id] || 0),
                h('span', {
                  className: 'rr-folderDeleteBtn',
                  title: '删除文件夹',
                  onClick: e => handleDeleteFolder(e, f)
                }, '×')
              )
            )
          })
        )
      ),

      // Right Main Area
      h('main', { className: 'rr-libraryMain' },
        h('div', { className: 'rr-libraryContentWrapper' },
          // Filter Bar: Search + Filter Badge + Show Hidden Toggle
          h('div', { className: 'rr-libraryFilterBar' },
            h('div', { className: 'rr-librarySearchWrap' },
              icon('search', 14),
              h('input', {
                type: 'search',
                className: 'rr-librarySearchInput',
                value: query,
                onChange: e => setQuery(e.target.value),
                placeholder: '搜索文献标题或作者...',
                'aria-label': '搜索文献'
              })
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('button', {
                type: 'button',
                className: 'rr-sidebarAddBtn',
                onClick: () => setSortMode(m => m === 'recent' ? 'default' : 'recent'),
                title: sortMode === 'recent' ? '当前：按最近阅读记录排序（点击切换为默认排序）' : '当前：默认排序（点击切换为按最近阅读排序）',
                style: sortMode === 'recent' ? { borderColor: 'var(--dsw-alias-brand-primary, #3b82f6)', color: 'var(--dsw-alias-brand-primary, #2563eb)' } : {}
              }, sortMode === 'recent' ? '按最近阅读 ▾' : '默认排序 ▾'),
              h('span', { className: 'rr-libraryFilterBadge' }, `${currentFilterName} · ${shown.length}`),
              h('button', {
                type: 'button',
                className: 'rr-sidebarAddBtn',
                onClick: () => setShowHidden(v => !v),
                title: showHidden ? '隐藏已隐藏文献' : '显示已隐藏文献'
              }, showHidden ? '隐藏已屏蔽' : '显示已屏蔽')
            )
          ),

          // Category Filter Pills
          h('div', { className: 'rr-categoryFilterRow' },
            CATEGORIES.map(cat => h('button', {
              key: cat.id,
              type: 'button',
              className: `rr-categoryPill ${category === cat.id ? 'rr-categoryPillActive' : ''}`,
              onClick: () => setCategory(cat.id)
            }, `${cat.label} (${categoryCounts[cat.id] || 0})`))
          ),

          failure ? h('div', { className: 'rr-stateCard', role: 'alert' }, failure, button('重试', loadLibrary)) : null,
          documents === null ? h('p', { style: { color: '#71717a', fontSize: 13, padding: '20px 0' } }, '正在加载文献库...') : null,

          // Documents Card Container
          h('div', { className: 'rr-documentsCardContainer' },
            documents !== null && shown.length === 0 ? (
              h('div', { style: { padding: '40px 20px', textAlign: 'center', color: '#a1a1aa', fontSize: 13 } },
                query || category !== 'all' || selectedFolder !== 'all'
                  ? '暂无匹配文献'
                  : '文献库中暂无文档'
              )
            ) : (
              shown.slice(offset, offset + 40).map(d => {
                const meta = itemMeta[d.id] ?? {}
                const currentIds = (meta.folderId ? String(meta.folderId).split(',').map(s => s.trim()).filter(Boolean) : [])
                const progress = progressMap[d.id]
                const pct = (progress && typeof progress.percent === 'number' && progress.percent > 0) ? progress.percent : 0
                const progressLabel = pct > 0 ? `读至 ${pct}%${progress.page ? ` (第 ${progress.page} 页)` : ''}` : '未读'
                const isUncategorized = currentIds.length === 0

                return h('div', {
                  key: d.id,
                  className: `rr-documentCardItem ${isUncategorized ? 'rr-documentCardItemUncategorized' : ''} ${draggedDocId === d.id ? 'rr-taskDragging' : ''}`,
                  draggable: true,
                  onDragStart: e => {
                    setDraggedDocId(d.id)
                    e.dataTransfer.setData('text/plain', d.id)
                    e.dataTransfer.effectAllowed = 'copyMove'
                  },
                  onDragEnd: () => {
                    setDraggedDocId(null)
                    setDragOverFolder(null)
                  }
                },
                  // Left: Grip + Title + Tags + Subtitle
                  h('div', { className: 'rr-documentCardLeft' },
                    h('div', { className: 'rr-dragGripIcon', title: '拖动归类' },
                      icon('grip', 15)
                    ),
                    h('div', { className: 'rr-documentMetaColumn', ...zhScriptAttrs(detectZhScript([d.name, d.author, d.titleSource].filter(Boolean).join(' '))) },
                      h('div', { className: 'rr-documentTitleRow' },
                        h('h3', { className: 'rr-documentTitleText', onClick: () => openDocument(d.id, progress?.blockId, progress?.view) }, d.name),
                        isUncategorized ? (
                          h('span', { className: 'rr-uncategorizedBadge' },
                            h('span', null, '未归类')
                          )
                        ) : (
                          currentIds.map(fId => {
                            const f = folders.find(x => x.id === fId)
                            if (!f) return null
                            return h('span', { key: fId, className: 'rr-folderPillTag' },
                              h('span', null, f.name),
                              h('button', {
                                type: 'button',
                                title: '移出此文件夹',
                                onClick: e => {
                                  e.stopPropagation()
                                  handleRemoveAssign(d.id, fId)
                                  showToast(`已从「${f.name}」移出`)
                                }
                              }, '×')
                            )
                          })
                        ),
                        meta.hidden ? h('span', { className: 'rr-hiddenTag' }, '已隐藏') : null
                      ),
                      h('div', { className: 'rr-documentSubtitleText' },
                        [d.author, d.titleSource, ({ book: '整书', paper: '论文', chapter: '章节', collection: '合集' })[d.kind]].filter(Boolean).join(' · ')
                      )
                    )
                  ),

                  // Right: Reading Progress + Button + More Menu
                  h('div', { className: 'rr-documentCardRight' },
                    h('div', { className: 'rr-readingProgressWrapper' },
                      h('div', { className: 'rr-readingProgressText' }, progressLabel),
                      h('div', { className: 'rr-readingProgressTrack' },
                        h('div', { className: 'rr-readingProgressFill', style: { width: pct + '%' } })
                      )
                    ),
                    h('button', {
                      type: 'button',
                      className: 'rr-primaryReadBtn',
                      onClick: () => openDocument(d.id, progress?.blockId, progress?.view)
                    }, pct > 0 ? '继续阅读' : '开始阅读'),
                    h('details', {
                      className: 'rr-itemMenu',
                      name: 'rr-document-actions',
                      onKeyDown: e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus() } },
                      onClick: e => { if (e.target.closest('button')) e.currentTarget.open = false }
                    },
                      h('summary', { className: 'rr-sidebarAddBtn' }, '更多'),
                      h('div', { className: 'rr-itemMenuContent' },
                        button(h(React.Fragment, null, icon('edit', 12), '重命名'), () => setRenameModal({ targetId: d.id, currentName: d.name }), 'rr-buttonQuiet rr-buttonCompact'),
                        button(h(React.Fragment, null, icon('folder', 12), '归类'), () => setAssignModal({ targetId: d.id, targetName: d.name, currentFolderId: meta.folderId }), 'rr-buttonQuiet rr-buttonCompact'),
                        button(h(React.Fragment, null, icon(meta.hidden ? 'eyeOff' : 'eye', 12), meta.hidden ? '取消隐藏' : '隐藏'), () => toggleHideDoc(d.id), 'rr-buttonQuiet rr-buttonCompact'),
                        button(h(React.Fragment, null, icon('trash', 12), '删除'), () => handleDeleteDoc(d.id, d.name), 'rr-buttonQuiet rr-buttonCompact', { style: { color: 'var(--dsw-alias-state-error-primary,#d32f2f)' } })
                      )
                    )
                  )
                )
              })
            )
          ),

          // Pagination
          shown.length > 40 ? h('div', { className: 'rr-rowActions', style: { justifyContent: 'center', marginTop: 12 } },
            button('上一页', () => setOffset(Math.max(0, offset - 40)), 'rr-buttonQuiet', { disabled: offset === 0 }),
            h('span', { style: { fontSize: 12, color: '#71717a' } }, (Math.floor(offset / 40) + 1) + ' / ' + Math.ceil(shown.length / 40)),
            button('下一页', () => setOffset(offset + 40), 'rr-buttonQuiet', { disabled: offset + 40 >= shown.length })
          ) : null
        )
      )
    )
  }

  return h('div', { className: 'rr-shell', 'data-chrome': insideDesktopWindow() ? 'desktop' : 'web', 'data-view': isReading ? 'reader' : view },
    h('style', null, CSS),
    insideDesktopWindow() ? h('div', { className: 'rr-desktopDragBar' }) : null,
    top,
    h('div', { className: 'rr-scroll' }, content),
    toast ? h('div', { className: 'rr-toastBox' }, icon('check', 16), h('span', null, toast)) : null,
    renameModal ? h(RenameDocModal, { targetId: renameModal.targetId, currentName: renameModal.currentName, onClose: () => setRenameModal(null), onRenamed: newName => handleDocRenamed(renameModal.targetId, newName) }) : null,
    assignModal ? h(FolderAssignModal, { ...assignModal, folders, onClose: () => setAssignModal(null), onSave: folderId => handleSaveAssign(assignModal.targetId, folderId), onCreateFolder: onFolderCreated }) : null,
    createFolderModalOpen ? h(CreateFolderModal, { onClose: () => setCreateFolderModalOpen(false), onCreated: onFolderCreated }) : null,
    cloudSyncOpen ? h(CloudSyncModal, { onClose: () => setCloudSyncOpen(false), onSynced: loadLibrary }) : null
  )
}
