import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {randomUUID} from 'node:crypto'
import {DatabaseSync,backup} from 'node:sqlite'
import {jsonrepair} from 'jsonrepair'
import {hash,markdownBlocks} from './markdown.js'
import {compactCleaningUnits,partitionCleaningCandidates,applyConsolidation,normalizeGlossaryCategory,isNonUniversalPublicTerm,isNonTermSectionHeading,normalizeGlossaryDomains,AUTO_PASS_REASON} from './glossary-semantics.js'
import {encodeGlossaryUnit,verifyModelInputs,captureModelOutput,watchGlossaryProviderFailure,compatibleGlossaryPrompt,QUOTA_ABORT_WINDOW_MS,createQuotaAbortTracker,TIMEOUT_ABORT_WINDOW_MS,createTimeoutAbortTracker,formatQuotaExhaustedMessage} from './glossary-transport.js'
import {assembleReviewAudit,applyReviewAudit,reviewAuditDirectory,assertReviewInputs} from './review-audit.js'

const VERSION=4,RUN_VERSION=3,DEFAULT_ANALYSIS_MAX_CHARS=3200
const PROMPTS={analysis:new URL('../../prompts/glossary-analysis.txt',import.meta.url),consolidation:new URL('../../prompts/glossary-consolidation.txt',import.meta.url)}
export const normalTerm=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()
const exact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim()
const same=(a,b)=>exact(a)===exact(b)
const key=(language,src)=>language+':'+normalTerm(src)
const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}}
async function atomic(file,value){
 await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp'
 try{await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(tmp,file)}finally{await fs.unlink(tmp).catch(()=>{})}
}
const termIn=(text,term)=>{
 const normalized=normalTerm(term),escaped=normalized.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/ /g,'\\s+'),cjk=/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(normalized)
 return new RegExp((cjk?'':'(?<![\\p{L}\\p{N}_])')+escaped+(cjk?'':'(?![\\p{L}\\p{N}_])'),'iu').test(normalTerm(text))
}
export async function glossaryPrompts(){return Object.fromEntries(await Promise.all(Object.entries(PROMPTS).map(async([kind,file])=>[kind,await fs.readFile(file,'utf8')])))}
const promptHashes=prompts=>Object.fromEntries(Object.entries(prompts).map(([kind,prompt])=>[kind,hash(prompt)]))
const modelRecord=status=>({name:status.model.name,model:status.model.model,thinking:status.model.thinking,threshold:status.model.threshold})

function reusableModel(previous,current){
 // Provider, model id and reasoning effort are provenance. They must not split
 // a run or block reuse; only the output budget can, and a larger one still counts.
 const strip=value=>{const {name,model,thinking,...rest}=value??{};return rest}
 const oldThreshold={...previous?.threshold},newThreshold={...current?.threshold},oldLimit=oldThreshold.output_token_limit,newLimit=newThreshold.output_token_limit
 delete oldThreshold.output_token_limit;delete newThreshold.output_token_limit
 return JSON.stringify({...strip(previous),threshold:oldThreshold})===JSON.stringify({...strip(current),threshold:newThreshold})&&(oldLimit===newLimit||Number.isFinite(oldLimit)&&Number.isFinite(newLimit)&&newLimit>=oldLimit)
}
function glossaryStateSignature({kind,units,prompt,cliVersion,outputTokenLimit}){
 const body={version:RUN_VERSION,kind,units,prompt,cliVersion}
 if(Number.isFinite(outputTokenLimit))body.outputTokenLimit=outputTokenLimit
 return hash(JSON.stringify(body))
}
function glossaryLegacySignature({kind,units,prompt,model,cliVersion}){
 return hash(JSON.stringify({version:RUN_VERSION,kind,units,prompt,model,cliVersion}))
}
function matchesGlossarySignature(stored,{kind,units,prompt,cliVersion,model}){
 const outputTokenLimit=model?.threshold?.output_token_limit
 return stored===glossaryStateSignature({kind,units,prompt,cliVersion,outputTokenLimit})||stored===glossaryStateSignature({kind,units,prompt,cliVersion})||(!!model&&stored===glossaryLegacySignature({kind,units,prompt,model,cliVersion}))
}

