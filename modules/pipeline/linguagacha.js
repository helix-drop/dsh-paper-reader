import { spawnSync, spawn } from 'node:child_process'
// Discover only sockets owned by the installed app; never scan arbitrary ports.
export async function discoverLinguaGacha(fetcher=fetch){
  const process=spawnSync('/usr/sbin/lsof',['-nP','-iTCP','-sTCP:LISTEN','-Fpcn'],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024})
  let name='';const urls=new Set()
  for(const line of (process.stdout??'').split('\n')){if(line.startsWith('p'))name='';if(line.startsWith('c'))name=line.slice(1);if(name==='LinguaGacha'&&/^n127\.0\.0\.1:\d+$/.test(line))urls.add('http://'+line.slice(1))}
  for(const url of urls){try{const response=await fetcher(url+'/api/health',{signal:AbortSignal.timeout(2000)}),value=await response.json();if(value.ok&&value.data?.service==='linguagacha-backend')return {connected:true,url,version:value.data.version}}catch{}}
  return {connected:false,message:'LinguaGacha未运行或本地服务未就绪'}
}
export function openLinguaGacha(){const result=spawnSync('/usr/bin/open',['-a','/Applications/LinguaGacha.app'],{timeout:5000});if(result.status!==0)throw new Error('无法打开已安装的 LinguaGacha');return {opened:true}}

export function refreshTranslationModel(root,profile){
  const profiles={'opencode-fast':['install-opencode-adapter','fast'],'opencode-high':['install-opencode-adapter','high'],'opencode-xhigh':['install-opencode-adapter','xhigh'],'opencode-max':['install-opencode-adapter','max'],'codex-high':['install-codex-adapter','high'],'codex-max':['install-codex-adapter','max'],'xai':['install-xai-adapter'],'mimo-flash':['install-mimo','flash'],'mimo-pro':['install-mimo','pro']}
  if(!profiles[profile])throw new Error('配置入口无效')
  const running=spawnSync('/usr/bin/pgrep',['-xq','LinguaGacha']);if(running.status===0)throw new Error('先关闭 LinguaGacha，再更新模型条目，避免 GUI 退出时覆盖配置')
  const result=spawnSync(root+'/lingua/lg-config',profiles[profile],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:65536})
  if(result.status!==0)throw new Error('项目配置更新未完成，请检查登录状态及项目凭证；未显示凭证内容')
  return {updated:true,profile,message:'项目模型条目已更新并备份，尚未启动翻译'}
}
const adapters=new Map()
export async function adapterStatus(){const services=[];for(const [kind,port] of [['opencode',8768],['codex',8765],['xai',8769]]){let running=false;try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});const v=await r.json();running=r.ok&&typeof v.backend==='string'&&v.backend.includes(kind)}catch{}services.push({kind,port,running})}return {services}}
export async function startSubscriptionAdapter(root,kind){
  if(!['opencode','codex','xai'].includes(kind))throw new Error('适配器类型无效')
  if((await adapterStatus()).services.find(s=>s.kind===kind)?.running)return {running:true,reused:true,kind}
  if(adapters.has(kind))return {starting:true,kind}
  const child=spawn('/opt/homebrew/bin/python3',[root+`/lingua/${kind}_subscription_adapter.py`],{cwd:root,stdio:'ignore'})
  adapters.set(kind,child);child.on('error',()=>adapters.delete(kind));child.on('close',()=>adapters.delete(kind));return {starting:true,kind}
}
