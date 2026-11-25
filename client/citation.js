// 学术引用生成模块 — 移植并扩展自 douban-book-plus/citation.js
// 支持中文格式（GB/T 7714-2015、《社会》、《社会学评论》）、英文格式（APA、MLA、Chicago）
// 与通用格式（BibTeX、RIS、Markdown），完整覆盖专著 [M]、期刊论文 [J]、论文集编著 [C]、论文集析出文献 [C]//。

const CITE_NON_ASCII = str => [...String(str || '')].some(ch => ch.charCodeAt(0) > 127)
const CITE_IS_CJK = str => /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(String(str || ''))

function citeParseNameList(raw) {
  if (Array.isArray(raw)) raw = raw.join(';')
  return String(raw || '')
    .split(/[;；/／,，、]/)
    .map(n => n.trim())
    .filter(n => n.length > 0)
    .map(n => {
      let cleaned = n.replace(/[\[【].*?[\]】]/g, '').trim()
      if (CITE_IS_CJK(cleaned)) cleaned = cleaned.replace(/\s+/g, '')
      return cleaned
    })
    .filter(n => n.length > 0)
}

function citeExtractYear(raw) {
  const m = String(raw || '').match(/(\d{4})/)
  return m ? m[1] : ''
}

function citeForeignSurnameOnly(name) {
  if (name.includes('·') || name.includes('・')) return name.split(/[·・]/).pop().trim()
  return name
}

function citeReverseForeignName(name) {
  if (name.includes('·') || name.includes('・')) {
    const parts = name.split(/[·・]/)
    const surname = parts.pop().trim()
    const given = parts.map(p => p.trim()).join('·')
    return `${surname},${given}`
  }
  return name
}

function citeReverseFirstAuthor(authors) {
  return authors.map((a, i) => (i === 0 ? citeReverseForeignName(a) : a))
}

function citeEscHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function citeJoinPubYear(pub, year, sep) {
  return [pub, year].filter(Boolean).join(sep)
}

function normalizeCitationInfo(raw = {}) {
  const title = String(raw.title || '').trim()
  const subtitle = String(raw.subtitle || '').trim()
  const fullTitle = subtitle ? `${title}：${subtitle}` : title
  const originalTitle = String(raw.originalTitle || raw.original_title || '').trim()
  const bookTitle = String(raw.bookTitle || raw.book_title || '').trim()
  const originalBookTitle = String(raw.originalBookTitle || raw.original_book_title || '').trim()
  const authors = citeParseNameList(raw.authors)
  const editors = citeParseNameList(raw.editors)
  const translators = citeParseNameList(raw.translators)
  const rawKind = String(raw.kind || '').toLowerCase()
  const kind = ['book', 'paper', 'collection', 'incollection'].includes(rawKind)
    ? rawKind
    : rawKind === 'chapter' ? 'incollection' : 'book'
  const year = citeExtractYear(raw.year)
  const pages = String(raw.pages || '').trim().replace(/^pp?\.?\s*/i, '').replace(/–|—/g, '-')
  return {
    kind,
    title,
    subtitle,
    fullTitle: fullTitle || originalTitle || '未命名文献',
    originalTitle,
    bookTitle,
    originalBookTitle,
    authors,
    editors,
    translators,
    publisher: String(raw.publisher || '').trim(),
    journal: String(raw.journal || '').trim(),
    year,
    volume: String(raw.volume || '').trim(),
    issue: String(raw.issue || '').trim(),
    pages,
    isbn: String(raw.isbn || '').trim(),
    doi: String(raw.doi || '').trim(),
    isChinese: CITE_IS_CJK(title || fullTitle),
  }
}

function citeSplitLatinName(name) {
  const s = String(name || '').trim()
  if (!s || CITE_IS_CJK(s) || s.includes('·') || s.includes('・')) return null
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',').map(x => x.trim()).filter(Boolean)
    return { last, given: rest.join(' ') }
  }
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  const particles = new Set(['de', 'du', 'des', 'la', 'le', 'von', 'van', 'der', 'den', 'da', 'di', 'del', 'della'])
  let cut = parts.length - 1
  while (cut > 1 && particles.has(parts[cut - 1].toLowerCase())) cut--
  return { given: parts.slice(0, cut).join(' '), last: parts.slice(cut).join(' ') }
}

function citeLatinInitials(given) {
  return String(given || '').split(/\s+/).filter(Boolean).map(p => (
    p.includes('-') ? p.split('-').filter(Boolean).map(x => `${x[0].toUpperCase()}.`).join('-') : `${p[0].toUpperCase()}.`
  )).join(' ')
}

function citeFormatSingleEnName(name, mode) {
  const parsed = citeSplitLatinName(name)
  if (!parsed) return name
  if (mode === 'apa') return `${parsed.last}, ${citeLatinInitials(parsed.given)}`
  if (mode === 'apa-editor') return `${citeLatinInitials(parsed.given)} ${parsed.last}`
  if (mode === 'invert') return `${parsed.last}, ${parsed.given}`
  return `${parsed.given} ${parsed.last}`
}

function citeFormatEnAuthors(authors, style, opts = {}) {
  if (authors.length === 0) return ''
  const normalOrder = Boolean(opts.normalOrder)
  const list = authors.map((a, i) => {
    if (style === 'apa') return citeFormatSingleEnName(a, normalOrder ? 'apa-editor' : 'apa')
    return citeFormatSingleEnName(a, !normalOrder && i === 0 ? 'invert' : 'normal')
  })
  if (list.length === 1) return list[0]
  if (style === 'apa') {
    if (list.length === 2) return `${list[0]}, & ${list[1]}`
    return `${list.slice(0, -1).join(', ')}, & ${list[list.length - 1]}`
  }
  if (style === 'mla') {
    if (list.length === 2) return `${list[0]}, and ${list[1]}`
    return `${list[0]}, et al.`
  }
  if (list.length <= 3) return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
  return `${list[0]} et al.`
}

function citePagePrefixEn(pages) {
  if (!pages) return ''
  return /[-,]/.test(pages) ? `pp. ${pages}` : `p. ${pages}`
}

function citeGbtNames(list) {
  const mapped = list.map(citeForeignSurnameOnly)
  return mapped.length > 3 ? mapped.slice(0, 3).join('，') + '，等' : mapped.join('，')
}

