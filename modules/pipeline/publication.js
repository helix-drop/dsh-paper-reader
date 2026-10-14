import fs from 'node:fs/promises'
import path from 'node:path'
import { hash, markdownBlocks } from './markdown.js'
const imageRefs = text => [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)|!\[\[([^\]]+)\]\]/g)]
export function bilingualMarkdown(source,target){
  const src=markdownBlocks(source),dst=markdownBlocks(target),headings=new Map()
  for(let i=0;i<src.length;i++)if(src[i].type==='heading'){const a=src[i].text.replace(/^#+\s*/,''),b=dst[i].text.replace(/^#+\s*/,'');const title=b+' | '+a;headings.set(a,title);headings.set(b,title)}
  const rewrite=s=>s.replace(/\[\[#([^\]|]+)(?:\|[^\]]*)?\]\]/g,(_,label)=>`[[#${(headings.get(label)??label).replace(/\|/g,'\\|')}]]`)
  return src.map((s,i)=>{
    const d=dst[i]
    if(s.type==='heading')return '#'.repeat(s.level)+' '+d.text.replace(/^#+\s*/,'')+' | '+s.text.replace(/^#+\s*/,'')
    if(s.type==='footnote'||/^\[footnote-\d+\]/.test(s.text))return rewrite(d.text)+'\n\n'+rewrite(s.text).split('\n').map(line=>'    '+line).join('\n')
    if(s.type==='code'||s.text===d.text)return rewrite(d.text)
    return rewrite(d.text)+'\n\n'+rewrite(s.text).split('\n').map(line=>'> '+line).join('\n')
  }).join('\n\n')+'\n'
}
export async function buildPublication(manager,t){
  const sourcePath=await manager.original(t),targetPath=t.translationPath
  if(!targetPath||!t.translationReport?.passed)throw new Error('先完成译文块对应校验')
  const source=await fs.readFile(sourcePath,'utf8'),target=await fs.readFile(targetPath,'utf8'),assets=new Map();if(t.translationReport.sourceFingerprint!==hash(source)||t.translationReport.targetFingerprint!==hash(target))throw new Error('阅读成品已变化，先重新校验译文')
  const portable=async(text,file)=>{
    let result=text
    for(const m of imageRefs(text)){
      const rel=m[1]??m[2]
      if(/^[a-z]+:/i.test(rel)||path.isAbsolute(rel))throw new Error('发布附件只允许项目内相对路径')
      const asset=await fs.realpath(path.resolve(path.dirname(file),rel)).catch(()=>{throw new Error('阅读附件缺失')})
      const roots=[manager.root,manager.readingRoot]
      if(!roots.some(root=>asset.startsWith(root+path.sep))||!(/\.(png|jpe?g|gif|webp|pdf)$/i.test(asset)))throw new Error('附件必须位于项目内且为图片或PDF')
      const bytes=await fs.readFile(asset),digest=hash(bytes),name='assets/'+digest.slice(0,20)+path.extname(asset).toLowerCase()
      assets.set(name,{bytes,source:asset});result=result.replace(m[0],m[0].replace(rel,name))
    }
    return result
  }
  const original=await portable(source,sourcePath),translation=await portable(target,targetPath)
  const files=[{name:'原文.md',bytes:Buffer.from(original),source:sourcePath},{name:'译文.md',bytes:Buffer.from(translation),source:targetPath},{name:'双语.md',bytes:Buffer.from(bilingualMarkdown(original,translation)),source:'generated-bilingual'}]
  if(t.input.type==='pdf'){const pdf=path.join(manager.docDir(t),'source.pdf');files.push({name:'阅读底本.pdf',bytes:await fs.readFile(pdf),source:pdf})}
  for(const [name,entry]of assets)files.push({name,...entry})
  const bundle=path.join(manager.dir(t.id),'publication');await fs.mkdir(bundle,{recursive:true})
  const title=t.name.replace(/[\/\\:\0]/g,'_').replace(/^\.+/,'').trim();if(!title)throw new Error('发布目录名称无效')
  const destination=path.join(manager.publishRoot,title),manifest=[]
  for(const f of files){const output=path.join(bundle,f.name);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,f.bytes);const old=await fs.readFile(path.join(destination,f.name)).catch(()=>null);manifest.push({name:f.name,sha256:hash(f.bytes),source:f.source,bytes:f.bytes.length,conflict:!!old&&hash(old)!==hash(f.bytes)})}
  return {files:manifest,destination,bundle,validated:true,semanticVerified:false,published:false,message:'阅读成品清单已生成；人工修改的同名文件不会覆盖'}
}
export async function commitPublication(manager,t,accepted){
  if(accepted!==true)throw new Error('请确认已查看校验与审校结论')
  const old=t.publication;if(!old?.validated)throw new Error('先生成发布清单')
  const fresh=await buildPublication(manager,t)
  if(JSON.stringify(fresh.files.map(f=>[f.name,f.sha256]))!==JSON.stringify(old.files.map(f=>[f.name,f.sha256])))throw new Error('阅读成品已变化，请重新查看发布清单')
  if(fresh.files.some(f=>f.conflict))throw new Error('目标目录含不同内容的同名文件，已保留；请使用不同任务名称')
  const destination=path.resolve(fresh.destination),realRoot=await fs.realpath(manager.publishRoot).catch(async()=>{await fs.mkdir(manager.publishRoot,{recursive:true});return fs.realpath(manager.publishRoot)})
  await fs.mkdir(destination,{recursive:true});const realDest=await fs.realpath(destination);if(!realDest.startsWith(realRoot+path.sep))throw new Error('发布目标不能指向库外目录')
  for(const f of fresh.files){const output=path.join(realDest,f.name);await fs.mkdir(path.dirname(output),{recursive:true});const parent=await fs.realpath(path.dirname(output));if(!parent.startsWith(realDest+path.sep)&&parent!==realDest)throw new Error('附件目录不能指向目标外部');const bytes=await fs.readFile(path.join(fresh.bundle,f.name));try{await fs.writeFile(output,bytes,{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e;if(hash(await fs.readFile(output))!==f.sha256)throw new Error('目标文件发生变化，停止发布且保留已有内容')}if(hash(await fs.readFile(output))!==f.sha256)throw new Error('发布后文件核验失败')}
  return {...fresh,published:true,acceptedByUser:true,publishedAt:new Date().toISOString()}
}
