import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { TaskManager } from '../modules/pipeline/tasks.js'
import { hash } from '../modules/pipeline/markdown.js'

async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pipeline-test-')))
  const readingRoot = path.join(root, 'reading')
  const publishRoot = path.join(root, 'published')
  await fs.mkdir(readingRoot, { recursive: true })
  await fs.mkdir(publishRoot, { recursive: true })
  const manager = new TaskManager(root, readingRoot, { publishRoot })

  const pdfFile = path.join(root, 'sample.pdf')
  await fs.writeFile(pdfFile, 'dummy pdf content for auto pipeline test')
  const fingerprint = hash('dummy pdf content for auto pipeline test')

  const task = {
    id: randomUUID(),
    name: 'Auto Pipeline Book',
    kind: 'book',
    input: { id: 'src-1', type: 'pdf', name: 'sample.pdf', path: pdfFile, fingerprint },
    path: pdfFile,
    worker: { provider: 'test-provider', model: 'test-model', timeout: 300 },
    state: 'idle',
    stage: 'inspect',
    createdAt: new Date().toISOString(),
    stages: {},
    bookmarks: [],
    phaseApproval:{phase:'transcription',workerId:'test-provider:test-model'},
    log: []
  }

  await fs.mkdir(manager.dir(task.id), { recursive: true })
  await manager.save(task)

  return { root, readingRoot, publishRoot, manager, task, close: () => fs.rm(root, { recursive: true, force: true }) }
}

test('three-confirmation pipeline: auto-chains transcription stage to completion without formal checkpoints', async () => {
  const f = await setup()
  try {
    const executedStages = []
    f.manager.py = async (_t, script, args = []) => {
      if (script === 'document_pipeline.py' && args[0] === 'structure') {
        return JSON.stringify({
          total_pages: 10,
          candidates: [{ id: '001', title: 'Chapter 1', start_page: 1, end_page: 10, note_pages: null }]
        })
      }
      return '{}'
    }
    f.manager.perform = async (t, stage) => {
      executedStages.push(stage)
      if (stage === 'inspect') {
        t.inspection = { fingerprint: t.input.fingerprint, verdict: 'BORN-DIGITAL', pages: 10 }
        t.profile = { language: 'en', book_type:'footnote_only',note_numbering:'per_page',note_location:'per_page_bottom',layout:'single',start_page: 1, end_page: 10 }
        t.profileAnalysis = { status: 'complete', fields: { language: { value: 'en' } } }
      } else if (stage === 'normalize') {
        const docDir = f.manager.docDir(t)
        await fs.mkdir(docDir, { recursive: true })
        await fs.writeFile(path.join(docDir, 'source.pdf'), 'norm pdf')
        await fs.writeFile(path.join(docDir, 'document_profile.json'), '{}')
        t.scope = { pages: 10, fingerprint: hash('norm pdf'), profileFingerprint: hash('{}') }
      } else if (stage === 'assemble') {
        t.sourceMap = { version: 1 }
      } else if (stage === 'glossary') {
        t.glossaryReport = { schemaVersion: 4, status: 'complete', transportVerified: true, cleaningCompleted: true, engine: 'LinguaGacha' }
      }
    }

    // 用户第 1 次确认：丢入 PDF，选择模型，点击开始转写
    await f.manager.start(f.task.id, 'transcribe')
    await f.manager.active.get(f.task.id)?.promise

    const saved = await f.manager.get(f.task.id)
    assert.deepEqual(executedStages, ['inspect', 'normalize', 'images', 'prepare', 'transcribe', 'verify', 'assemble'])
    assert.equal(saved.stages.glossary, undefined)
    assert.equal(saved.state, 'idle')
    assert.match(saved.message, /转写已完成，请在面板选择模型并确认进入术语分析与翻译/)
    assert.equal(saved.profile.confirmed, true)
    assert.equal(saved.structureConfirmed, true)

    // Re-running explicit verify / assemble after fixing edits/body/*.json must execute (never short-circuit as done)
    executedStages.length = 0
    await f.manager.start(f.task.id, 'verify')
    await f.manager.active.get(f.task.id)?.promise
    await f.manager.start(f.task.id, 'assemble')
    await f.manager.active.get(f.task.id)?.promise
    assert.deepEqual(executedStages, ['verify', 'assemble'])
  } finally {
    await f.close()
  }
})

