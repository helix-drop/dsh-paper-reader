import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {sessionGuard} from '../modules/pipeline/guard.js'

test('task authorization supports repair and original-page inspection regardless of stage',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reader-permissions-'))),taskDirectory=path.join(root,'task')
 await fs.mkdir(taskDirectory)
 await fs.mkdir(path.join(root,'docs'),{recursive:true})
 await fs.writeFile(path.join(root,'docs/PIPELINE-MANUAL.md'),'# Manual')
 const header={cwd:root,agentPreset:'reading-document'},check=(name,file,extra={})=>sessionGuard(root,{name,arguments:{path:path.join(taskDirectory,file),...extra},agent:{session:{header}}},{taskDirectory,authorizedStage:'diagnose'})
 try{
  assert.equal(sessionGuard(root,{name:'read',arguments:{path:'docs/PIPELINE-MANUAL.md'},agent:{session:{header:{cwd:root}}}}),undefined)
  for(const file of ['document/ai_convert/edits/body/page_001.json','document/ai_convert/edits/notes/page_001.json','document/ai_convert/chapters.json','review/report.md'])assert.equal(check('edit',file),undefined,file)
  assert.equal(check('read_image','document/ai_convert/page_images/page_001.png'),undefined)
  assert.equal(check('document_pipeline','',{action:'run',stage:'verify'}),undefined)
  for(const file of ['task.json','sessions.json','execution-events.jsonl','document/source.pdf','document/raw_pages.json','document/ai_convert/page_images/page_001.png','document/ai_convert/delivery/chapter_001/state.json','document/ai_convert/worker_audit.jsonl','document/ai_convert/delivery/chapter_001/output/report.json','document/ai_convert/requests/001.json','profile.json','fix.py'])assert.ok(check('edit',file),file)
  await fs.writeFile(path.join(root,'outside.txt'),'original')
  await fs.symlink(path.join(root,'outside.txt'),path.join(taskDirectory,'alias.txt'))
  assert.ok(check('edit','alias.txt'));assert.ok(check('edit','../outside.txt'))
  await fs.writeFile(path.join(taskDirectory,'.env'),'secret')
  await fs.symlink(path.join(taskDirectory,'.env'),path.join(taskDirectory,'credential-alias.txt'))
  assert.ok(check('read','credential-alias.txt'))
  assert.equal(sessionGuard(root,{name:'shell',arguments:{},agent:{session:{header:{cwd:root}}}}),undefined)
  assert.ok(sessionGuard(root,{name:'read',arguments:{},agent:{session:{header}}}))
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
