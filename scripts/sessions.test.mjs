import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import { Readable } from 'node:stream'
import {TaskSessions,safeText,cliEvent,responseText} from '../modules/pipeline/sessions.js'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {taskRoutes} from '../modules/pipeline/routes.js'

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-sessions-')),agents=new Map(),bindings=[]
 const manager={root,dir:id=>path.join(root,id),aiDir:t=>path.join(root,t.id,'document/ai_convert'),active:new Map()}
 const task={id:randomUUID(),name:'Example book',input:{type:'pdf'},worker:{model:'actual-worker-model'},state:'idle',stage:'inspect',stages:{},message:'检查完成'}
 const host={agents:{get:id=>agents.get(id)},sessionController:{create:async({sessionId})=>{if(!agents.has(sessionId))agents.set(sessionId,{session:{log:[],append(type,data,opts){this.log.push({type,data,...opts})}}});return {sessionId}},rename:async()=>{}}}
 const monitor=new TaskSessions(manager,host,async(...args)=>bindings.push(args))
 return {root,manager,task,host,monitor,agents,bindings,close:async()=>{monitor.close();await fs.rm(root,{recursive:true,force:true})}}
}
test('one persistent trio per document, concurrent adoption and restart reuse the identities',async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.monitor.ensure(f.task),f.monitor.ensure(f.task)])
  assert.deepEqual(a.sessions,b.sessions);assert.equal(f.agents.size,3)
  const restarted=new TaskSessions(f.manager,f.host,async()=>{});assert.deepEqual((await restarted.ensure(f.task)).sessions,a.sessions)
  await f.monitor.authorize(f.task,'transcribe');assert.equal((await f.monitor.status(f.task.id)).authorizedStage,'transcribe')
  assert.ok(f.bindings.some(b=>b[0]===a.sessions.worker&&b[3]==='diagnose'))
 }finally{await f.close()}
})
test('worker and CLI records reach own sessions without injecting into the orchestrator',async()=>{
 const f=await fixture();try{
  const {sessions}=await f.monitor.ensure(f.task)
  await Promise.all([f.monitor.record(f.task,'worker','request-1','实际模型已经返回'),f.monitor.record(f.task,'worker','request-1','实际模型已经返回')])
  await f.monitor.record(f.task,'linguagacha','progress-1','完成 3/10')
  assert.equal(f.agents.get(sessions.orchestrator).session.log.filter(e=>e.type==='user/message').length,0)
  assert.equal(f.agents.get(sessions.worker).session.log.filter(e=>e.type==='user/message').length,2)
  assert.equal(f.agents.get(sessions.linguagacha).session.log.filter(e=>e.type==='user/message').length,2)
  assert.equal((await f.monitor.status(f.task.id)).recent.length,2)
  const last=f.agents.get(sessions.worker).session.log.at(-1);assert.equal(last.data.source.kind,'user');assert.match(last.data.source.rpcId,/paper-reader-execution:/);assert.equal(last.surfaceOp,'append')
 }finally{await f.close()}
})
test('isolated page-round request receipts are visible and provider error bodies stay private',async()=>{
 const f=await fixture();try{
  const {sessions}=await f.monitor.ensure(f.task)
  const dir=path.join(f.manager.aiDir(f.task),'delivery/chapter_001/attempts/page_001_round_1/book/ai_convert/requests')
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'request_123.json'),JSON.stringify({requested_model:'actual-worker-model',images:[{}],response:'实际转写内容',error:null}))
  await fs.writeFile(path.join(dir,'request_124.json'),JSON.stringify({error:{type:'HTTPError',body:'private-provider-body'}}))
  await f.monitor.scan(f.task);await f.monitor.scan(f.task)
  const logs=f.agents.get(sessions.worker).session.log.filter(e=>e.type==='user/message').slice(1)
  assert.equal(logs.length,2);assert.match(logs[0].data.content[0].text,/实际转写内容/);assert.ok(!JSON.stringify(logs).includes('private-provider-body'))
  const before=logs.length;f.task.stage='review';await f.monitor.scan(f.task);await f.monitor.observe(f.task);assert.equal(f.agents.get(sessions.worker).session.log.filter(e=>e.type==='user/message').slice(1).length,before)
 }finally{await f.close()}
})
test('a session that already has a turn is resumed instead of minting another session',async()=>{
 const f=await fixture();try{
  const {sessions}=await f.monitor.ensure(f.task)
  const workerId=sessions.worker
  f.agents.delete(workerId)
  let created=0
  f.host.sessionController.create=async()=>{created++}
  f.host.sessionController.resume=async sessionId=>{
   assert.equal(sessionId,workerId)
   f.agents.set(sessionId,{session:{log:[{type:'turn/start'}],append(type,data,opts){this.log.push({type,data,...opts})}}})
   return f.agents.get(sessionId)
  }
  await f.monitor.record(f.task,'worker','after-resume','模型已返回')
  assert.equal(created,0)
  assert.equal((await f.monitor.status(f.task.id)).error??null,null)
  assert.match(f.agents.get(workerId).session.log.at(-1).data.content[0].text,/模型已返回/)
 }finally{await f.close()}
})
test('a dropped worker agent is reattached by its stored session id before the record is written',async()=>{
 const f=await fixture();try{
  const {sessions}=await f.monitor.ensure(f.task)
  const workerId=sessions.worker
  f.agents.delete(workerId)
  let created=0
  const original=f.host.sessionController.create
  f.host.sessionController.create=async args=>{created++;assert.equal(args.sessionId,workerId);return original(args)}
  await f.monitor.record(f.task,'worker','after-drop','模型已返回')
  assert.equal(created,1)
  assert.ok(f.agents.get(workerId))
  assert.equal((await f.monitor.status(f.task.id)).error??null,null)
  assert.match(f.agents.get(workerId).session.log.at(-1).data.content[0].text,/模型已返回/)
 }finally{await f.close()}
})
test('ensure keeps the stored session when create rejects an already loaded duplicate',async()=>{
 const f=await fixture();try{
  const first=await f.monitor.ensure(f.task)
  f.host.sessionController.create=async({sessionId})=>{if(f.agents.has(sessionId))throw new Error('session exists');throw new Error('missing')}
  const again=await f.monitor.ensure(f.task)
  assert.deepEqual(again.sessions,first.sessions)
  assert.equal(f.agents.size,3)
 }finally{await f.close()}
})
test('session delivery failures are surfaced without marking model execution successful',async()=>{
 const f=await fixture();try{
  await f.monitor.ensure(f.task);f.host.agents.get=()=>null
  await f.monitor.attempt(()=>f.monitor.record(f.task,'worker','failed-delivery','请求已发出'),f.task.id)
  assert.match((await f.monitor.status(f.task.id)).error,/同步失败/)
  assert.equal((await f.monitor.status(f.task.id)).recent.length,0)
 }finally{await f.close()}
})
test('journal replay restores execution messages after a lost host checkpoint and flushes them',async()=>{
 const f=await fixture();try{
  let flushes=0;f.host.sessions={flush:async()=>{flushes++}}
  const {sessions}=await f.monitor.ensure(f.task)
  await f.monitor.record(f.task,'worker','real-result','模型已返回')
  f.agents.clear()
  const restored=new TaskSessions(f.manager,f.host,async()=>{});await restored.ensure(f.task)
  const log=f.agents.get(sessions.worker).session.log
  assert.equal(log.filter(e=>e.type==='user/message'&&e.data.content[0].text.includes('模型已返回')).length,1)
  await restored.ensure(f.task);assert.equal(log.filter(e=>e.type==='user/message'&&e.data.content[0].text.includes('模型已返回')).length,1);assert.ok(flushes>0)
 }finally{await f.close()}
})
test('credentials and unstructured CLI output are excluded from mirrored events',()=>{
 assert.ok(!safeText('Bearer SECRET_TOKEN api_key=OTHER_SECRET sk-abcdefghijk').includes('SECRET'))
 assert.equal(cliEvent('raw secret from stderr'),null)
 assert.deepEqual(cliEvent(JSON.stringify({type:'progress',stats:{completed:2,key:'PRIVATE'},authorization:'PRIVATE'})).stats,{completed:2})
 assert.equal(responseText({choices:[{message:{content:'output',reasoning_content:'internal-reasoning'}}]}),'output')
})
test('busy model sessions defer progress until tool calls and results have settled',async()=>{
 const f=await fixture();try{
  const {sessions}=await f.monitor.ensure(f.task);const orchestrator=f.agents.get(sessions.worker)
  const before=orchestrator.session.log.length;orchestrator.status='running'
  await f.monitor.record(f.task,'worker','request-during-tool','模型已返回')
  assert.equal(orchestrator.session.log.length,before);assert.ok(f.monitor.pending.has(f.task.id))
  assert.equal(f.agents.get(sessions.orchestrator).session.log.length,0)
  orchestrator.status='idle';await f.monitor.flushPending(f.task.id)
  assert.equal(orchestrator.session.log.length,before+1);assert.ok(!f.monitor.pending.has(f.task.id))
  await f.monitor.flushPending(f.task.id);assert.equal(orchestrator.session.log.length,before+1)
 }finally{await f.close()}
})
test('background command emits real worker and CLI lifecycle records while preserving stdout',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-command-'));const m=new TaskManager(root,path.join(root,'reading'),{cliExecutable:process.execPath})
 const records=[];m.save=async t=>t;m.sessionMonitor={record:async(_t,role,key,text)=>records.push({role,key,text}),attempt:async fn=>fn(),scan:async()=>{}}
 const t={id:randomUUID(),stage:'translate',log:[]}
 try{const out=await m.command(t,process.execPath,['-e','process.stdout.write(JSON.stringify({type:"progress",stats:{completed:3,total:10}})+"\\n");process.stdout.write(JSON.stringify({type:"finished",status:"done"})+"\\n")']);assert.match(out,/completed/);assert.ok(records.some(e=>e.text.includes('completed')));assert.ok(records.some(e=>e.key.endsWith('finish')));assert.equal(t.log[0].exitCode,0)}finally{await m.index.close();await fs.rm(root,{recursive:true,force:true})}
})
test('resetSessions safely rotates session identities without self-deadlock',async()=>{
 const f=await fixture();try{
  const initial=await f.monitor.ensure(f.task)
  assert.ok(initial.sessions.orchestrator)
  const resetRes=await f.monitor.resetSessions(f.task)
  assert.ok(resetRes.sessions.orchestrator)
  assert.notEqual(resetRes.sessions.orchestrator,initial.sessions.orchestrator)
  assert.equal(resetRes.previousSessions.orchestrator,initial.sessions.orchestrator)
 }finally{await f.close()}
})
test('entering review from earlier phase or explicit rotateOrchestrator creates a clean orchestrator while preserving worker and CLI sessions',async()=>{
 const f=await fixture();try{
  const archived=[],unregistered=[]
  f.host.workspaceRegistry={archiveSession:async id=>archived.push(id)}
  f.monitor.unregister=async id=>unregistered.push(id)
  const phase2=await f.monitor.authorize(f.task,'translate')
  await f.monitor.record(f.task,'worker','req-keep','保留转写日志')
  const phase2Orch=phase2.sessions.orchestrator,workerId=phase2.sessions.worker,cliId=phase2.sessions.linguagacha
  // Entering review automatically isolates from bloated transcription/translation context.
  const review1=await f.monitor.authorize(f.task,'review')
  assert.notEqual(review1.sessions.orchestrator,phase2Orch)
  assert.equal(review1.sessions.worker,workerId)
  assert.equal(review1.sessions.linguagacha,cliId)
  assert.equal(review1.previousOrchestrator,phase2Orch)
  assert.equal(review1.authorizedStage,'review')
  assert.deepEqual(archived,[phase2Orch])
  assert.deepEqual(unregistered,[phase2Orch])
  // Subsequent review authorizations reuse the clean review orchestrator.
  const review2=await f.monitor.authorize(f.task,'review')
  assert.equal(review2.sessions.orchestrator,review1.sessions.orchestrator)
  // Explicit rotateOrchestrator rotates again on demand without clearing worker logs.
  const review3=await f.monitor.rotateOrchestrator(f.task,'review')
  assert.notEqual(review3.sessions.orchestrator,review1.sessions.orchestrator)
  assert.equal(review3.sessions.worker,workerId)
  assert.deepEqual(review3.previousOrchestrators,[phase2Orch,review1.sessions.orchestrator])
  assert.equal((await f.monitor.status(f.task.id)).recent.length,1)
 }finally{await f.close()}
})
test('POST /pipeline/tasks/:id/sessions rotates orchestrator on resetOrchestrator and rejects while active',async()=>{
 const f=await fixture();try{
  f.manager.get=async id=>{assert.equal(id,f.task.id);return f.task}
  f.manager.sessionMonitor=f.monitor
  const route=taskRoutes(f.manager,async()=>{}).find(r=>r.method==='POST'&&r.pattern.test(`/pipeline/tasks/${f.task.id}/sessions`))
  const invoke=async body=>{
   const req=Readable.from([Buffer.from(JSON.stringify(body))])
   let status=200,raw=''
   const res={writeHead:code=>{status=code},end:chunk=>{raw=String(chunk??'')}}
   const m=`/pipeline/tasks/${f.task.id}/sessions`.match(route.pattern)
   await route.handler(req,res,new URL('http://local'),m)
   return {status,json:JSON.parse(raw)}
  }
  const initial=await invoke({stage:'review'})
  assert.equal(initial.status,200)
  const rotated=await invoke({stage:'review',resetOrchestrator:true})
  assert.notEqual(rotated.json.sessions.orchestrator,initial.json.sessions.orchestrator)
  assert.equal(rotated.json.sessions.worker,initial.json.sessions.worker)
  assert.equal(rotated.json.previousOrchestrator,initial.json.sessions.orchestrator)
  f.manager.active.set(f.task.id,true)
  await assert.rejects(()=>invoke({stage:'review',resetOrchestrator:true}),/任务运行中不能更换编排会话/)
 }finally{await f.close()}
})
test('Python observer preserves one underlying call, its arguments and return value',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-worker-observer-'))
 try{
  await fs.writeFile(path.join(root,'worker_call.py'),'def call_api(config, prompt, images):\n assert config == {"model": "fixture-model"}\n assert prompt == "fixture-prompt"\n assert images == []\n return "fixture-result"\n')
  const script=path.join(root,'bounded_chapter.py')
  await fs.writeFile(script,'import worker_call\nresult=worker_call.call_api({"model":"fixture-model"}, "fixture-prompt", [])\nassert result == "fixture-result"\nprint("original-completed")\n')
  const output=execFileSync('/opt/homebrew/bin/python3',[fileURLToPath(new URL('../runtime/observe_worker.py',import.meta.url)),script],{encoding:'utf8'})
  const events=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
  assert.deepEqual(events.map(e=>e.event),['request_started','response_received']);assert.equal(events[0].requestId,events[1].requestId);assert.equal(events[1].response,'fixture-result');assert.match(output,/original-completed/)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('rotateOrchestrator aborts old session and guard tells superseded orchestrator to stop immediately',async()=>{
 const f=await fixture(),disposers=[];try{
  const {installPipelineModule}=await import('../modules/pipeline/index.js')
  const aborted=[]
  let guardFn,toolDef
  const ctx={
   inject:(deps,cb)=>{
    if(deps.includes('sessionController')&&deps.includes('agents')){
     cb({...f.host,sessionController:{...f.host.sessionController,abort:async({sessionId})=>aborted.push(sessionId)},workspaceRegistry:{archiveSession:async()=>{}}})
    }
   },
   on:(ev,fn)=>{if(ev==='dispose')disposers.push(fn)},
   tools:{guard:fn=>{guardFn=fn},register:d=>{toolDef=d}}
  }
  installPipelineModule(ctx,{pipelineWorkspace:f.root})
  const taskDir=path.join(f.root,'.pipeline/tasks',f.task.id)
  await fs.mkdir(taskDir,{recursive:true})
  await fs.writeFile(path.join(taskDir,'task.json'),JSON.stringify(f.task))
  const monitor=new TaskSessions({root:f.root,dir:id=>path.join(f.root,'.pipeline/tasks',id),aiDir:t=>path.join(f.root,'.pipeline/tasks',t.id,'document/ai_convert'),active:new Map()},{...f.host,sessionController:{...f.host.sessionController,abort:async({sessionId})=>aborted.push(sessionId)}},async(sid,tid,mode,stage)=>{
   const map=JSON.parse(await fs.readFile(path.join(f.root,'.pipeline/dsh-task-sessions.json'),'utf8').catch(()=>'{}'))
   map[sid]=tid;await fs.mkdir(path.join(f.root,'.pipeline'),{recursive:true});await fs.writeFile(path.join(f.root,'.pipeline/dsh-task-sessions.json'),JSON.stringify(map))
  })
  // Exercise real installed monitor via route / direct rotate
  const initial=await monitor.ensure(f.task)
  const oldOrch=initial.sessions.orchestrator
  let agentAborted=0
  f.agents.get(oldOrch).abort=()=>{agentAborted++}
  const rotated=await monitor.rotateOrchestrator(f.task,'transcribe')
  assert.notEqual(rotated.sessions.orchestrator,oldOrch)
  assert.equal(agentAborted,1)
  assert.ok(aborted.includes(oldOrch))
 }finally{for(const d of disposers)await d();await f.close()}
})
test('observer-wrapped bounded_chapter logs target script name and strips observer prompt JSON from diagnostics',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-observer-diag-'))
 const m=new TaskManager(root,path.join(root,'reading'),{python:process.execPath})
 m.save=async t=>t
 m.sessionMonitor={record:async()=>{},attempt:async fn=>fn(),scan:async()=>{}}
 const scriptDir=path.join(root,'.kimi-code/skills/fnm-ai-convert/scripts')
 await fs.mkdir(scriptDir,{recursive:true})
 const t={id:randomUUID(),stage:'transcribe',log:[]}
 try{
  await assert.rejects(
   m.rawCommand(t,process.execPath,[
    path.join(root,'observe_worker.py'),
    path.join(scriptDir,'bounded_chapter.py'),
    '-e',
   ],{}).catch(async()=>{
    return m.rawCommand(t,process.execPath,[
     '-e',
     'console.log(JSON.stringify({type:"paper-reader-worker",event:"request_started",prompt:"LONG_RAW_PROMPT_TEXT"}));process.exit(1)',
    ])
   }),
   /未通过/,
  )
  assert.equal(t.log[0].command,'bounded_chapter.py')
  assert.equal(t.log[1].diagnostic,undefined)
 }finally{await m.index.close();await fs.rm(root,{recursive:true,force:true})}
})
