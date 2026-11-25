import {normalizeTranslationQuotes,quoteNormalizationRecord} from './translation-typography.js'
import {verifySourceEvidence,validateEvidenceResolution} from './source-evidence.js'
import {normalizeReviewResult,reconcileGlossary} from './review-results.js'
import {runHarnessReview} from './harness-review.js'
import fs from 'node:fs/promises'
import {statSync} from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {hash,markdownBlocks,checkMarkdownPair,imageReferences} from './markdown.js'
import {loadSourceMap,saveTranslationMap,writeSourceMap} from './source-map.js'
import {safeText} from './sessions.js'
import {agyActivity} from './review-feedback.js'
import {normalizeGlossaryCategory,isNonUniversalPublicTerm,normalizeGlossaryDomains} from './glossary-semantics.js'

const normalize=s=>String(s??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()
const termPatterns=new Map(),normalizedBodies=new Map()
const contains=(body,src)=>{
 const term=normalize(src);if(!term)return false
 let value=normalizedBodies.get(body)
 if(value===undefined){value=normalize(body);if(normalizedBodies.size>=8192)normalizedBodies.clear();normalizedBodies.set(body,value)}
 let pattern=termPatterns.get(term)
 if(!pattern){const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),cjk=/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(term);pattern=new RegExp((cjk?'':'(?<![\\p{L}\\p{N}_])')+escaped+(cjk?'':'(?![\\p{L}\\p{N}_])'),'iu');if(termPatterns.size>=4096)termPatterns.clear();termPatterns.set(term,pattern)}
 return pattern.test(value)
}
const containsExactCase=(body,src)=>{
 const term=String(src??'').normalize('NFKC').trim().replace(/\s+/g,' ');if(!term)return false
 const value=String(body??'').normalize('NFKC').replace(/\s+/g,' ')
 if(!value.includes(term))return false
 const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),cjk=/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(term)
 return new RegExp((cjk?'':'(?<![\\p{L}\\p{N}_])')+escaped+(cjk?'':'(?![\\p{L}\\p{N}_])'),'u').test(value)
}
const termMatchesSource=(src,term)=>{
 if(!term?.src)return false
 const raw=String(term.src).trim(),titleCase=/^[\p{Lu}]/u.test(raw)&&!/^[\p{Lu}\p{N}_'’.\-\s]+$/u.test(raw)
 const needsExact=term.case_sensitive===true||term.matchPolicy?.caseSensitive===true||(titleCase&&(/^《.*》$/.test(String(term.dst??'').trim())||/(?:书名|人名|专名|篇名|机构|五行|自注|医家|古代|官职|\b(?:person|title|book|proper|institution|general office)\b)/i.test(String(term.info??''))))
 return needsExact?containsExactCase(src,term.src):contains(src,term.src)
}

async function atomic(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true})
 const tmp=`${file}.${randomUUID()}.tmp`
 try{await fs.writeFile(tmp,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(tmp,file)}
 finally{await fs.unlink(tmp).catch(()=>{})}
}
async function readJson(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
function pendingReviewPackets(manifest,validation){
 const passed=new Set(validation.validPackets),unresolved=new Set(validation.unresolved.map(item=>item.packet))
 return manifest.filter(p=>!passed.has(p.id)||unresolved.has(p.id)).map(p=>p.id)
}
const splitLines=text=>String(text??'').replace(/\r\n/g,'\n').replace(/\n+$/,'').split('\n')

export function classifyLine(text){
 const s=String(text??'').trim()
 if(/^#{1,6}\s/.test(s))return 'heading'
 if(/^\[footnote-\d+\]\\|^\[\^[^\]]+\]:|^\^[^\]]+\]:/.test(s))return 'note'
 if(s.startsWith('- [['))return 'navigation'
 if(s.startsWith('![')||s==='---')return 'other'
 return 'body'
}

export function footnoteMultiset(text){
 const marks=String(text??'').match(/\[\^[^\]]+\]|\[footnote-\d+\]/g)??[],counts=new Map()
 for(const m of marks)counts.set(m,(counts.get(m)??0)+1)
 return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}:${v}`).join('|')
}

export function structuralFlags(line,oldText,newText){
 const out=[],old=String(oldText??''),next=String(newText??'')
 const flag=(type,sample='')=>out.push({line,type,sample})
 if(old.length>120&&next.length<old.length/2)flag('short')
 if(old.length>0&&next.length>1.5*old.length)flag('expansion')
 if(old&&next.includes(old)&&next.length>old.length+20)flag('contains_original')
 for(let i=0;i<=next.length-30;i++){
  const word=next.slice(i,i+30)
  if(next.indexOf(word,i+30)>=0&&old.split(word).length-1<2){flag('repeat30',word);break}
 }
 for(const [label,pattern] of [
  ['adjacent_repeat',/(.{6,29})\1/u],
  ['annotation',/建议改为|无需修改|请补充|不构成不一致|（无）|[（(](?:原文(?:斜体|如此|分词|作|为|有误|未明)|译者?注[:：]|校注[:：])[^）)\n]*[）)]|（建议统一|（或统一|```/u],
  ['seam',/。[,，；;]/u],
  ['nested_td',/<td[^>]*>\s*<td/u],
  ['quote_seam',/。”\[\^[^\]]+\]”|"[^"\n]+"”/u]
 ]){
  const match=pattern.exec(next)
  if(match&&!pattern.test(old))flag(label,match[0].slice(0,80))
 }
 for(const [op,cl] of [['“','”'],['「','」']]){
  const count=(s,ch)=>s.split(ch).length-1
  if(count(old,op)===count(old,cl)&&count(next,op)!==count(next,cl))flag('quote_balance',op+cl)
 }
 const prefix=/^(\[\^[^\]]+\]:|\[footnote-\d+\]\\\S+)/.exec(old)
 if(prefix&&!next.startsWith(prefix[0]))flag('note_prefix',prefix[0])
 return out
}

export function scanLineHints(sourceLine,translationLine,glossaryTerms=[],reviewIssues=[],classify='body'){
 const hints=[],src=String(sourceLine??''),dst=String(translationLine??'')
 for(const issue of reviewIssues){
  const hit=(issue.members??[]).find(m=>contains(src,m.src))
  if(hit)hints.push({type:'unresolved_term',conceptId:issue.conceptId,src:hit.src,proposed:hit.proposed,reason:issue.reason})
  else if(issue.src&&contains(src,issue.src))hints.push({type:'unresolved_term',conceptId:issue.conceptId??issue.issueId,src:issue.src,proposed:issue.candidates??[],reason:issue.reason})
 }
 for(const term of glossaryTerms){
  if(!termMatchesSource(src,term))continue
  const expected=String(term.dst??'').trim()
  if(!expected||normalize(expected)===normalize(term.src))continue
  const parts=expected.split(/[·\s/（）()]+/).filter(p=>p.length>=2)
  if(!dst.includes(expected)&&!parts.some(p=>dst.includes(p))){
   hints.push({type:'glossary_mismatch',src:term.src,expectedDst:expected,info:term.info??''})
  }
 }
 if(classify==='body'&&/[\u4e00-\u9fff]/u.test(dst)){
  const stripped=dst.replace(/`[^`]*`/g,'').replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/\[\^[^\]]+\]/g,'').replace(/[（(][^）)\n]{1,60}[）)]/g,'')
  const words=stripped.match(/(?<![\p{L}\p{N}_])[a-z]{5,}(?![\p{L}\p{N}_])/gu)??[]
  const allowed=new Set(glossaryTerms.filter(t=>normalize(t.src)===normalize(t.dst)).flatMap(t=>normalize(t.src).split(/\s+/)))
  const residual=[...new Set(words.filter(w=>!allowed.has(w.toLowerCase())))]
  if(residual.length)hints.push({type:'untranslated_latin',words:residual.slice(0,5)})
 }
 for(const [label,pattern] of [
  ['adjacent_repeat',/(.{6,29})\1/u],
  ['annotation',/建议改为|无需修改|请补充|不构成不一致|（无）|[（(](?:原文(?:斜体|如此|分词|作|为|有误|未明)|译者?注[:：]|校注[:：])[^）)\n]*[）)]|```/u],
  ['seam',/。[,，；;]/u]
 ]){
  const m=pattern.exec(dst)
  if(m)hints.push({type:label,sample:m[0].slice(0,60)})
 }
 for(const [op,cl] of [['“','”'],['「','」']]){
  if((dst.split(op).length-1)!==(dst.split(cl).length-1))hints.push({type:'quote_balance',sample:op+cl})
 }
 return hints
}

