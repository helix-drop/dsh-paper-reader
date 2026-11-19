export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const plainText = text => String(text ?? '')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\[\^([^\]]+)\](?::\s*)?/g, '')
  .replace(/\[footnote-\d+\]\\[^\s]+\s*/g, '')
  .replace(/[*`_]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

export function buildFootnoteIndex(blocks, translated = false) {
  const entries = new Map()
  const custom = new Map()
  const add = (map, key, value) => {
    if (map.has(key)) map.set(key, null)
    else map.set(key, value)
  }
  for (const block of blocks ?? []) {
    const value = translated ? (block.translation ?? block.text ?? '') : (block.text ?? '')
    const defs = [...value.matchAll(/(?:^|\n)\[\^([^\]]+)\]:[ \t]*|(?:^|\n)\[footnote-(\d+)\]\\([^\s]+)[ \t]*/g)]
    for (let i = 0; i < defs.length; i++) {
      const m = defs[i]
      const text = value.slice(m.index + m[0].length, defs[i + 1]?.index ?? value.length).trim()
      const entry = {
        blockId: block.id,
        text,
        id: m[1] ?? ('p' + Number(m[2]) + '_' + m[3]),
      }
      if (m[1]) add(entries, m[1], entry)
      else add(custom, Number(m[2]) + '_' + m[3], entry)
    }
  }
  return { entries, custom }
}

export function resolveFootnote(index, id) {
  if (!index) return undefined
  if (index.entries.has(id)) return index.entries.get(id)
  const m = String(id ?? '').match(/(?:^|[-_])p0*(\d+)_([^\s]+)$/)
  return m ? index.custom.get(Number(m[1]) + '_' + m[2]) : undefined
}

export function footnoteDisplayNumbers(blocks, outline = [], translated = false) {
  const index = buildFootnoteIndex(blocks, translated)
  const labels = new Map()
  const counts = new Map()
  const chapters = new Set((outline ?? []).filter(x => x.level === 1).map(x => x.id))
  let chapter = 'front'
  const assign = (id, scope) => {
    if (labels.has(id)) return
    const alias = resolveFootnote(index, id)?.id
    if (alias && labels.has(alias)) {
      labels.set(id, labels.get(alias))
      return
    }
    const key = id.match(/^(c\d+)[-_]/i)?.[1] ?? scope
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    labels.set(id, String(n))
    if (alias) labels.set(alias, String(n))
  }
  const deferred = []
  for (const b of blocks ?? []) {
    if (chapters.has(b.id)) chapter = b.id
    const text = translated ? (b.translation ?? b.text ?? '') : (b.text ?? '')
    for (const m of text.matchAll(/\[\^([^\]]+)\](?!:)/g)) assign(m[1], chapter)
    const def = text.match(/^(?:\[\^([^\]]+)\]:|\[footnote-(\d+)\]\\([^\s]+))/)
    if (def) deferred.push([def[1] ?? ('p' + Number(def[2]) + '_' + def[3]), chapter])
  }
  for (const [id, scope] of deferred) assign(id, scope)
  return labels
}

export function matchQuoteRanges(raw, quote) {
  const needle = String(quote ?? '')
  if (!needle || !raw) return []
  const items = []
  for (let i = 0; i < raw.length; i++) items.push({ ch: raw[i], start: i, end: i + 1 })
  const apply = (re, build) => {
    const source = items.map(item => item.ch).join('')
    const next = []
    let last = 0
    for (const match of source.matchAll(re)) {
      next.push(...items.slice(last, match.index))
      next.push(...build(match, items.slice(match.index, match.index + match[0].length)))
      last = match.index + match[0].length
    }
    next.push(...items.slice(last))
    items.length = 0
    items.push(...next)
  }
  apply(/^#{1,6}\s+/gm, () => [])
  apply(/!\[([^\]]*)\]\([^)]+\)/g, (match, slice) => slice.slice(2, 2 + match[1].length))
  apply(/\[([^\]]+)\]\([^)]+\)/g, (match, slice) => slice.slice(1, 1 + match[1].length))
  apply(/\[\^([^\]]+)\](?::\s*)?/g, () => [])
  apply(/\[footnote-\d+\]\\[^\s]+\s*/g, () => [])
  apply(/[*`_]/g, () => [])
  apply(/\s+/g, (_match, slice) => [{ ch: ' ', start: slice[0].start, end: slice[slice.length - 1].end }])
  while (items[0]?.ch === ' ') items.shift()
  while (items.at(-1)?.ch === ' ') items.pop()
  const plain = items.map(item => item.ch).join('')
  const ranges = []
  for (let index = plain.indexOf(needle); index >= 0; index = plain.indexOf(needle, index + needle.length)) {
    ranges.push([items[index].start, items[index + needle.length - 1].end])
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (!last || range[0] > last[1]) merged.push(range)
    else last[1] = Math.max(last[1], range[1])
  }
  return merged
}

