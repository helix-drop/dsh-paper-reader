import {definition as readingPreset} from '../../preset.js'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readPipelineConfiguration, saveOcrCredential } from './configuration.js'
import { STAGES } from './tasks.js'
import { taskRoutes, TaskManager } from './routes.js'
import { startSubscriptionAdapter } from './linguagacha.js'
import { sessionGuard, GUARD_VERSION } from './guard.js'
import { readingWorkspace } from '../../shared/paths.js'

export const DEFAULT_PIPELINE_ROOT = '/Users/hao/K-PdfToMd'
const SKILL = '.kimi-code/skills/fnm-ai-convert'
export const PIPELINE_ENTRIES = [
  { stage: '输入分流', entry: 'census_borndigital.py', panel: '全页普查区分可靠文字层（BORN-DIGITAL）与扫描件/乱码层（SCANNED / TEXT-GARBAGE）', kind: 'both' },
  { stage: '文档结构观察', entry: '来源类型 / 正文范围 / 页面布局 / 注释体例', panel: '先区分整书、单篇论文与章节节选；单篇扫描论文可直接由确认配置生成单章结构，整书无目录时派观察 worker', kind: 'both' },
  { stage: 'OCR 参考', entry: `${SKILL}/scripts/paddle_ocr.py / mineru_ocr.py`, panel: '扫描件预生成双 OCR 备查；平时坚持视觉转写优先，仅在模型转写失败（尤指审核拒答/无法辨读）时启用 OCR 数据降级恢复', kind: 'both' },
  { stage: '文字层提取', entry: '.kimi-code/skills/fnm-textlayer-convert/scripts/tl_convert.py', panel: '可靠文字层默认直接提取，也可切换为视觉转写并用文字层作基线核对', kind: 'both' },
  { stage: '视觉转写', entry: `${SKILL}/scripts/bounded_chapter.py`, panel: '首轮纯视觉盲读（image_first_no_ocr_v1），自动执行注释标记预扫；仅首轮审核拒答或无法辨读时受控启用 OCR 降级', kind: 'both' },
  { stage: '观察 worker', entry: 'DSH subagent / WORKER_SPEC_P0_P1_P2_P4', panel: '仅观察与结构判断，完整规格派发；不得承接 P3 转写', kind: 'internal' },
  { stage: 'worker 调用', entry: `${SKILL}/scripts/worker_call.py`, panel: '仅详情展示，禁止直接启动绕过预算', kind: 'internal' },
  { stage: '程序校验与装配', entry: `${SKILL}/scripts/gate_check.py / verify_page_json.py / assemble_chapter.py / verify_output.py`, panel: '单次级联门禁校验后直接装配章节与整书，显示阻断项及警告，不等同语义验收', kind: 'both' },
  { stage: '术语管理', entry: 'lingua/curate_glossary.py', panel: '显示术语版本与待确认冲突', kind: 'both' },
  { stage: '段落翻译', entry: 'LinguaGacha --cli translate / Markdown V2', panel: '与编排模型分开，记录 CLI 进度、完成缓存和失败状态；不承诺逐块续跑', kind: 'both' },
  { stage: '译文检查', entry: 'lingua/check_translation.py', panel: '按块对应校验脚注与附件配对', kind: 'both' },
  { stage: '发布', entry: 'publish-book', panel: '先展示成品及附件清单，同名差异文件不覆盖，确认后发布并核验', kind: 'both' },
  { stage: '独立语义审校', entry: 'book-translation-review', panel: '可选阶段，不用重复转写替代审校', kind: 'both' },
]
const REQUIRED = ['AGENTS.md', '.kimi-code/AGENTS.md', `${SKILL}/SKILL.md`, `${SKILL}/scripts/harness_guard.py`, `${SKILL}/scripts/bounded_chapter.py`, `${SKILL}/scripts/worker_call.py`, 'document_pipeline.py', 'lingua/lg-config', 'publish-book']
const ENTRY_FILES = {
  '输入分流': ['census_borndigital.py'],
  'OCR 参考': ['paddle_ocr.py', 'mineru_ocr.py'].map(f => `${SKILL}/scripts/${f}`),
  '文字层提取': ['.kimi-code/skills/fnm-textlayer-convert/scripts/tl_convert.py'],
  '视觉转写': [`${SKILL}/scripts/bounded_chapter.py`, `${SKILL}/scripts/marker_prescan.py`],
  'worker 调用': [`${SKILL}/scripts/worker_call.py`],
  '程序校验与装配': ['gate_check.py', 'verify_page_json.py', 'assemble_chapter.py', 'assemble_book.py', 'verify_output.py', 'audit_book.py'].map(f => `${SKILL}/scripts/${f}`),
  '术语管理': ['lingua/curate_glossary.py'],
  '段落翻译': ['/Applications/LinguaGacha.app/Contents/MacOS/LinguaGacha'],
  '译文检查': ['lingua/check_translation.py'],
  '发布': ['publish-book'],
  '独立语义审校': ['book-translation-review/SKILL.md'],
}

