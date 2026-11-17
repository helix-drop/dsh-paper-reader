import {compactCleaningUnits,partitionCleaningCandidates,applyConsolidation,AUTO_PASS_REASON} from '../modules/pipeline/glossary-semantics.js'
import {semanticFixture} from './glossary-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {sessionGuard} from '../modules/pipeline/guard.js'
import {encodeGlossaryUnit,verifyModelInputs,glossaryProviderFailure} from '../modules/pipeline/glossary-transport.js'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {hash,markdownBlocks} from '../modules/pipeline/markdown.js'
import {analyseBookGlossary,requireBookGlossary,analysisUnits,cleanCandidates,normalizeCjkPunctuation,glossaryTransportUnits,planGlossary,readPublicGlossary,registerJointReview,promoteReviewedGlossary,recoverGlossaryCheckpoint,decodeGlossaryRecord,decodeGlossaryOutput} from '../modules/pipeline/glossary.js'
import {prepareReviewAudit,assembleReviewAudit,applyReviewAudit,runAgyReviewAudit,buildAgyReviewPrompt,reviewAuditDirectory,AGY_CLI_GROUP,REVIEW_ORCHESTRATOR_MODELS,REVIEW_EFFORTS,isAgyCliModel,resolveAgyCliModelFlag,resolveAgyWorkerTier,normalizeReviewConfig} from '../modules/pipeline/review-audit.js'

async function setup(options={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-glossary-'))),file=path.join(root,'book.md'),source=options.source??'Risk here means an imminent danger, not a calculated probability. Dasein is a philosophical concept.\n\nLiberty is discussed as political freedom.\n'
 await fs.writeFile(file,source);await fs.mkdir(path.join(root,'lingua/glossaries'),{recursive:true});await fs.writeFile(path.join(root,'lingua/glossaries/master_academic.json'),JSON.stringify([{src:'risk',dst:'风险',info:'一般风险概念'},{src:'liberty',dst:'自由'}]))
 const manager=new TaskManager(root,path.join(root,'papers')),task={id:randomUUID(),name:'A new book',kind:'book',input:{type:'markdown',fingerprint:hash(source)},path:file,profile:{language:'en',confirmed:true,source_fingerprint:hash(source)},stages:{inspect:{state:'done'}},log:[],state:'idle',bookmarks:[]}
 manager.original=async()=>file;manager.get=async()=>task;manager.save=async t=>t
 manager.cliStatus=async()=>({version:'offline-test',model:{name:'Test model',model:'fake',credentialConfigured:true,threshold:{input_token_limit:2000}}})
 const calls=[],requestLog=[];manager.glossaryRequestLog=async()=>requestLog;manager.watchGlossaryProviderFailure=async()=>()=>{};let failure=options.failure,decision=options.decision
 manager.command=async(_t,_cmd,args,io)=>{
  const input=args[args.indexOf('--input')+1],output=args[args.indexOf('--output-dir')+1],units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse),kind=path.basename(input,'.txt');calls.push(kind)
  if(failure==='request')throw new Error('offline model failure')
  const records=units.map(unit=>{
   const semantic=semanticFixture(unit,kind);if(semantic){if(decision==='unresolved')for(const group of semantic.groups??[])group.uncertain=true;return semantic}
   if(kind==='analysis'){
    const specs=options.terms??[{src:'Risk',dst:'危险',sense:'本书指眼前危险'},{src:'Dasein',dst:'此在',sense:'哲学概念'},{src:'Liberty',dst:'自由',sense:'政治自由'}],terms=[]
    for(const spec of specs){const passage=unit.passages.find(p=>p.text.toLowerCase().includes(spec.src.toLowerCase()));if(passage)terms.push({category:'concept',uncertain:false,evidence:{blockId:passage.blockId,quote:passage.text},...spec})}
    return {unitId:unit.unitId,terms}
   }
   return {unitId:unit.unitId,decision:decision??'book_override',dst:decision==='public'?unit.publicOptions[0].dst:unit.candidates[0]?.dst??'危险',reason:'原文明确区分了概念的含义',scope:'仅用于本书所讨论的直接危险',evidence:{blockId:unit.passages[0].blockId,quote:unit.passages[0].text}}
  })
  requestLog.push({started_at:new Date().toISOString(),ended_at:new Date().toISOString(),pairs:units.map((u,i)=>({src:JSON.stringify(u),dst:failure==='malformed'?'not JSON':failure==='missing'&&i===0?'':JSON.stringify(records[i])}))})
  await fs.writeFile(path.join(output,path.basename(input)),failure==='malformed'?'not JSON\n':(failure==='missing'?records.slice(1):records).map(r=>JSON.stringify(r)).join('\n')+'\n')
  await io.onLine(JSON.stringify({type:'finished',status:'done'}))
 }
 return {root,file,source,manager,task,calls,requestLog,setFailure:value=>{failure=value},setDecision:value=>{decision=value},close:()=>fs.rm(root,{recursive:true,force:true})}
}

test('all source blocks and long paragraphs enter analysis without dropping text',()=>{
 const source='## A\n\n'+('A😀 long paragraph. '.repeat(600))+'\n\n[^1]: A note.'
 const {units,blocks}=analysisUnits(source,100)
 for(const block of blocks)assert.equal(units.flatMap(u=>u.passages).filter(p=>p.blockId===block.id).map(p=>p.text).join(''),block.text)
 assert(units.length>2);assert(units.flatMap(u=>u.passages).every(p=>p.text.isWellFormed()))
})
test('cleaning retains short and once-only concepts and rejects unsupported source evidence',()=>{
 const source='Freud distinguishes Es as a technical concept.\n\n此在具有特殊的哲学含义。',blocks=markdownBlocks(source)
 const records=[{terms:[{src:'Es',dst:'本我',category:'concept',sense:'精神分析概念',evidence:{blockId:blocks[0].id,quote:blocks[0].text}},{src:'此在',dst:'Dasein',category:'concept',sense:'哲学概念',evidence:{blockId:blocks[1].id,quote:blocks[1].text}},{src:'invented',dst:'伪造',category:'concept',sense:'unknown',evidence:{blockId:blocks[0].id,quote:'not present'}}]}]
 const cleaned=cleanCandidates(records,blocks);assert.equal(cleaned.terms.length,2);assert.equal(cleaned.dropped.length,1)
})
test('one cleaning pass creates book overrides and defers public additions until joint review',async()=>{
 const f=await setup();try{
  const receipt=await analyseBookGlossary(f.manager,f.task);f.task.stages.glossary={state:'done'}
  assert.deepEqual(f.calls,['analysis','consolidation']);assert.equal(receipt.engine,'LinguaGacha');assert.equal(receipt.cleaningCompleted,true);assert.equal(receipt.semanticVerified,false)
  const directory=path.join(f.manager.dir(f.task.id),'glossary'),shared=JSON.parse(await fs.readFile(path.join(directory,'common-snapshot.json'))),overrides=JSON.parse(await fs.readFile(path.join(directory,'book-overrides.json'))),effective=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary.json')))
  assert(!shared.some(e=>e.src.toLowerCase()==='risk'));assert.equal(overrides[0].dst,'危险');assert.equal(effective.find(e=>e.src.toLowerCase()==='risk').dst,'危险');assert.equal(effective.find(e=>e.src==='Dasein').dst,'此在')
  const common=await readPublicGlossary(f.root);assert.equal(common.entries.find(e=>e.src==='risk').dst,'风险');assert(!common.entries.some(e=>e.src==='Dasein'));await assert.rejects(fs.access(common.file))
  await requireBookGlossary(f.manager,f.task);await analyseBookGlossary(f.manager,f.task);assert.deepEqual(f.calls,['analysis','consolidation'])
  await fs.writeFile(path.join(directory,'book-overrides.json'),'[]');await assert.rejects(requireBookGlossary(f.manager,f.task),/合并记录变化/)
 }finally{await f.close()}
})

test('an existing or empty glossary file cannot bypass mandatory LinguaGacha analysis',async()=>{
 const f=await setup();try{
  await fs.mkdir(f.manager.dir(f.task.id),{recursive:true});await fs.writeFile(path.join(f.manager.dir(f.task.id),'glossary.json'),'[]');f.task.stages.glossary={state:'done'}
  await assert.rejects(requireBookGlossary(f.manager,f.task),/必须完成/)
  await assert.rejects(f.manager.prepareCliTranslation(f.task),/必须完成/)
  f.task.phaseApproval={phase:'translation'};await assert.rejects(f.manager.start(f.task.id,'lgProject',{singleStep:true}),/必须完成/)
  assert.deepEqual(f.calls,[])
 }finally{await f.close()}
})
test('semantic uncertainty preserves original terms for translation and goes to joint review',async()=>{
 const f=await setup({decision:'unresolved'});try{
  const receipt=await analyseBookGlossary(f.manager,f.task);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
  assert(receipt.reviewIssues>0);assert.deepEqual(f.calls,['analysis','consolidation'])
  const dir=path.join(f.manager.dir(f.task.id),'glossary'),effective=JSON.parse(await fs.readFile(path.join(dir,'effective.json')));assert(effective.every(e=>e.src===e.dst));assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'public-candidates.json'))),[])
  await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')))
 }finally{await f.close()}
})

test('missing output units and failed requests preserve evidence and require an explicit retry',async()=>{
 const f=await setup({failure:'malformed'});try{
  await assert.rejects(analyseBookGlossary(f.manager,f.task));assert.equal(f.calls.length,1)
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/显式重试/);assert.equal(f.calls.length,1)
  f.setFailure(null);await analyseBookGlossary(f.manager,f.task,{retryErrors:true});assert.deepEqual(f.calls,['analysis','analysis','consolidation'])
 }finally{await f.close()}
})
test('empty analysis is complete only with coverage receipts, and source changes invalidate it',async()=>{
 const f=await setup({source:'A short introductory passage without specialised expressions.',terms:[]});try{
  const receipt=await analyseBookGlossary(f.manager,f.task);f.task.stages.glossary={state:'done'};assert.equal(receipt.effectiveTerms,0);await requireBookGlossary(f.manager,f.task)
  await fs.writeFile(f.file,f.source+' Changed.');await assert.rejects(requireBookGlossary(f.manager,f.task),/必须完成/)
 }finally{await f.close()}
})
test('successful book assembly stops before glossary until the next panel confirmation',async()=>{
 const f=await setup();try{
  const stages=[];f.manager.confirmed=async()=>{};f.manager.perform=async(t,stage)=>{stages.push(stage);if(stage==='glossary')assert.equal(t.stages.assemble.state,'done')}
  f.task.phaseApproval={phase:'transcription',workerId:'undefined:undefined'};await f.manager.start(f.task.id,'assemble');await f.manager.active.get(f.task.id)?.promise
  assert.deepEqual(stages,['assemble']);assert.equal(f.task.stages.glossary,undefined);assert.equal(f.task.state,'idle')
 }finally{await f.close()}
})
test('an analysis failure keeps successful transcription and assembly rather than retrying them',async()=>{
 const f=await setup();try{
  f.manager.confirmed=async()=>{};f.manager.perform=async(_t,stage)=>{if(stage==='glossary')throw new Error('analysis blocked')}
  f.task.stages.transcribe={state:'done'};f.task.phaseApproval={phase:'transcription',workerId:'undefined:undefined'};await f.manager.start(f.task.id,'assemble');await f.manager.active.get(f.task.id)?.promise
  f.task.phaseApproval={phase:'translation'};await f.manager.start(f.task.id,'glossary');await f.manager.active.get(f.task.id)?.promise
  assert.equal(f.task.stages.transcribe.state,'done');assert.equal(f.task.stages.assemble.state,'done');assert.equal(f.task.stages.glossary.state,'blocked');assert.equal(f.task.stage,'glossary')
 }finally{await f.close()}
})

test('unchanged inputs reuse analysis and the single cleaning result without extra model passes',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task);await analyseBookGlossary(f.manager,f.task,{retryErrors:true});assert.deepEqual(f.calls,['analysis','consolidation']);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('missing analysis units cannot produce a complete glossary',async()=>{
 const f=await setup({failure:'missing'});try{
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/原始返回缺失/)
  await assert.rejects(fs.access(path.join(f.manager.dir(f.task.id),'glossary/pipeline-receipt.json')))
  await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')))
 }finally{await f.close()}
})
test('ambiguous legacy defaults require source-based decisions and stay outside the safe registry',async()=>{
 const f=await setup({source:'Risk has a specific meaning in this argument.',terms:[]});try{
  await fs.writeFile(path.join(f.root,'lingua/glossaries/master_academic.json'),JSON.stringify([{src:'Risk',dst:'风险'},{src:'risk',dst:'危险'}]))
  const common=await readPublicGlossary(f.root);assert.equal(common.entries.length,0);assert.equal(common.ambiguous.length,1)
  const plan=planGlossary(common,{terms:[]},markdownBlocks(f.source),'en');assert.equal(plan.conflicts.length,1);assert.equal(plan.shared.length,0)
  f.setDecision('public');await analyseBookGlossary(f.manager,f.task)
  const updated=await readPublicGlossary(f.root);assert.equal(updated.entries.length,0);assert.equal(updated.ambiguous.length,1)
 }finally{await f.close()}
})
test('a later book keeps the shared rendering without inheriting another book override',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task)
  const common=await readPublicGlossary(f.root),blocks=markdownBlocks('Risk denotes the probability of future loss.')
  const plan=planGlossary(common,{terms:[{src:'risk',dst:'风险',sense:'损失概率',uncertain:false}]},blocks,'en')
  assert.equal(plan.conflicts.length,0);assert.equal(plan.shared[0].dst,'风险');assert.equal(plan.overrides.length,0)
 }finally{await f.close()}
})

test('task sessions can repair terminology and structure artifacts across stages',async()=>{
 const f=await setup();try{
  const taskDirectory=f.manager.dir(f.task.id),header={cwd:f.root,agentPreset:'reading-document'},exec={name:'write',agent:{session:{header}},arguments:{path:path.join(taskDirectory,'translation/analysis/glossary.json')}}
  assert.equal(sessionGuard(f.root,exec,{taskDirectory,authorizedStage:'glossary'}),undefined)
  exec.arguments.path=path.join(taskDirectory,'glossary.json');assert.equal(sessionGuard(f.root,exec,{taskDirectory,authorizedStage:'glossary'}),undefined)
  exec.arguments.path=path.join(taskDirectory,'document/ai_convert/chapters.json');assert.equal(sessionGuard(f.root,exec,{taskDirectory,authorizedStage:'prepare'}),undefined)
 }finally{await f.close()}
})

