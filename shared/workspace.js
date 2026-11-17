import path from 'node:path'
import os from 'node:os'
import {readFileSync,existsSync} from 'node:fs'

export const LEGACY_PIPELINE_ROOT='/Users/hao/K-PdfToMd'
export const MANAGED_WORKSPACE=path.join(os.homedir(),'Library/Application Support/DSH/PaperReader')
export function activeManagedWorkspace(){
  try{
    const marker=JSON.parse(readFileSync(path.join(MANAGED_WORKSPACE,'workspace-active.json'),'utf8'))
    if(marker.schemaVersion===1&&marker.status==='verified'&&marker.root===MANAGED_WORKSPACE&&existsSync(path.join(MANAGED_WORKSPACE,'.pipeline/catalog.sqlite')))return MANAGED_WORKSPACE
  }catch{}
  if(readWorkspaceMigration(MANAGED_WORKSPACE)?.sourceDuplicatesRemoved)throw new Error('阅读工作区未能激活；旧项目副本已清理，请恢复新工作区的激活标记与数据库。')
  return null
}
export function defaultPipelineWorkspace(){return activeManagedWorkspace()??LEGACY_PIPELINE_ROOT}
export function readWorkspaceMigration(root){
  try{const value=JSON.parse(readFileSync(path.join(root,'workspace-migration.json'),'utf8'));return value.schemaVersion===1&&value.root===root?value:null}catch{return null}
}
export function mapWorkspacePath(root,file,direction='storage'){
  const migration=readWorkspaceMigration(root)
  if(typeof file!=='string'||!migration)return file
  const pairs=Object.entries(migration.pathMappings??{}).map(([old,next])=>direction==='identity'?[next,old]:[old,next]).sort((a,b)=>b[0].length-a[0].length)
  for(const [from,to] of pairs)if(file===from||file.startsWith(from+path.sep))return to+file.slice(from.length)
  return file
}
export function resolveWorkspaceAsset(root,base,value){
  let file=String(value??'').trim().replace(/^<([\s\S]*)>$/,'$1')
  try{file=decodeURIComponent(file)}catch{}
  return path.resolve(base,mapWorkspacePath(root,file))
}
