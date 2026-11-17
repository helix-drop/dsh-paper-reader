import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
const script=new URL('./audit-migration.mjs',import.meta.url)
test('inventory reads task paths without changing records or exposing unrelated fields',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-audit-'))
 try {
  const dir=path.join(root,'.pipeline/tasks/11111111-1111-4111-a111-111111111111')
  await fs.mkdir(dir,{recursive:true})
  const record={id:path.basename(dir),legacy:{artifacts:{original:path.join(root,'Book/missing.md')}},path:path.join(root,'Book/missing.md'),apiKey:'DO_NOT_REPORT_THIS',log:[{command:'DO_NOT_REPORT_THIS'}]}
  const file=path.join(dir,'task.json'),before=JSON.stringify(record)
  await fs.writeFile(file,before)
  const out=execFileSync(process.execPath,[script.pathname,root],{encoding:'utf8'})
  const report=JSON.parse(out)
  assert.equal(report.taskCount,1);assert.equal(report.taskKinds.legacyBook,1)
  assert.deepEqual(report.pathInventory.Book,{uniquePaths:1,references:2,missing:1})
  assert.equal(out.includes('DO_NOT_REPORT_THIS'),false)
  assert.equal(await fs.readFile(file,'utf8'),before)
  assert.deepEqual(await fs.readdir(root),['.pipeline'])
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
