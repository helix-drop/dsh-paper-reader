import {normalizeTranslationQuotes,quoteNormalizationRecord} from './translation-typography.js'
import {alignFootnoteMarkers} from './translation-transport.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createReadStream} from 'node:fs'
import {randomUUID,createHash} from 'node:crypto'
import {hash,markdownBlocks,checkMarkdownPair} from './markdown.js'

export const sourceMapPath=file=>file+'.source-map.json'
const digestCache=new Map()
export async function fileDigest(file){
 const st=await fs.stat(file),stamp=[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':'),old=digestCache.get(file)
 if(old?.stamp===stamp)return old.hash
 const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes)
 const after=await fs.stat(file);if([after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':')!==stamp)throw new Error('核验指纹时文件发生变化')
 const value=digest.digest('hex');digestCache.set(file,{stamp,hash:value});if(digestCache.size>32)digestCache.delete(digestCache.keys().next().value)
 return value
}
export async function writeSourceMap(file,data){
 const output=sourceMapPath(file),temp=output+'.'+randomUUID()+'.tmp'
 try{await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await fs.rename(temp,output)}finally{await fs.unlink(temp).catch(()=>{})}
 return data
}
const ranges=pages=>pages.reduce((out,page)=>{const last=out.at(-1);if(last&&page===last[1]+1)last[1]=page;else out.push([page,page]);return out},[])
const numbers=values=>[...new Set(values)].sort((a,b)=>a-b)
const integer=value=>Number.isInteger(value)&&value>0
async function validateAssemblyInputs(directory,record,seen=new Set()){
 const root=await fs.realpath(directory)
 for(const input of record.inputs??[]){
  const file=await fs.realpath(path.resolve(directory,input.file))
  if(!file.startsWith(root+path.sep)||await fileDigest(file)!==input.sha256)throw new Error('装配来源文件已变化，请重新校验和装配')
  if(file.endsWith('.provenance.json')&&!seen.has(file)){seen.add(file);await validateAssemblyInputs(directory,JSON.parse(await fs.readFile(file,'utf8')),seen)}
 }
}
async function pdfReference(manager,file,reference){
 if(!reference||typeof reference.file!=='string'||!(/^[a-f0-9]{64}$/.test(reference.sha256??'')))throw new Error('来源映射缺少原 PDF 指纹')
 const pdf=await fs.realpath(path.resolve(path.dirname(file),reference.file))
 const roots=await Promise.all([manager.root,manager.readingRoot,manager.publishRoot].filter(Boolean).map(root=>fs.realpath(root).catch(()=>null)))
 if(!roots.some(root=>root&&pdf.startsWith(root+path.sep))||!(/\.pdf$/i.test(pdf)))throw new Error('来源映射的 PDF 必须位于阅读工作区或发布目录内')
 if(await fileDigest(pdf)!==reference.sha256)throw new Error('来源映射的原 PDF 已变化')
 return pdf
}
export async function validateSourceMap(manager,file,text,map){
 if(map?.schemaVersion!==1||!['original','translation'].includes(map.view)||map.markdownSha256!==hash(text)||!Array.isArray(map.blocks))throw new Error('来源映射与当前 Markdown 不一致')
 if(!integer(map.pdf?.totalPages))throw new Error('来源映射缺少原 PDF 总页数')
 const parsed=markdownBlocks(text)
 if(parsed.length!==map.blocks.length||new Set(map.blocks.map(b=>b.blockId)).size!==parsed.length)throw new Error('来源映射的段落标识缺失或重复')
 for(let i=0;i<parsed.length;i++){
  const b=map.blocks[i]
  if(b.markdownBlockId!==parsed[i].id||b.type!==parsed[i].type||!(/^[a-zA-Z0-9_-]{1,100}$/.test(b.blockId??''))||!Array.isArray(b.pdfPages)||b.pdfPages.some(p=>!integer(p)||p>map.pdf.totalPages)||!Array.isArray(b.sourcePids)||!Array.isArray(b.logicalPages)||b.logicalPages.some(p=>!integer(p))||!Array.isArray(b.regions)||JSON.stringify(b.pdfPages)!==JSON.stringify(numbers(b.pdfPages))||JSON.stringify(b.pdfPageRanges)!==JSON.stringify(ranges(b.pdfPages)))throw new Error('来源映射的段落或页码无效')
 }
 const pdfPath=await pdfReference(manager,file,map.pdf)
 return {...map,pdfPath}
}
export async function loadSourceMap(manager,file,text){
 let raw;try{raw=await fs.readFile(sourceMapPath(file),'utf8')}catch(e){if(e.code==='ENOENT')return null;throw e}
 return validateSourceMap(manager,file,text,JSON.parse(raw))
}
export function translationMapMatches(source,target){
 return !!target&&target.pairing==='explicit-block-id'&&target.sourceMarkdownSha256===source.markdownSha256&&target.pdf.sha256===source.pdf.sha256&&target.blocks.length===source.blocks.length&&target.blocks.every((b,i)=>{
  const original=source.blocks[i]
  return b.blockId===original.blockId&&['sourcePids','logicalPages','pdfPages','pdfPageRanges','regions'].every(key=>JSON.stringify(b[key])===JSON.stringify(original[key]))
 })
}
export async function buildSourceMap(manager,t){
 const file=await manager.original(t),text=await fs.readFile(file,'utf8')
 if(t.input.type!=='pdf')return loadSourceMap(manager,file,text)
 const doc=manager.docDir(t),profileFile=path.join(doc,'document_profile.json'),profileBytes=await fs.readFile(profileFile),profile=JSON.parse(profileBytes)
 const pdfHash=await fileDigest(t.path),normalizedHash=await fileDigest(path.join(doc,'source.pdf'))
 if(pdfHash!==t.input.fingerprint||pdfHash!==profile.original_fingerprint||normalizedHash!==profile.source_fingerprint)throw new Error('装配来源的 PDF 指纹不一致')
 const provenance=JSON.parse(await fs.readFile(file+'.provenance.json','utf8'))
 if(provenance.schemaVersion!==1||provenance.markdownSha256!==hash(text))throw new Error('装配来源记录已过期')
 await validateAssemblyInputs(doc,provenance)
 const pageMap=new Map((profile.source_page_map??[]).map(p=>[p.logical_page,p]))
 const seen=new Map(),blocks=markdownBlocks(text).map(b=>{
  const last=b.line+b.text.split('\n').length-1,spans=provenance.spans.filter(s=>s.startLine<=last&&s.endLine>=b.line)
  const sourcePids=[...new Map(spans.flatMap(s=>s.sourcePids.map(pid=>({chapter:s.chapterId,pid}))).map(p=>[p.chapter+':'+p.pid,p])).values()]
  const logicalPages=numbers(spans.flatMap(s=>s.logicalPages))
  if(logicalPages.some(p=>!pageMap.has(p)))throw new Error('段落缺少逻辑页到原 PDF 的映射')
  const regions=logicalPages.map(p=>pageMap.get(p)),pdfPages=numbers(regions.map(p=>p.source_page))
  const identity=hash(JSON.stringify({pdf:pdfHash,sourcePids,generated:!spans.length?b.id:undefined})),n=(seen.get(identity)??0)+1;seen.set(identity,n)
  return {blockId:'src-'+identity.slice(0,24)+'-'+n,markdownBlockId:b.id,type:b.type,sourcePids,logicalPages,pdfPages,pdfPageRanges:ranges(pdfPages),regions,generated:spans.length===0,unmappedReason:!spans.length?'generated-navigation-or-metadata':!pdfPages.length?'source-page-not-recorded':null}
 })
 const map={schemaVersion:1,view:'original',generator:'dsh-source-map-v1',markdownSha256:hash(text),pdf:{file:path.relative(path.dirname(file),t.path),sha256:pdfHash,totalPages:profile.original_total_pages},normalizedPdfSha256:normalizedHash,profileSha256:hash(profileBytes),assemblySha256:hash(JSON.stringify(provenance)),inputs:provenance.inputs,blocks}
 await validateSourceMap(manager,file,text,map);return writeSourceMap(file,map)
}

