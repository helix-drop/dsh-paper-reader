import {semanticFixture} from './glossary-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {hash,markdownBlocks} from '../modules/pipeline/markdown.js'
import {buildSourceMap,loadSourceMap,translationInput,acceptTranslation,saveTranslationMap,writeSourceMap} from '../modules/pipeline/source-map.js'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {buildPublication,commitPublication} from '../modules/pipeline/publication.js'
import {attachPdfLocations} from '../modules/pipeline/pdf-location.js'

const ID='11111111-1111-4111-8111-111111111111'
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-map-test-'))),taskDir=path.join(root,'task'),doc=path.join(taskDir,'document'),file=path.join(doc,'original.md'),pdf=path.join(root,'original.pdf'),report=path.join(taskDir,'review.md'),publishRoot=path.join(root,'published')
 await fs.mkdir(doc,{recursive:true});await fs.mkdir(publishRoot)
 const source='## Chapter\n\nA paragraph continued across two logical pages.\n\nA repeated paragraph.\n\nA repeated paragraph.\n'
 await fs.writeFile(pdf,'original PDF bytes');await fs.writeFile(path.join(doc,'source.pdf'),'normalized PDF bytes');await fs.writeFile(file,source)
 await fs.writeFile(path.join(doc,'document_profile.json'),JSON.stringify({original_fingerprint:hash('original PDF bytes'),source_fingerprint:hash('normalized PDF bytes'),original_total_pages:20,source_page_map:[{logical_page:1,source_page:12,rect:[0,0,0.5,1]},{logical_page:2,source_page:13,rect:[0,0,1,1]}]}))
 const spans=[{startLine:3,endLine:3,chapterId:'001',sourcePids:['p001_1','p002_1'],logicalPages:[1,2]},{startLine:5,endLine:5,chapterId:'001',sourcePids:['p002_2'],logicalPages:[2]},{startLine:7,endLine:7,chapterId:'001',sourcePids:['p002_3'],logicalPages:[2]}]
 await fs.writeFile(file+'.provenance.json',JSON.stringify({schemaVersion:1,markdownSha256:hash(source),spans,inputs:[]}))
 const manager=new TaskManager(root,path.join(root,'papers'),{publishRoot});manager.original=async()=>file;manager.docDir=()=>doc;manager.dir=()=>taskDir;manager.save=async t=>t
 const t={id:ID,input:{type:'pdf',fingerprint:hash('original PDF bytes')},path:pdf,name:'Map test',profile:{language:'en'},kind:'paper',stages:{assemble:{state:'done'}},bookmarks:[],log:[]}
 return {root,manager,t,file,source,doc,pdf,report,close:()=>fs.rm(root,{recursive:true,force:true})}
}
test('assembly maps repeated and cross-page paragraphs by provenance, preserving stable identities',async()=>{
 const f=await fixture();try{
  const map=await buildSourceMap(f.manager,f.t)
  assert.deepEqual(map.blocks[1].pdfPages,[12,13]);assert.deepEqual(map.blocks[1].pdfPageRanges,[[12,13]])
  assert.equal(map.blocks[1].sourcePids.length,2);assert.notEqual(map.blocks[2].blockId,map.blocks[3].blockId)
  assert.equal(map.blocks[0].generated,true);assert.deepEqual(map.blocks[0].pdfPages,[])
  assert.deepEqual((await loadSourceMap(f.manager,f.file,f.source)).blocks,map.blocks)
  const doc=await attachPdfLocations(f.manager,f.t,{blocks:markdownBlocks(f.source)})
  assert.equal(doc.blocks[1].pdfPage,12);assert.equal(doc.blocks[2].pdfPage,13);assert.equal(doc.blocks[3].pdfPage,13)
  await fs.writeFile(f.pdf,'changed PDF');await assert.rejects(loadSourceMap(f.manager,f.file,f.source),/PDF 已变化/)
 }finally{await f.close()}
})
test('stale Markdown, missing scope pages and duplicate block identifiers fail closed',async()=>{
 const f=await fixture();try{
  const map=await buildSourceMap(f.manager,f.t)
  await assert.rejects(loadSourceMap(f.manager,f.file,f.source+'changed'),/Markdown 不一致/)
  await writeSourceMap(f.file,{...map,blocks:map.blocks.map(b=>({...b,blockId:'duplicate'}))});await assert.rejects(loadSourceMap(f.manager,f.file,f.source),/缺失或重复/)
  const profile=path.join(f.doc,'document_profile.json'),p=JSON.parse(await fs.readFile(profile));p.source_page_map.pop();await fs.writeFile(profile,JSON.stringify(p));await assert.rejects(buildSourceMap(f.manager,f.t),/缺少逻辑页/)
 }finally{await f.close()}
})
test('translation keeps explicit identifiers and rejects dropped, duplicate or reordered markers',async()=>{
 const f=await fixture();try{
  const map=await buildSourceMap(f.manager,f.t),receipt=translationInput(f.source,map)
  const translated=receipt.text.replace('A paragraph continued across two logical pages.','跨越两个逻辑页的段落。').replaceAll('A repeated paragraph.','重复的段落。')
  const result=acceptTranslation(f.source,translated,receipt,map)
  assert(!result.target.includes('dsh-block:'));assert.deepEqual(result.blocks[1].pdfPages,[12,13])
  assert(receipt.ids.every(id=>/^B\d{4,}$/.test(id)))
  assert.equal(result.blocks[1].blockId,receipt.sourceIds[1])
  const withTypo=translated.replace(receipt.ids[1],'B9999')
  assert.throws(()=>acceptTranslation(f.source,withTypo,receipt,map),/段落标识/)
  const legacy={...receipt,schemaVersion:1,ids:receipt.sourceIds,text:receipt.text}
  const legacyText=translated.replace(/dsh-block:(B\d+)/g,(_m,id)=>'dsh-block:'+receipt.sourceIds[receipt.ids.indexOf(id)])
  const legacyTypo=legacyText.replace(legacy.ids[1],legacy.ids[1].slice(0,5)+legacy.ids[1].slice(6))
  assert.equal(acceptTranslation(f.source,legacyTypo,legacy,map).blocks[1].blockId,legacy.ids[1])
  assert.throws(()=>acceptTranslation(f.source,translated.replace(/<!--dsh-block:[^>]+-->/,''),receipt,map),/段落标识.*第 1 块/)
  assert.throws(()=>acceptTranslation(f.source,translated.replace(receipt.ids[1],receipt.ids[0]),receipt,map),/段落标识/)
  assert.throws(()=>acceptTranslation(f.source+'new',translated,receipt,map),/原文已变化/)
  const target=path.join(f.root,'translation.md');await fs.writeFile(target,result.target);const targetMap=await saveTranslationMap(f.manager,f.t,f.file,target,f.source,result.target,result.blocks)
  assert.equal(targetMap.sourceMarkdownSha256,hash(f.source));assert.equal((await loadSourceMap(f.manager,target,result.target)).pdfPath,f.pdf)
 }finally{await f.close()}
})
test('publication retains portable original and translated maps and the ORIGINAL PDF, and binds review versions',async()=>{
 const f=await fixture();try{
  const map=await buildSourceMap(f.manager,f.t),prep=translationInput(f.source,map),result=acceptTranslation(f.source,prep.text.replace('A paragraph continued across two logical pages.','跨页段落。').replaceAll('A repeated paragraph.','重复段落。'),prep,map),target=path.join(f.root,'translation.md')
  await fs.writeFile(target,result.target);await saveTranslationMap(f.manager,f.t,f.file,target,f.source,result.target,result.blocks)
  f.t.translationPath=target;f.t.translationReport={passed:true,sourceFingerprint:hash(f.source),targetFingerprint:hash(result.target)}
  await assert.rejects(buildPublication(f.manager,f.t),/审校/)
  await fs.writeFile(f.report,'Human review evidence');f.t.review={status:'pass',report:f.report,reportFingerprint:hash('Human review evidence'),sourceFingerprint:hash(f.source),targetFingerprint:hash(result.target)}
  f.t.publication=await buildPublication(f.manager,f.t)
  assert(f.t.publication.files.some(f=>f.name==='原文.md.source-map.json'));assert(f.t.publication.files.some(f=>f.name==='译文.md.source-map.json'))
  const published=await commitPublication(f.manager,f.t,true),original=path.join(published.destination,'原文.md'),translation=path.join(published.destination,'译文.md')
  assert.equal(await fs.readFile(path.join(published.destination,'原始PDF.pdf'),'utf8'),'original PDF bytes')
  assert.equal((await loadSourceMap(f.manager,original,await fs.readFile(original,'utf8'))).blocks[1].pdfPages[0],12)
  assert.equal((await loadSourceMap(f.manager,translation,await fs.readFile(translation,'utf8'))).sourceMarkdownSha256,hash(f.source))
  const bilingual=path.join(published.destination,'双语.md'),bilingualMap=await loadSourceMap(f.manager,bilingual,await fs.readFile(bilingual,'utf8'))
  assert.equal(bilingualMap.presentation,'bilingual');assert.equal(bilingualMap.blocks.filter(b=>b.pdfPages.length).length,6)
  await fs.writeFile(f.report,'Changed review');await assert.rejects(buildPublication(f.manager,f.t),/审校/)
 }finally{await f.close()}
})

