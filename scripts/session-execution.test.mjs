import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {executeInSession} from '../modules/pipeline/session-execution.js'

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-session-execution-'))
 const manager=new TaskManager(root,path.join(root,'reading'))
 const task={id:randomUUID(),name:'Session ownership',kind:'book',createdAt:new Date().toISOString(),input:{type:'markdown'},state:'idle',stage:'inspect',stages:{},phaseApproval:{phase:'transcription',workerId:'undefined:undefined'},log:[]}
 await fs.mkdir(manager.dir(task.id),{recursive:true});await manager.save(task)
 const controller=new AbortController(),exec={agent:{session:{id:'real-orchestrator'}},signal:controller.signal}
 return {manager,task,exec,controller,close:async()=>{await manager.index.close();await fs.rm(root,{recursive:true,force:true})}}
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}

test('native session run waits for actual completion and joins without launching twice',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();let calls=0,returned=false
 try{
  f.manager.perform=async()=>{calls++;entered.resolve();await release.promise}
  const run=()=>executeInSession(f.manager,f.task.id,'inspect',{singleStep:true},f.exec)
  const first=run().then(r=>{returned=true;return r});await entered.promise
  assert.equal(returned,false)
  const second=run();await new Promise(r=>setImmediate(r));assert.equal(calls,1)
  await assert.rejects(executeInSession(f.manager,f.task.id,'inspect',{}, {agent:{session:{id:'other'}}}),/其他执行请求/)
  release.resolve();const [a,b]=await Promise.all([first,second])
  assert.equal(a.completed,true);assert.equal(b.state,'idle');assert.equal(a.execution.sessionId,'real-orchestrator');assert.ok(a.execution.endedAt)
 }finally{release.resolve();await f.close()}
})
test('program failure returns blocked evidence to the owning session',async()=>{
 const f=await fixture();try{
  f.manager.perform=async()=>{throw new Error('fixture delivery rejected')}
  const result=await executeInSession(f.manager,f.task.id,'inspect',{singleStep:true},f.exec)
  assert.equal(result.completed,false);assert.equal(result.state,'blocked');assert.equal(result.stages.inspect.state,'blocked');assert.match(result.message,/delivery rejected/)
 }finally{await f.close()}
})
test('stopping session cancels the owned program and waits for its cleanup',async()=>{
 const f=await fixture(),entered=deferred();let cleaned=false
 try{
  f.manager.perform=async()=>{entered.resolve();while(!f.manager.active.get(f.task.id).cancel)await new Promise(r=>setTimeout(r,5));cleaned=true;throw new Error('cancelled')}
  const result=executeInSession(f.manager,f.task.id,'inspect',{singleStep:true},f.exec)
  await entered.promise;f.controller.abort()
  const final=await result;assert.equal(cleaned,true);assert.equal(final.state,'paused');assert.equal(final.interrupted,true);assert.equal(f.manager.active.size,0)
 }finally{await f.close()}
})
test('already stopped session cannot launch any work',async()=>{
 const f=await fixture();try{
  let calls=0;f.manager.perform=async()=>{calls++};f.controller.abort()
  await assert.rejects(executeInSession(f.manager,f.task.id,'inspect',{},f.exec),{name:'AbortError'});assert.equal(calls,0)
 }finally{await f.close()}
})

test('verify never expands into transcription or translation even with incomplete earlier stages',async()=>{
 const f=await fixture();try{
  f.task.input={type:'pdf'};f.task.stages.transcribe={state:'blocked'};await f.manager.save(f.task)
  f.manager.confirmed=async()=>{}
  const calls=[];f.manager.perform=async(_task,stage)=>{calls.push(stage)}
  const result=await executeInSession(f.manager,f.task.id,'verify',{},f.exec)
  assert.deepEqual(calls,['verify']);assert.equal(result.stages.transcribe.state,'blocked');assert.equal(result.stages.verify,undefined)
  const second=await executeInSession(f.manager,f.task.id,'verify',{},f.exec)
  assert.deepEqual(calls,['verify','verify']);assert.equal(second.stages.verify,undefined)
 }finally{await f.close()}
})

