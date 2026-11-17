import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {HarnessModels,DEFAULT_REQUEST_TIMEOUT_SECONDS,DEFAULT_FIRST_HEADER_TIMEOUT_MS,DEFAULT_STREAM_IDLE_TIMEOUT_MS,DEFAULT_LEASE_MAX_ATTEMPTS,expectedJsonlineIds,extractFinalJsonlinePass,isRetryableLeaseError} from '../modules/pipeline/harness-models.js'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {prepareReviewAudit,assembleReviewAudit,applyReviewAudit,runAgyReviewAudit} from '../modules/pipeline/review-audit.js'
import {writeSourceMap} from '../modules/pipeline/source-map.js'
import {hash,markdownBlocks} from '../modules/pipeline/markdown.js'
import {runHarnessReview,isWordMatch,buildSharedContext,buildSharedDecisions,STOPWORDS} from '../modules/pipeline/harness-review.js'
const exec=promisify(execFile)
const runtime=fileURLToPath(new URL('../runtime',import.meta.url))
function fixture(){
 const state={calls:[],catalog:{default:{provider:'dynamic',model:'new-model'},groups:[{id:'dynamic',name:'Current Harness provider',models:[{id:'new-model',name:'Current model',reasoning:{efforts:[{id:'high',name:'High'}]}}]}]},info:{inputModalities:['text','image'],reasoning:{efforts:[{id:'high'}]}}}
 const host={sessionController:{modelCatalog:async()=>structuredClone(state.catalog)},attachments:{admitPromptContent:async content=>content.map(b=>b.type==='image'?{type:'image',attachment:{attachmentId:'test-image',mediaType:b.mediaType}}:b)},llm:{resolveModelInfo:async()=>state.info,prepareCall:async config=>{
  state.calls.push(config)
  return {config:{...config,temperature:0.25},stream:async function*(request){assert.equal(request.temperature,0.25);state.request=request;yield {type:'text-delta',text:'Harness result'};yield {type:'finish',reason:{kind:'stop'}}}}
 }}}
 return {state,service:new HarnessModels(host)}
}
test('catalog and default reflect Harness changes without local aliases',async()=>{
 const {state,service}=fixture();assert.equal((await service.workers())[0].id,'dynamic:new-model')
 state.catalog.groups[0].models=[{id:'replacement',name:'Replacement'}];state.catalog.default.model='replacement'
 assert.equal((await service.workers())[0].id,'dynamic:replacement')
 await assert.rejects(service.validate({provider:'dynamic',model:'new-model'}),/目录/)
 assert.equal((await service.workers())[0].default,true)
})
test('lease requires authentication, bounds models, and retains exact prepared config',async()=>{
 const {state,service}=fixture(),lease=await service.openLease([{provider:'dynamic',model:'new-model',timeout:600,fallbacks:[]}])
 try{
  assert.equal((await fetch(lease.url+'/catalog')).status,401)
  const send=payload=>fetch(lease.url+'/call',{method:'POST',headers:{authorization:'Bearer '+lease.token},body:JSON.stringify(payload)})
  let r=await send({provider:'other',model:'new-model',prompt:'test'});assert.equal(r.status,502);assert.equal(state.calls.length,0)
  r=await send({provider:'dynamic',model:'new-model',prompt:'test',images:[{name:'page.png',mediaType:'image/png',data:'AAAA'}]})
  assert.equal((await r.json()).text,'Harness result');assert.deepEqual(state.calls[0],{provider:'dynamic',model:'new-model'})
  assert.equal(state.request.messages[0].content[1].attachment.attachmentId,'test-image')
  state.catalog.groups=[]
  assert.equal((await send({provider:'dynamic',model:'new-model',prompt:'test'})).status,502)
  assert.equal(state.calls.length,1)
 }finally{await lease.close()}
})
test('text-only model cannot silently discard images',async()=>{
 const {state,service}=fixture();state.info.inputModalities=['text']
 await assert.rejects(service.generate({provider:'dynamic',model:'new-model'},{messages:[{role:'user',content:[{type:'image',attachment:{}}]}]}),/不支持图像/)
 assert.equal(state.calls.length,0)
})
test('Python worker invokes a newly registered Harness provider without vendor config',async()=>{
 const {state,service}=fixture(),lease=await service.openLease([{provider:'dynamic',model:'new-model'}])
 try{
  const {stdout}=await exec('/opt/homebrew/bin/python3',['-c',"import harness_worker as w; c=w.get_provider_config('dynamic','new-model'); assert 'api_key' not in c and 'api_base' not in c; print(w.call_api(c,'source',[]))"],{env:{...process.env,...lease.env,PYTHONPATH:runtime}})
  assert.equal(stdout.trim(),'Harness result');assert.equal(state.calls.length,1)
 }finally{await lease.close()}
})
test('OpenAI-compatible translation wire uses the same Harness selection',async()=>{
 const {state,service}=fixture(),lease=await service.openLease([{provider:'dynamic',model:'new-model'}])
 try{
  const r=await fetch(lease.url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+lease.token},body:JSON.stringify({model:'dynamic/new-model',messages:[{role:'system',content:'translate'},{role:'user',content:'source'}],stream:true})})
  const text=await r.text();assert.match(text,/Harness result/);assert.match(text,/\[DONE\]/);assert.equal(state.request.system,'translate')
  assert.equal(state.calls.length,1)
 }finally{await lease.close()}
})
test('LinguaGacha projection restores original settings and never overwrites concurrent edits',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-lingua-'))
 try{
  const code=`import json,os
from pathlib import Path
from lingua_harness_config import apply_lease,restore_lease
r=Path(${JSON.stringify(root)});c=r/'config.json';p=r/'payload.json';b=r/'lease.restore.json'
original=json.dumps({'models':[{'id':'personal','api_key':'synthetic-private'}],'custom_setting':True})
c.write_text(original);p.write_text(json.dumps({'ownerPid':os.getpid(),'url':'http://127.0.0.1:1234','token':'local-capability','model':'dynamic/new-model'}))
apply_lease(c,p,b);v=json.loads(c.read_text());assert len(v['models'])==1 and v['models'][0]['model_id']=='dynamic/new-model';assert v['custom_setting'];assert v['models'][0]['threshold']['concurrency_limit']==4;assert v['request_timeout']==660 and v['prompt_enhancement_enable'] is False
restore_lease(c,b);assert c.read_text()==original
apply_lease(c,p,b);c.write_text('changed concurrently')
try: restore_lease(c,b)
except RuntimeError: pass
else: raise AssertionError('overwrote concurrent edit')
assert c.read_text()=='changed concurrently' and b.exists()
print('passed')`
  assert.equal((await exec('/opt/homebrew/bin/python3',['-c',code],{env:{...process.env,PYTHONPATH:runtime}})).stdout.trim(),'passed')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('Harness review processes only pending packets with a concrete catalog model',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-review-'))
 try{
  await fs.mkdir(path.join(root,'packets'));await fs.mkdir(path.join(root,'results'))
  await fs.writeFile(path.join(root,'packets/002.json'),'[]');await fs.writeFile(path.join(root,'results/001.json'),'preserved')
  const calls=[],manager={active:new Map(),save:async()=>{},modelService:{validate:async()=>{},generate:async(s,r)=>{assert.equal(r.sessionId,'paper-reader-fixture');calls.push(s);return {text:JSON.stringify({packet:'002',status:'pass',patches:[],unresolved:[]})}}}}
  await runHarnessReview({manager,task:{id:'fixture',reviewConfig:{orchestratorModel:'dynamic/reviewer',workerModel:'dynamic/worker'},reviewProgress:{}},prepared:{pendingPackets:['002']},auditDir:root})
  assert.deepEqual(calls,[{provider:'dynamic',model:'worker'}]);assert.equal(await fs.readFile(path.join(root,'results/001.json'),'utf8'),'preserved')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('task session survives lease recreation and reaches worker and translation streams',async()=>{
 const {state,service}=fixture(),choice={provider:'dynamic',model:'new-model'}
 for(const sessionId of ['paper-reader-task-a','paper-reader-task-a','paper-reader-task-b']){
  const lease=await service.openLease([choice],{sessionId})
  try{
   for(const [route,payload] of [['/call',{...choice,prompt:'inspect'}],['/v1/chat/completions',{model:'dynamic/new-model',messages:[{role:'user',content:'translate'}]}]]){
    const response=await fetch(lease.url+route,{method:'POST',headers:{authorization:'Bearer '+lease.token},body:JSON.stringify(payload)})
    assert.equal(response.status,200);await response.text();assert.equal(state.request.sessionId,sessionId)
   }
  }finally{await lease.close()}
 }
 await service.generate(choice,{messages:[]});assert.match(state.request.sessionId,/^paper-reader-/)
})
test('command uses task identity for the shared model lease',async()=>{
 const seen=[],manager={cliExecutable:'/cli',modelService:{openLease:async(_s,opts)=>{seen.push(opts);return {env:{},close:async()=>{}}}},dir:id=>'/tasks/'+id,rawCommand:async()=>''}
 for(const id of ['first','first','second'])await TaskManager.prototype.command.call(manager,{id,worker:{provider:'dynamic',model:'new-model'}},'/python',['analyze_document.py'])
 assert.deepEqual(seen.map(o=>o.sessionId),['paper-reader-first','paper-reader-first','paper-reader-second'])
})
test('terminal provider failure retains safe diagnostics through the lease and Python worker',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-failure-')),{service}=fixture()
 service.host.llm.prepareCall=async()=>({config:{},stream:async function*(){yield {type:'finish',reason:{kind:'error',failure:{code:'INVALID_REQUEST',status:400,message:'MissingSessionID: missing x-opencode-session; Authorization: Bearer synthetic-secret; api_key="private-value"; sk-syntheticprivate'}}}}})
 const lease=await service.openLease([{provider:'dynamic',model:'new-model'}],{directory:root,sessionId:'paper-reader-test'})
 try{
  const {stdout}=await exec('/opt/homebrew/bin/python3',['-c',`import json,harness_worker as w
try: w.call_api(w.get_provider_config('dynamic','new-model'),'test',[])
except w.HarnessRequestError as e: print(json.dumps(dict(code=e.code,status=e.status,message=e.safe_message)))
else: raise AssertionError('expected failure')`],{env:{...process.env,...lease.env,PYTHONPATH:runtime}})
  const failure=JSON.parse(stdout);assert.equal(failure.code,'INVALID_REQUEST');assert.equal(failure.status,400);assert.match(failure.message,/MissingSessionID/);assert.doesNotMatch(stdout,/synthetic-secret|private-value|sk-syntheticprivate/)
  const trace=JSON.parse(await fs.readFile(path.join(root,(await fs.readdir(root))[0]),'utf8'));assert.deepEqual(trace.error,failure);assert.ok(trace.completedAt)
 }finally{await lease.close();await fs.rm(root,{recursive:true,force:true})}
})

test('isWordMatch filters stopwords and matches whole word boundaries only', () => {
 assert.equal(isWordMatch('Ceci est un sujet important', 'je'), false) // stopword
 assert.equal(isWordMatch('Ceci est un sujet important', 'un'), false) // stopword
 assert.equal(isWordMatch('Le sujet de la phrase', 'sujet'), true)
 assert.equal(isWordMatch('Le projet de recherche', 'sujet'), false)
 assert.equal(isWordMatch('Une crise d\'identité nationale', 'identité'), true)
 assert.equal(isWordMatch('Martin Guerre revient au village', 'Martin Guerre'), true)
})

test('buildSharedContext caps items and character limits and extracts relevant context only', () => {
 const allRows = [
  { packet: '001', blockId: 'B001', source: 'Une réflexion sur l\'identité personnelle dans l\'histoire', translation: '关于历史上个人认同的思考' },
  { packet: '002', blockId: 'B002', source: 'Le sujet cartésien et la modernité', translation: '笛卡尔式主体与现代性' },
  { packet: '004', blockId: 'B004', source: 'Un texte sans aucun rapport avec les termes', translation: '与术语无关的文本' },
 ]
 const packetRows = [
  { blockId: 'B010', source: 'Nous interrogeons l\'identité ici.' }
 ]
 const shared = buildSharedContext({
  allRows,
  currentPacketId: '003',
  packetRows,
  terms: ['identité', 'sujet'],
  maxItems: 5,
  maxChars: 1000
 })
 assert.equal(shared.length, 1)
 assert.equal(shared[0].blockId, 'B001')
 assert.equal(shared[0].packet, '001')
})

test('Harness review catches context overflow and automatically retries with compaction', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-overflow-'))
 try {
  await fs.mkdir(path.join(root, 'packets'))
  await fs.mkdir(path.join(root, 'results'))
  await fs.writeFile(path.join(root, 'packets/001.json'), JSON.stringify([{ line: 1, blockId: 'B1', source: 'Test source', translation: '测试译文' }]))
  let attempts = 0
  const manager = {
   active: new Map(),
   save: async () => {},
   modelService: {
    validate: async () => {},
    generate: async (_selection, request) => {
     attempts++
     if (attempts === 1) {
      const err = new Error('pi-ai detected context overflow for model "gpt-6.1-sol"')
      err.code = 'CONTEXT_WINDOW_EXCEEDED'
      throw err
     }
     const prompt = request.messages[0].content[0].text
     const parsed = JSON.parse(prompt.slice(prompt.indexOf('{"packet":')))
     assert.deepEqual(parsed.sharedContext, []) // compacted mode on retry
     return { text: JSON.stringify({ packet: '001', status: 'pass', patches: [], unresolved: [] }) }
    }
   }
  }
  const task = { id: 'overflow-task', reviewConfig: { orchestratorModel: 'dynamic/reviewer', workerModel: 'dynamic/worker' }, reviewProgress: {} }
  const result = await runHarnessReview({
   manager,
   task,
   prepared: { pendingPackets: ['001'] },
   auditDir: root
  })
  assert.equal(result.status, 'SUCCESS')
  assert.equal(attempts, 2)
 } finally {
  await fs.rm(root, { recursive: true, force: true })
 }
})

test('session-orchestrated review requires subagent packet completion and supports glossary-decisions polysemous/override reconciliation', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-review-'))
 try {
  const source = path.join(root, 'source.md')
  const target = path.join(root, 'translated.md')
  await fs.writeFile(source, '# Chapitre 1\n\nQui dit je en nous?\n')
  await fs.writeFile(target, '# 第一章\n\n谁在我们之中说我？\n')
  const manager = {
   root,
   dir: () => root,
   original: async () => source,
   save: async () => {},
   modelService: { validate: async () => {}, generate: async () => { throw new Error('Should not run 1-by-1 loop') } }
  }
  const task = {
   id: 'session-review-task',
   name: 'Qui dit je',
   translationPath: target,
   reviewConfig: { orchestratorModel: 'openai-codex/gpt-6.1-sol', workerModel: 'inherit' }
  }
  const prepared = await prepareReviewAudit(manager, task)
  await assert.rejects(
   runAgyReviewAudit(manager, task, { sessionOrchestrated: true }),
   /请勿直接调用 run\(stage: "review"\) 启动单包串行循环/
  )
  await fs.writeFile(path.join(prepared.auditDir, 'results/001.json'), JSON.stringify({
   packet: '001',
   status: 'pass',
   patches: [],
   glossary_decisions: [
    { src: 'je', dst: '我', reason: '叙述代词' },
    { src: 'je', dst: '“我”', reason: '提及代词' },
    { src: 'Martin Guerre', dst: '马丁·盖尔', reason: '历史人名' },
    { src: 'Martin Guerre', dst: '马丁·格尔', reason: '旧译' }
   ],
   unresolved: []
  }))
  const before = await assembleReviewAudit(manager, task, { auditDir: prepared.auditDir })
  assert.equal(before.glossaryConflicts.length, 2)
  await fs.writeFile(path.join(prepared.auditDir, 'glossary-decisions.json'), JSON.stringify([
   { src: 'je', polysemous: true, reason: '多义词/代词随语境分译' },
   { src: 'Martin Guerre', dst: '马丁·盖尔', override: true, reason: '全书统一译名' }
  ]))
  const after = await assembleReviewAudit(manager, task, { auditDir: prepared.auditDir })
  assert.equal(after.glossaryConflicts.length, 0)
  assert.equal(after.unresolved.length, 0)
  assert.equal(after.complete, true)
  const completed = await runAgyReviewAudit(manager, task, { sessionOrchestrated: true })
  assert.equal(completed.validation.complete, true)
  assert.equal(task.reviewProgress.status, 'done')
 } finally {
  await fs.rm(root, { recursive: true, force: true })
 }
})

test('session-orchestrated source_corrections supports probed footnote completion and blank-page noise block deletion', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-source-corrections-'))
 try {
  const pdf = path.join(root, 'source.pdf')
  await fs.writeFile(pdf, 'fake-pdf-bytes')
  const source = path.join(root, 'source.md')
  const target = path.join(root, 'translated.md')
  const srcText = [
   '# Chapitre 18',
   'Texte avec note[^n1].',
   '[^n1]: 1. Les uns soutenaient que le',
   'ce d e in to u t',
   'Conclusion finale.'
  ].join('\n\n') + '\n'
  const dstText = [
   '# 第十八章',
   '带有注释的正文[^n1]。',
   '[^n1]: 1. 有人主张这艘船（原书此处截断）',
   '（此处系空白页底本透印乱码）',
   '最终结论。'
  ].join('\n\n') + '\n'
  await fs.writeFile(source, srcText)
  await fs.writeFile(target, dstText)
  const blocks = markdownBlocks(srcText)
  await writeSourceMap(source, {
   schemaVersion: 1,
   view: 'original',
   generator: 'test',
   markdownSha256: hash(srcText),
   pdf: { file: 'source.pdf', sha256: hash(await fs.readFile(pdf)), totalPages: 452 },
   blocks: blocks.map((b, i) => ({
    blockId: 'src-' + (i + 1),
    markdownBlockId: b.id,
    type: b.type,
    sourcePids: [],
    logicalPages: [341 + i],
    pdfPages: [341 + i],
    pdfPageRanges: [[341 + i, 341 + i]],
    regions: []
   }))
  })
  await fs.mkdir(path.join(root, 'probe-pages'), { recursive: true })
  await fs.writeFile(path.join(root, 'probe-pages/page_0341.png'), 'png')
  await fs.writeFile(path.join(root, 'probe-pages/page_0342.png'), 'png')
  await fs.writeFile(path.join(root, 'probe-pages/page_0424.png'), 'png')
  const manager = {
   root,
   dir: () => root,
   original: async t => t.sourceRevision ? t.sourceRevision.path : source,
   save: async () => {}
  }
  const task = {
   id: 'session-source-task',
   name: 'Qui dit je',
   translationPath: target,
   reviewConfig: { orchestratorModel: 'openai-codex/gpt-6.1-sol', workerModel: 'inherit' }
  }
  const prepared = await prepareReviewAudit(manager, task)
  await fs.writeFile(path.join(prepared.auditDir, 'results/001.json'), JSON.stringify({
   packet: '001',
   status: 'pass',
   patches: [],
   source_corrections: [
    {
     blockId: 'B0003',
     pages: [341, 342],
     source: '[^n1]: 1. Les uns soutenaient que le navire était resté identique.',
     translation: '[^n1]: 1. 有人主张这艘船仍是原来那艘。',
     reason: '核对341与342页底本原图补全跨页截断注文'
    },
    {
     blockId: 'B0004',
     delete: true,
     pages: [424],
     reason: '424页系空白衬页透印乱码，予以剔除'
    }
   ],
   glossary_decisions: [],
   unresolved: []
  }))
  const validation = await applyReviewAudit(manager, task, { auditDir: prepared.auditDir })
  assert.equal(validation.complete, true)
  assert.equal(validation.errors.length, 0)
  const newSource = await fs.readFile(await manager.original(task), 'utf8')
  const newTarget = await fs.readFile(task.translationPath, 'utf8')
  assert.equal(markdownBlocks(newSource).length, 4)
  assert.equal(markdownBlocks(newTarget).length, 4)
  assert(newSource.includes('navire était resté identique.'))
  assert(!newSource.includes('ce d e in to u t'))
  assert(newTarget.includes('有人主张这艘船仍是原来那艘。'))
  assert(!newTarget.includes('空白页底本透印乱码'))
 } finally {
  await fs.rm(root, { recursive: true, force: true })
 }
})

