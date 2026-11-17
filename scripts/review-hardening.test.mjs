import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {hash,markdownBlocks} from '../modules/pipeline/markdown.js'
import {sourceEvidenceBatches,sourceCorrectionBlocks,validateEvidenceResolution,prepareSourceEvidence} from '../modules/pipeline/source-evidence.js'
import {prepareReviewAudit,assembleReviewAudit,applyReviewAudit,assertReviewInputs} from '../modules/pipeline/review-audit.js'
import {runHarnessReview} from '../modules/pipeline/harness-review.js'
import {TaskManager} from '../modules/pipeline/tasks.js'
import {requireBookGlossary} from '../modules/pipeline/glossary.js'
import {loadSourceMap,translationMapMatches,saveTranslationMap} from '../modules/pipeline/source-map.js'
import {buildPublication} from '../modules/pipeline/publication.js'
import {deliveryState,pageTaskRows} from '../modules/pipeline/task-list.js'
const exec=promisify(execFile),write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value))}
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'))

async function fixture(pages=1){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-hardening-')),source=path.join(root,'source.md'),target=path.join(root,'translated.md'),pdf=path.join(root,'source.pdf')
 const text='Patient C. est stable.\n',translation='患者 C 状况稳定。\n'
 await exec('/opt/homebrew/bin/python3',['-c',"import pymupdf,sys; d=pymupdf.open(); [(lambda p:p.insert_text((50,100),'Patient A. est stable.'))(d.new_page()) for _ in range(int(sys.argv[2]))]; d.save(sys.argv[1])",pdf,String(pages)])
 await write(source,text);await write(target,translation)
 const block=markdownBlocks(text)[0]
 await write(source+'.source-map.json',{schemaVersion:1,view:'original',markdownSha256:hash(text),pdf:{file:'source.pdf',sha256:hash(await fs.readFile(pdf)),totalPages:pages},blocks:[{markdownBlockId:block.id,blockId:'source-1',type:block.type,pdfPages:[1],pdfPageRanges:[[1,1]],sourcePids:[],logicalPages:[1],regions:[]}]})
 const task={id:'fixture',input:{type:'pdf'},profile:{language:'fr'},stages:{glossary:{state:'done'}},reviewConfig:{workerModel:'fixture/model'},reviewProgress:{},translationPath:target,translationReport:{passed:true,explicitBlockIds:true}}
 const manager={root,dir:()=>root,active:new Map(),save:async()=>{},original:async t=>t.sourceRevision?TaskManager.prototype.original.call(manager,t):source,modelService:{validate:async()=>{},admitContent:async c=>c}}
 const prepared=await prepareReviewAudit(manager,task),audit=prepared.auditDir
 return {root,source,target,pdf,text,translation,task,manager,prepared,audit,close:()=>fs.rm(root,{recursive:true,force:true})}
}

test('large evidence sets split by whole issues; one over-wide issue does not block other issues',()=>{
 const planned=Array.from({length:35},(_,i)=>({id:'i'+i,pages:[i+1]})),out=sourceEvidenceBatches({planned,unavailable:[]})
 assert.deepEqual(out.batches.map(b=>b.pages.length),[16,16,3]);assert.equal(out.batches.flatMap(b=>b.planned).length,35)
 const mixed=sourceEvidenceBatches({planned:[{id:'wide',pages:Array.from({length:17},(_,i)=>i+1)},planned[0]],unavailable:[]})
 assert.equal(mixed.unavailable[0].id,'wide');assert.equal(mixed.batches.length,1)
})