function parseMobileSearchQuery(query) {
  const lower = String(query ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (!lower) return { lower: '', tokens: [] }
  return { lower, tokens: [...new Set(lower.split(' ').filter(Boolean))] }
}

function escapeAndHighlight(str, searchQuery) {
  const raw = String(str ?? '')
  const parsed = parseMobileSearchQuery(searchQuery)
  if (!parsed.lower || !raw) return escapeHtml(raw)
  const lower = raw.toLowerCase()
  const terms = lower.includes(parsed.lower) ? [parsed.lower] : parsed.tokens
  const sorted = [...terms].filter(Boolean).sort((a, b) => b.length - a.length)
  if (!sorted.length) return escapeHtml(raw)
  const ranges = []
  for (const term of sorted) {
    let pos = 0
    while ((pos = lower.indexOf(term, pos)) >= 0) {
      ranges.push([pos, pos + term.length])
      pos += Math.max(1, term.length)
    }
  }
  if (!ranges.length) return escapeHtml(raw)
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const r of ranges) {
    const prev = merged.at(-1)
    if (!prev || r[0] > prev[1]) merged.push([r[0], r[1]])
    else prev[1] = Math.max(prev[1], r[1])
  }
  let out = ''
  let cur = 0
  for (const [s, e] of merged) {
    if (s > cur) out += escapeHtml(raw.slice(cur, s))
    out += `<mark class="wr-markSearch">${escapeHtml(raw.slice(s, e))}</mark>`
    cur = e
  }
  if (cur < raw.length) out += escapeHtml(raw.slice(cur))
  return out
}

function renderInlineFragment(raw, { noteNumbers, view, blockId, searchQuery = '' }) {
  // Tokenize images, footnotes, links, bold/italic/code safely
  const tokens = []
  const re = /!\[([^\]]*)\]\(([^)]+)\)|\[\^([^\]]+)\](?!:)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  let out = ''
  for (const m of raw.matchAll(re)) {
    out += escapeAndHighlight(raw.slice(last, m.index), searchQuery)
    if (m[2] !== undefined) {
      out += `<img data-asset-ref="${escapeHtml(m[2])}" alt="${escapeHtml(m[1])}" loading="lazy" />`
    } else if (m[3] !== undefined) {
      const fnId = m[3]
      const label = noteNumbers?.get(fnId) ?? fnId
      out += `<button type="button" class="wr-fnRef" data-fn-id="${escapeHtml(fnId)}" data-fn-view="${escapeHtml(view)}" data-fn-block="${escapeHtml(blockId)}">${escapeHtml(label)}</button>`
    } else if (m[4] !== undefined) {
      out += `<span class="wr-linkText">${escapeAndHighlight(m[4], searchQuery)}</span>`
    } else if (m[6] !== undefined) {
      out += `<code>${escapeHtml(m[6])}</code>`
    } else if (m[7] !== undefined) {
      out += `<strong>${escapeAndHighlight(m[7], searchQuery)}</strong>`
    } else if (m[8] !== undefined) {
      out += `<em>${escapeAndHighlight(m[8], searchQuery)}</em>`
    }
    last = m.index + m[0].length
  }
  out += escapeAndHighlight(raw.slice(last), searchQuery)
  void tokens
  return out
}

function renderWithHighlights(raw, marks, opts) {
  if (!marks?.length) return renderInlineFragment(raw, opts)
  const spans = []
  for (const mark of marks) {
    const token = mark.id ? `${mark.id}:${mark.kind === 'bookmark' ? 'bookmark' : 'highlight'}` : ''
    const style = mark.style || 'highlight'
    const color = mark.color || 'gold'
    for (const [start, end] of matchQuoteRanges(raw, mark.quote)) {
      spans.push({ start, end, kind: mark.kind, style, color, ids: token ? [token] : [] })
    }
  }
  if (!spans.length) return renderInlineFragment(raw, opts)
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const s of spans) {
    const last = merged.at(-1)
    if (!last || s.start >= last.end) merged.push({ ...s, ids: [...s.ids] })
    else {
      last.end = Math.max(last.end, s.end)
      if (s.kind === 'bookmark') last.kind = 'bookmark'
      if (s.style && s.style !== 'highlight') last.style = s.style
      if (s.color && s.color !== 'gold') last.color = s.color
      for (const id of s.ids) {
        if (!last.ids.includes(id)) last.ids.push(id)
      }
    }
  }
  let cursor = 0
  let html = ''
  for (const s of merged) {
    if (s.start > cursor) html += renderInlineFragment(raw.slice(cursor, s.start), opts)
    const baseCls = s.kind === 'bookmark' ? 'wr-markBookmark' : 'wr-markHighlight'
    const extraCls = [
      s.style && s.style !== 'highlight' ? `wr-ms-${escapeHtml(s.style)}` : '',
      s.color && s.color !== 'gold' ? `wr-mc-${escapeHtml(s.color)}` : '',
    ].filter(Boolean).join(' ')
    const cls = extraCls ? `${baseCls} ${extraCls}` : baseCls
    const idAttr = s.ids?.length ? ` data-mark-ids="${escapeHtml(s.ids.join(','))}"` : ''
    html += `<mark class="${cls}"${idAttr}>${renderInlineFragment(raw.slice(s.start, s.end), opts)}</mark>`
    cursor = s.end
  }
  if (cursor < raw.length) html += renderInlineFragment(raw.slice(cursor), opts)
  return html
}

