import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {normalizeReviewResult,reconcileGlossary,recoveryIssues,mergeReviewRecovery} from '../modules/pipeline/review-results.js'
import {prepareReviewAudit,assembleReviewAudit,applyReviewAudit} from '../modules/pipeline/review-audit.js'
import {runHarnessReview} from '../modules/pipeline/harness-review.js'
import {HarnessModels} from '../modules/pipeline/harness-models.js'
import {reviewDisplay,reviewFeedback} from '../modules/pipeline/review-feedback.js'
const rows=[{blockId:'B0001',line:1,source:'A',translation:'甲',hints:[{type:'term'}]},{blockId:'B0002',line:3,source:'B',translation:'乙',candidate:'候选'}]
test('compatibility retains original evidence and cannot invent missing reasons or candidates',()=>{
 const raw={packet:'001',patches:[{blockId:'B0001',edits:[{old:'甲',new:'丙',reason:'证据'}]}],candidate_decisions:[{blockId:'B0001',decision:'accept',reason:'观察'},{blockId:'B0002',decision:'reject',reason:'候选错误'},{blockId:'UNKNOWN',decision:'accept',reason:'非法'}]},before=structuredClone(raw)
 const n=normalizeReviewResult(raw,rows)
 assert.deepEqual(raw,before);assert.equal(n.value.patches[0].reason,'证据');assert.equal(n.value.observations.length,1);assert.equal(n.value.candidate_decisions.length,2)
 const bad=normalizeReviewResult({patches:[{edits:[{old:'甲',new:'乙'}]}]},rows);assert.equal(bad.value.patches[0].reason,undefined)
})
test('glossary conflicts are independent of ordering and public eligibility is conservative',()=>{
 const a={packet:'001',src:'Asile',dst:'收容所',reason:'历史用法',publicEligible:true},b={...a,packet:'002',src:'asile',dst:'精神病院'}
 assert.equal(reconcileGlossary([a,b]).merged.length,0);assert.equal(reconcileGlossary([b,a]).conflicts.length,1)
 const same={...b,dst:a.dst,publicEligible:false};assert.equal(reconcileGlossary([a,same]).merged[0].publicEligible,false)
 assert.equal(reconcileGlossary([{...a,scope:'仅此段'}]).conflicts.length,1)
})
test('delta recovery preserves unmentioned work and issues; resolutions require known IDs and reasons',()=>{
 const prev={packet:'001',status:'needs-work',patches:[{blockId:'B0001',edits:[{old:'甲',new:'丙'}],reason:'证据'}],glossary_decisions:[{src:'a',dst:'甲'}],unresolved:['原页缺字','年份不一致']}
 const issues=recoveryIssues(prev,{},'001'),delta={packet:'001',mode:'recovery',resolved_issues:[{id:issues[0].id,reason:'查证原页'}]}
 const merged=mergeReviewRecovery(prev,delta,issues,rows)
 assert.deepEqual(merged.patches,prev.patches);assert.deepEqual(merged.glossary_decisions,prev.glossary_decisions);assert.deepEqual(merged.unresolved,['年份不一致']);assert.equal(merged.status,'needs-work');assert.equal(prev.unresolved.length,2)
 assert.throws(()=>mergeReviewRecovery(prev,{...delta,resolved_issues:[{id:'fake',reason:'x'}]},issues,rows),/凭据/)
 assert.throws(()=>mergeReviewRecovery(prev,{...delta,patches:[{blockId:'fake'}]},issues,rows),/未知/)
})
test('assembler collects independent patch failures and unresolved content; conflict blocks every write',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-recovery-')),source=path.join(root,'source.md'),target=path.join(root,'translated.md')
 try{
  await fs.writeFile(source,'A\n\nB\n');await fs.writeFile(target,'甲\n\n乙\n')
  const manager={dir:()=>root,original:async()=>source},task={id:'fixture',translationPath:target},p=await prepareReviewAudit(manager,task)
  const file=path.join(p.auditDir,'results/001.json'),write=x=>fs.writeFile(file,JSON.stringify(x))
  const raw={packet:'001',status:'needs-work',patches:[{blockId:'B0001',edits:[{old:'甲',new:'丙'}]},{blockId:'B0002',edits:[{old:'不存在',new:'丁'}],reason:'证据'}],unresolved:['保留内容疑点'],glossary_decisions:[]}
  await write(raw);let v=await assembleReviewAudit(manager,task);assert.equal(v.errors.length,2);assert(v.unresolved.some(x=>x.issue==='保留内容疑点'));assert.equal(v.patchCount,0)
  await write({...raw,status:'pass',patches:[],unresolved:[],glossary_decisions:[{src:'asile',dst:'收容所',reason:'a'},{src:'Asile',dst:'精神病院',reason:'b'}]})
  v=await assembleReviewAudit(manager,task);assert.equal(v.glossaryConflicts.length,1);assert(v.unresolved.length)
  await assert.rejects(applyReviewAudit(manager,task),/不能合并/);assert.equal(await fs.readFile(target,'utf8'),'甲\n\n乙\n');assert.equal(await fs.readFile(source,'utf8'),'A\n\nB\n')
  await write({...raw,status:'pass',unresolved:[],patches:[{blockId:'B0001',edits:[{old:'甲',new:'丙',reason:'证据'}]}]});v=await assembleReviewAudit(manager,task);assert.equal(v.errors.length,0);assert.equal(v.patchCount,1)
  assert.equal(JSON.parse(await fs.readFile(file)).patches[0].reason,undefined);assert.equal(JSON.parse(await fs.readFile(path.join(p.auditDir,'normalized-results/001.json'))).notes.length,1)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('Harness activity uses nonempty text and reasoning without exposing their content',async()=>{
 const events=[],service=new HarnessModels({sessionController:{modelCatalog:async()=>({groups:[{id:'p',models:[{id:'m'}]}]})},llm:{resolveModelInfo:async()=>({}),prepareCall:async()=>({config:{},stream:async function*(){yield {type:'reasoning-delta',text:''};yield {type:'text-delta',text:' '};yield {type:'reasoning-delta',text:'private reasoning'};yield {type:'text-delta',text:'public result'};yield {type:'finish',reason:{kind:'stop'}}}})}})
 await service.generate({provider:'p',model:'m'},{messages:[],onActivity:e=>events.push(e)})
 assert.deepEqual(events,[{kind:'reasoning'},{kind:'text'}]);assert(!JSON.stringify(events).includes('private'))
})
test('request state is persisted before generation, archives prior evidence, and validates each result',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-runtime-'))
 try{
  await fs.mkdir(path.join(root,'packets'));await fs.mkdir(path.join(root,'results'));await fs.writeFile(path.join(root,'packets/001.json'),JSON.stringify(rows))
  await fs.writeFile(path.join(root,'packets/002.json'),JSON.stringify([{blockId:'B0003',line:5,source:'A',translation:'甲'}]));await fs.writeFile(path.join(root,'results/002.json'),JSON.stringify({packet:'002',status:'pass',glossary_decisions:[{src:'A',dst:'甲',reason:'其他分包最新裁决'}]}))
  const prior={packet:'001',status:'needs-work',patches:[],unresolved:['疑点']};await fs.writeFile(path.join(root,'results/001.json'),JSON.stringify(prior));await fs.writeFile(path.join(root,'harness-001.json'),JSON.stringify({old:true}))
  const saved=[],task={id:'fixture',state:'running',stage:'review',reviewConfig:{workerModel:'p/m'},reviewProgress:{startedAt:new Date().toISOString()}},manager={active:new Map(),save:async t=>saved.push(structuredClone(t.reviewProgress)),modelService:{validate:async()=>{},generate:async(_s,r)=>{assert.equal(saved.at(-1).status,'requesting');const payload=JSON.parse(r.messages[0].content[0].text.split('\n').at(-1));assert.equal(payload.sharedDecisions[0].reason,'其他分包最新裁决');r.onActivity({kind:'reasoning'});return {text:JSON.stringify({packet:'001',mode:'recovery',unresolved:[]})}}}}
  let validated=0;await runHarnessReview({manager,task,prepared:{pendingPackets:['001']},auditDir:root,validate:async()=>{validated++;return {completed:1,validPackets:['001'],errors:[],unresolved:[{packet:'001'}]}}})
  assert.equal(validated,1);assert.equal(task.reviewProgress.packetStates['001'],'unresolved');assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'results/001.json'))).unresolved,['疑点'])
  const attempts=await fs.readdir(path.join(root,'attempts'));assert.equal(attempts.length,1);assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'attempts',attempts[0],'001.json'))),prior)
  await fs.writeFile(path.join(root,'manifest.json'),'[{"id":"001"}]');const f=await reviewFeedback(manager,{...task,reviewAudit:{auditDir:root}});assert.match(f.identityLabel,/DSH 模型服务/);assert(!f.identityLabel.includes('CLI'));assert(f.lastActivityAt)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('display clocks stop at completion and use current request for idle',()=>{
 const p={engine:'dsh-harness',startedAt:'2026-01-01T00:00:00Z',requestStartedAt:'2026-01-01T00:01:00Z',requestFinishedAt:'2026-01-01T00:01:10Z',finishedAt:'2026-01-01T00:01:12Z'}
 const d=reviewDisplay(p,{stage:'review',state:'blocked'},{unresolvedPackets:1},Date.parse('2026-02-01'))
 assert.equal(d.elapsedSeconds,72);assert.equal(d.requestSeconds,10);assert.equal(d.idleSeconds,12);assert.equal(d.statusLabel,'有未决问题')
})