test('textual source correction preserves footnotes and rejects structural or unrelated corrections',()=>{
 const rows=[{blockId:'B0001',source:'Patient C.[^1]'}],finding={source_patches:[{blockId:'B0001',old:'C.',new:'A.'}]}
 assert.equal(sourceCorrectionBlocks(finding,rows)[0].source,'Patient A.[^1]')
 for(const replacement of ['A.\n\nNew paragraph.','A.[^2]'])assert.throws(()=>sourceCorrectionBlocks({source_patches:[{blockId:'B0001',old:'C.',new:replacement}]},rows),/结构/)
 assert.throws(()=>sourceCorrectionBlocks({source_patches:[{blockId:'B0002',old:'C.',new:'A.'}]},rows),/范围/)
 const evidence={key:'key',findings:[{...finding,issueId:'i',verdict:'transcription_error'}],issues:[{id:'i',rows}]},issues=[{id:'i',kind:'content'}],delta={resolved_issues:[{id:'i',reason:'核对'}],source_evidence_decisions:[{issueId:'i',evidenceKey:'key',decision:'accept',reason:'核对'}]}
 assert.throws(()=>validateEvidenceResolution(delta,evidence,issues),e=>e.code==='SOURCE_CORRECTION_REQUIRED')
 delta.source_corrections=[{issueId:'i',blockId:'B0001',source:'Patient A.[^1]',translation:'患者甲[^1]',reason:'重新核对译文'}]
 assert.equal(validateEvidenceResolution(delta,evidence,issues).evidenceReviews[0].sourceCorrections.length,1)
 delta.source_corrections.push({...delta.source_corrections[0],blockId:'B0002'})
 assert.throws(()=>validateEvidenceResolution(delta,evidence,issues),/转写错误/)
})

test('PDF source correction is model-reviewed, versioned, mapped, idempotent and leaves old source/translation intact',async()=>{
 const f=await fixture();try{
  let calls=0
  f.manager.modelService.generate=async(_s,r)=>{
   calls++;const prompt=r.messages[0].content[0].text
   if(calls===1)return {text:JSON.stringify({packet:'001',status:'needs-work',unresolved:[{blockId:'B0001',issue:'姓名转写有误'}]})}
   assert(r.messages[0].content.some(c=>c.type==='image'))
   if(prompt.includes('核证输入：')){const input=JSON.parse(prompt.split('核证输入：').at(-1));return {text:JSON.stringify({findings:[{issueId:input.issues[0].id,verdict:'transcription_error',evidence:[{page:1,quote:'Patient A.'}],reason:'原图清楚显示 A',source_patches:[{blockId:'B0001',old:'C.',new:'A.',reason:'原图为 A'}]}]})}}
   const input=JSON.parse(prompt.split('\n').at(-1)),id=input.issues[0].id
   assert.equal(input.proposedSourceCorrections[0].source,'Patient A. est stable.')
   return {text:JSON.stringify({packet:'001',mode:'recovery',patches:[{blockId:'B0001',edits:[{old:'C',new:'A'}],reason:'对应原图姓名'}],resolved_issues:[{id,reason:'原图和译文已核对'}],source_evidence_decisions:[{issueId:id,evidenceKey:input.sourceEvidence.key,decision:'accept',reason:'确认 A'}],source_corrections:[{issueId:id,blockId:'B0001',source:'Patient A. est stable.',translation:'患者 A 状况稳定。',reason:'姓名修订不改变句义，已核对译文和术语'}]})}
  }
  await runHarnessReview({manager:f.manager,task:f.task,prepared:f.prepared,auditDir:f.audit,validate:()=>assembleReviewAudit(f.manager,f.task)})
  assert.equal(calls,3);assert.equal((await assembleReviewAudit(f.manager,f.task)).sourcePatchCount,1)
  // Emulate a completed terminology receipt without claiming a fresh full-text extraction.
  const artifacts={};for(const name of ['semantic-groups.json','semantic-rejections.json','review-issues.json','public-candidates.json','cleaning-inventory.json','book-overrides.json','common-snapshot.json','effective.json']){await write(path.join(f.root,'glossary',name),[]);artifacts[name]=hash(await fs.readFile(path.join(f.root,'glossary',name)))}
  await write(path.join(f.root,'glossary.json'),[])
  const receipt={schemaVersion:4,status:'complete',engine:'LinguaGacha',transportVerified:true,cleaningCompleted:true,sourceFingerprint:hash(f.text),language:'fr',artifacts,effectiveFingerprint:hash(await fs.readFile(path.join(f.root,'glossary.json')))}
  await write(path.join(f.root,'glossary/pipeline-receipt.json'),receipt);f.task.glossaryReport=receipt
  const beforeApply=structuredClone(f.task)
  await applyReviewAudit(f.manager,f.task)
  assert.equal(await fs.readFile(f.source,'utf8'),f.text);assert.equal(await fs.readFile(f.target,'utf8'),f.translation)
  const src=await f.manager.original(f.task),text=await fs.readFile(src,'utf8'),target=await fs.readFile(f.task.translationPath,'utf8')
  assert.equal(text,'Patient A. est stable.\n');assert.equal(target,'患者 A 状况稳定。\n')
  assert(translationMapMatches(await loadSourceMap(f.manager,src,text),await loadSourceMap(f.manager,f.task.translationPath,target)))
  assert.equal((await requireBookGlossary(f.manager,f.task)).sourceFingerprint,hash(f.text))
  const record=f.task.sourceRevision.recordFingerprint
  // Simulate interruption after writing new files but before persisting the task pointer.
  for(const key of Object.keys(f.task))delete f.task[key];Object.assign(f.task,beforeApply)
  await applyReviewAudit(f.manager,f.task);assert.equal(f.task.sourceRevision.recordFingerprint,record)
  await applyReviewAudit(f.manager,f.task);assert.equal(f.task.sourceRevision.recordFingerprint,record);assert.equal(calls,3)
  await assertReviewInputs(f.manager,f.task,f.audit)
  await fs.appendFile(src,'changed');await assert.rejects(f.manager.original(f.task),/发生变化/)
 }finally{await f.close()}
})

