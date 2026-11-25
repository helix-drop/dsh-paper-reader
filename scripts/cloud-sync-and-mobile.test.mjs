import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { ReadingProgressStore } from '../modules/pipeline/reading-progress.js'
import { BookmarkStore } from '../modules/pipeline/bookmarks.js'
import { TaskManager } from '../modules/pipeline/tasks.js'
import { taskRoutes } from '../modules/pipeline/routes.js'
import { createSyncServer } from '../sync-server/server.mjs'
import {
  computeViewportLayout,
  renderBlockBodyHtml,
  resolveSwipeDecision,
  resolveTapZoneAction,
  footnoteDisplayNumbers,
  extractGlossaryHits,
  validateCorrectionMarkers,
  WEREAD_THEMES,
  WEREAD_FONTS,
  WEREAD_SPACING_PRESETS,
  resolveFontStack,
  bookCoverPalette,
} from '../mobile-app/www/js/reading-core.js'

async function startHttpRoutes(routes) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const rest = url.pathname.slice('/api/paper-reader'.length) || '/'
    for (const r of routes) {
      if (r.method !== req.method) continue
      const m = rest.match(r.pattern)
      if (m) {
        try {
          return await r.handler(req, res, url, m)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
          return
        }
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` }
}

test('ReadingProgressStore persists LWW updates and merges multi-device entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-test-'))
  try {
    const store = new ReadingProgressStore(path.join(dir, 'progress.json'))
    const r1 = await store.put({
      documentId: 'doc:1',
      blockId: 'b2',
      percent: 45,
      view: 'translation',
      deviceName: 'Phone',
      updatedAt: 2000,
    })
    assert.equal(r1.saved, true)

    const stale = await store.put({
      documentId: 'doc:1',
      blockId: 'b1',
      percent: 10,
      deviceName: 'PC',
      updatedAt: 1000,
    })
    assert.equal(stale.saved, false)
    assert.equal(stale.conflict, true)
    assert.equal((await store.get('doc:1')).blockId, 'b2')

    const merged = await store.merge({
      'doc:1': { documentId: 'doc:1', blockId: 'b5', percent: 80, updatedAt: 3000, deviceName: 'Hanwang' },
      'doc:2': { documentId: 'doc:2', blockId: 'b1', percent: 12, updatedAt: 1500, deviceName: 'Phone' },
    })
    assert.equal(merged.merged, 2)
    assert.equal((await store.get('doc:1')).deviceName, 'Hanwang')
    assert.equal((await store.get('doc:2')).percent, 12)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('BookmarkStore sync merge respects deletion tombstones without resurrecting removed items', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-sync-'))
  try {
    const storeA = new BookmarkStore(path.join(dir, 'a.json'))
    const storeB = new BookmarkStore(path.join(dir, 'b.json'))
    const doc = {
      id: 'doc:bm',
      title: 'Test Book',
      kind: 'book',
      source: { kind: 'task', id: 'task-1' },
      version: 'v1',
      blocks: [{ id: 'b1', text: 'First paragraph about phenomenology and ontology.' }],
    }

    const mark = await storeA.add(doc, {
      selection: { startBlockId: 'b1', endBlockId: 'b1', exact: 'phenomenology and ontology', view: 'original' },
      comment: 'Key concept',
      tags: ['philosophy'],
    })

    // Sync A -> B
    await storeB.mergeState(await storeA.exportState())
    assert.equal((await storeB.list()).length, 1)

    // Delete on B
    await storeB.remove(mark.id)
    assert.equal((await storeB.list()).length, 0)

    // Sync B -> A should remove on A via tombstone
    await storeA.mergeState(await storeB.exportState())
    assert.equal((await storeA.list()).length, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('PC TaskManager <-> Cloud Sync Server end-to-end bidirectional sync (books, assets, progress, bookmarks, mobile corrections)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-pc-'))
  const cloudData = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-cloud-'))
  const readingRoot = path.join(root, 'papers')
  await fs.mkdir(readingRoot, { recursive: true })
  await fs.mkdir(path.join(root, 'Book/DemoBook'), { recursive: true })

  // 1x1 PNG pixel for asset sync check
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  await fs.writeFile(path.join(root, 'Book/DemoBook/fig1.png'), pngBytes)
  const srcMd = '# Demo Title\n\nFirst source paragraph[^1].\n\n![Figure](fig1.png)\n\n[^1]: Source note.\n'
  const dstMd = '# 示例标题\n\n第一段译文内容[^1]。\n\n![图一](fig1.png)\n\n[^1]: 译文注释。\n'
  const srcPath = path.join(root, 'Book/DemoBook/orig.md')
  const dstPath = path.join(root, 'Book/DemoBook/trans.md')
  await fs.writeFile(srcPath, srcMd, 'utf8')
  await fs.writeFile(dstPath, dstMd, 'utf8')

  const taskId = '11111111-1111-4111-8111-111111111111'
  const taskDir = path.join(root, '.pipeline/tasks', taskId)
  await fs.mkdir(taskDir, { recursive: true })
  const { hash } = await import('../modules/pipeline/markdown.js')
  const taskJson = {
    id: taskId,
    documentId: 'document:demo-1',
    name: 'Demo Bilingual Book',
    kind: 'book',
    input: { id: 'src-1', name: 'orig.md', type: 'markdown', fingerprint: hash(srcMd) },
    path: srcPath,
    translationPath: dstPath,
    translationReport: {
      passed: true,
      sourceFingerprint: hash(srcMd),
      targetFingerprint: hash(dstMd),
    },
    publication: { published: true },
    state: 'idle',
    stage: 'publish',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages: { inspect: { state: 'done' }, translate: { state: 'done' }, translationCheck: { state: 'done' }, publish: { state: 'done' } },
    bookmarks: [],
    log: [],
  }
  await fs.writeFile(path.join(taskDir, 'task.json'), JSON.stringify(taskJson, null, 2))

  const manager = new TaskManager(root, readingRoot)
  const pcRoutes = taskRoutes(manager, async () => {})
  const { server: pcServer, baseUrl: pcUrl } = await startHttpRoutes(pcRoutes)
  const { server: cloudServer, token } = await createSyncServer({ dataDir: cloudData, token: 'test-secret-token' })
  await new Promise(resolve => cloudServer.listen(0, '127.0.0.1', resolve))
  const cloudPort = cloudServer.address().port
  const cloudUrl = `http://127.0.0.1:${cloudPort}`

  try {
    // Unauthorized request must fail with 401
    const unauth = await fetch(`${cloudUrl}/api/paper-reader/pipeline/library`)
    assert.equal(unauth.status, 401)

    // Configure PC sync (without auto-starting background job so we can assert explicit sync1 below)
    const cfgRes = await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudUrl, token, deviceName: 'PC Test', includePdf: false, startBackground: false }),
    })
    assert.equal(cfgRes.status, 200)
    const cfgJson = await cfgRes.json()
    assert.equal(cfgJson.configured, true)
    assert.equal(cfgJson.hasToken, true)

    const sync1Res = await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/now`, { method: 'POST' })
    const sync1 = await sync1Res.json()
    assert.equal(sync1Res.status, 200, JSON.stringify(sync1))
    assert.equal(sync1.ok, true, JSON.stringify(sync1))
    assert.equal(sync1.pushedBooks, 1)

    const pcSearchRes = await fetch(`${pcUrl}/api/paper-reader/pipeline/search?q=${encodeURIComponent('第一段译文')}`)
    assert.equal(pcSearchRes.status, 200)
    const pcSearch = await pcSearchRes.json()
    assert.equal(pcSearch.totalBooks, 1)
    assert.ok(pcSearch.totalMatches >= 1)
    assert.equal(pcSearch.results[0].matches[0].view, 'translation')

    // Mobile/Hanwang reads library, reading, and asset from cloud
    const authHeaders = { authorization: `Bearer ${token}` }
    const cloudLib = await (await fetch(`${cloudUrl}/api/paper-reader/pipeline/library`, { headers: authHeaders })).json()
    assert.equal(cloudLib.documents.length, 1)
    assert.equal(cloudLib.documents[0].id, taskId)

    const cloudReading = await (await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${taskId}/reading`, { headers: authHeaders })).json()
    assert.equal(cloudReading.title, 'Demo Bilingual Book')

    const assetRes = await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${taskId}/asset?path=${encodeURIComponent('fig1.png')}`, { headers: authHeaders })
    assert.equal(assetRes.status, 200)
    assert.deepEqual(Buffer.from(await assetRes.arrayBuffer()), pngBytes)

    // Mobile saves reading progress, bookmark, and paragraph correction on cloud
    const targetBlock = cloudReading.blocks[1]
    await fetch(`${cloudUrl}/api/paper-reader/pipeline/progress`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: cloudReading.documentId,
        taskId,
        blockId: targetBlock.id,
        percent: 65,
        view: 'translation',
        deviceName: '汉王N10',
        updatedAt: Date.now() + 5000,
      }),
    })

    await fetch(`${cloudUrl}/api/paper-reader/pipeline/bookmarks`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { kind: 'task', id: taskId },
        selection: {
          startBlockId: targetBlock.id,
          endBlockId: targetBlock.id,
          exact: '第一段译文内容',
          view: 'translation',
        },
        comment: '手机端批注',
        tags: ['移动精读'],
      }),
    })

    const corrRes = await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${taskId}/corrections`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        blockId: targetBlock.id,
        view: 'translation',
        version: cloudReading.version,
        text: '第一段译文修订版内容[^1]。',
        reason: '修正措辞',
        deviceName: '汉王N10',
      }),
    })
    assert.equal(corrRes.status, 200)

    // PC runs sync again -> pulls progress, bookmark, and correction back to PC!
    const sync2 = await (await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/now`, { method: 'POST' })).json()
    assert.equal(sync2.ok, true)
    assert.equal(sync2.pulledProgress, 1)
    assert.equal(sync2.appliedCorrections, 1)

    const pcProg = await (await fetch(`${pcUrl}/api/paper-reader/pipeline/progress?documentId=${encodeURIComponent(cloudReading.documentId)}`)).json()
    assert.equal(pcProg.entry.deviceName, '汉王N10')
    assert.equal(pcProg.entry.percent, 65)

    // Batch progress migration via { items: [...] } preserves newer entries and merges older missing ones
    const batchRes = await fetch(`${pcUrl}/api/paper-reader/pipeline/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { documentId: cloudReading.documentId, percent: 10, updatedAt: 1000, deviceName: 'Old Local' },
          { documentId: 'document:migrated-book', percent: 42, updatedAt: Date.now(), deviceName: 'PC DSH' },
        ],
      }),
    })
    const batchJson = await batchRes.json()
    assert.equal(batchRes.status, 200)
    assert.equal(batchJson.merged, 1)
    assert.equal(batchJson.items[cloudReading.documentId].percent, 65)
    assert.equal(batchJson.items['document:migrated-book'].percent, 42)

    const pcBookmarks = await (await fetch(`${pcUrl}/api/paper-reader/pipeline/bookmarks`)).json()
    assert.equal(pcBookmarks.bookmarks.length, 1)
    assert.equal(pcBookmarks.bookmarks[0].comment, '手机端批注')

    const pcReadingAfter = await manager.reading(taskId)
    assert.equal(pcReadingAfter.blocks[1].translation, '第一段译文修订版内容[^1]。')

    // Renaming book on DSH propagates new name + reading title to Cloud on sync without re-uploading full bundle
    const renameRes = await fetch(`${pcUrl}/api/paper-reader/pipeline/tasks/${taskId}/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '现象学精读新译名' }),
    })
    assert.equal(renameRes.status, 200)
    const syncRename = await (await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/now`, { method: 'POST' })).json()
    assert.equal(syncRename.ok, true)
    assert.equal(syncRename.renamedBooks, 1)
    assert.equal(syncRename.pushedBooks, 0)
    const cloudLibAfterRename = await (await fetch(`${cloudUrl}/api/paper-reader/pipeline/library`, { headers: authHeaders })).json()
    assert.equal(cloudLibAfterRename.documents[0].name, '现象学精读新译名')
    const cloudReadingAfterRename = await (await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${taskId}/reading`, { headers: authHeaders })).json()
    assert.equal(cloudReadingAfterRename.title, '现象学精读新译名')

    // Cloud serves static mobile reader index.html
    const htmlRes = await fetch(`${cloudUrl}/`)
    assert.equal(htmlRes.status, 200)
    assert.match(await htmlRes.text(), /DSH|双语精读/)
  } finally {
    manager.stopBackgroundSync()
    pcServer.close()
    cloudServer.close()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(cloudData, { recursive: true, force: true })
  }
})

test('mobile reading-core renders highlights, footnotes, glossary hits, and protects footnote markers', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', text: 'Original term[^1].', translation: '对应术语概念[^1]。', sourceText: 'Original term[^1].' },
    { id: 'b2', type: 'footnote', text: '[^1]: Note text.', translation: '[^1]: 注释正文。' },
  ]
  const numbers = footnoteDisplayNumbers(blocks, [], true)
  assert.equal(numbers.get('1'), '1')

  const html = renderBlockBodyHtml('对应术语概念[^1]。', blocks[0], {
    view: 'translation',
    marks: [{ kind: 'bookmark', quote: '术语概念' }],
    noteNumbers: numbers,
    showDrawerTrigger: true,
  })
  assert.match(html, /<mark class="wr-markBookmark">术语概念<\/mark>/)
  assert.match(html, /data-fn-id="1"/)
  assert.match(html, /data-drawer-block="b1"/)

  const hits = extractGlossaryHits('对应术语概念', 'Original term', [{ source: 'Original', target: '对应' }])
  assert.equal(hits.length, 1)

  assert.throws(() => validateCorrectionMarkers('对应术语[^1]。', '对应术语。'), /注号/)
  assert.doesNotThrow(() => validateCorrectionMarkers('对应术语[^1]。', '修正术语[^1]。'))
})

test('computeViewportLayout and resolveTapZoneAction optimize narrow Android portrait vs wide Hanwang E-ink screens', () => {
  // 1. Narrow Android portrait phone (390x844): 1-col, stacked bilingual, bottom sheet, one-handed thumb lower-center turns next page
  const phoneLayout = computeViewportLayout({
    width: 390,
    height: 844,
    columnLayout: 'auto',
    bilingualLayout: 'auto',
    viewMode: 'bilingual',
    marginX: 20,
  })
  assert.equal(phoneLayout.isPortraitPhone, true)
  assert.equal(phoneLayout.colsPerSpread, 1)
  assert.equal(phoneLayout.effectiveBilingual, 'stacked')
  assert.equal(phoneLayout.dockSideSheet, false)
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.5, yRatio: 0.82, tapZoneMode: 'ergonomic', isPortraitPhone: true }),
    'next'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.5, yRatio: 0.12, tapZoneMode: 'ergonomic', isPortraitPhone: true }),
    'prev'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.32, yRatio: 0.5, tapZoneMode: 'ergonomic', isPortraitPhone: true }),
    'prev'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.68, yRatio: 0.5, tapZoneMode: 'ergonomic', isPortraitPhone: true }),
    'next'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.5, yRatio: 0.45, tapZoneMode: 'ergonomic', isPortraitPhone: true }),
    'menu'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.15, yRatio: 0.45, tapZoneMode: 'bottomNext', isPortraitPhone: true }),
    'prev'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.5, yRatio: 0.72, tapZoneMode: 'bottomNext', isPortraitPhone: true }),
    'next'
  )

  // 2. Hanwang 4:3 portrait E-ink screen (768x1024): parallel side-by-side bilingual, side-docked drawer, constrained single-col measure
  const einkPortraitBilingual = computeViewportLayout({
    width: 768,
    height: 1024,
    columnLayout: 'auto',
    bilingualLayout: 'auto',
    viewMode: 'bilingual',
    marginX: 20,
  })
  assert.equal(einkPortraitBilingual.isWide, true)
  assert.equal(einkPortraitBilingual.effectiveBilingual, 'parallel')
  assert.equal(einkPortraitBilingual.dockSideSheet, true)

  const einkPortraitSingle = computeViewportLayout({
    width: 768,
    height: 1024,
    columnLayout: 'single',
    bilingualLayout: 'auto',
    viewMode: 'translation',
    marginX: 20,
  })
  assert.equal(einkPortraitSingle.colsPerSpread, 1)
  assert.ok(einkPortraitSingle.horizontalPadding >= 64, 'Wide single-column mode constrains line measure with generous horizontal margins')

  // 3. Hanwang landscape E-ink / tablet (1024x768): automatic 2-column book spread
  const einkLandscape = computeViewportLayout({
    width: 1024,
    height: 768,
    columnLayout: 'auto',
    bilingualLayout: 'auto',
    viewMode: 'translation',
    marginX: 24,
  })
  assert.equal(einkLandscape.colsPerSpread, 2)
  assert.equal(einkLandscape.colWidth, 512)
  assert.equal(einkLandscape.spreadWidth, 1024)
  assert.equal(einkLandscape.dockSideSheet, true)

  // 4. Hanwang N10 stylus anti-mistouch mode ('keysOnly'): edge taps do not accidentally flip pages
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.12, yRatio: 0.5, tapZoneMode: 'keysOnly', isPortraitPhone: false }),
    'none'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.88, yRatio: 0.5, tapZoneMode: 'keysOnly', isPortraitPhone: false }),
    'none'
  )
  assert.equal(
    resolveTapZoneAction({ xRatio: 0.5, yRatio: 0.5, tapZoneMode: 'keysOnly', isPortraitPhone: false }),
    'menu'
  )

  // 5. WeRead horizontal swipe decision: deliberate drag (>=14% width even >450ms), quick flick, vertical rejection
  assert.equal(resolveSwipeDecision({ dx: -60, dy: 8, dt: 650, spreadWidth: 390 }), 'next')
  assert.equal(resolveSwipeDecision({ dx: 60, dy: -5, dt: 700, spreadWidth: 390 }), 'prev')
  assert.equal(resolveSwipeDecision({ dx: -24, dy: 4, dt: 160, spreadWidth: 390 }), 'next')
  assert.equal(resolveSwipeDecision({ dx: -15, dy: 2, dt: 120, spreadWidth: 390 }), 'stay')
  assert.equal(resolveSwipeDecision({ dx: -50, dy: 60, dt: 180, spreadWidth: 390 }), 'stay')
})

test('chunked PDF upload (>8MB) and background default autoSync work without blocking foreground', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chunk-pc-'))
  const cloudData = await fs.mkdtemp(path.join(os.tmpdir(), 'chunk-cloud-'))
  const readingRoot = path.join(root, 'papers')
  await fs.mkdir(readingRoot, { recursive: true })
  await fs.mkdir(path.join(root, 'Book/LargeBook'), { recursive: true })

  const taskId = '22222222-2222-4222-8222-222222222222'
  const taskDir = path.join(root, '.pipeline/tasks', taskId)
  const bookAiDir = path.join(taskDir, 'document/ai_convert/book')
  await fs.mkdir(bookAiDir, { recursive: true })
  const srcMd = '# Large PDF Book\n\nParagraph one.\n'
  const dstMd = '# 大文件书籍\n\n第一段译文。\n'
  const srcPath = path.join(bookAiDir, 'large-full.md')
  const dstPath = path.join(root, 'Book/LargeBook/trans.md')
  const pdfPath = path.join(root, 'Book/LargeBook/source.pdf')
  await fs.writeFile(srcPath, srcMd, 'utf8')
  await fs.writeFile(dstPath, dstMd, 'utf8')
  // 9.5 MB pseudo-PDF to exercise >8MB chunked upload & SHA-256 verification
  const bigPdf = Buffer.alloc(9.5 * 1024 * 1024, 0x41)
  Buffer.from('%PDF-1.4\n').copy(bigPdf, 0)
  await fs.writeFile(pdfPath, bigPdf)

  const { hash } = await import('../modules/pipeline/markdown.js')
  await fs.writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    documentId: 'document:large-1',
    name: 'Large PDF Book',
    kind: 'book',
    input: { id: 'src-large', name: 'source.pdf', type: 'pdf', fingerprint: hash(srcMd) },
    path: pdfPath,
    translationPath: dstPath,
    translationReport: {
      passed: true,
      sourceFingerprint: hash(srcMd),
      targetFingerprint: hash(dstMd),
    },
    publication: { published: true },
    state: 'idle',
    stage: 'publish',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stages: { inspect: { state: 'done' }, translate: { state: 'done' }, translationCheck: { state: 'done' }, publish: { state: 'done' } },
    bookmarks: [],
    log: [],
  }, null, 2))

  const manager = new TaskManager(root, readingRoot)
  const pcRoutes = taskRoutes(manager, async () => {})
  const { server: pcServer, baseUrl: pcUrl } = await startHttpRoutes(pcRoutes)
  const { server: cloudServer, token } = await createSyncServer({ dataDir: cloudData, token: 'chunk-token' })
  await new Promise(resolve => cloudServer.listen(0, '127.0.0.1', resolve))
  const cloudUrl = `http://127.0.0.1:${cloudServer.address().port}`

  try {
    // Saving config defaults autoSync=true and immediately starts background sync without blocking
    const cfgRes = await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudUrl, token, deviceName: 'PC Chunk', includePdf: true }),
    })
    const cfg = await cfgRes.json()
    assert.equal(cfgRes.status, 200)
    assert.equal(cfg.configured, true)
    assert.equal(cfg.autoSync, true)

    // Wait for background sync to finish
    let status = cfg
    for (let i = 0; i < 60; i++) {
      if (!status.background?.running && status.lastSyncAt) break
      await new Promise(r => setTimeout(r, 100))
      status = await (await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/status`)).json()
    }
    assert.equal(status.background?.running, false)
    assert.equal(status.lastError, null)
    assert.equal(status.lastResult?.pushedBooks, 1)
    assert.equal(status.lastResult?.pushedPdfs, 1)

    // Verify full 9.5MB PDF reached cloud intact
    const pdfRes = await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${taskId}/source`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(pdfRes.status, 200)
    const received = Buffer.from(await pdfRes.arrayBuffer())
    assert.equal(received.length, bigPdf.length)
    assert.equal(hash(received), hash(bigPdf))

    // Explicit background trigger via /sync/now { background: true } returns immediately
    const bgRes = await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/now`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ background: true }),
    })
    const bgJson = await bgRes.json()
    assert.equal(bgRes.status, 200)
    assert.equal(bgJson.accepted, true)
    for (let i = 0; i < 40; i++) {
      const s = await (await fetch(`${pcUrl}/api/paper-reader/pipeline/sync/status`)).json()
      if (!s.background?.running) break
      await new Promise(r => setTimeout(r, 50))
    }
  } finally {
    manager.stopBackgroundSync()
    pcServer.close()
    cloudServer.close()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(cloudData, { recursive: true, force: true })
  }
})

test('WeRead themes, font families, spacing presets, and scholarly cover palettes are complete and deterministic', () => {
  assert.ok(WEREAD_THEMES.length >= 10, 'at least 10 curated WeRead background themes')
  assert.ok(WEREAD_FONTS.length >= 10, 'at least 10 curated WeRead font presets')
  assert.equal(WEREAD_SPACING_PRESETS.length, 4)

  for (const t of WEREAD_THEMES) {
    assert.ok(t.id && t.label && t.bg && t.fg && t.border)
  }
  assert.match(resolveFontStack('kaiti'), /Kaiti|楷/i)
  assert.match(resolveFontStack('fangsong'), /FangSong|仿宋/i)
  assert.match(resolveFontStack('literary'), /Georgia|Palatino/i)

  const cover1 = bookCoverPalette('疯癫与文明', false)
  const cover2 = bookCoverPalette('疯癫与文明', false)
  assert.deepEqual(cover1, cover2)
  const einkCover = bookCoverPalette('疯癫与文明', true)
  assert.equal(einkCover.fg, '#000000')
})

function installMemoryIndexedDb() {
  const tables = new Map()
  const getTable = name => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  const makeReq = exec => {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null }
    queueMicrotask(() => {
      try {
        req.result = exec()
        req.onsuccess?.({ target: req })
      } catch (err) {
        req.error = err
        req.onerror?.({ target: req })
      }
    })
    return req
  }
  const db = {
    objectStoreNames: { contains: name => tables.has(name) },
    createObjectStore: name => getTable(name),
    transaction: storeName => {
      const tx = { oncomplete: null, onerror: null, error: null, abort: () => {} }
      const map = getTable(storeName)
      let pending = 0
      const finishCheck = () => {
        if (pending === 0) queueMicrotask(() => tx.oncomplete?.())
      }
      const track = req => {
        pending++
        const origSuccess = req.onsuccess
        req.onsuccess = ev => {
          origSuccess?.(ev)
          pending--
          finishCheck()
        }
        return req
      }
      const makeWrapped = exec => {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null }
        pending++
        queueMicrotask(() => {
          try {
            req.result = exec()
            req.onsuccess?.({ target: req })
            pending--
            finishCheck()
          } catch (err) {
            req.error = err
            req.onerror?.({ target: req })
            tx.error = err
            tx.onerror?.({ target: req })
          }
        })
        return req
      }
      queueMicrotask(() => finishCheck())
      tx.objectStore = () => ({
        get: k => makeWrapped(() => map.get(k)),
        put: (v, k) => makeWrapped(() => {
          const key = k !== undefined ? k : v?.id
          map.set(key, v)
          return key
        }),
        delete: k => makeWrapped(() => map.delete(k)),
        getAllKeys: () => makeWrapped(() => [...map.keys()]),
        getAll: () => makeWrapped(() => [...map.values()]),
        openCursor: () => {
          const entries = [...map.entries()]
          let idx = 0
          const req = { result: null, onsuccess: null, onerror: null }
          const step = () => {
            if (idx >= entries.length) {
              req.result = null
              req.onsuccess?.({ target: req })
              pending--
              finishCheck()
              return
            }
            const [k, v] = entries[idx++]
            req.result = {
              key: k,
              value: v,
              delete: () => map.delete(k),
              continue: () => queueMicrotask(step),
            }
            req.onsuccess?.({ target: req })
          }
          pending++
          queueMicrotask(step)
          return req
        },
      })
      return tx
    },
  }
  const prev = globalThis.indexedDB
  globalThis.indexedDB = {
    open: () => {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
  return () => {
    if (prev === undefined) delete globalThis.indexedDB
    else globalThis.indexedDB = prev
  }
}

test('cloud sync-server strips bloat + gzips, and mobile syncAll caches all MD texts while keeping PDFs on-demand', async () => {
  const cloudData = await fs.mkdtemp(path.join(os.tmpdir(), 'mob-sync-all-'))
  const { server, token, store } = await createSyncServer({ dataDir: cloudData, token: 'mob-token' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const cloudUrl = `http://127.0.0.1:${server.address().port}`
  const restoreDb = installMemoryIndexedDb()

  try {
    const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const padText = '学术正文内容，用于验证 gzip 压缩与轻量阅读载荷传输。'.repeat(20)
    await store.pushBundle({
      libraryEntry: {
        id: taskId,
        documentId: 'document:mob-1',
        name: 'Phenomenology Demo',
        kind: 'book',
        updatedAt: '2026-11-19T00:00:00.000Z',
      },
      reading: {
        id: taskId,
        documentId: 'document:mob-1',
        title: 'Phenomenology Demo',
        version: 'v1-hash',
        standaloneView: 'translation',
        blocks: [
          { id: 'b1', type: 'heading', text: '第一章', sourceBlockId: 'o1', sourceText: 'Chapter 1', sourceParagraphId: 'src-p1', pdfPages: [1], originalPdfPage: 1 },
          { id: 'b2', type: 'paragraph', text: padText, sourceBlockId: 'b2', sourceText: 'Original text.', pdfPage: 7, pdfPages: [7] },
          { id: 'b3', type: 'paragraph', text: '![Figure](fig.png)', sourceBlockId: 'o3', sourceText: '![Figure](fig.png)' },
        ],
        originalBlocks: [
          { id: 'o1', type: 'heading', text: 'Chapter 1' },
          { id: 'o2', type: 'paragraph', text: 'Original text.' },
          { id: 'o3', type: 'paragraph', text: '![Figure](fig.png)' },
        ],
        blockAliases: { legacy: 'b1' },
        bookmarkBlocks: [{ id: 'dup', text: 'HUGE_DUPLICATE'.repeat(50) }],
        glossary: [{ source: 'term', target: '术语' }],
        outline: [{ id: 'b1', label: '第一章', level: 1 }],
      },
      assets: [{ ref: 'fig.png', mimeType: 'image/png', dataBase64: pngBytes.toString('base64') }],
    })
    await store.savePdf(taskId, Buffer.from('%PDF-1.4\n%fake pdf\n'))

    // Verify server library includes version & reading strips bloat + compresses with gzip and Brotli (?lean=1)
    const rawRes = await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${taskId}/reading`, {
      headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
    })
    assert.equal(rawRes.status, 200)
    assert.equal(rawRes.headers.get('content-encoding'), 'gzip')
    assert.equal(rawRes.headers.get('access-control-max-age'), '86400')
    const serverReading = await rawRes.json()
    assert.equal(serverReading.bookmarkBlocks, undefined)
    assert.equal(serverReading.glossary, undefined)
    assert.deepEqual(serverReading.blockAliases, { legacy: 'b1' })

    const brRes = await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${taskId}/reading?lean=1`, {
      headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip, deflate, br' },
    })
    assert.equal(brRes.status, 200)
    assert.equal(brRes.headers.get('content-encoding'), 'br')
    const leanReading = await brRes.json()
    assert.equal(leanReading.blockAliases, undefined)
    assert.equal(leanReading.blocks[0].sourceParagraphId, undefined)
    assert.equal(leanReading.blocks[0].pdfPages, undefined)
    assert.equal(leanReading.blocks[0].originalPdfPage, undefined)
    assert.equal(leanReading.blocks[0].sourceBlockId, 'o1')
    assert.equal(leanReading.blocks[1].sourceBlockId, undefined)
    assert.equal(leanReading.blocks[1].pdfPage, 7)

    // Spy on HTTP routes hit during mobile syncAll & openBook
    const requestedUrls = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      requestedUrls.push(String(url))
      return origFetch(url, opts)
    }
    try {
      const { readerApi } = await import('../mobile-app/www/js/api.js')
      const { offlineDb } = await import('../mobile-app/www/js/offline-db.js')
      const settings = { serverUrl: cloudUrl, token, deviceName: 'Mobile Test' }

      // 1st sync: pulls library + all MD texts + inline images, never touches PDF or pdf-page
      const sync1 = await readerApi.syncAll(settings)
      assert.equal(sync1.syncedBooks, 1)
      assert.equal(sync1.skippedBooks, 0)
      assert.equal(sync1.failedBooks, 0)
      assert.ok(requestedUrls.some(u => u.includes('/reading?lean=1')))
      assert.ok(requestedUrls.some(u => u.includes('/asset?path=fig.png')))
      assert.equal(requestedUrls.some(u => u.includes('/source') || u.includes('/pdf-page/')), false)
      assert.equal(await offlineDb.getPdf(taskId), undefined)

      // Opening book uses local IndexedDB immediately without hitting /reading on network
      requestedUrls.length = 0
      const loaded = await readerApi.loadReading(settings, taskId)
      assert.equal(loaded.fromCache, true)
      assert.equal(loaded.reading.blocks.length, 3)
      assert.equal(requestedUrls.length, 0)

      // 2nd sync with unchanged version skips downloading reading again
      const sync2 = await readerApi.syncAll(settings)
      assert.equal(sync2.syncedBooks, 0)
      assert.equal(sync2.skippedBooks, 1)
      assert.equal(requestedUrls.some(u => u.includes('/reading')), false)

      // "Download all files" (includePdfs: true) caches source PDFs too
      const progressEvents = []
      const syncAllFiles = await readerApi.syncAll(settings, {
        includePdfs: true,
        onProgress: ev => progressEvents.push(ev),
      })
      assert.ok(progressEvents.some(ev => ev.phase === 'pdfs' && typeof ev.pct === 'number'))
      assert.equal(syncAllFiles.syncedPdfs, 1)
      assert.equal(syncAllFiles.skippedPdfs, 0)
      assert.equal(syncAllFiles.failedPdfs, 0)
      assert.ok((await offlineDb.getPdf(taskId))?.blob)

      // Repeated "download all files" skips already-cached PDF
      const syncAllFiles2 = await readerApi.syncAll(settings, { includePdfs: true })
      assert.equal(syncAllFiles2.syncedPdfs, 0)
      assert.equal(syncAllFiles2.skippedPdfs, 1)

      // When offline with cached PDF, loadPdfPageImageUrl falls back to cached PDF cleanly
      globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
      const offlinePage = await readerApi.loadPdfPageImageUrl(settings, taskId, 1)
      assert.equal(offlinePage.fallback, 'pdf')
      const offlinePdfUrl = await readerApi.downloadFullPdf(settings, taskId)
      assert.match(offlinePdfUrl, /^blob:/)
      globalThis.fetch = async (url, opts) => {
        requestedUrls.push(String(url))
        return origFetch(url, opts)
      }

      // Deleting book on cloud removes cached book & assets on mobile during sync
      await store.deleteTasks([taskId])
      const sync3 = await readerApi.syncAll(settings)
      assert.equal(sync3.library.documents.length, 0)
      assert.equal(await offlineDb.getBook(taskId), undefined)
      assert.equal(await offlineDb.getAsset(taskId, 'fig.png'), undefined)
      assert.equal(await offlineDb.getPdf(taskId), undefined)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    restoreDb()
    server.close()
    await fs.rm(cloudData, { recursive: true, force: true })
  }
})

