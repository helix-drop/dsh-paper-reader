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
    resolveTapZoneAction({ xRatio: 0.5, yRatio: 0.45, tapZoneMode: 'ergonomic', isPortraitPhone: true }),
    'menu'
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
  assert.ok(WEREAD_FONTS.length >= 8, 'at least 8 curated WeRead font presets')
  assert.equal(WEREAD_SPACING_PRESETS.length, 3)

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



