import {hash, markdownBlocks, checkMarkdownPair} from './markdown.js'
export const headingLabel=text=>text.replace(/^#+\s*/, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(_m,a,b)=>b??a).replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*`]/g,'').trim()
const normalize=text=>headingLabel(text).replace(/^#/,'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'')
// Generated front directories define chapters; heading levels inside chapters often come from OCR.
export function readerOutline(blocks){
 const duplicateIds=new Set()
 const titleKey=text=>normalize(headingLabel(text).replace(/^(?:[ivxlcdm]+[.、]\s*|[0-9]{1,2}(?:[.、]\s*|\s+))/i,''));for(let i=1;i<blocks.length;i++){const b=blocks[i],prev=blocks[i-1];if(b.type==='heading'&&prev.type==='heading'&&(normalize(b.text)===normalize(prev.text)||titleKey(b.text)===titleKey(prev.text)))duplicateIds.add(b.id);if(b.type==='heading'&&prev.type==='heading'&&/^(?:[ivxlcdm]+|\d+)$/i.test(headingLabel(b.text))&&blocks[i+1]?.type==='heading'&&titleKey(blocks[i+1].text)===titleKey(prev.text)){duplicateIds.add(b.id);duplicateIds.add(blocks[i+1].id)}}
 const directory=blocks.findIndex(b=>b.type==='heading'&&/^(目录|contents|table of contents|sommaire|inhaltsverzeichnis)$/i.test(headingLabel(b.text)))
 const hidden=new Set(duplicateIds),chapterIds=new Set(),links=[]
 if(directory>=0){hidden.add(blocks[directory].id);for(let i=directory+1;i<blocks.length&&blocks[i].type!=='heading';i++){const b=blocks[i];if(!/\[\[#|\]\(#/.test(b.text))break;hidden.add(b.id);for(const m of b.text.matchAll(/\[\[#([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(#([^)]+)\)/g)){let target=m[1]??m[4];try{target=decodeURIComponent(target)}catch{}const label=m[2]??m[3]??target;const found=blocks.slice(i+1).find(x=>x.type==='heading'&&(normalize(x.text)===normalize(target)||normalize(x.text).replace(/-/g,'')===normalize(target.replace(/-/g,' '))));if(found){chapterIds.add(found.id);links.push({id:found.id,label:headingLabel(label),level:1})}}}}
 if(links.length>30){const numbered=links.filter(x=>/^第[一二三四五六七八九十百零〇\d]+[章节部篇]|^(?:chapter|part)\s+[\divx]+/i.test(x.label));if(numbered.length>=3){const first=blocks.findIndex(x=>x.id===numbered[0].id);chapterIds.clear();for(const item of links){const index=blocks.findIndex(x=>x.id===item.id);if(numbered.includes(item)||index<first&&!/注释|notes|摘要/i.test(item.label)||/结论|结语|后记|附录|索引/.test(item.label))chapterIds.add(item.id)}}}
 if(!chapterIds.size){const headings=blocks.filter(b=>b.type==='heading'&&!hidden.has(b.id)),numbered=headings.filter(b=>/^(?:[0-9]{1,2}[.、]?\s+|[ivxlcdm]+[.、]\s+|第[一二三四五六七八九十百零〇\d]+[章节部篇]|(?:chapter|part)\s+[\divx]+)/i.test(headingLabel(b.text)));if(headings.length>30&&numbered.length>=3&&headings.filter(b=>b.level===1).length<=1){const first=blocks.indexOf(numbered[0]);for(const b of headings)if(numbered.includes(b)||blocks.indexOf(b)<first&&b.level!==1&&!/注释|notes/i.test(headingLabel(b.text))||/^(?:preface|introduction|acknowledgments|epilogue|conclusion|bibliography|index)$/i.test(headingLabel(b.text)))chapterIds.add(b.id)}}
 const headingBlocks=blocks.filter(b=>b.type==='heading'&&!hidden.has(b.id)),minimum=Math.min(...headingBlocks.filter((b,i)=>!(i===0&&b.level===1)).map(b=>b.level));const outline=[];let inChapter=false,lastLabel=''
 for(const b of blocks){if(b.type!=='heading'||hidden.has(b.id))continue;const label=headingLabel(b.text);if(!label||label===lastLabel)continue;lastLabel=label
  if(chapterIds.size){if(chapterIds.has(b.id)){inChapter=true;outline.push({id:b.id,label,level:1})}else if(inChapter)outline.push({id:b.id,label,level:Math.max(2,Math.min(4,b.level))})}
  else if(!(b===headingBlocks[0]&&b.level===1&&headingBlocks.length>1))outline.push({id:b.id,label,level:Math.max(1,b.level-minimum+1)})
 }
 return {outline,hiddenBlocks:[...hidden],directoryLinks:links}
}
export function enrichReading(doc){
 const source=doc.standaloneView==='translation'?(doc.originalBlocks??[]):doc.blocks,target=doc.standaloneView==='translation'?doc.blocks:doc.blocks.some(b=>b.translation)?doc.blocks.map(b=>({...b,text:b.translation??b.text})):null
 const markers=s=>[...s.matchAll(/\[\^[^\]]+\]/g)].map(m=>m[0]).sort().join('|');const paired=target&&source.length===target.length&&source.every((b,i)=>b.type===target[i].type&&(doc.explicitPairs||markers(b.text)===markers(target[i].text)))
 // Historical exports with removed paragraphs are deliberately not paired by array position.
 const outline=readerOutline(doc.blocks.map(b=>({...b,text:b.translation??b.text})));if(doc.metadata){const titles=doc.blocks.filter(b=>b.type==='heading'&&normalize(b.translation??b.text)===normalize(doc.title)).map(b=>b.id);outline.hiddenBlocks.push(...titles);outline.outline=outline.outline.filter(x=>!titles.includes(x.id))}
 return {...doc,...outline,originalOutline:readerOutline(source),comparisonAvailable:!!target&&!!source.length,alignment:paired?(doc.explicitPairs?'explicit-legacy-blocks':'structure-verified'):'unmatched',blocks:doc.blocks.map((b,i)=>({...b,...(paired?{sourceBlockId:source[i].id,sourceText:source[i].text}:{})})),version:doc.version??hash(source.map(b=>b.text).join('\n\n')+'|'+(target?.map(b=>b.text).join('\n\n')??''))}
}
export function replaceBlock(text,id,replacement){
 const blocks=markdownBlocks(text),b=blocks.find(x=>x.id===id);if(!b)throw new Error('段落已经变化，请重新打开编辑')
 if(typeof replacement!=='string'||!replacement.trim()||replacement.length>100000)throw new Error('段落须为1至100000字')
 const parsed=markdownBlocks(replacement);if(parsed.length!==1||parsed[0].type!==b.type||parsed[0].level!==b.level)throw new Error('勘误须保留当前段落结构；章节和段落拆分需另行处理')
 const lines=text.replace(/\r\n/g,'\n').split('\n');lines.splice(b.line-1,b.text.split('\n').length,...replacement.replace(/\r\n/g,'\n').split('\n'));let result=lines.join('\n');if(b.type==='heading'){const old=headingLabel(b.text),next=headingLabel(replacement);result=result.replace(/\[\[#([^\]|]+)(\|[^\]]+)?\]\]/g,(m,target,label)=>target===old?'[[#'+next+(label??'')+']]':m);const slug=s=>s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').replace(/\s+/g,'-');result=result.replace(/(\[[^\]]+\]\()#([^)]+)(\))/g,(m,start,target,end)=>{let decoded=target;try{decoded=decodeURIComponent(target)}catch{}return decoded===old||decoded===slug(old)?start+'#'+encodeURIComponent(slug(next))+end:m})}return result
}
