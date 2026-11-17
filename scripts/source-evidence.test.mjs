import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {sourceEvidencePlan,validateSourceEvidence,validateEvidenceResolution,prepareSourceEvidence,verifySourceEvidence} from '../modules/pipeline/source-evidence.js'
import {hash,markdownBlocks} from '../modules/pipeline/markdown.js'
const exec=promisify(execFile)
const issue={id:'issue-a',kind:'content',issue:{blockId:'B0001/B0002',issue:'年份差异'}}
const rows=[{blockId:'B0001',line:1,source:'generated title',translation:'标题'},{blockId:'B0002',line:3,source:'Source C.',translation:'译文C'}]
const plan=sourceEvidencePlan([issue],rows,{blocks:[{pdfPages:[]},{pdfPages:[1]}]})
const result={findings:[{issueId:issue.id,verdict:'source_inconsistency',evidence:[{page:1,quote:'Source C.'}],reason:'图像确为 C'}]}
test('issue location accepts multiple block IDs and keeps generated metadata distinct',()=>{
 assert.deepEqual(plan.pages,[1]);assert.equal(plan.planned[0].rows[0].pages.length,0)
 assert.equal(sourceEvidencePlan([{...issue,issue:{blockId:'B0999'}}],rows,{blocks:[]}).unavailable.length,1)
})
test('visual evidence needs full issue/page coverage and cannot change source under a different verdict',()=>{
 assert.equal(validateSourceEvidence(result,plan),result)
 assert.throws(()=>validateSourceEvidence({findings:[]},plan),/覆盖/)
 assert.throws(()=>validateSourceEvidence({findings:[{...result.findings[0],evidence:[{page:2,quote:'fake'}]}]},plan),/页面/)
 assert.throws(()=>validateSourceEvidence({findings:[{...result.findings[0],source_patches:[{blockId:'B0002',old:'C.',new:'A.',reason:'guess'}]}]},plan),/不得/)
})
test('source issues require explicit second review and source discrepancies require a note',()=>{
 const evidence={key:'proof',receiptHash:'hash',...result},delta={resolved_issues:[{id:issue.id,reason:'查图确认'}],source_evidence_decisions:[{issueId:issue.id,evidenceKey:'proof',decision:'accept',reason:'独立核对原页'}],source_notes:[{issueId:issue.id,text:'原文为 C，译文保留该写法。'}]}
 assert.equal(validateEvidenceResolution(delta,evidence,[issue]).evidenceReviews.length,1)
 assert.throws(()=>validateEvidenceResolution({...delta,source_notes:[]},evidence,[issue]),/底本说明/)
 assert.throws(()=>validateEvidenceResolution({...delta,source_evidence_decisions:[]},evidence,[issue]),/复核/)
 assert.throws(()=>validateEvidenceResolution(delta,{...evidence,findings:[{...result.findings[0],verdict:'insufficient'}]},[issue]),/复核/)
 assert.throws(()=>validateEvidenceResolution(delta,{...evidence,findings:[{...result.findings[0],verdict:'transcription_error'}]},[issue]),e=>e.code==='SOURCE_CORRECTION_REQUIRED')
})
test('real PDF rendering, receipt reuse and changed-page rejection',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-evidence-')),pdf=path.join(root,'original.pdf'),source=path.join(root,'source.md'),audit=path.join(root,'audit')
 try{
  await exec('/opt/homebrew/bin/python3',['-c',"import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((50,100),'Source C.'); d.save(sys.argv[1])",pdf])
  const text='Source C.\n';await fs.writeFile(source,text);const blocks=markdownBlocks(text),pdfHash=hash(await fs.readFile(pdf))
  await fs.writeFile(source+'.source-map.json',JSON.stringify({schemaVersion:1,view:'original',markdownSha256:hash(text),pdf:{file:'original.pdf',sha256:pdfHash,totalPages:1},blocks:blocks.map(b=>({markdownBlockId:b.id,blockId:'source-one',type:b.type,pdfPages:[1],pdfPageRanges:[[1,1]],sourcePids:[],logicalPages:[1],regions:[]}))}))
  await fs.mkdir(path.join(audit,'packets'),{recursive:true});await fs.writeFile(path.join(audit,'snapshots.json'),JSON.stringify({source_sha256:hash(text)}));await fs.writeFile(path.join(audit,'packets/001.json'),JSON.stringify([{blockId:'B0001',line:1,source:blocks[0].text,translation:'译文C'}]))
  let calls=0;const phases=[],args={manager:{root,original:async()=>source,modelService:{validate:async(_s,o)=>assert.equal(o.images,true)}},task:{input:{type:'pdf'}},auditDir:audit,packet:'001',selection:{provider:'p',model:'m'},issues:[{...issue,issue:{blockId:'B0001',issue:'姓名'}}],onState:async s=>phases.push(s),request:async(prompt,images)=>{calls++;assert.match(prompt,/图像/);assert.equal(images.length,1);assert.equal((await fs.readFile(images[0].file)).subarray(1,4).toString(),'PNG');return {text:JSON.stringify(result)}}}
  const evidence=await prepareSourceEvidence(args);assert.equal(calls,1);assert(phases.includes('rendering-source'));assert.equal((await prepareSourceEvidence(args)).cached,true);assert.equal(calls,1)
  await verifySourceEvidence(audit,evidence,hash(text))
  await fs.unlink(path.join(audit,'source-evidence',evidence.key,'receipt.json'));await prepareSourceEvidence(args);assert.equal(calls,1,'saved raw response must be revalidated without another model call')
  await fs.appendFile(evidence.images[0].file,'changed');await assert.rejects(prepareSourceEvidence(args),/图像发生变化/);assert.equal(calls,1)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})