test('LinguaGacha quote formatting is restored from source and paraphrases fall back to authentic block quotes while absent terms are dropped',()=>{
 const blocks=markdownBlocks('Foucault’s “bio-politics” concerns the governance of populations. 😀')
 const term={src:'bio-politics',dst:'生命政治',category:'concept',sense:'群体治理',evidence:{blockId:blocks[0].id,quote:'Foucault’s 「bio-politics」 concerns the governance of populations.'}}
 const result=cleanCandidates([{terms:[term,{...term,src:'biopower',dst:'生命权力',evidence:{...term.evidence,quote:'Foucault’s 「biopower」 concerns the treatment of patients.'}}]}],blocks)
 assert.equal(result.terms.length,1);assert.equal(result.dropped.length,1)
 assert.equal(result.terms[0].evidence[0].quote,'Foucault’s “bio-politics” concerns the governance of populations.')
 assert.equal(result.terms[0].evidence[0].returnedQuote,term.evidence.quote)
 const paraphrased=cleanCandidates([{terms:[{...term,evidence:{blockId:blocks[0].id,quote:'Foucault’s 「bio-politics」 concerns the treatment of patients.'}}]}],blocks)
 assert.equal(paraphrased.terms.length,1);assert.equal(paraphrased.dropped.length,0)
 assert.equal(paraphrased.terms[0].evidence[0].quote,blocks[0].text)
 assert.equal(paraphrased.terms[0].evidence[0].normalization,'derived-from-block')
})

test('a verified native checkpoint resumes only unfinished units and remains part of the final evidence',async()=>{
 const f=await setup({source:'Ordinary prose. '.repeat(260)+'\n\nA final passage without terminology.',terms:[]}),native=await fs.mkdtemp(path.join(os.tmpdir(),'linguagacha-cli-'));try{
  const originalCommand=f.manager.command,requested=[];let first=true
  f.manager.command=async(t,cmd,args,io)=>{
   const input=args[args.indexOf('--input')+1],units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse);requested.push(units.length)
   if(first){first=false;const db=new DatabaseSync(path.join(native,'cli-job.lg'));try{
    db.exec('CREATE TABLE meta(key TEXT,value TEXT);CREATE TABLE rules(type TEXT,data TEXT);CREATE TABLE items(data TEXT)')
    db.prepare('INSERT INTO meta VALUES (?,?)').run('created_at',JSON.stringify(new Date().toISOString()))
    db.prepare('INSERT INTO rules VALUES (?,?)').run('translation_prompt',JSON.stringify({text:await fs.readFile(args[args.indexOf('--prompt')+1],'utf8')}))
    for(const [index,unit] of units.entries())db.prepare('INSERT INTO items VALUES (?)').run(JSON.stringify({src:JSON.stringify(unit),dst:index===0?JSON.stringify({unitId:unit.unitId,terms:[]}):'',status:index===0?'PROCESSED':'NONE'}))
   }finally{db.close()}f.requestLog.push({started_at:new Date().toISOString(),ended_at:new Date().toISOString(),pairs:[{src:JSON.stringify(units[0]),dst:'{}'}]});throw new Error('test interrupted after one unit')}
   return originalCommand(t,cmd,args,io)
  }
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/test interrupted/)
  const receipt=await analyseBookGlossary(f.manager,f.task,{retryErrors:true});assert.equal(requested[1],requested[0]-1);assert.equal(receipt.analysisUnits,requested[0])
  const job=f.task.glossaryRuns.analysis,run=JSON.parse(await fs.readFile(job.receiptFile));assert.equal(run.reusedUnits,1);assert.equal(run.requestedUnits,requested[1])
  f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
  const cp=JSON.parse(await fs.readFile(path.join(job.directory,'checkpoint.json'))),database=Object.keys(cp.artifacts).find(x=>x.endsWith('.lg'))
  await fs.appendFile(path.join(job.directory,database),'changed');await requireBookGlossary(f.manager,f.task)
 }finally{await f.close();await fs.rm(native,{recursive:true,force:true})}
})

test('serialization recovery adds closing containers only and refuses unfinished strings or missing values',()=>{
 const complete={unitId:'a-test',terms:[{src:'a',dst:'甲',evidence:{quote:'A source quotation.'}}]},raw=JSON.stringify(complete).slice(0,-1),decoded=decodeGlossaryRecord(raw)
 assert.deepEqual(decoded.record,complete);assert.equal(decoded.repair.appended,'}')
 assert.throws(()=>decodeGlossaryRecord('{"unitId":"a","terms":[{"src":"unfinished'))
 assert.throws(()=>decodeGlossaryRecord('{"unitId":"a","terms":'))
 assert.throws(()=>decodeGlossaryRecord('{"unitId":"a","terms":[,]}'))
})
test('completed raw CLI output can be recovered without repeating model requests',async()=>{
 const f=await setup({source:'A short ordinary passage.',terms:[]});try{
  const originalCommand=f.manager.command;let requested=0
  f.manager.command=async(t,cmd,args,io)=>{const analysis=path.basename(args[args.indexOf('--input')+1])==='analysis.txt';if(analysis)requested++;await originalCommand(t,cmd,args,io);if(analysis)throw new Error('interrupted after export')}
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/interrupted after export/)
  const receipt=await analyseBookGlossary(f.manager,f.task,{retryErrors:true});assert.equal(requested,1);assert.equal(receipt.analysisUnits,1)
  f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('JSON fences are removed as framing while data and expected unit records remain intact',()=>{
 const record={unitId:'a',terms:[]},line=JSON.stringify(record),fenced=decodeGlossaryRecord(line+'\n```')
 assert.deepEqual(fenced.record,record);assert.equal(fenced.repair.kind,'json-fence-only')
 const result=decodeGlossaryOutput('```json\n'+line+'\n```\n'+JSON.stringify({unitId:'b',terms:[]}))
 assert.deepEqual(result.decoded.map(x=>x.record.unitId),['a','b']);assert.equal(result.repairs.length,2)
 assert.throws(()=>decodeGlossaryOutput(line+'\nextra commentary'))
})

test('the evidence text alias is accepted or replaced with authentic block evidence while absent terms are dropped',()=>{
 const blocks=markdownBlocks('Sauvages wrote about the medicine of insanity.'),base={src:'Sauvages',dst:'索瓦日',category:'person',sense:'原文所提及的人名'}
 const exactClean=cleanCandidates([{terms:[{...base,evidence:{blockId:blocks[0].id,text:blocks[0].text}}]}],blocks)
 assert.equal(exactClean.terms.length,1);assert.equal(exactClean.terms[0].evidence[0].returnedField,'text');assert.equal(exactClean.terms[0].evidence[0].quote,blocks[0].text)
 const cleaned=cleanCandidates([{terms:[{...base,evidence:{blockId:blocks[0].id,text:'An invented quotation about Sauvages.'}},{...base,src:'Pinel',dst:'皮内尔',evidence:{blockId:blocks[0].id,text:'Pinel wrote about insanity.'}}]}],blocks)
 assert.equal(cleaned.terms.length,1);assert.equal(cleaned.dropped.length,1);assert.equal(cleaned.terms[0].evidence[0].returnedField,'text');assert.equal(cleaned.terms[0].evidence[0].quote,blocks[0].text);assert.equal(cleaned.terms[0].evidence[0].normalization,'derived-from-block')
})

test('unescaped quotes are repaired only when every original string value is preserved',()=>{
 const raw='{"unitId":"c-a","decision":"public","dst":"萨特","reason":"公共选项"萨特"准确","scope":"本书译作"萨特"","evidence":{"blockId":"b","quote":"An original quotation."}}',decoded=decodeGlossaryRecord(raw)
 assert.equal(decoded.record.reason,'公共选项"萨特"准确');assert.equal(decoded.record.scope,'本书译作"萨特"');assert.equal(decoded.repair.kind,'json-syntax-only-string-fields-preserved')
 assert.throws(()=>decodeGlossaryRecord('{"unitId":"a","terms":[{"src":"a","dst":undefined}]}'))
 assert.throws(()=>decodeGlossaryRecord('{"unitId":"a","terms":[{"src":"unfinished}]}'))
})
test('different explanations of one agreed rendering remain documented without creating a translation conflict',()=>{
 const blocks=markdownBlocks('Dynamic nominalism is discussed in two contexts.'),common={entries:[],ambiguous:[]},terms=[{src:'Dynamic nominalism',dst:'动态唯名论',sense:'概念说明甲',uncertain:false},{src:'Dynamic nominalism',dst:'动态唯名论',sense:'概念说明乙',uncertain:false}],plan=planGlossary(common,{terms},blocks,'en')
 assert.equal(plan.conflicts.length,0);assert.equal(plan.shared.length,1);assert.deepEqual(plan.shared[0].contextualSenses,['概念说明甲','概念说明乙']);assert.equal(plan.additions.length,1)
})
test('changed public options rerun cleaning but reuse verified full-source extraction',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task)
  const publicFile=path.join(f.root,'lingua/glossaries/master_academic.json'),common=JSON.parse(await fs.readFile(publicFile));common.find(x=>x.src==='risk').dst='风控';await fs.writeFile(publicFile,JSON.stringify(common))
  await analyseBookGlossary(f.manager,f.task);assert.deepEqual(f.calls,['analysis','consolidation','consolidation']);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('protected JSON preserves all source data while defeating slash, bracket and ruby cleanup',()=>{
 const unit={unitId:'c-test',term:'a/b',publicOptions:[],candidates:[{sense:'解释甲/解释乙'}],passages:[{blockId:'b',text:'A [term/reading] and |term[reading], <ruby><rb>word</rb></ruby>, file.pdf.'}]},encoded=encodeGlossaryUnit(unit)
 assert.deepEqual(JSON.parse(encoded),unit)
 const processed=encoded.replace(/\[(.+)\/.+\]/giu,'$1').replace(/\((.+)\/.+\)/giu,'$1').replace(/\|(.+?)\[.+?\]/giu,'$1').replace(/<ruby>.*?<rb>(.*?)<\/rb>.*?<\/ruby>/giu,'$1')
 assert.equal(processed,encoded)
})
test('apparently valid output cannot pass when preprocessing changed the actual model input',async()=>{
 const f=await setup();try{
  const original=f.manager.command;f.manager.command=async(...args)=>{await original(...args);const last=f.requestLog.at(-1),unit=JSON.parse(last.pairs[0].src);unit.passages=[];last.pairs[0].src=JSON.stringify(unit)}
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/改变或遗漏了实际术语输入/)
  await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')))
 }finally{await f.close()}
})

test('a changed output identifier is quarantined while verified sibling records resume without new requests',async()=>{
 const f=await setup({source:'Ordinary prose. '.repeat(350),terms:[]});try{
  const command=f.manager.command,requests=[];let corrupt=true
  f.manager.command=async(...args)=>{const cli=args[2],input=cli[cli.indexOf('--input')+1],output=cli[cli.indexOf('--output-dir')+1];requests.push((await fs.readFile(input,'utf8')).trim().split('\n').length);await command(...args);if(corrupt){corrupt=false;const file=path.join(output,path.basename(input)),records=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);records[0].unitId='UNKNOWN';f.requestLog.at(-1).pairs[0].dst=JSON.stringify(records[0]);await fs.writeFile(file,records.map(JSON.stringify).join('\n'))}}
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/缺失、重复/)
  await analyseBookGlossary(f.manager,f.task,{retryErrors:true});assert(requests[0]>1);assert.equal(requests[1],1)
  f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})
test('delta cleaning omits unchanged groups without requesting another pass',async()=>{
 const f=await setup();try{
  const command=f.manager.command;let corrupt=true
  f.manager.command=async(...args)=>{await command(...args);const cli=args[2];if(corrupt&&path.basename(cli[cli.indexOf('--input')+1])==='consolidation.txt'){corrupt=false;const pair=f.requestLog.at(-1).pairs[0],record=JSON.parse(pair.dst);record.groups.pop();pair.dst=JSON.stringify(record)}}
  await analyseBookGlossary(f.manager,f.task);assert.deepEqual(f.calls,['analysis','consolidation']);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('export punctuation cannot alter original response identifiers or source evidence',async()=>{
 const f=await setup();try{
  const command=f.manager.command
  f.manager.command=async(...args)=>{await command(...args);const cli=args[2],input=cli[cli.indexOf('--input')+1],file=path.join(cli[cli.indexOf('--output-dir')+1],path.basename(input));await fs.writeFile(file,(await fs.readFile(file,'utf8')).replaceAll('G0001','G—0001'))}
  await analyseBookGlossary(f.manager,f.task);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
  const r=JSON.parse(await fs.readFile(f.task.glossaryRuns.consolidation.receiptFile));assert((await fs.readFile(r.exportFile,'utf8')).includes('G—0001'));assert((await fs.readFile(r.rawFile,'utf8')).includes('G0001'))
  await fs.appendFile(r.modelOutputEvidenceFile,'changed');await requireBookGlossary(f.manager,f.task)
  await fs.appendFile(path.join(f.manager.dir(f.task.id),'glossary/effective.json'),'changed');await assert.rejects(requireBookGlossary(f.manager,f.task),/合并记录变化/)
 }finally{await f.close()}
})

test('the single cleaning pass removes a narrative clause while retaining a conceptual term',async()=>{
 const f=await setup({source:'New realities effectively came into being. Dynamic nominalism is a theoretical concept.',terms:[{src:'New realities effectively came into being',dst:'新的现实产生了',sense:'叙述句'},{src:'Dynamic nominalism',dst:'动态唯名论',sense:'分类与被分类者共同出现的理论'}]});try{
  const command=f.manager.command
  f.manager.command=async(...args)=>{await command(...args);const cli=args[2];if(path.basename(cli[cli.indexOf('--input')+1])==='consolidation.txt'){for(const pair of f.requestLog.at(-1).pairs){const unit=JSON.parse(pair.src),record=JSON.parse(pair.dst);for(const group of record.groups)for(const item of group.members)if(unit.entries.find(e=>(e.entryId??e.id)===(item.entryId??item.id)).src.startsWith('New realities')){item.action='drop';item.reason='完整叙述句，并非术语'}pair.dst=JSON.stringify(record)}}}
  const report=await analyseBookGlossary(f.manager,f.task);assert.equal(report.cleaningCompleted,true);assert.equal(report.dropped,1)
  const dir=path.join(f.manager.dir(f.task.id),'glossary'),terms=JSON.parse(await fs.readFile(path.join(dir,'effective.json')));assert.equal(terms.length,1);assert.equal(terms[0].src,'Dynamic nominalism');assert.deepEqual(f.calls,['analysis','consolidation']);await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')))
 }finally{await f.close()}
})

test('full names and surnames reconcile across different source keys without replacing global defaults',async()=>{
 const f=await setup({source:'Pierre Janet discussed the case. Janet revisited the same case.',terms:[{src:'Pierre Janet',dst:'皮埃尔·让内',sense:'同一位法国精神病学家'}]});try{
  await fs.writeFile(path.join(f.root,'lingua/glossaries/master_academic.json'),JSON.stringify([{src:'JANET',dst:'雅内',info:'精神病学家'}]))
  const command=f.manager.command
  f.manager.command=async(...args)=>{await command(...args);const cli=args[2],input=cli[cli.indexOf('--input')+1];if(path.basename(input)==='consolidation.txt'){const pair=f.requestLog.at(-1).pairs[0],unit=JSON.parse(pair.src),record={unitId:unit.unitId,groups:[{members:unit.entries.map(e=>({...(e.entryId?{entryId:e.entryId}:{id:e.id}),dst:e.src==='JANET'?'让内':'皮埃尔·让内',action:'keep'})),category:'person',reason:'原文两种称谓指同一人物，中文姓氏统一',scope:'仅在本书指这一人物',uncertain:false,publicEligible:true,publicReason:'模型误判为可以公共复用，程序仍应保护既有公共别名'}]};pair.dst=JSON.stringify(record);await fs.writeFile(path.join(cli[cli.indexOf('--output-dir')+1],'consolidation.txt'),pair.dst)}}
  await analyseBookGlossary(f.manager,f.task);const terms=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary.json')));assert.equal(terms.find(t=>t.src==='JANET').dst,'让内');assert.equal(terms.find(t=>t.src==='Pierre Janet').dst,'皮埃尔·让内');assert.equal((await readPublicGlossary(f.root)).entries[0].dst,'雅内');assert.equal((await readPublicGlossary(f.root)).entries.length,1)
  const groups=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary/semantic-groups.json')));assert.equal(groups.length,1);assert.equal(groups[0].members.length,2);assert.equal(groups[0].publicEligible,false);const local=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary/book-overrides.json')));assert.equal(local.length,2);assert(local.every(e=>e.evidence.length>0))
 }finally{await f.close()}
})
test('a malformed cleaning partition cannot admit terms or release translation',async()=>{
 const f=await setup();try{
  const command=f.manager.command;f.manager.command=async(...args)=>{await command(...args);const cli=args[2];if(path.basename(cli[cli.indexOf('--input')+1])==='consolidation.txt'){const pair=f.requestLog.at(-1).pairs[0],record=JSON.parse(pair.dst);record.groups.push(record.groups[0]);pair.dst=JSON.stringify(record)}}
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/遗漏、重复/);await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')));await assert.rejects(requireBookGlossary(f.manager,f.task),/必须完成/)
 }finally{await f.close()}
})

