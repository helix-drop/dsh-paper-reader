import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { renderPdfPage } from './pdf-location.js'
import { taskSourcePdf } from './source-map.js'
import { hash } from './markdown.js'
import { ANALYZER, exists, json } from './tasks/shared.js'

export const COVER_ASSET_REF = '__cover__.jpg'
const COVER_MAX_WIDTH = 420
const COVER_JPEG_DPI = 110

const RESIZE_IMAGE_TO_JPEG_SCRIPT = `
import sys
from PIL import Image
src, dst, max_w = sys.argv[1], sys.argv[2], int(sys.argv[3])
img = Image.open(src)
if img.mode not in ("RGB", "L"):
    img = img.convert("RGB")
elif img.mode == "L":
    img = img.convert("RGB")
if max_w > 0 and img.width > max_w:
    new_h = max(1, round(img.height * (max_w / img.width)))
    img = img.resize((max_w, new_h), Image.Resampling.LANCZOS)
img.save(dst, format="JPEG", quality=84, optimize=True)
`

function execBin(bin, args, timeout = 20000) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr })
    })
  })
}

async function writeBinaryAtomic(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' })
    await fs.rename(tmp, filePath)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

export function taskCoverFile(manager, t) {
  const dir = manager.docDir ? manager.docDir(t) : path.join(manager.dir(t.id), 'document')
  return path.join(dir, 'cover.jpg')
}

export function taskCoverMeta(t) {
  const hasCover = Boolean(t?.cover?.file && !t?.cover?.none)
  return {
    hasCover,
    coverPage: t?.cover?.page ?? t?.profile?.cover_page ?? null,
    coverSha256: hasCover ? (t?.cover?.sha256 ?? null) : null,
  }
}

export async function detectPdfCoverPage(pdfFile, { kind = 'book', pythonBin = 'python3' } = {}) {
  if (!pdfFile || !(await exists(pdfFile))) return null
  const candidates = [...new Set([pythonBin, '/opt/homebrew/bin/python3', 'python3'].filter(Boolean))]
  for (const bin of candidates) {
    const { err, stdout } = await execBin(bin, [ANALYZER, '--detect-cover', pdfFile, '--kind', kind || 'book'])
    if (err) continue
    try {
      const lines = String(stdout || '').trim().split(/\r?\n/)
      const jsonLine = [...lines].reverse().find(l => l.trim().startsWith('{'))
      if (!jsonLine) continue
      const parsed = JSON.parse(jsonLine)
      if (parsed && ('page' in parsed)) return parsed
    } catch {}
  }
  return null
}

async function convertImageFileToCoverJpeg(srcImagePath, targetDir, { maxWidth = COVER_MAX_WIDTH, pythonBin = 'python3' } = {}) {
  const tmpOut = path.join(targetDir, `.cover-tmp-${randomUUID()}.jpg`)
  try {
    const candidates = [...new Set([pythonBin, '/opt/homebrew/bin/python3', 'python3'].filter(Boolean))]
    for (const bin of candidates) {
      const { err } = await execBin(bin, ['-c', RESIZE_IMAGE_TO_JPEG_SCRIPT, srcImagePath, tmpOut, String(maxWidth)])
      if (!err && await exists(tmpOut)) {
        return await fs.readFile(tmpOut)
      }
    }
    if (process.platform === 'darwin') {
      const { err } = await execBin('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '84', '-Z', String(maxWidth), srcImagePath, '--out', tmpOut])
      if (!err && await exists(tmpOut)) {
        return await fs.readFile(tmpOut)
      }
    }
    return null
  } finally {
    await fs.unlink(tmpOut).catch(() => {})
  }
}

async function findLogicalPageImage(manager, t, pdfPage) {
  const docDir = manager.docDir ? manager.docDir(t) : path.join(manager.dir(t.id), 'document')
  const aiDir = manager.aiDir ? manager.aiDir(t) : path.join(docDir, 'ai_convert')
  const imgDir = path.join(aiDir, 'page_images')
  if (!(await exists(imgDir))) return null

  const docProfile = await json(path.join(docDir, 'document_profile.json'), null)
  let logicalPage = null
  if (Array.isArray(docProfile?.source_page_map) && docProfile.source_page_map.length > 0) {
    logicalPage = docProfile.source_page_map.find(m => m.source_page === pdfPage)?.logical_page ?? null
  } else if ((t.profile?.start_page ?? 1) === 1 && !t.scope?.startPage) {
    logicalPage = pdfPage
  }
  if (!Number.isInteger(logicalPage) || logicalPage < 1) return null

  for (const pad of [3, 4]) {
    const candidate = path.join(imgDir, `page_${String(logicalPage).padStart(pad, '0')}.png`)
    if (await exists(candidate)) return candidate
  }
  return null
}

/**
 * Resolve, mark, and extract a static cover.jpg into document/cover.jpg once during
 * inspection/transcription/publication or explicit manual selection.
 * Never invoked by shelf listing or reading cover routes.
 */
export async function ensureTaskCover(manager, t, { page, force = false, source } = {}) {
  if (!t?.id) return null
  const docDir = manager.docDir ? manager.docDir(t) : path.join(manager.dir(t.id), 'document')
  const coverFile = taskCoverFile(manager, t)

  if (!force && t.cover) {
    if (t.cover.none) return t.cover
    if (t.cover.file && await exists(coverFile)) {
      if (!t.cover.sha256) {
        const raw = await fs.readFile(coverFile)
        t.cover = { ...t.cover, sha256: hash(raw), bytes: raw.length }
      }
      return t.cover
    }
  }

  let coverPage = page
  let detectedReason = null
  if (coverPage === undefined) {
    if (t.cover?.source === 'manual' && t.cover.page !== undefined) {
      coverPage = t.cover.page
    } else if (t.profile?.cover_page !== undefined) {
      coverPage = t.profile.cover_page
    } else {
      const pdfFile = await taskSourcePdf(manager, t).catch(() => null)
      if (!pdfFile) {
        t.cover = {
          page: null,
          none: true,
          file: null,
          sha256: null,
          source: source ?? 'program',
          markedAt: new Date().toISOString(),
        }
        return t.cover
      }
      const detected = await detectPdfCoverPage(pdfFile, { kind: t.kind, pythonBin: manager.python })
      if (!detected) return null
      coverPage = detected.page ?? null
      detectedReason = detected.reason || null
      if (t.profile) t.profile = { ...t.profile, cover_page: coverPage }
    }
  }

  if (coverPage === null || coverPage === '') {
    await fs.unlink(coverFile).catch(() => {})
    t.cover = {
      page: null,
      none: true,
      file: null,
      sha256: null,
      source: source ?? (t.profile?.cover_page === null ? 'profile' : 'auto'),
      ...(detectedReason ? { reason: detectedReason } : {}),
      markedAt: new Date().toISOString(),
    }
    if (t.profile) t.profile = { ...t.profile, cover_page: null }
    return t.cover
  }

  const pageNum = Number(coverPage)
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    throw new Error('封面页码须为正整数或留空')
  }
  const totalPages = Number(t.inspection?.pages)
  if (Number.isInteger(totalPages) && totalPages > 0 && pageNum > totalPages) {
    throw new Error(`封面页码超出 PDF 总页数（共 ${totalPages} 页）`)
  }

  let bytes = null
  const preRenderedPng = await findLogicalPageImage(manager, t, pageNum).catch(() => null)
  if (preRenderedPng) {
    await fs.mkdir(docDir, { recursive: true })
    bytes = await convertImageFileToCoverJpeg(preRenderedPng, docDir, { pythonBin: manager.python })
  }

  if (!bytes) {
    const pdfFile = await taskSourcePdf(manager, t).catch(() => null)
    if (!pdfFile) {
      if (source === 'manual') throw new Error('未找到原 PDF 或页面图，无法提取封面')
      return null
    }
    const rendered = await renderPdfPage({
      pdfFile,
      cacheDir: path.join(manager.dir(t.id), 'pdf-pages'),
      page: pageNum,
      dpi: COVER_JPEG_DPI,
      format: 'jpeg',
      maxWidth: COVER_MAX_WIDTH,
      pythonBin: manager.python,
    })
    if (!rendered?.supported || !rendered?.bytes?.length) {
      if (source === 'manual') throw new Error(rendered?.reason || '封面提取失败')
      return null
    }
    bytes = rendered.bytes
  }

  await writeBinaryAtomic(coverFile, bytes)
  const digest = hash(bytes)
  t.cover = {
    page: pageNum,
    none: false,
    file: 'cover.jpg',
    sha256: digest,
    bytes: bytes.length,
    source: source ?? (t.profile?.cover_page === pageNum ? 'profile' : 'auto'),
    ...(detectedReason ? { reason: detectedReason } : {}),
    markedAt: new Date().toISOString(),
  }
  if (t.profile) t.profile = { ...t.profile, cover_page: pageNum }
  return t.cover
}

export async function collectCoverAsset(manager, t, { backfillIfMissing = false } = {}) {
  if (!t?.id) return null
  if (!t.cover && backfillIfMissing) {
    const extracted = await ensureTaskCover(manager, t).catch(() => null)
    if (extracted && manager.save) {
      await manager.save(t).catch(() => {})
    }
  }
  if (!t.cover?.file || t.cover?.none) return null
  const coverFile = taskCoverFile(manager, t)
  const bytes = await fs.readFile(coverFile).catch(() => null)
  if (!bytes?.length) return null
  const digest = t.cover.sha256 || hash(bytes)
  if (!t.cover.sha256) t.cover = { ...t.cover, sha256: digest, bytes: bytes.length }
  return {
    ref: COVER_ASSET_REF,
    mimeType: 'image/jpeg',
    sha256: digest,
    dataBase64: bytes.toString('base64'),
  }
}
