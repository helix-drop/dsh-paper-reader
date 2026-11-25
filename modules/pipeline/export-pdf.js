import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function sanitizeExportFilename(title, suffix, ext) {
  const base = String(title ?? 'document')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'document'
  return `${base}${suffix ? '-' + suffix : ''}.${ext}`
}

export function contentDispositionFor(filename) {
  const asciiFallback = String(filename ?? 'document.pdf')
    .replace(/[^\x20-\x7e]+/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/^_+|_+$/g, '') || 'document.pdf'
  const encoded = encodeURIComponent(filename).replace(/['()*!]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

function parseInlineFootnotes(blocks = [], useTranslation = false) {
  const map = new Map()
  for (const b of blocks) {
    if (!b) continue
    const raw = String(useTranslation ? (b.translation ?? b.text) : (b.sourceText ?? b.text) ?? '')
    const defMatch = raw.match(/^\[\^([^\]]+)\]:\s*([\s\S]*)$/)
    if (defMatch) {
      map.set(defMatch[1], defMatch[2].trim())
      continue
    }
    const markerSplit = raw.split(/\n(?=\[footnote-[^\]]+\]|\[\^[^\]]+\]:)/)
    for (const part of markerSplit) {
      const m = part.match(/^\[footnote-([^\]]+)\]\\?([^\s]*)\s+([\s\S]*)$/) || part.match(/^\[\^([^\]]+)\]:\s*([\s\S]*)$/)
      if (m) {
        map.set(m[1], (m[3] ?? m[2] ?? '').trim())
      }
    }
  }
  return map
}

function splitParagraphAndDefs(raw) {
  const text = String(raw ?? '')
  const lines = text.split('\n')
  const bodyLines = []
  const defs = []
  let curDef = null
  for (const line of lines) {
    const m = line.match(/^\[footnote-([^\]]+)\]\\?([^\s]*)\s+([\s\S]*)$/) || line.match(/^\[\^([^\]]+)\]:\s*([\s\S]*)$/)
    if (m) {
      if (curDef) defs.push(curDef)
      curDef = { id: m[1], body: (m[3] ?? m[2] ?? '').trim() }
    } else if (curDef && (/^\s{2,}/.test(line) || !line.trim())) {
      if (line.trim()) curDef.body += '\n' + line.trim()
    } else {
      if (curDef) {
        defs.push(curDef)
        curDef = null
      }
      bodyLines.push(line)
    }
  }
  if (curDef) defs.push(curDef)
  return { body: bodyLines.join('\n').trim(), defs }
}

function renderInlineMarkdownHtml(raw, { assetDataUris = new Map(), refsOut = null } = {}) {
  const text = String(raw ?? '')
  const re = /!\[([^\]]*)\]\(([^)]+)\)|\[\^([^\]]+)\](?!:)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g
  let last = 0
  let out = ''
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index))
    if (m[2] !== undefined) {
      const ref = m[2]
      const src = assetDataUris.get(ref) || (/^https?:/i.test(ref) ? ref : '')
      if (src) {
        out += `<figure class="pdf-figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(m[1])}" />${m[1] ? `<figcaption>${escapeHtml(m[1])}</figcaption>` : ''}</figure>`
      } else {
        out += `<span class="pdf-imgPlaceholder">[插图: ${escapeHtml(m[1] || ref)}]</span>`
      }
    } else if (m[3] !== undefined) {
      const id = m[3]
      refsOut?.push(id)
      out += `<sup class="pdf-fnSup">[${escapeHtml(id)}]</sup>`
    } else if (m[4] !== undefined) {
      out += `<span class="pdf-link">${escapeHtml(m[4])}</span>`
    } else if (m[6] !== undefined) {
      out += `<code>${escapeHtml(m[6])}</code>`
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out += `<strong>${escapeHtml(m[7] ?? m[8])}</strong>`
    } else if (m[9] !== undefined || m[10] !== undefined) {
      out += `<em>${escapeHtml(m[9] ?? m[10])}</em>`
    }
    last = m.index + m[0].length
  }
  out += escapeHtml(text.slice(last))
  return out
}

