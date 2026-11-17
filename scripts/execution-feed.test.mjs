import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {executionEvents,publicExecutionText} from '../modules/pipeline/execution-feed.js'

test('live execution cursor delivers appended UTF-8 input and output once without reopening',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-feed-')),file=path.join(dir,'execution-events.jsonl')
 try{
  assert.equal((await executionEvents(dir,null)).cursor,0)
  const input={id:'request',role:'worker',text:'请求已发出\n输入：文献第 13 页',time:'2026-10-16T00:00:00Z'}
  await fs.writeFile(file,JSON.stringify(input)+'\n')
  const first=await executionEvents(dir,null);assert.deepEqual(first.events,[input])
  assert.equal((await executionEvents(dir,first.cursor)).events.length,0)
  const output={id:'response',role:'worker',text:'模型已返回\n响应：实际转写',time:'2026-10-16T00:00:01Z'}
  const line=Buffer.from(JSON.stringify(output)+'\n'),half=Math.floor(line.length/2)
  await fs.appendFile(file,line.subarray(0,half));const partial=await executionEvents(dir,first.cursor);assert.equal(partial.events.length,0);assert.equal(partial.cursor,first.cursor)
  await fs.appendFile(file,line.subarray(half));const second=await executionEvents(dir,partial.cursor);assert.deepEqual(second.events,[output]);assert.equal((await executionEvents(dir,second.cursor)).events.length,0)
  await fs.writeFile(file,JSON.stringify(input)+'\n');const reset=await executionEvents(dir,second.cursor);assert.equal(reset.reset,true);assert.deepEqual(reset.events,[input])
 }finally{await fs.rm(dir,{recursive:true,force:true})}
})
test('live feed exposes response content without internal reasoning or provider headers',()=>{
 const text='模型已返回\n响应内容：\n'+JSON.stringify({choices:[{message:{content:'实际输出',reasoning_content:'private-reasoning'}}],headers:{authorization:'private-header'}})
 const shown=publicExecutionText(text);assert.match(shown,/实际输出/);assert.ok(!shown.includes('private-reasoning'));assert.ok(!shown.includes('private-header'))
 assert.ok(!publicExecutionText('响应\n响应内容：\n{"choices":[{"message":{"content":"输出","reasoning_content":"private-reasoning').includes('private-reasoning'))
})
test('panel summaries distinguish blocked processing and an unstarted CLI',async()=>{
 const source=await fs.readFile(new URL('../client.js',import.meta.url),'utf8'),start=source.indexOf('    function executionSummary('),end=source.indexOf('    function PipelinePanel(',start),context={}
 vm.runInNewContext(source.slice(start,end),context)
 const task={state:'blocked',stage:'transcribe',message:'章节未通过验收',worker:{model:'test-model'},transcriptionProgress:{completed:9,total:338,active:[]}}
 assert.match(context.executionSummary(task,'orchestrator'),/已停止.*未通过验收/)
 assert.match(context.executionSummary(task,'worker'),/9\/338 页.*受阻/)
 assert.match(context.executionSummary(task,'linguagacha'),/尚未启动/)
})
test('mounted conversation feed refreshes input and output without reopening the session',async()=>{
 const source=await fs.readFile(new URL('../client.js',import.meta.url),'utf8'),start=source.indexOf('    function LiveDocumentExecution('),end=source.indexOf('    function ReaderIcon(',start)
 const states=[],refs=[],effects=[];let stateIndex=0,refIndex=0,initial=true,poll,reads=0;const urls=[]
 const task={name:'Fixture book',state:'running',message:'正在转写',worker:{model:'fixture'}}
 const input={id:'input',role:'worker',time:'2026-10-16T00:00:00Z',text:'状态：请求已发出\n输入提示：实际输入'}
 const output={id:'output',role:'worker',time:'2026-10-16T00:00:01Z',text:'状态：模型已返回\n模型响应：实际输出'}
 const context={AbortController,Date,Set,encodeURIComponent,h:(type,props,...children)=>({type,props,children}),
  useState:value=>{const index=stateIndex++;if(initial)states[index]=value;return [states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next}]},
  useRef:value=>{const index=refIndex++;if(initial)refs[index]={current:value};return refs[index]},
  useEffect:fn=>{if(initial)effects.push(fn)},setInterval:fn=>{poll=fn;return 1},clearInterval:()=>{},
  fetch:async url=>{urls.push(url);return {ok:true,json:async()=>({bound:true,role:'worker',task,sessions:{worker:'session-test'},cursor:++reads,events:reads===1?[input]:reads===2?[output]:[],reset:false})}}
 }
 vm.runInNewContext(source.slice(start,end),context)
 const render=()=>{stateIndex=0;refIndex=0;return context.LiveDocumentExecution({executionSessionId:'session-test',openExecutionSession:()=>{}})}
 render();const cleanup=effects.map(fn=>fn());await new Promise(resolve=>setImmediate(resolve));initial=false
 const closed=render();assert.ok(!JSON.stringify(closed).includes('实际输入'));assert.equal(closed.children[0].props['aria-expanded'],false)
 closed.children[0].props.onClick();assert.match(JSON.stringify(render()),/实际输入/);assert.ok(!JSON.stringify(render()).includes('实际输出'))
 await poll();assert.match(JSON.stringify(render()),/实际输出/);assert.equal(urls.length,2);assert.match(urls[1],/cursor=1/)
 await poll();render();assert.equal(states[1].filter(e=>e.id==='output').length,1)
 const opened=render();opened.children[1].children[0].props.onClick();assert.ok(!JSON.stringify(render()).includes('实际输入'))
 assert.ok(source.includes("name:'conversation.session.header.utilities',id:'paper-reader-live-execution'"));assert.ok(!source.includes("name:'conversation.composer.dock',id:'paper-reader-live-execution'"))
 for(const fn of cleanup)fn?.()
})