async function reviewFile(f,status='pass',extra=''){
 f.task.stages.glossary={state:'done'};const target=f.task.translationPath??path.join(f.manager.dir(f.task.id),'translated.md');if(!f.task.translationPath)await fs.writeFile(target,'A verified translation.');f.task.translationPath=target;f.task.translationReport={passed:true,sourceFingerprint:hash(f.source),targetFingerprint:hash(await fs.readFile(target))}
 const r=f.task.glossaryReport,report=path.join(f.manager.dir(f.task.id),'review/report.md');await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,`<!-- dsh-review-source:${r.sourceFingerprint} -->\n<!-- dsh-review-target:${f.task.translationReport.targetFingerprint} -->\n<!-- dsh-review-glossary:${r.effectiveFingerprint} -->\n<!-- dsh-review-issues:${r.issuesFingerprint} -->\n<!-- dsh-review-status:${status} -->\n${extra}`);return report
}
test('joint review needs current glossary and issues fingerprints; pending findings cannot promote terms',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task);const report=await reviewFile(f,'needs-work');await registerJointReview(f.manager,f.task,report);assert.equal(f.task.review.status,'needs-work');await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')))
  await fs.writeFile(report,(await fs.readFile(report,'utf8')).replace(f.task.glossaryReport.issuesFingerprint,'stale'));await assert.rejects(registerJointReview(f.manager,f.task,report),/当前术语表/)
 }finally{await f.close()}
})

test('semantically reviewed but book-specific new terms remain outside the public registry',async()=>{
 const f=await setup({source:'Dasein is discussed here.',terms:[{src:'Dasein',dst:'此在',sense:'本书的特定义法'}]});try{
  const command=f.manager.command;f.manager.command=async(...args)=>{await command(...args);const cli=args[2],input=cli[cli.indexOf('--input')+1];if(path.basename(input)==='consolidation.txt'){const pair=f.requestLog.at(-1).pairs[0],record=JSON.parse(pair.dst);for(const group of record.groups){group.publicEligible=false;group.publicReason='仅在本书成立的特殊含义'}pair.dst=JSON.stringify(record)}}
  await analyseBookGlossary(f.manager,f.task);assert(!(await readPublicGlossary(f.root)).entries.some(e=>e.src==='Dasein'));const local=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary/book-overrides.json')));assert.equal(local[0].dst,'此在')
 }finally{await f.close()}
})
test('an earlier structural-only receipt cannot satisfy the complete semantic cleaning requirement',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task);f.task.stages.glossary={state:'done'};const file=path.join(f.manager.dir(f.task.id),'glossary/pipeline-receipt.json'),receipt=JSON.parse(await fs.readFile(file));receipt.schemaVersion=2;delete receipt.semanticVerified;await fs.writeFile(file,JSON.stringify(receipt));await assert.rejects(requireBookGlossary(f.manager,f.task),/必须完成/)
 }finally{await f.close()}
})

test('only a passing joint review admits public candidates and repeated registration is idempotent',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task);const report=await reviewFile(f);await registerJointReview(f.manager,f.task,report);assert.equal(f.task.review.semanticVerified,true)
  const common=await readPublicGlossary(f.root);assert.equal(common.entries.find(e=>e.src==='Dasein').dst,'此在');assert.equal(common.entries.find(e=>e.src==='risk').dst,'风险');assert.equal(common.entries.length,3)
  await registerJointReview(f.manager,f.task,report);assert.equal((await readPublicGlossary(f.root)).entries.length,3);assert.deepEqual(f.calls,['analysis','consolidation'])
  await fs.appendFile(f.task.translationPath,'changed');await assert.rejects(registerJointReview(f.manager,f.task,report),/当前原文与译文/)
 }finally{await f.close()}
})

test('one cleaning pass receives both conceptual inflections and unifies their renderings',async()=>{
 const f=await setup({source:'A kind of person and kinds of persons are central conceptual expressions here.',terms:[{src:'kind of person',dst:'一类人',sense:'分类过程中形成的人的类型'},{src:'kinds of persons',dst:'人的种类',sense:'同一核心概念的复数形式'}]});try{
  const command=f.manager.command
  f.manager.command=async(...args)=>{await command(...args);const cli=args[2],kind=path.basename(cli[cli.indexOf('--input')+1],'.txt');if(kind==='consolidation'){const pair=f.requestLog.at(-1).pairs[0],unit=JSON.parse(pair.src);assert(unit.entries.some(e=>e.src==='kind of person'));pair.dst=JSON.stringify({unitId:unit.unitId,groups:[{members:unit.entries.map(e=>({...(e.entryId?{entryId:e.entryId}:{id:e.id}),dst:'人的类型',action:'keep'})),category:'concept',reason:'原文将两种词形用于同一核心概念，恢复误删的单数形式',scope:'本书的概念用法',uncertain:false,publicEligible:false,publicReason:'本书特定论证中的概念处理'}]})}}
  await analyseBookGlossary(f.manager,f.task);const dir=f.manager.dir(f.task.id),effective=JSON.parse(await fs.readFile(path.join(dir,'glossary.json')));assert.equal(effective.length,2);assert(effective.every(e=>e.dst==='人的类型'));const cleaned=JSON.parse(await fs.readFile(path.join(dir,'glossary/cleaned.json')));assert.equal(cleaned.dropped.length,0);assert.equal(cleaned.terms.length,2)
 }finally{await f.close()}
})

test('paused terminology work recovers original model responses even when export changed identifiers',async()=>{
 const f=await setup({source:'Ordinary source prose. '.repeat(240),terms:[]});try{
  const command=f.manager.command,counts=[];let interrupted=false
  f.manager.command=async(t,cmd,args,io)=>{const input=args[args.indexOf('--input')+1],units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse);if(path.basename(input)==='analysis.txt'){counts.push(units.length);if(!interrupted){interrupted=true;await command(t,cmd,args,{onLine:async()=>{}});const request=f.requestLog.at(-1);request.pairs=request.pairs.slice(0,1);await fs.writeFile(path.join(args[args.indexOf('--output-dir')+1],'analysis.txt'),request.pairs[0].dst.replaceAll('G0001','G—0001'));throw new Error('paused before all units completed')}}return command(t,cmd,args,io)}
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/paused before/);await analyseBookGlossary(f.manager,f.task,{retryErrors:true});assert.equal(counts[1],counts[0]-1);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('a public homograph from another explicit language cannot enter this book through full-table consolidation',async()=>{
 const f=await setup({source:'I felt pain today.',terms:[]});try{
  await fs.writeFile(path.join(f.root,'lingua/glossaries/master_academic.json'),JSON.stringify([{src:'pain',dst:'面包',language:'fr'}]));const report=await analyseBookGlossary(f.manager,f.task);assert.equal(report.effectiveTerms,0);assert.equal(report.reviewedEntries,0);assert.deepEqual((await readPublicGlossary(f.root)).entries.map(e=>e.language),['fr'])
 }finally{await f.close()}
})

test('inconsistent surnames become a joint-review issue and preserve original names',async()=>{
 const f=await setup({source:'Pierre Janet discussed the case. Janet revisited the same case.',terms:[{src:'Pierre Janet',dst:'皮埃尔·让内',sense:'同一人物'}]});try{
  await fs.writeFile(path.join(f.root,'lingua/glossaries/master_academic.json'),JSON.stringify([{src:'JANET',dst:'雅内'}]));const command=f.manager.command
  f.manager.command=async(...args)=>{await command(...args);const cli=args[2];if(path.basename(cli[cli.indexOf('--input')+1])==='consolidation.txt'){const pair=f.requestLog.at(-1).pairs[0],unit=JSON.parse(pair.src);pair.dst=JSON.stringify({unitId:unit.unitId,groups:[{members:unit.entries.map(e=>({...(e.entryId?{entryId:e.entryId}:{id:e.id}),dst:e.src==='JANET'?'雅内':'皮埃尔·让内',action:'keep'})),category:'person',reason:'模型声称是同一人物但没有统一姓氏',scope:'本书人物',uncertain:false,publicEligible:true,publicReason:'模型错误批准'}]})}}
  const receipt=await analyseBookGlossary(f.manager,f.task);assert.equal(receipt.reviewIssues,1);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task);const terms=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary.json')));assert(terms.every(e=>e.src===e.dst));await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')))
 }finally{await f.close()}
})

test('a recorded rejection allows retries up to the breaker limit while persisted exhaustion blocks the next retry',async()=>{
 const f=await setup({failure:'request'});try{
  await assert.rejects(analyseBookGlossary(f.manager,f.task));const file=f.task.glossaryRuns.analysis.receiptFile,receipt=JSON.parse(await fs.readFile(file));receipt.status='provider-rejected';receipt.providerFailure={reason:'content_filter',observedVia:'native-log'};receipt.providerRetryCount=10;await fs.writeFile(file,JSON.stringify(receipt));f.setFailure(null);await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:true}),/连续失败 10 次/);assert.equal(f.calls.length,1)
 }finally{await f.close()}
})
test('provider rejection stops immediately and explicit retries retain a shared 10-failure breaker limit',async()=>{
 const f=await setup();try{
  let reject;f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}}
  const inputs=[];f.manager.command=async(_t,_c,args)=>{f.calls.push('request');inputs.push(await fs.readFile(args[args.indexOf('--input')+1],'utf8'));reject({reason:'content_filter',observedVia:'test'});throw new Error('provider rejected')}
  for(let i=0;i<10;i++){await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:i>0}),/已保留完成结果/);assert.equal(f.calls.length,i+1)};assert(inputs.every(x=>x===inputs[0]));const receipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile));assert.equal(receipt.providerRetryCount,9);assert.equal(receipt.resumeAvailable,false)
  await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:true}),/连续失败 10 次/);assert.equal(f.calls.length,10)
 }finally{await f.close()}
})
test('a transient provider rejection reuses completed siblings and can finish on retry',async()=>{
 const f=await setup({source:'Ordinary source. '.repeat(300),terms:[]});try{
  let reject,first=true;f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}};const command=f.manager.command,counts=[]
  f.manager.command=async(t,cmd,args,io)=>{const input=args[args.indexOf('--input')+1],units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse);counts.push(units.length);if(first){first=false;await command(t,cmd,args,{onLine:async()=>{}});f.requestLog.at(-1).pairs=f.requestLog.at(-1).pairs.slice(0,1);reject({reason:'content_filter',observedVia:'test'});throw new Error('provider rejected')}return command(t,cmd,args,io)}
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/已保留完成结果/);assert.equal(counts.length,1)
  await analyseBookGlossary(f.manager,f.task,{retryErrors:true});assert.equal(counts[1],counts[0]-1);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('short CJK public terms embedded in a sentence still receive mandatory semantic review',async()=>{
 const f=await setup({source:'此在具有特殊的哲学含义。',terms:[]});try{
  await fs.writeFile(path.join(f.root,'lingua/glossaries/master_academic.json'),JSON.stringify([{src:'此在',dst:'Dasein'}]));const report=await analyseBookGlossary(f.manager,f.task);assert.equal(report.reviewedEntries,1);assert.equal(report.effectiveTerms,1);const inventory=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary/cleaning-inventory.json')));assert.equal(inventory.units[0].entries[0].publicOptions[0].dst,'Dasein')
 }finally{await f.close()}
})

test('compact cleaning covers every key once and keeps names and inflections together',()=>{
 const source='Pierre Janet and Janet studied a kind of person and kinds of persons. '+('Ordinary detail. '.repeat(100)),blocks=markdownBlocks(source),terms=['Pierre Janet','Janet','kind of person','kinds of persons',...Array.from({length:45},(_,i)=>'term'+i)].map(src=>({src,dst:src,category:'concept',sense:'a compact meaning',evidence:[{blockId:blocks[0].id,quote:source}]}))
 const units=compactCleaningUnits({terms,dropped:[]},{entries:[],ambiguous:[]},blocks,hash(source),'en',16000),entries=units.flatMap(u=>u.entries)
 assert.equal(entries.length,terms.length);assert.equal(new Set(entries.map(e=>e.entryId)).size,terms.length)
 for(const pair of [['Pierre Janet','Janet'],['kind of person','kinds of persons']])assert(units.some(u=>pair.every(src=>u.entries.some(e=>e.src===src))))
 for(const u of units){assert(JSON.stringify(u).length<16000);for(const e of u.entries)for(const ref of e.evidence){const context=u.contexts.find(c=>c.contextId===ref.contextId);assert(blocks.some(b=>b.id===context.blockId&&b.text.includes(context.quote)))}}
})
test('public changes after cleaning preserve the book and skip conflicting reviewed additions',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task);const report=await reviewFile(f),common=await readPublicGlossary(f.root),entries=[...common.entries,{src:'Dasein',dst:'存在者',language:'en'}];await fs.mkdir(path.dirname(common.file),{recursive:true});await fs.writeFile(common.file,JSON.stringify({...common,entries,revision:'concurrent-change'}))
  await registerJointReview(f.manager,f.task,report);assert.equal((await readPublicGlossary(f.root)).entries.find(e=>e.src==='Dasein').dst,'存在者');assert.equal(f.task.glossaryPublication.skipped.length,1)
  const effective=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary.json')));assert.equal(effective.find(e=>e.src==='Dasein').dst,'此在');await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})