function formatCiteGBT7714(info) {
  const pubYear = citeJoinPubYear(info.publisher, info.year, '，')
  if (info.kind === 'incollection') {
    const authors = citeGbtNames(info.authors)
    const editors = citeGbtNames(info.editors)
    const hostTitle = info.bookTitle || info.originalBookTitle
    const typeTag = editors ? '[C]//' : '[M]//'
    const hostHead = editors ? `${editors}，编. ${hostTitle}` : hostTitle
    const parts = []
    if (authors) parts.push(`${authors}.`)
    parts.push(`${info.fullTitle}${typeTag}${hostHead || ''}.`.replace(/\/\/\./, '.'))
    if (info.translators.length > 0) parts.push(`${info.translators.join('，')}，译.`)
    if (pubYear) parts.push(info.pages ? `${pubYear}: ${info.pages}.` : `${pubYear}.`)
    else if (info.pages) parts.push(`${info.pages}.`)
    const s = parts.join(' ')
    return { text: s, html: citeEscHtml(s) }
  }
  if (info.kind === 'collection') {
    const edList = info.editors.length ? info.editors : info.authors
    const eds = citeGbtNames(edList)
    const parts = []
    if (eds) parts.push(`${eds}，编.`)
    parts.push(`${info.fullTitle}[C].`)
    if (info.translators.length > 0) parts.push(`${info.translators.join('，')}，译.`)
    if (pubYear) parts.push(info.pages ? `${pubYear}: ${info.pages}.` : `${pubYear}.`)
    else if (info.pages) parts.push(`${info.pages}.`)
    const s = parts.join(' ')
    return { text: s, html: citeEscHtml(s) }
  }
  const authors = citeGbtNames(info.authors)
  const parts = []
  if (authors) parts.push(`${authors}.`)
  if (info.kind === 'paper') {
    parts.push(`${info.fullTitle}[J].`)
    if (info.translators.length > 0) parts.push(`${info.translators.join('，')}，译.`)
    const volIssue = info.volume && info.issue ? `${info.volume}(${info.issue})` : (info.volume || (info.issue ? `(${info.issue})` : ''))
    const venue = [info.journal || info.publisher, info.year, volIssue].filter(Boolean).join('，')
    if (venue) parts.push(info.pages ? `${venue}: ${info.pages}.` : `${venue}.`)
    else if (info.pages) parts.push(`${info.pages}.`)
  } else {
    parts.push(`${info.fullTitle}[M].`)
    if (info.translators.length > 0) parts.push(`${info.translators.join('，')}，译.`)
    if (pubYear) parts.push(info.pages ? `${pubYear}: ${info.pages}.` : `${pubYear}.`)
    else if (info.pages) parts.push(`${info.pages}.`)
  }
  const s = parts.join(' ')
  return { text: s, html: citeEscHtml(s) }
}

function formatCiteSociety(info) {
  if (info.kind === 'incollection') {
    const authors = citeReverseFirstAuthor(info.authors).join(',')
    const editors = citeReverseFirstAuthor(info.editors).join(',')
    const hostTitle = info.bookTitle || info.originalBookTitle
    const typeTag = editors ? '[C]//' : '[M]//'
    const hostPart = editors ? `${editors},编.${hostTitle}` : hostTitle
    const parts = [authors, info.year, `${info.fullTitle}${hostPart ? typeTag + hostPart : (editors ? '[C]' : '[M]')}`].filter(Boolean)
    if (info.translators.length > 0) parts.push(`${info.translators.join(',')},译`)
    if (info.publisher) parts.push(info.pages ? `${info.publisher}:${info.pages}` : info.publisher)
    else if (info.pages) parts.push(info.pages)
    const s = parts.join('.') + '.'
    return { text: s, html: citeEscHtml(s) }
  }
  if (info.kind === 'collection') {
    const edList = info.editors.length ? info.editors : info.authors
    const eds = edList.length ? `${citeReverseFirstAuthor(edList).join(',')},编` : ''
    const parts = [eds, info.year, `${info.fullTitle}[C]`].filter(Boolean)
    if (info.translators.length > 0) parts.push(`${info.translators.join(',')},译`)
    if (info.publisher) parts.push(info.pages ? `${info.publisher}:${info.pages}` : info.publisher)
    else if (info.pages) parts.push(info.pages)
    const s = parts.join('.') + '.'
    return { text: s, html: citeEscHtml(s) }
  }
  const authors = citeReverseFirstAuthor(info.authors).join(',')
  const typeTag = info.kind === 'paper' ? '[J]' : '[M]'
  const parts = [authors, info.year, `${info.fullTitle}${typeTag}`].filter(Boolean)
  if (info.translators.length > 0) parts.push(`${info.translators.join(',')},译`)
  if (info.kind === 'paper') {
    const venue = info.journal || info.publisher
    const volIssue = info.volume && info.issue ? `${info.volume}(${info.issue})` : (info.issue ? `(${info.issue})` : info.volume)
    const pub = [venue, volIssue].filter(Boolean).join(info.volume ? ',' : '')
    if (pub) parts.push(info.pages ? `${pub}:${info.pages}` : pub)
    else if (info.pages) parts.push(info.pages)
  } else if (info.publisher) {
    parts.push(info.pages ? `${info.publisher}:${info.pages}` : info.publisher)
  } else if (info.pages) {
    parts.push(info.pages)
  }
  const s = parts.join('.') + '.'
  return { text: s, html: citeEscHtml(s) }
}

function formatCiteSociologicalReview(info) {
  if (info.kind === 'incollection') {
    const authors = citeReverseFirstAuthor(info.authors).join(',')
    const editors = citeReverseFirstAuthor(info.editors).join(',')
    const hostTitle = info.bookTitle || info.originalBookTitle
    const hostSeg = hostTitle ? `载${editors ? editors + '编' : ''}《${hostTitle}》` : ''
    const parts = [authors, info.year, `《${info.fullTitle}》`, hostSeg].filter(Boolean)
    if (info.translators.length > 0) parts.push(`${info.translators.join(',')}译`)
    if (info.publisher) parts.push(info.pages ? `${info.publisher}，第${info.pages}页` : info.publisher)
    else if (info.pages) parts.push(`第${info.pages}页`)
    const s = parts.join('.') + '.'
    return { text: s, html: citeEscHtml(s) }
  }
  if (info.kind === 'collection') {
    const edList = info.editors.length ? info.editors : info.authors
    const eds = edList.length ? `${citeReverseFirstAuthor(edList).join(',')}编` : ''
    const parts = [eds, info.year, `《${info.fullTitle}》`].filter(Boolean)
    if (info.translators.length > 0) parts.push(`${info.translators.join(',')}译`)
    if (info.publisher) parts.push(info.pages ? `${info.publisher}，第${info.pages}页` : info.publisher)
    else if (info.pages) parts.push(`第${info.pages}页`)
    const s = parts.join('.') + '.'
    return { text: s, html: citeEscHtml(s) }
  }
  const authors = citeReverseFirstAuthor(info.authors).join(',')
  const parts = [authors, info.year, `《${info.fullTitle}》`].filter(Boolean)
  if (info.translators.length > 0) parts.push(`${info.translators.join(',')}译`)
  if (info.kind === 'paper') {
    const venue = info.journal ? `《${info.journal}》` : info.publisher
    const issue = info.issue ? `第${info.issue}期` : (info.volume ? `第${info.volume}卷` : '')
    const pub = [venue, issue].filter(Boolean).join('')
    if (pub) parts.push(info.pages ? `${pub}，第${info.pages}页` : pub)
    else if (info.pages) parts.push(`第${info.pages}页`)
  } else if (info.publisher) {
    parts.push(info.pages ? `${info.publisher}，第${info.pages}页` : info.publisher)
  } else if (info.pages) {
    parts.push(`第${info.pages}页`)
  }
  const s = parts.join('.') + '.'
  return { text: s, html: citeEscHtml(s) }
}

