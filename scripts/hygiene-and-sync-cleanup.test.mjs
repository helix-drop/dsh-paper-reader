import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TaskManager } from '../modules/pipeline/tasks.js'
import { buildPublication, commitPublication } from '../modules/pipeline/publication.js'
import { pruneDirByLru, pruneWorkspace, auditWorkspace } from '../modules/pipeline/hygiene.js'
import http from 'node:http'
import { hash, markdownBlocks } from '../modules/pipeline/markdown.js'
import { createSyncServer } from '../sync-server/server.mjs'
import { taskRoutes } from '../modules/pipeline/routes.js'
import { taskSourcePdf } from '../modules/pipeline/source-map.js'
import { attachPdfLocations } from '../modules/pipeline/pdf-location.js'

test('deleted legacy papers and books stay deleted across library(), importPapers(), and importLegacy()', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hygiene-tombstone-'))
  const readingRoot = path.join(root, 'papers')
  await fs.mkdir(readingRoot, { recursive: true })
  await fs.mkdir(path.join(root, 'Book/OldBook'), { recursive: true })

  const paperJson = {
    id: 'hacking-1983-making-up-people',
    status: 'done',
    sourceLanguage: 'en',
    title: { zh: '造就人', source: 'Making Up People' },
    blocks: [
      { id: 'h1', type: 'heading', source: 'Making Up People', text: '造就人' },
      { id: 'p1', type: 'para', source: 'Dynamic nominalism.', text: '动态唯名论。' },
    ],
  }
  const paperFile = path.join(readingRoot, 'hacking-1983-making-up-people.json')
  await fs.writeFile(paperFile, JSON.stringify(paperJson, null, 2))
  await fs.writeFile(path.join(root, 'Book/OldBook/OldBook.pdf'), '%PDF-1.4\n%fake\n')

  const manager = new TaskManager(root, readingRoot)
  try {
    const lib1 = await manager.library()
    assert.equal(lib1.length, 1)
    assert.equal(lib1[0].name, '造就人')
    const paperTaskId = lib1[0].id

    await manager.deleteTask(paperTaskId)
    const lib2 = await manager.library()
    assert.equal(lib2.length, 0, 'library() must not resurrect deleted legacy paper')
    await manager.importPapers()
    assert.equal((await manager.list()).length, 0, 'importPapers() must respect tombstone')
    await fs.access(paperFile)

    const bookImport1 = await manager.importLegacy()
    assert.equal(bookImport1.books.length, 1)
    const bookTaskId = bookImport1.books[0].id
    await manager.deleteTask(bookTaskId)

    const bookImport2 = await manager.importLegacy()
    assert.equal(bookImport2.books.length, 0, 'importLegacy() must not resurrect deleted legacy book')
  } finally {
    await manager.index.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('cloud sync propagates local task deletion and deduplicates identical PDFs by SHA-256', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hygiene-sync-pc-'))
  const cloudData = await fs.mkdtemp(path.join(os.tmpdir(), 'hygiene-sync-cloud-'))
  const readingRoot = path.join(root, 'papers')
  await fs.mkdir(readingRoot, { recursive: true })
  await fs.mkdir(path.join(root, '.pipeline/tasks/uploads'), { recursive: true })

  const sharedPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
  const pdfSha = hash(sharedPdf)
  const pdfPath1 = path.join(root, '.pipeline/tasks/uploads/book1.pdf')
  const pdfPath2 = path.join(root, '.pipeline/tasks/uploads/book2.pdf')
  await fs.writeFile(pdfPath1, sharedPdf)
  await fs.writeFile(pdfPath2, sharedPdf)

  const makeTask = async (id, name, pdfPath, docId) => {
    const dir = path.join(root, '.pipeline/tasks', id)
    await fs.mkdir(path.join(dir, 'document/ai_convert/book'), { recursive: true })
    await fs.mkdir(path.join(dir, 'translation'), { recursive: true })
    const orig = '# Title\n\nParagraph one.\n'
    const trans = '# 标题\n\n第一段。\n'
    const origFile = path.join(dir, 'document/ai_convert/book/orig.md')
    const transFile = path.join(dir, 'translation/translated.md')
    await fs.writeFile(origFile, orig)
    await fs.writeFile(transFile, trans)
    const t = {
      id,
      documentId: docId,
      name,
      kind: 'book',
      input: { id: hash(pdfPath), name: path.basename(pdfPath), type: 'pdf', fingerprint: pdfSha },
      path: pdfPath,
      originalPath: origFile,
      translationPath: transFile,
      translationReport: {
        passed: true,
        sourceFingerprint: hash(orig),
        targetFingerprint: hash(trans),
      },
      publication: { published: true },
      state: 'idle',
      stage: 'publish',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stages: { inspect: { state: 'done' }, assemble: { state: 'done' }, translate: { state: 'done' }, translationCheck: { state: 'done' }, publish: { state: 'done' } },
      bookmarks: [],
      log: [],
    }
    await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(t, null, 2))
  }

  const id1 = '11111111-1111-4111-8111-111111111111'
  const id2 = '22222222-2222-4222-8222-222222222222'
  await makeTask(id1, 'Book One', pdfPath1, 'document:book-1')
  await makeTask(id2, 'Book Two', pdfPath2, 'document:book-2')

  const manager = new TaskManager(root, readingRoot)
  manager.original = async t => t.originalPath
  const { server: cloudServer, token, store } = await createSyncServer({ dataDir: cloudData, token: 'sync-secret' })
  await new Promise(resolve => cloudServer.listen(0, '127.0.0.1', resolve))
  const cloudUrl = `http://127.0.0.1:${cloudServer.address().port}`

  try {
    await manager.saveCloudSync({ cloudUrl, token, includePdf: true, autoSync: false, startBackground: false })
    const res1 = await manager.syncCloud()
    assert.equal(res1.pushedBooks, 2)
    assert.equal(res1.pushedPdfs, 2)
    assert.equal(res1.deduplicatedPdfs, 1, 'second identical PDF in same batch must deduplicate via link-pdf')

    const st1 = await fs.stat(path.join(cloudData, 'books', id1, 'source.pdf'))
    const st2 = await fs.stat(path.join(cloudData, 'books', id2, 'source.pdf'))
    assert.equal(st1.ino, st2.ino, 'cloud PDFs with identical SHA-256 should share inode via blob hardlink')

    // Stale upload cleanup on cloud server
    const stalePart = path.join(cloudData, 'books', id1, 'uploads', 'abandoned.part')
    await fs.mkdir(path.dirname(stalePart), { recursive: true })
    await fs.writeFile(stalePart, 'partial')
    const oldTime = new Date(Date.now() - 48 * 3600 * 1000)
    await fs.utimes(stalePart, oldTime, oldTime)
    const upClean = await store.cleanupStaleUploads()
    assert.equal(upClean.removedFiles, 1)

    // Delete Book One locally and sync -> cloud must delete Book One and keep shared blob for Book Two
    await manager.deleteTask(id1)
    const res2 = await manager.syncCloud()
    assert.equal(res2.deletedCloudBooks, 1)
    const cloudLib = await store.libraryPayload()
    assert.deepEqual(cloudLib.documents.map(d => d.id), [id2])
    await assert.rejects(fs.access(path.join(cloudData, 'books', id1)))
    await fs.access(path.join(cloudData, 'books', id2, 'source.pdf'))

    // Delete Book Two locally and sync -> cloud deletes Book Two and removes orphaned PDF blob
    await manager.deleteTask(id2)
    const res3 = await manager.syncCloud()
    assert.equal(res3.deletedCloudBooks, 1)
    await assert.rejects(fs.access(path.join(cloudData, 'blobs', 'pdfs', `${pdfSha}.pdf`)))
  } finally {
    manager.stopBackgroundSync()
    await manager.index.close()
    cloudServer.close()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(cloudData, { recursive: true, force: true })
  }
})