test('mixed review statuses cannot certify public admission',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task);const report=await reviewFile(f,'pass','<!-- dsh-review-status:needs-work -->');await registerJointReview(f.manager,f.task,report);assert.equal(f.task.review.status,'needs-work');await assert.rejects(fs.access(path.join(f.root,'.pipeline/glossaries/common.json')))
 }finally{await f.close()}
})

test('provider retry detection ignores source text and informational prompt logs',()=>{
 const event={source:'engine',level:'warning',created_at:'2026-10-16T04:00:00Z',content:'请求失败：Provider finish_reason: content_filter … (Key 1)'}
 assert.equal(glossaryProviderFailure(event).reason,'content_filter');assert.equal(glossaryProviderFailure({...event,content:'请求失败：模型请求超时。 … (Key 1)'}).reason,'timeout');assert.equal(glossaryProviderFailure({...event,level:'info'}),null);assert.equal(glossaryProviderFailure({...event,source:'document'}),null);assert.equal(glossaryProviderFailure({...event,content:'A passage discussing content_filter.'}),null)
})
test('user cancellation stops provider retries immediately',async()=>{
 const f=await setup();try{
  let reject;f.manager.active.set(f.task.id,{cancel:false});f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}}
  f.manager.command=async()=>{f.calls.push('request');reject({reason:'content_filter',observedVia:'test'});f.manager.active.get(f.task.id).cancel=true;throw new Error('cancelled')}
  await assert.rejects(analyseBookGlossary(f.manager,f.task));assert.equal(f.calls.length,1)
 }finally{await f.close()}
})

test('request timeouts share the same persisted breaker budget as content filters',async()=>{
 const f=await setup();try{
  let reject;f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}}
  f.manager.command=async()=>{f.calls.push('request');reject({reason:f.calls.length%2?'timeout':'content_filter',observedVia:'test'});throw new Error('provider failure')}
  for(let i=0;i<10;i++){await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:i>0}),/已保留完成结果/);assert.equal(f.calls.length,i+1)}
  const receipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile));assert.equal(receipt.providerRetryCount,9)
  await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:true}),/连续失败 10 次/);assert.equal(f.calls.length,10)
 }finally{await f.close()}
})

test('partial responses are saved locally even when the last permitted retry fails',async()=>{
 const f=await setup({source:'Ordinary source. '.repeat(300),terms:[]});try{
  let reject,n=0;f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}};const command=f.manager.command
  f.manager.command=async(t,c,args,io)=>{if(++n===10){await command(t,c,args,{onLine:async()=>{}});f.requestLog.at(-1).pairs=f.requestLog.at(-1).pairs.slice(0,1)}reject({reason:'content_filter',observedVia:'test'});throw new Error('provider failure')}
  for(let i=0;i<10;i++)await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:i>0}),/已保留完成结果/);const receipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile));assert.equal(receipt.providerRetryCount,9);assert.equal((await fs.readFile(receipt.partialOutputFile,'utf8')).trim().split('\n').length,1);assert.equal(n,10)
 }finally{await f.close()}
})

test('structured length-limit failures are detected before the CLI can retry them without a bound',()=>{
 const event={level:'error',source:'engine-worker',created_at:'2026-10-16T04:29:17Z',content:{kind:'translation_result',summary:['任务耗时 598.78 秒','请求失败：供应商返回长度截断。 …'],pairs:[{src:'original input',dst:''}]}}
 assert.equal(glossaryProviderFailure(event).reason,'output_limit');assert.equal(glossaryProviderFailure({...event,level:'info'}),null);assert.equal(glossaryProviderFailure({...event,content:{...event.content,summary:['任务成功']}}),null)
})
test('structured output limits cannot silently exceed the shared breaker budget',async()=>{
 const f=await setup();try{
  let reject;f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}}
  f.manager.command=async()=>{f.calls.push('request');reject({reason:'output_limit',observedVia:'test'});throw new Error('truncated response')}
  for(let i=0;i<10;i++){await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:i>0}),/已保留完成结果/);assert.equal(f.calls.length,i+1)}
  await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:true}),/连续失败 10 次/);assert.equal(f.calls.length,10)
 }finally{await f.close()}
})

test('raising the output budget reuses complete results with their original model receipts',async()=>{
 const f=await setup();try{
  let limit=32768;f.manager.cliStatus=async()=>({version:'offline-test',model:{name:'Test model',model:'fake',credentialConfigured:true,threshold:{input_token_limit:2000,output_token_limit:limit}}})
  await analyseBookGlossary(f.manager,f.task);const before=[...f.calls];limit=65536;await analyseBookGlossary(f.manager,f.task,{refreshGlossary:true});assert.deepEqual(f.calls,before);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})
test('a model id change reuses a completed glossary stored under the old model signature',async()=>{
 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task);const before=[...f.calls]
  const job=f.task.glossaryRuns.analysis,receipt=JSON.parse(await fs.readFile(job.receiptFile,'utf8'))
  const prompt=await fs.readFile(path.join(receipt.directory,'prompt.txt'),'utf8'),units=JSON.parse(await fs.readFile(receipt.transportFile,'utf8')).expectedUnits
  const state=hash(JSON.stringify({version:3,kind:'analysis',units,prompt,cliVersion:'offline-test'}))
  assert.equal(path.basename(job.directory),state)
  const legacy=hash(JSON.stringify({version:3,kind:'analysis',units,prompt,model:receipt.model,cliVersion:'offline-test'})),legacyDir=path.join(path.dirname(job.directory),legacy)
  const rewrite=value=>typeof value==='string'?value.split(job.directory).join(legacyDir):Array.isArray(value)?value.map(rewrite):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)])):value
  const moved=rewrite(receipt);moved.signature=legacy
  await fs.writeFile(job.receiptFile,JSON.stringify(moved,null,2)+'\n');await fs.rename(job.directory,legacyDir)
  f.task.glossaryRuns.analysis={directory:legacyDir,receiptFile:path.join(legacyDir,'receipt.json')}
  f.manager.cliStatus=async()=>({version:'offline-test',model:{name:'openrouter/openai/gpt-6-luna',model:'openrouter/openai/gpt-6-luna',credentialConfigured:true,threshold:{input_token_limit:2000}}})
  await analyseBookGlossary(f.manager,f.task,{refreshGlossary:true});assert.deepEqual(f.calls,before)
  f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})
test('raising the output budget resumes a partially completed batch without replaying valid siblings',async()=>{
 const terms=Array.from({length:160},(_,i)=>({src:'Term'+String(i).padStart(3,'0'),dst:'术语'+i,sense:'a specialised theoretical concept'})),source=terms.map(t=>t.src+' is a theoretical concept. '+('Its meaning follows from this argument. '.repeat(4))).join('\n\n'),f=await setup({terms,source});try{
  let limit=32768,reject,fail=true,n=0;const counts=[],command=f.manager.command
  f.manager.cliStatus=async()=>({version:'offline-test',model:{name:'Test model',model:'fake',credentialConfigured:true,threshold:{input_token_limit:2000,output_token_limit:limit}}})
  f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}}
  f.manager.command=async(t,c,args,io)=>{const file=args[args.indexOf('--input')+1];if(path.basename(file)==='consolidation.txt'){const units=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);counts.push(units.length);if(fail){if(++n===1){await command(t,c,args,{onLine:async()=>{}});f.requestLog.at(-1).pairs=f.requestLog.at(-1).pairs.slice(0,1)}reject({reason:'output_limit',observedVia:'test'});throw new Error('truncated')}}return command(t,c,args,io)}
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/已保留完成结果/);assert(counts[0]>1);limit=65536;fail=false;await analyseBookGlossary(f.manager,f.task,{refreshGlossary:true});assert.equal(counts.at(-1),counts[0]-1);assert.equal(f.calls.filter(x=>x==='analysis').length,1);f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('cleanCandidates accepts blockId-only evidence and repeated quotes within the same block',()=>{
 const blocks=markdownBlocks('Dynamic nominalism matters. Dynamic nominalism is central to making up people.')
 const cleaned=cleanCandidates([{terms:[
  {src:'Dynamic nominalism',dst:'动态唯名论',category:'concept',evidence:{blockId:blocks[0].id,quote:'Dynamic nominalism'}},
  {src:'making up people',dst:'造人',category:'concept',evidence:{blockId:blocks[0].id}}
 ]}],blocks)
 assert.equal(cleaned.terms.length,2);assert.equal(cleaned.dropped.length,0)
 assert(cleaned.terms.find(t=>t.src==='making up people').evidence[0].quote.includes('making up people'))
})

