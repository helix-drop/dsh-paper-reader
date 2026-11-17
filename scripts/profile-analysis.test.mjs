import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {mergeProfileAnalysis} from '../modules/pipeline/profile-analysis.js'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {hash} from '../modules/pipeline/markdown.js'
const field=value=>({value,confidence:'high',pages:[1],reason:'page evidence',source:'model'})
const report=fingerprint=>({schemaVersion:1,fingerprint,completedAt:'2026-10-16',status:'complete',provider:'test',model:'test',fields:{language:field('en'),book_type:field('endnote_only'),note_location:field('book_end_notes'),layout:field('single'),start_page:field(1),end_page:field(338)},unresolved:['note_numbering'],samplePages:[1]})
test('automatic candidates replace unapproved guesses but never confirm scope',()=>{
 const t={kind:'book',name:'test',inspection:{fingerprint:'abc'},profile:{layout:'single',note_numbering:'per_chapter',source_fingerprint:'abc',confirmed:false}}
 const merged=mergeProfileAnalysis(t,report('abc'))
 assert.equal(merged.language,'en');assert.equal(merged.note_location,'book_end_notes');assert.equal(merged.confirmed,false)
 assert.equal(merged.note_numbering,undefined)
 assert.equal(merged.transcription_method,'vision')
})
test('manual saved profile and source approval survive analysis only for the same source',()=>{
 const t={inspection:{fingerprint:'abc'},profile:{language:'fr',start_page:8,confirmed:true,source_fingerprint:'abc'}}
 assert.equal(mergeProfileAnalysis(t,report('abc'),{preserveSaved:true}).language,'fr')
 assert.equal(mergeProfileAnalysis(t,report('abc'),{preserveSaved:true}).confirmed,true)
 t.inspection.fingerprint='new'
 assert.equal(mergeProfileAnalysis(t,report('new'),{preserveSaved:true}).confirmed,false)
 assert.throws(()=>mergeProfileAnalysis(t,report('stale')),/不一致/)
})
test('inspection runs model analysis before confirmation, reuses cached evidence, preserves human configuration',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-analysis-'))
 try{
  const manager=new TaskManager(root,root),id=randomUUID(),source=path.join(root,'source.md'),text='A real source document'
  await fs.writeFile(source,text);const fp=hash(text)
  const task={id,kind:'paper',name:'test',path:source,input:{type:'markdown'},worker:{provider:'test',model:'test'},stages:{},log:[]}
  let calls=0;manager.save=async t=>t
  manager.command=async()=>{calls++;const dir=path.join(manager.dir(id),'profile-analysis');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'analysis.json'),JSON.stringify(report(fp)));return ''}
  await manager.performBody(task,'inspect',{})
  assert.equal(task.profile.language,'en');assert.equal(task.profile.confirmed,false);assert.equal(calls,1)
  await manager.performBody(task,'inspect',{});assert.equal(calls,1)
  await fs.writeFile(path.join(manager.dir(id),'profile.json'),'{}');task.profile.language='fr';task.profile.confirmed=true
  await manager.performBody(task,'inspect',{reanalyze:true})
  assert.equal(calls,2);assert.equal(task.profile.language,'fr');assert.equal(task.profile.confirmed,true)
  manager.command=async()=>{await fs.writeFile(source,'source changed');return ''}
  await assert.rejects(manager.analyzeProfile(task,{reanalyze:true}),/源文件/)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('model failure retains program fields without inventing language or approving scope',()=>{
 const r={...report('abc'),status:'model_failed',fields:{start_page:field(1),end_page:field(338)}}
 const profile=mergeProfileAnalysis({kind:'book',inspection:{fingerprint:'abc'}},r)
 assert.equal(profile.start_page,1);assert.equal(profile.language,undefined);assert.equal(profile.confirmed,false)
})
test('irrelevant or incomplete tail-note ranges cannot poison profile validation',()=>{
 const r=report('abc');r.fields.book_type=field('footnote_only');r.fields.note_start_page=field(13)
 const p=mergeProfileAnalysis({kind:'book',inspection:{fingerprint:'abc'}},r)
 assert.equal(p.note_start_page,undefined);assert.equal(p.note_end_page,undefined)
 r.fields.book_type=field('endnote_only')
 assert.equal(mergeProfileAnalysis({kind:'book',inspection:{fingerprint:'abc'}},r).note_start_page,undefined)
 r.fields.note_end_page=field(20)
 assert.equal(mergeProfileAnalysis({kind:'book',inspection:{fingerprint:'abc'}},r).note_end_page,20)
})

