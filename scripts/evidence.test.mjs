import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {evidenceSummary,evidenceFiles,evidenceSearch,taskSummary} from '../modules/pipeline/evidence.js'
import {sessionGuard} from '../modules/pipeline/guard.js'
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reader-evidence-'))),dir=path.join(root,'task'),ai=path.join(dir,'document/ai_convert'),chapter=path.join(ai,'delivery/chapter_001'),book=path.join(chapter,'selected/book')
 await fs.mkdir(path.join(book,'ai_convert/actions'),{recursive:true});await fs.mkdir(path.join(chapter,'output'),{recursive:true})
 const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2))
 await write(path.join(ai,'chapters.json'),[{id:'001',title:'Front matter',start_page:1,end_page:5}])
 await write(path.join(chapter,'state.json'),{book,finished:true,attempts:{1:{used:3,needs_repair:true,history:[{state:'retained_previous',outcome:'uncertain'}]}}})
 await write(path.join(chapter,'output/report.json'),{quality_status:'pending',delivery_status:'produced',errors:['BLOCKED: <book>/ai_convert/actions/chapter_001.json'],regional_results:Array(1000).fill('unneeded detail')})
 await write(path.join(book,'ai_convert/actions/chapter_001.json'),{pages:[1],reasons:['SUSPICIOUS: gap']})
 const manager={dir:()=>dir,aiDir:()=>ai},task={id:'test',state:'blocked',stage:'transcribe'}
 return {root,dir,ai,book,chapter,manager,task,close:()=>fs.rm(root,{recursive:true,force:true})}
}
test('evidence resolves isolated selected book instead of guessing document root; omits bulk report data',async()=>{
 const f=await fixture();try{
  const result=await evidenceSummary(f.manager,f.task),c=result.chapters[0]
  assert.equal(c.paths.selectedBook,f.book);assert.equal(c.paths.actions,path.join(f.book,'ai_convert/actions/chapter_001.json'));assert.equal(c.paths.similarity,null)
  assert.equal(c.executionFinished,true);assert.equal(c.qualityStatus,'pending');assert.equal(c.pageBudgets[0].used,3)
  assert.ok(!JSON.stringify(result).includes('unneeded detail'));assert.ok(JSON.stringify(result).length<4000)
  assert.equal((await evidenceSummary(f.manager,f.task,{chapterId:'002'})).chapters.length,0)
  assert.deepEqual(await evidenceSummary(f.manager,f.task,{chapterId:'chapter_001'}),await evidenceSummary(f.manager,f.task,{chapterId:'001'}))
  await assert.rejects(evidenceSummary(f.manager,f.task,{chapterId:'chapter_001/../../outside'}),/编号无效/)
  await assert.rejects(evidenceSummary(f.manager,f.task,{chapterId:'../../outside'}),/编号无效/)
 }finally{await f.close()}
})
test('task-only file browsing paginates and rejects escape paths, links and credential files',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.dir,'.env'),'secret');await fs.symlink(f.root,path.join(f.dir,'outside'))
  await fs.writeFile(path.join(f.dir,'a.txt'),'one');await fs.writeFile(path.join(f.dir,'b.txt'),'two')
  const first=await evidenceFiles(f.dir,{limit:1});assert.equal(first.files.length,1);assert.equal(first.nextOffset,1)
  const all=await evidenceFiles(f.dir);assert.ok(!all.files.some(e=>['.env','outside'].includes(e.name)))
  await assert.rejects(evidenceFiles(f.dir,{directory:'..'}),/当前任务/)
  await assert.rejects(evidenceFiles(f.dir,{directory:'outside'}),/任务目录之外/)
  await assert.rejects(evidenceSearch(f.dir,{file:'.env',query:'secret'}),/非凭证/)
  await fs.symlink(path.join(f.dir,'.env'),path.join(f.dir,'alias.txt'));await assert.rejects(evidenceSearch(f.dir,{file:'alias.txt',query:'secret'}),/凭证/)
  await assert.rejects(evidenceSearch(f.dir,{file:'outside/a.txt',query:'one'}))
 }finally{await f.close()}
})
test('file search returns bounded relevant lines with a resumable cursor',async()=>{
 const f=await fixture();try{
  const file=path.join(f.dir,'sample.jsonl');await fs.writeFile(file,'no match\nneedle first\n'+('x'.repeat(1500))+'needle second\nneedle third\n')
  const first=await evidenceSearch(f.dir,{file,query:'needle',limit:2});assert.deepEqual(first.matches.map(m=>m.line),[2,3]);assert.equal(first.nextOffset,3);assert.ok(first.matches[1].text.length<=600);assert.ok(first.matches[1].text.includes('needle'))
  const second=await evidenceSearch(f.dir,{file,query:'needle',offset:first.nextOffset});assert.deepEqual(second.matches.map(m=>m.line),[4]);assert.equal(second.nextOffset,null)
  const piped=await evidenceSearch(f.dir,{file,query:'needle first|needle third'});assert.deepEqual(piped.matches.map(m=>m.line),[2,4])
 }finally{await f.close()}
})
test('task summary excludes full census, delivery histories and logs but preserves runtime configuration',()=>{
 const t={id:'one',worker:{model:'actual-model'},profile:{language:'en'},inspection:{verdict:'BORN-DIGITAL',pages:338,fingerprint:'hash',page_reports:Array(338).fill('bulk')},transcriptionDeliveries:{raw:'bulk'},log:['bulk']}
 const summary=taskSummary(t);assert.equal(summary.inspection.pages,338);assert.equal(summary.worker.model,'actual-model');assert.equal(summary.profile.language,'en');assert.ok(!JSON.stringify(summary).includes('bulk'))
})
test('observation sessions can inspect evidence but cannot run stages',async()=>{
 const f=await fixture();try{
  const exec={name:'document_pipeline',arguments:{action:'files'},agent:{session:{header:{cwd:f.root,agentPreset:'reading-document',origin:'subagent',delegationDepth:1}}}}
  assert.equal(sessionGuard(f.root,exec,{taskDirectory:f.dir,authorizedStage:'diagnose'}),undefined)
  exec.arguments.action='run';assert.match(sessionGuard(f.root,exec,{taskDirectory:f.dir,authorizedStage:'diagnose'}),/不能启动/)
 }finally{await f.close()}
})
test('registered document_pipeline exposes evidence actions only to its bound task session',async()=>{
 const f=await fixture(),disposers=[];try{
  const {installPipelineModule}=await import('../modules/pipeline/index.js')
  const id='11111111-1111-4111-8111-111111111111',sessionId='session-evidence-test',taskDir=path.join(f.root,'.pipeline/tasks',id)
  await fs.mkdir(taskDir,{recursive:true});await fs.writeFile(path.join(taskDir,'task.json'),JSON.stringify({...f.task,id,input:{type:'markdown'},name:'fixture',stages:{}}))
  await fs.writeFile(path.join(f.root,'.pipeline/dsh-task-sessions.json'),JSON.stringify({[sessionId]:id}))
  let definition;const ctx={inject:()=>{},on:(event,fn)=>{if(event==='dispose')disposers.push(fn)},tools:{guard:()=>{},register:d=>{definition=d}}}
  installPipelineModule(ctx,{pipelineWorkspace:f.root})
  const exec={agent:{session:{id:sessionId,header:{cwd:f.root,agentPreset:'reading-document'}}}}
  assert.ok(definition.parameters.properties.action.enum.includes('evidence'));assert.ok(definition.parameters.properties.action.enum.includes('files'));assert.ok(definition.parameters.properties.action.enum.includes('search'))
  const result=await definition.execute({action:'files',taskId:id},exec);assert.equal(result.files[0].name,'task.json')
  const omittedTask=await definition.execute({action:'task'},exec);assert.equal(omittedTask.id,id)
  const omittedFiles=await definition.execute({action:'files'},exec);assert.equal(omittedFiles.files[0].name,'task.json')
  const summary=await definition.execute({action:'task',taskId:id},exec);assert.ok(summary.evidenceTools.locate.includes('files'))
  await assert.rejects(definition.execute({action:'files',taskId:'wrong-task'},exec),/未绑定/)
  await assert.rejects(definition.execute({action:'task'},{agent:{session:{id:'unbound-session',header:{cwd:f.root,agentPreset:'reading-document'}}}}),/未绑定/)
 }finally{for(const dispose of disposers)await dispose();await f.close()}
})
test('file name filtering precedes pagination and never returns private files or links',async()=>{
 const f=await fixture();try{
  for(const name of ['page_001.json','page_002.json','page_424.json','page_425.json','.env.page_424'])await fs.writeFile(path.join(f.dir,name),'{}')
  await fs.symlink(path.join(f.dir,'page_424.json'),path.join(f.dir,'page_424-link.json'))
  const one=await evidenceFiles(f.dir,{query:'page_424'});assert.equal(one.total,1);assert.equal(one.files[0].name,'page_424.json')
  const first=await evidenceFiles(f.dir,{query:'page_42',limit:1});assert.equal(first.total,2);assert.equal(first.nextOffset,1)
  const second=await evidenceFiles(f.dir,{query:'page_42',offset:first.nextOffset,limit:1});assert.equal(second.files[0].name,'page_425.json')
  await assert.rejects(evidenceFiles(f.dir,{query:4}),/文件名筛选/)
 }finally{await f.close()}
})
