import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {markdownBlocks} from '../modules/pipeline/markdown.js'

async function run(t,code,stage='translate'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'translation-idle-')),script=path.join(root,'cli.cjs')
 const requested=[],timers=[],original=setTimeout
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{requested.push(ms);const timer=original(fn,ms===1200000?300:ms,...args);timers.push(timer);return timer})
 const manager={root,cliExecutable:process.execPath,active:new Map(),save:async()=>{}},task={id:'fixture',stage}
 try{
  await fs.writeFile(script,code)
  let error;try{await TaskManager.prototype.rawCommand.call(manager,task,process.execPath,[script])}catch(e){error=e}
  return {error,entry:task.log[0],requested}
 }finally{for(const timer of timers)clearTimeout(timer);t.mock.restoreAll();await fs.rm(root,{recursive:true,force:true})}
}
test('newly completed blocks extend the translation deadline beyond the original interval',async t=>{
 const result=await run(t,`let n=0;const timer=setInterval(()=>{console.log(JSON.stringify({type:'progress',stats:{completed:++n}}));if(n===7){clearInterval(timer);process.exitCode=0}},100)`)
 assert.equal(result.error,undefined);assert.equal(result.entry.timedOut,undefined)
 assert(result.requested.includes(1200000));assert(!result.requested.includes(10800000))
})
test('repeated progress, failed counts and log output cannot keep a stalled translation alive',async t=>{
 const result=await run(t,`console.log(JSON.stringify({type:'progress',stats:{completed:1}}));setInterval(()=>{console.log(JSON.stringify({type:'progress',stats:{completed:1,failed:100}}));console.log('still running')},40);process.on('SIGTERM',()=>process.exit(0))`)
 assert(result.entry.timedOut);assert.match(result.error.message,/连续 20 分钟没有新增完成块/)
 assert.equal(result.entry.exitCode,0)
})
test('silent translation times out and preserves a resumable diagnostic',async t=>{
 const result=await run(t,'setInterval(()=>{},1000)')
 assert(result.entry.timedOut);assert.match(result.error.message,/复用已完成译块/)
})
test('glossary CLI uses the idle watchdog instead of a 3 hour absolute deadline',async t=>{
 const result=await run(t,`let n=0;const timer=setInterval(()=>{console.log(JSON.stringify({type:'progress',stats:{completed:++n}}));if(n===7){clearInterval(timer);process.exitCode=0}},100)`,'glossary')
 assert.equal(result.error,undefined);assert.equal(result.entry.timedOut,undefined)
 assert(result.requested.includes(1200000));assert(!result.requested.includes(10800000))
})
test('stalled glossary CLI stops with a resumable, flagged error',async t=>{
 const result=await run(t,`console.log(JSON.stringify({type:'progress',stats:{completed:1}}));setInterval(()=>console.log('still running'),40);process.on('SIGTERM',()=>process.exit(0))`,'glossary')
 assert(result.entry.timedOut);assert.equal(result.error.timedOut,true);assert.equal(result.entry.exitCode,0)
 assert.match(result.error.message,/术语分析连续 20 分钟没有新增完成单元/)
})
test('other stages retain their original absolute timeout',async t=>{
 const result=await run(t,'console.log("done")','lgProject')
 assert.equal(result.error,undefined);assert(result.requested.includes(10800000));assert(!result.requested.includes(1200000))
})