test('task state persistence: pauses during execution and resumes seamlessly from breakpoint', async () => {
  const f = await setup()
  try {
    const docDir = f.manager.docDir(f.task)
    await fs.mkdir(docDir, { recursive: true })
    await fs.writeFile(path.join(docDir, 'source.pdf'), 'norm pdf')
    await fs.writeFile(path.join(docDir, 'document_profile.json'), '{}')

    f.task.inspection = { fingerprint: f.task.input.fingerprint, verdict: 'BORN-DIGITAL', pages: 10 }
    f.task.profile = { language: 'en', start_page: 1, end_page: 10, confirmed: true, source_fingerprint: f.task.input.fingerprint }
    f.task.scope = { pages: 10, fingerprint: hash('norm pdf'), profileFingerprint: hash('{}') }
    f.task.stages = {
      inspect: { state: 'done' },
      normalize: { state: 'done' },
      images: { state: 'done' },
      prepare: { state: 'done' },
      transcribe: { state: 'stopped' }
    }
    f.task.structureConfirmed = true
    f.task.observationConfirmed = true
    await f.manager.save(f.task)

    const executed = []
    f.manager.perform = async (t, stage) => {
      executed.push(stage)
      if (stage === 'glossary') {
        t.glossaryReport = { schemaVersion: 4, status: 'complete', transportVerified: true, cleaningCompleted: true, engine: 'LinguaGacha' }
      }
    }

    // 用户点击继续处理：从停止点 transcribe 继续，跳过已完成的前序步骤
    await f.manager.start(f.task.id, 'transcription')
    await f.manager.active.get(f.task.id)?.promise

    const saved = await f.manager.get(f.task.id)
    assert.deepEqual(executed, ['transcribe', 'verify', 'assemble'])
    assert.equal(saved.stages.transcribe.state, 'done')
    assert.equal(saved.stages.glossary, undefined)
    assert.equal(saved.state, 'idle')
  } finally {
    await f.close()
  }
})

test('three-confirmation pipeline: translation stage auto-chains and awaits third review confirmation', async () => {
  const f = await setup()
  try {
    f.task.inspection = { fingerprint: f.task.input.fingerprint, verdict: 'BORN-DIGITAL', pages: 10 }
    f.task.profile = { language: 'en', start_page: 1, end_page: 10, confirmed: true, source_fingerprint: f.task.input.fingerprint }
    f.task.stages = {
      inspect: { state: 'done' },
      normalize: { state: 'done' },
      images: { state: 'done' },
      prepare: { state: 'done' },
      transcribe: { state: 'done' },
      verify: { state: 'done' },
      assemble: { state: 'done' },
      glossary: { state: 'done' }
    }
    f.task.glossaryReport = { schemaVersion: 4, status: 'complete', transportVerified: true, cleaningCompleted: true, engine: 'LinguaGacha' }
    f.manager.requireGlossary = async () => {}
    await f.manager.save(f.task)

    const executed = []
    f.manager.perform = async (t, stage) => {
      executed.push(stage)
      if (stage === 'translationCheck') {
        t.translationReport = { passed: true, sourceFingerprint: 'src', targetFingerprint: 'dst' }
      }
    }

    // 用户第 2 次确认：术语分析与翻译属于同一次确认。
    f.task.phaseApproval={phase:'translation'};delete f.task.stages.glossary;await f.manager.save(f.task)
    await f.manager.start(f.task.id, 'translate')
    await f.manager.active.get(f.task.id)?.promise

    const saved = await f.manager.get(f.task.id)
    assert.deepEqual(executed, ['glossary','lgProject', 'translate', 'translationCheck'])
    assert.equal(saved.stages.translationCheck.state, 'done')
    assert.equal(saved.state, 'idle')
    assert.match(saved.message, /术语分析、翻译与校验已完成，请在面板选择模型并确认进入审校与发布/)
  } finally {
    await f.close()
  }
})