export function renderBlockCommentsBubbleHtml(blockComments) {
  if (!blockComments?.length) return ''
  const ids = blockComments.map(m => `${m.id}:${m.kind || 'bookmark'}`).join(',')
  return `<button type="button" class="wr-noteBubble" data-note-bubble="${escapeHtml(ids)}" title="查看或编辑想法笔记">💭 ${blockComments.length}</button>`
}

export function renderBlockBodyHtml(rawText, block, { view, marks = [], noteNumbers, showDrawerTrigger = false, searchQuery = '' }) {
  const raw = String(rawText ?? '')
  const trimmed = raw.trim()
  const opts = { view, blockId: block.id, noteNumbers, searchQuery }
  const trigger = showDrawerTrigger
    ? `<button type="button" class="wr-blockTrigger" data-drawer-block="${escapeHtml(block.id)}" title="对照原文与页码">原文${block.pdfPage ? ` · P${block.pdfPage}` : ''}</button>`
    : ''

  if (block.type === 'heading' || /^#{1,6}\s+/.test(trimmed)) {
    const m = trimmed.match(/^(#{1,6})\s+([\s\S]*)$/)
    const level = Math.min(4, Math.max(1, m ? m[1].length : (block.level || 2)))
    const content = m ? m[2] : trimmed
    return `<h${level}>${renderWithHighlights(content, marks, opts)}${trigger}</h${level}>`
  }

  if (block.type === 'quote' || trimmed.startsWith('> ')) {
    const body = trimmed.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n')
    return `<blockquote>${renderWithHighlights(body, marks, opts).replace(/\n/g, '<br/>')}${trigger}</blockquote>`
  }

  const fnDef = trimmed.match(/^\[\^([^\]]+)\]:\s*([\s\S]*)$/)
  if (fnDef) {
    const label = noteNumbers?.get(fnDef[1]) ?? fnDef[1]
    return `<p class="wr-footnoteDef"><strong>[${escapeHtml(label)}]</strong> ${renderWithHighlights(fnDef[2], marks, opts)}${trigger}</p>`
  }

  return `<p>${renderWithHighlights(trimmed, marks, opts).replace(/\n/g, '<br/>')}${trigger}</p>`
}

export function extractGlossaryHits(blockText, sourceText, glossary = []) {
  if (!Array.isArray(glossary) || !glossary.length) return []
  const haySrc = String(sourceText ?? '').toLowerCase()
  const hayDst = String(blockText ?? '').toLowerCase()
  const hits = []
  for (const item of glossary) {
    const src = String(item?.source ?? item?.src ?? '').trim()
    const dst = String(item?.target ?? item?.dst ?? '').trim()
    if (!src && !dst) continue
    if ((src && src.length >= 2 && haySrc.includes(src.toLowerCase())) || (dst && dst.length >= 2 && hayDst.includes(dst.toLowerCase()))) {
      hits.push({ source: src, target: dst, note: item?.note ?? item?.info ?? '' })
      if (hits.length >= 12) break
    }
  }
  return hits
}

export function validateCorrectionMarkers(rawOriginal, editedText) {
  const refs = value => [...String(value ?? '').matchAll(/\[\^[^\]]+\]/g)].map(m => m[0]).join('|')
  if (!String(editedText ?? '').trim()) {
    throw new Error('段落内容不能为空')
  }
  if (refs(rawOriginal) !== refs(editedText)) {
    throw new Error('注号 [^...] 须保留，请勿删除或修改脚注标号')
  }
}