const marker=/<!--\s*dsh-block:([a-zA-Z0-9_-]+)\s*-->/g
export function translationInput(source,map){
 const blocks=markdownBlocks(source)
 if(map&&map.markdownSha256!==hash(source))throw new Error('翻译原文映射已过期')
 if([...source.matchAll(marker)].length)throw new Error('原文含有保留的段落标识')
 const sourceIds=blocks.map((b,i)=>map?.blocks[i]?.blockId??'md-'+b.id)
 const ids=blocks.map((_,i)=>'B'+String(i+1).padStart(4,'0'))
 // Put comments on an existing line so heading and footnote syntax is preserved.
 const lines=source.replace(/\r\n/g,'\n').split('\n')
 for(let i=blocks.length-1;i>=0;i--){const b=blocks[i],line=b.line-1;lines[line]+=' <!--dsh-block:'+ids[i]+'-->'}
 return {schemaVersion:2,text:lines.join('\n'),ids,sourceIds,sourceFingerprint:hash(source),annotatedFingerprint:hash(lines.join('\n'))}
}
function editDistance(a, b) {
 if (a === b) return 0
 const la = a.length, lb = b.length
 if (Math.abs(la - lb) > 3) return Math.max(la, lb)
 const d = Array.from({ length: la + 1 }, () => new Uint8Array(lb + 1))
 for (let i = 0; i <= la; i++) d[i][0] = i
 for (let j = 0; j <= lb; j++) d[0][j] = j
 for (let i = 1; i <= la; i++) {
  for (let j = 1; j <= lb; j++) {
   d[i][j] = Math.min(
    d[i - 1][j] + 1,
    d[i][j - 1] + 1,
    d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
   )
  }
 }
 return d[la][lb]
}