test('failed profile observation does not call the model again during ordinary inspection',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-no-retry-'))
 try{
  const manager=new TaskManager(root,root),source=path.join(root,'source.md'),text='A source'
  await fs.writeFile(source,text)
  const task={id:randomUUID(),kind:'paper',name:'test',path:source,input:{type:'markdown'},worker:{provider:'test',model:'test'},stages:{},log:[]}
  let calls=0;manager.save=async t=>t
  manager.command=async()=>{calls++;const dir=path.join(manager.dir(task.id),'profile-analysis');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'analysis.json'),JSON.stringify({...report(hash(text)),status:'model_failed',fields:{}}));return ''}
  await manager.performBody(task,'inspect',{});await manager.performBody(task,'inspect',{});assert.equal(calls,1)
  await manager.performBody(task,'inspect',{reanalyze:true});assert.equal(calls,2)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('failed cache retries once after runtime repair and forwards changed approved fallback chain',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-repair-'))
 try{
  const manager=new TaskManager(root,root),source=path.join(root,'source.md'),text='A source',id=randomUUID()
  await fs.writeFile(source,text)
  const task={id,kind:'paper',name:'test',path:source,input:{type:'markdown'},inspection:{fingerprint:hash(text)},worker:{provider:'test',model:'test'},stages:{},log:[]}
  const dir=path.join(manager.dir(id),'profile-analysis'),file=path.join(dir,'analysis.json')
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,JSON.stringify({...report(hash(text)),status:'model_failed',fields:{}}))
  let calls=0,args=[];manager.save=async t=>t
  manager.command=async(_t,_cmd,argv)=>{calls++;args=argv;await fs.writeFile(file,JSON.stringify({...report(hash(text)),status:'model_failed',fields:{}}))}
  await manager.analyzeProfile(task);assert.equal(calls,1)
  await manager.analyzeProfile(task);assert.equal(calls,1)
  const worker=path.join(root,'.kimi-code/skills/fnm-ai-convert/scripts/worker_call.py')
  await fs.mkdir(path.dirname(worker),{recursive:true});await fs.writeFile(worker,'# route repaired')
  await manager.analyzeProfile(task);assert.equal(calls,2)
  await manager.analyzeProfile(task);assert.equal(calls,2)
  task.worker.fallbacks=[{provider:'kimi-coding',model:'k3-256k'}]
  await manager.analyzeProfile(task);assert.equal(calls,3)
  assert.deepEqual(args.slice(-2),['--fallback','kimi-coding:k3-256k'])
  await manager.analyzeProfile(task);assert.equal(calls,3)
  assert.equal(task.worker.provider,'test')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('successful but incomplete PDF analysis cannot auto-confirm or reach the validator',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-incomplete-'))
 try{
  const manager=new TaskManager(root,root),task={id:randomUUID(),kind:'book',input:{type:'pdf'},inspection:{fingerprint:'source',pages:452},profile:{language:'fr',layout:'single',start_page:1,end_page:452,confirmed:false},profileAnalysis:{status:'complete',unresolved:['book_type','note_numbering','note_location']},stages:{}}
  let calls=0;manager.py=async()=>{calls++};manager.save=async t=>t
  const before=structuredClone(task)
  await assert.rejects(manager.autoConfirmProfileAndScope(task),e=>e.code==='PROFILE_INCOMPLETE'&&e.message.includes('注释体例、注释编号方式、注释位置'))
  assert.equal(calls,0);assert.deepEqual(task,before)
  await assert.rejects(fs.access(path.join(manager.dir(task.id),'profile.candidate.json')),{code:'ENOENT'})
  // Actual corrected fields, rather than stale report.unresolved, determine readiness.
  await fs.mkdir(manager.dir(task.id),{recursive:true})
  task.path=path.join(root,'source.pdf');await fs.writeFile(task.path,'fixture')
  Object.assign(task.profile,{book_type:'footnote_only',note_numbering:'per_page',note_location:'per_page_bottom'})
  await manager.autoConfirmProfileAndScope(task);assert.equal(calls,1);assert.equal(task.profile.confirmed,true)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('unknown language is never defaulted to English and Markdown requires no PDF note settings',async()=>{
 const manager=new TaskManager('/unused','/unused'),task={id:'test',input:{type:'markdown'},inspection:{fingerprint:'source'},profile:{},profileAnalysis:{status:'complete'}}
 await assert.rejects(manager.autoConfirmProfileAndScope(task),e=>e.code==='PROFILE_INCOMPLETE'&&e.missing.join(',')==='language')
 const {profileReadiness}=await import('../modules/pipeline/profile-analysis.js')
 assert.equal(profileReadiness({...task,profile:{language:'fr'}}).ready,true)
 assert.deepEqual(profileReadiness({input:{type:'pdf'},profile:{language:'fr',book_type:'footnote_only',note_numbering:'per_page',note_location:'per_page_bottom',layout:'columns'}}).missing,['regions'])
})
test('document validator error survives subprocess exit into task diagnostics and monitor',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-diagnostic-'))
 try{
  const manager=new TaskManager(root,root),file=path.join(root,'document_pipeline.py'),task={id:randomUUID(),stage:'inspect',stages:{},log:[]},records=[]
  await fs.writeFile(file,"import json,sys\nprint('ordinary warning')\nprint(json.dumps({'error':'必须确认脚注或尾注体例'},ensure_ascii=False))\nsys.exit(2)\n")
  manager.save=async t=>t;manager.sessionMonitor={attempt:async fn=>fn(),record:async(_t,_role,_key,text)=>records.push(text),scan:async()=>{}}
  await assert.rejects(manager.rawCommand(task,manager.python,[file]),/退出码 2；必须确认脚注或尾注体例；已有产物保留/)
  assert.equal(task.log[0].diagnostic,'必须确认脚注或尾注体例');assert.ok(records.some(text=>text.includes('校验原因：必须确认脚注或尾注体例')))
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('analysis UI distinguishes a completed response from unresolved required fields',async()=>{
 const {default:vm}=await import('node:vm'),source=await fs.readFile(new URL('../client.js',import.meta.url),'utf8'),start=source.indexOf('    const profileLabels='),end=source.indexOf('    function isReadableTask',start)
 const ctx={React:{Fragment:'fragment'},h:(tag,props,...children)=>({tag,props,children}),button:()=>null};vm.runInNewContext(source.slice(start,end),ctx)
 const task={state:'blocked',profile:{confirmed:false},stages:{},profileAnalysis:{status:'complete',fields:{},samplePages:[],unresolved:['book_type']},profileReadiness:{ready:false,missing:['book_type','note_numbering','note_location']}}
 const rendered=JSON.stringify(ctx.ProfileAnalysis({task,onAnalyze:()=>{}}));assert.match(rendered,/仍有必填信息待核验/);assert.match(rendered,/注释体例、编号方式、注释位置/)
})

test('orchestrator summaries retain missing required fields despite analysis complete',async()=>{
 const {taskSummary}=await import('../modules/pipeline/evidence.js'),{TaskSessions}=await import('../modules/pipeline/sessions.js')
 const task={id:'fixture',state:'blocked',stage:'inspect',input:{type:'pdf'},profile:{language:'fr',layout:'single'},profileAnalysis:{status:'complete',model:'deepseek-v4.1-flash',failure:null}},records=[]
 const summary=taskSummary(task).profileAnalysis
 assert.equal(summary.status,'complete');assert.equal(summary.ready,false);assert.deepEqual(summary.missing,['book_type','note_numbering','note_location'])
 await TaskSessions.prototype.observe.call({record:async(_t,_role,_key,text)=>records.push(text)},task)
 assert.match(records[0],/"ready":false/);assert.match(records[0],/注释体例、注释编号方式、注释位置/)
})