test('CLI orchestration freezes source identities, validates adoption, reuses success and invalidates stale review on import',async()=>{
 const f=await fixture();try{
  await buildSourceMap(f.manager,f.t);f.t.stages.lgProject={state:'done'}
  f.manager.cliStatus=async()=>({version:'offline-test',model:{model:'fake',credentialConfigured:true}})
  const requestLog=[];f.manager.glossaryRequestLog=async()=>requestLog
  let invocations=0
  f.manager.command=async(_t,_cmd,args,io)=>{
   const input=args[args.indexOf('--input')+1],out=args[args.indexOf('--output-dir')+1]
   if(input.endsWith('.txt')){const units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse),kind=path.basename(input,'.txt'),records=units.map(u=>semanticFixture(u,kind)??{unitId:u.unitId,terms:[]});requestLog.push({started_at:new Date().toISOString(),ended_at:new Date().toISOString(),pairs:units.map((u,i)=>({src:JSON.stringify(u),dst:JSON.stringify(records[i])}))});await fs.writeFile(path.join(out,path.basename(input)),records.map(r=>JSON.stringify(r)).join('\n'));await io.onLine(JSON.stringify({type:'finished',status:'done'}));return}
   invocations++
   await fs.writeFile(path.join(out,'result.md'),(await fs.readFile(input,'utf8')).replace('A paragraph continued across two logical pages.','跨页段落。'))
   await io.onLine(JSON.stringify({type:'finished',status:'done'}))
  }
  f.t.phaseApproval={phase:'translation',translationModel:{model:'fake'}};await f.manager.perform(f.t,'glossary',{});f.t.stages.glossary={state:'done'}
  await f.manager.translateViaCli(f.t,{});await f.manager.perform(f.t,'translationCheck',{})
  assert.equal(f.t.translationReport.explicitBlockIds,true);assert.equal(f.t.translationReport.sourceMapAvailable,true)
  const target=await fs.readFile(f.t.translationPath,'utf8');assert(!target.includes('dsh-block:'))
  await f.manager.translateViaCli(f.t,{});assert.equal(invocations,1)
  f.t.stages.review={state:'done'};f.t.review={obsolete:true};f.manager.get=async()=>f.t
  await f.manager.importTranslation(ID,Buffer.from(target));assert.equal(f.t.review,undefined);assert.equal(f.t.stages.review,undefined)
  await assert.rejects(f.manager.perform(f.t,'translationCheck',{}),/缺少当前原文/)
 }finally{await f.close()}
})

