import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto'

export function splitModel(value){
 const id=String(value??''),i=id.indexOf('/')
 if(i<=0||i===id.length-1)throw new Error('请选择 DSH 中的模型')
 return {provider:id.slice(0,i),model:id.slice(i+1)}
}
export const modelKey=s=>`${s.provider}/${s.model}`

// Keep diagnostic facts, never SDK request objects, headers or credentials.
export function modelFailure(error){
 const code=/^[A-Z][A-Z0-9_]*$/.test(error?.code??'')?error.code:'HARNESS_REQUEST_FAILED'
 const message=String(error?.message??'DSH 模型请求未完成')
  .replace(/Bearer\s+[^\s"',}]+/gi,'Bearer [redacted]')
  .replace(/\b(?:sk|sk-ant)-[\w-]+/g,'[redacted]')
  .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization|cookie)["'\s]*[:=]["'\s]*)([^\s"',;}]+)/gi,'$1[redacted]')
  .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g,'[image omitted]').slice(0,1500)
 const status=error?.status??error?.statusCode
 return {code,message,...(Number.isInteger(status)&&status>=100&&status<=599?{status}:{})}
}

export const DEFAULT_REQUEST_TIMEOUT_SECONDS=600
export const DEFAULT_FIRST_HEADER_TIMEOUT_MS=DEFAULT_REQUEST_TIMEOUT_SECONDS*1000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS=180_000
export const DEFAULT_LEASE_MAX_ATTEMPTS=3
export const DEFAULT_LEASE_RETRY_DELAY_MS=1000
const SSE_HEADER_FLUSH_MS=5000
const SSE_KEEPALIVE_MS=15_000

const sleepAbortable=(ms,signal)=>ms<=0?Promise.resolve():new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(Object.assign(new Error('Request aborted'),{code:'ABORTED'}))
 let done=false
 const onAbort=()=>{if(done)return;done=true;clearTimeout(timer);reject(Object.assign(new Error('Request aborted'),{code:'ABORTED'}))}
 const timer=setTimeout(()=>{if(done)return;done=true;signal?.removeEventListener('abort',onAbort);resolve()},ms)
 timer.unref?.()
 signal?.addEventListener('abort',onAbort,{once:true})
})

export function expectedJsonlineIds(messages){
 const userMessages=(messages??[]).filter(m=>m?.role==='user')
 for(let i=userMessages.length-1;i>=0;i--){
  const content=userMessages[i]?.content
  const text=typeof content==='string'?content:Array.isArray(content)?content.filter(b=>b?.type==='text').map(b=>b.text).join('\n'):''
  const fences=[...text.matchAll(/```jsonline\s*\r?\n([\s\S]*?)```/gi)]
  const candidateBlock=fences.length?fences[fences.length-1][1]:''
  if(!candidateBlock.trim())continue
  const ids=[]
  let valid=true
  for(const rawLine of candidateBlock.split(/\r?\n/)){
   const line=rawLine.trim()
   if(!line)continue
   try{
    const obj=JSON.parse(line)
    if(!obj||typeof obj!=='object'||Array.isArray(obj)||!Number.isSafeInteger(obj.id)||obj.id<0||typeof obj.text!=='string'){valid=false;break}
    ids.push(obj.id)
   }catch{valid=false;break}
  }
  if(valid&&ids.length)return ids
 }
 return []
}

