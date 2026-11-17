import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {installPipelineModule} from '../modules/pipeline/index.js'

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reader-reset-')))
  const taskId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
  const taskDirectory = path.join(root, '.pipeline/tasks', taskId)
  const aiDir = path.join(taskDirectory, 'document/ai_convert')
  await fs.mkdir(aiDir, {recursive: true})

  // Mock transcription artifacts
  await fs.mkdir(path.join(aiDir, 'delivery/chapter_001'), {recursive: true})
  await fs.writeFile(path.join(aiDir, 'delivery/chapter_001/state.json'), JSON.stringify({chapter: '001'}))
  await fs.mkdir(path.join(aiDir, 'harness-requests'), {recursive: true})
  await fs.writeFile(path.join(aiDir, 'harness-requests/req_01.json'), '{}')
  await fs.writeFile(path.join(aiDir, 'worker_audit.jsonl'), '{"birth":1}\n')
  await fs.mkdir(path.join(aiDir, 'chapters'), {recursive: true})
  await fs.writeFile(path.join(aiDir, 'chapters/001.md'), '# Chapter 1')
  await fs.writeFile(path.join(aiDir, 'chapters.json'), '[{"id":"001","title":"Intro","start_page":1,"end_page":10}]')
  await fs.writeFile(path.join(aiDir, 'toc.json'), '[{"title":"Intro","target_pdf_page":1,"role_hint":"chapter"}]')

  const now = new Date().toISOString()
  const task = {
    id: taskId,
    name: 'sample.pdf',
    kind: 'book',
    state: 'blocked',
    stage: 'transcribe',
    path: path.join(taskDirectory, 'document.pdf'),
    input: {type: 'pdf', path: path.join(taskDirectory, 'document.pdf')},
    stages: {
      inspect: {state: 'done'},
      normalize: {state: 'done'},
      images: {state: 'done'},
      prepare: {state: 'done'},
      transcribe: {state: 'blocked', failure: 'Some error'}
    },
    structureConfirmed: true,
    observationConfirmed: true,
    phaseApproval: {phase: 'transcription'},
    createdAt: now,
    updatedAt: now,
    log: []
  }
  await fs.writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify(task, null, 2))
  await fs.writeFile(path.join(taskDirectory, 'sessions.json'), JSON.stringify({
    sessions: { orchestrator: 'session-old-123' },
    recorded: { 'rec-1': true }
  }))
  await fs.writeFile(path.join(taskDirectory, 'execution-events.jsonl'), '{"text":"old event"}\n')

  const manager = new TaskManager(root, root)
  return {
    root,
    taskId,
    taskDirectory,
    aiDir,
    manager,
    close: () => fs.rm(root, {recursive: true, force: true})
  }
}

test('resetTranscription purges deliveries, harness logs, and markdowns while preserving structure by default', async () => {
  const f = await fixture()
  try {
    const updated = await f.manager.resetTranscription(f.taskId, {cleanChapters: false})
    assert.equal(updated.state, 'ready')
    assert.equal(updated.stage, 'prepare')
    assert.equal(updated.stages.transcribe, undefined)
    assert.equal(updated.stages.images.state, 'done')

    // Verify delivery and requests are gone
    await assert.rejects(fs.access(path.join(f.aiDir, 'delivery')))
    await assert.rejects(fs.access(path.join(f.aiDir, 'harness-requests')))
    await assert.rejects(fs.access(path.join(f.aiDir, 'worker_audit.jsonl')))
    await assert.rejects(fs.access(path.join(f.aiDir, 'chapters/001.md')))

    // Verify chapters.json is preserved
    const chapters = JSON.parse(await fs.readFile(path.join(f.aiDir, 'chapters.json'), 'utf8'))
    assert.equal(chapters.length, 1)
    assert.equal(updated.structureConfirmed, true)

    // Verify session context is cleared
    const sess = JSON.parse(await fs.readFile(path.join(f.taskDirectory, 'sessions.json'), 'utf8'))
    assert.deepEqual(sess.sessions, {})
    assert.equal(sess.previousSessions.orchestrator, 'session-old-123')
    const events = await fs.readFile(path.join(f.taskDirectory, 'execution-events.jsonl'), 'utf8')
    assert.equal(events, '')
  } finally {
    await f.close()
  }
})

test('resetTranscription with cleanChapters purges chapters and resets structureConfirmed', async () => {
  const f = await fixture()
  try {
    const updated = await f.manager.resetTranscription(f.taskId, {cleanChapters: true})
    assert.equal(updated.state, 'ready')
    assert.equal(updated.stage, 'prepare')
    assert.equal(updated.structureConfirmed, false)
    assert.equal(updated.observationConfirmed, false)

    await assert.rejects(fs.access(path.join(f.aiDir, 'chapters.json')))
    await assert.rejects(fs.access(path.join(f.aiDir, 'toc.json')))
  } finally {
    await f.close()
  }
})

test('document_pipeline dispatches reset_transcription action', async () => {
  const f = await fixture()
  try {
    let toolDefinition
    const ctx = {
      tools: {
        register: def => { if (def.name === 'document_pipeline') toolDefinition = def },
        guard: () => {},
        presentAs: () => {},
        view: () => ({restrictableNames: []}),
        restrict: () => {}
      },
      on: () => {},
      inject: () => {}
    }
    const sessionId = 'session-reset-test'
    const taskSessionsFile = path.join(f.root, '.pipeline/dsh-task-sessions.json')
    await fs.mkdir(path.dirname(taskSessionsFile), {recursive: true})
    await fs.writeFile(taskSessionsFile, JSON.stringify({[sessionId]: f.taskId}))

    installPipelineModule(ctx, {pipelineWorkspace: f.root})

    // Mock session header
    const exec = {agent: {session: {id: sessionId, header: {cwd: f.root, agentPreset: 'reading-document'}}}}

    const result = await toolDefinition.execute({action: 'reset_transcription'}, exec)
    assert.equal(result.state, 'ready')
    assert.equal(result.stages.transcribe, undefined)
  } finally {
    await f.close()
  }
})

test('resetTranscription clears blocked prepare stage so workflow can restart prepare', async () => {
  const f = await fixture()
  try {
    const raw = JSON.parse(await fs.readFile(path.join(f.taskDirectory, 'task.json'), 'utf8'))
    raw.stages.prepare = { state: 'blocked' }
    raw.stage = 'prepare'
    raw.state = 'blocked'
    await fs.writeFile(path.join(f.taskDirectory, 'task.json'), JSON.stringify(raw, null, 2))

    const updated = await f.manager.resetTranscription(f.taskId, { cleanChapters: false })
    assert.equal(updated.state, 'ready')
    assert.equal(updated.stage, 'prepare')
    assert.equal(updated.stages.prepare, undefined)
  } finally {
    await f.close()
  }
})