export function pipelineGuard(root, exec, inspectSessions = new Set()) {
  const id = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
  return sessionGuard(root, exec, { inspect: inspectSessions.has(id) })
}

export async function exists(file) { try { await fs.access(file); return true } catch { return false } }
async function json(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback } }
export async function inspectPipeline(root, guardEnabled) {
  const missing = []
  for (const f of REQUIRED) if (!await exists(path.join(root, f))) missing.push(f)
  const entryChecks = []
  for (const entry of PIPELINE_ENTRIES) {
    const files = []
    for (const file of ENTRY_FILES[entry.stage] ?? []) files.push({ file, exists: await exists(path.isAbsolute(file) ? file : path.join(root, file)) })
    const status = files.some(f => !f.exists) ? '缺少文件' : entry.stage === '文档结构观察' ? '正文范围与结构待核验' : entry.stage === '观察 worker' ? 'DSH 子代理未实测' : entry.stage === '段落翻译' ? '持久工程与版本兼容接口已接入' : entry.stage === '发布' || entry.stage === '译文检查' ? '块检查与清单发布已接入' : '入口文件已检查，未执行任务'
    entryChecks.push({ ...entry, files, status })
  }
  const source = await fs.readFile(path.join(root, SKILL, 'scripts/worker_call.py'), 'utf8').catch(() => '')
  const provider = source.match(/^DEFAULT_PROVIDER\s*=\s*['"]([^'"]+)/m)?.[1] ?? 'unknown'
  const configBlock = source.split(`"${provider}": {`)[1]?.split('\n    },')[0] ?? ''
  const model = configBlock.match(/"default_model":\s*"([^"]+)"/)?.[1] ?? 'unknown'
  const entries = await fs.readdir(path.join(root, 'Book'), { withFileTypes: true }).catch(() => [])
  const books = []
  for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('_')).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, 'Book', entry.name)
    const chapters = await json(path.join(dir, 'ai_convert/chapters.json'), [])
    const analysis = await json(path.join(dir, 'ai_convert/book_analysis.json'), {})
    const report = await fs.readFile(path.join(dir, 'translation/check_report.md'), 'utf8').catch(() => '')
    const names = await fs.readdir(dir)
    const hasPdf = names.some(n => /\.pdf$/i.test(n))
    books.push({ hasPdf, name: entry.name, language: analysis.language ?? '', chapters: Array.isArray(chapters) ? chapters.length : 0, hasTranslationReport: !!report, translationChecksPassed: !!report && !report.includes('❌') })
  }
  return { root, stages:STAGES, guardEnabled, guardVersion:GUARD_VERSION, guardTransport:'单次 JSON 工具调用；嵌套工具继续执行角色检查', ready: guardEnabled && missing.length === 0, missing, worker: { provider, model, role: 'P3 视觉转写（Vision-First）', entry: `${SKILL}/scripts/bounded_chapter.py`, rules: '首轮纯视觉盲读（image_first_no_ocr_v1）；双 OCR 仅作后台核对与模型转写失败（尤其审核拒答）时的受控降级，每页默认两轮，不静默切换模型' }, translator: { engine: 'LinguaGacha 官方 CLI / MD_V2', config: '无需 GUI；模型、提示词与术语按任务保存，失败不宣称逐块续跑' }, books, processingReady: guardEnabled && missing.length === 0, readinessMeaning: '受控阶段入口已接入；每项任务仍须确认结构并通过对应门禁，不代表内容已验收', entries: entryChecks }
}

