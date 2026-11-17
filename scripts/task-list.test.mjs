import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import {PipelineIndex} from '../modules/pipeline/storage.js'
import {isReadableTask,pageTaskRows} from '../modules/pipeline/task-list.js'
const candidate={id:'book',name:'The Certification',state:'idle',stage:'normalize',stages:{inspect:{state:'done'},normalize:{state:'done'}},profile:{confirmed:true},publication:{published:false}}
const row=(t,extra={})=>({summary:JSON.stringify(t),library:null,...extra})
test('scope approval and normalization do not move an unfinished book into readable results',()=>{
 const result=pageTaskRows([row(candidate),row({...candidate,id:'published',publication:{published:true}})],{category:'active'})
 assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].id,'book')
 assert.deepEqual(result.counts,{all:2,active:1,done:1})
 assert.equal(isReadableTask(candidate),false)
})
test('legacy readability uses stored reading proof, not a completed inspection or caption',()=>{
 const result=pageTaskRows([row({...candidate,id:'legacy',legacy:true},{library:'{"kind":"legacy"}'}),row(candidate)],{category:'done'})
 assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].id,'legacy');assert.equal(result.tasks[0].readingReady,true)
})
test('category and metadata filters run before pagination, with global counts and recoverable offsets',()=>{
 const ready=Array.from({length:45},(_,i)=>row({...candidate,id:'ready'+i,publication:{published:true}}))
 const rows=[...ready,row(candidate),row({...candidate,id:'hidden'},{hidden:1}),row({...candidate,id:'folder'},{folderId:'one,two'})]
 const active=pageTaskRows(rows,{category:'active',limit:40,includeHidden:false,offset:40})
 assert.deepEqual(active.tasks.map(t=>t.id),['book','folder']);assert.equal(active.offset,0)
 assert.deepEqual(active.counts,{all:47,active:2,done:45})
 assert.deepEqual(pageTaskRows(rows,{folderId:'two'}).tasks.map(t=>t.id),['folder'])
 assert.equal(pageTaskRows(rows,{folderId:'uncategorized',includeHidden:false}).total,46)
})
test('SQLite page search finds the book across all batches and preserves wildcard literals',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-list-')),index=new PipelineIndex(root)
 try{
  for(let i=0;i<45;i++)await index.put({...candidate,id:'ready'+i,name:'ready'+i,input:{type:'pdf'},publication:{published:true},updatedAt:'2026-10-17'},'stamp')
  await index.put({...candidate,input:{type:'pdf'},name:'The Certification_100%',updatedAt:'2026-10-16'},'stamp')
  const all=await index.page({category:'all',limit:40});assert.equal(all.total,46)
  const active=await index.page({category:'active',limit:40});assert.equal(active.tasks[0].id,'book');assert.equal(active.total,1)
  assert.equal((await index.page({q:'Certification_100%'})).tasks[0].id,'book')
  assert.equal((await index.page({q:'CertificationX100Y'})).total,0)
 }finally{await index.close();await fs.rm(root,{recursive:true,force:true})}
})
test('production UI uses the same classification and rejects stale filter/page response identities',async()=>{
 const source=await fs.readFile(new URL('../client.js',import.meta.url),'utf8')
 const start=source.indexOf('    function isReadableTask(task)'),end=source.indexOf('    function PipelinePanel(',start),ctx={}
 vm.runInNewContext(source.slice(start,end),ctx)
 for(const t of [candidate,{...candidate,readingReady:true},{...candidate,publication:{published:true}},{...candidate,libraryProof:{kind:'legacy'}}])assert.equal(ctx.isReadableTask(t),isReadableTask(t))
 const page={query:'Certification',offset:0,category:'active',folderId:'all',includeHidden:false}
 assert.notEqual(ctx.taskPageKey(page),ctx.taskPageKey({...page,category:'done'}))
 assert.notEqual(ctx.taskPageKey(page),ctx.taskPageKey({...page,offset:40}))
 assert.match(ctx.taskPageUrl(page),/category=active/)
 assert.match(ctx.taskPageUrl(page),/includeHidden=false/)
})