test('lease defaults to 10-minute first-header timeout and flushes SSE headers plus keepalives during long reasoning', async () => {
 assert.equal(DEFAULT_REQUEST_TIMEOUT_SECONDS, 600)
 assert.equal(DEFAULT_FIRST_HEADER_TIMEOUT_MS, 600_000)
 const { service } = fixture()
 let releaseReasoning, generationDone = false
 const gate = new Promise(resolve => { releaseReasoning = resolve })
 service.host.llm.prepareCall = async config => ({
  config,
  stream: async function* () {
   await gate
   yield { type: 'text-delta', text: 'Long reasoning result' }
   yield { type: 'finish', reason: { kind: 'stop' } }
   generationDone = true
  }
 })
 const lease = await service.openLease([{ provider: 'dynamic', model: 'new-model' }], { headerFlushMs: 15, keepaliveMs: 20 })
 try {
  assert.equal(lease.serverTimeoutMs, 600_000)
  // fetch() resolves as soon as response headers arrive; without early SSE header flush this would hang on gate.
  const response = await fetch(lease.url + '/v1/chat/completions', {
   method: 'POST',
   headers: { authorization: 'Bearer ' + lease.token, 'content-type': 'application/json' },
   body: JSON.stringify({ model: 'dynamic/new-model', messages: [{ role: 'user', content: 'consolidate' }], stream: true })
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(generationDone, false)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const firstChunk = decoder.decode((await reader.read()).value)
  assert.match(firstChunk, /^: keepalive/)
  assert.equal(generationDone, false)
  releaseReasoning()
  let rest = firstChunk
  while (true) {
   const next = await reader.read()
   if (next.done) break
   rest += decoder.decode(next.value, { stream: true })
  }
  assert.match(rest, /Long reasoning result/)
  assert.match(rest, /\[DONE\]/)
 } finally {
  releaseReasoning?.()
  await lease.close()
 }
})

test('SSE failure after early header flush emits structured error frame without [DONE]', async () => {
 const { service } = fixture()
 service.host.llm.prepareCall = async config => ({
  config,
  stream: async function* () {
   yield { type: 'reasoning-delta', text: 'deep thought...' }
   yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_TIMEOUT', message: 'provider timed out after 600s' } } }
  }
 })
 const lease = await service.openLease([{ provider: 'dynamic', model: 'new-model' }], { headerFlushMs: 10, keepaliveMs: 20 })
 try {
  const response = await fetch(lease.url + '/v1/chat/completions', {
   method: 'POST',
   headers: { authorization: 'Bearer ' + lease.token, 'content-type': 'application/json' },
   body: JSON.stringify({ model: 'dynamic/new-model', messages: [{ role: 'user', content: 'consolidate' }], stream: true })
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /"UPSTREAM_TIMEOUT"/)
  assert.doesNotMatch(text, /\[DONE\]/)
 } finally {
  await lease.close()
 }
})

test('generate enforces stream idle watchdog, ignores whitespace keepalives, and rejects empty streams', async () => {
 assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 180_000)
 assert.equal(DEFAULT_LEASE_MAX_ATTEMPTS, 3)

 // 1. Silent stream after whitespace-only chunks trips STREAM_IDLE_TIMEOUT and aborts attemptSignal.
 const { service } = fixture()
 let seenSignalAborted = false
 service.host.llm.prepareCall = async config => ({
  config,
  stream: async function* (request) {
   request.signal.addEventListener('abort', () => { seenSignalAborted = true }, { once: true })
   yield { type: 'text-delta', text: '   \n' }
   await new Promise(resolve => setTimeout(resolve, 250))
   yield { type: 'text-delta', text: 'too late' }
  }
 })
 await assert.rejects(
  service.generate({ provider: 'dynamic', model: 'new-model' }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], streamIdleTimeoutMs: 50 }),
  err => err.code === 'STREAM_IDLE_TIMEOUT'
 )
 assert.equal(seenSignalAborted, true)

 // 2. Active non-whitespace deltas reset idle deadline beyond single window.
 let activityCount = 0
 service.host.llm.prepareCall = async config => ({
  config,
  stream: async function* () {
   for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 35))
    yield { type: 'text-delta', text: 'chunk-' + i + ' ' }
   }
   yield { type: 'finish', reason: { kind: 'stop' } }
  }
 })
 const ok = await service.generate({ provider: 'dynamic', model: 'new-model' }, {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  streamIdleTimeoutMs: 80,
  onActivity: () => { activityCount++ }
 })
 assert.equal(ok.text, 'chunk-0 chunk-1 chunk-2 chunk-3 ')
 assert.equal(activityCount, 4)

 // 3. Stop with blank text and no tool calls rejects with EMPTY_RESPONSE.
 service.host.llm.prepareCall = async config => ({
  config,
  stream: async function* () {
   yield { type: 'reasoning-delta', text: 'thinking' }
   yield { type: 'text-delta', text: '   ' }
   yield { type: 'finish', reason: { kind: 'stop' } }
  }
 })
 await assert.rejects(
  service.generate({ provider: 'dynamic', model: 'new-model' }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
  err => err.code === 'EMPTY_RESPONSE'
 )
} )