export function acceptTranslation(source,output,receipt,sourceMap){
 if(receipt.sourceFingerprint!==hash(source))throw new Error('翻译准备后的原文已变化')
 const marked=markdownBlocks(output),ids=marked.map(b=>[...b.text.matchAll(marker)].map(m=>m[1]))
 const knownIds = new Set(receipt.ids)
 if (receipt.schemaVersion!==2 && ids.length === receipt.ids.length) {
  for (let i = 0; i < ids.length; i++) {
   if (ids[i].length === 1 && ids[i][0] !== receipt.ids[i]) {
    const cur = ids[i][0]
    if (!knownIds.has(cur) && editDistance(cur, receipt.ids[i]) <= 2) {
     ids[i][0] = receipt.ids[i]
    }
   }
  }
 }
 if(ids.length!==receipt.ids.length||ids.some((id,i)=>id.length!==1||id[0]!==receipt.ids[i])||new Set(ids.flat()).size!==ids.length){
  if (ids.length !== receipt.ids.length) {
   throw new Error(`译文段落标识缺失、重复或顺序变化（原文 ${receipt.ids.length} 块，译文 ${ids.length} 块），保留原始输出等待核验`)
  }
  const mismatches = []
  for (let i = 0; i < ids.length; i++) {
   if (ids[i].length !== 1 || ids[i][0] !== receipt.ids[i]) {
    mismatches.push(`第 ${i + 1} 块期望 ${receipt.ids[i] ?? '无'}，实际为 ${ids[i].join(',') || '缺失'}`)
   }
  }
  const detail = mismatches.slice(0, 5).join('；') + (mismatches.length > 5 ? ` 等共 ${mismatches.length} 处` : '')
  throw new Error(`译文段落标识缺失、重复或顺序变化（${detail}），保留原始输出等待核验`)
 }
 const srcBlocks = markdownBlocks(source)
 if (srcBlocks.length === receipt.ids.length && marked.length === receipt.ids.length) {
  for (let i = 0; i < srcBlocks.length; i++) {
   marked[i].text = alignFootnoteMarkers(srcBlocks[i].text, marked[i].text)
  }
  output = marked.map(b => b.text).join('\n\n') + (output.endsWith('\n') ? '\n' : '')
 }
 const rawTarget=output.replace(/ <!--\s*dsh-block:([a-zA-Z0-9_-]+)\s*-->/g,'').replace(marker,'').replace(/\[\^+([a-zA-Z0-9_-]+)\]/g, '[^$1]').replace(/\[\^\[\^([a-zA-Z0-9_-]+)\]/g, '[^$1]').replace(/(?<!\[)\^([a-zA-Z0-9_-]+)\]/g, '[^$1]')
 const target=normalizeTranslationQuotes(rawTarget),typography=quoteNormalizationRecord(rawTarget,target)
 const check=checkMarkdownPair(source,target)
 const structuralErrors = check.errors.filter(e => e.includes('不能按位置配对') || e.includes('结构变化') || e.includes('附件路径变化'))
 if(structuralErrors.length) throw new Error(structuralErrors.join('；'))
 const sourceIds=receipt.sourceIds??receipt.ids
 if(sourceIds.length!==receipt.ids.length||sourceMap&&sourceIds.some((id,i)=>id!==sourceMap.blocks[i]?.blockId))throw new Error('翻译段落清单与来源映射不一致')
 const blocks=markdownBlocks(target).map((b,i)=>({...sourceMap?.blocks[i],blockId:sourceIds[i],markdownBlockId:b.id,type:b.type,sourceBlockId:sourceIds[i]}))
 return {target,check,blocks,typography}
}
export async function saveTranslationMap(manager,t,sourceFile,targetFile,source,target,blocks){
 const sourceMap=await loadSourceMap(manager,sourceFile,source)
 if(!sourceMap)return null
 const {pdfPath,...rest}=sourceMap
 const map={...rest,view:'translation',pairing:'explicit-block-id',sourceMarkdownSha256:hash(source),markdownSha256:hash(target),pdf:{...sourceMap.pdf,file:path.relative(path.dirname(targetFile),sourceMap.pdfPath)},blocks}
 await validateSourceMap(manager,targetFile,target,map);return writeSourceMap(targetFile,map)
}

export async function taskSourcePdf(manager,t){
 if(t.legacy?.artifacts?.sourcePdf)return t.legacy.artifacts.sourcePdf
 if(t.input.type==='pdf')return t.path
 const file=await manager.original(t),text=await fs.readFile(file,'utf8'),map=await loadSourceMap(manager,file,text)
 return map?.pdfPath??null
}