test('analyseBookGlossary heals blockId typos and tolerates foreign blockIds without failing',async()=>{
 const f=await setup({source:'Risk and uncertainty define this analysis unit.'})
 try{
  const command=f.manager.command
  f.manager.command=async(...args)=>{
   await command(...args)
   const cli=args[2]
   if(path.basename(cli[cli.indexOf('--input')+1])==='analysis.txt'){
    const output=cli[cli.indexOf('--output-dir')+1]
    const file=path.join(output,'analysis.txt')
    const raw=await fs.readFile(file,'utf8')
    const records=raw.trim().split('\n').map(JSON.parse)
    const unit=records[0]
    const termRisk=unit.terms.find(t=>t.src==='Risk')
    if(termRisk&&termRisk.evidence){
     termRisk.evidence.blockId=termRisk.evidence.blockId.slice(0,-1)
    }
    unit.terms.push({src:'AlienConcept',dst:'异域概念',category:'concept',evidence:{blockId:'totally-foreign-block',quote:'AlienConcept'}})
    await fs.writeFile(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n')
    f.requestLog.at(-1).pairs[0].dst=JSON.stringify(unit)
   }
  }
  const report=await analyseBookGlossary(f.manager,f.task)
  assert.equal(report.cleaningCompleted,true)
  const effective=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary.json')))
  assert(effective.some(t=>t.src==='Risk'))
  assert(!effective.some(t=>t.src==='AlienConcept'))
 }finally{await f.close()}
})

test('delta consolidation keeps unmentioned entries by default, resolves short IDs, and ignores dummy placeholders',async()=>{
 const f=await setup({source:'Dynamic nominalism and labeling theory are core concepts. New realities came into being.',terms:[
  {src:'Dynamic nominalism',dst:'动态唯名论',sense:'核心概念'},
  {src:'labeling theory',dst:'标签理论',sense:'社会学理论'},
  {src:'New realities came into being',dst:'新的现实产生了',sense:'叙述句'}
 ]});try{
  const command=f.manager.command
  f.manager.command=async(...args)=>{await command(...args);const cli=args[2];if(path.basename(cli[cli.indexOf('--input')+1])==='consolidation.txt'){
   const pair=f.requestLog.at(-1).pairs[0],unit=JSON.parse(pair.src)
   const dropEntry=unit.entries.find(e=>e.src.startsWith('New realities'))
   pair.dst=JSON.stringify({
    unitId:unit.unitId,
    checkedCount:unit.entries.length,
    groups:[
     {members:[{id:dropEntry.id,action:'drop',reason:'叙述分句，非术语'},{entryId:'t-dummyX',action:'drop',reason:'占位'}]}
    ]
   })
  }}
  const report=await analyseBookGlossary(f.manager,f.task)
  assert.equal(report.cleaningCompleted,true);assert.equal(report.dropped,1)
  const effective=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary.json')))
  assert(effective.some(t=>t.src==='Dynamic nominalism'&&t.dst==='动态唯名论'))
  assert(effective.some(t=>t.src==='labeling theory'&&t.dst==='标签理论'))
  assert(!effective.some(t=>t.src.startsWith('New realities')))
 }finally{await f.close()}
})

test('decodeGlossaryRecord repairs stray "}" inside string values without losing text',()=>{
 const raw1=`{"unitId":"clean-005","checkedCount":30,"groups":[{"canonicalSrc":"stark fact","canonicalDst":"硬事实","category":"concept","decision":"keep_local","uncertain":false,"members":[{"id":21,"action":"keep","dst":"硬事实","reason":"与'social fact/社会事实'对举，暂定"}"硬事实"}]}]}`
 const parsed1=decodeGlossaryRecord(raw1)
 assert.equal(parsed1.record.unitId,'clean-005')
 assert.equal(parsed1.record.groups[0].members[0].reason,`与'social fact/社会事实'对举，暂定"硬事实`)
 const raw2=`{"unitId":"clean-005","checkedCount":30,"groups":[{"canonicalSrc":"stark fact","canonicalDst":"硬事实","category":"concept","decision":"keep_local","uncertain":false,"members":[{"id":21,"action":"keep","dst":"硬事实","reason":"与'social fact/社会事实'对举，暂定"}"硬事实"}"}]}]}`
 const parsed2=decodeGlossaryRecord(raw2)
 assert.equal(parsed2.record.groups[0].members[0].reason,`与'social fact/社会事实'对举，暂定"硬事实"`)
})

test('decodeGlossaryRecord repairs doubled quotes and unescaped quotes inside string values without losing text',()=>{
 const raw=`{"unitId":"clean-006","checkedCount":10,"groups":[{"category":"concept","reason":"拉丁格言,意为""值多少便算多少"",指证明书效力有限","uncertain":false,"publicEligible":true}]}`
 const parsed=decodeGlossaryRecord(raw)
 assert.equal(parsed.record.unitId,'clean-006')
 assert.equal(parsed.record.groups[0].reason,'拉丁格言,意为"值多少便算多少",指证明书效力有限')
 assert.equal(parsed.repair.kind,'json-syntax-only-string-fields-preserved')
 const leadingAndFull=`{"unitId":"A0016","terms":[{"src":"homme « déréglé »","dst":""失序之人"","category":"concept"},{"src":"Le Chemin","dst":""道路"丛书","category":"title"},{"src":"Le Chemin 2","dst":"丛书"道路"","category":"title"}]}`
 const parsed2=decodeGlossaryRecord(leadingAndFull)
 assert.equal(parsed2.record.terms[0].dst,'"失序之人"')
 assert.equal(parsed2.record.terms[1].dst,'"道路"丛书')
 assert.equal(parsed2.record.terms[2].dst,'丛书"道路"')
})

test('packet-based review audit enforces 100% coverage, unique substring patches, footnote conservation, and applies surgical patches + glossary decisions',async()=>{
 const source='# I. Dynamic Nominalism\n\nRisk here means an imminent danger[^1], while Sauvages classified species.\n\nLiberty is discussed as political freedom.\n\n[^1]: See Janet (1889) on dynamic nominalism.\n'
 const target='# 一、动态唯名论\n\n这里的风险意味着迫在眉睫的祸患[^1]，而 Sauvages 对物种进行了分类。\n\n自由被作为政治自由加以讨论。\n\n[^1]: 参见雅内（1889）关于动态唯名论的论述。\n'
 const f=await setup({source,terms:[
  {src:'Risk',dst:'危险',sense:'指眼前危险'},
  {src:'Dasein',dst:'此在',sense:'哲学概念'},
  {src:'Liberty',dst:'自由',sense:'政治自由'}
 ]});try{
  await analyseBookGlossary(f.manager,f.task)
  const taskDir=f.manager.dir(f.task.id)
  const translatedPath=path.join(taskDir,'translation/translated.md')
  await fs.mkdir(path.dirname(translatedPath),{recursive:true})
  await fs.writeFile(translatedPath,target)
  f.task.translationPath=translatedPath
  f.task.translationReport={sourceFingerprint:hash(source),targetFingerprint:hash(target),glossaryFingerprint:f.task.glossaryReport.effectiveFingerprint}
  // Inject an unresolved issue for 'Sauvages' to verify packet hints & glossary_decisions resolution
  const issuesFile=path.join(taskDir,'glossary/review-issues.json')
  const issues=[{issueId:'issue-sauvages',type:'uncertain_term',src:'Sauvages',candidates:['Sauvages','索瓦热'],evidence:[{blockId:'b-0002',quote:'Sauvages classified species.'}],reason:'待结合正文中法国医学史语境核定译名'}]
  await fs.writeFile(issuesFile,JSON.stringify(issues,null,2))
  f.task.glossaryReport.issuesFingerprint=hash(await fs.readFile(issuesFile))
  f.task.glossaryReport.reviewIssues=1

  const prepared=await prepareReviewAudit(f.manager,f.task)
  assert.equal(prepared.totalPackets,1)
  assert.equal(prepared.totalLines,4)
  const packet=JSON.parse(await fs.readFile(path.join(prepared.auditDir,'packets/001.json'),'utf8'))
  assert.equal(packet.filter(r=>r.classify==='body').length,2)
  assert(packet.find(l=>l.line===3).terms.some(t=>t.src==='Risk'&&t.dst==='危险'))
  assert(packet.find(l=>l.line===3).hints.some(h=>h.type==='glossary_mismatch'&&h.src==='Risk'&&h.expectedDst==='危险'))
  assert(packet.find(l=>l.line===3).hints.some(h=>h.type==='unresolved_term'&&h.src==='Sauvages'))

  // 1) Guard checks for review stage packet subagents and results writing
  const subExec={name:'subagent',arguments:{prompt:`Review packet ${path.join(prepared.auditDir,'packets/001.json')}`},agent:{session:{header:{cwd:f.root,agentPreset:'reading-document'}}}}
  assert.equal(sessionGuard(f.root,subExec,{taskDirectory:taskDir,authorizedStage:'review'}),undefined)
  const badSubExec={...subExec,arguments:{prompt:'Review without packet path'}}
  assert.equal(sessionGuard(f.root,badSubExec,{taskDirectory:taskDir,authorizedStage:'review'}),undefined)
  const workerWrite={name:'write',arguments:{path:path.join(prepared.auditDir,'results/001.json')},agent:{session:{header:{cwd:f.root,agentPreset:'reading-document',origin:'subagent',delegationDepth:1}}}}
  assert.equal(sessionGuard(f.root,workerWrite,{taskDirectory:taskDir,authorizedStage:'review'}),undefined)

  // 2) Incomplete checked_lines or footnote marker deletion is rejected by assembleReviewAudit
  const resultFile=path.join(prepared.auditDir,'results/001.json')
  await fs.writeFile(resultFile,JSON.stringify({
   packet:'001',
   checked_lines:[1,3,5], // missing line 7
   body_count:2,
   patches:[{line:3,base:'translation',edits:[{old:'迫在眉睫的祸患[^1]',new:'迫在眉睫的祸患'}],reason:'误删脚注标记'}]
  }))
  const badValidation=await assembleReviewAudit(f.manager,f.task)
  assert.equal(badValidation.complete,false)
  assert(badValidation.errors.some(e=>e.error.includes('checked_lines')))

  // 2b) Footnote marker mismatch with full checked_lines is also rejected
  await fs.writeFile(resultFile,JSON.stringify({
   packet:'001',
   checked_lines:[1,3,5,7],
   body_count:2,
   patches:[{line:3,base:'translation',edits:[{old:'迫在眉睫的祸患[^1]',new:'迫在眉睫的祸患'}],reason:'误删脚注标记'}]
  }))
  const badFootnoteValidation=await assembleReviewAudit(f.manager,f.task)
  assert.equal(badFootnoteValidation.complete,false)
  assert(badFootnoteValidation.errors.some(e=>e.error.includes('脚注标记多重集')))

  // 3) Valid surgical patch + glossary_decisions passes assembleReviewAudit and updates translation + glossary via registerJointReview
  await fs.writeFile(resultFile,JSON.stringify({
   packet:'001',
   checked_lines:[1,3,5,7],
   body_count:2,
   patches:[
    {
     line:3,
     base:'translation',
     edits:[
      {old:'这里的风险',new:'这里的危险'},
      {old:'Sauvages',new:'索瓦热（Sauvages）'}
     ],
     reason:'统一本书特定概念 Risk->危险，并补全法国医学家索瓦热译名'
    }
   ],
   glossary_decisions:[
    {issueId:'issue-sauvages',src:'Sauvages',dst:'索瓦热',decision:'book_override',category:'person',reason:'18世纪法国植物学家与医学分类学家 François Boissier de Sauvages'}
   ]
  }))
  const goodValidation=await assembleReviewAudit(f.manager,f.task)
  assert.equal(goodValidation.complete,true)
  assert.equal(goodValidation.errors.length,0)
  assert.equal(goodValidation.patchCount,1)

  const report=await reviewFile(f,'pass','All 4 lines and 1 review issue audited and patched.')
  await registerJointReview(f.manager,f.task,report)
  assert.equal(f.task.review.semanticVerified,true)
  assert.equal(f.task.review.audit.applied,true)
  assert.equal(f.task.review.audit.patchCount,1)
  assert.equal(f.task.review.audit.glossaryDecisionCount,1)

  const updatedTarget=await fs.readFile(translatedPath,'utf8')
  assert(updatedTarget.includes('这里的危险意味着迫在眉睫的祸患[^1]，而 索瓦热（Sauvages） 对物种进行了分类。'))
  assert.equal(f.task.translationReport.targetFingerprint,hash(updatedTarget))
  assert.equal(f.task.review.targetFingerprint,hash(updatedTarget))

  const updatedGlossary=JSON.parse(await fs.readFile(path.join(taskDir,'glossary.json'),'utf8'))
  assert.equal(updatedGlossary.find(e=>e.src==='Sauvages')?.dst,'索瓦热')
  const updatedIssues=JSON.parse(await fs.readFile(issuesFile,'utf8'))
  assert.equal(updatedIssues.length,0)
 }finally{await f.close()}
})

test('Option A: perform(review) invokes agy-bridge review audit, validates packets, applies surgical patches and registers joint review',async()=>{
 const source='# Chapter 1\n\nDynamic nominalism explains how classifications interact with the people classified.\n'
 const f=await setup({source,terms:[{src:'Dynamic nominalism',dst:'动态唯名论',sense:'哈金核心概念'}]});try{
  await analyseBookGlossary(f.manager,f.task)
  f.task.stages.glossary={state:'done'}
  const taskDir=f.manager.dir(f.task.id)
  const translatedPath=path.join(taskDir,'translation/translated.md')
  await fs.mkdir(path.dirname(translatedPath),{recursive:true})
  const translatedText='# 第一章\n\n动态唯名论解释了分类如何与被分类的人发生互动。\n'
  await fs.writeFile(translatedPath,translatedText)
  f.task.translationPath=translatedPath
  f.task.translationReport={
   status:'complete',
   sourceFingerprint:hash(source),
   targetFingerprint:hash(translatedText),
   glossaryFingerprint:f.task.glossaryReport.effectiveFingerprint
  }
  f.task.stages.translationCheck={state:'done'}

  let runnerCalledWith=null
  f.manager.agyRunner=async({taskDir:td,prompt,prepared})=>{
   runnerCalledWith={td,prompt,prepared}
   const packet=prepared.manifest[0]
   assert.equal(packet.id,'001')
   await fs.writeFile(path.join(prepared.auditDir,'results/001.json'),JSON.stringify({
    packet:'001',
    checked_lines:[1,3],
    body_count:1,
    patches:[
     {
      line:3,
      base:'translation',
      edits:[{old:'发生互动',new:'产生双向互动（looping effect）'}],
      reason:'补充哈金动态唯名论语境下的互动准确表述'
     }
    ],
    glossary_decisions:[]
   },null,2))
   return {
    code:0,
    stdout:JSON.stringify({
     session_id:'agy-test-session-001',
     response:'Joint review completed with 1 surgical patch.',
     stats:{models:{'fixture/review':{tokens:{input:1200,output:350}}}}
    }),
    stderr:''
   }
  }

  f.task.reviewConfig={};f.task.phaseApproval={phase:'delivery',reviewConfig:{}};await f.manager.perform(f.task,'review',{})
  assert(runnerCalledWith,'agyRunner should be called automatically when review/report.md does not exist')
  assert(runnerCalledWith.prompt.includes('book-translation-review/SKILL.md'))
  assert(runnerCalledWith.prompt.includes('每包由 DSH 模型服务执行一次'))
  const multiPrompt=buildAgyReviewPrompt(f.manager,f.task,{...runnerCalledWith.prepared,totalPackets:6,pendingPackets:['001','002','003','004','005','006']})
  assert(multiPrompt.includes('每包由 DSH 模型服务执行一次'))
  assert.equal(f.task.review.semanticVerified,true)
  assert.equal(f.task.review.audit.applied,true)
  assert.equal(f.task.review.audit.patchCount,1)

  const receipt=JSON.parse(await fs.readFile(path.join(runnerCalledWith.prepared.auditDir,'agy-receipt.json'),'utf8'))
  assert.equal(receipt.sessionId,'agy-test-session-001')
  assert.equal(receipt.completedPackets,1)
  assert.equal(receipt.patchCount,1)

  const updatedTarget=await fs.readFile(translatedPath,'utf8')
  assert(updatedTarget.includes('动态唯名论解释了分类如何与被分类的人产生双向互动（looping effect）。'))
  assert.equal(f.task.translationReport.targetFingerprint,hash(updatedTarget))
 }finally{await f.close()}
})

test('review worker model selection: updateReviewConfig configures worker model, orchestrator model and effort', async () => {
 const source = '# Chapter 1\n\nDynamic nominalism.\n'
 const f = await setup({ source, terms: [{ src: 'Dynamic nominalism', dst: '动态唯名论', sense: '概念' }] })
 try {
  await f.manager.updateReviewConfig(f.task.id, {
   orchestratorModel: 'fixture/review-large',
   orchestratorEffort: 'high',
   workerModel: 'fixture/worker-large'
  })
  assert.equal(f.task.reviewConfig.orchestratorModel, 'fixture/review-large')
  assert.equal(f.task.reviewConfig.orchestratorEffort, 'high')
  assert.equal(f.task.reviewConfig.workerModel, 'fixture/worker-large')

  const prompt = buildAgyReviewPrompt(f.manager, f.task, { auditDir: '/tmp/audit', totalPackets: 5 })
  assert(prompt.includes('Worker 为 fixture/worker-large'), 'Prompt should reflect chosen worker model tier "pro"')

  // Test flash selection as well
  await f.manager.updateReviewConfig(f.task.id, { orchestratorModel:'fixture/review-large', workerModel: 'fixture/worker-fast' })
  const flashPrompt = buildAgyReviewPrompt(f.manager, f.task, { auditDir: '/tmp/audit', totalPackets: 5 })
  assert(flashPrompt.includes('Worker 为 fixture/worker-fast'), 'Prompt should reflect chosen worker model tier "flash"')
 } finally {
  await f.close()
 }
})

test('new glossary transport has short identifiers, restores provenance, and ignores unrelated provider failures',async()=>{
 const {glossaryTransportUnits}=await import('../modules/pipeline/glossary.js')
 const {glossaryFailureForUnits}=await import('../modules/pipeline/glossary-transport.js')
 const {units,blocks}=analysisUnits('Alpha has a specific technical meaning.')
 const wire=glossaryTransportUnits('analysis',units)
 assert(!/[a-f0-9]{24}/.test(JSON.stringify(wire.units)))
 const restored=wire.restore({unitId:'A0001',terms:[{src:'Alpha',dst:'阿尔法',evidence:{blockId:'B0001',quote:'Alpha'}}]})
 assert.equal(restored.unitId,units[0].unitId);assert.equal(restored.terms[0].evidence.blockId,blocks[0].id)
 const event={level:'error',source:'engine-worker',content:{kind:'translation_result',summary:['Provider finish_reason: content_filter'],pairs:[{src:JSON.stringify({...wire.units[0],passages:[]})}]}}
 assert.equal(glossaryFailureForUnits(event,wire.units),null)
 event.content.pairs[0].src=JSON.stringify(wire.units[0]);assert.equal(glossaryFailureForUnits(event,wire.units).reason,'content_filter')
 const generic={level:'warning',source:'engine',window:false,content:'请求失败：Provider finish_reason: content_filter … (Key 1)',error:{context:{model_id:'fixture'}}}
 assert.equal(glossaryFailureForUnits(generic,wire.units),null)
 assert.equal(glossaryFailureForUnits(generic,wire.units,{exclusiveCli:true,model:'fixture'}).reason,'content_filter')
 assert.equal(glossaryFailureForUnits(generic,wire.units,{exclusiveCli:true,model:'other'}),null)
 assert.equal(glossaryFailureForUnits({...generic,window:true},wire.units,{exclusiveCli:true,model:'fixture'}),null)
 assert.equal(glossaryFailureForUnits({...generic,error:{message:'模型请求超时。'},content:'请求失败：模型请求超时。 … (Key 1)'},wire.units,{exclusiveCli:true,model:'fixture'}).reason,'timeout')
})

async function prepareReviewFixture(f,target){
 const file=path.join(f.manager.dir(f.task.id),'translation/translated.md')
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,target)
 f.task.translationPath=file;f.task.translationReport={passed:true,sourceFingerprint:hash(f.source),targetFingerprint:hash(target)}
 return file
}
async function passPacket(prepared,id){await fs.writeFile(path.join(prepared.auditDir,'results',id+'.json'),JSON.stringify({packet:id,status:'pass',patches:[],unresolved:[]}))}