export function computeViewportLayout({
  width = 390,
  height = 844,
  columnLayout = 'auto',
  bilingualLayout = 'auto',
  viewMode = 'translation',
  marginX = 20,
}) {
  const W = Math.max(240, Math.round(Number(width) || 390))
  const H = Math.max(240, Math.round(Number(height) || 844))
  const isWide = W >= 640
  const isPortraitPhone = W < 600 && H >= W

  // On narrow portrait phones (<640px), parallel side-by-side bilingual columns are too narrow;
  // on wide E-ink tablets (>=640px), parallel side-by-side bilingual columns are much faster to scan.
  const effectiveBilingual = bilingualLayout === 'parallel'
    ? 'parallel'
    : bilingualLayout === 'stacked'
      ? 'stacked'
      : (isWide ? 'parallel' : 'stacked')

  const isParallelBilingual = viewMode === 'bilingual' && effectiveBilingual === 'parallel'

  let colsPerSpread = 1
  if (!isParallelBilingual && W >= 680) {
    if (columnLayout === 'double' || (columnLayout === 'auto' && W >= 860)) {
      colsPerSpread = 2
    }
  }

  const colWidth = Math.floor(W / colsPerSpread)
  // For single-column mode on wide 4:3 E-ink screens (e.g. 768px-960px), constrain line measure
  // to ~620px so lines stay around 34-40 Chinese characters instead of stretching edge-to-edge.
  let horizontalPadding = Math.max(10, Number(marginX) || 20)
  if (colsPerSpread === 1 && W >= 680 && !isParallelBilingual) {
    const idealContentWidth = Math.min(640, Math.round(W * 0.80))
    horizontalPadding = Math.max(horizontalPadding, Math.round((W - idealContentWidth) / 2))
  } else if (colsPerSpread === 2) {
    horizontalPadding = Math.max(16, Math.min(36, Number(marginX) || 24))
  }

  return {
    width: W,
    height: H,
    isWide,
    isPortraitPhone,
    colsPerSpread,
    colWidth,
    spreadWidth: colWidth * colsPerSpread,
    effectiveBilingual,
    horizontalPadding,
    dockSideSheet: W >= 680,
  }
}

export function resolveTapZoneAction({ xRatio, yRatio, tapZoneMode = 'ergonomic', isPortraitPhone = true }) {
  const x = Math.max(0, Math.min(1, Number(xRatio) || 0))
  const y = Math.max(0, Math.min(1, Number(yRatio) || 0))

  if (tapZoneMode === 'keysOnly') {
    // Stylus / Hanwang N10 anti-mistouch mode: only center box opens menu; page turns use physical keys or explicit bottom bar
    if (x >= 0.30 && x <= 0.70 && y >= 0.25 && y <= 0.70) return 'menu'
    return 'none'
  }

  if (tapZoneMode === 'bottomNext') {
    // One-handed thumb mode: center-middle opens menu, top 28% prev, everywhere else next
    if (x >= 0.32 && x <= 0.68 && y >= 0.28 && y <= 0.56) return 'menu'
    if (y < 0.28) return 'prev'
    return 'next'
  }

  if (tapZoneMode === 'classic') {
    if (x < 0.32) return 'prev'
    if (x > 0.68) return 'next'
    return 'menu'
  }

  // 'ergonomic' (default):
  // Left 30% -> prev; Right 30% -> next;
  // On tall portrait phones, lower-middle thumb zone (y > 0.70) also turns to next page for effortless one-handed reading.
  if (x < 0.30) return 'prev'
  if (x > 0.70) return 'next'
  if (isPortraitPhone && y > 0.70) return 'next'
  return 'menu'
}

export function resolveSwipeDecision({ dx = 0, dy = 0, dt = 0, spreadWidth = 360 } = {}) {
  const absX = Math.abs(Number(dx) || 0)
  const absY = Math.abs(Number(dy) || 0)
  const elapsed = Math.max(1, Number(dt) || 1)
  const width = Math.max(240, Number(spreadWidth) || 360)
  const distThreshold = Math.max(36, Math.min(72, Math.round(width * 0.14)))
  const flickThreshold = 20
  if (absX <= absY * 1.15) return 'stay'
  if (absX < distThreshold && !(absX >= flickThreshold && elapsed <= 300)) return 'stay'
  return dx < 0 ? 'next' : 'prev'
}

export const HIGHLIGHT_STYLES = [
  { id: 'highlight', label: '马克笔' },
  { id: 'wave', label: '波浪线' },
  { id: 'line', label: '直线' },
]

export const HIGHLIGHT_COLORS = [
  { id: 'gold', label: '暖金', hex: '#d4a742' },
  { id: 'blue', label: '海蓝', hex: '#3b82f6' },
  { id: 'green', label: '竹青', hex: '#10b981' },
  { id: 'pink', label: '绛红', hex: '#ec4899' },
  { id: 'purple', label: '堇紫', hex: '#8b5cf6' },
]

