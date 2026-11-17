import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {TaskManager, resolveFallbacks, visionFallbackArgs} from '../modules/pipeline/tasks.js'

test('fallback choices accept Harness model ids and reject the primary', () => {
  assert.deepEqual(resolveFallbacks('xiaomi:mimo-v2.6-flash', ['kimi-coding:k3', 'openai-codex:gpt-6-luna']), [
    {provider: 'kimi-coding', model: 'k3'},
    {provider: 'openai-codex', model: 'gpt-6-luna'},
  ])
  assert.deepEqual(resolveFallbacks('xiaomi:mimo-v2.6-flash', []), [])
  assert.throws(() => resolveFallbacks('xiaomi:mimo-v2.6-flash', ['xiaomi:mimo-v2.6-flash']), /不能与主模型相同/)
  assert.throws(() => resolveFallbacks('xiaomi:mimo-v2.6-flash', ['kimi-coding:k3', 'kimi-coding:k3']), /不能相同/)
  assert.throws(() => resolveFallbacks('xiaomi:mimo-v2.6-flash', ['not-a-model']), /DeepSeek Harness/)
  assert.throws(() => resolveFallbacks('xiaomi:mimo-v2.6-flash', ['kimi-coding:k3', 'google:gemini-3.5-flash-lite', 'openai-codex:gpt-6-luna']), /最多选择两个/)
})

test('vision fallback arguments keep two models after the primary', () => {
  assert.deepEqual(visionFallbackArgs({
    provider: 'mimo', model: 'mimo-v2.6-flash',
    fallbacks: [
      {provider: 'mimo', model: 'mimo-v2.6-flash'},
      {provider: 'kimi', model: 'kimi-a'},
      {provider: 'gemini', model: 'gemini-a'},
      {provider: 'minimax', model: 'extra'},
      {provider: 'bad:name', model: 'x'},
    ],
  }), ['--fallback', 'kimi:kimi-a', '--fallback', 'gemini:gemini-a'])
  assert.deepEqual(visionFallbackArgs({provider: 'mimo', model: 'mimo-v2.6-flash'}), [])
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-fallback-'))
  const skill = path.join(root, '.kimi-code/skills/fnm-ai-convert')
  await fs.mkdir(path.join(skill, 'scripts'), {recursive: true})
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'mimo-v2.6-pro\n')
  await fs.writeFile(path.join(skill, 'scripts/worker_call.py'), `
DEFAULT_PROVIDER = "mimo"
PROVIDERS = {
  "mimo": {"default_model": "mimo-v2.6-flash", "key_name": "MIMO_API_KEY", "request_deadline": 600},
  "kimi": {"default_model": "kimi-a", "key_name": "KIMI_API_KEY", "request_deadline": 120},
  "gemini": {"default_model": "gemini-a", "key_name": "GEMINI_API_KEY", "request_deadline": 120},
  "xai": {"default_model": "grok", "key_name": "XAI_API_KEY", "request_deadline": 120},
}
`)
  const manager = new TaskManager(root, path.join(root, 'reading'))
  const id = randomUUID()
  const task = {
    id, name: 'Fallback fixture', kind: 'chapter', state: 'idle', stage: 'transcribe',
    input: {type: 'pdf', fingerprint: 'abc'}, path: path.join(root, 'source.pdf'),
    worker: {provider: 'mimo', model: 'mimo-v2.6-flash', timeout: 600},
    stages: {transcribe: {state: 'done'}}, log: [{stage: 'transcribe', command: 'bounded_chapter.py'}],
    bookmarks: [],
  }
  await fs.mkdir(manager.dir(id), {recursive: true})
  await fs.writeFile(path.join(manager.dir(id), 'task.json'), JSON.stringify(task))
  return {root, manager, id}
}

test('fallback models can change after transcription without resetting the primary', async () => {
  const {root, manager, id} = await fixture()
  try {
    const saved = await manager.updateFallbacks(id, ['kimi:kimi-a', 'gemini:gemini-a'])
    assert.equal(saved.worker.provider, 'mimo')
    assert.equal(saved.worker.model, 'mimo-v2.6-flash')
    assert.deepEqual(saved.worker.fallbacks, [
      {provider: 'kimi', model: 'kimi-a'},
      {provider: 'gemini', model: 'gemini-a'},
    ])
    assert.deepEqual(visionFallbackArgs(saved.worker), ['--fallback', 'kimi:kimi-a', '--fallback', 'gemini:gemini-a'])
    await assert.rejects(manager.updateFallbacks(id, ['mimo:mimo-v2.6-flash']), /不能与主模型相同/)
    await assert.rejects(manager.updateFallbacks(id, ['kimi:kimi-a', 'kimi:kimi-a']), /不能相同/)
    const harness = await manager.updateFallbacks(id, ['kimi-coding:k3', 'openai-codex:gpt-6-luna'])
    assert.deepEqual(harness.worker.fallbacks, [
      {provider: 'kimi-coding', model: 'k3'},
      {provider: 'openai-codex', model: 'gpt-6-luna'},
    ])
    await assert.rejects(manager.updateFallbacks(id, ['not-a-model']), /DeepSeek Harness/)
    await assert.rejects(manager.updateFallbacks(id, ['kimi:kimi-a', 'gemini:gemini-a', 'mimo:mimo-v2.6-pro']), /最多选择两个/)
    manager.active.set(id, {cancel: false})
    await assert.rejects(manager.updateFallbacks(id, []), /正在运行/)
    manager.active.delete(id)
    const cleared = await manager.updateFallbacks(id, [])
    assert.equal(cleared.worker.fallbacks, undefined)
    assert.equal(cleared.worker.model, 'mimo-v2.6-flash')
  } finally {
    await fs.rm(root, {recursive: true, force: true})
  }
})


test('stopped transcription changes the worker without touching completed output or budgets', async () => {
  const {root, manager, id} = await fixture()
  try {
    const before = await manager.get(id)
    before.state = 'paused'
    before.worker.fallbacks = [{provider:'kimi',model:'kimi-a'},{provider:'gemini',model:'gemini-a'}]
    before.phaseApproval = {phase:'transcription',workerId:'mimo:mimo-v2.6-flash'}
    await manager.save(before)
    const dir = manager.aiDir(before)
    await fs.mkdir(dir,{recursive:true})
    const files = {'state.json': JSON.stringify({attempts:{1:{used:2},2:{used:1}},finished:false}), 'chapter.md':'completed page', 'worker_audit.jsonl':'existing audit\n'}
    for (const [name,value] of Object.entries(files)) await fs.writeFile(path.join(dir,name),value)
    const saved = await manager.updateWorker(id,'kimi:kimi-a')
    assert.equal(saved.worker.model,'kimi-a')
    assert.deepEqual(saved.worker.fallbacks,[{provider:'gemini',model:'gemini-a'}])
    assert.deepEqual(saved.stages,before.stages)
    assert.deepEqual(saved.log,before.log)
    assert.deepEqual(saved.phaseApproval,before.phaseApproval)
    for (const [name,value] of Object.entries(files)) assert.equal(await fs.readFile(path.join(dir,name),'utf8'),value)
    manager.active.set(id,{cancel:true})
    await assert.rejects(manager.updateWorker(id,'gemini:gemini-a'),/正在运行/)
    manager.active.delete(id)
  } finally {
    await manager.index.close()
    await fs.rm(root,{recursive:true,force:true})
  }
})