test('Antigravity handoff after quota failure keeps passed packets and resumes missing, broken and unresolved packets',async()=>{
 const source=Array.from({length:46},(_,i)=>`Ordinary paragraph ${i}.`).join('\n\n')+'\n'
 const f=await setup({source});try{
  await prepareReviewFixture(f,Array.from({length:46},(_,i)=>`第${i}段译文。`).join('\n\n')+'\n')
  const prepared=await prepareReviewAudit(f.manager,f.task,{maxBody:15})
  assert.equal(prepared.totalPackets,4)
  await assert.rejects(runAgyReviewAudit(f.manager,f.task,{agyRunner:async({prepared})=>{
   await passPacket(prepared,'001')
   await fs.writeFile(path.join(prepared.auditDir,'results/002.json'),'{"packet":')
   await fs.writeFile(path.join(prepared.auditDir,'results/003.json'),JSON.stringify({packet:'003',status:'needs-work',patches:[],unresolved:['term uncertain']}))
   throw new Error('model quota exhausted')
  }}),/quota exhausted/)
  assert.equal(f.task.reviewProgress.status,'blocked');assert.match(f.task.reviewProgress.error,/quota exhausted/)
  assert.ok(f.task.reviewProgress.finishedAt)
  const passedFile=path.join(prepared.auditDir,'results/001.json'),before=await fs.readFile(passedFile),stamp=(await fs.stat(passedFile)).mtimeMs
  f.task.stages.translationCheck={state:'done'};f.task.worker={provider:'fixture',model:'vision'}
  await f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig:{orchestratorModel:'fixture/review-small',workerModel:'inherit',orchestratorEffort:'high'},publishAccepted:true})
  await fs.writeFile(path.join(f.manager.dir(f.task.id),'review/report.md'),'Incomplete old report')
  let calls=0
  f.manager.agyRunner=async({prepared:next,options,prompt})=>{
   calls++;assert.equal(next.auditDir,prepared.auditDir);assert.deepEqual(next.pendingPackets,['002','003','004'])
   assert.equal(options.model,'fixture/review-small');assert.match(prompt,/仅处理待审包：002、003、004/)
   for(const id of next.pendingPackets)await passPacket(next,id)
   return {session_id:'handoff-fixture'}
  }
  await f.manager.perform(f.task,'review',{runAgy:true})
  assert.equal(f.task.review.audit.applied,true);assert.equal(calls,1)
  assert.deepEqual(await fs.readFile(passedFile),before);assert.equal((await fs.stat(passedFile)).mtimeMs,stamp)
  await f.manager.perform(f.task,'review',{runAgy:true});assert.equal(calls,1,'completed packets must not invoke agy again')
 }finally{await f.close()}
})

test('stopping agy waits for the local process to exit before releasing the task',async()=>{
 const f=await setup({source:'Ordinary paragraph.\n'});try{
  await prepareReviewFixture(f,'普通段落。\n');f.task.worker={provider:'fixture',model:'vision'};f.task.stages.translationCheck={state:'done'}
  await f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig:{orchestratorModel:'fixture/review',workerModel:'inherit',orchestratorEffort:'high'},publishAccepted:true})
  const command=path.join(f.root,'fake-agy'),ready=path.join(f.root,'ready'),closed=path.join(f.root,'closed')
  await fs.writeFile(command,`#!/bin/sh\ntrap 'sleep 0.15; touch "${closed}"; exit 0' TERM\ntouch "${ready}"\nwhile :; do sleep 1; done\n`,{mode:0o700});f.manager.agyCommand=command
  await f.manager.start(f.task.id,'review',{runAgy:true,singleStep:true})
  for(let n=0;!await fs.stat(ready).catch(()=>null);n++){assert.ok(n<800,'fixture process must start');await new Promise(r=>setTimeout(r,10))}
  assert.equal(f.manager.active.get(f.task.id).children.size,1)
  await assert.rejects(f.manager.confirmPhase(f.task.id,{phase:'delivery'}),/运行中/)
  await f.manager.stop(f.task.id)
  assert.ok(await fs.stat(closed));assert.equal(f.manager.active.has(f.task.id),false);assert.equal(f.task.state,'paused');assert.equal(f.task.reviewProgress.status,'paused')
 }finally{await f.manager.stop(f.task.id);await f.close()}
})

test('local agy transport passes the selected model and receives completed packet output',async()=>{
 const f=await setup({source:'Ordinary paragraph.\n'});try{
  await prepareReviewFixture(f,'普通段落。\n')
  const prepared=await prepareReviewAudit(f.manager,f.task),command=path.join(f.root,'fake-success.mjs'),argsFile=path.join(f.root,'received-args.json')
  await fs.writeFile(command,`#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync(${JSON.stringify(path.join(prepared.auditDir,'results/001.json'))},${JSON.stringify(JSON.stringify({packet:'001',status:'pass',patches:[],unresolved:[]}))});\nconsole.log(JSON.stringify({status:'SUCCESS',session_id:'local-transport-fixture'}));\n`,{mode:0o700})
  const result=await runAgyReviewAudit(f.manager,f.task,{agyCommand:command,model:'fixture/review-small',effort:'high',cliTimeoutMs:5000})
  assert.equal(result.validation.complete,true);assert.equal(result.receipt.sessionId,'local-transport-fixture')
  const args=JSON.parse(await fs.readFile(argsFile,'utf8'));assert.equal(args[args.indexOf('--model')+1],'fixture/review-small');assert.equal(args[args.indexOf('--effort')+1],'high')
  assert.ok(args[args.indexOf('--log-file')+1].startsWith(prepared.auditDir+path.sep));assert.equal(f.task.reviewProgress.passedPackets,1)
 }finally{await f.close()}
})

test('block review tolerates wrapping, needs no model counts or hashes, and rejects stale application',async()=>{
 const f=await setup({source:'Alpha begins a paragraph\nand ends the same paragraph.\n'});try{
  await prepareReviewFixture(f,'阿尔法开始并结束这一段。\n')
  const prepared=await prepareReviewAudit(f.manager,f.task)
  const rows=JSON.parse(await fs.readFile(path.join(prepared.auditDir,'packets/001.json')))
  assert.equal(rows.length,1);assert.equal(rows[0].blockId,'B0001')
  await passPacket(prepared,'001');assert.equal((await assembleReviewAudit(f.manager,f.task)).complete,true)
  await fs.writeFile(f.task.translationPath,'已经变更的译文。\n')
  await assert.rejects(applyReviewAudit(f.manager,f.task),/旧结果不能用于当前版本/)
  const next=await prepareReviewAudit(f.manager,f.task)
  assert.notEqual(next.auditDir,prepared.auditDir);assert.deepEqual(next.pendingPackets,['001'])
  assert.equal((await assembleReviewAudit(f.manager,f.task)).complete,false)
 }finally{await f.close()}
})

test('review invalidates only affected packets and never reinvokes a complete packet set',async()=>{
 const source=Array.from({length:31},(_,i)=>`${i===0?'Alpha':'Ordinary'} paragraph ${i}.`).join('\n\n')+'\n'
 const f=await setup({source});try{
  await prepareReviewFixture(f,Array.from({length:31},(_,i)=>`第${i}段译文。`).join('\n\n')+'\n')
  await fs.writeFile(path.join(f.manager.dir(f.task.id),'glossary.json'),JSON.stringify([{src:'Alpha',dst:'甲'}]))
  const prepared=await prepareReviewAudit(f.manager,f.task,{maxBody:15})
  assert.equal(prepared.totalPackets,3)
  for(const p of prepared.manifest)await passPacket(prepared,p.id)
  await fs.writeFile(path.join(f.manager.dir(f.task.id),'glossary.json'),JSON.stringify([{src:'Alpha',dst:'阿尔法'}]))
  const next=await prepareReviewAudit(f.manager,f.task,{maxBody:15})
  assert.notEqual(next.auditDir,prepared.auditDir);assert.deepEqual(next.pendingPackets,['001'])
  let calls=0
  const runner=async({prepared})=>{calls++;assert.deepEqual(prepared.pendingPackets,['001']);await passPacket(prepared,'001');return {session_id:'fixture'}}
  await runAgyReviewAudit(f.manager,f.task,{maxBody:15,agyRunner:runner})
  await runAgyReviewAudit(f.manager,f.task,{maxBody:15,agyRunner:runner})
  assert.equal(calls,1)
 }finally{await f.close()}
})

test('applied review is reusable, needs-work cannot be applied, and run snapshots are protected',async()=>{
 const f=await setup({source:'A paragraph.\n'});try{
  await prepareReviewFixture(f,'一个段落。\n')
  const prepared=await prepareReviewAudit(f.manager,f.task),file=path.join(prepared.auditDir,'results/001.json')
  await fs.writeFile(file,JSON.stringify({packet:'001',status:'needs-work',patches:[]}))
  await assert.rejects(applyReviewAudit(f.manager,f.task),/不能合并/)
  await fs.writeFile(file,JSON.stringify({packet:'001',status:'pass',patches:[{blockId:'B0001',edits:[{old:'一个',new:'这一'}],reason:'fixture correction'}]}))
  await applyReviewAudit(f.manager,f.task)
  const next=await prepareReviewAudit(f.manager,f.task);assert.equal(next.auditDir,prepared.auditDir);assert.deepEqual(next.pendingPackets,[])
  const exec={name:'write',arguments:{path:path.join(prepared.auditDir,'snapshots.json')},agent:{session:{header:{cwd:f.root,agentPreset:'reading-document'}}}}
  assert.match(sessionGuard(f.root,exec,{taskDirectory:f.manager.dir(f.task.id)}),/程序维护/)
  exec.arguments.path=file;assert.equal(sessionGuard(f.root,exec,{taskDirectory:f.manager.dir(f.task.id)}),undefined)
 }finally{await f.close()}
})

test('agy remains alive beyond old total limits while child model activity continues',async()=>{
 const f=await setup({source:'Ordinary paragraph.\n'});try{
  await prepareReviewFixture(f,'普通段落。\n');const prepared=await prepareReviewAudit(f.manager,f.task),command=path.join(f.root,'active-agy.mjs'),home=path.join(f.root,'cli'),parent='11111111-1111-1111-1111-111111111111',child='22222222-2222-2222-2222-222222222222'
  const code=`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),home=${JSON.stringify(home)},parent=${JSON.stringify(parent)},child=${JSON.stringify(child)},file=id=>path.join(home,'brain',id,'.system_generated/logs/transcript.jsonl');
if(args[args.indexOf('--print-timeout')+1]!=='0')process.exit(8);
for(const id of [parent,child])fs.mkdirSync(path.dirname(file(id)),{recursive:true});
fs.writeFileSync(args[args.indexOf('--log-file')+1],'Print mode: conversation='+parent+', sending message\\n');
fs.writeFileSync(file(parent),JSON.stringify({source:'MODEL',type:'GENERIC',status:'DONE',step_index:0,created_at:new Date().toISOString(),content:'Created the following subagents:\\n'+JSON.stringify({conversationId:child})})+'\\n');
let n=0;const timer=setInterval(()=>{fs.appendFileSync(file(child),JSON.stringify({source:'MODEL',type:'PLANNER_RESPONSE',step_index:++n,created_at:new Date().toISOString(),output_tokens:n})+'\\n');if(n===40){clearInterval(timer);fs.writeFileSync(${JSON.stringify(path.join(prepared.auditDir,'results/001.json'))},JSON.stringify({packet:'001',status:'pass',patches:[],unresolved:[]}));console.log(JSON.stringify({status:'SUCCESS',conversation_id:parent}));}},40);
`
  await fs.writeFile(command,code,{mode:0o700})
  const result=await runAgyReviewAudit(f.manager,f.task,{agyCommand:command,agyCliHome:home,idleTimeoutMs:1000,pollIntervalMs:20,cliTimeoutMs:1,printTimeout:'1ms'}).catch(async e=>{console.error('DEBUG',f.task.reviewProgress,await fs.readFile(f.task.reviewProgress.logFile,'utf8').catch(()=>'(no log)'),await fs.readFile(path.join(home,'brain',parent,'.system_generated/logs/transcript.jsonl'),'utf8').catch(()=>'(no transcript)'));throw e})
  assert.equal(result.validation.complete,true);assert.equal(f.task.reviewProgress.status,'done');assert.equal(f.task.reviewProgress.pid>0,true);assert.equal(f.task.reviewProgress.conversationId,parent);assert.deepEqual(f.task.reviewProgress.childConversations,[child])
 }finally{await f.close()}
})

test('agy with repeated errors but no effective interaction pauses and retains results',async()=>{
 const f=await setup({source:'Ordinary paragraph.\n'});try{
  await prepareReviewFixture(f,'普通段落。\n');f.task.worker={provider:'fixture',model:'vision'};f.task.stages.translationCheck={state:'done'}
  await f.manager.confirmPhase(f.task.id,{phase:'delivery',reviewConfig:{orchestratorModel:'fixture/review',workerModel:'inherit'},publishAccepted:true})
  const command=path.join(f.root,'idle-agy.mjs'),home=path.join(f.root,'cli'),cid='11111111-1111-1111-1111-111111111111'
  await fs.writeFile(command,`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2),file=path.join(${JSON.stringify(home)},'brain',${JSON.stringify(cid)},'.system_generated/logs/transcript.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(args[args.indexOf('--log-file')+1],'Print mode: conversation=${cid}, sending message\\n');let n=0;setInterval(()=>fs.appendFileSync(file,JSON.stringify({source:'SYSTEM',type:'ERROR_MESSAGE',step_index:++n,created_at:new Date().toISOString(),error:'retrying'})+'\\n'),20);setTimeout(()=>process.exit(9),1500);
`,{mode:0o700})
  f.manager.agyCommand=command
  await f.manager.start(f.task.id,'review',{runAgy:true,singleStep:true,agyCliHome:home,idleTimeoutMs:200,pollIntervalMs:20})
  await f.manager.active.get(f.task.id)?.promise
  assert.equal(f.task.state,'paused');assert.equal(f.task.reviewProgress.stopReason,'idle-timeout');assert.equal(f.task.reviewProgress.status,'paused');assert.match(f.task.message,/没有有效模型交互/);assert.ok(await fs.stat(path.join(f.task.reviewAudit.auditDir,'snapshots.json')))
 }finally{await f.manager.stop(f.task.id);await f.close()}
})

