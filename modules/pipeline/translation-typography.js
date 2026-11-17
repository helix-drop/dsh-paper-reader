import {markdownBlocks} from './markdown.js'

// Apply only to parsed translation text, never JSON, source text or model receipts.
// Protect Markdown syntax and executable/literal examples while preserving every newline.
export function normalizeTranslationQuotes(text){
 if(!/[「」『』«"]/.test(text))return text
 const offsets=[0];for(const m of text.matchAll(/\n/g))offsets.push(m.index+1)
 const spans=markdownBlocks(text).filter(b=>b.type==='code').map(b=>[offsets[b.line-1],offsets[b.line-1+b.text.split('\n').length]??text.length])
 const syntax=/(`+)[\s\S]*?\1(?!`)|<!--[\s\S]*?-->|<[^>\n]+>|\]\((?:\\.|[^()\\\n]|\([^()\n]*\))*\)|^\[(?![^\]\n]*\^)[^\]\n]+\]:[^\n]*$|\[\^[^\]\n]+\]|\]\[[^\]\n]*\]|!?\[\[[^\]\n]+\]\]|https?:\/\/[^\s<>]+/gm
 for(const m of text.matchAll(syntax))spans.push([m.index,m.index+m[0].length])
 spans.sort((a,b)=>a[0]-b[0])
 const quotes={'「':'“','」':'”','『':'‘','』':'’'},convert=s=>s.replace(/[「」『』]/g,c=>quotes[c])
  .replace(/«[ \t]*([^«»\n]*?)[ \t]*»/g,(m,inner)=>/[\u4e00-\u9fff]/.test(inner)?'“'+inner+'”':m)
  .replace(/"([^"\n]*)"/g,(m,inner)=>/[\u4e00-\u9fff]/.test(inner)?'“'+inner+'”':m)
 let cursor=0,result=''
 for(const [start,end] of spans){if(end<=cursor)continue;result+=convert(text.slice(cursor,Math.max(cursor,start)))+text.slice(Math.max(cursor,start),end);cursor=end}
 return result+convert(text.slice(cursor))
}
export function quoteNormalizationRecord(before,after){
 return {policy:'chinese-quotes-v1',changedCharacters:(before.match(/[「」『』«»"]/g)??[]).length-(after.match(/[「」『』«»"]/g)??[]).length}
}
