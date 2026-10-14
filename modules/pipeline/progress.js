import fs from 'node:fs/promises'
import path from 'node:path'
const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return null}}
const files=async dir=>{try{return await fs.readdir(dir)}catch{return []}}
export async function transcriptionProgress(task,directory){
  if(task.legacy||task.input.type!=='pdf'||!task.scope)return null
  const ai=path.join(directory,'document/ai_convert'),chapters=await read(path.join(ai,'chapters.json'))??[],planned=new Set(),completed=new Set(),active=[],failed=new Set(),review=new Set(),verified=new Set();let hasProtocol=false;
  const body=await files(path.join(ai,'edits/body'));for(const f of body){const m=f.match(/^page_(\d+)\.json$/);if(m)completed.add(Number(m[1]))}
  for(const chapter of chapters){
    for(let p=chapter.start_page;p<=chapter.end_page;p++)planned.add(p)
    const d=path.join(ai,'delivery','chapter_'+chapter.id),state=await read(path.join(d,'state.json'));if(!state)continue
    const report=await read(path.join(d,'output/report.json'));if(report?.input_protocol?.required===true&&Array.isArray(report.input_protocol.unverified_pages)){hasProtocol=true;const missing=new Set(report.input_protocol.unverified_pages);for(let p=chapter.start_page;p<=chapter.end_page;p++)if(!missing.has(p))verified.add(p)}
    const selected=await files(path.join(d,'selected/book/ai_convert/edits/body'));for(const f of selected){const m=f.match(/^page_(\d+)\.json$/);if(m)completed.add(Number(m[1]))}
    for(const [key,budget] of Object.entries(state.attempts??{})){const page=Number(key),history=budget.history??[],last=history.at(-1);if(last?.task==='notes'&&history.some(e=>e.task==='notes'&&['selected','retained_previous'].includes(e.state)))completed.add(page);if(last?.state==='started'&&task.state==='running'&&task.stage==='transcribe')active.push({page,round:last.round});if(last?.state==='failed'&&!completed.has(page))failed.add(page);if(last?.outcome==='uncertain'||last?.worker_status==='review_pending')review.add(page)}
  }
  const total=planned.size||Number(task.scope.pages)||0;if(!total)return null
  const done=task.stages.transcribe?.state==='done'?total:[...completed].filter(p=>!planned.size||planned.has(p)).length;
  return {completed:Math.min(done,total),total,percent:Math.min(100,Math.round(done/total*100)),verifiedInputPages:hasProtocol?verified.size:null,active,failed:failed.size,review:review.size,stageComplete:task.stages.transcribe?.state==='done',sourcePages:task.inspection?.pages??total,status:task.state}
}
