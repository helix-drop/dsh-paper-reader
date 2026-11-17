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
export function translationChunks(source){
 const chunks=markdownBlocks(source).map(block=>({...block,ids:ids(block.text)}))
 if(chunks.some(b=>b.ids.length!==1)||new Set(chunks.map(b=>b.ids[0])).size!==chunks.length)throw new Error('翻译输入缺少唯一块编号')
 return chunks.map(({ids,...block})=>({...block,blockId:ids[0]}))
}
function validChunk(source,target){
 if(typeof target!=='string'||markdownBlocks(target).length!==1||JSON.stringify(ids(source))!==JSON.stringify(ids(target)))return false
 // A single paragraph can reference definitions held in a different chunk.
 return !checkMarkdownPair(source,target).errors.some(e=>!e.endsWith('脚注缺定义'))
}
export function recoverTranslationChunks(source,receipts,requests,cached=[]){
 const chunks=translationChunks(source),expected=new Map(chunks.map(b=>[b.text,b])),recovered=new Map()
 // LinguaGacha MD_V2 会剥去块首结构前缀（> 引用、- 列表、# 标题等），导致原生日志中的 src 与块文本不等。
 // 规范化回退匹配：剥掉块标识与行首结构前缀后比对；仅当规范化文本在所有块中唯一时才采用，避免串块。
 const normalizeBlock=text=>String(text).replace(/<!--\s*dsh-block:[a-zA-Z0-9_-]+\s*-->/g,'').split('\n').map(l=>l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]|\d+\.)\s+/,'').trimEnd()).join('\n').trim()
 const normalized=new Map()
 for(const b of chunks){const n=normalizeBlock(b.text);if(!n)continue;if(normalized.has(n))normalized.set(n,null);else normalized.set(n,b)}
 const prefixRe=/^\s*(?:>\s+|#{1,6}\s+|[-*+]\s+|\d+\.\s+)/
 // MD_V2 会剥去每行行首结构前缀；模型只回译被剥行导致译文缺前缀、校验按结构变化拒收。
 // 按行对齐补回：行数一致且译文该行无任何前缀时，补上原文该行的前缀。
 const restoreLinePrefixes=(srcText,dstText)=>{
  const srcLines=srcText.split('\n'),dstLines=String(dstText).split('\n')
  if(srcLines.length!==dstLines.length)return dstText
  let changed=false
  const out=dstLines.map((dl,i)=>{
   const sp=srcLines[i].match(prefixRe)?.[0]
   if(sp&&!prefixRe.test(dl)){changed=true;return sp+dl}
   return dl
  })
  return changed?out.join('\n'):dstText
 }
 const adopt=pair=>{
  let chunk=expected.get(pair.src),dst=pair.dst
  if(!chunk&&typeof pair.src==='string'){
   const hit=normalized.get(normalizeBlock(pair.src))
   if(hit){
    chunk=hit
    dst=restoreLinePrefixes(chunk.text,dst)
   }
  }
  if(chunk&&validChunk(chunk.text,dst))recovered.set(chunk.blockId,{...pair,dst})
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
 const chunks=translationChunks(source),values=new Map(recovered.map(pair=>[ids(pair.src)[0],pair.dst]))
 const expected=chunks.filter(b=>!values.has(b.blockId))
 if(!expected.length){
  const lines=source.replace(/\r\n/g,'\n').split('\n')
  for(const b of [...chunks].reverse())lines.splice(b.line-1,b.text.split('\n').length,values.get(b.blockId))
  return lines.join('\n')
 }
 const returned=translationChunks(output)
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