export async function reviewAuditDirectory(manager,t,options={}){
 const base=options.auditDir?path.resolve(options.auditDir):path.join(manager.dir(t.id),'review/audit')
 if(options.auditDir&&await readJson(path.join(base,'snapshots.json'),null))return base
 const current=await readJson(path.join(base,'current.json'),null)
 if(current){if(!/^[a-f0-9-]{36}$/.test(current.runId))throw new Error('审校运行编号无效');return path.join(base,'runs',current.runId)}
 return base
}
async function reviewInputs(manager,t,revisions={}){
 return {source:hash(await fs.readFile(await manager.original(t))),translation:hash(await fs.readFile(t.translationPath??path.join(manager.dir(t.id),'translation/translated.md'))),glossary:hash(JSON.stringify(await readJson(path.join(manager.dir(t.id),'glossary.json'),[]))),issues:hash(JSON.stringify(await readJson(path.join(manager.dir(t.id),'glossary/review-issues.json'),[]))),revisions:hash(JSON.stringify(revisions))}
}
async function reviewResultDigest(auditDir){
 const files=(await fs.readdir(path.join(auditDir,'results')).catch(()=>[])).filter(f=>f.endsWith('.json')).sort()
 return hash(JSON.stringify(await Promise.all(files.map(async name=>[name,hash(await fs.readFile(path.join(auditDir,'results',name)))])))+'|'+hash(await fs.readFile(path.join(auditDir,'glossary-decisions.json')).catch(()=>'')))
}
export async function assertReviewInputs(manager,t,auditDir){
 const snap=await readJson(path.join(auditDir,'snapshots.json'),null)
 if(!snap?.inputs)return
 const current=await reviewInputs(manager,t,await readJson(path.join(auditDir,'old-revisions.json'),{}))
 const applied=await readJson(path.join(auditDir,'applied.json'),null)
 if(applied&&JSON.stringify(current)===JSON.stringify(applied.inputs)&&applied.resultDigest!==await reviewResultDigest(auditDir))throw new Error('已应用的审校结果发生变化，须重新建立审校运行')
 if(JSON.stringify(current)!==JSON.stringify(snap.inputs)&&JSON.stringify(current)!==JSON.stringify(applied?.inputs))throw new Error('审校期间原译文、术语或问题清单变化，旧结果不能用于当前版本')
}
export async function prepareReviewAudit(manager,t,options={}){
 const srcFile=await manager.original(t),dstFile=t.translationPath??path.join(manager.dir(t.id),'translation/translated.md')
 const sourceText=await fs.readFile(srcFile,'utf8'),translationText=await fs.readFile(dstFile,'utf8')
 const pair=checkMarkdownPair(sourceText,translationText)
 if(!pair.passed)throw new Error('审校输入结构不一致：'+pair.errors.join('；'))
 const glossary=await readJson(path.join(manager.dir(t.id),'glossary.json'),[])
 const reviewIssues=await readJson(path.join(manager.dir(t.id),'glossary/review-issues.json'),[])
 const revisions=options.revisions??{}
 const base=options.auditDir?path.resolve(options.auditDir):path.join(manager.dir(t.id),'review/audit')
 const previousDir=await reviewAuditDirectory(manager,t,options),existingSnap=await readJson(path.join(previousDir,'snapshots.json'),null)
 const inputs=await reviewInputs(manager,t,revisions)
 const applied=await readJson(path.join(previousDir,'applied.json'),null)
 const appliedMatches=applied&&JSON.stringify(applied.inputs)===JSON.stringify(inputs)&&applied.resultDigest===await reviewResultDigest(previousDir)
 const normalizedSource=sourceText,normalizedTranslation=translationText
 if(existingSnap?.schemaVersion===2&&(JSON.stringify(existingSnap.inputs)===JSON.stringify(inputs)||appliedMatches)&&!options.force){
  const manifest=await readJson(path.join(previousDir,'manifest.json'),[])
  const validation=await assembleReviewAudit(manager,t,{auditDir:previousDir})
  return {auditDir:previousDir,packets:manifest.length,totalPackets:manifest.length,reused:true,manifest,pendingPackets:pendingReviewPackets(manifest,validation)}
 }
 const runId=randomUUID(),auditDir=path.join(base,'runs',runId)
 await fs.mkdir(path.join(auditDir,'packets'),{recursive:true})
 await fs.mkdir(path.join(auditDir,'results'),{recursive:true})
 await atomic(path.join(auditDir,'source.md'),normalizedSource)
 await atomic(path.join(auditDir,'translation.md'),normalizedTranslation)
 await atomic(path.join(auditDir,'old-revisions.json'),revisions)
 await atomic(path.join(auditDir,'glossary-snapshot.json'),glossary)
 await atomic(path.join(auditDir,'review-issues-snapshot.json'),reviewIssues)

 const sourceMap=await loadSourceMap(manager,srcFile,normalizedSource).catch(()=>null)
 const pageIssuesByLogical=new Map()
 if(sourceMap?.blocks?.length){
  const taskDir=manager.dir(t.id),lps=new Set(sourceMap.blocks.flatMap(b=>b.logicalPages??[]))
  for(const lp of lps){
   const bodyPage=await readJson(path.join(taskDir,'document/ai_convert/edits/body',`page_${String(lp).padStart(3,'0')}.json`),null)
   const issues=(bodyPage?.metadata?.issues??[]).filter(x=>typeof x==='string'&&x.trim())
   if(issues.length)pageIssuesByLogical.set(lp,issues)
  }
 }
 const blocks=markdownBlocks(normalizedSource),targets=markdownBlocks(normalizedTranslation)
 const rows=blocks.map((block,i)=>{
  const n=block.line,s=block.text,z=targets[i].text,classify=classifyLine(s),hints=scanLineHints(s,z,glossary,reviewIssues,classify)
  const mapBlock=sourceMap?.blocks?.[i]
  const pageDefects=(mapBlock?.logicalPages??[]).flatMap(lp=>(pageIssuesByLogical.get(lp)??[]).map(issue=>`LPage ${lp}: ${issue}`))
  if(pageDefects.length)hints.push({type:'source_defect',logicalPages:mapBlock.logicalPages,pdfPages:mapBlock.pdfPages??[],issues:pageDefects})
  const matchedTerms=glossary.filter(term=>termMatchesSource(s,term)).map(term=>({src:term.src,dst:term.dst,info:term.info??''}))
  return {line:n,blockId:'B'+String(i+1).padStart(4,'0'),source:s,translation:z,classify,...(String(n) in revisions?{candidate:revisions[String(n)]}:{}),...(matchedTerms.length?{terms:matchedTerms}:{}),...(hints.length?{hints}:{})}
 })
 const covered=new Set(rows.map(r=>r.line))
 if(Object.keys(revisions).some(k=>!covered.has(Number(k))))throw new Error('旧修订指向空行，请先核查')

 const maxBody=Math.min(40,Math.max(15,Number(options.maxBody??24))),maxChars=Math.max(1000,Number(options.maxChars??48000))
 const packets=[];let current=[],size=0,body=0
 for(const row of rows){
  const length=(row.source?.length??0)+(row.translation?.length??0)+(row.candidate?.length??0)
  const boundary=row.classify==='heading'&&body>=15
  if(current.length&&(boundary||body>=maxBody||size+length>maxChars)){
   packets.push(current);current=[];size=0;body=0
  }
  current.push(row);size+=length;if(row.classify==='body')body++
 }
 if(current.length)packets.push(current)

 const manifest=[],packetHashes={}
 for(let i=0;i<packets.length;i++){
  const pid=String(i+1).padStart(3,'0'),packet=packets[i],file=path.join(auditDir,'packets',`${pid}.json`)
  await atomic(file,packet)
  packetHashes[pid]=hash(await fs.readFile(file))
  manifest.push({
   id:pid,
   start:packet[0].line,
   end:packet.at(-1).line,
   count:packet.length,
   body_count:packet.filter(r=>r.classify==='body').length,
   hint_count:packet.reduce((n,r)=>n+(r.hints?.length??0),0)
  })
 }
 await atomic(path.join(auditDir,'manifest.json'),manifest)
 const snapshots={
  schemaVersion:2,runId,inputs,
  taskId:t.id,
  created:new Date().toISOString(),
  source:srcFile,
  translation:dstFile,
  source_sha256:hash(await fs.readFile(path.join(auditDir,'source.md'))),
  translation_sha256:hash(await fs.readFile(path.join(auditDir,'translation.md'))),
  revisions_sha256:hash(await fs.readFile(path.join(auditDir,'old-revisions.json'))),
  glossary_sha256:hash(await fs.readFile(path.join(auditDir,'glossary-snapshot.json'))),
  issues_sha256:hash(await fs.readFile(path.join(auditDir,'review-issues-snapshot.json'))),
  manifest_sha256:hash(await fs.readFile(path.join(auditDir,'manifest.json'))),
  packet_sha256:packetHashes
 }
 await atomic(path.join(auditDir,'snapshots.json'),snapshots)
 // Only results validated against identical packet contents can survive a new run.
 if(existingSnap?.schemaVersion===2&&!options.force){
  const previous=await assembleReviewAudit(manager,t,{auditDir:previousDir}).catch(()=>null)
  const oldManifest=await readJson(path.join(previousDir,'manifest.json'),[])
  for(const info of manifest){
   const match=oldManifest.find(old=>existingSnap.packet_sha256?.[old.id]===packetHashes[info.id]&&previous?.validPackets?.includes(old.id))
   if(match){const result=await readJson(path.join(previousDir,'results',match.id+'.json'));await atomic(path.join(auditDir,'results',info.id+'.json'),{...result,packet:info.id})}
  }
 }
 await atomic(path.join(base,'current.json'),{runId})

 const validation=await assembleReviewAudit(manager,t,{auditDir})
 return {auditDir,pendingPackets:pendingReviewPackets(manifest,validation),packets:packets.length,totalPackets:packets.length,nonemptyLines:rows.length,totalLines:rows.length,bodyCount:rows.filter(r=>r.classify==='body').length,manifest}
}

