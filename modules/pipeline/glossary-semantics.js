import {hash} from './markdown.js'

const normalize=s=>String(s??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()
const categories=new Set(['concept','method','technical','institution','person','title'])
const CATEGORY_ALIASES=new Map([
 ['人名','person'],['人物','person'],['author','person'],['figure','person'],['people','person'],
 ['机构名','institution'],['机构','institution'],['organization','institution'],['organisation','institution'],['place','institution'],
 ['作品名','title'],['书名','title'],['著作名','title'],['著作文本','title'],['book','title'],['document','title'],['legislation','title'],['legal','title'],
 ['哲学概念','concept'],['理论概念','concept'],['学科术语','concept'],['概念','concept'],
 ['方法','method'],['方法术语','method'],
 ['技术','technical'],['技术术语','technical']
])
export const CANONICAL_GLOSSARY_CATEGORIES=categories
export function normalizeGlossaryCategory(raw,fallback='concept'){
 const c=String(raw??'').trim()
 if(categories.has(c))return c
 const alias=CATEGORY_ALIASES.get(c)||CATEGORY_ALIASES.get(c.toLowerCase())
 if(alias)return alias
 if(/人名|人物/.test(c))return 'person'
 if(/机构|组织|学院|医院/.test(c))return 'institution'
 if(/书名|著作|作品|法典|文献/.test(c))return 'title'
 if(/方法/.test(c))return 'method'
 if(/技术/.test(c))return 'technical'
 return categories.has(fallback)?fallback:'concept'
}
export function isNonUniversalPublicTerm(src,dst){
 const s=String(src??'').normalize('NFKC').trim(),d=String(dst??'').normalize('NFKC').trim()
 if(!s||!d)return 'empty-term'
 if(normalize(s)===normalize(d))return 'identical-source-target'
 if(/^(?:no change needed|unchanged|无需修改|无需更改|不必修改)$/iu.test(d))return 'meta-placeholder-target'
 if(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(s))return 'cjk-in-source'
 if(skipUnextractedPublicTerm({src:s}))return 'stopword-or-too-short'
 if(/^B\d+(?:[、,，\s-]+B\d+)*$/iu.test(s))return 'block-reference'
 if(/[*«»"“”]|\n/.test(s))return 'formatting-or-quote-noise'
 if(/\b(?:1[4-9]\d{2}|20[0-2]\d)\b/.test(s))return 'year-bound-citation'
 if(/^[A-Z][\p{L}'’.-]+,\s*[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}.'-]+)?$/u.test(s))return 'bibliography-name-format'
 return null
}
const text=s=>typeof s==='string'&&s.trim().length>0
const blockNormCache=new WeakMap()
const getNorm=b=>{if(typeof b==='object'&&b!==null){let n=blockNormCache.get(b);if(!n){n=normalize(b.text);blockNormCache.set(b,n)}return n}return normalize(b)}
const contains=(body,src)=>{const term=normalize(src),normBody=getNorm(body);if(!normBody.includes(term))return false;const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),cjk=/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(term);return new RegExp((cjk?'':'(?<![\\p{L}\\p{N}_])')+escaped+(cjk?'':'(?![\\p{L}\\p{N}_])'),'iu').test(normBody)}
const containsExactCase=(body,src)=>{const raw=typeof body==='object'&&body!==null?String(body.text??''):String(body??''),term=String(src??'').normalize('NFKC').trim().replace(/\s+/g,' ');if(!term)return false;const normRaw=raw.normalize('NFKC').replace(/\s+/g,' ');if(!normRaw.includes(term))return false;const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),cjk=/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(term);return new RegExp((cjk?'':'(?<![\\p{L}\\p{N}_])')+escaped+(cjk?'':'(?![\\p{L}\\p{N}_])'),'u').test(normRaw)}

