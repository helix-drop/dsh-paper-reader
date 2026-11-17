import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {assertPhaseApproved} from '../modules/pipeline/phases.js'
import {hash} from '../modules/pipeline/markdown.js'
import {taskRoutes} from '../modules/pipeline/routes.js'
import {Readable} from 'node:stream'

async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reader-phases-')))
 const status={model:{name:'fixture-channel',model:'fixture-model',credentialConfigured:true},preprocessing:{cleanRuby:false}}
 const manager=new TaskManager(root,path.join(root,'reading'),{cliStatus:async()=>status})
 const file=path.join(root,'source.pdf');await fs.writeFile(file,'source')
 const task={id:randomUUID(),name:'Phase fixture',kind:'paper',createdAt:new Date().toISOString(),input:{type:'pdf',fingerprint:hash('source')},path:file,worker:{provider:'fixture',model:'vision'},profile:{confirmed:true,source_fingerprint:hash('source')},state:'idle',stage:'inspect',stages:{},log:[]}
 await manager.save(task)
 return {root,status,manager,task,close:async()=>{await manager.index.close();await fs.rm(root,{recursive:true,force:true})}}
}
const reviewConfig={orchestratorModel:'fixture/review',orchestratorEffort:'high',workerModel:'inherit'}

test('explicit Antigravity continuation revisits review even when an old report was registered',async()=>{
 const f=await fixture();try{
  f.task.stages.translationCheck={state:'done'};f.task.stages.review={state:'done'};await f.manager.save(f.task)
  await f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig,publishAccepted:true})
  const calls=[];f.manager.performBody=async(t,stage,options)=>{calls.push(stage);if(stage==='review')assert.equal(options.runAgy,true);if(stage==='publish')t.publication={published:true}}
  await f.manager.start(f.task.id,'review',{runAgy:true});await f.manager.active.get(f.task.id)?.promise
  assert.deepEqual(calls,['review'])
  assert.equal((await f.manager.get(f.task.id)).publication,undefined)
 }finally{await f.close()}
})

test('legacy task and session registration cannot start an unconfirmed phase',async()=>{
 const f=await fixture();try{
  let calls=0;f.manager.performBody=async()=>{calls++}
  const route=taskRoutes(f.manager,async()=>{}) .find(r=>r.pattern.test('/pipeline/tasks/'+f.task.id+'/session'))
  await route.handler(Readable.from([JSON.stringify({sessionId:'old-session',stage:'translate'})]),{writeHead(){},end(){}},null,[null,f.task.id])
  for(const stage of ['inspect','transcribe','glossary','translate','review','publish'])await assert.rejects(f.manager.start(f.task.id,stage),/面板选择模型并确认/)
  for(const method of ['prepareReviewAudit','assembleReviewAudit','applyReviewAudit','runAgyReviewAudit'])await assert.rejects(f.manager[method](f.task.id),/面板选择模型并确认/)
  assert.equal(calls,0);assert.equal(f.manager.active.size,0);assert.equal((await f.manager.get(f.task.id)).phaseApproval,undefined)
 }finally{await f.close()}
})

test('confirmation checks prerequisites, chosen models and explicit publication consent',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.manager.confirmPhase(f.task.id,{phase:'translation',orchestratorModel:'fixture/orchestrator'}),/先完成转写/)
  await assert.rejects(f.manager.confirmPhase(f.task.id,{phase:'transcription',workerId:'fixture:vision'}),/请选择本阶段的编排模型/)
  f.task.stages.translationCheck={state:'done'};await f.manager.save(f.task)
  assert.equal((await f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig})).phaseApproval.publishAccepted,false)
  await assert.rejects(f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig:{},publishAccepted:true}),/请选择审校模型/)
  const approved=await f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig,publishAccepted:true})
  assert.equal(assertPhaseApproved(approved,'review'),'delivery')
  assert.throws(()=>assertPhaseApproved(approved,'publish'),/确认/)
  await assert.rejects(f.manager.publish(f.task.id,false),/确认发布/)
  approved.reviewConfig={...reviewConfig,workerModel:'flash'}
  assert.throws(()=>assertPhaseApproved(approved,'review'),/审校模型已变化/)
 }finally{await f.close()}
})

test('phase approval persists across reload but does not authorize the next phase',async()=>{
 const f=await fixture();let reloaded;try{
  const approved=await f.manager.confirmPhase(f.task.id,{phase:'transcription',orchestratorModel:'fixture/orchestrator',workerId:'fixture:vision',fallbackIds:[]})
  assert.ok(approved.phaseApproval.confirmedAt)
  reloaded=new TaskManager(f.root,path.join(f.root,'reading'))
  const saved=await reloaded.get(f.task.id)
  assert.equal(assertPhaseApproved(saved,'verify'),'transcription')
  assert.throws(()=>assertPhaseApproved(saved,'glossary'),/面板选择模型并确认/)
  saved.worker.fallbacks=[{provider:'fixture',model:'other'}]
  assert.throws(()=>assertPhaseApproved(saved,'transcribe'),/兜底模型已变化/)
 }finally{await reloaded?.index.close();await f.close()}
})

