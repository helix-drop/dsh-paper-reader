export function plainSearchText(raw) {
  return String(raw ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s*|>\s?)/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeOutlineChapterMap(outline = [], blocks = []) {
  const indexById = new Map()
  blocks.forEach((b, idx) => {
    if (b?.id != null) indexById.set(String(b.id), idx)
  })
  const entries = []
  for (const item of outline ?? []) {
    if (!item || item.id == null) continue
    const idx = indexById.get(String(item.id))
    if (idx === undefined) continue
    entries.push({
      idx,
      level: Number(item.level) || 1,
      label: String(item.label ?? '').replace(/\s*\((?:部扉页|篇扉页|扉页)\)/g, '').trim(),
    })
  }
  entries.sort((a, b) => a.idx - b.idx)
  return entries
}

export function chapterLabelForIndex(chapterEntries, blockIdx) {
  if (!chapterEntries?.length) return ''
  let nearestTop = ''
  let nearestAny = ''
  for (const entry of chapterEntries) {
    if (entry.idx > blockIdx) break
    if (entry.label) {
      nearestAny = entry.label
      if (entry.level <= 1) nearestTop = entry.label
    }
  }
  return nearestAny || nearestTop || ''
}

function parseQueryTerms(query) {
  const normalized = String(query ?? '').trim().replace(/\s+/g, ' ')
  if (!normalized) return { raw: '', lower: '', tokens: [] }
  const lower = normalized.toLowerCase()
  const tokens = [...new Set(lower.split(' ').filter(Boolean))]
  return { raw: normalized, lower, tokens }
}

function findBlockMatches(plain, parsed) {
  if (!plain || !parsed.lower) return null
  const hay = plain.toLowerCase()
  const phraseIdx = hay.indexOf(parsed.lower)
  if (phraseIdx >= 0) {
    let count = 0
    let cursor = 0
    const step = Math.max(1, parsed.lower.length)
    while (true) {
      const pos = hay.indexOf(parsed.lower, cursor)
      if (pos < 0) break
      count += 1
      cursor = pos + step
    }
    return {
      firstIdx: phraseIdx,
      matchLen: parsed.lower.length,
      count,
      score: 100 + count,
    }
  }
  if (parsed.tokens.length <= 1) return null
  let firstIdx = -1
  let matchLen = 0
  let totalCount = 0
  for (const tok of parsed.tokens) {
    const pos = hay.indexOf(tok)
    if (pos < 0) return null
    if (firstIdx < 0 || pos < firstIdx) {
      firstIdx = pos
      matchLen = tok.length
    }
    let cursor = 0
    while (true) {
      const hit = hay.indexOf(tok, cursor)
      if (hit < 0) break
      totalCount += 1
      cursor = hit + Math.max(1, tok.length)
    }
  }
  return {
    firstIdx,
    matchLen,
    count: Math.max(1, totalCount),
    score: 20 + totalCount,
  }
}

export function buildSearchSnippet(plain, matchIdx, matchLen, radius = 44) {
  const safeStart = Math.max(0, matchIdx - radius)
  const safeEnd = Math.min(plain.length, matchIdx + matchLen + radius)
  const prefix = safeStart > 0 ? '…' : ''
  const suffix = safeEnd < plain.length ? '…' : ''
  const body = plain.slice(safeStart, safeEnd)
  return {
    snippet: prefix + body + suffix,
    matchOffset: prefix.length + (matchIdx - safeStart),
    matchLen,
  }
}

export function buildDocumentSearchIndex(doc) {
  if (!doc || typeof doc !== 'object') {
    return { translation: [], original: [] }
  }
  const hasStandaloneOrig = doc.standaloneView === 'translation' && Array.isArray(doc.originalBlocks)
  const mainBlocks = Array.isArray(doc.blocks) ? doc.blocks : []
  const hiddenMain = new Set(doc.hiddenBlocks ?? [])
  const hiddenOrig = new Set(doc.originalOutline?.hiddenBlocks ?? [])
  const hasTranslation = doc.standaloneView === 'translation'
    || Boolean(doc.comparisonAvailable)
    || mainBlocks.some(b => typeof b?.translation === 'string' && b.translation.trim())

  const translation = []
  const original = []

  if (hasStandaloneOrig) {
    const transChapters = normalizeOutlineChapterMap(doc.outline, mainBlocks)
    mainBlocks.forEach((b, idx) => {
      if (!b || hiddenMain.has(b.id)) return
      const plain = plainSearchText(b.text)
      if (!plain) return
      translation.push({
        blockId: b.id,
        view: 'translation',
        chapterLabel: chapterLabelForIndex(transChapters, idx),
        plain,
      })
    })
    const origChapters = normalizeOutlineChapterMap(doc.originalOutline?.outline ?? doc.outline, doc.originalBlocks)
    doc.originalBlocks.forEach((b, idx) => {
      if (!b || hiddenOrig.has(b.id)) return
      const plain = plainSearchText(b.text)
      if (!plain) return
      original.push({
        blockId: b.id,
        view: 'original',
        chapterLabel: chapterLabelForIndex(origChapters, idx),
        plain,
      })
    })
  } else if (hasTranslation) {
    const transChapters = normalizeOutlineChapterMap(doc.outline, mainBlocks)
    const origChapters = normalizeOutlineChapterMap(doc.originalOutline?.outline ?? doc.outline, mainBlocks)
    mainBlocks.forEach((b, idx) => {
      if (!b) return
      if (!hiddenMain.has(b.id)) {
        const transPlain = plainSearchText(b.translation ?? b.text)
        if (transPlain) {
          translation.push({
            blockId: b.id,
            view: 'translation',
            chapterLabel: chapterLabelForIndex(transChapters, idx),
            plain: transPlain,
          })
        }
      }
      if (!hiddenOrig.has(b.id)) {
        const origRaw = b.sourceText ?? b.text
        const origPlain = plainSearchText(origRaw)
        if (origPlain) {
          original.push({
            blockId: b.sourceBlockId ?? b.id,
            view: 'original',
            chapterLabel: chapterLabelForIndex(origChapters, idx),
            plain: origPlain,
          })
        }
      }
    })
  } else {
    const origChapters = normalizeOutlineChapterMap(doc.originalOutline?.outline ?? doc.outline, mainBlocks)
    mainBlocks.forEach((b, idx) => {
      if (!b || hiddenOrig.has(b.id)) return
      const plain = plainSearchText(b.sourceText ?? b.text)
      if (!plain) return
      original.push({
        blockId: b.id,
        view: 'original',
        chapterLabel: chapterLabelForIndex(origChapters, idx),
        plain,
      })
    })
  }

  return { translation, original }
}

export function searchIndexedDocument(index, query, options = {}) {
  const parsed = parseQueryTerms(query)
  if (!parsed.lower) {
    return { totalMatches: 0, truncated: false, matches: [] }
  }
  const viewFilter = options.view === 'original' || options.view === 'translation' ? options.view : 'all'
  const maxMatches = Math.max(1, Math.min(500, Number(options.maxMatchesPerBook) || 8))
  const lists = []
  if (viewFilter !== 'original') lists.push(...(index?.translation ?? []))
  if (viewFilter !== 'translation') lists.push(...(index?.original ?? []))

  let totalMatches = 0
  const collected = []
  for (const item of lists) {
    const hit = findBlockMatches(item.plain, parsed)
    if (!hit) continue
    totalMatches += hit.count
    if (collected.length < maxMatches * 4) {
      const snip = buildSearchSnippet(item.plain, hit.firstIdx, hit.matchLen)
      collected.push({
        blockId: item.blockId,
        view: item.view,
        chapterLabel: item.chapterLabel,
        snippet: snip.snippet,
        matchOffset: snip.matchOffset,
        matchLen: snip.matchLen,
        matchCount: hit.count,
        _score: hit.score,
      })
    }
  }
  collected.sort((a, b) => b._score - a._score)
  const matches = collected.slice(0, maxMatches).map(({ _score, ...rest }) => rest)
  return {
    totalMatches,
    truncated: totalMatches > matches.length,
    matches,
  }
}

export function searchReadingDocument(doc, query, options = {}) {
  return searchIndexedDocument(buildDocumentSearchIndex(doc), query, options)
}

export function createLibrarySearcher({ maxCached = 200 } = {}) {
  const cache = new Map()

  function getCached(id, stamp, loadReading) {
    const key = String(id)
    const cached = cache.get(key)
    if (cached && (!stamp || cached.stamp === stamp)) {
      cache.delete(key)
      cache.set(key, cached)
      return cached.index
    }
    return null
  }

  function putCached(id, stamp, index) {
    const key = String(id)
    if (cache.has(key)) cache.delete(key)
    cache.set(key, { stamp: stamp ?? '', index })
    while (cache.size > maxCached) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  return async function searchLibrary({
    documents = [],
    loadDoc,
    query = '',
    taskId = '',
    view = 'all',
    limitBooks = 30,
    maxMatchesPerBook = 6,
  } = {}) {
    const parsed = parseQueryTerms(query)
    if (!parsed.lower) {
      return { query: '', totalBooks: 0, totalMatches: 0, results: [] }
    }
    const targetDocs = taskId
      ? documents.filter(d => d.id === taskId || d.documentId === taskId)
      : documents
    const perBookCap = taskId ? Math.max(50, Number(maxMatchesPerBook) || 200) : Math.max(1, Number(maxMatchesPerBook) || 6)

    const results = []
    let totalMatches = 0

    for (const meta of targetDocs) {
      if (!meta?.id) continue
      const titleHay = [meta.name, meta.author, meta.titleSource].filter(Boolean).join(' ')
      const titleMatched = Boolean(findBlockMatches(titleHay, parsed))

      const knownStamp = String(meta.stamp ?? meta.version ?? meta.updatedAt ?? '')
      let index = knownStamp ? getCached(meta.id, knownStamp) : null
      if (!index) {
        let loaded = null
        try { loaded = await loadDoc(meta) } catch { loaded = null }
        if (loaded?.reading) {
          index = buildDocumentSearchIndex(loaded.reading)
          const stamp = String(loaded.stamp ?? loaded.reading.version ?? knownStamp ?? '')
          putCached(meta.id, stamp, index)
        }
      }

      const bodyRes = index
        ? searchIndexedDocument(index, query, { view, maxMatchesPerBook: perBookCap })
        : { totalMatches: 0, truncated: false, matches: [] }

      if (!titleMatched && bodyRes.totalMatches === 0) continue

      totalMatches += bodyRes.totalMatches
      results.push({
        id: meta.id,
        documentId: meta.documentId ?? null,
        name: meta.name ?? '未命名文献',
        author: meta.author ?? '',
        titleSource: meta.titleSource ?? '',
        kind: meta.kind ?? 'paper',
        titleMatched,
        totalMatches: bodyRes.totalMatches,
        truncated: bodyRes.truncated,
        matches: bodyRes.matches,
      })
    }

    results.sort((a, b) => (
      (b.totalMatches - a.totalMatches)
      || (Number(b.titleMatched) - Number(a.titleMatched))
      || String(a.name).localeCompare(String(b.name), 'zh')
    ))

    const capped = results.slice(0, Math.max(1, Number(limitBooks) || 30))
    return {
      query: parsed.raw,
      totalBooks: results.length,
      totalMatches,
      results: capped,
    }
  }
}
