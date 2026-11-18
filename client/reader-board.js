function ReaderTocSidebar({
  readingScript,
  tocWidth,
  setTocWidth,
  setTocOpen,
  tocTab,
  setTocTab,
  activeOutline,
  tocGroups,
  savedMarks,
  reading,
  glossaryQuery,
  setGlossaryQuery,
  jumpBlock,
}) {
  return h('aside', { className: 'rr-tocPanel', 'aria-label': '独立目录', style: { width: tocWidth + 'px' }, ...zhScriptAttrs(readingScript) },
    h('div', { className: 'rr-tocHeader' },
      h('div', { className: 'rr-wrTocTabs' },
        h('button', { type: 'button', className: `rr-wrTocTab ${tocTab === 'outline' ? 'active' : ''}`, onClick: () => setTocTab('outline') }, `目录 (${(activeOutline.outline ?? []).length})`),
        h('button', { type: 'button', className: `rr-wrTocTab ${tocTab === 'marks' ? 'active' : ''}`, onClick: () => setTocTab('marks') }, `划线 (${savedMarks.length})`),
        h('button', { type: 'button', className: `rr-wrTocTab ${tocTab === 'glossary' ? 'active' : ''}`, onClick: () => setTocTab('glossary') }, `术语 (${(reading.glossary ?? []).length})`)
      ),
      button('收起', () => setTocOpen(false), 'rr-buttonQuiet', { style: { minHeight: 24, padding: '0 6px', fontSize: 11 } })
    ),
    h('input', { type: 'range', min: 180, max: 420, step: 10, value: tocWidth, 'aria-label': '目录宽度', onChange: e => setTocWidth(Number(e.target.value)) }),
    tocTab === 'outline'
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
      : tocTab === 'marks'
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
      : h('div', { className: 'rr-wrTocGlossaryList' },
          h('input', {
            type: 'search',
            placeholder: '搜索术语...',
            value: glossaryQuery,
            onChange: e => setGlossaryQuery(e.target.value),
            style: { marginBottom: 8, fontSize: 12, padding: '5px 8px' }
          }),
          (reading.glossary ?? [])
            .filter(g => !glossaryQuery.trim() || [g.source, g.target, g.note].filter(Boolean).join(' ').toLowerCase().includes(glossaryQuery.trim().toLowerCase()))
            .slice(0, 150)
            .map((g, i) =>
              h('div', { key: i, className: 'rr-wrTocGlossaryItem' },
                h('div', { style: { fontWeight: 600, fontSize: 12.5 } }, g.source, ' → ', h('span', { style: { color: 'var(--dsw-alias-brand-primary,#2563eb)' } }, g.target)),
                g.note ? h('div', { style: { fontSize: 11, opacity: 0.75, marginTop: 2 } }, g.note) : null
              )
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
}) {
  if (!activeReaderPanel) return null
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
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, maxWidth: 360 } },
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
            h('span', { className: 'rr-wrPopoverLabel', style: { marginLeft: 16 } }, '版心宽度'),
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
            button('收起', () => setActiveReaderPanel(null), 'rr-buttonQuiet', { style: { marginLeft: 'auto' } })
          ),
          h('div', { className: 'rr-wrPopoverRow' },
            h('span', { className: 'rr-wrPopoverLabel' }, '精选字体'),
            h('div', { className: 'rr-wrFontGrid' },
              WEREAD_FONTS.map(f =>
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
          ),
          h('div', { className: 'rr-wrPopoverRow', style: { flexWrap: 'wrap' } },
            h('span', { className: 'rr-wrPopoverLabel' }, '间距与对齐'),
            h('div', { className: 'rr-viewToggle' },
              WEREAD_SPACING_PRESETS.map(p =>
                button(p.label, () => updateWrSettings({ lineHeight: p.lineHeight, paraSpacing: p.paraSpacing }), Math.abs((wrSettings.lineHeight || 1.82) - p.lineHeight) < 0.04 ? 'rr-buttonPrimary' : 'rr-buttonQuiet')
              )
            ),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, margin: 0 } },
              `行距 ${wrSettings.lineHeight || 1.82}`,
              h('input', {
                type: 'range',
                min: 1.4,
                max: 2.3,
                step: 0.04,
                value: wrSettings.lineHeight || 1.82,
                onChange: e => updateWrSettings({ lineHeight: Number(e.target.value) }),
                style: { width: 90, margin: 0 }
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
                style: { width: 90, margin: 0 }
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