export function analysisUnits(source,maxChars=DEFAULT_ANALYSIS_MAX_CHARS){
 const blocks=markdownBlocks(source),units=[];let passages=[],size=0,hasNonHeading=false
 const flush=()=>{if(passages.length){units.push({unitId:'a-'+hash(JSON.stringify(passages)).slice(0,24)+'-'+units.length,passages});passages=[];size=0;hasNonHeading=false}}
 for(const block of blocks){
  if(block.type==='heading'&&block.level<=2&&hasNonHeading&&size>=Math.floor(maxChars*0.25))flush()
  const characters=Array.from(block.text)
  for(let start=0;start<characters.length;start+=maxChars){
   const text=characters.slice(start,start+maxChars).join('')
   if(size+text.length>maxChars)flush();passages.push({blockId:block.id,text});size+=text.length
   if(block.type!=='heading')hasNonHeading=true
  }
 }
 flush();if(!units.length)throw new Error('原文为空，不能完成术语分析');return {blocks,units}
}
export function normalizeCjkPunctuation(value){
 let s=String(value??'')
 if(!/[\u3400-\u9fff《》「」『』]/u.test(s))return s
 s=s.replace(/\.{3,}|…{2,}/gu,'……')
  .replace(/(?<=[\u3400-\u9fff》」』])\s*:\s*|\s*:\s*(?=[\u3400-\u9fff《「『])/gu,'：')
  .replace(/(?<=[\u3400-\u9fff》”」』])\s*\?(?=$|[》」』\s])|\?(?=[》」』])/gu,'？')
  .replace(/(?<=[\u3400-\u9fff》”」』])\s*!(?=$|[》」』\s])|!(?=[》」』])/gu,'！')
  .replace(/(?<=[\u3400-\u9fff》」』”])\s*,\s*(?=[\u3400-\u9fff《「『“])/gu,'，')
  .replace(/(?<=[\u3400-\u9fff》」』”])\s*;\s*(?=[\u3400-\u9fff《「『“])/gu,'；')
  .replace(/(?<=[\u3400-\u9fff》」』])\s*\(([^()]*)\)/gu,'（$1）')
 return s
}
function evidenceProjection(text){
 let value='',offsets=[]
 for(let start=0;start<text.length;){
  const char=String.fromCodePoint(text.codePointAt(start)),end=start+char.length
  for(const part of char.normalize('NFKC')){
   const normalized=/["“”「」]/u.test(part)?'"':/[‘’]/u.test(part)?"'":/\s/u.test(part)?' ':part
   if(normalized===' '&&value.endsWith(' ')){offsets[offsets.length-1].end=end;continue}
   value+=normalized;for(let i=0;i<normalized.length;i++)offsets.push({start,end})
  }
  start=end
 }
 return {value,offsets}
}
function deriveQuoteFromBlock(block,src){
 const pattern=src.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/['’‘]/gu,"['’‘]").replace(/\s+/g,'\\s+')
 const match=new RegExp(pattern,'iu').exec(block.text)
 const offset=match?.index??0,start=Math.max(0,offset-60)
 return block.text.slice(start,Math.min(block.text.length,offset+(match?.[0].length??src.length)+120))
}
function sourceEvidence(evidence,blocks,src){
 const block=blocks.find(b=>b.id===evidence?.blockId),hasQuote=evidence&&(typeof evidence.quote==='string'||typeof evidence.text==='string'),returned=typeof evidence?.quote==='string'?evidence.quote:evidence?.text
 if(!block||!termIn(block.text,src))return null
 if(!hasQuote||typeof returned!=='string'||!exact(returned)){
  const rest={...evidence};delete rest.text
  return {...rest,blockId:block.id,quote:deriveQuoteFromBlock(block,src),normalization:'derived-from-block'}
 }
 if(termIn(returned,src)){
  const source=evidenceProjection(block.text),quote=evidenceProjection(returned).value.trim(),start=quote?source.value.indexOf(quote):-1
  if(start>=0){
   const verbatim=block.text.slice(source.offsets[start].start,source.offsets[start+quote.length-1].end)
   return {...evidence,quote:verbatim,...(typeof evidence.quote==='string'?{}:{returnedField:'text'}),...(verbatim===returned?{}:{returnedQuote:returned,normalization:'source-verified-typography'})}
  }
 }
 const rest={...evidence};delete rest.text
 return {...rest,blockId:block.id,quote:deriveQuoteFromBlock(block,src),...(typeof evidence.quote==='string'?{}:{returnedField:'text'}),returnedQuote:returned,normalization:'derived-from-block'}
}
export function cleanCandidates(records,blocks){
 const kept=new Map(),dropped=[]
 for(const record of records)for(const item of record.terms??[]){
  const src=exact(item.src),dst=normalizeCjkPunctuation(exact(item.dst)),category=item.category,rawEvidence=item.evidence??(item.blockId?{blockId:item.blockId}:null),evidence=src?sourceEvidence(rawEvidence,blocks,src):null
  const sense=exact(item.sense??item.info??'')
  const nonTermReason=isNonTermSectionHeading(src)?'non-term-section-heading':/^(?:no change needed|unchanged|无需修改|无需更改)$/iu.test(dst)?'meta-placeholder-target':/^[A-Z][\p{L}'’.-]+(?:\s+(?:et al\.|&\s+[A-Z][\p{L}'’.-]+))?\s+\(?(?:1[5-9]\d{2}|20[0-2]\d)\)?$/u.test(src)?'author-year-citation':/^B\d+(?:[、,，\s-]+B\d+)*$/iu.test(src)?'block-reference':null
  const reason=!src||!dst?'empty-term':!/[\p{L}]/u.test(src)?'number-or-punctuation':!['concept','method','technical','institution','person','title'].includes(category)?'not-an-academic-term':nonTermReason?nonTermReason:!evidence?'unsupported-source-evidence':null
  if(reason){dropped.push({candidate:item,reason});continue}
  const id=normalTerm(src)+'|'+dst+'|'+sense,old=kept.get(id)
  if(old){if(!old.evidence.some(e=>e.blockId===evidence.blockId&&e.quote===evidence.quote))old.evidence.push(evidence);old.uncertain||=item.uncertain===true}
  else kept.set(id,{src,dst,category,sense:sense||category,uncertain:item.uncertain===true,evidence:[evidence]})
 }
 // Frequency and source-string length never decide whether a supported concept survives.
 return {terms:[...kept.values()],dropped}
}
function normalizePublic(entries){
 const groups=new Map()
 for(const e of entries){
  const src=exact(e.src),dst=exact(e.dst);if(!src||!dst)continue
  const language=e.language??'*',k=key(language,src),group=groups.get(k)??[]
  if(!group.some(p=>same(p.dst,dst)))group.push({...e,src,dst,language});groups.set(k,group)
 }
 const safe=[],ambiguous=[];for(const options of groups.values())if(options.length===1)safe.push(options[0]);else ambiguous.push({language:options[0].language,src:options[0].src,options})
 return {entries:safe,ambiguous}
}
export async function readDomainGlossary(root,domain){
 const cleanDomain=normalizeGlossaryDomains([domain])[0];if(!cleanDomain)throw new Error('领域术语库标识无效')
 const file=path.join(root,'.pipeline/glossaries/domains',`${cleanDomain}.json`),stored=await read(file,null)
 if(stored){if(stored.schemaVersion!==1||!Array.isArray(stored.entries)||!Array.isArray(stored.ambiguous))throw new Error(`领域术语库 (${cleanDomain}) 格式异常`);const canonical=normalizePublic(stored.entries);if(canonical.ambiguous.length)throw new Error(`领域术语库 (${cleanDomain}) 含重复冲突`);return {...stored,domain:cleanDomain,file}}
 return {schemaVersion:1,domain:cleanDomain,revision:`domain-empty-${cleanDomain}`,entries:[],ambiguous:[],file}
}
export async function readPublicGlossary(root,domains=[]){
 const file=path.join(root,'.pipeline/glossaries/common.json'),stored=await read(file,null)
 let base
 if(stored){if(stored.schemaVersion!==1||!Array.isArray(stored.entries)||!Array.isArray(stored.ambiguous))throw new Error('公共术语库格式异常，保留原件后核查');const canonical=normalizePublic(stored.entries);if(canonical.ambiguous.length)throw new Error('公共术语库含重复冲突，不能直接用于翻译');base={...stored,file}}
 else{
  const legacy=path.join(root,'lingua/glossaries/master_academic.json'),entries=await read(legacy,[])
  if(!Array.isArray(entries))throw new Error('原公共术语母表格式无效')
  const normalized=normalizePublic(entries)
  base={schemaVersion:1,revision:'seed-'+hash(JSON.stringify(entries)),...normalized,file,seed:{file:legacy,sha256:hash(JSON.stringify(entries))}}
 }
 const cleanDomains=normalizeGlossaryDomains(domains)
 if(!cleanDomains.length)return base
 const domainStores=await Promise.all(cleanDomains.map(d=>readDomainGlossary(root,d)))
 const merged=normalizePublic([...base.entries,...domainStores.flatMap(ds=>ds.entries.map(e=>({...e,_domain:ds.domain})))])
 const mergedAmbiguous=[...base.ambiguous,...domainStores.flatMap(ds=>ds.ambiguous),...merged.ambiguous]
 const compositeRevision=hash(base.revision+'|'+domainStores.map(ds=>`${ds.domain}:${ds.revision}`).join('|'))
 return {...base,revision:compositeRevision,entries:merged.entries,ambiguous:mergedAmbiguous,domains:cleanDomains}
}
export function planGlossary(common,cleaned,blocks,language){
 const observed=new Map(),candidates=new Map(),publicOptions=new Map()
 for(const term of common.entries.filter(e=>e.language==='*'||e.language===language)){
  if(!blocks.some(b=>termIn(b.text,term.src)))continue
  const k=normalTerm(term.src),old=observed.get(k)
  if(!old||term.language===language)observed.set(k,term)
 }
 for(const term of observed.values())publicOptions.set(normalTerm(term.src),[term])
 for(const group of common.ambiguous.filter(e=>e.language==='*'||e.language===language))if(blocks.some(b=>termIn(b.text,group.src)))publicOptions.set(normalTerm(group.src),group.options)
 for(const term of cleaned.terms){const k=normalTerm(term.src),group=candidates.get(k)??[];group.push(term);candidates.set(k,group)}
 const shared=[],overrides=[],additions=[],conflicts=[]
 for(const k of new Set([...publicOptions.keys(),...candidates.keys()])){
  const options=publicOptions.get(k)??[],proposed=candidates.get(k)??[],dst=new Set([...options,...proposed].map(e=>exact(e.dst)))
  if(dst.size>1||proposed.some(e=>e.uncertain)){
   const src=proposed[0]?.src??options[0].src
   const passages=blocks.filter(b=>termIn(b.text,src)).slice(0,6).map(b=>{
    const offset=normalTerm(b.text).indexOf(normalTerm(src)),start=Math.max(0,offset-200);return {blockId:b.id,text:b.text.slice(start,start+900)}
   })
   conflicts.push({unitId:'c-'+hash(language+':'+k).slice(0,24),term:src,publicOptions:options,candidates:proposed,passages});continue
  }
  const chosen=options[0]??proposed[0];if(!chosen)continue
  const entry={src:chosen.src,dst:chosen.dst,info:chosen.sense??chosen.info??'',language,contextualSenses:[...new Set(proposed.map(e=>e.sense))]}
  shared.push(entry);if(!options.length)additions.push(entry)
 }
 return {shared,overrides,additions,conflicts}
}