function scanJsonlineObjects(text,expectedSet){
 const found=[]
 const str=String(text??'')
 const n=str.length
 let i=0
 while(i<n){
  const idx=str.indexOf('{',i)
  if(idx===-1)break
  if(!/^\{\s*"id"\s*:\s*\d+/.test(str.slice(idx,idx+48))){i=idx+1;continue}
  let depth=0,inStr=false,esc=false,end=-1
  for(let j=idx;j<n;j++){
   const ch=str[j]
   if(inStr){
    if(esc)esc=false
    else if(ch==='\\')esc=true
    else if(ch==='"')inStr=false
    continue
   }
   if(ch==='"')inStr=true
   else if(ch==='{')depth++
   else if(ch==='}'){
    depth--
    if(depth===0){end=j+1;break}
   }
  }
  if(end!==-1){
   const candidate=str.slice(idx,end)
   try{
    const val=JSON.parse(candidate)
    if(val&&typeof val==='object'&&!Array.isArray(val)&&Number.isSafeInteger(val.id)&&expectedSet.has(val.id)&&typeof val.text==='string'&&val.text.trim().length>0){
     found.push({id:val.id,raw:candidate})
     i=end
     continue
    }
   }catch{}
  }
  i=idx+1
 }
 return found
}

export function extractFinalJsonlinePass(text,expectedIds){
 const ids=Array.isArray(expectedIds)?expectedIds:[]
 if(!ids.length)return {text,recovered:false,complete:true}
 const expectedSet=new Set(ids)
 const raw=String(text??'')
 // Fast clean-path check: optional leading <why>...</why> (matching LinguaGacha) + strict unique JSONLINE items only.
 let stripped=raw
 while(true){
  const open=/^\s*<why>/i.exec(stripped)
  if(!open)break
  const rest=stripped.slice(open[0].length)
  const close=/<\/why>/i.exec(rest)
  if(!close){stripped='';break}
  stripped=rest.slice(close.index+close[0].length)
 }
 const seenClean=new Set()
 let allLinesClean=true,cleanItems=0
 for(const line of stripped.split(/\r?\n/)){
  const t=line.trim()
  if(!t||t.startsWith('```'))continue
  try{
   const obj=JSON.parse(t)
   if(obj&&typeof obj==='object'&&!Array.isArray(obj)&&Number.isSafeInteger(obj.id)&&expectedSet.has(obj.id)&&typeof obj.text==='string'&&obj.text.trim().length>0&&!seenClean.has(obj.id)){
    seenClean.add(obj.id);cleanItems++;continue
   }
  }catch{}
  allLinesClean=false;break
 }
 if(allLinesClean&&cleanItems===expectedSet.size&&seenClean.size===expectedSet.size){
  return {text:raw,recovered:false,complete:true}
 }
 // Otherwise scan strictly valid JSON.parse-verified {id, text} objects via JSON string/brace state machine
 // and retain the final valid occurrence per expected request id (never inventing or editing strings).
 const latest=new Map()
 for(const item of scanJsonlineObjects(raw,expectedSet))latest.set(item.id,item.raw)
 if(!latest.size)return {text:raw,recovered:false,complete:false}
 const complete=latest.size===expectedSet.size
 const out=ids.filter(id=>latest.has(id)).map(id=>latest.get(id)).join('\n')
 return {text:out,recovered:true,complete}
}

export function isRetryableLeaseError(error,outerAborted=false){
 if(outerAborted)return false
 const code=/^[A-Z][A-Z0-9_]*$/.test(error?.code??'')?error.code:'HARNESS_REQUEST_FAILED'
 const status=error?.status??error?.statusCode
 const message=String(error?.message??'')
 if(['MODEL_NOT_AVAILABLE','MODEL_NOT_APPROVED','UNSUPPORTED_CONTENT','INVALID_REQUEST','CONTEXT_WINDOW_EXCEEDED','OUTPUT_LIMIT','UPSTREAM_TIMEOUT','UNAUTHORIZED','NOT_FOUND','CATALOG_UNAVAILABLE','UNSUPPORTED_OPTION','INVALID_CONFIG','UNKNOWN_MODEL'].includes(code))return false
 if(code==='RATE_LIMIT')return !/usage\s+limit|\bquota\b|quota\s+will\s+reset|rate_limit_error.*limit/i.test(message)
 if(['STREAM_IDLE_TIMEOUT','TRANSPORT','INCOMPLETE_RESPONSE','EMPTY_RESPONSE','ABORTED','INVALID_JSONLINE_RESPONSE'].includes(code))return true
 if(/flagged as potentially violating our usage policy/i.test(message))return true
 if(Number.isInteger(status)&&status>=400&&status<500&&![408,409,425,429].includes(status))return false
 if(Number.isInteger(status)&&(status>=500||[408,409,425,429].includes(status)))return !/usage\s+limit|\bquota\b|quota\s+will\s+reset/i.test(message)
 if(code==='PI_AI_ERROR'||code==='HARNESS_REQUEST_FAILED'){
  if(/invalid[_\s-]?api[_\s-]?key|unauthorized|forbidden|authentication|permission|model\s+not\s+found|does\s+not\s+exist|context\s+length|maximum\s+context|unsupported/i.test(message))return false
  if(/terminated|connection\s+error|econnreset|etimedout|eai_again|socket\s+hang\s+up|network|overloaded|bad\s+gateway|service\s+unavailable|gateway\s+timeout|internal\s+server\s+error|try\s+again|temporarily\s+unavailable|stream\s+ended\s+before|\b(?:429|500|502|503|504|529)\b/i.test(message))return true
 }
 return false
}

/** All model facts and credentials remain owned by the live Harness. */
export class HarnessModels {
 constructor(host){this.host=host;this.leases=new Set()}
 async admitContent(content){return this.host.attachments.admitPromptContent(content)}
 async catalog(){return this.host.sessionController.modelCatalog()}
 async workers(){const c=await this.catalog();return (c.groups??[]).flatMap(g=>g.models.map(m=>({id:`${g.id}:${m.id}`,provider:g.id,model:m.id,name:`${g.name} · ${m.name}`,reasoning:m.reasoning,default:g.id===c.default?.provider&&m.id===c.default?.model,selectable:true,credential:'由 DSH 管理',timeout:DEFAULT_REQUEST_TIMEOUT_SECONDS,connectionVerified:false})))}
 async validate(selection,{images=false}={}){
  const c=await this.catalog(),group=c.groups?.find(g=>g.id===selection.provider)
  if(!group?.models.some(m=>m.id===selection.model))throw Object.assign(new Error('模型已不在 DSH 可选目录中，请重新选择'),{code:'MODEL_NOT_AVAILABLE'})
  const info=await this.host.llm.resolveModelInfo(selection.provider,selection.model)
  if(selection.reasoningEffort&&!info.reasoning?.efforts.some(e=>e.id===selection.reasoningEffort))throw new Error('此模型不支持所选思考档位')
  if(images&&info.inputModalities&&!info.inputModalities.includes('image'))throw Object.assign(new Error('所选模型不支持图像输入'),{code:'UNSUPPORTED_CONTENT'})
  return info
 }
 async generate(selection,{messages,system,maxTokens,signal,onDelta,onActivity,sessionId=`paper-reader-${randomUUID()}`,streamIdleTimeoutMs=DEFAULT_STREAM_IDLE_TIMEOUT_MS}={}){
  if(signal?.aborted)throw Object.assign(new Error('Request aborted by caller'),{code:'ABORTED'})
  await this.validate(selection,{images:messages?.some(m=>m.content?.some?.(b=>b.type==='image'))})
  const idleMs=streamIdleTimeoutMs===0||streamIdleTimeoutMs===null?0:Math.max(1,Number(streamIdleTimeoutMs)||DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  const attemptController=new AbortController()
  const onOuterAbort=()=>attemptController.abort(signal?.reason)
  signal?.addEventListener('abort',onOuterAbort,{once:true})
  const attemptSignal=attemptController.signal
  let idleTimedOut=false,idleTimer=null,rejectIdle=null,idleError=null,iterator=null
  const idlePromise=idleMs>0?new Promise((_,reject)=>{rejectIdle=reject}):null
  idlePromise?.catch(()=>{})
  const resetIdle=()=>{
   if(!idleMs||idleTimedOut||signal?.aborted)return
   clearTimeout(idleTimer)
   idleTimer=setTimeout(()=>{
    if(signal?.aborted)return
    idleTimedOut=true
    idleError=Object.assign(new Error(`Upstream model stream idle timeout after ${idleMs}ms`),{code:'STREAM_IDLE_TIMEOUT'})
    attemptController.abort(idleError)
    rejectIdle?.(idleError)
   },idleMs)
   idleTimer.unref?.()
  }
  try{
   resetIdle()
   const preparePromise=this.host.llm.prepareCall({provider:selection.provider,model:selection.model,...(selection.reasoningEffort?{reasoningEffort:selection.reasoningEffort}:{}),...(maxTokens?{maxTokens}:{})},attemptSignal)
   preparePromise?.catch?.(()=>{})
   const prepared=idlePromise?await Promise.race([preparePromise,idlePromise]):await preparePromise
   let text='',usage,finish,sawToolCall=false
   iterator=prepared.stream({...prepared.config,messages,system,signal:attemptSignal,sessionId})[Symbol.asyncIterator]()
   while(true){
    const nextPromise=iterator.next()
    nextPromise.catch(()=>{})
    const step=idlePromise?await Promise.race([nextPromise,idlePromise]):await nextPromise
    if(step.done)break
    const chunk=step.value
    if(chunk.type==='text-delta'){
     text+=chunk.text??''
     onDelta?.(chunk.text)
     if(chunk.text?.trim()){resetIdle();onActivity?.({kind:'text'})}
    }else if(chunk.type==='reasoning-delta'){
     if(chunk.text?.trim()){resetIdle();onActivity?.({kind:'reasoning'})}
    }else{
     if(chunk.type==='tool-call-delta')sawToolCall=true
     if(chunk.type==='usage')usage=chunk.usage
     if(chunk.type==='finish')finish=chunk.reason
     if(['start','tool-call-delta','usage','finish'].includes(chunk.type))resetIdle()
    }
   }
   if(!finish||['error','aborted','max-tokens'].includes(finish.kind)){const raw=finish?.failure??{code:finish?.kind==='max-tokens'?'OUTPUT_LIMIT':finish?.kind==='aborted'?'ABORTED':'INCOMPLETE_RESPONSE'};const failure=modelFailure(raw.code||finish?.kind!=='aborted'?raw:{...raw,code:'ABORTED'});throw Object.assign(new Error(failure.message),failure)}
   if(!text.trim()&&!sawToolCall)throw Object.assign(new Error('Upstream returned an empty response'),{code:'EMPTY_RESPONSE'})
   return {text,usage,model:modelKey(selection)}
  }catch(error){
   if(idleTimedOut&&!signal?.aborted)throw idleError
   if(signal?.aborted&&!error?.code)throw Object.assign(new Error('Request aborted by caller'),{code:'ABORTED'})
   throw error
  }finally{
   clearTimeout(idleTimer)
   signal?.removeEventListener('abort',onOuterAbort)
   if(idleTimedOut&&iterator?.return){
    try{await Promise.race([iterator.return(undefined),new Promise(r=>{const t=setTimeout(r,50);t.unref?.()})])}catch{}
   }
  }
 }
 async openLease(selections,{directory,onEvent,sessionId=`paper-reader-${randomUUID()}`,headerFlushMs=SSE_HEADER_FLUSH_MS,keepaliveMs=SSE_KEEPALIVE_MS,streamIdleTimeoutMs=DEFAULT_STREAM_IDLE_TIMEOUT_MS,maxAttempts=DEFAULT_LEASE_MAX_ATTEMPTS,retryDelayMs=DEFAULT_LEASE_RETRY_DELAY_MS}={}){
  const allowed=new Set(selections.map(modelKey));for(const s of selections)await this.validate(s)
  const attemptLimit=Math.min(5,Math.max(1,Number(maxAttempts??DEFAULT_LEASE_MAX_ATTEMPTS)||DEFAULT_LEASE_MAX_ATTEMPTS))
  const baseRetryDelayMs=Math.max(0,Number(retryDelayMs??DEFAULT_LEASE_RETRY_DELAY_MS)||0)
  const token=randomBytes(32).toString('hex'),controllers=new Set()
  const server=http.createServer(async(req,res)=>{
   const provided=Buffer.from(String(req.headers.authorization??'')),expected=Buffer.from('Bearer '+token)
   const send=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
   if(provided.length!==expected.length||!timingSafeEqual(provided,expected))return send(401,{error:{code:'UNAUTHORIZED'}})
   if(req.method==='GET'&&req.url==='/catalog'){try{return send(200,await this.catalog())}catch{return send(503,{error:{code:'CATALOG_UNAVAILABLE'}})}}
   if(req.method!=='POST'||!['/call','/v1/chat/completions'].includes(req.url))return send(404,{error:{code:'NOT_FOUND'}})
   const controller=new AbortController();controllers.add(controller)
   res.on('close',()=>{if(!res.writableEnded)controller.abort()})
   let timer,flushTimer,keepaliveTimer,record,trace,sseStarted=false
   const startSse=()=>{
    if(sseStarted||res.headersSent||res.writableEnded||controller.signal.aborted)return
    sseStarted=true
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'})
    res.flushHeaders?.()
    res.write(': keepalive\n\n')
    keepaliveTimer=setInterval(()=>{if(!res.writableEnded)res.write(': keepalive\n\n')},keepaliveMs)
    keepaliveTimer.unref?.()
   }
   try{
    let size=0,chunks=[];for await(const b of req){size+=b.length;if(size>64*1024*1024)throw new Error('request too large');chunks.push(b)}
    const body=JSON.parse(Buffer.concat(chunks).toString()),selection=body.provider?{provider:body.provider,model:body.model}:splitModel(body.model)
    if(!allowed.has(modelKey(selection)))throw Object.assign(new Error('模型不在当前任务授权范围'),{code:'MODEL_NOT_APPROVED'})
    const approved=selections.find(s=>modelKey(s)===modelKey(selection));Object.assign(selection,approved)
    const timeout=Math.min(1800,Math.max(1,Number(body.timeout)||DEFAULT_REQUEST_TIMEOUT_SECONDS))*1000
    const deadline=Date.now()+timeout
    timer=setTimeout(()=>controller.abort(),timeout)
    let messages,system
    if(req.url==='/call'){
     const content=[{type:'text',text:String(body.prompt??'')},...(body.images??[]).map(i=>({type:'image',mediaType:i.mediaType,data:i.data,name:i.name}))]
     // Attachment admission preserves durable image references and lets the
     // selected Harness adapter perform its own image projection.
     messages=[{role:'user',content:await this.host.attachments.admitPromptContent(content)}]
    }else{
     system=body.messages?.filter(m=>m.role==='system'||m.role==='developer').map(m=>m.content).join('\n')
     messages=(body.messages??[]).filter(m=>!['system','developer'].includes(m.role)).map(m=>({role:m.role,content:typeof m.content==='string'?[{type:'text',text:m.content}]:m.content}))
     if(messages.some(m=>!['user','assistant'].includes(m.role)||m.content.some(b=>b.type!=='text')))throw new Error('不支持此翻译请求格式')
    }
    await this.validate(selection,{images:messages?.some(m=>m.content?.some?.(b=>b.type==='image'))})
    const expectedIds=req.url==='/v1/chat/completions'?expectedJsonlineIds(messages):[]
    record={requestId:randomUUID(),sessionId,provider:selection.provider,requested_model:selection.model,model:modelKey(selection),startedAt:new Date().toISOString(),prompt:body.prompt,messages,system,images:body.images?.map(({name,mediaType})=>({name,mediaType})),attempts:[],response:null,error:null}
    if(directory){await fs.mkdir(directory,{recursive:true});trace=path.join(directory,`harness-${record.requestId}.json`);await fs.writeFile(trace,JSON.stringify(record),{mode:0o600})}
    await onEvent?.({event:'request_started',...selection,requestId:record.requestId})
    const isSse=req.url==='/v1/chat/completions'&&Boolean(body.stream)
    if(isSse){flushTimer=setTimeout(startSse,headerFlushMs);flushTimer.unref?.()}
    const maxTokens=body.max_tokens??body.max_completion_tokens??(req.url==='/call'?undefined:131072)
    let result,wireText='',wireRecovered=false
    for(let attempt=1;;attempt++){
     if(controller.signal.aborted)throw Object.assign(new Error('Client disconnected or lease closed'),{code:'ABORTED'})
     const attemptStartMs=Date.now(),attemptStartedAt=new Date(attemptStartMs).toISOString()
     try{
      const candidate=await this.generate(selection,{messages,system,...(maxTokens?{maxTokens}:{}),signal:controller.signal,sessionId,streamIdleTimeoutMs,...(isSse?{onActivity:()=>startSse()}:{})})
      if(expectedIds.length){
       const extracted=extractFinalJsonlinePass(candidate.text,expectedIds)
       if(!extracted.complete&&attempt<attemptLimit&&!controller.signal.aborted&&(deadline-Date.now())>2000){
        const invalidErr=Object.assign(new Error('Upstream returned incomplete or duplicated JSONLINE output'),{code:'INVALID_JSONLINE_RESPONSE'})
        record.attempts.push({attempt,startedAt:attemptStartedAt,completedAt:new Date().toISOString(),durationMs:Date.now()-attemptStartMs,ok:false,error:modelFailure(invalidErr)})
        const delayMs=Math.min(baseRetryDelayMs*attempt,Math.max(0,deadline-Date.now()-2000))
        if(trace)await fs.writeFile(trace,JSON.stringify(record),{mode:0o600})
        await sleepAbortable(delayMs,controller.signal)
        continue
       }
       wireRecovered=extracted.recovered
       wireText=extracted.recovered?extracted.text:candidate.text
      }else{
       wireText=candidate.text
      }
      result=candidate
      record.attempts.push({attempt,startedAt:attemptStartedAt,completedAt:new Date().toISOString(),durationMs:Date.now()-attemptStartMs,ok:true})
      break
     }catch(attemptError){
      record.attempts.push({attempt,startedAt:attemptStartedAt,completedAt:new Date().toISOString(),durationMs:Date.now()-attemptStartMs,ok:false,error:modelFailure(attemptError)})
      const remainingMs=deadline-Date.now()
      const canRetry=!controller.signal.aborted&&attempt<attemptLimit&&remainingMs>2000&&isRetryableLeaseError(attemptError,controller.signal.aborted)
      if(!canRetry)throw attemptError
      const delayMs=Math.min(baseRetryDelayMs*attempt,Math.max(0,remainingMs-2000))
      if(trace)await fs.writeFile(trace,JSON.stringify(record),{mode:0o600})
      await sleepAbortable(delayMs,controller.signal)
     }
    }
    record.response=result.text;if(wireRecovered)record.wireNormalized=true;record.usage=result.usage;record.completedAt=new Date().toISOString()
    if(trace)await fs.writeFile(trace,JSON.stringify(record),{mode:0o600})
    await onEvent?.({event:'response_received',...selection,requestId:record.requestId,responseCharacters:result.text.length})
    if(req.url==='/call')return send(200,result)
    const completion={id:record.requestId,object:'chat.completion',created:Math.floor(Date.now()/1000),model:body.model,choices:[{index:0,message:{role:'assistant',content:wireText},finish_reason:'stop'}],usage:{prompt_tokens:result.usage?.inputTokens??0,completion_tokens:result.usage?.outputTokens??0}}
    if(isSse){
     startSse()
     res.end('data: '+JSON.stringify({...completion,object:'chat.completion.chunk',choices:[{index:0,delta:{content:wireText},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({...completion,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
    }
    else send(200,completion)
   }catch(e){
    const error=modelFailure(e)
    if(record){record.error=error;record.completedAt=new Date().toISOString();if(trace)await fs.writeFile(trace,JSON.stringify(record),{mode:0o600});await onEvent?.({event:'request_failed',requestId:record.requestId,model:record.requested_model,errorCode:error.code,errorMessage:error.message})}
    if(!res.headersSent)send(502,{error})
    else if(sseStarted&&!res.writableEnded)res.end('data: '+JSON.stringify({error:{message:error.message,type:error.code,code:error.code}})+'\n\n')
   }
   finally{clearTimeout(timer);clearTimeout(flushTimer);clearInterval(keepaliveTimer);controllers.delete(controller)}
  })
  server.keepAliveTimeout=60_000
  server.requestTimeout=DEFAULT_FIRST_HEADER_TIMEOUT_MS
  server.headersTimeout=DEFAULT_FIRST_HEADER_TIMEOUT_MS+5000
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const url=`http://127.0.0.1:${server.address().port}`
  const lease={url,token,serverTimeoutMs:DEFAULT_FIRST_HEADER_TIMEOUT_MS,env:{DSH_MODEL_GATEWAY:url,DSH_MODEL_TOKEN:token},close:async()=>{for(const c of controllers)c.abort();server.closeAllConnections();await new Promise(r=>server.close(r));this.leases.delete(lease)}}
  this.leases.add(lease);return lease
 }
 async close(){await Promise.all([...this.leases].map(l=>l.close()))}
}