test('pruneWorkspace, pruneDirByLru, and commitPublication clean intermediate caches without harming active or published artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hygiene-prune-'))
  const readingRoot = path.join(root, 'papers')
  const publishRoot = path.join(root, 'publications')
  await fs.mkdir(readingRoot, { recursive: true })
  await fs.mkdir(publishRoot, { recursive: true })

  // 1. LRU cache eviction
  const lruDir = path.join(root, 'lru-test')
  await fs.mkdir(lruDir, { recursive: true })
  for (let i = 1; i <= 4; i++) {
    const f = path.join(lruDir, `page_${i}_dpi180.png`)
    await fs.writeFile(f, Buffer.alloc(1024, i))
    const ts = new Date(Date.now() - (5 - i) * 60_000)
    await fs.utimes(f, ts, ts)
  }
  const lruRes = await pruneDirByLru(lruDir, { maxBytes: 2048, filePattern: /^page_\d+_dpi\d+\.png$/ })
  assert.equal(lruRes.deletedFiles, 2)
  assert.deepEqual((await fs.readdir(lruDir)).sort(), ['page_3_dpi180.png', 'page_4_dpi180.png'])

  // 2. commitPublication cleans intermediate task/publication bundle after committing to publishRoot
  const doneId = '33333333-3333-4333-8333-333333333333'
  const activeId = '44444444-4444-4444-8444-444444444444'
  const doneDir = path.join(root, '.pipeline/tasks', doneId)
  const activeDir = path.join(root, '.pipeline/tasks', activeId)
  await fs.mkdir(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/attempts/p1'), { recursive: true })
  await fs.mkdir(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/output/evidence'), { recursive: true })
  await fs.mkdir(path.join(doneDir, 'document/ai_convert/page_images'), { recursive: true })
  await fs.mkdir(path.join(doneDir, 'harness-requests'), { recursive: true })
  await fs.mkdir(path.join(doneDir, 'translation'), { recursive: true })
  await fs.mkdir(path.join(doneDir, 'review'), { recursive: true })
  await fs.mkdir(path.join(root, '.pipeline/tasks/uploads'), { recursive: true })
  await fs.mkdir(path.join(activeDir, 'harness-requests'), { recursive: true })

  const activeUpload = path.join(root, '.pipeline/tasks/uploads/active.pdf')
  const orphanUpload = path.join(root, '.pipeline/tasks/uploads/orphan.pdf')
  await fs.writeFile(activeUpload, '%PDF-1.4\nactive\n')
  await fs.writeFile(orphanUpload, '%PDF-1.4\norphan\n')

  const orig = '# Book\n\nBody paragraph.\n'
  const trans = '# 书名\n\n正文段落。\n'
  const origFile = path.join(doneDir, 'document/ai_convert/book/orig.md')
  const transFile = path.join(doneDir, 'translation/translated.md')
  const reviewFile = path.join(doneDir, 'review/report.md')
  await fs.mkdir(path.dirname(origFile), { recursive: true })
  await fs.writeFile(origFile, orig)
  await fs.writeFile(transFile, trans)
  await fs.writeFile(reviewFile, '<!-- dsh-review-status:pass -->\nOK\n')
  await fs.writeFile(path.join(doneDir, 'document/source.pdf'), '%PDF-1.4\nnorm\n')
  await fs.writeFile(path.join(doneDir, 'document/ai_convert/page_images/page_001.png'), 'png')
  await fs.writeFile(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/state.json'), '{}')
  await fs.writeFile(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/attempts/p1/a.json'), 'attempt-blob')
  await fs.writeFile(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/output/evidence/e.json'), 'ev-blob')
  await fs.writeFile(path.join(doneDir, 'harness-requests/req.json'), 'req-blob')
  await fs.writeFile(path.join(activeDir, 'harness-requests/keep.json'), 'active-req')

  const doneTask = {
    id: doneId,
    name: 'Published Book',
    kind: 'book',
    input: { id: 'i1', name: 'active.pdf', type: 'pdf', fingerprint: hash('%PDF-1.4\nactive\n') },
    path: activeUpload,
    translationPath: transFile,
    translationReport: { passed: true, sourceFingerprint: hash(orig), targetFingerprint: hash(trans) },
    review: { status: 'pass', report: reviewFile, reportFingerprint: hash('<!-- dsh-review-status:pass -->\nOK\n'), sourceFingerprint: hash(orig), targetFingerprint: hash(trans) },
    stages: { assemble: { state: 'done' }, translate: { state: 'done' }, translationCheck: { state: 'done' }, review: { state: 'done' } },
    state: 'idle',
    stage: 'publish',
  }
  const activeTask = {
    id: activeId,
    name: 'Running Book',
    kind: 'book',
    input: { id: 'i2', name: 'active.pdf', type: 'pdf', fingerprint: hash('%PDF-1.4\nactive\n') },
    path: activeUpload,
    state: 'running',
    stage: 'transcribe',
    stages: {},
  }
  await fs.writeFile(path.join(doneDir, 'task.json'), JSON.stringify(doneTask, null, 2))
  await fs.writeFile(path.join(activeDir, 'task.json'), JSON.stringify(activeTask, null, 2))

  const manager = new TaskManager(root, readingRoot, { publishRoot })
  manager.original = async t => (t.id === doneId ? origFile : '')
  try {
    doneTask.publication = await buildPublication(manager, doneTask)
    await fs.access(path.join(doneDir, 'publication/原文.md'))
    doneTask.publication = await commitPublication(manager, doneTask, true)
    assert.equal(doneTask.publication.published, true)
    await assert.rejects(fs.access(path.join(doneDir, 'publication')), 'commitPublication must clean intermediate bundle')
    await fs.access(path.join(publishRoot, 'Published Book/原文.md'))
    await fs.writeFile(path.join(doneDir, 'task.json'), JSON.stringify(doneTask, null, 2))

    const audit = await auditWorkspace(manager)
    assert.ok(audit.safeBytes > 0)
    assert.ok(audit.compactBytes >= audit.safeBytes)

    const resSafe = await pruneWorkspace(manager, { mode: 'safe' })
    assert.ok(resSafe.totalBytes > 0)
    await assert.rejects(fs.access(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/attempts')))
    await assert.rejects(fs.access(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/output/evidence')))
    await assert.rejects(fs.access(path.join(doneDir, 'harness-requests')))
    await assert.rejects(fs.access(orphanUpload))
    await fs.access(activeUpload)
    await fs.access(path.join(activeDir, 'harness-requests/keep.json'))
    await fs.access(path.join(doneDir, 'document/ai_convert/delivery/chapter_001/state.json'))
    await fs.access(path.join(doneDir, 'document/ai_convert/page_images/page_001.png'))

    const resCompact = await pruneWorkspace(manager, { mode: 'compact' })
    assert.ok(resCompact.totalBytes > 0)
    await assert.rejects(fs.access(path.join(doneDir, 'document/ai_convert/page_images')))
  } finally {
    await manager.index.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sourceHistory.directory recovers missing source PDF, block pdfPages, and HTTP Range streaming on adopted Markdown tasks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hygiene-pdf-recovery-'))
  const readingRoot = path.join(root, 'papers')
  const bookDir = path.join(root, 'Book/RecoveredBook')
  await fs.mkdir(readingRoot, { recursive: true })
  await fs.mkdir(path.join(bookDir, 'ai_convert/edits/body'), { recursive: true })

  const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
  const pdfFile = path.join(bookDir, 'RecoveredBook.pdf')
  await fs.writeFile(pdfFile, fakePdf)

  const origText = '# Recovered Book\n\nThis opening paragraph comes from page three of the historical conversion.\n'
  const transText = '# 复原书目\n\n这段正文来自历史转写的第三页内容，用于检验页码反查是否正常工作。\n'
  const mdFile = path.join(root, 'input-source.md')
  await fs.writeFile(mdFile, origText)

  const editPage = {
    book_page: 3,
    paragraphs: [
      { text: 'Recovered Book' },
      { text: 'This opening paragraph comes from page three of the historical conversion.' },
    ],
  }
  await fs.writeFile(path.join(bookDir, 'ai_convert/edits/body/page_003.json'), JSON.stringify(editPage))

  const id = '55555555-5555-4555-8555-555555555555'
  const taskDir = path.join(root, '.pipeline/tasks', id)
  const transFile = path.join(taskDir, 'translation/translated.md')
  await fs.mkdir(path.dirname(transFile), { recursive: true })
  await fs.writeFile(transFile, transText)

  const task = {
    id,
    documentId: 'document:recovered-book',
    name: 'RecoveredBook · 接续',
    kind: 'book',
    input: { id: 'md-1', name: 'orig.md', type: 'markdown', fingerprint: hash(origText) },
    path: mdFile,
    sourceHistory: { directory: bookDir, sourcePath: mdFile },
    translationPath: transFile,
    translationReport: { passed: true, sourceFingerprint: hash(origText), targetFingerprint: hash(transText) },
    stages: { inspect: { state: 'done' }, translate: { state: 'done' }, translationCheck: { state: 'done' } },
    bookmarks: [],
    log: [],
    state: 'idle',
    stage: 'publish',
  }
  await fs.writeFile(path.join(taskDir, 'task.json'), JSON.stringify(task, null, 2))

  const manager = new TaskManager(root, readingRoot)
  const routes = taskRoutes(manager, async () => {})
  const server = http.createServer(async (req, res) => {
    const rawUrl = new URL(req.url || '/', 'http://127.0.0.1')
    const cleanUrl = rawUrl.pathname.replace(/^\/api\/paper-reader/, '')
    const route = routes.find(r => r.method === req.method && r.pattern.test(cleanUrl))
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    const match = cleanUrl.match(route.pattern)
    await route.handler(req, res, rawUrl, match)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  try {
    assert.equal(await taskSourcePdf(manager, task), await fs.realpath(pdfFile))
    const origBlocks = markdownBlocks(origText)
    const transBlocks = markdownBlocks(transText).map((b, idx) => ({
      ...b,
      sourceBlockId: origBlocks[idx]?.id ?? null,
      sourceText: origBlocks[idx]?.text ?? '',
      translation: b.text,
    }))
    const located = await attachPdfLocations(manager, task, {
      standaloneView: 'translation',
      originalBlocks: origBlocks,
      blocks: transBlocks,
      outline: [],
    })
    assert.equal(located.pdfAvailable, true)
    assert.equal(located.pdfLocationAvailable, true)
    assert.equal(located.blocks[1].pdfPage, 3)
    assert.equal(located.originalBlocks[1].pdfPage, 3)

    const liveReading = await manager.reading(id)
    assert.equal(liveReading.pdfAvailable, true)
    assert.equal(liveReading.pdfLocationAvailable, true)
    assert.equal(liveReading.blocks[1].pdfPage, 3)

    const fullRes = await fetch(`${baseUrl}/api/paper-reader/pipeline/tasks/${id}/source`)
    assert.equal(fullRes.status, 200)
    assert.deepEqual(Buffer.from(await fullRes.arrayBuffer()), fakePdf)

    const rangeRes = await fetch(`${baseUrl}/api/paper-reader/pipeline/tasks/${id}/source`, {
      headers: { Range: 'bytes=0-8' },
    })
    assert.equal(rangeRes.status, 206)
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-8/${fakePdf.length}`)
    assert.equal(await rangeRes.text(), '%PDF-1.4\n')
  } finally {
    await manager.index.close()
    server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
