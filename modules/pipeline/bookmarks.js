import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
export const plainText=text=>String(text??'').replace(/^#{1,6}\s+/gm,'').replace(/!\[([^\]]*)\]\([^)]+\)/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\[\^([^\]]+)\](?::\s*)?/g,'').replace(/\[footnote-\d+\]\\[^\s]+\s*/g,'').replace(/[*`_]/g,'').replace(/\s+/g,' ').trim()
export function locateSelection(document, selection){
  selection=selection??{}
  const start=document.blocks.findIndex(b=>String(b.id)===String(selection.startBlockId))
  const end=document.blocks.findIndex(b=>String(b.id)===String(selection.endBlockId??selection.startBlockId))
  const view=selection.view==='translation'?'translation':'original'
  if(start<0||end<start)throw new Error('书签定位段落无效')
  const texts=document.blocks.slice(start,end+1).map(b=>plainText(view==='translation'?b.translation:b.text))
  if(texts.some(x=>!x))throw new Error('当前文本版本不可用')
  const span=texts.join(' '),exact=plainText(selection.exact)
  if(!exact||exact.length>20000)throw new Error('请选择不超过两万字的正文')
  let offset=span.indexOf(exact)
  if(offset<0)throw new Error('选中文字与当前文档不一致，请重新选择')
  if(selection.prefix){const match=plainText(selection.prefix);const hits=[];for(let i=span.indexOf(exact);i>=0;i=span.indexOf(exact,i+1))if(plainText(span.slice(0,i)).endsWith(match))hits.push(i);if(hits.length===1)offset=hits[0]}
  return {view,exact,offset,start,end,span,selector:{type:'TextQuoteSelector',view,startBlockId:String(selection.startBlockId),endBlockId:String(selection.endBlockId??selection.startBlockId),start:offset,end:offset+exact.length,exact,prefix:span.slice(Math.max(0,offset-80),offset),suffix:span.slice(offset+exact.length,offset+exact.length+80)}}
}
function sameSpan(item, located, documentId){
  const selector=item?.selector
  return item?.documentId===documentId&&selector?.view===located.view&&item.quote===located.exact&&selector.startBlockId===located.selector.startBlockId&&selector.endBlockId===located.selector.endBlockId&&selector.start===located.selector.start
}
export function quoteSlices(blocks, selector){
  if(!selector||selector.type!=='TextQuoteSelector'||!Array.isArray(blocks))return []
  const start=blocks.findIndex(b=>String(b.id)===String(selector.startBlockId))
  const end=blocks.findIndex(b=>String(b.id)===String(selector.endBlockId??selector.startBlockId))
  if(start<0||end<start)return []
  const view=selector.view==='translation'?'translation':'original'
  let cursor=0
  const slices=[]
  for(let i=start;i<=end;i++){
    const text=plainText(view==='translation'?blocks[i].translation:blocks[i].text)
    const from=Math.max(selector.start,cursor),to=Math.min(selector.end,cursor+text.length)
    if(from<to)slices.push({blockId:String(blocks[i].id),quote:text.slice(from-cursor,to-cursor)})
    cursor+=text.length+1
  }
  return slices.filter(s=>s.quote)
}
export class BookmarkStore {
  constructor(file){this.file=file;this.queue=Promise.resolve()}
  async read(){try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(value.schemaVersion!==1||!Array.isArray(value.bookmarks))throw new Error();return value}catch(e){if(e.code==='ENOENT')return{schemaVersion:1,documents:{},bookmarks:[],highlights:[],deleted:[]};throw new Error('书签数据格式异常，保留原文件')}}
  async change(fn){const job=this.queue.catch(()=>{}).then(async()=>{const state=await this.read(),value=await fn(state);await fs.mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(temp,this.file)}finally{await fs.unlink(temp).catch(()=>{})}return value});this.queue=job;return job}
  async add(document,args){return this.change(state=>{
    const located=locateSelection(document,args.selection??{}),now=new Date().toISOString()
    const style=['highlight','wave','line'].includes(args.style)?args.style:'highlight'
    const color=['gold','blue','green','pink','purple'].includes(args.color)?args.color:'gold'
    const mark={id:randomUUID(),documentId:document.id,source:document.source,documentVersion:document.version,quote:located.exact,comment:String(args.comment??'').slice(0,8000),tags:Array.isArray(args.tags)?args.tags.filter(x=>typeof x==='string').map(x=>x.slice(0,80)).slice(0,30):[],style,color,selector:located.selector,createdAt:now,updatedAt:now}
    if(Array.isArray(state.highlights))state.highlights=state.highlights.filter(h=>!sameSpan(h,located,document.id))
    state.documents[document.id]={id:document.id,title:document.title,kind:document.kind,source:document.source,updatedAt:now};state.bookmarks.push(mark);return mark
  })}
  async addHighlight(document,args){return this.change(state=>{
    const located=locateSelection(document,args.selection??{})
    const style=['highlight','wave','line'].includes(args.style)?args.style:'highlight'
    const color=['gold','blue','green','pink','purple'].includes(args.color)?args.color:'gold'
    const now=new Date().toISOString()
    const bookmark=state.bookmarks.find(b=>b.selector?.type==='TextQuoteSelector'&&b.highlight!==false&&sameSpan(b,located,document.id))
    if(bookmark){
      if(args.style||args.color){bookmark.style=style;bookmark.color=color;bookmark.updatedAt=now}
      return {...bookmark,already:true,kind:'bookmark'}
    }
    if(!Array.isArray(state.highlights))state.highlights=[]
    const existing=state.highlights.find(h=>sameSpan(h,located,document.id))
    if(existing){
      if(args.style||args.color){existing.style=style;existing.color=color;existing.updatedAt=now}
      return {...existing,already:true,kind:'highlight'}
    }
    const mark={id:randomUUID(),documentId:document.id,source:document.source,documentVersion:document.version,quote:located.exact,style,color,selector:located.selector,createdAt:now,updatedAt:now}
    state.highlights.push(mark);return mark
  })}
  async update(id,patch={}){return this.change(state=>{
    const now=new Date().toISOString()
    const style=patch.style&&['highlight','wave','line'].includes(patch.style)?patch.style:undefined
    const color=patch.color&&['gold','blue','green','pink','purple'].includes(patch.color)?patch.color:undefined
    const bm=state.bookmarks.find(b=>b.id===id)
    if(bm){
      if(typeof patch.comment==='string')bm.comment=patch.comment.slice(0,8000)
      if(Array.isArray(patch.tags))bm.tags=patch.tags.filter(x=>typeof x==='string').map(x=>x.slice(0,80)).slice(0,30)
      if(style)bm.style=style
      if(color)bm.color=color
      bm.highlight=true;bm.updatedAt=now;return {...bm,kind:'bookmark'}
    }
    const rows=Array.isArray(state.highlights)?state.highlights:[]
    const hlIdx=rows.findIndex(h=>h.id===id)
    if(hlIdx<0)throw new Error('划线或书签不存在')
    const hl=rows[hlIdx]
    if(style)hl.style=style
    if(color)hl.color=color
    hl.updatedAt=now
    if(typeof patch.comment==='string'&&patch.comment.trim()){
      rows.splice(hlIdx,1);state.highlights=rows
      const promoted={...hl,comment:patch.comment.slice(0,8000),tags:Array.isArray(patch.tags)?patch.tags.filter(x=>typeof x==='string').map(x=>x.slice(0,80)).slice(0,30):[],highlight:true,updatedAt:now}
      state.bookmarks.push(promoted);return {...promoted,kind:'bookmark'}
    }
    return {...hl,kind:'highlight'}
  })}
  async updateDocumentCitation(documentId,citation={}){return this.change(state=>{
    if(!documentId)throw new Error('缺少文献标识')
    const now=new Date().toISOString()
    const clean=v=>String(v??'').trim().slice(0,400)
    const validKinds=['book','paper','collection','incollection']
    const nextKind=validKinds.includes(citation.kind)?citation.kind:'book'
    const prev=state.documents[documentId]??{id:documentId,title:clean(citation.title)||documentId,kind:nextKind==='paper'?'paper':'book'}
    const nextCitation={
      kind:nextKind,
      title:clean(citation.title),
      subtitle:clean(citation.subtitle),
      originalTitle:clean(citation.originalTitle),
      authors:clean(citation.authors),
      editors:clean(citation.editors),
      translators:clean(citation.translators),
      bookTitle:clean(citation.bookTitle),
      originalBookTitle:clean(citation.originalBookTitle),
      publisher:clean(citation.publisher),
      journal:clean(citation.journal),
      year:clean(citation.year).slice(0,16),
      volume:clean(citation.volume).slice(0,40),
      issue:clean(citation.issue).slice(0,40),
      pages:clean(citation.pages).slice(0,40),
      isbn:clean(citation.isbn).slice(0,60),
      doi:clean(citation.doi).slice(0,160),
    }
    state.documents[documentId]={...prev,citation:nextCitation,updatedAt:now}
    return {documentId,citation:nextCitation,updatedAt:now}
  })}
  async removeHighlight(id){return this.change(state=>{const rows=Array.isArray(state.highlights)?state.highlights:[];const next=rows.filter(h=>h.id!==id);if(Array.isArray(state.highlights))state.highlights=next;const removed=next.length!==rows.length;if(removed){state.deleted=Array.isArray(state.deleted)?state.deleted.filter(d=>d.id!==id):[];state.deleted.push({id,kind:'highlight',deletedAt:new Date().toISOString()})}return{removed}})}
  async muteHighlight(id){return this.change(state=>{const hit=state.bookmarks.find(b=>b.id===id);if(!hit)return{muted:false};hit.highlight=false;hit.updatedAt=new Date().toISOString();return{muted:true}})}
  async highlights({documentId=''}={}){const state=await this.read(),rows=Array.isArray(state.highlights)?state.highlights:[];return rows.filter(h=>!documentId||h.documentId===documentId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))}
  async remove(id){return this.change(state=>{const before=state.bookmarks.length;state.bookmarks=state.bookmarks.filter(b=>b.id!==id);const removed=state.bookmarks.length!==before;if(removed){state.deleted=Array.isArray(state.deleted)?state.deleted.filter(d=>d.id!==id):[];state.deleted.push({id,kind:'bookmark',deletedAt:new Date().toISOString()})}return{removed}})}
  async list({documentId='',q=''}={}){const state=await this.read(),needle=String(q).toLocaleLowerCase();return state.bookmarks.filter(b=>(!documentId||b.documentId===documentId)&&(!needle||[b.quote,b.comment,...b.tags,state.documents[b.documentId]?.title].join(' ').toLocaleLowerCase().includes(needle))).map(b=>({...b,document:state.documents[b.documentId]})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
  async exportState(){const state=await this.read();return{schemaVersion:1,documents:state.documents??{},bookmarks:state.bookmarks??[],highlights:Array.isArray(state.highlights)?state.highlights:[],deleted:Array.isArray(state.deleted)?state.deleted:[]}}
  async mergeState(remote){if(!remote||typeof remote!=='object')return{merged:0};return this.change(state=>{
    state.documents=state.documents??{};state.bookmarks=state.bookmarks??[];state.highlights=Array.isArray(state.highlights)?state.highlights:[];state.deleted=Array.isArray(state.deleted)?state.deleted:[]
    const delMap=new Map();for(const d of [...state.deleted,...(Array.isArray(remote.deleted)?remote.deleted:[])]){if(!d?.id)continue;const prev=delMap.get(d.id);if(!prev||String(d.deletedAt??'').localeCompare(String(prev.deletedAt??''))>0)delMap.set(d.id,d)}
    const mergeRows=(localRows,remoteRows)=>{const map=new Map();for(const item of [...localRows,...(Array.isArray(remoteRows)?remoteRows:[])]){if(!item?.id)continue;const stamp=String(item.updatedAt??item.createdAt??'');const del=delMap.get(item.id);if(del&&String(del.deletedAt??'').localeCompare(stamp)>=0)continue;const prev=map.get(item.id);if(!prev||stamp.localeCompare(String(prev.updatedAt??prev.createdAt??''))>0)map.set(item.id,item)}return [...map.values()]}
    const beforeCount=state.bookmarks.length+state.highlights.length+state.deleted.length
    for(const [docId,docMeta]of Object.entries(remote.documents??{})){const prev=state.documents[docId];if(!prev||String(docMeta?.updatedAt??'').localeCompare(String(prev.updatedAt??''))>0)state.documents[docId]=docMeta}
    state.bookmarks=mergeRows(state.bookmarks,remote.bookmarks);state.highlights=mergeRows(state.highlights,remote.highlights);state.deleted=[...delMap.values()].slice(-2000)
    const afterCount=state.bookmarks.length+state.highlights.length+state.deleted.length
    return{merged:Math.abs(afterCount-beforeCount),bookmarks:state.bookmarks.length,highlights:state.highlights.length}
  })}
}
export function exportBookmarks(bookmarks,format='json'){
 if(format==='json')return JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),bookmarks},null,2)+'\n'
 return bookmarks.map(b=>`## ${b.document?.title??b.title??b.documentId}\n\n${String(b.quote??b.excerpt).split('\n').map(x=>'> '+x).join('\n')}\n\n${b.comment??b.note??''}\n\n标签：${(b.tags??[]).join('、')}\n\n书签 ID：${b.id} · ${b.createdAt??''}\n`).join('\n')
}