test('code, tables, lists and footnotes retain markers without altering final Markdown structure',()=>{
 const source='## Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| c | d |\n\n```js\nconst a = 1\n```\n\nParagraph[^1]  \nHard line break\n\n[^1]: note\n\n---\n'
 const input=translationInput(source,null),result=acceptTranslation(source,input.text,input,null)
 assert.equal(result.target,source);assert(result.check.passed)
})

test('chapter edits cannot reset a used transcription budget and invalid ranges never enter preparation',async()=>{
 const f=await fixture();try{
  f.manager.get=async()=>f.t;f.t.scope={pages:2};f.t.stages.transcribe={state:'blocked'}
  await assert.rejects(f.manager.confirmStructure(ID,{chapters:[{id:'new',title:'New',start_page:1,end_page:2}]}),/重置预算/)
  delete f.t.stages.transcribe
  for(const chapters of [[{title:'X',start_page:1,end_page:3}],[{title:'X',start_page:1.5,end_page:2}],[{id:'../escape',title:'X',start_page:1,end_page:2}],[{title:'X',start_page:1,end_page:2},{title:'Y',start_page:2,end_page:2}]])await assert.rejects(f.manager.confirmStructure(ID,{chapters}),/无效|重叠/)
 }finally{await f.close()}
})

test('an existing glossary survives a blocked analysis but cannot bypass it',async()=>{
 const f=await fixture();try{
  f.manager.cliStatus=async()=>({model:{credentialConfigured:false}})
  const file=path.join(f.manager.dir(ID),'glossary.json');await fs.mkdir(path.dirname(file),{recursive:true});const text=JSON.stringify([{src:'Dasein',dst:'此在'}]);await fs.writeFile(file,text)
  f.t.phaseApproval={phase:'translation',translationModel:{}};await assert.rejects(f.manager.perform(f.t,'glossary',{}),/缺少凭证/)
  assert.equal(await fs.readFile(file,'utf8'),text)
  await assert.rejects(f.manager.requireGlossary(f.t),/必须完成/)
 }finally{await f.close()}
})

