import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

async function loadClientHelpers() {
  const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
  const start = source.indexOf('    const ZH_HANT_CHAR_RE')
  const end = source.indexOf('    function SourceDialog(', start)
  assert(start >= 0 && end > start, 'script detection helpers should exist in client.js')
  const ctx = {}
  vm.runInNewContext(source.slice(start, end), ctx)
  const cssStart = source.indexOf('const CSS = `')
  const cssEnd = source.indexOf('\n`\n', cssStart)
  const css = source.slice(cssStart, cssEnd)
  return { ...ctx, css, source }
}

test('detectZhScript distinguishes Traditional and Simplified Chinese without false positives', async () => {
  const { detectZhScript, zhScriptAttrs } = await loadClientHelpers()
  assert.equal(detectZhScript('起，躁鬱兩者週期循環不已，愈演愈烈。沒有所謂理性表達，人人都要「嗆聲」。'), 'hant')
  assert.equal(detectZhScript('这是何春蕤二〇〇五年写作专论初稿时的社会脉络，讨论忧郁症与情绪管理。'), 'hans')
  assert.equal(detectZhScript('根本就是「情感」！', 'hant'), 'hant')
  assert.equal(detectZhScript('根本就是「情感」！', 'hans'), 'hans')
  assert.equal(detectZhScript('This is an English paragraph with no Chinese.', 'hans'), 'hans')
  assert.deepEqual({ ...zhScriptAttrs('hant') }, { 'data-zh-script': 'hant', lang: 'zh-Hant' })
  assert.deepEqual({ ...zhScriptAttrs('hans') }, {})
})

test('detectReadingScript scans outline and blocks even when title uses shared characters', async () => {
  const { detectReadingScript } = await loadClientHelpers()
  const reading = {
    title: '民困愁城',
    outline: [{ id: 'b1', level: 1, label: '序' }],
    blocks: [
      { id: 'b1', text: '# 序' },
      { id: 'b2', text: 'English preface paragraph before the main text.' },
      { id: 'b3', text: '本書使用的「憂鬱」是台灣的習慣用語，這個語詞差異還請所有中文讀者明鑑。' },
    ],
  }
  assert.equal(detectReadingScript(reading, reading.blocks, 'original'), 'hant')

  const bilingualReading = {
    title: '情感的现代性',
    blocks: [
      {
        id: 'b1',
        sourceText: '這是繁體中文原文段落，討論現代性與情緒管理體制。',
        translation: '这是简体中文译文段落，讨论现代性与情绪管理体制。',
      },
    ],
  }
  assert.equal(detectReadingScript(bilingualReading, bilingualReading.blocks, 'translation'), 'hans')
  assert.equal(detectReadingScript(bilingualReading, bilingualReading.blocks, 'original'), 'hant')
})

test('Traditional Chinese CSS overrides reading font stack away from GB2312-only font and balances VF weight', async () => {
  const { css } = await loadClientHelpers()
  const hantStart = css.indexOf('.rr-shell [data-zh-script="hant"]')
  assert(hantStart >= 0, 'Traditional Chinese CSS override should be defined')
  const hantCss = css.slice(hantStart)
  const hantFontRule = hantCss.slice(0, hantCss.indexOf('}'))
  assert(!hantFontRule.includes('方正屏显雅宋简体'), 'Traditional Chinese font stack must not use GB2312-only FangZheng font')
  assert(!hantFontRule.includes('FZPingXianYaSongS-R-GB'), 'Traditional Chinese font stack must not use GB2312 PostScript name')
  assert.match(hantFontRule, /Source Han Serif TC VF/)
  assert.match(hantFontRule, /Songti TC/)
  assert.match(hantCss, /Kaiti TC/)
  assert.match(hantCss, /PingFang TC/)
  assert.match(css, /--rr-reading-wght:\s*470/)
  assert.match(css, /font-variation-settings:\s*"wght"\s+var\(--rr-reading-wght,470\)/)
  assert.match(css, /font-variation-settings:\s*"wght"\s+650/)
  assert.match(css, /font-variation-settings:\s*"wght"\s+680/)
})