for(const mode of ['json','patch','network','cancel'])test('bounded recovery: '+mode,async()=>{
 const f=await fixture();try{
  f.task.input.type='markdown';let calls=0
  f.manager.modelService.generate=async()=>{
   calls++
   if(mode==='cancel'){const controller=[...f.manager.active.get(f.task.id).controllers][0];controller.abort();throw new Error('cancelled')}
   if(mode==='network')throw Object.assign(new Error('transient'),{status:503})
   if(calls===1&&mode==='json')return {text:'not JSON'}
   return {text:JSON.stringify({packet:'001',...(calls>1&&mode==='patch'?{mode:'recovery'}:{status:'pass'}),patches:mode==='patch'?[{blockId:'B0001',edits:[{old:'absent',new:'x'}],reason:'invalid'}]:[]})}
  }
  if(mode==='cancel')f.manager.active.set(f.task.id,{})
  const run=()=>runHarnessReview({manager:f.manager,task:f.task,prepared:f.prepared,auditDir:f.audit,validate:()=>assembleReviewAudit(f.manager,f.task)})
  if(['network','cancel'].includes(mode))await assert.rejects(run());else await run()
  assert.equal(calls,mode==='cancel'?1:2)
  if(mode==='json')assert.equal((await assembleReviewAudit(f.manager,f.task)).complete,true)
  if(mode==='patch')assert.equal((await assembleReviewAudit(f.manager,f.task)).complete,false)
  assert.equal(await fs.readFile(f.target,'utf8'),f.translation)
 }finally{await f.close()}
})

test('delivery presentation agrees for stored summaries and detail; blocked tasks cannot publish; published tasks cannot resume review',()=>{
 const task={id:'x',state:'idle',stages:{review:{state:'done'},translationCheck:{state:'done'}},review:{status:'pass',semanticVerified:true}}
 const full=deliveryState(task),list=pageTaskRows([{summary:JSON.stringify(task),library:null}]).tasks[0].deliveryState
 assert.deepEqual(full,list);assert.equal(full.canResume,false);assert.equal(full.canPreview,true)
 assert.equal(deliveryState({...task,publication:{published:true}}).canPreview,false)
 assert.equal(deliveryState({...task,stages:{...task.stages,review:{state:'blocked'}},review:{status:'needs-work'}}).canPreview,false)
 assert.equal(deliveryState({...task,review:{status:'pass',semanticVerified:false}}).canPreview,true)
 assert.equal(deliveryState({...task,review:{semanticVerified:false,audit:{applied:true},auditValidation:{complete:true,unresolved:[],errors:[]}}}).canPreview,true)
 assert.equal(deliveryState({...task,review:{semanticVerified:false,message:'报告已登记'}}).canPreview,false)
})