test('feedback clock follows continuous effective responses and findings use readable fields',async()=>{
 const {reviewFindingText}=await import('../modules/pipeline/review-feedback.js')
 assert.equal(reviewFindingText({blockId:'B0001',issue:'年份不一致',reason:'查原页'}),'段落 B0001 · 年份不一致 · 查原页')
 const p=await reviewFeedback({}, {state:'running',stage:'review',reviewProgress:{engine:'dsh-harness',lastActivityAt:'2026-01-01T00:00:00Z',lastInteractionAt:'2026-01-01T00:05:00Z',packetStates:{'001':'unresolved','002':'receiving','003':'queued'}}})
 assert.equal(p.lastActivityAt,'2026-01-01T00:05:00Z');assert.equal(p.attemptCompletedPackets,1);assert.equal(p.attemptTotalPackets,3)
})

test('invalid recovery cannot replace old results and is distinct from a model request failure',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-invalid-'))
 try{
  await fs.mkdir(path.join(root,'packets'));await fs.mkdir(path.join(root,'results'));await fs.writeFile(path.join(root,'packets/001.json'),JSON.stringify(rows))
  const prior={packet:'001',status:'needs-work',patches:[],unresolved:['未解决']},file=path.join(root,'results/001.json');await fs.writeFile(file,JSON.stringify(prior))
  const task={id:'fixture',reviewConfig:{workerModel:'p/m'},reviewProgress:{}},manager={active:new Map(),save:async()=>{},modelService:{validate:async()=>{},generate:async()=>({text:'not JSON'})}}
  await assert.rejects(runHarnessReview({manager,task,prepared:{pendingPackets:['001']},auditDir:root}))
  assert.equal(task.reviewProgress.packetStates['001'],'invalid-result');assert.deepEqual(JSON.parse(await fs.readFile(file)),prior)
  manager.modelService.generate=async()=>{throw Object.assign(new Error('network failed'),{code:'TRANSPORT'})}
  await assert.rejects(runHarnessReview({manager,task,prepared:{pendingPackets:['001']},auditDir:root}))
  assert.equal(task.reviewProgress.packetStates['001'],'request-failed');assert.deepEqual(JSON.parse(await fs.readFile(file)),prior)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('idle timer aborts without activity and nonempty reasoning keeps the request alive',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-idle-'))
 try{
  await fs.mkdir(path.join(root,'packets'));await fs.mkdir(path.join(root,'results'));await fs.writeFile(path.join(root,'packets/001.json'),'[]')
  const task={id:'fixture',reviewConfig:{workerModel:'p/m'},reviewProgress:{idleTimeoutMs:100}},manager={active:new Map(),save:async()=>{},modelService:{validate:async()=>{},generate:async(_s,r)=>new Promise((resolve,reject)=>r.signal.addEventListener('abort',()=>reject(r.signal.reason),{once:true}))}}
  await assert.rejects(runHarnessReview({manager,task,prepared:{pendingPackets:['001']},auditDir:root}),e=>e.code==='REVIEW_IDLE_TIMEOUT')
  manager.modelService.generate=async(_s,r)=>new Promise((resolve,reject)=>{
   let n=0;const timer=setInterval(()=>{r.onActivity({kind:'reasoning'});if(++n===5){clearInterval(timer);resolve({text:'{"packet":"001","status":"pass","patches":[]}'})}},30)
   r.signal.addEventListener('abort',()=>{clearInterval(timer);reject(r.signal.reason)},{once:true})
  })
  await runHarnessReview({manager,task,prepared:{pendingPackets:['001']},auditDir:root});assert(task.reviewProgress.lastInteractionAt)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('needs-work stops the task before publication and cannot mark review done',async()=>{
 const {TaskManager}=await import('../modules/pipeline/tasks.js'),root=await fs.mkdtemp(path.join(os.tmpdir(),'review-stage-'))
 try{
  const manager=new TaskManager(root,path.join(root,'reading')),task={id:'fixture',input:{type:'markdown'},phaseApproval:{phase:'delivery'},stages:{translationCheck:{state:'done'}},log:[]},executed=[]
  manager.get=async()=>task;manager.save=async()=>task;manager.confirmed=async()=>{};manager.perform=async(t,stage)=>{executed.push(stage);t.review={status:'needs-work',semanticVerified:false}}
  await manager.start(task.id,'review');await manager.active.get(task.id)?.promise
  assert.deepEqual(executed,['review']);assert.equal(task.state,'blocked');assert.equal(task.stages.review.state,'blocked');assert.match(task.message,/未决问题/)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('targeted recovery exposes only implicated rows and rejects unrelated edits',async()=>{
 const {reviewRecoveryScope}=await import('../modules/pipeline/review-results.js')
 const previous={packet:'001',status:'pass',patches:[{blockId:'B0001',reason:'a',edits:[]},{blockId:'B0002',reason:'b',edits:[]}],unresolved:[]},issues=[{id:'format',kind:'format',issue:'L3: old not found'}],scope=reviewRecoveryScope(issues,rows,previous)
 assert.deepEqual(scope.blockIds,['B0002']);assert.equal(scope.rows.length,1);assert.equal(scope.previous.patches.length,1)
 assert.throws(()=>mergeReviewRecovery(previous,{packet:'001',mode:'recovery',patches:[{blockId:'B0001',edits:[]}]},issues,rows,scope),/超出/)
 const repaired=mergeReviewRecovery(previous,{packet:'001',mode:'recovery',remove_patches:[{blockId:'B0002',reason:'正文已正确，无需替换'}]},issues,rows,scope)
 assert.deepEqual(repaired.patches,[previous.patches[0]])
})
