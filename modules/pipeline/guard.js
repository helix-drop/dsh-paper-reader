import path from 'node:path'
import {spawnSync} from 'node:child_process'
import { realpathSync, existsSync, statSync, readFileSync } from 'node:fs'
export const GUARD_VERSION='2026-10-13.7'
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
export function sessionGuard(root,exec,{inspect=false,taskDirectory=null,authorizedStage=null}={}){
  const name=String(exec.name),args=exec.arguments??{},cwd=path.resolve(exec.agent?.session?.header?.cwd??'/'),inside=cwd===root||cwd.startsWith(root+path.sep)
  if(!inside&&!inspect&&!taskDirectory)return
  const reading=exec.agent?.session?.header?.agentPreset==='reading-document',observer=(exec.agent?.session?.header?.delegationDepth??0)>0||exec.agent?.session?.header?.origin==='subagent';
  if(reading){
    if(!taskDirectory||!authorizedStage)return '文档预设必须绑定任务后才能使用工具。';
    if(observer&&['subagent','agent'].includes(name))return '结构观察 worker 不能继续派发代理。';
    if(name==='subagent'){
      const prompt=String(args.prompt??''),phases={P0_VISION:'phase0_setup.md',P1_SAMPLING:'phase1_analysis.md',P2_NOTESCOUT:'phase2_segmentation.md',P4_SPOTCHECK:'phase4_verify_export.md'},allowed=authorizedStage==='prepare'?['P0_VISION','P1_SAMPLING','P2_NOTESCOUT']:['diagnose','review'].includes(authorizedStage)?['P0_VISION','P1_SAMPLING','P4_SPOTCHECK']:[];
      const specs=[...prompt.matchAll(/<<<WORKER_SPEC_(\w+) BEGIN>>>/g)].map(m=>m[1]);
      if(!specs.length||specs.some(n=>!allowed.includes(n)))return '当前阶段只能派指定结构观察或抽验任务，并携带完整 B 面规格。';
      for(const n of specs){let text;try{text=readFileSync(path.join(root,'.kimi-code/skills/fnm-ai-convert/phases',phases[n]),'utf8')}catch{return '观察规格文件不可用。'}const begin='<<<WORKER_SPEC_'+n+' BEGIN>>>',end='<<<WORKER_SPEC_'+n+' END>>>',start=text.indexOf(begin),stop=text.indexOf(end,start);if(start<0||stop<0||!prompt.includes(text.slice(start,stop+end.length).trim()))return '观察 worker 的 B 面规格缺失或不完整。';}
      const images=prompt.match(/\/[^\s\"<>]+\/page_\d+\.(?:png|jpg|jpeg|webp)/g)??[],base=canonical(path.join(taskDirectory,'document/ai_convert/page_images'));
      if(!images.length||images.some(p=>path.dirname(canonical(p))!==base||!existsSync(p)))return '观察必须指定已生成的本任务页面图片；使用规范化逻辑页码和实际图片目录。';
    }
    if(['read','read_image','str_replace_editor'].includes(name)){
      const raw=String(args.path??args.file_path??args.filePath??''),file=canonical(path.resolve(cwd,raw)),taskBase=canonical(taskDirectory),base=canonical(root);
      const rule=file===path.join(base,'AGENTS.md')||file===path.join(base,'.kimi-code/AGENTS.md')||file===path.join(base,'lingua/README.md')||file.startsWith(path.join(base,'.kimi-code/skills')+path.sep)&&file.endsWith('.md');
      let source=null;if(observer)try{const input=JSON.parse(readFileSync(path.join(taskBase,'task.json'),'utf8'));if(input.input?.type==='pdf'&&typeof input.path==='string')source=canonical(input.path)}catch{}
      if(!rule&&file!==source&&!file.startsWith(taskBase+path.sep))return '文档预设只能读取规则与当前任务证据。';
      if(!observer&&(name==='read_image'||/\.(png|jpg|jpeg|webp|pdf)$/i.test(file)))return '编排者不能读取原页图像，必须派结构观察 worker。';
    }
  }
  if(name==='run_code')return safeTransport(args.code)?undefined:'文档编排只允许单次受控工具调用；禁止在程序中直接操作文件、网络或进程。使用 await tools.工具名(JSON对象)。'
  if(inspect&&!readOnly.has(name))return '环境检查会话只读，禁止写入、执行命令、派发 worker 或发布。'
  if(!projectTools.has(name))return '文档编排只使用已核验的受控工具，不能执行任意命令或调用其他服务。'
  if(name==='glob'){
    const directory=String(args.path??cwd),pattern=String(args.pattern??'');
    const base=canonical(root),resolved=canonical(path.resolve(cwd,directory)),prefix=canonical(path.resolve(resolved,pattern.split(/[?*{[]/)[0]||'.'));
    if(!pattern||pattern.split(/[\\/]/).includes('..')||![resolved,prefix].every(p=>p===base||p.startsWith(base+path.sep)))return '文档文件定位只允许项目目录，禁止枚举外部目录。';
    if(/(?:\.worker_env|credentials|auth\.json|cookie|(?:^|[\\/])golden(?:[\\/]|$))/i.test(pattern))return '禁止定位凭证或评测参考文件。';
  }
  if(['read','read_image','grep','str_replace_editor'].includes(name)){
    const target=String(args.path??args.file_path??args.filePath??'')
    if(/(?:\.worker_env|auth\.json|credentials|cookie|config\.toml|(?:^|\/)config\.json$|\.env(?:$|\.))/i.test(target))return '编排者不能读取凭证内容，连接状态由后台检查。'
    if(!target)return '读取与查询必须明确指定文件。'
    const resolved=canonical(path.resolve(cwd,target)),base=canonical(root)
    if(/(?:^|[\\/])golden(?:[\\/]|$)/.test(resolved))return 'golden 是评测参考，编排者与观察 worker 均不能读取。'
    if(!resolved.startsWith(base+path.sep)&&resolved!==base)return '文档编排仅读取项目内的规则和当前文档证据。'
    if(!observer&&(name==='read_image'||/\.(png|jpg|jpeg|webp|pdf)$/i.test(resolved)))return '编排者不能读取原页图像，必须派结构观察 worker。'
    if(name==='grep'){let file=false;try{file=statSync(resolved).isFile()}catch{}if(!file)return '文档查询只针对明确的文件，禁止递归搜索可能包含凭证的目录。'}

  }
  const writing=['write','edit'].includes(name)||name==='str_replace_editor'&&args.command!=='view'
  if(writing){if(reading){const rawPath=String(args.path??args.file_path??args.filePath??''),observerOutput=observer&&['prepare','diagnose','review'].includes(authorizedStage)&&/\/ai_convert\/worker_out\/[\w-]+\.json$/.test(rawPath),permitted=authorizedStage==='prepare'?/\/ai_convert\/(?:book_analysis|toc|chapters)\.json$/:authorizedStage==='glossary'?/\/translation\/analysis\/glossary\.json$/:['review','diagnose'].includes(authorizedStage)?/\/review\/report\.md$/:null;if(observer?!observerOutput:!(permitted?.test(rawPath)))return '当前授权阶段不能写入这种候选文件。'}const raw=args.path??args.file_path??args.filePath;if(typeof raw!=='string'||!raw)return '写入必须指定文件路径。';const target=canonical(path.resolve(cwd,raw)),base=taskDirectory?canonical(taskDirectory):canonical(root)
    if(!target.startsWith(base+path.sep))return '只能写入当前任务目录的结构或审校候选。'
    if(!(/\/(?:ai_convert\/(?:book_analysis|toc|chapters)\.json|translation\/analysis\/glossary\.json|review\/report\.md)$/.test(target)||((exec.agent?.session?.header?.delegationDepth??0)>0||exec.agent?.session?.header?.origin==='subagent')&&/\/ai_convert\/worker_out\/[\w-]+\.json$/.test(target)))return '编排者只能写结构、术语候选和审校报告；正文、注释、规则、脚本及审计预算由程序保存。'
  }
  const header=exec.agent?.session?.header??{};if(name==='document_pipeline'&&args.action==='run'&&(header.origin==='subagent'||(header.delegationDepth??0)>0))return '观察 worker 只能提交结构候选，不能启动转写、翻译或发布阶段。'
  if(name==='document_pipeline'&&inspect&&!['inspect','task'].includes(args.action))return '环境检查会话只能检查环境，不能运行任务。'
}
