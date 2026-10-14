import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const SKILL = '.kimi-code/skills/fnm-ai-convert'
const PUBLIC_PROVIDER_READER = `import ast,json,sys
t=ast.parse(sys.stdin.read());p={};d=''
for n in t.body:
 if isinstance(n,ast.Assign):
  for k in n.targets:
   if isinstance(k,ast.Name) and k.id=='PROVIDERS': p=ast.literal_eval(n.value)
   if isinstance(k,ast.Name) and k.id=='DEFAULT_PROVIDER': d=ast.literal_eval(n.value)
print(json.dumps({'defaultProvider':d,'providers':p}))`
async function readJson(file) { try { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('项目配置格式异常，未读取或修改密钥。') } }
export async function readPipelineConfiguration(root) {
  const source = await fs.readFile(path.join(root, SKILL, 'scripts/worker_call.py'), 'utf8')
  const parsed = spawnSync('python3', ['-c', PUBLIC_PROVIDER_READER], { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 })
  if (parsed.status !== 0) throw new Error('无法读取项目的公开 worker 配置。')
  const { defaultProvider, providers } = JSON.parse(parsed.stdout)
  const envText = await fs.readFile(path.join(root, SKILL, '.worker_env'), 'utf8').catch(() => '')
  const hasKey = name => !!process.env[name] || envText.split('\n').some(line => line.trim().startsWith(`${name}=`) && line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') !== '')
  const workers = []
  for (const [provider, cfg] of Object.entries(providers)) {
    const models = [cfg.default_model]
    if (provider === 'mimo' && (await fs.readFile(path.join(root, SKILL, 'SKILL.md'), 'utf8')).includes('mimo-v2.6-pro')) models.push('mimo-v2.6-pro')
    for (const model of models) workers.push({
      id: `${provider}:${model}`, provider, model, default: provider === defaultProvider && model === cfg.default_model,
      role: provider === 'xai' ? '仅结构裁判，不能作主转写' : provider === 'minimax' ? '历史通道，订阅未验证' : provider === 'gemini' ? '试点通道，质量未验收' : '转写候选',
      selectable: provider !== 'xai', credential: cfg.key_name === 'OPENAI_OAUTH' ? '使用项目登录态，尚未验证' : hasKey(cfg.key_name) ? '已配置，连接未验证' : '未配置 API key',
      timeout: cfg.request_deadline ?? cfg.request_timeout ?? 120, batchSize: cfg.batch_size ?? null, thinking: cfg.thinking?.type ?? '沿用项目配置', connectionVerified: false,
    })
  }
  const cfg = await readJson(path.join(root, SKILL, 'config.json'))
  const minerCfg = cfg.ocr?.mineru ?? cfg.ocr ?? {}
  const paddleEnvironment = !!process.env.PADDLEOCR_TOKEN
  const minerEnvironment = !!process.env[minerCfg.api_key_env || 'MINERU_API_KEY'] || !!process.env.MINERU_API_KEY
  return { workers, ocr: [
    { id: 'paddle', name: 'PaddleOCR', configured: paddleEnvironment || !!cfg.ocr?.paddle?.api_key, credentialSource: paddleEnvironment ? '环境变量优先' : cfg.ocr?.paddle?.api_key ? '项目配置' : '未配置', model: cfg.ocr?.paddle?.default_model || 'paddleocr-vl-1.6', connectionVerified: false },
    { id: 'mineru', name: 'MinerU', configured: minerEnvironment || !!minerCfg.api_key, credentialSource: minerEnvironment ? '环境变量优先' : minerCfg.api_key ? '项目配置' : '未配置', model: minerCfg.model_version || 'vlm', connectionVerified: false },
  ], ocrPolicy: '视觉转写优先：扫描件必须预生成双 OCR（PaddleOCR + MinerU），但首轮由多模态模型纯视觉盲读（image_first_no_ocr_v1）；仅当模型转写失败（尤其是遇到内容审核拒答或图像无法辨读）时才启用 OCR 数据作降级恢复或兜底，后台差异比对不直接覆盖视觉转写。可靠文字层与现成 Markdown 不调用云 OCR。' }
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
