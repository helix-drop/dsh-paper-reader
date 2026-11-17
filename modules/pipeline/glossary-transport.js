import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {hash} from './markdown.js'

// Only these audited prompts may migrate without invalidating prior results.
// The migration changes serialization, never the terminology instructions.
const legacyPromptHashes={analysis:'77c216168da62d6d3f80a4993e02c06f9cbc2715700bee8970ab00b068fd8c29',consolidation:'86e0eecc748c2dc30a1738a4ca3e4a7b75f6585b73b8dceb1d984945531b02db'}
export function upgradeGlossaryProtocol(kind,prompt){
 if(hash(prompt)!==legacyPromptHashes[kind])return null
 return prompt.replace(/^Follow LinguaGacha's outer JSONLINE protocol[^\n]*$/m,'Inner payload schema (this is NOT the outer response; serialize it into the outer text field):').trimEnd()+`\n\nREQUIRED OUTER RESPONSE FORMAT:\nEach LinguaGacha input item has an outer integer id and text. Read the terminology unit from that text. Return exactly one JSONLINE object for each outer input id, with the SAME outer id and a nonempty text STRING. The text string must contain the serialized inner payload described above, with JSON quotes and backslashes escaped correctly.\nExample with an empty ${kind==='analysis'?'terms':'groups'} array:\n`+JSON.stringify({id:0,text:JSON.stringify({unitId:kind==='analysis'?'A0001':'G0001',[kind==='analysis'?'terms':'groups']:[]})})+`\nCopy the actual outer id and inner unitId from the input; the example values are placeholders. Never put unitId, terms or groups at the outer level. Inner member ids identify terms and must not replace the outer request id. Return only outer JSONLINE objects, with no Markdown fences or commentary.\n`
}
export function compatibleGlossaryPrompt(kind,previous,current){return previous===current||upgradeGlossaryProtocol(kind,previous)===current}

export function encodeGlossaryUnit(unit){
 const encoded=JSON.stringify(unit).replace(/"(?:[^"\\]|\\.)*"/g,literal=>literal.replace(/[\[\]\/|<>.]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')))
 if(JSON.stringify(JSON.parse(encoded))!==JSON.stringify(unit))throw new Error('术语输入编码改变了原始数据')
 return encoded
}
const logCache=new Map()
export async function nativeRequests(){
 const root=path.join(os.homedir(),'LinguaGacha/log'),records=[]
 for(const name of (await fs.readdir(root).catch(()=>[])).filter(n=>/^app\.\d{8}\.jsonl$/.test(n)).sort()){
  const full=path.join(root,name),st=await fs.stat(full).catch(()=>null);if(!st)continue
  const cached=logCache.get(full)
  if(cached&&cached.size===st.size&&cached.mtimeMs===st.mtimeMs){records.push(...cached.records);continue}
  const fileRecords=[]
  for(const line of (await fs.readFile(full,'utf8')).split(/\r?\n/)){
   if(!line.trim())continue
   try{const value=JSON.parse(line).content;if(value&&typeof value==='object'&&Array.isArray(value.pairs))fileRecords.push(value)}catch{}
  }
  logCache.set(full,{size:st.size,mtimeMs:st.mtimeMs,records:fileRecords})
  records.push(...fileRecords)
 }
 return records
}
export async function verifyModelInputs(directory,receipt,units,readRequests=nativeRequests){
 let file=receipt.transportFile??path.join(directory,'transport-proofs',hash(String(receipt.startedAt)+receipt.directory)+'.transport-proof.json')
 const existing=await fs.readFile(file).catch(()=>null),expected=new Map(units.map(u=>[u.unitId,hash(JSON.stringify(u))]));let proof,legacy
 if(existing){
  if(receipt.transportSha256&&hash(existing)!==receipt.transportSha256)throw new Error('术语实际输入回执摘要变化')
  proof=JSON.parse(existing)
  if(proof.schemaVersion===1&&receipt.transportVerified===false){legacy=proof;proof=null;file=file.replace(/\.transport-proof\.json$/,'.v2.transport-proof.json')}
 }
 if(!proof){
  const ranges=[receipt],observations=[],checkpoint=JSON.parse(await fs.readFile(path.join(directory,'checkpoint.json'),'utf8').catch(()=>'null'))
  if(legacy)observations.push(...legacy.observations)
  for(const relative of Object.keys(checkpoint?.artifacts??{})){
   if(relative.split(path.sep).includes('..')||path.isAbsolute(relative))throw new Error('术语恢复证据路径异常')
   if(relative.endsWith('receipt.json'))try{ranges.push(JSON.parse(await fs.readFile(path.join(directory,relative))))}catch{}
   if(relative.endsWith('transport-proof.json'))try{observations.push(...JSON.parse(await fs.readFile(path.join(directory,relative))).observations)}catch{}
  }
  for(const request of await readRequests()){
   const time=Date.parse(request.ended_at??request.started_at)
   if(!ranges.some(r=>time>=Date.parse(r.startedAt)&&time<=Date.parse(r.endedAt??new Date().toISOString())))continue
   for(const pair of request.pairs??[]){
    // Input integrity is independent of whether the response decoded successfully.
    const source=String(pair.src??''),unitId=source.match(/"unitId"\s*:\s*"([^"\s]+)"/)?.[1]
    if(expected.has(unitId))observations.push({unitId,source,endedAt:request.ended_at??request.started_at})
   }
  }
  proof={schemaVersion:2,expectedUnits:units,observations,createdAt:new Date().toISOString()}
  // A later migration must not overwrite evidence already referenced by a checkpoint.
  if(legacy)file=file.replace(/\.v2\.transport-proof\.json$/,'.v2.'+hash(JSON.stringify(proof))+'.transport-proof.json')
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(proof,null,2)+'\n',{mode:0o600})
 }
 const latest=new Map()
 for(const observation of [...proof.observations].sort((a,b)=>Date.parse(a.endedAt)-Date.parse(b.endedAt))){
  if(!expected.has(observation.unitId))continue
  let valid=false;try{valid=hash(JSON.stringify(JSON.parse(observation.source)))===expected.get(observation.unitId)}catch{}
  latest.set(observation.unitId,valid)
 }
 const valid=new Set([...latest].filter(([,valid])=>valid).map(([id])=>id)),bytes=await fs.readFile(file)
 receipt.transportFile=file;receipt.transportSha256=hash(bytes);receipt.transportVerified=valid.size===units.length
 return {valid,file,proof}
}