function renderBlockHtml(raw, blockType, level, { assetDataUris, fnMap, renderedNotes }) {
  const { body, defs } = splitParagraphAndDefs(raw)
  const usedIds = []
  const opts = { assetDataUris, refsOut: usedIds }
  let mainHtml = ''
  const trimmed = body.trim()

  if (!trimmed && defs.length) {
    const unseen = renderedNotes ? defs.filter(d => !renderedNotes.has(d.id)) : defs
    if (!unseen.length) return ''
    const notesHtml = unseen.map(d => {
      renderedNotes?.add(d.id)
      return `<div class="pdf-fnItem"><span class="pdf-fnId">[${escapeHtml(d.id)}]</span> <span>${renderInlineMarkdownHtml(d.body, { assetDataUris })}</span></div>`
    }).join('')
    return `<div class="pdf-footnotes standalone">${notesHtml}</div>`
  }
  if (!trimmed) return ''

  if (trimmed === '---' || trimmed === '***') {
    return '<hr class="pdf-hr" />'
  }
  if (blockType === 'heading' || /^#{1,6}\s+/.test(trimmed)) {
    const m = trimmed.match(/^(#{1,6})\s+([\s\S]*)$/)
    const hLevel = Math.min(4, Math.max(1, m ? m[1].length : (level || 2)))
    const content = (m ? m[2] : trimmed).replace(/\s*\((?:部扉页|篇扉页|扉页)\)/g, '')
    mainHtml = `<h${hLevel} class="pdf-h pdf-h${hLevel}">${renderInlineMarkdownHtml(content, opts)}</h${hLevel}>`
  } else if (blockType === 'quote' || trimmed.startsWith('> ')) {
    const clean = trimmed.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n')
    mainHtml = `<blockquote class="pdf-quote">${renderInlineMarkdownHtml(clean, opts).replace(/\n/g, '<br/>')}</blockquote>`
  } else if (blockType === 'code') {
    mainHtml = `<pre class="pdf-pre">${escapeHtml(trimmed.replace(/^```[^\n]*\n?|\n?```$/g, ''))}</pre>`
  } else if (blockType === 'table') {
    mainHtml = `<pre class="pdf-tablePre">${escapeHtml(trimmed)}</pre>`
  } else {
    mainHtml = `<p class="pdf-p">${renderInlineMarkdownHtml(trimmed, opts).replace(/\n/g, '<br/>')}</p>`
  }

  const noteItems = []
  for (const d of defs) {
    renderedNotes?.add(d.id)
    noteItems.push(d)
  }
  for (const id of usedIds) {
    if (!defs.some(d => d.id === id) && fnMap?.has(id) && !renderedNotes?.has(id)) {
      renderedNotes?.add(id)
      noteItems.push({ id, body: fnMap.get(id) })
    }
  }
  const fnHtml = noteItems.length
    ? `<div class="pdf-footnotes">${noteItems.map(d => `<div class="pdf-fnItem"><span class="pdf-fnId">[${escapeHtml(d.id)}]</span> <span>${renderInlineMarkdownHtml(d.body, { assetDataUris })}</span></div>`).join('')}</div>`
    : ''
  return mainHtml + fnHtml
}

export function buildBilingualMarkdown(reading) {
  const title = reading?.title || '双语对照文献'
  const blocks = reading?.blocks ?? []
  const hidden = new Set(reading?.hiddenBlocks ?? [])
  const origBlocks = reading?.originalBlocks ?? []
  const lines = [`# ${title}`, '']
  const visible = blocks.filter(b => b && !hidden.has(b.id))
  for (let i = 0; i < visible.length; i++) {
    const b = visible[i]
    const trans = String(reading?.standaloneView === 'translation' ? b.text : (b.translation ?? b.text) ?? '').trim()
    const orig = String(b.sourceText ?? origBlocks[i]?.text ?? (reading?.standaloneView ? '' : b.text) ?? '').trim()
    if (!trans && !orig) continue
    if (b.type === 'heading') {
      lines.push(trans || orig)
      if (orig && trans && orig !== trans) lines.push(`> ${orig.replace(/^#+\s*/, '')}`)
    } else {
      if (trans) lines.push(trans)
      if (orig && orig !== trans) {
        lines.push('')
        lines.push(orig.split('\n').map(l => `> ${l}`).join('\n'))
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

const EXPORT_FONT_STACKS = {
  serif: 'Georgia, "方正屏显雅宋简体", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", serif',
  fzsong: '"FZNewShuSong-Z10", "FZShuSong-Z01", "Songti SC", "Source Han Serif SC", "Noto Serif SC", Georgia, serif',
  kaiti: '"LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", "Noto Serif SC", serif',
  fangsong: '"FangSong", "STFangsong", "Kaiti SC", "Noto Serif SC", serif',
  sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif',
  yuan: '"STYuanti-SC-Regular", "YouYuan", "PingFang SC", sans-serif',
  literary: 'Georgia, "Palatino Linotype", "Book Antiqua", "Times New Roman", "Source Han Serif SC", "Noto Serif SC", serif',
  mono: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "PingFang SC", monospace',
}

export function renderExportHtml(reading, { mode = 'translation', assetDataUris = new Map(), typography = {} } = {}) {
  const title = reading?.title || '导出文献'
  const isBilingual = mode === 'bilingual'
  const isOriginal = mode === 'original'
  const meta = reading?.metadata
  const blocks = reading?.blocks ?? []
  const origBlocks = reading?.originalBlocks ?? []
  const hiddenMain = new Set(reading?.hiddenBlocks ?? [])
  const hiddenOrig = new Set(reading?.originalOutline?.hiddenBlocks ?? [])

  const isTraditional = /[\u4e00-\u9fff]/.test(title) && /[譯註書體國學歷見觀變]/.test(title + (blocks[0]?.text ?? ''))
  const defaultCjk = isTraditional
    ? '"Source Han Serif TC", "Noto Serif CJK TC", "Songti TC", "PMingLiU"'
    : '"Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", "STSong"'
  const pickedFont = EXPORT_FONT_STACKS[typography?.fontFamily] || `${defaultCjk}, Georgia, "Times New Roman", serif`
  const reqFontSize = Number(typography?.fontSize)
  const bodySizePt = Number.isFinite(reqFontSize) && reqFontSize >= 12 && reqFontSize <= 28
    ? (isBilingual ? Math.max(8.5, Math.min(13, reqFontSize * 0.54)) : Math.max(9.5, Math.min(16, reqFontSize * 0.62)))
    : (isBilingual ? 9.6 : 11)
  const reqLh = Number(typography?.lineHeight)
  const bodyLh = Number.isFinite(reqLh) && reqLh >= 1.3 && reqLh <= 2.5
    ? (isBilingual ? Math.max(1.4, reqLh - 0.14) : reqLh)
    : (isBilingual ? 1.62 : 1.78)
  const reqLs = Number(typography?.letterSpacing)
  const bodyLs = Number.isFinite(reqLs) && reqLs >= 0 && reqLs <= 0.1 ? reqLs : 0.01
  const reqPara = Number(typography?.paraSpacing)
  const paraGapPt = Number.isFinite(reqPara) && reqPara >= 0.1 && reqPara <= 1.6 ? (reqPara * 11).toFixed(1) : '7'
  const cjkFont = defaultCjk

  const metaParts = meta
    ? [
        meta.author?.zh ?? meta.author?.source,
        meta.publication?.journal?.zh ?? meta.publication?.journal?.source ?? meta.publication?.book?.zh,
        meta.publication?.year,
        meta.publication?.pages,
      ].filter(Boolean)
    : []

  const transFnMap = parseInlineFootnotes(blocks, !reading?.standaloneView)
  const origFnMap = parseInlineFootnotes(origBlocks.length ? origBlocks : blocks, false)
  const renderedTransNotes = new Set()
  const renderedOrigNotes = new Set()

  let contentHtml = ''
  if (isBilingual) {
    const sourceList = reading?.standaloneView === 'translation' && origBlocks.length ? origBlocks : blocks
    const visibleTrans = blocks.filter(b => b && !hiddenMain.has(b.id))
    const origById = new Map(sourceList.map(b => [b.id, b]))
    const origByIdx = sourceList.filter(b => b && !hiddenOrig.has(b.id))
    const useMatchedByField = visibleTrans.some(b => typeof b.sourceText === 'string' && b.sourceText.trim())

    contentHtml = `
      <div class="pdf-colHeader">
        <span>中文译文</span>
        <span>原文对照</span>
      </div>
      ${visibleTrans.map((b, i) => {
        const transRaw = reading?.standaloneView === 'translation' ? b.text : (b.translation ?? b.text)
        const pairedOrig = b.sourceText
          ?? (b.sourceBlockId ? origById.get(b.sourceBlockId)?.text : null)
          ?? (!useMatchedByField ? origByIdx[i]?.text : null)
          ?? (reading?.standaloneView ? '' : b.text)
        const origRaw = pairedOrig ?? ''
        const isHead = b.type === 'heading' || /^#{1,6}\s+/.test(String(transRaw ?? '').trim())
        const transHtml = renderBlockHtml(transRaw, b.type, b.level, {
          assetDataUris, fnMap: transFnMap, renderedNotes: renderedTransNotes,
        })
        const origHtml = origRaw && origRaw !== transRaw
          ? renderBlockHtml(origRaw, b.type, b.level, {
              assetDataUris, fnMap: origFnMap, renderedNotes: renderedOrigNotes,
            })
          : '<p class="pdf-p pdf-emptyCol"></p>'
        if (!transHtml && !origHtml) return ''
        if (isHead) {
          return `<div class="pdf-biHead">${transHtml}${origRaw && origRaw !== transRaw ? `<div class="pdf-biHeadOrig">${escapeHtml(String(origRaw).replace(/^#+\s*/, ''))}</div>` : ''}</div>`
        }
        const avoidBreak = String(transRaw ?? '').length + String(origRaw ?? '').length < 900
        return `
          <div class="pdf-biRow ${avoidBreak ? 'avoid-break' : ''}">
            <div class="pdf-biLeft">${transHtml}</div>
            <div class="pdf-biRight">${origHtml}</div>
          </div>
        `
      }).join('')}
    `
  } else {
    const activeList = isOriginal && reading?.standaloneView === 'translation' && origBlocks.length ? origBlocks : blocks
    const hiddenSet = isOriginal ? hiddenOrig : hiddenMain
    const fnMap = isOriginal ? origFnMap : transFnMap
    const renderedNotes = isOriginal ? renderedOrigNotes : renderedTransNotes
    contentHtml = activeList
      .filter(b => b && !hiddenSet.has(b.id))
      .map(b => {
        const raw = isOriginal
          ? (b.sourceText ?? b.text)
          : (reading?.standaloneView === 'translation' ? b.text : (b.translation ?? b.text))
        return renderBlockHtml(raw, b.type, b.level, { assetDataUris, fnMap, renderedNotes })
      })
      .join('')
  }

  const modeBadge = isBilingual ? '双语对照版' : isOriginal ? '原文版' : '中文译文版'
  const headerShort = title.length > 32 ? title.slice(0, 32) + '…' : title

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} · ${modeBadge}</title>
<style>
  @page {
    size: A4;
    margin: 18mm 14mm 18mm 14mm;
    @top-left { content: "${escapeHtml(headerShort)}"; font-size: 8.5pt; color: #71717a; font-family: ${cjkFont}, Georgia, serif; }
    @top-right { content: "${modeBadge}"; font-size: 8.5pt; color: #71717a; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    @bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; color: #52525b; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  }
  @page :first {
    @top-left { content: none; }
    @top-right { content: none; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #1f2328;
    font-family: ${pickedFont};
    font-size: ${bodySizePt.toFixed(1)}pt;
    line-height: ${bodyLh.toFixed(2)};
    letter-spacing: ${bodyLs}em;
    text-align: justify;
    overflow-wrap: break-word;
  }
  .pdf-docHeader {
    border-bottom: 1.5pt solid #1e3a5f;
    padding-bottom: 10pt;
    margin-bottom: 16pt;
    text-align: left;
  }
  .pdf-modePill {
    display: inline-block;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 8pt;
    font-weight: 600;
    color: #1e3a5f;
    background: #eff4fb;
    border: 0.6pt solid #bfd0e6;
    border-radius: 3pt;
    padding: 1.5pt 6pt;
    margin-bottom: 6pt;
  }
  .pdf-docTitle {
    margin: 0 0 4pt;
    font-size: 18pt;
    line-height: 1.3;
    color: #142d55;
    font-weight: 700;
  }
  .pdf-docOrigTitle {
    margin: 0 0 4pt;
    font-size: 11.5pt;
    font-style: italic;
    color: #475569;
  }
  .pdf-docMeta {
    margin: 0;
    font-size: 9.5pt;
    color: #64748b;
  }
  .pdf-h {
    color: #142d55;
    font-weight: 700;
    text-align: left;
    break-after: avoid;
    page-break-after: avoid;
    margin: 14pt 0 6pt;
    line-height: 1.35;
  }
  .pdf-h1 { font-size: 15pt; border-bottom: 0.5pt solid #dbe3ef; padding-bottom: 3pt; }
  .pdf-h2 { font-size: 13pt; color: #28466e; }
  .pdf-h3 { font-size: 11.5pt; color: #28466e; }
  .pdf-h4 { font-size: 10.5pt; color: #334155; }
  .pdf-p { margin: 0 0 ${paraGapPt}pt; }
  .pdf-quote {
    margin: 7pt 0;
    padding: 6pt 10pt;
    background: #f7f9fd;
    border-left: 2.5pt solid #41699b;
    color: #1e2a3e;
  }
  .pdf-pre, .pdf-tablePre {
    font-family: Menlo, Consolas, monospace;
    font-size: 8.5pt;
    line-height: 1.45;
    background: #f8fafc;
    border: 0.5pt solid #e2e8f0;
    border-radius: 3pt;
    padding: 7pt 9pt;
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
  }
  .pdf-hr { border: none; border-top: 0.5pt solid #d4d4d8; margin: 12pt 0; }
  .pdf-figure { margin: 8pt 0; text-align: center; break-inside: avoid; }
  .pdf-figure img { max-width: 100%; max-height: 180mm; border-radius: 2pt; }
  .pdf-figure figcaption { font-size: 8.5pt; color: #64748b; margin-top: 3pt; }
  .pdf-imgPlaceholder { font-size: 9pt; color: #64748b; }
  .pdf-fnSup { font-size: 72%; color: #41699b; font-weight: 600; margin: 0 1pt; }
  .pdf-footnotes {
    margin: 2pt 0 9pt;
    padding: 4pt 8pt;
    background: #fafafa;
    border-left: 1.5pt solid #cbd5e1;
    font-size: 8.4pt;
    line-height: 1.5;
    color: #475569;
  }
  .pdf-fnItem + .pdf-fnItem { margin-top: 2pt; }
  .pdf-fnId { font-weight: 600; color: #334155; }
  code { font-family: Menlo, Consolas, monospace; font-size: 88%; background: #f1f5f9; padding: 0 2pt; border-radius: 2pt; }

  /* Bilingual side-by-side layout */
  .pdf-colHeader {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14pt;
    padding: 4pt 0;
    margin-bottom: 8pt;
    border-bottom: 1pt solid #cbd5e1;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 8.5pt;
    font-weight: 700;
    color: #334155;
    text-align: left;
  }
  .pdf-biHead {
    margin: 12pt 0 6pt;
    break-after: avoid;
    page-break-after: avoid;
  }
  .pdf-biHeadOrig {
    font-size: 9.2pt;
    color: #64748b;
    font-style: italic;
    margin-top: -3pt;
    margin-bottom: 4pt;
  }
  .pdf-biRow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 14pt;
    padding: 5pt 0;
    border-bottom: 0.4pt solid #e5e7eb;
  }
  .pdf-biRow.avoid-break {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .pdf-biLeft { min-width: 0; }
  .pdf-biRight { min-width: 0; color: #3f3f46; font-family: Georgia, "Times New Roman", ${cjkFont}, serif; }
  .pdf-emptyCol { min-height: 1em; }
</style>
</head>
<body>
  <header class="pdf-docHeader">
    <span class="pdf-modePill">DSH 精读 · ${modeBadge}</span>
    <h1 class="pdf-docTitle">${escapeHtml(title)}</h1>
    ${meta?.title?.source ? `<p class="pdf-docOrigTitle">${escapeHtml(meta.title.source)}</p>` : ''}
    ${metaParts.length ? `<p class="pdf-docMeta">${escapeHtml(metaParts.join(' · '))}</p>` : ''}
  </header>
  ${contentHtml}
</body>
</html>`
}

async function resolveChromeExecutable() {
  const candidates = [
    process.env.PAPER_READER_PDF_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const bin of candidates) {
    try {
      await fs.access(bin)
      return bin
    } catch {}
  }
  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const { stdout } = await execFileAsync('which', [cmd], { timeout: 2000 })
      const resolved = stdout.trim()
      if (resolved) return resolved
    } catch {}
  }
  return ''
}

export async function renderPdfFromReading(reading, { mode = 'translation', assetDataUris = new Map(), typography = {} } = {}) {
  const chrome = await resolveChromeExecutable()
  if (!chrome) {
    throw new Error('本机未检测到 Chrome / Chromium 浏览器，暂无法直接生成排版 PDF；可先下载 Markdown (.md) 使用。')
  }
  const html = renderExportHtml(reading, { mode, assetDataUris, typography })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-export-pdf-'))
  const htmlFile = path.join(dir, 'document.html')
  const pdfFile = path.join(dir, `${randomUUID()}.pdf`)
  try {
    await fs.writeFile(htmlFile, html, 'utf8')
    await execFileAsync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfFile}`,
        `file://${htmlFile}`,
      ],
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
    )
    return await fs.readFile(pdfFile)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
