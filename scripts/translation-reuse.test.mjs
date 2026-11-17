import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {hash} from '../modules/pipeline/markdown.js'
import {translationPrompt} from '../modules/pipeline/cli.js'
import {translationInput} from '../modules/pipeline/source-map.js'
import {translationChunks,recoverTranslationChunks} from '../modules/pipeline/translation-transport.js'

async function fixture(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'translation-reuse-'))
 try{
  const file=path.join(root,'original.md');await fs.writeFile(file,'Text.\n')
  const receipt=translationInput('Text.\n'),input=path.join(root,'input.md');await fs.writeFile(input,receipt.text)
  const model={model:'fixture/model',credentialConfigured:true,connectionVerified:false,threshold:{input_token_limit:800,output_token_limit:131072,concurrency_limit:1}}
  const manager={dir:()=>root,requireGlossary:async()=>{},original:async()=>file,cliStatus:async()=>({version:'fixture',model}),prepareTranslationInput:async()=>({file:input,receipt})}
  const task={input:{type:'markdown'},kind:'book',profile:{language:'en'},stages:{}}
  const prepare=()=>TaskManager.prototype.prepareCliTranslation.call(manager,task)
  await fn({root,receipt,model,manager,task,prepare})
 }finally{await fs.rm(root,{recursive:true,force:true})}
}
test('new preparation survives concurrency and model changes while source and glossary changes invalidate it',async()=>fixture(async f=>{
 await f.prepare();const key=f.task.cliPreparation.key
 for(const n of [4,8,2,6]){f.model.threshold.concurrency_limit=n;await f.prepare();assert.equal(f.task.cliPreparation.key,key)}
 f.model.model='fixture/changed';f.model.name='changed';await f.prepare();assert.equal(f.task.cliPreparation.key,key)
 f.model.model='fixture/model';f.model.threshold.input_token_limit=1600;await f.prepare();assert.notEqual(f.task.cliPreparation.key,key)
 f.model.threshold.input_token_limit=800;await f.prepare();assert.equal(f.task.cliPreparation.key,key)
 f.receipt.sourceFingerprint='changed';await f.prepare();assert.notEqual(f.task.cliPreparation.key,key)
 f.receipt.sourceFingerprint=hash('Text.\n');await fs.writeFile(path.join(f.root,'glossary.json'),'[{"src":"Text","dst":"正文"}]');await f.prepare();assert.notEqual(f.task.cliPreparation.key,key)
}))
test('legacy receipts remain reusable across 1 to 4 to 8 without rewriting keys or checkpoints',async()=>fixture(async f=>{
 const oldKey=hash(JSON.stringify({source:f.receipt.sourceFingerprint,annotated:f.receipt.annotatedFingerprint,model:f.model,prompt:translationPrompt('book'),glossary:[],language:'en'}))
 f.task.cliPreparation={key:oldKey}
 for(const n of [4,8,1]){f.model.threshold.concurrency_limit=n;await f.prepare();assert.equal(f.task.cliPreparation.key,oldKey)}
 f.model.threshold.input_token_limit=1600;await f.prepare();assert.notEqual(f.task.cliPreparation.key,oldKey)
}))
test('completed output is reused after concurrency changes without reading history or calling a model',async()=>fixture(async f=>{
 f.manager.prepareCliTranslation=f.prepare;f.manager.save=async()=>{}
 await f.prepare();await fs.mkdir(path.join(f.root,'translation'));const output='现有译文。\n';await fs.writeFile(path.join(f.root,'translation/translated.md'),output)
 f.task.stages.lgProject={state:'done'};f.task.translationCli={status:'done',key:f.task.cliPreparation.key,outputFingerprint:hash(output)}
 f.model.threshold.concurrency_limit=8
 f.manager.translationRequestLog=async()=>{throw Error('unnecessary history scan')};f.manager.command=async()=>{throw Error('unnecessary model request')}
 await TaskManager.prototype.translateViaCli.call(f.manager,f.task,{})
 assert.equal(f.task.translationProgress.reused,true)
}))
test('history filtering retains chronological winner, excludes invalid dates and does not mutate requests',()=>{
 const source=translationInput('Text.\n').text,chunk=translationChunks(source)[0]
 const pair=word=>({src:chunk.text,dst:chunk.text.replace('Text.',word)})
 const requests=[{ended_at:'2026-10-26T01:02:00Z',pairs:[pair('较新。')]},{ended_at:'invalid',pairs:[pair('无效。')]},{ended_at:'2026-10-26T01:01:00Z',pairs:[pair('较旧。')]},{ended_at:'2026-10-27T01:02:00Z',pairs:[pair('其他运行。')]}]
 const before=JSON.stringify(requests),result=recoverTranslationChunks(source,[{startedAt:'2026-10-26T01:00:00Z',endedAt:'2026-10-26T02:00:00Z'}],requests)
 assert.equal(result.recovered[0].dst,pair('较新。').dst);assert.equal(result.pending.length,0);assert.equal(JSON.stringify(requests),before)
})
test('partial legacy checkpoint survives concurrency change and sends only missing blocks',async()=>fixture(async f=>{
 f.receipt=translationInput('First.\n\nSecond.\n');const input=path.join(f.root,'input.md');await fs.writeFile(input,f.receipt.text)
 f.manager.prepareTranslationInput=async()=>({file:input,receipt:f.receipt});f.manager.prepareCliTranslation=f.prepare;f.manager.save=async()=>{}
 const oldKey=hash(JSON.stringify({source:f.receipt.sourceFingerprint,annotated:f.receipt.annotatedFingerprint,model:f.model,prompt:translationPrompt('book'),glossary:[],language:'en'}))
 f.task.cliPreparation={key:oldKey};f.task.stages.lgProject={state:'done'};f.task.translationCli={key:oldKey,status:'error',attempt:1}
 const chunks=translationChunks(f.receipt.text),cached=[{src:chunks[0].text,dst:chunks[0].text.replace('First.','第一段。')}],run=path.join(f.root,'translation-cli/runs/1')
 await fs.mkdir(run,{recursive:true});const checkpoint=path.join(run,'recovered.json'),bytes=JSON.stringify(cached);await fs.writeFile(checkpoint,bytes)
 await fs.writeFile(path.join(run,'receipt.json'),JSON.stringify({key:oldKey,startedAt:'2026-10-26T00:00:00Z',endedAt:'2026-10-26T01:00:00Z',checkpointFile:checkpoint,checkpointSha256:hash(bytes)}))
 f.manager.translationRequestLog=async()=>[];f.manager.watchTranslationProviderFailure=async()=>()=>{}
 let calls=0,combined
 f.manager.command=async(task,cmd,args,io)=>{calls++;const pending=await fs.readFile(args[args.indexOf('--input')+1],'utf8');assert.equal(pending.trim(),chunks[1].text.trim());await fs.writeFile(path.join(args[args.indexOf('--output-dir')+1],'translated.md'),pending.replace('Second.','第二段。'));await io.onLine(JSON.stringify({type:'finished',status:'done'}))}
 f.manager.acceptTranslationOutput=async(task,text)=>{combined=text;await fs.mkdir(path.join(f.root,'translation'),{recursive:true});await fs.writeFile(path.join(f.root,'translation/translated.md'),text)}
 f.model.threshold.concurrency_limit=4
 await TaskManager.prototype.translateViaCli.call(f.manager,f.task,{retryErrors:true})
 assert.equal(calls,1);assert.equal(f.task.translationCli.reusedBlocks,1);assert.equal(f.task.translationCli.requestedBlocks,1);assert(combined.includes('第一段。'));assert(combined.includes('第二段。'));assert.equal(await fs.readFile(checkpoint,'utf8'),bytes)
}))
