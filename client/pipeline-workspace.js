function renderPipelineWorkspace(ctx) {
  const {
    filteredTasks,
    itemMeta,
    folders,
    statusLabel,
    taskCaption,
    selected,
    draggedTaskId,
    setDraggedTaskId,
    setDragOverFolder,
    chooseTask,
    handleRemoveAssign,
    taskCounts,
    beginNew,
    taskQuery,
    setTaskQuery,
    setTaskOffset,
    pipelineSubFilter,
    setPipelineSubFilter,
    task,
    setSelectedFolder,
    setShowHidden,
    taskOffset,
    taskTotal,
    setServices,
    setDetailTab,
    setRenameValue,
    setRenameForm,
    setAssignModal,
    toggleHideTask,
    handleDeleteTask,
    phaseGroups,
    stages,
    currentGroup,
    revInfo,
    viewExecution,
    busy,
    rotateOrchestratorSession,
    nextAction,
    setReviewMonitor,
    stuckModel,
    setStuckModel,
    retryModels,
    retryStuckPages,
    advance,
    translationDone,
    reviewDone,
    deliveryDone,
    setMessage,
    setTranslationProfile,
    setPhaseRequest,
    launch,
    resetTranscription,
    run,
    readable,
    read,
    setPdfModal,
    openSystemPdf,
    startSupplementalReview,
    act,
    api,
  } = ctx

  const activeTasks = filteredTasks.filter(t => !isReadableTask(t))
  const otherTasks = filteredTasks.filter(isReadableTask)
  const renderTaskItem = t => {
    const meta = itemMeta[t.id] ?? {}
    const assigned = meta.folderId
      ? String(meta.folderId)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : []
    const isRunning = t.state === 'running'
    const isBlocked = ['blocked', 'paused', 'interrupted'].includes(t.state)
    const isDone = isReadableTask(t)
    const statusBadge = isRunning ? '运行中' : isBlocked ? statusLabel[t.state] || '阻断' : isDone ? '可阅读' : taskCaption(t) || '待启动'
    const tagClass = isRunning ? 'rr-tagRunning' : isBlocked ? 'rr-tagBlocked' : isDone ? 'rr-tagReady' : 'rr-tagWaiting'
    const isSelected = selected === t.id

    return h(
      'div',
      {
        key: t.id,
        className: `rr-pipelineTaskCard ${isSelected ? 'rr-pipelineTaskCardActive' : ''} ${isBlocked ? 'rr-pipelineTaskCardBlocked' : ''} ${draggedTaskId === t.id ? 'rr-taskDragging' : ''}`,
        onClick: () => chooseTask(t.id),
        draggable: true,
        onDragStart: e => {
          setDraggedTaskId(t.id)
          e.dataTransfer.setData('text/plain', t.id)
          e.dataTransfer.effectAllowed = 'move'
        },
        onDragEnd: () => {
          setDraggedTaskId(null)
          setDragOverFolder(null)
        },
      },
      h(
        'div',
        { className: 'rr-taskCardTopLine' },
        h('span', { className: 'rr-taskCardTitle' }, t.name),
        h('span', { className: `rr-taskCardStatusTag ${tagClass}` }, statusBadge)
      ),
      assigned.length || meta.hidden
        ? h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' } },
            assigned.map(fId => {
              const f = folders.find(x => x.id === fId)
              if (!f) return null
              return h(
                'span',
                { key: fId, className: 'rr-folderPillTag' },
                h('span', null, f.name),
                h(
                  'button',
                  {
                    type: 'button',
                    title: '移出此文件夹',
                    onClick: e => {
                      e.stopPropagation()
                      handleRemoveAssign(t.id, fId)
                    },
                  },
                  '×'
                )
              )
            }),
            meta.hidden ? h('span', { className: 'rr-hiddenTag' }, '已隐藏') : null
          )
        : null,
      h(
        'div',
        { className: 'rr-taskCardSubtitle' },
        h('span', { style: { color: isDone ? '#047857' : '#2563eb', fontWeight: 500 } }, ({ book: '整书', paper: '论文', chapter: '章节', collection: '合集' })[t.kind]),
        h('span', null, '·'),
        h('span', null, t.input?.type === 'markdown' ? 'Markdown 底本' : 'PDF 底本'),
        t.inspection?.pages ? h('span', null, ` · ${t.inspection.pages} 页`) : null
      )
    )
  }

  return h(
    'div',
    { className: 'rr-taskWorkspace' },
    h(
      'aside',
      { className: 'rr-taskList', 'aria-label': '处理流水线' },
      h(
        'div',
        { className: 'rr-taskListHeadModern' },
        h(
          'div',
          { className: 'rr-taskListHeadLeft' },
          h('span', { className: 'rr-taskListTitle' }, '处理流水线'),
          h('span', { className: 'rr-taskCountPill' }, taskCounts.all)
        ),
        button('+ 新增', beginNew, 'rr-pipelineAddBtn')
      ),
      h(
        'div',
        { className: 'rr-taskListSearchWrap' },
        icon('search', 14),
        h('input', {
          type: 'search',
          className: 'rr-pipelineSearchInput',
          placeholder: '搜索任务...',
          value: taskQuery,
          onChange: e => {
            setTaskQuery(e.target.value)
            setTaskOffset(0)
          },
        })
      ),
      h(
        'div',
        { className: 'rr-pipelineSubFilterRow' },
        h(
          'button',
          {
            type: 'button',
            className: `rr-subFilterBtn ${pipelineSubFilter === 'all' ? 'rr-subFilterBtnActive' : ''}`,
            onClick: () => setPipelineSubFilter('all'),
          },
          h('span', null, '全部'),
          h('span', { className: 'rr-subFilterBadge' }, taskCounts.all)
        ),
        h(
          'button',
          {
            type: 'button',
            className: `rr-subFilterBtn ${pipelineSubFilter === 'active' ? 'rr-subFilterBtnActive' : ''}`,
            onClick: () => setPipelineSubFilter('active'),
          },
          h('span', null, '待操作'),
          h('span', { className: 'rr-subFilterBadge' }, taskCounts.active)
        ),
        h(
          'button',
          {
            type: 'button',
            className: `rr-subFilterBtn ${pipelineSubFilter === 'done' ? 'rr-subFilterBtnActive' : ''}`,
            onClick: () => setPipelineSubFilter('done'),
          },
          h('span', null, '可阅读'),
          h('span', { className: 'rr-subFilterBadge' }, taskCounts.done)
        )
      ),
      h(
        'div',
        { className: 'rr-taskItemsScrollArea' },
        task && !filteredTasks.some(t => t.id === task.id)
          ? h(
              'div',
              { className: 'rr-pinnedTask' },
              h('p', { className: 'rr-pipelineNote' }, '当前打开的任务不在本批筛选结果中'),
              renderTaskItem(task),
              button(
                '在全部任务中定位',
                () => {
                  setPipelineSubFilter('all')
                  setSelectedFolder('all')
                  setShowHidden(!!itemMeta[task.id]?.hidden)
                  setTaskOffset(0)
                  setTaskQuery(task.name)
                },
                'rr-buttonQuiet'
              )
            )
          : null,
        filteredTasks.length
          ? h(
              React.Fragment,
              null,
              pipelineSubFilter !== 'done' && activeTasks.length
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'rr-pipelineGroupHeading' },
                      h('span', null, '待操作 · 进行中'),
                      h('span', { className: 'rr-pulsingDot' })
                    ),
                    activeTasks.map(renderTaskItem)
                  )
                : null,
              pipelineSubFilter !== 'active' && otherTasks.length
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'rr-pipelineGroupHeading', style: { marginTop: 8 } },
                      h('span', null, '可阅读成品'),
                      h('span', { style: { fontSize: 10, fontWeight: 400, color: '#a1a1aa' } }, `${otherTasks.length} 篇`)
                    ),
                    otherTasks.map(renderTaskItem)
                  )
                : null
            )
          : h('p', { className: 'rr-pipelineNote', style: { padding: 14, textAlign: 'center' } }, '未找到匹配任务。')
      ),
      h(
        'div',
        { className: 'rr-rowActions', style: { padding: '8px 10px', borderTop: '1px solid #f4f4f5' } },
        button('上一批', () => setTaskOffset(Math.max(0, taskOffset - 40)), 'rr-buttonQuiet', { disabled: taskOffset === 0 }),
        button('下一批', () => setTaskOffset(taskOffset + 40), 'rr-buttonQuiet', { disabled: taskOffset + 40 >= taskTotal }),
        button(
          '服务设置',
          () => {
            setServices(true)
            setDetailTab('flow')
          },
          'rr-buttonQuiet',
          { style: { marginLeft: 'auto' } }
        )
      )
    ),
    task
      ? h(
          'section',
          { className: 'rr-taskDetail' },
          h(
            'div',
            { className: 'rr-taskDetailInner' },
            h(
              'div',
              { className: 'rr-taskDetailHeader' },
              h(
                'div',
                null,
                h('span', { className: 'rr-taskDetailTypeTag' }, ({ book: '整本书', paper: '论文', chapter: '章节节选', collection: '文章合集' })[task.kind]),
                h('h1', { className: 'rr-taskDetailH1' }, task.name)
              ),
              h(
                'div',
                { className: 'rr-taskDetailActionButtons' },
                button(
                  '改名',
                  () => {
                    setRenameValue(task.name)
                    setRenameForm(true)
                  },
                  'rr-detailActionBtn',
                  { disabled: task.state === 'running' }
                ),
                button(
                  h(React.Fragment, null, icon('folder', 13), '归类'),
                  () => setAssignModal({ targetId: task.id, targetName: task.name, currentFolderId: itemMeta[task.id]?.folderId }),
                  'rr-detailActionBtn'
                ),
                button('处理记录', () => setDetailTab('records'), 'rr-detailActionBtn'),
                button(
                  h(React.Fragment, null, icon(itemMeta[task.id]?.hidden ? 'eyeOff' : 'eye', 13), itemMeta[task.id]?.hidden ? '取消隐藏' : '隐藏'),
                  () => toggleHideTask(task.id),
                  'rr-detailActionBtn'
                ),
                button(
                  h(React.Fragment, null, icon('trash', 13), '删除'),
                  () => handleDeleteTask(task.id, task.name),
                  'rr-detailActionBtn',
                  { disabled: task.state === 'running', style: { borderColor: '#fecaca', color: '#dc2626' } }
                )
              )
            ),
            h(
              'div',
              { className: 'rr-flowStepper' },
              phaseGroups
                .filter(g => stages.some(s => g.ids.includes(s.id)))
                .map((g, idx, arr) =>
                  h(
                    React.Fragment,
                    { key: g.id },
                    h('span', { className: currentGroup === g.id ? 'rr-flowStepperItemActive' : '' }, g.name),
                    idx < arr.length - 1 ? h('span', { className: 'rr-flowStepperSep' }, '›') : null
                  )
                )
            ),
            !task.legacy
              ? h(
                  'details',
                  {
                    open: !['review', 'publish'].includes(task.stage),
                    className: 'rr-executionSessions',
                    style: { margin: '12px 0', padding: '12px 0', borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
                  },
                  h('summary', null, ['review', 'publish'].includes(task.stage) && revInfo.isAgyReview ? '前置阶段执行会话（转写 / 翻译）' : '关联执行会话（编排 / 转写 / 翻译）'),
                  h(
                    'div',
                    { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,180px),1fr))', gap: 10, marginTop: 10 } },
                    ...Object.entries({ orchestrator: '编排会话', worker: '转写 Worker 会话', linguagacha: 'LinguaGacha 翻译会话' }).map(([role, label]) => {
                      const sid = shortSessionId(task.executionSessions?.sessions?.[role])
                      return h(
                        'div',
                        { key: role, style: { padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 } },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
                          h('strong', null, label),
                          h('code', { style: { fontSize: 11, color: '#71717a', background: '#f4f4f5', padding: '1px 5px', borderRadius: 4 } }, sid || '待创建')
                        ),
                        h('span', { className: 'rr-pipelineNote', style: { margin: 0, overflowWrap: 'anywhere' } }, executionSummary(task, role)),
                        h(
                          'div',
                          { style: { marginTop: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' } },
                          button(
                            role === 'orchestrator' ? '打开编排会话 →' : role === 'worker' ? '查看转写日志 →' : '查看翻译日志 →',
                            () => viewExecution(role),
                            'rr-detailActionBtn',
                            {
                              'aria-label': role === 'orchestrator' ? '打开编排者会话' : `查看 ${role === 'worker' ? '转写 Worker' : 'LinguaGacha 翻译'} 会话`,
                              disabled: busy && !task.executionSessions?.sessions?.[role],
                              style: { whiteSpace: 'normal', textAlign: 'left' },
                            }
                          ),
                          role === 'orchestrator'
                            ? button('重置为空白会话', () => rotateOrchestratorSession(false), 'rr-detailActionBtn', {
                                disabled: busy || task.state === 'running',
                                title: '仅归档当前编排会话并开启一个空白新会话（不自动发送任务指令；已完成的转写、翻译和审校产物全部保留）',
                              })
                            : null
                        )
                      )
                    })
                  ),
                  task.executionSessions?.error ? h('p', { role: 'alert', className: 'rr-taskWarning' }, task.executionSessions.error) : null,
                  task.executionSessions?.recent?.length
                    ? h(
                        'div',
                        { 'aria-live': 'polite', style: { marginTop: 12 } },
                        h('strong', { style: { fontSize: 12 } }, '最新执行记录'),
                        ...task.executionSessions.recent
                          .slice(-3)
                          .reverse()
                          .map(e =>
                            h(
                              'div',
                              { key: e.id, style: { padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
                              h(
                                'span',
                                { className: 'rr-pipelineNote' },
                                new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false }) +
                                  ' · ' +
                                  e.text
                                    .split('\n')
                                    .slice(0, e.text.startsWith('任务 ') ? 3 : 1)
                                    .join(' · ')
                              ),
                              button('打开对应会话', () => viewExecution(e.role), 'rr-detailActionBtn', { style: { marginLeft: 8 } })
                            )
                          )
                      )
                    : h('p', { className: 'rr-pipelineNote' }, '尚无模型调用成功记录；会话绑定本身不代表处理已启动。')
                )
              : null,
            h(
              'section',
              { className: 'rr-nextStepCardModern' },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h('span', { className: 'rr-nextStepBadge' }, 'NEXT STEP'),
                h('h3', { className: 'rr-nextStepTitle' }, nextAction.title)
              ),
              nextAction.note ? h('p', { className: 'rr-pipelineNote', style: { margin: '6px 0 8px' } }, nextAction.note) : null,
              ['review', 'publish'].includes(task.stage) && !task.legacy
                ? h(AntigravityFeedback, { task, onMonitor: () => setReviewMonitor(true), onOpenSession: !revInfo.isAgyReview ? () => viewExecution('orchestrator') : null })
                : task.transcriptionProgress && task.stages.transcribe
                ? h(
                    'div',
                    { className: 'rr-transcriptionProgress', 'aria-live': 'polite' },
                    h(
                      'div',
                      { className: 'rr-transcriptionProgressLabel' },
                      h('span', null, task.transcriptionProgress.stageComplete ? '转写完成' : '转写进度'),
                      h('span', null, `${task.transcriptionProgress.completed} / ${task.transcriptionProgress.total} 页`)
                    ),
                    h('progress', { 'aria-label': '转写页数', max: task.transcriptionProgress.total, value: task.transcriptionProgress.completed }),
                    h(
                      'p',
                      { className: 'rr-pipelineNote' },
                      [
                        task.transcriptionProgress.verifiedInputPages !== null && task.transcriptionProgress.verifiedInputPages !== undefined
                          ? `已核验 ${task.transcriptionProgress.verifiedInputPages} 页`
                          : null,
                        task.transcriptionProgress.active.map(p => `第 ${p.page} 页`).join('、'),
                        task.transcriptionProgress.failed ? `${task.transcriptionProgress.failed} 页未完成` : null,
                        task.transcriptionProgress.review ? `${task.transcriptionProgress.review} 页待核查` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    )
                  )
                : null,
              ['blocked', 'interrupted', 'paused'].includes(task.state) && task.message && !/^已确认.+阶段；/.test(task.message) && nextAction.kind !== 'structure'
                ? h('p', { className: 'rr-taskWarning' }, task.message)
                : null,
              task.stuckPages?.length && !task.legacy && task.state !== 'running' && !['review', 'publish'].includes(task.stage)
                ? h(
                    'div',
                    { style: { margin: '8px 0' } },
                    h('p', { className: 'rr-pipelineNote' }, '这些页继续自动转写不会再调用模型。章节已通过、但正文仍是 OCR 兜底的页也列在这里。选择一个 DSH 模型后，只重试这些页。'),
                    h(
                      'ul',
                      { className: 'rr-pipelineNote' },
                      task.stuckPages.map(page => h('li', { key: page.chapterId + ':' + page.page }, `第 ${page.page} 页 · 章 ${page.chapterId} · ${page.reason}`))
                    ),
                    h(
                      'label',
                      null,
                      '重试模型',
                      h(
                        'select',
                        { 'aria-label': '重试无法处理的页面', value: stuckModel, onChange: e => setStuckModel(e.target.value), disabled: busy },
                        h('option', { value: '' }, '请选择模型'),
                        retryModels.map(m => h('option', { key: m.id, value: m.id }, m.name))
                      )
                    ),
                    h('div', { className: 'rr-rowActions' }, button('用所选模型重试这些页', retryStuckPages, 'rr-buttonPrimary', { disabled: busy || !stuckModel }))
                  )
                : null,
              h(
                'div',
                { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
                button(h(React.Fragment, null, icon('play', 14), h('span', null, nextAction.label)), advance, 'rr-nextStepBtn', { disabled: busy }),
                !task.legacy && task.state !== 'running' && reviewDone && !deliveryDone
                  ? button('补充重审', startSupplementalReview, 'rr-detailActionBtn', {
                      disabled: busy,
                      title: '基于当前最新原文与译文创建全新审校运行并重审（可填写本次重点核查说明），完成后重新生成发布清单',
                    })
                  : null,
                !task.legacy &&
                  task.state !== 'running' &&
                  translationDone &&
                  !reviewDone &&
                  !deliveryDone &&
                  revInfo.approvedForDelivery &&
                  (revInfo.hasReviewOrchestrator || Boolean(revInfo.agyConversationId))
                  ? button(revInfo.isAgyReview ? '新建 CLI 会话续审' : '新建会话续审', () => rotateOrchestratorSession(true), 'rr-detailActionBtn', {
                      disabled: busy,
                      title: revInfo.isAgyReview
                        ? '不沿用旧 CLI 会话，开启全新 Antigravity CLI 会话继续剩余待审分包（已通过分包保留）'
                        : '归档当前编排会话，开启 0 上下文的全新 DSH 编排会话继续剩余待审分包（已通过分包全部保留）',
                    })
                  : null,
                (() => {
                  const targetPhase = phaseGroups.find(g => g.ids.includes(nextAction.stage))?.id ?? currentGroup
                  const canSwitchModel =
                    !task.legacy &&
                    task.state !== 'running' &&
                    !deliveryDone &&
                    !reviewDone &&
                    ((nextAction.kind === 'run' && task.phaseApproval?.phase === targetPhase) ||
                      (targetPhase === 'delivery' && task.deliveryState?.canResume && task.phaseApproval?.phase === 'delivery'))
                  if (!canSwitchModel) return null
                  const switchLabel = ({ transcription: '更换转写模型', translation: '更换翻译模型', delivery: '更换审校模型' })[targetPhase] ?? '更换本阶段模型'
                  return button(
                    switchLabel,
                    () => {
                      setMessage('')
                      setTranslationProfile('')
                      setPhaseRequest({
                        taskId: task.id,
                        phase: targetPhase,
                        stage: targetPhase === 'delivery' ? 'review' : nextAction.stage,
                        options: { newConversation: true, ...(targetPhase === 'delivery' ? { runAgy: true } : {}) },
                      })
                    },
                    'rr-detailActionBtn',
                    {
                      disabled: busy,
                      title: targetPhase === 'delivery' ? '重新选择审校编排模型、分包模型或思考档位，并开启全新会话接续待审分包' : '重新选择本阶段模型配置',
                    }
                  )
                })(),
                task.state === 'blocked' && task.stage === 'transcribe'
                  ? button('打开会话诊断修复', () => launch('diagnose'), 'rr-detailActionBtn', {
                      disabled: busy,
                      title: '拉起编排会话查看章节验收错误并对照原页定点修复，不重跑整章转写',
                    })
                  : null,
                !task.legacy &&
                  task.state !== 'running' &&
                  !translationDone &&
                  !['review', 'publish'].includes(task.stage) &&
                  (task.stages.transcribe || task.stages.verify || task.stages.assemble || task.transcriptionProgress?.completed > 0)
                  ? button('清空转写并重跑', resetTranscription, 'rr-detailActionBtn', {
                      disabled: busy,
                      title: '清除已转写的章节产物与交付快照，保留底本与页面图，从头重新转写',
                    })
                  : null,
                nextAction.kind === 'launch' ? button(nextAction.stage === 'review' ? '启动审校' : '执行结构门禁', () => run(nextAction.stage), 'rr-detailActionBtn', { disabled: busy }) : null,
                readable && nextAction.kind !== 'read'
                  ? button(task.legacy ? '阅读已有成果' : task.translationReport?.passed ? '阅读译文' : '阅读原文', () => read(selected), 'rr-detailActionBtn')
                  : null,
                task.legacy?.artifacts?.sourcePdf || task.input.type === 'pdf'
                  ? h(
                      React.Fragment,
                      null,
                      button(
                        h(React.Fragment, null, icon('pdf', 14), '查看原 PDF'),
                        () => setPdfModal({ url: '/api/paper-reader/pipeline/tasks/' + selected + '/source', title: task.name, taskId: selected }),
                        'rr-detailActionBtn'
                      ),
                      button(h(React.Fragment, null, icon('external', 13), '系统打开'), () => openSystemPdf(selected), 'rr-detailActionBtn')
                    )
                  : null
              )
            ),
            h(
              'div',
              { className: 'rr-docFactsGridModern' },
              h(
                'div',
                { className: 'rr-factCell' },
                h('small', null, '原文'),
                h('span', null, ({ fr: '法语', en: '英语', de: '德语', zh: '中文', ja: '日语', es: '西班牙语', it: '意大利语' })[task.profile?.language] ?? '待确认')
              ),
              h(
                'div',
                { className: 'rr-factCell' },
                h('small', null, '底本'),
                h('span', null, task.input.type === 'markdown' ? 'Markdown' : task.inspection?.verdict === 'BORN-DIGITAL' ? '原生文字 PDF' : 'PDF')
              ),
              h(
                'div',
                { className: 'rr-factCell' },
                h('small', null, '范围'),
                h('span', null, task.input.type === 'markdown' ? (task.inspection?.blocks ?? '—') + ' 块' : task.profile?.confirmed ? `${task.profile.start_page}–${task.profile.end_page} 页` : '待确认')
              ),
              task.input.type === 'pdf'
                ? h(
                    'div',
                    { className: 'rr-factCell' },
                    h('small', null, '封面页'),
                    h(
                      'span',
                      { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                      task.cover?.none
                        ? '无独立封面'
                        : task.cover?.page
                          ? `第 ${task.cover.page} 页`
                          : task.cover?.file && !task.cover?.none
                            ? '静态封面图'
                            : task.profile?.cover_page
                              ? `第 ${task.profile.cover_page} 页`
                              : '待提取',
                      button(
                        '设定',
                        () => {
                          const cur = task.cover?.page ?? task.profile?.cover_page ?? ''
                          const raw = window.prompt('输入作为书架封面的 PDF 页码（留空或填 0 表示无独立封面）：', cur ? String(cur) : '')
                          if (raw === null) return
                          const trimmed = raw.trim()
                          const coverPage = trimmed === '' || trimmed === '0' ? null : Number(trimmed)
                          if (coverPage !== null && (!Number.isInteger(coverPage) || coverPage < 1)) {
                            setMessage('封面页码须为正整数，或留空表示无封面')
                            return
                          }
                          act(async () => {
                            await api('/tasks/' + selected + '/cover', 'POST', { coverPage })
                            setMessage(coverPage ? `已将第 ${coverPage} 页标记为封面并生成静态封面图` : '已标记为无独立封面')
                          })
                        },
                        'rr-buttonQuiet',
                        { disabled: busy, style: { padding: '2px 7px', fontSize: 11 } }
                      )
                    )
                  )
                : null
            ),
            h(
              'div',
              { className: 'rr-workerBarModern' },
              h(
                'div',
                null,
                h('small', null, '转写 worker'),
                h(
                  'p',
                  null,
                  task.worker.model,
                  task.input.type !== 'markdown'
                    ? h('span', { className: 'rr-concurrencyTag' }, ['paper', 'chapter'].includes(task.kind) ? `${task.pageConcurrency ?? 4} 页并发` : `${task.transcriptionConcurrency ?? 2} 章并发`)
                    : null,
                  (task.worker.fallbacks ?? []).length ? h('span', { className: 'rr-concurrencyTag rr-fallbackTag' }, '兜底 ' + task.worker.fallbacks.map(f => f.model).join(' → ')) : null
                )
              ),
              button('模型与并发', () => setDetailTab('models'), 'rr-detailActionBtn')
            ),
            h(
              'div',
              { className: 'rr-detailFooter', style: { display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 14, borderTop: '1px solid #e4e4e7', marginTop: 6 } },
              h('span', { style: { fontSize: '11px', color: '#71717a', marginRight: '4px' } }, '高级阶段配置：'),
              button('翻译与审校', () => setDetailTab('models'), 'rr-detailActionBtn'),
              task.profile?.confirmed ? button('文档范围', () => setDetailTab('structure'), 'rr-detailActionBtn') : null,
              task.profile?.confirmed && ['book', 'collection'].includes(task.kind) ? button('章节结构', () => setDetailTab('chapters'), 'rr-detailActionBtn') : null
            )
          ),
          renderPipelineTaskDrawers(ctx)
        )
      : h('section', { className: 'rr-taskEmpty' }, h('h2', null, '请选择或创建任务'), button('新增任务', beginNew, 'rr-buttonPrimary'))
  )
}
