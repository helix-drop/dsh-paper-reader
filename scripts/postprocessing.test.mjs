import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {normalizeTranslationQuotes,quoteNormalizationRecord} from '../modules/pipeline/translation-typography.js'
import {bilingualMarkdown} from '../modules/pipeline/publication.js'
import {structuralFlags,scanLineHints,prepareReviewAudit,assembleReviewAudit,applyReviewAudit} from '../modules/pipeline/review-audit.js'
import {hash} from '../modules/pipeline/markdown.js'

test('footnotes and Chinese paired quotes normalize without altering foreign titles or literals',()=>{
 const input='[^id]: 「注释」 « 中文 » "中文" ( « French Title » ) "French"\n[ref]: ./「路径」\n`"代码"`\n"未配对\n'
 const output=normalizeTranslationQuotes(input)
 assert.equal(output,'[^id]: “注释” “中文” “中文” ( « French Title » ) "French"\n[ref]: ./「路径」\n`"代码"`\n"未配对\n')
 assert.equal(normalizeTranslationQuotes(output),output)
 assert.equal(quoteNormalizationRecord(input,output).changedCharacters,6)
})
test('bilingual navigation deduplicates after rewriting and H2 wins over repeated H3',()=>{
 const src='## 目录\n\n- [[#Introduction]]\n\n## Introduction\n\nText\n\n### INTRODUCTION\n'
 const dst='## 目录\n\n- [[#导论]]\n\n## 导论\n\n正文\n\n### 导论\n'
 const result=bilingualMarkdown(src,dst)
 assert.equal((result.match(/\[\[#/g)||[]).length,1)
 assert(result.includes('[[#导论 \\| Introduction]]'))
 assert(!result.includes('> - [['))
})
test('inline editorial annotations are detected with both parenthesis styles',()=>{
 for(const note of ['（原文斜体）','(原文如此)','（原文分词有误）','（原文作 autre）','（译者注：说明）','(译注:说明)','（校注：说明）']){
  assert(structuralFlags(1,'正文','正文'+note).some(f=>f.type==='annotation'))
  assert(scanLineHints('text','正文'+note).some(f=>f.type==='annotation'))
 }
})
async function fixture(source,target,run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'postprocessing-'))
 try{const src=path.join(root,'source.md'),dst=path.join(root,'translation.md');await fs.writeFile(src,source);await fs.writeFile(dst,target)
 const manager={dir:()=>root,original:async()=>src},task={id:'test',translationPath:dst};const prep=await prepareReviewAudit(manager,task)
 await run({manager,task,dst,auditDir:prep.auditDir})
 }finally{await fs.rm(root,{recursive:true,force:true})}
}
test('apply updates both old translated and source TOC anchors after heading patches',async()=>{
 for(const label of ['Introduction','旧导论'])await fixture('## Contents\n\n- [[#Introduction]]\n\n## Introduction\n','## 目录\n\n- [[#'+label+']]\n\n## 旧导论\n',async({manager,task,dst,auditDir})=>{
  await fs.writeFile(path.join(auditDir,'results/001.json'),JSON.stringify({packet:'001',status:'pass',patches:[{blockId:'B0003',edits:[{old:'旧导论',new:'新导论'}],reason:'标题修订'}]}))
  await applyReviewAudit(manager,task)
  const result=await fs.readFile(dst,'utf8');assert(result.includes('[[#新导论]]'));assert.equal(task.translationReport.targetFingerprint,hash(result))
  await applyReviewAudit(manager,task);assert.equal(await fs.readFile(dst,'utf8'),result)
 })
})
test('annotation patch blocks application and directs observations',async()=>{
 await fixture('Text.\n','正文。\n',async({manager,task,dst,auditDir})=>{
  await fs.writeFile(path.join(auditDir,'results/001.json'),JSON.stringify({packet:'001',status:'pass',patches:[{blockId:'B0001',edits:[{old:'正文。',new:'正文。（原文如此）'}],reason:'说明'}]}))
  const result=await assembleReviewAudit(manager,task);assert(result.errors.some(e=>e.error.includes('observations')))
  await assert.rejects(applyReviewAudit(manager,task));assert.equal(await fs.readFile(dst,'utf8'),'正文。\n')
 })
})
test('pseudo-heading demotion patches sync revised source while invalid structural patches fail packet assembly',async()=>{
 const src='## Contents\n\n- [[#Chapter 1]]\n\n## Author Name\n\n## Chapter 1\n\n## Running Header\n\nBody text.\n'
 const dst='## 目录\n\n- [[#旧第一章]]\n\n## 作者姓名\n\n## 旧第一章\n\n## 活页眉标题\n\n正文内容。\n'
 await fixture(src,dst,async({manager,task,dst,auditDir})=>{
  manager.original=async t=>t.sourceRevision?t.sourceRevision.path:path.join(manager.dir(),'source.md')
  await fs.writeFile(path.join(auditDir,'results/001.json'),JSON.stringify({packet:'001',status:'pass',patches:[{blockId:'B0006',edits:[{old:'正文内容。',new:'第一段。\n\n第二段。'}],reason:'非法拆段'}]}))
  let v=await assembleReviewAudit(manager,task)
  assert.equal(v.complete,false);assert(!v.validPackets.includes('001'))
  await fs.writeFile(path.join(auditDir,'results/001.json'),JSON.stringify({packet:'001',status:'pass',patches:[
   {blockId:'B0003',edits:[{old:'## 作者姓名',new:'*作者姓名*'}],reason:'扉页作者署名改为署名行'},
   {blockId:'B0004',edits:[{old:'旧第一章',new:'新第一章'}],reason:'修订章题'},
   {blockId:'B0005',edits:[{old:'## 活页眉标题',new:'<!-- 活页眉清洗：活页眉标题 -->'}],reason:'清洗跨页活页眉污染'}
  ]}))
  v=await assembleReviewAudit(manager,task)
  assert.equal(v.complete,true);assert.equal(v.errors.length,0);assert.equal(v.sourcePatchCount,2)
  await applyReviewAudit(manager,task)
  const finalDst=await fs.readFile(task.translationPath,'utf8'),finalSrc=await fs.readFile(await manager.original(task),'utf8')
  assert(finalDst.includes('[[#新第一章]]'));assert(finalDst.includes('*作者姓名*'));assert(finalDst.includes('<!-- 活页眉清洗：活页眉标题 -->'))
  assert(finalSrc.includes('*Author Name*'));assert(finalSrc.includes('<!-- Running Header -->'))
 })
})