test('review registration refuses stale reports even when a report file exists',async()=>{
 const f=await fixture();try{
  f.t.reviewConfig={};f.t.phaseApproval={phase:'delivery',reviewConfig:{}};f.t.translationPath=path.join(f.root,'translation.md');await fs.writeFile(f.t.translationPath,'translation');f.t.stages.translationCheck={state:'done'};f.t.translationReport={sourceFingerprint:hash(f.source),targetFingerprint:hash('translation')}
  const report=path.join(f.manager.dir(ID),'review/report.md');await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,'Old review')
  await assert.rejects(f.manager.perform(f.t,'review',{}),/缺少当前原文与译文指纹/)
  await fs.writeFile(report,'<!-- dsh-review-source:'+f.t.translationReport.sourceFingerprint+' -->\n<!-- dsh-review-target:'+f.t.translationReport.targetFingerprint+' -->\nFindings pending human review.')
  await f.manager.perform(f.t,'review',{});assert.equal(f.t.review.semanticVerified,false);assert.equal(f.t.review.sourceFingerprint,hash(f.source))
 }finally{await f.close()}
})

test('import associates an uploaded PDF by fingerprint and rejects a different PDF',async()=>{
 const f=await fixture();try{
  const map=await buildSourceMap(f.manager,f.t);f.manager.get=async()=>f.t
  const wrong=path.join(f.root,'wrong.pdf');await fs.writeFile(wrong,'different PDF')
  f.manager.catalog=async()=>[{id:'correct',type:'pdf',path:f.pdf},{id:'wrong',type:'pdf',path:wrong}]
  const moved={...map,pdf:{...map.pdf,file:'missing-after-upload.pdf'}}
  await assert.rejects(f.manager.importSourceMap(ID,'original',moved,'wrong'),/PDF 与映射指纹不一致/)
  await f.manager.importSourceMap(ID,'original',moved,'correct')
  assert.equal((await loadSourceMap(f.manager,f.file,f.source)).pdfPath,f.pdf)
 }finally{await f.close()}
})

