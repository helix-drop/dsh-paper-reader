function ReaderTocSidebar({
  readingScript,
  readingTitle,
  progressPct,
  tocWidth,
  setTocWidth,
  setTocOpen,
  tocTab,
  setTocTab,
  activeOutline,
  tocGroups,
  savedMarks,
  jumpBlock,
  bookSearchQuery,
  setBookSearchQuery,
  bookSearchResult,
  bookSearchCursor,
  onBookSearchStep,
  onJumpSearchHit,
  searchInputRef,
  onQuickBookmark,
}) {
  const activeTab = bookSearchQuery.trim()
    ? 'search'
    : tocTab === 'marks'
      ? 'marks'
      : tocTab === 'search'
        ? 'search'
        : 'outline'
  const matches = bookSearchResult?.matches ?? []
  return h('aside', { className: 'rr-tocPanel', 'aria-label': '独立目录', style: { width: tocWidth + 'px' }, ...zhScriptAttrs(readingScript) },
    h('div', { className: 'rr-tocBookMeta' },
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', { className: 'rr-tocBookTitle', title: readingTitle || '' }, readingTitle || '阅读目录'),
        progressPct != null ? h('div', { className: 'rr-tocBookSub' }, `当前阅读 ${progressPct}%`) : null
      ),
      onQuickBookmark ? button('+ 书签', onQuickBookmark, 'rr-buttonQuiet', { style: { minHeight: 22, padding: '0 6px', fontSize: 11 }, title: '收藏当前段落为书签' }) : null,
      button('收起', () => setTocOpen(false), 'rr-buttonQuiet', { style: { minHeight: 22, padding: '0 6px', fontSize: 11 } })
    ),
    h('div', { className: 'rr-wrSearchInputRow', style: { marginBottom: 6 } },
      h('input', {
        ref: searchInputRef,
        type: 'search',
        className: 'rr-wrSearchInput',
        value: bookSearchQuery,
        onChange: e => setBookSearchQuery(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter' && matches.length) {
            e.preventDefault()
            onBookSearchStep(e.shiftKey ? -1 : 1)
          }
        },
        placeholder: '在全书（原文/译文）中搜索...',
        'aria-label': '全书内容搜索',
      })
    ),
    !bookSearchQuery.trim() ? h('div', { className: 'rr-tocHeader' },
      h('div', { className: 'rr-wrTocTabs' },
        h('button', { type: 'button', className: `rr-wrTocTab ${activeTab === 'outline' ? 'active' : ''}`, onClick: () => setTocTab('outline') }, `目录 (${(activeOutline.outline ?? []).length})`),
        h('button', { type: 'button', className: `rr-wrTocTab ${activeTab === 'marks' ? 'active' : ''}`, onClick: () => setTocTab('marks') }, `划线 (${savedMarks.length})`)
      )
    ) : null,
    h('input', { type: 'range', min: 180, max: 420, step: 10, value: tocWidth, 'aria-label': '目录宽度', onChange: e => setTocWidth(Number(e.target.value)) }),
    activeTab === 'outline'
      ? h('nav', { 'aria-label': '章节目录' },
          tocGroups.length
            ? tocGroups.map(({ item, children }) =>
                h('div', { key: item.id, className: 'rr-tocChapter' },
                  button(item.label, () => jumpBlock(item.id), 'rr-buttonQuiet'),
                  children.length
                    ? h('details', null,
                        h('summary', null, '小标题 · ' + children.length),
                        children.map(child =>
                          button(child.label, () => jumpBlock(child.id), 'rr-buttonQuiet', {
                            key: child.id,
                            style: { paddingLeft: (child.level - 1) * 8 + 'px' }
                          })
                        )
                      )
                    : null
                )
              )
            : h('p', { className: 'rr-pipelineNote' }, '本文档暂无目录结构')
        )
      : activeTab === 'marks'
        ? h('div', { className: 'rr-wrTocMarksList' },
            savedMarks.length
              ? savedMarks.map(m =>
                  h('div', { key: m.id, className: 'rr-wrTocMarkCard', onClick: () => jumpBlock(m.blockId, m.view) },
                    h('blockquote', null, m.quote || m.exact),
                    m.comment ? h('p', null, '💭 ' + m.comment) : null
                  )
                )
              : h('p', { className: 'rr-pipelineNote', style: { textAlign: 'center', padding: '16px 0' } }, '本书暂无划线或书签')
          )
        : h('div', { className: 'rr-wrSearchBox' },
            bookSearchQuery.trim()
              ? h('div', { className: 'rr-wrSearchStatus' },
                  h('span', null, matches.length ? `${bookSearchCursor + 1}/${matches.length}（共 ${bookSearchResult.totalMatches} 处）` : '未找到匹配内容'),
                  matches.length > 1
                    ? h('div', { style: { display: 'flex', gap: 4 } },
                        button('↑', () => onBookSearchStep(-1), 'rr-buttonQuiet', { style: { minHeight: 22, padding: '0 6px', fontSize: 11 }, title: '上一条 (Shift+Enter)' }),
                        button('↓', () => onBookSearchStep(1), 'rr-buttonQuiet', { style: { minHeight: 22, padding: '0 6px', fontSize: 11 }, title: '下一条 (Enter)' })
                      )
                    : null
                )
              : h('p', { className: 'rr-pipelineNote', style: { margin: '4px 0' } }, '支持搜索本书译文与原文段落，Ctrl/Cmd+F 快速呼出。'),
            h('div', { className: 'rr-wrTocMarksList' },
              matches.map((hit, idx) => {
                const [b, mid, a] = splitSearchSnippetParts(hit.snippet, hit.matchOffset, hit.matchLen)
                return h('div', {
                  key: `${hit.view}:${hit.blockId}:${idx}`,
                  className: `rr-wrSearchHitCard ${idx === bookSearchCursor ? 'active' : ''}`,
                  onClick: () => onJumpSearchHit(hit, idx),
                },
                  h('div', { className: 'rr-wrSearchHitMeta' },
                    h('span', { className: 'rr-wrSearchBadge' }, hit.view === 'original' ? '原文' : '译文'),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, hit.chapterLabel || '正文段落')
                  ),
                  h('div', { className: 'rr-wrSearchSnippet' }, b, mid ? h('mark', { className: 'rr-searchHit' }, mid) : null, a)
                )
              })
            )
          )
  )
}