export async function captureModelOutput(receipt,units,readRequests=nativeRequests,{partial=false}={}){
 const expected=new Map(units.map(u=>[u.unitId,JSON.stringify(u)])),latest=new Map()
 for(const request of await readRequests()){
  const endedAt=request.ended_at??request.started_at,time=Date.parse(endedAt)
  if(!Number.isFinite(time)||time<Date.parse(receipt.startedAt)||time>Date.parse(receipt.endedAt??new Date().toISOString()))continue
  for(const pair of request.pairs??[]){
   if(!pair.dst)continue
   let unit;try{unit=JSON.parse(pair.src)}catch{continue}
   if(expected.get(unit.unitId)!==JSON.stringify(unit))continue
   const previous=latest.get(unit.unitId)
   if(!previous||Date.parse(previous.endedAt)<=time)latest.set(unit.unitId,{unitId:unit.unitId,source:pair.src,returnedText:pair.dst,endedAt})
  }
 }
 if(!latest.size&&partial)return null
 if(latest.size!==units.length&&!partial)throw new Error('术语模型原始返回缺失，不能以经过排版替换的导出文件代替')
 const observations=units.map(u=>latest.get(u.unitId)).filter(Boolean),file=path.join(receipt.directory,'model-output.txt'),evidenceFile=path.join(receipt.directory,'model-output-evidence.json'),raw=observations.map(o=>o.returnedText).join('\n')+'\n'
 await fs.writeFile(file,raw,{mode:0o600});await fs.writeFile(evidenceFile,JSON.stringify({schemaVersion:1,observations},null,2)+'\n',{mode:0o600})
 return {file,evidenceFile,raw,units:observations.length}
}