test('a failed chapter does not finish the task while another chapter can still write',async()=>{
 const f=await fixture();try{
  f.t.inspection={verdict:'SCANNED'};f.t.stages={prepare:{state:'done'},images:{state:'done'},paddle:{state:'done'},mineru:{state:'done'}};f.t.worker={provider:'fake',model:'fake',timeout:1}
  f.manager.active.set(ID,{cancel:false});f.manager.chapters=async()=>[{id:'001'},{id:'002'}]
  let release,started;const waiting=new Promise(r=>{release=r}),begin=new Promise(r=>{started=r});let completed=false
  f.manager.py=async(_t,script,args)=>{if(!script.endsWith('bounded_chapter.py'))return;if(args.includes('001'))throw new Error('chapter failed');started();await waiting;completed=true}
  f.manager.acceptTranscriptionDelivery=async()=>{}
  f.t.phaseApproval={phase:'transcription',workerId:'fake:fake'};let settled=false;const run=f.manager.perform(f.t,'transcribe',{}).catch(e=>{assert.equal(e.message,'chapter failed')}).finally(()=>{settled=true})
  await begin;await new Promise(r=>setImmediate(r));assert.equal(settled,false);release();await run;assert.equal(completed,true)
 }finally{await f.close()}
})

test('academic translation refuses destructive ruby preprocessing before dispatch',async()=>{
 const {assertAcademicPreprocessing}=await import('../modules/pipeline/cli.js')
 const source='Medical practitioners[^1] listed his/her qualifications and a later sentence.[^2]'
 // Exact aggressive rule in the installed LinguaGacha 0.127.1 cleaner.
 assert.notEqual(source.replace(/\[(.+)\/.+\]/giu,'$1'),source)
 assert.throws(()=>assertAcademicPreprocessing({preprocessing:{cleanRuby:true}}),/清理会删除/)
 assert.doesNotThrow(()=>assertAcademicPreprocessing({preprocessing:{cleanRuby:false}}))
 const f=await fixture();try{
  f.t.translationEngine='http';f.t.lgPreparationKey='same';f.manager.requireGlossary=async()=>{};f.manager.requireDone=async()=>{};f.manager.prepareTranslationInput=async()=>({receipt:{annotatedFingerprint:'same'}});f.manager.ensureLgProject=async()=>{};f.manager.modelStatus=async()=>({model:'fixture'});const routes=[]
  f.manager.lg=async(_t,route)=>{routes.push(route);return {settings:{clean_ruby:true}}}
  await assert.rejects(f.manager.translateTask(f.t,{}),/清理会删除/)
  assert.deepEqual(routes,['/api/settings/app'])
 }finally{await f.close()}
})