function WeReadPopoverPanel({
  activeReaderPanel,
  setActiveReaderPanel,
  wrSettings,
  updateWrSettings,
  paperWidth,
  setPaperWidth,
  storePaperWidth,
  comparisonAvailable,
  splitPdfCompare,
}) {
  const [fontCat, setFontCat] = useState('all')
  if (!activeReaderPanel) return null
  const fontCats = [
    { id: 'all', label: `全部 (${WEREAD_FONTS.length})` },
    { id: 'serif', label: '宋体' },
    { id: 'kaiti', label: '楷仿' },
    { id: 'sans', label: '黑圆' },
    { id: 'western', label: '西文/等宽' },
  ]
  const shownFonts = fontCat === 'all' ? WEREAD_FONTS : WEREAD_FONTS.filter(f => f.cat === fontCat)
  return h('div', { className: 'rr-wrPopoverPanel', role: 'region', 'aria-label': activeReaderPanel === 'theme' ? '背景与亮度设置' : '字体与排版设置' },
    activeReaderPanel === 'theme'
      ? h('div', { className: 'rr-wrPopoverBody' },
          h('div', { className: 'rr-wrPopoverRow' },
            h('span', { className: 'rr-wrPopoverLabel' }, '背景主题'),
            h('div', { className: 'rr-wrSwatchList' },
              WEREAD_THEMES.map(t =>
                h('button', {
                  key: t.id,
                  type: 'button',
                  className: `rr-wrSwatchBtn ${wrSettings.theme === t.id ? 'active' : ''}`,
                  onClick: () => updateWrSettings({ theme: t.id })
                },
                  h('span', {
                    className: 'rr-wrSwatchCircle',
                    style: { background: t.swatch, color: t.fg, borderColor: wrSettings.theme === t.id ? '#2563eb' : t.border }
                  }, wrSettings.theme === t.id ? '✓' : (t.id === 'eink' ? '墨' : '')),
                  h('span', { className: 'rr-wrSwatchName' }, t.label)
                )
              )
            )
          ),
          h('div', { className: 'rr-wrPopoverRow' },
            h('span', { className: 'rr-wrPopoverLabel' }, '护眼亮度'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 320 } },
              h('span', null, '🔅'),
              h('input', {
                type: 'range',
                min: 40,
                max: 100,
                step: 1,
                value: wrSettings.brightness ?? 100,
                onChange: e => updateWrSettings({ brightness: Number(e.target.value) }),
                style: { margin: 0, flex: 1 }
              }),
              h('span', null, '🔆'),
              h('span', { style: { fontSize: 12, minWidth: 38 } }, `${wrSettings.brightness ?? 100}%`)
            ),
            h('span', { className: 'rr-wrPopoverLabel', style: { marginLeft: 12 } }, '版式与版心'),
            !splitPdfCompare ? h('div', { className: 'rr-viewToggle' },
              button('单栏精读', () => updateWrSettings({ desktopLayout: 'scroll' }), (wrSettings.desktopLayout || 'scroll') === 'scroll' ? 'rr-buttonPrimary' : 'rr-buttonQuiet'),
              button('双栏对开', () => updateWrSettings({ desktopLayout: 'spread' }), wrSettings.desktopLayout === 'spread' ? 'rr-buttonPrimary' : 'rr-buttonQuiet')
            ) : null,
            h('div', { className: 'rr-viewToggle' },
              [[680, '窄栏'], [780, '标准'], [940, '宽栏'], [1140, '超宽']].map(([w, lbl]) =>
                button(lbl, () => { setPaperWidth(w); storePaperWidth(w) }, Math.abs(paperWidth - w) < 30 ? 'rr-buttonPrimary' : 'rr-buttonQuiet')
              )
            ),
            button('收起', () => setActiveReaderPanel(null), 'rr-buttonQuiet', { style: { marginLeft: 'auto' } })
          )
        )
      : h('div', { className: 'rr-wrPopoverBody' },
          h('div', { className: 'rr-wrPopoverRow' },
            h('span', { className: 'rr-wrPopoverLabel' }, '字号与字重'),
            h('div', { className: 'rr-wrStepperWrap' },
              button('A−', () => updateWrSettings({ fontSize: Math.max(13, Math.round(((wrSettings.fontSize || 17.5) - 0.5) * 2) / 2) }), 'rr-buttonQuiet'),
              h('input', {
                type: 'range',
                min: 13,
                max: 28,
                step: 0.5,
                value: wrSettings.fontSize || 17.5,
                onChange: e => updateWrSettings({ fontSize: Number(e.target.value) }),
                style: { margin: 0, width: 140 }
              }),
              h('span', { style: { fontSize: 12, fontWeight: 600, minWidth: 42, textAlign: 'center' } }, `${wrSettings.fontSize || 17.5}px`),
              button('A+', () => updateWrSettings({ fontSize: Math.min(28, Math.round(((wrSettings.fontSize || 17.5) + 0.5) * 2) / 2) }), 'rr-buttonQuiet')
            ),
            h('div', { className: 'rr-viewToggle', style: { marginLeft: 8 } },
              [[400, '标准'], [470, '适中'], [520, '中粗'], [600, '加粗']].map(([w, lbl]) =>
                button(lbl, () => updateWrSettings({ fontWeight: w }), (wrSettings.fontWeight || 470) === w ? 'rr-buttonPrimary' : 'rr-buttonQuiet')
              )
            ),
            h('span', { className: 'rr-pipelineNote', style: { margin: '0 0 0 auto' } }, '导出 PDF 同步生效'),
            button('收起', () => setActiveReaderPanel(null), 'rr-buttonQuiet')
          ),
          h('div', { className: 'rr-wrPopoverRow', style: { alignItems: 'flex-start' } },
            h('span', { className: 'rr-wrPopoverLabel', style: { paddingTop: 4 } }, '精选字体'),
            h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'rr-viewToggle', style: { alignSelf: 'flex-start' } },
                fontCats.map(c => button(c.label, () => setFontCat(c.id), fontCat === c.id ? 'rr-buttonPrimary' : 'rr-buttonQuiet', { key: c.id }))
              ),
              h('div', { className: 'rr-wrFontGrid' },
                shownFonts.map(f =>
                  h('button', {
                    key: f.id,
                    type: 'button',
                    className: `rr-wrFontCard ${wrSettings.fontFamily === f.id ? 'active' : ''}`,
                    onClick: () => updateWrSettings({ fontFamily: f.id })
                  },
                    h('span', { className: 'rr-wrFontCardTitle', style: { fontFamily: f.stack } }, f.label),
                    h('span', { className: 'rr-wrFontCardSub' }, f.sub)
                  )
                )
              )
            )
          ),
          h('div', { className: 'rr-wrPopoverRow', style: { flexWrap: 'wrap' } },
            h('span', { className: 'rr-wrPopoverLabel' }, '行距/字距/版式'),
            h('div', { className: 'rr-viewToggle' },
              WEREAD_SPACING_PRESETS.map(p =>
                button(p.label, () => updateWrSettings({ lineHeight: p.lineHeight, paraSpacing: p.paraSpacing, letterSpacing: p.letterSpacing }), Math.abs((wrSettings.lineHeight || 1.82) - p.lineHeight) < 0.04 ? 'rr-buttonPrimary' : 'rr-buttonQuiet', { key: p.id })
              )
            ),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, margin: 0 } },
              `行距 ${wrSettings.lineHeight || 1.82}`,
              h('input', {
                type: 'range',
                min: 1.35,
                max: 2.45,
                step: 0.04,
                value: wrSettings.lineHeight || 1.82,
                onChange: e => updateWrSettings({ lineHeight: Number(e.target.value) }),
                style: { width: 84, margin: 0 }
              })
            ),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, margin: 0 } },
              `段距 ${wrSettings.paraSpacing ?? 0.45}em`,
              h('input', {
                type: 'range',
                min: 0.15,
                max: 1.35,
                step: 0.05,
                value: wrSettings.paraSpacing ?? 0.45,
                onChange: e => updateWrSettings({ paraSpacing: Number(e.target.value) }),
                style: { width: 84, margin: 0 }
              })
            ),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, margin: 0 } },
              `字距 ${wrSettings.letterSpacing ?? 0.01}em`,
              h('input', {
                type: 'range',
                min: 0,
                max: 0.08,
                step: 0.005,
                value: wrSettings.letterSpacing ?? 0.01,
                onChange: e => updateWrSettings({ letterSpacing: Number(e.target.value) }),
                style: { width: 76, margin: 0 }
              })
            ),
            h('div', { className: 'rr-viewToggle' },
              button('首行缩进', () => updateWrSettings({ textIndent: wrSettings.textIndent === false }), wrSettings.textIndent !== false ? 'rr-buttonPrimary' : 'rr-buttonQuiet'),
              button((wrSettings.textAlign || 'justify') === 'justify' ? '两端对齐' : '左对齐', () => updateWrSettings({ textAlign: (wrSettings.textAlign || 'justify') === 'justify' ? 'left' : 'justify' }), (wrSettings.textAlign || 'justify') === 'justify' ? 'rr-buttonPrimary' : 'rr-buttonQuiet')
            ),
            comparisonAvailable
              ? h('div', { className: 'rr-viewToggle' },
                  button('双语并排', () => updateWrSettings({ bilingualLayout: 'parallel' }), (wrSettings.bilingualLayout || 'parallel') === 'parallel' ? 'rr-buttonPrimary' : 'rr-buttonQuiet'),
                  button('双语叠排', () => updateWrSettings({ bilingualLayout: 'stacked' }), wrSettings.bilingualLayout === 'stacked' ? 'rr-buttonPrimary' : 'rr-buttonQuiet')
                )
              : null
          )
        )
  )
}

