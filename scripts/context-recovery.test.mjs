import test from 'node:test'
import assert from 'node:assert/strict'
import {installContextRecovery,isContextOverflow} from '../modules/pipeline/context-recovery.js'
import {apply, definition} from '../preset.js'
test('reading preset enables native pressure compaction and output pruning',()=>{
 const group=definition.plugins.find(p=>p.id==='compaction')
 assert.equal(group.name,'cordis:group');assert.equal(group.group,true)
 assert.deepEqual(group.isolate,{compaction:true,toolResultPruner:true})
 const p=group.config.find(p=>p.name==='@deepseek-ai/dsh-compaction-basic');assert.equal(p.config.auto,true);assert.ok(p.config.thresholdRatio<0.8)
 assert.ok(group.config.some(p=>p.name==='@deepseek-ai/dsh-compaction-tool-result-pruner'))
 assert.ok(group.config.some(p=>p.name==='@local/paper-reader/preset'))
})
test('reading preset uses native tool presentation only when the host still provides it', () => {
  const host = presentAs => ({inject() {}, on() {}, systemPrompt: {section() {}}, tools: {view: () => ({restrictableNames: []}), restrict() {}, ...(presentAs ? {presentAs} : {})}})
  assert.doesNotThrow(() => apply(host()))
  const calls = []
  apply(host(mode => calls.push(mode)))
  assert.deepEqual(calls, ['native'])
})
test('reading preset does not filter tools during system-prompt assembly', () => {
  const events = {}
  apply({inject() {}, on(name, fn) { events[name] = fn }, systemPrompt: {section() {}}, tools: {view: () => ({restrictableNames: ['shell']}), restrict() {}}})
  assert.equal(events['system-prompt/assemble'], undefined)
})
test('overflow recovery requires durable progress and retries at most once per turn',async()=>{
 let calls=0;const events={},agent={session:{surface:{replaceGeneration:0}}}
 installContextRecovery({inject:(_deps,fn)=>fn({compaction:{compactIfNeeded:async()=>{calls++;agent.session.surface.replaceGeneration++}}}),on:(n,fn)=>events[n]=fn,logger:{warn(){}}})
 const input={agent,failure:{code:'INVALID_REQUEST',message:'Your request exceeded k3-256k model token limit: 262144'},signal:new AbortController().signal}
 assert.equal(isContextOverflow({code:'INVALID_REQUEST',message:'bad parameter'}),false)
 assert.deepEqual(await events['agent/request-error'](input,()=>null),{kind:'retry'})
 assert.equal(await events['agent/request-error'](input,()=>null),null);assert.equal(calls,1)
 events['agent/status']({agent,status:'idle'});await events['agent/request-error'](input,()=>null);assert.equal(calls,2)
})
