import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { taskRoutes } from '../modules/pipeline/routes.js'
import { TaskManager } from '../modules/pipeline/tasks.js'
import { hash, markdownBlocks } from '../modules/pipeline/markdown.js'
import { readerOutline, enrichReading } from '../modules/pipeline/reader.js'
import { detectZhScript, isTraditionalChinese, convertHantToHansMarkdown } from '../modules/pipeline/zh-convert.js'
import { fileStamp } from '../modules/pipeline/storage.js'

test('readerOutline omits per-chapter NOTES subsections while keeping TOC links and real subsections', () => {
  const md = [
    '# 測試書目',
    '',
    '## 目录',
    '',
    '- [[#序]]',
    '- [[#上篇　主題篇]]',
    '- [[#第一章　導言]]',
    '- [[#下篇　討論篇]]',
    '- [[#第二章　結尾]]',
    '',
    '## 序',
    '',
    '序言正文[^n1]。',
    '',
    '### NOTES',
    '',
    '[^n1]: 1. 註釋內容。',
    '',
    '## 上篇　主題篇',
    '',
    '## 第一章　導言',
    '',
    '### 第一節　問題意識',
    '',
    '正文內容。',
    '',
    '### 註釋',
    '',
    '## 下篇　討論篇',
    '',
    '## 第二章　結尾',
    '',
    '### 第一節　結論',
    '',
    '### 注释',
  ].join('\n')

  const doc = enrichReading({ id: 'o1', title: '測試書目', blocks: markdownBlocks(md) })
  const labels = doc.outline.map(item => `${item.level}:${item.label}`)
  assert.deepEqual(labels, [
    '1:序',
    '1:上篇　主題篇',
    '1:第一章　導言',
    '3:第一節　問題意識',
    '1:下篇　討論篇',
    '1:第二章　結尾',
    '3:第一節　結論',
  ])
})

