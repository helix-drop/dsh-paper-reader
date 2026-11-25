const profileLabels={document_type:'文档类型',language:'原文语言',book_type:'注释体例',note_location:'注释位置',note_numbering:'编号方式',layout:'页面布局',start_page:'处理起始页',end_page:'处理结束页',note_start_page:'尾注起始页',note_end_page:'尾注结束页',cover_page:'封面页',regions:'逐页裁切与阅读顺序',title:'标题'}
const profileValues={book:'整本书',paper:'论文',chapter:'章节节选',collection:'文章合集',en:'英语',fr:'法语',de:'德语',zh:'中文',ja:'日语',es:'西班牙语',it:'意大利语',footnote_only:'页底脚注',endnote_only:'尾注',mixed:'混合体例',no_notes:'无注释',per_page:'每页重置',per_chapter:'每章重置',continuous:'全文连续',per_page_bottom:'所在页底',chapter_end_notes:'章节末尾',book_end_notes:'整书末尾',none:'无注释',single:'单页单栏',spread:'左右双页',columns:'多栏排版'}
function ProfileAnalysis({task,onAnalyze}){
  const report=task.profileAnalysis,pending=task.profile?.confirmed?[]:(task.profileReadiness?.missing??report?.unresolved??[]),running=task.state==='running',locked=task.stages.normalize?.state==='done'||task.stages.lgProject?.state==='done'
  return h('div',{className:'rr-profileAnalysis'},h('p',{className:'rr-pipelineNote',role:'status'},running?'正在分析文档，完成后自动填写。':!report?'尚未自动分析文档。':report.status==='model_failed'?'模型分析未完成，已保留程序检查结果。可重试分析，或展开配置核对。':report.preservedUserProfile&&task.profile?.confirmed?'分析完成，已有人工保存的配置继续保留。':pending.length?'模型已返回分析结果，仍有必填信息待核验，尚不能继续处理。':'已自动填写分析结果，处理范围默认保留全文。'),
    !locked?button(report?'重新分析文档':'自动分析文档',onAnalyze,'rr-buttonQuiet',{disabled:running}):null,
    report?h(React.Fragment,null,h('p',{className:'rr-pipelineNote'},['language','document_type','layout','book_type','note_numbering'].map(key=>profileValues[task.profile?.[key]]??'').filter(Boolean).join(' · ')),pending.length?h('p',{className:'rr-taskWarning'},'待核对：'+pending.map(key=>profileLabels[key]??key).join('、')):null,
      h('details',null,h('summary',null,'查看分析依据'),h('p',{className:'rr-pipelineNote'},'采样页：'+report.samplePages.join('、')),h('table',{className:'rr-taskTable'},h('tbody',null,Object.entries(report.fields).map(([key,field])=>h('tr',{key},h('th',null,profileLabels[key]??key),h('td',null,field.value===null&&key==='cover_page'?'无独立封面':(profileValues[field.value]??String(field.value))),h('td',null,(field.confidence==='high'?'较高置信度 · ':'中等置信度 · ')+field.reason+(field.pages.length?' · PDF页 '+field.pages.join('、'):'')))))))):null)
}
function isReadableTask(task) {
  return task.publication?.published === true || task.readingReady === true || Boolean(task.libraryProof)
}
function taskPageKey(page) { return JSON.stringify([page.query,page.offset,page.category,page.folderId,page.includeHidden]) }
function taskPageUrl(page) {
  return '/tasks?limit=40&offset='+page.offset+'&q='+encodeURIComponent(page.query)+'&category='+page.category+'&folderId='+encodeURIComponent(page.folderId)+'&includeHidden='+page.includeHidden
}
function shortSessionId(id) {
  return typeof id==='string'&&id?id.replace(/^session-/,'').slice(0,8):''
}
function reviewSessionInfo(task) {
  const orchModel=task?.reviewConfig?.orchestratorModel??''
  const isAgyReview=orchModel.startsWith('agy/')
  const approvedForDelivery=task?.phaseApproval?.phase==='delivery'&&Boolean(orchModel)
  const orchSessionId=task?.executionSessions?.sessions?.orchestrator??''
  const authStage=task?.executionSessions?.authorizedStage??''
  const hasReviewOrchestrator=Boolean(!isAgyReview&&orchSessionId&&['review','publish'].includes(authStage))
  const shortOrchId=shortSessionId(orchSessionId)
  const agyConversationId=isAgyReview&&task?.reviewProgress?.engine==='agy-bridge'&&typeof task?.reviewProgress?.conversationId==='string'?task.reviewProgress.conversationId:''
  return {orchModel,isAgyReview,approvedForDelivery,orchSessionId,shortOrchId,authStage,hasReviewOrchestrator,agyConversationId}
}
function resolveNextAction(task,{stageName='当前阶段',transcriptionDone=false,translationDone=false,reviewDone=false,deliveryDone=false,needsBookObservation=false}={}) {
  if(!task)return null
  if(task.legacy){
    return {
      label:task.libraryProof?'开始阅读':task.legacy.artifacts.original?'接续处理':'查看旧进度',
      title:task.legacy.caption,
      note:task.legacy.resumeBlocked?'已有正文、审计和预算保留。旧底本尚需核验后才能接续，导入不会重新生成。':'已有装配原文和译文保留；可阅读成品，处理记录保留旧流程的检查结果。',
      kind:task.libraryProof?'read':task.legacy.artifacts.original?'adopt':'records'
    }
  }
  const rev=reviewSessionInfo(task)
  if(task.state==='running'){
    return {
      label:'停止当前任务',
      title:'正在'+stageName,
      note:task.stage==='glossary'?({analysis:'正在分析全文术语。',consolidation:'正在一次完成清洗、译名冲突处理与概念归并。'}[task.glossaryProgress?.phase]??'正在使用 LinguaGacha 分析全文术语。')+(task.glossaryProgress?.providerRetry?`请求失败后第 ${task.glossaryProgress.providerRetry}/3 次重试。`:'')+'停止后保留已完成的结果与分析记录。':task.stage==='review'?(rev.isAgyReview?'Antigravity CLI 正在执行分包审校，停止后保留已保存的分包结果。':`DSH 编排会话${rev.shortOrchId?'（'+rev.shortOrchId+'）':''}正在并发执行分包审校，停止后保留已保存的分包结果。`):'停止后保留现有产物与处理记录。',
      kind:'stop'
    }
  }
  if(deliveryDone)return {label:'开始阅读',title:'处理完成',note:'原文、译文与来源映射已就绪，可在阅读器中对照查看。',kind:'read'}
  if(reviewDone)return {label:'核对发布清单',title:'审校已通过 · 待确认发布',note:'所有分包已通过审校并写入译文。发布将直接沿用现有成果，不再调用审校模型。',kind:'publication',stage:'publish'}
  if(task.state==='blocked'&&(task.profileAnalysis?.status==='model_failed'||task.profileReadiness?.ready===false)&&!task.profile?.confirmed){
    return {label:'核对文档范围与体例',title:'文档体例待核验',note:task.profileReadiness?.message||task.message||'请核对处理范围和分析结果后确认。',kind:'structure'}
  }
  if(task.state==='blocked'&&needsBookObservation){
    return {label:'核对章节结构',title:'章节结构待确认',note:task.message||'自动提取的章节存在冲突，请在面板核对确认章节。',kind:'chapters'}
  }
  if(task.state==='blocked'&&task.stage!=='review'){
    if(!transcriptionDone)return {label:'确认配置并继续转写',title:'转写受阻 · 待确认后继续',note:'确认模型配置后从断点接续转写，已完成的页面与章节全部保留。',kind:'run',stage:'transcribe',options:{}}
    if(!translationDone)return {label:'重试未完成翻译项',title:'术语或翻译受阻',note:'将仅重试失败或未完成的术语分片或段落块，已完成部分自动复用。',kind:'run',stage:'translate',options:{retryErrors:true}}
    return {label:'重试当前阶段',title:'处理遇到阻断',note:task.message||'请核对阻断原因后重试。',kind:'run',stage:task.stage||'review',options:{}}
  }
  if(!transcriptionDone){
    const paused=['paused','interrupted','stopped'].includes(task.state)
    return {label:paused?'确认配置并继续转写':'开始转写与装配',title:paused?'转写已暂停':'第一阶段：转写与装配',note:paused?'确认模型配置后从断点接续转写，已完成的页面与章节保留。':'依次完成体例与范围确认、章节划分、正文视觉转写和原文装配；完成后等待确认进入术语分析与翻译。',kind:'run',stage:'transcribe',options:{}}
  }
  if(!translationDone){
    const paused=['paused','interrupted','stopped'].includes(task.state)
    return {label:paused?'继续术语分析与翻译':'选择模型并开始翻译',title:paused?'翻译已暂停':'第二阶段：术语分析与翻译',note:paused?'从断点接续术语分析或段落翻译，已完成块自动复用。':'转写与原文装配已完成。确认模型后依次完成术语分析、翻译与译文校验，随后等待审校确认。',kind:'run',stage:'translate',options:paused?{retryErrors:true}:{}}
  }
  if(!rev.approvedForDelivery){
    return {label:'选择模型并开始审校',title:'第三阶段：确认审校模型',note:'双语映射与译文结构已检验通过。确认审校模型后将自动开启独立的 0 上下文审校会话，完成后单独核对发布清单。',kind:'run',stage:'review',options:{}}
  }
  const hasPriorReview=Boolean(task.reviewAudit||['blocked','paused','interrupted','stopped'].includes(task.state))
  if(rev.isAgyReview){
    if(rev.agyConversationId){
      const shortCli=rev.agyConversationId.slice(0,8)
      return {label:`在原 CLI 会话继续审校 (${shortCli})`,title:task.state==='blocked'?'审校中断 · 可接续原 CLI 会话':'审校已暂停 · 可接续原 CLI 会话',note:`沿用现有 Antigravity CLI 会话（${shortCli}）继续处理剩余待审分包，已通过的分包全部保留；如需全新上下文可点击右侧「新建 CLI 会话续审」。`,kind:'run',stage:'review',options:{resumeConversation:true}}
    }
    return {label:hasPriorReview?'开启新 CLI 会话续审':'启动 CLI 审校',title:'开启新 Antigravity CLI 会话审校',note:'开启新的 Antigravity CLI 会话处理待审分包，已通过校验的分包全部保留。',kind:'run',stage:'review',options:{newConversation:true}}
  }
  if(rev.hasReviewOrchestrator){
    return {
      label:`${hasPriorReview?'在当前会话继续审校':'在当前会话开始审校'} (${rev.shortOrchId})`,
      title:task.state==='blocked'?'审校中断 · 可沿用当前会话或新建会话':'接续当前审校编排会话',
      note:`将在当前绑定的 DSH 审校编排会话（${rev.shortOrchId}）中继续处理剩余待审分包，已通过的分包全部保留。若该会话上下文过长或无响应，请点击右侧「新建会话续审」。`,
      kind:'run',
      stage:'review',
      options:{}
    }
  }
  return {
    label:hasPriorReview?'开启新会话继续审校':'开启新会话开始审校',
    title:'将开启全新 0 上下文审校编排会话',
    note:'当前尚无审校专用会话（或仍绑定前置阶段会话）；点击后将自动归档旧会话、创建 0 上下文新编排会话接续待审分包，已通过的分包全部保留。',
    kind:'run',
    stage:'review',
    options:{resetOrchestrator:true}
  }
}
function executionSummary(task,role) {
  if(['review','publish'].includes(task.stage)&&role==='orchestrator'){
    const m=task.reviewConfig?.orchestratorModel??''
    return m&&!m.startsWith('agy/')?'当前审校编排会话（subagent 并发审校分包，可打开会话查看实时进度或人工干预）':'当前审校由 Antigravity CLI 执行；此处保留前置阶段的 DSH 编排会话。'
  }
  if(role==='orchestrator')return ({running:'后台正在处理，查看会话中的派发与实时反馈',blocked:'处理已停止：'+task.message,paused:'已暂停，现有进度保留',interrupted:'已中断，等待恢复'})[task.state]??task.message??'等待派发'
  if(role==='worker'){const p=task.transcriptionProgress;return [task.worker?.model,p?`${p.completed}/${p.total} 页`:null,p?.active?.length?'正在处理第 '+p.active.map(v=>v.page).join('、')+' 页':null,task.state==='blocked'?'处理受阻，查看验收原因':null].filter(Boolean).join(' · ')}
  const progress=task.stage==='glossary'?task.glossaryProgress:task.translationProgress
  return progress?`${task.stage==='glossary'?'术语处理':'翻译'} · ${progress.status??(task.state==='running'?'运行中':task.state)}`:'尚未启动术语或翻译，暂无 CLI 调用'
}
function AntigravityFeedback({task,onMonitor,onOpenSession}) {
  const p=task.reviewFeedback??task.reviewProgress??{},clock=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚无记录'
  const rev=reviewSessionInfo(task)
  const running=task.stage==='review'&&task.state==='running',passed=p.passedPackets,received=p.receivedPackets??p.completedPackets??0
  const status=running?({starting:'正在启动','process-started':'进程已启动，等待会话',connected:'会话已建立，等待模型响应',running:'模型正在处理'}[p.status]??'运行中'):({done:'审校结束',blocked:'处理受阻',paused:'已暂停',interrupted:'已中断'}[p.status]??'等待审校')
  const stale=running&&p.lastActivityAt&&Date.now()-Date.parse(p.lastActivityAt)>120000
  return h('div',{className:'rr-agyFeedback','aria-label':'审校反馈',style:{margin:'16px 0',overflowWrap:'anywhere'}},
    h('strong',null,'审校 · '+(p.statusLabel??status)),
    onMonitor?button('打开审校监控',onMonitor,'rr-detailActionBtn',{disabled:!task.reviewFeedback,style:{marginLeft:12}}):null,
    onOpenSession?button(`打开当前审校会话${rev.shortOrchId?' ('+rev.shortOrchId+')':''} →`,onOpenSession,'rr-detailActionBtn',{style:{marginLeft:8}}):null,
    !task.reviewFeedback?h('p',{role:'alert',className:'rr-taskWarning'},'后端尚未载入审校反馈功能。仅刷新面板无法更新后端，当前无法确认会话与模型活动。'):null,
    h('p',{className:'rr-pipelineNote'},'模型：'+(p.model??task.reviewConfig?.orchestratorModel??'尚未记录')+' · 开始：'+clock(p.startedAt)),
    h('p',{className:'rr-pipelineNote'},'本次派发：'+(p.runId??'旧版调用')+' · '+(!rev.isAgyReview?`当前编排会话：${rev.orchSessionId||'待创建'}`:(p.identityLabel??(p.engine==='dsh-harness'?'DSH 模型服务':'CLI 会话：'+(p.conversationId??'尚未取得'))))),
    h('p',{className:'rr-pipelineNote'},'本轮耗时 '+(p.elapsedSeconds??0)+' 秒 · 当前请求耗时 '+(p.requestSeconds??0)+' 秒 · 距最近有效响应 '+(p.idleSeconds??0)+' 秒'+(running?'；连续 '+Math.round((p.idleTimeoutMs??600000)/60000)+' 分钟无有效响应将暂停。':'。')),
    h('div',{className:'rr-transcriptionProgress'},
      h('div',{className:'rr-transcriptionProgressLabel'},h('span',null,'已有分包结果（含此前轮次）'),h('span',null,`${received} / ${p.totalPackets??'?'} 包已收到 · 本轮完成 ${p.attemptCompletedPackets??0}/${p.attemptTotalPackets??0} 包`)),
      h('progress',{'aria-label':'已收到审校结果',max:p.totalPackets||1,value:received}),
      h('p',{className:'rr-pipelineNote'},passed!==undefined?`通过且无未决问题 ${passed} 包 · 待校验 ${p.awaitingValidationPackets??0} 包 · 校验未通过 ${p.invalidPackets??0} 包 · 有未决问题 ${p.unresolvedPackets??0} 包 · 未返回 ${p.missingPackets??Math.max(0,(p.totalPackets??0)-received)} 包`:'已收到不等于审校通过；完整校验状态尚未载入。')
    ),
    h('p',{className:'rr-pipelineNote'},'最近活动：'+clock(p.lastActivityAt)+(stale?' · 已超过两分钟没有新记录，尚不能据此判断任务失败。':'')),
    p.error?h('p',{role:'alert',className:'rr-taskWarning'},p.error):null,
    p.findings?.length?h('p',{className:'rr-taskWarning'},'待处理问题 '+p.findings.length+' 项；具体原因见下方分包状态。'):null,
    p.lastError?h('p',{className:'rr-taskWarning'},'最近错误（'+clock(p.lastError.time)+'）：'+p.lastError.text+(running?'；调用仍在运行。':'')):null,
    p.events?.length?h('div',{style:{maxHeight:220,overflow:'auto',borderTop:'1px solid var(--dsw-alias-border-l1)'}},...p.events.slice(-6).reverse().map(e=>h('div',{key:e.id,style:{padding:'8px 0',whiteSpace:'pre-wrap',fontSize:12}},h('small',null,clock(e.time)+' · '+({retry:'自动重试',evidence:'原页核证',request:'请求发起',response:'模型响应',validation:'结果校验',reply:'模型反馈',tool:'工具活动',error:'调用错误'}[e.kind]??'活动')),h('div',null,e.text)))):h('p',{className:'rr-pipelineNote'},running?'已发起调用，尚未读取到模型反馈。':'暂无可显示的模型反馈。'),
    h('details',null,h('summary',null,'分包状态与会话信息'),
      h('p',{className:'rr-pipelineNote'},'这里读取本次运行的请求记录与分包结果，查看与刷新不调用模型。'),
      !rev.isAgyReview&&rev.orchSessionId?h('p',{className:'rr-pipelineNote'},'DSH 编排会话：'+rev.orchSessionId):null,
      rev.isAgyReview&&p.conversationId?h('p',{className:'rr-pipelineNote'},'CLI 会话：'+p.conversationId):null,
      h('p',{className:'rr-pipelineNote'},'最近结果文件：'+clock(p.latestResultAt)),
      p.packets?.length?h('table',{className:'rr-taskTable'},h('thead',null,h('tr',null,h('th',null,'分包'),h('th',null,'状态'))),
        h('tbody',null,...p.packets.map(packet=>h('tr',{key:packet.id},h('td',null,packet.id),h('td',null,({'locating-source':'定位原页','rendering-source':'渲染原页','validating-evidence':'核证结果校验','awaiting-evidence':'等待补充证据',queued:'等待派发',requesting:'等待模型响应',receiving:'正在接收',validating:'正在校验','request-failed':'模型请求失败','invalid-result':'返回结果无法采用',passed:'通过且无未决问题',received:'已收到，待校验',invalid:'校验未通过',unresolved:'有未决问题',missing:'未返回'})[packet.status]+(packet.findings?.length?'：'+packet.findings.map(f=>f.text).join('；'):'')))))):null
    )
  )
}
