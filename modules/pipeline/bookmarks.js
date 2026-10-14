import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hash } from './markdown.js'
export const plainText=text=>String(text??'').replace(/^#{1,6}\s+/gm,'').replace(/!\[([^\]]*)\]\([^)]+\)/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\[\^([^\]]+)\]/g,'$1').replace(/[*`_]/g,'').replace(/\s+/g,' ').trim()
export class BookmarkStore {
  constructor(file){this.file=file;this.queue=Promise.resolve()}
  async read(){try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(value.schemaVersion!==1||!Array.isArray(value.bookmarks))throw new Error();return value}catch(e){if(e.code==='ENOENT')return{schemaVersion:1,documents:{},bookmarks:[]};throw new Error('书签数据格式异常，保留原文件')}}
  async change(fn){const job=this.queue.catch(()=>{}).then(async()=>{const state=await this.read(),value=await fn(state);await fs.mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(temp,this.file)}finally{await fs.unlink(temp).catch(()=>{})}return value});this.queue=job;return job}
  async add(document,args){return this.change(state=>{
    const selection=args.selection??{},start=document.blocks.findIndex(b=>String(b.id)===String(selection.startBlockId)),end=document.blocks.findIndex(b=>String(b.id)===String(selection.endBlockId??selection.startBlockId));
    const view=selection.view==='translation'?'translation':'original';if(start<0||end<start)throw new Error('书签定位段落无效')
    const texts=document.blocks.slice(start,end+1).map(b=>plainText(view==='translation'?b.translation:b.text));if(texts.some(x=>!x))throw new Error('当前文本版本不可用')
    const span=texts.join(' '),exact=plainText(selection.exact);if(!exact||exact.length>20000)throw new Error('请选择不超过两万字的正文');let offset=span.indexOf(exact)
    if(offset<0)throw new Error('选中文字与当前文档不一致，请重新选择')
    if(selection.prefix){const match=plainText(selection.prefix);const hits=[];for(let i=span.indexOf(exact);i>=0;i=span.indexOf(exact,i+1))if(plainText(span.slice(0,i)).endsWith(match))hits.push(i);if(hits.length===1)offset=hits[0]}
    const now=new Date().toISOString(),mark={id:randomUUID(),documentId:document.id,source:document.source,documentVersion:document.version,quote:exact,comment:String(args.comment??'').slice(0,8000),tags:Array.isArray(args.tags)?args.tags.filter(x=>typeof x==='string').map(x=>x.slice(0,80)).slice(0,30):[],selector:{type:'TextQuoteSelector',view,startBlockId:String(selection.startBlockId),endBlockId:String(selection.endBlockId??selection.startBlockId),start:offset,end:offset+exact.length,exact,prefix:span.slice(Math.max(0,offset-80),offset),suffix:span.slice(offset+exact.length,offset+exact.length+80)},createdAt:now,updatedAt:now}
    state.documents[document.id]={id:document.id,title:document.title,kind:document.kind,source:document.source,updatedAt:now};state.bookmarks.push(mark);return mark
  })}
  async remove(id){return this.change(state=>{const before=state.bookmarks.length;state.bookmarks=state.bookmarks.filter(b=>b.id!==id);return{removed:state.bookmarks.length!==before}})}
  async list({documentId='',q=''}={}){const state=await this.read(),needle=String(q).toLocaleLowerCase();return state.bookmarks.filter(b=>(!documentId||b.documentId===documentId)&&(!needle||[b.quote,b.comment,...b.tags,state.documents[b.documentId]?.title].join(' ').toLocaleLowerCase().includes(needle))).map(b=>({...b,document:state.documents[b.documentId]})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
}
export function exportBookmarks(bookmarks,format='json'){
 if(format==='json')return JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),bookmarks},null,2)+'\n'
 return bookmarks.map(b=>`## ${b.document?.title??b.title??b.documentId}\n\n${String(b.quote??b.excerpt).split('\n').map(x=>'> '+x).join('\n')}\n\n${b.comment??b.note??''}\n\n标签：${(b.tags??[]).join('、')}\n\n书签 ID：${b.id} · ${b.createdAt??''}\n`).join('\n')
}