test('translation stops provider retries, preserves exact completed blocks and resumes only missing blocks',async()=>{
 const f=await fixture();try{
  await buildSourceMap(f.manager,f.t);f.manager.requireGlossary=async()=>{};f.manager.cliStatus=async()=>({version:'offline-test',model:{model:'fixture',credentialConfigured:true}})
  const requests=[],counts=[];let fail
  f.manager.translationRequestLog=async()=>requests;f.manager.watchTranslationProviderFailure=async cb=>{fail=cb;return ()=>{}}
  f.manager.command=async(_t,_cmd,args,io)=>{
   const input=await fs.readFile(args[args.indexOf('--input')+1],'utf8'),blocks=markdownBlocks(input),out=args[args.indexOf('--output-dir')+1];counts.push(blocks.length)
   const pairs=blocks.map(b=>({src:b.text,dst:b.text.replace('A repeated paragraph.','重复的段落。')}))
   if(counts.length===1){requests.push({ended_at:new Date().toISOString(),pairs:pairs.slice(0,2)});fail({reason:'timeout'});throw new Error('Stopped')}
   await fs.writeFile(path.join(out,'result.md'),pairs.map(p=>p.dst).join('\n\n'));await io.onLine(JSON.stringify({type:'finished',status:'done'}))
  }
  await assert.rejects(f.manager.translateViaCli(f.t,{}),/停止自动重试/)
  await assert.rejects(f.manager.translateViaCli(f.t,{}),/上次翻译未完成/);assert.deepEqual(counts,[4])
  // A later retry must still work after old application logs have rotated away.
  requests.length=0
  await f.manager.translateViaCli(f.t,{retryErrors:true});assert.deepEqual(counts,[4,2])
  assert.equal(f.t.translationCli.reusedBlocks,2);assert.equal(f.t.translationCli.status,'done')
  await f.manager.translateViaCli(f.t,{});assert.deepEqual(counts,[4,2])
  assert.equal(markdownBlocks(await fs.readFile(path.join(f.manager.dir(ID),'translation/translated.md'),'utf8')).length,4)
 }finally{await f.close()}
})

test('chapter validation failure retains pending output but drains independent chapter queue',async()=>{
 for(const concurrency of [1,2]){
  const f=await fixture();try{
   f.t.inspection={verdict:'SCANNED'};f.t.stages={prepare:{state:'done'},images:{state:'done'}};f.t.worker={provider:'fake',model:'fake',timeout:1};f.t.phaseApproval={phase:'transcription',workerId:'fake:fake'}
   f.manager.active.set(ID,{cancel:false});f.manager.chapters=async()=>['001','002','003','004'].map(id=>({id}))
   const delivery=path.join(f.manager.aiDir(f.t),'delivery/chapter_001');await fs.mkdir(path.join(delivery,'output'),{recursive:true})
   await fs.writeFile(path.join(delivery,'state.json'),JSON.stringify({finished:true,attempts:{1:{used:2}}}))
   await fs.writeFile(path.join(delivery,'output/report.json'),JSON.stringify({quality_status:'pending',input_protocol:{required:true,unverified_pages:[]},errors:['BLOCKED: fixture']}))
   const started=[],accepted=[],accept=f.manager.acceptTranscriptionDelivery.bind(f.manager)
   f.manager.py=async(_t,script,args)=>{if(script.endsWith('bounded_chapter.py'))started.push(args[args.indexOf('--chapter')+1])}
   f.manager.acceptTranscriptionDelivery=async(t,id)=>{if(id==='001')return accept(t,id);accepted.push(id)}
   await assert.rejects(f.manager.perform(f.t,'transcribe',{concurrency}),e=>e.code==='CHAPTER_VALIDATION_PENDING')
   assert.deepEqual(started.sort(),['001','002','003','004']);assert.deepEqual(accepted.sort(),['002','003','004'])
   assert.equal(f.t.transcriptionDeliveries['001'].quality,'pending');assert.equal(f.t.transcriptionDeliveries['001'].attempts['1'].used,2)
  }finally{await f.close()}
 }
})

test('infrastructure failure stops unstarted chapters instead of draining queue',async()=>{
 const f=await fixture();try{
  f.t.inspection={verdict:'SCANNED'};f.t.stages={prepare:{state:'done'},images:{state:'done'}};f.t.worker={provider:'fake',model:'fake',timeout:1};f.t.phaseApproval={phase:'transcription',workerId:'fake:fake'}
  f.manager.active.set(ID,{cancel:false});f.manager.chapters=async()=>[{id:'001'},{id:'002'}];const started=[]
  f.manager.py=async(_t,script,args)=>{if(script.endsWith('bounded_chapter.py')){started.push(args[args.indexOf('--chapter')+1]);throw new Error('source snapshot changed')}}
  await assert.rejects(f.manager.perform(f.t,'transcribe',{concurrency:1}),/source snapshot changed/);assert.deepEqual(started,['001'])
 }finally{await f.close()}
})