test('review stops before publication even with legacy combined approval', async () => {
  const f = await setup()
  try {
    f.task.inspection = { fingerprint: f.task.input.fingerprint, verdict: 'BORN-DIGITAL', pages: 10 }
    f.task.profile = { language: 'en', start_page: 1, end_page: 10, confirmed: true, source_fingerprint: f.task.input.fingerprint }
    f.task.stages = {
      inspect: { state: 'done' },
      normalize: { state: 'done' },
      images: { state: 'done' },
      prepare: { state: 'done' },
      transcribe: { state: 'done' },
      verify: { state: 'done' },
      assemble: { state: 'done' },
      glossary: { state: 'done' },
      lgProject: { state: 'done' },
      translate: { state: 'done' },
      translationCheck: { state: 'done' }
    }
    f.task.translationReport = { passed: true, sourceFingerprint: 'src', targetFingerprint: 'dst' }
    f.manager.requireGlossary = async () => {}
    await f.manager.save(f.task)

    const executed = []
    f.manager.perform = async (t, stage) => {
      executed.push(stage)
      if (stage === 'publish') {
        t.publication = { published: true }
      }
    }

    // 旧版合并确认也不能使审校自动进入发布。
    f.task.phaseApproval={phase:'delivery',publishAccepted:true};await f.manager.save(f.task)
    await f.manager.start(f.task.id, 'review')
    await f.manager.active.get(f.task.id)?.promise

    const saved = await f.manager.get(f.task.id)
    assert.deepEqual(executed, ['review'])
    assert.equal(saved.stages.review.state, 'done')
    assert.equal(saved.stages.publish, undefined)
    assert.equal(saved.state, 'idle')
    assert.match(saved.message, /确认发布清单/)
  } finally {
    await f.close()
  }
})

test('pipeline improvement: start() supports translation prepare aliases and maps to lgProject', async () => {
  const f = await setup()
  try {
    f.task.inspection = { fingerprint: f.task.input.fingerprint, verdict: 'BORN-DIGITAL', pages: 10 }
    f.task.profile = { language: 'en', start_page: 1, end_page: 10, confirmed: true, source_fingerprint: f.task.input.fingerprint }
    f.task.stages = {
      inspect: { state: 'done' },
      normalize: { state: 'done' },
      images: { state: 'done' },
      prepare: { state: 'done' },
      transcribe: { state: 'done' },
      verify: { state: 'done' },
      assemble: { state: 'done' },
      glossary: { state: 'done' }
    }
    f.manager.requireGlossary = async () => {}
    await f.manager.save(f.task)

    const executed = []
    f.manager.perform = async (t, stage) => {
      executed.push(stage)
    }

    f.task.phaseApproval={phase:'translation'}
    for (const alias of ['translate_prepare', 'translation_prepare', 'prepare_translation']) {
      delete f.task.stages.lgProject
      await f.manager.save(f.task)
      executed.length = 0
      await f.manager.start(f.task.id, alias, { singleStep: true })
      await f.manager.active.get(f.task.id)?.promise
      assert.deepEqual(executed, ['lgProject'])
      const saved = await f.manager.get(f.task.id)
      assert.equal(saved.stages.lgProject?.state, 'done')
    }
  } finally {
    await f.close()
  }
})

test('pipeline improvement: translateViaCli auto-heals lgProject when lgProject stage is not done', async () => {
  const f = await setup()
  try {
    f.task.inspection = { fingerprint: f.task.input.fingerprint, verdict: 'BORN-DIGITAL', pages: 10 }
    f.task.profile = { language: 'en', start_page: 1, end_page: 10, confirmed: true, source_fingerprint: f.task.input.fingerprint }
    f.task.stages = {
      inspect: { state: 'done' },
      normalize: { state: 'done' },
      images: { state: 'done' },
      prepare: { state: 'done' },
      transcribe: { state: 'done' },
      verify: { state: 'done' },
      assemble: { state: 'done' },
      glossary: { state: 'done' }
    }
    let prepCalled = false
    f.manager.prepareCliTranslation = async (t) => {
      prepCalled = true
      t.cliPreparation = { directory: f.manager.dir(t.id), key: 'dummy-key' }
      t.translationModel = { model: 'mock-model', credentialConfigured: true }
      await fs.writeFile(path.join(t.cliPreparation.directory,'source.md'),'# Source <!--dsh-block:B0001-->\n')
    }
    f.manager.command = async (_t, _cmd, _args, io) => {
      await io.onLine(JSON.stringify({ type: 'finished', status: 'done' }))
    }
    const runsDir = path.join(f.manager.dir(f.task.id), 'runs/1/output')
    await fs.mkdir(runsDir, { recursive: true })
    await fs.writeFile(path.join(runsDir, 'translated.md'), '# Translated')
    f.manager.acceptTranslationOutput = async (_t, text) => {
      const output = path.join(f.manager.dir(f.task.id), 'translation/translated.md')
      await fs.mkdir(path.dirname(output), { recursive: true })
      await fs.writeFile(output, text)
    }
    await f.manager.save(f.task)

    assert.equal(f.task.stages.lgProject, undefined)
    await f.manager.translateViaCli(f.task, {})
    assert.equal(prepCalled, true)
    assert.equal(f.task.stages.lgProject?.state, 'done')
  } finally {
    await f.close()
  }
})