function formatCiteAPA(info) {
  const title = info.originalTitle || info.fullTitle
  if (info.kind === 'incollection') {
    const authors = citeFormatEnAuthors(info.authors, 'apa')
    const editors = citeFormatEnAuthors(info.editors, 'apa', { normalOrder: true })
    const edLabel = info.editors.length > 1 ? 'Eds.' : 'Ed.'
    const host = info.originalBookTitle || info.bookTitle
    const head = [authors, info.year ? `(${info.year})` : ''].filter(Boolean).join(' ')
    const inPartPlain = host
      ? `In ${editors ? `${editors} (${edLabel}), ` : ''}${host}${info.pages ? ` (${citePagePrefixEn(info.pages)})` : ''}.`
      : (info.pages ? `(${citePagePrefixEn(info.pages)}).` : '')
    const inPartHtml = host
      ? `In ${editors ? `${citeEscHtml(editors)} (${edLabel}), ` : ''}<span style="font-style:italic">${citeEscHtml(host)}</span>${info.pages ? ` (${citeEscHtml(citePagePrefixEn(info.pages))})` : ''}.`
      : (info.pages ? `(${citeEscHtml(citePagePrefixEn(info.pages))}).` : '')
    const pub = info.publisher ? ` ${info.publisher}.` : ''
    const text = `${head ? head + '. ' : ''}${title}.${inPartPlain ? ' ' + inPartPlain : ''}${pub}`
    const html = `${head ? citeEscHtml(head) + '. ' : ''}${citeEscHtml(title)}.${inPartHtml ? ' ' + inPartHtml : ''}${info.publisher ? ' ' + citeEscHtml(info.publisher) + '.' : ''}`
    return { text, html }
  }
  if (info.kind === 'collection') {
    const edList = info.editors.length ? info.editors : info.authors
    const eds = citeFormatEnAuthors(edList, 'apa')
    const edLabel = edList.length > 1 ? 'Eds.' : 'Ed.'
    const head = [eds ? `${eds} (${edLabel})` : '', info.year ? `(${info.year})` : ''].filter(Boolean).join('. ')
    const pageText = info.pages ? ` (${citePagePrefixEn(info.pages)})` : ''
    const tail = info.publisher ? ` ${info.publisher}.` : ''
    const text = `${head ? head + '. ' : ''}${title}${pageText}.${tail}`
    const html = `${head ? citeEscHtml(head) + '. ' : ''}<span style="font-style:italic">${citeEscHtml(title)}</span>${citeEscHtml(pageText)}.${info.publisher ? ' ' + citeEscHtml(info.publisher) + '.' : ''}`
    return { text, html }
  }
  const authors = citeFormatEnAuthors(info.authors, 'apa')
  const head = [authors, info.year ? `(${info.year})` : ''].filter(Boolean).join(' ')
  if (info.kind === 'paper') {
    const journal = info.journal || info.publisher
    const volIssue = info.volume && info.issue ? `${info.volume}(${info.issue})` : (info.volume || (info.issue ? `(${info.issue})` : ''))
    const venuePlain = [journal, volIssue, info.pages].filter(Boolean).join(', ')
    const venueHtml = [
      journal ? `<span style="font-style:italic">${citeEscHtml(journal)}</span>` : '',
      info.volume ? `<span style="font-style:italic">${citeEscHtml(info.volume)}</span>${info.issue ? `(${citeEscHtml(info.issue)})` : ''}` : (info.issue ? `(${citeEscHtml(info.issue)})` : ''),
      info.pages ? citeEscHtml(info.pages) : '',
    ].filter(Boolean).join(', ')
    const doiPart = info.doi ? ` https://doi.org/${info.doi.replace(/^https?:\/\/doi\.org\//i, '')}` : ''
    const text = `${head ? head + '. ' : ''}${title}.${venuePlain ? ' ' + venuePlain + '.' : ''}${doiPart}`
    const html = `${head ? citeEscHtml(head) + '. ' : ''}${citeEscHtml(title)}.${venueHtml ? ' ' + venueHtml + '.' : ''}${citeEscHtml(doiPart)}`
    return { text, html }
  }
  const pageText = info.pages ? ` (${citePagePrefixEn(info.pages)})` : ''
  const tail = info.publisher ? ` ${info.publisher}.` : ''
  const text = `${head ? head + '. ' : ''}${title}${pageText}.${tail}`
  const html = `${head ? citeEscHtml(head) + '. ' : ''}<span style="font-style:italic">${citeEscHtml(title)}</span>${citeEscHtml(pageText)}.${info.publisher ? ' ' + citeEscHtml(info.publisher) + '.' : ''}`
  return { text, html }
}