export const WEREAD_THEMES = [
  { id: 'white', label: '纯白', bg: '#ffffff', fg: '#212832', swatch: '#ffffff', border: '#e4e6eb', dark: false },
  { id: 'paper', label: '羊皮纸', bg: '#f6f1e7', fg: '#2c2620', swatch: '#f3ead8', border: '#e2d8c5', dark: false },
  { id: 'kraft', label: '牛皮纸', bg: '#eadcc9', fg: '#382c1e', swatch: '#e2cfb4', border: '#cfb999', dark: false },
  { id: 'green', label: '护眼绿', bg: '#d8ebd9', fg: '#1e3022', swatch: '#cce5ce', border: '#b6d5b8', dark: false },
  { id: 'cyan', label: '海天蓝', bg: '#dceaf2', fg: '#1d2d38', swatch: '#cce0ec', border: '#b5cfdf', dark: false },
  { id: 'rose', label: '胭脂粉', bg: '#f5e4e6', fg: '#362225', swatch: '#efd5d8', border: '#dec0c4', dark: false },
  { id: 'gray', label: '极简灰', bg: '#eaecf0', fg: '#1f2329', swatch: '#dfe2e8', border: '#cfd4dc', dark: false },
  { id: 'dark', label: '暗夜灰', bg: '#0e0e10', fg: '#b4b4b6', swatch: '#1c1c1e', border: '#323236', dark: true },
  { id: 'night', label: '纯黑', bg: '#000000', fg: '#9c9ca0', swatch: '#0a0a0c', border: '#27272a', dark: true },
  { id: 'eink', label: '水墨屏', bg: '#ffffff', fg: '#000000', swatch: '#ffffff', border: '#000000', dark: false, eink: true },
]

export const WEREAD_FONTS = [
  { id: 'serif', cat: 'serif', label: '思源宋体', sub: '经典书宋', stack: '"Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", Georgia, serif' },
  { id: 'fzsong', cat: 'serif', label: '方正新书宋', sub: '人文雅宋', stack: '"FZNewShuSong-Z10", "FZShuSong-Z01", "Noto Serif SC", "Noto Serif CJK SC", "Songti SC", "Source Han Serif SC", Georgia, serif' },
  { id: 'cangjin', cat: 'serif', label: '玄宋45S', sub: '微信书宋韵味', stack: '"FZSongKeBenXiuKaiS-R-GB", "Noto Serif SC", "Noto Serif CJK SC", "Songti SC", "Source Han Serif SC", Georgia, serif' },
  { id: 'kaiti', cat: 'kaiti', label: '霞鹜文楷', sub: '屏幕增重楷体', stack: '"LXGW WenKai Screen", "LXGW WenKai Lite", "LXGW WenKai", "Kaiti SC", "STKaiti", "FZKai-Z03", "KaiTi", "DFKai-SB", "Noto Serif SC", serif' },
  { id: 'fangsong', cat: 'kaiti', label: '书刻仿宋', sub: '古籍清朗', stack: '"FangSong", "STFangsong", "FZFangSong-Z02", "LXGW WenKai Screen", "Noto Serif SC", "Noto Serif CJK SC", serif' },
  { id: 'sans', cat: 'sans', label: '系统黑体', sub: '现代清晰', stack: '-apple-system, BlinkMacSystemFont, "PingFang SC", "MiSans", "HarmonyOS Sans SC", "OPPOSans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' },
  { id: 'hyqihei', cat: 'sans', label: '汉仪旗黑', sub: '杂志爽朗', stack: '"HYQiHei 50S", "HYQiHei", "MiSans", "HarmonyOS Sans SC", "PingFang SC", "Noto Sans CJK SC", sans-serif' },
  { id: 'yuan', cat: 'sans', label: '雅致圆体', sub: '柔和舒缓', stack: '"STYuanti-SC-Regular", "YouYuan", "FZY3JW--GB1-0", "PingFang SC", "HarmonyOS Sans SC", "Noto Sans CJK SC", sans-serif' },
  { id: 'literary', cat: 'western', label: '西文衬线', sub: '外文双语优享', stack: 'Georgia, "Palatino Linotype", "Book Antiqua", "Times New Roman", "Noto Serif SC", "Noto Serif CJK SC", serif' },
  { id: 'mono', cat: 'western', label: '等宽字体', sub: '严谨对齐', stack: '"JetBrains Mono", "SFMono-Regular", Consolas, "PingFang SC", "Noto Sans CJK SC", monospace' },
]

export const WEREAD_SPACING_PRESETS = [
  { id: 'compact', label: '紧凑', lineHeight: 1.55, paraSpacing: 0.45, marginX: 16, letterSpacing: 0 },
  { id: 'normal', label: '适中', lineHeight: 1.78, paraSpacing: 0.75, marginX: 20, letterSpacing: 0.01 },
  { id: 'weread', label: '微信默认', lineHeight: 1.9, paraSpacing: 0.6, marginX: 20, letterSpacing: 0.015 },
  { id: 'loose', label: '宽松', lineHeight: 2.08, paraSpacing: 1.15, marginX: 28, letterSpacing: 0.025 },
]

export function resolveFontStack(fontId) {
  const hit = WEREAD_FONTS.find(f => f.id === fontId)
  return hit ? hit.stack : WEREAD_FONTS[0].stack
}

