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
 assert.equal(profileReadiness({input:{type:'pdf'},profile:{language:'en',book_type:'no_notes',note_location:'none',layout:'single'}}).ready,true)
 assert.equal(profileReadiness({input:{type:'pdf'},profile:{language:'en',book_type:'no_notes',note_location:'none',note_numbering:'none',layout:'single'}}).ready,true)
 const noNotesReport={...report('abc'),fields:{...report('abc').fields,book_type:field('no_notes'),note_location:field('none')}}
 assert.equal(mergeProfileAnalysis({kind:'paper',inspection:{fingerprint:'abc'}},noNotesReport).note_numbering,'per_chapter')
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

test('cover_page detection metadata survives profile merge and static cover extraction avoids runtime rendering',async()=>{
  const {ensureTaskCover,taskCoverMeta}=await import('../modules/pipeline/cover.js')
  const {mergeProfileAnalysis}=await import('../modules/pipeline/profile-analysis.js')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cover-extract-'))
  try{
    const noCoverProfile=mergeProfileAnalysis(
      {kind:'paper',inspection:{fingerprint:'fp1'},profile:{}},
      {schemaVersion:1,fingerprint:'fp1',fields:{language:field('en'),cover_page:{value:null,confidence:'high',pages:[1],reason:'paper starts immediately',source:'model'}},unresolved:[]}
    )
    assert.equal(noCoverProfile.cover_page,null)

    const id=randomUUID(),manager=new TaskManager(root,root)
    const task={id,kind:'book',name:'cover-test',input:{type:'pdf'},inspection:{fingerprint:'fp2',pages:10},profile:{cover_page:3},stages:{},log:[]}
    const docDir=manager.docDir(task),aiDir=manager.aiDir(task)
    await fs.mkdir(path.join(aiDir,'page_images'),{recursive:true})
    await fs.writeFile(path.join(docDir,'document_profile.json'),JSON.stringify({source_page_map:[{source_page:3,logical_page:2}]}))
    const png1x1=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')
    await fs.writeFile(path.join(aiDir,'page_images','page_002.png'),png1x1)

    manager.save=async x=>x;manager.get=async()=>task
    const cover=await ensureTaskCover(manager,task)
    assert.equal(cover.page,3)
    assert.equal(cover.none,false)
    assert.equal(cover.file,'cover.jpg')
    assert.ok(cover.sha256)
    assert.deepEqual(taskCoverMeta(task),{hasCover:true,coverPage:3,coverSha256:cover.sha256})
    const diskBytes=await fs.readFile(path.join(docDir,'cover.jpg'))
    assert.ok(diskBytes.length>10)

    // SQLite PipelineIndex retains cover metadata across manager.library() reload
    const {atomic:atomicWrite}=await import('../modules/pipeline/tasks/shared.js'),{fileStamp}=await import('../modules/pipeline/storage.js')
    const realManager=new TaskManager(root,root),readMd=path.join(root,'read.md')
    await fs.writeFile(readMd,'# Title\nBody')
    task.documentId='document:cover-test';task.state='idle';task.legacy={key:'legacy:cov',caption:'fixture',artifacts:{readingPath:readMd}};task.publication={published:true};task.stages={...task.stages,publish:{state:'done'}};task.libraryProof={kind:'legacy',readingPath:readMd,readingStamp:await fileStamp(readMd)}
    await atomicWrite(path.join(realManager.dir(id),'task.json'),task)
    await realManager.save(task)
    const freshManager=new TaskManager(root,root)
    const libEntries=await freshManager.library()
    assert.equal(libEntries.length,1)
    assert.deepEqual({hasCover:libEntries[0].hasCover,coverPage:libEntries[0].coverPage,coverSha256:libEntries[0].coverSha256},{hasCover:true,coverPage:3,coverSha256:cover.sha256})

    await manager.setTaskCoverPage(id,null)
    assert.equal(task.cover.none,true)
    assert.equal(task.cover.page,null)
    assert.deepEqual(taskCoverMeta(task),{hasCover:false,coverPage:null,coverSha256:null})
    await assert.rejects(fs.access(path.join(docDir,'cover.jpg')),{code:'ENOENT'})

    // Heuristic skips JSTOR wrapper page 1 and dense prose, selecting real title/cover page 2
    const pdfBook=path.join(root,'sample-book.pdf'),pdfPaper=path.join(root,'sample-paper.pdf')
    const {detectPdfCoverPage}=await import('../modules/pipeline/cover.js')
    const {execFileSync}=await import('node:child_process')
    let hasFitz=true
    try{
      execFileSync(manager.python,['-c',`
import pymupdf as fitz
doc = fitz.open()
p1 = doc.new_page()
p1.insert_text((72, 120), "Downloaded from https://www.jstor.org/stable/12345\\nAll use subject to JSTOR terms.", fontsize=12)
p2 = doc.new_page()
p2.draw_rect(fitz.Rect(60, 80, 500, 680), color=(0.15, 0.3, 0.6), fill=(0.2, 0.35, 0.65))
p2.insert_text((100, 300), "Critique of Historical Reason", fontsize=26, color=(1, 1, 1))
p3 = doc.new_page()
p3.insert_textbox(fitz.Rect(72, 72, 520, 760), "Body prose. " * 140, fontsize=11)
doc.save(${JSON.stringify(pdfBook)})
paper = fitz.open()
pp = paper.new_page()
pp.insert_textbox(fitz.Rect(72, 72, 520, 760), "Academic journal paper first page. " * 55, fontsize=10.5)
paper.save(${JSON.stringify(pdfPaper)})
`],{stdio:'ignore'})
    }catch{hasFitz=false}
    if(hasFitz){
      const detectedBook=await detectPdfCoverPage(pdfBook,{kind:'book',pythonBin:manager.python})
      assert.equal(detectedBook?.page,2)
      const detectedPaper=await detectPdfCoverPage(pdfPaper,{kind:'paper',pythonBin:manager.python})
      assert.equal(detectedPaper?.page,null)
    }
  }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('bibliography extracted during profile analysis merges cleanly into task.profile without blocking readiness',()=>{
  const bib={kind:'paper',title:'再议基础设施权力',original_title:'Infrastructural Power Revisited',authors:'Michael Mann',journal:'Studies in Comparative International Development',year:'2008',doi:'10.1007/s12116-008-9027-7'}
  const merged=mergeProfileAnalysis(
    {kind:'paper',name:'再议基础设施权力',inspection:{fingerprint:'fp-bib'},profile:{}},
    {schemaVersion:1,fingerprint:'fp-bib',fields:{language:field('en'),book_type:field('footnote_only'),note_numbering:field('continuous'),note_location:field('per_page_bottom'),layout:field('single'),bibliography:field(bib)},unresolved:[]},
  )
  assert.deepEqual(merged.bibliography,bib)
})
