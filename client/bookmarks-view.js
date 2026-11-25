const BM_PREFS_KEY = 'dsh.bookmarks.prefs.v1'
const BM_COLOR_MAP = {
  gold: '#c89532',
  blue: '#3b76d6',
  green: '#2d9358',
  pink: '#cf4e85',
  purple: '#7c52d9',
}
function readBmPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(BM_PREFS_KEY) || '{}')
    return {
      surface: raw.surface === 'white' ? 'white' : 'paper',
      font: raw.font === 'sans' ? 'sans' : 'serif',
      fontSize: [15, 16.5, 18].includes(raw.fontSize) ? raw.fontSize : 16.5,
      sort: raw.sort === 'recent' ? 'recent' : 'reading',
    }
  } catch {
    return { surface: 'paper', font: 'serif', fontSize: 16.5, sort: 'reading' }
  }
}
function formatBmDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate()
  return y === now.getFullYear() ? `${m}月${day}日` : `${y}年${m}月${day}日`
}
function compareBmReadingOrder(a, b) {
  const oa = Number.isInteger(a.blockOrder) ? a.blockOrder : Number.MAX_SAFE_INTEGER
  const ob = Number.isInteger(b.blockOrder) ? b.blockOrder : Number.MAX_SAFE_INTEGER
  if (oa !== ob) return oa - ob
  const sa = Number.isInteger(a.selector?.start) ? a.selector.start : 0
  const sb = Number.isInteger(b.selector?.start) ? b.selector.start : 0
  if (sa !== sb) return sa - sb
  return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
}
function bookmarkToMarkdown(b) {
  const quote = String(b.quote ?? '').split('\n').map(l => '> ' + l).join('\n')
  const parts = [quote]
  if (b.comment && b.comment.trim()) parts.push(b.comment.trim())
  if (Array.isArray(b.tags) && b.tags.length) parts.push(b.tags.map(t => `#${t}`).join(' '))
  return parts.join('\n\n')
}