test('convertHantToHansMarkdown converts Traditional Chinese while protecting code, URLs, images, and footnotes', async () => {
  const trad = [
    '# 情感與現代性',
    '',
    '## 目录',
    '',
    '- [[#第一章　導論]]',
    '',
    '## 第一章　導論',
    '',
    '憂鬱症與現代性黑暗面的討論[^c001-1]，請參見 `preserveTraditional(這個詞)` 與 [網站資料](https://example.org/憂鬱/path)。',
    '',
    '![圖表說明](images/圖表_原始.png)',
    '',
    '```js',
    'const label = "保持繁體代碼不動"',
    '```',
    '',
    '### NOTES',
    '',
    '[^c001-1]: 1. 參考著作權與台灣社會研究，見 https://example.org/繁體網址 。',
  ].join('\n')

  assert.equal(detectZhScript(trad), 'hant')
  assert.equal(isTraditionalChinese(trad), true)

  const simplified = await convertHantToHansMarkdown(trad)
  assert.equal(detectZhScript(simplified), 'hans')
  assert.match(simplified, /# 情感与现代性/)
  assert.match(simplified, /- \[\[#第一章　导论\]\]/)
  assert.match(simplified, /## 第一章　导论/)
  assert.match(simplified, /忧郁症与现代性黑暗面的讨论\[\^c001-1\]/)
  assert.match(simplified, /`preserveTraditional\(這個詞\)`/)
  assert.match(simplified, /!\[图表说明\]\(images\/圖表_原始\.png\)/)
  assert.match(simplified, /\(https:\/\/example\.org\/憂鬱\/path\)/)
  assert.match(simplified, /const label = "保持繁體代碼不動"/)
  assert.match(simplified, /\[\^c001-1\]: 1\. 参考著作权与台湾社会研究，见 https:\/\/example\.org\/繁體網址/)

  const origBlocks = markdownBlocks(trad)
  const simBlocks = markdownBlocks(simplified)
  const enriched = enrichReading({
    id: 'hant-1',
    title: '情感與現代性',
    blocks: origBlocks.map((b, i) => ({ ...b, translation: simBlocks[i]?.text })),
  })
  assert.equal(enriched.comparisonAvailable, true)
  assert.equal(enriched.alignment, 'structure-verified')
  assert.deepEqual(enriched.originalOutline.outline.map(x => x.label), ['第一章　導論'])
  assert.deepEqual(enriched.outline.map(x => x.label), ['第一章　导论'])
})

test('TaskManager supports Traditional-to-Simplified toggle without mutating original files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-zhconv-'))
  try {
    const pubDir = path.join(root, 'publications', '測試繁體書')
    const bookDir = path.join(root, 'Book', '測試繁體書', 'ai_convert', 'book', '測試繁體書')
    await fs.mkdir(pubDir, { recursive: true })
    await fs.mkdir(bookDir, { recursive: true })

    const originalMd = [
      '# 測試繁體書',
      '',
      '## 第一章　開始',
      '',
      '這是一本關於社會結構、心理情緒與歷史變遷的繁體中文著作[^c1-1]。',
      '',
      '### NOTES',
      '',
      '[^c1-1]: 1. 這裡是繁體註釋。',
    ].join('\n')

    const pubFile = path.join(pubDir, '測試繁體書-full.md')
    const origFile = path.join(bookDir, '測試繁體書-full.md')
    await fs.writeFile(pubFile, originalMd, 'utf8')
    await fs.writeFile(origFile, originalMd, 'utf8')

    const manager = new TaskManager(root, { publishRoot: path.join(root, 'publications') })
    const fp = hash(originalMd)
    const stamp = await fileStamp(pubFile)
    const id = '11111111-1111-4111-8111-111111111111'
    await manager.save({
      id,
      documentId: 'document:' + id,
      schemaVersion: 2,
      name: '測試繁體書-full',
      kind: 'book',
      input: { id: fp, name: '測試繁體書', type: 'markdown', fingerprint: fp },
      path: origFile,
      worker: { provider: 'legacy', model: 'legacy', timeout: null },
      state: 'imported',
      stage: 'inspect',
      createdAt: new Date().toISOString(),
      stages: { inspect: { state: 'done', historical: true } },
      bookmarks: [],
      log: [],
      lgUrl: '',
      legacy: {
        key: 'book:' + path.join(root, 'Book', '測試繁體書'),
        directory: path.join(root, 'Book', '測試繁體書'),
        caption: '已有发布成品',
        artifacts: { original: origFile, translation: null, readingPath: pubFile },
        readingFingerprint: fp,
        readingStamp: stamp,
      },
      libraryProof: { kind: 'legacy', readingPath: pubFile, readingHash: fp, readingStamp: stamp, title: '測試繁體書-full' },
    })

    const initial = await manager.reading(id)
    assert.equal(initial.zhConvertEligible, true)
    assert.equal(initial.zhConverted, false)
    assert.equal(initial.comparisonAvailable, false)

    const converted = await manager.convertTraditionalToSimplified(id, { enabled: true })
    assert.equal(converted.zhConverted, true)
    assert.equal(converted.zhConvertEligible, false)
    assert.equal(converted.comparisonAvailable, true)
    assert.equal(converted.alignment, 'structure-verified')
    assert.equal(converted.standaloneView, undefined)
    const bodyBlock = converted.blocks.find(b => b.text.includes('這是一本'))
    assert.ok(bodyBlock, 'Original Traditional block should remain accessible')
    assert.match(bodyBlock.sourceText, /社會結構.*繁體中文著作/)
    assert.match(bodyBlock.translation, /社会结构.*繁体中文著作/)

    assert.equal(await fs.readFile(pubFile, 'utf8'), originalMd)
    assert.equal(await fs.readFile(origFile, 'utf8'), originalMd)
    assert.match(await manager.readingDownload(id, 'original'), /繁體中文著作/)
    assert.match(await manager.readingDownload(id, 'translation'), /繁体中文著作/)

    const edited = await manager.correctReading(id, {
      blockId: bodyBlock.id,
      view: 'translation',
      version: converted.version,
      text: '这是一本修订后的简体译文[^c1-1]。',
    })
    const updatedBlock = edited.blocks.find(b => b.id === bodyBlock.id)
    assert.equal(updatedBlock.translation, '这是一本修订后的简体译文[^c1-1]。')
    assert.match(updatedBlock.sourceText, /繁體中文著作/)
    assert.equal(await fs.readFile(pubFile, 'utf8'), originalMd)

    const disabled = await manager.convertTraditionalToSimplified(id, { enabled: false })
    assert.equal(disabled.zhConverted, false)
    assert.equal(disabled.zhConvertEligible, true)
    assert.equal(disabled.comparisonAvailable, false)

    await manager.index.close()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('zh-convert route validates Simplified or already-translated documents and supports HTTP POST toggling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-zhconv-route-'))
  try {
    const manager = new TaskManager(root, { publishRoot: path.join(root, 'publications') })
    const routes = taskRoutes(manager, async () => {})
    const callRoute = async (method, urlPath, body) => {
      const route = routes.find(r => r.method === method && r.pattern.test(urlPath))
      assert.ok(route, `Route ${method} ${urlPath} should exist`)
      const match = urlPath.match(route.pattern)
      const req = new EventEmitter()
      req.method = method
      req.url = urlPath
      const chunks = []
      const res = {
        statusCode: 200,
        headers: {},
        writeHead(code, headers) { this.statusCode = code; this.headers = headers },
        end(data) { chunks.push(data) },
      }
      queueMicrotask(() => {
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      })
      await route.handler(req, res, new URL('http://localhost' + urlPath), match)
      return JSON.parse(chunks.join(''))
    }

    const simpFile = path.join(root, 'simp.md')
    await fs.writeFile(simpFile, '# 简体书\n\n## 第一章\n\n这是简体中文正文内容，关于社会结构与现代性。', 'utf8')
    const simpTask = {
      id: '22222222-2222-4222-8222-222222222222',
      documentId: 'document:simp',
      schemaVersion: 2,
      name: '简体书',
      kind: 'book',
      input: { id: 's1', name: 'simp.md', type: 'markdown', fingerprint: hash(await fs.readFile(simpFile, 'utf8')) },
      path: simpFile,
      worker: { provider: 'legacy', model: 'legacy', timeout: null },
      state: 'imported',
      stage: 'inspect',
      createdAt: new Date().toISOString(),
      stages: { inspect: { state: 'done' } },
      bookmarks: [],
      log: [],
      lgUrl: '',
    }
    await manager.save(simpTask)
    const simpReading = await manager.reading(simpTask.id)
    assert.equal(simpReading.zhConvertEligible, false)
    await assert.rejects(() => callRoute('POST', `/pipeline/tasks/${simpTask.id}/zh-convert`, { enabled: true }), /不是繁体中文/)

    const tradFile = path.join(root, 'trad.md')
    await fs.writeFile(tradFile, '# 繁體測試\n\n## 第一章\n\n這裡討論情感與現代性以及社會結構變遷。', 'utf8')
    const tradTask = {
      id: '33333333-3333-4333-8333-333333333333',
      documentId: 'document:trad',
      schemaVersion: 2,
      name: '繁體測試',
      kind: 'book',
      input: { id: 't1', name: 'trad.md', type: 'markdown', fingerprint: hash(await fs.readFile(tradFile, 'utf8')) },
      path: tradFile,
      worker: { provider: 'legacy', model: 'legacy', timeout: null },
      state: 'imported',
      stage: 'inspect',
      createdAt: new Date().toISOString(),
      stages: { inspect: { state: 'done' } },
      bookmarks: [],
      log: [],
      lgUrl: '',
    }
    await manager.save(tradTask)
    const viaRoute = await callRoute('POST', `/pipeline/tasks/${tradTask.id}/zh-convert`, { enabled: true })
    assert.equal(viaRoute.zhConverted, true)
    assert.match(viaRoute.blocks[2].translation, /现代性以及社会结构变迁/)

    const enFile = path.join(root, 'en.md')
    const zhTransFile = path.join(root, 'zh.md')
    const enText = '# Title\n\nEnglish paragraph.'
    const zhTransText = '# 标题\n\n中文译文段落。'
    await fs.writeFile(enFile, enText, 'utf8')
    await fs.writeFile(zhTransFile, zhTransText, 'utf8')
    const biTask = {
      id: '44444444-4444-4444-8444-444444444444',
      documentId: 'document:bi',
      schemaVersion: 2,
      name: '双语书',
      kind: 'book',
      input: { id: 'b1', name: 'en.md', type: 'markdown', fingerprint: hash(enText) },
      path: enFile,
      translationPath: zhTransFile,
      translationReport: { passed: true, sourceFingerprint: hash(enText), targetFingerprint: hash(zhTransText) },
      worker: { provider: 'legacy', model: 'legacy', timeout: null },
      state: 'done',
      stage: 'publish',
      createdAt: new Date().toISOString(),
      stages: { inspect: { state: 'done' } },
      bookmarks: [],
      log: [],
      lgUrl: '',
    }
    await manager.save(biTask)
    await assert.rejects(() => callRoute('POST', `/pipeline/tasks/${biTask.id}/zh-convert`, { enabled: true }), /已有译文/)

    // Verify translation PDF, bilingual PDF, and bilingual Markdown export
    const { renderExportHtml, buildBilingualMarkdown, contentDispositionFor } = await import('../modules/pipeline/export-pdf.js')
    const biReading = await manager.reading(biTask.id)
    const htmlTrans = renderExportHtml(biReading, { mode: 'translation' })
    const htmlBi = renderExportHtml(biReading, { mode: 'bilingual' })
    assert.ok(htmlTrans.includes('中文译文段落') && !htmlTrans.includes('English paragraph'))
    assert.ok(htmlBi.includes('中文译文段落') && htmlBi.includes('English paragraph') && htmlBi.includes('pdf-biRow'))
    assert.ok(buildBilingualMarkdown(biReading).includes('> English paragraph'))
    assert.ok(contentDispositionFor('双语书-双语对照.pdf').includes("filename*=UTF-8''"))

    const biMdRes = await manager.readingDownloadExport(biTask.id, { kind: 'bilingual', format: 'md' })
    assert.equal(biMdRes.mimeType, 'text/markdown; charset=utf-8')
    assert.match(biMdRes.bytes.toString('utf8'), /English paragraph/)

    const transPdfRes = await manager.readingDownloadExport(biTask.id, { kind: 'translation', format: 'pdf' })
    assert.equal(transPdfRes.mimeType, 'application/pdf')
    assert.ok(transPdfRes.bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'expected real PDF header')
    const biPdfRes = await manager.readingDownloadExport(biTask.id, { kind: 'bilingual', format: 'pdf' })
    assert.equal(biPdfRes.mimeType, 'application/pdf')
    assert.ok(biPdfRes.bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'expected real bilingual PDF header')

    const routeReq = new EventEmitter()
    routeReq.method = 'GET'
    const downloadRoute = routes.find(r => r.method === 'GET' && r.pattern.test(`/pipeline/tasks/${biTask.id}/download`))
    let writtenHeaders = {}
    let writtenBody = Buffer.alloc(0)
    await downloadRoute.handler(
      routeReq,
      { writeHead: (_c, h) => { writtenHeaders = h }, end: b => { writtenBody = Buffer.from(b) } },
      new URL(`http://localhost/pipeline/tasks/${biTask.id}/download?kind=bilingual&format=pdf`),
      `/pipeline/tasks/${biTask.id}/download`.match(downloadRoute.pattern),
    )
    assert.equal(writtenHeaders['content-type'], 'application/pdf')
    assert.ok(writtenBody.subarray(0, 5).toString('ascii') === '%PDF-')

    await manager.index.close()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
