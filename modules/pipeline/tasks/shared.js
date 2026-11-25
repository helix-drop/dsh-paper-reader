import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const VISION = '.kimi-code/skills/fnm-ai-convert/scripts'
export const TEXT = '.kimi-code/skills/fnm-textlayer-convert/scripts'

export const ANALYZER = fileURLToPath(new URL('../../../runtime/analyze_document.py', import.meta.url))
export const WORKER_OBSERVER = fileURLToPath(new URL('../../../runtime/observe_worker.py', import.meta.url))
export const ASSEMBLER = fileURLToPath(new URL('../../../runtime/assemble_with_provenance.py', import.meta.url))
export const RESOLVE_ENDNOTES = fileURLToPath(new URL('../../../runtime/resolve_endnotes.py', import.meta.url))
export const VERIFY_DELIVERIES = fileURLToPath(new URL('../../../runtime/verify_deliveries.py', import.meta.url))
export const APPLY_SOURCE_EDIT = fileURLToPath(new URL('../../../runtime/apply_source_edit.py', import.meta.url))
export const OCR_REGION_SCRIPT = fileURLToPath(new URL('../../../runtime/ocr_region.py', import.meta.url))
export const PROBE_PAGES_SCRIPT = fileURLToPath(new URL('../../../runtime/probe_pages.py', import.meta.url))

export const STAGES = [
  { id: 'inspect', name: '输入检查', entry: 'census_borndigital / document_pipeline', scope: 'all' },
  { id: 'normalize', name: '范围与布局', entry: 'document_pipeline normalize', scope: 'pdf' },
  { id: 'images', name: '页面图', entry: 'extract_page_images', scope: 'pdf' },
  { id: 'paddle', name: 'PaddleOCR', entry: 'paddle_ocr（仅核对与失败兜底）', scope: 'ocr' },
  { id: 'mineru', name: 'MinerU', entry: 'mineru_ocr（仅核对与失败兜底）', scope: 'ocr' },
  { id: 'prepare', name: '结构准备', entry: 'tl_convert prepare / 单篇结构自动生成 / 观察 worker', scope: 'pdf' },
  { id: 'transcribe', name: '转写', entry: 'tl_convert extract / marker_prescan + bounded_chapter（视觉优先）', scope: 'pdf' },
  { id: 'verify', name: '原文校验', entry: 'gate_check 3c / verify_page_json / verify_textlayer_structure', scope: 'pdf' },
  { id: 'assemble', name: '文档装配', entry: 'assemble_chapter / assemble_book / verify_output', scope: 'pdf' },
  { id: 'glossary', name: '术语分析与合并', entry: 'LinguaGacha / 全文提取 / 一次清洗与归并', scope: 'all' },
  { id: 'lgProject', name: '翻译准备', entry: 'LinguaGacha 官方 CLI / Markdown V2', scope: 'all' },
  { id: 'translate', name: '段落翻译', entry: 'LinguaGacha batch-translation', scope: 'all' },
  { id: 'translationCheck', name: '译文校验', entry: '段落块对应 / 注释 / 附件', scope: 'all' },
  { id: 'review', name: '语义审校', entry: 'book-translation-review / 正文与术语联合审校', scope: 'all' },
  { id: 'publish', name: '发布', entry: '阅读成品与附件清单', scope: 'all' },
]

export const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)

export const documentIdFor = t => (
  t.documentId && t.documentId !== 'document:undefined'
    ? t.documentId
    : 'document:' + (t.input?.fingerprint ?? t.inspection?.fingerprint ?? t.id)
)

export const exists = async p => Boolean(await fs.stat(p).catch(() => null))

export async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(tmp, file)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

export async function json(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw new Error('任务记录格式异常')
  }
}

export async function walk(dir, extension, maxDepth = 5) {
  const out = []
  if (maxDepth < 0) return out
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue
    const f = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(f, extension, maxDepth - 1)))
    else if (extension.test(e.name)) out.push(f)
  }
  return out
}

export function parseModelChoice(id) {
  const raw = String(id ?? '')
  const sep = raw.indexOf(':')
  if (sep <= 0 || raw.indexOf(':', sep + 1) !== -1) {
    throw new Error('请选择 DeepSeek Harness 中的模型')
  }
  const provider = raw.slice(0, sep)
  const model = raw.slice(sep + 1)
  if (!provider || !model || provider.length > 80 || model.length > 120) {
    throw new Error('请选择 DeepSeek Harness 中的模型')
  }
  return { provider, model }
}

export function resolveFallbacks(primaryId, fallbackIds) {
  if (!Array.isArray(fallbackIds)) throw new Error('兜底模型格式无效')
  const ids = fallbackIds.filter(Boolean)
  if (ids.length > 2) throw new Error('最多选择两个兜底模型')
  const fallbacks = []
  for (const fid of ids) {
    const choice = parseModelChoice(fid)
    if (`${choice.provider}:${choice.model}` === primaryId) {
      throw new Error('兜底模型不能与主模型相同')
    }
    if (fallbacks.some(item => item.provider === choice.provider && item.model === choice.model)) {
      throw new Error('两个兜底模型不能相同')
    }
    fallbacks.push(choice)
  }
  return fallbacks
}

export function visionFallbackArgs(worker) {
  const seen = new Set()
  const primary = `${worker?.provider}:${worker?.model}`
  const args = []
  for (const item of worker?.fallbacks ?? []) {
    const provider = String(item?.provider ?? '')
    const model = String(item?.model ?? '')
    if (!provider || !model || provider.includes(':') || model.includes(':')) continue
    const key = `${provider}:${model}`
    if (seen.has(key) || key === primary) continue
    if (seen.size >= 2) break
    seen.add(key)
    args.push('--fallback', key)
  }
  return args
}