export async function assembleReviewAudit(manager,t,options={}){
 const auditDir=await reviewAuditDirectory(manager,t,options)
 const snap=await readJson(path.join(auditDir,'snapshots.json'),null)
 if(!snap)throw new Error('尚未生成审校数据包，请先执行 prepareReviewAudit')
 for(const [filename,key] of [['source.md','source_sha256'],['translation.md','translation_sha256'],['old-revisions.json','revisions_sha256'],['manifest.json','manifest_sha256'],['glossary-snapshot.json','glossary_sha256'],['review-issues-snapshot.json','issues_sha256']]){
  if(hash(await fs.readFile(path.join(auditDir,filename)))!==snap[key])throw new Error('审校快照已被篡改：'+filename)
 }
 const sourceText=await fs.readFile(path.join(auditDir,'source.md'),'utf8'),targetText=await fs.readFile(path.join(auditDir,'translation.md'),'utf8')
 const sourceBlocks=markdownBlocks(sourceText),targetBlocks=markdownBlocks(targetText)
 const source=snap.schemaVersion===2?[]:splitLines(sourceText),original=snap.schemaVersion===2?[]:splitLines(targetText)
 if(snap.schemaVersion===2)for(let i=0;i<sourceBlocks.length;i++){source[sourceBlocks[i].line-1]=sourceBlocks[i].text;original[sourceBlocks[i].line-1]=targetBlocks[i]?.text??''}
 const result=[...original],errors=[],flags=[],changes=[],completed=[],validPackets=[],unresolved=[],glossaryDecisions=[],resultVersions={},sourceChanges=new Map()
 const manifest=await readJson(path.join(auditDir,'manifest.json'),[])
 if(!manifest.length)throw new Error('空的审校清单不能建立完成证明')
 const packed=[]
 for(const info of manifest){
  const pid=info.id,file=path.join(auditDir,'packets',`${pid}.json`)
  if(hash(await fs.readFile(file))!==snap.packet_sha256?.[pid])throw new Error('审校任务包已被修改：'+pid)
  const rows=await readJson(file,[])
  if(!rows.length||info.count!==rows.length||info.start!==rows[0].line||info.end!==rows.at(-1).line||info.body_count!==rows.filter(r=>r.classify==='body').length)throw new Error('审校清单与任务包元数据不符：'+pid)
  packed.push(...rows)
 }
 const expectedLines=snap.schemaVersion===2?sourceBlocks.map(b=>b.line):source.map((s,i)=>({line:i+1,s,z:original[i]})).filter(r=>r.s.trim()||r.z.trim()).map(r=>r.line)
 if(packed.some(r=>r.source!==source[r.line-1]||r.translation!==original[r.line-1]))throw new Error('审校任务包与原译文快照不一致')
 if(JSON.stringify(packed.map(r=>r.line))!==JSON.stringify(expectedLines))throw new Error('审校任务包未完整覆盖快照非空行')

 for(const info of manifest){
  const pid=info.id,resFile=path.join(auditDir,'results',`${pid}.json`)
  try{
   const version=await fs.stat(resFile).catch(()=>null)
   if(version)resultVersions[pid]={mtimeMs:version.mtimeMs,size:version.size}
   const raw=await readJson(resFile,null);if(!raw)continue
   completed.push(pid)
   const packet=await readJson(path.join(auditDir,'packets',`${pid}.json`),[])
   const normalized=normalizeReviewResult(raw,packet),review=normalized.value
   const corrections=[]
   for(const proof of review.evidenceReviews??[]){
    const receipt=await verifySourceEvidence(auditDir,proof,snap.source_sha256)
    validateEvidenceResolution({resolved_issues:proof.resolved,source_evidence_decisions:proof.decisions,source_notes:proof.sourceNotes,source_corrections:proof.sourceCorrections},receipt,receipt.issues)
    corrections.push(...(proof.sourceCorrections??[]))
   }
   await atomic(path.join(auditDir,'normalized-results',pid+'.json'),normalized)
   const packetErrors=[],check=fn=>{try{fn()}catch(e){packetErrors.push({packet:pid,error:e.message})}}
   const rawCorrections=[...(review.source_corrections??[]),...(review.sourceCorrections??[])].flatMap(c=>Array.isArray(c?.blockIds)?c.blockIds.map(blockId=>({...c,blockId})):[c])
   for(const c of rawCorrections)check(()=>{
    if(!c||typeof c!=='object'||!c.blockId)throw new Error('source_corrections 缺少 blockId')
    const pages=c.pages??c.evidencePages??c.page_numbers??[]
    if(!Array.isArray(pages)||!pages.length||pages.some(p=>!Number.isInteger(p)||p<1))throw new Error('source_corrections 必须附带已探测的原页页码 pages：'+c.blockId)
    const taskDir=manager.dir(t.id)
    for(const p of pages){
     const p4=path.join(taskDir,'probe-pages','page_'+String(p).padStart(4,'0')+'.png')
     const p3=path.join(taskDir,'document/ai_convert/page_images/page_'+String(p).padStart(3,'0')+'.png')
     const p3b=path.join(taskDir,'document/ai_convert/page_images/page_'+String(p).padStart(4,'0')+'.png')
     if(!statSync(p4,{throwIfNoEntry:false})&&!statSync(p3,{throwIfNoEntry:false})&&!statSync(p3b,{throwIfNoEntry:false}))throw new Error(`source_corrections 引用的原页尚未经 probe_page 渲染核实：第 ${p} 页 (${c.blockId})`)
    }
    corrections.push({...c,_direct:true})
   })
   const lut=new Map(packet.map(r=>[r.line,r]))
   check(()=>{
   if((review.packet??review.packet_id)!==pid)throw new Error('packet 编号不匹配')
   const lines=review.checked_lines
   if(snap.schemaVersion!==2||lines!==undefined){
    if(!Array.isArray(lines)||lines.length!==lut.size||new Set(lines).size!==lut.size||lines.some(l=>!lut.has(l)))throw new Error('checked_lines 未完整覆盖本包全部非空行')
    if(review.body_count!==undefined&&review.body_count!==info.body_count)throw new Error('body_count 与任务包正文段数不一致')
   }else if(!['pass','needs-work'].includes(review.status))throw new Error('缺少分包审校结论 status')
   })
   if(review.status==='needs-work'&&!review.unresolved.length)unresolved.push({packet:pid,issue:'该分包审校仍需修订'})
   for(const x of review.unresolved)unresolved.push({packet:pid,issue:x})
   for(const g of review.glossary_decisions)check(()=>{if(typeof g?.src!=='string'||!g.src.trim()||typeof g?.dst!=='string'||!g.dst.trim()||typeof g.reason!=='string'||!g.reason.trim())throw new Error('术语裁决缺少 src、dst 或理由');glossaryDecisions.push({...g,packet:pid})})
   const resolveLine=p=>p.blockId?packet.find(r=>r.blockId===p.blockId)?.line:p.line
   const decisions=(review.candidate_decisions??[]).map(d=>({...d,line:resolveLine(d)}))
   check(()=>{if(new Set(decisions.map(d=>d.line)).size!==decisions.length)throw new Error('candidate_decisions 存在重复行')})
   const candidateLines=packet.filter(r=>'candidate' in r).map(r=>r.line)
   check(()=>{if(decisions.length!==candidateLines.length||candidateLines.some(l=>!decisions.some(d=>d.line===l)))throw new Error('candidate_decisions 与实际旧候选行不一致（缺失或多余）')})
   const dlut=new Map(decisions.map(d=>[d.line,d]))
   for(const d of decisions)check(()=>{if(!['accept','reject','revise'].includes(d.decision)||!String(d.reason??'').trim())throw new Error('无效的旧候选裁定或缺少理由')})
   const patches=(review.patches??[]).map(p=>({...p,line:resolveLine(p)}))
   check(()=>{if(new Set(patches.map(p=>p.line)).size!==patches.length)throw new Error('patches 存在重复行')})
   const patched=new Map()
   for(const p of patches)check(()=>{
    const n=p.line,row=lut.get(n)
    const base=(!p.base||p.base==='translation'||p.base===row?.translation)?'translation':(p.base==='candidate'||p.base===row?.candidate)?'candidate':null
    if(!row||!base||!(base in row))throw new Error(`L${n}: 无效的补丁行或基准字段`)
    if(base==='candidate'&&dlut.get(n)?.decision==='reject')throw new Error(`L${n}: 补丁引用了已拒绝的候选`)
    if(!String(p.reason??'').trim())throw new Error(`L${n}: 补丁缺少修订理由`)
    let text=row[base]
    for(const edit of p.edits??[]){
     const old=edit?.old,next=edit?.new
     if(typeof old!=='string'||!old||typeof next!=='string')throw new Error(`L${n}: 补丁片段必须为非空字符串`)
     const occurrences=text.split(old).length-1
     if(occurrences!==1)throw new Error(`L${n}: 补丁片段在当前行中不是唯一命中（命中 ${occurrences} 次）`)
     text=text.replace(old,next)
    }
    if(snap.schemaVersion!==2&&(text.includes('\n')||text.includes('\r')))throw new Error(`L${n}: 补丁包含非法换行符`)
    let scForLine=corrections.find(c=>c.blockId===row.blockId&&!c.delete&&typeof c.source==='string')
    if(!scForLine&&typeof p.source==='string'&&p.source.trim()){
     scForLine={blockId:row.blockId,source:p.source.trim(),translation:text,reason:p.reason,_structuralSync:true}
     corrections.push(scForLine)
    }
    if(footnoteMultiset(scForLine?scForLine.source:source[n-1])!==footnoteMultiset(text))throw new Error(`L${n}: 脚注标记多重集与原文不一致`)
    if(snap.schemaVersion===2){
     const effSource=scForLine?scForLine.source:source[n-1]
     const srcParsed=markdownBlocks(effSource),dstParsed=markdownBlocks(text)
     if(srcParsed.length!==1||dstParsed.length!==1)throw new Error(`L${n}: 补丁改变了段落块数量（原文 ${srcParsed.length} 块，译文 ${dstParsed.length} 块）`)
     const assetRefs=s=>imageReferences(s).map(m=>m.reference).sort().join('|')
     if(assetRefs(effSource)!==assetRefs(text))throw new Error(`L${n}: 附件路径与原文不一致`)
     if(srcParsed[0].type!==dstParsed[0].type||srcParsed[0].level!==dstParsed[0].level){
      if(srcParsed[0].type==='heading'&&!scForLine&&(dstParsed[0].type==='paragraph'||dstParsed[0].type==='heading')){
       const body=source[n-1].replace(/^#{1,6}\s+/,'').trim(),trimmed=text.trim()
       let syncedSource=dstParsed[0].type==='heading'?'#'.repeat(dstParsed[0].level)+' '+body:body
       if(dstParsed[0].type==='paragraph'){
        if(/^<!--[\s\S]*-->$/.test(trimmed)&&!footnoteMultiset(body)&&!assetRefs(body))syncedSource=`<!-- ${body.replace(/-->/g,'').trim()} -->`
        else if(/^\*\*[^*\n]+\*\*$/.test(trimmed)&&!/^\*\*[\s\S]*\*\*$/.test(body))syncedSource=`**${body.replace(/^\*+|\*+$/g,'').trim()}**`
        else if(/^\*[^*\n]+\*$/.test(trimmed)&&!/^\*[\s\S]*\*$/.test(body))syncedSource=`*${body}*`
        const checkSynced=markdownBlocks(syncedSource)
        if(checkSynced.length!==1||checkSynced[0].type!=='paragraph')syncedSource=`*${body.replace(/^\*+|\*+$/g,'').trim()}*`
       }
       corrections.push({blockId:row.blockId,source:syncedSource,translation:text,reason:p.reason,_structuralSync:true})
      }else if((srcParsed[0].type==='paragraph'||srcParsed[0].type==='rule')&&!scForLine&&dstParsed[0].type==='heading'){
       const body=source[n-1].replace(/^\*+|\*+$/g,'').trim()
       const syncedSource='#'.repeat(dstParsed[0].level)+' '+(body&&body!=='---'?body:text.replace(/^#{1,6}\s+/,'').trim())
       corrections.push({blockId:row.blockId,source:syncedSource,translation:text,reason:p.reason,_structuralSync:true})
      }else{
       throw new Error(`L${n}: 补丁改变了段落结构（${srcParsed[0].type}${srcParsed[0].level??''} -> ${dstParsed[0].type}${dstParsed[0].level??''}）`)
      }
     }
    }
    patched.set(n,text)
   })
   for(const [n,d] of dlut.entries())check(()=>{
    const final=patched.get(n)??original[n-1]
    if(d.decision==='accept'&&final!==lut.get(n).candidate)throw new Error(`L${n}: accept 候选缺少显式匹配的补丁`)
    if(d.decision==='revise'&&!patched.has(n))throw new Error(`L${n}: revise 候选缺少修订补丁`)
   })
   const proposed=new Map()
   for(const c of corrections)check(()=>{
    const row=packet.find(r=>r.blockId===c.blockId)
    if(!row)throw new Error('原文修订后的译文与模型复审不一致：'+c.blockId)
    if(c.delete===true){
     if(!String(c.reason??'').trim())throw new Error('删除伪正文块缺少理由：'+c.blockId)
     proposed.set(c.blockId,{...c,delete:true})
     return
    }
    if(typeof c.source!=='string'||!c.source.trim())throw new Error('原文修订缺少新原文：'+c.blockId)
    if(c._direct&&c.translation&&!patched.has(row.line)){
     if(footnoteMultiset(c.source)!==footnoteMultiset(c.translation))throw new Error(`L${row.line}: 脚注标记多重集与原文不一致`)
     patched.set(row.line,c.translation)
     patches.push({line:row.line,blockId:c.blockId,reason:c.reason??'原页核证同步修订译文'})
    }
    const finalTrans=patched.get(row.line)??row.translation
    if(c.translation!==undefined&&c.translation!==finalTrans)throw new Error('原文修订后的译文与模型复审不一致：'+c.blockId)
    if(footnoteMultiset(c.source)!==footnoteMultiset(finalTrans))throw new Error(`L${row.line}: 脚注标记多重集与新原文不一致`)
    if(snap.schemaVersion===2){
     const scParsed=markdownBlocks(c.source),ftParsed=markdownBlocks(finalTrans)
     if(scParsed.length!==1||ftParsed.length!==1||scParsed[0].type!==ftParsed[0].type||scParsed[0].level!==ftParsed[0].level)throw new Error(`L${row.line}: 原文修订后的段落结构与译文不一致（${c.blockId}）`)
    }
    if(proposed.has(c.blockId)&&proposed.get(c.blockId).source!==c.source)throw new Error('同段原文修订冲突：'+c.blockId)
    proposed.set(c.blockId,{...c,translation:finalTrans})
   })
   if(packetErrors.length){errors.push(...packetErrors);continue}
   for(const [id,c] of proposed)sourceChanges.set(id,c)
   for(const p of patches){
    const n=p.line,text=patched.get(n)
    result[n-1]=text
    if(text!==original[n-1]){
     changes.push({line:n,blockId:lut.get(n).blockId??null,source:source[n-1],original:original[n-1],revised:text,reason:p.reason})
     flags.push(...structuralFlags(n,original[n-1],text))
    }
   }
   validPackets.push(pid)

  }catch(e){errors.push({packet:pid,error:e.message})}
 }
 const expectedIds=new Set(manifest.map(x=>x.id))
 const resFiles=(await fs.readdir(path.join(auditDir,'results')).catch(()=>[])).filter(f=>f.endsWith('.json')).map(f=>path.basename(f,'.json'))
 const unknown=resFiles.filter(id=>!expectedIds.has(id))
 if(unknown.length)errors.push({error:'unknown result files',files:unknown})
 for(let bi=0;bi<sourceBlocks.length;bi++){
  const n=sourceBlocks[bi].line,i=n-1,bId='B'+String(bi+1).padStart(4,'0'),sc=sourceChanges.get(bId)
  if(sc?.delete===true)continue
  const effSource=sc?.source??source[i]
  if(footnoteMultiset(effSource)!==footnoteMultiset(result[i]))errors.push({line:i+1,error:'final full-text footnote multiset mismatch'})
 }
 if(snap.schemaVersion!==2){
  for(const n of expectedLines){const i=n-1
   if(footnoteMultiset(source[i])!==footnoteMultiset(result[i]))errors.push({line:i+1,error:'final full-text footnote multiset mismatch'})
  }
 }
 const extraDecisions=await readJson(path.join(auditDir,'glossary-decisions.json'),[])
 if(Array.isArray(extraDecisions)){
  for(const g of extraDecisions){
   if(!g?.src)continue
   const k=normalize(g.src)
   if(g.polysemous===true||g.contextDependent===true){
    for(let i=glossaryDecisions.length-1;i>=0;i--)if(normalize(glossaryDecisions[i].src)===k)glossaryDecisions.splice(i,1)
   }else if(g.override===true&&g.dst){
    for(let i=glossaryDecisions.length-1;i>=0;i--)if(normalize(glossaryDecisions[i].src)===k)glossaryDecisions.splice(i,1)
    glossaryDecisions.push({src:g.src,dst:g.dst,reason:g.reason??'编排者跨包统一裁决',category:g.category??'concept',publicEligible:Boolean(g.publicEligible)})
   }else if(g.dst){
    glossaryDecisions.push(g)
   }
  }
 }

 const {merged,conflicts:glossaryConflicts}=reconcileGlossary(glossaryDecisions)
 for(const c of glossaryConflicts)for(const pid of new Set(c.decisions.map(d=>d.packet).filter(Boolean)))unresolved.push({packet:pid,kind:'glossary-conflict',issue:'跨包术语裁决冲突：'+c.src})
 if(glossaryConflicts.some(c=>c.decisions.every(d=>!d.packet)))errors.push({error:'附加术语裁决存在冲突'})
 for(const f of flags.filter(f=>f.type==='annotation'))errors.push({line:f.line,error:'译文含内嵌按语，请移入 observations',sample:f.sample})
 const missing=manifest.map(x=>x.id).filter(id=>!completed.includes(id))
 const validation={
  complete:validPackets.length===manifest.length&&errors.length===0,
  validPackets,
  resultVersions,
  completed:completed.length,
  total:manifest.length,
  changed_lines:changes.length,
  patchCount:changes.length,
  sourcePatchCount:sourceChanges.size,
  glossaryDecisionCount:glossaryDecisions.length,
  errors,
  flags,
  unresolved,
  missing,
  glossaryConflicts,
  glossary_decisions:merged
 }
 await atomic(path.join(auditDir,'validation.json'),validation)
 await atomic(path.join(auditDir,'changes.json'),changes)
 let preview=result.join('\n')+'\n'
 if(snap.schemaVersion===2){
  const lines=targetText.replace(/\r\n/g,'\n').split('\n')
  for(let i=targetBlocks.length-1;i>=0;i--){
   const b=targetBlocks[i],c=sourceChanges.get('B'+String(i+1).padStart(4,'0'))
   if(c?.delete===true){
    let removeCount=b.text.split('\n').length
    if(b.line-1+removeCount<lines.length&&!lines[b.line-1+removeCount].trim())removeCount++
    lines.splice(b.line-1,removeCount)
   }else{
    const nextB=targetBlocks[i+1],revText=result[sourceBlocks[i].line-1]
    const needBlank=(revText!==b.text||Boolean(c))&&nextB&&!sourceChanges.get('B'+String(i+2).padStart(4,'0'))?.delete&&b.line+b.text.split('\n').length===nextB.line
    const rep=revText.split('\n')
    if(needBlank)rep.push('')
    lines.splice(b.line-1,b.text.split('\n').length,...rep)
   }
  }
  preview=lines.join('\n')
 }
 const rawPreview=preview;preview=normalizeTranslationQuotes(preview)
 validation.typography=quoteNormalizationRecord(rawPreview,preview)
 const sourceLines=sourceText.replace(/\r\n/g,'\n').split('\n')
 for(let i=sourceBlocks.length-1;i>=0;i--){
  const c=sourceChanges.get('B'+String(i+1).padStart(4,'0')),b=sourceBlocks[i]
  if(c?.delete===true){
   let removeCount=b.text.split('\n').length
   if(b.line-1+removeCount<sourceLines.length&&!sourceLines[b.line-1+removeCount].trim())removeCount++
   sourceLines.splice(b.line-1,removeCount)
  }else if(c){
   const nextB=sourceBlocks[i+1]
   const needBlank=nextB&&!sourceChanges.get('B'+String(i+2).padStart(4,'0'))?.delete&&b.line+b.text.split('\n').length===nextB.line
   const rep=c.source.split('\n')
   if(needBlank)rep.push('')
   sourceLines.splice(b.line-1,b.text.split('\n').length,...rep)
  }
 }
 const revisedSource=sourceLines.join('\n')
 const sourceCheck=checkMarkdownPair(revisedSource,preview)
 if(!sourceCheck.passed){validation.errors.push({error:'审校合成稿未通过段落与标记配对检查：'+sourceCheck.errors.join('；')});validation.complete=false}
 await atomic(path.join(auditDir,'validation.json'),validation)
 await atomic(path.join(auditDir,'source-changes.json'),[...sourceChanges.values()])
 await atomic(path.join(auditDir,'reviewed-source.md'),revisedSource)
 await atomic(path.join(auditDir,'reviewed-preview.md'),preview)
 return validation
}

export async function applyReviewAudit(manager,t,options={}){
 const auditDir=await reviewAuditDirectory(manager,t,options)
 await assertReviewInputs(manager,t,auditDir)
 const validation=await assembleReviewAudit(manager,t,{auditDir})
 if(!validation.complete||validation.errors.length||validation.unresolved.length){
  const details=[...validation.errors.map(e=>`包 ${e.packet??'全局'}：${e.error}`),...validation.unresolved.map(e=>`包 ${e.packet??'全局'}：${typeof e.issue==='object'?JSON.stringify(e.issue):e.issue??e.kind??'未决问题'}`)]
  throw new Error(`审校数据包尚未全部完成或仍存在门禁错误，不能合并入正式译文；缺失 ${validation.missing.length} 包${validation.missing.length?'（'+validation.missing.slice(0,6).join(',')+'）':''}，错误 ${validation.errors.length} 项，未决 ${validation.unresolved.length} 项。${details.slice(0,3).map(s=>s.slice(0,180)).join('；')}。完整报告：${path.join(auditDir,'validation.json')}。先修正对应 results/编号.json，再执行 review_assemble；输入未变时重复 apply 不会解决问题。`)
 }
 let preview=await fs.readFile(path.join(auditDir,'reviewed-preview.md'),'utf8')
 let srcFile=await manager.original(t),source=await fs.readFile(srcFile,'utf8')
 let dstFile=t.translationPath??path.join(manager.dir(t.id),'translation/translated.md')
 const revisedSource=await fs.readFile(path.join(auditDir,'reviewed-source.md'),'utf8')
 const sourceH2=markdownBlocks(revisedSource).filter(b=>b.type==='heading'&&b.level===2)
 const targetBlocks=markdownBlocks(preview),targetH2=targetBlocks.filter(b=>b.type==='heading'&&b.level===2)
 const oldBlocks=markdownBlocks(await fs.readFile(path.join(auditDir,'translation.md'),'utf8')),oldH2=oldBlocks.filter(b=>b.type==='heading'&&b.level===2)
 const toc=targetH2.find(b=>b.text.trim()==='## 目录'),anchors=new Map()
 if(toc&&sourceH2.length===targetH2.length){
  sourceH2.forEach((b,i)=>{const label=b.text.replace(/^##\s*/,'');if(!anchors.has(label))anchors.set(label,targetH2[i].text.replace(/^##\s*/,''))})
  if(oldH2.length===targetH2.length)oldH2.forEach((b,i)=>{const label=b.text.replace(/^##\s*/,'');if(!anchors.has(label))anchors.set(label,targetH2[i].text.replace(/^##\s*/,''))})
  else if(oldBlocks.length===targetBlocks.length)oldBlocks.forEach((b,i)=>{if(b.type==='heading'&&b.level===2&&targetBlocks[i]?.type==='heading'&&targetBlocks[i]?.level===2){const label=b.text.replace(/^##\s*/,'');if(!anchors.has(label))anchors.set(label,targetBlocks[i].text.replace(/^##\s*/,''))}})
  const end=targetH2.find(b=>b.line>toc.line)?.line??Infinity,lines=preview.split('\n')
  for(const b of targetBlocks.filter(b=>b.type==='list'&&b.line>toc.line&&b.line<end)){
   for(let i=b.line-1;i<b.line-1+b.text.split('\n').length;i++)lines[i]=lines[i].replace(/\[\[#([^\]|]+)(\|[^\]]*)?\]\]/g,(m,label,alias)=>anchors.has(label)?`[[#${anchors.get(label)}${alias??''}]]`:m)
  }
  preview=lines.join('\n')
 }
 const check=checkMarkdownPair(revisedSource,preview)
 if(!check.passed)throw new Error('审校合成稿未通过段落与标记配对检查：'+check.errors.join('；'))

 const sourceChanged=hash(source)!==hash(revisedSource)
 if(sourceChanged){
  const baseSource=srcFile,baseHash=hash(source),baseTarget=dstFile,map=await loadSourceMap(manager,srcFile,source)
  if(!map&&t.input?.type==='pdf')throw new Error('原文修订缺少有效来源映射')
  const allSourceChanges=await readJson(path.join(auditDir,'source-changes.json'),[])
  const deletedIndices=new Set()
  for(const c of allSourceChanges)if(c?.delete===true&&/^B\d+$/.test(c.blockId))deletedIndices.add(Number(c.blockId.slice(1))-1)
  const blocks=markdownBlocks(revisedSource),revisionId=hash(revisedSource+'|'+preview)
  const taskDir=manager.dir(t.id),baseSourceDir=path.dirname(baseSource)
  const srcDir=baseSourceDir===taskDir||baseSourceDir.startsWith(taskDir+path.sep)?baseSourceDir:path.join(taskDir,'source')
  srcFile=path.join(srcDir,'source.review-'+revisionId+'.md')
  dstFile=path.join(path.dirname(baseTarget),'translated.review-'+revisionId+'.md')
  await atomic(srcFile,revisedSource)
  if(map){
   const keptMapBlocks=map.blocks.filter((_,i)=>!deletedIndices.has(i)),{pdfPath,...mapRest}=map
   await writeSourceMap(srcFile,{...mapRest,pdf:{...map.pdf,file:path.relative(path.dirname(srcFile),pdfPath)},markdownSha256:hash(revisedSource),blocks:keptMapBlocks.map((b,i)=>({...b,markdownBlockId:blocks[i].id,type:blocks[i].type})),revisionOf:baseHash})
  }
  await atomic(dstFile,preview)
  const revisedMap=map?await loadSourceMap(manager,srcFile,revisedSource):null
  if(revisedMap)await saveTranslationMap(manager,t,srcFile,dstFile,revisedSource,preview,markdownBlocks(preview).map((b,i)=>({...revisedMap.blocks[i],markdownBlockId:b.id,type:b.type})))
  const revision={path:srcFile,sourceFingerprint:hash(revisedSource),baseSource,baseFingerprint:baseHash,originalFingerprint:t.sourceRevision?.originalFingerprint??baseHash,targetPath:dstFile,targetFingerprint:hash(preview),auditDir,changes:await readJson(path.join(auditDir,'source-changes.json')),previous:t.sourceRevision?{record:t.sourceRevision.record,recordFingerprint:t.sourceRevision.recordFingerprint}:null}
  const record=path.join(auditDir,'source-revision.json');await atomic(record,revision)
  t.sourceRevision={...revision,record,recordFingerprint:hash(await fs.readFile(record))}
  t.translationPath=dstFile;source=revisedSource
 }
 if(sourceChanged||hash(preview)!==hash(await fs.readFile(dstFile,'utf8'))||t.translationReport?.targetFingerprint!==hash(preview)){
  await fs.copyFile(dstFile,`${dstFile}.pre-review-${Date.now()}.bak`)
  await atomic(dstFile,preview)
  const sourceMap=await loadSourceMap(manager,srcFile,source),targetBlocks=markdownBlocks(preview)
  if(sourceMap)await saveTranslationMap(manager,t,srcFile,dstFile,source,preview,targetBlocks.map((b,i)=>({...sourceMap.blocks[i],markdownBlockId:b.id,type:b.type})))
  const alignFile=path.join(manager.dir(t.id),'translation/alignment.json'),oldAlign=await readJson(alignFile,null)
  if(oldAlign)await atomic(alignFile,{...oldAlign,sourceFingerprint:hash(source),targetFingerprint:hash(preview)})
  t.translationReport={...check,sourceFingerprint:hash(source),targetFingerprint:hash(preview),explicitBlockIds:Boolean(t.translationReport?.explicitBlockIds),sourceMapAvailable:Boolean(sourceMap)}
  await atomic(path.join(manager.dir(t.id),'translation-report.json'),t.translationReport)
  t.translationPath=dstFile
 }

 if((sourceChanged||validation.glossary_decisions?.length)&&t.glossaryReport?.schemaVersion===4){
  const gDir=path.join(manager.dir(t.id),'glossary')
  const overrides=await readJson(path.join(gDir,'book-overrides.json'),[])
  const shared=await readJson(path.join(gDir,'common-snapshot.json'),[])
  const additions=await readJson(path.join(gDir,'public-candidates.json'),[])
  const issues=await readJson(path.join(gDir,'review-issues.json'),[])
  for(const d of validation.glossary_decisions??[]){
   const k=normalize(d.src)
   const idx=overrides.findIndex(e=>normalize(e.src)===k)
   const nonUniversal=isNonUniversalPublicTerm(d.src,d.dst)
   const domainSlug=d.tier==='domain'?normalizeGlossaryDomains([d.domain])[0]??'':''
   const allowPublic=d.tier==='local'?false:(d.publicEligible===true&&!nonUniversal)
   const tier=allowPublic&&domainSlug?'domain':(allowPublic?'common':'local')
   const category=normalizeGlossaryCategory(d.category,'concept')
   const entry={src:d.src,dst:d.dst,info:d.reason??'联合审校确认译名',language:t.profile?.language??'en',category,semanticApproval:{publicEligible:allowPublic,tier,...(domainSlug&&allowPublic?{domain:domainSlug}:{}),reason:allowPublic?(d.reason??'联合审校确认'):(nonUniversal?'非普适性公共术语候选，仅保留在本书':(d.reason??'联合审校确认'))}}
   if(idx>=0)overrides[idx]={...overrides[idx],dst:d.dst,category,info:d.reason??overrides[idx].info,semanticApproval:entry.semanticApproval}
   else overrides.push(entry)
   for(let i=issues.length-1;i>=0;i--)if((issues[i].members??[]).some(m=>normalize(m.src)===k)||normalize(issues[i].src)===k)issues.splice(i,1)
   if(allowPublic&&!additions.some(a=>normalize(a.src)===k))additions.push(entry)
  }
  const byKey=new Map()
  for(const e of [...shared,...overrides])byKey.set(normalize(e.src),{src:e.src,dst:e.dst,info:e.info??'',regex:false,case_sensitive:false})
  const effective=[...byKey.values()]
  await atomic(path.join(gDir,'book-overrides.json'),overrides)
  await atomic(path.join(gDir,'public-candidates.json'),additions)
  await atomic(path.join(gDir,'review-issues.json'),issues)
  await atomic(path.join(gDir,'effective.json'),effective)
  await atomic(path.join(manager.dir(t.id),'glossary.json'),effective)
  const receiptFile=path.join(gDir,'pipeline-receipt.json'),receipt=await readJson(receiptFile,null)
  if(receipt){
   if(sourceChanged)receipt.reviewedSource={sourceFingerprint:hash(source),originalFingerprint:t.sourceRevision.originalFingerprint,record:t.sourceRevision.record,recordFingerprint:t.sourceRevision.recordFingerprint}
   for(const name of ['book-overrides.json','public-candidates.json','review-issues.json','effective.json'])receipt.artifacts[name]=hash(await fs.readFile(path.join(gDir,name)))
   receipt.issuesFingerprint=receipt.artifacts['review-issues.json']
   receipt.effectiveFingerprint=hash(await fs.readFile(path.join(manager.dir(t.id),'glossary.json')))
   receipt.effectiveTerms=effective.length
   receipt.reviewIssues=issues.length
   await atomic(receiptFile,receipt)
   t.glossaryReport=receipt
  }
 }
 await atomic(path.join(auditDir,'applied.json'),{inputs:await reviewInputs(manager,t,await readJson(path.join(auditDir,'old-revisions.json'),{})),resultDigest:await reviewResultDigest(auditDir)})
 return validation
}

const DEFAULT_AGY_FALLBACK='/Users/hao/.local/bin/agy'

export function resolveAgyCommand(customPath){
 if(typeof customPath==='string'&&customPath.trim())return customPath.trim()
 if(process.env.AGY_PATH?.trim())return process.env.AGY_PATH.trim()
 const home=process.env.HOME||''
 for(const candidate of [DEFAULT_AGY_FALLBACK,home?`${home}/.local/bin/agy`:null,'/usr/local/bin/agy','/opt/homebrew/bin/agy'].filter(Boolean)){
  try{if(statSync(candidate).isFile())return candidate}catch{}
 }
 return DEFAULT_AGY_FALLBACK
}

export function safeAgyEnv(){
 const env={}
 for(const key of ['HOME','PATH','TMPDIR','LANG','LC_ALL','USER','LOGNAME']){
  if(process.env[key])env[key]=process.env[key]
 }
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']){
  try{
   const value=process.env[key]
   if(!value)continue
   const url=new URL(value)
   if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password)env[key]=value
  }catch{}
 }
 if(process.env.NO_PROXY)env.NO_PROXY=process.env.NO_PROXY
 return env
}

export function extractAgyJson(stdout){
 if(typeof stdout!=='string')throw new Error('Empty agy stdout')
 const trimmed=stdout.trim()
 try{return JSON.parse(trimmed)}catch{
  const first=trimmed.indexOf('{'),last=trimmed.lastIndexOf('}')
  if(first!==-1&&last>first)return JSON.parse(trimmed.slice(first,last+1))
  throw new Error('No valid JSON found in agy CLI output')
 }
}

// Model identifiers are validated against the live Harness catalog or local Antigravity CLI catalog by TaskManager.
export const REVIEW_ORCHESTRATOR_MODELS = [
  'gemini-4-hydrogen-xhigh',
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-low',
  'gemini-4-argon-high',
  'gemini-4-argon-medium',
  'gemini-4-argon-low',
  'gemini-pro-orchestrator-g1-pro',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-opus-5-5-high',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-low',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-low',
  'gpt-oss-120b-medium'
]
export const REVIEW_WORKER_MODELS = [
  { id: 'inherit', name: '继承编排者模型（同款高阶智商，推荐）' },
  { id: 'pro', name: 'Pro 级推理模型（高阶独立审校）' },
  { id: 'flash', name: 'Flash 级高速模型（高效分包扫描）' },
  { id: 'flash_lite', name: 'Flash-Lite 极轻模型（轻量初筛）' }
]
export const REVIEW_EFFORTS = ['high', 'xhigh', 'medium', 'low', 'max']
const AGY_REASONING = {
  supported: true,
  defaultEffort: 'high',
  efforts: [
    { id: 'high', name: 'High（推荐）' },
    { id: 'xhigh', name: 'XHigh' },
    { id: 'medium', name: 'Medium' },
    { id: 'low', name: 'Low' },
    { id: 'max', name: 'Max' }
  ]
}
export const AGY_CLI_GROUP = {
  id: 'agy',
  name: 'agy',
  models: [
    { id: 'gemini-4-hydrogen-xhigh', name: 'gemini-4-hydrogen-xhigh · Gemini 4 Hydrogen (XHigh)', reasoning: AGY_REASONING },
    { id: 'gemini-4-hydrogen-high', name: 'gemini-4-hydrogen-high · Gemini 4 Hydrogen (High)', reasoning: AGY_REASONING },
    { id: 'gemini-4-hydrogen-medium', name: 'gemini-4-hydrogen-medium · Gemini 4 Hydrogen (Medium)', reasoning: AGY_REASONING },
    { id: 'gemini-4-hydrogen-low', name: 'gemini-4-hydrogen-low · Gemini 4 Hydrogen (Low)', reasoning: AGY_REASONING },
    { id: 'gemini-4-argon-high', name: 'gemini-4-argon-high · Gemini 4 Argon (High)', reasoning: AGY_REASONING },
    { id: 'gemini-4-argon-medium', name: 'gemini-4-argon-medium · Gemini 4 Argon (Medium)', reasoning: AGY_REASONING },
    { id: 'gemini-4-argon-low', name: 'gemini-4-argon-low · Gemini 4 Argon (Low)', reasoning: AGY_REASONING },
    { id: 'gemini-pro-orchestrator-g1-pro', name: 'gemini-pro-orchestrator-g1-pro · Orchestrator (Argon)', reasoning: AGY_REASONING },
    { id: 'gemini-3.8-flash-high', name: 'gemini-3.8-flash-high · Gemini 3.8 Flash (High)', reasoning: AGY_REASONING },
    { id: 'gemini-3.8-flash-medium', name: 'gemini-3.8-flash-medium · Gemini 3.8 Flash (Medium)', reasoning: AGY_REASONING },
    { id: 'gemini-3.8-flash-low', name: 'gemini-3.8-flash-low · Gemini 3.8 Flash (Low)', reasoning: AGY_REASONING },
    { id: 'claude-opus-5-5-high', name: 'claude-opus-5-5-high · Claude Opus 5.5 (High)', reasoning: AGY_REASONING },
    { id: 'claude-opus-5-5-medium', name: 'claude-opus-5-5-medium · Claude Opus 5.5 (Medium)', reasoning: AGY_REASONING },
    { id: 'claude-opus-5-5-low', name: 'claude-opus-5-5-low · Claude Opus 5.5 (Low)', reasoning: AGY_REASONING },
    { id: 'claude-sonnet-5-5-high', name: 'claude-sonnet-5-5-high · Claude Sonnet 5.5 (High)', reasoning: AGY_REASONING },
    { id: 'claude-sonnet-5-5-medium', name: 'claude-sonnet-5-5-medium · Claude Sonnet 5.5 (Medium)', reasoning: AGY_REASONING },
    { id: 'claude-sonnet-5-5-low', name: 'claude-sonnet-5-5-low · Claude Sonnet 5.5 (Low)', reasoning: AGY_REASONING },
    { id: 'gpt-oss-120b-medium', name: 'gpt-oss-120b-medium · GPT-OSS 120B (Medium)', reasoning: AGY_REASONING },
    { id: 'pro', name: 'pro · Worker Pro 级推理模型', reasoning: AGY_REASONING },
    { id: 'flash', name: 'flash · Worker Flash 级高速模型', reasoning: AGY_REASONING },
    { id: 'flash_lite', name: 'flash_lite · Worker Flash-Lite 极轻模型', reasoning: AGY_REASONING }
  ]
}
export function isAgyCliModel(model) {
  if (typeof model !== 'string' || !model.trim()) return false
  return model.startsWith('agy/') || REVIEW_ORCHESTRATOR_MODELS.includes(model)
}
export function resolveAgyCliModelFlag(model, effort) {
  const raw = String(model ?? '').replace(/^agy\//, '').trim()
  if (!raw) return ''
  const tier = ['low', 'medium', 'high'].includes(effort) ? effort : 'high'
  if (raw === 'pro') return `gemini-4-argon-${tier}`
  if (raw === 'flash' || raw === 'flash_lite') return `gemini-3.8-flash-${tier}`
  if (raw === 'gemini-4-hydrogen') {
    const hydrogenTier = ['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'high'
    return `gemini-4-hydrogen-${hydrogenTier}`
  }
  if (['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5'].includes(raw)) return `${raw}-${tier}`
  return raw
}
export function resolveAgyWorkerTier(workerModel) {
  if (!workerModel || workerModel === 'inherit') return 'inherit'
  const raw = String(workerModel).replace(/^agy\//, '').trim().toLowerCase()
  if (['inherit', 'pro', 'flash', 'flash_lite'].includes(raw)) return raw
  if (raw.includes('lite')) return 'flash_lite'
  if (raw.includes('flash')) return 'flash'
  if (raw.includes('hydrogen') || raw.includes('argon') || raw.includes('pro') || raw.includes('opus') || raw.includes('sonnet')) return 'pro'
  return 'inherit'
}
export function normalizeReviewConfig(value) {
  const v = (value && typeof value === 'object') ? value : {}
  const route = x => {
    if (typeof x !== 'string') return ''
    if (REVIEW_ORCHESTRATOR_MODELS.includes(x) || ['pro', 'flash', 'flash_lite'].includes(x)) return `agy/${x}`
    return /^[^/\s]+\/.+$/.test(x) ? x : ''
  }
  return {orchestratorModel:route(v.orchestratorModel),orchestratorEffort:typeof v.orchestratorEffort==='string'?v.orchestratorEffort:'',workerModel:v.workerModel==='inherit'||!v.workerModel?'inherit':route(v.workerModel)}
}

export function buildAgyReviewPrompt(manager,t,prepared,options={}){
 const auditDir=prepared.auditDir,cfg=normalizeReviewConfig(t?.reviewConfig),workerModel=cfg.workerModel
 const useAgyCli=isAgyCliModel(cfg.orchestratorModel),workerTier=resolveAgyWorkerTier(workerModel)
 const pending=prepared.pendingPackets??prepared.manifest?.map(p=>p.id)??Array.from({length:prepared.totalPackets??1},(_,i)=>String(i+1).padStart(3,'0'))
 const focusNote=typeof options.note==='string'&&options.note.trim()?options.note.trim():''
 return [
  `执行《${t.name}》正文与术语联合审校${options.force?'（补充重审）':''}。阅读 ${path.join(manager.root,'book-translation-review/SKILL.md')}。本次使用块级差量协议；无需填写哈希、checked_lines 或 body_count。`,
  ...(focusNote?[`【本轮补充重审重点指令】${focusNote}`]:[]),
  `审校目录：${auditDir}。仅处理待审包：${pending.join('、')}，其他包已通过程序验证，不得重新派发。每包位于 packets/编号.json，对应结果写入 results/编号.json。`,
  `包内每项含 blockId、source、translation、classify、terms、hints。只依据分包内给出的内容及其相邻上下文判断，不必反复读取全文或完整术语表。`,
  useAgyCli
   ?(pending.length<=2&&workerTier==='inherit'?'当前待审包不超过两个，可直接审校，无需额外派发子代理。':`使用 invoke_subagent（TypeName: self，Model: ${workerTier}）派发待审包，每包只派发一次；派发给子代理的 Prompt 必须原样附带下方返回 JSON 结构示例与字段铁律，严禁省略 schema 只传字段名。`)
   :`每包由 DSH 模型服务执行一次；Worker 为 ${workerModel==='inherit'?'所选审校模型':workerModel}。`,
  '返回结构：{packet: 包编号, status: pass或needs-work, patches: [{blockId: 块编号, edits: [{old: 原译文中唯一命中的片段, new: 修订片段}], reason: 修订依据}], candidate_decisions: [], glossary_decisions: [{src: 原词, dst: 译名, category: 类别, publicEligible: 布尔值, reason: 依据}], source_corrections: [{blockId: 块编号, pages: [页码], source: 完整新原文, translation: 完整新译文, reason: 原页核证依据}], source_notes: [{blockId: 块编号, text: 底本残缺或版面说明}], unresolved: [未决问题]}。没有修改时 patches、candidate_decisions、source_corrections、source_notes 可省略或为空数组。',
  'JSON 结构铁律（程序门禁强制校验，违者整包拒收）：① patches 每项必须包含 edits 数组（[{old, new}]）与非空 reason，严禁写成扁平 {blockId, old, new}；同一 blockId 在同包 patches 中最多出现一次，同块多处修改须合并放进该块的 edits 数组；② glossary_decisions 每项必须包含非空 src、dst 与 reason（严禁用 info/note 代替 reason，严禁附带 scope 字段）；③ source_corrections 必须给出 pages（整数页码数组）、source（完整新原文块）、translation（应用 patches 后的完整新译文块）与非空 reason，严禁写成 {old, new} 差量；④ source_notes 使用 {blockId, text}（勿用 note 键）；⑤ 仅当输入行实际含 candidate 字段时才填写 candidate_decisions，严禁把 hints/terms 写入 candidate_decisions；⑥ 若编排者运行收尾自检脚本，严禁在脚本中兼容无 edits 的扁平格式、重复 blockId 或缺失 reason 的条目——发现任何字段不合上述规范时，必须先将 results/编号.json 转换重写为标准格式后再结束会话。',
  '关键准则：① glossary_decisions 仅用于真正需要全书唯一固定译名的专有名词或核心理论概念；对于普通多义词、代词或随语境自然分译的词汇（如 je/moi/personne/propre/sujet/identité/vérité/vie/modèle/procès 等），直接在具体句子的 patches 中按语境修订即可，严禁将不同语境译法写入 glossary_decisions（会导致跨包冲突），也严禁因多义词随语境分译而写入 unresolved！② 【篇名与核心主题概念跨包对齐（防前紧后松/各包分译）】：对文章标题/章名核心概念及其关键派生短语（如 making up people / made up），即使 glossary-snapshot 未完整收录原动名词短语，各包也必须通过 glossary_decisions 申报统一译名并在 patches 中统一校改；编排者汇总时除处理 glossaryConflicts 外，须主动核对标题与核心主题术语（如某包改译了核心词，其余包是否仍保留旧译）确保全篇高度一致！审校完成的包默认设 status: "pass"、unresolved: []。',
  '需要修改的文字才输出补丁；保留脚注、附件及 Markdown 结构。候选修订另用 candidate_decisions 明确接受、拒绝或修订。无法确认时 status=needs-work，不为满足检查补写内容。',
  `底本转写讹误与物理裁切/残损双轨处置（防死锁）：若怀疑原文有转写讹误（含英文/拉丁文跨页连字符断词在装配时误插空格形成的断词碎片，如 honor able 实为 honorable），或 hints 含 source_defect（提示底本扫描边缘裁切/缺字），可查阅原文同路径 .source-map.json 中的 logicalPages/pdfPages，并直接检视页面图像（${path.join(manager.dir(t.id),'document/ai_convert/page_images/page_NNN.png')} 对应 logicalPages；${path.join(manager.dir(t.id),'probe-pages/page_NNNN.png')} 对应 pdfPages）：① 若原页图像清晰可辨（或行末连字符跨页/跨裁切边导致的断词错误如 honor able→honorable、Krafft-[Eb]ing 误拼为 Kraffting），提交 source_corrections（附已存在的页码 pages、完整新 source 与完整新 translation）及对应 patches，设 status: "pass"、unresolved: []；② 若核对原图确认属于底本 PDF 自身物理扫描裁切/破损缺字（原图边缘本身即缺失字符，无法从原图恢复更多字形），严禁要求从同一残缺原图中“补全完整原文”而将分包设为 status: "needs-work" 或填入 unresolved（这会阻断整书已审校补丁的合并）！正确做法：基于可见原文与上下文稳妥修订译文 patches，将该处底本物理残缺情况记录入顶层 source_notes: [{blockId, text: "底本第X页左/右缘物理裁切..."}]（程序会自动收入审校报告「底本核证说明」），并将本包设为 status: "pass"、unresolved: []。`,
  '版面与页眉核查：特别核查非章首出现的章节名/书名标题（如 ## 章名/书名），若其紧接在未完半句之后，或自身后半段拼接着正文句子，这属于底本从物理页面抓取的活页眉污染。严禁顺着错误标题将其作为正式大标题翻译；遇到此类断句，在 patch 中说明或记录，确保正文语义连贯。',
  '篇章扉页、标题层级与标题形式规范化：审校时必须全面梳理并规范标题结构与形式：① 严禁将空转节星号（如 ## *）、作者署名（如 ## 雅克·德里达）、题献（如 ## 献给某某）、扉页/封底重复书名与副标题、书末丛书广告目录或原书目录页（Table des matières）内部条目保留为 ##/### 标题而污染目录大纲（星号降为普通段落 *，题献/署名降为斜体段，非章节标题降为粗体或斜体段）；② 严禁因原书多行排版将同一标题拆成两个块（如上一块为 ## 标题前半，下一块为普通段落或同级标题后半，或将 ## 第X部分 / ## I 与下一块 ### 标题 拆成两块），必须合并至首块标题并将残留块转为 HTML 注释占位（<!-- ... -->）以保持块序对齐；③ 对照原书目录核查部（Partie）、编（Division）、章（Chapitre）编号序列与位置，修复漏标、跳号或插到上一章注释前的错位标题，统一全书章标题形式（如统一为 ## I. 标题，消除同书内混用分拆标题、斜体无点号与正体带点号）；④ 严格区分章级（##，含部、编、章、序言、导言、结论）与章内小节级（###，含章内分节及 ### 注释），严禁把章内小节标为 ## 与章并列；⑤ 同步更新文首自动目录（[[#...]]）与书末原书目录译文，确保与正文规范化后的标题完全一致。',
  `可选总结写入 ${path.join(auditDir,'summary.md')}，无需任何版本标记。不要改写输入快照、分包、执行状态或正式译文。程序负责计数、版本核对、合并和报告。`
 ].join('\n')
}

export async function runAgyReviewAudit(manager,t,options={}){
 const prepared=await prepareReviewAudit(manager,t,options)
 const taskDir=manager.dir(t.id),auditDir=prepared.auditDir,reportFile=path.join(taskDir,'review/report.md')
 const reviewCfg=normalizeReviewConfig(t?.reviewConfig)
 options={
  ...options,
  model: options.model ?? (reviewCfg.orchestratorModel || undefined),
  effort: options.effort ?? (reviewCfg.orchestratorEffort || undefined)
 }
 const useAgyCli=isAgyCliModel(options.model)
 const useHarness=Boolean(manager.modelService)&&!useAgyCli
 const priorValidation=await assembleReviewAudit(manager,t,{auditDir})
 prepared.pendingPackets=pendingReviewPackets(prepared.manifest,priorValidation)
 if(options.packetIds!==undefined){
  if(!Array.isArray(options.packetIds)||!options.packetIds.length||options.packetIds.some(id=>!prepared.pendingPackets.includes(id)))throw new Error('定向续审只能选择当前待处理分包')
  prepared.pendingPackets=prepared.pendingPackets.filter(id=>options.packetIds.includes(id))
 }
 t.reviewAudit=prepared
 const prompt=buildAgyReviewPrompt(manager,t,prepared,options)
 await atomic(path.join(auditDir,useHarness?'harness-prompt.txt':'agy-prompt.txt'),prompt)

 const countCompleted=async()=>{
  const files=(await fs.readdir(path.join(auditDir,'results')).catch(()=>[])).filter(f=>/^\d{3}\.json$/.test(f))
  return files.length
 }
 const candidateCid=options.conversationId??(options.resumeConversation!==false?(t.reviewProgress?.conversationId??null):null)
 const canResumeConversation=!useHarness&&Boolean(candidateCid)&&options.newConversation!==true&&options.force!==true&&(options.model===t.reviewProgress?.model||!options.model||!t.reviewProgress?.model)
 const retainedConversationId=canResumeConversation?candidateCid:null
 const retainedChildren=canResumeConversation?(t.reviewProgress?.childConversations??[]):[]

 if(t.reviewProgress?.startedAt)t.reviewRuns=[...(t.reviewRuns??[]),{...t.reviewProgress}].slice(-8)
 t.reviewProgress={
  engine:useHarness?'dsh-harness':'agy-bridge',
  phase:useHarness?'harness-review':'agy-review',
  status:'starting',
  runId:randomUUID(),
  conversationId:retainedConversationId,
  childConversations:retainedChildren,
  idleTimeoutMs:600000,
  totalPackets:prepared.totalPackets,
  completedPackets:await countCompleted(),
  receivedPackets:priorValidation.completed,
  passedPackets:prepared.totalPackets-pendingReviewPackets(prepared.manifest,priorValidation).length,
  model:useHarness&&reviewCfg.workerModel!=='inherit'?reviewCfg.workerModel:options.model??null,
  startedAt:new Date().toISOString()
 }
 await manager.save?.(t)

 const runner=useHarness?runHarnessReview:options.agyRunner??manager.agyRunner
 if(manager.requireHarnessModels&&!manager.modelService&&!useAgyCli)throw new Error('DSH 模型服务尚未就绪')
 let agyReply
 try{
 if(!prepared.pendingPackets.length){agyReply={reused:true}}else if(options.sessionOrchestrated&&useHarness){
  const errCount=priorValidation.errors?.length??0,unresCount=priorValidation.unresolved?.length??0
  const conflictTerms=(priorValidation.glossaryConflicts??[]).map(c=>c.src).join('、')
  throw new Error(`当前仍有 ${prepared.pendingPackets.length}/${prepared.totalPackets} 个分包待完成或待消解（待处理包：${prepared.pendingPackets.slice(0,15).join('、')}${prepared.pendingPackets.length>15?' 等':''}；门禁错误 ${errCount} 项，未决项 ${unresCount} 项${conflictTerms?`，跨包术语冲突：${conflictTerms}`:''}）。请勿直接调用 run(stage: "review") 启动单包串行循环！正确 SOP：1) 使用 subagent 工具按批次并发派发子代理（例如每轮并发 4–8 个 subagent），读取 ${auditDir}/packets/编号.json 并将结果写入 ${auditDir}/results/编号.json；2) 若已有分包存在普通多义词误报的 unresolved 或跨包术语冲突，直接用 write/edit 修正对应 ${auditDir}/results/编号.json（设 status: "pass", unresolved: []）或写入 ${auditDir}/glossary-decisions.json（设 polysemous: true 或 override: true）；3) 调用 review_assemble 校验直至 pendingPackets 为空；4) 最后再调用 run(stage: "review") 完成合成与登记。`)
 }else if(typeof runner==='function'){
  const rawReply=await runner({manager,task:t,taskDir,prepared,prompt,auditDir,reportFile:path.join(auditDir,'summary.md'),options,priorValidation,validate:()=>assembleReviewAudit(manager,t,{auditDir})})
  agyReply=typeof rawReply?.stdout==='string'?extractAgyJson(rawReply.stdout):rawReply
 }else{
  const command=resolveAgyCommand(options.agyCommand??manager.agyCommand)
  // A review has no total duration limit. Only a lack of useful interaction
  // across the coordinator and its own subagents stops the local invocation.
  const idleTimeoutMs=Number(options.idleTimeoutMs??600000)
  if(!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<=0)throw new Error('审校空闲时限无效')
  t.reviewProgress.idleTimeoutMs=idleTimeoutMs

  const maxAttempts=Number(options.maxAttempts??3)
  const baseRetryDelayMs=Number(options.retryDelayMs??3000)
  let attempt=0

  while(attempt<maxAttempts){
   attempt++
   t.reviewProgress.logFile=path.join(auditDir,`agy-${randomUUID()}.log`)
   await manager.save?.(t)

   const args=[
    '-p',prompt,
    '--output-format','json',
    '--log-file',t.reviewProgress.logFile,
    '--print-timeout','0',
    '--mode','accept-edits',
    '--dangerously-skip-permissions',
    '--add-dir',taskDir,
    '--add-dir',manager.root
   ]
   const activeCid=t.reviewProgress.conversationId||retainedConversationId
   if(activeCid)args.push('--conversation',activeCid)
   const agyModelFlag=resolveAgyCliModelFlag(options.model,options.effort)
   if(agyModelFlag)args.push('--model',agyModelFlag)
   if(options.effort)args.push('--effort',options.effort)

   let attemptResult=null,attemptError=null
   try{
    attemptResult=await new Promise((resolve,reject)=>{
     let settled=false,child,pollTimer,killTimer,stopping=false,failure=null,stdout='',stderr='',bytes=0,polling=false,saveQueue=Promise.resolve()
     const active=manager.active?.get(t.id)
     const cleanup=()=>{clearInterval(pollTimer);clearTimeout(killTimer);active?.children?.delete(child)}
     const signalTree=sig=>{try{if(process.platform!=='win32'&&child?.pid)process.kill(-child.pid,sig);else child?.kill(sig)}catch{}}
     const persist=()=>{saveQueue=saveQueue.then(()=>manager.save?.(t));return saveQueue}
     const finish=(err,val)=>{if(settled)return;settled=true;cleanup();saveQueue.then(()=>err?reject(err):resolve(val),reject)}
     const stop=()=>{if(stopping)return;stopping=true;signalTree('SIGTERM');killTimer=setTimeout(()=>signalTree('SIGKILL'),3000);killTimer.unref?.()}

     pollTimer=setInterval(async()=>{
      if(polling||settled||stopping)return
      polling=true
      try{
       if(manager.active?.get(t.id)?.cancel){
        stop()
        return
       }
       const doneCount=await countCompleted()
       const activity=await agyActivity(manager,t,{cliHome:options.agyCliHome})
       if(settled||stopping)return
       const startedMs=Date.parse(t.reviewProgress.startedAt)||Date.now()
       const interactionMs=activity.lastInteractionAt?Date.parse(activity.lastInteractionAt):0
       const activeSinceStart=interactionMs>startedMs
       const lastInteractionAt=activeSinceStart?activity.lastInteractionAt:null
       const nextStatus=activeSinceStart?'running':(activity.conversationId||t.reviewProgress.conversationId)?'connected':'process-started'
       if(doneCount!==t.reviewProgress.completedPackets||activity.conversationId!==t.reviewProgress.conversationId||lastInteractionAt!==t.reviewProgress.lastInteractionAt||nextStatus!==t.reviewProgress.status){
        t.reviewProgress={...t.reviewProgress,status:nextStatus,completedPackets:doneCount,receivedPackets:doneCount,conversationId:activity.conversationId||t.reviewProgress.conversationId,lastInteractionAt,childConversations:activity.childConversations?.length?activity.childConversations:t.reviewProgress.childConversations}
        await persist()
       }
       const lastActiveMs=Math.max(startedMs,interactionMs)
       if(Date.now()-lastActiveMs>=idleTimeoutMs){
        failure=Object.assign(new Error('连续 10 分钟没有有效模型交互，审校已暂停；已保存的分包结果保留'),{code:'AGY_IDLE_TIMEOUT'})
        stop()
       }
      }catch(error){failure=error;stop()}finally{polling=false}
     },options.pollIntervalMs??2000)

     try{
      child=spawn(command,args,{
       cwd:manager.root,
       env:safeAgyEnv(),
       stdio:['ignore','pipe','pipe'],
       windowsHide:true,
       detached:process.platform!=='win32'
      })
      if(active){active.children??=new Set();active.children.add(child);if(active.cancel)stop()}
      child.on('spawn',()=>{t.reviewProgress={...t.reviewProgress,pid:child.pid,status:'process-started',processStartedAt:new Date().toISOString()};persist().catch(error=>{failure=error;stop()})})
      const collect=(kind,chunk)=>{bytes+=Buffer.byteLength(chunk);if(bytes>16*1024*1024){failure=new Error('Antigravity 输出超过本地缓冲区上限，已保留分包结果');stop();return}if(kind==='out')stdout+=chunk;else stderr+=chunk}
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
      child.stdout.on('data',chunk=>collect('out',chunk));child.stderr.on('data',chunk=>collect('err',chunk))
      child.on('error',error=>finish(new Error(`无法启动本地 agy CLI: ${error.message}`)))
      child.on('close',async (code,signal)=>{
       try{
        const postActivity=await agyActivity(manager,t,{cliHome:options.agyCliHome})
        if(postActivity?.conversationId)t.reviewProgress.conversationId=postActivity.conversationId
        if(postActivity?.childConversations?.length)t.reviewProgress.childConversations=postActivity.childConversations
       }catch{}
       if(manager.active?.get(t.id)?.cancel)return finish(new Error('任务已停止'))
       if(failure)return finish(failure)
       if(code!==0)return finish(new Error(`Antigravity (agy) 联合审校调用失败: 退出码 ${code}，信号 ${signal??'无'}${stderr?` (${stderr.slice(0,200).trim()})`:''}`))
       try{
        const parsed=extractAgyJson(stdout)
        if(parsed.status&&parsed.status!=='SUCCESS')return finish(new Error(`Antigravity 返回非成功状态: ${parsed.status}`))
        finish(null,parsed)
       }catch(e){
        finish(new Error(`Antigravity 输出 JSON 解析失败: ${e.message}`))
       }
      })
     }catch(err){
      finish(new Error(`无法启动本地 agy CLI: ${err.message}`))
     }
    })
   }catch(err){
    attemptError=err
   }

   if(attemptResult){
    agyReply=attemptResult
    break
   }

   if(manager.active?.get(t.id)?.cancel||attemptError?.code==='AGY_IDLE_TIMEOUT'||attemptError?.message?.includes('任务已停止')||attemptError?.message?.includes('本地缓冲区上限')){
    throw attemptError
   }

   if(attempt<maxAttempts){
    const delay=baseRetryDelayMs*attempt
    t.reviewProgress.lastError={time:new Date().toISOString(),text:`调用未完成（第 ${attempt} 次尝试）：${attemptError?.message??'未知错误'}；${Math.round(delay/1000)} 秒后进行第 ${attempt+1}/${maxAttempts} 次自动重试...`}
    await manager.save?.(t)
    await new Promise(r=>setTimeout(r,delay))
    if(manager.active?.get(t.id)?.cancel)throw new Error('任务已停止')
   }else{
    throw attemptError
   }
  }
 }

 const validation=await assembleReviewAudit(manager,t,{auditDir})
 const cid=agyReply?.conversation_id??agyReply?.session_id??null
 const previousReceipt=await readJson(path.join(auditDir,'agy-receipt.json'),null)
 const receipt=agyReply?.reused&&previousReceipt?previousReceipt:{
  engine:useHarness?'dsh-harness':'agy-bridge',
  conversationId:cid,
  sessionId:agyReply?.session_id??cid,
  durationSeconds:agyReply?.duration_seconds??null,
  completedAt:new Date().toISOString(),
  totalPackets:prepared.totalPackets,
  completedPackets:validation.completed,
  patchCount:validation.patchCount,
  glossaryDecisionCount:validation.glossaryDecisionCount,
  complete:validation.complete,
  errors:validation.errors
 }
 if(!agyReply?.reused||!previousReceipt)await atomic(path.join(auditDir,'agy-receipt.json'),receipt)
 t.reviewProgress={
  ...t.reviewProgress,
  engine:useHarness?'dsh-harness':'agy-bridge',
  phase:'complete',
  status:validation.complete&&!validation.unresolved.length?'done':'blocked',
  totalPackets:prepared.totalPackets,
  completedPackets:validation.completed,
  receivedPackets:validation.completed,
  passedPackets:validation.total-pendingReviewPackets(prepared.manifest,validation).length,
  finishedAt:new Date().toISOString(),
  patchCount:validation.patchCount,
  glossaryDecisionCount:validation.glossaryDecisionCount,
  conversationId:receipt.conversationId
 }
 if(!validation.complete||validation.errors.length){
  throw new Error(`分包审校未通过程序门禁（已完成 ${validation.completed}/${validation.total} 包，错误 ${validation.errors.length} 项）：${validation.errors.map(e=>`${e.packet??''}:${e.error}`).join('；')}`)
 }

 await assertReviewInputs(manager,t,auditDir)
 const snap=await readJson(path.join(auditDir,'snapshots.json'))
 const summary=await fs.readFile(path.join(auditDir,'summary.md'),'utf8').catch(()=>'')
 const statusTag=validation.unresolved.length?'needs-work':'pass'
 const targetPath=t.translationPath??path.join(manager.dir(t.id),'translation/translated.md')
 const tags=[`<!-- dsh-review-source:${hash(await fs.readFile(await manager.original(t)))} -->`,`<!-- dsh-review-target:${hash(await fs.readFile(targetPath))} -->`,...(t.glossaryReport?.effectiveFingerprint?[`<!-- dsh-review-glossary:${t.glossaryReport.effectiveFingerprint} -->`]:[]),...(t.glossaryReport?.issuesFingerprint?[`<!-- dsh-review-issues:${t.glossaryReport.issuesFingerprint} -->`]:[]),`<!-- dsh-review-status:${statusTag} -->`]
 const sourceNotes=[]
 for(const item of prepared.manifest){
  const result=await readJson(path.join(auditDir,'results',item.id+'.json'),{})
  for(const proof of result.evidenceReviews??[]){
   for(const note of proof.sourceNotes??[])sourceNotes.push(note.text)
   for(const c of proof.sourceCorrections??[])sourceNotes.push('转写更正 '+c.blockId+'：'+c.reason)
  }
   for(const note of [...(result.source_notes??[]),...(result.sourceNotes??[])])if(note?.text||typeof note==='string')sourceNotes.push(typeof note==='string'?note:(note.blockId&&!String(note.text).includes(note.blockId)?`${note.blockId}：${note.text}`:note.text))
  for(const c of [...(result.source_corrections??[]),...(result.sourceCorrections??[])].flatMap(x=>Array.isArray(x?.blockIds)?x.blockIds.map(blockId=>({...x,blockId})):[x]))if(c?.blockId&&c?.reason)sourceNotes.push((c.delete?'剔除空白页透印伪块 ':'转写更正 ')+c.blockId+'：'+c.reason)
 }
 const noteText=sourceNotes.length?'\n\n底本核证说明\n\n'+[...new Set(sourceNotes)].join('\n\n'):''
 const body=summary.replace(/<!--\s*dsh-review-[^>]+-->\s*/g,'').trim()||`已接收 ${validation.completed}/${validation.total} 个审校包，修订 ${validation.patchCount} 处，术语裁决 ${validation.glossaryDecisionCount} 项。`
 await atomic(reportFile,tags.join('\n')+'\n\n'+body+noteText+'\n')
 return {prepared,validation,receipt,reportFile}
 }catch(error){
  t.reviewProgress={...t.reviewProgress,status:manager.active?.get(t.id)?.cancel||['AGY_IDLE_TIMEOUT','REVIEW_IDLE_TIMEOUT'].includes(error.code)?'paused':'blocked',stopReason:['AGY_IDLE_TIMEOUT','REVIEW_IDLE_TIMEOUT'].includes(error.code)?'idle-timeout':manager.active?.get(t.id)?.cancel?'user-stop':'error',error:safeText(error.message,1500),finishedAt:new Date().toISOString()}
  await manager.save?.(t)
  throw error
 }
}

