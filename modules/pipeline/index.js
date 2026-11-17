import {HarnessModels} from './harness-models.js'
import {LINGUAGACHA_CLI} from './cli.js'
import {definition as readingPreset} from '../../preset.js'
import fs from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readPipelineConfiguration, saveOcrCredential } from './configuration.js'
import { STAGES } from './tasks.js'
import { taskRoutes, TaskManager } from './routes.js'
import { startSubscriptionAdapter } from './linguagacha.js'
import { sessionGuard, GUARD_VERSION } from './guard.js'
import { readingWorkspace } from '../../shared/paths.js'
import {TaskSessions} from './sessions.js'
import {executionEvents} from './execution-feed.js'
import {executeInSession} from './session-execution.js'
import {evidenceSummary,evidenceFiles,evidenceSearch,taskSummary} from './evidence.js'
import {transcriptionProgress} from './progress.js'

import {defaultPipelineWorkspace} from '../../shared/workspace.js'
export const DEFAULT_PIPELINE_ROOT = defaultPipelineWorkspace()
const SKILL = '.kimi-code/skills/fnm-ai-convert'
export const PIPELINE_ENTRIES = [
  { stage: '输入分流', entry: 'census_borndigital.py', panel: '全页普查区分可靠文字层（BORN-DIGITAL）与扫描件/乱码层（SCANNED / TEXT-GARBAGE）', kind: 'both' },
  { stage: '文档结构观察', entry: '来源类型 / 正文范围 / 页面布局 / 注释体例', panel: '先区分整书、单篇论文与章节节选；单篇扫描论文可直接由确认配置生成单章结构，整书无目录时派观察 worker', kind: 'both' },
  { stage: 'OCR 参考', entry: `${SKILL}/scripts/paddle_ocr.py / mineru_ocr.py`, panel: '扫描件按需选择页内区域调用 OCR，同一区域复用已有结果。主模型失败后依次尝试最多两个已配置兜底模型，全部失败才 OCR 抄写。已选定的视觉页不会因后续传输失败被替换。', kind: 'both' },
  { stage: '文字层提取', entry: '.kimi-code/skills/fnm-textlayer-convert/scripts/tl_convert.py', panel: '可靠文字层默认直接提取，也可切换为视觉转写并用文字层作基线核对', kind: 'both' },
  { stage: '视觉转写', entry: `${SKILL}/scripts/bounded_chapter.py`, panel: '首轮纯视觉盲读（image_first_no_ocr_v1），自动执行注释标记预扫。主模型失败后依次尝试最多两个兜底模型，全部失败才 OCR 抄写。', kind: 'both' },
  { stage: '观察 worker', entry: 'DSH subagent / WORKER_SPEC_P0_P1_P2_P4', panel: '仅观察与结构判断，完整规格派发；不得承接 P3 转写', kind: 'internal' },
  { stage: 'worker 调用', entry: `${SKILL}/scripts/worker_call.py`, panel: '仅详情展示，禁止直接启动绕过预算', kind: 'internal' },
  { stage: '程序校验与装配', entry: `${SKILL}/scripts/gate_check.py / verify_page_json.py / assemble_chapter.py / verify_output.py`, panel: '单次级联门禁校验后直接装配章节与整书，显示阻断项及警告，不等同语义验收', kind: 'both' },
  { stage: '术语管理', entry: 'LinguaGacha 官方 CLI + 术语分析提示词', panel: '全文分析、清洗、原文冲突处理、公共表与本书覆盖表', kind: 'both' },
  { stage: '段落翻译', entry: 'LinguaGacha --cli translate / Markdown V2', panel: '与编排模型分开；完成块经原文与结构核验后复用，恢复只提交缺失块', kind: 'both' },
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
  '程序校验与装配': ['gate_check.py', 'verify_page_json.py', 'assemble_chapter.py', 'assemble_book.py', 'verify_output.py'].map(f => `${SKILL}/scripts/${f}`),
  '术语管理': [LINGUAGACHA_CLI],
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
export async function inspectPipeline(root, guardEnabled, modelService) {
  const missing = []
  for (const f of REQUIRED) if (!await exists(path.join(root, f))) missing.push(f)
  const entryChecks = []
  for (const entry of PIPELINE_ENTRIES) {
    const files = []
    for (const file of ENTRY_FILES[entry.stage] ?? []) files.push({ file, exists: await exists(path.isAbsolute(file) ? file : path.join(root, file)) })
    const status = files.some(f => !f.exists) ? '缺少文件' : entry.stage === '文档结构观察' ? '正文范围与结构待核验' : entry.stage === '观察 worker' ? 'DSH 子代理未实测' : entry.stage === '段落翻译' ? '持久工程与版本兼容接口已接入' : entry.stage === '发布' || entry.stage === '译文检查' ? '块检查与清单发布已接入' : '入口文件已检查，未执行任务'
    entryChecks.push({ ...entry, files, status })
  }
  const catalog=modelService?await modelService.catalog():null
  const {provider='',model=''}=catalog?.default??{}
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
  return { root, stages:STAGES, guardEnabled, guardVersion:GUARD_VERSION, guardTransport:'单次 JSON 工具调用；嵌套工具继续执行角色检查', ready: guardEnabled && missing.length === 0, missing, worker: { provider, model, role: 'P3 视觉转写（Vision-First）', entry: `${SKILL}/scripts/bounded_chapter.py`, rules: '首轮纯视觉盲读（image_first_no_ocr_v1）。主模型失败后依次尝试任务里配置的最多两个兜底模型，全部失败才 OCR 抄写。已选定的视觉页不会因后续传输失败被替换。每页预算不变。' }, translator: { engine: 'LinguaGacha 官方 CLI / MD_V2', config: '无需 GUI；模型、提示词与术语按任务保存，核验通过的完成块支持恢复' }, modelCatalog:catalog, books, processingReady: guardEnabled && missing.length === 0, readinessMeaning: '受控阶段入口已接入；每项任务仍须确认结构并通过对应门禁，不代表内容已验收', entries: entryChecks }
}

export function installPipelineModule(ctx, config) {
  const root = path.resolve(config?.pipelineWorkspace ?? config?.bookWorkspace ?? DEFAULT_PIPELINE_ROOT)
  const pluginRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
  if (root !== pluginRoot) {
    try {
      const docsSrc = path.join(pluginRoot, 'docs'), docsDst = path.join(root, 'docs')
      if (!existsSync(docsDst)) fs.symlink(docsSrc, docsDst, 'dir').catch(() => {})
      const readmeSrc = path.join(pluginRoot, 'README.md'), readmeDst = path.join(root, 'README.md')
      if (!existsSync(readmeDst)) fs.symlink(readmeSrc, readmeDst, 'file').catch(() => {})
    } catch {}
  }
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
  manager.requireExecutionSessions=true
  manager.requireHarnessModels=true
  ctx.inject(['llm','sessionController','attachments'],host=>{
    const service=new HarnessModels(host);manager.modelService=service
    manager.cliStatus=()=>manager.translationStatus()
    ctx.on('dispose',()=>{void service.close();if(manager.modelService===service)manager.modelService=null})
  })
  let presetRegistry, presetReady
  ctx.inject(['agentPresets'], c => {
    presetRegistry = c.agentPresets
    const registerPreset = async () => {
      if (c.agentPresets.definitions?.has(readingPreset.id)) return
      try {
        const dispose = await c.agentPresets.register(readingPreset)
        ctx.on('dispose', () => { try { void dispose() } catch {} })
      } catch (e) {
        if (!String(e?.message).includes('Duplicate agent preset')) {
          ctx.logger?.warn?.('agentPresets.register error: ' + (e?.message || e))
        }
      }
    }
    presetReady = registerPreset().catch(() => {})
  })
  const registerTaskSession = async (id, taskId, mode='processing',stage=null) => {
    if (typeof id !== 'string' || !/^[\w-]{8,100}$/.test(id) || inspectSessions.has(id)&&mode!=='inspect') throw new Error('任务会话编号无效或只读会话不能升级')
    if(stage){if(stage!=='diagnose'&&!STAGES.some(s=>s.id===stage))throw new Error('授权阶段无效');authorizations[id]={taskId,stage};await fs.writeFile(authorizationFile,JSON.stringify(authorizations),{mode:0o600})}
    if(mode==='inspect'){inspectSessions.add(id);await fs.mkdir(path.dirname(stateFile),{recursive:true});await fs.writeFile(stateFile,JSON.stringify([...inspectSessions]),{mode:0o600})}taskSessions.set(id, taskId); await fs.mkdir(path.dirname(taskSessionFile), {recursive:true}); await fs.writeFile(taskSessionFile, JSON.stringify(Object.fromEntries(taskSessions)), {mode:0o600})
  }
  const unregisterTaskSession = async (id) => {
    taskSessions.delete(id); delete authorizations[id]; inspectSessions.delete(id)
    await fs.writeFile(taskSessionFile, JSON.stringify(Object.fromEntries(taskSessions)), {mode:0o600}).catch(()=>{})
    await fs.writeFile(authorizationFile, JSON.stringify(authorizations), {mode:0o600}).catch(()=>{})
  }
  ctx.inject(['sessionController','agents','workspaceRegistry','sessions'],host=>{
    const monitor=new TaskSessions(manager,host,registerTaskSession,unregisterTaskSession)
    manager.sessionMonitor=monitor;monitor.start()
    ctx.on('dispose',()=>monitor.close())
  })
  if (guardEnabled) ctx.tools.guard(exec => {
    const id=exec?.agent?.session?.id??exec?.agent?.session?.header?.id,parent=exec?.agent?.session?.header?.parentSession;if(parent){if(taskSessions.has(parent)&&!taskSessions.has(id))taskSessions.set(id,taskSessions.get(parent));if(inspectSessions.has(parent))inspectSessions.add(id)}const taskId=taskSessions.get(id)
    return sessionGuard(root,exec,{inspect:inspectSessions.has(id),taskDirectory:taskId?manager.dir(taskId):null,authorizedStage:(authorizations[id]??authorizations[parent])?.stage})
  })
  manager.startBackgroundSync?.()
  ctx.on('dispose',()=>{
    manager.stopBackgroundSync?.()
    void manager.index.close()
  })
  ctx.tools.register({
    name: 'document_pipeline',
    timeoutMs: 24 * 60 * 60 * 1000,
    description: `证据工具：evidence 返回实际存在的章节 state、report、selectedBook、actions、similarity、body 和 notes 路径及验收错误摘要，可按 chapterId 筛选。files 分页列出当前任务目录，directory 默认任务根；已有文件名片段时用 query 筛选后分页。search 在指定 file 内查询 query 文本，offset 为零起始行号，结果含从 1 开始的行号与后续 nextOffset。probe_page 或 probe 受控探测指定原页（page 或 pages 数组，最多 8 页），提取文本层并渲染原页高清图至 probe-pages 供 read_image 查验。先定位再 read，禁止猜文件路径；大报告先看摘要再按需读取。统一文档编排：inspect 检查环境，task 读取当前会话绑定任务，run 执行当前任务内的处理、验证与恢复；阶段内可修复当前任务结果；转写、术语分析与翻译、审校与发布三阶段分别需要用户在面板选模型并确认，阶段完成后必须停止，review_prepare / review_assemble / review_apply 执行译后分包审计准备、汇总门禁校验与受控补丁应用。未绑定会话不能运行任务，不能写密钥或发布。工作目录必须为 ${root}。先核验文档来源、正文范围、页面布局和注释体例。扫描件先按原页图像转写；有疑点时用 ocr 指定 page 和 region [左,上,右,下]，坐标为页宽高的 0 到 1 比例，程序截取该区域后调用 PaddleOCR。同一区域复用已有结果或云端任务，不能反复提交。OCR 返回仅为辅助证据。主模型失败后依次尝试最多两个已配置兜底模型，全部失败才 OCR 抄写。已选定的视觉页不会因后续传输失败被替换。单篇扫描论文/章节可直接由已确认配置生成单章结构并过门禁；整书按结构观察切分章节。P3 调 bounded_chapter.py，可修正已有 body/notes，修正后重新验收，不派 P3 子代理。翻译使用 LinguaGacha 官方 CLI 与 MD_V2；任务保存结果和状态，不需要 GUI。检查结果不代表转写或语义验收。sync_profile 在底本物理范围不变时，无损同步 profile.candidate.json/profile.json 到 document_profile.json 与 book_analysis.json，并自动对齐 scope 指纹快照与交付哈希。`,
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['inspect', 'task', 'evidence', 'files', 'search', 'probe_page', 'probe', 'ocr', 'run', 'review_prepare', 'review_assemble', 'review_apply', 'reset_transcription', 'sync_profile'] }, page:{type:'integer',minimum:1}, pages:{type:'array',items:{type:'integer',minimum:1},maxItems:8}, region:{type:'array',items:{type:'number',minimum:0,maximum:1},minItems:4,maxItems:4}, reason:{type:'string'}, taskId: {type:'string'}, stage: {type:'string'}, chapterId:{type:'string'}, directory:{type:'string'}, file:{type:'string'}, query:{type:'string'}, offset:{type:'integer',minimum:0}, limit:{type:'integer',minimum:1,maximum:100}, options:{type:'object',properties:{reanalyze:{type:'boolean'},retryErrors:{type:'boolean'},singleStep:{type:'boolean'},cleanChapters:{type:'boolean'},chapterId:{type:'string'},textLimit:{type:'integer',minimum:100,maximum:20000}},additionalProperties:false} }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const run = async () => {
        if(args.action==='inspect') return {...await inspectPipeline(root,guardEnabled,manager.modelService),sessionCwd:exec?.agent?.session?.header?.cwd??null}
        const session=exec?.agent?.session, id=session?.id??session?.header?.id, parent=session?.header?.parentSession
        if(parent&&taskSessions.has(parent)&&!taskSessions.has(id))taskSessions.set(id,taskSessions.get(parent))
        const taskId=args.taskId??taskSessions.get(id)
        if(path.resolve(session?.header?.cwd??'/')!==root||!taskId||taskSessions.get(id)!==taskId) throw new Error('此会话未绑定指定文档任务')
        const resolved={...args,taskId}
        if(args.action==='evidence')return evidenceSummary(manager,await manager.get(taskId),resolved)
        if(args.action==='files')return evidenceFiles(manager.dir(taskId),resolved)
        if(args.action==='search')return evidenceSearch(manager.dir(taskId),resolved)
        if(args.action==='probe_page'||args.action==='probe')return manager.probePage(taskId,resolved)
        if(args.action==='task'){const t=await manager.get(taskId),taskDir=manager.dir(t.id);return {...taskSummary(t),fullTaskFile:path.join(taskDir,'task.json'),phaseApproval:t.phaseApproval??null,authorization:authorizations[id]??null,mandatoryManual:'docs/PIPELINE-MANUAL.md',mandatoryInstruction:'首次处理必须阅读 docs/PIPELINE-MANUAL.md；已读且未变时复用，缺少当前阶段规则时按需补读；转写与校验异常先查 §3.3 现有恢复入口。目录三重交叉核验与底本快照冻结规则持续适用。',evidenceTools:{summary:'document_pipeline evidence；可指定 chapterId',locate:'document_pipeline files；directory 为任务内目录，可用 query 按文件名片段筛选后分页',search:'document_pipeline search；file 为明确文件，query 为待查询文本',probe:'document_pipeline probe_page；指定 page 或 pages 提取文本层并渲染原页图至 probe-pages，结合 read_image 查看',diagnosticRule:'已有工具返回的准确路径可直接 read；仅在路径未知时用 evidence/files 定位，禁止把 <book> 当作文档根目录或猜测路径'},evidencePaths:{document:manager.docDir(t),pageImages:path.join(manager.aiDir(t),'page_images'),pageFilePattern:'page_NNN.png',logicalPages:t.scope?.pages??null,logicalPageMeaning:'规范化后的页码从1开始；原PDF页码不能直接用作图片文件编号',originalStartPage:t.profile?.start_page??null,structure:path.join(manager.docDir(t),'ai_convert'),reviewAudit:t.reviewAudit?.auditDir??path.join(taskDir,'review/audit'),reviewInstructions:'先调用 review_prepare，使用返回的 auditDir、manifest 和 pendingPackets 路径'},log:t.log?.slice(-3).map(({stage,command,exitCode,endedAt})=>({stage,command,exitCode,endedAt})),logSummary:'完整运行日志保留在任务中；编排输入只显示最近三次执行摘要'}}
        if(session.header.origin==='subagent'||(session.header.delegationDepth??0)>0)throw new Error('观察或审校 worker 不能运行处理或汇总阶段')
        if(args.action==='reset_transcription')return manager.resetTranscription(taskId,args.options??{})
        if(args.action==='sync_profile')return manager.syncProfile(taskId)
        if(args.action==='ocr'){if(!guardEnabled)throw new Error('角色拦截未安装，不能运行 OCR');return manager.ocrRegion(taskId,args)}
        if(['review_prepare','review_assemble','review_apply'].includes(args.action)){
          if(!guardEnabled)throw new Error('角色拦截未安装，不能运行模型任务')
          return args.action==='review_prepare'?manager.prepareReviewAudit(taskId):args.action==='review_assemble'?manager.assembleReviewAudit(taskId):manager.applyReviewAudit(taskId)
        }
        if(args.stage==='publish'||args.stage==='delivery')throw new Error('发布需由用户发起')
        if(!guardEnabled)throw new Error('角色拦截未安装，不能运行模型任务');return executeInSession(manager,taskId,args.stage,{...(args.options??{}),...(args.chapterId?{chapterId:args.chapterId}:{}),...(args.stage==='review'?{sessionOrchestrated:true}:{})},exec)
      }
      return JSON.parse(JSON.stringify(await run()))
    },
  })
  return [
    ...taskRoutes(manager, registerTaskSession),
    {method:'GET',pattern:/^\/pipeline\/execution-sessions\/([^/]+)$/,handler:async(_req,res,url,m)=>{
      const taskId=taskSessions.get(m[1]);res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store')
      if(!taskId){res.end(JSON.stringify({bound:false}));return}
      const t=await manager.get(taskId),monitor=manager.sessionMonitor,binding=await monitor?.status(taskId),role=Object.entries(binding?.sessions??{}).find(([,id])=>id===m[1])?.[0]??'orchestrator'
      const session=monitor?.host.agents.get(m[1])?.session
      res.end(JSON.stringify({bound:true,role,sessionId:m[1],lastTurn:session?.log.findLast(e=>e.type==='turn/start')?.data.turn,task:{id:t.id,name:t.name,state:t.state,stage:t.stage,message:t.message,worker:t.worker,glossaryProgress:t.glossaryProgress,translationProgress:t.translationProgress},sessions:binding?.sessions,syncError:binding?.error,progress:await transcriptionProgress(t,manager.dir(t.id)),...await executionEvents(manager.dir(t.id),url.searchParams.get('cursor'))}))
    }},
    {method:'GET',pattern:/^\/pipeline\/presets$/,handler:async(_req,res)=>{await presetReady;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({presets:await presetRegistry.list(),readingPreset:readingPreset.id}))}},
    { method: 'GET', pattern: /^\/pipeline\/configuration$/, handler: async (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(await readPipelineConfiguration(root,manager.modelService))) } },
    { method: 'POST', pattern: /^\/pipeline\/ocr-credential$/, handler: async (req, res) => {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('request too large') }
      let body; try { body = JSON.parse(raw) } catch { throw new Error('OCR 配置请求格式无效。') }
      if (!body || typeof body !== 'object') throw new Error('OCR 配置请求格式无效。')
      const result = await saveOcrCredential(root, body.service, body.apiKey)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    } },
    { method: 'GET', pattern: /^\/pipeline$/, handler: async (_req, res) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(await inspectPipeline(root, guardEnabled,manager.modelService))) } },
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
