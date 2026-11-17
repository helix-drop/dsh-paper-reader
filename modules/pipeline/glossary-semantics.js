import {hash} from './markdown.js'

const normalize=s=>String(s??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()
const categories=new Set(['concept','method','technical','institution','person','title'])
const text=s=>typeof s==='string'&&s.trim().length>0
const blockNormCache=new WeakMap()
const getNorm=b=>{if(typeof b==='object'&&b!==null){let n=blockNormCache.get(b);if(!n){n=normalize(b.text);blockNormCache.set(b,n)}return n}return normalize(b)}
const contains=(body,src)=>{const term=normalize(src),normBody=getNorm(body);if(!normBody.includes(term))return false;const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),cjk=/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(term);return new RegExp((cjk?'':'(?<![\\p{L}\\p{N}_])')+escaped+(cjk?'':'(?![\\p{L}\\p{N}_])'),'iu').test(normBody)}

const PROPER_CATEGORIES=new Set(['person','title','institution'])
const ARTICLES=new Set(['le','la','les','l','un','une','the','a','an','de','du','des','d','of','der','die','das'])
const STOP_STEMS=new Set(['the','and','for','with','from','into','that','this','person','people','kind','type','of','de','des','les','une','der','die','das'])
export const AUTO_PASS_REASON='低频专名，未经合并直接保留'
const normApostrophe=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/[’‘`´]/gu,"'").replace(/\s+/g,' ').trim()
const lexTokens=s=>normApostrophe(s).match(/[\p{L}\p{N}_]+/gu)??[]
const stemToken=w=>{if(w.length<=3)return w;let x=w.replace(/aux$/,'al').replace(/[sx]$/,'');if(x.length>3)x=x.replace(/e$/,'').replace(/y$/,'i');return x}
const inflectionKey=s=>lexTokens(s).filter(w=>!ARTICLES.has(w)).map(stemToken).join(' ')
const countOccurrences=(normSource,src)=>{const target=normApostrophe(src);return target?normSource.split(target).length-1:0}

function wireEntryLength(e){
 if(e.conflict||e.uncertain)return JSON.stringify({id:99,src:e.src,dst:e.dst,category:e.category,conflict:e.conflict||undefined,uncertain:e.uncertain||undefined,proposals:e.proposals,publicOptions:e.publicOptions,evidence:e.evidence}).length+40
 return JSON.stringify({id:99,src:e.src,dst:e.dst,category:e.category}).length+2
}

// Conservative four-rule union for lexical association:
// (1) inflection/article variants, (2) person surname containment,
// (3) whole-entry token containment (len>=4), (4) shared >=3-char stem + family.
function associationClusters(entries){
 const n=entries.length,parent=entries.map((_,i)=>i)
 const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i]}return i}
 const union=(a,b)=>{parent[find(a)]=find(b)}
 const byInflection=new Map()
 for(const [i,e] of entries.entries()){const k=inflectionKey(e.src);if(!k)continue;const prev=byInflection.get(k);if(prev!==undefined)union(prev,i);else byInflection.set(k,i)}
 const persons=[],lastNames=new Map()
 for(const [i,e] of entries.entries()){
  if(e.category!=='person')continue
  const t=lexTokens(e.src);persons.push([i,t])
  if(t.length){const last=t[t.length-1],list=lastNames.get(last)??[];list.push(i);lastNames.set(last,list)}
 }
 for(const [i,t] of persons)if(t.length===1&&lastNames.has(t[0]))for(const j of lastNames.get(t[0]))if(j!==i)union(i,j)
 const keyIdx=new Map()
 for(const [i,e] of entries.entries()){
  const k=lexTokens(e.src).filter(w=>!ARTICLES.has(w)).join(' ')
  if(k.length>=4){const list=keyIdx.get(k)??[];list.push(i);keyIdx.set(k,list)}
 }
 for(const [i,e] of entries.entries()){
  const sig=lexTokens(e.src).filter(w=>!ARTICLES.has(w))
  for(let a=0;a<sig.length;a++)for(let b=a+1;b<=sig.length;b++){
   if(b-a===sig.length)continue
   const matches=keyIdx.get(sig.slice(a,b).join(' '))
   if(matches)for(const j of matches)union(i,j)
  }
 }
 const stemIdx=new Map()
 for(const [i,e] of entries.entries()){
  for(const word of lexTokens(e.src)){
   const stem=stemToken(word)
   if(word.length<3||STOP_STEMS.has(word)||!stem)continue
   const prev=stemIdx.get(stem)
   if(prev!==undefined)union(i,prev);else stemIdx.set(stem,i)
  }
 }
 const family=s=>normalize(s).replace(/persons|people/g,'person').replace(/kinds/g,'kind').replace(/types/g,'type').replace(/\b(?:a|an|the)\s+/g,'')
 const families=new Map()
 for(const [i,e] of entries.entries()){const f=family(e.src),old=families.get(f);if(old!==undefined)union(i,old);else families.set(f,i)}
 const sizes=new Map()
 for(let i=0;i<n;i++){const root=find(i);sizes.set(root,(sizes.get(root)??0)+1)}
 return {find,sizes}
}

function buildUnit(batch,sourceFingerprint,prefix='g-',extra={}){
 const contexts=[],byContext=new Map(),compact=batch.map((e,idx)=>{
  const evidence=e.evidence.map(context=>{const k=context.blockId+'|'+context.quote;let contextId=byContext.get(k);if(!contextId){contextId='x-'+hash(k).slice(0,16);byContext.set(k,contextId);contexts.push({contextId,...context})}return {contextId}})
  return {id:idx+1,...e,evidence}
 })
 const payload={sourceFingerprint,entryCount:compact.length,entries:compact,contexts,otherTerms:[],otherTermsAreContextOnly:true,...extra}
 return {unitId:prefix+hash(JSON.stringify(payload)).slice(0,24),...payload}
}

// Lightweight single-pass batching: deduplicate proposals by dst, route uncontested
// once-only proper names to auto-pass, and size LLM batches by slim wire payload + 100-entry cap.
export function partitionCleaningCandidates(structural,common,blocks,sourceFingerprint,language,maxChars=24000,{source,maxEntries=100,enableAutoPass=true}={}){
 const byKey=new Map(),publicTerms=[...common.entries,...common.ambiguous.flatMap(g=>g.options)].filter(t=>(t.language==='*'||t.language===language)&&blocks.some(b=>contains(b,t.src)))
 for(const term of [...structural.terms,...publicTerms]){const k=normalize(term.src),group=byKey.get(k)??[];group.push(term);byKey.set(k,group)}
 const entries=[...byKey].map(([k,terms])=>{
  const first=terms[0],context=[],seen=new Set()
  const byDst=new Map()
  for(const t of terms){
   const d=String(t.dst??'').trim(),m=String(t.sense??t.info??'').trim().slice(0,80)
   if(!byDst.has(d)||(!byDst.get(d).meaning&&m))byDst.set(d,{dst:d,meaning:m})
  }
  const proposals=[...byDst.values()],pubOpts=publicTerms.filter(t=>normalize(t.src)===k).map(t=>({dst:t.dst,info:t.info??''}))
  const conflict=proposals.length>1||pubOpts.some(o=>o.dst!==first.dst)||terms.some(t=>t.uncertain===true)
  const preferred=new Set(terms.flatMap(t=>t.evidence??[]).map(e=>e.blockId)),matches=blocks.filter(b=>contains(b,first.src)).sort((a,b)=>Number(preferred.has(b.id))-Number(preferred.has(a.id)))
  for(const b of matches){
   const match=new RegExp(first.src.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/['’‘]/gu,"['’‘]").replace(/\s+/g,'\\s+'),'iu').exec(b.text)
   const offset=match?.index??0,start=Math.max(0,offset-60),quote=b.text.slice(start,Math.min(b.text.length,offset+(match?.[0].length??first.src.length)+120))
   if(!seen.has(quote)){context.push({blockId:b.id,quote});seen.add(quote)}if(context.length===(conflict?2:1))break
  }
  return {entryId:'t-'+hash(k).slice(0,24),src:first.src,dst:first.dst,category:first.category??'concept',conflict,proposals,evidence:context,publicOptions:pubOpts,bookSpecific:false,uncertain:terms.some(t=>t.uncertain===true)}
 })
 const normSource=normApostrophe(source??blocks.map(b=>b.text).join('\n')),{find,sizes}=associationClusters(entries)
 const autoPassRaw=[],clusters=new Map()
 for(const [i,e] of entries.entries()){
  const publicConflict=e.publicOptions.some(o=>o.dst!==e.dst),occurrences=countOccurrences(normSource,e.src)
  if(enableAutoPass&&PROPER_CATEGORIES.has(e.category)&&occurrences<=1&&!e.conflict&&!e.uncertain&&!publicConflict&&sizes.get(find(i))===1){
   autoPassRaw.push({entry:e,occurrences})
   continue
  }
  const root=find(i),group=clusters.get(root)??[];group.push(e);clusters.set(root,group)
 }
 const budget=Math.max(4000,maxChars>20000?maxChars-6000:Math.floor(maxChars*0.72)),cap=Math.max(1,maxEntries)
 const batches=[];let batch=[],size=0
 for(const cluster of clusters.values()){
  const length=cluster.reduce((sum,e)=>sum+wireEntryLength(e),0)
  if(batch.length+cluster.length<=cap&&size+length<=budget){batch.push(...cluster);size+=length;continue}
  if(batch.length&&cluster.length<=cap&&length<=budget){batches.push(batch);batch=[...cluster];size=length;continue}
  if(batch.length){batches.push(batch);batch=[];size=0}
  for(const entry of cluster){
   const entryLen=wireEntryLength(entry)
   if(batch.length&&(batch.length>=cap||size+entryLen>budget)){batches.push(batch);batch=[];size=0}
   batch.push(entry);size+=entryLen
  }
 }
 if(batch.length)batches.push(batch)
 const units=batches.map(b=>buildUnit(b,sourceFingerprint,'g-'))
 const autoPassUnit=autoPassRaw.length?buildUnit(autoPassRaw.map(x=>x.entry),sourceFingerprint,'auto-pass-',{autoPass:true}):null
 const autoPass={
  schemaVersion:1,
  sourceFingerprint,
  reason:AUTO_PASS_REASON,
  count:autoPassRaw.length,
  entries:autoPassRaw.map(({entry,occurrences})=>({entryId:entry.entryId,src:entry.src,dst:entry.dst,category:entry.category,occurrences,reason:AUTO_PASS_REASON,evidence:entry.evidence})),
 }
 return {units,autoPassUnit,autoPass}
}

export function compactCleaningUnits(structural,common,blocks,sourceFingerprint,language,maxChars=24000,options={}){
 return partitionCleaningCandidates(structural,common,blocks,sourceFingerprint,language,maxChars,{...options,enableAutoPass:options.enableAutoPass===true}).units
}

export function applyConsolidation(unit,record,previous,common,language){
 const rawGroups=record?.groups??record?.decisions
 if(record?.unitId!==unit.unitId||!Array.isArray(rawGroups))throw new Error('术语全表归并缺少完整分组')
 const hasShortId=rawGroups.some(g=>Array.isArray(g?.members)&&g.members.some(m=>m?.id!==undefined))
 const deltaMode=record?.delta===true||Number.isInteger(record?.checkedCount)||Array.isArray(record?.decisions)||hasShortId||(rawGroups.length===0&&unit.entries.length>0)
 const byId=new Map(unit.entries.map(e=>[e.entryId,e])),byShortId=new Map(unit.entries.map((e,i)=>[String(e.id??i+1),e]))
 const resolveEntry=m=>byId.get(m?.entryId)??byShortId.get(String(m?.id??m?.entryId??''))
 const seen=new Set(),translations=new Map(),groups=[],unresolved=[],rejected=[]

 const processGroup=(group,isDefault=false)=>{
  if(!Array.isArray(group.members)||!group.members.length){if(deltaMode)return;throw new Error('术语分组缺少含义、范围或公共表准入判定')}
  const validMembers=group.members.filter(m=>{
   const entry=resolveEntry(m)
   if(!entry&&m?.action==='drop'&&(!text(m?.dst)||m?.reason==='占位'))return false
   return true
  })
  if(!validMembers.length)return
  if(!deltaMode&&!isDefault&&(!categories.has(group.category)||!text(group.reason)||!text(group.scope)||typeof group.uncertain!=='boolean'||typeof group.publicEligible!=='boolean'||!text(group.publicReason)))throw new Error('术语分组缺少含义、范围或公共表准入判定')
  for(const member of validMembers){
   const entry=resolveEntry(member),action=member.action??'keep'
   if(deltaMode&&action==='drop'&&!text(member.reason))member.reason=text(group.reason)?group.reason.trim():'非核心学术术语'
   const dst=text(member.dst)?member.dst.trim():(action==='drop'||deltaMode?entry?.dst??entry?.src:'')
   if(!entry||seen.has(entry.entryId)||!text(dst)||!['keep','drop'].includes(action)||action==='drop'&&!text(member.reason))throw new Error('术语全表归并遗漏、重复或添加了原文之外的条目')
   seen.add(entry.entryId)
  }
  const firstEntry=resolveEntry(validMembers[0])
  const category=categories.has(group.category)?group.category:(categories.has(firstEntry?.category)?firstEntry.category:'concept')
  const reason=text(group.reason)?group.reason.trim():(validMembers.find(m=>text(m.reason))?.reason?.trim()||firstEntry?.proposals?.[0]?.meaning||'按原文语境采用')
  const scope=text(group.scope)?group.scope.trim():'本书语境'
  const uncertain=Boolean(group.uncertain)
  const requestedPublic=typeof group.publicEligible==='boolean'?group.publicEligible:!firstEntry?.bookSpecific
  const publicReason=text(group.publicReason)?group.publicReason.trim():(requestedPublic?'术语明确，待联合审校确认':'本书特定用法，保留在本书')
  const members=validMembers.map(m=>{
   const orig=resolveEntry(m),action=m.action??'keep',dst=(text(m.dst)?m.dst:orig.dst).trim()
   return {...orig,evidence:orig.evidence.map(e=>e.contextId?unit.contexts.find(c=>c.contextId===e.contextId):e),dst,action,...(m.reason?{reason:m.reason}:{})}
  })
  const conceptId='concept-'+hash(members.map(m=>m.entryId).sort().join('|')).slice(0,24)
  const groupLocal=!requestedPublic||members.some(m=>m.action==='keep'&&(m.bookSpecific||m.publicOptions.some(o=>o.dst!==m.dst)))
  const saved={...group,category,reason,scope,uncertain,publicEligible:!groupLocal,requestedPublicEligibility:requestedPublic,publicReason,conceptId,members}
  let issue=uncertain?'semantic-group-unresolved':null
  if(category==='person'&&!uncertain){
   const names=members.filter(m=>m.action==='keep'),letters=s=>s.replace(/[^\p{L}\p{N}]/gu,'')
   for(const short of names)for(const full of names)if(normalize(full.src)!==normalize(short.src)&&contains(full.src,short.src)&&/[\u3400-\u9fff]/u.test(short.dst)&&/[\u3400-\u9fff]/u.test(full.dst)&&!letters(full.dst).includes(letters(short.dst)))issue='inconsistent-person-name'
  }
  groups.push(saved)
  if(issue){
   unresolved.push({conceptId,reason:issue,scope,members:members.map(m=>({src:m.src,proposed:m.dst})),handling:'preserve-source-for-joint-review'})
   saved.publicEligible=false
   for(const member of members){member.proposedDst=member.dst;member.dst=member.src;member.action='keep';member.bookSpecific=true}
  }
  for(const member of members){
   if(member.action==='drop'){rejected.push(member);continue}
   translations.set(normalize(member.src),{...member,category,conceptId,aliases:members.filter(m=>m.action==='keep').map(m=>m.src),publicEligible:!groupLocal&&!issue,info:scope==='本书语境'?reason:scope+'；'+reason,publicReason:issue?'含义或姓名译法待联合审校，保留原词。':groupLocal?'本组含本书特定用法或既有公共译名差异，整组保留在本书。':publicReason})
  }
 }

 for(const group of rawGroups)processGroup(group,false)
 if(deltaMode){
  const defaultMemberReason=unit.autoPass?AUTO_PASS_REASON:'默认保留无异议术语'
  for(const entry of unit.entries)if(!seen.has(entry.entryId)){
   processGroup({members:[{entryId:entry.entryId,dst:entry.dst,action:entry.initialDecision??'keep',reason:defaultMemberReason}],category:categories.has(entry.category)?entry.category:'concept',reason:unit.autoPass?AUTO_PASS_REASON:(entry.proposals?.[0]?.meaning||'按原文语境采用'),scope:'本书语境',uncertain:Boolean(entry.uncertain||entry.conflict),publicEligible:!entry.bookSpecific&&!entry.conflict,publicReason:entry.bookSpecific?'本书含义保留在本书':'术语明确，待联合审校确认'},true)
  }
 }
 if(seen.size!==unit.entries.length)throw new Error('术语全表归并没有覆盖所有有原文证据的候选')
 const shared=[],overrides=[],additions=[]
 for(const original of unit.entries){
  const term=translations.get(normalize(original.src));if(!term)continue
  const options=[...common.entries,...common.ambiguous.flatMap(g=>g.options)].filter(e=>(e.language==='*'||e.language===language)&&normalize(e.src)===normalize(term.src)),oldOverride=previous.overrides.some(e=>normalize(e.src)===normalize(term.src))
  const entry={src:term.src,dst:term.dst,info:term.info,language,category:term.category,conceptId:term.conceptId,aliases:term.aliases,evidence:term.evidence,semanticApproval:{publicEligible:term.publicEligible,reason:term.publicReason}}
  if(oldOverride||!term.publicEligible||options.some(e=>e.dst!==term.dst)){overrides.push(entry);continue}
  shared.push(entry);if(!options.length)additions.push(entry)
 }
 const effective=[...shared,...overrides].map(e=>({src:e.src,dst:e.dst,info:e.info,regex:false,case_sensitive:false}))
 if(new Set(effective.map(e=>normalize(e.src))).size!==effective.length)throw new Error('语义归并后仍有重复生效原词')
 return {...previous,shared,overrides,additions,effective,groups,rejected,unresolved}
}
