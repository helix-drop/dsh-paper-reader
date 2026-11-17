import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {hash} from '../modules/pipeline/markdown.js'
import {prepareReviewAudit,applyReviewAudit} from '../modules/pipeline/review-audit.js'

test('scope diagnostics distinguish changed PDF from stale profile and never alter files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'scope-diagnostic-'))
 try{
  const source=path.join(root,'upload.pdf');await fs.writeFile(source,'original');await fs.writeFile(path.join(root,'source.pdf'),'normalized');await fs.writeFile(path.join(root,'document_profile.json'),'{}')
  const manager={docDir:()=>root},task={path:source,profile:{confirmed:true,source_fingerprint:hash('original')},scope:{fingerprint:hash('normalized'),profileFingerprint:hash('{}')}}
  await TaskManager.prototype.confirmed.call(manager,task)
  task.scope.profileFingerprint='old'
  await assert.rejects(TaskManager.prototype.confirmed.call(manager,task),/sync_profile/)
  task.scope.fingerprint='old'
  await assert.rejects(TaskManager.prototype.confirmed.call(manager,task),e=>e.message.includes('source.pdf')&&!e.message.includes('sync_profile'))
  assert.equal(await fs.readFile(source,'utf8'),'original');assert.equal(await fs.readFile(path.join(root,'document_profile.json'),'utf8'),'{}')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('rejected review apply points to the precise report and unresolved packet without another tool call',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-diagnostic-'))
 try{
  const source=path.join(root,'source.md'),target=path.join(root,'target.md');await fs.writeFile(source,'Text.\n');await fs.writeFile(target,'正文。\n')
  const manager={dir:()=>root,original:async()=>source},task={id:'fixture',translationPath:target},prepared=await prepareReviewAudit(manager,task)
  await fs.writeFile(path.join(prepared.auditDir,'results/001.json'),JSON.stringify({packet:'001',status:'needs-work',patches:[],unresolved:[{blockId:'B0001',issue:'脚注续文需要原页核对'}]}))
  await assert.rejects(applyReviewAudit(manager,task),e=>e.message.includes('001')&&e.message.includes('脚注续文')&&e.message.includes(path.join(prepared.auditDir,'validation.json'))&&e.message.includes('review_assemble'))
  assert.equal(await fs.readFile(target,'utf8'),'正文。\n')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
