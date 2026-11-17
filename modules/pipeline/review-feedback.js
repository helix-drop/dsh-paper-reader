import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {createInterface} from 'node:readline'
import {safeText} from './sessions.js'

export function reviewFindingText(issue){
 if(typeof issue==='string')return issue
 if(!issue||typeof issue!=='object')return '未说明问题'
 return [issue.blockId?'段落 '+issue.blockId:null,issue.src,issue.issue??issue.message??issue.description,issue.reason].filter(x=>typeof x==='string'&&x.trim()).join(' · ')||'未说明问题'
}

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
async function json(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return fallback}}
async function readWindow(file,limit=192*1024,fromEnd=true){
 let handle
 try{handle=await fs.open(file,'r');const stat=await handle.stat(),start=fromEnd?Math.max(0,stat.size-limit):0,buffer=Buffer.alloc(Math.min(limit,stat.size-start));await handle.read(buffer,0,buffer.length,start);let text=buffer.toString('utf8');if(start)text=text.slice(text.indexOf('\n')+1);return {text,mtimeMs:stat.mtimeMs}}
 catch{return {text:'',mtimeMs:0}}finally{await handle?.close()}
}

// Only public replies and tool labels enter the panel. Never mirror reasoning,
// tool arguments, raw tool results, the full prompt or authentication logs.
export function agyTranscriptEvents(text,limit=12){
 return text.split('\n').flatMap(line=>{
  let row;try{row=JSON.parse(line)}catch{return []}
  if(row.type==='ERROR_MESSAGE'&&typeof row.error==='string')return [{id:String(row.step_index)+'-error',time:row.created_at,kind:'error',text:safeText(row.error,1000)}]
  if(row.source!=='MODEL'||row.type!=='PLANNER_RESPONSE')return []
  const events=[],time=row.created_at,id=String(row.step_index)
  if(typeof row.content==='string'&&row.content.trim())events.push({id:id+'-reply',time,kind:'reply',text:safeText(row.content,3000)})
  for(const [i,tool] of (row.tool_calls??[]).entries()){
   let summary=tool.args?.toolSummary??tool.args?.toolAction??''
   try{summary=JSON.parse(summary)}catch{}
   if(typeof summary!=='string')summary=''
   events.push({id:id+'-tool-'+i,time,kind:'tool',text:safeText([tool.name,summary].filter(Boolean).join(' · '),350)})
  }
  return events
 }).slice(-limit)
}

// Old in-flight calls did not save their CLI identity. Recover only a log whose
// startup time AND workspace task path match; never adopt the latest global chat.
export async function locateConversation(manager,t,cliHome=path.join(os.homedir(),'.gemini/antigravity-cli')){
 const p=t.reviewProgress??{},started=Date.parse(p.startedAt)
 if(uuid.test(p.conversationId??''))return p.conversationId
 const key=t.id+':'+p.startedAt
 manager.agyFeedbackLinks??=new Map()
 const cached=manager.agyFeedbackLinks.get(key)
 if(cached?.id||!p.logFile&&Date.now()-(cached?.checkedAt??0)<10000)return cached?.id??null
 let files=p.logFile?[p.logFile]:[]
 if(!files.length&&Number.isFinite(started)){
  files=(await fs.readdir(path.join(cliHome,'log')).catch(()=>[])).filter(f=>/^cli-\d{8}_\d{6}\.log$/.test(f)).sort().reverse().slice(0,30).filter(f=>{
   const m=/cli-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(f)
   return Math.abs(new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime()-started)<60000
  }).map(f=>path.join(cliHome,'log',f))
 }
 const matches=[]
 for(const file of files){
  const {text}=await readWindow(file,256*1024,false)
  if(!p.logFile&&!text.split('\n').some(l=>l.includes('workspaceDirs=')&&l.includes(manager.dir(t.id))))continue
  const id=/Print mode: conversation=([a-f0-9-]{36}),/i.exec(text)?.[1]
  if(id&&uuid.test(id))matches.push(id)
 }
 const id=matches.length===1?matches[0]:null
 if(manager.agyFeedbackLinks.size>=100)manager.agyFeedbackLinks.clear()
 manager.agyFeedbackLinks.set(key,{id,checkedAt:Date.now()});return id
}

