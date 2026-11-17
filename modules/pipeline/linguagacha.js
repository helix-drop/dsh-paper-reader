import { spawn, spawnSync } from 'node:child_process'
export async function discoverLinguaGacha(fetcher=fetch){
  for(const port of [54819,54820,54821,54822]){
    try{const response=await fetcher(`http://127.0.0.1:${port}/api/meta/version`,{signal:AbortSignal.timeout(1200)});if(!response.ok)continue;const value=await response.json();if(value.ok&&value.data?.version)return {found:true,url:`http://127.0.0.1:${port}`,version:value.data.version}}catch{}
  }
  return {found:false}
}
export function openLinguaGacha(){const result=spawnSync('/usr/bin/open',['-a','/Applications/LinguaGacha.app'],{timeout:5000});if(result.status!==0)throw new Error('无法打开已安装的 LinguaGacha');return {opened:true}}

const adapters=new Map()
export async function adapterStatus(){const services=[];for(const [kind,port] of [['opencode',8768],['codex',8765],['xai',8769]]){let running=false;try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});const v=await r.json();running=r.ok&&typeof v.backend==='string'&&v.backend.includes(kind)}catch{}services.push({kind,port,running})}return {services}}
export async function startSubscriptionAdapter(root,kind){
  if(!['opencode','codex','xai'].includes(kind))throw new Error('适配器类型无效')
  if((await adapterStatus()).services.find(s=>s.kind===kind)?.running)return {running:true,reused:true,kind}
  if(adapters.has(kind))return {starting:true,kind}
  const child=spawn('/opt/homebrew/bin/python3',[root+`/lingua/${kind}_subscription_adapter.py`],{cwd:root,stdio:'ignore',detached:true})
  child.unref()
  adapters.set(kind,child);child.on('error',()=>adapters.delete(kind));child.on('close',()=>adapters.delete(kind));return {starting:true,kind}
}
