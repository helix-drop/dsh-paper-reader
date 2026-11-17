import {profileReadiness} from './profile-analysis.js'
import fs from 'node:fs/promises'
import path from 'node:path'

const privateName=/(?:^|\/)(?:\.env(?:\..*)?|.*(?:credential|cookie|auth\.json|config\.toml|worker_env).*)(?:\/|$)/i
const within=(base,file)=>file===base||file.startsWith(base+path.sep)
const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}}
const bounded=(n,fallback,max)=>Number.isInteger(n)&&n>=0?Math.min(n,max):fallback

// Follow no links outside the bound task, including links hidden in parent directories.
export async function taskEvidencePath(directory,value='.'){
 const original=path.resolve(directory),base=await fs.realpath(directory),file=path.resolve(original,value)
 if((!within(base,file)&&!within(original,file))||privateName.test(path.relative(within(base,file)?base:original,file)))throw new Error('只能定位当前任务内的非凭证证据文件')
 const real=await fs.realpath(file)
 if(!within(base,real))throw new Error('证据路径指向任务目录之外')
 if(privateName.test(path.relative(base,real)))throw new Error('不能读取凭证文件')
 return real
}
async function existing(directory,file){try{return await taskEvidencePath(directory,file)}catch(e){if(e.code==='ENOENT')return null;throw e}}
export async function evidenceFiles(directory,{directory:relative='.',offset=0,limit=40,query}={}){
 if(query!==undefined&&(typeof query!=='string'||query.length>200))throw new Error('文件名筛选须为不超过 200 字的文本')
 const folder=await taskEvidencePath(directory,relative),entries=(await fs.readdir(folder,{withFileTypes:true})).filter(e=>!e.isSymbolicLink()&&!privateName.test(e.name)&&(query===undefined||e.name.includes(query))).sort((a,b)=>a.name.localeCompare(b.name))
 offset=bounded(offset,0,100000);limit=Math.max(1,bounded(limit,40,100))
 return {directory:folder,total:entries.length,offset,nextOffset:offset+limit<entries.length?offset+limit:null,files:entries.slice(offset,offset+limit).map(e=>({name:e.name,path:path.join(folder,e.name),type:e.isDirectory()?'directory':'file'}))}
}
export async function evidenceSearch(directory,{file,query,offset=0,limit=20}={}){
 if(typeof file!=='string'||typeof query!=='string'||!query||query.length>200)throw new Error('查询需指定证据文件和不超过 200 字的文本')
 const target=await taskEvidencePath(directory,file),stat=await fs.stat(target)
 if(!stat.isFile()||! /\.(?:jsonl?|md|txt|log|csv)$/i.test(target))throw new Error('仅查询明确的文本证据文件')
 if(stat.size>4*1024*1024)throw new Error('证据文件超过 4 MB，请先读取章节摘要或选择较小的证据文件')
 const lines=(await fs.readFile(target,'utf8')).split('\n'),matches=[],terms=[query,...(query.includes('|')?query.split('|').filter(Boolean):[])];offset=bounded(offset,0,1000000);limit=Math.max(1,bounded(limit,20,40));let nextOffset=null
 for(let i=offset;i<lines.length;i++){
  const hit=terms.find(t=>lines[i].includes(t))
  if(!hit)continue
  if(matches.length===limit){nextOffset=i;break}
  const at=lines[i].indexOf(hit),start=Math.max(0,at-180)
  matches.push({line:i+1,text:lines[i].slice(start,start+600),truncated:start>0||lines[i].length>start+600})
 }
 return {file:target,query,matches,nextOffset,totalLines:lines.length}
}
export function taskSummary(t){
 const keys=['id','name','kind','input','path','worker','state','stage','message','createdAt','updatedAt','stages','profile','scope','structureConfirmed','observationConfirmed','transcriptionPlan','execution','translationEngine','translationReport','publication']
 const result=Object.fromEntries(keys.filter(k=>t[k]!==undefined).map(k=>[k,t[k]]))
 if(t.inspection)result.inspection=Object.fromEntries(['fingerprint','verdict','pages','blocks'].filter(k=>t.inspection[k]!==undefined).map(k=>[k,t.inspection[k]]))
 if(t.profileAnalysis)result.profileAnalysis={status:t.profileAnalysis.status,provider:t.profileAnalysis.provider,model:t.profileAnalysis.model,failure:t.profileAnalysis.failure,...profileReadiness(t)}
 if(t.glossaryReport)result.glossaryReport=Object.fromEntries(['status','effectiveFingerprint','issuesFingerprint','transportVerified','cleaningCompleted'].map(k=>[k,t.glossaryReport[k]]))
 result.fullTaskFile='task.json'
 return result
}
export async function evidenceSummary(manager,t,{chapterId,offset=0,limit=8}={}){
 const directory=manager.dir(t.id),deliveryCandidate=path.join(manager.aiDir(t),'delivery'),chapterFile=await existing(directory,path.join(manager.aiDir(t),'chapters.json')),chapters=chapterFile?await read(chapterFile):[]
 const delivery=await existing(directory,deliveryCandidate)
 if(typeof chapterId==='string')chapterId=chapterId.replace(/^chapter_(\d{3,6})$/,'$1')
 if(chapterId!==undefined&&!/^\d{3,6}$/.test(chapterId))throw new Error('章节编号无效')
 const entries=(delivery?await fs.readdir(delivery,{withFileTypes:true}):[]).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/^chapter_\d{3,6}$/.test(e.name)&&(!chapterId||e.name==='chapter_'+chapterId)).sort((a,b)=>a.name.localeCompare(b.name))
 offset=bounded(offset,0,100000);limit=Math.max(1,bounded(limit,8,12));const summaries=[]
 for(const entry of entries.slice(offset,offset+limit)){
  const folder=await taskEvidencePath(directory,path.join(delivery,entry.name)),id=entry.name.slice(8)
  const statePath=await existing(directory,path.join(folder,'state.json')),reportPath=await existing(directory,path.join(folder,'output/report.json'))
  const state=statePath?await read(statePath):null,report=reportPath?await read(reportPath):null
  // state.book names the selected isolated book; do not interpret <book> as document/.
  const book=await existing(directory,state?.book??path.join(folder,'selected/book'))
  const selectedAi=book?path.join(book,'ai_convert'):null,paths={state:statePath,report:reportPath,selectedBook:book}
  for(const [key,relative] of Object.entries({actions:`actions/chapter_${id}.json`,similarity:`similarity_report/chapter_${id}.json`,body:'edits/body',notes:'edits/notes',images:'page_images'}))paths[key]=selectedAi?await existing(directory,path.join(selectedAi,relative)):null
  const chapter=chapters.find(c=>String(c.id)===id)
  summaries.push({chapterId:id,title:chapter?.title??null,startPage:chapter?.start_page??null,endPage:chapter?.end_page??null,qualityStatus:report?.quality_status??'report_missing',deliveryStatus:report?.delivery_status??null,executionFinished:state?.finished??false,errorCount:report?.errors?.length??0,errors:(report?.errors??[]).slice(0,8).map(s=>String(s).slice(0,700)),errorsTruncated:(report?.errors?.length??0)>8,paths,pageBudgets:Object.entries(state?.attempts??{}).slice(0,30).map(([page,b])=>({page:Number(page),used:b.used??0,needsRepair:b.needs_repair??false,lastState:b.history?.at(-1)?.state??null,lastOutcome:b.history?.at(-1)?.outcome??null}))})
 }
 const failureDiagnostic=t.state==='blocked'?(t.message??(t.log?.at(-1)?.diagnostic??null)):null
 return {taskId:t.id,taskState:t.state,stage:t.stage,message:t.message,failureDiagnostic,taskDirectory:directory,totalChapters:entries.length,offset,nextOffset:offset+limit<entries.length?offset+limit:null,chapters:summaries,instructions:'paths 只返回实际存在的证据；null 表示不存在。报告中的 <book> 指该章节 paths.selectedBook。先看 errors 和质量状态，再读取对应 actions/similarity 的必要部分。需要定位文件时调用 files，需要查询文件时调用 search；禁止猜测文件名。executionFinished 仅表示执行结束，不代表验收通过。'}
}