function formatCiteMLA(info) {
  const title = info.originalTitle || info.fullTitle
  const pageSeg = info.pages ? citePagePrefixEn(info.pages) : ''
  if (info.kind === 'incollection') {
    const authors = citeFormatEnAuthors(info.authors, 'mla')
    const editors = citeFormatEnAuthors(info.editors, 'mla', { normalOrder: true })
    const host = info.originalBookTitle || info.bookTitle
    const partsPlain = [host, editors ? `edited by ${editors}` : '', info.publisher, info.year, pageSeg].filter(Boolean).join(', ')
    const partsHtml = [
      host ? `<span style="font-style:italic">${citeEscHtml(host)}</span>` : '',
      editors ? `edited by ${citeEscHtml(editors)}` : '',
      citeEscHtml(info.publisher),
      citeEscHtml(info.year),
      citeEscHtml(pageSeg),
    ].filter(Boolean).join(', ')
    const text = `${authors ? authors + '. ' : ''}"${title}."${partsPlain ? ' ' + partsPlain + '.' : ''}`
    const html = `${authors ? citeEscHtml(authors) + '. ' : ''}&ldquo;${citeEscHtml(title)}.&rdquo;${partsHtml ? ' ' + partsHtml + '.' : ''}`
    return { text, html }
  }
  if (info.kind === 'collection') {
    const edList = info.editors.length ? info.editors : info.authors
    const eds = citeFormatEnAuthors(edList, 'mla')
    const edSuffix = edList.length > 1 ? 'editors' : 'editor'
    const head = eds ? `${eds}, ${edSuffix}. ` : ''
    const tail = [info.publisher, info.year, pageSeg].filter(Boolean).join(', ')
    const text = `${head}${title}.${tail ? ' ' + tail + '.' : ''}`
    const html = `${citeEscHtml(head)}<span style="font-style:italic">${citeEscHtml(title)}</span>.${tail ? ' ' + citeEscHtml(tail) + '.' : ''}`
    return { text, html }
  }
  const authors = citeFormatEnAuthors(info.authors, 'mla')
  if (info.kind === 'paper') {
    const journal = info.journal || info.publisher
    const partsPlain = [journal, info.volume ? `vol. ${info.volume}` : '', info.issue ? `no. ${info.issue}` : '', info.year, pageSeg].filter(Boolean).join(', ')
    const partsHtml = [
      journal ? `<span style="font-style:italic">${citeEscHtml(journal)}</span>` : '',
      info.volume ? `vol. ${citeEscHtml(info.volume)}` : '',
      info.issue ? `no. ${citeEscHtml(info.issue)}` : '',
      citeEscHtml(info.year),
      citeEscHtml(pageSeg),
    ].filter(Boolean).join(', ')
    const text = `${authors ? authors + '. ' : ''}"${title}."${partsPlain ? ' ' + partsPlain + '.' : ''}`
    const html = `${authors ? citeEscHtml(authors) + '. ' : ''}&ldquo;${citeEscHtml(title)}.&rdquo;${partsHtml ? ' ' + partsHtml + '.' : ''}`
    return { text, html }
  }
  const pubYear = [info.publisher, info.year, pageSeg].filter(Boolean).join(', ')
  const text = `${authors ? authors + '. ' : ''}${title}.${pubYear ? ' ' + pubYear + '.' : ''}`
  const html = `${authors ? citeEscHtml(authors) + '. ' : ''}<span style="font-style:italic">${citeEscHtml(title)}</span>.${pubYear ? ' ' + citeEscHtml(pubYear) + '.' : ''}`
  return { text, html }
}

function formatCiteChicago(info) {
  const title = info.originalTitle || info.fullTitle
  if (info.kind === 'incollection') {
    const authors = citeFormatEnAuthors(info.authors, 'chicago')
    const editors = citeFormatEnAuthors(info.editors, 'chicago', { normalOrder: true })
    const host = info.originalBookTitle || info.bookTitle
    const hostClausePlain = host ? `In ${host}${editors ? `, edited by ${editors}` : ''}${info.pages ? `, ${info.pages}` : ''}.` : (info.pages ? `${info.pages}.` : '')
    const hostClauseHtml = host
      ? `In <span style="font-style:italic">${citeEscHtml(host)}</span>${editors ? `, edited by ${citeEscHtml(editors)}` : ''}${info.pages ? `, ${citeEscHtml(info.pages)}` : ''}.`
      : (info.pages ? `${citeEscHtml(info.pages)}.` : '')
    const pubYear = [info.publisher, info.year].filter(Boolean).join(', ')
    const text = `${authors ? authors + '. ' : ''}"${title}."${hostClausePlain ? ' ' + hostClausePlain : ''}${pubYear ? ' ' + pubYear + '.' : ''}`
    const html = `${authors ? citeEscHtml(authors) + '. ' : ''}&ldquo;${citeEscHtml(title)}.&rdquo;${hostClauseHtml ? ' ' + hostClauseHtml : ''}${pubYear ? ' ' + citeEscHtml(pubYear) + '.' : ''}`
    return { text, html }
  }
  if (info.kind === 'collection') {
    const edList = info.editors.length ? info.editors : info.authors
    const eds = citeFormatEnAuthors(edList, 'chicago')
    const edSuffix = edList.length > 1 ? 'eds.' : 'ed.'
    const head = eds ? `${eds}, ${edSuffix} ` : ''
    const tail = [info.publisher, info.year, info.pages].filter(Boolean).join(', ')
    const text = `${head}${title}.${tail ? ' ' + tail + '.' : ''}`
    const html = `${citeEscHtml(head)}<span style="font-style:italic">${citeEscHtml(title)}</span>.${tail ? ' ' + citeEscHtml(tail) + '.' : ''}`
    return { text, html }
  }
  const authors = citeFormatEnAuthors(info.authors, 'chicago')
  if (info.kind === 'paper') {
    const journal = info.journal || info.publisher
    const volNo = [info.volume, info.issue ? `no. ${info.issue}` : ''].filter(Boolean).join(', ')
    const yr = info.year ? `(${info.year})` : ''
    const venueCore = [journal, volNo, yr].filter(Boolean).join(' ')
    const venuePlain = info.pages ? `${venueCore}${venueCore ? ': ' : ''}${info.pages}` : venueCore
    const venueCoreHtml = [
      journal ? `<span style="font-style:italic">${citeEscHtml(journal)}</span>` : '',
      citeEscHtml(volNo),
      citeEscHtml(yr),
    ].filter(Boolean).join(' ')
    const venueHtml = info.pages ? `${venueCoreHtml}${venueCoreHtml ? ': ' : ''}${citeEscHtml(info.pages)}` : venueCoreHtml
    const text = `${authors ? authors + '. ' : ''}"${title}."${venuePlain ? ' ' + venuePlain + '.' : ''}`
    const html = `${authors ? citeEscHtml(authors) + '. ' : ''}&ldquo;${citeEscHtml(title)}.&rdquo;${venueHtml ? ' ' + venueHtml + '.' : ''}`
    return { text, html }
  }
  const pubYear = [info.publisher, info.year].filter(Boolean).join(', ')
  const tail = [pubYear, info.pages].filter(Boolean).join(', ')
  const text = `${authors ? authors + '. ' : ''}${title}.${tail ? ' ' + tail + '.' : ''}`
  const html = `${authors ? citeEscHtml(authors) + '. ' : ''}<span style="font-style:italic">${citeEscHtml(title)}</span>.${tail ? ' ' + citeEscHtml(tail) + '.' : ''}`
  return { text, html }
}

