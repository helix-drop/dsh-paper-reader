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

function renderInlineFragment(raw, { noteNumbers, view, blockId }) {
  // Tokenize images, footnotes, links, bold/italic/code safely
  const tokens = []
  const re = /!\[([^\]]*)\]\(([^)]+)\)|\[\^([^\]]+)\](?!:)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  let out = ''
  for (const m of raw.matchAll(re)) {
    out += escapeHtml(raw.slice(last, m.index))
    if (m[2] !== undefined) {
      out += `<img data-asset-ref="${escapeHtml(m[2])}" alt="${escapeHtml(m[1])}" loading="lazy" />`
    } else if (m[3] !== undefined) {
      const fnId = m[3]
      const label = noteNumbers?.get(fnId) ?? fnId
      out += `<button type="button" class="wr-fnRef" data-fn-id="${escapeHtml(fnId)}" data-fn-view="${escapeHtml(view)}" data-fn-block="${escapeHtml(blockId)}">${escapeHtml(label)}</button>`
    } else if (m[4] !== undefined) {
      out += `<span class="wr-linkText">${escapeHtml(m[4])}</span>`
    } else if (m[6] !== undefined) {
      out += `<code>${escapeHtml(m[6])}</code>`
    } else if (m[7] !== undefined) {
      out += `<strong>${escapeHtml(m[7])}</strong>`
    } else if (m[8] !== undefined) {
      out += `<em>${escapeHtml(m[8])}</em>`
    }
    last = m.index + m[0].length
  }
  out += escapeHtml(raw.slice(last))
  void tokens
  return out
}

function renderWithHighlights(raw, marks, opts) {
  if (!marks?.length) return renderInlineFragment(raw, opts)
  const spans = []
  for (const mark of marks) {
    for (const [start, end] of matchQuoteRanges(raw, mark.quote)) {
      spans.push({ start, end, kind: mark.kind })
    }
  }
  if (!spans.length) return renderInlineFragment(raw, opts)
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const s of spans) {
    const last = merged.at(-1)
    if (!last || s.start >= last.end) merged.push({ ...s })
    else {
      last.end = Math.max(last.end, s.end)
      if (s.kind === 'bookmark') last.kind = 'bookmark'
    }
  }
  let cursor = 0
  let html = ''
  for (const s of merged) {
    if (s.start > cursor) html += renderInlineFragment(raw.slice(cursor, s.start), opts)
    const cls = s.kind === 'bookmark' ? 'wr-markBookmark' : 'wr-markHighlight'
    html += `<mark class="${cls}">${renderInlineFragment(raw.slice(s.start, s.end), opts)}</mark>`
    cursor = s.end
  }
  if (cursor < raw.length) html += renderInlineFragment(raw.slice(cursor), opts)
  return html
}

export function renderBlockBodyHtml(rawText, block, { view, marks = [], noteNumbers, showDrawerTrigger = false }) {
  const raw = String(rawText ?? '')
  const trimmed = raw.trim()
  const opts = { view, blockId: block.id, noteNumbers }
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

