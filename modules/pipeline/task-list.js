// Packet validation can finish before the review object is marked pass. An applied,
// closed audit is the same completion as status pass; needs-work stays incomplete.
function reviewAccepted(t){
 const review=t.review
 if(!review)return true
 if(review.status==='needs-work')return false
 if(review.status==='pass')return true
 const validation=review.auditValidation
 return review.audit?.applied===true&&validation?.complete===true&&!(validation.unresolved??[]).length&&!(validation.errors??[]).length
}
// This is also used for list summaries; completed stages are persisted only after validation.
export function deliveryState(t){
 const published=isReadableTask(t),reviewComplete=t.stages?.review?.state==='done'&&reviewAccepted(t)
 const running=t.state==='running',ready=t.stages?.translationCheck?.state==='done'
 return {published,reviewComplete,canResume:ready&&!reviewComplete&&!published&&!running,canPreview:reviewComplete&&!published&&!running,caption:published?'已发布':reviewComplete&&!running?'审校通过 · 待发布':null}
}
// Readability is independent of scope approval and individual completed stages.
export function isReadableTask(task) {
  return task.publication?.published === true || task.readingReady === true || Boolean(task.libraryProof)
}
export function pageTaskRows(rows, {offset=0,limit=40,category='all',folderId='all',includeHidden=true}={}) {
  limit=Math.max(1,Math.min(100,Number(limit)||40));offset=Math.max(0,Number(offset)||0)
  const matches=rows.filter(row=>{
    if(!includeHidden&&row.hidden)return false
    const folders=String(row.folderId??'').split(',').map(x=>x.trim()).filter(Boolean)
    return folderId==='all'||(folderId==='uncategorized'?folders.length===0:folders.includes(folderId))
  }).map(row=>{const t={...JSON.parse(row.summary),readingReady:row.library!=null};return {...t,deliveryState:deliveryState(t)}})
  const readable=matches.filter(isReadableTask).length
  const filtered=matches.filter(t=>category==='active'?!isReadableTask(t):category==='done'?isReadableTask(t):true)
  // A saved offset may become invalid when tasks change category or are removed.
  offset=filtered.length?Math.min(offset,Math.floor((filtered.length-1)/limit)*limit):0
  return {tasks:filtered.slice(offset,offset+limit),total:filtered.length,offset,limit,counts:{all:matches.length,active:matches.length-readable,done:readable}}
}