function formatCiteBibTeX(info) {
  const namePool = info.kind === 'collection' && info.editors.length ? info.editors : info.authors
  const firstRaw = namePool[0] || ''
  const firstLast = citeSplitLatinName(firstRaw)?.last || citeReverseForeignName(firstRaw).split(',')[0] || 'unknown'
  const key = (firstLast.replace(/[^a-zA-Z\u4e00-\u9fff]/g, '') || info.kind) + (info.year || '')
  const title = info.originalTitle || info.fullTitle
  const entryType = info.kind === 'paper' ? 'article' : (info.kind === 'incollection' ? 'incollection' : 'book')
  const lines = [`@${entryType}{${key},`, `  title     = {${title}},`]
  if (info.kind !== 'collection' && info.authors.length) lines.push(`  author    = {${info.authors.map(citeReverseForeignName).join(' and ')}},`)
  if (info.editors.length) lines.push(`  editor    = {${info.editors.map(citeReverseForeignName).join(' and ')}},`)
  if (info.kind === 'incollection' && (info.originalBookTitle || info.bookTitle)) {
    lines.push(`  booktitle = {${info.originalBookTitle || info.bookTitle}},`)
  }
  if (info.year) lines.push(`  year      = {${info.year}},`)
  if (info.kind === 'paper' && info.journal) lines.push(`  journal   = {${info.journal}},`)
  if (info.publisher) lines.push(`  publisher = {${info.publisher}},`)
  if (info.volume) lines.push(`  volume    = {${info.volume}},`)
  if (info.issue) lines.push(`  number    = {${info.issue}},`)
  if (info.pages) lines.push(`  pages     = {${info.pages.replace('-', '--')}},`)
  if (info.isbn) lines.push(`  isbn      = {${info.isbn}},`)
  if (info.doi) lines.push(`  doi       = {${info.doi}},`)
  if (info.translators.length > 0) lines.push(`  translator = {${info.translators.join(' and ')}},`)
  lines.push('}')
  const s = lines.join('\n')
  return { text: s, html: `<pre style="margin:0">${citeEscHtml(s)}</pre>` }
}

function formatCiteRIS(info, mode = 'zh') {
  const ty = info.kind === 'paper' ? 'JOUR' : (info.kind === 'incollection' ? 'CHAP' : (info.kind === 'collection' ? 'EDBOOK' : 'BOOK'))
  const title = mode === 'en' ? (info.originalTitle || info.fullTitle) : info.fullTitle
  const bookTitle = mode === 'en' ? (info.originalBookTitle || info.bookTitle) : (info.bookTitle || info.originalBookTitle)
  const lines = [`TY  - ${ty}`, `TI  - ${title}`]
  if (info.kind !== 'collection') {
    for (const author of info.authors) lines.push(`AU  - ${citeReverseForeignName(author)}`)
  }
  for (const ed of info.editors) lines.push(`A2  - ${citeReverseForeignName(ed)}`)
  if (info.kind === 'collection' && !info.editors.length) {
    for (const author of info.authors) lines.push(`A2  - ${citeReverseForeignName(author)}`)
  }
  for (const tr of info.translators) lines.push(`A3  - ${tr}`)
  if (info.kind === 'incollection' && bookTitle) {
    lines.push(`T2  - ${bookTitle}`)
  }
  if (info.year) lines.push(`PY  - ${info.year}`)
  if (info.kind === 'paper' && info.journal) lines.push(`JO  - ${info.journal}`)
  if (info.publisher) lines.push(`PB  - ${info.publisher}`)
  if (info.volume) lines.push(`VL  - ${info.volume}`)
  if (info.issue) lines.push(`IS  - ${info.issue}`)
  if (info.pages) {
    const [sp, ep] = info.pages.split('-')
    if (sp) lines.push(`SP  - ${sp}`)
    if (ep) lines.push(`EP  - ${ep}`)
  }
  if (info.isbn) lines.push(`SN  - ${info.isbn}`)
  if (info.doi) lines.push(`DO  - ${info.doi}`)
  lines.push('ER  - ')
  const s = lines.join('\n')
  return { text: s, html: `<pre style="margin:0">${citeEscHtml(s)}</pre>` }
}

function formatCiteMarkdown(info) {
  const host = info.bookTitle || info.originalBookTitle
  const meta = [
    info.kind !== 'collection' && info.authors.length ? `作者：${info.authors.join(' / ')}` : '',
    info.editors.length ? `编者：${info.editors.join(' / ')}` : (info.kind === 'collection' && info.authors.length ? `编者：${info.authors.join(' / ')}` : ''),
    info.kind === 'incollection' && host ? `载《${host}》` : '',
    info.translators.length ? `译者：${info.translators.join(' / ')}` : '',
    citeJoinPubYear(info.kind === 'paper' ? (info.journal || info.publisher) : info.publisher, info.year, '，'),
    info.pages ? `第 ${info.pages} 页` : '',
    info.isbn ? `ISBN：${info.isbn}` : '',
    info.doi ? `DOI：${info.doi}` : '',
  ].filter(Boolean).join(' | ')
  const text = `《${info.fullTitle}》${meta ? `（${meta}）` : ''}`
  return { text, html: citeEscHtml(text) }
}

function generateCitations(rawInfo, mode) {
  const info = normalizeCitationInfo(rawInfo)
  const resolvedMode = mode || (info.isChinese ? 'zh' : 'en')
  const common = [
    { name: 'BibTeX', ...formatCiteBibTeX(info) },
    { name: 'RIS (Zotero / EndNote)', ...formatCiteRIS(info, resolvedMode) },
    { name: 'Markdown', ...formatCiteMarkdown(info) },
  ]
  if (resolvedMode === 'zh') {
    return [
      { name: 'GB/T 7714-2015', ...formatCiteGBT7714(info) },
      { name: '《社会》', ...formatCiteSociety(info) },
      { name: '《社会学评论》', ...formatCiteSociologicalReview(info) },
      ...common,
    ]
  }
  return [
    { name: 'APA', ...formatCiteAPA(info) },
    { name: 'MLA', ...formatCiteMLA(info) },
    { name: 'Chicago', ...formatCiteChicago(info) },
    ...common,
  ]
}

async function copyCitationRichText(text, html) {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem === 'function') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ])
      return
    }
  } catch {}
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error('clipboard_unavailable')
}

