import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { BookmarkStore, plainText, quoteSlices } from '../modules/pipeline/bookmarks.js'

test('plainText removes inline footnote references, definitions, and markdown tokens', () => {
  const inline = '这两部著作中分别阐述了他们关于该主题的思想[^c002-p057_1]。但时间上的接近只会使历史的突然介入和深刻断裂的影响更加突出。'
  assert.equal(plainText(inline), '这两部著作中分别阐述了他们关于该主题的思想。但时间上的接近只会使历史的突然介入和深刻断裂的影响更加突出。')

  const definition = '[^c002-p057_1]: 1. 康德的《人类学》出版于1798年'
  assert.equal(plainText(definition), '1. 康德的《人类学》出版于1798年')

  const custom = '[footnote-63]\\2 同上，第72页。'
  assert.equal(plainText(custom), '同上，第72页。')

  const combined = '然而，在《人类学》和《哲学科学百科全书》之间并没有多少年，这两部著作中分别阐述了他们关于该主题的思想[^c002-p057_1]。\n[footnote-57]\\1 康德的《人类学》出版于1798年'
  assert.equal(plainText(combined), '然而，在《人类学》和《哲学科学百科全书》之间并没有多少年，这两部著作中分别阐述了他们关于该主题的思想。 康德的《人类学》出版于1798年')
})

