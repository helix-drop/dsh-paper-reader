import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {normalizeTranslationQuotes,quoteNormalizationRecord} from '../modules/pipeline/translation-typography.js'
import {translationInput,acceptTranslation} from '../modules/pipeline/source-map.js'
import {prepareReviewAudit,assembleReviewAudit,applyReviewAudit} from '../modules/pipeline/review-audit.js'
import {markdownBlocks,hash} from '../modules/pipeline/markdown.js'

test('Chinese corner quotes normalize after parsing, including inner quotes; existing quotation styles stay intact',()=>{
 const raw=JSON.stringify({text:'他称之为「一种『稳定』状态」。\r\n原有“中文”和 "JSON" 引号。'}),parsed=JSON.parse(raw)
 const result=normalizeTranslationQuotes(parsed.text)
 assert.equal(result,'他称之为“一种‘稳定’状态”。\r\n原有“中文”和 "JSON" 引号。')
 assert.equal(normalizeTranslationQuotes(result),result);assert.equal(quoteNormalizationRecord(parsed.text,result).changedCharacters,4)
 assert.equal(JSON.parse(raw).text,parsed.text)
})

test('literal code, URLs, attachment paths and Markdown identifiers are preserved',()=>{
 const text=['「正文」 `const x = "「literal」"`','````js','const a = "「literal」"','```','````','~~~json','{"text":"「literal」"}','~~~','[「标题」](./「文件」(1).pdf)','![「说明」](./「图片」.png)','[^「id」]','[^「id」]: 「注释」','[ref]: ./「文件」.pdf','<!-- 「metadata」 -->','<span title="「attribute」">「内容」</span>','[「文字」][「ref」]','https://example.test/「path」',''].join('\n')
 const normalized=normalizeTranslationQuotes(text)
 assert.match(normalized,/“正文” `const x = "「literal」"`/)
 assert.match(normalized,/const a = "「literal」"/);assert.match(normalized,/\{"text":"「literal」"\}/)
 assert(normalized.includes('[“标题”](./「文件」(1).pdf)'));assert(normalized.includes('![“说明”](./「图片」.png)'))
 assert(normalized.includes('[^「id」]'));assert(normalized.includes('<!-- 「metadata」 -->'))
 assert(normalized.includes('<span title="「attribute」">“内容”</span>'));assert(normalized.includes('[“文字”][「ref」]'))
 assert(normalized.includes('https://example.test/「path」'))
 assert.equal(normalized.split('\n').length,text.split('\n').length)
})

test('accepted translation is normalized before hashes and source-map block identifiers are produced',()=>{
 const source='He said so.\n',receipt=translationInput(source),raw=receipt.text.replace('He said so.','他说「可以」。')
 const result=acceptTranslation(source,raw,receipt,null)
 assert.equal(result.target,'他说“可以”。\n');assert.equal(result.check.passed,true)
 assert.equal(result.blocks[0].markdownBlockId,markdownBlocks(result.target)[0].id)
 assert.equal(result.typography.changedCharacters,2);assert(raw.includes('「可以」'));assert.equal(receipt.sourceFingerprint,hash(source))
})

test('review patches retain their exact match base and raw evidence while final typography is normalized',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'quotes-review-')),source=path.join(root,'source.md'),target=path.join(root,'translated.md')
 try{
  await fs.writeFile(source,'He said so.\n');await fs.writeFile(target,'他说「错误」。\n')
  const manager={dir:()=>root,original:async()=>source},task={id:'fixture',translationPath:target},prepared=await prepareReviewAudit(manager,task)
  const raw={packet:'001',status:'pass',patches:[{blockId:'B0001',edits:[{old:'「错误」',new:'「正确」'}],reason:'原文'}]},file=path.join(prepared.auditDir,'results/001.json')
  await fs.writeFile(file,JSON.stringify(raw));const validation=await assembleReviewAudit(manager,task)
  assert.equal(validation.complete,true);assert.equal(validation.typography.changedCharacters,2)
  await applyReviewAudit(manager,task);assert.equal(await fs.readFile(target,'utf8'),'他说“正确”。\n')
  assert.equal(task.translationReport.targetFingerprint,hash('他说“正确”。\n'))
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),raw);assert.equal(await fs.readFile(source,'utf8'),'He said so.\n')
  await applyReviewAudit(manager,task);assert.equal(await fs.readFile(target,'utf8'),'他说“正确”。\n')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