test('incomplete successful analysis blocks the transcription chain before normalize',async()=>{
 const f=await setup()
 try{
  const calls=[];f.manager.perform=async(t,stage)=>{calls.push(stage);t.inspection={fingerprint:t.input.fingerprint,pages:452};t.profile={language:'fr',layout:'single'};t.profileAnalysis={status:'complete',unresolved:['book_type','note_numbering','note_location']}}
  f.manager.py=async()=>{throw new Error('must not invoke validator with incomplete profile')}
  await f.manager.start(f.task.id,'transcribe');await f.manager.active.get(f.task.id)?.promise
  const task=await f.manager.get(f.task.id)
  assert.equal(task.state,'blocked');assert.match(task.message,/注释体例、注释编号方式、注释位置/);assert.deepEqual(calls,['inspect']);assert.notEqual(task.profile.confirmed,true);assert.equal(task.stages.normalize,undefined)
 }finally{await f.close()}
})

test('ensureTextLayerReference passes --force and --raw-only, copies curated structure, and reuses existing raw_pages', async () => {
  const f = await setup()
  try {
    f.task.scope = { pages: 2 }
    const doc = f.manager.docDir(f.task)
    await fs.mkdir(path.join(doc, 'ai_convert'), { recursive: true })
    await fs.writeFile(path.join(doc, 'source.pdf'), 'dummy-pdf')
    await fs.writeFile(path.join(doc, 'document_profile.json'), JSON.stringify({ document_type: 'book', language: 'en' }))
    await fs.writeFile(path.join(doc, 'ai_convert/chapters.json'), JSON.stringify([{ id: '001', title: 'Chapter 1', start_page: 1, end_page: 2, note_pages: [2, 2] }]))
    await fs.writeFile(path.join(doc, 'ai_convert/toc.json'), JSON.stringify([{ title: 'Chapter 1', printed_start: 1, target_pdf_page: 1 }]))
    await fs.writeFile(path.join(doc, 'ai_convert/book_analysis.json'), JSON.stringify({ book_type: 'endnote_only', note_location: 'book_end_notes' }))

    const pyCalls = []
    f.manager.py = async (_t, script, args) => {
      pyCalls.push({ script, args })
      const ref = args[0]
      if (args[1] === 'extract') {
        for (const name of ['raw_pages.json', 'raw_pages_paddle.json', 'raw_pages_mineru.json']) {
          await fs.writeFile(path.join(ref, name), JSON.stringify({ pages: [{ bookPage: 1, markdown: 'p1' }, { bookPage: 2, markdown: 'p2' }] }))
        }
      }
    }

    const refDir = await f.manager.ensureTextLayerReference(f.task)
    assert.ok(refDir)
    assert.deepEqual(pyCalls.map(c => c.args), [
      [refDir, 'prepare', '--force'],
      [refDir, 'extract', '--force', '--raw-only']
    ])
    // Verify curated structure was copied to reference
    const copiedCh = JSON.parse(await fs.readFile(path.join(refDir, 'ai_convert/chapters.json'), 'utf8'))
    assert.deepEqual(copiedCh[0].note_pages, [2, 2])

    // Verify raw_pages files were copied into doc
    for (const name of ['raw_pages.json', 'raw_pages_paddle.json', 'raw_pages_mineru.json']) {
      assert.ok(await fs.stat(path.join(doc, name)))
    }

    // Call again: should reuse existing raw_pages without invoking python
    pyCalls.length = 0
    await f.manager.ensureTextLayerReference(f.task)
    assert.equal(pyCalls.length, 0)
  } finally {
    await f.close()
  }
})