function BookmarkLibrary({ onOpenPaper, onOpenTask }) {
  const [marks, setMarks] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [onlyCommented, setOnlyCommented] = useState(false)
  const [colorFilter, setColorFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [prefs, setPrefs] = useState(readBmPrefs)
  const [editingId, setEditingId] = useState(null)
  const [editComment, setEditComment] = useState('')
  const [editTags, setEditTags] = useState('')
  const [editColor, setEditColor] = useState('gold')
  const [savingId, setSavingId] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [citeTarget, setCiteTarget] = useState(null)
  const [copiedId, setCopiedId] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const mainRef = useRef(null)

  const updatePrefs = patch => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(BM_PREFS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }
  const flashNotice = msg => {
    setNotice(msg)
    setTimeout(() => setNotice(cur => (cur === msg ? '' : cur)), 2400)
  }

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/paper-reader/pipeline/bookmarks')
      .then(r => r.json())
      .then(v => { setMarks(v.bookmarks ?? []); setError('') })
      .catch(() => setError('书签加载失败'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const docs = useMemo(() => {
    const map = new Map()
    for (const b of marks) {
      const id = b.documentId
      const existing = map.get(id)
      const avail = b.sourceAvailable !== false
      if (!existing) {
        map.set(id, {
          id,
          title: b.document?.title ?? id,
          kind: b.document?.kind ?? 'book',
          source: b.source,
          citation: b.document?.citation ?? null,
          available: avail,
          count: 1,
          commented: b.comment?.trim() ? 1 : 0,
          latestAt: b.updatedAt || b.createdAt || '',
        })
      } else {
        existing.count += 1
        if (b.comment?.trim()) existing.commented += 1
        if (avail) existing.available = true
        if (!existing.citation && b.document?.citation) existing.citation = b.document.citation
        const ts = b.updatedAt || b.createdAt || ''
        if (ts > existing.latestAt) existing.latestAt = ts
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1
      return String(b.latestAt).localeCompare(String(a.latestAt))
    })
  }, [marks])

  const allTags = useMemo(() => {
    const counts = new Map()
    for (const b of marks) {
      for (const t of b.tags ?? []) {
        const clean = String(t).trim()
        if (clean) counts.set(clean, (counts.get(clean) ?? 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [marks])

  const totalCommented = useMemo(() => marks.filter(b => b.comment?.trim()).length, [marks])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return marks.filter(b => {
      if (documentId && b.documentId !== documentId) return false
      if (onlyCommented && !b.comment?.trim()) return false
      if (colorFilter && (b.color || 'gold') !== colorFilter) return false
      if (tagFilter && !(b.tags ?? []).includes(tagFilter)) return false
      if (needle) {
        const hay = [b.quote, b.comment, b.chapter, ...(b.tags ?? []), b.document?.title].join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [marks, documentId, onlyCommented, colorFilter, tagFilter, query])

  const groups = useMemo(() => {
    if (prefs.sort === 'recent' && !documentId) {
      const sorted = [...filtered].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      const runs = []
      for (const item of sorted) {
        const prev = runs.at(-1)
        if (prev && prev.docId === item.documentId) prev.items.push(item)
        else runs.push({
          key: `${item.documentId}-${runs.length}`,
          docId: item.documentId,
          title: item.document?.title ?? item.documentId,
          kind: item.document?.kind ?? 'book',
          source: item.source,
          citation: item.document?.citation ?? null,
          available: item.sourceAvailable !== false,
          items: [item],
        })
      }
      return runs
    }
    const byDoc = new Map()
    for (const item of filtered) {
      let g = byDoc.get(item.documentId)
      if (!g) {
        g = {
          key: item.documentId,
          docId: item.documentId,
          title: item.document?.title ?? item.documentId,
          kind: item.document?.kind ?? 'book',
          source: item.source,
          citation: item.document?.citation ?? null,
          available: item.sourceAvailable !== false,
          latestAt: item.updatedAt || item.createdAt || '',
          items: [],
        }
        byDoc.set(item.documentId, g)
      }
      g.items.push(item)
      const ts = item.updatedAt || item.createdAt || ''
      if (ts > g.latestAt) g.latestAt = ts
    }
    const list = [...byDoc.values()].sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1
      return String(b.latestAt).localeCompare(String(a.latestAt))
    })
    for (const g of list) {
      g.items.sort(prefs.sort === 'recent'
        ? (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
        : compareBmReadingOrder)
    }
    return list
  }, [filtered, prefs.sort, documentId])

  const selectedDoc = documentId ? docs.find(d => d.id === documentId) ?? null : null
  const hasFilters = Boolean(query.trim() || onlyCommented || colorFilter || tagFilter)

  const openMarkSource = b => {
    if (b.sourceAvailable === false) {
      flashNotice('该书签对应的原文献已不在文献库中')
      return
    }
    const blockId = b.selector?.startBlockId
    const view = b.selector?.view
    if (b.source?.kind === 'paper') onOpenPaper(b.source.id, blockId, view)
    else if (b.source?.id) onOpenTask(b.source.id, blockId, view)
  }
  const openDocSource = doc => {
    if (!doc || doc.available === false) {
      flashNotice('该文献已不在文献库中')
      return
    }
    if (doc.source?.kind === 'paper') onOpenPaper(doc.source.id)
    else if (doc.source?.id) onOpenTask(doc.source.id)
  }

  const startEdit = b => {
    setConfirmDeleteId(null)
    setEditingId(b.id)
    setEditComment(b.comment ?? '')
    setEditTags((b.tags ?? []).join('，'))
    setEditColor(b.color || 'gold')
  }
  const cancelEdit = () => { setEditingId(null); setSavingId(null) }
  const saveEdit = async b => {
    if (savingId) return
    setSavingId(b.id)
    const parsedTags = editTags.split(/[，,]/).map(x => x.trim()).filter(Boolean)
    try {
      const r = await fetch('/api/paper-reader/pipeline/bookmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updateBookmark: { id: b.id, comment: editComment, tags: parsedTags, color: editColor } }),
      })
      const val = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(val.error || '保存评注失败')
      setMarks(prev => prev.map(x => x.id === b.id ? { ...x, comment: editComment, tags: parsedTags, color: editColor, updatedAt: val.updatedAt || new Date().toISOString() } : x))
      setEditingId(null)
      flashNotice('评注已保存')
    } catch (e) {
      setError(e.message || '保存失败')
    } finally {
      setSavingId(null)
    }
  }

  const remove = async id => {
    try {
      const r = await fetch('/api/paper-reader/pipeline/bookmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remove: id }),
      })
      if (!r.ok) throw new Error('删除失败')
      setMarks(prev => prev.filter(x => x.id !== id))
      setConfirmDeleteId(null)
      if (editingId === id) setEditingId(null)
      flashNotice('已删除摘录')
    } catch {
      setError('删除失败')
    }
  }

  const copySingle = async b => {
    try {
      await navigator.clipboard.writeText(bookmarkToMarkdown(b))
      setCopiedId(b.id)
      setTimeout(() => setCopiedId(cur => (cur === b.id ? '' : cur)), 1600)
    } catch {
      flashNotice('复制失败')
    }
  }

  const copyGroupMarkdown = async (title, items) => {
    const sections = [`# ${title}\n`]
    let lastChapter = ''
    for (const b of items) {
      if (prefs.sort === 'reading' && b.chapter && b.chapter !== lastChapter) {
        sections.push(`## ${b.chapter}\n`)
        lastChapter = b.chapter
      }
      sections.push(bookmarkToMarkdown(b) + '\n')
    }
    try {
      await navigator.clipboard.writeText(sections.join('\n').trim() + '\n')
      flashNotice(`已复制 ${items.length} 条读书笔记`)
    } catch {
      flashNotice('复制失败')
    }
  }

  const exportFile = async format => {
    try {
      const response = await fetch('/api/paper-reader/pipeline/bookmarks/export?format=' + format + '&documentId=' + encodeURIComponent(documentId) + '&q=' + encodeURIComponent(query))
      if (!response.ok) throw new Error()
      const url = URL.createObjectURL(await response.blob())
      const a = document.createElement('a')
      const baseName = selectedDoc ? selectedDoc.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) : '书签与读书笔记'
      a.href = url
      a.download = `${baseName}.${format === 'json' ? 'json' : 'md'}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setError('导出失败')
    }
  }

  const openExcerptCite = b => setCiteTarget({
    taskId: b.source?.kind === 'task' ? b.source.id : '',
    documentId: b.documentId,
    title: b.document?.title ?? b.documentId,
    kind: b.document?.kind ?? 'book',
    citation: b.document?.citation ?? null,
    pages: b.pages ?? '',
    chapterTitle: cleanCiteHeadingText(b.chapter ?? ''),
  })
  const openDocCite = doc => setCiteTarget({
    taskId: doc.source?.kind === 'task' ? doc.source.id : '',
    documentId: doc.id ?? doc.docId,
    title: doc.title,
    kind: doc.kind ?? 'book',
    citation: doc.citation ?? null,
    pages: '',
  })
  const handleSavedCitation = (docId, savedMeta) => {
    setMarks(prev => prev.map(x => x.documentId === docId
      ? { ...x, document: { ...x.document, citation: savedMeta } }
      : x))
  }

  const selectDoc = id => {
    setDocumentId(id)
    setConfirmDeleteId(null)
    if (mainRef.current) mainRef.current.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const fontStack = prefs.font === 'sans'
    ? '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'
    : '"Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", Georgia, serif'

  const sheetStyle = {
    '--bm-font-family': fontStack,
    '--bm-font-size': `${prefs.fontSize}px`,
  }

  const renderExcerpt = (b, showChapterInline) => {
    const accent = BM_COLOR_MAP[b.color] || BM_COLOR_MAP.gold
    const isEditing = editingId === b.id
    const isConfirming = confirmDeleteId === b.id
    const script = detectZhScript(b.quote)
    return h('article', { className: `rr-bmItem ${isEditing ? 'is-editing' : ''}`, key: b.id, style: { '--bm-accent': accent } },
      h('blockquote', { className: 'rr-bmQuote', ...zhScriptAttrs(script) }, b.quote),
      !isEditing && b.comment?.trim() ? h('div', { className: 'rr-bmNote' },
        h('span', { className: 'rr-bmNoteLabel' }, '评注'),
        h('p', { className: 'rr-bmNoteText' }, b.comment)
      ) : null,
      isEditing ? h('div', {
        className: 'rr-bmEditor',
        onKeyDown: e => {
          if (e.key === 'Escape') { e.stopPropagation(); cancelEdit() }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveEdit(b) }
        },
      },
        h('textarea', {
          className: 'rr-bmEditorArea',
          value: editComment,
          onChange: e => setEditComment(e.target.value),
          placeholder: '写下你的阅读想法、批注或关联线索…（⌘/Ctrl + Enter 保存）',
          rows: 3,
          autoFocus: true,
        }),
        h('div', { className: 'rr-bmEditorRow' },
          h('input', {
            className: 'rr-bmEditorTags',
            type: 'text',
            value: editTags,
            onChange: e => setEditTags(e.target.value),
            placeholder: '标签（用逗号分隔）',
          }),
          h('div', { className: 'rr-bmColorDots', role: 'group', 'aria-label': '选择标记色' },
            HIGHLIGHT_COLORS.map(c => h('button', {
              key: c.id,
              type: 'button',
              className: `rr-bmColorDot ${editColor === c.id ? 'active' : ''}`,
              style: { background: BM_COLOR_MAP[c.id] || c.hex },
              title: c.label,
              onClick: () => setEditColor(c.id),
            }))
          ),
          h('div', { className: 'rr-bmEditorBtns' },
            button('取消', cancelEdit, 'rr-buttonQuiet rr-bmMiniBtn', { disabled: savingId === b.id }),
            button(savingId === b.id ? '保存中…' : '保存', () => saveEdit(b), 'rr-buttonPrimary rr-bmMiniBtn', { disabled: savingId === b.id })
          )
        )
      ) : null,
      h('footer', { className: 'rr-bmMeta' },
        h('div', { className: 'rr-bmMetaLeft' },
          h('time', { dateTime: b.createdAt || '' }, formatBmDate(b.createdAt)),
          b.pages ? h('span', { className: 'rr-bmPageBadge', title: '原文页码' }, `p. ${b.pages}`) : null,
          showChapterInline && b.chapter ? h('span', { className: 'rr-bmMetaChap', title: b.chapter }, '· ', b.chapter) : null,
          b.selector?.view === 'original' ? h('span', { className: 'rr-bmViewBadge' }, '原文') : null,
          ...(b.tags ?? []).map(t => h('button', {
            key: t,
            type: 'button',
            className: `rr-bmTagPill ${tagFilter === t ? 'active' : ''}`,
            onClick: () => setTagFilter(cur => (cur === t ? '' : t)),
          }, `#${t}`))
        ),
        h('div', { className: `rr-bmActions ${isConfirming || isEditing ? 'is-pinned' : ''}` },
          b.sourceAvailable !== false
            ? h('button', { type: 'button', className: 'rr-bmActionBtn', onClick: () => openMarkSource(b), title: '在阅读器中定位到这段原文' },
                icon('external', 12), h('span', null, '定位原文'))
            : h('span', { className: 'rr-bmMissingHint' }, '原文献已移除'),
          h('button', { type: 'button', className: 'rr-bmActionBtn', onClick: () => openExcerptCite(b), title: '生成学术引用格式（GB/T 7714、《社会》、APA、BibTeX 等）' },
            icon('quote', 12), h('span', null, '生成引用')),
          h('button', { type: 'button', className: 'rr-bmActionBtn', onClick: () => isEditing ? cancelEdit() : startEdit(b) },
            icon('edit', 12), h('span', null, b.comment?.trim() ? '编辑评注' : '写评注')),
          h('button', { type: 'button', className: 'rr-bmActionBtn', onClick: () => copySingle(b) },
            icon(copiedId === b.id ? 'check' : 'copy', 12), h('span', null, copiedId === b.id ? '已复制' : '复制')),
          isConfirming
            ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'rr-bmActionBtn is-danger', onClick: () => remove(b.id) }, '确认删除'),
                h('button', { type: 'button', className: 'rr-bmActionBtn', onClick: () => setConfirmDeleteId(null) }, '取消')
              )
            : h('button', { type: 'button', className: 'rr-bmActionBtn is-delete', onClick: () => setConfirmDeleteId(b.id), title: '删除此条摘录' },
                icon('trash', 12), h('span', null, '删除'))
        )
      )
    )
  }

  return h('div', { className: 'rr-bmWorkspace', 'data-surface': prefs.surface },
    h('aside', { className: 'rr-bmSidebar', 'aria-label': '书签导航与筛选' },
      h('div', { className: 'rr-bmSideHead' },
        h('span', { className: 'rr-sidebarTitle' }, '读书笔记'),
        h('span', { className: 'rr-taskCountPill' }, `${marks.length} 条`)
      ),
      h('div', { className: 'rr-bmQuickNav' },
        h('button', {
          type: 'button',
          className: `rr-bmSideItem ${!documentId && !onlyCommented ? 'active' : ''}`,
          onClick: () => { setOnlyCommented(false); selectDoc('') },
        },
          h('span', { className: 'rr-bmSideItemLabel' }, icon('book', 14), h('span', null, '全部摘录')),
          h('span', { className: 'rr-folderCount' }, marks.length)
        ),
        h('button', {
          type: 'button',
          className: `rr-bmSideItem ${onlyCommented ? 'active' : ''}`,
          onClick: () => setOnlyCommented(v => !v),
        },
          h('span', { className: 'rr-bmSideItemLabel' }, icon('note', 14), h('span', null, '含评注笔记')),
          h('span', { className: 'rr-folderCount' }, totalCommented)
        )
      ),
      h('div', { className: 'rr-folderSectionLabel' }, `按文献浏览（${docs.length}）`),
      h('nav', { className: 'rr-bmBookList', 'aria-label': '按书籍或论文筛选' },
        docs.length ? docs.map(doc => h('button', {
          key: doc.id,
          type: 'button',
          className: `rr-bmBookBtn ${documentId === doc.id ? 'active' : ''} ${!doc.available ? 'is-missing' : ''}`,
          onClick: () => selectDoc(documentId === doc.id ? '' : doc.id),
          title: doc.title,
        },
          h('div', { className: 'rr-bmBookBtnBody' },
            h('span', { className: 'rr-bmBookIcon' }, icon(doc.kind === 'paper' ? 'file' : 'book', 13)),
            h('span', { className: 'rr-bmBookTitle' }, doc.title)
          ),
          h('div', { className: 'rr-bmBookBtnMeta' },
            !doc.available ? h('span', { className: 'rr-bmBookGone' }, '已移除') : null,
            h('span', { className: 'rr-folderCount' }, doc.count)
          )
        )) : h('p', { className: 'rr-bmSideEmpty' }, loading ? '加载中…' : '暂无已摘录文献')
      ),
      h('div', { className: 'rr-bmSideFooter' },
        h('div', { className: 'rr-bmColorFilterRow' },
          h('span', { className: 'rr-bmSideSubLabel' }, '标记色'),
          h('div', { className: 'rr-bmColorDots' },
            h('button', {
              type: 'button',
              className: `rr-bmColorAll ${!colorFilter ? 'active' : ''}`,
              onClick: () => setColorFilter(''),
              title: '全部颜色',
            }, '全部'),
            HIGHLIGHT_COLORS.map(c => h('button', {
              key: c.id,
              type: 'button',
              className: `rr-bmColorDot ${colorFilter === c.id ? 'active' : ''}`,
              style: { background: BM_COLOR_MAP[c.id] || c.hex },
              title: c.label,
              onClick: () => setColorFilter(cur => (cur === c.id ? '' : c.id)),
            }))
          )
        ),
        allTags.length ? h('div', { className: 'rr-bmTagCloud' },
          h('span', { className: 'rr-bmSideSubLabel' }, '标签'),
          h('div', { className: 'rr-bmTagCloudList' },
            allTags.map(([tag, count]) => h('button', {
              key: tag,
              type: 'button',
              className: `rr-bmTagPill ${tagFilter === tag ? 'active' : ''}`,
              onClick: () => setTagFilter(cur => (cur === tag ? '' : tag)),
            }, `#${tag} `, h('span', { className: 'rr-bmTagCnt' }, count)))
          )
        ) : null
      )
    ),
    h('main', { className: 'rr-bmMain', ref: mainRef },
      h('div', { className: 'rr-bmToolbar' },
        h('div', { className: 'rr-bmSearchWrap' },
          h('span', { className: 'rr-bmSearchIcon' }, icon('search', 14)),
          h('input', {
            type: 'search',
            className: 'rr-bmSearchInput',
            value: query,
            onChange: e => setQuery(e.target.value),
            placeholder: '搜索摘录、评注、章节或标签…',
            'aria-label': '搜索书签',
          }),
          query ? h('button', { type: 'button', className: 'rr-bmSearchClear', onClick: () => setQuery(''), 'aria-label': '清空搜索' }, icon('close', 12)) : null
        ),
        h('div', { className: 'rr-bmToolbarRight' },
          h('div', { className: 'rr-bmSeg', role: 'group', 'aria-label': '排序方式' },
            h('button', { type: 'button', className: `rr-bmSegBtn ${prefs.sort === 'reading' ? 'active' : ''}`, 'aria-pressed': prefs.sort === 'reading', onClick: () => updatePrefs({ sort: 'reading' }), title: '按原文段落先后顺序排列，适合连续复读' }, '文中顺序'),
            h('button', { type: 'button', className: `rr-bmSegBtn ${prefs.sort === 'recent' ? 'active' : ''}`, 'aria-pressed': prefs.sort === 'recent', onClick: () => updatePrefs({ sort: 'recent' }), title: '按最近记录时间排列' }, '最新')
          ),
          h('div', { className: 'rr-bmSeg', role: 'group', 'aria-label': '阅读外观' },
            h('button', { type: 'button', className: `rr-bmSegBtn ${prefs.surface === 'paper' ? 'active' : ''}`, 'aria-pressed': prefs.surface === 'paper', onClick: () => updatePrefs({ surface: 'paper' }) }, '柔纸'),
            h('button', { type: 'button', className: `rr-bmSegBtn ${prefs.surface === 'white' ? 'active' : ''}`, 'aria-pressed': prefs.surface === 'white', onClick: () => updatePrefs({ surface: 'white' }) }, '纯白')
          ),
          h('div', { className: 'rr-bmSeg', role: 'group', 'aria-label': '字体与字号' },
            h('button', { type: 'button', className: `rr-bmSegBtn ${prefs.font === 'serif' ? 'active' : ''}`, 'aria-pressed': prefs.font === 'serif', onClick: () => updatePrefs({ font: 'serif' }) }, '宋体'),
            h('button', { type: 'button', className: `rr-bmSegBtn ${prefs.font === 'sans' ? 'active' : ''}`, 'aria-pressed': prefs.font === 'sans', onClick: () => updatePrefs({ font: 'sans' }) }, '黑体'),
            h('button', {
              type: 'button',
              className: 'rr-bmSegBtn',
              disabled: prefs.fontSize <= 15,
              onClick: () => updatePrefs({ fontSize: prefs.fontSize > 16.5 ? 16.5 : 15 }),
              title: '缩小字号',
            }, 'A-'),
            h('button', {
              type: 'button',
              className: 'rr-bmSegBtn',
              disabled: prefs.fontSize >= 18,
              onClick: () => updatePrefs({ fontSize: prefs.fontSize < 16.5 ? 16.5 : 18 }),
              title: '增大字号',
            }, 'A+')
          ),
          h('details', {
            className: 'rr-bmExportMenu',
            onClick: e => { if (e.target.closest('button')) e.currentTarget.open = false },
            onKeyDown: e => { if (e.key === 'Escape') e.currentTarget.open = false },
          },
            h('summary', { className: 'rr-bmExportBtn' }, icon('download', 13), h('span', null, '导出')),
            h('div', { className: 'rr-bmExportPop' },
              h('button', { type: 'button', className: 'rr-bmExportItem', onClick: () => copyGroupMarkdown(selectedDoc ? selectedDoc.title : '读书笔记汇编', filtered) },
                icon('copy', 13), h('span', null, '复制为 Markdown')),
              h('button', { type: 'button', className: 'rr-bmExportItem', onClick: () => exportFile('markdown') },
                icon('file', 13), h('span', null, '下载 Markdown (.md)')),
              h('button', { type: 'button', className: 'rr-bmExportItem', onClick: () => exportFile('json') },
                icon('download', 13), h('span', null, '下载 JSON 备份'))
            )
          )
        )
      ),
      error ? h('div', { className: 'rr-bmErrorBar', role: 'alert' }, error) : null,
      h('div', { className: 'rr-bmSheetWrap' },
        h('div', { className: 'rr-bmSheet', style: sheetStyle },
          selectedDoc ? h('header', { className: 'rr-bmDocHero' },
            h('div', { className: 'rr-bmDocHeroTop' },
              h('span', { className: 'rr-bmDocKindTag' }, selectedDoc.kind === 'paper' ? '论文笔记' : '书籍笔记'),
              selectedDoc.available === false ? h('span', { className: 'rr-bmBookGone' }, '原文献已移除') : null
            ),
            h('h1', { className: 'rr-bmDocHeroTitle', ...zhScriptAttrs(detectZhScript(selectedDoc.title)) }, selectedDoc.title),
            h('div', { className: 'rr-bmDocHeroSub' },
              h('span', null, `${filtered.length} 条摘录${selectedDoc.commented ? ` · ${selectedDoc.commented} 条评注` : ''}${selectedDoc.latestAt ? ` · 最近记录于 ${formatBmDate(selectedDoc.latestAt)}` : ''}`),
              h('div', { className: 'rr-bmDocHeroActions' },
                selectedDoc.available !== false ? h('button', { type: 'button', className: 'rr-bmHeroLink', onClick: () => openDocSource(selectedDoc) }, icon('book', 13), h('span', null, '打开全文')) : null,
                h('button', { type: 'button', className: 'rr-bmHeroLink', onClick: () => openDocCite(selectedDoc) }, icon('quote', 13), h('span', null, '生成引用')),
                h('button', { type: 'button', className: 'rr-bmHeroLink', onClick: () => copyGroupMarkdown(selectedDoc.title, filtered) }, icon('copy', 13), h('span', null, '复制本书笔记'))
              )
            )
          ) : h('header', { className: 'rr-bmAllHero' },
            h('div', { className: 'rr-bmAllHeroLeft' },
              h('h1', { className: 'rr-bmAllHeroTitle' }, onlyCommented ? '评注笔记集' : '读书笔记汇编'),
              h('span', { className: 'rr-bmAllHeroSub' },
                hasFilters
                  ? `已筛选 ${filtered.length} 条摘录（共 ${marks.length} 条）`
                  : `${docs.length} 部文献 · ${marks.length} 条摘录${totalCommented ? ` · ${totalCommented} 条评注` : ''}`)
            ),
            hasFilters ? button('重置筛选', () => { setQuery(''); setOnlyCommented(false); setColorFilter(''); setTagFilter('') }, 'rr-buttonQuiet rr-bmMiniBtn') : null
          ),
          loading && !marks.length ? h('div', { className: 'rr-bmEmptyState' }, h('p', null, '正在载入读书笔记…'))
          : !groups.length ? h('div', { className: 'rr-bmEmptyState' },
              h('div', { className: 'rr-bmEmptyIcon' }, icon('book', 28)),
              h('h3', null, marks.length ? '没有符合条件的摘录' : '还没有保存任何书签与摘录'),
              h('p', null, marks.length ? '尝试更换关键词或清除左侧筛选条件。' : '阅读书籍或论文时选中文字，即可划线或写下评注，所有内容都会在这里按章节整理成册。'),
              hasFilters ? button('清空筛选', () => { setQuery(''); setOnlyCommented(false); setColorFilter(''); setTagFilter('') }, 'rr-buttonQuiet') : null
            )
          : groups.map(group => {
              let lastChapter = ''
              const showChapterHeaders = prefs.sort === 'reading'
              return h('section', { className: 'rr-bmBookSection', key: group.key },
                !selectedDoc ? h('div', { className: 'rr-bmBookHeading' },
                  h('div', { className: 'rr-bmBookHeadingLeft' },
                    h('h2', {
                      className: 'rr-bmBookHeadingTitle',
                      ...zhScriptAttrs(detectZhScript(group.title)),
                      onClick: () => selectDoc(group.docId),
                      title: '点击专注阅读本书笔记',
                    }, group.title),
                    h('span', { className: 'rr-bmBookHeadingCount' }, `${group.items.length} 条`)
                  ),
                  h('div', { className: 'rr-bmBookHeadingOps' },
                    h('button', { type: 'button', className: 'rr-bmInlineLink', onClick: () => openDocCite(group) }, '生成引用'),
                    h('button', { type: 'button', className: 'rr-bmInlineLink', onClick: () => selectDoc(group.docId) }, '专注本书'),
                    group.available !== false ? h('button', { type: 'button', className: 'rr-bmInlineLink', onClick: () => openDocSource(group) }, '打开全文') : null
                  )
                ) : null,
                h('div', { className: 'rr-bmStream' },
                  group.items.map(b => {
                    const chapChanged = showChapterHeaders && b.chapter && b.chapter !== lastChapter
                    if (showChapterHeaders && b.chapter) lastChapter = b.chapter
                    return h(React.Fragment, { key: b.id },
                      chapChanged ? h('h3', { className: 'rr-bmChapterHeading', ...zhScriptAttrs(detectZhScript(b.chapter)) },
                        h('span', { className: 'rr-bmChapterMark', 'aria-hidden': true }, '§'),
                        h('span', null, b.chapter)
                      ) : null,
                      renderExcerpt(b, !showChapterHeaders)
                    )
                  })
                )
              )
            })
        )
      ),
      notice ? h('div', { className: 'rr-toastBox', role: 'status' }, icon('check', 14), h('span', null, notice)) : null,
      citeTarget ? h(CitationModal, { target: citeTarget, onClose: () => setCiteTarget(null), onSavedCitation: handleSavedCitation }) : null
    )
  )
}
