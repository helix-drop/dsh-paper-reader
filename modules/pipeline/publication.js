import fs from 'node:fs/promises'
import path from 'node:path'
import { hash, markdownBlocks, imageReferences } from './markdown.js'
import {loadSourceMap,sourceMapPath,taskSourcePdf,translationMapMatches} from './source-map.js'
export function bilingualMarkdown(source,target,withParts=false){
  const src=markdownBlocks(source),dst=markdownBlocks(target),headings=new Map()
  for(const i of src.map((_,i)=>i).sort((a,b)=>(src[a].level===2?0:1)-(src[b].level===2?0:1)))if(src[i].type==='heading'){const a=src[i].text.replace(/^#+\s*/,''),b=dst[i].text.replace(/^#+\s*/,'');const title=b+' | '+a;if(!headings.has(a))headings.set(a,title);if(!headings.has(b))headings.set(b,title)}
  const rewrite=s=>s.replace(/\[\[#([^\]|]+)(?:\|[^\]]*)?\]\]/g,(_,label)=>`[[#${(headings.get(label)??label).replace(/\|/g,'\\|')}]]`)
  const parts=src.map((s,i)=>{
    const d=dst[i]
    if(s.type==='heading')return '#'.repeat(s.level)+' '+d.text.replace(/^#+\s*/,'')+' | '+s.text.replace(/^#+\s*/,'')
    if(s.type==='footnote'||/^\[footnote-\d+\]/.test(s.text))return rewrite(d.text)+'\n\n'+rewrite(s.text).split('\n').map(line=>'    '+line).join('\n')
    const rd=rewrite(d.text),rs=rewrite(s.text)
    if(s.type==='code'||s.text===d.text||rd===rs)return rd
    return rd+'\n\n'+rs.split('\n').map(line=>'> '+line).join('\n')
  })
  const text=parts.join('\n\n')+'\n'
  return withParts?{text,parts}:text
}
export async function buildPublication(manager,t){
  const sourcePath=await manager.original(t),targetPath=t.translationPath??path.join(manager.dir(t.id),'translation/translated.md')
  if(!targetPath||!await fs.stat(targetPath).catch(()=>null)||!t.translationReport?.passed)throw new Error('先完成译文块对应校验')
  if(t.review?.status!=='pass')throw new Error('语义审校尚未通过，不能生成正式发布清单；待核查稿仍可读取')
  const source=await fs.readFile(sourcePath,'utf8'),target=await fs.readFile(targetPath,'utf8'),assets=new Map();if(t.translationReport.sourceFingerprint!==hash(source)||t.translationReport.targetFingerprint!==hash(target))throw new Error('阅读成品已变化，先重新校验译文')
  if(t.review?.sourceFingerprint!==hash(source)||t.review?.targetFingerprint!==hash(target)||!t.review.report||hash(await fs.readFile(t.review.report))!==t.review.reportFingerprint)throw new Error('语义审校报告与当前原文、译文不一致，请重新审校并登记报告')
  const sourceMap=await loadSourceMap(manager,sourcePath,source),targetMap=await loadSourceMap(manager,targetPath,target)
  if(sourceMap&&(!translationMapMatches(sourceMap,targetMap)))throw new Error('发布前需要完整保留原文与译文的来源映射')
  const portable=async(text,file)=>{
    let result=text
    for(const m of imageReferences(text)){
      const rel=m.reference
      if(/^[a-z]+:/i.test(rel)||path.isAbsolute(rel))throw new Error('发布附件只允许项目内相对路径')
      let decoded;try{decoded=decodeURIComponent(rel)}catch{throw new Error('附件路径编码无效')}
      const asset=await fs.realpath(path.resolve(path.dirname(file),decoded)).catch(async()=>{if(file===targetPath)return fs.realpath(path.resolve(path.dirname(sourcePath),decoded)).catch(async()=>{if(t.sourceRevision?.baseSource)return fs.realpath(path.resolve(path.dirname(t.sourceRevision.baseSource),decoded));throw new Error('阅读附件缺失')});if(t.sourceRevision?.baseSource)return fs.realpath(path.resolve(path.dirname(t.sourceRevision.baseSource),decoded)).catch(()=>{throw new Error('阅读附件缺失')});throw new Error('阅读附件缺失')})
      const roots=[manager.root,manager.readingRoot]
      if(!roots.some(root=>asset.startsWith(root+path.sep))||!(/\.(png|jpe?g|gif|webp|pdf)$/i.test(asset)))throw new Error('附件必须位于项目内且为图片或PDF')
      const bytes=await fs.readFile(asset),digest=hash(bytes),name='assets/'+digest.slice(0,20)+path.extname(asset).toLowerCase()
      assets.set(name,{bytes,source:asset});result=result.replace(m.text,m.text.replace(rel,name))
    }
    return result
  }
  const original=await portable(source,sourcePath),translation=await portable(target,targetPath)
  const bilingual=bilingualMarkdown(original,translation,true)
  const files=[{name:'原文.md',bytes:Buffer.from(original),source:sourcePath},{name:'译文.md',bytes:Buffer.from(translation),source:targetPath},{name:'双语.md',bytes:Buffer.from(bilingual.text),source:'generated-bilingual'}]
  const pdf=await taskSourcePdf(manager,t)
  if(pdf)files.push({name:'原始PDF.pdf',bytes:await fs.readFile(pdf),source:pdf})
  if(t.input.type==='pdf'){const normalized=path.join(manager.docDir(t),'source.pdf');files.push({name:'阅读底本.pdf',bytes:await fs.readFile(normalized),source:normalized})}
  if(sourceMap){
    // The published Markdown may rewrite attachment paths. Recompute its block hashes
    // while retaining source identities and original-PDF page ranges.
    for(const [name,text,map]of [['原文.md',original,sourceMap],['译文.md',translation,targetMap]]){
      const {pdfPath,...data}=map,parsed=markdownBlocks(text)
      if(parsed.length!==map.blocks.length)throw new Error('发布附件改写改变了段落结构')
      const portableMap={...data,markdownSha256:hash(text),pdf:{...data.pdf,file:'原始PDF.pdf'},blocks:map.blocks.map((b,i)=>({...b,markdownBlockId:parsed[i].id}))}
      if(map.view==='translation')portableMap.sourceMarkdownSha256=hash(original)
      // These maps are necessary reader attachments, explicitly requested by the user.
      files.push({name:path.basename(sourceMapPath(name)),bytes:Buffer.from(JSON.stringify(portableMap,null,2)+'\n'),source:sourceMapPath(map.view==='translation'?targetPath:sourcePath)})
    }
    let cursor=1
    const parts=bilingual.parts.map((text,i)=>{const start=cursor,end=start+text.split('\n').length-1;cursor=end+2;return {start,end,source:sourceMap.blocks[i]}})
    const occurrences=new Map(),blocks=markdownBlocks(bilingual.text).map(b=>{
      const part=parts.find(p=>p.start<=b.line&&b.line<=p.end);if(!part)throw new Error('双语 Markdown 缺少段落来源')
      const source=part.source,n=(occurrences.get(source.blockId)??0)+1;occurrences.set(source.blockId,n)
      return {...source,sourceBlockId:source.blockId,blockId:source.blockId+'-bi-'+n,markdownBlockId:b.id,type:b.type}
    })
    const {pdfPath,...data}=sourceMap
    files.push({name:'双语.md.source-map.json',source:'generated-bilingual-map',bytes:Buffer.from(JSON.stringify({...data,presentation:'bilingual',markdownSha256:hash(bilingual.text),sourceMarkdownSha256:hash(original),pdf:{...data.pdf,file:'原始PDF.pdf'},blocks},null,2)+'\n')})
  }
  for(const [name,entry]of assets)files.push({name,...entry})
  const bundle=path.join(manager.dir(t.id),'publication');await fs.mkdir(bundle,{recursive:true})
  const title=t.name.replace(/[\/\\:\0]/g,'_').replace(/^\.+/,'').trim();if(!title)throw new Error('发布目录名称无效')
  const destination=path.join(manager.publishRoot,title),manifest=[],prevPublished=t.publishedFiles??t.publication?.publishedFiles??{}
  for(const f of files){const output=path.join(bundle,f.name);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,f.bytes);const old=await fs.readFile(path.join(destination,f.name)).catch(()=>null),oldHash=old?hash(old):null,newHash=hash(f.bytes);manifest.push({name:f.name,sha256:newHash,source:f.source,bytes:f.bytes.length,conflict:!!oldHash&&oldHash!==newHash&&oldHash!==prevPublished[f.name]})}
  return {files:manifest,destination,bundle,validated:true,semanticVerified:false,published:false,publishedFiles:prevPublished,message:'阅读成品清单已生成；人工修改的同名文件不会覆盖'}
}
export async function commitPublication(manager,t,accepted){
  if(accepted!==true)throw new Error('请确认已查看校验与审校结论')
  const old=t.publication;if(!old?.validated)throw new Error('先生成发布清单')
  const fresh=await buildPublication(manager,t),prevPublished=t.publishedFiles??old?.publishedFiles??{}
  if(JSON.stringify(fresh.files.map(f=>[f.name,f.sha256]))!==JSON.stringify(old.files.map(f=>[f.name,f.sha256])))throw new Error('阅读成品已变化，请重新查看发布清单')
  if(fresh.files.some(f=>f.conflict))throw new Error('目标目录含不同内容的同名文件，已保留；请使用不同任务名称')
  const destination=path.resolve(fresh.destination),realRoot=await fs.realpath(manager.publishRoot).catch(async()=>{await fs.mkdir(manager.publishRoot,{recursive:true});return fs.realpath(manager.publishRoot)})
  await fs.mkdir(destination,{recursive:true});const realDest=await fs.realpath(destination);if(!realDest.startsWith(realRoot+path.sep))throw new Error('发布目标不能指向库外目录')
  const publishedFiles={...prevPublished}
  for(const f of fresh.files){const output=path.join(realDest,f.name);await fs.mkdir(path.dirname(output),{recursive:true});const parent=await fs.realpath(path.dirname(output));if(!parent.startsWith(realDest+path.sep)&&parent!==realDest)throw new Error('附件目录不能指向目标外部');const bytes=await fs.readFile(path.join(fresh.bundle,f.name));try{await fs.writeFile(output,bytes,{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e;const existingHash=hash(await fs.readFile(output));if(existingHash!==f.sha256&&existingHash!==prevPublished[f.name])throw new Error('目标文件发生变化，停止发布且保留已有内容');if(existingHash!==f.sha256)await fs.writeFile(output,bytes)}if(hash(await fs.readFile(output))!==f.sha256)throw new Error('发布后文件核验失败');publishedFiles[f.name]=f.sha256}
  t.publishedFiles=publishedFiles
  return {...fresh,published:true,acceptedByUser:true,publishedAt:new Date().toISOString(),publishedFiles}
}