function WeReadFloatingRail({
  tocOpen,
  setTocOpen,
  onOpenSearch,
  wrSettings,
  updateWrSettings,
  splitPdfCompare,
  activeReaderPanel,
  setActiveReaderPanel,
  onScrollTop,
}) {
  return h('div', { className: 'rr-wrFloatingRail', 'aria-label': '快捷阅读控制栏' },
    h('button', { type: 'button', className: `rr-wrRailBtn ${tocOpen ? 'active' : ''}`, title: tocOpen ? '收起目录' : '展开目录', onClick: () => setTocOpen(v => !v) }, '☰'),
    h('button', { type: 'button', className: 'rr-wrRailBtn', title: '全书内容搜索 (Ctrl/Cmd+F)', onClick: onOpenSearch }, '🔍'),
    !splitPdfCompare ? h('button', {
      type: 'button',
      className: `rr-wrRailBtn ${wrSettings.desktopLayout === 'spread' ? 'active' : ''}`,
      title: wrSettings.desktopLayout === 'spread' ? '切换为单栏精读' : '切换为微信双栏对开',
      onClick: () => updateWrSettings({ desktopLayout: wrSettings.desktopLayout === 'spread' ? 'scroll' : 'spread' }),
    }, wrSettings.desktopLayout === 'spread' ? '▥' : '◫') : null,
    h('button', {
      type: 'button',
      className: `rr-wrRailBtn ${activeReaderPanel === 'theme' ? 'active' : ''}`,
      title: '背景主题与日夜切换',
      onClick: () => setActiveReaderPanel(p => p === 'theme' ? null : 'theme'),
    }, wrSettings.theme === 'dark' || wrSettings.theme === 'night' ? '☀' : '☾'),
    h('button', {
      type: 'button',
      className: `rr-wrRailBtn ${activeReaderPanel === 'typography' ? 'active' : ''}`,
      title: '字体、字号与行距排版',
      onClick: () => setActiveReaderPanel(p => p === 'typography' ? null : 'typography'),
    }, 'Aa'),
    h('button', { type: 'button', className: 'rr-wrRailBtn', title: '回到页首', onClick: onScrollTop }, '↑')
  )
}