function buildCitationFromTask(task, fallbackTitle = '') {
  const bib = task?.profile?.bibliography ?? {}
  const meta = task?.paperImport?.metadata ?? {}
  const pubObj = meta.publication && typeof meta.publication === 'object' ? meta.publication : null
  const pickStr = v => (v == null ? '' : typeof v === 'object' ? String(v.source ?? v.zh ?? '').trim() : String(v).trim())
  const rawTitle = String(task?.name ?? fallbackTitle ?? '').trim()
  const bibTitle = String(bib.title ?? '').trim()
  const bibOrig = String(bib.original_title ?? bib.originalTitle ?? '').trim()
  const profTitle = String(task?.profile?.title ?? meta.title?.source ?? '').trim()
  const title = rawTitle || bibTitle
  let originalTitle = bibOrig || (profTitle && profTitle !== title ? profTitle : '')
  if (!originalTitle && bibTitle && bibTitle !== title && !CITE_IS_CJK(bibTitle)) originalTitle = bibTitle
  const rawKind = String(bib.kind ?? '').toLowerCase()
  const taskKind = String(task?.kind ?? task?.profile?.document_type ?? '').toLowerCase()
  const kind = ['book', 'paper', 'collection', 'incollection'].includes(rawKind)
    ? rawKind
    : rawKind === 'chapter'
      ? 'incollection'
      : taskKind === 'paper'
        ? (pubObj?.book ? 'incollection' : 'paper')
        : taskKind === 'chapter'
          ? 'incollection'
          : taskKind === 'collection'
            ? 'collection'
            : 'book'
  const isPaper = kind === 'paper'
  const isIncol = kind === 'incollection'
  const pubStr = typeof meta.publication === 'string' ? meta.publication.trim() : ''
  return {
    kind,
    title,
    subtitle: String(bib.subtitle ?? '').trim(),
    originalTitle,
    authors: String(bib.authors ?? '').trim() || pickStr(meta.author),
    editors: String(bib.editors ?? '').trim(),
    translators: String(bib.translators ?? '').trim(),
    bookTitle: String(bib.book_title ?? bib.bookTitle ?? (pubObj?.book ? pickStr(pubObj.book.zh ?? pubObj.book) : '')).trim(),
    originalBookTitle: String(bib.original_book_title ?? bib.originalBookTitle ?? (pubObj?.book ? pickStr(pubObj.book.source ?? '') : '')).trim(),
    publisher: String(bib.publisher ?? (pubObj ? pickStr(pubObj.publisher) : (isPaper ? '' : pubStr))).trim(),
    journal: String(bib.journal ?? (pubObj && !isIncol ? pickStr(pubObj.journal) : (isPaper ? pubStr : ''))).trim(),
    year: String(bib.year ?? pubObj?.year ?? '').trim(),
    volume: String(bib.volume ?? '').trim(),
    issue: String(bib.issue ?? pubObj?.issue ?? '').trim(),
    pages: String(bib.pages ?? pubObj?.pages ?? '').trim(),
    isbn: String(bib.isbn ?? pubObj?.isbn ?? '').trim(),
    doi: String(bib.doi ?? pubObj?.doi ?? '').trim(),
  }
}

function buildInitialCiteForm(meta, target, chapterMode) {
  const baseKind = ['book', 'paper', 'collection', 'incollection'].includes(meta.kind)
    ? meta.kind
    : (['book', 'paper', 'collection', 'incollection'].includes(target.kind) ? target.kind : 'book')
  if (baseKind === 'collection' && chapterMode && target.chapterTitle) {
    return {
      kind: 'incollection',
      title: target.chapterTitle,
      subtitle: '',
      originalTitle: target.originalChapterTitle || '',
      authors: '',
      editors: meta.editors || meta.authors || '',
      translators: meta.translators || '',
      bookTitle: meta.title || target.title || '',
      originalBookTitle: meta.originalTitle || '',
      publisher: meta.publisher || '',
      journal: '',
      year: meta.year || '',
      volume: meta.volume || '',
      issue: meta.issue || '',
      pages: target.pages || '',
      isbn: meta.isbn || '',
      doi: meta.doi || '',
    }
  }
  const pages = (baseKind === 'book' || baseKind === 'collection')
    ? (target.pages || '')
    : (meta.pages || target.pages || '')
  return {
    kind: baseKind,
    title: meta.title || target.title || '',
    subtitle: meta.subtitle || '',
    originalTitle: meta.originalTitle || '',
    authors: meta.authors || '',
    editors: meta.editors || '',
    translators: meta.translators || '',
    bookTitle: meta.bookTitle || '',
    originalBookTitle: meta.originalBookTitle || '',
    publisher: meta.publisher || '',
    journal: meta.journal || '',
    year: meta.year || '',
    volume: meta.volume || '',
    issue: meta.issue || '',
    pages,
    isbn: meta.isbn || '',
    doi: meta.doi || '',
  }
}

const CITE_SKIP_HEADING_RE = /^(?:目录|contents|table of contents|table des matières|sommaire|inhaltsverzeichnis|文献|参考文献|references|bibliography|bibliographie|索引|index)$/i

function cleanCiteHeadingText(raw) {
  let s = String(raw ?? '')
    .replace(/^#+\s*/, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\s*\((?:部扉页|篇扉页|扉页)\)\s*/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.startsWith('《') && s.endsWith('》') && !s.slice(1, -1).includes('》')) {
    s = s.slice(1, -1).trim()
  }
  return s
}

function chapterHeadingForBlock(reading, blockId) {
  if (!reading || !blockId) return { chapterTitle: '', originalChapterTitle: '' }
  const blocks = reading.blocks ?? []
  const idx = blocks.findIndex(b => String(b.id) === String(blockId) || String(b.sourceBlockId) === String(blockId))
  if (idx < 0) return { chapterTitle: '', originalChapterTitle: '' }
  const blockIndex = new Map(blocks.map((b, i) => [String(b.id), i]))
  const outline = (reading.outline ?? []).filter(h => {
    const pos = blockIndex.get(String(h.id))
    return pos !== undefined && pos <= idx && (h.level ?? 1) <= 2 && !CITE_SKIP_HEADING_RE.test(cleanCiteHeadingText(h.label))
  })
  const picked = outline.at(-1)
  if (!picked) return { chapterTitle: '', originalChapterTitle: '' }
  const blk = blocks[blockIndex.get(String(picked.id))]
  const origBlk = (reading.originalBlocks ?? []).find(x => String(x.id) === String(blk?.sourceBlockId))
  const chapterTitle = cleanCiteHeadingText(picked.label || blk?.translation || blk?.text || '')
  const originalChapterTitle = cleanCiteHeadingText(blk?.sourceText || origBlk?.text || '')
  return {
    chapterTitle,
    originalChapterTitle: originalChapterTitle && originalChapterTitle !== chapterTitle ? originalChapterTitle : '',
  }
}