test('full-library & in-book search across DSH engine, Cloud Sync HTTP, and Mobile offline store', async () => {
  const { searchReadingDocument, createLibrarySearcher } = await import('../modules/pipeline/search.js')
  const { searchBookContent, renderBlockBodyHtml, renderLibrarySearchSectionHtml } = await import('../mobile-app/www/js/reading-core.js')

  const sampleDoc = {
    documentId: 'doc-search-1',
    title: '历史唯物主义与认知革命',
    kind: 'book',
    comparisonAvailable: true,
    outline: [
      { id: 'b1', level: 1, label: '第一章 理论基础' },
      { id: 'b3', level: 1, label: '第二章 结语' },
    ],
    hiddenBlocks: ['b-hidden'],
    originalOutline: { hiddenBlocks: ['b-hidden'] },
    blocks: [
      { id: 'b-hidden', type: 'paragraph', text: 'hidden secret', translation: '隐藏版权页', sourceText: 'hidden secret' },
      { id: 'b1', type: 'heading', level: 1, text: '# Chapitre 1', translation: '# 第一章 理论基础', sourceText: '# Chapitre 1' },
      {
        id: 'b2',
        sourceBlockId: 'orig-b2',
        type: 'paragraph',
        text: '**Raison** et *folie*[^1].',
        translation: '**理性**与疯癫的辩证[^1]。',
        sourceText: '**Raison** et *folie*[^1].',
      },
      { id: 'b3', type: 'footnote', text: '[^1]: Foucault, Folie et deraison.', translation: '[^1]: 福柯讨论理性与疯癫史。', sourceText: '[^1]: Foucault, Folie et deraison.' },
    ],
  }

  // 1. Direct search strips markdown/footnote markers, skips hidden blocks, and hits both translation & original
  const transHits = searchReadingDocument(sampleDoc, '理性')
  assert.equal(transHits.totalMatches, 2)
  assert.equal(transHits.matches[0].blockId, 'b2')
  assert.equal(transHits.matches[0].view, 'translation')
  assert.equal(transHits.matches[0].chapterLabel, '第一章 理论基础')

  const hiddenMiss = searchReadingDocument(sampleDoc, '隐藏版权页')
  assert.equal(hiddenMiss.totalMatches, 0)

  const origHits = searchReadingDocument(sampleDoc, 'Folie')
  assert.equal(origHits.totalMatches, 2)
  assert.ok(origHits.matches.some(m => m.view === 'original' && m.blockId === 'orig-b2'))

  // 2. Cache reuses index when stamp unchanged and invalidates when stamp changes
  let loadCalls = 0
  const searcher = createLibrarySearcher()
  const docs = [{ id: 't1', name: '历史唯物主义', stamp: 'v1' }]
  const loadDoc = async () => {
    loadCalls += 1
    return { reading: sampleDoc, stamp: docs[0].stamp }
  }
  const r1 = await searcher({ documents: docs, query: '辩证', loadDoc })
  const r2 = await searcher({ documents: docs, query: '福柯', loadDoc })
  assert.equal(r1.totalBooks, 1)
  assert.equal(r2.totalMatches, 1)
  assert.equal(loadCalls, 1)

  docs[0].stamp = 'v2'
  await searcher({ documents: docs, query: '辩证', loadDoc })
  assert.equal(loadCalls, 2)

  // 3. Mobile reading-core emits data-mark-ids on saved highlights & highlights search terms + renders library results
  const blockHtml = renderBlockBodyHtml('理性与疯癫的辩证', { id: 'b2', type: 'paragraph' }, {
    view: 'translation',
    marks: [{ id: 'mk-1', kind: 'highlight', quote: '理性与疯癫' }],
    searchQuery: '疯癫',
  })
  assert.ok(blockHtml.includes('data-mark-ids="mk-1:highlight"'))
  assert.ok(blockHtml.includes('<mark class="wr-markSearch">疯癫</mark>'))

  const mobileHits = searchBookContent(sampleDoc, 'Folie')
  assert.equal(mobileHits.totalMatches, 2)

  const shelfSearchHtml = renderLibrarySearchSectionHtml({ loading: false, query: '疯癫', data: r1 }, '疯癫')
  assert.ok(shelfSearchHtml.includes('data-search-jump="t1"'))

  // 4. Sync server GET /pipeline/search & mobile offlineDb.searchAllBooks end-to-end
  const cloudData = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-sync-search-'))
  const { server, token, store } = await createSyncServer({ dataDir: cloudData, token: 'search-token' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const cloudUrl = `http://127.0.0.1:${server.address().port}`
  const restoreDb = installMemoryIndexedDb()
  try {
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await store.pushBundle({
      libraryEntry: { id: taskId, documentId: 'doc-search-1', name: '历史唯物主义与认知革命', kind: 'book' },
      reading: { ...sampleDoc, version: 'v1' },
      assets: [],
    })
    const res = await fetch(`${cloudUrl}/api/paper-reader/pipeline/search?q=${encodeURIComponent('辩证')}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.totalBooks, 1)
    assert.equal(body.results[0].matches[0].blockId, 'b2')

    const { readerApi } = await import('../mobile-app/www/js/api.js')
    const { offlineDb } = await import('../mobile-app/www/js/offline-db.js')
    const settings = { serverUrl: cloudUrl, token, deviceName: 'Test Phone' }
    await readerApi.syncAll(settings)
    const offlineOnlyRes = await offlineDb.searchAllBooks('Raison')
    assert.equal(offlineOnlyRes.totalBooks, 1)
    assert.equal(offlineOnlyRes.results[0].matches[0].view, 'original')
    const mergedRes = await readerApi.searchLibrary(settings, '辩证')
    assert.equal(mergedRes.totalBooks, 1)

    // 5. Book rename propagates via pushState (no full re-upload) -> library + reading.title + mobile offline cache & syncStatus
    const { renderSyncStatusCardHtml } = await import('../mobile-app/www/js/reading-core.js')
    const pushRes = await store.pushState({
      documentsMeta: [{ id: taskId, name: '历史唯物主义与认知革命（修订版）', kind: 'book' }],
    })
    assert.equal(pushRes.renamedBooks, 1)
    const syncAfterRename = await readerApi.syncAll(settings)
    assert.equal(syncAfterRename.renamedBooks, 1)
    assert.equal(syncAfterRename.skippedBooks, 1)
    assert.equal(syncAfterRename.library.documents[0].name, '历史唯物主义与认知革命（修订版）')
    const cachedAfterRename = await offlineDb.getBook(taskId)
    assert.equal(cachedAfterRename.reading.title, '历史唯物主义与认知革命（修订版）')

    await offlineDb.saveSyncStatus({ at: Date.now(), ok: true, totalDocs: 1, renamedBooks: 1, syncedBooks: 0 })
    const savedStatus = await offlineDb.getSyncStatus()
    assert.equal(savedStatus.renamedBooks, 1)
    const activeHtml = renderSyncStatusCardHtml({
      syncing: true,
      syncProgress: { phaseLabel: '下载 MD 正文', done: 1, total: 2, pct: 50, title: '书名' },
      hasCancel: true,
    })
    assert.ok(activeHtml.includes('50%') && activeHtml.includes('1/2'))
    const doneHtml = renderSyncStatusCardHtml({ syncing: false, syncStatus: savedStatus, cachedMd: 1, totalDocs: 1, cachedPdf: 0, totalPdfDocs: 0 })
    assert.ok(doneHtml.includes('改名 1'))

    // 6. WeRead multi-style highlight classes, thought bubble, spacing presets, grouped search & PDF typography params
    const { renderBlockCommentsBubbleHtml, WEREAD_SPACING_PRESETS } = await import('../mobile-app/www/js/reading-core.js')
    const { renderExportHtml } = await import('../modules/pipeline/export-pdf.js')
    assert.ok(WEREAD_SPACING_PRESETS.some(p => p.id === 'weread' && p.lineHeight === 1.9 && p.letterSpacing === 0.015))
    const styledHtml = renderBlockBodyHtml('先验感性论的直观形式', { id: 'b3', type: 'paragraph' }, {
      view: 'translation',
      marks: [{ id: 'mk-2', kind: 'bookmark', style: 'wave', color: 'blue', quote: '直观形式', comment: '核心概念' }],
    })
    assert.ok(styledHtml.includes('wr-ms-wave wr-mc-blue'))
    const bubbleHtml = renderBlockCommentsBubbleHtml([{ id: 'mk-2', kind: 'bookmark', comment: '核心概念' }])
    assert.ok(bubbleHtml.includes('data-note-bubble="mk-2:bookmark"') && bubbleHtml.includes('💭 1'))

    const groupedSearch = renderLibrarySearchSectionHtml(
      { loading: false, query: '哲学', data: r1 },
      '哲学',
      [{ id: taskId, name: '历史唯物主义与认知革命', author: 'Test' }]
    )
    assert.ok(groupedSearch.includes('data-act="clear-shelf-search"') && groupedSearch.includes('书名 / 作者命中'))

    // Update bookmark style/color/comment via cloud sync store action
    const createdBm = await store.saveSelectionBookmark({
      source: { kind: 'task', id: taskId },
      selection: { startBlockId: 'b2', endBlockId: 'b2', view: 'translation', exact: '理性与疯癫' },
      style: 'line',
      color: 'purple',
      highlightOnly: true,
    })
    assert.equal(createdBm.style, 'line')
    assert.equal(createdBm.color, 'purple')
    const updatedBm = await store.saveSelectionBookmark({
      updateBookmark: { id: createdBm.id, style: 'wave', color: 'green', comment: '云端更新想法' },
    })
    assert.equal(updatedBm.style, 'wave')
    assert.equal(updatedBm.color, 'green')
    assert.equal(updatedBm.comment, '云端更新想法')

    const exportHtml = renderExportHtml(
      { title: '排版导出测试', blocks: [{ id: 'p1', type: 'paragraph', text: 'Original.', translation: '译文段落。' }], comparisonAvailable: true },
      { mode: 'translation', typography: { fontFamily: 'kaiti', fontSize: 20, lineHeight: 2.0, letterSpacing: 0.04, paraSpacing: 0.9 } }
    )
    assert.ok(exportHtml.includes('letter-spacing: 0.04em') && exportHtml.includes('KaiTi') && exportHtml.includes('line-height: 2.00'))

    // 7. Static cover asset syncs via __cover__.jpg & /cover with CORS headers for Capacitor cross-origin WebView
    const missingCoverRes = await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${encodeURIComponent(taskId)}/cover`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://localhost' },
    })
    assert.equal(missingCoverRes.status, 404)
    assert.equal(missingCoverRes.headers.get('access-control-allow-origin'), '*')

    // Missing __cover__.jpg in bundle must never leave hasCover: true dangling on cloud
    await store.pushBundle({
      libraryEntry: {
        id: taskId,
        documentId: 'doc:sync-1',
        name: '历史唯物主义与认知革命（修订版）',
        kind: 'book',
        ready: true,
        hasCover: true,
        coverPage: 2,
        coverSha256: 'b'.repeat(64),
        updatedAt: new Date().toISOString(),
      },
      reading: { ...sampleDoc, version: 'v2-missing-cover' },
      assets: [],
    })
    assert.equal((await store.libraryPayload()).documents[0].hasCover, false)
    assert.equal((await store.pullState()).manifest[taskId].hasCoverAsset, false)

    // Pre-cache a 404 null entry cleanly and verify subsequent cover upload with coverSha256 recovers
    assert.equal(await readerApi.loadCoverUrl(settings, taskId, { hasCover: true, coverSha256: '' }), null)

    const coverBytes = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
    const coverSha = 'a'.repeat(64)
    await store.pushBundle({
      libraryEntry: {
        id: taskId,
        documentId: 'doc:sync-1',
        name: '历史唯物主义与认知革命（修订版）',
        kind: 'book',
        ready: true,
        hasCover: true,
        coverPage: 2,
        coverSha256: coverSha,
        updatedAt: new Date().toISOString(),
      },
      reading: { ...sampleDoc, version: 'v2-with-cover' },
      assets: [
        { ref: '__cover__.jpg', mimeType: 'image/jpeg', sha256: coverSha, dataBase64: coverBytes.toString('base64') },
      ],
    })
    assert.equal((await store.pullState()).manifest[taskId].hasCoverAsset, true)
    assert.equal(readerApi.getCachedCoverUrl(taskId, coverSha), undefined)
    const coverRes = await fetch(`${cloudUrl}/api/paper-reader/pipeline/tasks/${encodeURIComponent(taskId)}/cover?v=${coverSha}`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://localhost' },
    })
    assert.equal(coverRes.status, 200)
    assert.equal(coverRes.headers.get('access-control-allow-origin'), '*')
    assert.equal((await coverRes.arrayBuffer()).byteLength, coverBytes.length)

    // Pre-seed stale legacy page-1 cover in mobile IndexedDB and verify syncAll refreshes with __cover__.jpg
    await offlineDb.saveAsset(taskId, '__cover_page_1__', new Blob(['stale']), 'image/jpeg')
    const syncCoverRes = await readerApi.syncAll(settings)
    assert.equal(syncCoverRes.library.documents[0].hasCover, true)
    assert.equal(syncCoverRes.library.documents[0].coverPage, 2)
    assert.equal(syncCoverRes.library.documents[0].coverSha256, coverSha)
    assert.equal(await offlineDb.getAsset(taskId, '__cover_page_1__'), undefined)
    const cachedCover = await offlineDb.getAsset(taskId, '__cover__.jpg')
    assert.ok(cachedCover?.blob && cachedCover.sha256 === coverSha)
    const cachedUrl = await readerApi.loadCoverUrl({ serverUrl: '' }, taskId, { hasCover: true, coverSha256: coverSha })
    assert.ok(typeof cachedUrl === 'string' && cachedUrl.startsWith('blob:'))
    const suppressedUrl = await readerApi.loadCoverUrl(settings, taskId, { hasCover: false })
    assert.equal(suppressedUrl, null)

    // 8. Generated horizontal editorial cover comfortably accommodates 25+ char paper titles without truncation tricks
    const { editorialCoverSpec, renderBookCoverHtml } = await import('../mobile-app/www/js/reading-core.js')
    const longPaper = {
      id: 'p-long',
      kind: 'paper',
      name: '米歇尔·福柯的“治理术”与迈克尔·曼的“基础设施权力”之比较',
      author: 'D. McNay',
      hasCover: false,
    }
    const specLong = editorialCoverSpec(longPaper, false)
    assert.equal(specLong.sizeClass, 'is-long')
    assert.ok(specLong.units >= 24)
    const longHtml = renderBookCoverHtml(longPaper, false, '离线')
    assert.ok(longHtml.includes('is-generated') && longHtml.includes('is-long') && longHtml.includes('学术论文') && longHtml.includes('wr-covBadge'))
    assert.ok(!longHtml.includes('data-cover-task='))

    const splitPaper = {
      id: 'p-split',
      kind: 'paper',
      name: '当爱遇上药物：后社会主义中国矛盾情感的药物化',
      author: 'Zhiying Ma',
      hasCover: false,
    }
    const splitHtml = renderBookCoverHtml(splitPaper, true, '')
    assert.ok(splitHtml.includes('当爱遇上药物：') && splitHtml.includes('后社会主义中国矛盾情感的药物化') && splitHtml.includes('--cov-fg:#000000'))
  } finally {
    restoreDb()
    server.close()
    await fs.rm(cloudData, { recursive: true, force: true })
  }
})