function extractQuotaResetHint(message){
 const clean=String(message??'').replace(/\\"/g,'"').replace(/\\n/g,' ')
 const direct=clean.match(/Your quota will reset[^"{}\\]*/i)?.[0]?.replace(/[.\s]+$/,'')?.trim()
 if(direct)return direct.slice(0,200)
 const inner=[...clean.matchAll(/"message"\s*:\s*"([^"{}]+)"/g)].map(m=>m[1].trim()).find(s=>/usage\s+limit|\bquota\b|reset/i.test(s))
 if(inner)return inner.replace(/[.\s]+$/,'').slice(0,200)
 return '供应商返回额度上限'
}

export const QUOTA_ABORT_WINDOW_MS=180_000
export function formatQuotaExhaustedMessage(model,resetHint,completed,total){
 return `模型 ${model} 额度已用尽（${resetHint||'供应商返回额度上限'}）。已完成 ${completed}/${total} 个单元并已保存。额度恢复后在面板点击继续，只处理未完成部分；如需换模型，请在面板重新确认翻译阶段。`
}
export function createQuotaAbortTracker({model,initialCompleted=0,windowMs=QUOTA_ABORT_WINDOW_MS,onAbort}){
 let completed=initialCompleted,quota=null,aborted=null,timer=null
 const clear=()=>{if(timer){clearTimeout(timer);timer=null}}
 return {
  onFailure(failure){
   if(aborted||failure?.reason!=='quota')return
   const at=failure.at??new Date().toISOString(),hint=failure.resetHint||'供应商返回额度上限'
   if(!quota){
    quota={firstAt:at,lastAt:at,count:1,resetHint:hint,model}
    timer=setTimeout(()=>{if(!quota||aborted)return;aborted={...quota};onAbort?.(aborted)},windowMs)
    timer.unref?.()
   }else{
    quota.lastAt=at;quota.count+=1;if(failure.resetHint)quota.resetHint=failure.resetHint
   }
  },
  onProgress(nextCompleted){
   if(!Number.isFinite(nextCompleted)||nextCompleted<=completed)return
   completed=nextCompleted
   if(quota&&!aborted){clear();quota=null}
  },
  get aborted(){return aborted},
  close(){clear()},
 }
}

export const TIMEOUT_ABORT_WINDOW_MS=180_000
export function createTimeoutAbortTracker({initialCompleted=0,windowMs=TIMEOUT_ABORT_WINDOW_MS,onAbort}={}){
 let completed=initialCompleted,pending=null,aborted=null,timer=null
 const clear=()=>{if(timer){clearTimeout(timer);timer=null}}
 return {
  onFailure(failure){
   if(aborted||failure?.reason!=='timeout')return
   const at=failure.at??new Date().toISOString()
   if(!pending){
    pending={...failure,firstAt:at,at,count:1}
    timer=setTimeout(()=>{if(!pending||aborted)return;aborted={...pending};onAbort?.(aborted)},windowMs)
    timer.unref?.()
   }else{
    pending.at=at;pending.count=(pending.count??1)+1
    if(failure.observedVia)pending.observedVia=failure.observedVia
    if(failure.scope)pending.scope=failure.scope
   }
  },
  onProgress(nextCompleted){
   if(!Number.isFinite(nextCompleted)||nextCompleted<=completed)return
   completed=nextCompleted
   if(pending&&!aborted){clear();pending=null}
  },
  get pending(){return pending},
  get aborted(){return aborted},
  close(){clear()},
 }
}

export function glossaryProviderFailure(event){
 if(!['warning','error'].includes(event.level))return null
 const worker=event.source==='engine-worker'&&event.content?.kind==='translation_result',message=worker?(event.content.summary??[]).join(' '):event.source==='engine'&&typeof event.content==='string'?event.content:''
 const isQuota=(/\\?"code\\?"\s*:\s*\\?"RATE_LIMIT\\?"/.test(message)||event.error?.code==='RATE_LIMIT')&&/rate_limit_error|usage\s+limit|\bquota\b/i.test(message)
 if(isQuota)return {reason:'quota',resetHint:extractQuotaResetHint(message),observedVia:'native-log',at:event.created_at,scope:'active-cli-batch'}
 const reason=/Provider finish_reason:\s*content_filter/i.test(message)?'content_filter':/模型请求超时/.test(message)?'timeout':/供应商返回长度截断/.test(message)?'output_limit':null
 return reason?{reason,observedVia:'native-log',at:event.created_at,scope:'active-cli-batch'}:null
}

export function glossaryFailureForUnits(event,units,{exclusiveCli=false,model,sources}={}){
 const failure=glossaryProviderFailure(event)
 if(!failure||!units&&!sources)return failure
 const expected=new Map((units??[]).map(u=>[u.unitId,JSON.stringify(u)]))
 const matches=(event.content?.pairs??[]).some(pair=>{if(sources?.includes(pair.src))return true;try{const unit=JSON.parse(pair.src);return expected.get(unit.unitId)===JSON.stringify(unit)}catch{return false}})
 if(matches)return failure
 // The CLI key scheduler logs timeout/content-filter failures before a work
 // unit produces pairs. This branch is only enabled under the shared CLI lock
 // and only observes new headless events; it must not ignore those retries.
 const loggedModel=event.error?.context?.model_id
 if(exclusiveCli&&event.source==='engine'&&event.window===false&&(!loggedModel||!model||loggedModel.toLowerCase()===model.toLowerCase()))return {...failure,scope:'exclusive-cli-window'}
 return null
}

// Observe explicit provider rejections; do not let the CLI retry them without a bound.
export async function watchGlossaryProviderFailure(onFailure,{units,model,sources}={}){
 const root=path.join(os.homedir(),'LinguaGacha/log'),offsets=new Map(),tails=new Map();let closed=false,busy=false
 const files=async()=>(await fs.readdir(root).catch(()=>[])).filter(n=>/^app\.\d{8}\.jsonl$/.test(n))
 for(const file of await files())offsets.set(file,(await fs.stat(path.join(root,file))).size)
 const poll=async()=>{
  if(closed||busy)return;busy=true
  try{for(const file of await files()){
   const full=path.join(root,file),size=(await fs.stat(full)).size,offset=offsets.get(file)??0;if(size<=offset)continue
   const handle=await fs.open(full,'r'),buffer=Buffer.alloc(size-offset);try{await handle.read(buffer,0,buffer.length,offset)}finally{await handle.close()}offsets.set(file,size)
   const lines=((tails.get(file)??'')+buffer.toString()).split('\n');tails.set(file,lines.pop())
   for(const line of lines){let event;try{event=JSON.parse(line)}catch{continue}
    const failure=glossaryFailureForUnits(event,units,{exclusiveCli:true,model,sources})
    if(!closed&&failure){
     if(failure.reason==='quota'||failure.reason==='timeout'){onFailure(failure);continue}
     closed=true;clearInterval(timer);onFailure(failure);return
    }
   }
  }}catch{}finally{busy=false}
 }
 const timer=setInterval(()=>{void poll()},1000);timer.unref()
 return ()=>{closed=true;clearInterval(timer)}
}