const parseRows=text=>text.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
function childIds(row){
 if(row.type!=='GENERIC'||!/^Created the following subagents?:\s*$/m.test(row.content??''))return []
 return [...row.content.matchAll(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/gi)].map(m=>m[1]).filter(id=>uuid.test(id))
}
export function effectiveAgyRow(row){
 if(row.source!=='MODEL')return false
 if(row.type==='PLANNER_RESPONSE')return !!(row.output_tokens>0||row.content?.trim()||row.thinking?.trim()||row.tool_calls?.length)
 return row.type==='GENERIC'&&row.status==='DONE'&&!!row.content?.trim()
}

// Keep only identities and digests in memory. Model reasoning never leaves this
// reader. Error/retry messages and filesystem heartbeat timestamps do not reset idle.
export async function agyActivity(manager,t,{cliHome=path.join(os.homedir(),'.gemini/antigravity-cli'),now=Date.now()}={}){
 const conversationId=await locateConversation(manager,t,cliHome)
 if(!conversationId)return {conversationId:null,events:[],lastError:null,lastInteractionAt:t.reviewProgress?.lastInteractionAt??null,childConversations:[],feedbackAvailable:false}
 manager.agyActivityStates??=new Map()
 const key=t.id+':'+t.reviewProgress?.startedAt+':'+conversationId
 let state=manager.agyActivityStates.get(key)
 if(!state){if(manager.agyActivityStates.size>=100)manager.agyActivityStates.clear();state={streams:new Map(),lastInteraction:Date.parse(t.reviewProgress?.lastInteractionAt)||0};manager.agyActivityStates.set(key,state)}
 const ids=[conversationId],events=[];let lastError=null,available=false
 for(let i=0;i<ids.length&&i<128;i++){
  const id=ids[i],file=path.join(cliHome,'brain',id,'.system_generated/logs/transcript.jsonl')
  let stream=state.streams.get(id)
  if(!stream){stream={children:new Set(),stamp:null};state.streams.set(id,stream)
   // Initial scan recovers children even when delegation has scrolled out of the tail.
   try{for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})){try{for(const child of childIds(JSON.parse(line)))stream.children.add(child)}catch{}}}catch{}
  }
  const stat=await fs.stat(file).catch(()=>null),version=stat?`${stat.mtimeMs}:${stat.size}`:null
  if(version&&version===stream.version){
   available||=stream.available
   for(const child of stream.children)if(!ids.includes(child)&&ids.length<128)ids.push(child)
   events.push(...stream.events)
   if(stream.error&&(!lastError||stream.error.time>lastError.time))lastError=stream.error
   continue
  }
  const transcript=await readWindow(file),rows=parseRows(transcript.text)
  available||=!!transcript.text
  for(const row of rows)for(const child of childIds(row))stream.children.add(child)
  for(const child of stream.children)if(!ids.includes(child)&&ids.length<128)ids.push(child)
  const effective=rows.filter(effectiveAgyRow).at(-1)
  if(effective){
   const stamp=createHash('sha256').update(JSON.stringify([effective.step_index,effective.type,effective.content,effective.thinking,effective.tool_calls,effective.output_tokens])).digest('hex')
   if(stream.stamp!==stamp){
    const completed=/^Completed At: (.+)$/m.exec(effective.content??'')?.[1]
    const rowTime=Date.parse(completed??effective.created_at)||0
    const startedMs=Date.parse(t.reviewProgress?.startedAt)||0
    const time=stream.stamp?now:rowTime>=startedMs?rowTime:0
    if(time>0)state.lastInteraction=Math.max(state.lastInteraction,time)
    stream.stamp=stamp
   }
  }
  const publicEvents=agyTranscriptEvents(transcript.text,Infinity).map(e=>({...e,id:id+':'+e.id,conversationId:id,worker:id!==conversationId}))
  events.push(...publicEvents)
  const err=publicEvents.findLast(e=>e.kind==='error');if(err&&(!lastError||err.time>lastError.time))lastError=err
  if(transcript.text){stream.version=version;stream.available=true;stream.events=publicEvents;stream.error=err}
 }
 return {conversationId,events:events.sort((a,b)=>String(a.time).localeCompare(String(b.time))).slice(-18),lastError,
  lastInteractionAt:state.lastInteraction?new Date(state.lastInteraction).toISOString():null,childConversations:ids.slice(1),feedbackAvailable:available}
}