test('translateViaCli resets quota timer on progress, aborts after sustained quota window without consuming retry budget, and resumes remaining blocks',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'translation-quota-'))),sourceFile=path.join(root,'source.md')
 const source='First paragraph on psychiatry.\n\nSecond paragraph on clinical observation.\n\nThird paragraph on asylum institutions.\n\nFourth paragraph on nosology.\n'
 await fs.writeFile(sourceFile,source)
 const id='22222222-2222-4222-8222-222222222222'
 const manager=new TaskManager(root,path.join(root,'papers'))
 manager.original=async()=>sourceFile;manager.save=async x=>x;manager.requireGlossary=async()=>{}
 manager.cliStatus=async()=>({version:'offline-test',model:{name:'MiMo',model:'opencode-go/mimo-v2.6-pro',credentialConfigured:true}})
 const task={id,name:'Quota test',kind:'paper',input:{type:'markdown'},path:sourceFile,profile:{language:'en'},stages:{},log:[],bookmarks:[]}
 const requests=[],counts=[];let emitFailure
 manager.translationRequestLog=async()=>requests
 manager.watchTranslationProviderFailure=async cb=>{emitFailure=cb;return ()=>{}}
 try{
  manager.command=async(_t,_cmd,args,io)=>{
   const input=await fs.readFile(args[args.indexOf('--input')+1],'utf8'),blocks=markdownBlocks(input),out=args[args.indexOf('--output-dir')+1]
   counts.push(blocks.length)
   const pairs=blocks.map((b,i)=>({src:b.text,dst:`译文块 ${counts.length}-${i+1}：${b.text}`}))
   if(counts.length===1){
    await io.onLine(JSON.stringify({type:'progress',stats:{total:4,completed:1,failed:0}}))
    emitFailure({reason:'quota',resetHint:'Your quota will reset when the current 5-hour window ends',at:new Date().toISOString()})
    await new Promise(r=>setTimeout(r,20))
    // Progress resets the quota window before expiry.
    requests.push({ended_at:new Date().toISOString(),pairs:pairs.slice(0,2)})
    await io.onLine(JSON.stringify({type:'progress',stats:{total:4,completed:2,failed:0}}))
    emitFailure({reason:'quota',resetHint:'Your quota will reset when the current 5-hour window ends',at:new Date().toISOString()})
    emitFailure({reason:'quota',resetHint:'Your quota will reset when the current 5-hour window ends',at:new Date().toISOString()})
    await new Promise(r=>setTimeout(r,110))
    throw new Error('CLI terminated after quota abort')
   }
   // Second attempt: transient quota event followed by progress completes normally.
   emitFailure({reason:'quota',resetHint:'Your quota will reset when the current 5-hour window ends',at:new Date().toISOString()})
   await new Promise(r=>setTimeout(r,15))
   await io.onLine(JSON.stringify({type:'progress',stats:{total:blocks.length,completed:1,failed:0}}))
   await fs.writeFile(path.join(out,'result.md'),pairs.map(p=>p.dst).join('\n\n'))
   await io.onLine(JSON.stringify({type:'progress',stats:{total:blocks.length,completed:blocks.length,failed:0}}))
   await io.onLine(JSON.stringify({type:'finished',status:'done'}))
  }
  await assert.rejects(
   manager.translateViaCli(task,{quotaWindowMs:60}),
   err=>err.code==='TRANSLATION_PROVIDER_QUOTA'&&/模型 opencode-go\/mimo-v2\.6-pro 额度已用尽（Your quota will reset when the current 5-hour window ends）。已完成 2\/4 个单元并已保存。/.test(err.message)
  )
  assert.equal(task.translationCli.status,'quota-exhausted')
  assert.equal(task.translationCli.providerFailure,undefined)
  assert.equal(task.translationCli.providerRetryCount,0)
  assert.equal(task.translationCli.quotaFailure.count,2)
  const recovered=JSON.parse(await fs.readFile(task.translationCli.checkpointFile,'utf8'))
  assert.equal(recovered.length,2)

  await manager.translateViaCli(task,{retryErrors:true,quotaWindowMs:120})
  assert.deepEqual(counts,[4,2])
  assert.equal(task.translationCli.status,'done')
  assert.equal(task.translationCli.providerRetryCount,0)
  assert.equal(task.translationCli.reusedBlocks,2)
  const finalBlocks=markdownBlocks(await fs.readFile(path.join(manager.dir(id),'translation/translated.md'),'utf8'))
  assert.equal(finalBlocks.length,4)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('translateViaCli tolerates isolated timeouts when progress advances, aborts when stalled, and resumes remaining blocks',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'translation-timeout-window-'))),sourceFile=path.join(root,'source.md')
 const source='First paragraph on nosology.\n\nSecond paragraph on clinical observation.\n\nThird paragraph on therapeutics.\n\nFourth paragraph on pathology.\n'
 await fs.writeFile(sourceFile,source)
 const id='33333333-3333-4333-8333-333333333333'
 const manager=new TaskManager(root,path.join(root,'papers'))
 manager.original=async()=>sourceFile;manager.save=async x=>x;manager.requireGlossary=async()=>{}
 manager.cliStatus=async()=>({version:'offline-test',model:{name:'GPT-5.4',model:'opencode-go/gpt-5.4',credentialConfigured:true}})
 const task={id,name:'Timeout test',kind:'paper',input:{type:'markdown'},path:sourceFile,profile:{language:'en'},stages:{},log:[],bookmarks:[]}
 const requests=[],counts=[];let emitFailure
 manager.translationRequestLog=async()=>requests
 manager.watchTranslationProviderFailure=async cb=>{emitFailure=cb;return ()=>{}}
 try{
  manager.command=async(_t,_cmd,args,io)=>{
   const input=await fs.readFile(args[args.indexOf('--input')+1],'utf8'),blocks=markdownBlocks(input),out=args[args.indexOf('--output-dir')+1]
   counts.push(blocks.length)
   const pairs=blocks.map((b,i)=>({src:b.text,dst:`译文段 ${counts.length}-${i+1}：${b.text}`}))
   if(counts.length===1){
    await io.onLine(JSON.stringify({type:'progress',stats:{total:4,completed:1,failed:0}}))
    emitFailure({reason:'timeout',observedVia:'native-log',at:new Date().toISOString()})
    await new Promise(r=>setTimeout(r,20))
    // Progress clears pending timeout without aborting.
    requests.push({ended_at:new Date().toISOString(),pairs:pairs.slice(0,2)})
    await io.onLine(JSON.stringify({type:'progress',stats:{total:4,completed:2,failed:0}}))
    // Sustained stall on timeout aborts after timeoutWindowMs.
    emitFailure({reason:'timeout',observedVia:'native-log',at:new Date().toISOString()})
    await new Promise(r=>setTimeout(r,130))
    throw new Error('CLI terminated after timeout abort')
   }
   // Resumed run sees an isolated timeout cleared by progress and finishes cleanly.
   emitFailure({reason:'timeout',observedVia:'native-log',at:new Date().toISOString()})
   await new Promise(r=>setTimeout(r,20))
   await io.onLine(JSON.stringify({type:'progress',stats:{total:blocks.length,completed:1,failed:0}}))
   await fs.writeFile(path.join(out,'result.md'),pairs.map(p=>p.dst).join('\n\n'))
   await io.onLine(JSON.stringify({type:'progress',stats:{total:blocks.length,completed:blocks.length,failed:0}}))
   await io.onLine(JSON.stringify({type:'finished',status:'done'}))
  }
  await assert.rejects(manager.translateViaCli(task,{timeoutWindowMs:70}),/翻译请求timeout/)
  assert.equal(task.translationCli.status,'error')
  assert.equal(task.translationCli.providerFailure.reason,'timeout')
  assert.equal(task.translationCli.cliStats.completed,2)
  const recovered=JSON.parse(await fs.readFile(task.translationCli.checkpointFile,'utf8'))
  assert.equal(recovered.length,2)

  await manager.translateViaCli(task,{retryErrors:true,timeoutWindowMs:140})
  assert.deepEqual(counts,[4,2])
  assert.equal(task.translationCli.status,'done')
  assert.equal(task.translationCli.reusedBlocks,2)
  // Run 1 had cliStats.completed = 2 before providerFailure -> consecutive failure streak stayed 1!
  assert.equal(task.translationCli.providerRetryCount,1)
  const finalBlocks=markdownBlocks(await fs.readFile(path.join(manager.dir(id),'translation/translated.md'),'utf8'))
  assert.equal(finalBlocks.length,4)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
