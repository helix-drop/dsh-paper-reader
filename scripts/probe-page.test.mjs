import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {sessionGuard} from '../modules/pipeline/guard.js'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {spawnSync} from 'node:child_process'

async function createTestPdf(filePath) {
  const code = `
import pymupdf
doc = pymupdf.open()
p1 = doc.new_page(width=595, height=842)
p1.insert_text((50, 72), 'Title: Introduction to Philosophy\\nChapter 1: The Self\\nWho says I in us?')
p2 = doc.new_page(width=595, height=842)
p2.insert_text((50, 72), 'Notes and References\\n1. Arnaud, C. 2006.\\n2. Grasset publication.')
doc.save('${filePath}')
`
  const res = spawnSync('/opt/homebrew/bin/python3', ['-c', code])
  if (res.status !== 0) throw new Error(res.stderr.toString())
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reader-probe-')))
  const taskId = '11111111-2222-4333-8444-555555555555'
  const taskDirectory = path.join(root, '.pipeline/tasks', taskId)
  await fs.mkdir(taskDirectory, {recursive: true})
  const pdfFile = path.join(taskDirectory, 'document.pdf')
  await createTestPdf(pdfFile)

  const now = new Date().toISOString()
  const task = {
    id: taskId,
    name: 'document.pdf',
    kind: 'book',
    state: 'queued',
    stage: 'inspect',
    path: pdfFile,
    input: {type: 'pdf', path: pdfFile},
    stages: {},
    phaseApproval: {phase: 'transcription'},
    createdAt: now,
    updatedAt: now,
    log: []
  }
  await fs.writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify(task, null, 2))

  const manager = new TaskManager(root, root)
  return {
    root,
    taskDirectory,
    pdfFile,
    task,
    manager,
    close: () => fs.rm(root, {recursive: true, force: true})
  }
}

test('probe_page extracts text layer and renders page images within task probe-pages', async () => {
  const f = await fixture()
  try {
    const res = await f.manager.probePage(f.task.id, {page: 2})
    assert.equal(res.totalPages, 2)
    assert.equal(res.count, 1)
    const p2 = res.pages[0]
    assert.equal(p2.page, 2)
    assert.equal(p2.hasText, true)
    assert.ok(p2.text.includes('Notes and References'))
    assert.ok(p2.headings.includes('Notes and References'))
    assert.ok(await fs.stat(p2.imagePath))
    assert.ok(p2.imagePath.includes('probe-pages'))

    // Batch probing up to 8 pages
    const multi = await f.manager.probePage(f.task.id, {pages: [1, 2]})
    assert.equal(multi.count, 2)
    assert.equal(multi.pages[0].page, 1)
    assert.ok(multi.pages[0].text.includes('Chapter 1'))

    // Page out of bounds rejects
    await assert.rejects(f.manager.probePage(f.task.id, {page: 5}), /超出文档总页数/)

    // Max 8 pages enforced
    await assert.rejects(f.manager.probePage(f.task.id, {pages: [1, 2, 3, 4, 5, 6, 7, 8, 9]}), /1 到 8 个/);
  } finally {
    await f.close()
  }
})

test('probe_page and rendered images pass sessionGuard for orchestrator and observers', async () => {
  const f = await fixture()
  try {
    const header = {cwd: f.root, agentPreset: 'reading-document'}

    // Observer subagent can call probe_page
    const subagentExec = {
      name: 'document_pipeline',
      arguments: {action: 'probe_page', page: 1},
      agent: {session: {header: {...header, origin: 'subagent', delegationDepth: 1}}}
    }
    assert.equal(sessionGuard(f.root, subagentExec, {taskDirectory: f.taskDirectory}), undefined)

    // Also supports probe alias
    subagentExec.arguments.action = 'probe'
    assert.equal(sessionGuard(f.root, subagentExec, {taskDirectory: f.taskDirectory}), undefined)

    // Reading rendered image via read_image inside taskDirectory is allowed
    const imgPath = path.join(f.taskDirectory, 'probe-pages/page_0001.png')
    await fs.mkdir(path.dirname(imgPath), {recursive: true})
    await fs.writeFile(imgPath, 'fake-png')
    const imgExec = {
      name: 'read_image',
      arguments: {path: imgPath},
      agent: {session: {header}}
    }
    assert.equal(sessionGuard(f.root, imgExec, {taskDirectory: f.taskDirectory}), undefined)
  } finally {
    await f.close()
  }
})

test('registered document_pipeline dispatches probe_page', async () => {
  const f = await fixture()
  const disposers = []
  try {
    const {installPipelineModule} = await import('../modules/pipeline/index.js')
    const sessionId = 'session-probe-test'
    await fs.mkdir(path.join(f.root, '.pipeline'), {recursive: true})
    await fs.writeFile(path.join(f.root, '.pipeline/dsh-task-sessions.json'), JSON.stringify({[sessionId]: f.task.id}))

    let definition
    const ctx = {
      inject: () => {},
      on: (event, fn) => { if (event === 'dispose') disposers.push(fn) },
      tools: {
        guard: () => {},
        register: d => { definition = d }
      }
    }
    installPipelineModule(ctx, {pipelineWorkspace: f.root})

    assert.ok(definition.parameters.properties.action.enum.includes('probe_page'))
    assert.ok(definition.parameters.properties.action.enum.includes('probe'))

    const exec = {agent: {session: {id: sessionId, header: {cwd: f.root, agentPreset: 'reading-document'}}}}
    const res = await definition.execute({action: 'probe_page', page: 1}, exec)
    assert.equal(res.taskId, f.task.id)
    assert.equal(res.pages[0].page, 1)
    assert.ok(res.pages[0].text.includes('Introduction'))
  } finally {
    for (const d of disposers) await d()
    await f.close()
  }
})
