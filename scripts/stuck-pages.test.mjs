import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {TaskManager, blockedPagesFromReport, stuckPagesFromReports, reopenStuckBudget} from '../modules/pipeline/tasks.js'

test('blockedPagesFromReport extracts both page numbers and page:pid duplicate-anchor locations', () => {
  const pages = blockedPagesFromReport([
    'BLOCKED: anchor [^27] appears in 2 paragraphs (189:p189_1, 197:p197_2). Anchors must be chapter-wide unique.',
    'BLOCKED: marker_review page 189 repeated_printed_label',
    'WARNING: page 200 volume low'
  ])
  assert.deepEqual(pages, [189, 197])
})

test('stuck pages are exhausted pages in chapters that have not passed', () => {
  const pages = stuckPagesFromReports([
    {
      chapterId: '010',
      quality: 'pending',
      attempts: {
        '21': {models_exhausted: true, used: 1, history: [{error_message: 'page 21 content hash differs', model_failures: [{model: 'grok-4.7'}, {model: 'mimo-v2.6-pro'}]}]},
        '22': {models_exhausted: false, used: 1, history: []},
        note: {models_exhausted: true, history: [{error_message: 'not a page'}]}
      }
    },
    {
      chapterId: '011',
      quality: 'program_checks_passed',
      attempts: {'59': {models_exhausted: true, used: 1, history: [{failure_kind: 'timeout'}]}}
    },
    {
      chapterId: '004',
      quality: 'program_checks_passed',
      attempts: {'10': {models_exhausted: true, used: 2, history: [{error_message: 'regional_repair_requires_a_recorded_finding'}]}}
    }
  ])
  assert.deepEqual(pages, [{
    chapterId: '010',
    page: 21,
    reason: 'page 21 content hash differs',
    models: ['grok-4.7', 'mimo-v2.6-pro']
  }])
})

test('reopen clears exhaustion once and keeps a single remaining round', () => {
  const kept = {models_exhausted: true, used: 1, last_failed: false, history: [{models_exhausted: true, error_message: 'AUTH 401'}]}
  assert.equal(reopenStuckBudget(kept), true)
  assert.equal(kept.models_exhausted, false)
  assert.equal(kept.used, 1)
  assert.equal(kept.last_failed, true)
  assert.equal(kept.history[0].models_exhausted, false)

  const clamped = {models_exhausted: true, used: 2, history: [{models_exhausted: true}, {models_exhausted: true}]}
  assert.equal(reopenStuckBudget(clamped), true)
  assert.equal(clamped.used, 1)
  assert.equal(clamped.last_failed, true)
  assert.equal(clamped.history[0].models_exhausted, true)
  assert.equal(clamped.history[1].models_exhausted, false)

  const rejected = {models_exhausted: false, used: 2, last_failed: false, history: [{state: 'retained_previous', models_exhausted: false}]}
  assert.equal(reopenStuckBudget(rejected), true)
  assert.equal(rejected.used, 1)
  assert.equal(rejected.last_failed, true)
  assert.equal(rejected.models_exhausted, false)
  assert.equal(rejected.history[0].models_exhausted, false)
  assert.equal(reopenStuckBudget({models_exhausted: false, used: 1}), false)
  assert.equal(reopenStuckBudget(null), false)
})

test('an OCR fallback page stays retryable after its chapter has passed', () => {
  const pages = stuckPagesFromReports([
    {
      chapterId: '011',
      quality: 'program_checks_passed',
      attempts: {
        '59': {models_exhausted: true, used: 1, fallback_applied: 'ocr_layout_cleaned', history: [{error_message: 'TIMEOUT: pi-ai stream idle timeout after 300000ms', calls: [{model: 'grok-4.7'}]}]},
        '82': {models_exhausted: false, used: 1, history: []}
      }
    },
    {
      chapterId: '004',
      quality: 'program_checks_passed',
      attempts: {'10': {models_exhausted: true, used: 2, history: [{error_message: 'regional_repair_requires_a_recorded_finding'}]}}
    }
  ])
  assert.deepEqual(pages, [{
    chapterId: '011',
    page: 59,
    reason: 'TIMEOUT: pi-ai stream idle timeout after 300000ms',
    models: ['grok-4.7']
  }])
})