test('translation confirmation runs glossary and translation once and stops before review',async()=>{
 const f=await fixture();try{
  f.task.stages.assemble={state:'done'};await f.manager.save(f.task)
  const approved=await f.manager.confirmPhase(f.task.id,{phase:'translation',orchestratorModel:'fixture/orchestrator'})
  assert.deepEqual(approved.phaseApproval.translationModel,{name:'fixture-channel',model:'fixture-model'})
  assert.equal(approved.profile.glossary_model,'fixture-model');assert.equal(approved.profile.translation_model,'fixture-model')
  const calls=[];f.manager.requireGlossary=async()=>{};f.manager.performBody=async(_t,stage)=>{calls.push(stage)}
  await f.manager.start(f.task.id,'translate');await f.manager.active.get(f.task.id)?.promise
  assert.deepEqual(calls,['glossary','lgProject','translate','translationCheck'])
  const saved=await f.manager.get(f.task.id);assert.equal(saved.stages.review,undefined)
  await assert.rejects(f.manager.start(f.task.id,'review'),/面板选择模型并确认/)
  await f.manager.start(f.task.id,'translate');await f.manager.active.get(f.task.id)?.promise
  assert.equal(calls.length,4,'completed steps must not call models again')
 }finally{await f.close()}
})

test('changed translation model is rejected before model dispatch',async()=>{
 const f=await fixture();try{
  f.task.stages.assemble={state:'done'};await f.manager.save(f.task)
  const approved=await f.manager.confirmPhase(f.task.id,{phase:'translation',orchestratorModel:'fixture/orchestrator'})
  let calls=0;f.manager.performBody=async()=>{calls++};f.status.model.model='unexpected-model'
  await assert.rejects(f.manager.perform(approved,'glossary'),/模型已变化/)
  await assert.rejects(f.manager.perform(approved,'translate'),/模型已变化/)
  assert.equal(calls,0)
 }finally{await f.close()}
})

test('review uses confirmed model and failure prevents publication',async()=>{
 const f=await fixture();try{
  f.task.stages.translationCheck={state:'done'};await f.manager.save(f.task)
  const approved=await f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig,publishAccepted:true})
  const calls=[];f.manager.performBody=async(_t,stage,options)=>{calls.push(stage);assert.equal(options.model,reviewConfig.orchestratorModel);assert.equal(options.effort,'high');throw new Error('unresolved review issue')}
  await assert.rejects(f.manager.perform(approved,'review',{model:'other',effort:'low'}),/unresolved review issue/)
  calls.length=0
  await f.manager.start(f.task.id,'review');await f.manager.active.get(f.task.id)?.promise
  assert.deepEqual(calls,['review']);const saved=await f.manager.get(f.task.id)
  assert.equal(saved.state,'blocked');assert.equal(saved.publication,undefined);assert.equal(saved.stages.publish,undefined)
 }finally{await f.close()}
})


test('resume confirms a new worker and reasoning effort while skipping completed stages',async()=>{
 const f=await fixture();let reloaded;try{
  f.task.state='paused';f.task.stage='transcribe'
  for(const stage of ['inspect','normalize','images','prepare'])f.task.stages[stage]={state:'done'}
  f.task.stages.transcribe={state:'stopped'}
  await f.manager.save(f.task)
  const validated=[]
  f.manager.modelService={validate:async choice=>{validated.push(choice);if(choice.reasoningEffort&&!['high','low'].includes(choice.reasoningEffort))throw new Error('unsupported effort')}}
  const choices={phase:'transcription',orchestratorModel:'fixture/orchestrator',orchestratorEffort:'high',workerId:'fixture:new-vision',fallbackIds:[]}
  await assert.rejects(f.manager.confirmPhase(f.task.id,{...choices,orchestratorEffort:'invalid'}),/unsupported effort/)
  assert.equal((await f.manager.get(f.task.id)).worker.model,'vision')
  const approved=await f.manager.confirmPhase(f.task.id,choices)
  assert.equal(approved.phaseApproval.orchestratorEffort,'high')
  assert.equal(assertPhaseApproved(approved,'transcribe'),'transcription')
  assert.ok(validated.some(c=>c.model==='orchestrator'&&c.reasoningEffort==='high'))
  reloaded=new TaskManager(f.root,path.join(f.root,'reading'))
  assert.equal((await reloaded.get(f.task.id)).phaseApproval.orchestratorEffort,'high')
  const calls=[]
  f.manager.performBody=async(t,stage)=>{calls.push(stage);assert.equal(t.worker.model,'new-vision')}
  await f.manager.start(f.task.id,'transcribe');await f.manager.active.get(f.task.id)?.promise
  assert.deepEqual(calls,['transcribe','verify','assemble'])
 }finally{await reloaded?.index.close();await f.close()}
})