test('BookmarkStore.add succeeds when selected text spans across a footnote reference', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-test-'))
  const file = path.join(tmp, 'bookmarks.json')
  const store = new BookmarkStore(file)
  try {
    const rawParagraph = '然而，在《人类学》和《哲学科学百科全书》之间并没有多少年，这两部著作中分别阐述了他们关于该主题的思想[^c002-p057_1]。但时间上的接近只会使历史的突然介入和深刻断裂的影响更加突出。'
    const doc = {
      id: 'doc-1',
      title: '与疯人的对话',
      kind: 'book',
      source: { kind: 'task', id: 'task-1' },
      version: 'v1',
      blocks: [
        { id: 'b-1', text: rawParagraph, translation: rawParagraph }
      ]
    }
    const selection = {
      startBlockId: 'b-1',
      endBlockId: 'b-1',
      view: 'translation',
      exact: '然而，在《人类学》和《哲学科学百科全书》之间并没有多少年，这两部著作中分别阐述了他们关于该主题的思想。但时间上的接近只会使历史的突然介入和深刻断裂的影响更加突出。',
      prefix: '',
      suffix: ''
    }
    const bookmark = await store.add(doc, { selection, comment: '康德到黑格尔之间的断裂', tags: ['哲学'] })
    assert.ok(bookmark.id)
    assert.equal(bookmark.quote, selection.exact)
    assert.equal(bookmark.comment, '康德到黑格尔之间的断裂')

    const list = await store.list({ documentId: 'doc-1' })
    assert.equal(list.length, 1)
    assert.equal(list[0].quote, selection.exact)
    assert.deepEqual(quoteSlices(doc.blocks, bookmark.selector), [{ blockId: 'b-1', quote: selection.exact }])
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

function sampleDocument() {
  return {
    id: 'doc-1',
    title: '基础性权力',
    kind: 'paper',
    source: { kind: 'task', id: 'task-1' },
    version: 'v1',
    blocks: [
      { id: 'a', text: 'Alpha sentence here.', translation: '甲句在这里。' },
      { id: 'b', text: 'Beta follows after.', translation: '乙句接着来。' }
    ]
  }
}

test('quoteSlices splits a selection across blocks on the joined plain text', () => {
  const doc = sampleDocument()
  const slices = quoteSlices(doc.blocks, {
    type: 'TextQuoteSelector',
    view: 'original',
    startBlockId: 'a',
    endBlockId: 'b',
    start: 'Alpha '.length,
    end: 'Alpha '.length + 'sentence here. Beta'.length
  })
  assert.deepEqual(slices, [
    { blockId: 'a', quote: 'sentence here.' },
    { blockId: 'b', quote: 'Beta' }
  ])
  assert.deepEqual(quoteSlices(doc.blocks, { type: 'LegacyBlockSelector' }), [])
})

test('highlight-only records stay beside bookmarks and yield to an imported bookmark', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-test-'))
  const file = path.join(tmp, 'bookmarks.json')
  const store = new BookmarkStore(file)
  try {
    const doc = sampleDocument()
    const selection = { startBlockId: 'a', endBlockId: 'b', view: 'original', exact: 'sentence here. Beta', prefix: 'Alpha ', suffix: '' }
    const highlight = await store.addHighlight(doc, { selection })
    assert.equal(highlight.quote, selection.exact)
    assert.equal(highlight.already, undefined)
    const again = await store.addHighlight(doc, { selection })
    assert.equal(again.already, true)
    assert.equal(again.kind, 'highlight')
    assert.equal((await store.highlights({ documentId: doc.id })).length, 1)

    const other = await store.addHighlight(doc, { selection: { startBlockId: 'b', endBlockId: 'b', view: 'translation', exact: '乙句接着来。', prefix: '', suffix: '' } })
    assert.equal((await store.highlights({ documentId: doc.id })).length, 2)

    const bookmark = await store.add(doc, { selection, comment: '跨段', tags: ['权力'] })
    const highlights = await store.highlights({ documentId: doc.id })
    assert.equal(highlights.length, 1)
    assert.equal(highlights[0].id, other.id)
    assert.deepEqual(quoteSlices(doc.blocks, bookmark.selector).map(s => s.quote), ['sentence here.', 'Beta'])

    const covered = await store.addHighlight(doc, { selection })
    assert.equal(covered.already, true)
    assert.equal(covered.kind, 'bookmark')
    assert.equal((await store.highlights({ documentId: doc.id })).length, 1)
    assert.equal((await store.muteHighlight(bookmark.id)).muted, true)
    assert.equal((await store.list({ documentId: doc.id }))[0].highlight, false)
    const revived = await store.addHighlight(doc, { selection })
    assert.equal(revived.already, undefined)
    assert.equal((await store.highlights({ documentId: doc.id })).some(h => h.id === revived.id), true)
    assert.equal((await store.removeHighlight(other.id)).removed, true)
    assert.equal((await store.removeHighlight(revived.id)).removed, true)
    assert.equal((await store.highlights({ documentId: doc.id })).length, 0)
    assert.equal((await store.list({ documentId: doc.id })).length, 1)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('a bookmark file without highlights still loads and is not rewritten just to add the key', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-test-'))
  const file = path.join(tmp, 'bookmarks.json')
  const original = JSON.stringify({ schemaVersion: 1, documents: {}, bookmarks: [{ id: 'b1', documentId: 'doc-1', quote: '原句', comment: '', tags: [], createdAt: '2020-01-01T00:00:00.000Z' }] }) + '\n'
  await fs.writeFile(file, original)
  const store = new BookmarkStore(file)
  try {
    assert.equal((await store.list({ documentId: 'doc-1' })).length, 1)
    assert.deepEqual(await store.highlights({ documentId: 'doc-1' }), [])
    assert.equal(await fs.readFile(file, 'utf8'), original)
    assert.equal((await store.removeHighlight('missing')).removed, false)
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(Object.hasOwn(saved, 'highlights'), false)
    assert.equal(saved.bookmarks.length, 1)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('matchQuoteRanges paints through footnote markers and markdown tokens', async () => {
  const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
  const start = source.indexOf('    function matchQuoteRanges(')
  const end = source.indexOf('    function SelectionBookmark(', start)
  assert(start >= 0 && end > start)
  const ctx = {}
  vm.runInNewContext(source.slice(start, end), ctx)
  const raw = '然而，在《人类学》和《哲学科学百科全书》之间并没有多少年，这两部著作中分别阐述了他们关于该主题的思想[^c002-p057_1]。但时间上的接近只会使历史的突然介入和深刻断裂的影响更加突出。'
  const quote = '主题的思想。但时间'
  const ranges = ctx.matchQuoteRanges(raw, quote)
  assert.equal(ranges.length, 1)
  assert.equal(raw.slice(ranges[0][0], ranges[0][1]).startsWith('主题的思想'), true)
  assert.equal(raw.slice(ranges[0][0], ranges[0][1]).endsWith('但时间'), true)
  assert.equal(raw.slice(ranges[0][0], ranges[0][1]).includes('[^c002-p057_1]'), true)
  assert.equal(JSON.stringify(ctx.matchQuoteRanges(raw, plainText(raw))), JSON.stringify([[0, raw.length]]))
  const plain = '我自然很高兴基础性权力(IP)这一概念。'
  const at = plain.indexOf('基础性权力(IP)')
  assert.equal(JSON.stringify(ctx.matchQuoteRanges(plain, '基础性权力(IP)')), JSON.stringify([[at, at + '基础性权力(IP)'.length]]))
  const bold = '这是**基础性权力**的定义'
  assert.equal(bold.slice(...ctx.matchQuoteRanges(bold, '是基础性权力的')[0]), '是**基础性权力**的')
  const spaced = '基础性  权力'
  assert.equal(spaced.slice(...ctx.matchQuoteRanges(spaced, '基础性 权力')[0]), spaced)
})

test('BookmarkStore supports multi-style, color swatches, and in-place update() promotion', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-style-'))
  const file = path.join(tmp, 'bookmarks.json')
  const store = new BookmarkStore(file)
  try {
    const doc = {
      id: 'doc-style-1',
      title: '美学导论',
      kind: 'book',
      source: { kind: 'task', id: 'task-style-1' },
      version: 'v1',
      blocks: [{ id: 'b1', text: '纯粹直观是感性认识的先验形式。', translation: '纯粹直观是感性认识的先验形式。' }],
    }
    const sel = { startBlockId: 'b1', endBlockId: 'b1', view: 'translation', exact: '纯粹直观是感性认识' }
    const hl = await store.addHighlight(doc, { selection: sel, style: 'wave', color: 'blue' })
    assert.equal(hl.style, 'wave')
    assert.equal(hl.color, 'blue')
    const listed = await store.highlights({ documentId: doc.id })
    assert.equal(listed[0].style, 'wave')
    assert.equal(listed[0].color, 'blue')

    // Updating highlight with a comment promotes it to bookmark while keeping id, style, and color
    const promoted = await store.update(hl.id, { style: 'line', color: 'pink', comment: '先验感性论核心定义' })
    assert.equal(promoted.id, hl.id)
    assert.equal(promoted.kind, 'bookmark')
    assert.equal(promoted.style, 'line')
    assert.equal(promoted.color, 'pink')
    assert.equal(promoted.comment, '先验感性论核心定义')
    const bookmarksAfter = await store.list({ documentId: doc.id })
    assert.equal(bookmarksAfter.length, 1)
    assert.equal(bookmarksAfter[0].highlight, true)
    assert.equal((await store.highlights({ documentId: doc.id })).length, 0)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('BookmarkStore.updateDocumentCitation persists metadata and client/citation.js formats book/paper/collection/incollection citations', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bookmarks-cite-'))
  const file = path.join(tmp, 'bookmarks.json')
  const store = new BookmarkStore(file)
  try {
    const doc = sampleDocument()
    await store.add(doc, {
      selection: { startBlockId: 'a', endBlockId: 'a', view: 'translation', exact: '甲句在这里。', prefix: '', suffix: '' },
      comment: '核心论点',
    })
    const saved = await store.updateDocumentCitation(doc.id, {
      kind: 'incollection',
      title: '人类种类的循环效应',
      originalTitle: 'The Looping Effects of Human Kinds',
      authors: 'Ian Hacking',
      editors: 'Dan Sperber; David Premack; Ann James Premack',
      bookTitle: '因果认知：跨学科辩论',
      originalBookTitle: 'Causal Cognition: A Multi-Disciplinary Debate',
      publisher: 'Clarendon Press',
      year: '1995',
      pages: '351-383',
    })
    assert.equal(saved.citation.kind, 'incollection')
    assert.equal(saved.citation.editors, 'Dan Sperber; David Premack; Ann James Premack')
    assert.equal(saved.citation.bookTitle, '因果认知：跨学科辩论')
    const listed = await store.list({ documentId: doc.id })
    assert.equal(listed[0].document.citation.year, '1995')
    assert.equal(listed[0].document.citation.originalBookTitle, 'Causal Cognition: A Multi-Disciplinary Debate')
    assert.equal(listed[0].document.citation.pages, '351-383')

    const citeSrc = await fs.readFile(new URL('../client/citation.js', import.meta.url), 'utf8')
    const ctx = vm.createContext({})
    vm.runInContext(citeSrc + '\nthis.OUT = { generateCitations, normalizeCitationInfo, chapterHeadingForBlock };', ctx)
    const { generateCitations, chapterHeadingForBlock } = ctx.OUT

    // Book citations matching douban-book-plus conventions
    const bookInfo = {
      kind: 'book',
      title: '规训与惩罚',
      subtitle: '监狱的诞生',
      originalTitle: 'Surveiller et punir',
      authors: '米歇尔·福柯',
      translators: '刘北成，杨远婴',
      publisher: '生活·读书·新知三联书店',
      year: '2019',
      isbn: '9787108064981',
      pages: '23-24',
    }
    const zhBook = generateCitations(bookInfo, 'zh')
    assert.equal(zhBook.find(c => c.name === 'GB/T 7714-2015').text, '福柯. 规训与惩罚：监狱的诞生[M]. 刘北成，杨远婴，译. 生活·读书·新知三联书店，2019: 23-24.')
    assert.equal(zhBook.find(c => c.name === '《社会》').text, '福柯,米歇尔.2019.规训与惩罚：监狱的诞生[M].刘北成,杨远婴,译.生活·读书·新知三联书店:23-24.')
    assert.equal(zhBook.find(c => c.name === '《社会学评论》').text, '福柯,米歇尔.2019.《规训与惩罚：监狱的诞生》.刘北成,杨远婴译.生活·读书·新知三联书店，第23-24页.')
    assert.match(zhBook.find(c => c.name === 'BibTeX').text, /@book\{福柯2019,[\s\S]*pages\s*=\s*\{23--24\}/)
    assert.match(zhBook.find(c => c.name === 'RIS (Zotero / EndNote)').text, /TY  - BOOK[\s\S]*SP  - 23[\s\S]*EP  - 24/)

    // English journal paper citations (clean, no excerpt text)
    const paperEn = generateCitations({
      kind: 'paper',
      title: '再议基础设施权力',
      originalTitle: 'Infrastructural Power Revisited',
      authors: 'Michael Mann',
      journal: 'Studies in Comparative International Development',
      year: '2008',
      volume: '43',
      issue: '3',
      pages: '355-365',
    }, 'en')
    const apaPaper = paperEn.find(c => c.name === 'APA')
    assert.equal(apaPaper.text, 'Mann, M. (2008). Infrastructural Power Revisited. Studies in Comparative International Development, 43(3), 355-365.')
    assert.match(apaPaper.html, /font-style:italic/)
    assert.match(paperEn.find(c => c.name === 'BibTeX').text, /@article\{Mann2008,/)

    // Edited collection citations [C]
    const colInfo = {
      kind: 'collection',
      title: '海德格尔与精神病学',
      originalTitle: 'Heidegger und die Psychiatrie',
      editors: 'Alfred Denker; Miles Groth; Josef Jenewein; Holger Zaborowski',
      publisher: 'Verlag Karl Alber',
      year: '2023',
      pages: '85',
    }
    const zhCol = generateCitations(colInfo, 'zh')
    assert.match(zhCol.find(c => c.name === 'GB/T 7714-2015').text, /\[C\]\. Verlag Karl Alber，2023: 85\.$/)
    assert.match(zhCol.find(c => c.name === '《社会》').text, /,编\.2023\.海德格尔与精神病学\[C\]\.Verlag Karl Alber:85\.$/)
    assert.match(zhCol.find(c => c.name === '《社会学评论》').text, /编\.2023\.《海德格尔与精神病学》\.Verlag Karl Alber，第85页\.$/)
    const enCol = generateCitations(colInfo, 'en')
    assert.match(enCol.find(c => c.name === 'APA').text, /\(Eds\.\)\. \(2023\)\. Heidegger und die Psychiatrie \(p\. 85\)\. Verlag Karl Alber\.$/)
    assert.match(enCol.find(c => c.name === 'MLA').text, /editors\. Heidegger und die Psychiatrie\. Verlag Karl Alber, 2023, p\. 85\.$/)
    assert.match(enCol.find(c => c.name === 'Chicago').text, /eds\. Heidegger und die Psychiatrie\. Verlag Karl Alber, 2023, 85\.$/)
    assert.match(enCol.find(c => c.name === 'BibTeX').text, /@book\{Denker2023,[\s\S]*editor\s*=\s*\{/)
    assert.match(enCol.find(c => c.name === 'RIS (Zotero / EndNote)').text, /TY  - EDBOOK[\s\S]*A2  - /)

    // Essay / chapter inside an edited collection [C]//
    const incolInfo = {
      kind: 'incollection',
      title: '人类种类的循环效应',
      originalTitle: 'The Looping Effects of Human Kinds',
      authors: 'Ian Hacking',
      editors: 'Dan Sperber; David Premack; Ann James Premack',
      bookTitle: '因果认知：跨学科辩论',
      originalBookTitle: 'Causal Cognition: A Multi-Disciplinary Debate',
      publisher: 'Clarendon Press',
      year: '1995',
      pages: '351-383',
    }
    const zhIncol = generateCitations(incolInfo, 'zh')
    assert.match(zhIncol.find(c => c.name === 'GB/T 7714-2015').text, /人类种类的循环效应\[C\]\/\/.*因果认知：跨学科辩论\. Clarendon Press，1995: 351-383\.$/)
    assert.match(zhIncol.find(c => c.name === '《社会》').text, /人类种类的循环效应\[C\]\/\/.*因果认知：跨学科辩论\.Clarendon Press:351-383\.$/)
    assert.match(zhIncol.find(c => c.name === '《社会学评论》').text, /《人类种类的循环效应》\.载.*编《因果认知：跨学科辩论》\.Clarendon Press，第351-383页\.$/)
    const enIncol = generateCitations(incolInfo, 'en')
    assert.equal(enIncol.find(c => c.name === 'APA').text, 'Hacking, I. (1995). The Looping Effects of Human Kinds. In D. Sperber, D. Premack, & A. J. Premack (Eds.), Causal Cognition: A Multi-Disciplinary Debate (pp. 351-383). Clarendon Press.')
    assert.match(enIncol.find(c => c.name === 'MLA').text, /"The Looping Effects of Human Kinds\." Causal Cognition: A Multi-Disciplinary Debate, edited by Dan Sperber, et al\., Clarendon Press, 1995, pp\. 351-383\.$/)
    assert.match(enIncol.find(c => c.name === 'Chicago').text, /"The Looping Effects of Human Kinds\." In Causal Cognition: A Multi-Disciplinary Debate, edited by Dan Sperber, David Premack, and Ann James Premack, 351-383\. Clarendon Press, 1995\.$/)
    assert.match(enIncol.find(c => c.name === 'BibTeX').text, /@incollection\{Hacking1995,[\s\S]*editor\s*=\s*\{[\s\S]*booktitle\s*=\s*\{Causal Cognition: A Multi-Disciplinary Debate\}/)
    assert.match(enIncol.find(c => c.name === 'RIS (Zotero / EndNote)').text, /TY  - CHAP[\s\S]*A2  - Dan Sperber[\s\S]*T2  - Causal Cognition: A Multi-Disciplinary Debate/)

    // Chapter heading resolver skips TOC and L3 subsections, strips outer 《》 and footnote markers
    const sampleReading = {
      blocks: [
        { id: 'h0', type: 'heading', text: '## 目录', sourceText: '## Table des matières' },
        { id: 'h1', type: 'heading', text: '## 《意大利的疯癫史》', sourceText: '## Histoire de la folie en Italie [^fn1]' },
        { id: 'h2', type: 'heading', text: '### 导论', sourceText: '### Introduction' },
        { id: 'p1', type: 'paragraph', text: '正文段落' },
      ],
      outline: [
        { id: 'h0', level: 1, label: '目录' },
        { id: 'h1', level: 2, label: '《意大利的疯癫史》' },
        { id: 'h2', level: 3, label: '导论' },
      ],
    }
    assert.deepEqual({ ...chapterHeadingForBlock(sampleReading, 'p1') }, {
      chapterTitle: '意大利的疯癫史',
      originalChapterTitle: 'Histoire de la folie en Italie',
    })
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('clampPopupToBounds keeps selection capsule and mark popover inside DSH panel bounds at all edges', async () => {
  const src = await fs.readFile(new URL('../client/reading-helpers.js', import.meta.url), 'utf8')
  const fnStart = src.indexOf('function clampPopupToBounds(')
  const fnEnd = src.indexOf('function measurePopupPosition(')
  const ctx = vm.createContext({})
  vm.runInContext(src.slice(fnStart, fnEnd) + '\nthis.clampPopupToBounds = clampPopupToBounds;', ctx)
  const clamp = ctx.clampPopupToBounds

  const panel = { left: 0, top: 0, width: 720, height: 640 }
  const capsule = { width: 360, height: 80 }

  // Near left edge: never clips past x=12
  const leftEdge = clamp(panel, { left: 8, right: 36, top: 200, bottom: 220 }, capsule, { preferAbove: true })
  assert.equal(leftEdge.left, 12)
  assert.equal(leftEdge.below, false)
  assert.equal(leftEdge.top, 110)

  // Near right edge: never overflows panel.width - margin (708)
  const rightEdge = clamp(panel, { left: 680, right: 710, top: 200, bottom: 220 }, capsule, { preferAbove: true })
  assert.equal(rightEdge.left, 720 - 360 - 12)
  assert.ok(rightEdge.left + capsule.width <= panel.width - 12)

  // Near top edge: flips below selection instead of clipping top
  const topEdge = clamp(panel, { left: 300, right: 420, top: 20, bottom: 42 }, capsule, { preferAbove: true })
  assert.equal(topEdge.below, true)
  assert.equal(topEdge.top, 52)

  // Near bottom edge for SavedMarkPopover (preferAbove: false): flips above instead of clipping bottom
  const popover = { width: 300, height: 240 }
  const bottomEdge = clamp(panel, { left: 300, right: 300, top: 560, bottom: 580 }, popover, { preferAbove: false, gap: 8 })
  assert.equal(bottomEdge.below, false)
  assert.equal(bottomEdge.top, 560 - 240 - 8)
  assert.ok(bottomEdge.top >= 12 && bottomEdge.top + popover.height <= panel.height - 12)

  // Ultra-narrow panel (e.g. DSH split pane 340px wide): stays strictly inside [12, 328]
  const narrow = clamp({ left: 0, top: 0, width: 340, height: 500 }, { left: 260, right: 330, top: 200, bottom: 220 }, { width: 316, height: 112 }, { preferAbove: true })
  assert.equal(narrow.left, 12)
  assert.ok(narrow.left + 316 <= 340 - 12)
})