export function reviewPacketCounts(manifest,validation,versions,validationTime=0){
 const unresolved=new Set((validation?.unresolved??[]).map(x=>x.packet)),valid=new Set(validation?.validPackets??[])
 const errors=new Set((validation?.errors??[]).map(x=>x.packet)),packets=[]
 for(const {id} of manifest){
  const version=versions[id],old=validation?.resultVersions?.[id]
  const unchanged=!!version&&(old?old.mtimeMs===version.mtimeMs&&old.size===version.size:version.mtimeMs<=validationTime)
  const status=!version?'missing':!unchanged?'received':errors.has(id)?'invalid':unresolved.has(id)?'unresolved':valid.has(id)?'passed':'received'
  packets.push({id,status})
 }
 const count=status=>packets.filter(p=>p.status===status).length
 return {totalPackets:packets.length,receivedPackets:packets.length-count('missing'),passedPackets:count('passed'),invalidPackets:count('invalid'),unresolvedPackets:count('unresolved'),awaitingValidationPackets:count('received'),missingPackets:count('missing'),packets}
}

/** Read-only: uses local evidence; no agent prompt, CLI invocation or task save. */
export async function reviewFeedback(manager,t,{cliHome=path.join(os.homedir(),'.gemini/antigravity-cli')}={}){
 if(!t.reviewProgress&&!t.reviewAudit){
  if(t.stage==='review'){
   return {status:'idle',statusLabel:'等待审校',feedbackAvailable:true,model:t.reviewConfig?.orchestratorModel??null,totalPackets:0,receivedPackets:0,attemptCompletedPackets:0,attemptTotalPackets:0}
  }
  return null
 }
 const progress=t.reviewProgress??{},auditDir=t.reviewAudit?.auditDir
 let counts={},latestResultAt=null,findings=[]
 if(auditDir){
  const [manifest,validation,validationStat]=await Promise.all([json(path.join(auditDir,'manifest.json'),[]),json(path.join(auditDir,'validation.json'),{}),fs.stat(path.join(auditDir,'validation.json')).catch(()=>null)])
  const versions={}
  await Promise.all(manifest.map(async({id})=>{if(!/^\d{3,}$/.test(id))return;const stat=await fs.stat(path.join(auditDir,'results',id+'.json')).catch(()=>null);if(stat)versions[id]={mtimeMs:stat.mtimeMs,size:stat.size}}))
  counts=reviewPacketCounts(manifest,validation,versions,validationStat?.mtimeMs)
  findings=[...(validation.errors??[]).map(e=>({packet:e.packet,kind:'format',text:safeText(e.error??'',1000)})),...(validation.unresolved??[]).map(e=>({packet:e.packet,kind:e.kind??'content',text:safeText(reviewFindingText(e.issue),1500)}))]
  for(const packet of counts.packets){packet.resultStatus=packet.status;const live=progress.packetStates?.[packet.id];if(live&&(['queued','requesting','receiving','validating','locating-source','rendering-source','validating-evidence'].includes(live)&&t.state==='running'||['request-failed','invalid-result'].includes(live)))packet.status=live;packet.findings=findings.filter(e=>e.packet===packet.id)}
  const last=Math.max(0,...Object.values(versions).map(v=>v.mtimeMs));if(last)latestResultAt=new Date(last).toISOString()
 }
 const activity=['dsh-harness','dsh-session'].includes(progress.engine)?{conversationId:null,childConversations:[],events:[],lastInteractionAt:progress.lastInteractionAt??null,feedbackAvailable:true}:await agyActivity(manager,t,{cliHome})
 if(['dsh-harness','dsh-session'].includes(progress.engine)&&progress.events?.length)activity.events=progress.events.map(e=>({id:e.id,time:e.time,kind:e.kind,text:safeText(e.text,1000)}))
 if(progress.engine==='dsh-harness'&&auditDir&&!activity.events.length){
  const files=(await fs.readdir(auditDir)).filter(f=>/^harness-\d+\.json$/.test(f)).sort().slice(-18)
  for(const f of files){const r=await json(path.join(auditDir,f),null);if(r)activity.events.push({id:r.packet,time:r.completedAt??r.startedAt,kind:r.error?'error':r.response?'reply':'tool',text:r.error?'模型请求未完成':r.response?'分包 '+r.packet+' 已收到模型返回，程序负责验证和装配':'分包 '+r.packet+' 已发起 DSH 模型请求'})}
 }
 const {logFile,...publicProgress}=progress
 const display=reviewDisplay(progress,t,counts)
 return {...publicProgress,...counts,...activity,...display,findings,model:progress.model??t.reviewConfig?.orchestratorModel,
  status:t.stage==='review'&&t.state!=='running'?t.state:progress.status,
  latestResultAt,lastActivityAt:[progress.lastActivityAt,activity.lastInteractionAt,activity.events.at(-1)?.time].filter(Boolean).sort().at(-1)??null,
  error:safeText(progress.error??'',1500)}
}

