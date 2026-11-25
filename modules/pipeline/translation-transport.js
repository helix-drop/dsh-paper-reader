import {markdownBlocks,checkMarkdownPair} from './markdown.js'

const ids=text=>[...text.matchAll(/<!--\s*dsh-block:([a-zA-Z0-9_-]+)\s*-->/g)].map(m=>m[1])
export function alignFootnoteMarkers(source, target) {
  if (typeof source !== 'string' || typeof target !== 'string') return target
  const srcAnchor = source.match(/^(\[\^[^\]]+\]:\s*)/)
  if (srcAnchor && !target.startsWith(srcAnchor[1])) {
    const srcHasNumber = /^\[\^[^\]]+\]:\s*\d+[.)]/.test(source)
    if (!srcHasNumber && /^\s*\d+[.)]\s*/.test(target)) {
      target = target.replace(/^\s*\d+[.)]\s*/, srcAnchor[1])
    } else {
      target = target.replace(/^(\[\^[^\]]+\]:\s*)?/, srcAnchor[1])
    }
  }
  const srcMarkers = [...source.matchAll(/\[\^([^\]]+)\]/g)].map(m => m[1])
  if (!srcMarkers.length) return target
  let result = target.replace(/\[\^+([a-zA-Z0-9_-]+)\]/g, '[^$1]').replace(/\[\^\[\^([a-zA-Z0-9_-]+)\]/g, '[^$1]').replace(/(?<!\[)\^([a-zA-Z0-9_-]+)\]/g, '[^$1]')
  for (const tag of srcMarkers) {
    const fullMarker = `[^${tag}]`
    if (result.includes(fullMarker)) continue
    const normalizedTag = tag.replace(/[-_]/g, '').toLowerCase()
    const existingMarkers = [...result.matchAll(/\[\^([^\]]+)\]/g)]
    let replaced = false
    for (const em of existingMarkers) {
      if (em[1].replace(/[-_]/g, '').toLowerCase() === normalizedTag) {
        result = result.replace(em[0], fullMarker)
        replaced = true
        break
      }
    }
    if (replaced) continue
    const markerIdx = source.indexOf(fullMarker)
    const beforeSrc = markerIdx !== -1 ? source.slice(0, markerIdx) : ''
    const commentMatch = result.match(/(\s*<!--\s*dsh-block:[^>]+-->\s*)$/)
    const comment = commentMatch ? commentMatch[1] : ''
    const body = commentMatch ? result.slice(0, commentMatch.index) : result
    let inserted = false
    const quoteMatch = beforeSrc.match(/(?:«|“|"|'|‘)([^»”"'’]{1,60})(?:»|”|"|'|’)\s*$/)
    if (quoteMatch) {
      const phrase = quoteMatch[1].trim()
      if (phrase.length >= 2) {
        const pIdx = body.indexOf(phrase)
        if (pIdx !== -1) {
          const afterP = body.slice(pIdx + phrase.length)
          const closeQuote = afterP.match(/^[»”"'’]?/)
          const insertPos = pIdx + phrase.length + (closeQuote ? closeQuote[0].length : 0)
          result = body.slice(0, insertPos) + fullMarker + body.slice(insertPos) + comment
          inserted = true
        }
      }
    }
    if (!inserted) {
      const emMatch = beforeSrc.match(/(?:\*|_)([^*_]{2,40})(?:\*|_)\s*$/)
      if (emMatch) {
        const phrase = emMatch[1].trim()
        const pIdx = body.indexOf(phrase)
        if (pIdx !== -1) {
          const afterP = body.slice(pIdx + phrase.length)
          const closeEm = afterP.match(/^(\*|_)?/)
          const insertPos = pIdx + phrase.length + (closeEm ? closeEm[0].length : 0)
          result = body.slice(0, insertPos) + fullMarker + body.slice(insertPos) + comment
          inserted = true
        }
      }
    }
    if (!inserted) {
      const wordMatch = beforeSrc.match(/([a-zA-ZÀ-ÿ]{3,})\s*$/)
      if (wordMatch) {
        const word = wordMatch[1]
        const wIdx = body.indexOf(word)
        if (wIdx !== -1) {
          const insertPos = wIdx + word.length
          result = body.slice(0, insertPos) + fullMarker + body.slice(insertPos) + comment
          inserted = true
        }
      }
    }
    if (!inserted) {
      const ratio = markerIdx !== -1 && source.length > 0 ? markerIdx / source.length : 0.8
      const targetPos = Math.round(ratio * body.length)
      const puncts = [...body.matchAll(/[，。；：！？、\.,;:!?]/g)]
      if (puncts.length) {
        puncts.sort((a, b) => Math.abs(a.index - targetPos) - Math.abs(b.index - targetPos))
        const bestPunct = puncts[0]
        const insertPos = bestPunct.index + bestPunct[0].length
        result = body.slice(0, insertPos) + fullMarker + body.slice(insertPos) + comment
        inserted = true
      } else {
        result = body + fullMarker + comment
        inserted = true
      }
    }
  }
  return result
}
export const alignFootnoteAnchor = alignFootnoteMarkers
export function translationChunks(source,label='翻译输入'){
 const chunks=markdownBlocks(source).map(block=>({...block,ids:ids(block.text)}))
 if(chunks.some(b=>b.ids.length!==1)||new Set(chunks.map(b=>b.ids[0])).size!==chunks.length)throw new Error(`${label}缺少唯一块编号`)
 return chunks.map(({ids,...block})=>({...block,blockId:ids[0]}))
}
function validChunk(source,target){
 if(typeof target!=='string'||markdownBlocks(target).length!==1||JSON.stringify(ids(source))!==JSON.stringify(ids(target)))return false
 // A single paragraph can reference definitions held in a different chunk.
 return !checkMarkdownPair(source,target).errors.some(e=>!e.endsWith('脚注缺定义'))
}
const normalizeBlockText=text=>String(text).replace(/<!--\s*dsh-block:[a-zA-Z0-9_-]+\s*-->/g,'').split('\n').map(l=>l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]|\d+\.)\s+/,'').trimEnd()).join('\n').trim()
const linePrefixRe=/^\s*(?:>\s+|#{1,6}\s+|[-*+]\s+|\d+\.\s+)/
function restoreLinePrefixes(srcText,dstText){
 const srcLines=srcText.split('\n'),dstLines=String(dstText).split('\n')
 if(srcLines.length!==dstLines.length)return dstText
 let changed=false
 const out=dstLines.map((dl,i)=>{
  const sp=srcLines[i].match(linePrefixRe)?.[0]
  if(sp&&!linePrefixRe.test(dl)){changed=true;return sp+dl}
  return dl
 })
 return changed?out.join('\n'):dstText
}
function attachBlockIdOnFirstLine(dstText,blockId){
 const lines=String(dstText).replace(/\r\n/g,'\n').split('\n')
 lines[0]+=` <!--dsh-block:${blockId}-->`
 return lines.join('\n')
}
export function restorePairVerifiedBlockIds(expectedChunks,rawOutput,requests=[],receipts=[]){
 if(typeof rawOutput!=='string'||!rawOutput.trim()||!expectedChunks?.length)return rawOutput
 const outBlocks=markdownBlocks(rawOutput)
 if(!outBlocks.some(b=>ids(b.text).length===0))return rawOutput
 const byExactSrc=new Map(expectedChunks.map(c=>[c.text,c])),byNormSrc=new Map()
 for(const c of expectedChunks){const n=normalizeBlockText(c.text);if(!n)continue;byNormSrc.set(n,byNormSrc.has(n)?null:c)}
 const ranges=receipts.map(r=>[Date.parse(r.startedAt),Date.parse(r.endedAt??new Date().toISOString())+5000]).filter(([s,e])=>Number.isFinite(s)&&Number.isFinite(e))
 const relevant=requests.map(request=>({request,time:Date.parse(request.ended_at??request.started_at)}))
  .filter(({time})=>!ranges.length||ranges.some(([start,end])=>time>=start&&time<=end))
  .sort((a,b)=>a.time-b.time)
 const canonDst=s=>String(s).normalize('NFKC').replace(/["“”'‘’「」『』]/gu,'"').replace(/\s+/g,' ').trim()
 const dstMap=new Map()
 const register=(rawDst,chunk)=>{
  const key=canonDst(rawDst)
  if(!key)return
  const prev=dstMap.get(key)
  dstMap.set(key,prev&&prev.blockId!==chunk.blockId?null:chunk)
 }
 for(const {request} of relevant){
  for(const pair of request.pairs??[]){
   if(typeof pair?.src!=='string'||typeof pair?.dst!=='string'||!pair.dst.trim()||ids(pair.dst).length!==0)continue
   const chunk=byExactSrc.get(pair.src)??byNormSrc.get(normalizeBlockText(pair.src))
   if(!chunk)continue
   register(pair.dst,chunk)
   register(restoreLinePrefixes(chunk.text,pair.dst),chunk)
  }
 }
 if(!dstMap.size)return rawOutput
 const lines=rawOutput.replace(/\r\n/g,'\n').split('\n')
 let changed=false
 for(let i=outBlocks.length-1;i>=0;i--){
  const b=outBlocks[i]
  if(ids(b.text).length!==0)continue
  const matched=dstMap.get(canonDst(b.text))
  if(!matched)continue
  if(outBlocks.length===expectedChunks.length&&matched.blockId!==expectedChunks[i].blockId)continue
  lines[b.line-1]+=` <!--dsh-block:${matched.blockId}-->`
  changed=true
 }
 return changed?lines.join('\n'):rawOutput
}
export function recoverTranslationChunks(source,receipts,requests,cached=[]){
 const chunks=translationChunks(source),expected=new Map(chunks.map(b=>[b.text,b])),recovered=new Map()
 // LinguaGacha MD_V2 会剥去块首结构前缀（> 引用、- 列表、# 标题等），导致原生日志中的 src 与块文本不等。
 // 规范化回退匹配：剥掉块标识与行首结构前缀后比对；仅当规范化文本在所有块中唯一时才采用，避免串块。
 const normalized=new Map()
 for(const b of chunks){const n=normalizeBlockText(b.text);if(!n)continue;if(normalized.has(n))normalized.set(n,null);else normalized.set(n,b)}
 const adopt=pair=>{
  if(!pair||typeof pair.src!=='string'||typeof pair.dst!=='string')return
  let chunk=expected.get(pair.src),dst=pair.dst
  if(!chunk){
   const hit=normalized.get(normalizeBlockText(pair.src))
   if(hit){
    chunk=hit
    dst=restoreLinePrefixes(chunk.text,dst)
   }
  }
  if(!chunk){
   const srcSubs=markdownBlocks(pair.src),dstSubs=markdownBlocks(pair.dst)
   if(srcSubs.length>1&&srcSubs.length===dstSubs.length){
    for(let i=0;i<srcSubs.length;i++)adopt({src:srcSubs[i].text,dst:dstSubs[i].text})
   }
   return
  }
  if(dst.trim()&&ids(dst).length===0&&markdownBlocks(dst).length===1){
   dst=attachBlockIdOnFirstLine(dst,chunk.blockId)
  }
  if(validChunk(chunk.text,dst))recovered.set(chunk.blockId,{...pair,src:chunk.text,dst})
 }
 for(const pair of cached)adopt(pair)
 const ranges=receipts.map(r=>[Date.parse(r.startedAt),Date.parse(r.endedAt)])
 const relevant=requests.map(request=>({request,time:Date.parse(request.ended_at??request.started_at)}))
  .filter(({time})=>ranges.some(([start,end])=>time>=start&&time<=end))
 for(const {request} of relevant.sort((a,b)=>a.time-b.time)){
  for(const pair of request.pairs??[])adopt(pair)
 }
 return {chunks,recovered:[...recovered.values()],pending:chunks.filter(b=>!recovered.has(b.blockId))}
}
export function assembleTranslationChunks(source,recovered,output){
 const chunks=translationChunks(source),values=new Map(recovered.map(pair=>[ids(pair.src)[0]??ids(pair.dst)[0],pair.dst]))
 const expected=chunks.filter(b=>!values.has(b.blockId))
 if(!expected.length){
  const lines=source.replace(/\r\n/g,'\n').split('\n')
  for(const b of [...chunks].reverse())lines.splice(b.line-1,b.text.split('\n').length,values.get(b.blockId))
  return lines.join('\n')
 }
 let returned
 try{
  returned=translationChunks(output,'增量译文返回')
 }catch(err){
  const outIds=new Set(markdownBlocks(output).flatMap(b=>ids(b.text)))
  const missing=expected.map(b=>b.blockId).filter(id=>!outIds.has(id))
  if(missing.length)throw new Error(`增量译文返回缺少唯一块编号（缺失块标识：${missing.slice(0,8).join('、')}${missing.length>8?` 等 ${missing.length} 块`:''}）`)
  throw err
 }
 if(expected.length!==returned.length||returned.some((b,i)=>b.blockId!==expected[i].blockId))throw new Error('增量翻译返回缺块、重复块或顺序变化，保留已有结果')
 for(let i=0;i<returned.length;i++){
  const target=alignFootnoteAnchor(expected[i].text,returned[i].text)
  if(!validChunk(expected[i].text,target))throw new Error('增量翻译结构或脚注变化，保留已有结果')
  values.set(returned[i].blockId,target)
 }
 const lines=source.replace(/\r\n/g,'\n').split('\n')
 for(const b of [...chunks].reverse())lines.splice(b.line-1,b.text.split('\n').length,values.get(b.blockId))
 return lines.join('\n')
}
