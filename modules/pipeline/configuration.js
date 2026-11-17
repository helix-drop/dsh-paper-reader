import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
const SKILL = '.kimi-code/skills/fnm-ai-convert'
async function readJson(file) { try { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('项目配置格式异常，未读取或修改密钥。') } }
export async function readPipelineConfiguration(root, modelService) {
  const workers = modelService ? await modelService.workers() : []
  const cfg = await readJson(path.join(root, SKILL, 'config.json'))
  const minerCfg = cfg.ocr?.mineru ?? cfg.ocr ?? {}
  const paddleEnvironment = !!process.env.PADDLEOCR_TOKEN
  const minerEnvironment = !!process.env[minerCfg.api_key_env || 'MINERU_API_KEY'] || !!process.env.MINERU_API_KEY
  return { workers, ocr: [
    { id: 'paddle', name: 'PaddleOCR', configured: paddleEnvironment || !!cfg.ocr?.paddle?.api_key, credentialSource: paddleEnvironment ? '环境变量优先' : cfg.ocr?.paddle?.api_key ? '项目配置' : '未配置', model: cfg.ocr?.paddle?.default_model || 'paddleocr-vl-1.6', connectionVerified: false },
    { id: 'mineru', name: 'MinerU', configured: minerEnvironment || !!minerCfg.api_key, credentialSource: minerEnvironment ? '环境变量优先' : minerCfg.api_key ? '项目配置' : '未配置', model: minerCfg.model_version || 'vlm', connectionVerified: false },
  ], ocrPolicy: '视觉转写优先：扫描件首轮直接读取原页图像；需要辅助辨读时，由模型选择页码与区域后调用 OCR。同一区域自动复用结果，不要求整书 OCR。主模型失败后依次尝试任务配置的最多两个兜底模型，全部失败才 OCR 抄写。已选定的视觉页不会因后续传输失败被替换。后台差异比对不直接覆盖视觉转写。可靠文字层与现成 Markdown 不调用云 OCR。' }
}
// Only the authenticated settings route calls this; never expose a credential-writing model tool.
let credentialWriteQueue = Promise.resolve()
export async function saveOcrCredential(root, service, apiKey) {
  if (!['paddle', 'mineru'].includes(service) || typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) throw new Error('OCR 服务或密钥格式无效。')
  const write = async () => {
    const file = path.join(root, SKILL, 'config.json')
    const cfg = await readJson(file)
    cfg.ocr ??= {}
    if (typeof cfg.ocr !== 'object' || Array.isArray(cfg.ocr)) throw new Error('项目 OCR 配置格式异常，未修改密钥。')
    cfg.ocr[service] ??= {}
    if (typeof cfg.ocr[service] !== 'object' || Array.isArray(cfg.ocr[service])) throw new Error('项目 OCR 配置格式异常，未修改密钥。')
    cfg.ocr[service].api_key = apiKey.trim()
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await fs.rename(temp, file)
      await fs.chmod(file, 0o600)
    } finally { await fs.unlink(temp).catch(() => {}) }
    return { saved: true, service, configured: true, connectionVerified: false }
  }
  const next = credentialWriteQueue.then(write)
  credentialWriteQueue = next.catch(() => {})
  return next
}