test('a cross-page paragraph needs the page containing the issue; distinct paragraphs each need evidence',()=>{
 const one=sourceEvidencePlan([{...issue,issue:{blockId:'B0002'}}],rows,{blocks:[{pdfPages:[]},{pdfPages:[13,14]}]})
 assert.doesNotThrow(()=>validateSourceEvidence({findings:[{...result.findings[0],evidence:[{page:14,quote:'Source C.'}]}]},one))
 const both=sourceEvidencePlan([issue],rows,{blocks:[{pdfPages:[13]},{pdfPages:[14]}]})
 assert.throws(()=>validateSourceEvidence({findings:[{...result.findings[0],evidence:[{page:14,quote:'Source C.'}]}]},both),/对应页面/)
})

test('fresh review automatically enters visual evidence and second review once',async()=>{
 const {runHarnessReview}=await import('../modules/pipeline/harness-review.js'),root=await fs.mkdtemp(path.join(os.tmpdir(),'evidence-chain-')),source=path.join(root,'source.md'),pdf=path.join(root,'source.pdf'),text='Source C.\n'
 try{
  await exec('/opt/homebrew/bin/python3',['-c',"import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((50,100),'Source C.'); d.save(sys.argv[1])",pdf]);await fs.writeFile(source,text)
  const b=markdownBlocks(text)[0];await fs.writeFile(source+'.source-map.json',JSON.stringify({schemaVersion:1,view:'original',markdownSha256:hash(text),pdf:{file:'source.pdf',sha256:hash(await fs.readFile(pdf)),totalPages:1},blocks:[{markdownBlockId:b.id,blockId:'src-one',type:b.type,pdfPages:[1],pdfPageRanges:[[1,1]],sourcePids:[],logicalPages:[1],regions:[]}]}))
  await fs.mkdir(path.join(root,'packets'));await fs.mkdir(path.join(root,'results'));await fs.writeFile(path.join(root,'snapshots.json'),JSON.stringify({source_sha256:hash(text)}));await fs.writeFile(path.join(root,'packets/001.json'),JSON.stringify([{blockId:'B0001',line:1,source:b.text,translation:'译文'}]))
  const task={id:'fixture',input:{type:'pdf'},reviewConfig:{workerModel:'p/m'},reviewProgress:{}},phases=[];let calls=0
  const manager={root,original:async()=>source,active:new Map(),save:async t=>phases.push(t.reviewProgress.step),modelService:{validate:async()=>{},admitContent:async c=>c,generate:async(_s,r)=>{
   calls++;const prompt=r.messages[0].content[0].text
   if(calls===1)return {text:JSON.stringify({packet:'001',status:'needs-work',patches:[],unresolved:[{blockId:'B0001',issue:'姓名疑点'}]})}
   assert(r.messages[0].content.some(c=>c.type==='image'))
   if(prompt.includes('核证输入：')){const input=JSON.parse(prompt.split('核证输入：').at(-1));return {text:JSON.stringify({findings:[{issueId:input.issues[0].id,verdict:'source_inconsistency',evidence:[{page:1,quote:'Source C.'}],reason:'图像一致'}]})}}
   const input=JSON.parse(prompt.split('\n').at(-1)),id=input.issues[0].id
   return {text:JSON.stringify({packet:'001',mode:'recovery',resolved_issues:[{id,reason:'重新核对图像'}],source_evidence_decisions:[{issueId:id,evidenceKey:input.sourceEvidence.key,decision:'accept',reason:'图像确为C'}],source_notes:[{issueId:id,text:'原文为 C，保留原文。'}]})}
  }}}
  await runHarnessReview({manager,task,auditDir:root,prepared:{pendingPackets:['001']},validate:async()=>{const r=JSON.parse(await fs.readFile(path.join(root,'results/001.json')));return {completed:1,validPackets:['001'],errors:[],unresolved:r.unresolved.map(issue=>({packet:'001',issue}))}}})
  assert.equal(calls,3);assert(phases.includes('source-evidence'));assert(phases.includes('evidence-review'));assert.equal(task.reviewProgress.passedPackets,1)
  const r=JSON.parse(await fs.readFile(path.join(root,'results/001.json')));assert.equal(r.status,'pass');assert.equal(r.evidenceReviews.length,1)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