const COVER_PALETTES = [
  { bg: 'linear-gradient(145deg, #2b3a4a 0%, #1d2833 100%)', fg: '#f4efe6', accent: '#d4b483' },
  { bg: 'linear-gradient(145deg, #4a3531 0%, #2f201d 100%)', fg: '#f7efe8', accent: '#e0a96d' },
  { bg: 'linear-gradient(145deg, #2d4239 0%, #1c2b24 100%)', fg: '#eef3ef', accent: '#a3c9a8' },
  { bg: 'linear-gradient(145deg, #3d354b 0%, #251f30 100%)', fg: '#f2eef7', accent: '#c8b6e2' },
  { bg: 'linear-gradient(145deg, #4b4234 0%, #30291f 100%)', fg: '#f7f3eb', accent: '#d8c39e' },
  { bg: 'linear-gradient(145deg, #263f4d 0%, #172730 100%)', fg: '#edf4f7', accent: '#90bfd6' },
]

export function bookCoverPalette(title = '', isEink = false) {
  if (isEink) {
    return { bg: '#ffffff', fg: '#000000', accent: '#000000', eink: true }
  }
  const str = String(title || 'book')
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return COVER_PALETTES[Math.abs(h) % COVER_PALETTES.length]
}

export function stripMarkdownForSearch(raw) {
  return String(raw ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s*|>\s?)/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function searchBookContent(reading, query, { maxMatches = 200, view = 'all' } = {}) {
  const parsed = parseMobileSearchQuery(query)
  if (!reading || !parsed.lower) return { totalMatches: 0, truncated: false, matches: [] }

  const findHit = plain => {
    const hay = plain.toLowerCase()
    const pos = hay.indexOf(parsed.lower)
    if (pos >= 0) {
      let count = 0
      let cur = 0
      const step = Math.max(1, parsed.lower.length)
      while ((cur = hay.indexOf(parsed.lower, cur)) >= 0) { count++; cur += step }
      return { firstIdx: pos, matchLen: parsed.lower.length, count }
    }
    if (parsed.tokens.length <= 1) return null
    let firstIdx = -1
    let matchLen = 0
    let count = 0
    for (const tok of parsed.tokens) {
      const idx = hay.indexOf(tok)
      if (idx < 0) return null
      if (firstIdx < 0 || idx < firstIdx) { firstIdx = idx; matchLen = tok.length }
      let cur = 0
      while ((cur = hay.indexOf(tok, cur)) >= 0) { count++; cur += Math.max(1, tok.length) }
    }
    return { firstIdx, matchLen, count: Math.max(1, count) }
  }

  const chapterMap = (outline, blocks) => {
    const byId = new Map((blocks || []).map((b, i) => [b.id, i]))
    return (outline || [])
      .map(it => ({
        idx: byId.get(it.id),
        label: String(it.label || '').replace(/\s*\((?:部扉页|篇扉页|扉页)\)/g, '').trim(),
      }))
      .filter(x => x.idx !== undefined)
      .sort((a, b) => a.idx - b.idx)
  }
  const labelAt = (entries, i) => {
    let lbl = ''
    for (const e of entries) {
      if (e.idx > i) break
      if (e.label) lbl = e.label
    }
    return lbl
  }

  let totalMatches = 0
  const matches = []
  const scan = (blocks, outline, hiddenSet, targetView, getRaw, getId) => {
    if (view !== 'all' && view !== targetView) return
    const chapters = chapterMap(outline, blocks)
    ;(blocks || []).forEach((b, idx) => {
      if (!b || hiddenSet.has(b.id)) return
      const plain = stripMarkdownForSearch(getRaw(b))
      if (!plain) return
      const hit = findHit(plain)
      if (!hit) return
      totalMatches += hit.count
      if (matches.length < maxMatches) {
        const s0 = Math.max(0, hit.firstIdx - 32)
        const s1 = Math.min(plain.length, hit.firstIdx + hit.matchLen + 32)
        const pre = s0 > 0 ? '…' : ''
        const suf = s1 < plain.length ? '…' : ''
        matches.push({
          blockId: getId(b),
          view: targetView,
          chapterLabel: labelAt(chapters, idx),
          snippet: pre + plain.slice(s0, s1) + suf,
          matchOffset: pre.length + (hit.firstIdx - s0),
          matchLen: hit.matchLen,
          matchCount: hit.count,
        })
      }
    })
  }

  const hiddenMain = new Set(reading.hiddenBlocks ?? [])
  const hiddenOrig = new Set(reading.originalOutline?.hiddenBlocks ?? [])
  const hasStandalone = reading.standaloneView === 'translation' && Array.isArray(reading.originalBlocks)
  const hasTrans = hasStandalone || Boolean(reading.comparisonAvailable) || (reading.blocks || []).some(b => typeof b?.translation === 'string' && b.translation.trim())

  if (hasStandalone) {
    scan(reading.blocks, reading.outline, hiddenMain, 'translation', b => b.text, b => b.id)
    scan(reading.originalBlocks, reading.originalOutline?.outline ?? reading.outline, hiddenOrig, 'original', b => b.text, b => b.id)
  } else if (hasTrans) {
    scan(reading.blocks, reading.outline, hiddenMain, 'translation', b => b.translation ?? b.text, b => b.id)
    scan(reading.blocks, reading.originalOutline?.outline ?? reading.outline, hiddenOrig, 'original', b => b.sourceText ?? b.text, b => b.sourceBlockId ?? b.id)
  } else {
    scan(reading.blocks, reading.originalOutline?.outline ?? reading.outline, hiddenOrig, 'original', b => b.sourceText ?? b.text, b => b.id)
  }

  return { totalMatches, truncated: totalMatches > matches.length, matches }
}

export function renderSearchSnippetHtml(snippet, matchOffset, matchLen) {
  const text = String(snippet ?? '')
  if (!(matchLen > 0) || matchOffset < 0 || matchOffset >= text.length) {
    return escapeHtml(text)
  }
  return (
    escapeHtml(text.slice(0, matchOffset))
    + `<mark class="wr-markSearch">${escapeHtml(text.slice(matchOffset, matchOffset + matchLen))}</mark>`
    + escapeHtml(text.slice(matchOffset + matchLen))
  )
}

export function renderLibrarySearchSectionHtml(searchState, shelfQuery, titleMatches = []) {
  const q = String(shelfQuery ?? '').trim()
  if (!q) return ''
  const data = searchState?.data
  const results = (data?.results ?? []).filter(r => r.matches?.length > 0)
  return `
    <div class="wr-libSearchSection">
      <div class="wr-barRow" style="margin-bottom:8px;gap:8px;">
        <button type="button" class="wr-btnGhost" data-act="clear-shelf-search" style="padding:4px 10px;font-size:12px;">← 返回书架</button>
        <span style="font-size:11.5px;color:var(--fg-muted);flex:1;text-align:right;">
          ${searchState?.loading ? '正在检索全库原文与译文…' : `书名 ${titleMatches.length} 部 · 正文 ${data?.totalMatches || 0} 处`}
        </span>
      </div>
      ${titleMatches.length ? `
        <div style="font-size:12px;font-weight:700;color:var(--fg-muted);margin:2px 0 6px;">书名 / 作者命中 (${titleMatches.length})</div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
          ${titleMatches.slice(0, 20).map(d => `
            <div class="wr-libSearchBookCard" data-open-book="${escapeHtml(d.id)}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="min-width:0;">
                <div class="wr-libSearchBookName">${escapeHtml(d.name)}</div>
                ${d.author ? `<div style="font-size:11px;color:var(--fg-muted);">${escapeHtml(d.author)}</div>` : ''}
              </div>
              <span class="wr-badge">打开</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div style="font-size:12px;font-weight:700;color:var(--fg-muted);margin:2px 0 6px;">全库正文检索 (${data?.totalMatches || 0})${data?.offlineOnly ? ' · 离线缓存' : ''}</div>
      ${
        !searchState?.loading && data && !results.length
          ? '<div style="font-size:12px;color:var(--fg-muted);padding:6px 0;">全库已索引正文中未找到匹配内容</div>'
          : results.map(book => `
            <div class="wr-libSearchBookCard">
              <div class="wr-barRow" style="margin-bottom:4px;">
                <span class="wr-libSearchBookName" data-open-book="${escapeHtml(book.id)}">${escapeHtml(book.name)}</span>
                <span class="wr-badge">${book.totalMatches} 处</span>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px;">
                ${book.matches.map(h => `
                  <button type="button" class="wr-libSearchHitBtn" data-search-jump="${escapeHtml(book.id)}" data-jump-block="${escapeHtml(h.blockId)}" data-jump-view="${escapeHtml(h.view)}">
                    <span class="wr-searchTag">${h.view === 'original' ? '原文' : '译文'}</span>
                    ${h.chapterLabel ? `<span class="wr-searchChapter">${escapeHtml(h.chapterLabel)}</span>` : ''}
                    <span class="wr-searchSnippetText">${renderSearchSnippetHtml(h.snippet, h.matchOffset, h.matchLen)}</span>
                  </button>
                `).join('')}
              </div>
            </div>
          `).join('')
      }
    </div>
  `
}

function formatSyncTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const now = new Date()
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    if (d.toDateString() === now.toDateString()) return `今天 ${hhmm}`
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return ''
  }
}

export function renderSyncStatusCardHtml({
  syncing = false,
  syncProgress = null,
  syncStatus = null,
  cachedMd = 0,
  totalDocs = 0,
  cachedPdf = 0,
  totalPdfDocs = 0,
  outboxCount = 0,
  serverConfigured = false,
  hasCancel = false,
  showActions = true,
}) {
  if (syncing) {
    const p = syncProgress || {}
    const total = Number(p.total) || 0
    const done = Number(p.done) || 0
    const pct = p.pct !== undefined
      ? Math.max(0, Math.min(100, Number(p.pct)))
      : total > 0
        ? Math.max(4, Math.min(100, Math.round((done / total) * 100)))
        : 12
    const stats = [
      total > 0 ? `${done}/${total}` : '',
      p.skipped > 0 ? `一致跳过 ${p.skipped}` : '',
      p.failed > 0 ? `失败 ${p.failed}` : '',
    ].filter(Boolean).join(' · ')
    return `
      <div class="wr-syncCard active">
        <div class="wr-barRow" style="gap:8px;">
          <span class="wr-syncDot running"></span>
          <strong style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.phaseLabel || '正在与云端同步...')}</strong>
          <span style="font-size:12px;font-weight:700;color:var(--accent);">${pct}%</span>
          ${hasCancel ? '<button type="button" class="wr-btnGhost" data-act="cancel-sync" style="padding:3px 9px;font-size:11px;">取消</button>' : ''}
        </div>
        <div class="wr-syncProgressTrack"><div class="wr-syncProgressFill" style="width:${pct}%"></div></div>
        <div class="wr-barRow" style="font-size:11.5px;color:var(--fg-muted);gap:8px;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.title ? `当前：${p.title}` : (p.message || '正在处理中...'))}</span>
          ${stats ? `<span style="flex-shrink:0;">${escapeHtml(stats)}</span>` : ''}
        </div>
      </div>
    `
  }

  const timeText = formatSyncTime(syncStatus?.at)
  if (syncStatus && syncStatus.ok === false) {
    return `
      <div class="wr-syncCard error">
        <div class="wr-barRow" style="gap:8px;">
          <span class="wr-syncDot error"></span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:600;">${syncStatus.aborted ? '同步已取消' : '同步失败'}${timeText ? ` · ${escapeHtml(timeText)}` : ''}</div>
            <div style="font-size:11.5px;color:var(--fg-muted);word-break:break-word;margin-top:2px;">${escapeHtml(syncStatus.error || '无法连接云服务器')}</div>
          </div>
          ${showActions ? '<button type="button" class="wr-btnGhost" data-act="sync-now" style="padding:4px 10px;font-size:12px;flex-shrink:0;">重试</button>' : ''}
        </div>
      </div>
    `
  }

  if (syncStatus?.at) {
    const changes = [
      syncStatus.addedBooks ? `新增 ${syncStatus.addedBooks}` : '',
      syncStatus.renamedBooks ? `改名 ${syncStatus.renamedBooks}` : '',
      syncStatus.syncedBooks ? `更新正文 ${syncStatus.syncedBooks}` : '',
      syncStatus.syncedPdfs ? `新下 PDF ${syncStatus.syncedPdfs}` : '',
      syncStatus.removedBooks ? `清理已删 ${syncStatus.removedBooks}` : '',
      !syncStatus.addedBooks && !syncStatus.renamedBooks && !syncStatus.syncedBooks && !syncStatus.syncedPdfs && !syncStatus.removedBooks
        ? `全部已是最新 (${syncStatus.totalDocs ?? totalDocs} 本)`
        : '',
      syncStatus.failedBooks ? `正文失败 ${syncStatus.failedBooks}` : '',
      syncStatus.failedPdfs ? `PDF失败 ${syncStatus.failedPdfs}` : '',
    ].filter(Boolean)
    return `
      <div class="wr-syncCard">
        <div class="wr-barRow" style="gap:8px;">
          <span class="wr-syncDot ok"></span>
          <span style="font-size:12px;font-weight:600;flex:1;">已同步 · ${escapeHtml(timeText || '刚刚')}</span>
          <span style="font-size:11.5px;color:var(--fg-muted);">MD ${cachedMd}/${totalDocs} · PDF ${cachedPdf}/${totalPdfDocs}${outboxCount ? ` · 待传 ${outboxCount}` : ''}</span>
        </div>
        <div class="wr-syncBadges">
          ${changes.map(c => `<span class="wr-syncBadge">${escapeHtml(c)}</span>`).join('')}
        </div>
      </div>
    `
  }

  return `
    <div class="wr-syncCard">
      <div class="wr-barRow" style="gap:8px;">
        <span class="wr-syncDot idle"></span>
        <span style="font-size:12px;color:var(--fg-muted);flex:1;">
          ${serverConfigured ? '尚未同步（点击右上角「↻ 同步」或下方按钮获取云端书库）' : '尚未连接云服务器（点击进入「设置」填地址与密钥）'}
        </span>
        ${showActions ? `<button type="button" class="wr-btnGhost" data-act="${serverConfigured ? 'sync-now' : 'goto-settings'}" style="padding:4px 10px;font-size:12px;flex-shrink:0;">${serverConfigured ? '立即同步' : '去设置'}</button>` : ''}
      </div>
    </div>
  `
}