// Both views consume the same lifecycle labels and clocks.
export function reviewDisplay(p,t,counts={},now=Date.now()){
 const running=t.stage==='review'&&t.state==='running',end=running?now:Date.parse(p.finishedAt)||now
 const seconds=(a,b=end)=>a?Math.max(0,Math.floor((b-Date.parse(a))/1000)):null
 const labels={starting:'准备审校',preparing:'准备审校',requesting:'等待模型响应',receiving:'正在接收模型返回',validating:'正在校验结果','process-started':'进程已启动，等待会话',connected:'会话已建立，等待模型响应',running:'模型正在处理',done:'审校通过',blocked:counts.invalidPackets?'结果校验未通过':counts.unresolvedPackets?'有未决问题':'处理受阻',paused:'已暂停',interrupted:'已中断'}
 if(p.step==='source-evidence'){labels.requesting='等待原页核证响应';labels.receiving='模型正在核对原页'}
 if(p.step==='evidence-review'){labels.requesting='等待核证复审响应';labels.receiving='模型正在复审核证结果'}
 Object.assign(labels,{'locating-source':'正在定位原页','rendering-source':'正在渲染原页','validating-evidence':'正在校验核证结果','awaiting-evidence':'证据不足，等待补充'})
 const status=running?p.status:t.state==='blocked'?'blocked':p.status
 const states=Object.values(p.packetStates??{}),attemptCompletedPackets=states.filter(s=>['passed','invalid','unresolved','received'].includes(s)).length
 return {attemptTotalPackets:states.length,attemptCompletedPackets,statusLabel:labels[status]??labels[t.state]??'等待审校',elapsedSeconds:seconds(p.startedAt),requestSeconds:seconds(p.requestStartedAt,Date.parse(p.requestFinishedAt)||end),idleSeconds:seconds(p.lastInteractionAt??p.requestStartedAt??p.startedAt),isRunning:running,
  identityLabel:p.engine==='dsh-session'?'DSH 审校编排会话（subagent 并发审校 · 可在编排会话实时查看与干预）':p.engine==='dsh-harness'?'DSH 模型服务 · 当前分包 '+(p.currentPacket??'尚未派发')+' · 请求 '+(p.requestId??'尚未记录'):'CLI 会话：'+(p.conversationId??'尚未取得')+' · 子任务 '+(p.childConversations?.length??0)}
}
