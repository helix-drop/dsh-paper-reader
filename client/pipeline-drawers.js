function renderPipelineTaskDrawers(ctx) {
  const {
    task,
    selected,
    detailTab,
    setDetailTab,
    setPdfModal,
    openSystemPdf,
    run,
    profileValue,
    editProfile,
    editProfileFields,
    firstSide,
    setFirstSide,
    lastSide,
    setLastSide,
    setMessage,
    profile,
    setProfile,
    profileEdits,
    act,
    api,
    busy,
    chapterLoading,
    chapters,
    updateChapter,
    removeChapter,
    addChapter,
    loadChapters,
    confirmChapterStructure,
    launch,
    environment,
    chooseTask,
    setTask,
    stages,
    stageState,
    glossaryReady,
    publicationAccepted,
    setPublicationAccepted,
    workerChoice,
    setWorkerChoice,
    fallback1,
    setFallback1,
    fallback2,
    setFallback2,
    transcriptionModels,
    fallbackOptions,
    refresh,
    modelKey,
    setModelKey,
    orchestratorEffort,
    setOrchestratorEffort,
    models,
    linguaSettings,
    setLinguaSettings,
    sourceMapPdfId,
    setSourceMapPdfId,
    catalog,
    translationRef,
    resumeWithAntigravity,
    translationDone,
    reviewDone,
    deliveryDone,
    reviewWorkerChoice,
    setReviewWorkerChoice,
    reviewOrchestratorChoice,
    setReviewOrchestratorChoice,
    reviewEffortChoice,
    setReviewEffortChoice,
  } = ctx

  return h(
    React.Fragment,
    null,
    detailTab !== 'flow'
      ? h(
          'div',
          { className: 'rr-drawerHeading' },
          h('h3', null, ({ structure: '文档范围', chapters: '章节结构', models: '模型与并发设置', records: '处理记录' })[detailTab]),
          button('关闭', () => setDetailTab('flow'), 'rr-buttonQuiet')
        )
      : null,
    h(
      'section',
      { hidden: detailTab !== 'structure', className: 'rr-taskDrawer' },
      h('h3', null, '文档范围与体例'),
      task.legacy?.artifacts?.sourcePdf || task.input.type === 'pdf'
        ? h(
            React.Fragment,
            null,
            button(
              h(React.Fragment, null, icon('pdf', 14), '查看原 PDF'),
              () => setPdfModal({ url: '/api/paper-reader/pipeline/tasks/' + selected + '/source', title: task.name, taskId: selected }),
              'rr-buttonQuiet'
            ),
            button(h(React.Fragment, null, icon('external', 13), '系统打开'), () => openSystemPdf(selected), 'rr-buttonQuiet')
          )
        : null,
      task.inspection ? h('p', { className: 'rr-pipelineNote' }, `${task.inspection.verdict} · ${task.inspection.pages || task.inspection.blocks} ${task.input.type === 'pdf' ? '页' : '块'}`) : null,
      h(ProfileAnalysis, { task, onAnalyze: () => run('inspect', { reanalyze: true, singleStep: true }) }),
      h(
        'details',
        { key: task.profileAnalysis?.completedAt ?? 'initial', open: !task.profileAnalysis || task.profileAnalysis.unresolved?.length > 0 },
        h('summary', null, '调整识别结果'),
        h(
          'div',
          { className: 'rr-pipelineFields' },
          !task.stages.normalize?.state || task.stages.normalize?.state !== 'done'
            ? h(
                'label',
                null,
                '文档体裁',
                h(
                  'select',
                  { value: profileValue.document_type ?? task.kind, onChange: e => editProfile('document_type', e.target.value) },
                  h('option', { value: 'book' }, '整本书'),
                  h('option', { value: 'collection' }, '文章合集'),
                  h('option', { value: 'paper' }, '论文'),
                  h('option', { value: 'chapter' }, '章节节选')
                )
              )
            : null,
          h(
            'label',
            null,
            '原文语言',
            h(
              'select',
              { value: profileValue.language ?? '', onChange: e => editProfile('language', e.target.value) },
              [
                ['', '请选择'],
                ['fr', '法语'],
                ['en', '英语'],
                ['de', '德语'],
                ['zh', '中文'],
                ['ja', '日语'],
                ['es', '西班牙语'],
                ['it', '意大利语'],
                ...(!['', 'fr', 'en', 'de', 'zh', 'ja', 'es', 'it'].includes(profileValue.language ?? '') ? [[profileValue.language, profileValue.language + '（自动识别）']] : []),
              ].map(([value, label]) => h('option', { key: value, value }, label))
            )
          ),
          task.input.type === 'pdf'
            ? h(
                'label',
                null,
                '转写方式',
                h(
                  'select',
                  { value: profileValue.transcription_method ?? 'auto', onChange: e => editProfile('transcription_method', e.target.value) },
                  h('option', { value: 'auto' }, '自动分流'),
                  h('option', { value: 'vision' }, '视觉模型转写')
                )
              )
            : null,
          task.input.type === 'pdf'
            ? h(
                'label',
                null,
                '注释体例',
                h(
                  'select',
                  {
                    value: profileValue.book_type ?? '',
                    onChange: e => {
                      const type = e.target.value
                      editProfileFields({
                        book_type: type,
                        note_location: type === 'no_notes' ? 'none' : type === 'footnote_only' ? 'per_page_bottom' : '',
                        note_numbering: type === 'no_notes' ? 'continuous' : profileValue.note_numbering,
                      })
                    },
                  },
                  [
                    ['', '请选择'],
                    ['footnote_only', '页底脚注'],
                    ['endnote_only', '尾注'],
                    ['mixed', '脚注与尾注'],
                    ['no_notes', '无注释'],
                  ].map(([value, label]) => h('option', { key: value, value }, label))
                )
              )
            : null,
          task.input.type === 'pdf'
            ? h(
                'label',
                null,
                '注释归属',
                h(
                  'select',
                  { value: profileValue.note_location ?? '', onChange: e => editProfile('note_location', e.target.value) },
                  [
                    ['', '请选择'],
                    ['per_page_bottom', '所在页底'],
                    ['chapter_end_notes', '章节末尾'],
                    ['book_end_notes', '整书末尾'],
                    ['mixed', '多种位置'],
                    ['none', '无注释'],
                  ].map(([value, label]) => h('option', { key: value, value }, label))
                )
              )
            : null,
          task.input.type === 'pdf'
            ? h(
                'label',
                null,
                '编号方式',
                h(
                  'select',
                  { value: profileValue.note_numbering ?? '', onChange: e => editProfile('note_numbering', e.target.value) },
                  h('option', { value: '' }, '待识别'),
                  h('option', { value: 'continuous' }, '全文连续'),
                  h('option', { value: 'per_chapter' }, '每章重置'),
                  h('option', { value: 'per_page' }, '每页重置')
                )
              )
            : null,
          task.input.type === 'pdf'
            ? h(
                'label',
                null,
                '页面布局',
                h(
                  'select',
                  { value: profileValue.layout ?? '', onChange: e => editProfile('layout', e.target.value) },
                  h('option', { value: '' }, '待识别'),
                  h('option', { value: 'single' }, '单页单栏'),
                  h('option', { value: 'spread' }, '左右双页扫描'),
                  h('option', { value: 'columns' }, '多栏排版')
                )
              )
            : null,
          task.input.type === 'pdf'
            ? h('label', null, '处理起始 PDF 页', h('input', { type: 'number', min: 1, max: task.inspection?.pages, value: profileValue.start_page ?? 1, onChange: e => editProfile('start_page', Number(e.target.value)) }))
            : null,
          task.input.type === 'pdf'
            ? h('label', null, '处理结束 PDF 页', h('input', { type: 'number', min: 1, max: task.inspection?.pages, value: profileValue.end_page ?? task.inspection?.pages ?? 1, onChange: e => editProfile('end_page', Number(e.target.value)) }))
            : null,
          task.input.type === 'pdf' && ['endnote_only', 'mixed'].includes(profileValue.book_type)
            ? h('label', null, '尾注起始 PDF 页（可选）', h('input', { type: 'number', min: 1, max: task.inspection?.pages, value: profileValue.note_start_page ?? '', placeholder: '可选', onChange: e => { const v = e.target.value; editProfile('note_start_page', v === '' ? undefined : Number(v)) } }))
            : null,
          task.input.type === 'pdf' && ['endnote_only', 'mixed'].includes(profileValue.book_type)
            ? h('label', null, '尾注结束 PDF 页（可选）', h('input', { type: 'number', min: 1, max: task.inspection?.pages, value: profileValue.note_end_page ?? '', placeholder: '可选', onChange: e => { const v = e.target.value; editProfile('note_end_page', v === '' ? undefined : Number(v)) } }))
            : null
        ),
        profileValue.layout === 'spread'
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'rr-pipelineFields' },
                [
                  ['首幅扫描页', firstSide, setFirstSide],
                  ['末幅扫描页', lastSide, setLastSide],
                ].map(([label, value, update]) =>
                  h(
                    'label',
                    { key: label },
                    label,
                    h(
                      'select',
                      { value, onChange: e => update(e.target.value) },
                      h('option', { value: 'both' }, '左右页都保留'),
                      h('option', { value: 'left' }, '仅保留左页'),
                      h('option', { value: 'right' }, '仅保留右页')
                    )
                  )
                )
              ),
              button(
                '生成左右页范围',
                () => {
                  const start = profileValue.start_page
                  const end = profileValue.end_page
                  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
                    setMessage('先填写有效起止页')
                    return
                  }
                  const regions = []
                  for (let page = start; page <= end; page++) {
                    const choice = page === start ? firstSide : page === end ? lastSide : 'both'
                    if (choice !== 'right') regions.push({ page, rect: [0, 0, 0.5, 1] })
                    if (choice !== 'left') regions.push({ page, rect: [0.5, 0, 1, 1] })
                  }
                  editProfile('regions', regions)
                },
                'rr-buttonQuiet'
              )
            )
          : null,
        h(
          'details',
          null,
          h('summary', null, '高级区域映射与完整配置'),
          h('textarea', {
            'aria-label': '文档结构配置',
            value: profile,
            onChange: e => {
              setProfile(e.target.value)
              try {
                profileEdits.current = { ...JSON.parse(e.target.value), confirmed: false }
              } catch {}
            },
            rows: 12,
          })
        )
      ),
      h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('input', { type: 'checkbox', style: { width: 'auto' }, checked: profileValue.confirmed === true, onChange: e => editProfile('confirmed', e.target.checked) }),
        task.input.type === 'pdf' ? '已核对正文范围、布局和注释体例' : '已核对原文语言'
      ),
      button(
        '保存结构配置',
        () =>
          act(async () => {
            let value
            try {
              value = JSON.parse(profile)
            } catch {
              throw new Error('结构配置JSON格式无效')
            }
            await api('/tasks/' + selected + '/profile', 'POST', value)
            setDetailTab('flow')
            setMessage('结构配置已保存')
          }),
        'rr-buttonPrimary',
        { disabled: busy || !task.inspection || task.state === 'running' || profileValue.confirmed !== true }
      )
    ),
    h(
      'section',
      { hidden: detailTab !== 'chapters', className: 'rr-taskDrawer' },
      h('h3', null, '整书章节结构'),
      chapterLoading
        ? h('p', null, '正在提取章节候选...')
        : h(
            'div',
            null,
            chapters.length
              ? h(
                  'div',
                  { style: { maxHeight: '340px', overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '6px', margin: '10px 0' } },
                  chapters.map((ch, idx) =>
                    h(
                      'div',
                      { key: idx, style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '6px 0', borderBottom: idx < chapters.length - 1 ? '1px solid var(--dsw-alias-border-l1)' : 'none' } },
                      h('span', { style: { minWidth: '22px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, '#' + ch.num),
                      h(
                        'select',
                        { style: { width: '85px', fontSize: '11px', padding: '4px' }, value: ch.role_hint ?? 'chapter', onChange: e => updateChapter(idx, 'role_hint', e.target.value) },
                        h('option', { value: 'front_matter' }, '前言'),
                        h('option', { value: 'chapter' }, '正文'),
                        h('option', { value: 'notes' }, '注释'),
                        h('option', { value: 'back_matter' }, '附录')
                      ),
                      h('input', { style: { flex: 1, minWidth: '100px', fontSize: '12px', padding: '4px' }, value: ch.title, placeholder: '章节标题', onChange: e => updateChapter(idx, 'title', e.target.value) }),
                      h('input', { type: 'number', min: 1, max: task?.inspection?.pages, style: { width: '45px', fontSize: '11px', padding: '4px' }, value: ch.start_page ?? '', placeholder: '起', onChange: e => updateChapter(idx, 'start_page', Number(e.target.value)) }),
                      h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' } }, '–'),
                      h('input', { type: 'number', min: 1, max: task?.inspection?.pages, style: { width: '45px', fontSize: '11px', padding: '4px' }, value: ch.end_page ?? '', placeholder: '止', onChange: e => updateChapter(idx, 'end_page', Number(e.target.value)) }),
                      button('×', () => removeChapter(idx), 'rr-buttonIcon rr-buttonQuiet', { title: '删除此章', style: { width: '24px', minHeight: '24px', padding: 0 } })
                    )
                  )
                )
              : h('p', { className: 'rr-pipelineNote' }, '当前无章节候选。'),
            h('div', { className: 'rr-rowActions', style: { margin: '8px 0' } }, button('+ 添加章节', addChapter, 'rr-buttonQuiet'), button('重新提取', () => loadChapters(selected), 'rr-buttonQuiet', { disabled: chapterLoading })),
            h(
              'div',
              { className: 'rr-rowActions', style: { marginTop: '16px' } },
              button('确认章节结构并生效', confirmChapterStructure, 'rr-buttonPrimary', { disabled: busy || !chapters.length }),
              button('转交 DSH 结构观察', () => launch('prepare'), 'rr-buttonQuiet', { disabled: busy || !environment?.guardEnabled })
            )
          )
    ),
    h(
      'section',
      { hidden: detailTab !== 'records', className: 'rr-taskDrawer rr-recordDrawer' },
      task.legacy
        ? h(
            'section',
            null,
            h('h3', null, '原项目进度'),
            task.legacy.artifacts.original
              ? button(
                  '接续现有原文',
                  () =>
                    act(async () => {
                      const value = await api('/tasks/' + selected + '/adopt', 'POST', {})
                      chooseTask(value.id)
                      setTask(value)
                    }),
                  'rr-buttonQuiet'
                )
              : null,
            h('p', { className: 'rr-pipelineNote' }, task.legacy.caption),
            h(
              'table',
              null,
              h(
                'tbody',
                null,
                [
                  ['已转写页', String(task.legacy.progress.presentPages ?? 0) + ' / ' + (task.legacy.progress.expectedPages || '未登记')],
                  ['缺失正文页', (task.legacy.progress.missingPages ?? []).slice(0, 30).join('、') || '无缺页'],
                  ['旧流程状态', task.legacy.progress.oldProgress ? (task.legacy.progress.oldProgress.status ?? '未记录') + ' / ' + (task.legacy.progress.oldProgress.current_stage ?? '未记录') : '未使用旧流程总表'],
                  ['占位翻译', (task.legacy.progress.oldProgress?.stage_history ?? []).some(s => s.stage === 'placeholder_translate') ? '有旧测试产物' : '未发现'],
                  ['历史调用', String(task.legacy.progress.auditRecords ?? 0)],
                  ['历史模型', (task.legacy.progress.models ?? []).join('、') || '未记录'],
                  ['剩余问题', task.legacy.progress.remainingIssues ? '有待核查记录' : '无问题台账'],
                  ['译文检查', task.legacy.progress.translationReport ? (task.legacy.progress.translationReport.errors ? '旧报告有阻断项' : task.legacy.progress.translationReport.warnings ? '旧报告有警告' : '旧报告通过') : '未找到旧报告'],
                  ['续跑', task.legacy.resumeBlocked ? '待核验旧底本与预算' : '接续使用已装配 Markdown'],
                ].map(([label, value]) => h('tr', { key: label }, h('th', null, label), h('td', null, value)))
              )
            )
          )
        : null,
      task.message ? h('p', { className: 'rr-pipelineNote' }, task.message) : null,
      h(
        'details',
        null,
        h('summary', null, '排障与阶段操作'),
        h(
          'div',
          { className: 'rr-taskStages' },
          stages.map(s =>
            h(
              'div',
              { key: s.id },
              h('strong', null, s.name),
              h('span', null, ({ done: '已完成', running: '运行中', blocked: '阻断', stopped: '已停止', outdated: '待更新术语流程' })[stageState(task, s.id)] ?? '待执行'),
              h(
                'div',
                { className: 'rr-rowActions' },
                button(
                  task.stages[s.id]?.state === 'done'
                    ? ['inspect', 'verify', 'glossary', 'translationCheck', 'review', 'publish', 'lgProject'].includes(s.id)
                      ? s.id === 'lgProject'
                        ? '重新打开'
                        : s.id === 'review'
                        ? '重新审校'
                        : s.id === 'publish'
                        ? '预览发布'
                        : '重新检查'
                      : '已完成'
                    : s.id === 'translate' && task.stages.translate?.state === 'blocked'
                    ? '重试翻译'
                    : s.id === 'review'
                    ? '启动审校'
                    : '执行',
                  () => run(s.id),
                  'rr-buttonQuiet',
                  {
                    disabled:
                      busy ||
                      !!task.legacy ||
                      task.state === 'running' ||
                      (task.stages[s.id]?.state === 'done' && !['inspect', 'verify', 'glossary', 'translationCheck', 'review', 'publish', 'lgProject'].includes(s.id)),
                  }
                ),
                s.id === 'prepare' ? button('转交 DSH 结构观察', () => launch('prepare'), 'rr-buttonQuiet', { disabled: busy || !!task.legacy }) : null
              )
            )
          )
        )
      ),
      task.glossaryReport
        ? h(
            'p',
            { className: 'rr-pipelineNote' },
            `${glossaryReady(task) ? '术语分析' : '旧术语记录'}：${task.glossaryReport.analysisUnits ?? 0} 单元 · 清洗覆盖 ${task.glossaryReport.reviewedEntries ?? 0} · 清洗后 ${task.glossaryReport.candidates ?? 0} · 分组 ${task.glossaryReport.semanticGroups ?? 0} · 待审校 ${task.glossaryReport.reviewIssues ?? 0} · 采用 ${task.glossaryReport.effectiveTerms ?? 0}`
          )
        : null,
      h('h3', null, '处理记录'),
      h(
        'table',
        { className: 'rr-taskTable' },
        h(
          'tbody',
          null,
          task.log.map((l, i) => h('tr', { key: i }, h('td', null, l.stage), h('td', null, l.command), h('td', null, l.exitCode === undefined ? '执行中' : `退出码 ${l.exitCode}`)))
        )
      ),
      task.translationReport && !task.translationReport.passed ? h('p', { className: 'rr-pipelineNote' }, task.translationReport.errors.join('；')) : null,
      task.review
        ? h(
            'div',
            null,
            button(
              '查看审校报告',
              () =>
                act(async () => {
                  const report = await api('/tasks/' + selected + '/review')
                  setMessage(report.text)
                }),
              'rr-buttonQuiet'
            )
          )
        : null,
      task.publication
        ? h(
            'div',
            null,
            task.publication.message ? h('p', { className: 'rr-pipelineNote' }, task.publication.message) : null,
            h('pre', null, task.publication.files.map(f => `${f.conflict ? '同名冲突 · ' : ''}${f.name} · ${f.bytes}字节`).join('\n')),
            h('p', { className: 'rr-pipelineNote' }, task.publication.destination),
            h(
              'label',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('input', { type: 'checkbox', style: { width: 'auto' }, checked: publicationAccepted, onChange: e => setPublicationAccepted(e.target.checked) }),
              '已核对，确认发布此清单'
            ),
            button(
              task.publication.published ? '已发布' : '发布到阅读库',
              () => act(() => api('/tasks/' + selected + '/publish', 'POST', { accepted: publicationAccepted })),
              'rr-buttonPrimary',
              { disabled: busy || !publicationAccepted || task.publication.published || task.publication.files.some(f => f.conflict) }
            )
          )
        : null
    ),
    h(
      'section',
      { hidden: detailTab !== 'models', className: 'rr-modelGrid rr-taskDrawer' },
      h(
        'div',
        { className: 'rr-modelCard rr-transcriptionCard' },
        h('h3', null, '转写 worker'),
        h('p', { className: 'rr-currentModel' }, '当前：' + task.worker.model),
        h('p', { className: 'rr-pipelineNote' }, '主模型失败后依次尝试兜底模型，全部失败才 OCR 抄写。'),
        h(
          'label',
          null,
          '选择转写模型',
          h(
            'select',
            {
              'aria-label': '选择转写模型',
              value: workerChoice,
              onChange: e => {
                const value = e.target.value
                setWorkerChoice(value)
                if (value === fallback1) setFallback1('')
                if (value === fallback2) setFallback2('')
              },
              disabled: busy || task.state === 'running',
            },
            h('option', { value: '' }, '请选择模型'),
            transcriptionModels.map(m => h('option', { key: m.id, value: m.id, disabled: m.disabled }, m.name))
          )
        ),
        h(
          'label',
          null,
          '兜底模型 1',
          h(
            'select',
            { 'aria-label': '兜底模型 1', value: fallback1, onChange: e => setFallback1(e.target.value), disabled: busy || !!task.legacy || task.state === 'running' },
            h('option', { value: '' }, '不使用'),
            fallbackOptions(fallback1, fallback2).map(m => h('option', { key: m.id, value: m.id, disabled: m.disabled }, m.name))
          )
        ),
        h(
          'label',
          null,
          '兜底模型 2',
          h(
            'select',
            { 'aria-label': '兜底模型 2', value: fallback2, onChange: e => setFallback2(e.target.value), disabled: busy || !!task.legacy || task.state === 'running' },
            h('option', { value: '' }, '不使用'),
            fallbackOptions(fallback2, fallback1).map(m => h('option', { key: m.id, value: m.id, disabled: m.disabled }, m.name))
          )
        ),
        ['book', 'collection'].includes(task.kind)
          ? h(
              'label',
              null,
              '整书转写并发度',
              h(
                'select',
                {
                  'aria-label': '转写并发度',
                  value: task.transcriptionConcurrency ?? 2,
                  onChange: e =>
                    act(async () => {
                      await api('/tasks/' + selected + '/concurrency', 'POST', { concurrency: Number(e.target.value) })
                      refresh()
                    }),
                  disabled: busy || task.state === 'running',
                },
                h('option', { value: 1 }, '1 章串行'),
                h('option', { value: 2 }, '2 章并行（推荐）'),
                h('option', { value: 3 }, '3 章并行')
              )
            )
          : null,
        ['paper', 'chapter'].includes(task.kind)
          ? h(
              'label',
              null,
              '单篇转写并发度',
              h(
                'select',
                {
                  'aria-label': '单篇转写并发度',
                  value: task.pageConcurrency ?? 4,
                  onChange: e =>
                    act(async () => {
                      await api('/tasks/' + selected + '/concurrency', 'POST', { pageConcurrency: Number(e.target.value) })
                      refresh()
                    }),
                  disabled: busy || task.state === 'running',
                },
                h('option', { value: 1 }, '1 页串行'),
                h('option', { value: 2 }, '2 页并行'),
                h('option', { value: 4 }, '4 页并行（推荐）'),
                h('option', { value: 6 }, '6 页并行')
              )
            )
          : null,
        h(
          'div',
          { className: 'rr-rowActions' },
          button(
            '保存转写模型',
            () =>
              act(async () => {
                await api('/tasks/' + selected + '/worker', 'POST', { workerId: workerChoice })
                setMessage('转写模型已保存，继续时确认配置；已有成果与已用预算保留')
              }),
            'rr-buttonPrimary',
            { disabled: busy || !!task.legacy || task.state === 'running' || !workerChoice }
          ),
          button(
            '保存兜底模型',
            () =>
              act(async () => {
                await api('/tasks/' + selected + '/worker', 'POST', { fallbackIds: [fallback1, fallback2].filter(Boolean) })
                setMessage('兜底模型已保存，主模型与已用预算不变')
              }),
            'rr-buttonQuiet',
            { disabled: busy || !!task.legacy || task.state === 'running' }
          )
        )
      ),
      h(
        'div',
        { className: 'rr-modelCard' },
        h('h3', null, '编排者 · DSH'),
        h(
          'label',
          null,
          '会话模型',
          h(
            'select',
            {
              'aria-label': '编排者模型',
              disabled: busy || task.state === 'running',
              value: modelKey,
              onChange: e => {
                setModelKey(e.target.value)
                setOrchestratorEffort('')
              },
            },
            h('option', { value: '' }, '沿用 DSH 当前选择'),
            models.map(m => h('option', { key: m.key, value: m.key }, m.name))
          )
        ),
        h(
          'label',
          null,
          '编排者思考强度',
          h(
            'select',
            {
              'aria-label': '编排者思考强度',
              value: orchestratorEffort,
              onChange: e => setOrchestratorEffort(e.target.value),
              disabled: busy || task?.state === 'running' || !(models.find(m => m.key === modelKey)?.reasoning?.efforts?.length),
            },
            [{ id: '', name: '沿用会话当前档位' }, ...(models.find(m => m.key === modelKey)?.reasoning?.efforts ?? [])].map(e => h('option', { key: e.id, value: e.id }, e.name ?? e.id))
          )
        ),
        button('打开编排检查', () => launch('inspect'), 'rr-buttonQuiet', { disabled: busy || !environment?.guardEnabled })
      ),
      h(
        'div',
        { className: 'rr-modelCard' },
        h('h3', null, '翻译 worker · LinguaGacha'),
        task.translationModel ? h('p', { className: 'rr-pipelineNote' }, `${task.translationModel.name} · 并发 ${task.translationModel.threshold?.concurrency_limit ?? 4} · 凭证由 DSH 管理`) : null,
        h(
          'label',
          null,
          '切换翻译模型通道',
          h(
            'select',
            {
              'aria-label': '切换翻译模型通道',
              defaultValue: '',
              onChange: e => {
                const val = e.target.value
                if (val)
                  act(async () => {
                    const res = await api('/translation-model', 'POST', { profile: val })
                    setLinguaSettings(await api('/translation-service'))
                    setMessage(res.message)
                    refresh()
                  })
              },
            },
            h('option', { value: '' }, '保持当前：' + (linguaSettings?.model?.name || '沿用默认')),
            models.map(m => h('option', { key: m.key, value: m.key }, m.name))
          )
        ),
        h(
          'label',
          null,
          '术语与翻译并发度',
          h(
            'select',
            {
              'aria-label': '术语与翻译并发度',
              value: linguaSettings?.model?.threshold?.concurrency_limit ?? '',
              disabled: busy || !linguaSettings || task.state === 'running',
              onChange: e =>
                act(async () => {
                  const val = Number(e.target.value)
                  const res = await api('/translation-concurrency', 'POST', { concurrency: val })
                  setLinguaSettings(await api('/translation-service'))
                  setMessage(res.message)
                  refresh()
                }),
            },
            h('option', { value: 1 }, '1 块串行'),
            h('option', { value: 2 }, '2 块并行'),
            h('option', { value: 4 }, '4 块并行（默认）'),
            h('option', { value: 6 }, '6 块并行'),
            h('option', { value: 8 }, '8 块并行')
          )
        ),
        button(
          '检查 CLI 配置',
          () =>
            act(async () => {
              const service = await api('/translation-service')
              setLinguaSettings(service)
              setMessage('LinguaGacha ' + service.version + ' · ' + service.model.name + '（并发度 ' + service.model.threshold.concurrency_limit + '） · 凭证由 DSH 管理，连接以实际请求为准')
            }),
          'rr-buttonQuiet'
        ),
        h(
          'label',
          null,
          '导入映射对应的原 PDF',
          h(
            'select',
            { 'aria-label': '导入映射对应的原 PDF', value: sourceMapPdfId, onChange: e => setSourceMapPdfId(e.target.value) },
            h('option', { value: '' }, '沿用映射中的 PDF 位置'),
            (catalog.sources ?? []).filter(s => s.type === 'pdf').map(s => h('option', { key: s.id, value: s.id }, s.displayName ?? s.name))
          )
        ),
        ['original', 'translation'].map(view =>
          h(
            'label',
            { key: view, className: 'rr-button rr-buttonQuiet' },
            view === 'original' ? '导入原文来源映射' : '导入译文来源映射',
            h('input', {
              hidden: true,
              type: 'file',
              accept: '.json',
              disabled: busy || !!task.legacy || task.state === 'running',
              onChange: e => {
                const file = e.target.files?.[0]
                if (file)
                  act(async () => {
                    await api('/tasks/' + selected + '/source-map?view=' + view + (sourceMapPdfId ? '&pdfSourceId=' + encodeURIComponent(sourceMapPdfId) : ''), 'POST', JSON.parse(await file.text()))
                    setMessage('来源映射已核验，请重新执行译文校验。')
                  })
                e.target.value = ''
              },
            })
          )
        ),
        button('导入对应译文', () => translationRef.current?.click(), 'rr-buttonQuiet'),
        h('input', {
          hidden: true,
          type: 'file',
          accept: '.md,.markdown',
          ref: translationRef,
          onChange: e => {
            const file = e.target.files?.[0]
            if (file) act(() => api('/tasks/' + selected + '/translation', 'POST', file))
            e.target.value = ''
          },
        })
      ),
      h(
        'div',
        { className: 'rr-modelCard' },
        h('h3', null, '审校配置 · DSH / CLI'),
        h('p', { className: 'rr-pipelineNote' }, '更换审校模型或上下文过长时，先停止当前审校，确认新模型后将以全新会话接续，已通过校验的分包全部保留。'),
        button('更换模型并新会话续审', resumeWithAntigravity, 'rr-buttonQuiet', { disabled: busy || task.state === 'running' || !translationDone || reviewDone || deliveryDone || !!task.legacy }),
        h('p', { className: 'rr-currentModel' }, '当前分包 Worker：' + (task?.reviewConfig?.workerModel === 'inherit' ? '继承审校编排模型' : task?.reviewConfig?.workerModel ?? '未选择')),
        h(
          'label',
          null,
          '选择分包审校 Worker',
          h(
            'select',
            {
              'aria-label': '选择分包审校 Worker',
              value: reviewWorkerChoice,
              onChange: e => setReviewWorkerChoice(e.target.value),
              disabled: busy || (task?.state === 'running' && task?.stage === 'review'),
            },
            [{ id: 'inherit', name: '继承审校编排模型' }, ...models.map(m => ({ id: m.key, name: m.name }))].map(w => h('option', { key: w.id, value: w.id }, w.name))
          )
        ),
        h(
          'label',
          null,
          '审校编排者模型',
          h(
            'select',
            {
              'aria-label': '审校编排者模型',
              value: reviewOrchestratorChoice,
              onChange: e => {
                setReviewOrchestratorChoice(e.target.value)
                setReviewEffortChoice('')
              },
              disabled: busy || (task?.state === 'running' && task?.stage === 'review'),
            },
            h('option', { value: '' }, '请选择审校模型'),
            models.map(m => h('option', { key: m.key, value: m.key }, m.name))
          )
        ),
        h(
          'label',
          null,
          '编排者思考档位',
          h(
            'select',
            {
              'aria-label': '编排者思考档位',
              value: reviewEffortChoice,
              onChange: e => setReviewEffortChoice(e.target.value),
              disabled: busy || (task?.state === 'running' && task?.stage === 'review'),
            },
            h('option', { value: '' }, '默认（沿用 DSH 默认）'),
            (models.find(m => m.key === reviewOrchestratorChoice)?.reasoning?.efforts ?? []).map(m => h('option', { key: m.id, value: m.id }, m.name))
          )
        ),
        button(
          '仅保存审校模型设置',
          () =>
            act(async () => {
              await api('/tasks/' + selected + '/review-config', 'POST', {
                orchestratorModel: reviewOrchestratorChoice,
                orchestratorEffort: reviewEffortChoice,
                workerModel: reviewWorkerChoice,
              })
              setMessage('审校模型与分包 Worker 设置已保存')
            }),
          'rr-buttonPrimary',
          { disabled: busy || (task?.state === 'running' && task?.stage === 'review') }
        )
      )
    )
  )
}
