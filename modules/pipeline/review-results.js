import {createHash} from 'node:crypto'
const key=s=>String(s??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const rowFor=(rows,x)=>x.blockId?rows.find(r=>r.blockId===x.blockId):rows.find(r=>r.line===x.line)

// Compatibility never invents a reason or a decision and never edits the raw response.
export function normalizeReviewResult(raw,rows){
 const value=structuredClone(raw),notes=[]
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('审校结果必须为对象')
 for(const field of ['patches','candidate_decisions','glossary_decisions','unresolved']){
  if(value[field]!==undefined&&!Array.isArray(value[field]))throw new Error(field+' 必须为数组')
  value[field]??=[]
 }
 for(const p of value.patches){
  if(!p||typeof p!=='object'||!Array.isArray(p.edits))throw new Error('补丁必须包含 edits 数组')
  if(!String(p.reason??'').trim()&&p.edits.length&&p.edits.every(e=>typeof e?.reason==='string'&&e.reason.trim())){
   p.reason=[...new Set(p.edits.map(e=>e.reason.trim()))].join('；');notes.push({type:'edit-reasons',blockId:p.blockId,line:p.line})
  }
 }
 value.observations??=[]
 value.candidate_decisions=value.candidate_decisions.filter(d=>{
  const row=d&&rowFor(rows,d)
  if(row&&!('candidate' in row)&&['accept','reject','revise'].includes(d.decision)&&typeof d.reason==='string'&&d.reason.trim()){
   value.observations.push({...d,kind:'non-candidate-observation'});notes.push({type:'non-candidate-observation',blockId:row.blockId,line:row.line});return false
  }
  return true
 })
 return {value,notes,rawDigest:digest(raw)}
}

export function reconcileGlossary(decisions){
 const groups=new Map(),merged=[],conflicts=[]
 for(const d of decisions){const k=key(d.src);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(d)}
 for(const [src,items] of groups){
  // Scoped meanings must not become an unconditional global substitution.
  if(new Set(items.map(x=>key(x.dst))).size>1||items.some(x=>x.scope)){
   conflicts.push({src,decisions:items});continue
  }
  const sorted=items.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  merged.push({...sorted[0],publicEligible:items.every(x=>x.publicEligible===true),packets:[...new Set(items.map(x=>x.packet).filter(Boolean))].sort()})
 }
 return {merged,conflicts}
}

export function recoveryIssues(review,validation,id){
 const issues=(review.unresolved??[]).map(issue=>({kind:'content',issue}))
 if(review.status==='needs-work'&&!issues.length)issues.push({kind:'content',issue:'此前结论为 needs-work，但未说明具体问题，请明确理由'})
 for(const e of validation?.errors??[])if(e.packet===id)issues.push({kind:'format',issue:e.error})
 for(const c of validation?.glossaryConflicts??[])if(c.decisions.some(d=>d.packet===id))issues.push({kind:'glossary-conflict',issue:c})
 return issues.map(x=>({...x,id:digest(x).slice(0,16)}))
}

// Recovery is an explicit delta. Omitted patches/decisions/issues survive.
export function mergeReviewRecovery(previous,delta,issues,rows,scope){
 if(delta.packet!==(previous.packet??previous.packet_id)||delta.mode!=='recovery')throw new Error('恢复结果的包编号或 mode 不匹配')
 const next=structuredClone(previous),known=new Map(issues.map(x=>[x.id,x])),resolved=new Set()
 for(const x of delta.resolved_issues??[]){
  if(!known.has(x.id)||resolved.has(x.id)||!String(x.reason??'').trim())throw new Error('恢复结果包含无效的问题解决凭据')
  resolved.add(x.id)
 }
 for(const field of ['patches','candidate_decisions','glossary_decisions']){
  if(delta[field]!==undefined&&!Array.isArray(delta[field]))throw new Error(field+' 必须为数组')
  const identify=x=>field==='glossary_decisions'?key(x.src):rowFor(rows,x)?.line
  const seen=new Set()
  for(const item of delta[field]??[]){
   if(scope&&field!=='glossary_decisions'&&!scope.blockIds.includes(rowFor(rows,item)?.blockId))throw new Error('续审修改超出当前疑点范围：'+field)
   if(scope&&field==='glossary_decisions'&&!scope.rows.some(r=>key(r.source).includes(key(item.src))))throw new Error('续审术语超出当前疑点范围')
   const k=identify(item);if(!k||seen.has(k))throw new Error('恢复结果包含未知或重复条目：'+field);seen.add(k)
   next[field]=(next[field]??[]).filter(x=>identify(x)!==k);next[field].push(item)
  }
 }
 for(const x of delta.remove_patches??[]){
  const line=rowFor(rows,x)?.line
  if(scope&&!scope.blockIds.includes(rowFor(rows,x)?.blockId))throw new Error('删除补丁超出当前疑点范围')
  if(!line||!String(x.reason??'').trim()||!(next.patches??[]).some(p=>rowFor(rows,p)?.line===line))throw new Error('删除补丁缺少有效条目或理由')
  next.patches=next.patches.filter(p=>rowFor(rows,p)?.line!==line)
 }
 const remaining=issues.filter(x=>x.kind==='content'&&!resolved.has(x.id)).map(x=>x.issue)
 if(delta.unresolved!==undefined&&!Array.isArray(delta.unresolved))throw new Error('unresolved 必须为数组')
 next.unresolved=[...new Map([...remaining,...(delta.unresolved??[])].map(x=>[JSON.stringify(x),x])).values()]
 next.status=next.unresolved.length||delta.status==='needs-work'?'needs-work':'pass'
 next.recoveryEvidence=[...(next.recoveryEvidence??[]),{previousDigest:digest(previous),resolved:delta.resolved_issues??[]}]
 return next
}

// Recovery receives only implicated rows; all other accepted work stays outside
// the model's mutation scope and is retained by the host merge.
export function reviewRecoveryScope(issues,rows,previous){
 const ids=new Set();let broad=false
 for(const item of issues){
  if(item.kind==='content'){
   const named=String(item.issue?.blockId??'').match(/B\d{4,}/g)??[]
   if(!named.length)broad=true
   for(const id of named)if(rows.some(r=>r.blockId===id))ids.add(id)
  }else if(item.kind==='glossary-conflict'){
   const term=key(item.issue.src);for(const r of rows)if(key(r.source).includes(term))ids.add(r.blockId)
  }else{
   const line=/L(\d+)/.exec(String(item.issue))?.[1],r=rows.find(r=>r.line===Number(line))
   if(r)ids.add(r.blockId);else broad=true
  }
 }
 if(broad||!ids.size)for(const r of rows)ids.add(r.blockId)
 const selected=rows.filter(r=>ids.has(r.blockId)),inRows=x=>ids.has(rowFor(rows,x)?.blockId)
 const glossarySources=[...new Set((previous.glossary_decisions??[]).filter(g=>selected.some(r=>key(r.source).includes(key(g.src)))).map(g=>g.src))]
 return {blockIds:[...ids],rows:selected,glossarySources,previous:{packet:previous.packet,status:previous.status,patches:(previous.patches??[]).filter(inRows),candidate_decisions:(previous.candidate_decisions??[]).filter(inRows),glossary_decisions:(previous.glossary_decisions??[]).filter(g=>glossarySources.includes(g.src)),unresolved:previous.unresolved??[]}}
}
