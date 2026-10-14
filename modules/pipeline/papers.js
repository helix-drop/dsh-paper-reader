// Compatibility import only: historical JSON is evidence, Markdown uses the shared reader.
import fs from 'node:fs/promises'
import path from 'node:path'
import {hash,markdownBlocks} from './markdown.js'
import {fileStamp} from './storage.js'
const uuid=key=>{const s=hash(key);return `${s.slice(0,8)}-${s.slice(8,12)}-5${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`}
const numbered=text=>/^(\d+)\s*[—-]\s*([\s\S]*)$/.exec(text??'')
const supers='⁰¹²³⁴⁵⁶⁷⁸⁹'
export function paperMarkdown(doc){
 if(doc.status!=='done'||!Array.isArray(doc.blocks)||!doc.blocks.length)throw new Error('论文尚无完整阅读成品')
 const ids=new Set(),numbers=new Map(),warnings=[]
 for(const b of doc.blocks){if(typeof b.id!=='string'||!b.id||ids.has(b.id)||!/^[\w-]+$/.test(b.id))throw new Error('论文段落编号异常');ids.add(b.id);if(b.type==='footnote'){const n=numbered(b.text)?.[1];if(n)numbers.set(n,[...(numbers.get(n)??[]),b.id]);else warnings.push('历史注释 '+b.id+' 未采用数字注号，保留正文标记，需核验引用关系')}}
 const refs=text=>String(text).replace(/\((\d{1,2})\)|[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,(m,n)=>{n??=[...m].map(x=>supers.indexOf(x)).join('');const found=numbers.get(n);return found?.length===1?'[^legacy-'+found[0]+']':m})
 const render=(b,key)=>{const raw=b[key];if(typeof raw!=='string'||!raw.trim())throw new Error('论文缺少原文或译文：'+b.id);if(raw.includes('\n\n'))throw new Error('论文单块含多个段落，需单独核验：'+b.id)
  const text=b.type==='footnote'?numbered(raw)?.[2]??raw:refs(raw)
  if(b.type==='heading'||b.type==='subheading')return (b.type==='heading'?'## ':'### ')+text
  if(b.type==='footnote')return '[^legacy-'+b.id+']: '+text
  if(b.type==='quote')return text.split('\n').map(x=>'> '+x).join('\n')
  if(!['para','abstract'].includes(b.type))throw new Error('未支持的论文块类型：'+b.type)
  return text
 }
 const source=doc.blocks.map(b=>render(b,'source')).join('\n\n')+'\n',translation=doc.blocks.map(b=>render(b,'text')).join('\n\n')+'\n'
 const src=markdownBlocks(source),dst=markdownBlocks(translation)
 if(src.length!==doc.blocks.length||dst.length!==doc.blocks.length||src.some((b,i)=>b.type!==dst[i].type))throw new Error('论文块结构转换不一致')
 for(const [n,found] of numbers)if(found.length>1)warnings.push('历史注号 '+n+' 重复，保留原标记，不猜测注释归属')
 const orphan=doc.blocks.filter(b=>b.type==='footnote'&&translation.split('[^legacy-'+b.id+']').length<3).length;if(orphan)warnings.push('历史正文缺少可识别引用标记的注释共 '+orphan+' 条，保留注释，不猜测引用位置')
 return {source,translation,blockIds:doc.blocks.map(b=>b.id),pages:doc.blocks.map(b=>b.page??null),warnings}
}
export async function importLegacyPapers(manager){
 await manager.ensureIndex();const existing=await manager.index.papers(),results=[],skipped=[]
 for(const file of (await fs.readdir(manager.readingRoot).catch(()=>[])).filter(n=>/^[\w.\-一-鿿]+\.json$/.test(n)).sort()){
  const sourceFile=path.join(manager.readingRoot,file),stamp=await fileStamp(sourceFile),cached=existing.find(t=>t.paperImport.file===file);if(cached&&cached.paperImport.adapterVersion===2&&cached.paperImport.sourceStamp===stamp){results.push(cached.id);continue}let raw,doc;try{raw=await fs.readFile(sourceFile,'utf8');doc=JSON.parse(raw)}catch{skipped.push({file,reason:'JSON 无效'});continue}
  if(!Array.isArray(doc?.blocks)||doc.status!=='done')continue
  const key='paper:'+sourceFile,previous=existing.find(t=>t.legacy?.key===key)
  if(previous){if(previous.paperImport.fingerprint!==hash(raw))skipped.push({file,reason:'历史 JSON 已变化，保留已导入版本和修订，需人工核验新版本'});else if(previous.paperImport.adapterVersion!==2){previous.paperImport={...previous.paperImport,adapterVersion:2,sourceStamp:stamp,warnings:paperMarkdown(doc).warnings};await manager.save(previous)}results.push(previous.id);continue}
  try{
   const converted=paperMarkdown(doc),id=uuid(key),dir=path.join(manager.dir(id),'imported'),original=path.join(dir,'original.md'),translation=path.join(dir,'translated.md');await fs.mkdir(dir,{recursive:true})
   // Snapshot source evidence; never modify the original JSON, PDF or global glossary.
   await fs.writeFile(path.join(dir,'paper.json'),raw,{flag:'wx',mode:0o600});await fs.writeFile(original,converted.source,{flag:'wx',mode:0o600});await fs.writeFile(translation,converted.translation,{flag:'wx',mode:0o600})
   let sourcePdf=null;if(typeof doc.sourcePdf==='string'&&path.basename(doc.sourcePdf)===doc.sourcePdf){const candidate=path.join(manager.readingRoot,'src',doc.sourcePdf);if(await fileStamp(candidate))sourcePdf=candidate}
   const now=new Date().toISOString(),name=doc.title?.zh??doc.title?.source??doc.id??file
   const t={id,documentId:'paper:'+String(doc.id??file),name,documentTitle:name,kind:'paper',input:{type:'markdown',name:file,id:hash(sourceFile),fingerprint:hash(converted.source)},path:original,state:'legacy',stage:'publish',createdAt:now,bookmarks:[],log:[],stages:{},worker:{provider:'historical',model:'历史成品'},profile:{language:doc.sourceLanguage??'',document_type:'paper',confirmed:true},paperImport:{adapterVersion:2,file,sourceFile,sourceStamp:stamp,fingerprint:hash(raw),blockIds:converted.blockIds,pages:converted.pages,warnings:converted.warnings,metadata:{title:doc.title,author:doc.author,publication:doc.publication,pageCount:doc.pageCount},glossary:doc.glossary??[]},legacy:{key,directory:dir,caption:'已有论文成品',readingFingerprint:hash(converted.translation),resumeBlocked:false,artifacts:{original,translation,readingPath:translation,sourcePdf},progress:{models:[],budget:[],auditRecords:0},publicationEvidence:{historical:true,status:doc.status}},libraryProof:{kind:'legacy',readingPath:translation,readingStamp:await fileStamp(translation)}}
   await manager.save(t);results.push(id)
  }catch(e){skipped.push({file,reason:e.message})}
 }
 return {documents:results.length,ids:results,skipped}
}