export function installPipelineModule(ctx, config) {
  const root = path.resolve(config?.pipelineWorkspace ?? config?.bookWorkspace ?? DEFAULT_PIPELINE_ROOT)
  // Local placeholders are not OAuth secrets. DSH never receives xAI tokens.
  ctx.inject(['credentials'], credentialContext => {
    void (async()=>{
      await credentialContext.credentials.set('XAI_LOCAL_ADAPTER_KEY','xai-local')
      await startSubscriptionAdapter(root,'xai')
      await startSubscriptionAdapter(root,'opencode')
    })().catch(()=>ctx.logger.warn('本地订阅适配器未启动，请在服务设置中检查；未读取或显示登录凭证。'))
  })
  const guardEnabled = typeof ctx.tools.guard === 'function'
  const stateFile = path.join(root, '.pipeline/dsh-inspect-sessions.json')
  let remembered = []
  try { remembered = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}
  const inspectSessions = new Set(Array.isArray(remembered) ? remembered.filter(x => typeof x === 'string') : [])
  const taskSessionFile = path.join(root, '.pipeline/dsh-task-sessions.json')
  let savedTaskSessions = {}; try { savedTaskSessions = JSON.parse(readFileSync(taskSessionFile, 'utf8')) } catch {}
  const taskSessions = new Map(Object.entries(savedTaskSessions))
  const authorizationFile=path.join(root,'.pipeline/dsh-task-authorizations.json');let authorizations={};try{authorizations=JSON.parse(readFileSync(authorizationFile,'utf8'))}catch{}
  const manager = new TaskManager(root, readingWorkspace())
  let presetRegistry,presetReady;ctx.inject(['agentPresets'],c=>{presetRegistry=c.agentPresets;presetReady=c.agentPresets.register(readingPreset).then(dispose=>{ctx.on('dispose',()=>{void dispose()})})})
  const registerTaskSession = async (id, taskId, mode='processing',stage=null) => {
    if (typeof id !== 'string' || !/^[\w-]{8,100}$/.test(id) || inspectSessions.has(id)&&mode!=='inspect') throw new Error('任务会话编号无效或只读会话不能升级')
    if(stage){if(stage!=='diagnose'&&!STAGES.some(s=>s.id===stage))throw new Error('授权阶段无效');authorizations[id]={taskId,stage};await fs.writeFile(authorizationFile,JSON.stringify(authorizations),{mode:0o600})}
    if(mode==='inspect'){inspectSessions.add(id);await fs.mkdir(path.dirname(stateFile),{recursive:true});await fs.writeFile(stateFile,JSON.stringify([...inspectSessions]),{mode:0o600})}taskSessions.set(id, taskId); await fs.mkdir(path.dirname(taskSessionFile), {recursive:true}); await fs.writeFile(taskSessionFile, JSON.stringify(Object.fromEntries(taskSessions)), {mode:0o600})
  }
  if (guardEnabled) ctx.tools.guard(exec => {
    const id=exec?.agent?.session?.id??exec?.agent?.session?.header?.id,parent=exec?.agent?.session?.header?.parentSession;if(parent){if(taskSessions.has(parent)&&!taskSessions.has(id))taskSessions.set(id,taskSessions.get(parent));if(inspectSessions.has(parent))inspectSessions.add(id)}const taskId=taskSessions.get(id)
    return sessionGuard(root,exec,{inspect:inspectSessions.has(id),taskDirectory:taskId?manager.dir(taskId):null,authorizedStage:(authorizations[id]??authorizations[parent])?.stage})
  })
  ctx.on('dispose',()=>{void manager.index.close()})
  ctx.tools.register({
    name: 'document_pipeline',
    description: `统一文档编排：inspect 检查环境，task 读取当前会话绑定任务，run 调用面板已确认任务的受控阶段。未绑定会话不能运行任务，不能写密钥或发布。工作目录必须为 ${root}。先核验文档来源、正文范围、页面布局和注释体例。扫描件预生成双 OCR，但坚持视觉转写优先（首轮纯视觉盲读），仅在模型转写失败（尤其遇到内容审核拒答或图像无法辨读）时启用 OCR 降级恢复。单篇扫描论文/章节可直接由已确认配置生成单章结构并过门禁；整书按结构观察切分章节。P3 调 bounded_chapter.py，不直接写 body/notes、不派 P3 子代理。翻译使用 LinguaGacha 官方 CLI 与 MD_V2；任务保存结果和状态，不需要 GUI。检查结果不代表转写或语义验收。`,
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['inspect', 'task', 'run'] }, taskId: {type:'string'}, stage: {type:'string'} }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      if(args.action==='inspect') return {...await inspectPipeline(root,guardEnabled),sessionCwd:exec?.agent?.session?.header?.cwd??null}
      const session=exec?.agent?.session, id=session?.id??session?.header?.id
      if(path.resolve(session?.header?.cwd??'/')!==root||taskSessions.get(id)!==args.taskId) throw new Error('此会话未绑定指定文档任务')
      if(args.action==='task'){const t=await manager.get(args.taskId);return {...t,authorization:authorizations[id]??null,evidencePaths:{document:manager.docDir(t),pageImages:path.join(manager.aiDir(t),'page_images'),pageFilePattern:'page_NNN.png',logicalPages:t.scope?.pages??null,logicalPageMeaning:'规范化后的页码从1开始；原PDF页码不能直接用作图片文件编号',originalStartPage:t.profile?.start_page??null,structure:path.join(manager.docDir(t),'ai_convert')},log:t.log?.slice(-3).map(({stage,command,exitCode,endedAt})=>({stage,command,exitCode,endedAt})),logSummary:'完整运行日志保留在任务中；编排输入只显示最近三次执行摘要'}}
      if(session.header.origin==='subagent'||(session.header.delegationDepth??0)>0)throw new Error('观察 worker 不能运行处理阶段');if(['publish','review'].includes(args.stage))throw new Error('发布清单及语义审校由面板单独操作')
      if(authorizations[id]?.stage==='diagnose')throw new Error('核查会话不能启动处理阶段');if(authorizations[id]&&args.stage!==authorizations[id].stage)throw new Error('此会话只获准执行阶段 '+authorizations[id].stage);if(session.header.agentPreset==='reading-document'&&!authorizations[id])throw new Error('文档预设缺少阶段授权');
      if(!guardEnabled)throw new Error('角色拦截未安装，不能运行模型任务');return manager.start(args.taskId,args.stage)
    },
  })
  return [
    ...taskRoutes(manager, registerTaskSession),
    {method:'GET',pattern:/^\/pipeline\/presets$/,handler:async(_req,res)=>{await presetReady;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({presets:await presetRegistry.list(),readingPreset:readingPreset.id}))}},
    { method: 'GET', pattern: /^\/pipeline\/configuration$/, handler: async (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(await readPipelineConfiguration(root))) } },
    { method: 'POST', pattern: /^\/pipeline\/ocr-credential$/, handler: async (req, res) => {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('request too large') }
      let body; try { body = JSON.parse(raw) } catch { throw new Error('OCR 配置请求格式无效。') }
      if (!body || typeof body !== 'object') throw new Error('OCR 配置请求格式无效。')
      const result = await saveOcrCredential(root, body.service, body.apiKey)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    } },
    { method: 'GET', pattern: /^\/pipeline$/, handler: async (_req, res) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(await inspectPipeline(root, guardEnabled))) } },
    { method: 'POST', pattern: /^\/pipeline\/inspect-session$/, handler: async (req, res) => {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1024) throw new Error('request too large') }
      const { sessionId } = JSON.parse(raw)
      if (typeof sessionId !== 'string' || !/^[\w-]{8,100}$/.test(sessionId)) throw new Error('invalid session id')
      inspectSessions.add(sessionId)
      await fs.mkdir(path.dirname(stateFile), { recursive: true })
      await fs.writeFile(stateFile, JSON.stringify([...inspectSessions]))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, mode: 'read-only' }))
    } },
  ]
}