test('CLI stopped by the watchdog mid-batch is resumable, not GLOSSARY_RESULT_INVALID',async()=>{
 const f=await setup({source:'Ordinary prose. '.repeat(600),terms:[]});try{
  const command=f.manager.command,requests=[];let stall=true
  f.manager.command=async(t,c,args,io)=>{
   const input=args[args.indexOf('--input')+1],units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse);requests.push(units.map(u=>u.unitId))
   if(!stall)return command(t,c,args,io)
   stall=false;assert(units.length>1)
   await command(t,c,args,{onLine:async()=>{}})
   for(const p of f.requestLog.at(-1).pairs.slice(1))p.dst=''
   await io.onLine(JSON.stringify({type:'progress',status:'running',stats:{total:units.length,completed:1,failed:0,pending:units.length-1,skipped:0,percent:100/units.length}}))
   // Session 4ba0487e: the watchdog SIGTERMs the CLI, which exits 0 without a finished event.
   const error=new Error('LinguaGacha 未通过，退出码 0；术语分析连续 20 分钟没有新增完成单元，已停止；恢复时复用已完成单元；已有产物保留');error.timedOut=true;error.exitCode=0;throw error
  }
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/没有新增完成单元/)
  const job=f.task.glossaryRuns.analysis,receipt=JSON.parse(await fs.readFile(job.receiptFile))
  assert.equal(receipt.errorCode,'GLOSSARY_BATCH_INCOMPLETE');assert.equal(receipt.cliTimedOut,true)
  assert.equal(receipt.partialUnitsCaptured,1);assert.equal(receipt.resumeAvailable,true);assert.equal(receipt.providerRetryCount,0)
  await analyseBookGlossary(f.manager,f.task,{retryErrors:true})
  assert.deepEqual(requests[1],requests[0].slice(1))
  f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('CLI done with failed items retains verified responses and retries only missing units',async()=>{
 const f=await setup({source:'Ordinary prose. '.repeat(600),terms:[]});try{
  const command=f.manager.command,requests=[];let fail=true
  f.manager.command=async(t,c,args,io)=>{
   const input=args[args.indexOf('--input')+1],units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse);requests.push(units.map(u=>u.unitId))
   if(!fail)return command(t,c,args,io)
   fail=false;assert(units.length>1)
   await command(t,c,args,{onLine:async()=>{}})
   for(const p of f.requestLog.at(-1).pairs.slice(1))p.dst=''
   await io.onLine(JSON.stringify({type:'progress',stats:{total:units.length,completed:1,failed:units.length-1,pending:0,skipped:0,percent:100/units.length}}))
   await io.onLine(JSON.stringify({type:'finished',status:'done'}))
  }
  await assert.rejects(analyseBookGlossary(f.manager,f.task),/术语批次未全部完成/)
  const job=f.task.glossaryRuns.analysis,receipt=JSON.parse(await fs.readFile(job.receiptFile))
  assert.equal(receipt.transportVerified,true);assert.equal(receipt.errorCode,'GLOSSARY_BATCH_INCOMPLETE');assert.equal(f.task.glossaryProgress.stats.pending,0)
  assert.equal((await fs.readFile(receipt.partialOutputFile,'utf8')).trim().split('\n').length,1)
  // The export contains apparently valid results for failed items. It must not
  // be used to recover them; only native responses authorize reuse.
  await analyseBookGlossary(f.manager,f.task,{retryErrors:true})
  assert.deepEqual(requests[1],requests[0].slice(1));assert.equal(f.calls.filter(x=>x==='analysis').length,2)
  f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('agy review automatically retries on transient exit codes and preserves existing conversation id',async()=>{
 const f=await setup({source:'Ordinary paragraph.\n'});try{
  await prepareReviewFixture(f,'普通段落。\n')
  const prepared=await prepareReviewAudit(f.manager,f.task),command=path.join(f.root,'retry-agy.mjs'),historyFile=path.join(f.root,'invocations.json')
  await fs.writeFile(historyFile,'[]')
  const cid='33333333-3333-3333-3333-333333333333'
  // Fake CLI: attempt 1 fails with code 3 (e.g. 400 location error), attempt 2 succeeds with code 0.
  const code=`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),historyFile=${JSON.stringify(historyFile)};
const invocations=JSON.parse(fs.readFileSync(historyFile,'utf8'));
invocations.push(args);
fs.writeFileSync(historyFile,JSON.stringify(invocations));
const convIndex=args.indexOf('--conversation');
const conversationId=convIndex!==-1?args[convIndex+1]:${JSON.stringify(cid)};
fs.writeFileSync(args[args.indexOf('--log-file')+1],'Print mode: conversation='+conversationId+', sending message\\n');
if(invocations.length===1){
 process.stderr.write('error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.\\n');
 process.exit(3);
}
fs.writeFileSync(${JSON.stringify(path.join(prepared.auditDir,'results/001.json'))},JSON.stringify({packet:'001',status:'pass',patches:[],unresolved:[]}));
console.log(JSON.stringify({status:'SUCCESS',conversation_id:conversationId}));
`
  await fs.writeFile(command,code,{mode:0o700})
  const result=await runAgyReviewAudit(f.manager,f.task,{
   agyCommand:command,
   model:'fixture/review-small',
   effort:'high',
   maxAttempts:3,
   retryDelayMs:50,
   pollIntervalMs:20
  })
  assert.equal(result.validation.complete,true)
  assert.equal(f.task.reviewProgress.conversationId,cid)
  const invocations=JSON.parse(await fs.readFile(historyFile,'utf8'))
  assert.equal(invocations.length,2)
  // Second invocation should have used --conversation
  assert.equal(invocations[1].includes('--conversation'),true)
  assert.equal(invocations[1][invocations[1].indexOf('--conversation')+1],cid)
 }finally{await f.close()}
})

test('legacy input audit is preserved while failed response inputs receive a separate complete audit',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'glossary-proof-upgrade-'));try{
  const units=[{unitId:'G0001',entries:[]},{unitId:'G0002',entries:[]}],startedAt='2026-10-22T12:00:00Z',endedAt='2026-10-22T12:01:00Z'
  const file=path.join(directory,'legacy.transport-proof.json'),bytes=JSON.stringify({schemaVersion:1,expectedUnits:units,observations:[{unitId:'G0001',source:JSON.stringify(units[0]),endedAt}]})
  await fs.writeFile(file,bytes)
  const receipt={startedAt,endedAt,directory,transportFile:file,transportSha256:hash(bytes),transportVerified:false}
  const result=await verifyModelInputs(directory,receipt,units,async()=>[{started_at:startedAt,ended_at:endedAt,pairs:units.map((u,i)=>({src:JSON.stringify(u),dst:i?'':'valid'}))}])
  assert.equal(result.valid.size,2);assert.equal(result.proof.schemaVersion,2);assert.notEqual(result.file,file);assert.equal(await fs.readFile(file,'utf8'),bytes)
  const migratedBytes=await fs.readFile(result.file)
  const retryReceipt={startedAt,endedAt,directory,transportFile:file,transportSha256:hash(bytes),transportVerified:false}
  await verifyModelInputs(directory,retryReceipt,units,async()=>[{ended_at:endedAt,pairs:units.map(u=>({src:JSON.stringify(u),dst:''}))}])
  assert.deepEqual(await fs.readFile(result.file),migratedBytes)
  const changed={...units[1],entries:['altered']},receipt2={startedAt,endedAt,directory}
  const rejected=await verifyModelInputs(directory,receipt2,units,async()=>[{ended_at:endedAt,pairs:[{src:JSON.stringify(changed),dst:''}]}])
  assert.equal(rejected.valid.size,0)
 }finally{await fs.rm(directory,{recursive:true,force:true})}
})

test('quota rate-limit detection requires RATE_LIMIT + quota wording, resets on progress, aborts without consuming providerRetryCount, and resumes',async()=>{
 const nov1Event={
  source:'engine',
  level:'warning',
  created_at:'2026-11-01T14:43:39Z',
  content:'请求失败：502: {"code":"RATE_LIMIT","message":"429 {\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"You\'ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.\\"}}"} … (Key 1)'
 }
 const detected=glossaryProviderFailure(nov1Event)
 assert.equal(detected.reason,'quota')
 assert.equal(detected.resetHint,'Your quota will reset when the current 5-hour window ends')
 assert.equal(glossaryProviderFailure({...nov1Event,content:'请求失败：HTTP 429 Too Many Requests'}),null)
 assert.equal(glossaryProviderFailure({...nov1Event,content:'请求失败：502: {"code":"RATE_LIMIT","message":"transient gateway throttle"}'}),null)

 const f=await setup({source:'Ordinary prose. '.repeat(600),terms:[]});try{
  const baseCommand=f.manager.command;let emitFailure,attempt=0
  f.manager.watchGlossaryProviderFailure=async cb=>{emitFailure=cb;return ()=>{}}
  f.manager.command=async(t,cmd,args,io)=>{
   const input=args[args.indexOf('--input')+1],kind=path.basename(input,'.txt')
   if(kind!=='analysis')return baseCommand(t,cmd,args,io)
   attempt++
   const units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse)
   if(attempt===1){
    await baseCommand(t,cmd,args,{onLine:async()=>{}})
    f.requestLog.at(-1).pairs=f.requestLog.at(-1).pairs.slice(0,1)
    await io.onLine(JSON.stringify({type:'progress',stats:{total:units.length,completed:1,failed:0,pending:units.length-1,skipped:0}}))
    emitFailure(detected)
    await new Promise(r=>setTimeout(r,95))
    throw new Error('CLI stopped on quota abort')
   }
   if(attempt<=4){
    emitFailure(detected)
    await new Promise(r=>setTimeout(r,95))
    throw new Error('CLI stopped on repeated quota abort')
   }
   // Attempt 5: single 429 followed by progress does NOT abort.
   emitFailure(detected)
   await new Promise(r=>setTimeout(r,15))
   await io.onLine(JSON.stringify({type:'progress',stats:{total:units.length,completed:1,failed:0,pending:units.length-1,skipped:0}}))
   await io.onLine(JSON.stringify({type:'progress',stats:{total:units.length,completed:units.length,failed:0,pending:0,skipped:0}}))
   return baseCommand(t,cmd,args,io)
  }
  for(let i=0;i<4;i++){
   await assert.rejects(
    analyseBookGlossary(f.manager,f.task,{retryErrors:i>0,quotaWindowMs:55}),
    err=>err.code==='GLOSSARY_PROVIDER_QUOTA'&&/模型 fake 额度已用尽（Your quota will reset when the current 5-hour window ends）。已完成 1\/\d+ 个单元并已保存。/.test(err.message)
   )
   const receipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile,'utf8'))
   assert.equal(receipt.status,'quota-exhausted')
   assert.equal(receipt.errorCode,'GLOSSARY_PROVIDER_QUOTA')
   assert.equal(receipt.providerRetryCount,0,'quota failure must never increment providerRetryCount')
   assert.equal(receipt.resumeAvailable,true)
   if(i>0)assert.equal(receipt.reusedUnits,1)
  }
  const finalReceipt=await analyseBookGlossary(f.manager,f.task,{retryErrors:true,quotaWindowMs:120})
  assert.equal(finalReceipt.status,'complete')
  const analysisReceipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile,'utf8'))
  assert.equal(analysisReceipt.providerRetryCount,0)
  assert.equal(analysisReceipt.reusedUnits,1)
  f.task.stages.glossary={state:'done'};await requireBookGlossary(f.manager,f.task)
 }finally{await f.close()}
})

test('cleanCandidates derives bounded quotes from blockId and normalizes CJK punctuation in dst only',()=>{
 const prefix='Introductory clause. '.repeat(6),suffix=' Concluding remark.'.repeat(10)
 const blocks=markdownBlocks(`${prefix}Dynamic nominalism reshapes classification.${suffix}`)
 const cleaned=cleanCandidates([{terms:[
  {src:'Dynamic nominalism',dst:'动态唯名论: 分类与互动(导论)...',category:'concept',sense:'概念',evidence:{blockId:blocks[0].id}},
  {src:'classification',dst:'《分类学》?',category:'title',sense:'书名',evidence:{blockId:blocks[0].id,quote:'paraphrased quote that does not match verbatim'}},
  {src:'Dynamic nominalism',dst:'Dynamic nominalism (Hacking)...',category:'title',sense:'原名保留',evidence:{blockId:blocks[0].id}},
  {src:'nonexistent term',dst:'不存在',category:'concept',sense:'伪造',evidence:{blockId:blocks[0].id}}
 ]}],blocks)
 assert.equal(cleaned.terms.length,3)
 assert.equal(cleaned.dropped.length,1)
 assert.equal(cleaned.dropped[0].reason,'unsupported-source-evidence')
 const cjkTerm=cleaned.terms.find(t=>t.dst.startsWith('动态唯名论'))
 assert.equal(cjkTerm.dst,'动态唯名论：分类与互动（导论）……')
 assert.equal(cjkTerm.evidence[0].normalization,'derived-from-block')
 assert(cjkTerm.evidence[0].quote.includes('Dynamic nominalism'))
 assert(cjkTerm.evidence[0].quote.length<=60+'Dynamic nominalism'.length+120)
 assert(blocks[0].text.includes(cjkTerm.evidence[0].quote))
 assert.equal(cleaned.terms.find(t=>t.src==='classification').dst,'《分类学》？')
 assert.equal(cleaned.terms.find(t=>t.dst.startsWith('Dynamic nominalism')).dst,'Dynamic nominalism (Hacking)...')
 assert.equal(normalizeCjkPunctuation('Salpêtrière (Paris)...'),'Salpêtrière (Paris)...')
 assert.equal(normalizeCjkPunctuation('疯癫，临床; 精神病学!'),'疯癫，临床；精神病学！')
})