test('vault binding, SQLite root recovery key, 6-digit pairing, rate limit, and device revocation', async () => {
  const { TaskManager } = await import('../modules/pipeline/tasks.js')
  const { readCloudSyncConfig, saveCloudSyncConfig, bindCloudVault, generateCloudPairingCode, revokeCloudDevice, cloudAuthStatus } = await import('../modules/pipeline/sync.js')
  const { createSyncServer } = await import('../sync-server/server.mjs')
  const { parsePairingInput } = await import('../mobile-app/www/js/connection-panel.js')
  const { offlineDb } = await import('../mobile-app/www/js/offline-db.js')
  const { readerApi } = await import('../mobile-app/www/js/api.js')

  let fakeNow = Date.now()
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-auth-pc-'))
  const cloudData = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-auth-cloud-'))
  const { server, token: rootKey } = await createSyncServer({
    dataDir: cloudData,
    disablePublicWeb: true,
    now: () => fakeNow,
  })
  const port = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  const cloudUrl = `http://127.0.0.1:${port}`
  const manager = new TaskManager(rootDir, rootDir)

  const restoreDb = installMemoryIndexedDb()

  try {
    // 1. DisablePublicWeb blocks anonymous root GET /
    const rootGet = await fetch(`${cloudUrl}/`)
    assert.equal(rootGet.status, 404)

    // 2. Save root recovery key + cloudUrl into PC config + SQLite catalog.sqlite, then verify recovery if JSON file vanishes
    await saveCloudSyncConfig(rootDir, { cloudUrl, token: rootKey, vaultName: 'Hao-哲社精读库' }, manager.index)
    await bindCloudVault(rootDir, 'Hao-哲社精读库', { index: manager.index })
    await fs.rm(path.join(rootDir, '.pipeline', 'cloud-sync.json'))
    const recovered = await readCloudSyncConfig(rootDir, manager.index)
    assert.equal(recovered.cloudUrl, cloudUrl)
    assert.equal(recovered.token, rootKey)
    assert.equal(recovered.vaultName, 'Hao-哲社精读库')
    assert.equal(recovered.dbBacked, true)

    // 3. PC generates 6-digit pairing code; mobile parses bundle string & pairs once
    const pairInfo = await generateCloudPairingCode(rootDir, { index: manager.index })
    assert.match(pairInfo.code, /^\d{6}$/)
    const parsedBundle = parsePairingInput(`dsh://pair?u=${encodeURIComponent(cloudUrl)}&c=${pairInfo.code}&v=${encodeURIComponent('Hao-哲社精读库')}`)
    assert.equal(parsedBundle.code, pairInfo.code)
    assert.equal(parsedBundle.vaultName, 'Hao-哲社精读库')

    const paired = await readerApi.pairWithCode(await offlineDb.getSettings(), {
      serverUrl: parsedBundle.serverUrl,
      code: parsedBundle.code,
      vaultName: parsedBundle.vaultName,
      deviceId: 'dev-mob-1',
      deviceName: 'Pixel-测试机',
    })
    assert.ok(paired.token.startsWith('dsh_dev_'))
    assert.equal(paired.vaultName, 'Hao-哲社精读库')

    // Single-use pairing code cannot be reused
    await assert.rejects(
      () => readerApi.pairWithCode({}, { serverUrl: cloudUrl, code: pairInfo.code, deviceId: 'dev-2', deviceName: 'X' }),
      err => err.status === 401,
    )

    // Device token can access sync/health & library, supports non-ASCII UTF-8 vault header, and cannot invoke rootOnly routes
    const deviceSettings = await offlineDb.saveSettings({ serverUrl: cloudUrl, token: paired.token, vaultName: paired.vaultName })
    const health = await readerApi.testConnection(deviceSettings)
    assert.equal(health.ok, true)
    assert.equal(health.role, 'device')
    assert.equal(health.vaultName, 'Hao-哲社精读库')

    const forbiddenRoot = await fetch(`${cloudUrl}/api/paper-reader/sync/auth/pair-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${paired.token}` },
    })
    assert.equal(forbiddenRoot.status, 403)

    const wrongVault = await fetch(`${cloudUrl}/api/paper-reader/sync/health`, {
      headers: { authorization: `Bearer ${paired.token}`, 'x-dsh-vault': encodeURIComponent('wrong-library') },
    })
    assert.equal(wrongVault.status, 409)

    // 4. Rate limiter / brute-force lockout kicks in after MAX_IP_ATTEMPTS (5)
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${cloudUrl}/api/paper-reader/sync/auth/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.99' },
        body: JSON.stringify({ code: '000001' }),
      })
      assert.equal(r.status, 401)
    }
    const throttled = await fetch(`${cloudUrl}/api/paper-reader/sync/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.99' },
      body: JSON.stringify({ code: '000001' }),
    })
    assert.equal(throttled.status, 429)

    // 5. PC revokes device token -> mobile gets 401; PC recovery key still works
    const authSt = await cloudAuthStatus(rootDir, { index: manager.index })
    assert.equal(authSt.devices.length, 1)
    await revokeCloudDevice(rootDir, 'dev-mob-1', { index: manager.index })
    await assert.rejects(() => readerApi.testConnection(deviceSettings), err => err.status === 401)
    const rootHealth = await fetch(`${cloudUrl}/api/paper-reader/sync/health`, {
      headers: { authorization: `Bearer ${recovered.token}` },
    })
    assert.equal(rootHealth.status, 200)

    // 6. Transient mid-stream body-read failure during syncAll retries automatically
    const origFetch2 = globalThis.fetch
    let libAttempts = 0
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('/pipeline/library')) {
        libAttempts++
        if (libAttempts === 1) {
          return {
            ok: true,
            status: 200,
            async text() { throw new TypeError('ERR_HTTP2_PROTOCOL_ERROR') },
          }
        }
      }
      return origFetch2(url, opts)
    }
    try {
      const syncRetryRes = await readerApi.syncAll(
        { serverUrl: cloudUrl, token: recovered.token, vaultName: 'Hao-哲社精读库', deviceName: 'Mobile' },
        { syncBooks: false },
      )
      assert.equal(libAttempts, 2)
      assert.ok(Array.isArray(syncRetryRes.library.documents))
    } finally {
      globalThis.fetch = origFetch2
    }
  } finally {
    restoreDb()
    server.close()
    await manager.index.close().catch(() => {})
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(cloudData, { recursive: true, force: true })
  }
})