function CitationModal({ target, onClose, onSavedCitation }) {
  const [baseMeta, setBaseMeta] = useState(() => target.citation || {})
  const canChapterToggle = (baseMeta.kind === 'collection' || target.kind === 'collection') && Boolean(target.chapterTitle)
  const [chapterMode, setChapterMode] = useState(() => canChapterToggle)
  const [form, setForm] = useState(() => buildInitialCiteForm(target.citation || {}, target, canChapterToggle))
  const [mode, setMode] = useState(() => (CITE_IS_CJK(form.title) ? 'zh' : 'en'))
  const [showFields, setShowFields] = useState(() => !baseMeta.authors && !baseMeta.editors && !baseMeta.year && !baseMeta.publisher && !baseMeta.journal)
  const [activeExport, setActiveExport] = useState('')
  const [savingMeta, setSavingMeta] = useState(false)
  const [metaSavedMsg, setMetaSavedMsg] = useState('')
  const [copiedName, setCopiedName] = useState('')
  const [copyErrName, setCopyErrName] = useState('')

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 若宿主后端尚未重启导致 citation 为空或未包含论文集字段，客户端自动从任务接口兜底读取 profile.bibliography
  useEffect(() => {
    if (!target.taskId || baseMeta.saved) return
    const alreadyRich = (baseMeta.kind === 'collection' || baseMeta.kind === 'incollection') || ((baseMeta.authors || baseMeta.editors) && (baseMeta.year || baseMeta.publisher || baseMeta.journal) && baseMeta.kind === 'paper')
    if (alreadyRich) return
    let alive = true
    fetch('/api/paper-reader/pipeline/tasks/' + encodeURIComponent(target.taskId))
      .then(r => (r.ok ? r.json() : null))
      .then(t => {
        if (!alive || !t) return
        const resolved = buildCitationFromTask(t, target.title)
        if (!resolved.authors && !resolved.editors && !resolved.year && !resolved.originalTitle && !resolved.publisher && !resolved.journal && resolved.kind !== 'collection' && resolved.kind !== 'incollection') return
        setBaseMeta(resolved)
        const autoChapter = resolved.kind === 'collection' && Boolean(target.chapterTitle)
        setChapterMode(autoChapter)
        setForm(buildInitialCiteForm(resolved, target, autoChapter))
        if (resolved.authors || resolved.editors || resolved.year) setShowFields(false)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [target.taskId])

  const switchChapterScope = nextChapterMode => {
    setChapterMode(nextChapterMode)
    setForm(buildInitialCiteForm(baseMeta, target, nextChapterMode))
  }

  const setField = (k, v) => setForm(prev => {
    if (k === 'kind') {
      const nextPages = (v === 'book' || v === 'collection') ? (target.pages || '') : (baseMeta.pages || target.pages || prev.pages || '')
      return { ...prev, kind: v, pages: nextPages }
    }
    return { ...prev, [k]: v }
  })

  const allCitations = useMemo(() => generateCitations(form, mode), [form, mode])
  const exportNames = new Set(['BibTeX', 'RIS (Zotero / EndNote)', 'Markdown'])
  const primaryCitations = useMemo(() => allCitations.filter(c => !exportNames.has(c.name)), [allCitations])
  const exportCitations = useMemo(() => allCitations.filter(c => exportNames.has(c.name)), [allCitations])
  const activeExportItem = exportCitations.find(c => c.name === activeExport) ?? null

  const handleCopy = async cite => {
    try {
      await copyCitationRichText(cite.text, cite.html)
      setCopiedName(cite.name)
      setCopyErrName('')
      setTimeout(() => setCopiedName(cur => (cur === cite.name ? '' : cur)), 1500)
    } catch {
      setCopyErrName(cite.name)
      setTimeout(() => setCopyErrName(cur => (cur === cite.name ? '' : cur)), 1500)
    }
  }

  const handleSaveMeta = async () => {
    if (!target.documentId || savingMeta) return
    setSavingMeta(true)
    setMetaSavedMsg('')
    try {
      const docMeta = (form.kind === 'book' || form.kind === 'collection') ? { ...form, pages: '' } : { ...form }
      const r = await fetch('/api/paper-reader/pipeline/bookmarks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updateDocumentCitation: { documentId: target.documentId, citation: docMeta } }),
      })
      const val = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(val.error || '保存书目信息失败')
      onSavedCitation?.(target.documentId, { ...docMeta, saved: true })
      setMetaSavedMsg('已保存本书书目信息')
      setTimeout(() => setMetaSavedMsg(''), 2200)
    } catch (e) {
      setMetaSavedMsg(e.message || '保存失败')
    } finally {
      setSavingMeta(false)
    }
  }

  const isPaper = form.kind === 'paper'
  const isCollection = form.kind === 'collection'
  const isIncollection = form.kind === 'incollection'
  const shortLabel = name => ({ 'GB/T 7714-2015': 'GB/T 7714', 'RIS (Zotero / EndNote)': 'RIS' })[name] ?? name

  return h('div', {
    className: 'rr-citeOverlay',
    role: 'dialog',
    'aria-modal': true,
    'aria-label': '引用',
    onClick: e => { if (e.target === e.currentTarget) onClose() },
  },
    h('div', { className: 'rr-citeModal' },
      h('header', { className: 'rr-citeHeader' },
        h('div', { className: 'rr-citeHeaderLeft' },
          h('h3', null, '引用'),
          h('div', { className: 'rr-bmSeg', role: 'group', 'aria-label': '引用语言格式' },
            h('button', { type: 'button', className: `rr-bmSegBtn ${mode === 'zh' ? 'active' : ''}`, 'aria-pressed': mode === 'zh', onClick: () => setMode('zh') }, '中文格式'),
            h('button', { type: 'button', className: `rr-bmSegBtn ${mode === 'en' ? 'active' : ''}`, 'aria-pressed': mode === 'en', onClick: () => setMode('en') }, '英文格式')
          ),
          canChapterToggle ? h('div', { className: 'rr-bmSeg', role: 'group', 'aria-label': '论文集引用范围' },
            h('button', { type: 'button', className: `rr-bmSegBtn ${chapterMode ? 'active' : ''}`, 'aria-pressed': chapterMode, onClick: () => switchChapterScope(true) }, '引本篇析出'),
            h('button', { type: 'button', className: `rr-bmSegBtn ${!chapterMode ? 'active' : ''}`, 'aria-pressed': !chapterMode, onClick: () => switchChapterScope(false) }, '引整本论文集')
          ) : null,
          !isPaper && form.pages ? h('span', { className: 'rr-bmPageBadge', title: '已附带对应页码' }, `p. ${form.pages}`) : null
        ),
        h('div', { className: 'rr-citeHeaderRight' },
          h('button', {
            type: 'button',
            className: `rr-citeEditToggle ${showFields ? 'active' : ''}`,
            onClick: () => setShowFields(v => !v),
          }, icon('edit', 12), h('span', null, showFields ? '收起书目' : '编辑书目')),
          h('button', { type: 'button', className: 'rr-citeClose', onClick: onClose, 'aria-label': '关闭' }, icon('close', 16))
        )
      ),
      showFields ? h('section', { className: 'rr-citeFields' },
        h('div', { className: 'rr-citeFieldGrid' },
          h('label', { className: 'rr-citeField' },
            h('span', null, '文献类型'),
            h('select', { value: form.kind, onChange: e => setField('kind', e.target.value) },
              h('option', { value: 'book' }, '专著 [M]'),
              h('option', { value: 'paper' }, '期刊论文 [J]'),
              h('option', { value: 'collection' }, '论文集编著 [C]'),
              h('option', { value: 'incollection' }, '论文集析出 [C]//')
            )
          ),
          h('label', { className: 'rr-citeField' },
            h('span', null, '出版年'),
            h('input', { value: form.year, onChange: e => setField('year', e.target.value), placeholder: '如 1995' })
          ),
          h('label', { className: 'rr-citeField' },
            h('span', null, isPaper ? '论文页码' : '引文页码'),
            h('input', { value: form.pages, onChange: e => setField('pages', e.target.value), placeholder: isPaper ? '如 185-213' : '如 23-24' })
          ),
          !isCollection ? h('label', { className: 'rr-citeField rr-citeSpan2' },
            h('span', null, isIncollection ? '篇目作者（多人用逗号或分号分隔）' : '作者（多人用逗号或分号分隔）'),
            h('input', { value: form.authors, onChange: e => setField('authors', e.target.value), placeholder: '如 Ian Hacking 或 伊恩·哈金' })
          ) : h('label', { className: 'rr-citeField rr-citeSpan2' },
            h('span', null, '编者（多人用逗号或分号分隔）'),
            h('input', { value: form.editors, onChange: e => setField('editors', e.target.value), placeholder: '如 Alfred Denker; Holger Zaborowski' })
          ),
          h('label', { className: 'rr-citeField' },
            h('span', null, '译者（可选）'),
            h('input', { value: form.translators, onChange: e => setField('translators', e.target.value), placeholder: '如 刘北成' })
          ),
          h('label', { className: 'rr-citeField rr-citeSpan3' },
            h('span', null, isIncollection ? '析出篇名（中文）' : '中文题名'),
            h('input', { value: form.title, onChange: e => setField('title', e.target.value), placeholder: isIncollection ? '单篇论文或章节标题' : '书名或论文名' })
          ),
          h('label', { className: 'rr-citeField rr-citeSpan3' },
            h('span', null, isIncollection ? '析出篇原作名（英文格式优先）' : '原作名（英文格式优先）'),
            h('input', { value: form.originalTitle, onChange: e => setField('originalTitle', e.target.value), placeholder: 'Original Title' })
          ),
          isIncollection ? h(React.Fragment, null,
            h('label', { className: 'rr-citeField rr-citeSpan2' },
              h('span', null, '所属论文集 / 原书名'),
              h('input', { value: form.bookTitle, onChange: e => setField('bookTitle', e.target.value), placeholder: '中文论文集或原书名' })
            ),
            h('label', { className: 'rr-citeField' },
              h('span', null, '论文集编者（可选）'),
              h('input', { value: form.editors, onChange: e => setField('editors', e.target.value), placeholder: '多人用分号分隔' })
            ),
            h('label', { className: 'rr-citeField rr-citeSpan3' },
              h('span', null, '所属论文集原作名（英文格式优先）'),
              h('input', { value: form.originalBookTitle, onChange: e => setField('originalBookTitle', e.target.value), placeholder: 'Edited Volume Original Title' })
            )
          ) : null,
          isPaper ? h(React.Fragment, null,
            h('label', { className: 'rr-citeField rr-citeSpan2' },
              h('span', null, '期刊名'),
              h('input', { value: form.journal, onChange: e => setField('journal', e.target.value), placeholder: '如 European Journal of Sociology' })
            ),
            h('label', { className: 'rr-citeField' },
              h('span', null, '卷 / 期'),
              h('div', { className: 'rr-citeSplit' },
                h('input', { value: form.volume, onChange: e => setField('volume', e.target.value), placeholder: '卷' }),
                h('input', { value: form.issue, onChange: e => setField('issue', e.target.value), placeholder: '期' })
              )
            )
          ) : h(React.Fragment, null,
            h('label', { className: 'rr-citeField rr-citeSpan2' },
              h('span', null, '出版社'),
              h('input', { value: form.publisher, onChange: e => setField('publisher', e.target.value), placeholder: '如 Clarendon Press / 出版社名' })
            ),
            h('label', { className: 'rr-citeField' },
              h('span', null, 'ISBN'),
              h('input', { value: form.isbn, onChange: e => setField('isbn', e.target.value), placeholder: '可选' })
            )
          )
        ),
        h('div', { className: 'rr-citeFieldsFoot' },
          h('span', { className: 'rr-citeFieldsHint' }, metaSavedMsg || '修改即时生效；保存后将记住本书书目信息。'),
          target.documentId && !chapterMode ? button(savingMeta ? '保存中…' : '保存书目', handleSaveMeta, 'rr-buttonPrimary rr-bmMiniBtn', { disabled: savingMeta }) : null
        )
      ) : null,
      h('div', { className: 'rr-citeBody' },
        primaryCitations.map(cite => {
          const isCopied = copiedName === cite.name
          const isFailed = copyErrName === cite.name
          return h('div', { className: 'rr-citeRow', key: cite.name },
            h('div', { className: 'rr-citeRowLabel' }, shortLabel(cite.name)),
            h('div', { className: 'rr-citeRowContent' },
              h('div', { className: 'rr-citeText', dangerouslySetInnerHTML: { __html: cite.html } })
            ),
            h('button', {
              type: 'button',
              className: `rr-citeCopyBtn ${isCopied ? 'copied' : ''} ${isFailed ? 'failed' : ''}`,
              onClick: () => handleCopy(cite),
            }, isCopied ? '已复制' : (isFailed ? '失败' : '复制'))
          )
        }),
        activeExportItem ? h('div', { className: 'rr-citeExportBox' },
          h('div', { className: 'rr-citeExportBoxHead' },
            h('span', null, activeExportItem.name),
            h('button', {
              type: 'button',
              className: `rr-citeCopyBtn ${copiedName === activeExportItem.name ? 'copied' : ''}`,
              onClick: () => handleCopy(activeExportItem),
            }, copiedName === activeExportItem.name ? '已复制' : '复制')
          ),
          h('div', { className: 'rr-citeText', dangerouslySetInnerHTML: { __html: activeExportItem.html } })
        ) : null
      ),
      h('footer', { className: 'rr-citeFooter' },
        exportCitations.map(cite => h('button', {
          key: cite.name,
          type: 'button',
          className: `rr-citeFooterLink ${activeExport === cite.name ? 'active' : ''}`,
          onClick: () => setActiveExport(cur => (cur === cite.name ? '' : cite.name)),
        }, shortLabel(cite.name)))
      )
    )
  )
}