test('once-only uncontested proper names auto-pass into auto-pass.json while associated, repeated, conceptual, or contested names enter consolidation',async()=>{
 const source=[
  'Jean Fernel authored a treatise while Hôpital Sainte-Anne archived Traité médico-philosophique.',
  'Pierre Janet and Janet debated Archives générales and Archive générale.',
  'École normale supérieure collaborated with École normale, Clinique Tarnier, and Clinique Charcot.',
  'Esquirol visited Bicêtre, and Esquirol defined nosographie.'
 ].join('\n\n')
 const terms=[
  {src:'Jean Fernel',dst:'让·费尔内尔',category:'person',sense:'16世纪医学家'},
  {src:'Hôpital Sainte-Anne',dst:'圣安娜医院',category:'institution',sense:'巴黎精神病院'},
  {src:'Traité médico-philosophique',dst:'医学哲学论',category:'title',sense:'皮内尔著作'},
  {src:'Pierre Janet',dst:'皮埃尔·让内',category:'person',sense:'心理学家'},
  {src:'Janet',dst:'让内',category:'person',sense:'心理学家简称'},
  {src:'Archives générales',dst:'综合档案',category:'title',sense:'期刊复数'},
  {src:'Archive générale',dst:'综合档案单数',category:'title',sense:'期刊单数'},
  {src:'École normale supérieure',dst:'巴黎高等师范学院',category:'institution',sense:'高师全称'},
  {src:'École normale',dst:'师范学院',category:'institution',sense:'高师简称'},
  {src:'Clinique Tarnier',dst:'塔尼耶诊所',category:'institution',sense:'诊所甲'},
  {src:'Clinique Charcot',dst:'沙可诊所',category:'institution',sense:'诊所乙'},
  {src:'Esquirol',dst:'埃斯基罗尔',category:'person',sense:'高频人物'},
  {src:'nosographie',dst:'疾病分类学',category:'concept',sense:'低频但属核心概念'},
  {src:'Bicêtre',dst:'比塞特医院',category:'institution',sense:'与公共表译名不同'}
 ]
 const f=await setup({source,terms});try{
  await fs.writeFile(path.join(f.root,'lingua/glossaries/master_academic.json'),JSON.stringify([{src:'Bicêtre',dst:'比塞特尔'}]))
  const wireSeen=[]
  const baseCommand=f.manager.command
  f.manager.command=async(t,cmd,args,io)=>{
   const input=args[args.indexOf('--input')+1]
   if(path.basename(input)==='consolidation.txt'){
    const units=(await fs.readFile(input,'utf8')).trim().split('\n').map(JSON.parse)
    wireSeen.push(...units.flatMap(u=>u.entries.map(e=>e.src)))
   }
   return baseCommand(t,cmd,args,io)
  }
  const receipt=await analyseBookGlossary(f.manager,f.task)
  f.task.stages.glossary={state:'done'}
  await requireBookGlossary(f.manager,f.task)
  assert.equal(receipt.autoPassedEntries,3)
  const dir=path.join(f.manager.dir(f.task.id),'glossary')
  const autoPass=JSON.parse(await fs.readFile(path.join(dir,'auto-pass.json'),'utf8'))
  assert.equal(autoPass.count,3)
  assert.deepEqual(autoPass.entries.map(e=>e.src).sort(),['Hôpital Sainte-Anne','Jean Fernel','Traité médico-philosophique'])
  assert(autoPass.entries.every(e=>e.reason===AUTO_PASS_REASON))
  for(const skipped of ['Jean Fernel','Hôpital Sainte-Anne','Traité médico-philosophique'])assert(!wireSeen.includes(skipped),`${skipped} must skip consolidation LLM`)
  for(const routed of ['Pierre Janet','Janet','Archives générales','Archive générale','École normale supérieure','École normale','Clinique Tarnier','Clinique Charcot','Esquirol','nosographie','Bicêtre'])assert(wireSeen.includes(routed),`${routed} must enter consolidation LLM`)
  const effective=JSON.parse(await fs.readFile(path.join(f.manager.dir(f.task.id),'glossary.json'),'utf8'))
  assert.equal(effective.length,14)
  const groups=JSON.parse(await fs.readFile(path.join(dir,'semantic-groups.json'),'utf8'))
  for(const skipped of ['Jean Fernel','Hôpital Sainte-Anne','Traité médico-philosophique']){
   const g=groups.find(x=>x.members.some(m=>m.src===skipped))
   assert.equal(g.reason,AUTO_PASS_REASON)
  }
  await fs.writeFile(path.join(dir,'auto-pass.json'),JSON.stringify({...autoPass,count:0,entries:[]}))
  await assert.rejects(requireBookGlossary(f.manager,f.task),/合并记录变化/)
 }finally{await f.close()}
})

test('consolidation transport sends slim payload for non-conflict entries, retains proposals and 2 quotes for conflicts, and enforces 100-entry batch cap',()=>{
 const nonConflictCount=120
 const blocks=markdownBlocks([
  ...Array.from({length:nonConflictCount},(_,i)=>`Concept_${String(i).padStart(3,'0')} defines an independent analytical axis.`),
  'Délire designates acute clinical delirium in the first ward.',
  'Délire also denotes systematized delusion in chronic paranoia.',
  'Délire recurs in a third observation.'
 ].join('\n\n'))
 const structural={
  terms:[
   ...Array.from({length:nonConflictCount},(_,i)=>({
    src:`Concept_${String(i).padStart(3,'0')}`,
    dst:`概念_${i}`,
    category:'concept',
    sense:'无冲突概念',
    uncertain:false,
    evidence:[{blockId:blocks[i].id,quote:blocks[i].text}]
   })),
   {src:'Délire',dst:'谵妄',category:'concept',sense:'急性谵妄',uncertain:false,evidence:[{blockId:blocks[nonConflictCount].id,quote:blocks[nonConflictCount].text}]},
   {src:'Délire',dst:'妄想',category:'concept',sense:'系统性妄想',uncertain:false,evidence:[{blockId:blocks[nonConflictCount+1].id,quote:blocks[nonConflictCount+1].text}]}
  ],
  dropped:[]
 }
 const partitioned=partitionCleaningCandidates(structural,{entries:[],ambiguous:[]},blocks,hash('slim-test'),'fr',24000,{maxEntries:100})
 assert.equal(partitioned.units.length,2)
 assert(partitioned.units.every(u=>u.entries.length<=100))
 const transport=glossaryTransportUnits('consolidation',partitioned.units)
 const allWireEntries=transport.units.flatMap(u=>u.entries)
 assert.equal(allWireEntries.length,121)
 const slimSample=allWireEntries.find(e=>e.src==='Concept_000')
 assert.deepEqual(Object.keys(slimSample),['id','src','dst','category'])
 const conflictWireUnit=transport.units.find(u=>u.entries.some(e=>e.src==='Délire'))
 const conflictEntry=conflictWireUnit.entries.find(e=>e.src==='Délire')
 assert.equal(conflictEntry.conflict,true)
 assert.equal(conflictEntry.proposals.length,2)
 assert.equal(conflictEntry.evidence.length,2)
 assert.equal(conflictWireUnit.contexts.length,2,'only the 2 quotes for the single conflicting entry should be sent on wire')
 const nonConflictOnlyUnit=transport.units.find(u=>!u.entries.some(e=>e.src==='Délire'))
 assert.equal(nonConflictOnlyUnit.contexts.length,0,'batch without conflicts sends zero context quotes on wire')
 // Verify applyConsolidation resolves short id accurately on restored record
 const restored=transport.restore({unitId:'G0001',groups:[{members:[{id:1,dst:'概念_零_修订',action:'keep',reason:'修订译名'}]}]})
 const applied=applyConsolidation(partitioned.units[0],restored,{effective:[],overrides:[]},{entries:[],ambiguous:[]},'fr')
 assert.equal(applied.effective.find(e=>e.src==='Concept_000').dst,'概念_零_修订')
 assert.equal(applied.effective.length,partitioned.units[0].entries.length)
})

test('VERSION=4 legacy receipt without auto-pass.json stays valid under requireBookGlossary and heading-aware 8000-char chunking preserves all source text',async()=>{
 const sectionA='# Chapitre I\n\n'+Array.from({length:12},(_,i)=>`Paragraph A${i}: ${'clinical observation in psychiatry '.repeat(8)}.`).join('\n\n')
 const sectionB='## Section 1.2\n\n'+Array.from({length:12},(_,i)=>`Paragraph B${i}: ${'institutional history of madness '.repeat(8)}.`).join('\n\n')
 const sectionC='### Subsection 1.2.1\n\n'+Array.from({length:8},(_,i)=>`Paragraph C${i}: ${'philosophical nosology and method '.repeat(8)}.`).join('\n\n')
 const fullSource=[sectionA,sectionB,sectionC].join('\n\n')
 const {blocks,units}=analysisUnits(fullSource,8000)
 assert(units.length>=2)
 assert.equal(units[1].passages[0].text,'## Section 1.2','## heading after >=25% budget flushes to start a fresh unit')
 for(const block of blocks){
  assert.equal(units.flatMap(u=>u.passages).filter(p=>p.blockId===block.id).map(p=>p.text).join(''),block.text)
 }

 const f=await setup();try{
  await analyseBookGlossary(f.manager,f.task,{analysisMaxChars:8000})
  f.task.stages.glossary={state:'done'}
  const dir=path.join(f.manager.dir(f.task.id),'glossary'),receiptPath=path.join(dir,'pipeline-receipt.json')
  const receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'))
  assert.equal(receipt.schemaVersion,4)
  assert.equal(receipt.analysisMaxChars,8000)
  // Simulate a finished task produced before auto-pass.json existed (e.g., 70bf3c88)
  delete receipt.artifacts['auto-pass.json']
  delete receipt.autoPassedEntries
  delete receipt.analysisMaxChars
  await fs.unlink(path.join(dir,'auto-pass.json'))
  await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2))
  const verified=await requireBookGlossary(f.manager,f.task)
  assert.equal(verified.schemaVersion,4)
 }finally{await f.close()}
})

test('isolated glossary timeouts clear on completed progress while sustained stalled timeouts abort and resume without exceeding breaker',async()=>{
 const f=await setup({source:'Ordinary source. '.repeat(300),terms:[]});try{
  let emitFailure,attempt=0;const baseCommand=f.manager.command
  f.manager.watchGlossaryProviderFailure=async cb=>{emitFailure=cb;return ()=>{}}
  f.manager.command=async(t,cmd,args,io)=>{
   const kind=path.basename(args[args.indexOf('--input')+1],'.txt')
   if(kind!=='analysis')return baseCommand(t,cmd,args,io)
   attempt++
   if(attempt===1){
    await io.onLine(JSON.stringify({type:'progress',stats:{total:2,completed:0,failed:0}}))
    emitFailure({reason:'timeout',observedVia:'native-log',at:new Date().toISOString()})
    await new Promise(r=>setTimeout(r,20))
    // Completed unit clears the pending timeout window before it can abort.
    await io.onLine(JSON.stringify({type:'progress',stats:{total:2,completed:1,failed:0}}))
    // Second timeout stalls past timeoutWindowMs -> triggers watchdog abort.
    const request=await (async()=>{await baseCommand(t,cmd,args,{onLine:async()=>{}});return f.requestLog.at(-1)})()
    request.pairs=request.pairs.slice(0,1)
    emitFailure({reason:'timeout',observedVia:'native-log',at:new Date().toISOString()})
    await new Promise(r=>setTimeout(r,130))
    throw new Error('CLI terminated after sustained timeout')
   }
   // Resumed run sees an isolated timeout followed by progress and completes cleanly.
   emitFailure({reason:'timeout',observedVia:'native-log',at:new Date().toISOString()})
   await new Promise(r=>setTimeout(r,20))
   await io.onLine(JSON.stringify({type:'progress',stats:{total:1,completed:1,failed:0}}))
   return baseCommand(t,cmd,args,io)
  }
  await assert.rejects(analyseBookGlossary(f.manager,f.task,{timeoutWindowMs:70}),/模型请求超时/)
  const firstReceipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile,'utf8'))
  assert.equal(firstReceipt.status,'provider-rejected')
  assert.equal(firstReceipt.providerFailure.reason,'timeout')
  assert.equal(firstReceipt.providerRetryCount,0)
  // Because attempt 1 reported cliStats.completed = 1 alongside providerFailure, consecutive streak is 1 (< BREAKER_LIMIT) and resumes cleanly.
  const report=await analyseBookGlossary(f.manager,f.task,{retryErrors:true,timeoutWindowMs:140})
  assert.equal(report.status,'complete')
  const finalReceipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile,'utf8'))
  assert.equal(finalReceipt.status,'done')
  assert.equal(finalReceipt.reusedUnits,1)
  assert.equal(finalReceipt.providerRetryCount,1)
 }finally{await f.close()}
})

test('glossary breaker resets when prior failures expire past 30 minutes',async()=>{
 const f=await setup();try{
  let reject,fail=true;f.manager.watchGlossaryProviderFailure=async cb=>{reject=cb;return ()=>{}}
  const baseCommand=f.manager.command
  f.manager.command=async(t,cmd,args,io)=>{if(fail){f.calls.push('request');reject({reason:'timeout',observedVia:'test'});throw new Error('timeout')}return baseCommand(t,cmd,args,io)}
  for(let i=0;i<10;i++)await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:i>0}),/已保留完成结果/)
  await assert.rejects(analyseBookGlossary(f.manager,f.task,{retryErrors:true}),/连续失败 10 次/)
  // Age all persisted receipts past the 30-minute breaker window.
  const staleAt=new Date(Date.now()-31*60*1000).toISOString()
  const runsDir=path.join(f.task.glossaryRuns.analysis.directory,'runs')
  for(const name of await fs.readdir(runsDir)){
   const rp=path.join(runsDir,name,'receipt.json'),rec=JSON.parse(await fs.readFile(rp,'utf8'))
   if(rec.providerFailure)rec.providerFailure.at=staleAt
   rec.endedAt=staleAt;rec.startedAt=staleAt
   await fs.writeFile(rp,JSON.stringify(rec))
  }
  const topReceipt=JSON.parse(await fs.readFile(f.task.glossaryRuns.analysis.receiptFile,'utf8'))
  topReceipt.providerFailure.at=staleAt;topReceipt.endedAt=staleAt;topReceipt.startedAt=staleAt
  await fs.writeFile(f.task.glossaryRuns.analysis.receiptFile,JSON.stringify(topReceipt))
  fail=false
  const report=await analyseBookGlossary(f.manager,f.task,{retryErrors:true})
  assert.equal(report.status,'complete')
 }finally{await f.close()}
})

test('agy catalog, effort levels, and bridge helpers support updated agy CLI models',()=>{
 for(const id of ['gemini-4-hydrogen-xhigh','gemini-4-hydrogen-high','gemini-4-hydrogen-medium','gemini-4-hydrogen-low','gemini-pro-orchestrator-g1-pro']){
  assert.ok(REVIEW_ORCHESTRATOR_MODELS.includes(id),id)
  const entry=AGY_CLI_GROUP.models.find(m=>m.id===id)
  assert.ok(entry,id)
  assert.ok(entry.reasoning.efforts.some(e=>e.id==='xhigh'))
  assert.equal(isAgyCliModel(id),true)
  assert.equal(isAgyCliModel('agy/'+id),true)
  assert.equal(normalizeReviewConfig({orchestratorModel:id,orchestratorEffort:'xhigh',workerModel:id}).orchestratorModel,'agy/'+id)
 }
 assert.ok(REVIEW_EFFORTS.includes('xhigh'))
 assert.equal(resolveAgyCliModelFlag('agy/gemini-4-hydrogen','xhigh'),'gemini-4-hydrogen-xhigh')
 assert.equal(resolveAgyCliModelFlag('agy/gemini-4-hydrogen-xhigh','xhigh'),'gemini-4-hydrogen-xhigh')
 assert.equal(resolveAgyCliModelFlag('agy/pro','xhigh'),'gemini-4-argon-high')
 assert.equal(resolveAgyWorkerTier('agy/gemini-4-hydrogen-xhigh'),'pro')
})