test('openLease transparently retries transient stream hangs, transport resets, and usage-policy false positives without retrying permanent or quota errors', async () => {
 assert.equal(isRetryableLeaseError({ code: 'STREAM_IDLE_TIMEOUT' }), true)
 assert.equal(isRetryableLeaseError({ code: 'TRANSPORT', message: 'terminated' }), true)
 assert.equal(isRetryableLeaseError({ code: 'PI_AI_ERROR', message: 'Your request was flagged as potentially violating our usage policy.' }), true)
 assert.equal(isRetryableLeaseError({ code: 'ABORTED', message: 'OpenAI Responses stream ended before a terminal response event' }), true)
 assert.equal(isRetryableLeaseError({ code: 'INVALID_REQUEST', status: 400, message: 'bad payload' }), false)
 assert.equal(isRetryableLeaseError({ code: 'UPSTREAM_TIMEOUT', message: 'timed out' }), false)
 assert.equal(isRetryableLeaseError({ code: 'RATE_LIMIT', message: 'Your quota will reset in 4 hours (usage limit)' }), false)

 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-retry-'))
 try {
  const { service } = fixture()
  let attemptNum = 0
  service.host.llm.prepareCall = async config => ({
   config,
   stream: async function* () {
    attemptNum++
    if (attemptNum === 1) {
     // Stall past streamIdleTimeoutMs -> STREAM_IDLE_TIMEOUT -> retry #1
     await new Promise(resolve => setTimeout(resolve, 200))
     yield { type: 'finish', reason: { kind: 'stop' } }
     return
    }
    if (attemptNum === 2) {
     // Policy false positive / transport glitch -> retry #2
     yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Your request was flagged as potentially violating our usage policy.' } } }
     return
    }
    yield { type: 'text-delta', text: 'Recovered on attempt 3' }
    yield { type: 'finish', reason: { kind: 'stop' } }
   }
  })
  const lease = await service.openLease([{ provider: 'dynamic', model: 'new-model' }], {
   directory: root,
   headerFlushMs: 10,
   keepaliveMs: 15,
   streamIdleTimeoutMs: 45,
   maxAttempts: 3,
   retryDelayMs: 5
  })
  try {
   const response = await fetch(lease.url + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + lease.token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'dynamic/new-model', messages: [{ role: 'user', content: 'translate' }], stream: true })
   })
   assert.equal(response.status, 200)
   const body = await response.text()
   assert.match(body, /^: keepalive/m)
   assert.match(body, /Recovered on attempt 3/)
   assert.match(body, /\[DONE\]/)
   assert.equal(attemptNum, 3)

   const traceFiles = (await fs.readdir(root)).filter(f => f.startsWith('harness-'))
   assert.equal(traceFiles.length, 1)
   const trace = JSON.parse(await fs.readFile(path.join(root, traceFiles[0]), 'utf8'))
   assert.equal(trace.attempts.length, 3)
   assert.equal(trace.attempts[0].ok, false)
   assert.equal(trace.attempts[0].error.code, 'STREAM_IDLE_TIMEOUT')
   assert.equal(trace.attempts[1].ok, false)
   assert.equal(trace.attempts[1].error.code, 'PI_AI_ERROR')
   assert.equal(trace.attempts[2].ok, true)
   assert.equal(trace.error, null)

   // Quota exhaustion must fail immediately on 1 attempt without retrying.
   let quotaCalls = 0
   service.host.llm.prepareCall = async config => ({
    config,
    stream: async function* () {
     quotaCalls++
     yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'usage limit reached; Your quota will reset later' } } }
    }
   })
   const quotaRes = await fetch(lease.url + '/call', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + lease.token },
    body: JSON.stringify({ provider: 'dynamic', model: 'new-model', prompt: 'hi' })
   })
   assert.equal(quotaRes.status, 502)
   assert.equal(quotaCalls, 1)
  } finally {
   await lease.close()
  }
 } finally {
  await fs.rm(root, { recursive: true, force: true })
 }
})

