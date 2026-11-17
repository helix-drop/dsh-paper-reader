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
