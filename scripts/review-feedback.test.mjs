import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {reviewFeedback,reviewPacketCounts,agyTranscriptEvents,agyActivity} from '../modules/pipeline/review-feedback.js'

test('review counts separate validity, unresolved findings and replaced results',()=>{
 const manifest=['001','002','003','004','005','006'].map(id=>({id})),old={mtimeMs:10,size:4}
 const validation={validPackets:['001','002','003'],unresolved:[{packet:'002'}],errors:[{packet:'004'}],resultVersions:{'001':old,'002':old,'003':old,'004':old}}
 const f=reviewPacketCounts(manifest,validation,{'001':old,'002':old,'003':{...old,mtimeMs:20},'004':old,'005':old})
 assert.equal(f.passedPackets,1);assert.equal(f.unresolvedPackets,1);assert.equal(f.invalidPackets,1);assert.equal(f.awaitingValidationPackets,2);assert.equal(f.missingPackets,1);assert.equal(f.receivedPackets,5)
 // Older audits use their validation timestamp, never claim newer files passed.
 assert.equal(reviewPacketCounts(manifest,{validPackets:['001','003']},{'001':old,'003':{...old,mtimeMs:20}},15).passedPackets,1)
})

test('public feedback omits private reasoning, input, raw output and tool arguments',()=>{
 const rows=[{source:'USER_EXPLICIT',type:'USER_INPUT',content:'private prompt'},
  {source:'MODEL',type:'PLANNER_RESPONSE',step_index:1,created_at:'2026-10-19T05:02:33Z',thinking:'private reasoning',content:'正在审校 Bearer abcdef12345',tool_calls:[{name:'view_file',args:{toolSummary:'"查看第 007 包"',AbsolutePath:'private path'}}]},
  {source:'MODEL',type:'GENERIC',content:'private raw output'},
  {source:'SYSTEM',type:'ERROR_MESSAGE',step_index:2,error:'stream idle timeout'}]
 const out=agyTranscriptEvents(rows.map(JSON.stringify).join('\n')+'\n{partial')
 assert.equal(out.length,3);assert.equal(out[1].text,'view_file · 查看第 007 包');assert.equal(out[2].kind,'error');assert.equal(out[2].text,'stream idle timeout')
 assert(!JSON.stringify(out).includes('private'));assert(!JSON.stringify(out).includes('abcdef12345'))
})

