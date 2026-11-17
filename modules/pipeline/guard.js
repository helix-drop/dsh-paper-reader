import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {spawnSync} from 'node:child_process'
import { realpathSync, existsSync, statSync, readFileSync } from 'node:fs'
export const GUARD_VERSION='2026-10-17.1'
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const readOnly=new Set(['read','read_image','glob','grep','document_pipeline','get_goal','todo_write','run_code'])
const projectTools=new Set([...readOnly,'write','edit','str_replace_editor','subagent','agent'])
function canonical(target){let p=target,tail=[];while(!existsSync(p)&&path.dirname(p)!==p){tail.unshift(path.basename(p));p=path.dirname(p)}try{return path.join(realpathSync(p),...tail)}catch{return target}}
export function safeTransport(code){
  const match=String(code??'').trim().match(/^(?:return\s+)?await\s+tools\.([a-zA-Z_][\w]*)\s*\(([\s\S]*)\)\s*;?$/)
  if(!match||!projectTools.has(match[1])||match[1]==='run_code')return false
  try{const args=JSON.parse(match[2]);return args!==null&&typeof args==='object'&&!Array.isArray(args)}catch{
    if(match[2].length>262144)return false
    // Python PTC uses True/False/None and may use single-quoted strings.
    // literal_eval parses data only; imports, calls and expressions never execute.
    const checked=spawnSync('/opt/homebrew/bin/python3',['-c','import ast,json,sys; obj=ast.literal_eval(sys.stdin.read()); json.dumps(obj); sys.exit(0 if isinstance(obj,dict) else 2)'],{input:match[2],stdio:['pipe','ignore','ignore'],timeout:2000})
    return !checked.error&&checked.status===0
  }
}
export function observationImagePaths(prompt,base){
  const escaped=base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const known=String(prompt).match(new RegExp(escaped+'/page_\\d+\\.(?:png|jpg|jpeg|webp)','g'))??[]
  let rest=String(prompt);for(const file of new Set(known))rest=rest.split(file).join('<task-image>')
  const other=rest.match(/\/[^\s\"<>]+\/page_\d+\.(?:png|jpg|jpeg|webp)/g)??[]
  return [...known,...other]
}
const within=(file,base)=>file===base||file.startsWith(base+path.sep)
const privatePath=/(?:^|[\\/])(?:\.env(?:\..*)?|\.worker_env|credentials?|private-transports|auth\.json|cookies?|config\.toml|config\.json|golden)(?:[\\/]|$)/i
// Immutable inputs and program-owned receipts remain readable, but not writable.
const protectedWrite=/(?:^|\/)(?:task\.json|sessions\.json|execution-events\.jsonl|state\.json|profile\.json|document_profile\.json|profile-analysis|source\.[^/]+|raw_pages[^/]*|translation-cli|translation-input|ocr-regions|ocr-policy\.json|page_images|requests|harness-requests|attempts|worker_audit\.jsonl|actions|similarity_report|budget[^/]*|audit\.jsonl|\.kimi-code|AGENTS\.md)(?:\/|$)|(?:^|\/)output\/(?:report\.json|structured)(?:\/|$)|(?:^|\/)review\/audit\/(?:runs\/[a-f0-9-]+\/)?(?:snapshots\.json|current\.json|applied\.json|source\.md|translation\.md|glossary-snapshot\.json|review-issues-snapshot\.json|glossary\.json|issues\.json|old-revisions\.json|packets|manifest\.json|validation\.json|report\.json|receipt[^/]*)(?:\/|$)/i
export function sessionGuard(root,exec,{inspect=false,taskDirectory=null}={}){
  const name=String(exec.name),args=exec.arguments??{},header=exec.agent?.session?.header??{}
  const reading=header.agentPreset==='reading-document'
  // Sharing the runtime working directory does not enroll an ordinary session.
  if(!taskDirectory&&!inspect)return reading?'文档会话必须先绑定任务。':undefined
  const cwd=path.resolve(header.cwd??root),base=canonical(taskDirectory??root)
  const observer=header.origin==='subagent'||(header.delegationDepth??0)>0
  if(name==='run_code')return safeTransport(args.code)?undefined:'请使用原生工具；程序执行由 document_pipeline 管理。'
  if(inspect&&!readOnly.has(name))return '环境检查会话只读。'
  if(!projectTools.has(name))return '此工具不属于文档处理工具；程序执行由 document_pipeline 管理。'
  if(observer&&['subagent','agent'].includes(name))return '子代理不能继续派发代理。'
  if(name==='document_pipeline'){
    if((inspect||observer)&&!['inspect','task','evidence','files','search','probe_page','probe'].includes(args.action))return '只读检查或子代理不能启动处理；由编排者统一调度。'
    return
  }
  const writing=['write','edit'].includes(name)||name==='str_replace_editor'&&args.command!=='view'
  if(!writing&&!['read','read_image','grep','glob','str_replace_editor'].includes(name))return
  const raw=args.path??args.file_path??args.filePath
  if(typeof raw!=='string'||!raw)return '请明确指定文件或目录。'
  const lexical=path.resolve(cwd,raw),target=canonical(lexical)
  if(privatePath.test(lexical)||privatePath.test(target))return '凭证和评测参考不属于任务数据。'
  if(writing){
    if(!within(lexical,path.resolve(taskDirectory??root))||!within(target,base))return '只能修改当前任务内的处理结果。'
    const relative=path.relative(base,target).split(path.sep).join('/')
    if(protectedWrite.test(relative)||/\.(?:py|js|mjs|cjs|sh|command|zsh)$/i.test(target))return '原始输入、程序、预算和执行记录由程序维护，不能直接改写。'
    return
  }
  const project=canonical(root)
  const allowedDocRoots=[project, canonical(PLUGIN_ROOT)]
  const rule=target.endsWith('.md') && allowedDocRoots.some(dir => (
    target===path.join(dir,'AGENTS.md') ||
    target===path.join(dir,'.kimi-code/AGENTS.md') ||
    target===path.join(dir,'lingua/README.md') ||
    target===path.join(dir,'README.md') ||
    within(target,path.join(dir,'docs')) ||
    within(target,path.join(dir,'.kimi-code/skills')) ||
    within(target,path.join(dir,'book-translation-review'))
  ))
  let source
  try{const task=JSON.parse(readFileSync(path.join(base,'task.json'),'utf8'));if(typeof task.path==='string')source=canonical(task.path)}catch{}
  if(!within(target,base)&&!rule&&target!==source)return '只能读取当前任务及处理规则。'
  if(name==='glob'){
    const pattern=String(args.pattern??''),prefix=canonical(path.resolve(target,pattern.split(/[?*{[]/)[0]||'.'))
    if(!within(target,base)||!within(prefix,base)||pattern.split(/[\\/]/).includes('..')||privatePath.test(pattern))return '文件定位仅限当前任务。'
  }
  if(name==='grep'){let file=false;try{file=statSync(target).isFile()}catch{}if(!file)return '查询请指定文件，目录定位使用 files。'}
}