test('extractFinalJsonlinePass recovers duplicate harmony passes on /v1/chat/completions while retaining raw trace and retrying incomplete passes', async () => {
 const userPrompt = '待翻译的文本为：\n```jsonline\n{"id":0,"text":"First paragraph."}\n{"id":1,"text":"Second paragraph."}\n```'
 const ids = expectedJsonlineIds([{ role: 'user', content: userPrompt }])
 assert.deepEqual(ids, [0, 1])

 const dupRaw = '{"id":0,"text":"第一段初稿"}\n{"id":0,"text":"第一段修订终稿"}\n{"id":1,"text":"第二段译文"}'
 const extracted = extractFinalJsonlinePass(dupRaw, ids)
 assert.equal(extracted.recovered, true)
 assert.equal(extracted.complete, true)
 assert.equal(extracted.text, '{"id":0,"text":"第一段修订终稿"}\n{"id":1,"text":"第二段译文"}')

 const cleanRaw = '<why>notes</why>\n{"id":0,"text":"一"}\n{"id":1,"text":"二"}'
 const cleanCheck = extractFinalJsonlinePass(cleanRaw, ids)
 assert.equal(cleanCheck.recovered, false)
 assert.equal(cleanCheck.complete, true)
 assert.equal(cleanCheck.text, cleanRaw)

 // End-to-end: attempt 1 emits incomplete JSONLINE (missing id 1), retries, attempt 2 emits duplicate harmony pass -> normalized wire output, raw trace preserved.
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-jsonline-'))
 try {
  const { service } = fixture()
  let calls = 0
  service.host.llm.prepareCall = async config => ({
   config,
   stream: async function* () {
    calls++
    if (calls === 1) {
     yield { type: 'text-delta', text: '{"id":0,"text":"只有第一段"}' }
     yield { type: 'finish', reason: { kind: 'stop' } }
     return
    }
    yield { type: 'text-delta', text: dupRaw }
    yield { type: 'finish', reason: { kind: 'stop' } }
   }
  })
  const lease = await service.openLease([{ provider: 'dynamic', model: 'new-model' }], { directory: root, maxAttempts: 3, retryDelayMs: 5 })
  try {
   const response = await fetch(lease.url + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + lease.token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'dynamic/new-model', messages: [{ role: 'user', content: userPrompt }], stream: false })
   })
   assert.equal(response.status, 200)
   const completion = await response.json()
   assert.equal(completion.choices[0].message.content, '{"id":0,"text":"第一段修订终稿"}\n{"id":1,"text":"第二段译文"}')
   assert.equal(calls, 2)

   const traceFile = path.join(root, (await fs.readdir(root)).find(f => f.startsWith('harness-')))
   const trace = JSON.parse(await fs.readFile(traceFile, 'utf8'))
   assert.equal(trace.wireNormalized, true)
   assert.equal(trace.response, dupRaw)
   assert.equal(trace.attempts.length, 2)
   assert.equal(trace.attempts[0].error.code, 'INVALID_JSONLINE_RESPONSE')
   assert.equal(trace.attempts[1].ok, true)
  } finally {
   await lease.close()
  }
 } finally {
  await fs.rm(root, { recursive: true, force: true })
 }
})
