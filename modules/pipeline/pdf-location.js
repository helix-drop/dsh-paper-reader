import fs from 'node:fs/promises'
import path from 'node:path'
import {loadSourceMap,translationMapMatches} from './source-map.js'
import {markdownBlocks} from './markdown.js'

const normalize=text=>String(text??'').replace(/\[\^[^\]]+\](?::)?/g,'').replace(/<[^>]*>/g,'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')
const cache=new Map()
export function locateSourceBlocks(blocks,pages){
  const indexed=pages.map(p=>({...p,text:normalize(p.text)}))
  return new Map(blocks.map(block=>{
    const text=normalize(block.text),minimum=block.type==='heading'?12:32
    if(text.length<minimum)return [block.id,null]
    const needle=text.slice(0,96),hits=indexed.filter(p=>p.text.includes(needle))
    const unique=[...new Set(hits.map(p=>p.page))]
    return [block.id,unique.length===1?unique[0]:null]
  }))
}
export async function attachPdfLocations(manager,t,doc){
  // A present but stale sidecar must never fall back to heuristic matching.
  if(manager.original){
    const file=t.legacy?(t.legacy.artifacts.original??t.legacy.artifacts.readingPath):await manager.original(t),text=await fs.readFile(file,'utf8')
    let map
    try{map=await loadSourceMap(manager,file,text)}catch(e){return {...doc,pdfLocationAvailable:false,pdfLocationWarning:e.message,blocks:doc.blocks.map(b=>({...b,pdfPage:null}))}}
    if(map){
      const originalText=doc.standaloneView==='translation'?doc.originalBlocks:doc.blocks
      const originalValid=originalText?.length===map.blocks.length&&originalText.every((b,i)=>b.id===map.blocks[i].markdownBlockId)
      let activeMap=map,translated=doc.standaloneView==='translation'||doc.blocks.some(b=>b.translation)
      if(translated){
        const targetFile=t.legacy?.artifacts?.translation??t.translationPath
        try{
          const targetText=targetFile?await fs.readFile(targetFile,'utf8'):null
          activeMap=targetText?await loadSourceMap(manager,targetFile,targetText):null
          const current=doc.blocks.map(b=>doc.standaloneView==='translation'?b.text:b.translation);if(targetText&&markdownBlocks(targetText).some((b,i)=>b.text!==current[i]))activeMap=null
          if(!translationMapMatches(map,activeMap))activeMap=null
        }catch{activeMap=null}
      }
      const activeIds=new Set(activeMap?.blocks.map(b=>b.blockId)??[]),sourceIndex=new Map(map.blocks.map(b=>[b.markdownBlockId,b])),targetIndex=new Map(activeMap?.blocks.map(b=>[b.markdownBlockId,b])??[])
      const located=b=>{
        const location=originalValid?(doc.standaloneView==='translation'?targetIndex.get(b.id):translated&&activeMap?(activeIds.has(sourceIndex.get(b.id)?.blockId)?sourceIndex.get(b.id):null):!translated?sourceIndex.get(b.id):null):null
        return {...b,originalPdfPage:originalValid?sourceIndex.get(b.id)?.pdfPages[0]??null:null,pdfPage:location?.pdfPages[0]??null,pdfPages:location?.pdfPages??[],sourceParagraphId:location?.blockId}
      }
      const blocks=doc.blocks.map(located)
      return {...doc,blocks,originalBlocks:doc.originalBlocks?.map(b=>({...b,pdfPage:originalValid?sourceIndex.get(b.id)?.pdfPages[0]??null:null})),sourceMapAvailable:true,sourceMapViews:{original:originalValid,translation:translated&&!!activeMap},pdfLocationAvailable:blocks.some(b=>b.pdfPage),pdfLocationWarning:!originalValid?'正文修订后来源映射需要重新核验':translated&&!activeMap?'译文尚无有效段落来源映射':null}
    }
  }
  if(!(t.legacy?.artifacts?.sourcePdf||t.input?.type==='pdf'))return doc
  const source=doc.standaloneView==='translation'?doc.originalBlocks??[]:doc.blocks
  let sourcePages=new Map()
  if(t.paperImport){sourcePages=new Map(source.map((b,i)=>[b.id,Number.isInteger((t.paperImport.pages??[])[i])&&(t.paperImport.pages??[])[i]>0?(t.paperImport.pages??[])[i]:null]))}
  else{
    const base=t.legacy?t.legacy.directory:manager.docDir(t),dir=path.join(base,'ai_convert/edits/body')
    const files=(await fs.readdir(dir).catch(()=>[])).filter(f=>/^page_\d+\.json$/.test(f)).sort()
    const stats=await Promise.all(files.map(async file=>{const st=await fs.stat(path.join(dir,file)).catch(()=>null);return file+':'+(st?st.size+':'+st.mtimeMs:'missing')}))
    const stamp=stats.join('|'),cached=cache.get(dir)
    let pages=cached?.stamp===stamp?cached.pages:null
    if(!pages){
      pages=await Promise.all(files.map(async file=>{
        let data;try{data=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'))}catch{return null}
        const page=data.book_page??Number(file.match(/\d+/)[0])
        const texts=[...(Array.isArray(data.paragraphs)?data.paragraphs:[]),...(Array.isArray(data.notes_definitions)?data.notes_definitions:[])].map(p=>p.text??'').join('\n')
        return {page,text:normalize(texts)}
      }));pages=pages.filter(Boolean);cache.set(dir,{stamp,pages});if(cache.size>16)cache.delete(cache.keys().next().value)
    }
    sourcePages=locateSourceBlocks(source,pages)
    if(!t.legacy){
      const profile=await fs.readFile(path.join(base,'document_profile.json'),'utf8').then(JSON.parse).catch(()=>({}))
      const mapping=new Map((profile.source_page_map??[]).map(p=>[p.logical_page,p.source_page]))
      // Without a scope map a normalized page cannot establish the original PDF page.
      sourcePages=new Map([...sourcePages].map(([id,page])=>[id,mapping.get(page)??null]))
    }
  }
  const clean=page=>Number.isInteger(page)&&page>0?page:null
  return {...doc,pdfLocationAvailable:[...sourcePages.values()].some(p=>clean(p)),
    originalBlocks:doc.originalBlocks?.map(b=>({...b,pdfPage:clean(sourcePages.get(b.id))})),
    blocks:doc.blocks.map(b=>({...b,pdfPage:clean(sourcePages.get(doc.standaloneView==='translation'?b.sourceBlockId:b.id))}))}
}