test('a rejected OCR copy stays listed after the chapter has passed', () => {
  const pages = stuckPagesFromReports([{
    chapterId: '011',
    quality: 'program_checks_passed',
    attempts: {
      '59': {models_exhausted: false, used: 2, fallback_applied: 'ocr_layout_cleaned', history: [{state: 'retained_previous', reason: 'native_text_contradiction', calls: [{model: 'grok-4.7'}]}]},
      '60': {models_exhausted: false, used: 2, fallback_applied: 'ocr_layout_cleaned', history: [{state: 'selected'}]}
    }
  }])
  assert.deepEqual(pages, [{
    chapterId: '011',
    page: 59,
    reason: 'native_text_contradiction',
    models: ['grok-4.7']
  }])
})

test('a rejected BLOCKED page with a spent round stays retryable, other repair pages do not', () => {
  const pages = stuckPagesFromReports([
    {
      chapterId: '010',
      quality: 'pending',
      blockedPages: [21],
      attempts: {
        '21': {models_exhausted: false, used: 2, history: [{state: 'retained_previous', outcome: 'candidate_rejected', reason: 'new_structural_or_evidence_failure', calls: [{model: 'grok-4.7'}]}]},
        '51': {models_exhausted: false, used: 2, history: [{state: 'retained_previous', outcome: 'candidate_rejected'}]}
      }
    },
    {
      chapterId: '011',
      quality: 'program_checks_passed',
      blockedPages: [59],
      attempts: {'59': {models_exhausted: false, used: 2, history: [{state: 'retained_previous'}]}}
    }
  ])
  assert.deepEqual(pages, [{
    chapterId: '010',
    page: 21,
    reason: 'new_structural_or_evidence_failure',
    models: ['grok-4.7']
  }])
})