test('in-flight legacy CLI is discovered by task and start time without changing files or invoking models',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-feedback-')),cliHome=path.join(root,'cli'),auditDir=path.join(root,'audit'),id='test-task',cid='3596b15a-dc0f-4982-b6a4-7c651bf9fffc'
 const manager={dir:()=>path.join(root,'task'),start:()=>assert.fail('must not start'),save:()=>assert.fail('must not save')}
 try{
  await fs.mkdir(path.join(cliHome,'log'),{recursive:true});await fs.mkdir(path.join(auditDir,'results'),{recursive:true})
  const started=new Date(2026,9,19,13,2,21),t={id,state:'running',stage:'review',reviewAudit:{auditDir},reviewProgress:{startedAt:started.toISOString()},reviewConfig:{orchestratorModel:'selected-model'}}
  const log=path.join(cliHome,'log/cli-20261019_130222.log')
  await fs.writeFile(log,`server workspaceDirs=[${manager.dir()}]\nPrint mode: conversation=${cid}, sending message\n`)
  await fs.writeFile(path.join(cliHome,'log/cli-20261019_130223.log'),'workspaceDirs=[other-task]\nPrint mode: conversation=11111111-1111-1111-1111-111111111111, sending message\n')
  const transcript=path.join(cliHome,'brain',cid,'.system_generated/logs/transcript.jsonl');await fs.mkdir(path.dirname(transcript),{recursive:true})
  await fs.writeFile(transcript,JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',step_index:1,content:'正在审校',created_at:started.toISOString()})+'\n')
  await fs.writeFile(path.join(auditDir,'manifest.json'),JSON.stringify([{id:'001'},{id:'002'}]))
  await fs.writeFile(path.join(auditDir,'results/001.json'),'{}');const stat=await fs.stat(path.join(auditDir,'results/001.json'))
  const validation=JSON.stringify({validPackets:['001'],resultVersions:{'001':{mtimeMs:stat.mtimeMs,size:stat.size}}});await fs.writeFile(path.join(auditDir,'validation.json'),validation)
  const before=JSON.stringify(t),f=await reviewFeedback(manager,t,{cliHome})
  assert.equal(f.conversationId,cid);assert.equal(f.passedPackets,1);assert.equal(f.missingPackets,1);assert.equal(f.events[0].text,'正在审校');assert.equal(f.model,'selected-model')
  assert.equal(JSON.stringify(t),before);assert.equal(await fs.readFile(path.join(auditDir,'validation.json'),'utf8'),validation)
  await fs.writeFile(transcript,JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',step_index:2,content:'新反馈'})+'\n')
  assert.equal((await reviewFeedback(manager,t,{cliHome})).events[0].text,'新反馈')
  t.state='interrupted';assert.equal((await reviewFeedback(manager,t,{cliHome})).status,'interrupted')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('ambiguous matching logs never attach a different conversation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-links-')),manager={dir:()=>'/same-task'},started=new Date(2026,9,19,13,2,21)
 try{
  await fs.mkdir(path.join(root,'log'),{recursive:true})
  for(const [time,id] of [['130222','11111111-1111-1111-1111-111111111111'],['130223','22222222-2222-2222-2222-222222222222']])await fs.writeFile(path.join(root,'log','cli-20261019_'+time+'.log'),`workspaceDirs=[/same-task]\nPrint mode: conversation=${id}, sending message\n`)
  const result=await reviewFeedback(manager,{id:'x',reviewProgress:{startedAt:started.toISOString()}},{cliHome:root})
  assert.equal(result.conversationId,null);assert.equal(result.feedbackAvailable,false)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('idle activity includes only this invocation and its children, not errors or log heartbeats',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agy-activity-')),parent='11111111-1111-1111-1111-111111111111',child='22222222-2222-2222-2222-222222222222',other='33333333-3333-3333-3333-333333333333',manager={dir:()=>root}
 const started=Date.parse('2026-10-19T06:00:00Z'),task={id:'task',reviewProgress:{conversationId:parent,startedAt:new Date(started).toISOString()}},file=id=>path.join(root,'brain',id,'.system_generated/logs/transcript.jsonl')
 const write=async(id,rows)=>{await fs.mkdir(path.dirname(file(id)),{recursive:true});await fs.writeFile(file(id),rows.map(JSON.stringify).join('\n')+'\n')}
 const row=(i,time)=>({source:'MODEL',type:'PLANNER_RESPONSE',step_index:i,created_at:new Date(time).toISOString(),output_tokens:i+1,thinking:'private thinking'})
 try{
  const parentRows=[row(1,started),{source:'MODEL',type:'GENERIC',status:'DONE',step_index:2,created_at:new Date(started).toISOString(),content:'Created the following subagents:\n'+JSON.stringify({conversationId:child})}]
  await write(parent,parentRows);await write(child,[row(1,started+1000)]);await write(other,[row(99,started+99999)])
  let result=await agyActivity(manager,task,{cliHome:root,now:started+2000})
  assert.deepEqual(result.childConversations,[child]);assert.equal(result.lastInteractionAt,new Date(started+1000).toISOString());assert(!JSON.stringify(result).includes('private'))
  parentRows.push({source:'SYSTEM',type:'ERROR_MESSAGE',step_index:3,created_at:new Date(started+5000).toISOString(),error:'retry timeout'})
  await write(parent,parentRows);await fs.utimes(file(child),new Date(),new Date())
  result=await agyActivity(manager,task,{cliHome:root,now:started+6000});assert.equal(result.lastInteractionAt,new Date(started+1000).toISOString());assert.equal(result.lastError.text,'retry timeout')
  await write(child,[row(1,started+1000),row(2,started+7000)])
  result=await agyActivity(manager,task,{cliHome:root,now:started+8000});assert.equal(result.lastInteractionAt,new Date(started+8000).toISOString())
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('resumed conversation does not adopt ancient interaction from prior round before startedAt',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agy-resume-')),cid='11111111-1111-1111-1111-111111111111',manager={dir:()=>root}
 const ancient=Date.parse('2026-10-18T10:00:00Z'),resumed=Date.parse('2026-10-19T06:00:00Z')
 const task={id:'task',reviewProgress:{conversationId:cid,startedAt:new Date(resumed).toISOString()}}
 const file=path.join(root,'brain',cid,'.system_generated/logs/transcript.jsonl')
 try{
  await fs.mkdir(path.dirname(file),{recursive:true})
  await fs.writeFile(file,JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',step_index:1,created_at:new Date(ancient).toISOString(),output_tokens:100})+'\n')
  const result=await agyActivity(manager,task,{cliHome:root,now:resumed+2000})
  assert.equal(result.lastInteractionAt,null)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
