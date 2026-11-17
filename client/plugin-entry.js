function LiveDocumentExecution({executionSessionId,openExecutionSession}) {
  const [data,setData]=useState(null),[events,setEvents]=useState([]),[error,setError]=useState(''),[expanded,setExpanded]=useState(false),[syncedAt,setSyncedAt]=useState(null)
  const scroll=useRef(null),follow=useRef(true)
  useEffect(()=>{
    if(!executionSessionId)return
    let live=true,pending=false,cursor=null,timer;const controller=new AbortController()
    setData(null);setEvents([]);setError('');setExpanded(false)
    const read=async()=>{
      if(pending||!live)return;pending=true
      try{
        const response=await fetch('/api/paper-reader/pipeline/execution-sessions/'+encodeURIComponent(executionSessionId)+(cursor===null?'':'?cursor='+cursor),{signal:controller.signal,cache:'no-store'})
        const next=await response.json();if(!response.ok)throw new Error(next.error??'读取执行反馈失败')
        if(!live)return;setData(next);setSyncedAt(Date.now());setError('')
        if(!next.bound){clearInterval(timer);return}
        cursor=next.cursor
        if(next.events.length||next.reset)setEvents(previous=>{const combined=next.reset?next.events:[...previous,...next.events],seen=new Set();return combined.filter(e=>{if(seen.has(e.id))return false;seen.add(e.id);return true}).slice(-60)})
      }catch(e){if(live&&e.name!=='AbortError')setError('实时反馈连接失败，正在重连：'+e.message)}finally{pending=false}
    }
    read();timer=setInterval(read,1000)
    return()=>{live=false;clearInterval(timer);controller.abort()}
  },[executionSessionId])
  useEffect(()=>{if(follow.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight},[events,expanded])
  if(!data?.bound)return error?h('p',{role:'alert'},error):null
  const task=data.task,role=data.role,labels={orchestrator:'编排者',worker:'Worker',linguagacha:'LinguaGacha CLI'}
  const visible=events.filter(e=>role==='orchestrator'||e.role===role).slice(-12),last=visible.at(-1)
  const actionStyle={border:'1px solid var(--dsw-alias-border-l1)',background:'transparent',color:'inherit',borderRadius:5,padding:'4px 7px',cursor:'pointer',fontSize:12}
  return h('div',{onKeyDown:e=>{if(e.key==='Escape'){setExpanded(false);e.currentTarget.querySelector('button')?.focus()}},style:{position:'relative',display:'flex',alignItems:'center'}},
    h('button',{type:'button',style:actionStyle,'aria-expanded':expanded,'aria-label':'文档执行详情',onClick:()=>setExpanded(v=>!v)},'执行详情'),
    expanded?h('div',null,
    h('button',{type:'button','aria-label':'关闭文档执行详情',onClick:()=>setExpanded(false),style:{position:'fixed',inset:0,border:0,background:'transparent',cursor:'default',zIndex:49}}),
    h('section',{'aria-label':'文档实时执行',role:'region',style:{position:'absolute',top:'calc(100% + 10px)',right:0,zIndex:50,boxSizing:'border-box',width:'min(580px, calc(100vw - 24px))',maxHeight:'min(620px, calc(100dvh - 110px))',overflow:'auto',padding:14,border:'1px solid var(--dsw-alias-border-l1)',borderRadius:8,boxShadow:'0 8px 28px rgba(0,0,0,.16)',background:'var(--dsw-alias-bg-layer-1)',fontSize:12,color:'var(--dsw-alias-label-primary)'}},
    h('div',{style:{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}},h('strong',null,'文档实时执行 · '+labels[role]),h('span',{role:'status'},({running:'正在处理',blocked:'处理已停止，存在阻断',paused:'已暂停',interrupted:'已中断',idle:'当前阶段结束',queued:'等待执行'})[task.state]??task.state),h('button',{type:'button',onClick:()=>setExpanded(v=>!v),style:{...actionStyle,marginLeft:'auto'},'aria-expanded':expanded},'收起执行详情')),
    h('div',{style:{margin:'6px 0',overflowWrap:'anywhere'}},task.name),
    h('p',{style:{margin:'5px 0',color:task.state==='blocked'?'var(--dsw-alias-state-error-primary)':'inherit'}},task.message),
    data.progress?h('div',null,`${data.progress.completed}/${data.progress.total} 页`+(data.progress.active.length?' · 正在处理第 '+data.progress.active.map(v=>v.page).join('、')+' 页':'')):null,
    h('div',{style:{display:'flex',gap:6,margin:'7px 0',flexWrap:'wrap'}},...Object.entries(labels).map(([key,label])=>h('button',{type:'button',key,style:actionStyle,disabled:key===role||!data.sessions?.[key],onClick:()=>openExecutionSession(data.sessions[key])},'查看'+label+'会话'))),
    error||data.syncError?h('p',{role:'alert',style:{margin:5}},error||data.syncError):h('div',{style:{opacity:.7,fontSize:11}},(last?'最近记录 '+new Date(last.time).toLocaleTimeString('zh-CN',{hour12:false}):'尚无本环节的请求记录')+(syncedAt?' · 同步于 '+new Date(syncedAt).toLocaleTimeString('zh-CN',{hour12:false}):'')+' · 每秒刷新'),
    expanded?h('div',{ref:scroll,onScroll:()=>{const node=scroll.current;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<40},style:{maxHeight:210,overflow:'auto',marginTop:7,borderTop:'1px solid var(--dsw-alias-border-l1)'}},
      ...visible.map(e=>h('article',{key:e.id,style:{padding:'8px 0',borderBottom:'1px solid var(--dsw-alias-border-l1)',overflowWrap:'anywhere'}},
        h('strong',null,new Date(e.time).toLocaleTimeString('zh-CN',{hour12:false})+' · '+labels[e.role]),h('div',{style:{whiteSpace:'pre-wrap',marginTop:4}},e.text.split('\n')[0]),/模型响应|响应内容：/.test(e.text)?h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'inherit',margin:'5px 0',opacity:.85}},e.text.split('\n').slice(1).join('\n').slice(0,600)):null,e.text.includes('\n')?h('details',null,
        h('summary',{style:{cursor:'pointer',padding:'4px 0'}},e.text.includes('输入提示：')?'查看本次输入':e.text.includes('响应')?'查看模型返回正文':'查看处理详情'),
        h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'inherit',margin:4}},e.text)):null)),
      !visible.length?h('p',null,role==='linguagacha'?'尚未启动术语或翻译，暂无 CLI 输入输出。':'尚无本环节的请求记录。'):null
    ):null
  )):null)
}
function ReaderIcon({ size = 18, active = false }) { return h('span', { style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', display: 'inline-flex' } }, icon('book', size)) }
return {
  inject: ['slots', 'locale', 'sessions', 'layout', 'remote', 'remote.session', 'workspaces', 'uiWorkspace'],
  apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'paper-reader: dictionaries')
    const t = ctx.locale.bind(NS)
    const face = {
      onClose: () => ctx.layout.selectPanel(null),
      subscribeSessions: listener => ctx.sessions.list.subscribe(listener),
      getSessions: () => ctx.sessions.list.getSnapshot(),
      sessionSelection: sessionId => {
        try {
          const row = ctx.sessions.list.getSnapshot()?.byId?.[sessionId]
          const proj = row?.projectionValues?.modelSelection
          const pick = proj?.next ?? proj?.lastUsed
          if (!pick?.provider || !pick?.model) return null
          return { provider: pick.provider, model: pick.model, ...(pick.reasoningEffort ? { reasoningEffort: pick.reasoningEffort } : {}) }
        } catch { return null }
      },
      sessionForPaper: async (workspacePath, file) => {
        const key = SESSION_KEY_PREFIX + file
        const remembered = readStoredSession(key)
        const rememberedRow = remembered ? ctx.sessions.list.getSnapshot()?.byId?.[remembered] : null
        if (remembered && (!file.startsWith('document:')||rememberedRow?.agentPreset==='reading-document') && face.sessionExists(remembered) && (!rememberedRow?.cwd || rememberedRow.cwd === workspacePath)) {
          if (file.startsWith('pipeline:')) await face.renameSession(remembered, sessionTitle(file))
          return { id: remembered, reused: true }
        }
        if (typeof workspacePath !== 'string' || workspacePath === '') throw new Error(t('workspaceFailed'))
        // workspaces.create 按规范化路径幂等:没注册过就注册,注册过就原样返回同一个 WorkspaceId
        const view = await ctx.workspaces.create({ path: workspacePath })
        const workspaceId = view?.workspaceId
        if (!workspaceId) throw new Error(t('workspaceFailed'))
        // 宿主以工作区 path 作为新会话的 cwd,并把会话 attach 到该工作区(一个会话只属于一个工作区)
        const id = await face.createSession(workspaceId,file.startsWith('document:')?'reading-document':undefined)
        if (!id) throw new Error(t('sessionFailed'))
        writeStoredSession(key, id)
        // 名字只影响侧栏可读性,失败不阻断派发
        void face.renameSession(id, sessionTitle(file))
        return { id, reused: false }
      },
      // 新建会话:优先用 Client 服务(它同时把新会话行发布进清单投影)
      createSession: async (workspaceId,agentPreset) => {
        if (!agentPreset&&typeof ctx.sessions.create === 'function') return ctx.sessions.create({ workspaceId })
        // 兜底:同一条 Remote 命令 + 刷新本地清单投影(旧代际没有 sessions.create 时仍可用)
        const response = await ctx.remote.session.create({ workspaceId,agentPreset })
        if (response?.ok !== true) {
          throw new Error(`${response?.error?.code ?? 'session-create-failed'}: ${response?.error?.message ?? ''}`)
        }
        if(agentPreset&&response.value?.agentPreset!==agentPreset)throw new Error('宿主没有启用所需文档预设，任务未派发')
        ctx.sessions.refresh?.()
        return response.value?.sessionId
      },
      // 会话改名:只为侧栏可辨认,失败不影响派发
      renameSession: async (sessionId, title) => {
        try { return (await ctx.remote.session.rename({ sessionId, title }))?.ok === true } catch { return false }
      },
      /**
       * 记录的会话还能用吗。清单尚未加载完成时一律当作"能用":宁可复用也不能因为读不到清单
       * 就给同一篇论文重复建会话(那正是需要消除的会话堆积)。读失败同样保守判为可用。
       */
      sessionExists: sessionId => {
        try {
          const list = ctx.sessions.list.getSnapshot()
          if (list?.phase === 'pending') return true
          if (list?.byId?.[sessionId] === undefined) return false
          const archived = ctx.workspaces.list?.getSnapshot?.()?.archivedSessionIds
          return !(Array.isArray(archived) && archived.includes(sessionId))
        } catch { return true }
      },
      // 跳转到刚派发的会话:进展在那里,不必再回一堆会话里找
      openSession: async sessionId => {
        try { await ctx.sessions.refresh?.() } catch {}
        try {
          const list = ctx.sessions.list.getSnapshot()
          if (list?.phase !== 'pending' && list?.byId?.[sessionId] === undefined) throw new Error('sessions.retain: unknown session ' + sessionId)
        } catch (error) {
          if (String(error?.message ?? '').includes('unknown session')) throw error
        }
        ctx.uiWorkspace.openSession(sessionId)
      },
      // 派发结果带错误分类:{ok} 或 {ok:false, error},不再吞掉失败原因
      promptSession: async (sessionId, text) => {
        try {
          return await ctx.sessions.using(sessionId, { source: 'paper-reader' }, async ref => {
            const session = ref?.binding?.session
            if (typeof session?.prompt !== 'function') return { ok: false, error: 'session-binding-missing' }
            const result = await session.prompt([{ type: 'text', text }], 'queue')
            return result?.ok === true
              ? { ok: true }
              : { ok: false, error: String(result?.error ?? result?.stopReason ?? 'prompt-rejected') }
          })
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      },
      // 模型目录:宿主当前代际的 provider/model 清单(remote.session.modelCatalog)
      listModels: async () => {
        const response = await ctx.remote.session.modelCatalog()
        if (response?.ok !== true) {
          throw new Error(`${response?.error?.code ?? 'model-catalog-failed'}: ${response?.error?.message ?? ''}`)
        }
        return response.value
      },
      // 会话级模型选择:成功即对下一次请求生效(宿主同时会把它存为默认模型)
      // 会话级模型/档位选择:成功即对下一次请求生效(宿主同时会把它存为默认)。
      // reasoningEffort 省略时按"不改动档位"处理(宿主保留该会话当前档位)。
      selectSessionModel: async (sessionId, selection) => {
        try {
          const response = await ctx.remote.session.selectModel({
            sessionId, provider: selection.provider, model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          })
          return response?.ok === true
            ? { ok: true, selected: response.value?.selected ?? selection }
            : { ok: false, error: `${response?.error?.code ?? 'select-model-failed'}: ${response?.error?.message ?? ''}` }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      },
    }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'paper-reader', locale: NS, inject: () => face }, ReaderPage))
    ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'paper-reader-live-execution',order:20,inject:sessionId=>({executionSessionId:sessionId,openExecutionSession:id=>ctx.uiWorkspace.openSession(id)})},LiveDocumentExecution))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'paper-reader', order: 30, locale: NS, label: () => t('panel') }, ReaderIcon))
  },
}