test('seventeen-page review automatically finishes two evidence batches without revisiting resolved issues',async()=>{
 const f=await fixture(17);try{
  const source=Array.from({length:17},(_,i)=>'Patient C. on page '+(i+1)+'.').join('\n\n')+'\n',target=Array.from({length:17},(_,i)=>'第 '+(i+1)+' 页患者 C。').join('\n\n')+'\n'
  await write(f.source,source);await write(f.target,target)
  const map=await read(f.source+'.source-map.json');map.markdownSha256=hash(source);map.blocks=markdownBlocks(source).map((b,i)=>({...map.blocks[0],markdownBlockId:b.id,blockId:'source-'+i,pdfPages:[i+1],pdfPageRanges:[[i+1,i+1]],logicalPages:[i+1]}));await write(f.source+'.source-map.json',map)
  const prepared=await prepareReviewAudit(f.manager,f.task,{force:true});let calls=0;const reviewed=[]
  f.manager.modelService.generate=async(_s,r)=>{
   calls++;const prompt=r.messages[0].content[0].text
   if(calls===1)return {text:JSON.stringify({packet:'001',status:'needs-work',unresolved:map.blocks.map((_,i)=>({blockId:'B'+String(i+1).padStart(4,'0'),issue:'核对姓名'}))})}
   const imageCount=r.messages[0].content.filter(c=>c.type==='image').length;assert(imageCount<=16&&imageCount>0)
   if(prompt.includes('核证输入：')){const input=JSON.parse(prompt.split('核证输入：').at(-1));return {text:JSON.stringify({findings:input.issues.map(i=>({issueId:i.id,verdict:'source_inconsistency',evidence:[{page:i.pages[0],quote:'Patient A.'}],reason:'图像证据'}))})}}
   const input=JSON.parse(prompt.split('\n').at(-1));for(const i of input.issues){assert(!reviewed.includes(i.id));reviewed.push(i.id)}
   return {text:JSON.stringify({packet:'001',mode:'recovery',resolved_issues:input.issues.map(i=>({id:i.id,reason:'确认'})),source_evidence_decisions:input.issues.map(i=>({issueId:i.id,evidenceKey:input.sourceEvidence.key,decision:'accept',reason:'核对图像'})),source_notes:input.issues.map(i=>({issueId:i.id,text:'保留底本差异'}))})}
  }
  await runHarnessReview({manager:f.manager,task:f.task,prepared,auditDir:prepared.auditDir,validate:()=>assembleReviewAudit(f.manager,f.task)})
  assert.equal(calls,5);assert.equal(reviewed.length,17);const validation=await assembleReviewAudit(f.manager,f.task);assert.equal(validation.complete,true);assert.equal(validation.unresolved.length,0)
 }finally{await f.close()}
})

test('a corrected translation must exactly match the image-backed second review before applying a new source',async()=>{
 const f=await fixture();try{
  const prepared=f.prepared,row=(await read(path.join(f.audit,'packets/001.json')))[0]
  const issues=[{id:'i',kind:'content',issue:{blockId:row.blockId,issue:'错误'}}]
  const evidence=await prepareSourceEvidence({manager:f.manager,task:f.task,auditDir:f.audit,packet:'001',issues,selection:{provider:'fixture',model:'model'},onState:async()=>{},request:async()=>({text:JSON.stringify({findings:[{issueId:'i',verdict:'transcription_error',evidence:[{page:1,quote:'Patient A.'}],reason:'图像',source_patches:[{blockId:'B0001',old:'C.',new:'A.',reason:'图像'}]}]})})})
  const delta={resolved_issues:[{id:'i',reason:'确认'}],source_evidence_decisions:[{issueId:'i',evidenceKey:evidence.key,decision:'accept',reason:'图像'}],source_corrections:[{issueId:'i',blockId:'B0001',source:'Patient A. est stable.',translation:'患者 A 状况稳定。',reason:'对应原图'}]}
  await write(path.join(f.audit,'results/001.json'),{packet:'001',status:'pass',patches:[],...validateEvidenceResolution(delta,evidence,issues)})
  await assert.rejects(applyReviewAudit(f.manager,f.task),/不能合并/)
  assert.equal(await fs.readFile(f.source,'utf8'),f.text);assert.equal(f.task.sourceRevision,undefined)
 }finally{await f.close()}
})