test('retry uses only the chosen model on stuck pages and leaves the task worker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-stuck-'))
  const manager = new TaskManager(root, path.join(root, 'reading'))
  const id = randomUUID()
  const worker = {
    provider: 'opencode-go',
    model: 'muse-spark',
    timeout: 600,
    fallbacks: [{provider: 'xiaomi', model: 'mimo-v2.6-pro'}]
  }
  const task = {
    id, name: 'Stuck fixture', kind: 'book', state: 'blocked', stage: 'verify',
    input: {type: 'pdf', fingerprint: 'abc'}, path: path.join(root, 'source.pdf'),
    worker, stages: {transcribe: {state: 'blocked'}, verify: {state: 'blocked'}},
    phaseApproval: {phase: 'transcription', workerId: 'opencode-go:muse-spark', fallbacks: worker.fallbacks},
    bookmarks: [], log: []
  }
  await fs.mkdir(manager.dir(id), {recursive: true})
  await fs.writeFile(path.join(manager.dir(id), 'task.json'), JSON.stringify(task))
  const chapterDir = (chapter) => path.join(manager.aiDir(task), 'delivery', `chapter_${chapter}`)
  const writeChapter = async (chapter, state, quality) => {
    const dir = chapterDir(chapter)
    await fs.mkdir(path.join(dir, 'output'), {recursive: true})
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state))
    await fs.writeFile(path.join(dir, 'output/report.json'), JSON.stringify({
      quality_status: quality,
      input_protocol: {required: true, unverified_pages: []},
      errors: quality === 'program_checks_passed' ? [] : ['BLOCKED: page 21 content hash differs from accepted audit record']
    }))
  }
  const stuck = {
    finished: true,
    attempts: {
      '21': {used: 1, models_exhausted: true, last_failed: false, history: [{models_exhausted: true, error_message: 'AUTH 401', model_failures: [{model: 'grok-4.7'}]}]},
      '20': {used: 1, models_exhausted: false, last_failed: false, history: [{outcome: 'kept'}]}
    }
  }
  const passed = {finished: true, attempts: {'59': {used: 2, models_exhausted: true, last_failed: true, history: [{models_exhausted: true}]}}}
  await writeChapter('010', stuck, 'pending')
  await writeChapter('011', passed, 'program_checks_passed')
  const occupied = path.join(chapterDir('010'), 'attempts', 'page_021_round_2', 'book')
  await fs.mkdir(occupied, {recursive: true})
  await fs.writeFile(path.join(occupied, 'marker.txt'), 'keep')
  const passedBefore = await fs.readFile(path.join(chapterDir('011'), 'state.json'), 'utf8')
  try {
    await assert.rejects(manager.retryStuckPages(id, 'not-a-model'), /DeepSeek Harness/)
    assert.equal(JSON.parse(await fs.readFile(path.join(chapterDir('010'), 'state.json'), 'utf8')).attempts['21'].models_exhausted, true)
    const calls = []
    manager.py = async (_t, script, args, io) => {
      calls.push({script, args, io})
      const state = JSON.parse(await fs.readFile(path.join(chapterDir('010'), 'state.json'), 'utf8'))
      assert.equal(state.attempts['21'].models_exhausted, false)
      assert.equal(state.attempts['21'].last_failed, true)
      assert.equal(state.attempts['21'].used, 1)
      assert.equal(state.attempts['20'].models_exhausted, false)
      assert.equal(state.attempts['20'].last_failed, false)
      const names = await fs.readdir(path.join(chapterDir('010'), 'attempts'))
      const retired = names.find(name => name.startsWith('page_021_round_2.previous-'))
      assert.ok(retired)
      assert.equal(await fs.readFile(path.join(chapterDir('010'), 'attempts', retired, 'book', 'marker.txt'), 'utf8'), 'keep')
    }
    manager.command = async () => { throw new Error('verify_deliveries.py 未通过，退出码 1') }
    const started = await manager.retryStuckPages(id, 'deepseek-official:deepseek-flash')
    assert.equal(started.state, 'running')
    assert.equal(started.worker.model, 'muse-spark')
    await manager.active.get(id).promise
    assert.equal(calls.length, 1)
    assert.match(calls[0].script, /bounded_chapter\.py$/)
    assert.deepEqual(calls[0].io, {models: [{provider: 'deepseek-official', model: 'deepseek-flash'}]})
    assert.ok(!calls[0].args.includes('--fallback'))
    const pagesAt = calls[0].args.indexOf('--pages')
    assert.equal(calls[0].args[pagesAt + 1], '21')
    assert.equal(calls[0].args[calls[0].args.indexOf('--provider') + 1], 'deepseek-official')
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'deepseek-flash')
    assert.equal(calls[0].args[calls[0].args.indexOf('--chapter') + 1], '010')
    const saved = await manager.get(id)
    assert.equal(saved.state, 'blocked')
    assert.equal(saved.stage, 'verify')
    assert.equal(saved.worker.provider, 'opencode-go')
    assert.equal(saved.worker.model, 'muse-spark')
    assert.deepEqual(saved.worker.fallbacks, worker.fallbacks)
    assert.equal(saved.phaseApproval.workerId, 'opencode-go:muse-spark')
    assert.match(saved.message, /章节 010 未通过程序验收/)
    assert.equal(await fs.readFile(path.join(chapterDir('011'), 'state.json'), 'utf8'), passedBefore)
    assert.equal((await manager.listStuckPages(saved)).length, 0)
    await assert.rejects(manager.retryStuckPages(id, 'deepseek-official:deepseek-flash'), /没有模型已耗尽/)
  } finally {
    await manager.index.close()
    await fs.rm(root, {recursive: true, force: true})
  }
})
