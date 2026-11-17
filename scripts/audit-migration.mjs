/** Read-only inventory: never copies books, opens the live catalog, or reads credentials. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(process.argv[2] ?? '/Users/hao/K-PdfToMd')
const dirs = async p => fs.readdir(p, {withFileTypes:true}).catch(() => [])
await fs.access(path.join(root,'.pipeline/tasks'))
const counts = {}, refs = new Map(), tasks = [], broken = []
function paths(value, key = '') {
  if (typeof value === 'string' && path.isAbsolute(value)) {
    // Ignore log commands and prose; inspect only known path-bearing fields.
    if (!/^(path|file|directory|.*Path|.*File|sourcePdf|original|translation|readingPath|audit|report|remaining|rawPaddle|rawMineru|key)$/.test(key)) return
    refs.set(value, (refs.get(value) ?? 0) + 1)
  } else if (Array.isArray(value)) value.forEach(v => paths(v,key))
  else if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) paths(v,k)
}
for (const entry of await dirs(path.join(root,'.pipeline/tasks'))) {
  if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue
  const file = path.join(root,'.pipeline/tasks',entry.name,'task.json')
  try {
    const t = JSON.parse(await fs.readFile(file,'utf8'))
    const kind = t.legacy ? 'legacyBook' : t.paperImport ? 'legacyPaper' : 'native'
    counts[kind] = (counts[kind] ?? 0) + 1
    tasks.push({id:t.id,kind,state:t.state,stage:t.stage})
    paths(t)
  } catch { broken.push(path.relative(root,file)) }
}
const buckets = {}
for (const [p,n] of refs) {
  const group = p.startsWith(root+path.sep) ? path.relative(root,p).split(path.sep)[0] : 'external'
  const bucket = buckets[group] ??= {uniquePaths:0,references:0,missing:0}
  bucket.uniquePaths++;bucket.references += n
  try {await fs.access(p)} catch {bucket.missing++}
}
const dependencies=[]
async function scan(dir) {
  for(const e of await dirs(dir)) {
    const p=path.join(dir,e.name)
    if(e.isDirectory()) await scan(p)
    else if(/\.js$/.test(e.name)) {
      const source=await fs.readFile(p,'utf8')
      if(/K-PdfToMd|\.kimi-code|lingua\/|document_pipeline\.py|publish-book|Book['"/]/.test(source)) dependencies.push(path.relative(plugin,p))
    }
  }
}
await scan(path.join(plugin,'modules'));await scan(path.join(plugin,'shared'))
const report={schemaVersion:1,generatedAt:new Date().toISOString(),sourceRoot:root,readOnly:true,taskCount:tasks.length,taskKinds:counts,unreadableTaskRecords:broken,pathInventory:buckets,dependencyModules:dependencies,tasks,limitations:['Only known path fields in task JSON are counted; not every asset or embedded Markdown link.','The live SQLite database, service configuration, environment files and credentials are not read.','File presence does not establish source fidelity or completion.']}
process.stdout.write(JSON.stringify(report,null,2)+'\n')