test('publication preview and confirmation are separate from model selection and never call a model',async()=>{
 const f=await fixture();try{
  const m=f.manager,t=f.task;m.publishRoot=path.join(f.root,'published');await fs.mkdir(m.publishRoot);m.docDir=()=>f.root
  m.locked=async(_key,fn)=>fn();m.get=async()=>t;m.confirmed=async()=>{};m.requireGlossary=async()=>{};m.requireDone=async(task,...stages)=>{for(const s of stages)assert.equal(task.stages[s]?.state,'done')};m.publishPreview=task=>buildPublication(m,task)
  m.modelService.generate=async()=>{throw new Error('must not call model')}
  t.name='Publication fixture';t.stages.review={state:'done'};t.stages.translationCheck={state:'done'};t.phaseApproval={phase:'delivery',reviewConfig:t.reviewConfig,publishAccepted:false}
  t.translationReport={passed:true,sourceFingerprint:hash(f.text),targetFingerprint:hash(f.translation)}
  const map=await loadSourceMap(m,f.source,f.text);await saveTranslationMap(m,t,f.source,f.target,f.text,f.translation,markdownBlocks(f.translation).map((b,i)=>({...map.blocks[i],markdownBlockId:b.id,type:b.type})))
  const report=path.join(f.root,'report.md');await write(report,'Verified fixture');t.review={status:'pass',semanticVerified:true,sourceFingerprint:hash(f.text),targetFingerprint:hash(f.translation),report,reportFingerprint:hash('Verified fixture')}
  await TaskManager.prototype.publicationPreview.call(m,t.id);assert.equal(t.publication.published,false);assert.deepEqual(await fs.readdir(m.publishRoot),[])
  await assert.rejects(TaskManager.prototype.publish.call(m,t.id,false),/确认发布/)
  await TaskManager.prototype.publish.call(m,t.id,true);assert.equal(t.publication.published,true);assert.equal(t.stages.publish.state,'done')
  await TaskManager.prototype.publicationPreview.call(m,t.id);assert.equal(t.publication.published,true)
 }finally{await f.close()}
})

test('image-only PDF evidence repairs a malformed response once and reuses the validated receipt',async()=>{
 const f=await fixture();try{
  await exec('/opt/homebrew/bin/python3',['-c',"import pymupdf,sys,os; old=pymupdf.open(sys.argv[1]); pix=old[0].get_pixmap(); d=pymupdf.open(); p=d.new_page(); p.insert_image(p.rect,stream=pix.tobytes('png')); d.save(sys.argv[1]+'.scan'); old.close(); os.replace(sys.argv[1]+'.scan',sys.argv[1]); assert not d[0].get_text()",f.pdf])
  const map=await read(f.source+'.source-map.json');map.pdf.sha256=hash(await fs.readFile(f.pdf));await write(f.source+'.source-map.json',map)
  let calls=0;const args={manager:f.manager,task:f.task,auditDir:f.audit,packet:'001',issues:[{id:'i',kind:'content',issue:{blockId:'B0001',issue:'核对姓名'}}],selection:{provider:'fixture',model:'model'},onState:async()=>{},request:async(_p,images)=>{calls++;assert.equal(images.length,1);if(calls===1)return {text:'invalid JSON'};return {text:JSON.stringify({findings:[{issueId:'i',verdict:'source_inconsistency',evidence:[{page:1,quote:'Patient A.'}],reason:'图像明确'}]})}}}
  const evidence=await prepareSourceEvidence(args);assert.equal(calls,2);assert.equal((await prepareSourceEvidence(args)).cached,true);assert.equal(calls,2)
  const files=await fs.readdir(path.join(f.audit,'source-evidence',evidence.key));assert(files.some(n=>/^request-.+\.json$/.test(n)))
 }finally{await f.close()}
})

test('persistently invalid visual evidence stops after one repair, including a later resume',async()=>{
 const f=await fixture();try{
  let calls=0;const args={manager:f.manager,task:f.task,auditDir:f.audit,packet:'001',issues:[{id:'i',kind:'content',issue:{blockId:'B0001',issue:'核对姓名'}}],selection:{provider:'fixture',model:'model'},onState:async()=>{},request:async()=>{calls++;return {text:'invalid JSON'}}}
  await assert.rejects(prepareSourceEvidence(args));assert.equal(calls,2)
  await assert.rejects(prepareSourceEvidence(args));assert.equal(calls,2)
 }finally{await f.close()}
})