async function txtFiles(dir){
 const result=[];for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
  if(e.isSymbolicLink()||e.name.toLowerCase()==='bilingual'||e.name.includes('对照'))continue
  const file=path.join(dir,e.name);if(e.isDirectory())result.push(...await txtFiles(file));else if(e.name.endsWith('.txt'))result.push(file)
 }return result
}
function checkRecords(records,units){
 if(!Array.isArray(records)||records.length!==units.length||new Set(records.map(r=>r.unitId)).size!==units.length||units.some(u=>!records.some(r=>r.unitId===u.unitId)))throw new Error('LinguaGacha 术语结果缺失、重复或不属于当前原文')
 return records
}
function recoverableRecords(records,units){
 const expected=new Set(units.map(u=>u.unitId)),counts=new Map()
 for(const r of records)counts.set(r.unitId,(counts.get(r.unitId)??0)+1)
 return records.filter(r=>expected.has(r.unitId)&&counts.get(r.unitId)===1)
}
function decodeSimpleRecord(raw){
 const trimmed=raw.replace(/^[\s\u200b-\u200f\ufeff]+|[\s\u200b-\u200f\ufeff]+$/gu,''),body=trimmed.replace(/^```(?:json|jsonl|jsonline)?[ \t]*\r?\n/i,'').replace(/\r?\n```[ \t]*$/,'');let suffix=''
 try{const record=JSON.parse(body);return {record,repair:body===trimmed?null:{kind:'json-fence-only',rawSha256:hash(raw),correctedSha256:hash(body)}}}catch(original){
  if(!/[}\]]\s*$/.test(body))throw original
  const stack=[];let quoted=false,escaped=false
  for(const char of body){
   if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue}
   if(char==='"')quoted=true
   else if(char==='{')stack.push('}')
   else if(char==='[')stack.push(']')
   else if((char==='}'||char===']')&&stack.pop()!==char)throw original
  }
  if(quoted||escaped||!stack.length)throw original
  suffix=stack.reverse().join('');const corrected=body+suffix,record=JSON.parse(corrected)
  return {record,repair:{kind:'closing-containers-only',appended:suffix,rawSha256:hash(raw),correctedSha256:hash(corrected)}}
 }
}
const regexLiteral=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
function stringFieldsPreserved(value,raw,key=null){
 if(typeof value==='string'){
  if(key===null||value.length>50000)return false
  if(value===''&&new RegExp('"'+regexLiteral(key)+'"').test(raw))return true
  const literal=Array.from(value,char=>{
   const variants=[char,JSON.stringify(char).slice(1,-1)]
   if(char.length===1)variants.push('\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))
   if(char==='/')variants.push('\\/')
   if(char==='"')variants.push('"}"','"}','""')
   return '(?:'+[...new Set(variants)].map(regexLiteral).join('|')+')'
  }).join('')
  return new RegExp('"'+regexLiteral(key)+'"\\s*:\\s*"'+literal+'"','u').test(raw)
 }
 if(Array.isArray(value))return value.every(item=>stringFieldsPreserved(item,raw))
 return !value||typeof value!=='object'||Object.entries(value).every(([key,item])=>stringFieldsPreserved(item,raw,key))
}
export function decodeGlossaryRecord(raw){
 try{return decodeSimpleRecord(raw)}catch(original){
  const body=raw.replace(/^[\s\u200b-\u200f\ufeff]+|[\s\u200b-\u200f\ufeff]+$/gu,'').replace(/^```(?:json|jsonl|jsonline)?[ \t]*\r?\n/i,'').replace(/\r?\n```[ \t]*$/,'')
  if(!body.startsWith('{')||!/[}\]]$/.test(body)||/[\[,]\s*,/.test(body))throw original
  const normalized=body
    .replace(/:\s*""([^"\r\n]+)""(?=[\s,}\]])/g,':"\\"$1\\""')
    .replace(/,"([a-zA-Z0-9_-]+)",(?=")/g,',"$1":"",')
    .replace(/"quote"\s*:\s*"(.*?)"(?=\s*\}\})/gu,(m,quoteText)=>{const fixed=quoteText.replace(/\\"/g,'"').replace(/"/g,'\\"');return '"quote":"'+fixed+'"'})
    .replace(/"sense"\s*:\s*"(.*?)"(?=\s*,\s*"uncertain")/gu,(m,senseText)=>{const fixed=senseText.replace(/\\"/g,'"').replace(/"/g,'\\"');return '"sense":"'+fixed+'"'})
    .replace(/"\s*\}\s*\]\s*,\s*"uncertain"\s*:\s*(false|true)\s*,\s*"publicEligible"\s*:\s*(false|true)\s*\}\s*[\r\n]+\s*\{"members"/g,'","uncertain":$1,"publicEligible":$2},{"members"')
    .replace(/"\s*\}\s*\]\s*,\s*"uncertain"\s*:\s*(false|true)\s*,\s*"publicEligible"\s*:\s*(false|true)\s*\}\s*\]\s*\}/g,'","uncertain":$1,"publicEligible":$2}]}')
    .replace(/("\s*)\}\s*,\s*(?="uncertain")/g,'$1,')
    .replace(/"\}"(?=[^\s,\]}])/g,'"')
    .replace(/([^\s"{:,\[])"\}"(?=\s*[,\]}])/g,'$1""')
    .replace(/(?<=[:\[,]\s*)""(?=[^\s,:{}[\]"])/gu,'"\\"')
    .replace(/(?<=[^\s{}[\]:,])""(?=[,，]\s*[^"{\[\]\s])/gu,'\\"')
    .replace(/(?<=[^\s{}[\]:,])""(?=[^\s,:{}[\]])/gu,'\\"')

  let out=''
  let inString=false,escaped=false
  for(let i=0;i<normalized.length;i++){
   const ch=normalized[i]
   if(!inString){
    out+=ch
    if(ch==='"')inString=true
    continue
   }
   if(escaped){out+=ch;escaped=false;continue}
   if(ch==='\\'){out+=ch;escaped=true;continue}
   if(ch!=='"'){out+=ch;continue}
   const rest=normalized.slice(i+1)
   if(/^\s*:/.test(rest)){out+='"';inString=false;continue}
   if(rest.startsWith('"')){
    const afterDouble=rest.slice(1)
    if(/^\s*(?:[\}\]]|,\s*\{|,\s*"[a-zA-Z0-9_$-]+"\s*:|\s*$)/.test(afterDouble)){
     out+='\\"'
     continue
    }
    out+='\\"'
    continue
   }
   const match=/^\s*(?:[\}\]]|,\s*\{|,\s*"[a-zA-Z0-9_$-]+"\s*:|\s*$)/.exec(rest)
   if(match){
    out+='"'
    inString=false
    continue
   }
   out+='\\"'
  }

  let corrected,record
  try{corrected=jsonrepair(out);record=JSON.parse(corrected)}catch{throw original}
  const words=text=>text.replace(/[{}\[\],:"\\\s]/g,'')
  if(words(out)!==words(corrected)||!record||Array.isArray(record)||!stringFieldsPreserved(record,body))throw original
  return {record,repair:{kind:'json-syntax-only-string-fields-preserved',rawSha256:hash(raw),correctedSha256:hash(corrected)}}
 }
}
export function decodeGlossaryOutput(raw,{partial=false}={}){
 const decoded=[],repairs=[]
 const lines=raw.split(/\r?\n/)
 const chunks=[]
 let current=null
 for(const [index,line] of lines.entries()){
  const trimmed=line.trim()
  if(!trimmed)continue
  if(/^```(?:json|jsonl|jsonline)?\s*$/i.test(trimmed)){
   repairs.push({kind:'standalone-json-fence',line:index+1,rawSha256:hash(line)})
   continue
  }
  if(trimmed.startsWith('{"unitId"')||trimmed.startsWith('{"unitId":')){
   if(current)chunks.push(current)
   current={line:index+1,text:line}
  }else if(current){
   current.text+='\n'+line
  }else{
   chunks.push({line:index+1,text:line})
  }
 }
 if(current)chunks.push(current)

 for(const chunk of chunks){
  try{
   const result=decodeGlossaryRecord(chunk.text)
   decoded.push(result)
   if(result.repair)repairs.push({unitId:result.record.unitId,line:chunk.line,...result.repair})
  }catch(error){
   if(!partial)throw error
  }
 }
 return {decoded,repairs}
}
async function validatedCheckpoint(directory,signature){
 const saved=await read(path.join(directory,'checkpoint.json'),null)
 if(saved){
  if(saved.signature!==signature||hash(JSON.stringify(saved.records))!==saved.recordsSha256)throw new Error('术语恢复检查点摘要异常')
  for(const [relative,digest] of Object.entries(saved.artifacts))if(relative.split(path.sep).includes('..')||path.isAbsolute(relative)||hash(await fs.readFile(path.join(directory,relative)))!==digest)throw new Error('术语恢复证据变化')
 }
 return saved
}
export async function recoverGlossaryCheckpoint(directory,previous,kind,units,prompt,requestLog){
 const file=path.join(directory,'checkpoint.json'),saved=await validatedCheckpoint(directory,previous.signature)
 const transport=await verifyModelInputs(directory,previous,units,requestLog),verified=records=>records.filter(r=>transport.valid.has(r.unitId)),transportArtifact={[path.relative(directory,transport.file)]:hash(await fs.readFile(transport.file))}
 if(saved){
  checkRecords(saved.records,units.filter(u=>saved.records.some(r=>r.unitId===u.unitId)))
  if(saved.recoveredRun===previous.directory&&saved.sourceInputSha256===previous.inputSha256){const records=verified(saved.records),next={...saved,records,recordsSha256:hash(JSON.stringify(records)),artifacts:{...saved.artifacts,...transportArtifact}};await atomic(file,next);return next}
 }
 const input=path.join(previous.directory,kind+'.txt'),bytes=await fs.readFile(input)
 if(hash(bytes)!==previous.inputSha256||hash(prompt)!==previous.promptSha256)throw new Error('暂停分析的输入或提示词摘要变化')
 const requested=bytes.toString().trim().split(/\r?\n/).map(JSON.parse),expected=new Map(requested.map(u=>[u.unitId,JSON.stringify(u)]))
 const rawFiles=await txtFiles(path.join(previous.directory,'output')),events=await fs.readFile(path.join(previous.directory,'events.jsonl'),'utf8').catch(()=>'')
 // CLI completion also occurs when individual items failed. Recover only
 // source-verified native responses, regardless of the process exit status.
 const modelOutput=await captureModelOutput(previous,requested,requestLog,{partial:true})
 if(modelOutput){
  const {decoded,repairs}=decodeGlossaryOutput(modelOutput.raw,{partial:true}),parsed=decoded.map(x=>x.record)
  const recoverable=recoverableRecords(parsed,requested)
  const fresh=verified(recoverable.filter(r=>kind!=='analysis'||Array.isArray(r.terms))),records=verified(units.map(u=>[...(saved?.records??[]),...fresh].find(r=>r.unitId===u.unitId)).filter(Boolean))
  if(fresh.length){
  checkRecords(records,units.filter(u=>records.some(r=>r.unitId===u.unitId)))
  await atomic(path.join(previous.directory,'receipt.json'),previous)
  const artifacts={...saved?.artifacts,...transportArtifact};for(const p of [...rawFiles,modelOutput.file,modelOutput.evidenceFile,input,path.join(previous.directory,'prompt.txt'),...(events?[path.join(previous.directory,'events.jsonl')]:[]),path.join(previous.directory,'receipt.json')])artifacts[path.relative(directory,p)]=hash(await fs.readFile(p))
  const result={schemaVersion:1,signature:previous.signature,records,recordsSha256:hash(JSON.stringify(records)),artifacts,recoveredRun:previous.directory,sourceInputSha256:previous.inputSha256,repairs:[...saved?.repairs??[],...repairs],createdAt:new Date().toISOString()};await atomic(file,result);return result
  }
 }
 for(const entry of await fs.readdir(os.tmpdir(),{withFileTypes:true})){
  if(!entry.isDirectory()||!entry.name.startsWith('linguagacha-cli-'))continue
  let db
  try{
   const database=path.join(os.tmpdir(),entry.name,'cli-job.lg');db=new DatabaseSync(database,{readOnly:true})
   const created=Date.parse(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='created_at'").get().value)),started=Date.parse(previous.startedAt),ended=Date.parse(previous.endedAt)
   if(!Number.isFinite(created)||created<started-5000||created>ended)continue
   const rule=JSON.parse(db.prepare("SELECT data FROM rules WHERE type='translation_prompt'").get().data)
   if(rule.text.trim()!==prompt.trim())continue
   const items=db.prepare('SELECT data FROM items').all().map(r=>JSON.parse(r.data))
   if(items.length!==requested.length||items.some(i=>{const u=JSON.parse(i.src);return expected.get(u.unitId)!==JSON.stringify(u)}))continue
   const fresh=verified(items.filter(i=>i.status==='PROCESSED').flatMap(i=>{try{const r=decodeGlossaryRecord(i.dst).record;return r.unitId===JSON.parse(i.src).unitId?[r]:[]}catch{return []}}))
   if(!fresh.length||kind==='analysis'&&fresh.some(r=>!Array.isArray(r.terms)))continue
   const records=verified(units.map(u=>[...(saved?.records??[]),...fresh].find(r=>r.unitId===u.unitId)).filter(Boolean))
   checkRecords(records,units.filter(u=>records.some(r=>r.unitId===u.unitId)))
   const copy=path.join(previous.directory,'checkpoint.lg');await backup(db,copy)
   await atomic(path.join(previous.directory,'receipt.json'),previous)
   const artifacts={...saved?.artifacts,...transportArtifact};for(const p of [copy,input,path.join(previous.directory,'prompt.txt'),path.join(previous.directory,'receipt.json')])artifacts[path.relative(directory,p)]=hash(await fs.readFile(p))
   const result={schemaVersion:1,signature:previous.signature,records,recordsSha256:hash(JSON.stringify(records)),artifacts,recoveredRun:previous.directory,sourceInputSha256:previous.inputSha256,createdAt:new Date().toISOString()};await atomic(file,result);return result
  }catch(e){if(e.message?.includes('摘要')||e.message?.includes('恢复'))throw e}
  finally{db?.close()}
 }
 if(saved){const records=verified(saved.records),next={...saved,records,recordsSha256:hash(JSON.stringify(records)),artifacts:{...saved.artifacts,...transportArtifact}};await atomic(file,next);return next}return null
}
async function reuseCompatibleUnits(manager,t,directory,kind,units,prompt,status,signature){
 const parent=path.dirname(directory);let best=null
 for(const name of await fs.readdir(parent).catch(()=>[])){
  if(name===path.basename(directory))continue
  const other=path.join(parent,name),receiptFile=path.join(other,'receipt.json'),receiptBytes=await fs.readFile(receiptFile).catch(()=>null);if(!receiptBytes)continue
  const previous=JSON.parse(receiptBytes),inputFile=path.join(previous.directory,kind+'.txt'),inputBytes=await fs.readFile(inputFile).catch(()=>null);if(!inputBytes||hash(inputBytes)!==previous.inputSha256)continue
  const requested=inputBytes.toString().trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  let supplied=requested
  if(supplied.length!==previous.unitCount){
   if(!previous.transportFile)continue
   const proofBytes=await fs.readFile(previous.transportFile);if(hash(proofBytes)!==previous.transportSha256)throw new Error('可复用术语输入证明变化')
   supplied=JSON.parse(proofBytes).expectedUnits
   if(!Array.isArray(supplied)||requested.some(u=>!supplied.some(s=>JSON.stringify(s)===JSON.stringify(u))))continue
  }
  // A larger output allowance does not invalidate complete, source-verified results.
  // Keep their original model receipts rather than relabeling them as new-budget calls.
  const promptFile=path.join(previous.directory,'prompt.txt'),promptBytes=await fs.readFile(promptFile),previousPrompt=promptBytes.toString()
  if(hash(promptBytes)!==previous.promptSha256||!compatibleGlossaryPrompt(kind,previousPrompt,prompt))continue
  if(supplied.length!==previous.unitCount||!reusableModel(previous.model,modelRecord(status))||!matchesGlossarySignature(previous.signature,{kind,units:supplied,prompt:previousPrompt,cliVersion:status.version,model:previous.model}))continue
  const transport=await verifyModelInputs(other,previous,supplied,manager.glossaryRequestLog),files=[['receipt.json',receiptBytes],['input.txt',inputBytes],['prompt.txt',promptBytes],['transport-proof.json',await fs.readFile(transport.file)]];let records
  if(previous.status==='done'){
   const bytes=await fs.readFile(path.join(other,'records.json'));if(hash(bytes)!==previous.recordsSha256)throw new Error('可复用术语记录摘要变化')
   records=checkRecords(JSON.parse(bytes),supplied);files.push(['records.json',bytes])
   const raw=await fs.readFile(previous.rawFile);if(hash(raw)!==previous.rawSha256)throw new Error('可复用术语原始返回摘要变化');files.push(['raw-output.txt',raw])
  }else{
   const checkpoint=await recoverGlossaryCheckpoint(other,previous,kind,supplied,previousPrompt,manager.glossaryRequestLog);if(!checkpoint)continue;records=checkpoint.records;files.push(['checkpoint.json',Buffer.from(JSON.stringify(checkpoint))]);for(const relative of Object.keys(checkpoint.artifacts))files.push(['proof/'+relative,await fs.readFile(path.join(other,relative))])
  }
  const byId=new Map(supplied.map(u=>[u.unitId,JSON.stringify(u)])),selected=units.filter(u=>byId.get(u.unitId)===JSON.stringify(u)&&transport.valid.has(u.unitId)).map(u=>records.find(r=>r.unitId===u.unitId)).filter(Boolean)
  if(selected.length&&(!best||selected.length>best.records.length))best={records:selected,files,originSignature:previous.signature}
  if(best?.records.length===units.length)break
 }
 if(!best)return null
 const copy=path.join(directory,'reuse',best.originSignature),artifacts={};await fs.mkdir(copy,{recursive:true})
 for(const [name,bytes] of best.files){const file=path.join(copy,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{mode:0o600});artifacts[path.relative(directory,file)]=hash(bytes)}
 const checkpoint={schemaVersion:1,signature,sourceFingerprint:t.glossarySourceFingerprint,originSignature:best.originSignature,records:best.records,recordsSha256:hash(JSON.stringify(best.records)),artifacts,createdAt:new Date().toISOString()};await atomic(path.join(directory,'checkpoint.json'),checkpoint);return checkpoint
}
// Keep internal identities stable for provenance and legacy checkpoints; only
// the transport projection uses short request-local identifiers.
export function glossaryTransportUnits(kind,units){
 const blockIds=new Map(),reverseBlocks=new Map()
 const block=id=>{if(!blockIds.has(id)){const short='B'+String(blockIds.size+1).padStart(4,'0');blockIds.set(id,short);reverseBlocks.set(short,id)}return blockIds.get(id)}
 const maps=new Map()
 const projected=units.map((unit,i)=>{
  const unitId=(kind==='analysis'?'A':'G')+String(i+1).padStart(4,'0'),entries=new Map()
  maps.set(unitId,{unit,entries})
  if(kind==='analysis')return {unitId,passages:unit.passages.map(p=>({...p,blockId:block(p.blockId)}))}
  const neededContextIds=new Set()
  for(const entry of unit.entries??[])if(entry.conflict||entry.uncertain||entry.publicOnly)for(const e of entry.evidence??[])if(e.contextId)neededContextIds.add(e.contextId)
  const contexts=new Map()
  for(const c of unit.contexts??[])if(neededContextIds.has(c.contextId))contexts.set(c.contextId,'C'+String(contexts.size+1).padStart(3,'0'))
  const wireEntries=unit.entries.map((entry,j)=>{
   const shortId=entry.id??(j+1),entryId='E'+String(j+1).padStart(3,'0')
   entries.set(entryId,entry.entryId)
   if(!entry.conflict&&!entry.uncertain&&!entry.publicOnly)return {id:shortId,src:entry.src,dst:entry.dst,category:entry.category}
   return {
    id:shortId,src:entry.src,dst:entry.dst,category:entry.category,
    ...(entry.conflict?{conflict:true}:{}),
    ...(entry.uncertain?{uncertain:true}:{}),
    ...(entry.publicOnly?{publicOnly:true}:{}),
    ...(entry.proposals?.length?{proposals:entry.proposals}:{}),
    ...(entry.publicOptions?.length?{publicOptions:entry.publicOptions}:{}),
    evidence:(entry.evidence??[]).map(e=>({contextId:contexts.get(e.contextId)})).filter(e=>e.contextId),
   }
  })
  return {unitId,entries:wireEntries,contexts:(unit.contexts??[]).filter(c=>contexts.has(c.contextId)).map(c=>({...c,contextId:contexts.get(c.contextId),blockId:block(c.blockId)}))}
 })
 const restore=record=>{
  const map=maps.get(record.unitId);if(!map)return record
  const result=structuredClone(record);result.unitId=map.unit.unitId;if(kind==='consolidation')result.delta=true
  for(const term of result.terms??[]){if(term.blockId)term.blockId=reverseBlocks.get(term.blockId)??term.blockId;if(term.evidence?.blockId)term.evidence.blockId=reverseBlocks.get(term.evidence.blockId)??term.evidence.blockId}
  for(const group of result.groups??result.decisions??[])for(const member of group.members??[])if(member.entryId)member.entryId=map.entries.get(member.entryId)??member.entryId
  return result
 }
 return {units:projected,restore}
}
async function runUnits(manager,t,kind,units,prompt,status,options){
 let transport=glossaryTransportUnits(kind,units)
 // Continue an existing long-ID run with its exact prompt instead of spending
 // money to migrate it. Model identity is not part of the match; input or prompt changes still miss.
 const old=await read(t.glossaryRuns?.[kind]?.receiptFile??'',null).catch(()=>null)
 if(old?.directory){
  const oldPrompt=await fs.readFile(path.join(old.directory,'prompt.txt'),'utf8').catch(()=>null)
  if(oldPrompt&&hash(oldPrompt)===old.promptSha256&&compatibleGlossaryPrompt(kind,oldPrompt,prompt)&&matchesGlossarySignature(old.signature,{kind,units,prompt:oldPrompt,cliVersion:status.version,model:old.model})&&reusableModel(old.model,modelRecord(status))){transport={units,restore:r=>r}}
 }
 const adapted={...options,...(options.acceptRecord?{acceptRecord:(r,u)=>options.acceptRecord(transport.restore(r),units[transport.units.indexOf(u)])}:{})}
 return (await runUnitsAttempt(manager,t,kind,transport.units,prompt,status,adapted)).map(transport.restore)
}
async function runUnitsAttempt(manager,t,kind,units,prompt,status,options){
 if(!units.length){if(t.glossaryRuns)delete t.glossaryRuns[kind];return []}
 const signature=glossaryStateSignature({kind,units,prompt,cliVersion:status.version,outputTokenLimit:status.model?.threshold?.output_token_limit}),directory=path.join(manager.dir(t.id),'glossary',kind,signature),receiptFile=path.join(directory,'receipt.json')
 t.glossaryRuns={...t.glossaryRuns,[kind]:{directory,receiptFile}}
 const previous=await read(receiptFile,null),cachedFile=path.join(directory,'records.json')
 const rejected=['content_filter','timeout','output_limit'].includes(previous?.providerFailure?.reason)
 // 连续失败熔断：30 分钟内、最近一次成功之后连续失败达 10 次才停止；任何成功返回都会刷新计数
 const BREAKER_WINDOW_MS=30*60*1000,BREAKER_LIMIT=10,nowMs=Date.now(),history=[],seenFailDirs=new Set(),seenOkDirs=new Set(),runReceipts=[]
 for(const name of await fs.readdir(path.join(directory,'runs')).catch(()=>[])){
  const r=await read(path.join(directory,'runs',name,'receipt.json'),null).catch(()=>null)
  if(r)runReceipts.push({...r,_dir:r.directory??path.join(directory,'runs',name)})
 }
 runReceipts.sort((a,b)=>(Date.parse(a.startedAt??'')||0)-(Date.parse(b.startedAt??'')||0)||(Number(a.providerRetryCount)||0)-(Number(b.providerRetryCount)||0))
 const pushBreakerReceipt=(r,dirKey)=>{
  if(!r)return
  const failReason=['content_filter','timeout','output_limit'].includes(r?.providerFailure?.reason)
  const failAt=failReason?Date.parse(r?.providerFailure?.at??r?.endedAt??r?.startedAt??''):NaN
  const hasFail=Number.isFinite(failAt)&&nowMs-failAt<=BREAKER_WINDOW_MS&&(!dirKey||!seenFailDirs.has(dirKey))
  const okAt=Date.parse(r?.endedAt??r?.startedAt??'')
  const hasOk=Number.isFinite(okAt)&&nowMs-okAt<=BREAKER_WINDOW_MS&&(r?.cliStats?.completed>0||r?.status==='done')&&(!dirKey||!seenOkDirs.has(dirKey))
  if(hasOk&&dirKey)seenOkDirs.add(dirKey)
  if(hasFail&&dirKey)seenFailDirs.add(dirKey)
  if(hasOk&&hasFail){const startAt=Date.parse(r?.startedAt??'');history.push({at:Number.isFinite(startAt)?Math.min(startAt,failAt):Math.min(okAt,failAt),seq:history.length,ok:true});history.push({at:failAt,seq:history.length,ok:false})}
  else{if(hasOk)history.push({at:okAt,seq:history.length,ok:true});if(hasFail)history.push({at:failAt,seq:history.length,ok:false})}
 }
 for(const r of runReceipts)pushBreakerReceipt(r,r._dir)
 if(rejected)pushBreakerReceipt(previous,previous?.directory)
 history.sort((a,b)=>a.at-b.at||a.seq-b.seq)
 let retryCount=0
 for(const h of history)retryCount=h.ok?0:retryCount+1
 if(rejected){
  const prevAt=Date.parse(previous?.providerFailure?.at??previous?.endedAt??previous?.startedAt??'')
  const prevFresh=!Number.isFinite(prevAt)||nowMs-prevAt<=BREAKER_WINDOW_MS
  const okAfterPrev=Number.isFinite(prevAt)&&history.some(h=>h.ok&&h.at>=prevAt)
  if(prevFresh&&!okAfterPrev)retryCount=Math.max(retryCount,Number(previous?.providerRetryCount)||0)
 }
 if(rejected&&retryCount>=BREAKER_LIMIT){t.glossaryProgress={phase:kind,status:'blocked',providerRetry:retryCount,providerRetryLimit:BREAKER_LIMIT};throw new Error(`模型请求 30 分钟内连续失败 ${retryCount} 次且无成功返回，保留结果并停止；不再自动请求`)}
 if(previous?.status==='done'){
  const bytes=await fs.readFile(cachedFile);if(hash(bytes)!==previous.recordsSha256)throw new Error('已完成的术语结果摘要变化，保留原件后核查')
  if(hash(await fs.readFile(previous.rawFile))!==previous.rawSha256)throw new Error('已完成的术语原始返回摘要变化')
  if(previous.checkpointFile)await validatedCheckpoint(directory,signature)
  const transport=await verifyModelInputs(directory,previous,units,manager.glossaryRequestLog);await atomic(receiptFile,previous)
  if(transport.valid.size!==units.length)throw new Error('已有术语结果的实际模型输入未通过校验，不能采用')
  const records=checkRecords(JSON.parse(bytes),units)
  if(!(options.retryErrors===true&&options.acceptRecord&&records.some(r=>!options.acceptRecord(r,units.find(u=>u.unitId===r.unitId)))))return records
 }
 if(previous&&options.retryErrors!==true)throw new Error('上次术语分析未完成，原始结果已保留；请显式重试，不自动重复请求')
 let checkpoint=previous?await recoverGlossaryCheckpoint(directory,previous,kind,units,prompt,manager.glossaryRequestLog):!previous?await reuseCompatibleUnits(manager,t,directory,kind,units,prompt,status,signature):null
 if(previous&&(checkpoint?.records.length??0)<units.length){
  const checkpointFile=path.join(directory,'checkpoint.json'),existing=await fs.readFile(checkpointFile).catch(()=>null)
  const sibling=await reuseCompatibleUnits(manager,t,directory,kind,units,prompt,status,signature)
  if((sibling?.records.length??0)>(checkpoint?.records.length??0))checkpoint=sibling
  else if(existing)await fs.writeFile(checkpointFile,existing)
 }
 if(checkpoint&&options.acceptRecord){const records=checkpoint.records.filter(r=>options.acceptRecord(r,units.find(u=>u.unitId===r.unitId)));checkpoint={...checkpoint,records,recordsSha256:hash(JSON.stringify(records))};await atomic(path.join(directory,'checkpoint.json'),checkpoint)}
 const reused=checkpoint?.records??[],pending=units.filter(u=>!reused.some(r=>r.unitId===u.unitId))
 if(previous)await atomic(path.join(previous.directory,'receipt.json'),previous)
 const run=path.join(directory,'runs',randomUUID()),output=path.join(run,'output'),input=path.join(run,kind+'.txt'),promptFile=path.join(run,'prompt.txt')
 await fs.mkdir(output,{recursive:true});await fs.writeFile(input,pending.map(encodeGlossaryUnit).join('\n')+'\n',{mode:0o600});await fs.writeFile(promptFile,prompt,{mode:0o600})
 const receipt={schemaVersion:1,status:'running',providerRetryCount:retryCount,providerRetryLimit:BREAKER_LIMIT,engine:'LinguaGacha',transport:'official-cli-custom-prompt',inputEncoding:'unicode-safe-json-v1',signature,directory:run,inputSha256:hash(await fs.readFile(input)),promptSha256:hash(prompt),model:modelRecord(status),startedAt:new Date().toISOString(),unitCount:units.length,requestedUnits:pending.length,reusedUnits:reused.length,partialResumeSupported:!!checkpoint,...(checkpoint?{checkpointFile:path.join(directory,'checkpoint.json')}: {})}
 await atomic(receiptFile,receipt);t.glossaryProgress={phase:kind,status:'running',units:units.length,providerRetry:receipt.providerRetryCount,providerRetryLimit:BREAKER_LIMIT};await manager.save(t)
 try{
  if(!pending.length){const proof=await verifyModelInputs(directory,receipt,units,manager.glossaryRequestLog);if(proof.valid.size!==units.length)throw new Error('复用术语的实际模型输入未通过校验');await atomic(cachedFile,reused);receipt.recordsSha256=hash(await fs.readFile(cachedFile));receipt.rawFile=receipt.checkpointFile;receipt.rawSha256=hash(await fs.readFile(receipt.rawFile));receipt.status='done';return reused}
  let finished=false
  await manager.locked('linguagacha-cli',async()=>{
   const current=await manager.cliStatus();if(hash(JSON.stringify(modelRecord(current)))!==hash(JSON.stringify(modelRecord(status))))throw new Error('术语分析模型已变化，未静默切换模型')
   if(manager.active.get(t.id)?.cancel)throw new Error('任务已停止')
   let providerFailure=null
   const terminateChild=()=>{
    const child=manager.active.get(t.id)?.child
    if(child){try{process.kill(-child.pid,'SIGTERM')}catch{};const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);timer.unref()}
   }
   const quotaTracker=createQuotaAbortTracker({model:status.model.model,initialCompleted:reused.length,windowMs:options?.quotaWindowMs??manager.quotaWindowMs??QUOTA_ABORT_WINDOW_MS,onAbort:quota=>{receipt.quotaFailure=quota;t.glossaryFailure={reason:'quota',...quota};terminateChild()}})
   const timeoutTracker=createTimeoutAbortTracker({initialCompleted:reused.length,windowMs:options?.timeoutWindowMs??manager.timeoutWindowMs??TIMEOUT_ABORT_WINDOW_MS,onAbort:failure=>{if(providerFailure||quotaTracker.aborted)return;providerFailure={...failure,at:failure.at??new Date().toISOString(),provider:status.model.model};t.glossaryFailure={...providerFailure,providerRetry:receipt.providerRetryCount};terminateChild()}})
   const stopWatching=await (manager.watchGlossaryProviderFailure??watchGlossaryProviderFailure)(failure=>{
    if(failure.reason==='quota'){quotaTracker.onFailure(failure);return}
    if(failure.reason==='timeout'){timeoutTracker.onFailure(failure);return}
    providerFailure={...failure,at:failure.at??new Date().toISOString(),provider:status.model.model};t.glossaryFailure={...providerFailure,providerRetry:receipt.providerRetryCount}
    terminateChild()
   },{units:pending,model:status.model.model})
   try{
   await manager.command(t,manager.cliExecutable,['--cli','translate','--input',input,'--output-dir',output,'--source-language',t.profile.language.toUpperCase(),'--target-language','ZH','--prompt',promptFile],{onLine:async line=>{
    await fs.appendFile(path.join(run,'events.jsonl'),line+'\n',{mode:0o600});let event;try{event=JSON.parse(line)}catch{return}
    if(event.type==='finished')finished=event.status==='done'
    if(event.type==='progress'){if(event.stats){receipt.cliStats=event.stats;if(Number.isFinite(event.stats.completed)){const totalDone=reused.length+event.stats.completed;quotaTracker.onProgress(totalDone);timeoutTracker.onProgress(totalDone)}}t.glossaryProgress={phase:kind,providerRetry:receipt.providerRetryCount,providerRetryLimit:BREAKER_LIMIT,...event,...(event.stats?{stats:{...event.stats,total:units.length,completed:reused.length+event.stats.completed,pending:Math.max(0,units.length-reused.length-event.stats.completed-(event.stats.failed??0)-(event.stats.skipped??0)),percent:100*(reused.length+event.stats.completed)/units.length},reusedUnits:reused.length}:{})};await manager.save(t)}
   }})
   if(timeoutTracker.aborted&&!providerFailure&&!quotaTracker.aborted){providerFailure={...timeoutTracker.aborted,at:timeoutTracker.aborted.at??new Date().toISOString(),provider:status.model.model};t.glossaryFailure={...providerFailure,providerRetry:receipt.providerRetryCount}}
   if(!providerFailure&&!quotaTracker.aborted&&timeoutTracker.pending&&!manager.active.get(t.id)?.cancel&&(!finished||(receipt.cliStats?.failed??0)>0||(receipt.cliStats?.pending??0)>0)){providerFailure={...timeoutTracker.pending,at:timeoutTracker.pending.at??new Date().toISOString(),provider:status.model.model};t.glossaryFailure={...providerFailure,providerRetry:receipt.providerRetryCount}}
   }catch(error){
    if(!quotaTracker.aborted&&!providerFailure&&timeoutTracker.pending&&!error.timedOut&&!manager.active.get(t.id)?.cancel){providerFailure={...timeoutTracker.pending,at:timeoutTracker.pending.at??new Date().toISOString(),provider:status.model.model};t.glossaryFailure={...providerFailure,providerRetry:receipt.providerRetryCount}}
    if(quotaTracker.aborted){receipt.quotaFailure=quotaTracker.aborted;error.code='GLOSSARY_PROVIDER_QUOTA'}else if(providerFailure){receipt.providerFailure=providerFailure;error.code='GLOSSARY_PROVIDER_RETRY';error.message=(providerFailure.reason==='timeout'?'模型请求超时':providerFailure.reason==='output_limit'?'模型输出达到长度上限':'模型返回 content_filter')+'，已保留完成结果；检查原因后可仅恢复未完成部分'}else if(error.timedOut){receipt.cliTimedOut=true;error.code='GLOSSARY_BATCH_INCOMPLETE'}throw error
   }
   finally{quotaTracker.close();timeoutTracker.close();stopWatching()}
   if(quotaTracker.aborted){receipt.quotaFailure=quotaTracker.aborted;const error=new Error('供应商额度用尽');error.code='GLOSSARY_PROVIDER_QUOTA';throw error}
   if(providerFailure){receipt.providerFailure=providerFailure;const error=new Error((providerFailure.reason==='timeout'?'模型请求超时':providerFailure.reason==='output_limit'?'模型输出达到长度上限':'模型返回 content_filter')+'，已保留完成结果；检查原因后可仅恢复未完成部分');error.code='GLOSSARY_PROVIDER_RETRY';throw error}

  })
  if(!finished)throw new Error('LinguaGacha 未报告术语分析完成')
  if(manager.active.get(t.id)?.cancel)throw new Error('任务已停止')
  const transport=await verifyModelInputs(directory,receipt,units,manager.glossaryRequestLog);if(transport.valid.size!==units.length)throw new Error('LinguaGacha 改变或遗漏了实际术语输入，原始返回保留但不能采用')
  if(receipt.cliStats?.failed>0||receipt.cliStats?.skipped>0||receipt.cliStats?.pending>0){const error=new Error(`术语批次未全部完成：成功 ${receipt.cliStats.completed??0}，失败 ${receipt.cliStats.failed??0}，跳过 ${receipt.cliStats.skipped??0}，待处理 ${receipt.cliStats.pending??0}；已保留原始返回，可恢复未完成部分`);error.code='GLOSSARY_BATCH_INCOMPLETE';throw error}
  const files=await txtFiles(output);if(files.length!==1)throw new Error('术语分析输出范围异常，保留原始文件')
  const modelOutput=await captureModelOutput(receipt,pending,manager.glossaryRequestLog),raw=modelOutput.raw,{decoded,repairs}=decodeGlossaryOutput(raw),fresh=checkRecords(decoded.map(x=>x.record),pending),records=checkRecords(units.map(u=>[...reused,...fresh].find(r=>r.unitId===u.unitId)),units)
  if(kind==='analysis'&&records.some(r=>!Array.isArray(r.terms)))throw new Error('术语分析结果缺少候选列表')
  receipt.repairsFile=path.join(run,'serialization-repairs.json');await atomic(receipt.repairsFile,repairs)
  await atomic(cachedFile,records);receipt.recordsSha256=hash(await fs.readFile(cachedFile));receipt.rawSha256=hash(raw);receipt.rawFile=modelOutput.file;receipt.modelOutputEvidenceFile=modelOutput.evidenceFile;receipt.exportFile=files[0];receipt.exportSha256=hash(await fs.readFile(files[0]));receipt.status='done';return records
 }catch(e){
  receipt.status=manager.active.get(t.id)?.cancel?'stopped':receipt.quotaFailure?'quota-exhausted':receipt.providerFailure?'provider-rejected':'error'
  // A CLI stopped mid-batch (watchdog, exit without "finished") is an incomplete
  // batch, not malformed model output; keep the resumable classification.
  const stats=receipt.cliStats,unfinished=stats&&(stats.pending>0||stats.failed>0||stats.skipped>0)
  receipt.errorCode=e.code??(receipt.cliTimedOut||unfinished?'GLOSSARY_BATCH_INCOMPLETE':'GLOSSARY_RESULT_INVALID')
  try{const partial=await captureModelOutput(receipt,pending,manager.glossaryRequestLog,{partial:true});if(partial){receipt.partialOutputFile=partial.file;receipt.partialOutputEvidenceFile=partial.evidenceFile;receipt.partialUnitsCaptured=partial.units}}catch(error){receipt.partialCaptureError=error.message}
  if(receipt.quotaFailure){
   const completedUnits=Math.min(units.length,reused.length+Math.max(receipt.partialUnitsCaptured??0,receipt.cliStats?.completed??0))
   e.code='GLOSSARY_PROVIDER_QUOTA';receipt.errorCode='GLOSSARY_PROVIDER_QUOTA'
   e.message=formatQuotaExhaustedMessage(status.model.model,receipt.quotaFailure.resetHint,completedUnits,units.length)
   t.glossaryFailure={reason:'quota',...receipt.quotaFailure,completedUnits,totalUnits:units.length}
  }
  receipt.error=String(e.message)
  // partialResumeSupported only says whether THIS run started from a checkpoint.
  // resumeAvailable tells the orchestrator whether retryErrors:true can reuse
  // the units captured here instead of repeating the whole batch.
  receipt.resumeAvailable=receipt.status==='quota-exhausted'?(reused.length+(receipt.partialUnitsCaptured??0))>0:(receipt.status==='error'&&(receipt.partialUnitsCaptured??0)>0||receipt.status==='provider-rejected'&&(receipt.providerRetryCount+1)<BREAKER_LIMIT)
  throw e
 }
 finally{receipt.endedAt=new Date().toISOString();if(!receipt.transportFile)try{await verifyModelInputs(directory,receipt,units,manager.glossaryRequestLog)}catch(error){receipt.transportAuditError=error.message}await atomic(path.join(run,'receipt.json'),receipt);await atomic(receiptFile,receipt)}
}

// Public admission happens only after joint review of the current translation and glossary.
export async function promoteReviewedGlossary(manager,t,review){
 await requireBookGlossary(manager,t)
 const directory=path.join(manager.dir(t.id),'glossary'),additions=await read(path.join(directory,'public-candidates.json'),[]),base=await readPublicGlossary(manager.root)
 const source=await fs.readFile(await manager.original(t)),target=await fs.readFile(t.translationPath??path.join(manager.dir(t.id),'translation/translated.md'))
 if(!t.translationReport?.passed||review?.status!=='pass'||review.sourceFingerprint!==hash(source)||review.targetFingerprint!==hash(target)||review.glossaryFingerprint!==t.glossaryReport.effectiveFingerprint||review.issuesFingerprint!==t.glossaryReport.issuesFingerprint)throw new Error('公共术语更新需要当前正文和术语的联合审校通过记录')
 if(!review.report||hash(await fs.readFile(review.report))!==review.reportFingerprint)throw new Error('联合审校报告已经变化')
 const dir=path.dirname(base.file);await fs.mkdir(dir,{recursive:true})
 const db=new DatabaseSync(path.join(dir,'write-lock.sqlite'));let acquired=false
 try{
  db.exec('PRAGMA busy_timeout=1000');db.exec('BEGIN IMMEDIATE');acquired=true
  const current=await readPublicGlossary(manager.root),entries=[...current.entries],index=new Map(entries.map(e=>[key(e.language,e.src),e])),skipped=[],added=[],domainAdded={},domainStores=new Map()
  const targetDomain=term=>term.semanticApproval?.tier==='domain'?normalizeGlossaryDomains([term.semanticApproval?.domain])[0]??'':''
  const loadDomain=async d=>{if(!domainStores.has(d)){const ds=await readDomainGlossary(manager.root,d);domainStores.set(d,{store:ds,entries:[...ds.entries],idx:new Map(ds.entries.map(e=>[key(e.language,e.src),e])),changed:false})}return domainStores.get(d)}
  for(const d of new Set(additions.map(targetDomain).filter(Boolean)))await loadDomain(d)
  const conflicts=new Set(additions.filter(term=>{
   const d=targetDomain(term),ds=d?domainStores.get(d):null
   const oldCommon=index.get(key(term.language,term.src))??index.get(key('*',term.src))
   const oldDom=ds?(ds.idx.get(key(term.language,term.src))??ds.idx.get(key('*',term.src))):null
   const ambCommon=current.ambiguous.some(g=>(g.language==='*'||g.language===term.language)&&normalTerm(g.src)===normalTerm(term.src))
   const ambDom=ds?ds.store.ambiguous.some(g=>(g.language==='*'||g.language===term.language)&&normalTerm(g.src)===normalTerm(term.src)):false
   return ambCommon||ambDom||(oldCommon&&!same(oldCommon.dst,term.dst))||(oldDom&&!same(oldDom.dst,term.dst))
  }).map(term=>term.conceptId))
  for(const term of additions){
   if(term.semanticApproval?.publicEligible!==true||!term.semanticApproval.reason)throw new Error('公共候选缺少可复用判定')
   if(isNonUniversalPublicTerm(term.src,term.dst)||String(term.info??'').includes(AUTO_PASS_REASON)){skipped.push({src:term.src,reason:'不符合公共术语普适性准入规则'});continue}
   if(conflicts.has(term.conceptId)){skipped.push({src:term.src,reason:'公共或领域库已有不同译名，整组保留本书用法'});continue}
   const dom=targetDomain(term),k=key(term.language,term.src),normCat=normalizeGlossaryCategory(term.category,'concept')
   const entry={...term,category:normCat,origin:{taskId:t.id,sourceFingerprint:t.glossarySourceFingerprint,reviewFingerprint:review.reportFingerprint,...(dom?{domain:dom}:{})}}
   if(dom){
    const ds=domainStores.get(dom),old=ds.idx.get(k)??ds.idx.get(key('*',term.src))
    if(!old){ds.entries.push(entry);ds.idx.set(k,entry);ds.changed=true;(domainAdded[dom]??=[]).push(term.src)}
   }else{
    const old=index.get(k)??index.get(key('*',term.src))
    if(!old){entries.push(entry);index.set(k,entry);added.push(term.src)}
   }
  }
  const next={schemaVersion:1,revision:hash(JSON.stringify({entries,ambiguous:current.ambiguous})),entries,ambiguous:current.ambiguous,seed:current.seed}
  if(added.length){
   const bytes=await fs.readFile(base.file).catch(()=>null)
   if(bytes){await fs.mkdir(path.join(dir,'history'),{recursive:true});await fs.writeFile(path.join(dir,'history',hash(bytes)+'.json'),bytes,{mode:0o600})}
   await atomic(base.file,next)
  }
  for(const [dom,ds] of domainStores.entries()){
   if(!ds.changed)continue
   const nextDom={schemaVersion:1,domain:dom,revision:hash(JSON.stringify({entries:ds.entries,ambiguous:ds.store.ambiguous})),entries:ds.entries,ambiguous:ds.store.ambiguous}
   const bytes=await fs.readFile(ds.store.file).catch(()=>null)
   if(bytes){await fs.mkdir(path.join(dir,'history'),{recursive:true});await fs.writeFile(path.join(dir,'history',hash(bytes)+'.json'),bytes,{mode:0o600})}
   await atomic(ds.store.file,nextDom)
  }
  db.exec('COMMIT');acquired=false
  const receipt={status:'reviewed',reviewFingerprint:review.reportFingerprint,glossaryFingerprint:review.glossaryFingerprint,added,domainAdded,skipped,revision:added.length?next.revision:current.revision,at:new Date().toISOString()}
  await atomic(path.join(directory,'public-promotion.json'),receipt);t.glossaryPublication=receipt;return receipt
 }finally{if(acquired)db.exec('ROLLBACK');db.close()}
}

export async function analyseBookGlossary(manager,t,options={}){
 if(t.stages.glossary?.state==='done'&&t.glossaryReport?.schemaVersion===VERSION&&!options.refreshGlossary)return requireBookGlossary(manager,t)
 if(t.input.type==='pdf')await manager.requireDone(t,'assemble')
 const sourceFile=await manager.original(t),source=await fs.readFile(sourceFile,'utf8'),language=t.profile?.language
 if(!/^[a-z]{2,3}$/.test(language??''))throw new Error('术语分析前须确认原文语言')
 const prompts=await glossaryPrompts(),status=await manager.cliStatus()
 if(!status.model?.credentialConfigured)throw new Error('LinguaGacha 当前模型缺少凭证，未启动术语分析')
 const approved=t.phaseApproval?.translationModel
 if(approved&&(status.model.name!==approved.name||status.model.model!==approved.model))throw new Error('术语与翻译模型已变化，请在面板重新选择并确认')
 if(t.profile.glossary_model&&t.profile.glossary_model!==status.model.model)throw new Error('术语模型与任务指定值不一致，未发送分析')
 const analysisMaxChars=options.analysisMaxChars??t.profile?.glossary_analysis_max_chars??manager.glossaryAnalysisMaxChars??DEFAULT_ANALYSIS_MAX_CHARS
 if(!Number.isInteger(analysisMaxChars)||analysisMaxChars<100)throw new Error('术语提取分块大小无效')
 const domains=normalizeGlossaryDomains(options.domains??t.glossaryDomains??t.profile?.glossary_domains??[])
 const directory=path.join(manager.dir(t.id),'glossary'),{blocks,units}=analysisUnits(source,analysisMaxChars),common=await readPublicGlossary(manager.root,domains)
 const previousFingerprint=t.glossaryReport?.effectiveFingerprint
 t.glossaryRuns=t.glossaryRuns??{};delete t.glossaryReport;delete t.glossaryPublication
 await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'source.md'),source,{mode:0o600});t.glossarySourceFingerprint=hash(source)
 const records=await runUnits(manager,t,'analysis',units,prompts.analysis,status,options)
 for(const r of records){
  const unit=units.find(u=>u.unitId===r.unitId)
  if(!unit)continue
  const unitBids=new Set(unit.passages.map(p=>p.blockId))
  r.terms=(r.terms||[]).filter(term=>{
   const bid=term.evidence?.blockId??term.blockId
   if(unitBids.has(bid))return true
   const quote=term.evidence?.quote||term.evidence?.text||''
   const matches=unit.passages.filter(p=>(quote&&p.text.includes(quote))||(term.src&&termIn(p.text,term.src))),unique=[...new Map(matches.map(p=>[p.blockId,p])).values()],match=unique.length===1?unique[0]:null
   if(match){
    if(term.evidence)term.evidence.blockId=match.blockId
    term.blockId=match.blockId
    return true
   }
   return false
  })
 }
 const structural=cleanCandidates(records,blocks),partitioned=partitionCleaningCandidates(structural,common,blocks,hash(source),language,24000,{source}),cleaningUnits=partitioned.units
 await atomic(path.join(directory,'structural-cleaned.json'),structural);await atomic(path.join(directory,'cleaning-inventory.json'),{units:cleaningUnits,autoPassCount:partitioned.autoPass.count});await atomic(path.join(directory,'auto-pass.json'),partitioned.autoPass)
 const empty={effective:[],overrides:[]},acceptRecord=(r,u)=>{try{applyConsolidation(u,r,empty,common,language);return true}catch{return false}}
 const groupRecords=await runUnits(manager,t,'consolidation',cleaningUnits,prompts.consolidation,status,{...options,acceptRecord})
 const parts=[...cleaningUnits.map(u=>applyConsolidation(u,groupRecords.find(r=>r.unitId===u.unitId),empty,common,language)),...(partitioned.autoPassUnit?[applyConsolidation(partitioned.autoPassUnit,{unitId:partitioned.autoPassUnit.unitId,delta:true,groups:[]},empty,common,language)]:[])]
 const result=Object.fromEntries(['shared','overrides','additions','effective','groups','rejected','unresolved'].map(k=>[k,parts.flatMap(p=>p[k])]))
 if(new Set(result.effective.map(e=>normalTerm(e.src))).size!==result.effective.length)throw new Error('合并术语表仍有重复冲突')
 const effectiveKeys=new Set(result.effective.map(e=>normalTerm(e.src))),cleaned={terms:structural.terms.filter(term=>effectiveKeys.has(normalTerm(term.src))),dropped:[...structural.dropped,...result.rejected.map(candidate=>({candidate,reason:candidate.reason,stage:'cleaning'}))]}
 const issues=result.unresolved
 if(hash(await fs.readFile(sourceFile))!==hash(source))throw new Error('术语分析期间原文变化，不能采用旧结果')
 if(manager.active.get(t.id)?.cancel)throw new Error('任务已停止')
 const files={'common-snapshot.json':result.shared,'book-overrides.json':result.overrides,'public-candidates.json':result.additions,'effective.json':result.effective,'semantic-groups.json':result.groups,'semantic-rejections.json':result.rejected,'review-issues.json':issues,'cleaned.json':cleaned}
 for(const [name,data] of Object.entries(files))await atomic(path.join(directory,name),data)
 const formal=path.join(manager.dir(t.id),'glossary.json'),old=await fs.readFile(formal).catch(()=>null)
 if(old){const history=path.join(directory,'history');await fs.mkdir(history,{recursive:true});await fs.writeFile(path.join(history,hash(old)+'.json'),old,{mode:0o600})}
 await atomic(formal,result.effective)
 if(previousFingerprint!==hash(await fs.readFile(formal))){delete t.stages.review;delete t.stages.publish;delete t.review;delete t.publication}
 const artifacts={};for(const name of [...Object.keys(files),'source.md','structural-cleaned.json','cleaning-inventory.json','auto-pass.json'])artifacts[name]=hash(await fs.readFile(path.join(directory,name)))
 for(const job of Object.values(t.glossaryRuns??{})){const r=await read(job.receiptFile,null);if(!r||r.status!=='done'||!r.transportVerified)throw new Error('术语分析缺少有效的完成或输入记录');const files=[job.receiptFile,path.join(job.directory,'records.json'),r.rawFile,r.transportFile,...(r.modelOutputEvidenceFile?[r.modelOutputEvidenceFile]:[]),...(r.exportFile?[r.exportFile]:[]),...(r.repairsFile?[r.repairsFile]:[])];if(r.checkpointFile){files.push(r.checkpointFile);const checkpoint=await read(r.checkpointFile,null);for(const rel of Object.keys(checkpoint.artifacts))files.push(path.join(job.directory,rel))}for(const file of files){const rel=path.relative(directory,file);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('术语记录路径异常');artifacts[rel]=hash(await fs.readFile(file))}}
 if(hash(await fs.readFile(sourceFile))!==hash(source))throw new Error('术语合并期间原文变化，须重新分析')
 const receipt={schemaVersion:VERSION,status:'complete',engine:'LinguaGacha',transportVerified:true,cleaningCompleted:true,semanticVerified:false,sourceFingerprint:hash(source),language,promptHashes:promptHashes(prompts),commonRevision:common.revision,publicMerge:'pending-joint-review',analysisMaxChars,analysisUnits:units.length,cleaningUnits:cleaningUnits.length,structuralCandidates:structural.terms.length,candidates:cleaned.terms.length,dropped:cleaned.dropped.length,autoPassedEntries:partitioned.autoPass.count,reviewedEntries:cleaningUnits.reduce((n,u)=>n+u.entries.length,0),semanticGroups:result.groups.length,reviewIssues:issues.length,issuesFingerprint:artifacts['review-issues.json'],overrides:result.overrides.length,effectiveTerms:result.effective.length,effectiveFingerprint:hash(await fs.readFile(formal)),artifacts,completedAt:new Date().toISOString()}
 await atomic(path.join(directory,'pipeline-receipt.json'),receipt);delete t.glossaryFailure;t.glossaryReport=receipt;t.glossaryProgress={phase:'complete',status:'done',terms:result.effective.length};return receipt
}

export async function requireBookGlossary(manager,t){
 const directory=path.join(manager.dir(t.id),'glossary'),receipt=await read(path.join(directory,'pipeline-receipt.json'),null),source=await fs.readFile(await manager.original(t),'utf8')
 if(t.stages.glossary?.state!=='done'||receipt?.schemaVersion!==VERSION||receipt.status!=='complete'||receipt.engine!=='LinguaGacha'||!receipt.transportVerified||!receipt.cleaningCompleted||!(receipt.sourceFingerprint===hash(source)||receipt.reviewedSource?.sourceFingerprint===hash(source)&&receipt.reviewedSource.originalFingerprint===receipt.sourceFingerprint&&receipt.reviewedSource.recordFingerprint===t.sourceRevision?.recordFingerprint&&receipt.reviewedSource.record===t.sourceRevision?.record)||receipt.language!==t.profile.language)throw new Error('翻译前必须完成当前原文的 LinguaGacha 全文提取及一次清洗归并；旧术语文件不能代替完整流程')
 if(['semantic-groups.json','semantic-rejections.json','review-issues.json','public-candidates.json','cleaning-inventory.json'].some(file=>!receipt.artifacts?.[file]))throw new Error('术语清洗缺少完整记录')
 if(hash(await fs.readFile(path.join(manager.dir(t.id),'glossary.json')))!==receipt.effectiveFingerprint)throw new Error('本书术语表已变化，请重新完成术语合并')
 for(const [name,digest]of Object.entries(receipt.artifacts).filter(([name])=>['effective.json','review-issues.json','public-candidates.json','book-overrides.json','common-snapshot.json','auto-pass.json'].includes(name)))if(path.isAbsolute(name)||name.split(path.sep).includes('..')||hash(await fs.readFile(path.join(directory,name)))!==digest)throw new Error('术语来源或合并记录变化，请重新核查')
 return receipt
}

export async function registerJointReview(manager,t,report){
 const auditDir=await reviewAuditDirectory(manager,t),snap=await read(path.join(auditDir,'snapshots.json'),null)
 const hasResults=snap&&(await fs.readdir(path.join(auditDir,'results')).catch(()=>[])).some(f=>f.endsWith('.json'))
 let reviewText=await fs.readFile(report,'utf8'),auditValidation=null
 const statusList=[...reviewText.matchAll(/<!-- dsh-review-status:([^\s]+) -->/g)].map(m=>m[1])
 let isPass=statusList.join(',')==='pass'
 if(hasResults){
  await assertReviewInputs(manager,t,auditDir)
  auditValidation=await assembleReviewAudit(manager,t,{auditDir})
  isPass=auditValidation.complete&&!auditValidation.unresolved.length&&statusList.every(status=>status==='pass')
  if(isPass)auditValidation=await applyReviewAudit(manager,t,{auditDir})
  // The host binds the report after verifying the captured request inputs.
  const targetPath=t.translationPath??path.join(manager.dir(t.id),'translation/translated.md')
  const tags=[`<!-- dsh-review-source:${hash(await fs.readFile(await manager.original(t)))} -->`,`<!-- dsh-review-target:${hash(await fs.readFile(targetPath))} -->`,...(t.glossaryReport?.effectiveFingerprint?[`<!-- dsh-review-glossary:${t.glossaryReport.effectiveFingerprint} -->`]:[]),...(t.glossaryReport?.issuesFingerprint?[`<!-- dsh-review-issues:${t.glossaryReport.issuesFingerprint} -->`]:[]),`<!-- dsh-review-status:${isPass?'pass':'needs-work'} -->`]
  reviewText=tags.join('\n')+'\n\n'+reviewText.replace(/<!--\s*dsh-review-[^>]+-->\s*/g,'').trim()+'\n'
  await fs.writeFile(report,reviewText,{mode:0o600})
 }
 const targetPath=t.translationPath??path.join(manager.dir(t.id),'translation/translated.md')
 const source=hash(await fs.readFile(await manager.original(t))),target=hash(await fs.readFile(targetPath))
 if(source!==t.translationReport?.sourceFingerprint||target!==t.translationReport?.targetFingerprint||!reviewText.includes('<!-- dsh-review-source:'+source+' -->')||!reviewText.includes('<!-- dsh-review-target:'+target+' -->'))throw new Error('审校报告缺少当前原文与译文指纹，请对照当前版本重新审校')
 const review={report,reportFingerprint:hash(reviewText),sourceFingerprint:source,targetFingerprint:target,semanticVerified:false,...(auditValidation?{auditValidation,audit:{applied:isPass&&Boolean(auditValidation.complete),patchCount:auditValidation.patchCount??0,glossaryDecisionCount:auditValidation.glossaryDecisionCount??0,validation:auditValidation}}:{}),message:'报告已登记，需阅读具体结论；公共术语尚未更新'}
 if(t.glossaryReport?.schemaVersion===VERSION){
  const receipt=await requireBookGlossary(manager,t)
  review.glossaryFingerprint=receipt.effectiveFingerprint;review.issuesFingerprint=receipt.issuesFingerprint
  if(!reviewText.includes('<!-- dsh-review-glossary:'+review.glossaryFingerprint+' -->')||!reviewText.includes('<!-- dsh-review-issues:'+review.issuesFingerprint+' -->'))throw new Error('联合审校报告须对应当前术语表及待核查记录')
  if(isPass){review.status='pass';review.semanticVerified=true;await promoteReviewedGlossary(manager,t,review);review.message='正文与术语联合审校通过，已处理可复用公共候选'}
  else{review.status='needs-work';delete t.glossaryPublication}
 }else if(isPass){
  review.status='pass'
  review.message='正文审校已通过并写入译文。当前任务没有现行术语流程回执，公共术语未另行更新。'
 }else if(auditValidation){
  review.status='needs-work'
  review.message='审校报告已登记，仍有未决问题。'
 }
 t.review=review;return review
}