export const GLOSSARY_DOMAINS=[
 {id:'continental-philosophy',name:'欧陆哲学 / 观念史'},
 {id:'history-of-psychiatry',name:'精神病学史 / 疯癫研究'},
 {id:'history-of-science',name:'科学史 / 认识论'},
 {id:'chinese-medicine-history',name:'中医史 / 东亚医学'},
 {id:'colonial-law',name:'殖民法制 / 帝国治理史'},
 {id:'social-theory',name:'社会理论 / 政治哲学'}
]
export function normalizeGlossaryDomains(domains){
 if(!Array.isArray(domains))return []
 const out=[]
 for(const item of domains){
  const slug=String(item??'').trim().toLowerCase()
  if(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)&&!out.includes(slug))out.push(slug)
 }
 return out
}
export function isNonTermSectionHeading(src){
 return NON_TERM_SECTIONS.has(normalize(src))
}
const NON_TERM_SECTIONS=new Set([
 'introduction','conclusion','conclusions','preface','foreword','afterword','appendix','appendices',
 'bibliography','references','acknowledgments','acknowledgements','index','glossary','contents','table of contents','seminar'
])
const PROPER_CATEGORIES=new Set(['person','title','institution'])
const PUBLIC_STOPWORDS=new Set([
 'a','an','the','and','or','but','nor','yet','so','for','of','in','on','at','to','from','with','by','as','is','are','was','were','be','been','being','it','its','if','not','no',
 'he','she','we','they','you','my','your','his','her','our','their','this','that','these','those','what','which','who','whom','whose','where','when','why','how',
 'le','la','les','l','un','une','de','du','des','et','ou','en','au','aux','ce','cet','cette','ces','je','tu','il','elle','on','nous','vous','ils','elles','ne','pas','que','qui','dont','par','pour','avec','dans','sur','sous','vers','sans','chez','car','donc','ni','si',
 ...NON_TERM_SECTIONS
])
const isTitleCaseTerm=src=>{const s=String(src??'').trim();return /^[\p{Lu}]/u.test(s)&&!/^[\p{Lu}\p{N}_'’.\-\s]+$/u.test(s)}
const skipUnextractedPublicTerm=t=>{
 const raw=String(t?.src??'').trim(),norm=normalize(raw)
 if(!norm)return true
 if(PUBLIC_STOPWORDS.has(norm))return true
 const hasCjk=/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(raw)
 if(!hasCjk&&!/\s/.test(raw)&&raw.length<=2&&!/^[A-Z]{2}$/.test(raw))return true
 return false
}
export const requiresCaseSensitivePublicMatch=t=>t?.case_sensitive===true||t?.matchPolicy?.caseSensitive===true||isTitleCaseTerm(t?.src)
const ARTICLES=new Set(['le','la','les','l','un','une','the','a','an','de','du','des','d','of','der','die','das'])
const STOP_STEMS=new Set(['the','and','for','with','from','into','that','this','person','people','kind','type','of','de','des','les','une','der','die','das'])
export const AUTO_PASS_REASON='低频专名，未经合并直接保留'
const normApostrophe=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/[’‘`´]/gu,"'").replace(/\s+/g,' ').trim()
const lexTokens=s=>normApostrophe(s).match(/[\p{L}\p{N}_]+/gu)??[]
const stemToken=w=>{if(w.length<=3)return w;let x=w.replace(/aux$/,'al').replace(/[sx]$/,'');if(x.length>3)x=x.replace(/e$/,'').replace(/y$/,'i');return x}
const inflectionKey=s=>lexTokens(s).filter(w=>!ARTICLES.has(w)).map(stemToken).join(' ')
const countOccurrences=(normSource,src)=>{const target=normApostrophe(src);return target?normSource.split(target).length-1:0}

function wireEntryLength(e){
 if(e.conflict||e.uncertain||e.publicOnly)return JSON.stringify({id:99,src:e.src,dst:e.dst,category:e.category,conflict:e.conflict||undefined,uncertain:e.uncertain||undefined,publicOnly:e.publicOnly||undefined,proposals:e.proposals,publicOptions:e.publicOptions,evidence:e.evidence}).length+40
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
 const structuralKeys=new Set((structural?.terms??[]).map(t=>normalize(t.src)))
 const byKey=new Map(),publicTerms=[...common.entries,...common.ambiguous.flatMap(g=>g.options)].filter(t=>{
  if(!(t.language==='*'||t.language===language))return false
  const extracted=structuralKeys.has(normalize(t.src))
  if(!extracted&&skipUnextractedPublicTerm(t))return false
  const check=!extracted&&requiresCaseSensitivePublicMatch(t)?containsExactCase:contains
  return blocks.some(b=>check(b,t.src))
 })
 for(const term of [...structural.terms,...publicTerms]){const k=normalize(term.src),group=byKey.get(k)??[];group.push(term);byKey.set(k,group)}
 const entries=[...byKey].map(([k,terms])=>{
  const first=terms[0],context=[],seen=new Set()
  const byDst=new Map()
  for(const t of terms){
   const d=String(t.dst??'').trim(),m=String(t.sense??t.info??'').trim().slice(0,80)
   if(!byDst.has(d)||(!byDst.get(d).meaning&&m))byDst.set(d,{dst:d,meaning:m})
  }
  const proposals=[...byDst.values()],pubOpts=publicTerms.filter(t=>normalize(t.src)===k).map(t=>({dst:t.dst,info:t.info??''}))
  const publicOnly=!structuralKeys.has(k)
  const conflict=proposals.length>1||pubOpts.some(o=>o.dst!==first.dst)||terms.some(t=>t.uncertain===true)
  const exactOnly=publicOnly&&requiresCaseSensitivePublicMatch(first)
  const preferred=new Set(terms.flatMap(t=>t.evidence??[]).map(e=>e.blockId)),matches=blocks.filter(b=>(exactOnly?containsExactCase:contains)(b,first.src)).sort((a,b)=>Number(preferred.has(b.id))-Number(preferred.has(a.id)))
  for(const b of matches){
   const match=new RegExp(first.src.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/['’‘]/gu,"['’‘]").replace(/\s+/g,'\\s+'),exactOnly?'u':'iu').exec(b.text)
   const offset=match?.index??0,start=Math.max(0,offset-60),quote=b.text.slice(start,Math.min(b.text.length,offset+(match?.[0].length??first.src.length)+120))
   if(!seen.has(quote)){context.push({blockId:b.id,quote});seen.add(quote)}if(context.length===(conflict?2:1))break
  }
  return {entryId:'t-'+hash(k).slice(0,24),src:first.src,dst:first.dst,category:first.category??'concept',conflict,publicOnly,proposals,evidence:context,publicOptions:pubOpts,bookSpecific:false,uncertain:terms.some(t=>t.uncertain===true)}
 })
 const normSource=normApostrophe(source??blocks.map(b=>b.text).join('\n')),{find,sizes}=associationClusters(entries)
 const autoPassRaw=[],clusters=new Map()
 for(const [i,e] of entries.entries()){
  const publicConflict=e.publicOptions.some(o=>o.dst!==e.dst),occurrences=countOccurrences(normSource,e.src)
  if(enableAutoPass&&structuralKeys.has(normalize(e.src))&&PROPER_CATEGORIES.has(e.category)&&occurrences<=1&&!e.conflict&&!e.uncertain&&!publicConflict&&sizes.get(find(i))===1){
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

const HOUSEKEEPING_DROP_RE=/\b(?:duplicate|duplicated|already\s+(?:in|merged|kept|grouped|included|resolved)|merged\s+into|see\s+(?:above|earlier|group))\b|重复|已(?:归并|合并|保留|收录|处理)|并入/iu

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
  let validMembers=group.members.filter(m=>{
   const entry=resolveEntry(m)
   if(!entry&&m?.action==='drop'&&(!text(m?.dst)||m?.reason==='占位'))return false
   return true
  })
  if(deltaMode&&!isDefault&&validMembers.length){
   const byEntry=new Map()
   for(const m of validMembers){const e=resolveEntry(m);if(!e)continue;const list=byEntry.get(e.entryId)??[];list.push(m);byEntry.set(e.entryId,list)}
   const collapsed=new Map()
   for(const [eid,list] of byEntry){
    if(list.length<2)continue
    const orig=byId.get(eid),keeps=list.filter(m=>(m.action??'keep')==='keep'),drops=list.filter(m=>m.action==='drop')
    if(keeps.length+drops.length!==list.length)continue
    if(keeps.length>=1){
     const keptDsts=[...new Set(keeps.map(m=>(text(m.dst)?m.dst.trim():(orig?.dst??orig?.src??'')).trim()).filter(Boolean))]
     if(keptDsts.length===1&&drops.every(d=>!text(d.dst)||d.dst.trim()!==keptDsts[0])){
      const dropNote=drops.find(d=>text(d.reason))?.reason?.trim()
      collapsed.set(eid,{...keeps[0],...(text(keeps[0].reason)||!dropNote?{}:{reason:dropNote})})
     }
    }else if(drops.length>1){
     collapsed.set(eid,drops[0])
    }
   }
   if(collapsed.size){
    const emitted=new Set()
    validMembers=validMembers.flatMap(m=>{
     const e=resolveEntry(m);if(!e||!collapsed.has(e.entryId))return [m]
     if(emitted.has(e.entryId))return []
     emitted.add(e.entryId);return [collapsed.get(e.entryId)]
    })
   }
   validMembers=validMembers.filter(m=>{
    const e=resolveEntry(m)
    if(e&&seen.has(e.entryId)&&translations.has(normalize(e.src))&&m?.action==='drop'&&HOUSEKEEPING_DROP_RE.test(`${m?.reason??''} ${group?.reason??''}`))return false
    return true
   })
  }
  if(!validMembers.length)return
  if(!deltaMode&&!isDefault&&(!categories.has(group.category)||!text(group.reason)||!text(group.scope)||typeof group.uncertain!=='boolean'||typeof group.publicEligible!=='boolean'||!text(group.publicReason)))throw new Error('术语分组缺少含义、范围或公共表准入判定')
  for(const member of validMembers){
   const entry=resolveEntry(member),action=member.action??'keep'
   if(deltaMode&&action==='drop'&&!text(member.reason))member.reason=text(group.reason)?group.reason.trim():'非核心学术术语'
   const dst=text(member.dst)?member.dst.trim():(action==='drop'||deltaMode?entry?.dst??entry?.src:'')
   if(!entry||seen.has(entry.entryId)||!text(dst)||!['keep','drop'].includes(action)||action==='drop'&&!text(member.reason)){
    const label=`${unit.unitId} 条目 ${member?.id??member?.entryId??'?'}${entry?` (${entry.src})`:''}`
    throw new Error(`术语全表归并遗漏、重复或添加了原文之外的条目（${label}；请调用 run 并传 options.retryErrors=true 仅重跑异常分片，切勿手改 records.json）`)
   }
   seen.add(entry.entryId)
  }
  const firstEntry=resolveEntry(validMembers[0])
  const category=normalizeGlossaryCategory(group.category,normalizeGlossaryCategory(firstEntry?.category,'concept'))
  const reason=text(group.reason)?group.reason.trim():(validMembers.find(m=>text(m.reason))?.reason?.trim()||firstEntry?.proposals?.[0]?.meaning||'按原文语境采用')
  const scope=text(group.scope)?group.scope.trim():'本书语境'
  const uncertain=Boolean(group.uncertain)
  const rawTier=String(group.tier??'').trim().toLowerCase()
  const promotionDomain=rawTier==='domain'?normalizeGlossaryDomains([group.domain])[0]??'':''
  const promotionTier=rawTier==='domain'&&promotionDomain?'domain':rawTier==='local'?'local':'common'
  const requestedPublic=rawTier==='local'?false:(typeof group.publicEligible==='boolean'?group.publicEligible:!firstEntry?.bookSpecific)
  const publicReason=text(group.publicReason)?group.publicReason.trim():(requestedPublic?'术语明确，待联合审校确认':'本书特定用法，保留在本书')
  const members=validMembers.map(m=>{
   const orig=resolveEntry(m),action=m.action??'keep',dst=(text(m.dst)?m.dst:orig.dst).trim()
   return {...orig,evidence:orig.evidence.map(e=>e.contextId?unit.contexts.find(c=>c.contextId===e.contextId):e),dst,action,...(m.reason?{reason:m.reason}:{})}
  })
  const conceptId='concept-'+hash(members.map(m=>m.entryId).sort().join('|')).slice(0,24)
  const groupLocal=!requestedPublic||Boolean(unit.autoPass)||members.some(m=>m.action==='keep'&&(m.bookSpecific||m.publicOptions.some(o=>o.dst!==m.dst)||Boolean(isNonUniversalPublicTerm(m.src,m.dst))))
  const saved={...group,category,reason,scope,uncertain,publicEligible:!groupLocal,promotionTier:groupLocal?'local':promotionTier,...(promotionDomain&&!groupLocal?{promotionDomain}:{}),requestedPublicEligibility:requestedPublic,publicReason,conceptId,members}
  let issue=uncertain?'semantic-group-unresolved':null
  if(category==='person'&&!uncertain){
   const names=members.filter(m=>m.action==='keep'),letters=s=>s.replace(/[^\p{L}\p{N}]/gu,'')
   for(const short of names)for(const full of names)if(normalize(full.src)!==normalize(short.src)&&contains(full.src,short.src)&&/[\u3400-\u9fff]/u.test(short.dst)&&/[\u3400-\u9fff]/u.test(full.dst)&&!letters(full.dst).includes(letters(short.dst)))issue='inconsistent-person-name'
  }
  groups.push(saved)
  if(issue){
   unresolved.push({conceptId,reason:issue,scope,members:members.map(m=>({src:m.src,proposed:m.dst})),handling:'preserve-source-for-joint-review'})
   saved.publicEligible=false
   saved.promotionTier='local'
   for(const member of members){member.proposedDst=member.dst;member.dst=member.src;member.action='keep';member.bookSpecific=true}
  }
  for(const member of members){
   if(member.action==='drop'){rejected.push(member);continue}
   const nonUniversal=unit.autoPass?'unreviewed-auto-pass':isNonUniversalPublicTerm(member.src,member.dst)
   const memberPublicEligible=!groupLocal&&!issue&&!nonUniversal
   const memberPublicReason=issue?'含义或姓名译法待联合审校，保留原词。':nonUniversal?'未经充分归并审核或属同形/引文/非通用表达，仅保留在本书。':groupLocal?'本组含本书特定用法或既有公共译名差异，整组保留在本书。':publicReason
   translations.set(normalize(member.src),{...member,category,conceptId,aliases:members.filter(m=>m.action==='keep').map(m=>m.src),publicEligible:memberPublicEligible,promotionTier:memberPublicEligible?promotionTier:'local',...(promotionDomain&&memberPublicEligible?{promotionDomain}:{}),info:scope==='本书语境'?reason:scope+'；'+reason,publicReason:memberPublicReason})
  }
 }

 for(const group of rawGroups)processGroup(group,false)
 if(deltaMode){
  const defaultMemberReason=unit.autoPass?AUTO_PASS_REASON:'默认保留在本书'
  for(const entry of unit.entries)if(!seen.has(entry.entryId)){
   // Unmentioned delta-mode entries are kept strictly for THIS book (`local`),
   // never silently promoted to shared public/domain glossaries without explicit approval.
   processGroup({members:[{entryId:entry.entryId,dst:entry.dst,action:entry.initialDecision??'keep',reason:defaultMemberReason}],category:normalizeGlossaryCategory(entry.category,'concept'),tier:'local',reason:unit.autoPass?AUTO_PASS_REASON:(entry.proposals?.[0]?.meaning||'按原文语境采用'),scope:'本书语境',uncertain:Boolean(entry.uncertain||entry.conflict),publicEligible:false,publicReason:unit.autoPass?'低频专名未经跨书归并审核，仅保留在本书':'默认仅保留在本书，需显式审核通过方可进入公共或领域库'},true)
  }
 }
 if(seen.size!==unit.entries.length)throw new Error('术语全表归并没有覆盖所有有原文证据的候选')
 const shared=[],overrides=[],additions=[]
 for(const original of unit.entries){
  const term=translations.get(normalize(original.src));if(!term)continue
  const options=[...common.entries,...common.ambiguous.flatMap(g=>g.options)].filter(e=>(e.language==='*'||e.language===language)&&normalize(e.src)===normalize(term.src)),oldOverride=previous.overrides.some(e=>normalize(e.src)===normalize(term.src))
  const entry={src:term.src,dst:term.dst,info:term.info,language,category:term.category,conceptId:term.conceptId,aliases:term.aliases,evidence:term.evidence,matchPolicy:{caseSensitive:isTitleCaseTerm(term.src)||/^[A-Z]{2,}$/.test(term.src.trim())},semanticApproval:{publicEligible:term.publicEligible,tier:term.promotionTier??(term.publicEligible?'common':'local'),...(term.promotionDomain?{domain:term.promotionDomain}:{}),reason:term.publicReason}}
  if(oldOverride||!term.publicEligible||options.some(e=>e.dst!==term.dst)){overrides.push(entry);continue}
  shared.push(entry);if(!options.length)additions.push(entry)
 }
 const effective=[...shared,...overrides].map(e=>({src:e.src,dst:e.dst,info:e.info,regex:false,case_sensitive:false}))
 if(new Set(effective.map(e=>normalize(e.src))).size!==effective.length)throw new Error('语义归并后仍有重复生效原词')
 return {...previous,shared,overrides,additions,effective,groups,rejected,unresolved}
}
