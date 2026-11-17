import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const source=await fs.readFile(new URL('../client.js',import.meta.url),'utf8')
const plain=value=>JSON.parse(JSON.stringify(value))
function compile(start,end,context,result){
 vm.runInNewContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)))+`;globalThis.result=${result}`,context)
 return context.result
}

test('paused transcription opens editable confirmation and does not dispatch early',()=>{
 for(const state of ['paused','stopped','blocked','interrupted']){
  let request,dispatched=false
  const task={id:'task',state,phaseApproval:{phase:'transcription',orchestratorModel:'fixture/orch',workerId:'fixture:old',fallbacks:[]}}
  const context={task,phaseGroups:[{id:'transcription',ids:['transcribe']}],modelKey:'fixture/orch',orchestratorEffort:'',workerChoice:'fixture:old',fallback1:'',fallback2:'',setMessage(){},setTranslationProfile(){},setPhaseRequest:value=>request=value,act:fn=>fn(),executeStage:()=>{dispatched=true}}
  const run=compile('      const run=(stage,options={})=>{','      const confirmAndRun=',context,'run')
  run('transcribe')
  assert.equal(request.taskId,'task');assert.equal(request.phase,'transcription');assert.equal(dispatched,false)
 }
})

test('an edited effort or saved worker requires confirmation even for an already approved phase',()=>{
 for(const change of [{orchestratorEffort:'high'},{workerChoice:'fixture:new'}]){
  let request
  const context={task:{id:'task',state:'idle',phaseApproval:{phase:'transcription',orchestratorModel:'fixture/orch',workerId:'fixture:old',fallbacks:[]}},phaseGroups:[{id:'transcription',ids:['transcribe']}],modelKey:'fixture/orch',orchestratorEffort:'',workerChoice:'fixture:old',fallback1:'',fallback2:'',setMessage(){},setTranslationProfile(){},setPhaseRequest:value=>request=value,act:fn=>fn(),executeStage:()=>assert.fail('unconfirmed dispatch'),...change}
  compile('      const run=(stage,options={})=>{','      const confirmAndRun=',context,'run')('transcribe')
  assert.equal(request.phase,'transcription')
 }
})

test('confirmation sends the selected effort and worker, then dispatches the saved task',async()=>{
 let sent,executed
 const saved={id:'task',phaseApproval:{orchestratorEffort:'high'}}
 const context={phaseRequest:{taskId:'task',phase:'transcription',stage:'transcribe',options:{}},selected:'task',models:[{key:'fixture/orch'}],modelKey:'fixture/orch',orchestratorEffort:'high',workerChoice:'fixture:new',fallback1:'',fallback2:'',translationProfile:'',reviewOrchestratorChoice:'',reviewWorkerChoice:'inherit',reviewEffortChoice:'',act:fn=>fn(),api:async(_url,_method,body)=>{sent=body;return saved},setTask(){},setPhaseRequest(){},executeStage:async t=>{executed=t}}
 await compile('      const confirmAndRun=','      const resumeWithAntigravity=',context,'confirmAndRun')()
 assert.equal(sent.workerId,'fixture:new');assert.equal(sent.orchestratorEffort,'high');assert.equal(executed,saved)
})

test('orchestrator dispatch applies the persisted effort before prompting and stops on selection failure',async()=>{
 const t={id:'task',name:'fixture',phaseApproval:{phase:'transcription',orchestratorModel:'fixture/orch',orchestratorEffort:'high'}}
 const calls=[]
 let ok=true
 const context={models:[{key:'fixture/orch',selection:{provider:'fixture',model:'orch'}}],environment:{root:'/fixture'},api:async()=>({sessions:{orchestrator:'session'}}),selectSessionModel:async(id,selection)=>{calls.push(['select',id,plain(selection)]);return {ok}},promptSession:async()=>{calls.push(['prompt']);return {ok:true}},setTask(){},openSession(){},setMessage(){}}
 const dispatch=compile('      const dispatch=async','      const dispatchReview=',context,'dispatch')
 await dispatch(t,'transcribe')
 assert.deepEqual(calls,[['select','session',{provider:'fixture',model:'orch',reasoningEffort:'high'}],['prompt']])
 calls.length=0;ok=false
 await assert.rejects(dispatch(t,'transcribe'),/编排模型选择失败/)
 assert.equal(calls.length,1)
})

test('resolveNextAction distinguishes DSH current-session vs new-session review and ignores stale CLI conversationId',()=>{
 const resolveNextAction=compile('    function shortSessionId(','    function executionSummary(',{},'resolveNextAction')
 const flags={stageName:'审校',transcriptionDone:true,translationDone:true,reviewDone:false,deliveryDone:false,needsBookObservation:false}
 // 1. Stale agy conversationId on a DSH session review with unbound/earlier-stage orchestrator -> clearly labels new session
 const unboundDsh={
  id:'t1',state:'blocked',stage:'review',reviewAudit:{totalPackets:69},
  phaseApproval:{phase:'delivery'},reviewConfig:{orchestratorModel:'xai-local/grok-4.7'},
  reviewProgress:{engine:'dsh-session',conversationId:'225db58d-267a-4c38-bca7-a588ba7a5c8e'},
  executionSessions:{sessions:{},authorizedStage:'review'}
 }
 const a1=plain(resolveNextAction(unboundDsh,flags))
 assert.equal(a1.label,'开启新会话继续审校')
 assert.deepEqual(a1.options,{resetOrchestrator:true})
 assert.ok(!a1.note.includes('225db58d'))

 // 2. Active bound review DSH orchestrator session -> clearly shows short session ID for current-session continuation
 const boundDsh={
  ...unboundDsh,
  executionSessions:{sessions:{orchestrator:'session-bec51b74-b4a4-411b-8cea-cf9e1d05e142'},authorizedStage:'review'}
 }
 const a2=plain(resolveNextAction(boundDsh,flags))
 assert.equal(a2.label,'在当前会话继续审校 (bec51b74)')
 assert.deepEqual(a2.options,{})
 assert.match(a2.note,/bec51b74/)

 // 3. Genuine Antigravity CLI review with active agy-bridge conversationId -> clearly labels CLI resume
 const boundAgy={
  id:'t2',state:'blocked',stage:'review',reviewAudit:{totalPackets:69},
  phaseApproval:{phase:'delivery'},reviewConfig:{orchestratorModel:'agy/gemini-3.8-flash-high'},
  reviewProgress:{engine:'agy-bridge',conversationId:'225db58d-267a-4c38-bca7-a588ba7a5c8e'}
 }
 const a3=plain(resolveNextAction(boundAgy,flags))
 assert.equal(a3.label,'在原 CLI 会话继续审校 (225db58d)')
 assert.deepEqual(a3.options,{resumeConversation:true})

 // 4. Unconfirmed review phase -> prompts model selection
 const unconfirmed={id:'t3',state:'idle',stage:'translationCheck',phaseApproval:{phase:'translation'}}
 const a4=resolveNextAction(unconfirmed,flags)
 assert.equal(a4.label,'选择模型并开始审校')
})
