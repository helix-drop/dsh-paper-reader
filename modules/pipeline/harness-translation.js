import fs from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {splitModel,modelKey} from './harness-models.js'
import {cliStatus} from './cli.js'
const exec=promisify(execFile)
const settingsFile=manager=>path.join(manager.root,'.pipeline/harness-translation.json')
async function settings(manager){try{return JSON.parse(await fs.readFile(settingsFile(manager),'utf8'))}catch(e){if(e.code==='ENOENT')return {};throw e}}
export async function selectHarnessTranslation(manager,id){
 if(!manager.modelService)throw new Error('DSH 模型服务尚未就绪')
 const selection=splitModel(id);await manager.modelService.validate(selection)
 const old=await settings(manager),value={...old,selection};await fs.mkdir(path.dirname(settingsFile(manager)),{recursive:true});await fs.writeFile(settingsFile(manager),JSON.stringify(value),{mode:0o600})
 return {updated:true,profile:id,message:'已选择 DSH 模型，凭证与连接由 Harness 管理'}
}
export async function harnessTranslationStatus(manager){
 const current=await settings(manager),catalog=await manager.modelService.catalog(),selection=current.selection??catalog.default
 const info=await manager.modelService.validate(selection),base=await cliStatus(manager.root,true)
 const maxTokens=current.maxTokens??info.defaultMaxTokens??131072
 const inputTokens=current.inputTokens??current.input_token_limit??800
 return {...base,model:{name:modelKey(selection),model:modelKey(selection),provider:selection.provider,harnessModel:selection.model,credentialConfigured:true,credentialManagedBy:'DSH',connectionVerified:false,threshold:{input_token_limit:inputTokens,output_token_limit:maxTokens,concurrency_limit:current.concurrency??4},agent:{context_window:info.context?.contextWindow??1048576,max_output_tokens:maxTokens},requestTimeout:600},preprocessing:{cleanRuby:false},message:'模型目录、连接、凭证和推理默认值均由 DSH 管理'}
}
export async function setHarnessConcurrency(manager,value){
 const concurrency=Number(value);if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('并发数须为 1–8')
 const old=await settings(manager);await fs.mkdir(path.dirname(settingsFile(manager)),{recursive:true});await fs.writeFile(settingsFile(manager),JSON.stringify({...old,concurrency}),{mode:0o600});return {updated:true,concurrency}
}
export async function setHarnessInputTokens(manager,value){
 const inputTokens=Number(value);if(!Number.isInteger(inputTokens)||inputTokens<100||inputTokens>32000)throw new Error('分块 token 阈值须为 100–32000')
 const old=await settings(manager);await fs.mkdir(path.dirname(settingsFile(manager)),{recursive:true});await fs.writeFile(settingsFile(manager),JSON.stringify({...old,inputTokens}),{mode:0o600});return {updated:true,inputTokens}
}
export async function projectTranslationLease(manager,t,lease){
 const status=await manager.cliStatus(),model=t.phaseApproval?.translationModel?.model
 if(!model||model!==status.model.model)throw new Error('翻译模型与阶段确认不一致')
 const dir=path.join(manager.root,'.pipeline/private-transports'),id=randomUUID(),payload=path.join(dir,id+'.json'),receipt=path.join(dir,id+'.restore.json')
 await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);await fs.writeFile(payload,JSON.stringify({ownerPid:process.pid,url:lease.url,token:lease.token,model,contextWindow:status.model.agent.context_window,maxTokens:status.model.agent.max_output_tokens,inputTokens:status.model.threshold.input_token_limit,concurrency:status.model.threshold.concurrency_limit}),{mode:0o600})
 const script=path.join(manager.root,'lingua/lg-config')
 const diagnostic=e=>{
  const stderr=String(e.stderr??'')
  const known=['LinguaGacha 正在运行，不能更换临时连接','另一个 DSH 翻译进程仍持有临时配置','LinguaGacha 配置在执行期间变化，保留恢复副本，不覆盖修改']
  return known.find(message=>stderr.includes(message))??(e.killed?'配置命令执行超时':e.code==='ENOENT'||stderr.includes('FileNotFoundError')?'配置文件或程序不存在':stderr.includes('PermissionError')?'配置文件访问权限不足':stderr.includes('JSONDecodeError')?'配置或恢复记录不是有效 JSON':'配置命令异常退出，请核查配置及恢复记录；不能据此判断应用仍在运行')
 }
 try{await exec(manager.python,[script,'harness-begin',payload,receipt],{timeout:15000,maxBuffer:65536})}catch(e){await fs.unlink(payload).catch(()=>{});throw new Error('LinguaGacha 临时连接配置失败：'+diagnostic(e))}
 await fs.unlink(payload)
 return async()=>{try{await exec(manager.python,[script,'harness-end',receipt],{timeout:15000,maxBuffer:65536})}catch(e){throw new Error('LinguaGacha 配置恢复失败，已保留恢复副本：'+diagnostic(e))}}
}