test('explicit retry forwards only remaining non-exhausted page budgets in finished pending chapters',async()=>{
 const f=await fixture();try{
  f.t.inspection={verdict:'SCANNED'};f.t.stages={prepare:{state:'done'},images:{state:'done'}};f.t.worker={provider:'fake',model:'fake',timeout:1};f.t.phaseApproval={phase:'transcription',workerId:'fake:fake'}
  f.manager.chapters=async()=>[{id:'001'}];f.manager.acceptTranscriptionDelivery=async()=>{};const calls=[]
  f.manager.py=async(_t,script,args)=>{if(script.endsWith('bounded_chapter.py'))calls.push(args)}
  const folder=path.join(f.manager.aiDir(f.t),'delivery/chapter_001');await fs.mkdir(path.join(folder,'output'),{recursive:true})
  await fs.writeFile(path.join(folder,'state.json'),JSON.stringify({finished:true,attempts:{1:{used:1},2:{used:2},3:{used:1,models_exhausted:true}}}))
  await fs.writeFile(path.join(folder,'output/report.json'),JSON.stringify({quality_status:'pending'}))
  await f.manager.perform(f.t,'transcribe',{retryErrors:false});assert.equal(calls[0].includes('--pages'),false)
  await f.manager.perform(f.t,'transcribe',{retryErrors:true});assert.equal(calls[1][calls[1].indexOf('--pages')+1],'1')
 }finally{await f.close()}
})

test('passed chapters revalidate deliveries without dispatching a model worker',async()=>{
 const f=await fixture();try{
  f.t.inspection={verdict:'SCANNED'};f.t.stages={prepare:{state:'done'},images:{state:'done'}};f.t.worker={provider:'fake',model:'fake',timeout:1};f.t.phaseApproval={phase:'transcription',workerId:'fake:fake'}
  f.manager.chapters=async()=>[{id:'001'}]
  const folder=path.join(f.manager.aiDir(f.t),'delivery/chapter_001');await fs.mkdir(path.join(folder,'output'),{recursive:true})
  await fs.writeFile(path.join(folder,'state.json'),JSON.stringify({finished:true,attempts:{1:{used:2}}}))
  await fs.writeFile(path.join(folder,'output/report.json'),JSON.stringify({quality_status:'program_checks_passed'}))
  const commands=[],accepted=[]
  f.manager.py=async(_t,script)=>{if(script.endsWith('bounded_chapter.py'))throw new Error('model worker must not be dispatched')}
  f.manager.command=async(_t,_cmd,args)=>{commands.push(args)}
  f.manager.acceptTranscriptionDelivery=async(_t,id)=>{accepted.push(id)}
  await f.manager.perform(f.t,'transcribe',{})
  assert.equal(commands.length,1);assert.ok(commands[0][0].endsWith('verify_deliveries.py'));assert.deepEqual(commands[0].slice(-2),['--chapter','001']);assert.deepEqual(accepted,['001'])
 }finally{await f.close()}
})

test('source snapshot mismatch in a produced report is a fatal rather than chapter-local error',async()=>{
 const f=await fixture();try{
  const folder=path.join(f.manager.aiDir(f.t),'delivery/chapter_001');await fs.mkdir(path.join(folder,'output'),{recursive:true})
  await fs.writeFile(path.join(folder,'state.json'),JSON.stringify({finished:true,attempts:{}}))
  await fs.writeFile(path.join(folder,'output/report.json'),JSON.stringify({quality_status:'pending',input_protocol:{required:true,unverified_pages:[]},errors:["BLOCKED: source changed since this run's input snapshot; output retains the prior version"]}))
  await assert.rejects(f.manager.acceptTranscriptionDelivery(f.t,'001'),e=>e.code!=='CHAPTER_VALIDATION_PENDING'&&/输入快照/.test(e.message))
 }finally{await f.close()}
})
