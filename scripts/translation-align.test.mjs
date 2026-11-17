import test from 'node:test'
import assert from 'node:assert/strict'
import { alignFootnoteMarkers } from '../modules/pipeline/translation-transport.js'
import { checkMarkdownPair } from '../modules/pipeline/markdown.js'

test('alignFootnoteMarkers restores footnote definition anchor', () => {
  const src = '[^c007-p122_1]: Some footnote text'
  const dst = '1. 一些脚注文本 <!--dsh-block:B0394-->'
  const aligned = alignFootnoteMarkers(src, dst)
  assert.equal(aligned, '[^c007-p122_1]: 一些脚注文本 <!--dsh-block:B0394-->')
})

test('alignFootnoteMarkers restores missing inline footnote marker with quoted phrase', () => {
  const src = '« Masquer » : une déraison sous sa forme « épithétique »[^c009-p156_1] : le *déraisonnable*'
  const dst = '“遮蔽”：一种以其“épithétique”形态所冲淡的déraison：即*déraisonnable* <!--dsh-block:B0500-->'
  const aligned = alignFootnoteMarkers(src, dst)
  assert.ok(aligned.includes('[^c009-p156_1]'))
  assert.ok(aligned.includes('“épithétique”[^c009-p156_1]形态'))
})

test('alignFootnoteMarkers repairs near-miss marker variants', () => {
  const src = 'paragraph with note[^c009-p156_1]'
  const dst = '段落带注释[^c009-p156-1] <!--dsh-block:B0100-->'
  const aligned = alignFootnoteMarkers(src, dst)
  assert.ok(aligned.includes('[^c009-p156_1]'))
  assert.ok(!aligned.includes('[^c009-p156-1]'))
})

test('alignFootnoteMarkers proportional insertion when no quoted phrase', () => {
  const src = 'First sentence. Second sentence here[^c001-p001_1]. Third sentence follows.'
  const dst = '第一句话。第二句话在这里。第三句话紧随其后。 <!--dsh-block:B0001-->'
  const aligned = alignFootnoteMarkers(src, dst)
  assert.ok(aligned.includes('[^c001-p001_1]'))
  assert.ok(aligned.endsWith(' <!--dsh-block:B0001-->'))
})
